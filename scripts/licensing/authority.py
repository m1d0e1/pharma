"""Reference offline Ed25519 license issuer and single-machine authority.

The authority database contains operational state; it MUST live outside the
Pharma repository and application data directory. The Ed25519 seed is supplied
only by the issuer operator's environment, and is never stored here.

The signed wire envelope intentionally matches the Pharma native verifier:
  {"payload_b64":"base64url-without-padding(raw JSON bytes)",
   "signature_b64":"base64url-without-padding(64-byte Ed25519 signature)"}
"""

from __future__ import annotations

import base64
from contextlib import closing, contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time
import uuid
from typing import Any, Callable, Iterator

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)


LICENSE_ID = re.compile(r"^[A-Za-z0-9._-]{6,128}$")
MACHINE_FINGERPRINT = re.compile(r"^[a-f0-9]{64}$")
ACTOR = re.compile(r"^[A-Za-z0-9._@-]{1,100}$")
MAX_I64 = (1 << 63) - 1
MAX_LEASE_SECONDS = 24 * 60 * 60
REQUEST_SKEW_SECONDS = 300
NATIVE_CLOCK_TOLERANCE_SECONDS = 120
SIGNING_KEY_ENV = "PHARMA_LICENSE_ISSUER_SEED_B64"
OPERATOR_TOKEN_ENV = "PHARMA_AUTHORITY_OPERATOR_TOKEN"
DATABASE_ENV = "PHARMA_AUTHORITY_DB"
WIRE_FIELDS = frozenset(
    (
        "license_id",
        "machine_fingerprint",
        "issued_at_utc",
        "expires_at_utc",
        "lease_until_utc",
        "activation_serial",
        "revoked",
    )
)
OFFLINE_TERM_WIRE_FIELDS = WIRE_FIELDS | {"offline_term"}


class AuthorityError(Exception):
    """Expected public-facing error, always without bearer secrets."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class Rejected(AuthorityError):
    """Rejected activation, replay, authorization or stale state."""


class DurableCredentialRejection(Rejected):
    """Denial whose throttling evidence must commit, never roll back."""


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64url(value: str, *, expected_size: int | None = None) -> bytes:
    if not isinstance(value, str) or not value or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise Rejected("invalid_encoding", "Expected unpadded base64url data")
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, base64.binascii.Error) as exc:
        raise Rejected("invalid_encoding", "Invalid base64url data") from exc
    if _b64url(raw) != value or (expected_size is not None and len(raw) != expected_size):
        raise Rejected("invalid_encoding", "Noncanonical base64url data or invalid byte length")
    return raw


def _integer(value: Any, field: str, *, minimum: int = 0) -> int:
    if type(value) is not int or not minimum <= value <= MAX_I64:
        raise Rejected("invalid_input", f"{field} must be an integer in [{minimum}, i64::MAX]")
    return value


def _license_id(value: Any) -> str:
    if not isinstance(value, str) or not LICENSE_ID.fullmatch(value):
        raise Rejected("invalid_input", "license_id must be 6-128 ASCII letters, digits, dot, dash or underscore")
    return value


def _machine(value: Any) -> str:
    if not isinstance(value, str) or not MACHINE_FINGERPRINT.fullmatch(value):
        raise Rejected("invalid_input", "machine_fingerprint must be lowercase hex SHA-256 (64 chars)")
    return value


def _actor(value: Any) -> str:
    if not isinstance(value, str) or not ACTOR.fullmatch(value):
        raise Rejected("invalid_input", "actor_id must be nonempty ASCII identifier")
    return value


def load_signing_key(env: dict[str, str] | None = None) -> Ed25519PrivateKey:
    """Read a 32-byte Ed25519 seed from environment, never from a repo file."""
    value = (os.environ if env is None else env).get(SIGNING_KEY_ENV, "")
    if not value:
        raise AuthorityError("missing_key", f"{SIGNING_KEY_ENV} must be set in the operator environment")
    try:
        return Ed25519PrivateKey.from_private_bytes(_unb64url(value, expected_size=32))
    except ValueError as exc:
        raise AuthorityError("invalid_key", "Issuer seed must contain 32 bytes") from exc


def public_key_b64(key: Ed25519PrivateKey | Ed25519PublicKey) -> str:
    pub = key.public_key() if isinstance(key, Ed25519PrivateKey) else key
    return _b64url(pub.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    ))


def sign_payload(key: Ed25519PrivateKey, payload: dict[str, Any]) -> dict[str, str]:
    if frozenset(payload) not in (WIRE_FIELDS, OFFLINE_TERM_WIRE_FIELDS):
        raise AuthorityError("invalid_payload", "Signed payload keys do not match native protocol")
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return {"payload_b64": _b64url(raw), "signature_b64": _b64url(key.sign(raw))}


def verify_activation_envelope(
    envelope: dict[str, Any],
    public_key_raw_b64: str,
    *,
    machine_fingerprint: str,
    now_utc: int,
    license_id: str | None = None,
    minimum_serial: int = 0,
) -> dict[str, Any]:
    """Reference native-equivalent check. Caller must pin issuer public key.

    Offline revocation cannot invalidate an *older* unexpired signed token
    without a newer signed tombstone, or the lease expiring.
    """
    if not isinstance(envelope, dict) or set(envelope) != {"payload_b64", "signature_b64"}:
        raise Rejected("bad_envelope", "Expected the two-field native license envelope")
    if len(json.dumps(envelope)) > 16_384:
        raise Rejected("bad_envelope", "Native license envelope exceeds 16 KiB")
    raw = _unb64url(envelope["payload_b64"])
    signature = _unb64url(envelope["signature_b64"], expected_size=64)
    pub_bytes = _unb64url(public_key_raw_b64, expected_size=32)
    try:
        Ed25519PublicKey.from_public_bytes(pub_bytes).verify(signature, raw)
    except (InvalidSignature, ValueError) as exc:
        raise Rejected("bad_signature", "Ed25519 signature did not verify") from exc
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise Rejected("bad_payload", "Invalid signed JSON") from exc
    if type(payload) is not dict or set(payload) not in (WIRE_FIELDS, OFFLINE_TERM_WIRE_FIELDS):
        raise Rejected("bad_payload", "Signed JSON has unexpected or missing fields")
    _license_id(payload["license_id"])
    _machine(payload["machine_fingerprint"])
    _integer(payload["issued_at_utc"], "issued_at_utc")
    _integer(payload["expires_at_utc"], "expires_at_utc")
    offline_term = payload.get("offline_term", False)
    if type(offline_term) is not bool or ("offline_term" in payload and not offline_term):
        raise Rejected("bad_payload", "Explicit offline_term must be true")
    if offline_term:
        if payload["lease_until_utc"] is not None:
            raise Rejected("bad_payload", "Offline-term license must have no lease")
    else:
        _integer(payload["lease_until_utc"], "lease_until_utc")
    _integer(payload["activation_serial"], "activation_serial", minimum=1)
    _integer(now_utc, "now_utc")
    _integer(minimum_serial, "minimum_serial")
    if type(payload["revoked"]) is not bool:
        raise Rejected("bad_payload", "revoked must be JSON boolean")
    if payload["machine_fingerprint"] != _machine(machine_fingerprint):
        raise Rejected("wrong_machine", "License is bound to another machine")
    if license_id is not None and payload["license_id"] != _license_id(license_id):
        raise Rejected("wrong_license", "License identifier mismatch")
    if payload["activation_serial"] < minimum_serial:
        raise Rejected("superseded", "Signed license serial is older than trusted local status")
    if payload["revoked"]:
        raise Rejected("revoked", "License has been revoked")
    if payload["issued_at_utc"] > now_utc + NATIVE_CLOCK_TOLERANCE_SECONDS:
        raise Rejected("not_yet_valid", "Signed license is not valid before issued_at_utc")
    if not payload["issued_at_utc"] < payload["expires_at_utc"]:
        raise Rejected("bad_payload", "Invalid signed license term")
    if not offline_term:
        if not payload["issued_at_utc"] < payload["lease_until_utc"] <= payload["expires_at_utc"]:
            raise Rejected("bad_payload", "Invalid lease or expiry relation")
        if payload["lease_until_utc"] - payload["issued_at_utc"] > MAX_LEASE_SECONDS:
            raise Rejected("bad_payload", "Offline lease exceeds the native 24-hour cap")
        if now_utc >= payload["lease_until_utc"]:
            raise Rejected("expired", "Signed offline lease has expired")
    if now_utc >= payload["expires_at_utc"]:
        raise Rejected("expired", "Signed license term has expired")
    return payload


def _hash_code(code: str, salt: bytes) -> bytes:
    return hashlib.scrypt(code.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)


class Authority:
    """Single-writer SQLite authority; multiple processes serialize via BEGIN IMMEDIATE."""

    def __init__(
        self,
        database_path: str | Path,
        signing_key: Ed25519PrivateKey,
        *,
        operator_secret: str | None = None,
        clock: Callable[[], int] | None = None,
    ):
        supplied_path = Path(database_path).expanduser()
        if not supplied_path.is_absolute():
            raise AuthorityError("unsafe_path", "Authority database path must be absolute")
        self.path = supplied_path.resolve()
        repository_root = Path(__file__).resolve().parents[2]
        application_data = Path(os.environ.get("APPDATA", "/__no_appdata__")).resolve()
        if self.path == repository_root or repository_root in self.path.parents:
            raise AuthorityError("unsafe_path", "Authority state must reside outside the repository")
        pharma_app_dir = application_data / "com.pharma.system"
        if self.path == pharma_app_dir or pharma_app_dir in self.path.parents:
            raise AuthorityError("unsafe_path", "Authority state must not reside in the app's production DB directory")
        if not isinstance(signing_key, Ed25519PrivateKey):
            raise AuthorityError("invalid_key", "Ed25519 signing key required")
        secret = operator_secret if operator_secret is not None else os.environ.get(OPERATOR_TOKEN_ENV, "")
        if not isinstance(secret, str) or len(secret) < 32:
            raise AuthorityError("missing_operator_secret", f"{OPERATOR_TOKEN_ENV} must contain >=32 random characters")
        self._secret = secret
        self._key = signing_key
        self._clock = clock or (lambda: int(time.time()))
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @property
    def issuer_public_key_b64(self) -> str:
        return public_key_b64(self._key)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(str(self.path), timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=30000")
        db.execute("PRAGMA synchronous=FULL")
        return db

    def _initialize(self) -> None:
        # On a brand-new authority database, several concurrently starting
        # processes can all reach PRAGMA journal_mode=WAL while SQLite is
        # initializing the journal. That PRAGMA sometimes returns SQLITE_BUSY
        # immediately even with busy_timeout configured. Retry the entire
        # idempotent schema bootstrap; BEGIN IMMEDIATE below still pins signer
        # identity atomically once the schema is ready.
        for attempt in range(12):
            try:
                self._initialize_once()
                return
            except sqlite3.OperationalError as exc:
                if "locked" not in str(exc).lower() or attempt == 11:
                    raise
                time.sleep(min(0.05 * (2 ** attempt), 0.5))

    def _initialize_once(self) -> None:
        with closing(self._connect()) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute(
                """CREATE TABLE IF NOT EXISTS licenses (
                     license_id TEXT PRIMARY KEY,
                     activation_code_salt BLOB NOT NULL,
                     activation_code_hash BLOB NOT NULL,
                     expires_at_utc INTEGER NOT NULL,
                     lease_seconds INTEGER NOT NULL,
                     state TEXT NOT NULL CHECK (state IN ('available','active','revoked')),
                     machine_fingerprint TEXT,
                     activation_serial INTEGER NOT NULL DEFAULT 0,
                     created_at_utc INTEGER NOT NULL,
                     updated_at_utc INTEGER NOT NULL,
                     offline_term INTEGER NOT NULL DEFAULT 0 CHECK(offline_term IN (0,1)),
                     CHECK (activation_serial >= 0)
                   )"""
            )
            db.execute(
                """CREATE TABLE IF NOT EXISTS used_nonces (
                     request_nonce TEXT PRIMARY KEY,
                     license_id TEXT NOT NULL REFERENCES licenses(license_id),
                     machine_fingerprint TEXT NOT NULL,
                     issued_at_utc INTEGER NOT NULL,
                     activation_serial INTEGER NOT NULL
                   )"""
            )
            db.execute(
                """CREATE TABLE IF NOT EXISTS authority_events (
                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                     license_id TEXT NOT NULL REFERENCES licenses(license_id),
                     action TEXT NOT NULL,
                     actor_id TEXT NOT NULL,
                     previous_machine TEXT,
                     next_machine TEXT,
                     activation_serial INTEGER NOT NULL,
                     occurred_at_utc INTEGER NOT NULL
                   )"""
            )
            db.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL)")
            # Durable per-license credential throttling across processes and
            # issuer restarts. Deliberately no row for nonexistent IDs, which
            # would let random unauthenticated IDs consume unlimited space.
            db.execute(
                """CREATE TABLE IF NOT EXISTS activation_failures (
                     license_id TEXT PRIMARY KEY REFERENCES licenses(license_id),
                     failed_count INTEGER NOT NULL CHECK(failed_count >= 0),
                     retry_after_utc INTEGER NOT NULL
                   )"""
            )
            # Signed, machine-specific revocation receipts survive issuer
            # restarts and are deliverable to a former machine on its next
            # authenticated renewal. An unsigned HTTP error cannot revoke a
            # previously installed offline lease.
            db.execute(
                """CREATE TABLE IF NOT EXISTS revocation_receipts (
                     license_id TEXT NOT NULL REFERENCES licenses(license_id),
                     machine_fingerprint TEXT NOT NULL,
                     activation_serial INTEGER NOT NULL,
                     signed_envelope_json TEXT NOT NULL,
                     PRIMARY KEY (license_id, machine_fingerprint)
                   )"""
            )
            db.execute("CREATE TABLE IF NOT EXISTS issuer_identity (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            # A single authority DB must never silently switch its signer.
            # Pinning also catches loading the wrong operator environment key.
            db.execute("BEGIN IMMEDIATE")
            try:
                expected_public = self.issuer_public_key_b64
                current = db.execute(
                    "SELECT value FROM issuer_identity WHERE key='issuer_public_key_b64'"
                ).fetchone()
                if current is not None and current["value"] != expected_public:
                    raise AuthorityError("signer_mismatch", "Authority state belongs to a different Ed25519 issuer key")
                if current is None:
                    db.execute(
                        "INSERT INTO issuer_identity(key,value) VALUES('issuer_public_key_b64',?)",
                        (expected_public,),
                    )
                # Additive migration; serialized under the issuer's writer
                # transaction. Existing leased records remain offline_term=0.
                columns = {row["name"] for row in db.execute("PRAGMA table_info(licenses)")}
                if "offline_term" not in columns:
                    db.execute("ALTER TABLE licenses ADD COLUMN offline_term INTEGER NOT NULL DEFAULT 0 CHECK(offline_term IN (0,1))")
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.execute("COMMIT")
            except DurableCredentialRejection:
                # BEGIN IMMEDIATE makes failed-attempt counters atomic, and
                # rollback here would silently disable the throttle.
                db.execute("COMMIT")
                raise
            except BaseException:
                db.execute("ROLLBACK")
                raise
        finally:
            db.close()

    def _now(self, db: sqlite3.Connection) -> int:
        now = _integer(self._clock(), "system clock", minimum=1)
        row = db.execute("SELECT value FROM metadata WHERE key='last_seen_utc'").fetchone()
        if row is not None and now < row["value"]:
            raise Rejected("clock_rollback", "Issuer clock moved backwards; correct the system clock")
        db.execute(
            "INSERT INTO metadata(key,value) VALUES('last_seen_utc',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (now,),
        )
        return now

    def _authorize(self, credential: Any) -> None:
        if not isinstance(credential, str) or not hmac.compare_digest(credential, self._secret):
            raise Rejected("unauthorized", "Valid operator credential required")

    def _verify_activation_code(
        self, db: sqlite3.Connection, license_row: sqlite3.Row, code: str, now: int,
    ) -> None:
        license_id = license_row["license_id"]
        attempts = db.execute(
            "SELECT failed_count,retry_after_utc FROM activation_failures WHERE license_id=?",
            (license_id,),
        ).fetchone()
        if attempts is not None and now < attempts["retry_after_utc"]:
            raise Rejected("rate_limited", "Try activation again after the cooldown period")
        if hmac.compare_digest(_hash_code(code, license_row["activation_code_salt"]),
                               license_row["activation_code_hash"]):
            db.execute("DELETE FROM activation_failures WHERE license_id=?", (license_id,))
            return
        failed_count = min(32, (attempts["failed_count"] if attempts else 0) + 1)
        # Start after four guesses. Bounded exponential cooldown is enforced
        # before scrypt, preventing CPU exhaustion by repeated guessed codes.
        backoff = min(900, 2 ** (failed_count - 4)) if failed_count >= 5 else 0
        db.execute(
            "INSERT INTO activation_failures(license_id,failed_count,retry_after_utc) VALUES(?,?,?) "
            "ON CONFLICT(license_id) DO UPDATE SET failed_count=excluded.failed_count, "
            "retry_after_utc=excluded.retry_after_utc",
            (license_id, failed_count, now + backoff),
        )
        raise DurableCredentialRejection("invalid_credentials", "Invalid license identifier or activation code")

    def _event(
        self, db: sqlite3.Connection, license_id: str, action: str,
        actor_id: str, previous: str | None, next_machine: str | None,
        serial: int, now: int,
    ) -> None:
        db.execute(
            "INSERT INTO authority_events(license_id,action,actor_id,previous_machine,"
            "next_machine,activation_serial,occurred_at_utc) VALUES(?,?,?,?,?,?,?)",
            (license_id, action, actor_id, previous, next_machine, serial, now),
        )

    def _signed(
        self, license_id: str, machine: str, now: int,
        expires: int, lease: int | None, serial: int, *, revoked: bool = False,
        offline_term: bool = False,
    ) -> dict[str, str]:
        payload = {
            "license_id": license_id,
            "machine_fingerprint": machine,
            "issued_at_utc": now,
            "expires_at_utc": expires,
            "lease_until_utc": lease,
            "activation_serial": serial,
            "revoked": revoked,
        }
        if offline_term:
            if lease is not None or revoked:
                raise AuthorityError("invalid_payload", "Offline grant requires no lease and cannot revoke")
            payload["offline_term"] = True
        return sign_payload(self._key, payload)

    def _validated_revocation_receipt(
        self, stored: sqlite3.Row, license_row: sqlite3.Row,
        machine: str, now: int,
    ) -> dict[str, str]:
        """Fail closed on corrupted/rolled-back authority receipt storage.

        A valid old *activation* envelope can have a genuine signature and the
        same license/device identity. It must never be replayed as an issuer's
        revocation response. Checking a signature alone is insufficient: the
        persisted receipt must match its own serial, the current DB license,
        and the exact revoked-only envelope that this issuer would have signed.
        The database schema and native wire envelope are unchanged.
        """
        def unique_fields(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("Duplicate stored receipt field")
                result[key] = value
            return result

        def reject_nonfinite(_value: str) -> None:
            raise ValueError("Non-finite stored receipt JSON number")

        try:
            raw = stored["signed_envelope_json"]
            # Check character length *before* encoding. An oversized malformed
            # DB value must not allocate a second arbitrarily large byte copy.
            if (type(raw) is not str or not 0 < len(raw) <= 16_384
                    or len(raw.encode("utf-8")) > 16_384):
                raise ValueError("Invalid stored receipt size")
            envelope = json.loads(raw, object_pairs_hook=unique_fields,
                                  parse_constant=reject_nonfinite)
            if type(envelope) is not dict or set(envelope) != {"payload_b64", "signature_b64"}:
                raise ValueError("Invalid stored receipt envelope")
            payload_raw = _unb64url(envelope["payload_b64"])
            _unb64url(envelope["signature_b64"], expected_size=64)
            payload = json.loads(payload_raw, object_pairs_hook=unique_fields,
                                 parse_constant=reject_nonfinite)
            if type(payload) is not dict or set(payload) != WIRE_FIELDS:
                raise ValueError("Invalid signed receipt payload")
            issued = _integer(payload["issued_at_utc"], "receipt issued_at_utc", minimum=1)
            serial = _integer(stored["activation_serial"], "receipt serial", minimum=1)
            current_serial = _integer(license_row["activation_serial"], "license serial")
            updated_at = _integer(license_row["updated_at_utc"], "license updated_at_utc")
            if (license_row["state"] not in ("active", "revoked")
                    or issued > now or issued > updated_at
                    or serial > current_serial):
                raise ValueError("Stored receipt disagrees with current license state")
            expected = self._signed(
                license_row["license_id"], machine, issued,
                license_row["expires_at_utc"], issued, serial, revoked=True,
            )
            if envelope != expected:
                raise ValueError("Stored receipt does not match an authentic tombstone")
            return expected
        except (Rejected, TypeError, ValueError, KeyError, UnicodeError,
                OverflowError, RecursionError) as exc:
            # Do not leak tampered database contents, credential data, or raw
            # parsing/signature exceptions through the public HTTPS endpoint.
            raise AuthorityError("authority_state_invalid",
                                 "Stored revocation receipt failed integrity checks") from exc

    def create_license(
        self, *, expires_at_utc: int, operator_token: str,
        actor_id: str, license_id: str | None = None,
        lease_seconds: int = MAX_LEASE_SECONDS,
    ) -> dict[str, Any]:
        self._authorize(operator_token)
        actor_id = _actor(actor_id)
        expires_at_utc = _integer(expires_at_utc, "expires_at_utc", minimum=1)
        lease_seconds = _integer(lease_seconds, "lease_seconds", minimum=1)
        if lease_seconds > MAX_LEASE_SECONDS:
            raise Rejected("invalid_input", "Lease exceeds native verifier's 24-hour upper bound")
        license_id = _license_id(license_id or f"pharma-{uuid.uuid4()}")
        code = secrets.token_urlsafe(32)
        salt = secrets.token_bytes(16)
        digest = _hash_code(code, salt)
        with self._transaction() as db:
            now = self._now(db)
            if expires_at_utc <= now:
                raise Rejected("expired", "License expiry must be strictly in the future")
            try:
                db.execute(
                    "INSERT INTO licenses(license_id,activation_code_salt,activation_code_hash,"
                    "expires_at_utc,lease_seconds,state,created_at_utc,updated_at_utc)"
                    " VALUES(?,?,?,?,?,'available',?,?)",
                    (license_id, salt, digest, expires_at_utc, lease_seconds, now, now),
                )
            except sqlite3.IntegrityError as exc:
                raise Rejected("already_exists", "License ID already exists") from exc
            self._event(db, license_id, "create", actor_id, None, None, 0, now)
        # Secret is revealed once and must be delivered to the entitled customer securely.
        return {"license_id": license_id, "activation_code": code, "expires_at_utc": expires_at_utc}

    def issue_offline_license(
        self, *, machine_fingerprint: str, expires_at_utc: int,
        actor_id: str, operator_token: str, license_id: str | None = None,
    ) -> dict[str, Any]:
        """Owner-only, first-time, device-bound offline issuance.

        This directly signs an offline-term grant. There is deliberately no
        activation code to deliver or online first-use step. The unreturned,
        high-entropy placeholder in the existing authority credential columns
        cannot be recovered by customers or used for remote renewal.
        """
        self._authorize(operator_token)
        actor_id = _actor(actor_id)
        machine = _machine(machine_fingerprint)
        expires_at_utc = _integer(expires_at_utc, "expires_at_utc", minimum=1)
        license_id = _license_id(license_id or f"pharma-{uuid.uuid4()}")
        unavailable_code = secrets.token_urlsafe(32)
        salt = secrets.token_bytes(16)
        digest = _hash_code(unavailable_code, salt)
        with self._transaction() as db:
            now = self._now(db)
            if expires_at_utc <= now:
                raise Rejected("expired", "Offline license expiry must be in the future")
            serial = 1
            envelope = self._signed(
                license_id, machine, now, expires_at_utc,
                None, serial, offline_term=True,
            )
            try:
                db.execute(
                    "INSERT INTO licenses(license_id,activation_code_salt,activation_code_hash,"
                    "expires_at_utc,lease_seconds,state,machine_fingerprint,activation_serial,"
                    "created_at_utc,updated_at_utc,offline_term)"
                    " VALUES(?,?,?,?,?,'active',?,?,?,?,1)",
                    (license_id, salt, digest, expires_at_utc, MAX_LEASE_SECONDS,
                     machine, serial, now, now),
                )
            except sqlite3.IntegrityError as exc:
                raise Rejected("already_exists", "License ID already exists") from exc
            self._event(db, license_id, "issue_offline", actor_id, None, machine, serial, now)
        return {
            "license_id": license_id,
            "expires_at_utc": expires_at_utc,
            "activation_serial": serial,
            "activation": envelope,
        }

    def extend_term(
        self, *, license_id: str, expected_serial: int,
        expected_expires_at_utc: int, expires_at_utc: int,
        actor_id: str, operator_token: str,
    ) -> dict[str, Any]:
        """Operator-only same-license paid-term extension; never rebind devices.

        A bound installation receives a NEW higher-serial signed lease, using
        the original license ID and machine. An unbound unused activation code
        remains unchanged. Neither a stale operator request nor a revocation
        can be bypassed by issuing a second license for the same installation.
        """
        self._authorize(operator_token)
        license_id = _license_id(license_id)
        serial = _integer(expected_serial, "expected_serial")
        old_expiry = _integer(expected_expires_at_utc, "expected_expires_at_utc", minimum=1)
        new_expiry = _integer(expires_at_utc, "expires_at_utc", minimum=1)
        actor_id = _actor(actor_id)
        with self._transaction() as db:
            now = self._now(db)
            row = db.execute("SELECT * FROM licenses WHERE license_id=?", (license_id,)).fetchone()
            if row is None:
                raise Rejected("not_found", "License not found")
            if row["state"] == "revoked":
                raise Rejected("revoked", "Revoked license cannot be extended")
            if row["activation_serial"] != serial or row["expires_at_utc"] != old_expiry:
                raise Rejected("stale_state", "License serial or original term has changed")
            if new_expiry <= max(now, old_expiry):
                raise Rejected("invalid_input", "New license term must extend past existing expiry and issuer time")
            machine = row["machine_fingerprint"]
            if (row["state"] == "active" and machine is None) or (
                row["state"] == "available" and (machine is not None or serial != 0)
            ):
                raise AuthorityError("authority_state_invalid", "License state has contradictory device custody")
            next_serial = serial + 1 if machine is not None else serial
            if next_serial > MAX_I64:
                raise Rejected("serial_exhausted", "Activation serial is exhausted")
            activation = None
            if machine is not None:
                offline = bool(row["offline_term"])
                lease = None if offline else min(now + row["lease_seconds"], new_expiry)
                if not offline and (lease <= now or lease - now > MAX_LEASE_SECONDS):
                    raise AuthorityError("authority_state_invalid", "Invalid stored license lease bounds")
                activation = self._signed(license_id, machine, now,
                                          new_expiry, lease, next_serial, offline_term=offline)
            db.execute("UPDATE licenses SET expires_at_utc=?,activation_serial=?,updated_at_utc=? "
                       "WHERE license_id=?", (new_expiry, next_serial, now, license_id))
            self._event(db, license_id, "extend_term", actor_id, machine,
                        machine, next_serial, now)
            return {"license_id": license_id, "expires_at_utc": new_expiry,
                    "activation_serial": next_serial, "activation": activation}

    def convert_to_offline_term(
        self, *, license_id: str, expected_serial: int,
        expected_expires_at_utc: int, actor_id: str, operator_token: str,
    ) -> dict[str, Any]:
        """Operator-authorized once-only upgrade to fully offline signed term.

        Never alter expiry, device binding, signing key, or revocation status.
        The upgrade gets a new signed serial and is auditable and transactional.
        """
        self._authorize(operator_token)
        license_id = _license_id(license_id)
        serial = _integer(expected_serial, "expected_serial", minimum=1)
        expiry = _integer(expected_expires_at_utc, "expected_expires_at_utc", minimum=1)
        actor_id = _actor(actor_id)
        with self._transaction() as db:
            now = self._now(db)
            row = db.execute("SELECT * FROM licenses WHERE license_id=?", (license_id,)).fetchone()
            if row is None:
                raise Rejected("not_found", "License not found")
            if row["state"] != "active" or not row["machine_fingerprint"]:
                raise Rejected("invalid_state", "Only a bound active license may be converted")
            if row["activation_serial"] != serial or row["expires_at_utc"] != expiry:
                raise Rejected("stale_state", "Expected license generation/expiry does not match")
            if row["offline_term"]:
                raise Rejected("already_offline", "License is already an offline term")
            if now >= expiry or serial >= MAX_I64:
                raise Rejected("expired", "License is expired or cannot advance serial")
            next_serial = serial + 1
            signed = self._signed(license_id, row["machine_fingerprint"], now, expiry,
                                  None, next_serial, offline_term=True)
            db.execute("UPDATE licenses SET offline_term=1,activation_serial=?,updated_at_utc=? "
                       "WHERE license_id=?", (next_serial, now, license_id))
            self._event(db, license_id, "convert_offline_term", actor_id,
                        row["machine_fingerprint"], row["machine_fingerprint"], next_serial, now)
            return {"license_id": license_id, "expires_at_utc": expiry,
                    "activation_serial": next_serial, "activation": signed}

    def activate(
        self, *, license_id: str, machine_fingerprint: str, activation_code: str,
        request_nonce: str, requested_at_utc: int,
    ) -> dict[str, str]:
        license_id = _license_id(license_id)
        machine = _machine(machine_fingerprint)
        _unb64url(request_nonce, expected_size=32)
        requested_at_utc = _integer(requested_at_utc, "requested_at_utc")
        if not isinstance(activation_code, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", activation_code):
            raise Rejected("invalid_credentials", "Invalid license activation code")
        with self._transaction() as db:
            now = self._now(db)
            if abs(requested_at_utc - now) > REQUEST_SKEW_SECONDS:
                raise Rejected("stale_request", "Activation request outside issuer clock window")
            if db.execute("SELECT 1 FROM used_nonces WHERE request_nonce=?", (request_nonce,)).fetchone():
                raise Rejected("replay", "Activation nonce has already been consumed")
            license_row = db.execute("SELECT * FROM licenses WHERE license_id=?", (license_id,)).fetchone()
            if license_row is None:
                raise Rejected("invalid_credentials", "Invalid license identifier or activation code")
            self._verify_activation_code(db, license_row, activation_code, now)
            receipt = db.execute(
                "SELECT activation_serial,signed_envelope_json FROM revocation_receipts "
                "WHERE license_id=? AND machine_fingerprint=?",
                (license_id, machine),
            ).fetchone()
            if receipt is not None:
                # The caller proved knowledge of this exact license's secret,
                # and the response is already bound to their machine and key.
                # Validate persisted proof *before* consuming a nonce: a
                # substituted older authentic grant must never recover rights.
                tombstone = self._validated_revocation_receipt(receipt, license_row, machine, now)
                db.execute(
                    "INSERT INTO used_nonces(request_nonce,license_id,machine_fingerprint,issued_at_utc,activation_serial)"
                    " VALUES(?,?,?,?,?)", (request_nonce, license_id, machine, now, receipt["activation_serial"]),
                )
                return tombstone
            if license_row["state"] == "revoked":
                raise Rejected("revoked", "License was revoked")
            if now >= license_row["expires_at_utc"]:
                raise Rejected("expired", "License has expired")
            current = license_row["machine_fingerprint"]
            if current is not None and current != machine:
                raise Rejected("machine_bound", "License is already bound to another machine")
            serial = license_row["activation_serial"] + 1
            if serial > MAX_I64:
                raise Rejected("serial_exhausted", "Activation serial is exhausted")
            offline = bool(license_row["offline_term"])
            lease = None if offline else min(license_row["expires_at_utc"], now + license_row["lease_seconds"])
            if not offline and lease <= now:
                raise Rejected("expired", "No remaining license lease")
            signed = self._signed(license_id, machine, now, license_row["expires_at_utc"], lease, serial,
                                  offline_term=offline)
            db.execute(
                "UPDATE licenses SET state='active',machine_fingerprint=?,activation_serial=?,updated_at_utc=? "
                "WHERE license_id=?", (machine, serial, now, license_id),
            )
            # An operator may later deliberately reauthorize a former device.
            db.execute("DELETE FROM revocation_receipts WHERE license_id=? AND machine_fingerprint=?",
                       (license_id, machine))
            db.execute(
                "INSERT INTO used_nonces(request_nonce,license_id,machine_fingerprint,issued_at_utc,activation_serial)"
                " VALUES(?,?,?,?,?)", (request_nonce, license_id, machine, now, serial),
            )
            self._event(db, license_id, "activate", "license_holder", current, machine, serial, now)
            return signed

    def reassign(
        self, *, license_id: str, expected_machine_fingerprint: str,
        new_machine_fingerprint: str, expected_serial: int, actor_id: str,
        operator_token: str,
    ) -> dict[str, dict[str, str]]:
        self._authorize(operator_token)
        license_id = _license_id(license_id)
        old = _machine(expected_machine_fingerprint)
        new = _machine(new_machine_fingerprint)
        serial = _integer(expected_serial, "expected_serial", minimum=1)
        _actor(actor_id)
        if old == new:
            raise Rejected("invalid_input", "New machine must differ from current machine")
        with self._transaction() as db:
            now = self._now(db)
            row = db.execute("SELECT * FROM licenses WHERE license_id=?", (license_id,)).fetchone()
            if row is None:
                raise Rejected("not_found", "License not found")
            if row["state"] == "revoked":
                raise Rejected("revoked", "License was revoked")
            if row["state"] != "active" or row["machine_fingerprint"] != old or row["activation_serial"] != serial:
                raise Rejected("stale_state", "Expected binding/serial does not match current authority state")
            if now >= row["expires_at_utc"]:
                raise Rejected("expired", "License has expired")
            # Old-machine tombstone and new-machine grant occupy distinct
            # monotonic serials. Deliver the tombstone to the old installation.
            tombstone_serial = serial + 1
            new_serial = serial + 2
            if new_serial > MAX_I64:
                raise Rejected("serial_exhausted", "Activation serial is exhausted")
            offline = bool(row["offline_term"])
            lease = None if offline else min(now + row["lease_seconds"], row["expires_at_utc"])
            revoked_old = self._signed(license_id, old, now, row["expires_at_utc"], now,
                                       tombstone_serial, revoked=True)
            db.execute(
                "INSERT OR REPLACE INTO revocation_receipts"
                "(license_id,machine_fingerprint,activation_serial,signed_envelope_json) VALUES(?,?,?,?)",
                (license_id, old, tombstone_serial, json.dumps(revoked_old, separators=(",", ":"))),
            )
            activation = self._signed(license_id, new, now, row["expires_at_utc"], lease, new_serial,
                                      offline_term=offline)
            db.execute(
                "UPDATE licenses SET machine_fingerprint=?,activation_serial=?,updated_at_utc=? WHERE license_id=?",
                (new, new_serial, now, license_id),
            )
            db.execute("DELETE FROM revocation_receipts WHERE license_id=? AND machine_fingerprint=?",
                       (license_id, new))
            self._event(db, license_id, "reassign", actor_id, old, new, new_serial, now)
            return {"activation": activation, "revocation": revoked_old}

    def revoke(
        self, *, license_id: str, expected_serial: int, actor_id: str, operator_token: str,
    ) -> dict[str, str] | None:
        self._authorize(operator_token)
        license_id = _license_id(license_id)
        serial = _integer(expected_serial, "expected_serial", minimum=0)
        _actor(actor_id)
        with self._transaction() as db:
            now = self._now(db)
            row = db.execute("SELECT * FROM licenses WHERE license_id=?", (license_id,)).fetchone()
            if row is None:
                raise Rejected("not_found", "License not found")
            if row["state"] == "revoked":
                raise Rejected("revoked", "License already revoked")
            if serial != row["activation_serial"]:
                raise Rejected("stale_state", "Expected serial does not match current authority state")
            new_serial = serial + 1
            if new_serial > MAX_I64:
                raise Rejected("serial_exhausted", "Activation serial is exhausted")
            db.execute(
                "UPDATE licenses SET state='revoked',activation_serial=?,updated_at_utc=? WHERE license_id=?",
                (new_serial, now, license_id),
            )
            self._event(db, license_id, "revoke", actor_id, row["machine_fingerprint"],
                        None, new_serial, now)
            if row["machine_fingerprint"] is None:
                return None
            tombstone = self._signed(license_id, row["machine_fingerprint"], now,
                                     row["expires_at_utc"], now, new_serial, revoked=True)
            db.execute(
                "INSERT OR REPLACE INTO revocation_receipts"
                "(license_id,machine_fingerprint,activation_serial,signed_envelope_json) VALUES(?,?,?,?)",
                (license_id, row["machine_fingerprint"], new_serial,
                 json.dumps(tombstone, separators=(",", ":"))),
            )
            return tombstone

    def status(self, *, license_id: str, operator_token: str) -> dict[str, Any]:
        self._authorize(operator_token)
        license_id = _license_id(license_id)
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT license_id,state,machine_fingerprint,activation_serial,expires_at_utc,"
                "lease_seconds,offline_term,created_at_utc,updated_at_utc FROM licenses WHERE license_id=?",
                (license_id,),
            ).fetchone()
            if row is None:
                raise Rejected("not_found", "License not found")
            return dict(row)
