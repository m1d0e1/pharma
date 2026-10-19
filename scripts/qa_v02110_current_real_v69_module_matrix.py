"""Read-only eight-module acceptance against ACTUAL CURRENT v0.2.109 history.

Reads a freshly captured, SHA-pinned installed-v29 disposable snapshot and the
independently native-SQLx69, primary_pharmacy-normalized disposable candidate
as OS bytes into private SQLite memory. NEVER tests synthetic fixtures, writes
to source SQLite, performs a login, or treats the graph as owner authorization.
"""
from __future__ import annotations

from contextlib import closing
from decimal import Decimal
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

from scripts.qa_v02110_primary_pharmacy_migration import same
from scripts.qa_v02110_current_installed_snapshot import INSTALLED_SHA, no_sidecars
from scripts import qa_v02110_native_sqlx69_primary_scope_postflight as native_postflight
from scripts import qa_v02110_primary_pharmacy_migration as source_guard

ROOT = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
SOURCE_PATTERN = re.compile(r"pharma-v02110-current-installed-offline-[a-f0-9]{32}\Z")
NATIVE_NAME = "pharma-v02110-native-sqlx69-primary-scope-43d756ccfe4d43a0a6b0c07ee742b53a"
NATIVE_FILE = "NATIVE-SQLX69-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3"
NATIVE_SHA = "bf0a85e37bce355a75cd741186f206887e4e9912df0d7a511ee299a0fde15e08"
TENANT = "primary_pharmacy"

MODULES = {
    "catalog_drugs_units_manufacturers_interactions": ("master_drugs", "drug_interactions", "units", "manufacturers"),
    "inventory_batches_adjustments_shortages_opening": ("inventory", "stock_adjustments", "shortages", "opening_balances", "opening_balance_items"),
    "purchases_orders_invoices_items": ("purchase_orders", "purchase_order_items", "purchase_invoices", "purchase_invoice_items"),
    "supplier_balances_transactions_purchase_returns": ("suppliers", "supplier_transactions", "purchase_returns", "purchase_return_items"),
    "sales_pos_refunds_returns": ("sales_invoices", "sales_items", "returns", "return_items"),
    "patients_credits_allergies_conditions": ("patients", "patient_transactions", "patient_allergies", "patient_conditions"),
    "shifts_cash_banks_cards_registers": ("shifts", "cash_movements", "banks", "credit_cards", "points_of_sale"),
    "accounts_journals_expenses_notices": ("accounts", "daily_journals", "journal_entries", "expenses", "financial_notices"),
}


def pinned_data(path: Path, expected: str) -> bytes:
    if (not path.is_file() or path.is_symlink() or path.parent.is_symlink()
            or path.parent.parent.resolve(strict=True) != ROOT.resolve(strict=True)):
        raise ValueError("Only exact private detached QA source files are permitted")
    no_sidecars(path)
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Immutable current pharmacy data digest mismatch")
    return data


def rows(db: sqlite3.Connection, table: str, cols: list[str]):
    names = ",".join('"' + c.replace('"', '""') + '"' for c in cols)
    return db.execute(f'SELECT rowid,{names} FROM "{table}" ORDER BY rowid')


def module_assertions(original: sqlite3.Connection, mapped: sqlite3.Connection) -> dict:
    if [d.execute("PRAGMA integrity_check").fetchone()[0] for d in (original, mapped)] != ["ok", "ok"]:
        raise ValueError("Historical SQLite integrity is not valid")
    if any(d.execute("PRAGMA foreign_key_check").fetchone() for d in (original, mapped)):
        raise ValueError("Historical source or native69 foreign key failure")
    versions = [d.execute("SELECT max(version) FROM _sqlx_migrations WHERE success=1").fetchone()[0]
                for d in (original, mapped)]
    if versions != [29, 69]:
        raise ValueError("A real installed v29 to registered native69 pair is required")
    if mapped.execute("SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone()[0] != 0:
        raise ValueError("Unsigned history has forged owner attestation")
    old_seq = original.execute("SELECT seq FROM sqlite_sequence WHERE name='accounts'").fetchone()
    new_seq = mapped.execute("SELECT seq FROM sqlite_sequence WHERE name='accounts'").fetchone()
    if old_seq != (4829,) or new_seq != old_seq:
        raise ValueError("Original accounts AUTOINCREMENT metadata changed")

    summary: dict[str, dict] = {}
    total_verified = 0
    total_tenant_scope = 0
    for category, tables in MODULES.items():
        table_counts = {}
        for table in tables:
            original_cols = [r[1] for r in original.execute(f'PRAGMA table_info("{table}")')]
            migrated_cols = [r[1] for r in mapped.execute(f'PRAGMA table_info("{table}")')]
            if not original_cols or not set(original_cols).issubset(migrated_cols):
                raise ValueError("Missing actual original module or native69 column: " + table)
            count = 0
            for a, b in itertools.zip_longest(rows(original, table, original_cols),
                                                rows(mapped, table, original_cols)):
                if a is None or b is None or len(a) != len(b) or not same(a[0], b[0]):
                    raise ValueError("Actual real-history original rowid changed: " + table)
                for col, old, new in zip(original_cols, a[1:], b[1:]):
                    if col == "pharmacy_id":
                        if (old is not None and old != "" and old != "local_default") or new != TENANT:
                            raise ValueError("A foreign original scope was adopted: " + table)
                        total_tenant_scope += 1
                    elif not same(old, new):
                        raise ValueError("Actual historical typed field changed: " + table + "." + col)
                count += 1
            table_counts[table] = count
            total_verified += count
        summary[category] = {"status": "PASS_REAL_ORIGINAL_ROWS_TYPE_EXACT", "tables": table_counts,
                             "original_business_rows": sum(table_counts.values())}

    # Original journal identity, sums and balanced status must be conserved.
    def journals(db: sqlite3.Connection):
        result = {}
        for j, kind, amount in db.execute("SELECT journal_id,type,amount FROM journal_entries ORDER BY rowid"):
            key = str(j)
            if kind not in ("debit", "credit") or type(amount) not in (float, int):
                raise ValueError("Unrecognized original journal entry")
            result.setdefault(key, [Decimal(0), Decimal(0)])[0 if kind == "debit" else 1] += Decimal(str(amount))
        return result
    a, b = journals(original), journals(mapped)
    if a != b or len(a) != 1856 or sum(abs(v[0]-v[1]) <= Decimal("0.00001") for v in a.values()) != 1856:
        raise ValueError("Actual historical double entry or journal identifiers differ")
    return {
        "status": "PASS_EIGHT_MODULES_REAL_CURRENT_INSTALLED_V29_TO_NATIVE_V69",
        "source": "ACTUAL_CURRENT_INSTALLED_V0.2.109_DISPOSABLE_SNAPSHOT_NOT_SYNTHETIC",
        "canonical_mapped_tenant": TENANT,
        "modules": summary,
        "module_count": len(summary),
        "original_module_business_rows_verified": total_verified,
        "original_direct_scope_fields_checked_in_modules": total_tenant_scope,
        "journals_exactly_balanced_and_preserved": 1856,
        "sqlite_integrity_and_fk": "PASS",
        "original_accounts_autoincrement_sequence": 4829,
        "historical_owner_independently_authenticated": False,
        "business_gui_mutation_authorized": False,
        "synthetic_data_used": False,
        "production_ready": False,
    }


def check(source: Path, native_report: Path | None = None) -> dict:
    if (source.name != "current-v02109-offline-source.sqlite3"
        or not SOURCE_PATTERN.fullmatch(source.parent.name)):
        raise ValueError("A freshly designated current installed real v29 source is mandatory")
    before_bytes = pinned_data(source, INSTALLED_SHA)
    if native_report is None:
        candidate = ROOT / NATIVE_NAME / NATIVE_FILE
        candidate_sha = NATIVE_SHA
    else:
        # First validate the new actual Rust-SQLx69 result independently,
        # including the same source SHA and exact immutable migration ledger.
        report = native_postflight.audit(native_report)
        if report["status"] != "PASS_NATIVE_SQLX69_TWICE_CURRENT_PRIMARY_TYPED_PARITY":
            raise ValueError("Native SQLx69 current history postflight failed")
        candidate = native_report.parent / native_postflight.OUTPUT_NAME
        candidate_sha = report["native_sqlx69_output_sha256"]
    mapped_bytes = pinned_data(candidate, candidate_sha)
    with closing(sqlite3.connect(":memory:")) as original, closing(sqlite3.connect(":memory:")) as mapped:
        original.deserialize(before_bytes)
        mapped.deserialize(mapped_bytes)
        original.execute("PRAGMA query_only=ON")
        mapped.execute("PRAGMA query_only=ON")
        result = module_assertions(original, mapped)
    if hashlib.sha256(source.read_bytes()).hexdigest() != INSTALLED_SHA or hashlib.sha256(candidate.read_bytes()).hexdigest() != candidate_sha:
        raise ValueError("Actual historical source bytes changed during eight-module audit")
    result["current_original_v29_sha256"] = INSTALLED_SHA
    result["native_mapped_v69_sha256"] = candidate_sha
    return result


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (2, 4) or (len(sys.argv) == 4 and sys.argv[2] != "--native-report"):
            raise ValueError("Supply the exact current v29 snapshot and optional --native-report pinned postflight")
        print(json.dumps(check(Path(sys.argv[1]), Path(sys.argv[3]) if len(sys.argv) == 4 else None), sort_keys=True))
    except (ValueError, OSError, sqlite3.DatabaseError, TypeError, source_guard.Refused) as e:
        print("REFUSED_REAL_CURRENT_HISTORY_EIGHT_MODULES: " + str(e), file=sys.stderr)
        raise SystemExit(2)
