"""Synthetic SQLite-only regression for the native account compatibility seed.

Extracts and executes the real SQL from src-tauri/src/schema.rs; never opens
any installed, sealed, QA, or production database. The SQLite fixture uses
the exact original accounts CREATE TABLE from migration 001, in private RAM.
"""
from __future__ import annotations

from contextlib import closing
from pathlib import Path
import re
import sqlite3
import unittest


ROOT = Path(__file__).resolve().parents[1]

# Guard source defaults and order independently from the SQL under test.
EXPECTED = (
    ("1.1.1", "الصندوق", "Cash Drawer", "asset", 0),
    ("2.1", "دائنون", "Accounts Payable", "liability", 0),
    ("1.1.2", "حسابات العملاء", "Accounts Receivable", "asset", 0),
    ("3.1", "إيرادات المبيعات", "Sales Revenue", "revenue", 0),
    ("1.1.3", "المخزون السلعي", "Inventory Asset", "asset", 0),
    ("4.1", "تكلفة البضاعة المباعة", "Cost of Goods Sold", "expense", 0),
    ("1.1.4", "تسويات البنوك", "Bank Clearing", "asset", 0),
    ("2.2", "أرصدة محافظ العملاء", "Patient Wallet Liability", "liability", 0),
    ("4.2", "تسويات حسابات العملاء", "Customer Adjustments", "expense", 0),
    ("3.9", "حقوق ملكية الأرصدة الافتتاحية", "Opening Balance Equity", "equity", 0),
    ("3.2", "إيرادات نقدية أخرى", "Other Cash Income", "revenue", 0),
    ("3.3", "تسويات نقدية للموردين", "Supplier Cash Adjustments", "revenue", 0),
    ("3.8", "مسحوبات المالك", "Owner Drawings", "equity", 0),
    ("4.4", "مصروفات تشغيلية عامة", "General Operating Expenses", "expense", 0),
)


def actual_seed_sql() -> str:
    source = (ROOT / "src-tauri" / "src" / "schema.rs").read_text(encoding="utf-8")
    marker = "// Seed rows added to old migrations are not replayed on upgrades."
    if source.count(marker) != 1:
        raise AssertionError("Expected one native account compatibility seed")
    tail = source.split(marker, 1)[1]
    match = re.search(r'sqlx::raw_sql\(\s*r#"(.*?)"#', tail, flags=re.DOTALL)
    if match is None:
        raise AssertionError("Missing native compatibility raw SQL")
    # Ignore SQL line comments while locating the first statement terminator:
    # comments may legitimately contain semicolons.
    statements = re.sub(r"(?m)^[ \t]*--[^\n]*", "", match.group(1))
    first, sep, _ = statements.partition(";")
    if not sep or not re.search(r"\bINSERT\s+OR\s+IGNORE\s+INTO\s+accounts\b", first,
                                re.IGNORECASE):
        raise AssertionError("The native account seed no longer preserves INSERT OR IGNORE")
    if len(re.findall(r"\bINSERT\s+OR\s+IGNORE\s+INTO\s+accounts\b",
                      match.group(1), re.IGNORECASE)) != 1:
        raise AssertionError("Expected exactly one native compatibility account insert")
    return first + ";"


def real_accounts_ddl() -> str:
    source = (ROOT / "src-tauri" / "migrations" / "001_initial.sql").read_text(
        encoding="utf-8"
    )
    statements = re.findall(r"CREATE TABLE IF NOT EXISTS accounts\s*\(.*?\);",
                            source, flags=re.DOTALL | re.IGNORECASE)
    if len(statements) != 1 or "AUTOINCREMENT" not in statements[0]:
        raise AssertionError("Original accounts AUTOINCREMENT schema changed")
    return statements[0]


def rows(db: sqlite3.Connection) -> list[tuple]:
    return db.execute(
        "SELECT id, parent_id, code, name_ar, name_en, type, is_group, balance, "
        "created_at FROM accounts ORDER BY id"
    ).fetchall()


def seq(db: sqlite3.Connection) -> int:
    return db.execute(
        "SELECT seq FROM sqlite_sequence WHERE name='accounts'"
    ).fetchone()[0]


class NativeAccountCompatibilitySeedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute(real_accounts_ddl())
        self.seed = actual_seed_sql()

    def seed_once(self) -> None:
        self.db.execute(self.seed)

    def bump_to_historical_seq(self) -> None:
        # Purely synthetic gap simulates the v29 AUTO-INCREMENT high-water mark.
        self.db.execute(
            "INSERT INTO accounts(id,code,name_ar,type) "
            "VALUES(4815,'synthetic-sentinel','Synthetic','asset')"
        )
        self.db.execute("DELETE FROM accounts WHERE id=4815")
        self.assertEqual(seq(self.db), 4815)

    def test_fresh_seed_preserves_all_original_defaults_and_order(self) -> None:
        self.seed_once()
        actual = self.db.execute(
            "SELECT code,name_ar,name_en,type,is_group FROM accounts ORDER BY id"
        ).fetchall()
        self.assertEqual(actual, list(EXPECTED))
        self.assertEqual([row[0] for row in rows(self.db)],
                         list(range(1, len(EXPECTED) + 1)))
        self.assertEqual(seq(self.db), len(EXPECTED))

    def test_repeated_startup_does_not_advance_historical_autoincrement(self) -> None:
        self.seed_once()
        # INSERT OR IGNORE historically preserves a customized existing code.
        self.db.execute(
            "UPDATE accounts SET name_en='Customized Cash', is_group=1 "
            "WHERE code='1.1.1'"
        )
        self.bump_to_historical_seq()
        before = rows(self.db)
        for _ in range(3):
            self.seed_once()
            self.assertEqual(rows(self.db), before)
            self.assertEqual(seq(self.db), 4815)

    def test_genuinely_missing_code_inserts_only_it_once(self) -> None:
        self.seed_once()
        missing = EXPECTED[9]  # middle account, canonical code '3.9'
        self.db.execute("DELETE FROM accounts WHERE code=?", (missing[0],))
        self.bump_to_historical_seq()
        before = rows(self.db)

        self.seed_once()
        after = rows(self.db)
        self.assertEqual(len(after), len(before) + 1)
        self.assertEqual([row for row in after if row in before], before)
        new_rows = [row for row in after if row not in before]
        self.assertEqual(len(new_rows), 1)
        self.assertEqual(new_rows[0][0], 4816)
        self.assertEqual(new_rows[0][2:7], missing)
        self.assertEqual(new_rows[0][1], None)
        self.assertEqual(new_rows[0][7], 0)
        self.assertEqual(seq(self.db), 4816)

        self.seed_once()
        self.assertEqual(rows(self.db), after)
        self.assertEqual(seq(self.db), 4816)


if __name__ == "__main__":
    unittest.main()
