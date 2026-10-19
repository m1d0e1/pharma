"""Diagnostic only: compare every original typed row across forward SQL on RAM copy.

Never runs against a writable archive, installed profile or native application.
This diagnostic deliberately bypasses the *real* native startup guard to show
what the SQL would change IF that guard were wrong or bypassed. It cannot
authorize an upgrade; SQL-only execution is not SQLx/Tauri operational QA.
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

from scripts.legacy_pharmacy_upgrade import UnsafeSource, ensure, validate_integrity
from scripts.qa_historical_archive_preflight import (
    approved_archive, digest_file, read_only_connection,
)
from scripts.qa_legacy_row_custody import _row_hash

KNOWN_PIN = "49e04765052bb6e797f959562a0270e53af369a87cadcf0e8430c5bab234fdb1"
KNOWN_ARCHIVE = (
    "production-profile-qa-snapshot-20261017-eaa4fb9f5de04ead80c14a16159a9f31"
)
ARCHIVE_NAME = "production_snapshot_immutable.sqlite3"
MAX_TABLES = 256
MAX_ROWS = 3_000_000
MIGRATION_VERSION = re.compile(r"^([0-9]{3})_.*\.sql$")


def quoted(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def original_table_schema(db: sqlite3.Connection) -> dict[str, tuple[str, ...]]:
    names = [r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )]
    ensure(0 < len(names) <= MAX_TABLES, "historical_table_budget_exceeded")
    schema = {}
    for name in names:
        columns = tuple(r[1] for r in db.execute(f"PRAGMA table_info({quoted(name)})"))
        ensure(bool(columns), "historical_table_missing_columns")
        schema[name] = columns
    return schema


def original_row_commitments(
    db: sqlite3.Connection, columns: dict[str, tuple[str, ...]],
) -> dict[str, tuple[int, str]]:
    """Exact old-column storage/type and complete-row comparison; no PII returned."""
    result = {}
    total = 0
    for name, names in columns.items():
        identifiers = ",".join(quoted(n) for n in names)
        # SQLite sorts the same typed projections identically, even if rows
        # have no single PK. Duplicates still contribute individual hashes.
        order = ",".join(str(i) for i in range(1, len(names) + 1))
        h = hashlib.sha256()
        count = 0
        for row in db.execute(f"SELECT {identifiers} FROM {quoted(name)} ORDER BY {order}"):
            h.update(bytes.fromhex(_row_hash(name, row)))
            count += 1
            total += 1
            ensure(total <= MAX_ROWS, "historical_row_budget_exceeded")
        result[name] = (count, h.hexdigest())
    return result


def _field_types(value: object) -> tuple[str, str]:
    """Private cell representation; never include value in public report."""
    import struct
    if value is None:
        return ("null", "")
    if type(value) is int:
        return ("int", str(value))
    if type(value) is float:
        return ("real", struct.pack(">d", value).hex())
    if type(value) is str:
        return ("text", value)
    if type(value) is bytes:
        return ("blob", value.hex())
    raise UnsafeSource("unknown_historical_cell_type")


def changed_id_columns(
    before: sqlite3.Connection, after: sqlite3.Connection,
    name: str, columns: tuple[str, ...],
) -> dict[str, int] | None:
    """Only for unique original IDs; never output original keys or cell data."""
    if "id" not in columns:
        return None
    statement = f"SELECT {','.join(quoted(n) for n in columns)} FROM {quoted(name)}"
    old = before.execute(statement).fetchall()
    new = after.execute(statement).fetchall()
    id_pos = columns.index("id")
    old_map = {_field_types(row[id_pos]): row for row in old}
    new_map = {_field_types(row[id_pos]): row for row in new}
    if len(old_map) != len(old) or len(new_map) != len(new) or old_map.keys() != new_map.keys():
        return None
    return {
        field: sum(
            1 for key in old_map
            if _field_types(old_map[key][pos]) != _field_types(new_map[key][pos])
        )
        for pos, field in enumerate(columns)
        if any(
            _field_types(old_map[key][pos]) != _field_types(new_map[key][pos])
            for key in old_map
        )
    }


def sql_files(directory: Path, first: int) -> list[tuple[int, Path]]:
    entries = []
    for path in directory.iterdir():
        match = MIGRATION_VERSION.fullmatch(path.name)
        if match is None:
            continue
        number = int(match.group(1))
        if number >= first:
            ensure(path.is_file() and not path.is_symlink(), "forward_sql_source_not_regular")
            entries.append((number, path))
    entries.sort()
    ensure(bool(entries), "forward_sql_not_found")
    ensure([item[0] for item in entries] == list(range(first, entries[-1][0] + 1)),
           "forward_sql_has_gap_or_duplicate")
    return entries


def rehearsal_on_connections(
    source: sqlite3.Connection, migrated: sqlite3.Connection,
    scripts: list[tuple[int, str]], *, include_column_diffs: bool = True,
) -> dict:
    """The caller must supply a disposable RAM clone. Never invokes native IPC."""
    original = original_table_schema(source)
    baseline = original_row_commitments(source, original)
    before_n = sum(count for count, _ in baseline.values())
    applied = []
    error = None
    for version, sql in scripts:
        try:
            migrated.executescript("BEGIN IMMEDIATE;\n" + sql + "\n")
            migrated.commit()
            applied.append(version)
        except sqlite3.Error:
            migrated.rollback()
            error = version
            break
    changed = {}
    missing = []
    original_columns_changed = []
    for name, names in original.items():
        current_columns = tuple(
            r[1] for r in migrated.execute(f"PRAGMA table_info({quoted(name)})")
        )
        if not set(names).issubset(current_columns):
            missing.append(name)
            continue
        # Comparing the original fields (in their original order) permits
        # legitimate newly added columns without losing old-data fidelity.
        current = original_row_commitments(migrated, {name: names})[name]
        if current != baseline[name]:
            changed[name] = {
                "old_count": baseline[name][0], "new_count": current[0],
                "changed_original_fields": changed_id_columns(source, migrated, name, names)
                if include_column_diffs else None,
            }
        if current_columns != names:
            original_columns_changed.append(name)
    integrity = migrated.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    foreign_keys = migrated.execute("PRAGMA foreign_key_check").fetchone() is None
    return {
        "original_tables": len(original), "original_typed_rows": before_n,
        "forward_sql_versions_applied": len(applied),
        "last_forward_sql_version": applied[-1] if applied else None,
        "first_sql_failure_version": error,
        "original_tables_missing_original_columns": sorted(missing),
        "original_tables_with_new_columns": sorted(original_columns_changed),
        "changed_original_record_tables": changed,
        "sqlite_integrity_ok": integrity,
        "foreign_key_check_ok": foreign_keys,
        "sql_only_diagnostic_not_native_sqlx_upgrade": True,
        "historical_tenant_ownership_authorized": False,
        "customer_upgrade_approved": False,
        "safe_to_install_over_customer_database": False,
    }


def audit_pinned_archive(local_app_data: Path, source_pin: str = KNOWN_PIN) -> dict:
    ensure(source_pin.lower() == KNOWN_PIN, "independent_archive_pin_required")
    archive = approved_archive(
        local_app_data / "pharma-disposable-data-copies" / KNOWN_ARCHIVE / ARCHIVE_NAME,
        local_app_data,
    )
    ensure(digest_file(archive) == KNOWN_PIN, "original_archive_pin_mismatch")
    with closing(read_only_connection(archive)) as source:
        validate_integrity(source)
        max_version = source.execute("SELECT MAX(version) FROM _sqlx_migrations").fetchone()[0]
        ensure(max_version == 29, "unexpected_original_migration_version")
        with closing(sqlite3.connect(":memory:")) as migrated:
            source.backup(migrated)
            directory = Path(__file__).resolve().parents[1] / "src-tauri" / "migrations"
            scripts = [(n, path.read_text(encoding="utf-8")) for n, path in sql_files(directory, 30)]
            result = rehearsal_on_connections(source, migrated, scripts)
    ensure(digest_file(archive) == KNOWN_PIN, "archive_changed_during_sql_diagnostic")
    return {
        **result,
        "pinned_archive_unchanged": True,
        "original_sqlx_version": 29,
        "read_only_original_with_ram_clone": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Fail-closed historical SQL-only drift diagnostic")
    parser.add_argument("--expected-sha256", required=True)
    args = parser.parse_args()
    try:
        local_app_data = Path(os.environ["LOCALAPPDATA"])
        report = audit_pinned_archive(local_app_data, args.expected_sha256)
    except (ValueError, sqlite3.Error, OSError, KeyError) as exc:
        print(json.dumps({"status": "REFUSED", "reason": type(exc).__name__,
                          "safe_to_install_over_customer_database": False}))
        return 3
    print(json.dumps(report, sort_keys=True))
    # Even unchanged original rows would NOT prove native startup/login,
    # signed owner/reviewer approval, financial provenance or installer safety.
    # Always exit nonzero: this diagnostic must never be misused as a green
    # production-import/release gate.
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
