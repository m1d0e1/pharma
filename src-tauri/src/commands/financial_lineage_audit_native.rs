//! Owner-only, read-only historical finance provenance diagnostics.
//!
//! This is deliberately not a certification of the ledger: journal_entries
//! have neither a source-invoice FK nor a pharmacy column, accounts are global,
//! and old sales journals identify only an eight-character invoice prefix.
//! Never infer historic scope from a user's current branch or a NULL pharmacy.
use serde::Serialize;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use tauri::{Manager, State};

use super::auth::LocalSessionState;

const MAX_FINDINGS: usize = 200;
const MAX_SCAN_ROWS: i64 = 1_000_000;
const MAX_ID_BYTES: usize = 256;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinancialLineageFinding {
    record_type: &'static str,
    record_id: String,
    source_id: Option<String>,
    issue_code: String,
    // "explicit_conflict" requires contradictory stored FKs/scopes.
    // "review_required" includes missing, NULL and text-only lineage.
    assessment: &'static str,
    record_pharmacy_id: Option<String>,
    source_pharmacy_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinancialLineageAudit {
    status: &'static str,
    findings: Vec<FinancialLineageFinding>,
    unverifiable_journals: i64,
}

async fn require_owner(conn: &mut SqliteConnection, actor: &str) -> Result<(), String> {
    // Re-read the live role and active state *inside* the read transaction.
    // Never accept a user, role, tenant or SQL value from the renderer.
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
        return Err("Financial lineage audit requires an active owner".into());
    }
    Ok(())
}

fn checked_id(input: Option<String>) -> Result<Option<String>, String> {
    match input {
        None => Ok(None),
        Some(id)
            if !id.is_empty() && id.len() <= MAX_ID_BYTES && !id.chars().any(char::is_control) =>
        {
            Ok(Some(id))
        }
        _ => Err("Financial lineage contains invalid identity or pharmacy data".into()),
    }
}

fn decode(
    row: &sqlx::sqlite::SqliteRow,
    record_type: &'static str,
) -> Result<FinancialLineageFinding, String> {
    let record_id = checked_id(row.try_get("record_id").map_err(|e| e.to_string())?)?
        .ok_or("Financial lineage has a missing record ID")?;
    let issue_code: String = row.try_get("issue_code").map_err(|e| e.to_string())?;
    let assessment = match row
        .try_get::<String, _>("assessment")
        .map_err(|e| e.to_string())?
        .as_str()
    {
        "explicit_conflict" => "explicit_conflict",
        "review_required" => "review_required",
        _ => return Err("Unknown financial lineage finding assessment".into()),
    };
    if !matches!(
        issue_code.as_str(),
        "journal_scope_unknown"
            | "purchase_marker_unparseable"
            | "purchase_source_missing"
            | "purchase_source_scope_unknown"
            | "purchase_source_scope_conflict"
            | "entry_journal_missing"
            | "entry_account_missing"
            | "entry_amount_invalid"
            | "journal_lines_missing"
            | "journal_unbalanced"
            | "sales_invoice_missing"
            | "sales_lot_missing"
            | "sales_lot_drug_conflict"
            | "sales_lot_scope_unknown"
            | "sales_lot_scope_conflict"
            | "purchase_invoice_missing"
            | "purchase_lot_missing"
            | "purchase_lot_drug_conflict"
            | "purchase_lot_scope_unknown"
            | "purchase_lot_scope_conflict"
            | "adjustment_lot_missing"
            | "adjustment_lot_scope_unknown"
            | "sale_return_invoice_missing"
            | "sale_return_scope_unknown"
            | "sale_return_scope_conflict"
            | "sale_return_item_parent_missing"
            | "sale_return_item_unlinked"
            | "sale_return_sale_item_missing"
            | "sale_return_sale_item_invoice_conflict"
            | "sale_return_drug_conflict"
            | "sale_return_lot_conflict"
            | "sale_return_lot_unverifiable"
            | "sale_return_quantity_over_sold"
            | "purchase_return_invoice_missing"
            | "purchase_return_invoice_unlinked"
            | "purchase_return_scope_unknown"
            | "purchase_return_supplier_conflict"
            | "purchase_return_item_parent_missing"
            | "purchase_return_item_unlinked"
            | "purchase_return_source_item_missing"
            | "purchase_return_source_invoice_conflict"
            | "purchase_return_drug_conflict"
            | "purchase_return_lot_conflict"
            | "purchase_return_lot_unverifiable"
            | "purchase_return_quantity_over_purchased"
            | "inventory_quantity_or_cost_invalid"
            | "inventory_scope_unknown"
            | "adjustment_recorded_quantity_invalid"
            | "adjustment_recorded_quantity_unknown"
            | "lot_journal_marker_unparseable"
            | "lot_journal_source_missing"
            | "lot_journal_source_scope_unknown"
            | "lot_journal_source_scope_conflict"
            | "purchase_return_journal_source_missing"
            | "purchase_return_journal_scope_unknown"
            | "purchase_return_journal_scope_conflict"
            | "purchase_return_journal_amount_conflict"
            | "purchase_return_journal_duplicate_claim"
            | "supplier_ledger_source_missing"
            | "supplier_ledger_supplier_conflict"
            | "supplier_ledger_return_amount_conflict"
            | "supplier_ledger_return_duplicate_claim"
    ) {
        return Err("Unknown financial lineage issue".into());
    }
    Ok(FinancialLineageFinding {
        record_type,
        record_id,
        source_id: checked_id(row.try_get("source_id").map_err(|e| e.to_string())?)?,
        issue_code,
        assessment,
        record_pharmacy_id: checked_id(
            row.try_get("record_pharmacy_id")
                .map_err(|e| e.to_string())?,
        )?,
        source_pharmacy_id: checked_id(
            row.try_get("source_pharmacy_id")
                .map_err(|e| e.to_string())?,
        )?,
    })
}

// Purchase journals have an explicit *text* marker, unlike legacy sales
// journals. A matching marker is a claim requiring human review, not a
// tamper-proof source FK; even different explicit scopes are review_required.
const JOURNAL_SOURCES: &str = r#"
WITH markers AS (
 SELECT j.id,j.pharmacy_id,j.description,
   CASE
    WHEN substr(j.description,1,21)='Purchase invoice [id='
       AND substr(j.description,-1)=']'
       AND length(j.description) BETWEEN 23 AND 278
      THEN substr(j.description,22,length(j.description)-22)
    WHEN substr(j.description,1,18)='Purchase edit [id='
       AND substr(j.description,-1)=']'
       AND length(j.description) BETWEEN 20 AND 275
      THEN substr(j.description,19,length(j.description)-19)
    ELSE NULL END source_ref
 FROM main.daily_journals j
 WHERE j.pharmacy_id IS NULL OR TRIM(j.pharmacy_id)=''
    OR substr(j.description,1,21)='Purchase invoice [id='
    OR substr(j.description,1,18)='Purchase edit [id='
)
SELECT CAST(j.id AS TEXT) record_id,j.source_ref source_id,
 j.pharmacy_id record_pharmacy_id,p.pharmacy_id source_pharmacy_id,
 CASE
  WHEN j.pharmacy_id IS NULL OR TRIM(j.pharmacy_id)='' THEN 'journal_scope_unknown'
  WHEN j.source_ref IS NULL OR TRIM(j.source_ref)='' THEN 'purchase_marker_unparseable'
  WHEN p.id IS NULL THEN 'purchase_source_missing'
  WHEN p.pharmacy_id IS NULL OR TRIM(p.pharmacy_id)='' THEN 'purchase_source_scope_unknown'
  ELSE 'purchase_source_scope_conflict'
 END issue_code,'review_required' assessment
FROM markers j
LEFT JOIN main.purchase_invoices p ON p.id=j.source_ref
WHERE j.pharmacy_id IS NULL OR TRIM(j.pharmacy_id)=''
 OR j.source_ref IS NULL OR TRIM(j.source_ref)=''
 OR p.id IS NULL OR p.pharmacy_id IS NULL OR TRIM(p.pharmacy_id)=''
 OR j.pharmacy_id<>p.pharmacy_id
ORDER BY j.id COLLATE BINARY LIMIT 201
"#;

const BAD_ENTRIES: &str = r#"
SELECT CAST(e.id AS TEXT) record_id,CAST(e.journal_id AS TEXT) source_id,
 j.pharmacy_id record_pharmacy_id,CAST(NULL AS TEXT) source_pharmacy_id,
 CASE WHEN j.id IS NULL THEN 'entry_journal_missing'
      WHEN a.id IS NULL THEN 'entry_account_missing'
      ELSE 'entry_amount_invalid' END issue_code,
 CASE WHEN j.id IS NULL OR a.id IS NULL THEN 'explicit_conflict'
      ELSE 'review_required' END assessment
FROM main.journal_entries e
LEFT JOIN main.daily_journals j ON j.id=e.journal_id
LEFT JOIN main.accounts a ON a.id=e.account_id
WHERE j.id IS NULL OR a.id IS NULL
 OR typeof(e.amount) NOT IN ('integer','real') OR e.amount<=0
 OR e.amount>1000000000000
 OR LOWER(TRIM(COALESCE(e.type,''))) NOT IN ('debit','credit')
ORDER BY e.id LIMIT 201
"#;

const BAD_JOURNALS: &str = r#"
SELECT CAST(j.id AS TEXT) record_id,CAST(NULL AS TEXT) source_id,
 j.pharmacy_id record_pharmacy_id,CAST(NULL AS TEXT) source_pharmacy_id,
 CASE WHEN COUNT(e.id)=0 THEN 'journal_lines_missing'
      ELSE 'journal_unbalanced' END issue_code,'review_required' assessment
FROM main.daily_journals j
LEFT JOIN main.journal_entries e ON e.journal_id=j.id
GROUP BY j.id
HAVING COUNT(e.id)=0 OR ABS(COALESCE(
 SUM(CASE WHEN LOWER(TRIM(e.type))='debit' THEN e.amount
          WHEN LOWER(TRIM(e.type))='credit' THEN -e.amount
          ELSE 0 END),0))>0.005
ORDER BY j.id COLLATE BINARY LIMIT 201
"#;

// An absent lot ID is not itself corruption: POS negative stock, a cancelled
// purchase or deleted historical batch can legitimately leave NULL links.
// For explicit references, compare the authoritative invoice and lot scope.
const BAD_SALES: &str = r#"
SELECT CAST(si.id AS TEXT) record_id,CAST(si.inventory_id AS TEXT) source_id,
 s.pharmacy_id record_pharmacy_id,i.pharmacy_id source_pharmacy_id,
 CASE WHEN s.id IS NULL THEN 'sales_invoice_missing'
      WHEN i.id IS NULL THEN 'sales_lot_missing'
      WHEN i.drug_id IS NOT si.drug_id THEN 'sales_lot_drug_conflict'
      WHEN s.pharmacy_id IS NULL OR TRIM(s.pharmacy_id)=''
        OR i.pharmacy_id IS NULL OR TRIM(i.pharmacy_id)=''
      THEN 'sales_lot_scope_unknown'
      ELSE 'sales_lot_scope_conflict' END issue_code,
 CASE WHEN s.id IS NOT NULL AND i.id IS NOT NULL
       AND (i.drug_id IS NOT si.drug_id
         OR (TRIM(COALESCE(s.pharmacy_id,''))<>''
         AND TRIM(COALESCE(i.pharmacy_id,''))<>''
         AND s.pharmacy_id<>i.pharmacy_id))
      THEN 'explicit_conflict' ELSE 'review_required' END assessment
FROM main.sales_items si
LEFT JOIN main.sales_invoices s ON s.id=si.invoice_id
LEFT JOIN main.inventory i ON i.id=si.inventory_id
WHERE s.id IS NULL
 OR ((si.inventory_id IS NOT NULL AND TRIM(si.inventory_id)<>'')
   AND (i.id IS NULL OR i.drug_id IS NOT si.drug_id
     OR s.pharmacy_id IS NULL OR TRIM(s.pharmacy_id)=''
     OR i.pharmacy_id IS NULL OR TRIM(i.pharmacy_id)=''
     OR s.pharmacy_id<>i.pharmacy_id))
ORDER BY si.id LIMIT 201
"#;

const BAD_PURCHASES: &str = r#"
SELECT CAST(pi.id AS TEXT) record_id,CAST(pi.inventory_id AS TEXT) source_id,
 p.pharmacy_id record_pharmacy_id,i.pharmacy_id source_pharmacy_id,
 CASE WHEN p.id IS NULL THEN 'purchase_invoice_missing'
      WHEN i.id IS NULL THEN 'purchase_lot_missing'
      WHEN i.drug_id IS NOT pi.drug_id THEN 'purchase_lot_drug_conflict'
      WHEN p.pharmacy_id IS NULL OR TRIM(p.pharmacy_id)=''
        OR i.pharmacy_id IS NULL OR TRIM(i.pharmacy_id)=''
      THEN 'purchase_lot_scope_unknown'
      ELSE 'purchase_lot_scope_conflict' END issue_code,
 CASE WHEN p.id IS NOT NULL AND i.id IS NOT NULL
       AND (i.drug_id IS NOT pi.drug_id
         OR (TRIM(COALESCE(p.pharmacy_id,''))<>''
         AND TRIM(COALESCE(i.pharmacy_id,''))<>''
         AND p.pharmacy_id<>i.pharmacy_id))
      THEN 'explicit_conflict' ELSE 'review_required' END assessment
FROM main.purchase_invoice_items pi
LEFT JOIN main.purchase_invoices p ON p.id=pi.invoice_id
LEFT JOIN main.inventory i ON i.id=pi.inventory_id
WHERE p.id IS NULL
 OR ((pi.inventory_id IS NOT NULL AND TRIM(pi.inventory_id)<>'')
   AND (i.id IS NULL OR i.drug_id IS NOT pi.drug_id
     OR p.pharmacy_id IS NULL OR TRIM(p.pharmacy_id)=''
     OR i.pharmacy_id IS NULL OR TRIM(i.pharmacy_id)=''
     OR p.pharmacy_id<>i.pharmacy_id))
ORDER BY pi.id LIMIT 201
"#;

const BAD_ADJUSTMENTS: &str = r#"
SELECT CAST(sa.id AS TEXT) record_id,CAST(sa.inventory_id AS TEXT) source_id,
 CAST(NULL AS TEXT) record_pharmacy_id,i.pharmacy_id source_pharmacy_id,
 CASE WHEN i.id IS NULL THEN 'adjustment_lot_missing'
      ELSE 'adjustment_lot_scope_unknown' END issue_code,
 'review_required' assessment
FROM main.stock_adjustments sa
LEFT JOIN main.inventory i ON i.id=sa.inventory_id
WHERE i.id IS NULL OR i.pharmacy_id IS NULL OR TRIM(i.pharmacy_id)=''
ORDER BY sa.id LIMIT 201
"#;

// Returns explicitly store the sales-invoice FK and, on compatible databases,
// their own pharmacy. NULL/blank scope can be a migrated historic backfill and
// MUST NOT be attributed to local_default. A conflicting non-NULL FK scope is
// a direct contradiction in persisted records, not a claim about actor intent.
const SALE_RETURN_HEADERS: &str = r#"
SELECT CAST(r.id AS TEXT) record_id,CAST(r.invoice_id AS TEXT) source_id,
       r.pharmacy_id record_pharmacy_id,s.pharmacy_id source_pharmacy_id,
       CASE WHEN s.id IS NULL THEN 'sale_return_invoice_missing'
            WHEN r.pharmacy_id IS NULL OR TRIM(r.pharmacy_id)=''
              OR s.pharmacy_id IS NULL OR TRIM(s.pharmacy_id)=''
            THEN 'sale_return_scope_unknown'
            ELSE 'sale_return_scope_conflict' END issue_code,
       CASE WHEN s.id IS NOT NULL
                 AND TRIM(COALESCE(r.pharmacy_id,''))<>''
                 AND TRIM(COALESCE(s.pharmacy_id,''))<>''
                 AND r.pharmacy_id<>s.pharmacy_id
            THEN 'explicit_conflict' ELSE 'review_required' END assessment
FROM main.returns r LEFT JOIN main.sales_invoices s ON s.id=r.invoice_id
WHERE s.id IS NULL OR r.pharmacy_id IS NULL OR TRIM(r.pharmacy_id)=''
   OR s.pharmacy_id IS NULL OR TRIM(s.pharmacy_id)=''
   OR r.pharmacy_id<>s.pharmacy_id
ORDER BY r.id COLLATE BINARY LIMIT 201
"#;

// sale_item_id is a genuine original-line FK when present. Legacy NULL means
// unprovable lineage even if drug_id or inventory_id happens to match another
// sale; no fuzzy joins or current-user pharmacy inference are permitted.
const SALE_RETURN_LINES: &str = r#"
SELECT CAST(ri.id AS TEXT) record_id,CAST(ri.sale_item_id AS TEXT) source_id,
       r.pharmacy_id record_pharmacy_id,source_invoice.pharmacy_id source_pharmacy_id,
       CASE WHEN r.id IS NULL THEN 'sale_return_item_parent_missing'
            WHEN ri.sale_item_id IS NULL THEN 'sale_return_item_unlinked'
            WHEN si.id IS NULL THEN 'sale_return_sale_item_missing'
            WHEN si.invoice_id IS NOT r.invoice_id THEN 'sale_return_sale_item_invoice_conflict'
            WHEN ri.drug_id IS NOT NULL AND si.drug_id IS NOT NULL
                 AND ri.drug_id<>si.drug_id THEN 'sale_return_drug_conflict'
            WHEN TRIM(COALESCE(ri.inventory_id,''))<>''
                 AND TRIM(COALESCE(si.inventory_id,''))=''
              THEN 'sale_return_lot_unverifiable'
            ELSE 'sale_return_lot_conflict' END issue_code,
       CASE WHEN r.id IS NOT NULL AND si.id IS NOT NULL
                 AND (si.invoice_id IS NOT r.invoice_id
                      OR (ri.drug_id IS NOT NULL AND si.drug_id IS NOT NULL
                          AND ri.drug_id<>si.drug_id)
                      OR (TRIM(COALESCE(ri.inventory_id,''))<>''
                          AND TRIM(COALESCE(si.inventory_id,''))<>''
                          AND ri.inventory_id<>si.inventory_id))
            THEN 'explicit_conflict' ELSE 'review_required' END assessment
FROM main.return_items ri
LEFT JOIN main.returns r ON r.id=ri.return_id
LEFT JOIN main.sales_items si ON si.id=ri.sale_item_id
LEFT JOIN main.sales_invoices source_invoice ON source_invoice.id=si.invoice_id
WHERE r.id IS NULL OR ri.sale_item_id IS NULL OR si.id IS NULL
   OR si.invoice_id IS NOT r.invoice_id
   OR (ri.drug_id IS NOT NULL AND si.drug_id IS NOT NULL AND ri.drug_id<>si.drug_id)
   OR (TRIM(COALESCE(ri.inventory_id,''))<>'' AND
       (TRIM(COALESCE(si.inventory_id,''))='' OR ri.inventory_id<>si.inventory_id))
ORDER BY ri.id LIMIT 201
"#;

// Purchase return headers have NO own pharmacy_id. Only source invoice scope
// is visible; supplier_id does not prove pharmacy ownership.
const PURCHASE_RETURN_HEADERS: &str = r#"
SELECT CAST(pr.id AS TEXT) record_id,CAST(pr.purchase_invoice_id AS TEXT) source_id,
       CAST(NULL AS TEXT) record_pharmacy_id,p.pharmacy_id source_pharmacy_id,
       CASE WHEN pr.purchase_invoice_id IS NULL OR TRIM(pr.purchase_invoice_id)=''
              THEN 'purchase_return_invoice_unlinked'
            WHEN p.id IS NULL THEN 'purchase_return_invoice_missing'
            WHEN p.pharmacy_id IS NULL OR TRIM(p.pharmacy_id)=''
              THEN 'purchase_return_scope_unknown'
            ELSE 'purchase_return_supplier_conflict' END issue_code,
       CASE WHEN p.id IS NOT NULL AND pr.supplier_id IS NOT NULL
                 AND p.supplier_id IS NOT NULL AND pr.supplier_id<>p.supplier_id
            THEN 'explicit_conflict' ELSE 'review_required' END assessment
FROM main.purchase_returns pr
LEFT JOIN main.purchase_invoices p ON p.id=pr.purchase_invoice_id
WHERE pr.purchase_invoice_id IS NULL OR TRIM(pr.purchase_invoice_id)=''
   OR p.id IS NULL OR p.pharmacy_id IS NULL OR TRIM(p.pharmacy_id)=''
   OR (pr.supplier_id IS NOT NULL AND p.supplier_id IS NOT NULL
       AND pr.supplier_id<>p.supplier_id)
ORDER BY pr.id COLLATE BINARY LIMIT 201
"#;

const PURCHASE_RETURN_LINES: &str = r#"
SELECT CAST(pri.id AS TEXT) record_id,
       CAST(pri.purchase_invoice_item_id AS TEXT) source_id,
       return_invoice.pharmacy_id record_pharmacy_id,
       source_invoice.pharmacy_id source_pharmacy_id,
       CASE WHEN pr.id IS NULL THEN 'purchase_return_item_parent_missing'
            WHEN pri.purchase_invoice_item_id IS NULL THEN 'purchase_return_item_unlinked'
            WHEN pii.id IS NULL THEN 'purchase_return_source_item_missing'
            WHEN pr.purchase_invoice_id IS NULL OR TRIM(pr.purchase_invoice_id)=''
              THEN 'purchase_return_invoice_unlinked'
            WHEN pii.invoice_id IS NOT pr.purchase_invoice_id
              THEN 'purchase_return_source_invoice_conflict'
            WHEN pri.drug_id IS NOT NULL AND pii.drug_id IS NOT NULL
                 AND pri.drug_id<>pii.drug_id THEN 'purchase_return_drug_conflict'
            WHEN TRIM(COALESCE(pri.inventory_id,''))<>''
                 AND TRIM(COALESCE(pii.inventory_id,''))=''
              THEN 'purchase_return_lot_unverifiable'
            ELSE 'purchase_return_lot_conflict' END issue_code,
       CASE WHEN pr.id IS NOT NULL AND pii.id IS NOT NULL
                 AND pr.purchase_invoice_id IS NOT NULL
                 AND (pii.invoice_id IS NOT pr.purchase_invoice_id
                      OR (pri.drug_id IS NOT NULL AND pii.drug_id IS NOT NULL
                          AND pri.drug_id<>pii.drug_id)
                      OR (TRIM(COALESCE(pri.inventory_id,''))<>''
                          AND TRIM(COALESCE(pii.inventory_id,''))<>''
                          AND pri.inventory_id<>pii.inventory_id))
            THEN 'explicit_conflict' ELSE 'review_required' END assessment
FROM main.purchase_return_items pri
LEFT JOIN main.purchase_returns pr ON pr.id=pri.purchase_return_id
LEFT JOIN main.purchase_invoice_items pii ON pii.id=pri.purchase_invoice_item_id
LEFT JOIN main.purchase_invoices return_invoice ON return_invoice.id=pr.purchase_invoice_id
LEFT JOIN main.purchase_invoices source_invoice ON source_invoice.id=pii.invoice_id
WHERE pr.id IS NULL OR pri.purchase_invoice_item_id IS NULL OR pii.id IS NULL
   OR pr.purchase_invoice_id IS NULL OR TRIM(pr.purchase_invoice_id)=''
   OR pii.invoice_id IS NOT pr.purchase_invoice_id
   OR (pri.drug_id IS NOT NULL AND pii.drug_id IS NOT NULL
       AND pri.drug_id<>pii.drug_id)
   OR (TRIM(COALESCE(pri.inventory_id,''))<>'' AND
       (TRIM(COALESCE(pii.inventory_id,''))='' OR pri.inventory_id<>pii.inventory_id))
ORDER BY pri.id LIMIT 201
"#;

// ONLY completed/approved returns with the same original invoice + sale item
// are counted. Compare everything in *large* units using positive conversion
// factors snapshotted on the original sale item. Unknown historical unit
// labels, NULL/invalid factors and malformed quantities make a group
// non-provable (excluded), never an assumed 1:1 conversion. This query does
// not attempt to recognize mutable master_drugs labels retrospectively.
const SALES_OVER_RETURN: &str = r#"
WITH validated AS (
 SELECT si.id line_id,s.pharmacy_id,
   CASE WHEN typeof(si.quantity_sold) IN ('real','integer')
              AND si.quantity_sold>0 AND si.quantity_sold<=1000000000000
        THEN si.quantity_sold * (
          CASE
            WHEN LOWER(TRIM(si.unit)) IN ('large','box') THEN 1.0
            WHEN LOWER(TRIM(si.unit)) IN ('medium','strip','شريط')
                 AND typeof(si.large_to_medium) IN ('real','integer')
                 AND si.large_to_medium BETWEEN 1 AND 10000
                 THEN 1.0/si.large_to_medium
            WHEN LOWER(TRIM(si.unit))
                 IN ('small','unit','pill','tablet','capsule','قرص','كبسولة')
                 AND typeof(si.large_to_medium) IN ('real','integer')
                 AND typeof(si.medium_to_small) IN ('real','integer')
                 AND si.large_to_medium BETWEEN 1 AND 10000
                 AND si.medium_to_small BETWEEN 1 AND 10000
                 THEN 1.0/(si.large_to_medium*si.medium_to_small)
            ELSE NULL END)
        ELSE NULL END sold_large,
   CASE WHEN typeof(ri.quantity_returned) IN ('real','integer')
              AND ri.quantity_returned>0 AND ri.quantity_returned<=1000000000000
              AND ri.unit IS NOT NULL AND TRIM(ri.unit)<>''
        THEN ri.quantity_returned * (
          CASE
            WHEN LOWER(TRIM(COALESCE(NULLIF(TRIM(ri.unit),''),si.unit)))
                 IN ('large','box') THEN 1.0
            WHEN LOWER(TRIM(COALESCE(NULLIF(TRIM(ri.unit),''),si.unit)))
                 IN ('medium','strip','شريط')
                 AND typeof(si.large_to_medium) IN ('real','integer')
                 AND si.large_to_medium BETWEEN 1 AND 10000
                 THEN 1.0/si.large_to_medium
            WHEN LOWER(TRIM(COALESCE(NULLIF(TRIM(ri.unit),''),si.unit)))
                 IN ('small','unit','pill','tablet','capsule','قرص','كبسولة')
                 AND typeof(si.large_to_medium) IN ('real','integer')
                 AND typeof(si.medium_to_small) IN ('real','integer')
                 AND si.large_to_medium BETWEEN 1 AND 10000
                 AND si.medium_to_small BETWEEN 1 AND 10000
                 THEN 1.0/(si.large_to_medium*si.medium_to_small)
            ELSE NULL END)
        ELSE NULL END returned_large
 FROM main.return_items ri
 JOIN main.returns r ON r.id=ri.return_id
 JOIN main.sales_items si ON si.id=ri.sale_item_id AND si.invoice_id=r.invoice_id
 JOIN main.sales_invoices s ON s.id=si.invoice_id
 WHERE LOWER(TRIM(COALESCE(r.status,''))) IN ('approved','completed')
)
SELECT CAST(line_id AS TEXT) record_id,CAST(line_id AS TEXT) source_id,
       pharmacy_id record_pharmacy_id,pharmacy_id source_pharmacy_id,
       'sale_return_quantity_over_sold' issue_code,
       'explicit_conflict' assessment
FROM validated
GROUP BY line_id
HAVING COUNT(*)=COUNT(sold_large) AND COUNT(*)=COUNT(returned_large)
   AND MIN(sold_large)>0
   AND SUM(returned_large)>MAX(sold_large)+0.000001
ORDER BY line_id LIMIT 201
"#;

// The purchase workflow's invoice quantity is PAID large units; bonus units
// are not part of the return allowance. Legacy absent snapshot conversion
// data is deliberately not filled using mutable master-drug definitions.
const PURCHASE_OVER_RETURN: &str = r#"
WITH validated AS (
 SELECT pii.id line_id,p.pharmacy_id,
   CASE WHEN typeof(pii.quantity) IN ('real','integer')
               AND pii.quantity>0 AND pii.quantity<=1000000000000
        THEN CAST(pii.quantity AS REAL) ELSE NULL END paid_large,
   CASE WHEN typeof(pri.quantity_returned) IN ('real','integer')
               AND pri.quantity_returned>0 AND pri.quantity_returned<=1000000000000
        THEN pri.quantity_returned * (
          CASE
            WHEN LOWER(TRIM(pri.unit)) IN ('large','box') THEN 1.0
            WHEN LOWER(TRIM(pri.unit)) IN ('medium','strip')
                 AND typeof(pii.strips_per_box) IN ('integer','real')
                 AND pii.strips_per_box BETWEEN 1 AND 10000
                 THEN 1.0/pii.strips_per_box
            WHEN LOWER(TRIM(pri.unit)) IN ('small','unit','pill')
                 AND typeof(pii.strips_per_box) IN ('integer','real')
                 AND typeof(pii.medium_to_small) IN ('integer','real')
                 AND pii.strips_per_box BETWEEN 1 AND 10000
                 AND pii.medium_to_small BETWEEN 1 AND 10000
                 THEN 1.0/(pii.strips_per_box*pii.medium_to_small)
            ELSE NULL END)
        ELSE NULL END returned_large
 FROM main.purchase_return_items pri
 JOIN main.purchase_returns pr ON pr.id=pri.purchase_return_id
 JOIN main.purchase_invoice_items pii
   ON pii.id=pri.purchase_invoice_item_id AND pii.invoice_id=pr.purchase_invoice_id
 JOIN main.purchase_invoices p ON p.id=pii.invoice_id
 WHERE LOWER(TRIM(COALESCE(pr.status,''))) IN ('approved','completed')
)
SELECT CAST(line_id AS TEXT) record_id,CAST(line_id AS TEXT) source_id,
       pharmacy_id record_pharmacy_id,pharmacy_id source_pharmacy_id,
       'purchase_return_quantity_over_purchased' issue_code,
       'explicit_conflict' assessment
FROM validated
GROUP BY line_id
HAVING COUNT(*)=COUNT(paid_large) AND COUNT(*)=COUNT(returned_large)
   AND MIN(paid_large)>0
   AND SUM(returned_large)>MAX(paid_large)+0.000001
ORDER BY line_id LIMIT 201
"#;

// Physical stock and its cost cannot be negative or non-numeric. This is a
// present recorded-state diagnostic, NOT a reconciliation against immutable
// historic stock movement: POS, purchases, returns, adjustments and repairs
// can all change the same lot. NULL tenant is unproven historical ownership,
// never silently reassigned to local_default.
const INVENTORY_RECORDED_STATE: &str = r#"
SELECT CAST(i.id AS TEXT) record_id,CAST(NULL AS TEXT) source_id,
       i.pharmacy_id record_pharmacy_id,CAST(NULL AS TEXT) source_pharmacy_id,
       CASE WHEN i.pharmacy_id IS NULL OR TRIM(i.pharmacy_id)=''
         THEN 'inventory_scope_unknown'
         ELSE 'inventory_quantity_or_cost_invalid' END issue_code,
       CASE WHEN i.pharmacy_id IS NOT NULL AND TRIM(i.pharmacy_id)<>''
         THEN 'explicit_conflict' ELSE 'review_required' END assessment
FROM main.inventory i
WHERE i.quantity IS NULL OR typeof(i.quantity) NOT IN ('integer','real')
 OR i.quantity<0 OR i.quantity>1000000000000
 OR (i.cost_price IS NOT NULL AND
       (typeof(i.cost_price) NOT IN ('integer','real')
        OR i.cost_price<0 OR i.cost_price>1000000000000))
ORDER BY i.id COLLATE BINARY LIMIT 201
"#;

// Historical adjustments have an inventory_id but no immutable pharmacy or
// linked journal ID. Invalid numeric values are contradictory stock records;
// NULL old/new quantities remain review-only (some legacy writers omitted
// the snapshots). Current user's pharmacy never implies historic ownership.
const STOCK_ADJUSTMENT_RECORDED_STATE: &str = r#"
SELECT CAST(sa.id AS TEXT) record_id,CAST(sa.inventory_id AS TEXT) source_id,
       CAST(NULL AS TEXT) record_pharmacy_id,i.pharmacy_id source_pharmacy_id,
       CASE WHEN sa.old_quantity IS NULL OR sa.new_quantity IS NULL
          THEN 'adjustment_recorded_quantity_unknown'
          ELSE 'adjustment_recorded_quantity_invalid' END issue_code,
       CASE WHEN sa.old_quantity IS NULL OR sa.new_quantity IS NULL
          THEN 'review_required' ELSE 'explicit_conflict' END assessment
FROM main.stock_adjustments sa
LEFT JOIN main.inventory i ON i.id=sa.inventory_id
WHERE sa.old_quantity IS NULL OR sa.new_quantity IS NULL
   OR typeof(sa.old_quantity) NOT IN ('integer','real')
   OR typeof(sa.new_quantity) NOT IN ('integer','real')
   OR sa.old_quantity<0 OR sa.new_quantity<0
   OR sa.old_quantity>1000000000000 OR sa.new_quantity>1000000000000
ORDER BY sa.id LIMIT 201
"#;

// Native stock journals use stable namespace IDs, but [lot_id=...] lives in
// mutable free-text description. Even a definite text-vs-current-lot branch
// conflict is *review_required*, never independently proved financial fraud.
const LOT_JOURNAL_SOURCE_CLAIMS: &str = r#"
WITH raw_claims AS (
 SELECT j.id,j.pharmacy_id,
        CASE WHEN instr(COALESCE(j.description,''),'[lot_id=')>0
             THEN substr(j.description,instr(j.description,'[lot_id=')+8)
             ELSE NULL END tail
 FROM main.daily_journals j
 WHERE j.id LIKE 'native-lot-adjust-%'
    OR j.id LIKE 'native-lot-zero-%'
), claims AS (
 SELECT id,pharmacy_id,
        CASE WHEN tail IS NOT NULL AND instr(tail,']')>1
               AND instr(tail,']')<=257
             THEN substr(tail,1,instr(tail,']')-1)
             ELSE NULL END lot_ref
 FROM raw_claims
)
SELECT CAST(j.id AS TEXT) record_id,j.lot_ref source_id,
       j.pharmacy_id record_pharmacy_id,i.pharmacy_id source_pharmacy_id,
       CASE WHEN j.lot_ref IS NULL THEN 'lot_journal_marker_unparseable'
            WHEN i.id IS NULL THEN 'lot_journal_source_missing'
            WHEN j.pharmacy_id IS NULL OR TRIM(j.pharmacy_id)=''
              OR i.pharmacy_id IS NULL OR TRIM(i.pharmacy_id)=''
              THEN 'lot_journal_source_scope_unknown'
            ELSE 'lot_journal_source_scope_conflict' END issue_code,
       'review_required' assessment
FROM claims j LEFT JOIN main.inventory i ON i.id=j.lot_ref
WHERE j.lot_ref IS NULL OR i.id IS NULL
   OR j.pharmacy_id IS NULL OR TRIM(j.pharmacy_id)=''
   OR i.pharmacy_id IS NULL OR TRIM(i.pharmacy_id)=''
   OR j.pharmacy_id<>i.pharmacy_id
ORDER BY j.id COLLATE BINARY LIMIT 201
"#;

// Native purchase-return journal descriptions include the *full* return ID,
// unlike old eight-character sales labels. Still text, not an immutable FK:
// duplicates, amount differences and cross-branch claims require review.
const PURCHASE_RETURN_JOURNAL_CLAIMS: &str = r#"
WITH claims AS (
 SELECT j.id,j.pharmacy_id,j.total_amount,
        NULLIF(substr(j.description,length('Purchase return ')+1),'') claimed_id
 FROM main.daily_journals j
 WHERE substr(j.description,1,length('Purchase return '))='Purchase return '
), matched AS (
 SELECT j.id,j.pharmacy_id,j.total_amount,j.claimed_id,
        pr.id return_id,pr.total_amount source_amount,
        p.pharmacy_id source_scope,
        COUNT(*) OVER (PARTITION BY j.claimed_id) claim_count
 FROM claims j
 LEFT JOIN main.purchase_returns pr ON pr.id=j.claimed_id
 LEFT JOIN main.purchase_invoices p ON p.id=pr.purchase_invoice_id
)
SELECT CAST(j.id AS TEXT) record_id,j.claimed_id source_id,
       j.pharmacy_id record_pharmacy_id,j.source_scope source_pharmacy_id,
       CASE WHEN j.return_id IS NULL THEN 'purchase_return_journal_source_missing'
            WHEN j.claim_count>1 THEN 'purchase_return_journal_duplicate_claim'
            WHEN j.pharmacy_id IS NULL OR TRIM(j.pharmacy_id)=''
              OR j.source_scope IS NULL OR TRIM(j.source_scope)=''
              THEN 'purchase_return_journal_scope_unknown'
            WHEN j.pharmacy_id<>j.source_scope
              THEN 'purchase_return_journal_scope_conflict'
            ELSE 'purchase_return_journal_amount_conflict' END issue_code,
       'review_required' assessment
FROM matched j
WHERE j.return_id IS NULL OR j.claim_count>1
   OR j.pharmacy_id IS NULL OR TRIM(j.pharmacy_id)=''
   OR j.source_scope IS NULL OR TRIM(j.source_scope)=''
   OR j.pharmacy_id<>j.source_scope
   OR (typeof(j.total_amount) IN ('integer','real')
       AND typeof(j.source_amount) IN ('integer','real')
       AND ABS(j.total_amount-j.source_amount)>0.005)
ORDER BY j.id COLLATE BINARY LIMIT 201
"#;

// supplier_transactions.reference_id is the complete original invoice or
// purchase-return ID for native type='invoice'/'return'; it is NOT a real FK,
// and invoice-type transactions may repeat legitimately on purchase edits.
// Only duplicate return-type *claims* warrant review, not duplicate invoices.
// Supplier ledger has no tenant column: never invent a branch from suppliers.
const SUPPLIER_SOURCE_CLAIMS: &str = r#"
WITH source_claims AS (
 SELECT st.id,st.type,st.reference_id,st.supplier_id,st.amount,
        p.id invoice_id,p.supplier_id invoice_supplier,p.pharmacy_id invoice_scope,
        pr.id return_id,pr.supplier_id return_supplier,pr.total_amount return_amount,
        src.pharmacy_id return_scope,
        COUNT(*) OVER (PARTITION BY st.type,st.reference_id) claimed_count
 FROM main.supplier_transactions st
 LEFT JOIN main.purchase_invoices p
   ON st.type='invoice' AND p.id=st.reference_id
 LEFT JOIN main.purchase_returns pr
   ON st.type='return' AND pr.id=st.reference_id
 LEFT JOIN main.purchase_invoices src ON src.id=pr.purchase_invoice_id
 WHERE st.type IN ('invoice','return')
)
SELECT CAST(s.id AS TEXT) record_id,CAST(s.reference_id AS TEXT) source_id,
       CAST(NULL AS TEXT) record_pharmacy_id,
       CASE WHEN s.type='invoice' THEN s.invoice_scope
            ELSE s.return_scope END source_pharmacy_id,
       CASE WHEN (s.type='invoice' AND s.invoice_id IS NULL)
                 OR (s.type='return' AND s.return_id IS NULL)
              THEN 'supplier_ledger_source_missing'
            WHEN (s.type='invoice' AND s.invoice_supplier IS NOT NULL
                  AND s.supplier_id<>s.invoice_supplier)
              OR (s.type='return' AND s.return_supplier IS NOT NULL
                  AND s.supplier_id<>s.return_supplier)
              THEN 'supplier_ledger_supplier_conflict'
            WHEN s.type='return' AND s.claimed_count>1
              THEN 'supplier_ledger_return_duplicate_claim'
            ELSE 'supplier_ledger_return_amount_conflict' END issue_code,
       'review_required' assessment
FROM source_claims s
WHERE (s.type='invoice' AND s.invoice_id IS NULL)
   OR (s.type='return' AND s.return_id IS NULL)
   OR (s.type='invoice' AND s.invoice_supplier IS NOT NULL
       AND s.supplier_id<>s.invoice_supplier)
   OR (s.type='return' AND s.return_supplier IS NOT NULL
       AND s.supplier_id<>s.return_supplier)
   OR (s.type='return' AND s.claimed_count>1)
   OR (s.type='return'
       AND typeof(s.amount) IN ('integer','real')
       AND typeof(s.return_amount) IN ('integer','real')
       AND ABS(s.amount-s.return_amount)>0.005)
ORDER BY s.id LIMIT 201
"#;

// No invariant relates a legacy 'Sales invoice XXXXXXXX' text to a full UUID,
// and shared account IDs do not establish which pharmacy posted the line.
const UNVERIFIABLE: &str = r#"
SELECT COUNT(*) FROM main.daily_journals j
WHERE j.description IS NULL
 OR NOT (
    (substr(j.description,1,21)='Purchase invoice [id='
      AND substr(j.description,-1)=']'
      AND length(j.description) BETWEEN 23 AND 278)
 OR (substr(j.description,1,18)='Purchase edit [id='
      AND substr(j.description,-1)=']'
      AND length(j.description) BETWEEN 20 AND 275)
 )
"#;

async fn assert_bounded(conn: &mut SqliteConnection) -> Result<(), String> {
    for (name, statement) in [
        ("daily_journals", "SELECT COUNT(*) FROM main.daily_journals"),
        (
            "journal_entries",
            "SELECT COUNT(*) FROM main.journal_entries",
        ),
        ("sales_items", "SELECT COUNT(*) FROM main.sales_items"),
        (
            "purchase_invoice_items",
            "SELECT COUNT(*) FROM main.purchase_invoice_items",
        ),
        (
            "stock_adjustments",
            "SELECT COUNT(*) FROM main.stock_adjustments",
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
        ("inventory", "SELECT COUNT(*) FROM main.inventory"),
        (
            "supplier_transactions",
            "SELECT COUNT(*) FROM main.supplier_transactions",
        ),
    ] {
        let count: i64 = sqlx::query_scalar(statement)
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| format!("Missing financial lineage schema {name}: {e}"))?;
        if !(0..=MAX_SCAN_ROWS).contains(&count) {
            return Err(format!("Financial lineage scan too large in {name}"));
        }
    }
    Ok(())
}

async fn audit_snapshot(
    conn: &mut SqliteConnection,
    actor: &str,
) -> Result<FinancialLineageAudit, String> {
    // When called through the IPC, SQLite is opened read_only(true) and BEGIN
    // provides one stable WAL-aware view for authorization and every finding.
    sqlx::query("BEGIN")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    let result = async {
        require_owner(conn, actor).await?;
        assert_bounded(conn).await?;
        let mut findings = Vec::new();
        for (kind, statement) in [
            ("journal", JOURNAL_SOURCES),
            ("journal_entry", BAD_ENTRIES),
            ("journal", BAD_JOURNALS),
            ("sales_item", BAD_SALES),
            ("purchase_item", BAD_PURCHASES),
            ("stock_adjustment", BAD_ADJUSTMENTS),
            ("sale_return", SALE_RETURN_HEADERS),
            ("sale_return_item", SALE_RETURN_LINES),
            ("purchase_return", PURCHASE_RETURN_HEADERS),
            ("purchase_return_item", PURCHASE_RETURN_LINES),
            ("sale_item", SALES_OVER_RETURN),
            ("purchase_item", PURCHASE_OVER_RETURN),
            ("inventory", INVENTORY_RECORDED_STATE),
            ("stock_adjustment", STOCK_ADJUSTMENT_RECORDED_STATE),
            ("journal", LOT_JOURNAL_SOURCE_CLAIMS),
            ("journal", PURCHASE_RETURN_JOURNAL_CLAIMS),
            ("supplier_transaction", SUPPLIER_SOURCE_CLAIMS),
        ] {
            let rows = sqlx::query(statement)
                .fetch_all(&mut *conn)
                .await
                .map_err(|e| format!("Financial lineage schema is not safely auditable: {e}"))?;
            if findings.len() + rows.len() > MAX_FINDINGS {
                return Err("More than 200 financial lineage anomalies; no partial result".into());
            }
            for row in &rows {
                findings.push(decode(row, kind)?);
            }
        }
        let unverifiable_journals: i64 = sqlx::query_scalar(UNVERIFIABLE)
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        Ok(FinancialLineageAudit {
            status: if findings.is_empty() && unverifiable_journals == 0 {
                "limited_no_findings"
            } else {
                "review_required"
            },
            findings,
            unverifiable_journals,
        })
    }
    .await;
    // End read-only snapshot on all paths; a rolled-back read changes nothing.
    let end = sqlx::query("ROLLBACK").execute(&mut *conn).await;
    if let Err(error) = end {
        return Err(format!("Unable to release audit snapshot: {error}"));
    }
    result
}

#[tauri::command]
pub async fn audit_financial_lineage_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<FinancialLineageAudit, String> {
    let actor = session.authorize_session().await?;
    let source = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    let options = SqliteConnectOptions::new()
        .filename(source)
        .read_only(true)
        .create_if_missing(false);
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| format!("Cannot open live database for audit: {e}"))?;
    let result = audit_snapshot(&mut conn, actor.as_deref().ok_or("Login required")?).await;
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
                ('owner-a','owner',1,'a'),
                ('owner-b','owner',1,'b'),
                ('admin-a','admin',1,'a'),
                ('cashier-a','cashier',1,'a'),
                ('inactive-owner','owner',0,'a');
            CREATE TABLE daily_journals(
                id TEXT PRIMARY KEY,date TEXT,description TEXT,
                created_by TEXT,total_amount REAL,pharmacy_id TEXT
            );
            CREATE TABLE accounts(id INTEGER PRIMARY KEY);
            INSERT INTO accounts VALUES(1),(2);
            CREATE TABLE journal_entries(
                id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,
                type TEXT,amount REAL
            );
            CREATE TABLE inventory(
                id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
                quantity REAL DEFAULT 0,cost_price REAL DEFAULT 0
            );
            INSERT INTO inventory VALUES
                ('lot-a',10,'a',5,2),('lot-b',20,'b',8,3),
                ('lot-null',10,NULL,1,2);
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT);
            INSERT INTO sales_invoices VALUES('sale-a','a'),('sale-b','b');
            CREATE TABLE sales_items(
                id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,drug_id INTEGER,
                quantity_sold REAL,unit TEXT,large_to_medium INTEGER,medium_to_small INTEGER
            );
            CREATE TABLE purchase_invoices(
                id TEXT PRIMARY KEY,pharmacy_id TEXT,supplier_id INTEGER
            );
            INSERT INTO purchase_invoices VALUES
                ('purchase-a','a',1),('purchase-b','b',2);
            CREATE TABLE purchase_invoice_items(
                id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,drug_id INTEGER,
                quantity REAL,strips_per_box INTEGER,medium_to_small INTEGER
            );
            CREATE TABLE stock_adjustments(
                id INTEGER PRIMARY KEY,inventory_id TEXT,
                old_quantity REAL,new_quantity REAL,user_id TEXT
            );
            CREATE TABLE returns(
                id TEXT PRIMARY KEY,invoice_id TEXT,pharmacy_id TEXT,status TEXT
            );
            CREATE TABLE return_items(
                id INTEGER PRIMARY KEY,return_id TEXT,sale_item_id INTEGER,
                inventory_id TEXT,drug_id INTEGER,quantity_returned REAL,unit TEXT
            );
            CREATE TABLE purchase_returns(
                id TEXT PRIMARY KEY,purchase_invoice_id TEXT,supplier_id INTEGER,
                status TEXT,total_amount REAL
            );
            CREATE TABLE purchase_return_items(
                id INTEGER PRIMARY KEY,purchase_return_id TEXT,
                purchase_invoice_item_id INTEGER,inventory_id TEXT,drug_id INTEGER,
                quantity_returned REAL,unit TEXT
            );
            CREATE TABLE supplier_transactions(
                id INTEGER PRIMARY KEY,supplier_id INTEGER,type TEXT,
                amount REAL,reference_id TEXT
            );
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    async fn balanced_journal(
        conn: &mut SqliteConnection,
        id: &str,
        description: &str,
        pharmacy: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO daily_journals
                (id,date,description,created_by,total_amount,pharmacy_id)
             VALUES(?,'2026-10-12',?,'owner-a',50,?)",
        )
        .bind(id)
        .bind(description)
        .bind(pharmacy)
        .execute(&mut *conn)
        .await
        .unwrap();
        for (account, direction) in [(1, "debit"), (2, "credit")] {
            sqlx::query(
                "INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES(?,?,?,50)",
            )
            .bind(id)
            .bind(account)
            .bind(direction)
            .execute(&mut *conn)
            .await
            .unwrap();
        }
    }

    fn issues(report: &FinancialLineageAudit) -> Vec<&str> {
        report
            .findings
            .iter()
            .map(|f| f.issue_code.as_str())
            .collect()
    }

    #[tokio::test]
    async fn owner_is_live_and_global_admin_cannot_run_cross_pharmacy_audit() {
        let mut conn = fixture().await;
        for actor in ["owner-a", "owner-b"] {
            assert!(audit_snapshot(&mut conn, actor).await.is_ok(), "{actor}");
        }
        for actor in ["admin-a", "cashier-a", "inactive-owner", "absent"] {
            assert!(audit_snapshot(&mut conn, actor).await.is_err(), "{actor}");
        }
        conn.execute("UPDATE users SET role='admin' WHERE id='owner-a'")
            .await
            .unwrap();
        assert!(
            audit_snapshot(&mut conn, "owner-a").await.is_err(),
            "role must be re-read, not trusted from session cache"
        );
        conn.execute("UPDATE users SET role='owner',is_active=0 WHERE id='owner-a'")
            .await
            .unwrap();
        assert!(
            audit_snapshot(&mut conn, "owner-a").await.is_err(),
            "revoked owner must not get global financial data"
        );
        let role: String = sqlx::query_scalar("SELECT role FROM users WHERE id='owner-a'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            role, "owner",
            "audit and failed authorization never alter DB"
        );
    }

    #[tokio::test]
    async fn purchase_description_scope_conflict_is_detected_but_not_called_proven() {
        let mut conn = fixture().await;
        balanced_journal(
            &mut conn,
            "j-mismatch",
            "Purchase invoice [id=purchase-b]",
            Some("a"),
        )
        .await;
        balanced_journal(
            &mut conn,
            "j-matched",
            "Purchase invoice [id=purchase-b]",
            Some("b"),
        )
        .await;
        balanced_journal(
            &mut conn,
            "j-orphan",
            "Purchase edit [id=not-there]",
            Some("a"),
        )
        .await;
        balanced_journal(
            &mut conn,
            "j-null",
            "Purchase invoice [id=purchase-a]",
            None,
        )
        .await;
        let output = audit_snapshot(&mut conn, "owner-b").await.unwrap();
        assert_eq!(output.status, "review_required");
        assert_eq!(
            output
                .findings
                .iter()
                .find(|f| f.record_id == "j-mismatch")
                .map(|f| (f.issue_code.as_str(), f.assessment)),
            Some(("purchase_source_scope_conflict", "review_required")),
            "description text cannot prove authenticated journal/source provenance"
        );
        assert!(!output.findings.iter().any(|f| f.record_id == "j-matched"));
        assert_eq!(
            output
                .findings
                .iter()
                .find(|f| f.record_id == "j-orphan")
                .map(|f| f.issue_code.as_str()),
            Some("purchase_source_missing")
        );
        assert_eq!(
            output
                .findings
                .iter()
                .find(|f| f.record_id == "j-null")
                .map(|f| f.issue_code.as_str()),
            Some("journal_scope_unknown"),
            "NULL legacy pharmacy must not become local_default"
        );
    }

    #[tokio::test]
    async fn direct_sales_purchase_inventory_links_expose_cross_tenant_and_drug_mismatch() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO sales_items(id,invoice_id,inventory_id,drug_id) VALUES
             (1,'sale-a','lot-b',20),
             (2,'sale-a','lot-a',20),
             (3,'sale-a','lot-null',10),
             (4,'sale-a','lot-a',10),
             (5,'sale-b',NULL,20)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO purchase_invoice_items(id,invoice_id,inventory_id,drug_id) VALUES
             (1,'purchase-b','lot-a',10),
             (2,'purchase-a','lot-a',20),
             (3,'purchase-a','lot-null',10),
             (4,'purchase-a','lot-a',10)",
        )
        .await
        .unwrap();
        let report = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        for code in [
            "sales_lot_scope_conflict",
            "sales_lot_drug_conflict",
            "sales_lot_scope_unknown",
            "purchase_lot_scope_conflict",
            "purchase_lot_drug_conflict",
            "purchase_lot_scope_unknown",
        ] {
            assert!(issues(&report).contains(&code), "{code}");
        }
        assert!(!report.findings.iter().any(|f| f.record_type=="sales_item" &&
            matches!(f.record_id.as_str(),"4" | "5")),
            "valid linked sale or legitimate no-stock sale must not be flagged");
        assert!(!report
            .findings
            .iter()
            .any(|f| f.record_type == "purchase_item" && f.record_id == "4"));
        for finding in report
            .findings
            .iter()
            .filter(|f| f.issue_code.ends_with("scope_conflict"))
        {
            assert_eq!(finding.assessment, "explicit_conflict");
            assert_ne!(finding.record_pharmacy_id, finding.source_pharmacy_id);
        }
        let json = serde_json::to_value(&report).unwrap();
        assert!(json.get("unverifiableJournals").is_some());
        assert!(json["findings"][0].get("recordPharmacyId").is_some());
        assert!(json.get("actorId").is_none());
        assert!(json.get("passwordHash").is_none());
    }

    #[tokio::test]
    async fn orphaned_entries_and_unbalanced_journals_are_evidence_not_mutations() {
        let mut conn = fixture().await;
        balanced_journal(&mut conn, "j-unbalanced", "Manual adjustment", Some("a")).await;
        conn.execute(
            "UPDATE journal_entries SET amount=40
             WHERE journal_id='j-unbalanced' AND type='credit'",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO journal_entries(journal_id,account_id,type,amount)
             VALUES('missing-journal',1,'debit',5)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO journal_entries(journal_id,account_id,type,amount)
             VALUES('j-unbalanced',999,'debit',1)",
        )
        .await
        .unwrap();
        conn.execute("INSERT INTO stock_adjustments(id,inventory_id) VALUES(1,'deleted-lot')")
            .await
            .unwrap();
        let report = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        for issue in [
            "journal_unbalanced",
            "entry_journal_missing",
            "entry_account_missing",
            "adjustment_lot_missing",
        ] {
            assert!(issues(&report).contains(&issue), "{issue}");
        }
        let amount: f64 = sqlx::query_scalar(
            "SELECT amount FROM journal_entries
             WHERE journal_id='j-unbalanced' AND type='credit'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(amount, 40.0, "read-only audit cannot repair accounting");
    }

    #[tokio::test]
    async fn ambiguous_legacy_sales_prefix_and_shared_account_are_not_trusted_lineage() {
        let mut conn = fixture().await;
        balanced_journal(&mut conn, "legacy-j", "Sales invoice deadbeef", Some("a")).await;
        let report = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(report.unverifiable_journals, 1);
        assert_eq!(report.status, "review_required");
        assert!(
            report.findings.is_empty(),
            "8-char sale prefixes are not a unique, immutable invoice link"
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM journal_entries")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn over_200_anomalies_fail_closed_instead_of_partial_disclosure() {
        let mut conn = fixture().await;
        sqlx::query(
            "WITH RECURSIVE n(x) AS (
                SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<201
             )
             INSERT INTO sales_items(id,invoice_id,inventory_id,drug_id)
             SELECT x,'no-such-invoice','lot-a',10 FROM n",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let failure = audit_snapshot(&mut conn, "owner-a").await.unwrap_err();
        assert!(failure.contains("More than 200"), "{failure}");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales_items")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 201);
        // The failed transaction must release its snapshot for another read.
        assert!(audit_snapshot(&mut conn, "owner-a").await.is_err());
    }

    #[tokio::test]
    async fn sale_return_header_proves_explicit_scope_conflict_but_not_legacy_null() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO returns VALUES
             ('r-conflict','sale-b','a','approved'),
             ('r-legacy','sale-a',NULL,'approved'),
             ('r-missing','deleted-sale','a','completed'),
             ('r-good','sale-a','a','completed')",
        )
        .await
        .unwrap();
        let audit = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            audit
                .findings
                .iter()
                .find(|f| f.record_id == "r-conflict")
                .map(|f| (f.issue_code.as_str(), f.assessment)),
            Some(("sale_return_scope_conflict", "explicit_conflict"))
        );
        assert_eq!(
            audit
                .findings
                .iter()
                .find(|f| f.record_id == "r-legacy")
                .map(|f| (f.issue_code.as_str(), f.assessment)),
            Some(("sale_return_scope_unknown", "review_required"))
        );
        assert_eq!(
            audit
                .findings
                .iter()
                .find(|f| f.record_id == "r-missing")
                .map(|f| f.issue_code.as_str()),
            Some("sale_return_invoice_missing")
        );
        assert!(!audit.findings.iter().any(|f| f.record_id == "r-good"));
    }

    #[tokio::test]
    async fn sale_return_item_rejects_cross_invoice_sale_fk_wrong_drug_and_lot() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO sales_items(id,invoice_id,inventory_id,drug_id,quantity_sold,unit)
             VALUES(11,'sale-b','lot-b',20,2,'large'),
                   (12,'sale-a','lot-a',10,2,'large')",
        )
        .await
        .unwrap();
        conn.execute("INSERT INTO returns VALUES('r-a','sale-a','a','approved')")
            .await
            .unwrap();
        conn.execute(
            "INSERT INTO return_items VALUES
             (11,'r-a',11,'lot-b',20,1,'large'),
             (12,'r-a',12,'lot-a',20,1,'large'),
             (13,'r-a',12,'lot-b',10,1,'large'),
             (14,'r-a',NULL,NULL,10,1,'large'),
             (15,'r-a',12,'lot-a',10,1,'large')",
        )
        .await
        .unwrap();
        let report = audit_snapshot(&mut conn, "owner-b").await.unwrap();
        for (id, code, assessment) in [
            (
                "11",
                "sale_return_sale_item_invoice_conflict",
                "explicit_conflict",
            ),
            ("12", "sale_return_drug_conflict", "explicit_conflict"),
            ("13", "sale_return_lot_conflict", "explicit_conflict"),
            ("14", "sale_return_item_unlinked", "review_required"),
        ] {
            let line = report
                .findings
                .iter()
                .find(|f| f.record_type == "sale_return_item" && f.record_id == id)
                .unwrap();
            assert_eq!(
                (line.issue_code.as_str(), line.assessment),
                (code, assessment)
            );
        }
        assert!(!report
            .findings
            .iter()
            .any(|f| f.record_type == "sale_return_item" && f.record_id == "15"));
    }

    #[tokio::test]
    async fn purchase_return_header_is_invoice_scoped_not_current_user_or_supplier_branch() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO purchase_returns(id,purchase_invoice_id,supplier_id,status) VALUES
             ('p-good','purchase-a',1,'completed'),
             ('p-supplier','purchase-b',1,'completed'),
             ('p-legacy',NULL,1,'completed'),
             ('p-missing','deleted-purchase',1,'completed')",
        )
        .await
        .unwrap();
        let report = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(!report.findings.iter().any(|f| f.record_id == "p-good"));
        for (id, code, assessment) in [
            (
                "p-supplier",
                "purchase_return_supplier_conflict",
                "explicit_conflict",
            ),
            (
                "p-legacy",
                "purchase_return_invoice_unlinked",
                "review_required",
            ),
            (
                "p-missing",
                "purchase_return_invoice_missing",
                "review_required",
            ),
        ] {
            let row = report
                .findings
                .iter()
                .find(|f| f.record_type == "purchase_return" && f.record_id == id)
                .unwrap();
            assert_eq!(
                (row.issue_code.as_str(), row.assessment),
                (code, assessment)
            );
        }
    }

    #[tokio::test]
    async fn purchase_return_lines_detect_cross_invoice_wrong_drug_and_reassigned_lot() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO purchase_invoice_items(id,invoice_id,inventory_id,drug_id,quantity)
             VALUES(11,'purchase-b','lot-b',20,5),(12,'purchase-a','lot-a',10,5)",
        )
        .await
        .unwrap();
        conn.execute("INSERT INTO purchase_returns(id,purchase_invoice_id,supplier_id,status) VALUES('pr-a','purchase-a',1,'completed')")
            .await
            .unwrap();
        conn.execute(
            "INSERT INTO purchase_return_items VALUES
             (11,'pr-a',11,'lot-b',20,1,'large'),
             (12,'pr-a',12,'lot-a',20,1,'large'),
             (13,'pr-a',12,'lot-b',10,1,'large'),
             (14,'pr-a',NULL,NULL,10,1,'large'),
             (15,'pr-a',12,'lot-a',10,1,'large')",
        )
        .await
        .unwrap();
        let report = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        for (id, code, assessment) in [
            (
                "11",
                "purchase_return_source_invoice_conflict",
                "explicit_conflict",
            ),
            ("12", "purchase_return_drug_conflict", "explicit_conflict"),
            ("13", "purchase_return_lot_conflict", "explicit_conflict"),
            ("14", "purchase_return_item_unlinked", "review_required"),
        ] {
            let line = report
                .findings
                .iter()
                .find(|f| f.record_type == "purchase_return_item" && f.record_id == id)
                .unwrap();
            assert_eq!(
                (line.issue_code.as_str(), line.assessment),
                (code, assessment)
            );
        }
        assert!(!report
            .findings
            .iter()
            .any(|f| f.record_type == "purchase_return_item" && f.record_id == "15"));
    }

    #[tokio::test]
    async fn provable_sale_overreturn_normalizes_snapshot_units_only_when_finalized() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO sales_items
             (id,invoice_id,inventory_id,drug_id,quantity_sold,unit,large_to_medium,medium_to_small)
             VALUES (40,'sale-a','lot-a',10,1,'large',10,5),
                    (41,'sale-a','lot-a',10,1,'large',10,5),
                    (42,'sale-a','lot-a',10,1,'large',NULL,NULL)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO returns VALUES
             ('r-f1','sale-a','a','completed'),
             ('r-f2','sale-a','a','approved'),
             ('r-pending','sale-a','a','pending')",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO return_items VALUES
             (40,'r-f1',40,'lot-a',10,6,'medium'),
             (41,'r-f2',40,'lot-a',10,5,'medium'),
             (42,'r-pending',41,'lot-a',10,200,'small'),
             (43,'r-f1',42,'lot-a',10,100,'small'),
             (44,'r-f2',41,'lot-a',10,200,NULL)",
        )
        .await
        .unwrap();
        let report = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        let matches: Vec<_> = report
            .findings
            .iter()
            .filter(|f| f.issue_code == "sale_return_quantity_over_sold")
            .collect();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].record_id, "40");
        assert_eq!(matches[0].assessment, "explicit_conflict");
    }

    #[tokio::test]
    async fn purchase_overreturn_uses_paid_quantity_not_bonus_and_does_not_guess_missing_factor() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO purchase_invoice_items
             (id,invoice_id,inventory_id,drug_id,quantity,strips_per_box,medium_to_small)
             VALUES(40,'purchase-a','lot-a',10,2,10,5),
                   (41,'purchase-a','lot-a',10,2,NULL,NULL),
                   (42,'purchase-a','lot-a',10,2,10,5)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO purchase_returns(id,purchase_invoice_id,supplier_id,status) VALUES
             ('p-f1','purchase-a',1,'completed'),
             ('p-f2','purchase-a',1,'approved'),
             ('p-pending','purchase-a',1,'pending')",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO purchase_return_items VALUES
             (40,'p-f1',40,'lot-a',10,11,'medium'),
             (41,'p-f2',40,'lot-a',10,10,'medium'),
             (42,'p-f1',41,'lot-a',10,300,'small'),
             (43,'p-pending',42,'lot-a',10,300,'small')",
        )
        .await
        .unwrap();
        let report = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        let matches: Vec<_> = report
            .findings
            .iter()
            .filter(|f| f.issue_code == "purchase_return_quantity_over_purchased")
            .collect();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].record_id, "40");
        assert_eq!(matches[0].assessment, "explicit_conflict");
    }

    #[tokio::test]
    async fn return_finding_overflow_rolls_back_snapshot_without_mutating_history() {
        let mut conn = fixture().await;
        conn.execute(
            "WITH RECURSIVE n(x) AS
              (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<201)
             INSERT INTO return_items(id,return_id,sale_item_id)
             SELECT x,'missing-return',NULL FROM n",
        )
        .await
        .unwrap();
        let error = audit_snapshot(&mut conn, "owner-a").await.unwrap_err();
        assert!(error.contains("More than 200"), "{error}");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM return_items")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            201
        );
    }

    #[tokio::test]
    async fn invalid_inventory_cost_and_quantity_are_recorded_defects_not_master_scope() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price) VALUES
             ('bad-qty',10,'a',-2,5),
             ('bad-cost',20,'b',3,-1),
             ('bad-type',10,'a','not-a-number',5),
             ('uncertain-cost',10,NULL,-1,4)",
        )
        .await
        .unwrap();
        let report = audit_snapshot(&mut conn, "owner-b").await.unwrap();
        for id in ["bad-qty", "bad-cost", "bad-type"] {
            let row = report
                .findings
                .iter()
                .find(|f| f.record_type == "inventory" && f.record_id == id)
                .unwrap();
            assert_eq!(row.issue_code, "inventory_quantity_or_cost_invalid");
            assert_eq!(row.assessment, "explicit_conflict");
        }
        let legacy = report
            .findings
            .iter()
            .find(|f| f.record_type == "inventory" && f.record_id == "uncertain-cost")
            .unwrap();
        assert_eq!(legacy.issue_code, "inventory_scope_unknown");
        assert_eq!(legacy.assessment, "review_required");
        assert!(
            !report
                .findings
                .iter()
                .any(|f| f.record_type == "inventory" && f.record_id == "lot-null"),
            "NULL tenant alone isn't a new valuation defect"
        );
        let remaining: f64 =
            sqlx::query_scalar("SELECT quantity FROM inventory WHERE id='bad-qty'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(remaining, -2.0, "audit never repairs source quantity");
    }

    #[tokio::test]
    async fn historic_stock_adjustment_invalid_and_missing_snapshots_not_falsely_tenant_bound() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO stock_adjustments(id,inventory_id,old_quantity,new_quantity,user_id)
             VALUES (1,'lot-a',10,-2,'owner-b'),
                    (2,'lot-b',NULL,4,'owner-a'),
                    (3,'lot-null',2,3,'owner-b'),
                    (4,'lot-a','unknown',1,'owner-b')",
        )
        .await
        .unwrap();
        let report = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        for id in ["1", "4"] {
            let row = report
                .findings
                .iter()
                .find(|f| {
                    f.record_type == "stock_adjustment"
                        && f.record_id == id
                        && f.issue_code == "adjustment_recorded_quantity_invalid"
                })
                .unwrap();
            assert_eq!(row.assessment, "explicit_conflict");
        }
        assert_eq!(
            report
                .findings
                .iter()
                .find(|f| f.record_type == "stock_adjustment"
                    && f.record_id == "2"
                    && f.issue_code == "adjustment_recorded_quantity_unknown")
                .map(|f| f.assessment),
            Some("review_required")
        );
        assert!(
            !report
                .findings
                .iter()
                .any(|f| f.record_type == "stock_adjustment"
                    && f.record_id == "3"
                    && matches!(
                        f.issue_code.as_str(),
                        "adjustment_recorded_quantity_invalid"
                            | "adjustment_recorded_quantity_unknown"
                    )),
            "valid recorded quantities must not be labeled invalid or missing"
        );
        assert_eq!(
            report
                .findings
                .iter()
                .find(|f| f.record_type == "stock_adjustment"
                    && f.record_id == "3"
                    && f.issue_code == "adjustment_lot_scope_unknown")
                .map(|f| f.assessment),
            Some("review_required"),
            "legacy NULL lot pharmacy remains an ambiguous scope finding"
        );
    }

    #[tokio::test]
    async fn native_lot_journal_full_id_is_only_a_text_claim_even_across_pharmacies() {
        let mut conn = fixture().await;
        balanced_journal(
            &mut conn,
            "native-lot-adjust-conflict",
            "تسوية مخزون [lot_id=lot-b] old_qty=5",
            "a".into(),
        )
        .await;
        balanced_journal(
            &mut conn,
            "native-lot-zero-missing",
            "تصفير مخزون [lot_id=deleted-lot]",
            "a".into(),
        )
        .await;
        balanced_journal(
            &mut conn,
            "native-lot-adjust-null",
            "تسوية مخزون [lot_id=lot-null]",
            "a".into(),
        )
        .await;
        balanced_journal(
            &mut conn,
            "native-lot-adjust-corrupt",
            "مخزون غير معروف",
            "a".into(),
        )
        .await;
        balanced_journal(
            &mut conn,
            "native-lot-zero-good",
            "تصفير مخزون [lot_id=lot-a]",
            "a".into(),
        )
        .await;
        let report = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        for (id, issue) in [
            (
                "native-lot-adjust-conflict",
                "lot_journal_source_scope_conflict",
            ),
            ("native-lot-zero-missing", "lot_journal_source_missing"),
            ("native-lot-adjust-null", "lot_journal_source_scope_unknown"),
            (
                "native-lot-adjust-corrupt",
                "lot_journal_marker_unparseable",
            ),
        ] {
            let found = report
                .findings
                .iter()
                .find(|f| f.record_type == "journal" && f.record_id == id && f.issue_code == issue)
                .unwrap();
            assert_eq!(found.assessment, "review_required");
        }
        assert!(!report
            .findings
            .iter()
            .any(|f| f.record_id == "native-lot-zero-good"));
    }

    #[tokio::test]
    async fn purchase_return_journal_claims_flag_duplicate_branch_and_amount_without_certifying() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO purchase_returns
              (id,purchase_invoice_id,supplier_id,status,total_amount) VALUES
              ('pr-good','purchase-a',1,'completed',50),
              ('pr-b','purchase-b',2,'completed',50)",
        )
        .await
        .unwrap();
        balanced_journal(
            &mut conn,
            "j-return-wrong-scope",
            "Purchase return pr-b",
            Some("a"),
        )
        .await;
        balanced_journal(
            &mut conn,
            "j-return-first",
            "Purchase return pr-good",
            Some("a"),
        )
        .await;
        balanced_journal(
            &mut conn,
            "j-return-second",
            "Purchase return pr-good",
            Some("a"),
        )
        .await;
        balanced_journal(
            &mut conn,
            "j-return-missing",
            "Purchase return deleted",
            Some("a"),
        )
        .await;
        balanced_journal(&mut conn, "j-return-null", "Purchase return pr-b", None).await;
        let report = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        assert!(report
            .findings
            .iter()
            .any(|f| f.record_id == "j-return-first"
                && f.issue_code == "purchase_return_journal_duplicate_claim"));
        assert!(report
            .findings
            .iter()
            .any(|f| f.record_id == "j-return-second"
                && f.issue_code == "purchase_return_journal_duplicate_claim"));
        // j-return-wrong-scope and j-return-null claim the same pr-b;
        // their duplicate claim takes priority and still means review-only.
        assert!(report
            .findings
            .iter()
            .any(|f| f.record_id == "j-return-wrong-scope"
                && f.issue_code == "purchase_return_journal_duplicate_claim"));
        assert!(report
            .findings
            .iter()
            .any(|f| f.record_id == "j-return-missing"
                && f.issue_code == "purchase_return_journal_source_missing"));
        assert!(report
            .findings
            .iter()
            .filter(|f| f.issue_code.starts_with("purchase_return_journal"))
            .all(|f| f.assessment == "review_required"));
    }

    #[tokio::test]
    async fn supplier_reference_can_flag_duplicate_return_without_false_invoice_edit_duplicate() {
        let mut conn = fixture().await;
        conn.execute(
            "INSERT INTO purchase_returns
               (id,purchase_invoice_id,supplier_id,status,total_amount)
             VALUES('pr-1','purchase-a',1,'completed',20),
                   ('pr-2','purchase-b',2,'completed',30)",
        )
        .await
        .unwrap();
        conn.execute(
            "INSERT INTO supplier_transactions
              (id,supplier_id,type,amount,reference_id) VALUES
              (1,1,'return',20,'pr-1'),
              (2,1,'return',20,'pr-1'),
              (3,1,'invoice',100,'purchase-a'),
              (4,1,'invoice',20,'purchase-a'),
              (5,1,'return',30,'pr-2'),
              (6,1,'return',2,'deleted-return')",
        )
        .await
        .unwrap();
        let report = audit_snapshot(&mut conn, "owner-a").await.unwrap();
        assert_eq!(
            report
                .findings
                .iter()
                .find(|f| f.record_type == "supplier_transaction" && f.record_id == "1")
                .map(|f| f.issue_code.as_str()),
            Some("supplier_ledger_return_duplicate_claim")
        );
        assert!(report
            .findings
            .iter()
            .any(|f| f.record_type == "supplier_transaction"
                && f.record_id == "5"
                && f.issue_code == "supplier_ledger_supplier_conflict"));
        assert!(report
            .findings
            .iter()
            .any(|f| f.record_type == "supplier_transaction"
                && f.record_id == "6"
                && f.issue_code == "supplier_ledger_source_missing"));
        assert!(
            !report
                .findings
                .iter()
                .any(|f| f.record_type == "supplier_transaction"
                    && matches!(f.record_id.as_str(), "3" | "4")),
            "purchase invoice edit legitimately adds another supplier entry"
        );
        assert!(report
            .findings
            .iter()
            .filter(|f| f.record_type == "supplier_transaction")
            .all(|f| f.assessment == "review_required"));
    }

    #[tokio::test]
    async fn new_stock_anomaly_overflow_refuses_partial_report_and_releases_read_transaction() {
        let mut conn = fixture().await;
        conn.execute(
            "WITH RECURSIVE n(x) AS
              (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<201)
             INSERT INTO stock_adjustments(id,inventory_id,old_quantity,new_quantity)
             SELECT x,'lot-a',-x,x FROM n",
        )
        .await
        .unwrap();
        let failure = audit_snapshot(&mut conn, "owner-a").await.unwrap_err();
        assert!(failure.contains("More than 200"), "{failure}");
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM stock_adjustments")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            n, 201,
            "read-only failed scan never truncates or repairs data"
        );
    }
}
