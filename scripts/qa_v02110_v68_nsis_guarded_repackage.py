"""Compile a separate, customer-safe QA-only NSIS wrapper for pinned v68 bytes.

Uses the retained v68 executable and generated v68 NSIS source, never current
dirty/rebuilding Rust/Next output. Rewrites the QA installer to install under a
unique process filename, per-user registry/path context, and without WebView2
machine updates. Keeps the original v68 package and generated sources intact.
Does NOT launch either installer, app, or uninstaller.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

from scripts import qa_v02110_v68_nsis_isolation as original


QA_EXE_BASENAME = "pharma-v68-primary-qa"
QA_PRODUCT = "Pharma 0.2.110 Primary V68 Isolated NSIS QA"
QA_SETUP = "Pharma-0.2.110-V68-ISOLATED-UNSIGNED-QA-x64-setup.exe"
NSIS_COMPILER = Path(os.environ.get("LOCALAPPDATA", "")) / "tauri" / "NSIS" / "Bin" / "makensis.exe"


def replace_one(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise original.Refused("Expected exactly one generated NSIS source operation: " + old[:75])
    return text.replace(old, new, 1)


def guarded_source(source: str) -> str:
    """Return isolated QA-only NSIS with no generic executable process name."""
    original.inspect_artifacts()
    original.inspect_nsis(source, (original.RETAINED_NSI / "utils.nsh").read_text(encoding="utf-8-sig"))
    source = replace_one(source, '!define MAINBINARYNAME "pharma"',
                         f'!define MAINBINARYNAME "{QA_EXE_BASENAME}"')
    source = replace_one(source, f'!define PRODUCTNAME "{original.PRODUCT}"',
                         f'!define PRODUCTNAME "{QA_PRODUCT}"')
    source = replace_one(source, '!define INSTALLMODE "both"',
                         '!define INSTALLMODE "currentUser"')
    path = str(original.PACKAGE / original.EXECUTABLE)
    path_pattern = r'!define MAINBINARYSRCPATH "[^"]+"'
    hits = re.findall(path_pattern, source)
    if len(hits) != 1:
        raise original.Refused("Cannot uniquely rebind embedded v68 executable")
    source = replace_one(source, hits[0], '!define MAINBINARYSRCPATH "' + path + '"')
    source = replace_one(source, '  File "${MAINBINARYSRCPATH}"',
                         '  File /oname=${MAINBINARYNAME}.exe "${MAINBINARYSRCPATH}"')
    # Never depend on mutable target/debug/nsis files after another build.
    external_language = '!include "' + str(original.PROJECT / "src-tauri" / "target" / "debug" / "nsis" / "x64" / "English.nsh") + '"'
    source = replace_one(source, external_language, '!include "English.nsh"')
    # WebView2 runtime has its own system-level installer/update side effects.
    # Keep QA install entirely file/registry scoped; a machine with insufficient
    # runtime will refuse QA app launch rather than mutate the Windows runtime.
    start = source.find('Section WebView2\n')
    end = source.find('SectionEnd', start)
    if start < 0 or end < 0 or source.count('Section WebView2\n') != 1:
        raise original.Refused("Unexpected generated WebView2 section")
    section = source[start:end + len('SectionEnd')]
    if 'ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install"' not in section:
        raise original.Refused("Expected WebView2 embedded bootstrapper call missing")
    source = source[:start] + 'Section WebView2\n  ; QA only: skip global runtime installation/update.\nSectionEnd' + source[end + len('SectionEnd'):]
    inspect_guarded(source)
    return source


def inspect_guarded(source: str) -> dict:
    expected = {
        "MAINBINARYNAME": QA_EXE_BASENAME,
        "PRODUCTNAME": QA_PRODUCT,
        "BUNDLEID": original.QA_ID,
        "INSTALLMODE": "currentUser",
    }
    for name, value in expected.items():
        if not re.search(rf'^!define {name} "{re.escape(value)}"$', source, re.MULTILINE):
            raise original.Refused("Guarded NSIS definition drift: " + name)
    for clause in (
        '  File /oname=${MAINBINARYNAME}.exe "${MAINBINARYSRCPATH}"',
        'File /a "/oname=pharma_local.db" "D:\\PhD\\Tools\\pharma\\src-tauri\\qa-resource-v02110\\pharma_local.db"',
        'Delete "$INSTDIR\\${MAINBINARYNAME}.exe"',
        'Delete "$INSTDIR\\pharma_local.db"',
        'RmDir /r "$APPDATA\\${BUNDLEID}"',
        'RmDir /r "$LOCALAPPDATA\\${BUNDLEID}"',
        'Section WebView2\n  ; QA only: skip global runtime installation/update.\nSectionEnd',
    ):
        original.contains_exact(source, clause)
    if source.count('!insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"') != 2:
        raise original.Refused("QA process custody guard changed")
    if 'ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install"' in source:
        raise original.Refused("Guarded QA package still includes WebView2 bootstrapper execution")
    if source.count('!define MAINBINARYSRCPATH "' + str(original.PACKAGE / original.EXECUTABLE) + '"') != 1:
        raise original.Refused("QA executable no longer points to archived immutable v68")
    return {
        "qaOnly": True,
        "installedProcessExecutable": QA_EXE_BASENAME + ".exe",
        "processHelperNowTargetsUniqueQaFilename": True,
        "installModeCurrentUser": True,
        "installerRequestsAdmin": False,
        "webView2InstallationCodeRemoved": True,
        "sanitizedResourcePreserved": True,
        "originalV68ArtifactsUnchanged": True,
        "originalV68InstallerExecuted": False,
        "guardedRepackageInstallerExecuted": False,
    }


def build() -> dict:
    if os.name != "nt":
        raise original.Refused("Compiling a Windows NSIS QA wrapper requires Windows")
    original.inspect_protected_state()
    original.expect_digest(original.PACKAGE / original.EXECUTABLE, original.SHA[original.EXECUTABLE])
    if not NSIS_COMPILER.is_file():
        raise original.Refused("Pinned local NSIS compiler unavailable")
    source_root = original.RETAINED_NSI
    source = (source_root / "installer.nsi").read_text(encoding="utf-8-sig")
    transformed = guarded_source(source)
    original.EVIDENCE_PARENT.mkdir(exist_ok=True)
    folder = original.EVIDENCE_PARENT / ("guarded-build-" + uuid.uuid4().hex)
    folder.mkdir(exist_ok=False)
    compile_dir = folder / "nsis-source"
    compile_dir.mkdir()
    for name in ("utils.nsh", "FileAssociation.nsh", "English.nsh"):
        source_file = source_root / name
        if not source_file.is_file() or source_file.is_symlink():
            raise original.Refused("Missing NSIS helper source: " + name)
        shutil.copyfile(source_file, compile_dir / name)
    staged = compile_dir / "installer.nsi"
    staged.write_text(transformed, encoding="utf-8", newline="\n")

    completed = subprocess.run([str(NSIS_COMPILER), "/V2", str(staged)],
                               cwd=compile_dir, capture_output=True, text=True,
                               timeout=180, check=False,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    (folder / "NSIS_COMPILER_OUTPUT.txt").write_text(
        f"exit_code={completed.returncode}\n" + completed.stdout + completed.stderr,
        encoding="utf-8",
    )
    built = compile_dir / "nsis-output.exe"
    if completed.returncode != 0 or not built.is_file():
        raise original.Refused("QA-only NSIS compile failed; see retained compiler output")
    final_installer = folder / QA_SETUP
    built.replace(final_installer)
    guarded_hash = original.sha256(final_installer)
    report = {
        "result": "PASS_SEPARATE_GUARDED_V68_QA_NSIS_COMPILE_ONLY",
        "originalPackagePath": str(original.PACKAGE),
        "originalV68SetupSha256": original.SHA[original.INSTALLER],
        "originalV68ExecutableSha256": original.SHA[original.EXECUTABLE],
        "guardedNsisSha256": guarded_hash,
        "guardedNsisSourceSha256": hashlib.sha256(staged.read_bytes()).hexdigest(),
        "guardedInstallerPath": str(final_installer),
        "runtimeInstallUninstallAccepted": False,
        "customerApprovedProductionInstall": False,
        "contract": inspect_guarded(transformed),
        "protectedCustomerDatabaseSha256BeforeAndAfter": original.SHA["installed_customer"],
    }
    after = original.inspect_protected_state()
    if after["installedCustomerDbSHA256"] != original.SHA["installed_customer"]:
        raise original.Refused("Protected database changed during guarded NSIS compilation")
    with (folder / "V68_GUARDED_QA_ONLY.json").open("x", encoding="utf-8") as out:
        json.dump(report, out, indent=2, sort_keys=True)
        out.write("\n")
    return report


if __name__ == "__main__":
    try:
        print(json.dumps(build(), sort_keys=True))
    except (OSError, ValueError, original.Refused, subprocess.SubprocessError) as exc:
        print("REFUSED guarded v68 NSIS QA repackage: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
