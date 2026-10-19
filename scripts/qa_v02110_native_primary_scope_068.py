"""Build a native-068 typed scope/relationship witness on an isolated v67 copy.

Only accepts an independently SHA-pinned, WAL-detached native v67 source and a
normalized disposable stage produced by qa_v02110_primary_pharmacy_migration.
Neither input is opened as a file-backed SQLite connection; both are deserialized
into private read-only memory. Output is a new isolated native SQL-only candidate
under LOCALAPPDATA/pharma-disposable-data-copies. It is NEVER an installation.

The original 032 owner password is present only in the input rehearsal's
sealed-custody escrow. It is never copied into native 068 evidence. The output
has *no* QA escrow tables or new credentials. An empty owner-attestation table
allows a future native owner-authenticated import to bind verified evidence;
this script cannot authenticate that owner or create an attestation.

Usage:
  python -B -m scripts.qa_v02110_native_primary_scope_068 \
    --source <offline-current-v67.sqlite3> --source-sha256 <sha256> \
    --normalized <disposable-normalized-v67.sqlite3> \
    --normalized-sha256 <sha256>
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import itertools
import json
from pathlib import Path
import sqlite3
import sys
import uuid

from scripts import qa_v02110_primary_pharmacy_migration as qa
from scripts.qa_full_history_lineage import make_full_history_lineage

MIGRATION = Path(__file__).resolve().parent.parent / "src-tauri" / "migrations" / (
    "068_primary_pharmacy_typed_scope_audit.sql"
)
DIR_PREFIX = "pharma-v02110-primary-pharmacy-native-068-"
OUTPUT_NAME = "NATIVE-068-UNSIGNED-TEST-ONLY.sqlite3"
REPORT_NAME = "NATIVE-068-RECONCILIATION.json"
FORMAT = "pharma-v02110-native-068-typed-scope-reconciliation-v1"
FROZEN_QA_TABLES = qa.AUDIT_TABLES


def _frame(hasher, data: bytes) -> None:
    hasher.update(len(data).to_bytes(8, "big"))
    hasher.update(data)


def canonical(value: object) -> bytes:
    # Scope originals may be SQLite BLOBs. Encode them with an explicit typed
    # frame for deterministic source commitments without losing the raw bytes.
    def encode_blob(item: object) -> object:
        if isinstance(item, bytes):
            return {"__sqlite_blob_hex_v1__": item.hex()}
        raise TypeError("Unsupported non-JSON audit commitment type")
    return json.dumps(value, ensure_ascii=True, sort_keys=True,
                      separators=(",", ":"), allow_nan=False,
                      default=encode_blob).encode("utf-8")


def physical_rows(db: sqlite3.Connection, table: str):
    return qa.row_stream(db, table)


def typed_row_digest(row: tuple) -> str:
    h = hashlib.sha256()
    for value in row:
        storage, literal = qa.typed(value)
        _frame(h, storage.encode("ascii"))
        _frame(h, literal)
    return h.hexdigest()


def physical_table_digest(db: sqlite3.Connection, table: str) -> tuple[int, str]:
    h = hashlib.sha256()
    count = 0
    for row in physical_rows(db, table):
        _frame(h, bytes.fromhex(typed_row_digest(row)))
        count += 1
        if count > qa.MAX_ROWS:
            raise qa.Refused("Original table exceeds physical row verification budget")
    return count, h.hexdigest()


def original_scope_records(source: sqlite3.Connection,
                           normalized: sqlite3.Connection) -> list[tuple]:
    """Rowid and exact original SQLite storage; digest full unmodified row."""
    ledger = normalized.execute("""SELECT source_table,source_rowid,
        original_storage,original_literal FROM qa_primary_scope_originals
        ORDER BY source_table,source_rowid""").fetchall()
    result = []
    seen = set()
    scoped = qa.scope_tables(source)
    if {t for t, *_ in ledger} - set(scoped):
        raise qa.Refused("Original scope archive contains a non-scoped table")
    by_table: dict[str, dict[int, tuple]] = {}
    for table, rowid, storage, literal in ledger:
        if (table, rowid) in seen:
            raise qa.Refused("Duplicate scope archive identity")
        seen.add((table, rowid))
        by_table.setdefault(table, {})[rowid] = (storage, literal)
    for table in scoped:
        entries = by_table.get(table, {})
        if not entries:
            continue
        col = qa.columns(source, table).index("pharmacy_id") + 1
        for record in physical_rows(source, table):
            rowid = record[0]
            if rowid not in entries:
                continue
            storage, literal = entries[rowid]
            if qa.typed(record[col])[0] != storage or not qa.same(record[col], literal):
                raise qa.Refused("Native source scope differs from the archived typed original")
            result.append((table, rowid, storage, literal,
                           typed_row_digest(record)))
    if len(result) != len(ledger):
        raise qa.Refused("An original scoped physical row disappeared")
    return sorted(result, key=lambda row: (row[0], row[1]))


def relationship_evidence(source: sqlite3.Connection,
                          normalized: sqlite3.Connection) -> list[tuple]:
    before = make_full_history_lineage(source)
    after = make_full_history_lineage(normalized)
    output = []
    def fixed_report(report: dict) -> dict:
        return report["fixed_relationships"]
    def declared_report(report: dict) -> dict:
        return {item["opaque_relationship_id"]: item
                for item in report["declared_foreign_keys"]}
    for kind, old, new in (
        ("FIXED", fixed_report(before), fixed_report(after)),
        ("DECLARED_FK", declared_report(before), declared_report(after)),
    ):
        if old.keys() != new.keys():
            raise qa.Refused("Original declared/fixed relationship definitions drifted")
        for key in sorted(old):
            a, b = old[key], new[key]
            if a != b:
                raise qa.Refused("Original typed indirect graph changed during normalization")
            if a["status"] != "typed_structural_inspection_not_ownership":
                # Uninspectable legacy relationships remain explicitly
                # quarantined; metadata must not turn them into fake links.
                rows = a.get("source_rows_quarantined", 0)
                matched = coerced = missing = partial = 0
                unlinked = rows
            else:
                rows = a["source_rows"]
                matched = a["matched_typed_rows"]
                coerced = a["coercion_only_parent_rows"]
                missing = a["missing_parent_rows"]
                unlinked = a["optional_unlinked_rows"] + (
                    a["missing_mandatory_reference_rows"] - a["partial_null_reference_rows"]
                )
                partial = a["partial_null_reference_rows"]
            if rows != matched + coerced + missing + unlinked + partial:
                raise qa.Refused("Indirect relation witness has unaccounted physical rows")
            relation_id = hashlib.sha256(canonical(["pharma-068-relation", kind, key])).hexdigest()
            digest = hashlib.sha256(canonical(a)).hexdigest()
            output.append((relation_id, kind, rows, matched, coerced, missing,
                           unlinked, partial, digest, digest))
    if not output:
        raise qa.Refused("No native/fixed relationships were auditable")
    return sorted(output)


def evidence_payload(source: sqlite3.Connection,
                     normalized: sqlite3.Connection) -> dict:
    """Deterministic commitments and typed parent/child census for ALL tables."""
    original_names = qa.tables(source)
    staged_names = qa.tables(normalized)
    if set(staged_names) != set(original_names) | FROZEN_QA_TABLES:
        raise qa.Refused("Normalized rehearsal has unexpected physical tables")
    scoped = set(qa.scope_tables(source))
    scope_records = original_scope_records(source, normalized)
    physical = []
    for table in original_names:
        before_count, before_digest = physical_table_digest(source, table)
        after_count, after_digest = physical_table_digest(normalized, table)
        if before_count != after_count:
            raise qa.Refused("Original physical table row count changed")
        if table not in scoped and before_digest != after_digest:
            raise qa.Refused("Unscoped original physical table changed")
        physical.append((table, before_count, int(table in scoped),
                         before_digest, after_digest))
    relations = relationship_evidence(source, normalized)
    whole_rows = sum(entry[1] for entry in physical)
    if whole_rows > qa.MAX_ROWS:
        raise qa.Refused("Historical physical row budget exceeded")
    if len(scope_records) != normalized.execute(
        "SELECT COUNT(*) FROM qa_primary_scope_originals"
    ).fetchone()[0]:
        raise qa.Refused("Original direct scope records are incomplete")
    return {"physical": physical, "scopes": scope_records,
            "relations": relations, "whole_rows": whole_rows,
            "direct_tables": len(scoped)}


def _storage_safe_escrow_drop(db: sqlite3.Connection) -> None:
    """Scrub QA-only credentials without renumbering original SQLite rowids."""
    db.execute("PRAGMA secure_delete=ON")
    with db:
        for name in sorted(FROZEN_QA_TABLES):
            db.execute(f"DROP TABLE {qa.quote(name)}")
    # VACUUM renumbers implicit sqlite_stat1 rowids, breaking whole-source
    # physical preservation. secure_delete wipes each dropped QA table's cells
    # while leaving existing native table rowids and FTS shadows unchanged.
    if FROZEN_QA_TABLES.intersection(qa.tables(db)):
        raise qa.Refused("QA-only credential archive persisted in native candidate")


def register_metadata(candidate: sqlite3.Connection, *, source_pin: str,
                      sealed_pin: str, payload: dict, audit_id: str,
                      evidence_id: str) -> None:
    if candidate.execute("SELECT name FROM sqlite_master WHERE name=?",
                         ("native_primary_scope_audit_batches",)).fetchone():
        raise qa.Refused("068 already exists; never reapply migration SQL")
    candidate.executescript(MIGRATION.read_text(encoding="utf-8"))
    expected_sql = MIGRATION.read_bytes()
    if not expected_sql:
        raise qa.Refused("068 SQL is missing")
    with candidate:
        candidate.execute("""INSERT INTO native_primary_scope_audit_batches
            (audit_sha256,original_v67_sha256,sealed_v29_sha256,
             observed_native_schema_version,original_physical_table_count,
             original_physical_row_count,expected_original_scope_count,
             expected_table_witness_count,expected_relation_witness_count)
            VALUES(?,?,?,67,?,?,?,?,?)""",
            (audit_id, source_pin, sealed_pin, len(payload["physical"]),
             payload["whole_rows"], len(payload["scopes"]),
             len(payload["physical"]), len(payload["relations"])))
        candidate.executemany("""INSERT INTO native_primary_scope_audit_originals
            (audit_sha256,source_table,source_rowid,original_storage,
             original_literal,original_row_typed_sha256) VALUES(?,?,?,?,?,?)""",
            ((audit_id, *item) for item in payload["scopes"]))
        candidate.executemany("""INSERT INTO native_primary_scope_audit_tables
            (audit_sha256,source_table,original_physical_rows,directly_scoped,
             original_typed_rows_sha256,normalized_typed_rows_sha256)
            VALUES(?,?,?,?,?,?)""",
            ((audit_id, *item) for item in payload["physical"]))
        candidate.executemany("""INSERT INTO native_primary_scope_audit_relations
            (audit_sha256,relation_sha256,relation_kind,source_rows,
             matched_typed_rows,coerced_only_rows,missing_parent_rows,
             unlinked_rows,partial_null_rows,before_edge_sha256,after_edge_sha256)
            VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            ((audit_id, *item) for item in payload["relations"]))
        candidate.execute("INSERT INTO native_primary_scope_audit_seals "
                          "(audit_sha256,evidence_sha256) VALUES(?,?)",
                          (audit_id, evidence_id))
        qa.healthy(candidate)
    if candidate.execute("SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone()[0]:
        raise qa.Refused("QA must never mint an authenticated owner attestation")


def _verify_native_cells(normalized: sqlite3.Connection,
                         output: sqlite3.Connection) -> tuple[int, int]:
    """Every existing physical row, rowid, exact typed cell and FTS shadow."""
    verified, fts = 0, 0
    for name in sorted(set(qa.tables(normalized)) - FROZEN_QA_TABLES):
        cols = qa.columns(normalized, name)
        if cols != qa.columns(output, name):
            raise qa.Refused("Existing native column layout changed after 068")
        for a, b in itertools.zip_longest(physical_rows(normalized, name),
                                          physical_rows(output, name),
                                          fillvalue=None):
            if a is None or b is None or len(a) != len(b) or any(
                not qa.same(x, y) for x, y in zip(a, b)
            ):
                raise qa.Refused("068 metadata changed historical physical/financial/FTS cells")
            verified += 1
            fts += int("fts" in name)
            if verified > qa.MAX_ROWS:
                raise qa.Refused("Native row reconciliation exceeded row budget")
    return verified, fts


def produce(*, source: Path, source_sha256: str, normalized: Path,
            normalized_sha256: str, folder: Path | None = None) -> dict:
    source_pin = source_sha256.lower()
    normalized_pin = normalized_sha256.lower()
    source_raw = qa.checked_file(source, source_pin)
    staged_raw = qa.checked_file(normalized, normalized_pin)
    sealed_path = qa.disposable_root() / qa.SEAL_PARENT / qa.SEAL_NAME
    sealed_bytes = qa.checked_file(sealed_path, qa.SEALED_PIN, sealed=True)
    root = qa.disposable_root()
    result_dir = folder or root / (DIR_PREFIX + uuid.uuid4().hex)
    if (result_dir.parent.resolve(strict=True) != root.resolve(strict=True)
        or result_dir.is_symlink() or result_dir.exists()
        or not result_dir.name.startswith(DIR_PREFIX)):
        raise qa.Refused("Native 068 stage requires a new private disposable folder")
    with closing(qa.memory_source(source_raw)) as baseline, \
         closing(qa.memory_source(staged_raw)) as rehearsal, \
         closing(qa.memory_source(sealed_bytes)) as sealed:
        if qa._phase(rehearsal)[0] != "NORMALIZED":
            raise qa.Refused("068 must begin with a verified normalized rehearsal")
        qa.verify(baseline, rehearsal, sealed, source_pin)
        payload = evidence_payload(baseline, rehearsal)
        summary_commitment = {
            "format": FORMAT,
            "source_v67_sha256": source_pin,
            "normalized_v67_sha256": normalized_pin,
            "sealed_v29_sha256": qa.SEALED_PIN,
            "native068_sql_sha256": qa.digest(MIGRATION),
            "physical": payload["physical"],
            "scopes": payload["scopes"],
            "relations": payload["relations"],
        }
        audit_id = hashlib.sha256(canonical(summary_commitment)).hexdigest()
        evidence_id = hashlib.sha256(canonical([
            "pharma-native-068-typed-witness-v1", audit_id,
            payload["physical"], payload["scopes"], payload["relations"],
        ])).hexdigest()
        result_dir.mkdir(mode=0o700)
        candidate_path = result_dir / OUTPUT_NAME
        with closing(sqlite3.connect(candidate_path)) as candidate:
            rehearsal.backup(candidate)
            _storage_safe_escrow_drop(candidate)
            register_metadata(candidate, source_pin=source_pin,
                              sealed_pin=qa.SEALED_PIN, payload=payload,
                              audit_id=audit_id, evidence_id=evidence_id)
            count, fts = _verify_native_cells(rehearsal, candidate)
            if count != payload["whole_rows"]:
                raise qa.Refused("068 final typed-row count differs from source proof")
            qa.healthy(candidate)
            if candidate.execute("SELECT COUNT(*) FROM native_primary_scope_audit_observations").fetchone() != (1,):
                raise qa.Refused("Native unsigned scope witness is not sealed")
            if candidate.execute("SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone() != (0,):
                raise qa.Refused("An unauthenticated owner attestation appeared")
        if qa.digest(source) != source_pin or qa.digest(normalized) != normalized_pin or \
           qa.digest(sealed_path) != qa.SEALED_PIN:
            raise qa.Refused("Detached custody source changed during native 068 stage")
    report = {
        "format": FORMAT,
        "status": "NATIVE_068_UNSIGNED_DISPOSABLE_CANDIDATE_NO_AUTHORIZATION",
        "candidate": str(candidate_path),
        "candidate_sha256": qa.digest(candidate_path),
        "source_v67_sha256": source_pin,
        "normalized_v67_sha256": normalized_pin,
        "sealed_v29_sha256": qa.SEALED_PIN,
        "native_068_sql_sha256": qa.digest(MIGRATION),
        "audit_sha256": audit_id,
        "evidence_sha256": evidence_id,
        "all_original_native_physical_rows_verified": count,
        "fts_and_shadow_physical_rows_verified": fts,
        "all_original_native_physical_tables_witnessed": len(payload["physical"]),
        "direct_scope_originals_archived": len(payload["scopes"]),
        "direct_scoped_tables": payload["direct_tables"],
        "indirect_declared_and_fixed_relationships_witnessed": len(payload["relations"]),
        "owner_attestations_registered": 0,
        "original_users_finance_stock_fts_cells_unchanged_except_proven_scopes": True,
        "sqlite_fk_and_integrity_healthy": True,
        "source_sqlite_file_connections": 0,
        "installed_profile_writes": 0,
        "native_authenticated_import_authorized": False,
        "native_sqlx_migration_ledger_068_applied": False,
        "sql_only_migration_068_schema_verified": True,
    }
    report_path = result_dir / REPORT_NAME
    with report_path.open("x", encoding="utf-8") as file:
        json.dump(report, file, indent=2, sort_keys=True)
        file.write("\n")
    report["report"] = str(report_path)
    report["report_sha256"] = qa.digest(report_path)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--normalized", type=Path, required=True)
    parser.add_argument("--normalized-sha256", required=True)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(produce(
            source=args.source, source_sha256=args.source_sha256,
            normalized=args.normalized, normalized_sha256=args.normalized_sha256,
        ), sort_keys=True))
        return 0
    except (qa.Refused, ValueError, OSError, sqlite3.Error, MemoryError) as exc:
        print(json.dumps({"status": "REFUSED_WITHOUT_SOURCE_MUTATION",
                          "reason": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
