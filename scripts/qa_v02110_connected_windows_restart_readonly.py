"""Post-purchase restart persistence through actual pinned Windows WebView2.

No credentials, raw SQL IPC, financial submission or process restart is attempted.
The already-running signed synthetic application must have been started after
its independently witnessed original purchase/sale/returns. Navigation is
performed only through the real WebView2 renderer, while read-only SQL verifies
that the existing source receipts and money/inventory remain unchanged.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
import time
import sys

import psutil

from scripts.qa_legacy_windows_gui_followon import ReadOnlyCdp
from scripts.qa_v02110_connected_windows_gui import (
    ACTOR, IDENTITY, PORT, ROUTES, TENANT, custody, exact_binary,
)
from scripts.qa_v02110_connected_real_windows_receipts import check as financial_receipts


def accepted(pid: int) -> dict:
    exe, manifest = exact_binary()
    process = psutil.Process(pid)
    if process.exe().lower() != str(exe).lower() or not process.is_running():
        raise RuntimeError("Pinned connected synthetic QA app is not running")
    start = process.create_time()
    # Transactions were generated on 18 October 2026 between 11:36 and 11:47
    # in the app host's local timezone. This UTC cutoff is deliberately earlier
    # than that interval, so a prior-to-transaction process cannot claim restart.
    if start <= datetime(2026, 10, 18, 9, 47, 23, tzinfo=timezone.utc).timestamp():
        raise RuntimeError("Process did not restart after original GUI purchase return")
    receipt_before = financial_receipts()
    endpoint = custody(pid)
    cd = ReadOnlyCdp(endpoint)
    observations = []
    try:
        cd.command("Runtime.enable")
        cd.command("Page.enable")
        cd.command("Log.enable")
        for route in ROUTES:
            if custody(pid) != endpoint:
                raise RuntimeError("WebView2 process changed during restart persistence audit")
            cd.command("Page.navigate", {"url": "http://tauri.localhost" + route})
            state = None
            for _ in range(70):
                try:
                    state = cd.evaluate("""(async () => {
                      const s=await window.__TAURI_INTERNALS__?.invoke?.('license_status');
                      const u=await window.__TAURI_INTERNALS__?.invoke?.('current_local_user');
                      return {route:location.pathname,licenseValid:s?.valid===true,
                        startupReady:s?.startup_ready===true,
                        userId:u?.id,role:u?.role,tenant:u?.pharmacy_id};
                    })()""")
                    if (state and state.get("route") == route
                            and state.get("licenseValid") is True
                            and state.get("startupReady") is True
                            and (state.get("userId"), state.get("role"), state.get("tenant"))
                            == (ACTOR, "owner", TENANT)):
                        break
                except RuntimeError:
                    pass  # Navigation replaced a JavaScript world; retry read-only.
                time.sleep(0.15)
            else:
                raise RuntimeError("Original signed synthetic user not authenticated at " + route)
            observations.append(state)
        receipt_after = financial_receipts()
        if receipt_before != receipt_after:
            raise RuntimeError("Finance receipts changed during read-only GUI route sequence")
        if custody(pid) != endpoint:
            raise RuntimeError("App/WebView2 changed while inspecting persistence")
        return {
            "status": "PASS_ACTUAL_LICENSED_WINDOWS_GUI_POST_PURCHASE_RESTART_READ_ONLY",
            "qa_app_id": IDENTITY,
            "qa_exe_sha256": manifest["executableSHA256"],
            "pid": pid,
            "started_after_original_gui_financial_writes": True,
            "authenticated_routes_verified": [r["route"] for r in observations],
            "persisted_native_sqlx_schema": receipt_after["sqlx_version"],
            "purchase_cents": receipt_after["purchase_cents"],
            "nonzero_costed_pos_cogs_cents": receipt_after["sale_purchase_origin_cogs_cents"],
            "supplier_balance_cents": receipt_after["supplier_payable_cents"],
            "purchase_return_cents": receipt_after["purchase_return_credit_cents"],
            "journals_balanced_and_unchanged": receipt_after["balanced_native_journals"],
            "sampled_webview_renderer_errors": cd.errors,
            "financial_ipc_writes_issued": 0,
            "real_customer_history_accessed": False,
            "commercial_production_ready": False,
        }
    finally:
        cd.close()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or not sys.argv[1].isdigit():
            raise RuntimeError("Pinned running QA PID required")
        print(json.dumps(accepted(int(sys.argv[1])), sort_keys=True))
    except (RuntimeError, KeyError, OSError, ValueError, psutil.Error):
        print("Connected restart persistence WebView2 QA refused", file=sys.stderr)
        raise SystemExit(2)
