"""Disposable synthetic tests for current-declaration first-owner enrollment.

Never imports or writes any real/installed/archived pharmacy source. The only
artifact writes occur inside a short-lived temporary test directory.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import io
from pathlib import Path
import re
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from scripts import owner_first_enrollment as owner


@unittest.skipUnless(__import__("os").name == "nt", "Windows security APIs required")
class OwnerFirstEnrollmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.migrations = Path(owner.__file__).resolve().parent.parent / "src-tauri" / "migrations"
        cls.migrations_hashes = []
        for index in range(1, 68):
            choices = list(cls.migrations.glob(f"{index:03d}_*.sql"))
            assert len(choices) == 1
            cls.migrations_hashes.append((
                index, {1: "initial_schema", 2: "performance_tuning"}.get(
                    index, choices[0].stem.split("_", 1)[1]), 1,
                hashlib.sha384(choices[0].read_bytes()).digest()))
        mig32 = (cls.migrations / "032_remove_public_owner_bootstrap_credential.sql").read_text()
        cls.original_hash = re.search(r"AND password_hash = '([^']+)'", mig32).group(1)

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="owner_first_synthetic_")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.original = self.root / "original.sqlite3"
        self.sealed = self.root / "independent-seal.sqlite3"
        self.native = self.root / "signed-native-52.sqlite3"
        self._fixture()
        self.o_pin = owner._hash(self.original.read_bytes())
        self.s_pin = owner._hash(self.sealed.read_bytes())
        self.n_pin = owner._hash(self.native.read_bytes())
        # Production census is immutable at the CLI boundary; these patches
        # only let tiny synthetic physical fixtures exercise full comparison.
        self.census = patch.multiple(
            owner, EXPECTED_TABLES=5, EXPECTED_ROWS=36,
            SEALED_ACCOUNTS_SEQ=11, ORIGINAL_ACCOUNTS_SEQ=25)
        self.census.start()
        self.addCleanup(self.census.stop)

    def _fixture(self) -> None:
        with closing(sqlite3.connect(self.sealed)) as db:
            db.executescript("""
                CREATE TABLE _sqlx_migrations(
                    version INTEGER PRIMARY KEY, description TEXT NOT NULL,
                    success INTEGER NOT NULL, checksum BLOB NOT NULL,
                    execution_time INTEGER NOT NULL);
                CREATE TABLE users(
                    id TEXT PRIMARY KEY, role TEXT NOT NULL, is_active INTEGER,
                    password_hash TEXT, pharmacy_id TEXT);
                CREATE TABLE accounts(
                    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE);
                CREATE TABLE inventory(
                    id TEXT PRIMARY KEY, pharmacy_id TEXT, quantity REAL, sku BLOB);
                INSERT INTO accounts(id,code) VALUES(11,'test-account');
                INSERT INTO accounts(id,code) VALUES(3,'test-account-2');
                INSERT INTO inventory VALUES('item-a',NULL,0.125,X'00FF');
                INSERT INTO inventory VALUES('item-b','local_default',-0.0,X'10');
            """)
            db.execute(
                "INSERT INTO users VALUES('admin','owner',1,?,NULL)",
                (self.original_hash,))
            db.execute(
                "INSERT INTO users VALUES('staff','cashier',1,'synthetic-only','local_default')")
            db.executemany(
                "INSERT INTO _sqlx_migrations VALUES(?,?,?,?,0)",
                self.migrations_hashes[:29])
            db.commit()
        self.original.write_bytes(self.sealed.read_bytes())
        with closing(sqlite3.connect(self.original)) as db:
            db.execute("UPDATE sqlite_sequence SET seq=25 WHERE name='accounts'")
            db.commit()
        self.native.write_bytes(self.original.read_bytes())
        with closing(sqlite3.connect(self.native)) as db:
            db.execute("UPDATE users SET password_hash=NULL,pharmacy_id='local_default' "
                       "WHERE id='admin'")
            db.executemany("INSERT INTO _sqlx_migrations VALUES(?,?,?,?,0)",
                           self.migrations_hashes[29:52])
            db.commit()

    def _inspect(self, native: bool = True) -> dict:
        return owner.inspect_sources(
            root=self.root, original=self.original, sealed=self.sealed,
            migrations=self.migrations, original_pin=self.o_pin, sealed_pin=self.s_pin,
            native=self.native if native else None,
            native_sha256=self.n_pin if native else None)

    def test_inspect_read_only_and_explicit_known_sequence_discrepancy(self) -> None:
        before = {path: path.read_bytes() for path in (self.original, self.sealed,
                                                      self.native)}
        result = self._inspect(native=False)
        self.assertEqual(result["status"], "PASS_READ_ONLY_V29_CUSTODY")
        self.assertEqual(result["known_custody_difference"]["sealed_autoincrement"], 11)
        self.assertEqual(result["known_custody_difference"]["original_autoincrement"], 25)
        self.assertFalse(result["owner_authenticated_by_v29"])
        self.assertEqual(before, {path: path.read_bytes() for path in before})
        self.assertFalse((self.root / owner.FILE_SECRET).exists())

    def test_sidecars_refused_before_database_deserialization(self) -> None:
        sidecar = Path(str(self.sealed) + "-wal")
        sidecar.write_bytes(b"synthetic unsafe WAL")
        with self.assertRaisesRegex(owner.Refused, "sidecar"):
            self._inspect(native=False)
        sidecar.unlink()
        self.assertEqual(self._inspect(native=False)["v29_sqlx_migrations"], 29)

    def test_cli_enroll_missing_confirmation_fails_before_source_access(self) -> None:
        output = self.root / "should-not-exist"
        with patch("sys.stderr", new_callable=io.StringIO):
            status = owner.main([
                "enroll", "--output-dir", str(output), "--owner-id", "admin",
                "--native-source", str(self.native),
                "--native-sha256", self.n_pin])
        self.assertEqual(status, 2)
        self.assertFalse(output.exists())

    def test_native_52_and_67_are_only_supported_signed_copy_versions(self) -> None:
        result = self._inspect()
        self.assertEqual(result["native_sqlx_version"], 52)
        self.assertEqual(result["native_owner_changed_columns"],
                         ["password_hash", "pharmacy_id"])
        with closing(sqlite3.connect(self.native)) as db:
            db.executemany("INSERT INTO _sqlx_migrations VALUES(?,?,?,?,0)",
                           self.migrations_hashes[52:67])
            db.commit()
        self.n_pin = owner._hash(self.native.read_bytes())
        self.assertEqual(self._inspect()["native_sqlx_version"], 67)
        with closing(sqlite3.connect(self.native)) as db:
            db.execute("DELETE FROM _sqlx_migrations WHERE version>29")
            db.commit()
        self.n_pin = owner._hash(self.native.read_bytes())
        with self.assertRaisesRegex(owner.Refused, "52 or 67"):
            self._inspect()

    def test_rejects_business_row_change_bad_pin_and_owner_drift(self) -> None:
        with closing(sqlite3.connect(self.original)) as db:
            db.execute("UPDATE inventory SET quantity=100 WHERE id='item-a'")
            db.commit()
        with self.assertRaisesRegex(owner.Refused, "SHA-256"):
            self._inspect()
        self.o_pin = owner._hash(self.original.read_bytes())
        with self.assertRaisesRegex(owner.Refused, "historical data"):
            self._inspect()
        self.original.write_bytes(self.sealed.read_bytes())
        with closing(sqlite3.connect(self.original)) as db:
            db.execute("UPDATE sqlite_sequence SET seq=25 WHERE name='accounts'")
            db.commit()
        self.o_pin = owner._hash(self.original.read_bytes())
        with closing(sqlite3.connect(self.native)) as db:
            db.execute("UPDATE users SET password_hash='fake' WHERE id='admin'")
            db.commit()
        self.n_pin = owner._hash(self.native.read_bytes())
        with self.assertRaisesRegex(owner.Refused, "032"):
            self._inspect()

    def test_rejects_wrong_scope_wrong_seal_and_sqlx_checksum(self) -> None:
        with closing(sqlite3.connect(self.native)) as db:
            db.execute("UPDATE users SET pharmacy_id='another-tenant' WHERE id='admin'")
            db.commit()
        self.n_pin = owner._hash(self.native.read_bytes())
        with self.assertRaisesRegex(owner.Refused, "032"):
            self._inspect()
        self.native.write_bytes(self.original.read_bytes())
        with closing(sqlite3.connect(self.native)) as db:
            db.execute("UPDATE users SET password_hash=NULL,pharmacy_id='local_default' WHERE id='admin'")
            db.executemany("INSERT INTO _sqlx_migrations VALUES(?,?,?,?,0)",
                           self.migrations_hashes[29:52])
            db.execute("UPDATE _sqlx_migrations SET checksum=X'01' WHERE version=52")
            db.commit()
        self.n_pin = owner._hash(self.native.read_bytes())
        with self.assertRaisesRegex(owner.Refused, "checksum"):
            self._inspect()
        self.native.unlink()
        with self.assertRaises(owner.Refused):
            self._inspect()

    def test_key_created_only_after_explicit_verified_enroll_and_signed_public_verify(self) -> None:
        evidence = self._inspect()
        output = self.root / "synthetic-enrollment"
        with self.assertRaisesRegex(owner.Refused, "declaration"):
            owner.enroll(evidence=evidence, declaration="no", owner_id="admin",
                         directory=output, root=self.root)
        self.assertFalse(output.exists())
        with patch.object(owner, "_off_profile_new_directory") as safe_output:
            safe_output.return_value = None   # disposable tests only
            with patch.multiple(owner, ORIGINAL_PIN=self.o_pin, SEALED_PIN=self.s_pin):
                result = owner.enroll(
                    evidence=evidence,
                    declaration="I currently declare my responsibility as first owner for this isolated test.",
                    owner_id="admin", directory=output, root=self.root)
                self.assertEqual(result["status"], "CURRENT_DECLARATION_SIGNED_AND_DPAPI_SEALED")
                private = (output / owner.FILE_SECRET).read_bytes()
                public = (output / owner.FILE_MANIFEST).read_bytes()
                self.assertNotIn(b"PRIVATE KEY", private)
                self.assertNotIn(b"synthetic-only", public)
                _, _, _, win32crypt, *_ = owner._crypto()
                seed = win32crypt.CryptUnprotectData(private, None, None, None, 0)[1]
                self.assertEqual(len(seed), 32)
                self.assertNotEqual(private, seed)
                self.assertEqual(owner.verify_certificate(output)["status"],
                                 "PUBLIC_CURRENT_DECLARATION_SIGNATURE_VERIFIED")
                with self.assertRaises(FileExistsError):
                    owner.enroll(evidence=evidence,
                                 declaration="I currently claim first owner responsibility for this test.",
                                 owner_id="admin", directory=output, root=self.root)
                cert = output / owner.FILE_CERTIFICATE
                cert.write_bytes(cert.read_bytes().replace(b"signature_ed25519_hex",
                                                          b"forged_signature_hex"))
                with self.assertRaises(owner.Refused):
                    owner.verify_certificate(output)

    def test_incomplete_crash_output_does_not_pass_public_verification(self) -> None:
        folder = self.root / "partial"
        folder.mkdir()
        with self.assertRaises(owner.Refused):
            owner.verify_certificate(folder)


if __name__ == "__main__":
    unittest.main()
