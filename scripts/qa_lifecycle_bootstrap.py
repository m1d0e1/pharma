"""One-time disposable QA tenant/password bootstrap, never a production user tool.

Creates a private DPAPI-wrapped synthetic credential and a fresh AppData profile
only after a SHA-pinned read-only source preflight. The credential is never
printed, passed as a CLI argument or stored in this repository. The original
business history retains its exact tenant IDs; new actor ownership is explicit.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

from scripts.qa_lifecycle_fixture import APP_ID, create_fixture, preflight
from scripts.licensing.local_qa import protect, unprotect

SECRET_DIR = "PharmaLifecycleQA20261016Credentials"
SECRET_FILE = "qa-owner.dpapi"


def directory() -> Path:
    if os.name != "nt" or not os.environ.get("LOCALAPPDATA"):
        raise RuntimeError("Disposable QA credentials require Windows DPAPI")
    return Path(os.environ["LOCALAPPDATA"]) / SECRET_DIR


def _bcrypt(password: str) -> str:
    # The project already pins bcryptjs; Python's optional bcrypt package is
    # not a required dependency. Pass the secret on stdin, never in argv.
    js = "const fs=require('fs'),b=require('bcryptjs');const p=fs.readFileSync(0,'utf8');process.stdout.write(b.hashSync(p,12));"
    result = subprocess.run(["node", "-e", js], input=password, text=True,
                            capture_output=True, cwd=Path(__file__).resolve().parents[1],
                            check=True, timeout=30)
    if result.stderr or not result.stdout.startswith(("$2a$12$", "$2b$12$")) or len(result.stdout) != 60:
        raise RuntimeError("Synthetic actor bcrypt creation failed")
    return result.stdout


def bootstrap(source: Path, pin: str, parent: Path) -> dict:
    preflight(source, parent, pin)
    private = directory()
    if private.exists() or private.is_symlink():
        raise FileExistsError("Disposable lifecycle credentials already exist; refuse reuse")
    password = "LQa!8Z" + secrets.token_urlsafe(30)
    digest = _bcrypt(password)
    private.mkdir(parents=False, exist_ok=False)
    with (private / SECRET_FILE).open("xb") as stream:
        stream.write(protect(json.dumps({"app_id": APP_ID,
                                         "username": "qa_lifecycle_owner_20261016",
                                         "password": password}, separators=(",", ":")).encode("utf-8")))
        stream.flush()
        os.fsync(stream.fileno())
    os.environ["PHARMA_LIFECYCLE_TEMP_HASH"] = digest
    try:
        result = create_fixture(source, parent, pin, allow_history=True,
                                actor_bcrypt_env="PHARMA_LIFECYCLE_TEMP_HASH")
    finally:
        os.environ.pop("PHARMA_LIFECYCLE_TEMP_HASH", None)
    return {"status": result["status"], "app_id": result["app_id"],
            "profile_sha256": result["profile_sha256"],
            "source_read_only": result["source_read_only"],
            "actor_password_dpapi_sealed": True,
            "historic_rows_reassigned": False}


def load_approved_qa_credential() -> dict:
    raw = unprotect((directory() / SECRET_FILE).read_bytes())
    credential = json.loads(raw)
    if credential.get("app_id") != APP_ID:
        raise ValueError("QA credential belongs to another app identity")
    return credential


def main() -> int:
    parser = argparse.ArgumentParser(description="One-shot independently owned Windows QA profile")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--profile-parent", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        print(json.dumps(bootstrap(arguments.source, arguments.sha256, arguments.profile_parent),
                         sort_keys=True))
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        print("Disposable lifecycle bootstrap refused operation: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
