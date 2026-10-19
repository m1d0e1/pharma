"""Read-only real-history primary_pharmacy RBAC continuity audit, not login.

Compares genuine v0.2.109 users on a pinned current-history copy against the
isolated 029→067→primary_pharmacy stage. Preserves identities, inactive flags,
role permissions and sealed 032/052 audit without impersonating any owner.
No historic finance/tenant access is granted by this checker.
"""
from __future__ import annotations

from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys

from scripts.qa_v02110_current_installed_snapshot import INSTALLED_SHA
from scripts.qa_v02110_current_forward_sql_rehearsal import digest_file
from scripts.qa_v02110_one_tenant_permission_preview import (
    PERMISSIONS, summarize_users,
)
from scripts.qa_v02110_primary_pharmacy_migration import (
    DATABASE_NAME, STAGE_PREFIX, TENANT,
)


def _checked(path: Path, expected: str) -> bytes:
    if not path.is_file() or path.is_symlink():
        raise ValueError("Detached stage missing")
    for suffix in ("-wal", "-shm", "-journal"):
        if Path(str(path) + suffix).exists():
            raise ValueError("Detached candidate must not have SQLite sidecars")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError("Immutable stage checksum mismatch")
    return raw


def audit(original: Path, candidate: Path) -> dict:
    root = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
    if (original.name != "current-v02109-offline-source.sqlite3"
            or not original.parent.name.startswith("pharma-v02110-current-installed-offline-")
            or candidate.name != DATABASE_NAME
            or not candidate.parent.name.startswith(STAGE_PREFIX)
            or original.parent.parent.resolve(strict=True) != root.resolve(strict=True)
            or candidate.parent.parent.resolve(strict=True) != root.resolve(strict=True)):
        raise ValueError("Only designated current disposable source and tenant candidate")
    stage_report = json.loads((candidate.parent / "STAGED_SCOPE_AUDIT.json").read_text(encoding="utf8"))
    candidate_sha = stage_report["candidate_sha256"]
    source_sha = stage_report["source_sha256"]
    if (stage_report.get("proposed_scope") != TENANT
            or stage_report["verification"]["scoped_literals_originals_archived"] != 7567
            or stage_report["verification"]["original_032_052_user_rows_escrowed"] != 4
            or stage_report.get("native_authentication_or_authorization_approved") is not False):
        raise ValueError("Single-pharmacy audit marker absent")
    old_bytes, new_bytes = _checked(original, INSTALLED_SHA), _checked(candidate, candidate_sha)
    with closing(sqlite3.connect(":memory:")) as before, closing(sqlite3.connect(":memory:")) as after:
        before.deserialize(old_bytes)
        after.deserialize(new_bytes)
        before.execute("PRAGMA query_only=ON")
        after.execute("PRAGMA query_only=ON")
        columns = ["id", "username", "full_name", "role", "is_active", "permissions"]
        select = ",".join('"' + c + '"' for c in columns)
        old_users = before.execute(f"SELECT {select} FROM users ORDER BY rowid").fetchall()
        new_users = after.execute(f"SELECT {select} FROM users ORDER BY rowid").fetchall()
        if len(old_users) != 4 or old_users != new_users:
            raise ValueError("Original original user identity/role/permissions/activation drift")
        if sum(str(row[3]).lower() == "owner" and row[4] == 1 for row in old_users) != 1:
            raise ValueError("Expected exactly one historically active owner")
        if sum(row[4] == 1 for row in old_users) != 3:
            raise ValueError("Expected three active and one inactive original users")
        if after.execute("SELECT COUNT(*) FROM users WHERE pharmacy_id=?", (TENANT,)).fetchone()[0] != 4:
            raise ValueError("Every real original user must map to permanent primary_pharmacy")
        if after.execute("SELECT COUNT(*) FROM users WHERE pharmacy_id IS NULL OR pharmacy_id<>?", (TENANT,)).fetchone()[0]:
            raise ValueError("Named user scopes outside primary_pharmacy remain")
        perms_before = summarize_users([(r[3], r[4], None, r[5]) for r in old_users])
        perms_after = summarize_users([(r[3], r[4], TENANT, r[5]) for r in new_users])
        if (perms_before["active_users_by_role"] != perms_after["active_users_by_role"]
                or perms_before["active_users_with_capability_if_correctly_enrolled"]
                != perms_after["active_users_with_capability_if_correctly_enrolled"]):
            raise ValueError("Historical permissions changed by tenant mapping")
        archived = after.execute(
            "SELECT COUNT(*) FROM qa_sealed_032_052_user_originals").fetchone()[0]
        if archived != 4 or after.execute(
            "SELECT phase, proposed_tenant, source_sha256 FROM qa_primary_scope_meta"
        ).fetchall() != [("NORMALIZED", TENANT, source_sha)]:
            raise ValueError("Original identity escrow or mapped-phase witness incomplete")
        old_hashes = before.execute("SELECT id,password_hash FROM users ORDER BY rowid").fetchall()
        current_hashes = after.execute("SELECT id,password_hash FROM users ORDER BY rowid").fetchall()
        if len(old_hashes) != len(current_hashes):
            raise ValueError("Unexpected user authentication identity count")
        changed_owner_hashes = sum(a[1] != b[1] for a, b in zip(old_hashes, current_hashes))
        if changed_owner_hashes != 1:
            raise ValueError("Owner hash must only change under sealed migration 032")
        # A mapped user does not acquire additional privileges by mapping alone.
        return {
            "status": "CURRENT_REAL_HISTORY_PRIMARY_PHARMACY_ORIGINAL_RBAC_PRESERVED",
            "source_sha256": INSTALLED_SHA,
            "mapped_qa_sha256": candidate_sha,
            "native_v67_source_sha256": source_sha,
            "permanent_tenant": TENANT,
            "original_users": len(old_users),
            "active_original_owner": 1,
            "active_original_users": 3,
            "inactive_original_users_unchanged": 1,
            "all_original_user_scopes_mapped": True,
            "original_actor_roles_and_permissions_preserved": True,
            "original_permission_keys_checked": len(PERMISSIONS),
            "all_original_credentials_restored": False,
            "original_owner_public_credential_not_reactivated": True,
            "immutable_032_052_owner_originals_escrowed": archived,
            "native_authentication_verified": False,
            "staff_permission_boundary_native_gui_verified": False,
            "production_ready": False,
        }


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Original disposable v29 and physical mapped QA stage required")
        print(json.dumps(audit(Path(sys.argv[1]), Path(sys.argv[2])), sort_keys=True))
    except (ValueError, KeyError, OSError, sqlite3.Error):
        print("REFUSED primary_pharmacy original RBAC continuity", file=sys.stderr)
        raise SystemExit(2)
