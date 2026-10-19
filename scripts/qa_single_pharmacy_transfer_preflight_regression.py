"""RAM-only single-pharmacy staging eligibility; never uses a QA/customer DB."""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import sqlite3
import unittest

from scripts.qa_historical_archive_manifest_regression import fixture
from scripts.qa_single_pharmacy_transfer_preflight import (
    assess_connection, check_tenant, scope_review,
)
from scripts.legacy_pharmacy_upgrade import UnsafeSource


class OnePharmacyPreflightMatrix(unittest.TestCase):
    def test_01_one_pharmacy_scope_with_incomplete_module_schema_is_not_a_transfer_candidate(self) -> None:
        with closing(fixture()) as db:
            # Repair the synthetic deliberately orphaned sale line, and
            # explicitly identify its other sale as the SAME target tenant.
            db.execute("DELETE FROM sales_items WHERE id='line-orphan'")
            db.execute(
                "UPDATE sales_invoices SET pharmacy_id='single-verified' "
                "WHERE id='sale-2'"
            )
            db.execute(
                "UPDATE sales_invoices SET patient_id='private-patient' WHERE id='sale-2'"
            )
            db.commit()
            original = db.serialize()
            pin = hashlib.sha256(original).hexdigest()
            report = assess_connection(db, tenant_id="single-verified",
                                       source_sha256=pin)
            self.assertEqual(db.serialize(), original)
            self.assertEqual(report["classification"],
                             "REFUSE_INCOMPLETE_HISTORICAL_MODULE_GRAPH")
            self.assertEqual(report["all_tables_covered"], 21)
            self.assertGreater(report["tenanted_scope_counts"]["null"], 0)
            self.assertGreater(report["tenanted_scope_counts"]["local_default"], 0)
            self.assertGreater(report["tenanted_scope_counts"]["unscoped_rows"], 0)
            self.assertEqual(report["tenanted_scope_counts"]["foreign_explicit"], 0)
            self.assertGreater(report["structural_findings"][
                "module_unmapped_layout_quarantined_rows"], 0)
            self.assertFalse(report["source_sha256_verified"])
            self.assertFalse(report["tenant_assigned"])
            self.assertFalse(report["safe_to_activate_or_import"])
            self.assertFalse(report["full_financial_provenance_certified"])
            self.assertEqual(report["source_mappings_created"], 0)
            rendered = json.dumps(report, ensure_ascii=False)
            for private in ("PRIVATE CUSTOMER", "PRIVATE SUPPLIER", "01000000000",
                            "private-patient", "supplier-x", "sale-2"):
                self.assertNotIn(private, rendered)

    def test_02_explicit_foreign_claim_disallows_bulk_one_tenant_transfer(self) -> None:
        with closing(fixture()) as db:
            original = db.serialize()
            report = assess_connection(db, tenant_id="single-verified",
                                       source_sha256=hashlib.sha256(original).hexdigest())
            self.assertEqual(report["classification"],
                             "REFUSE_EXPLICIT_SCOPE_CONFLICT")
            self.assertGreater(report["tenanted_scope_counts"]["foreign_explicit"], 0)
            self.assertEqual(db.serialize(), original)
            self.assertFalse(report["safe_to_activate_or_import"])

    def test_07_orphaned_accounting_module_parent_refuses_even_if_core_sale_links_are_intact(self) -> None:
        with closing(fixture()) as db:
            db.execute("DELETE FROM sales_items WHERE id='line-orphan'")
            db.execute("UPDATE sales_invoices SET pharmacy_id='single-verified'")
            db.execute("UPDATE sales_invoices SET patient_id='private-patient' WHERE id='sale-2'")
            db.execute("UPDATE inventory SET drug_id='absent-catalog-record'")
            db.commit()
            before = db.serialize()
            report = assess_connection(db, tenant_id="single-verified",
                                       source_sha256=hashlib.sha256(before).hexdigest())
            self.assertEqual(report["classification"],
                             "REFUSE_BROKEN_HISTORICAL_RELATIONSHIPS")
            self.assertEqual(report["structural_findings"]["broken_required_links"], 0)
            self.assertGreater(report["structural_findings"][
                "module_orphan_or_missing_parent_findings"], 0)
            self.assertEqual(before, db.serialize())

    def test_08_same_textual_identity_from_different_sqlite_storage_classes_refuses(self) -> None:
        with closing(fixture()) as db:
            db.execute("DELETE FROM sales_items WHERE id='line-orphan'")
            db.execute("UPDATE sales_invoices SET pharmacy_id='single-verified'")
            db.execute("UPDATE sales_invoices SET patient_id='private-patient' WHERE id='sale-2'")
            db.execute("CREATE TABLE unscoped_legacy_custom(id, preserved_payload TEXT)")
            db.execute("INSERT INTO unscoped_legacy_custom VALUES(1,'SECRET-A')")
            db.execute("INSERT INTO unscoped_legacy_custom VALUES('1','SECRET-B')")
            db.commit()
            before = db.serialize()
            report = assess_connection(db, tenant_id="single-verified",
                                       source_sha256=hashlib.sha256(before).hexdigest())
            self.assertEqual(report["classification"],
                             "REFUSE_AMBIGUOUS_TYPED_HISTORICAL_RECORD_GRAPH")
            self.assertEqual(report["full_typed_record_graph_findings"][
                "canonical_id_collision_rows"], 1)
            self.assertEqual(before, db.serialize())
            self.assertNotIn("SECRET-", json.dumps(report))

    def test_03_orphaned_financial_history_blocks_despite_all_one_tenant_scopes(self) -> None:
        with closing(fixture()) as db:
            db.execute("UPDATE sales_invoices SET pharmacy_id='single-verified'")
            db.commit()
            original = db.serialize()
            report = assess_connection(db, tenant_id="single-verified",
                                       source_sha256=hashlib.sha256(original).hexdigest())
            self.assertEqual(report["classification"],
                             "REFUSE_BROKEN_HISTORICAL_RELATIONSHIPS")
            self.assertGreater(report["structural_findings"]["broken_required_links"], 0)
            self.assertEqual(db.serialize(), original)

    def test_04_blank_local_default_and_nontext_scope_do_not_fake_verified_tenant(self) -> None:
        with closing(fixture()) as db:
            db.execute("INSERT INTO users VALUES('blank','   ')")
            db.execute("INSERT INTO users VALUES(?,?)",
                       ("nontext", sqlite3.Binary(b"\x00binary-nontext")))
            db.commit()
            buckets = scope_review(db, "single-verified")
            self.assertGreater(buckets["blank"], 0)
            self.assertGreater(buckets["null"], 0)
            self.assertGreater(buckets["local_default"], 0)
            self.assertEqual(buckets["nontext"], 1)
            self.assertEqual(buckets["tenant_literal"], 0)

    def test_05_malformed_or_placeholder_tenant_not_accepted_as_target(self) -> None:
        for tenant in ("", " ", "local_default", "LOCAL_DEFAULT", " trailing ",
                       "\nclient", "\x00", "../escape", "<unsafe>", "tenant/other",
                       "tenant\u202eother"):
            with self.assertRaisesRegex(UnsafeSource,
                                        "independently_established_explicit_tenant_required"):
                check_tenant(tenant)

    def test_06_fractional_legacy_journal_is_review_not_invented_financial_discrepancy(self) -> None:
        with closing(fixture()) as db:
            db.execute("DELETE FROM sales_items WHERE id='line-orphan'")
            db.execute("UPDATE sales_invoices SET pharmacy_id='single-verified'")
            db.execute("UPDATE sales_invoices SET patient_id='private-patient' WHERE id='sale-2'")
            db.execute("UPDATE journal_entries SET amount=25.005")
            db.commit()
            before = db.serialize()
            report = assess_connection(db, tenant_id="single-verified",
                                       source_sha256=hashlib.sha256(before).hexdigest())
            self.assertEqual(db.serialize(), before)
            # The toy fixture lacks later optional business columns; fail
            # closed on that more severe incomplete-graph blocker first,
            # *while still reporting the genuine fractional-cent findings*.
            self.assertEqual(report["classification"],
                             "REFUSE_INCOMPLETE_HISTORICAL_MODULE_GRAPH")
            self.assertEqual(
                report["structural_findings"]["fractional_cent_legacy_journal_amounts"], 2,
            )
            self.assertEqual(report["structural_findings"]["unbalanced_or_empty_journals"], 0)
            self.assertFalse(report["safe_to_activate_or_import"])


if __name__ == "__main__":
    unittest.main()
