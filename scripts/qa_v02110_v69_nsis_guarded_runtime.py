"""Fail-closed, two-cycle *real* NSIS test for a pinned hardened v69 QA wrapper.

The original v69 setup (SHA 9D1D...) must NEVER be launched: its generated
WebView2 section can invoke the machine Edge updater despite 'skip' in config.
The only executable accepted here is a separately recompiled, pinned wrapper
whose complete WebView2 section is inert. The live customer and signed QA
profiles are read only. The v69 application itself is never started.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from scripts import qa_v02110_v68_nsis_isolation as common


BUILD = Path(r"D:\PhD\Tools\pharma-builds\v02110-v069-guarded-qa-9d7f48b8d502431a93bba44c13f34ca6")
ORIGINAL_SETUP = BUILD / "Pharma-0.2.110-V069-QuickAdd-UNSIGNED-QA-x64-setup.exe"
ORIGINAL_SETUP_SHA256 = "9d1d19121d463f446f4606bd01804b9fc5d2681cb38d7254e2f1839d5712cdf0"
ORIGINAL_NSI = BUILD / "cargo-target/x86_64-pc-windows-msvc/debug/nsis/x64/installer.nsi"
ORIGINAL_NSI_SHA256 = "a90366fb261bad937d0c4ac1b8dcec6aeb8b63b741abb97320b9715053a7a434"
MANIFEST = BUILD / "QA_ONLY_RELEASE_BLOCKED.json"
QA_PRODUCT = "Pharma 0.2.110 V069 QuickAdd Guarded QA"
QA_APP_ID = "com.pharma.disposable.v069quickaddqa20261018"
QA_EXE = "pharma-v069-quickadd-guarded-qa.exe"
QA_EXE_SHA256 = "43433662d1323d1be8e5387badfe792f791679a6f9a1a7d6264e4c56457307da"
QA_SEED = common.PROJECT / "src-tauri/qa-resource-v02110/pharma_local.db"
QA_SEED_SHA256 = "2602d9c5d24078cec4dbe5066ff9df71223738e84733747746ff3c55e0678af9"
REPO_SEED = common.PROJECT / "src-tauri/pharma_local.db"
REPO_SEED_SHA256 = "8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3"
CUSTOMER_EXE = Path(r"C:\Program Files\Pharmacy Local Enforcer\pharma.exe")
CUSTOMER_EXE_SHA256 = "1842cd68e55caaba697268c5e8e55dfde469dca975eb839e7dbe9ca4a546e99d"
SIGNED_APP_ID = "com.pharma.disposable.connectedpositiveqa20261018"
SIGNED_PID = 25528
SIGNED_WEBVIEW_PID = 5620
SIGNED_EXE_SHA256 = "dc7133ca1494249fed5a5a135cd15b1e7a8ba3b5d82876f44b7d09e831666e2c"
SIGNED_DB_SHA256 = "9ae96cee46e1361c8a88f37a4d72e3be535c7e1edd08fdaebfcec12b27db3f65"
SIGNED_RUNNING_CLOCK = "licensing/license-clock.dpapi"

# Independently compiled QA-only wrapper; the original installer is forbidden.
HARDENED_SETUP = BUILD / "Pharma-0.2.110-V069-QuickAdd-HARDENED-UNSIGNED-QA-x64-setup.exe"
HARDENED_SETUP_SHA256 = "53ef5b1dee90b847f217955724202479edca92a31c807fef9aba5be7026fb9c9"
HARDENED_NSI = BUILD / "hardened-nsis-source/installer.nsi"
HARDENED_NSI_SHA256 = "4556e4032ae2a55644b7ade0ff5cdf5fa203d43b5ce30f0a5163d46bfaaa50ca"


def require(condition: bool, explanation: str) -> None:
    if not condition:
        raise common.Refused(explanation)


def stat_hash(path: Path) -> dict:
    require(path.is_file() and not path.is_symlink(), "Missing or linked protected file: " + str(path))
    attrs = path.stat()
    return {"sha256": common.sha256(path), "size": attrs.st_size, "mtimeNs": attrs.st_mtime_ns}


def tree_fingerprint(root: Path) -> dict:
    require(root.is_dir() and not root.is_symlink(), "Missing protected signed QA profile")
    records = {}
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink(), "Protected signed QA tree contains link")
        if path.is_file():
            records[path.relative_to(root).as_posix()] = stat_hash(path)
    return records


def protected_fingerprint() -> dict:
    """Byte hashes and metadata without SQLite, process signalling or writing."""
    require(os.name == "nt", "Windows required")
    customer = Path(os.environ["APPDATA"]) / "com.pharma.system/pharma_local.db"
    database = stat_hash(customer)
    require(database["sha256"] == common.SHA["installed_customer"], "Customer database checksum changed")
    sidecars = [str(customer) + suffix for suffix in ("-wal", "-shm", "-journal")]
    require(not any(Path(x).exists() for x in sidecars), "Customer SQLite WAL/SHM/journal present")
    common.expect_digest(CUSTOMER_EXE, CUSTOMER_EXE_SHA256)

    import psutil
    process = psutil.Process(SIGNED_PID)
    require(process.is_running() and "connected-positive-synthetic-qa-only.exe" in process.name().lower(),
            "Protected signed synthetic PID identity changed")
    signed_exe = Path(process.exe())
    common.expect_digest(signed_exe, SIGNED_EXE_SHA256)
    child = next((p for p in process.children(recursive=False) if p.pid == SIGNED_WEBVIEW_PID), None)
    require(child is not None and child.is_running() and child.name().lower() == "msedgewebview2.exe",
            "Protected signed QA WebView2 PID changed")
    require("--remote-debugging-port=9345" in child.cmdline(), "Protected signed QA WebView2 port changed")

    signed_profile = Path(os.environ["APPDATA"]) / SIGNED_APP_ID
    signed_files = tree_fingerprint(signed_profile)
    require(signed_files.get("pharma_local.db", {}).get("sha256") == SIGNED_DB_SHA256,
            "Protected signed QA DB checksum changed")
    return {
        "customerDb": database, "customerNoSidecars": True,
        "customerExeSha256": CUSTOMER_EXE_SHA256,
        "signedQaPid": SIGNED_PID,
        "signedQaCreationTime": process.create_time(),
        "signedQaExe": str(signed_exe),
        "signedQaExeSha256": SIGNED_EXE_SHA256,
        "signedQaWebviewPid": SIGNED_WEBVIEW_PID,
        "signedQaWebviewCreationTime": child.create_time(),
        "signedQaWebviewPort": 9345,
        "signedQaProfileFiles": signed_files,
    }


def stable_protected_view(state: dict) -> dict:
    """Exclude only the live signed process's rotating DPAPI clock.

    This file advanced at its observed one-minute cadence during the first
    guarded trial. Its full hashes/timestamps are still retained in evidence;
    every other signed profile file, both DBs, both process identities and the
    customer executable are compared exactly.
    """
    return {**state, "signedQaProfileFiles": {
        name: fingerprint for name, fingerprint in state["signedQaProfileFiles"].items()
        if name != SIGNED_RUNNING_CLOCK
    }}


def assert_protected_stable(before: dict, after: dict) -> None:
    require(stable_protected_view(before) == stable_protected_view(after),
            "Protected customer DB, signed QA process or stable profile files changed")


def reg_product(hive: int) -> dict | None:
    import winreg
    path = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + QA_PRODUCT
    try:
        with winreg.OpenKey(hive, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as key:
            return {name: winreg.QueryValueEx(key, name)[0] for name in
                    ("DisplayName", "DisplayVersion", "InstallLocation", "UninstallString")}
    except FileNotFoundError:
        return None


def assert_qa_uninstalled() -> None:
    import winreg
    require(reg_product(winreg.HKEY_CURRENT_USER) is None, "QA HKCU uninstall key already exists")
    require(reg_product(winreg.HKEY_LOCAL_MACHINE) is None, "QA HKLM uninstall key already exists")
    for root in ("APPDATA", "LOCALAPPDATA"):
        require(not (Path(os.environ[root]) / QA_APP_ID).exists(), "QA app profile already exists")


def assert_no_qa_process() -> None:
    import psutil
    for process in psutil.process_iter(("name",)):
        if (process.info.get("name") or "").lower() == QA_EXE:
            raise common.Refused("QA executable process already running; fail closed")


def static_contract() -> dict:
    """Checks both unsafe original and exact, separately-pinned hardened wrapper."""
    common.expect_digest(ORIGINAL_SETUP, ORIGINAL_SETUP_SHA256)
    common.expect_digest(ORIGINAL_NSI, ORIGINAL_NSI_SHA256)
    common.expect_digest(QA_SEED, QA_SEED_SHA256)
    common.expect_digest(REPO_SEED, REPO_SEED_SHA256)
    common.expect_digest(BUILD / "Pharma-0.2.110-V069-QuickAdd-Guarded-QA-only.exe", QA_EXE_SHA256)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8-sig"))
    expected = {"release": "NOT_PRODUCTION_READY", "qaOnly": True, "appId": QA_APP_ID,
                "uniqueExecutableName": QA_EXE, "nsisInstallMode": "currentUser",
                "webview2RuntimeInstaller": "FULL_SECTION_DISABLED", "customerDataBundled": False,
                "exeAuthenticode": "NotSigned", "nsisAuthenticode": "NotSigned",
                "exeSha256": QA_EXE_SHA256.upper(), "nsisSha256": HARDENED_SETUP_SHA256.upper(),
                "retainedTauriGeneratedNsisSha256": ORIGINAL_SETUP_SHA256.upper(),
                "hardenedNsisSourceSha256": HARDENED_NSI_SHA256.upper(),
                "webview2SectionInert": True, "noMachineWebviewUpdatePath": True,
                "sanitizedQaResourceSha256": QA_SEED_SHA256.upper(),
                "packagedResourceSha256": QA_SEED_SHA256.upper()}
    drift = [key for key, value in expected.items() if manifest.get(key) != value]
    require(not drift, "Original blocked-release manifest drift: " + ", ".join(drift))
    original_text = ORIGINAL_NSI.read_text(encoding="utf-8-sig")
    require('!define INSTALLWEBVIEW2MODE ""' in original_text and
            'ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1' in original_text,
            "Original NSIS fallback risk changed; review before testing")

    require(HARDENED_SETUP_SHA256 != "" and HARDENED_NSI_SHA256 != "" and
            HARDENED_SETUP.is_absolute() and HARDENED_NSI.is_absolute(),
            "No pinned hardened wrapper was authorized for runtime")
    require(HARDENED_SETUP.resolve() != ORIGINAL_SETUP.resolve(), "Original unsafe v69 setup forbidden")
    common.expect_digest(HARDENED_SETUP, HARDENED_SETUP_SHA256)
    common.expect_digest(HARDENED_NSI, HARDENED_NSI_SHA256)
    source = HARDENED_NSI.read_text(encoding="utf-8-sig")
    definitions = {"PRODUCTNAME": QA_PRODUCT, "BUNDLEID": QA_APP_ID,
                   "MAINBINARYNAME": QA_EXE[:-4], "INSTALLMODE": "currentUser",
                   "VERSION": "0.2.110"}
    for key, value in definitions.items():
        require(bool(re.search(rf'^!define {key} "{re.escape(value)}"$', source, re.MULTILINE)),
                "Hardened NSIS definition drift: " + key)

    # A 'skip' install mode is NOT sufficient: native Tauri's NSIS template
    # still runs a minimum-version Edge WebView2 updater on this Windows host.
    webview = re.search(r'(?m)^Section WebView2\s*\n(.*?)^SectionEnd\s*$', source, re.DOTALL)
    require(webview is not None and re.fullmatch(r'(?m)(?:\s*;[^\n]*\n|\s*\n)*', webview.group(1)) is not None,
            "Hardened WebView2 section contains executable instructions")
    require(source.count('Section WebView2\n') == 1 and
            source.count('!insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"') == 2,
            "Hardened NSIS app process safeguards drifted")
    for required in (
        'RequestExecutionLevel user',
        'File /a "/oname=pharma_local.db" "D:\\PhD\\Tools\\pharma\\src-tauri\\qa-resource-v02110\\pharma_local.db"',
        'WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"',
        'DeleteRegKey HKCU "${UNINSTKEY}"',
        'Delete "$INSTDIR\\${MAINBINARYNAME}.exe"',
        'Delete "$INSTDIR\\pharma_local.db"',
        'RmDir /r "$APPDATA\\${BUNDLEID}"',
        'RmDir /r "$LOCALAPPDATA\\${BUNDLEID}"',
    ):
        require(required in source, "Hardened NSIS operation drift: " + required)
    require("com.pharma.system" not in source and SIGNED_APP_ID not in source,
            "Hardened NSIS references protected app data")
    helper = HARDENED_NSI.parent / "utils.nsh"
    utility_text = helper.read_text(encoding="utf-8-sig")
    require('nsis_tauri_utils::FindProcessCurrentUser "${executableName}"' in utility_text and
            'nsis_tauri_utils::KillProcessCurrentUser "${executableName}"' in utility_text,
            "Hardened NSIS process helper was modified")
    return {"originalSetupExecuted": False, "originalUnsafeNsisSha256": ORIGINAL_NSI_SHA256,
            "originalWebviewUpdaterFallbackPresent": True,
            "hardenedSetupSha256": HARDENED_SETUP_SHA256,
            "hardenedNsisSourceSha256": HARDENED_NSI_SHA256,
            "qaAppId": QA_APP_ID, "currentUserOnly": True, "webviewSectionEntirelyInert": True,
            "uniqueExecutableProcessName": QA_EXE, "sanitizedSeedOnly": True}


def assert_target_fresh(path: Path) -> None:
    local = Path(os.environ["LOCALAPPDATA"]).resolve()
    require(path.is_absolute() and path.parent.resolve() == local and not path.exists() and
            path.name.startswith("pharma-v69-quickadd-nsis-qa-trial-"),
            "Unsafe, nonfresh, or unexpected QA install target")


def verify_installed(path: Path) -> dict:
    import winreg
    require(path.is_dir() and not path.is_symlink(), "NSIS QA installation directory missing")
    common.expect_digest(path / QA_EXE, QA_EXE_SHA256)
    common.expect_digest(path / "pharma_local.db", QA_SEED_SHA256)
    require((path / "uninstall.exe").is_file(), "QA NSIS uninstaller missing")
    key = reg_product(winreg.HKEY_CURRENT_USER)
    require(key is not None and key["DisplayName"] == QA_PRODUCT and key["DisplayVersion"] == "0.2.110",
            "QA HKCU registry product/version mismatch")
    require(Path(key["InstallLocation"].strip('"')).resolve() == path.resolve() and
            Path(key["UninstallString"].strip('"')).resolve() == (path / "uninstall.exe").resolve(),
            "QA HKCU install/uninstall location mismatch")
    require(reg_product(winreg.HKEY_LOCAL_MACHINE) is None, "QA unexpectedly registered under HKLM")
    return {"installedExeSha256": QA_EXE_SHA256, "installedSeedSha256": QA_SEED_SHA256,
            "installPath": str(path), "scopedHkcuUninstallKey": True, "noHklmProductKey": True}


def verify_uninstalled(path: Path, max_seconds: float = 25.0) -> float:
    import winreg
    began = time.monotonic()
    while path.exists() or reg_product(winreg.HKEY_CURRENT_USER) is not None:
        require(time.monotonic() - began <= max_seconds,
                "Deferred NSIS cleanup did not remove QA install and HKCU key")
        time.sleep(0.15)
    assert_qa_uninstalled()
    return time.monotonic() - began


def exercise() -> dict:
    contract = static_contract()
    before = protected_fingerprint()
    assert_no_qa_process()
    assert_qa_uninstalled()
    target = Path(os.environ["LOCALAPPDATA"]).resolve() / ("pharma-v69-quickadd-nsis-qa-trial-" + uuid.uuid4().hex)
    assert_target_fresh(target)
    evidence_folder = BUILD / ("hardened-runtime-trial-" + uuid.uuid4().hex)
    evidence_folder.mkdir(exist_ok=False)
    report_path = evidence_folder / "V69_HARDENED_NSIS_RUNTIME_EVIDENCE.json"
    report = {"result": "IN_PROGRESS", "actualOriginalV69SetupExecuted": False,
              "productionCustomerReleaseAccepted": False, "hardenedContract": contract,
              "protectedBefore": before, "trialTarget": str(target), "steps": [],
              "signedQaClockComparedSeparately": SIGNED_RUNNING_CLOCK}

    def record(step: str, **detail: object) -> None:
        report["steps"].append({"step": step, **detail})
        report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    record("preflight", qaInstallAbsent=True, qaProfileAbsent=True, hkcuProductAbsent=True)
    for iteration in (1, 2):
        assert_target_fresh(target)
        assert_no_qa_process()
        completion = subprocess.run([str(HARDENED_SETUP), "/S", "/NS", "/CurrentUser", "/D=" + str(target)],
                                    check=False, timeout=150, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        record("install", iteration=iteration, exitCode=completion.returncode)
        require(completion.returncode == 0, "Hardened QA NSIS installer returned nonzero")
        record("verify-installed", iteration=iteration, **verify_installed(target))
        assert_protected_stable(before, protected_fingerprint())
        assert_no_qa_process()
        uninstall = target / "uninstall.exe"
        require(uninstall.is_file() and uninstall.parent.resolve() == target.resolve(),
                "Hardened QA uninstaller is missing or outside isolated target")
        completion = subprocess.run([str(uninstall), "/S"], check=False, timeout=150,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        record("uninstall", iteration=iteration, exitCode=completion.returncode)
        require(completion.returncode == 0, "Hardened QA NSIS uninstaller returned nonzero")
        delay = verify_uninstalled(target)
        record("verify-removed", iteration=iteration, targetAbsent=True,
               hkcuRegistryAbsent=True, qaProfileAbsent=True, cleanupWaitSeconds=round(delay, 3))
        assert_protected_stable(before, protected_fingerprint())

    after = protected_fingerprint()
    assert_protected_stable(before, after)
    report["protectedAfter"] = after
    report["result"] = "PASS_REAL_HARDENED_V69_QA_NSIS_INSTALL_UNINSTALL_REINSTALL_UNINSTALL"
    report["protectedCustomerAndSignedQaStableFilesUnchanged"] = True
    report["signedQaClockChangedDuringTrial"] = (
        before["signedQaProfileFiles"].get(SIGNED_RUNNING_CLOCK)
        != after["signedQaProfileFiles"].get(SIGNED_RUNNING_CLOCK))
    report["entireSignedQaProfileByteIdentical"] = (
        before["signedQaProfileFiles"] == after["signedQaProfileFiles"])
    record("final", protectedCustomerAndSignedQaStableFilesIntact=True)
    report["evidencePath"] = str(report_path)
    return report


if __name__ == "__main__":
    try:
        print(json.dumps(exercise(), sort_keys=True))
    except (OSError, ValueError, common.Refused, subprocess.SubprocessError) as exc:
        print("REFUSED v69 guarded NSIS runtime acceptance: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
