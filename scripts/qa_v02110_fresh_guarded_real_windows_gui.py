"""Read-only actual Windows WebView2 negative acceptance for fresh-renderer v0.2.110.

Only observes one already-running pinned disposable QA executable and its own
loopback CDP page. It neither supplies credentials nor installs a license,
activates historical custody, or invokes finance/business methods. Five route
navigations are actual WebView2 operations, not synthetic React/Jest tests.
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


APP_ID = "com.pharma.disposable.freshrenderqa20261018"
QA_EXE = Path(
    r"D:\PhD\Tools\pharma-builds\v02110-fresh-renderer-guarded-"
    r"5525c9a60caa45ac8a79f6d4310ebc96\Pharma-0.2.110-FRESH-RENDERER-GUARDED-QA-only.exe"
)
QA_SHA = "2227bd604a81fe668d7c44fad4f4e16009d5c0202d77901a649cb84a52694391"
SEALED_SHA = "06fc00f32ec2603758cd3f0eb12c38024f22fce27c4e5f7875ab47aceb6c87fb"
PORT = 9343
ROUTES = ("/reports/purchases", "/reports/sales", "/inventory", "/patients", "/returns")
CONTROLS = (
    "#pos-checkout-submit,#purchase-save-button,#sales-return-search,"
    '[data-testid="patient-wallet-topup"]'
)


def sha(path: Path) -> str:
    with path.open("rb") as reader:
        return hashlib.file_digest(reader, "sha256").hexdigest()


def custody(pid: int) -> str:
    if os.name != "nt" or pid < 5 or not QA_EXE.is_file():
        raise RuntimeError("Only the pinned Windows QA executable may be inspected")
    app = psutil.Process(pid)
    if Path(app.exe()).resolve() != QA_EXE.resolve() or sha(QA_EXE) != QA_SHA:
        raise RuntimeError("Executable identity or SHA does not match")
    children = [
        child for child in app.children(recursive=False)
        if child.name().lower() == "msedgewebview2.exe"
        and f"--remote-debugging-port={PORT}" in child.cmdline()
        and APP_ID.lower() in " ".join(child.cmdline()).lower()
    ]
    if len(children) != 1:
        raise RuntimeError("No unique directly owned WebView2 debugger")
    # Check that the CDP endpoint actually belongs to this local QA process.
    listeners = [
        conn for conn in psutil.net_connections(kind="tcp")
        if conn.status == "LISTEN" and conn.laddr
        and conn.laddr.port == PORT
    ]
    if len(listeners) != 1 or listeners[0].laddr.ip != "127.0.0.1":
        raise RuntimeError("No unique isolated IPv4 CDP listener")
    if listeners[0].pid not in {child.pid for child in children}:
        raise RuntimeError("Port is owned by a different WebView2 process")
    with urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=4) as result:
        pages = [p for p in json.load(result) if p.get("type") == "page"]
    if len(pages) != 1 or urlparse(pages[0].get("url", "")).hostname != "tauri.localhost":
        raise RuntimeError("Wrong or ambiguous real WebView2 page")
    endpoint = urlparse(pages[0].get("webSocketDebuggerUrl", ""))
    if (endpoint.scheme, endpoint.hostname, endpoint.port) != ("ws", "127.0.0.1", PORT):
        raise RuntimeError("WebView2 websocket endpoint mismatches QA listener")
    return pages[0]["webSocketDebuggerUrl"]


def check(pid: int) -> dict:
    if os.name != "nt":
        raise RuntimeError("Windows-only negative GUI acceptance")
    profile = Path(os.environ["APPDATA"]) / APP_ID
    db = profile / "pharma_local.db"
    manifest_path = profile / "qa_source_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if (manifest.get("purpose"), manifest.get("app_id"),
            manifest.get("historical_copy"), manifest.get("authorized_historical_access")) != (
            "SINGLE_USE_NEGATIVE_GUI_ONLY", APP_ID, True, False):
        raise RuntimeError("Profile is not the designated non-authorized historical-copy QA")
    if sha(db) != SEALED_SHA:
        raise RuntimeError("Disposable historical test copy differs from sealed original")
    endpoint = custody(pid)
    cdp = ReadOnlyCdp(endpoint)
    observations = []
    try:
        cdp.command("Runtime.enable")
        cdp.command("Page.enable")
        cdp.command("Log.enable")
        for route in ROUTES:
            if custody(pid) != endpoint:
                raise RuntimeError("WebView2 process or endpoint changed")
            cdp.command("Page.navigate", {"url": "http://tauri.localhost" + route})
            result = None
            for _ in range(55):
                try:
                    result = cdp.evaluate(
                        """(async () => {
                          const s = await window.__TAURI_INTERNALS__?.invoke?.('license_status');
                          return {
                            route: location.pathname,
                            invalid: s?.valid === false,
                            startupNotReady: s?.startup_ready === false,
                            businessControlsAbsent: !document.querySelector(
                              '#pos-checkout-submit,#purchase-save-button,#sales-return-search,' +
                              '[data-testid="patient-wallet-topup"]'
                            ),
                            tauriBridgeExists: typeof window.__TAURI_INTERNALS__?.invoke === 'function'
                          };
                        })()"""
                    )
                    if result and result["route"] == route and all(
                        result.get(key) is True
                        for key in ("invalid", "startupNotReady", "businessControlsAbsent",
                                    "tauriBridgeExists")
                    ):
                        break
                except RuntimeError:
                    pass  # Real page navigation replaces JavaScript context.
                time.sleep(0.15)
            else:
                raise RuntimeError(f"Actual Windows WebView did not deny {route}: {result}")
            observations.append(result)
        if custody(pid) != endpoint or sha(db) != SEALED_SHA:
            raise RuntimeError("Process custody or history-copy SHA changed during GUI sweep")
        return {
            "result": "PASS_ACTUAL_WINDOWS_TAURI_FRESH_RENDERER_FIVE_ROUTE_NEGATIVE",
            "qa_exe_sha256": QA_SHA,
            "app_id": APP_ID,
            "real_webview": True,
            "routes": observations,
            "sampled_renderer_errors": cdp.errors,
            "original_history_copy_unchanged": True,
            "finance_or_business_ipc_calls_issued": False,
            "customer_authorization": False,
            "historical_positive_acceptance": False,
        }
    finally:
        cdp.close()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or not sys.argv[1].isdigit():
            raise RuntimeError("Supply the exact pinned disposable QA PID")
        print(json.dumps(check(int(sys.argv[1])), sort_keys=True))
    except (RuntimeError, OSError, ValueError, KeyError, psutil.Error) as error:
        print("QA negative WebView2 acceptance REFUSED: " + str(error), file=sys.stderr)
        raise SystemExit(2)
