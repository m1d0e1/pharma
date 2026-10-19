"""Refusal tests for the exact-current-data Windows ReplaceFileW QA namespace."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import qa_original_history_live_replacefile_recovery as recovery


class LiveReplacefileRefusalTests(unittest.TestCase):
    def test_qa_token_must_be_strictly_hex(self):
        for bad in ("", "..", "A" * 32, "a" * 31, "a" * 33, "../" + "a" * 32):
            with self.subTest(bad=bad):
                with self.assertRaises(recovery.Refused):
                    recovery._folder(bad)

    def test_cannot_replace_user_profile_or_wrong_parent(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder)
            with mock.patch.object(recovery.guard, "disposable_root",
                                   return_value=parent / "approved"):
                with self.assertRaisesRegex(recovery.Refused, "restricted"):
                    recovery._replace(parent, recovery.INCOMING, recovery.ROLLBACK,
                                      "0" * 64, "1" * 64, 4843, 29, 69)

    def test_refuses_incoming_and_backup_same_file(self):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder)
            private = parent / (recovery.PREFIX + "a" * 32)
            private.mkdir()
            with mock.patch.object(recovery.guard, "disposable_root", return_value=parent):
                with self.assertRaisesRegex(recovery.Refused, "restricted"):
                    recovery._replace(private, recovery.ROLLBACK, recovery.ROLLBACK,
                                      "0" * 64, "1" * 64, 4843, 29, 69)

    def test_manifest_cannot_assert_acceptance(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / "QA_PAIR_METADATA.json").write_text(
                json.dumps({"status": "PRODUCTION_APPROVED", "v29_sha256": "0" * 64,
                            "v69_sha256": "1" * 64, "sequence": 4843}),
                encoding="utf-8")
            with mock.patch.object(recovery.custody, "_no_reparse"), \
                 mock.patch.object(recovery.custody, "_private_acl"):
                with self.assertRaises(recovery.Refused):
                    recovery._pair(path)

    def test_manifest_rejects_extra_forged_authorization(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / "QA_PAIR_METADATA.json").write_text(
                json.dumps({"status": "UNACCEPTED_QA_PAIR", "v29_sha256": "0" * 64,
                            "v69_sha256": "1" * 64, "sequence": 4843,
                            "owner_approved": True}),
                encoding="utf-8")
            with mock.patch.object(recovery.custody, "_no_reparse"), \
                 mock.patch.object(recovery.custody, "_private_acl"):
                with self.assertRaises(recovery.Refused):
                    recovery._pair(path)


if __name__ == "__main__":
    unittest.main()
