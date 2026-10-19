"""Negative QA tests for a live original v29 whose AUTOINCREMENT advances.

No test opens a customer file with SQLite or modifies installed/app-data files.
Every hostile change is applied to an in-memory clone of the SHA-pinned
historical original, then compared against its original typed physical rows.
"""
from __future__ import annotations

import os
from pathlib import Path
import sqlite3
import unittest

from scripts import qa_original_history_live_sequence_rebase as rebase
from scripts import qa_original_history_atomic_rehearsal as stage
from scripts import qa_original_history_preinstall_gate as gate
from scripts import qa_v02110_primary_pharmacy_migration as custody


class OriginalLiveCursorRebaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        original = Path(os.environ["APPDATA"]) / gate.HISTORY_QA_IDENTIFIER / "pharma_local.db"
        if not gate._pinned_source(original):
            raise RuntimeError("Cannot test without an independently pinned original archive")
        cls.original = original.read_bytes()
        cls.sqlx69 = custody.checked_file(
            custody.disposable_root() / stage.V69_FOLDER / stage.V69_NAME,
            stage.V69_SHA)
        cls.synthetic_live = cls.edited(
            cls.original,
            "UPDATE sqlite_sequence SET seq=4843 WHERE name='accounts'",
        )

    @staticmethod
    def edited(raw: bytes, sql: str) -> bytes:
        with sqlite3.connect(":memory:") as db:
            db.deserialize(raw)
            db.execute(sql)
            db.commit()
            return db.serialize()

    def test_upward_account_cursor_preserves_every_original_business_row(self):
        with rebase._ram(self.original) as a, rebase._ram(self.synthetic_live) as b:
            result = rebase.compare_business_identical(a, b)
        self.assertEqual(result["original_business_and_physical_history_rows_equal"], 289_753)
        self.assertEqual(result["original_accounts_sequence"], 4829)
        self.assertEqual(result["live_accounts_sequence"], 4843)
        changed, witness = rebase.rebased_candidate(
            self.original, self.synthetic_live, self.sqlx69)
        self.assertEqual(witness["native_receipts_or_business_records_invented"], False)
        self.assertFalse(witness["production_installation_authorized"])
        with rebase._ram(changed) as candidate:
            self.assertEqual(
                candidate.execute("SELECT COUNT(*),MAX(version) FROM _sqlx_migrations").fetchone(),
                (69, 69))
            self.assertEqual(
                candidate.execute("SELECT seq FROM sqlite_sequence WHERE name='accounts'").fetchone(),
                (4843,))
            self.assertEqual(
                candidate.execute("SELECT COUNT(*) FROM native_primary_scope_audit_batches").fetchone(),
                (1,))

    def test_change_to_original_sale_total_is_never_dismissed_as_sequence_noise(self):
        corrupted = self.edited(
            self.synthetic_live,
            "UPDATE sales_invoices SET total_amount=total_amount+0.01 "
            "WHERE rowid=(SELECT MIN(rowid) FROM sales_invoices)",
        )
        with rebase._ram(self.original) as a, rebase._ram(corrupted) as b:
            with self.assertRaisesRegex(rebase.Refused, "economic/source row"):
                rebase.compare_business_identical(a, b)

    def test_any_other_autoincrement_sequence_change_is_refused(self):
        with rebase._ram(self.original) as db:
            other = db.execute(
                "SELECT name FROM sqlite_sequence WHERE name!='accounts' ORDER BY name LIMIT 1"
            ).fetchone()[0]
        # Fixed identifier originates in the sealed original SQLite metadata,
        # never customer/renderer SQL input.
        corrupted = self.edited(
            self.synthetic_live,
            f"UPDATE sqlite_sequence SET seq=seq+1 WHERE name='{other}'",
        )
        with rebase._ram(self.original) as a, rebase._ram(corrupted) as b:
            with self.assertRaisesRegex(rebase.Refused, "AUTOINCREMENT source changed"):
                rebase.compare_business_identical(a, b)

    def test_backward_autoincrement_and_new_schema_are_refused(self):
        old_cursor = self.edited(
            self.original,
            "UPDATE sqlite_sequence SET seq=4828 WHERE name='accounts'",
        )
        with rebase._ram(self.original) as a, rebase._ram(old_cursor) as b:
            with self.assertRaisesRegex(rebase.Refused, "AUTOINCREMENT source changed"):
                rebase.compare_business_identical(a, b)
        schema_changed = self.edited(
            self.synthetic_live, "CREATE TABLE unapproved_added_business_table(id TEXT)"
        )
        with rebase._ram(self.original) as a, rebase._ram(schema_changed) as b:
            with self.assertRaisesRegex(rebase.Refused, "schema changed"):
                rebase.compare_business_identical(a, b)

    def test_missing_legacy_scope_audit_cannot_become_authorized_candidate(self):
        # SQLx69 itself installs an immutable-audit trigger, so even a
        # synthetic in-memory attacker cannot delete the signed-status
        # audit marker with ordinary SQL. This is stronger than reaching
        # the importer-level missing-audit check.
        with self.assertRaisesRegex(sqlite3.IntegrityError, "audit batch immutable"):
            self.edited(self.sqlx69, "DELETE FROM native_primary_scope_audit_batches")

    def test_qa_postflight_refuses_paths_and_tokens_instead_of_opening_arbitrary_files(self):
        for bad in ("", "../com.pharma.system", "0" * 31, "F" * 32,
                    "0" * 32 + "/pharma_local.db", "C:/Windows/System32"):
            with self.subTest(token=bad):
                with self.assertRaisesRegex(rebase.Refused, "Malformed isolated"):
                    rebase.verify_token(bad)
        with self.assertRaises((rebase.Refused, FileNotFoundError)):
            rebase.verify_token("0" * 32)


if __name__ == "__main__":
    unittest.main()
