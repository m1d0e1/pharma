"""Native SQLx68 pinned source, immutable evidence and exact scope rollback tests."""
from __future__ import annotations

from contextlib import closing
import hashlib
from pathlib import Path
import sqlite3
import unittest
from unittest.mock import patch

from scripts import qa_v02110_native_sqlx68_primary_scope_stage as stage
from scripts import qa_v02110_primary_pharmacy_migration as qa
from scripts import qa_v02110_native_primary_scope_068 as native


class NativeSqlx68ReversibleScopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.before = sqlite3.connect(":memory:")
        self.addCleanup(self.before.close)
        self.before.executescript("""
            CREATE TABLE native_amounts (
              id TEXT PRIMARY KEY, pharmacy_id BLOB,
              fractional_amount REAL NOT NULL, original_payload BLOB NOT NULL
            );
            CREATE TABLE native_children (
              id TEXT PRIMARY KEY, parent_id TEXT,
              pharmacy_id BLOB, unit_amount REAL NOT NULL,
              FOREIGN KEY(parent_id) REFERENCES native_amounts(id)
            );
            CREATE TRIGGER native_amount_immutable
              BEFORE UPDATE ON native_amounts
              BEGIN SELECT RAISE(ABORT,'Original native financial guard active'); END;
        """)
        values = (None,"",b"\x00\x01",-0.0,"local_default")
        for i,value in enumerate(values):
            self.before.execute(
                "INSERT INTO native_amounts VALUES(?,?,?,?)",
                (f"amount-{i}",value,1.123456789+i,bytes([i,0,255])))
            self.before.execute(
                "INSERT INTO native_children VALUES(?,?,?,?)",
                (f"line-{i}",f"amount-{i}",value,2.718281828459+i))
        self.before.commit()
        self.candidate=sqlite3.connect(":memory:")
        self.addCleanup(self.candidate.close)
        self.before.backup(self.candidate)
        self.candidate.executescript(native.MIGRATION.read_text(encoding="utf-8"))
        self.candidate.execute("""INSERT INTO native_primary_scope_audit_batches
           (audit_sha256,original_v67_sha256,sealed_v29_sha256,
            observed_native_schema_version,original_physical_table_count,
            original_physical_row_count,expected_original_scope_count,
            expected_table_witness_count,expected_relation_witness_count)
           VALUES(?,?,?,67,2,10,10,2,1)""",
           ("a"*64,"b"*64,"c"*64))
        for t in ("native_amounts","native_children"):
            for row in qa.row_stream(self.before,t):
                columns=qa.columns(self.before,t)
                index=columns.index("pharmacy_id")+1
                storage,_=qa.typed(row[index])
                self.candidate.execute(
                    "INSERT INTO native_primary_scope_audit_originals "
                    "(audit_sha256,source_table,source_rowid,original_storage,"
                    "original_literal,original_row_typed_sha256) VALUES(?,?,?,?,?,?)",
                    ("a"*64,t,row[0],storage,row[index],
                     native.typed_row_digest(row)))
        self.candidate.commit()

    def test_complete_typed_rollback_then_normalize_without_touching_financial_or_fk(self):
        expected={t: list(qa.row_stream(self.before,t))
                  for t in ("native_amounts","native_children")}
        self.assertEqual(stage.mutate_scopes(self.candidate,self.before,restore=False),10)
        for table,rows in expected.items():
            observed=list(qa.row_stream(self.candidate,table))
            self.assertEqual(len(rows),len(observed))
            for a,b in zip(rows,observed):
                idx=qa.columns(self.before,table).index("pharmacy_id")+1
                self.assertEqual(qa.typed(b[idx]),qa.typed(qa.TENANT))
                self.assertTrue(all(qa.same(x,y) for i,(x,y) in enumerate(zip(a,b)) if i!=idx))
        self.assertEqual(stage.mutate_scopes(self.candidate,self.before,restore=True),10)
        for table,rows in expected.items():
            observed=list(qa.row_stream(self.candidate,table))
            self.assertTrue(all(stage._same_row(a,b) for a,b in zip(rows,observed)))
        self.assertEqual(stage.mutate_scopes(self.candidate,self.before,restore=False),10)
        self.assertEqual(self.candidate.execute(
            "SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone(),(0,))
        qa.healthy(self.candidate)

    def test_existing_068_witness_guard_survives_scope_mutation(self):
        names={name for (name,) in self.candidate.execute(
            "SELECT name FROM sqlite_master WHERE type='trigger'")}
        self.assertIn("native_primary_scope_audit_original_no_change",names)
        self.assertIn("native_amount_immutable",names)
        self.assertEqual(stage.mutate_scopes(self.candidate,self.before,restore=False),10)
        self.assertEqual(names,{name for (name,) in self.candidate.execute(
            "SELECT name FROM sqlite_master WHERE type='trigger'")})
        with self.assertRaisesRegex(sqlite3.IntegrityError,"Original native financial guard active"):
            self.candidate.execute(
                "UPDATE native_amounts SET fractional_amount=123 WHERE id='amount-0'")
        with self.assertRaisesRegex(sqlite3.IntegrityError,"Typed original immutable"):
            self.candidate.execute(
                "UPDATE native_primary_scope_audit_originals "
                "SET original_literal=original_literal")
        self.assertEqual(self.candidate.execute(
            "SELECT COUNT(*) FROM native_primary_scope_audit_originals").fetchone(),(10,))

    def test_altered_trigger_is_refused_before_writes(self):
        self.candidate.execute("DROP TRIGGER native_amount_immutable")
        with self.assertRaisesRegex(qa.Refused,"trigger definitions drifted"):
            stage.mutate_scopes(self.candidate,self.before,restore=False)
        for table in ("native_amounts","native_children"):
            self.assertTrue(all(stage._same_row(a,b) for a,b in zip(
                qa.row_stream(self.before,table),qa.row_stream(self.candidate,table))))

    def test_actual_068_sql_checksum_and_registered_native_migration(self):
        with closing(qa.memory_source(
                qa.checked_file(stage.sources()[0],stage.CURRENT_V67_SHA))) as original, \
             closing(qa.memory_source(
                qa.checked_file(stage.sources()[1],stage.NATIVE68_SHA))) as sqlx68:
            stage.verify_native68_migration(original,sqlx68)
            ledger=sqlx68.execute(
                "SELECT description,hex(checksum),success FROM _sqlx_migrations WHERE version=68"
            ).fetchone()
            self.assertEqual(ledger,(stage.DESC,hashlib.sha384(
                native.MIGRATION.read_bytes()).hexdigest().upper(),1))
            self.assertEqual(sqlx68.execute(
                "SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone(),(0,))

    def test_no_existing_or_arbitrary_stage_folder_can_be_selected(self):
        with self.assertRaises(qa.Refused):
            stage.stage_dir(Path("C:/Windows/not-disposable"))
        self.assertEqual(stage.FORMAT,"pharma-v02110-current-native-sqlx68-typed-reversible-v1")

    def test_lineage_readonly_inspection_restores_reversible_connection_mode(self):
        self.assertEqual(self.candidate.execute("PRAGMA query_only").fetchone(),(0,))
        def prior_lineage(source, candidate):
            candidate.execute("PRAGMA query_only=ON")
            return 147
        with patch.object(stage,"_read_relationship_witness",side_effect=prior_lineage):
            self.assertEqual(stage.verify_relationship_witness(self.before,self.candidate),147)
        self.assertEqual(self.candidate.execute("PRAGMA query_only").fetchone(),(0,))
        self.assertEqual(stage.mutate_scopes(self.candidate,self.before,restore=False),10)
        with patch.object(stage,"_read_relationship_witness",side_effect=prior_lineage):
            self.candidate.execute("PRAGMA query_only=ON")
            self.assertEqual(stage.verify_relationship_witness(self.before,self.candidate),147)
        self.assertEqual(self.candidate.execute("PRAGMA query_only").fetchone(),(1,))
        self.candidate.execute("PRAGMA query_only=OFF")


if __name__=="__main__":
    unittest.main()
