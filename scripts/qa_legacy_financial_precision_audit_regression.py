"""In-memory regression matrix; never connects to a customer or QA profile."""
from __future__ import annotations

from contextlib import closing
import json
import sqlite3
import unittest

from scripts.qa_historical_archive_manifest_regression import fixture
from scripts.qa_legacy_financial_precision_audit import financial_precision_counts
from scripts.legacy_pharmacy_upgrade import UnsafeSource


class FinancialPrecisionAuditRegression(unittest.TestCase):
    def test_balanced_legacy_fractional_cent_journal_is_reviewed_not_reposted(self):
        with closing(fixture()) as db:
            db.execute("UPDATE journal_entries SET amount=25.005")
            db.commit()
            original = db.serialize()
            report = financial_precision_counts(db)
            self.assertEqual(report["journal_headers"], 1)
            self.assertEqual(report["journal_entries"], 2)
            self.assertEqual(report["fractional_cent_entries"], 2)
            self.assertEqual(report["journals_with_fractional_cent_entries"], 1)
            self.assertEqual(report["journals_with_decimal_balancing_difference"], 0)
            self.assertEqual(report["journals_with_per_entry_cent_balancing_difference"], 0)
            self.assertFalse(report["financial_postings_created"])
            self.assertEqual(original, db.serialize())

    def test_cent_rounded_parity_can_hide_historical_raw_difference(self):
        with closing(fixture()) as db:
            db.execute("UPDATE journal_entries SET amount=25.003 WHERE id='debit'")
            db.execute("UPDATE journal_entries SET amount=25.004 WHERE id='credit'")
            db.commit()
            report = financial_precision_counts(db)
            self.assertEqual(report["journals_with_decimal_balancing_difference"], 1)
            self.assertEqual(report["journals_with_per_entry_cent_balancing_difference"], 0)
            self.assertEqual(report["journals_where_cent_parity_masks_decimal_difference"], 1)
            self.assertEqual(report["journals_where_decimal_parity_diverges_from_cent_parity"], 1)

    def test_decimal_balance_can_be_obscured_by_per_entry_cent_rounding(self):
        with closing(fixture()) as db:
            db.execute("DELETE FROM journal_entries")
            db.executemany("INSERT INTO journal_entries VALUES(?,?,?,?)", [
                ("debit1", "journal-1", "debit", 0.006),
                ("debit2", "journal-1", "debit", 0.006),
                ("credit", "journal-1", "credit", 0.012),
            ])
            report = financial_precision_counts(db)
            self.assertEqual(report["journals_with_decimal_balancing_difference"], 0)
            self.assertEqual(report["journals_with_per_entry_cent_balancing_difference"], 1)
            self.assertEqual(report["journals_where_decimal_parity_diverges_from_cent_parity"], 1)

    def test_malformed_and_negative_source_not_converted_into_a_receipt(self):
        with closing(fixture()) as db:
            db.execute("UPDATE journal_entries SET amount=-1 WHERE id='credit'")
            db.commit()
            report = financial_precision_counts(db)
            self.assertEqual(report["negative_journal_amount_entries"], 1)
            self.assertEqual(report["journals_with_invalid_side_or_amount"], 1)
            self.assertFalse(report["financial_source_provenance_verified"])

    def test_diagnostic_output_is_counts_only_and_source_unchanged(self):
        with closing(fixture()) as db:
            original = db.serialize()
            output = json.dumps(financial_precision_counts(db))
            self.assertEqual(original, db.serialize())
            for sensitive in ("PRIVATE CUSTOMER", "PRIVATE SUPPLIER",
                              "private-patient", "supplier-x", "journal-1",
                              "01000000000", "sale-2"):
                self.assertNotIn(sensitive, output)

    def test_unavailable_numeric_columns_remain_unreviewed(self):
        with closing(fixture()) as db:
            report = financial_precision_counts(db)
            self.assertEqual(report["source_numeric_classification"][
                "supplier_ledger_amount"]["unsupported_legacy_rows"], 1)
            self.assertEqual(report["source_numeric_classification"][
                "sale_total"]["unsupported_legacy_rows"], 2)

    def test_ieee_float_noise_does_not_falsely_create_subcent_finance_alarm(self):
        with closing(fixture()) as db:
            db.execute("UPDATE journal_entries SET amount=?",
                       (12.34 - 0.000000000000002,))
            report = financial_precision_counts(db)
            self.assertEqual(report["fractional_cent_entries"], 0)
            self.assertEqual(report["journals_with_decimal_balancing_difference"], 0)

    def test_orphan_journal_entries_refused_without_id_exposure(self):
        with closing(fixture()) as db:
            db.execute("INSERT INTO journal_entries VALUES('orphan','no-journal','debit',1)")
            with self.assertRaisesRegex(UnsafeSource, "historical_journal_orphan_entries"):
                financial_precision_counts(db)

    def test_extreme_numeric_is_not_decimal_quantized_or_accepted_as_financial_source(self):
        with closing(fixture()) as db:
            db.execute("UPDATE journal_entries SET amount=1e308 WHERE id='debit'")
            report = financial_precision_counts(db)
            self.assertEqual(report["journals_with_invalid_side_or_amount"], 1)
            self.assertEqual(report["journals_with_decimal_balancing_difference"], 0)
            self.assertFalse(report["financial_source_provenance_verified"])


if __name__ == "__main__":
    unittest.main()
