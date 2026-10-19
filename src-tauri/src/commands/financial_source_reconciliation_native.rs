//! Read-only, owner-only financial SOURCE -> JOURNAL reconciliation.
//!
//! Historical journals have random UUID primary keys and no immutable source
//! foreign key. Purchase markers are mutable descriptions; sales/return
//! descriptions contain only the first eight invoice characters. Accounts
//! are global and their classifications/mappings may have changed. Therefore
//! source-claim mismatches are NOT assertions of fraud or a COGS certification.
//! Only directly contradictory stored FKs, pharmacy scopes, and ledger sums
//! are marked explicit contradictions. NULL tenant is NEVER local_default.
use serde::Serialize;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use tauri::{Manager, State};

use super::auth::LocalSessionState;

const MAX_FINDINGS: usize = 200;
const MAX_SCANNED_ROWS: i64 = 1_000_000;
const MAX_IDENTIFIER_BYTES: usize = 256;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationFinding {
    source_type: &'static str,
    record_id: String,
    source_id: Option<String>,
    source_pharmacy_id: Option<String>,
    // This is the journal's scope for journal findings. For direct stored-FK
    // findings, it is the invoice/return header's scope, not an invented
    // connection to a historical journal.
    journal_pharmacy_id: Option<String>,
    issue_code: String,
    classification: &'static str,
    source_amount: Option<f64>,
    journal_amount: Option<f64>,
    debit_total: Option<f64>,
    credit_total: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinancialSourceReconciliation {
    // No status in this API claims exhaustive historical provenance.
    status: &'static str,
    findings: Vec<ReconciliationFinding>,
    scanned_journals: i64,
    unverifiable_legacy_journals: i64,
    // Only rows with 040 append-only provenance can be checked structurally;
    // unlinked adjustments may be legacy or otherwise unattributed. Neither
    // count certifies historical stock valuation or a mutable current catalog.
    stock_provenance: StockProvenanceCoverage,
    max_findings: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StockProvenanceCoverage {
    recorded: i64,
    structurally_verified: i64,
    review_required: i64,
    unattributed_adjustments: i64,
}

async fn require_active_owner(conn: &mut SqliteConnection, actor: &str) -> Result<(), String> {
    let role: Option<Option<String>> = sqlx::query_scalar(
        "SELECT role FROM main.users WHERE CAST(id AS TEXT)=?
         AND COALESCE(is_active,1)=1 LIMIT 1",
    )
    .bind(actor)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if !role
        .flatten()
        .is_some_and(|role| role.trim().eq_ignore_ascii_case("owner"))
    {
        return Err("Source reconciliation requires a live active owner".into());
    }
    Ok(())
}

fn checked_id(input: Option<String>) -> Result<Option<String>, String> {
    match input {
        None => Ok(None),
        Some(id)
            if !id.is_empty()
                && id.len() <= MAX_IDENTIFIER_BYTES
                && !id.chars().any(char::is_control) =>
        {
            Ok(Some(id))
        }
        _ => Err("Financial source contains malformed identifying data".into()),
    }
}

fn checked_amount(input: Option<f64>) -> Result<Option<f64>, String> {
    match input {
        None => Ok(None),
        Some(amount) if amount.is_finite() && amount.abs() <= 1_000_000_000_000.0 => {
            Ok(Some(amount))
        }
        _ => Err("Financial source reconciliation contains unbounded amount".into()),
    }
}

fn decode(
    row: &sqlx::sqlite::SqliteRow,
    source_type: &'static str,
) -> Result<ReconciliationFinding, String> {
    let code: String = row.try_get("issue_code").map_err(|e| e.to_string())?;
    if !matches!(
        code.as_str(),
        "ledger_entry_journal_missing"
            | "ledger_entry_account_missing"
            | "ledger_entry_invalid_amount_or_side"
            | "ledger_account_type_unverifiable"
            | "journal_has_no_entries"
            | "journal_unbalanced"
            | "native_journal_total_disagrees_with_debits"
            | "purchase_claim_source_missing"
            | "purchase_claim_initial_duplicate"
            | "purchase_claim_scope_unknown"
            | "purchase_claim_scope_conflict"
            | "purchase_return_claim_missing"
            | "purchase_return_claim_duplicate"
            | "purchase_return_claim_scope_unknown"
            | "purchase_return_claim_scope_conflict"
            | "purchase_return_claim_amount_conflict"
            | "lot_claim_missing"
            | "lot_claim_unparseable"
            | "lot_claim_scope_unknown"
            | "lot_claim_scope_conflict"
            | "sale_return_invoice_missing"
            | "sale_return_scope_unknown"
            | "sale_return_scope_conflict"
            | "purchase_return_invoice_missing"
            | "purchase_return_invoice_unlinked"
            | "purchase_return_supplier_conflict"
            | "sale_line_inventory_scope_conflict"
            | "purchase_line_inventory_scope_conflict"
            | "sale_return_line_invoice_conflict"
            | "purchase_return_line_invoice_conflict"
            | "supplier_return_reference_missing"
            | "supplier_return_reference_duplicate"
            | "supplier_return_supplier_conflict"
            | "supplier_return_amount_conflict"
            | "purchase_return_receipt_source_conflict"
            | "purchase_return_receipt_journal_conflict"
            | "purchase_return_receipt_supplier_conflict"
            | "purchase_return_receipt_cash_conflict"
            | "purchase_return_receipt_cash_legacy_unverifiable"
            | "supplier_payment_receipt_source_conflict"
            | "supplier_payment_receipt_ledger_conflict"
            | "supplier_payment_receipt_journal_conflict"
            | "supplier_payment_receipt_account_unverifiable"
            | "supplier_payment_receipt_cash_conflict"
            | "supplier_payment_receipt_balance_conflict"
            | "stock_provenance_source_missing"
            | "stock_provenance_source_conflict"
            | "stock_provenance_snapshot_invalid"
            | "stock_provenance_duplicate_journal_claim"
            | "stock_provenance_current_lot_missing"
            | "stock_provenance_current_lot_scope_unknown"
            | "stock_provenance_current_lot_scope_changed"
            | "stock_provenance_current_actor_missing"
            | "stock_provenance_current_actor_scope_unknown"
            | "stock_provenance_current_actor_scope_changed"
            | "stock_provenance_journal_missing"
            | "stock_provenance_journal_identity_invalid"
            | "stock_provenance_journal_tenant_actor_conflict"
            | "stock_provenance_journal_amount_conflict"
            | "stock_provenance_journal_lines_conflict"
            | "stock_provenance_current_account_unverifiable"
            | "purchase_event_snapshot_invalid"
            | "purchase_event_journal_missing"
            | "purchase_event_journal_scope_conflict"
            | "purchase_event_journal_amount_conflict"
            | "purchase_event_journal_lines_conflict"
            | "purchase_event_current_actor_scope_changed"
            | "purchase_event_current_invoice_unverifiable"
            | "sale_receipt_source_missing_or_changed"
            | "legacy_patient_credit_unreceipted"
            | "native_patient_cash_tenant_unknown"
            | "legacy_cash_patient_movement_unlinked"
            | "legacy_bank_patient_journal_unlinked"
            | "legacy_notice_journal_unlinked"
            | "native_patient_receipt_source_conflict"
            | "native_patient_cash_witness_unverifiable"
            | "native_patient_cash_witness_conflict"
            | "native_notice_cash_witness_unverifiable"
            | "native_notice_cash_witness_conflict"
            | "native_patient_receipt_journal_conflict"
            | "native_patient_receipt_account_unverifiable"
            | "sale_receipt_lines_changed"
            | "sale_receipt_journal_missing"
            | "sale_receipt_journal_scope_conflict"
            | "sale_receipt_amount_unbalanced"
            | "sale_receipt_funding_account_unverifiable"
            | "sale_receipt_current_actor_unverifiable"
            | "return_receipt_source_missing_or_changed"
            | "return_receipt_original_sale_scope_conflict"
            | "return_receipt_lines_changed"
            | "return_receipt_journal_missing"
            | "return_receipt_journal_scope_conflict"
            | "return_receipt_amount_unbalanced"
            | "return_receipt_current_actor_unverifiable"
            | "sale_settlement_source_conflict"
            | "sale_settlement_cost_conservation_conflict"
            | "sale_settlement_journal_conflict"
            | "sale_settlement_current_lot_unverifiable"
            | "delivery_receipt_source_conflict"
            | "delivery_receipt_journal_scope_conflict"
            | "delivery_receipt_amount_unbalanced"
            | "delivery_receipt_cash_movement_conflict"
            | "delivery_receipt_current_actor_unverifiable"
            | "delivery_fractional_amount_needs_review"
            | "purchase_creation_receipt_snapshot_invalid"
            | "purchase_creation_receipt_original_journal_conflict"
            | "purchase_creation_receipt_current_source_unverifiable"
            | "purchase_draft_original_witness_conflict"
            | "purchase_draft_current_source_unverifiable"
            | "purchase_zero_delta_receipt_snapshot_invalid"
            | "purchase_zero_delta_receipt_original_journal_conflict"
            | "purchase_zero_delta_receipt_historical_link_unverifiable"
            | "purchase_zero_delta_receipt_current_source_unverifiable"
    ) {
        return Err("Unknown source reconciliation finding".into());
    }
    let classification = match row
        .try_get::<String, _>("classification")
        .map_err(|e| e.to_string())?
        .as_str()
    {
        "explicit_contradiction" => "explicit_contradiction",
        "source_claim_conflict" => "source_claim_conflict",
        "unverifiable_history" => "unverifiable_history",
        _ => return Err("Unrecognized source reconciliation classification".into()),
    };
    Ok(ReconciliationFinding {
        source_type,
        record_id: checked_id(row.try_get("record_id").map_err(|e| e.to_string())?)?
            .ok_or("Source finding requires a record identity")?,
        source_id: checked_id(row.try_get("source_id").map_err(|e| e.to_string())?)?,
        source_pharmacy_id: checked_id(
            row.try_get("source_pharmacy_id")
                .map_err(|e| e.to_string())?,
        )?,
        journal_pharmacy_id: checked_id(
            row.try_get("journal_pharmacy_id")
                .map_err(|e| e.to_string())?,
        )?,
        issue_code: code,
        classification,
        source_amount: checked_amount(row.try_get("source_amount").map_err(|e| e.to_string())?)?,
        journal_amount: checked_amount(row.try_get("journal_amount").map_err(|e| e.to_string())?)?,
        debit_total: checked_amount(row.try_get("debit_total").map_err(|e| e.to_string())?)?,
        credit_total: checked_amount(row.try_get("credit_total").map_err(|e| e.to_string())?)?,
    })
}

// All query statements are fixed, parameter-free and return the same columns.
// The caller stops BEFORE decoding or returning a truncated result.
const JOURNAL_ENTRY_REFERENCES: &str = r#"
SELECT CAST(e.id AS TEXT) record_id,CAST(e.journal_id AS TEXT) source_id,
       CAST(NULL AS TEXT) source_pharmacy_id,j.pharmacy_id journal_pharmacy_id,
       CAST(NULL AS REAL) source_amount,
       CAST(NULL AS REAL) journal_amount,
       CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       CASE WHEN j.id IS NULL THEN 'ledger_entry_journal_missing'
            WHEN a.id IS NULL THEN 'ledger_entry_account_missing'
            WHEN typeof(e.amount) NOT IN ('real','integer') OR e.amount<=0
              OR e.amount>1000000000000
              OR LOWER(TRIM(COALESCE(e.type,''))) NOT IN ('debit','credit')
              THEN 'ledger_entry_invalid_amount_or_side'
            ELSE 'ledger_account_type_unverifiable' END issue_code,
       CASE WHEN a.id IS NOT NULL AND j.id IS NOT NULL
                 AND LOWER(TRIM(COALESCE(a.type,''))) NOT IN
                     ('asset','liability','equity','revenue','expense','income','capital')
                 AND typeof(e.amount) IN ('real','integer')
                 AND e.amount>0 AND e.amount<=1000000000000
                 AND LOWER(TRIM(COALESCE(e.type,''))) IN ('debit','credit')
            THEN 'unverifiable_history'
            ELSE 'explicit_contradiction' END classification
FROM main.journal_entries e
LEFT JOIN main.daily_journals j ON j.id=e.journal_id
LEFT JOIN main.accounts a ON a.id=e.account_id
WHERE j.id IS NULL OR a.id IS NULL
   OR typeof(e.amount) NOT IN ('real','integer') OR e.amount<=0
   OR e.amount>1000000000000
   OR LOWER(TRIM(COALESCE(e.type,''))) NOT IN ('debit','credit')
   OR (a.id IS NOT NULL AND LOWER(TRIM(COALESCE(a.type,''))) NOT IN
       ('asset','liability','equity','revenue','expense','income','capital'))
ORDER BY e.id LIMIT 201
"#;

// Accounting-side (debit/credit) reconciliation is sound across account
// types, including reversals. It is NOT sound to prohibit an expense credit
// or an asset credit, so no account-normal-side accusation is made. For
// recognized native purchase and lot journals, the posted header total was
// the sum of debit lines; the source invoice CURRENT total is NOT compared
// because purchase edits can legitimately change it after original posting.
const JOURNAL_TOTALS: &str = r#"
WITH totals AS (
 SELECT j.id,j.pharmacy_id,j.total_amount,j.description,
        COUNT(e.id) entries,
        SUM(CASE WHEN LOWER(TRIM(e.type))='debit' THEN e.amount ELSE 0 END) debit,
        SUM(CASE WHEN LOWER(TRIM(e.type))='credit' THEN e.amount ELSE 0 END) credit,
        SUM(CASE WHEN typeof(e.amount) NOT IN ('integer','real')
                  OR e.amount<=0 OR e.amount>1000000000000
                  OR LOWER(TRIM(COALESCE(e.type,''))) NOT IN ('debit','credit')
                 THEN 1 ELSE 0 END) invalid_entries
 FROM main.daily_journals j
 LEFT JOIN main.journal_entries e ON e.journal_id=j.id
 GROUP BY j.id
)
SELECT CAST(t.id AS TEXT) record_id,CAST(NULL AS TEXT) source_id,
       CAST(NULL AS TEXT) source_pharmacy_id,t.pharmacy_id journal_pharmacy_id,
       CAST(NULL AS REAL) source_amount,
       CASE WHEN typeof(t.total_amount) IN ('integer','real') THEN t.total_amount
            ELSE NULL END journal_amount,
       CAST(t.debit AS REAL) debit_total,CAST(t.credit AS REAL) credit_total,
       CASE WHEN t.entries=0 THEN 'journal_has_no_entries'
            WHEN ABS(t.debit-t.credit)>0.000001 THEN 'journal_unbalanced'
            ELSE 'native_journal_total_disagrees_with_debits' END issue_code,
       'explicit_contradiction' classification
FROM totals t
WHERE t.entries=0
   OR (t.invalid_entries=0 AND
       (ABS(t.debit-t.credit)>0.000001
        OR ((substr(t.description,1,21)='Purchase invoice [id='
              OR substr(t.description,1,18)='Purchase edit [id='
              OR substr(t.description,1,16)='Purchase return '
              OR t.id LIKE 'native-lot-adjust-%'
              OR t.id LIKE 'native-lot-zero-%')
            AND typeof(t.total_amount) IN ('integer','real')
            AND ABS(t.total_amount-t.debit)>0.000001)))
ORDER BY t.id COLLATE BINARY LIMIT 201
"#;

// Purchase invoice initial-post markers carry a full ID; edit markers may
// repeat legitimately and their posted DELTA differs from the invoice's
// current total. Marker text can be edited, so all findings are claims.
const PURCHASE_JOURNAL_CLAIMS: &str = r#"
WITH claims AS (
 SELECT j.id,j.pharmacy_id,j.total_amount,j.description,
        CASE WHEN substr(j.description,1,21)='Purchase invoice [id='
                  AND substr(j.description,-1)=']'
                  AND length(j.description) BETWEEN 23 AND 278
             THEN substr(j.description,22,length(j.description)-22)
             WHEN substr(j.description,1,18)='Purchase edit [id='
                  AND substr(j.description,-1)=']'
                  AND length(j.description) BETWEEN 20 AND 275
             THEN substr(j.description,19,length(j.description)-19)
             ELSE NULL END source_ref,
        CASE WHEN substr(j.description,1,21)='Purchase invoice [id='
             THEN 1 ELSE 0 END initial_claim
 FROM main.daily_journals j
 WHERE substr(j.description,1,21)='Purchase invoice [id='
    OR substr(j.description,1,18)='Purchase edit [id='
), linked AS (
 SELECT j.*,p.id invoice_id,p.pharmacy_id source_scope,
        COUNT(*) OVER (PARTITION BY j.initial_claim,j.source_ref) claim_count
 FROM claims j LEFT JOIN main.purchase_invoices p ON p.id=j.source_ref
)
SELECT CAST(j.id AS TEXT) record_id,j.source_ref source_id,
       j.source_scope source_pharmacy_id,j.pharmacy_id journal_pharmacy_id,
       CAST(NULL AS REAL) source_amount,
       CASE WHEN typeof(j.total_amount) IN ('integer','real')
            THEN j.total_amount ELSE NULL END journal_amount,
       CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       CASE WHEN j.source_ref IS NULL OR j.invoice_id IS NULL
              THEN 'purchase_claim_source_missing'
            WHEN j.initial_claim=1 AND j.claim_count>1
              THEN 'purchase_claim_initial_duplicate'
            WHEN TRIM(COALESCE(j.source_scope,''))=''
              OR TRIM(COALESCE(j.pharmacy_id,''))=''
              THEN 'purchase_claim_scope_unknown'
            ELSE 'purchase_claim_scope_conflict' END issue_code,
       CASE WHEN j.invoice_id IS NULL OR (j.initial_claim=1 AND j.claim_count>1)
                 OR (TRIM(COALESCE(j.source_scope,''))<>''
                     AND TRIM(COALESCE(j.pharmacy_id,''))<>''
                     AND j.source_scope<>j.pharmacy_id)
            THEN 'source_claim_conflict' ELSE 'unverifiable_history'
       END classification
FROM linked j
WHERE j.source_ref IS NULL OR j.invoice_id IS NULL
   OR (j.initial_claim=1 AND j.claim_count>1)
   OR TRIM(COALESCE(j.source_scope,''))=''
   OR TRIM(COALESCE(j.pharmacy_id,''))=''
   OR j.source_scope<>j.pharmacy_id
ORDER BY j.id COLLATE BINARY LIMIT 201
"#;

// Native purchase-return journal amount equals return total at posting.
// No immutable journal -> return FK exists, therefore amount/scope disagreements
// remain source_claim_conflict, never certified diversion or duplicate posting.
const PURCHASE_RETURN_JOURNAL_CLAIMS: &str = r#"
WITH claims AS (
 SELECT j.id,j.pharmacy_id,j.total_amount,
        NULLIF(substr(j.description,17),'') source_ref
 FROM main.daily_journals j
 WHERE substr(j.description,1,16)='Purchase return '
), joined AS (
 SELECT j.*,pr.id return_id,pr.total_amount source_total,
        pi.pharmacy_id source_scope,
        COUNT(*) OVER (PARTITION BY j.source_ref) claimed_count
 FROM claims j
 LEFT JOIN main.purchase_returns pr ON pr.id=j.source_ref
 LEFT JOIN main.purchase_invoices pi ON pi.id=pr.purchase_invoice_id
)
SELECT CAST(j.id AS TEXT) record_id,j.source_ref source_id,
       j.source_scope source_pharmacy_id,j.pharmacy_id journal_pharmacy_id,
       CASE WHEN typeof(j.source_total) IN ('real','integer')
            THEN j.source_total ELSE NULL END source_amount,
       CASE WHEN typeof(j.total_amount) IN ('real','integer')
            THEN j.total_amount ELSE NULL END journal_amount,
       CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       CASE WHEN j.return_id IS NULL THEN 'purchase_return_claim_missing'
            WHEN j.claimed_count>1 THEN 'purchase_return_claim_duplicate'
            WHEN TRIM(COALESCE(j.source_scope,''))=''
              OR TRIM(COALESCE(j.pharmacy_id,''))=''
              THEN 'purchase_return_claim_scope_unknown'
            WHEN j.source_scope<>j.pharmacy_id
              THEN 'purchase_return_claim_scope_conflict'
            ELSE 'purchase_return_claim_amount_conflict' END issue_code,
       CASE WHEN j.return_id IS NOT NULL AND
                 (TRIM(COALESCE(j.source_scope,''))=''
                  OR TRIM(COALESCE(j.pharmacy_id,''))='')
            THEN 'unverifiable_history' ELSE 'source_claim_conflict'
       END classification
FROM joined j
WHERE j.return_id IS NULL OR j.claimed_count>1
   OR TRIM(COALESCE(j.source_scope,''))=''
   OR TRIM(COALESCE(j.pharmacy_id,''))=''
   OR j.source_scope<>j.pharmacy_id
   OR (typeof(j.total_amount) IN ('real','integer')
       AND typeof(j.source_total) IN ('real','integer')
       AND ABS(j.total_amount-j.source_total)>0.005)
ORDER BY j.id COLLATE BINARY LIMIT 201
"#;

// Native lot journal PK namespace is stable, but lot identity is embedded in
// mutable description text and current inventory cost/quantity can change
// after posting. The text is not a historical COGS or valuation proof.
const LOT_JOURNAL_CLAIMS: &str = r#"
WITH raw_claims AS (
 SELECT j.id,j.pharmacy_id,
        CASE WHEN instr(COALESCE(j.description,''),'[lot_id=')>0
             THEN substr(j.description,instr(j.description,'[lot_id=')+8)
             ELSE NULL END tail
 FROM main.daily_journals j
 WHERE (j.id LIKE 'native-lot-adjust-%' OR j.id LIKE 'native-lot-zero-%')
   AND NOT EXISTS (
     SELECT 1 FROM main.native_stock_ledger_provenance p WHERE p.journal_id=j.id
   )
), claims AS (
 SELECT id,pharmacy_id,
        CASE WHEN tail IS NOT NULL AND instr(tail,']') BETWEEN 2 AND 257
             THEN substr(tail,1,instr(tail,']')-1) ELSE NULL END lot_ref
 FROM raw_claims
)
SELECT CAST(j.id AS TEXT) record_id,j.lot_ref source_id,
       i.pharmacy_id source_pharmacy_id,j.pharmacy_id journal_pharmacy_id,
       CAST(NULL AS REAL) source_amount,CAST(NULL AS REAL) journal_amount,
       CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       CASE WHEN j.lot_ref IS NULL THEN 'lot_claim_unparseable'
            WHEN i.id IS NULL THEN 'lot_claim_missing'
            WHEN TRIM(COALESCE(i.pharmacy_id,''))=''
              OR TRIM(COALESCE(j.pharmacy_id,''))=''
              THEN 'lot_claim_scope_unknown'
            ELSE 'lot_claim_scope_conflict' END issue_code,
       CASE WHEN j.lot_ref IS NULL
                 OR TRIM(COALESCE(i.pharmacy_id,''))=''
                 OR TRIM(COALESCE(j.pharmacy_id,''))=''
            THEN 'unverifiable_history' ELSE 'source_claim_conflict' END classification
FROM claims j LEFT JOIN main.inventory i ON i.id=j.lot_ref
WHERE j.lot_ref IS NULL OR i.id IS NULL
   OR TRIM(COALESCE(i.pharmacy_id,''))=''
   OR TRIM(COALESCE(j.pharmacy_id,''))=''
   OR i.pharmacy_id<>j.pharmacy_id
ORDER BY j.id COLLATE BINARY LIMIT 201
"#;

// returns.invoice_id is a stored relationship, not a note; do not infer NULL
// tenant from current employee or shift. Header scope mismatch is a concrete
// stored contradiction even if historical intent cannot be reconstructed.
const SALES_RETURN_HEADERS: &str = r#"
SELECT CAST(r.id AS TEXT) record_id,CAST(r.invoice_id AS TEXT) source_id,
       s.pharmacy_id source_pharmacy_id,r.pharmacy_id journal_pharmacy_id,
       CAST(NULL AS REAL) source_amount,CAST(NULL AS REAL) journal_amount,
       CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       CASE WHEN s.id IS NULL THEN 'sale_return_invoice_missing'
            WHEN TRIM(COALESCE(s.pharmacy_id,''))=''
              OR TRIM(COALESCE(r.pharmacy_id,''))=''
              THEN 'sale_return_scope_unknown'
            ELSE 'sale_return_scope_conflict' END issue_code,
       CASE WHEN s.id IS NOT NULL AND
                 TRIM(COALESCE(s.pharmacy_id,''))<>'' AND
                 TRIM(COALESCE(r.pharmacy_id,''))<>'' AND
                 s.pharmacy_id<>r.pharmacy_id
            THEN 'explicit_contradiction' ELSE 'unverifiable_history'
       END classification
FROM main.returns r LEFT JOIN main.sales_invoices s ON s.id=r.invoice_id
WHERE s.id IS NULL OR TRIM(COALESCE(s.pharmacy_id,''))=''
   OR TRIM(COALESCE(r.pharmacy_id,''))=''
   OR s.pharmacy_id<>r.pharmacy_id
ORDER BY r.id COLLATE BINARY LIMIT 201
"#;

// Purchase return has no persisted pharmacy column. Its invoice ID is the
// scope source; never claim a tenant from supplier_id or current user scope.
const PURCHASE_RETURN_HEADERS: &str = r#"
SELECT CAST(pr.id AS TEXT) record_id,
       CAST(pr.purchase_invoice_id AS TEXT) source_id,
       pi.pharmacy_id source_pharmacy_id,
       CAST(NULL AS TEXT) journal_pharmacy_id,
       CAST(NULL AS REAL) source_amount,CAST(NULL AS REAL) journal_amount,
       CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       CASE WHEN TRIM(COALESCE(pr.purchase_invoice_id,''))=''
              THEN 'purchase_return_invoice_unlinked'
            WHEN pi.id IS NULL THEN 'purchase_return_invoice_missing'
            ELSE 'purchase_return_supplier_conflict' END issue_code,
       CASE WHEN pi.id IS NOT NULL AND
                 pi.supplier_id IS NOT NULL AND pr.supplier_id IS NOT NULL AND
                 pi.supplier_id<>pr.supplier_id
            THEN 'explicit_contradiction' ELSE 'unverifiable_history'
       END classification
FROM main.purchase_returns pr
LEFT JOIN main.purchase_invoices pi ON pi.id=pr.purchase_invoice_id
WHERE TRIM(COALESCE(pr.purchase_invoice_id,''))=''
   OR pi.id IS NULL
   OR (pi.supplier_id IS NOT NULL AND pr.supplier_id IS NOT NULL
       AND pi.supplier_id<>pr.supplier_id)
ORDER BY pr.id COLLATE BINARY LIMIT 201
"#;

// Invoice-item -> lot is a real stored relationship. These are contrasts of
// persisted branch IDs only, NOT claims that a mutable lot has never moved.
const INVOICE_ITEM_TENANT_LINKS: &str = r#"
WITH links AS (
 SELECT 'sale' kind,CAST(si.id AS TEXT) id,CAST(si.inventory_id AS TEXT) lot_ref,
        s.pharmacy_id invoice_scope,i.pharmacy_id lot_scope
 FROM main.sales_items si
 JOIN main.sales_invoices s ON s.id=si.invoice_id
 JOIN main.inventory i ON i.id=si.inventory_id
 WHERE TRIM(COALESCE(si.inventory_id,''))<>''
   AND TRIM(COALESCE(s.pharmacy_id,''))<>''
   AND TRIM(COALESCE(i.pharmacy_id,''))<>''
   AND s.pharmacy_id<>i.pharmacy_id
 UNION ALL
 SELECT 'purchase',CAST(pi.id AS TEXT),CAST(pi.inventory_id AS TEXT),
        p.pharmacy_id,i.pharmacy_id
 FROM main.purchase_invoice_items pi
 JOIN main.purchase_invoices p ON p.id=pi.invoice_id
 JOIN main.inventory i ON i.id=pi.inventory_id
 WHERE TRIM(COALESCE(pi.inventory_id,''))<>''
   AND TRIM(COALESCE(p.pharmacy_id,''))<>''
   AND TRIM(COALESCE(i.pharmacy_id,''))<>''
   AND p.pharmacy_id<>i.pharmacy_id
)
SELECT id record_id,lot_ref source_id,
       lot_scope source_pharmacy_id,invoice_scope journal_pharmacy_id,
       CAST(NULL AS REAL) source_amount,CAST(NULL AS REAL) journal_amount,
       CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       CASE WHEN kind='sale' THEN 'sale_line_inventory_scope_conflict'
            ELSE 'purchase_line_inventory_scope_conflict' END issue_code,
       'explicit_contradiction' classification
FROM links ORDER BY kind,id COLLATE BINARY LIMIT 201
"#;

// Original item ID mismatched to return's invoice is a direct contradictory
// FK relation. NULL original IDs can be legitimate old returns and are not
// falsely associated using drug_id or editable product catalog master.
const RETURN_ITEM_PARENT_LINKS: &str = r#"
WITH links AS (
 SELECT 'sale' kind,CAST(ri.id AS TEXT) id,
        CAST(ri.sale_item_id AS TEXT) item_ref,
        s.pharmacy_id original_scope,r.pharmacy_id return_scope,
        si.invoice_id original_invoice,r.invoice_id claimed_invoice
 FROM main.return_items ri
 JOIN main.returns r ON r.id=ri.return_id
 JOIN main.sales_items si ON si.id=ri.sale_item_id
 LEFT JOIN main.sales_invoices s ON s.id=si.invoice_id
 WHERE ri.sale_item_id IS NOT NULL AND si.invoice_id IS NOT r.invoice_id
 UNION ALL
 SELECT 'purchase',CAST(pri.id AS TEXT),
        CAST(pri.purchase_invoice_item_id AS TEXT),
        p.pharmacy_id,source.pharmacy_id,
        pii.invoice_id,pr.purchase_invoice_id
 FROM main.purchase_return_items pri
 JOIN main.purchase_returns pr ON pr.id=pri.purchase_return_id
 JOIN main.purchase_invoice_items pii ON pii.id=pri.purchase_invoice_item_id
 LEFT JOIN main.purchase_invoices p ON p.id=pii.invoice_id
 LEFT JOIN main.purchase_invoices source ON source.id=pr.purchase_invoice_id
 WHERE pri.purchase_invoice_item_id IS NOT NULL
   AND pii.invoice_id IS NOT pr.purchase_invoice_id
)
SELECT id record_id,item_ref source_id,
       original_scope source_pharmacy_id,return_scope journal_pharmacy_id,
       CAST(NULL AS REAL) source_amount,CAST(NULL AS REAL) journal_amount,
       CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       CASE WHEN kind='sale' THEN 'sale_return_line_invoice_conflict'
            ELSE 'purchase_return_line_invoice_conflict' END issue_code,
       'explicit_contradiction' classification
FROM links ORDER BY kind,id COLLATE BINARY LIMIT 201
"#;

// A native purchase return emits one type='return' supplier transaction with
// reference_id=FULL return ID. Repeated type='invoice' rows are LEGITIMATE
// when an invoice was edited, hence they are purposely not treated as dupes.
// Reference_id is not a foreign key, so all disagreements remain claims.
const SUPPLIER_RETURN_CLAIMS: &str = r#"
WITH claims AS (
 SELECT st.id,st.reference_id,st.supplier_id,st.amount,
        pr.id return_id,pr.supplier_id original_supplier,
        pr.total_amount return_amount,p.pharmacy_id return_scope,
        COUNT(*) OVER (PARTITION BY st.reference_id) claim_count
 FROM main.supplier_transactions st
 LEFT JOIN main.purchase_returns pr ON pr.id=st.reference_id
 LEFT JOIN main.purchase_invoices p ON p.id=pr.purchase_invoice_id
 WHERE st.type='return'
)
SELECT CAST(s.id AS TEXT) record_id,CAST(s.reference_id AS TEXT) source_id,
       s.return_scope source_pharmacy_id,CAST(NULL AS TEXT) journal_pharmacy_id,
       CASE WHEN typeof(s.return_amount) IN ('integer','real')
            THEN s.return_amount ELSE NULL END source_amount,
       CASE WHEN typeof(s.amount) IN ('integer','real') THEN s.amount
            ELSE NULL END journal_amount,
       CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       CASE WHEN s.return_id IS NULL THEN 'supplier_return_reference_missing'
            WHEN s.claim_count>1 THEN 'supplier_return_reference_duplicate'
            WHEN s.supplier_id<>s.original_supplier
              THEN 'supplier_return_supplier_conflict'
            ELSE 'supplier_return_amount_conflict' END issue_code,
       'source_claim_conflict' classification
FROM claims s
WHERE s.return_id IS NULL OR s.claim_count>1
   OR s.supplier_id<>s.original_supplier
   OR (typeof(s.amount) IN ('real','integer')
       AND typeof(s.return_amount) IN ('real','integer')
       AND ABS(s.amount-s.return_amount)>0.005)
ORDER BY s.id LIMIT 201
"#;

// 041 attests original return/tenant/amount. 048 seals linked supplier rows
// and prospective cash refunds, but old cash movements did not store a return
// identifier. Inspect each 041 parent: a query starting at supplier_transactions
// cannot observe a *completely missing* supplier claim.
pub(super) const PURCHASE_RETURN_RECEIPT_FINANCIAL: &str = r#"
WITH claims AS (
 SELECT p.return_id,p.purchase_invoice_id,p.pharmacy_id,p.actor_id,p.supplier_id,
        p.refund_method,p.amount_cents,p.journal_id,
        r.id current_return,r.purchase_invoice_id current_invoice,
        r.supplier_id current_supplier,
        r.refund_method current_method,r.total_amount current_total,
        i.pharmacy_id current_scope,
        j.id current_journal,j.pharmacy_id journal_scope,
        CAST(j.created_by AS TEXT) journal_actor,j.total_amount journal_total,
        (SELECT count(*) FROM journal_entries e WHERE e.journal_id=p.journal_id) journal_lines,
        (SELECT count(*) FROM journal_entries e WHERE e.journal_id=p.journal_id
          AND e.type='debit' AND typeof(e.amount) IN ('integer','real')
          AND abs(e.amount*100-p.amount_cents)<0.0001) exact_debits,
        (SELECT count(*) FROM journal_entries e WHERE e.journal_id=p.journal_id
          AND e.type='credit' AND typeof(e.amount) IN ('integer','real')
          AND abs(e.amount*100-p.amount_cents)<0.0001) exact_credits,
        (SELECT count(*) FROM supplier_transactions st
         WHERE st.reference_id=p.return_id) supplier_rows,
        (SELECT count(*) FROM supplier_transactions st
         WHERE st.reference_id=p.return_id AND st.type='return'
           AND st.supplier_id=p.supplier_id AND typeof(st.amount) IN ('real','integer')
           AND abs(st.amount*100-p.amount_cents)<0.0001) exact_returns,
        (SELECT count(*) FROM supplier_transactions st
         WHERE st.reference_id=p.return_id AND st.type='payment'
           AND st.supplier_id=p.supplier_id AND typeof(st.amount) IN ('real','integer')
           AND abs(st.amount*100+p.amount_cents)<0.0001) exact_payments,
        (SELECT count(*) FROM cash_movements cm
         WHERE cm.source_type='purchase_return' AND cm.target_name=p.return_id) cash_rows,
        (SELECT count(*) FROM cash_movements cm
         WHERE cm.source_type='purchase_return' AND cm.target_name=p.return_id
           AND cm.type='receipt' AND cm.category='purchase_return'
           AND CAST(cm.user_id AS TEXT)=p.actor_id AND cm.pharmacy_id=p.pharmacy_id
           AND typeof(cm.amount) IN ('integer','real')
           AND abs(cm.amount*100-p.amount_cents)<0.0001) exact_cash
 FROM native_purchase_return_provenance p
 LEFT JOIN purchase_returns r ON r.id=p.return_id
 LEFT JOIN purchase_invoices i ON i.id=p.purchase_invoice_id
 LEFT JOIN daily_journals j ON j.id=p.journal_id
), assessed AS (
 SELECT *,CASE
   WHEN current_return IS NULL OR current_invoice IS NOT purchase_invoice_id
     OR current_supplier IS NOT supplier_id
     OR current_method IS NOT refund_method OR current_scope IS NOT pharmacy_id
     OR typeof(current_total) NOT IN ('real','integer')
     OR abs(current_total*100-amount_cents)>0.0001
     THEN 'purchase_return_receipt_source_conflict'
   WHEN current_journal IS NULL OR journal_scope IS NOT pharmacy_id
     OR journal_actor IS NOT actor_id
     OR typeof(journal_total) NOT IN ('real','integer')
     OR abs(journal_total*100-amount_cents)>0.0001
     OR journal_lines<>2 OR exact_debits<>1 OR exact_credits<>1
     THEN 'purchase_return_receipt_journal_conflict'
   WHEN supplier_rows<>CASE WHEN refund_method='cash' THEN 2 ELSE 1 END
     OR exact_returns<>1 OR (refund_method='cash' AND exact_payments<>1)
     THEN 'purchase_return_receipt_supplier_conflict'
   WHEN refund_method='cash' AND cash_rows=0
     THEN 'purchase_return_receipt_cash_legacy_unverifiable'
   WHEN cash_rows<>CASE WHEN refund_method='cash' THEN 1 ELSE 0 END
     OR (refund_method='cash' AND exact_cash<>1)
     THEN 'purchase_return_receipt_cash_conflict'
   ELSE NULL END issue_code
 FROM claims
)
SELECT CAST(return_id AS TEXT) record_id,CAST(purchase_invoice_id AS TEXT) source_id,
       pharmacy_id source_pharmacy_id,journal_scope journal_pharmacy_id,
       CAST(amount_cents AS REAL)/100.0 source_amount,journal_total journal_amount,
       NULL debit_total,NULL credit_total,issue_code,
       CASE WHEN issue_code='purchase_return_receipt_cash_legacy_unverifiable'
                 THEN 'unverifiable_history'
            WHEN issue_code='purchase_return_receipt_supplier_conflict'
                 THEN 'source_claim_conflict'
            ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY return_id LIMIT 201
"#;

// Only 054 receipts claim supplier payment source custody. Historical shared
// supplier balances/transactions remain unverified; do not assign them a tenant.
pub(super) const NATIVE_SUPPLIER_PAYMENT_FINANCIAL: &str = r#"
WITH checked AS (
 SELECT r.*,p.id invoice_exists,p.pharmacy_id invoice_scope,p.supplier_id invoice_supplier,
        c.source_total_cents original_cents,c.initial_journal_id original_journal,
        s.id supplier_exists,s.balance supplier_balance,
        st.id ledger_exists,st.supplier_id ledger_supplier,st.type ledger_type,
        st.reference_id ledger_reference,st.amount ledger_amount,
        (SELECT count(*) FROM supplier_transactions duplicate_claim
          WHERE duplicate_claim.reference_id='supplier-payment:'||r.id) payment_claim_count,
        j.id journal_exists,j.pharmacy_id journal_scope,j.created_by journal_actor,
        j.date journal_date,j.total_amount journal_total,
        cm.id cash_exists,cm.pharmacy_id cash_scope,cm.user_id cash_actor,
        cm.type cash_type,cm.category cash_category,cm.source_type cash_source,
        cm.target_name cash_target,cm.amount cash_amount,sh.pharmacy_id shift_scope,
        (SELECT count(*) FROM journal_entries e WHERE e.journal_id=r.journal_id) entry_count,
        (SELECT count(*) FROM journal_entries e WHERE e.journal_id=r.journal_id
          AND e.type='debit' AND typeof(e.amount) IN ('real','integer')
          AND abs(e.amount*100-r.amount_cents)<0.0001) exact_debit_count,
        (SELECT count(*) FROM journal_entries e WHERE e.journal_id=r.journal_id
          AND e.type='credit' AND typeof(e.amount) IN ('real','integer')
          AND abs(e.amount*100-r.amount_cents)<0.0001) exact_credit_count,
        (SELECT count(*) FROM journal_entries e JOIN accounts a ON a.id=e.account_id
          WHERE e.journal_id=r.journal_id AND e.type='debit' AND a.code='2.1'
            AND typeof(e.amount) IN ('real','integer') AND abs(e.amount*100-r.amount_cents)<0.0001) debit_lines,
        (SELECT count(*) FROM journal_entries e JOIN accounts a ON a.id=e.account_id
          WHERE e.journal_id=r.journal_id AND e.type='credit'
            AND a.code=CASE WHEN r.payment_method='cash' THEN '1.1.1' ELSE '1.1.4' END
            AND typeof(e.amount) IN ('real','integer') AND abs(e.amount*100-r.amount_cents)<0.0001) credit_lines,
        (SELECT count(*) FROM cash_movements other WHERE other.source_type='supplier_payment'
          AND other.target_name=r.id) tagged_cash_count
 FROM native_supplier_payment_receipts r
 LEFT JOIN purchase_invoices p ON p.id=r.invoice_id
 LEFT JOIN native_purchase_create_requests c ON c.invoice_id=r.invoice_id
 LEFT JOIN suppliers s ON s.id=r.supplier_id
 LEFT JOIN supplier_transactions st ON st.id=r.supplier_transaction_id
 LEFT JOIN daily_journals j ON j.id=r.journal_id
 LEFT JOIN cash_movements cm ON cm.id=r.cash_movement_id
 LEFT JOIN shifts sh ON sh.id=cm.shift_id
), assessed AS (
 SELECT *, CASE
   WHEN invoice_exists IS NULL OR invoice_scope IS NOT pharmacy_id
     OR invoice_supplier IS NOT supplier_id OR original_cents IS NULL
     OR original_journal IS NULL THEN 'supplier_payment_receipt_source_conflict'
   WHEN ledger_exists IS NULL OR payment_claim_count<>1 OR ledger_supplier IS NOT supplier_id
     OR ledger_type IS NOT 'payment' OR ledger_reference IS NOT 'supplier-payment:'||id
     OR typeof(ledger_amount) NOT IN ('real','integer')
     OR abs(ledger_amount*100-amount_cents)>0.0001
     THEN 'supplier_payment_receipt_ledger_conflict'
   WHEN journal_exists IS NULL OR journal_scope IS NOT pharmacy_id
     OR CAST(journal_actor AS TEXT) IS NOT actor_id OR journal_date IS NOT payment_date
     OR typeof(journal_total) NOT IN ('real','integer')
     OR abs(journal_total*100-amount_cents)>0.0001
     OR entry_count<>2 OR exact_debit_count<>1 OR exact_credit_count<>1
     THEN 'supplier_payment_receipt_journal_conflict'
   WHEN debit_lines<>1 OR credit_lines<>1
     THEN 'supplier_payment_receipt_account_unverifiable'
   WHEN tagged_cash_count<>CASE WHEN payment_method='cash' THEN 1 ELSE 0 END
     OR (payment_method='cash' AND
       (cash_exists IS NULL OR cash_scope IS NOT pharmacy_id OR cash_actor IS NOT actor_id
       OR shift_scope IS NOT pharmacy_id OR cash_type IS NOT 'disbursement'
       OR cash_category IS NOT 'accounts_payable' OR cash_source IS NOT 'supplier_payment'
       OR cash_target IS NOT id OR typeof(cash_amount) NOT IN ('real','integer')
       OR abs(cash_amount*100-amount_cents)>0.0001))
     THEN 'supplier_payment_receipt_cash_conflict'
   -- The smallest immutable balance_after_cents is the latest of a strictly
   -- decreasing, positive-payment 054 chain. Never judge global supplier
   -- balances if later non-054 ledger, extra invoice or return is present.
   WHEN (SELECT count(*) FROM purchase_invoices pi WHERE pi.supplier_id=checked.supplier_id)=1
     AND NOT EXISTS(SELECT 1 FROM purchase_returns pr WHERE pr.supplier_id=checked.supplier_id)
     AND (SELECT count(*) FROM supplier_transactions st WHERE st.supplier_id=checked.supplier_id)
         =1+(SELECT count(*) FROM native_supplier_payment_receipts other
             WHERE other.supplier_id=checked.supplier_id)
     AND (supplier_exists IS NULL OR typeof(supplier_balance) NOT IN ('real','integer')
       OR abs(supplier_balance*100.0-(SELECT min(other.balance_after_cents)
           FROM native_supplier_payment_receipts other
           WHERE other.supplier_id=checked.supplier_id))>0.0001)
     THEN 'supplier_payment_receipt_balance_conflict'
   ELSE NULL END issue_code FROM checked
)
SELECT CAST(id AS TEXT) record_id,CAST(invoice_id AS TEXT) source_id,
       pharmacy_id source_pharmacy_id,journal_scope journal_pharmacy_id,
       CAST(amount_cents AS REAL)/100.0 source_amount,journal_total journal_amount,
       NULL debit_total,NULL credit_total,issue_code,
       CASE WHEN issue_code='supplier_payment_receipt_account_unverifiable'
            THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY id LIMIT 201
"#;

// Migration 040 has a real adjustment_id PK + UNIQUE nullable journal_id.
// This checks the persisted *structural* claim, not mutable journal text.
// Its immutable sidecar, stock_adjustments and linked journal/entries are
// protected by 040 triggers. Inventory, users and accounts are NOT frozen:
// missing/moved current lot, current user or retyped account MUST NOT be
// characterized as evidence of a fraudulent historical posting.
//
// One finding maximum per 040 row, highest-priority issue first. For a
// well-formed row, issue_code=NULL and the outer query suppresses it; the
// report counts such rows as structurally verified, subject to this defined
// snapshot check. No sale, purchase, COGS or description-prefix guesswork.
const STOCK_PROVENANCE_STRUCTURE: &str = r#"
WITH checks AS (
  SELECT p.adjustment_id,p.inventory_id,p.pharmacy_id,p.actor_id,
         p.old_quantity,p.new_quantity,p.unit_cost_cents,p.valuation_cents,
         p.direction,p.journal_id,p.inventory_account_id,
         p.counterpart_account_id,p.counterpart_type,
         sa.id adjustment_found,sa.inventory_id source_lot,
         CAST(sa.user_id AS TEXT) source_actor,
         sa.old_quantity source_old,sa.new_quantity source_new,
         i.id current_lot,i.pharmacy_id current_lot_scope,
         CAST(u.id AS TEXT) current_actor,u.pharmacy_id current_actor_scope,
         j.id linked_journal,j.pharmacy_id actual_journal_scope,
         CAST(j.created_by AS TEXT) journal_actor,j.total_amount journal_total,
         asset.id asset_found,asset.type asset_type,
         asset.is_group asset_group,
         other.id other_found,other.type other_type,
         other.is_group other_group,
         EXISTS(SELECT 1 FROM main.accounts child
                WHERE child.parent_id=asset.id) asset_children,
         EXISTS(SELECT 1 FROM main.accounts child
                WHERE child.parent_id=other.id) other_children,
         COUNT(e.id) entry_count,
         SUM(CASE WHEN e.type='debit' THEN 1 ELSE 0 END) debit_count,
         SUM(CASE WHEN e.type='credit' THEN 1 ELSE 0 END) credit_count,
         SUM(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END) debit_sum,
         SUM(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END) credit_sum,
         SUM(CASE WHEN e.account_id=p.inventory_account_id
                    AND e.type=CASE WHEN p.direction='increase'
                                    THEN 'debit' ELSE 'credit' END
                  THEN 1 ELSE 0 END) asset_line_count,
         SUM(CASE WHEN e.account_id=p.counterpart_account_id
                    AND e.type=CASE WHEN p.direction='increase'
                                    THEN 'credit' ELSE 'debit' END
                  THEN 1 ELSE 0 END) other_line_count,
         SUM(CASE WHEN e.id IS NOT NULL AND
                    (typeof(e.amount) NOT IN ('integer','real')
                     OR abs(e.amount*100-p.valuation_cents)>0.00001)
                  THEN 1 ELSE 0 END) wrong_amount_count,
         COUNT(*) OVER (PARTITION BY p.journal_id) journal_claims
  FROM main.native_stock_ledger_provenance p
  LEFT JOIN main.stock_adjustments sa ON sa.id=p.adjustment_id
  LEFT JOIN main.inventory i ON i.id=p.inventory_id
  LEFT JOIN main.users u ON CAST(u.id AS TEXT)=p.actor_id
  LEFT JOIN main.daily_journals j ON j.id=p.journal_id
  LEFT JOIN main.journal_entries e ON e.journal_id=p.journal_id
  LEFT JOIN main.accounts asset ON asset.id=p.inventory_account_id
  LEFT JOIN main.accounts other ON other.id=p.counterpart_account_id
  GROUP BY p.adjustment_id
), assessed AS (
  SELECT c.*,
   CASE
    WHEN c.adjustment_found IS NULL THEN 'stock_provenance_source_missing'
    WHEN c.source_lot IS NOT c.inventory_id
      OR c.source_actor IS NOT c.actor_id
      OR typeof(c.source_old) NOT IN ('integer','real')
      OR typeof(c.source_new) NOT IN ('integer','real')
      OR abs(c.source_old-c.old_quantity)>0.000000001
      OR abs(c.source_new-c.new_quantity)>0.000000001
      THEN 'stock_provenance_source_conflict'
    WHEN typeof(c.old_quantity) NOT IN ('integer','real')
      OR typeof(c.new_quantity) NOT IN ('integer','real')
      OR typeof(c.unit_cost_cents)!='integer'
      OR typeof(c.valuation_cents)!='integer'
      OR c.old_quantity NOT BETWEEN 0 AND 1000000000
      OR c.new_quantity NOT BETWEEN 0 AND 1000000000
      OR c.unit_cost_cents NOT BETWEEN 0 AND 100000000000
      OR c.valuation_cents NOT BETWEEN 0 AND 100000000000000
      OR c.old_quantity=c.new_quantity
      OR (c.direction='increase' AND c.new_quantity<=c.old_quantity)
      OR (c.direction='decrease' AND c.new_quantity>=c.old_quantity)
      OR c.direction NOT IN ('increase','decrease')
      OR abs(abs(c.new_quantity-c.old_quantity)*c.unit_cost_cents
                -c.valuation_cents)>0.0001
      OR (c.valuation_cents=0 AND
          (c.journal_id IS NOT NULL OR c.inventory_account_id IS NOT NULL
           OR c.counterpart_account_id IS NOT NULL OR c.counterpart_type IS NOT NULL))
      OR (c.valuation_cents>0 AND
          (c.journal_id IS NULL OR c.inventory_account_id IS NULL
           OR c.counterpart_account_id IS NULL
           OR c.inventory_account_id=c.counterpart_account_id
           OR (c.direction='increase' AND c.counterpart_type IS NOT 'revenue')
           OR (c.direction='decrease' AND c.counterpart_type IS NOT 'expense')))
      THEN 'stock_provenance_snapshot_invalid'
    WHEN c.journal_id IS NOT NULL AND c.journal_claims>1
      THEN 'stock_provenance_duplicate_journal_claim'
    WHEN c.journal_id IS NOT NULL AND c.linked_journal IS NULL
      THEN 'stock_provenance_journal_missing'
    WHEN c.journal_id IS NOT NULL AND
      NOT (c.journal_id GLOB 'native-lot-adjust-*'
           OR (c.direction='decrease' AND c.journal_id GLOB 'native-lot-zero-*'))
      THEN 'stock_provenance_journal_identity_invalid'
    WHEN c.journal_id IS NOT NULL AND
      (c.actual_journal_scope IS NOT c.pharmacy_id
       OR c.journal_actor IS NOT c.actor_id)
      THEN 'stock_provenance_journal_tenant_actor_conflict'
    WHEN c.journal_id IS NOT NULL AND
      (typeof(c.journal_total) NOT IN ('integer','real')
       OR abs(c.journal_total*100-c.valuation_cents)>0.00001)
      THEN 'stock_provenance_journal_amount_conflict'
    WHEN c.journal_id IS NOT NULL AND
      (c.entry_count!=2 OR c.debit_count!=1 OR c.credit_count!=1
       OR c.asset_line_count!=1 OR c.other_line_count!=1
       OR c.wrong_amount_count!=0
       OR abs(c.debit_sum-c.credit_sum)>0.00001)
      THEN 'stock_provenance_journal_lines_conflict'
    WHEN c.current_lot IS NULL THEN 'stock_provenance_current_lot_missing'
    WHEN TRIM(COALESCE(c.current_lot_scope,''))=''
      THEN 'stock_provenance_current_lot_scope_unknown'
    WHEN c.current_lot_scope<>c.pharmacy_id
      THEN 'stock_provenance_current_lot_scope_changed'
    WHEN c.current_actor IS NULL THEN 'stock_provenance_current_actor_missing'
    WHEN TRIM(COALESCE(c.current_actor_scope,''))=''
      THEN 'stock_provenance_current_actor_scope_unknown'
    WHEN c.current_actor_scope<>c.pharmacy_id
      THEN 'stock_provenance_current_actor_scope_changed'
    WHEN c.journal_id IS NOT NULL AND
      (c.asset_found IS NULL OR c.other_found IS NULL
       OR LOWER(TRIM(COALESCE(c.asset_type,'')))!='asset'
       OR LOWER(TRIM(COALESCE(c.other_type,'')))!=c.counterpart_type
       OR COALESCE(c.asset_group,1)!=0 OR COALESCE(c.other_group,1)!=0
       OR c.asset_children!=0 OR c.other_children!=0)
      THEN 'stock_provenance_current_account_unverifiable'
    ELSE NULL END issue_code
  FROM checks c
)
SELECT CAST(adjustment_id AS TEXT) record_id,CAST(inventory_id AS TEXT) source_id,
       current_lot_scope source_pharmacy_id,
       CASE WHEN journal_id IS NOT NULL THEN actual_journal_scope
            ELSE pharmacy_id END journal_pharmacy_id,
       CAST(valuation_cents AS REAL)/100.0 source_amount,
       CASE WHEN typeof(journal_total) IN ('real','integer')
            THEN CAST(journal_total AS REAL) ELSE NULL END journal_amount,
       CASE WHEN journal_id IS NOT NULL THEN CAST(debit_sum AS REAL)
            ELSE NULL END debit_total,
       CASE WHEN journal_id IS NOT NULL THEN CAST(credit_sum AS REAL)
            ELSE NULL END credit_total,
       issue_code,
       CASE WHEN issue_code IN (
          'stock_provenance_current_lot_missing',
          'stock_provenance_current_lot_scope_unknown',
          'stock_provenance_current_lot_scope_changed',
          'stock_provenance_current_actor_missing',
          'stock_provenance_current_actor_scope_unknown',
          'stock_provenance_current_actor_scope_changed',
          'stock_provenance_current_account_unverifiable')
         THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL
ORDER BY adjustment_id LIMIT 201
"#;

// These rows have NO 040 structural evidence. They may be legitimate legacy
// entries predating migration 040, so absence cannot prove skipped posting.
const UNATTRIBUTED_STOCK_ADJUSTMENTS: &str = r#"
SELECT COUNT(*) FROM main.stock_adjustments sa
WHERE NOT EXISTS(SELECT 1 FROM main.native_stock_ledger_provenance p
                 WHERE p.adjustment_id=sa.id)
"#;

// Migration 042 events retain a historical purchase's journal and source-line
// JSON *even when a legitimate later edit removes/recreates invoice rows*.
// Only immutable journal/header/entries and receipt arithmetic are structural.
// Current invoice/actor are mutable and cannot authenticate historical scope.
const PURCHASE_EVENT_STRUCTURE: &str = r#"
WITH summary AS (
 SELECT p.event_id,p.invoice_id,p.pharmacy_id,p.actor_id,p.event_kind,
        p.journal_id,p.signed_cents,p.old_total_cents,p.new_total_cents,
        p.line_snapshot,
        j.id journal_present,j.pharmacy_id actual_scope,
        CAST(j.created_by AS TEXT) journal_actor,j.total_amount journal_amount,
        i.id current_invoice,i.pharmacy_id current_invoice_scope,
        CAST(u.id AS TEXT) current_actor,u.pharmacy_id current_actor_scope,
        count(e.id) entry_count,
        sum(CASE WHEN e.type='debit' THEN 1 ELSE 0 END) debits,
        sum(CASE WHEN e.type='credit' THEN 1 ELSE 0 END) credits,
        sum(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END) debit_sum,
        sum(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END) credit_sum,
        sum(CASE WHEN e.id IS NOT NULL AND
                 (typeof(e.amount) NOT IN ('real','integer')
                  OR abs(e.amount*100-abs(p.signed_cents))>0.0001)
                 THEN 1 ELSE 0 END) wrong_amount_lines
 FROM main.native_purchase_posting_events p
 LEFT JOIN main.daily_journals j ON j.id=p.journal_id
 LEFT JOIN main.journal_entries e ON e.journal_id=p.journal_id
 LEFT JOIN main.purchase_invoices i ON i.id=p.invoice_id
 LEFT JOIN main.users u ON CAST(u.id AS TEXT)=p.actor_id
 GROUP BY p.event_id
), assessed AS (
 SELECT s.*,CASE
   WHEN typeof(s.signed_cents)!='integer' OR s.signed_cents=0
     OR s.event_kind NOT IN ('initial','edit_delta','reverse')
     OR NOT (json_valid(s.line_snapshot))
     OR CASE WHEN json_valid(s.line_snapshot) THEN json_type(s.line_snapshot)!='array'
                  OR json_array_length(s.line_snapshot) NOT BETWEEN 1 AND 200
             ELSE 1 END
     OR (s.event_kind='initial' AND
          (s.old_total_cents!=0 OR s.signed_cents!=s.new_total_cents))
     OR (s.event_kind='edit_delta' AND
          s.signed_cents!=s.new_total_cents-s.old_total_cents)
     OR (s.event_kind='reverse' AND
          (s.new_total_cents!=0 OR s.signed_cents!=-s.old_total_cents))
   THEN 'purchase_event_snapshot_invalid'
   WHEN s.journal_present IS NULL THEN 'purchase_event_journal_missing'
   WHEN s.actual_scope IS NOT s.pharmacy_id OR s.journal_actor IS NOT s.actor_id
     THEN 'purchase_event_journal_scope_conflict'
   WHEN typeof(s.journal_amount) NOT IN ('integer','real')
       OR abs(s.journal_amount*100-abs(s.signed_cents))>0.0001
     THEN 'purchase_event_journal_amount_conflict'
   WHEN s.entry_count!=2 OR s.debits!=1 OR s.credits!=1
       OR s.wrong_amount_lines!=0 OR abs(s.debit_sum-s.credit_sum)>0.00001
     THEN 'purchase_event_journal_lines_conflict'
   WHEN s.current_invoice IS NULL OR s.current_invoice_scope IS NOT s.pharmacy_id
     THEN 'purchase_event_current_invoice_unverifiable'
   WHEN s.current_actor IS NULL OR s.current_actor_scope IS NOT s.pharmacy_id
     THEN 'purchase_event_current_actor_scope_changed'
   ELSE NULL END issue_code
 FROM summary s
)
SELECT CAST(event_id AS TEXT) record_id,CAST(invoice_id AS TEXT) source_id,
       pharmacy_id source_pharmacy_id,actual_scope journal_pharmacy_id,
       CAST(signed_cents AS REAL)/100.0 source_amount,
       CAST(journal_amount AS REAL) journal_amount,
       CAST(debit_sum AS REAL) debit_total,
       CAST(credit_sum AS REAL) credit_total,issue_code,
       CASE WHEN issue_code IN ('purchase_event_current_invoice_unverifiable',
             'purchase_event_current_actor_scope_changed')
              THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY event_id LIMIT 201
"#;

// 044: creation receipt can outlive a deleted/edited invoice. A mutable
// current source never disproves a historical request. The completed request
// can, however, be cross-checked against a fixed original 042 journal event.
const PURCHASE_CREATION_STRUCTURE: &str = r#"
WITH base AS (
 SELECT r.*,p.id current_invoice,p.pharmacy_id current_source_scope,
        u.id current_actor,u.pharmacy_id current_actor_scope,
        e.journal_id event_journal,e.pharmacy_id event_scope,
        e.actor_id event_actor,e.new_total_cents event_amount,
        j.id journal_exists,j.pharmacy_id journal_scope
 FROM native_purchase_create_requests r
 LEFT JOIN purchase_invoices p ON p.id=r.invoice_id
 LEFT JOIN users u ON CAST(u.id AS TEXT)=r.actor_id
 LEFT JOIN native_purchase_posting_events e
   ON e.journal_id=r.initial_journal_id AND e.event_kind='initial'
 LEFT JOIN daily_journals j ON j.id=r.initial_journal_id
), assessed AS (
 SELECT b.*,CASE
  WHEN length(b.request_id)!=36
    OR substr(b.request_id,15,1)!='4'
    OR substr(b.request_id,20,1) NOT IN ('8','9','a','b')
    OR b.request_id!=lower(b.request_id)
    OR b.source_status NOT IN ('draft','completed')
    OR typeof(b.source_total_cents)!='integer'
    OR b.source_total_cents<0 OR b.source_total_cents>100000000000000
    OR b.source_line_count NOT BETWEEN 0 AND 200
    OR (b.source_status='draft' AND
       (b.source_total_cents!=0 OR b.initial_journal_id IS NOT NULL))
    OR (b.source_status='completed' AND
       (b.source_total_cents<=0 OR b.initial_journal_id IS NULL))
    THEN 'purchase_creation_receipt_snapshot_invalid'
  WHEN b.source_status='completed' AND
    (b.event_journal IS NULL OR b.journal_exists IS NULL
     OR b.event_scope IS NOT b.pharmacy_id
     OR b.event_actor IS NOT b.actor_id
     OR b.event_amount IS NOT b.source_total_cents
     OR b.journal_scope IS NOT b.pharmacy_id)
    THEN 'purchase_creation_receipt_original_journal_conflict'
  WHEN b.current_invoice IS NULL OR b.current_source_scope IS NOT b.pharmacy_id
    OR b.current_actor IS NULL OR b.current_actor_scope IS NOT b.pharmacy_id
    THEN 'purchase_creation_receipt_current_source_unverifiable'
  ELSE NULL END issue_code FROM base b
)
SELECT CAST(request_id AS TEXT) record_id,CAST(invoice_id AS TEXT) source_id,
       current_source_scope source_pharmacy_id,journal_scope journal_pharmacy_id,
       CAST(source_total_cents AS REAL)/100.0 source_amount,
       NULL journal_amount,NULL debit_total,NULL credit_total,
       issue_code,
       CASE WHEN issue_code='purchase_creation_receipt_current_source_unverifiable'
         THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY request_id LIMIT 201
"#;

// 047: a prospective native draft has both an original typed-request digest
// and a persisted source-content digest sealed atomically with 044. SQL can
// check structural linkage, never recertify the *historical* original request
// from a mutable present-day invoice or claim a database hash is a signature.
const PURCHASE_DRAFT_WITNESS_STRUCTURE: &str = r#"
WITH assessed AS (
 SELECT w.*,p.id current_invoice,p.pharmacy_id current_scope,
        p.status current_status,CAST(p.user_id AS TEXT) current_user,
        CASE
         WHEN length(w.original_request_sha256)!=64
           OR w.original_request_sha256 GLOB '*[^0-9a-f]*'
           OR length(w.original_source_sha256)!=64
           OR w.original_source_sha256 GLOB '*[^0-9a-f]*'
           OR NOT EXISTS(
             SELECT 1 FROM native_purchase_create_requests r
             WHERE r.request_id=w.request_id AND r.invoice_id=w.invoice_id
               AND r.actor_id=w.actor_id AND r.pharmacy_id=w.pharmacy_id
               AND r.source_status='draft' AND r.source_total_cents=0
               AND r.initial_journal_id IS NULL
           ) THEN 'purchase_draft_original_witness_conflict'
         WHEN p.id IS NULL OR p.pharmacy_id IS NOT w.pharmacy_id
           OR CAST(p.user_id AS TEXT) IS NOT w.actor_id OR p.status!='draft'
           THEN 'purchase_draft_current_source_unverifiable'
         ELSE NULL END issue_code
 FROM native_purchase_draft_create_witnesses w
 LEFT JOIN purchase_invoices p ON p.id=w.invoice_id
)
SELECT CAST(request_id AS TEXT) record_id,CAST(invoice_id AS TEXT) source_id,
       current_scope source_pharmacy_id,NULL journal_pharmacy_id,
       NULL source_amount,NULL journal_amount,NULL debit_total,NULL credit_total,
       issue_code,
       CASE WHEN issue_code='purchase_draft_current_source_unverifiable'
         THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY request_id LIMIT 201
"#;

// 046: a zero monetary delta has no synthetic journal. Its immutable old/new
// stock snapshot is checked structurally; changing current lots or invoice
// lines cannot be assumed to undo the witnessed historical operation.
const PURCHASE_ZERO_DELTA_STRUCTURE: &str = r#"
WITH base AS (
 SELECT r.*,p.id current_invoice,p.pharmacy_id current_invoice_scope,
        u.id current_actor,u.pharmacy_id current_actor_scope,
        e.journal_id original_event_journal,e.pharmacy_id event_scope,
        j.id original_journal,j.pharmacy_id original_journal_scope
 FROM native_purchase_zero_delta_stock_events r
 LEFT JOIN purchase_invoices p ON p.id=r.invoice_id
 LEFT JOIN users u ON CAST(u.id AS TEXT)=r.actor_id
 LEFT JOIN native_purchase_posting_events e
   ON e.journal_id=r.original_journal_id AND e.invoice_id=r.invoice_id
   AND e.event_kind='initial'
 LEFT JOIN daily_journals j ON j.id=r.original_journal_id
), assessed AS (
 SELECT b.*,CASE
   WHEN typeof(b.total_cents)!='integer' OR b.total_cents<=0
     OR b.total_cents>100000000000000
     OR b.line_count NOT BETWEEN 1 AND 200
     OR NOT json_valid(b.line_snapshot)
     OR CASE WHEN json_valid(b.line_snapshot) THEN
         json_type(b.line_snapshot)!='array'
         OR json_array_length(b.line_snapshot)!=b.line_count
       ELSE 1 END
     OR CASE WHEN json_valid(b.line_snapshot)
                   AND json_type(b.line_snapshot)='array' THEN
       NOT EXISTS(SELECT 1 FROM json_each(b.line_snapshot) v
         WHERE typeof(json_extract(v.value,'$.oldReceived')) IN ('integer','real')
           AND typeof(json_extract(v.value,'$.newReceived')) IN ('integer','real')
           AND ABS(json_extract(v.value,'$.newReceived')
                   -json_extract(v.value,'$.oldReceived'))>0.000001)
       ELSE 1 END
     THEN 'purchase_zero_delta_receipt_snapshot_invalid'
   WHEN b.original_journal_id IS NOT NULL AND
     (b.original_event_journal IS NULL OR b.original_journal IS NULL
      OR b.event_scope IS NOT b.pharmacy_id
      OR b.original_journal_scope IS NOT b.pharmacy_id)
     THEN 'purchase_zero_delta_receipt_original_journal_conflict'
   WHEN b.original_journal_id IS NULL
     THEN 'purchase_zero_delta_receipt_historical_link_unverifiable'
   WHEN b.current_invoice IS NULL OR b.current_invoice_scope IS NOT b.pharmacy_id
     OR b.current_actor IS NULL OR b.current_actor_scope IS NOT b.pharmacy_id
     THEN 'purchase_zero_delta_receipt_current_source_unverifiable'
   ELSE NULL END issue_code FROM base b
)
SELECT CAST(event_id AS TEXT) record_id,CAST(invoice_id AS TEXT) source_id,
       current_invoice_scope source_pharmacy_id,original_journal_scope journal_pharmacy_id,
       CAST(total_cents AS REAL)/100.0 source_amount,
       NULL journal_amount,NULL debit_total,NULL credit_total,
       issue_code,
       CASE WHEN issue_code IN ('purchase_zero_delta_receipt_historical_link_unverifiable',
                               'purchase_zero_delta_receipt_current_source_unverifiable')
         THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY event_id LIMIT 201
"#;

// Start from the old source, not from receipts: the 043 structural report
// cannot list patient credit debt that never received a native 043 witness.
// Even a non-NULL pharmacy may have been inferred by startup compatibility.
// An unreceipted historical source is unverifiable, never evidence of fraud.
const LEGACY_PATIENT_CREDIT_SOURCES: &str = r#"
SELECT CAST(s.id AS TEXT) record_id,CAST(s.patient_id AS TEXT) source_id,
       s.pharmacy_id source_pharmacy_id,CAST(NULL AS TEXT) journal_pharmacy_id,
       CASE WHEN typeof(s.total_amount) IN ('real','integer')
            THEN s.total_amount ELSE NULL END source_amount,
       CAST(NULL AS REAL) journal_amount,CAST(NULL AS REAL) debit_total,
       CAST(NULL AS REAL) credit_total,
       'legacy_patient_credit_unreceipted' issue_code,
       'unverifiable_history' classification
FROM main.sales_invoices s
WHERE s.patient_id IS NOT NULL AND s.payment_method='credit'
  AND (s.status IS NULL OR s.status=''
       OR LOWER(s.status) IN ('completed','approved','delivered'))
  AND NOT EXISTS(SELECT 1 FROM main.native_sale_cogs_provenance p
                 WHERE p.sale_id=s.id AND p.payment_method='credit')
ORDER BY s.id COLLATE BINARY LIMIT 201
"#;

// The native patient cash writer always records an explicit pharmacy_id.
// A NULL/blank current movement with its reserved source_type cannot be
// assigned to local_default from the present-day patient, shift or actor.
// There is no V1 payment-to-cash UUID FK: report uncertain custody, not fraud.
const NATIVE_PATIENT_CASH_UNKNOWN_TENANT: &str = r#"
SELECT CAST(cm.id AS TEXT) record_id,CAST(cm.target_name AS TEXT) source_id,
       NULLIF(TRIM(cm.pharmacy_id),'') source_pharmacy_id,
       CAST(NULL AS TEXT) journal_pharmacy_id,
       CASE WHEN typeof(cm.amount) IN ('real','integer')
         THEN CAST(cm.amount AS REAL) ELSE NULL END source_amount,
       CAST(NULL AS REAL) journal_amount,CAST(NULL AS REAL) debit_total,
       CAST(NULL AS REAL) credit_total,
       'native_patient_cash_tenant_unknown' issue_code,
       'unverifiable_history' classification
FROM main.cash_movements cm
WHERE cm.source_type='patient_payment'
  AND (cm.pharmacy_id IS NULL OR TRIM(cm.pharmacy_id)='')
ORDER BY CAST(cm.id AS TEXT) COLLATE BINARY LIMIT 201
"#;

// Historical 033 and 036 records have no journal UUID. Do not match old
// random UUID journals by actor, date, text, amount or insertion order.
const LEGACY_PATIENT_MONEY_JOURNAL_LINKS: &str = r#"
SELECT CAST('bank:'||t.id AS TEXT) record_id,CAST(t.patient_id AS TEXT) source_id,
       sc.pharmacy_id source_pharmacy_id,NULL journal_pharmacy_id,
       CASE WHEN typeof(t.amount) IN ('integer','real') THEN CAST(t.amount AS REAL) ELSE NULL END source_amount,
       CAST(NULL AS REAL) journal_amount,CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       'legacy_bank_patient_journal_unlinked' issue_code,'unverifiable_history' classification
FROM main.patient_payment_scope sc JOIN main.patient_transactions t ON t.id=sc.transaction_id
WHERE t.type='payment' AND t.payment_method='bank'
  AND NOT EXISTS(SELECT 1 FROM main.native_patient_financial_journal_receipts r
                 WHERE r.source_kind='payment' AND r.source_id=t.id)
UNION ALL
SELECT CAST('cash:'||t.id AS TEXT),CAST(t.patient_id AS TEXT),sc.pharmacy_id,NULL,
       CASE WHEN typeof(t.amount) IN ('integer','real') THEN CAST(t.amount AS REAL) ELSE NULL END,
       CAST(NULL AS REAL),CAST(NULL AS REAL),CAST(NULL AS REAL),
       'legacy_cash_patient_movement_unlinked','unverifiable_history'
FROM main.patient_payment_scope sc JOIN main.patient_transactions t ON t.id=sc.transaction_id
WHERE t.type='payment' AND t.payment_method='cash'
  AND NOT EXISTS(SELECT 1 FROM main.native_patient_financial_journal_receipts r
                 WHERE r.source_kind='payment' AND r.source_id=t.id)
UNION ALL
SELECT CAST('notice:'||n.id AS TEXT),CAST(n.target_id AS TEXT),sc.pharmacy_id,NULL,
       CASE WHEN typeof(n.amount) IN ('integer','real') THEN CAST(n.amount AS REAL) ELSE NULL END,
       CAST(NULL AS REAL),CAST(NULL AS REAL),CAST(NULL AS REAL),
       'legacy_notice_journal_unlinked','unverifiable_history'
FROM main.financial_notice_native_scope sc JOIN main.financial_notices n ON n.id=sc.notice_id
WHERE NOT EXISTS(SELECT 1 FROM main.native_patient_financial_journal_receipts r
                 WHERE r.source_kind='notice' AND r.source_id=n.id)
ORDER BY record_id COLLATE BINARY LIMIT 201
"#;

// Structural source-to-journal witness for NEW 051 postings. A current
// account code may have been reclassified later: report such historical
// classification changes as unverifiable, not as original monetary fraud.
pub(super) const NATIVE_PATIENT_FINANCIAL_JOURNAL_STRUCTURE: &str = r#"
WITH matched AS (
 SELECT r.*,t.id transaction_exists,t.patient_id patient_id,t.user_id transaction_actor,
        t.date transaction_date,t.type transaction_type,t.amount transaction_amount,
        t.payment_method transaction_method,ps.pharmacy_id payment_scope,
        n.id notice_exists,n.target_id notice_target,n.target_type notice_target_type,
        n.user_id notice_actor,n.date notice_date,n.type notice_type,
        n.amount notice_amount,n.pharmacy_id notice_pharmacy,
        ns.pharmacy_id notice_scope,
        ns.patient_transaction_id mirror_source_id,
        ptm.id mirror_exists,ptm.patient_id mirror_patient,
        ptm.user_id mirror_actor,ptm.date mirror_date,
        ptm.type mirror_type,ptm.amount mirror_amount,
        j.id actual_journal,j.date journal_date,j.created_by journal_actor,
        j.pharmacy_id journal_scope,j.total_amount journal_total
 FROM native_patient_financial_journal_receipts r
 LEFT JOIN patient_transactions t ON r.source_kind='payment' AND t.id=r.source_id
 LEFT JOIN patient_payment_scope ps ON ps.transaction_id=t.id
 LEFT JOIN financial_notices n ON r.source_kind='notice' AND n.id=r.source_id
 LEFT JOIN financial_notice_native_scope ns ON ns.notice_id=n.id
 LEFT JOIN patient_transactions ptm ON r.source_kind='notice'
     AND ptm.id=ns.patient_transaction_id
 LEFT JOIN daily_journals j ON j.id=r.journal_id
), assessed AS (
 SELECT m.*,CASE
  WHEN m.source_kind='payment' AND
    (m.transaction_exists IS NULL OR m.transaction_type IS NOT 'payment'
     OR m.transaction_actor IS NOT m.actor_id OR m.payment_scope IS NOT m.pharmacy_id
     OR m.transaction_method IS NOT m.money_kind
     OR typeof(m.transaction_amount) NOT IN ('real','integer')
     OR ABS(m.transaction_amount*100-m.amount_cents)>0.00001)
    OR m.source_kind='notice' AND
    (m.notice_exists IS NULL OR m.notice_target_type NOT IN ('customer','pharmacy')
     OR m.notice_actor IS NOT m.actor_id OR m.notice_scope IS NOT m.pharmacy_id
     OR m.notice_pharmacy IS NOT m.pharmacy_id OR m.notice_type IS NOT m.money_kind
     OR typeof(m.notice_amount) NOT IN ('real','integer')
     OR ABS(m.notice_amount*100-m.amount_cents)>0.00001
     OR (m.notice_target_type='customer' AND
       (m.mirror_exists IS NULL OR m.mirror_patient IS NOT m.notice_target
        OR m.mirror_actor IS NOT m.notice_actor OR m.mirror_date IS NOT m.notice_date
        OR m.mirror_type IS NOT 'adjustment'
        OR typeof(m.mirror_amount) NOT IN ('real','integer')
        OR ABS(m.mirror_amount*100-CASE WHEN m.notice_type='credit'
                   THEN -m.amount_cents ELSE m.amount_cents END)>0.00001))
     OR (m.notice_target_type='pharmacy' AND m.mirror_source_id IS NOT NULL))
    THEN 'native_patient_receipt_source_conflict'
  WHEN m.source_kind='payment' AND m.money_kind='cash'
    AND m.cash_movement_id IS NULL
    THEN 'native_patient_cash_witness_unverifiable'
  WHEN (m.cash_movement_id IS NOT NULL
         AND (m.source_kind!='payment' OR m.money_kind!='cash'))
    OR (m.source_kind='payment' AND m.money_kind='cash'
      AND (SELECT COUNT(*) FROM native_patient_financial_journal_receipts r2
           WHERE r2.cash_movement_id=m.cash_movement_id)<>1)
    OR (m.source_kind='payment' AND m.money_kind='cash' AND NOT EXISTS(
      SELECT 1 FROM cash_movements cm JOIN shifts sh
        ON CAST(sh.id AS TEXT)=CAST(cm.shift_id AS TEXT)
      WHERE cm.id=m.cash_movement_id AND cm.source_type='patient_payment'
        AND cm.target_name=m.patient_id AND cm.type='receipt'
        AND cm.category='accounts_receivable' AND cm.pharmacy_id=m.pharmacy_id
        AND sh.pharmacy_id=m.pharmacy_id AND CAST(cm.user_id AS TEXT)=m.actor_id
        AND cm.date=m.transaction_date AND typeof(cm.amount) IN ('real','integer')
        AND ABS(cm.amount*100.0-m.amount_cents)<0.00001))
    THEN 'native_patient_cash_witness_conflict'
  WHEN m.actual_journal IS NULL OR m.journal_scope IS NOT m.pharmacy_id
    OR CAST(m.journal_actor AS TEXT) IS NOT m.actor_id
    OR m.journal_date IS NOT CASE WHEN m.source_kind='payment' THEN m.transaction_date ELSE m.notice_date END
    OR typeof(m.journal_total) NOT IN ('real','integer')
    OR ABS(m.journal_total*100-m.amount_cents)>0.00001
    OR (SELECT COUNT(*) FROM journal_entries e WHERE e.journal_id=m.journal_id)!=2
    OR EXISTS(SELECT 1 FROM journal_entries e WHERE e.journal_id=m.journal_id
              AND (e.type NOT IN ('debit','credit') OR typeof(e.amount) NOT IN ('real','integer')
                   OR ABS(e.amount*100-m.amount_cents)>0.00001))
    OR (SELECT COUNT(*) FROM journal_entries e WHERE e.journal_id=m.journal_id AND e.type='debit')!=1
    OR (SELECT COUNT(*) FROM journal_entries e WHERE e.journal_id=m.journal_id AND e.type='credit')!=1
    THEN 'native_patient_receipt_journal_conflict'
  WHEN NOT EXISTS(SELECT 1 FROM journal_entries e JOIN accounts a ON a.id=e.account_id
     WHERE e.journal_id=m.journal_id AND e.type='debit' AND COALESCE(a.is_group,0)=0
       AND a.code=CASE
         WHEN m.source_kind='payment' AND m.money_kind='cash' THEN '1.1.1'
         WHEN m.source_kind='payment' THEN '1.1.4'
         WHEN m.money_kind='credit' THEN '4.2'
         WHEN m.notice_target_type='customer' THEN '1.1.2' ELSE '1.1.1' END)
     OR NOT EXISTS(SELECT 1 FROM journal_entries e JOIN accounts a ON a.id=e.account_id
     WHERE e.journal_id=m.journal_id AND e.type='credit' AND COALESCE(a.is_group,0)=0
       AND a.code=CASE
         WHEN m.source_kind='payment' THEN '1.1.2'
         WHEN m.money_kind='debit' THEN '4.2'
         WHEN m.notice_target_type='customer' THEN '1.1.2' ELSE '1.1.1' END)
    THEN 'native_patient_receipt_account_unverifiable'
  ELSE NULL END issue_code
 FROM matched m
)
SELECT CAST(source_id AS TEXT) record_id,
       CAST(CASE WHEN source_kind='payment' THEN patient_id ELSE notice_target END AS TEXT) source_id,
       pharmacy_id source_pharmacy_id,journal_scope journal_pharmacy_id,
       CAST(amount_cents AS REAL)/100.0 source_amount,
       journal_total journal_amount,CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       issue_code,CASE WHEN issue_code IN ('native_patient_receipt_account_unverifiable',
                                         'native_patient_cash_witness_unverifiable')
         THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY source_id COLLATE BINARY LIMIT 201
"#;

// 056: only new pharmacy notices carry an exact, append-only source -> cash
// UUID. Earlier 051 source -> journal receipts are intentionally not joined
// to old shift cash by a coincidental amount/date; report them as unknown.
pub(super) const NATIVE_NOTICE_CASH_WITNESS: &str = r#"
WITH inspected AS (
 SELECT r.source_id,r.pharmacy_id,r.actor_id,r.journal_id,r.amount_cents,
        n.id notice_exists,n.target_type,n.target_id,n.type notice_type,
        n.user_id notice_actor,n.pharmacy_id notice_pharmacy,n.date notice_date,
        w.notice_id witness_exists,w.journal_id witness_journal,
        w.cash_movement_id,w.shift_id witness_shift,w.pharmacy_id witness_pharmacy,
        w.actor_id witness_actor,w.amount_cents witness_cents,
        cm.id cash_exists,cm.shift_id cash_shift,cm.pharmacy_id cash_pharmacy,
        cm.user_id cash_actor,cm.source_type cash_source,cm.target_name cash_target,
        cm.type cash_type,cm.category cash_category,cm.amount cash_amount,cm.date cash_date,
        sh.id shift_exists,sh.pharmacy_id shift_pharmacy,
        (SELECT count(*) FROM cash_movements other
         WHERE other.source_type='financial_notice' AND other.target_name=r.source_id) cash_claims
 FROM native_patient_financial_journal_receipts r
 JOIN financial_notices n ON n.id=r.source_id
 LEFT JOIN native_financial_notice_cash_witnesses w ON w.notice_id=r.source_id
 LEFT JOIN cash_movements cm ON cm.id=w.cash_movement_id
 LEFT JOIN shifts sh ON sh.id=cm.shift_id
 WHERE r.source_kind='notice' AND n.target_type='pharmacy'
), assessed AS (
 SELECT *,CASE
   WHEN witness_exists IS NULL THEN 'native_notice_cash_witness_unverifiable'
   WHEN witness_journal IS NOT journal_id OR witness_pharmacy IS NOT pharmacy_id
     OR witness_actor IS NOT actor_id OR witness_cents IS NOT amount_cents
     OR notice_exists IS NULL OR notice_pharmacy IS NOT pharmacy_id
     OR CAST(notice_actor AS TEXT) IS NOT actor_id
     OR notice_type NOT IN ('debit','credit') OR target_id IS NOT NULL
     OR cash_exists IS NULL OR cash_claims<>1 OR length(cash_movement_id)<>36
     OR cash_shift IS NOT witness_shift OR shift_exists IS NULL
     OR shift_pharmacy IS NOT pharmacy_id OR cash_pharmacy IS NOT pharmacy_id
     OR CAST(cash_actor AS TEXT) IS NOT actor_id
     OR cash_source IS NOT 'financial_notice' OR cash_target IS NOT source_id
     OR cash_category IS NOT 'financial_notice'
     OR cash_type IS NOT CASE notice_type WHEN 'debit' THEN 'receipt' ELSE 'disbursement' END
     OR cash_date IS NOT notice_date OR typeof(cash_amount) NOT IN ('real','integer')
     OR abs(cash_amount*100.0-amount_cents)>0.00001
     THEN 'native_notice_cash_witness_conflict'
   ELSE NULL END issue_code FROM inspected
)
SELECT CAST(source_id AS TEXT) record_id,CAST(source_id AS TEXT) source_id,
       pharmacy_id source_pharmacy_id,CAST(NULL AS TEXT) journal_pharmacy_id,
       CAST(amount_cents AS REAL)/100.0 source_amount,
       CAST(NULL AS REAL) journal_amount,CAST(NULL AS REAL) debit_total,
       CAST(NULL AS REAL) credit_total,issue_code,
       CASE WHEN issue_code='native_notice_cash_witness_unverifiable'
         THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY source_id COLLATE BINARY LIMIT 201
"#;

// 043 new native sale/COGS posting. A receipted sale header, immutable source
// items and journal entries are protected; account classifications and users
// are still mutable current state and are not historical issuer signatures.
const SALE_COGS_STRUCTURE: &str = r#"
WITH base AS (
 SELECT p.*,s.id stored_sale,s.pharmacy_id source_scope,s.user_id source_actor,
        s.total_amount source_total,s.payment_method source_payment,s.status source_status,
        (SELECT count(*) FROM sales_items si WHERE si.invoice_id=p.sale_id) source_lines,
        j.id stored_journal,j.pharmacy_id journal_scope,j.created_by journal_actor,
        j.total_amount journal_total,
        u.id current_actor,u.pharmacy_id current_actor_scope,
        count(e.journal_id) entry_count,
        sum(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END) debits,
        sum(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END) credits,
        sum(CASE WHEN a.code='1.1.2' AND a.type='asset' AND e.type='debit'
                 AND abs(e.amount*1000000-p.sale_micros)<2 THEN 1 ELSE 0 END) receivable_lines,
        sum(CASE WHEN a.code='3.1' AND e.type='credit'
                 AND abs(e.amount*1000000-p.sale_micros)<2 THEN 1 ELSE 0 END) revenue_lines,
        sum(CASE WHEN a.code='4.1' AND e.type='debit'
                 AND abs(e.amount*1000000-p.cogs_micros)<2 THEN 1 ELSE 0 END) expense_lines,
        sum(CASE WHEN a.code='1.1.3' AND e.type='credit'
                 AND abs(e.amount*1000000-p.cogs_micros)<2 THEN 1 ELSE 0 END) stock_lines
 FROM native_sale_cogs_provenance p
 LEFT JOIN sales_invoices s ON s.id=p.sale_id
 LEFT JOIN daily_journals j ON j.id=p.journal_id
 LEFT JOIN journal_entries e ON e.journal_id=p.journal_id
 LEFT JOIN accounts a ON a.id=e.account_id
 LEFT JOIN users u ON CAST(u.id AS TEXT)=p.actor_id
 GROUP BY p.sale_id
), assessed AS (
 SELECT b.*,CASE
  WHEN b.stored_sale IS NULL OR b.source_scope IS NOT b.pharmacy_id
       OR CAST(b.source_actor AS TEXT) IS NOT b.actor_id
       OR b.source_payment IS NOT b.payment_method
       OR NOT (
         b.source_status='completed'
         OR (b.source_status='delivered' AND b.payment_method='delivery'
           AND EXISTS(SELECT 1 FROM native_delivery_collection_receipts dc
             WHERE dc.sale_id=b.sale_id AND dc.pharmacy_id=b.pharmacy_id
               AND dc.sale_cents*10000=b.sale_micros))
       )
       OR typeof(b.source_total) NOT IN ('integer','real')
       OR abs(b.source_total*1000000-b.sale_micros)>2
       THEN 'sale_receipt_source_missing_or_changed'
  WHEN b.source_lines!=b.line_count OR b.line_count NOT BETWEEN 1 AND 200
       OR NOT json_valid(b.line_snapshot)
       OR CASE WHEN json_valid(b.line_snapshot)
            THEN json_type(b.line_snapshot)!='array'
              OR json_array_length(b.line_snapshot)!=b.line_count
          ELSE 1 END THEN 'sale_receipt_lines_changed'
  WHEN b.stored_journal IS NULL THEN 'sale_receipt_journal_missing'
  WHEN b.journal_scope IS NOT b.pharmacy_id
       OR CAST(b.journal_actor AS TEXT) IS NOT b.actor_id
       THEN 'sale_receipt_journal_scope_conflict'
  WHEN typeof(b.journal_total) NOT IN ('integer','real')
       OR abs(b.journal_total*1000000-(b.sale_micros+b.cogs_micros))>2
       OR b.entry_count!=(CASE WHEN b.cogs_micros>0 THEN 4 ELSE 2 END)
       OR abs(b.debits-b.credits)>0.000001
       OR b.revenue_lines!=1
       OR b.expense_lines!=(CASE WHEN b.cogs_micros>0 THEN 1 ELSE 0 END)
       OR b.stock_lines!=(CASE WHEN b.cogs_micros>0 THEN 1 ELSE 0 END)
       THEN 'sale_receipt_amount_unbalanced'
  WHEN b.payment_method='delivery' AND b.sale_micros>0 AND b.receivable_lines!=1
       THEN 'sale_receipt_funding_account_unverifiable'
  WHEN b.current_actor IS NULL OR b.current_actor_scope IS NOT b.pharmacy_id
       THEN 'sale_receipt_current_actor_unverifiable'
  ELSE NULL END issue_code FROM base b
)
SELECT CAST(sale_id AS TEXT) record_id,CAST(sale_id AS TEXT) source_id,
       source_scope source_pharmacy_id,journal_scope journal_pharmacy_id,
       CAST(sale_micros AS REAL)/1000000.0 source_amount,
       journal_total journal_amount,debits debit_total,credits credit_total,
       issue_code,
       CASE WHEN issue_code IN ('sale_receipt_current_actor_unverifiable',
                                'sale_receipt_funding_account_unverifiable')
            THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY sale_id LIMIT 201
"#;

// 045: collection is a distinct receivable-to-cash/fee journal, *not* a
// rewrite of the original 043 sale money or journal. Only the stored source
// relation and actual entries are checked. Current actor/shift assignments
// can change after posting and must not be asserted as historical fraud.
const DELIVERY_COLLECTION_STRUCTURE: &str = r#"
WITH base AS (
 SELECT c.*,s.id actual_sale,s.pharmacy_id sale_scope,
        s.status sale_status,s.payment_method sale_method,
        s.total_amount original_total,
        p.sale_micros original_micros,
        j.id actual_journal,j.pharmacy_id journal_scope,
        CAST(j.created_by AS TEXT) journal_actor,j.total_amount journal_total,
        m.id actual_movement,m.pharmacy_id movement_scope,
        CAST(m.user_id AS TEXT) movement_actor,
        m.shift_id movement_shift,m.type movement_type,
        m.category movement_category,m.source_type movement_source,
        m.amount movement_amount,
        sh.id current_shift,sh.pharmacy_id current_shift_scope,
        u.id current_actor,u.pharmacy_id current_actor_scope,
        COUNT(e.id) entry_count,
        SUM(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END) debit_sum,
        SUM(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END) credit_sum,
        SUM(CASE WHEN a.code='1.1.1' AND e.type='debit'
               AND ABS(e.amount*100-c.total_cents)<0.0001 THEN 1 ELSE 0 END) cash_lines,
        SUM(CASE WHEN a.code='1.1.2' AND e.type='credit'
               AND ABS(e.amount*100-c.sale_cents)<0.0001 THEN 1 ELSE 0 END) receivable_lines,
        SUM(CASE WHEN a.code='3.2' AND e.type='credit'
               AND ABS(e.amount*100-c.fee_cents)<0.0001 THEN 1 ELSE 0 END) fee_lines
 FROM native_delivery_collection_receipts c
 LEFT JOIN sales_invoices s ON s.id=c.sale_id
 LEFT JOIN native_sale_cogs_provenance p ON p.sale_id=c.sale_id
 LEFT JOIN daily_journals j ON j.id=c.journal_id
 LEFT JOIN journal_entries e ON e.journal_id=c.journal_id
 LEFT JOIN accounts a ON a.id=e.account_id
 LEFT JOIN cash_movements m ON m.id=c.movement_id
 LEFT JOIN shifts sh ON sh.id=c.shift_id
 LEFT JOIN users u ON CAST(u.id AS TEXT)=c.actor_id
 GROUP BY c.id
), assessed AS (
 SELECT b.*,CASE
   WHEN b.actual_sale IS NULL OR b.sale_scope IS NOT b.pharmacy_id
     OR b.sale_status IS NOT 'delivered' OR b.sale_method IS NOT 'delivery'
     OR b.original_micros IS NULL OR b.original_micros!=b.sale_cents*10000
     OR typeof(b.original_total) NOT IN ('integer','real')
     OR ABS(b.original_total*100-b.sale_cents)>0.0001
     OR typeof(b.sale_cents)!='integer' OR typeof(b.fee_cents)!='integer'
     OR typeof(b.total_cents)!='integer'
     OR b.sale_cents<0 OR b.fee_cents<0
     OR b.total_cents<=0 OR b.sale_cents+b.fee_cents!=b.total_cents
     THEN 'delivery_receipt_source_conflict'
   WHEN b.actual_journal IS NULL OR b.journal_scope IS NOT b.pharmacy_id
     OR b.journal_actor IS NOT b.actor_id
     THEN 'delivery_receipt_journal_scope_conflict'
   WHEN typeof(b.journal_total) NOT IN ('integer','real')
     OR ABS(b.journal_total*100-b.total_cents)>0.0001
     OR b.entry_count!=(CASE WHEN b.sale_cents>0 AND b.fee_cents>0 THEN 3 ELSE 2 END)
     OR ABS(b.debit_sum-b.credit_sum)>0.000001
     OR b.cash_lines!=1
     OR b.receivable_lines!=(CASE WHEN b.sale_cents>0 THEN 1 ELSE 0 END)
     OR b.fee_lines!=(CASE WHEN b.fee_cents>0 THEN 1 ELSE 0 END)
     THEN 'delivery_receipt_amount_unbalanced'
   WHEN b.actual_movement IS NULL OR b.movement_scope IS NOT b.pharmacy_id
     OR b.movement_actor IS NOT b.actor_id OR b.movement_shift IS NOT b.shift_id
     OR b.movement_type IS NOT 'receipt' OR b.movement_category IS NOT 'delivery'
     OR b.movement_source IS NOT 'delivery_collection'
     OR typeof(b.movement_amount) NOT IN ('integer','real')
     OR ABS(b.movement_amount*100-b.total_cents)>0.0001
     THEN 'delivery_receipt_cash_movement_conflict'
   WHEN b.current_actor IS NULL OR b.current_actor_scope IS NOT b.pharmacy_id
     OR b.current_shift IS NULL OR b.current_shift_scope IS NOT b.pharmacy_id
     THEN 'delivery_receipt_current_actor_unverifiable'
   ELSE NULL END issue_code
 FROM base b
)
SELECT CAST(id AS TEXT) record_id,CAST(sale_id AS TEXT) source_id,
       sale_scope source_pharmacy_id,journal_scope journal_pharmacy_id,
       CAST(total_cents AS REAL)/100.0 source_amount,
       CAST(journal_total AS REAL) journal_amount,
       CAST(debit_sum AS REAL) debit_total,CAST(credit_sum AS REAL) credit_total,
       issue_code,
       CASE WHEN issue_code='delivery_receipt_current_actor_unverifiable'
            THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY id LIMIT 201
"#;

// Fractional delivery amounts cannot be settled by 045's cent-exact cash
// collection. Even an otherwise valid original 043 posting can be fractional;
// a pre-043 sale also lacks original journal custody. Neither case licenses
// guessing a cent-rounded receivable or assigning an old pharmacy/journal.
const DELIVERY_FRACTIONAL_REVIEW: &str = r#"
SELECT CAST(s.id AS TEXT) record_id,CAST(s.id AS TEXT) source_id,
       NULLIF(TRIM(s.pharmacy_id),'') source_pharmacy_id,
       CAST(NULL AS TEXT) journal_pharmacy_id,
       CAST(s.total_amount AS REAL) source_amount,
       CAST(NULL AS REAL) journal_amount,
       CAST(NULL AS REAL) debit_total,CAST(NULL AS REAL) credit_total,
       'delivery_fractional_amount_needs_review' issue_code,
       'unverifiable_history' classification
FROM main.sales_invoices s
WHERE s.payment_method='delivery' AND s.status='completed'
  AND typeof(s.total_amount) IN ('integer','real')
  AND s.total_amount BETWEEN 0 AND 1000000000
  AND ABS(s.total_amount*100-ROUND(s.total_amount*100))>0.0000001
  AND NOT EXISTS(SELECT 1 FROM main.native_delivery_collection_receipts c
                 WHERE c.sale_id=s.id)
ORDER BY s.id COLLATE BINARY LIMIT 201
"#;

const SALE_RETURN_COGS_STRUCTURE: &str = r#"
WITH base AS (
 SELECT p.*,r.id stored_return,r.invoice_id source_sale,r.pharmacy_id source_scope,
        CAST(r.user_id AS TEXT) source_actor,r.total_refund source_refund,
        r.refund_method source_method,r.status source_status,
        s.id stored_sale,s.pharmacy_id original_sale_scope,
        (SELECT count(*) FROM return_items ri WHERE ri.return_id=p.return_id) source_lines,
        (SELECT count(*) FROM return_items ri
             JOIN sales_items si ON si.id=ri.sale_item_id AND si.invoice_id=p.sale_id
             WHERE ri.return_id=p.return_id) verified_original_lines,
        (SELECT SUM(CAST(ri.total_price AS REAL)) FROM return_items ri
             WHERE ri.return_id=p.return_id) source_line_refund,
        j.id stored_journal,j.pharmacy_id journal_scope,
        CAST(j.created_by AS TEXT) journal_actor,j.total_amount journal_total,
        u.id current_actor,u.pharmacy_id current_actor_scope,
        count(e.journal_id) entry_count,
        sum(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END) debits,
        sum(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END) credits,
        sum(CASE WHEN a.code='3.1' AND e.type='debit'
                 AND abs(e.amount*1000000-p.refund_micros)<2 THEN 1 ELSE 0 END) refund_lines,
        sum(CASE WHEN a.code='1.1.3' AND e.type='debit'
                 AND abs(e.amount*1000000-p.cogs_micros)<2 THEN 1 ELSE 0 END) inventory_lines,
        sum(CASE WHEN a.code='4.1' AND e.type='credit'
                 AND abs(e.amount*1000000-p.cogs_micros)<2 THEN 1 ELSE 0 END) cogs_lines
 FROM native_sale_return_cogs_provenance p
 LEFT JOIN returns r ON r.id=p.return_id
 LEFT JOIN sales_invoices s ON s.id=p.sale_id
 LEFT JOIN daily_journals j ON j.id=p.journal_id
 LEFT JOIN journal_entries e ON e.journal_id=p.journal_id
 LEFT JOIN accounts a ON a.id=e.account_id
 LEFT JOIN users u ON CAST(u.id AS TEXT)=p.actor_id
 GROUP BY p.return_id
), assessed AS (
 SELECT b.*,CASE
  WHEN b.stored_return IS NULL OR b.source_sale IS NOT b.sale_id
       OR b.source_scope IS NOT b.pharmacy_id OR b.source_actor IS NOT b.actor_id
       OR b.source_method IS NOT b.refund_method
       OR LOWER(COALESCE(b.source_status,'')) NOT IN ('approved','completed')
       OR typeof(b.source_refund) NOT IN ('integer','real')
       OR abs(b.source_refund*1000000-b.refund_micros)>2
       THEN 'return_receipt_source_missing_or_changed'
  WHEN b.stored_sale IS NULL OR b.original_sale_scope IS NOT b.pharmacy_id
       THEN 'return_receipt_original_sale_scope_conflict'
  WHEN b.source_lines!=b.line_count OR b.verified_original_lines!=b.line_count
       OR b.source_line_refund IS NULL
       OR abs(b.source_line_refund*1000000-b.refund_micros)>5000
       OR b.line_count NOT BETWEEN 1 AND 200 OR NOT json_valid(b.line_snapshot)
       OR CASE WHEN json_valid(b.line_snapshot)
            THEN json_type(b.line_snapshot)!='array'
              OR json_array_length(b.line_snapshot)!=b.line_count ELSE 1 END
       OR EXISTS (
         SELECT 1 FROM return_items ri WHERE ri.return_id=b.return_id
           AND NOT EXISTS (
             SELECT 1 FROM json_each(CASE WHEN json_valid(b.line_snapshot)
                              THEN b.line_snapshot ELSE '[]' END) witness
             WHERE json_extract(witness.value,'$.lineId')=ri.id
               AND json_extract(witness.value,'$.originalSaleItemId')=ri.sale_item_id
               AND json_extract(witness.value,'$.originalSaleId')=b.sale_id
               AND typeof(ri.total_price) IN ('integer','real')
               AND typeof(json_extract(witness.value,'$.value')) IN ('integer','real')
               AND ri.total_price>=0
               AND abs(ri.total_price-json_extract(witness.value,'$.value'))<=0.005
           )
       )
       THEN 'return_receipt_lines_changed'
  WHEN b.stored_journal IS NULL THEN 'return_receipt_journal_missing'
  WHEN b.journal_scope IS NOT b.pharmacy_id OR b.journal_actor IS NOT b.actor_id
       THEN 'return_receipt_journal_scope_conflict'
  WHEN typeof(b.journal_total) NOT IN ('integer','real')
       OR abs(b.journal_total*1000000-(b.refund_micros+b.cogs_micros))>2
       OR b.entry_count!=(CASE WHEN b.cogs_micros>0 THEN 4 ELSE 2 END)
       OR abs(b.debits-b.credits)>0.000001 OR b.refund_lines!=1
       OR b.inventory_lines!=(CASE WHEN b.cogs_micros>0 THEN 1 ELSE 0 END)
       OR b.cogs_lines!=(CASE WHEN b.cogs_micros>0 THEN 1 ELSE 0 END)
       THEN 'return_receipt_amount_unbalanced'
  WHEN b.current_actor IS NULL OR b.current_actor_scope IS NOT b.pharmacy_id
       THEN 'return_receipt_current_actor_unverifiable'
  ELSE NULL END issue_code FROM base b
)
SELECT CAST(return_id AS TEXT) record_id,CAST(sale_id AS TEXT) source_id,
       source_scope source_pharmacy_id,journal_scope journal_pharmacy_id,
       CAST(refund_micros AS REAL)/1000000.0 source_amount,
       journal_total journal_amount,debits debit_total,credits credit_total,
       issue_code,
       CASE WHEN issue_code='return_receipt_current_actor_unverifiable'
            THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY return_id LIMIT 201
"#;

const SALE_NEGATIVE_SETTLEMENT_STRUCTURE: &str = r#"
WITH base AS (
 SELECT p.*,si.id source_line,si.invoice_id actual_sale,si.inventory_id actual_lot,
        si.cost_price actual_unit_cost,si.is_negative current_negative,si.drug_id source_drug,
        s.pharmacy_id actual_sale_scope,orig.sale_id original_receipted_sale,
        orig.pharmacy_id original_receipt_scope,orig.line_snapshot original_line_snapshot,
        i.id current_lot,i.pharmacy_id current_lot_scope,i.drug_id current_lot_drug,
        j.id stored_journal,j.pharmacy_id journal_scope,
        CAST(j.created_by AS TEXT) journal_actor,j.total_amount journal_total,
        count(e.journal_id) entry_count,
        sum(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END) debits,
        sum(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END) credits,
        sum(CASE WHEN e.type='debit' AND typeof(e.amount) IN ('real','integer')
                 AND abs(e.amount*1000000-p.cogs_micros)<2 THEN 1 ELSE 0 END) exact_debits,
        sum(CASE WHEN e.type='credit' AND typeof(e.amount) IN ('real','integer')
                 AND abs(e.amount*1000000-p.cogs_micros)<2 THEN 1 ELSE 0 END) exact_credits
 FROM native_sale_negative_settlement_provenance p
 LEFT JOIN sales_items si ON si.id=p.sale_item_id
 LEFT JOIN sales_invoices s ON s.id=p.sale_id
 LEFT JOIN native_sale_cogs_provenance orig ON orig.sale_id=p.sale_id
 LEFT JOIN inventory i ON i.id=p.inventory_id
 LEFT JOIN daily_journals j ON j.id=p.journal_id
 LEFT JOIN journal_entries e ON e.journal_id=p.journal_id
 GROUP BY p.sale_item_id
), assessed AS (
 SELECT b.*,CASE
  WHEN b.source_line IS NULL OR b.actual_sale IS NOT b.sale_id
       OR b.actual_lot IS NOT b.inventory_id OR b.current_negative!=0
       OR b.actual_sale_scope IS NOT b.pharmacy_id
       OR b.original_receipted_sale IS NULL
       OR b.original_receipt_scope IS NOT b.pharmacy_id
       OR NOT EXISTS (
         SELECT 1 FROM json_each(CASE WHEN json_valid(b.original_line_snapshot)
                        THEN b.original_line_snapshot ELSE '[]' END) original_line
         WHERE json_extract(original_line.value,'$.lineId')=b.sale_item_id
           AND json_extract(original_line.value,'$.negative')=1
           AND json_type(original_line.value,'$.inventoryId')='null'
           AND json_extract(original_line.value,'$.drugId')=b.source_drug
           AND CAST(json_extract(original_line.value,'$.costPerLarge') AS REAL)=0
       )
       OR abs(b.actual_unit_cost-b.unit_cost)>0.000001
       THEN 'sale_settlement_source_conflict'
  WHEN typeof(b.stock_quantity) NOT IN ('real','integer')
       OR typeof(b.unit_cost) NOT IN ('real','integer')
       OR b.stock_quantity<0 OR b.unit_cost<0
       OR abs(b.stock_quantity*b.unit_cost*1000000-b.cogs_micros)>=2
       THEN 'sale_settlement_cost_conservation_conflict'
  WHEN (b.cogs_micros>0 AND
        (b.stored_journal IS NULL OR b.journal_scope IS NOT b.pharmacy_id
         OR b.journal_actor IS NOT b.actor_id
         OR typeof(b.journal_total) NOT IN ('integer','real')
         OR abs(b.journal_total*1000000-b.cogs_micros)>2
         OR b.entry_count!=2 OR abs(b.debits-b.credits)>0.000001
         OR b.exact_debits!=1 OR b.exact_credits!=1))
       OR (b.cogs_micros=0 AND b.journal_id IS NOT NULL)
       THEN 'sale_settlement_journal_conflict'
  WHEN b.current_lot IS NULL OR b.current_lot_scope IS NOT b.pharmacy_id
       OR b.current_lot_drug IS NOT b.source_drug
       THEN 'sale_settlement_current_lot_unverifiable'
  ELSE NULL END issue_code FROM base b
)
SELECT CAST(sale_item_id AS TEXT) record_id,CAST(sale_id AS TEXT) source_id,
       pharmacy_id source_pharmacy_id,journal_scope journal_pharmacy_id,
       CAST(cogs_micros AS REAL)/1000000.0 source_amount,
       journal_total journal_amount,debits debit_total,credits credit_total,
       issue_code,
       CASE WHEN issue_code='sale_settlement_current_lot_unverifiable'
            THEN 'unverifiable_history' ELSE 'explicit_contradiction' END classification
FROM assessed WHERE issue_code IS NOT NULL ORDER BY sale_item_id LIMIT 201
"#;

const LEGACY_UNVERIFIABLE: &str = r#"
SELECT COUNT(*) FROM main.daily_journals j
WHERE (j.description IS NULL
   OR substr(j.description,1,14)='Sales invoice '
   OR substr(j.description,1,13)='Sales return ')
  AND NOT EXISTS(SELECT 1 FROM native_sale_cogs_provenance p WHERE p.journal_id=j.id)
  AND NOT EXISTS(SELECT 1 FROM native_sale_return_cogs_provenance p WHERE p.journal_id=j.id)
"#;

async fn assert_scan_caps(conn: &mut SqliteConnection) -> Result<i64, String> {
    let mut journal_count = 0;
    for (name, sql) in [
        ("daily_journals", "SELECT COUNT(*) FROM main.daily_journals"),
        (
            "journal_entries",
            "SELECT COUNT(*) FROM main.journal_entries",
        ),
        ("accounts", "SELECT COUNT(*) FROM main.accounts"),
        ("sales_invoices", "SELECT COUNT(*) FROM main.sales_invoices"),
        ("sales_items", "SELECT COUNT(*) FROM main.sales_items"),
        (
            "purchase_invoices",
            "SELECT COUNT(*) FROM main.purchase_invoices",
        ),
        (
            "purchase_invoice_items",
            "SELECT COUNT(*) FROM main.purchase_invoice_items",
        ),
        ("returns", "SELECT COUNT(*) FROM main.returns"),
        ("return_items", "SELECT COUNT(*) FROM main.return_items"),
        (
            "purchase_returns",
            "SELECT COUNT(*) FROM main.purchase_returns",
        ),
        (
            "purchase_return_items",
            "SELECT COUNT(*) FROM main.purchase_return_items",
        ),
        (
            "native_purchase_return_provenance",
            "SELECT COUNT(*) FROM main.native_purchase_return_provenance",
        ),
        ("inventory", "SELECT COUNT(*) FROM main.inventory"),
        ("users", "SELECT COUNT(*) FROM main.users"),
        (
            "stock_adjustments",
            "SELECT COUNT(*) FROM main.stock_adjustments",
        ),
        (
            "native_stock_ledger_provenance",
            "SELECT COUNT(*) FROM main.native_stock_ledger_provenance",
        ),
        (
            "native_purchase_posting_events",
            "SELECT COUNT(*) FROM main.native_purchase_posting_events",
        ),
        (
            "native_sale_cogs_provenance",
            "SELECT COUNT(*) FROM main.native_sale_cogs_provenance",
        ),
        (
            "native_sale_return_cogs_provenance",
            "SELECT COUNT(*) FROM main.native_sale_return_cogs_provenance",
        ),
        (
            "native_sale_negative_settlement_provenance",
            "SELECT COUNT(*) FROM main.native_sale_negative_settlement_provenance",
        ),
        (
            "native_purchase_create_requests",
            "SELECT COUNT(*) FROM main.native_purchase_create_requests",
        ),
        (
            "native_purchase_draft_create_witnesses",
            "SELECT COUNT(*) FROM main.native_purchase_draft_create_witnesses",
        ),
        (
            "native_delivery_collection_receipts",
            "SELECT COUNT(*) FROM main.native_delivery_collection_receipts",
        ),
        (
            "native_purchase_zero_delta_stock_events",
            "SELECT COUNT(*) FROM main.native_purchase_zero_delta_stock_events",
        ),
        (
            "supplier_transactions",
            "SELECT COUNT(*) FROM main.supplier_transactions",
        ),
        (
            "native_supplier_payment_receipts",
            "SELECT COUNT(*) FROM main.native_supplier_payment_receipts",
        ),
        ("cash_movements", "SELECT COUNT(*) FROM main.cash_movements"),
        ("sales_invoices", "SELECT COUNT(*) FROM main.sales_invoices"),
        (
            "patient_transactions",
            "SELECT COUNT(*) FROM main.patient_transactions",
        ),
        (
            "financial_notices",
            "SELECT COUNT(*) FROM main.financial_notices",
        ),
        (
            "native_patient_financial_journal_receipts",
            "SELECT COUNT(*) FROM main.native_patient_financial_journal_receipts",
        ),
        (
            "native_financial_notice_cash_witnesses",
            "SELECT COUNT(*) FROM main.native_financial_notice_cash_witnesses",
        ),
    ] {
        let count: i64 = sqlx::query_scalar(sql)
            .fetch_one(&mut *conn)
            .await
            .map_err(|err| format!("Cannot safely reconcile {name}: {err}"))?;
        if !(0..=MAX_SCANNED_ROWS).contains(&count) {
            return Err(format!(
                "Source reconciliation scan exceeds bound on {name}"
            ));
        }
        if name == "daily_journals" {
            journal_count = count;
        }
    }
    Ok(journal_count)
}

async fn reconcile_snapshot(
    conn: &mut SqliteConnection,
    actor: &str,
) -> Result<FinancialSourceReconciliation, String> {
    // Production connection is read_only(true); a BEGIN snapshot captures
    // committed WAL changes consistently. ROLLBACK ends the *read* snapshot.
    sqlx::query("BEGIN")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    let outcome = async {
        require_active_owner(conn, actor).await?;
        let scanned_journals = assert_scan_caps(conn).await?;
        let stock_provenance_recorded: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM main.native_stock_ledger_provenance")
                .fetch_one(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
        let unattributed_adjustments: i64 = sqlx::query_scalar(UNATTRIBUTED_STOCK_ADJUSTMENTS)
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        let mut findings = Vec::new();
        for (source_type, statement) in [
            ("journal_entry", JOURNAL_ENTRY_REFERENCES),
            ("journal", JOURNAL_TOTALS),
            ("purchase_journal_claim", PURCHASE_JOURNAL_CLAIMS),
            (
                "purchase_return_journal_claim",
                PURCHASE_RETURN_JOURNAL_CLAIMS,
            ),
            ("lot_journal_claim", LOT_JOURNAL_CLAIMS),
            ("sale_return", SALES_RETURN_HEADERS),
            ("purchase_return", PURCHASE_RETURN_HEADERS),
            ("inventory_invoice_line", INVOICE_ITEM_TENANT_LINKS),
            ("return_original_line", RETURN_ITEM_PARENT_LINKS),
            ("supplier_return_claim", SUPPLIER_RETURN_CLAIMS),
            (
                "native_purchase_return_financial",
                PURCHASE_RETURN_RECEIPT_FINANCIAL,
            ),
            ("native_supplier_payment", NATIVE_SUPPLIER_PAYMENT_FINANCIAL),
            ("stock_provenance", STOCK_PROVENANCE_STRUCTURE),
            ("purchase_posting_event", PURCHASE_EVENT_STRUCTURE),
            ("native_purchase_creation", PURCHASE_CREATION_STRUCTURE),
            (
                "native_purchase_draft_witness",
                PURCHASE_DRAFT_WITNESS_STRUCTURE,
            ),
            ("native_purchase_zero_delta", PURCHASE_ZERO_DELTA_STRUCTURE),
            ("native_sale_cogs", SALE_COGS_STRUCTURE),
            ("legacy_patient_credit", LEGACY_PATIENT_CREDIT_SOURCES),
            ("native_patient_cash", NATIVE_PATIENT_CASH_UNKNOWN_TENANT),
            (
                "legacy_patient_money_journal",
                LEGACY_PATIENT_MONEY_JOURNAL_LINKS,
            ),
            (
                "native_patient_money_journal",
                NATIVE_PATIENT_FINANCIAL_JOURNAL_STRUCTURE,
            ),
            ("native_notice_cash", NATIVE_NOTICE_CASH_WITNESS),
            ("native_delivery_collection", DELIVERY_COLLECTION_STRUCTURE),
            ("delivery_fractional_review", DELIVERY_FRACTIONAL_REVIEW),
            ("native_sale_return_cogs", SALE_RETURN_COGS_STRUCTURE),
            (
                "native_sale_negative_settlement",
                SALE_NEGATIVE_SETTLEMENT_STRUCTURE,
            ),
        ] {
            // LIMIT 201 exposes overflow without materializing unbounded data.
            let rows = sqlx::query(statement)
                .fetch_all(&mut *conn)
                .await
                .map_err(|err| {
                    format!("Source reconciliation schema is not safely auditable: {err}")
                })?;
            if findings.len() + rows.len() > MAX_FINDINGS {
                return Err(
                    "Financial source reconciliation exceeded 200 findings; no partial report"
                        .into(),
                );
            }
            for row in &rows {
                findings.push(decode(row, source_type)?);
            }
        }
        let unverifiable_legacy_journals: i64 = sqlx::query_scalar(LEGACY_UNVERIFIABLE)
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        let stock_review_required = findings
            .iter()
            .filter(|f| f.source_type == "stock_provenance")
            .count() as i64;
        if stock_review_required > stock_provenance_recorded {
            return Err("Invalid stock provenance reconciliation cardinality".into());
        }
        Ok(FinancialSourceReconciliation {
            status: if findings.is_empty()
                && unverifiable_legacy_journals == 0
                && unattributed_adjustments == 0
            {
                "limited_no_findings"
            } else {
                "review_required"
            },
            findings,
            scanned_journals,
            unverifiable_legacy_journals,
            stock_provenance: StockProvenanceCoverage {
                recorded: stock_provenance_recorded,
                structurally_verified: stock_provenance_recorded - stock_review_required,
                review_required: stock_review_required,
                unattributed_adjustments,
            },
            max_findings: MAX_FINDINGS,
        })
    }
    .await;
    let release = sqlx::query("ROLLBACK").execute(&mut *conn).await;
    if let Err(error) = release {
        return Err(format!(
            "Unable to close source reconciliation snapshot: {error}"
        ));
    }
    outcome
}

#[tauri::command]
pub async fn reconcile_financial_sources_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<FinancialSourceReconciliation, String> {
    // Keep live actor RwLock guard through connection close so logout and
    // actor switching cannot happen in the middle of an owner-wide report.
    let actor = session.authorize_session().await?;
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| format!("Cannot open readonly database: {e}"))?;
    let result = reconcile_snapshot(&mut conn, actor.as_deref().ok_or("Login required")?).await;
    let close = conn.close().await.map_err(|e| e.to_string());
    match (result, close) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,is_active INTEGER,pharmacy_id TEXT);
            INSERT INTO users VALUES
              ('owner-a','owner',1,'a'),('owner-b','owner',1,'b'),
              ('admin-a','admin',1,'a'),('inactive','owner',0,'a');
            CREATE TABLE accounts(
              id INTEGER PRIMARY KEY,type TEXT,
              is_group INTEGER DEFAULT 0,parent_id INTEGER
            );
            INSERT INTO accounts(id,type) VALUES
              (1,'asset'),(2,'revenue'),(3,'expense'),(4,'unclassified');
            CREATE TABLE daily_journals(
              id TEXT PRIMARY KEY,date TEXT,description TEXT,created_by TEXT,
              total_amount REAL,pharmacy_id TEXT
            );
            CREATE TABLE journal_entries(
              id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,
              type TEXT,amount REAL
            );
            CREATE TABLE patient_transactions(id TEXT PRIMARY KEY,patient_id TEXT,user_id TEXT,
              type TEXT,amount REAL,payment_method TEXT,date TEXT);
            CREATE TABLE patient_payment_scope(transaction_id TEXT PRIMARY KEY,pharmacy_id TEXT,request_id TEXT);
            CREATE TABLE financial_notices(id TEXT PRIMARY KEY,user_id TEXT,target_type TEXT,
              target_id TEXT,type TEXT,amount REAL,date TEXT,pharmacy_id TEXT);
            CREATE TABLE financial_notice_native_scope(notice_id TEXT PRIMARY KEY,pharmacy_id TEXT,
              request_id TEXT,patient_transaction_id TEXT);
            CREATE TABLE native_patient_financial_journal_receipts(source_kind TEXT,source_id TEXT,
              pharmacy_id TEXT,actor_id TEXT,journal_id TEXT,amount_cents INTEGER,money_kind TEXT,cash_movement_id TEXT);
            CREATE TABLE native_financial_notice_cash_witnesses(notice_id TEXT,journal_id TEXT,
              cash_movement_id TEXT,shift_id TEXT,pharmacy_id TEXT,actor_id TEXT,amount_cents INTEGER);
            CREATE TABLE inventory(
              id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
              quantity REAL DEFAULT 0,cost_price REAL DEFAULT 0
            );
            INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price) VALUES
              ('lot-a',10,'a',5,3),('lot-b',10,'b',6,3),
              ('lot-legacy',10,NULL,1,3);
            CREATE TABLE stock_adjustments(
              id INTEGER PRIMARY KEY,inventory_id TEXT,reason_id INTEGER,
              old_quantity REAL,new_quantity REAL,user_id TEXT
            );
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,patient_id TEXT);
            INSERT INTO sales_invoices(id,pharmacy_id) VALUES('sale-a','a'),('sale-b','b');
            CREATE TABLE sales_items(
              id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,drug_id INTEGER
            );
            CREATE TABLE purchase_invoices(
              id TEXT PRIMARY KEY,pharmacy_id TEXT,supplier_id INTEGER,total_amount REAL
            );
            INSERT INTO purchase_invoices VALUES
              ('purchase-a','a',1,100),('purchase-b','b',2,100);
            CREATE TABLE purchase_invoice_items(
              id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,drug_id INTEGER
            );
            CREATE TABLE returns(
              id TEXT PRIMARY KEY,invoice_id TEXT,pharmacy_id TEXT,status TEXT
            );
            CREATE TABLE return_items(
              id INTEGER PRIMARY KEY,return_id TEXT,sale_item_id INTEGER,total_price REAL
            );
            CREATE TABLE purchase_returns(
              id TEXT PRIMARY KEY,purchase_invoice_id TEXT,supplier_id INTEGER,
              total_amount REAL,status TEXT
            );
            CREATE TABLE purchase_return_items(
              id INTEGER PRIMARY KEY,purchase_return_id TEXT,purchase_invoice_item_id INTEGER
            );
            CREATE TABLE supplier_transactions(
              id INTEGER PRIMARY KEY,type TEXT,reference_id TEXT,supplier_id INTEGER,amount REAL
            );
            CREATE TABLE suppliers(id INTEGER PRIMARY KEY,balance REAL);
            CREATE TABLE native_purchase_return_provenance(
              return_id TEXT PRIMARY KEY,purchase_invoice_id TEXT,pharmacy_id TEXT,
              actor_id TEXT,supplier_id INTEGER,refund_method TEXT,amount_cents INTEGER,journal_id TEXT
            );
            CREATE TABLE native_purchase_posting_events(
              event_id TEXT PRIMARY KEY, invoice_id TEXT, pharmacy_id TEXT,
              actor_id TEXT,event_kind TEXT,journal_id TEXT,signed_cents INTEGER,
              old_total_cents INTEGER,new_total_cents INTEGER,line_snapshot TEXT
            );
            CREATE TABLE native_sale_cogs_provenance(
              sale_id TEXT PRIMARY KEY,request_id TEXT,pharmacy_id TEXT,actor_id TEXT,
              journal_id TEXT,payment_method TEXT,sale_micros INTEGER,cogs_micros INTEGER,
              line_count INTEGER,line_snapshot TEXT
            );
            CREATE TABLE native_sale_return_cogs_provenance(
              return_id TEXT PRIMARY KEY,request_id TEXT,sale_id TEXT,pharmacy_id TEXT,actor_id TEXT,
              journal_id TEXT,refund_method TEXT,refund_micros INTEGER,cogs_micros INTEGER,
              line_count INTEGER,line_snapshot TEXT
            );
            CREATE TABLE native_sale_negative_settlement_provenance(
              sale_item_id INTEGER PRIMARY KEY,sale_id TEXT,pharmacy_id TEXT,actor_id TEXT,
              inventory_id TEXT,stock_quantity REAL,unit_cost REAL,cogs_micros INTEGER,journal_id TEXT
            );
            ALTER TABLE sales_invoices ADD COLUMN user_id TEXT;
            ALTER TABLE sales_invoices ADD COLUMN total_amount REAL;
            ALTER TABLE sales_invoices ADD COLUMN payment_method TEXT;
            ALTER TABLE sales_invoices ADD COLUMN status TEXT;
            ALTER TABLE returns ADD COLUMN user_id TEXT;
            ALTER TABLE returns ADD COLUMN total_refund REAL;
            ALTER TABLE returns ADD COLUMN refund_method TEXT;
            ALTER TABLE sales_items ADD COLUMN is_negative INTEGER;
            ALTER TABLE sales_items ADD COLUMN cost_price REAL;
            ALTER TABLE purchase_invoices ADD COLUMN user_id TEXT;
            ALTER TABLE purchase_invoices ADD COLUMN status TEXT;
            ALTER TABLE purchase_returns ADD COLUMN refund_method TEXT;
            UPDATE purchase_invoices SET user_id='owner-a',status='draft' WHERE id='purchase-a';
            UPDATE purchase_invoices SET user_id='owner-b',status='draft' WHERE id='purchase-b';
            ALTER TABLE accounts ADD COLUMN code TEXT;
        "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/040_stock_ledger_provenance.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        // Projection-only schema for later migrations in an intentionally
        // minimal old-history fixture; real triggers are integration-tested
        // by the native delivery and purchase writer fixtures.
        sqlx::raw_sql(
            "CREATE TABLE native_purchase_create_requests(request_id TEXT,invoice_id TEXT,actor_id TEXT,pharmacy_id TEXT,supplier_id INTEGER,source_status TEXT,source_total_cents INTEGER,source_line_count INTEGER,initial_journal_id TEXT);
             CREATE TABLE native_purchase_draft_create_witnesses(request_id TEXT,invoice_id TEXT,actor_id TEXT,pharmacy_id TEXT,original_request_sha256 TEXT,original_source_sha256 TEXT);
             CREATE TABLE native_purchase_zero_delta_stock_events(event_id TEXT,invoice_id TEXT,actor_id TEXT,pharmacy_id TEXT,supplier_id INTEGER,total_cents INTEGER,original_journal_id TEXT,line_snapshot TEXT,line_count INTEGER);
             CREATE TABLE native_delivery_collection_receipts(id TEXT,request_id TEXT,sale_id TEXT,pharmacy_id TEXT,actor_id TEXT,shift_id TEXT,journal_id TEXT,movement_id TEXT,sale_cents INTEGER,fee_cents INTEGER,total_cents INTEGER);
             CREATE TABLE native_supplier_payment_receipts(id TEXT,request_id TEXT,supplier_id INTEGER,invoice_id TEXT,supplier_transaction_id INTEGER,pharmacy_id TEXT,actor_id TEXT,amount_cents INTEGER,payment_method TEXT,payment_date TEXT,journal_id TEXT,cash_movement_id TEXT,balance_before_cents INTEGER,balance_after_cents INTEGER);
             CREATE TABLE shifts(id TEXT PRIMARY KEY,pharmacy_id TEXT,status TEXT);
            CREATE TABLE cash_movements(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT,shift_id TEXT,type TEXT,category TEXT,source_type TEXT,target_name TEXT,amount REAL,date TEXT);",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/049_purchase_return_reference_indexes.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    async fn journal(
        conn: &mut SqliteConnection,
        id: &str,
        description: &str,
        pharmacy: Option<&str>,
        amount: f64,
    ) {
        sqlx::query(
            "INSERT INTO daily_journals
          (id,date,description,created_by,total_amount,pharmacy_id)
          VALUES(?,'2026-10-12',?,'owner-a',?,?)",
        )
        .bind(id)
        .bind(description)
        .bind(amount)
        .bind(pharmacy)
        .execute(&mut *conn)
        .await
        .unwrap();
        for (account, side) in [(1, "debit"), (2, "credit")] {
            sqlx::query(
                "INSERT INTO journal_entries(journal_id,account_id,type,amount)
                        VALUES(?,?,?,?)",
            )
            .bind(id)
            .bind(account)
            .bind(side)
            .bind(amount)
            .execute(&mut *conn)
            .await
            .unwrap();
        }
    }

    fn issue<'a>(
        report: &'a FinancialSourceReconciliation,
        code: &str,
    ) -> Vec<&'a ReconciliationFinding> {
        report
            .findings
            .iter()
            .filter(|f| f.issue_code == code)
            .collect()
    }

    const STOCK_GAIN_JOURNAL: &str = "native-lot-adjust-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const STOCK_LOSS_JOURNAL: &str = "native-lot-zero-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    // The real 040 migration, not a simplified mock, validates these fixtures.
    async fn stock_proof(
        conn: &mut SqliteConnection,
        id: i64,
        lot: &str,
        old: f64,
        new: f64,
        cost_cents: i64,
        journal_id: Option<&str>,
    ) {
        sqlx::query("UPDATE inventory SET quantity=?,cost_price=? WHERE id=?")
            .bind(new)
            .bind(cost_cents as f64 / 100.0)
            .bind(lot)
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO stock_adjustments
             (id,inventory_id,old_quantity,new_quantity,user_id)
             VALUES(?,?,?,?,'owner-a')",
        )
        .bind(id)
        .bind(lot)
        .bind(old)
        .bind(new)
        .execute(&mut *conn)
        .await
        .unwrap();
        let valuation = ((new - old).abs() * cost_cents as f64).round() as i64;
        let increase = new > old;
        if let Some(j) = journal_id {
            // The title deliberately references a DIFFERENT lot. Once 040
            // linkage exists it must not be mistaken for structural evidence.
            sqlx::query(
                "INSERT INTO daily_journals
                 (id,date,description,created_by,total_amount,pharmacy_id)
                 VALUES(?,'2026-10-12','Legacy-like [lot_id=lot-b]',
                        'owner-a',?,'a')",
            )
            .bind(j)
            .bind(valuation as f64 / 100.0)
            .execute(&mut *conn)
            .await
            .unwrap();
            for (account, side) in if increase {
                [(1, "debit"), (2, "credit")]
            } else {
                [(3, "debit"), (1, "credit")]
            } {
                sqlx::query(
                    "INSERT INTO journal_entries(journal_id,account_id,type,amount)
                     VALUES(?,?,?,?)",
                )
                .bind(j)
                .bind(account)
                .bind(side)
                .bind(valuation as f64 / 100.0)
                .execute(&mut *conn)
                .await
                .unwrap();
            }
        }
        sqlx::query(
            "INSERT INTO native_stock_ledger_provenance
             (adjustment_id,inventory_id,pharmacy_id,actor_id,
              old_quantity,new_quantity,unit_cost_cents,valuation_cents,
              direction,journal_id,inventory_account_id,
              counterpart_account_id,counterpart_type)
             VALUES(?,?,'a','owner-a',?,?,?,?,?,?,?, ?,?)",
        )
        .bind(id)
        .bind(lot)
        .bind(old)
        .bind(new)
        .bind(cost_cents)
        .bind(valuation)
        .bind(if increase { "increase" } else { "decrease" })
        .bind(journal_id)
        .bind(journal_id.map(|_| 1_i64))
        .bind(journal_id.map(|_| if increase { 2_i64 } else { 3_i64 }))
        .bind(journal_id.map(|_| if increase { "revenue" } else { "expense" }))
        .execute(&mut *conn)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn proof_040_is_verified_without_trusting_a_misleading_lot_description() {
        let mut conn = fixture().await;
        stock_proof(
            &mut conn,
            100,
            "lot-a",
            2.0,
            5.0,
            300,
            Some(STOCK_GAIN_JOURNAL),
        )
        .await;
        journal(
            &mut conn,
            "native-lot-adjust-legacy-uuid",
            "Historic [lot_id=lot-b]",
            Some("a"),
            5.0,
        )
        .await;
        let report = reconcile_snapshot(&mut conn, "owner-b").await.unwrap();
        assert_eq!(report.stock_provenance.recorded, 1);
        assert_eq!(report.stock_provenance.structurally_verified, 1);
        assert_eq!(report.stock_provenance.review_required, 0);
        assert_eq!(report.stock_provenance.unattributed_adjustments, 0);
        assert!(!report
            .findings
            .iter()
            .any(|f| f.source_type == "stock_provenance" || f.record_id == STOCK_GAIN_JOURNAL));
        assert_eq!(issue(&report, "lot_claim_scope_conflict").len(), 1);
        assert_eq!(
            issue(&report, "lot_claim_scope_conflict")[0].classification,
            "source_claim_conflict"
        );
    }

    #[tokio::test]
    async fn zero_cost_040_proof_is_structural_without_a_fabricated_journal() {
        let mut conn = fixture().await;
        sqlx::query(
            "INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price)
             VALUES('free-lot',10,'a',0,0)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        stock_proof(&mut conn, 101, "free-lot", 0.0, 2.0, 0, None).await;
        let report = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(report.stock_provenance.structurally_verified, 1);
        assert!(report.findings.is_empty());
    }

    #[tokio::test]
    async fn missing_original_adjustment_and_journal_are_independent_contradictions() {
        let mut conn = fixture().await;
        stock_proof(
            &mut conn,
            102,
            "lot-a",
            2.0,
            5.0,
            300,
            Some(STOCK_GAIN_JOURNAL),
        )
        .await;
        // Deliberately simulate corrupted storage in this disposable fixture,
        // bypassing 040 tamper protection, not production writes.
        conn.execute("PRAGMA foreign_keys=OFF").await.unwrap();
        conn.execute("DROP TRIGGER native_stock_adjustment_no_delete")
            .await
            .unwrap();
        conn.execute("DELETE FROM stock_adjustments WHERE id=102")
            .await
            .unwrap();
        let report = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(issue(&report, "stock_provenance_source_missing").len(), 1);
        assert_eq!(
            issue(&report, "stock_provenance_source_missing")[0].classification,
            "explicit_contradiction"
        );
        conn.execute("DROP TRIGGER native_stock_journal_no_delete")
            .await
            .unwrap();
        conn.execute(
            "DELETE FROM daily_journals WHERE id=
            'native-lot-adjust-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
        )
        .await
        .unwrap();
        // Same bad row prioritizes missing adjustment. Restore that original
        // source in the artificial fixture to isolate the journal defect.
        conn.execute(
            "INSERT INTO stock_adjustments
             (id,inventory_id,old_quantity,new_quantity,user_id)
             VALUES(102,'lot-a',2,5,'owner-a')",
        )
        .await
        .unwrap();
        let result = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(issue(&result, "stock_provenance_journal_missing").len(), 1);
        assert_eq!(result.stock_provenance.structurally_verified, 0);
    }

    #[tokio::test]
    async fn journal_tenant_and_posted_amount_tampering_is_explicit() {
        let mut conn = fixture().await;
        stock_proof(
            &mut conn,
            103,
            "lot-a",
            2.0,
            5.0,
            300,
            Some(STOCK_GAIN_JOURNAL),
        )
        .await;
        conn.execute("DROP TRIGGER native_stock_journal_no_update")
            .await
            .unwrap();
        sqlx::query("UPDATE daily_journals SET pharmacy_id='b' WHERE id=?")
            .bind(STOCK_GAIN_JOURNAL)
            .execute(&mut conn)
            .await
            .unwrap();
        let cross = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&cross, "stock_provenance_journal_tenant_actor_conflict").len(),
            1
        );
        assert_eq!(cross.stock_provenance.review_required, 1);
        sqlx::query("UPDATE daily_journals SET pharmacy_id='a',total_amount=8 WHERE id=?")
            .bind(STOCK_GAIN_JOURNAL)
            .execute(&mut conn)
            .await
            .unwrap();
        let mismatch = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&mismatch, "stock_provenance_journal_amount_conflict").len(),
            1
        );
        assert_eq!(
            issue(&mismatch, "stock_provenance_journal_amount_conflict")[0].classification,
            "explicit_contradiction"
        );
    }

    #[tokio::test]
    async fn broken_040_journal_lines_and_account_reference_have_distinct_assessments() {
        let mut conn = fixture().await;
        stock_proof(
            &mut conn,
            104,
            "lot-a",
            2.0,
            5.0,
            300,
            Some(STOCK_GAIN_JOURNAL),
        )
        .await;
        conn.execute("DROP TRIGGER native_stock_entries_no_update")
            .await
            .unwrap();
        sqlx::query(
            "UPDATE journal_entries SET amount=8 WHERE journal_id=?
                     AND type='credit'",
        )
        .bind(STOCK_GAIN_JOURNAL)
        .execute(&mut conn)
        .await
        .unwrap();
        let result = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&result, "stock_provenance_journal_lines_conflict").len(),
            1
        );
        assert_eq!(
            issue(&result, "stock_provenance_journal_lines_conflict")[0].classification,
            "explicit_contradiction"
        );
        sqlx::query("UPDATE journal_entries SET amount=9 WHERE journal_id=? AND type='credit'")
            .bind(STOCK_GAIN_JOURNAL)
            .execute(&mut conn)
            .await
            .unwrap();
        conn.execute("UPDATE accounts SET type='expense' WHERE id=1")
            .await
            .unwrap();
        let changed = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&changed, "stock_provenance_current_account_unverifiable").len(),
            1
        );
        assert_eq!(
            issue(&changed, "stock_provenance_current_account_unverifiable")[0].classification,
            "unverifiable_history"
        );
    }

    #[tokio::test]
    async fn current_lot_and_actor_changes_do_not_rewrite_historical_provenance() {
        let mut conn = fixture().await;
        stock_proof(
            &mut conn,
            105,
            "lot-a",
            2.0,
            5.0,
            300,
            Some(STOCK_GAIN_JOURNAL),
        )
        .await;
        conn.execute("UPDATE inventory SET cost_price=200,quantity=20 WHERE id='lot-a'")
            .await
            .unwrap();
        let stable = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            stable.stock_provenance.structurally_verified, 1,
            "later cost and quantity changes do not alter the original snapshot"
        );
        conn.execute("UPDATE inventory SET pharmacy_id=NULL WHERE id='lot-a'")
            .await
            .unwrap();
        let missing = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&missing, "stock_provenance_current_lot_scope_unknown").len(),
            1
        );
        conn.execute("UPDATE inventory SET pharmacy_id='a' WHERE id='lot-a'")
            .await
            .unwrap();
        conn.execute("UPDATE users SET pharmacy_id='b' WHERE id='owner-a'")
            .await
            .unwrap();
        let moved = reconcile_snapshot(&mut conn, "owner-b").await.unwrap();
        assert_eq!(
            issue(&moved, "stock_provenance_current_actor_scope_changed").len(),
            1
        );
        assert_eq!(
            issue(&moved, "stock_provenance_current_actor_scope_changed")[0].classification,
            "unverifiable_history"
        );
    }

    #[tokio::test]
    async fn migration_040_uniqueness_prevents_replaying_one_journal_for_two_sources() {
        let mut conn = fixture().await;
        stock_proof(
            &mut conn,
            106,
            "lot-a",
            2.0,
            5.0,
            300,
            Some(STOCK_GAIN_JOURNAL),
        )
        .await;
        conn.execute(
            "INSERT INTO stock_adjustments
           (id,inventory_id,old_quantity,new_quantity,user_id)
           VALUES(107,'lot-a',2,5,'owner-a')",
        )
        .await
        .unwrap();
        let dup = sqlx::query(
            "INSERT INTO native_stock_ledger_provenance
             (adjustment_id,inventory_id,pharmacy_id,actor_id,old_quantity,
              new_quantity,unit_cost_cents,valuation_cents,direction,journal_id,
              inventory_account_id,counterpart_account_id,counterpart_type)
             SELECT 107,inventory_id,pharmacy_id,actor_id,old_quantity,
                    new_quantity,unit_cost_cents,valuation_cents,direction,
                    journal_id,inventory_account_id,counterpart_account_id,
                    counterpart_type
             FROM native_stock_ledger_provenance WHERE adjustment_id=106",
        )
        .execute(&mut conn)
        .await;
        assert!(
            dup.is_err(),
            "040 UNIQUE journal reference must reject replay"
        );
        let report = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(report.stock_provenance.recorded, 1);
        assert_eq!(report.stock_provenance.unattributed_adjustments, 1);
        assert_eq!(report.stock_provenance.structurally_verified, 1);
        assert!(issue(&report, "stock_provenance_duplicate_journal_claim").is_empty());
        assert_eq!(
            report.status, "review_required",
            "unattributed adjustment is uncertain, not certified legacy"
        );
    }

    #[tokio::test]
    async fn source_201_040_orphans_fail_closed_and_release_the_read_snapshot() {
        let mut conn = fixture().await;
        // Only in-memory: drop the insert guard to construct a corrupted
        // forward-only sidecar containing 201 absent original source IDs.
        conn.execute("PRAGMA foreign_keys=OFF").await.unwrap();
        conn.execute("DROP TRIGGER native_stock_provenance_insert_guard")
            .await
            .unwrap();
        conn.execute(
            "WITH RECURSIVE n(x) AS
              (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<200)
             INSERT INTO native_stock_ledger_provenance
              (adjustment_id,inventory_id,pharmacy_id,actor_id,old_quantity,
               new_quantity,unit_cost_cents,valuation_cents,direction)
             SELECT x,'lot-a','a','owner-a',2,5,0,0,'increase' FROM n",
        )
        .await
        .unwrap();
        let within = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(within.stock_provenance.review_required, 200);
        assert_eq!(within.stock_provenance.structurally_verified, 0);
        assert_eq!(within.findings.len(), 200);
        conn.execute(
            "INSERT INTO native_stock_ledger_provenance
             (adjustment_id,inventory_id,pharmacy_id,actor_id,old_quantity,
              new_quantity,unit_cost_cents,valuation_cents,direction)
             VALUES(201,'lot-a','a','owner-a',2,5,0,0,'increase')",
        )
        .await
        .unwrap();
        let failed = reconcile_snapshot(&mut conn, "owner-a").await.unwrap_err();
        assert!(failed.contains("exceeded 200"), "{failed}");
        let unchanged: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM native_stock_ledger_provenance")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(unchanged, 201);
    }

    #[tokio::test]
    async fn live_owner_is_required_and_revocation_is_immediate() {
        let mut conn = fixture().await;
        for actor in ["owner-a", "owner-b"] {
            let output = reconcile_snapshot(&mut conn, actor).await.unwrap();
            assert_eq!(output.max_findings, 200);
        }
        for actor in ["admin-a", "inactive", "missing"] {
            assert!(
                reconcile_snapshot(&mut conn, actor).await.is_err(),
                "{actor}"
            );
        }
        conn.execute("UPDATE users SET role='admin' WHERE id='owner-a'")
            .await
            .unwrap();
        assert!(reconcile_snapshot(&mut conn, "owner-a").await.is_err());
        let current: String = sqlx::query_scalar("SELECT role FROM users WHERE id='owner-a'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            current, "admin",
            "audit never modifies role on authorization failure"
        );
    }

    #[tokio::test]
    async fn purchase_full_id_claims_distinguish_cross_tenant_missing_duplicate_and_edit() {
        let mut conn = fixture().await;
        journal(
            &mut conn,
            "j-cross",
            "Purchase invoice [id=purchase-b]",
            Some("a"),
            100.0,
        )
        .await;
        journal(
            &mut conn,
            "j-duplicate-1",
            "Purchase invoice [id=purchase-a]",
            Some("a"),
            100.0,
        )
        .await;
        journal(
            &mut conn,
            "j-duplicate-2",
            "Purchase invoice [id=purchase-a]",
            Some("a"),
            100.0,
        )
        .await;
        journal(
            &mut conn,
            "j-missing",
            "Purchase invoice [id=deleted]",
            Some("a"),
            100.0,
        )
        .await;
        journal(
            &mut conn,
            "j-edit-1",
            "Purchase edit [id=purchase-b]",
            Some("b"),
            10.0,
        )
        .await;
        journal(
            &mut conn,
            "j-edit-2",
            "Purchase edit [id=purchase-b]",
            Some("b"),
            20.0,
        )
        .await;
        let report = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&report, "purchase_claim_scope_conflict")[0].record_id,
            "j-cross"
        );
        assert_eq!(
            issue(&report, "purchase_claim_source_missing")[0].record_id,
            "j-missing"
        );
        assert_eq!(issue(&report, "purchase_claim_initial_duplicate").len(), 2);
        assert!(
            !report
                .findings
                .iter()
                .any(|f| matches!(f.record_id.as_str(), "j-edit-1" | "j-edit-2")),
            "purchase edits may legitimately repeat with separate delta amounts"
        );
        for f in report
            .findings
            .iter()
            .filter(|f| f.source_type == "purchase_journal_claim")
        {
            assert_eq!(
                f.classification, "source_claim_conflict",
                "mutable journal descriptions cannot certify tenant fraud"
            );
        }
    }

    #[tokio::test]
    async fn purchase_return_claims_reconcile_exact_posted_amount_as_review_only() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO purchase_returns (id,purchase_invoice_id,supplier_id,total_amount,status) VALUES
          ('return-a','purchase-a',1,30,'completed'),
          ('return-b','purchase-b',2,50,'completed')",
        )
        .await
        .unwrap();
        journal(
            &mut conn,
            "jr-ok",
            "Purchase return return-a",
            Some("a"),
            30.0,
        )
        .await;
        journal(
            &mut conn,
            "jr-amount",
            "Purchase return return-b",
            Some("b"),
            40.0,
        )
        .await;
        journal(
            &mut conn,
            "jr-cross",
            "Purchase return return-a",
            Some("b"),
            30.0,
        )
        .await;
        journal(
            &mut conn,
            "jr-absent",
            "Purchase return absent",
            Some("a"),
            10.0,
        )
        .await;
        let report = reconcile_snapshot(&mut conn, "owner-b").await.unwrap();
        assert_eq!(
            issue(&report, "purchase_return_claim_amount_conflict")[0].record_id,
            "jr-amount"
        );
        assert_eq!(
            issue(&report, "purchase_return_claim_missing")[0].record_id,
            "jr-absent"
        );
        assert_eq!(issue(&report, "purchase_return_claim_duplicate").len(), 2);
        assert!(report
            .findings
            .iter()
            .filter(|f| f.source_type == "purchase_return_journal_claim")
            .all(|f| f.classification != "explicit_contradiction"));
    }

    #[tokio::test]
    async fn debit_credit_and_account_type_checks_are_structural_not_normal_side_fraud() {
        let mut conn = fixture().await;
        journal(
            &mut conn,
            "good-reversal",
            "Manual reversal",
            Some("a"),
            50.0,
        )
        .await;
        // Accounting reversals may legally credit expenses: account type is
        // not evidence that a posting's debit/credit side is illicit.
        conn.execute(
            "UPDATE journal_entries SET account_id=3
                      WHERE journal_id='good-reversal' AND type='credit'",
        )
        .await
        .unwrap();
        journal(
            &mut conn,
            "j-unbalanced",
            "Purchase return absent",
            Some("a"),
            20.0,
        )
        .await;
        conn.execute(
            "UPDATE journal_entries SET amount=19
                      WHERE journal_id='j-unbalanced' AND type='credit'",
        )
        .await
        .unwrap();
        journal(
            &mut conn,
            "j-header",
            "Purchase invoice [id=purchase-a]",
            Some("a"),
            20.0,
        )
        .await;
        conn.execute("UPDATE daily_journals SET total_amount=99 WHERE id='j-header'")
            .await
            .unwrap();
        conn.execute(
            "INSERT INTO journal_entries(journal_id,account_id,type,amount)
                      VALUES('missing',1,'debit',1)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO journal_entries(journal_id,account_id,type,amount)
                      VALUES('j-header',999,'debit',2)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO journal_entries(journal_id,account_id,type,amount)
                      VALUES('j-header',4,'debit',2)",
        )
        .await
        .unwrap();
        let report = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(issue(&report, "journal_unbalanced")
            .iter()
            .any(|f| f.record_id == "j-unbalanced"));
        assert_eq!(issue(&report, "ledger_entry_journal_missing").len(), 1);
        assert_eq!(issue(&report, "ledger_entry_account_missing").len(), 1);
        assert_eq!(issue(&report, "ledger_account_type_unverifiable").len(), 1);
        assert!(
            !report
                .findings
                .iter()
                .any(|f| f.record_id == "good-reversal"),
            "asset/expense normal balance is not an immutable direction restriction"
        );
        assert_eq!(
            issue(&report, "journal_unbalanced")[0].classification,
            "explicit_contradiction"
        );
    }

    #[tokio::test]
    async fn persisted_source_relations_prove_tenant_and_original_item_disagreement() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO sales_items(id,invoice_id,inventory_id,drug_id) VALUES
           (1,'sale-a','lot-b',10),
           (2,'sale-b','lot-b',10),
           (3,'sale-a','lot-a',10)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO purchase_invoice_items VALUES
           (1,'purchase-a','lot-b',10),
           (2,'purchase-b','lot-b',10)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO returns(id,invoice_id,pharmacy_id,status) VALUES
           ('r-cross','sale-b','a','approved'),
           ('r-unknown','sale-a',NULL,'approved'),
           ('r-good','sale-a','a','approved')",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO return_items(id,return_id,sale_item_id) VALUES
           (1,'r-good',2),(2,'r-good',3)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO purchase_returns (id,purchase_invoice_id,supplier_id,total_amount,status) VALUES
           ('pr-supplier','purchase-b',1,30,'completed'),
           ('pr-good','purchase-a',1,30,'completed')",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO purchase_return_items VALUES
           (1,'pr-good',2),(2,'pr-good',1)",
        )
        .await
        .unwrap();
        let report = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        for code in [
            "sale_return_scope_conflict",
            "sale_line_inventory_scope_conflict",
            "purchase_line_inventory_scope_conflict",
            "sale_return_line_invoice_conflict",
            "purchase_return_line_invoice_conflict",
            "purchase_return_supplier_conflict",
        ] {
            assert!(!issue(&report, code).is_empty(), "{code}");
            assert!(
                issue(&report, code)
                    .iter()
                    .all(|f| f.classification == "explicit_contradiction"),
                "{code}"
            );
        }
        let null = issue(&report, "sale_return_scope_unknown");
        assert_eq!(null[0].record_id, "r-unknown");
        assert_eq!(null[0].classification, "unverifiable_history");
    }

    #[tokio::test]
    async fn native_lot_marker_cross_pharmacy_is_unverified_and_legacy_sales_prefix_is_opaque() {
        let mut conn = fixture().await;
        journal(
            &mut conn,
            "native-lot-adjust-uuid1",
            "تسوية مخزون [lot_id=lot-b] old_qty=5",
            Some("a"),
            15.0,
        )
        .await;
        journal(
            &mut conn,
            "native-lot-zero-uuid2",
            "تصفير مخزون [lot_id=lot-legacy]",
            Some("a"),
            8.0,
        )
        .await;
        journal(
            &mut conn,
            "native-lot-zero-uuid3",
            "تصفير مخزون [lot_id=deleted]",
            Some("a"),
            8.0,
        )
        .await;
        journal(
            &mut conn,
            "legacy-sale-journal",
            "Sales invoice deadbeef",
            Some("a"),
            20.0,
        )
        .await;
        let report = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&report, "lot_claim_scope_conflict")[0].classification,
            "source_claim_conflict"
        );
        assert_eq!(
            issue(&report, "lot_claim_scope_unknown")[0].classification,
            "unverifiable_history"
        );
        assert_eq!(
            issue(&report, "lot_claim_missing")[0].classification,
            "unverifiable_history",
            "historically deleted lots do not establish financial fraud"
        );
        assert_eq!(report.unverifiable_legacy_journals, 1);
        assert!(
            !report
                .findings
                .iter()
                .any(|f| f.record_id == "legacy-sale-journal"),
            "eight-character invoice prefix is not a stable source FK"
        );
    }

    #[tokio::test]
    async fn supplier_return_duplicate_reference_is_a_claim_but_invoice_edit_duplicates_allowed() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO purchase_returns (id,purchase_invoice_id,supplier_id,total_amount,status) VALUES
          ('pr-1','purchase-a',1,50,'completed'),
          ('pr-2','purchase-b',2,30,'completed')",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO supplier_transactions VALUES
          (1,'return','pr-1',1,50),
          (2,'return','pr-1',1,50),
          (3,'return','pr-2',1,30),
          (4,'return','deleted',2,20),
          (5,'invoice','purchase-a',1,100),
          (6,'invoice','purchase-a',1,20)",
        )
        .await
        .unwrap();
        let report = reconcile_snapshot(&mut conn, "owner-b").await.unwrap();
        assert_eq!(
            issue(&report, "supplier_return_reference_duplicate").len(),
            2
        );
        assert_eq!(issue(&report, "supplier_return_supplier_conflict").len(), 1);
        assert_eq!(issue(&report, "supplier_return_reference_missing").len(), 1);
        assert!(
            !report
                .findings
                .iter()
                .any(|f| matches!(f.record_id.as_str(), "5" | "6")),
            "purchase invoice edits legitimately generate repeated type=invoice"
        );
        assert!(report
            .findings
            .iter()
            .filter(|f| f.source_type == "supplier_return_claim")
            .all(|f| f.classification == "source_claim_conflict"));
    }

    #[tokio::test]
    async fn owner_detects_subcent_ledger_imbalance_and_native_header_disagreement() {
        let mut conn = fixture().await;
        journal(
            &mut conn,
            "micro-imbalance",
            "Legacy posting",
            Some("a"),
            20.0,
        )
        .await;
        conn.execute("UPDATE journal_entries SET amount=19.996 WHERE journal_id='micro-imbalance' AND type='credit'")
            .await.unwrap();
        journal(
            &mut conn,
            "micro-header",
            "Purchase invoice [id=purchase-a]",
            Some("a"),
            20.0,
        )
        .await;
        conn.execute("UPDATE daily_journals SET total_amount=20.004 WHERE id='micro-header'")
            .await
            .unwrap();
        let report = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(issue(&report, "journal_unbalanced")
            .iter()
            .any(|f| f.record_id == "micro-imbalance"));
        assert!(issue(&report, "native_journal_total_disagrees_with_debits")
            .iter()
            .any(|f| f.record_id == "micro-header"));
        assert_eq!(report.status, "review_required");
    }

    #[tokio::test]
    async fn owner_flags_fractional_delivery_receivable_without_guessing_an_original_journal() {
        let mut conn = fixture().await;
        conn.execute("INSERT INTO sales_invoices(id,pharmacy_id,user_id,total_amount,payment_method,status) VALUES('old-delivery',NULL,'owner-a',20.004,'delivery','completed')")
            .await.unwrap();
        let report = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        let findings = issue(&report, "delivery_fractional_amount_needs_review");
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].record_id, "old-delivery");
        assert_eq!(findings[0].source_amount, Some(20.004));
        assert_eq!(findings[0].source_pharmacy_id, None);
        assert_eq!(findings[0].journal_pharmacy_id, None);
        assert_eq!(findings[0].classification, "unverifiable_history");
        assert_eq!(report.status, "review_required");
    }

    #[tokio::test]
    async fn native_journal_header_vs_debit_amount_is_exact_but_null_tenant_is_unverified() {
        let mut conn = fixture().await;
        journal(
            &mut conn,
            "j-posted-diff",
            "Purchase invoice [id=purchase-a]",
            Some("a"),
            30.0,
        )
        .await;
        // Keep two valid balanced lines, change only the header's claimed sum.
        conn.execute("UPDATE daily_journals SET total_amount=50 WHERE id='j-posted-diff'")
            .await
            .unwrap();
        journal(
            &mut conn,
            "j-null-pharmacy",
            "Purchase invoice [id=purchase-b]",
            None,
            20.0,
        )
        .await;
        let report = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        let mismatch = issue(&report, "native_journal_total_disagrees_with_debits");
        assert_eq!(mismatch.len(), 1);
        assert_eq!(mismatch[0].record_id, "j-posted-diff");
        assert_eq!(mismatch[0].classification, "explicit_contradiction");
        assert_eq!(mismatch[0].journal_amount, Some(50.0));
        assert_eq!(mismatch[0].debit_total, Some(30.0));
        assert_eq!(mismatch[0].credit_total, Some(30.0));
        let unknown = issue(&report, "purchase_claim_scope_unknown");
        assert_eq!(unknown.len(), 1);
        assert_eq!(unknown[0].record_id, "j-null-pharmacy");
        assert_eq!(unknown[0].classification, "unverifiable_history");
    }

    #[tokio::test]
    async fn finding_overflow_fails_closed_and_rollback_releases_consistent_snapshot() {
        let mut conn = fixture().await;
        conn.execute(
            "WITH RECURSIVE n(x) AS
              (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<200)
           INSERT INTO journal_entries(id,journal_id,account_id,type,amount)
           SELECT x,'deleted',1,'debit',1 FROM n",
        )
        .await
        .unwrap();
        let first_page = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(first_page.max_findings, 200);
        assert_eq!(first_page.findings.len(), 200);
        assert_eq!(first_page.findings[0].record_id, "1");
        assert_eq!(first_page.findings[199].record_id, "200");
        // Exactly 200 findings may be returned. One extra must *reject*
        // instead of silently exposing only page 1 of an incomplete history.
        conn.execute(
            "INSERT INTO journal_entries(id,journal_id,account_id,type,amount)
             VALUES(201,'deleted',1,'debit',1)",
        )
        .await
        .unwrap();
        let error = reconcile_snapshot(&mut conn, "owner-a").await.unwrap_err();
        assert!(error.contains("exceeded 200"), "{error}");
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM journal_entries")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(remaining, 201, "read-only rollback must not modify history");
        assert!(
            reconcile_snapshot(&mut conn, "owner-a").await.is_err(),
            "a prior overflow cannot return a truncated second page"
        );
    }

    #[tokio::test]
    async fn purchase_event_042_protected_journal_contradiction_vs_mutable_invoice_history() {
        let mut conn = fixture().await;
        journal(
            &mut conn,
            "purchase-receipt-j",
            "Native sealed purchase",
            Some("a"),
            10.0,
        )
        .await;
        conn.execute(
            r#"INSERT INTO native_purchase_posting_events
              (event_id,invoice_id,pharmacy_id,actor_id,event_kind,journal_id,
               signed_cents,old_total_cents,new_total_cents,line_snapshot)
             VALUES('event-1','purchase-a','a','owner-a','initial','purchase-receipt-j',
                    1000,0,1000,'[{"inventoryId":"lot-a"}]')"#,
        )
        .await
        .unwrap();
        let healthy = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(!healthy
            .findings
            .iter()
            .any(|f| f.source_type == "purchase_posting_event"));
        conn.execute("UPDATE daily_journals SET total_amount=11 WHERE id='purchase-receipt-j'")
            .await
            .unwrap();
        let corrupt = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        let recorded = issue(&corrupt, "purchase_event_journal_amount_conflict");
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].classification, "explicit_contradiction");
        conn.execute("UPDATE daily_journals SET total_amount=10 WHERE id='purchase-receipt-j'")
            .await
            .unwrap();
        conn.execute("DELETE FROM purchase_invoices WHERE id='purchase-a'")
            .await
            .unwrap();
        let historic = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        let missing = issue(&historic, "purchase_event_current_invoice_unverifiable");
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].classification, "unverifiable_history");
    }

    #[tokio::test]
    async fn sale_and_return_043_reports_detect_journal_tenant_money_and_source_contradictions() {
        let mut conn = fixture().await;
        conn.execute("UPDATE accounts SET code=CASE id WHEN 1 THEN '1.1.1' WHEN 2 THEN '3.1' WHEN 3 THEN '4.1' ELSE '1.1.3' END").await.unwrap();
        conn.execute("UPDATE sales_invoices SET user_id='owner-a',total_amount=10,payment_method='cash',status='completed' WHERE id='sale-a'").await.unwrap();
        conn.execute("INSERT INTO sales_items(id,invoice_id,inventory_id,drug_id,is_negative,cost_price) VALUES(33,'sale-a','lot-a',10,0,0)").await.unwrap();
        journal(
            &mut conn,
            "sale-043-j",
            "Sales invoice sealed",
            Some("a"),
            10.0,
        )
        .await;
        let nonce1 = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO native_sale_cogs_provenance
             (sale_id,request_id,pharmacy_id,actor_id,journal_id,payment_method,
              sale_micros,cogs_micros,line_count,line_snapshot)
             VALUES('sale-a',?,'a','owner-a','sale-043-j','cash',10000000,0,1,'[{}]')",
        )
        .bind(nonce1)
        .execute(&mut conn)
        .await
        .unwrap();

        conn.execute("INSERT INTO returns(id,invoice_id,pharmacy_id,status,user_id,total_refund,refund_method) VALUES('return-043','sale-a','a','approved','owner-a',5,'cash')").await.unwrap();
        conn.execute(
            "INSERT INTO return_items(id,return_id,sale_item_id,total_price) VALUES(44,'return-043',33,5)",
        )
        .await
        .unwrap();
        conn.execute("INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id) VALUES('return-043-j','2026-10-12','Sales return sealed','owner-a',5,'a')").await.unwrap();
        conn.execute("INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES('return-043-j',2,'debit',5),('return-043-j',1,'credit',5)").await.unwrap();
        let nonce2 = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            r#"INSERT INTO native_sale_return_cogs_provenance
             (return_id,request_id,sale_id,pharmacy_id,actor_id,journal_id,refund_method,
              refund_micros,cogs_micros,line_count,line_snapshot)
             VALUES('return-043',?,'sale-a','a','owner-a','return-043-j','cash',5000000,0,1,
               '[{"lineId":44,"originalSaleItemId":33,"originalSaleId":"sale-a","value":5}]')"#,
        )
        .bind(nonce2)
        .execute(&mut conn)
        .await
        .unwrap();
        let healthy = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(!healthy.findings.iter().any(|f| matches!(
            f.source_type,
            "native_sale_cogs" | "native_sale_return_cogs"
        )));
        // A balanced 5-refund journal and original return receipt cannot
        // explain a source line whose actual refunded amount changed to 3.
        conn.execute("UPDATE return_items SET total_price=3 WHERE id=44")
            .await
            .unwrap();
        let source_value_changed = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&source_value_changed, "return_receipt_lines_changed").len(),
            1
        );
        // Even if a locally tampered receipt line is changed to match that
        // understated source, its total cannot explain the sealed refund.
        conn.execute("UPDATE native_sale_return_cogs_provenance SET line_snapshot='[{\"lineId\":44,\"originalSaleItemId\":33,\"originalSaleId\":\"sale-a\",\"value\":3}]' WHERE return_id='return-043'")
            .await.unwrap();
        let collusive_understatement = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&collusive_understatement, "return_receipt_lines_changed").len(),
            1
        );
        conn.execute("UPDATE return_items SET total_price=5 WHERE id=44")
            .await
            .unwrap();
        conn.execute("UPDATE native_sale_return_cogs_provenance SET line_snapshot='[{\"lineId\":44,\"originalSaleItemId\":33,\"originalSaleId\":\"sale-a\",\"value\":5}]' WHERE return_id='return-043'")
            .await.unwrap();

        // A correctly balanced return cannot inherit the immutable source
        // witness for a different original sale line.
        conn.execute("UPDATE native_sale_return_cogs_provenance SET line_snapshot='[{\"lineId\":44,\"originalSaleItemId\":999,\"originalSaleId\":\"sale-a\"}]' WHERE return_id='return-043'")
            .await.unwrap();
        let forged_original_line = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&forged_original_line, "return_receipt_lines_changed").len(),
            1
        );
        conn.execute("UPDATE native_sale_return_cogs_provenance SET line_snapshot='[{\"lineId\":44,\"originalSaleItemId\":33,\"originalSaleId\":\"sale-a\",\"value\":5}]' WHERE return_id='return-043'")
            .await.unwrap();

        conn.execute("UPDATE daily_journals SET pharmacy_id='b' WHERE id='sale-043-j'")
            .await
            .unwrap();
        let forged_scope = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&forged_scope, "sale_receipt_journal_scope_conflict").len(),
            1
        );
        conn.execute("UPDATE daily_journals SET pharmacy_id='a' WHERE id='sale-043-j'")
            .await
            .unwrap();
        conn.execute("UPDATE daily_journals SET total_amount=6 WHERE id='return-043-j'")
            .await
            .unwrap();
        let forged_money = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&forged_money, "return_receipt_amount_unbalanced").len(),
            1
        );
        conn.execute("UPDATE daily_journals SET total_amount=5 WHERE id='return-043-j'")
            .await
            .unwrap();
        conn.execute("UPDATE returns SET status='pending' WHERE id='return-043'")
            .await
            .unwrap();
        let forged_history = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&forged_history, "return_receipt_source_missing_or_changed").len(),
            1
        );
    }

    #[tokio::test]
    async fn legacy_patient_credit_is_reported_as_unverifiable_even_if_tenant_was_filled() {
        let mut conn = fixture().await;
        conn.execute("UPDATE sales_invoices SET patient_id='patient-a',payment_method='credit',status='completed',total_amount=100 WHERE id='sale-a'")
            .await.unwrap();
        conn.execute("INSERT INTO sales_invoices(id,pharmacy_id,patient_id,total_amount,payment_method,status) VALUES('legacy-normalized','local_default','patient-old',60,'credit','completed'),('legacy-null',NULL,'patient-old',30,'credit','completed'),('draft-credit','a','patient-a',10,'credit','draft'),('cash-sale','a','patient-a',15,'cash','completed')")
            .await.unwrap();
        let report = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        let unproven = issue(&report, "legacy_patient_credit_unreceipted");
        assert_eq!(
            unproven.len(),
            3,
            "both inferred and NULL historic tenant sources need review"
        );
        assert!(unproven
            .iter()
            .all(|f| f.classification == "unverifiable_history"));
        assert!(unproven.iter().any(|f| f.record_id == "legacy-normalized"
            && f.source_pharmacy_id.as_deref() == Some("local_default")));
        assert!(unproven
            .iter()
            .any(|f| f.record_id == "legacy-null" && f.source_pharmacy_id.is_none()));
        assert!(!unproven
            .iter()
            .any(|f| f.record_id == "draft-credit" || f.record_id == "cash-sale"));
        assert!(
            reconcile_snapshot(&mut conn, "owner-b").await.is_ok(),
            "owner-only audit is global and must not infer a patient pharmacy"
        );
        assert!(
            reconcile_snapshot(&mut conn, "admin-a").await.is_err(),
            "non-owner audit must remain denied"
        );
        // A deliberately incomplete synthetic receipt is NOT a valid journal
        // and must not be presented as a healthy full owner reconciliation.
        // Verify only the source-coverage query's inclusion rule here; actual
        // 043 receipts and journals have separate structural coverage tests.
        conn.execute("INSERT INTO native_sale_cogs_provenance(sale_id,payment_method) VALUES('sale-a','credit')")
            .await.unwrap();
        let after = sqlx::query(LEGACY_PATIENT_CREDIT_SOURCES)
            .fetch_all(&mut conn)
            .await
            .unwrap();
        assert_eq!(after.len(), 2);
    }

    #[tokio::test]
    async fn owner_reports_unscoped_reserved_native_patient_cash_without_guessing_its_branch() {
        let mut conn = fixture().await;
        conn.execute("INSERT INTO cash_movements(id,pharmacy_id,source_type,target_name,amount) VALUES('cash-missing',NULL,'patient_payment','patient-p',20),('cash-empty','','patient_payment','patient-q',3),('cash-local','local_default','patient_payment','patient-r',4),('cash-other',NULL,'other','patient-p',2)")
            .await.unwrap();
        let findings = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        let unknown = issue(&findings, "native_patient_cash_tenant_unknown");
        assert_eq!(unknown.len(), 2);
        assert!(unknown
            .iter()
            .all(|item| item.classification == "unverifiable_history"));
        assert!(unknown.iter().any(|item| item.record_id == "cash-missing"
            && item.source_pharmacy_id.is_none()
            && item.source_id.as_deref() == Some("patient-p")));
        assert!(unknown.iter().any(|item| item.record_id == "cash-empty"));
        assert!(!unknown
            .iter()
            .any(|item| item.record_id == "cash-local" || item.record_id == "cash-other"));
        assert!(reconcile_snapshot(&mut conn, "admin-a").await.is_err());
        conn.execute(
            "UPDATE cash_movements SET pharmacy_id='local_default' WHERE id='cash-missing'",
        )
        .await
        .unwrap();
        let repaired = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&repaired, "native_patient_cash_tenant_unknown").len(),
            1
        );
    }

    #[tokio::test]
    async fn owner_reports_historic_null_cash_uuid_and_exact_movement_conflicts() {
        let mut conn = fixture().await;
        conn.execute(r#"
          INSERT INTO patient_transactions VALUES
            ('old-cash','patient-old','owner-a','payment',5,'cash','2026-10-11'),
            ('new-cash','patient-new','owner-a','payment',20,'cash','2026-10-11');
          INSERT INTO patient_payment_scope VALUES
            ('old-cash','a','old-cash-nonce'),('new-cash','a','new-cash-nonce');
          INSERT INTO native_patient_financial_journal_receipts
            (source_kind,source_id,pharmacy_id,actor_id,journal_id,amount_cents,money_kind)
            VALUES('payment','new-cash','a','owner-a','cash-journal',2000,'cash');
        "#).await.unwrap();
        let old = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(issue(&old, "legacy_cash_patient_movement_unlinked").len(), 1);
        assert_eq!(issue(&old, "native_patient_cash_witness_unverifiable").len(), 1);
        assert_eq!(issue(&old, "native_patient_cash_witness_unverifiable")[0].classification,
            "unverifiable_history");

        conn.execute(r#"
          INSERT INTO shifts VALUES('cash-shift','a','closed');
          INSERT INTO cash_movements(id,pharmacy_id,user_id,shift_id,type,category,
             source_type,target_name,amount,date)
             VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a','owner-a','cash-shift',
             'receipt','accounts_receivable','patient_payment','patient-new',20,'2026-10-11');
          UPDATE native_patient_financial_journal_receipts
             SET cash_movement_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
             WHERE source_id='new-cash';
        "#).await.unwrap();
        let exact = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(issue(&exact, "native_patient_cash_witness_unverifiable").is_empty());
        assert!(issue(&exact, "native_patient_cash_witness_conflict").is_empty());

        conn.execute("UPDATE cash_movements SET amount=21 WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'")
            .await.unwrap();
        let changed = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(issue(&changed, "native_patient_cash_witness_conflict").len(), 1);
        assert_eq!(issue(&changed, "native_patient_cash_witness_conflict")[0].classification,
            "explicit_contradiction");
    }

    #[tokio::test]
    async fn owner_flags_tampered_latest_054_supplier_balance() {
        let mut conn = fixture().await;
        conn.execute(r#"
          UPDATE purchase_invoices SET status='completed',total_amount=100 WHERE id='purchase-a';
          UPDATE accounts SET code='2.1' WHERE id=1;
          UPDATE accounts SET code='1.1.1' WHERE id=2;
          INSERT INTO suppliers VALUES(1,80);
          INSERT INTO native_purchase_create_requests
            (invoice_id,initial_journal_id,source_total_cents)
            VALUES('purchase-a','original-journal',10000);
          INSERT INTO supplier_transactions(id,type,reference_id,supplier_id,amount)
            VALUES(701,'invoice','purchase-a',1,100),
                  (702,'payment','supplier-payment:receipt-054',1,20);
          INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
            VALUES('supplier-money-054','2026-10-11','Supplier 054','owner-a',20,'a');
          INSERT INTO journal_entries(journal_id,account_id,type,amount)
            VALUES('supplier-money-054',1,'debit',20),('supplier-money-054',2,'credit',20);
          INSERT INTO shifts VALUES('supplier-shift','a','closed');
          INSERT INTO cash_movements(id,pharmacy_id,user_id,shift_id,type,category,
             source_type,target_name,amount,date)
            VALUES('supplier-cash-054','a','owner-a','supplier-shift','disbursement',
             'accounts_payable','supplier_payment','receipt-054',20,'2026-10-11');
          INSERT INTO native_supplier_payment_receipts
            (id,request_id,supplier_id,invoice_id,supplier_transaction_id,pharmacy_id,actor_id,
             amount_cents,payment_method,payment_date,journal_id,cash_movement_id,
             balance_before_cents,balance_after_cents)
            VALUES('receipt-054','request-054',1,'purchase-a',702,'a','owner-a',
             2000,'cash','2026-10-11','supplier-money-054','supplier-cash-054',10000,8000);
        "#).await.unwrap();
        // Isolate the exact SQL used by the owner report: this projection-only
        // fixture intentionally lacks a full 044 original purchase receipt.
        let good = sqlx::query(NATIVE_SUPPLIER_PAYMENT_FINANCIAL)
            .fetch_all(&mut conn).await.unwrap();
        assert!(good.is_empty(), "Valid receipted settlement is not contradictory");
        conn.execute("UPDATE suppliers SET balance=500 WHERE id=1")
            .await.unwrap();
        let changed = sqlx::query(NATIVE_SUPPLIER_PAYMENT_FINANCIAL)
            .fetch_all(&mut conn).await.unwrap();
        assert_eq!(changed.len(), 1,
            "Tampering the settled supplier balance escaped owner source audit");
        assert_eq!(changed[0].try_get::<String,_>("issue_code").unwrap(),
            "supplier_payment_receipt_balance_conflict");
    }

    #[tokio::test]
    async fn owner_separates_historic_notice_cash_from_exact_056_witness_conflicts() {
        let mut conn = fixture().await;
        conn.execute(r#"
          INSERT INTO financial_notices(id,user_id,target_type,target_id,type,amount,date,pharmacy_id)
            VALUES('ph-notice','owner-a','pharmacy',NULL,'debit',12.5,'2026-10-11','a');
          INSERT INTO financial_notice_native_scope VALUES('ph-notice','a','ph-nonce',NULL);
          INSERT INTO native_patient_financial_journal_receipts
            (source_kind,source_id,pharmacy_id,actor_id,journal_id,amount_cents,money_kind)
            VALUES('notice','ph-notice','a','owner-a','ph-journal',1250,'debit');
          INSERT INTO shifts VALUES('ph-notice-shift','a','closed');
          INSERT INTO cash_movements(id,pharmacy_id,user_id,shift_id,type,category,
            source_type,target_name,amount,date)
            VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a','owner-a',
            'ph-notice-shift','receipt','financial_notice','financial_notice',
            'ph-notice',12.5,'2026-10-11');
        "#).await.unwrap();
        let old = sqlx::query(NATIVE_NOTICE_CASH_WITNESS).fetch_all(&mut conn).await.unwrap();
        assert_eq!(old.len(),1);
        assert_eq!(old[0].try_get::<String,_>("issue_code").unwrap(),
            "native_notice_cash_witness_unverifiable");
        assert_eq!(old[0].try_get::<String,_>("classification").unwrap(),
            "unverifiable_history");
        conn.execute(r#"
          INSERT INTO native_financial_notice_cash_witnesses
            VALUES('ph-notice','ph-journal','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                   'ph-notice-shift','a','owner-a',1250);
        "#).await.unwrap();
        assert!(sqlx::query(NATIVE_NOTICE_CASH_WITNESS)
            .fetch_all(&mut conn).await.unwrap().is_empty());
        conn.execute("UPDATE cash_movements SET amount=99 WHERE target_name='ph-notice'")
            .await.unwrap();
        let changed = sqlx::query(NATIVE_NOTICE_CASH_WITNESS)
            .fetch_all(&mut conn).await.unwrap();
        assert_eq!(changed.len(),1);
        assert_eq!(changed[0].try_get::<String,_>("issue_code").unwrap(),
            "native_notice_cash_witness_conflict");
        assert_eq!(changed[0].try_get::<String,_>("classification").unwrap(),
            "explicit_contradiction");
    }

    #[tokio::test]
    async fn owner_separates_v1_unlinked_patient_finance_from_v2_source_journal_contradictions() {
        let mut conn = fixture().await;
        conn.execute(r#"
          INSERT INTO patient_transactions VALUES
            ('v1-bank','patient-old','owner-a','payment',1,'bank','2026-10-11'),
            ('v2-bank','patient-new','owner-a','payment',20,'bank','2026-10-11');
          INSERT INTO patient_payment_scope VALUES
            ('v1-bank','a','old-request'),('v2-bank','a','new-request');
          INSERT INTO financial_notices VALUES
            ('v1-notice','owner-a','customer','patient-old','debit',5,'2026-10-11','a');
          INSERT INTO financial_notice_native_scope VALUES('v1-notice','a','old-notice',NULL);
          UPDATE accounts SET code=CASE id WHEN 1 THEN '1.1.4' WHEN 2 THEN '1.1.2' END;
          INSERT INTO daily_journals VALUES('v2-bank-journal','2026-10-11','Native bank','owner-a',20,'a');
          INSERT INTO journal_entries(journal_id,account_id,type,amount)
             VALUES('v2-bank-journal',1,'debit',20),('v2-bank-journal',2,'credit',20);
          INSERT INTO native_patient_financial_journal_receipts
           (source_kind,source_id,pharmacy_id,actor_id,journal_id,amount_cents,money_kind)
           VALUES('payment','v2-bank','a','owner-a','v2-bank-journal',2000,'bank');
        "#).await.unwrap();
        let inspected = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&inspected, "legacy_bank_patient_journal_unlinked").len(),
            1
        );
        assert_eq!(issue(&inspected, "legacy_notice_journal_unlinked").len(), 1);
        assert!(issue(&inspected, "native_patient_receipt_source_conflict").is_empty());
        assert!(issue(&inspected, "native_patient_receipt_journal_conflict").is_empty());
        assert!(issue(&inspected, "native_patient_receipt_account_unverifiable").is_empty());
        assert!(
            inspected
                .findings
                .iter()
                .filter(|f| matches!(
                    f.issue_code.as_str(),
                    "legacy_bank_patient_journal_unlinked" | "legacy_notice_journal_unlinked"
                ))
                .all(|f| f.classification == "unverifiable_history"
                    && f.journal_pharmacy_id.is_none())
        );
        // This synthetic projection intentionally omits 051's no-update
        // triggers to model malicious external database corruption; actual
        // 051-backed app writes cannot make this edit through SQLite.
        conn.execute("UPDATE patient_transactions SET amount=1 WHERE id='v2-bank'")
            .await
            .unwrap();
        let altered = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&altered, "native_patient_receipt_source_conflict").len(),
            1
        );
        conn.execute("UPDATE patient_transactions SET amount=20 WHERE id='v2-bank'")
            .await
            .unwrap();
        conn.execute("UPDATE daily_journals SET total_amount=15 WHERE id='v2-bank-journal'")
            .await
            .unwrap();
        let corrupt = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&corrupt, "native_patient_receipt_journal_conflict").len(),
            1
        );
        assert!(reconcile_snapshot(&mut conn, "admin-a").await.is_err());
    }

    #[tokio::test]
    async fn native_051_customer_notice_reconciliation_catches_broken_patient_adjustment_mirror() {
        let mut conn = fixture().await;
        conn.execute(r#"
          UPDATE accounts SET code=CASE id WHEN 1 THEN '1.1.2' WHEN 2 THEN '4.2' END;
          INSERT INTO financial_notices VALUES
            ('v2-notice','owner-a','customer','patient-new','debit',12.5,'2026-10-11','a');
          INSERT INTO patient_transactions VALUES
            ('v2-mirror','patient-new','owner-a','adjustment',12.5,NULL,'2026-10-11');
          INSERT INTO financial_notice_native_scope VALUES('v2-notice','a','notice-request','v2-mirror');
          INSERT INTO daily_journals VALUES
            ('v2-notice-journal','2026-10-11','Native notice','owner-a',12.5,'a');
          INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES
            ('v2-notice-journal',1,'debit',12.5),('v2-notice-journal',2,'credit',12.5);
          INSERT INTO native_patient_financial_journal_receipts
           (source_kind,source_id,pharmacy_id,actor_id,journal_id,amount_cents,money_kind) VALUES
            ('notice','v2-notice','a','owner-a','v2-notice-journal',1250,'debit');
        "#).await.unwrap();
        let good = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(issue(&good, "native_patient_receipt_source_conflict").is_empty());
        assert!(issue(&good, "native_patient_receipt_journal_conflict").is_empty());

        // A projection without 051's no-update trigger models independent
        // forensic inspection of tampered or malformed imported history.
        conn.execute("UPDATE patient_transactions SET amount=25 WHERE id='v2-mirror'")
            .await.unwrap();
        let changed_amount = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(issue(&changed_amount, "native_patient_receipt_source_conflict").len(), 1);

        conn.execute("UPDATE patient_transactions SET amount=12.5,patient_id='different-patient' WHERE id='v2-mirror'")
            .await.unwrap();
        let changed_owner = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(issue(&changed_owner, "native_patient_receipt_source_conflict").len(), 1);
    }

    #[tokio::test]
    async fn delivered_045_requires_real_receipt_and_reconciles_cash_fee_journal() {
        let mut conn = fixture().await;
        conn.execute(
            "UPDATE accounts SET code=CASE id WHEN 1 THEN '1.1.1'
                 WHEN 2 THEN '3.1' WHEN 3 THEN '1.1.2' ELSE '3.2' END,
                 type=CASE WHEN id=3 THEN 'asset' WHEN id=4 THEN 'revenue' ELSE type END",
        )
        .await
        .unwrap();
        conn.execute(
            "UPDATE sales_invoices SET user_id='owner-a',total_amount=10,
              payment_method='delivery',status='delivered' WHERE id='sale-a'",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO sales_items(id,invoice_id,inventory_id,drug_id,is_negative,cost_price)
             VALUES(330,'sale-a','lot-a',10,0,0)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
             VALUES ('original-delivery','2026-10-12','Original','owner-a',10,'a'),
                    ('collection','2026-10-12','Collection','owner-a',12,'a')",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO journal_entries(journal_id,account_id,type,amount)
             VALUES('original-delivery',3,'debit',10),('original-delivery',2,'credit',10),
                   ('collection',1,'debit',12),('collection',3,'credit',10),
                   ('collection',4,'credit',2)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO native_sale_cogs_provenance
             (sale_id,request_id,pharmacy_id,actor_id,journal_id,payment_method,
              sale_micros,cogs_micros,line_count,line_snapshot)
             VALUES('sale-a','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    'a','owner-a','original-delivery','delivery',10000000,0,1,'[{}]')",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO shifts(id,pharmacy_id,status) VALUES ('shift-a','a','closed');
             INSERT INTO cash_movements(id,pharmacy_id,user_id,shift_id,type,category,source_type,amount)
             VALUES('cash-1','a','owner-a','shift-a','receipt','delivery','delivery_collection',12);
             INSERT INTO native_delivery_collection_receipts
             (id,request_id,sale_id,pharmacy_id,actor_id,shift_id,journal_id,movement_id,sale_cents,fee_cents,total_cents)
             VALUES('receipt-a','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                   'sale-a','a','owner-a','shift-a','collection','cash-1',1000,200,1200)",
        ).await.unwrap();
        let healthy = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(!healthy.findings.iter().any(|f| matches!(
            f.source_type,
            "native_sale_cogs" | "native_delivery_collection"
        )));
        // A balanced original delivery journal is not proof that its debit
        // actually created an A/R balance collectible by native delivery.
        conn.execute(
            "UPDATE journal_entries SET account_id=1
             WHERE journal_id='original-delivery' AND account_id=3",
        )
        .await
        .unwrap();
        let cash_classified_original = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        let original_finding = issue(
            &cash_classified_original,
            "sale_receipt_funding_account_unverifiable",
        );
        assert_eq!(original_finding.len(), 1);
        assert_eq!(original_finding[0].classification, "unverifiable_history");
        conn.execute(
            "UPDATE journal_entries SET account_id=3
             WHERE journal_id='original-delivery' AND account_id=1",
        )
        .await
        .unwrap();
        // A legitimate shift closure must not reclassify its historical cash event.
        conn.execute("UPDATE daily_journals SET pharmacy_id='b' WHERE id='collection'")
            .await
            .unwrap();
        let wrong_tenant = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&wrong_tenant, "delivery_receipt_journal_scope_conflict").len(),
            1
        );
        conn.execute("UPDATE daily_journals SET pharmacy_id='a' WHERE id='collection'")
            .await
            .unwrap();
        conn.execute(
            "UPDATE journal_entries SET amount=4 WHERE journal_id='collection' AND account_id=4",
        )
        .await
        .unwrap();
        let wrong_amount = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&wrong_amount, "delivery_receipt_amount_unbalanced").len(),
            1
        );
        conn.execute(
            "UPDATE journal_entries SET amount=2 WHERE journal_id='collection' AND account_id=4",
        )
        .await
        .unwrap();
        conn.execute("DELETE FROM native_delivery_collection_receipts WHERE id='receipt-a'")
            .await
            .unwrap();
        let missing_receipt = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&missing_receipt, "sale_receipt_source_missing_or_changed").len(),
            1
        );
    }

    #[tokio::test]
    async fn purchase_request_and_zero_delta_owner_reports_separate_contradiction_from_legacy() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO native_purchase_create_requests
             (request_id,invoice_id,actor_id,pharmacy_id,supplier_id,source_status,source_total_cents,source_line_count)
             VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','purchase-a','owner-a','a',1,'draft',0,1);
             INSERT INTO native_purchase_zero_delta_stock_events
             (event_id,invoice_id,actor_id,pharmacy_id,supplier_id,total_cents,line_count,line_snapshot)
             VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','purchase-a','owner-a','a',1,10000,1,
               '[{\"lineId\":1,\"inventoryId\":\"lot-a\",\"oldReceived\":2,\"newReceived\":3}]')",
        ).await.unwrap();
        let baseline = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(issue(&baseline, "purchase_creation_receipt_snapshot_invalid").is_empty());
        assert_eq!(
            issue(
                &baseline,
                "purchase_zero_delta_receipt_historical_link_unverifiable"
            )
            .len(),
            1
        );
        assert_eq!(
            issue(
                &baseline,
                "purchase_zero_delta_receipt_historical_link_unverifiable"
            )[0]
            .classification,
            "unverifiable_history"
        );
        conn.execute(
            "UPDATE native_purchase_create_requests SET source_status='completed'
             WHERE invoice_id='purchase-a'",
        )
        .await
        .unwrap();
        let incorrect = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&incorrect, "purchase_creation_receipt_snapshot_invalid").len(),
            1
        );
        conn.execute(
            "UPDATE native_purchase_create_requests SET source_status='draft'
             WHERE invoice_id='purchase-a'",
        )
        .await
        .unwrap();
        conn.execute("DELETE FROM purchase_invoices WHERE id='purchase-a'")
            .await
            .unwrap();
        let edited_away = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(
                &edited_away,
                "purchase_creation_receipt_current_source_unverifiable"
            )
            .len(),
            1
        );
        assert_eq!(
            issue(
                &edited_away,
                "purchase_creation_receipt_current_source_unverifiable"
            )[0]
            .classification,
            "unverifiable_history"
        );
    }

    #[tokio::test]
    async fn draft_witness_owner_projection_distinguishes_broken_receipt_from_mutable_source() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO native_purchase_create_requests
             (request_id,invoice_id,actor_id,pharmacy_id,supplier_id,source_status,source_total_cents,source_line_count)
             VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','purchase-a','owner-a','a',1,'draft',0,1);
             INSERT INTO native_purchase_draft_create_witnesses
             (request_id,invoice_id,actor_id,pharmacy_id,original_request_sha256,original_source_sha256)
             VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','purchase-a','owner-a','a',
                    lower(hex(zeroblob(32))),lower(hex(zeroblob(32))))",
        ).await.unwrap();
        let baseline = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(issue(&baseline, "purchase_draft_original_witness_conflict").is_empty());
        conn.execute(
            "UPDATE native_purchase_draft_create_witnesses
             SET original_request_sha256='unsafe'",
        )
        .await
        .unwrap();
        let broken = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&broken, "purchase_draft_original_witness_conflict").len(),
            1
        );
        assert_eq!(
            issue(&broken, "purchase_draft_original_witness_conflict")[0].classification,
            "explicit_contradiction"
        );
        conn.execute(
            "UPDATE native_purchase_draft_create_witnesses
             SET original_request_sha256=lower(hex(zeroblob(32)));
             DELETE FROM purchase_invoices WHERE id='purchase-a'",
        )
        .await
        .unwrap();
        let missing = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&missing, "purchase_draft_current_source_unverifiable").len(),
            1
        );
        assert_eq!(
            issue(&missing, "purchase_draft_current_source_unverifiable")[0].classification,
            "unverifiable_history"
        );
    }

    #[tokio::test]
    async fn owner_detects_missing_supplier_rows_and_distinguishes_legacy_cash_from_forgery() {
        let mut conn = fixture().await;
        for (statement, expected_index) in [
            ("EXPLAIN QUERY PLAN SELECT * FROM supplier_transactions WHERE reference_id='return-a'",
             "idx_native_purchase_return_supplier_reference"),
            ("EXPLAIN QUERY PLAN SELECT * FROM cash_movements WHERE source_type='purchase_return' AND target_name='return-a'",
             "idx_native_purchase_return_cash_source"),
        ] {
            let plans = sqlx::query(statement).fetch_all(&mut conn).await.unwrap();
            assert!(plans.iter().any(|row| row.try_get::<String,_>("detail")
                .unwrap().contains(expected_index)), "Missing indexed source lookup: {expected_index}");
        }
        journal(
            &mut conn,
            "return-journal",
            "Native return receipt",
            Some("a"),
            15.0,
        )
        .await;
        conn.execute(
            "INSERT INTO purchase_returns(id,purchase_invoice_id,supplier_id,total_amount,status,refund_method)
                VALUES('return-a','purchase-a',1,15,'completed','credit');
             INSERT INTO supplier_transactions(id,type,reference_id,supplier_id,amount)
                VALUES(501,'return','return-a',1,15);
            INSERT INTO native_purchase_return_provenance
                (return_id,purchase_invoice_id,pharmacy_id,actor_id,supplier_id,refund_method,amount_cents,journal_id)
                VALUES('return-a','purchase-a','a','owner-a',1,'credit',1500,'return-journal');",
        )
        .await.unwrap();
        let good = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(issue(&good, "purchase_return_receipt_supplier_conflict").is_empty());
        assert!(issue(&good, "purchase_return_receipt_cash_conflict").is_empty());
        assert!(issue(&good, "purchase_return_receipt_journal_conflict").is_empty());
        assert!(reconcile_snapshot(&mut conn, "admin-a").await.is_err());

        conn.execute("UPDATE daily_journals SET pharmacy_id='b' WHERE id='return-journal'")
            .await
            .unwrap();
        let foreign_journal = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&foreign_journal, "purchase_return_receipt_journal_conflict").len(),
            1
        );
        assert_eq!(
            issue(&foreign_journal, "purchase_return_receipt_journal_conflict")[0].classification,
            "explicit_contradiction"
        );
        conn.execute("UPDATE daily_journals SET pharmacy_id='a' WHERE id='return-journal'")
            .await
            .unwrap();

        // A supplier-first scan silently misses a row deleted in its entirety.
        conn.execute("DELETE FROM supplier_transactions WHERE id=501")
            .await
            .unwrap();
        let missing = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&missing, "purchase_return_receipt_supplier_conflict").len(),
            1
        );
        assert_eq!(
            issue(&missing, "purchase_return_receipt_supplier_conflict")[0].classification,
            "source_claim_conflict"
        );

        conn.execute(
            "INSERT INTO supplier_transactions(id,type,reference_id,supplier_id,amount)
                VALUES(501,'return','return-a',1,15);
             UPDATE purchase_returns SET refund_method='cash' WHERE id='return-a';
             UPDATE native_purchase_return_provenance SET refund_method='cash' WHERE return_id='return-a';
             INSERT INTO supplier_transactions(id,type,reference_id,supplier_id,amount)
                VALUES(502,'payment','return-a',1,-15);",
        ).await.unwrap();
        let old_cash = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(
                &old_cash,
                "purchase_return_receipt_cash_legacy_unverifiable"
            )
            .len(),
            1
        );
        assert_eq!(
            issue(
                &old_cash,
                "purchase_return_receipt_cash_legacy_unverifiable"
            )[0]
            .classification,
            "unverifiable_history"
        );

        conn.execute(
            "INSERT INTO cash_movements(id,pharmacy_id,user_id,type,category,source_type,target_name,amount)
                VALUES('cash-a','a','owner-a','receipt','purchase_return','purchase_return','return-a',15)",
        ).await.unwrap();
        assert!(issue(
            &reconcile_snapshot(&mut conn, "owner-a").await.unwrap(),
            "purchase_return_receipt_cash_legacy_unverifiable"
        )
        .is_empty());
        conn.execute("UPDATE cash_movements SET pharmacy_id='b' WHERE id='cash-a'")
            .await
            .unwrap();
        let foreign_cash = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&foreign_cash, "purchase_return_receipt_cash_conflict").len(),
            1
        );
        assert_eq!(
            issue(&foreign_cash, "purchase_return_receipt_cash_conflict")[0].classification,
            "explicit_contradiction"
        );
        conn.execute("UPDATE cash_movements SET pharmacy_id='a' WHERE id='cash-a'")
            .await
            .unwrap();
        conn.execute("UPDATE supplier_transactions SET amount=14 WHERE id=502")
            .await
            .unwrap();
        assert_eq!(
            issue(
                &reconcile_snapshot(&mut conn, "owner-a").await.unwrap(),
                "purchase_return_receipt_supplier_conflict"
            )
            .len(),
            1
        );
        conn.execute("UPDATE supplier_transactions SET amount=-15 WHERE id=502")
            .await
            .unwrap();
        conn.execute("UPDATE purchase_returns SET supplier_id=2 WHERE id='return-a'")
            .await
            .unwrap();
        assert_eq!(
            issue(
                &reconcile_snapshot(&mut conn, "owner-a").await.unwrap(),
                "purchase_return_receipt_source_conflict"
            )
            .len(),
            1
        );
    }

    #[tokio::test]
    async fn negative_settlement_owner_report_rejects_balanced_wrong_amount_entries() {
        let mut conn = fixture().await;
        conn.execute(
            "UPDATE accounts SET code=CASE id WHEN 1 THEN '1.1.1' WHEN 2 THEN '3.1' END;
             UPDATE sales_invoices SET user_id='owner-a',status='completed',
             total_amount=10,payment_method='cash' WHERE id='sale-a'",
        )
        .await
        .unwrap();
        journal(
            &mut conn,
            "original-negative-sale",
            "Completed original sale",
            Some("a"),
            10.0,
        )
        .await;
        conn.execute(
            r#"INSERT INTO native_sale_cogs_provenance
              (sale_id,request_id,pharmacy_id,actor_id,journal_id,payment_method,
               sale_micros,cogs_micros,line_count,line_snapshot)
             VALUES('sale-a','12345678-abcd-4abc-8abc-123456789abc','a','owner-a',
               'original-negative-sale','cash',10000000,0,1,
               '[{"lineId":77,"inventoryId":null,"drugId":10,"quantity":1,"costPerLarge":0,"negative":true}]')"#,
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO sales_items(id,invoice_id,inventory_id,drug_id,is_negative,cost_price)
             VALUES(77,'sale-a','lot-a',10,0,5)",
        )
        .await
        .unwrap();
        journal(
            &mut conn,
            "negative-77",
            "Negative stock settlement",
            Some("a"),
            5.0,
        )
        .await;
        conn.execute(
            "INSERT INTO native_sale_negative_settlement_provenance
             (sale_item_id,sale_id,actor_id,pharmacy_id,inventory_id,
              stock_quantity,unit_cost,cogs_micros,journal_id)
             VALUES(77,'sale-a','owner-a','a','lot-a',1,5,5000000,'negative-77')",
        )
        .await
        .unwrap();
        let good = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(issue(&good, "sale_settlement_journal_conflict").is_empty());
        assert!(issue(&good, "sale_settlement_source_conflict").is_empty());
        assert!(issue(&good, "sale_settlement_cost_conservation_conflict").is_empty());

        // A source-linked journal header with a NULL total is not proof of
        // the immutable COGS amount, even if both journal entries still balance.
        conn.execute("UPDATE daily_journals SET total_amount=NULL WHERE id='negative-77'")
            .await
            .unwrap();
        let missing_header_amount = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&missing_header_amount, "sale_settlement_journal_conflict").len(),
            1
        );
        conn.execute("UPDATE daily_journals SET total_amount=5 WHERE id='negative-77'")
            .await
            .unwrap();

        // A balanced settlement cannot be attributed to an unrelated original
        // sale line merely because the original sale receipt exists.
        conn.execute("UPDATE native_sale_cogs_provenance SET line_snapshot='[{\"lineId\":99,\"inventoryId\":null,\"drugId\":10,\"costPerLarge\":0,\"negative\":true}]' WHERE sale_id='sale-a'")
            .await.unwrap();
        let unrelated_original = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&unrelated_original, "sale_settlement_source_conflict").len(),
            1
        );
        conn.execute("UPDATE native_sale_cogs_provenance SET line_snapshot='[{\"lineId\":77,\"inventoryId\":null,\"drugId\":10,\"quantity\":1,\"costPerLarge\":0,\"negative\":true}]' WHERE sale_id='sale-a'")
            .await.unwrap();

        // Inventory is mutable current evidence: legitimate lot deletion or
        // catalog correction cannot prove an original source contradiction.
        conn.execute("DELETE FROM inventory WHERE id='lot-a'")
            .await
            .unwrap();
        let missing_lot = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(issue(&missing_lot, "sale_settlement_source_conflict").is_empty());
        assert_eq!(
            issue(&missing_lot, "sale_settlement_current_lot_unverifiable").len(),
            1
        );
        conn.execute("INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price) VALUES('lot-a',20,'a',5,3)")
            .await.unwrap();
        let changed_lot = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(issue(&changed_lot, "sale_settlement_source_conflict").is_empty());
        assert_eq!(
            issue(&changed_lot, "sale_settlement_current_lot_unverifiable").len(),
            1
        );
        conn.execute("UPDATE inventory SET drug_id=10 WHERE id='lot-a'")
            .await
            .unwrap();

        // Immutable receipt rows are the sole local historical unit-cost/stock
        // witness. Detect a mathematically inconsistent row independently of
        // its balanced journal (for example after offline data tampering).
        conn.execute("UPDATE native_sale_negative_settlement_provenance SET stock_quantity=0.5 WHERE sale_item_id=77")
            .await.unwrap();
        let wrong_stock = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&wrong_stock, "sale_settlement_cost_conservation_conflict").len(),
            1
        );
        conn.execute("UPDATE native_sale_negative_settlement_provenance SET stock_quantity=1 WHERE sale_item_id=77")
            .await.unwrap();
        conn.execute("UPDATE sales_invoices SET pharmacy_id='b' WHERE id='sale-a'")
            .await
            .unwrap();
        let foreign_sale = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            issue(&foreign_sale, "sale_settlement_source_conflict").len(),
            1
        );
        conn.execute("UPDATE sales_invoices SET pharmacy_id='a' WHERE id='sale-a'")
            .await
            .unwrap();

        // Two entries still balance but are both short of the immutable
        // settlement amount: old logic checked balance/header, not each side.
        conn.execute("UPDATE journal_entries SET amount=3 WHERE journal_id='negative-77'")
            .await
            .unwrap();
        let wrong = reconcile_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(issue(&wrong, "sale_settlement_journal_conflict").len(), 1);
        assert_eq!(
            issue(&wrong, "sale_settlement_journal_conflict")[0].classification,
            "explicit_contradiction"
        );
        assert!(reconcile_snapshot(&mut conn, "admin-a").await.is_err());
    }
}
