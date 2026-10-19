"""Read-only v0.2.109 sealed-vs-installed accounts AUTOINCREMENT custody audit.

Usage (PowerShell; replace the installed hash only after independent verification):
  python -B -m scripts.qa_v02110_accounts_sequence_drift_readonly \
    --installed-sha256 4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197

No disk-backed SQLite connection is ever made. Both files are read as bytes and
deserialized into private RAM SQLite connections. In particular, the installed
database is never opened by SQLite, so this tool cannot create/modify -shm,
-wal, a rollback journal, or cause a recovery checkpoint.

Safety: an active/nonempty WAL or rollback journal is *refused*, not silently
ignored. Run a separately authorized, committed WAL-consistent snapshot audit
when either is present. A live DB may change concurrently: file and sidecar
metadata/hashes are checked before and after; this is an observation, not an
atomic multi-file snapshot or a historical writer attribution.

Only aggregate structure/typed-row commitments and the accounts sequence
integer are printed; no patient, staff, finance, supplier or account row data.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys

from scripts.qa_historical_forward_sql_drift import (
    original_row_commitments, original_table_schema,
)


SEALED_PARENT = "pharma-v02110-prebuild-snapshot-cb743d7b7ab14ffd9583ee1a64cdd472"
SEALED_FILENAME = "current-v02109-sealed.sqlite3"
SEALED_SHA256 = "06fc00f32ec2603758cd3f0eb12c38024f22fce27c4e5f7875ab47aceb6c87fb"
INSTALLED_RELATIVE = Path("com.pharma.system") / "pharma_local.db"
PIN = re.compile(r"[0-9a-fA-F]{64}\Z")
MAX_FILE_BYTES = 700_000_000

# Exactly the 14 values attempted in one native compatibility SQL statement
# at src-tauri/src/schema.rs:2115-2129 (code column only, no customer data).
NATIVE_COMPAT_CODES = (
    "1.1.1", "2.1", "1.1.2", "3.1", "1.1.3", "4.1", "1.1.4",
    "2.2", "4.2", "3.9", "3.2", "3.3", "3.8", "4.4",
)


class Refused(ValueError):
    """Fail closed without writing or exposing historical records."""


def _path_guard(path: Path) -> None:
    if not path.is_file():
        raise Refused("Required custody database missing")
    for component in (path, path.parent, path.parent.parent):
        mode = component.lstat()
        if stat.S_ISLNK(mode.st_mode) or (
            getattr(mode, "st_file_attributes", 0)
            & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        ):
            raise Refused("Custody path contains filesystem indirection")


def _sidecars(path: Path, *, detached: bool) -> dict[str, tuple[int, int] | None]:
    """Observe sidecars through OS metadata only; never open SQLite on disk."""
    details = {}
    for suffix in ("-wal", "-shm", "-journal"):
        candidate = Path(str(path) + suffix)
        try:
            mode = candidate.lstat()
        except FileNotFoundError:
            details[suffix] = None
            continue
        if not stat.S_ISREG(mode.st_mode) or (
            getattr(mode, "st_file_attributes", 0)
            & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        ):
            raise Refused("Unexpected SQLite sidecar type or reparse point")
        if detached or (suffix in ("-wal", "-journal") and mode.st_size != 0):
            raise Refused("Uncommitted WAL/journal or detached sidecars: WAL-consistent snapshot required")
        details[suffix] = (mode.st_size, mode.st_mtime_ns)
    return details


def _capture(path: Path, *, detached: bool, expected_sha: str) -> tuple[bytes, dict]:
    _path_guard(path)
    before_sidecars = _sidecars(path, detached=detached)
    before = path.stat()
    if not 50_000 <= before.st_size <= MAX_FILE_BYTES:
        raise Refused("Unexpected SQLite source size")
    # OS file read only, no sqlite3.connect(path), backup(), WAL recovery, or SQL.
    data = path.read_bytes()
    if len(data) != before.st_size or not data.startswith(b"SQLite format 3\x00"):
        raise Refused("Incomplete SQLite read or unexpected file header")
    actual_sha = hashlib.sha256(data).hexdigest()
    if actual_sha != expected_sha:
        raise Refused("Independent SQLite SHA-256 pin mismatch")
    after = path.stat()
    if ((before.st_size, before.st_mtime_ns, before.st_ino) !=
        (after.st_size, after.st_mtime_ns, after.st_ino) or
        before_sidecars != _sidecars(path, detached=detached)):
        raise Refused("Source or sidecars changed during file read")
    return data, {"sha256": actual_sha, "size": after.st_size,
                  "mtime_ns": after.st_mtime_ns, "sidecars": before_sidecars}


def _unchanged(path: Path, *, detached: bool, original: dict) -> bool:
    before = _sidecars(path, detached=detached)
    if before != original["sidecars"]:
        return False
    info = path.stat()
    if info.st_size != original["size"] or info.st_mtime_ns != original["mtime_ns"]:
        return False
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return (digest.hexdigest() == original["sha256"] and
            _sidecars(path, detached=detached) == original["sidecars"])


def _ram(data: bytes) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    try:
        db.deserialize(data)
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA query_only").fetchone() != (1,):
            raise Refused("RAM SQLite read-only guard failed")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise Refused("SQLite integrity check failed")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise Refused("SQLite foreign-key check failed")
    except Exception:
        db.close()
        raise
    return db


def _sequence(db: sqlite3.Connection) -> int:
    rows = db.execute("SELECT seq FROM sqlite_sequence WHERE name='accounts'").fetchall()
    if len(rows) != 1 or type(rows[0][0]) is not int:
        raise Refused("Expected exactly one integer accounts sequence")
    return rows[0][0]


def _migrations(db: sqlite3.Connection) -> bool:
    return [row[0] for row in db.execute(
        "SELECT version FROM _sqlx_migrations WHERE success=1 ORDER BY version"
    )] == list(range(1, 30))


def _ignore_reproduction() -> dict:
    """A deterministic, fully RAM-based 14-duplicate statement reproduction."""
    with closing(sqlite3.connect(":memory:")) as db:
        db.execute("CREATE TABLE accounts(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE)")
        db.execute("INSERT INTO accounts(id,code) VALUES(4815,?)", (NATIVE_COMPAT_CODES[0],))
        db.executemany("INSERT INTO accounts(id,code) VALUES(?,?)",
                       ((number, code) for number, code in enumerate(NATIVE_COMPAT_CODES[1:], 1)))
        before_rows = db.execute("SELECT id,code FROM accounts ORDER BY id").fetchall()
        before_seq = _sequence(db)
        placeholders = ",".join("(?)" for _ in NATIVE_COMPAT_CODES)
        db.execute(f"INSERT OR IGNORE INTO accounts(code) VALUES {placeholders}",
                   NATIVE_COMPAT_CODES)
        after_rows = db.execute("SELECT id,code FROM accounts ORDER BY id").fetchall()
        after_seq = _sequence(db)
        result = {"duplicate_attempts": len(NATIVE_COMPAT_CODES),
                  "typed_account_rows_unchanged": before_rows == after_rows,
                  "before_seq": before_seq, "after_seq": after_seq,
                  "advance": after_seq - before_seq}
        if (before_rows != after_rows or before_seq != 4815 or after_seq != 4829):
            raise Refused("Synthetic AUTOINCREMENT reproduction failed")
        return result


def compare(source: sqlite3.Connection, installed: sqlite3.Connection) -> dict:
    if not _migrations(source) or not _migrations(installed):
        raise Refused("Sealed/installed SQLx ledger is not the complete v29 chain")
    schema = original_table_schema(source)
    other_schema = original_table_schema(installed)
    if schema != other_schema:
        raise Refused("Original table or column layout differs")
    baseline = original_row_commitments(source, schema)
    current = original_row_commitments(installed, schema)
    old_count = sum(c for c, _ in baseline.values())
    if len(schema) != 67 or old_count != 289_778:
        raise Refused("Original source 67-table/289778-row custody census differs")
    changed = sorted(name for name in schema if baseline[name] != current[name])
    old_seq, new_seq = _sequence(source), _sequence(installed)
    # A single changed sqlite_sequence table digest cannot by itself establish
    # which of its individual sequence rows changed. Compare every other entry.
    other_sequences_sql = (
        "SELECT name,seq FROM sqlite_sequence WHERE name!='accounts' ORDER BY name,seq"
    )
    old_others = source.execute(other_sequences_sql).fetchall()
    new_others = installed.execute(other_sequences_sql).fetchall()
    other_sequences_unchanged = old_others == new_others
    canonical_sql = ",".join("?" for _ in NATIVE_COMPAT_CODES)
    present = installed.execute(
        f"SELECT COUNT(*) FROM accounts WHERE code IN ({canonical_sql})",
        NATIVE_COMPAT_CODES,
    ).fetchone()[0]
    only_expected = (changed == ["sqlite_sequence"] and old_seq == 4815 and
                     new_seq == 4829 and other_sequences_unchanged and
                     present == len(NATIVE_COMPAT_CODES))
    return {
        "status": "ONLY_ACCOUNTS_SEQUENCE_DRIFT" if only_expected else
                  ("EXACT_TYPED_ROW_PARITY" if not changed else "UNEXPECTED_TYPED_ROW_DRIFT"),
        "original_table_count": len(schema),
        "sealed_original_typed_rows": old_count,
        "installed_original_typed_rows": sum(c for c, _ in current.values()),
        "changed_original_table_names": changed,
        "non_sequence_tables_unchanged": all(name == "sqlite_sequence" for name in changed),
        "sealed_accounts_sequence": old_seq,
        "installed_accounts_sequence": new_seq,
        "accounts_sequence_advance": new_seq - old_seq,
        "other_sqlite_sequence_entries_unchanged": other_sequences_unchanged,
        "other_sqlite_sequence_entries": len(old_others),
        "original_accounts_rows_unchanged": baseline["accounts"] == current["accounts"],
        "canonical_native_compatibility_codes_present": present,
        "canonical_native_compatibility_codes_expected": len(NATIVE_COMPAT_CODES),
        "source_and_installed_both_sqlx_v29": True,
        "hypothesis_code_path": "src-tauri/src/schema.rs:2115-2129",
        "hypothesis_writer_or_execution_proven": False,
        "source_owner_or_reviewer_authorized": False,
        "production_release_authorized": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installed-sha256", required=False)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    try:
        reproduction = _ignore_reproduction()
        if args.self_test:
            if args.installed_sha256 is not None:
                raise Refused("Self-test does not read or accept installed custody pins")
            print(json.dumps({"status": "PASS_MEMORY_ONLY", "reproduction": reproduction},
                             sort_keys=True))
            return 0
        if not args.installed_sha256 or not PIN.fullmatch(args.installed_sha256):
            raise Refused("Independent installed full SHA-256 pin is mandatory")
        source = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies" / SEALED_PARENT / SEALED_FILENAME
        installed = Path(os.environ["APPDATA"]) / INSTALLED_RELATIVE
        if os.path.samefile(source, installed):
            raise Refused("Sealed and installed sources alias the same file")
        sealed_bytes, sealed_meta = _capture(source, detached=True,
                                             expected_sha=SEALED_SHA256)
        live_bytes, live_meta = _capture(installed, detached=False,
                                         expected_sha=args.installed_sha256.lower())
        with closing(_ram(sealed_bytes)) as baseline, closing(_ram(live_bytes)) as live:
            report = compare(baseline, live)
        if not _unchanged(source, detached=True, original=sealed_meta) or not _unchanged(
            installed, detached=False, original=live_meta
        ):
            raise Refused("Custody file or sidecars changed during RAM verification")
        report.update({
            "sealed_sha256": SEALED_SHA256,
            "installed_sha256": live_meta["sha256"],
            "installed_mtime_ns": live_meta["mtime_ns"],
            "installed_wal": "absent_or_empty_checked",
            "sources_verified_unchanged_after_read": True,
            "source_file_sqlite_connections": 0,
            "checkpoints_or_source_writes": 0,
            "ignored_duplicate_insert_memory_reproduction": reproduction,
            "cause_and_timestamp_established": False,
        })
        print(json.dumps(report, sort_keys=True))
        return 0 if report["status"] == "ONLY_ACCOUNTS_SEQUENCE_DRIFT" else 2
    except (Refused, OSError, sqlite3.Error, KeyError, AssertionError) as exc:
        print(json.dumps({"status": "REFUSED", "reason": str(exc),
                          "source_database_writes": 0}, sort_keys=True), file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
