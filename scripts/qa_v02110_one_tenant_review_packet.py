"""Produce an UNSIGNED one-pharmacy source-scope review packet, never a grant.

The claimed single operational pharmacy is a *proposal*, not inferred consent.
Every original database row and typed value remains untouched. The report
contains aggregate counts, full-source cryptographic commitments and a
separately chosen tentative tenant identifier, not patient/financial contents.

Usage:
 python -B -m scripts.qa_v02110_one_tenant_review_packet \
     --source <WAL-detached-sealed-v29-file> --expected-sha256 <pin> \
     --proposed-tenant pharmacy_primary --output <new-review-json-file>

This does NOT make the custody verifier's owner/reviewer signing roots exist,
notarize a human review, change a source field or permit a v29 upgrade.
"""
from __future__ import annotations

import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import uuid

from scripts.qa_legacy_ownership_approvals import (
    FORMAT, PURPOSE, SourceCommitment, snapshot_sqlite_bytes,
)
from scripts.qa_full_history_lineage import make_full_history_lineage

SEAL_NAME = "current-v02109-sealed.sqlite3"
SEAL_PARENT = "pharma-v02110-prebuild-snapshot-cb743d7b7ab14ffd9583ee1a64cdd472"
PIN = "06fc00f32ec2603758cd3f0eb12c38024f22fce27c4e5f7875ab47aceb6c87fb"
TENANT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")


def quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_path_checked(source: Path, expected_sha: str) -> Path:
    if expected_sha.lower() != PIN:
        raise ValueError("Source pin differs from independently retained sealed v29")
    root = Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"
    expected = root / SEAL_PARENT / SEAL_NAME
    if (source.is_symlink() or source.parent.is_symlink() or
        source.resolve(strict=True) != expected.resolve(strict=True) or
        not source.is_file()):
        raise ValueError("Only the pinned, detached, sealed v29 source may be inspected")
    if any(Path(str(source) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise ValueError("Detached source has mutable SQLite sidecars")
    if file_sha256(source) != PIN:
        raise ValueError("Sealed original source digest mismatch")
    return source


def scope_census(db: sqlite3.Connection) -> dict:
    """Count every physical SQLite table, including FTS5 virtual/shadows.

    Classify exact original scope storage types; never coerce or normalize it.
    In particular NULL and local_default are different archival values.
    """
    names = sorted(row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"))
    if not names or len(names) > 512 or len(names) != len(set(names)):
        raise ValueError("Unexpected physical source schema")
    summaries = []
    scoped_rows = 0
    named_rows = 0
    all_rows = 0
    for table in names:
        tq = quote(table)
        columns = {str(r[1]) for r in db.execute(f"PRAGMA table_xinfo({tq})")}
        total = int(db.execute(f"SELECT COUNT(*) FROM {tq}").fetchone()[0])
        all_rows += total
        item: dict = {"table": table, "original_physical_rows": total,
                      "original_values_mutated": False}
        if "pharmacy_id" not in columns:
            item["scope_status"] = "no_direct_scope_requires_reviewed_link_or_shared_directory"
        else:
            row = db.execute(f"""SELECT
                COALESCE(SUM(CASE WHEN pharmacy_id IS NULL THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN typeof(pharmacy_id)='text'
                    AND pharmacy_id='local_default' THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN typeof(pharmacy_id)='text'
                    AND TRIM(pharmacy_id)='' THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN typeof(pharmacy_id)='text'
                    AND pharmacy_id NOT IN ('local_default','')
                    AND TRIM(pharmacy_id)<>'' THEN 1 ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN pharmacy_id IS NOT NULL
                    AND typeof(pharmacy_id)!='text' THEN 1 ELSE 0 END),0)
                FROM {tq}""").fetchone()
            null, placeholder, blank, named, nontext = map(int, row)
            if sum((null, placeholder, blank, named, nontext)) != total:
                raise ValueError("Source scope classes are not exhaustive")
            item["scope_status"] = "original_literal_must_remain_unchanged"
            item["original_scope_types"] = {
                "null": null, "literal_local_default": placeholder,
                "blank_text": blank, "other_nonblank_text": named,
                "non_text_nonnull": nontext,
            }
            scoped_rows += total
            named_rows += named
        summaries.append(item)
    return {"original_physical_table_count": len(names),
            "original_physical_table_rows_including_fts": all_rows,
            "rows_in_directly_scoped_tables": scoped_rows,
            "rows_with_other_named_literal_scope": named_rows,
            "tables": summaries}


def make_packet(db: sqlite3.Connection, *, source: SourceCommitment,
                proposed_tenant: str) -> dict:
    if (TENANT.fullmatch(proposed_tenant) is None or
        proposed_tenant.lower() == "local_default"):
        raise ValueError("A real proposed tenant ID, not local_default, is required")
    census = scope_census(db)
    if census["original_physical_table_count"] != source.table_count or \
       census["original_physical_table_rows_including_fts"] != source.full_row_count:
        raise ValueError("Cryptographic all-rows commitment and table census differ")
    lineage = make_full_history_lineage(db)
    if lineage["table_count"] != source.table_count or \
       lineage["total_table_rows_including_fts_shadows"] != source.full_row_count:
        raise ValueError("Full source-link census and cryptographic source differ")
    issues = [
        {"relationship": k, "status": v["status"],
         "source_rows_quarantined": v.get("source_rows_quarantined", 0)}
        for k, v in lineage["fixed_relationships"].items()
        if v.get("status") != "typed_structural_inspection_not_ownership"
    ]
    return {
        "format": "pharma-v02110-one-pharmacy-candidate-review-v1",
        "status": "UNSIGNED_PROPOSAL_NOT_CUSTOMER_AUTHORIZATION",
        "user_supplied_claim": "all historical data came from one pharmacy and one tenant",
        "proposed_destination_tenant": proposed_tenant,
        "destination_tenant_owner_confirmed": False,
        "source": {k: getattr(source, k) for k in (
            "source_sha256", "all_rows_typed_sha256", "schema_sha256",
            "full_row_count", "table_count", "source_size_bytes")},
        "request_id_for_future_independent_review": str(uuid.uuid4()),
        "cryptographic_review_purpose": {
            "format": FORMAT, "purpose": PURPOSE,
            "owner_signer_id": None, "reviewer_signer_id": None,
            "owner_signature_verified": False,
            "independent_reviewer_signature_verified": False,
            "trusted_owner_and_reviewer_public_roots_installed": False,
        },
        "scope_census": census,
        "structural_lineage": {
            "coverage": lineage["coverage"],
            "fixed_relationship_exceptions": issues,
            "ownership_certified": False,
            "financial_provenance_certified": False,
        },
        "preservation_contract": {
            "original_table_ids_rowids_storage_classes_amounts_unchanged": True,
            "preserve_null_blank_and_local_default_literally": True,
            "do_not_resurrect_original_public_admin_password": True,
            "credential_032_and_scope_052_native_drift_requires_review": True,
            "mapping_is_separate_metadata_and_requires_signed_authorization": True,
            "no_operations_or_mutations_performed": True,
        },
        "commercial_release_authorized": False,
        "native_gui_customer_history_authorized": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Immutable single-pharmacy ownership review packet only")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--proposed-tenant", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        source = source_path_checked(args.source, args.expected_sha256)
        # Source content is held in memory by the checksum checker; the only
        # database connection is immutable and query_only. No main DB writes.
        commitment = snapshot_sqlite_bytes(source.read_bytes())
        if commitment.source_sha256 != PIN:
            raise ValueError("Whole-source cryptographic commitment changed")
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            db.execute("PRAGMA query_only=ON")
            if db.execute("PRAGMA integrity_check").fetchone() != ("ok",) or \
               db.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise ValueError("Source structural integrity is not healthy")
            packet = make_packet(db, source=commitment, proposed_tenant=args.proposed_tenant)
        if file_sha256(source) != PIN:
            raise ValueError("Immutable source mutated during review")
        output = args.output.resolve(strict=False)
        if output.exists() or output.is_symlink() or not output.parent.is_dir() or \
           output.suffix.lower() != ".json" or output.is_relative_to(source.parent):
            raise ValueError("Output must be a new separate JSON review file")
        packet["created_at_utc"] = datetime.now(timezone.utc).isoformat()
        with output.open("x", encoding="utf8") as handle:
            json.dump(packet, handle, ensure_ascii=True, indent=2, sort_keys=True)
            handle.write("\n")
        print(json.dumps({
            "status": packet["status"], "packet": str(output),
            "packet_sha256": file_sha256(output),
            "source_tables": packet["source"]["table_count"],
            "source_rows": packet["source"]["full_row_count"],
            "other_named_direct_scope_rows": packet["scope_census"]["rows_with_other_named_literal_scope"],
            "independently_authorized": False,
        }, sort_keys=True))
        return 0
    except (OSError, ValueError, sqlite3.Error, MemoryError, KeyError):
        print("One-pharmacy unsigned packet refused: source custody or review invariants failed", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
