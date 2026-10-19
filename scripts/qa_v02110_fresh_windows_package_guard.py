"""Read-only gate for the separately retained *unsigned* fresh-renderer QA package.

Checks actual immutable build artifacts and QA-only source/resource pins. It
does NOT execute an installer, simulate rollback, grant an owner/license, or
claim commercial/customer installation acceptance.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


PROJECT = Path(r"D:\PhD\Tools\pharma")
STAGE = Path(
    r"D:\PhD\Tools\pharma-builds\v02110-renderer-fresh-stage-db939d37ec234d46a07f8f19f6d9a8ec"
)
PACKAGE = Path(
    r"D:\PhD\Tools\pharma-builds\v02110-fresh-renderer-guarded-5525c9a60caa45ac8a79f6d4310ebc96"
)
APP_ID = "com.pharma.disposable.freshrenderqa20261018"
EXE_NAME = "Pharma-0.2.110-FRESH-RENDERER-GUARDED-QA-only.exe"
SETUP_NAME = "Pharma-0.2.110-FRESH-RENDERER-GUARDED-QA-unsigned-x64-setup.exe"
EXPECTED = {
    EXE_NAME: "2227bd604a81fe668d7c44fad4f4e16009d5c0202d77901a649cb84a52694391",
    SETUP_NAME: "4d671b50d18c2dc486e971380764a66f55601e35e3415e90b83608a42256487a",
    "bootstrap": "8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3",
    "sanitized": "2602d9c5d24078cec4dbe5066ff9df71223738e84733747746ff3c55e0678af9",
    "purchase": "2788f7565c5bb46a9189f652dc07c3737cadf3cef6ca2cb87eea11af164cce9c",
}


def sha(path: Path) -> str:
    with path.open("rb") as reader:
        h = hashlib.sha256()
        for chunk in iter(lambda: reader.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def verify() -> dict:
    if os.name != "nt":
        raise RuntimeError("This pinned packaged Windows QA check requires Windows")
    artifacts = {key: sha(PACKAGE / key) for key in (EXE_NAME, SETUP_NAME)}
    if any(artifacts[name] != EXPECTED[name] for name in artifacts):
        raise RuntimeError("Signed-off QA EXE or NSIS bytes changed")
    manifest = json.loads((PACKAGE / "QA_ONLY_RELEASE_BLOCKED.json").read_text(encoding="utf-8-sig"))
    config_path = PROJECT / "src-tauri" / "tauri.v02110-fresh-renderer-guarded-qa.conf.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    expected_export = (PROJECT / "src-tauri" / config["build"]["frontendDist"]).resolve()
    if expected_export != (STAGE / "out").resolve():
        raise RuntimeError("Tauri frontendDist is not the detached fresh export")
    if not (expected_export / "purchases" / "new.html").is_file():
        raise RuntimeError("Purchase frontend not exported")
    if config["identifier"] != APP_ID or config["build"]["beforeBuildCommand"] != "":
        raise RuntimeError("Unsafe app ID or pre-build command")
    if config["bundle"]["resources"] != {"qa-resource-v02110/pharma_local.db": "pharma_local.db"}:
        raise RuntimeError("Windows package config does not map the sanitized QA seed")
    if sha(PROJECT / "src-tauri" / "pharma_local.db") != EXPECTED["bootstrap"]:
        raise RuntimeError("Original bootstrap was changed")
    if sha(PROJECT / "src-tauri" / "qa-resource-v02110" / "pharma_local.db") != EXPECTED["sanitized"]:
        raise RuntimeError("Sanitized resource was changed")
    relative_purchase = Path("src") / "app" / "(dashboard)" / "purchases" / "new" / "PurchaseInvoiceClient.tsx"
    if (sha(PROJECT / relative_purchase) != EXPECTED["purchase"]
            or sha(STAGE / relative_purchase) != EXPECTED["purchase"]):
        raise RuntimeError("Staged purchase patch diverged from packaged frontend source")
    if (manifest.get("appId") != APP_ID or manifest.get("qaOnly") is not True
            or manifest.get("release") != "NOT_PRODUCTION_READY"
            or manifest.get("historyCustodyApproved") is not False
            or manifest.get("historicalPositiveGuiAccepted") is not False
            or manifest.get("installerRuntimeVerified") is not False
            or manifest.get("executableSha256", "").lower() != artifacts[EXE_NAME]
            or manifest.get("installerSha256", "").lower() != artifacts[SETUP_NAME]):
        raise RuntimeError("Retained QA release-blocking manifest does not match artifacts")
    script = (
        "$ErrorActionPreference='Stop';"
        f"$p=Get-Item -LiteralPath '{(PACKAGE / EXE_NAME).as_posix()}';"
        f"$s=Get-AuthenticodeSignature -LiteralPath '{(PACKAGE / SETUP_NAME).as_posix()}';"
        "[pscustomobject]@{version=$p.VersionInfo.ProductVersion;signature=$s.Status.ToString()}"
        "|ConvertTo-Json -Compress"
    )
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, timeout=20, check=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    windows = json.loads(proc.stdout.strip())
    if windows != {"version": "0.2.110", "signature": "NotSigned"}:
        raise RuntimeError("Version or unsigned commercial-release guard changed")
    return {
        "status": "PASS_IMMUTABLE_QA_PACKAGE_STATIC_SAFETY_ONLY",
        "appId": APP_ID,
        "rendererFresh": True,
        "purchaseSourceSHA256": EXPECTED["purchase"],
        "executableSHA256": artifacts[EXE_NAME],
        "installerSHA256": artifacts[SETUP_NAME],
        "authenticode": windows["signature"],
        "version": windows["version"],
        "sanitizedSeedPinned": True,
        "productionInstallerExecuted": False,
        "installerInstallRollbackTested": False,
        "customerHistoryAuthorized": False,
        "readyForProduction": False,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(verify(), sort_keys=True))
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        print("QA PACKAGE RELEASE BLOCKED: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
