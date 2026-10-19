"""No real license issued: mock DPAPI and use a new temporary issuer ledger."""
from __future__ import annotations

from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.licensing import lifecycle_qa
from scripts.licensing.authority import verify_activation_envelope


class TestIndependentLifecycleIssuer(unittest.TestCase):
    def setUp(self) -> None:
        self.sandbox = tempfile.TemporaryDirectory(prefix="pharma-lifecycle-issuer-unit-")
        self.addCleanup(self.sandbox.cleanup)
        self.issuer_directory = Path(self.sandbox.name) / "completely-new-test-issuer"
        self.issuer_patch = patch.object(lifecycle_qa, "operator_directory",
                                         lambda: self.issuer_directory)
        # Test-only no-op seal to avoid touching Windows CurrentUser DPAPI.
        # Production imports the real strict DPAPI wrapper.
        self.protect_patch = patch.object(lifecycle_qa, "protect", lambda data: data)
        self.unprotect_patch = patch.object(lifecycle_qa, "unprotect", lambda data: data)
        self.issuer_patch.start()
        self.protect_patch.start()
        self.unprotect_patch.start()
        self.addCleanup(self.issuer_patch.stop)
        self.addCleanup(self.protect_patch.stop)
        self.addCleanup(self.unprotect_patch.stop)

    def test_init_never_returns_secret_and_refuses_rotation(self) -> None:
        state = lifecycle_qa.init()
        self.assertEqual(state["identity"], lifecycle_qa.APP_ID)
        self.assertEqual(len(state["issuer_public_key_b64"]), 43)
        self.assertFalse("seed" in repr(state) or "activation_code" in repr(state))
        self.assertTrue((self.issuer_directory / "issuer.sqlite").is_file())
        self.assertTrue((self.issuer_directory / "operator.dpapi").is_file())
        self.assertEqual(lifecycle_qa.status()["grant_state"], "not-issued")
        with self.assertRaisesRegex(RuntimeError, "refuse reset"):
            lifecycle_qa.init()

    def test_signed_offline_term_is_bound_and_sealed_not_printed(self) -> None:
        identity = lifecycle_qa.init()
        fingerprint = "a" * 64
        profile_report = {"app_id": lifecycle_qa.APP_ID, "status": "PASS"}
        with patch.object(lifecycle_qa, "verify_fixture", return_value=profile_report) as verify:
            result = lifecycle_qa.grant(
                fingerprint=fingerprint, days=1, profile_parent=Path(self.sandbox.name))
        verify.assert_called_once_with(Path(self.sandbox.name))
        self.assertEqual(result["status"], "signed-offline-term")
        self.assertEqual(result["activation_serial"], 2)
        self.assertNotIn("signature_b64", result)
        self.assertNotIn("activation_code", repr(result))
        self.assertEqual(lifecycle_qa.status()["grant_state"], "signed-offline-term")

        stored = lifecycle_qa._state()
        signed = stored["credential"]["offline_grant"]
        claims = verify_activation_envelope(signed, identity["issuer_public_key_b64"],
                                             machine_fingerprint=fingerprint,
                                             now_utc=__import__("time").time().__int__())
        self.assertEqual(claims["machine_fingerprint"], fingerprint)
        self.assertTrue(claims["offline_term"])
        self.assertIsNone(claims["lease_until_utc"])
        with self.assertRaises(RuntimeError):
            lifecycle_qa.grant(fingerprint=fingerprint, days=1,
                               profile_parent=Path(self.sandbox.name))

    def test_rejects_guessed_fingerprint_and_release_approved_environment(self) -> None:
        lifecycle_qa.init()
        with self.assertRaisesRegex(ValueError, "actual 64-character"):
            lifecycle_qa.grant(fingerprint="not-native", days=1,
                               profile_parent=Path(self.sandbox.name))
        with patch.dict("os.environ", {"PHARMA_SECURITY_RELEASE_APPROVED": "1"}):
            with self.assertRaisesRegex(RuntimeError, "release-approved"):
                lifecycle_qa.grant(fingerprint="a" * 64, days=1,
                                   profile_parent=Path(self.sandbox.name))
        self.assertEqual(lifecycle_qa.status()["grant_state"], "not-issued")

    def test_public_key_command_is_nonsecret_and_no_unrequested_issuer_creation(self) -> None:
        self.assertFalse(self.issuer_directory.exists())
        with redirect_stdout(StringIO()):
            self.assertEqual(lifecycle_qa.main(["public-key"]), 1)
        self.assertFalse(self.issuer_directory.exists())


if __name__ == "__main__":
    unittest.main()
