"""Strict, read-only lifecycle QA postflight after prospective migration 064.

Runs ONLY against the fixed disposable QA AppData identity. It never copies,
updates, backfills or exports historic data, and never prints raw row IDs,
names, patient information, account details or monetary values. Legacy global
records are not assigned to the QA tenant.

Usage:
  python -B -m scripts.qa_lifecycle_receipt_postflight_064
  python -B -m scripts.qa_lifecycle_receipt_postflight_064 --pre-064
  python -B -m scripts.qa_lifecycle_receipt_postflight_064 --self-test

The pre-064 mode is a strictly explicit, 63-migration baseline check. It
cannot be mistaken for installed-064 acceptance. Both modes fail closed.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import unittest


IDENTITY = "com.pharma.disposable.lifecycle.qa20261016"
TENANT = "qa_lifecycle_20261016"
ACTOR = "qa_lifecycle_owner_20261016"
ORIGINAL_SHA256 = "8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3"
MAX_QA_BYTES = 1024 * 1024 * 1024


class PostflightRefused(ValueError):
    """Safe-to-print fixed-code denial; never include SQL, IDs, or PII."""


def require(ok: bool, code: str) -> None:
    if not ok:
        raise PostflightRefused(code)


def file_sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for piece in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(piece)
    return digest.hexdigest()


def count(db: sqlite3.Connection, sql: str, *params: object) -> int:
    """Only fixed SQL and fixed scalar params; consume exactly one count."""
    value = db.execute(sql, params).fetchone()
    require(value is not None and len(value) == 1 and
            isinstance(value[0], int) and value[0] >= 0, "invalid_aggregate")
    return value[0]


def must_count(
    db: sqlite3.Connection, label: str, expected: int,
    sql: str, *params: object,
) -> int:
    result = count(db, sql, *params)
    require(result == expected, label)
    return result


def cent_eq(alias: str, field: str) -> str:
    """Use fixed trusted SQL identifiers; values stay inside SQLite."""
    return (f"typeof({alias}.{field}) IN ('integer','real') "
            f"AND abs({alias}.{field}*100-?)<0.0001")


def migration_checks(db: sqlite3.Connection, *, pre_064: bool,
                     post_065: bool = False, post_066: bool = False) -> int:
    require(sum((bool(pre_064), bool(post_065), bool(post_066))) <= 1,
            "conflicting_migration_phase")
    expected = 63 if pre_064 else 66 if post_066 else 65 if post_065 else 64
    # Exact contiguous migration set prevents 64 successes mixed with later,
    # failed, duplicate or omitted older versions from receiving a green pass.
    record = db.execute(
        "SELECT count(*), count(DISTINCT version), min(version), max(version), "
        "sum(CASE WHEN success=1 THEN 1 ELSE 0 END) FROM _sqlx_migrations"
    ).fetchone()
    require(record == (expected, expected, 1, expected, expected),
            "migration_set_incorrect")
    must_count(db, "migration_versions_noninteger", 0,
               "SELECT count(*) FROM _sqlx_migrations "
               "WHERE typeof(version)!='integer'")
    receipt_tables = count(
        db,
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN "
        "('native_master_drug_create_receipts','native_master_drug_create_candidates')",
    )
    require(receipt_tables == (0 if pre_064 else 2), "catalog_064_schema_incorrect")
    if not pre_064:
        must_count(db, "catalog_receipts_must_be_zero", 0,
                   "SELECT count(*) FROM native_master_drug_create_receipts")
        must_count(db, "catalog_candidates_must_be_zero", 0,
                   "SELECT count(*) FROM native_master_drug_create_candidates")
    if post_065 or post_066:
        must_count(db, "legacy_065_schema_missing", 4,
                   "SELECT count(*) FROM sqlite_master WHERE "
                   "(type='table' AND name IN "
                   "('native_legacy_upgrade_manifests',"
                   "'native_legacy_upgrade_source_mappings',"
                   "'native_legacy_upgrade_manifest_seals')) OR "
                   "(type='view' AND name='native_legacy_upgrade_authorized_sources')")
        for table in (
            "native_legacy_upgrade_manifests",
            "native_legacy_upgrade_source_mappings",
            "native_legacy_upgrade_manifest_seals",
        ):
            # Fixed, trusted table-name allowlist; no untrusted identifier SQL.
            must_count(db, "unapproved_legacy_065_evidence_exists", 0,
                       f'SELECT count(*) FROM "{table}"')
    if post_066:
        must_count(db, "legacy_066_payload_guards_missing", 11,
                   "SELECT count(*) FROM sqlite_master WHERE type='trigger' "
                   "AND name LIKE 'native_legacy_upgrade_%_payload_no_update'")
    return expected


def audit(db: sqlite3.Connection, *, pre_064: bool = False,
          post_065: bool = False, post_066: bool = False) -> dict:
    """Read fixed aggregate source checks; do not extract sensitive rows."""
    db.execute("PRAGMA query_only=ON")
    require(db.execute("PRAGMA integrity_check").fetchone() == ("ok",),
            "sqlite_integrity")
    require(db.execute("PRAGMA foreign_key_check").fetchone() is None,
            "foreign_keys")
    migration_count = migration_checks(db, pre_064=pre_064,
                                       post_065=post_065, post_066=post_066)

    must_count(db, "qa_owner_identity", 1,
               "SELECT count(*) FROM users WHERE CAST(id AS TEXT)=? "
               "AND pharmacy_id=? AND lower(trim(role))='owner' "
               "AND COALESCE(is_active,1)=1", ACTOR, TENANT)
    counts = {
        "purchases": must_count(
            db, "tenant_purchase_count", 1,
            "SELECT count(*) FROM purchase_invoices WHERE pharmacy_id=?", TENANT),
        "sales": must_count(
            db, "tenant_sale_count", 1,
            "SELECT count(*) FROM sales_invoices WHERE pharmacy_id=?", TENANT),
        "customer_returns": must_count(
            db, "tenant_customer_return_count", 1,
            "SELECT count(*) FROM returns r JOIN sales_invoices s ON s.id=r.invoice_id "
            "WHERE s.pharmacy_id=?", TENANT),
        "journals": must_count(
            db, "tenant_journal_count", 6,
            "SELECT count(*) FROM daily_journals WHERE pharmacy_id=?", TENANT),
        "cash_movements": must_count(
            db, "tenant_cash_movement_count", 1,
            "SELECT count(*) FROM cash_movements WHERE pharmacy_id=?", TENANT),
        "lots": must_count(
            db, "tenant_inventory_lot_count", 1,
            "SELECT count(*) FROM inventory WHERE pharmacy_id=?", TENANT),
        "owned_patients": must_count(
            db, "tenant_patient_witness_count", 2,
            "SELECT count(*) FROM native_patient_directory_ownership w "
            "JOIN patients p ON p.id=w.patient_id WHERE w.pharmacy_id=?", TENANT),
        "global_purchase_returns": must_count(
            db, "global_purchase_return_count", 1,
            "SELECT count(*) FROM purchase_returns"),
        "open_shifts": must_count(
            db, "tenant_open_shift_count", 1,
            "SELECT count(*) FROM shifts WHERE pharmacy_id=? "
            "AND lower(trim(status))='open'", TENANT),
    }
    must_count(db, "tenant_total_shift_count", 1,
               "SELECT count(*) FROM shifts WHERE pharmacy_id=?", TENANT)

    must_count(
        db, "purchase_042_044_source", 1,
        "SELECT count(*) FROM purchase_invoices p "
        "JOIN native_purchase_create_requests c ON c.invoice_id=p.id "
        "JOIN native_purchase_posting_events e ON e.journal_id=c.initial_journal_id "
        "WHERE p.pharmacy_id=? AND CAST(p.user_id AS TEXT)=? "
        "AND p.payment_method='credit' AND p.status='completed' "
        "AND c.pharmacy_id=p.pharmacy_id AND c.actor_id=p.user_id "
        "AND c.supplier_id=p.supplier_id AND c.source_status='completed' "
        "AND c.source_total_cents=46200 AND c.source_line_count=1 "
        "AND e.event_kind='initial' AND e.invoice_id=p.id "
        "AND e.actor_id=c.actor_id AND e.pharmacy_id=p.pharmacy_id "
        "AND e.supplier_id=p.supplier_id AND e.payment_method='credit' "
        "AND e.new_total_cents=46200 AND "
        + cent_eq("p", "total_amount"),
        TENANT, ACTOR, 46200,
    )
    must_count(db, "native_purchase_initial_event_count", 1,
               "SELECT count(*) FROM native_purchase_posting_events "
               "WHERE pharmacy_id=? AND event_kind='initial'", TENANT)
    must_count(db, "native_purchase_create_count", 1,
               "SELECT count(*) FROM native_purchase_create_requests WHERE pharmacy_id=?",
               TENANT)
    must_count(db, "native_sale_cogs_count", 1,
               "SELECT count(*) FROM native_sale_cogs_provenance "
               "WHERE pharmacy_id=?", TENANT)
    must_count(
        db, "sale_043_source", 1,
        "SELECT count(*) FROM sales_invoices s "
        "JOIN native_sale_cogs_provenance r ON r.sale_id=s.id "
        "WHERE s.pharmacy_id=? AND s.user_id=? AND r.pharmacy_id=s.pharmacy_id "
        "AND r.actor_id=s.user_id AND s.payment_method='cash' "
        "AND lower(trim(s.status))='completed' "
        "AND r.sale_micros=300000000 AND r.cogs_micros=231000000 AND "
        + cent_eq("s", "total_amount"), TENANT, ACTOR, 30000,
    )
    must_count(db, "native_return_cogs_count", 1,
               "SELECT count(*) FROM native_sale_return_cogs_provenance "
               "WHERE pharmacy_id=?", TENANT)
    must_count(
        db, "return_043_source", 1,
        "SELECT count(*) FROM returns r "
        "JOIN sales_invoices s ON s.id=r.invoice_id "
        "JOIN native_sale_return_cogs_provenance w ON w.return_id=r.id "
        "WHERE s.pharmacy_id=? AND CAST(r.user_id AS TEXT)=? "
        "AND w.actor_id=r.user_id AND w.sale_id=s.id "
        "AND w.pharmacy_id=s.pharmacy_id AND w.refund_micros=150000000 "
        "AND w.cogs_micros=115500000", TENANT, ACTOR,
    )
    must_count(db, "native_supplier_payment_count", 1,
               "SELECT count(*) FROM native_supplier_payment_receipts "
               "WHERE pharmacy_id=?", TENANT)
    must_count(
        db, "supplier_receipt_054_lineage", 1,
        "SELECT count(*) FROM native_supplier_payment_receipts r "
        "JOIN purchase_invoices p ON p.id=r.invoice_id AND p.supplier_id=r.supplier_id "
        "JOIN supplier_transactions t ON t.id=r.supplier_transaction_id "
        "JOIN suppliers s ON s.id=r.supplier_id "
        "JOIN daily_journals j ON j.id=r.journal_id "
        "WHERE r.pharmacy_id=? AND r.actor_id=? AND p.pharmacy_id=r.pharmacy_id "
        "AND p.payment_method='credit' AND r.payment_method='bank' "
        "AND r.amount_cents=2500 AND r.balance_before_cents=46200 "
        "AND r.balance_after_cents=43700 AND r.cash_movement_id IS NULL "
        "AND t.supplier_id=r.supplier_id AND t.type='payment' "
        "AND t.user_id=r.actor_id AND t.payment_method=r.payment_method "
        "AND t.reference_id='supplier-payment:'||r.id "
        "AND j.pharmacy_id=r.pharmacy_id "
        "AND " + cent_eq("s", "balance") + " AND "
        + cent_eq("t", "amount") + " AND " + cent_eq("j", "total_amount"),
        TENANT, ACTOR, 32150, 2500, 2500,
    )
    must_count(db, "native_purchase_return_count", 1,
               "SELECT count(*) FROM native_purchase_return_provenance "
               "WHERE pharmacy_id=?", TENANT)
    must_count(
        db, "supplier_return_041_lineage", 1,
        "SELECT count(*) FROM purchase_returns r "
        "JOIN purchase_invoices p ON p.id=r.purchase_invoice_id "
        "JOIN native_purchase_return_provenance w ON w.return_id=r.id "
        "JOIN daily_journals j ON j.id=w.journal_id "
        "WHERE p.pharmacy_id=? AND CAST(r.user_id AS TEXT)=? "
        "AND r.supplier_id=p.supplier_id AND w.purchase_invoice_id=p.id "
        "AND w.supplier_id=p.supplier_id AND w.pharmacy_id=p.pharmacy_id "
        "AND w.actor_id=r.user_id AND w.amount_cents=11550 "
        "AND w.line_count=1 AND w.refund_method='credit' "
        "AND j.pharmacy_id=p.pharmacy_id", TENANT, ACTOR,
    )
    must_count(
        db, "owned_lot_value_and_quantity", 1,
        "SELECT count(*) FROM inventory i "
        "JOIN purchase_invoice_items pi ON pi.inventory_id=i.id "
        "JOIN purchase_invoices p ON p.id=pi.invoice_id "
        "WHERE i.pharmacy_id=? AND p.pharmacy_id=i.pharmacy_id "
        "AND i.quantity=2 AND " + cent_eq("i", "cost_price")
        + " AND " + cent_eq("i", "local_selling_price"),
        TENANT, 11550, 15000,
    )
    must_count(db, "tenant_wallet_receipt_count", 1,
               "SELECT count(*) FROM native_patient_wallet_topup_receipts "
               "WHERE pharmacy_id=?", TENANT)
    must_count(
        db, "wallet_060_cash_journal_witness", 1,
        "SELECT count(*) FROM native_patient_wallet_topup_receipts r "
        "JOIN native_patient_directory_ownership w ON w.patient_id=r.patient_id "
        "JOIN patients p ON p.id=r.patient_id "
        "JOIN cash_movements c ON c.id=r.cash_movement_id "
        "JOIN shifts s ON s.id=r.shift_id AND s.id=c.shift_id "
        "JOIN daily_journals j ON j.id=r.journal_id "
        "WHERE r.pharmacy_id=? AND r.actor_id=? AND w.pharmacy_id=r.pharmacy_id "
        "AND r.amount_cents=500 AND c.pharmacy_id=r.pharmacy_id "
        "AND c.category='patient_wallet' AND c.source_type='patient_wallet' "
        "AND c.type='receipt' AND c.user_id=r.actor_id "
        "AND c.target_name=r.patient_id "
        "AND s.pharmacy_id=r.pharmacy_id AND lower(trim(s.status))='open' "
        "AND j.pharmacy_id=r.pharmacy_id AND j.created_by=r.actor_id "
        "AND " + cent_eq("p", "wallet_balance") + " AND "
        + cent_eq("c", "amount") + " AND " + cent_eq("j", "total_amount"),
        TENANT, ACTOR, 500, 500, 500,
    )
    must_count(
        db, "owned_wallet_sum_and_credit_limits", 2,
        "SELECT count(*) FROM native_patient_directory_ownership w "
        "JOIN patients p ON p.id=w.patient_id "
        "WHERE w.pharmacy_id=? AND " + cent_eq("p", "credit_limit"),
        TENANT, 0,
    )
    # Global patient rows do not gain inferred QA ownership. Exactly one of
    # the two *prospectively witnessed* QA patients holds the 500-cent wallet.
    must_count(
        db, "owned_wallet_nonzero_count", 1,
        "SELECT count(*) FROM native_patient_directory_ownership w "
        "JOIN patients p ON p.id=w.patient_id "
        "WHERE w.pharmacy_id=? AND " + cent_eq("p", "wallet_balance"),
        TENANT, 500,
    )
    must_count(
        db, "owned_wallet_zero_count", 1,
        "SELECT count(*) FROM native_patient_directory_ownership w "
        "JOIN patients p ON p.id=w.patient_id "
        "WHERE w.pharmacy_id=? AND " + cent_eq("p", "wallet_balance"),
        TENANT, 0,
    )
    must_count(db, "tenant_credit_sales_must_be_zero", 0,
               "SELECT count(*) FROM sales_invoices "
               "WHERE pharmacy_id=? AND (lower(trim(payment_method))='credit' "
               "OR COALESCE(remaining_amount,0)>0)", TENANT)
    must_count(db, "tenant_stock_adjustments_must_be_zero", 0,
               "SELECT count(*) FROM stock_adjustments a "
               "JOIN inventory i ON i.id=a.inventory_id WHERE i.pharmacy_id=?",
               TENANT)
    must_count(db, "tenant_native_stock_adjustments_must_be_zero", 0,
               "SELECT count(*) FROM native_stock_ledger_provenance "
               "WHERE pharmacy_id=?", TENANT)
    must_count(db, "tenant_negative_sales_must_be_zero", 0,
               "SELECT count(*) FROM sales_items i "
               "JOIN sales_invoices s ON s.id=i.invoice_id "
               "WHERE s.pharmacy_id=? AND COALESCE(i.is_negative,0)<>0",
               TENANT)

    # This query aggregates *inside SQLite*; no journal IDs or monetary
    # values leave the connection. A journal must be exactly two-sided,
    # cent-exact, and each side must equal its own header total.
    errors = count(
        db,
        "SELECT count(*) FROM ( "
        " SELECT j.id FROM daily_journals j "
        " LEFT JOIN journal_entries e ON e.journal_id=j.id "
        " WHERE j.pharmacy_id=? "
        " GROUP BY j.id "
        " HAVING CAST(j.created_by AS TEXT)<>? OR j.created_by IS NULL "
        " OR count(e.id)<2 "
        " OR sum(CASE WHEN e.type='debit' THEN 1 ELSE 0 END)<1 "
        " OR sum(CASE WHEN e.type='credit' THEN 1 ELSE 0 END)<1 "
        " OR sum(CASE WHEN e.type NOT IN ('debit','credit') OR e.type IS NULL "
        "    THEN 1 ELSE 0 END)>0 "
        " OR sum(CASE WHEN e.amount IS NULL OR "
        "    typeof(e.amount) NOT IN ('integer','real') "
        "    OR e.amount<0 OR abs(e.amount*100-round(e.amount*100))>0.0001 "
        "    THEN 1 ELSE 0 END)>0 "
        " OR typeof(j.total_amount) NOT IN ('integer','real') "
        " OR j.total_amount<0 OR "
        "    abs(j.total_amount*100-round(j.total_amount*100))>0.0001 "
        " OR sum(CASE WHEN e.type='debit' THEN round(e.amount*100) ELSE 0 END)"
        "    <>round(j.total_amount*100) "
        " OR sum(CASE WHEN e.type='credit' THEN round(e.amount*100) ELSE 0 END)"
        "    <>round(j.total_amount*100) "
        ")",
        TENANT, ACTOR,
    )
    require(errors == 0, "owned_journals_unbalanced_or_invalid")
    must_count(
        db, "tenant_journal_total_unexpected", 1,
        "SELECT count(*) FROM (SELECT sum(total_amount) AS posted_total "
        "FROM daily_journals WHERE pharmacy_id=? "
        "HAVING count(*)=6 AND "
        "abs(sum(total_amount)*100-140400)<0.0001)",
        TENANT,
    )
    entry_count = count(db,
                        "SELECT count(*) FROM journal_entries e "
                        "JOIN daily_journals j ON j.id=e.journal_id "
                        "WHERE j.pharmacy_id=?", TENANT)
    require(entry_count >= 12, "tenant_journal_entries_incomplete")

    return {
        "mode": "pre_064" if pre_064 else "post_066" if post_066 else "post_065" if post_065 else "post_064",
        "post_064_accepted": not pre_064,
        "post_065_evidence_schema_installed": post_065 or post_066,
        "post_066_payload_seal_installed": post_066,
        "authorized_legacy_mapping_count": 0 if post_065 or post_066 else None,
        "sqlite_integrity_and_foreign_keys_ok": True,
        "migration_count": migration_count,
        "exact_contiguous_migrations": True,
        "owned_counts": counts,
        "supplier_payment_054_count": 1,
        "wallet_funding_060_count": 1,
        "native_purchase_042_044_count": 1,
        "native_sales_043_count": 1,
        "native_customer_returns_043_count": 1,
        "native_supplier_returns_041_count": 1,
        "tenant_journal_entries": entry_count,
        "all_owned_journals_balanced": True,
        "lot_stock_cost_retail_match": True,
        "supplier_payable_match": True,
        "owned_wallet_and_credit_limit_match": True,
        "credit_sales": 0,
        "tenant_stock_adjustments": 0,
        "catalog_create_receipts": 0 if not pre_064 else None,
        "catalog_create_candidates": 0 if not pre_064 else None,
        "historical_ownership_not_inferred": True,
        "data_copy_performed": False,
        "production_certified": False,
    }


def permitted_files() -> tuple[Path, Path]:
    """Reject any caller-selected database, AppData alias or SQLite sidecar."""
    require(os.name == "nt", "windows_only_profile")
    appdata_var = os.environ.get("APPDATA")
    require(bool(appdata_var) and Path(appdata_var).is_absolute(), "appdata_missing")
    appdata = Path(appdata_var)
    profile = appdata / IDENTITY
    db = profile / "pharma_local.db"
    original = Path(__file__).resolve().parents[1] / "src-tauri" / "pharma_local.db"
    for item in (appdata, profile, db):
        require(item.exists() and not item.is_symlink(), "profile_path_denied")
        require(os.path.normcase(os.path.abspath(item)) ==
                os.path.normcase(str(item.resolve(strict=True))),
                "profile_alias_denied")
    require(db.is_file() and original.is_file() and db != original,
            "profile_source_denied")
    require(db.stat().st_size <= MAX_QA_BYTES and db.stat().st_size > 0,
            "profile_size_denied")
    require(db.stat().st_nlink == 1, "profile_hardlink_denied")
    for suffix in ("-wal", "-shm", "-journal"):
        require(not db.with_name(db.name + suffix).exists(), "active_sqlite_sidecar_denied")
    return original, db


def inspect_profile(*, pre_064: bool = False,
                    post_065: bool = False, post_066: bool = False) -> dict:
    original, db_file = permitted_files()
    original_before = file_sha(original)
    require(original_before == ORIGINAL_SHA256, "original_repository_sha_changed")
    qa_before = file_sha(db_file)
    # immutable=1 avoids creation/access of SHM/journal and enforces a static
    # detached read. Sidecars and changed before/after bytes cause denial.
    with closing(sqlite3.connect(
        db_file.as_uri() + "?mode=ro&immutable=1", uri=True
    )) as db:
        report = audit(db, pre_064=pre_064, post_065=post_065,
                       post_066=post_066)
    require(file_sha(db_file) == qa_before, "qa_changed_during_read")
    require(file_sha(original) == original_before, "original_changed_during_read")
    report["disposable_appdata_only"] = True
    report["original_repository_sha_preserved"] = True
    report["qa_file_unchanged_during_read"] = True
    report["read_only_immutable_sqlite"] = True
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only QA lifecycle 064 receipts postflight")
    parser.add_argument("--pre-064", action="store_true",
                        help="Explicit 63-migration baseline only; never claim 064 acceptance")
    parser.add_argument("--post-065", action="store_true",
                        help="Strict 65-migration evidence-only upgrade QA; no legacy adoption")
    parser.add_argument("--post-066", action="store_true",
                        help="Strict 66-migration mapped-source payload-seal QA; no history adoption")
    parser.add_argument("--self-test", action="store_true",
                        help="Synthetic RAM-only regression; does not open AppData")
    options = parser.parse_args(argv)
    if sum((options.pre_064, options.post_065, options.post_066)) > 1:
        parser.error("Conflicting migration acceptance modes")
    if options.self_test:
        require(not options.pre_064, "conflicting_test_options")
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(PostflightSyntheticRegression)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    try:
        result = inspect_profile(pre_064=options.pre_064,
                                 post_065=options.post_065,
                                 post_066=options.post_066)
    except (OSError, sqlite3.Error, PostflightRefused) as exc:
        code = str(exc) if isinstance(exc, PostflightRefused) else "readonly_sqlite_unavailable"
        print(json.dumps({"accepted": False, "reason": code,
                          "production_certified": False}, sort_keys=True))
        return 1
    # An explicit pre-064 baseline passing is NEVER an accepted 064 postflight.
    print(json.dumps({
        "accepted": not options.pre_064,
        "baseline_verified": options.pre_064,
        **result,
    }, sort_keys=True))
    return 0


def _synthetic_fixture(*, pre_064: bool = False) -> sqlite3.Connection:
    """Synthetic private RAM fixture; never contacts any AppData database."""
    db = sqlite3.connect(":memory:")
    db.executescript("""
      CREATE TABLE _sqlx_migrations(version INTEGER, success INTEGER);
      CREATE TABLE users(id TEXT,pharmacy_id TEXT,role TEXT,is_active INTEGER);
      CREATE TABLE purchase_invoices(
        id TEXT,supplier_id INTEGER,pharmacy_id TEXT,user_id TEXT,
        payment_method TEXT,status TEXT,total_amount REAL);
      CREATE TABLE native_purchase_create_requests(
        invoice_id TEXT,initial_journal_id TEXT,pharmacy_id TEXT,actor_id TEXT,
        supplier_id INTEGER,source_status TEXT,source_total_cents INTEGER,
        source_line_count INTEGER);
      CREATE TABLE native_purchase_posting_events(
        invoice_id TEXT,journal_id TEXT,actor_id TEXT,pharmacy_id TEXT,
        supplier_id INTEGER,payment_method TEXT,event_kind TEXT,new_total_cents INTEGER);
      CREATE TABLE sales_invoices(
        id TEXT,pharmacy_id TEXT,user_id TEXT,payment_method TEXT,
        status TEXT,total_amount REAL,remaining_amount REAL);
      CREATE TABLE native_sale_cogs_provenance(
        sale_id TEXT,pharmacy_id TEXT,actor_id TEXT,sale_micros INTEGER,cogs_micros INTEGER);
      CREATE TABLE returns(id TEXT,invoice_id TEXT,user_id TEXT);
      CREATE TABLE native_sale_return_cogs_provenance(
        return_id TEXT,sale_id TEXT,pharmacy_id TEXT,actor_id TEXT,
        refund_micros INTEGER,cogs_micros INTEGER);
      CREATE TABLE suppliers(id INTEGER,balance REAL);
      CREATE TABLE supplier_transactions(
        id INTEGER,supplier_id INTEGER,type TEXT,user_id TEXT,
        reference_id TEXT,payment_method TEXT,amount REAL);
      CREATE TABLE native_supplier_payment_receipts(
        id TEXT,supplier_id INTEGER,invoice_id TEXT,supplier_transaction_id INTEGER,
        pharmacy_id TEXT,actor_id TEXT,payment_method TEXT,amount_cents INTEGER,
        balance_before_cents INTEGER,balance_after_cents INTEGER,cash_movement_id TEXT,
        journal_id TEXT);
      CREATE TABLE purchase_returns(id TEXT,purchase_invoice_id TEXT,
        supplier_id INTEGER,user_id TEXT);
      CREATE TABLE native_purchase_return_provenance(
        return_id TEXT,purchase_invoice_id TEXT,supplier_id INTEGER,pharmacy_id TEXT,
        actor_id TEXT,amount_cents INTEGER,line_count INTEGER,refund_method TEXT,journal_id TEXT);
      CREATE TABLE inventory(id TEXT,pharmacy_id TEXT,quantity REAL,
        cost_price REAL,local_selling_price REAL);
      CREATE TABLE purchase_invoice_items(invoice_id TEXT,inventory_id TEXT);
      CREATE TABLE patients(id TEXT,credit_limit REAL,wallet_balance REAL);
      CREATE TABLE native_patient_directory_ownership(patient_id TEXT,pharmacy_id TEXT);
      CREATE TABLE native_patient_wallet_topup_receipts(
        patient_id TEXT,pharmacy_id TEXT,actor_id TEXT,amount_cents INTEGER,
        cash_movement_id TEXT,shift_id TEXT,journal_id TEXT);
      CREATE TABLE shifts(id TEXT,pharmacy_id TEXT,status TEXT);
      CREATE TABLE cash_movements(id TEXT,pharmacy_id TEXT,category TEXT,
        source_type TEXT,type TEXT,user_id TEXT,shift_id TEXT,
        target_name TEXT,amount REAL);
      CREATE TABLE daily_journals(id TEXT,pharmacy_id TEXT,created_by TEXT,total_amount REAL);
      CREATE TABLE journal_entries(id INTEGER PRIMARY KEY,journal_id TEXT,type TEXT,amount REAL);
      CREATE TABLE sales_items(invoice_id TEXT,is_negative INTEGER);
      CREATE TABLE stock_adjustments(id TEXT,inventory_id TEXT);
      CREATE TABLE native_stock_ledger_provenance(pharmacy_id TEXT);
    """)
    if not pre_064:
        db.executescript("""
          CREATE TABLE native_master_drug_create_receipts(id TEXT);
          CREATE TABLE native_master_drug_create_candidates(id TEXT);
        """)
    db.executemany("INSERT INTO _sqlx_migrations VALUES(?,1)",
                   ((index,) for index in range(1, 64 if pre_064 else 65)))
    db.execute("INSERT INTO users VALUES(?,?,?,1)", (ACTOR, TENANT, "owner"))
    db.execute("INSERT INTO purchase_invoices VALUES(?,?,?,?,?,?,?)",
               ("purchase-source", 1, TENANT, ACTOR, "credit", "completed", 462.0))
    db.execute("INSERT INTO native_purchase_create_requests VALUES(?,?,?,?,?,?,?,?)",
               ("purchase-source", "journal-purchase", TENANT, ACTOR, 1,
                "completed", 46200, 1))
    db.execute("INSERT INTO native_purchase_posting_events VALUES(?,?,?,?,?,?,?,?)",
               ("purchase-source", "journal-purchase", ACTOR, TENANT, 1,
                "credit", "initial", 46200))
    db.execute("INSERT INTO sales_invoices VALUES(?,?,?,?,?,?,?)",
               ("sale-source", TENANT, ACTOR, "cash", "completed", 300., 0.))
    db.execute("INSERT INTO native_sale_cogs_provenance VALUES(?,?,?,?,?)",
               ("sale-source", TENANT, ACTOR, 300000000, 231000000))
    db.execute("INSERT INTO returns VALUES(?,?,?)",
               ("return-source", "sale-source", ACTOR))
    db.execute("INSERT INTO native_sale_return_cogs_provenance VALUES(?,?,?,?,?,?)",
               ("return-source", "sale-source", TENANT, ACTOR, 150000000, 115500000))
    db.execute("INSERT INTO suppliers VALUES(1,321.5)")
    db.execute("INSERT INTO supplier_transactions VALUES(4,1,'payment',?,?,?,?)",
               (ACTOR, "supplier-payment:payment-receipt", "bank", 25.0))
    db.execute("INSERT INTO native_supplier_payment_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
               ("payment-receipt", 1, "purchase-source", 4, TENANT, ACTOR, "bank",
                2500, 46200, 43700, None, "journal-payment"))
    db.execute("INSERT INTO purchase_returns VALUES(?,?,?,?)",
               ("purchase-return-source", "purchase-source", 1, ACTOR))
    db.execute("INSERT INTO native_purchase_return_provenance VALUES(?,?,?,?,?,?,?,?,?)",
               ("purchase-return-source", "purchase-source", 1, TENANT,
                ACTOR, 11550, 1, "credit", "journal-purchase-return"))
    db.execute("INSERT INTO inventory VALUES(?,?,?,?,?)",
               ("lot-source", TENANT, 2, 115.5, 150.0))
    db.execute("INSERT INTO purchase_invoice_items VALUES(?,?)",
               ("purchase-source", "lot-source"))
    db.executemany("INSERT INTO patients VALUES(?,?,?)",
                   (("qa-patient-a", 0, 0), ("qa-patient-b", 0, 5)))
    db.executemany("INSERT INTO native_patient_directory_ownership VALUES(?,?)",
                   (("qa-patient-a", TENANT), ("qa-patient-b", TENANT)))
    db.execute("INSERT INTO shifts VALUES(? ,?,'open')", ("shift-qa", TENANT))
    db.execute("INSERT INTO cash_movements VALUES(?,?,?,?,?,?,?,?,?)",
               ("wallet-cash", TENANT, "patient_wallet", "patient_wallet",
                "receipt", ACTOR, "shift-qa", "qa-patient-b", 5.0))
    db.execute("INSERT INTO native_patient_wallet_topup_receipts VALUES(?,?,?,?,?,?,?)",
               ("qa-patient-b", TENANT, ACTOR, 500, "wallet-cash",
                "shift-qa", "journal-wallet"))
    db.execute("INSERT INTO sales_items VALUES('sale-source',0)")
    postings = {
        "journal-purchase": (462., (("debit", 462.), ("credit", 462.))),
        "journal-sale": (531., (("debit", 300.), ("credit", 300.),
                                ("debit", 231.), ("credit", 231.))),
        "journal-return": (265.5, (("debit", 150.), ("credit", 150.),
                                    ("debit", 115.5), ("credit", 115.5))),
        "journal-payment": (25., (("debit", 25.), ("credit", 25.))),
        "journal-purchase-return": (115.5, (("debit", 115.5), ("credit", 115.5))),
        "journal-wallet": (5., (("debit", 5.), ("credit", 5.))),
    }
    for journal, (amount, legs) in postings.items():
        db.execute("INSERT INTO daily_journals VALUES(?,?,?,?)",
                   (journal, TENANT, ACTOR, amount))
        db.executemany("INSERT INTO journal_entries(journal_id,type,amount) VALUES(?,?,?)",
                       ((journal, kind, value) for kind, value in legs))
    db.commit()
    return db


# Tests are embedded so this assignment changes exactly ONE new file.
class PostflightSyntheticRegression(unittest.TestCase):
    def test_post064_valid_qa_one_receipt_each_and_sanitized(self) -> None:
        with closing(_synthetic_fixture()) as db:
            report = audit(db)
            self.assertTrue(report["post_064_accepted"])
            self.assertEqual(report["migration_count"], 64)
            self.assertEqual(report["tenant_journal_entries"], 16)
            self.assertEqual(report["catalog_create_receipts"], 0)
            self.assertTrue(report["all_owned_journals_balanced"])
            self.assertFalse(report["production_certified"])
            encoded = json.dumps(report, sort_keys=True)
            for secret in ("purchase-source", "qa-patient-a", "lot-source",
                           "journal-wallet", ACTOR, TENANT, "321.5", "115.5"):
                self.assertNotIn(secret, encoded)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("UPDATE patients SET wallet_balance=99")

    def test_explicit_pre064_never_claims_new_catalog_migration(self) -> None:
        with closing(_synthetic_fixture(pre_064=True)) as db:
            report = audit(db, pre_064=True)
            self.assertEqual(report["mode"], "pre_064")
            self.assertFalse(report["post_064_accepted"])
            self.assertEqual(report["migration_count"], 63)
        with closing(_synthetic_fixture(pre_064=True)) as db:
            with self.assertRaisesRegex(PostflightRefused, "migration_set_incorrect"):
                audit(db, pre_064=False)
        with closing(_synthetic_fixture()) as db:
            with self.assertRaisesRegex(PostflightRefused, "migration_set_incorrect"):
                audit(db, pre_064=True)

    def test_fails_closed_on_receipt_wallet_catalog_and_cost_tampering(self) -> None:
        cases = (
            ("UPDATE inventory SET cost_price=150", "owned_lot_value_and_quantity"),
            ("UPDATE inventory SET local_selling_price=5", "owned_lot_value_and_quantity"),
            ("UPDATE patients SET wallet_balance=0", "wallet_060_cash_journal_witness"),
            ("UPDATE native_supplier_payment_receipts SET amount_cents=2501",
             "supplier_receipt_054_lineage"),
            ("UPDATE supplier_transactions SET amount=27", "supplier_receipt_054_lineage"),
            ("UPDATE cash_movements SET amount=7", "wallet_060_cash_journal_witness"),
            ("INSERT INTO native_master_drug_create_receipts VALUES('unauthorized')",
             "catalog_receipts_must_be_zero"),
            ("UPDATE journal_entries SET amount=100 WHERE journal_id='journal-wallet' "
             "AND type='debit'", "owned_journals_unbalanced_or_invalid"),
        )
        for statement, label in cases:
            with self.subTest(label=label), closing(_synthetic_fixture()) as db:
                db.execute(statement)
                with self.assertRaisesRegex(PostflightRefused, label):
                    audit(db)

    def test_incomplete_migration_and_incorrect_qa_tenant_fail_closed(self) -> None:
        with closing(_synthetic_fixture()) as db:
            db.execute("DELETE FROM _sqlx_migrations WHERE version=34")
            with self.assertRaisesRegex(PostflightRefused, "migration_set_incorrect"):
                audit(db)
        with closing(_synthetic_fixture()) as db:
            db.execute("UPDATE purchase_invoices SET pharmacy_id='local_default'")
            with self.assertRaisesRegex(PostflightRefused, "tenant_purchase_count"):
                audit(db)



if __name__ == "__main__":
    sys.exit(main())
