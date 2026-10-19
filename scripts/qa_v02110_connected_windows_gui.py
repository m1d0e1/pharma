"""Actual Windows Tauri/WebView2 licensed positive SYNTHETIC GUI lifecycle.

Never operates on v0.2.109 history, real owner credentials, or a customer
license. Matches an immutable QA executable and its directly-owned WebView2
process, uses the real React license/login forms, and cannot issue any native
business IPC or money transaction. Financial GUI writes must be performed
separately, once, with independently checked immutable SQLite receipts.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlparse
from urllib.request import urlopen

import psutil

from scripts.qa_legacy_windows_gui_followon import ReadOnlyCdp
from scripts import qa_v02110_connected_positive_fixture as connected


IDENTITY = connected.IDENTITY
ACTOR = connected.ACTOR
TENANT = connected.TENANT
PORT = 9345
EXE_NAME = "Pharma-0.2.110-CONNECTED-POSITIVE-SYNTHETIC-QA-only.exe"
PREFIX = "v02110-connected-positive-native-"
PUBLIC_TEST_KEY = "IaQa2vpE4smulGbXfH5cB_GzHqCiw_lAhL4JhawORQY"
ROUTES = ("/inventory", "/purchases/new", "/purchases/suppliers", "/pos",
          "/patients", "/reports/sales", "/reports/purchases", "/returns")


def sha(path: Path) -> str:
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def exact_binary() -> tuple[Path, dict]:
    builds = Path(r"D:\PhD\Tools\pharma-builds")
    folders = [p for p in builds.iterdir() if p.is_dir()
               and re.fullmatch(PREFIX + r"[0-9a-f]{32}", p.name)]
    if len(folders) != 1:
        raise RuntimeError("Exactly one sealed connected positive QA package required")
    folder = folders[0]
    manifest = json.loads((folder / "QA_ONLY_RELEASE_BLOCKED.json").read_text("utf-8-sig"))
    executable = folder / EXE_NAME
    if (not executable.is_file() or executable.is_symlink()
            or manifest.get("identity") != IDENTITY
            or manifest.get("qaOnly") is not True
            or manifest.get("testPublicKey") != PUBLIC_TEST_KEY
            or manifest.get("historicalRowsIncluded") is not False
            or manifest.get("release") != "NOT_PRODUCTION_READY"
            or manifest.get("executableSHA256", "").lower() != sha(executable)):
        raise RuntimeError("QA binary or release blocker manifest has changed")
    return executable.resolve(), manifest


def custody(pid: int) -> str:
    if os.name != "nt" or pid < 5:
        raise RuntimeError("Windows pinned synthetic QA only")
    binary, _ = exact_binary()
    process = psutil.Process(pid)
    if Path(process.exe()).resolve() != binary:
        raise RuntimeError("QA process is not the pinned executable")
    direct = [c for c in process.children(recursive=False)
              if c.name().lower() == "msedgewebview2.exe"
              and f"--remote-debugging-port={PORT}" in c.cmdline()
              and IDENTITY.lower() in " ".join(c.cmdline()).lower()]
    listeners = [x for x in psutil.net_connections(kind="tcp")
                 if x.status == "LISTEN" and x.laddr and
                 x.laddr.ip == "127.0.0.1" and x.laddr.port == PORT]
    if len(direct) != 1 or len(listeners) != 1 or listeners[0].pid != direct[0].pid:
        raise RuntimeError("WebView2 is not uniquely owned by connected positive QA")
    with urlopen(f"http://127.0.0.1:{PORT}/json/list", timeout=4) as response:
        pages = [p for p in json.load(response) if p.get("type") == "page"]
    if len(pages) != 1 or urlparse(pages[0].get("url", "")).hostname != "tauri.localhost":
        raise RuntimeError("Not a unique actual Tauri WebView page")
    address = pages[0]["webSocketDebuggerUrl"]
    parsed = urlparse(address)
    if (parsed.scheme, parsed.hostname, parsed.port) != ("ws", "127.0.0.1", PORT):
        raise RuntimeError("WebView2 debugger endpoint mismatch")
    return address


def evaluate_with_wait(cdp: ReadOnlyCdp, source: str, *, tries: int = 50):
    for _ in range(tries):
        try:
            result = cdp.evaluate(source)
            if result:
                return result
        except RuntimeError:
            pass
        time.sleep(0.15)
    raise RuntimeError("Real React UI did not settle into the expected state")


def read_status(pid: int) -> dict:
    endpoint = custody(pid)
    cdp = ReadOnlyCdp(endpoint)
    try:
        cdp.command("Runtime.enable")
        value = evaluate_with_wait(cdp, """(async () => {
          const s = await window.__TAURI_INTERNALS__?.invoke?.('license_status');
          if (!s || !/^[a-f0-9]{64}$/.test(s.machine_fingerprint||'')) return null;
          return { valid:s.valid===true, ready:s.startup_ready===true,
            blocked:s.startup_upgrade_blocked===true, fingerprint:s.machine_fingerprint,
            route:location.pathname };
        })()""")
        if custody(pid) != endpoint:
            raise RuntimeError("QA process replaced during status observation")
        return value
    finally:
        cdp.close()


def activate_test_only(pid: int) -> dict:
    # This is explicit test-only issuance for the separate synthetic QA actor.
    state = read_status(pid)
    if state["valid"] or state["ready"] or state["blocked"]:
        raise RuntimeError("Only an unlicensed new synthetic QA UI may be activated")
    if not (Path(os.environ["APPDATA"]) / IDENTITY / "source.json").is_file():
        raise RuntimeError("Synthetic profile fixture source not pinned")
    if connected.command("issuer-status").get("signed_grant_present"):
        raise RuntimeError("Do not recreate an existing synthetic QA grant")
    issued = connected.command("issue", state["fingerprint"])
    if issued.get("license_verifiable") is not True:
        raise RuntimeError("Signed test-only issuer did not verify its envelope")
    signed = json.dumps(connected.offline_envelope(), separators=(",", ":"))
    endpoint = custody(pid)
    cdp = ReadOnlyCdp(endpoint)
    try:
        cdp.command("Runtime.enable")
        if not evaluate_with_wait(cdp, "document.querySelector('#signed-license')!==null"):
            raise RuntimeError("Real React license form not rendered")
        # Only test-only signed envelope enters the React input, not native IPC.
        javascript = """(() => {
          const input=document.querySelector('#signed-license');
          const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')?.set;
          if (!input || !setter) return false;
          setter.call(input, VALUE);
          input.dispatchEvent(new Event('input',{bubbles:true}));
          return true;
        })()""".replace("VALUE", json.dumps(signed))
        if cdp.evaluate(javascript) is not True:
            raise RuntimeError("React test-only license textarea input refused")
        button = """(() => {
          const el=[...document.querySelectorAll('button')].find(
            b=>b.textContent?.trim()==='تفعيل الترخيص');
          if(!el || el.disabled) return false;
          el.click(); return true;
        })()"""
        if cdp.evaluate(button) is not True:
            raise RuntimeError("Native signed license form cannot be submitted")
        valid = evaluate_with_wait(cdp, """(async() => {
          const s=await window.__TAURI_INTERNALS__.invoke('license_status');
          return s.valid===true && s.startup_ready===false;
        })()""", tries=70)
        if not valid:
            raise RuntimeError("Test-only license verification did not require restart")
    finally:
        cdp.close()
    return {"status":"ACTUAL_WINDOWS_REACT_TEST_LICENSE_SIGNED",
            "test_only":True, "customer_history":False,
            "test_license_issued_once":True,
            "test_license_installed_via_actual_react":True,
            "restart_required":True, "business_postings":0}


def login_test_only(pid: int) -> dict:
    status = read_status(pid)
    if not status["valid"] or not status["ready"] or status["blocked"]:
        raise RuntimeError("Synthetic QA native license/startup not ready")
    endpoint = custody(pid)
    cdp = ReadOnlyCdp(endpoint)
    try:
        cdp.command("Runtime.enable")
        if not evaluate_with_wait(cdp, "document.querySelector('#login-username')!==null"):
            raise RuntimeError("Real React login form not visible")
        secret = connected.secret()
        if (secret.get("app_id"), secret.get("username")) != (IDENTITY, ACTOR):
            raise RuntimeError("Synthetic DPAPI login identity mismatch")
        for name, value in (("login-username", ACTOR),
                            ("login-password", secret["password"])):
            js = """(() => {
              const e=document.getElementById(ID);
              const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
              if(!e||!s)return false;
              s.call(e,VALUE); e.dispatchEvent(new Event('input',{bubbles:true}));
              return true;
            })()""".replace("ID", json.dumps(name)).replace("VALUE", json.dumps(value))
            if cdp.evaluate(js) is not True:
                raise RuntimeError("React login input rejected")
        if cdp.evaluate("""(() => {
           const button=document.querySelector('#login-password')?.closest('form')
             ?.querySelector('button[type=submit]');
           if (!button || button.disabled) return false;
           button.click(); return true;
        })()""") is not True:
            raise RuntimeError("React login submit unavailable")
        evaluate_with_wait(cdp, "location.pathname==='/'", tries=85)
        actor = cdp.evaluate("""(async() => {
          const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');
          return {id:u?.id,role:u?.role,tenant:u?.pharmacy_id};
        })()""")
        if actor != {"id":ACTOR,"role":"owner","tenant":TENANT}:
            raise RuntimeError("Native authenticated synthetic principal mismatch")
        for route in ROUTES:
            if custody(pid) != endpoint:
                raise RuntimeError("QA process changed during GUI route acceptance")
            cdp.command("Page.navigate",{"url":"http://tauri.localhost"+route})
            evaluate_with_wait(cdp, "location.pathname==="+json.dumps(route), tries=70)
            if cdp.evaluate("""(async() => {
              const s=await window.__TAURI_INTERNALS__.invoke('license_status');
              const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');
              return s.valid===true && s.startup_ready===true && u?.id===ID;
            })()""".replace("ID",json.dumps(ACTOR))) is not True:
                raise RuntimeError("Signed synthetic QA session lost on route")
        return {"status":"ACTUAL_WINDOWS_SIGNED_SYNTHETIC_LOGIN_AND_ROUTES_PASS",
                "native_actor":ACTOR,"tenant":TENANT,"routes":list(ROUTES),
                "sampled_renderer_errors":cdp.errors,
                "customer_history_authorized":False,"financial_writes":0}
    finally:
        cdp.close()


if __name__ == "__main__":
    try:
        if len(sys.argv)!=3 or not sys.argv[2].isdigit():
            raise RuntimeError("Command status/activate/login and exact pinned PID required")
        cmd,pid=sys.argv[1],int(sys.argv[2])
        if cmd=="status":
            output=read_status(pid)
            output.pop("fingerprint",None)  # Native fingerprint is not needed in terminal output.
        elif cmd=="activate":
            output=activate_test_only(pid)
        elif cmd=="login":
            output=login_test_only(pid)
        else:
            raise RuntimeError("Unsupported signed synthetic GUI command")
        print(json.dumps(output,sort_keys=True))
    except (OSError,RuntimeError,ValueError,KeyError,psutil.Error):
        print("Connected signed synthetic WebView2 QA REFUSED without financial writes",
              file=sys.stderr)
        raise SystemExit(2)
