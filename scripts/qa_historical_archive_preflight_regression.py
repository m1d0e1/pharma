"""Synthetic, filesystem-isolated regression for the archive inspection gate."""
from __future__ import annotations

from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

from scripts.qa_historical_archive_preflight import (
    GLOBAL_TABLES,
    IDENTITY_TABLES,
    approved_archive,
    digest_file,
    inspect_archive,
    read_only_connection,
)


class HistoricalArchivePreflightTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="pharma-archive-readonly-test-")
        self.addCleanup(self.temp.cleanup)
        self.local_app_data = Path(self.temp.name)
        self.root = self.local_app_data / "pharma-disposable-data-copies"
        self.profile = self.root / ("production-profile-qa-snapshot-20261017-" + "a" * 32)
        self.profile.mkdir(parents=True)
        self.archive = self.profile / "production_snapshot_immutable.sqlite3"
        with closing(sqlite3.connect(self.archive)) as conn, conn:
            for table in IDENTITY_TABLES:
                conn.execute(f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY, pharmacy_id TEXT)')
            for table in GLOBAL_TABLES:
                conn.execute(f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY)')
            conn.executemany(
                "INSERT INTO purchase_invoices(pharmacy_id) VALUES (?)",
                [(None,), ("local_default",), ("",), ("  ",), ("tenant-a",), ("LOCAL_DEFAULT",)],
            )
            conn.executemany(
                "INSERT INTO users(pharmacy_id) VALUES (?)",
                [(None,), (None,), ("local_default",)],
            )
            conn.execute("INSERT INTO patients DEFAULT VALUES")
        self.expected = digest_file(self.archive)

    def test_preserves_literal_unknown_legacy_and_other_scope_without_disclosure(self) -> None:
        report = inspect_archive(self.archive, self.expected, self.local_app_data)
        self.assertEqual(report["archive_sha256"], self.expected)
        self.assertEqual(report["tenant_categories"]["purchase_invoices"], {
            "rows": 6, "identity": "literal_pharmacy_id", "null": 1,
            "local_default": 1, "blank": 2, "other_exact_values": 2,
        })
        self.assertEqual(report["tenant_categories"]["users"]["null"], 2)
        self.assertEqual(report["tenant_categories"]["patients"], {
            "rows": 1, "identity": "column_absent",
        })
        self.assertFalse(report["historical_ownership_verified"])
        self.assertFalse(report["interactive_transactions_authorized"])
        self.assertEqual(self.expected, digest_file(self.archive))
        self.assertNotIn("tenant-a", str(report))
        self.assertNotIn("LOCAL_DEFAULT", str(report))

    def test_rejects_wrong_hash_and_all_unapproved_paths(self) -> None:
        with self.assertRaisesRegex(ValueError, "SHA-256 differs"):
            inspect_archive(self.archive, "0" * 64, self.local_app_data)
        with self.assertRaisesRegex(ValueError, "SHA-256 is required"):
            inspect_archive(self.archive, "not-a-sha", self.local_app_data)
        other = self.local_app_data / "com.pharma.system" / "pharma_local.db"
        other.parent.mkdir()
        other.write_bytes(self.archive.read_bytes())
        with self.assertRaisesRegex(ValueError, "designated detached"):
            approved_archive(other, self.local_app_data)
        with self.assertRaisesRegex(ValueError, "designated detached"):
            approved_archive(self.archive, self.local_app_data / "unrelated")

    def test_rejects_live_sqlite_sidecars_and_missing_tenant_schema(self) -> None:
        sidecar = self.profile / "production_snapshot_immutable.sqlite3-wal"
        sidecar.write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "sidecar"):
            inspect_archive(self.archive, self.expected, self.local_app_data)
        sidecar.unlink()
        with closing(sqlite3.connect(self.archive)) as conn, conn:
            conn.execute("ALTER TABLE purchase_invoices RENAME TO removed_purchases")
        with self.assertRaisesRegex(ValueError, "required table layout"):
            inspect_archive(self.archive, digest_file(self.archive), self.local_app_data)

    def test_readonly_connection_denies_sqlite_update(self) -> None:
        with closing(read_only_connection(self.archive)) as connection:
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("UPDATE users SET pharmacy_id='tenant-a'")
        self.assertEqual(digest_file(self.archive), self.expected)


if __name__ == "__main__":
    unittest.main()
