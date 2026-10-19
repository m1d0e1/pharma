"""Explicit one-time native licensing of only the new disposable lifecycle app.

Use only while the NEW independently compiled QA binary is running minimized
with a single localhost WebView2 debug endpoint. Parent PowerShell must verify
the exact process executable path/hash and port before invoking this helper.
The signed grant never leaves protected DPAPI state except over private stdin
to the native `license_install` IPC, and is never printed or persisted here.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

from scripts.licensing.lifecycle_qa import _state, grant, status
from scripts.qa_lifecycle_fixture import APP_ID, verify_fixture


BRIDGE = Path(__file__).with_name("qa_lifecycle_license_bridge.js")


def bridge(mode: str, signed_grant: dict | None = None) -> dict:
    outcome = subprocess.run(["node", str(BRIDGE), mode],
                             input=json.dumps(signed_grant) if signed_grant is not None else None,
                             text=True, capture_output=True, timeout=35,
                             cwd=Path(__file__).resolve().parents[1])
    if outcome.returncode != 0:
        # Never echo a native exception containing signed material.
        raise RuntimeError("New QA WebView native licensing bridge refused operation")
    response = json.loads(outcome.stdout)
    return response


def main() -> None:
    if os.name != "nt":
        raise RuntimeError("Native lifecycle licensing is Windows-only")
    fixture = verify_fixture(Path(os.environ["APPDATA"]))
    if fixture["app_id"] != APP_ID:
        raise RuntimeError("Disposable lifecycle database is not owned by new app identity")
    issuer = status()
    if issuer["grant_state"] != "not-issued":
        raise RuntimeError("Grant already issued; inspect protected state instead of replaying")
    native = bridge("status")
    if native["valid"]:
        raise RuntimeError("Unexpected prelicensed QA binary")
    fingerprint = native["fingerprint"]
    result = grant(fingerprint=fingerprint, days=7, profile_parent=Path(os.environ["APPDATA"]))
    if result["status"] != "signed-offline-term":
        raise RuntimeError("Independent QA issuer did not produce offline signed term")
    envelope = _state()["credential"]["offline_grant"]
    installed = bridge("install", envelope)
    if not installed["valid"] or not installed["offline_term"]:
        raise RuntimeError("QA native installation failed")
    print(json.dumps({"qa_identity": APP_ID, "license_issued_to_new_native_binary": True,
                      "offline_term": True, "requires_restart": not installed["startup_ready"],
                      "credentials_never_printed": True}, sort_keys=True))


if __name__ == "__main__":
    main()
