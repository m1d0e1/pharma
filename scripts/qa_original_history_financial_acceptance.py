"""Read-only financial provenance census for a pinned disposable SQLx69 database.

Reports aggregate evidence, never authorizes live posting or import.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from scripts import qa_v02110_primary_pharmacy_migration as guard

STAGE = "pharma-v02110-native-sqlx69-primary-scope-43d756ccfe4d43a0a6b0c07ee742b53a"
NAME = "NATIVE-SQLX69-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3"
PIN = "bf0a85e37bce355a75cd741186f206887e4e9912df0d7a511ee299a0fde15e08"
RECEIPTS = {
    "native_sale_cogs_provenance": "sales_invoices",
    "native_sale_return_cogs_provenance": "returns",
    "native_purchase_create_requests": "purchase_invoices",
    "native_purchase_return_provenance": "purchase_returns",
    "native_supplier_payment_receipts": "supplier_transactions",
    "native_stock_ledger_provenance": "stock_adjustments",
    "native_patient_financial_journal_receipts": "patient_transactions",
}


def check(db: sqlite3.Connection) -> dict:
    db.execute("PRAGMA query_only=ON")
    if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise ValueError("SQLite integrity failed")
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise ValueError("Foreign key violation")
    if db.execute("SELECT MAX(version),COUNT(*) FROM _sqlx_migrations WHERE success=1").fetchone() != (69, 69):
        raise ValueError("SQLx69 history not fully registered")
    required = set(RECEIPTS) | set(RECEIPTS.values())
    existing = {name for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not required.issubset(existing):
        raise ValueError("Financial source or native receipt table missing")
    audit_rows = db.execute("SELECT COUNT(*) FROM native_primary_scope_audit_originals").fetchone()[0]
    links = db.execute("SELECT COUNT(*) FROM native_primary_scope_audit_relations").fetchone()[0]
    if (audit_rows, links) != (7567, 147):
        raise ValueError("Original scope or structural witness altered")
    if db.execute("SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone()[0] != 0:
        raise ValueError("Unexpected historical owner grant")
    if db.execute("SELECT COUNT(*) FROM users WHERE id='admin' AND role='owner' AND pharmacy_id='primary_pharmacy' AND password_hash IS NULL").fetchone()[0] != 1:
        raise ValueError("Historical owner quarantine not preserved")
    journal_rows = db.execute("SELECT COUNT(*) FROM daily_journals").fetchone()[0]
    entries = db.execute("SELECT COUNT(*) FROM journal_entries").fetchone()[0]
    unbalanced = db.execute("SELECT COUNT(*) FROM (SELECT j.id FROM daily_journals j LEFT JOIN journal_entries e ON e.journal_id=j.id GROUP BY j.id HAVING COUNT(e.id)<2 OR ABS(COALESCE(SUM(CASE WHEN e.type='debit' THEN e.amount ELSE -e.amount END),0))>0.00001)").fetchone()[0]
    if (journal_rows, entries, unbalanced) != (1856, 5632, 0):
        raise ValueError("Historical double entry totals are not preserved")
    coverage = {}
    for receipt, historical in sorted(RECEIPTS.items()):
        coverage[receipt] = {
            "historical_source_table": historical,
            "historical_rows": db.execute(f'SELECT COUNT(*) FROM "{historical}"').fetchone()[0],
            "native_receipts": db.execute(f'SELECT COUNT(*) FROM "{receipt}"').fetchone()[0],
            "original_financial_provenance_certified": False,
        }
    return {"status": "BLOCKED_LEGACY_FINANCIAL_PROVENANCE_NOT_CERTIFIED",
            "balanced_historical_journals": journal_rows,
            "original_journal_entries": entries,
            "typed_source_scope_witnesses": audit_rows,
            "original_relation_witnesses": links,
            "historical_owner_password_still_quarantined": True,
            "financial_native_receipt_census": coverage,
            "historic_receipts_not_retroactively_inferred": True,
            "production_allowed": False}


def main() -> int:
    try:
        path = guard.disposable_root() / STAGE / NAME
        raw = guard.checked_file(path, PIN)
        with sqlite3.connect(":memory:") as db:
            db.deserialize(raw)
            result = check(db)
        if hashlib.sha256(path.read_bytes()).hexdigest() != PIN:
            raise ValueError("Detached source changed during read")
        result["source_sha256"] = PIN
        result["database_mutations"] = 0
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, guard.Refused, OSError, sqlite3.Error) as exc:
        print(json.dumps({"status": "REFUSED_NO_FINANCIAL_ACCEPTANCE", "reason": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
