"""Synthetic in-memory all-module archive audit, never an archive data export."""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import sqlite3
import unittest

from scripts.qa_historical_archive_manifest import (
    EXTENDED_FAMILIES, make_manifest, verified_manifest,
)
from scripts.qa_historical_archive_manifest_regression import fixture


def module_fixture() -> sqlite3.Connection:
    db = fixture()
    db.executescript("""
      CREATE TABLE accounts(id TEXT PRIMARY KEY,parent_id TEXT,balance REAL);
      INSERT INTO accounts VALUES ('asset-account',NULL,0),('expense-account','asset-account',0);
      ALTER TABLE journal_entries ADD COLUMN account_id TEXT;
      UPDATE journal_entries SET account_id='asset-account' WHERE id='debit';
      UPDATE journal_entries SET account_id='expense-account' WHERE id='credit';
      ALTER TABLE inventory ADD COLUMN quantity REAL;
      UPDATE inventory SET quantity=20 WHERE id='lot-a';
      ALTER TABLE purchase_invoices ADD COLUMN user_id TEXT;
      ALTER TABLE purchase_invoices ADD COLUMN total_amount REAL;
      UPDATE purchase_invoices SET total_amount=100;
      INSERT INTO users VALUES('actor-a','branch-a');
      INSERT INTO purchase_invoices VALUES
        ('invoice-scoped','supplier-x','branch-a','actor-a',100);
      ALTER TABLE purchase_invoice_items ADD COLUMN drug_id TEXT;
      ALTER TABLE purchase_invoice_items ADD COLUMN cost_price REAL;
      UPDATE purchase_invoice_items SET drug_id='drug-1',cost_price=12;
      ALTER TABLE sales_items ADD COLUMN drug_id TEXT;
      ALTER TABLE sales_items ADD COLUMN cost_price REAL;
      UPDATE sales_items SET drug_id='drug-1',cost_price=4;
      ALTER TABLE sales_invoices ADD COLUMN user_id TEXT;
      ALTER TABLE sales_invoices ADD COLUMN total_amount REAL;
      UPDATE sales_invoices SET total_amount=30;
      ALTER TABLE patient_transactions ADD COLUMN user_id TEXT;
      ALTER TABLE patient_transactions ADD COLUMN amount REAL;
      UPDATE patient_transactions SET user_id='actor-a',amount=5;
      ALTER TABLE supplier_transactions ADD COLUMN type TEXT;
      ALTER TABLE supplier_transactions ADD COLUMN amount REAL;
      ALTER TABLE supplier_transactions ADD COLUMN reference_id TEXT;
      ALTER TABLE supplier_transactions ADD COLUMN user_id TEXT;
      UPDATE supplier_transactions SET type='invoice',amount=99,
        reference_id='invoice-1',user_id='actor-a';
      ALTER TABLE cash_movements ADD COLUMN user_id TEXT;
      ALTER TABLE cash_movements ADD COLUMN amount REAL;
      ALTER TABLE shifts ADD COLUMN user_id TEXT;
      ALTER TABLE shifts ADD COLUMN pharmacy_id TEXT;
      UPDATE shifts SET user_id='actor-a',pharmacy_id='branch-a';
      UPDATE cash_movements SET user_id='actor-a',amount=7.00;
      CREATE TABLE stock_adjustments(
        id TEXT PRIMARY KEY,inventory_id TEXT,user_id TEXT
      );
      INSERT INTO stock_adjustments VALUES('stock-1','lot-a','actor-a');
      CREATE TABLE expense_definitions(id TEXT PRIMARY KEY);
      INSERT INTO expense_definitions VALUES('PRIVATE-ACCOUNT-DESCRIPTION');
      CREATE TABLE supplier_private_extra(id TEXT PRIMARY KEY,contact TEXT);
      INSERT INTO supplier_private_extra VALUES('PRIVATE-SUPPLIER-ROW','PRIVATE-PHONE');
      CREATE TABLE native_purchase_create_requests(
        invoice_id TEXT,pharmacy_id TEXT,actor_id TEXT,supplier_id TEXT
      );
      CREATE TABLE native_purchase_posting_events(
        invoice_id TEXT,event_kind TEXT,pharmacy_id TEXT,
        supplier_id TEXT,actor_id TEXT
      );
      INSERT INTO native_purchase_create_requests
        VALUES('invoice-scoped','branch-a','actor-a','supplier-x');
      INSERT INTO native_purchase_posting_events
        VALUES('invoice-scoped','initial','branch-a','supplier-x','actor-a');
    """)
    db.commit()
    return db


class HistoricalModuleCoverageRegression(unittest.TestCase):
    def test_source_witness_candidate_does_not_authorize_history_or_copy(self) -> None:
        with closing(module_fixture()) as db:
            original_sha = hashlib.sha256(db.serialize()).hexdigest()
            report = verified_manifest(
                db, original_sha,
                lambda: hashlib.sha256(db.serialize()).hexdigest(),
            )
            self.assertEqual(report["archive_sha256"], original_sha)
            self.assertEqual(report["native_witness_candidate_counts"]["purchase_create_044"][
                "source_rows_with_candidate"], 1)
            self.assertEqual(report["native_witness_candidate_counts"]["purchase_posting_042"][
                "source_rows_with_candidate"], 1)
            self.assertEqual(report["native_witness_candidate_counts"]["purchase_create_044"][
                "source_rows_without_candidate"], 1)
            self.assertFalse(report["native_witness_candidate_counts"]["purchase_create_044"][
                "historic_financial_source_certified"])
            self.assertEqual(report["module_source_relations"]["journal_entry_to_account"][
                "orphan_rows"], 0)
            self.assertEqual(report["module_source_relations"]["cash_shift_literal_tenant"][
                "unknown_or_legacy_scope"], 1)
            self.assertEqual(report["module_source_relations"][
                "supplier_invoice_ledger_candidate"]["matching_source_and_cents"], 0)
            self.assertEqual(report["module_source_relations"][
                "supplier_invoice_ledger_candidate"]["source_or_amount_unmatched"], 1)
            self.assertEqual(report["amount_shape_findings"][
                "purchase_line_cost"]["malformed_or_negative_rows"], 0)
            self.assertEqual(report["amount_shape_findings"][
                "cash_movement_amount"]["malformed_or_negative_rows"], 0)
            self.assertEqual(report["quarantined_identity_counts"]["literal_null"] > 0, True)
            self.assertIn("stock_and_opening", report["domain_counts"])
            self.assertIn("accounts_and_payments", report["domain_counts"])
            self.assertGreater(report["domain_counts"]["unclassified"], 0)
            for protected in (
                "historical_tenant_ownership_certified",
                "financial_provenance_certified",
                "archive_customer_supplier_copy_authorized",
                "global_customer_supplier_source_owner_verified",
                "import_permitted",
            ):
                self.assertFalse(report[protected])
            dump = json.dumps(report)
            for private in (
                "PRIVATE-", "branch-a", "supplier-x", "invoice-scoped",
                "asset-account", "actor-a", "PRIVATE-PHONE", "lot-a",
            ):
                self.assertNotIn(private, dump)
            self.assertEqual(original_sha, hashlib.sha256(db.serialize()).hexdigest())

    def test_optional_legacy_schema_and_nonexistent_new_receipts_stay_quarantined(self) -> None:
        with closing(fixture()) as db:
            report = make_manifest(db)
            for label in (
                "purchase_create_044", "purchase_posting_042",
                "purchase_returns_041", "sale_cogs_043", "sale_returns_043",
                "supplier_payments_054",
            ):
                self.assertEqual(report["native_witness_candidate_counts"][label]["status"],
                                 "native_witness_table_absent")
            self.assertEqual(report["module_source_relations"][
                "supplier_ledger_to_actor"]["status"],
                "unmapped_legacy_column_quarantined")
            self.assertEqual(report["module_source_relations"][
                "cash_shift_literal_tenant"]["status"],
                "unmapped_legacy_column_quarantined")
            self.assertFalse(report["import_permitted"])

    def test_orphans_and_untrusted_financial_shapes_have_only_numeric_findings(self) -> None:
        with closing(module_fixture()) as db:
            db.execute("UPDATE journal_entries SET account_id='missing-account' WHERE id='debit'")
            db.execute("UPDATE supplier_transactions SET amount=100.125")
            db.execute("UPDATE purchase_invoice_items SET cost_price=-300")
            result = make_manifest(db)
            self.assertEqual(result["module_source_relations"][
                "journal_entry_to_account"]["orphan_rows"], 1)
            self.assertEqual(result["module_source_relations"][
                "supplier_invoice_ledger_candidate"]["source_or_amount_unmatched"], 1)
            self.assertEqual(result["amount_shape_findings"][
                "supplier_ledger_amount"]["malformed_or_negative_rows"], 1)
            self.assertEqual(result["amount_shape_findings"][
                "purchase_line_cost"]["malformed_or_negative_rows"], 1)
            self.assertFalse(result["financial_provenance_certified"])

    def test_unknown_tables_and_full_module_map_never_leak_private_table_names(self) -> None:
        with closing(module_fixture()) as db:
            db.execute(
                'CREATE TABLE "master_drugs_fts_docsize" (id TEXT, size BLOB)'
            )
            db.execute(
                'INSERT INTO "master_drugs_fts_docsize" VALUES (?,?)',
                ("PRIVATE-SEARCH-INDEX-ROW", b"\x00\xff"),
            )
            report = make_manifest(db)
            all_tables = sum(table["rows"] for table in report["tables"])
            self.assertEqual(report["all_table_rows"], all_tables)
            self.assertEqual(len({table["opaque_table_id"] for table in report["tables"]}),
                             report["table_count"])
            self.assertIn("stock_adjustments", EXTENDED_FAMILIES)
            self.assertNotIn("supplier_private_extra", json.dumps(report))
            self.assertNotIn("PRIVATE-SEARCH-INDEX-ROW", json.dumps(report))
            self.assertEqual(
                report["domain_counts"]["catalog_search_index_quarantined"], 1
            )
            self.assertFalse(report["global_customer_supplier_source_owner_verified"])


if __name__ == "__main__":
    unittest.main()
