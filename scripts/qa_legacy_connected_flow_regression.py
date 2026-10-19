#!/usr/bin/env python3
"""Headless, purely in-memory connected legacy-source 065+066 acceptance.

Run: python -m unittest -v scripts.qa_legacy_connected_flow_regression
Never accesses QA/archive DB paths or emits production evidence. Fixture
approvals/tenants are deliberately synthetic; mapping is evidence only, NOT
financial posting or authorized historic tenant reattribution.
"""
from __future__ import annotations

import sqlite3
import unittest

from scripts.qa_legacy_connected_flow import (
    ALL_HISTORY_TABLES, SOURCE_IDS, FlowRejected, build_connected_memory,
    connected_sources, map_synthetic_evidence, record_map_digest,
    typed, typed_record_map, validate_connected_graph,
)
from scripts.qa_legacy_upgrade_mapping_matrix_065 import (
    MANIFEST, MAPPING, SEAL, trusted_synthetic_bundle,
)


class LegacyConnectedFlowRegression(unittest.TestCase):
    def setUp(self) -> None:
        self.db = build_connected_memory()
        self.before = typed_record_map(self.db)
        self.before_sha = record_map_digest(self.before)
        self.sources = connected_sources(self.db)

    def tearDown(self) -> None:
        self.db.close()

    def assert_sources_preserved(self) -> None:
        after = typed_record_map(self.db)
        self.assertEqual(after, self.before, "original typed row-level history changed")
        self.assertEqual(record_map_digest(after), self.before_sha)
        self.assertEqual(self.db.execute("PRAGMA integrity_check").fetchone(), ("ok",))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def assert_empty_evidence(self) -> None:
        for table in (
            "native_legacy_upgrade_manifests",
            "native_legacy_upgrade_source_mappings",
            "native_legacy_upgrade_manifest_seals",
        ):
            self.assertEqual(self.db.execute(f"SELECT count(*) FROM {table}").fetchone(), (0,))
        self.assertEqual(self.db.execute(
            "SELECT count(*) FROM native_legacy_upgrade_authorized_sources"
        ).fetchone(), (0,))

    def mutate_then_rollback(self, sql: str, code: str) -> None:
        self.db.execute("SAVEPOINT negative_probe")
        try:
            self.db.execute(sql)
            with self.assertRaisesRegex(FlowRejected, code):
                validate_connected_graph(self.db)
        finally:
            self.db.execute("ROLLBACK TO negative_probe")
            self.db.execute("RELEASE negative_probe")
        validate_connected_graph(self.db)
        self.assert_sources_preserved()
        self.assert_empty_evidence()

    def test_01_connected_originals_mapping_preserves_every_typed_record(self) -> None:
        validate_connected_graph(self.db)
        self.assertEqual(len(SOURCE_IDS), 11, "all 065 source families exercised")
        self.assertGreaterEqual(len(self.sources), 18)
        self.assertIn("native_patient_wallet_topup_receipts", ALL_HISTORY_TABLES)
        self.assertIn("supplier_payments", ALL_HISTORY_TABLES)
        self.assertEqual(self.before["inventory"][typed("lot-connected")][
            [name for name, _ in self.before["inventory"][typed("lot-connected")]].index("pharmacy_id")
        ][1], typed(None), "null source ownership remains explicitly null")
        self.assertEqual(self.before["purchase_orders"][typed("order-connected")][
            [name for name, _ in self.before["purchase_orders"][typed("order-connected")]].index("pharmacy_id")
        ][1], typed(" "), "blank ownership literal must retain its exact space")
        bundle = map_synthetic_evidence(self.db, self.sources)
        self.assertEqual(len(bundle.mappings), len(self.sources))
        self.assertEqual(self.db.execute(
            "SELECT count(*) FROM native_legacy_upgrade_authorized_sources"
        ).fetchone(), (len(self.sources),))
        mapped = {
            (table, record_id): (identity, literal, source_sha)
            for table, record_id, identity, literal, source_sha in self.db.execute(
                "SELECT source_table,source_record_id,original_identity_class,"
                "original_pharmacy_literal,source_snapshot_sha256 "
                "FROM native_legacy_upgrade_source_mappings"
            )
        }
        self.assertEqual(len(mapped), len(self.sources))
        self.assertIn(("inventory", "lot-connected"), mapped)
        self.assertIn(("daily_journals", "journal-wallet"), mapped)
        self.assertEqual(mapped[("inventory", "lot-connected")][:2], ("null", None))
        self.assertEqual(mapped[("purchase_orders", "order-connected")][:2], ("blank", " "))
        validate_connected_graph(self.db)
        self.assert_sources_preserved()
        # A SQLite evidence view and test-key HMACs cannot establish actual
        # historic pharmacy ownership, consent or payment authorization.

    def test_02_foreign_and_orphan_links_fail_closed_before_any_claim(self) -> None:
        for sql, code in (
            ("UPDATE suppliers SET pharmacy_id='branch-b' WHERE id='supplier-synthetic'",
             "purchase_lot_supplier_link"),
            ("UPDATE inventory SET pharmacy_id='branch-b' WHERE id='lot-connected'",
             "foreign_source_pharmacy"),
            ("UPDATE purchase_invoices SET supplier_id='absent' WHERE id='purchase-connected'",
             "purchase_lot_supplier_link"),
            ("UPDATE purchase_invoice_items SET invoice_id='missing' WHERE id='pii-connected'",
             "purchase_lot_supplier_link"),
            ("UPDATE sales_items SET invoice_id='missing' WHERE id='sale-line-connected'",
             "sale_return_lot_patient_conversion_link"),
            ("UPDATE sales_invoices SET patient_id='missing' WHERE id='sale-connected'",
             "sale_return_lot_patient_conversion_link"),
            ("UPDATE returns SET invoice_id='missing' WHERE id='return-connected'",
             "sale_return_lot_patient_conversion_link"),
            ("UPDATE return_items SET sale_item_id='missing' WHERE id='return-line-connected'",
             "sale_return_lot_patient_conversion_link"),
            ("UPDATE inventory SET expiry_date='2000-01-01' WHERE id='lot-connected'",
             "purchase_lot_supplier_link"),
            ("UPDATE inventory SET strips_per_box=10 WHERE id='lot-connected'",
             "sale_return_lot_patient_conversion_link"),
            ("UPDATE sales_items SET quantity_sold=25 WHERE id='sale-line-connected'",
             "sale_return_lot_patient_conversion_link"),
            ("UPDATE inventory SET quantity=12 WHERE id='lot-connected'",
             "stock_unit_conservation"),
            ("INSERT INTO sales_items VALUES('orphan-line','sale-missing','lot-connected',77,1,'medium',12,10,10)",
             "unclaimed_sales_items"),
            ("INSERT INTO purchase_invoice_items VALUES('orphan-purchase','missing','lot-connected',77,1,10)",
             "unclaimed_purchase_invoice_items"),
        ):
            with self.subTest(code=code, sql=sql):
                self.mutate_then_rollback(sql, code)

    def test_03_financial_wallet_cash_shift_supplier_journal_orphans_fail_closed(self) -> None:
        for sql, code in (
            ("UPDATE native_patient_wallet_topup_receipts SET actor_id='owner-b-1'",
             "wallet_cash_shift_journal_witness"),
            ("UPDATE native_patient_wallet_topup_receipts SET amount_cents=9999",
             "wallet_cash_shift_journal_witness"),
            ("UPDATE native_patient_wallet_topup_receipts SET journal_id='missing'",
             "wallet_cash_shift_journal_witness"),
            ("UPDATE cash_movements SET shift_id='missing' WHERE id='cash-wallet'",
             "wallet_cash_shift_journal_witness"),
            ("UPDATE shifts SET pharmacy_id='branch-b' WHERE id='shift-synthetic'",
             "wallet_cash_shift_journal_witness"),
            ("UPDATE cash_movements SET amount=99 WHERE id='cash-wallet'",
             "wallet_cash_shift_journal_witness"),
            ("UPDATE patients SET wallet_balance=65 WHERE id='patient-synthetic'",
             "wallet_receipt_sale_return_conservation"),
            ("UPDATE supplier_payments SET invoice_id='unknown'",
             "supplier_payment_cash_journal_link"),
            ("UPDATE cash_movements SET amount=-35 WHERE id='cash-supplier'",
             "supplier_payment_cash_journal_link"),
            ("UPDATE cash_movements SET amount=-6 WHERE id='cash-expense'",
             "expense_cash_journal_link"),
            ("UPDATE shifts SET closing_cash=64 WHERE id='shift-synthetic'",
             "shift_cash_conservation"),
            ("UPDATE journal_entries SET amount_cents=2500 WHERE id='journal-sale-2'",
             "original_journal_entries_journal-sale"),
            ("DELETE FROM journal_entries WHERE id='journal-wallet-1'",
             "original_journal_entries_journal-wallet"),
            ("INSERT INTO journal_entries VALUES('orphan-entry','missing-journal','1.1.1','debit',1)",
             "unclaimed_journal_entries"),
        ):
            with self.subTest(code=code, sql=sql):
                self.mutate_then_rollback(sql, code)

    def test_04_exact_065_066_seal_blocks_source_money_tenant_stock_and_replace(self) -> None:
        validate_connected_graph(self.db)
        map_synthetic_evidence(self.db, self.sources)
        for table, ids in SOURCE_IDS.items():
            record_id = ids[0]
            with self.subTest(table=table):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(f"UPDATE {table} SET payload='tampered' WHERE CAST(id AS TEXT)=?",
                                    (record_id,))
                with self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(
                        f"UPDATE {table} SET pharmacy_id='branch-b' WHERE CAST(id AS TEXT)=?",
                        (record_id,))
                with self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(f"DELETE FROM {table} WHERE CAST(id AS TEXT)=?", (record_id,))
        for sql in (
            "UPDATE inventory SET quantity=9999 WHERE id='lot-connected'",
            "UPDATE purchase_invoices SET total_amount=1 WHERE id='purchase-connected'",
            "UPDATE sales_invoices SET total_amount=1 WHERE id='sale-connected'",
            "UPDATE returns SET total_refund=1 WHERE id='return-connected'",
            "UPDATE daily_journals SET total_amount=1 WHERE id='journal-wallet'",
            "UPDATE cash_movements SET amount=1 WHERE id='cash-wallet'",
            "UPDATE expenses SET amount=1 WHERE id='expense-connected'",
            "INSERT OR REPLACE INTO inventory(id,pharmacy_id,payload) "
            "VALUES('lot-connected','branch-b','rewritten lot')",
        ):
            with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(sql)
        validate_connected_graph(self.db)
        self.assert_sources_preserved()

    def test_05_partial_mapping_then_bad_foreign_claim_rolls_back_entire_flow(self) -> None:
        validate_connected_graph(self.db)
        bundle = trusted_synthetic_bundle(self.db, self.sources)
        self.db.execute("BEGIN IMMEDIATE")
        try:
            self.db.execute(MANIFEST, bundle.manifest_params)
            self.db.execute(MAPPING, bundle.mappings[0])
            bad = list(bundle.mappings[1])
            bad[3] = "explicit"
            bad[4] = "branch-b"
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(MAPPING, bad)
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(SEAL, bundle.seal_params)
        finally:
            self.db.execute("ROLLBACK")
        self.assert_empty_evidence()
        self.assert_sources_preserved()
        map_synthetic_evidence(self.db, self.sources)
        self.assert_sources_preserved()

    def test_06_restart_from_in_memory_backup_rechecks_all_original_rows(self) -> None:
        validate_connected_graph(self.db)
        map_synthetic_evidence(self.db, self.sources)
        successor = sqlite3.connect(":memory:", isolation_level=None)
        try:
            self.db.backup(successor)
            self.db.close()
            self.db = successor
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.execute("PRAGMA recursive_triggers=OFF")
            successor = None
            validate_connected_graph(self.db)
            self.assert_sources_preserved()
            self.assertEqual(self.db.execute(
                "SELECT count(*) FROM native_legacy_upgrade_authorized_sources"
            ).fetchone(), (len(self.sources),))
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(
                    "UPDATE cash_movements SET amount=9999 WHERE id='cash-wallet'"
                )
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(
                    "UPDATE inventory SET quantity=9999 WHERE id='lot-connected'"
                )
            self.assert_sources_preserved()
        finally:
            if successor is not None:
                successor.close()

    def test_07_unmapped_connected_details_need_external_typed_parity(self) -> None:
        # The real 065+066 source table whitelist does not include the linked
        # journal_entries, patient, supplier or receipt detail tables. They
        # must be independently included in before/after acceptance; the
        # SQLite mapping VIEW alone is insufficient financial proof.
        validate_connected_graph(self.db)
        map_synthetic_evidence(self.db, self.sources)
        for sql, code in (
            ("UPDATE journal_entries SET amount_cents=1 WHERE id='journal-sale-2'",
             "original_journal_entries_journal-sale"),
            ("UPDATE patients SET wallet_balance=99 WHERE id='patient-synthetic'",
             "wallet_receipt_sale_return_conservation"),
            ("UPDATE suppliers SET pharmacy_id='branch-b' WHERE id='supplier-synthetic'",
             "purchase_lot_supplier_link"),
            ("INSERT INTO journal_entries VALUES('unclaimed','missing','4.1','debit',1)",
             "unclaimed_journal_entries"),
        ):
            with self.subTest(code=code):
                self.db.execute("SAVEPOINT test_unmapped_history")
                try:
                    # The unprotected auxiliary row physically changes. An
                    # external test-owned typed source map catches even a
                    # still-balanced-but-changed original journal witness.
                    self.db.execute(sql)
                    with self.assertRaisesRegex(FlowRejected, code):
                        validate_connected_graph(self.db)
                    with self.assertRaises(AssertionError):
                        self.assert_sources_preserved()
                finally:
                    self.db.execute("ROLLBACK TO test_unmapped_history")
                    self.db.execute("RELEASE test_unmapped_history")
                validate_connected_graph(self.db)
                self.assert_sources_preserved()


if __name__ == "__main__":
    print("SYNTHETIC :memory: LEGACY 065+066; NOT HISTORIC OWNERSHIP OR MONEY AUTHORIZATION")
    unittest.main()
