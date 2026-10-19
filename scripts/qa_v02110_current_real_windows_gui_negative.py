"""Real WebView2 fail-closed access to CURRENT installed v0.2.109 data copy.

This checks the newly built 0.2.110 Windows QA EXE with a byte-for-byte copy
of the CURRENT installed customer database, never synthetic rows. There is no
commercial license or independently authenticated original owner: positive
business UI is therefore intentionally forbidden. This tool is read-only.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import urlparse
from urllib.request import urlopen

import psutil

from scripts.qa_legacy_windows_gui_followon import ReadOnlyCdp

APP_ID = "com.pharma.disposable.currenthistoryguardedqa20261018"
EXE = Path(r"D:\PhD\Tools\pharma-builds\v02110-current-realhistory-nativebuild-cd43dc806c324ed28439aada0cc124b2"
           r"\cargo-target\x86_64-pc-windows-msvc\debug\pharma-v02110-currenthistory-guarded-qa.exe")
EXE_SHA = "c6996b56c5a404f0f1d6cfb96b450c7d1c5d79d85d934726352ac776a93d58de"
CURRENT_DB_SHA = "4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197"
PORT = 9372
ROUTES = (
    "/stores/items", "/inventory", "/purchases/new", "/purchases/suppliers",
    "/pos", "/returns/new", "/patients", "/accounts", "/shifts",
    "/finance/handover", "/reports/sales", "/reports/purchases",
    "/reports/trial-balance", "/staff/manage",
)


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def original_and_disposable_custody() -> None:
    if os.name != "nt":
        raise RuntimeError("Windows current-installed real-data GUI only")
    original = Path(os.environ["APPDATA"]) / "com.pharma.system" / "pharma_local.db"
    profile = Path(os.environ["APPDATA"]) / APP_ID
    qa_copy = profile / "pharma_local.db"
    manifest = json.loads((profile / "qa_real_current_history_manifest.json").read_text("utf-8-sig"))
    if (manifest.get("app_id"), manifest.get("current_history"), manifest.get("synthetic_history"),
            manifest.get("original_owner_authorization"), manifest.get("commercial_license")) != (
            APP_ID, True, False, False, False):
        raise RuntimeError("Only an independently copied, unlicensed original-history QA profile is allowed")
    for file in (original, qa_copy):
        if (not file.is_file() or file.is_symlink() or sha(file) != CURRENT_DB_SHA
                or any(Path(str(file) + suffix).exists() for suffix in ("-wal", "-shm", "-journal"))):
            raise RuntimeError("Original/current real historical copy was modified or has sidecars")


def custody(pid: int) -> str:
    if pid < 5 or not EXE.is_file() or sha(EXE) != EXE_SHA:
        raise RuntimeError("QA binary absent or not the pinned current source Windows executable")
    p = psutil.Process(pid)
    if Path(p.exe()).resolve() != EXE.resolve():
        raise RuntimeError("Wrong running app identity")
    children = [c for c in p.children(recursive=False)
                if c.name().lower() == "msedgewebview2.exe"
                and f"--remote-debugging-port={PORT}" in c.cmdline()
                and APP_ID.lower() in " ".join(c.cmdline()).lower()]
    if len(children) != 1:
        raise RuntimeError("Exactly one app-owned WebView2 child is required")
    listeners = [c for c in psutil.net_connections(kind="tcp") if c.status == "LISTEN"
                 and c.laddr and c.laddr.port == PORT]
    if len(listeners) != 1 or listeners[0].laddr.ip != "127.0.0.1" or listeners[0].pid != children[0].pid:
        raise RuntimeError("WebView2 CDP listener custody failure")
    with urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=4) as stream:
        pages = [page for page in json.load(stream) if page.get("type") == "page"]
    if len(pages) != 1 or urlparse(pages[0].get("url", "")).hostname != "tauri.localhost":
        raise RuntimeError("Wrong native WebView2 page")
    socket = pages[0]["webSocketDebuggerUrl"]
    endpoint = urlparse(socket)
    if (endpoint.scheme, endpoint.hostname, endpoint.port) != ("ws", "127.0.0.1", PORT):
        raise RuntimeError("Wrong WebView2 websocket origin")
    return socket


JS = """(async () => {
  const license = await window.__TAURI_INTERNALS__.invoke('license_status');
  let deniedUser = false;
  try { const user = await window.__TAURI_INTERNALS__.invoke('current_local_user');
        deniedUser = user === null; }
  catch { deniedUser = true; }
  return {
    route: location.pathname,
    invalidLicense: license.valid === false,
    startupNotReady: license.startup_ready === false,
    noUserGranted: deniedUser,
    activationPageOnly: document.body.innerText.includes('تفعيل ترخيص فارما'),
    noBusinessControls: !document.querySelector(
      '#purchase-supplier,#supplier-payment-amount,#handover-actual-cash,' +
      '#inventory-large-quantity,[data-nav="checkout-button"],#add-patient-payment-method'
    ),
    tauriBridge: typeof window.__TAURI_INTERNALS__?.invoke === 'function'
  };
})()"""


def run(pid: int) -> dict:
    original_and_disposable_custody()
    socket = custody(pid)
    client = ReadOnlyCdp(socket)
    confirmed = []
    try:
        client.command("Runtime.enable")
        client.command("Page.enable")
        for route in ROUTES:
            if custody(pid) != socket:
                raise RuntimeError("App or WebView2 custody changed")
            client.command("Page.navigate", {"url": "http://tauri.localhost" + route})
            observed = None
            for _ in range(45):
                try:
                    observed = client.evaluate(JS)
                    if observed and observed.get("route") == route and all(
                            observed.get(key) is True for key in (
                                "invalidLicense", "startupNotReady", "noUserGranted",
                                "activationPageOnly", "noBusinessControls", "tauriBridge")):
                        break
                except RuntimeError:
                    pass  # Window navigation invalidates its previous JavaScript execution context.
                time.sleep(0.17)
            else:
                raise RuntimeError("Unlicensed real-history UI exposed or failed access-gate checks: " + route)
            confirmed.append({"route": route, "ownerAndLicenseFailClosed": True})
        original_and_disposable_custody()
        if custody(pid) != socket:
            raise RuntimeError("App identity changed after route verification")
        return {
            "status": "PASS_CURRENT_V02109_REAL_HISTORY_WINDOWS_V02110_GUI_DENIAL",
            "sourceIsActualCurrentNotSynthetic": True,
            "originalInstalledDatabaseSha256": CURRENT_DB_SHA,
            "disposableRealCurrentDbSha256": CURRENT_DB_SHA,
            "windowsQaExeSha256": EXE_SHA,
            "nativeWebView2": True,
            "routes": confirmed,
            "businessOrFinanceWritesSent": False,
            "historicalOwnerAuthenticated": False,
            "commercialLicensePresent": False,
            "positiveHistoricalGUIAccepted": False,
            "productionReady": False,
            "sampledRendererErrors": client.errors,
        }
    finally:
        client.close()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or not sys.argv[1].isdigit():
            raise RuntimeError("Supply exact pinned real-data QA application process ID")
        print(json.dumps(run(int(sys.argv[1])), sort_keys=True))
    except (ValueError, OSError, RuntimeError, KeyError, psutil.Error) as exc:
        print("REAL_CURRENT_HISTORY_GUI_NEGATIVE_REFUSED: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
