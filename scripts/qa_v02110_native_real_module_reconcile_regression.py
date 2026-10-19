"""No-customer-data regression for the native original-record audit gate."""
from __future__ import annotations

from contextlib import closing
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import unittest

from scripts import qa_v02110_native_real_module_reconcile as qa


class NativeRealSourceReconcileSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pharma-v02110-audit-unit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "pharma-disposable-data-copies"
        self.root.mkdir()
        self.source_dir = self.root / ("pharma-v02110-prebuild-snapshot-" + "a" * 32)
        self.source_dir.mkdir()
        self.source = self.source_dir / "current-v02109-sealed.sqlite3"
        self.source.write_bytes(b"synthetic-not-sqlite-" * 4096)
        self.sha = hashlib.sha256(self.source.read_bytes()).hexdigest()

    def args(self):
        return self.source, self.sha, self.root, qa.SRC, "current-v02109-sealed.sqlite3"

    def test_full_hash_and_private_folder_are_required(self):
        self.assertEqual(qa._detached(*self.args()), self.source)
        for wrong in ("a", "0" * 64, self.sha[:-1] + ("0" if self.sha[-1] != "0" else "1")):
            with self.subTest(pin=wrong), self.assertRaises(ValueError):
                qa._detached(self.source, wrong, self.root, qa.SRC,
                             "current-v02109-sealed.sqlite3")

    def test_sidecar_and_unapproved_path_are_rejected(self):
        foreign = self.root.parent / "current-v02109-sealed.sqlite3"
        foreign.write_bytes(self.source.read_bytes())
        with self.assertRaises(ValueError):
            qa._detached(foreign, self.sha, self.root, qa.SRC, self.source.name)
        wal = Path(str(self.source) + "-wal")
        wal.write_bytes(b"test-only-WAL-sidecar")
        with self.assertRaises(ValueError):
            qa._detached(*self.args())

    def test_read_only_invalid_migration_source_is_refused_without_writes(self):
        old = self.root / "old-synthetic.db"
        new = self.root / "new-synthetic.db"
        for file in (old, new):
            with closing(sqlite3.connect(file)) as connection:
                connection.execute("CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,success INTEGER)")
                connection.execute("INSERT INTO _sqlx_migrations VALUES(1,1)")
                connection.commit()
        saved = hashlib.sha256(old.read_bytes()).digest()
        with closing(sqlite3.connect(old.as_uri() + "?mode=ro", uri=True)) as original, \
             closing(sqlite3.connect(new.as_uri() + "?mode=ro", uri=True)) as candidate:
            original.execute("PRAGMA query_only=ON")
            candidate.execute("PRAGMA query_only=ON")
            with self.assertRaisesRegex(ValueError, "true complete v29-to-v67"):
                qa.compare(original, candidate)
        self.assertEqual(hashlib.sha256(old.read_bytes()).digest(), saved)

    def test_all_mandatory_module_categories_are_present(self):
        self.assertEqual(set(qa.MODULES), {
            "catalog", "stock", "purchasing", "suppliers", "sales_pos",
            "patients", "cash", "accounting",
        })


if __name__ == "__main__":
    unittest.main()
