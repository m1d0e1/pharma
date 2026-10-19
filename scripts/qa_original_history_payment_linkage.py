"""Original-only payment/lot link diagnostics; never fabricates native receipts.

The preserved SQLx69 snapshot is read into SQLite memory. All output is
aggregate-only and `production_allowed` remains false, even on audit success.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import sys

from scripts import qa_original_history_financial_acceptance as finance
from scripts import qa_original_history_legacy_source_links as links
from scripts import qa_v02110_primary_pharmacy_migration as guard


def _count(db: sqlite3.Connection, sql: str) -> int:
    return int(db.execute(sql).fetchone()[0])


def check(db: sqlite3.Connection) -> dict:
    links.check(db)
    db.execute("PRAGMA query_only=ON")
    counts = {
        "sale_no_inventory_negative_lines": _count(db, """
            SELECT COUNT(*) FROM sales_items
            WHERE inventory_id IS NULL AND is_negative=1"""),
        "sale_no_inventory_regular_lines": _count(db, """
            SELECT COUNT(*) FROM sales_items
            WHERE inventory_id IS NULL AND (is_negative IS NULL OR is_negative<>1)"""),
        "completed_sale_no_inventory_lines": _count(db, """
            SELECT COUNT(*) FROM sales_items s JOIN sales_invoices i ON i.id=s.invoice_id
            WHERE s.inventory_id IS NULL AND i.status='completed'"""),
        "draft_sale_no_inventory_lines": _count(db, """
            SELECT COUNT(*) FROM sales_items s JOIN sales_invoices i ON i.id=s.invoice_id
            WHERE s.inventory_id IS NULL AND i.status='draft'"""),
        "purchase_invoice_zero_paid": _count(db, """
            SELECT COUNT(*) FROM purchase_invoices WHERE paid_amount=0"""),
        "supplier_unmatched_cash_positive_payments": _count(db, """
            SELECT COUNT(*) FROM supplier_transactions t
            WHERE t.type='payment' AND t.amount>0
              AND lower(t.payment_method)='cash'
              AND NOT EXISTS (SELECT 1 FROM purchase_invoices i
                    WHERE i.id=t.reference_id AND i.supplier_id=t.supplier_id)"""),
        "supplier_unmatched_payment_refs_len_21": _count(db, """
            SELECT COUNT(*) FROM supplier_transactions t
            WHERE t.type='payment' AND length(t.reference_id)=21
              AND NOT EXISTS (SELECT 1 FROM purchase_invoices i
                    WHERE i.id=t.reference_id AND i.supplier_id=t.supplier_id)"""),
        "cash_marked_supplier_payment": _count(db,
            "SELECT COUNT(*) FROM cash_movements WHERE source_type='supplier_payment'"),
        "patient_payment_transactions": _count(db,
            "SELECT COUNT(*) FROM patient_transactions WHERE type='payment'"),
        "cash_marked_patient_payment": _count(db,
            "SELECT COUNT(*) FROM cash_movements WHERE source_type='patient_payment'"),
        "patient_payment_amount_date_distinct_groups": _count(db, """
            SELECT COUNT(*) FROM (SELECT date,ROUND(amount,2) AS cents
              FROM patient_transactions WHERE type='payment'
              GROUP BY date,ROUND(amount,2))"""),
        "patient_cash_amount_date_unmatched_groups": _count(db, """
            WITH patient AS (
              SELECT date d,ROUND(amount,2) a,COUNT(*) n
              FROM patient_transactions WHERE type='payment'
              GROUP BY date,ROUND(amount,2)),
            cash AS (
              SELECT date d,ROUND(amount,2) a,COUNT(*) n
              FROM cash_movements WHERE source_type='patient_payment'
              GROUP BY date,ROUND(amount,2)),
            keys AS (SELECT d,a FROM patient UNION SELECT d,a FROM cash)
            SELECT COUNT(*) FROM keys k
            LEFT JOIN patient p ON p.d=k.d AND p.a=k.a
            LEFT JOIN cash c ON c.d=k.d AND c.a=k.a
            WHERE COALESCE(p.n,0)<>COALESCE(c.n,0)"""),
        "patient_wallet_positive_accounts": _count(db,
            "SELECT COUNT(*) FROM patients WHERE wallet_balance>0"),
        "cash_marked_patient_wallet": _count(db,
            "SELECT COUNT(*) FROM cash_movements WHERE source_type='patient_wallet'"),
        "patient_wallet_cash_amount_unmatched_groups": _count(db, """
            WITH wallet AS (
              SELECT ROUND(wallet_balance,2) a,COUNT(*) n FROM patients
              WHERE wallet_balance>0 GROUP BY ROUND(wallet_balance,2)),
            cash AS (
              SELECT ROUND(amount,2) a,COUNT(*) n FROM cash_movements
              WHERE source_type='patient_wallet' GROUP BY ROUND(amount,2)),
            keys AS (SELECT a FROM wallet UNION SELECT a FROM cash)
            SELECT COUNT(*) FROM keys k LEFT JOIN wallet w ON w.a=k.a
            LEFT JOIN cash c ON c.a=k.a
            WHERE COALESCE(w.n,0)<>COALESCE(c.n,0)"""),
    }
    expected = {
        "sale_no_inventory_negative_lines": 7,
        "sale_no_inventory_regular_lines": 1,
        "completed_sale_no_inventory_lines": 7,
        "draft_sale_no_inventory_lines": 1,
        "purchase_invoice_zero_paid": 101,
        "supplier_unmatched_cash_positive_payments": 9,
        "supplier_unmatched_payment_refs_len_21": 9,
        "cash_marked_supplier_payment": 6,
        "patient_payment_transactions": 49,
        "cash_marked_patient_payment": 49,
        "patient_payment_amount_date_distinct_groups": 49,
        "patient_cash_amount_date_unmatched_groups": 0,
        "patient_wallet_positive_accounts": 2,
        "cash_marked_patient_wallet": 2,
        "patient_wallet_cash_amount_unmatched_groups": 0,
    }
    if counts != expected:
        raise ValueError("Historical payment/date/lot link witnesses changed")
    return {
        "status": "HISTORICAL_PAYMENT_WITNESSES_MATCH_ACCEPTANCE_BLOCKED",
        "witness_counts": counts,
        "patient_cash_witness_is_date_amount_multiset_not_native_receipt": True,
        "patient_wallet_cash_amount_multiset_not_ownership_or_source_receipt": True,
        "supplier_payment_to_purchase_allocation_verified": False,
        "historic_sale_cash_attribution_verified": False,
        "historic_inventory_lot_cogs_verified": False,
        "historic_opening_balances_certified": False,
        "historical_owner_authenticated": False,
        "production_allowed": False,
    }


def main() -> int:
    try:
        path = guard.disposable_root() / finance.STAGE / finance.NAME
        raw = guard.checked_file(path, finance.PIN)
        with sqlite3.connect(":memory:") as db:
            db.deserialize(raw)
            result = check(db)
        if hashlib.sha256(path.read_bytes()).hexdigest() != finance.PIN:
            raise ValueError("Original detached database changed during payment inspection")
        result["original_sqlx69_sha256"] = finance.PIN
        result["database_mutations"] = 0
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, sqlite3.Error, OSError, guard.Refused):
        print(json.dumps({"status": "REFUSED_HISTORICAL_PAYMENT_WITNESS"}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
