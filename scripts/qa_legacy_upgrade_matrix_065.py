"""Safe 065 copy-only matrix: no live database writes, no PII output.

Default run applies exact repo 065 SQL ONLY to copies of a synthetic 064
source, tests transactional exception/rollback/restart and sealed restore.
--pinned-history additionally previews the real 67-table archive RO immutable.
--sealed-064 PATH --sha256 PIN can test a separately sealed 064 QA backup
under an explicit UUID-named temp/custody directory; NEVER installed AppData.
No reversed 065 profile can count as a genuine 064 input.
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

from scripts.legacy_pharmacy_upgrade import (
    UnsafeSource, all_rows_digest, backup_to, create_stage_root,
    digest_file, ensure, no_aliases, open_frozen, preview_detached,
    require_pin, validate_integrity,
)
from scripts.qa_lifecycle_receipt_postflight_064 import (
    PostflightRefused, _synthetic_fixture, audit,
)

MIGRATION = Path(__file__).resolve().parents[1] / "src-tauri" / "migrations" / "065_legacy_upgrade_provenance.sql"
HISTORY_SHA = "49e04765052bb6e797f959562a0270e53af369a87cadcf0e8430c5bab234fdb1"
HISTORY_DIR = "production-profile-qa-snapshot-20261017-eaa4fb9f5de04ead80c14a16159a9f31"
SEALED_FOLDER = re.compile(r"pharma-legacy-qa064-[0-9a-f]{32}\Z")
AUTHORIZED_APPDATA_064_BACKUP = (
    "com.pharma.disposable.lifecycle.qa20261016",
    "backups",
    "1638ebd3-59eb-405a-b828-191ee2a87df8",
    "pharma_local.db",
)
AUTHORIZED_APPDATA_064_SHA = (
    "691e1698e5959e8b6468a77c4d94d6426175259d8f5cf931d6610618704b718b"
)
EVIDENCE_TABLES = (
    "native_legacy_upgrade_manifests",
    "native_legacy_upgrade_source_mappings",
    "native_legacy_upgrade_manifest_seals",
)


def migration_text() -> tuple[str, str]:
    ensure(MIGRATION.is_file() and not MIGRATION.is_symlink(), "migration_065_not_found")
    raw = MIGRATION.read_bytes()
    ensure(raw.startswith(b"-- Prospective registration") and
           raw.count(b"CREATE TABLE native_legacy_upgrade_") == 3 and
           b"CREATE VIEW native_legacy_upgrade_authorized_sources AS" in raw,
           "migration_065_source_unexpected")
    return raw.decode("utf-8"), hashlib.sha256(raw).hexdigest()


def raw_sqlx_history_sha(db: sqlite3.Connection) -> str:
    digest = hashlib.sha256()
    for row in db.execute("SELECT * FROM _sqlx_migrations WHERE version<=64 ORDER BY version"):
        for value in row:
            if value is None:
                tag, part = b"N", b""
            elif isinstance(value, bytes):
                tag, part = b"B", value
            elif isinstance(value, int):
                tag, part = b"I", str(value).encode()
            else:
                tag, part = b"T", str(value).encode("utf-8")
            digest.update(tag + len(part).to_bytes(8, "big") + part)
    return digest.hexdigest()


def snapshot_typed(db: sqlite3.Connection, *, baseline_tables: tuple[str, ...] | None = None) -> dict:
    """Private SHA commitment to EVERY old table; includes exact ID and money bytes."""
    validate_integrity(db)
    present_tables = tuple(sorted(row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name<>'_sqlx_migrations'"
    )))
    if baseline_tables is not None:
        ensure(set(baseline_tables).issubset(present_tables), "old_module_table_missing")
        ensure(set(present_tables) - set(baseline_tables) == set(EVIDENCE_TABLES),
               "unexpected_new_065_tables")
    tables = baseline_tables if baseline_tables is not None else present_tables
    old_counts = tuple(
        db.execute("SELECT count(*) FROM " + '"' + table.replace('"', '""') + '"').fetchone()[0]
        for table in tables
    )
    receipts = (
        "native_purchase_return_provenance", "native_purchase_posting_events",
        "native_sale_cogs_provenance", "native_sale_return_cogs_provenance",
        "native_purchase_create_requests", "native_supplier_payment_receipts",
        "native_patient_wallet_topup_receipts", "native_master_drug_create_receipts",
        "journal_entries",
    )
    receipt_counts = tuple(db.execute(
        "SELECT count(*) FROM " + '"' + table + '"'
    ).fetchone()[0] for table in receipts)
    return {
        "tables": tables,
        "row_counts": old_counts,
        "all_existing_rows_typed_sha": all_rows_digest(db, table_names=tables),
        "old_migrations_typed_sha": raw_sqlx_history_sha(db),
        "numeric_receipt_counts": receipt_counts,
    }


def validate_qa(db: sqlite3.Connection, *, migrated: bool) -> dict:
    result = audit(db, post_065=migrated)
    ensure(result["migration_count"] == (65 if migrated else 64),
           "qa_064_065_version_mismatch")
    if migrated:
        for table in EVIDENCE_TABLES:
            ensure(db.execute('SELECT count(*) FROM "' + table + '"').fetchone() == (0,),
                   "unauthorized_065_mapping_created")
        ensure(db.execute(
            "SELECT count(*) FROM native_legacy_upgrade_authorized_sources"
        ).fetchone() == (0,), "unauthorized_065_view_source")
    return result


def execute_065(db: sqlite3.Connection, script: str, *, force_abort: bool = False) -> None:
    """Exact migration executes in one transaction only on a new disposable copy."""
    ensure(db.execute("PRAGMA query_only").fetchone() == (0,), "copy_is_readonly")
    ensure(db.execute("SELECT count(*) FROM _sqlx_migrations WHERE success=1").fetchone() ==
           (64,), "not_a_true_064_copy")
    db.execute("PRAGMA foreign_keys=ON")
    try:
        db.executescript("BEGIN IMMEDIATE;\n" + script + "\n")
        if force_abort:
            raise UnsafeSource("injected_065_exception_before_commit")
        columns = {row[1] for row in db.execute("PRAGMA table_info(_sqlx_migrations)")}
        if {"description", "checksum", "execution_time"}.issubset(columns):
            db.execute(
                "INSERT INTO _sqlx_migrations"
                "(version,description,success,checksum,execution_time) VALUES (65,?,1,?,0)",
                ("legacy_upgrade_provenance",
                 sqlite3.Binary(hashlib.sha384(script.encode("utf-8")).digest())),
            )
        else:
            ensure(columns == {"version", "success"}, "unsupported_fixture_sqlx")
            db.execute("INSERT INTO _sqlx_migrations VALUES(65,1)")
        db.commit()
    except BaseException:
        db.rollback()
        raise


def stage_one_matrix(
    source: sqlite3.Connection, script: str, *, source_guard: callable,
    real_064: bool,
) -> dict:
    source.execute("PRAGMA query_only=ON")
    validate_qa(source, migrated=False)
    baseline = snapshot_typed(source)
    stage = create_stage_root()
    candidate = stage / "qa064-source-copy.sqlite3"
    sealed = stage / "qa064-sealed-backup.sqlite3"
    failure = stage / "qa065-rollback-test.sqlite3"
    migrated = stage / "qa065-migrated.sqlite3"
    restored = stage / "qa064-restored.sqlite3"
    backup_to(source, candidate)
    ensure(source_guard(), "source_changed_during_online_backup")
    with closing(open_frozen(candidate)) as db:
        validate_qa(db, migrated=False)
        ensure(snapshot_typed(db) == baseline, "initial_064_copy_not_identical")
        backup_to(db, sealed)
    with closing(open_frozen(sealed)) as db:
        ensure(snapshot_typed(db) == baseline, "sealed_064_not_identical")
        backup_to(db, failure)
        backup_to(db, migrated)
        backup_to(db, restored)
    with closing(sqlite3.connect(failure)) as db:
        try:
            execute_065(db, script, force_abort=True)
        except UnsafeSource as error:
            ensure(str(error) == "injected_065_exception_before_commit",
                   "unexpected_065_failure")
        else:
            raise UnsafeSource("065_incomplete_should_rollback")
    with closing(open_frozen(failure)) as db:
        validate_qa(db, migrated=False)
        ensure(snapshot_typed(db) == baseline, "065_rollback_corrupted_064")
        ensure(db.execute(
            "SELECT count(*) FROM sqlite_master WHERE name='native_legacy_upgrade_manifests'"
        ).fetchone() == (0,), "065_ddl_not_rolled_back")
    with closing(sqlite3.connect(migrated)) as db:
        execute_065(db, script)
    with closing(open_frozen(migrated)) as db:
        validate_qa(db, migrated=True)
        ensure(snapshot_typed(db, baseline_tables=baseline["tables"]) == baseline,
               "065_migration_changed_old_source_rows")
    for path in (candidate, sealed, restored):
        with closing(open_frozen(path)) as db:
            validate_qa(db, migrated=False)
            ensure(snapshot_typed(db) == baseline, "sealed_backup_not_recoverable")
    ensure(source_guard(), "original_source_changed_during_065")
    return {
        "source": "pinned_sealed_064" if real_064 else "disposable_synthetic_064",
        "status": "PASS",
        "copied_064_verified": True,
        "exact_065_sql_applied_to_copy_only": True,
        "old_all_table_content_and_original_numeric_receipts_identical": True,
        "old_sqlx_checksum_rows_preserved": True,
        "exception_transactional_ddl_rollback_restart_verified": True,
        "completed_065_restart_verified": True,
        "unmodified_sealed_backup_restart_verified": True,
        "retained_private_copy_files": 5,
        "active_qa_or_archive_written": False,
        "original_tenant_reassigned": False,
        "new_provenance_seals_created": 0,
        "historical_use_authorized": False,
    }


def synthetic_source() -> sqlite3.Connection:
    db = _synthetic_fixture()
    db.executescript("""
        ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE returns ADD COLUMN pharmacy_id TEXT;
        UPDATE returns SET pharmacy_id='qa_lifecycle_20261016';
        CREATE TABLE native_owner_scope_review(owner_id TEXT);
        CREATE TABLE activity_log(id INTEGER PRIMARY KEY,pharmacy_id TEXT);
        CREATE TABLE shortages(id INTEGER PRIMARY KEY,pharmacy_id TEXT);
        CREATE TABLE purchase_orders(id TEXT PRIMARY KEY,pharmacy_id TEXT);
        CREATE TABLE expenses(id TEXT PRIMARY KEY,pharmacy_id TEXT);
        CREATE TABLE financial_notices(id TEXT PRIMARY KEY,pharmacy_id TEXT);
    """)
    db.commit()
    return db


def run_synthetic() -> dict:
    script, fingerprint = migration_text()
    with closing(synthetic_source()) as memory:
        before = hashlib.sha256(memory.serialize()).hexdigest()
        report = stage_one_matrix(
            memory, script, real_064=False,
            source_guard=lambda: hashlib.sha256(memory.serialize()).hexdigest() == before,
        )
    ensure(digest_file(MIGRATION) == fingerprint, "065_sql_changed_during_matrix")
    return report


def validate_sealed_064(path: Path, sha: str) -> Path:
    pin = require_pin(sha)
    sealed = no_aliases(path)
    ensure(sealed.is_file(), "sealed_064_path_denied")
    temp = no_aliases(Path(tempfile.gettempdir()))
    app_root = Path(os.environ.get("LOCALAPPDATA", "")) / "pharma-disposable-data-copies"
    allowed = (
        sealed.name == "qa064-sealed.sqlite3" and
        SEALED_FOLDER.fullmatch(sealed.parent.name) is not None and
        sealed.parent.parent == temp
    )
    if app_root.is_dir() and sealed.name == "qa064-sealed.sqlite3":
        allowed |= (
            SEALED_FOLDER.fullmatch(sealed.parent.name) is not None and
            sealed.parent.parent == no_aliases(app_root)
        )
    # Prime independently pinned the genuine native *pre-upgrade* 064
    # auto-backup. The pathname and hash must BOTH be exact; this never
    # includes installed QA's active pharma_local.db, which is now 065.
    appdata = os.environ.get("APPDATA")
    if appdata:
        special = Path(appdata).joinpath(*AUTHORIZED_APPDATA_064_BACKUP)
        allowed |= (
            sealed == special.resolve() and
            pin == AUTHORIZED_APPDATA_064_SHA and
            sealed.name == "pharma_local.db"
        )
    ensure(allowed and 0 < sealed.stat().st_size < 1024**3 and
           sealed.stat().st_nlink == 1, "sealed_064_path_denied")
    ensure(not any(sealed.with_name(sealed.name + suffix).exists()
                   for suffix in ("-wal", "-shm", "-journal")),
           "sealed_064_sidecar_denied")
    ensure(digest_file(sealed) == pin, "sealed_064_sha_denied")
    return sealed


def run_sealed_064(source_path: Path, sha: str) -> dict:
    path = validate_sealed_064(source_path, sha)
    script, migration_fingerprint = migration_text()
    original_sha = digest_file(path)
    # Always create a separate *one-level* private 064 sealed copy, including
    # when the input itself is the native pre-upgrade auto-backup. Never run
    # migration SQL against that original backup or installed QA.
    temporary = no_aliases(Path(tempfile.gettempdir()))
    folder = temporary / ("pharma-legacy-qa064-" + uuid.uuid4().hex)
    folder.mkdir(mode=0o700, exist_ok=False)
    copy = folder / "qa064-sealed.sqlite3"
    with closing(open_frozen(path)) as original:
        validate_qa(original, migrated=False)
        baseline = snapshot_typed(original)
        backup_to(original, copy)
    ensure(digest_file(path) == original_sha, "native_064_backup_changed_during_copy")
    copied_pin = digest_file(copy)
    with closing(open_frozen(copy)) as source:
        validate_qa(source, migrated=False)
        ensure(snapshot_typed(source) == baseline, "native_064_backup_copy_not_identical")
        result = stage_one_matrix(
            source, script, real_064=True,
            source_guard=lambda: digest_file(copy) == copied_pin and
            digest_file(path) == original_sha,
        )
    ensure(digest_file(copy) == copied_pin, "one_level_sealed_064_copy_changed")
    ensure(digest_file(path) == original_sha and
           digest_file(MIGRATION) == migration_fingerprint,
           "source_changed_after_065_copy_rehearsal")
    result["separately_pinned_064_staging_copy_preserved"] = True
    return result


def preview_pinned_history() -> dict:
    local = os.environ.get("LOCALAPPDATA")
    ensure(os.name == "nt" and bool(local), "windows_pinned_archive_required")
    root = Path(local)
    archive = (root / "pharma-disposable-data-copies" /
               HISTORY_DIR / "production_snapshot_immutable.sqlite3")
    report = preview_detached(archive, HISTORY_SHA, root)
    q = report["identity_quarantine"]
    ensure(report["table_count"] == 67 and report["all_table_rows"] == 289778 and
           q["literal_null"] == 28 and q["literal_local_default"] == 7539 and
           q["unscoped_columns"] == 282211 and q["blank"] == 0 and
           q["explicit_but_unverified"] == 0,
           "pinned_historical_parity_denied")
    return {
        "status": "PASS",
        "historical_table_count": 67, "historical_row_count": 289778,
        "distinct_identity_classes_checked": True,
        "immutable_pinned_source_preserved": True,
        "historical_copy_into_qa": False,
        "source_owner_certified": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Safe copy-only 065 matrix; PASS/FAIL aggregates")
    parser.add_argument("--pinned-history", action="store_true",
                        help="RO immutable pinned 67-table historical archive preflight")
    parser.add_argument("--sealed-064", type=Path,
                        help="Only an independently SHA-pinned isolated 064 fixture")
    parser.add_argument("--sha256", help="Required independent pin for --sealed-064")
    args = parser.parse_args(argv)
    if bool(args.sealed_064) != bool(args.sha256):
        parser.error("sealed-064 path and SHA-256 pin must be supplied together")
    stages = {}
    try:
        stages["synthetic_064_to_065"] = run_synthetic()
        if args.pinned_history:
            stages["historical_immutable_preview"] = preview_pinned_history()
        if args.sealed_064:
            stages["sealed_real_064_to_065"] = run_sealed_064(args.sealed_064, args.sha256)
        print(json.dumps({
            "status": "PASS", "stages": stages,
            "evidence_limits": "copied_source_and_exact_SQL_only; no GUI, signed owner authority, live 065 upgrade, financial provenance or active QA writes",
        }, sort_keys=True))
        return 0
    except BaseException as failure:
        code = str(failure) if isinstance(failure, (UnsafeSource, PostflightRefused)) else "065_copy_matrix_failed"
        print(json.dumps({
            "status": "FAIL", "reason": code, "stages_completed": len(stages),
            "installed_qa_or_archive_modified": False,
            "source_owner_certified": False,
        }, sort_keys=True))
        return 1


if __name__ == "__main__":
    sys.exit(main())
