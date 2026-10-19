"""Reference offline loopback-only HTTP adapter; no cloud services or deployment."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import sqlite3
import ssl
import threading
import time
from typing import Any, Callable

from .authority import Authority, AuthorityError
from .cli import dispatch, MAX_REQUEST_BYTES


def strict_activation_json(raw: bytes) -> Any:
    """Reject ambiguous JSON before it can reach credential/replay validation.

    Default Python JSON parsing silently accepts duplicate properties and
    nonstandard NaN/Infinity. Neither has a canonical cross-language meaning
    for a signed device-bound authority request. Explicitly deny both rather
    than risk proxy, audit and activation parser disagreements.
    """
    def unique_pairs(pairs):
        data = {}
        for key, value in pairs:
            if key in data:
                raise AuthorityError("duplicate_json_key", "Repeated JSON field rejected")
            data[key] = value
        return data

    def reject_constant(_value):
        raise AuthorityError("invalid_json_number", "Non-finite JSON value rejected")

    return json.loads(raw, object_pairs_hook=unique_pairs,
                      parse_constant=reject_constant)


class SourceRequestLimiter:
    """Bounded, per-TCP-peer token bucket for the public HTTPS endpoint.

    Forwarded/X-Forwarded-For/Host are untrusted and never consulted. This is
    process-local defense in depth, not an API-gateway or shared-cluster limit.
    In particular, a TLS-terminating reverse proxy groups all its customers
    under the proxy's socket address unless the gateway does its own limiting.
    """

    def __init__(self, *, burst: int = 30, window_seconds: float = 60.0,
                 max_sources: int = 1024, idle_seconds: float = 120.0,
                 clock: Callable[[], float] = time.monotonic):
        if (type(burst) is not int or burst < 1 or window_seconds <= 0
                or type(max_sources) is not int or max_sources < 1
                or idle_seconds <= 0):
            raise ValueError("Rate limit capacity, window and tracking bounds must be positive")
        self.burst = burst
        self.window_seconds = window_seconds
        self.max_sources = max_sources
        self.idle_seconds = idle_seconds
        self._clock = clock
        self._lock = threading.Lock()
        # Source address -> (remaining tokens, last request's monotonic time).
        self._sources: dict[str, tuple[float, float]] = {}
        self._last_prune = clock()

    def _prune(self, now: float) -> None:
        for source, (_, last_seen) in list(self._sources.items()):
            if now - last_seen >= self.idle_seconds:
                del self._sources[source]
        self._last_prune = now

    def admit(self, source: str) -> int | None:
        """Return None to admit; otherwise integer Retry-After seconds."""
        with self._lock:
            now = self._clock()
            if now - self._last_prune >= self.idle_seconds:
                self._prune(now)
            previous = self._sources.get(source)
            if previous is None:
                if len(self._sources) >= self.max_sources:
                    # Recheck stale entries at capacity, but NEVER evict live
                    # offenders: that would let new IPs reset their counters.
                    self._prune(now)
                    if len(self._sources) >= self.max_sources:
                        return max(1, math.ceil(self.idle_seconds))
                tokens = float(self.burst)
            else:
                left, previous_at = previous
                tokens = min(self.burst, left + max(0.0, now - previous_at)
                             * self.burst / self.window_seconds)
            if tokens < 1:
                self._sources[source] = (tokens, now)
                return max(1, math.ceil((1 - tokens) * self.window_seconds / self.burst))
            self._sources[source] = (tokens - 1, now)
            return None


class OfflineAuthorityHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, authority: Authority, port: int, *, max_clients: int = 16,
                 client_timeout_seconds: float = 5.0):
        if type(port) is not int or not (0 <= port <= 65535):
            raise AuthorityError("invalid_port", "port must be between 0 and 65535")
        if not isinstance(max_clients, int) or not 1 <= max_clients <= 128:
            raise AuthorityError("invalid_server_limits", "max_clients must be 1..128")
        if not 0.05 <= client_timeout_seconds <= 30.0:
            raise AuthorityError("invalid_server_limits", "Client timeout must be 0.05..30 seconds")
        self.authority = authority
        self.client_timeout_seconds = client_timeout_seconds
        self._slots = threading.BoundedSemaphore(max_clients)
        # Intentionally hard-code loopback. No HTTP exposed to remote network.
        super().__init__(("127.0.0.1", port), AuthorityHandler)

    def process_request(self, request, client_address):
        # ThreadingHTTPServer by default creates unlimited handler threads.
        if not self._slots.acquire(blocking=False):
            # In HTTPS mode this socket has not completed its TLS handshake.
            # SSLSocket.sendall() here can *perform the handshake* on this
            # single accept-loop thread and stall all subsequent renewals if
            # an unauthenticated peer sends no ClientHello. Reject by closing
            # the transport only; never do TLS I/O from the accept loop.
            if getattr(self, "public_mode", False):
                self.close_request(request)
            else:
                try:
                    request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                except OSError:
                    pass
                finally:
                    self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


class HTTPSActivationServer(OfflineAuthorityHTTPServer):
    """TLS-only customer activation endpoint; never expose operator commands."""

    def __init__(self, authority: Authority, *, host: str, public_host: str, port: int,
                 certificate: str, private_key: str, max_clients: int = 16):
        if not public_host or any(c in public_host for c in "/:@? #\\"):
            raise AuthorityError("invalid_host", "Public DNS hostname must not contain URL parts")
        if not host or not isinstance(host, str) or type(port) is not int or not 0 <= port <= 65535:
            raise AuthorityError("invalid_host", "Explicit network bind address and valid port required")
        if port == 0 and host not in ("127.0.0.1", "::1"):
            raise AuthorityError("invalid_port", "Dynamic ports are reserved for localhost TLS tests")
        if not isinstance(max_clients, int) or not 1 <= max_clients <= 128:
            raise AuthorityError("invalid_server_limits", "max_clients must be 1..128")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(certfile=certificate, keyfile=private_key)
        self.authority = authority
        self.client_timeout_seconds = 5.0
        self._slots = threading.BoundedSemaphore(max_clients)
        self.public_mode = True
        self.public_host = public_host.lower()
        self.source_limiter = SourceRequestLimiter()
        ThreadingHTTPServer.__init__(self, (host, port), AuthorityHandler)
        try:
            # Never perform unauthenticated TLS handshakes inside the serial
            # HTTPServer accept loop. The bounded worker thread performs it
            # after a slot is reserved, with the configured socket timeout.
            self.socket = context.wrap_socket(self.socket, server_side=True,
                                              do_handshake_on_connect=False)
        except BaseException:
            self.server_close()
            raise

class AuthorityHandler(BaseHTTPRequestHandler):
    server: OfflineAuthorityHTTPServer

    def setup(self) -> None:
        self.request.settimeout(self.server.client_timeout_seconds)
        if getattr(self.server, "public_mode", False):
            self.request.do_handshake()
        super().setup()

    def log_message(self, format: str, *args: Any) -> None:
        # Suppress request details and bearer secrets. No request body logging.
        pass

    def _reply(self, status: int, payload: dict[str, Any], *,
               retry_after: int | None = None) -> None:
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if getattr(self.server, "public_mode", False):
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _admit_public_request(self) -> bool:
        if not getattr(self.server, "public_mode", False):
            return True
        # client_address comes directly from TCP accept(), not from headers
        # that a malicious renderer or remote caller can forge.
        retry_after = self.server.source_limiter.admit(self.client_address[0])
        if retry_after is None:
            return True
        self._reply(429, {"ok": False, "error": {"code": "rate_limited"}},
                    retry_after=retry_after)
        return False

    def _validate_loopback_origin(self) -> bool:
        if getattr(self.server, "public_mode", False):
            # Never trust Origin or X-Forwarded-* for a machine license. Only
            # the explicitly configured public DNS host is accepted.
            port = self.server.server_port
            host = self.server.public_host
            allowed = {host, f"{host}:{port}"} if port == 443 else {f"{host}:{port}"}
            if self.headers.get("Host", "").lower() not in allowed or self.headers.get("Origin", ""):
                self._reply(403, {"ok": False, "error": {"code": "invalid_host"}})
                return False
            return True
        # A browser can attempt DNS rebinding against a loopback listener.
        # Reject arbitrary Host/Origin headers even though this is not a
        # production API or substitute for protected operator-host access.
        port = self.server.server_port
        allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin", "")
        if host not in allowed_hosts:
            self._reply(403, {"ok": False, "error": {"code": "invalid_host"}})
            return False
        if origin and origin not in {f"http://{value}" for value in allowed_hosts}:
            self._reply(403, {"ok": False, "error": {"code": "invalid_origin"}})
            return False
        return True

    def do_GET(self) -> None:
        if not self._admit_public_request():
            return
        if not self._validate_loopback_origin():
            return
        if self.path != "/v1/public-key":
            self._reply(404, {"ok": False, "error": {"code": "not_found"}})
            return
        self._reply(200, {"ok": True, "result": dispatch(self.server.authority, "public-key", {})})

    def do_POST(self) -> None:
        if not self._admit_public_request():
            return
        if not self._validate_loopback_origin():
            return
        path_to_action = {
            "/v1/issue": "issue",
            "/v1/activate": "activate",
            "/v1/reassign": "reassign",
            "/v1/revoke": "revoke",
            "/v1/status": "status",
        }
        action = path_to_action.get(self.path)
        if getattr(self.server, "public_mode", False) and action != "activate":
            # Issuance, transfers, revocations and status require a separate
            # operator-only CLI; never expose those methods on the public API.
            self._reply(404, {"ok": False, "error": {"code": "not_found"}})
            return
        if action is None:
            self._reply(404, {"ok": False, "error": {"code": "not_found"}})
            return
        try:
            if self.headers.get_content_type() != "application/json":
                raise AuthorityError("bad_content_type", "Content-Type must be application/json")
            length_text = self.headers.get("Content-Length", "")
            if not length_text.isdecimal() or int(length_text) > MAX_REQUEST_BYTES:
                raise AuthorityError("bad_length", "Invalid or excessive Content-Length")
            payload = strict_activation_json(self.rfile.read(int(length_text)))
            if type(payload) is not dict:
                raise AuthorityError("bad_json", "Expected JSON object")
            output = dispatch(self.server.authority, action, payload)
            self._reply(200, {"ok": True, "result": output})
        except (AuthorityError, KeyError, TypeError, ValueError) as exc:
            if isinstance(exc, AuthorityError):
                code, message = exc.code, str(exc)
            else:
                code, message = "invalid_input", "Missing or malformed request field"
            status = 503 if code == "authority_state_invalid" else 429 if code == "rate_limited" else 401 if code == "unauthorized" else 409 if code in {
                "machine_bound", "stale_state", "replay", "revoked", "already_exists",
            } else 400
            try:
                self._reply(status, {"ok": False, "error": {"code": code, "message": message}})
            except OSError:
                # A peer may abandon a partial request just as its TLS read
                # fails. Failure to send an error *to that closed socket* is
                # expected, not a worker exception or a reason to log a trace.
                # The authority transaction has already committed/rolled back.
                pass
        except sqlite3.DatabaseError:
            # A locked, damaged or interrupted issuer DB is not an invalid
            # customer credential. Do not spill SQLite details or break the
            # HTTP connection; operator recovery can restore durable state.
            try:
                self._reply(503, {"ok": False, "error": {"code": "authority_unavailable"}})
            except OSError:
                pass
        except TimeoutError:
            try:
                self._reply(408, {"ok": False, "error": {"code": "request_timeout"}})
            except OSError:
                pass


def serve(authority: Authority, *, port: int = 8765) -> None:
    with OfflineAuthorityHTTPServer(authority, port) as server:
        print(f"Pharma reference licensing authority on http://127.0.0.1:{server.server_port}", flush=True)
        server.serve_forever(poll_interval=0.5)


def serve_https(authority: Authority, *, host: str, public_host: str, port: int,
                certificate: str, private_key: str) -> None:
    """Explicit TLS server; requires operator-owned certificates and firewall."""
    with HTTPSActivationServer(authority, host=host, public_host=public_host,
                               port=port, certificate=certificate, private_key=private_key) as server:
        print(f"Pharma HTTPS activation server listening on {host}:{server.server_port}", flush=True)
        server.serve_forever(poll_interval=0.5)
