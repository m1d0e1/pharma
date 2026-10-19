"""Create an isolated, empty-business native GUI QA seed; NEVER touch customer data.

Only accepts the repository's reference-only bundled seed and a new filename
within the chosen isolated Cargo debug directory. This is NOT an ownership
reconciliation of an existing pharmacy and must never run on APPDATA profiles.

Usage from repo root:
  python -B -m scripts.qa_prepare_synthetic_primary_seed --debug-dir PATH
"""

import argparse
import hashlib
import os
from pathlib import Path
import sqlite3

BUSINESS = (
    "patients", "inventory", "sales_invoices", "sales_items", "purchase_invoices",
    "purchase_invoice_items", "returns", "return_items", "cash_movements", "daily_journals",
)


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def prepare(debug_dir: Path) -> dict:
    project = Path(__file__).resolve().parent.parent
    source = project / "src-tauri" / "pharma_local.db"
    if not source.is_file() or source.is_symlink():
        raise RuntimeError("Reference-only bundled seed is missing or aliased")
    debug_dir = debug_dir.resolve(strict=True)
    allowed = (project.parent / "pharma-builds").resolve(strict=True)
    if debug_dir.name != "debug" or allowed not in debug_dir.parents:
        raise RuntimeError("QA seed destination must be an isolated pharma-builds Cargo debug folder")
    if os.path.normcase(str(debug_dir)).startswith(os.path.normcase(os.environ.get("APPDATA", "NO_APPDATA_DEST"))):
        raise RuntimeError("Never create a seed in the installed APPDATA profiles")
    for parent in (debug_dir, debug_dir.parent, allowed):
        if parent.is_symlink():
            raise RuntimeError("QA build folder contains an alias")
    target = debug_dir / "pharma_local.db"
    if target.exists() or target.is_symlink() or any(Path(str(target) + s).exists() for s in ("-wal", "-shm", "-journal")):
        raise RuntimeError("Never overwrite an existing QA seed or its sidecars")
    original_hash = digest(source)
    uri = "file:" + source.resolve().as_posix() + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as before:
        before.execute("PRAGMA query_only=ON")
        if before.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise RuntimeError("Bundled seed integrity failed")
        for table in BUSINESS:
            if before.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]:
                raise RuntimeError(f"Bundled seed contains pharmacy business history in {table}")
        original_owners = before.execute(
            "SELECT CAST(id AS TEXT),username,role,COALESCE(is_active,1),pharmacy_id "
            "FROM users"
        ).fetchall()
        if original_owners != [("admin", "admin", "owner", 1, None)]:
            raise RuntimeError("Reference seed no longer has one unscoped bootstrap owner")
        # Distinct, new OS file; SQLx migrations and owner enrollment happen
        # only in a separately licensed, disposable Tauri identity at launch.
        with sqlite3.connect(target) as candidate:
            before.backup(candidate)
            candidate.execute("PRAGMA journal_mode=DELETE")
            with candidate:
                result = candidate.execute(
                    "UPDATE users SET pharmacy_id='primary_pharmacy', password_hash=NULL "
                    "WHERE id='admin' AND role='owner' AND is_active=1 AND pharmacy_id IS NULL"
                )
                if result.rowcount != 1:
                    raise RuntimeError("QA owner seed count changed")
            if candidate.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise RuntimeError("Synthetic copy failed integrity check")
            if candidate.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise RuntimeError("Synthetic copy failed foreign keys")
            for table in BUSINESS:
                if candidate.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]:
                    raise RuntimeError("QA seed gained pharmacy history unexpectedly")
    if digest(source) != original_hash:
        raise RuntimeError("Bundled original seed changed during QA preparation")
    return {
        "status": "SYNTHETIC_QA_SEED_ONLY",
        "source_sha256_unchanged": original_hash,
        "qa_seed_sha256": digest(target),
        "customer_history_rows": 0,
        "owner_password_enrolled": False,
        "license_provisioned": False,
        "production_or_customer_upgrade": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--debug-dir", type=Path, required=True)
    args = parser.parse_args()
    import json
    print(json.dumps(prepare(args.debug_dir), sort_keys=True))


if __name__ == "__main__":
    main()
