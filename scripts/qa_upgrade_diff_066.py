"""Read-only installed QA v065 -> v066 full typed-row differential.

Requires a genuine hashed native-created v065 backup and separately licensed
disposable QA profile. Rejects any unexplained old row, schema or money changes;
does not guess tenant ownership or touch the historical archive.
"""
from __future__ import annotations

from collections import Counter
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import uuid

from scripts.qa_upgrade_diff_065 import (
    QA_ID, EXPECTED_REPO_SHA, Refused, require, digest_file, tables,
    objects, hashed_rows, integrity, DOMAINS,
)
from scripts.qa_lifecycle_receipt_postflight_064 import inspect_profile

ADDED_TRIGGERS = {
    f"native_legacy_upgrade_{table}_payload_no_update"
    for table in (
        "inventory", "sales_invoices", "purchase_invoices", "returns",
        "activity_log", "shortages", "purchase_orders", "cash_movements",
        "daily_journals", "expenses", "financial_notices",
    )
}


def compare(old: sqlite3.Connection, new: sqlite3.Connection) -> dict:
    integrity(old)
    integrity(new)
    original_tables, new_tables = tables(old), tables(new)
    require(original_tables == new_tables, "66_changed_table_names")
    prior_obj, after_obj = objects(old), objects(new)
    require(all(after_obj.get(key) == value for key, value in prior_obj.items()),
            "66_changed_original_ddl")
    additional = set(after_obj) - set(prior_obj)
    require(additional == {("trigger", name) for name in ADDED_TRIGGERS},
            "66_unapproved_new_schema_object")
    unchanged = 0
    counts = {}
    for table in sorted(original_tables - {"_sqlx_migrations", "activity_log"}):
        before, after = hashed_rows(old, table), hashed_rows(new, table)
        require(before == after, "66_original_business_record_changed")
        unchanged += 1
        if table in DOMAINS:
            counts[table] = {"before": sum(before.values()), "after": sum(after.values())}
    previous_ledger = hashed_rows(old, "_sqlx_migrations")
    current_ledger = hashed_rows(new, "_sqlx_migrations")
    require(not (previous_ledger - current_ledger)
            and sum((current_ledger - previous_ledger).values()) == 1,
            "66_original_migration_checksum_changed")
    require(old.execute("SELECT count(*),min(version),max(version) FROM _sqlx_migrations").fetchone()
            == (65, 1, 65), "66_original_not_exact_v065")
    require(new.execute("SELECT count(*),min(version),max(version) FROM _sqlx_migrations").fetchone()
            == (66, 1, 66), "66_current_not_exact_v066")
    require(new.execute(
        "SELECT description,success FROM _sqlx_migrations WHERE version=66"
    ).fetchall() == [("legacy_mapped_source_row_seal", 1)],
            "66_new_migration_identity_bad")
    previous_log = hashed_rows(old, "activity_log")
    current_log = hashed_rows(new, "activity_log")
    require(not (previous_log - current_log), "66_existing_audit_row_changed")
    boundary = old.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()[0]
    appended = new.execute(
        "SELECT action,CAST(user_id AS TEXT),pharmacy_id FROM activity_log "
        "WHERE id>? ORDER BY id", (boundary,),
    ).fetchall()
    require(len(appended) == sum((current_log - previous_log).values())
            and len(appended) <= 128
            and all(v == ("LOGIN", "qa_lifecycle_owner_20261016", "qa_lifecycle_20261016")
                    for v in appended), "66_unexpected_audit_activity")
    for table in (
        "native_legacy_upgrade_manifests",
        "native_legacy_upgrade_source_mappings",
        "native_legacy_upgrade_manifest_seals",
    ):
        require(new.execute(f'SELECT count(*) FROM "{table}"').fetchone() == (0,),
                "66_unapproved_historical_grant_found")
    return {
        "accepted": True,
        "classification": "VERIFIED_DISPOSABLE_QA_065_TO_066_ONLY",
        "original_migrations": 65,
        "new_migrations": 66,
        "old_tables": len(original_tables),
        "new_tables": len(new_tables),
        "all_existing_business_tables_unchanged": unchanged,
        "unexpected_missing_or_changed_original_records": 0,
        "new_payload_immutability_triggers": len(ADDED_TRIGGERS),
        "new_login_only_events": len(appended),
        "unapproved_historic_grants": 0,
        "domain_counts": counts,
        "production_tenantless_upgrade_certified": False,
    }


def pre_upgrade_backup() -> tuple[Path, Path, Path]:
    require(os.name == "nt", "66_windows_profile_only")
    appdata = Path(os.environ.get("APPDATA", ""))
    require(appdata.is_absolute() and appdata.is_dir() and not appdata.is_symlink(),
            "66_appdata_unavailable")
    directory = appdata / QA_ID
    active = directory / "pharma_local.db"
    backups = directory / "backups"
    require(directory.is_dir() and backups.is_dir() and active.is_file()
            and not active.is_symlink(), "66_disposable_qa_missing")
    matches = []
    for entry in backups.iterdir():
        require(entry.is_dir() and not entry.is_symlink()
                and str(uuid.UUID(entry.name)) == entry.name,
                "66_unexpected_backup_directory")
        manifest_path = entry / "backup_manifest.json"
        source = entry / "pharma_local.db"
        require(manifest_path.is_file() and source.is_file()
                and not manifest_path.is_symlink() and not source.is_symlink()
                and source.stat().st_nlink == 1, "66_missing_native_sealed_backup")
        manifest = json.loads(manifest_path.read_text("utf8"))
        require(manifest.get("format") == "pharma-backup-snapshot-v1"
                and manifest.get("database_file") == "pharma_local.db"
                and manifest.get("backup_id") == entry.name
                and manifest.get("source_name") == "pharma_local.db"
                and manifest.get("sha256") == digest_file(source)
                and manifest.get("size_bytes") == source.stat().st_size
                and manifest.get("created_by_owner") is None,
                "66_native_backup_manifest_unverified")
        expected_path_hash = hashlib.sha256(("\\\\?\\" + str(active.resolve())).encode()).hexdigest()
        require(manifest.get("source_path_sha256") == expected_path_hash,
                "66_wrong_appdata_backup_lineage")
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            db.execute("PRAGMA query_only=ON")
            integrity(db)
            version = db.execute(
                "SELECT count(*),min(version),max(version) FROM _sqlx_migrations"
            ).fetchone()
        if version == (65, 1, 65):
            matches.append(source)
    require(len(matches) == 1, "66_no_unique_valid_sealed_065_backup")
    return matches[0], active, Path(__file__).resolve().parents[1] / "src-tauri" / "pharma_local.db"


def run() -> dict:
    source, active, repo = pre_upgrade_backup()
    previous_hash, current_hash = digest_file(source), digest_file(active)
    require(digest_file(repo) == EXPECTED_REPO_SHA, "66_original_repo_db_changed")
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro&immutable=1", uri=True)) as old:
        with closing(sqlite3.connect(active.as_uri() + "?mode=ro", uri=True)) as current_ro:
            current_ro.execute("PRAGMA query_only=ON")
            with closing(sqlite3.connect(":memory:")) as frozen:
                current_ro.backup(frozen)
                outcome = compare(old, frozen)
    require(digest_file(source) == previous_hash and digest_file(active) == current_hash
            and digest_file(repo) == EXPECTED_REPO_SHA,
            "66_source_changed_during_readonly_diff")
    ledger = inspect_profile(post_066=True)
    require(ledger.get("all_owned_journals_balanced") is True
            and ledger.get("supplier_payable_match") is True
            and ledger.get("owned_wallet_and_credit_limit_match") is True,
            "66_finance_postflight_failed")
    outcome["strict_receipts_and_finance_postflight"] = "PASS"
    outcome["original_native_backup_unchanged"] = True
    outcome["protected_repo_unchanged"] = True
    return outcome


if __name__ == "__main__":
    try:
        result = run()
    except (Refused, OSError, ValueError, TypeError, sqlite3.Error, KeyError):
        print(json.dumps({"accepted": False, "classification": "FAIL_CLOSED_065_TO_066_QA_DISCREPANCY"}))
        raise SystemExit(2)
    print(json.dumps(result, sort_keys=True))
