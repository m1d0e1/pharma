"""Copy and verify DPAPI-encrypted operator credentials and current issuer ledger.

Private QA/recovery custody ONLY. The backup remains bound to the Windows user's
DPAPI profile, and even a verified second local disk is NOT a portable off-site
recovery. Never print/extract the raw seed or operator token or issue licenses.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from scripts import owner_first_enrollment as custody
from scripts.licensing import windows_private_operator as issuer
from scripts.licensing.authority import public_key_b64

DIR_PREFIX = "pharma-commercial-offline-local-recovery-"
MANIFEST = "LOCAL_RECOVERY_NOT_PORTABLE.json"
FILES = (issuer.ISSUER_BLOB, issuer.TOKEN_BLOB, issuer.AUTHORITY_DB)
TOKEN = re.compile(r"[0-9a-f]{32}\Z")


class Refused(ValueError):
    pass


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _checked_backup_dir(folder: Path, parent: Path) -> None:
    if (folder.parent != parent or not folder.name.startswith(DIR_PREFIX)
            or not folder.is_dir() or folder.is_symlink()):
        raise Refused("Only an independently private recovery folder is supported")
    if not TOKEN.fullmatch(folder.name[len(DIR_PREFIX):]):
        raise Refused("Malformed private local recovery identifier")
    custody._no_reparse(parent)
    custody._no_reparse(folder)
    custody._private_acl(folder, set_restriction=False)


def _source() -> tuple[dict[str, bytes], str]:
    _, state, keys = _directories()
    paths = [keys / issuer.ISSUER_BLOB,
             keys / issuer.TOKEN_BLOB,
             state / issuer.AUTHORITY_DB]
    raw = {}
    for path in paths:
        custody._no_reparse(path)
        if not path.is_file() or path.is_symlink() or path.stat().st_nlink != 1:
            raise Refused("Operator source recovery file is unsafe")
        custody._private_acl(path, set_restriction=False)
        if any(Path(str(path) + ending).exists()
               for ending in ("-wal", "-shm", "-journal")):
            raise Refused("Active SQLite authority state must not be copied")
        first, second = path.read_bytes(), path.read_bytes()
        if first != second or len(first) == 0:
            raise Refused("Commercial operator state changed during recovery read")
        raw[path.name] = first
    public = issuer.status()["public_license_verification_key_b64url"]
    if not public:
        raise Refused("Commercial issuer public identity is missing")
    return raw, public


def _directories() -> tuple[Path, Path, Path]:
    root = issuer._root()
    issuer._checked_dir(root)
    state, keys = root / "state", root / "secrets"
    issuer._checked_dir(state)
    issuer._checked_dir(keys)
    return root, state, keys


def backup(parent: Path) -> dict:
    custody._require_windows()
    if not parent.is_absolute() or not parent.is_dir() or parent.is_symlink():
        raise Refused("A separate existing absolute private recovery parent is required")
    custody._no_reparse(parent)
    repo = Path(__file__).resolve().parents[2]
    if parent.resolve() == repo or repo in parent.resolve().parents:
        raise Refused("Operator backup cannot be written within the source repository")
    raw, public = _source()
    folder = parent / (DIR_PREFIX + uuid.uuid4().hex)
    folder.mkdir(mode=0o700)
    custody._private_acl(folder)
    for name in FILES:
        custody._exclusive_file(folder / name, raw[name])
    manifest = {
        "format": "PHARMA-WINDOWS-DPAPI-LOCAL-RECOVERY-ONLY-v1",
        "issuer_public_key_b64url": public,
        "file_sha256": {name: _sha(raw[name]) for name in FILES},
        "portable_cross_windows_account": False,
        "independent_off_device_recovery_certified": False,
        "production_release_approved": False,
    }
    custody._exclusive_file(folder / MANIFEST,
                            (json.dumps(manifest, sort_keys=True) + "\n").encode("ascii"))
    result = verify(folder, parent)
    after, after_public = _source()
    if (public != after_public or
            any(_sha(raw[name]) != _sha(after[name]) for name in FILES)):
        raise Refused("Issuer ledger changed during private recovery snapshot")
    result["private_backup_directory"] = str(folder)
    return result


def verify(folder: Path, parent: Path) -> dict:
    custody._require_windows()
    _checked_backup_dir(folder, parent)
    manifest = folder / MANIFEST
    custody._no_reparse(manifest)
    if not manifest.is_file() or manifest.is_symlink() or manifest.stat().st_nlink != 1:
        raise Refused("Private recovery manifest is missing")
    custody._private_acl(manifest, set_restriction=False)
    data = json.loads(manifest.read_bytes())
    if (type(data) is not dict
            or set(data) != {"format", "issuer_public_key_b64url",
                             "file_sha256", "portable_cross_windows_account",
                             "independent_off_device_recovery_certified",
                             "production_release_approved"}
            or data.get("format") != "PHARMA-WINDOWS-DPAPI-LOCAL-RECOVERY-ONLY-v1"
            or data.get("portable_cross_windows_account") is not False
            or data.get("independent_off_device_recovery_certified") is not False
            or data.get("production_release_approved") is not False
            or set(data.get("file_sha256", {})) != set(FILES)):
        raise Refused("Local backup cannot assert commercial release or portable recovery")
    for name in FILES:
        path = folder / name
        custody._no_reparse(path)
        if not path.is_file() or path.is_symlink() or path.stat().st_nlink != 1:
            raise Refused("Local encrypted recovery file is missing")
        custody._private_acl(path, set_restriction=False)
        if _sha(path.read_bytes()) != data["file_sha256"][name]:
            raise Refused("Encrypted local recovery file changed")
    try:
        _, seed = issuer._crypto().CryptUnprotectData(
            (folder / issuer.ISSUER_BLOB).read_bytes(), None, None, None, 0)
        _, token = issuer._crypto().CryptUnprotectData(
            (folder / issuer.TOKEN_BLOB).read_bytes(), None, None, None, 0)
    except Exception as exc:
        raise Refused("Local backup cannot be unsealed by the current Windows owner") from exc
    if len(seed) != 32 or len(token) < 32:
        raise Refused("Local recovery secrets are malformed")
    if public_key_b64(Ed25519PrivateKey.from_private_bytes(seed)) != data["issuer_public_key_b64url"]:
        raise Refused("Commercial issuer key differs from sealed local recovery evidence")
    # An authority ledger can retain the SQLite WAL-mode header even when it
    # has been cleanly checkpointed and has no sidecars. Python deserialize()
    # cannot open a WAL-mode header in a private RAM connection. Normalize only
    # these two header bytes in an IN-MEMORY integrity-check clone; both source
    # and recovery-file bytes remain unchanged and SHA-256-pinned.
    original = (folder / issuer.AUTHORITY_DB).read_bytes()
    if original[:16] != b"SQLite format 3\x00":
        raise Refused("Sealed recovery authority has an invalid SQLite header")
    if original[18:20] not in (b"\x01\x01", b"\x02\x02"):
        raise Refused("Unexpected recovery SQLite journal-mode header")
    validation = bytearray(original)
    validation[18:20] = b"\x01\x01"
    db = sqlite3.connect(":memory:")
    try:
        db.deserialize(bytes(validation))
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise Refused("Local recovery authority database fails SQLite integrity")
    finally:
        db.close()
    return {
        "status": "PASS_PRIVATE_DPAPI_LOCAL_RECOVERY_COPY_NOT_PORTABLE",
        "issuer_public_key_b64url": data["issuer_public_key_b64url"],
        "files_verified": len(FILES),
        "private_issuer_seed_printed": False,
        "portable_off_device_restore_accepted": False,
        "production_installer_authorized": False,
    }


def main() -> int:
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--backup-parent":
            result = backup(Path(sys.argv[2]))
        elif len(sys.argv) == 4 and sys.argv[1] == "--verify":
            result = verify(Path(sys.argv[2]), Path(sys.argv[3]))
        else:
            raise Refused("Use explicit local backup parent or existing backup directory")
        print(json.dumps(result, sort_keys=True))
        return 0
    except (Refused, custody.Refused, issuer.Refused,
            ValueError, OSError, sqlite3.Error, TypeError, KeyError):
        print(json.dumps({"status": "REFUSED_WINDOWS_LOCAL_ISSUER_RECOVERY"}),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
