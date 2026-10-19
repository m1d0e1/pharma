"""Provision a NEW, unclaimed native QA profile from an explicitly pinned SQLite source.

All database work is against a private staged copy made with SQLite backup().
Source is URI mode=ro/query_only, historical IDs and tenant IDs stay unchanged.
Never targets an existing AppData identity, source DB, QA DB, or production seed.

Examples (in a disposable test folder; do NOT use existing QA AppData):
    python -B -m scripts.qa_lifecycle_fixture create --source X.db \
        --source-sha256 <64hex> --profile-parent <empty-or-existing-parent>
    python -B -m scripts.qa_lifecycle_fixture verify --profile-parent <parent>

Native login additionally requires an independently licensed binary for this
exact app identifier, a valid existing canonical owner's enrollment, and an
explicitly provisioned bcrypt credential for the new test actor. This tool
does not mint native receipts, impersonate operators, or bypass license/auth.
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
import tempfile


APP_ID = "com.pharma.disposable.lifecycle.qa20261016"
TENANT_ID = "qa_lifecycle_20261016"
ACTOR_ID = "qa_lifecycle_owner_20261016"
ACTOR_USERNAME = "qa_lifecycle_owner_20261016"
DATABASE = "pharma_local.db"
MANIFEST = "fixture-provenance.json"
SQLITE_HEADER = b"SQLite format 3\x00"

# These financial/historical tables MUST NOT be rewritten, backfilled, or
# assigned to the new actor/tenant. The global supplier directory is shared.
HISTORY = (
    "inventory", "patients", "sales_invoices", "sales_items", "returns",
    "purchase_invoices", "purchase_invoice_items", "purchase_returns",
    "suppliers", "supplier_transactions", "shifts", "daily_journals",
    "journal_entries", "cash_movements", "financial_notices",
)
REQUIRED = ("users", "_sqlx_migrations") + HISTORY
BLOCKED_APP_IDS = frozenset((
    "com.pharma.system", "com.pharma.disposable.qa20261015renewable",
    "com.pharma.disposable.qa20261014bg", "com.pharma.disposable.qa20261014b",
    "com.pharma.disposable.qa20261014c", "com.pharma.licenseqaonline",
    "com.pharma.educationalcloudqa",
))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_plain_path(path: Path, *, exists: bool) -> Path:
    """Reject symlinks/junctions and lexical traversal, including ancestors."""
    absolute = Path(os.path.abspath(path))
    if path.is_symlink() or (exists and not absolute.exists()):
        raise ValueError("Unexpected symlink or missing path")
    if exists and not absolute.exists():
        raise ValueError(f"Missing source/destination parent: {absolute}")
    # Windows: a junction may not report is_symlink() on older Python.
    resolved = absolute.resolve(strict=exists)
    if os.path.normcase(str(resolved)) != os.path.normcase(str(absolute)):
        raise ValueError("Filesystem alias/junction is disallowed")
    return absolute


def preflight(source_path: Path, parent_path: Path, expected_sha256: str) -> tuple[Path, Path]:
    if not re.fullmatch(r"[a-fA-F0-9]{64}", expected_sha256):
        raise ValueError("A 64-character pinned source SHA-256 is required")
    source = ensure_plain_path(source_path, exists=True)
    parent = ensure_plain_path(parent_path, exists=True)
    if not source.is_file() or not parent.is_dir():
        raise ValueError("Source must be a file and destination parent a directory")
    with source.open("rb") as input_stream:
        header = input_stream.read(len(SQLITE_HEADER))
    if header != SQLITE_HEADER:
        raise ValueError("Source is not a SQLite database")
    repository = Path(__file__).resolve().parents[1]
    if parent == repository or repository in parent.parents:
        raise ValueError("QA profile must not be created inside the repository")
    if any(part.lower() in BLOCKED_APP_IDS | {APP_ID} for part in parent.parts):
        raise ValueError("QA profile cannot be nested under a production or existing QA identity")
    if parent == source.parent or source == parent / APP_ID / DATABASE:
        raise ValueError("Fixture destination aliases the source directory")
    if (parent / APP_ID).exists() or (parent / APP_ID).is_symlink():
        raise FileExistsError("Refusing to overwrite/reuse an existing QA profile")
    if APP_ID in BLOCKED_APP_IDS:
        raise ValueError("QA identity collides with an existing application")
    if sha256(source).lower() != expected_sha256.lower():
        raise ValueError("Source hash does not match pinned input")
    return source, parent


def readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=10)
    connection.execute("PRAGMA query_only=ON")
    return connection


def check_source(connection: sqlite3.Connection) -> dict:
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    missing = sorted(set(REQUIRED) - tables)
    if missing:
        raise ValueError("Missing required native source tables: " + ", ".join(missing))
    if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise ValueError("Source quick_check failed")
    if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise ValueError("Source foreign keys are inconsistent")
    migrations = connection.execute("SELECT COUNT(*), MAX(version) FROM _sqlx_migrations WHERE success=1").fetchone()
    if migrations[0] < 54 or (migrations[1] or 0) < 54:
        raise ValueError("Source is not a migrated native QA database (minimum migration 054)")
    if connection.execute("SELECT 1 FROM users WHERE id=? OR username=?", (ACTOR_ID, ACTOR_USERNAME)).fetchone():
        raise ValueError("The disposable fixture actor already exists in source")
    counts = {table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
              for table in HISTORY}
    return {"migration_count": migrations[0], "max_migration": migrations[1], "history_counts": counts}


def history_digests(connection: sqlite3.Connection) -> dict[str, str]:
    # Canonical ordered serialization hashes even shared/unowned legacy rows;
    # no actual patient/financial values are exported into provenance JSON.
    result = {}
    for table in HISTORY:
        digest = hashlib.sha256()
        for row in connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid'):
            digest.update(json.dumps(row, ensure_ascii=False, separators=(",", ":"),
                                     default=str).encode("utf-8"))
            digest.update(b"\n")
        result[table] = digest.hexdigest()
    return result


def verify_fixture(profile_parent: Path) -> dict:
    parent = ensure_plain_path(profile_parent, exists=True)
    profile = ensure_plain_path(parent / APP_ID, exists=True)
    data_path = ensure_plain_path(profile / DATABASE, exists=True)
    metadata_path = ensure_plain_path(profile / MANIFEST, exists=True)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("app_id") != APP_ID or metadata.get("synthetic_tenant") != TENANT_ID:
        raise ValueError("Wrong QA app/tenant provenance")
    if metadata.get("profile_sha256") != sha256(data_path):
        raise ValueError("QA fixture database differs from sealed provenance")
    with closing(readonly(data_path)) as clone:
        if clone.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("QA fixture integrity_check failed")
        if clone.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise ValueError("QA fixture foreign-key check failed")
        if history_digests(clone) != metadata["history_sha256"]:
            raise ValueError("Source history or original tenant identity changed in QA profile")
        user = clone.execute(
            "SELECT id,username,role,pharmacy_id,password_hash FROM users WHERE id=?", (ACTOR_ID,)
        ).fetchone()
        if not user or user[:4] != (ACTOR_ID, ACTOR_USERNAME, "owner", TENANT_ID):
            raise ValueError("Independent QA actor/tenant identity mismatch")
        if bool(user[4]) != bool(metadata["actor_bcrypt_provisioned"]):
            raise ValueError("Actor credential provisioning changed")
    return {"status": "PASS", "app_id": APP_ID, "profile": str(profile),
            "profile_sha256": metadata["profile_sha256"], "tenant": TENANT_ID,
            "history_counts": metadata["history_counts"],
            "source_sha256": metadata["source_file_sha256"],
            "actor_login_ready": metadata["actor_login_ready"],
            "source_read_only": True}


def create_fixture(source_path: Path, profile_parent: Path, expected_sha256: str,
                   *, allow_history: bool = False, actor_bcrypt_env: str | None = None) -> dict:
    source, parent = preflight(source_path, profile_parent, expected_sha256)
    bcrypt_hash = os.environ.get(actor_bcrypt_env, "") if actor_bcrypt_env else ""
    if actor_bcrypt_env and not re.fullmatch(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}", bcrypt_hash):
        raise ValueError("Actor bcrypt env var must supply an independently generated bcrypt hash")
    with closing(readonly(source)) as src:
        analysis = check_source(src)
        if not allow_history and any(analysis["history_counts"].values()):
            raise ValueError("Nonempty business history requires explicit --allow-history consent")
        # Nothing under the final Tauri identity exists before validation.
        with tempfile.TemporaryDirectory(prefix="._pharma_lifecycle_staging_", dir=parent) as stage:
            stage_path = Path(stage)
            destination = stage_path / DATABASE
            with closing(sqlite3.connect(destination)) as copy:
                src.backup(copy)
                if copy.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError("SQLite backup consistency check failed")
                copy.execute("PRAGMA journal_mode=DELETE")
                before = history_digests(copy)
                if analysis["history_counts"] != check_source(copy)["history_counts"]:
                    raise ValueError("SQLite backup did not preserve history counts")
                copy.execute("PRAGMA foreign_keys=ON")
                with copy:
                    copy.execute(
                        "INSERT INTO users(id,username,role,full_name,pharmacy_id,permissions,password_hash,is_active) "
                        "VALUES (?,?,?,?,?,?,?,1)",
                        (ACTOR_ID, ACTOR_USERNAME, "owner", "Disposable lifecycle QA owner", TENANT_ID,
                         "{}", bcrypt_hash or None),
                    )
                if copy.execute("PRAGMA foreign_key_check").fetchone() is not None:
                    raise ValueError("Disposable actor broke foreign keys")
                if history_digests(copy) != before:
                    raise ValueError("Historical tenant, supplier or financial records were changed")
                if copy.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError("Disposable profile integrity check failed")
                # Native owner enrollment refers to canonical 'admin'. Never
                # rewrite/reassign that historical actor just to make QA work.
                original_admin = copy.execute(
                    "SELECT role,password_hash FROM users WHERE id='admin'"
                ).fetchone()
                admin_enrolled = not (original_admin and original_admin[0] == "owner"
                                      and not original_admin[1])
            if sha256(source).lower() != expected_sha256.lower():
                raise ValueError("Pinned source changed during backup; refuse promotion")
            metadata = {
                "schema": "pharma.disposable.lifecycle.fixture.v1",
                "app_id": APP_ID, "test_only": True, "synthetic_tenant": TENANT_ID,
                "synthetic_actor": ACTOR_ID, "actor_bcrypt_provisioned": bool(bcrypt_hash),
                # Native may reject a historically seeded/public admin hash or
                # detect owner-scope review conditions not provable offline.
                # Never assert that the new actor can log in without native.
                "actor_login_ready": False,
                "actor_password_and_canonical_owner_preflight": bool(bcrypt_hash and admin_enrolled),
                "native_auth_and_license_not_bypassed": True,
                "native_financial_receipts_seeded": False,
                "source_read_only_via_sqlite_uri": True, "copy_method": "sqlite3.Connection.backup",
                "source_file_sha256": sha256(source).lower(),
                "source_file_path": str(source),
                "migration_count": analysis["migration_count"],
                "max_migration": analysis["max_migration"],
                "history_counts": analysis["history_counts"], "history_sha256": before,
                "profile_sha256": sha256(destination),
            }
            with (stage_path / MANIFEST).open("x", encoding="utf-8") as output:
                json.dump(metadata, output, ensure_ascii=False, indent=2, sort_keys=True)
                output.write("\n")
            # Atomic promotion, never replacing an old identity or staging DB.
            if (parent / APP_ID).exists():
                raise FileExistsError("QA identity appeared during build; refusing replacement")
            stage_path.rename(parent / APP_ID)
    return verify_fixture(parent)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Independent, disposable Pharma lifecycle native QA profile")
    parser.add_argument("command", choices=("create", "verify"))
    parser.add_argument("--profile-parent", type=Path, required=True,
                        help="Explicit existing parent; create only the brand-new app ID child")
    parser.add_argument("--source", type=Path, help="Explicit trusted migrated SQLite source, read-only")
    parser.add_argument("--source-sha256", help="Pinned SHA-256 for source file (mandatory for create)")
    parser.add_argument("--allow-history", action="store_true",
                        help="Explicit consent to copy sensitive historical financial/patient rows")
    parser.add_argument("--actor-bcrypt-env", help="Env var containing precomputed test-only bcrypt hash")
    args = parser.parse_args(argv)
    try:
        if args.command == "create":
            if args.source is None or args.source_sha256 is None:
                parser.error("create requires --source and --source-sha256")
            result = create_fixture(args.source, args.profile_parent, args.source_sha256,
                                    allow_history=args.allow_history, actor_bcrypt_env=args.actor_bcrypt_env)
        else:
            result = verify_fixture(args.profile_parent)
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        return 0
    except (ValueError, OSError, sqlite3.Error, KeyError) as error:
        print(json.dumps({"status": "FAIL", "reason": str(error), "profile_modified": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
