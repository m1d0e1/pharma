"""Current installed v0.2.109 business facts after isolated primary_pharmacy v68.

Reads only *pinned disposable* copies of the actual installed v29 source and
its normalized/audited v68 outcome via OS bytes deserialized in RAM. Verifies
original currency, fractional quantities, costs, patient/supplier balances,
cash shifts, invoice lines, returns, accounting and original identifiers by
typed physical row comparison, rather than comparing aggregate totals alone.
This is data integrity and report continuity, NOT customer authorization or
authenticated native GUI acceptance.
"""
from __future__ import annotations

from contextlib import closing
from collections import defaultdict
from decimal import Decimal
import hashlib
import itertools
import json
import os
from pathlib import Path
import sqlite3
import sys

from scripts.qa_v02110_primary_pharmacy_migration import typed, same

ORIGINAL_SHA = "4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197"
MAPPED_068_SHA = "b6e9f4edfb725cc403bb5aebdbe5308dc979d19ccf3f723dfc78087af53c47db"
LOCAL = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
ORIGINAL = LOCAL / "pharma-v02110-current-installed-offline-3c440154ab73402cab74949543ce2879" / "current-v02109-offline-source.sqlite3"
MAPPED = LOCAL / "pharma-v02110-primary-pharmacy-native-068-d054f6059df04bd685d8d5823499ee75" / "NATIVE-068-UNSIGNED-TEST-ONLY.sqlite3"
METRICS: dict[str, tuple[str, ...]] = {
    "inventory": ("quantity", "cost_price", "local_selling_price", "unit_price",
                  "strips_per_box", "medium_to_small"),
    "purchase_invoices": ("total_amount", "paid_amount", "expenses", "discount_value"),
    "purchase_invoice_items": ("quantity", "bonus_quantity", "cost_price", "selling_price"),
    "sales_invoices": ("total_amount", "discount_amount", "paid_amount", "remaining_amount"),
    "sales_items": ("quantity_sold", "unit_price", "cost_price", "large_to_medium", "medium_to_small"),
    "patients": ("opening_balance", "credit_limit", "points_balance", "wallet_balance", "point_value"),
    "patient_transactions": ("amount",),
    "suppliers": ("balance",),
    "supplier_transactions": ("amount",),
    "accounts": ("balance",),
    "daily_journals": ("total_amount",),
    "journal_entries": ("amount",),
    "shifts": ("starting_cash", "ending_cash", "actual_cash", "transfer_amount",
               "cash_difference", "treasury_retained_cash"),
    "cash_movements": ("amount",),
    "purchase_returns": ("total_amount",),
    "purchase_return_items": ("quantity_returned", "unit_price", "total_price"),
    "returns": ("total_refund",),
    "return_items": ("quantity_returned", "total_price"),
}


def pinned_bytes(path: Path, expected: str) -> bytes:
    if not path.is_file() or path.is_symlink() or path.parent.is_symlink():
        raise ValueError("Missing or indirect QA source")
    if path.parent.parent.resolve(strict=True) != LOCAL.resolve(strict=True):
        raise ValueError("Never use an installed/customer profile")
    if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise ValueError("Cannot read a detached copy with WAL/journal sidecars")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("Pinned original or mapped v68 copy differs")
    return raw


def selected_rows(db: sqlite3.Connection, table: str, columns: list[str]):
    quoted = ",".join('"' + x.replace('"', '""') + '"' for x in columns)
    return db.execute(f'SELECT rowid,{quoted} FROM "{table}" ORDER BY rowid')


def metrics(db: sqlite3.Connection, table: str, names: tuple[str, ...]) -> dict:
    output = {}
    for column in names:
        total = Decimal(0)
        nonnull = 0
        for (value,) in db.execute(f'SELECT "{column}" FROM "{table}"'):
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("Unexpected nonnumeric historical financial storage")
            total += Decimal(str(value))
            nonnull += 1
        output[column] = {"sum": str(total), "non_null_values": nonnull}
    return output


def journal_balances(db: sqlite3.Connection) -> tuple[int, int, dict[str, tuple[str, str]]]:
    by_journal: dict[str, list[Decimal]] = defaultdict(lambda: [Decimal(0), Decimal(0)])
    for journal_id, kind, raw in db.execute(
            "SELECT journal_id,type,amount FROM journal_entries ORDER BY rowid"):
        if kind not in ("debit", "credit") or not isinstance(raw, (int, float)):
            raise ValueError("Unrecognized original journal posting type")
        by_journal[str(journal_id)][0 if kind == "debit" else 1] += Decimal(str(raw))
    balanced = 0
    result = {}
    for journal_id, (debit, credit) in sorted(by_journal.items()):
        if abs(debit - credit) <= Decimal("0.00001"):
            balanced += 1
        result[journal_id] = (str(debit), str(credit))
    return len(by_journal), balanced, result


def check() -> dict:
    v29_data = pinned_bytes(ORIGINAL, ORIGINAL_SHA)
    v68_data = pinned_bytes(MAPPED, MAPPED_068_SHA)
    with closing(sqlite3.connect(":memory:")) as before, closing(sqlite3.connect(":memory:")) as after:
        before.deserialize(v29_data)
        after.deserialize(v68_data)
        before.execute("PRAGMA query_only=ON")
        after.execute("PRAGMA query_only=ON")
        if any(db.execute("PRAGMA integrity_check").fetchone() != ("ok",)
               or db.execute("PRAGMA foreign_key_check").fetchone() is not None
               for db in (before, after)):
            raise ValueError("Current-history SQLite integrity or FK failed")
        if before.execute("SELECT MAX(version) FROM _sqlx_migrations").fetchone() != (29,):
            raise ValueError("Not original current installed v29")
        # A 068 audit was added via SQL-only isolated staging; the signed
        # owner-less candidate intentionally retains the migrated 067 ledger.
        if after.execute("SELECT MAX(version) FROM _sqlx_migrations").fetchone() != (67,):
            raise ValueError("Unexpected detached QA-only v68 registry")
        audit = after.execute(
            "SELECT expected_original_scope_count,expected_relation_witness_count,"
            "original_physical_row_count,pharmacy_id FROM native_primary_scope_audit_batches"
        ).fetchall()
        if audit != [(7567, 147, 289816, "primary_pharmacy")]:
            raise ValueError("Real v68 typed scope/relationship provenance drift")
        if after.execute("SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone() != (0,):
            raise ValueError("QA-only history unexpectedly granted owner access")
        data = {}
        verified_rows = 0
        original_journals, balanced_journals, original_journal_totals = journal_balances(before)
        new_journals, new_balanced, new_journal_totals = journal_balances(after)
        if (original_journals, balanced_journals, original_journal_totals) != (
                new_journals, new_balanced, new_journal_totals):
            raise ValueError("Original debit/credit journal facts changed across upgrade")
        for table, fieldnames in METRICS.items():
            original_cols = [x[1] for x in before.execute(f'PRAGMA table_info("{table}")')]
            new_cols = [x[1] for x in after.execute(f'PRAGMA table_info("{table}")')]
            if not original_cols or not set(original_cols).issubset(new_cols):
                raise ValueError(f"Original business table/fields absent: {table}")
            if not set(fieldnames).issubset(original_cols):
                raise ValueError(f"Historical numeric source fields absent: {table}")
            original_finance = metrics(before, table, fieldnames)
            if original_finance != metrics(after, table, fieldnames):
                raise ValueError(f"Historical financial totals changed: {table}")
            compared = 0
            for older, newer in itertools.zip_longest(
                    selected_rows(before, table, original_cols),
                    selected_rows(after, table, original_cols), fillvalue=None):
                if older is None or newer is None or len(older) != len(newer):
                    raise ValueError(f"Original physical identifiers changed: {table}")
                for index, column in enumerate(("rowid", *original_cols)):
                    if column == "pharmacy_id":
                        if newer[index] != "primary_pharmacy":
                            raise ValueError(f"Unmapped direct finance scope in {table}")
                        continue
                    if not same(older[index], newer[index]):
                        raise ValueError(f"Original typed value or rowid changed in {table}.{column}")
                compared += 1
            verified_rows += compared
            data[table] = {"original_rows": compared, "financial_and_quantity_projection": original_finance}
        if hashlib.sha256(ORIGINAL.read_bytes()).hexdigest() != ORIGINAL_SHA:
            raise ValueError("Current installed snapshot changed while reading")
        if hashlib.sha256(MAPPED.read_bytes()).hexdigest() != MAPPED_068_SHA:
            raise ValueError("Detached normalized v68 source changed while reading")
    return {
        "status": "PASS_CURRENT_REAL_HISTORY_POST_UPDATE_FINANCIAL_AND_STOCK_PARITY",
        "original_installed_snapshot_sha256": ORIGINAL_SHA,
        "mapped_068_disposable_sha256": MAPPED_068_SHA,
        "canonical_tenant": "primary_pharmacy",
        "original_business_tables_checked": len(data),
        "original_business_rows_type_checked": verified_rows,
        "original_scope_literals_archived": 7567,
        "direct_and_indirect_graph_witnesses": 147,
        "financial_and_fractional_values_conserved": True,
        "original_journals_checked": original_journals,
        "original_journals_balanced_to_one_hundredth_milliunit": balanced_journals,
        "original_journal_debits_and_credits_type_exact_after_update": True,
        "metric_tables": data,
        "owner_authentication_verified": False,
        "native_sqlx_068_ledger_applied": False,
        "positive_historical_windows_gui_tested": False,
        "original_installation_modified": False,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(check(), sort_keys=True))
    except (OSError, ValueError, sqlite3.Error):
        print("REFUSED current real pharmacy financial/stock parity", file=sys.stderr)
        raise SystemExit(2)
