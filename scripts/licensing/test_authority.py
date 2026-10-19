"""Security-oriented tests for the offline issuer and native wire format.

Run: python -m unittest discover -s scripts/licensing -p 'test_*.py' -v
Uses only ephemeral keys in memory and SQLite files in OS temporary directories.
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import http.client
import json
import multiprocessing
import os
import socket
import ssl
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives import hashes
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from scripts.licensing.authority import (
    Authority,
    AuthorityError,
    Rejected,
    _b64url,
    public_key_b64,
    verify_activation_envelope,
)
from scripts.licensing.cli import dispatch
from scripts.licensing.server import (
    OfflineAuthorityHTTPServer, HTTPSActivationServer, SourceRequestLimiter,
    strict_activation_json,
)


ACTOR = "operator-001"
OPERATOR_TOKEN = "correct-horse-battery-issuer-demo-test-only-256bits"
MACHINE_A = "a" * 64
MACHINE_B = "b" * 64
MACHINE_C = "c" * 64


def process_activate(arguments):
    """Module-level picklable helper to verify SQLite locking across processes."""
    db_path, seed_bytes, license_id, code, machine, nonce = arguments
    key = Ed25519PrivateKey.from_private_bytes(seed_bytes)
    authority = Authority(db_path, key, operator_secret=OPERATOR_TOKEN, clock=lambda: 3000)
    try:
        return ("ok", machine, authority.activate(
            license_id=license_id, machine_fingerprint=machine,
            activation_code=code, request_nonce=nonce, requested_at_utc=3000,
        ))
    except Rejected as exc:
        return ("error", machine, exc.code)


class FixedClock:
    def __init__(self, instant: int):
        self.instant = instant

    def __call__(self):
        return self.instant


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pharma-license-test-")
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / "authority.sqlite"
        self.key = Ed25519PrivateKey.generate()
        self.clock = FixedClock(1000)
        self.authority = Authority(
            self.db_path, self.key,
            operator_secret=OPERATOR_TOKEN, clock=self.clock,
        )
        self.public = public_key_b64(self.key)

    def issue(self, *, expires=2000, lease=100):
        return self.authority.create_license(
            expires_at_utc=expires, lease_seconds=lease,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )

    def activate(self, license_id, code, *, machine=MACHINE_A, nonce_byte=0, requested_at=None):
        return self.authority.activate(
            license_id=license_id, machine_fingerprint=machine,
            activation_code=code, request_nonce=_b64url(bytes([nonce_byte]) * 32),
            requested_at_utc=self.clock.instant if requested_at is None else requested_at,
        )

    def assert_code(self, code: str, call):
        with self.assertRaises(Rejected) as context:
            call()
        self.assertEqual(context.exception.code, code)

    def verify(self, envelope, *, machine=MACHINE_A, now=None, minimum_serial=0):
        return verify_activation_envelope(
            envelope, self.public, machine_fingerprint=machine,
            now_utc=self.clock.instant if now is None else now,
            minimum_serial=minimum_serial,
        )

    def test_first_time_manual_offline_issuance_needs_no_online_activation(self):
        grant = dispatch(self.authority, "issue-offline", {
            "machine_fingerprint": MACHINE_A,
            "expires_at_utc": 3000,
            "actor_id": ACTOR,
            "operator_token": OPERATOR_TOKEN,
        })
        self.assertNotIn("activation_code", grant)
        self.assertEqual(grant["activation_serial"], 1)
        claims = self.verify(grant["activation"])
        self.assertEqual(claims["license_id"], grant["license_id"])
        self.assertEqual(claims["activation_serial"], 1)
        self.assertTrue(claims["offline_term"])
        self.assertIsNone(claims["lease_until_utc"])
        self.assert_code("wrong_machine", lambda: self.verify(grant["activation"], machine=MACHINE_B))
        self.assert_code("expired", lambda: self.verify(grant["activation"], now=3000))
        state = self.authority.status(license_id=grant["license_id"], operator_token=OPERATOR_TOKEN)
        self.assertEqual(state["offline_term"], 1)
        self.assertEqual(state["activation_serial"], 1)
        self.assertEqual(state["machine_fingerprint"], MACHINE_A)
        extended = self.authority.extend_term(
            license_id=grant["license_id"], expected_serial=1,
            expected_expires_at_utc=3000, expires_at_utc=5000,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        self.assertEqual(extended["activation_serial"], 2)
        self.assertEqual(self.verify(extended["activation"], now=3001)["expires_at_utc"], 5000)
        self.assertTrue(self.verify(extended["activation"], now=3001)["offline_term"])
        self.assert_code("superseded", lambda: self.verify(
            grant["activation"], now=1500, minimum_serial=2))

    def test_manual_offline_issuance_is_operator_only_and_not_a_renewal_bypass(self):
        args = {
            "machine_fingerprint": MACHINE_A, "expires_at_utc": 3000,
            "actor_id": ACTOR, "operator_token": OPERATOR_TOKEN,
            "license_id": "pharma-manual-offline",
        }
        self.assert_code("unauthorized", lambda: dispatch(
            self.authority, "issue-offline", {**args, "operator_token": "not-authorized"}))
        self.assert_code("invalid_input", lambda: dispatch(
            self.authority, "issue-offline", {**args, "machine_fingerprint": MACHINE_B.upper()}))
        self.assert_code("invalid_input", lambda: dispatch(
            self.authority, "issue-offline", {**args, "expires_at_utc": "3000"}))
        self.assert_code("invalid_input", lambda: dispatch(
            self.authority, "issue-offline", {**args, "lease_seconds": 86400}))
        self.assert_code("expired", lambda: dispatch(
            self.authority, "issue-offline", {**args, "expires_at_utc": 999}))
        first = dispatch(self.authority, "issue-offline", args)
        self.assert_code("already_exists", lambda: dispatch(
            self.authority, "issue-offline", args))
        self.assertEqual(self.verify(first["activation"])["activation_serial"], 1)
        self.assert_code("invalid_credentials", lambda: self.activate(
            first["license_id"], "A" * 43, nonce_byte=61))

    def test_offline_term_is_explicit_operator_signed_and_no_daily_lease(self):
        issued = self.issue(expires=1000 + 15 * 86400, lease=100)
        bound = self.activate(issued["license_id"], issued["activation_code"], nonce_byte=19)
        self.assertEqual(self.verify(bound, now=1099)["activation_serial"], 1)
        self.assert_code("expired", lambda: self.verify(bound, now=1100))
        self.assert_code("unauthorized", lambda: self.authority.convert_to_offline_term(
            license_id=issued["license_id"], expected_serial=1,
            expected_expires_at_utc=issued["expires_at_utc"],
            actor_id=ACTOR, operator_token="wrong",
        ))
        result = self.authority.convert_to_offline_term(
            license_id=issued["license_id"], expected_serial=1,
            expected_expires_at_utc=issued["expires_at_utc"],
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        signed = result["activation"]
        claims = self.verify(signed, now=issued["expires_at_utc"] - 1)
        self.assertIs(claims["offline_term"], True)
        self.assertIsNone(claims["lease_until_utc"])
        self.assertEqual(claims["activation_serial"], 2)
        self.assertEqual(claims["expires_at_utc"], issued["expires_at_utc"])
        self.assert_code("expired", lambda: self.verify(signed, now=issued["expires_at_utc"]))
        self.assert_code("wrong_machine", lambda: self.verify(signed, machine=MACHINE_B))
        self.assert_code("superseded", lambda: self.verify(bound, minimum_serial=2))
        self.assert_code("already_offline", lambda: self.authority.convert_to_offline_term(
            license_id=issued["license_id"], expected_serial=2,
            expected_expires_at_utc=issued["expires_at_utc"],
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        ))
        self.assertEqual(self.authority.status(
            license_id=issued["license_id"], operator_token=OPERATOR_TOKEN,
        )["offline_term"], 1)

        self.clock.instant = 1200
        reissued = self.activate(issued["license_id"], issued["activation_code"], nonce_byte=20)
        self.assertTrue(self.verify(reissued, now=issued["expires_at_utc"] - 1)["offline_term"])
        self.assertEqual(self.verify(reissued)["activation_serial"], 3)

    def test_offline_term_tamper_and_revocation_still_fail_closed(self):
        issued = self.issue(expires=100000, lease=100)
        first = self.activate(issued["license_id"], issued["activation_code"], nonce_byte=21)
        offline = self.authority.convert_to_offline_term(
            license_id=issued["license_id"], expected_serial=1,
            expected_expires_at_utc=issued["expires_at_utc"], actor_id=ACTOR,
            operator_token=OPERATOR_TOKEN,
        )["activation"]
        self.assertTrue(self.verify(offline)["offline_term"])
        payload = json.loads(base64.urlsafe_b64decode(offline["payload_b64"] + "==="))
        for edited_field, edited_value in (("offline_term", False),
                                           ("lease_until_utc", 100000),
                                           ("expires_at_utc", 200000)):
            modified = dict(payload)
            modified[edited_field] = edited_value
            bad = dict(offline)
            bad["payload_b64"] = _b64url(json.dumps(modified).encode())
            self.assert_code("bad_signature", lambda b=bad: self.verify(b))
        bad_mode = dict(payload)
        bad_mode["offline_term"] = False
        bad_signed = {"payload_b64": _b64url(json.dumps(bad_mode).encode()),
                      "signature_b64": ""}
        encoded = base64.urlsafe_b64decode(bad_signed["payload_b64"] + "===")
        bad_signed["signature_b64"] = _b64url(self.key.sign(encoded))
        self.assert_code("bad_payload", lambda: self.verify(bad_signed))
        self.assert_code("stale_state", lambda: self.authority.convert_to_offline_term(
            license_id=issued["license_id"], expected_serial=1,
            expected_expires_at_utc=issued["expires_at_utc"], actor_id=ACTOR,
            operator_token=OPERATOR_TOKEN,
        ))
        revoked = self.authority.revoke(license_id=issued["license_id"],
                                        expected_serial=2, actor_id=ACTOR,
                                        operator_token=OPERATOR_TOKEN)
        self.assertIsNotNone(revoked)
        self.assert_code("revoked", lambda: self.verify(revoked))
        self.assert_code("invalid_state", lambda: self.authority.convert_to_offline_term(
            license_id=issued["license_id"], expected_serial=3,
            expected_expires_at_utc=issued["expires_at_utc"], actor_id=ACTOR,
            operator_token=OPERATOR_TOKEN,
        ))
        delivered_tombstone = self.activate(
            issued["license_id"], issued["activation_code"], nonce_byte=22,
        )
        self.assert_code("revoked", lambda: self.verify(delivered_tombstone))

    def test_offline_term_reassignment_is_signed_and_old_machine_revoked(self):
        issued = self.issue(expires=100000, lease=100)
        self.activate(issued["license_id"], issued["activation_code"], nonce_byte=27)
        self.authority.convert_to_offline_term(
            license_id=issued["license_id"], expected_serial=1,
            expected_expires_at_utc=issued["expires_at_utc"], actor_id=ACTOR,
            operator_token=OPERATOR_TOKEN,
        )
        moved = self.authority.reassign(license_id=issued["license_id"],
            expected_machine_fingerprint=MACHINE_A, new_machine_fingerprint=MACHINE_B,
            expected_serial=2, actor_id=ACTOR, operator_token=OPERATOR_TOKEN)
        self.assertEqual(self.verify(moved["activation"], machine=MACHINE_B)["activation_serial"], 4)
        self.assertTrue(self.verify(moved["activation"], machine=MACHINE_B)["offline_term"])
        self.assert_code("revoked", lambda: self.verify(moved["revocation"], machine=MACHINE_A))
        self.assert_code("wrong_machine", lambda: self.verify(
            moved["activation"], machine=MACHINE_A))

    def test_source_rate_limiter_rejects_abuse_but_keeps_other_sources_healthy(self):
        monotonic = FixedClock(0)
        limiter = SourceRequestLimiter(
            burst=3, window_seconds=30, max_sources=4, idle_seconds=120,
            clock=monotonic,
        )
        for _ in range(3):
            self.assertIsNone(limiter.admit("198.51.100.10"))
        self.assertEqual(limiter.admit("198.51.100.10"), 10)
        self.assertEqual(limiter.admit("198.51.100.10"), 10)
        self.assertIsNone(limiter.admit("198.51.100.11"))
        monotonic.instant = 9
        self.assertEqual(limiter.admit("198.51.100.10"), 1)
        monotonic.instant = 10
        self.assertIsNone(limiter.admit("198.51.100.10"))
        self.assertIsNone(limiter.admit("198.51.100.11"))
        # A clock going backwards cannot refill more than the burst or admit
        # requests for free. Production uses time.monotonic(), not wall UTC.
        monotonic.instant = 0
        self.assertIsNone(limiter.admit("198.51.100.12"))
        self.assertLessEqual(len(limiter._sources), limiter.max_sources)
        # Expected operational boundary: state lives in this server process,
        # not on disk or across deployments. The production gateway must
        # independently enforce distributed/global abuse controls.
        restarted = SourceRequestLimiter(
            burst=3, window_seconds=30, max_sources=4,
            idle_seconds=120, clock=monotonic,
        )
        self.assertIsNone(restarted.admit("198.51.100.10"))

    def test_activation_json_rejects_repeated_keys_and_nonfinite_constants(self):
        # Both the authorization record and server audit should see exactly
        # one deterministic interpretation of a credential request.
        self.assertEqual(strict_activation_json(b'{"nonce":"one","v":1}'),
                         {"nonce": "one", "v": 1})
        for raw in (b'{"activation_code":"good","activation_code":"evil"}',
                    b'{"metadata":{"x":1,"x":2}}',
                    b'{"requested_at_utc":NaN}',
                    b'{"requested_at_utc":Infinity}',
                    b'{"requested_at_utc":-Infinity}'):
            with self.subTest(payload=raw), self.assertRaises(AuthorityError):
                strict_activation_json(raw)

    def test_source_rate_limiter_tracking_remains_bounded_and_prunes_idle_peers(self):
        monotonic = FixedClock(100)
        limiter = SourceRequestLimiter(
            burst=2, window_seconds=20, max_sources=3, idle_seconds=30,
            clock=monotonic,
        )
        for i in range(20):
            result = limiter.admit(f"2001:db8::{i}")
            self.assertEqual(result is None, i < 3)
            self.assertLessEqual(len(limiter._sources), 3)
        self.assertEqual(limiter.admit("2001:db8::0"), None)  # Still tracked, one token left.
        self.assertEqual(limiter.admit("2001:db8::0"), 10)
        self.assertEqual(limiter.admit("203.0.113.10"), 30)  # No active-peer eviction.
        monotonic.instant = 131
        self.assertIsNone(limiter.admit("203.0.113.10"))
        self.assertEqual(set(limiter._sources), {"203.0.113.10"})
        self.assertLessEqual(len(limiter._sources), 3)

    def test_source_rate_limiter_is_atomic_under_simultaneous_attempts(self):
        monotonic = FixedClock(0)
        limiter = SourceRequestLimiter(
            burst=5, window_seconds=60, max_sources=2,
            clock=monotonic,
        )
        with ThreadPoolExecutor(max_workers=12) as pool:
            outcomes = list(pool.map(limiter.admit, ["203.0.113.5"] * 40))
        self.assertEqual(outcomes.count(None), 5)
        # Threads may acquire the lock in any order; only the aggregate
        # admitted count is deterministic, not the order of result slots.
        self.assertTrue(all(value is None or value >= 1 for value in outcomes))
        self.assertEqual(len(limiter._sources), 1)

    def test_native_payload_wire_and_explicit_expiry_boundaries(self):
        issued = self.issue(expires=1020, lease=10)
        envelope = self.activate(issued["license_id"], issued["activation_code"], nonce_byte=1)
        self.assertEqual(set(envelope), {"payload_b64", "signature_b64"})
        self.assertNotIn("=", envelope["payload_b64"] + envelope["signature_b64"])
        decoded = json.loads(base64.urlsafe_b64decode(envelope["payload_b64"] + "==="))
        self.assertEqual(set(decoded), {
            "license_id", "machine_fingerprint", "issued_at_utc", "expires_at_utc",
            "lease_until_utc", "activation_serial", "revoked",
        })
        self.assertEqual(decoded["issued_at_utc"], 1000)
        self.assertEqual(decoded["expires_at_utc"], 1020)
        self.assertEqual(decoded["lease_until_utc"], 1010)
        self.assertEqual(decoded["activation_serial"], 1)
        self.assertIs(decoded["revoked"], False)
        self.verify(envelope, now=1000)
        self.verify(envelope, now=1009)
        self.assert_code("expired", lambda: self.verify(envelope, now=1010))
        # Mirror native's 120-second timestamp tolerance (not a local date zone).
        self.verify(envelope, now=880)
        self.assert_code("not_yet_valid", lambda: self.verify(envelope, now=879))
        self.assert_code("wrong_machine", lambda: self.verify(envelope, machine=MACHINE_B))

        self.clock.instant = 1010
        renewed = self.activate(issued["license_id"], issued["activation_code"], nonce_byte=2)
        self.assertEqual(self.verify(renewed)["activation_serial"], 2)
        self.verify(renewed, now=1019)
        self.assert_code("expired", lambda: self.verify(renewed, now=1020))
        self.clock.instant = 1020
        self.assert_code("expired", lambda: self.activate(
            issued["license_id"], issued["activation_code"], nonce_byte=3,
        ))

    def test_activation_replay_and_single_machine_binding(self):
        issued = self.issue()
        license_id, code = issued["license_id"], issued["activation_code"]
        first = self.activate(license_id, code, nonce_byte=4)
        self.assertEqual(self.verify(first)["activation_serial"], 1)
        self.assert_code("replay", lambda: self.activate(license_id, code, nonce_byte=4))
        self.assert_code("machine_bound", lambda: self.activate(
            license_id, code, machine=MACHINE_B, nonce_byte=5,
        ))
        second = self.activate(license_id, code, nonce_byte=6)
        self.assertEqual(self.verify(second)["activation_serial"], 2)
        self.assertEqual(self.authority.status(
            license_id=license_id, operator_token=OPERATOR_TOKEN,
        )["machine_fingerprint"], MACHINE_A)

    def test_native_24_hour_lease_maximum_and_default(self):
        self.assert_code("invalid_input", lambda: self.authority.create_license(
            expires_at_utc=200000, lease_seconds=86401,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        ))
        default_issued = self.authority.create_license(
            expires_at_utc=200000, actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        envelope = self.activate(
            default_issued["license_id"], default_issued["activation_code"], nonce_byte=20,
        )
        self.assertEqual(self.verify(envelope)["lease_until_utc"] - 1000, 86400)
        at_max = self.authority.create_license(
            expires_at_utc=200000, lease_seconds=86400,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        self.assertEqual(self.authority.status(
            license_id=at_max["license_id"], operator_token=OPERATOR_TOKEN,
        )["lease_seconds"], 86400)

    def test_reference_validator_rejects_overlong_cryptographically_valid_lease(self):
        # A key-owning operator can sign a syntactically correct envelope the
        # production native client must nevertheless reject on policy grounds.
        from scripts.licensing.authority import sign_payload
        forged_policy = {
            "license_id": "pharma-policy-test", "machine_fingerprint": MACHINE_A,
            "issued_at_utc": 1000, "expires_at_utc": 100000,
            "lease_until_utc": 1000 + 86401,
            "activation_serial": 1, "revoked": False,
        }
        envelope = sign_payload(self.key, forged_policy)
        self.assert_code("bad_payload", lambda: self.verify(envelope, now=1000))
        forged_policy["lease_until_utc"] = 1000 + 86400
        self.verify(sign_payload(self.key, forged_policy), now=1000)

    def test_operator_authentication_and_optimistic_reassignment(self):
        with self.assertRaises(Rejected):
            self.authority.create_license(expires_at_utc=2000, actor_id=ACTOR, operator_token="no")
        issued = self.issue()
        license_id = issued["license_id"]
        self.activate(license_id, issued["activation_code"], nonce_byte=7)
        self.assert_code("unauthorized", lambda: self.authority.reassign(
            license_id=license_id, expected_machine_fingerprint=MACHINE_A,
            new_machine_fingerprint=MACHINE_B, expected_serial=1, actor_id=ACTOR,
            operator_token="wrong",
        ))
        result = self.authority.reassign(
            license_id=license_id, expected_machine_fingerprint=MACHINE_A,
            new_machine_fingerprint=MACHINE_B, expected_serial=1,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        self.assert_code("revoked", lambda: self.verify(result["revocation"], machine=MACHINE_A))
        self.assertEqual(self.verify(result["activation"], machine=MACHINE_B)["activation_serial"], 3)
        self.assert_code("stale_state", lambda: self.authority.reassign(
            license_id=license_id, expected_machine_fingerprint=MACHINE_A,
            new_machine_fingerprint=MACHINE_C, expected_serial=1,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        ))
        signed_old_receipt = self.activate(
            license_id, issued["activation_code"], nonce_byte=8, machine=MACHINE_A,
        )
        self.assertEqual(signed_old_receipt, result["revocation"])
        self.assert_code("revoked", lambda: self.verify(signed_old_receipt, machine=MACHINE_A))
        self.assertEqual(self.verify(
            self.activate(license_id, issued["activation_code"], nonce_byte=9, machine=MACHINE_B),
            machine=MACHINE_B,
        )["activation_serial"], 4)

    def test_operator_same_license_term_extension_after_expiry_is_signed_and_serial_monotonic(self):
        issued = self.issue(expires=1010, lease=100)
        license_id = issued["license_id"]
        old = self.activate(license_id, issued["activation_code"], nonce_byte=190)
        self.clock.instant = 1020
        self.assert_code("expired", lambda: self.verify(old))
        request = dict(license_id=license_id, expected_serial=1,
                       expected_expires_at_utc=1010, expires_at_utc=2000,
                       actor_id=ACTOR, operator_token=OPERATOR_TOKEN)
        result = dispatch(self.authority, "extend", request)
        self.assertEqual(result["license_id"], license_id)
        self.assertEqual(result["activation_serial"], 2)
        self.assertEqual(result["expires_at_utc"], 2000)
        claims = self.verify(result["activation"], minimum_serial=2)
        self.assertEqual((claims["license_id"], claims["machine_fingerprint"]),
                         (license_id, MACHINE_A))
        self.assertEqual((claims["issued_at_utc"], claims["lease_until_utc"]), (1020, 1120))
        self.assert_code("superseded", lambda: self.verify(old, now=1005, minimum_serial=2))
        self.assert_code("stale_state", lambda: dispatch(self.authority, "extend", request))
        self.assertEqual(self.authority.status(license_id=license_id,
                                              operator_token=OPERATOR_TOKEN)["activation_serial"], 2)

    def test_operator_extension_cannot_bypass_revocation_or_concurrent_cas(self):
        available = self.issue(expires=1010)
        license_id = available["license_id"]
        req = dict(license_id=license_id, expected_serial=0,
                   expected_expires_at_utc=1010, expires_at_utc=2000,
                   actor_id=ACTOR, operator_token=OPERATOR_TOKEN)
        self.assert_code("unauthorized", lambda: dispatch(self.authority, "extend",
            {**req, "operator_token": "not-an-operator"}))
        self.assert_code("invalid_input", lambda: dispatch(self.authority, "extend",
            {**req, "expires_at_utc": 1010}))
        with ThreadPoolExecutor(max_workers=2) as pool:
            attempts = list(pool.map(lambda _: self._try_term_extension(req), range(2)))
        self.assertEqual(attempts.count("ok"), 1)
        self.assertEqual(attempts.count("stale_state"), 1)
        state = self.authority.status(license_id=license_id, operator_token=OPERATOR_TOKEN)
        self.assertEqual((state["state"], state["activation_serial"], state["expires_at_utc"]),
                         ("available", 0, 2000))
        activation = self.activate(license_id, available["activation_code"], nonce_byte=191)
        self.assertEqual(self.verify(activation)["activation_serial"], 1)
        self.authority.revoke(license_id=license_id, expected_serial=1,
                              actor_id=ACTOR, operator_token=OPERATOR_TOKEN)
        self.assert_code("revoked", lambda: dispatch(self.authority, "extend",
            {**req, "expected_serial": 2, "expected_expires_at_utc": 2000,
             "expires_at_utc": 3000}))

    def _try_term_extension(self, request):
        try:
            dispatch(self.authority, "extend", request)
            return "ok"
        except Rejected as exc:
            return exc.code

    def test_revoke_rejects_revoked_new_requests_and_signed_status(self):
        issued = self.issue()
        license_id, code = issued["license_id"], issued["activation_code"]
        old = self.activate(license_id, code, nonce_byte=10)
        self.assert_code("unauthorized", lambda: self.authority.revoke(
            license_id=license_id, expected_serial=1, actor_id=ACTOR,
            operator_token="incorrect",
        ))
        tombstone = self.authority.revoke(
            license_id=license_id, expected_serial=1,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        self.assertIsNotNone(tombstone)
        self.assert_code("revoked", lambda: self.verify(tombstone))
        self.assert_code("superseded", lambda: self.verify(old, minimum_serial=2))
        received = self.activate(license_id, code, nonce_byte=11)
        self.assertEqual(received, tombstone)
        self.assert_code("revoked", lambda: self.verify(received))
        self.assert_code("replay", lambda: self.activate(license_id, code, nonce_byte=11))
        self.assert_code("revoked", lambda: self.authority.revoke(
            license_id=license_id, expected_serial=1, actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        ))
        state = self.authority.status(license_id=license_id, operator_token=OPERATOR_TOKEN)
        self.assertEqual((state["state"], state["activation_serial"]), ("revoked", 2))

    def test_revocation_before_activation_and_stale_operator_commands(self):
        issued = self.issue()
        license_id = issued["license_id"]
        self.assert_code("stale_state", lambda: self.authority.revoke(
            license_id=license_id, expected_serial=1, actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        ))
        self.assertIsNone(self.authority.revoke(
            license_id=license_id, expected_serial=0, actor_id=ACTOR,
            operator_token=OPERATOR_TOKEN,
        ))
        self.assert_code("revoked", lambda: self.activate(
            license_id, issued["activation_code"], nonce_byte=12,
        ))

    def test_corrupt_stored_revocation_receipts_fail_closed_without_burning_nonce(self):
        issued = self.issue()
        license_id, code = issued["license_id"], issued["activation_code"]
        old_grant = self.activate(license_id, code, nonce_byte=174)
        transfer = self.authority.reassign(
            license_id=license_id, expected_machine_fingerprint=MACHINE_A,
            new_machine_fingerprint=MACHINE_B, expected_serial=1,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        # An older *authentically signed* grant is the dangerous substitution:
        # naive Ed25519-only verification still succeeds, yet revoked=false.
        self.assertEqual(self.verify(old_grant)["activation_serial"], 1)
        signed_other = self.issue()
        self.activate(signed_other["license_id"], signed_other["activation_code"],
                      machine=MACHINE_C, nonce_byte=175)
        other_receipt = self.authority.revoke(
            license_id=signed_other["license_id"], expected_serial=1,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        original = json.dumps(transfer["revocation"], separators=(",", ":"))
        malformed = {
            "authentic_old_grant": json.dumps(old_grant),
            "authentic_other_license_tombstone": json.dumps(other_receipt),
            "authentic_wrong_device_tombstone": json.dumps({
                **transfer["revocation"],
                "payload_b64": transfer["activation"]["payload_b64"],
            }),
            "duplicate_envelope_field": ('{"payload_b64":"wrong","payload_b64":'
                                         + json.dumps(transfer["revocation"]["payload_b64"])
                                         + ',"signature_b64":'
                                         + json.dumps(transfer["revocation"]["signature_b64"]) + '}'),
            "nonfinite_json": '{"payload_b64":NaN,"signature_b64":"redacted"}',
            "overlong_json": 'x' * 16_385,
            "truncated_json": '{"payload_b64":',
        }
        nonce = _b64url(bytes([176]) * 32)
        for case, tampered in malformed.items():
            with self.subTest(case=case):
                with closing(sqlite3.connect(self.db_path)) as db:
                    db.execute(
                        "UPDATE revocation_receipts SET signed_envelope_json=? "
                        "WHERE license_id=? AND machine_fingerprint=?",
                        (tampered, license_id, MACHINE_A),
                    )
                    db.commit()
                # Restart/recovery cannot bypass the stored receipt integrity
                # check, even with a correct activation code and fresh nonce.
                restarted = Authority(self.db_path, self.key,
                                      operator_secret=OPERATOR_TOKEN, clock=self.clock)
                with self.assertRaises(AuthorityError) as error:
                    restarted.activate(
                        license_id=license_id, activation_code=code,
                        machine_fingerprint=MACHINE_A, request_nonce=nonce,
                        requested_at_utc=self.clock.instant,
                    )
                self.assertEqual(error.exception.code, "authority_state_invalid")
                self.assertNotIn("payload_b64", str(error.exception))
                with closing(sqlite3.connect(self.db_path)) as db:
                    self.assertIsNone(db.execute(
                        "SELECT 1 FROM used_nonces WHERE request_nonce=?", (nonce,),
                    ).fetchone())
                    self.assertEqual(db.execute(
                        "SELECT activation_serial FROM licenses WHERE license_id=?", (license_id,),
                    ).fetchone()[0], 3)
        # Restore the legitimate signed row, then reuse the same nonce. It must
        # deliver the correct tombstone once and refuse replay across restart.
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute("UPDATE revocation_receipts SET signed_envelope_json=? "
                       "WHERE license_id=? AND machine_fingerprint=?",
                       (original, license_id, MACHINE_A))
            db.commit()
        recovered = Authority(self.db_path, self.key,
                              operator_secret=OPERATOR_TOKEN, clock=self.clock)
        self.assertEqual(recovered.activate(
            license_id=license_id, activation_code=code,
            machine_fingerprint=MACHINE_A, request_nonce=nonce,
            requested_at_utc=self.clock.instant,
        ), transfer["revocation"])
        self.assert_code("replay", lambda: self.activate(
            license_id, code, machine=MACHINE_A, nonce_byte=176,
        ))

    def test_receipt_serial_corruption_and_interrupted_activation_rollback(self):
        issued = self.issue()
        license_id, code = issued["license_id"], issued["activation_code"]
        self.activate(license_id, code, nonce_byte=177)
        transfer = self.authority.reassign(
            license_id=license_id, expected_machine_fingerprint=MACHINE_A,
            new_machine_fingerprint=MACHINE_B, expected_serial=1,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute("UPDATE revocation_receipts SET activation_serial=1 "
                       "WHERE license_id=? AND machine_fingerprint=?", (license_id, MACHINE_A))
            db.commit()
        with self.assertRaises(AuthorityError) as context:
            self.activate(license_id, code, nonce_byte=178)
        self.assertEqual(context.exception.code, "authority_state_invalid")
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute("UPDATE revocation_receipts SET activation_serial=2 "
                       "WHERE license_id=? AND machine_fingerprint=?", (license_id, MACHINE_A))
            # Synthetic I/O/constraint interruption at nonce persistence. The
            # issuer must not return the signed receipt without committing its
            # nonce, nor alter the license serial on a failed transaction.
            db.execute("CREATE TRIGGER refuse_nonce BEFORE INSERT ON used_nonces "
                       "BEGIN SELECT RAISE(ABORT,'synthetic interrupted activation'); END")
            db.commit()
        with self.assertRaises(sqlite3.IntegrityError):
            self.activate(license_id, code, nonce_byte=178)
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertIsNone(db.execute(
                "SELECT 1 FROM used_nonces WHERE request_nonce=?",
                (_b64url(bytes([178]) * 32),),
            ).fetchone())
            self.assertEqual(db.execute(
                "SELECT activation_serial FROM licenses WHERE license_id=?", (license_id,),
            ).fetchone()[0], 3)
            db.execute("DROP TRIGGER refuse_nonce")
            db.commit()
        self.assertEqual(self.activate(license_id, code, nonce_byte=178),
                         transfer["revocation"])
        self.assert_code("replay", lambda: self.activate(license_id, code, nonce_byte=178))

    def test_http_corrupt_receipt_and_interrupted_storage_recover_without_replay(self):
        issued = self.issue()
        license_id, code = issued["license_id"], issued["activation_code"]
        old_grant = self.activate(license_id, code, nonce_byte=179)
        moved = self.authority.reassign(
            license_id=license_id, expected_machine_fingerprint=MACHINE_A,
            new_machine_fingerprint=MACHINE_B, expected_serial=1,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        server = OfflineAuthorityHTTPServer(self.authority, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, timeout=5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        nonce = _b64url(bytes([180]) * 32)
        data = json.dumps({
            "license_id": license_id, "activation_code": code,
            "machine_fingerprint": MACHINE_A, "request_nonce": nonce,
            "requested_at_utc": self.clock.instant,
        })

        def request():
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            try:
                connection.request("POST", "/v1/activate", body=data,
                                   headers={"Content-Type": "application/json"})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute("UPDATE revocation_receipts SET signed_envelope_json=? "
                       "WHERE license_id=? AND machine_fingerprint=?",
                       (json.dumps(old_grant), license_id, MACHINE_A))
            db.commit()
        status, result = request()
        self.assertEqual((status, result["error"]["code"]), (503, "authority_state_invalid"))
        self.assertNotIn("activation_code", json.dumps(result))
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute("UPDATE revocation_receipts SET signed_envelope_json=? "
                       "WHERE license_id=? AND machine_fingerprint=?",
                       (json.dumps(moved["revocation"]), license_id, MACHINE_A))
            db.execute("CREATE TRIGGER refuse_nonce_http BEFORE INSERT ON used_nonces "
                       "BEGIN SELECT RAISE(ABORT,'synthetic private database detail'); END")
            db.commit()
        status, result = request()
        self.assertEqual((status, result),
                         (503, {"ok": False, "error": {"code": "authority_unavailable"}}))
        self.assertNotIn("synthetic private", json.dumps(result))
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertIsNone(db.execute(
                "SELECT 1 FROM used_nonces WHERE request_nonce=?", (nonce,),
            ).fetchone())
            db.execute("DROP TRIGGER refuse_nonce_http")
            db.commit()
        # A new issuer process can safely resume after operator storage repair;
        # the exact same previously rejected nonce must not be lost or replayed.
        server.authority = Authority(self.db_path, self.key,
                                     operator_secret=OPERATOR_TOKEN, clock=self.clock)
        status, result = request()
        self.assertEqual(status, 200)
        self.assertEqual(result["result"], moved["revocation"])
        status, replay = request()
        self.assertEqual((status, replay["error"]["code"]), (409, "replay"))

    def test_competing_authenticated_reassignments_have_single_winner(self):
        issued = self.issue()
        license_id = issued["license_id"]
        self.activate(license_id, issued["activation_code"], nonce_byte=21)
        gate = threading.Barrier(2)

        def transfer(new_machine):
            local = Authority(
                self.db_path, self.key, operator_secret=OPERATOR_TOKEN, clock=self.clock,
            )
            gate.wait(timeout=5)
            try:
                result = local.reassign(
                    license_id=license_id,
                    expected_machine_fingerprint=MACHINE_A,
                    new_machine_fingerprint=new_machine,
                    expected_serial=1,
                    actor_id=ACTOR,
                    operator_token=OPERATOR_TOKEN,
                )
                return ("ok", new_machine, result)
            except Rejected as exc:
                return ("error", new_machine, exc.code)

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(transfer, (MACHINE_B, MACHINE_C)))
        succeeded = [r for r in results if r[0] == "ok"]
        failures = [r for r in results if r[0] == "error"]
        self.assertEqual(len(succeeded), 1)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0][2], "stale_state")
        self.assertEqual(self.verify(
            succeeded[0][2]["activation"],
            machine=succeeded[0][1],
        )["activation_serial"], 3)
        self.assertEqual(self.authority.status(
            license_id=license_id, operator_token=OPERATOR_TOKEN,
        )["machine_fingerprint"], succeeded[0][1])

    def test_request_clock_skew_and_clock_rollback(self):
        issued = self.issue()
        license_id, code = issued["license_id"], issued["activation_code"]
        self.assert_code("stale_request", lambda: self.activate(
            license_id, code, nonce_byte=13, requested_at=699,
        ))
        self.assert_code("stale_request", lambda: self.activate(
            license_id, code, nonce_byte=14, requested_at=1301,
        ))
        envelope = self.activate(license_id, code, nonce_byte=15, requested_at=700)
        self.verify(envelope, now=1000)
        self.clock.instant = 999
        self.assert_code("clock_rollback", lambda: self.activate(
            license_id, code, nonce_byte=16, requested_at=999,
        ))
        self.assertEqual(self.authority.status(
            license_id=license_id, operator_token=OPERATOR_TOKEN,
        )["activation_serial"], 1)

    def test_wrong_credentials_and_signature_tampering(self):
        issued = self.issue()
        license_id = issued["license_id"]
        self.assert_code("invalid_credentials", lambda: self.activate(
            license_id, "x" * 40, nonce_byte=17,
        ))
        original = self.activate(license_id, issued["activation_code"], nonce_byte=18)
        bad_payload = dict(original)
        altered = json.loads(base64.urlsafe_b64decode(original["payload_b64"] + "==="))
        altered["machine_fingerprint"] = MACHINE_B
        bad_payload["payload_b64"] = _b64url(
            json.dumps(altered, sort_keys=True, separators=(",", ":")).encode("utf-8")
        )
        self.assert_code("bad_signature", lambda: self.verify(bad_payload, machine=MACHINE_B))
        self.assert_code("invalid_encoding", lambda: self.verify({
            **original, "signature_b64": original["signature_b64"] + "=",
        }))
        other_public = public_key_b64(Ed25519PrivateKey.generate())
        self.assert_code("bad_signature", lambda: verify_activation_envelope(
            original, other_public, machine_fingerprint=MACHINE_A, now_utc=1000,
        ))

    def test_activation_guess_throttle_is_durable_and_valid_code_recovers(self):
        issued = self.issue()
        license_id = issued["license_id"]
        bad = "x" * 43
        for index in range(5):
            self.assert_code("invalid_credentials", lambda i=index: self.activate(
                license_id, bad, nonce_byte=70+i,
            ))
        with closing(sqlite3.connect(self.db_path)) as db:
            row = db.execute(
                "SELECT failed_count,retry_after_utc FROM activation_failures WHERE license_id=?",
                (license_id,),
            ).fetchone()
        self.assertEqual(row, (5, 1002))
        # Throttle cannot be bypassed by reopening the issuer or providing the
        # correct activation code during the lockout.
        restarted = Authority(self.db_path, self.key, operator_secret=OPERATOR_TOKEN, clock=self.clock)
        self.assert_code("rate_limited", lambda: restarted.activate(
            license_id=license_id, machine_fingerprint=MACHINE_A,
            activation_code=issued["activation_code"],
            request_nonce=_b64url(bytes([76]) * 32), requested_at_utc=1000,
        ))
        self.clock.instant = 1002
        self.activate(license_id, issued["activation_code"], nonce_byte=77)
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertIsNone(db.execute(
                "SELECT 1 FROM activation_failures WHERE license_id=?", (license_id,),
            ).fetchone())

    def test_throttle_never_allocates_for_random_invalid_license_identifiers(self):
        issued = self.issue()
        for index in range(5):
            self.assert_code("invalid_credentials", lambda i=index: self.activate(
                f"unknown-license-{i}", "x" * 43, nonce_byte=80+i,
            ))
        with closing(sqlite3.connect(self.db_path)) as db:
            self.assertEqual(db.execute("SELECT count(*) FROM activation_failures").fetchone()[0], 0)
        # A failed request may not consume the nonce or change binding/serial.
        self.activate(issued["license_id"], issued["activation_code"], nonce_byte=80)

    def test_persisted_state_survives_reopen_and_replay(self):
        issued = self.issue()
        old = self.activate(issued["license_id"], issued["activation_code"], nonce_byte=19)
        restarted = Authority(self.db_path, self.key, operator_secret=OPERATOR_TOKEN, clock=self.clock)
        self.assertEqual(restarted.status(
            license_id=issued["license_id"], operator_token=OPERATOR_TOKEN,
        )["activation_serial"], 1)
        self.assert_code("replay", lambda: restarted.activate(
            license_id=issued["license_id"], machine_fingerprint=MACHINE_A,
            activation_code=issued["activation_code"],
            request_nonce=_b64url(bytes([19]) * 32),
            requested_at_utc=1000,
        ))
        self.verify(old)

    def test_authority_db_refuses_different_operator_signing_key(self):
        self.issue()
        other_signer = Ed25519PrivateKey.generate()
        with self.assertRaises(AuthorityError) as context:
            Authority(self.db_path, other_signer, operator_secret=OPERATOR_TOKEN, clock=self.clock)
        self.assertEqual(context.exception.code, "signer_mismatch")
        self.assertIsInstance(
            Authority(self.db_path, self.key, operator_secret=OPERATOR_TOKEN, clock=self.clock),
            Authority,
        )

    def test_thread_race_single_binding_and_unique_monotonic_serials(self):
        issued = self.issue()
        ready = threading.Barrier(12)

        def competitor(index):
            contender = Authority(self.db_path, self.key, operator_secret=OPERATOR_TOKEN, clock=self.clock)
            ready.wait(timeout=20)
            machine = MACHINE_A if index % 2 == 0 else MACHINE_B
            try:
                envelope = contender.activate(
                    license_id=issued["license_id"], machine_fingerprint=machine,
                    activation_code=issued["activation_code"],
                    request_nonce=_b64url(bytes([30 + index]) * 32), requested_at_utc=1000,
                )
                payload = verify_activation_envelope(
                    envelope, self.public, machine_fingerprint=machine, now_utc=1000,
                )
                return ("ok", machine, payload["activation_serial"])
            except Rejected as exc:
                return ("error", machine, exc.code)

        with ThreadPoolExecutor(max_workers=12) as executor:
            outcomes = list(executor.map(competitor, range(12)))
        succeeded = [v for v in outcomes if v[0] == "ok"]
        rejected = [v for v in outcomes if v[0] == "error"]
        self.assertGreaterEqual(len(succeeded), 1)
        self.assertEqual({v[1] for v in succeeded}, {succeeded[0][1]})
        self.assertTrue(all(v[2] == "machine_bound" for v in rejected))
        self.assertEqual(sorted(v[2] for v in succeeded), list(range(1, len(succeeded) + 1)))
        self.assertEqual(self.authority.status(
            license_id=issued["license_id"], operator_token=OPERATOR_TOKEN,
        )["activation_serial"], len(succeeded))

    def test_simultaneous_first_bootstrap_on_new_authority_database(self):
        # Unlike an activation race against an already opened DB, this races
        # journal-mode negotiation, initial DDL and issuer key pinning.
        pristine = Path(self.temp.name) / "first-start" / "authority.sqlite"
        barrier = threading.Barrier(12)

        def bootstrap(_):
            barrier.wait(timeout=20)
            started = Authority(pristine, self.key, operator_secret=OPERATOR_TOKEN, clock=self.clock)
            return started.issuer_public_key_b64

        with ThreadPoolExecutor(max_workers=12) as executor:
            keys = list(executor.map(bootstrap, range(12)))
        self.assertEqual(keys, [self.public] * 12)
        after = Authority(pristine, self.key, operator_secret=OPERATOR_TOKEN, clock=self.clock)
        result = after.create_license(
            expires_at_utc=2000, actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        self.assertTrue(result["license_id"])

    def test_activation_serial_overflow_fails_as_rejected_without_unsigned_state(self):
        issued = self.issue()
        first = self.activate(issued["license_id"], issued["activation_code"], nonce_byte=21)
        self.assertEqual(self.verify(first)["activation_serial"], 1)
        with closing(sqlite3.connect(self.db_path)) as db:
            db.execute("UPDATE licenses SET activation_serial=? WHERE license_id=?",
                       ((1 << 63)-1,issued["license_id"]))
            db.commit()
        self.assert_code("serial_exhausted", lambda: self.activate(
            issued["license_id"], issued["activation_code"], nonce_byte=22))
        self.assertEqual(self.authority.status(
            license_id=issued["license_id"], operator_token=OPERATOR_TOKEN,
        )["activation_serial"], (1 << 63)-1)

    def test_cross_process_race_for_one_machine_binding(self):
        # Runs with spawn on Windows and POSIX, validating file-backed SQLite locks.
        fresh_clock = FixedClock(3000)
        issuer = Authority(self.db_path, self.key, operator_secret=OPERATOR_TOKEN, clock=fresh_clock)
        issued = issuer.create_license(
            expires_at_utc=4000, operator_token=OPERATOR_TOKEN, actor_id=ACTOR,
        )
        seed_bytes = self.key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
        args = [
            (str(self.db_path), seed_bytes, issued["license_id"], issued["activation_code"],
             MACHINE_A if i % 2 == 0 else MACHINE_B, _b64url(bytes([60 + i]) * 32))
            for i in range(4)
        ]
        with multiprocessing.get_context("spawn").Pool(processes=4) as pool:
            outcomes = pool.map(process_activate, args)
        successes = [v for v in outcomes if v[0] == "ok"]
        self.assertGreaterEqual(len(successes), 1)
        self.assertEqual(len({v[1] for v in successes}), 1)
        self.assertTrue(all(v[2] == "machine_bound" for v in outcomes if v[0] == "error"))

    def test_api_dispatch_and_state_path_refusal(self):
        issue = dispatch(self.authority, "issue", {
            "actor_id": ACTOR, "operator_token": OPERATOR_TOKEN, "expires_at_utc": 2000,
        })
        envelope = dispatch(self.authority, "activate", {
            "license_id": issue["license_id"],
            "machine_fingerprint": MACHINE_A,
            "activation_code": issue["activation_code"],
            "request_nonce": _b64url(bytes([97]) * 32),
            "requested_at_utc": 1000,
        })
        self.assertEqual(self.verify(envelope)["activation_serial"], 1)
        self.assertEqual(dispatch(self.authority, "public-key", {})["issuer_public_key_b64"], self.public)
        repo_path = Path(__file__).resolve().parent / "NOT_A_REAL_STATE.sqlite"
        with self.assertRaises(AuthorityError):
            Authority(repo_path, self.key, operator_secret=OPERATOR_TOKEN, clock=self.clock)
        self.assertFalse(repo_path.exists())

    def test_loopback_http_contract_and_host_origin_guards(self):
        server = OfflineAuthorityHTTPServer(self.authority, port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, timeout=5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def request(method, path, obj=None, *, headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            self.addCleanup(connection.close)
            data = json.dumps(obj).encode("utf-8") if obj is not None else None
            extra_headers = {"Content-Type": "application/json"} if data is not None else {}
            extra_headers.update(headers or {})
            connection.request(method, path, body=data, headers=extra_headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())

        status, public = request("GET", "/v1/public-key")
        self.assertEqual(status, 200)
        self.assertEqual(public["result"]["issuer_public_key_b64"], self.public)

        status, rejected = request("POST", "/v1/issue", {
            "actor_id": ACTOR, "operator_token": "invalid", "expires_at_utc": 2000,
        })
        self.assertEqual((status, rejected["error"]["code"]), (401, "unauthorized"))

        status, created = request("POST", "/v1/issue", {
            "actor_id": ACTOR, "operator_token": OPERATOR_TOKEN, "expires_at_utc": 2000,
        })
        self.assertEqual(status, 200)
        issued = created["result"]
        activation_request = {
            "license_id": issued["license_id"],
            "activation_code": issued["activation_code"],
            "machine_fingerprint": MACHINE_A,
            "request_nonce": _b64url(bytes([98]) * 32),
            "requested_at_utc": 1000,
        }
        status, activated = request("POST", "/v1/activate", activation_request)
        self.assertEqual(status, 200)
        self.assertEqual(self.verify(activated["result"])["activation_serial"], 1)
        status, replay = request("POST", "/v1/activate", activation_request)
        self.assertEqual((status, replay["error"]["code"]), (409, "replay"))
        status, rejected = request("GET", "/v1/public-key", headers={
            "Host": "malicious.example",
        })
        self.assertEqual((status, rejected["error"]["code"]), (403, "invalid_host"))
        status, rejected = request("GET", "/v1/public-key", headers={
            "Origin": "http://malicious.example",
        })
        self.assertEqual((status, rejected["error"]["code"]), (403, "invalid_origin"))

    def test_public_https_rate_limit_ignores_forwarded_headers_and_recovers(self):
        tls_key = ec.generate_private_key(ec.SECP256R1())
        now = datetime.now(timezone.utc)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "licenses.example.test")])
        certificate = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name).public_key(tls_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("licenses.example.test")]),
                           critical=False)
            .sign(tls_key, hashes.SHA256()))
        cert = Path(self.temp.name) / "rate-limit-cert.pem"
        key = Path(self.temp.name) / "rate-limit-key.pem"
        cert.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        key.write_bytes(tls_key.private_bytes(serialization.Encoding.PEM,
                        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        server = HTTPSActivationServer(self.authority, host="127.0.0.1",
                                       public_host="licenses.example.test", port=0,
                                       certificate=str(cert), private_key=str(key))
        monotonic = FixedClock(0)
        server.source_limiter = SourceRequestLimiter(
            burst=2, window_seconds=60, max_sources=4,
            idle_seconds=120, clock=monotonic,
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, timeout=5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        context = ssl._create_unverified_context()  # Disposable QA TLS key only.

        def request(method, path, data=None, *, purported_source):
            connection = http.client.HTTPSConnection(
                "127.0.0.1", server.server_port, timeout=5, context=context,
            )
            try:
                # These header values are completely attacker-controlled and
                # must not replace socket-derived client_address[0].
                headers = {
                    "Host": f"licenses.example.test:{server.server_port}",
                    "X-Forwarded-For": purported_source,
                    "Forwarded": f"for={purported_source}",
                    "X-Real-IP": purported_source,
                }
                if data is not None:
                    headers["Content-Type"] = "application/json"
                connection.request(method, path, body=data, headers=headers)
                response = connection.getresponse()
                return response.status, dict(response.getheaders()), json.loads(response.read())
            finally:
                connection.close()

        for source in ("192.0.2.11", "198.51.100.22"):
            status, headers, result = request(
                "GET", "/v1/public-key", purported_source=source,
            )
            self.assertEqual(status, 200)
            self.assertEqual(result["result"]["issuer_public_key_b64"], self.public)
            self.assertNotIn("Retry-After", headers)

        # A third request pretending to be from a fresh IP still consumes
        # the real loopback socket peer's exhausted bucket.
        status, headers, rejected = request(
            "POST", "/v1/activate", b"{", purported_source="203.0.113.33",
        )
        self.assertEqual(status, 429)
        self.assertEqual(headers.get("Retry-After"), "30")
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        self.assertEqual(rejected, {"ok": False, "error": {"code": "rate_limited"}})
        self.assertNotIn("activation_code", json.dumps(rejected))

        monotonic.instant = 30
        issued = self.issue()
        activation = json.dumps({
            "license_id": issued["license_id"], "activation_code": issued["activation_code"],
            "machine_fingerprint": MACHINE_A,
            "request_nonce": _b64url(bytes([147]) * 32),
            "requested_at_utc": self.clock.instant,
        }).encode("utf-8")
        status, headers, activated = request(
            "POST", "/v1/activate", activation, purported_source="192.0.2.44",
        )
        self.assertEqual(status, 200)
        self.assertEqual(self.verify(activated["result"])["activation_serial"], 1)

    def test_public_tls_activation_only_never_exposes_operator_commands(self):
        tls_private = ec.generate_private_key(ec.SECP256R1())
        now = datetime.now(timezone.utc)
        tls_cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "licenses.example.test")]))
            .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "licenses.example.test")]))
            .public_key(tls_private.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("licenses.example.test")]), critical=False)
            .sign(tls_private, hashes.SHA256()))
        cert = Path(self.temp.name) / "tls-cert.pem"
        key = Path(self.temp.name) / "tls-private.pem"
        cert.write_bytes(tls_cert.public_bytes(serialization.Encoding.PEM))
        key.write_bytes(tls_private.private_bytes(serialization.Encoding.PEM,
                            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        server = HTTPSActivationServer(self.authority, host="127.0.0.1", public_host="licenses.example.test",
                                       port=0, certificate=str(cert), private_key=str(key))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, timeout=5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def request(path, data, host="licenses.example.test"):
            # Synthetic QA certificate only: production Rust uses WebPKI TLS
            # validation and never disables hostname/certificate verification.
            context = ssl._create_unverified_context()
            connection = http.client.HTTPSConnection("127.0.0.1", server.server_port,
                                                     context=context, timeout=5)
            try:
                body = json.dumps(data).encode("utf-8")
                connection.request("POST", path, body=body, headers={"Content-Type": "application/json", "Host": f"{host}:{server.server_port}"})
                response = connection.getresponse()
                return response.status, dict(response.getheaders()), json.loads(response.read())
            finally:
                connection.close()

        status, _, denied = request("/v1/issue", {"operator_token": OPERATOR_TOKEN})
        self.assertEqual((status, denied["error"]["code"]), (404, "not_found"))
        status, _, denied = request("/v1/revoke", {"operator_token": OPERATOR_TOKEN})
        self.assertEqual((status, denied["error"]["code"]), (404, "not_found"))
        issued = self.issue()
        activation = {"license_id": issued["license_id"], "activation_code": issued["activation_code"],
                      "machine_fingerprint": MACHINE_A, "request_nonce": _b64url(bytes([98])*32),
                      "requested_at_utc": 1000}
        status, headers, result = request("/v1/activate", activation)
        self.assertEqual(status, 200)
        self.assertEqual(self.verify(result["result"])["activation_serial"], 1)
        self.assertIn("max-age", headers.get("Strict-Transport-Security", ""))
        status, _, denied = request("/v1/activate", activation, host="attacker.example")
        self.assertEqual((status, denied["error"]["code"]), (403, "invalid_host"))

    def test_https_reassignment_revocation_receipts_and_nonces_end_to_end(self):
        # Only the in-memory QA signer and a disposable loopback TLS listener
        # are used. The public endpoint must deliver signed machine-specific
        # tombstones after transfers/revocation, but never for a guessed code.
        tls_key = ec.generate_private_key(ec.SECP256R1())
        now = datetime.now(timezone.utc)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "licenses.example.test")])
        certificate = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name).public_key(tls_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("licenses.example.test")]),
                           critical=False)
            .sign(tls_key, hashes.SHA256()))
        cert_path = Path(self.temp.name) / "receipt-test-cert.pem"
        key_path = Path(self.temp.name) / "receipt-test-key.pem"
        cert_path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
        key_path.write_bytes(tls_key.private_bytes(serialization.Encoding.PEM,
                             serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        server = HTTPSActivationServer(
            self.authority, host="127.0.0.1", public_host="licenses.example.test",
            port=0, certificate=str(cert_path), private_key=str(key_path),
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, timeout=5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        issued = self.issue()
        license_id, code = issued["license_id"], issued["activation_code"]
        context = ssl._create_unverified_context()  # Ephemeral QA certificate only.

        def activate_https(machine: str, nonce_byte: int, *, password: str | None = None):
            connection = http.client.HTTPSConnection(
                "127.0.0.1", server.server_port, timeout=5, context=context,
            )
            try:
                body = json.dumps({
                    "license_id": license_id, "activation_code": code if password is None else password,
                    "machine_fingerprint": machine,
                    "request_nonce": _b64url(bytes([nonce_byte]) * 32),
                    "requested_at_utc": self.clock.instant,
                })
                connection.request("POST", "/v1/activate", body=body,
                    headers={"Host": f"licenses.example.test:{server.server_port}",
                             "Content-Type": "application/json"})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        status, initial = activate_https(MACHINE_A, 120)
        self.assertEqual(status, 200)
        self.assertEqual(self.verify(initial["result"])["activation_serial"], 1)

        transfer = self.authority.reassign(
            license_id=license_id, expected_machine_fingerprint=MACHINE_A,
            new_machine_fingerprint=MACHINE_B, expected_serial=1,
            actor_id=ACTOR, operator_token=OPERATOR_TOKEN,
        )
        self.assertEqual(self.verify(transfer["activation"], machine=MACHINE_B)["activation_serial"], 3)

        status, rejected = activate_https(MACHINE_A, 121, password="A" * 43)
        self.assertEqual((status, rejected["error"]["code"]), (400, "invalid_credentials"))
        self.assertNotIn("result", rejected)

        status, old_device = activate_https(MACHINE_A, 122)
        self.assertEqual(status, 200)
        self.assertEqual(old_device["result"]["signature_b64"], transfer["revocation"]["signature_b64"])
        self.assert_code("revoked", lambda: self.verify(old_device["result"], machine=MACHINE_A))
        self.assert_code("superseded", lambda: self.verify(initial["result"], minimum_serial=2))

        status, replay = activate_https(MACHINE_A, 122)
        self.assertEqual((status, replay["error"]["code"]), (409, "replay"))
        status, cross_machine_replay = activate_https(MACHINE_B, 122)
        self.assertEqual((status, cross_machine_replay["error"]["code"]), (409, "replay"))
        status, wrong_machine = activate_https(MACHINE_C, 123)
        self.assertEqual((status, wrong_machine["error"]["code"]), (409, "machine_bound"))

        status, new_device = activate_https(MACHINE_B, 124)
        self.assertEqual(status, 200)
        self.assertEqual(self.verify(new_device["result"], machine=MACHINE_B)["activation_serial"], 4)

        tombstone = self.authority.revoke(
            license_id=license_id, expected_serial=4, actor_id=ACTOR,
            operator_token=OPERATOR_TOKEN,
        )
        self.assertIsNotNone(tombstone)
        # Reopen the issuer before delivery: the receipt must not depend on
        # in-process memory or an open operator connection.
        server.authority = Authority(
            self.db_path, self.key, operator_secret=OPERATOR_TOKEN, clock=self.clock,
        )
        status, revoked_device = activate_https(MACHINE_B, 125)
        self.assertEqual(status, 200)
        self.assertEqual(revoked_device["result"]["signature_b64"], tombstone["signature_b64"])
        self.assert_code("revoked", lambda: self.verify(revoked_device["result"], machine=MACHINE_B))
        self.assert_code("superseded", lambda: self.verify(new_device["result"],
                         machine=MACHINE_B, minimum_serial=5))
        status, replay = activate_https(MACHINE_B, 125)
        self.assertEqual((status, replay["error"]["code"]), (409, "replay"))
        status, still_old = activate_https(MACHINE_A, 126)
        self.assertEqual(status, 200)
        self.assertEqual(still_old["result"]["signature_b64"], transfer["revocation"]["signature_b64"])
        self.assert_code("revoked", lambda: self.verify(still_old["result"], machine=MACHINE_A))

    def test_slow_local_http_request_is_bounded_and_does_not_exhaust_threads(self):
        server = OfflineAuthorityHTTPServer(self.authority, port=0,
                                            max_clients=1, client_timeout_seconds=0.35)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, timeout=5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        slow = socket.create_connection(("127.0.0.1", server.server_port), timeout=3)
        self.addCleanup(slow.close)
        slow.sendall((
            f"POST /v1/issue HTTP/1.1\r\nHost: 127.0.0.1:{server.server_port}\r\n"
            "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"
        ).encode("ascii"))
        time.sleep(0.1)
        contender = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        self.addCleanup(contender.close)
        contender.request("GET", "/v1/public-key")
        try:
            self.assertEqual(contender.getresponse().status, 503)
        except (ConnectionAbortedError, ConnectionResetError):
            # Windows may reset a saturated socket on immediate close rather
            # than deliver the best-effort 503; neither permits a request.
            pass
        # The malicious/abandoned incomplete request must release its slot.
        time.sleep(0.65)
        healthy = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
        self.addCleanup(healthy.close)
        healthy.request("GET", "/v1/public-key")
        reply = healthy.getresponse()
        self.assertEqual(reply.status, 200)
        self.assertEqual(json.loads(reply.read())["result"]["issuer_public_key_b64"], self.public)

    def test_saturated_https_accept_loop_never_handshakes_with_untrusted_peer(self):
        # The historical saturation handler called SSLSocket.sendall() before
        # scheduling a worker. An attacker sending no ClientHello could then
        # block the *single* accept loop even after capacity was available.
        tls_private = ec.generate_private_key(ec.SECP256R1())
        now = datetime.now(timezone.utc)
        tls_cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "licenses.example.test")]))
            .issuer_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "licenses.example.test")]))
            .public_key(tls_private.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=1))
            .sign(tls_private, hashes.SHA256()))
        cert = Path(self.temp.name) / "saturated-tls-cert.pem"
        key = Path(self.temp.name) / "saturated-tls-private.pem"
        cert.write_bytes(tls_cert.public_bytes(serialization.Encoding.PEM))
        key.write_bytes(tls_private.private_bytes(serialization.Encoding.PEM,
                            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        server = HTTPSActivationServer(self.authority, host="127.0.0.1", public_host="licenses.example.test",
                                       port=0, certificate=str(cert), private_key=str(key), max_clients=1)
        server.client_timeout_seconds = 1.5
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, timeout=5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        context = ssl._create_unverified_context()  # Ephemeral QA certificate only.
        slow_raw = socket.create_connection(("127.0.0.1", server.server_port), timeout=2)
        slow = context.wrap_socket(slow_raw, server_hostname="licenses.example.test")
        self.addCleanup(slow.close)
        slow.sendall((f"POST /v1/activate HTTP/1.1\r\nHost: licenses.example.test:{server.server_port}\r\n"
                      "Content-Type: application/json\r\nContent-Length: 200\r\n\r\n{").encode())
        time.sleep(0.1)
        raw_staller = socket.create_connection(("127.0.0.1", server.server_port), timeout=2)
        self.addCleanup(raw_staller.close)
        try:
            time.sleep(0.1)
            slow.close()  # Releases the single worker slot.
            time.sleep(0.2)
            healthy = http.client.HTTPSConnection("127.0.0.1", server.server_port,
                                                   context=context, timeout=1.5)
            try:
                healthy.request("GET", "/v1/public-key", headers={"Host": f"licenses.example.test:{server.server_port}"})
                reply = healthy.getresponse()
                self.assertEqual(reply.status, 200)
                self.assertEqual(json.loads(reply.read())["result"]["issuer_public_key_b64"], self.public)
            finally:
                healthy.close()
        finally:
            raw_staller.close()

    def test_cli_stdin_protocol_using_environment_only_signer(self):
        seed = self.key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )
        env = dict(os.environ)
        env.update({
            "PHARMA_AUTHORITY_DB": str(self.db_path),
            "PHARMA_LICENSE_ISSUER_SEED_B64": _b64url(seed),
            "PHARMA_AUTHORITY_OPERATOR_TOKEN": OPERATOR_TOKEN,
        })

        def cli(command, request=None):
            result = subprocess.run(
                [sys.executable, "-m", "scripts.licensing.cli", command],
                input=json.dumps(request) if request is not None else None,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(Path(__file__).resolve().parents[2]),
                env=env,
                timeout=15,
                check=False,
            )
            return result.returncode, json.loads(result.stdout)

        status, public = cli("public-key")
        self.assertEqual(status, 0)
        self.assertEqual(public["result"]["issuer_public_key_b64"], self.public)
        status, issued_result = cli("issue", {
            "expires_at_utc": 2000, "operator_token": OPERATOR_TOKEN,
            "actor_id": ACTOR, "lease_seconds": 100,
        })
        self.assertEqual(status, 2)
        self.assertEqual(issued_result["error"]["code"], "expired")

        # A new in-memory clock fixture drives the direct API tests; the CLI
        # uses real UTC, so create an expiry relative to actual current time.
        import time

        status, issued_result = cli("issue", {
            "expires_at_utc": int(time.time()) + 3600,
            "operator_token": OPERATOR_TOKEN, "actor_id": ACTOR, "lease_seconds": 100,
        })
        self.assertEqual(status, 0)
        issued = issued_result["result"]
        self.assertNotIn("PHARMA_LICENSE_ISSUER_SEED_B64", json.dumps(issued))
        status, activated = cli("activate", {
            "license_id": issued["license_id"], "activation_code": issued["activation_code"],
            "machine_fingerprint": MACHINE_A, "request_nonce": _b64url(bytes([99]) * 32),
            "requested_at_utc": int(time.time()),
        })
        self.assertEqual(status, 0)
        self.assertEqual(
            verify_activation_envelope(
                activated["result"], self.public, machine_fingerprint=MACHINE_A,
                now_utc=int(time.time()),
            )["activation_serial"], 1,
        )


if __name__ == "__main__":
    unittest.main()
