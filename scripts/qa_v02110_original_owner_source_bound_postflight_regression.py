"""Fail-closed owner provenance and 068→069 custody tamper regressions.

Every mutated source is a private RAM copy deserialized from a pinned snapshot;
the real installed customer DB and retained v29/v67/v68/v69 files stay sealed.
"""
from __future__ import annotations

from contextlib import closing, ExitStack
import sqlite3
import unittest

from scripts import qa_v02110_primary_pharmacy_migration as qa
from scripts import qa_v02110_original_owner_source_bound_postflight as audit


class OriginalOwnerSourceBoundPostflightRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshots = tuple(
            qa.checked_file(path,pin,sealed=(i==0))
            for i,(path,pin) in enumerate(zip(
                audit.source_paths(),
                (qa.SEALED_PIN,audit.stage.CURRENT_V67_SHA,audit.V68_PIN,audit.V69_PIN)
            ))
        )

    def _ram(self):
        stack=ExitStack()
        self.addCleanup(stack.close)
        return [stack.enter_context(closing(qa.memory_source(raw)))
                for raw in self.snapshots]

    def test_real_current_installed_derived_full_owner_custody_is_unsigned(self):
        report=audit.verify()
        self.assertEqual(report["original_typed_scope_rowid_literal_and_full_row_sha_verified"],7567)
        self.assertEqual(report["native_068_owner_attestations"],0)
        self.assertEqual(report["native_069_owner_attestations"],0)
        self.assertFalse(report["original_owner_login_or_signed_approval_authentication_completed"])
        self.assertFalse(report["tenant_permission_or_finance_grant_created"])
        serialized=str(report)
        self.assertNotIn("password_hash",serialized)
        self.assertNotIn("$2b$",serialized)

    def test_missing_original_v29_credential_does_not_elevate_signed_claim(self):
        db=self._ram()
        db[0].execute("PRAGMA query_only=OFF")
        db[0].execute("UPDATE users SET password_hash=NULL WHERE id='admin'")
        with self.assertRaisesRegex(qa.Refused,"original owner credential"):
            audit.verify_owner_sources(*db)

    def test_inferred_052_v67_scope_is_not_original_owner_proof(self):
        db=self._ram()
        db[1].execute("PRAGMA query_only=OFF")
        db[1].execute("UPDATE users SET pharmacy_id='primary_pharmacy' WHERE id='admin'")
        with self.assertRaisesRegex(qa.Refused,"032/052"):
            audit.verify_owner_sources(*db)

    def test_restoring_historical_owner_hash_in_normalized_stage_is_refused(self):
        db=self._ram()
        db[2].execute("PRAGMA query_only=OFF")
        db[2].execute("UPDATE users SET password_hash='synthetic-owner-not-authorized' WHERE id='admin'")
        with self.assertRaisesRegex(qa.Refused,"credential was restored"):
            audit.verify_owner_sources(*db)

    def test_fabricated_owner_attestation_on_native69_is_rejected(self):
        db=self._ram()
        db[3].execute("PRAGMA query_only=OFF")
        db[3].execute("DROP TRIGGER native_primary_scope_owner_attestation_guard")
        batch = db[3].execute(
            "SELECT audit_sha256 FROM native_primary_scope_audit_seals"
        ).fetchone()[0]
        db[3].execute("""INSERT INTO native_primary_scope_owner_attestations
             (audit_sha256,original_v67_sha256,pharmacy_id,verified_owner_id,
              signed_evidence_sha256,verified_typed_mapping_sha256,signed_evidence_ref)
             VALUES(?,?,?,?,?,?,?)""",
             (batch,audit.stage.CURRENT_V67_SHA,qa.TENANT,"admin",
              "f"*64,"e"*64,"forged-owner-signature-reference"))
        with self.assertRaisesRegex(qa.Refused,"owner attestation"):
            audit.verify_owner_sources(*db)

    def test_typed_original_storage_and_whole_row_sha_tamper_is_detected(self):
        db=self._ram()
        db[2].execute("PRAGMA query_only=OFF")
        db[2].execute("DROP TRIGGER native_primary_scope_audit_original_no_change")
        db[2].execute(
            "UPDATE native_primary_scope_audit_originals SET original_row_typed_sha256=? "
            "WHERE source_table='users'", ("f"*64,))
        with self.assertRaisesRegex(qa.Refused,"original scope/graph evidence"):
            audit.verify_owner_sources(*db)

    def test_sqlx69_registered_checksum_tamper_is_rejected(self):
        db=self._ram()
        db[3].execute("PRAGMA query_only=OFF")
        db[3].execute(
            "UPDATE _sqlx_migrations SET checksum=? WHERE version=69",
            (b"\x01"*48,))
        with self.assertRaisesRegex(qa.Refused,"Native069 frozen"):
            audit.verify_owner_sources(*db)

    def test_explicit_foreign_source_scope_cannot_be_silently_adopted(self):
        db=self._ram()
        db[1].execute("PRAGMA query_only=OFF")
        db[1].execute(
            "UPDATE inventory SET pharmacy_id='other-owned-tenant' "
            "WHERE rowid=(SELECT MIN(rowid) FROM inventory)")
        with self.assertRaisesRegex(qa.Refused,"Original typed source-bound"):
            audit.verify_owner_sources(*db)


if __name__ == "__main__":
    unittest.main()
