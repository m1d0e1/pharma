"""In-memory legacy witness and isolated temp-file crash/recovery regressions."""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import sqlite3
import unittest

from scripts.qa_historical_archive_manifest_regression import fixture
from scripts.qa_historical_archive_manifest import MODULE_RELATIONSHIPS
from scripts.legacy_pharmacy_upgrade import (
    UnsafeSource, backup_to, create_stage_root, open_frozen, selected_manifest,
)
from scripts.qa_legacy_row_custody import (
    TABLE_COPY, TABLE_ROLLBACK, WITNESS, _make_witness, private_row_witness,
    rehearse_staged_rollback, stage_connection, verify_and_seal_stage,
)
from scripts.legacy_pharmacy_upgrade import all_rows_digest


def complete_single_branch_fixture() -> sqlite3.Connection:
    db = fixture()
    # Give the tiny original archive fixture the optional module layouts that
    # its original manifest regression deliberately omits. Required actors,
    # source parents and accounting accounts are authentic *synthetic* rows.
    existing = {row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    for _, child, child_col, parent, parent_col, _ in MODULE_RELATIONSHIPS:
        for table in (child, parent):
            if table not in existing:
                db.execute(f'CREATE TABLE "{table}"(id TEXT PRIMARY KEY)')
                existing.add(table)
        for table, column in ((child, child_col), (parent, parent_col)):
            cols = {c[1] for c in db.execute(f'PRAGMA table_info("{table}")')}
            if column not in cols:
                db.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" TEXT')
    for table, column, definition in (
        ("supplier_transactions", "type", "TEXT"),
        ("supplier_transactions", "reference_id", "TEXT"),
        ("supplier_transactions", "amount", "REAL"),
        ("purchase_invoices", "total_amount", "REAL"),
        ("shifts", "pharmacy_id", "TEXT"),
    ):
        if column not in {c[1] for c in db.execute(f'PRAGMA table_info("{table}")')}:
            db.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {definition}')
    db.execute("INSERT INTO accounts(id,parent_id) VALUES('acct-a',NULL)")
    db.execute("UPDATE journal_entries SET account_id='acct-a'")
    db.execute("UPDATE purchase_invoice_items SET drug_id='drug-1'")
    db.execute("UPDATE purchase_returns SET supplier_id='supplier-x'")
    for table in ("shifts", "cash_movements", "returns", "purchase_returns",
                  "patient_transactions"):
        db.execute(f'UPDATE "{table}" SET user_id=?', ("user-legacy",))
    db.execute("DELETE FROM sales_items WHERE id='line-orphan'")
    db.execute("UPDATE sales_invoices SET pharmacy_id='single-branch'")
    db.execute("UPDATE sales_invoices SET patient_id='private-patient' WHERE id='sale-2'")
    db.commit()
    return db


def pin(db: sqlite3.Connection) -> str:
    return hashlib.sha256(db.serialize()).hexdigest()


def stage(db: sqlite3.Connection):
    source_hash = pin(db)
    original = db.serialize()
    report = stage_connection(
        db, source_sha256=source_hash, tenant="single-branch",
        source_unchanged=lambda: db.serialize() == original,
    )
    self_check = (original, source_hash, report)
    return self_check


class LegacyRowCustodyRegression(unittest.TestCase):
    def test_every_original_record_is_witnessed_then_verified_after_restart(self):
        with closing(complete_single_branch_fixture()) as db:
            original, source_hash, report = stage(db)
            self.assertEqual(db.serialize(), original)
            self.assertEqual(report["stage_state"], "SEALED_CUSTODY_ONLY")
            self.assertEqual(report["tables_with_original_rows"], 30)
            self.assertGreater(report["original_row_witnesses"], 20)
            self.assertTrue(report["complete_individual_typed_record_witness_parity"])
            self.assertFalse(report["safe_to_activate_or_import"])
            self.assertFalse(report["historical_tenant_ownership_granted"])
            self.assertFalse(report["all_financial_provenance_certified"])
            self.assertNotIn("private-patient", json.dumps(report))
            self.assertNotIn("PRIVATE CUSTOMER", json.dumps(report))
            import tempfile
            from pathlib import Path
            st = Path(tempfile.gettempdir()) / report["stage_token"]
            reopened = verify_and_seal_stage(
                st, expected_source_sha256=source_hash, tenant="single-branch",
                original=db, source_unchanged=lambda: db.serialize() == original,
                local_app_data=None,
            )
            self.assertEqual(reopened["original_row_witnesses"], report["original_row_witnesses"])
            with closing(open_frozen(st / TABLE_ROLLBACK)) as rolled:
                self.assertEqual(all_rows_digest(rolled), all_rows_digest(db))
                self.assertEqual(rolled.execute("SELECT pharmacy_id FROM inventory").fetchone(),
                                 ("local_default",))
            with closing(open_frozen(st / WITNESS)) as witness:
                self.assertEqual(witness.execute(
                    "SELECT COUNT(*) FROM source_rows"
                ).fetchone(), (report["original_row_witnesses"],))
                with self.assertRaises(sqlite3.OperationalError):
                    witness.execute("DELETE FROM source_rows")

    def test_partial_crash_before_copy_recovery_must_not_seal(self):
        with closing(complete_single_branch_fixture()) as db:
            root = create_stage_root()
            original = db.serialize()
            backup_to(db, root / TABLE_COPY)
            with self.assertRaisesRegex(UnsafeSource, "retained_stage_backup_missing"):
                verify_and_seal_stage(
                    root, expected_source_sha256=pin(db),
                    tenant="single-branch", original=db,
                    source_unchanged=lambda: db.serialize() == original,
                    local_app_data=None,
                )
            self.assertFalse((root / WITNESS).exists())
            self.assertEqual(db.serialize(), original)

    def test_sealed_witness_survives_transaction_rollback_and_committed_clone_restore(self):
        with closing(complete_single_branch_fixture()) as db:
            original, source_sha, stage_result = stage(db)
            import tempfile
            from pathlib import Path
            root = Path(tempfile.gettempdir()) / stage_result["stage_token"]
            report = rehearse_staged_rollback(
                root, expected_source_sha256=source_sha, tenant="single-branch",
                original=db, source_unchanged=lambda: db.serialize() == original,
                local_app_data=None,
            )
            self.assertTrue(report["ddl_rollback_after_reopen_ok"])
            self.assertTrue(report["synthetic_commit_restart_ok"])
            self.assertTrue(report["new_file_restore_matches_original"])
            self.assertFalse(report["real_profile_or_production_restore_performed"])
            self.assertFalse(report["safe_to_activate_or_import"])
            with closing(open_frozen(root / WITNESS)) as witness:
                self.assertEqual(witness.execute("SELECT state FROM source_meta").fetchone(),
                                 ("SEALED_CUSTODY_ONLY",))
            self.assertEqual(db.serialize(), original)

    def test_crash_after_preparing_witness_resumes_only_matching_source(self):
        with closing(complete_single_branch_fixture()) as db:
            root = create_stage_root()
            original = db.serialize()
            sha = pin(db)
            db.execute("PRAGMA query_only=ON")
            backup_to(db, root / TABLE_COPY)
            with closing(open_frozen(root / TABLE_COPY)) as clone:
                backup_to(clone, root / TABLE_ROLLBACK)
                _make_witness(
                    clone, root / WITNESS, source_sha256=sha,
                    tenant="single-branch", original_manifest=selected_manifest(db),
                    source_typed_sha=all_rows_digest(db),
                )
            original_check = lambda: db.serialize() == original
            preparing = verify_and_seal_stage(
                root, expected_source_sha256=sha, tenant="single-branch",
                original=db, source_unchanged=original_check, local_app_data=None,
                seal=False,
            )
            self.assertEqual(preparing["stage_state"], "PREPARING")
            with self.assertRaisesRegex(UnsafeSource, "source_owner_free_custody_mismatch"):
                verify_and_seal_stage(
                    root, expected_source_sha256=sha, tenant="another-branch",
                    original=db, source_unchanged=original_check,
                    local_app_data=None,
                )
            sealed = verify_and_seal_stage(
                root, expected_source_sha256=sha, tenant="single-branch",
                original=db, source_unchanged=original_check, local_app_data=None,
            )
            self.assertEqual(sealed["stage_state"], "SEALED_CUSTODY_ONLY")
            self.assertEqual(db.serialize(), original)

    def test_independent_changed_row_or_hash_refuses_sealed_custody(self):
        with closing(complete_single_branch_fixture()) as db:
            original, sha, report = stage(db)
            import tempfile
            from pathlib import Path
            root = Path(tempfile.gettempdir()) / report["stage_token"]
            with self.assertRaisesRegex(UnsafeSource, "source_owner_free_custody_mismatch"):
                verify_and_seal_stage(
                    root, expected_source_sha256="f" * 64,
                    tenant="single-branch", original=db,
                    source_unchanged=lambda: db.serialize() == original,
                    local_app_data=None,
                )
            with closing(sqlite3.connect(root / TABLE_COPY)) as clone:
                clone.execute("UPDATE inventory SET pharmacy_id='tampered-tenant'")
                clone.commit()
            with self.assertRaisesRegex(UnsafeSource,
                                        "stage_manifest_mismatch|stage_private_content_mismatch"):
                verify_and_seal_stage(
                    root, expected_source_sha256=sha, tenant="single-branch",
                    original=db,
                    source_unchanged=lambda: db.serialize() == original,
                    local_app_data=None,
                )
            self.assertEqual(db.serialize(), original)

    def test_exact_storage_bit_flip_or_blob_changes_individual_record_commitment(self):
        with closing(complete_single_branch_fixture()) as db:
            with closing(sqlite3.connect(":memory:")) as evidence:
                evidence.executescript(
                    "CREATE TABLE source_tables(opaque_table_id TEXT,original_row_count INT,"
                    "original_columns_sha256 TEXT);"
                    "CREATE TABLE source_rows(opaque_table_id TEXT,source_ordinal INT,"
                    "original_identity_sha256 TEXT,original_typed_row_sha256 TEXT);"
                )
                before = private_row_witness(db, evidence)
                original_hash = all_rows_digest(evidence, table_names=("source_rows",))
                db.execute("UPDATE journal_entries SET amount=25.001 WHERE id='debit'")
                with closing(sqlite3.connect(":memory:")) as recomputed:
                    recomputed.executescript(
                        "CREATE TABLE source_tables(opaque_table_id TEXT,original_row_count INT,"
                        "original_columns_sha256 TEXT);"
                        "CREATE TABLE source_rows(opaque_table_id TEXT,source_ordinal INT,"
                        "original_identity_sha256 TEXT,original_typed_row_sha256 TEXT);"
                    )
                    after = private_row_witness(db, recomputed)
                    self.assertEqual(before, after)
                    self.assertNotEqual(original_hash, all_rows_digest(
                        recomputed, table_names=("source_rows",)
                    ))

    def test_sealed_evidence_rejects_insert_replace_update_and_delete(self):
        with closing(complete_single_branch_fixture()) as db:
            original, _, report = stage(db)
            import tempfile
            from pathlib import Path
            evidence_path = Path(tempfile.gettempdir()) / report["stage_token"] / WITNESS
            with closing(sqlite3.connect(evidence_path)) as evidence:
                evidence.execute("PRAGMA recursive_triggers=OFF")
                before = all_rows_digest(evidence)
                modifications = (
                    "INSERT OR REPLACE INTO source_meta(marker,format,source_sha256,"
                    "source_typed_sha256,original_schema_sha256,provisional_tenant,"
                    "original_table_count,original_row_count,state) "
                    "SELECT marker,format,source_sha256,source_typed_sha256,"
                    "original_schema_sha256,provisional_tenant,original_table_count,"
                    "original_row_count,state FROM source_meta",
                    "INSERT INTO source_tables VALUES('new-table',1,'0')",
                    "INSERT INTO source_rows VALUES('new-table',1,'some-id','some-digest')",
                    "DELETE FROM source_rows",
                    "UPDATE source_rows SET original_typed_row_sha256='bad'",
                    "UPDATE source_meta SET provisional_tenant='fake'",
                )
                for sql in modifications:
                    with self.subTest(sql=sql), self.assertRaises(sqlite3.IntegrityError):
                        evidence.execute(sql)
                self.assertEqual(before, all_rows_digest(evidence))
            self.assertEqual(original, db.serialize())

    def test_foreign_owner_unresolved_missing_parent_never_staged(self):
        with closing(fixture()) as db:
            source = db.serialize()
            with self.assertRaisesRegex(UnsafeSource, "historical_stage_source_not_structurally_safe"):
                stage_connection(
                    db, source_sha256=pin(db), tenant="single-branch",
                    source_unchanged=lambda: db.serialize() == source,
                )
            self.assertEqual(db.serialize(), source)


if __name__ == "__main__":
    unittest.main()
