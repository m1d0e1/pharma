"""Isolated SQL-only 029→067 rehearsal using CURRENT installed v0.2.109 copy.

Never connects to or mutates installed customer SQLite. A validated, exact
disposable 029 snapshot is deserialized into private RAM, original SQL migration
texts are applied only in RAM, then a separate new QA-only v67 database is
written with sqlite3.backup. This is deliberately NOT native SQLx startup,
credential enrollment, ownership authorization or commercial acceptance.
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid

from scripts.qa_historical_forward_sql_drift import (
    original_row_commitments, original_table_schema, changed_id_columns,
    sql_files,
)
from scripts.qa_v02110_current_installed_snapshot import (
    INSTALLED_SHA, TENANT, verify_pharmacy_history, no_sidecars, safe_regular,
)


ROOT = Path(__file__).resolve().parents[1]
COPY_PREFIX = "pharma-v02110-current-installed-offline-"
OUTPUT_PREFIX = "pharma-v02110-current-v67-sql-rehearsal-"
TO_VERSION = 67


def digest_file(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def source_copy_checked(path: Path) -> tuple[bytes, dict]:
    root = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
    if (path.name != "current-v02109-offline-source.sqlite3"
            or re.fullmatch(COPY_PREFIX + r"[0-9a-f]{32}", path.parent.name) is None
            or path.parent.parent.resolve(strict=True) != root.resolve(strict=True)):
        raise ValueError("Current source must be a new designated disposable 029 copy")
    safe_regular(path)
    no_sidecars(path)
    recorded = json.loads((path.parent / "CURRENT_INSTALLED_QA_ONLY.json").read_text(encoding="utf-8"))
    if (recorded.get("staged_sha256") != INSTALLED_SHA
            or recorded.get("desired_single_tenant") != TENANT
            or recorded.get("status") != "CURRENT_V02109_DISPOSABLE_COPY_VERIFIED"):
        raise ValueError("No verified current-history snapshot manifest")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != INSTALLED_SHA:
        raise ValueError("Current-history copy changed since custody verification")
    evidence = verify_pharmacy_history(raw)
    return raw, evidence


def rehearsal(source: Path) -> dict:
    raw, evidence = source_copy_checked(source)
    root = source.parent.parent
    dest_folder = root / (OUTPUT_PREFIX + uuid.uuid4().hex)
    dest_folder.mkdir(mode=0o700)
    dest = dest_folder / "current-v02109-to-v67-SQL-ONLY-NOT-AUTHORIZED.sqlite3"
    # Registered migrations may continue past 067. This historical v29→v67
    # rehearsal must remain valid when forward-only 068/069 (or later) land;
    # include *only* the exact, immutable 030..067 historical chain.
    scripts = [item for item in sql_files(ROOT / "src-tauri" / "migrations", 30)
               if item[0] <= TO_VERSION]
    if [n for n, _ in scripts] != list(range(30, TO_VERSION + 1)):
        raise ValueError("Forward migration chain differs from verified 030..067")

    with closing(sqlite3.connect(":memory:")) as before, closing(sqlite3.connect(":memory:")) as migrated:
        before.deserialize(raw)
        before.execute("PRAGMA query_only=ON")
        before.backup(migrated)
        old_schema = original_table_schema(before)
        typed_before = original_row_commitments(before, old_schema)
        applied: list[int] = []
        for number, file in scripts:
            sql_bytes = file.read_bytes()
            if not sql_bytes:
                raise ValueError(f"Empty registered forward SQL migration {number}")
            try:
                # This diagnostic deliberately executes the immutable SQL alone
                # and records SQLx-style SHA-384 ledger entries. Native startup
                # may perform additional compatibility preflight; do not infer
                # runtime success from this isolated SQL-only rehearsal.
                migrated.executescript("BEGIN IMMEDIATE;\n" + sql_bytes.decode("utf-8") + "\nCOMMIT;")
                description = file.stem.split("_", 1)[1]
                migrated.execute(
                    "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time)"
                    " VALUES(?,?,?,?,?)",
                    (number, description, 1, hashlib.sha384(sql_bytes).digest(), 0),
                )
                migrated.commit()
                applied.append(number)
            except sqlite3.Error as exc:
                migrated.rollback()
                raise ValueError(f"Offline forward SQL refused at migration {number}: {type(exc).__name__}") from exc
        if migrated.execute("SELECT MAX(version) FROM _sqlx_migrations").fetchone() != (67,):
            raise ValueError("SQL forward migration registry incomplete")
        if migrated.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise ValueError("SQL forward stage integrity failure")
        if migrated.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("SQL forward stage FK failure")
        changed = {}
        for table, columns in old_schema.items():
            after_info = {column[1] for column in migrated.execute(
                f'PRAGMA table_info("{table.replace(chr(34), chr(34) * 2)}")')}
            if not set(columns).issubset(after_info):
                raise ValueError("Original table columns missing after SQL migration")
            after = original_row_commitments(migrated, {table: columns})[table]
            if after != typed_before[table]:
                changed[table] = {
                    "source_rows": typed_before[table][0], "target_rows": after[0],
                    "changed_original_fields": changed_id_columns(before, migrated, table, columns),
                }
        # The old source's sqlite_sequence may stay exactly unchanged: SQL-only
        # migration replay does not have to execute native account compatibility
        # seeding (the latter is a separate pre-migration native code path).
        if (not {"_sqlx_migrations", "users"}.issubset(changed)
                or set(changed) - {"_sqlx_migrations", "users", "sqlite_sequence"}):
            raise ValueError(f"Unexpected original-history table drift: {sorted(changed)}")
        if (changed["users"]["changed_original_fields"]
                != {"password_hash": 1, "pharmacy_id": 1}):
            raise ValueError("Immutable owner credential/scope change differs from expected 032/052")
        old_counts = sum(item[0] for item in typed_before.values())
        if old_counts != evidence["physical_original_rows"]:
            raise ValueError("Original historic row counts do not agree")
        if digest_file(source) != INSTALLED_SHA:
            raise ValueError("Source changed during RAM-only forward replay")
        # Durable *independent* stage, never a new installed profile.
        with closing(sqlite3.connect(dest)) as on_disk:
            migrated.backup(on_disk)
            on_disk.commit()
    no_sidecars(source)
    if digest_file(source) != INSTALLED_SHA or not dest.is_file():
        raise ValueError("Source drift or missing disposable stage")
    result = {
        "status": "CURRENT_HISTORY_SQL_ONLY_029_TO_067_REHEARSAL",
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_disposable_current_v29": str(source),
        "source_sha256": INSTALLED_SHA,
        "destination_disposable_v67": str(dest),
        "destination_sha256": digest_file(dest),
        "original_physical_table_count": len(old_schema),
        "original_physical_typed_rows": old_counts,
        "applied_forward_migration_versions": applied,
        "expected_original_table_changes": changed,
        "final_sqlx_version": 67,
        "desired_permanent_tenant": TENANT,
        "native_sqlx_startup_executed": False,
        "native_authentication_executed": False,
        "user_scope_mapping_executed": False,
        "independent_secondary_reviewer_required_by_user": False,
        "owner_authenticated": False,
        "commercial_license_verified": False,
        "can_install_over_customer": False,
        "original_source_writes": 0,
    }
    with (dest_folder / "OFFLINE_SQL_ONLY_NOT_AUTHORIZED.json").open("x", encoding="utf-8") as output:
        json.dump(result, output, indent=2, sort_keys=True)
        output.write("\n")
    return {key: result[key] for key in (
        "status", "source_sha256", "destination_disposable_v67", "destination_sha256",
        "original_physical_typed_rows", "final_sqlx_version",
        "desired_permanent_tenant", "native_authentication_executed",
        "can_install_over_customer",
    )}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Supply exact verified disposable current-v29 snapshot path")
        print(json.dumps(rehearsal(Path(sys.argv[1])), sort_keys=True))
    except (ValueError, OSError, sqlite3.Error, MemoryError) as exc:
        print("REFUSED SQL-only current-history migration: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
