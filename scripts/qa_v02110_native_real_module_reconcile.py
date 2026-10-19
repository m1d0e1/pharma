"""Exact old-record and module parity for a real v29 → native SQLx v67 QA clone.

Read-only. Never licenses, migrates, assigns ownership, rounds money, or writes
to any SQLite file. The source and candidate must be individually SHA-pinned,
previously committed *detached* SQLite files under the local private QA root.
Only summary counts and changed original column names are printed. A nonzero
result is mandatory while even one original user credential/scope differs.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

from scripts.legacy_pharmacy_upgrade import validate_integrity
from scripts.qa_historical_forward_sql_drift import (
    original_table_schema, original_row_commitments, changed_id_columns, quoted,
)

SRC = re.compile(r"pharma-v02110-prebuild-snapshot-[a-f0-9]{32}\Z")
DST = re.compile(r"pharma-v02110-native-sqlx-diagnostic-[a-f0-9]{32}\Z")
HEX = re.compile(r"[a-fA-F0-9]{64}\Z")

# All original operational modules with named business rows. FTS virtual/shadow
# rows are separately included in the unconditional 67-table typed witness.
MODULES = {
    "catalog": ("master_drugs", "drug_interactions", "units", "manufacturers"),
    "stock": ("inventory", "stock_adjustments", "shortages", "opening_balances", "opening_balance_items"),
    "purchasing": ("purchase_orders", "purchase_order_items", "purchase_invoices", "purchase_invoice_items"),
    "suppliers": ("suppliers", "supplier_transactions", "purchase_returns", "purchase_return_items"),
    "sales_pos": ("sales_invoices", "sales_items", "returns", "return_items"),
    "patients": ("patients", "patient_transactions", "patient_allergies", "patient_conditions"),
    "cash": ("shifts", "cash_movements", "banks", "credit_cards", "points_of_sale"),
    "accounting": ("accounts", "daily_journals", "journal_entries", "expenses", "financial_notices"),
}


def _sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _detached(path: Path, pin: str, root: Path, pattern: re.Pattern, filename: str) -> Path:
    if not path.is_absolute() or ".." in path.parts or not HEX.fullmatch(pin):
        raise ValueError("Full independent custody source pin and absolute private path required")
    if path.name != filename or not pattern.fullmatch(path.parent.name):
        raise ValueError("Not an approved original or unactivated native QA file")
    if path.parent.parent != root or not path.is_file():
        raise ValueError("QA file is not under the exact private root")
    for item in (path, path.parent, root):
        if item.is_symlink():
            raise ValueError("No symlinks may be used for historical custody")
    for suffix in ("-wal", "-shm", "-journal"):
        if Path(str(path) + suffix).exists():
            raise ValueError("Uncommitted SQLite sidecars cannot be ignored")
    if not 50_000 <= path.stat().st_size <= 700_000_000 or _sha(path) != pin.lower():
        raise ValueError("Independent snapshot SHA-256 or file budget differs")
    return path


def _ledger(db: sqlite3.Connection) -> list[int]:
    return [int(row[0]) for row in db.execute(
        "SELECT version FROM _sqlx_migrations WHERE success=1 ORDER BY version"
    )]


def compare(original: sqlite3.Connection, native: sqlite3.Connection) -> dict:
    """Exact original SQLite storage-type/row commitments; never outputs PII."""
    validate_integrity(original)
    validate_integrity(native)
    source_versions = _ledger(original)
    native_versions = _ledger(native)
    if source_versions != list(range(1, 30)) or native_versions != list(range(1, 68)):
        raise ValueError("Input is not a true complete v29-to-v67 native migration")
    old_schema = original_table_schema(original)
    old_rows = original_row_commitments(original, old_schema)
    assert len(old_schema) == 67 and sum(r[0] for r in old_rows.values()) == 289_778
    original_names = set(old_schema)
    current_names = set(original_table_schema(native))
    missing_tables = sorted(original_names - current_names)
    different: dict[str, dict] = {}
    for table, cols in old_schema.items():
        if table in missing_tables:
            continue
        now_cols = tuple(row[1] for row in native.execute(f"PRAGMA table_info({quoted(table)})"))
        if not set(cols).issubset(now_cols):
            different[table] = {"original_columns_missing": sorted(set(cols) - set(now_cols))}
            continue
        count_hash = original_row_commitments(native, {table: cols})[table]
        if count_hash != old_rows[table]:
            different[table] = {
                "old_typed_rows": old_rows[table][0],
                "native_typed_rows": count_hash[0],
                "changed_column_counts": changed_id_columns(original, native, table, cols)
                if table not in ("sqlite_sequence", "_sqlx_migrations") else None,
            }
    modules = {}
    for module, tables in MODULES.items():
        if any(table not in original_names for table in tables):
            raise ValueError("Known source lacks a required pharmacy business module")
        module_drift = [t for t in tables if t in different]
        modules[module] = {
            "original_rows": sum(old_rows[t][0] for t in tables),
            "source_rows_unchanged": not module_drift,
            "changed_tables": module_drift,
        }
    result = {
        "status": "VERIFIED_PRESERVATION_WITH_RELEASE_BLOCKERS" if different else "ALL_ORIGINAL_ROWS_EXACT",
        "original_tables": len(old_schema),
        "original_typed_table_rows": sum(v[0] for v in old_rows.values()),
        "native_original_tables_retained": not missing_tables,
        "native_integrity_ok": native.execute("PRAGMA integrity_check").fetchone() == ("ok",),
        "native_fk_errors": len(native.execute("PRAGMA foreign_key_check").fetchall()),
        "whole_original_table_differences": different,
        "modules": modules,
        "historical_owner_authorization_approved": False,
        "financial_origin_independently_signed": False,
        "customer_installer_safe": False,
    }
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--native-sha256", required=True)
    args = parser.parse_args(argv)
    try:
        root = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
        src = _detached(args.source, args.source_sha256, root, SRC, "current-v02109-sealed.sqlite3")
        dst = _detached(args.native, args.native_sha256, root, DST, "native-v67-working-only.sqlite3")
        if src == dst:
            raise ValueError("Source and native working files must differ")
        with closing(sqlite3.connect(src.as_uri() + "?mode=ro&immutable=1", uri=True)) as old, \
             closing(sqlite3.connect(dst.as_uri() + "?mode=ro&immutable=1", uri=True)) as new:
            old.execute("PRAGMA query_only=ON")
            new.execute("PRAGMA query_only=ON")
            result = compare(old, new)
        if _sha(src) != args.source_sha256.lower() or _sha(dst) != args.native_sha256.lower():
            raise ValueError("Source or native QA output changed during verification")
        result["private_original_and_native_source_unchanged_after"] = True
        print(json.dumps(result, sort_keys=True))
        # Preservation checks are strictly advisory: no owner/reviewer-signed
        # mapping, authentic positive GUI or financial source attestations.
        return 2
    except (OSError, ValueError, sqlite3.Error, AssertionError, KeyError):
        print('{"status":"REFUSED","safe_to_install":false}', file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
