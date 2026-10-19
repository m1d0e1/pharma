#!/usr/bin/env python3
"""Synthetic RAM-only Ed25519 legacy source custody adversarial regressions.

No production archives, operational signers, installed trust roots, files,
UI state, tenant mappings, credentials, or native databases are accessed.
Private test keys are generated in memory and never printed or persisted.
"""
from __future__ import annotations

import base64
from contextlib import redirect_stderr, redirect_stdout
import copy
import io
import json
import os
import sqlite3
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from scripts import qa_legacy_ownership_approvals as audit


def sample_bytes() -> bytes:
    db = sqlite3.connect(":memory:")
    try:
        db.execute("CREATE TABLE history (id TEXT PRIMARY KEY, amount BLOB, detail BLOB)")
        db.execute("CREATE TABLE zero_rows (value TEXT)")
        db.execute("INSERT INTO history VALUES (?, ?, ?)",
                   ("record-a", 17.5, b"\x00\xff\x01"))
        db.execute("INSERT INTO history VALUES (?, ?, ?)",
                   ("record-b", None, "private-synthetic-only"))
        db.commit()
        return db.serialize()
    finally:
        db.close()


def changed_bytes(raw: bytes, sql: str) -> bytes:
    db = sqlite3.connect(":memory:")
    try:
        db.deserialize(raw)
        db.execute(sql)
        db.commit()
        return db.serialize()
    finally:
        db.close()


def known_fts_bytes() -> bytes:
    """Real migration's external-content FTS5 plus its four generated shadows."""
    db = sqlite3.connect(":memory:")
    try:
        db.executescript("""
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY,
              trade_name TEXT,
              trade_name_en TEXT,
              generic_name TEXT,
              active_ingredient TEXT
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS master_drugs_fts USING fts5(
              id UNINDEXED,
              trade_name,
              trade_name_en,
              generic_name,
              active_ingredient,
              content='master_drugs',
              content_rowid='id'
            );
            INSERT INTO master_drugs VALUES(1,'SYNTHETIC ONE','First','Drug','a');
            INSERT INTO master_drugs VALUES(2,'SYNTHETIC TWO','Second','Drug','b');
            INSERT INTO master_drugs_fts(rowid,id,trade_name,trade_name_en,generic_name,active_ingredient)
              SELECT id,id,trade_name,trade_name_en,generic_name,active_ingredient
              FROM master_drugs;
        """)
        db.commit()
        return db.serialize()
    finally:
        db.close()


def rebuilt_fts_009_bytes() -> bytes:
    """Current real migration 009 column layout, synthetic rows only."""
    db = sqlite3.connect(":memory:")
    try:
        db.executescript("""
            CREATE TABLE master_drugs (
                id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT,
                generic_name TEXT, active_ingredient TEXT, manufacturer TEXT, category TEXT
            );
            CREATE VIRTUAL TABLE master_drugs_fts USING fts5(
                id UNINDEXED, trade_name, trade_name_en, generic_name,
                active_ingredient, manufacturer, category,
                content='master_drugs', content_rowid='id'
            );
            INSERT INTO master_drugs VALUES(1,'synthetic','one','drug','a','maker','group');
            INSERT INTO master_drugs VALUES(2,'synthetic','two','drug','b','maker','group');
            INSERT INTO master_drugs_fts(
                rowid,id,trade_name,trade_name_en,generic_name,
                active_ingredient,manufacturer,category
            ) SELECT id,id,trade_name,trade_name_en,generic_name,
                active_ingredient,manufacturer,category FROM master_drugs;
        """)
        db.commit()
        return db.serialize()
    finally:
        db.close()


def pub_bytes(key: Ed25519PrivateKey) -> bytes:
    return key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )


def signed_bundle(
    source: audit.SourceCommitment,
    owner: Ed25519PrivateKey,
    reviewer: Ed25519PrivateKey,
    *,
    nonce: str,
    now: int,
) -> dict:
    statement = {
        "format": audit.FORMAT,
        "custody_purpose": audit.PURPOSE,
        "source_sha256": source.source_sha256,
        "all_rows_typed_sha256": source.all_rows_typed_sha256,
        "schema_sha256": source.schema_sha256,
        "target_tenant": "independently-known-branch-A",
        "full_row_count": source.full_row_count,
        "table_count": source.table_count,
        "source_size_bytes": source.source_size_bytes,
        "request_id": nonce,
        "owner_signer_id": "owner-authority-A",
        "reviewer_signer_id": "review-authority-B",
        "issued_at_utc": now - 30,
        "expires_at_utc": now + 600,
    }
    signed = audit._canonical(statement)
    signatures = {}
    for role, identifier, key in (
        ("owner", "owner-authority-A", owner),
        ("reviewer", "review-authority-B", reviewer),
    ):
        signature = key.sign(
            audit.DOMAIN + role.encode("ascii") + b"\x00" + signed
        )
        signatures[role] = {
            "signer_id": identifier,
            "signature_b64": base64.urlsafe_b64encode(signature).rstrip(b"=").decode(),
        }
    return {"statement": statement, "signatures": signatures}


class IndependentCustodyApprovalRegressions(unittest.TestCase):
    def setUp(self) -> None:
        self.original = sample_bytes()
        self.source = audit.snapshot_sqlite_bytes(self.original)
        self.owner = Ed25519PrivateKey.generate()
        self.reviewer = Ed25519PrivateKey.generate()
        self.roots = audit._TrustRoots(
            audit._PinnedSigner("owner-authority-A", pub_bytes(self.owner)),
            audit._PinnedSigner("review-authority-B", pub_bytes(self.reviewer)),
        )
        self.nonce = str(uuid.uuid4())
        self.now = int(time.time())
        self.bundle = signed_bundle(
            self.source, self.owner, self.reviewer,
            nonce=self.nonce, now=self.now,
        )
        self.consumed: set[str] = set()

    def check(self, bundle=None, source=None, roots=None, *, nonce=None, tenant=None, now=None):
        return audit._crypto_evidence_only(
            self.bundle if bundle is None else bundle,
            self.source if source is None else source,
            self.roots if roots is None else roots,
            expected_tenant=tenant or "independently-known-branch-A",
            expected_request_id=nonce or self.nonce,
            now_utc=self.now if now is None else now,
            consumed_request_ids=self.consumed,
        )

    def test_legitimate_independently_pinned_signatures_are_crypto_only(self):
        self.assertEqual(self.source.full_row_count, 2)
        self.assertEqual(self.source.table_count, 2)
        self.assertEqual(len(self.source.schema_sha256), 64)
        self.assertIn("NOT_OPERATIONAL_AUTHORIZATION", self.check())
        self.assertEqual(self.consumed, {self.nonce})

    def test_same_nonce_replay_and_unexpected_request_denied(self):
        self.check()
        with self.assertRaises(audit.CustodyDenied):
            self.check()
        self.consumed.clear()
        with self.assertRaises(audit.CustodyDenied):
            self.check(nonce=str(uuid.uuid4()))

    def test_tampered_all_statement_fields_denied(self):
        replacements = {
            "format": "another-format",
            "custody_purpose": "authorize-import",
            "source_sha256": "a" * 64,
            "all_rows_typed_sha256": "a" * 64,
            "schema_sha256": "a" * 64,
            "full_row_count": 3,
            "table_count": 1,
            "source_size_bytes": 17,
            "target_tenant": "foreign-pharmacy",
            "request_id": str(uuid.uuid4()),
            "owner_signer_id": "someone-else",
            "reviewer_signer_id": "someone-else",
            "issued_at_utc": self.now + 900,
            "expires_at_utc": self.now - 10,
        }
        for field, value in replacements.items():
            with self.subTest(field=field):
                tampered = copy.deepcopy(self.bundle)
                tampered["statement"][field] = value
                with self.assertRaises(audit.CustodyDenied):
                    self.check(bundle=tampered)
        self.assertEqual(self.consumed, set())

    def test_signed_but_wrong_tenant_and_incomplete_or_extended_claims_denied(self):
        with self.assertRaises(audit.CustodyDenied):
            self.check(tenant="other-tenant")
        for key in ("source_sha256", "full_row_count"):
            malformed = copy.deepcopy(self.bundle)
            del malformed["statement"][key]
            with self.assertRaises(audit.CustodyDenied):
                self.check(bundle=malformed)
        extended = copy.deepcopy(self.bundle)
        extended["public_key"] = pub_bytes(self.owner).hex()
        with self.assertRaises(audit.CustodyDenied):
            self.check(bundle=extended)
        self.assertEqual(self.consumed, set())

    def test_two_cryptographically_valid_signatures_from_same_key_fail(self):
        same_roots = audit._TrustRoots(
            self.roots.owner,
            audit._PinnedSigner("review-authority-B", pub_bytes(self.owner)),
        )
        same_bundle = signed_bundle(
            self.source, self.owner, self.owner, nonce=self.nonce, now=self.now
        )
        with self.assertRaises(audit.CustodyDenied):
            self.check(bundle=same_bundle, roots=same_roots)

    def test_two_signer_ids_cannot_represent_one_identity(self):
        aliases = audit._TrustRoots(
            self.roots.owner,
            audit._PinnedSigner("owner-authority-A", pub_bytes(self.reviewer)),
        )
        with self.assertRaises(audit.CustodyDenied):
            self.check(roots=aliases)

    def test_role_swap_or_forged_signatures_denied(self):
        swapped = copy.deepcopy(self.bundle)
        swapped["signatures"]["owner"]["signature_b64"], swapped["signatures"]["reviewer"]["signature_b64"] = (
            swapped["signatures"]["reviewer"]["signature_b64"],
            swapped["signatures"]["owner"]["signature_b64"],
        )
        with self.assertRaises(audit.CustodyDenied):
            self.check(bundle=swapped)
        forged = copy.deepcopy(self.bundle)
        forged["signatures"]["reviewer"]["signature_b64"] = base64.urlsafe_b64encode(
            b"\0" * 64
        ).rstrip(b"=").decode()
        with self.assertRaises(audit.CustodyDenied):
            self.check(bundle=forged)
        self.assertEqual(self.consumed, set())

    def test_missing_roots_missing_signature_and_bundle_keys_fail(self):
        with self.assertRaises(audit.CustodyDenied):
            self.check(roots="untrusted-caller-root")
        with self.assertRaises(audit.CustodyDenied):
            audit._crypto_evidence_only(
                self.bundle, self.source, None,
                expected_tenant="independently-known-branch-A",
                expected_request_id=self.nonce,
                now_utc=self.now, consumed_request_ids=set(),
            )
        missing = copy.deepcopy(self.bundle)
        missing["signatures"].pop("reviewer")
        with self.assertRaises(audit.CustodyDenied):
            self.check(bundle=missing)

    def test_expiry_and_default_tenant_denied_even_with_valid_signatures(self):
        with self.assertRaises(audit.CustodyDenied):
            self.check(now=self.now + 601)
        forbidden = signed_bundle(
            self.source, self.owner, self.reviewer,
            nonce=self.nonce, now=self.now,
        )
        forbidden["statement"]["target_tenant"] = "local_default"
        with self.assertRaises(audit.CustodyDenied):
            self.check(bundle=forbidden, tenant="local_default")

    def test_all_typed_rows_changes_do_not_escape_commitment(self):
        for sql in (
            "UPDATE history SET amount=18.5 WHERE id='record-a'",
            "UPDATE history SET amount=17 WHERE id='record-a'",
            "UPDATE history SET amount='17.5' WHERE id='record-a'",
            "UPDATE history SET detail=X'01FF00' WHERE id='record-a'",
            "DELETE FROM history WHERE id='record-b'",
            "INSERT INTO zero_rows VALUES ('extra')",
        ):
            with self.subTest(sql=sql):
                changed = audit.snapshot_sqlite_bytes(changed_bytes(self.original, sql))
                self.assertNotEqual(changed.source_sha256, self.source.source_sha256)
                self.assertNotEqual(changed.all_rows_typed_sha256, self.source.all_rows_typed_sha256)
                with self.assertRaises(audit.CustodyDenied):
                    self.check(source=changed)

    def test_schema_changes_affect_both_schema_and_source_digest(self):
        altered = audit.snapshot_sqlite_bytes(
            changed_bytes(self.original, "ALTER TABLE zero_rows ADD COLUMN secret TEXT")
        )
        self.assertNotEqual(altered.schema_sha256, self.source.schema_sha256)
        self.assertNotEqual(altered.source_sha256, self.source.source_sha256)
        with self.assertRaises(audit.CustodyDenied):
            self.check(source=altered)

    def test_wal_mode_snapshot_header_and_unverifiable_virtual_table_denied(self):
        not_detached = bytearray(self.original)
        not_detached[18:20] = b"\x02\x02"
        with self.assertRaises(audit.CustodyDenied):
            audit.snapshot_sqlite_bytes(bytes(not_detached))
        with self.assertRaises(audit.CustodyDenied):
            audit.snapshot_sqlite_bytes(
                changed_bytes(
                    self.original,
                    "CREATE VIRTUAL TABLE search_index USING fts5(content)",
                )
            )

    def test_exact_known_external_fts_and_four_shadows_have_stable_full_commitments(self):
        raw = known_fts_bytes()
        first = audit.snapshot_sqlite_bytes(raw)
        again = audit.snapshot_sqlite_bytes(raw)
        self.assertEqual(first, again)
        self.assertEqual(first.table_count, 6)  # catalog + virtual + 4 shadows
        self.assertGreaterEqual(first.full_row_count, 7)
        with sqlite3.connect(":memory:") as db:
            db.deserialize(raw)
            names = {name for (name,) in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )}
        self.assertEqual(names, {
            "master_drugs", "master_drugs_fts", "master_drugs_fts_config",
            "master_drugs_fts_data", "master_drugs_fts_docsize",
            "master_drugs_fts_idx",
        })

    def test_current_009_rebuild_full_fts_source_and_shadow_hashes(self):
        baseline = rebuilt_fts_009_bytes()
        initial = audit.snapshot_sqlite_bytes(baseline)
        self.assertEqual(initial.table_count, 6)
        self.assertGreater(initial.full_row_count, 7)
        changed = audit.snapshot_sqlite_bytes(changed_bytes(
            baseline, "UPDATE master_drugs SET category='new-group' WHERE id=1"
        ))
        self.assertNotEqual(initial.all_rows_typed_sha256, changed.all_rows_typed_sha256)
        self.assertNotEqual(initial.source_sha256, changed.source_sha256)

    def test_fts_visible_and_all_shadow_changes_break_typed_source_commitment(self):
        original = known_fts_bytes()
        baseline = audit.snapshot_sqlite_bytes(original)
        mutations = (
            "UPDATE master_drugs SET trade_name='DIFFERENT' WHERE id=1",
            "DELETE FROM master_drugs WHERE id=2",
            "INSERT INTO master_drugs_fts_config(k,v) VALUES('synthetic-new',17)",
            "INSERT INTO master_drugs_fts_docsize(id,sz) VALUES(12345,X'0102')",
            "INSERT INTO master_drugs_fts_data(id,block) VALUES(12345,X'0102')",
            "INSERT INTO master_drugs_fts_idx(segid,term,pgno) "
            "VALUES(12345,X'0102',1)",
        )
        for sql in mutations:
            with self.subTest(sql=sql):
                altered = audit.snapshot_sqlite_bytes(changed_bytes(original, sql))
                self.assertNotEqual(altered.source_sha256, baseline.source_sha256)
                self.assertNotEqual(altered.all_rows_typed_sha256,
                                    baseline.all_rows_typed_sha256)

    def test_fts_schema_spoofing_arbitrary_virtuals_and_lost_shadow_are_denied(self):
        original = known_fts_bytes()
        tests = (
            "DROP TABLE master_drugs_fts_config",
            "CREATE VIRTUAL TABLE foreign_virtual USING fts5(data)",
            "CREATE VIRTUAL TABLE foreign_rtree USING rtree(id,x,y)",
            "CREATE TABLE master_drugs_fts_EXTRA(data TEXT)",
        )
        for sql in tests:
            with self.subTest(sql=sql):
                with self.assertRaises(audit.CustodyDenied):
                    audit.snapshot_sqlite_bytes(changed_bytes(original, sql))
        for ddl in (
            "CREATE VIRTUAL TABLE master_drugs_fts USING fts5("
            "id UNINDEXED,trade_name,trade_name_en,generic_name,active_ingredient)",
            "CREATE VIRTUAL TABLE master_drugs_fts USING fts5("
            "id UNINDEXED,trade_name,trade_name_en,generic_name,active_ingredient,"
            "content='another_table',content_rowid='id')",
            "CREATE VIRTUAL TABLE master_drugs_fts USING fts5("
            "id UNINDEXED,trade_name,trade_name_en,generic_name,active_ingredient,"
            "tokenize='porter',content='master_drugs',content_rowid='id')",
        ):
            with self.subTest(ddl=ddl):
                db = sqlite3.connect(":memory:")
                try:
                    db.execute("CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,"
                               "trade_name TEXT,trade_name_en TEXT,"
                               "generic_name TEXT,active_ingredient TEXT)")
                    db.execute(ddl)
                    with self.assertRaises(audit.CustodyDenied):
                        audit.snapshot_sqlite_bytes(db.serialize())
                finally:
                    db.close()

    def test_cli_requires_approved_detached_location_and_source_pin_even_if_roots_mocked(self):
        # Only synthetic cryptographic roots are mocked, never installed.
        known_sha = self.source.source_sha256
        params = [
            "--source", "wrong-location/production_snapshot_immutable.sqlite3",
            "--approvals", "synthetic-memory.json",
            "--expected-sha256", known_sha,
            "--expected-tenant", "independently-known-branch-A",
            "--expected-request-id", self.nonce,
        ]
        with patch.object(audit, "_installed_operational_roots", return_value=self.roots), \
                patch.object(audit, "approved_archive",
                             side_effect=audit.CustodyDenied("disallowed")) as approved, \
                patch.object(audit, "_read_detached_file",
                             side_effect=AssertionError("should never open")), \
                patch.dict(os.environ, {"LOCALAPPDATA": "synthetic-root"}):
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                self.assertEqual(audit.main(params), 3)
            self.assertEqual(approved.call_count, 1)
            self.assertIn("DENIED", stderr.getvalue())
        with patch.object(audit, "_installed_operational_roots", return_value=self.roots), \
                patch.object(audit, "approved_archive", return_value=Path("approved-archive")), \
                patch.object(audit, "digest_file", return_value="1" * 64), \
                patch.object(audit, "_read_detached_file",
                             side_effect=AssertionError("pin must precede opening")), \
                patch.dict(os.environ, {"LOCALAPPDATA": "synthetic-root"}):
            with redirect_stderr(io.StringIO()):
                self.assertEqual(audit.main(params), 3)

    def test_hypothetical_verified_cli_path_rechecks_pin_and_never_grants_authority(self):
        # Artificial in-RAM roots and fake approved location exercise only
        # plumbing; production installs NO independent roots and always denies.
        args = [
            "--source", "synthetic-source",
            "--approvals", "synthetic-signatures",
            "--expected-sha256", self.source.source_sha256,
            "--expected-tenant", "independently-known-branch-A",
            "--expected-request-id", self.nonce,
        ]
        signed_json = json.dumps(self.bundle).encode()
        for trailing_pin, expected_rc in (
            (self.source.source_sha256, 0),
            ("f" * 64, 3),
        ):
            with self.subTest(repin_ok=expected_rc == 0):
                with patch.object(audit, "_installed_operational_roots",
                                  return_value=self.roots), \
                        patch.object(audit, "approved_archive",
                                     return_value=Path("synthetic-verified-location")) as approved, \
                        patch.object(audit, "digest_file",
                                     side_effect=[self.source.source_sha256, trailing_pin]) as digest, \
                        patch.object(audit, "_read_detached_file",
                                     side_effect=[self.original, signed_json]) as reader, \
                        patch.dict(os.environ, {"LOCALAPPDATA": "synthetic-root"}):
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        self.assertEqual(audit.main(args), expected_rc)
                    approved.assert_called_once_with(
                        Path("synthetic-source"), Path("synthetic-root")
                    )
                    self.assertEqual(digest.call_count, 2)
                    self.assertEqual(reader.call_count, 2)
                    self.assertNotIn("private-synthetic-only", stdout.getvalue())
                    if expected_rc == 0:
                        self.assertIn("NO MIGRATION OR TENANT AUTHORIZATION",
                                      stdout.getvalue())
                    else:
                        self.assertEqual(stdout.getvalue(), "")
                        self.assertIn("DENIED", stderr.getvalue())

    def test_cli_fails_before_archive_or_approval_reads_without_independent_roots(self):
        params = [
            "--source", "production_snapshot_immutable.sqlite3",
            "--approvals", "synthetic-memory.json",
            "--expected-sha256", self.source.source_sha256,
            "--expected-tenant", "independently-known-branch-A",
            "--expected-request-id", self.nonce,
        ]
        with patch.object(audit, "approved_archive",
                          side_effect=AssertionError("cannot access source location")), \
                patch.object(audit, "_read_detached_file",
                             side_effect=AssertionError("cannot read private source")), \
                patch.dict(os.environ, {"LOCALAPPDATA": "synthetic-root"}):
            with redirect_stderr(io.StringIO()):
                self.assertEqual(audit.main(params), 3)

    def test_cli_refuses_before_any_source_or_bundle_read_even_with_fixture_env(self):
        fake_args = [
            "--source", "does-not-exist.sqlite3",
            "--approvals", "does-not-exist.json",
            "--expected-sha256", self.source.source_sha256,
            "--expected-tenant", "fake-tenant",
            "--expected-request-id", self.nonce,
        ]
        with patch.dict(os.environ, {
            "PHARMA_OWNER_APPROVAL_PUBLIC_KEY": pub_bytes(self.owner).hex(),
            "PHARMA_REVIEWER_APPROVAL_PUBLIC_KEY": pub_bytes(self.reviewer).hex(),
        }), patch.object(audit, "_read_detached_file", side_effect=AssertionError("opened")):
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                self.assertEqual(audit.main(fake_args), 3)
            self.assertIn("DENIED", stderr.getvalue())
            self.assertNotIn("does-not-exist", stderr.getvalue())
        self.assertIsNone(audit._AUTHORIZED_OWNER_PUBLIC_KEY_HEX)
        self.assertIsNone(audit._AUTHORIZED_REVIEWER_PUBLIC_KEY_HEX)

    def test_unknown_cli_key_input_never_echoes_a_secret(self):
        fake_private_secret = "SECRET-NEVER-PRINT-OR-ACCEPT"
        stderr = io.StringIO()
        with redirect_stderr(stderr), self.assertRaises(SystemExit) as exit_info:
            audit.main([
                "--source", "placeholder",
                "--approvals", "placeholder",
                "--expected-tenant", "pharmacy-A",
                "--expected-request-id", self.nonce,
                "--owner-private-key", fake_private_secret,
            ])
        self.assertEqual(exit_info.exception.code, 2)
        self.assertIn("DENIED", stderr.getvalue())
        self.assertNotIn(fake_private_secret, stderr.getvalue())

    def test_ambiguous_duplicate_or_nonfinite_json_denied_before_crypto(self):
        with self.assertRaises(audit.CustodyDenied):
            json.loads(
                '{"statement":{"source_sha256":"a","source_sha256":"b"}}',
                object_pairs_hook=audit._reject_duplicate_json_keys,
            )
        with self.assertRaises(audit.CustodyDenied):
            json.loads(
                '{"statement":{"full_row_count":NaN}}',
                parse_constant=audit._reject_nonfinite_json_constant,
            )


if __name__ == "__main__":
    unittest.main(verbosity=1)
