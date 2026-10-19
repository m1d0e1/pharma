"""Synthetic-only regressions; never open original or installed profile."""
from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.qa_v02110_one_tenant_review_packet import (
    PIN, scope_census, source_path_checked, make_packet,
)
from scripts.qa_legacy_ownership_approvals import SourceCommitment


class OneTenantReportSafetyTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE users(id TEXT PRIMARY KEY, pharmacy_id TEXT);
            CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY, pharmacy_id TEXT);
            CREATE TABLE inventory(id TEXT PRIMARY KEY, pharmacy_id TEXT);
            CREATE TABLE patients(id TEXT PRIMARY KEY);
            INSERT INTO users VALUES('owner', NULL), ('cashier', NULL);
            INSERT INTO purchase_invoices VALUES('p1', NULL), ('p2','local_default');
            INSERT INTO inventory VALUES('i1','local_default'), ('i2','');
            INSERT INTO patients VALUES('pt1');
        """)

    def test_null_and_placeholder_remain_distinct(self):
        report = scope_census(self.db)
        self.assertEqual(report["original_physical_table_count"], 4)
        self.assertEqual(report["original_physical_table_rows_including_fts"], 7)
        rows = {row["table"]: row for row in report["tables"]}
        self.assertEqual(rows["users"]["original_scope_types"]["null"], 2)
        self.assertEqual(rows["purchase_invoices"]["original_scope_types"]["null"], 1)
        self.assertEqual(rows["purchase_invoices"]["original_scope_types"]["literal_local_default"], 1)
        self.assertEqual(rows["inventory"]["original_scope_types"]["blank_text"], 1)
        self.assertEqual(rows["patients"]["scope_status"],
                         "no_direct_scope_requires_reviewed_link_or_shared_directory")
        self.assertEqual(self.db.execute("SELECT pharmacy_id FROM purchase_invoices WHERE id='p1'").fetchone(), (None,))

    def test_other_explicit_tenant_is_not_absorbed_silently(self):
        self.db.execute("INSERT INTO inventory VALUES('foreign','branch_b')")
        report = scope_census(self.db)
        self.assertEqual(report["rows_with_other_named_literal_scope"], 1)
        self.assertEqual(report["original_physical_table_rows_including_fts"], 8)

    def test_nontext_storage_is_not_coerced(self):
        self.db.execute("INSERT INTO inventory VALUES(?,?)", ("blob", sqlite3.Binary(b"\x01")))
        table = next(t for t in scope_census(self.db)["tables"] if t["table"] == "inventory")
        self.assertEqual(table["original_scope_types"]["non_text_nonnull"], 1)
        self.assertEqual(self.db.execute("SELECT typeof(pharmacy_id) FROM inventory WHERE id='blob'").fetchone(), ("blob",))

    def test_reject_reserved_destination_before_lineage(self):
        dummy = SourceCommitment("a"*64, "b"*64, "c"*64, 7, 4, 4096)
        for target in ("local_default", "", " tenant", "space between", "☃"):
            with self.subTest(target=target):
                with self.assertRaises(ValueError):
                    make_packet(self.db, source=dummy, proposed_tenant=target)

    def test_bogus_root_or_digest_refused_before_read(self):
        with patch("os.environ", {"LOCALAPPDATA": str(Path.cwd())}):
            with self.assertRaises((OSError, ValueError)):
                source_path_checked(Path("nonexistent.sqlite3"), PIN)
            with self.assertRaises(ValueError):
                source_path_checked(Path("nonexistent.sqlite3"), "0"*64)


if __name__ == "__main__":
    unittest.main()
