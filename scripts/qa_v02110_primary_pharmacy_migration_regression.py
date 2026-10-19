"""Synthetic RAM-only regression for deterministic QA custody/rollback."""
from __future__ import annotations

import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from scripts import qa_v02110_primary_pharmacy_migration as qa


def fixture(native: bool) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.execute("CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,success INTEGER)")
    db.executemany("INSERT INTO _sqlx_migrations VALUES(?,1)",
                   ((v,) for v in range(1, 68 if native else 30)))
    db.executescript("""
        CREATE TABLE users (
            id TEXT PRIMARY KEY, role TEXT NOT NULL, pharmacy_id TEXT,
            password_hash TEXT, permissions TEXT
        );
        CREATE TABLE sales_invoices (
            id TEXT PRIMARY KEY, pharmacy_id TEXT, total REAL, payload BLOB
        );
        CREATE TABLE invoice_items (
            id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL,
            price REAL, FOREIGN KEY(invoice_id) REFERENCES sales_invoices(id)
        );
        CREATE TABLE inventory (
            id INTEGER PRIMARY KEY AUTOINCREMENT, pharmacy_id TEXT,
            on_hand REAL, batch BLOB
        );
        CREATE TABLE master_drugs(id INTEGER PRIMARY KEY, name TEXT);
        CREATE VIRTUAL TABLE master_drugs_fts USING fts5(name);
        CREATE TRIGGER invoice_scope_guard
            BEFORE UPDATE OF pharmacy_id ON sales_invoices
            BEGIN SELECT RAISE(ABORT, 'native finance posting scope guarded'); END;
    """)
    db.execute("INSERT INTO users VALUES(?,?,?,?,?)",
               ("owner", "owner", None if not native else "local_default",
                "historical-public-bcrypt-hash" if not native else None, None))
    db.execute("INSERT INTO users VALUES(?,?,?,?,?)",
               ("admin", "admin", None, "distinct-private-hash", '{"can_view_purchases":true}'))
    db.executemany("INSERT INTO sales_invoices VALUES(?,?,?,?)", (
        ("one", "local_default", 8.00127, b"\x00\xff"),
        ("two", None, -0.0, b"\xfe\x01"),
        ("three", "branch_older", 0.333333333333, b"secret"),
        ("four", "  ", 4.2, b" "),
        ("five", "primary_pharmacy", 19.95, b"unchanged"),
    ))
    db.execute("INSERT INTO invoice_items VALUES('part','one',2.71828182845)")
    db.execute("INSERT INTO inventory(pharmacy_id,on_hand,batch) VALUES(?,?,?)",
               (sqlite3.Binary(b"\x00\x10"), 18.000000023, b"\xaa\x00"))
    db.execute("INSERT INTO master_drugs VALUES(1,'amoxicillin')")
    db.execute("INSERT INTO master_drugs_fts(rowid,name) VALUES(1,'amoxicillin')")
    db.commit()
    qa.healthy(db)
    return db


class PrimaryPharmacyReversibleMigrationTests(unittest.TestCase):
    def setUp(self):
        self.original = fixture(native=True)
        self.sealed = fixture(native=False)
        self.candidate = sqlite3.connect(":memory:")
        self.original.backup(self.candidate)
        self.addCleanup(self.original.close)
        self.addCleanup(self.sealed.close)
        self.addCleanup(self.candidate.close)
        self.pin = "a" * 64

    def prepare_and_normalize(self):
        prepared = qa.prepare(self.candidate, self.original, self.sealed, self.pin)
        changed = qa._mutate_scopes(self.candidate, restore=False)
        result = qa.verify(self.original, self.candidate, self.sealed, self.pin)
        self.assertEqual(result["direct_scope_cells_changed"], changed)
        return prepared, changed

    def test_full_scope_normalization_with_exact_typed_escrow(self):
        prepared, changed = self.prepare_and_normalize()
        self.assertEqual(prepared["direct_tables"], 3)
        self.assertEqual(changed, 7)  # users 2, sales 4, inventory 1
        self.assertEqual(self.candidate.execute(
            "SELECT COUNT(*) FROM sales_invoices WHERE pharmacy_id='primary_pharmacy'"
        ).fetchone(), (5,))
        self.assertEqual(self.candidate.execute(
            "SELECT total,payload FROM sales_invoices WHERE id='one'"
        ).fetchone(), (8.00127, b"\x00\xff"))
        self.assertEqual(self.candidate.execute(
            "SELECT password_hash FROM users WHERE id='owner'"
        ).fetchone(), (None,))
        self.assertEqual(self.candidate.execute(
            "SELECT source_rowid,original_storage,original_literal "
            "FROM qa_primary_scope_originals WHERE source_table='inventory'"
        ).fetchone(), (1, "blob", b"\x00\x10"))
        self.assertEqual(self.candidate.execute(
            "SELECT original_storage,original_literal "
            "FROM qa_primary_scope_originals WHERE source_table='sales_invoices' "
            "AND source_rowid=2"
        ).fetchone(), ("null", None))
        self.assertEqual(self.candidate.execute(
            "SELECT original_storage,original_literal "
            "FROM qa_primary_scope_originals WHERE source_table='sales_invoices' "
            "AND source_rowid=4"
        ).fetchone(), ("text", "  "))
        escrow = self.candidate.execute(
            "SELECT original_owner_password_storage, original_owner_password_literal "
            "FROM qa_sealed_032_052_user_originals WHERE sealed_user_id='owner'"
        ).fetchone()
        self.assertEqual(escrow, ("text", "historical-public-bcrypt-hash"))
        # Source owner original scope NULL remains archived even though the
        # native v67 owner scope was later backfilled to local_default.
        self.assertEqual(self.candidate.execute(
            "SELECT original_scope_storage,original_scope_literal "
            "FROM qa_sealed_032_052_user_originals WHERE sealed_user_id='owner'"
        ).fetchone(), ("null", None))

    def test_normalize_twice_is_idempotent_then_rollback_recovers_originals(self):
        prepared, changed = self.prepare_and_normalize()
        normalized_bytes = self.candidate.serialize()
        self.assertEqual(qa._mutate_scopes(self.candidate, restore=False), 0)
        self.assertEqual(normalized_bytes, self.candidate.serialize())
        self.assertEqual(qa._mutate_scopes(self.candidate, restore=True), changed)
        rollback = qa.verify(self.original, self.candidate, self.sealed, self.pin)
        self.assertEqual(rollback["phase"], "ROLLED_BACK")
        self.assertEqual(rollback["direct_scope_cells_changed"], 0)
        self.assertEqual(self.candidate.execute(
            "SELECT pharmacy_id FROM users WHERE id='owner'"
        ).fetchone(), ("local_default",))
        self.assertEqual(self.candidate.execute(
            "SELECT password_hash FROM users WHERE id='owner'"
        ).fetchone(), (None,))
        self.assertEqual(qa._mutate_scopes(self.candidate, restore=True), 0)
        self.assertEqual(qa._mutate_scopes(self.candidate, restore=False), changed)
        self.assertEqual(qa.verify(self.original, self.candidate, self.sealed,
                                   self.pin)["phase"], "NORMALIZED")

    def test_precision_fts_fk_and_non_scope_tampering_are_detected(self):
        self.prepare_and_normalize()
        self.candidate.execute("UPDATE sales_invoices SET total=8 WHERE id='one'")
        with self.assertRaisesRegex(qa.Refused, "non-scope"):
            qa.verify(self.original, self.candidate, self.sealed, self.pin)
        self.candidate.rollback()
        # Candidate is still valid; changing a shadow FTS row is detected.
        self.candidate.execute("DELETE FROM master_drugs_fts WHERE rowid=1")
        with self.assertRaisesRegex(qa.Refused, "physical row"):
            qa.verify(self.original, self.candidate, self.sealed, self.pin)

    def test_sealed_original_credential_tampering_detected_without_restoration(self):
        self.prepare_and_normalize()
        self.candidate.execute("UPDATE qa_sealed_032_052_user_originals "
                               "SET original_owner_password_literal='fabricated' "
                               "WHERE sealed_user_id='owner'")
        with self.assertRaisesRegex(qa.Refused, "SEALED"):
            qa.verify(self.original, self.candidate, self.sealed, self.pin)

    def test_read_snapshot_requires_sha_and_no_wal_sidecars(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(qa, "disposable_root",
                                                            return_value=Path(tmp)):
            file = Path(tmp) / "synthetic-native.sqlite3"
            file.write_bytes(self.original.serialize())
            expected = hashlib.sha256(file.read_bytes()).hexdigest()
            self.assertEqual(qa.checked_file(file, expected), file.read_bytes())
            with self.assertRaisesRegex(qa.Refused, "SHA-256"):
                qa.checked_file(file, "0" * 64)
            sidecar = Path(str(file) + "-wal")
            sidecar.write_bytes(b"uncommitted")
            with self.assertRaisesRegex(qa.Refused, "sidecars"):
                qa.checked_file(file, expected)


if __name__ == "__main__":
    unittest.main()
