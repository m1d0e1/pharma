"""Isolated negative witnesses for the pinned native purchase identity audit."""

import runpy
import sqlite3
import unittest
from pathlib import Path
import json
from decimal import Decimal


AUDITOR = runpy.run_path(str(Path(__file__).with_name('qa-background-purchase-stock.py')))
SOURCE = AUDITOR['SOURCE']
ASSERT_IDENTITY = AUDITOR['assert_purchase_identity']


class PurchaseIdentityTamperTests(unittest.TestCase):
    def setUp(self):
        self.source = sqlite3.connect(SOURCE.as_uri() + '?mode=ro', uri=True)
        self.source.execute('PRAGMA query_only=ON')
        self.clone = sqlite3.connect(':memory:')
        self.source.backup(self.clone)

    def tearDown(self):
        self.clone.close()
        self.source.close()

    def test_unmodified_source_identity(self):
        self.assertEqual(ASSERT_IDENTITY(self.clone)['invoice_cents'], 35000)

    def test_inventory_debit_account_cannot_become_an_expense(self):
        self.clone.execute("UPDATE accounts SET type='expense' WHERE code='1.1.3'")
        with self.assertRaises(AssertionError):
            ASSERT_IDENTITY(self.clone)

    def test_accounts_payable_credit_cannot_become_a_group(self):
        self.clone.execute("UPDATE accounts SET is_group=1 WHERE code='2.1'")
        with self.assertRaises(AssertionError):
            ASSERT_IDENTITY(self.clone)

    def test_posting_snapshot_tax_cannot_diverge_from_source_line(self):
        # Immutability is separately enforced in the real DB. Disable the
        # update guard ONLY inside this memory clone to test auditor detection.
        self.clone.execute('DROP TRIGGER native_purchase_event_no_update')
        event = self.clone.execute(
            'SELECT event_id,line_snapshot FROM native_purchase_posting_events'
        ).fetchone()
        lines = json.loads(event[1])
        lines[0]['tax'] = 12.5
        self.clone.execute(
            'UPDATE native_purchase_posting_events SET line_snapshot=? WHERE event_id=?',
            (json.dumps(lines), event[0])
        )
        with self.assertRaises(AssertionError):
            ASSERT_IDENTITY(self.clone)

    def test_current_synthetic_actor_cannot_be_moved_to_foreign_pharmacy(self):
        self.clone.execute("UPDATE users SET pharmacy_id='foreign_tenant' WHERE id='admin'")
        with self.assertRaises(AssertionError):
            ASSERT_IDENTITY(self.clone)

    def test_current_synthetic_actor_cannot_be_inactive(self):
        self.clone.execute("UPDATE users SET is_active=0 WHERE id='admin'")
        with self.assertRaises(AssertionError):
            ASSERT_IDENTITY(self.clone)

    def test_decimal_arithmetic_uses_precise_unit_multiplication(self):
        cents = AUDITOR['cents']
        self.assertEqual(cents(Decimal('35.02') * 10), 35020)
        self.assertEqual(cents((Decimal('46.01') - Decimal('35.02')) * 10), 10990)


if __name__ == '__main__':
    unittest.main()
