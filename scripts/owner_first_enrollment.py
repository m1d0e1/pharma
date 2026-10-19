"""Windows-only, standalone, fail-closed first-owner *current declaration*.

inspect (the default) reads detached SHA-pinned SQLite files exclusively via
OS bytes and SQLite RAM deserialization. It never opens installed SQLite as a
database, changes a source, generates keys, or authorizes historical ownership.

enroll requires independent source lineage, a native SQLx 52/67 detached copy,
an explicit current declaration and confirmation, and a new off-profile output
directory. A new local Ed25519 key is immediately DPAPI CurrentUser wrapped;
the new private key is NEVER persisted or printed in plaintext.

verify checks the self-signed public certificate and its SHA-bound manifest.
It does not convert self-assertion into third-party or historical authorization.
The output is a current local declaration; no release or owner login is granted.
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
import sqlite3
import stat
import struct
import sys


ORIGINAL_SUBDIR = "pharma-v02110-current-installed-offline-3c440154ab73402cab74949543ce2879"
ORIGINAL_FILENAME = "current-v02109-offline-source.sqlite3"
ORIGINAL_PIN = "4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197"
SEALED_SUBDIR = "pharma-v02110-prebuild-snapshot-cb743d7b7ab14ffd9583ee1a64cdd472"
SEALED_FILENAME = "current-v02109-sealed.sqlite3"
SEALED_PIN = "06fc00f32ec2603758cd3f0eb12c38024f22fce27c4e5f7875ab47aceb6c87fb"
EXPECTED_TABLES = 67
EXPECTED_ROWS = 289778
SEALED_ACCOUNTS_SEQ = 4815
ORIGINAL_ACCOUNTS_SEQ = 4829
OWNER_ID = "admin"
CONFIRM_PHRASE = "I CONFIRM CURRENT FIRST-OWNER ENROLLMENT"
MAX_BYTES = 700_000_000
PIN_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
FILE_MANIFEST = "public_manifest.json"
FILE_CERTIFICATE = "owner_enrollment_certificate.json"
FILE_SECRET = "owner_private_key.dpapi"
FILE_COMPLETE = "COMPLETE.json"
CERT_FORMAT = "pharma.current-first-owner-declaration.v1"


class Refused(ValueError):
    """A sanitizable refusal: never include original row contents in messages."""


def _require_windows() -> None:
    if os.name != "nt":
        raise Refused("Windows CurrentUser DPAPI and native file ACLs are required")


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def _hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _typed(value: object) -> tuple[str, bytes]:
    if value is None:
        return ("null", b"")
    if type(value) is int:
        return ("integer", str(value).encode("ascii"))
    if type(value) is float:
        return ("real", struct.pack("!d", value))
    if type(value) is str:
        return ("text", value.encode("utf-8"))
    if type(value) is bytes:
        return ("blob", value)
    raise Refused("Unrecognized SQLite storage class")


def _no_reparse(path: Path) -> None:
    attrs = path.lstat()
    if (stat.S_ISLNK(attrs.st_mode) or
            getattr(attrs, "st_file_attributes", 0) &
            getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
        raise Refused("Path contains an alias or reparse point")


def _contained_file(path: Path, root: Path, *, precise: Path | None = None) -> None:
    if (not path.is_absolute() or not root.is_absolute() or
            not root.is_dir() or not path.is_file()):
        raise Refused("Only absolute detached custody paths are permitted")
    absolute = path.resolve(strict=True)
    root_abs = root.resolve(strict=True)
    if not absolute.is_relative_to(root_abs) or absolute == root_abs:
        raise Refused("Detached custody source lies outside the approved root")
    if precise is not None and absolute != precise.resolve(strict=True):
        raise Refused("Detached custody path differs from the retained pinned source")
    p = path
    while p != root:
        _no_reparse(p)
        p = p.parent
        if len(p.parts) < len(root.parts):
            raise Refused("Detached source escaped its root")
    _no_reparse(root)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise Refused("Detached source is not an exclusive regular file")
    if not 4096 <= info.st_size <= MAX_BYTES:
        raise Refused("Detached source has an invalid file size")
    for ending in ("-wal", "-shm", "-journal"):
        if Path(str(path) + ending).exists() or Path(str(path) + ending).is_symlink():
            raise Refused("Detached SQLite source has a mutable sidecar")


def _capture(path: Path, expected: str, root: Path,
             *, precise: Path | None = None) -> tuple[bytes, tuple]:
    if not PIN_PATTERN.fullmatch(expected):
        raise Refused("An independent SHA-256 pin is mandatory")
    _contained_file(path, root, precise=precise)
    before = path.stat()
    with path.open("rb") as fh:
        raw = fh.read(MAX_BYTES + 1)
    if (raw[:16] != b"SQLite format 3\x00" or len(raw) != before.st_size or
            _hash(raw) != expected):
        raise Refused("Detached custody input failed its independent SHA-256 pin")
    _contained_file(path, root, precise=precise)
    after = path.stat()
    fingerprint = (after.st_size, after.st_mtime_ns, after.st_ino)
    if fingerprint != (before.st_size, before.st_mtime_ns, before.st_ino):
        raise Refused("Detached custody file changed while reading")
    return raw, fingerprint


def _unchanged(path: Path, expected: str, fingerprint: tuple, root: Path,
               *, precise: Path | None = None) -> None:
    _contained_file(path, root, precise=precise)
    item = path.stat()
    if (item.st_size, item.st_mtime_ns, item.st_ino) != fingerprint:
        raise Refused("Source file metadata changed during verification")
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for part in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(part)
    if h.hexdigest() != expected:
        raise Refused("Source file changed during verification")
    _contained_file(path, root, precise=precise)


def _ram(data: bytes) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    try:
        db.deserialize(data)
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA query_only").fetchone() != (1,):
            raise Refused("RAM SQLite read-only guard failed")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise Refused("SQLite integrity_check failed")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise Refused("SQLite foreign_key_check failed")
    except BaseException:
        db.close()
        raise
    return db


def _migrations(db: sqlite3.Connection, directory: Path, expected_end: int) -> None:
    rows = db.execute(
        "SELECT version,description,success,checksum FROM _sqlx_migrations "
        "ORDER BY version").fetchall()
    if len(rows) != expected_end or expected_end not in (29, 52, 67):
        raise Refused("SQLx migration version is incomplete or unsupported")
    for i, row in enumerate(rows, 1):
        if type(row[0]) is not int or row[0] != i or row[2] != 1:
            raise Refused("SQLx migration chain is incomplete or unsuccessful")
        choices = list(directory.glob(f"{i:03d}_*.sql"))
        if len(choices) != 1 or not choices[0].is_file():
            raise Refused("Local SQLx migration chain differs from expected")
        # Registered SQLx historical 001/002 descriptions precede the current
        # filenames; their SHA-384 bytes must still match without exception.
        label = {1: "initial_schema", 2: "performance_tuning"}.get(
            i, choices[0].stem.split("_", 1)[1])
        digest = hashlib.sha384(choices[0].read_bytes()).digest()
        if row[1] != label or row[3] != digest:
            raise Refused("SQLx installed checksum differs from retained migration")


def _schema(db: sqlite3.Connection) -> tuple:
    return tuple(db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master "
                            "ORDER BY type,name,tbl_name,sql"))


def _tables(db: sqlite3.Connection) -> list[str]:
    tables = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    if len(set(tables)) != len(tables) or not 3 <= len(tables) <= 512:
        raise Refused("Original physical table coverage is invalid")
    return tables


def _columns(db: sqlite3.Connection, table: str) -> tuple[str, ...]:
    return tuple(row[1] for row in db.execute(
        f"PRAGMA table_xinfo({_ident(table)})") if row[6] in (0, 2, 3))


def _rows(db: sqlite3.Connection, table: str, cols: tuple[str, ...]):
    available = _columns(db, table)
    if not cols or any(column not in available for column in cols):
        raise Refused("Native source lost an original typed column")
    fields = ",".join(_ident(name) for name in cols)
    wr = db.execute("SELECT wr FROM pragma_table_list WHERE name=?",
                    (table,)).fetchone()
    if wr is None:
        raise Refused("Original physical source table was removed")
    if wr[0]:
        info = list(db.execute(f"PRAGMA table_info({_ident(table)})"))
        primary = [r[1] for r in sorted(info, key=lambda r: r[5]) if r[5]]
        if not primary:
            raise Refused("WITHOUT ROWID physical table has no original key")
        sql = (f"SELECT {fields} FROM {_ident(table)} ORDER BY " +
               ",".join(_ident(x) for x in primary))
    else:
        aliases = [x for x in ("_rowid_", "rowid", "oid") if x not in available]
        if not aliases:
            raise Refused("SQLite row identifier is ambiguous")
        sql = (f"SELECT {aliases[0]},{fields} FROM {_ident(table)} "
               f"ORDER BY {aliases[0]}")
    return db.execute(sql)


def _same_rows(left: sqlite3.Connection, right: sqlite3.Connection,
               table: str, cols: tuple[str, ...]) -> int:
    from itertools import zip_longest
    n = 0
    for l, r in zip_longest(_rows(left, table, cols), _rows(right, table, cols)):
        if l is None or r is None or len(l) != len(r) or any(
                _typed(a) != _typed(b) for a, b in zip(l, r)):
            raise Refused("Typed physical historical data differs: " + table)
        n += 1
    return n


def _sequences(db: sqlite3.Connection) -> dict[str, int]:
    rows = db.execute("SELECT name,seq FROM sqlite_sequence").fetchall()
    if len(rows) != len(set(r[0] for r in rows)) or any(
            type(n) is not str or type(s) is not int for n, s in rows):
        raise Refused("SQLite AUTOINCREMENT witness is malformed")
    return dict(rows)


def _owner(db: sqlite3.Connection) -> tuple:
    rows = db.execute(
        "SELECT rowid,id,role,is_active,typeof(password_hash),password_hash,"
        "typeof(pharmacy_id),pharmacy_id FROM users "
        "WHERE lower(trim(coalesce(role,'')))='owner'").fetchall()
    if len(rows) != 1 or rows[0][1:4] != (OWNER_ID, "owner", 1):
        raise Refused("Original active owner identity is ambiguous")
    return rows[0]


def _v29_owner_provenance(original: sqlite3.Connection,
                          sealed: sqlite3.Connection, directory: Path) -> None:
    owner_a = _owner(original)
    owner_b = _owner(sealed)
    if any(_typed(a) != _typed(b) for a, b in zip(owner_a, owner_b)):
        raise Refused("Original and independently sealed owner custody differ")
    mig32 = (directory / "032_remove_public_owner_bootstrap_credential.sql").read_text(
        encoding="utf-8")
    known = re.search(r"AND password_hash = '([^']+)'", mig32)
    if (known is None or owner_a[4] != "text" or
            owner_a[5] != known.group(1) or owner_a[6:] != ("null", None)):
        raise Refused("Original owner credential does not satisfy 032 precondition")


def _native_lineage(baseline: sqlite3.Connection, native: sqlite3.Connection,
                    baseline_cols: dict[str, tuple[str, ...]], version: int) -> dict:
    old = _owner(baseline)
    new = _owner(native)
    if old[:4] != new[:4] or new[4:] != ("null", None, "text", "local_default"):
        raise Refused("Native 032 credential quarantine or 052 scope is missing")
    old_users = baseline_cols["users"]
    if "password_hash" not in old_users or "pharmacy_id" not in old_users:
        raise Refused("Original owner provenance fields are missing")
    changed = 0
    count = 0
    for table, cols in baseline_cols.items():
        if table in ("_sqlx_migrations", "sqlite_sequence"):
            continue
        if table != "users":
            count += _same_rows(baseline, native, table, cols)
            continue
        from itertools import zip_longest
        for older, current in zip_longest(_rows(baseline, "users", cols),
                                         _rows(native, "users", cols)):
            if older is None or current is None:
                raise Refused("Native user row count changed")
            for i, col in enumerate(("_rowid_", *cols)):
                if _typed(older[i]) == _typed(current[i]):
                    continue
                if (older[0] != old[0] or
                        (col == "password_hash" and
                         (current[i] is not None or older[i] != old[5])) or
                        (col == "pharmacy_id" and
                         (current[i] != "local_default" or older[i] is not None)) or
                        col not in ("password_hash", "pharmacy_id")):
                    raise Refused("Native 032/052 provenance or other user data differs")
                changed += 1
            count += 1
        if changed != 2:
            raise Refused("Native original owner 032/052 transition is incomplete")
    if version not in (52, 67):
        raise Refused("Native signed-copy enrollment accepts SQLx 52 or 67 only")
    # The native SQLx ledger has 30..52/67 new records. Its 1..29 custody
    # prefix must preserve every original storage class and field, including
    # execution_time, in addition to independently matched SHA-384 checksums.
    sqlx_cols = baseline_cols["_sqlx_migrations"]
    if any(c not in _columns(native, "_sqlx_migrations") for c in sqlx_cols):
        raise Refused("Native SQLx metadata lost an original column")
    projection = ",".join(_ident(c) for c in sqlx_cols)
    old_sqlx = baseline.execute(
        f"SELECT {projection} FROM _sqlx_migrations ORDER BY version")
    new_sqlx = native.execute(
        f"SELECT {projection} FROM _sqlx_migrations "
        "WHERE version<=29 ORDER BY version")
    from itertools import zip_longest
    sqlx_count = 0
    for earlier, current in zip_longest(old_sqlx, new_sqlx):
        if (earlier is None or current is None or
                len(earlier) != len(current) or any(
                    _typed(a) != _typed(b) for a, b in zip(earlier, current))):
            raise Refused("Native SQLx v29 typed custody prefix changed")
        sqlx_count += 1
    if sqlx_count != 29:
        raise Refused("Native SQLx v29 custody prefix is incomplete")
    prior = _sequences(baseline)
    newer = _sequences(native)
    if any(newer.get(k) != (ORIGINAL_ACCOUNTS_SEQ if k == "accounts" else v)
           for k, v in prior.items()):
        raise Refused("Native historical sequence lineage differs")
    return {"native_v29_original_rows_type_exact_except_032_052":
            count + sqlx_count + len(prior),
            "native_owner_changed_columns": ["password_hash", "pharmacy_id"],
            "native_sqlx_version": version}


def source_paths() -> tuple[Path, Path, Path]:
    root = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
    return (root, root / ORIGINAL_SUBDIR / ORIGINAL_FILENAME,
            root / SEALED_SUBDIR / SEALED_FILENAME)


def inspect_sources(*, root: Path, original: Path, sealed: Path,
                    migrations: Path, native: Path | None = None,
                    native_sha256: str | None = None,
                    original_pin: str = ORIGINAL_PIN,
                    sealed_pin: str = SEALED_PIN) -> dict:
    """Internal injectable paths/pins enable synthetic tests, never CLI overrides."""
    _require_windows()
    if original == sealed or original.resolve() == sealed.resolve():
        raise Refused("Original and independent seal must be different files")
    first, fm = _capture(original, original_pin, root)
    second, sm = _capture(sealed, sealed_pin, root)
    other: bytes | None = None
    nm: tuple | None = None
    if native is not None:
        if (not native_sha256 or native.resolve() in
                (original.resolve(), sealed.resolve())):
            raise Refused("Independent native source and SHA-256 are mandatory")
        other, nm = _capture(native, native_sha256, root)
    elif native_sha256 is not None:
        raise Refused("Native source path and independent pin are required together")
    with closing(_ram(first)) as db, closing(_ram(second)) as proof:
        _migrations(db, migrations, 29)
        _migrations(proof, migrations, 29)
        if _schema(db) != _schema(proof):
            raise Refused("Independent v29 physical schema differs")
        tables = _tables(proof)
        if len(tables) != EXPECTED_TABLES:
            raise Refused("Independent original v29 physical table census differs")
        columns = {name: _columns(proof, name) for name in tables}
        count = 0
        for table, cols in columns.items():
            if table == "sqlite_sequence":
                continue
            count += _same_rows(proof, db, table, cols)
        before, after = _sequences(proof), _sequences(db)
        if (before.get("accounts") != SEALED_ACCOUNTS_SEQ or
                after.get("accounts") != ORIGINAL_ACCOUNTS_SEQ or
                set(before) != set(after) or any(
                    before[name] != after[name] for name in before if name != "accounts")):
            raise Refused("Independent v29 sequence witness differs beyond known accounts drift")
        sequence_rows = len(before)
        if count + sequence_rows != EXPECTED_ROWS:
            raise Refused("Independent original v29 typed physical row census differs")
        _v29_owner_provenance(db, proof, migrations)
        result: dict = {
            "status": "PASS_READ_ONLY_V29_CUSTODY",
            "original_v29_sha256": original_pin,
            "independently_sealed_v29_sha256": sealed_pin,
            "v29_sqlx_migrations": 29,
            "v29_physical_tables": len(tables),
            "v29_physical_rows": count + sequence_rows,
            "typed_original_business_rows_identical": True,
            "known_custody_difference": {
                "table": "sqlite_sequence", "entry": "accounts",
                "sealed_autoincrement": SEALED_ACCOUNTS_SEQ,
                "original_autoincrement": ORIGINAL_ACCOUNTS_SEQ,
                "historical_writer_proven": False,
            },
            "original_owner_id": OWNER_ID,
            "032_public_bootstrap_hash_only_custody_fact": True,
            "owner_authenticated_by_v29": False,
            "independent_historical_owner_proof": False,
            "release_or_operational_license_authorized": False,
            "sources_opened_with_disk_sqlite": False,
        }
        if other is not None:
            with closing(_ram(other)) as target:
                rows = target.execute(
                    "SELECT version FROM _sqlx_migrations ORDER BY version").fetchall()
                version = len(rows)
                if version not in (52, 67):
                    raise Refused("Native source must be a complete SQLx 52 or 67 copy")
                _migrations(target, migrations, version)
                result.update(_native_lineage(proof, target, columns, version))
                result.update({"status": "PASS_NATIVE_SOURCE_BOUND_FOR_CURRENT_DECLARATION",
                               "native_source_sha256": native_sha256,
                               "current_declaration_signed": False,
                               "historical_owner_authenticated": False})
    _unchanged(original, original_pin, fm, root)
    _unchanged(sealed, sealed_pin, sm, root)
    if native is not None and nm is not None and native_sha256 is not None:
        _unchanged(native, native_sha256, nm, root)
    return result


def _crypto():
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey, Ed25519PublicKey)
        from cryptography.hazmat.primitives import serialization
        import win32crypt
        import win32api
        import win32security
        import win32con
        import ntsecuritycon
    except ImportError as exc:
        raise Refused("Installed Windows security or Ed25519 libraries are unavailable") from exc
    return (Ed25519PrivateKey, Ed25519PublicKey, serialization, win32crypt,
            win32api, win32security, win32con, ntsecuritycon)


def _private_acl(path: Path, *, set_restriction: bool = True) -> None:
    """Replace inherited DACL, verify only current SID and SYSTEM own FULL access."""
    _, _, _, _, win32api, sec, wc, rights = _crypto()
    token = sec.OpenProcessToken(win32api.GetCurrentProcess(), wc.TOKEN_QUERY)
    user = sec.GetTokenInformation(token, sec.TokenUser)[0]
    system = sec.CreateWellKnownSid(sec.WinLocalSystemSid, None)
    acl = sec.ACL()
    for sid in (user, system):
        acl.AddAccessAllowedAceEx(sec.ACL_REVISION_DS, 0,
                                  rights.FILE_ALL_ACCESS, sid)
    if set_restriction:
        sec.SetNamedSecurityInfo(str(path), sec.SE_FILE_OBJECT,
                                 sec.DACL_SECURITY_INFORMATION |
                                 sec.PROTECTED_DACL_SECURITY_INFORMATION,
                                 None, None, acl, None)
    descriptor = sec.GetNamedSecurityInfo(
        str(path), sec.SE_FILE_OBJECT, sec.DACL_SECURITY_INFORMATION)
    observed = descriptor.GetSecurityDescriptorDacl()
    control, _ = descriptor.GetSecurityDescriptorControl()
    expected = {sec.ConvertSidToStringSid(user), sec.ConvertSidToStringSid(system)}
    if (observed is None or not control & sec.SE_DACL_PROTECTED or
            observed.GetAceCount() != 2):
        raise Refused("Output DACL is inherited, absent, or not exclusive")
    got = set()
    for index in range(observed.GetAceCount()):
        ace = observed.GetAce(index)
        if (ace[0][0] != sec.ACCESS_ALLOWED_ACE_TYPE or
                ace[1] != rights.FILE_ALL_ACCESS):
            raise Refused("Output DACL includes unsafe permissions")
        got.add(sec.ConvertSidToStringSid(ace[2]))
    if got != expected:
        raise Refused("Output DACL permits a principal outside owner and SYSTEM")


def _off_profile_new_directory(directory: Path, root: Path) -> None:
    if not directory.is_absolute() or directory.exists() or directory.is_symlink():
        raise Refused("Enrollment output must be a unique, absent absolute directory")
    parent = directory.parent
    if not parent.is_dir() or not parent.is_absolute():
        raise Refused("Enrollment output parent must exist")
    for part in (directory, parent):
        if part.exists():
            _no_reparse(part)
    # The full new directory must be physically outside user-profile/AppData
    # trees, source root and repository. A new folder inside the source root
    # would undermine independent evidence custody.
    paths = [root, Path(__file__).resolve().parent.parent]
    for name in ("USERPROFILE", "APPDATA", "LOCALAPPDATA"):
        if os.getenv(name):
            paths.append(Path(os.environ[name]))
    actual = directory.resolve(strict=False)
    for forbidden in paths:
        real = forbidden.resolve(strict=False)
        if actual == real or actual.is_relative_to(real):
            raise Refused("Enrollment output must be off-profile and outside the repository")
    node = parent
    while node != node.parent:
        _no_reparse(node)
        node = node.parent


def _exclusive_file(path: Path, content: bytes) -> None:
    # The *empty* file is locked down before even the DPAPI-wrapped secret is
    # written. Existence flags are exclusive; no file replacement is possible.
    handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_BINARY, 0o600)
    try:
        _private_acl(path)
        with os.fdopen(handle, "wb", closefd=False) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(handle)
    _private_acl(path)


def enroll(*, evidence: dict, declaration: str, owner_id: str,
           directory: Path, root: Path) -> dict:
    """Call only after verification and external final owner confirmation."""
    _require_windows()
    if (evidence.get("status") != "PASS_NATIVE_SOURCE_BOUND_FOR_CURRENT_DECLARATION"
            or owner_id != OWNER_ID or not isinstance(declaration, str) or
            not 20 <= len(declaration.strip()) <= 4000 or
            any(ord(c) < 32 and c not in "\n\t" for c in declaration)):
        raise Refused("Current owner declaration, matching identity, and native lineage required")
    _off_profile_new_directory(directory, root)
    EdPriv, _, serialization, win32crypt, *_ = _crypto()
    # New directory creation is exclusive. Failed/incomplete output stays
    # quarantined; never resume, rotate or overwrite an existing directory.
    directory.mkdir(mode=0o700)
    _private_acl(directory)
    timestamp = datetime.now(timezone.utc).isoformat()
    key = EdPriv.generate()              # ONLY here, after all preflight
    raw = key.private_bytes(serialization.Encoding.Raw,
                            serialization.PrivateFormat.Raw,
                            serialization.NoEncryption())
    try:
        wrapped = win32crypt.CryptProtectData(
            raw, "Pharma current first owner declaration only", None,
            None, None, 0)
    finally:
        del raw
    public = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw).hex()
    manifest = {
        "format": CERT_FORMAT, "owner_id": owner_id,
        "created_at_utc": timestamp, "present_tense_declaration": declaration.strip(),
        "public_key_ed25519_hex": public,
        "source_evidence": {
            k: evidence[k] for k in ("original_v29_sha256",
                                     "independently_sealed_v29_sha256",
                                     "native_source_sha256", "native_sqlx_version",
                                     "v29_physical_tables", "v29_physical_rows",
                                     "known_custody_difference")
        },
        "scope": "current user declaration only; no historical ownership authentication",
        "third_party_verified": False,
        "native_owner_authentication_granted": False,
        "commercial_release_promoted": False,
        "independent_historical_owner_proof": False,
    }
    manifest_data = _json_bytes(manifest)
    certificate = {"format": CERT_FORMAT, "manifest_sha256": _hash(manifest_data),
                   "signature_ed25519_hex": key.sign(manifest_data).hex()}
    certificate_data = _json_bytes(certificate)
    _exclusive_file(directory / FILE_SECRET, wrapped)
    _exclusive_file(directory / FILE_MANIFEST, manifest_data)
    _exclusive_file(directory / FILE_CERTIFICATE, certificate_data)
    complete = {"format": CERT_FORMAT, "manifest_sha256": _hash(manifest_data),
                "certificate_sha256": _hash(certificate_data)}
    _exclusive_file(directory / FILE_COMPLETE, _json_bytes(complete))
    _private_acl(directory)
    verification = verify_certificate(directory)
    return {"status": "CURRENT_DECLARATION_SIGNED_AND_DPAPI_SEALED",
            "public_manifest_sha256": verification["public_manifest_sha256"],
            "public_certificate_verified": True,
            "output_directory": str(directory),
            "private_key_exposed": False,
            "historical_owner_authenticated": False,
            "release_authorized": False}


def verify_certificate(directory: Path) -> dict:
    """Verify public SHA and Ed25519 signature without loading private key."""
    _require_windows()
    _, EdPublic, *_ = _crypto()
    if not directory.is_dir() or directory.is_symlink():
        raise Refused("Completed enrollment directory missing")
    _no_reparse(directory)
    _private_acl(directory, set_restriction=False)
    for name in (FILE_MANIFEST, FILE_CERTIFICATE, FILE_SECRET, FILE_COMPLETE):
        file = directory / name
        if not file.is_file() or file.is_symlink() or file.stat().st_nlink != 1:
            raise Refused("Complete enrollment artifacts are missing or aliased")
        _no_reparse(file)
        _private_acl(file, set_restriction=False)
    manifest_data = (directory / FILE_MANIFEST).read_bytes()
    certificate_data = (directory / FILE_CERTIFICATE).read_bytes()
    complete_data = (directory / FILE_COMPLETE).read_bytes()
    if max(map(len, (manifest_data, certificate_data, complete_data))) > 20000:
        raise Refused("Public declaration artifacts are oversized")
    manifest = json.loads(manifest_data)
    certificate = json.loads(certificate_data)
    complete = json.loads(complete_data)
    if (_json_bytes(manifest) != manifest_data or
            _json_bytes(certificate) != certificate_data or
            _json_bytes(complete) != complete_data or
            manifest.get("format") != CERT_FORMAT or
            certificate.get("format") != CERT_FORMAT or
            complete.get("format") != CERT_FORMAT or
            certificate.get("manifest_sha256") != _hash(manifest_data) or
            complete.get("manifest_sha256") != _hash(manifest_data) or
            complete.get("certificate_sha256") != _hash(certificate_data)):
        raise Refused("Signed public enrollment SHA binding is invalid")
    sources = manifest.get("source_evidence", {})
    if (sources.get("original_v29_sha256") != ORIGINAL_PIN or
            sources.get("independently_sealed_v29_sha256") != SEALED_PIN or
            sources.get("native_sqlx_version") not in (52, 67) or
            not PIN_PATTERN.fullmatch(str(sources.get("native_source_sha256", ""))) or
            manifest.get("owner_id") != OWNER_ID or
            manifest.get("independent_historical_owner_proof") is not False or
            manifest.get("commercial_release_promoted") is not False):
        raise Refused("Public certificate source/custody or scope is untrusted")
    try:
        EdPublic.from_public_bytes(bytes.fromhex(
            manifest["public_key_ed25519_hex"])).verify(
                bytes.fromhex(certificate["signature_ed25519_hex"]), manifest_data)
    except Exception as exc:
        raise Refused("Public Ed25519 certificate signature failed") from exc
    return {"status": "PUBLIC_CURRENT_DECLARATION_SIGNATURE_VERIFIED",
            "public_manifest_sha256": _hash(manifest_data),
            "self_signed_current_declaration_only": True,
            "independent_historical_owner_proof": False,
            "release_or_login_authorized": False}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", choices=("inspect", "enroll", "verify"),
                        default="inspect")
    parser.add_argument("--native-source", type=Path)
    parser.add_argument("--native-sha256")
    parser.add_argument("--owner-id")
    parser.add_argument("--declaration-file", type=Path)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--confirm")
    args = parser.parse_args(argv)
    try:
        _require_windows()
        if args.action == "verify":
            if not args.output_dir or any(
                    x is not None for x in (args.native_source, args.native_sha256,
                                            args.owner_id, args.declaration_file,
                                            args.confirm)):
                raise Refused("verify requires only --output-dir")
            result = verify_certificate(args.output_dir)
        else:
            root, original, sealed = source_paths()
            migrations = Path(__file__).resolve().parent.parent / "src-tauri" / "migrations"
            if bool(args.native_source) != bool(args.native_sha256):
                raise Refused("Native path and SHA pin are required together")
            if args.native_source is not None and (
                    not args.native_source.is_absolute() or
                    not args.native_source.resolve().is_relative_to(root.resolve())):
                raise Refused("Native source must be a detached disposable copy")
            if args.action == "inspect":
                if any(x is not None for x in (args.owner_id, args.declaration_file,
                                               args.output_dir, args.confirm)):
                    raise Refused("inspect cannot carry enrollment options")
                result = inspect_sources(root=root, original=original, sealed=sealed,
                                         migrations=migrations, native=args.native_source,
                                         native_sha256=args.native_sha256)
            else:
                if (args.confirm != CONFIRM_PHRASE or args.owner_id != OWNER_ID or
                        args.declaration_file is None or args.output_dir is None or
                        args.native_source is None or args.native_sha256 is None):
                    raise Refused("Explicit confirmation, current declaration, native source, and output are required")
                if not args.declaration_file.is_file() or args.declaration_file.stat().st_size > 4096:
                    raise Refused("Current declaration file is missing or too large")
                declaration = args.declaration_file.read_text(encoding="utf-8")
                evidence = inspect_sources(root=root, original=original, sealed=sealed,
                                           migrations=migrations, native=args.native_source,
                                           native_sha256=args.native_sha256)
                result = enroll(evidence=evidence, declaration=declaration,
                                owner_id=args.owner_id, directory=args.output_dir,
                                root=root)
        print(json.dumps(result, sort_keys=True, ensure_ascii=True))
        return 0
    except (Refused, OSError, sqlite3.Error, MemoryError, ValueError, TypeError,
            KeyError, UnicodeError):
        print(json.dumps({"status": "REFUSED",
                          "reason": "source lineage, Windows protection, or declaration precondition failed"},
                         sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
