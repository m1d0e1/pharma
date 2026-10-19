"""Reversible primary_pharmacy physical-scope audit on a DISPOSABLE native v67 clone.

Only a SHA-pinned, WAL-detached SQLite source in the private disposable-copy root
is read, via OS bytes -> private RAM deserialize. SQLite never opens the source
file. A fresh private stage receives all writes. The sealed v29 source supplies
the *original* 032 owner credential and 052 user scopes to an audit-only escrow;
it is never used to authenticate anyone or restore a credential to v67.

Commands:
  python -B -m scripts.qa_v02110_primary_pharmacy_migration check
  python -B -m scripts.qa_v02110_primary_pharmacy_migration stage
  python -B -m scripts.qa_v02110_primary_pharmacy_migration audit --stage PATH
  python -B -m scripts.qa_v02110_primary_pharmacy_migration rollback --stage PATH
  python -B -m scripts.qa_v02110_primary_pharmacy_migration normalize --stage PATH

For an independently WAL-consistent detached snapshot, the read-only `check`
accepts v29-v69 native SQLx ledgers, including v52 profiles. The mutation/
rollback rehearsal remains limited to *v67* and additionally requires the
separately sealed v29 source. Supply --source PATH --source-sha256 HEX. The file
must already be under the disposable root; live APPDATA and sealed v29 cannot
be selected. Never install the QA output. No migration SQL, application
profile, license or permissions are changed; structural eligibility cannot
grant tenant ownership or RBAC.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import struct
import sys
import uuid

from scripts.qa_v02110_single_scope_rehearsal import (
    SOURCE_FILENAME, SOURCE_PIN, SOURCE_SUBFOLDER,
)
from scripts.qa_v02110_one_tenant_review_packet import (
    PIN as SEALED_PIN, SEAL_NAME, SEAL_PARENT,
)

TENANT = "primary_pharmacy"
STAGE_PREFIX = "pharma-v02110-primary-pharmacy-migration-"
DATABASE_NAME = "DISPOSABLE-primary-pharmacy-v67.sqlite3"
AUDIT_TABLES = frozenset({"qa_primary_scope_originals", "qa_primary_scope_meta",
                          "qa_sealed_032_052_user_originals"})
SHA = re.compile(r"[0-9a-f]{64}\Z")
MAX_FILE_BYTES = 700_000_000
MAX_TABLES = 512
MAX_ROWS = 3_000_000


class Refused(ValueError):
    """No unsafe source, stage, schema, or custody transition is permitted."""


def quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def digest(data: bytes | Path) -> str:
    h = hashlib.sha256()
    if isinstance(data, bytes):
        h.update(data)
    else:
        with data.open("rb") as handle:
            for part in iter(lambda: handle.read(1024 * 1024), b""):
                h.update(part)
    return h.hexdigest()


def disposable_root() -> Path:
    return Path(os.environ["LOCALAPPDATA"]) / "pharma-disposable-data-copies"


def _safe_component(path: Path) -> None:
    st = path.lstat()
    if stat.S_ISLNK(st.st_mode) or (getattr(st, "st_file_attributes", 0)
                                  & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)):
        raise Refused("Filesystem aliases or reparse points are forbidden")


def checked_file(path: Path, expected_sha: str, *, sealed: bool = False) -> bytes:
    """Read a detached immutable snapshot without a disk-backed SQLite handle."""
    root = disposable_root()
    if not SHA.fullmatch(expected_sha) or not root.is_dir():
        raise Refused("Detached snapshot must have an independent 64-digit SHA pin")
    if not path.is_file() or path.resolve(strict=True) == path.parent.resolve(strict=True):
        raise Refused("Detached SQLite snapshot is missing")
    resolved_root = root.resolve(strict=True)
    if not path.resolve(strict=True).is_relative_to(resolved_root):
        raise Refused("Only disposable snapshots can be source inputs")
    node = path
    while node != root:
        _safe_component(node)
        node = node.parent
        if len(node.parts) < len(root.parts):
            raise Refused("Snapshot parent escaped approved disposable root")
    _safe_component(root)
    if sealed and path.resolve(strict=True) != (root / SEAL_PARENT / SEAL_NAME).resolve(strict=True):
        raise Refused("SEALED owner originals must come from the exact retained v29")
    if not sealed and path.resolve(strict=True) == (root / SEAL_PARENT / SEAL_NAME).resolve(strict=False):
        raise Refused("Sealed v29 must not masquerade as the native v67 source")
    if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise Refused("Snapshot has WAL or journal sidecars; first obtain a consistent detached copy")
    before = path.stat()
    if before.st_nlink != 1 or not 4096 <= before.st_size <= MAX_FILE_BYTES:
        raise Refused("Unexpected SQLite snapshot size or hardlinked input")
    data = path.read_bytes()
    after = path.stat()
    if (data[:16] != b"SQLite format 3\x00" or len(data) != before.st_size or
            (before.st_size, before.st_mtime_ns, before.st_ino) !=
            (after.st_size, after.st_mtime_ns, after.st_ino) or
            digest(data) != expected_sha or digest(path) != expected_sha):
        raise Refused("Detached snapshot changed or failed its SHA-256 pin")
    return data


def memory_source(raw: bytes) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    try:
        db.deserialize(raw)
        db.execute("PRAGMA query_only=ON")
        healthy(db)
    except BaseException:
        db.close()
        raise
    return db


def healthy(db: sqlite3.Connection) -> None:
    if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
        raise Refused("SQLite integrity check failed")
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise Refused("Foreign-key graph changed or was invalid")


def schema(db: sqlite3.Connection) -> tuple[tuple, ...]:
    return tuple(db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master "
                            "ORDER BY type,name,tbl_name,sql"))


def tables(db: sqlite3.Connection) -> list[str]:
    names = [r[0] for r in db.execute("SELECT name FROM sqlite_master "
                                   "WHERE type='table' ORDER BY name")]
    if len(names) > MAX_TABLES or len(set(names)) != len(names):
        raise Refused("Unsupported physical table inventory")
    return names


def columns(db: sqlite3.Connection, name: str) -> list[str]:
    # Hidden FTS control columns are ephemeral. Physical FTS shadow tables and
    # the virtual table's visible values + rowid are compared independently.
    return [r[1] for r in db.execute(f"PRAGMA table_xinfo({quote(name)})")
            if r[6] in (0, 2, 3)]


def row_stream(db: sqlite3.Connection, name: str):
    info = list(db.execute(f"PRAGMA table_info({quote(name)})"))
    cols = columns(db, name)
    fields = ",".join(quote(c) for c in cols)
    # WITHOUT ROWID tables have a deterministic typed PK ordering. Direct
    # scope edits require a real rowid and are rejected before any changes.
    without_rowid = bool(db.execute("SELECT wr FROM pragma_table_list WHERE name=?",
                                    (name,)).fetchone()[0])
    if without_rowid:
        pk = [r[1] for r in sorted(info, key=lambda r: r[5]) if r[5] > 0]
        if not pk:
            raise Refused("WITHOUT ROWID table missing SQLite primary key")
        return db.execute(f"SELECT {fields} FROM {quote(name)} ORDER BY " +
                          ",".join(quote(x) for x in pk))
    aliases = [n for n in ("_rowid_", "rowid", "oid") if n not in cols]
    if not aliases:
        raise Refused("Rowid is shadowed by all conventional aliases")
    rid = aliases[0]
    return db.execute(f"SELECT {rid},{fields} FROM {quote(name)} ORDER BY {rid}")


def typed(value: object) -> tuple[str, bytes]:
    """Byte-exact SQLite storage comparison including signed floating zero."""
    if value is None:
        return "null", b""
    if type(value) is int:
        return "integer", str(value).encode("ascii")
    if type(value) is float:
        return "real", struct.pack("!d", value)
    if type(value) is str:
        return "text", value.encode("utf-8")
    if type(value) is bytes:
        return "blob", value
    raise Refused("Unsupported SQLite cell storage type")


def same(left: object, right: object) -> bool:
    return typed(left) == typed(right)


def scope_tables(db: sqlite3.Connection) -> list[str]:
    return [name for name in tables(db) if "pharmacy_id" in columns(db, name)]


def assert_single_pharmacy_source(db: sqlite3.Connection) -> dict[str, int]:
    """Reject any competing or ambiguous direct scope before candidate normalization.

    This verifies *structural eligibility only*. A single visible tenant is not
    proof of ownership: the signed-owner and licensed operational release gates
    remain separate. Never silently merge foreign, mixed-case, numeric or BLOB
    identifiers merely because the user expects one pharmacy.
    """
    counts = {"null": 0, "blank": 0, "local_default": 0, TENANT: 0}
    scoped = scope_tables(db)
    if not scoped or "users" not in scoped:
        raise Refused("No explicit single-pharmacy owner/scope schema")
    for name in scoped:
        # Stream values so a large historical database does not materialize
        # private patient, invoice or journal records in diagnostic output.
        for (value,) in db.execute(
            f"SELECT pharmacy_id FROM {quote(name)}"
        ):
            if value is None:
                kind = "null"
            elif type(value) is str and not value.strip():
                kind = "blank"
            elif type(value) is str and value in ("local_default", TENANT):
                kind = value
            else:
                # An unknown explicit ID, case-folded alias, numeric/blob
                # or malformed scope is NOT a one-pharmacy ownership grant.
                raise Refused(
                    "Direct scope includes a foreign/ambiguous tenant; "
                    "independent review required"
                )
            counts[kind] += 1
    owners = db.execute(
        "SELECT CAST(id AS TEXT),pharmacy_id,COALESCE(is_active,1) "
        "FROM users WHERE lower(trim(COALESCE(role,'')))='owner' "
        "AND COALESCE(is_active,1)=1"
    ).fetchall()
    if len(owners) != 1 or owners[0][2] != 1:
        raise Refused("Exactly one active original owner is required for single-pharmacy QA")
    if type(owners[0][1]) is not str and owners[0][1] is not None:
        raise Refused("Owner tenant is not a recognized text/null scope")
    return counts


def read_only_native_version(db: sqlite3.Connection) -> int:
    """Conservatively check an older native ledger without granting authority.

    A contiguous SUCCESS-only ledger is necessary, but not sufficient, for
    migration: Rust SQLx still checks every registered checksum on an approved
    detached stage. This read-only operation never rewrites an old checksum.
    """
    exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' "
                        "AND name='_sqlx_migrations'").fetchone()
    if exists is None:
        raise Refused("Native migration ledger is missing; manual custody review required")
    records = list(db.execute(
        "SELECT version,success,typeof(version),typeof(success) "
        "FROM _sqlx_migrations ORDER BY version"
    ))
    if (not 29 <= len(records) <= 69 or
            any(type(version) is not int or type(success) is not int or
                success != 1 or storage != "integer" or result_type != "integer" or
                version != position
                for position, (version, success, storage, result_type)
                in enumerate(records, 1))):
        raise Refused("Native migration ledger is incomplete, failed or unsupported")
    return len(records)


def native_version(db: sqlite3.Connection) -> None:
    if read_only_native_version(db) != 67:
        raise Refused("Only fully migrated native v67 copies are supported")


def sealed_version(db: sqlite3.Connection) -> None:
    versions = [r[0] for r in db.execute("SELECT version FROM _sqlx_migrations "
                                           "WHERE success=1 ORDER BY version")]
    if versions != list(range(1, 30)):
        raise Refused("Original sealed owner custody must be v29")


def custody_rows(sealed: sqlite3.Connection):
    """All 052 user scopes, and only the original 032 owner's credential hash.

    This evidence is stored exclusively in an audit table; rollback never
    copies these password hashes into the native users table.
    """
    fields = "rowid,id,role,typeof(pharmacy_id),pharmacy_id,typeof(password_hash),password_hash"
    for rowid, user_id, role, scope_type, scope, password_type, password in sealed.execute(
        f"SELECT {fields} FROM users ORDER BY rowid"
    ):
        owner = isinstance(role, str) and role.lower() == "owner"
        yield (rowid, user_id, scope_type, scope,
               password_type if owner else None, password if owner else None)


def prepare(candidate: sqlite3.Connection, source: sqlite3.Connection,
            sealed: sqlite3.Connection, source_sha: str) -> dict:
    """Archive every literal before changing one row. Only on private candidate."""
    native_version(source)
    sealed_version(sealed)
    eligibility = assert_single_pharmacy_source(source)
    if AUDIT_TABLES.intersection(tables(source)):
        raise Refused("Source already has QA-owned metadata names")
    scoped = scope_tables(source)
    if any(source.execute("SELECT wr FROM pragma_table_list WHERE name=?",
                          (t,)).fetchone()[0] for t in scoped):
        raise Refused("Direct scope in WITHOUT ROWID table cannot be archived safely")
    if not scoped:
        raise Refused("Source has no directly scoped tables")
    with candidate:
        candidate.execute("""CREATE TABLE qa_primary_scope_originals (
            source_table TEXT NOT NULL, source_rowid INTEGER NOT NULL,
            original_storage TEXT NOT NULL, original_literal BLOB,
            source_sha256 TEXT NOT NULL,
            PRIMARY KEY(source_table,source_rowid)
        ) WITHOUT ROWID""")
        candidate.execute("""CREATE TABLE qa_sealed_032_052_user_originals (
            sealed_user_rowid INTEGER PRIMARY KEY, sealed_user_id BLOB NOT NULL,
            original_scope_storage TEXT NOT NULL, original_scope_literal BLOB,
            original_owner_password_storage TEXT, original_owner_password_literal BLOB,
            sealed_source_sha256 TEXT NOT NULL
        )""")
        candidate.execute("""CREATE TABLE qa_primary_scope_meta (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            phase TEXT NOT NULL CHECK(phase IN ('PREPARED','NORMALIZED','ROLLED_BACK')),
            source_sha256 TEXT NOT NULL, sealed_sha256 TEXT NOT NULL,
            proposed_tenant TEXT NOT NULL,
            original_direct_scope_count INTEGER NOT NULL,
            original_physical_table_count INTEGER NOT NULL
        )""")
        original_count = 0
        for name in scoped:
            tq = quote(name)
            candidate.execute(f"""INSERT INTO qa_primary_scope_originals
                SELECT ?,rowid,typeof(pharmacy_id),pharmacy_id,?
                FROM {tq} WHERE pharmacy_id IS NOT ?""",
                (name, source_sha, TENANT))
            original_count += candidate.execute("SELECT changes()").fetchone()[0]
        candidate.executemany("""INSERT INTO qa_sealed_032_052_user_originals
            VALUES(?,?,?,?,?,?,?)""",
            (r + (SEALED_PIN,) for r in custody_rows(sealed)))
        candidate.execute("INSERT INTO qa_primary_scope_meta VALUES(1,'PREPARED',?,?,?,?,?)",
                          (source_sha, SEALED_PIN, TENANT, original_count,
                           len(tables(source))))
    return {"direct_tables": len(scoped), "original_scope_rows": original_count,
            "single_pharmacy_scope_classes": eligibility,
            "sealed_user_scope_originals": candidate.execute(
                "SELECT COUNT(*) FROM qa_sealed_032_052_user_originals").fetchone()[0]}


def _phase(db: sqlite3.Connection) -> tuple:
    rows = db.execute("SELECT phase,source_sha256,sealed_sha256,proposed_tenant,"
                      "original_direct_scope_count,original_physical_table_count "
                      "FROM qa_primary_scope_meta WHERE singleton=1").fetchall()
    if len(rows) != 1 or rows[0][2:4] != (SEALED_PIN, TENANT):
        raise Refused("QA stage metadata does not identify required custody/tenant")
    return rows[0]


def _mutate_scopes(candidate: sqlite3.Connection, *, restore: bool) -> int:
    """Drop and recreate native triggers inside a single rollback-safe transaction.

    Native v67 uses UPDATE guards on financial/stock provenance; this QA-only
    suspension is needed to change *all* directly scoped historical rows. Native
    definitions are restored before commit. FK checks run after all table scopes
    have converged, avoiding temporary parent/child mismatches.
    """
    current = _phase(candidate)
    if current[0] == ("ROLLED_BACK" if restore else "NORMALIZED"):
        return 0
    if restore and current[0] != "NORMALIZED":
        raise Refused("Only a fully normalized candidate can roll back")
    if not restore and current[0] not in ("PREPARED", "ROLLED_BACK"):
        raise Refused("Unknown normalization phase")
    changed = 0
    if candidate.in_transaction:
        raise Refused("QA stage requires a dedicated clean write transaction")
    with candidate:
        # Acquire the SQLite RESERVED writer lock before rechecking source
        # eligibility. A SELECT-only Python context manager does not do that.
        candidate.execute("BEGIN IMMEDIATE")
        if _phase(candidate) != current:
            raise Refused("QA scope metadata changed before write reservation")
        triggers = candidate.execute(
            "SELECT name,sql FROM sqlite_master "
            "WHERE type='trigger' ORDER BY name"
        ).fetchall()
        if any(not sql for _, sql in triggers):
            raise Refused("Trigger without restorable source SQL")
        scoped = scope_tables(candidate)
        if not restore:
            # PREPARED can be reopened. Check under the writer lock and
            # BEFORE any trigger drop or UPDATE.
            assert_single_pharmacy_source(candidate)
        for name, _ in triggers:
            candidate.execute(f"DROP TRIGGER {quote(name)}")
        if restore:
            records = candidate.execute("SELECT source_table,source_rowid,original_literal "
                                        "FROM qa_primary_scope_originals "
                                        "ORDER BY source_table,source_rowid").fetchall()
            for table, group in itertools.groupby(records, key=lambda r: r[0]):
                if table not in scoped:
                    raise Refused("Archive table is absent from original direct scopes")
                cursor = candidate.executemany(
                    f"UPDATE {quote(table)} SET pharmacy_id=? WHERE rowid=? AND pharmacy_id=?",
                    ((literal, rowid, TENANT) for _, rowid, literal in group))
                changed += cursor.rowcount
        else:
            for name in scoped:
                candidate.execute(f"UPDATE {quote(name)} SET pharmacy_id=? "
                                  "WHERE pharmacy_id IS NOT ?", (TENANT, TENANT))
                changed += candidate.execute("SELECT changes()").fetchone()[0]
        for _, definition in triggers:
            candidate.execute(definition)
        candidate.execute("UPDATE qa_primary_scope_meta SET phase=? WHERE singleton=1",
                          ("ROLLED_BACK" if restore else "NORMALIZED",))
        healthy(candidate)
        if changed != current[4]:
            raise Refused("Direct scope row count changed during transaction")
    return changed


def verify(source: sqlite3.Connection, candidate: sqlite3.Connection,
           sealed: sqlite3.Connection, expected_sha: str) -> dict:
    """Compare *every* physical historical row and typed cell, including FTS.

    A difference in schema, rowid, cell type, bytes, precision or an unarchived
    scope aborts verification. All financial amounts/stock values participate.
    """
    healthy(source)
    healthy(candidate)
    native_version(candidate)
    original_schema = schema(source)
    staged_schema = tuple(item for item in schema(candidate)
                          if item[1] not in AUDIT_TABLES and item[2] not in AUDIT_TABLES)
    if original_schema != staged_schema:
        raise Refused("Native source schema, triggers, or indexes drifted")
    phase, pin, _, tenant, count, table_count = _phase(candidate)
    if pin != expected_sha or tenant != TENANT or table_count != len(tables(source)):
        raise Refused("Stage source/tenant commitment differs from archived source")
    originals = candidate.execute("SELECT source_table,source_rowid,"
                                  "original_storage,original_literal,source_sha256 "
                                  "FROM qa_primary_scope_originals "
                                  "ORDER BY source_table,source_rowid").fetchall()
    ledger = {(t, rid): (storage, literal) for t, rid, storage, literal, sha in originals
              if sha == pin}
    if len(originals) != count or len(ledger) != count:
        raise Refused("Scope original ledger is incomplete or duplicate")
    sealed_originals = list(custody_rows(sealed))
    escrow = candidate.execute("""SELECT sealed_user_rowid,sealed_user_id,
        original_scope_storage,original_scope_literal,
        original_owner_password_storage,original_owner_password_literal,
        sealed_source_sha256 FROM qa_sealed_032_052_user_originals
        ORDER BY sealed_user_rowid""").fetchall()
    if len(escrow) != len(sealed_originals) or any(
        not all(same(a, b) for a, b in zip(expected + (SEALED_PIN,), actual))
        for expected, actual in zip(sealed_originals, escrow)
    ):
        raise Refused("SEALED v29 032/052 originals changed in archival escrow")
    seen = set()
    rows_checked = 0
    scope_changed = 0
    finance_fields_checked = 0
    fts_rows_checked = 0
    for table in tables(source):
        src_cols = columns(source, table)
        if src_cols != columns(candidate, table):
            raise Refused("Native physical columns changed")
        idx = src_cols.index("pharmacy_id") + 1 if "pharmacy_id" in src_cols else -1
        has_rowid = not bool(source.execute("SELECT wr FROM pragma_table_list WHERE name=?",
                                            (table,)).fetchone()[0])
        # WITHOUT ROWID tables return only real columns.
        if not has_rowid and idx >= 0:
            raise Refused("Cannot prove scoped WITHOUT ROWID source identity")
        original = row_stream(source, table)
        staged = row_stream(candidate, table)
        for before, after in itertools.zip_longest(original, staged, fillvalue=None):
            if before is None or after is None or len(before) != len(after):
                raise Refused("Historical physical row appeared or disappeared")
            rows_checked += 1
            if rows_checked > MAX_ROWS:
                raise Refused("Physical verification exceeded bounded row budget")
            rid = before[0] if has_rowid else None
            if idx >= 0 and (table, rid) in ledger:
                seen.add((table, rid))
                storage, original_scope = ledger[(table, rid)]
                if storage != typed(before[idx])[0] or not same(before[idx], original_scope):
                    raise Refused("Archived typed scope differs from physical source")
            elif idx >= 0 and not same(before[idx], TENANT) and phase == "NORMALIZED":
                raise Refused("Changed source scope missing from original ledger")
            for i, (a, b) in enumerate(zip(before, after)):
                if idx == i and phase == "NORMALIZED" and (table, rid) in ledger:
                    if not same(b, TENANT):
                        raise Refused("Original scope was not normalized exactly")
                    if not same(a, b):
                        scope_changed += 1
                    continue
                if not same(a, b):
                    raise Refused("Historical non-scope rowid/cell changed")
            if any(word in table for word in ("sale", "purchase", "finance", "cash",
                                               "journal", "account", "stock", "inventory",
                                               "return", "payment", "balance")):
                finance_fields_checked += len(before) - int(idx >= 0)
            if "fts" in table:
                fts_rows_checked += 1
    if len(seen) != count or (phase == "NORMALIZED" and scope_changed != count):
        raise Refused("Source and escrow row coverage differ")
    if phase not in ("NORMALIZED", "ROLLED_BACK", "PREPARED"):
        raise Refused("Unknown QA stage phase")
    return {"phase": phase, "native_physical_tables_verified": len(tables(source)),
            "all_original_physical_rows_typed_verified": rows_checked,
            "scoped_literals_originals_archived": count,
            "direct_scope_cells_changed": scope_changed,
            "finance_stock_and_account_cells_typed_verified": finance_fields_checked,
            "fts_virtual_and_shadow_rows_verified": fts_rows_checked,
            "original_032_052_user_rows_escrowed": len(escrow),
            "foreign_keys_and_integrity_verified": True,
            "credentials_restored_or_permissions_granted": False}


def stage_path(root: Path, selected: Path | None = None) -> Path:
    if selected is None:
        return root / (STAGE_PREFIX + uuid.uuid4().hex)
    if (selected.name == DATABASE_NAME and selected.parent.name.startswith(STAGE_PREFIX)):
        selected = selected.parent
    if (not re.fullmatch(STAGE_PREFIX + r"[0-9a-f]{32}", selected.name) or
            selected.parent.resolve(strict=True) != root.resolve(strict=True) or
            selected.is_symlink()):
        raise Refused("Stage must have a unique folder directly under disposable root")
    return selected


def audit_graph_sidecar(source: sqlite3.Connection, folder: Path, source_sha: str) -> None:
    from scripts.qa_full_history_lineage import make_full_history_lineage
    report = make_full_history_lineage(source)
    summary = {
        "status": "INDEPENDENT_STRUCTURAL_GRAPH_AUDIT_NO_OWNERSHIP_GRANT",
        "source_sha256": source_sha,
        "coverage": report["coverage"],
        "nonconforming_fixed_links": {name: {"status": rel["status"],
            "source_rows_quarantined": rel.get("source_rows_quarantined", 0)}
            for name, rel in report["fixed_relationships"].items()
            if rel["status"] != "typed_structural_inspection_not_ownership"},
        "declared_fk_groups_checked": len(report["declared_foreign_keys"]),
        "ownership_certified": False,
        "permissions_granted": False,
    }
    with (folder / "INDEPENDENT_RELATION_GRAPH_NO_GRANT.json").open("x", encoding="utf-8") as stream:
        json.dump(summary, stream, indent=2, sort_keys=True)
        stream.write("\n")


def run(action: str, *, folder: Path | None = None,
        source: Path | None = None, source_sha256: str | None = None) -> dict:
    root = disposable_root()
    default = root / SOURCE_SUBFOLDER / SOURCE_FILENAME
    source = source or default
    expected = (source_sha256 or SOURCE_PIN).lower()
    if source != default and source_sha256 is None:
        raise Refused("Custom WAL-consistent snapshot requires independent SHA-256")
    # Supplying a different SHA for the retained default pin is forbidden.
    if source == default and expected != SOURCE_PIN:
        raise Refused("Pinned native v67 SHA cannot be overridden")
    source_raw = checked_file(source, expected)
    if action == "check":
        # Reusable historical-updater discovery phase, including the actual
        # v52 licensed-GUI blocker: no v29 archive or mutation is required.
        # Checksum validation / owner identity / migration remain separate.
        with closing(memory_source(source_raw)) as before:
            version = read_only_native_version(before)
            classes = assert_single_pharmacy_source(before)
            physical_tables = len(tables(before))
        if digest(source) != expected:
            raise Refused("Detached candidate changed during read-only eligibility check")
        return {
            "status": "SINGLE_PHARMACY_SCOPE_CANDIDATE_ONLY",
            "source_sha256": expected,
            "proposed_scope": TENANT,
            "native_version": version,
            "physical_tables": physical_tables,
            "direct_scoped_rows": sum(classes.values()),
            "scope_classes": classes,
            "ownership_verified": False,
            "registered_migration_checksums_verified": False,
            "migration_or_production_authorized": False,
            "source_file_sqlite_connections": 0,
            "installed_customer_profile_mutations": 0,
        }
    sealed = root / SEAL_PARENT / SEAL_NAME
    sealed_raw = checked_file(sealed, SEALED_PIN, sealed=True)
    path = stage_path(root, folder)
    with closing(memory_source(source_raw)) as before, closing(memory_source(sealed_raw)) as v29:
        native_version(before)
        sealed_version(v29)
        assert_single_pharmacy_source(before)
        if action == "stage":
            if path.exists() or path.is_symlink():
                raise Refused("Stage folder already exists; never overwrite a prior audit")
            path.mkdir(mode=0o700)
            candidate_path = path / DATABASE_NAME
            with closing(sqlite3.connect(candidate_path)) as db:
                before.backup(db)
                db.execute("PRAGMA foreign_keys=OFF")
                prep = prepare(db, before, v29, expected)
                changed = _mutate_scopes(db, restore=False)
                audit = verify(before, db, v29, expected)
            audit_graph_sidecar(before, path, expected)
        else:
            if not path.is_dir() or path.is_symlink():
                raise Refused("Only existing private disposable QA stages may be reopened")
            _safe_component(path)
            candidate_path = path / DATABASE_NAME
            _safe_component(candidate_path)
            if not candidate_path.is_file() or candidate_path.stat().st_nlink != 1 or any(Path(str(candidate_path) + ext).exists()
                                                  for ext in ("-wal", "-shm", "-journal")):
                raise Refused("Stage candidate must be a clean detached SQLite database")
            with closing(sqlite3.connect(candidate_path)) as db:
                if _phase(db)[1] != expected:
                    raise Refused("Source SHA does not match the stage archive")
                verify(before, db, v29, expected)  # refuse tampered stage before any mutation
                changed = (0 if action == "audit" else
                           _mutate_scopes(db, restore=(action == "rollback")))
                audit = verify(before, db, v29, expected)
            prep = None
    if digest(source) != expected or digest(sealed) != SEALED_PIN:
        raise Refused("An immutable source changed during the audit")
    result = {"status": "DISPOSABLE_PRIMARY_PHARMACY_SCOPE_REHEARSAL_ONLY",
              "action": action, "stage": str(path), "candidate": str(candidate_path),
              "candidate_sha256": digest(candidate_path),
              "source_sha256": expected, "sealed_v29_sha256": SEALED_PIN,
              "proposed_scope": TENANT, "rows_changed_this_action": changed,
              "verification": audit,
              "source_file_sqlite_connections": 0,
              "installed_customer_profile_mutations": 0,
              "native_authentication_or_authorization_approved": False}
    if prep is not None:
        result["prepared"] = prep
    # Each reversible operation keeps its own append-only evidence: an initial
    # report intentionally records the stage-time hash, while later rollback /
    # normalize commands record *their* current hash without rewriting history.
    record = path / ("STAGED_SCOPE_AUDIT.json" if action == "stage" else
                     f"QA_{action.upper()}_{uuid.uuid4().hex}.json")
    with record.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2, sort_keys=True)
        stream.write("\n")
    result["audit_record_path"] = str(record)
    result["audit_record_sha256"] = digest(record)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("check", "stage", "audit", "rollback", "normalize"))
    parser.add_argument("--stage", type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--source-sha256")
    options = parser.parse_args(argv)
    try:
        if options.action not in ("check", "stage") and options.stage is None:
            raise Refused("An existing --stage folder is required")
        result = run(options.action, folder=options.stage, source=options.source,
                     source_sha256=options.source_sha256)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (Refused, OSError, sqlite3.Error, MemoryError, ValueError) as exc:
        print(json.dumps({"status": "REFUSED_WITHOUT_SOURCE_MUTATION",
                          "reason": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
