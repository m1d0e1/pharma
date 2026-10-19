//! DETACHED, UNREGISTERED feasibility checks for a future post-sale COGS correction.
//!
//! This module is not referenced from main.rs or commands/mod.rs. It imports no
//! SQL, Tauri, journal writer, or mutable database API. Its inputs are *claims*,
//! NOT authenticated records. A caller must independently read and reconcile
//! real 043 receipts, all sale/return lines, live authorization, original
//! journals, and acquisition valuation in ONE protected native transaction.
//! Passing these pure checks is NEVER authority to post money or enable UI.
#![allow(dead_code)]

use std::collections::HashSet;

const MICRO: i128 = 1_000_000;
const MAX_MONEY_MICROS: i64 = 1_000_000_000_000_000_000;
const MAX_SOURCE_LINES: usize = 200;
const MAX_QUANTITY_MICROS: i64 = 1_000_000_000_000_000;

type Check<T> = Result<T, &'static str>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Side {
    Debit,
    Credit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HistoricalUnit {
    Large,
    Medium,
    Small,
    Unknown, // Custom/unsealed/null historical labels must never be guessed.
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct JournalLine<'a> {
    pub account_code: &'a str,
    pub side: Side,
    pub amount_micros: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct JournalProof<'a> {
    pub journal_id: &'a str,
    pub pharmacy_id: &'a str,
    pub actor_id: &'a str,
    pub total_amount_micros: i64,
    pub lines: Vec<JournalLine<'a>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SaleLineProof<'a> {
    pub sale_item_id: i64,
    pub drug_id: i64,
    pub inventory_id: Option<&'a str>,
    pub inventory_pharmacy: &'a str,
    pub inventory_drug_id: i64,
    pub is_negative: bool,
    pub quantity_in_unit_micros: i64,
    pub unit: HistoricalUnit,
    pub large_to_medium: i64,
    pub medium_to_small: i64,
    pub cost_per_large_micros: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReturnLineProof<'a> {
    pub return_line_id: i64,
    pub original_sale_id: &'a str,
    pub original_sale_item_id: i64,
    pub drug_id: i64,
    pub restock_inventory_pharmacy: &'a str,
    pub restock_inventory_drug_id: i64,
    pub quantity_in_unit_micros: i64,
    pub unit: HistoricalUnit,
    pub original_cost_per_large_micros: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct Sale043Proof<'a> {
    pub sale_id: &'a str,
    pub sale_pharmacy: &'a str,
    pub sale_actor: &'a str,
    pub sale_payment_method: &'a str,
    pub receipt_request_id: &'a str,
    pub receipt_payment_method: &'a str,
    pub receipt_pharmacy: &'a str,
    pub receipt_actor: &'a str,
    pub receipt_journal_id: &'a str,
    pub sale_status: &'a str,
    pub sale_micros: i64,
    pub cogs_micros: i64,
    pub recorded_line_count: usize,
    pub live_line_count: usize,
    pub snapshot: Vec<SaleLineProof<'a>>,
    pub journal: JournalProof<'a>,
}

#[derive(Clone, Debug)]
pub(crate) struct Return043Proof<'a> {
    pub return_id: &'a str,
    pub original_sale_id: &'a str,
    pub return_pharmacy: &'a str,
    pub return_actor: &'a str,
    pub return_refund_method: &'a str,
    pub receipt_request_id: &'a str,
    pub receipt_refund_method: &'a str,
    pub receipt_pharmacy: &'a str,
    pub receipt_actor: &'a str,
    pub receipt_journal_id: &'a str,
    pub status: &'a str,
    pub refund_micros: i64,
    pub cogs_micros: i64,
    pub recorded_line_count: usize,
    pub live_line_count: usize,
    pub snapshot: Vec<ReturnLineProof<'a>>,
    pub journal: JournalProof<'a>,
}

/// A locked native reader would need to enumerate EVERY completed/approved
/// return header independently, not just the returns already bearing receipts.
#[derive(Clone, Debug)]
pub(crate) struct FinalizedReturnHeader<'a> {
    pub return_id: &'a str,
    pub original_sale_id: &'a str,
    pub pharmacy_id: &'a str,
}

#[derive(Clone, Debug)]
pub(crate) struct HistoricalSource<'a> {
    pub sale: Sale043Proof<'a>,
    pub original_line: SaleLineProof<'a>,
    pub finalized_return_headers: Vec<FinalizedReturnHeader<'a>>,
    pub return_receipts: Vec<Return043Proof<'a>>,
    pub has_negative_settlement: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Outstanding {
    /// Quantity expressed in millionths of one historically defined large unit.
    pub sold_large_micros: i64,
    pub returned_large_micros: i64,
    pub remaining_large_micros: i64,
}

fn scoped_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.trim() == id && id != "local_default"
}

fn money(value: i64) -> bool {
    (0..=MAX_MONEY_MICROS).contains(&value)
}

pub(crate) fn canonical_uuid_v4(id: &str) -> Check<()> {
    let bytes = id.as_bytes();
    if bytes.len() != 36 || bytes[8] != b'-' || bytes[13] != b'-'
        || bytes[18] != b'-' || bytes[23] != b'-' || bytes[14] != b'4'
        || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        || bytes.iter().enumerate().any(|(i, byte)| {
            !matches!(i, 8 | 13 | 18 | 23)
                && !matches!(*byte, b'0'..=b'9' | b'a'..=b'f')
        })
    {
        return Err("Noncanonical UUIDv4 request nonce");
    }
    Ok(())
}

/// Exact conversion from millionths of a *named historical unit* into
/// millionths of the sealed sale's large unit. No float, silent truncation or
/// use of today's mutable drug catalog labels. Fail on non-representable units.
fn to_large_micros(qty: i64, unit: HistoricalUnit, sale: &SaleLineProof<'_>) -> Check<i64> {
    if !(1..=MAX_QUANTITY_MICROS).contains(&qty)
        || sale.large_to_medium <= 0 || sale.medium_to_small <= 0
        || sale.large_to_medium > 1_000_000 || sale.medium_to_small > 1_000_000
    {
        return Err("Unverified historical quantity or unit ratios");
    }
    let divisor = match unit {
        HistoricalUnit::Large => 1_i128,
        HistoricalUnit::Medium => i128::from(sale.large_to_medium),
        HistoricalUnit::Small => i128::from(sale.large_to_medium)
            .checked_mul(i128::from(sale.medium_to_small))
            .ok_or("Historical unit conversion overflow")?,
        HistoricalUnit::Unknown => return Err("Unsealed historical unit name"),
    };
    if i128::from(qty) % divisor != 0 {
        return Err("Historical quantity cannot be represented without rounding");
    }
    let normalized = i128::from(qty) / divisor;
    if normalized <= 0 || normalized > i128::from(MAX_QUANTITY_MICROS) {
        return Err("Invalid normalized historical quantity");
    }
    i64::try_from(normalized).map_err(|_| "Historical quantity overflow")
}

fn exact_value(cost_per_large_micros: i64, large_qty_micros: i64) -> Check<i64> {
    if !money(cost_per_large_micros) || large_qty_micros < 0 {
        return Err("Unbounded historical cost/quantity");
    }
    let product = i128::from(cost_per_large_micros)
        .checked_mul(i128::from(large_qty_micros))
        .ok_or("COGS multiplication overflow")?;
    if product % MICRO != 0 {
        return Err("COGS amount has ambiguous submicro rounding");
    }
    let value = product / MICRO;
    if value > i128::from(MAX_MONEY_MICROS) {
        return Err("COGS exceeds receipt bounds");
    }
    i64::try_from(value).map_err(|_| "COGS exceeds i64 bounds")
}

fn journal_pair(lines: &[JournalLine<'_>], first: (&str, Side), second: (&str, Side), amount: i64) -> Check<()> {
    let first_count = lines.iter().filter(|line| line.account_code == first.0
        && line.side == first.1 && line.amount_micros == amount).count();
    let second_count = lines.iter().filter(|line| line.account_code == second.0
        && line.side == second.1 && line.amount_micros == amount).count();
    if first_count != 1 || second_count != 1 {
        return Err("043 COGS journal directions, amount or account codes conflict");
    }
    Ok(())
}

fn verify_043_journal(
    journal: &JournalProof<'_>, receipt_journal_id: &str,
    tenant: &str, actor: &str, primary_micros: i64,
    cogs_micros: i64, return_kind: bool,
) -> Check<()> {
    if !scoped_id(receipt_journal_id) || !scoped_id(journal.journal_id)
        || journal.journal_id != receipt_journal_id
        || journal.pharmacy_id != tenant || journal.actor_id != actor
        || !money(primary_micros) || !money(cogs_micros)
        || i128::from(journal.total_amount_micros) != i128::from(primary_micros) + i128::from(cogs_micros)
        || journal.lines.len() != (if cogs_micros > 0 { 4 } else { 2 })
        || journal.lines.iter().any(|line| !money(line.amount_micros))
    {
        return Err("043 receipt and journal amount, scope or entry count conflict");
    }
    let (revenue_side, counterpart_side) = if return_kind {
        (Side::Debit, Side::Credit)
    } else {
        (Side::Credit, Side::Debit)
    };
    let revenue_count = journal.lines.iter().filter(|entry| {
        entry.account_code == "3.1" && entry.side == revenue_side
            && entry.amount_micros == primary_micros
    }).count();
    let counterpart_count = journal.lines.iter().filter(|entry| {
        entry.account_code != "3.1" && entry.account_code != "4.1"
            && entry.account_code != "1.1.3"
            && entry.side == counterpart_side && entry.amount_micros == primary_micros
    }).count();
    if revenue_count != 1 || counterpart_count != 1 {
        return Err("043 receipt revenue/refund journal source mismatch");
    }
    if cogs_micros > 0 {
        if return_kind {
            journal_pair(&journal.lines, ("1.1.3", Side::Debit), ("4.1", Side::Credit), cogs_micros)?;
        } else {
            journal_pair(&journal.lines, ("4.1", Side::Debit), ("1.1.3", Side::Credit), cogs_micros)?;
        }
    }
    Ok(())
}

fn valid_sale_line(line: &SaleLineProof<'_>, tenant: &str) -> Check<i64> {
    if line.sale_item_id <= 0 || line.drug_id <= 0 || line.is_negative
        || line.inventory_id.is_none()
        || !line.inventory_id.is_some_and(|id| scoped_id(id))
        || line.inventory_pharmacy != tenant || line.inventory_drug_id != line.drug_id
        || !money(line.cost_per_large_micros)
    {
        return Err("Sale line lacks settled tenant/drug/lot provenance");
    }
    to_large_micros(line.quantity_in_unit_micros, line.unit, line)
}

/// *Structural-only* 043 history validation. Result is a normalized historic
/// quantity, not an adjustment quote, journal, certified source, or permission.
/// Only a future transaction-held reader can guarantee these vectors are
/// complete and reflect immutable disk records.
pub(crate) fn check_historical_source(source: &HistoricalSource<'_>) -> Check<Outstanding> {
    let sale = &source.sale;
    let tenant = sale.receipt_pharmacy;
    if !scoped_id(tenant) || !scoped_id(sale.sale_actor) || sale.sale_pharmacy != tenant
        || sale.receipt_actor != sale.sale_actor
        || sale.sale_payment_method.is_empty()
        || sale.receipt_payment_method != sale.sale_payment_method
        || !scoped_id(sale.sale_id) || sale.sale_status != "completed"
        || source.has_negative_settlement
        || sale.recorded_line_count == 0 || sale.recorded_line_count > MAX_SOURCE_LINES
        || sale.recorded_line_count != sale.live_line_count
        || sale.recorded_line_count != sale.snapshot.len()
    {
        return Err("043 sale actor/tenant/status, negative settlement or line count unverified");
    }
    canonical_uuid_v4(sale.receipt_request_id)?;
    verify_043_journal(&sale.journal, sale.receipt_journal_id, tenant,
        sale.receipt_actor, sale.sale_micros, sale.cogs_micros, false)?;

    let mut seen_lines = HashSet::new();
    let mut total_cogs: i128 = 0;
    let mut selected = None;
    for line in &sale.snapshot {
        if !seen_lines.insert(line.sale_item_id) {
            return Err("Duplicate 043 sale line witness");
        }
        let large_qty = valid_sale_line(line, tenant)?;
        total_cogs = total_cogs.checked_add(i128::from(exact_value(line.cost_per_large_micros, large_qty)?))
            .ok_or("043 sale COGS sum overflow")?;
        if line.sale_item_id == source.original_line.sale_item_id {
            if line != &source.original_line {
                return Err("Current sale line contradicts its sealed 043 snapshot");
            }
            selected = Some(large_qty);
        }
    }
    if total_cogs != i128::from(sale.cogs_micros) {
        return Err("043 sale line COGS conflicts with original journal");
    }
    let sold = selected.ok_or("Requested sale item lacks an original 043 line")?;
    let mut seen_return_headers = HashSet::new();
    for header in &source.finalized_return_headers {
        if !scoped_id(header.return_id) || header.original_sale_id != sale.sale_id
            || header.pharmacy_id != tenant || !seen_return_headers.insert(header.return_id)
        {
            return Err("Finalized return source or tenant conflict");
        }
    }
    if seen_return_headers.len() != source.return_receipts.len() {
        return Err("Finalized returns not fully receipted by 043");
    }

    let mut seen_receipts = HashSet::new();
    let mut returned: i128 = 0;
    for receipt in &source.return_receipts {
        if !seen_return_headers.contains(receipt.return_id)
            || !seen_receipts.insert(receipt.return_id)
            || receipt.original_sale_id != sale.sale_id
            || receipt.receipt_pharmacy != tenant || receipt.return_pharmacy != tenant
            || !scoped_id(receipt.receipt_actor)
            || receipt.receipt_actor != receipt.return_actor
            || receipt.return_refund_method.is_empty()
            || receipt.receipt_refund_method != receipt.return_refund_method
            || !matches!(receipt.status, "approved" | "completed")
            || receipt.recorded_line_count == 0 || receipt.recorded_line_count > MAX_SOURCE_LINES
            || receipt.recorded_line_count != receipt.live_line_count
            || receipt.recorded_line_count != receipt.snapshot.len()
        {
            return Err("043 return receipt missing, foreign, duplicate or incomplete");
        }
        canonical_uuid_v4(receipt.receipt_request_id)?;
        verify_043_journal(&receipt.journal, receipt.receipt_journal_id, tenant,
            receipt.receipt_actor, receipt.refund_micros, receipt.cogs_micros, true)?;
        let mut receipt_cogs = 0_i128;
        let mut seen_return_lines = HashSet::new();
        for returned_line in &receipt.snapshot {
            if returned_line.return_line_id <= 0
                || !seen_return_lines.insert(returned_line.return_line_id)
                || returned_line.original_sale_id != sale.sale_id
            {
                return Err("Return snapshot origin/line identity mismatch");
            }
            let original = sale.snapshot.iter()
                .find(|line| line.sale_item_id == returned_line.original_sale_item_id)
                .ok_or("Return refers to an unreceipted original sale line")?;
            if returned_line.drug_id != original.drug_id
                || returned_line.restock_inventory_pharmacy != tenant
                || returned_line.restock_inventory_drug_id != original.drug_id
                || returned_line.original_cost_per_large_micros != original.cost_per_large_micros
            {
                return Err("Return cost/lot/drug/tenant contradicts original sale");
            }
            let large_qty = to_large_micros(returned_line.quantity_in_unit_micros,
                returned_line.unit, original)?;
            receipt_cogs = receipt_cogs.checked_add(i128::from(exact_value(
                original.cost_per_large_micros, large_qty)?))
                .ok_or("043 return COGS sum overflow")?;
            if original.sale_item_id == source.original_line.sale_item_id {
                returned = returned.checked_add(i128::from(large_qty))
                    .ok_or("Returned historical quantity overflow")?;
            }
        }
        if receipt_cogs != i128::from(receipt.cogs_micros) {
            return Err("043 return COGS conflicts with original reversal journal");
        }
    }
    if returned > i128::from(sold) {
        return Err("Completed returns exceed original sold quantity");
    }
    let returned_large_micros = i64::try_from(returned).map_err(|_| "Returned quantity overflow")?;
    Ok(Outstanding {
        sold_large_micros: sold,
        returned_large_micros,
        remaining_large_micros: sold - returned_large_micros,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CorrectionRequest<'a> {
    pub request_id: &'a str,
    pub pharmacy_id: &'a str,
    pub sale_id: &'a str,
    pub sale_item_id: i64,
    pub expected_revision: u64,
    pub proposed_cost_per_large_micros: i64,
    pub reason_code: &'a str,
    pub evidence_reference: &'a str,
}

#[derive(Clone, Debug)]
pub(crate) struct RecordedNonce<'a> {
    pub original_request: CorrectionRequest<'a>,
    pub receipt_journal_id: &'a str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NonceState {
    FreshPreflightOnly,
    IdenticalCommittedReplay,
}

/// No generated nonce, signature or local hash. The persisted source reader
/// must bring a UNIQUE, append-only nonce receipt into this check.
pub(crate) fn check_nonce(
    request: &CorrectionRequest<'_>, current_revision: u64,
    committed: Option<&RecordedNonce<'_>>,
) -> Check<NonceState> {
    canonical_uuid_v4(request.request_id)?;
    if !scoped_id(request.pharmacy_id) || !scoped_id(request.sale_id)
        || request.sale_item_id <= 0 || !money(request.proposed_cost_per_large_micros)
        || request.reason_code.is_empty() || request.reason_code.len() > 64
        || !request.reason_code.bytes().all(|byte| byte.is_ascii_uppercase() || byte == b'_')
        || request.evidence_reference.is_empty() || request.evidence_reference.len() > 128
        || request.evidence_reference.trim() != request.evidence_reference
    {
        return Err("Unbounded, unidentified or unproved correction request");
    }
    if let Some(existing) = committed {
        if existing.original_request.request_id != request.request_id {
            return Err("Nonce witness does not belong to request");
        }
        if &existing.original_request != request || !scoped_id(existing.receipt_journal_id) {
            return Err("Canonical request nonce was reused with different content");
        }
        return Ok(NonceState::IdenticalCommittedReplay);
    }
    if request.expected_revision != current_revision {
        return Err("Correction source revision stale");
    }
    Ok(NonceState::FreshPreflightOnly)
}

/// An *origin claim*, NOT independent certification. A future native
/// transaction must join the exact immutable purchase/acquisition event,
/// original line, lot valuation and journal in storage before even calling
/// this check. The owner's proposed number or a mutable inventory price
/// cannot constitute that evidence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ValuationOrigin {
    ImmutableAcquisitionCorrection,
    MutableInventoryCost,
    OwnerEnteredNumber,
    UnknownLegacy,
}

#[derive(Clone, Debug)]
pub(crate) struct ValuationWitness<'a> {
    pub origin: ValuationOrigin,
    pub acquisition_event_id: &'a str,
    pub valuation_correction_receipt_id: &'a str,
    pub valuation_journal_id: &'a str,
    pub pharmacy_id: &'a str,
    pub inventory_id: &'a str,
    pub drug_id: i64,
    pub original_cost_per_large_micros: i64,
    pub corrected_cost_per_large_micros: i64,
    pub explicitly_proven_historical_zero: bool,
}

/// This only rejects malformed/inconsistent evidence. There is deliberately
/// no approve/write API or monetary amount to post in this module.
pub(crate) fn check_valuation_claim(
    request: &CorrectionRequest<'_>,
    original: &SaleLineProof<'_>,
    witness: &ValuationWitness<'_>,
) -> Check<()> {
    if witness.origin != ValuationOrigin::ImmutableAcquisitionCorrection
        || !scoped_id(witness.acquisition_event_id)
        || !scoped_id(witness.valuation_correction_receipt_id)
        || !scoped_id(witness.valuation_journal_id)
        || witness.pharmacy_id != request.pharmacy_id
        || witness.pharmacy_id != original.inventory_pharmacy
        || original.inventory_id != Some(witness.inventory_id)
        || witness.drug_id != original.drug_id
        || witness.original_cost_per_large_micros != original.cost_per_large_micros
        || witness.corrected_cost_per_large_micros != request.proposed_cost_per_large_micros
        || !money(witness.original_cost_per_large_micros)
        || !money(witness.corrected_cost_per_large_micros)
        || (original.cost_per_large_micros == 0 && !witness.explicitly_proven_historical_zero)
    {
        return Err("No independently sourced, scope-matched acquisition valuation proof");
    }
    Ok(())
}

/// A future refund needs its own separately sealed *supplemental* reversal,
/// in addition to its 043 historical-cost reversal; no original is rewritten.
/// This only checks a detached, already-resolved witness, not DB atomicity,
/// uniqueness or independent acquisition cost.
pub(crate) struct FutureReturnCompensation<'a> {
    pub sale_id: &'a str,
    pub pharmacy_id: &'a str,
    pub correction_revision: u64,
    pub return_id: &'a str,
    pub original_sale_item_id: i64,
    pub refund_nonce: &'a str,
    pub original_043_return_receipt_id: &'a str,
    pub supplemental_journal: JournalProof<'a>,
    pub historical_sale_line: SaleLineProof<'a>,
    pub returned_quantity_in_unit_micros: i64,
    pub returned_unit: HistoricalUnit,
    pub previous_cost_per_large_micros: i64,
    pub effective_cost_per_large_micros: i64,
}

pub(crate) fn check_later_return_compensation(source: &FutureReturnCompensation<'_>) -> Check<()> {
    canonical_uuid_v4(source.refund_nonce)?;
    if !scoped_id(source.sale_id) || !scoped_id(source.pharmacy_id)
        || !scoped_id(source.return_id)
        || source.original_043_return_receipt_id != source.return_id
        || source.correction_revision == 0
        || source.original_sale_item_id != source.historical_sale_line.sale_item_id
        || !money(source.previous_cost_per_large_micros)
        || !money(source.effective_cost_per_large_micros)
        || source.supplemental_journal.pharmacy_id != source.pharmacy_id
        || !scoped_id(source.supplemental_journal.actor_id)
        || !scoped_id(source.supplemental_journal.journal_id)
        || source.supplemental_journal.lines.len() != 2
    {
        return Err("Later return compensation source/receipt/tenant mismatch");
    }
    let historical_sold = valid_sale_line(&source.historical_sale_line, source.pharmacy_id)?;
    let quantity = to_large_micros(source.returned_quantity_in_unit_micros,
        source.returned_unit, &source.historical_sale_line)?;
    if quantity > historical_sold {
        return Err("Later return compensation exceeds original sale quantity");
    }
    let change = i128::from(source.effective_cost_per_large_micros)
        - i128::from(source.previous_cost_per_large_micros);
    let product = change.checked_mul(i128::from(quantity))
        .ok_or("Later return reversal overflow")?;
    if product == 0 || product % MICRO != 0 {
        return Err("Later return has zero or inexact correction reversal");
    }
    let abs_amount = product.abs() / MICRO;
    if abs_amount > i128::from(MAX_MONEY_MICROS)
        || i128::from(source.supplemental_journal.total_amount_micros) != abs_amount
    {
        return Err("Later return supplemental journal amount unverified");
    }
    let amount = i64::try_from(abs_amount).map_err(|_| "Later return journal overflow")?;
    if change > 0 {
        journal_pair(&source.supplemental_journal.lines,
            ("1.1.3", Side::Debit), ("4.1", Side::Credit), amount)?;
    } else {
        journal_pair(&source.supplemental_journal.lines,
            ("4.1", Side::Debit), ("1.1.3", Side::Credit), amount)?;
    }
    Ok(())
}

/// An independently enumerated correction chain must be fully represented by
/// unique supplemental reversal receipts in ONE refund transaction. This
/// function cannot certify transaction atomicity, native receipt persistence
/// or replay safety; those remain database-enforced release blockers.
pub(crate) fn check_complete_later_return_reversals(
    expected_revisions: &[u64],
    supplementals: &[FutureReturnCompensation<'_>],
) -> Check<()> {
    if expected_revisions.is_empty() || expected_revisions.len() != supplementals.len() {
        return Err("Later refund correction-reversal set incomplete");
    }
    let mut expected = HashSet::new();
    for revision in expected_revisions {
        if *revision == 0 || !expected.insert(*revision) {
            return Err("Later refund correction chain has duplicate revision");
        }
    }
    let first = &supplementals[0];
    let mut seen_revisions = HashSet::new();
    let mut seen_journals = HashSet::new();
    for source in supplementals {
        check_later_return_compensation(source)?;
        if source.refund_nonce != first.refund_nonce
            || source.return_id != first.return_id
            || source.sale_id != first.sale_id
            || source.pharmacy_id != first.pharmacy_id
            || source.original_sale_item_id != first.original_sale_item_id
            || source.returned_quantity_in_unit_micros != first.returned_quantity_in_unit_micros
            || source.returned_unit != first.returned_unit
            || !expected.contains(&source.correction_revision)
            || !seen_revisions.insert(source.correction_revision)
            || !seen_journals.insert(source.supplemental_journal.journal_id)
        {
            return Err("Later refund reversal has duplicate, missing or foreign correction source");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONCE: &str = "550e8400-e29b-41d4-a716-446655440000";
    const REFUND_NONCE: &str = "550e8400-e29b-41d4-b716-446655440001";
    const COST: i64 = 115_500_000;
    const SALE_AMOUNT: i64 = 400_000_000;
    const SALE_COGS: i64 = 231_000_000;
    const RETURN_AMOUNT: i64 = 200_000_000;

    fn sale_line() -> SaleLineProof<'static> {
        SaleLineProof {
            sale_item_id: 17, drug_id: 9, inventory_id: Some("lot-a"),
            inventory_pharmacy: "tenant-a", inventory_drug_id: 9, is_negative: false,
            quantity_in_unit_micros: 2_000_000, unit: HistoricalUnit::Large,
            large_to_medium: 10, medium_to_small: 2,
            cost_per_large_micros: COST,
        }
    }

    fn journal_line(account_code: &'static str, side: Side, amount_micros: i64) -> JournalLine<'static> {
        JournalLine { account_code, side, amount_micros }
    }

    fn sale_journal() -> JournalProof<'static> {
        JournalProof {
            journal_id: "sale-journal", pharmacy_id: "tenant-a", actor_id: "owner-a",
            total_amount_micros: SALE_AMOUNT + SALE_COGS,
            lines: vec![
                journal_line("1.1.1", Side::Debit, SALE_AMOUNT),
                journal_line("3.1", Side::Credit, SALE_AMOUNT),
                journal_line("4.1", Side::Debit, SALE_COGS),
                journal_line("1.1.3", Side::Credit, SALE_COGS),
            ],
        }
    }

    fn return_journal(cogs: i64) -> JournalProof<'static> {
        JournalProof {
            journal_id: "return-journal", pharmacy_id: "tenant-a", actor_id: "owner-a",
            total_amount_micros: RETURN_AMOUNT + cogs,
            lines: vec![
                journal_line("3.1", Side::Debit, RETURN_AMOUNT),
                journal_line("1.1.1", Side::Credit, RETURN_AMOUNT),
                journal_line("1.1.3", Side::Debit, cogs),
                journal_line("4.1", Side::Credit, cogs),
            ],
        }
    }

    fn return_receipt() -> Return043Proof<'static> {
        Return043Proof {
            return_id: "return-a", original_sale_id: "sale-a",
            return_pharmacy: "tenant-a", receipt_pharmacy: "tenant-a",
            return_actor: "owner-a", return_refund_method: "cash",
            receipt_request_id: REFUND_NONCE, receipt_refund_method: "cash",
            receipt_actor: "owner-a", receipt_journal_id: "return-journal",
            status: "approved", refund_micros: RETURN_AMOUNT,
            cogs_micros: COST, recorded_line_count: 1, live_line_count: 1,
            snapshot: vec![ReturnLineProof {
                return_line_id: 51, original_sale_id: "sale-a",
                original_sale_item_id: 17, drug_id: 9,
                restock_inventory_pharmacy: "tenant-a", restock_inventory_drug_id: 9,
                quantity_in_unit_micros: 1_000_000, unit: HistoricalUnit::Large,
                original_cost_per_large_micros: COST,
            }],
            journal: return_journal(COST),
        }
    }

    fn historical() -> HistoricalSource<'static> {
        let original = sale_line();
        HistoricalSource {
            sale: Sale043Proof {
                sale_id: "sale-a", sale_pharmacy: "tenant-a",
                sale_actor: "owner-a", receipt_pharmacy: "tenant-a",
                sale_payment_method: "cash", receipt_request_id: NONCE,
                receipt_payment_method: "cash",
                receipt_actor: "owner-a", receipt_journal_id: "sale-journal",
                sale_status: "completed", sale_micros: SALE_AMOUNT,
                cogs_micros: SALE_COGS, recorded_line_count: 1, live_line_count: 1,
                snapshot: vec![original.clone()], journal: sale_journal(),
            },
            original_line: original,
            finalized_return_headers: vec![FinalizedReturnHeader {
                return_id: "return-a", original_sale_id: "sale-a",
                pharmacy_id: "tenant-a",
            }],
            return_receipts: vec![return_receipt()],
            has_negative_settlement: false,
        }
    }

    fn request() -> CorrectionRequest<'static> {
        CorrectionRequest {
            request_id: NONCE, pharmacy_id: "tenant-a", sale_id: "sale-a",
            sale_item_id: 17, expected_revision: 0,
            proposed_cost_per_large_micros: 120_000_000,
            reason_code: "PROVEN_VALUATION", evidence_reference: "acquisition-event-a",
        }
    }

    fn valuation() -> ValuationWitness<'static> {
        ValuationWitness {
            origin: ValuationOrigin::ImmutableAcquisitionCorrection,
            acquisition_event_id: "purchase-event-a",
            valuation_correction_receipt_id: "purchase-valuation-correction-a",
            valuation_journal_id: "purchase-adjustment-journal-a",
            pharmacy_id: "tenant-a", inventory_id: "lot-a", drug_id: 9,
            original_cost_per_large_micros: COST,
            corrected_cost_per_large_micros: 120_000_000,
            explicitly_proven_historical_zero: false,
        }
    }

    fn compensation() -> FutureReturnCompensation<'static> {
        FutureReturnCompensation {
            sale_id: "sale-a", pharmacy_id: "tenant-a", correction_revision: 1,
            return_id: "return-future", original_sale_item_id: 17,
            refund_nonce: REFUND_NONCE,
            original_043_return_receipt_id: "return-future",
            historical_sale_line: sale_line(),
            returned_quantity_in_unit_micros: 1_000_000,
            returned_unit: HistoricalUnit::Large,
            previous_cost_per_large_micros: COST,
            effective_cost_per_large_micros: 120_000_000,
            supplemental_journal: JournalProof {
                journal_id: "supplemental-return-reversal", pharmacy_id: "tenant-a",
                actor_id: "owner-a", total_amount_micros: 4_500_000,
                lines: vec![
                    journal_line("1.1.3", Side::Debit, 4_500_000),
                    journal_line("4.1", Side::Credit, 4_500_000),
                ],
            },
        }
    }

    #[test]
    fn historical_043_fixture_is_structurally_consistent_but_never_authorizes_posting() {
        let checked = check_historical_source(&historical()).unwrap();
        assert_eq!(checked, Outstanding {
            sold_large_micros: 2_000_000,
            returned_large_micros: 1_000_000,
            remaining_large_micros: 1_000_000,
        });
        // The result contains *only* normalized quantities, not an account,
        // journal command, user authorization or approved cost adjustment.
    }

    #[test]
    fn denies_unreceipted_finalized_return_and_partial_receipt_coverage() {
        let mut source = historical();
        source.return_receipts.clear();
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.finalized_return_headers.clear();
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.return_receipts[0].recorded_line_count = 2;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.finalized_return_headers.push(FinalizedReturnHeader {
            return_id: "return-unreceipted", original_sale_id: "sale-a",
            pharmacy_id: "tenant-a",
        });
        assert!(check_historical_source(&source).is_err());
    }

    #[test]
    fn denies_original_sale_snapshot_lot_scope_cost_and_journal_mutation() {
        let mut source = historical();
        source.original_line.cost_per_large_micros += 1;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.sale.snapshot[0].inventory_pharmacy = "foreign-tenant";
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.sale.snapshot[0].inventory_drug_id = 777;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.sale.journal.lines[2].account_code = "5.1";
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.sale.journal.lines[2].amount_micros += 1;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.sale.cogs_micros += 1;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.sale.receipt_actor = "foreign-owner";
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.sale.receipt_payment_method = "credit";
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.sale.receipt_request_id = "noncanonical-sale-request";
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.sale.live_line_count = 2;
        assert!(check_historical_source(&source).is_err());
    }

    #[test]
    fn denies_rewritten_or_foreign_return_source_even_if_restock_lot_exists() {
        let mut source = historical();
        source.return_receipts[0].snapshot[0].original_sale_item_id = 81;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.return_receipts[0].snapshot[0].original_sale_id = "other-sale";
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.return_receipts[0].snapshot[0].restock_inventory_drug_id = 2;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.return_receipts[0].snapshot[0].restock_inventory_pharmacy = "tenant-b";
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.return_receipts[0].snapshot[0].original_cost_per_large_micros += 1;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.return_receipts[0].journal.lines[2].side = Side::Credit;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.return_receipts[0].receipt_journal_id = "orphan";
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.return_receipts[0].receipt_actor = "foreign-owner";
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.return_receipts[0].receipt_refund_method = "other-method";
        assert!(check_historical_source(&source).is_err());
    }

    #[test]
    fn excludes_negative_stock_unknown_custom_units_and_unsettled_cost() {
        let mut source = historical();
        source.has_negative_settlement = true;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.sale.snapshot[0].is_negative = true;
        source.original_line.is_negative = true;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.sale.snapshot[0].unit = HistoricalUnit::Unknown;
        source.original_line.unit = HistoricalUnit::Unknown;
        assert!(check_historical_source(&source).is_err());
        let mut source = historical();
        source.return_receipts[0].snapshot[0].unit = HistoricalUnit::Unknown;
        assert!(check_historical_source(&source).is_err());
        assert!(to_large_micros(1_000_000, HistoricalUnit::Medium,
            &SaleLineProof { large_to_medium: 3, ..sale_line() }).is_err());
        assert!(exact_value(MAX_MONEY_MICROS, 2_000_000).is_err());
    }

    #[test]
    fn supports_only_exact_historical_partial_conversion_and_rejects_overreturns() {
        let mut source = historical();
        let item = &mut source.return_receipts[0].snapshot[0];
        item.unit = HistoricalUnit::Small;
        item.quantity_in_unit_micros = 1_000_000; // 1 of 20 small units = .05 large
        source.return_receipts[0].cogs_micros = 5_775_000;
        source.return_receipts[0].journal = return_journal(5_775_000);
        let checked = check_historical_source(&source).unwrap();
        assert_eq!(checked.returned_large_micros, 50_000);
        assert_eq!(checked.remaining_large_micros, 1_950_000);

        let mut source = historical();
        source.return_receipts[0].snapshot[0].quantity_in_unit_micros = 3_000_000;
        source.return_receipts[0].cogs_micros = 346_500_000;
        source.return_receipts[0].journal = return_journal(346_500_000);
        assert!(check_historical_source(&source).is_err());
    }

    #[test]
    fn zero_cost_requires_an_explicit_proven_historical_acquisition_source() {
        let original = SaleLineProof { cost_per_large_micros: 0, ..sale_line() };
        let mut witness = valuation();
        witness.original_cost_per_large_micros = 0;
        assert!(check_valuation_claim(&request(), &original, &witness).is_err());
        witness.explicitly_proven_historical_zero = true;
        assert!(check_valuation_claim(&request(), &original, &witness).is_ok());
        witness.origin = ValuationOrigin::OwnerEnteredNumber;
        assert!(check_valuation_claim(&request(), &original, &witness).is_err());
        witness.origin = ValuationOrigin::MutableInventoryCost;
        assert!(check_valuation_claim(&request(), &original, &witness).is_err());
        witness.origin = ValuationOrigin::UnknownLegacy;
        assert!(check_valuation_claim(&request(), &original, &witness).is_err());
    }

    #[test]
    fn valuation_identity_must_match_acquisition_origin_lot_drug_and_tenant() {
        assert!(check_valuation_claim(&request(), &sale_line(), &valuation()).is_ok());
        let mut witness = valuation();
        witness.pharmacy_id = "foreign-tenant";
        assert!(check_valuation_claim(&request(), &sale_line(), &witness).is_err());
        let mut witness = valuation();
        witness.drug_id = 77;
        assert!(check_valuation_claim(&request(), &sale_line(), &witness).is_err());
        let mut witness = valuation();
        witness.inventory_id = "different-lot";
        assert!(check_valuation_claim(&request(), &sale_line(), &witness).is_err());
        let mut witness = valuation();
        witness.acquisition_event_id = "";
        assert!(check_valuation_claim(&request(), &sale_line(), &witness).is_err());
        let mut witness = valuation();
        witness.corrected_cost_per_large_micros += 1;
        assert!(check_valuation_claim(&request(), &sale_line(), &witness).is_err());
    }

    #[test]
    fn canonical_nonce_replay_is_only_structural_and_never_posts() {
        assert_eq!(check_nonce(&request(), 0, None).unwrap(), NonceState::FreshPreflightOnly);
        let committed = RecordedNonce {
            original_request: request(), receipt_journal_id: "committed-correction-journal",
        };
        assert_eq!(check_nonce(&request(), 99, Some(&committed)).unwrap(),
            NonceState::IdenticalCommittedReplay);
        let mut conflicting = request();
        conflicting.proposed_cost_per_large_micros += 1;
        assert!(check_nonce(&conflicting, 0, Some(&committed)).is_err());
        assert!(check_nonce(&request(), 1, None).is_err());
        let mut invalid = request();
        invalid.request_id = "550e8400-e29b-11d4-a716-446655440000"; // UUIDv1
        assert!(check_nonce(&invalid, 0, None).is_err());
        invalid.request_id = "550E8400-E29B-41D4-A716-446655440000";
        assert!(check_nonce(&invalid, 0, None).is_err());
        invalid.request_id = "00000000-0000-4000-7000-000000000000";
        assert!(check_nonce(&invalid, 0, None).is_err());
        let mut no_origin = request();
        no_origin.pharmacy_id = "local_default";
        assert!(check_nonce(&no_origin, 0, None).is_err());
    }

    #[test]
    fn later_refund_must_compensate_only_prior_cost_difference() {
        assert!(check_later_return_compensation(&compensation()).is_ok());
        let mut future = compensation();
        future.supplemental_journal.lines[0].side = Side::Credit;
        assert!(check_later_return_compensation(&future).is_err());
        let mut future = compensation();
        future.original_043_return_receipt_id = "unreceipted-return";
        assert!(check_later_return_compensation(&future).is_err());
        let mut future = compensation();
        future.supplemental_journal.lines[0].amount_micros += 1;
        assert!(check_later_return_compensation(&future).is_err());
        let mut future = compensation();
        future.pharmacy_id = "tenant-b";
        assert!(check_later_return_compensation(&future).is_err());
        let mut future = compensation();
        future.returned_quantity_in_unit_micros = 3_000_000;
        assert!(check_later_return_compensation(&future).is_err());
        let mut future = compensation();
        future.returned_unit = HistoricalUnit::Small;
        future.returned_quantity_in_unit_micros = 1_000_000;
        future.supplemental_journal.total_amount_micros = 225_000;
        future.supplemental_journal.lines[0].amount_micros = 225_000;
        future.supplemental_journal.lines[1].amount_micros = 225_000;
        assert!(check_later_return_compensation(&future).is_ok());
        let mut future = compensation();
        future.effective_cost_per_large_micros = 115_500_001;
        future.returned_unit = HistoricalUnit::Small;
        future.returned_quantity_in_unit_micros = 1_000_000;
        assert!(check_later_return_compensation(&future).is_err()); // 0.05 micro
    }

    #[test]
    fn refund_reversal_chain_refuses_missing_duplicate_foreign_and_unpaired_revisions() {
        assert!(check_complete_later_return_reversals(&[1], &[compensation()]).is_ok());
        assert!(check_complete_later_return_reversals(&[1, 2], &[compensation()]).is_err());
        assert!(check_complete_later_return_reversals(&[1, 1],
            &[compensation(), compensation()]).is_err());
        assert!(check_complete_later_return_reversals(&[1, 2],
            &[compensation(), compensation()]).is_err());
        let mut foreign = compensation();
        foreign.correction_revision = 2;
        foreign.return_id = "different-return";
        foreign.original_043_return_receipt_id = "different-return";
        foreign.supplemental_journal.journal_id = "supplemental-reversal-2";
        assert!(check_complete_later_return_reversals(&[1, 2],
            &[compensation(), foreign]).is_err());
        let mut second = compensation();
        second.correction_revision = 2;
        second.supplemental_journal.journal_id = "supplemental-reversal-2";
        assert!(check_complete_later_return_reversals(&[1, 2],
            &[compensation(), second]).is_ok());
        // The previous positive assertion consumed the fixture; create a
        // separate counterfeit refund nonce instead of reusing moved state.
        let mut second = compensation();
        second.correction_revision = 2;
        second.supplemental_journal.journal_id = "supplemental-reversal-2";
        second.refund_nonce = NONCE;
        assert!(check_complete_later_return_reversals(&[1, 2],
            &[compensation(), second]).is_err());
    }
}
