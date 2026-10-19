"""Actual WebView2 React-login QA for the one, licensed, synthetic v0.2.110 profile.

No production/historical database; no raw SQL/business IPC; no secret logging.
Run only when an operator has already started the exact SHA-pinned disposable
QA EXE with loopback WebView2 CDP port 9342 and has accepted its test-only key.
The Python process briefly reads its *own test fixture's* CurrentUser DPAPI
random password and enters it through the real React form, not directly via
login IPC. An authenticated actor is rechecked by native IPC and scope.

The test never edits user credentials, bypasses license/startup/owner guards,
or posts financial transactions. Credential entry is one-shot: on failure it
returns a refusal, never guesses/retries a password or grants an owner session.
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
from scripts.qa_v02110_positive_synthetic_bootstrap import ACTOR, IDENTITY, TENANT, get_secret

QA_EXE = Path(r"D:\PhD\Tools\pharma-builds\v02110-positive-synthetic-8c7a8d5b86dd472e9a81749c21d4144f\Pharma-0.2.110-POSITIVE-SYNTHETIC-QA-only.exe")
QA_SHA = "26ad3d1cd26105127947bff459c36139c9d7c28cee2378c299009e4e1a056b3e"
QA_PORT = 9342
ROUTES = ("/inventory", "/patients", "/reports/purchases", "/reports/sales", "/returns")


def custody(pid: int) -> str:
    if os.name != "nt" or pid < 5 or not QA_EXE.is_file():
        raise RuntimeError("Only existing Windows synthetic QA executable may be inspected")
    process = psutil.Process(pid)
    if Path(process.exe()).resolve() != QA_EXE.resolve() or hashlib.sha256(QA_EXE.read_bytes()).hexdigest() != QA_SHA:
        raise RuntimeError("Live QA executable path or SHA is not pinned")
    listeners = [p for p in psutil.net_connections(kind="tcp")
                 if p.status == "LISTEN" and p.laddr.port == QA_PORT]
    if len(listeners) != 1 or listeners[0].laddr.ip != "127.0.0.1":
        raise RuntimeError("Expected one local synthetic WebView2 debugger")
    child = psutil.Process(listeners[0].pid)
    if child.ppid() != pid or child.name().lower() != "msedgewebview2.exe":
        raise RuntimeError("WebView2 process is not the pinned QA child")
    arguments = child.cmdline()
    if "--remote-debugging-port=9342" not in arguments or not any(
        arg.lower().startswith("--user-data-dir=") and
        IDENTITY.lower() in arg.lower() for arg in arguments
    ):
        raise RuntimeError("WebView2 debugger/profile identity mismatch")
    with urlopen(f"http://127.0.0.1:{QA_PORT}/json/list", timeout=4) as response:
        pages = [p for p in json.load(response) if p.get("type") == "page"]
    if len(pages) != 1 or urlparse(pages[0].get("url", "")).hostname != "tauri.localhost":
        raise RuntimeError("Non-unique or non-Tauri synthetic QA page")
    endpoint = pages[0]["webSocketDebuggerUrl"]
    parsed = urlparse(endpoint)
    if (parsed.scheme, parsed.hostname, parsed.port) != ("ws", "127.0.0.1", QA_PORT):
        raise RuntimeError("Wrong QA debugger websocket")
    return endpoint


def wait_for(cdp: ReadOnlyCdp, expression: str, *, attempts: int = 60) -> bool:
    for _ in range(attempts):
        try:
            if cdp.evaluate(expression):
                return True
        except RuntimeError:
            pass
        time.sleep(0.15)
    return False


def check(pid: int) -> dict:
    endpoint = custody(pid)
    manifest = Path(os.environ["APPDATA"]) / IDENTITY / "source.json"
    if not manifest.is_file():
        raise RuntimeError("Synthetic QA manifest missing")
    metadata = json.loads(manifest.read_text(encoding="utf8"))
    if (metadata.get("app_id"), metadata.get("tenant"),
        metadata.get("historical_rows_included"),
        metadata.get("genuine_customer_ownership_approved")) != (IDENTITY,TENANT,False,False):
        raise RuntimeError("Positive GUI identity is not wholly synthetic")
    cdp = ReadOnlyCdp(endpoint)
    try:
        cdp.command("Runtime.enable")
        if not wait_for(cdp,"document.querySelector('#login-username')!==null",attempts=45):
            raise RuntimeError("React login form not rendered")
        license_ok = cdp.evaluate("(async()=>{const s=await window.__TAURI_INTERNALS__.invoke('license_status');return s?.valid===true&&s?.startup_ready===true&&s?.startup_upgrade_blocked===false})()")
        if not license_ok or cdp.evaluate("location.pathname") != "/login":
            raise RuntimeError("Synthetic Windows app is not licensed and waiting for login")
        # Owned disposable identity only. Never take a secret from an original
        # customer user, renderer storage, shell arguments or a text fixture.
        secret = get_secret()
        if secret.get("app_id") != IDENTITY or secret.get("username") != ACTOR:
            raise RuntimeError("DPAPI QA fixture credential belongs to wrong identity")
        fields = (("login-username",secret["username"]),
                  ("login-password",secret["password"]))
        for element_id,value in fields:
            action = """(()=>{const e=document.getElementById(ID),s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;if(!e||!s)return false;s.call(e,VALUE);e.dispatchEvent(new Event('input',{bubbles:true}));return true})()"""
            action = action.replace("ID",json.dumps(element_id)).replace("VALUE",json.dumps(value))
            if cdp.evaluate(action) is not True:
                raise RuntimeError("Synthetic login form input was rejected")
        clicked = cdp.evaluate("(()=>{const f=document.querySelector('#login-password')?.closest('form');if(!f)return false;const b=f.querySelector('button[type=submit]');if(!b||b.disabled)return false;b.click();return true})()")
        if clicked is not True or not wait_for(cdp,"location.pathname==='/'",attempts=70):
            raise RuntimeError("Actual QA React login did not complete")
        actor = cdp.evaluate("(async()=>{const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');return {id:u?.id,role:u?.role,pharmacy_id:u?.pharmacy_id}})()")
        if actor != {"id":ACTOR,"role":"owner","pharmacy_id":TENANT}:
            raise RuntimeError("Native authenticated QA actor does not match tenant")
        for route in ROUTES:
            if custody(pid) != endpoint:
                raise RuntimeError("QA executable or WebView2 custody changed")
            cdp.command("Page.navigate",{"url":"http://tauri.localhost"+route})
            if not wait_for(cdp,"location.pathname==="+json.dumps(route),attempts=50):
                raise RuntimeError("Requested authenticated QA route did not settle")
            valid = cdp.evaluate("(async()=>{const s=await window.__TAURI_INTERNALS__.invoke('license_status');const u=await window.__TAURI_INTERNALS__.invoke('current_local_user');return s.valid===true&&s.startup_ready===true&&u?.id==="+json.dumps(ACTOR)+"})()")
            if valid is not True:
                raise RuntimeError("Authenticated QA session/tenant lost on route navigation")
        return {"status":"VERIFIED_REAL_WINDOWS_QA_GUI_LOGIN_AND_FIVE_ROUTES",
                "actual_react_form_used":True,"native_login_actor_verified":True,
                "active_named_qa_tenant":True,"signed_offline_license":True,
                "five_business_routes_checked":True,"historical_customer_data":False,
                "customer_scope_authorization":False,"financial_mutations":0,
                "sampled_runtime_errors":cdp.errors}
    finally:
        cdp.close()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2 or not re.fullmatch(r"[1-9][0-9]{1,6}",sys.argv[1]):
            raise RuntimeError("Supply exact running positive synthetic QA PID")
        print(json.dumps(check(int(sys.argv[1])),sort_keys=True))
    except (RuntimeError,ValueError,KeyError,OSError,psutil.Error):
        print("Actual QA GUI login refused; no customer source or financial records touched",file=sys.stderr)
        raise SystemExit(2)
