"""Second, strictly test-only signed synthetic Windows GUI fixture.

Keeps its own disposable app ID, CurrentUser DPAPI password and independent
test Ed25519 issuer. All issuance happens via the existing Authority class and
real machine fingerprint; no commercial key, genuine pharmacy history, or
historical user account may be copied into this profile.

This module reuses the original audited synthetic v67 fixture/issuer routines
in an isolated CLI process, with *only* the QA constants explicitly rebound.
It never modifies the original positive QA profile or its signed grant.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import sys

from scripts import qa_v02110_positive_synthetic_bootstrap as fixture
from scripts import qa_v02110_positive_license as issuer


IDENTITY = "com.pharma.disposable.connectedpositiveqa20261018"
ACTOR = "qa_connected_owner_20261018"
TENANT = "qa_connected_20261018"
SECRET_FOLDER = "PharmaConnectedPositiveQA20261018Credentials"
ISSUER_FOLDER = "PharmaConnectedV02110TestIssuer"


def isolated_qa_constants() -> None:
    fixture.IDENTITY = IDENTITY
    fixture.ACTOR = ACTOR
    fixture.TENANT = TENANT
    fixture.SECRET_FOLDER = SECRET_FOLDER
    issuer.IDENTITY = IDENTITY
    issuer.ACTOR = ACTOR
    issuer.TENANT = TENANT
    issuer.FOLDER = ISSUER_FOLDER
    # This QA test deliberately provisions the previously validated synthetic
    # v67 baseline. If an additive native v68 now exists, the actual licensed
    # Tauri/SQLx startup (not Python) must migrate it, which we can then check.
    def pinned_synthetic_v67_paths(root: Path) -> list[Path]:
        migration_dir = root / "src-tauri" / "migrations"
        all_sql = sorted(migration_dir.glob("[0-9][0-9][0-9]_*.sql"))
        first = [p for p in all_sql if int(p.name[:3]) <= 67]
        if len(first) != 67 or [int(p.name[:3]) for p in first] != list(range(1,68)):
            raise RuntimeError("Original synthetic v67 SQL chain changed")
        if any(p.is_symlink() or not p.is_file() for p in first):
            raise RuntimeError("Untrusted synthetic migration source")
        return first
    fixture._schema_paths = pinned_synthetic_v67_paths
    # Initial source SHA is sealed by the first-run synthetic-only manifest.
    report_path = Path(os.environ["APPDATA"]) / IDENTITY / "source.json"
    if report_path.is_file():
        manifest = json.loads(report_path.read_text(encoding="utf8"))
        if (manifest.get("app_id"), manifest.get("actor"), manifest.get("tenant"),
            manifest.get("synthetic_only"), manifest.get("historical_rows_included"),
            manifest.get("genuine_customer_ownership_approved")) != (
                IDENTITY, ACTOR, TENANT, True, False, False):
            raise RuntimeError("Connected GUI QA manifest identity mismatch")
        value = manifest.get("db_sha256")
        if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
            raise RuntimeError("Connected synthetic fixture SHA unavailable")
        issuer.EXPECTED_SYNTHETIC_SHA = value


def command(action: str, fingerprint: str | None = None) -> dict:
    if os.environ.get("PHARMA_SECURITY_RELEASE_APPROVED"):
        raise RuntimeError("QA fixture forbidden in production release mode")
    isolated_qa_constants()
    if action == "bootstrap":
        return fixture.build_fixture(Path(__file__).resolve().parents[1],
                                     Path(os.environ["APPDATA"]),
                                     Path(os.environ["LOCALAPPDATA"]))
    if action == "issuer-init":
        return issuer.init()
    if action == "issuer-status":
        return issuer.status()
    if action == "issue":
        if fingerprint is None or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            raise RuntimeError("Actual native machine fingerprint required")
        return issuer.issue(fingerprint)
    raise RuntimeError("Only bootstrap, issuer-init, issuer-status, issue allowed")


def offline_envelope() -> dict:
    isolated_qa_constants()
    return issuer.envelope_for_native_bridge()


def secret() -> dict:
    isolated_qa_constants()
    return fixture.get_secret()


if __name__ == "__main__":
    try:
        if len(sys.argv) not in (2,3):
            raise RuntimeError("QA fixture command required")
        result = command(sys.argv[1], sys.argv[2] if len(sys.argv)==3 else None)
        if result.get("qa_identity") not in (None, IDENTITY):
            raise RuntimeError("Synthetic fixture returned unexpected identity")
        print(json.dumps(result,sort_keys=True))
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print("CONNECTED SYNTHETIC QA REFUSED: " + type(error).__name__,file=sys.stderr)
        raise SystemExit(2)
