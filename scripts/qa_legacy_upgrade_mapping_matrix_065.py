#!/usr/bin/env python3
"""Adversarial, exclusively in-memory SQLite QA for migrations 065 and 066.

Run from anywhere: python scripts/qa_legacy_upgrade_mapping_matrix_065.py

There are NO live/installed/QA database connections, file-backed SQLite
databases, tenant creation outside this synthetic memory fixture, schema
rewrites or receipt insertions. Loads the real 065 and 066 SQL from the repository.
The pre-066 RED reproductions also run in a separate SQLite :memory: fixture.

The two approvals used for the positive path are TEST-ONLY HMAC endorsements
with deterministic public-in-source fixture keys, verified by this harness.
They are NOT real detached signatures or independently authorized grants.
SQLite itself validates digest *syntax*, not digest contents, signatures,
source-snapshot integrity or who supplied an evidence reference. Any actual
production mapping requires an independent, authorized cryptographic verifier
and a separate controlled approval mechanism before DB insertion.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import sqlite3
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MIGRATION = Path(__file__).resolve().parents[1] / (
    "src-tauri/migrations/065_legacy_upgrade_provenance.sql"
)
MIGRATION_066 = Path(__file__).resolve().parents[1] / (
    "src-tauri/migrations/066_legacy_mapped_source_row_seal.sql"
)
TABLES = (
    "inventory",
    "sales_invoices",
    "purchase_invoices",
    "returns",
    "activity_log",
    "shortages",
    "purchase_orders",
    "cash_movements",
    "daily_journals",
    "expenses",
    "financial_notices",
)
INTEGER_IDS = frozenset(("activity_log", "shortages"))
# Small realistic subset of original 001 source columns, in addition to the
# synthetic 'payload' field. These test stock, money, and historical details;
# no user data or application DB is ever opened.
BUSINESS_COLUMNS = {
    "inventory": ("quantity", "REAL DEFAULT 7"),
    "sales_invoices": ("total_amount", "REAL DEFAULT 37.5"),
    "purchase_invoices": ("total_amount", "REAL DEFAULT 37.5"),
    "returns": ("total_refund", "REAL DEFAULT 37.5"),
    "activity_log": ("details", "TEXT DEFAULT 'synthetic activity history'"),
    "shortages": ("requested_quantity", "INTEGER DEFAULT 7"),
    "purchase_orders": ("total_amount", "REAL DEFAULT 37.5"),
    "cash_movements": ("amount", "REAL DEFAULT 37.5"),
    "daily_journals": ("total_amount", "REAL DEFAULT 37.5"),
    "expenses": ("amount", "REAL DEFAULT 37.5"),
    "financial_notices": ("amount", "REAL DEFAULT 37.5"),
}
MANIFEST = """INSERT INTO native_legacy_upgrade_manifests (
    manifest_sha256,authorized_pharmacy_id,expected_source_count,
    grant_actor_id,approval_actor_id,grant_evidence_sha256,
    approval_evidence_sha256,grant_evidence_ref,approval_evidence_ref
) VALUES (?,?,?,?,?,?,?,?,?)"""
MAPPING = """INSERT INTO native_legacy_upgrade_source_mappings (
    source_table,source_record_id,manifest_sha256,original_identity_class,
    original_pharmacy_literal,source_snapshot_sha256,source_evidence_ref
) VALUES (?,?,?,?,?,?,?)"""
SEAL = """INSERT INTO native_legacy_upgrade_manifest_seals (
    manifest_sha256,sealed_by_actor_id,seal_evidence_sha256,seal_evidence_ref
) VALUES (?,?,?,?)"""


def canonical(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def digest(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def identity_class(value: str | None) -> str:
    if value is None:
        return "null"
    if not value.strip():
        return "blank"
    if value == "local_default":
        return "local_default"
    return "explicit"


@dataclass(frozen=True)
class Source:
    table: str
    record_id: str
    original: str | None


SOURCES = (
    Source("inventory", "stock-null", None),
    Source("inventory", "stock-empty", ""),
    Source("inventory", "stock-spaces", "   "),
    Source("sales_invoices", "sale-default", "local_default"),
    Source("purchase_invoices", "purchase-a", "branch-a"),
    Source("returns", "return-null", None),
    Source("activity_log", "14", None),
    Source("shortages", "22", "local_default"),
    Source("purchase_orders", "order-blank", ""),
    Source("cash_movements", "cash-a", "branch-a"),
    Source("daily_journals", "journal-null", None),
    Source("expenses", "expense-blank", " "),
    Source("financial_notices", "notice-null", None),
)


def rows_snapshot(conn: sqlite3.Connection) -> dict[str, list[tuple]]:
    """Read-only witness that the upgrade never updates source/financial rows."""
    return {
        table: conn.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
        for table in TABLES
    }


def source_row_hash(conn: sqlite3.Connection, source: Source) -> str:
    """Fixture canonicalization; not a production snapshot-hashing protocol."""
    row = conn.execute(
        f"SELECT * FROM {source.table} WHERE id=?",
        (int(source.record_id) if source.table in INTEGER_IDS else source.record_id,),
    ).fetchone()
    if row is None:
        raise AssertionError("Synthetic source vanished")
    return digest(canonical({"table": source.table, "row": row}))


class SyntheticEndorsements:
    """Distinct HMAC keys simulate *verified* independent actor endorsements.

    Test keys are intentionally shipped in this QA script. Nothing produced
    here may be presented as production evidence or a genuine signature.
    """

    KEYS = {
        "owner-a-1": b"TEST ONLY 065 owner A one - not a private production key",
        "owner-a-2": b"TEST ONLY 065 owner A two - not a private production key",
        "owner-b-1": b"TEST ONLY 065 owner B one - not a private production key",
        "owner-b-2": b"TEST ONLY 065 owner B two - not a private production key",
    }

    @classmethod
    def endorse(cls, actor: str, document: dict[str, Any]) -> str:
        return hmac.new(cls.KEYS[actor], canonical(document), hashlib.sha256).hexdigest()

    @classmethod
    def verifies(cls, actor: str, document: dict[str, Any], signature: str) -> bool:
        return hmac.compare_digest(cls.endorse(actor, document), signature)


@dataclass(frozen=True)
class Bundle:
    manifest_sha: str
    manifest_params: tuple
    mappings: tuple[tuple, ...]
    seal_params: tuple
    signed_documents: tuple[tuple[str, dict[str, Any], str], ...]


def trusted_synthetic_bundle(
    conn: sqlite3.Connection,
    sources: tuple[Source, ...],
    *,
    target: str = "branch-a",
    grant: str = "owner-a-1",
    approver: str = "owner-a-2",
) -> Bundle:
    """Verify test-only endorsements BEFORE preparing SQL inserts."""
    entries = [
        {
            "table": s.table,
            "id": s.record_id,
            "identity_class": identity_class(s.original),
            "original_literal": s.original,
            "source_sha": source_row_hash(conn, s),
        }
        for s in sources
    ]
    # The manifest binds exact source IDs/classes, target tenant, and the
    # SHA-256 of the independently canonicalized synthetic source snapshots.
    manifest_sha = digest(canonical({"target": target, "entries": entries}))
    grant_document = {
        "kind": "synthetic-grant",
        "manifest": manifest_sha,
        "tenant": target,
        "actor": grant,
    }
    approval_document = {
        "kind": "synthetic-independent-approval",
        "manifest": manifest_sha,
        "tenant": target,
        "actor": approver,
        "grant": grant,
    }
    seal_document = {
        "kind": "synthetic-seal",
        "manifest": manifest_sha,
        "tenant": target,
        "actor": approver,
        "count": len(entries),
    }
    documents = (
        (grant, grant_document, SyntheticEndorsements.endorse(grant, grant_document)),
        (
            approver,
            approval_document,
            SyntheticEndorsements.endorse(approver, approval_document),
        ),
        (approver, seal_document, SyntheticEndorsements.endorse(approver, seal_document)),
    )
    for actor, content, signature in documents:
        if not SyntheticEndorsements.verifies(actor, content, signature):
            raise AssertionError("Invalid synthetic endorsement")
    grant_sig, approval_sig, seal_sig = (signed[2] for signed in documents)
    manifest_params = (
        manifest_sha,
        target,
        len(entries),
        grant,
        approver,
        digest(bytes.fromhex(grant_sig)),
        digest(bytes.fromhex(approval_sig)),
        "synthetic-test-only://grant/" + manifest_sha[:24],
        "synthetic-test-only://approval/" + manifest_sha[:24],
    )
    mapping_rows = tuple(
        (
            entry["table"],
            entry["id"],
            manifest_sha,
            entry["identity_class"],
            entry["original_literal"],
            entry["source_sha"],
            "synthetic-test-only://source/"
            + entry["table"]
            + "/"
            + entry["id"],
        )
        for entry in entries
    )
    seal_params = (
        manifest_sha,
        approver,
        digest(bytes.fromhex(seal_sig)),
        "synthetic-test-only://seal/" + manifest_sha[:24],
    )
    return Bundle(manifest_sha, manifest_params, mapping_rows, seal_params, documents)


def build_memory_database(*, install_066: bool = True) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA recursive_triggers=OFF")
    conn.execute(
        "CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, pharmacy_id TEXT,"
        " permissions TEXT, is_active INTEGER)"
    )
    conn.execute("CREATE TABLE native_owner_scope_review (owner_id TEXT PRIMARY KEY)")
    for table in TABLES:
        id_type = "INTEGER" if table in INTEGER_IDS else "TEXT"
        column, definition = BUSINESS_COLUMNS[table]
        conn.execute(
            f"CREATE TABLE {table} (id {id_type} PRIMARY KEY,"
            f"pharmacy_id TEXT, payload TEXT, {column} {definition})"
        )
    people = (
        ("owner-a-1", "owner", "branch-a", "{}", 1),
        ("owner-a-2", "owner", "branch-a", "{}", 1),
        ("owner-b-1", "owner", "branch-b", "{}", 1),
        ("owner-b-2", "owner", "branch-b", "{}", 1),
        ("staff-a", "cashier", "branch-a", "{}", 1),
        ("disabled-a", "owner", "branch-a", "{}", 0),
        ("quarantined-a", "owner", "branch-a", "{}", 1),
        ("local-a", "owner", "local_default", "{}", 1),
        ("denied-admin", "admin", "branch-a", '{"can_manage_inventory":false}', 1),
    )
    conn.executemany("INSERT INTO users VALUES (?,?,?,?,?)", people)
    conn.execute("INSERT INTO native_owner_scope_review VALUES ('quarantined-a')")
    for source in SOURCES:
        ident = int(source.record_id) if source.table in INTEGER_IDS else source.record_id
        conn.execute(
            f"INSERT INTO {source.table}(id,pharmacy_id,payload) VALUES(?,?,?)",
            (ident, source.original, "synthetic data for " + source.record_id),
        )
    # Identical string IDs in distinct tables do not represent the same source.
    conn.execute(
        "INSERT INTO sales_invoices(id,pharmacy_id,payload) "
        "VALUES ('stock-null',NULL,'separate sale identity')"
    )
    # This explicit foreign record MUST NOT be silently mapped to branch-a.
    conn.execute(
        "INSERT INTO inventory(id,pharmacy_id,payload) "
        "VALUES ('foreign-stock','branch-b','other tenant')"
    )
    # Apply unmodified real SQL, using exclusively :memory: fixture tables.
    conn.executescript(MIGRATION.read_text(encoding="utf-8"))
    if install_066:
        conn.executescript(MIGRATION_066.read_text(encoding="utf-8"))
    return conn


class LegacyUpgradeMappingMatrix065(unittest.TestCase):
    def setUp(self) -> None:
        self.db = build_memory_database()
        self.before = rows_snapshot(self.db)

    def tearDown(self) -> None:
        self.db.close()

    def denied(self, sql: str, args: tuple = ()) -> str:
        with self.assertRaises(sqlite3.DatabaseError) as result:
            self.db.execute(sql, args)
        return str(result.exception)

    def seal_valid_bundle(self, bundle: Bundle | None = None) -> Bundle:
        bundle = bundle or trusted_synthetic_bundle(self.db, SOURCES)
        self.db.execute(MANIFEST, bundle.manifest_params)
        for mapping in bundle.mappings:
            self.db.execute(MAPPING, mapping)
        self.db.execute(SEAL, bundle.seal_params)
        return bundle

    def test_01_prospective_schema_empty_no_backfill_or_receipts(self) -> None:
        for table in (
            "native_legacy_upgrade_manifests",
            "native_legacy_upgrade_source_mappings",
            "native_legacy_upgrade_manifest_seals",
            "native_legacy_upgrade_authorized_sources",
        ):
            self.assertEqual(self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)
        self.assertEqual(rows_snapshot(self.db), self.before)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_02_authorized_evidence_only_synthetic_hmac_two_owner_success(self) -> None:
        bundle = trusted_synthetic_bundle(self.db, SOURCES)
        self.assertEqual(len(bundle.signed_documents), 3)
        self.assertEqual(bundle.manifest_params[3:5], ("owner-a-1", "owner-a-2"))
        for actor, document, signature in bundle.signed_documents:
            self.assertTrue(SyntheticEndorsements.verifies(actor, document, signature))
        self.db.execute("BEGIN IMMEDIATE")
        self.db.execute(MANIFEST, bundle.manifest_params)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_authorized_sources"
        ).fetchone()[0], 0)
        for mapping in bundle.mappings[:-1]:
            self.db.execute(MAPPING, mapping)
        self.denied(SEAL, bundle.seal_params)  # incomplete count
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_authorized_sources"
        ).fetchone()[0], 0)
        self.db.execute(MAPPING, bundle.mappings[-1])
        self.denied(SEAL, (bundle.manifest_sha, "owner-a-1", *bundle.seal_params[2:]))
        self.db.execute(SEAL, bundle.seal_params)
        self.db.execute("COMMIT")
        witness = self.db.execute(
            "SELECT source_table,source_record_id,original_identity_class,"
            "original_pharmacy_literal,authorized_pharmacy_id "
            "FROM native_legacy_upgrade_authorized_sources"
        ).fetchall()
        self.assertEqual(len(witness), len(SOURCES))
        self.assertEqual({row[2] for row in witness},
                         {"null", "blank", "local_default", "explicit"})
        self.assertTrue(all(row[4] == "branch-a" for row in witness))
        self.assertIn(("inventory", "stock-empty", "blank", "", "branch-a"), witness)
        self.assertIn(("inventory", "stock-spaces", "blank", "   ", "branch-a"), witness)
        self.assertIn(("inventory", "stock-null", "null", None, "branch-a"), witness)
        self.assertEqual(rows_snapshot(self.db), self.before)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_03_grant_actor_independence_inactive_quarantine_foreign(self) -> None:
        bundle = trusted_synthetic_bundle(self.db, (SOURCES[0],))
        base = list(bundle.manifest_params)
        for change in (
            {4: "owner-a-1"},  # same grant/approval
            {4: "owner-b-1"},  # foreign actor
            {3: "owner-b-1"},  # foreign grant
            {3: "staff-a"},
            {3: "disabled-a"},
            {4: "quarantined-a"},
            {4: "denied-admin"},
            {1: "local_default"},
            {1: "   "},
            {2: 0},
            {2: 10001},
            {5: "not-a-hash"},
            {6: base[5]},  # copied grant digest
            {7: "x"},  # missing/short grant evidence reference
            {8: base[7]},  # same references, not independent
        ):
            params = base.copy()
            for index, value in change.items():
                params[index] = value
            self.denied(MANIFEST, tuple(params))
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_manifests"
        ).fetchone()[0], 0)

    def test_04_missing_source_wrong_class_wrong_literal_or_foreign(self) -> None:
        bundle = trusted_synthetic_bundle(self.db, SOURCES)
        self.db.execute(MANIFEST, bundle.manifest_params)
        base = list(bundle.mappings[0])  # inventory stock-null
        for change in (
            {0: "unknown_table"},
            {1: "unknown-record"},
            {1: " stock-null "},
            {3: "blank", 4: ""},
            {3: "explicit", 4: "branch-b"},
            {3: "local_default", 4: "local_default"},
            {5: "g" * 64},
            {5: "0" * 64},
            {6: " "},
        ):
            params = base.copy()
            for index, value in change.items():
                params[index] = value
            self.denied(MAPPING, tuple(params))
        # Exact original whitespace is preserved (not just 'blank' class).
        whitespace = list(bundle.mappings[2])
        whitespace[4] = ""
        self.denied(MAPPING, tuple(whitespace))
        # Existing explicit branch-b row cannot be reattributed to branch-a.
        self.denied(MAPPING, (
            "inventory", "foreign-stock", bundle.manifest_sha, "explicit",
            "branch-b", digest("synthetic foreign row"), "synthetic-test-only://foreign",
        ))
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_source_mappings"
        ).fetchone()[0], 0)

    def test_05_dual_tenant_and_composite_identity_cross_claims(self) -> None:
        main = trusted_synthetic_bundle(self.db, (SOURCES[0],))
        other_source = Source("inventory", "foreign-stock", "branch-b")
        branch_b = trusted_synthetic_bundle(
            self.db, (other_source,), target="branch-b",
            grant="owner-b-1", approver="owner-b-2",
        )
        self.seal_valid_bundle(main)
        self.seal_valid_bundle(branch_b)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_authorized_sources"
        ).fetchone()[0], 2)
        # Same source is immutable even when the second manifest has
        # distinct active approvers in another tenant and the row was NULL.
        conflict = trusted_synthetic_bundle(
            self.db, (SOURCES[0],), target="branch-b",
            grant="owner-b-1", approver="owner-b-2",
        )
        self.db.execute(MANIFEST, conflict.manifest_params)
        self.denied(MAPPING, conflict.mappings[0])
        # Composite key permits same ID in another allowed source table.
        same_id_different_table = Source("sales_invoices", "stock-null", None)
        another = trusted_synthetic_bundle(self.db, (same_id_different_table,))
        self.seal_valid_bundle(another)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_authorized_sources "
            "WHERE source_record_id='stock-null'"
        ).fetchone()[0], 2)
        self.assertEqual(rows_snapshot(self.db), self.before)

    def test_06_seal_wrong_actor_missing_count_late_append_duplicate(self) -> None:
        bundle = trusted_synthetic_bundle(self.db, SOURCES[:2])
        self.db.execute(MANIFEST, bundle.manifest_params)
        self.db.execute(MAPPING, bundle.mappings[0])
        self.denied(SEAL, bundle.seal_params)
        self.db.execute(MAPPING, bundle.mappings[1])
        self.denied(SEAL, (bundle.manifest_sha, "owner-b-1", *bundle.seal_params[2:]))
        self.denied(SEAL, (
            bundle.manifest_sha, "owner-a-2", bundle.manifest_sha, bundle.seal_params[3],
        ))
        self.denied(SEAL, (
            bundle.manifest_sha, "owner-a-2", bundle.seal_params[2],
            bundle.manifest_params[7],
        ))
        self.db.execute(SEAL, bundle.seal_params)
        self.denied(SEAL, bundle.seal_params)
        self.denied(
            "INSERT OR REPLACE INTO native_legacy_upgrade_manifest_seals"
            "(manifest_sha256,sealed_by_actor_id,seal_evidence_sha256,seal_evidence_ref)"
            " VALUES(?,?,?,?)",
            bundle.seal_params,
        )
        self.denied(MAPPING, bundle.mappings[0])
        self.denied(
            "INSERT OR REPLACE INTO native_legacy_upgrade_source_mappings("
            "source_table,source_record_id,manifest_sha256,original_identity_class,"
            "original_pharmacy_literal,source_snapshot_sha256,source_evidence_ref)"
            " VALUES(?,?,?,?,?,?,?)",
            bundle.mappings[0],
        )
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_authorized_sources"
        ).fetchone()[0], 2)

    def test_07_receipt_surfaces_unchanged_and_no_source_rewrites(self) -> None:
        self.seal_valid_bundle()
        self.assertEqual(rows_snapshot(self.db), self.before)
        # These source tables have only synthetic rows, not financial receipts.
        for table in TABLES:
            self.assertEqual(
                self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0],
                len(self.before[table]),
            )
        for source in SOURCES:
            record_id = int(source.record_id) if source.table in INTEGER_IDS else source.record_id
            self.denied(
                f"UPDATE {source.table} SET pharmacy_id='branch-b' WHERE id=?",
                (record_id,),
            )
            self.denied(
                f"UPDATE {source.table} SET id=? WHERE id=?",
                (987654 if source.table in INTEGER_IDS else "replacement-id", record_id),
            )
            self.denied(f"DELETE FROM {source.table} WHERE id=?", (record_id,))
            self.denied(
                f"INSERT OR REPLACE INTO {source.table}(id,pharmacy_id,payload)"
                " VALUES(?,?,?)",
                (record_id, "branch-b", "synthetic replacement"),
            )
        self.assertEqual(rows_snapshot(self.db), self.before)

    def test_08_immutable_manifest_source_and_seal_after_memory_restart(self) -> None:
        bundle = self.seal_valid_bundle()
        # sqlite3.backup copies only between in-memory connections, never disk.
        successor = sqlite3.connect(":memory:", isolation_level=None)
        self.db.backup(successor)
        self.db.close()
        self.db = successor
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA recursive_triggers=OFF")
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_authorized_sources"
        ).fetchone()[0], len(SOURCES))
        for table, column, where, params in (
            (
                "native_legacy_upgrade_manifests", "manifest_sha256",
                "manifest_sha256=?", (bundle.manifest_sha,),
            ),
            (
                "native_legacy_upgrade_manifest_seals", "sealed_by_actor_id",
                "manifest_sha256=?", (bundle.manifest_sha,),
            ),
            (
                "native_legacy_upgrade_source_mappings", "source_snapshot_sha256",
                "source_table='inventory'", (),
            ),
        ):
            # WITHOUT ROWID evidence tables: update a *real* column to itself.
            # Trigger must still reject the otherwise valid no-op statement.
            self.assertIn(
                "immutable",
                self.denied(
                    f"UPDATE {table} SET {column}={column} WHERE {where}", params
                ).lower(),
            )
            self.denied(f"DELETE FROM {table} WHERE {where}", params)
        self.denied(
            "INSERT OR REPLACE INTO native_legacy_upgrade_manifests"
            "(manifest_sha256,authorized_pharmacy_id,expected_source_count,"
            "grant_actor_id,approval_actor_id,grant_evidence_sha256,"
            "approval_evidence_sha256,grant_evidence_ref,approval_evidence_ref)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            bundle.manifest_params,
        )
        self.denied("UPDATE inventory SET id='another' WHERE id='stock-null'")
        self.denied("DELETE FROM activity_log WHERE id=14")
        self.assertEqual(rows_snapshot(self.db), self.before)
        self.assertEqual(self.db.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_09_forged_hashes_and_missing_signature_are_sql_limit_not_trust(self) -> None:
        real = trusted_synthetic_bundle(self.db, (SOURCES[0],))
        false_signature = "0" * 64
        actor, document, _signature = real.signed_documents[0]
        self.assertFalse(SyntheticEndorsements.verifies(actor, document, false_signature))
        forged = list(real.manifest_params)
        forged[5] = digest("attacker-chosen fake SHA that is syntactically valid")
        forged[7] = "synthetic-test-only://unverified-approval-claim"
        # A DB CHECK cannot authenticate a detached approval or recompute an
        # arbitrary digest. Demonstrate this in a rolled-back SAVEPOINT ONLY.
        self.db.execute("SAVEPOINT deliberate_forgery")
        try:
            self.db.execute(MANIFEST, tuple(forged))
            source_mapping = list(real.mappings[0])
            source_mapping[5] = digest("untrue source snapshot")
            self.assertNotEqual(
                source_mapping[5], source_row_hash(self.db, SOURCES[0])
            )
            self.db.execute(MAPPING, tuple(source_mapping))
            self.db.execute(SEAL, real.seal_params)
            # This row only means SQL shape/actor/count validation passed,
            # *not* that any signature or evidence is authentic.
            self.assertEqual(self.db.execute(
                "SELECT COUNT(*) FROM native_legacy_upgrade_authorized_sources"
            ).fetchone()[0], 1)
        finally:
            self.db.execute("ROLLBACK TO deliberate_forgery")
            self.db.execute("RELEASE deliberate_forgery")
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_manifests"
        ).fetchone()[0], 0)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_authorized_sources"
        ).fetchone()[0], 0)
        self.assertEqual(rows_snapshot(self.db), self.before)

    def test_10_mapped_payload_update_refused_before_and_after_seal(self) -> None:
        # 066 now seals the whole row on first mapping, before final seal.
        bundle = trusted_synthetic_bundle(self.db, (SOURCES[0],))
        self.db.execute(MANIFEST, bundle.manifest_params)
        self.db.execute(MAPPING, bundle.mappings[0])
        self.assertIn("sealed", self.denied(
            "UPDATE inventory SET payload='later mutation' WHERE id='stock-null'"
        ))
        self.assertIn("sealed", self.denied(
            "UPDATE inventory SET payload=payload WHERE id='stock-null'"
        ))
        self.assertEqual(source_row_hash(self.db, SOURCES[0]), bundle.mappings[0][5])
        self.db.execute(SEAL, bundle.seal_params)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_authorized_sources"
        ).fetchone()[0], 1)
        self.assertIn("sealed", self.denied(
            "UPDATE inventory SET payload='after seal' WHERE id='stock-null'"
        ))
        self.assertEqual(rows_snapshot(self.db), self.before)

    def test_13_red_065_payload_edits_and_green_066_all_11_sources(self) -> None:
        # Deterministic RED proof: with real 065 *alone* SQL allows stock and
        # financial field edits despite recorded source-to-tenant mappings.
        # Load forward-only 066 into the same memory DB: both edits now fail.
        legacy = build_memory_database(install_066=False)
        try:
            pre_bundle = trusted_synthetic_bundle(
                legacy, (SOURCES[0], Source("expenses", "expense-blank", " "))
            )
            legacy.execute(MANIFEST, pre_bundle.manifest_params)
            for mapping in pre_bundle.mappings:
                legacy.execute(MAPPING, mapping)
            before = source_row_hash(legacy, SOURCES[0])
            before_expense = source_row_hash(legacy, SOURCES[-2])
            affected = legacy.execute(
                "UPDATE inventory SET quantity=99 WHERE id='stock-null'"
            ).rowcount
            affected_amount = legacy.execute(
                "UPDATE expenses SET amount=9999 WHERE id='expense-blank'"
            ).rowcount
            self.assertEqual(affected, 1, "065 alone must allow stock mutation")
            self.assertEqual(affected_amount, 1, "065 alone must allow monetary mutation")
            self.assertNotEqual(source_row_hash(legacy, SOURCES[0]), before)
            self.assertNotEqual(source_row_hash(legacy, SOURCES[-2]), before_expense)
            # RED demonstrates 065 can seal stale snapshots. This is not
            # genuine verified endorsement; all fixture HMACs are TEST ONLY.
            legacy.execute(SEAL, pre_bundle.seal_params)
            legacy.executescript(MIGRATION_066.read_text(encoding="utf-8"))
            with self.assertRaisesRegex(sqlite3.IntegrityError, "sealed"):
                legacy.execute(
                    "UPDATE inventory SET quantity=123 WHERE id='stock-null'"
                )
            with self.assertRaisesRegex(sqlite3.IntegrityError, "sealed"):
                legacy.execute(
                    "UPDATE expenses SET amount=12345 WHERE id='expense-blank'"
                )
            self.assertEqual(legacy.execute(
                "SELECT quantity FROM inventory WHERE id='stock-null'"
            ).fetchone()[0], 99)
            self.assertEqual(legacy.execute(
                "SELECT amount FROM expenses WHERE id='expense-blank'"
            ).fetchone()[0], 9999)
        finally:
            legacy.close()

        # End-to-end 066 check covers each 065 whitelisted source, including
        # integer-ID audit/shortages and finance-related table identities.
        self.seal_valid_bundle()
        trigger_names = {
            row[0] for row in self.db.execute(
                "SELECT name FROM sqlite_master WHERE type='trigger'"
            )
        }
        for source in SOURCES:
            with self.subTest(table=source.table, record_id=source.record_id):
                self.assertIn(
                    f"native_legacy_upgrade_{source.table}_payload_no_update",
                    trigger_names,
                )
                before_hash = source_row_hash(self.db, source)
                key = int(source.record_id) if source.table in INTEGER_IDS else source.record_id
                error = self.denied(
                    f"UPDATE {source.table} SET payload='modified' WHERE id=?", (key,)
                )
                self.assertIn("sealed", error)
                business_col = BUSINESS_COLUMNS[source.table][0]
                business_value = "rewritten history" if business_col == "details" else 123456
                business_err = self.denied(
                    f"UPDATE {source.table} SET {business_col}=? WHERE id=?",
                    (business_value, key),
                )
                self.assertIn("sealed", business_err)
                self.assertEqual(source_row_hash(self.db, source), before_hash)
        self.assertEqual(rows_snapshot(self.db), self.before)

    def test_14_unmapped_dml_permitted_even_when_other_rows_mapped(self) -> None:
        self.seal_valid_bundle()
        self.assertEqual(self.db.execute(
            "UPDATE inventory SET payload='unmapped edit' "
            "WHERE id='foreign-stock'"
        ).rowcount, 1)
        self.assertEqual(self.db.execute(
            "UPDATE inventory SET quantity=88 WHERE id='foreign-stock'"
        ).rowcount, 1)
        self.assertEqual(self.db.execute(
            "UPDATE sales_invoices SET payload='unmapped sale' "
            "WHERE id='stock-null'"
        ).rowcount, 1)
        self.db.execute(
            "INSERT INTO inventory(id,pharmacy_id,payload) VALUES("
            "'new-unmapped','branch-b','unmapped new stock')"
        )
        self.assertEqual(self.db.execute(
            "UPDATE inventory SET payload='changed' WHERE id='new-unmapped'"
        ).rowcount, 1)
        self.assertEqual(self.db.execute(
            "DELETE FROM inventory WHERE id='new-unmapped'"
        ).rowcount, 1)
        self.assertEqual(self.db.execute(
            "SELECT payload FROM inventory WHERE id='foreign-stock'"
        ).fetchone()[0], "unmapped edit")
        self.assertEqual(self.db.execute(
            "SELECT quantity FROM inventory WHERE id='foreign-stock'"
        ).fetchone()[0], 88)
        self.assertEqual(self.db.execute(
            "SELECT payload FROM inventory WHERE id='stock-null'"
        ).fetchone()[0], "synthetic data for stock-null")

    def test_15_066_atomic_multirecord_failure_and_rollback(self) -> None:
        self.seal_valid_bundle()
        baseline = rows_snapshot(self.db)
        # A statement touching unmapped and mapped inventory rows fails as
        # a unit even if SQLite starts by editing unmapped rows first.
        self.assertIn("sealed", self.denied(
            "UPDATE inventory SET payload='bulk' WHERE id IN "
            "('foreign-stock','stock-null')"
        ))
        self.assertEqual(rows_snapshot(self.db), baseline)
        self.db.execute("BEGIN IMMEDIATE")
        self.db.execute("UPDATE inventory SET payload='pending' WHERE id='foreign-stock'")
        self.assertIn("sealed", self.denied(
            "UPDATE inventory SET payload='tamper' WHERE id='stock-null'"
        ))
        self.db.execute("ROLLBACK")
        self.assertEqual(rows_snapshot(self.db), baseline)

    def test_16_066_blocks_mapped_rows_on_restarted_memory_connection(self) -> None:
        self.seal_valid_bundle()
        successor = sqlite3.connect(":memory:", isolation_level=None)
        self.db.backup(successor)
        self.db.close()
        self.db = successor
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA recursive_triggers=OFF")
        self.assertIn("sealed", self.denied(
            "UPDATE expenses SET payload='post restart tamper' WHERE id='expense-blank'"
        ))
        self.assertIn("sealed", self.denied(
            "UPDATE shortages SET payload='post restart tamper' WHERE id=22"
        ))
        self.assertEqual(rows_snapshot(self.db), self.before)

    def test_11_atomic_rollback_after_partial_manifest_and_mapping(self) -> None:
        bundle = trusted_synthetic_bundle(self.db, (SOURCES[0], SOURCES[1]))
        self.db.execute("BEGIN IMMEDIATE")
        self.db.execute(MANIFEST, bundle.manifest_params)
        self.db.execute(MAPPING, bundle.mappings[0])
        # A failed second claim does not grant an incomplete sealed manifest.
        bad = list(bundle.mappings[1])
        bad[4] = "branch-b"  # actual original is blank
        self.denied(MAPPING, tuple(bad))
        self.denied(SEAL, bundle.seal_params)
        self.db.execute("ROLLBACK")
        for name in (
            "native_legacy_upgrade_manifests",
            "native_legacy_upgrade_source_mappings",
            "native_legacy_upgrade_manifest_seals",
            "native_legacy_upgrade_authorized_sources",
        ):
            self.assertEqual(self.db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0], 0)
        self.assertEqual(rows_snapshot(self.db), self.before)
        self.seal_valid_bundle(bundle)
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_authorized_sources"
        ).fetchone()[0], 2)

    def test_12_tampered_synthetic_approval_fails_external_verifier(self) -> None:
        bundle = trusted_synthetic_bundle(self.db, (SOURCES[0],))
        for actor, content, signature in bundle.signed_documents:
            self.assertTrue(SyntheticEndorsements.verifies(actor, content, signature))
            self.assertFalse(SyntheticEndorsements.verifies(actor, content, "0" * 64))
            forged = dict(content)
            forged["tenant"] = "branch-b"
            self.assertFalse(SyntheticEndorsements.verifies(actor, forged, signature))
        # A real client MUST make these external checks before SQL; this
        # matrix never claims that migration 065 can enforce authenticity.
        self.assertEqual(self.db.execute(
            "SELECT COUNT(*) FROM native_legacy_upgrade_manifests"
        ).fetchone()[0], 0)


if __name__ == "__main__":
    print("065+066 SYNTHETIC-ONLY MATRIX: SQLite :memory:; NO real grants/signatures/QA DB")
    print("CAVEAT: SQL checks hash shape; only test HMACs are verified by this script.")
    unittest.main(verbosity=2)
