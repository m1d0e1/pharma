"""Synthetic, in-memory only negative coverage for the read-only lineage graph."""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import sqlite3
import unittest

from scripts.qa_full_history_lineage import make_full_history_lineage, verified_lineage
from scripts.qa_historical_archive_manifest import opaque_table_id
from scripts.qa_historical_archive_manifest_regression import fixture as archive_fixture


def fixture(*, full_67: bool = False) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=OFF")
    db.executescript("""
        CREATE TABLE users(id TEXT PRIMARY KEY, pharmacy_id TEXT);
        CREATE TABLE patients(id TEXT PRIMARY KEY, full_name TEXT, phone TEXT);
        CREATE TABLE sales_invoices(id TEXT PRIMARY KEY, patient_id TEXT,
            FOREIGN KEY(patient_id) REFERENCES patients(id));
        CREATE TABLE sales_items(id TEXT, invoice_id TEXT,
            FOREIGN KEY(invoice_id) REFERENCES sales_invoices(id));
        CREATE TABLE master_drugs(id INTEGER PRIMARY KEY, trade_name TEXT);
        CREATE TABLE inventory(id TEXT PRIMARY KEY, drug_id INTEGER,
            FOREIGN KEY(drug_id) REFERENCES master_drugs(id));
        CREATE TABLE suppliers(id INTEGER PRIMARY KEY, name_ar TEXT);
        CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY, supplier_id INTEGER);
        CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY, invoice_id TEXT);
        CREATE TABLE child_fk(id INTEGER PRIMARY KEY, parent_id BLOB NOT NULL,
            FOREIGN KEY(parent_id) REFERENCES parent_fk(id));
        CREATE TABLE parent_fk(id INTEGER PRIMARY KEY);
        CREATE TABLE composite_parent(a TEXT, b INTEGER, PRIMARY KEY(a,b));
        CREATE TABLE composite_child(a TEXT, b INTEGER,
            FOREIGN KEY(a,b) REFERENCES composite_parent(a,b));
        CREATE TABLE ids_untyped(id, marker TEXT);
        CREATE TABLE "patient\""private" (id TEXT, phone TEXT);
        CREATE VIRTUAL TABLE master_drugs_fts USING fts5(
            id UNINDEXED, trade_name, content='master_drugs', content_rowid='id'
        );
        INSERT INTO master_drugs(id,trade_name) VALUES(1,'SECRET DRUG');
        INSERT INTO master_drugs_fts(rowid,id,trade_name) VALUES(1,1,'SECRET DRUG');
        INSERT INTO patients VALUES('patient-secret','SECRET NAME','555-0100');
        INSERT INTO sales_invoices VALUES('sale-good','patient-secret');
        INSERT INTO sales_items VALUES('line-good','sale-good');
        INSERT INTO suppliers VALUES(1,'SECRET SUPPLIER');
        INSERT INTO purchase_invoices VALUES('purchase-good',1);
        INSERT INTO purchase_invoice_items VALUES(1,'purchase-good');
        INSERT INTO inventory VALUES('lot-good',1);
        INSERT INTO parent_fk VALUES(5);
        INSERT INTO child_fk VALUES(1,5);
        INSERT INTO composite_parent VALUES('one',9);
        INSERT INTO composite_child VALUES('one',9);
        INSERT INTO ids_untyped VALUES(1,'PRIVATE A');
    """)
    if full_67:
        count = db.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'"
        ).fetchone()[0]
        if count > 67:
            raise AssertionError("FTS fixture exceeded 67 tables")
        for index in range(67 - count):
            db.execute(f'CREATE TABLE "additional_{index:03}"(payload TEXT)')
        assert db.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table'"
        ).fetchone()[0] == 67
    return db


class WholeHistoryLineageRegression(unittest.TestCase):
    def test_existing_historical_manifest_fixture_is_compatible(self) -> None:
        with closing(archive_fixture()) as db:
            report = make_full_history_lineage(db)
            self.assertEqual(report["table_count"], 21)
            self.assertEqual(report["fixed_relationships"]["sale_line_to_invoice"]
                             ["missing_parent_rows"], 1)
            self.assertEqual(report["fixed_relationships"]["sale_to_patient"]
                             ["missing_parent_rows"], 1)
            self.assertEqual(report["fts_catalog_candidate"]["status"],
                             "fts_virtual_table_absent_quarantined")
            self.assertFalse(report["historical_tenant_ownership_certified"])

    def test_all_67_tables_including_fts_shadows_are_counted_without_exposing_data(self) -> None:
        with closing(fixture(full_67=True)) as db:
            before = hashlib.sha256(db.serialize()).hexdigest()
            result = verified_lineage(
                db, before, lambda: hashlib.sha256(db.serialize()).hexdigest()
            )
            self.assertEqual(result["table_count"], 67)
            self.assertEqual(len(result["tables"]), 67)
            self.assertEqual(len({entry["opaque_table_id"] for entry in result["tables"]}), 67)
            self.assertEqual(result["table_count"], result["coverage"]["enumerated_tables"])
            self.assertTrue(result["coverage"]["whole_schema_counted"])
            # FTS5 external-content schema uses four shadows and one virtual
            # table; an internal-content index would additionally have _content.
            self.assertEqual(result["coverage"]["fts_tables_and_shadows"], 5)
            self.assertEqual(before, hashlib.sha256(db.serialize()).hexdigest())
            self.assertEqual(db.execute("PRAGMA query_only").fetchone()[0], 1)
            rendered = json.dumps(result)
            for secret in (
                "SECRET", "555-0100", "patient-secret", "sale-good",
                "purchase-good", "lot-good", 'patient"private',
            ):
                self.assertNotIn(secret, rendered)
            self.assertFalse(result["historical_tenant_ownership_certified"])
            self.assertFalse(result["financial_provenance_certified"])
            self.assertFalse(result["import_permitted"])

    def test_mandatory_and_declared_fk_orphans_and_nullable_sources_are_separate(self) -> None:
        with closing(fixture()) as db:
            db.execute("INSERT INTO sales_items VALUES('dangling','sale-absent')")
            db.execute("INSERT INTO sales_items VALUES('missing',NULL)")
            db.execute("INSERT INTO sales_invoices VALUES('sale-orphan','lost-patient')")
            db.execute("INSERT INTO sales_invoices VALUES('sale-null',NULL)")
            db.execute("INSERT INTO child_fk VALUES(2,99)")
            db.execute("INSERT INTO composite_child VALUES('one',NULL)")
            db.execute("INSERT INTO composite_child VALUES('absent',8)")
            report = make_full_history_lineage(db)
            mandatory = report["fixed_relationships"]["sale_line_to_invoice"]
            self.assertEqual(mandatory["matched_typed_rows"], 1)
            self.assertEqual(mandatory["missing_parent_rows"], 1)
            self.assertEqual(mandatory["missing_mandatory_reference_rows"], 1)
            optional = report["fixed_relationships"]["sale_to_patient"]
            self.assertEqual(optional["missing_parent_rows"], 1)
            self.assertEqual(optional["optional_unlinked_rows"], 1)
            declared = report["declared_foreign_keys"]
            self.assertTrue(any(
                edge["missing_parent_rows"] == 1 and edge["missing_mandatory_reference_rows"] == 0
                for edge in declared if edge["source_table"] == opaque_table_id("composite_child")
            ))
            self.assertTrue(any(
                edge["partial_null_reference_rows"] == 1
                for edge in declared if edge["source_table"] == opaque_table_id("composite_child")
            ))
            self.assertTrue(any(
                edge["missing_parent_rows"] == 1
                for edge in declared if edge["source_table"] == opaque_table_id("child_fk")
            ))

    def test_cross_storage_type_coercion_and_duplicate_ids_do_not_pass_typed_graph(self) -> None:
        with closing(fixture()) as db:
            db.execute("INSERT INTO ids_untyped VALUES('1','PRIVATE B')")
            db.execute("INSERT INTO child_fk VALUES(3,'5')")
            db.execute("INSERT INTO child_fk VALUES(4,5.0)")
            db.execute("INSERT INTO sales_items VALUES(4,'sale-good')")
            db.execute("INSERT INTO sales_items VALUES('4','sale-good')")
            db.execute("INSERT INTO sales_items VALUES(NULL,'sale-good')")
            report = make_full_history_lineage(db)
            id_entry = next(item for item in report["tables"] if item["opaque_table_id"] ==
                            opaque_table_id("ids_untyped"))
            self.assertEqual(id_entry["id_key"]["cast_text_collision_rows"], 1)
            sale_line = next(item for item in report["tables"] if item["opaque_table_id"] ==
                             opaque_table_id("sales_items"))
            self.assertEqual(sale_line["id_key"]["cast_text_collision_rows"], 1)
            self.assertEqual(sale_line["id_key"]["null_rows"], 1)
            fk = next(edge for edge in report["declared_foreign_keys"]
                      if edge["source_table"] == opaque_table_id("child_fk"))
            self.assertEqual(fk["matched_typed_rows"], 1)
            self.assertEqual(fk["coercion_only_parent_rows"], 2)

    def test_missing_parent_table_or_column_is_quarantined_not_assumed_empty(self) -> None:
        with closing(fixture()) as db:
            db.execute("CREATE TABLE absent_parent_link(id TEXT REFERENCES missing_table(id))")
            db.execute("INSERT INTO absent_parent_link VALUES('someone')")
            db.execute("ALTER TABLE purchase_invoice_items RENAME COLUMN invoice_id TO old_ref")
            report = make_full_history_lineage(db)
            self.assertTrue(any(
                edge["status"] == "missing_parent_schema_quarantined"
                and edge["source_rows_quarantined"] == 1
                for edge in report["declared_foreign_keys"]
            ))
            self.assertEqual(
                report["fixed_relationships"]["purchase_line_to_purchase"]["status"],
                "missing_link_column_quarantined",
            )
            self.assertFalse(report["coverage"]["all_fixed_links_inspectable"])

    def test_untrusted_table_names_cannot_inject_sql_or_leak_table_values(self) -> None:
        with closing(fixture()) as db:
            name = '"; DROP TABLE patients; --'
            quoted = '"' + name.replace('"', '""') + '"'
            db.execute(f"CREATE TABLE {quoted}(id TEXT)")
            db.execute(f"INSERT INTO {quoted} VALUES(?)", ("PRIVATE-ROW-VALUE",))
            report = make_full_history_lineage(db)
            self.assertNotIn(name, json.dumps(report))
            self.assertNotIn("PRIVATE-ROW-VALUE", json.dumps(report))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM patients").fetchone()[0], 1)

    def test_sha_pin_changes_are_detected_and_query_only_rejects_any_write(self) -> None:
        with closing(fixture()) as db:
            current = hashlib.sha256(db.serialize()).hexdigest()
            with self.assertRaisesRegex(ValueError, "independent source pin"):
                verified_lineage(db, "f" * 64, lambda: current)
            outputs = iter((current, "0" * 64))
            with self.assertRaisesRegex(ValueError, "changed during"):
                verified_lineage(db, current, lambda: next(outputs))
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("INSERT INTO patients VALUES('try','no','no')")

    def test_independent_census_pin_rejects_any_missing_or_extra_table(self) -> None:
        with closing(fixture(full_67=True)) as db:
            expected = hashlib.sha256(db.serialize()).hexdigest()
            with self.assertRaisesRegex(ValueError, "census differs"):
                verified_lineage(db, expected, lambda: expected, expected_table_count=66)
            self.assertEqual(
                verified_lineage(db, expected, lambda: expected, expected_table_count=67)
                ["table_count"], 67
            )


if __name__ == "__main__":
    unittest.main()
