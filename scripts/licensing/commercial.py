"""Dedicated, fail-closed commercial authority for a separately managed VM service.

This is NOT the educational signer. Secrets and the SQLite authority state are
operator-provisioned in isolated volumes before startup. No initialize endpoint,
no credentials in source/CLI arguments, no customer database, and no operator
HTTP endpoints. HTTPS must be terminated by a trusted, host-bound ingress.
"""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import stat
import sys
import threading
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .authority import Authority, AuthorityError, _unb64url, public_key_b64
from .cli import MAX_REQUEST_BYTES, dispatch
from .server import (
    AuthorityHandler, OfflineAuthorityHTTPServer, SourceRequestLimiter,
    strict_activation_json,
)


COMMERCIAL_HOST = "commercial-licenses.getpharmatech.app"
EDUCATIONAL_HOST = "licenses.getpharmatech.app"
ACK_ENV = "PHARMA_COMMERCIAL_TLS_TERMINATED"
ISSUE_APPROVAL_ENV = "PHARMA_COMMERCIAL_ISSUANCE_APPROVED"
STATE_DIR_ENV = "PHARMA_COMMERCIAL_STATE_DIR"
SECRETS_DIR_ENV = "PHARMA_COMMERCIAL_SECRETS_DIR"
STATE_DEFAULT = "/var/lib/pharma-commercial"
SECRETS_DEFAULT = "/run/pharma-commercial-secrets"
SEED_NAME = "commercial-issuer.seed"
TOKEN_NAME = "commercial-operator.token"
UNSAFE_PUBLIC_KEYS = frozenset({
    "QwRr_kCSs-lJlOraFdzCDYqqB7ZY_TlU644O-4vcpd4",  # Public QA key.
    "1P_GZRtjQCUNkm9sDQrS6w8RInIVdus9Y_y2tC6BCRg",  # Educational VM.
})


def _safe_dir(raw: str, label: str) -> Path:
    supplied = Path(raw).expanduser()
    if not supplied.is_absolute() or supplied.is_symlink():
        raise AuthorityError("unsafe_path", f"{label} must be an absolute non-symlink directory")
    resolved = supplied.resolve()
    repo = Path(__file__).resolve().parents[2]
    if resolved == repo or repo in resolved.parents:
        raise AuthorityError("unsafe_path", f"{label} cannot be inside the source repository")
    if not resolved.is_dir() or resolved.is_symlink():
        raise AuthorityError("unsafe_path", f"{label} must exist before commercial startup")
    if os.name != "nt":
        details = resolved.stat()
        if details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) & 0o077:
            raise AuthorityError("unsafe_permissions", f"{label} must be owned by the process user and mode 0700")
    return resolved


def _private_file(path: Path, *, max_bytes: int) -> str:
    if path.is_symlink() or not path.is_file():
        raise AuthorityError("missing_secret", "A required commercial identity or operator credential is absent")
    if os.name != "nt":
        details = path.stat()
        if details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) & 0o077:
            raise AuthorityError("unsafe_permissions", "Commercial secrets require owner-only permissions")
    with path.open("rb") as source:
        value = source.read(max_bytes + 1)
    if not value or len(value) > max_bytes:
        raise AuthorityError("invalid_secret", "Commercial secret has an invalid size")
    try:
        return value.decode("ascii").strip()
    except UnicodeDecodeError as exc:
        raise AuthorityError("invalid_secret", "Commercial secret has an invalid encoding") from exc


def commercial_paths(env: dict[str, str] | None = None) -> tuple[Path, Path]:
    values = env if env is not None else os.environ
    state = _safe_dir(values.get(STATE_DIR_ENV, STATE_DEFAULT), "Commercial state")
    secret = _safe_dir(values.get(SECRETS_DIR_ENV, SECRETS_DEFAULT), "Commercial secrets")
    if state == secret or state in secret.parents or secret in state.parents:
        raise AuthorityError("unsafe_path", "Commercial state and secrets must be separate")
    for item in (state, secret):
        # No common staging directory or its descendants; including a reused
        # staging signer/database would mix commercial and educational authority.
        for old in ("/var/lib/pharma-staging", "/run/pharma-staging-secrets"):
            old_path = Path(old)
            if item == old_path or old_path in item.parents:
                raise AuthorityError("unsafe_path", "Commercial service cannot reuse educational volumes")
    return state, secret


def make_commercial_authority(env: dict[str, str] | None = None) -> Authority:
    state, private = commercial_paths(env)
    seed = _unb64url(_private_file(private / SEED_NAME, max_bytes=64), expected_size=32)
    token = _private_file(private / TOKEN_NAME, max_bytes=128)
    if len(token) < 32:
        raise AuthorityError("invalid_secret", "Commercial operator token is too short")
    key = Ed25519PrivateKey.from_private_bytes(seed)
    if public_key_b64(key) in UNSAFE_PUBLIC_KEYS:
        raise AuthorityError("noncommercial_signer", "Commercial authority refuses published test or educational signing keys")
    # Authority pins this issuer identity in its own SQLite state. It rejects
    # attempts to reopen an existing license DB with a different signer.
    return Authority(state / "authority.sqlite", key, operator_secret=token)


class CommercialHandler(AuthorityHandler):
    """Public activation only; ingress does trusted TLS termination."""

    def setup(self) -> None:
        self.request.settimeout(self.server.client_timeout_seconds)
        # Parent attempts SSLSocket.do_handshake() when public_mode=True.
        # The port is exclusively reachable through VM-loopback Caddy.
        BaseHTTPRequestHandler.setup(self)

    def _validate_loopback_origin(self) -> bool:
        host = self.headers.get("Host", "").lower()
        if host not in (COMMERCIAL_HOST, COMMERCIAL_HOST + ":443") or self.headers.get("Origin", ""):
            self._reply(403, {"ok": False, "error": {"code": "invalid_host"}})
            return False
        return True


class CommercialActivationServer(OfflineAuthorityHTTPServer):
    """One rate-limited instance, in its own Docker container/loopback port."""

    def __init__(self, authority: Authority, *, bind: str = "0.0.0.0", port: int = 8080):
        if bind not in ("0.0.0.0", "127.0.0.1") or type(port) is not int or not 0 <= port <= 65535:
            raise AuthorityError("invalid_bind", "Explicit IPv4 bind address and port required")
        if bind != "127.0.0.1" and (port == 0 or os.getenv(ACK_ENV) != "acknowledged"):
            raise AuthorityError("missing_ingress_ack", "Non-loopback HTTP requires trusted TLS ingress acknowledgment")
        self.authority = authority
        self.public_mode = True
        self.public_host = COMMERCIAL_HOST
        self.client_timeout_seconds = 5.0
        self._slots = threading.BoundedSemaphore(16)
        self.source_limiter = SourceRequestLimiter()
        ThreadingHTTPServer.__init__(self, (bind, port), CommercialHandler)


def _read_operator_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise AuthorityError("request_too_large", "Operator request exceeds size limit")
    data = strict_activation_json(raw)
    if type(data) is not dict or "operator_token" in data:
        raise AuthorityError("bad_json", "Operator request must exclude private credentials")
    return data


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Isolated commercial licensing authority")
    parser.add_argument("command", choices=("serve", "public-key", "operator"))
    parser.add_argument("operator_action", nargs="?", choices=("issue", "issue-offline", "extend", "offline-term", "reassign", "revoke", "status"))
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    options = parser.parse_args(argv)
    try:
        authority = make_commercial_authority()
        if options.command == "serve":
            if os.getenv(ACK_ENV) != "acknowledged":
                raise AuthorityError("missing_ingress_ack", "HTTPS ingress must be explicitly confirmed")
            with CommercialActivationServer(authority, bind=options.bind, port=options.port) as server:
                print("Commercial activation API on private ingress backend", flush=True)
                server.serve_forever(poll_interval=0.5)
            return 0
        if options.command == "public-key":
            result = dispatch(authority, "public-key", {})
        else:
            if not options.operator_action:
                raise AuthorityError("invalid_command", "Operator command requires an action")
            if options.operator_action in ("issue", "issue-offline") and os.getenv(ISSUE_APPROVAL_ENV) != "true":
                raise AuthorityError("issuance_disabled", "Commercial customer issuance requires explicit release authorization")
            payload = _read_operator_request()
            payload["operator_token"] = authority._secret
            result = dispatch(authority, options.operator_action, payload)
        # 'issue' returns a one-time bearer; this operator-only stdout must
        # NEVER be collected by Azure RunCommand, server logs or tickets.
        print(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
        return 0
    except (AuthorityError, KeyError, TypeError, ValueError) as exc:
        code = exc.code if isinstance(exc, AuthorityError) else "invalid_input"
        print(json.dumps({"ok": False, "error": {"code": code}}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
