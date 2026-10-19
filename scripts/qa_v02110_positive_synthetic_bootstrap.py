"""Provision an isolated, *new* one-owner/one-tenant QA schema, never customer history.

Uses the exact 001..067 SQL of this checkout, plus SQLx SHA-384 checksums.
The only historic credential introduced by 001 is deliberately discarded in
this entirely new SYNTHETIC fixture. A fresh, random owner password is sent
through Node bcrypt on stdin and kept only in Windows CurrentUser DPAPI state.
No source/installed/archive database is opened or read by this script.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import sys
import uuid
from contextlib import closing

from scripts.licensing.local_qa import protect, unprotect


IDENTITY = "com.pharma.disposable.positiveqa20261018"
TENANT = "qa_positive_20261018"
ACTOR = "qa_positive_owner_20261018"
SECRET_FOLDER = "PharmaPositiveQA20261018Credentials"
SECRET_FILENAME = "owner.dpapi"


def _schema_paths(root: Path) -> list[Path]:
    files = sorted((root / "src-tauri" / "migrations").glob("[0-9][0-9][0-9]_*.sql"))
    if len(files) != 67 or [int(f.name[:3]) for f in files] != list(range(1, 68)):
        raise RuntimeError("Exact native v67 migration chain required")
    if any(f.is_symlink() or not f.is_file() for f in files):
        raise RuntimeError("Migration path indirection refused")
    return files


def _bcrypt(password: str, root: Path) -> str:
    code = "const fs=require('fs'),b=require('bcryptjs');process.stdout.write(b.hashSync(fs.readFileSync(0,'utf8'),12))"
    run = subprocess.run(["node", "-e", code], input=password, text=True,
                         capture_output=True, cwd=root, check=True, timeout=40)
    if run.stderr or not re.fullmatch(r"\$2[aby]\$12\$[./A-Za-z0-9]{53}", run.stdout):
        raise RuntimeError("Isolated QA password digest invalid")
    return run.stdout


def build_fixture(root: Path, appdata: Path, localappdata: Path) -> dict:
    if os.name != "nt" or not appdata.is_dir() or not localappdata.is_dir():
        raise RuntimeError("Windows AppData and CurrentUser DPAPI required")
    if root.is_symlink() or appdata.is_symlink() or localappdata.is_symlink():
        raise RuntimeError("Source/profile symlink not approved")
    profile = appdata / IDENTITY
    protected = localappdata / SECRET_FOLDER
    if any(p.exists() or p.is_symlink() for p in (profile, protected)):
        raise FileExistsError("Synthetic QA identity/credential already exists; refuse reuse")
    paths = _schema_paths(root)
    password = "PQa!8Z" + secrets.token_urlsafe(30)
    digest = _bcrypt(password, root)
    # No source pharmacy file is used: all rows here are new synthetic data.
    stage = appdata / ("pharma-positiveqa-staging-" + uuid.uuid4().hex)
    stage.mkdir(mode=0o700)
    temporary = stage / "pharma_local.db"
    try:
        with closing(sqlite3.connect(temporary)) as db:
            # Native SQLx creates this metadata table itself before its first
            # migration. The fixture must model that exact fresh-DB prelude.
            db.execute("""CREATE TABLE _sqlx_migrations(
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN NOT NULL,
                checksum BLOB NOT NULL,
                execution_time BIGINT NOT NULL
            )""")
            for version, path in enumerate(paths, 1):
                sql = path.read_text(encoding="utf-8")
                db.executescript(sql)
                checksum = hashlib.sha384(sql.encode("utf-8")).digest()
                db.execute(
                    "INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) "
                    "VALUES(?,?,1,?,0)", (version, path.stem[4:], checksum)
                )
                db.commit()
            users = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            if users != 1 or db.execute("SELECT id FROM users").fetchone() != ("admin",):
                raise RuntimeError("Unexpected bootstrap identity in synthetic-only fresh schema")
            # This admin row was CREATED IN THIS FUNCTION by migration 001,
            # and has no historical business data or original customer identity.
            # We do not alter a real owner's credential or tenant.
            permissions = db.execute("SELECT permissions FROM users WHERE id='admin'").fetchone()[0]
            with db:
                db.execute("DELETE FROM users WHERE id='admin'")
                db.execute("INSERT INTO users(id,username,password_hash,role,full_name,pharmacy_id,permissions,is_active) "
                           "VALUES(?,?,?,?,?,?,?,1)",
                           (ACTOR, ACTOR, digest, "owner", "Synthetic QA owner", TENANT, permissions))
            checks = {
                name: int(db.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0])
                for name in ("inventory","patients","suppliers","sales_invoices","purchase_invoices",
                             "daily_journals","journal_entries","shifts","cash_movements")
            }
            if any(checks.values()):
                raise RuntimeError("New synthetic QA schema unexpectedly has business history")
            if db.execute("PRAGMA integrity_check").fetchone() != ("ok",) \
               or db.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise RuntimeError("Synthetic QA schema inconsistent")
            if db.execute("SELECT COUNT(*) FROM _sqlx_migrations WHERE success=1").fetchone() != (67,):
                raise RuntimeError("Synthetic SQLx metadata incomplete")
            db.execute("PRAGMA journal_mode=DELETE")
        protected.mkdir(mode=0o700)
        with (protected / SECRET_FILENAME).open("xb") as file:
            file.write(protect(json.dumps({"app_id": IDENTITY, "username": ACTOR,
                                           "password": password}, separators=(",", ":")).encode()))
            file.flush()
            os.fsync(file.fileno())
        import hashlib as _hash
        sha = _hash.sha256(temporary.read_bytes()).hexdigest()
        with (stage / "source.json").open("x", encoding="utf-8") as file:
            json.dump({"app_id": IDENTITY, "version": "0.2.110", "synthetic_only": True,
                       "actor": ACTOR, "tenant": TENANT, "db_sha256": sha,
                       "historical_rows_included": False,
                       "genuine_customer_ownership_approved": False}, file)
        if profile.exists():
            raise FileExistsError("Synthetic QA profile appeared during staging")
        stage.rename(profile)
        return {"status":"SYNTHETIC_QA_PROFILE_STAGED", "qa_identity": IDENTITY,
                "synthetic_only": True, "native_schema_version":67,
                "business_rows_before_GUI": checks,
                "owner_secret_DPAPI_sealed": True,"customer_history_copied":False,
                "original_pharmacy_profile_modified":False, "qa_source_sha256":sha}
    except BaseException:
        # Deliberately never delete a partial staged database/credential: a
        # failed QA creation needs explicit manual evidence review, not retry.
        raise


def get_secret() -> dict:
    data = json.loads(unprotect((Path(os.environ["LOCALAPPDATA"]) /
                                 SECRET_FOLDER / SECRET_FILENAME).read_bytes()))
    if data.get("app_id") != IDENTITY or data.get("username") != ACTOR:
        raise RuntimeError("QA-only DPAPI secret belongs to another app")
    return data


def resume_prepared_fixture(stage_name: str, appdata: Path, localappdata: Path, root: Path) -> dict:
    """Only finish an interrupted rename, never regenerate owner/credentials."""
    if not re.fullmatch(r"pharma-positiveqa-staging-[a-f0-9]{32}", stage_name):
        raise RuntimeError("Unapproved synthetic staging folder")
    stage = appdata / stage_name
    final = appdata / IDENTITY
    if final.exists() or final.is_symlink() or not stage.is_dir() or stage.is_symlink():
        raise FileExistsError("New QA profile already exists or stage is not plain")
    secret = get_secret()
    manifest = stage / "source.json"
    source = stage / "pharma_local.db"
    if not manifest.is_file() or not source.is_file() or source.is_symlink():
        raise RuntimeError("Incomplete synthetic profile cannot be resumed")
    meta = json.loads(manifest.read_text(encoding="utf8"))
    if meta.get("app_id") != IDENTITY or meta.get("tenant") != TENANT \
       or meta.get("actor") != ACTOR or meta.get("historical_rows_included") is not False:
        raise RuntimeError("Synthetic QA manifest identity mismatch")
    sha = hashlib.sha256(source.read_bytes()).hexdigest()
    if sha != meta.get("db_sha256"):
        raise RuntimeError("Staged QA database SHA pin mismatch")
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as db:
        db.execute("PRAGMA query_only=ON")
        if db.execute("PRAGMA integrity_check").fetchone() != ("ok",) \
           or db.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise RuntimeError("Staged QA database inconsistent")
        if db.execute("SELECT COUNT(*),MIN(version),MAX(version) FROM _sqlx_migrations WHERE success=1").fetchone() != (67,1,67):
            raise RuntimeError("Unfinished synthetic SQLx ledger")
        accounts = db.execute("SELECT id,username,role,pharmacy_id,password_hash FROM users").fetchall()
        if len(accounts) != 1 or accounts[0][:4] != (ACTOR,ACTOR,"owner",TENANT):
            raise RuntimeError("Staged synthetic actor has unexpected identity")
        password_hash = accounts[0][4]
        if any(db.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0] for name in (
            "inventory","patients","suppliers","sales_invoices","purchase_invoices",
            "daily_journals","journal_entries","shifts","cash_movements")):
            raise RuntimeError("Staged synthetic history is not empty")
    check = "const fs=require('fs'),b=require('bcryptjs');const a=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(b.compareSync(a[0],a[1])?'MATCH':'DENIED')"
    verified = subprocess.run(["node", "-e", check],
                              input=json.dumps([secret["password"],password_hash]),
                              text=True, capture_output=True, cwd=root,
                              check=True, timeout=40)
    if verified.stderr or verified.stdout != "MATCH":
        raise RuntimeError("QA DPAPI secret does not belong to staged actor")
    if final.exists():
        raise FileExistsError("Synthetic QA identity appeared during review")
    stage.rename(final)
    return {"status":"VERIFIED_INTERRUPTED_QA_STAGING_RECOVERED",
            "synthetic_identity":IDENTITY,"sqlx_versions":67,
            "only_one_scoped_QA_owner":True,
            "synthetic_owner_DPAPI_secret_verified":True,
            "history_customer_records_imported":False,
            "qa_profile_sha256":sha}


if __name__ == "__main__":
    try:
        root = Path(__file__).resolve().parents[1]
        app = Path(os.environ["APPDATA"])
        local = Path(os.environ["LOCALAPPDATA"])
        if len(sys.argv) == 3 and sys.argv[1] == "--resume-prepared-stage":
            result = resume_prepared_fixture(sys.argv[2], app, local, root)
        elif len(sys.argv) == 1:
            result = build_fixture(root, app, local)
        else:
            raise RuntimeError("Only an explicit fresh or independently reviewed resume is supported")
        print(json.dumps(result, sort_keys=True))
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as err:
        print("SYNTHETIC POSITIVE QA REFUSED: " + type(err).__name__, file=sys.stderr)
        raise SystemExit(2)
