"""Read-only, counts-only typed source-graph inspection of historical SQLite.

Every sqlite_master table, including global/child, virtual FTS and FTS shadow
tables, receives an opaque census entry. A matching key is *structural only*:
it does NOT establish tenant ownership, financial correctness, or permission to
copy any historical record. No row IDs, names, values or SQLite schema strings
obtained from the archive are emitted.

CLI use is restricted to the same approved detached, SHA-pinned, immutable
archive as qa_historical_archive_preflight.py. Synthetic callers can pass an
in-memory connection to make_full_history_lineage / verified_lineage.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from collections.abc import Callable

from scripts.qa_historical_archive_manifest import (
    MAX_ROWS, MAX_TABLES, MODULE_RELATIONSHIPS, RELATIONSHIPS,
    opaque_table_id, quote, table_family,
)
from scripts.qa_historical_archive_preflight import (
    SHA256, approved_archive, digest_file, read_only_connection,
)


def _opaque_edge(*parts: object) -> str:
    return hashlib.sha256(
        json.dumps(["pharma-structural-edge-v1", *parts],
                   ensure_ascii=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _count(db: sqlite3.Connection, sql: str) -> int:
    result = db.execute(sql).fetchone()
    return int(result[0]) if result else 0


def _table_columns(db: sqlite3.Connection, table: str) -> dict[str, dict]:
    rows = db.execute(f"PRAGMA table_xinfo({quote(table)})").fetchall()
    if not rows:
        raise ValueError("Historical lineage contains an unreadable table schema")
    return {
        row[1]: {
            "type": str(row[2] or "").upper(),
            "notnull": bool(row[3]),
            "pk": int(row[5]),
        }
        for row in rows
    }


def _id_summary(
    db: sqlite3.Connection, table: str, columns: dict[str, dict],
) -> dict:
    """Count NULL and duplicate *cast-text* key identities, never emit keys.

    SQLite allows different storage classes and even legacy schema layouts
    without a primary constraint. Grouping canonical text representations
    catches collisions such as INTEGER 1 and TEXT '1' that literal UNIQUE
    indexes with BLOB affinity can otherwise admit.
    """
    pk = sorted(
        (metadata["pk"], name)
        for name, metadata in columns.items() if metadata["pk"]
    )
    key = ["id"] if "id" in columns else [name for _, name in pk]
    if not key:
        return {"status": "no_declared_or_conventional_key"}
    table_q = quote(table)
    null_condition = " OR ".join(f"{quote(name)} IS NULL" for name in key)
    nonnull_condition = " AND ".join(f"{quote(name)} IS NOT NULL" for name in key)
    projection = ", ".join(f"CAST({quote(name)} AS TEXT)" for name in key)
    duplicates = _count(
        db,
        f"SELECT COALESCE(SUM(n-1),0) FROM "
        f"(SELECT COUNT(*) n FROM {table_q} WHERE {nonnull_condition} "
        f"GROUP BY {projection} HAVING COUNT(*)>1)"
    )
    nulls = _count(db, f"SELECT COUNT(*) FROM {table_q} WHERE {null_condition}")
    # For the conventional ID, blank values and incompatible storage types
    # remain suspicious even when no SQL PRIMARY KEY was declared.
    blanks = 0
    wrong_storage = 0
    if key == ["id"]:
        blanks = _count(
            db, f"SELECT COUNT(*) FROM {table_q} "
            f"WHERE typeof(id)='text' AND trim(id)=''"
        )
        declared = columns["id"]["type"]
        expected = (
            "integer" if "INT" in declared else
            "text" if any(token in declared for token in ("CHAR", "CLOB", "TEXT")) else
            "real" if any(token in declared for token in ("REAL", "FLOA", "DOUB")) else
            None
        )
        if expected is not None:
            wrong_storage = _count(
                db, f"SELECT COUNT(*) FROM {table_q} "
                f"WHERE id IS NOT NULL AND typeof(id)<>{json.dumps(expected)}"
            )
    return {
        "status": "id" if key == ["id"] else "composite_primary_key",
        "key_columns": len(key),
        "null_rows": nulls,
        "blank_id_rows": blanks,
        "noncanonical_storage_rows": wrong_storage,
        "cast_text_collision_rows": duplicates,
        "source_identity_authenticated": False,
    }


def _inspect_link(
    db: sqlite3.Connection,
    columns: dict[str, dict[str, dict]],
    counts: dict[str, int],
    child: str,
    source_columns: tuple[str, ...],
    parent: str,
    parent_columns: tuple[str, ...],
    required: bool,
) -> dict:
    base = {
        "source_table": opaque_table_id(child),
        "parent_table": opaque_table_id(parent),
        "key_columns": len(source_columns),
        "mandatory_reference": required,
    }
    if child not in columns:
        return {**base, "status": "missing_source_schema_quarantined",
                "source_rows_quarantined": 0}
    if parent not in columns:
        return {**base, "status": "missing_parent_schema_quarantined",
                "source_rows_quarantined": counts[child]}
    if (len(source_columns) != len(parent_columns)
            or not all(name in columns[child] for name in source_columns)
            or not all(name in columns[parent] for name in parent_columns)):
        return {**base, "status": "missing_link_column_quarantined",
                "source_rows_quarantined": counts[child]}

    # All column names originate in PRAGMA or a fixed code-owned tuple, and
    # are escaped as identifiers. Never format SQL with archive row content.
    refs = [f"c.{quote(name)}" for name in source_columns]
    targets = [f"p.{quote(name)}" for name in parent_columns]
    all_null = " AND ".join(f"{ref} IS NULL" for ref in refs)
    any_null = " OR ".join(f"{ref} IS NULL" for ref in refs)
    complete = f"NOT ({any_null})"
    strict_predicate = " AND ".join(
        f"typeof({source})=typeof({target}) "
        f"AND {target} COLLATE BINARY={source} COLLATE BINARY"
        for source, target in zip(refs, targets)
    )
    sqlite_predicate = " AND ".join(
        f"{target}={source}" for source, target in zip(refs, targets)
    )
    parent_q = quote(parent)
    strict_exists = f"EXISTS(SELECT 1 FROM {parent_q} p WHERE {strict_predicate})"
    sqlite_exists = f"EXISTS(SELECT 1 FROM {parent_q} p WHERE {sqlite_predicate})"
    row = db.execute(
        f"SELECT COUNT(*), "
        f"COALESCE(SUM(CASE WHEN {all_null} THEN 1 ELSE 0 END),0), "
        f"COALESCE(SUM(CASE WHEN ({any_null}) AND NOT ({all_null}) THEN 1 ELSE 0 END),0), "
        f"COALESCE(SUM(CASE WHEN {complete} AND {strict_exists} THEN 1 ELSE 0 END),0), "
        f"COALESCE(SUM(CASE WHEN {complete} AND NOT {strict_exists} "
        f"AND {sqlite_exists} THEN 1 ELSE 0 END),0), "
        f"COALESCE(SUM(CASE WHEN {complete} AND NOT {sqlite_exists} THEN 1 ELSE 0 END),0) "
        f"FROM {quote(child)} c"
    ).fetchone()
    total, all_missing, partial, matched, coerced, orphan = map(int, row)
    # Each child row is accounted for once: a complete source is matched,
    # coercion-only or missing. A partially populated composite is neither a
    # valid reference nor a valid fully-unlinked optional relationship.
    if total != all_missing + partial + matched + coerced + orphan:
        raise ValueError("Historical lineage source graph could not be partitioned")
    return {
        **base,
        "status": "typed_structural_inspection_not_ownership",
        "source_rows": total,
        "matched_typed_rows": matched,
        "coercion_only_parent_rows": coerced,
        "missing_parent_rows": orphan,
        "missing_mandatory_reference_rows": (all_missing + partial) if required else 0,
        "optional_unlinked_rows": all_missing if not required else 0,
        "partial_null_reference_rows": partial,
        "historical_source_certified": False,
    }


def _declared_edges(
    db: sqlite3.Connection,
    columns: dict[str, dict[str, dict]],
    counts: dict[str, int],
) -> list[dict]:
    results = []
    for child in sorted(columns):
        fk_rows = db.execute(f"PRAGMA foreign_key_list({quote(child)})").fetchall()
        grouped: dict[int, list[tuple]] = defaultdict(list)
        for row in fk_rows:
            grouped[int(row[0])].append(row)
        for fk_id, parts in sorted(grouped.items()):
            parts.sort(key=lambda row: int(row[1]))
            parent = str(parts[0][2])
            from_cols = tuple(str(item[3]) for item in parts)
            # An omitted referenced column means the parent's PK in SQLite.
            to_cols = tuple(str(item[4]) if item[4] is not None else ""
                            for item in parts)
            parent_pk = sorted(
                (meta["pk"], key)
                for key, meta in columns.get(parent, {}).items() if meta["pk"]
            )
            if any(not name for name in to_cols) and len(parent_pk) == len(parts):
                to_cols = tuple(
                    [name if name else parent_pk[index][1]
                     for index, name in enumerate(to_cols)]
                )
            mandatory = any(
                columns[child].get(name, {}).get("notnull", False)
                for name in from_cols
            )
            detail = _inspect_link(
                db, columns, counts, child, from_cols, parent, to_cols, mandatory
            )
            results.append({
                "opaque_relationship_id": _opaque_edge(
                    child, fk_id, parent, from_cols, to_cols
                ),
                "kind": "declared_foreign_key",
                **detail,
            })
    return results


def _fts_summary(
    db: sqlite3.Connection,
    columns: dict[str, dict[str, dict]],
    counts: dict[str, int],
) -> dict:
    # FTS5 with external content can expose ordinary content rows through the
    # virtual table even when the index is stale. Count only structural rowid
    # candidates; *never* perform its writing 'integrity-check' control INSERT.
    if "master_drugs_fts" not in columns:
        return {"status": "fts_virtual_table_absent_quarantined",
                "fts_index_contents_verified": False}
    if "master_drugs" not in columns or "id" not in columns["master_drugs"]:
        return {"status": "fts_catalog_reference_unavailable_quarantined",
                "fts_rows_quarantined": counts["master_drugs_fts"],
                "fts_index_contents_verified": False}
    orphan = _count(
        db, 'SELECT COUNT(*) FROM "master_drugs_fts" f '
        'WHERE NOT EXISTS(SELECT 1 FROM "master_drugs" m '
        'WHERE typeof(m.id)=typeof(f.rowid) AND m.id=f.rowid)'
    )
    return {
        "status": "fts_rowid_structural_candidate_only",
        "fts_virtual_rows": counts["master_drugs_fts"],
        "fts_rowid_missing_catalog_rows": orphan,
        "fts_index_contents_verified": False,
    }


def make_full_history_lineage(db: sqlite3.Connection) -> dict:
    """Aggregate every physical SQLite table; fail closed on unreadable schema.

    This also marks the supplied connection query_only so testing may prove it
    cannot mutate even synthetic fixtures. SQL errors are redacted to avoid
    leaking schema strings from a malicious archive.
    """
    db.execute("PRAGMA query_only=ON")
    try:
        catalog = db.execute(
            "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        names = [row[0] for row in catalog]
        if not names or len(names) > MAX_TABLES or len(set(names)) != len(names):
            raise ValueError("Historical lineage table count is out of supported bounds")
        columns = {name: _table_columns(db, name) for name in names}
        counts = {name: _count(db, f"SELECT COUNT(*) FROM {quote(name)}") for name in names}
        if sum(counts.values()) > MAX_ROWS:
            raise ValueError("Historical lineage row budget exceeded")

        tables = []
        fts_count = 0
        for name, create_sql in catalog:
            is_fts = name == "master_drugs_fts" or name.startswith("master_drugs_fts_")
            fts_count += int(is_fts)
            tables.append({
                "opaque_table_id": opaque_table_id(name),
                "family": table_family(name),
                "rows": counts[name],
                "column_count": len(columns[name]),
                "fts_role": (
                    "virtual_index_unverified" if is_fts and
                    create_sql and "CREATE VIRTUAL TABLE" in create_sql.upper()
                    else "shadow_unverified" if is_fts else "not_fts"
                ),
                "id_key": _id_summary(db, name, columns[name]),
            })
        fixed = {}
        for label, child, child_col, parent, parent_col, required in (
            RELATIONSHIPS + MODULE_RELATIONSHIPS
        ):
            fixed[label] = _inspect_link(
                db, columns, counts, child, (child_col,), parent, (parent_col,), required
            )
        declared = _declared_edges(db, columns, counts)
        all_fixed = all(
            edge["status"] == "typed_structural_inspection_not_ownership"
            for edge in fixed.values()
        )
        return {
            "format": "historical-full-typed-source-graph-v1",
            "table_count": len(names),
            "total_table_rows_including_fts_shadows": sum(counts.values()),
            "tables": tables,
            "coverage": {
                "enumerated_tables": len(names),
                "whole_schema_counted": True,
                "fts_tables_and_shadows": fts_count,
                "fixed_relationships_checked": len(fixed),
                "declared_foreign_key_groups_checked": len(declared),
                "all_fixed_links_inspectable": all_fixed,
            },
            "fixed_relationships": fixed,
            "declared_foreign_keys": declared,
            "fts_catalog_candidate": _fts_summary(db, columns, counts),
            "historical_tenant_ownership_certified": False,
            "financial_provenance_certified": False,
            "archive_customer_supplier_copy_authorized": False,
            "import_permitted": False,
        }
    except sqlite3.Error:
        raise ValueError("Historical lineage read-only source inspection failed") from None


def verified_lineage(
    db: sqlite3.Connection, expected_sha256: str, hash_source: Callable[[], str],
    *, expected_table_count: int | None = None,
) -> dict:
    """Pin source twice, validate physical SQLite integrity, never write.

    Unlike foreign_key_check's fail-fast gate, missing FK parents stay visible
    in the lineage counts; this report is an investigation, not an import pass.
    """
    if SHA256.fullmatch(expected_sha256) is None:
        raise ValueError("A complete independent source SHA-256 pin is required")
    before = hash_source()
    if before.lower() != expected_sha256.lower():
        raise ValueError("Archive SHA-256 differs from independent source pin")
    db.execute("PRAGMA query_only=ON")
    try:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Historical lineage source integrity failure")
    except sqlite3.Error:
        raise ValueError("Historical lineage integrity inspection failed") from None
    report = make_full_history_lineage(db)
    if expected_table_count is not None and report["table_count"] != expected_table_count:
        raise ValueError("Historical lineage table census differs from independently expected count")
    if hash_source().lower() != before.lower():
        raise ValueError("Historical lineage source changed during inspection")
    report["archive_sha256"] = before.lower()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Counts-only typed lineage of an approved detached SQLite archive"
    )
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--expected-table-count", type=int, default=67)
    args = parser.parse_args()
    try:
        source = approved_archive(args.snapshot, Path(os.environ["LOCALAPPDATA"]))
        with closing(read_only_connection(source)) as db:
            report = verified_lineage(
                db, args.expected_sha256, lambda: digest_file(source),
                expected_table_count=args.expected_table_count,
            )
        print(json.dumps(report, separators=(",", ":"), sort_keys=True))
        return 0
    except (ValueError, sqlite3.Error, OSError, KeyError):
        # Never print a raw exception/filename/schema/row value.
        parser.exit(2, "Detached archive lineage inspection rejected; no report emitted\n")


if __name__ == "__main__":
    raise SystemExit(main())
