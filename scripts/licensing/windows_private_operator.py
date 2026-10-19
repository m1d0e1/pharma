"""Windows-only manual offline license issuer using DPAPI-protected operator keys.

This has no server endpoints, does not authorize historical source imports,
and does not code-sign Windows executables. The operator must independently
back up and verify recovery of the issuer identity and authority ledger before
commercial use. DPAPI CurrentUser recovery depends on Windows account custody.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from scripts import owner_first_enrollment as custody
from scripts.licensing.authority import Authority, AuthorityError, public_key_b64
from scripts.licensing.cli import MAX_REQUEST_BYTES, dispatch
from scripts.licensing.commercial import UNSAFE_PUBLIC_KEYS, ISSUE_APPROVAL_ENV

ROOT_NAME = "pharma-commercial-offline-operator"
ISSUER_BLOB = "commercial-issuer-seed.dpapi"
TOKEN_BLOB = "commercial-operator-token.dpapi"
AUTHORITY_DB = "authority.sqlite"


class Refused(ValueError):
    pass


def _root() -> Path:
    custody._require_windows()
    if not os.getenv("LOCALAPPDATA"):
        raise Refused("Windows LocalAppData is missing")
    return Path(os.environ["LOCALAPPDATA"]) / ROOT_NAME


def _crypto():
    try:
        import win32crypt
        return win32crypt
    except ImportError as exc:
        raise Refused("Windows DPAPI is unavailable") from exc


def _checked_dir(path: Path) -> None:
    if not path.is_dir() or path.is_symlink():
        raise Refused("Private Windows operator directory is missing")
    custody._no_reparse(path)
    custody._private_acl(path, set_restriction=False)


def _checked_blob(path: Path) -> bytes:
    if not path.is_file() or path.is_symlink() or path.stat().st_nlink != 1:
        raise Refused("Sealed Windows operator credential is missing")
    if not 100 <= path.stat().st_size <= 16384:
        raise Refused("Sealed operator credential is malformed")
    custody._no_reparse(path)
    custody._private_acl(path, set_restriction=False)
    try:
        _, plain = _crypto().CryptUnprotectData(path.read_bytes(), None, None, None, 0)
    except Exception as exc:
        raise Refused("DPAPI user cannot unwrap operator credential") from exc
    return plain


def _load() -> Authority:
    root = _root()
    _checked_dir(root)
    state, secret = root / "state", root / "secrets"
    _checked_dir(state)
    _checked_dir(secret)
    seed = _checked_blob(secret / ISSUER_BLOB)
    token = _checked_blob(secret / TOKEN_BLOB)
    if len(seed) != 32 or not 32 <= len(token) <= 128 or not token.isascii():
        raise Refused("Protected operator identity dimensions are invalid")
    key = Ed25519PrivateKey.from_private_bytes(seed)
    if public_key_b64(key) in UNSAFE_PUBLIC_KEYS:
        raise Refused("Published QA/educational signing key is not commercial")
    ledger = state / AUTHORITY_DB
    if not ledger.is_file() or ledger.is_symlink() or ledger.stat().st_nlink != 1:
        raise Refused("Original offline issuer ledger is unavailable")
    custody._private_acl(ledger, set_restriction=False)
    return Authority(ledger, key, operator_secret=token.decode("ascii"))


def initialize() -> dict[str, Any]:
    root = _root()
    if root.exists() or root.is_symlink():
        raise Refused("Commercial issuer exists; never overwrite its signing identity")
    custody._no_reparse(root.parent)
    root.mkdir(mode=0o700)
    custody._private_acl(root)
    state, secret = root / "state", root / "secrets"
    for folder in (state, secret):
        folder.mkdir(mode=0o700)
        custody._private_acl(folder)
    signer = Ed25519PrivateKey.generate()
    seed = signer.private_bytes(serialization.Encoding.Raw,
                                serialization.PrivateFormat.Raw,
                                serialization.NoEncryption())
    public = public_key_b64(signer)
    if public in UNSAFE_PUBLIC_KEYS:
        raise Refused("Unexpected public test issuer identity")
    token = secrets.token_urlsafe(48).encode("ascii")
    protect = _crypto().CryptProtectData
    custody._exclusive_file(secret / ISSUER_BLOB,
                            protect(seed, "PHARMA offline commercial issuer", None, None, None, 0))
    custody._exclusive_file(secret / TOKEN_BLOB,
                            protect(token, "PHARMA offline operator", None, None, None, 0))
    custody._exclusive_file(state / AUTHORITY_DB, b"")
    issuer = Authority(state / AUTHORITY_DB, signer, operator_secret=token.decode("ascii"))
    custody._private_acl(state / AUTHORITY_DB, set_restriction=False)
    if issuer.issuer_public_key_b64 != public:
        raise Refused("Commercial signing identity failed initialization")
    return {
        "status": "PRIVATE_WINDOWS_ISSUER_PROVISIONED_BACKUP_PENDING",
        "public_license_verification_key_b64url": public,
        "private_seed_exposed": False,
        "commercial_issuance_approved": False,
        "off_device_recovery_backup_verified": False,
        "historical_import_or_financial_approval_granted": False,
    }


def status() -> dict[str, Any]:
    issuer = _load()
    return {
        "status": "PRIVATE_WINDOWS_ISSUER_PRESENT_RECOVERY_NOT_CERTIFIED",
        "public_license_verification_key_b64url": issuer.issuer_public_key_b64,
        "private_seed_exposed": False,
        "commercial_installer_signed": False,
        "historical_import_approved": False,
    }


def issue_offline() -> dict[str, Any]:
    if os.environ.get(ISSUE_APPROVAL_ENV) != "true":
        raise Refused("Offline commercial issuance requires explicit operator approval")
    issuer = _load()
    body = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(body) > MAX_REQUEST_BYTES:
        raise Refused("Offline customer license request too large")
    try:
        request = json.loads(body)
    except (ValueError, UnicodeError) as exc:
        raise Refused("Invalid license request") from exc
    if not isinstance(request, dict) or "operator_token" in request:
        raise Refused("Operator credentials cannot be supplied by license caller")
    request["operator_token"] = issuer._secret
    result = dispatch(issuer, "issue-offline", request)
    return {
        "status": "PASS_PRIVATE_MANUAL_OFFLINE_LICENSE_ISSUED",
        "license_id": result["license_id"],
        "activation_serial": result["activation_serial"],
        "expires_at_utc": result["expires_at_utc"],
        "activation": result["activation"],
        "not_historical_import_approval": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("initialize", "status", "issue-offline"))
    try:
        args = parser.parse_args()
        result = {
            "initialize": initialize,
            "status": status,
            "issue-offline": issue_offline,
        }[args.operation]()
        print(json.dumps(result, sort_keys=True))
        return 0
    except (Refused, custody.Refused, AuthorityError, sqlite3.Error,
            OSError, ValueError, UnicodeError, KeyError, TypeError):
        print(json.dumps({"status": "REFUSED_PRIVATE_WINDOWS_OFFLINE_ISSUER"}),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
