"""Read-only cents-based custody and receipt assertions for disposable lifecycle QA.

No database is created or written. Run only after the five guarded GUI postings;
this deliberately does not certify historical/unowned rows or all application routes.
"""
from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
import hashlib
import json
import os
from pathlib import Path
import sqlite3


TENANT = "qa_lifecycle_20261016"
ACTOR = "qa_lifecycle_owner_20261016"
IDENTITY = "com.pharma.disposable.lifecycle.qa20261016"
PURCHASE = "2efd9b8e-19bf-48cc-8bdf-c9ee723d1460"
SALE = "3726c3df-c9cf-4e32-835a-848d045e69aa"
RETURN = "4ad81d46-1cf1-4145-90da-9faff32a3299"
PAYMENT = "adb55eed-455b-46f6-8f2e-4b6972ccfd1e"
PURCHASE_RETURN = "dfeff7a8-e319-4cfe-922b-d6b56db5419e"
PATIENT = "89c5f6bb-8027-425d-b983-70c4b67aeea3"
LOT = "81340a25-8056-4628-909c-54091f775921"
ORIGINAL_SHA256 = "8ED7A0AA73B636BB95B29B03EECBB218E2E672C7DDD5EF577F2F50F4EB9E18C3"


def cents(value: object) -> int:
    assert value is not None, "Financial value is missing, not zero"
    return int((Decimal(str(value)) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def exactly_one(conn: sqlite3.Connection, query: str, params: tuple[object, ...]) -> tuple:
    rows = conn.execute(query, params).fetchall()
    assert len(rows) == 1, f"Expected one immutable QA record; found {len(rows)}"
    return rows[0]


def main() -> None:
    appdata = os.environ.get("APPDATA")
    assert appdata, "APPDATA must identify an explicit disposable Windows profile"
    original = Path(__file__).resolve().parents[1] / "src-tauri" / "pharma_local.db"
    assert original.is_file(), "Original repository database not found"
    assert hashlib.sha256(original.read_bytes()).hexdigest().upper() == ORIGINAL_SHA256, (
        "Original repository pharmacy database SHA-256 changed"
    )
    database = (Path(appdata) / IDENTITY / "pharma_local.db").resolve(strict=True)
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as conn:
        conn.execute("PRAGMA query_only=ON")
        assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        assert not conn.execute("PRAGMA foreign_key_check").fetchall()
        assert conn.execute("SELECT COUNT(*) FROM _sqlx_migrations WHERE success=1").fetchone()[0] == 63

        purchase = exactly_one(conn, "SELECT pharmacy_id,payment_method,total_amount FROM purchase_invoices WHERE id=?", (PURCHASE,))
        assert purchase[:2] == (TENANT, "credit") and cents(purchase[2]) == 46200
        sale = exactly_one(conn, "SELECT pharmacy_id,payment_method,total_amount,paid_amount,status FROM sales_invoices WHERE id=?", (SALE,))
        assert sale[:2] == (TENANT, "cash") and sale[4] == "completed"
        assert cents(sale[2]) == cents(sale[3]) == 30000

        sale_receipt = exactly_one(conn, "SELECT actor_id,sale_micros,cogs_micros FROM native_sale_cogs_provenance WHERE sale_id=? AND pharmacy_id=?", (SALE, TENANT))
        assert sale_receipt == (ACTOR, 300000000, 231000000)
        sales_return = exactly_one(conn, "SELECT actor_id,refund_micros,cogs_micros,journal_id FROM native_sale_return_cogs_provenance WHERE return_id=? AND sale_id=? AND pharmacy_id=?", (RETURN, SALE, TENANT))
        assert sales_return[:3] == (ACTOR, 150000000, 115500000)
        payment = exactly_one(conn, "SELECT actor_id,amount_cents,payment_method,balance_before_cents,balance_after_cents,journal_id FROM native_supplier_payment_receipts WHERE id=? AND invoice_id=? AND pharmacy_id=?", (PAYMENT, PURCHASE, TENANT))
        assert payment[:5] == (ACTOR, 2500, "bank", 46200, 43700)
        purchase_return = exactly_one(conn, "SELECT actor_id,amount_cents,refund_method,line_count,journal_id FROM native_purchase_return_provenance WHERE return_id=? AND purchase_invoice_id=? AND pharmacy_id=?", (PURCHASE_RETURN, PURCHASE, TENANT))
        assert purchase_return[:4] == (ACTOR, 11550, "credit", 1)
        lot = exactly_one(conn, "SELECT pharmacy_id,quantity,cost_price,expiry_date FROM inventory WHERE id=?", (LOT,))
        assert lot[0] == TENANT and lot[1] == 2 and cents(lot[2]) == 11550 and lot[3] == "2028-10-17"
        assert cents(exactly_one(conn, "SELECT balance FROM suppliers WHERE id=1", ())[0]) == 32150
        patient = exactly_one(conn, "SELECT points_balance,wallet_balance FROM patients WHERE id=?", (PATIENT,))
        assert patient == (150.0, 0.0)

        journals = conn.execute("SELECT id,total_amount FROM daily_journals WHERE pharmacy_id=?", (TENANT,)).fetchall()
        assert len(journals) == 5
        posted_ids = {j[0] for j in journals}
        assert sales_return[3] in posted_ids and payment[5] in posted_ids and purchase_return[4] in posted_ids
        debit = credit = 0
        for journal_id, journal_total in journals:
            entries = conn.execute("SELECT type,amount FROM journal_entries WHERE journal_id=?", (journal_id,)).fetchall()
            left = sum(cents(amount) for kind, amount in entries if kind == "debit")
            right = sum(cents(amount) for kind, amount in entries if kind == "credit")
            assert left == right == cents(journal_total), f"Unbalanced owned journal: {journal_id}"
            debit += left
            credit += right
        assert debit == credit == 139900
        assert exactly_one(conn, "SELECT COUNT(*) FROM sales_invoices WHERE pharmacy_id='local_default'", ())[0] == 7

        result = {
            "disposable_qa_only": True,
            "original_repository_db_sha256_preserved": True,
            "sqlite_integrity_and_foreign_keys": "PASS",
            "owned_posted_journals": len(journals),
            "total_debit_cents": debit,
            "total_credit_cents": credit,
            "net_sale_revenue_cents": 15000,
            "net_sale_cogs_cents": 11550,
            "gross_profit_cents": 3450,
            "supplier_payable_cents": 32150,
            "remaining_stock_units": lot[1],
            "patient_loyalty_points": patient[0],
            "legacy_local_default_sales_still": 7,
            "full_application_certified": False,
        }
        print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
