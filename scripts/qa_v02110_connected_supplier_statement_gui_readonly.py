"""Real signed Windows WebView2 supplier statement acceptance, with zero writes.

Runs against the already-running connected synthetic QA app only. React's
statement button is a read operation; no finance IPC is sent by this harness.
Independent SQLite purchase/return receipts must match before and afterward.
"""
from __future__ import annotations

import json
import sys
import time

from scripts.qa_legacy_windows_gui_followon import ReadOnlyCdp
from scripts.qa_v02110_connected_real_windows_receipts import check as receipts
from scripts.qa_v02110_connected_windows_gui import (
    ACTOR, TENANT, custody, exact_binary,
)


def verify(pid: int) -> dict:
    if pid != 25528:
        raise RuntimeError("Refuse unpinned signed QA PID")
    before = receipts()
    binary, _ = exact_binary()
    endpoint = custody(pid)
    cdp = ReadOnlyCdp(endpoint)
    try:
        cdp.command("Runtime.enable")
        cdp.command("Page.navigate", {"url": "http://tauri.localhost/purchases/suppliers"})
        button_ready = False
        for _ in range(65):
            if custody(pid) != endpoint:
                raise RuntimeError("Signed QA app custody changed")
            button_ready = cdp.evaluate("""(() => {
              if (location.pathname !== '/purchases/suppliers') return false;
              const button = [...document.querySelectorAll('button')].find(
                b => b.textContent?.trim() === 'كشف الحساب');
              return !!button && !button.disabled &&
                document.body.innerText.includes('QA Connected Supplier 20261018');
            })()""") is True
            if button_ready:
                break
            time.sleep(.15)
        if not button_ready:
            raise RuntimeError("Native supplier statement React button absent")
        identity = cdp.evaluate("""(async () => {
          const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');
          const s=await window.__TAURI_INTERNALS__.invoke('license_status');
          return {id:u?.id,role:u?.role,tenant:u?.pharmacy_id,
            ready:s?.startup_ready === true, valid:s?.valid === true};
        })()""")
        if identity != {"id": ACTOR, "role": "owner", "tenant": TENANT,
                        "ready": True, "valid": True}:
            raise RuntimeError("Signed test-only native user not authenticated")
        clicked = cdp.evaluate("""(() => {
          const button=[...document.querySelectorAll('button')].find(
            b => b.textContent?.trim() === 'كشف الحساب');
          if (!button || button.disabled) return false;
          button.click(); return true;
        })()""")
        if clicked is not True:
            raise RuntimeError("Supplier statement did not open through React")
        rows = None
        for _ in range(65):
            rows = cdp.evaluate("""(() => {
              const dialog=document.querySelector('[role=dialog][aria-labelledby="supplier-statement-title"]');
              if (!dialog || dialog.textContent.includes('جاري تحميل كشف الحساب')) return null;
              const table=dialog.querySelector('table');
              return {title:dialog.querySelector('h3')?.textContent?.trim(),
                rows:[...table?.querySelectorAll('tbody tr')||[]].map(tr=>
                  [...tr.querySelectorAll('td')].map(cell=>cell.textContent?.trim())),
                error:dialog.textContent.includes('تعذر تحميل كشف حساب المورد'),
                pendingPayment:!!document.querySelector('#supplier-payment-amount')};
            })()""")
            if rows is not None:
                break
            time.sleep(.15)
        if not rows or rows.get("error") or rows.get("pendingPayment"):
            raise RuntimeError("Supplier statement incomplete or payment dialog active")
        seen = rows["rows"]
        if len(seen) != 2 or not all(len(cells) == 5 for cells in seen):
            raise RuntimeError("Signed QA supplier source transactions not rendered exactly twice")
        kinds = {cells[1]: cells for cells in seen}
        if set(kinds) != {"فاتورة شراء", "مرتجع شراء"}:
            raise RuntimeError("GUI source invoice and purchase return labels missing")
        if (not kinds["فاتورة شراء"][2].startswith("8")
                or not kinds["مرتجع شراء"][2].startswith("2")
                or "90f2b798" not in kinds["فاتورة شراء"][4]
                or "5a5f0c4a" not in kinds["مرتجع شراء"][4]):
            raise RuntimeError("GUI source amounts or immutable references mismatch")
        if cdp.errors:
            raise RuntimeError("Real signed WebView2 reported runtime errors")
    finally:
        cdp.close()
    if custody(pid) != endpoint:
        raise RuntimeError("Signed QA process changed after statement acceptance")
    after = receipts()
    if after != before:
        raise RuntimeError("Read-only statement acceptance mutated financial receipts")
    return {"status": "PASS_REAL_SIGNED_WINDOWS_GUI_SUPPLIER_INVOICE_RETURN_STATEMENT",
            "signed_synthetic_qa_only": True,
            "app_executable": binary.name,
            "supplier_transactions_in_gui": len(seen),
            "purchase_invoice_egp": 8, "purchase_return_egp": 2,
            "underlying_supplier_payable_egp": 6,
            "financial_receipts_unchanged": True, "finance_ipc_sent_by_harness": 0,
            "production_owner_authorized": False}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise RuntimeError("Exact pinned signed QA PID required")
        print(json.dumps(verify(int(sys.argv[1])), sort_keys=True, ensure_ascii=True))
    except (RuntimeError, ValueError, OSError) as error:
        print(f"Signed synthetic supplier statement refused: {error}", file=sys.stderr)
        raise SystemExit(2)
