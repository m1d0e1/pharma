"""Actual signed Windows WebView2 net sales/purchase report acceptance.

Read-only React report routes, checked against independent immutable native
purchase, sale, sale-return and purchase-return SQLite receipts. Never posts.
This synthetic QA actor does not authorize a historic customer upgrade.
"""
from __future__ import annotations

import json
import sys
import time

from scripts.qa_legacy_windows_gui_followon import ReadOnlyCdp
from scripts.qa_v02110_connected_real_windows_receipts import check as receipts
from scripts.qa_v02110_connected_windows_gui import ACTOR, TENANT, custody


def _report_rows(cdp: ReadOnlyCdp, pid: int, endpoint: str, route: str, prefix: str):
    if custody(pid) != endpoint:
        raise RuntimeError("Existing signed QA custody changed before report")
    cdp.command("Page.navigate", {"url": "http://tauri.localhost" + route})
    for _ in range(85):
        if custody(pid) != endpoint:
            raise RuntimeError("Existing signed QA custody changed during report")
        try:
            rows = cdp.evaluate("""(() => {
              if (location.pathname !== ROUTE) return null;
              return [...document.querySelectorAll('table tbody tr')].map(tr =>
                [...tr.querySelectorAll('td')].map(td => td.textContent?.trim()));
            })()""".replace("ROUTE", json.dumps(route)))
        except RuntimeError:
            rows = None  # CDP contexts are replaced during normal page navigation.
        if rows and len(rows) == 1 and rows[0][0].startswith(prefix):
            return rows[0]
        time.sleep(.15)
    raise RuntimeError(f"Native signed QA report {route} lacked expected source row")


def verify(pid: int) -> dict:
    if pid != 25528:
        raise RuntimeError("Exact pinned connected QA process required")
    before = receipts()
    endpoint = custody(pid)
    cdp = ReadOnlyCdp(endpoint)
    try:
        cdp.command("Runtime.enable")
        sales = _report_rows(cdp, pid, endpoint, "/reports/sales", "#908169c1")
        # Native financial row: original invoice 5, sale return 5, net 0.
        if len(sales) != 11 or [sales[i] for i in (5, 7, 8, 9)] != ["5", "5", "5", "0"]:
            raise RuntimeError("Signed Windows sales report did not conserve refund/net sale")
        purchases = _report_rows(cdp, pid, endpoint, "/reports/purchases", "#90f2b798")
        # Purchase: original 8, receipted purchase return 2, net acquisition 6.
        if (len(purchases) != 12 or
                [purchases[i] for i in (5, 8, 9, 10)] != ["8", "8", "2", "6"]):
            raise RuntimeError("Signed Windows purchase report did not reconcile return/net")
        principal = cdp.evaluate("""(async () => {
          const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');
          const s=await window.__TAURI_INTERNALS__.invoke('license_status');
          return {id:u?.id,role:u?.role,tenant:u?.pharmacy_id,
                  ready:s?.startup_ready===true,valid:s?.valid===true};
        })()""")
        if principal != {"id": ACTOR, "role": "owner", "tenant": TENANT,
                         "ready": True, "valid": True} or cdp.errors:
            raise RuntimeError("Windows reports lack genuine signed QA actor or renderer health")
    finally:
        cdp.close()
    if custody(pid) != endpoint or receipts() != before:
        raise RuntimeError("GUI reports changed the actor process or source receipts")
    return {"status": "PASS_ACTUAL_SIGNED_WINDOWS_GUI_NET_SALES_PURCHASE_REPORTS",
            "signed_synthetic_qa_only": True, "native_qa_actor": ACTOR,
            "sales_invoice_count": 1, "gross_sale_cents": 500,
            "receipted_sales_return_cents": 500, "net_sales_cents": 0,
            "purchases_invoice_count": 1, "gross_purchase_cents": 800,
            "receipted_purchase_return_cents": 200, "net_purchase_cents": 600,
            "financial_receipts_unchanged": True, "finance_ipc_sent_by_harness": 0,
            "real_historical_owner_authenticated": False}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise RuntimeError("Exact running QA PID required")
        print(json.dumps(verify(int(sys.argv[1])), sort_keys=True, ensure_ascii=True))
    except (RuntimeError, ValueError, OSError) as error:
        print(f"Signed synthetic financial report refused: {error}", file=sys.stderr)
        raise SystemExit(2)
