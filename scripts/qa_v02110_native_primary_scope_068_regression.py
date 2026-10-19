"""Isolated v67→068 native typed witness + rollback/immutability regressions."""
from __future__ import annotations

import hashlib
import sqlite3
import unittest

from scripts import qa_v02110_native_primary_scope_068 as native
from scripts import qa_v02110_primary_pharmacy_migration as qa
from scripts.qa_v02110_primary_pharmacy_migration_regression import fixture


class Native068ScopeAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = fixture(native=True)
        self.sealed = fixture(native=False)
        # Native 053 installs this immutable quarantine before 068. The
        # compact synthetic fixture needs its structural owner-review table.
        self.source.execute("CREATE TABLE native_owner_scope_review "
                            "(owner_id TEXT PRIMARY KEY, reason TEXT NOT NULL)")
        self.source.execute("ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1")
        # ANALYZE adds sqlite_stat1 with anonymous rowids; its unchanged
        # physical identities are part of the historical preservation promise.
        self.source.execute("ANALYZE")
        self.source.commit()
        self.normalized = sqlite3.connect(":memory:")
        self.source.backup(self.normalized)
        self.addCleanup(self.source.close)
        self.addCleanup(self.sealed.close)
        self.addCleanup(self.normalized.close)
        self.pin = "a" * 64
        self.prep = qa.prepare(self.normalized, self.source, self.sealed, self.pin)
        qa._mutate_scopes(self.normalized, restore=False)
        qa.verify(self.source, self.normalized, self.sealed, self.pin)
        self.original_stat1 = list(qa.row_stream(self.normalized, "sqlite_stat1"))

    def register(self) -> tuple[sqlite3.Connection, dict]:
        self.payload = native.evidence_payload(self.source, self.normalized)
        self.assertEqual(len(self.payload["scopes"]), self.prep["original_scope_rows"])
        self.assertTrue(self.payload["relations"])
        self.assertEqual(self.payload["whole_rows"],
                         sum(item[1] for item in self.payload["physical"]))
        # Accept BLOB scope originals in an explicit typed JSON commitment.
        self.assertIn(b"__sqlite_blob_hex_v1__", native.canonical(self.payload["scopes"]))
        candidate = sqlite3.connect(":memory:")
        self.addCleanup(candidate.close)
        self.normalized.backup(candidate)
        native._storage_safe_escrow_drop(candidate)
        self.assertEqual(list(qa.row_stream(candidate, "sqlite_stat1")), self.original_stat1)
        self.assertFalse(qa.AUDIT_TABLES.intersection(qa.tables(candidate)))
        audit_id = hashlib.sha256(b"synthetic-native-068-batch").hexdigest()
        evidence_id = hashlib.sha256(b"synthetic-native-068-evidence").hexdigest()
        native.register_metadata(candidate, source_pin=self.pin,
                                 sealed_pin=qa.SEALED_PIN, payload=self.payload,
                                 audit_id=audit_id, evidence_id=evidence_id)
        self.assertEqual(candidate.execute(
            "SELECT COUNT(*) FROM native_primary_scope_audit_observations"
        ).fetchone(), (1,))
        self.assertEqual(candidate.execute(
            "SELECT COUNT(*) FROM native_primary_scope_owner_attestations"
        ).fetchone(), (0,))
        self.assertEqual(candidate.execute(
            "SELECT original_storage,original_literal "
            "FROM native_primary_scope_audit_originals "
            "WHERE source_table='inventory'"
        ).fetchone(), ("blob", b"\x00\x10"))
        self.assertEqual(
            candidate.execute("SELECT password_hash FROM users WHERE id='owner'").fetchone(),
            (None,),
        )
        return candidate, {"batch": audit_id, "evidence": evidence_id}

    def test_complete_typed_native_068_preserves_all_original_financial_fts_and_stat1(self):
        candidate, _ = self.register()
        rows, fts = native._verify_native_cells(self.normalized, candidate)
        self.assertEqual(rows, self.payload["whole_rows"])
        self.assertGreater(fts, 0)
        self.assertEqual(candidate.execute(
            "SELECT total,payload FROM sales_invoices WHERE id='one'"
        ).fetchone(), (8.00127, b"\x00\xff"))
        self.assertEqual(candidate.execute(
            "SELECT price FROM invoice_items WHERE id='part'"
        ).fetchone(), (2.71828182845,))
        qa.healthy(candidate)

    def test_seal_rejects_missing_witness_and_all_existing_evidence_is_immutable(self):
        bare = sqlite3.connect(":memory:")
        self.addCleanup(bare.close)
        # A migration only adds tables and triggers; it never creates a grant.
        bare.executescript(native.MIGRATION.read_text(encoding="utf-8"))
        self.assertEqual(bare.execute(
            "SELECT count(*) FROM native_primary_scope_audit_batches"
        ).fetchone(), (0,))
        bare.execute("""INSERT INTO native_primary_scope_audit_batches
             (audit_sha256,original_v67_sha256,sealed_v29_sha256,
              observed_native_schema_version,original_physical_table_count,
              original_physical_row_count,expected_original_scope_count,
              expected_table_witness_count,expected_relation_witness_count)
             VALUES(?,?,?,67,1,1,1,1,1)""",
             ("d"*64, "a"*64, "b"*64))
        with self.assertRaisesRegex(sqlite3.IntegrityError, "incomplete"):
            bare.execute("INSERT INTO native_primary_scope_audit_seals VALUES(?,?,CURRENT_TIMESTAMP)",
                         ("d"*64, "c"*64))
        candidate, refs = self.register()
        audit_id, evidence = refs["batch"], refs["evidence"]
        for table, identity, update_sql in (
            ("native_primary_scope_audit_batches", (audit_id,),
             "UPDATE native_primary_scope_audit_batches SET pharmacy_id=pharmacy_id"),
            ("native_primary_scope_audit_originals", (audit_id,),
             "UPDATE native_primary_scope_audit_originals SET original_literal=original_literal"),
            ("native_primary_scope_audit_tables", (audit_id,),
             "UPDATE native_primary_scope_audit_tables SET directly_scoped=directly_scoped"),
            ("native_primary_scope_audit_relations", (audit_id,),
             "UPDATE native_primary_scope_audit_relations SET source_rows=source_rows"),
            ("native_primary_scope_audit_seals", (audit_id,),
             "UPDATE native_primary_scope_audit_seals SET evidence_sha256=evidence_sha256"),
        ):
            with self.subTest(table=table):
                with self.assertRaises(sqlite3.IntegrityError):
                    candidate.execute(update_sql)
                with self.assertRaises(sqlite3.IntegrityError):
                    candidate.execute(f"DELETE FROM {qa.quote(table)}")
        with self.assertRaises(sqlite3.IntegrityError):
            candidate.execute("""INSERT OR REPLACE INTO native_primary_scope_audit_seals
                (audit_sha256,evidence_sha256) VALUES(?,?)""",
                (audit_id, evidence))
        with self.assertRaises(sqlite3.IntegrityError):
            candidate.execute("""INSERT INTO native_primary_scope_audit_tables
                 (audit_sha256,source_table,original_physical_rows,directly_scoped,
                  original_typed_rows_sha256,normalized_typed_rows_sha256)
                 VALUES(?,'late',0,0,?,?)""", (audit_id, "a"*64, "a"*64))

    def test_owner_attestation_cannot_bypass_original_owner_enrollment(self):
        candidate, refs = self.register()
        with self.assertRaisesRegex(sqlite3.IntegrityError, "Owner must"):
            candidate.execute("""INSERT INTO native_primary_scope_owner_attestations
                 (audit_sha256,original_v67_sha256,pharmacy_id,verified_owner_id,
                  signed_evidence_sha256,verified_typed_mapping_sha256,signed_evidence_ref)
                 VALUES(?,?,?,?,?,?,?)""",
                 (refs["batch"], self.pin, qa.TENANT, "owner", "f"*64,
                  refs["evidence"], "sample-evidence-ref-test"))
        self.assertEqual(candidate.execute(
            "SELECT COUNT(*) FROM native_primary_scope_owner_attestations"
        ).fetchone(), (0,))

    def test_unauthorized_finance_cell_change_detected_and_reversible_scope_rollback(self):
        # The signed-zero, fractional amounts and blobs are checked cellwise.
        # A source ledger rewrite is refused prior to 068 evidence production.
        bad = sqlite3.connect(":memory:")
        self.addCleanup(bad.close)
        self.normalized.backup(bad)
        # Native finance scopes have update guards; a ledger amount change is
        # the simplest proof the typed auditor detects direct non-scope drift.
        bad.execute("UPDATE sales_invoices SET total=8.00 WHERE id='one'")
        with self.assertRaisesRegex(qa.Refused, "non-scope"):
            qa.verify(self.source, bad, self.sealed, self.pin)
        bad.rollback()
        self.assertEqual(bad.execute(
            "SELECT total FROM sales_invoices WHERE id='one'"
        ).fetchone(), (8.00127,))
        # Keep rollback entirely separate from the immutable native 068 seal.
        # Roll back the original reversible disposable rehearsal.
        self.normalized.execute("PRAGMA query_only=OFF")
        restored = qa._mutate_scopes(self.normalized, restore=True)
        self.assertEqual(restored, self.prep["original_scope_rows"])
        result = qa.verify(self.source, self.normalized, self.sealed, self.pin)
        self.assertEqual(result["phase"], "ROLLED_BACK")
        self.assertEqual(result["direct_scope_cells_changed"], 0)

    def test_audit_graph_has_no_permissions_and_detects_indirect_fk_tampering(self):
        candidate, _ = self.register()
        self.assertEqual(candidate.execute(
            "SELECT COUNT(*) FROM native_primary_scope_audit_relations"
        ).fetchone(), (len(self.payload["relations"]),))
        self.assertEqual(candidate.execute(
            "SELECT DISTINCT authority FROM native_primary_scope_audit_observations"
        ).fetchone(), ("UNSIGNED_AUDIT_ONLY_NOT_OWNER_AUTHORIZATION",))
        changed = sqlite3.connect(":memory:")
        self.addCleanup(changed.close)
        self.normalized.backup(changed)
        changed.execute("PRAGMA foreign_keys=OFF")
        changed.execute("UPDATE invoice_items SET invoice_id='no-parent' WHERE id='part'")
        with self.assertRaisesRegex(qa.Refused, "graph changed"):
            native.relationship_evidence(self.source, changed)


if __name__ == "__main__":
    unittest.main()
