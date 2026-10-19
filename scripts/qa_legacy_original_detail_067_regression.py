#!/usr/bin/env python3
"""Strictly in-memory regression against real unmodified SQL 065, 066 and 067.

These are simulated original records and TEST-ONLY 065 endorsements. No file
database is opened, no real historical origin or tenant right is certified.
The only native DDL under test is the literal migration SQL in this checkout.

Run: python -m unittest -v scripts.qa_legacy_original_detail_067_regression
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import unittest
from pathlib import Path

from scripts.qa_legacy_upgrade_mapping_matrix_065 import (
    MANIFEST, MAPPING, SEAL, SOURCES, Source, build_memory_database,
    rows_snapshot, trusted_synthetic_bundle,
)

SQL_067 = (Path(__file__).resolve().parents[1] / "src-tauri" / "migrations"
           / "067_legacy_original_detail_row_seal.sql")
REGISTRY = "native_legacy_original_detail_rows"
INSERT = f"""INSERT INTO {REGISTRY}
(source_table,source_record_id,manifest_sha256,source_snapshot_sha256,source_evidence_ref)
VALUES(?,?,?,?,?)"""
DETAILS = (
    ("sales_items", "101", "invoice_id", "sale-default", "quantity_sold"),
    ("purchase_invoice_items", "102", "invoice_id", "purchase-a", "quantity"),
    ("purchase_order_items", "103", "po_id", "order-blank", "quantity"),
    ("return_items", "104", "return_id", "return-null", "quantity_returned"),
    ("journal_entries", "105", "journal_id", "journal-null", "amount"),
    ("supplier_transactions", "106", "supplier_id", 51, "amount"),
    ("patient_transactions", "pat-ledger-1", "patient_id", "pat-legacy", "amount"),
)
PARENTS = (
    next(s for s in SOURCES if s.table == table and s.record_id == record)
    for table, record in (
        ("sales_invoices", "sale-default"),
        ("purchase_invoices", "purchase-a"),
        ("purchase_orders", "order-blank"),
        ("returns", "return-null"),
        ("daily_journals", "journal-null"),
    )
)
PARENTS = tuple(PARENTS)


def snapshot(db: sqlite3.Connection) -> dict:
    """Exact SQLite typed per-column row identity; never hash only counts."""
    result = {}
    for table, *_ in DETAILS:
        cols = [item[1] for item in db.execute(f'PRAGMA table_info("{table}")')]
        data = {}
        for row in db.execute(f'SELECT * FROM "{table}"'):
            key = row[0]
            data[key] = tuple(
                (col, "null" if val is None else "real" if isinstance(val, float)
                 else "integer" if isinstance(val, int) else "text",
                 val.hex() if isinstance(val, float) else val)
                for col, val in zip(cols, row)
            )
        result[table] = data
    return result


def source_digest(db: sqlite3.Connection, table: str, record_id: str) -> str:
    row = snapshot(db)[table][int(record_id) if record_id.isdigit() else record_id]
    return hashlib.sha256(json.dumps((table, row), sort_keys=True).encode()).hexdigest()


def fixture(*, install_067: bool = True) -> sqlite3.Connection:
    # build_memory_database contains the actual pre-existing 065 and 066 SQL.
    db = build_memory_database()
    db.execute("ALTER TABLE sales_invoices ADD COLUMN patient_id TEXT")
    db.execute("ALTER TABLE purchase_invoices ADD COLUMN supplier_id INTEGER")
    db.execute("UPDATE sales_invoices SET patient_id='pat-legacy' WHERE id='sale-default'")
    db.execute("UPDATE purchase_invoices SET supplier_id=51 WHERE id='purchase-a'")
    db.executescript("""
      CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,quantity_sold REAL);
      CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY,invoice_id TEXT,quantity REAL);
      CREATE TABLE purchase_order_items(id INTEGER PRIMARY KEY,po_id TEXT,quantity REAL);
      CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT,quantity_returned REAL);
      CREATE TABLE journal_entries(id INTEGER PRIMARY KEY,journal_id TEXT,amount REAL);
      CREATE TABLE supplier_transactions(id INTEGER PRIMARY KEY,supplier_id INTEGER,amount REAL);
      CREATE TABLE patient_transactions(id TEXT PRIMARY KEY,patient_id TEXT,amount REAL);
      INSERT INTO sales_items VALUES(101,'sale-default',4);
      INSERT INTO purchase_invoice_items VALUES(102,'purchase-a',12);
      INSERT INTO purchase_order_items VALUES(103,'order-blank',12);
      INSERT INTO return_items VALUES(104,'return-null',2);
      INSERT INTO journal_entries VALUES(105,'journal-null',12);
      INSERT INTO supplier_transactions VALUES(106,51,7);
      INSERT INTO patient_transactions VALUES('pat-ledger-1','pat-legacy',5);
    """)
    if install_067:
        db.executescript(SQL_067.read_text(encoding="utf-8"))
    return db


def seal_parents(db: sqlite3.Connection):
    bundle = trusted_synthetic_bundle(db, PARENTS)
    db.execute(MANIFEST, bundle.manifest_params)
    for mapping in bundle.mappings:
        db.execute(MAPPING, mapping)
    db.execute(SEAL, bundle.seal_params)
    return bundle


def register(db: sqlite3.Connection, manifest_sha256: str, table: str,
             record_id: str, *, proof: str | None = None) -> None:
    db.execute(INSERT, (
        table, record_id, manifest_sha256, proof or source_digest(db, table, record_id),
        "synthetic-test-only://067/" + table + "/" + record_id,
    ))


class OriginalDetail067Regression(unittest.TestCase):
    def setUp(self) -> None:
        self.db = fixture()
        self.original = snapshot(self.db)

    def tearDown(self) -> None:
        self.db.close()

    def test_01_install_empty_no_changes_no_freezing_business_writes(self) -> None:
        self.assertEqual(snapshot(self.db), self.original)
        self.assertEqual(self.db.execute(f"SELECT count(*) FROM {REGISTRY}").fetchone(), (0,))
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])
        self.assertEqual(self.db.execute("PRAGMA integrity_check").fetchone(), ("ok",))
        for table, pk, fk, link, value in DETAILS:
            with self.subTest(table=table):
                self.db.execute(f'UPDATE "{table}" SET "{value}"="{value}"+1 WHERE id=?',
                                (int(pk) if pk.isdigit() else pk,))
                self.assertNotEqual(snapshot(self.db)[table], self.original[table])
                self.db.execute(f'UPDATE "{table}" SET "{value}"="{value}"-1 WHERE id=?',
                                (int(pk) if pk.isdigit() else pk,))
        self.assertEqual(snapshot(self.db), self.original)

    def test_02_register_all_exact_mapped_original_children_and_freeze_all_mutations(self) -> None:
        bundle = seal_parents(self.db)
        for table, pk, *_ in DETAILS:
            register(self.db, bundle.manifest_sha, table, pk)
        self.assertEqual(self.db.execute(f"SELECT count(*) FROM {REGISTRY}").fetchone(), (7,))
        # Disable recursive triggers: INSERT OR REPLACE must still be denied.
        self.db.execute("PRAGMA recursive_triggers=OFF")
        for table, pk, fk, link, value in DETAILS:
            key = int(pk) if pk.isdigit() else pk
            with self.subTest(table=table):
                for sql, args in (
                    (f'UPDATE "{table}" SET "{value}"="{value}"+1 WHERE id=?', (key,)),
                    (f'UPDATE "{table}" SET "{value}"="{value}" WHERE id=?', (key,)),
                    (f'UPDATE "{table}" SET id=? WHERE id=?', ((key+999) if isinstance(key,int) else "replace", key)),
                    (f'DELETE FROM "{table}" WHERE id=?', (key,)),
                    (f'INSERT OR REPLACE INTO "{table}" (id,"{fk}","{value}") VALUES (?,?,?)',
                     (key, link, 999)),
                ):
                    with self.assertRaises(sqlite3.IntegrityError):
                        self.db.execute(sql, args)
                with self.assertRaises(sqlite3.IntegrityError):
                    register(self.db, bundle.manifest_sha, table, pk)
        self.assertEqual(snapshot(self.db), self.original)

    def test_03_evidence_registry_itself_is_immutable_and_replace_protected(self) -> None:
        bundle = seal_parents(self.db)
        register(self.db, bundle.manifest_sha, "sales_items", "101")
        original = self.db.execute(f'SELECT * FROM {REGISTRY}').fetchall()
        for sql, args in (
            (f"UPDATE {REGISTRY} SET source_snapshot_sha256=?",
             ("f"*64,)),
            (f"DELETE FROM {REGISTRY}", ()),
            (f"INSERT OR REPLACE INTO {REGISTRY} "
             "(source_table,source_record_id,manifest_sha256,source_snapshot_sha256,source_evidence_ref) "
             "VALUES(?,?,?,?,?)",
             ("sales_items","101",bundle.manifest_sha,"f"*64,
              "synthetic-test-only://forged-replacement")),
        ):
            with self.assertRaises(sqlite3.IntegrityError):
                self.db.execute(sql,args)
        self.assertEqual(self.db.execute(f'SELECT * FROM {REGISTRY}').fetchall(),original)
        self.assertEqual(snapshot(self.db),self.original)

    def test_04_bad_or_unsealed_parent_or_wrong_pk_or_foreign_manifest_denied(self) -> None:
        bundle = trusted_synthetic_bundle(self.db,PARENTS)
        # Even if manifest exists, its seal MUST exist before any child maps.
        self.db.execute(MANIFEST,bundle.manifest_params)
        for mapping in bundle.mappings:
            self.db.execute(MAPPING,mapping)
        with self.assertRaises(sqlite3.IntegrityError):
            register(self.db,bundle.manifest_sha,"sales_items","101")
        self.db.execute(SEAL,bundle.seal_params)
        for table, record_id in (
            ("sales_items","9999"),          # orphaned child
            ("sales_items","0101"),          # noncanonical integer alias
            ("sales_items","-1"),            # absent row
            ("journal_entries","0105"),
            ("patient_transactions","missing"),
            ("patients","101"),              # global mutable master not whitelisted
            ("no_such_table","1"),           # SQL injection/table discovery denied
        ):
            with self.subTest(table=table,record_id=record_id):
                with self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(INSERT,(table,record_id,bundle.manifest_sha,"a"*64,
                                            "synthetic-test-only://bad-child"))
        # Sealed foreign source bundle cannot be used for different parent's child.
        db2_source = Source("purchase_invoices","foreign-invoice","branch-b")
        self.db.execute("INSERT INTO purchase_invoices(id,pharmacy_id,supplier_id,payload)"
                        " VALUES('foreign-invoice','branch-b',999,'other tenant')")
        foreign_bundle = trusted_synthetic_bundle(
            self.db,(db2_source,),target="branch-b",
            grant="owner-b-1",approver="owner-b-2")
        self.db.execute(MANIFEST,foreign_bundle.manifest_params)
        self.db.execute(MAPPING,foreign_bundle.mappings[0])
        self.db.execute(SEAL,foreign_bundle.seal_params)
        with self.assertRaises(sqlite3.IntegrityError):
            register(self.db,foreign_bundle.manifest_sha,"purchase_invoice_items","102")
        # A physically existing child with the right key but NO mapped parent
        # still cannot register: neither orphan existence nor same-table
        # coincidence grants original provenance.
        self.db.execute("SAVEPOINT wrong_parent")
        try:
            self.db.execute("INSERT INTO sales_items VALUES(1001,'missing-sale',1)")
            with self.assertRaises(sqlite3.IntegrityError):
                register(self.db,bundle.manifest_sha,"sales_items","1001")
            self.db.execute("INSERT INTO supplier_transactions VALUES(1002,9999,1)")
            with self.assertRaises(sqlite3.IntegrityError):
                register(self.db,bundle.manifest_sha,"supplier_transactions","1002")
            self.db.execute("INSERT INTO patient_transactions VALUES('foreign-patient-ledger','not-this-patient',1)")
            with self.assertRaises(sqlite3.IntegrityError):
                register(self.db,bundle.manifest_sha,"patient_transactions","foreign-patient-ledger")
        finally:
            self.db.execute("ROLLBACK TO wrong_parent")
            self.db.execute("RELEASE wrong_parent")
        self.assertEqual(self.db.execute(f"SELECT count(*) FROM {REGISTRY}").fetchone(),(0,))
        self.assertEqual(snapshot(self.db),self.original)

    def test_05_registered_originals_and_new_unregistered_ids_coexist(self) -> None:
        bundle = seal_parents(self.db)
        for table, pk, *_ in DETAILS:
            register(self.db,bundle.manifest_sha,table,pk)
        for index,(table,_,fk,link,value) in enumerate(DETAILS,1):
            key = f"modern-{index}" if table=="patient_transactions" else 800+index
            with self.subTest(table=table):
                self.db.execute(
                    f'INSERT INTO "{table}"(id,"{fk}","{value}") VALUES(?,?,?)',
                    (key,link,3),
                )
                self.db.execute(f'UPDATE "{table}" SET "{value}"=4 WHERE id=?',(key,))
                self.db.execute(
                    f'INSERT OR REPLACE INTO "{table}"(id,"{fk}","{value}") VALUES(?,?,?)',
                    (key,link,5),
                )
                self.assertEqual(self.db.execute(
                    f'SELECT "{value}" FROM "{table}" WHERE id=?',(key,)).fetchone(),(5,))
                self.db.execute(f'DELETE FROM "{table}" WHERE id=?',(key,))
        self.assertEqual(snapshot(self.db),self.original)
        self.assertEqual(self.db.execute(f"SELECT count(*) FROM {REGISTRY}").fetchone(),(7,))

    def test_06_partial_registration_rollback_and_restart_in_memory(self) -> None:
        bundle = seal_parents(self.db)
        self.db.execute("BEGIN IMMEDIATE")
        register(self.db,bundle.manifest_sha,"sales_items","101")
        register(self.db,bundle.manifest_sha,"journal_entries","105")
        with self.assertRaises(sqlite3.IntegrityError):
            register(self.db,bundle.manifest_sha,"sales_items","9999",proof="a"*64)
        self.db.execute("ROLLBACK")
        self.assertEqual(self.db.execute(f"SELECT count(*) FROM {REGISTRY}").fetchone(),(0,))
        for table,pk,*_ in DETAILS:
            register(self.db,bundle.manifest_sha,table,pk)
        successor = sqlite3.connect(":memory:",isolation_level=None)
        try:
            self.db.backup(successor)
            self.db.close()
            self.db = successor
            successor = None
            self.db.execute("PRAGMA recursive_triggers=OFF")
            for table,pk,_,_,value in DETAILS:
                with self.subTest(table=table),self.assertRaises(sqlite3.IntegrityError):
                    self.db.execute(f'UPDATE "{table}" SET "{value}"=999 WHERE id=?',
                                    (int(pk) if pk.isdigit() else pk,))
            self.assertEqual(snapshot(self.db),self.original)
            self.assertEqual(self.db.execute(f"SELECT count(*) FROM {REGISTRY}").fetchone(),(7,))
        finally:
            if successor is not None:
                successor.close()

    def test_07_registration_preserves_existing_parent_rows_and_tenant_literals(self) -> None:
        baseline = rows_snapshot(self.db)
        originals = snapshot(self.db)
        # Installing 067 is a DDL-only action. Prospective synthetic mappings
        # happen separately; no sources are moved, given a new tenant literal,
        # or financially posted by the migration/registration itself.
        self.assertEqual(self.db.execute(f"SELECT count(*) FROM {REGISTRY}").fetchone(),(0,))
        bundle = seal_parents(self.db)
        for table, pk, *_ in DETAILS:
            register(self.db,bundle.manifest_sha,table,pk)
        self.assertEqual(rows_snapshot(self.db),baseline)
        self.assertEqual(snapshot(self.db),originals)
        self.assertEqual(self.db.execute(
            "SELECT original_identity_class,original_pharmacy_literal FROM "
            "native_legacy_upgrade_source_mappings WHERE source_table='sales_invoices'"
        ).fetchone(),("local_default","local_default"))
        self.assertEqual(self.db.execute(
            "SELECT original_identity_class,original_pharmacy_literal FROM "
            "native_legacy_upgrade_source_mappings WHERE source_table='purchase_orders'"
        ).fetchone(),("blank",""))


if __name__ == "__main__":
    unittest.main()
