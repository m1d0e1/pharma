"""Counts-only custody manifest for a DETACHED historical SQLite archive.

No row ID, source value, contact field, price or ledger amount is returned.
This module never copies records or certifies historic tenant ownership.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Callable


MAX_TABLES = 256
MAX_ROWS = 3_000_000

# The snapshot verifier must cover the entire financial/customer graph, even
# when a pre-migration schema did not declare every foreign key.
FAMILIES = {
    "master_drugs": "catalog",
    "inventory": "inventory",
    "patients": "customers",
    "patient_transactions": "customers",
    "sales_invoices": "sales",
    "sales_items": "sales",
    "returns": "sales_returns",
    "return_items": "sales_returns",
    "suppliers": "suppliers",
    "supplier_transactions": "suppliers",
    "purchase_invoices": "purchases",
    "purchase_invoice_items": "purchases",
    "purchase_returns": "purchase_returns",
    "purchase_return_items": "purchase_returns",
    "daily_journals": "journal",
    "journal_entries": "journal",
    "cash_movements": "journal",
    "financial_notices": "journal",
    "shifts": "journal",
    "users": "identity",
    "activity_log": "identity",
}
EXTENDED_FAMILIES = {
    "config": "configuration",
    "employee_jobs": "identity",
    "points_of_sale": "cash_and_shifts",
    "expense_definitions": "accounts_and_payments",
    "expenses": "accounts_and_payments",
    "banks": "accounts_and_payments",
    "accounts": "accounts_and_payments",
    "trial_balance_settings": "accounts_and_payments",
    "credit_cards": "accounts_and_payments",
    "commercial_papers": "accounts_and_payments",
    "opening_balances": "stock_and_opening",
    "opening_balance_items": "stock_and_opening",
    "shortages": "stock_and_opening",
    "stock_adjustments": "stock_and_opening",
    "adjustment_reasons": "catalog",
    "drug_alternatives": "catalog",
    "drug_indications": "catalog",
    "scientific_groups": "catalog",
    "indications": "catalog",
    "item_natures": "catalog",
    "usage_methods": "catalog",
    "product_categories": "catalog",
    "manufacturers": "catalog",
    "units": "catalog",
    "refill_reminders": "customer_clinical",
    "patient_allergies": "customer_clinical",
    "patient_conditions": "customer_clinical",
    "drug_interactions": "customer_clinical",
    "purchase_orders": "purchases",
    "purchase_order_items": "purchases",
    "native_stock_ledger_provenance": "native_witnesses",
    "native_purchase_return_provenance": "native_witnesses",
    "native_purchase_return_line_provenance": "native_witnesses",
    "native_purchase_posting_events": "native_witnesses",
    "native_purchase_create_requests": "native_witnesses",
    "native_sale_cogs_provenance": "native_witnesses",
    "native_sale_return_cogs_provenance": "native_witnesses",
    "native_sale_negative_settlement_provenance": "native_witnesses",
    "native_supplier_payment_receipts": "native_witnesses",
    "native_patient_financial_journal_receipts": "native_witnesses",
    "native_patient_wallet_topup_receipts": "native_witnesses",
    "native_patient_directory_ownership": "native_witnesses",
    "native_supplier_directory_ownership": "native_witnesses",
    "native_owner_scope_review": "native_witnesses",
    "native_financial_notice_cash_witnesses": "native_witnesses",
    "native_purchase_zero_delta_stock_events": "native_witnesses",
    "native_purchase_draft_create_witnesses": "native_witnesses",
    "native_delivery_collection_receipts": "native_witnesses",
    "inventory_lot_import_receipts": "native_witnesses",
    "_sqlx_migrations": "migration_metadata",
}
REQUIRED = (
    "master_drugs", "inventory", "patients", "patient_transactions",
    "sales_invoices", "sales_items", "returns", "return_items",
    "suppliers", "supplier_transactions", "purchase_invoices",
    "purchase_invoice_items", "purchase_returns", "purchase_return_items",
    "daily_journals", "journal_entries", "cash_movements", "shifts", "users",
)
DIRECT_SCOPE_REQUIRED = (
    "users", "inventory", "sales_invoices", "purchase_invoices",
    "daily_journals", "cash_movements",
)

# (opaque report category, child table, reference column, parent table,
#  parent key, null reference is itself an unresolved relationship)
RELATIONSHIPS = (
    ("sale_line_to_invoice", "sales_items", "invoice_id", "sales_invoices", "id", True),
    ("sale_line_to_lot", "sales_items", "inventory_id", "inventory", "id", False),
    ("sale_to_patient", "sales_invoices", "patient_id", "patients", "id", False),
    ("return_to_sale", "returns", "invoice_id", "sales_invoices", "id", True),
    ("return_line_to_return", "return_items", "return_id", "returns", "id", True),
    ("return_line_to_sale_line", "return_items", "sale_item_id", "sales_items", "id", False),
    ("purchase_to_supplier", "purchase_invoices", "supplier_id", "suppliers", "id", True),
    ("purchase_line_to_purchase", "purchase_invoice_items", "invoice_id", "purchase_invoices", "id", True),
    ("purchase_return_to_purchase", "purchase_returns", "purchase_invoice_id", "purchase_invoices", "id", False),
    ("purchase_return_line_to_return", "purchase_return_items", "purchase_return_id", "purchase_returns", "id", True),
    ("purchase_return_line_to_source_line", "purchase_return_items", "purchase_invoice_item_id", "purchase_invoice_items", "id", False),
    ("supplier_ledger_to_supplier", "supplier_transactions", "supplier_id", "suppliers", "id", True),
    ("patient_ledger_to_patient", "patient_transactions", "patient_id", "patients", "id", True),
    ("entry_to_journal", "journal_entries", "journal_id", "daily_journals", "id", True),
    ("cash_to_shift", "cash_movements", "shift_id", "shifts", "id", False),
)
STOCK_TENANT_LINKS = (
    ("sale_line_to_lot_scope", "sales_items", "sales_invoices", "invoice_id"),
    ("purchase_line_to_lot_scope", "purchase_invoice_items", "purchase_invoices", "invoice_id"),
)

# Source and parent columns are an audit graph, NOT an export or ownership map.
# Optional newer receipts are never backfilled when a legacy schema lacks them.
# A missing non-null source link and an absent historic witness mean quarantine.
MODULE_RELATIONSHIPS = (
    ("inventory_to_catalog", "inventory", "drug_id", "master_drugs", "id", True),
    ("sale_line_to_catalog", "sales_items", "drug_id", "master_drugs", "id", False),
    ("purchase_line_to_catalog", "purchase_invoice_items", "drug_id", "master_drugs", "id", True),
    ("purchase_line_to_lot", "purchase_invoice_items", "inventory_id", "inventory", "id", False),
    ("purchase_return_to_supplier", "purchase_returns", "supplier_id", "suppliers", "id", True),
    ("sales_return_line_to_lot", "return_items", "inventory_id", "inventory", "id", False),
    ("purchase_return_line_to_lot", "purchase_return_items", "inventory_id", "inventory", "id", False),
    ("journal_entry_to_account", "journal_entries", "account_id", "accounts", "id", True),
    ("account_to_parent", "accounts", "parent_id", "accounts", "id", False),
    ("shift_to_actor", "shifts", "user_id", "users", "id", True),
    ("cash_to_actor", "cash_movements", "user_id", "users", "id", True),
    ("sale_to_actor", "sales_invoices", "user_id", "users", "id", False),
    ("purchase_to_actor", "purchase_invoices", "user_id", "users", "id", False),
    ("supplier_ledger_to_actor", "supplier_transactions", "user_id", "users", "id", False),
    ("patient_ledger_to_actor", "patient_transactions", "user_id", "users", "id", True),
    ("sale_return_to_actor", "returns", "user_id", "users", "id", True),
    ("purchase_return_to_actor", "purchase_returns", "user_id", "users", "id", True),
    ("purchase_order_line_to_order", "purchase_order_items", "po_id", "purchase_orders", "id", True),
    ("purchase_opening_line_to_header", "opening_balance_items", "ob_id", "opening_balances", "id", True),
    ("stock_adjustment_to_lot", "stock_adjustments", "inventory_id", "inventory", "id", True),
    ("shortage_to_catalog", "shortages", "drug_id", "master_drugs", "id", True),
    ("financial_notice_to_actor", "financial_notices", "user_id", "users", "id", True),
    ("expense_to_actor", "expenses", "user_id", "users", "id", True),
    ("trial_balance_to_account", "trial_balance_settings", "account_id", "accounts", "id", False),
)

# Fixed post-migration witnesses are *candidate structural links only*.
# Querying whether an archived source has such a row is never authentication,
# an ownership certificate, or permission to mint historic financial evidence.
# (category, historical source, optional immutable witness, fixed join clause)
WITNESS_LINKS = (
    ("purchase_create_044", "purchase_invoices", "native_purchase_create_requests",
     "w.invoice_id=s.id AND w.pharmacy_id=s.pharmacy_id "
     "AND CAST(s.user_id AS TEXT)=w.actor_id AND w.supplier_id=s.supplier_id"),
    ("purchase_posting_042", "purchase_invoices", "native_purchase_posting_events",
     "w.invoice_id=s.id AND w.event_kind='initial' AND w.pharmacy_id=s.pharmacy_id "
     "AND w.supplier_id=s.supplier_id AND CAST(s.user_id AS TEXT)=w.actor_id"),
    ("purchase_returns_041", "purchase_returns", "native_purchase_return_provenance",
     "w.return_id=s.id AND w.supplier_id=s.supplier_id "
     "AND w.purchase_invoice_id=s.purchase_invoice_id AND CAST(s.user_id AS TEXT)=w.actor_id"),
    ("sale_cogs_043", "sales_invoices", "native_sale_cogs_provenance",
     "w.sale_id=s.id AND w.pharmacy_id=s.pharmacy_id AND CAST(s.user_id AS TEXT)=w.actor_id"),
    ("sale_returns_043", "returns", "native_sale_return_cogs_provenance",
     "w.return_id=s.id AND w.sale_id=s.invoice_id AND CAST(s.user_id AS TEXT)=w.actor_id"),
    ("stock_adjustments_040", "stock_adjustments", "native_stock_ledger_provenance",
     "w.adjustment_id=s.id AND w.inventory_id=s.inventory_id "
     "AND CAST(s.user_id AS TEXT)=w.actor_id"),
    ("supplier_payments_054", "supplier_transactions", "native_supplier_payment_receipts",
     "w.supplier_transaction_id=s.id AND w.supplier_id=s.supplier_id "
     "AND CAST(s.user_id AS TEXT)=w.actor_id AND s.type='payment'"),
)


def quote(identifier: str) -> str:
    # sqlite_master names are untrusted schema content. Always escape as
    # identifiers; never interpret them as SQL or emit them in the manifest.
    return '"' + identifier.replace('"', '""') + '"'


def columns_of(db: sqlite3.Connection, table: str) -> set[str]:
    result = {row[1] for row in db.execute(f"PRAGMA table_info({quote(table)})")}
    if not result:
        raise ValueError("Historical coverage has an unreadable table schema")
    return result


def opaque_table_id(table: str) -> str:
    return hashlib.sha256(("pharma-archived-table-v1\0" + table).encode("utf-8")).hexdigest()


def table_family(table: str) -> str:
    if table in FAMILIES:
        return FAMILIES[table]
    if table in EXTENDED_FAMILIES:
        return EXTENDED_FAMILIES[table]
    # SQLite's FTS content/shadow tables are counted individually, but they
    # cannot become public row-level catalog exports through this classifier.
    if table == "master_drugs_fts" or table.startswith("master_drugs_fts_"):
        return "catalog_search_index_quarantined"
    if table.startswith("sqlite_"):
        return "sqlite_internal_metadata"
    return "unclassified"


def module_source_summary(
    db: sqlite3.Connection, available: dict[str, set[str]], row_counts: dict[str, int],
) -> dict[str, dict]:
    """Fixed source joins expose only counts and unsupported layout quarantine."""
    summary: dict[str, dict] = {}
    for label, child, child_key, parent, parent_key, required in MODULE_RELATIONSHIPS:
        if child not in available or parent not in available:
            summary[label] = {"status": "missing_module_table_quarantined",
                              "source_rows_quarantined": row_counts.get(child, 0)}
            continue
        if child_key not in available[child] or parent_key not in available[parent]:
            summary[label] = {"status": "unmapped_legacy_column_quarantined",
                              "source_rows_quarantined": row_counts[child]}
            continue
        child_table = quote(child)
        child_column = quote(child_key)
        parent_table = quote(parent)
        parent_column = quote(parent_key)
        missing, unlinked = db.execute(
            f"SELECT SUM(CASE WHEN c.{child_column} IS NOT NULL AND NOT EXISTS "
            f"(SELECT 1 FROM {parent_table} p WHERE p.{parent_column}=c.{child_column}) "
            f"THEN 1 ELSE 0 END), "
            f"SUM(CASE WHEN c.{child_column} IS NULL THEN 1 ELSE 0 END) "
            f"FROM {child_table} c"
        ).fetchone()
        summary[label] = {
            "status": "structural_link_only",
            "orphan_rows": missing or 0,
            "missing_reference_rows": (unlinked or 0) if required else 0,
            "legacy_unlinked_rows": (unlinked or 0) if not required else 0,
        }
    # A source-linked supplier ledger row remains globally unscoped: the
    # pharmacy cannot be obtained from supplier_id or a mutable reference_id.
    required_ledger = {"type", "reference_id", "supplier_id", "amount"}
    required_purchase = {"id", "supplier_id", "total_amount"}
    if required_ledger.issubset(available["supplier_transactions"]) and (
        required_purchase.issubset(available["purchase_invoices"])
    ):
        invoice_rows, valid_source, anomalous = db.execute(
            "SELECT COUNT(*), "
            "SUM(CASE WHEN EXISTS(SELECT 1 FROM purchase_invoices p "
            "WHERE p.id=st.reference_id AND p.supplier_id=st.supplier_id "
            "AND typeof(st.amount) IN ('integer','real') "
            "AND typeof(p.total_amount) IN ('integer','real') "
            "AND abs(st.amount*100-p.total_amount*100)<0.0001) THEN 1 ELSE 0 END), "
            "SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM purchase_invoices p "
            "WHERE p.id=st.reference_id AND p.supplier_id=st.supplier_id "
            "AND typeof(st.amount) IN ('integer','real') "
            "AND typeof(p.total_amount) IN ('integer','real') "
            "AND abs(st.amount*100-p.total_amount*100)<0.0001) THEN 1 ELSE 0 END) "
            "FROM supplier_transactions st WHERE st.type='invoice'"
        ).fetchone()
        summary["supplier_invoice_ledger_candidate"] = {
            "status": "global_ledger_structural_only",
            "invoice_ledger_rows": invoice_rows,
            "matching_source_and_cents": valid_source or 0,
            "source_or_amount_unmatched": anomalous or 0,
            "source_owner_authenticated": False,
        }
    else:
        summary["supplier_invoice_ledger_candidate"] = {
            "status": "unmapped_legacy_column_quarantined",
            "source_rows_quarantined": row_counts["supplier_transactions"],
            "source_owner_authenticated": False,
        }
    if {"id", "pharmacy_id"}.issubset(available["shifts"]) and (
        {"shift_id", "pharmacy_id"}.issubset(available["cash_movements"])
    ):
        mismatch, unresolved = db.execute(
            "SELECT "
            "SUM(CASE WHEN s.pharmacy_id IS NOT NULL AND c.pharmacy_id IS NOT NULL "
            "AND trim(s.pharmacy_id)<>'' AND trim(c.pharmacy_id)<>'' "
            "AND s.pharmacy_id<>c.pharmacy_id THEN 1 ELSE 0 END), "
            "SUM(CASE WHEN s.pharmacy_id IS NULL OR c.pharmacy_id IS NULL "
            "OR trim(s.pharmacy_id)='' OR trim(c.pharmacy_id)='' "
            "OR s.pharmacy_id='local_default' OR c.pharmacy_id='local_default' "
            "THEN 1 ELSE 0 END) "
            "FROM cash_movements c JOIN shifts s ON s.id=c.shift_id"
        ).fetchone()
        summary["cash_shift_literal_tenant"] = {
            "status": "literal_scope_structural_only",
            "mismatched_literals": mismatch or 0,
            "unknown_or_legacy_scope": unresolved or 0,
        }
    else:
        summary["cash_shift_literal_tenant"] = {
            "status": "unmapped_legacy_column_quarantined",
            "source_rows_quarantined": row_counts["cash_movements"],
        }
    return summary


def native_witness_summary(
    db: sqlite3.Connection, available: dict[str, set[str]], row_counts: dict[str, int],
) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for label, source, witness, join_predicate in WITNESS_LINKS:
        if source not in available:
            result[label] = {
                "status": "source_module_table_absent",
                "source_rows_without_candidate": 0,
                "historic_financial_source_certified": False,
            }
            continue
        if witness not in available:
            result[label] = {
                "status": "native_witness_table_absent",
                "source_rows_without_candidate": row_counts[source],
                "historic_financial_source_certified": False,
            }
            continue
        # These expressions are compile-time-fixed: source, witness and join
        # predicates never come from a GUI, snapshot row or CLI argument.
        # The migration's own trigger is not retroactive: even matching
        # legacy rows remain untrusted without independent ownership proof.
        matched = db.execute(
            f"SELECT COUNT(*) FROM {quote(source)} s "
            f"WHERE EXISTS(SELECT 1 FROM {quote(witness)} w WHERE {join_predicate})"
        ).fetchone()[0]
        result[label] = {
            "status": "structural_candidate_not_authenticated",
            "source_rows_with_candidate": matched,
            "source_rows_without_candidate": row_counts[source] - matched,
            "historic_financial_source_certified": False,
        }
    return result


NUMERIC_FIELDS = (
    ("inventory_quantity", "inventory", "quantity", False),
    ("sale_total", "sales_invoices", "total_amount", True),
    ("sale_line_cost", "sales_items", "cost_price", False),
    ("purchase_total", "purchase_invoices", "total_amount", True),
    ("purchase_line_cost", "purchase_invoice_items", "cost_price", True),
    ("supplier_ledger_amount", "supplier_transactions", "amount", True),
    ("patient_ledger_amount", "patient_transactions", "amount", True),
    ("cash_movement_amount", "cash_movements", "amount", True),
    ("account_balance", "accounts", "balance", False),
)


def amount_shape_counts(
    db: sqlite3.Connection, available: dict[str, set[str]], row_counts: dict[str, int],
) -> dict[str, dict]:
    # Financial checks classify malformed values *without exporting* values,
    # computing replacements or deriving original cost from selling prices.
    output: dict[str, dict] = {}
    for label, table, field, require_cent in NUMERIC_FIELDS:
        if table not in available or field not in available[table]:
            output[label] = {
                "status": "legacy_numeric_column_unavailable",
                "rows_quarantined": row_counts.get(table, 0),
            }
            continue
        c = quote(field)
        invalid = db.execute(
            f"SELECT COUNT(*) FROM {quote(table)} WHERE "
            f"typeof({c}) NOT IN ('integer','real') "
            f"OR {c}<0 "
            + (f"OR abs({c}*100-round({c}*100))>0.0001" if require_cent else "")
        ).fetchone()[0]
        output[label] = {
            "status": "numeric_shape_only",
            "malformed_or_negative_rows": invalid,
            "cost_or_amount_provenance_verified": False,
        }
    return output


def relationship_summary(db: sqlite3.Connection, available: dict[str, set[str]]) -> dict:
    anomalies: dict[str, dict[str, int]] = {}
    for label, child, child_key, parent, parent_key, required in RELATIONSHIPS:
        if child_key not in available[child] or parent_key not in available[parent]:
            raise ValueError("Historical source relationship schema incomplete")
        c, p = quote(child), quote(parent)
        ck, pk = quote(child_key), quote(parent_key)
        missing, null = db.execute(
            f"SELECT "
            f"SUM(CASE WHEN c.{ck} IS NOT NULL AND NOT EXISTS "
            f"(SELECT 1 FROM {p} p WHERE p.{pk}=c.{ck}) THEN 1 ELSE 0 END),"
            f"SUM(CASE WHEN c.{ck} IS NULL THEN 1 ELSE 0 END) FROM {c} c"
        ).fetchone()
        anomalies[label] = {
            "missing_parent": missing or 0,
            "missing_reference": (null or 0) if required else 0,
            "legacy_unlinked": (null or 0) if not required else 0,
        }
    if not {"type", "amount"}.issubset(available["journal_entries"]):
        raise ValueError("Historical journal schema incomplete")
    # Observe ledger anomalies without asserting that matched totals prove
    # provenance, tenant ownership or correctness of original sale cost.
    invalid: int = db.execute(
        "SELECT COUNT(*) FROM journal_entries WHERE "
        "type NOT IN ('debit','credit') OR type IS NULL OR "
        "typeof(amount) NOT IN ('integer','real') OR amount<0 OR "
        "abs(amount*100-round(amount*100))>0.0001"
    ).fetchone()[0]
    unbalanced: int = db.execute(
        "SELECT COUNT(*) FROM (SELECT j.id FROM daily_journals j "
        "LEFT JOIN journal_entries e ON e.journal_id=j.id GROUP BY j.id "
        "HAVING COUNT(e.id)=0 OR "
        "COALESCE(SUM(CASE WHEN e.type='debit' THEN ROUND(e.amount*100) ELSE 0 END),0) "
        "<> COALESCE(SUM(CASE WHEN e.type='credit' THEN ROUND(e.amount*100) ELSE 0 END),0))"
    ).fetchone()[0]
    anomalies["journal_structure"] = {
        "invalid_cent_or_side": invalid,
        "unbalanced_or_empty": unbalanced,
    }
    # A structurally valid invoice/lot join does not establish a legitimate
    # tenant transfer. Count exact literal mismatches separately from scopes
    # that cannot be certified (NULL, blank, or historical local_default).
    for label, child, parent, invoice_key in STOCK_TENANT_LINKS:
        if not {"inventory_id", invoice_key}.issubset(available[child]):
            raise ValueError("Historical inventory lineage schema incomplete")
        if "pharmacy_id" not in available[parent] or "pharmacy_id" not in available["inventory"]:
            raise ValueError("Historical inventory tenant metadata missing")
        joined = db.execute(
            f"SELECT "
            "SUM(CASE WHEN h.pharmacy_id IS NOT NULL "
            "AND lot.pharmacy_id IS NOT NULL "
            "AND h.pharmacy_id<>lot.pharmacy_id THEN 1 ELSE 0 END), "
            "SUM(CASE WHEN h.pharmacy_id IS NULL OR lot.pharmacy_id IS NULL "
            "OR trim(h.pharmacy_id)='' OR trim(lot.pharmacy_id)='' "
            "OR h.pharmacy_id='local_default' OR lot.pharmacy_id='local_default' "
            "THEN 1 ELSE 0 END) "
            f"FROM {quote(child)} item "
            f"JOIN {quote(parent)} h ON h.id=item.{quote(invoice_key)} "
            "JOIN inventory lot ON lot.id=item.inventory_id "
            "WHERE item.inventory_id IS NOT NULL"
        ).fetchone()
        anomalies[label] = {
            "literal_cross_scope": joined[0] or 0,
            "unverifiable_scope": joined[1] or 0,
        }
    return anomalies


def make_manifest(db: sqlite3.Connection) -> dict:
    """Read SQLite *metadata and aggregate counts*, never private row data."""
    from scripts.qa_historical_archive_preflight import scope_counts

    names = sorted(row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ))
    if not names or len(names) > MAX_TABLES or len(set(names)) != len(names):
        raise ValueError("Historical table count is out of supported bounds")
    available = {table: columns_of(db, table) for table in names}
    if not set(REQUIRED).issubset(available):
        raise ValueError("Historical coverage is missing required business tables")
    for table in DIRECT_SCOPE_REQUIRED:
        if "pharmacy_id" not in available[table]:
            raise ValueError("Historical tenant scope metadata missing")

    tables = []
    total_rows = 0
    quarantined = {
        "unscoped_columns": 0, "literal_null": 0,
        "literal_local_default": 0, "blank": 0,
        "explicit_but_unverified": 0,
    }
    family_counts: dict[str, int] = {}
    row_counts: dict[str, int] = {}
    schema_hash = hashlib.sha256()
    for table in names:
        # quote(table) is essential: a malicious snapshot can contain quotes,
        # SQL punctuation, arbitrary names and SQLite FTS shadow tables.
        scope = scope_counts(db, table)
        row_count = scope["rows"]
        row_counts[table] = row_count
        total_rows += row_count
        if total_rows > MAX_ROWS:
            raise ValueError("Historical manifest row budget exceeded")
        kind = table_family(table)
        family_counts[kind] = family_counts.get(kind, 0) + row_count
        if scope["identity"] == "column_absent":
            quarantined["unscoped_columns"] += row_count
            disposition = "unscoped_quarantine"
        else:
            quarantined["literal_null"] += scope["null"]
            quarantined["literal_local_default"] += scope["local_default"]
            quarantined["blank"] += scope["blank"]
            quarantined["explicit_but_unverified"] += scope["other_exact_values"]
            disposition = "literal_scope_unverified"
        entry = {
            "opaque_table_id": opaque_table_id(table),
            "family": kind,
            "rows": row_count,
            "scope": scope,
            "disposition": disposition,
        }
        tables.append(entry)
        schema_hash.update(json.dumps(
            [entry["opaque_table_id"], sorted(available[table]), row_count],
            separators=(",", ":"),
        ).encode("utf-8"))
    return {
        "format": "historical-quarantine-manifest-v1",
        "table_count": len(tables),
        "all_table_rows": total_rows,
        "opaque_schema_coverage_sha256": schema_hash.hexdigest(),
        "tables": tables,
        "domain_counts": dict(sorted(family_counts.items())),
        "quarantined_identity_counts": quarantined,
        "relationships": relationship_summary(db, available),
        "module_source_relations": module_source_summary(db, available, row_counts),
        "native_witness_candidate_counts": native_witness_summary(db, available, row_counts),
        "amount_shape_findings": amount_shape_counts(db, available, row_counts),
        "global_customer_supplier_source_owner_verified": False,
        "historical_tenant_ownership_certified": False,
        "financial_provenance_certified": False,
        "archive_customer_supplier_copy_authorized": False,
        "import_permitted": False,
    }


def verified_manifest(
    db: sqlite3.Connection, expected_sha256: str, hash_source: Callable[[], str],
) -> dict:
    """Enforce integrity and a SHA pin on both sides of manifest generation.

    The hash callback is supplied by the caller after approved_archive() has
    restricted it to the detached source. Synthetic tests supply a RAM hash.
    """
    from scripts.qa_historical_archive_preflight import SHA256

    if SHA256.fullmatch(expected_sha256) is None:
        raise ValueError("Manifest requires an independently pinned SHA-256")
    original = hash_source()
    if original.lower() != expected_sha256.lower():
        raise ValueError("Archive SHA-256 differs from independent source pin")
    db.execute("PRAGMA query_only=ON")
    if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise ValueError("Historical archive integrity failure")
    if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise ValueError("Historical archive foreign-key failure")
    manifest = make_manifest(db)
    if hash_source() != original:
        raise ValueError("Historical archive changed during coverage audit")
    manifest["archive_sha256"] = original
    return manifest
