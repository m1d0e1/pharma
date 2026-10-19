"""Read-only audit of *separate* disposable Windows pharmacy QA histories.

These profiles were created by different independent QA transactions. Do not
merge their ledgers or reinterpret their `local_default` rows as a new tenant.
All reported money is integer cents, and every opened connection is query-only.
"""
from __future__ import annotations

from contextlib import closing
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
import os
from pathlib import Path
import sqlite3


SOURCE_SHA = "8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3"


def cents(value: object) -> int:
    return int((Decimal(str(value or 0)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def readonly(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise RuntimeError(f"Missing QA database: {path.name}")
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.execute("PRAGMA query_only=ON")
    if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise RuntimeError("QA database integrity failure")
    if conn.execute("PRAGMA foreign_key_check").fetchall():
        raise RuntimeError("QA database foreign-key violations")
    return conn


def balanced_journals(db: sqlite3.Connection) -> tuple[int, int]:
    rows = db.execute("""
        SELECT j.id,
               SUM(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END),
               SUM(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END)
          FROM daily_journals j
          LEFT JOIN journal_entries e ON e.journal_id=j.id
         GROUP BY j.id
    """).fetchall()
    for journal_id, debit, credit in rows:
        if cents(debit) != cents(credit):
            raise AssertionError(f"Unbalanced journal {journal_id}")
    return len(rows), sum(cents(row[1]) for row in rows)


def purchase_case(db: sqlite3.Connection) -> dict:
    rows = db.execute("""
        SELECT i.id,i.total_amount,i.supplier_id,i.pharmacy_id,s.balance
          FROM purchase_invoices i JOIN suppliers s ON s.id=i.supplier_id
    """).fetchall()
    if len(rows) != 1:
        raise AssertionError(f"Expected one pinned synthetic purchase, got {len(rows)}")
    invoice_id, amount, supplier, tenant, balance = rows[0]
    if tenant != "local_default":
        raise AssertionError("Historical tenant provenance has changed")
    items = db.execute("SELECT quantity,cost_price FROM purchase_invoice_items WHERE invoice_id=?", (invoice_id,)).fetchall()
    line_cents = sum(cents(Decimal(str(qty)) * Decimal(str(cost))) for qty, cost in items)
    ledger = db.execute("SELECT type,amount FROM supplier_transactions WHERE supplier_id=?", (supplier,)).fetchall()
    invoices = sum(cents(v) for typ, v in ledger if typ == "invoice")
    payments = sum(cents(v) for typ, v in ledger if typ == "payment")
    invoice_cents = cents(amount)
    if (invoice_cents, line_cents, invoices, payments, cents(balance)) != (35000, 35000, 35000, 5600, 29400):
        raise AssertionError("Pinned purchase, supplier ledger or payable no longer reconciles")
    receipt_count = db.execute("SELECT COUNT(*) FROM native_supplier_payment_receipts").fetchone()[0]
    lot_qty = db.execute("SELECT COALESCE(SUM(quantity),0) FROM inventory WHERE pharmacy_id=?", (tenant,)).fetchone()[0]
    if receipt_count != 3 or lot_qty != 10:
        raise AssertionError("Supplier payment receipts or received lot quantity changed")
    journals, journal_debits = balanced_journals(db)
    return {
        "independently_certified_tenant": False,
        "historical_scope": "local_default (not ownership-certified)",
        "purchase_count": 1,
        "invoice_cents": invoice_cents,
        "line_cents": line_cents,
        "supplier_payment_cents": payments,
        "supplier_outstanding_cents": cents(balance),
        "supplier_payment_receipts": receipt_count,
        "received_stock_units": lot_qty,
        "balanced_journal_count": journals,
        "journal_debits_cents": journal_debits,
    }


def sales_case(db: sqlite3.Connection) -> dict:
    invoices = db.execute("""
        SELECT id,total_amount,pharmacy_id FROM sales_invoices ORDER BY id
    """).fetchall()
    if len(invoices) != 7:
        raise AssertionError(f"Expected seven isolated synthetic sales, got {len(invoices)}")
    total = 0
    total_lines = 0
    for invoice_id, amount, tenant in invoices:
        if tenant != "local_default":
            raise AssertionError("Historical synthetic sale tenant was rewritten")
        lines = db.execute("SELECT quantity_sold,unit_price,item_discount_percent FROM sales_items WHERE invoice_id=?", (invoice_id,)).fetchall()
        gross = sum(cents(Decimal(str(qty)) * Decimal(str(price))) for qty, price, _ in lines)
        discount = sum(cents(Decimal(str(qty)) * Decimal(str(price)) * Decimal(str(percent or 0)) / Decimal(100)) for qty, price, percent in lines)
        if gross - discount != cents(amount):
            raise AssertionError(f"Sales header/items mismatch: {invoice_id}")
        total += cents(amount)
        total_lines += len(lines)
    if (total, total_lines) != (36000, 7):
        raise AssertionError("Pinned sales history or arithmetic changed")
    cogs_rows = db.execute("""
        SELECT p.sale_id,p.sale_micros,p.cogs_micros,p.pharmacy_id,
               s.total_amount
          FROM native_sale_cogs_provenance p
          JOIN sales_invoices s ON s.id=p.sale_id
    """).fetchall()
    posted_cogs = 0
    for invoice_id, sale_micros, cogs_micros, scope, amount in cogs_rows:
        if scope != "local_default" or sale_micros != cents(amount) * 10000:
            raise AssertionError(f"Sale provenance does not match source invoice {invoice_id}")
        expected = sum(
            cents(Decimal(str(q)) * Decimal(str(cost)))
            for q, cost in db.execute("SELECT quantity_sold,cost_price FROM sales_items WHERE invoice_id=?", (invoice_id,))
        )
        if cogs_micros != expected * 10000:
            raise AssertionError(f"COGS provenance does not match source sale item {invoice_id}")
        posted_cogs += expected
    if len(cogs_rows) != 7 or posted_cogs != 1000:
        raise AssertionError("Pinned positive cost sale or provenance unexpectedly changed")
    refunds = db.execute("""
        SELECT r.id,r.invoice_id,r.total_refund,r.refund_method,r.status,
               r.pharmacy_id,p.refund_micros,p.cogs_micros,p.journal_id
          FROM returns r
          JOIN native_sale_return_cogs_provenance p ON p.return_id=r.id
    """).fetchall()
    refund_cents = 0
    methods: set[str] = set()
    for return_id, invoice_id, refund, method, status, scope, micros, cogs_micros, journal_id in refunds:
        if (scope, status) != ("local_default", "approved") or not journal_id:
            raise AssertionError("Return provenance status or pharmacy invalid")
        items = db.execute("""
            SELECT ri.quantity_returned,ri.unit_price,ri.total_price,si.invoice_id
              FROM return_items ri JOIN sales_items si ON si.id=ri.sale_item_id
             WHERE ri.return_id=?
        """, (return_id,)).fetchall()
        line_total = sum(cents(total_price) for _, _, total_price, _ in items)
        if not items or any(source_invoice != invoice_id for _, _, _, source_invoice in items):
            raise AssertionError("Return lines not linked to their original sales invoice")
        if line_total != cents(refund) or int(micros) != cents(refund) * 10000:
            raise AssertionError("Refund receipt, native provenance and line total disagree")
        if cogs_micros != 0:
            raise AssertionError("This pinned no-cost QA return must not invent COGS")
        refund_cents += line_total
        methods.add(method)
    if len(refunds) != 3 or refund_cents != 7200 or methods != {"cash", "bank", "wallet"}:
        raise AssertionError("Pinned source-linked QA refunds changed")

    delivery = db.execute("""
        SELECT d.sale_cents,d.fee_cents,d.total_cents,s.total_amount,s.payment_method,
               s.pharmacy_id
          FROM native_delivery_collection_receipts d
          JOIN sales_invoices s ON s.id=d.sale_id
    """).fetchall()
    if delivery != [(19200, 300, 19500, 192.0, "delivery", "local_default")]:
        raise AssertionError("Delivery sale plus fee collection no longer reconciles")
    wallet = db.execute("SELECT wallet_balance FROM patients").fetchall()
    wallet_topups = db.execute("SELECT amount_cents,pharmacy_id FROM native_patient_wallet_topup_receipts").fetchall()
    wallet_spend = db.execute("SELECT COALESCE(SUM(total_amount),0) FROM sales_invoices WHERE payment_method='wallet'").fetchone()[0]
    wallet_refunds = db.execute("SELECT COALESCE(SUM(total_refund),0) FROM returns WHERE refund_method='wallet' AND status='approved'").fetchone()[0]
    if len(wallet) != 1 or wallet_topups != [(2400, "local_default")]:
        raise AssertionError("QA patient wallet source receipt identity changed")
    expected_wallet = 2400 - cents(wallet_spend) + cents(wallet_refunds)
    if expected_wallet != cents(wallet[0][0]) or expected_wallet != 2400:
        raise AssertionError("Patient wallet topup, sale, refund and balance do not conserve")
    journals, journal_debits = balanced_journals(db)
    lots = db.execute("SELECT quantity FROM inventory WHERE pharmacy_id='local_default'").fetchall()
    if (len(lots), sum(row[0] for row in lots), journals) != (3, 3, 15):
        raise AssertionError("Sales lot inventory or journal history changed")
    return {
        "independently_certified_tenant": False,
        "historical_scope": "local_default (not ownership-certified)",
        "sales_count": len(invoices),
        "sales_lines": total_lines,
        "sales_header_and_line_cents": total,
        "sale_source_provenance_count": len(cogs_rows),
        "posted_cogs_cents": posted_cogs,
        "approved_refund_count": len(refunds),
        "approved_refund_cents": refund_cents,
        "approved_refund_methods": sorted(methods),
        "delivery_sale_cents": delivery[0][0],
        "delivery_fee_cents": delivery[0][1],
        "delivery_collected_cents": delivery[0][2],
        "wallet_topup_cents": wallet_topups[0][0],
        "wallet_sale_cents": cents(wallet_spend),
        "wallet_refund_cents": cents(wallet_refunds),
        "wallet_ending_balance_cents": cents(wallet[0][0]),
        "stock_lot_count": len(lots),
        "remaining_stock_units": sum(row[0] for row in lots),
        "balanced_journal_count": journals,
        "journal_debits_cents": journal_debits,
    }


def main() -> None:
    if os.name != "nt":
        raise RuntimeError("This script targets the explicitly identified Windows QA AppData")
    original = Path(__file__).resolve().parents[1] / "src-tauri" / "pharma_local.db"
    source_digest = hashlib.sha256(original.read_bytes()).hexdigest()
    if source_digest != SOURCE_SHA:
        raise RuntimeError("Protected repository source DB hash changed; do not proceed")
    appdata = Path(os.environ["APPDATA"])
    bg = appdata / "com.pharma.disposable.qa20261014bg" / "pharma_local.db"
    ui = appdata / "com.pharma.disposable.qa20261015renewable" / "pharma_local.db"
    with closing(readonly(bg)) as bg_db, closing(readonly(ui)) as ui_db:
        result = {
            "audit": "independent_disposable_qa_profiles_read_only",
            "purchase_supplier_profile": purchase_case(bg_db),
            "sales_inventory_profile": sales_case(ui_db),
            "combined_or_reassigned_legacy_ownership": False,
            "protected_source_sha256_unchanged": source_digest.upper(),
        }
    print(json.dumps(result, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
