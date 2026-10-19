"""Strict, privacy-safe, READ-ONLY 064->065 Windows QA upgrade difference audit.

Compares the immutable native pre-migration WAL-aware sealed backup against a
consistent read snapshot of the *same* disposable QA profile. Unapproved
changes, lost source identities, invented evidence, a missing source receipt,
or changed balances are FAIL, never counted as a successful migration.

No caller-provided database paths; no live/production/historical writes.
Run: python -B -m scripts.qa_upgrade_diff_065
"""
from __future__ import annotations

from collections import Counter
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import struct
import sys
import unittest
import uuid

from scripts.qa_lifecycle_receipt_postflight_064 import inspect_profile

QA_ID = "com.pharma.disposable.lifecycle.qa20261016"
EXPECTED_REPO_SHA = "8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3"
EXPECTED_ARCHIVE_SHA = "49e04765052bb6e797f959562a0270e53af369a87cadcf0e8430c5bab234fdb1"
LEGACY_PREFIX = "native_legacy_upgrade_"
NEW_TABLES = {
    "native_legacy_upgrade_manifests",
    "native_legacy_upgrade_source_mappings",
    "native_legacy_upgrade_manifest_seals",
}
NEW_VIEW = "native_legacy_upgrade_authorized_sources"
EXPECTED_NEW_TRIGGERS = 42
DOMAINS = (
    "users", "inventory", "sales_invoices", "sales_items", "purchase_invoices",
    "purchase_invoice_items", "returns", "return_items", "purchase_returns",
    "daily_journals", "journal_entries", "cash_movements", "patients", "suppliers",
    "shifts", "native_sale_cogs_provenance", "native_sale_return_cogs_provenance",
    "native_supplier_payment_receipts", "native_patient_wallet_topup_receipts",
)


class Refused(ValueError):
    pass


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise Refused(reason)


def digest_file(path: Path) -> str:
    with path.open("rb") as data:
        return hashlib.file_digest(data, "sha256").hexdigest()


def quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def record_hash(values: tuple) -> bytes:
    digest = hashlib.sha256()
    for value in values:
        if value is None:
            encoded = b"n"
        elif isinstance(value, bytes):
            encoded = b"b" + value
        elif isinstance(value, str):
            encoded = b"s" + value.encode("utf8")
        elif type(value) is int:
            encoded = b"i" + str(value).encode("ascii")
        elif type(value) is float:
            encoded = b"f" + struct.pack("!d", value)
        else:
            raise Refused("unsupported_source_sqlite_type")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.digest()


def hashed_rows(db: sqlite3.Connection, table: str) -> Counter[bytes]:
    require(re.fullmatch(r"[a-zA-Z_][a-zA-Z_0-9]*", table) is not None,
            "unsafe_internal_table_name")
    return Counter(record_hash(tuple(row)) for row in db.execute(
        f"SELECT * FROM {quote(table)}"
    ))


def tables(db: sqlite3.Connection) -> set[str]:
    return {name for (name,) in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    )}


def objects(db: sqlite3.Connection) -> dict[tuple[str, str], tuple[str, str]]:
    return {
        (kind, name): (tbl, ddl)
        for kind, name, tbl, ddl in db.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master "
            "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
        )
    }


def integrity(db: sqlite3.Connection) -> None:
    db.execute("PRAGMA query_only=ON")
    require(db.execute("PRAGMA integrity_check").fetchone() == ("ok",),
            "integrity_check_failed")
    require(db.execute("PRAGMA foreign_key_check").fetchone() is None,
            "foreign_key_check_failed")


def compare(old: sqlite3.Connection, new: sqlite3.Connection) -> dict:
    """Full table-content multiset parity, identity and schema authorization."""
    integrity(old)
    integrity(new)
    before, after = tables(old), tables(new)
    require(before <= after, "original_table_missing")
    require(after - before == NEW_TABLES, "unexpected_new_or_missing_table")
    old_obj, new_obj = objects(old), objects(new)
    require(all(new_obj.get(key) == value for key, value in old_obj.items()),
            "source_schema_object_rewritten_or_missing")
    extra_obj = set(new_obj) - set(old_obj)
    require({name for kind, name in extra_obj if kind == "table"} == NEW_TABLES,
            "unexpected_new_table_objects")
    require({name for kind, name in extra_obj if kind == "view"} == {NEW_VIEW},
            "unexpected_new_view_objects")
    triggers = {name for kind, name in extra_obj if kind == "trigger"}
    require(len(triggers) == EXPECTED_NEW_TRIGGERS and
            all(name.startswith(LEGACY_PREFIX) for name in triggers),
            "unexpected_schema_triggers")
    require({name for kind, name in extra_obj if kind == "index"} ==
            {"idx_native_legacy_upgrade_mapping_manifest"},
            "unexpected_new_legacy_indexes")
    require(all(kind in ("table", "view", "trigger", "index") for kind, _ in extra_obj),
            "unknown_schema_object")
    for table in NEW_TABLES:
        require(not hashed_rows(new, table), "unapproved_historical_mapping_inserted")

    preserved = 0
    changed = []
    counts: dict[str, dict[str, int]] = {}
    for table in sorted(before - {"_sqlx_migrations", "activity_log"}):
        prior, current = hashed_rows(old, table), hashed_rows(new, table)
        original_count, current_count = sum(prior.values()), sum(current.values())
        if prior != current:
            changed.append(table)
        else:
            preserved += 1
        if table in DOMAINS:
            counts[table] = {"before": original_count, "after": current_count}
    require(not changed, "business_table_content_discrepancy")

    # An installed migration must be exactly 065, never rewrite 001..064.
    before_migrations = hashed_rows(old, "_sqlx_migrations")
    after_migrations = hashed_rows(new, "_sqlx_migrations")
    require(not (before_migrations - after_migrations), "prior_migration_row_changed")
    require(sum((after_migrations - before_migrations).values()) == 1,
            "unexpected_migration_history_delta")
    newest = new.execute(
        "SELECT version, description, success FROM _sqlx_migrations WHERE version=65"
    ).fetchall()
    require(newest == [(65, "legacy_upgrade_provenance", 1)],
            "new_migration_identity_incorrect")
    require(old.execute("SELECT count(*) FROM _sqlx_migrations").fetchone() == (64,) and
            new.execute("SELECT count(*) FROM _sqlx_migrations").fetchone() == (65,),
            "migration_set_incorrect")

    # Startup/login may append an audit event, but absolutely no previous
    # activity row may disappear or change. No finance write is excused.
    original_log, latest_log = hashed_rows(old, "activity_log"), hashed_rows(new, "activity_log")
    require(not (original_log - latest_log), "original_activity_log_mutated")
    appended = latest_log - original_log
    # Use the actual immutable numeric identity boundary, not a mutable
    # timestamp or free-text audit note.
    last_pre = old.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    additions = new.execute(
        "SELECT action,CAST(user_id AS TEXT),pharmacy_id FROM activity_log "
        "WHERE id>? ORDER BY id", (last_pre,)
    ).fetchall()
    require(len(additions) == sum(appended.values()) and len(additions) <= 128 and
            all(row == ("LOGIN", "qa_lifecycle_owner_20261016", "qa_lifecycle_20261016")
                for row in additions),
            "unexpected_activity_log_append")

    # Old row IDs, source invoices, lots, original financial receipts, account
    # balances and transaction source references are byte-for-byte identical.
    return {
        "accepted": True,
        "classification": "VERIFIED_QA_COPY_UPGRADE_ONLY",
        "migration_from": 64,
        "migration_to": 65,
        "original_table_count": len(before),
        "current_table_count": len(after),
        "identical_existing_tables": preserved,
        "changed_original_business_tables": changed,
        "new_legacy_mapping_tables": len(NEW_TABLES),
        "authorized_legacy_mapping_rows": 0,
        "new_legacy_view_count": 1,
        "new_legacy_trigger_count": EXPECTED_NEW_TRIGGERS,
        "new_migration_rows": 1,
        "new_login_audit_rows": len(additions),
        "original_record_content_missing": False,
        "original_record_identities_changed": False,
        "existing_stock_supplier_patient_accounting_changed": False,
        "domain_row_counts": counts,
        "foreign_keys_and_integrity_valid": True,
        "historical_null_or_local_default_adopted": False,
        "production_upgrade_certified": False,
    }


def checked_profile() -> tuple[Path, Path, Path]:
    require(os.name == "nt", "windows_only_test")
    appdata = Path(os.environ.get("APPDATA", ""))
    require(appdata.is_absolute() and appdata.is_dir() and not appdata.is_symlink(),
            "qa_appdata_unavailable")
    root = appdata / QA_ID
    live = root / "pharma_local.db"
    backup_dir = root / "backups"
    require(root.is_dir() and backup_dir.is_dir() and live.is_file(),
            "strict_disposable_qa_profile_missing")
    require(all(not path.is_symlink() for path in (root, backup_dir, live)),
            "linked_profile_denied")
    candidates = list(backup_dir.iterdir())
    require(len(candidates) == 1, "ambiguous_qa_premigration_backup")
    folder = candidates[0]
    require(folder.is_dir() and not folder.is_symlink(), "invalid_qa_backup_folder")
    require(str(uuid.UUID(folder.name)) == folder.name, "invalid_qa_backup_id")
    source = folder / "pharma_local.db"
    manifest_path = folder / "backup_manifest.json"
    require(source.is_file() and manifest_path.is_file() and
            not source.is_symlink() and not manifest_path.is_symlink() and
            source.stat().st_nlink == 1 and live.stat().st_nlink == 1,
            "unsafe_qa_backup_members")
    require(source.stat().st_size > 0 and source.stat().st_size < 1024**3 and
            manifest_path.stat().st_size < 8192, "invalid_qa_backup_sizes")
    require(not any((folder / ("pharma_local.db" + suffix)).exists()
                    for suffix in ("-wal", "-shm", "-journal")),
            "backup_has_live_sqlite_sidecar")
    manifest = json.loads(manifest_path.read_text("utf8"))
    require(manifest.get("format") == "pharma-backup-snapshot-v1" and
            manifest.get("backup_id") == folder.name and
            manifest.get("database_file") == "pharma_local.db" and
            manifest.get("size_bytes") == source.stat().st_size and
            manifest.get("source_name") == "pharma_local.db" and
            manifest.get("created_by_owner") is None and
            manifest.get("sha256") == digest_file(source),
            "backup_manifest_integrity_failed")
    # Win32 Rust Path::canonicalize() yields extended path notation (\\?\).
    native_path = "\\\\?\\" + str(live.resolve())
    require(manifest.get("source_path_sha256") == hashlib.sha256(
        native_path.encode("utf8")
    ).hexdigest(), "backup_source_path_lineage_mismatch")
    repo = Path(__file__).resolve().parents[1] / "src-tauri" / "pharma_local.db"
    require(digest_file(repo) == EXPECTED_REPO_SHA, "protected_repository_db_changed")
    return live, source, repo


def audit_profile() -> dict:
    live, source, repo = checked_profile()
    original_sha = digest_file(source)
    live_sha = digest_file(live)
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro&immutable=1", uri=True)) as old:
        with closing(sqlite3.connect(live.as_uri() + "?mode=ro", uri=True)) as live_ro:
            # Consistent live WAL-aware read snapshot; destination RAM only.
            with closing(sqlite3.connect(":memory:")) as current:
                live_ro.backup(current)
                report = compare(old, current)
    require(digest_file(source) == original_sha and
            digest_file(repo) == EXPECTED_REPO_SHA and
            digest_file(live) == live_sha, "sqlite_source_changed_during_diff")
    receipt_report = inspect_profile(post_065=True)
    require(receipt_report["migration_count"] == 65 and
            receipt_report["all_owned_journals_balanced"] and
            receipt_report["supplier_payable_match"] and
            receipt_report["owned_wallet_and_credit_limit_match"],
            "source_receipt_postflight_failed")
    report["strict_post_065_receipt_reconciliation"] = "PASS"
    report["original_repo_db_unchanged"] = True
    report["original_native_backup_unchanged"] = True
    report["replay_or_financial_writer_executed"] = False
    return report


class SyntheticDiffTests(unittest.TestCase):
    @staticmethod
    def fixture() -> sqlite3.Connection:
        db = sqlite3.connect(":memory:")
        db.executescript("""
          CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,amount REAL);
          CREATE TABLE journal_entries(id TEXT PRIMARY KEY,amount REAL);
          INSERT INTO sales_invoices VALUES('same-source',NULL,15.0);
          INSERT INTO journal_entries VALUES('receipt',15.0);
        """)
        return db

    def test_exact_rows_are_order_independent_and_preserve_sqlite_types(self):
        a, b = self.fixture(), self.fixture()
        self.assertEqual(hashed_rows(a, "sales_invoices"), hashed_rows(b, "sales_invoices"))
        b.execute("UPDATE sales_invoices SET amount=15.01")
        self.assertNotEqual(hashed_rows(a, "sales_invoices"), hashed_rows(b, "sales_invoices"))
        a.close(); b.close()

    def test_missing_or_doubled_receipt_not_equal(self):
        a, b = self.fixture(), self.fixture()
        b.execute("DELETE FROM journal_entries")
        self.assertNotEqual(hashed_rows(a, "journal_entries"), hashed_rows(b, "journal_entries"))
        b.execute("INSERT INTO journal_entries VALUES('other',15.0)")
        self.assertNotEqual(hashed_rows(a, "journal_entries"), hashed_rows(b, "journal_entries"))
        a.close(); b.close()

    def test_identity_null_legacy_and_explicit_are_not_equal(self):
        a = self.fixture()
        before = hashed_rows(a, "sales_invoices")
        for tenant in ("", "local_default", "unproven-tenant"):
            a.execute("UPDATE sales_invoices SET pharmacy_id=?", (tenant,))
            self.assertNotEqual(before, hashed_rows(a, "sales_invoices"))
        a.close()

    def test_differing_text_blob_and_number_types_not_equal(self):
        self.assertNotEqual(record_hash((1,)), record_hash(("1",)))
        self.assertNotEqual(record_hash((1.0,)), record_hash((1,)))
        self.assertNotEqual(record_hash((b"1",)), record_hash(("1",)))
        self.assertNotEqual(record_hash((None,)), record_hash(("",)))


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        result = unittest.TextTestRunner(verbosity=2).run(
            unittest.defaultTestLoader.loadTestsFromTestCase(SyntheticDiffTests)
        )
        return 0 if result.wasSuccessful() else 1
    if len(sys.argv) > 1:
        print(json.dumps({"accepted": False, "reason": "unsupported_input"}))
        return 2
    try:
        result = audit_profile()
    except (Refused, OSError, sqlite3.Error, ValueError, TypeError, KeyError):
        print(json.dumps({"accepted": False, "reason": "strict_copy_upgrade_discrepancy_or_unavailable"}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
