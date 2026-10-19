"""No real profile touched: simulation checks use invented RAM databases."""
from __future__ import annotations

import sqlite3
import unittest

from scripts.qa_v02110_single_scope_rehearsal import (
    scope_counts, scope_tables, verify_all_old_rows,
)


def make_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.executescript("""
        CREATE TABLE users(id TEXT PRIMARY KEY,pharmacy_id TEXT,role TEXT);
        CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,
                                  total_amount REAL);
        CREATE TABLE patients(id TEXT PRIMARY KEY,notes TEXT);
        INSERT INTO users VALUES('owner',NULL,'owner'),('staff','local_default','pharmacist');
        INSERT INTO sales_invoices VALUES('old-null',NULL,8.00127);
        INSERT INTO sales_invoices VALUES('old-placeholder','local_default',2.75);
        INSERT INTO patients VALUES('patient','original-value');
    """)
    return db


class ScopeStagingSafetyTests(unittest.TestCase):
    def setUp(self):
        self.original = make_db()
        self.clone = make_db()
        self.addCleanup(self.original.close)
        self.addCleanup(self.clone.close)
        self.clone.execute("CREATE TABLE qa_original_legacy_pharmacy_scopes(table_name TEXT)")

    def stage(self):
        for table in scope_tables(self.clone):
            self.clone.execute('UPDATE "'+table+'" SET pharmacy_id=?',("pharmacy_primary",))

    def test_direct_scopes_repaired_without_changing_any_other_cell(self):
        self.stage()
        verified = verify_all_old_rows(
            self.original,self.clone,set(scope_tables(self.clone)),"pharmacy_primary")
        self.assertEqual(verified["only_scope_field_changed_rows"],4)
        self.assertEqual(verified["other_original_cells_changed"],0)
        self.assertEqual(verified["source_physical_rows_compared"],5)
        self.assertEqual(self.original.execute("SELECT pharmacy_id FROM users WHERE id='owner'").fetchone(),(None,))

    def test_fractional_original_financial_cent_must_remain_exact(self):
        self.stage()
        self.clone.execute("UPDATE sales_invoices SET total_amount=8.00 WHERE id='old-null'")
        with self.assertRaisesRegex(ValueError,"Non-scope"):
            verify_all_old_rows(self.original,self.clone,set(scope_tables(self.clone)),"pharmacy_primary")

    def test_original_parent_or_child_deletion_is_denied(self):
        self.stage()
        self.clone.execute("DELETE FROM patients")
        with self.assertRaisesRegex(ValueError,"Historical row"):
            verify_all_old_rows(self.original,self.clone,set(scope_tables(self.clone)),"pharmacy_primary")

    def test_foreign_named_scope_cannot_be_reassigned(self):
        self.original.execute("UPDATE sales_invoices SET pharmacy_id='branch_b' WHERE id='old-null'")
        self.stage()
        with self.assertRaisesRegex(ValueError,"Foreign owner"):
            verify_all_old_rows(self.original,self.clone,set(scope_tables(self.clone)),"pharmacy_primary")

    def test_other_named_scope_detected_before_unification(self):
        self.original.execute("INSERT INTO sales_invoices VALUES('foreign','branch_b',99)")
        self.assertEqual(scope_counts(self.original,"sales_invoices")["other"],1)


if __name__ == "__main__":
    unittest.main()
