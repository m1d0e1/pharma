"""Isolated TEST-ONLY license issuer for a single container behind HTTPS ingress.

No production identity, customer billing, local Windows DPAPI state or operator
HTTP route is available here. The internal HTTP listener MUST NOT be published
to the Internet directly; the ingress must enforce HTTPS and access policy.
"""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import stat
import sys
import threading
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .authority import Authority, AuthorityError, _b64url, _unb64url, public_key_b64
from .cli import MAX_REQUEST_BYTES, dispatch
from .server import AuthorityHandler, OfflineAuthorityHTTPServer, SourceRequestLimiter, strict_activation_json


# Explicit educational staging HTTPS hostname. This is NOT a production issuer.
# The signer, database, credentials and release guard remain strictly TEST-ONLY.
STAGING_HOST = "licenses.getpharmatech.app"
STAGING_ACK = "PHARMA_STAGING_TLS_TERMINATED"
STATE_DIR_ENV = "PHARMA_STAGING_STATE_DIR"
SECRETS_DIR_ENV = "PHARMA_STAGING_SECRETS_DIR"
SEED_NAME = "staging-only-issuer.seed"
TOKEN_NAME = "staging-only-operator.token"


def _outside_repository(value: str, label: str) -> Path:
    supplied = Path(value).expanduser()
    if not supplied.is_absolute() or supplied.is_symlink():
        raise AuthorityError("unsafe_path", f"{label} must be an absolute non-symlink path")
    path = supplied.resolve()
    repo = Path(__file__).resolve().parents[2]
    if path == repo or repo in path.parents:
        raise AuthorityError("unsafe_path", f"{label} must reside outside the repository")
    qa_home = os.environ.get("LOCALAPPDATA")
    if qa_home:
        qa = (Path(qa_home) / "PharmaLicenseQAOperator").resolve()
        if path == qa or qa in path.parents:
            raise AuthorityError("unsafe_path", "Staging must not use Windows localhost QA state")
    if path.exists() and not path.is_dir():
        raise AuthorityError("unsafe_path", f"{label} must be a directory")
    return path


def directories(env: dict[str, str] | None = None) -> tuple[Path, Path]:
    values = os.environ if env is None else env
    state = _outside_repository(values.get(STATE_DIR_ENV, "/var/lib/pharma-staging"), "Staging state")
    private = _outside_repository(values.get(SECRETS_DIR_ENV, "/run/pharma-staging-secrets"), "Staging secrets")
    if state == private or state in private.parents or private in state.parents:
        raise AuthorityError("unsafe_path", "Staging secrets and state need separate directories")
    return state, private


def _private_dir(path: Path, *, create: bool) -> None:
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not path.is_dir() or path.is_symlink():
        raise AuthorityError("unsafe_path", "Missing or unsafe staging directory")
    if os.name != "nt":
        info = path.stat()
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise AuthorityError("unsafe_permissions", "Staging directories must be private to the service user")


def _read_secret(path: Path, *, max_bytes: int) -> str:
    if path.is_symlink() or not path.is_file():
        raise AuthorityError("missing_secret", "Required staging secret file is missing or unsafe")
    if os.name != "nt":
        info = path.stat()
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise AuthorityError("unsafe_permissions", "Staging secret file permissions must be 0600")
    with path.open("rb") as stream:
        raw = stream.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise AuthorityError("invalid_secret", "Staging secret has invalid size")
    try:
        return raw.decode("ascii").strip()
    except UnicodeDecodeError as exc:
        raise AuthorityError("invalid_secret", "Invalid staging secret encoding") from exc


def _new_secret(path: Path, payload: str) -> None:
    # Exclusive creation avoids replacing a signing identity or operator token.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(str(path), flags, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write((payload + "\n").encode("ascii"))
        stream.flush()
        os.fsync(stream.fileno())


def initialize(*, env: dict[str, str] | None = None) -> str:
    state, private = directories(env)
    _private_dir(state, create=True)
    _private_dir(private, create=True)
    seed_file, token_file = private / SEED_NAME, private / TOKEN_NAME
    if any(path.exists() or path.is_symlink() for path in (seed_file, token_file)) or (state / "authority.sqlite").exists():
        raise AuthorityError("already_initialized", "Staging identity/state exists; never rotate by reinitializing")
    key = Ed25519PrivateKey.generate()
    raw_seed = key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                 serialization.NoEncryption())
    _new_secret(seed_file, _b64url(raw_seed))
    _new_secret(token_file, secrets.token_urlsafe(48))
    # Never print the seed or operator token; the only reported identity is public.
    return public_key_b64(key)


def make_staging_authority(*, env: dict[str, str] | None = None) -> Authority:
    state, private = directories(env)
    _private_dir(state, create=False)
    _private_dir(private, create=False)
    raw_seed = _unb64url(_read_secret(private / SEED_NAME, max_bytes=64), expected_size=32)
    token = _read_secret(private / TOKEN_NAME, max_bytes=128)
    if len(token) < 32:
        raise AuthorityError("invalid_secret", "Staging operator credential too short")
    return Authority(state / "authority.sqlite", Ed25519PrivateKey.from_private_bytes(raw_seed),
                     operator_secret=token)


class StagingHandler(AuthorityHandler):
    """Reuse the public-only routes but accept plaintext ONLY behind HTTPS ingress."""

    def setup(self) -> None:
        self.request.settimeout(self.server.client_timeout_seconds)
        # Parent AuthorityHandler.setup() handshakes a TLS socket in public mode.
        # At this staging boundary TLS is terminated by the trusted ingress.
        BaseHTTPRequestHandler.setup(self)

    def _validate_loopback_origin(self) -> bool:
        host = self.headers.get("Host", "").lower()
        if host not in (STAGING_HOST, STAGING_HOST + ":443") or self.headers.get("Origin", ""):
            self._reply(403, {"ok": False, "error": {"code": "invalid_host"}})
            return False
        return True


class StagingActivationServer(OfflineAuthorityHTTPServer):
    """Single replica only; do not expose this HTTP socket without TLS ingress."""

    def __init__(self, authority: Authority, *, bind: str = "0.0.0.0", port: int = 8080,
                 max_clients: int = 16):
        if bind not in ("127.0.0.1", "0.0.0.0") or type(port) is not int or not 0 <= port <= 65535:
            raise AuthorityError("invalid_bind", "Staging bind must be explicit IPv4 and port 0..65535")
        if bind != "127.0.0.1" and port == 0:
            raise AuthorityError("invalid_bind", "Dynamic ports are for loopback tests only")
        if bind != "127.0.0.1" and os.environ.get(STAGING_ACK) != "acknowledged":
            raise AuthorityError("missing_ingress_ack", "Non-loopback HTTP requires explicit HTTPS ingress acknowledgment")
        if not 1 <= max_clients <= 128:
            raise AuthorityError("invalid_server_limits", "Clients must be 1..128")
        self.authority = authority
        self.public_mode = True
        self.public_host = STAGING_HOST
        self.client_timeout_seconds = 5.0
        self._slots = threading.BoundedSemaphore(max_clients)
        self.source_limiter = SourceRequestLimiter()
        ThreadingHTTPServer.__init__(self, (bind, port), StagingHandler)


def _read_operator_request() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise AuthorityError("request_too_large", "Operator request is too large")
    try:
        payload = strict_activation_json(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise AuthorityError("bad_json", "Expected JSON object") from exc
    if type(payload) is not dict or "operator_token" in payload:
        raise AuthorityError("bad_json", "Operator request must be an object without credentials")
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="TEST-ONLY container staging authority, never production")
    parser.add_argument("command", choices=("init", "public-key", "serve", "operator"))
    parser.add_argument("operator_action", nargs="?", choices=("issue", "extend", "reassign", "revoke", "status"))
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    options = parser.parse_args(argv)
    try:
        if os.environ.get("PHARMA_SECURITY_RELEASE_APPROVED"):
            raise AuthorityError("production_guard", "Staging refuses any production-release approval environment")
        if options.command == "init":
            key = initialize()
            result = {"environment": "TEST_ONLY_STAGING", "issuer_public_key_b64": key}
        else:
            authority = make_staging_authority()
            if options.command == "serve":
                if os.environ.get(STAGING_ACK) != "acknowledged":
                    raise AuthorityError("missing_ingress_ack", "Explicit trusted HTTPS ingress acknowledgment required")
                with StagingActivationServer(authority, bind=options.bind, port=options.port) as server:
                    print("TEST-ONLY staging activation service; internal HTTP behind HTTPS ingress", flush=True)
                    server.serve_forever(poll_interval=0.5)
                return 0
            if options.command == "public-key":
                result = dispatch(authority, "public-key", {})
            else:
                if options.operator_action is None:
                    raise AuthorityError("invalid_command", "Operator action required")
                payload = _read_operator_request()
                payload["operator_token"] = authority._secret
                result = dispatch(authority, options.operator_action, payload)
        print(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
        return 0
    except (AuthorityError, ValueError, KeyError, TypeError) as exc:
        code = exc.code if isinstance(exc, AuthorityError) else "invalid_input"
        print(json.dumps({"ok": False, "error": {"code": code}}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
