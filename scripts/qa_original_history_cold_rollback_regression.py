"""Fail-closed tests for the cold v29 recovery copy; no customer DB writes."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import qa_original_history_cold_rollback_backup as cold


class ColdRecoveryRefusalTests(unittest.TestCase):
    def test_refuses_invalid_recovery_tokens(self):
        for token in ("", "..", "A" * 32, "a" * 31, "a" * 33, "../" + "a" * 32):
            with self.subTest(token=token):
                with self.assertRaises(cold.Refused):
                    cold._target(token)

    def test_fails_closed_if_pharma_is_running(self):
        with mock.patch("psutil.process_iter", return_value=[
                mock.Mock(info={"name": "PHARMA.EXE"})]):
            with self.assertRaisesRegex(cold.Refused, "Stop PHARMA"):
                cold._process_absent()

    def test_fails_closed_if_process_inventory_unavailable(self):
        import psutil
        with mock.patch("psutil.process_iter", side_effect=psutil.AccessDenied()):
            with self.assertRaisesRegex(cold.Refused, "process shutdown"):
                cold._process_absent()

    def test_rejects_manifest_that_asserts_production_approval(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            token = "a" * 32
            directory = root / (cold.PREFIX + token)
            directory.mkdir()
            (directory / cold.MANIFEST).write_text(
                json.dumps({"status": "UNACCEPTED_CURRENT_V29_COLD_ROLLBACK",
                            "v29_sha256": "0" * 64, "account_cursor": 4843,
                            "typed_history_rows": 289753, "production_approved": True}),
                encoding="ascii")
            with mock.patch.object(cold.guard, "disposable_root", return_value=root), \
                 mock.patch.object(cold.custody, "_no_reparse"), \
                 mock.patch.object(cold.custody, "_private_acl"):
                with self.assertRaisesRegex(cold.Refused, "cannot authorize"):
                    cold.verify_token(token)

    def test_rejects_extra_import_authorization_in_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            token = "b" * 32
            directory = root / (cold.PREFIX + token)
            directory.mkdir()
            (directory / cold.MANIFEST).write_text(
                json.dumps({"status": "UNACCEPTED_CURRENT_V29_COLD_ROLLBACK",
                            "v29_sha256": "0" * 64, "account_cursor": 4843,
                            "typed_history_rows": 289753, "production_approved": False,
                            "historical_owner_authenticated": True}),
                encoding="ascii")
            with mock.patch.object(cold.guard, "disposable_root", return_value=root), \
                 mock.patch.object(cold.custody, "_no_reparse"), \
                 mock.patch.object(cold.custody, "_private_acl"):
                with self.assertRaisesRegex(cold.Refused, "cannot authorize"):
                    cold.verify_token(token)


if __name__ == "__main__":
    unittest.main()
