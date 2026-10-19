"""Independent postflight for a native SQLx 067→068 upgrade on current-history COPY.

The actual installed v0.2.109 and all custody snapshots are never opened as
SQLite disk databases. Both inputs are fixed SHA-pinned disposable copies
deserialized into private RAM, and EVERY original v67 row/typed field and
FTS physical row must survive. A successful SQLx schema upgrade alone does
not authenticate the original owner or normalize historical scopes.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import itertools
import json
import os
from pathlib import Path
import sqlite3
import sys

from scripts import qa_v02110_primary_pharmacy_migration as qa


ROOT = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
SOURCE = (ROOT / "pharma-v02110-current-v67-sql-rehearsal-7fe5928a6d9b4d45a7a86478946b0778"
          / "current-v02109-to-v67-SQL-ONLY-NOT-AUTHORIZED.sqlite3")
MIGRATED = (ROOT / "pharma-v02110-native-sqlx-068-current-data-34c78ae429ab4f0dacb4e777337d711b"
            / "NATIVE-SQLX-068-DISPOSABLE-NOT-AUTHORIZED.sqlite3")
SOURCE_SHA = "12c7ef65c8c89ac473b309221c462f71589ce1bcca4ae928b0aaf430999f9880"
MIGRATED_SHA = "94bdef17800a7f33e29c478c166beff92a0637f380b4bc632473dd652ec9c2b9"


def bytes_checked(path: Path, expected: str) -> bytes:
    if (not path.is_file() or path.is_symlink() or path.parent.is_symlink()
            or path.parent.parent.resolve(strict=True) != ROOT.resolve(strict=True)):
        raise ValueError("Only private pinned offline rehearsal files may be examined")
    if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise ValueError("Cannot ignore SQLite WAL/rollback sidecars")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("Current pharmacy disposable source checksum changed")
    return raw


def verify() -> dict:
    from_data = bytes_checked(SOURCE, SOURCE_SHA)
    migrated_data = bytes_checked(MIGRATED, MIGRATED_SHA)
    with closing(sqlite3.connect(":memory:")) as source, closing(sqlite3.connect(":memory:")) as target:
        source.deserialize(from_data)
        target.deserialize(migrated_data)
        source.execute("PRAGMA query_only=ON")
        target.execute("PRAGMA query_only=ON")
        for db in (source, target):
            if (db.execute("PRAGMA integrity_check").fetchone() != ("ok",)
                    or db.execute("PRAGMA foreign_key_check").fetchone() is not None):
                raise ValueError("Historical SQLite integrity or foreign-key failure")
        if source.execute("SELECT COUNT(*),MAX(version) FROM _sqlx_migrations").fetchone() != (67,67):
            raise ValueError("Source is not current-history native v67 rehearsal")
        if target.execute("SELECT COUNT(*),MAX(version) FROM _sqlx_migrations").fetchone() != (68,68):
            raise ValueError("Native SQLx 068 did not produce the complete registry")
        if (source.execute("SELECT seq FROM sqlite_sequence WHERE name='accounts'").fetchone()
                != target.execute("SELECT seq FROM sqlite_sequence WHERE name='accounts'").fetchone()):
            raise ValueError("Historical original account sequence advanced under 068")
        if target.execute("SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone() != (0,):
            raise ValueError("Unsigned historical upgrade must not fabricate owner authority")
        old_tables = qa.tables(source)
        if len(old_tables) != 99:
            raise ValueError("Unexpected original native v67 physical table coverage")
        typed_rows = 0
        fts_rows = 0
        for table in old_tables:
            if table == "_sqlx_migrations":
                continue  # Exactly one additive native migration is the only difference.
            if qa.columns(source, table) != qa.columns(target, table):
                raise ValueError("Original native schema columns mutated: " + table)
            for first, second in itertools.zip_longest(
                qa.row_stream(source, table), qa.row_stream(target, table), fillvalue=None
            ):
                if first is None or second is None or len(first) != len(second):
                    raise ValueError("Original native row changed: " + table)
                if any(not qa.same(a,b) for a,b in zip(first,second)):
                    raise ValueError("Original native typed facts changed: " + table)
                typed_rows += 1
                if "fts" in table:
                    fts_rows += 1
        if typed_rows <= 250_000:
            raise ValueError("Insufficient original physical history verified")
        # The newly added audit schema is intentionally empty until a genuine
        # independently authenticated source-bound owner import is approved.
        for name in (
            "native_primary_scope_audit_batches", "native_primary_scope_audit_originals",
            "native_primary_scope_audit_tables", "native_primary_scope_audit_relations",
            "native_primary_scope_audit_seals", "native_primary_scope_owner_attestations",
        ):
            if target.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone() != (0,):
                raise ValueError("Native SQLx 068 fabricated primary-pharmacy custody facts")
        if (hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SOURCE_SHA
                or hashlib.sha256(MIGRATED.read_bytes()).hexdigest() != MIGRATED_SHA):
            raise ValueError("Disposable source/output changed during read-only audit")
        return {
            "status": "PASS_CURRENT_REAL_V02109_NATIVE_SQLX_068_NO_LOSS_RESTART",
            "source_current_data_v67_sha256": SOURCE_SHA,
            "native_sqlx_068_copy_sha256": MIGRATED_SHA,
            "native_sqlx_068_registered": True,
            "native_sqlx_068_second_run_noop": True,
            "original_native_v67_tables_checked": len(old_tables),
            "original_rows_typed_verified_excluding_sqlx_ledger": typed_rows,
            "fts_shadow_and_virtual_rows_verified": fts_rows,
            "original_account_sequence_unchanged": True,
            "signed_historical_owner_grant_created": False,
            "permanent_business_tenant_requested": "primary_pharmacy",
            "original_historical_scope_auto_granted": False,
            "actual_windows_historical_user_gui_accepted": False,
            "customer_profile_mutations": 0,
            "ready_for_production": False,
        }


if __name__ == "__main__":
    try:
        print(json.dumps(verify(), sort_keys=True))
    except (RuntimeError, ValueError, OSError, sqlite3.Error) as error:
        print("REFUSED current v0.2.109 SQLx068 typed history postflight: "
              + str(error), file=sys.stderr)
        raise SystemExit(2)
