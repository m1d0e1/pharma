"""Independent read-only native SQLite proof for the v69 signed synthetic GUI costed purchase.

This is deliberately a *milestone* verifier: it requires the exact single
costed EGP 8 purchase before subsequent supplier settlement/POS writes. It
neither invokes financial IPC nor opens the protected installed DB in SQLite.
The real original-history owner/commercial acceptance remains blocked.
"""

from __future__ import annotations

from contextlib import closing
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

from scripts import qa_v02110_v69_signed_synthetic_fixture as fixture
from scripts import qa_v02110_v69_signed_synthetic_gui_gate as gate


INVOICE_NUMBER = "QA-V69-COST-CREDIT-20261018-001"
BARCODE = "QA069COST20261018"
UUID = re.compile(r"^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$")
CUSTOMER_SHA = "4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197"


def exactly_one(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> sqlite3.Row:
    rows = conn.execute(sql, params).fetchmany(2)
    if len(rows) != 1:
        raise RuntimeError("Expected exactly one independently verified immutable source row")
    return rows[0]


def cents(amount: object) -> int:
    if amount is None:
        raise RuntimeError("Missing monetary value")
    value = Decimal(str(amount)) * 100
    if not value.is_finite() or value != value.to_integral_value():
        raise RuntimeError("Non-cent-exact monetary source")
    return int(value)


def run(pid: int) -> dict:
    if pid <= 4 or pid == 25528:
        raise RuntimeError("Expected exclusive new signed synthetic GUI PID")
    signed_exe, manifest = gate.exact_binary()
    gate.configure_readonly_gate()
    status = gate.tested_gui.read_status(pid)
    if status["valid"] is not True or status["ready"] is not True or status["blocked"] is not False:
        raise RuntimeError("Current native QA GUI lacks an authenticated startup license")

    source = Path(os.environ["APPDATA"]) / fixture.IDENTITY / "pharma_local.db"
    if not source.is_file() or source.is_symlink():
        raise RuntimeError("Dedicated synthetic SQLite profile absent")
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        if conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Signed synthetic QA integrity failure")
        if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise RuntimeError("Signed synthetic QA foreign key failure")
        migrations = exactly_one(conn, "SELECT count(*) AS n, max(version) AS v FROM _sqlx_migrations WHERE success=1")
        if (migrations["n"], migrations["v"]) != (69, 69):
            raise RuntimeError("Native SQLx 069 not installed")
        sql = (Path(__file__).resolve().parents[1] / "src-tauri/migrations/069_supplier_return_aware_payment_guard.sql").read_bytes()
        checksum = exactly_one(conn, "SELECT checksum FROM _sqlx_migrations WHERE version=69 AND success=1")
        if bytes(checksum["checksum"]) != hashlib.sha384(sql).digest():
            raise RuntimeError("Registered native migration 069 checksum changed")

        principal = exactly_one(conn, "SELECT id,role,pharmacy_id FROM users WHERE is_active=1")
        if tuple(principal) != (fixture.ACTOR, "owner", fixture.TENANT):
            raise RuntimeError("Incorrect native QA user or tenant")
        supplier = exactly_one(conn, "SELECT * FROM suppliers")
        if supplier["id"] != 1 or supplier["name_ar"] != "QA V69 Connected Supplier 20261018" or cents(supplier["balance"]) != 800:
            raise RuntimeError("Supplier payable differs from original costed purchase")
        owner = exactly_one(conn, "SELECT * FROM native_supplier_directory_ownership")
        if (owner["supplier_id"], owner["actor_id"], owner["pharmacy_id"]) != (1, fixture.ACTOR, fixture.TENANT):
            raise RuntimeError("Native supplier ownership receipt missing")
        drug = exactly_one(conn, "SELECT * FROM master_drugs")
        if (drug["id"], drug["barcode"], cents(drug["official_price"]), drug["has_expiry"]) != (1, BARCODE, 500, 1):
            raise RuntimeError("Native catalog entry differs")
        drug_receipt = exactly_one(conn, "SELECT * FROM native_master_drug_create_receipts")
        if (drug_receipt["drug_id"], drug_receipt["actor_id"], drug_receipt["pharmacy_id"]) != (1, fixture.ACTOR, fixture.TENANT):
            raise RuntimeError("Native master catalog creation receipt missing")

        invoice = exactly_one(conn, "SELECT * FROM purchase_invoices")
        invoice_id = invoice["id"]
        if not UUID.fullmatch(invoice_id) or (
            invoice["invoice_number"], invoice["supplier_id"], invoice["pharmacy_id"], invoice["user_id"],
            invoice["invoice_date"], invoice["payment_method"], invoice["status"],
            cents(invoice["total_amount"]), cents(invoice["paid_amount"])
        ) != (INVOICE_NUMBER, 1, fixture.TENANT, fixture.ACTOR, "2026-10-18", "credit", "completed", 800, 0):
            raise RuntimeError("Exact native source-bound credit purchase mismatch")
        line = exactly_one(conn, "SELECT * FROM purchase_invoice_items")
        lot = exactly_one(conn, "SELECT * FROM inventory")
        if (
            line["invoice_id"], line["drug_id"], line["quantity"], line["bonus_quantity"],
            cents(line["cost_price"]), cents(line["selling_price"]), line["expiry_date"],
            line["inventory_id"], line["barcode"]
        ) != (invoice_id, 1, 4, 0, 200, 500, "2028-12-31", lot["id"], BARCODE):
            raise RuntimeError("Purchased line, cost and identified inventory lot diverge")
        if (
            lot["drug_id"], lot["pharmacy_id"], lot["quantity"], cents(lot["cost_price"]),
            cents(lot["local_selling_price"]), lot["expiry_date"], lot["barcode"], lot["batch_number"]
        ) != (1, fixture.TENANT, 4, 200, 500, "2028-12-31", BARCODE, "PURCHASE-" + invoice_id):
            raise RuntimeError("Native purchased stock lot or COGS basis diverges")

        request = exactly_one(conn, "SELECT * FROM native_purchase_create_requests")
        event = exactly_one(conn, "SELECT * FROM native_purchase_posting_events")
        if not UUID.fullmatch(request["request_id"]) or (
            request["invoice_id"], request["actor_id"], request["pharmacy_id"], request["supplier_id"],
            request["source_status"], request["source_total_cents"], request["source_line_count"]
        ) != (invoice_id, fixture.ACTOR, fixture.TENANT, 1, "completed", 800, 1):
            raise RuntimeError("Native exactly-once request or actor receipt mismatch")
        if (
            event["invoice_id"], event["actor_id"], event["pharmacy_id"], event["supplier_id"],
            event["event_kind"], event["journal_id"], event["payment_method"],
            event["signed_cents"], event["new_total_cents"]
        ) != (invoice_id, fixture.ACTOR, fixture.TENANT, 1, "initial", request["initial_journal_id"], "credit", 800, 800):
            raise RuntimeError("Immutable native purchase journal/event chain mismatch")
        snapshot = json.loads(event["line_snapshot"])
        if len(snapshot) != 1 or snapshot[0].get("inventoryId") != lot["id"] or snapshot[0].get("originalLotVerifiable") is not True or snapshot[0].get("cost") != 2.0 or snapshot[0].get("quantity") != 4.0:
            raise RuntimeError("Native sealed purchase lot-origin COGS witness missing")
        transaction = exactly_one(conn, "SELECT * FROM supplier_transactions")
        if (transaction["supplier_id"], transaction["type"], transaction["reference_id"], cents(transaction["amount"])) != (1, "invoice", invoice_id, 800):
            raise RuntimeError("Supplier ledger source does not conserve payable")
        journal = exactly_one(conn, "SELECT * FROM daily_journals")
        if (journal["id"], journal["pharmacy_id"], journal["created_by"], cents(journal["total_amount"])) != (request["initial_journal_id"], fixture.TENANT, fixture.ACTOR, 800):
            raise RuntimeError("Purchase-native journal header mismatch")
        entries = conn.execute("SELECT a.code,e.type,e.amount FROM journal_entries e JOIN accounts a ON a.id=e.account_id WHERE e.journal_id=? ORDER BY e.type,a.code", (journal["id"],)).fetchall()
        if [(x["code"], x["type"], cents(x["amount"])) for x in entries] != [("2.1", "credit", 800), ("1.1.3", "debit", 800)]:
            raise RuntimeError("Purchase inventory/payables double entry does not balance")
        for table in ("native_supplier_payment_receipts", "native_sale_cogs_provenance", "purchase_returns", "sales_invoices", "cash_movements"):
            if conn.execute("SELECT count(*) FROM " + table).fetchone()[0] != 0:
                raise RuntimeError("Costed-purchase-before-settlement milestone no longer pristine: " + table)

    customer = Path(os.environ["APPDATA"]) / "com.pharma.system" / "pharma_local.db"
    if not customer.is_file() or gate.sha(customer) != CUSTOMER_SHA:
        raise RuntimeError("Protected v0.2.109 customer SHA changed")
    if any(Path(str(customer) + ext).exists() for ext in ("-wal", "-shm", "-journal")):
        raise RuntimeError("Protected customer DB sidecar unexpectedly present")
    return {
        "status": "PASS_V69_REAL_WINDOWS_SIGNED_SYNTHETIC_COSTED_CREDIT_PURCHASE_RECEIPTED",
        "customerHistoryAuthority": False, "productionReady": False,
        "nativeActor": fixture.ACTOR, "tenant": fixture.TENANT, "purchaseRequestId": request["request_id"],
        "invoiceId": invoice_id, "invoiceNumber": INVOICE_NUMBER, "inventoryLotId": lot["id"],
        "totalCents": 800, "unitCostCents": 200, "unitSaleCents": 500, "receivedUnits": 4,
        "nativePurchaseCreationRequests": 1, "nativePurchasePostingEvents": 1,
        "journalDebitCents": 800, "journalCreditCents": 800,
        "supplierPayableCents": 800, "sqlx69": True, "sqliteIntegrityAndFk": "PASS",
        "originalV02109CustomerSha256": CUSTOMER_SHA,
        "signedQaExeSha256": gate.sha(signed_exe),
    }


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or not sys.argv[1].isdigit():
            raise RuntimeError("Requires only pinned signed v69 GUI QA PID")
        print(json.dumps(run(int(sys.argv[1])), sort_keys=True))
    except (OSError, RuntimeError, ValueError, sqlite3.DatabaseError, KeyError) as error:
        print("V69 SIGNED SYNTHETIC COSTED PURCHASE READ-ONLY RECEIPT REFUSED: " + str(error), file=sys.stderr)
        raise SystemExit(2)
