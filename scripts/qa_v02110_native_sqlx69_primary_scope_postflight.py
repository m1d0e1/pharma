"""Independent RAM-only typed postflight for native SQLx 068-to-069 twice.

The SQLx migration is performed exclusively by the opt-in Rust test against
a NEW disposable OS-byte clone. This script never connects to any disk SQLite
database: both independently SHA-pinned files are read as bytes and then
deserialized into private RAM. No unsigned scope evidence grants an owner.

Usage:
  python -B -m scripts.qa_v02110_native_sqlx69_primary_scope_postflight \
      --report <new-disposable-folder>/native-sqlx69-rust-qa.json
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import itertools
import json
from pathlib import Path
import sqlite3
import sys

from scripts import qa_v02110_primary_pharmacy_migration as qa


SOURCE_PARENT = (
    "pharma-v02110-current-native-sqlx68-primary-scope-"
    "844cda322c1843b7809c9d9f20c259df"
)
SOURCE_NAME = "NATIVE-SQLX68-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3"
SOURCE_PIN = "816f49d70f0da6edb04cac8bdc5ee1af7b9ed307fd4ae0459b7e1ef7061481bb"
OUTPUT_NAME = "NATIVE-SQLX69-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3"
OUTPUT_PREFIX = "pharma-v02110-native-sqlx69-primary-scope-"
REPORT_NAME = "native-sqlx69-rust-qa.json"
MIGRATION = (Path(__file__).resolve().parents[1] / "src-tauri" / "migrations"
             / "069_supplier_return_aware_payment_guard.sql")
TRIGGER_NAME = "native_supplier_payment_insert_guard"
RETURN_GUARD_TEXT = "Supplier purchase return lacks immutable tenant-bound credit provenance"


def _reject(message: str) -> None:
    raise qa.Refused(message)


def audit(report_path: Path) -> dict:
    root = qa.disposable_root()
    source = root / SOURCE_PARENT / SOURCE_NAME
    if (report_path.name != REPORT_NAME
        or not report_path.parent.name.startswith(OUTPUT_PREFIX)
        or report_path.parent.parent != root):
        _reject("Only a new native SQLx69 disposable QA report can select output")
    # Reparse-point, path-escape, byte pin, WAL, hardlink and mutation guards.
    qa._safe_component(report_path)
    qa._safe_component(report_path.parent)
    qa._safe_component(root)
    raw_report = report_path.read_bytes()
    report = json.loads(raw_report)
    target = report_path.parent / OUTPUT_NAME
    if (report.get("source_sha256") != SOURCE_PIN
        or report.get("output_path") != str(target)
        or report.get("status") != "NATIVE_SQLX69_TWICE_AWAIT_INDEPENDENT_POSTFLIGHT"
        or report.get("second_native_migration_run") != "noop"):
        _reject("Native Rust QA report is mismatched or incomplete")
    output_pin = report.get("output_sha256")
    if (not isinstance(output_pin, str) or not qa.SHA.fullmatch(output_pin)
        or output_pin == SOURCE_PIN):
        _reject("An independent pinned native SQLx69 target is required")
    source_raw = qa.checked_file(source, SOURCE_PIN)
    target_raw = qa.checked_file(target, output_pin)
    migration_bytes = MIGRATION.read_bytes()
    expected_sql = migration_bytes.decode("utf-8")
    expected_trigger = expected_sql[expected_sql.index("CREATE TRIGGER "):].strip().rstrip(";")

    with closing(qa.memory_source(source_raw)) as before, \
         closing(qa.memory_source(target_raw)) as after:
        old_ledger = list(before.execute(
            "SELECT version,description,success,checksum,execution_time "
            "FROM _sqlx_migrations ORDER BY version"))
        new_ledger = list(after.execute(
            "SELECT version,description,success,checksum,execution_time "
            "FROM _sqlx_migrations ORDER BY version"))
        if ([row[0] for row in old_ledger] != list(range(1, 69))
            or [row[0] for row in new_ledger] != list(range(1, 70))
            or any(row[2] != 1 for row in new_ledger)):
            _reject("Native registered 068→069 SQLx ledger is incomplete")
        for old, new in zip(old_ledger, new_ledger):
            if not all(qa.same(x, y) for x, y in zip(old, new)):
                _reject("Original SQLx ledger row changed during 069")
        expected_ledger = (69, "supplier_return_aware_payment_guard", 1,
                           hashlib.sha384(migration_bytes).digest())
        if new_ledger[-1][:4] != expected_ledger:
            _reject("Registered 069 description/checksum differs from frozen SQL")

        old_schema = {row[1]: row for row in qa.schema(before)}
        new_schema = {row[1]: row for row in qa.schema(after)}
        if old_schema.keys() != new_schema.keys():
            _reject("069 created or deleted unexpected schema objects")
        changed_objects = {key for key in old_schema
                           if old_schema[key] != new_schema[key]}
        if changed_objects != {TRIGGER_NAME}:
            _reject("069 changed schema objects other than supplier payment trigger")
        old_trigger = old_schema[TRIGGER_NAME]
        new_trigger = new_schema[TRIGGER_NAME]
        if (old_trigger[:3] != new_trigger[:3]
            or new_trigger[0] != "trigger"
            or new_trigger[2] != "native_supplier_payment_receipts"
            or new_trigger[3].strip().rstrip(";") != expected_trigger
            or RETURN_GUARD_TEXT not in new_trigger[3]
            or RETURN_GUARD_TEXT in old_trigger[3]):
            _reject("Replacement supplier return-aware 069 trigger is not exact")

        original_tables = set(qa.tables(before))
        if original_tables != set(qa.tables(after)):
            _reject("069 added or removed original physical SQLite tables")
        stored_original_names = {
            row[0] for row in before.execute(
                "SELECT source_table FROM native_primary_scope_audit_tables")
        }
        if (len(stored_original_names) != 99
            or not stored_original_names.issubset(original_tables)):
            _reject("Original 99-table native v67 witness inventory changed")
        batch = before.execute(
            "SELECT pharmacy_id,original_physical_table_count,"
            "original_physical_row_count,expected_original_scope_count,"
            "expected_relation_witness_count FROM native_primary_scope_audit_batches"
        ).fetchall()
        if batch != [("primary_pharmacy", 99, 289816, 7567, 147)]:
            _reject("Pinned v68 current-history original audit is incomplete")
        if (before.execute(
            "SELECT COUNT(*) FROM native_primary_scope_audit_originals").fetchone() != (7567,)
            or before.execute(
                "SELECT COUNT(*) FROM native_primary_scope_audit_relations").fetchone() != (147,)
            or before.execute(
                "SELECT SUM(original_physical_rows) "
                "FROM native_primary_scope_audit_tables").fetchone() != (289816,)):
            _reject("Original exact typed scopes, graph or physical row witnesses missing")

        physical_count = fts_count = financial_cells = archive_rows = 0
        all_rows_typed_compared = 0
        for name in sorted(original_tables):
            before_cols = qa.columns(before, name)
            if before_cols != qa.columns(after, name):
                _reject(f"Original SQLite physical columns changed: {name}")
            # Native SQLx alone adds exactly one ledger row; every other cell,
            # rowid, FTS/shadow datum, seal and unsigned evidence stays typed.
            expected_addition = name == "_sqlx_migrations"
            first = qa.row_stream(before, name)
            second = qa.row_stream(after, name)
            rows_seen = 0
            for a, b in itertools.zip_longest(first, second, fillvalue=None):
                if a is None or b is None or len(a) != len(b):
                    if (expected_addition and a is None and b is not None
                        and b[0] == 69 and rows_seen == 68):
                        continue
                    _reject(f"Original physical SQLite row was inserted/deleted: {name}")
                if any(not qa.same(x, y) for x, y in zip(a, b)):
                    _reject(f"Original rowid or storage-class cell changed: {name}")
                rows_seen += 1
                all_rows_typed_compared += 1
                if name in stored_original_names:
                    # Exactly one v68 SQLx ledger row follows original v67.
                    if not expected_addition or rows_seen <= 67:
                        physical_count += 1
                        fts_count += int("fts" in name)
                    if any(term in name for term in (
                        "sale", "purchase", "cash", "journal", "account",
                        "stock", "inventory", "return", "payment", "balance", "finance"
                    )):
                        financial_cells += len(a) - int("pharmacy_id" in before_cols)
                if name == "native_primary_scope_audit_originals":
                    archive_rows += 1
            if expected_addition and rows_seen != 68:
                _reject("069 changed the number of original v68 ledger rows")

        if (physical_count, fts_count, financial_cells, archive_rows) != (
            289816, 49658, 165579, 7567
        ):
            _reject("Original historical physical/FTS/finance/typed-scope totals changed: "
                    + str((physical_count, fts_count, financial_cells, archive_rows)))
        original_seq = before.execute(
            "SELECT seq FROM sqlite_sequence WHERE name='accounts'").fetchone()
        new_seq = after.execute(
            "SELECT seq FROM sqlite_sequence WHERE name='accounts'").fetchone()
        if original_seq != (4829,) or new_seq != original_seq:
            _reject("Original SQLite accounts sequence advanced from 4829")
        if (before.execute(
            "SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone() != (0,)
            or after.execute(
                "SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone() != (0,)):
            _reject("Unsigned original-history review must not create owner trust")

    if (hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_PIN
        or hashlib.sha256(target.read_bytes()).hexdigest() != output_pin
        or report_path.read_bytes() != raw_report):
        _reject("Detached source, output or native report changed during read-only audit")
    return {
        "status": "PASS_NATIVE_SQLX69_TWICE_CURRENT_PRIMARY_TYPED_PARITY",
        "original_sqlx68_source_sha256": SOURCE_PIN,
        "native_sqlx69_output_sha256": output_pin,
        "sqlx69_migration_sql_sha256": hashlib.sha256(migration_bytes).hexdigest(),
        "sqlx69_migration_checksum_sha384": hashlib.sha384(migration_bytes).hexdigest(),
        "all_original_sqlx68_rows_type_exact": all_rows_typed_compared,
        "original_v67_physical_rows_verified": physical_count,
        "original_fts_and_shadow_rows_verified": fts_count,
        "original_finance_stock_account_cells_verified": financial_cells,
        "original_exact_typed_scope_literals_preserved": archive_rows,
        "original_direct_and_indirect_link_witnesses": 147,
        "original_accounts_sequence": 4829,
        "original_sqlx_ledger_rows_unchanged": 68,
        "new_registered_sqlx_ledger_version": 69,
        "native_second_sqlx_run_noop": True,
        "only_replaced_schema_object": TRIGGER_NAME,
        "original_owner_attestations_created": 0,
        "sqlite_integrity_and_foreign_keys": True,
        "disk_sqlite_source_connections": 0,
        "customer_profile_writes": 0,
        "historical_owner_attestation_authorized": False,
        "ready_for_production": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(audit(args.report), sort_keys=True))
        return 0
    except (qa.Refused, ValueError, OSError, sqlite3.Error, KeyError,
            UnicodeError, TypeError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "REFUSED_NATIVE_SQLX69_POSTFLIGHT",
                          "reason": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
