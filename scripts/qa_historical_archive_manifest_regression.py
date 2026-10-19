"""RAM-only legacy pharmacy manifest safety and privacy checks."""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import sqlite3
import unittest
from unittest.mock import patch

from scripts.qa_historical_archive_preflight import inspect_archive
from scripts.qa_historical_archive_manifest import (
    FAMILIES,
    REQUIRED,
    make_manifest,
    opaque_table_id,
    verified_manifest,
)


SCHEMA = {
    "master_drugs": "id TEXT PRIMARY KEY, trade_name TEXT",
    "inventory": "id TEXT PRIMARY KEY, drug_id TEXT, pharmacy_id TEXT",
    "patients": "id TEXT PRIMARY KEY, full_name TEXT, phone TEXT",
    "patient_transactions": "id TEXT PRIMARY KEY, patient_id TEXT",
    "sales_invoices": "id TEXT PRIMARY KEY, pharmacy_id TEXT, patient_id TEXT",
    "sales_items": "id TEXT PRIMARY KEY, invoice_id TEXT, inventory_id TEXT",
    "returns": "id TEXT PRIMARY KEY, invoice_id TEXT",
    "return_items": "id TEXT PRIMARY KEY, return_id TEXT, sale_item_id TEXT",
    "suppliers": "id TEXT PRIMARY KEY, name_ar TEXT, phone TEXT",
    "supplier_transactions": "id TEXT PRIMARY KEY, supplier_id TEXT",
    "purchase_invoices": "id TEXT PRIMARY KEY, supplier_id TEXT, pharmacy_id TEXT",
    "purchase_invoice_items": "id TEXT PRIMARY KEY, invoice_id TEXT, inventory_id TEXT",
    "purchase_returns": "id TEXT PRIMARY KEY, purchase_invoice_id TEXT",
    "purchase_return_items": "id TEXT PRIMARY KEY, purchase_return_id TEXT, purchase_invoice_item_id TEXT",
    "daily_journals": "id TEXT PRIMARY KEY, pharmacy_id TEXT",
    "journal_entries": "id TEXT PRIMARY KEY, journal_id TEXT, type TEXT, amount REAL",
    "cash_movements": "id TEXT PRIMARY KEY, pharmacy_id TEXT, shift_id TEXT",
    "shifts": "id TEXT PRIMARY KEY",
    "users": "id TEXT PRIMARY KEY, pharmacy_id TEXT",
    "financial_notices": "id TEXT PRIMARY KEY",
    "activity_log": "id TEXT PRIMARY KEY",
}


def fixture() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    for table, columns in SCHEMA.items():
        db.execute(f'CREATE TABLE "{table}" ({columns})')
    db.executemany(
        "INSERT INTO users(id,pharmacy_id) VALUES (?,?)",
        [("user-NULL", None), ("user-legacy", "local_default")],
    )
    db.execute(
        "INSERT INTO patients VALUES('private-patient','PRIVATE CUSTOMER','01000000000')"
    )
    db.execute(
        "INSERT INTO suppliers VALUES('supplier-x','PRIVATE SUPPLIER','09999999999')"
    )
    db.execute("INSERT INTO master_drugs VALUES('drug-1','PRIVATE MEDICINE')")
    db.execute("INSERT INTO inventory VALUES('lot-a','drug-1','local_default')")
    db.executemany(
        "INSERT INTO sales_invoices VALUES(?,?,?)",
        [
            ("sale-1", None, "private-patient"),
            ("sale-2", "pharmacy-explicit-unverified", "absent-patient"),
        ],
    )
    db.executemany(
        "INSERT INTO sales_items VALUES(?,?,?)",
        [("line-1", "sale-1", "lot-a"), ("line-orphan", "missing-sale", None),
         ("line-cross-scope", "sale-2", "lot-a")],
    )
    db.execute("INSERT INTO returns VALUES('return-1','sale-1')")
    db.execute("INSERT INTO return_items VALUES('return-line-1','return-1',NULL)")
    db.execute("INSERT INTO purchase_invoices VALUES('invoice-1','supplier-x',NULL)")
    db.execute("INSERT INTO purchase_invoice_items VALUES('purchase-line-1','invoice-1','lot-a')")
    db.execute("INSERT INTO purchase_returns VALUES('purchase-return-1','invoice-1')")
    db.execute(
        "INSERT INTO purchase_return_items VALUES('pr-line-1','purchase-return-1',NULL)"
    )
    db.execute("INSERT INTO supplier_transactions VALUES('supplier-ledger-1','supplier-x')")
    db.execute("INSERT INTO patient_transactions VALUES('patient-ledger-1','private-patient')")
    db.execute("INSERT INTO daily_journals VALUES('journal-1','local_default')")
    db.executemany(
        "INSERT INTO journal_entries VALUES(?,?,?,?)",
        [("debit","journal-1","debit",25.00),
         ("credit","journal-1","credit",25.00)],
    )
    db.execute("INSERT INTO shifts VALUES('shift-1')")
    db.execute("INSERT INTO cash_movements VALUES('cash-1',NULL,'shift-1')")
    db.commit()
    return db


class ArchiveManifestRegression(unittest.TestCase):
    def test_command_preflight_combines_pinned_sha_and_full_manifest(self) -> None:
        db = fixture()
        expected = hashlib.sha256(db.serialize()).hexdigest()
        with patch(
            "scripts.qa_historical_archive_preflight.approved_archive",
            return_value="in_memory_only",
        ), patch(
            "scripts.qa_historical_archive_preflight.digest_file",
            return_value=expected,
        ), patch(
            "scripts.qa_historical_archive_preflight.read_only_connection",
            return_value=db,
        ):
            report = inspect_archive(
                "never_a_real_path", expected, "never_a_real_localappdata",
                include_manifest=True,
            )
        self.assertIn("historical_coverage_manifest", report)
        self.assertEqual(
            report["historical_coverage_manifest"]["table_count"], len(SCHEMA)
        )
        self.assertEqual(report["archive_sha256"], expected)
        self.assertFalse(report["historical_coverage_manifest"]["import_permitted"])

    def test_exhaustive_opaque_counts_orphans_and_quarantine_without_private_rows(self) -> None:
        with closing(fixture()) as db:
            before = hashlib.sha256(db.serialize()).hexdigest()
            manifest = verified_manifest(
                db, before, lambda: hashlib.sha256(db.serialize()).hexdigest()
            )
            after = hashlib.sha256(db.serialize()).hexdigest()
            self.assertEqual(before, after)
            self.assertEqual(manifest["table_count"], len(SCHEMA))
            self.assertEqual(manifest["all_table_rows"], sum(
                table["rows"] for table in manifest["tables"]
            ))
            self.assertEqual(set(FAMILIES.values()) - {"catalog"}, {
                entry["family"] for entry in manifest["tables"]
                if entry["family"] != "catalog"
            })
            self.assertEqual(
                manifest["relationships"]["sale_line_to_invoice"]["missing_parent"], 1
            )
            self.assertEqual(
                manifest["relationships"]["sale_to_patient"]["missing_parent"], 1
            )
            self.assertEqual(
                manifest["relationships"]["return_line_to_sale_line"]["legacy_unlinked"], 1
            )
            self.assertEqual(
                manifest["relationships"]["purchase_return_line_to_source_line"]["legacy_unlinked"], 1
            )
            self.assertEqual(
                manifest["relationships"]["journal_structure"]["unbalanced_or_empty"], 0
            )
            self.assertEqual(
                manifest["relationships"]["sale_line_to_lot_scope"]["literal_cross_scope"], 1
            )
            self.assertEqual(
                manifest["relationships"]["sale_line_to_lot_scope"]["unverifiable_scope"], 2
            )
            self.assertEqual(
                manifest["relationships"]["purchase_line_to_lot_scope"]["unverifiable_scope"], 1
            )
            quarantine = manifest["quarantined_identity_counts"]
            self.assertGreater(quarantine["unscoped_columns"], 0)
            self.assertGreater(quarantine["literal_null"], 0)
            self.assertGreater(quarantine["literal_local_default"], 0)
            self.assertEqual(quarantine["explicit_but_unverified"], 1)
            self.assertFalse(manifest["import_permitted"])
            self.assertFalse(manifest["archive_customer_supplier_copy_authorized"])
            self.assertFalse(manifest["historical_tenant_ownership_certified"])
            self.assertFalse(manifest["financial_provenance_certified"])
            output = json.dumps(manifest, ensure_ascii=False)
            for sensitive in (
                "PRIVATE", "01000000000", "09999999999", "patient-ledger-1",
                "sale-1", "invoice-1", "pharmacy-explicit-unverified", "drug-1",
                "supplier-x", "local_default",
            ):
                # local_default appears as a category *name*, never as a row
                # value or evidence of a tenant.
                if sensitive != "local_default":
                    self.assertNotIn(sensitive, output)
            self.assertEqual(
                len({item["opaque_table_id"] for item in manifest["tables"]}),
                len(SCHEMA),
            )
            self.assertIn(opaque_table_id("sales_items"), {
                item["opaque_table_id"] for item in manifest["tables"]
            })

    def test_changed_sha_and_wrong_pin_abort_without_any_output(self) -> None:
        with closing(fixture()) as db:
            before = hashlib.sha256(db.serialize()).hexdigest()
            observed = iter((before, "0" * 64))
            with self.assertRaisesRegex(ValueError, "changed during"):
                verified_manifest(db, before, lambda: next(observed))
        with closing(fixture()) as db:
            with self.assertRaisesRegex(ValueError, "independent source pin"):
                verified_manifest(db, "1" * 64, lambda: "0" * 64)

    def test_missing_critical_schema_and_unresolved_foreign_keys_fail_closed(self) -> None:
        with closing(fixture()) as db:
            db.execute("DROP TABLE purchase_returns")
            with self.assertRaisesRegex(ValueError, "missing required business tables"):
                make_manifest(db)
        with closing(fixture()) as db:
            db.execute("ALTER TABLE sales_items RENAME COLUMN invoice_id TO lost_parent")
            with self.assertRaisesRegex(ValueError, "relationship schema incomplete"):
                make_manifest(db)

    def test_money_structure_flags_incomplete_ledger_without_source_prices(self) -> None:
        with closing(fixture()) as db:
            db.execute(
                "UPDATE journal_entries SET amount=25.001 WHERE id='credit'"
            )
            result = make_manifest(db)
            self.assertEqual(
                result["relationships"]["journal_structure"]["invalid_cent_or_side"], 1
            )
            self.assertGreaterEqual(
                result["relationships"]["journal_structure"]["unbalanced_or_empty"], 0
            )
            self.assertFalse(result["financial_provenance_certified"])
        with closing(fixture()) as db:
            db.execute("UPDATE journal_entries SET amount=30 WHERE id='credit'")
            result = make_manifest(db)
            self.assertEqual(
                result["relationships"]["journal_structure"]["invalid_cent_or_side"], 0
            )
            self.assertEqual(
                result["relationships"]["journal_structure"]["unbalanced_or_empty"], 1
            )
            self.assertFalse(result["import_permitted"])

    def test_untrusted_sqlite_table_name_is_quoted_and_never_exposed(self) -> None:
        with closing(fixture()) as db:
            hostile = 'unexpected"; DROP TABLE patients; --'
            db.execute(f'CREATE TABLE "{hostile.replace(chr(34), chr(34)*2)}" (id TEXT)')
            db.execute(
                f'INSERT INTO "{hostile.replace(chr(34), chr(34)*2)}" VALUES (?)',
                ("PRIVATE-SIDE-CONTENT",),
            )
            report = make_manifest(db)
            self.assertEqual(report["table_count"], len(SCHEMA) + 1)
            self.assertNotIn(hostile, json.dumps(report))
            self.assertNotIn("PRIVATE-SIDE-CONTENT", json.dumps(report))
            self.assertEqual(
                db.execute("SELECT count(*) FROM patients").fetchone()[0], 1
            )


if __name__ == "__main__":
    unittest.main()
