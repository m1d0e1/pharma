"""Read-only, fail-closed selector for the retained v69 unsigned QA NSIS.

Use as the last packaging gate: python -B -m scripts.qa_v02110_v69_nsis_select
The generated Tauri setup is deliberately rejected because its NSIS WebView2
section can update a machine runtime even with `webviewInstallMode: skip`.
No installer, uninstaller, Cargo, NSIS compiler, or application is executed.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

from scripts import qa_v02110_v69_nsis_guarded_runtime as pinned


def require(condition: bool, message: str) -> None:
    if not condition:
        raise pinned.common.Refused(message)


def webview_section(source: str, name: str) -> str:
    sections = re.findall(
        r"(?ms)^Section WebView2[ \t]*\r?\n(.*?)^SectionEnd[ \t]*(?:\r?\n|$)",
        source,
    )
    require(len(sections) == 1, name + " must have exactly one WebView2 section")
    return sections[0]


def verify_webview_guard(generated: str, hardened: str) -> None:
    """Reject changed generator behavior or any active hardened WebView2 code."""
    original_body = webview_section(generated, "Generated NSIS")
    require("ExecWait" in original_body and "needsadmin=true" in original_body,
            "Generated NSIS updater risk changed: refuse without review")
    guarded_body = webview_section(hardened, "Hardened NSIS")
    require(all(not line.strip() or line.lstrip().startswith(";")
                for line in guarded_body.splitlines()),
            "Hardened NSIS has executable WebView2 instructions")
    require('!define INSTALLWEBVIEW2MODE ""' in hardened and
            '!define INSTALLMODE "currentUser"' in hardened and
            "RequestExecutionLevel user" in hardened,
            "Hardened NSIS configuration no longer enforces user-only installation")


def verify_manifest_selection(manifest: dict, requested: Path | None = None) -> Path:
    """Return *only* the exact pinned, unsigned, release-blocked QA package."""
    hardened = pinned.HARDENED_SETUP.resolve(strict=True)
    original = pinned.ORIGINAL_SETUP.resolve(strict=True)
    require(hardened != original, "Hardened NSIS cannot alias unsafe generated setup")
    expected = {
        "release": "NOT_PRODUCTION_READY",
        "classification": "UNSIGNED_DISPOSABLE_QA_ONLY_NOT_PRODUCTION",
        "qaOnly": True,
        "customerDataBundled": False,
        "customerInstallAuthorized": False,
        "commercialOwnerAuthenticated": False,
        "commercialIssuerConfigured": False,
        "commercialLicenseIssued": False,
        "nsisFile": pinned.HARDENED_SETUP.name,
        "nsisSha256": pinned.HARDENED_SETUP_SHA256.upper(),
        "nsisAuthenticode": "NotSigned",
        "exeSha256": pinned.QA_EXE_SHA256.upper(),
        "exeAuthenticode": "NotSigned",
        "retainedTauriGeneratedNsisFile": pinned.ORIGINAL_SETUP.name,
        "retainedTauriGeneratedNsisSha256": pinned.ORIGINAL_SETUP_SHA256.upper(),
        "hardenedNsisSourceSha256": pinned.HARDENED_NSI_SHA256.upper(),
        "webview2RuntimeInstaller": "FULL_SECTION_DISABLED",
        "webview2SectionInert": True,
        "noMachineWebviewUpdatePath": True,
        "nsisInstallMode": "currentUser",
    }
    mismatch = [field for field, value in expected.items() if manifest.get(field) != value]
    require(not mismatch, "QA manifest rejects NSIS selection: " + ", ".join(mismatch))
    require(Path(manifest.get("hardenedNsisSourcePath", "")).resolve(strict=True)
            == pinned.HARDENED_NSI.resolve(strict=True),
            "Manifest hardened NSIS source path changed")
    if requested is not None:
        require(requested.is_absolute(), "Candidate installer path must be absolute")
        require(requested.resolve(strict=True) == hardened,
                "Refused generated or unpinned NSIS; only hardened QA setup is selectable")
    return hardened


def select(requested: Path | None = None) -> dict:
    # This existing static contract pins artifact digests and verifies NSIS
    # process/registry/resource guards. Never call its runtime exercise().
    contract = pinned.static_contract()
    generated = pinned.ORIGINAL_NSI.read_text(encoding="utf-8-sig")
    hardened = pinned.HARDENED_NSI.read_text(encoding="utf-8-sig")
    verify_webview_guard(generated, hardened)
    manifest = json.loads(pinned.MANIFEST.read_text(encoding="utf-8-sig"))
    chosen = verify_manifest_selection(manifest, requested)
    return {
        "decision": "PASS_SELECT_HARDENED_UNSIGNED_QA_ONLY",
        "selectedInstaller": str(chosen),
        "selectedSha256": contract["hardenedSetupSha256"],
        "hardenedNsisSourceSha256": contract["hardenedNsisSourceSha256"],
        "generatedNsisUpdaterRejected": contract["originalWebviewUpdaterFallbackPresent"],
        "webview2InstallerAndUpdaterDisabled": contract["webviewSectionEntirelyInert"],
        "commercialReleaseAllowed": False,
        "installerExecuted": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, help="Explicit installer path to verify; generated setup is refused")
    args = parser.parse_args()
    try:
        print(json.dumps(select(args.candidate), sort_keys=True))
    except (OSError, ValueError, KeyError, pinned.common.Refused) as exc:
        print("REFUSED v69 QA NSIS selection: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
