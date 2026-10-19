"""Owner-only local index of unresolved legacy financial references (no DB writes).

An index is for human reconciliation on the original Windows PC. It is not a
signed statement, authorization, modern native receipt, or installer input.
Never print original document/transaction identifiers to the terminal.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import uuid

from scripts import owner_first_enrollment as custody
from scripts import qa_original_history_financial_acceptance as finance
from scripts import qa_original_history_legacy_source_links as links
from scripts import qa_original_history_supplier_ap_reconciliation as ap
from scripts import qa_original_history_cash_tender_transition as cash_tender
from scripts import qa_v02110_primary_pharmacy_migration as guard


def build_index(db: sqlite3.Connection) -> dict:
    result = links.check(db)
    if result['status'] != 'LEGACY_SOURCE_LINKS_CHECKED_FINANCIAL_ACCEPTANCE_BLOCKED':
        raise ValueError('Source link check is not the expected blocked state')
    ap_result = ap.check(db)
    if (ap_result['status'] !=
            'HISTORICAL_SUPPLIER_AP_INTERNALLY_RECONCILED_EXTERNAL_PROVENANCE_PENDING'):
        raise ValueError('Historical supplier closing balances are not independently reconciled')
    cash_result = cash_tender.check(db)
    if cash_result['status'] != 'ORIGINAL_CASH_TENDER_SOURCE_PRESERVED_NOT_ATTRIBUTED':
        raise ValueError('Historical cash/shift source is not pinned and reviewed')
    if not cash_result['historical_null_shift_ids_are_before_first_shift_not_missing_employee_assignments']:
        raise ValueError('Original pre-shift era is not chronologically verified')
    sales = [{"sale_line_id": row[0], "sale_invoice_id": row[1],
              "master_drug_id": row[2],
              "legacy_inventory_exception_class": (
                  "NEGATIVE_LINE_NO_INVENTORY_BATCH" if row[3] == 1
                  else "REGULAR_LINE_NO_INVENTORY_BATCH"),
              "historical_sale_status": row[4]}
             for row in db.execute("""SELECT x.id,x.invoice_id,x.drug_id,x.is_negative,i.status
                         FROM sales_items x JOIN sales_invoices i ON i.id=x.invoice_id
                         WHERE x.inventory_id IS NULL ORDER BY x.id""")]
    payments = [{"supplier_transaction_id": row[0],
                 "supplier_id": row[1], "standalone_payment_reference": row[2],
                 "internal_supplier_ap_amount_math_reconciled": True,
                 "external_cash_or_supplier_receipt_review_needed": True}
                for row in db.execute("""SELECT t.id,t.supplier_id,t.reference_id
                   FROM supplier_transactions t WHERE t.type='payment'
                   AND NOT EXISTS (SELECT 1 FROM purchase_invoices p
                       WHERE p.id=t.reference_id AND p.supplier_id=t.supplier_id)
                   ORDER BY t.id""")]
    if len(sales) != 8 or len(payments) != 9:
        raise ValueError('Unresolved source-document reference count changed')
    if (sum(item['legacy_inventory_exception_class']=='NEGATIVE_LINE_NO_INVENTORY_BATCH'
            for item in sales) != 7 or
            sum(item['historical_sale_status']=='draft' for item in sales) != 1 or
            not all(isinstance(item['standalone_payment_reference'], str)
                    and item['standalone_payment_reference'].startswith('sup-')
                    and len(item['standalone_payment_reference']) == 21
                    for item in payments)):
        raise ValueError('Original source financial exception classification changed')
    # Private source-document lookup indexes: all 533 unshifted cash invoices
    # and 14 returns PRE-DATE the very first shift. They are valid legacy-era
    # rows, never automatically missing per-employee or shared shift IDs.
    # Their original tender/receipt support is separately owner-reviewable.
    # IDs, source amounts and dates never reach stdout or public reports.
    cash_sales_without_shift = [
        {'sale_invoice_id': id_, 'original_total_amount': amount, 'source_created_at': created}
        for id_, amount, created in db.execute("""
            SELECT id,total_amount,created_at FROM sales_invoices
            WHERE payment_method='cash' AND status='completed' AND shift_id IS NULL
            ORDER BY id""")]
    sale_returns_without_shift = [
        {'return_id': id_, 'original_sale_invoice_id': parent,
         'original_refund_amount': amount, 'source_created_at': created}
        for id_, parent, amount, created in db.execute("""
            SELECT id,invoice_id,total_refund,created_at FROM returns
            WHERE shift_id IS NULL ORDER BY id""")]
    discrepancy_shifts = [
        {'shift_id': id_, 'original_starting_cash': opening,
         'original_ending_cash': closing, 'original_actual_cash': actual,
         'original_cash_difference': difference}
        for id_, opening, closing, actual, difference in db.execute("""
            SELECT id,starting_cash,ending_cash,actual_cash,cash_difference
            FROM shifts WHERE status='discrepancy' ORDER BY id""")]
    if (len(cash_sales_without_shift), len(sale_returns_without_shift),
            len(discrepancy_shifts)) != (533, 14, 16):
        raise ValueError('Original cash/shift reconciliation reference counts changed')
    return {
        "format": "pharma.legacy-financial-private-review-index.v3",
        "original_source_sqlx69_sha256": finance.PIN,
        "context": "Original v29 historical business rows were typed-preserved and normalized only in detached QA",
        "sale_lines_missing_inventory_id": sales,
        "supplier_payments_with_standalone_generated_references": payments,
        "original_cash_sales_without_shift_private_owner_review": cash_sales_without_shift,
        "original_sale_returns_without_shift_private_owner_review": sale_returns_without_shift,
        "original_shift_discrepancies_private_owner_review": discrepancy_shifts,
        "shared_pharmacy_shift_is_single_drawer_not_per_cashier": True,
        "original_pre_shift_era_census_verified": cash_result['verified_pre_shared_shift_source_census'],
        "unshifted_legacy_sales_or_refunds_require_shift_id_repair": False,
        "all_three_historical_supplier_ap_balances_internal_math_reconciled": True,
        "all_49_patient_payment_cash_date_amount_groups_match": True,
        "two_positive_patient_wallet_balances_match_cash_amount_multiset": True,
        "owner_source_evidence_review_status": "PENDING_EXTERNAL_ORIGINAL_DOCUMENT_RECONCILIATION",
        "review_steps": [
            "Seven no-inventory sale items were marked negative and completed; one was a draft. Inspect original negative-sale workflow and lot/COGS evidence; do not synthesize IDs.",
            "Nine standalone supplier payment references are lower-case sup- prefixed receipt codes, not ordinary invoice IDs. Independently verify external vendor/cash support even though all three supplier AP balances reconcile exactly.",
            "Reconcile historical sales tender and receivables, because every preserved invoice has zero paid_amount and remaining_amount; do not infer these are settled.",
            "Corroborate matching historical patient cash/date/amount and wallet summaries against the patient's credit/AR opening balance and source-document journals.",
            "The 533 original unshifted cash invoices and 14 original unshifted sale returns ALL predate the first recorded shift. They are the legitimate pre-shared-shift historical era, not missing employee shifts. Keep their original null shift_id; review tender only when reconciling financial opening balances.",
            "Review 16 original discrepancy shifts using original opening, expected/ending, actual and difference amounts; resolve only with authentic drawer or paper records. Do not turn these historical exceptions into synthesized journal entries.",
            "After documented independent review, update acceptance policy/tests; never fabricate legacy native immutable receipt rows.",
        ],
        "owner_authorized_production_migration": False,
        "legacy_financial_certified": False,
        "database_mutations": 0,
    }


def main() -> int:
    try:
        custody._require_windows()
        root = guard.disposable_root()
        path = root / finance.STAGE / finance.NAME
        source, source_fingerprint = custody._capture(path, finance.PIN, root)
        with sqlite3.connect(':memory:') as db:
            db.deserialize(source)
            db.execute('PRAGMA query_only=ON')
            document = build_index(db)
        custody._unchanged(path, finance.PIN, source_fingerprint, root)
        # A disposable local review index is not an independent enrollment
        # declaration, and MUST NOT reside in live PHARMA application profile.
        target = root / ('pharma-legacy-private-financial-review-' + uuid.uuid4().hex)
        if not root.is_dir() or target.exists() or target.is_symlink():
            raise ValueError('Private QA review directory is not exclusive')
        custody._no_reparse(root)
        target.mkdir(mode=0o700)
        custody._private_acl(target)
        content = (json.dumps(document, ensure_ascii=True, sort_keys=True,
                              indent=2, allow_nan=False) + '\n').encode('utf-8')
        out = target / 'OWNER_ONLY_LEGACY_FINANCIAL_REVIEW.json'
        custody._exclusive_file(out, content)
        # The only terminal output is metadata, never document identifiers.
        print(json.dumps({"status": "CREATED_LOCAL_OWNER_ONLY_RECONCILIATION_INDEX_NOT_AUTHORIZATION",
                          "path": str(out), "file_sha256": hashlib.sha256(content).hexdigest(),
                          "sale_lines_needing_lot_review": 8,
                          "supplier_payments_needing_allocation_review": 9,
                          "verified_original_pre_shift_cash_sales": 533,
                          "verified_original_pre_shift_sale_returns": 14,
                          "discrepancy_shifts_needing_source_review": 16,
                          "production_allowed": False}, sort_keys=True))
        return 0
    except (ValueError, sqlite3.Error, OSError, guard.Refused, custody.Refused) as exc:
        # Avoid outputting sensitive content from SQLite or filesystem errors.
        print(json.dumps({"status": "REFUSED_PRIVATE_FINANCIAL_REVIEW_INDEX",
                          "reason": type(exc).__name__}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
