"""Windows-only original-owner COPY-ONLY ticket for a detached native SQLx v52/67.

Default `inspect` checks pinned v29/seal/v67 provenance, installed owner public
certificate, exact Rust typed direct-scope framing, and source SHA, read-only.
`sign` requires a separate explicit confirmation and expiry; it unwraps the
CURRENT USER's DPAPI-protected enrollment seed in RAM only, stages a new private
disposable snapshot.sqlite3 + ticket.json, and irreversibly reserves the source
SHA against reissue. The real owner key is never needed for tests.

No installed profile, original/sealed archive, existing enrollment, native
database or migration is written. A ticket authorizes only native COPY-ONLY
review, never login, historical owner authority, or release promotion.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import struct
import sys
import time

from scripts import owner_first_enrollment as custody


DOMAIN = b"pharma/native/copy-only-v52-v67-primary-pharmacy/v1\x00"
SCOPE_DOMAIN = b"pharma/native/v52-v67-all-direct-scope-cells/v1"
TENANT = "primary_pharmacy"
MAX_AGE = 30 * 24 * 3600
NATIVE_SOURCE_PIN = "12c7ef65c8c89ac473b309221c462f71589ce1bcca4ae928b0aaf430999f9880"
NATIVE_SOURCE_SUBDIR = "pharma-v02110-current-v67-sql-rehearsal-7fe5928a6d9b4d45a7a86478946b0778"
NATIVE_SOURCE_NAME = "current-v02109-to-v67-SQL-ONLY-NOT-AUTHORIZED.sqlite3"
EXPECTED_SCOPE_SHA = "d31010b396087e1d52c86508b381f5886574739e8a9fe3629ef11e5264744c0e"
EXPECTED_ORIGINAL_SCOPE_CELLS = 7567
ENROLLMENT = Path(
    r"D:\PhD\Tools\pharma-builds\pharma-original-owner-enrollment-20261019-59071bc80b9c475093df120567535f07")
CONFIRM = "I AUTHORIZE ONE COPY-ONLY SIGNED DISPOSABLE TICKET"
HEX32 = re.compile(r"[0-9a-f]{64}\Z")
TOKEN = re.compile(r"[0-9a-f]{32}\Z")
DENIED = "COPY_ONLY_TICKET_REFUSED"


class Refused(ValueError):
    """Sanitizable error: never include private credential or source cells."""


def _require_windows() -> None:
    custody._require_windows()


def _frame(digest, blob: bytes) -> None:
    digest.update(len(blob).to_bytes(8, "big"))
    digest.update(blob)


def _safe_identifier(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


_RUST_WHITESPACE = ("\t\n\v\f\r \u0085\u00a0\u1680\u2028\u2029"
                    "\u202f\u205f\u3000" + "".join(
                        chr(code) for code in range(0x2000, 0x200B)))


def _rust_trim_is_empty(value: str) -> bool:
    """Match Rust str::trim's Unicode White_Space (Python strips C0 1C..1F)."""
    return not value.strip(_RUST_WHITESPACE)


def originals_and_scope_sha(db: sqlite3.Connection) -> tuple[int, str]:
    """Byte-exact Python port of Rust originals_and_scope_sha.

    Native has been corrected to exclude only actual SQLite internal names
    with the BINARY 'sqlite_' prefix. Its old NOT LIKE 'sqlite_%' accidentally
    treated '_' as a wildcard and omitted names such as sqliteXcustom.
    """
    names = [row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND substr(name,1,7) COLLATE BINARY != 'sqlite_' ORDER BY name")]
    if not 1 <= len(names) <= 512:
        raise Refused("Unrecognized native physical table inventory")
    digest = hashlib.sha256()
    _frame(digest, SCOPE_DOMAIN)
    scoped_tables = 0
    originals = 0
    for name in names:
        fields = list(db.execute(f"PRAGMA table_xinfo({_safe_identifier(name)})"))
        column_names = [str(row[1]) for row in fields]
        if "pharmacy_id" not in column_names:
            continue
        if any(row[6] != 0 for row in fields):
            raise Refused("Generated or hidden direct-scope source columns denied")
        scoped_tables += 1
        with_rowid = db.execute(
            "SELECT wr FROM pragma_table_list WHERE name=?", (name,)).fetchall()
        if len(with_rowid) != 1 or with_rowid[0][0] != 0:
            raise Refused("Direct scope requires ordinary unambiguous rowid")
        alias = next((x for x in ("_rowid_", "rowid", "oid")
                      if x not in column_names), None)
        if alias is None:
            raise Refused("All physical rowid aliases are shadowed")
        _frame(digest, name.encode("utf-8"))
        sql = (f"SELECT {alias} AS scope_rowid,typeof(pharmacy_id) AS scope_kind,"
               f"pharmacy_id AS scope_text FROM {_safe_identifier(name)} ORDER BY {alias}")
        for rowid, storage, literal in db.execute(sql):
            if type(rowid) is not int or not -(2**63) <= rowid < 2**63:
                raise Refused("Unexpected native SQLite physical rowid type")
            if storage not in ("null", "text"):
                raise Refused("Direct tenant storage must be NULL or TEXT")
            if storage == "null":
                if literal is not None:
                    raise Refused("Malformed NULL tenant literal")
                literal_bytes = b""
            else:
                if type(literal) is not str or (
                        literal not in (TENANT, "local_default") and
                        not _rust_trim_is_empty(literal)):
                    raise Refused("Foreign or ambiguous explicit tenant is denied")
                literal_bytes = literal.encode("utf-8")
            _frame(digest, rowid.to_bytes(8, "big", signed=True))
            _frame(digest, storage.encode("utf-8"))
            _frame(digest, literal_bytes)
            if literal != TENANT:
                originals += 1
    if scoped_tables == 0 or originals == 0:
        raise Refused("Native source has no original direct tenant cells to normalize")
    return originals, digest.hexdigest()


def message_bytes(*, version: int, original_v29_sha: str, source_sha: str,
                  scope_sha: str, nonce: bytes, expires: int, owner_id: str) -> bytes:
    if (type(version) is not int or version not in (52, 67) or
            any(not HEX32.fullmatch(value)
                for value in (original_v29_sha, source_sha, scope_sha)) or
            not isinstance(nonce, bytes) or len(nonce) != 32 or
            not any(nonce) or type(expires) is not int or
            not 0 <= expires < 2**64 or not isinstance(owner_id, str) or
            not owner_id or len(owner_id) > 128 or
            not owner_id.isascii() or owner_id.strip() != owner_id or
            any(ord(c) < 32 or ord(c) == 127 for c in owner_id)):
        raise Refused("Native signature message parameters are invalid")
    identity = hashlib.sha256()
    _frame(identity, owner_id.encode("ascii"))
    _frame(identity, TENANT.encode("ascii"))
    return (DOMAIN + version.to_bytes(8, "big", signed=True) +
            bytes.fromhex(original_v29_sha) + bytes.fromhex(source_sha) +
            bytes.fromhex(scope_sha) + nonce + expires.to_bytes(8, "big") +
            identity.digest())


def _public_enrollment(directory: Path) -> dict:
    """Require existing valid certificate, known SHA pins and exact signer ID."""
    try:
        verified = custody.verify_certificate(directory)
        if verified["status"] != "PUBLIC_CURRENT_DECLARATION_SIGNATURE_VERIFIED":
            raise Refused("Original current-declaration certificate is not verified")
        raw = (directory / custody.FILE_MANIFEST).read_bytes()
        if len(raw) > 20000:
            raise Refused("Unexpected oversized owner public manifest")
        manifest = json.loads(raw)
        if custody._json_bytes(manifest) != raw:
            raise Refused("Noncanonical public enrollment evidence")
        facts = manifest["source_evidence"]
        if (manifest["owner_id"] != custody.OWNER_ID or
                facts["independently_sealed_v29_sha256"] != custody.SEALED_PIN or
                facts["original_v29_sha256"] != custody.ORIGINAL_PIN or
                facts["native_source_sha256"] != NATIVE_SOURCE_PIN or
                facts["native_sqlx_version"] != 67 or
                not isinstance(manifest["public_key_ed25519_hex"], str) or
                not HEX32.fullmatch(manifest["public_key_ed25519_hex"]) or
                manifest["independent_historical_owner_proof"] is not False or
                manifest["commercial_release_promoted"] is not False):
            raise Refused("Enrollment manifest conflicts with custody pins or scope")
        return manifest
    except (KeyError, ValueError, TypeError, OSError) as exc:
        raise Refused("Public owner manifest rejected") from exc


def _source_root() -> Path:
    return custody.source_paths()[0]


def _native_source(root: Path) -> Path:
    return root / NATIVE_SOURCE_SUBDIR / NATIVE_SOURCE_NAME


def _source_read_locked(root: Path, source: Path) -> tuple[bytes, tuple]:
    """Acquire Windows FILE_SHARE_READ handle; refuse concurrent replace/write."""
    _require_windows()
    custody._contained_file(source, root)
    try:
        import win32file
        import win32con
    except ImportError as exc:
        raise Refused("Windows exclusive-read capability unavailable") from exc
    handle = win32file.CreateFile(
        str(source), win32con.GENERIC_READ, win32con.FILE_SHARE_READ, None,
        win32con.OPEN_EXISTING, 0x00200000, None)  # FILE_FLAG_OPEN_REPARSE_POINT
    try:
        before = source.stat()
        # Do not permit a hard link or a junction to serve as a custody source.
        info = win32file.GetFileInformationByHandle(handle)
        if info[7] != 1:
            raise Refused("Pinned native source must have one hard link")
        data = bytearray()
        while True:
            _, chunk = win32file.ReadFile(handle, 1024 * 1024)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > custody.MAX_BYTES:
                raise Refused("Pinned native source exceeds custody budget")
        raw = bytes(data)
        if (raw[:16] != b"SQLite format 3\x00" or
                len(raw) != before.st_size or
                hashlib.sha256(raw).hexdigest() != NATIVE_SOURCE_PIN):
            raise Refused("Detached native source failed its independent SHA pin")
        custody._contained_file(source, root)
        after = source.stat()
        fingerprint = (after.st_size, after.st_mtime_ns, after.st_ino)
        if fingerprint != (before.st_size, before.st_mtime_ns, before.st_ino):
            raise Refused("Pinned native source changed during locked read")
        return raw, fingerprint
    finally:
        handle.Close()


def preview(*, root: Path, source: Path, enrolled: Path,
            original: Path, sealed: Path, migrations: Path) -> tuple[dict, dict, bytes]:
    """Audited source + sanitized preflight evidence. No secret-key access."""
    _require_windows()
    # Enrollment and source inputs must be exact, pre-existing path locations.
    manifest = _public_enrollment(enrolled)
    if source.resolve(strict=True) != _native_source(root).resolve(strict=True):
        raise Refused("Only the pinned pre-existing disposable v67 source is supported")
    raw, fingerprint = _source_read_locked(root, source)
    v29 = custody.inspect_sources(
        root=root, original=original, sealed=sealed,
        migrations=migrations, native=source, native_sha256=NATIVE_SOURCE_PIN)
    if (v29.get("status") != "PASS_NATIVE_SOURCE_BOUND_FOR_CURRENT_DECLARATION" or
            v29.get("native_sqlx_version") != 67 or
            v29.get("native_source_sha256") != NATIVE_SOURCE_PIN):
        raise Refused("Independent original-to-native lineage is incomplete")
    with closing(custody._ram(raw)) as db:
        custody._migrations(db, migrations, 67)
        owner = custody._owner(db)
        if owner[1] != manifest["owner_id"] or owner[4:] != (
                "null", None, "text", "local_default"):
            raise Refused("Native source owner is ambiguous or not 032/052 quarantined")
        reviews = db.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND "
            "name='native_owner_scope_review'").fetchone()[0]
        if reviews:
            disputed = db.execute(
                "SELECT COUNT(*) FROM native_owner_scope_review WHERE "
                "typeof(owner_id)!='text' OR owner_id!=?",
                (manifest["owner_id"],)).fetchone()[0]
            if disputed:
                raise Refused("Native custody contains another disputed owner")
        originals_count, scope_sha = originals_and_scope_sha(db)
        if (scope_sha != EXPECTED_SCOPE_SHA or
                originals_count != EXPECTED_ORIGINAL_SCOPE_CELLS):
            raise Refused("Native source direct-scope evidence differs from independent custody")
    custody._unchanged(source, NATIVE_SOURCE_PIN, fingerprint, root)
    public = {"status": "PASS_READ_ONLY_COPY_ONLY_TICKET_PREFLIGHT",
              "original_v29_sha256": custody.ORIGINAL_PIN,
              "independently_sealed_v29_sha256": custody.SEALED_PIN,
              "native_source_sha256": NATIVE_SOURCE_PIN,
              "native_version": 67,
              "scope_sha256": scope_sha,
              "original_scope_cells_requiring_copy_only_normalization": originals_count,
              "known_accounts_sequence_custody_difference": v29["known_custody_difference"],
              "enrolled_current_owner_public_key_verified": True,
              "enrollment_public_manifest_sha256":
                  hashlib.sha256(custody._json_bytes(manifest)).hexdigest(),
              "native_installed_or_profile_modified": False,
              "owner_historical_authentication_proven": False,
              "release_or_login_authorized": False}
    return public, manifest, raw


def _source_claim(root: Path, source_sha: str) -> Path:
    return root / (".owner-copy-only-source-" + source_sha + ".sealed")


def _safe_stage_root(root: Path) -> None:
    _require_windows()
    if (not root.is_absolute() or root.name != "pharma-disposable-data-copies" or
            not root.is_dir()):
        raise Refused("Unexpected native disposable stage root")
    for path in (root, *root.parents):
        if path.exists():
            custody._no_reparse(path)
    # Refuse broad writable ACLs that could delete/replay a root claim, rather
    # than silently relaxing the Windows-only replay isolation contract.
    _, _, _, _, _, sec, _, _ = custody._crypto()
    descriptor = sec.GetNamedSecurityInfo(
        str(root), sec.SE_FILE_OBJECT, sec.DACL_SECURITY_INFORMATION)
    dacl = descriptor.GetSecurityDescriptorDacl()
    if dacl is None:
        raise Refused("Disposable root has an unsafe NULL Windows DACL")
    broad = {"S-1-1-0", "S-1-5-11", "S-1-5-32-545",
             "S-1-5-32-546", "S-1-5-7", "S-1-5-2"}
    write_mask = (0x0002 | 0x0004 | 0x0040 | 0x00010000 |
                  0x00040000 | 0x00080000 | 0x40000000 | 0x10000000)
    for index in range(dacl.GetAceCount()):
        ace = dacl.GetAce(index)
        if (ace[0][0] == sec.ACCESS_ALLOWED_ACE_TYPE and
                sec.ConvertSidToStringSid(ace[2]) in broad and
                ace[1] & write_mask):
            raise Refused("Disposable root grants broad write/delete access")


def _owner_sign(directory: Path, manifest: dict, message: bytes) -> bytes:
    """Decrypt seed in ephemeral RAM after all public/custody checks."""
    _require_windows()
    custody.verify_certificate(directory)
    # Detection of certificate/manifest swaps since prior preflight.
    if (directory / custody.FILE_MANIFEST).read_bytes() != custody._json_bytes(manifest):
        raise Refused("Public owner manifest changed during issue")
    _, _, serialization, win32crypt, *_ = custody._crypto()
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    secret = directory / custody.FILE_SECRET
    custody._private_acl(secret, set_restriction=False)
    raw = secret.read_bytes()
    if not 64 <= len(raw) <= 4096:
        raise Refused("DPAPI owner private key envelope size invalid")
    seed = win32crypt.CryptUnprotectData(raw, None, None, None, 0)[1]
    try:
        if len(seed) != 32:
            raise Refused("CurrentUser DPAPI did not restore an Ed25519 seed")
        key = Ed25519PrivateKey.from_private_bytes(seed)
        actual = key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
        if actual != manifest["public_key_ed25519_hex"]:
            raise Refused("CurrentUser DPAPI private signer differs from enrolled public key")
        signature = key.sign(message)
        key.public_key().verify(signature, message)
        return signature
    finally:
        del seed


def _ticket_json(*, source_sha: str, scope_sha: str, nonce: bytes,
                 expires: int, signature: bytes) -> bytes:
    ticket = {"source_sha256": source_sha, "scope_sha256": scope_sha,
              "nonce": nonce.hex(), "expires_unix_seconds": expires,
              "ed25519_signature": signature.hex()}
    raw = custody._json_bytes(ticket)
    if len(raw) > 4096:
        raise Refused("Native wire ticket exceeds size limit")
    return raw


def verify_ticket(ticket: dict, *, version: int, public_key_hex: str,
                  original_v29_sha: str, now: int,
                  expected_source_sha: str, expected_scope_sha: str,
                  owner_id: str = custody.OWNER_ID) -> None:
    if (not isinstance(ticket, dict) or
            set(ticket) != {"source_sha256", "scope_sha256", "nonce",
                        "expires_unix_seconds", "ed25519_signature"} or
            any(not isinstance(ticket[k], str) for k in
                ("source_sha256", "scope_sha256", "nonce", "ed25519_signature")) or
            ticket["source_sha256"] != expected_source_sha or
            ticket["scope_sha256"] != expected_scope_sha or
            type(ticket["expires_unix_seconds"]) is not int or
            ticket["expires_unix_seconds"] < now or
            ticket["expires_unix_seconds"] - now > MAX_AGE or
            not HEX32.fullmatch(ticket["nonce"]) or
            not any(bytes.fromhex(ticket["nonce"])) or
            not re.fullmatch(r"[0-9a-f]{128}", ticket["ed25519_signature"]) or
            not HEX32.fullmatch(public_key_hex)):
        raise Refused("Native signed ticket wire fields or expiry are invalid")
    message = message_bytes(
        version=version, original_v29_sha=original_v29_sha,
        source_sha=expected_source_sha, scope_sha=expected_scope_sha,
        nonce=bytes.fromhex(ticket["nonce"]), expires=ticket["expires_unix_seconds"],
        owner_id=owner_id)
    try:
        _, EdPublic, *_ = custody._crypto()
        EdPublic.from_public_bytes(bytes.fromhex(public_key_hex)).verify(
            bytes.fromhex(ticket["ed25519_signature"]), message)
    except Exception as exc:
        raise Refused("Native Ed25519 signed-ticket validation failed") from exc


def issue(*, root: Path, source: Path, enrolled: Path, original: Path,
          sealed: Path, migrations: Path, confirm: str,
          expires_unix_seconds: int, now: int | None = None) -> dict:
    """The real path is gated exclusively through explicit `sign` CLI."""
    _require_windows()
    if confirm != CONFIRM:
        raise Refused("Separate exact copy-only confirmation required")
    now = int(time.time()) if now is None else now
    if (type(now) is not int or type(expires_unix_seconds) is not int or
            expires_unix_seconds <= now or
            expires_unix_seconds - now > MAX_AGE):
        raise Refused("Signed ticket expiry must be future and at most 30 days")
    evidence, manifest, raw = preview(
        root=root, source=source, enrolled=enrolled, original=original,
        sealed=sealed, migrations=migrations)
    _safe_stage_root(root)
    # Commit to the same source that passed SHA and typed-census preflight
    # before creating any irreversible claim or unsealing a signing key.
    source_fingerprint = source.stat()
    custody._unchanged(source, NATIVE_SOURCE_PIN,
                       (source_fingerprint.st_size, source_fingerprint.st_mtime_ns,
                        source_fingerprint.st_ino), root)
    if _source_claim(root, NATIVE_SOURCE_PIN).exists():
        raise Refused("This exact source SHA already has a reserved copy-only ticket")
    nonce = secrets.token_bytes(32)
    if len(nonce) != 32 or not any(nonce):
        raise Refused("Cryptographic ticket nonce source failed")
    message = message_bytes(
        version=evidence["native_version"],
        original_v29_sha=manifest["source_evidence"]["independently_sealed_v29_sha256"],
        source_sha=evidence["native_source_sha256"],
        scope_sha=evidence["scope_sha256"], nonce=nonce,
        expires=expires_unix_seconds, owner_id=manifest["owner_id"])
    # Reserve ONE issuance per pinned source SHA. A crash leaves the reservation
    # burned. Never clear it, reuse a prior token, or resume an incomplete stage.
    claim = _source_claim(root, NATIVE_SOURCE_PIN)
    custody._exclusive_file(claim, b"original-owner copy-only SHA reserved; no replay\n")
    signature = _owner_sign(enrolled, manifest, message)
    wire = _ticket_json(source_sha=NATIVE_SOURCE_PIN, scope_sha=evidence["scope_sha256"],
                        nonce=nonce, expires=expires_unix_seconds, signature=signature)
    parsed = json.loads(wire)
    verify_ticket(parsed, version=evidence["native_version"],
                  public_key_hex=manifest["public_key_ed25519_hex"],
                  original_v29_sha=custody.SEALED_PIN, now=now,
                  expected_source_sha=NATIVE_SOURCE_PIN,
                  expected_scope_sha=evidence["scope_sha256"])
    # Stage exactly two files, matching native Rust checked_stage. Parent root
    # claim is outside that token directory and cannot be treated as input.
    token = secrets.token_hex(16)
    if not TOKEN.fullmatch(token):
        raise Refused("Native stage token generation failed")
    folder = root / token
    folder.mkdir(mode=0o700)
    custody._private_acl(folder)
    custody._exclusive_file(folder / "snapshot.sqlite3", raw)
    custody._exclusive_file(folder / "ticket.json", wire)
    custody._private_acl(folder, set_restriction=False)
    if set(p.name for p in folder.iterdir()) != {"snapshot.sqlite3", "ticket.json"}:
        raise Refused("Native ticket stage contains unexpected files")
    if hashlib.sha256((folder / "snapshot.sqlite3").read_bytes()).hexdigest() != NATIVE_SOURCE_PIN:
        raise Refused("Private staged source SHA differs from signed native source")
    custody._unchanged(source, NATIVE_SOURCE_PIN,
                       (source_fingerprint.st_size, source_fingerprint.st_mtime_ns,
                        source_fingerprint.st_ino), root)
    return {"status": "SIGNED_NATIVE_COPY_ONLY_DISPOSABLE_STAGE",
            "stage_token": token, "native_source_sha256": NATIVE_SOURCE_PIN,
            "scope_sha256": evidence["scope_sha256"],
            "owner_public_key_match": True, "ticket_signature_verified": True,
            "expires_unix_seconds": expires_unix_seconds,
            "source_replay_claim_reserved": True,
            "installed_profile_mutated": False, "release_or_login_granted": False}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inspect", "sign"), nargs="?", default="inspect")
    parser.add_argument("--expires-unix-seconds", type=int)
    parser.add_argument("--confirm")
    args = parser.parse_args(argv)
    try:
        _require_windows()
        root, original, sealed = custody.source_paths()
        source = _native_source(root)
        migration_root = Path(__file__).resolve().parent.parent / "src-tauri" / "migrations"
        if args.action == "inspect":
            if args.confirm is not None or args.expires_unix_seconds is not None:
                raise Refused("inspect cannot accept sign-only arguments")
            public, _, _ = preview(
                root=root, source=source, enrolled=ENROLLMENT,
                original=original, sealed=sealed, migrations=migration_root)
            result = public
        else:
            if args.confirm != CONFIRM or args.expires_unix_seconds is None:
                raise Refused("Sign requires current explicit confirmation and expiry")
            result = issue(
                root=root, source=source, enrolled=ENROLLMENT,
                original=original, sealed=sealed, migrations=migration_root,
                confirm=args.confirm, expires_unix_seconds=args.expires_unix_seconds)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (Refused, custody.Refused, OSError, sqlite3.Error, ValueError,
            TypeError, KeyError, ImportError, OverflowError, UnicodeError,
            AttributeError):
        print(json.dumps({"status": DENIED,
                          "reason": "source provenance, owner custody, nonce/replay, "
                                    "expiry or Windows protection failed"}, sort_keys=True),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
