"""Offline issuer command-line JSON endpoint.

Usage (cwd = project root):
  python -m scripts.licensing.cli public-key
  python -m scripts.licensing.cli issue     < issue-request.json
  python -m scripts.licensing.cli issue-offline < offline-first-issue-request.json
  python -m scripts.licensing.cli activate  < activation-request.json
  python -m scripts.licensing.cli reassign  < reassign-request.json
  python -m scripts.licensing.cli extend    < extend-request.json
  python -m scripts.licensing.cli offline-term < offline-term-request.json
  python -m scripts.licensing.cli revoke    < revoke-request.json
  python -m scripts.licensing.cli status    < status-request.json
  python -m scripts.licensing.cli serve --port 8765

Inputs are JSON on stdin to avoid secrets in argv/process listings. Private
signing key and operator verifier secret are read only from environment.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

from .authority import (
    Authority,
    AuthorityError,
    Rejected,
    DATABASE_ENV,
    MAX_LEASE_SECONDS,
    load_signing_key,
)

MAX_REQUEST_BYTES = 16 * 1024


def make_authority() -> Authority:
    path = os.environ.get(DATABASE_ENV)
    if not path:
        raise AuthorityError("missing_db", f"{DATABASE_ENV} must be set outside the Pharma repository")
    return Authority(path, load_signing_key())


def dispatch(authority: Authority, command: str, data: dict[str, Any]) -> Any:
    if command == "public-key":
        return {"algorithm": "Ed25519", "issuer_public_key_b64": authority.issuer_public_key_b64}
    if command == "issue":
        return authority.create_license(
            expires_at_utc=data["expires_at_utc"],
            lease_seconds=data.get("lease_seconds", MAX_LEASE_SECONDS),
            operator_token=data["operator_token"],
            actor_id=data["actor_id"],
            license_id=data.get("license_id"),
        )
    if command == "issue-offline":
        required = {"machine_fingerprint", "expires_at_utc", "actor_id", "operator_token"}
        if set(data) not in (required, required | {"license_id"}):
            raise Rejected("invalid_input", "Offline issuance requires exactly the bound machine, term, actor and operator credential")
        return authority.issue_offline_license(
            machine_fingerprint=data["machine_fingerprint"],
            expires_at_utc=data["expires_at_utc"],
            actor_id=data["actor_id"],
            operator_token=data["operator_token"],
            license_id=data.get("license_id"),
        )
    if command == "activate":
        return authority.activate(
            license_id=data["license_id"],
            machine_fingerprint=data["machine_fingerprint"],
            activation_code=data["activation_code"],
            request_nonce=data["request_nonce"],
            requested_at_utc=data["requested_at_utc"],
        )
    if command == "extend":
        return authority.extend_term(
            license_id=data["license_id"],
            expected_serial=data["expected_serial"],
            expected_expires_at_utc=data["expected_expires_at_utc"],
            expires_at_utc=data["expires_at_utc"],
            actor_id=data["actor_id"],
            operator_token=data["operator_token"],
        )
    if command == "offline-term":
        return authority.convert_to_offline_term(
            license_id=data["license_id"],
            expected_serial=data["expected_serial"],
            expected_expires_at_utc=data["expected_expires_at_utc"],
            actor_id=data["actor_id"],
            operator_token=data["operator_token"],
        )
    if command == "reassign":
        return authority.reassign(
            license_id=data["license_id"],
            expected_machine_fingerprint=data["expected_machine_fingerprint"],
            new_machine_fingerprint=data["new_machine_fingerprint"],
            expected_serial=data["expected_serial"],
            actor_id=data["actor_id"],
            operator_token=data["operator_token"],
        )
    if command == "revoke":
        return {"revocation": authority.revoke(
            license_id=data["license_id"],
            expected_serial=data["expected_serial"],
            actor_id=data["actor_id"],
            operator_token=data["operator_token"],
        )}
    if command == "status":
        return authority.status(
            license_id=data["license_id"],
            operator_token=data["operator_token"],
        )
    raise AuthorityError("invalid_command", "Unsupported command")


def _read_json_stdin() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise AuthorityError("request_too_large", "Request exceeds 16 KiB")
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise AuthorityError("bad_json", "Expected one JSON object on standard input") from exc
    if type(value) is not dict:
        raise AuthorityError("bad_json", "Expected JSON object")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline Pharma license authority (never deployed by this tool)")
    parser.add_argument(
        "command",
        choices=("public-key", "issue", "issue-offline", "activate", "extend", "offline-term", "reassign", "revoke", "status", "serve", "serve-https"),
    )
    parser.add_argument("--port", type=int, default=8765, help="Loopback-only HTTP port for serve")
    parser.add_argument("--host", default="127.0.0.1", help="Explicit network bind address for serve-https")
    parser.add_argument("--public-host", default="", help="Expected HTTPS DNS hostname in Host header")
    parser.add_argument("--tls-cert", default="", help="Operator-managed trusted TLS certificate path")
    parser.add_argument("--tls-key", default="", help="Operator-managed TLS private key path")
    options = parser.parse_args(argv)
    try:
        authority = make_authority()
        if options.command == "serve":
            from .server import serve

            serve(authority, port=options.port)
            return 0
        if options.command == "serve-https":
            from .server import serve_https
            if not options.public_host or not options.tls_cert or not options.tls_key:
                raise AuthorityError("missing_tls", "HTTPS requires --public-host, --tls-cert and --tls-key")
            serve_https(authority, host=options.host, public_host=options.public_host,
                        port=options.port, certificate=options.tls_cert, private_key=options.tls_key)
            return 0
        request = {} if options.command == "public-key" else _read_json_stdin()
        result = dispatch(authority, options.command, request)
        print(json.dumps({"ok": True, "result": result}, separators=(",", ":"), ensure_ascii=True))
        return 0
    except (AuthorityError, KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, AuthorityError):
            code, msg = exc.code, str(exc)
        else:
            code, msg = "invalid_input", "Missing or malformed request field"
        print(json.dumps({"ok": False, "error": {"code": code, "message": msg}}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
