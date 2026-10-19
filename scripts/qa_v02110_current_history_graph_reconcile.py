"""Read-only original-graph and exact typed finance reconciliation, current v29→v67.

Both files are independently pinned disposable copies of the CURRENT original
installation, not production files. They are read as OS bytes and deserialized
into memory; no SQLite disk connections, writes, checkpoints or permissions
are involved. Fixed patient/supplier/invoice relationships are compared
structurally, never treated as ownership evidence.
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

from scripts.qa_full_history_lineage import make_full_history_lineage
from scripts.qa_historical_forward_sql_drift import (
    original_table_schema, original_row_commitments, changed_id_columns,
)
from scripts.qa_v02110_current_installed_snapshot import (
    INSTALLED_SHA, no_sidecars, safe_regular,
)
from scripts.qa_v02110_current_forward_sql_rehearsal import digest_file


V67_NAME = "current-v02109-to-v67-SQL-ONLY-NOT-AUTHORIZED.sqlite3"
SCOPE = "primary_pharmacy"


def verify(source: Path, stage: Path) -> dict:
    root = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
    if (
        source.name != "current-v02109-offline-source.sqlite3"
        or stage.name != V67_NAME
        or re.fullmatch(r"pharma-v02110-current-installed-offline-[0-9a-f]{32}", source.parent.name) is None
        or re.fullmatch(r"pharma-v02110-current-v67-sql-rehearsal-[0-9a-f]{32}", stage.parent.name) is None
        or source.parent.parent.resolve(strict=True) != root.resolve(strict=True)
        or stage.parent.parent.resolve(strict=True) != root.resolve(strict=True)
    ):
        raise ValueError("Only designated current-history physical disposable stages allowed")
    for db in (source, stage):
        safe_regular(db)
        no_sidecars(db)
    manifest = json.loads((stage.parent / "OFFLINE_SQL_ONLY_NOT_AUTHORIZED.json").read_text("utf-8"))
    stage_sha = manifest.get("destination_sha256")
    if (manifest.get("source_sha256") != INSTALLED_SHA
            or manifest.get("final_sqlx_version") != 67
            or manifest.get("desired_permanent_tenant") != SCOPE
            or manifest.get("native_authentication_executed") is not False
            or manifest.get("source_disposable_current_v29") != str(source)
            or not isinstance(stage_sha, str)
            or re.fullmatch(r"[0-9a-f]{64}", stage_sha) is None):
        raise ValueError("Current forward SQL rehearsal provenance missing")
    if digest_file(source) != INSTALLED_SHA or digest_file(stage) != stage_sha:
        raise ValueError("Current source or v67 output changed since manifest")
    before_bytes, after_bytes = source.read_bytes(), stage.read_bytes()
    with closing(sqlite3.connect(":memory:")) as before, closing(sqlite3.connect(":memory:")) as after:
        before.deserialize(before_bytes)
        after.deserialize(after_bytes)
        before.execute("PRAGMA query_only=ON")
        after.execute("PRAGMA query_only=ON")
        original_tables = original_table_schema(before)
        previous = original_row_commitments(before, original_tables)
        later = original_row_commitments(after, original_tables)
        drift = sorted(t for t in original_tables if previous[t] != later[t])
        if drift != ["_sqlx_migrations", "users"]:
            raise ValueError("Unexpected original typed-data drift")
        user_changes = changed_id_columns(before, after, "users", original_tables["users"])
        if user_changes != {"password_hash": 1, "pharmacy_id": 1}:
            raise ValueError("Historical owner changed outside immutable 032/052 effects")
        graph_before = make_full_history_lineage(before)
        graph_after = make_full_history_lineage(after)
        if graph_before["fixed_relationships"] != graph_after["fixed_relationships"]:
            raise ValueError("Original historic patient/supplier/invoice graph changed")
        if graph_before["fts_catalog_candidate"] != graph_after["fts_catalog_candidate"]:
            raise ValueError("Original external FTS/catalog row linkage changed")
        source_tables = len(original_tables)
        source_rows = sum(v[0] for v in previous.values())
        if source_tables != 67 or source_rows != 289778:
            raise ValueError("Unexpected original source full-history census")
        if graph_before["coverage"]["fixed_relationships_checked"] < 39:
            raise ValueError("Historical graph mapping coverage incomplete")
        if graph_before["coverage"]["all_fixed_links_inspectable"] is not True:
            raise ValueError("Historical fixed graph uninspectable")
        exact_table_count = source_tables - len(drift)
        results = {
            "status": "CURRENT_REAL_HISTORY_V29_TO_V67_TYPED_GRAPH_RECONCILED",
            "original_physical_tables": source_tables,
            "original_typed_table_rows": source_rows,
            "unchanged_full_original_tables": exact_table_count,
            "original_tables_changed": drift,
            "original_user_changes_only": user_changes,
            "original_stock_sales_purchases_patients_suppliers_cash_accounting_rows_unchanged": True,
            "fixed_original_relationships_checked": graph_before["coverage"]["fixed_relationships_checked"],
            "original_patient_supplier_invoice_fixed_edges_exact": True,
            "original_fts_relationship_exact": True,
            "external_fts_index_contents_certified": False,
            "original_v29_sha256": INSTALLED_SHA,
            "disposable_v67_sha256": stage_sha,
            "tenant_to_be_mapped": SCOPE,
            "customer_history_access_granted": False,
            "original_owner_credential_restored": False,
            "reviewer_signature_required_by_business_model": False,
            "positive_authenticated_windows_gui_verified": False,
            "production_ready": False,
        }
    if digest_file(source) != INSTALLED_SHA or digest_file(stage) != stage_sha:
        raise ValueError("Input changed after read-only verification")
    return results


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Two exact verified disposable paths required")
        print(json.dumps(verify(Path(sys.argv[1]), Path(sys.argv[2])), sort_keys=True))
    except (ValueError, OSError, sqlite3.Error):
        print("REFUSED current v29/v67 typed-graph comparison", file=sys.stderr)
        raise SystemExit(2)
