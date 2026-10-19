"""Test-only v0.2.110 *synthetic* QA licensing; never historical ownership.

The issuer lives under Windows CurrentUser DPAPI outside the repository. It is
created once for the separately provisioned, wholly synthetic app identifier.
It cannot grant access to, sign for, or remap real customer history. Secrets
and signed envelopes are never printed. `issue` is opt-in and single-grant.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from scripts.licensing.authority import Authority, _b64url, verify_activation_envelope
from scripts.licensing.local_qa import protect, unprotect
from scripts.qa_v02110_positive_synthetic_bootstrap import IDENTITY, TENANT, ACTOR

FOLDER = "PharmaPositiveV02110TestIssuer"
EXPECTED_SYNTHETIC_SHA = "e41e1a223ece1d75c20561f8f28991a909b6e6be24231697ece8f5744f11c98a"


def location() -> Path:
    if os.name != "nt":
        raise RuntimeError("Windows CurrentUser DPAPI required")
    return Path(os.environ["LOCALAPPDATA"]) / FOLDER


def _state_path() -> Path:
    return location() / "operator.dpapi"


def _put(state: dict, *, initial: bool = False) -> None:
    dest = _state_path()
    temp = location() / "operator.pending.dpapi"
    if temp.exists():
        raise RuntimeError("Interrupted QA issuer update requires review")
    with temp.open("xb") as output:
        output.write(protect(json.dumps(state, separators=(",", ":")).encode("utf8")))
        output.flush()
        os.fsync(output.fileno())
    if initial:
        if dest.exists():
            raise RuntimeError("QA issuer key already provisioned")
        temp.rename(dest)
    else:
        temp.replace(dest)


def _get() -> dict:
    state = json.loads(unprotect(_state_path().read_bytes()).decode("utf8"))
    if state.get("identity") != IDENTITY or state.get("tenant") != TENANT:
        raise RuntimeError("QA license identity mismatch")
    return state


def _key(state: dict) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(base64.urlsafe_b64decode(
        state["seed_b64"] + "=" * (-len(state["seed_b64"]) % 4)))


def _authority(state: dict) -> Authority:
    return Authority(location() / "issuer.sqlite", _key(state),
                     operator_secret=state["operator_token"])


def _public(state: dict) -> str:
    return _b64url(_key(state).public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw))


def inspect_fixture(*, original: bool = True) -> None:
    root = Path(os.environ["APPDATA"]) / IDENTITY
    db_path = root / "pharma_local.db"
    manifest = root / "source.json"
    if not db_path.is_file() or not manifest.is_file() or root.is_symlink():
        raise RuntimeError("Dedicated synthetic QA profile is missing")
    data = json.loads(manifest.read_text(encoding="utf8"))
    if (data.get("app_id"), data.get("tenant"), data.get("actor"),
        data.get("historical_rows_included"), data.get("genuine_customer_ownership_approved")) != (
            IDENTITY, TENANT, ACTOR, False, False):
        raise RuntimeError("Synthetic profile is not approved for QA use")
    with sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        if db.execute("SELECT COUNT(*),MIN(version),MAX(version) FROM _sqlx_migrations WHERE success=1").fetchone() != (67, 1, 67):
            raise RuntimeError("Synthetic profile migrations invalid")
        if db.execute("SELECT COUNT(*),MIN(pharmacy_id),MAX(pharmacy_id) FROM users WHERE role='owner'").fetchone() != (1, TENANT, TENANT):
            raise RuntimeError("No explicit unique synthetic owner")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise RuntimeError("QA synthetic data damaged")
    if original and hashlib.sha256(db_path.read_bytes()).hexdigest() != EXPECTED_SYNTHETIC_SHA:
        raise RuntimeError("Synthetic initial database no longer pinned")


def init() -> dict:
    if os.environ.get("PHARMA_SECURITY_RELEASE_APPROVED"):
        raise RuntimeError("Not permitted in a production release")
    inspect_fixture()
    location().mkdir(mode=0o700, parents=False, exist_ok=False)
    state = {"identity": IDENTITY, "tenant": TENANT,
             "seed_b64": _b64url(secrets.token_bytes(32)),
             "operator_token": secrets.token_urlsafe(40)}
    _put(state, initial=True)
    return {"status": "QA_ONLY_ISSUER_CREATED", "identity": IDENTITY,
            "public_key_b64": _public(state), "customer_authority": False}


def status() -> dict:
    state = _get()
    return {"status": "QA_ONLY_ISSUER", "identity": IDENTITY,
            "public_key_b64": _public(state),
            "signed_grant_present": bool(state.get("grant")),
            "customer_authority": False}


def issue(fingerprint: str) -> dict:
    if os.environ.get("PHARMA_SECURITY_RELEASE_APPROVED"):
        raise RuntimeError("QA cannot issue production licenses")
    inspect_fixture()
    if re.fullmatch(r"[a-f0-9]{64}", fingerprint) is None:
        raise RuntimeError("Require real native fingerprint")
    state = _get()
    if state.get("grant"):
        raise RuntimeError("QA grant already issued; no replacement/replay")
    issuer = _authority(state)
    new = issuer.create_license(
        expires_at_utc=int(time.time()) + 7 * 86400,
        actor_id="positive-v02110-qa-test", operator_token=state["operator_token"])
    # Persist bearer recovery data before it can be used, not in stdout.
    state["grant"] = {"license_id": new["license_id"],
                      "activation_code": new["activation_code"],
                      "fingerprint": fingerprint}
    _put(state)
    result = issuer.activate(
        license_id=new["license_id"], activation_code=new["activation_code"],
        machine_fingerprint=fingerprint, request_nonce=_b64url(secrets.token_bytes(32)),
        requested_at_utc=int(time.time()))
    verified = verify_activation_envelope(result, _public(state),
                                          machine_fingerprint=fingerprint,
                                          now_utc=int(time.time()))
    offline = issuer.convert_to_offline_term(
        license_id=new["license_id"], expected_serial=verified["activation_serial"],
        expected_expires_at_utc=verified["expires_at_utc"],
        actor_id="positive-v02110-qa-test", operator_token=state["operator_token"])
    verify_activation_envelope(offline["activation"], _public(state),
                               machine_fingerprint=fingerprint,
                               now_utc=int(time.time()))
    state["grant"]["offline_envelope"] = offline["activation"]
    _put(state)
    return {"status": "SIGNED_TEST_ONLY_OFFLINE_LICENSE", "identity": IDENTITY,
            "license_verifiable": True, "customer_owner_approved": False,
            "customer_history_approved": False}


def envelope_for_native_bridge() -> dict:
    state = _get()
    if not isinstance(state.get("grant", {}).get("offline_envelope"), dict):
        raise RuntimeError("No persisted signed QA grant")
    return state["grant"]["offline_envelope"]


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["init"]:
            result = init()
        elif sys.argv[1:] == ["status"]:
            result = status()
        elif len(sys.argv) == 3 and sys.argv[1] == "issue":
            result = issue(sys.argv[2])
        else:
            raise RuntimeError("Use init, status, or issue <real native fingerprint>")
        print(json.dumps(result, sort_keys=True))
    except Exception as exc:
        print("POSITIVE SYNTHETIC QA LICENSING REFUSED: " + type(exc).__name__, file=sys.stderr)
        raise SystemExit(2)
