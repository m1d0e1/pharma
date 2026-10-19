"""Detached original-history finance and QA recovery refusal regressions."""
from __future__ import annotations

import os
from pathlib import Path
import sqlite3
import unittest

from scripts import qa_original_history_financial_acceptance as financial
from scripts import qa_original_history_atomic_rehearsal as atomic
from scripts import qa_original_history_owner_readiness as owner
from scripts import qa_original_history_legacy_source_links as links
from scripts import qa_original_history_private_review_index as private_review
from scripts import qa_original_history_payment_linkage as payment
from scripts import qa_original_history_process_crash_recovery as process_crash
from scripts import qa_original_history_supplier_ap_reconciliation as supplier_ap
from scripts import qa_original_history_preinstall_gate as preinstall
from scripts import qa_original_history_cash_tender_transition as cash_tender
from scripts import qa_v02110_primary_pharmacy_migration as guard


class HistoricalCompletionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = guard.checked_file(guard.disposable_root() / financial.STAGE / financial.NAME,
                                     financial.PIN)

    def in_memory(self):
        db = sqlite3.connect(":memory:")
        db.deserialize(self.raw)
        return db

    def test_financial_audit_does_not_mistake_balanced_journals_for_receipts(self):
        with self.in_memory() as db:
            result = financial.check(db)
        self.assertEqual(result["status"], "BLOCKED_LEGACY_FINANCIAL_PROVENANCE_NOT_CERTIFIED")
        self.assertEqual(result["balanced_historical_journals"], 1856)
        self.assertEqual(result["typed_source_scope_witnesses"], 7567)
        self.assertEqual(result["financial_native_receipt_census"]["native_sale_cogs_provenance"]["native_receipts"], 0)
        self.assertFalse(result["production_allowed"])

    def test_financial_audit_rejects_tampered_historical_journal(self):
        with self.in_memory() as db:
            db.execute("UPDATE journal_entries SET amount=amount+1 WHERE rowid=(SELECT MIN(rowid) FROM journal_entries)")
            with self.assertRaisesRegex(ValueError, "double entry"):
                financial.check(db)

    def test_financial_audit_rejects_manufactured_owner_attestation(self):
        with self.in_memory() as db:
            db.execute("UPDATE users SET password_hash='invalid-test-hash' WHERE id='admin'")
            with self.assertRaisesRegex(ValueError, "owner quarantine"):
                financial.check(db)

    def test_sqlx69_cannot_be_mislabeled_as_sqlx68_during_qa_recovery(self):
        with self.assertRaisesRegex(atomic.Refused, "valid source version"):
            atomic.staged_sqlite(self.raw, 68)

    def test_qa_recovery_classifier_requires_unambiguous_pinned_versions(self):
        self.assertIn("RESTORE_FIRST", atomic.classify_qa_interruption(None, "v68", "v69"))
        self.assertIn("UNACCEPTED", atomic.classify_qa_interruption("v69", "v68", None))
        for state in ((None, None, "v69"), ("v69", None, None),
                      ("v69", "v69", None), ("v68", "v68", "v69"),
                      ("v68", "v69", None), (None, None, None)):
            with self.subTest(state=state):
                with self.assertRaisesRegex(atomic.Refused, "Ambiguous interrupted QA"):
                    atomic.classify_qa_interruption(*state)

    def test_crash_worker_cannot_accept_arbitrary_absolute_paths_or_tokens(self):
        for bad in ('', '../com.pharma.system', '0' * 31, 'F' * 32,
                    '0' * 32 + '/pharma_local.db'):
            with self.subTest(bad=bad):
                with self.assertRaisesRegex(atomic.Refused, 'token is malformed'):
                    process_crash.qa_folder_from_token(bad)

    def test_qa_write_through_rename_rejects_other_profile_or_volume(self):
        from pathlib import Path
        with self.assertRaisesRegex(atomic.Refused, 'restricted to same-folder QA'):
            atomic.win32_qa_rename_write_through(
                Path('C:/other/pharma_local.db'), Path('C:/other/QA_ACTIVE.sqlite3'))
        with self.assertRaisesRegex(atomic.Refused, 'restricted to same-folder QA'):
            atomic.win32_qa_rename_write_through(
                Path('C:/qa/QA_ACTIVE.sqlite3'), Path('D:/qa/QA_ROLLBACK.sqlite3'))

    def test_original_owner_is_not_ready_for_live_login(self):
        with self.in_memory() as db:
            result = owner.check(db)
        self.assertTrue(result["password_still_quarantined"])
        self.assertFalse(result["production_authorized"])

    def test_original_source_links_are_evidence_not_financial_release(self):
        with self.in_memory() as db:
            result = links.check(db)
        self.assertEqual(result["source_link_counts"]["purchase_invoice_supplier_ledger_exact_amount"], 101)
        self.assertEqual(result["sale_lines_without_inventory_lot_reference"], 8)
        self.assertEqual(result["supplier_payment_rows_without_matching_purchase_invoice_reference"], 9)
        self.assertFalse(result["production_allowed"])
        self.assertFalse(result["supplier_payment_allocation_certified"])

    def test_private_review_index_never_grants_source_authorization(self):
        with self.in_memory() as db:
            index = private_review.build_index(db)
        self.assertEqual(len(index["sale_lines_missing_inventory_id"]), 8)
        self.assertEqual(len(index["supplier_payments_with_standalone_generated_references"]), 9)
        self.assertEqual(index['format'], 'pharma.legacy-financial-private-review-index.v3')
        self.assertEqual(len(index['original_cash_sales_without_shift_private_owner_review']), 533)
        self.assertEqual(len(index['original_sale_returns_without_shift_private_owner_review']), 14)
        self.assertEqual(len(index['original_shift_discrepancies_private_owner_review']), 16)
        self.assertFalse(index['unshifted_legacy_sales_or_refunds_require_shift_id_repair'])
        self.assertEqual(index['original_pre_shift_era_census_verified']['all_original_sales_without_shift'], 575)
        self.assertTrue(index['all_three_historical_supplier_ap_balances_internal_math_reconciled'])
        self.assertEqual(index['owner_source_evidence_review_status'],
                         'PENDING_EXTERNAL_ORIGINAL_DOCUMENT_RECONCILIATION')
        self.assertFalse(index["owner_authorized_production_migration"])
        self.assertFalse(index["legacy_financial_certified"])

    def test_patient_payment_cash_aggregate_date_amount_matches_without_receipt_authorization(self):
        with self.in_memory() as db:
            result = payment.check(db)
        count = result["witness_counts"]
        self.assertEqual(count["patient_payment_transactions"], 49)
        self.assertEqual(count["cash_marked_patient_payment"], 49)
        self.assertEqual(count["patient_cash_amount_date_unmatched_groups"], 0)
        self.assertEqual(count["sale_no_inventory_negative_lines"], 7)
        self.assertEqual(count["sale_no_inventory_regular_lines"], 1)
        self.assertFalse(result["production_allowed"])
        self.assertFalse(result["historic_opening_balances_certified"])

    def test_patient_cash_date_amount_source_mismatch_is_rejected(self):
        with self.in_memory() as db:
            db.execute("UPDATE cash_movements SET amount=amount+0.25 "
                       "WHERE rowid=(SELECT MIN(rowid) FROM cash_movements "
                       "WHERE source_type='patient_payment')")
            with self.assertRaisesRegex(ValueError, "payment/date/lot link"):
                payment.check(db)

    def test_original_supplier_closing_balances_reconcile_without_native_receipts(self):
        with self.in_memory() as db:
            result = supplier_ap.check(db)
        self.assertEqual(result['source_counts']['supplier_accounts_balanced'], 3)
        self.assertEqual(result['source_counts']['supplier_payments_standalone_positive_receipt_refs'], 9)
        self.assertEqual(result['source_counts']['supplier_payments_invoice_linked_negative_refs'], 11)
        self.assertTrue(result['all_supplier_closing_balance_formulas_match'])
        self.assertFalse(result['external_supplier_receipts_independently_certified'])
        self.assertFalse(result['production_allowed'])

    def test_original_supplier_closing_balance_detects_payment_amount_tampering(self):
        with self.in_memory() as db:
            db.execute("UPDATE supplier_transactions SET amount=amount+0.5 "
                       "WHERE id=(SELECT MIN(id) FROM supplier_transactions WHERE type='payment' AND amount>0)")
            with self.assertRaisesRegex(ValueError, 'closing balance'):
                supplier_ap.check(db)

    def test_original_supplier_closing_balance_detects_sign_tampering(self):
        with self.in_memory() as db:
            db.execute("UPDATE supplier_transactions SET amount=-amount "
                       "WHERE id=(SELECT MIN(id) FROM supplier_transactions WHERE type='payment' AND amount<0)")
            with self.assertRaisesRegex(ValueError, 'reference/sign'):
                supplier_ap.check(db)

    def test_patient_wallet_balance_tampering_breaks_amount_multiset(self):
        with self.in_memory() as db:
            db.execute('UPDATE patients SET wallet_balance=wallet_balance+0.5 '
                       'WHERE id=(SELECT id FROM patients WHERE wallet_balance>0 LIMIT 1)')
            with self.assertRaisesRegex(ValueError, 'payment/date/lot link'):
                payment.check(db)

    def test_installer_must_not_treat_ledger_internal_consistency_as_release(self):
        # The customer may open the live PHARMA app during detached QA:
        # SQLite can legitimately advance its local sqlite_sequence without
        # changing any historic economic row. Never coerce that evolving
        # installed file to the frozen original SHA for a passing regression.
        live = Path(os.environ['APPDATA']) / 'com.pharma.system' / 'pharma_local.db'
        result = preinstall.check()
        self.assertTrue(
            result['current_installed_v29_business_and_physical_rows_identical_to_archived_original'])
        self.assertTrue(
            result['live_source_business_equivalence_is_not_import_or_financial_authorization'])
        if not preinstall._pinned_source(live):
            self.assertFalse(result['original_installed_source_unchanged'])
            self.assertTrue(result['live_source_metadata_sequence_only_drift'])
            self.assertGreaterEqual(result['live_accounts_autoincrement_source_cursor'], 4829)
        self.assertTrue(result['historical_supplier_ap_internal_balances_reconciled'])
        self.assertFalse(result['native_verified_qa_online_license_and_activation_proof'])
        self.assertFalse(result['verified_source_bound_historical_offline_import_grant'])
        self.assertTrue(result['ordinary_customer_offline_license_is_not_an_original_history_import_grant'])
        self.assertFalse(result['original_owner_authenticated_on_historical_qa_profile'])
        self.assertFalse(result['legacy_opening_balance_transition_independently_certified'])
        self.assertFalse(result['production_upgrade_allowed'])

    def test_original_cash_tender_source_witnesses_do_not_certify_payment_receipts(self):
        with self.in_memory() as db:
            result = cash_tender.check(db)
        self.assertEqual(result['money_cents_and_rows']['original_completed_cash_sales'],
                         {'rows': 1398, 'cents': 11072049})
        self.assertEqual(result['original_unattributed_counts']['original_cash_sale_without_shift'], 533)
        self.assertEqual(result['original_unattributed_counts']['original_return_without_shift'], 14)
        self.assertEqual(result['original_unattributed_counts']['original_shift_discrepancy_status'], 16)
        self.assertEqual(result['first_recorded_original_pharmacy_shift_started_at'],
                         '2026-08-13 07:15:45')
        self.assertEqual(result['verified_pre_shared_shift_source_census']['all_original_sales_without_shift_and_before_first_shift'], 575)
        self.assertEqual(result['verified_pre_shared_shift_source_census']['original_returns_without_shift_and_before_first_shift'], 14)
        self.assertFalse(result['historical_shift_ids_retroactively_created'])
        self.assertFalse(result['historical_sales_and_refund_tenders_independently_posted'])
        self.assertFalse(result['production_allowed'])

    def test_original_cash_sale_amount_tampering_is_refused(self):
        with self.in_memory() as db:
            db.execute("UPDATE sales_invoices SET total_amount=total_amount+0.25 "
                       "WHERE id=(SELECT MIN(id) FROM sales_invoices "
                       "WHERE payment_method='cash' AND status='completed')")
            with self.assertRaisesRegex(ValueError, 'tender/cash financial witness'):
                cash_tender.check(db)

    def test_original_return_shift_attribution_tampering_is_refused(self):
        with self.in_memory() as db:
            db.execute("UPDATE returns SET shift_id=NULL WHERE id=(SELECT MIN(id) "
                       "FROM returns WHERE shift_id IS NOT NULL)")
            with self.assertRaisesRegex(ValueError, 'tender/shift/AR witness'):
                cash_tender.check(db)

    def test_original_pre_shift_sale_chronology_tampering_is_refused_without_rewriting_links(self):
        with self.in_memory() as db:
            db.execute("UPDATE sales_invoices SET created_at='2026-09-20 12:00:00' "
                       "WHERE id=(SELECT MIN(id) FROM sales_invoices "
                       "WHERE shift_id IS NULL AND payment_method='cash' AND status='completed')")
            with self.assertRaisesRegex(ValueError, 'pre-shared-shift historical chronology'):
                cash_tender.check(db)

    def test_original_pre_shift_return_chronology_tampering_is_refused(self):
        with self.in_memory() as db:
            db.execute("UPDATE returns SET created_at='2026-09-20 12:00:00' "
                       "WHERE id=(SELECT MIN(id) FROM returns WHERE shift_id IS NULL)")
            with self.assertRaisesRegex(ValueError, 'pre-shared-shift historical chronology'):
                cash_tender.check(db)

    def test_patient_cash_date_source_mismatch_is_rejected(self):
        with self.in_memory() as db:
            db.execute("UPDATE cash_movements SET date='1900-01-01' "
                       "WHERE rowid=(SELECT MIN(rowid) FROM cash_movements "
                       "WHERE source_type='patient_payment')")
            with self.assertRaisesRegex(ValueError, "payment/date/lot link"):
                payment.check(db)

    def test_supplier_payment_classification_tampering_is_rejected(self):
        with self.in_memory() as db:
            db.execute("UPDATE supplier_transactions SET payment_method='card' "
                       "WHERE id=(SELECT MIN(t.id) FROM supplier_transactions t "
                       "WHERE t.type='payment' AND NOT EXISTS (SELECT 1 FROM purchase_invoices i "
                       "WHERE i.id=t.reference_id AND i.supplier_id=t.supplier_id))")
            with self.assertRaisesRegex(ValueError, "payment/date/lot link"):
                payment.check(db)

    def test_legacy_link_rejects_changed_purchase_invoice_amount(self):
        with self.in_memory() as db:
            db.execute("UPDATE supplier_transactions SET amount=amount+1 WHERE id=(SELECT MIN(id) FROM supplier_transactions WHERE type='invoice')")
            with self.assertRaisesRegex(ValueError, "legacy financial link counts"):
                links.check(db)

    def test_legacy_link_rejects_unattributed_extra_sale_lot(self):
        with self.in_memory() as db:
            db.execute("UPDATE sales_items SET inventory_id=NULL WHERE id=(SELECT MIN(id) FROM sales_items WHERE inventory_id IS NOT NULL)")
            with self.assertRaisesRegex(ValueError, "legacy financial link counts"):
                links.check(db)

    def test_legacy_link_rejects_changed_return_supplier_amount(self):
        with self.in_memory() as db:
            db.execute("UPDATE supplier_transactions SET amount=amount+1 WHERE id=(SELECT MIN(id) FROM supplier_transactions WHERE type='return')")
            with self.assertRaisesRegex(ValueError, "legacy financial link counts"):
                links.check(db)

    def test_legacy_link_rejects_changed_journal_header_total(self):
        with self.in_memory() as db:
            db.execute("UPDATE daily_journals SET total_amount=total_amount+1 WHERE rowid=(SELECT MIN(rowid) FROM daily_journals)")
            with self.assertRaisesRegex(ValueError, "legacy financial link counts"):
                links.check(db)


if __name__ == "__main__":
    unittest.main()
