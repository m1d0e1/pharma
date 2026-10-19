"""Opt-in *actual* per-user NSIS lifecycle for the new pinned, guarded v68 QA wrapper.

The original v68 installer is never run. The new wrapper uses a unique QA-only
process filename, no elevation, no system WebView2 installer, and only a freshly
allocated disposable $LOCALAPPDATA target. Repeated installed-customer-hash
checks fail closed if other programs modify the protected source meanwhile.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

from scripts import qa_v02110_v68_nsis_isolation as original
from scripts import qa_v02110_v68_nsis_guarded_repackage as guarded


GUARDED_FOLDER = original.EVIDENCE_PARENT / "guarded-build-c88c3ebb3ee44e32a8429b2929675dad"
GUARDED_SETUP = GUARDED_FOLDER / guarded.QA_SETUP
GUARDED_SETUP_SHA256 = "1f33d0fcd32578689b26911b45a872bdf0deeac9ebb5fa46970f7ce4e5152cd0"
GUARDED_NSI_SHA256 = "67aaf8d7d3da9bbcd79a1fc80f0052a15d4f18ad8cc874a9ae6f63cfb1fd6e7b"
PROTECTED_CUSTOMER_EXE = Path(r"C:\Program Files\Pharmacy Local Enforcer\pharma.exe")
PROTECTED_CUSTOMER_EXE_SHA256 = "1842cd68e55caaba697268c5e8e55dfde469dca975eb839e7dbe9ca4a546e99d"
SIGNED_QA_ID = "com.pharma.disposable.connectedpositiveqa20261018"
SIGNED_PID = 25528


def check_reg() -> dict:
    import winreg

    keyname = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + guarded.QA_PRODUCT
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, keyname, 0,
                        winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
        return {name: winreg.QueryValueEx(key, name)[0] for name in
                ("DisplayName", "DisplayVersion", "InstallLocation", "UninstallString")}


def registry_absent() -> bool:
    try:
        check_reg()
        return False
    except FileNotFoundError:
        return True


def assert_customer_files() -> dict:
    state = original.inspect_protected_state()
    original.expect_digest(PROTECTED_CUSTOMER_EXE, PROTECTED_CUSTOMER_EXE_SHA256)
    return state


def signed_profile_fingerprint() -> dict:
    # Read-only custody; no activation, SQLite connection or process command.
    profile = Path(os.environ["APPDATA"]) / SIGNED_QA_ID
    db = profile / "pharma_local.db"
    if not profile.is_dir() or profile.is_symlink() or not db.is_file():
        raise original.Refused("Protected signed synthetic QA profile disappeared")
    import psutil

    process = psutil.Process(SIGNED_PID)
    # This app's EXE filename contains CONNECTED-POSITIVE, while its profile
    # app ID is independent and checked by the pinned profile folder above.
    if not process.is_running() or "connected-positive-synthetic-qa-only.exe" not in process.name().lower():
        raise original.Refused("Signed QA PID identity changed")
    exe = Path(process.exe())
    if original.sha256(exe) != "dc7133ca1494249fed5a5a135cd15b1e7a8ba3b5d82876f44b7d09e831666e2c":
        raise original.Refused("Protected signed QA executable bytes changed")
    webview = sorted((child.pid, child.create_time(), tuple(child.cmdline()))
                     for child in process.children(recursive=False)
                     if child.name().lower() == "msedgewebview2.exe")
    if not any(any("--remote-debugging-port=9345" in arg for arg in cmd)
               for _, _, cmd in webview):
        raise original.Refused("Protected signed QA WebView PID/custody disappeared")
    return {"signedQaPid": SIGNED_PID, "signedQaExe": str(exe),
            "signedQaExeSha256": original.sha256(exe),
            "signedQaCreationTime": process.create_time(),
            "signedQaWebviewDirectChildren": webview,
            "signedQaDbSha256": original.sha256(db)}


def verify_existing_wrapper() -> dict:
    original.inspect_artifacts()
    original.expect_digest(GUARDED_SETUP, GUARDED_SETUP_SHA256)
    source = GUARDED_FOLDER / "nsis-source" / "installer.nsi"
    original.expect_digest(source, GUARDED_NSI_SHA256)
    contract = guarded.inspect_guarded(source.read_text(encoding="utf-8-sig"))
    if not contract["installModeCurrentUser"] or not contract["processHelperNowTargetsUniqueQaFilename"]:
        raise original.Refused("Guarded compiled QA NSIS contract no longer isolated")
    return contract


def no_running_qa_process() -> None:
    import psutil

    for process in psutil.process_iter(("name",)):
        if process.info.get("name", "").lower() == guarded.QA_EXE_BASENAME + ".exe":
            raise original.Refused("Guarded QA process already running; no safe file install/uninstall")


def require_install_target(path: Path) -> None:
    root = Path(os.environ["LOCALAPPDATA"]).resolve()
    if not path.is_absolute() or not original._within(path, root) or path.exists():
        raise original.Refused("QA runtime installation target is not fresh under LocalAppData")
    if path.parent.resolve() != root or not path.name.startswith("pharma-v68-nsis-qa-trial-"):
        raise original.Refused("Unexpected QA runtime installation location")


def actual_installed_payload(target: Path) -> dict:
    exe = target / (guarded.QA_EXE_BASENAME + ".exe")
    db = target / "pharma_local.db"
    uninstall = target / "uninstall.exe"
    if not target.is_dir() or target.is_symlink() or not uninstall.is_file():
        raise original.Refused("Guarded NSIS did not produce isolated install files")
    original.expect_digest(exe, original.SHA[original.EXECUTABLE])
    original.expect_digest(db, original.SHA["sanitized"])
    registry = check_reg()
    install_location = registry["InstallLocation"].strip('"')
    if (registry["DisplayName"] != guarded.QA_PRODUCT
            or registry["DisplayVersion"] != "0.2.110"
            or Path(install_location).resolve() != target.resolve()
            or Path(registry["UninstallString"].strip('"')).resolve() != uninstall.resolve()):
        raise original.Refused("Unexpected QA uninstall registry target")
    return {"installedExeSha256": original.SHA[original.EXECUTABLE],
            "installedSeedSha256": original.SHA["sanitized"],
            "registryScopedToQaProduct": True,
            "installPath": str(target)}


def run_installer(target: Path) -> int:
    complete = subprocess.run(
        [str(GUARDED_SETUP), "/S", "/NS", "/CurrentUser", "/D=" + str(target)],
        timeout=150, check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return complete.returncode


def run_uninstaller(target: Path) -> int:
    uninstall = target / "uninstall.exe"
    if not uninstall.is_file() or not original._within(uninstall, Path(os.environ["LOCALAPPDATA"])):
        raise original.Refused("Refused uninstaller outside guarded QA install target")
    complete = subprocess.run([str(uninstall), "/S"], timeout=150, check=False,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return complete.returncode


def verify_removed(target: Path, max_seconds: float = 25.0) -> float:
    # NSIS may exit its initial uninstaller process after launching a temporary
    # self-copy to finish deleting uninstall.exe. The first child exit code is
    # not sufficient: poll the actual target and HKCU key until both disappear.
    began = time.monotonic()
    while target.exists() or not registry_absent():
        if time.monotonic() - began > max_seconds:
            raise original.Refused("Guarded QA uninstall left installed payload or registry key")
        time.sleep(0.15)
    qa_profile = Path(os.environ["APPDATA"]) / original.QA_ID
    if qa_profile.exists():
        raise original.Refused("Unexpected QA profile created without running QA app")
    return time.monotonic() - began


def run() -> dict:
    if os.name != "nt":
        raise original.Refused("Windows-only guarded runtime acceptance")
    contract = verify_existing_wrapper()
    customer_before = assert_customer_files()
    signed_before = signed_profile_fingerprint()
    no_running_qa_process()
    if not registry_absent():
        raise original.Refused("Pre-existing QA uninstall registry key")

    local = Path(os.environ["LOCALAPPDATA"]).resolve()
    target = local / ("pharma-v68-nsis-qa-trial-" + uuid.uuid4().hex)
    require_install_target(target)
    evidence = original.EVIDENCE_PARENT / ("runtime-trial-" + uuid.uuid4().hex)
    evidence.mkdir(exist_ok=False)
    result = {"guardedSetupSha256": GUARDED_SETUP_SHA256,
              "originalV68InstallerExecuted": False,
              "guardedWrapperInstallUninstallExecuted": True,
              "guardedNsisContract": contract,
              "customerBefore": customer_before,
              "signedQaBefore": signed_before,
              "target": str(target),
              "steps": []}

    def stage(name: str, **details: object) -> None:
        result["steps"].append({"step": name, **details})
        file = evidence / "NSIS_RUNTIME_EVIDENCE.json"
        with file.open("w", encoding="utf-8") as output:
            json.dump(result, output, sort_keys=True, indent=2)
            output.write("\n")

    stage("preflight", qaTargetAbsent=True, registryAbsent=True)
    for iteration in (1, 2):
        no_running_qa_process()
        require_install_target(target)
        code = run_installer(target)
        stage("install", iteration=iteration, exitCode=code)
        if code != 0:
            raise original.Refused("Guarded NSIS per-user install returned nonzero")
        payload = actual_installed_payload(target)
        stage("verify-installed", iteration=iteration, **payload)
        assert_customer_files()
        no_running_qa_process()
        code = run_uninstaller(target)
        stage("uninstall", iteration=iteration, exitCode=code)
        if code != 0:
            raise original.Refused("Guarded NSIS per-user uninstall returned nonzero")
        cleanup_seconds = verify_removed(target)
        stage("verify-removed", iteration=iteration, targetAbsent=True,
              registryAbsent=True, cleanupWaitSeconds=round(cleanup_seconds, 3))
        assert_customer_files()

    signed_after = signed_profile_fingerprint()
    if signed_before != signed_after:
        raise original.Refused("Protected signed QA profile or running executable changed during trial")
    customer_after = assert_customer_files()
    if customer_before != customer_after:
        raise original.Refused("Protected customer database metadata changed during trial")
    result["signedQaAfter"] = signed_after
    result["customerAfter"] = customer_after
    result["customerAndSignedQaUnchanged"] = True
    result["result"] = "PASS_REAL_GUARDED_QA_NSIS_INSTALL_UNINSTALL_REINSTALL_UNINSTALL"
    result["productionCustomerUpgradeOrRollbackAccepted"] = False
    result["actualRuntimeOriginalV68InstallerAccepted"] = False
    stage("final", protectedCustomerAndSignedQaIntact=True)
    result["evidencePath"] = str(evidence / "NSIS_RUNTIME_EVIDENCE.json")
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(run(), sort_keys=True))
    except (OSError, ValueError, original.Refused, subprocess.SubprocessError) as exc:
        print("REFUSED actual guarded NSIS QA lifecycle: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
