"""Whole-source immutable history witness and restart-safe *custody-only* stage.

All writes go to a freshly minted disposable folder, NEVER an installed app
profile, protected archive, native migration table or operator login. Every
historical table/row is copied without changing original IDs, labels or money.
The independent typed per-row witness is private: stdout is counts and SHA
commitments only, never patient/supplier data or original identifiers.

This is NOT a migration importer. Even a sealed result grants no historical
tenant ownership, receipt provenance, user access or permission to install it.
Actual activation additionally requires external ownership signatures,
independent reviewer, recipient-level mapping, safe native reads and finance
reconciliation. A crash can leave PREPARING files, which cannot be activated;
recovery may verify and seal the exact unchanged copies or leave them inert.
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
import struct
import tempfile

from scripts.legacy_pharmacy_upgrade import (
    UnsafeSource, all_rows_digest, backup_to, create_stage_root, ensure,
    no_aliases, open_frozen, require_pin, selected_manifest,
    synthetic_rollback_rehearsal, validate_integrity, verify_clone_against,
)
from scripts.qa_historical_archive_manifest import opaque_table_id, quote
from scripts.qa_historical_archive_preflight import (
    approved_archive, digest_file, read_only_connection,
)
from scripts.qa_single_pharmacy_transfer_preflight import (
    assess_connection, check_tenant,
)

STAGE_FORMAT = "historical-all-row-custody-v1"
STAGE_PATTERN = re.compile(r"pharma-legacy-stage-[0-9a-f]{32}\Z")
TABLE_COPY = "candidate.sqlite3"
TABLE_ROLLBACK = "rollback-retained.sqlite3"
WITNESS = "historical-row-witness.sqlite3"
MAX_ROWS = 3_000_000

SCHEMA = """
CREATE TABLE source_meta (
    marker INTEGER PRIMARY KEY CHECK(marker=1),
    format TEXT NOT NULL CHECK(format='historical-all-row-custody-v1'),
    source_sha256 TEXT NOT NULL,
    source_typed_sha256 TEXT NOT NULL,
    original_schema_sha256 TEXT NOT NULL,
    provisional_tenant TEXT NOT NULL,
    original_table_count INTEGER NOT NULL,
    original_row_count INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('PREPARING','SEALED_CUSTODY_ONLY')),
    owner_grant_verified INTEGER NOT NULL DEFAULT 0 CHECK(owner_grant_verified=0),
    financial_provenance_verified INTEGER NOT NULL DEFAULT 0 CHECK(financial_provenance_verified=0),
    activation_permitted INTEGER NOT NULL DEFAULT 0 CHECK(activation_permitted=0)
);
CREATE TABLE source_tables (
    opaque_table_id TEXT NOT NULL PRIMARY KEY,
    original_row_count INTEGER NOT NULL,
    original_columns_sha256 TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE source_rows (
    opaque_table_id TEXT NOT NULL REFERENCES source_tables(opaque_table_id),
    source_ordinal INTEGER NOT NULL CHECK(source_ordinal>0),
    original_identity_sha256 TEXT NOT NULL,
    original_typed_row_sha256 TEXT NOT NULL,
    PRIMARY KEY(opaque_table_id,source_ordinal)
) WITHOUT ROWID;
CREATE TRIGGER no_meta_delete BEFORE DELETE ON source_meta
BEGIN SELECT RAISE(ABORT,'custody evidence immutable'); END;
CREATE TRIGGER no_meta_replace BEFORE INSERT ON source_meta
WHEN EXISTS(SELECT 1 FROM source_meta WHERE marker=1)
BEGIN SELECT RAISE(ABORT,'custody evidence cannot be replaced'); END;
CREATE TRIGGER no_table_insert_after_seal BEFORE INSERT ON source_tables
WHEN EXISTS(SELECT 1 FROM source_meta WHERE state='SEALED_CUSTODY_ONLY')
BEGIN SELECT RAISE(ABORT,'sealed custody evidence cannot grow'); END;
CREATE TRIGGER no_row_insert_after_seal BEFORE INSERT ON source_rows
WHEN EXISTS(SELECT 1 FROM source_meta WHERE state='SEALED_CUSTODY_ONLY')
BEGIN SELECT RAISE(ABORT,'sealed custody evidence cannot grow'); END;
CREATE TRIGGER no_table_update BEFORE UPDATE ON source_tables
BEGIN SELECT RAISE(ABORT,'custody evidence immutable'); END;
CREATE TRIGGER no_table_delete BEFORE DELETE ON source_tables
BEGIN SELECT RAISE(ABORT,'custody evidence immutable'); END;
CREATE TRIGGER no_row_update BEFORE UPDATE ON source_rows
BEGIN SELECT RAISE(ABORT,'custody evidence immutable'); END;
CREATE TRIGGER no_row_delete BEFORE DELETE ON source_rows
BEGIN SELECT RAISE(ABORT,'custody evidence immutable'); END;
CREATE TRIGGER no_row_replace BEFORE INSERT ON source_rows
WHEN EXISTS(SELECT 1 FROM source_rows x WHERE x.opaque_table_id=NEW.opaque_table_id
 AND x.source_ordinal=NEW.source_ordinal)
BEGIN SELECT RAISE(ABORT,'custody evidence immutable'); END;
CREATE TRIGGER no_meta_sealed_update BEFORE UPDATE ON source_meta
WHEN OLD.state='SEALED_CUSTODY_ONLY'
BEGIN SELECT RAISE(ABORT,'sealed custody evidence immutable'); END;
"""


def _frame(hasher, payload: bytes) -> None:
    hasher.update(len(payload).to_bytes(8, "big"))
    hasher.update(payload)


def _typed_payload(value: object) -> tuple[bytes, bytes]:
    if value is None:
        return b"N", b""
    if type(value) is int:
        return b"I", str(value).encode("ascii")
    if type(value) is float:
        return b"F", struct.pack(">d", value)
    if type(value) is str:
        return b"T", value.encode("utf-8")
    if type(value) is bytes:
        return b"B", value
    raise UnsafeSource("unsupported_original_sqlite_storage_type")


def _row_hash(table: str, row: tuple) -> str:
    h = hashlib.sha256()
    _frame(h, STAGE_FORMAT.encode("ascii"))
    _frame(h, table.encode("utf-8"))
    for value in row:
        tag, raw = _typed_payload(value)
        h.update(tag)
        _frame(h, raw)
    return h.hexdigest()


def private_row_witness(source: sqlite3.Connection, evidence: sqlite3.Connection) -> dict:
    """Stream every original row; preserve REAL's exact binary bits and BLOBs."""
    names = tuple(sorted(r[0] for r in source.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )))
    ensure(0 < len(names) <= 256, "unsupported_original_table_census")
    total = 0
    for table in names:
        physical = quote(table)
        cols = source.execute(f"PRAGMA table_info({physical})").fetchall()
        ensure(bool(cols), "unreadable_original_table")
        names_and_types = [(c[1], c[2], c[3], c[5]) for c in cols]
        col_hash = hashlib.sha256(json.dumps(
            names_and_types, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")).hexdigest()
        opaque = opaque_table_id(table)
        expected = source.execute(f"SELECT COUNT(*) FROM {physical}").fetchone()[0]
        evidence.execute(
            "INSERT INTO source_tables VALUES (?,?,?)",
            (opaque, expected, col_hash),
        )
        count = 0
        idx = next((j for j, c in enumerate(cols) if c[1] == "id"), None)
        sorter = ",".join(str(i) for i in range(1, len(cols) + 1))
        for row in source.execute(f"SELECT * FROM {physical} ORDER BY {sorter}"):
            count += 1
            total += 1
            ensure(total <= MAX_ROWS, "original_history_row_budget_exceeded")
            # An absent legacy ID remains unassigned; a private commitment to
            # the original ordinal is not a fabricated business identifier.
            source_identity = row[idx] if idx is not None else None
            identity_h = hashlib.sha256()
            identity_h.update(b"pharma-source-id-witness-v1\0")
            _frame(identity_h, table.encode("utf-8"))
            if idx is None:
                _frame(identity_h, b"no_id_ordinal")
                _frame(identity_h, str(count).encode("ascii"))
            else:
                tag, raw = _typed_payload(source_identity)
                identity_h.update(tag)
                _frame(identity_h, raw)
            evidence.execute(
                "INSERT INTO source_rows VALUES (?,?,?,?)",
                (opaque, count, identity_h.hexdigest(), _row_hash(table, row)),
            )
        ensure(count == expected, "original_table_row_count_changed")
    return {"tables": len(names), "rows": total}


def _stage_path(path: Path, *, local_app_data: Path | None) -> Path:
    stage = no_aliases(path)
    ensure(stage.is_dir() and STAGE_PATTERN.fullmatch(stage.name) is not None,
           "legacy_stage_path_denied")
    if local_app_data is not None:
        private_root = no_aliases(local_app_data / "pharma-disposable-data-copies")
        ensure(stage.parent == private_root, "legacy_stage_outside_private_custody")
    else:
        ensure(stage.parent == no_aliases(Path(tempfile.gettempdir())),
               "legacy_synthetic_stage_not_under_temp")
    return stage


def _make_witness(
    source: sqlite3.Connection, target: Path, *, source_sha256: str,
    tenant: str, original_manifest: dict, source_typed_sha: str,
) -> None:
    ensure(not target.exists(), "custody_witness_already_exists")
    with closing(sqlite3.connect(target)) as evidence:
        evidence.execute("PRAGMA foreign_keys=ON")
        evidence.execute("PRAGMA synchronous=FULL")
        evidence.executescript(SCHEMA)
        evidence.execute("BEGIN IMMEDIATE")
        try:
            evidence.execute(
                "INSERT INTO source_meta(marker,format,source_sha256,source_typed_sha256,"
                "original_schema_sha256,provisional_tenant,original_table_count,"
                "original_row_count,state) VALUES(1,?,?,?,?,?,?,?,'PREPARING')",
                (STAGE_FORMAT, source_sha256, source_typed_sha,
                 original_manifest["opaque_schema_coverage_sha256"], tenant,
                 original_manifest["table_count"], original_manifest["all_table_rows"]),
            )
            counts = private_row_witness(source, evidence)
            ensure(counts == {"tables": original_manifest["table_count"],
                              "rows": original_manifest["all_table_rows"]},
                   "typed_source_witness_census_mismatch")
            evidence.commit()
        except BaseException:
            evidence.rollback()
            raise


def _verify_private_witness(source: sqlite3.Connection, witness: Path) -> dict:
    ensure(witness.is_file() and not witness.is_symlink(), "custody_witness_missing")
    with closing(open_frozen(witness)) as evidence:
        ensure(evidence.execute("PRAGMA integrity_check").fetchone() == ("ok",),
               "custody_witness_integrity_failed")
        meta = evidence.execute(
            "SELECT format,source_sha256,source_typed_sha256,"
            "original_schema_sha256,provisional_tenant,original_table_count,"
            "original_row_count,state,owner_grant_verified,"
            "financial_provenance_verified,activation_permitted "
            "FROM source_meta WHERE marker=1"
        ).fetchone()
        ensure(meta is not None and meta[0] == STAGE_FORMAT
               and meta[8:] == (0, 0, 0), "custody_evidence_invalid")
        with closing(sqlite3.connect(":memory:")) as recomputed:
            recomputed.executescript(
                "CREATE TABLE source_tables(opaque_table_id TEXT PRIMARY KEY,"
                "original_row_count INTEGER,original_columns_sha256 TEXT);"
                "CREATE TABLE source_rows(opaque_table_id TEXT,source_ordinal INTEGER,"
                "original_identity_sha256 TEXT,original_typed_row_sha256 TEXT,"
                "PRIMARY KEY(opaque_table_id,source_ordinal));"
            )
            counts = private_row_witness(source, recomputed)
            for table in ("source_tables", "source_rows"):
                from scripts.legacy_pharmacy_upgrade import all_rows_digest
                ensure(
                    all_rows_digest(evidence, table_names=(table,)) ==
                    all_rows_digest(recomputed, table_names=(table,)),
                    "source_record_witness_mismatch",
                )
        ensure(counts == {"tables": meta[5], "rows": meta[6]},
               "source_record_witness_census_mismatch")
        ensure(all_rows_digest(source) == meta[2], "source_snapshot_typed_rows_changed")
        return {
            "format": meta[0],
            "source_sha256": meta[1],
            "source_typed_sha256": meta[2],
            "original_schema_sha256": meta[3],
            "provisional_tenant": meta[4],
            "tables": meta[5],
            "rows": meta[6],
            "stage_state": meta[7],
        }


def verify_and_seal_stage(
    stage: Path, *, expected_source_sha256: str, tenant: str,
    original: sqlite3.Connection, source_unchanged: callable,
    local_app_data: Path | None,
    seal: bool = True,
) -> dict:
    """Crash recovery only on verified disposable copies; never app install."""
    stage = _stage_path(stage, local_app_data=local_app_data)
    pin = require_pin(expected_source_sha256)
    check_tenant(tenant)
    original.execute("PRAGMA query_only=ON")
    ensure(source_unchanged(), "source_changed_during_legacy_stage")
    manifest = selected_manifest(original)
    original_digest = all_rows_digest(original)
    for file in (TABLE_COPY, TABLE_ROLLBACK):
        target = stage / file
        ensure(target.is_file() and not target.is_symlink(), "retained_stage_backup_missing")
        verify_clone_against(manifest, original_digest, target)
    with closing(open_frozen(stage / TABLE_COPY)) as candidate:
        witness = _verify_private_witness(candidate, stage / WITNESS)
    ensure(witness["source_sha256"] == pin
           and witness["source_typed_sha256"] == original_digest
           and witness["original_schema_sha256"] ==
               manifest["opaque_schema_coverage_sha256"]
           and witness["provisional_tenant"] == tenant
           and witness["tables"] == manifest["table_count"]
           and witness["rows"] == manifest["all_table_rows"],
           "source_owner_free_custody_mismatch")
    ensure(source_unchanged(), "original_source_changed_during_recovery")
    if seal and witness["stage_state"] == "PREPARING":
        with closing(sqlite3.connect(stage / WITNESS)) as evidence:
            evidence.execute("PRAGMA synchronous=FULL")
            evidence.execute("BEGIN IMMEDIATE")
            try:
                changed = evidence.execute(
                    "UPDATE source_meta SET state='SEALED_CUSTODY_ONLY' "
                    "WHERE marker=1 AND state='PREPARING' AND source_sha256=?",
                    (pin,),
                ).rowcount
                ensure(changed == 1, "custody_seal_concurrent_state_changed")
                evidence.commit()
            except BaseException:
                evidence.rollback()
                raise
        with closing(open_frozen(stage / WITNESS)) as sealed:
            ensure(sealed.execute("SELECT state FROM source_meta").fetchone() ==
                   ("SEALED_CUSTODY_ONLY",), "custody_seal_restart_failed")
        witness["stage_state"] = "SEALED_CUSTODY_ONLY"
    return {
        "stage_token": stage.name,
        "stage_state": witness["stage_state"],
        "tables_with_original_rows": witness["tables"],
        "original_row_witnesses": witness["rows"],
        "full_private_typed_source_copy_match": True,
        "complete_individual_typed_record_witness_parity": True,
        "retained_original_rollback_copy": True,
        "reopened_witness_integrity_verified": True,
        "source_unchanged_before_and_after": True,
        "original_source_sha256": pin,
        "private_row_witness_sha256": digest_file(stage / WITNESS),
        "all_historic_user_ids_and_tenant_literals_preserved": True,
        "owner_or_second_reviewer_approved": False,
        "all_financial_provenance_certified": False,
        "production_or_qa_installation_touched": False,
        "historical_tenant_ownership_granted": False,
        "safe_to_activate_or_import": False,
    }


def rehearse_staged_rollback(
    stage: Path, *, expected_source_sha256: str, tenant: str,
    original: sqlite3.Connection, source_unchanged: callable,
    local_app_data: Path | None,
) -> dict:
    """Verify sealed evidence, crash rollback, committed clone, restored clone.

    This never unseals/replaces the existing snapshot or the historical
    witness. The two working names are exclusive create-only operations;
    retry after an interrupted drill fails closed, retaining all partial files.
    """
    verified = verify_and_seal_stage(
        stage, expected_source_sha256=expected_source_sha256,
        tenant=tenant, original=original, source_unchanged=source_unchanged,
        local_app_data=local_app_data,
    )
    ensure(verified["stage_state"] == "SEALED_CUSTODY_ONLY",
           "history_custody_stage_not_sealed")
    stage = _stage_path(stage, local_app_data=local_app_data)
    source_digest = all_rows_digest(original)
    manifest = selected_manifest(original)
    drill = synthetic_rollback_rehearsal(
        stage / TABLE_COPY, stage / TABLE_ROLLBACK,
        stage / "working-synthetic-migration.sqlite3",
        stage / "restored-after-rehearsal.sqlite3",
        manifest, source_digest,
    )
    with closing(open_frozen(stage / WITNESS)) as proof:
        ensure(proof.execute("SELECT state FROM source_meta").fetchone() ==
               ("SEALED_CUSTODY_ONLY",), "recovery_drill_modified_immutable_witness")
    ensure(source_unchanged(), "original_history_changed_during_restore_drill")
    return {
        **verified,
        **drill,
        "rollback_drill_affected_only_disposable_working_copy": True,
        "real_profile_or_production_restore_performed": False,
        "safe_to_activate_or_import": False,
    }


def stage_connection(
    source: sqlite3.Connection, *, source_sha256: str, tenant: str,
    source_unchanged: callable, private_root: Path | None = None,
) -> dict:
    """Create independent immutable baseline, full row register, rollback copy."""
    check_tenant(tenant)
    require_pin(source_sha256)
    source.execute("PRAGMA query_only=ON")
    validate_integrity(source)
    # All core/module/typed graph audit gates must first accept the source;
    # REVIEW accounting precision remains quarantined even on successful copy.
    preflight = assess_connection(source, tenant_id=tenant,
                                  source_sha256=source_sha256)
    ensure(preflight["classification"] not in (
        "REFUSE_EXPLICIT_SCOPE_CONFLICT",
        "REFUSE_BROKEN_HISTORICAL_RELATIONSHIPS",
        "REFUSE_AMBIGUOUS_TYPED_HISTORICAL_RECORD_GRAPH",
        "REFUSE_INCOMPLETE_HISTORICAL_MODULE_GRAPH",
    ), "historical_stage_source_not_structurally_safe")
    baseline_manifest = selected_manifest(source)
    baseline_typed = all_rows_digest(source)
    stage = create_stage_root(private_root=private_root)
    # A failure or crash leaves only distinct incomplete disposable files;
    # intentionally NEVER clean/rename/replace the customer's source.
    backup_to(source, stage / TABLE_COPY)
    verify_clone_against(baseline_manifest, baseline_typed, stage / TABLE_COPY)
    with closing(open_frozen(stage / TABLE_COPY)) as candidate:
        backup_to(candidate, stage / TABLE_ROLLBACK)
        _make_witness(candidate, stage / WITNESS,
                      source_sha256=source_sha256, tenant=tenant,
                      original_manifest=baseline_manifest,
                      source_typed_sha=baseline_typed)
    return verify_and_seal_stage(
        stage, expected_source_sha256=source_sha256, tenant=tenant,
        original=source, source_unchanged=source_unchanged,
        local_app_data=private_root.parent if private_root is not None else None,
    )


def stage_pinned_archive(source: Path, expected_sha256: str,
                         tenant: str, local_app_data: Path) -> dict:
    archive = approved_archive(source, local_app_data)
    pin = require_pin(expected_sha256)
    ensure(digest_file(archive) == pin, "detached_archive_pin_mismatch")
    with closing(read_only_connection(archive)) as db:
        result = stage_connection(
            db, source_sha256=pin, tenant=tenant,
            source_unchanged=lambda: digest_file(archive) == pin,
            private_root=local_app_data / "pharma-disposable-data-copies",
        )
    ensure(digest_file(archive) == pin, "detached_archive_changed")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Isolated custody-only row witness; NEVER tenant activation"
    )
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--provisional-tenant", required=True)
    args = parser.parse_args()
    try:
        report = stage_pinned_archive(
            args.archive, args.expected_sha256, args.provisional_tenant,
            Path(os.environ["LOCALAPPDATA"]),
        )
    except (UnsafeSource, sqlite3.Error, ValueError, OSError, KeyError):
        print(json.dumps({"format": STAGE_FORMAT, "stage_completed": False,
                          "safe_to_activate_or_import": False}))
        return 2
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
