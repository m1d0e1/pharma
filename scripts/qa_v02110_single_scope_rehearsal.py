"""DISPOSABLE-ONLY v0.2.110 one-pharmacy scope integration rehearsal.

Never opens installed/commercial AppData for writing. Only the EXACT retained,
SHA-pinned v67 diagnostic source is permitted. Creates a NEW, private SQLite
clone and records the *typed* original scope of each row in a QA-only ledger.
Then, on that private clone only, normalizes directly scoped legacy values to
one proposed tenant and verifies ALL existing tables/rows, byte-valued fields,
floating point values, foreign keys and original source SHA have not changed.

No real owner/reviewer signatures, enrollment, license activation or postable
financial receipts are claimed or generated. Never install the result.
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid

SOURCE_SUBFOLDER = "pharma-v02110-native-sqlx-diagnostic-6e1926dcde9641c184ecec124aa41143"
SOURCE_FILENAME = "native-v67-working-only.sqlite3"
SOURCE_PIN = "b50822deb18c351b9565961a026f3087a4375819cffb9dcf85723c0b9c4c57cb"
TENANT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
MAX_ROWS = 3_000_000


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def q(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def source_path() -> Path:
    if os.name != "nt":
        raise ValueError("Windows disposable QA storage required")
    parent = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
    original = parent / SOURCE_SUBFOLDER / SOURCE_FILENAME
    if any(piece.is_symlink() for piece in (parent, original.parent, original)):
        raise ValueError("Pinned native diagnostic path may not have symlink components")
    if not original.is_file() or digest(original) != SOURCE_PIN:
        raise ValueError("Pinned native v67 diagnostic source unavailable")
    if any(Path(str(original) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise ValueError("Native diagnostic source has live sidecars")
    return original


def scope_tables(db: sqlite3.Connection) -> list[str]:
    tables = [name for (name,) in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    return [table for table in tables if "pharmacy_id" in {
        row[1] for row in db.execute(f"PRAGMA table_info({q(table)})")
    }]


def scope_counts(db: sqlite3.Connection, table: str) -> dict[str, int]:
    null, legacy, foreign = db.execute(f"""
        SELECT
          COALESCE(SUM(CASE WHEN pharmacy_id IS NULL THEN 1 ELSE 0 END),0),
          COALESCE(SUM(CASE WHEN typeof(pharmacy_id)='text' AND
              (pharmacy_id='local_default' OR trim(pharmacy_id)='') THEN 1 ELSE 0 END),0),
          COALESCE(SUM(CASE WHEN pharmacy_id IS NOT NULL AND NOT
              (typeof(pharmacy_id)='text' AND
              (pharmacy_id='local_default' OR trim(pharmacy_id)='')) THEN 1 ELSE 0 END),0)
        FROM {q(table)}""").fetchone()
    return {"null": int(null), "legacy": int(legacy), "other": int(foreign)}


def verify_all_old_rows(source: sqlite3.Connection, stage: sqlite3.Connection,
                        allowed: set[str], tenant: str) -> dict:
    """Compare every typed SQLite cell; only allow archived scope changes."""
    source_tables = sorted(row[0] for row in source.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"))
    stage_tables = set(row[0] for row in stage.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"))
    if set(source_tables) | {"qa_original_legacy_pharmacy_scopes"} != stage_tables:
        raise ValueError("Unexpected stage table replacement or addition")
    verified_rows = 0
    changed_rows = 0
    for table in source_tables:
        src_cols = [r[1] for r in source.execute(f"PRAGMA table_xinfo({q(table)})") if r[6] == 0]
        clone_cols = [r[1] for r in stage.execute(f"PRAGMA table_xinfo({q(table)})") if r[6] == 0]
        if src_cols != clone_cols:
            raise ValueError("Staged table columns differ from original native history")
        if "pharmacy_id" in src_cols and table in allowed:
            index = src_cols.index("pharmacy_id")
        else:
            index = -1
        projection = ",".join(q(name) for name in src_cols)
        if table == "master_drugs_fts":
            # Ignore SQLite's ephemeral FTS control columns; persistent visible
            # FTS data, stable source rowid and ALL physical shadows stay tested.
            projection += ",rowid"
        cursor_a = source.execute(f"SELECT {projection} FROM {q(table)}")
        cursor_b = stage.execute(f"SELECT {projection} FROM {q(table)}")
        for before, after in itertools.zip_longest(cursor_a, cursor_b, fillvalue=None):
            if before is None or after is None:
                raise ValueError("Historical row disappeared or appeared")
            verified_rows += 1
            if verified_rows > MAX_ROWS:
                raise ValueError("Historical verification exceeded maximum rows")
            if before != after:
                if index < 0 or before[:index] != after[:index] or before[index+1:] != after[index+1:]:
                    raise ValueError("Non-scope legacy original row was altered")
                if before[index] is not None and not (
                    isinstance(before[index], str) and
                    (before[index] == "local_default" or not before[index].strip())):
                    raise ValueError("Foreign owner scope reassigned")
                if after[index] != tenant:
                    raise ValueError("Original row changed to unexpected tenant")
                changed_rows += 1
    return {"source_physical_rows_compared": verified_rows,
            "only_scope_field_changed_rows": changed_rows,
            "other_original_cells_changed": 0}


def rehearse(*, tenant: str, folder: Path) -> dict:
    if TENANT_RE.fullmatch(tenant) is None or tenant.lower() == "local_default":
        raise ValueError("Proposed tenant must be explicit and non-placeholder")
    pinned = source_path()
    root = pinned.parent.parent
    if (folder.parent.resolve(strict=True) != root.resolve(strict=True) or folder.exists()
        or not re.fullmatch(r"pharma-v02110-single-scope-simulation-[0-9a-f]{32}",folder.name)):
        raise ValueError("Disposable-only unique stage path required")
    folder.mkdir(mode=0o700)
    db_file = folder / "one-pharmacy-candidate-NOT-AUTHORIZED.sqlite3"
    try:
        with closing(sqlite3.connect(pinned.as_uri() + "?mode=ro&immutable=1", uri=True)) as before:
            before.execute("PRAGMA query_only=ON")
            if before.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise ValueError("Source integrity failure")
            with closing(sqlite3.connect(db_file)) as candidate:
                before.backup(candidate)
                candidate.execute("PRAGMA foreign_keys=ON")
                candidate.execute("PRAGMA recursive_triggers=ON")
                if candidate.execute("PRAGMA foreign_key_check").fetchone() is not None:
                    raise ValueError("Source foreign key anomaly")
                table_names = scope_tables(candidate)
                old_counts = {name: scope_counts(candidate, name) for name in table_names}
                if any(value["other"] for value in old_counts.values()):
                    raise ValueError("Existing explicitly different pharmacy scope found")
                to_change = sum(v["null"] + v["legacy"] for v in old_counts.values())
                if to_change == 0:
                    raise ValueError("No original single-pharmacy legacy scope to rehearse")
                with candidate:
                    candidate.execute("""CREATE TABLE qa_original_legacy_pharmacy_scopes (
                        source_table TEXT NOT NULL, source_rowid INTEGER NOT NULL,
                        original_pharmacy_storage TEXT NOT NULL,
                        original_pharmacy_literal BLOB, proposed_pharmacy_id TEXT NOT NULL,
                        source_sha256 TEXT NOT NULL,
                        PRIMARY KEY(source_table,source_rowid)
                    ) WITHOUT ROWID""")
                    for table in table_names:
                        if not old_counts[table]["null"] + old_counts[table]["legacy"]:
                            continue
                        tq = q(table)
                        # If a target table has no SQLite rowid, this operation
                        # rejects rather than guessing a primary key or record.
                        candidate.execute(f"""INSERT INTO qa_original_legacy_pharmacy_scopes
                            SELECT ?,rowid,typeof(pharmacy_id),pharmacy_id,?,?
                            FROM {tq} WHERE pharmacy_id IS NULL OR
                            (typeof(pharmacy_id)='text' AND
                             (pharmacy_id='local_default' OR TRIM(pharmacy_id)=''))""",
                            (table, tenant, SOURCE_PIN))
                        candidate.execute(f"""UPDATE {tq} SET pharmacy_id=?
                            WHERE pharmacy_id IS NULL OR
                            (typeof(pharmacy_id)='text' AND
                             (pharmacy_id='local_default' OR TRIM(pharmacy_id)=''))""",(tenant,))
                    count = candidate.execute("SELECT COUNT(*) FROM qa_original_legacy_pharmacy_scopes").fetchone()[0]
                    if count != to_change:
                        raise ValueError("Original legacy scope archive incomplete")
                if candidate.execute("PRAGMA integrity_check").fetchone() != ("ok",) or \
                   candidate.execute("PRAGMA foreign_key_check").fetchone() is not None:
                    raise ValueError("Rehearsal produced invalid SQLite database")
                for name in table_names:
                    after_scope = scope_counts(candidate, name)
                    if (after_scope["null"] or after_scope["legacy"] or
                        after_scope["other"] != sum(old_counts[name].values())):
                        raise ValueError("Not every original direct scope reconciled")
                verification = verify_all_old_rows(before, candidate, set(table_names), tenant)
                if verification["only_scope_field_changed_rows"] != to_change:
                    raise ValueError("Staged changed-row tally inconsistent")
                if candidate.execute("SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations").fetchone()[0] != 67:
                    raise ValueError("Staged native migration ledger changed")
                if digest(pinned) != SOURCE_PIN:
                    raise ValueError("Pinned original source changed during stage")
        report = {
            "status": "TEST_ONLY_ONE_PHARMACY_SCOPE_REHEARSAL_NO_AUTHORIZATION",
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "proposed_pharmacy_id": tenant,
            "immutable_native_v67_original_sha256": SOURCE_PIN,
            "stage_sqlite_sha256": digest(db_file),
            "tables_with_pharmacy_column": len(table_names),
            "source_tenant_literal_categories": old_counts,
            "archived_original_scope_rows": to_change,
            "original_fields_preserved_in_pinned_source": True,
            "scope_originals_present_in_qa_ledger": True,
            "all_original_rows_reconciled": verification,
            "independent_owner_reviewer_approval": False,
            "commercial_or_historical_finance_access_authorized": False,
            "never_use_this_disposable_db_as_live_customer_data": True,
        }
        with (folder / "ONE_PHARMACY_REHEARSAL_ONLY.json").open("x", encoding="utf8") as file:
            json.dump(report,file,indent=2,sort_keys=True)
            file.write("\n")
        return {"status": report["status"], "folder": str(folder),
                "staged_scope_rows": to_change,
                "source_physical_rows_checked":verification["source_physical_rows_compared"],
                "native_original_sha256_unchanged":True,"operational_authority":False}
    except BaseException:
        # Do NOT automatically delete a partial data-bearing QA stage. The
        # operator must review an interrupted clone in its unique folder.
        raise


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Only one proposed tenant name may be supplied")
        result = rehearse(
            tenant=sys.argv[1],
            folder=source_path().parent.parent /
                   ("pharma-v02110-single-scope-simulation-" + uuid.uuid4().hex),
        )
        print(json.dumps(result,sort_keys=True))
    except (OSError,ValueError,sqlite3.Error,MemoryError):
        print("One-tenant disposable rehearsal refused; no production record changed",file=sys.stderr)
        raise SystemExit(2)
