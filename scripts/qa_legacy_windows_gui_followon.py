"""Fail-closed, read-only verification of an ALREADY RUNNING legacy 066 QA WebView.

This tool does not launch/restart/activate an application, open a browser/window,
write a database, install a license, or submit any business operation. It only
inspects the existing, uniquely SHA-pinned disposable QA process and its owned
localhost WebView2 debugger. With explicit --five-routes it navigates the same
WebView to five original URLs, solely to verify the safe ownership quarantine.

Run: python -B scripts/qa_legacy_windows_gui_followon.py --pid PID --sha SHA
     --current-only
or add --five-routes for read-only background CDP route navigation.

Do not interpret ownership quarantine as positive historical adoption.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import urlopen

EXPECTED_BINARY = (
    "d:\\phd\\tools\\pharma-builds\\optimized-offline-qa-20261016\\"
    "pharma-0.2.109-optimized-offline-qa-legacy-066-quarantine-20261017-202408.exe"
)
EXPECTED_HASH = "E91A7815BDA39BB141319D04A68ED7720240F8D31C898A632D6FE543E7C1A36E"
ROUTES = (
    "/reports/purchases", "/reports/sales", "/inventory", "/patients", "/returns",
)
QUARANTINE_TEXT = "تم إيقاف الترقية لحماية سجلات الصيدلية"
PROTECTED_CONTROLS = (
    "#pos-checkout-submit,#purchase-save-button,#sales-return-search,"
    '[data-testid="patient-wallet-topup"]'
)


def process_custody(pid: int, sha: str) -> dict:
    """Query only Windows process and TCP metadata, with no commands that mutate state."""
    if sys.platform != "win32" or not re.fullmatch(r"[A-F0-9]{64}", sha):
        raise RuntimeError("Windows/SHA requirement not satisfied")
    if sha != EXPECTED_HASH:
        raise RuntimeError("Refusing any different QA executable digest")

    ps = (
        f"$qa=Get-CimInstance Win32_Process -Filter 'ProcessId={pid}';"
        "if(-not $qa){throw 'QA PID not running'};"
        "$listeners=@(Get-NetTCPConnection -LocalPort 9334 -State Listen -ErrorAction Stop);"
        "if($listeners.Count -ne 1){throw 'Ambiguous WebView2 listener'};"
        "$listener=$listeners[0];"
        "$child=Get-CimInstance Win32_Process -Filter \"ProcessId=$($listener.OwningProcess)\";"
        "if(-not $child){throw 'No owned WebView2'};"
        "[pscustomobject]@{"
        "path=$qa.ExecutablePath;parent=$child.ParentProcessId;"
        "childName=$child.Name;args=$child.CommandLine;"
        "address=$listener.LocalAddress;port=$listener.LocalPort;"
        "listenerPid=$listener.OwningProcess"
        "} | ConvertTo-Json -Compress"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps],
        capture_output=True, text=True, timeout=15, check=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    data = json.loads(result.stdout.strip())
    file_path = str(data["path"])
    if file_path.lower() != EXPECTED_BINARY:
        raise RuntimeError("QA binary path differs from pinned disposable build")
    if not Path(file_path).is_file():
        raise RuntimeError("Pinned QA binary not found")
    with open(file_path, "rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest().upper()
    if digest != sha:
        raise RuntimeError("QA binary contents differ from expected SHA-256")
    if (
        int(data["parent"]) != pid
        or str(data["childName"]).lower() != "msedgewebview2.exe"
        or data["address"] != "127.0.0.1"
        or int(data["port"]) != 9334
        or "--remote-debugging-port=9334" not in data["args"]
        or "com.pharma.disposable.lifecycle.qa20261016" not in data["args"]
    ):
        raise RuntimeError("QA WebView2 is not an exact owned disposable listener")
    return {
        "qaPid": pid,
        "webViewPid": int(data["listenerPid"]),
        "binarySha256": sha,
        "ownedLoopback9334": True,
    }


def only_owned_page() -> str:
    with urlopen("http://127.0.0.1:9334/json/list", timeout=4) as response:
        targets = json.load(response)
    pages = [target for target in targets if target.get("type") == "page"]
    if not pages or len(pages) > 2:
        raise RuntimeError("No unique QA browser target")
    qa_pages = [target for target in pages if urlparse(target.get("url", "")).hostname == "tauri.localhost"]
    if len(qa_pages) != 1 or any(
        target != qa_pages[0] and urlparse(target.get("url", "")).hostname != "downloads-hub"
        for target in pages
    ):
        raise RuntimeError("Foreign or ambiguous WebView2 page present")
    url = qa_pages[0].get("webSocketDebuggerUrl", "")
    parsed = urlparse(url)
    if parsed.scheme != "ws" or parsed.hostname != "127.0.0.1" or parsed.port != 9334:
        raise RuntimeError("Wrong WebView2 page websocket endpoint")
    return url


class ReadOnlyCdp:
    def __init__(self, endpoint: str):
        import websocket  # pip package websocket-client
        self.socket = websocket.create_connection(
            endpoint, timeout=9, suppress_origin=True, http_proxy_host=None
        )
        self.next_id = 0
        self.errors = 0

    def command(self, method: str, params: dict | None = None):
        if method not in {"Runtime.enable", "Log.enable", "Page.enable", "Runtime.evaluate", "Page.navigate"}:
            raise RuntimeError("Non-read-only CDP command refused")
        self.next_id += 1
        seq = self.next_id
        self.socket.send(json.dumps({"id": seq, "method": method, "params": params or {}}))
        deadline = time.monotonic() + 9
        while time.monotonic() < deadline:
            message = json.loads(self.socket.recv())
            name = message.get("method")
            if (
                name == "Runtime.exceptionThrown"
                or name == "Log.entryAdded" and message.get("params", {}).get("entry", {}).get("level") == "error"
                or name == "Runtime.consoleAPICalled" and message.get("params", {}).get("type") == "error"
            ):
                self.errors += 1
            if message.get("id") == seq:
                if message.get("error"):
                    raise RuntimeError(f"CDP {method} rejected")
                return message.get("result", {})
        raise RuntimeError(f"CDP {method} timed out")

    def evaluate(self, expression: str):
        result = self.command("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
        })
        if result.get("exceptionDetails"):
            raise RuntimeError("Page evaluation returned an exception")
        return result.get("result", {}).get("value")

    def close(self):
        self.socket.close()


def check_quarantine(cdp: ReadOnlyCdp) -> dict:
    """The only invoked native method is non-business license_status."""
    return cdp.evaluate(
        """(async () => {
          const status = await window.__TAURI_INTERNALS__?.invoke?.('license_status');
          const banner = document.querySelector(
            '[role="alert"][aria-label="مراجعة ملكية السجلات القديمة"]');
          return {
            route: location.pathname,
            validLicense: status?.valid === true,
            startupDenied: status?.startup_ready === false,
            ownershipBlocked: status?.startup_upgrade_blocked === true,
            quarantineVisible: !!banner && banner.textContent.includes(
              'تم إيقاف الترقية لحماية سجلات الصيدلية'),
            businessControlsAbsent: !document.querySelector(
              '#pos-checkout-submit,#purchase-save-button,#sales-return-search,' +
              '[data-testid="patient-wallet-topup"]')
          };
        })()"""
    )


def inspect(pid: int, sha: str, five_routes: bool) -> dict:
    custody = process_custody(pid, sha)
    endpoint = only_owned_page()
    cdp = ReadOnlyCdp(endpoint)
    observations: list[dict] = []
    try:
        cdp.command("Runtime.enable")
        cdp.command("Page.enable")
        cdp.command("Log.enable")
        before = check_quarantine(cdp)
        if not all(
            before.get(k) is True
            for k in ("validLicense", "startupDenied", "ownershipBlocked", "quarantineVisible", "businessControlsAbsent")
        ):
            raise RuntimeError("Current native startup is not quarantined; navigation refused")
        if five_routes:
            for route in ROUTES:
                # Recheck custody immediately before every background navigation.
                process_custody(pid, sha)
                cdp.command("Page.navigate", {"url": "http://tauri.localhost" + route})
                deadline = time.monotonic() + 9
                observation = None
                ready = False
                while time.monotonic() < deadline:
                    try:
                        observation = check_quarantine(cdp)
                        ready = bool(
                            observation and observation.get("route") == route and all(
                                observation.get(k) is True
                                for k in (
                                    "validLicense", "startupDenied", "ownershipBlocked",
                                    "quarantineVisible", "businessControlsAbsent",
                                )
                            )
                        )
                        if ready:
                            break
                    except RuntimeError:
                        pass  # Replaced document while routing.
                    time.sleep(0.2)
                if not ready:
                    raise RuntimeError(f"Route {route} did not settle with all ownership protections")
                observations.append(observation)
        else:
            observations.append(before)
        process_custody(pid, sha)
        return {
            "custody": custody,
            "mode": "five-route-negative" if five_routes else "current-route-negative",
            "observations": observations,
            "allCheckedRoutesQuarantined": True,
            "runtimeErrorsSampled": cdp.errors,
            "financialOrBusinessNativeCallsIssued": False,
            "historicalTransferVerified": False,
        }
    finally:
        cdp.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--sha", type=str, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--current-only", action="store_true")
    mode.add_argument("--five-routes", action="store_true")
    args = parser.parse_args()
    try:
        value = inspect(args.pid, args.sha.upper(), args.five_routes)
        print("LEGACY_066_GUI_FOLLOWON=" + json.dumps(value, ensure_ascii=False))
        return 0
    except Exception as exc:
        # No patient, sales, or record details; preserve the specific gate reason.
        print("LEGACY_066_GUI_FOLLOWON_BLOCKED=" + type(exc).__name__ + ": " + str(exc))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
