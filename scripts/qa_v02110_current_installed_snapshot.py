"""Snapshot the CURRENT installed v0.2.109 pharmacy, without opening its SQLite file.

This intentionally refuses nonempty WAL/rollback journals or even an existing
SHM sidecar. A raw byte copy of a live WAL database is NOT a consistent
snapshot: in that case a separately supervised SQLite online backup is
required and this script will not try to checkpoint or alter the original.

The output is a unique private disposable snapshot for offline QA only, not a
license, authentication grant, or installation target.
"""
from __future__ import annotations

import hashlib
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import stat
import sys
import uuid


INSTALLED_SHA = "4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197"
SEALED_SHA = "06fc00f32ec2603758cd3f0eb12c38024f22fce27c4e5f7875ab47aceb6c87fb"
MIN_BYTES = 1_000_000
MAX_BYTES = 400_000_000
NAME = "pharma-v02110-current-installed-offline-"
TENANT = "primary_pharmacy"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_regular(path: Path) -> None:
    mode = path.lstat()
    if not stat.S_ISREG(mode.st_mode) or (
        getattr(mode, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    ):
        raise ValueError("Unsafe source or destination path")


def no_sidecars(source: Path) -> None:
    for suffix in ("-wal", "-shm", "-journal"):
        if Path(str(source) + suffix).exists():
            raise ValueError("Source has SQLite sidecars; raw copy would not be WAL-consistent")


def verify_pharmacy_history(data: bytes) -> dict:
    if not data.startswith(b"SQLite format 3\x00") or not MIN_BYTES < len(data) < MAX_BYTES:
        raise ValueError("Input is not a recognized full source database")
    with closing(sqlite3.connect(":memory:")) as db:
        db.deserialize(data)
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise ValueError("Historical source failed SQLite integrity")
        if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("Historical source failed FK integrity")
        versions = [v for (v,) in db.execute(
            "SELECT version FROM _sqlx_migrations WHERE success=1 ORDER BY version")]
        if versions != list(range(1, 30)):
            raise ValueError("Current source is not an intact v0.2.109 SQLx v29 archive")
        tables = [n for (n,) in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")]
        if len(tables) != 67:
            raise ValueError("Historical source physical table coverage changed")
        count = 0
        for table in tables:
            # All table names originate from SQLite's own validated schema.
            quoted = '"' + table.replace('"', '""') + '"'
            count += db.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
        if count != 289_778:
            raise ValueError("Unexpected current source typed-row census")
        old = db.execute(
            "SELECT seq FROM sqlite_sequence WHERE name='accounts'").fetchall()
        if old != [(4829,)]:
            raise ValueError("Unexpected existing account-sequence metadata")
        return {
            "sqlx_version": 29, "physical_original_tables": len(tables),
            "physical_original_rows": count,
            "accounts_sequence_as_seen_in_current_installed": 4829,
            "sqlite_integrity": "ok", "fk_issues": 0,
        }


def snapshot() -> dict:
    if os.name != "nt":
        raise ValueError("Windows existing-profile-only snapshot")
    source = Path(os.environ["APPDATA"]) / "com.pharma.system" / "pharma_local.db"
    root = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
    safe_regular(source)
    if not root.is_dir() or root.is_symlink():
        raise ValueError("Disposable snapshot root is unavailable or indirect")
    no_sidecars(source)
    metadata = source.stat()
    data = source.read_bytes()  # OS read, never SQLite-connect installed DB.
    if digest(data) != INSTALLED_SHA:
        raise ValueError("Current installed source changed; re-audit before snapshot")
    evidence = verify_pharmacy_history(data)
    if source.stat().st_mtime_ns != metadata.st_mtime_ns:
        raise ValueError("Current source changed during read")
    if digest(source.read_bytes()) != INSTALLED_SHA:
        raise ValueError("Current source changed after read")
    no_sidecars(source)
    folder = root / (NAME + uuid.uuid4().hex)
    folder.mkdir(mode=0o700)
    staged = folder / "current-v02109-offline-source.sqlite3"
    with staged.open("xb") as target:
        target.write(data)
        target.flush()
        os.fsync(target.fileno())
    safe_regular(staged)
    if digest(staged.read_bytes()) != INSTALLED_SHA:
        raise ValueError("Copied snapshot differs from the original")
    evidence.update({
        "status": "CURRENT_V02109_DISPOSABLE_COPY_VERIFIED",
        "current_installed_source_sha256": INSTALLED_SHA,
        "independent_sealed_original_sha256": SEALED_SHA,
        "staged_sha256": INSTALLED_SHA,
        "staged_path": str(staged),
        "desired_single_tenant": TENANT,
        "history_ownership_or_license_inferred": False,
        "installed_source_opened_with_sqlite": False,
        "source_file_or_wal_checkpoint_writes": 0,
        "ready_for_production": False,
    })
    with (folder / "CURRENT_INSTALLED_QA_ONLY.json").open("x", encoding="utf-8") as output:
        json.dump(evidence, output, indent=2, sort_keys=True)
        output.write("\n")
    if digest(source.read_bytes()) != INSTALLED_SHA or source.stat().st_mtime_ns != metadata.st_mtime_ns:
        raise ValueError("Current installed source changed after snapshot")
    no_sidecars(source)
    return evidence


if __name__ == "__main__":
    try:
        print(json.dumps(snapshot(), sort_keys=True))
    except (ValueError, OSError, sqlite3.Error):
        print("REFUSED current-history snapshot: installed source left unchanged", file=sys.stderr)
        raise SystemExit(2)
