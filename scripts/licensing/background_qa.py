"""Persistent, separate issuer for the 2026-10-15 disposable background QA app.

This operator has its own Windows DPAPI-protected signing seed and SQLite
serial/nonce ledger. It is NOT the old 2026-10-14 BG issuer, a production
issuer, or a way to install a differently signed grant in the old binary.

Run as a module, from the repository root. Never publish the operator DPAPI
blob, activation credential, or output signed envelopes to source control.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import sys
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .authority import Authority, Rejected, _b64url, verify_activation_envelope
from .local_qa import protect, unprotect, init_local_tls, verify_local_tls


IDENTIFIER = "com.pharma.disposable.qa20261015renewable"
ISSUER_DIRECTORY = "PharmaBgRenewable20261015Issuer"
LOCAL_HTTPS_PORT = 18766  # Never reuse the distinct PharmaLicenseQAOperator port.
EXISTING_QA_TRANSPORT_LEAF_SHA1 = "B958096C1F1767E93DC5E01880137A24AA5AFDF1"


def directory() -> Path:
    if os.name != "nt" or not os.environ.get("LOCALAPPDATA"):
        raise RuntimeError("Disposable BG issuer requires a Windows user profile")
    return Path(os.environ["LOCALAPPDATA"]) / ISSUER_DIRECTORY


def state_path() -> Path:
    return directory() / "operator.dpapi"


def _write_state(state: dict) -> None:
    """Never overwrite a pending file or rotate the signing identity."""
    target = state_path()
    pending = target.with_name("operator.pending.dpapi")
    encoded = protect(json.dumps(state, separators=(",", ":")).encode("utf-8"))
    with pending.open("xb") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    pending.replace(target)


def _load() -> dict:
    return json.loads(unprotect(state_path().read_bytes()).decode("utf-8"))


def _authority(state: dict) -> Authority:
    seed = base64.urlsafe_b64decode(state["seed"] + "=")
    key = Ed25519PrivateKey.from_private_bytes(seed)
    return Authority(directory() / "issuer.sqlite", key, operator_secret=state["operator_token"])


def _activate(authority: Authority, credentials: dict) -> dict:
    return authority.activate(
        license_id=credentials["license_id"],
        activation_code=credentials["activation_code"],
        machine_fingerprint=credentials["machine_fingerprint"],
        request_nonce=_b64url(secrets.token_bytes(32)),
        requested_at_utc=int(time.time()),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Renewable test-only disposable BG issuer")
    parser.add_argument("command", choices=("init", "public-key", "status", "grant", "renew", "offline-term",
                                             "tls-init", "tls-info", "serve-https",
                                             "serve-https-pretrusted-transport",
                                             "online-credential", "qa-owner-password"))
    parser.add_argument("--fingerprint", default="")
    parser.add_argument("--days", type=int, default=7)
    options = parser.parse_args(argv)
    try:
        if os.environ.get("PHARMA_SECURITY_RELEASE_APPROVED"):
            raise RuntimeError("Disposable BG issuer refuses a release-approved environment")
        if options.command == "init":
            if state_path().exists() or (directory() / "issuer.sqlite").exists():
                raise RuntimeError("Disposable BG issuer already exists; never reset or rotate its key")
            directory().mkdir(parents=True, exist_ok=True)
            key = Ed25519PrivateKey.generate()
            from cryptography.hazmat.primitives import serialization

            seed = key.private_bytes(
                serialization.Encoding.Raw,
                serialization.PrivateFormat.Raw,
                serialization.NoEncryption(),
            )
            state = {"seed": _b64url(seed), "operator_token": secrets.token_urlsafe(40)}
            _write_state(state)
            authority = _authority(state)
            print(json.dumps({
                "ready": True, "test_only": True, "identity": IDENTIFIER,
                "issuer_public_key_b64": authority.issuer_public_key_b64,
                "state_directory": str(directory()),
            }))
            return 0

        if options.command == "tls-init":
            if not state_path().is_file():
                raise RuntimeError("Initialize the separate durable BG issuer first")
            print(json.dumps(init_local_tls(directory())))
            return 0
        if options.command == "tls-info":
            print(json.dumps(verify_local_tls(directory())))
            return 0

        state = _load()
        authority = _authority(state)
        if options.command in ("serve-https", "serve-https-pretrusted-transport"):
            from .server import serve_https
            if options.command == "serve-https-pretrusted-transport":
                # The first attempt to trust this issuer's NEW leaf was not
                # confirmed by Windows. Reuse only a known, previously approved
                # localhost transport certificate; NEVER reuse the other QA
                # issuer's signing material, authority or activation ledger.
                from .local_qa import verify_local_tls as verify_existing_qa_tls
                tls = verify_existing_qa_tls()
                if tls["thumbprint_sha1"] != EXISTING_QA_TRANSPORT_LEAF_SHA1:
                    raise RuntimeError("Pretrusted TLS leaf changed; independent review required")
            else:
                tls = verify_local_tls(directory())
            serve_https(authority, host="127.0.0.1", public_host="localhost",
                        port=LOCAL_HTTPS_PORT,
                        certificate=tls["certificate_file"], private_key=tls["private_key_file"])
        elif options.command == "online-credential":
            cred = state.get("credentials")
            if cred is None:
                raise RuntimeError("No bound disposable QA license exists")
            print(json.dumps({"license_id": cred["license_id"],
                              "activation_code": cred["activation_code"]}))
        elif options.command == "qa-owner-password":
            if "credentials" not in state:
                raise RuntimeError("No bound disposable QA license exists")
            if not state.get("qa_owner_password"):
                candidate = "Xy9!" + secrets.token_urlsafe(26)
                state["qa_owner_password"] = candidate
                _write_state(state)
            print(json.dumps({"qa_owner_password": state["qa_owner_password"]}))
        elif options.command == "public-key":
            print(authority.issuer_public_key_b64)
        elif options.command == "status":
            credential = state.get("credentials")
            if credential is None:
                print(json.dumps({"state": "not-issued", "identity": IDENTIFIER,
                                  "issuer_public_key_b64": authority.issuer_public_key_b64}))
            else:
                status = authority.status(license_id=credential["license_id"],
                                          operator_token=state["operator_token"])
                print(json.dumps({"identity": IDENTIFIER, **status}))
        elif options.command == "grant":
            if "credentials" in state:
                raise RuntimeError("Existing BG grant: use renew, never create a second license")
            if len(options.fingerprint) != 64 or any(char not in "0123456789abcdef" for char in options.fingerprint):
                raise RuntimeError("Use the actual native 64-character lowercase machine fingerprint")
            if not 1 <= options.days <= 30:
                raise RuntimeError("Disposable subscription term must be 1..30 days")
            created = authority.create_license(
                expires_at_utc=int(time.time()) + options.days * 86400,
                operator_token=state["operator_token"], actor_id="disposable-bg-qa",
            )
            state["credentials"] = {
                "license_id": created["license_id"],
                "activation_code": created["activation_code"],
                "machine_fingerprint": options.fingerprint,
            }
            # Save bearer credential BEFORE activation; interrupted issuance
            # must not create an untracked valid license or silently rotate it.
            _write_state(state)
            signed = _activate(authority, state["credentials"])
            verified = verify_activation_envelope(signed, authority.issuer_public_key_b64,
                machine_fingerprint=options.fingerprint, now_utc=int(time.time()))
            print(json.dumps({"identity": IDENTIFIER, "test_only": True,
                              "license_id": created["license_id"],
                              "activation_serial": verified["activation_serial"],
                              "signed_license": signed}))
        elif options.command == "renew":
            credentials = state.get("credentials")
            if credentials is None:
                raise RuntimeError("No independent disposable BG grant; first grant must use native fingerprint")
            signed = _activate(authority, credentials)
            verified = verify_activation_envelope(signed, authority.issuer_public_key_b64,
                machine_fingerprint=credentials["machine_fingerprint"], now_utc=int(time.time()),
                license_id=credentials["license_id"])
            print(json.dumps({"identity": IDENTIFIER, "test_only": True,
                              "license_id": credentials["license_id"],
                              "activation_serial": verified["activation_serial"],
                              "signed_license": signed}))
        elif options.command == "offline-term":
            credentials = state.get("credentials")
            if credentials is None:
                raise RuntimeError("No bound disposable QA license exists")
            status = authority.status(license_id=credentials["license_id"],
                                      operator_token=state["operator_token"])
            converted = authority.convert_to_offline_term(
                license_id=credentials["license_id"],
                expected_serial=status["activation_serial"],
                expected_expires_at_utc=status["expires_at_utc"],
                actor_id="disposable-bg-qa", operator_token=state["operator_token"],
            )
            verified = verify_activation_envelope(converted["activation"],
                authority.issuer_public_key_b64,
                machine_fingerprint=credentials["machine_fingerprint"],
                now_utc=int(time.time()), license_id=credentials["license_id"])
            if verified.get("offline_term") is not True or verified.get("lease_until_utc") is not None:
                raise RuntimeError("Offline-term issuer result failed verification")
            print(json.dumps({"identity": IDENTIFIER, "test_only": True,
                              "license_id": credentials["license_id"],
                              "activation_serial": verified["activation_serial"],
                              "expires_at_utc": verified["expires_at_utc"],
                              "signed_license": converted["activation"]}))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, Rejected) as exc:
        print("Disposable BG QA issuer: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
