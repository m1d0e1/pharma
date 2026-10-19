"""Read-only counts for legacy finance precision: no re-posting or normalization.

This is an investigative companion to the pinned-history preflight, NOT an
authorization to reinterpret historic money, source COGS, receipts or tenant
ownership. Decimal(str(SQLite REAL)) is a readable diagnostic approximation:
the original typed SQLite values and original journal are never changed.
Counts only leave the function; original IDs and amounts remain private.
"""
from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import math
import sqlite3

from scripts.legacy_pharmacy_upgrade import UnsafeSource, ensure
from scripts.qa_historical_archive_manifest import NUMERIC_FIELDS, quote

MAX_JOURNAL_ENTRIES = 3_000_000
CENT = Decimal("0.01")
MAX_DIAGNOSTIC_ABSOLUTE_AMOUNT = Decimal("1000000000000000")
# Historical IEEE-754 REAL storage can return 12.339999999999998 for a
# value that was intended as exactly 12.34. Do not call that a fractional
# cent: use the manifest's conservative one-ten-thousandth-of-a-cent margin.
CENT_PRECISION_EPSILON = Decimal("0.0001")


def _decimal(value: object) -> Decimal | None:
    if type(value) not in (int, float):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    # Absurd magnitudes are not safe evidence of historic financial values;
    # keep the original bytes untouched and quarantine the diagnostic field.
    return amount if amount.is_finite() and abs(amount) <= MAX_DIAGNOSTIC_ABSOLUTE_AMOUNT else None


def _subcent_above_float_tolerance(amount: Decimal) -> bool:
    scaled = amount * 100
    whole_cents = scaled.to_integral_value(rounding=ROUND_HALF_UP)
    return abs(scaled - whole_cents) > CENT_PRECISION_EPSILON


def financial_precision_counts(db: sqlite3.Connection) -> dict:
    """Classify immutable financial rows and journal parity, without values/IDs."""
    db.execute("PRAGMA query_only=ON")
    names = {row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    ensure({"daily_journals", "journal_entries"}.issubset(names),
           "historical_finance_schema_incomplete")
    header_count = db.execute("SELECT COUNT(*) FROM daily_journals").fetchone()[0]
    rows = db.execute("SELECT journal_id,type,amount FROM journal_entries "
                      "ORDER BY journal_id")
    counts = {
        "journal_headers": header_count,
        "journal_entries": 0,
        "journals_with_entries": 0,
        "journals_without_entries": 0,
        "journals_with_invalid_side_or_amount": 0,
        "journals_with_fractional_cent_entries": 0,
        "fractional_cent_entries": 0,
        "journals_with_decimal_balancing_difference": 0,
        "journals_with_per_entry_cent_balancing_difference": 0,
        "journals_where_cent_parity_masks_decimal_difference": 0,
        "journals_where_decimal_parity_diverges_from_cent_parity": 0,
        "negative_journal_amount_entries": 0,
        "source_numeric_classification": {},
        "financial_source_provenance_verified": False,
        "original_ledger_values_mutated": False,
        "financial_postings_created": False,
    }
    current_key: object = object()
    debit = credit = debit_cents = credit_cents = Decimal(0)
    invalid = fractional = False
    have_key = False

    def finish() -> None:
        nonlocal debit, credit, debit_cents, credit_cents, invalid, fractional
        if not have_key:
            return
        counts["journals_with_entries"] += 1
        if invalid:
            counts["journals_with_invalid_side_or_amount"] += 1
        else:
            decimal_difference = debit != credit
            cent_difference = debit_cents != credit_cents
            counts["journals_with_decimal_balancing_difference"] += int(
                decimal_difference
            )
            counts["journals_with_per_entry_cent_balancing_difference"] += int(
                cent_difference
            )
            counts["journals_where_cent_parity_masks_decimal_difference"] += int(
                decimal_difference and not cent_difference
            )
            counts["journals_where_decimal_parity_diverges_from_cent_parity"] += int(
                decimal_difference != cent_difference
            )
        counts["journals_with_fractional_cent_entries"] += int(fractional)
        debit = credit = debit_cents = credit_cents = Decimal(0)
        invalid = fractional = False

    for journal_key, side, source_amount in rows:
        counts["journal_entries"] += 1
        ensure(counts["journal_entries"] <= MAX_JOURNAL_ENTRIES,
               "historical_finance_row_budget_exceeded")
        if have_key and journal_key != current_key:
            finish()
        current_key, have_key = journal_key, True
        amount = _decimal(source_amount)
        if side not in ("credit", "debit") or amount is None or amount < 0:
            invalid = True
            if amount is not None and amount < 0:
                counts["negative_journal_amount_entries"] += 1
            continue
        if _subcent_above_float_tolerance(amount):
            fractional = True
            counts["fractional_cent_entries"] += 1
        rounded = (amount * 100).to_integral_value(rounding=ROUND_HALF_UP) * CENT
        if side == "debit":
            debit += amount
            debit_cents += rounded
        else:
            credit += amount
            credit_cents += rounded
    finish()
    ensure(counts["journals_with_entries"] <= header_count,
           "historical_journal_orphan_entries")
    counts["journals_without_entries"] = header_count - counts["journals_with_entries"]

    for category, table, field, requires_cents in NUMERIC_FIELDS:
        # An old schema is allowed to lack a later numeric field; this is
        # recorded as unreviewed rows, not filled from guessed selling prices.
        if table not in names:
            counts["source_numeric_classification"][category] = {
                "unsupported_legacy_rows": 0,
                "nonnumeric_or_nonfinite": 0,
                "negative_original_values": 0,
                "fractional_cent_values": 0,
            }
            continue
        cols = {row[1] for row in db.execute(
            f"PRAGMA table_info({quote(table)})"
        )}
        if field not in cols:
            counts["source_numeric_classification"][category] = {
                "unsupported_legacy_rows": db.execute(
                    f"SELECT COUNT(*) FROM {quote(table)}"
                ).fetchone()[0],
                "nonnumeric_or_nonfinite": 0,
                "negative_original_values": 0,
                "fractional_cent_values": 0,
            }
            continue
        totals = dict(
            unsupported_legacy_rows=0,
            nonnumeric_or_nonfinite=0,
            negative_original_values=0,
            fractional_cent_values=0,
        )
        for (raw_value,) in db.execute(
            f"SELECT {quote(field)} FROM {quote(table)}"
        ):
            amount = _decimal(raw_value)
            if amount is None:
                totals["nonnumeric_or_nonfinite"] += 1
            else:
                totals["negative_original_values"] += int(amount < 0)
                if requires_cents:
                    totals["fractional_cent_values"] += int(
                        _subcent_above_float_tolerance(amount)
                    )
        counts["source_numeric_classification"][category] = totals
    return counts
