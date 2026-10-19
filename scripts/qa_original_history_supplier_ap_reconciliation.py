"""Source-based real-history supplier AP math without invented native receipts.

The original 101 purchases, 9 returns, 20 supplier payments and the persisted
3 supplier balances are independently reconciled on exact pinned SQLx69 RAM
bytes. This certifies INTERNAL legacy ledger arithmetic, never source custody,
actual vendor receipts, modern idempotency or release permission.
"""
from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import sys

from scripts import qa_original_history_payment_linkage as linkage
from scripts import qa_original_history_financial_acceptance as finance
from scripts import qa_v02110_primary_pharmacy_migration as guard


def check(db: sqlite3.Connection) -> dict:
    linkage.check(db)
    db.execute('PRAGMA query_only=ON')
    invoices = list(db.execute('SELECT supplier_id,total_amount FROM purchase_invoices'))
    returns = list(db.execute('SELECT supplier_id,total_amount FROM purchase_returns'))
    ledger = list(db.execute('SELECT supplier_id,type,amount,reference_id FROM supplier_transactions'))
    suppliers = list(db.execute('SELECT id,balance FROM suppliers'))
    if len(invoices) != 101 or len(returns) != 9 or len(ledger) != 130 or len(suppliers) != 3:
        raise ValueError('Original supplier AP row census changed')
    if len({sid for sid, _ in suppliers}) != 3:
        raise ValueError('Original supplier identity is not unique')
    for value in [v for _, v in suppliers] + [v for _, v in invoices] + [v for _, v in returns] + [v for _, _, v, _ in ledger]:
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError('Non-numeric original supplier amount or balance')
    allocated: dict[int, dict[str, float]] = {
        sid: {'invoice': 0.0, 'return': 0.0, 'payment_abs': 0.0}
        for sid, _ in suppliers
    }
    for supplier, amount in invoices:
        if supplier not in allocated:
            raise ValueError('Purchase references unknown original supplier')
        allocated[supplier]['invoice'] += amount
    for supplier, amount in returns:
        if supplier not in allocated:
            raise ValueError('Return references unknown original supplier')
        allocated[supplier]['return'] += amount
    positive_standalone = 0
    negative_invoice_linked = 0
    for supplier, kind, amount, ref in ledger:
        if supplier not in allocated:
            raise ValueError('Supplier transaction references unknown source owner')
        if kind == 'payment':
            # Two real original sign conventions. The reference style agrees
            # with the sign; do not mutate the original signed amount.
            if amount > 0 and isinstance(ref, str) and len(ref) == 21 and ref.startswith('sup-'):
                positive_standalone += 1
            elif amount < 0 and isinstance(ref, str) and len(ref) == 36:
                negative_invoice_linked += 1
            else:
                raise ValueError('Unrecognized original supplier payment reference/sign')
            allocated[supplier]['payment_abs'] += abs(amount)
        elif kind not in ('invoice', 'return'):
            raise ValueError('Unrecognized original supplier financial ledger row')
    if (positive_standalone, negative_invoice_linked) != (9, 11):
        raise ValueError('Original supplier payment reference/sign census changed')
    # Separate matching of ledger invoice/return source and exact numeric values
    # was already validated in linkage.check. Now independently tie terminal AP
    # to the genuine source document totals and all original payment magnitudes.
    differences = []
    for supplier, stored in suppliers:
        totals = allocated[supplier]
        calculated = totals['invoice'] - totals['return'] - totals['payment_abs']
        differences.append(abs(calculated - stored))
    if not all(diff < 0.005 for diff in differences):
        raise ValueError('Historical supplier AP closing balance differs from recorded source')
    observed = {
        'purchase_invoice_rows': len(invoices),
        'purchase_return_rows': len(returns),
        'supplier_ledger_rows': len(ledger),
        'supplier_accounts_balanced': len(suppliers),
        'supplier_payments_standalone_positive_receipt_refs': positive_standalone,
        'supplier_payments_invoice_linked_negative_refs': negative_invoice_linked,
    }
    return {
        'status': 'HISTORICAL_SUPPLIER_AP_INTERNALLY_RECONCILED_EXTERNAL_PROVENANCE_PENDING',
        'source_counts': observed,
        'all_supplier_closing_balance_formulas_match': True,
        'closing_formula': 'original purchases - original returns - absolute original supplier payments',
        'original_source_payment_signs_preserved': True,
        'original_purchase_paid_header_fields_unchanged': True,
        'external_supplier_receipts_independently_certified': False,
        'original_supplier_payment_cash_movements_fully_attributed': False,
        'native_supplier_receipts_retroactively_created': False,
        'original_history_financial_transition_certified': False,
        'production_allowed': False,
    }


def main() -> int:
    try:
        path = guard.disposable_root() / finance.STAGE / finance.NAME
        raw = guard.checked_file(path, finance.PIN)
        with sqlite3.connect(':memory:') as db:
            db.deserialize(raw)
            result = check(db)
        if hashlib.sha256(path.read_bytes()).hexdigest() != finance.PIN:
            raise ValueError('Pinned original derived SQLx69 changed during review')
        result['original_sqlx69_sha256'] = finance.PIN
        result['database_mutations'] = 0
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, sqlite3.Error, OSError, guard.Refused):
        print(json.dumps({'status': 'REFUSED_HISTORICAL_SUPPLIER_AP_RECONCILIATION'}),
              file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
