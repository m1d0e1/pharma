"""No-live-DB regression for legacy archive preview and upgrade rehearsal."""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

from scripts.legacy_pharmacy_upgrade import (
    UnsafeSource, create_stage_root, digest_file, preview_detached,
    rehearse_pinned_archive, stage_fixture, validated_synthetic_source,
)
from scripts.qa_historical_archive_manifest_regression import fixture
from scripts.qa_historical_archive_manifest import make_manifest
from scripts.qa_legacy_upgrade_matrix_065 import (
    run_synthetic, validate_sealed_064, migration_text,
)


def write_fixture(path: Path) -> str:
    with closing(fixture()) as memory:
        with closing(sqlite3.connect(path)) as saved:
            memory.backup(saved)
    return digest_file(path)


class UpgradeRehearsalRegression(unittest.TestCase):
    def test_matrix_065_exact_sql_rehearsal_and_full_receipt_parity(self) -> None:
        script, digest = migration_text()
        self.assertIn("CREATE VIEW native_legacy_upgrade_authorized_sources", script)
        self.assertEqual(len(digest), 64)
        result = run_synthetic()
        self.assertTrue(result["exact_065_sql_applied_to_copy_only"])
        self.assertTrue(result["old_all_table_content_and_original_numeric_receipts_identical"])
        self.assertTrue(result["exception_transactional_ddl_rollback_restart_verified"])
        self.assertTrue(result["completed_065_restart_verified"])
        self.assertTrue(result["unmodified_sealed_backup_restart_verified"])
        self.assertFalse(result["original_tenant_reassigned"])
        self.assertEqual(result["retained_private_copy_files"], 5)
        self.assertFalse(result["historical_use_authorized"])
        published = json.dumps(result, sort_keys=True)
        for secret in ("qa-patient", "supplier-x", "purchase-source", "journal-wallet"):
            self.assertNotIn(secret, published)

    def test_ambiguous_blank_explicit_null_legacy_matrix_without_owner_guess(self) -> None:
        with closing(fixture()) as memory:
            memory.executemany(
                "INSERT INTO users(id,pharmacy_id) VALUES(?,?)",
                (("private-user-blank", ""), ("private-user-exact", "independent_branch")),
            )
            memory.commit()
            first = make_manifest(memory)
            buckets = first["quarantined_identity_counts"]
            self.assertGreater(buckets["literal_null"], 0)
            self.assertGreater(buckets["blank"], 0)
            self.assertGreater(buckets["literal_local_default"], 0)
            self.assertGreater(buckets["explicit_but_unverified"], 0)
            self.assertFalse(first["historical_tenant_ownership_certified"])
            with tempfile.TemporaryDirectory() as folder:
                dest = Path(folder) / "disposable-synthetic.sqlite3"
                with closing(sqlite3.connect(dest)) as saved:
                    memory.backup(saved)
                with closing(sqlite3.connect(dest.as_uri() + "?mode=ro&immutable=1",
                                            uri=True)) as cloned:
                    second = make_manifest(cloned)
                    self.assertEqual(first, second)
                    self.assertEqual(
                        tuple(memory.execute(
                            "SELECT id,pharmacy_id FROM users ORDER BY id"
                        )),
                        tuple(cloned.execute(
                            "SELECT id,pharmacy_id FROM users ORDER BY id"
                        )),
                    )
            self.assertNotIn("private-user-blank", json.dumps(first))
            self.assertNotIn("independent_branch", json.dumps(first))

    def test_sealed_064_source_rejects_active_qa_and_unpinned_alias(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "pharma_local.db"
            expected = write_fixture(source)
            with self.assertRaisesRegex(UnsafeSource, "sealed_064_path_denied"):
                validate_sealed_064(source, expected)

    def test_pinned_preview_preserves_all_identity_buckets_without_piis(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            local = root / "Local"
            archive_folder = (local / "pharma-disposable-data-copies" /
                              ("production-profile-qa-snapshot-20261017-" + "a" * 32))
            archive_folder.mkdir(parents=True)
            archive = archive_folder / "production_snapshot_immutable.sqlite3"
            original_sha = write_fixture(archive)
            preview = preview_detached(archive, original_sha, local)
            self.assertEqual(original_sha, digest_file(archive))
            self.assertTrue(preview["archive_pinned_sha256_ok"])
            self.assertEqual(preview["identity_quarantine"]["literal_null"], 4)
            self.assertGreater(preview["identity_quarantine"]["literal_local_default"], 0)
            self.assertGreater(preview["identity_quarantine"]["unscoped_columns"], 0)
            self.assertEqual(preview["table_count"], 21)
            self.assertFalse(preview["historical_ownership_certified"])
            self.assertFalse(preview["sensitive_history_transfer_authorized"])
            self.assertFalse(preview["private_row_copy_performed"])
            published = json.dumps(preview)
            for private in (
                "PRIVATE", "01000000000", "supplier-x",
                "sale-1", "invoice-1", "local_default",
            ):
                if private != "local_default":  # known fixed quarantine category
                    self.assertNotIn(private, published)

    def test_pinned_private_rehearsal_retains_four_isolated_stage_files(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            local = Path(scratch) / "Local"
            custody = local / "pharma-disposable-data-copies"
            archive_folder = custody / ("production-profile-qa-snapshot-20261017-" + "c" * 32)
            archive_folder.mkdir(parents=True)
            archive = archive_folder / "production_snapshot_immutable.sqlite3"
            original_sha = write_fixture(archive)
            report = rehearse_pinned_archive(archive, original_sha, local)
            self.assertTrue(report["real_archive_staged"])
            self.assertTrue(report["online_sqlite_backup_complete"])
            self.assertTrue(report["ddl_rollback_after_reopen_ok"])
            self.assertTrue(report["synthetic_commit_restart_ok"])
            self.assertTrue(report["new_file_restore_matches_original"])
            self.assertEqual(report["retained_files"], 4)
            self.assertTrue(report["source_sha256_verified_and_preserved"])
            self.assertEqual(digest_file(archive), original_sha)
            stage = custody / report["disposable_stage_token"]
            self.assertEqual({item.name for item in stage.iterdir()}, {
                "candidate.sqlite3", "rollback-retained.sqlite3",
                "working-synthetic-migration.sqlite3",
                "restored-after-rehearsal.sqlite3",
            })
            with closing(sqlite3.connect(stage / "candidate.sqlite3")) as candidate:
                self.assertEqual(
                    candidate.execute("SELECT pharmacy_id FROM users WHERE id='user-NULL'").
                    fetchone(), (None,),
                )
                self.assertEqual(
                    candidate.execute("SELECT pharmacy_id FROM users WHERE id='user-legacy'").
                    fetchone(), ("local_default",),
                )
            self.assertNotIn("PRIVATE", json.dumps(report))
            self.assertFalse(report["historical_data_transfer_authorized"])

    def test_online_backup_includes_committed_wal_and_frozen_input(self) -> None:
        fixture_folder = (Path(tempfile.gettempdir()) /
                          ("pharma-legacy-fixture-" + uuid.uuid4().hex))
        fixture_folder.mkdir()
        stage_dir = fixture_folder / "synthetic-stage"
        stage_dir.mkdir()
        source = fixture_folder / "source.sqlite3"
        try:
            write_fixture(source)
            with closing(sqlite3.connect(source)) as writer:
                self.assertEqual(writer.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
                writer.execute("PRAGMA wal_autocheckpoint=0")
                writer.execute("INSERT INTO users VALUES('new-synthetic',NULL)")
                writer.commit()
                self.assertTrue(source.with_name(source.name + "-wal").exists())
                # File digest of the main file is pinned separately from the
                # WAL; SQLite mode=ro+backup must include committed WAL frames.
                original_sha = digest_file(source)
                with patch(
                    "scripts.legacy_pharmacy_upgrade.create_stage_root",
                    return_value=stage_dir,
                ):
                    report = stage_fixture(source, original_sha)
                self.assertEqual(report["all_table_rows"], 25)
                self.assertEqual(digest_file(source), original_sha)
                with closing(sqlite3.connect(stage_dir / "candidate.sqlite3")) as saved:
                    self.assertEqual(
                        saved.execute("SELECT count(*) FROM users").fetchone()[0], 3
                    )
                self.assertFalse(report["real_archive_staged"])
                self.assertTrue(report["full_private_content_parity_verified_no_rows_printed"])
        finally:
            # This is a precisely identified synthetic test-only directory.
            # Never use this cleanup code for a pinned private real archive.
            import shutil
            self.assertEqual(fixture_folder.parent, Path(tempfile.gettempdir()))
            self.assertTrue(fixture_folder.name.startswith("pharma-legacy-fixture-"))
            shutil.rmtree(fixture_folder)

    def test_rejects_wrong_pin_and_non_fixture_or_live_app_sources(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            real_looking = Path(scratch) / "pharma_local.db"
            correct_sha = write_fixture(real_looking)
            with self.assertRaisesRegex(UnsafeSource, "synthetic_fixture_path_denied"):
                validated_synthetic_source(real_looking, correct_sha)
            local = Path(scratch) / "Local"
            folder = (local / "pharma-disposable-data-copies" /
                      ("production-profile-qa-snapshot-20261017-" + "b" * 32))
            folder.mkdir(parents=True)
            archived = folder / "production_snapshot_immutable.sqlite3"
            expected = write_fixture(archived)
            with self.assertRaisesRegex(UnsafeSource, "source_sha256_mismatch"):
                preview_detached(archived, "f" * 64, local)
            archived.with_name(archived.name + "-wal").touch()
            with self.assertRaisesRegex(ValueError, "sidecar"):
                preview_detached(archived, expected, local)

    def test_failed_rehearsal_preserves_retained_stage_and_original(self) -> None:
        with tempfile.TemporaryDirectory() as scratch:
            local = Path(scratch) / "Local"
            custody = local / "pharma-disposable-data-copies"
            archive_folder = custody / ("production-profile-qa-snapshot-20261017-" + "d" * 32)
            archive_folder.mkdir(parents=True)
            archived = archive_folder / "production_snapshot_immutable.sqlite3"
            expected = write_fixture(archived)
            with patch(
                "scripts.legacy_pharmacy_upgrade.synthetic_rollback_rehearsal",
                side_effect=UnsafeSource("rehearsal_injected_failure"),
            ):
                with self.assertRaisesRegex(UnsafeSource, "rehearsal_injected_failure"):
                    rehearse_pinned_archive(archived, expected, local)
            retained = list(custody.glob("pharma-legacy-stage-*"))
            self.assertEqual(len(retained), 1)
            self.assertTrue((retained[0] / "candidate.sqlite3").is_file())
            self.assertTrue((retained[0] / "rollback-retained.sqlite3").is_file())
            self.assertEqual(expected, digest_file(archived))


if __name__ == "__main__":
    unittest.main()
