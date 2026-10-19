"""Read-only, full-history eligibility assessment for an old one-pharmacy database.

This does NOT transfer data, establish a tenant, produce a trusted signature,
install a manifest in the app, or authorize ownership of patients or receipts.
The ONLY accepted file is an already pinned, detached historical archive in the
private preservation directory. No database writer or ordinary app profile is
opened. The output contains aggregates and commitments, never customer rows,
actors, balances, identifiers, source paths or a guessed ownership assignment.

An operational upgrade needs independent owner/second-reviewer signed grants,
matching source hashes and a complete one-to-one record graph, an approved
read-only legacy view, and separately certified financial/rollback acceptance.
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

from scripts.legacy_pharmacy_upgrade import (
    UnsafeSource, all_rows_digest, ensure, require_pin,
)
from scripts.qa_historical_archive_manifest import (
    make_manifest, quote, verified_manifest,
)
from scripts.qa_historical_archive_preflight import (
    approved_archive, digest_file, read_only_connection,
)
from scripts.qa_legacy_financial_precision_audit import financial_precision_counts
from scripts.qa_full_history_lineage import make_full_history_lineage

FORMAT = "single-pharmacy-historical-preflight-v1"
EXPLICIT_TENANT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def check_tenant(tenant_id: str) -> None:
    ensure(
        isinstance(tenant_id, str)
        and EXPLICIT_TENANT.fullmatch(tenant_id) is not None
        and tenant_id.lower() != "local_default",
        "independently_established_explicit_tenant_required",
    )


def scope_review(db: sqlite3.Connection, tenant_id: str) -> dict[str, int]:
    """Count *every* real table with a pharmacy_id; never select source IDs.

    A purported explicit other tenant, even when only one pharmacy is expected,
    is a conflict. NULL/blank/local_default remain unresolved, NOT attributed.
    This intentionally does not deduce ownership from foreign keys.
    """
    totals = dict(
        tenant_literal=0, null=0, blank=0, local_default=0,
        foreign_explicit=0, nontext=0, scoped_tables=0, unscoped_tables=0,
        unscoped_rows=0, active_legacy_owners=0, active_foreign_owners=0,
    )
    names = [row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )]
    for name in names:
        q = quote(name)
        columns = {column[1] for column in db.execute(f"PRAGMA table_info({q})")}
        if "pharmacy_id" not in columns:
            totals["unscoped_tables"] += 1
            totals["unscoped_rows"] += db.execute(
                f"SELECT COUNT(*) FROM {q}"
            ).fetchone()[0]
            continue
        counts = db.execute(
            f"""SELECT
              SUM(CASE WHEN pharmacy_id=? THEN 1 ELSE 0 END),
              SUM(CASE WHEN pharmacy_id IS NULL THEN 1 ELSE 0 END),
              SUM(CASE WHEN typeof(pharmacy_id)='text' AND trim(pharmacy_id)=''
                        THEN 1 ELSE 0 END),
              SUM(CASE WHEN typeof(pharmacy_id)='text'
                         AND lower(trim(pharmacy_id))='local_default'
                        THEN 1 ELSE 0 END),
              SUM(CASE WHEN typeof(pharmacy_id)='text'
                         AND pharmacy_id<>?
                         AND trim(pharmacy_id)<>''
                         AND lower(trim(pharmacy_id))<>'local_default'
                        THEN 1 ELSE 0 END),
              SUM(CASE WHEN pharmacy_id IS NOT NULL
                         AND typeof(pharmacy_id)<>'text' THEN 1 ELSE 0 END)
              FROM {q}""", (tenant_id, tenant_id),
        ).fetchone()
        totals["scoped_tables"] += 1
        for field, number in zip(
            ("tenant_literal", "null", "blank", "local_default",
             "foreign_explicit", "nontext"), counts,
        ):
            totals[field] += number or 0
    if "users" in names:
        columns = {c[1] for c in db.execute("PRAGMA table_info(users)")}
        if {"role", "pharmacy_id"}.issubset(columns):
            active = "COALESCE(is_active,1)=1 AND " if "is_active" in columns else ""
            owners = db.execute(
                "SELECT "
                "SUM(CASE WHEN pharmacy_id IS NULL OR trim(pharmacy_id)='' "
                "OR lower(trim(pharmacy_id))='local_default' THEN 1 ELSE 0 END),"
                "SUM(CASE WHEN pharmacy_id IS NOT NULL AND "
                "trim(pharmacy_id)<>'' AND "
                "lower(trim(pharmacy_id))<>'local_default' "
                "AND pharmacy_id<>? THEN 1 ELSE 0 END) "
                f"FROM users WHERE {active}lower(trim(coalesce(role,'')))='owner'",
                (tenant_id,),
            ).fetchone()
            totals["active_legacy_owners"] = owners[0] or 0
            totals["active_foreign_owners"] = owners[1] or 0
    return totals


def structural_findings(db: sqlite3.Connection, manifest: dict) -> dict[str, int]:
    """Separate broken source lineage from legacy accounting conventions.

    A historical negative supplier credit or a fractional journal cent may be
    legitimate legacy provenance. It requires interpretation, not fabricated
    rounding, reversal or an automatic journal/stock rewrite.
    """
    relationships = manifest["relationships"]
    broken = sum(
        details.get("missing_parent", 0) + details.get("missing_reference", 0)
        for details in relationships.values()
    )
    unbalanced = relationships["journal_structure"]["unbalanced_or_empty"]
    journal = db.execute(
        "SELECT "
        "SUM(CASE WHEN type NOT IN ('debit','credit') OR type IS NULL THEN 1 ELSE 0 END),"
        "SUM(CASE WHEN typeof(amount) NOT IN ('integer','real') THEN 1 ELSE 0 END),"
        "SUM(CASE WHEN amount<0 THEN 1 ELSE 0 END),"
        "SUM(CASE WHEN typeof(amount) IN ('integer','real') "
        "AND abs(amount*100-round(amount*100))>0.0001 "
        "THEN 1 ELSE 0 END) FROM journal_entries"
    ).fetchone()
    mismatched_stock = sum(
        details.get("literal_cross_scope", 0)
        for details in relationships.values()
    )
    invalid_numeric = sum(
        details.get("malformed_or_negative_rows", 0)
        for details in manifest["amount_shape_findings"].values()
    )
    # RELATIONSHIPS is the core sale/purchase/customer ledger graph. The
    # separately enumerated MODULE_RELATIONSHIPS includes accounts, actors,
    # catalog, returns, opening lots and stock adjustments; ignoring it would
    # make an intact sale graph appear importable despite an orphaned ledger
    # account or a missing purchase-order parent.
    module = manifest["module_source_relations"]
    module_orphans = sum(
        item.get("orphan_rows", 0) + item.get("missing_reference_rows", 0)
        for item in module.values()
    )
    module_unmapped = sum(
        item.get("source_rows_quarantined", 0)
        for item in module.values()
        if item.get("status") in (
            "missing_module_table_quarantined",
            "unmapped_legacy_column_quarantined",
        )
    )
    # An unmatched supplier invoice/ledger amount cannot be turned into a
    # synthetic historic payment. Even a matching pair only establishes a
    # structural candidate, never original owner or financial provenance.
    ledger_unmatched = module.get("supplier_invoice_ledger_candidate", {}).get(
        "source_or_amount_unmatched", 0
    )
    cash_unknown = module.get("cash_shift_literal_tenant", {}).get(
        "unknown_or_legacy_scope", 0
    )
    stock_unknown = sum(
        item.get("unverifiable_scope", 0)
        for item in relationships.values()
    )
    return {
        "broken_required_links": broken,
        "module_orphan_or_missing_parent_findings": module_orphans,
        "module_unmapped_layout_quarantined_rows": module_unmapped,
        "unbalanced_or_empty_journals": unbalanced,
        "nonstandard_journal_side": journal[0] or 0,
        "nonnumeric_journal_amount": journal[1] or 0,
        "negative_journal_amount": journal[2] or 0,
        "fractional_cent_legacy_journal_amounts": journal[3] or 0,
        "cross_scope_stock_links": mismatched_stock,
        "stock_links_with_unverified_legacy_scope": stock_unknown,
        "cash_shift_links_with_unverified_legacy_scope": cash_unknown,
        "supplier_invoice_ledger_source_or_amount_unmatched": ledger_unmatched,
        "legacy_numeric_formats_needing_review": invalid_numeric,
    }


def full_typed_graph_findings(db: sqlite3.Connection, manifest: dict) -> dict[str, int | bool]:
    """Refuse ambiguous typed IDs and FK relationships, including unscoped rows."""
    graph = make_full_history_lineage(db)
    ensure(graph["table_count"] == manifest["table_count"] and
           graph["total_table_rows_including_fts_shadows"] == manifest["all_table_rows"],
           "full_typed_graph_census_mismatch")
    edges = list(graph["fixed_relationships"].values()) + graph["declared_foreign_keys"]
    return {
        "tables_checked": graph["table_count"],
        "fixed_application_relationships_checked": graph["coverage"]["fixed_relationships_checked"],
        "declared_foreign_key_groups_checked": graph["coverage"]["declared_foreign_key_groups_checked"],
        "canonical_id_collision_rows": sum(
            t["id_key"].get("cast_text_collision_rows", 0) for t in graph["tables"]
        ),
        "null_or_blank_source_id_rows": sum(
            t["id_key"].get("null_rows", 0) + t["id_key"].get("blank_id_rows", 0)
            for t in graph["tables"]
        ),
        "noncanonical_source_id_storage_rows": sum(
            t["id_key"].get("noncanonical_storage_rows", 0) for t in graph["tables"]
        ),
        "coercion_only_parent_reference_rows": sum(
            edge.get("coercion_only_parent_rows", 0) for edge in edges
        ),
        "missing_parent_reference_findings": sum(
            edge.get("missing_parent_rows", 0) for edge in edges
        ),
        "missing_mandatory_reference_findings": sum(
            edge.get("missing_mandatory_reference_rows", 0) for edge in edges
        ),
        "partially_null_composite_reference_findings": sum(
            edge.get("partial_null_reference_rows", 0) for edge in edges
        ),
        "unmapped_source_layout_quarantined_rows": sum(
            edge.get("source_rows_quarantined", 0) for edge in edges
        ),
        "search_index_rowid_missing_catalog_rows": graph["fts_catalog_candidate"].get(
            "fts_rowid_missing_catalog_rows", 0
        ),
        "fts_search_index_contents_cryptographically_certified": False,
        "entire_record_graph_owner_authenticated": False,
    }


def assess_connection(
    db: sqlite3.Connection, *, tenant_id: str, source_sha256: str,
) -> dict:
    """Pure read-only assessment over a verified frozen or synthetic connection."""
    check_tenant(tenant_id)
    require_pin(source_sha256)
    db.execute("PRAGMA query_only=ON")
    ensure(db.execute("PRAGMA integrity_check").fetchone() == ("ok",),
           "sqlite_integrity_failed")
    ensure(db.execute("PRAGMA foreign_key_check").fetchone() is None,
           "sqlite_foreign_keys_failed")
    manifest = make_manifest(db)
    scopes = scope_review(db, tenant_id)
    defects = structural_findings(db, manifest)
    typed_graph = full_typed_graph_findings(db, manifest)
    finance_precision = financial_precision_counts(db)
    exact_rows_sha = all_rows_digest(db)
    commitment = hashlib.sha256(json.dumps(
        [FORMAT, source_sha256.lower(), tenant_id, exact_rows_sha,
         manifest["opaque_schema_coverage_sha256"]],
        ensure_ascii=False, separators=(",", ":"),
    ).encode("utf-8")).hexdigest()
    foreign = scopes["foreign_explicit"] + scopes["nontext"]
    # A legacy lot whose header already has the verified target is still
    # unresolved, not *independently disproven*, when the other literal is
    # NULL/local_default. Report cross-scope pairs for the reviewer rather than
    # incorrectly claiming a second pharmacy from a placeholder mismatch.
    broken = sum(defects.get(key, 0) for key in (
        "broken_required_links", "module_orphan_or_missing_parent_findings",
        "unbalanced_or_empty_journals",
        "nonstandard_journal_side", "nonnumeric_journal_amount",
        "negative_journal_amount",
    ))
    legacy_finance_review = (
        defects["fractional_cent_legacy_journal_amounts"]
        + defects["legacy_numeric_formats_needing_review"]
        + defects["supplier_invoice_ledger_source_or_amount_unmatched"]
        + finance_precision["journals_with_decimal_balancing_difference"]
        + finance_precision["journals_with_per_entry_cent_balancing_difference"]
        + finance_precision["journals_with_invalid_side_or_amount"]
    )
    typed_ambiguity = sum(typed_graph[key] for key in (
        "canonical_id_collision_rows", "null_or_blank_source_id_rows",
        "noncanonical_source_id_storage_rows", "coercion_only_parent_reference_rows",
        "missing_parent_reference_findings", "missing_mandatory_reference_findings",
        "partially_null_composite_reference_findings",
    ))
    # Distinguish operator's real-world single-pharmacy statement from
    # independently signed original source ownership; no auto-approval.
    classification = (
        "REFUSE_EXPLICIT_SCOPE_CONFLICT" if foreign
        else "REFUSE_BROKEN_HISTORICAL_RELATIONSHIPS" if broken
        else "REFUSE_AMBIGUOUS_TYPED_HISTORICAL_RECORD_GRAPH" if typed_ambiguity
        else "REFUSE_INCOMPLETE_HISTORICAL_MODULE_GRAPH"
            if (defects["module_unmapped_layout_quarantined_rows"]
                or typed_graph["unmapped_source_layout_quarantined_rows"])
        else "REVIEW_LEGACY_FINANCIAL_PRECISION_AND_SIGN" if legacy_finance_review
        else "CANDIDATE_AWAITING_INDEPENDENT_OWNERSHIP_PROOF"
    )
    return {
        "format": FORMAT,
        "classification": classification,
        "source_sha256_verified": False,  # outer custody layer sets true
        "all_table_rows": manifest["all_table_rows"],
        "all_tables_covered": manifest["table_count"],
        "opaque_schema_coverage_sha256": manifest["opaque_schema_coverage_sha256"],
        "private_typed_record_commitment_sha256": commitment,
        "tenanted_scope_counts": scopes,
        "structural_findings": defects,
        "full_typed_record_graph_findings": typed_graph,
        "read_only_financial_precision_review": finance_precision,
        "legacy_manifest_quarantine_counts": manifest["quarantined_identity_counts"],
        "historical_owned_source_record_ids_modified": 0,
        "customer_database_written": False,
        "tenant_created": False,
        "tenant_assigned": False,
        "source_mappings_created": 0,
        "receipt_or_financial_posting_created": False,
        "historical_owner_grants_verified": False,
        "independent_second_approval_verified": False,
        "historical_patient_supplier_access_authorized": False,
        "full_financial_provenance_certified": False,
        "safe_to_activate_or_import": False,
        "next_gate": (
            "resolve_explicit_foreign_ownership_without_guessing" if foreign
            else "reconcile_broken_lineage_and_source_finance" if broken
            else "resolve_ambiguous_original_record_id_or_exact_typed_relationships"
                if typed_ambiguity
            else "map_every_unsupported_historical_module_before_any_import"
                if (defects["module_unmapped_layout_quarantined_rows"]
                    or typed_graph["unmapped_source_layout_quarantined_rows"])
            else "independently_validate_legacy_fractional_cents_and_signed_ledger_semantics"
                if legacy_finance_review
            else "independently_verify_two_signed_owner_approvals_and_every_original_record"
        ),
    }


def inspect_archive(path: Path, expected_sha256: str, tenant_id: str,
                    local_app_data: Path) -> dict:
    """The only supported real input: privately pinned immutable archive."""
    check_tenant(tenant_id)
    pin = require_pin(expected_sha256)
    archive = approved_archive(path, local_app_data)
    ensure(digest_file(archive) == pin, "historical_archive_pin_mismatch")
    with closing(read_only_connection(archive)) as db:
        verified_manifest(db, pin, lambda: digest_file(archive))
        result = assess_connection(db, tenant_id=tenant_id, source_sha256=pin)
    ensure(digest_file(archive) == pin, "historical_archive_changed_during_review")
    result["source_sha256_verified"] = True
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--target-tenant", required=True)
    arguments = parser.parse_args()
    try:
        result = inspect_archive(
            arguments.archive, arguments.expected_sha256,
            arguments.target_tenant, Path(os.environ["LOCALAPPDATA"]),
        )
    except (UnsafeSource, ValueError, sqlite3.Error, OSError, KeyError):
        print(json.dumps({"format": FORMAT, "classification": "REFUSE_PREFLIGHT",
                          "safe_to_activate_or_import": False}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0 if result["classification"].startswith("CANDIDATE_") else 2


if __name__ == "__main__":
    raise SystemExit(main())
