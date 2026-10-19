"""Pinned, fail-closed v68 NSIS inspection and disposable offline rollback drill.

Never invokes the installer/uninstaller, opens the customer SQLite database with
SQLite, edits installed app/profile files, or writes any Windows registry key.
The installer actually invokes a global pharma.exe process-kill helper, which
makes a live trial unsafe while this workstation retains the customer install.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid


PROJECT = Path(__file__).resolve().parent.parent
PACKAGE = PROJECT.parent / "pharma-builds" / (
    "v02110-primary-pharmacy-v68-guarded-b501dd37754e4f6b8f7d82ce75190615"
)
EVIDENCE_PARENT = PROJECT.parent / "pharma-builds" / "v02110-v68-nsis-isolation-evidence"
RETAINED_NSI = EVIDENCE_PARENT / "retained-generated-v68-nsis"
QA_ID = "com.pharma.disposable.primarytenantqa20261018"
PRODUCT = "Pharma 0.2.110 Primary Pharmacy Guarded QA"
INSTALLER = "Pharma-0.2.110-PRIMARY-PHARMACY-V68-QA-unsigned-x64-setup.exe"
EXECUTABLE = "Pharma-0.2.110-PRIMARY-PHARMACY-V68-GUARDED-QA-only.exe"
SHA = {
    INSTALLER: "26695fb5d8a3ceaef72f02f232fabe3a2f88d90b2ce94b0c27891e11e0413927",
    EXECUTABLE: "0e306f28d1126b057cbcb90cbbc06496f35deae429c1f5f26a85f4ae363edf18",
    "installer.nsi": "7958d11527e987f38cb0358bcddd2fd50a8485ca9c2625ed887805c539dc65a2",
    "utils.nsh": "fd766caf19dd635793d14e7a4247c454fbf7a179d50b80947845e0abb30cf35f",
    "FileAssociation.nsh": "e933990b06dceac358fc1a4e71cb55c7dc9783ad4df8fc2c6248118a7ad4d348",
    "English.nsh": "79c5775a167222dd72eda103861d55581cddc58735d65f535a3dead9320c537c",
    "sanitized": "2602d9c5d24078cec4dbe5066ff9df71223738e84733747746ff3c55e0678af9",
    "repository_seed": "8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3",
    "installed_customer": "4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197",
}


class Refused(RuntimeError):
    """Unsafe or changed evidence; stop before copying even disposable data."""


def sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def expect_digest(path: Path, expected: str) -> None:
    if not path.is_file() or path.is_symlink() or sha256(path) != expected:
        raise Refused("Pinned QA artifact or protected installed database changed: " + path.name)


def contains_exact(source: str, needle: str) -> None:
    if needle not in source:
        raise Refused("Generated NSIS contract drift: " + needle[:75])


def inspect_nsis(installer: str, utility: str) -> dict:
    """Statically check the pinned source's actual side-effect and collision paths."""
    definitions = {
        "PRODUCTNAME": PRODUCT,
        "BUNDLEID": QA_ID,
        "VERSION": "0.2.110",
        "INSTALLMODE": "both",
        "MAINBINARYNAME": "pharma",
        "INSTALLWEBVIEW2MODE": "embedBootstrapper",
    }
    for name, value in definitions.items():
        if not re.search(rf'^!define {name} "{re.escape(value)}"$', installer, re.MULTILINE):
            raise Refused("Unexpected generated NSIS identifier/configuration: " + name)
    required = [
        '!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCTNAME}"',
        '!define MANUPRODUCTKEY "${MANUKEY}\\${PRODUCTNAME}"',
        '!define MULTIUSER_INSTALLMODE_COMMANDLINE',
        '!define MULTIUSER_EXECUTIONLEVEL Highest',
        '!insertmacro MULTIUSER_INIT',
        '!insertmacro MULTIUSER_UNINIT',
        'File /a "/oname=pharma_local.db" "D:\\PhD\\Tools\\pharma\\src-tauri\\qa-resource-v02110\\pharma_local.db"',
        'WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"',
        'WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString"',
        'DeleteRegKey SHCTX "${UNINSTKEY}"',
        'Delete "$INSTDIR\\${MAINBINARYNAME}.exe"',
        'Delete "$INSTDIR\\pharma_local.db"',
        'RMDir "$INSTDIR"',
        'RmDir /r "$APPDATA\\${BUNDLEID}"',
        'RmDir /r "$LOCALAPPDATA\\${BUNDLEID}"',
    ]
    for statement in required:
        contains_exact(installer, statement)
    process_macro = '!insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"'
    if installer.count(process_macro) != 2:
        raise Refused("Expected two install/uninstall process-collision gates")
    contains_exact(utility, 'nsis_tauri_utils::FindProcess "${executableName}"')
    contains_exact(utility, 'nsis_tauri_utils::KillProcess "${executableName}"')
    # INSTALLMODE=both invokes the global, cross-user branch. A unique app ID
    # does not protect an unrelated customer pharma.exe from this macro.
    if "!insertmacro CheckIfAppIsRunning" not in installer:
        raise Refused("Unexpected process helper configuration")
    return {
        "qaAppId": QA_ID,
        "nsisInstallMode": "both",
        "highestExecutionLevel": True,
        "canInstallWebView2GloballyIfMissingOrOld": True,
        "registryUninstallKeyScopedToProductName": True,
        "resourceBundledFromSanitizedSeed": True,
        "uninstallAppDataRootUsesQaAppId": True,
        "globalSameFilenameProcessKillDuringInstallAndUninstall": True,
        "installerRuntimeMayTouchCustomerProcess": True,
        "safeToRunOnCustomerWorkstation": False,
    }


def inspect_protected_state() -> dict:
    if os.name != "nt":
        raise Refused("Windows host required for installed-profile custody")
    roaming = Path(os.environ["APPDATA"])
    local = Path(os.environ["LOCALAPPDATA"])
    customer = roaming / "com.pharma.system" / "pharma_local.db"
    expect_digest(customer, SHA["installed_customer"])
    attrs = customer.stat()
    sidecars = [str(customer) + suffix for suffix in ("-wal", "-shm", "-journal")]
    if any(Path(path).exists() for path in sidecars):
        raise Refused("Protected SQLite source has sidecars; no offline byte-level baseline")

    import winreg  # Windows only; read operations only.

    existing_registry = []
    product_key = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + PRODUCT
    for hive, label in ((winreg.HKEY_CURRENT_USER, "HKCU"),
                        (winreg.HKEY_LOCAL_MACHINE, "HKLM")):
        try:
            with winreg.OpenKey(hive, product_key, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY):
                existing_registry.append(label)
        except FileNotFoundError:
            pass
    qa_roots = (
        roaming / QA_ID,
        local / QA_ID,
        local / PRODUCT,
        local / "Programs" / PRODUCT,
        Path(os.environ["ProgramFiles"]) / PRODUCT,
    )
    if existing_registry or any(path.exists() for path in qa_roots):
        raise Refused("QA product installation/profile already exists; cannot presume an unused lifecycle target")
    return {
        "installedCustomerDbSHA256": SHA["installed_customer"],
        "installedCustomerDbSize": attrs.st_size,
        "installedCustomerDbMtimeNs": attrs.st_mtime_ns,
        "customerSQLiteOpened": False,
        "customerSourceSidecarsPresent": False,
        "qaInstallRegistryKeysPresent": existing_registry,
        "qaInstallOrProfileDirectoriesPresent": False,
    }


def inspect_artifacts() -> dict:
    nsi = RETAINED_NSI / "installer.nsi"
    nsh = nsi.parent / "utils.nsh"
    seed = PROJECT / "src-tauri" / "qa-resource-v02110" / "pharma_local.db"
    repo_seed = PROJECT / "src-tauri" / "pharma_local.db"
    paths = {
        INSTALLER: PACKAGE / INSTALLER,
        EXECUTABLE: PACKAGE / EXECUTABLE,
        "installer.nsi": nsi,
        "utils.nsh": nsh,
        "FileAssociation.nsh": RETAINED_NSI / "FileAssociation.nsh",
        "English.nsh": RETAINED_NSI / "English.nsh",
        "sanitized": seed,
        "repository_seed": repo_seed,
    }
    for name, path in paths.items():
        expect_digest(path, SHA[name])
    manifest = json.loads((PACKAGE / "QA_ONLY_RELEASE_BLOCKED.json").read_text(encoding="utf-8-sig"))
    required = {
        "release": "NOT_PRODUCTION_READY",
        "qaOnly": True,
        "appId": QA_ID,
        "nativeSqlxMigrationCount": 68,
        "permanentTenant": "primary_pharmacy",
        "installerAuthenticode": "NotSigned",
        "originalInstalledDataIncluded": False,
        "executableFile": EXECUTABLE,
        "installerFile": INSTALLER,
        "executableSha256": SHA[EXECUTABLE].upper(),
        "installerSha256": SHA[INSTALLER].upper(),
    }
    if any(manifest.get(key) != value for key, value in required.items()):
        raise Refused("Retained blocked-release manifest changed")
    return inspect_nsis(nsi.read_text(encoding="utf-8-sig"), nsh.read_text(encoding="utf-8-sig"))


def _within(path: Path, root: Path) -> bool:
    try:
        return path.resolve().is_relative_to(root.resolve())
    except (ValueError, OSError):
        return False


def offline_clone_rollback(evidence: Path) -> dict:
    """Model exact QA payload install/delete and byte-perfect rollback in a new folder."""
    install = evidence / "simulation" / "install"
    rollback = evidence / "simulation" / "rollback"
    if not (_within(install, evidence) and _within(rollback, evidence)):
        raise Refused("Non-isolated disposable simulation directory")
    install.mkdir(parents=True, exist_ok=False)
    rollback.mkdir(parents=True, exist_ok=False)
    seed = PROJECT / "src-tauri" / "qa-resource-v02110" / "pharma_local.db"
    original = PACKAGE / EXECUTABLE
    installed_db = install / "pharma_local.db"
    installed_exe = install / "pharma.exe"
    preserved = rollback / "pharma_local.db"
    shutil.copyfile(seed, preserved)
    shutil.copyfile(seed, installed_db)
    shutil.copyfile(original, installed_exe)
    for path, expected in ((preserved, SHA["sanitized"]),
                           (installed_db, SHA["sanitized"]),
                           (installed_exe, SHA[EXECUTABLE])):
        expect_digest(path, expected)

    # The corrupt byte is deliberately added to the disposable install copy;
    # restoring its retained snapshot tests rollback byte-for-byte.
    with installed_db.open("ab") as output:
        output.write(b"qa-disposable-rollback-fixture-v68")
    if sha256(installed_db) == SHA["sanitized"]:
        raise Refused("Rollback injection did not change the disposable file")
    staged_restore = install / "pharma_local.db.rollback-temp"
    shutil.copyfile(preserved, staged_restore)
    staged_restore.replace(installed_db)
    expect_digest(installed_db, SHA["sanitized"])

    for path in (installed_db, installed_exe):
        if not _within(path, evidence) or not path.is_file() or path.is_symlink():
            raise Refused("Simulated uninstall path escaped dedicated evidence root")
        path.unlink()
    install.rmdir()
    if install.exists():
        raise Refused("Simulated uninstall left install files")
    expect_digest(preserved, SHA["sanitized"])
    expect_digest(seed, SHA["sanitized"])
    expect_digest(original, SHA[EXECUTABLE])
    return {
        "modelOnly": True,
        "actualNsisInstallerInvoked": False,
        "actualNsisUninstallerInvoked": False,
        "payloadSha256MatchesRetainedArtifacts": True,
        "disposableInstalledCloneModifiedForRollback": True,
        "rollbackRestoredExactSanitizedSeed": True,
        "simulatedUninstallRemovedOnlyDisposableInstalledFiles": True,
        "rollbackSnapshotRetained": str(preserved),
    }


def verify() -> dict:
    contract = inspect_artifacts()
    before = inspect_protected_state()
    if EVIDENCE_PARENT.exists() and (EVIDENCE_PARENT.is_symlink() or
                                     not EVIDENCE_PARENT.is_dir()):
        raise Refused("Evidence root is not an ordinary directory")
    EVIDENCE_PARENT.mkdir(exist_ok=True)
    evidence = EVIDENCE_PARENT / ("run-" + uuid.uuid4().hex)
    evidence.mkdir(exist_ok=False)
    drill = offline_clone_rollback(evidence)
    after = inspect_protected_state()
    if before != after:
        raise Refused("Protected customer database/registry/profile metadata changed during inspection")
    report = {
        "result": "PASS_PINNED_V68_STATIC_AND_DISPOSABLE_MODEL_ONLY",
        "liveInstallUninstallRollbackAcceptance": False,
        "reasonLiveTrialWithheld": "Compiled NSIS uses global pharma.exe FindProcess/KillProcess and may update system WebView2",
        "commercialReleaseAccepted": False,
        "packagePath": str(PACKAGE),
        "artifactHashesSha256": {key: SHA[key] for key in (INSTALLER, EXECUTABLE, "installer.nsi", "utils.nsh", "FileAssociation.nsh", "English.nsh", "sanitized")},
        "nsisContract": contract,
        "protectedBeforeAndAfterIdentical": True,
        "protectedSnapshot": before,
        "offlineLifecycle": drill,
    }
    path = evidence / "V68_NSIS_QA_ONLY_VERIFICATION.json"
    with path.open("x", encoding="utf-8") as out:
        json.dump(report, out, indent=2, sort_keys=True)
        out.write("\n")
    report["evidencePath"] = str(path)
    return report


if __name__ == "__main__":
    try:
        print(json.dumps(verify(), sort_keys=True))
    except (OSError, ValueError, Refused, json.JSONDecodeError) as exc:
        print("REFUSED v68 NSIS isolation verification: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
