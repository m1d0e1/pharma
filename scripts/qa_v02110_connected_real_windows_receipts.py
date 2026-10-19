"""Independent read-only native SQL verification of actual Windows GUI QA writes.

This verifies the *specific* uniquely named, isolated synthetic purchase -> sale
-> return. It cannot authorize historic customer data or independently verify
commercial owner enrollment. It never sends financial IPC or changes SQLite.
"""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys

from scripts.qa_v02110_connected_windows_gui import (
    IDENTITY, TENANT, ACTOR, exact_binary, sha,
)

INVOICE = "90f2b798-4d6d-44f1-b27b-f19f14674f32"
REQUEST = "6727dd50-87cf-41ad-ab21-4fffcca289e1"
LOT = "be751c3a-fbc1-4da8-af51-6b86fd938abf"
SALE = "908169c1-08f5-4bd3-99fb-be24990746b7"
RETURN = "9ee575db-7201-44da-996a-b486753f449b"
PURCHASE_RETURN = "5a5f0c4a-4b5b-4275-b01c-6e915c954f7c"
PURCHASE_RETURN_REQUEST = "de19e0fe-12c5-4260-945d-18a704cb439a"
ITEM = "QA Purchased Origin Drug 20261018"
PURCHASE_NO = "QA-PURCHASE-COST-20261018-001"


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def check() -> dict:
    qa_exe, manifest = exact_binary()
    profile = Path(os.environ["APPDATA"]) / IDENTITY
    source = json.loads((profile / "source.json").read_text("utf-8"))
    expect((source.get("historical_rows_included"), source.get("genuine_customer_ownership_approved"),
            source.get("actor"), source.get("tenant")) == (False, False, ACTOR, TENANT),
           "Synthetic data ownership manifest mismatch")
    db_path = profile / "pharma_local.db"
    with closing(sqlite3.connect(db_path.as_uri()+"?mode=ro",uri=True)) as d:
        d.execute("PRAGMA query_only=ON")
        expect(d.execute("PRAGMA integrity_check").fetchone() == ("ok",), "SQLite corrupt")
        expect(d.execute("PRAGMA foreign_key_check").fetchone() is None, "FK violations")
        expect(d.execute("SELECT MAX(version) FROM _sqlx_migrations WHERE success=1").fetchone() == (68,),
               "Native startup did not apply migration 068")
        users = d.execute("SELECT id,role,pharmacy_id FROM users WHERE is_active=1").fetchall()
        expect(users == [(ACTOR, "owner", TENANT)], "Synthetic principal scope changed")
        names = ["suppliers", "native_supplier_directory_ownership",
                 "master_drugs", "native_master_drug_create_receipts",
                 "purchase_invoices", "purchase_invoice_items",
                 "native_purchase_create_requests", "native_purchase_posting_events",
                 "supplier_transactions", "inventory", "sales_invoices", "sales_items",
                 "native_sale_cogs_provenance", "returns", "return_items",
                 "native_sale_return_cogs_provenance", "daily_journals", "journal_entries",
                 "purchase_returns", "purchase_return_items",
                 "native_purchase_return_provenance", "native_purchase_return_line_provenance"]
        counts = {n:d.execute(f'SELECT COUNT(*) FROM "{n}"').fetchone()[0] for n in names}
        for n in names[:16]:
            expect(counts[n] == (2 if n == "supplier_transactions" else 1),
                   f"Unexpected QA cardinality in {n}")
        expect(counts["daily_journals"] == 4 and counts["journal_entries"] == 12,
               "Expected purchase, cash sale, sales return and purchase return journals exactly once")
        for n in names[18:]:
            expect(counts[n] == 1, f"Unexpected purchase-return cardinality in {n}")
        supplier = d.execute("SELECT id,name_ar,balance FROM suppliers").fetchone()
        expect(supplier == (1,"QA Connected Supplier 20261018",6.0),
               "Supplier credit payable net of 200-cent purchase return drift")
        supplier_owner = d.execute(
            "SELECT supplier_id,pharmacy_id,actor_id FROM native_supplier_directory_ownership"
        ).fetchone()
        expect(supplier_owner == (1,TENANT,ACTOR),"Supplier directory witness mismatch")
        drug = d.execute("SELECT id,trade_name_en,barcode,official_price FROM master_drugs").fetchone()
        expect(drug == (1,ITEM,"QA02110COST20261018",5.0), "Catalog native create drift")
        expect(d.execute(
            "SELECT drug_id,pharmacy_id,actor_id FROM native_master_drug_create_receipts"
        ).fetchone() == (1,TENANT,ACTOR), "Master drug creation witness mismatch")
        invoice = d.execute(
            "SELECT id,supplier_id,pharmacy_id,user_id,invoice_number,status,"
            "total_amount,paid_amount,payment_method FROM purchase_invoices"
        ).fetchone()
        expect(invoice == (INVOICE,1,TENANT,ACTOR,PURCHASE_NO,"completed",8.0,0.0,"credit"),
               "Credit purchase source or amount changed")
        expect(d.execute(
            "SELECT request_id,invoice_id,source_total_cents "
            "FROM native_purchase_create_requests"
        ).fetchone() == (REQUEST,INVOICE,800),"Durable purchase identity mismatch")
        event=d.execute(
            "SELECT invoice_id,actor_id,pharmacy_id,supplier_id,event_kind,"
            "payment_method,signed_cents,old_total_cents,new_total_cents,line_snapshot "
            "FROM native_purchase_posting_events"
        ).fetchone()
        expect(event[:9] == (INVOICE,ACTOR,TENANT,1,"initial","credit",800,0,800),
               "Immutable acquisition event mismatch")
        purchase_lines=json.loads(event[9])
        expect(len(purchase_lines)==1 and
               purchase_lines[0]["inventoryId"]==LOT and
               purchase_lines[0]["cost"]==2.0 and
               purchase_lines[0]["quantity"]==4 and
               purchase_lines[0]["originalLotVerifiable"] is True,
               "Lot not proven from purchase source")
        expect(d.execute(
            "SELECT supplier_id,type,amount,reference_id FROM supplier_transactions ORDER BY id"
        ).fetchall() == [(1,"invoice",8.0,INVOICE),
                       (1,"return",2.0,PURCHASE_RETURN)], "Supplier payable ledger mismatch")
        expect(d.execute(
            "SELECT id,drug_id,quantity,cost_price,local_selling_price,expiry_date,"
            "pharmacy_id FROM inventory"
        ).fetchone() == (LOT,1,3,2.,5.,"2028-12-31",TENANT), "Inventory not conserved")
        expect(d.execute(
            "SELECT id,pharmacy_id,user_id,total_amount,payment_method FROM sales_invoices"
        ).fetchone() == (SALE,TENANT,ACTOR,5.0,"cash"),"POS sale drift")
        expect(d.execute(
            "SELECT invoice_id,inventory_id,drug_id,quantity_sold,unit_price,"
            "unit,is_negative,cost_price FROM sales_items"
        ).fetchone() == (SALE,LOT,1,1.,5.,"large",0,2.),"POS lot/cost mismatch")
        sale = d.execute(
            "SELECT sale_id,pharmacy_id,actor_id,sale_micros,cogs_micros,line_count,"
            "line_snapshot FROM native_sale_cogs_provenance"
        ).fetchone()
        expect(sale[:6]==(SALE,TENANT,ACTOR,5_000_000,2_000_000,1),
               "Purchase-origin cost receipt missing")
        sale_lines=json.loads(sale[6])
        expect(len(sale_lines)==1 and sale_lines[0]["inventoryId"]==LOT
               and sale_lines[0]["costPerLarge"]==2. and sale_lines[0]["quantity"]==1,
               "Immutable POS cost snapshot mismatch")
        ret=d.execute(
            "SELECT id,invoice_id,user_id,total_refund,refund_method,status,pharmacy_id "
            "FROM returns"
        ).fetchone()
        expect(ret == (RETURN,SALE,ACTOR,5.0,"cash","approved",TENANT),
               "Return amount/source/permission drift")
        expect(d.execute(
            "SELECT return_id,inventory_id,quantity_returned,total_price,"
            "sale_item_id,unit FROM return_items"
        ).fetchone()==(RETURN,LOT,1.,5.,1,"large"), "Return invoice linkage drift")
        rev=d.execute(
            "SELECT return_id,sale_id,pharmacy_id,actor_id,refund_micros,cogs_micros,"
            "line_count,line_snapshot FROM native_sale_return_cogs_provenance"
        ).fetchone()
        expect(rev[:7] == (RETURN,SALE,TENANT,ACTOR,5_000_000,2_000_000,1),
               "Return COGS reversal mismatch")
        rev_lines=json.loads(rev[7])
        expect(len(rev_lines)==1 and rev_lines[0]["inventoryId"]==LOT
               and rev_lines[0]["costPerLarge"]==2. and rev_lines[0]["quantity"]==1,
               "Sale COGS restored from wrong lot")
        purchase_return=d.execute(
            "SELECT id,supplier_id,user_id,purchase_invoice_id,total_amount,refund_method,status "
            "FROM purchase_returns"
        ).fetchone()
        expect(purchase_return==(PURCHASE_RETURN,1,ACTOR,INVOICE,2.0,"credit","completed"),
               "Original credit purchase return invoice/linkage drift")
        expect(d.execute(
            "SELECT purchase_return_id,inventory_id,drug_id,quantity_returned,unit_price,"
            "total_price,purchase_invoice_item_id,unit FROM purchase_return_items"
        ).fetchone()==(PURCHASE_RETURN,LOT,1,1.,2.,2.,1,"large"),
               "Original purchased lot returned using wrong unit/cost/source")
        return_proof=d.execute(
            "SELECT return_id,request_id,purchase_invoice_id,pharmacy_id,actor_id,"
            "supplier_id,journal_id,refund_method,amount_cents,line_count "
            "FROM native_purchase_return_provenance"
        ).fetchone()
        expect(return_proof==(PURCHASE_RETURN,PURCHASE_RETURN_REQUEST,INVOICE,
               TENANT,ACTOR,1,"5359b8f4-7e21-496c-b88f-e1fe74ba057f","credit",200,1),
               "Immutable purchase return receipt mismatch")
        expect(d.execute(
            "SELECT return_item_id,return_id,purchase_invoice_item_id,inventory_id,"
            "quantity_returned,stock_quantity,refund_value "
            "FROM native_purchase_return_line_provenance"
        ).fetchone()==(1,PURCHASE_RETURN,1,LOT,1.,1.,2.),
               "Purchase return original-line typed provenance mismatch")
        journals=d.execute(
            "SELECT j.id,j.total_amount,COUNT(e.id),"
            "SUM(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END),"
            "SUM(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END)"
            " FROM daily_journals j JOIN journal_entries e ON e.journal_id=j.id "
            "WHERE j.pharmacy_id=? AND j.created_by=? GROUP BY j.id",(TENANT,ACTOR)
        ).fetchall()
        expect(sorted((float(row[1]),row[2],float(row[3]),float(row[4]))
                      for row in journals)==[(2.0,2,2.0,2.0),
                                            (7.0,4,7.0,7.0),
                                            (7.0,4,7.0,7.0),
                                            (8.0,2,8.0,8.0)],
               "Native accounting debits/credits do not conserve acquisition, sale and returns")
    return {
        "status":"PASS_ACTUAL_SIGNED_WINDOWS_GUI_COSTED_PURCHASE_POS_RETURN",
        "qa_executable_sha256":sha(qa_exe),
        "app_id":IDENTITY,
        "sqlx_version":68,
        "native_purchase_invoice":INVOICE,
        "purchase_request_id":REQUEST,
        "purchase_cents":800,
        "source_lot":LOT,
        "inventory_initial_large_units":4,
        "inventory_final_after_purchase_return_large_units":3,
        "stock_sale_and_return_large_units":1,
        "sale_id":SALE,
        "cash_sale_cents":500,
        "sale_purchase_origin_cogs_cents":200,
        "return_id":RETURN,
        "cash_refund_cents":500,
        "reversed_cogs_cents":200,
        "purchase_return_id":PURCHASE_RETURN,
        "purchase_return_request":PURCHASE_RETURN_REQUEST,
        "purchase_return_restock_decrement_units":1,
        "purchase_return_credit_cents":200,
        "supplier_payable_cents":600,
        "balanced_native_journals":4,
        "exact_cardinalities":counts,
        "customer_history_authorized":False,
        "historical_original_rows_included":False,
        "ready_for_production":False,
    }


if __name__=="__main__":
    try:
        print(json.dumps(check(),sort_keys=True))
    except (OSError,sqlite3.Error,RuntimeError,ValueError,KeyError):
        print("Connected signed Windows synthetic financial receipts REFUSED",
              file=sys.stderr)
        raise SystemExit(2)
