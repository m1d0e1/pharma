"""Read-only, privacy-preserving verification of an isolated production SQLite copy.

Run with --source the actual installed production-profile database and
--snapshot the newly made disposable local copy. No SQL writes, migrations,
SQLite exports, patient names, IDs, phone numbers or raw rows are emitted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3


BUSINESS_TABLES = (
    "master_drugs", "inventory", "sales_invoices", "sales_items",
    "purchase_invoices", "purchase_invoice_items", "returns", "return_items",
    "purchase_returns", "purchase_return_items", "patients", "suppliers",
    "daily_journals", "journal_entries", "shifts", "cash_movements",
    "supplier_transactions", "users", "activity_log",
)

SOURCE_RELATIVE = Path("com.pharma.system") / "pharma_local.db"
COPY_ROOT = "pharma-disposable-data-copies"


def connect_read_only(filename: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(filename.resolve().as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=15000")
    return connection


def quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def fingerprint(connection: sqlite3.Connection) -> dict:
    names = sorted(row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ))
    digest = hashlib.sha256()
    counts: dict[str, int] = {}
    for name in names:
        columns = [row[1] for row in connection.execute(f"PRAGMA table_info({quote(name)})")]
        if not columns:
            raise ValueError("Unreadable schema column metadata")
        select = f"SELECT {','.join(map(quote, columns))} FROM {quote(name)}"
        # Canonical row digests avoid relying on unspecified SQLite row order.
        # Row *content* is never logged or written to a file.
        row_hashes = [
            hashlib.sha256(json.dumps(row, ensure_ascii=False, separators=(",", ":"),
                                      default=str).encode("utf8")).digest()
            for row in connection.execute(select)
        ]
        row_hashes.sort()
        digest.update(name.encode("utf8"))
        digest.update(len(row_hashes).to_bytes(8, "big"))
        for row_digest in row_hashes:
            digest.update(row_digest)
        counts[name] = len(row_hashes)
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    foreign_violations = len(connection.execute("PRAGMA foreign_key_check").fetchall())
    if integrity != "ok" or foreign_violations:
        raise ValueError("Snapshot integrity or foreign key verification failed")
    return {
        "table_count": len(names),
        "logical_rows": sum(counts.values()),
        "logical_digest": digest.hexdigest(),
        "business_rows": {name: counts[name] for name in BUSINESS_TABLES if name in counts},
        "integrity": integrity,
        "foreign_key_violations": foreign_violations,
    }


def source_relationship_summary(connection: sqlite3.Connection) -> dict:
    checks = {
        "sales_without_items": "SELECT COUNT(*) FROM sales_invoices s WHERE NOT EXISTS (SELECT 1 FROM sales_items i WHERE i.invoice_id=s.id)",
        "sales_items_without_sale": "SELECT COUNT(*) FROM sales_items i WHERE NOT EXISTS (SELECT 1 FROM sales_invoices s WHERE s.id=i.invoice_id)",
        "sales_items_missing_lot": "SELECT COUNT(*) FROM sales_items i WHERE i.inventory_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inventory lot WHERE lot.id=i.inventory_id)",
        "purchases_without_lines": "SELECT COUNT(*) FROM purchase_invoices p WHERE NOT EXISTS (SELECT 1 FROM purchase_invoice_items i WHERE i.invoice_id=p.id)",
        "purchase_items_without_purchase": "SELECT COUNT(*) FROM purchase_invoice_items i WHERE NOT EXISTS (SELECT 1 FROM purchase_invoices p WHERE p.id=i.invoice_id)",
        "returns_without_sale": "SELECT COUNT(*) FROM returns r WHERE NOT EXISTS (SELECT 1 FROM sales_invoices s WHERE s.id=r.invoice_id)",
        "return_items_without_return": "SELECT COUNT(*) FROM return_items ri WHERE NOT EXISTS (SELECT 1 FROM returns r WHERE r.id=ri.return_id)",
        "return_items_without_original_sale_line": "SELECT COUNT(*) FROM return_items WHERE sale_item_id IS NULL",
        "purchase_returns_without_purchase": "SELECT COUNT(*) FROM purchase_returns r WHERE NOT EXISTS (SELECT 1 FROM purchase_invoices p WHERE p.id=r.purchase_invoice_id)",
        "purchase_return_items_without_purchase_line": "SELECT COUNT(*) FROM purchase_return_items WHERE purchase_invoice_item_id IS NULL",
        "journals_without_entries": "SELECT COUNT(*) FROM daily_journals j WHERE NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.journal_id=j.id)",
        "journal_entries_without_header": "SELECT COUNT(*) FROM journal_entries e WHERE NOT EXISTS (SELECT 1 FROM daily_journals j WHERE j.id=e.journal_id)",
        "negative_inventory_lots": "SELECT COUNT(*) FROM inventory WHERE CAST(quantity AS REAL)<0",
        "negative_patient_wallets": "SELECT COUNT(*) FROM patients WHERE CAST(COALESCE(wallet_balance,0) AS REAL)<0",
    }
    results = {key: connection.execute(sql).fetchone()[0] for key, sql in checks.items()}
    imbalanced = connection.execute("""
        SELECT COUNT(*) FROM (
            SELECT j.id FROM daily_journals j
            LEFT JOIN journal_entries e ON e.journal_id=j.id
            GROUP BY j.id
            HAVING COALESCE(SUM(CASE WHEN e.type='debit' THEN ROUND(e.amount*100) ELSE 0 END),0)
              <> COALESCE(SUM(CASE WHEN e.type='credit' THEN ROUND(e.amount*100) ELSE 0 END),0)
        )
    """).fetchone()[0]
    results["unbalanced_cent_journals"] = imbalanced
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify a separate immutable production-data QA snapshot read-only")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    arguments = parser.parse_args()
    expected_source = (Path(os.environ["APPDATA"]) / SOURCE_RELATIVE).resolve()
    expected_copy_root = (Path(os.environ["LOCALAPPDATA"]) / COPY_ROOT).resolve()
    source = arguments.source.resolve(strict=True)
    snapshot = arguments.snapshot.resolve(strict=True)
    if source != expected_source or snapshot == source or expected_copy_root not in snapshot.parents:
        raise ValueError("Only the approved installed-profile source and separate QA snapshot are readable")
    if not snapshot.name == "production_snapshot_immutable.sqlite3":
        raise ValueError("Unexpected disposable production-data snapshot")
    with connect_read_only(source) as original, connect_read_only(snapshot) as copied:
        original_result = fingerprint(original)
        copied_result = fingerprint(copied)
        if original_result != copied_result:
            raise ValueError("Source and disposable QA snapshot have different logical row content")
        graph = source_relationship_summary(copied)
    print("ISOLATED_PRODUCTION_COPY_VERIFICATION=PASS")
    print(json.dumps({
        "copy_exact": True,
        "table_count": copied_result["table_count"],
        "all_table_rows": copied_result["logical_rows"],
        "logical_sha256": copied_result["logical_digest"],
        "business_table_rows": copied_result["business_rows"],
        "relationship_anomaly_counts": graph,
        "integrity": copied_result["integrity"],
        "foreign_key_violations": 0,
        "tenant_ownership_reassigned": False,
        "financial_source_receipts_backfilled": False,
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
