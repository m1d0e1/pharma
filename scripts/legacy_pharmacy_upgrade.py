"""Privacy-gated operator preview and disposable upgrade rehearsal.

Production and archived history:
  * ONLY an independently pinned, finalized detached archive is inspected;
  * SQLite connection is mode=ro&immutable=1 with query_only=ON;
  * default preview reports aggregate counts and opaque *table* IDs, NEVER rows;
  * explicit rehearse-pinned-archive copies ONLY into a unique disposable,
    private staging folder; it cannot install or run the real pharmacy app;
  * no historical NULL, blank or local_default owner is inferred or rewritten;
  * a rehearsal is NOT an owner authorization, production migration or
    consent to use patient/supplier/finance data in a runnable QA profile.

Disposable synthetic sources:
  * stage-fixture reads an isolated TEMP fixture with SQLite mode=ro and
    online Connection.backup(), so committed WAL frames enter the backup;
  * only a NEW unique OS-temp stage is writable, backups are retained;
  * verifies full row contents privately by digest, checks post-stage restart,
    synthetic DDL transaction rollback and a separate committed/revert drill;
  * no application, migration, financial receipt or QA profile is launched.

Examples (PowerShell, Windows):
  python -B -m scripts.legacy_pharmacy_upgrade preview `
      --archive "<approved-detached-archive>" --expected-sha256 "<pinned>"
  python -B -m scripts.legacy_pharmacy_upgrade rehearse-pinned-archive `
      --archive "<approved-detached-archive>" --expected-sha256 "<pinned>"
  python -B -m scripts.legacy_pharmacy_upgrade stage-fixture `
      --source "<TEMP>/pharma-legacy-fixture-<random>/source.sqlite3" `
      --expected-sha256 "<fixture-pinned-sha>"
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import uuid

from scripts.qa_historical_archive_preflight import (
    approved_archive, digest_file, read_only_connection,
)
from scripts.qa_historical_archive_manifest import make_manifest, verified_manifest, quote


PIN = re.compile(r"[0-9a-fA-F]{64}\Z")
TEMP_FIXTURE = re.compile(r"pharma-legacy-fixture-[0-9a-f]{32}\Z")
SQLITE_FILE = "source.sqlite3"
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_TOTAL_ROWS = 3_000_000
TEMP_STAGE_PREFIX = "pharma-legacy-stage-"
REHEARSAL_MARKER = "__disposable_legacy_upgrade_rehearsal__"
REHEARSAL_DDL = (
    f'CREATE TABLE "{REHEARSAL_MARKER}" '
    "(sequence INTEGER PRIMARY KEY, rehearsal_state TEXT NOT NULL)"
)


class UnsafeSource(ValueError):
    """Failures must never mention PII, local paths, SQL or row identifiers."""


def ensure(ok: bool, reason: str) -> None:
    if not ok:
        raise UnsafeSource(reason)


def require_pin(value: str) -> str:
    ensure(PIN.fullmatch(value) is not None, "invalid_pinned_sha256")
    return value.lower()


def verified_bytes(path: Path, pin: str) -> str:
    actual = digest_file(path)
    ensure(actual == require_pin(pin), "source_sha256_mismatch")
    return actual


def validate_integrity(db: sqlite3.Connection) -> None:
    ensure(db.execute("PRAGMA integrity_check").fetchone() == ("ok",),
           "sqlite_integrity_failed")
    ensure(db.execute("PRAGMA foreign_key_check").fetchone() is None,
           "sqlite_foreign_keys_failed")


def selected_manifest(db: sqlite3.Connection) -> dict:
    manifest = make_manifest(db)
    ensure(manifest["all_table_rows"] <= MAX_TOTAL_ROWS, "row_limit_exceeded")
    return manifest


def masked_summary(manifest: dict, *, action: str) -> dict:
    """No table names, IDs, row data, customer fields, money or source paths."""
    return {
        "action": action,
        "table_count": manifest["table_count"],
        "all_table_rows": manifest["all_table_rows"],
        "opaque_table_ids": sorted(item["opaque_table_id"] for item in manifest["tables"]),
        "opaque_schema_coverage_sha256": manifest["opaque_schema_coverage_sha256"],
        "identity_quarantine": manifest["quarantined_identity_counts"],
        "domain_counts": manifest["domain_counts"],
        "historical_ownership_certified": False,
        "sensitive_history_transfer_authorized": False,
        "financial_receipt_provenance_certified": False,
        "null_blank_legacy_identifiers_preserved": True,
        "owner_reassignment_performed": False,
        "production_or_qa_database_target": False,
    }


def preview_detached(
    archive_path: Path, expected_sha256: str, local_app_data: Path,
) -> dict:
    """Read-only against the EXACT historically approved detached archive."""
    pin = require_pin(expected_sha256)
    archive = approved_archive(archive_path, local_app_data)
    before = verified_bytes(archive, pin)
    with closing(read_only_connection(archive)) as db:
        result = verified_manifest(db, pin, lambda: digest_file(archive))
    ensure(digest_file(archive) == before, "archive_changed_during_preview")
    return {
        **masked_summary(result, action="preview_only"),
        "archive_pinned_sha256_ok": True,
        "source_unchanged_during_read": True,
        "sqlite_integrity_and_foreign_keys_ok": True,
        "private_row_copy_performed": False,
        "next_action": "independent_source_owner_authorization_required",
    }


def no_aliases(path: Path) -> Path:
    """Block Win32 junctions/symlinks, path traversal and path aliases."""
    ensure(path.is_absolute() and path.exists(), "synthetic_fixture_path_denied")
    ensure(not any(p.is_symlink() for p in (path,) + tuple(path.parents)),
           "synthetic_fixture_path_denied")
    absolute = Path(os.path.abspath(path))
    ensure(os.path.normcase(str(absolute)) ==
           os.path.normcase(str(absolute.resolve(strict=True))),
           "synthetic_fixture_alias_denied")
    return absolute


def validated_synthetic_source(source: Path, expected_sha256: str) -> Path:
    """Only explicitly labeled temporary fixture; never archive or live QA."""
    require_pin(expected_sha256)
    root = no_aliases(Path(tempfile.gettempdir()))
    candidate = no_aliases(source)
    ensure(candidate.is_file() and candidate.name == SQLITE_FILE,
           "synthetic_fixture_path_denied")
    ensure(candidate.parent.parent == root and
           TEMP_FIXTURE.fullmatch(candidate.parent.name) is not None,
           "synthetic_fixture_path_denied")
    ensure(0 < candidate.stat().st_size <= MAX_FILE_BYTES,
           "synthetic_fixture_size_denied")
    ensure(candidate.stat().st_nlink == 1, "synthetic_fixture_hardlink_denied")
    # A live, WAL-backed source is deliberately NOT opened immutable because
    # immutable=1 ignores WAL frames and would silently lose committed rows.
    # SQLite mode=ro+Connection.backup uses a consistent read snapshot.
    verified_bytes(candidate, expected_sha256)
    return candidate


def all_rows_digest(
    db: sqlite3.Connection, *, table_names: tuple[str, ...] | None = None,
) -> str:
    """Private, deterministic full-content parity; only booleans escape.

    Stream through sorted canonical binary encodings. SQLite's ORDER BY for
    each column handles duplicate ROWID-free tables, BLOBs and UTF-8 safely.
    This is NOT an ownership certificate or a downloadable row-level hash.
    """
    digest = hashlib.sha256()
    existing = {row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    if table_names is None:
        names = sorted(existing)
    else:
        ensure(len(set(table_names)) == len(table_names) and
               set(table_names).issubset(existing),
               "content_digest_selected_table_missing")
        names = sorted(table_names)
    ensure(len(names) <= 256, "content_digest_table_limit")
    for table in names:
        columns = db.execute(f"PRAGMA table_info({quote(table)})").fetchall()
        ensure(bool(columns), "content_digest_schema_incomplete")
        digest.update(table.encode("utf-8"))
        n = len(columns)
        # Sorting all projected columns provides order-independent hashing and
        # preserves duplicates; these data never appear in JSON or exceptions.
        sql = (f"SELECT * FROM {quote(table)} ORDER BY " +
               ",".join(str(i) for i in range(1, n + 1)))
        for row in db.execute(sql):
            for value in row:
                if value is None:
                    payload, tag = b"", b"N"
                elif isinstance(value, int):
                    payload, tag = str(value).encode("ascii"), b"I"
                elif isinstance(value, float):
                    payload, tag = value.hex().encode("ascii"), b"F"
                elif isinstance(value, str):
                    payload, tag = value.encode("utf-8"), b"T"
                elif isinstance(value, bytes):
                    payload, tag = value, b"B"
                else:
                    raise UnsafeSource("content_digest_unknown_type")
                digest.update(tag)
                digest.update(len(payload).to_bytes(8, "big"))
                digest.update(payload)
        digest.update(b"\x00ENDTABLE")
    return digest.hexdigest()


def open_frozen(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        db.execute("PRAGMA query_only=ON")
        return db
    except BaseException:
        db.close()
        raise


def backup_to(source: sqlite3.Connection, target: Path) -> None:
    ensure(not target.exists(), "stage_target_preexists")
    # Target is created inside a freshly minted private disposable folder.
    # Closing the destination checkpoints/finalizes SQLite and releases locks.
    with closing(sqlite3.connect(target)) as destination:
        source.backup(destination, pages=512, sleep=0.01)


def verify_clone_against(
    original_manifest: dict, original_rows_digest: str, clone: Path,
) -> None:
    with closing(open_frozen(clone)) as db:
        validate_integrity(db)
        cloned_manifest = selected_manifest(db)
        ensure(cloned_manifest == original_manifest,
               "stage_manifest_mismatch")
        ensure(all_rows_digest(db) == original_rows_digest,
               "stage_private_content_mismatch")


def synthetic_rollback_rehearsal(
    candidate: Path, rollback_backup: Path, working: Path, restored: Path,
    baseline_manifest: dict, baseline_digest: str,
) -> dict:
    """All writers target new disposable copies. Original remains untouched."""
    with closing(open_frozen(rollback_backup)) as prior:
        backup_to(prior, working)
    # First test a transactional DDL rollback and reopened state.
    with closing(sqlite3.connect(working)) as mutable:
        mutable.execute("BEGIN IMMEDIATE")
        try:
            mutable.execute(REHEARSAL_DDL)
            mutable.execute(
                f'INSERT INTO "{REHEARSAL_MARKER}" VALUES (?,?)',
                (1, "disposable-only"),
            )
        finally:
            mutable.rollback()
    with closing(open_frozen(working)) as reopened:
        ensure(reopened.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
            (REHEARSAL_MARKER,),
        ).fetchone() == (0,), "sql_ddl_rollback_failed")
    verify_clone_against(baseline_manifest, baseline_digest, working)

    # Independently demonstrate a *committed* synthetic schema operation,
    # then restore by online backup into a NEW file (never overwrite/delete).
    with closing(sqlite3.connect(working)) as committed:
        committed.execute(REHEARSAL_DDL)
        committed.commit()
    with closing(open_frozen(working)) as after_restart:
        ensure(after_restart.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
            (REHEARSAL_MARKER,),
        ).fetchone() == (1,), "staged_commit_restart_failed")
    with closing(open_frozen(rollback_backup)) as prior:
        backup_to(prior, restored)
    verify_clone_against(baseline_manifest, baseline_digest, restored)
    # The original baseline candidate and retained rollback file MUST remain
    # unchanged, even though the separate working rehearsal now has a marker.
    verify_clone_against(baseline_manifest, baseline_digest, candidate)
    verify_clone_against(baseline_manifest, baseline_digest, rollback_backup)
    return {
        "ddl_rollback_after_reopen_ok": True,
        "synthetic_commit_restart_ok": True,
        "new_file_restore_matches_original": True,
        "retained_pre_rehearsal_backups": 2,
    }


def create_stage_root(*, private_root: Path | None = None) -> Path:
    if private_root is None:
        root = no_aliases(Path(tempfile.gettempdir()))
    else:
        root = no_aliases(private_root)
        ensure(root.name == "pharma-disposable-data-copies" and
               root.parent.name == "Local" and root.is_dir(),
               "private_stage_root_denied")
    folder = root / (TEMP_STAGE_PREFIX + uuid.uuid4().hex)
    folder.mkdir(mode=0o700, exist_ok=False)
    ensure(folder.parent == root and folder.is_dir() and not folder.is_symlink(),
           "private_stage_creation_denied")
    return folder


def stage_connection(
    source: sqlite3.Connection, *, stage_root: Path, source_unchanged: callable,
    real_archive: bool,
) -> dict:
    """Only this explicit workflow writes; source connection remains query-only."""
    candidate = stage_root / "candidate.sqlite3"
    rollback = stage_root / "rollback-retained.sqlite3"
    working = stage_root / "working-synthetic-migration.sqlite3"
    restored = stage_root / "restored-after-rehearsal.sqlite3"
    source.execute("PRAGMA query_only=ON")
    validate_integrity(source)
    initial_manifest = selected_manifest(source)
    initial_content = all_rows_digest(source)
    backup_to(source, candidate)
    ensure(source_unchanged(), "source_changed_during_online_backup")
    verify_clone_against(initial_manifest, initial_content, candidate)
    with closing(open_frozen(candidate)) as copy_source:
        backup_to(copy_source, rollback)
    verify_clone_against(initial_manifest, initial_content, rollback)
    rehearsal = synthetic_rollback_rehearsal(
        candidate, rollback, working, restored,
        initial_manifest, initial_content,
    )
    ensure(source_unchanged(), "source_changed_during_rehearsal")
    return {
        **masked_summary(initial_manifest, action=(
            "pinned_archive_disposable_rehearsal" if real_archive
            else "synthetic_disposable_rehearsal")),
        "source_sha256_verified_and_preserved": True,
        "sqlite_integrity_and_foreign_keys_ok": True,
        "source_read_only_connection": True,
        "online_sqlite_backup_complete": True,
        "full_private_content_parity_verified_no_rows_printed": True,
        "disposable_stage_token": stage_root.name,
        "retained_files": 4,
        **rehearsal,
        "real_archive_staged": real_archive,
        "historical_data_transfer_authorized": False,
        "migration_applied_to_production_or_qa": False,
    }


def stage_fixture(source: Path, expected_sha256: str) -> dict:
    """Explicit synthetic-only online backup/restart/rollback rehearsal."""
    pin = require_pin(expected_sha256)
    safe_source = validated_synthetic_source(source, pin)
    initial = verified_bytes(safe_source, pin)
    stage_root = create_stage_root()
    # Never delete a stage on error: both partial files and retained backups
    # remain for operator inspection with access controls.
    try:
        with closing(sqlite3.connect(safe_source.as_uri() + "?mode=ro", uri=True)) as src:
            src.execute("PRAGMA query_only=ON")
            report = stage_connection(
                src, stage_root=stage_root,
                source_unchanged=lambda: digest_file(safe_source) == initial,
                real_archive=False,
            )
    except BaseException as problem:
        # No path, SQL or private data in error output. Stage is deliberately
        # retained even when partial, no replacement or cleanup is attempted.
        if isinstance(problem, UnsafeSource):
            raise
        raise UnsafeSource("synthetic_stage_failed_backups_retained") from None
    return report


def rehearse_pinned_archive(
    archive_path: Path, expected_sha256: str, local_app_data: Path,
) -> dict:
    """Explicit isolated PII custody rehearsal, never any production/app use."""
    pin = require_pin(expected_sha256)
    archive = approved_archive(archive_path, local_app_data)
    before = verified_bytes(archive, pin)
    # Stage root belongs to the existing disposable-copy custody area, not
    # any Tauri app identifier or production/QA sqlite database directory.
    private_root = local_app_data / "pharma-disposable-data-copies"
    stage_root = create_stage_root(private_root=private_root)
    try:
        with closing(read_only_connection(archive)) as source:
            result = stage_connection(
                source, stage_root=stage_root,
                source_unchanged=lambda: digest_file(archive) == before,
                real_archive=True,
            )
        ensure(digest_file(archive) == before,
               "archive_changed_during_rehearsal")
        return result
    except BaseException as issue:
        # Evidence and backups remain isolated for access-controlled review.
        # NEVER replace, restore or delete original or active app databases.
        if isinstance(issue, UnsafeSource):
            raise
        raise UnsafeSource("pinned_archive_rehearsal_failed_stage_retained") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Legacy pharmacy: immutable preview and isolated backup rehearsal")
    modes = parser.add_subparsers(dest="mode", required=True)
    preview = modes.add_parser("preview", help="Read only a pinned detached historical archive")
    preview.add_argument("--archive", type=Path, required=True)
    preview.add_argument("--expected-sha256", required=True)
    pinned = modes.add_parser(
        "rehearse-pinned-archive",
        help="Opt-in online backup into a unique private detached folder; NO QA app or owner adoption",
    )
    pinned.add_argument("--archive", type=Path, required=True)
    pinned.add_argument("--expected-sha256", required=True)
    synthetic = modes.add_parser("stage-fixture", help="Stage only a synthetic OS-TEMP source via SQLite backup")
    synthetic.add_argument("--source", type=Path, required=True)
    synthetic.add_argument("--expected-sha256", required=True)
    args = parser.parse_args(argv)
    try:
        if args.mode in ("preview", "rehearse-pinned-archive"):
            ensure(os.name == "nt" and bool(os.getenv("LOCALAPPDATA")),
                   "approved_windows_archive_environment_required")
            if args.mode == "preview":
                report = preview_detached(args.archive, args.expected_sha256,
                                          Path(os.environ["LOCALAPPDATA"]))
            else:
                report = rehearse_pinned_archive(args.archive, args.expected_sha256,
                                                 Path(os.environ["LOCALAPPDATA"]))
        else:
            report = stage_fixture(args.source, args.expected_sha256)
        print(json.dumps({"ok": True, **report}, sort_keys=True))
        return 0
    except (UnsafeSource, OSError, sqlite3.Error, ValueError) as error:
        reason = str(error) if isinstance(error, UnsafeSource) else "source_rejected_or_unavailable"
        print(json.dumps({
            "ok": False, "reason": reason, "data_transfer_authorized": False,
            "source_owner_inferred": False, "fail_closed": True,
        }, sort_keys=True))
        return 1


if __name__ == "__main__":
    sys.exit(main())
