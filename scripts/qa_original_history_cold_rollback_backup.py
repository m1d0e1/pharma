"""Make and verify a private, read-only cold rollback copy of the *current* v29.

Does not open the installed SQLite file with SQLite, checkpoint it, alter
the live app profile or grant historical owner/finance/release authorization.
Refuses while the pharmacy executable runs or while WAL/journal sidecars exist.
The resulting copy is a retained original-data recovery source, NOT an installer.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid

from scripts import owner_first_enrollment as custody
from scripts import qa_original_history_live_sequence_rebase as rebase
from scripts import qa_original_history_preinstall_gate as gate
from scripts import qa_v02110_primary_pharmacy_migration as guard


PREFIX = "pharma-v02110-current-v29-cold-rollback-"
NAME = "CURRENT_V29_COLD_ROLLBACK.sqlite3"
MANIFEST = "CURRENT_V29_COLD_ROLLBACK.json"
TOKEN = re.compile(r"[0-9a-f]{32}\Z")


class Refused(ValueError):
    pass


def _process_absent() -> None:
    custody._require_windows()
    try:
        import psutil
    except ImportError as exc:
        raise Refused("Reliable process inventory is required for a cold backup") from exc
    try:
        for process in psutil.process_iter(attrs=["name"]):
            if (process.info.get("name") or "").casefold() == "pharma.exe":
                raise Refused("Stop PHARMA before making a cold rollback backup")
    except (psutil.Error, OSError) as exc:
        raise Refused("Unable to prove application process shutdown") from exc


def _fingerprint_raw() -> tuple[bytes, dict]:
    _process_absent()
    original = Path(os.environ["APPDATA"]) / gate.HISTORY_QA_IDENTIFIER / "pharma_local.db"
    if not gate._pinned_source(original):
        raise Refused("Protected v29 original custody source was not validated")
    live = rebase._live_os_bytes_stable()
    with closing(rebase._ram(original.read_bytes())) as archived, \
         closing(rebase._ram(live)) as current:
        witness = rebase.compare_business_identical(archived, current)
    if witness["original_business_and_physical_history_rows_equal"] != 289753:
        raise Refused("Current v29 historical physical census unexpectedly differs")
    if hashlib.sha256(rebase._live_os_bytes_stable()).digest() != hashlib.sha256(live).digest():
        raise Refused("Installed v29 changed while inspecting for backup")
    _process_absent()
    return live, witness


def _target(token: str) -> tuple[Path, Path]:
    if not TOKEN.fullmatch(token):
        raise Refused("Malformed cold-rollback token")
    root = guard.disposable_root()
    custody._no_reparse(root)
    directory = root / (PREFIX + token)
    if directory.parent != root or not directory.is_dir() or directory.is_symlink():
        raise Refused("Cold rollback is outside the owner-only recovery namespace")
    custody._no_reparse(directory)
    custody._private_acl(directory, set_restriction=False)
    return root, directory


def verify_token(token: str) -> dict:
    root, directory = _target(token)
    source = directory / NAME
    metadata_path = directory / MANIFEST
    custody._no_reparse(metadata_path)
    if (not metadata_path.is_file() or metadata_path.is_symlink()
            or metadata_path.stat().st_nlink != 1
            or not 200 < metadata_path.stat().st_size < 4096):
        raise Refused("Recovery metadata is malformed")
    custody._private_acl(metadata_path, set_restriction=False)
    metadata = json.loads(metadata_path.read_bytes())
    if (not isinstance(metadata, dict)
            or set(metadata) != {"status", "v29_sha256", "account_cursor",
                                 "typed_history_rows", "production_approved"}
            or metadata.get("status") != "UNACCEPTED_CURRENT_V29_COLD_ROLLBACK"
            or metadata.get("production_approved") is not False
            or type(metadata.get("account_cursor")) is not int
            or metadata.get("typed_history_rows") != 289753
            or not isinstance(metadata.get("v29_sha256"), str)
            or not guard.SHA.fullmatch(metadata["v29_sha256"])):
        raise Refused("Recovery metadata cannot authorize historical import")
    raw, fingerprint = custody._capture(source, metadata["v29_sha256"], root)
    with closing(rebase._ram(raw)) as db:
        if (db.execute("SELECT COUNT(*),MAX(version) FROM _sqlx_migrations").fetchone()
                != (29, 29)
                or db.execute("SELECT seq FROM sqlite_sequence WHERE name='accounts'").fetchone()
                != (metadata["account_cursor"],)):
            raise Refused("Recovery copy is not a valid current native v29 database")
    live, witness = _fingerprint_raw()
    if (hashlib.sha256(live).hexdigest() != metadata["v29_sha256"]
            or witness["live_accounts_sequence"] != metadata["account_cursor"]):
        raise Refused("Stored rollback differs from current installed v29 source")
    custody._unchanged(source, metadata["v29_sha256"], fingerprint, root)
    return {"status": "PASS_PRIVATE_CURRENT_V29_COLD_ROLLBACK_UNACCEPTED",
            "current_v29_sha256": metadata["v29_sha256"],
            "current_accounts_cursor": metadata["account_cursor"],
            "typed_historical_rows": 289753,
            "owner_authenticated": False,
            "production_approved": False,
            "installed_profile_written": False}


def exercise() -> dict:
    live, witness = _fingerprint_raw()
    root = guard.disposable_root()
    token = uuid.uuid4().hex
    folder = root / (PREFIX + token)
    custody._no_reparse(root)
    folder.mkdir(mode=0o700)
    custody._private_acl(folder)
    digest = hashlib.sha256(live).hexdigest()
    custody._exclusive_file(folder / NAME, live)
    manifest = {
        "status": "UNACCEPTED_CURRENT_V29_COLD_ROLLBACK",
        "v29_sha256": digest,
        "account_cursor": witness["live_accounts_sequence"],
        "typed_history_rows": witness["original_business_and_physical_history_rows_equal"],
        "production_approved": False,
    }
    custody._exclusive_file(folder / MANIFEST,
                            (json.dumps(manifest, sort_keys=True) + "\n").encode("ascii"))
    verified = verify_token(token)
    verified["rollback_directory"] = str(folder)
    verified["rollback_token"] = token
    return verified


def main() -> int:
    try:
        custody._require_windows()
        if len(sys.argv) == 3 and sys.argv[1] == "--verify-token":
            result = verify_token(sys.argv[2])
        elif len(sys.argv) == 1:
            result = exercise()
        else:
            raise Refused("Unsupported cold rollback operation")
        print(json.dumps(result, sort_keys=True))
        return 0
    except (Refused, custody.Refused, rebase.Refused, guard.Refused, OSError,
            sqlite3.Error, ValueError, KeyError, TypeError):
        print(json.dumps({"status": "REFUSED_CURRENT_V29_COLD_ROLLBACK"}),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
