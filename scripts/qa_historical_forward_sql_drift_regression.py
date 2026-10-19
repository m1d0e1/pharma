"""RAM-only checks for exact original field/row drift diagnostic."""
from __future__ import annotations

from contextlib import closing
from contextlib import redirect_stdout
import io
from pathlib import Path
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

from scripts.legacy_pharmacy_upgrade import UnsafeSource
from scripts.qa_historical_forward_sql_drift import (
    original_table_schema, original_row_commitments,
    rehearsal_on_connections, sql_files,
)


class ForwardSqlDriftTests(unittest.TestCase):
    def fixture(self):
        source = sqlite3.connect(":memory:")
        source.executescript("""
          CREATE TABLE users(id TEXT PRIMARY KEY,pharmacy_id TEXT,password_hash BLOB);
          CREATE TABLE financial_originals(id INTEGER PRIMARY KEY,amount REAL,payload BLOB);
          INSERT INTO users VALUES('original-admin',NULL,x'0102');
          INSERT INTO users VALUES('employee','local_default',x'FDEE');
          INSERT INTO financial_originals VALUES(1,0.00125,x'00FF');
        """)
        clone = sqlite3.connect(":memory:")
        source.backup(clone)
        return source, clone

    def test_schema_extension_keeps_every_original_typed_field(self):
        before, after = self.fixture()
        with closing(before), closing(after):
            original = original_row_commitments(before, original_table_schema(before))
            result = rehearsal_on_connections(before, after, [
                (30, "ALTER TABLE users ADD COLUMN native_authorized_at TEXT;"
                     "CREATE TABLE new_safe_table(id TEXT PRIMARY KEY);")
            ])
            self.assertEqual(result["changed_original_record_tables"], {})
            self.assertEqual(result["original_tables_with_new_columns"], ["users"])
            self.assertTrue(result["sqlite_integrity_ok"])
            self.assertFalse(result["historical_tenant_ownership_authorized"])
            self.assertFalse(result["customer_upgrade_approved"])
            self.assertFalse(result["safe_to_install_over_customer_database"])
            self.assertEqual(original, original_row_commitments(before, original_table_schema(before)))

    def test_independent_type_and_tenant_mutation_detected_without_identifiers(self):
        before, after = self.fixture()
        with closing(before), closing(after):
            result = rehearsal_on_connections(before, after, [
                (30, "UPDATE users SET pharmacy_id='local_default',password_hash=x'03'"
                     " WHERE id='original-admin';"
                     "UPDATE financial_originals SET amount=0.001250000001 WHERE id=1;")
            ])
            self.assertEqual(set(result["changed_original_record_tables"]),
                             {"users", "financial_originals"})
            self.assertEqual(result["changed_original_record_tables"]["users"]["changed_original_fields"],
                             {"pharmacy_id": 1, "password_hash": 1})
            self.assertEqual(result["changed_original_record_tables"]["financial_originals"]
                             ["changed_original_fields"], {"amount": 1})
            self.assertEqual(result["original_typed_rows"], 3)
            self.assertNotIn("original-admin", str(result))
            self.assertFalse(result["safe_to_install_over_customer_database"])

    def test_deleted_original_record_is_detected_even_when_count_still_plausible(self):
        before, after = self.fixture()
        with closing(before), closing(after):
            result = rehearsal_on_connections(before, after, [
                (30, "DELETE FROM financial_originals WHERE id=1;")
            ])
            self.assertEqual(result["changed_original_record_tables"]["financial_originals"]
                             ["old_count"], 1)
            self.assertEqual(result["changed_original_record_tables"]["financial_originals"]
                             ["new_count"], 0)

    def test_transaction_failure_rolls_back_without_changes_to_source(self):
        before, after = self.fixture()
        with closing(before), closing(after):
            result = rehearsal_on_connections(before, after, [
                (30, "CREATE TABLE marker(n INTEGER CHECK(n=1));"
                     "INSERT INTO marker VALUES(2);")
            ])
            self.assertEqual(result["first_sql_failure_version"], 30)
            self.assertEqual(result["changed_original_record_tables"], {})
            self.assertEqual(result["forward_sql_versions_applied"], 0)
            self.assertEqual(before.execute("SELECT COUNT(*) FROM users").fetchone(), (2,))
            self.assertEqual(after.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='marker'").fetchone(), (0,))

    def test_version_gap_is_never_silently_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)
            (path / "030_alpha.sql").write_text("SELECT 1;")
            (path / "032_beta.sql").write_text("SELECT 2;")
            with self.assertRaises(UnsafeSource):
                sql_files(path, 30)

    def test_cli_never_turns_sql_only_parity_into_release_approval(self):
        from scripts.qa_historical_forward_sql_drift import KNOWN_PIN, main

        # In-process synthetic stub ONLY. Even a perfect parity diagnostic
        # cannot be used as an authorized customer production release gate.
        clean_report = {
            "original_tables": 2, "original_typed_rows": 3,
            "changed_original_record_tables": {},
            "first_sql_failure_version": None,
            "sqlite_integrity_ok": True, "foreign_key_check_ok": True,
            "safe_to_install_over_customer_database": False,
        }
        with patch("scripts.qa_historical_forward_sql_drift.audit_pinned_archive",
                   return_value=clean_report), \
                patch.dict(os.environ, {"LOCALAPPDATA": tempfile.gettempdir()}), \
                patch.object(sys, "argv", ["sql-drift", "--expected-sha256", KNOWN_PIN]), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(main(), 2)


if __name__ == "__main__":
    unittest.main()
