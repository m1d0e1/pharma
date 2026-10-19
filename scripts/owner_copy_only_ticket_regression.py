"""Disposable Windows regression for native COPY-ONLY ticket producer.

Creates only short-lived synthetic SQLx source, synthetic Ed25519/DPAPI
enrollment, and synthetic stage. Never opens, decrypts or signs with the real
original-owner enrollment or any real pharmacy database.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from scripts import owner_copy_only_ticket as ticket
from scripts import owner_first_enrollment as custody


@unittest.skipUnless(os.name == "nt", "Requires Windows CurrentUser DPAPI")
class CopyOnlySyntheticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.migrations = Path(ticket.__file__).resolve().parent.parent / "src-tauri" / "migrations"
        cls.sqlx = []
        for version in range(1, 68):
            candidates = list(cls.migrations.glob(f"{version:03d}_*.sql"))
            assert len(candidates) == 1
            path = candidates[0]
            desc = {1: "initial_schema", 2: "performance_tuning"}.get(
                version, path.stem.split("_", 1)[1])
            cls.sqlx.append((version, desc, 1, hashlib.sha384(path.read_bytes()).digest(), 0))

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="native_copy_ticket_synthetic_")
        self.addCleanup(temporary.cleanup)
        self.parent = Path(temporary.name)
        self.root = self.parent / "pharma-disposable-data-copies"
        self.root.mkdir()
        subdir = self.root / ticket.NATIVE_SOURCE_SUBDIR
        subdir.mkdir()
        self.source = subdir / ticket.NATIVE_SOURCE_NAME
        with closing(sqlite3.connect(self.source)) as db:
            db.executescript("""
                CREATE TABLE _sqlx_migrations(version INTEGER PRIMARY KEY,
                  description TEXT,success INTEGER,checksum BLOB,execution_time INTEGER);
                CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT NOT NULL,
                  is_active INTEGER,password_hash TEXT,pharmacy_id TEXT);
                CREATE TABLE widgets(id INTEGER PRIMARY KEY, pharmacy_id TEXT, quantity REAL);
                CREATE TABLE sqliteXcustom(id INTEGER PRIMARY KEY,pharmacy_id TEXT);
                INSERT INTO users VALUES('admin','owner',1,NULL,'local_default');
                INSERT INTO widgets VALUES(1,NULL,0.125);
                INSERT INTO widgets VALUES(2,'',-0.0);
                INSERT INTO widgets VALUES(3,'primary_pharmacy',20);
                INSERT INTO widgets VALUES(4,'local_default',30);
                INSERT INTO sqliteXcustom VALUES(8,NULL);
            """)
            db.executemany("INSERT INTO _sqlx_migrations VALUES(?,?,?,?,?)", self.sqlx)
            db.commit()
        self.pin = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.pins = [
            patch.object(ticket, "NATIVE_SOURCE_PIN", self.pin),
            patch.object(custody, "ORIGINAL_PIN", "a" * 64),
            patch.object(custody, "SEALED_PIN", "b" * 64),
            patch.object(custody, "_off_profile_new_directory", lambda *_: None),
            patch.object(custody, "inspect_sources",
                         return_value={
                            "status": "PASS_NATIVE_SOURCE_BOUND_FOR_CURRENT_DECLARATION",
                            "native_sqlx_version": 67,
                            "native_source_sha256": self.pin,
                            "known_custody_difference": {
                                "table": "sqlite_sequence",
                                "entry": "accounts",
                                "sealed_autoincrement": 11,
                                "original_autoincrement": 25,
                                "historical_writer_proven": False,
                            }
                         }),
        ]
        for patched in self.pins:
            patched.start()
            self.addCleanup(patched.stop)
        with closing(sqlite3.connect(":memory:")) as db:
            db.deserialize(self.source.read_bytes())
            db.execute("PRAGMA query_only=ON")
            self.count, self.digest = ticket.originals_and_scope_sha(db)
        self.expected = patch.multiple(
            ticket, EXPECTED_SCOPE_SHA=self.digest, EXPECTED_ORIGINAL_SCOPE_CELLS=self.count)
        self.expected.start()
        self.addCleanup(self.expected.stop)
        self.enrolled = self.parent / "synthetic-owner-enrollment"
        self.original = self.root / "not-consulted-synthetic-original"
        self.sealed = self.root / "not-consulted-synthetic-seal"
        custody.enroll(
            evidence={
                "status": "PASS_NATIVE_SOURCE_BOUND_FOR_CURRENT_DECLARATION",
                "original_v29_sha256": custody.ORIGINAL_PIN,
                "independently_sealed_v29_sha256": custody.SEALED_PIN,
                "native_source_sha256": self.pin,
                "native_sqlx_version": 67,
                "v29_physical_tables": 5, "v29_physical_rows": 100,
                "known_custody_difference": {"table": "sqlite_sequence",
                                              "entry": "accounts",
                                              "historical_writer_proven": False},
            },
            declaration="I currently declare responsibility for my disposable synthetic test.",
            owner_id="admin", directory=self.enrolled, root=self.root)

    def _preview(self) -> dict:
        report, _, _ = ticket.preview(
            root=self.root, source=self.source, enrolled=self.enrolled,
            original=self.original, sealed=self.sealed, migrations=self.migrations)
        return report

    def _issue(self, *, now: int = 1_900_000_000,
               expires: int = 1_900_000_300) -> dict:
        return ticket.issue(
            root=self.root, source=self.source, enrolled=self.enrolled,
            original=self.original, sealed=self.sealed, migrations=self.migrations,
            confirm=ticket.CONFIRM, now=now, expires_unix_seconds=expires)

    def test_preflight_synthetic_with_exact_nonsecret_census(self) -> None:
        before = self.source.read_bytes()
        result = self._preview()
        self.assertEqual(result["status"], "PASS_READ_ONLY_COPY_ONLY_TICKET_PREFLIGHT")
        self.assertEqual(result["scope_sha256"], self.digest)
        self.assertEqual(result["original_scope_cells_requiring_copy_only_normalization"], 5)
        self.assertEqual(before, self.source.read_bytes())

    def test_native_framing_matches_independent_explicit_fixture(self) -> None:
        # Regression fixture includes sqliteXcustom: SQLite LIKE 'sqlite_%'
        # would incorrectly exclude this legitimate directly-scoped table.
        def independent_frame(sha, data):
            sha.update(len(data).to_bytes(8, "big") + data)
        sha = hashlib.sha256()
        independent_frame(sha, ticket.SCOPE_DOMAIN)
        for name, rows in [
            ("sqliteXcustom", [(8, "null", "")]),
            ("users", [(1, "text", "local_default")]),
            ("widgets", [(1, "null", ""), (2, "text", ""),
                         (3, "text", "primary_pharmacy"),
                         (4, "text", "local_default")]),
        ]:
            independent_frame(sha, name.encode())
            for rowid, storage, literal in rows:
                independent_frame(sha, rowid.to_bytes(8, "big", signed=True))
                independent_frame(sha, storage.encode())
                independent_frame(sha, literal.encode())
        self.assertEqual(self.digest, sha.hexdigest())
        nonce = bytes(range(1, 33))
        expires = 1_900_000_500
        identity = hashlib.sha256()
        independent_frame(identity, b"admin")
        independent_frame(identity, b"primary_pharmacy")
        expected = (ticket.DOMAIN + (67).to_bytes(8, "big", signed=True) +
                    bytes.fromhex("b" * 64) + bytes.fromhex(self.pin) +
                    bytes.fromhex(self.digest) + nonce + expires.to_bytes(8, "big") +
                    identity.digest())
        message = ticket.message_bytes(
            version=67, original_v29_sha="b" * 64, source_sha=self.pin,
            scope_sha=self.digest, nonce=nonce, expires=expires, owner_id="admin")
        self.assertEqual(message, expected)

    def test_signed_stage_only_two_files_dpapi_real_synthetic_signer(self) -> None:
        signed = self._issue()
        folder = self.root / signed["stage_token"]
        self.assertTrue(folder.is_dir())
        self.assertEqual(sorted(x.name for x in folder.iterdir()),
                         ["snapshot.sqlite3", "ticket.json"])
        self.assertEqual((folder / "snapshot.sqlite3").read_bytes(),
                         self.source.read_bytes())
        wire = json.loads((folder / "ticket.json").read_bytes())
        manifest = json.loads((self.enrolled / custody.FILE_MANIFEST).read_bytes())
        ticket.verify_ticket(
            wire, version=67, public_key_hex=manifest["public_key_ed25519_hex"],
            original_v29_sha=custody.SEALED_PIN, now=1_900_000_000,
            expected_source_sha=self.pin, expected_scope_sha=self.digest)
        self.assertEqual(len(wire), 5)
        self.assertTrue(ticket._source_claim(self.root, self.pin).is_file())
        self.assertFalse(signed["release_or_login_granted"])
        with self.assertRaisesRegex(ticket.Refused, "already"):
            self._issue()

    def test_tamper_wrong_public_key_expiry_nonce_and_signature(self) -> None:
        signed = self._issue()
        wire = json.loads((self.root / signed["stage_token"] / "ticket.json").read_bytes())
        manifest = json.loads((self.enrolled / custody.FILE_MANIFEST).read_bytes())
        pub = manifest["public_key_ed25519_hex"]
        ok = dict(version=67, public_key_hex=pub, original_v29_sha=custody.SEALED_PIN,
                  now=1_900_000_000, expected_source_sha=self.pin,
                  expected_scope_sha=self.digest)
        for change in (
            {"source_sha256": "0" * 64},
            {"scope_sha256": "0" * 64},
            {"nonce": "0" * 64},
            {"ed25519_signature": "0" * 128},
            {"expires_unix_seconds": 1_899_999_999},
            {"expires_unix_seconds": 1_900_000_000 + ticket.MAX_AGE + 1},
            {"nonce": 123},
            {"extra": "not a native field"},
        ):
            damaged = dict(wire, **change)
            with self.assertRaises(ticket.Refused):
                ticket.verify_ticket(damaged, **ok)
        with self.assertRaises(ticket.Refused):
            ticket.verify_ticket(wire, **{**ok, "public_key_hex": "0" * 64})
        with self.assertRaises(ticket.Refused):
            ticket.verify_ticket(wire, **{**ok, "version": 52})

    def test_reject_foreign_scope_blob_hidden_and_bad_scope(self) -> None:
        with closing(sqlite3.connect(":memory:")) as db:
            db.deserialize(self.source.read_bytes())
            db.execute("UPDATE widgets SET pharmacy_id='another-tenant' WHERE id=1")
            with self.assertRaisesRegex(ticket.Refused, "Foreign"):
                ticket.originals_and_scope_sha(db)
            db.execute("UPDATE widgets SET pharmacy_id=X'01' WHERE id=1")
            with self.assertRaisesRegex(ticket.Refused, "storage"):
                ticket.originals_and_scope_sha(db)
            db.execute("UPDATE widgets SET pharmacy_id=NULL WHERE id=1")
            db.execute("CREATE TABLE hidden_scope(pharmacy_id TEXT, "
                       "generated TEXT GENERATED ALWAYS AS (pharmacy_id) VIRTUAL)")
            with self.assertRaisesRegex(ticket.Refused, "hidden"):
                ticket.originals_and_scope_sha(db)
        # U+001C is stripped by Python str.strip but not by Rust str.trim.
        # Accepting it would produce a ticket native Rust would reject.
        with closing(sqlite3.connect(":memory:")) as db:
            db.deserialize(self.source.read_bytes())
            db.execute("UPDATE widgets SET pharmacy_id=? WHERE id=1", ("\x1c",))
            with self.assertRaisesRegex(ticket.Refused, "Foreign"):
                ticket.originals_and_scope_sha(db)

    def test_source_hash_drift_denied_without_claim_or_signing(self) -> None:
        with closing(sqlite3.connect(self.source)) as db:
            db.execute("UPDATE widgets SET quantity=999 WHERE id=1")
            db.commit()
        with self.assertRaises(ticket.Refused):
            self._issue()
        self.assertFalse(ticket._source_claim(self.root, self.pin).exists())
        self.assertFalse(any(p.is_dir() and ticket.TOKEN.fullmatch(p.name)
                             for p in self.root.iterdir()))

    def test_reject_noncurrent_dpapi_enrolled_key_and_burn_claim(self) -> None:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption
        import win32crypt
        other = Ed25519PrivateKey.generate().private_bytes(
            Encoding.Raw, PrivateFormat.Raw, NoEncryption())
        wrong_dpapi = win32crypt.CryptProtectData(other, "synthetic wrong signer",
                                                  None, None, None, 0)
        (self.enrolled / custody.FILE_SECRET).write_bytes(wrong_dpapi)
        with self.assertRaisesRegex(ticket.Refused, "differs"):
            self._issue()
        self.assertTrue(ticket._source_claim(self.root, self.pin).is_file())
        self.assertFalse(any(p.is_dir() and ticket.TOKEN.fullmatch(p.name)
                             for p in self.root.iterdir()))

    def test_confirmation_and_expiry_refuse_before_any_key_or_output(self) -> None:
        with self.assertRaisesRegex(ticket.Refused, "confirmation"):
            ticket.issue(
                root=self.root, source=self.source, enrolled=self.enrolled,
                original=self.original, sealed=self.sealed,
                migrations=self.migrations, confirm="guess",
                now=100, expires_unix_seconds=200)
        for expiry in (100, 100 + ticket.MAX_AGE + 1, -1):
            with self.assertRaises(ticket.Refused):
                self._issue(now=100, expires=expiry)
        self.assertFalse(ticket._source_claim(self.root, self.pin).exists())


if __name__ == "__main__":
    unittest.main()
