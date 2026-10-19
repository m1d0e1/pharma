"""Isolated SQLite regression for native migration 063 and the *actual* action predicate.

Run: py -3 -m unittest -v scripts.qa_unused_drug_indexes_regression
The test uses :memory: ONLY; never opens a production, QA, patient, or finance DB.
All generated names and references are synthetic.
"""
import hashlib
import pathlib
import re
import sqlite3
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "src-tauri/migrations/063_unused_drug_reference_indexes.sql"
ACTION = ROOT / "src/app/actions-client/master-drugs.ts"

REFERENCES = (
    "inventory",
    "sales_items",
    "refill_reminders",
    "return_items",
    "purchase_invoice_items",
    "purchase_order_items",
    "purchase_return_items",
    "opening_balance_items",
    "shortages",
    "drug_indications",
    "drug_alternatives",
)
NEW_INDEXES = {
    "refill_reminders": "idx_refill_reminders_drug_id",
    "return_items": "idx_return_items_drug",
    "purchase_order_items": "idx_purchase_order_items_drug",
    "purchase_return_items": "idx_purchase_return_items_drug",
    "opening_balance_items": "idx_opening_balance_items_drug",
    "drug_alternatives": "idx_drug_alternatives_alternative",
}


def unused_items_sql():
    source = ACTION.read_text(encoding="utf-8")
    predicate = re.search(
        r"const MASTER_DRUG_REFERENCE_PREDICATE\s*=\s*`(.*?)`\s*;",
        source,
        re.DOTALL,
    )
    if not predicate:
        raise AssertionError("Production unused-item predicate no longer found")
    action = source.split("export async function getUnusedItemsAction()", 1)[1]
    action = action.split("export async function archiveMasterDrugAction", 1)[0]
    query = re.search(
        r"SELECT\s+(.+?)\s+FROM master_drugs m\s+WHERE NOT\s*"
        r"\(\$\{MASTER_DRUG_REFERENCE_PREDICATE\}\)\s+"
        r"ORDER BY m\.trade_name ASC",
        action,
        re.DOTALL,
    )
    if not query:
        raise AssertionError("Production unused-items SELECT shape changed")
    return (
        "SELECT " + " ".join(query.group(1).split()) + " FROM master_drugs m WHERE NOT ("
        + predicate.group(1)
        + ") ORDER BY m.trade_name ASC"
    )


def synthetic_database():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, "
        "trade_name TEXT NOT NULL, trade_name_en TEXT, manufacturer TEXT, "
        "official_price REAL, is_medicine INTEGER)"
    )
    conn.executemany(
        "INSERT INTO master_drugs (id,trade_name) VALUES (?,?)",
        ((i, f"SYNTHETIC_DRUG_{i:06d}") for i in range(1, 1501)),
    )
    for table in REFERENCES:
        if table == "drug_alternatives":
            conn.execute(
                "CREATE TABLE drug_alternatives("
                "drug_id INTEGER,alternative_id INTEGER,"
                "PRIMARY KEY(drug_id,alternative_id))"
            )
            conn.executemany(
                "INSERT INTO drug_alternatives VALUES (?,?)",
                ((1 + (i % 120), 1 + (i // 120)) for i in range(2400)),
            )
        else:
            conn.execute(
                f"CREATE TABLE {table} (id INTEGER PRIMARY KEY,drug_id INTEGER)"
            )
            conn.executemany(
                f"INSERT INTO {table} VALUES (?,?)",
                ((i, 1 + (i % 120)) for i in range(1, 2401)),
            )
    # Every reference source has a distinct, otherwise-unused sentinel drug.
    # Especially test a drug linked only as the alternative *target*.
    for i, table in enumerate(REFERENCES):
        drug_id = 201 + i
        if table == "drug_alternatives":
            conn.execute(
                "INSERT INTO drug_alternatives(drug_id,alternative_id) VALUES (?,?)",
                (drug_id, 212),
            )
        else:
            conn.execute(
                f"INSERT INTO {table}(id,drug_id) VALUES (?,?)",
                (100001 + i, drug_id),
            )
    # Existing indexed lookups from the *measured* disposable QA EXPLAIN.
    for table in (
        "inventory",
        "sales_items",
        "purchase_invoice_items",
        "shortages",
        "drug_indications",
    ):
        conn.execute(f"CREATE INDEX idx_existing_{table} ON {table}(drug_id)")
    conn.execute(
        "CREATE INDEX idx_existing_trade_name "
        "ON master_drugs(trade_name COLLATE NOCASE)"
    )
    return conn


def data_fingerprint(conn):
    """Digest all synthetic table rows to prove migration has zero data effects."""
    digest = hashlib.sha256()
    for table in ("master_drugs", *REFERENCES):
        digest.update(table.encode())
        for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid"):
            digest.update(repr(row).encode())
    return digest.hexdigest()


class UnusedDrugIndexMigrationTests(unittest.TestCase):
    def test_exact_production_predicate_includes_every_reference(self):
        sql = unused_items_sql()
        for table in REFERENCES:
            self.assertIn(f"FROM {table} WHERE", sql)
        self.assertIn("alternative_id = m.id", sql)
        self.assertEqual(sql.count("EXISTS("), len(REFERENCES))
        self.assertIn("ORDER BY m.trade_name ASC", sql)

    def test_additive_indexes_remove_reference_scans_without_mutating_any_data(self):
        sql = unused_items_sql()
        migration = MIGRATION.read_text(encoding="utf-8")
        non_comments = re.sub(r"--[^\n]*", "", migration).strip()
        statements = [part.strip() for part in non_comments.split(";") if part.strip()]
        self.assertEqual(len(statements), len(NEW_INDEXES))
        self.assertTrue(
            all(re.fullmatch(
                r"CREATE INDEX IF NOT EXISTS [a-z0-9_]+\s+"
                r"ON\s+[a-z0-9_]+\s*\(\s*[a-z0-9_]+\s*\)",
                statement,
                re.IGNORECASE,
            ) for statement in statements),
            "063 must be exclusively additive CREATE INDEX statements",
        )
        conn = synthetic_database()
        try:
            before_fingerprint = data_fingerprint(conn)
            before_plan = [r[3] for r in conn.execute("EXPLAIN QUERY PLAN " + sql)]
            for table in NEW_INDEXES:
                self.assertTrue(
                    any(f"SCAN {table}" in step for step in before_plan),
                    f"Expected unindexed lookup on {table}: {before_plan}",
                )
            start = time.perf_counter()
            before = conn.execute(sql).fetchall()
            baseline_ms = (time.perf_counter() - start) * 1000

            conn.executescript(migration)
            # Idempotence: no conflicting duplicate index or schema change.
            conn.executescript(migration)

            after_plan = [r[3] for r in conn.execute("EXPLAIN QUERY PLAN " + sql)]
            for table, index in NEW_INDEXES.items():
                self.assertIn(
                    index,
                    [r[1] for r in conn.execute(f"PRAGMA index_list({table})")],
                )
                self.assertTrue(
                    any(f"SEARCH {table}" in step for step in after_plan),
                    f"Missing indexed lookup on {table}: {after_plan}",
                )
                self.assertFalse(
                    any(f"SCAN {table}" in step for step in after_plan),
                    f"Full reference scan survived 063 on {table}",
                )
            self.assertTrue(
                any("alternative_id=?" in step for step in after_plan),
                "Alternative-as-target lookups should use new alternative_id index",
            )
            start = time.perf_counter()
            after = conn.execute(sql).fetchall()
            indexed_ms = (time.perf_counter() - start) * 1000
            self.assertEqual(
                [row[0] for row in before],
                [row[0] for row in after],
                "Indexes cannot change which medicines are safe to delete",
            )
            # 1..120 are referenced by the synthetic history, 201..211 by
            # distinct reference tables, and 212 by alternative_id only.
            forbidden = set(range(1, 121)) | set(range(201, 213))
            candidates = {row[0] for row in after}
            self.assertFalse(candidates & forbidden)
            self.assertIn(213, candidates)
            self.assertEqual(len(before), 1368)
            self.assertEqual(data_fingerprint(conn), before_fingerprint)
            self.assertGreater(
                baseline_ms, indexed_ms * 5,
                f"Synthetic relationship scan regression: "
                f"before={baseline_ms:.2f}ms after={indexed_ms:.2f}ms",
            )
            print(
                f"IN_MEMORY_ONLY catalog=1500 refs_per_table=2400 "
                f"before_ms={baseline_ms:.3f} after_ms={indexed_ms:.3f}"
            )
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
