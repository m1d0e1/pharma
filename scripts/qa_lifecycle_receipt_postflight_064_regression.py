"""Independent RAM-only regression for the 064 lifecycle receipt postflight."""
from __future__ import annotations

from contextlib import closing
import json
import unittest

from scripts.qa_lifecycle_receipt_postflight_064 import (
    PostflightRefused, _synthetic_fixture, audit,
)


class LifecyclePostflight64Regression(unittest.TestCase):
    def test_full_064_synthetic_baseline_is_read_only_and_private(self) -> None:
        with closing(_synthetic_fixture()) as db:
            report = audit(db)
            self.assertTrue(report["post_064_accepted"])
            self.assertEqual(report["migration_count"], 64)
            self.assertEqual(report["owned_counts"]["journals"], 6)
            self.assertEqual(report["tenant_journal_entries"], 16)
            self.assertEqual(report["wallet_funding_060_count"], 1)
            self.assertEqual(report["supplier_payment_054_count"], 1)
            self.assertEqual(report["catalog_create_receipts"], 0)
            self.assertFalse(report["production_certified"])
            for private in ("purchase-source", "lot-source", "qa-patient-b", "journal-wallet"):
                self.assertNotIn(private, json.dumps(report))

    def test_063_snapshot_requires_opt_in_not_064_acceptance(self) -> None:
        with closing(_synthetic_fixture(pre_064=True)) as db:
            baseline = audit(db, pre_064=True)
            self.assertEqual(baseline["migration_count"], 63)
            self.assertFalse(baseline["post_064_accepted"])
        with closing(_synthetic_fixture(pre_064=True)) as db:
            with self.assertRaisesRegex(PostflightRefused, "migration_set_incorrect"):
                audit(db)

    def test_wrong_receipt_ledger_valuation_and_064_catalog_must_fail(self) -> None:
        changes = (
            ("UPDATE supplier_transactions SET reference_id='different'",
             "supplier_receipt_054_lineage"),
            ("UPDATE cash_movements SET amount=4",
             "wallet_060_cash_journal_witness"),
            ("UPDATE inventory SET cost_price=150",
             "owned_lot_value_and_quantity"),
            ("INSERT INTO native_master_drug_create_receipts VALUES('new')",
             "catalog_receipts_must_be_zero"),
            ("UPDATE journal_entries SET amount=9 WHERE journal_id='journal-wallet' "
             "AND type='credit'", "owned_journals_unbalanced_or_invalid"),
        )
        for sql, reason in changes:
            with self.subTest(reason=reason), closing(_synthetic_fixture()) as db:
                db.execute(sql)
                with self.assertRaisesRegex(PostflightRefused, reason):
                    audit(db)


if __name__ == "__main__":
    unittest.main()
