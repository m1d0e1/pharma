"""Privacy-safe, strictly read-only preflight for a preserved production archive.

This is a CLI inspection gate, not an authorization token for an interactive
GUI, a tenant migration, or a historical financial certification.
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


ARCHIVE_NAME = "production_snapshot_immutable.sqlite3"
ARCHIVE_FOLDER = re.compile(r"production-profile-qa-snapshot-\d{8}-[a-f0-9]{32}\Z")
SHA256 = re.compile(r"[a-fA-F0-9]{64}\Z")

# Fixed counts only. Never return original IDs, names, balances or credentials.
IDENTITY_TABLES = (
    "users", "inventory", "sales_invoices", "purchase_invoices",
    "daily_journals", "cash_movements",
)
GLOBAL_TABLES = ("patients", "suppliers", "supplier_transactions")


def approved_archive(path: Path, local_app_data: Path) -> Path:
    root = (local_app_data / "pharma-disposable-data-copies").resolve()
    if not root.is_dir():
        raise ValueError("Archive must be the designated detached production snapshot")
    if path.is_symlink() or path.parent.is_symlink() or path.parent.parent.is_symlink():
        raise ValueError("Archive path links are not accepted")
    candidate = path.resolve(strict=True)
    if (
        not candidate.is_file()
        or candidate.name != ARCHIVE_NAME
        or candidate.parent.parent != root
        or ARCHIVE_FOLDER.fullmatch(candidate.parent.name) is None
    ):
        raise ValueError("Archive must be the designated detached production snapshot")
    for suffix in ("-wal", "-shm", "-journal"):
        if candidate.with_name(candidate.name + suffix).exists():
            raise ValueError("Archive has a live SQLite sidecar; use a finalized detached copy")
    return candidate


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_only_connection(archive: Path) -> sqlite3.Connection:
    # This path is reached only after the detached-folder, sidecar and hash
    # checks. The reader intentionally has no write-capable connection.
    connection = sqlite3.connect(archive.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        connection.execute("PRAGMA query_only=ON")
        return connection
    except BaseException:
        connection.close()
        raise


def scope_counts(connection: sqlite3.Connection, table: str) -> dict[str, object]:
    # The full coverage manifest also supplies opaque sqlite_master names.
    # Escape all identifiers; do not allow schema names to become SQL syntax.
    quoted = '"' + table.replace('"', '""') + '"'
    columns = {col[1] for col in connection.execute(f"PRAGMA table_info({quoted})")}
    if not columns:
        raise ValueError("Archive is missing a required table layout")
    if "pharmacy_id" not in columns:
        return {
            "rows": connection.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0],
            "identity": "column_absent",
        }
    row = connection.execute(f"""
        SELECT COUNT(*),
          SUM(CASE WHEN pharmacy_id IS NULL THEN 1 ELSE 0 END),
          SUM(CASE WHEN typeof(pharmacy_id)='text'
                    AND pharmacy_id='local_default' THEN 1 ELSE 0 END),
          SUM(CASE WHEN typeof(pharmacy_id)='text'
                    AND TRIM(pharmacy_id)='' THEN 1 ELSE 0 END),
          SUM(CASE WHEN pharmacy_id IS NOT NULL
                    AND NOT (typeof(pharmacy_id)='text'
                             AND (pharmacy_id='local_default' OR TRIM(pharmacy_id)=''))
                   THEN 1 ELSE 0 END)
        FROM {quoted}
    """).fetchone()
    return {
        "rows": row[0],
        "identity": "literal_pharmacy_id",
        "null": row[1] or 0,
        "local_default": row[2] or 0,
        "blank": row[3] or 0,
        "other_exact_values": row[4] or 0,
    }


def inspect_archive(
    path: Path, expected_sha256: str, local_app_data: Path,
    *, include_manifest: bool = False,
) -> dict:
    if SHA256.fullmatch(expected_sha256) is None:
        raise ValueError("A 64-character pinned SHA-256 is required")
    archive = approved_archive(path, local_app_data)
    before = digest_file(archive)
    if before.lower() != expected_sha256.lower():
        raise ValueError("Archive SHA-256 differs from the independently verified snapshot")
    # Only appropriate for the already-detached, sidecar-free backup.
    # immutable=1 prevents SQLite from creating an SHM/journal or acquiring a
    # writer, while mode=ro and query_only provide additional independent gates.
    manifest = None
    with closing(read_only_connection(archive)) as connection:
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Archive integrity check failed")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("Archive foreign key check failed")
        result = {table: scope_counts(connection, table)
                  for table in IDENTITY_TABLES + GLOBAL_TABLES}
        if any(result[table]["identity"] != "literal_pharmacy_id"
               for table in IDENTITY_TABLES):
            raise ValueError("Expected tenant identity column is missing")
        if include_manifest:
            from scripts.qa_historical_archive_manifest import verified_manifest
            manifest = verified_manifest(
                connection, expected_sha256, lambda: digest_file(archive)
            )
    if digest_file(archive) != before:
        raise ValueError("Archive changed while being inspected")
    report = {
        "archive_sha256": before,
        "integrity": "ok",
        "tenant_categories": result,
        "historical_ownership_verified": False,
        "interactive_transactions_authorized": False,
        "null_and_local_default_preserved": True,
    }
    if manifest is not None:
        report["historical_coverage_manifest"] = manifest
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect detached production history without writes")
    parser.add_argument("--snapshot", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument(
        "--historical-manifest", action="store_true",
        help="Include all-table opaque coverage counts and orphan/quarantine checks; never exports rows",
    )
    arguments = parser.parse_args()
    report = inspect_archive(
        arguments.snapshot, arguments.expected_sha256, Path(os.environ["LOCALAPPDATA"]),
        include_manifest=arguments.historical_manifest,
    )
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
