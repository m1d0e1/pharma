"""End-to-end real-history reversibility/idempotence on a NEW disposable clone.

Uses actual 67-migrated current installation history, but NEVER the installed
v29 profile or any retained pinned source as a writer. This exercises the
scope ledger, complete physical typed values, trigger/FTS/FK restoration,
full rollback, re-normalization, and repeat no-op. Not auth, finance posting or
installer rollback acceptance.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

from scripts.qa_v02110_primary_pharmacy_migration import TENANT, run, Refused, digest


CURRENT_SOURCE = (
    Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
    / "pharma-v02110-current-v67-sql-rehearsal-7fe5928a6d9b4d45a7a86478946b0778"
    / "current-v02109-to-v67-SQL-ONLY-NOT-AUTHORIZED.sqlite3"
)
CURRENT_SHA = "12c7ef65c8c89ac473b309221c462f71589ce1bcca4ae928b0aaf430999f9880"
V29_SHA = "4db10f4785780451adf8c56fe1428f65b947f89505c7e861a387c5072c8ee197"


def assert_action(result: dict, phase: str, rows: int) -> None:
    if (
        result["verification"]["phase"] != phase
        or result["rows_changed_this_action"] != rows
        or result["verification"]["all_original_physical_rows_typed_verified"] != 289_816
        or result["verification"]["scoped_literals_originals_archived"] != 7_567
        or result["verification"]["original_032_052_user_rows_escrowed"] != 4
        or result["verification"]["foreign_keys_and_integrity_verified"] is not True
        or result["source_sha256"] != CURRENT_SHA
        or result["proposed_scope"] != TENANT
        or result["installed_customer_profile_mutations"] != 0
    ):
        raise Refused("Real-history disposition failed typed/reversible custody invariants")


def exercise() -> dict:
    if digest(CURRENT_SOURCE) != CURRENT_SHA:
        raise Refused("Current native v67 offline source is not byte pinned")
    kwargs = {"source": CURRENT_SOURCE, "source_sha256": CURRENT_SHA}
    staged = run("stage", **kwargs)
    candidate = staged["candidate"]
    folder = Path(staged["stage"])
    assert_action(staged, "NORMALIZED", 7_567)
    audit_before = run("audit", folder=folder, **kwargs)
    assert_action(audit_before, "NORMALIZED", 0)
    rolled_back = run("rollback", folder=folder, **kwargs)
    assert_action(rolled_back, "ROLLED_BACK", 7_567)
    rollback_audit = run("audit", folder=folder, **kwargs)
    assert_action(rollback_audit, "ROLLED_BACK", 0)
    normalized = run("normalize", folder=folder, **kwargs)
    assert_action(normalized, "NORMALIZED", 7_567)
    repeat = run("normalize", folder=folder, **kwargs)
    assert_action(repeat, "NORMALIZED", 0)
    final = run("audit", folder=folder, **kwargs)
    assert_action(final, "NORMALIZED", 0)
    if digest(CURRENT_SOURCE) != CURRENT_SHA:
        raise Refused("Current v67 source changed during isolated recovery cycle")
    return {
        "status": "PASS_CURRENT_REAL_HISTORY_PRIMARY_PHARMACY_REVERSIBLE_IDEMPOTENT",
        "source_immutable_current_v67_sha256": CURRENT_SHA,
        "current_installed_v29_before_snapshot_sha256": V29_SHA,
        "primary_tenant": TENANT,
        "disposable_candidate_path": candidate,
        "final_disposable_candidate_sha256": final["candidate_sha256"],
        "original_scope_cells_roundtrip": 7_567,
        "original_physical_typed_rows_every_phase": 289_816,
        "original_user_identity_escrow_rows": 4,
        "rollback_restore_all_original_scope_literals": True,
        "native_triggers_fts_financial_facts_verified": True,
        "repeat_normalize_financial_or_scope_writes": 0,
        "live_customer_profile_writes": 0,
        "historical_customer_gui_authenticated": False,
        "installer_rollback_tested": False,
        "ready_for_production": False,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(exercise(), sort_keys=True))
    except (OSError, KeyError, ValueError, Refused) as exc:
        print("REFUSED real-history disposable recovery cycle: " + str(exc), file=sys.stderr)
        raise SystemExit(2)
