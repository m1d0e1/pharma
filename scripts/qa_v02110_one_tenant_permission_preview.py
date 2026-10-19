"""Privacy-safe one-pharmacy RBAC preview from the sealed historical source.

This is a planning aid, NOT authentication, credential enrollment, migration,
or operational permission enforcement. Source users retain original NULL scope;
real access still requires independent ownership approval, native login, active
actor, and the typed native permission checks for *each* command.

Only aggregated counts are exported. No user IDs, passwords, names, permission
JSON blobs, patient identities, supplier identities, money or historical rows.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys

from scripts.qa_v02110_one_tenant_review_packet import PIN, file_sha256, source_path_checked

# Actual fixed native permission names. Never use a generic "tenant means ALL
# privileges" switch: tenant membership and operation capability are separate.
PERMISSIONS = (
    "can_manage_inventory", "can_access_pos", "rep_can_view_sales",
    "can_view_purchases", "rep_can_view_purchases", "can_view_patients",
    "can_view_returns", "acc_can_view_general", "acc_can_make_daily_entries",
    "acc_can_process_cash_flow", "can_view_cogs", "can_view_shifts",
    "can_view_settlement", "can_view_staff_manage", "show_cost_price",
)


def decoded_permissions(raw: str | None) -> object:
    if raw is None:
        return None
    value: object = raw
    for _ in range(3):
        if not isinstance(value, str):
            break
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            return None
    return value


def can_use(role: str | None, raw: str | None, key: str) -> bool:
    """Mirror native permission_policy::user_has_permission exactly for keys."""
    normalized = (role or "").strip().lower()
    if normalized == "owner":
        return True
    decoded = decoded_permissions(raw)
    if isinstance(decoded, list):
        return key in decoded
    if isinstance(decoded, dict):
        value = decoded.get(key)
        if type(value) is bool:
            return value
        if type(value) in (int, float):
            return float(value) == 1.0
        if isinstance(value, str):
            return value.strip().lower() in ("true", "1")
        return False
    return (raw is None and key == "can_access_pos" and
            normalized in ("admin", "pharmacist", "cashier"))


def summarize_users(rows: list[tuple]) -> dict:
    roles = Counter()
    permitted = {key: 0 for key in PERMISSIONS}
    excluded = 0
    unscoped = 0
    for role, active, pharmacy, permissions in rows:
        if pharmacy is None or pharmacy == "" or pharmacy == "local_default":
            unscoped += 1
        if active != 1:
            excluded += 1
            continue
        normalized = (role or "").strip().lower()
        roles[normalized if normalized in ("owner", "admin", "pharmacist", "cashier")
              else "other"] += 1
        for key in PERMISSIONS:
            permitted[key] += int(can_use(role, permissions, key))
    return {
        "historical_user_count": len(rows),
        "active_users_by_role": dict(sorted(roles.items())),
        "inactive_accounts_excluded_from_access": excluded,
        "original_users_with_legacy_unscoped_literals": unscoped,
        "active_users_with_capability_if_correctly_enrolled": permitted,
        "original_credentials_modified": False,
        "actual_native_login_proven": False,
        "staff_automatically_upgraded_to_owner": False,
        "tenant_scope_overrides_role_permissions": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sealed-source single-pharmacy staff permission preview")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        source = source_path_checked(args.source, args.expected_sha256)
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            db.execute("PRAGMA query_only=ON")
            if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise ValueError("Source database failed integrity")
            users = db.execute("SELECT role,is_active,pharmacy_id,permissions FROM users").fetchall()
        if file_sha256(source) != PIN:
            raise ValueError("Original sealed source modified")
        output = args.output.resolve(strict=False)
        if (output.exists() or output.is_symlink() or not output.parent.is_dir()
            or output.suffix.lower() != ".json"):
            raise ValueError("Only a fresh separate report JSON is accepted")
        preview = {
            "status": "ROLE_VISIBILITY_PREVIEW_ONLY_NOT_HISTORICAL_AUTHORIZATION",
            "sealed_source_sha256": PIN,
            "historical_tenant_assigned": False,
            "independently_verified_owner_approval": False,
            "independently_verified_reviewer_approval": False,
            "can_operate_financial_writers": False,
            "permissions": summarize_users(users),
        }
        with output.open("x", encoding="utf8") as handle:
            json.dump(preview, handle, indent=2, sort_keys=True)
            handle.write("\n")
        print(json.dumps({
            "status": preview["status"], "output": str(output),
            "report_sha256": file_sha256(output),
            "users": preview["permissions"]["historical_user_count"],
            "operational_permission_verified": False,
        }, sort_keys=True))
        return 0
    except (ValueError, OSError, sqlite3.Error):
        print("One-pharmacy RBAC preview refused: sealed source or output unverified",file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
