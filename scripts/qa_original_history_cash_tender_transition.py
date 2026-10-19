"""Original-only source cash/tender carry-forward audit (read-only and blocked).

Historical sales tender, shift cash, original customer credits and financial
journals are separate preserved facts. Their row counts and sums cannot be
reinterpreted as newly issued native payment receipts. No original personal
IDs, patients, staff or invoice details leave the in-memory query.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import sys

from scripts import qa_original_history_financial_acceptance as finance
from scripts import qa_original_history_supplier_ap_reconciliation as ap
from scripts import qa_v02110_primary_pharmacy_migration as custody


def _money(db: sqlite3.Connection, sql: str) -> tuple[int, int]:
    row = db.execute(sql).fetchone()
    if row is None or type(row[0]) is not int or row[1] is None:
        raise ValueError("Original tender money source incomplete")
    return int(row[0]), round(float(row[1]) * 100)


def _count(db: sqlite3.Connection, sql: str) -> int:
    value = db.execute(sql).fetchone()
    if value is None or type(value[0]) is not int:
        raise ValueError("Original tender source missing")
    return value[0]


def check(db: sqlite3.Connection) -> dict:
    ap.check(db)
    db.execute("PRAGMA query_only=ON")
    totals = {
        "original_completed_cash_sales": _money(db, """
            SELECT COUNT(*),ROUND(SUM(total_amount),2)
            FROM sales_invoices WHERE payment_method='cash' AND status='completed'"""),
        "original_completed_credit_sales": _money(db, """
            SELECT COUNT(*),ROUND(SUM(total_amount),2)
            FROM sales_invoices WHERE payment_method='credit' AND status='completed'"""),
        "original_sales_refunds": _money(db, """
            SELECT COUNT(*),ROUND(SUM(total_refund),2) FROM returns"""),
        "original_cash_movements_marked_receipt": _money(db, """
            SELECT COUNT(*),ROUND(SUM(amount),2)
            FROM cash_movements WHERE type='receipt'"""),
        "original_cash_movements_marked_disbursement": _money(db, """
            SELECT COUNT(*),ROUND(SUM(amount),2)
            FROM cash_movements WHERE type='disbursement'"""),
        "original_cash_movements_marked_supplier_payment": _money(db, """
            SELECT COUNT(*),ROUND(SUM(amount),2)
            FROM cash_movements WHERE source_type='supplier_payment'"""),
        "original_journals": _money(db, """
            SELECT COUNT(*),ROUND(SUM(total_amount),2) FROM daily_journals"""),
    }
    expected = {
        "original_completed_cash_sales": (1398, 11072049),
        "original_completed_credit_sales": (117, 1022730),
        "original_sales_refunds": (67, 435397),
        "original_cash_movements_marked_receipt": (63, 1750769),
        "original_cash_movements_marked_disbursement": (59, 9732914),
        "original_cash_movements_marked_supplier_payment": (6, 2647600),
        "original_journals": (1856, 39725449),
    }
    if totals != expected:
        raise ValueError("Original source tender/cash financial witness changed")
    counts = {
        "original_cash_sale_without_shift": _count(db, """
            SELECT COUNT(*) FROM sales_invoices
            WHERE status='completed' AND payment_method='cash' AND shift_id IS NULL"""),
        "original_return_without_shift": _count(db,
            "SELECT COUNT(*) FROM returns WHERE shift_id IS NULL"),
        "original_shift_discrepancy_status": _count(db,
            "SELECT COUNT(*) FROM shifts WHERE status='discrepancy'"),
        "original_credit_sales_linked_to_patient": _count(db, """
            SELECT COUNT(*) FROM sales_invoices WHERE
            status='completed' AND payment_method='credit' AND patient_id IS NOT NULL"""),
        "original_sale_invoices_with_paid_remaining_both_zero": _count(db, """
            SELECT COUNT(*) FROM sales_invoices
            WHERE paid_amount=0 AND remaining_amount=0"""),
    }
    if counts != {
        "original_cash_sale_without_shift": 533,
        "original_return_without_shift": 14,
        "original_shift_discrepancy_status": 16,
        "original_credit_sales_linked_to_patient": 117,
        "original_sale_invoices_with_paid_remaining_both_zero": 1529,
    }:
        raise ValueError("Original tender/shift/AR witness changed")
    # Earlier v29 original sales can legitimately predate the pharmacy's
    # shared-drawer/shift system. They are NOT missing a cashier-specific
    # assignment, and inventing a link to any later shift would distort the
    # historic source. Verify original timestamp ordering independently.
    first_shared_shift = db.execute(
        "SELECT MIN(datetime(start_time)) FROM shifts"
    ).fetchone()[0]
    if first_shared_shift != "2026-08-13 07:15:45":
        raise ValueError("Original start of pharmacy shift era changed")
    pre_shift = {
        "all_original_sales_without_shift": _count(db, """
            SELECT COUNT(*) FROM sales_invoices WHERE shift_id IS NULL"""),
        "original_cash_sales_without_shift_and_before_first_shift": _count(db, """
            SELECT COUNT(*) FROM sales_invoices
            WHERE shift_id IS NULL AND payment_method='cash' AND status='completed'
              AND datetime(created_at)<(SELECT MIN(datetime(start_time)) FROM shifts)"""),
        "all_original_sales_without_shift_and_before_first_shift": _count(db, """
            SELECT COUNT(*) FROM sales_invoices
            WHERE shift_id IS NULL
              AND datetime(created_at)<(SELECT MIN(datetime(start_time)) FROM shifts)"""),
        "original_returns_without_shift_and_before_first_shift": _count(db, """
            SELECT COUNT(*) FROM returns
            WHERE shift_id IS NULL
              AND datetime(created_at)<(SELECT MIN(datetime(start_time)) FROM shifts)"""),
    }
    if pre_shift != {
        "all_original_sales_without_shift": 575,
        "original_cash_sales_without_shift_and_before_first_shift": 533,
        "all_original_sales_without_shift_and_before_first_shift": 575,
        "original_returns_without_shift_and_before_first_shift": 14,
    }:
        raise ValueError("Original pre-shared-shift historical chronology changed")
    return {
        "status": "ORIGINAL_CASH_TENDER_SOURCE_PRESERVED_NOT_ATTRIBUTED",
        "money_cents_and_rows": {name: {"rows": n, "cents": cents}
                                 for name, (n, cents) in totals.items()},
        "original_unattributed_counts": counts,
        "first_recorded_original_pharmacy_shift_started_at": first_shared_shift,
        "verified_pre_shared_shift_source_census": pre_shift,
        "historical_null_shift_ids_are_before_first_shift_not_missing_employee_assignments": True,
        "historical_shift_ids_retroactively_created": False,
        "source_tender_ledger_and_cash_movements_are_not_interchangeable": True,
        "historical_sales_and_refund_tenders_independently_posted": False,
        "legacy_patient_credit_opening_AR_certified": False,
        "legacy_shift_discrepancies_independently_resolved": False,
        "native_legacy_receipts_inserted": False,
        "production_allowed": False,
    }


def main() -> int:
    try:
        path = custody.disposable_root() / finance.STAGE / finance.NAME
        raw = custody.checked_file(path, finance.PIN)
        with sqlite3.connect(":memory:") as db:
            db.deserialize(raw)
            result = check(db)
        if hashlib.sha256(path.read_bytes()).hexdigest() != finance.PIN:
            raise ValueError("Pinned source changed during tender audit")
        result["sqlx69_original_source_sha256"] = finance.PIN
        result["database_mutations"] = 0
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, sqlite3.Error, OSError, custody.Refused):
        print(json.dumps({"status": "REFUSED_CASH_TENDER_SOURCE_AUDIT"}),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
