"""Opt-in, independent test-only issuer for the *new* lifecycle QA app.

No state is created on import, `status`, or `public-key`. `init` creates a NEW
DPAPI-wrapped Ed25519 signing seed/operator token under a dedicated folder in
LOCALAPPDATA, never in source control. `grant` binds to a supplied native
fingerprint, issues ONE auditable license, and DPAPI-seals the offline signed
envelope; it never prints a private key, bearer activation code or envelope.

This is not an installer. A separately configured/licensed QA binary and a
reviewed native license-install workflow are required before it can launch.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .authority import Authority, Rejected, verify_activation_envelope, _b64url
from .local_qa import protect, unprotect
from scripts.qa_lifecycle_fixture import APP_ID, verify_fixture


ISSUER_DIRECTORY = "PharmaLifecycleQA20261016Issuer"
ACTOR = "disposable-lifecycle-qa"


def operator_directory() -> Path:
    if os.name != "nt" or not os.environ.get("LOCALAPPDATA"):
        raise RuntimeError("Windows CurrentUser-DPAPI is mandatory for lifecycle QA issuer")
    return Path(os.environ["LOCALAPPDATA"]) / ISSUER_DIRECTORY


def _file_path() -> Path:
    return operator_directory() / "operator.dpapi"


def _state() -> dict:
    raw = unprotect(_file_path().read_bytes())
    state = json.loads(raw)
    if state.get("identity") != APP_ID:
        raise RuntimeError("Existing issuer belongs to a different QA identity")
    return state


def _write(state: dict, *, initial: bool = False) -> None:
    directory = operator_directory()
    encoded = protect(json.dumps(state, separators=(",", ":")).encode("utf-8"))
    if initial:
        directory.mkdir(exist_ok=False, parents=False)
        with _file_path().open("xb") as output:
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        return
    pending = directory / "operator.pending.dpapi"
    with pending.open("xb") as output:
        output.write(encoded)
        output.flush()
        os.fsync(output.fileno())
    pending.replace(_file_path())


def _authority(state: dict) -> Authority:
    key = Ed25519PrivateKey.from_private_bytes(
        base64.urlsafe_b64decode(state["seed_b64"] + "=" * (-len(state["seed_b64"]) % 4))
    )
    return Authority(operator_directory() / "issuer.sqlite", key,
                     operator_secret=state["operator_token"])


def init() -> dict:
    if os.environ.get("PHARMA_SECURITY_RELEASE_APPROVED"):
        raise RuntimeError("Never initialize test issuer in a release-approved environment")
    folder = operator_directory()
    if folder.exists():
        raise RuntimeError("Issuer directory exists: refuse reset, key rotation or grant reuse")
    state = {"identity": APP_ID, "seed_b64": _b64url(secrets.token_bytes(32)),
             "operator_token": secrets.token_urlsafe(40)}
    _write(state, initial=True)
    authority = _authority(state)
    return {"status": "initialized", "identity": APP_ID,
            "test_only": True, "issuer_public_key_b64": authority.issuer_public_key_b64}


def status() -> dict:
    state = _state()
    authority = _authority(state)
    credential = state.get("credential")
    return {"identity": APP_ID, "test_only": True,
            "issuer_public_key_b64": authority.issuer_public_key_b64,
            "grant_state": "signed-offline-term" if credential and credential.get("offline_grant")
            else "needs-review" if credential else "not-issued",
            "license_id": credential.get("license_id") if credential else None}


def grant(*, fingerprint: str, days: int, profile_parent: Path) -> dict:
    if os.environ.get("PHARMA_SECURITY_RELEASE_APPROVED"):
        raise RuntimeError("Never issue a QA grant in release-approved environment")
    if not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        raise ValueError("Use actual 64-character lowercase fingerprint from the NEW QA binary")
    if not 1 <= days <= 14:
        raise ValueError("Disposable QA grant duration is limited to 1..14 days")
    state = _state()
    if "credential" in state:
        raise RuntimeError("Issuer already has a grant/partial grant: review, never mint another")
    verified = verify_fixture(profile_parent)  # read-only, exact new app identity
    if verified["app_id"] != APP_ID:
        raise ValueError("Fixture identity differs from new QA binary")
    authority = _authority(state)
    created = authority.create_license(
        expires_at_utc=int(time.time()) + days * 86400,
        operator_token=state["operator_token"], actor_id=ACTOR,
    )
    # Persist credential BEFORE activation; a crash cannot discard the bearer
    # while leaving an untracked licensed serial. Never log credential data.
    state["credential"] = {"license_id": created["license_id"],
                           "activation_code": created["activation_code"],
                           "machine_fingerprint": fingerprint}
    _write(state)
    lease = authority.activate(
        license_id=created["license_id"], activation_code=created["activation_code"],
        machine_fingerprint=fingerprint, request_nonce=_b64url(secrets.token_bytes(32)),
        requested_at_utc=int(time.time()),
    )
    verified_lease = verify_activation_envelope(
        lease, authority.issuer_public_key_b64,
        machine_fingerprint=fingerprint, now_utc=int(time.time()),
        license_id=created["license_id"],
    )
    offline = authority.convert_to_offline_term(
        license_id=created["license_id"], expected_serial=verified_lease["activation_serial"],
        expected_expires_at_utc=verified_lease["expires_at_utc"], actor_id=ACTOR,
        operator_token=state["operator_token"],
    )
    claims = verify_activation_envelope(
        offline["activation"], authority.issuer_public_key_b64,
        machine_fingerprint=fingerprint, now_utc=int(time.time()),
        license_id=created["license_id"],
    )
    if claims.get("offline_term") is not True or claims.get("lease_until_utc") is not None:
        raise RuntimeError("Signed offline license failed native-equivalent checks")
    state["credential"]["offline_grant"] = offline["activation"]
    _write(state)
    return {"status": "signed-offline-term", "identity": APP_ID,
            "license_id": created["license_id"],
            "activation_serial": claims["activation_serial"],
            "expires_at_utc": claims["expires_at_utc"],
            "test_only": True, "signed_envelope_does_not_leave_DPAPI_state": True}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Lifecycle QA-only Ed25519 operator")
    parser.add_argument("command", choices=("init", "status", "public-key", "grant"))
    parser.add_argument("--fingerprint", default="", help="Use native license_status fingerprint from NEW QA binary")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--profile-parent", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            result = init()
        elif args.command == "status":
            result = status()
        elif args.command == "public-key":
            result = {"identity": APP_ID, "issuer_public_key_b64": status()["issuer_public_key_b64"]}
        else:
            if args.profile_parent is None:
                parser.error("grant requires --profile-parent pointing to the new QA profile")
            result = grant(fingerprint=args.fingerprint, days=args.days,
                           profile_parent=args.profile_parent)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (RuntimeError, ValueError, OSError, KeyError, Rejected) as exc:
        print("Lifecycle QA issuer refused operation: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
