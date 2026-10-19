"""Private disposable Win32 ReplaceFileW refusal tests (no customer DB writes)."""
from __future__ import annotations

from pathlib import Path
import hashlib
import unittest
import uuid

from scripts import owner_first_enrollment as custody
from scripts import qa_original_history_atomic_rehearsal as atomic
from scripts import qa_original_history_replacefile_recovery as replace


class ReplaceFileIsolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        custody._require_windows()
        cls.source68, cls.source69, cls.raw68, cls.raw69, cls.root, _, _ = atomic.checked_sources()

    def stage(self):
        folder = self.root / ('pharma-isolated-atomic-history-qa-' + uuid.uuid4().hex)
        folder.mkdir(mode=0o700)
        custody._private_acl(folder)
        active, incoming, rollback = (folder / 'QA_ACTIVE.sqlite3',
                                      folder / 'QA_INCOMING.sqlite3',
                                      folder / 'QA_ROLLBACK.sqlite3')
        custody._exclusive_file(active, self.raw68)
        custody._exclusive_file(incoming, self.raw69)
        return folder, active, incoming, rollback

    def test_refuses_destination_outside_qa_folder(self):
        folder, active, incoming, rollback = self.stage()
        with self.assertRaisesRegex(atomic.Refused, 'restricted to private QA'):
            replace.replace_file_with_backup(active, incoming,
                                             Path(str(folder.parent / 'pharma_local.db')))
        self.assertEqual(atomic.inspect_qa_recovery_state(folder),
                         'PREPARED_OR_RESTORED_BASELINE')

    def test_refuses_orphaned_wal_with_original_files_intact(self):
        folder, active, incoming, rollback = self.stage()
        custody._exclusive_file(Path(str(incoming) + '-wal'), b'fake-sidecar')
        with self.assertRaisesRegex(custody.Refused, 'sidecar'):
            replace.replace_file_with_backup(active, incoming, rollback)
        atomic.fingerprint(active, atomic.V68_SHA)
        self.assertEqual(hashlib.sha256(incoming.read_bytes()).hexdigest(), atomic.V69_SHA)
        self.assertFalse(rollback.exists())

    def test_refuses_existing_rollback_instead_of_overwriting(self):
        folder, active, incoming, rollback = self.stage()
        custody._exclusive_file(rollback, self.raw68)
        with self.assertRaisesRegex(atomic.Refused, 'cannot overwrite existing'):
            replace.replace_file_with_backup(active, incoming, rollback)
        atomic.fingerprint(rollback, atomic.V68_SHA)
        atomic.fingerprint(active, atomic.V68_SHA)

    def test_refuses_corrupted_candidate(self):
        folder, active, incoming, rollback = self.stage()
        # A wholly private test artifact, NOT a source/current profile.
        with open(incoming, 'r+b') as file:
            file.seek(200)
            byte = file.read(1)
            file.seek(200)
            file.write(bytes([byte[0] ^ 1]))
            file.flush()
        with self.assertRaisesRegex(atomic.Refused, 'Unknown original-derived QA source'):
            replace.replace_file_with_backup(active, incoming, rollback)
        atomic.fingerprint(active, atomic.V68_SHA)
        self.assertFalse(rollback.exists())


if __name__ == '__main__':
    unittest.main()
