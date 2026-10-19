"""Staging-only issuer regression tests; isolated temporary keys and databases."""

from __future__ import annotations

from contextlib import redirect_stdout
import http.client
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from scripts.licensing.authority import AuthorityError, _b64url, verify_activation_envelope
from scripts.licensing import staging


class StagingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pharma-staging-test-")
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.env = {
            staging.STATE_DIR_ENV: str(base / "persistent-db"),
            staging.SECRETS_DIR_ENV: str(base / "private-keys"),
        }
        self.public = staging.initialize(env=self.env)
        self.authority = staging.make_staging_authority(env=self.env)
        self.assertEqual(self.public, self.authority.issuer_public_key_b64)

    def test_educational_listener_uses_approved_dns_without_commercial_signer(self):
        self.assertEqual(staging.STAGING_HOST, "licenses.getpharmatech.app")
        self.assertEqual(staging.SEED_NAME, "staging-only-issuer.seed")

    def test_new_identity_has_private_permissions_and_reinitialization_fails_closed(self):
        db_dir, secret_dir = staging.directories(self.env)
        self.assertFalse((db_dir / "authority.sqlite").is_symlink())
        for name in (staging.SEED_NAME, staging.TOKEN_NAME):
            secret_file = secret_dir / name
            self.assertTrue(secret_file.exists())
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(secret_file.stat().st_mode), 0o600)
        with self.assertRaises(AuthorityError) as result:
            staging.initialize(env=self.env)
        self.assertEqual(result.exception.code, "already_initialized")
        self.assertEqual(staging.make_staging_authority(env=self.env).issuer_public_key_b64, self.public)
        self.assertNotEqual(self.public, "zkYpUf79V1IbE8h_ud3q2mP-Ee9O_A9fS65z1cCQVus")

    def test_staging_guard_fails_closed_on_missing_secrets_unsafe_paths_and_nonproxy_http(self):
        repo = Path(staging.__file__).resolve().parents[2]
        with self.assertRaises(AuthorityError) as context:
            staging.directories({**self.env, staging.STATE_DIR_ENV: str(repo / "state")})
        self.assertEqual(context.exception.code, "unsafe_path")
        with self.assertRaises(AuthorityError) as context:
            staging.make_staging_authority(env={**self.env, staging.SECRETS_DIR_ENV: str(Path(self.tmp.name) / "missing")})
        self.assertEqual(context.exception.code, "unsafe_path")
        with patch.dict(os.environ, {staging.STAGING_ACK: ""}):
            with self.assertRaises(AuthorityError) as context:
                staging.StagingActivationServer(self.authority, bind="0.0.0.0", port=8080)
            self.assertEqual(context.exception.code, "missing_ingress_ack")
        with patch.dict(os.environ, {"PHARMA_SECURITY_RELEASE_APPROVED": "1", **self.env}):
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(staging.main(["public-key"]), 2)
            self.assertIn("production_guard", output.getvalue())

    def _request(self, port, method, path, body=None, *, host=None, origin=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        headers = {"Host": staging.STAGING_HOST if host is None else host}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if origin:
            headers["Origin"] = origin
        try:
            conn.request(method, path, body=None if body is None else json.dumps(body).encode(),
                         headers=headers)
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def _live(self, check):
        with staging.StagingActivationServer(self.authority, bind="127.0.0.1", port=0) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                check(server.server_port)
            finally:
                server.shutdown()
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())

    def test_http_public_only_signed_activation_and_replay_persist_after_restart(self):
        # Issue through the separate local authority, never via the HTTP API.
        now = int(time.time())
        issued = self.authority.create_license(
            expires_at_utc=now + 3600, operator_token=self.authority._secret,
            actor_id="test-operator", lease_seconds=600,
        )
        request = {
            "license_id": issued["license_id"],
            "activation_code": issued["activation_code"],
            "machine_fingerprint": "a" * 64,
            "request_nonce": _b64url(b"1" * 32),
            "requested_at_utc": now,
        }
        def first(port):
            status, pub = self._request(port, "GET", "/v1/public-key")
            self.assertEqual(status, 200)
            self.assertEqual(pub["result"]["issuer_public_key_b64"], self.public)
            for path in ("/v1/issue", "/v1/status", "/v1/revoke", "/v1/reassign"):
                status, _ = self._request(port, "POST", path, {})
                self.assertEqual(status, 404, path)
            status, _ = self._request(port, "GET", "/v1/public-key", host="attacker.example")
            self.assertEqual(status, 403)
            status, _ = self._request(port, "GET", "/v1/public-key", origin="https://evil.example")
            self.assertEqual(status, 403)
            status, issued_signed = self._request(port, "POST", "/v1/activate", request)
            self.assertEqual(status, 200)
            payload = verify_activation_envelope(issued_signed["result"], self.public,
                machine_fingerprint="a" * 64, now_utc=now)
            self.assertEqual(payload["activation_serial"], 1)
        self._live(first)
        self.authority = staging.make_staging_authority(env=self.env)
        def after_restart(port):
            status, answer = self._request(port, "POST", "/v1/activate", request)
            self.assertEqual(status, 409)
            self.assertEqual(answer["error"]["code"], "replay")
        self._live(after_restart)

    def test_operator_cli_uses_private_token_without_accepting_one_in_json(self):
        payload = json.dumps({"expires_at_utc": int(time.time()) + 3600, "actor_id": "test-operator"})
        with patch.dict(os.environ, self.env), patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(payload.encode()), encoding="utf-8")):
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(staging.main(["operator", "issue"]), 0)
        result = json.loads(output.getvalue())["result"]
        self.assertTrue(result["activation_code"])
        self.assertNotIn(self.authority._secret, output.getvalue())
        supplied = b'{"actor_id":"test-operator","operator_token":"attacker"}'
        with patch.dict(os.environ, self.env), patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(supplied), encoding="utf-8")):
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(staging.main(["operator", "status"]), 2)
        self.assertEqual(json.loads(output.getvalue())["error"]["code"], "bad_json")

    def test_signer_identity_is_pinned_to_existing_persistent_db(self):
        _, private = staging.directories(self.env)
        another = Ed25519PrivateKey.generate().private_bytes(
            serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
            serialization.NoEncryption())
        (private / staging.SEED_NAME).write_text(_b64url(another) + "\n", encoding="ascii")
        with self.assertRaises(AuthorityError) as context:
            staging.make_staging_authority(env=self.env)
        self.assertEqual(context.exception.code, "signer_mismatch")


if __name__ == "__main__":
    unittest.main()
