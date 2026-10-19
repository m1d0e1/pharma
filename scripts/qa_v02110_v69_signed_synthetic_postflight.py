"""Read-only SQLx69 and custody postflight for licensed synthetic v69 QA GUI.

No financial IPC, no business records posted, no database mutations or customer
SQLite opening. This verifies only the dedicated new synthetic profile.
"""

from __future__ import annotations

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

from scripts import qa_v02110_v69_signed_synthetic_fixture as fixture
from scripts import qa_v02110_v69_signed_synthetic_gui_gate as gui


def run(pid: int) -> dict:
    exe, manifest = gui.exact_binary()
    if pid == 25528 or not gui.tested_gui:  # Never target existing signed QA.
        raise RuntimeError("Invalid v69 QA process")
    gui.configure_readonly_gate()
    actual_window = gui.tested_gui.read_status(pid)
    if not actual_window["valid"] or not actual_window["ready"] or actual_window["blocked"]:
        raise RuntimeError("Native signed synthetic v69 not licensed and startup ready")
    path = Path(os.environ["APPDATA"]) / fixture.IDENTITY / "pharma_local.db"
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("Dedicated new synthetic v69 QA profile missing")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",) or db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise RuntimeError("New synthetic QA SQLite integrity or FK failure")
        migrations = db.execute("SELECT COUNT(*),MIN(version),MAX(version) FROM _sqlx_migrations WHERE success=1").fetchone()
        if migrations != (69, 1, 69):
            raise RuntimeError("New QA SQLx did not reach exact migration 069: " + str(migrations))
        sql = (Path(__file__).resolve().parents[1] / "src-tauri/migrations/069_supplier_return_aware_payment_guard.sql").read_bytes()
        checksum = db.execute("SELECT checksum FROM _sqlx_migrations WHERE version=69 AND success=1").fetchone()
        if not checksum or bytes(checksum[0]) != hashlib.sha384(sql).digest():
            raise RuntimeError("SQLx69 migration checksum diverges from actual source")
        principal = db.execute("SELECT id,role,pharmacy_id FROM users WHERE is_active=1").fetchall()
        if principal != [(fixture.ACTOR, "owner", fixture.TENANT)]:
            raise RuntimeError("QA tenant scoped synthetic principal mismatch")
        tables = ("purchase_invoices", "supplier_transactions", "sales_invoices", "returns",
                  "purchase_returns", "inventory", "suppliers", "patients", "daily_journals",
                  "journal_entries", "cash_movements")
        counts = {table: db.execute('SELECT COUNT(*) FROM "' + table + '"').fetchone()[0]
                  for table in tables}
        if any(counts.values()):
            raise RuntimeError("Financial posting or business history unexpectedly present")
    # Hash protected files WITHOUT opening either old SQLite database.
    stable = {
        "customer": Path(os.environ["APPDATA"]) / "com.pharma.system/pharma_local.db",
        "oldSignedQa": Path(os.environ["APPDATA"]) /
                       "com.pharma.disposable.connectedpositiveqa20261018/pharma_local.db",
    }
    expected = {"customer": "4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197",
                "oldSignedQa": "9ae96cee46e1361c8a88f37a4d72e3be535c7e1edd08fdaebfcec12b27db3f65"}
    for name, source in stable.items():
        if gui.sha(source) != expected[name]:
            raise RuntimeError("Protected older customer or signed QA profile drift " + name)
    return {"result": "PASS_REAL_SIGNED_SYNTHETIC_V69_GUI_NATIVE_POSTFLIGHT_READONLY",
            "qaPid": pid, "qaSignedExecutableSha256": gui.sha(exe),
            "testOnly": True, "sqlxMigrations": migrations[0], "version69ChecksumMatches": True,
            "nativeLicensingValid": True, "nativeStartupReady": True, "tenant": fixture.TENANT,
            "nativeActor": fixture.ACTOR, "financialPostingCounts": counts,
            "protectedCustomerAndExistingSignedQaDbUnchanged": True,
            "commercialHistoryAuthority": False}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or not sys.argv[1].isdigit():
            raise RuntimeError("Require one exact new GUI QA PID")
        print(json.dumps(run(int(sys.argv[1])), sort_keys=True))
    except (OSError, ValueError, RuntimeError, sqlite3.DatabaseError):
        print("v69 SIGNED SYNTHETIC QA POSTFLIGHT REFUSED", file=sys.stderr)
        raise SystemExit(2)
