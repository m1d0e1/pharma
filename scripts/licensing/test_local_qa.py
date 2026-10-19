"""Real Windows DPAPI-backed local QA workflow, isolated under a temp directory."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from scripts.licensing import local_qa
from scripts.licensing.operator_ui import operator_command
from scripts.licensing.authority import Rejected, verify_activation_envelope
from cryptography import x509


@unittest.skipUnless(os.name == "nt", "Windows DPAPI-only local QA")
class LocalOperatorQA(unittest.TestCase):
    def test_qa_tls_is_only_a_short_lived_non_ca_localhost_leaf(self):
        with tempfile.TemporaryDirectory(prefix="pharma-qa-tls-test-") as root:
            with patch.object(local_qa, "directory", return_value=Path(root)):
                created = local_qa.init_local_tls()
                verified = local_qa.verify_local_tls()
                self.assertEqual(created["thumbprint_sha1"], verified["thumbprint_sha1"])
                crt = x509.load_pem_x509_certificate(Path(created["certificate_file"]).read_bytes())
                self.assertFalse(crt.extensions.get_extension_for_class(x509.BasicConstraints).value.ca)
                self.assertFalse(crt.extensions.get_extension_for_class(x509.KeyUsage).value.key_cert_sign)
                self.assertIn("localhost", crt.extensions.get_extension_for_class(x509.SubjectAlternativeName)
                              .value.get_values_for_type(x509.DNSName))
                with self.assertRaisesRegex(RuntimeError, "refusing replacement"):
                    local_qa.init_local_tls()

    def test_qa_keys_and_credentials_stay_sealed_while_grants_renew(self):
        with tempfile.TemporaryDirectory(prefix="pharma-qa-operator-test-") as root:
            with patch.object(local_qa, "directory", return_value=Path(root)):
                def command(*args):
                    output = io.StringIO()
                    with redirect_stdout(output):
                        self.assertEqual(local_qa.main(list(args)), 0)
                    return json.loads(output.getvalue())

                ready = command("init")
                self.assertEqual(operator_command("status")["state"], "not-issued")
                public = ready["public_key_b64"]
                self.assertEqual(len(public), 43)
                self.assertEqual(command("status")["state"], "not-issued")
                machine = "a" * 64
                first = command("grant", "--fingerprint", machine)
                signed = first["signed_license"]
                decoded = verify_activation_envelope(signed, public, machine_fingerprint=machine,
                                                     now_utc=int(time.time()))
                self.assertEqual(decoded["activation_serial"], 1)
                second = command("renew")
                decoded2 = verify_activation_envelope(second["signed_license"], public,
                                                     machine_fingerprint=machine,
                                                     now_utc=int(time.time()), minimum_serial=2)
                self.assertEqual(decoded2["activation_serial"], 2)
                self.assertEqual(command("status")["activation_serial"], 2)
                self.assertEqual(operator_command("status")["activation_serial"], 2)
                password = command("qa-owner-password")["qa_owner_password"]
                self.assertEqual(password, command("qa-owner-password")["qa_owner_password"])
                self.assertTrue(14 <= len(password) <= 72)
                self.assertTrue(any(c.isupper() for c in password) and
                                any(c.islower() for c in password) and
                                any(c.isdigit() for c in password) and
                                any(not c.isalnum() for c in password))
                with self.assertRaises(Rejected):
                    verify_activation_envelope(signed, public, machine_fingerprint="b" * 64,
                                               now_utc=int(time.time()))
                with self.assertRaises(Rejected):
                    verify_activation_envelope(signed, public, machine_fingerprint=machine,
                                               now_utc=int(time.time()),
                                               minimum_serial=2)
                sealed = (Path(root) / "operator.dpapi").read_bytes()
                self.assertNotIn(first["license_id"].encode(), sealed)
                self.assertNotIn(machine.encode(), sealed)
                self.assertNotIn(b"activation_code", sealed)
                self.assertNotIn(password.encode(), sealed)
                output = io.StringIO()
                with redirect_stdout(output), redirect_stderr(io.StringIO()):
                    self.assertEqual(local_qa.main(["init"]), 1)


if __name__ == "__main__":
    unittest.main()
