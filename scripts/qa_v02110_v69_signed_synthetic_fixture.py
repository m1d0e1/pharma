"""Distinct, private test-only v69 finance owner and Ed25519 QA issuer.

This code creates only a new synthetic SQLx v67 base for the v69 native app to
migrate on *its own first launch*. No legacy/customer rows or old QA identity
are used. All credentials remain in DPAPI-protected files under QA_ROOT.
No native app/installer is launched here.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys

from scripts import qa_v02110_positive_synthetic_bootstrap as fixture
from scripts import qa_v02110_positive_license as issuer


QA_ROOT = Path(r"D:\PhD\Tools\pharma-builds\v02110-v069-signed-synthetic-finance-qa-20261018")
IDENTITY = "com.pharma.disposable.v069syntheticfinanceqa20261018"
ACTOR = "qa_v069_finance_owner_20261018"
TENANT = "qa_v069_finance_20261018"
OWNER_FOLDER = QA_ROOT / "test-owner-credentials"
ISSUER_FOLDER = QA_ROOT / "test-license-issuer"


def isolated_constants() -> None:
    if os.environ.get("PHARMA_SECURITY_RELEASE_APPROVED"):
        raise RuntimeError("Never create synthetic issuer in production-approved environment")
    fixture.IDENTITY, fixture.ACTOR, fixture.TENANT = IDENTITY, ACTOR, TENANT
    fixture.SECRET_FOLDER = str(OWNER_FOLDER)
    issuer.IDENTITY, issuer.ACTOR, issuer.TENANT = IDENTITY, ACTOR, TENANT
    issuer.FOLDER = str(ISSUER_FOLDER)

    def pinned_v67_schema(root: Path) -> list[Path]:
        all_sql = sorted((root / "src-tauri" / "migrations").glob("[0-9][0-9][0-9]_*.sql"))
        matched = [file for file in all_sql if int(file.name[:3]) <= 67]
        if len(matched) != 67 or [int(file.name[:3]) for file in matched] != list(range(1, 68)):
            raise RuntimeError("Exact disposable 001..067 native migration chain required")
        if any(file.is_symlink() or not file.is_file() for file in matched):
            raise RuntimeError("Disallowed migration path indirection")
        return matched

    fixture._schema_paths = pinned_v67_schema
    source = Path(os.environ["APPDATA"]) / IDENTITY / "source.json"
    if source.is_file():
        manifest = json.loads(source.read_text(encoding="utf-8"))
        expected = (IDENTITY, ACTOR, TENANT, True, False, False)
        actual = tuple(manifest.get(key) for key in
                       ("app_id", "actor", "tenant", "synthetic_only",
                        "historical_rows_included", "genuine_customer_ownership_approved"))
        if actual != expected or not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get("db_sha256"))):
            raise RuntimeError("New v69 synthetic source manifest custody failed")
        issuer.EXPECTED_SYNTHETIC_SHA = manifest["db_sha256"]


def command(action: str, fingerprint: str | None = None) -> dict:
    isolated_constants()
    if action == "bootstrap":
        if not QA_ROOT.is_dir() or QA_ROOT.is_symlink():
            raise RuntimeError("QA root missing or linked")
        return fixture.build_fixture(Path(__file__).resolve().parents[1],
                                     Path(os.environ["APPDATA"]),
                                     Path(os.environ["LOCALAPPDATA"]))
    if action == "issuer-init":
        return issuer.init()
    if action == "issuer-status":
        return issuer.status()
    if action == "issue":
        if not fingerprint or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            raise RuntimeError("Actual native fingerprint required; never invent one")
        return issuer.issue(fingerprint)
    raise RuntimeError("Only bootstrap, issuer-init, issuer-status, issue commands permitted")


def offline_envelope() -> dict:
    isolated_constants()
    return issuer.envelope_for_native_bridge()


def owner_secret() -> dict:
    isolated_constants()
    return fixture.get_secret()


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (2, 3):
            raise RuntimeError("Expected one QA fixture subcommand")
        report = command(sys.argv[1], sys.argv[2] if len(sys.argv) == 3 else None)
        if report.get("qa_identity") not in (None, IDENTITY):
            raise RuntimeError("QA fixture identity changed")
        print(json.dumps(report, sort_keys=True))
    except (OSError, RuntimeError, ValueError, KeyError) as failure:
        print("SIGNED SYNTHETIC V69 QA REFUSED: " + type(failure).__name__, file=sys.stderr)
        raise SystemExit(2)
