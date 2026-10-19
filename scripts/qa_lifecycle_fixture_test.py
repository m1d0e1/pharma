"""Disposable SQLite-only tests: no real QA AppData, production seed, or GUI."""
from __future__ import annotations

import hashlib
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from scripts.qa_lifecycle_fixture import (
    ACTOR_ID, APP_ID, DATABASE, MANIFEST, TENANT_ID,
    create_fixture, history_digests, readonly, sha256, verify_fixture,
)


def synthetic_native_fixture(path: Path) -> None:
    """Tiny migrated-shape mock; NOT a substitute for real 054+ native migrations."""
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript("""
            PRAGMA foreign_keys=ON;
            CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,role TEXT,full_name TEXT,
                pharmacy_id TEXT,permissions TEXT,password_hash TEXT,is_active INTEGER DEFAULT 1);
            CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,success INTEGER);
            CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name_ar TEXT,balance REAL DEFAULT 0);
            CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,supplier_id INTEGER REFERENCES suppliers(id),
                pharmacy_id TEXT,user_id TEXT REFERENCES users(id),total_amount REAL);
            CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY,invoice_id TEXT REFERENCES purchase_invoices(id));
            CREATE TABLE supplier_transactions(id INTEGER PRIMARY KEY,supplier_id INTEGER REFERENCES suppliers(id),
                type TEXT,amount REAL);
            CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT);
            CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT);
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT);
            CREATE TABLE sales_items(id TEXT PRIMARY KEY);
            CREATE TABLE returns(id TEXT PRIMARY KEY,pharmacy_id TEXT);
            CREATE TABLE purchase_returns(id TEXT PRIMARY KEY,supplier_id INTEGER REFERENCES suppliers(id));
            CREATE TABLE shifts(id TEXT PRIMARY KEY,pharmacy_id TEXT);
            CREATE TABLE daily_journals(id TEXT PRIMARY KEY,pharmacy_id TEXT);
            CREATE TABLE journal_entries(id TEXT PRIMARY KEY);
            CREATE TABLE cash_movements(id TEXT PRIMARY KEY,pharmacy_id TEXT);
            CREATE TABLE financial_notices(id TEXT PRIMARY KEY,pharmacy_id TEXT);
        """)
        db.executemany("INSERT INTO _sqlx_migrations(version,success) VALUES (?,1)",
                       [(number,) for number in range(1, 61)])
        db.executemany(
            "INSERT INTO users(id,username,role,pharmacy_id,permissions) VALUES (?,?,?,?,?)",
            [("admin", "admin", "owner", None, "{}"),
             ("buyer-a", "buyer-a", "cashier", "tenant-a", "{}"),
             ("buyer-b", "buyer-b", "cashier", "tenant-b", "{}")],
        )
        db.execute("INSERT INTO suppliers(id,name_ar,balance) VALUES (77,'Shared legacy supplier',100)")
        db.executemany(
            "INSERT INTO purchase_invoices(id,supplier_id,pharmacy_id,user_id,total_amount) VALUES (?,?,?,?,?)",
            [("invoice-a", 77, "tenant-a", "buyer-a", 20),
             ("invoice-b", 77, "tenant-b", "buyer-b", 30),
             ("invoice-unowned", 77, None, "admin", 50)],
        )
        db.execute("INSERT INTO supplier_transactions(id,supplier_id,type,amount) VALUES (91,77,'invoice',100)")
        db.execute("INSERT INTO inventory(id,pharmacy_id) VALUES ('stock-b','tenant-b')")
        db.execute("INSERT INTO daily_journals(id,pharmacy_id) VALUES ('journal-a','tenant-a')")
        db.execute("INSERT INTO cash_movements(id,pharmacy_id) VALUES ('cash-b','tenant-b')")


class LifecycleFixtureSafety(unittest.TestCase):
    def setUp(self) -> None:
        self.sandbox = tempfile.TemporaryDirectory(prefix="pharma-lifecycle-fixture-unit-")
        self.addCleanup(self.sandbox.cleanup)
        base = Path(self.sandbox.name)
        self.source = base / "source.db"
        self.parent = base / "profile-parent"
        self.parent.mkdir()
        synthetic_native_fixture(self.source)
        self.original_hash = sha256(self.source)

    def create(self, **kwargs) -> dict:
        return create_fixture(self.source, self.parent, self.original_hash, allow_history=True, **kwargs)

    def test_native_history_backup_retains_mixed_tenant_supplier_ids_and_canonical_owner(self):
        with closing(readonly(self.source)) as db:
            source_digest = history_digests(db)
            original_owner = db.execute("SELECT id,pharmacy_id,password_hash FROM users WHERE id='admin'").fetchone()

        report = self.create()
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["app_id"], APP_ID)
        self.assertEqual(report["tenant"], TENANT_ID)
        self.assertFalse(report["actor_login_ready"])  # original owner enrollment still blocked
        self.assertEqual(sha256(self.source), self.original_hash)
        self.assertFalse((self.parent / "com.pharma.system").exists())
        profile = self.parent / APP_ID
        with closing(readonly(profile / DATABASE)) as clone:
            self.assertEqual(history_digests(clone), source_digest)
            self.assertEqual(clone.execute("SELECT id,pharmacy_id,password_hash FROM users WHERE id='admin'").fetchone(), original_owner)
            self.assertEqual(clone.execute("SELECT id,role,pharmacy_id,password_hash FROM users WHERE id=?", (ACTOR_ID,)).fetchone(),
                             (ACTOR_ID, "owner", TENANT_ID, None))
            self.assertEqual(clone.execute("SELECT id,pharmacy_id FROM purchase_invoices ORDER BY id").fetchall(),
                             [("invoice-a", "tenant-a"), ("invoice-b", "tenant-b"),
                              ("invoice-unowned", None)])
            self.assertEqual(clone.execute("SELECT DISTINCT supplier_id FROM purchase_invoices").fetchall(), [(77,)])
            self.assertEqual(clone.execute("PRAGMA query_only").fetchone(), (1,))
            with self.assertRaises(sqlite3.OperationalError):
                clone.execute("UPDATE purchase_invoices SET pharmacy_id='changed'")
        manifest = json.loads((profile / MANIFEST).read_text(encoding="utf-8"))
        self.assertEqual(manifest["copy_method"], "sqlite3.Connection.backup")
        self.assertEqual(manifest["history_sha256"], source_digest)
        self.assertEqual(manifest["source_file_sha256"], self.original_hash)
        self.assertFalse(manifest["native_financial_receipts_seeded"])
        self.assertEqual(verify_fixture(self.parent)["status"], "PASS")

    def test_never_overwrites_existing_identity_or_mutates_source_on_second_create(self):
        self.create()
        fixture_hash = sha256(self.parent / APP_ID / DATABASE)
        with self.assertRaises(FileExistsError):
            self.create()
        self.assertEqual(fixture_hash, sha256(self.parent / APP_ID / DATABASE))
        self.assertEqual(self.original_hash, sha256(self.source))

    def test_history_copy_requires_explicit_consent_and_source_hash_pin(self):
        with self.assertRaisesRegex(ValueError, "--allow-history"):
            create_fixture(self.source, self.parent, self.original_hash)
        with self.assertRaisesRegex(ValueError, "Source hash"):
            create_fixture(self.source, self.parent, "0" * 64, allow_history=True)
        self.assertFalse((self.parent / APP_ID).exists())

    def test_readonly_verifier_detects_profile_tampering_without_fixing_it(self):
        self.create()
        db_path = self.parent / APP_ID / DATABASE
        with closing(sqlite3.connect(db_path)) as clone, clone:
            clone.execute("UPDATE purchase_invoices SET pharmacy_id='forged' WHERE id='invoice-b'")
        tampered = sha256(db_path)
        with self.assertRaisesRegex(ValueError, "profile database differs|fixture database differs|sealed provenance"):
            verify_fixture(self.parent)
        self.assertEqual(tampered, sha256(db_path))  # verifier did not rewrite it
        self.assertEqual(self.original_hash, sha256(self.source))

    def test_fails_closed_if_new_actor_already_in_historical_source(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("INSERT INTO users(id,username,role,pharmacy_id) VALUES (?,?,?,?)",
                       (ACTOR_ID, "foreign-user", "cashier", "tenant-b"))
        updated_sha = sha256(self.source)
        with self.assertRaisesRegex(ValueError, "actor already exists"):
            create_fixture(self.source, self.parent, updated_sha, allow_history=True)
        self.assertFalse((self.parent / APP_ID).exists())

    def test_does_not_allow_aliased_source_or_existing_application_data_junction(self):
        link = self.parent / "source-alias.db"
        try:
            link.symlink_to(self.source)
        except (OSError, NotImplementedError):
            self.skipTest("Symlinks unavailable to current Windows test account")
        with self.assertRaises(ValueError):
            create_fixture(link, self.parent, self.original_hash, allow_history=True)
        self.assertFalse((self.parent / APP_ID).exists())


if __name__ == "__main__":
    unittest.main()
