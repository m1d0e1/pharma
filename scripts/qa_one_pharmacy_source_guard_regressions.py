"""Safety regressions for historical single-pharmacy *candidate* scope mapping.

Entirely synthetic in-memory tables. These tests never open real pharmacy files.
The acceptance here is structural and MUST NOT assert owner authorization.
"""
from __future__ import annotations

import sqlite3
import unittest

from scripts.qa_v02110_primary_pharmacy_migration import (
    Refused, TENANT, SEALED_PIN, _mutate_scopes,
    assert_single_pharmacy_source, read_only_native_version, native_version,
)


def fixture() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.executescript("""
        CREATE TABLE users (
          id TEXT PRIMARY KEY,role TEXT NOT NULL,
          is_active INTEGER NOT NULL,pharmacy_id TEXT
        );
        INSERT INTO users VALUES ('admin','owner',1,'local_default');
        INSERT INTO users VALUES ('staff','pharmacist',0,NULL);
        CREATE TABLE sales_invoices (
          id TEXT PRIMARY KEY,pharmacy_id TEXT,amount REAL NOT NULL
        );
        INSERT INTO sales_invoices VALUES ('s1',NULL,41.17);
        INSERT INTO sales_invoices VALUES ('s2','local_default',97.05);
        INSERT INTO sales_invoices VALUES ('s3','primary_pharmacy',0.0);
        CREATE TABLE expenses (
          id TEXT PRIMARY KEY,pharmacy_id,amount REAL NOT NULL
        );
        INSERT INTO expenses VALUES ('e1','  ',10.50);
    """)
    return conn


class OnePharmacyScopeGateTests(unittest.TestCase):
    def test_read_only_preflight_accepts_complete_legacy_v52_without_upgrade_authority(self):
        # The currently blocked licensed QA app has native version 52. The
        # check-only path must recognize its ledger without treating a scope
        # or a migration-version observation as historical owner consent.
        with fixture() as db:
            db.execute("CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,success INTEGER)")
            db.executemany("INSERT INTO _sqlx_migrations VALUES (?,1)",
                           ((version,) for version in range(1, 53)))
            self.assertEqual(read_only_native_version(db), 52)
            self.assertEqual(assert_single_pharmacy_source(db)["local_default"], 2)
            with self.assertRaisesRegex(Refused, "v67"):
                native_version(db)  # Actual copy mutation remains v67-only.

    def test_read_only_preflight_accepts_complete_v29_v67_and_v69(self):
        for last in (29, 67, 69):
            with self.subTest(last=last), fixture() as db:
                db.execute("CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,success INTEGER)")
                db.executemany("INSERT INTO _sqlx_migrations VALUES (?,1)",
                               ((version,) for version in range(1, last + 1)))
                self.assertEqual(read_only_native_version(db), last)

    def test_preflight_rejects_gaps_failures_invalid_storage_and_future_versions(self):
        for mode in ("missing", "gap", "failure", "text", "future"):
            with self.subTest(mode=mode), fixture() as db:
                if mode == "missing":
                    with self.assertRaisesRegex(Refused, "missing"):
                        read_only_native_version(db)
                    continue
                db.execute("CREATE TABLE _sqlx_migrations(version PRIMARY KEY,success)")
                db.executemany("INSERT INTO _sqlx_migrations VALUES (?,1)",
                               ((version,) for version in range(1, 53)))
                if mode == "gap":
                    db.execute("DELETE FROM _sqlx_migrations WHERE version=24")
                elif mode == "failure":
                    db.execute("UPDATE _sqlx_migrations SET success=0 WHERE version=30")
                elif mode == "text":
                    db.execute("UPDATE _sqlx_migrations SET success='1' WHERE version=30")
                else:
                    db.executemany("INSERT INTO _sqlx_migrations VALUES (?,1)",
                                   ((version,) for version in range(53, 71)))
                with self.assertRaisesRegex(Refused, "incomplete, failed or unsupported"):
                    read_only_native_version(db)

    @staticmethod
    def with_stage_ledger(db: sqlite3.Connection, expected_count: int = 5):
        db.execute("""CREATE TABLE qa_primary_scope_meta (
          singleton INTEGER PRIMARY KEY, phase TEXT NOT NULL,
          source_sha256 TEXT, sealed_sha256 TEXT,
          proposed_tenant TEXT, original_direct_scope_count INTEGER,
          original_physical_table_count INTEGER
        )""")
        db.execute("""INSERT INTO qa_primary_scope_meta VALUES
          (1,'PREPARED',?,?,?,?,?)""", (
            "0" * 64, SEALED_PIN, TENANT, expected_count, 4
        ))
        db.execute("""CREATE TABLE qa_primary_scope_originals (
          source_table TEXT,source_rowid INTEGER,original_literal BLOB
        )""")
        for table in ["users", "sales_invoices", "expenses"]:
            db.execute(
                f"INSERT INTO qa_primary_scope_originals "
                f"SELECT ?,rowid,pharmacy_id FROM {table} "
                f"WHERE pharmacy_id IS NOT ?", (table, TENANT)
            )
        db.executescript("""
            CREATE TRIGGER retain_native_business_guard
            BEFORE UPDATE ON sales_invoices
            BEGIN SELECT RAISE(ABORT,'Native trigger must not be removed'); END;
        """)
        db.commit()

    def test_allowed_classes_are_not_authorization(self):
        with fixture() as db:
            classes = assert_single_pharmacy_source(db)
            self.assertEqual(classes, {
                "null": 2, "blank": 1, "local_default": 2,
                TENANT: 1,
            })
            self.assertEqual(db.execute(
                "SELECT amount FROM sales_invoices WHERE id='s1'"
            ).fetchone()[0], 41.17)

    def test_reject_explicit_competing_scope_in_every_table_including_inactive(self):
        for table, key in [
            ("users", "staff"), ("sales_invoices", "s2"), ("expenses", "e1")
        ]:
            with self.subTest(table=table), fixture() as db:
                db.execute(
                    f"UPDATE {table} SET pharmacy_id='other_pharmacy' WHERE id=?",
                    (key,),
                )
                before = db.execute(
                    f"SELECT pharmacy_id FROM {table} WHERE id=?", (key,)
                ).fetchone()[0]
                with self.assertRaisesRegex(Refused, "foreign/ambiguous"):
                    assert_single_pharmacy_source(db)
                self.assertEqual(db.execute(
                    f"SELECT pharmacy_id FROM {table} WHERE id=?", (key,)
                ).fetchone()[0], before)

    def test_reject_case_folded_or_coerced_tenant_values(self):
        for other in ["LOCAL_DEFAULT", "Primary_Pharmacy", "pharmacy-2",
                      " local_default", "primary_pharmacy ", 1, 0, b"local_default"]:
            with self.subTest(other=other), fixture() as db:
                db.execute(
                    "UPDATE expenses SET pharmacy_id=? WHERE id='e1'", (other,)
                )
                with self.assertRaises(Refused):
                    assert_single_pharmacy_source(db)

    def test_requires_one_active_owner_even_for_single_pharmacy(self):
        with fixture() as db:
            db.execute("UPDATE users SET is_active=0 WHERE id='admin'")
            with self.assertRaisesRegex(Refused, "Exactly one active"):
                assert_single_pharmacy_source(db)
        with fixture() as db:
            db.execute(
                "INSERT INTO users VALUES('retired','owner',0,'local_default')"
            )
            self.assertEqual(
                assert_single_pharmacy_source(db)["local_default"], 3,
                "An inactive historical owner is not an active contender"
            )
        with fixture() as db:
            db.execute(
                "INSERT INTO users VALUES('co-owner','owner',1,'primary_pharmacy')"
            )
            with self.assertRaisesRegex(Refused, "Exactly one active"):
                assert_single_pharmacy_source(db)

    def test_qa_scope_normalizer_denies_foreign_tenant_before_any_trigger_drop(self):
        with fixture() as db:
            self.with_stage_ledger(db)
            db.execute(
                "UPDATE expenses SET pharmacy_id='OTHER' WHERE id='e1'"
            )
            db.commit()
            before = list(db.execute(
                "SELECT name,sql FROM sqlite_master WHERE type='trigger'"
            ))
            with self.assertRaisesRegex(Refused, "foreign/ambiguous"):
                _mutate_scopes(db, restore=False)
            self.assertEqual(
                before, list(db.execute(
                    "SELECT name,sql FROM sqlite_master WHERE type='trigger'"
                ))
            )
            self.assertEqual(
                db.execute("SELECT phase FROM qa_primary_scope_meta").fetchone()[0],
                "PREPARED",
            )
            self.assertEqual(db.execute(
                "SELECT pharmacy_id FROM users WHERE id='admin'"
            ).fetchone()[0], "local_default")

    def test_normalize_rollback_normalize_preserves_finance_and_native_triggers(self):
        with fixture() as db:
            self.with_stage_ledger(db)
            originals = {
                table: db.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
                for table in ("users", "sales_invoices", "expenses")
            }
            before_triggers = db.execute(
                "SELECT name,sql FROM sqlite_master WHERE type='trigger'"
            ).fetchall()
            self.assertEqual(_mutate_scopes(db, restore=False), 5)
            self.assertEqual(_mutate_scopes(db, restore=False), 0)
            for table in originals:
                self.assertEqual(
                    {r[0] for r in db.execute(f"SELECT pharmacy_id FROM {table}")},
                    {TENANT},
                )
            self.assertEqual(_mutate_scopes(db, restore=True), 5)
            for table, old in originals.items():
                self.assertEqual(
                    db.execute(f"SELECT * FROM {table} ORDER BY id").fetchall(), old
                )
            self.assertEqual(db.execute(
                "SELECT name,sql FROM sqlite_master WHERE type='trigger'"
            ).fetchall(), before_triggers)
            self.assertEqual(_mutate_scopes(db, restore=False), 5)

    def test_normalization_error_rolls_back_every_scope_change_and_trigger(self):
        with fixture() as db:
            self.with_stage_ledger(db, expected_count=100)
            original_scope = db.execute(
                "SELECT id,pharmacy_id FROM sales_invoices ORDER BY id"
            ).fetchall()
            with self.assertRaisesRegex(Refused, "Direct scope row count"):
                _mutate_scopes(db, restore=False)
            self.assertEqual(db.execute(
                "SELECT id,pharmacy_id FROM sales_invoices ORDER BY id"
            ).fetchall(), original_scope)
            self.assertEqual(db.execute(
                "SELECT phase FROM qa_primary_scope_meta"
            ).fetchone()[0], "PREPARED")
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM sqlite_master "
                "WHERE type='trigger' AND name='retain_native_business_guard'"
            ).fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
