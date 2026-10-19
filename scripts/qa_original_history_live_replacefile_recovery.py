"""Windows crash/recovery exercise on the *current* real-history v29 -> SQLx69 pair.

Every on-disk operation is confined to a new private disposable QA directory.
Neither this test nor its child has a code path to replace the installed database.
The exact current-live bytes and the already validated SQLx69 candidate are pinned
and re-derived; original records, unsigned audit and owner quarantine stay intact.
This is NOT installation authorization or a physical power-loss certification.
"""
from __future__ import annotations

import ctypes
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import uuid

from scripts import owner_first_enrollment as custody
from scripts import qa_original_history_live_sequence_rebase as rebase
from scripts import qa_v02110_primary_pharmacy_migration as guard


TOKEN = "b33bde4e89fd4894862bb7f67b30169c"
PREFIX = "pharma-v02110-live-replacefile-qa-"
ACTIVE = "QA_ACTIVE.sqlite3"
INCOMING = "QA_INCOMING.sqlite3"
ROLLBACK = "QA_ROLLBACK.sqlite3"
ROLLFORWARD = "QA_ROLLFORWARD.sqlite3"
CHILD = "--qa-replace-child"
CHILD_EXIT = 74


class Refused(ValueError):
    pass


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _folder(token: str) -> Path:
    if not rebase.TOKEN.fullmatch(token):
        raise Refused("Invalid isolated QA token")
    root = guard.disposable_root()
    path = root / (PREFIX + token)
    if path.parent != root or not path.is_dir() or path.is_symlink():
        raise Refused("Only an existing disposable QA directory may be exercised")
    custody._no_reparse(root)
    custody._no_reparse(path)
    custody._private_acl(path, set_restriction=False)
    return path


def _validate_raw(raw: bytes, version: int, sequence: int) -> None:
    with rebase._ram(raw) as db:
        if db.execute(
            "SELECT COUNT(*),MAX(version) FROM _sqlx_migrations"
        ).fetchone() != (version, version):
            raise Refused("Detached QA database has the wrong native SQLx version")
        if db.execute(
            "SELECT seq FROM sqlite_sequence WHERE name='accounts'"
        ).fetchone() != (sequence,):
            raise Refused("QA database does not retain the current account sequence")
        if version == 69:
            if db.execute(
                "SELECT COUNT(*) FROM native_primary_scope_audit_batches"
            ).fetchone() != (1,) or db.execute(
                "SELECT COUNT(*) FROM native_primary_scope_owner_attestations"
            ).fetchone() != (0,):
                raise Refused("Historic QA normalization audit or owner quarantine differs")


def _checked(path: Path, folder: Path, expected: str, version: int,
             sequence: int) -> None:
    custody._contained_file(path, guard.disposable_root(), precise=folder / path.name)
    custody._private_acl(path, set_restriction=False)
    raw = path.read_bytes()
    if digest(raw) != expected:
        raise Refused("Detached QA file differs from the exact original-history pin")
    _validate_raw(raw, version, sequence)


def _replace(folder: Path, incoming_name: str, backup_name: str,
             active_pin: str, incoming_pin: str, sequence: int,
             active_version: int, incoming_version: int) -> None:
    if (folder.parent != guard.disposable_root()
            or not folder.name.startswith(PREFIX)
            or incoming_name not in (INCOMING, ROLLBACK, ROLLFORWARD)
            or backup_name not in (ROLLBACK, ROLLFORWARD)
            or incoming_name == backup_name):
        raise Refused("ReplaceFileW restricted to private original-history QA")
    token = folder.name[len(PREFIX):]
    if _folder(token) != folder:
        raise Refused("Private QA folder identity changed")
    active = folder / ACTIVE
    incoming = folder / incoming_name
    backup = folder / backup_name
    if backup.exists() or backup.is_symlink():
        raise Refused("Refuse to overwrite a previous QA recovery artifact")
    for base in (active, incoming, backup):
        if any(Path(str(base) + ext).exists() for ext in ("-wal", "-shm", "-journal")):
            raise Refused("SQLite sidecar makes atomic QA replacement ambiguous")
    _checked(active, folder, active_pin, active_version, sequence)
    _checked(incoming, folder, incoming_pin, incoming_version, sequence)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    replace = kernel.ReplaceFileW
    replace.argtypes = (ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_wchar_p,
                        ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p)
    replace.restype = ctypes.c_int
    if replace(str(active), str(incoming), str(backup), 0, None, None) != 1:
        raise Refused("Win32 refused atomic QA ReplaceFileW")


def _pair(folder: Path) -> tuple[str, str, int]:
    manifest = folder / "QA_PAIR_METADATA.json"
    custody._no_reparse(manifest)
    if not manifest.is_file() or manifest.is_symlink() or manifest.stat().st_nlink != 1:
        raise Refused("Missing safe QA pair metadata")
    custody._private_acl(manifest, set_restriction=False)
    raw = manifest.read_bytes()
    if len(raw) > 4096:
        raise Refused("Oversized QA pair manifest")
    metadata = json.loads(raw)
    if (type(metadata) is not dict or set(metadata) !=
            {"v29_sha256", "v69_sha256", "sequence", "status"}
            or metadata["status"] != "UNACCEPTED_QA_PAIR"
            or not isinstance(metadata["v29_sha256"], str)
            or not isinstance(metadata["v69_sha256"], str)
            or not guard.SHA.fullmatch(metadata["v29_sha256"])
            or not guard.SHA.fullmatch(metadata["v69_sha256"])
            or type(metadata["sequence"]) is not int
            or metadata["sequence"] < 4829):
        raise Refused("Invalid original-history QA pair metadata")
    return metadata["v29_sha256"], metadata["v69_sha256"], metadata["sequence"]


def exercise() -> dict:
    custody._require_windows()
    # First verify existing stage from the live original and independent native
    # SQLx69 migration. A caller cannot supply a different app data location.
    preflight = rebase.verify_token(TOKEN)
    live = rebase._live_os_bytes_stable()
    live_sha = digest(live)
    if live_sha != preflight["live_v29_sha256"]:
        raise Refused("Current live source changed after paired QA preflight")
    root = guard.disposable_root()
    v69_file = root / (rebase.QA_PREFIX + TOKEN) / rebase.QA_NAME
    v69, fingerprint = custody._capture(
        v69_file, preflight["qa_stage_sha256"], root)
    sequence = preflight["accounts_sequence_preserved"]
    _validate_raw(live, 29, sequence)
    _validate_raw(v69, 69, sequence)
    token = uuid.uuid4().hex
    folder = root / (PREFIX + token)
    custody._no_reparse(root)
    folder.mkdir(mode=0o700)
    custody._private_acl(folder)
    custody._exclusive_file(folder / ACTIVE, live)
    custody._exclusive_file(folder / INCOMING, v69)
    custody._exclusive_file(
        folder / "QA_PAIR_METADATA.json",
        (json.dumps({"status": "UNACCEPTED_QA_PAIR", "v29_sha256": live_sha,
                     "v69_sha256": digest(v69), "sequence": sequence},
                    sort_keys=True) + "\n").encode("ascii"))
    child = subprocess.run(
        [sys.executable, "-B", "-m",
         "scripts.qa_original_history_live_replacefile_recovery", CHILD, token],
        cwd=str(Path(__file__).resolve().parent.parent),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        check=False, timeout=90,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if child.returncode != CHILD_EXIT:
        raise Refused("Windows QA child did not exit at its crash point")
    _checked(folder / ACTIVE, folder, digest(v69), 69, sequence)
    _checked(folder / ROLLBACK, folder, live_sha, 29, sequence)
    _replace(folder, ROLLBACK, ROLLFORWARD, digest(v69), live_sha,
             sequence, 69, 29)
    _checked(folder / ACTIVE, folder, live_sha, 29, sequence)
    _checked(folder / ROLLFORWARD, folder, digest(v69), 69, sequence)
    _replace(folder, ROLLFORWARD, ROLLBACK, live_sha, digest(v69),
             sequence, 29, 69)
    _checked(folder / ACTIVE, folder, digest(v69), 69, sequence)
    _checked(folder / ROLLBACK, folder, live_sha, 29, sequence)
    if digest(rebase._live_os_bytes_stable()) != live_sha:
        raise Refused("Installed original changed while QA recovery ran")
    custody._unchanged(v69_file, digest(v69), fingerprint, root)
    return {
        "status": "PASS_LIVE_ALIGNED_SQLX69_WIN32_CRASH_ROLLBACK_QA_UNACCEPTED",
        "historical_rows_preserved": preflight["verified_business_history_rows_identical"],
        "accounts_sequence_preserved": sequence,
        "v29_sha256": live_sha,
        "v69_sha256": digest(v69),
        "qa_folder": str(folder),
        "child_process_exit_after_atomic_replace": True,
        "rollback_and_repromotion_checked": True,
        "installed_profile_modified": False,
        "owner_and_financial_authorization_present": False,
        "production_installation_allowed": False,
        "physical_power_loss_certified": False,
    }


def main() -> int:
    try:
        custody._require_windows()
        if len(sys.argv) == 3 and sys.argv[1] == CHILD:
            folder = _folder(sys.argv[2])
            v29, v69, seq = _pair(folder)
            _replace(folder, INCOMING, ROLLBACK, v29, v69, seq, 29, 69)
            os._exit(CHILD_EXIT)
        if len(sys.argv) != 1:
            raise Refused("Unsupported live replacement QA argument")
        print(json.dumps(exercise(), sort_keys=True))
        return 0
    except (Refused, custody.Refused, rebase.Refused, guard.Refused,
            OSError, sqlite3.Error, ValueError, subprocess.TimeoutExpired):
        print(json.dumps({"status": "REFUSED_LIVE_ALIGNED_REPLACEFILE_QA"}),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
