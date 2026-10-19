"""Detached current-installed-derived native SQLx68 + reversible typed tenant stage.

The input SQLx68 database was migrated by the native Rust runtime, separately
from the current-installed-derived SQL-only v67 source. Both are immutable,
independently SHA-pinned disposable snapshots. This helper DOES NOT apply an
emulated SQLx migration or forge its ledger. It creates a NEW private copy,
normalizes only direct pharmacy_id fields, registers unsigned 068 typed/graph
evidence, and can roll back/reapply exact original literals on that copy.

None of these actions is owner authentication, RBAC enrollment, signed evidence
approval, or permission to deploy. 032 bootstrap credentials never leave RAM.
Never point this script at the installed customer profile or an existing stage.

  python -B -m scripts.qa_v02110_native_sqlx68_primary_scope_stage stage
  python -B -m scripts.qa_v02110_native_sqlx68_primary_scope_stage audit --stage NEW_FOLDER
  python -B -m scripts.qa_v02110_native_sqlx68_primary_scope_stage rollback --stage NEW_FOLDER
  python -B -m scripts.qa_v02110_native_sqlx68_primary_scope_stage normalize --stage NEW_FOLDER
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
from scripts import qa_v02110_native_primary_scope_068 as native
from scripts.qa_full_history_lineage import make_full_history_lineage

FORMAT = "pharma-v02110-current-native-sqlx68-typed-reversible-v1"
STAGE_PREFIX = "pharma-v02110-current-native-sqlx68-primary-scope-"
DATABASE_NAME = "NATIVE-SQLX68-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3"
NATIVE68_SHA = "94bdef17800a7f33e29c478c166beff92a0637f380b4bc632473dd652ec9c2b9"
CURRENT_V67_SHA = "12c7ef65c8c89ac473b309221c462f71589ce1bcca4ae928b0aaf430999f9880"
V67_SUBDIR = "pharma-v02110-current-v67-sql-rehearsal-7fe5928a6d9b4d45a7a86478946b0778"
V67_FILE = "current-v02109-to-v67-SQL-ONLY-NOT-AUTHORIZED.sqlite3"
NATIVE68_SUBDIR = "pharma-v02110-native-sqlx-068-current-data-34c78ae429ab4f0dacb4e777337d711b"
NATIVE68_FILE = "NATIVE-SQLX-068-DISPOSABLE-NOT-AUTHORIZED.sqlite3"
DESC = "primary_pharmacy_typed_scope_audit"
AUDIT_TABLES = (
    "native_primary_scope_audit_batches",
    "native_primary_scope_audit_originals",
    "native_primary_scope_audit_tables",
    "native_primary_scope_audit_relations",
    "native_primary_scope_audit_seals",
    "native_primary_scope_owner_attestations",
)


def sources() -> tuple[Path, Path, Path]:
    root = qa.disposable_root()
    return (root / V67_SUBDIR / V67_FILE,
            root / NATIVE68_SUBDIR / NATIVE68_FILE,
            root / qa.SEAL_PARENT / qa.SEAL_NAME)


def read_inputs() -> tuple[sqlite3.Connection, sqlite3.Connection, sqlite3.Connection]:
    p67, p68, sealed = sources()
    return (qa.memory_source(qa.checked_file(p67, CURRENT_V67_SHA)),
            qa.memory_source(qa.checked_file(p68, NATIVE68_SHA)),
            qa.memory_source(qa.checked_file(sealed, qa.SEALED_PIN, sealed=True)))


def verify_native68_migration(source: sqlite3.Connection,
                              migrated: sqlite3.Connection) -> None:
    qa.native_version(source)
    if len(qa.tables(source)) != 99:
        raise qa.Refused("Current-derived v67 original table inventory changed")
    recorded = list(migrated.execute(
        "SELECT version,description,success,checksum FROM _sqlx_migrations ORDER BY version"))
    if ([row[0] for row in recorded] != list(range(1, 69))
        or any(row[2] != 1 for row in recorded)):
        raise qa.Refused("Native SQLx migration ledger is not exactly v68")
    sql = native.MIGRATION.read_bytes()
    if recorded[-1] != (68, DESC, 1, hashlib.sha384(sql).digest()):
        raise qa.Refused("Native registered 068 checksum/description differs from frozen SQL")
    original_rows = list(qa.row_stream(source, "_sqlx_migrations"))
    new_rows = list(qa.row_stream(migrated, "_sqlx_migrations"))
    if len(new_rows) != len(original_rows) + 1 or any(
        not _same_row(a,b) for a,b in zip(original_rows, new_rows)
    ):
        raise qa.Refused("Native SQLx68 rewrote an original SQLx migration record")
    old_schema = qa.schema(source)
    new_schema = tuple(row for row in qa.schema(migrated)
                       if row[1] not in set(AUDIT_TABLES)
                       and row[2] not in set(AUDIT_TABLES)
                       and not row[1].startswith("native_primary_scope_audit_")
                       and not row[1].startswith("native_primary_scope_owner_attestation_"))
    if old_schema != new_schema:
        raise qa.Refused("Native SQLx68 changed a preexisting schema object")
    for name in AUDIT_TABLES:
        if migrated.execute(f"SELECT COUNT(*) FROM {qa.quote(name)}").fetchone() != (0,):
            raise qa.Refused("Native SQLx68 incorrectly minted an audit or owner attestation")
    qa.healthy(migrated)


def _same_row(a: tuple, b: tuple) -> bool:
    return len(a) == len(b) and all(qa.same(x, y) for x, y in zip(a, b))


def make_evidence(source: sqlite3.Connection, sealed: sqlite3.Connection) -> dict:
    """Build exact typed originals and 147 native source graph witnesses in RAM."""
    rehearsal = sqlite3.connect(":memory:")
    try:
        source.backup(rehearsal)
        prepared = qa.prepare(rehearsal, source, sealed, CURRENT_V67_SHA)
        changed = qa._mutate_scopes(rehearsal, restore=False)
        facts = qa.verify(source, rehearsal, sealed, CURRENT_V67_SHA)
        if changed != prepared["original_scope_rows"]:
            raise qa.Refused("Rehearsal scope count differs from archived typed originals")
        payload = native.evidence_payload(source, rehearsal)
        if len(payload["scopes"]) != changed or len(payload["relations"]) != 147:
            raise qa.Refused("Current v67 scope or indirect graph census changed")
        commitment = {
            "format": FORMAT,
            "source_v67_sha256": CURRENT_V67_SHA,
            "source_native68_sha256": NATIVE68_SHA,
            "sealed_v29_sha256": qa.SEALED_PIN,
            "native068_sql_sha256": qa.digest(native.MIGRATION),
            "physical": payload["physical"],
            "scopes": payload["scopes"],
            "relations": payload["relations"],
        }
        payload["audit_sha256"] = hashlib.sha256(native.canonical(commitment)).hexdigest()
        payload["evidence_sha256"] = hashlib.sha256(native.canonical([
            "pharma-native-sqlx68-primary-reversible-v1", payload["audit_sha256"],
            payload["physical"], payload["scopes"], payload["relations"],
        ])).hexdigest()
        payload["rehearsal"] = facts
        return payload
    finally:
        rehearsal.close()


def _registered_original_triggers(source: sqlite3.Connection) -> list[tuple[str, str]]:
    triggers = list(source.execute(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"))
    if not triggers or any(not definition for _, definition in triggers):
        raise qa.Refused("Cannot safely restore the native v67 financial triggers")
    return triggers


def mutate_scopes(candidate: sqlite3.Connection, source: sqlite3.Connection,
                  *, restore: bool) -> int:
    """Exact 068 typed original rollback/reapply; leave 068 immutability active.

    Temporarily suspend ONLY the original native v67 source triggers in a
    single rollback-safe transaction. All new 068 audit/attestation protection
    triggers remain active. Restore each original native trigger before commit.
    """
    original_triggers = _registered_original_triggers(source)
    candidate_triggers = dict(candidate.execute(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger'"))
    if any(candidate_triggers.get(n) != sql for n,sql in original_triggers):
        raise qa.Refused("Native source trigger definitions drifted")
    archives = list(candidate.execute(
        "SELECT source_table,source_rowid,original_literal "
        "FROM native_primary_scope_audit_originals ORDER BY source_table,source_rowid"))
    if not archives:
        raise qa.Refused("No exact typed scope archive exists")
    tables = set(qa.scope_tables(source))
    if set(t for t, _, _ in archives) - tables:
        raise qa.Refused("Unexpected table in permanent 068 typed archive")
    changed = 0
    with candidate:
        for name, _ in original_triggers:
            candidate.execute(f"DROP TRIGGER {qa.quote(name)}")
        if restore:
            for table, group in itertools.groupby(archives, key=lambda item: item[0]):
                cursor = candidate.executemany(
                    f"UPDATE {qa.quote(table)} SET pharmacy_id=? "
                    "WHERE rowid=? AND pharmacy_id=?",
                    ((literal,rowid,qa.TENANT) for _,rowid,literal in group))
                changed += cursor.rowcount
        else:
            for table in sorted(tables):
                candidate.execute(
                    f"UPDATE {qa.quote(table)} SET pharmacy_id=? WHERE pharmacy_id IS NOT ?",
                    (qa.TENANT,qa.TENANT))
                changed += candidate.execute("SELECT changes()").fetchone()[0]
        for _, definition in original_triggers:
            candidate.execute(definition)
        qa.healthy(candidate)
        if changed != len(archives):
            raise qa.Refused("Native scope transition is incomplete; transaction must revert")
    return changed


def register_evidence(candidate: sqlite3.Connection, payload: dict) -> None:
    """Insert into the EXISTING real native SQLx68 tables; never run SQL twice."""
    batch = payload["audit_sha256"]
    with candidate:
        candidate.execute("""INSERT INTO native_primary_scope_audit_batches
         (audit_sha256,original_v67_sha256,sealed_v29_sha256,
          observed_native_schema_version,original_physical_table_count,
          original_physical_row_count,expected_original_scope_count,
          expected_table_witness_count,expected_relation_witness_count)
         VALUES(?,?,?,67,?,?,?,?,?)""",
         (batch, CURRENT_V67_SHA, qa.SEALED_PIN, len(payload["physical"]),
          payload["whole_rows"], len(payload["scopes"]),len(payload["physical"]),
          len(payload["relations"])))
        candidate.executemany("""INSERT INTO native_primary_scope_audit_originals
            (audit_sha256,source_table,source_rowid,original_storage,original_literal,
             original_row_typed_sha256) VALUES(?,?,?,?,?,?)""",
            ((batch,*r) for r in payload["scopes"]))
        candidate.executemany("""INSERT INTO native_primary_scope_audit_tables
            (audit_sha256,source_table,original_physical_rows,directly_scoped,
             original_typed_rows_sha256,normalized_typed_rows_sha256)
            VALUES(?,?,?,?,?,?)""",
            ((batch,*r) for r in payload["physical"]))
        candidate.executemany("""INSERT INTO native_primary_scope_audit_relations
            (audit_sha256,relation_sha256,relation_kind,source_rows,matched_typed_rows,
             coerced_only_rows,missing_parent_rows,unlinked_rows,partial_null_rows,
             before_edge_sha256,after_edge_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            ((batch,*r) for r in payload["relations"]))
        candidate.execute(
            "INSERT INTO native_primary_scope_audit_seals(audit_sha256,evidence_sha256) VALUES(?,?)",
            (batch,payload["evidence_sha256"]))
        qa.healthy(candidate)


def _read_relationship_witness(source: sqlite3.Connection,
                               candidate: sqlite3.Connection) -> int:
    """Compare 147 original fixed/declared edges; ignore new 068 registry FKs."""
    original = make_full_history_lineage(source)
    staged = make_full_history_lineage(candidate)
    def projections(graph: dict):
        yield "FIXED",graph["fixed_relationships"]
        yield "DECLARED_FK",{r["opaque_relationship_id"]:r
                             for r in graph["declared_foreign_keys"]}
    old = dict(projections(original))
    new = dict(projections(staged))
    expected = {}
    for kind, source_edges in old.items():
        for key, data in source_edges.items():
            if new[kind].get(key) != data:
                raise qa.Refused("Original direct/indirect typed relationship changed")
            rid = hashlib.sha256(native.canonical(["pharma-068-relation",kind,key])).hexdigest()
            expected[rid] = (kind, hashlib.sha256(native.canonical(data)).hexdigest())
    observed = {row[0]:(row[1],row[2],row[3]) for row in candidate.execute(
        "SELECT relation_sha256,relation_kind,before_edge_sha256,after_edge_sha256 "
        "FROM native_primary_scope_audit_relations")}
    if len(expected) != 147 or len(observed) != 147:
        raise qa.Refused("Original indirect relationship witness count differs from 147")
    if any(observed.get(rid) != (kind,dig,dig)
           for rid,(kind,dig) in expected.items()):
        raise qa.Refused("Stored immutable relationship witness differs from actual source graph")
    # Counts alone do not establish the underlying typed edge evidence:
    # independently reconstruct all 147 original relation partitions.
    expected_full = native.relationship_evidence(source,source)
    observed_full = candidate.execute(
        "SELECT relation_sha256,relation_kind,source_rows,matched_typed_rows,"
        "coerced_only_rows,missing_parent_rows,unlinked_rows,partial_null_rows,"
        "before_edge_sha256,after_edge_sha256 "
        "FROM native_primary_scope_audit_relations ORDER BY relation_sha256").fetchall()
    if observed_full != expected_full:
        raise qa.Refused("Original typed indirect relationship partition was rewritten")
    return len(observed)


def verify_relationship_witness(source: sqlite3.Connection,
                                candidate: sqlite3.Connection) -> int:
    # The historic read-only lineage library sets PRAGMA query_only=ON on its
    # input and does not restore it. Preserve the candidate's prior mode so a
    # *verified* native disposable stage can roll back in a later statement.
    previous_mode = candidate.execute("PRAGMA query_only").fetchone()[0]
    try:
        return _read_relationship_witness(source,candidate)
    finally:
        candidate.execute(f"PRAGMA query_only={'ON' if previous_mode else 'OFF'}")


def audit(source: sqlite3.Connection, migrated: sqlite3.Connection,
          candidate: sqlite3.Connection) -> dict:
    """All 99 original tables, all typed cells/rowids, finance, FTS, v68 ledger."""
    verify_native68_migration(source, migrated)
    if qa.schema(candidate) != qa.schema(migrated):
        raise qa.Refused("Reversible candidate changed native 068 schema or trigger guards")
    if list(qa.tables(candidate)) != list(qa.tables(migrated)):
        raise qa.Refused("Candidate introduced or removed a physical native table")
    rows = list(candidate.execute(
        "SELECT audit_sha256,original_v67_sha256,sealed_v29_sha256,"
        "original_physical_table_count,original_physical_row_count,"
        "expected_original_scope_count,expected_relation_witness_count "
        "FROM native_primary_scope_audit_batches"))
    if len(rows) != 1 or rows[0][1:] != (
        CURRENT_V67_SHA,qa.SEALED_PIN,99,289816,7567,147):
        raise qa.Refused("Unexpected unsigned source custody batch")
    audit_id = rows[0][0]
    seal = candidate.execute(
        "SELECT evidence_sha256 FROM native_primary_scope_audit_seals WHERE audit_sha256=?",
        (audit_id,)).fetchone()
    if not seal or len(seal[0]) != 64:
        raise qa.Refused("Immutable typed batch not sealed")
    if candidate.execute("SELECT COUNT(*) FROM native_primary_scope_owner_attestations").fetchone() != (0,):
        raise qa.Refused("Signed owner attestation cannot be fabricated")
    for table in AUDIT_TABLES:
        if table != "native_primary_scope_owner_attestations" and candidate.execute(
            f"SELECT COUNT(DISTINCT audit_sha256) FROM {qa.quote(table)}"
        ).fetchone() != (1,):
            raise qa.Refused("Audit metadata contains more than one source batch")
    if candidate.execute("SELECT COUNT(*) FROM native_primary_scope_audit_originals").fetchone() != (7567,):
        raise qa.Refused("Exact typed rollback archive is not complete")
    expected_originals = {(t,rid):(storage,lit,dig) for t,rid,storage,lit,dig in
        candidate.execute(
            "SELECT source_table,source_rowid,original_storage,original_literal,"
            "original_row_typed_sha256 FROM native_primary_scope_audit_originals")}
    if len(expected_originals) != 7567:
        raise qa.Refused("Original scope archive contains duplicate physical identities")
    witnesses = {t:(count,scoped,old_digest,new_digest) for t,count,scoped,old_digest,new_digest in
        candidate.execute(
            "SELECT source_table,original_physical_rows,directly_scoped,"
            "original_typed_rows_sha256,normalized_typed_rows_sha256 "
            "FROM native_primary_scope_audit_tables")}
    source_tables = qa.tables(source)
    if len(witnesses) != len(source_tables) or set(witnesses) != set(source_tables):
        raise qa.Refused("Original physical table census incomplete")
    persisted_physical = list(candidate.execute(
        "SELECT source_table,original_physical_rows,directly_scoped,"
        "original_typed_rows_sha256,normalized_typed_rows_sha256 "
        "FROM native_primary_scope_audit_tables ORDER BY source_table"))
    persisted_scopes = list(candidate.execute(
        "SELECT source_table,source_rowid,original_storage,original_literal,"
        "original_row_typed_sha256 FROM native_primary_scope_audit_originals "
        "ORDER BY source_table,source_rowid"))
    persisted_relations = list(candidate.execute(
        "SELECT relation_sha256,relation_kind,source_rows,matched_typed_rows,"
        "coerced_only_rows,missing_parent_rows,unlinked_rows,partial_null_rows,"
        "before_edge_sha256,after_edge_sha256 "
        "FROM native_primary_scope_audit_relations ORDER BY relation_sha256"))
    committed = {"format":FORMAT,"source_v67_sha256":CURRENT_V67_SHA,
                 "source_native68_sha256":NATIVE68_SHA,
                 "sealed_v29_sha256":qa.SEALED_PIN,
                 "native068_sql_sha256":qa.digest(native.MIGRATION),
                 "physical":persisted_physical,"scopes":persisted_scopes,
                 "relations":persisted_relations}
    if hashlib.sha256(native.canonical(committed)).hexdigest()!=audit_id:
        raise qa.Refused("Stored scope and graph data break original batch SHA-256 commitment")
    expected_seal = hashlib.sha256(native.canonical([
        "pharma-native-sqlx68-primary-reversible-v1",audit_id,
        persisted_physical,persisted_scopes,persisted_relations])).hexdigest()
    if seal[0]!=expected_seal:
        raise qa.Refused("Stored typed scope audit seal does not match 068 evidence")
    source_scoped = set(qa.scope_tables(source))
    states = set()
    physically_checked = 0
    fts_checked = 0
    finance_cells = 0
    archive_visited = set()
    for table in source_tables:
        idx = qa.columns(source,table).index("pharmacy_id") + 1 if table in source_scoped else -1
        before_stream = qa.row_stream(source,table)
        after_stream = qa.row_stream(candidate,table)
        src_count, src_digest = native.physical_table_digest(source,table)
        src_evidence = witnesses[table]
        if (src_count, int(table in source_scoped), src_digest) != src_evidence[:3]:
            raise qa.Refused("Source physical table commitment no longer matches")
        before_h = hashlib.sha256()
        after_h = hashlib.sha256()
        normalized_h = hashlib.sha256()
        count = 0
        for before, after in itertools.zip_longest(before_stream,after_stream,fillvalue=None):
            if before is None or after is None:
                if table != "_sqlx_migrations" or before is not None or after is None or after[1]!=68:
                    raise qa.Refused("Native physical row missing or added")
                continue
            if len(before) != len(after):
                raise qa.Refused("Native physical schema changed")
            original_key = (table,before[0]) if idx>=0 else None
            entry = expected_originals.get(original_key)
            if entry:
                archive_visited.add(original_key)
                old_type, literal, rowhash = entry
                if old_type != qa.typed(before[idx])[0] or not qa.same(before[idx], literal):
                    raise qa.Refused("Original typed direct scope escrow mismatch")
                if native.typed_row_digest(before) != rowhash:
                    raise qa.Refused("Original physical row SHA witness mismatch")
                normalized = qa.same(after[idx],qa.TENANT)
                restored = qa.same(after[idx],before[idx])
                if not normalized and not restored:
                    raise qa.Refused("Historical scope literal neither normalized nor exact original")
                states.add("NORMALIZED" if normalized else "ROLLED_BACK")
            for i,(a,b) in enumerate(zip(before,after)):
                if idx==i and entry:
                    continue
                if not qa.same(a,b):
                    raise qa.Refused("Non-scope financial/stock/FTS cell or rowid changed")
            native._frame(after_h,bytes.fromhex(native.typed_row_digest(after)))
            native._frame(before_h,bytes.fromhex(native.typed_row_digest(before)))
            expected_row = list(before)
            if entry:
                expected_row[idx] = qa.TENANT
            native._frame(normalized_h,bytes.fromhex(native.typed_row_digest(tuple(expected_row))))
            count+=1
            physically_checked+=1
            if "fts" in table:
                fts_checked+=1
            if any(term in table for term in (
                "sale","purchase","cash","journal","account","stock",
                "inventory","return","payment","balance","finance")):
                finance_cells+=len(before)-int(idx>=0)
        if count != src_count or before_h.hexdigest()!=src_digest:
            raise qa.Refused("Physical original row digest/count differs")
        if normalized_h.hexdigest()!=src_evidence[3]:
            raise qa.Refused("Recorded normalized typed-row digest not reproducible from originals")
        if table != "_sqlx_migrations":
            if after_h.hexdigest() != src_evidence[3 if states=={"NORMALIZED"} else 2]:
                raise qa.Refused("Physical native 068 typed audit digest changed")
        else:
            if list(qa.row_stream(candidate,table)) != list(qa.row_stream(migrated,table)):
                raise qa.Refused("Native SQLx68 ledger changed during scope repair")
    if states not in ({"NORMALIZED"},{"ROLLED_BACK"}):
        raise qa.Refused("Direct scopes are mixed; atomic reversal required")
    if physically_checked != 289816 or fts_checked != 49658 or len(archive_visited)!=7567:
        raise qa.Refused("Original native v67 table/FTS/typed archive coverage differs")
    # Confirm every *original* native SQLx68 row remains exactly as it was,
    # including all newly created 068 audit structures and schema definitions.
    if candidate.execute("SELECT COUNT(*),MAX(version) FROM _sqlx_migrations").fetchone() != (68,68):
        raise qa.Refused("Native version68 migration history incomplete")
    if candidate.execute("SELECT COUNT(*) FROM native_primary_scope_audit_relations").fetchone() != (147,):
        raise qa.Refused("Indirect relationship witness count changed")
    relations = verify_relationship_witness(source,candidate)
    qa.healthy(candidate)
    return {"phase": next(iter(states)),"native_sqlx_version":68,
            "native_068_sql_sha256":qa.digest(native.MIGRATION),
            "native_068_sha384":hashlib.sha384(native.MIGRATION.read_bytes()).hexdigest(),
            "typed_original_physical_rows":physically_checked,
            "original_physical_tables":len(source_tables),
            "typed_financial_stock_and_account_cells":finance_cells,
            "fts_shadow_and_virtual_rows":fts_checked,
            "reversible_original_scope_literals":len(archive_visited),
            "direct_scoped_tables":len(source_scoped),
            "original_direct_and_indirect_link_witnesses":relations,
            "owner_attestations":0,
            "sqlite_integrity_and_foreign_keys":True}


def stage_dir(path: Path | None) -> Path:
    root = qa.disposable_root()
    if path is None:
        return root/(STAGE_PREFIX+uuid.uuid4().hex)
    if path.name == DATABASE_NAME:
        path = path.parent
    if (path.parent.resolve(strict=True)!=root.resolve(strict=True)
        or path.is_symlink()
        or not path.name.startswith(STAGE_PREFIX)):
        raise qa.Refused("Stage must be an isolated direct child of disposable root")
    return path


def run(action: str, *, folder: Path | None = None) -> dict:
    if action not in ("stage","audit","rollback","normalize"):
        raise qa.Refused("Invalid native SQLx68 scope action")
    path = stage_dir(folder)
    if action == "stage" and path.exists():
        raise qa.Refused("Never overwrite an existing disposable native stage")
    if action != "stage" and not path.is_dir():
        raise qa.Refused("Existing disposable native stage folder required")
    p67,p68,p29 = sources()
    with closing(qa.memory_source(qa.checked_file(p67,CURRENT_V67_SHA))) as before, \
         closing(qa.memory_source(qa.checked_file(p68,NATIVE68_SHA))) as migrated, \
         closing(qa.memory_source(qa.checked_file(p29,qa.SEALED_PIN,sealed=True))) as sealed:
        verify_native68_migration(before,migrated)
        if action == "stage":
            payload = make_evidence(before,sealed)
            path.mkdir(mode=0o700)
            target = path/DATABASE_NAME
            with closing(sqlite3.connect(target)) as candidate:
                migrated.backup(candidate)
                register_evidence(candidate,payload)
                changed = mutate_scopes(candidate,before,restore=False)
                result = audit(before,migrated,candidate)
            if changed != 7567:
                raise qa.Refused("Native current-history stage did not normalize 7567 originals")
        else:
            target=path/DATABASE_NAME
            if (not target.is_file() or any(Path(str(target)+suffix).exists()
                for suffix in ("-wal","-shm","-journal")) or target.stat().st_nlink!=1):
                raise qa.Refused("Only a clean private offline native scope stage may be reopened")
            qa._safe_component(path)
            qa._safe_component(target)
            with closing(sqlite3.connect(target)) as candidate:
                prior = audit(before,migrated,candidate)
                if action=="rollback" and prior["phase"]=="NORMALIZED":
                    changed = mutate_scopes(candidate,before,restore=True)
                elif action=="normalize" and prior["phase"]=="ROLLED_BACK":
                    changed = mutate_scopes(candidate,before,restore=False)
                else:
                    changed = 0
                result = audit(before,migrated,candidate)
                if action == "rollback" and result["phase"]!="ROLLED_BACK":
                    raise qa.Refused("Rollback did not restore original typed scopes")
                if action == "normalize" and result["phase"]!="NORMALIZED":
                    raise qa.Refused("Normalization did not restore primary_pharmacy")
                if changed not in (0,7567):
                    raise qa.Refused("Partial scope transition blocked")
        if qa.digest(p67)!=CURRENT_V67_SHA or qa.digest(p68)!=NATIVE68_SHA or qa.digest(p29)!=qa.SEALED_PIN:
            raise qa.Refused("Pinned source changed during isolated native staging")
    report = {"status":"ISOLATED_NATIVE_SQLX68_PRIMARY_PHARMACY_TYPED_REVERSIBLE_NO_OWNER_GRANT",
              "action":action,"stage":str(path),"candidate":str(target),
              "candidate_sha256":qa.digest(target),"current_installed_derived_v67_sha256":CURRENT_V67_SHA,
              "native_runtime_sqlx68_source_sha256":NATIVE68_SHA,
              "sealed_v29_sha256":qa.SEALED_PIN,
              "scope_cells_changed_this_action":changed,
              "original_sources_modified":False,
              "installed_customer_profile_modified":False,
              "original_owner_authenticated_or_enrolled":False,
              "native_verified_owner_import_performed":False,
              "verification":result}
    audit_path=path/(
        "NATIVE_SQLX68_STAGED_PRIMARY_SCOPE.json" if action=="stage"
        else f"NATIVE_SQLX68_{action.upper()}_{uuid.uuid4().hex}.json")
    with audit_path.open("x",encoding="utf-8") as stream:
        json.dump(report,stream,indent=2,sort_keys=True)
        stream.write("\n")
    report["record_path"]=str(audit_path)
    report["record_sha256"]=qa.digest(audit_path)
    return report


def main(argv: list[str] | None = None) -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=("stage","audit","rollback","normalize"))
    parser.add_argument("--stage",type=Path)
    options=parser.parse_args(argv)
    try:
        if options.action!="stage" and options.stage is None:
            raise qa.Refused("An existing isolated --stage folder is required")
        print(json.dumps(run(options.action,folder=options.stage),sort_keys=True))
        return 0
    except (qa.Refused,ValueError,sqlite3.Error,OSError,MemoryError) as exc:
        print(json.dumps({"status":"REFUSED_WITHOUT_SOURCE_MUTATION",
                          "reason":str(exc)},sort_keys=True),file=sys.stderr)
        return 2


if __name__=="__main__":
    raise SystemExit(main())
