"""Disposable Windows DPAPI local recovery tests, no commercial state accessed."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.licensing import windows_private_operator as issuer
from scripts.licensing import windows_private_issuer_backup as backup


class PrivateLocalBackupTests(unittest.TestCase):
    def setUp(self):
        issuer.custody._require_windows()
        tmp = tempfile.TemporaryDirectory(prefix="pharma-dpapi-recovery-test-")
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.issuer_root = root / "test-only-issuer"
        self.recovery_parent = root / "private-backups"
        self.recovery_parent.mkdir()
        self.patch = patch.object(issuer, "_root", return_value=self.issuer_root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        issuer.initialize()

    def test_backup_retains_key_identity_and_sqlite_rows(self):
        result = backup.backup(self.recovery_parent)
        self.assertEqual(result["status"],
                         "PASS_PRIVATE_DPAPI_LOCAL_RECOVERY_COPY_NOT_PORTABLE")
        self.assertEqual(result["files_verified"], 3)
        self.assertEqual(result["issuer_public_key_b64url"],
                         issuer.status()["public_license_verification_key_b64url"])
        self.assertFalse(result["portable_off_device_restore_accepted"])

    def test_corrupted_private_ledger_refused(self):
        result = backup.backup(self.recovery_parent)
        folder = Path(result["private_backup_directory"])
        ledger = folder / issuer.AUTHORITY_DB
        data = bytearray(ledger.read_bytes())
        data[256] ^= 0x01
        ledger.write_bytes(data)
        with self.assertRaises(backup.Refused):
            backup.verify(folder, self.recovery_parent)

    def test_manifest_cannot_claim_portable_recovery_or_approval(self):
        result = backup.backup(self.recovery_parent)
        folder = Path(result["private_backup_directory"])
        manifest = folder / backup.MANIFEST
        packet = json.loads(manifest.read_text(encoding="ascii"))
        packet["production_release_approved"] = True
        manifest.write_text(json.dumps(packet), encoding="ascii")
        with self.assertRaises(backup.Refused):
            backup.verify(folder, self.recovery_parent)


if __name__ == "__main__":
    unittest.main()
