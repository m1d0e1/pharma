"""Aggregate-only legacy financial link audit on the pinned *detached* SQLx69 history.

Original documents are not native 042+ posting receipts. A passing source-link
check is expressly NOT owner authentication, payment allocation, or a release.
No patient/person identifiers or row-level amounts are emitted.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import sys

from scripts import qa_original_history_financial_acceptance as finance
from scripts import qa_v02110_primary_pharmacy_migration as guard


def one(db: sqlite3.Connection, statement: str) -> int:
    return int(db.execute(statement).fetchone()[0])


def check(db: sqlite3.Connection) -> dict:
    # Separate preservation checks precede all legacy link interpretation.
    finance.check(db)
    db.execute("PRAGMA query_only=ON")
    counts = {
        "purchase_invoice_supplier_ledger_exact_amount": one(db, """
            SELECT COUNT(*) FROM supplier_transactions t
            JOIN purchase_invoices i ON i.id=t.reference_id
            WHERE t.type='invoice' AND t.supplier_id=i.supplier_id
              AND typeof(t.amount) IN ('integer','real')
              AND typeof(i.total_amount) IN ('integer','real')
              AND ABS(t.amount-i.total_amount)<0.011"""),
        "purchase_invoice_ledger_rows": one(db,
            "SELECT COUNT(*) FROM supplier_transactions WHERE type='invoice'"),
        "purchase_invoice_ledger_unique_refs": one(db,
            "SELECT COUNT(DISTINCT reference_id) FROM supplier_transactions WHERE type='invoice'"),
        "purchase_invoice_items_linked": one(db, """
            SELECT COUNT(*) FROM purchase_invoice_items x
            JOIN purchase_invoices i ON i.id=x.invoice_id"""),
        "purchase_invoices_with_items": one(db, """
            SELECT COUNT(*) FROM purchase_invoices i WHERE EXISTS
            (SELECT 1 FROM purchase_invoice_items x WHERE x.invoice_id=i.id)"""),
        "purchase_return_supplier_ledger_exact_amount": one(db, """
            SELECT COUNT(*) FROM supplier_transactions t
            JOIN purchase_returns r ON r.id=t.reference_id
            JOIN purchase_invoices i ON i.id=r.purchase_invoice_id
            WHERE t.type='return' AND t.supplier_id=r.supplier_id
              AND r.supplier_id=i.supplier_id
              AND typeof(t.amount) IN ('real','integer')
              AND typeof(r.total_amount) IN ('real','integer')
              AND ABS(t.amount-r.total_amount)<0.011"""),
        "purchase_return_ledger_rows": one(db,
            "SELECT COUNT(*) FROM supplier_transactions WHERE type='return'"),
        "purchase_return_ledger_unique_refs": one(db,
            "SELECT COUNT(DISTINCT reference_id) FROM supplier_transactions WHERE type='return'"),
        "purchase_return_items_linked": one(db, """
            SELECT COUNT(*) FROM purchase_return_items x
            JOIN purchase_returns r ON r.id=x.purchase_return_id
            JOIN purchase_invoice_items p ON p.id=x.purchase_invoice_item_id
            WHERE p.invoice_id=r.purchase_invoice_id"""),
        "sale_items_with_invoice_inventory_and_recorded_cost": one(db, """
            SELECT COUNT(*) FROM sales_items x
            JOIN sales_invoices i ON i.id=x.invoice_id
            JOIN inventory v ON v.id=x.inventory_id
            WHERE typeof(x.cost_price) IN ('real','integer')"""),
        "sale_items_with_null_inventory_id": one(db,
            "SELECT COUNT(*) FROM sales_items WHERE inventory_id IS NULL"),
        "sale_items_without_inventory_but_with_master_drug": one(db, """
            SELECT COUNT(*) FROM sales_items x JOIN master_drugs m ON m.id=x.drug_id
            WHERE x.inventory_id IS NULL AND typeof(x.cost_price) IN ('real','integer')"""),
        "sales_invoices_with_items": one(db, """
            SELECT COUNT(*) FROM sales_invoices i WHERE EXISTS
            (SELECT 1 FROM sales_items x WHERE x.invoice_id=i.id)"""),
        "sale_return_lines_linked_to_same_invoice": one(db, """
            SELECT COUNT(*) FROM return_items x JOIN returns r ON r.id=x.return_id
            JOIN sales_items s ON s.id=x.sale_item_id
            WHERE s.invoice_id=r.invoice_id"""),
        "sale_returns_with_items": one(db, """
            SELECT COUNT(*) FROM returns r WHERE EXISTS
            (SELECT 1 FROM return_items x WHERE x.return_id=r.id)"""),
        "journal_headers_equal_debit_sum": one(db, """
            SELECT COUNT(*) FROM daily_journals j WHERE
            typeof(j.total_amount) IN ('real','integer') AND
            ABS(j.total_amount-(SELECT SUM(e.amount) FROM journal_entries e
               WHERE e.journal_id=j.id AND e.type='debit'))<0.011"""),
        "cash_movements_with_valid_shift_or_no_shift": one(db, """
            SELECT COUNT(*) FROM cash_movements m WHERE m.shift_id IS NULL
            OR EXISTS (SELECT 1 FROM shifts s WHERE s.id=m.shift_id)"""),
        "patient_transactions_with_patient": one(db, """
            SELECT COUNT(*) FROM patient_transactions t JOIN patients p ON p.id=t.patient_id"""),
        "supplier_payment_ledger_rows": one(db,
            "SELECT COUNT(*) FROM supplier_transactions WHERE type='payment'"),
        "supplier_payment_refs_matching_purchase_and_supplier": one(db, """
            SELECT COUNT(*) FROM supplier_transactions t
            JOIN purchase_invoices i ON i.id=t.reference_id
            WHERE t.type='payment' AND t.supplier_id=i.supplier_id"""),
        "sales_with_zero_paid_and_remaining": one(db, """
            SELECT COUNT(*) FROM sales_invoices
            WHERE paid_amount=0 AND remaining_amount=0"""),
        "sales_invoice_draft_count": one(db,
            "SELECT COUNT(*) FROM sales_invoices WHERE status='draft'"),
    }
    # This is a pinned corpus-specific *refusal* baseline. Differences are an
    # altered/ambiguous artifact, not justification to repair historical rows.
    expected = {
        "purchase_invoice_supplier_ledger_exact_amount": 101,
        "purchase_invoice_ledger_rows": 101,
        "purchase_invoice_ledger_unique_refs": 101,
        "purchase_invoice_items_linked": 766,
        "purchase_invoices_with_items": 101,
        "purchase_return_supplier_ledger_exact_amount": 9,
        "purchase_return_ledger_rows": 9,
        "purchase_return_ledger_unique_refs": 9,
        "purchase_return_items_linked": 11,
        "sale_items_with_invoice_inventory_and_recorded_cost": 2298,
        "sale_items_with_null_inventory_id": 8,
        "sale_items_without_inventory_but_with_master_drug": 8,
        "sales_invoices_with_items": 1529,
        "sale_return_lines_linked_to_same_invoice": 86,
        "sale_returns_with_items": 67,
        "journal_headers_equal_debit_sum": 1856,
        "cash_movements_with_valid_shift_or_no_shift": 122,
        "patient_transactions_with_patient": 87,
        "supplier_payment_ledger_rows": 20,
        "supplier_payment_refs_matching_purchase_and_supplier": 11,
        "sales_with_zero_paid_and_remaining": 1529,
        "sales_invoice_draft_count": 1,
    }
    if counts != expected:
        raise ValueError("Original legacy financial link counts deviate from pinned baseline")
    return {
        "status": "LEGACY_SOURCE_LINKS_CHECKED_FINANCIAL_ACCEPTANCE_BLOCKED",
        "source_link_counts": counts,
        "supplier_payment_rows_without_matching_purchase_invoice_reference": 9,
        "sale_lines_without_inventory_lot_reference": 8,
        "historical_sale_paid_remaining_fields_zero": True,
        "sale_payment_attribution_certified": False,
        "supplier_payment_allocation_certified": False,
        "historical_journal_to_source_document_provenance_certified": False,
        "native_cogs_receipts_exist_for_original_history": False,
        "original_historical_financial_writers_authorized": False,
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
            raise ValueError("Detached historical source changed during aggregate-only inspection")
        result["source_sha256"] = finance.PIN
        result["database_mutations"] = 0
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, sqlite3.Error, OSError, guard.Refused) as exc:
        print(json.dumps({"status": "REFUSED_LEGACY_SOURCE_LINKS",
                          "reason": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
