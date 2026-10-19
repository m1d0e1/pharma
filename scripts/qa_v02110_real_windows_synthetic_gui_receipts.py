"""Read-only financial custody check for the actual synthetic Windows QA GUI.

Never issues native business writes, normalizes scope, reads customer secrets,
or accepts a different app identifier. Reject mismatched owner/tenant, duplicate
commit, missing native receipt, broken accounting, stock quantity or return.
This is *not* certification of historical source financial provenance.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

IDENTITY = "com.pharma.disposable.positiveqa20261018"
TENANT = "qa_positive_20261018"
ACTOR = "qa_positive_owner_20261018"
ORIGINAL = Path("pharma-v02110-prebuild-snapshot-cb743d7b7ab14ffd9583ee1a64cdd472") / "current-v02109-sealed.sqlite3"
ORIGINAL_SHA = "06fc00f32ec2603758cd3f0eb12c38024f22fce27c4e5f7875ab47aceb6c87fb"
TABLES = (
    "patients", "native_patient_directory_ownership", "suppliers",
    "native_supplier_directory_ownership", "master_drugs",
    "native_master_drug_create_receipts", "inventory",
    "inventory_lot_create_requests", "sales_invoices", "sales_items",
    "native_sale_cogs_provenance", "returns", "return_items",
    "native_sale_return_cogs_provenance", "daily_journals",
    "journal_entries", "purchase_invoices", "native_purchase_create_requests",
    "native_purchase_posting_events", "supplier_transactions",
    "patient_transactions", "native_patient_wallet_topup_receipts",
)


def verify() -> dict:
    original = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies" / ORIGINAL
    if hashlib.sha256(original.read_bytes()).hexdigest() != ORIGINAL_SHA:
        raise RuntimeError("Original sealed v0.2.109 historical source custody changed")
    profile = Path(os.environ["APPDATA"]) / IDENTITY
    manifest = json.loads((profile / "source.json").read_text(encoding="utf8"))
    if ((manifest.get("app_id"), manifest.get("tenant"),
         manifest.get("historical_rows_included"),
         manifest.get("genuine_customer_ownership_approved"))
            != (IDENTITY,TENANT,False,False)):
        raise RuntimeError("Not the separately authorized synthetic QA profile")
    path = profile / "pharma_local.db"
    with sqlite3.connect(path.as_uri() + "?mode=ro",uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise RuntimeError("QA SQLite integrity failure")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise RuntimeError("QA foreign key violation")
        if db.execute("SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations").fetchone()[0]!=67:
            raise RuntimeError("Unexpected QA schema version")
        users = db.execute("SELECT id,role,pharmacy_id FROM users WHERE is_active=1").fetchall()
        if users != [(ACTOR,"owner",TENANT)]:
            raise RuntimeError("Unexpected authenticated QA principal")
        counts = {name:db.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
                  for name in TABLES}
        exact = {
            "patients":1,"native_patient_directory_ownership":1,
            "suppliers":1,"native_supplier_directory_ownership":1,
            "master_drugs":1,"native_master_drug_create_receipts":1,
            "inventory":1,"inventory_lot_create_requests":1,
            "sales_invoices":1,"sales_items":1,"native_sale_cogs_provenance":1,
            "returns":1,"return_items":1,"native_sale_return_cogs_provenance":1,
            "daily_journals":2,"journal_entries":4,
            "purchase_invoices":0,"native_purchase_create_requests":0,
            "native_purchase_posting_events":0,"supplier_transactions":0,
            "patient_transactions":0,"native_patient_wallet_topup_receipts":0,
        }
        if counts!=exact:
            raise RuntimeError("Unexpected duplicate, absent, or unreviewed QA receipt")
        patient=db.execute("SELECT id,wallet_balance,opening_balance FROM patients").fetchone()
        supplier=db.execute("SELECT id,balance FROM suppliers").fetchone()
        if patient is None or patient[1:]!=(0.0,0.0) or supplier is None or supplier[1]!=0:
            raise RuntimeError("Wallet/credit/supplier initial balances unexpectedly changed")
        for table,column,ident in (
            ("native_patient_directory_ownership","patient_id",patient[0]),
            ("native_supplier_directory_ownership","supplier_id",supplier[0]),
        ):
            row=db.execute(f"SELECT pharmacy_id,actor_id FROM {table} WHERE {column}=?",(ident,)).fetchone()
            if row!=(TENANT,ACTOR):
                raise RuntimeError("Synthetic directory ownership witness inconsistent")
        item=db.execute("SELECT drug_id,quantity,cost_price,local_selling_price,expiry_date,pharmacy_id FROM inventory").fetchone()
        if item!=(1,4.0,0.0,5.0,"2028-12-31",TENANT):
            raise RuntimeError("Positive stock sold/returned quantity or values changed")
        sale=db.execute("SELECT id,patient_id,pharmacy_id,user_id,total_amount,payment_method FROM sales_invoices").fetchone()
        if not sale or sale[1:]!=(patient[0],TENANT,ACTOR,5.0,"cash"):
            raise RuntimeError("Native cash POS receipt not owned by QA actor")
        return_row=db.execute("SELECT invoice_id,total_refund FROM returns").fetchone()
        if return_row!=(sale[0],5.0):
            raise RuntimeError("Return not linked to exact native cash sale")
        cost=db.execute("SELECT sale_micros,cogs_micros,pharmacy_id FROM native_sale_cogs_provenance").fetchone()
        if cost!=(5_000_000,0,TENANT):
            raise RuntimeError("Native sale/COGS immutable receipt mismatch")
        entries=db.execute("""SELECT j.id,j.total_amount,
            SUM(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END),
            SUM(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END)
            FROM daily_journals j JOIN journal_entries e ON e.journal_id=j.id
            WHERE j.pharmacy_id=? GROUP BY j.id""",(TENANT,)).fetchall()
        if len(entries)!=2 or any(abs(float(total)-5)>1e-9 or
                                  abs(float(debit)-5)>1e-9 or
                                  abs(float(credit)-5)>1e-9
                                  for _,total,debit,credit in entries):
            raise RuntimeError("Native sale/return accounting imbalance")
    if hashlib.sha256(original.read_bytes()).hexdigest()!=ORIGINAL_SHA:
        raise RuntimeError("Original historical source changed during QA audit")
    return {
        "status":"VERIFIED_REAL_WINDOWS_GUI_SYNTHETIC_POS_RETURN_POSTFLIGHT",
        "original_customer_source_sha256_unchanged":True,
        "qa_app_id":IDENTITY,"native_schema":67,
        "directory_owner_witnesses_verified":2,
        "inventory_original_four_units_restored":True,
        "cash_sale_cents":500,"cash_return_cents":500,
        "sale_native_provenance":True,"return_native_provenance":True,
        "balanced_native_journals":2,
        "purchase_attempt_committed":False,
        "wallet_funding_committed":False,
        "exact_receipt_cardinalities":counts,
        "customer_history_authorized":False,
        "positive_historical_gui_tested":False,
    }


if __name__=="__main__":
    try:
        print(json.dumps(verify(),sort_keys=True))
    except (RuntimeError,OSError,sqlite3.Error,KeyError,ValueError):
        print("VERIFICATION_REFUSED: synthetic GUI receipts or original custody differ",file=sys.stderr)
        raise SystemExit(2)
