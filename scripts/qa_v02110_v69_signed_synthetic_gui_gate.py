"""Pinned v69 test-signed *synthetic* GUI license/login via real React forms.

No application/installer launch and NO finance IPC. Invoke only after verifying
the v69 QA-only signed EXE and starting it in a wholly separate QA process with
WebView2 debug port 9369 (never PID 25528/port 9345). Activation is ONE-TIME.
The login form uses only this fixture's DPAPI-protected synthetic password.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys

import psutil

from scripts import qa_v02110_connected_windows_gui as tested_gui
from scripts import qa_v02110_v69_signed_synthetic_fixture as synthetic


PORT = 9369
MANIFEST = synthetic.QA_ROOT / "QA_ONLY_RELEASE_BLOCKED.json"
TEST_EXE = synthetic.QA_ROOT / "Pharma-0.2.110-V069-SYNTHETIC-FINANCE-TEST-SIGNED-QA-only.exe"


def sha(path: Path) -> str:
    hash_value = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            hash_value.update(data)
    return hash_value.hexdigest()


def exact_binary() -> tuple[Path, dict]:
    if os.name != "nt" or not MANIFEST.is_file() or MANIFEST.is_symlink():
        raise RuntimeError("Windows-only pinned v69 QA manifest is required")
    record = json.loads(MANIFEST.read_text(encoding="utf-8-sig"))
    expected = {
        "qaOnly": True,
        "release": "NOT_PRODUCTION_READY",
        "appId": synthetic.IDENTITY,
        "nativeStrictRendererSqlQa": True,
        "bundledInstaller": False,
        "testLicensePublicKey": "UY4M7QDwEWQKBJqhJvZmO5g8tem_SQXgKAEDNEKcdOU",
        "commercialOwnerAuthenticated": False,
        "customerDataBundled": False,
        "commercialLicenseIssued": False,
        "testSignedExecutableFile": TEST_EXE.name,
        "codeSigningTrustStoreImported": False,
        "codeSigningIssuer": "SELF_SIGNED_EPHEMERAL_TEST_ONLY",
    }
    if any(record.get(key) != value for key, value in expected.items()):
        raise RuntimeError("v69 synthetic QA signed executable or license manifest changed")
    if not TEST_EXE.is_file() or TEST_EXE.is_symlink() or sha(TEST_EXE) != record.get("testSignedExecutableSha256", "").lower():
        raise RuntimeError("Pinned test-signed v69 GUI EXE byte hash changed")
    return TEST_EXE.resolve(), record


def configure_readonly_gate() -> None:
    # Reuse only the already validated real React activation/login/browser
    # custody code from connected QA. Do NOT invoke its hardcoded old-PID CLI.
    tested_gui.IDENTITY = synthetic.IDENTITY
    tested_gui.ACTOR = synthetic.ACTOR
    tested_gui.TENANT = synthetic.TENANT
    tested_gui.PORT = PORT
    tested_gui.connected = synthetic
    tested_gui.exact_binary = exact_binary
    synthetic.secret = synthetic.owner_secret
    tested_gui.ROUTES = ("/", "/purchases/new", "/purchases/suppliers", "/reports/purchases",
                         "/reports/sales", "/inventory", "/returns")


def run(command: str, pid: int) -> dict:
    exact_binary()
    if pid == 25528:
        raise RuntimeError("Protected signed QA PID25528 must never be targeted")
    if os.environ.get("PHARMA_SECURITY_RELEASE_APPROVED"):
        raise RuntimeError("This is a synthetic QA-only GUI flow")
    configure_readonly_gate()
    if command == "preflight":
        status = tested_gui.read_status(pid)
        if status["valid"] or status["ready"] or status["blocked"]:
            raise RuntimeError("Activation preflight needs a new unlicensed synthetic QA window")
        endpoint = tested_gui.custody(pid)
        cdp = tested_gui.ReadOnlyCdp(endpoint)
        try:
            react_ready = cdp.evaluate("""(() => {
                const t=document.querySelector('#signed-license');
                const b=[...document.querySelectorAll('button')].find(
                  el=>el.textContent?.trim()==='تفعيل الترخيص');
                // Disabled before the signed envelope is entered is expected.
                return !!t && !!b;
            })()""")
            if react_ready is not True:
                visible = cdp.evaluate("""(() => ({path:location.pathname,
                  signedTextarea:!!document.querySelector('#signed-license'),
                  buttons:[...document.querySelectorAll('button')].slice(0,8).map(
                    b=>({text:(b.textContent||'').trim().slice(0,70),disabled:b.disabled}))
                }))()""")
                raise RuntimeError("Native v69 activation React form not ready; do not issue test grant: " + json.dumps(visible, ensure_ascii=False))
        finally:
            cdp.close()
        return {"status": "PASS_REAL_REACT_TEST_LICENSE_FORM", "qaPid": pid,
                "port": PORT, "testGrantIssued": False, "financialWrites": 0}
    if command == "status":
        status = tested_gui.read_status(pid)
        status.pop("fingerprint", None)
        return status
    if command == "activate":
        return tested_gui.activate_test_only(pid)
    if command == "login":
        return tested_gui.login_test_only(pid)
    raise RuntimeError("Only preflight, status, activate or login permitted; NO finance IPC")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3 or sys.argv[1] not in ("preflight", "status", "activate", "login"):
            raise RuntimeError("Usage: python -B -m scripts.qa_v02110_v69_signed_synthetic_gui_gate preflight|status|activate|login <new QA PID>")
        pid = int(sys.argv[2])
        if pid <= 4:
            raise RuntimeError("Invalid QA PID")
        print(json.dumps(run(sys.argv[1], pid), sort_keys=True))
    except (OSError, RuntimeError, ValueError, KeyError, psutil.Error) as failure:
        # Never print an activation envelope, DPAPI password or native machine
        # fingerprint; only the public exception class from this gate.
        detail = str(failure) if len(sys.argv) > 1 and sys.argv[1] == "preflight" else type(failure).__name__
        print("v69 SIGNED SYNTHETIC GUI REFUSED; no financial writes: " + detail,
              file=sys.stderr)
        raise SystemExit(2)
