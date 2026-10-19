"""Reconcile the previous one-click synthetic Windows F9 purchase without posting.

Pins the exact running positive licensed synthetic QA application, reads only
sessionStorage provenance and a WAL-aware read-only SQLite connection to its
own synthetic profile. No receipt is forged and no request is replayed.
"""
from __future__ import annotations

from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys

from scripts.qa_v02110_authenticated_synthetic_windows_gui import custody
from scripts.qa_legacy_windows_gui_followon import ReadOnlyCdp
from scripts.qa_v02110_real_windows_synthetic_gui_receipts import IDENTITY, ORIGINAL, ORIGINAL_SHA


def inspect(pid: int) -> dict:
    endpoint = custody(pid)
    db_path = Path(os.environ["APPDATA"]) / IDENTITY / "pharma_local.db"
    protected = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies" / ORIGINAL
    from hashlib import sha256
    if sha256(protected.read_bytes()).hexdigest() != ORIGINAL_SHA:
        raise RuntimeError("Independent customer-source seal no longer matches")
    cdp = ReadOnlyCdp(endpoint)
    try:
        cdp.command("Runtime.enable")
        window_state = cdp.evaluate("""(() => {
          const keys = Object.keys(sessionStorage);
          const result = [];
          for (const key of keys) {
            if (!key.endsWith(':pending-native-create-v1')) continue;
            const raw = sessionStorage.getItem(key);
            let value;
            try { value = JSON.parse(raw || 'null'); } catch { value = null; }
            result.push({storageKey:key,requestId:value?.requestId || null,
              validFingerprint:typeof value?.fingerprint === 'string' && value.fingerprint.length>0,
              hasOtherKeys:value != null && typeof value === 'object' &&
                Object.keys(value).some(x=>!['requestId','fingerprint'].includes(x))});
          }
          return {route:location.pathname,pending:result,
            sessionStorageEntries:keys.length,hasTauriBridge:!!window.__TAURI_INTERNALS__?.invoke};
        })()""")
    finally:
        cdp.close()
    if not window_state or window_state.get("hasTauriBridge") is not True:
        raise RuntimeError("Actual Windows WebView is not connected")
    with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise RuntimeError("Synthetic database integrity failed")
        names = ("purchase_invoices", "purchase_invoice_items", "native_purchase_create_requests",
                 "native_purchase_posting_events", "supplier_transactions")
        counts = {name:db.execute('SELECT COUNT(*) FROM "'+name+'"').fetchone()[0] for name in names}
        original_requests = [r.get("requestId") for r in window_state["pending"]]
        if any(not isinstance(x, str) or not x for x in original_requests):
            raise RuntimeError("A pending synthetic purchase request ID is corrupt")
        receipts = []
        cols = {x[1] for x in db.execute("PRAGMA table_info(native_purchase_create_requests)")}
        if "request_id" in cols:
            for request_id in original_requests:
                receipt_count = db.execute(
                    "SELECT COUNT(*) FROM native_purchase_create_requests WHERE request_id=?",
                    (request_id,)).fetchone()[0]
                receipts.append({"requestId":request_id,"nativeReceiptCount":receipt_count})
        if any(v != 0 for v in counts.values()):
            # This is not inherently a failure: a historical one-shot request
            # may have committed. Preserve facts and demand review before retry.
            status = "NATIVE_PURCHASE_WRITES_PRESENT_REVIEW_BEFORE_SUBMIT"
        else:
            status = "ZERO_NATIVE_PURCHASE_WRITES_CONFIRMED_READONLY"
    return {"status":status,"synthetic_only":True,"live_customer_history":False,
            "pending_native_create_intents":window_state["pending"],
            "current_tauri_route":window_state["route"],
            "native_purchase_counts":counts,"matched_request_receipts":receipts,
            "native_financial_writes_performed":0,"customer_history_not_modified":True}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or not sys.argv[1].isdigit():
            raise RuntimeError("Exact existing synthetic QA PID required")
        print(json.dumps(inspect(int(sys.argv[1])), sort_keys=True))
    except (RuntimeError, OSError, KeyError, sqlite3.Error, ValueError) as error:
        print("Synthetic pending purchase inspection refused: "+str(error), file=sys.stderr)
        raise SystemExit(2)
