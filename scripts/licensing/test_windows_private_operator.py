"""Windows disposable-only operator signing tests; never the real identity."""
from __future__ import annotations

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from scripts.licensing import windows_private_operator as operator


class WindowsPrivateOperatorTests(unittest.TestCase):
    def setUp(self):
        operator.custody._require_windows()
        temp = tempfile.TemporaryDirectory(prefix="pharma-issuer-unit-only-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "isolated-issuer"
        root_patch = patch.object(operator, "_root", return_value=self.root)
        root_patch.start()
        self.addCleanup(root_patch.stop)

    def test_first_provision_stays_dpapi_sealed_and_never_resets(self):
        result = operator.initialize()
        self.assertEqual(result["status"], "PRIVATE_WINDOWS_ISSUER_PROVISIONED_BACKUP_PENDING")
        self.assertTrue(result["private_seed_exposed"] is False)
        self.assertNotIn(result["public_license_verification_key_b64url"],
                         operator.UNSAFE_PUBLIC_KEYS)
        secret = self.root / "secrets" / operator.ISSUER_BLOB
        self.assertTrue(secret.is_file())
        self.assertNotIn(b"PRIVATE KEY", secret.read_bytes())
        self.assertEqual(operator.status()["public_license_verification_key_b64url"],
                         result["public_license_verification_key_b64url"])
        with self.assertRaisesRegex(operator.Refused, "never overwrite"):
            operator.initialize()
        self.assertEqual(operator.status()["public_license_verification_key_b64url"],
                         result["public_license_verification_key_b64url"])

    def test_denies_nonapproved_issuance(self):
        operator.initialize()
        with patch.dict(operator.os.environ, {operator.ISSUE_APPROVAL_ENV: "false"}):
            with self.assertRaisesRegex(operator.Refused, "explicit operator approval"):
                operator.issue_offline()

    def test_sealed_signer_tampering_fails_closed(self):
        operator.initialize()
        sealed = self.root / "secrets" / operator.ISSUER_BLOB
        content = bytearray(sealed.read_bytes())
        content[-3] ^= 0x40
        sealed.write_bytes(content)
        with self.assertRaises(operator.Refused):
            operator.status()

    def test_missing_credential_refuses_reenrollment(self):
        operator.initialize()
        (self.root / "secrets" / operator.TOKEN_BLOB).unlink()
        with self.assertRaises(operator.Refused):
            operator.status()
        with self.assertRaises(operator.Refused):
            operator.initialize()

    def test_public_command_does_not_emit_private_identity(self):
        operator.initialize()
        buffer = io.StringIO()
        with patch.object(sys, "argv", ["operator", "status"]), \
                contextlib.redirect_stdout(buffer):
            self.assertEqual(operator.main(), 0)
        self.assertIn("PRIVATE_WINDOWS_ISSUER_PRESENT", buffer.getvalue())
        self.assertNotIn("commercial-operator-token", buffer.getvalue())

    def test_authorized_offline_issue_uses_sealed_test_identity_only(self):
        operator.initialize()
        fingerprint = "a" * 64  # Synthetic fake fingerprint, never a customer device.
        stdin = type("PrivateStdin", (), {"buffer": io.BytesIO(json.dumps({
            "machine_fingerprint": fingerprint,
            "expires_at_utc": int(time.time()) + 14 * 86400,
            "actor_id": "disposable-qa-issuer",
        }).encode("utf-8"))})()
        with patch.dict(operator.os.environ, {operator.ISSUE_APPROVAL_ENV: "true"}), \
                patch.object(sys, "stdin", stdin):
            response = operator.issue_offline()
        self.assertEqual(response["activation_serial"], 1)
        self.assertEqual(set(response["activation"]),
                         {"payload_b64", "signature_b64"})
        self.assertEqual(response["status"], "PASS_PRIVATE_MANUAL_OFFLINE_LICENSE_ISSUED")
        self.assertTrue(response["not_historical_import_approval"])
        self.assertFalse((self.root / "secrets" / "commercial-issuer.seed").exists())


if __name__ == "__main__":
    unittest.main()
