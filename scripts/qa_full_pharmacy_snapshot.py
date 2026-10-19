"""Build a protected, read-only sourced full-data pharmacy QA snapshot.

Never modifies the protected source database or the currently installed QA DB.
The complete source is stored only as a CurrentUser-DPAPI encrypted SQLite
backup; the separate working SQLite copy contains selected nonfinancial
catalog/reference data and retains the legitimate synthetic QA identity.

Run only in the trusted Windows workspace:
    python -B -m scripts.qa_full_pharmacy_snapshot
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import sqlite3

from scripts.licensing.local_qa import protect, unprotect


SOURCE_SHA256 = "8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3"
QA_APP_ID = "com.pharma.disposable.qa20261015renewable"
CATALOG_TABLES = (
    "master_drugs", "drug_interactions", "manufacturers", "product_categories",
    "scientific_groups", "item_natures", "units",
)
REQUIRED_EMPTY_HISTORY = (
    "inventory", "patients", "sales_invoices", "sales_items", "purchase_invoices",
    "purchase_invoice_items", "suppliers", "supplier_transactions", "purchase_returns",
)


def _readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.execute("PRAGMA query_only=ON")
    return connection


def _count(connection: sqlite3.Connection, table: str) -> int:
    if table not in CATALOG_TABLES + REQUIRED_EMPTY_HISTORY + ("users", "_sqlx_migrations"):
        raise RuntimeError("Unapproved table count requested")
    return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def _columns(connection: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in connection.execute(f"PRAGMA table_info({table})")]


def _bulk_transfer(source: sqlite3.Connection, target: sqlite3.Connection, table: str) -> None:
    src_cols = _columns(source, table)
    dest_cols = _columns(target, table)
    if not src_cols or not dest_cols or not set(src_cols).issubset(dest_cols):
        raise RuntimeError(f"Incompatible catalog table layout: {table}")
    columns_sql = ", ".join('"' + name + '"' for name in src_cols)
    placeholders = ", ".join("?" for _ in src_cols)
    target.execute(f"DELETE FROM {table}")  # detached catalog-only working copy
    cursor = source.execute(f"SELECT {columns_sql} FROM {table}")
    while True:
        block = cursor.fetchmany(1000)
        if not block:
            break
        target.executemany(
            f"INSERT INTO {table} ({columns_sql}) VALUES ({placeholders})", block
        )


def main() -> None:
    if os.name != "nt":
        raise RuntimeError("Windows CurrentUser-DPAPI protection is mandatory")
    root = Path(__file__).resolve().parents[1]
    original = root / "src-tauri" / "pharma_local.db"
    independent = Path(os.environ["APPDATA"]) / QA_APP_ID / "pharma_local.db"
    directory = Path(os.environ["LOCALAPPDATA"]) / "PharmaFullCatalogQa20261015"
    encrypted = directory / "original-complete-sqlite.dpapi"
    staged = directory / "pharma-catalog-workbench.db"
    if not original.is_file() or not independent.is_file():
        raise RuntimeError("Both original and independent QA SQLite databases must exist")
    if _sha256(original) != SOURCE_SHA256:
        raise RuntimeError("Protected original pharmacy database hash has changed")
    if encrypted.exists() or staged.exists():
        raise RuntimeError("Refusing to overwrite an existing full-data snapshot or QA workbench")
    source = _readonly(original)
    qa = _readonly(independent)
    try:
        if source.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("Source SQLite quick_check failed")
        if qa.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("Synthetic QA SQLite quick_check failed")
        if sum(1 for _ in source.execute("PRAGMA foreign_key_check")):
            raise RuntimeError("Original pharmacy has foreign-key violations")
        if qa.execute("SELECT COUNT(*) FROM _sqlx_migrations WHERE success=1").fetchone()[0] != 59:
            raise RuntimeError("Synthetic QA does not have all 59 native migrations")
        if qa.execute(
            "SELECT COUNT(*) FROM users WHERE id=? AND role=? AND pharmacy_id=? AND is_active=1",
            ("admin", "owner", "local_default"),
        ).fetchone()[0] != 1:
            raise RuntimeError("The legitimate independent QA owner identity changed")
        for table in REQUIRED_EMPTY_HISTORY:
            if _count(source, table) or _count(qa, table):
                raise RuntimeError(f"Protected history is unexpectedly nonempty: {table}")
        if _count(source, "master_drugs") != 25404:
            raise RuntimeError("Original pharmacy drug catalog count unexpectedly changed")
        expected_counts = {table: _count(source, table) for table in CATALOG_TABLES}

        # A consistent original *full* SQLite backup is serialized in memory
        # before DPAPI sealing. Never write the full unredacted DB as plaintext.
        full = sqlite3.connect(":memory:")
        source.backup(full)
        try:
            if full.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("Complete in-memory original snapshot failed integrity")
            snapshot = full.serialize()
            original_tables = full.execute(
                "SELECT COUNT(*) FROM sqlite_master WHERE type=?", ("table",)
            ).fetchone()[0]
            sealed = protect(snapshot)
        finally:
            full.close()
        # DPAPI roundtrip is checked byte-for-byte. Windows' bundled Python
        # SQLite deserialize cannot reopen this 58 MB legacy FTS database in
        # memory, even without encryption; the original memory-backed backup
        # above was already independently integrity-checked via SQLite.
        recovered = unprotect(sealed)
        if len(recovered) != len(snapshot) or hashlib.sha256(recovered).digest() != hashlib.sha256(snapshot).digest():
            raise RuntimeError("Encrypted full original SQLite bytes failed DPAPI roundtrip")

        directory.mkdir(parents=True, exist_ok=True)
        with encrypted.open("xb") as handle:
            handle.write(sealed)
            handle.flush()
            os.fsync(handle.fileno())

        # Create a separate workbench from the current signed-identity QA
        # database. Never write the running app's DB, password, or tenant actor.
        target = sqlite3.connect(str(staged))
        try:
            qa.backup(target)
            target.execute("PRAGMA foreign_keys=ON")
            target.execute("BEGIN IMMEDIATE")
            for table in CATALOG_TABLES:
                _bulk_transfer(source, target, table)
            if list(target.execute("PRAGMA foreign_key_check")):
                raise RuntimeError("Catalog working-copy import broke foreign keys")
            target.commit()
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("QA catalog working copy failed SQLite integrity_check")
            if _count(target, "users") != _count(qa, "users"):
                raise RuntimeError("Catalog import changed QA user count")
            for table in REQUIRED_EMPTY_HISTORY:
                if _count(target, table):
                    raise RuntimeError(f"Unexpected business data in working copy: {table}")
            for table, expected in expected_counts.items():
                if _count(target, table) != expected:
                    raise RuntimeError(f"Catalog count mismatch after import: {table}")
            fts_count = target.execute("SELECT COUNT(*) FROM master_drugs_fts").fetchone()[0]
            if fts_count != expected_counts["master_drugs"]:
                raise RuntimeError("Master medicine FTS catalog count mismatch")
        finally:
            target.close()
        if _sha256(original) != SOURCE_SHA256:
            raise RuntimeError("Protected original database hash changed after QA construction")
        print("FULL_ENCRYPTED_SNAPSHOT=" + str(encrypted))
        print("FULL_SNAPSHOT_TABLE_COUNT=" + str(original_tables))
        print("FULL_SNAPSHOT_DPAPI_RECOVERY=PASS")
        print("SEPARATE_CATALOG_WORKBENCH=" + str(staged))
        print("CATALOG_WORKBENCH_SHA256=" + _sha256(staged))
        for table, count in expected_counts.items():
            print("QA_" + table.upper() + "_COUNT=" + str(count))
        print("CATALOG_FTS_COUNT=" + str(fts_count))
        print("ORIGINAL_UNMODIFIED_SHA256=" + SOURCE_SHA256)
        print("EXISTING_SIGNED_QA_DATABASE_NOT_MODIFIED=PASS")
    finally:
        source.close()
        qa.close()


if __name__ == "__main__":
    main()
