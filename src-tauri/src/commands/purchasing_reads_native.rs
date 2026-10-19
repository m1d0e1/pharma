//! Fixed supplier and purchasing read projections. Every query derives its
//! actor and tenant from the authenticated database user, never renderer SQL.
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::time::Duration;

use super::critical::active_generic_actor;
use super::guarded_read::{fetch_scoped_limited, reset_cancelled_read_state, ReadLimits};
use super::permission_policy::user_has_permission;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PurchaseReportFilters {
    start_date: Option<String>,
    end_date: Option<String>,
    user_id: Option<String>,
    payment_method: Option<String>,
    supplier_id: Option<i64>,
    status: Option<String>,
    invoice_number: Option<String>,
    drug_name: Option<String>,
}

fn valid_id(value: Option<&str>) -> Result<&str, String> {
    let value = value.ok_or("Record ID required")?;
    if value.is_empty() || value.len() > 256 || value.contains('\0') {
        return Err("Invalid purchasing record identifier".into());
    }
    Ok(value)
}

fn bounded_search(value: Option<&str>) -> Result<Option<String>, String> {
    let term = value.map(str::trim).filter(|s| !s.is_empty());
    if term.is_some_and(|s| s.len() > 128 || s.contains('\0')) {
        return Err("Purchasing search term is invalid".into());
    }
    Ok(term.map(|s| format!("%{s}%")))
}

fn read_limits(max_rows: usize) -> ReadLimits {
    ReadLimits {
        max_duration: Duration::from_secs(4),
        max_rows,
        max_bytes: 2 * 1024 * 1024,
    }
}

// A supplier return can reduce an invoice's report value only when the native
// immutable parent, line and posting journal witnesses independently reconcile
// against the explicitly tenant-owned original purchase. Legacy returns without
// this complete receipt are never assigned an amount or silently counted as 0.
const VERIFIED_REPORT_PURCHASE_RETURNS: &str = r#"
WITH verified AS (
 SELECT p.return_id,p.purchase_invoice_id,p.amount_cents
 FROM main.native_purchase_return_provenance p
 JOIN main.purchase_returns r ON r.id=p.return_id
   AND r.purchase_invoice_id=p.purchase_invoice_id
   AND CAST(r.user_id AS TEXT)=p.actor_id
   AND r.supplier_id=p.supplier_id
   AND r.refund_method=p.refund_method
   AND LOWER(TRIM(r.status))='completed'
   AND ABS(r.total_amount*100-p.amount_cents)<0.0001
 JOIN main.purchase_invoices i ON i.id=p.purchase_invoice_id
   AND i.pharmacy_id=p.pharmacy_id AND i.supplier_id=p.supplier_id
   AND i.status='completed' AND typeof(i.total_amount) IN ('integer','real')
   AND i.total_amount>=0
   AND ABS(i.total_amount*100-ROUND(i.total_amount*100))<0.001
   AND (SELECT COUNT(*) FROM main.native_purchase_posting_events initial
        WHERE initial.invoice_id=i.id AND initial.event_kind='initial'
          AND initial.pharmacy_id=i.pharmacy_id AND initial.supplier_id=i.supplier_id)=1
   AND (SELECT SUM(post.signed_cents) FROM main.native_purchase_posting_events post
        WHERE post.invoice_id=i.id)=CAST(ROUND(i.total_amount*100) AS INTEGER)
   AND NOT EXISTS (
     SELECT 1 FROM main.native_purchase_posting_events post
     WHERE post.invoice_id=i.id AND
       (post.pharmacy_id<>i.pharmacy_id OR post.supplier_id<>i.supplier_id)
   )
 JOIN main.users actor ON CAST(actor.id AS TEXT)=p.actor_id
   AND actor.pharmacy_id=p.pharmacy_id
 JOIN main.daily_journals journal ON journal.id=p.journal_id
   AND journal.pharmacy_id=p.pharmacy_id
   AND CAST(journal.created_by AS TEXT)=p.actor_id
   AND ABS(journal.total_amount*100-p.amount_cents)<0.0001
 WHERE p.pharmacy_id=? AND typeof(p.amount_cents)='integer' AND p.amount_cents>0
   AND p.line_count BETWEEN 1 AND 200
   AND p.line_count=(SELECT COUNT(*) FROM main.purchase_return_items ri
                       WHERE ri.purchase_return_id=p.return_id)
   AND p.line_count=(SELECT COUNT(*) FROM main.native_purchase_return_line_provenance lp
                       WHERE lp.return_id=p.return_id)
   AND ABS((SELECT SUM(lp.refund_value)*100
            FROM main.native_purchase_return_line_provenance lp
            WHERE lp.return_id=p.return_id)-p.amount_cents)<0.0001
   AND EXISTS (
     SELECT 1 FROM main.journal_entries entry
     JOIN main.accounts account ON account.id=entry.account_id
     WHERE entry.journal_id=p.journal_id
     GROUP BY entry.journal_id
     HAVING COUNT(*)=2
       AND SUM(CASE WHEN entry.type='debit' AND
            ((p.refund_method='credit' AND account.code='2.1') OR
             (p.refund_method='cash' AND account.code='1.1.1'))
            THEN 1 ELSE 0 END)=1
       AND SUM(CASE WHEN entry.type='credit' AND account.code='1.1.3'
            THEN 1 ELSE 0 END)=1
       AND SUM(CASE WHEN typeof(entry.amount) IN ('integer','real')
            AND ABS(entry.amount*100-p.amount_cents)<0.0001
            THEN 1 ELSE 0 END)=2
   )
   AND NOT EXISTS (
     SELECT 1 FROM main.native_purchase_return_line_provenance lp
     LEFT JOIN main.purchase_return_items ri ON ri.id=lp.return_item_id
       AND ri.purchase_return_id=p.return_id
     LEFT JOIN main.purchase_invoice_items pi ON pi.id=lp.purchase_invoice_item_id
       AND pi.invoice_id=p.purchase_invoice_id
     LEFT JOIN main.inventory lot ON lot.id=lp.inventory_id
       AND lot.pharmacy_id=p.pharmacy_id
     WHERE lp.return_id=p.return_id AND
       (ri.id IS NULL OR pi.id IS NULL OR lot.id IS NULL OR
        ri.inventory_id IS NULL OR pi.inventory_id IS NULL OR
        ri.drug_id IS NULL OR pi.drug_id IS NULL OR lot.drug_id IS NULL OR
        typeof(ri.quantity_returned) NOT IN ('integer','real') OR
        typeof(ri.total_price) NOT IN ('integer','real') OR
        typeof(lp.quantity_returned) NOT IN ('integer','real') OR
        typeof(lp.stock_quantity) NOT IN ('integer','real') OR
        typeof(lp.refund_value) NOT IN ('integer','real') OR
        ri.purchase_invoice_item_id<>lp.purchase_invoice_item_id OR
        ri.inventory_id<>lp.inventory_id OR
        pi.inventory_id<>lp.inventory_id OR
        ri.drug_id<>pi.drug_id OR lot.drug_id<>pi.drug_id OR
        lp.quantity_returned<=0 OR lp.stock_quantity<=0 OR
        lp.refund_value<0 OR
        ABS(lp.quantity_returned-ri.quantity_returned)>0.000000001 OR
        ABS(lp.refund_value-ri.total_price)>0.00001)
   )
)
"#;

async fn read_purchase_report_return_adjustments(
    conn: &mut SqliteConnection,
    pharmacy: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    // A tenant-owned, finalized or pending legacy return without proof means
    // the report cannot certify the net figure. Detect before page/filtering.
    let check = format!("{VERIFIED_REPORT_PURCHASE_RETURNS}
      SELECT EXISTS (
        SELECT 1 FROM main.purchase_returns r
        JOIN main.purchase_invoices i ON i.id=r.purchase_invoice_id
        WHERE i.pharmacy_id=? AND NOT EXISTS (
          SELECT 1 FROM verified v WHERE v.return_id=r.id
        )
        UNION ALL
        SELECT 1 FROM main.native_purchase_return_provenance receipt
        WHERE receipt.pharmacy_id=? AND NOT EXISTS (
          SELECT 1 FROM verified v WHERE v.return_id=receipt.return_id
        )
      )");
    let unverified: i64 = sqlx::query_scalar(&check)
        .bind(pharmacy).bind(pharmacy).bind(pharmacy)
        .fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
    if unverified != 0 {
        return Err("Unverified tenant-owned purchase return; net purchasing report unavailable".into());
    }
    let sql = format!("{VERIFIED_REPORT_PURCHASE_RETURNS}
      SELECT return_id,purchase_invoice_id,amount_cents FROM verified
      ORDER BY return_id LIMIT ? OFFSET ?");
    fetch_scoped_limited(
        conn,&sql,vec![json!(pharmacy),json!(limit),json!(offset)],
        read_limits(limit as usize),
    ).await
}

/// Historical suppliers have no pharmacy_id. Only show a directory entry when
/// an explicitly tenant-owned purchase invoice proves this tenant has used it.
/// A supplier's global balance cannot be certified from that association.
pub(super) async fn run_purchasing_read(
    conn: &mut SqliteConnection,
    actor_id: &str,
    key: &str,
    record_id: Option<&str>,
    search: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    if limit == 0 || limit > 200 || offset > 50_000 {
        return Err("Purchasing read requires a bounded page".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy) = active_generic_actor(conn, actor_id).await?;
    // The local_default alias does not prove ownership of historical
    // NULL-pharmacy invoice/return rows. Require independent ownership
    // reconciliation before allowing those legacy users native reads.
    if pharmacy == "local_default" {
        return Err("Legacy purchasing ownership needs independent tenant verification".into());
    }
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let can_purchases = user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_view_purchases",
        false,
    );
    let can_report = user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "rep_can_view_purchases",
        false,
    );
    let can_suppliers = user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_view_suppliers",
        false,
    );
    let is_statement = key == "purchases.supplier_transactions";
    if (key == "purchases.suppliers_list" && !(can_suppliers || can_purchases))
        || (key == "purchases.suppliers_report" && !(can_purchases || can_report))
        || (is_statement && !(can_suppliers || can_purchases))
        || (!matches!(
            key,
            "purchases.suppliers_list" | "purchases.suppliers_report"
        ) && !is_statement
            && !can_purchases
            && !(can_report
                && matches!(
                    key,
                    "purchases.reports"
                        | "purchases.report_return_adjustments"
                        | "purchases.detail_header"
                        | "purchases.detail_items"
                        | "purchases.detail_returns"
                )))
    {
        return Err("Authenticated role cannot read purchasing records".into());
    }
    let no_filters = record_id.is_none() && search.is_none();
    if key == "purchases.report_return_adjustments" {
        if !no_filters || !(can_report || can_purchases) {
            return Err("Invalid or unauthorized purchase return report read".into());
        }
        return read_purchase_report_return_adjustments(conn,&pharmacy,limit,offset).await;
    }
    let (sql, params, cap): (&str, Vec<Value>, usize) = match key {
        "purchases.suppliers_list" if no_filters => (
            r#"SELECT s.id,s.name_ar,s.name_en,
                 CASE WHEN owned.supplier_id IS NOT NULL THEN s.phone ELSE NULL END AS phone,
                 CASE WHEN owned.supplier_id IS NOT NULL THEN s.address ELSE NULL END AS address,
                 CASE WHEN owned.supplier_id IS NOT NULL THEN s.created_at ELSE NULL END AS created_at,
                 NULL AS balance,
                 (SELECT COUNT(*) FROM main.purchase_invoices pi
                  WHERE pi.supplier_id=s.id AND pi.pharmacy_id=?) AS purchase_count,
                 (SELECT COUNT(*) FROM main.supplier_transactions st
                  WHERE st.supplier_id=s.id AND
                   ((st.type='invoice' AND EXISTS (
                       SELECT 1 FROM main.purchase_invoices pi WHERE pi.id=st.reference_id AND pi.supplier_id=s.id
                         AND pi.pharmacy_id=?))
                    OR (st.type IN ('return','payment') AND EXISTS (
                      SELECT 1 FROM main.purchase_returns pr JOIN main.purchase_invoices pi ON pi.id=pr.purchase_invoice_id
                      WHERE pr.id=st.reference_id AND pr.supplier_id=s.id
                        AND pi.supplier_id=pr.supplier_id
                        AND (st.type='return' OR (pr.refund_method='cash'
                          AND st.notes='Cash purchase return refund'
                          AND ABS(st.amount+pr.total_amount)<0.0001))
                        AND pi.pharmacy_id=?))
                    OR EXISTS (SELECT 1 FROM main.native_supplier_payment_receipts receipt
                      WHERE receipt.supplier_transaction_id=st.id AND receipt.supplier_id=s.id
                        AND receipt.pharmacy_id=?))) AS transaction_count
               FROM main.suppliers s
               LEFT JOIN main.native_supplier_directory_ownership owned
                 ON owned.supplier_id=s.id AND owned.pharmacy_id=?
               WHERE (EXISTS (
                 SELECT 1 FROM main.purchase_invoices used
                 WHERE used.supplier_id=s.id AND used.pharmacy_id=?
               ) OR owned.supplier_id IS NOT NULL) AND NOT EXISTS (
                 SELECT 1 FROM main.native_supplier_directory_ownership foreign_owner
                 WHERE foreign_owner.supplier_id=s.id AND foreign_owner.pharmacy_id<>?
               )
               ORDER BY s.name_ar,s.id LIMIT ? OFFSET ?"#,
            vec![
                json!(pharmacy),
                json!(pharmacy),
                json!(pharmacy),
                json!(pharmacy),
                json!(pharmacy),
                json!(pharmacy),
                json!(pharmacy),
                json!(limit),
                json!(offset),
            ],
            200,
        ),
        "purchases.suppliers_report" if no_filters => (
            r#"SELECT DISTINCT s.id,s.name_ar,s.name_en FROM main.suppliers s
               JOIN main.purchase_invoices i ON i.supplier_id=s.id
               WHERE i.pharmacy_id=? OR (i.pharmacy_id IS NULL AND ?='local_default')
               ORDER BY s.name_ar,s.id LIMIT ? OFFSET ?"#,
            vec![
                json!(pharmacy),
                json!(pharmacy),
                json!(limit),
                json!(offset),
            ],
            200,
        ),
        "purchases.supplier_transactions" if search.is_none() => {
            let id: i64 = valid_id(record_id)?
                .parse()
                .map_err(|_| "Invalid supplier ID")?;
            if id <= 0 {
                return Err("Invalid supplier ID".into());
            }
            (
                r#"SELECT st.* FROM main.supplier_transactions st
                   WHERE st.supplier_id=? AND
                     ((st.type='invoice' AND EXISTS (
                        SELECT 1 FROM main.purchase_invoices pi WHERE pi.id=st.reference_id
                          AND pi.supplier_id=st.supplier_id
                          AND (pi.pharmacy_id=? OR (pi.pharmacy_id IS NULL AND ?='local_default'))))
                      OR (st.type IN ('return','payment') AND EXISTS (
                        SELECT 1 FROM main.purchase_returns pr
                        JOIN main.purchase_invoices pi ON pi.id=pr.purchase_invoice_id
                        WHERE pr.id=st.reference_id AND pr.supplier_id=st.supplier_id
                          AND pi.supplier_id=pr.supplier_id
                          AND (st.type='return' OR (pr.refund_method='cash'
                            AND st.notes='Cash purchase return refund'
                            AND ABS(st.amount+pr.total_amount)<0.0001))
                          AND (pi.pharmacy_id=? OR (pi.pharmacy_id IS NULL AND ?='local_default'))))
                      OR EXISTS (SELECT 1 FROM main.native_supplier_payment_receipts receipt
                        WHERE receipt.supplier_transaction_id=st.id AND receipt.supplier_id=st.supplier_id
                          AND receipt.pharmacy_id=?))
                   ORDER BY datetime(COALESCE(st.created_at,CURRENT_TIMESTAMP)) DESC,st.id DESC
                   LIMIT ? OFFSET ?"#,
                vec![
                    json!(id),
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(limit),
                    json!(offset),
                ],
                200,
            )
        }
        "purchases.reports" if search.is_none() => {
            if !can_report && !can_purchases {
                return Err("Purchase report permission denied".into());
            }
            let raw_filters = record_id.ok_or("Purchase report filters required")?;
            if raw_filters.len() > 1024 || raw_filters.contains('\0') {
                return Err("Invalid purchase report filters".into());
            }
            let filters: PurchaseReportFilters =
                serde_json::from_str(raw_filters).map_err(|_| "Invalid purchase report filters")?;
            let text = [
                filters.start_date.as_deref(),
                filters.end_date.as_deref(),
                filters.user_id.as_deref(),
                filters.payment_method.as_deref(),
                filters.status.as_deref(),
                filters.invoice_number.as_deref(),
                filters.drug_name.as_deref(),
            ];
            if text
                .iter()
                .flatten()
                .any(|v| v.len() > 128 || v.contains('\0'))
                || filters.supplier_id.is_some_and(|id| id <= 0)
            {
                return Err("Invalid purchase report filters".into());
            }
            let status = filters
                .status
                .filter(|s| s != "all")
                .unwrap_or_else(|| "completed".into());
            let user_filter = filters.user_id.as_deref().filter(|s| *s != "all");
            let payment_filter = filters.payment_method.as_deref().filter(|s| *s != "all");
            let invoice_like = filters.invoice_number.map(|s| format!("%{s}%"));
            let drug_like = filters.drug_name.map(|s| format!("%{s}%"));
            (
                r#"SELECT i.*,s.name_ar AS supplier_name,
                    COALESCE(u.full_name,u.username,i.user_id,'غير محدد') AS staff_name,
                    COALESCE((SELECT SUM(pii.quantity*COALESCE(pii.selling_price,md.official_price,0))
                      FROM main.purchase_invoice_items pii LEFT JOIN main.master_drugs md ON md.id=pii.drug_id
                      WHERE pii.invoice_id=i.id OR
                        (pii.invoice_id=i.invoice_number
                          AND NOT EXISTS (SELECT 1 FROM main.purchase_invoice_items own WHERE own.invoice_id=i.id)
                          AND (SELECT COUNT(*) FROM main.purchase_invoices candidate
                            WHERE candidate.invoice_number=i.invoice_number)=1
                          AND NOT EXISTS (SELECT 1 FROM main.purchase_invoices collision
                            WHERE collision.id=i.invoice_number AND collision.id<>i.id))),0) AS total_selling_amount,
                    COALESCE((SELECT SUM(CAST(pii.quantity AS REAL)*CAST(pii.cost_price AS REAL)
                      *(1+CAST(COALESCE(pii.tax_percent,0) AS REAL)/100.0)
                      *(1+CAST(COALESCE(i.tax_percent,0) AS REAL)/100.0))
                      FROM main.purchase_invoice_items pii WHERE pii.invoice_id=i.id OR
                        (pii.invoice_id=i.invoice_number
                          AND NOT EXISTS (SELECT 1 FROM main.purchase_invoice_items own WHERE own.invoice_id=i.id)
                          AND (SELECT COUNT(*) FROM main.purchase_invoices candidate
                            WHERE candidate.invoice_number=i.invoice_number)=1
                          AND NOT EXISTS (SELECT 1 FROM main.purchase_invoices collision
                            WHERE collision.id=i.invoice_number AND collision.id<>i.id))),0)
                      +CAST(COALESCE(i.expenses,0) AS REAL) AS gross_amount,
                    MAX(0,COALESCE((SELECT SUM(CAST(pii.quantity AS REAL)*CAST(pii.cost_price AS REAL)
                      *(1+CAST(COALESCE(pii.tax_percent,0) AS REAL)/100.0)
                      *(1+CAST(COALESCE(i.tax_percent,0) AS REAL)/100.0))
                      FROM main.purchase_invoice_items pii WHERE pii.invoice_id=i.id OR
                        (pii.invoice_id=i.invoice_number
                          AND NOT EXISTS (SELECT 1 FROM main.purchase_invoice_items own WHERE own.invoice_id=i.id)
                          AND (SELECT COUNT(*) FROM main.purchase_invoices candidate
                            WHERE candidate.invoice_number=i.invoice_number)=1
                          AND NOT EXISTS (SELECT 1 FROM main.purchase_invoices collision
                            WHERE collision.id=i.invoice_number AND collision.id<>i.id))),0)
                      +CAST(COALESCE(i.expenses,0) AS REAL)-CAST(COALESCE(i.total_amount,0) AS REAL))
                      AS discount_amount
                   FROM main.purchase_invoices i
                   LEFT JOIN main.suppliers s ON s.id=i.supplier_id
                   LEFT JOIN main.users u ON u.id=i.user_id
                     AND (u.pharmacy_id=? OR (u.pharmacy_id IS NULL AND ?='local_default'))
                   WHERE (i.pharmacy_id=? OR (i.pharmacy_id IS NULL AND ?='local_default'))
                     AND (? IS NULL OR date(i.invoice_date)>=?)
                     AND (? IS NULL OR date(i.invoice_date)<=?)
                     AND (? IS NULL OR i.user_id=?)
                     AND (? IS NULL OR i.payment_method=?)
                     AND (? IS NULL OR i.supplier_id=?)
                     AND i.status=?
                     AND (? IS NULL OR i.invoice_number LIKE ?)
                     AND (? IS NULL OR EXISTS(SELECT 1 FROM main.purchase_invoice_items line
                       JOIN main.master_drugs md ON md.id=line.drug_id
                       WHERE (line.invoice_id=i.id OR
                         (line.invoice_id=i.invoice_number
                           AND NOT EXISTS (SELECT 1 FROM main.purchase_invoice_items own WHERE own.invoice_id=i.id)
                           AND (SELECT COUNT(*) FROM main.purchase_invoices candidate
                             WHERE candidate.invoice_number=i.invoice_number)=1
                           AND NOT EXISTS (SELECT 1 FROM main.purchase_invoices collision
                             WHERE collision.id=i.invoice_number AND collision.id<>i.id)))
                       AND (md.trade_name LIKE ? OR md.trade_name_en LIKE ? OR md.active_ingredient LIKE ?)))
                   ORDER BY date(i.invoice_date) DESC,i.created_at DESC,i.id DESC LIMIT ? OFFSET ?"#,
                vec![
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(filters.start_date),
                    json!(filters.start_date),
                    json!(filters.end_date),
                    json!(filters.end_date),
                    json!(user_filter),
                    json!(user_filter),
                    json!(payment_filter),
                    json!(payment_filter),
                    json!(filters.supplier_id),
                    json!(filters.supplier_id),
                    json!(status),
                    json!(invoice_like),
                    json!(invoice_like),
                    json!(drug_like),
                    json!(drug_like),
                    json!(drug_like),
                    json!(drug_like),
                    json!(limit),
                    json!(offset),
                ],
                200,
            )
        }
        "purchases.return_search" | "purchases.return_supplier" => {
            let supplier = if key == "purchases.return_supplier" {
                let id: i64 = valid_id(record_id)?
                    .parse()
                    .map_err(|_| "Invalid supplier ID")?;
                if id <= 0 || search.is_some() {
                    return Err("Return supplier filter is invalid".into());
                }
                Some(id)
            } else if record_id.is_none() {
                None
            } else {
                return Err("Return search does not accept record IDs".into());
            };
            let like = bounded_search(search)?;
            if supplier.is_none() && like.is_none() {
                return Ok(Vec::new());
            }
            // Both return picker paths require a completed owned invoice with
            // some unreturned quantity. Prior approved/completed mixed-unit
            // returns are reduced to the source invoice's large units.
            (
                r#"SELECT i.id,i.invoice_number,i.supplier_id,i.total_amount,i.invoice_date,
                    i.created_at,i.status,s.name_ar AS supplier_name
                   FROM main.purchase_invoices i
                   LEFT JOIN main.suppliers s ON s.id=i.supplier_id
                   WHERE (i.pharmacy_id=? OR (i.pharmacy_id IS NULL AND ?='local_default'))
                     AND i.status='completed' AND (? IS NULL OR i.supplier_id=?)
                     AND NOT EXISTS (SELECT 1 FROM main.purchase_returns mismatched
                       WHERE mismatched.purchase_invoice_id=i.id AND mismatched.supplier_id<>i.supplier_id)
                     AND EXISTS (
                       SELECT 1 FROM main.purchase_invoice_items candidate
                       LEFT JOIN main.master_drugs drug ON drug.id=candidate.drug_id
                       WHERE candidate.invoice_id=i.id
                         AND CAST(candidate.quantity AS REAL)>COALESCE((
                           SELECT SUM(CASE
                             WHEN LOWER(TRIM(COALESCE(pri.unit,'large'))) IN ('medium','strip')
                               THEN CAST(pri.quantity_returned AS REAL)
                                 /COALESCE(NULLIF(candidate.strips_per_box,0),NULLIF(drug.large_to_medium,0),1)
                             WHEN LOWER(TRIM(COALESCE(pri.unit,'large'))) IN ('small','unit','pill')
                               THEN CAST(pri.quantity_returned AS REAL)
                                 /(COALESCE(NULLIF(candidate.strips_per_box,0),NULLIF(drug.large_to_medium,0),1)
                                   *COALESCE(NULLIF(candidate.medium_to_small,0),NULLIF(drug.medium_to_small,0),1))
                             ELSE CAST(pri.quantity_returned AS REAL) END)
                           FROM main.purchase_return_items pri
                           JOIN main.purchase_returns pr ON pr.id=pri.purchase_return_id
                           WHERE pr.purchase_invoice_id=i.id AND pr.supplier_id=i.supplier_id
                             AND LOWER(COALESCE(pr.status,'')) IN ('completed','approved')
                             AND (pri.purchase_invoice_item_id=candidate.id OR
                               (pri.purchase_invoice_item_id IS NULL AND pri.inventory_id=candidate.inventory_id
                                AND pri.drug_id=candidate.drug_id))
                         ),0)+0.000001
                     )
                     AND (? IS NULL OR i.id LIKE ? OR i.invoice_number LIKE ? OR s.name_ar LIKE ?
                       OR EXISTS (SELECT 1 FROM main.purchase_invoice_items line
                         LEFT JOIN main.master_drugs md ON md.id=line.drug_id
                         WHERE line.invoice_id=i.id AND (md.trade_name LIKE ? OR md.trade_name_en LIKE ?
                           OR md.active_ingredient LIKE ? OR md.barcode LIKE ? OR line.barcode LIKE ?
                           OR CAST(md.id AS TEXT)=? OR md.barcode=? OR line.barcode=?)))
                   ORDER BY date(i.invoice_date) DESC,i.created_at DESC,i.id DESC LIMIT ? OFFSET ?"#,
                vec![
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(supplier),
                    json!(supplier),
                    json!(like),
                    json!(like),
                    json!(like),
                    json!(like),
                    json!(like),
                    json!(like),
                    json!(like),
                    json!(like),
                    json!(like),
                    json!(search),
                    json!(search),
                    json!(search),
                    json!(limit),
                    json!(offset),
                ],
                200,
            )
        }
        "purchases.detail_header" if search.is_none() && offset == 0 && limit == 2 => {
            let id = valid_id(record_id)?;
            // Prefer exact UUID/ID over invoice number, which is not unique.
            let exact = fetch_scoped_limited(
                conn,
                r#"SELECT i.* FROM main.purchase_invoices i WHERE i.id=?
                   AND (i.pharmacy_id=? OR (i.pharmacy_id IS NULL AND ?='local_default')) LIMIT 1"#,
                vec![json!(id), json!(pharmacy), json!(pharmacy)],
                read_limits(1),
            )
            .await?;
            if !exact.is_empty() {
                return Ok(exact);
            }
            (
                r#"SELECT i.* FROM main.purchase_invoices i WHERE i.invoice_number=?
                   AND (i.pharmacy_id=? OR (i.pharmacy_id IS NULL AND ?='local_default'))
                   ORDER BY i.created_at DESC LIMIT 2"#,
                vec![json!(id), json!(pharmacy), json!(pharmacy)],
                2,
            )
        }
        "purchases.detail_items" if search.is_none() => {
            let id = valid_id(record_id)?;
            (
                r#"SELECT pii.*,
                     COALESCE(NULLIF(NULLIF(d.trade_name,''),'Drug '||d.id),
                       NULLIF(NULLIF(d.trade_name_en,''),'Drug '||d.id),
                       d.trade_name,d.trade_name_en,'صنف #'||pii.drug_id) AS trade_name,
                     COALESCE(NULLIF(NULLIF(d.trade_name_en,''),'Drug '||d.id),
                       NULLIF(NULLIF(d.trade_name,''),'Drug '||d.id),
                       d.trade_name_en,d.trade_name,'صنف #'||pii.drug_id) AS trade_name_en,
                     COALESCE(NULLIF(pii.barcode,''),NULLIF(lot.barcode,''),d.barcode) AS barcode,
                     COALESCE(NULLIF(TRIM(d.large_unit),''),'علبة') AS large_unit,
                     COALESCE(NULLIF(TRIM(d.medium_unit),''),'شريط') AS medium_unit,
                     COALESCE(NULLIF(TRIM(d.small_unit),''),'وحدة') AS small_unit,
                     COALESCE(d.has_expiry,1) AS has_expiry,d.large_to_medium,
                     COALESCE(NULLIF(pii.medium_to_small,0),NULLIF(d.medium_to_small,0),1) AS medium_to_small,
                     d.official_price AS base_price,u.name_en AS unit,
                     COALESCE(pii.selling_price,d.official_price,0) AS selling_price,
                     lot.expiry_date AS inventory_expiry_date,lot.batch_number,
                     lot.pharmacy_id AS inventory_pharmacy_id
                   FROM main.purchase_invoices invoice
                   JOIN main.purchase_invoice_items pii ON
                     (pii.invoice_id=invoice.id OR
                       (pii.invoice_id=invoice.invoice_number
                        AND NOT EXISTS (SELECT 1 FROM main.purchase_invoice_items own WHERE own.invoice_id=invoice.id)
                        AND (SELECT COUNT(*) FROM main.purchase_invoices candidate
                          WHERE candidate.invoice_number=invoice.invoice_number)=1
                        AND NOT EXISTS (SELECT 1 FROM main.purchase_invoices conflicting_id
                          WHERE conflicting_id.id=invoice.invoice_number AND conflicting_id.id<>invoice.id)))
                   LEFT JOIN main.master_drugs d ON d.id=pii.drug_id
                   LEFT JOIN main.units u ON u.id=pii.unit_id
                   LEFT JOIN main.inventory lot ON lot.id=pii.inventory_id
                     AND (lot.pharmacy_id=? OR (lot.pharmacy_id IS NULL AND ?='local_default'))
                   WHERE invoice.id=?
                     AND (invoice.pharmacy_id=? OR (invoice.pharmacy_id IS NULL AND ?='local_default'))
                   ORDER BY pii.id LIMIT ? OFFSET ?"#,
                vec![
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(id),
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(limit),
                    json!(offset),
                ],
                200,
            )
        }
        "purchases.detail_returns" if search.is_none() => {
            let id = valid_id(record_id)?;
            (
                r#"SELECT pri.purchase_invoice_item_id,pri.inventory_id,pri.drug_id,
                     pri.quantity_returned,COALESCE(pri.unit,'large') AS unit
                   FROM main.purchase_returns pr
                   JOIN main.purchase_invoices invoice ON invoice.id=pr.purchase_invoice_id
                   JOIN main.purchase_return_items pri ON pri.purchase_return_id=pr.id
                   WHERE invoice.id=? AND pr.supplier_id=invoice.supplier_id
                     AND (invoice.pharmacy_id=? OR (invoice.pharmacy_id IS NULL AND ?='local_default'))
                     AND LOWER(COALESCE(pr.status,'')) IN ('completed','approved')
                   ORDER BY pri.id LIMIT ? OFFSET ?"#,
                vec![
                    json!(id),
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(limit),
                    json!(offset),
                ],
                200,
            )
        }
        "purchases.returns_list" if record_id.is_none() => {
            let like = bounded_search(search)?;
            (
                r#"SELECT pr.*,s.name_ar AS supplier_name,u.full_name AS user_name,
                    pi.invoice_number,pi.invoice_date,
                    (SELECT COUNT(*) FROM main.purchase_return_items pri WHERE pri.purchase_return_id=pr.id) AS items_count
                   FROM main.purchase_returns pr
                   LEFT JOIN main.suppliers s ON s.id=pr.supplier_id
                   LEFT JOIN main.users u ON u.id=pr.user_id
                     AND (u.pharmacy_id=? OR (u.pharmacy_id IS NULL AND ?='local_default'))
                   JOIN main.purchase_invoices pi ON pi.id=pr.purchase_invoice_id
                   WHERE pr.supplier_id=pi.supplier_id
                     AND (pi.pharmacy_id=? OR (pi.pharmacy_id IS NULL AND ?='local_default'))
                     AND (? IS NULL OR CAST(pr.id AS TEXT) LIKE ? OR pr.purchase_invoice_id LIKE ?
                       OR pi.invoice_number LIKE ? OR s.name_ar LIKE ? OR u.full_name LIKE ?)
                   ORDER BY pr.created_at DESC,pr.id DESC LIMIT ? OFFSET ?"#,
                vec![
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(like),
                    json!(like),
                    json!(like),
                    json!(like),
                    json!(like),
                    json!(like),
                    json!(limit),
                    json!(offset),
                ],
                200,
            )
        }
        "purchases.return_detail" if search.is_none() && limit == 1 && offset == 0 => {
            let id = valid_id(record_id)?;
            (
                r#"SELECT pr.*,s.name_ar AS supplier_name,s.phone AS supplier_phone,
                    u.full_name AS user_name,pi.invoice_number,pi.invoice_date,
                    pi.total_amount AS invoice_total,pi.payment_method AS invoice_payment_method
                   FROM main.purchase_returns pr
                   LEFT JOIN main.suppliers s ON s.id=pr.supplier_id
                   LEFT JOIN main.users u ON u.id=pr.user_id
                     AND (u.pharmacy_id=? OR (u.pharmacy_id IS NULL AND ?='local_default'))
                   JOIN main.purchase_invoices pi ON pi.id=pr.purchase_invoice_id
                   WHERE pr.id=? AND pr.supplier_id=pi.supplier_id
                     AND (pi.pharmacy_id=? OR (pi.pharmacy_id IS NULL AND ?='local_default'))
                   LIMIT 1"#,
                vec![
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(id),
                    json!(pharmacy),
                    json!(pharmacy),
                ],
                1,
            )
        }
        "purchases.return_items" if search.is_none() => {
            let id = valid_id(record_id)?;
            (
                r#"SELECT pri.*,COALESCE(pri.drug_name,md.trade_name) AS drug_name,
                    md.trade_name_en,lot.batch_number,lot.expiry_date
                   FROM main.purchase_return_items pri
                   JOIN main.purchase_returns pr ON pr.id=pri.purchase_return_id
                   JOIN main.purchase_invoices invoice ON invoice.id=pr.purchase_invoice_id
                   LEFT JOIN main.master_drugs md ON md.id=pri.drug_id
                   LEFT JOIN main.inventory lot ON lot.id=pri.inventory_id
                     AND (lot.pharmacy_id=? OR (lot.pharmacy_id IS NULL AND ?='local_default'))
                   WHERE pr.id=? AND pr.supplier_id=invoice.supplier_id
                     AND (invoice.pharmacy_id=? OR (invoice.pharmacy_id IS NULL AND ?='local_default'))
                   ORDER BY pri.id LIMIT ? OFFSET ?"#,
                vec![
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(id),
                    json!(pharmacy),
                    json!(pharmacy),
                    json!(limit),
                    json!(offset),
                ],
                200,
            )
        }
        _ => return Err("Unknown or malformed purchasing scoped read".into()),
    };
    fetch_scoped_limited(conn, sql, params, read_limits(cap)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    #[tokio::test]
    async fn purchase_report_native_adjustments_require_owned_immutable_return_sources() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
          CREATE TABLE users(id TEXT,role TEXT,is_active INTEGER,pharmacy_id TEXT,permissions TEXT);
          INSERT INTO users VALUES
            ('report-a','pharmacist',1,'tenant-a','{"rep_can_view_purchases":true}'),
            ('buyer-a','pharmacist',1,'tenant-a','{"can_view_purchases":true}'),
            ('report-b','pharmacist',1,'tenant-b','{"rep_can_view_purchases":true}'),
            ('buyer-b','pharmacist',1,'tenant-b','{"can_view_purchases":true}'),
            ('legacy','owner',1,'local_default','{}'),
            ('denied','pharmacist',1,'tenant-a','{}');
          CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,supplier_id INTEGER,status TEXT,total_amount REAL);
          INSERT INTO purchase_invoices VALUES
            ('invoice-a','tenant-a',7,'completed',462),
            ('invoice-b','tenant-b',8,'completed',80),
            ('invoice-legacy',NULL,7,'completed',900);
          CREATE TABLE native_purchase_posting_events(invoice_id TEXT,pharmacy_id TEXT,
            supplier_id INTEGER,event_kind TEXT,signed_cents INTEGER);
          INSERT INTO native_purchase_posting_events VALUES
            ('invoice-a','tenant-a',7,'initial',46200),
            ('invoice-b','tenant-b',8,'initial',8000);
          CREATE TABLE purchase_returns(id TEXT PRIMARY KEY,purchase_invoice_id TEXT,
            supplier_id INTEGER,user_id TEXT,total_amount REAL,refund_method TEXT,status TEXT,created_at TEXT);
          INSERT INTO purchase_returns VALUES
            ('return-a','invoice-a',7,'buyer-a',115.50,'credit','completed','2026-10-19'),
            ('return-b','invoice-b',8,'buyer-b',40,'credit','completed','2026-10-20'),
            ('return-legacy','invoice-legacy',7,'legacy',900,'credit','completed','2026-10-20'),
            ('return-unreceipted','invoice-a',7,'buyer-a',5,'credit','completed','2026-10-20');
          CREATE TABLE daily_journals(id TEXT PRIMARY KEY,pharmacy_id TEXT,created_by TEXT,total_amount REAL);
          INSERT INTO daily_journals VALUES
            ('journal-a','tenant-a','buyer-a',115.50),('journal-b','tenant-b','buyer-b',40);
          CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT);
          INSERT INTO accounts VALUES(1,'2.1'),(2,'1.1.3'),(3,'1.1.1');
          CREATE TABLE journal_entries(journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
          INSERT INTO journal_entries VALUES
            ('journal-a',1,'debit',115.50),('journal-a',2,'credit',115.50),
            ('journal-b',1,'debit',40),('journal-b',2,'credit',40);
          CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT,drug_id INTEGER);
          INSERT INTO inventory VALUES('lot-a','tenant-a',132),('lot-b','tenant-b',132);
          CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,drug_id INTEGER);
          INSERT INTO purchase_invoice_items VALUES(11,'invoice-a','lot-a',132),(21,'invoice-b','lot-b',132);
          CREATE TABLE purchase_return_items(id INTEGER PRIMARY KEY,purchase_return_id TEXT,
            purchase_invoice_item_id INTEGER,inventory_id TEXT,drug_id INTEGER,
            quantity_returned REAL,total_price REAL);
          INSERT INTO purchase_return_items VALUES
            (1,'return-a',11,'lot-a',132,1,115.50),(2,'return-b',21,'lot-b',132,1,40),
            (3,'return-unreceipted',11,'lot-a',132,1,5);
          CREATE TABLE native_purchase_return_line_provenance(return_item_id INTEGER,return_id TEXT,
            purchase_invoice_item_id INTEGER,inventory_id TEXT,quantity_returned REAL,
            stock_quantity REAL,refund_value REAL);
          INSERT INTO native_purchase_return_line_provenance VALUES
            (1,'return-a',11,'lot-a',1,1,115.50),(2,'return-b',21,'lot-b',1,1,40);
          CREATE TABLE native_purchase_return_provenance(return_id TEXT PRIMARY KEY,
            purchase_invoice_id TEXT,pharmacy_id TEXT,actor_id TEXT,supplier_id INTEGER,
            journal_id TEXT,refund_method TEXT,amount_cents INTEGER,line_count INTEGER);
          INSERT INTO native_purchase_return_provenance VALUES
            ('return-a','invoice-a','tenant-a','buyer-a',7,'journal-a','credit',11550,1),
            ('return-b','invoice-b','tenant-b','buyer-b',8,'journal-b','credit',4000,1);
        "#).execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"an owned unreceipted return must block net KPI");
        sqlx::query("DELETE FROM purchase_return_items WHERE id=3").execute(&mut conn).await.unwrap();
        sqlx::query("DELETE FROM purchase_returns WHERE id='return-unreceipted'").execute(&mut conn).await.unwrap();
        let a=run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.unwrap();
        let b=run_purchasing_read(&mut conn,"report-b","purchases.report_return_adjustments",
            None,None,20,0).await.unwrap();
        assert_eq!(a.len(),1);
        assert_eq!(b.len(),1);
        assert_eq!(a[0]["return_id"],"return-a");
        assert_eq!(a[0]["purchase_invoice_id"],"invoice-a");
        assert_eq!(a[0]["amount_cents"],11550);
        assert_eq!(b[0]["return_id"],"return-b");
        for actor in ["denied","legacy"] {
            assert!(run_purchasing_read(&mut conn,actor,"purchases.report_return_adjustments",
                None,None,20,0).await.is_err());
        }
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            Some("tenant-b"),None,20,0).await.is_err(),"the renderer cannot supply scope");
        sqlx::query("UPDATE purchase_return_items SET inventory_id='lot-b' WHERE id=1")
            .execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"foreign lot must invalidate report");
        sqlx::query("UPDATE purchase_return_items SET inventory_id='lot-a' WHERE id=1")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE daily_journals SET total_amount=100 WHERE id='journal-a'")
            .execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"changed receipt journal must invalidate report");
        sqlx::query("UPDATE daily_journals SET total_amount=115.50 WHERE id='journal-a'")
            .execute(&mut conn).await.unwrap();
        sqlx::query("DELETE FROM journal_entries WHERE journal_id='journal-a' AND type='credit'")
            .execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"missing inventory reversal entry must fail closed");
        sqlx::query("INSERT INTO journal_entries VALUES('journal-a',2,'credit',115.50)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE purchase_return_items SET quantity_returned=NULL WHERE id=1")
            .execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"NULL source quantity cannot validate against an immutable line receipt");
        sqlx::query("UPDATE purchase_return_items SET quantity_returned=1 WHERE id=1")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE purchase_return_items SET drug_id=NULL WHERE id=1")
            .execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"NULL source drug cannot validate a posted line");
        sqlx::query("UPDATE purchase_return_items SET drug_id=132 WHERE id=1")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE purchase_invoice_items SET inventory_id=NULL WHERE id=11")
            .execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"NULL original inventory must invalidate line lineage");
        sqlx::query("UPDATE purchase_invoice_items SET inventory_id='lot-a' WHERE id=11")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE native_purchase_return_provenance SET pharmacy_id='tenant-a' WHERE return_id='return-b'")
            .execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"a foreign invoice receipt claiming this tenant must fail the register");
        sqlx::query("UPDATE native_purchase_return_provenance SET pharmacy_id='tenant-b' WHERE return_id='return-b'")
            .execute(&mut conn).await.unwrap();
        sqlx::query("DELETE FROM native_purchase_return_line_provenance WHERE return_item_id=1")
            .execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"partially missing immutable line receipts must block the entire KPI");
        sqlx::query("INSERT INTO native_purchase_return_line_provenance VALUES (1,'return-a',11,'lot-a',1,1,115.50)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE native_purchase_return_line_provenance SET refund_value=99 WHERE return_item_id=1")
            .execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"tampered monetary line proof must not form a partial net value");
        sqlx::query("UPDATE native_purchase_return_line_provenance SET refund_value=115.50 WHERE return_item_id=1")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE purchase_invoices SET total_amount=500 WHERE id='invoice-a'")
            .execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"altered original purchase total must not override immutable posting events");
        sqlx::query("UPDATE purchase_invoices SET total_amount=462 WHERE id='invoice-a'")
            .execute(&mut conn).await.unwrap();
        sqlx::query("DELETE FROM native_purchase_posting_events WHERE invoice_id='invoice-a'")
            .execute(&mut conn).await.unwrap();
        assert!(run_purchasing_read(&mut conn,"report-a","purchases.report_return_adjustments",
            None,None,20,0).await.is_err(),"a missing original native purchase posting cannot certify return adjusted net");
    }

    #[tokio::test]
    async fn purchasing_native_reads_enforce_actor_tenant_and_supplier_statement_source() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
          CREATE TABLE users(id TEXT,role TEXT,is_active INTEGER,pharmacy_id TEXT,permissions TEXT,full_name TEXT,username TEXT);
          INSERT INTO users VALUES ('a','pharmacist',1,'tenant-a','{"can_view_purchases":true,"can_view_suppliers":true}','A','a'),
            ('b','pharmacist',1,'tenant-b','{"can_view_purchases":true}','B','b'),
            ('report','pharmacist',1,'tenant-a','{"rep_can_view_purchases":true}','Reporter','r'),
            ('supplier','pharmacist',1,'tenant-a','{"can_view_suppliers":true}','Supplier','s'),
            ('legacy','pharmacist',1,'local_default','{"can_view_purchases":true}','Legacy','l'),
            ('denied','cashier',1,'tenant-a','{"can_view_purchases":false}','Denied','d'),
            ('inactive','owner',0,'tenant-a','{}','Inactive','i');
          CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name_ar TEXT,name_en TEXT,phone TEXT,address TEXT,created_at TEXT,balance REAL);
          CREATE TABLE native_supplier_directory_ownership(supplier_id INTEGER PRIMARY KEY,pharmacy_id TEXT,actor_id TEXT,request_id TEXT,payload_sha256 TEXT);
          INSERT INTO suppliers VALUES(7,'Shared','S','111','A','2026-01-01',999),
            (8,'Another','A','222','B','2026-01-01',777),
            (9,'Foreign only','F','FOREIGN PHONE','FOREIGN ADDRESS','2026-01-01',909),
            (10,'Unowned history','U','UNOWNED PHONE','UNOWNED ADDRESS','2026-01-01',1010),
            (11,'New A','N','NEW-A-CONTACT','NEW-A-ADDRESS','2026-01-01',0),
            (12,'New B','N','NEW-B-SECRET','NEW-B-SECRET','2026-01-01',0);
          INSERT INTO native_supplier_directory_ownership VALUES
            (11,'tenant-a','a','new-a','sha-a'),(12,'tenant-b','b','new-b','sha-b');
          CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,supplier_id INTEGER,pharmacy_id TEXT,user_id TEXT,status TEXT,invoice_number TEXT,invoice_date TEXT,created_at TEXT,total_amount REAL,payment_method TEXT,expenses REAL,tax_percent REAL);
          INSERT INTO purchase_invoices VALUES
            ('inv-a',7,'tenant-a','a','completed','A1','2026-10-01','2026-10-02',100,'credit',0,0),
            ('inv-b',7,'tenant-b','b','completed','B1','2026-10-01','2026-10-03',900,'credit',0,0),
            ('draft-a',7,'tenant-a','a','draft','AD','2026-10-01','2026-10-01',10,'credit',0,0),
            ('spent-a',7,'tenant-a','a','completed','FULL','2026-10-01','2026-10-01',10,'credit',0,0),
            ('other-supplier',8,'tenant-a','a','completed','OTHER','2026-10-01','2026-10-01',10,'credit',0,0),
            ('foreign-only-invoice',9,'tenant-b','b','completed','SECRET-FOREIGN','2026-10-01','2026-10-01',909,'credit',0,0),
            ('unowned-invoice',10,NULL,'legacy','completed','UNOWNED','2026-10-01','2026-10-01',1010,'credit',0,0);
          CREATE TABLE supplier_transactions(id INTEGER PRIMARY KEY,supplier_id INTEGER,type TEXT,amount REAL,reference_id TEXT,notes TEXT,created_at TEXT);
          INSERT INTO supplier_transactions VALUES
            (1,7,'invoice',100,'inv-a','A','2026-10-02'),
            (2,7,'invoice',900,'inv-b','SECRET B','2026-10-03'),
            (3,7,'return',10,'return-a','OUR RETURN','2026-10-03'),
            (4,7,'payment',-10,'return-a','Cash purchase return refund','2026-10-03'),
            (5,7,'payment',-20,'return-b','Cash purchase return refund','2026-10-04'),
            (6,7,'payment',-90,'return-a','Forged foreign-like payment','2026-10-03'),
            (7,9,'invoice',909,'foreign-only-invoice','FOREIGN ONLY SECRET','2026-10-06');
          CREATE TABLE native_supplier_payment_receipts(supplier_transaction_id INTEGER,supplier_id INTEGER,pharmacy_id TEXT);
          CREATE TABLE purchase_returns(id TEXT PRIMARY KEY,supplier_id INTEGER,user_id TEXT,purchase_invoice_id TEXT,status TEXT,created_at TEXT,reason TEXT,total_amount REAL,refund_method TEXT);
          INSERT INTO purchase_returns VALUES
            ('return-a',7,'a','inv-a','completed','2026-10-03','A',10,'cash'),
            ('return-b',7,'b','inv-b','completed','2026-10-04','SECRET B',20,'cash'),
            ('spent-return',7,'a','spent-a','approved','2026-10-05','spent',10,'credit');
          CREATE TABLE purchase_return_items(id INTEGER PRIMARY KEY,purchase_return_id TEXT,purchase_invoice_item_id INTEGER,inventory_id TEXT,drug_id INTEGER,quantity_returned REAL,unit TEXT,drug_name TEXT);
          INSERT INTO purchase_return_items VALUES(1,'return-a',1,'lot-a',10,1,'large','A'),
            (2,'return-b',2,'lot-b',10,1,'large','SECRET B'),
            (3,'spent-return',3,'lot-spent',10,1,'large','Spent');
          CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER,quantity REAL,cost_price REAL,selling_price REAL,tax_percent REAL,strips_per_box REAL,medium_to_small REAL,inventory_id TEXT,barcode TEXT,unit_id INTEGER);
          INSERT INTO purchase_invoice_items VALUES(1,'inv-a',10,2,50,60,0,1,1,'lot-a','AA',NULL),
            (2,'inv-b',10,2,450,500,0,1,1,'lot-b','BB',NULL),
            (3,'spent-a',10,1,10,10,0,1,1,'lot-spent','SPENT',NULL),
            (4,'other-supplier',10,1,10,10,0,1,1,'lot-other','OTHER',NULL);
          CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,active_ingredient TEXT,barcode TEXT,large_to_medium REAL,medium_to_small REAL,official_price REAL,large_unit TEXT,medium_unit TEXT,small_unit TEXT,has_expiry INTEGER);
          INSERT INTO master_drugs VALUES(10,'Drug','D','Ingredient','AA',1,1,60,'box','strip','pill',1);
          CREATE TABLE units(id INTEGER,name_en TEXT);
          CREATE TABLE inventory(id TEXT,pharmacy_id TEXT,barcode TEXT,expiry_date TEXT,batch_number TEXT);
          INSERT INTO inventory VALUES('lot-a','tenant-a','AA','2027-01-01','BATCH-A'),
            ('lot-b','tenant-b','BB','2028-01-01','PRIVATE'),
            ('lot-spent','tenant-a','SPENT','2027-01-01','SPENT'),
            ('lot-other','tenant-a','OTHER','2027-01-01','OTHER');
        "#).execute(&mut conn).await.unwrap();
        let read = |key: &'static str,
                    id: Option<&'static str>,
                    search: Option<&'static str>,
                    actor: &'static str| (key, id, search, actor);
        let directory = run_purchasing_read(
            &mut conn,
            "a",
            "purchases.suppliers_list",
            None,
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert!(
            directory.iter().find(|s| s["id"] == 7).unwrap()["balance"].is_null(),
            "mixed-tenant global balance must be unknown"
        );
        assert!(directory.iter().find(|s| s["id"] == 7).unwrap()["phone"].is_null(),
            "legacy global contact data cannot become tenant-owned by invoice association");
        assert_eq!(
            directory.iter().find(|s| s["id"] == 7).unwrap()["purchase_count"],
            3
        );
        // Supplier directory contacts and global legacy balances are not
        // authenticated tenant data. Only explicitly linked names may appear,
        // and even sole-tenant-looking global balances cannot be certified.
        assert_eq!(directory.len(), 3);
        assert!(directory.iter().any(|s| s["id"] == 7));
        assert!(directory.iter().any(|s| s["id"] == 8));
        assert!(directory.iter().any(|s| s["id"] == 11 && s["phone"] == "NEW-A-CONTACT"));
        assert!(directory.iter().all(|s| s["balance"].is_null()));
        assert!(!directory.iter().any(|s| s["id"] == 9 || s["id"] == 10 || s["id"] == 12));
        let other_directory = run_purchasing_read(
            &mut conn,
            "b",
            "purchases.suppliers_list",
            None,
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(other_directory.len(), 3);
        assert!(other_directory.iter().any(|s| s["id"] == 7));
        assert!(other_directory.iter().any(|s| s["id"] == 9));
        assert!(other_directory.iter().any(|s| s["id"] == 12));
        assert!(other_directory.iter().all(|s| s["balance"].is_null()));
        assert!(!other_directory
            .iter()
            .any(|s| s["id"] == 8 || s["id"] == 10 || s["id"] == 11));
        let supplier_only_directory = run_purchasing_read(
            &mut conn,
            "supplier",
            "purchases.suppliers_list",
            None,
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(supplier_only_directory.len(), 3);
        assert!(supplier_only_directory
            .iter()
            .all(|s| s["balance"].is_null() && s["id"] != 9 && s["id"] != 10 && s["id"] != 12));
        for actor in ["denied", "inactive", "nonexistent", "legacy"] {
            assert!(run_purchasing_read(
                &mut conn,
                actor,
                "purchases.suppliers_list",
                None,
                None,
                20,
                0,
            )
            .await
            .is_err());
        }
        assert!(run_purchasing_read(
            &mut conn,
            "a",
            "purchases.supplier_transactions",
            Some("9"),
            None,
            20,
            0,
        )
        .await
        .unwrap()
        .is_empty());
        let foreign_statement = run_purchasing_read(
            &mut conn,
            "b",
            "purchases.supplier_transactions",
            Some("9"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(foreign_statement.len(), 1);
        assert_eq!(foreign_statement[0]["notes"], "FOREIGN ONLY SECRET");
        let statement = run_purchasing_read(
            &mut conn,
            "a",
            "purchases.supplier_transactions",
            Some("7"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(statement.len(), 3);
        assert!(!statement
            .iter()
            .any(|s| s["notes"] == "SECRET B" || s["notes"] == "Forged foreign-like payment"));
        assert!(statement.iter().any(|s| s["notes"] == "A"));
        let reports = run_purchasing_read(
            &mut conn,
            "report",
            "purchases.reports",
            Some(r#"{"status":"completed"}"#),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(reports.len(), 3);
        assert!(reports.iter().any(|s| s["id"] == "inv-a"));
        assert!(!reports
            .iter()
            .any(|s| s["id"] == "inv-b" || s["id"] == "draft-a"));
        let only_supplier = run_purchasing_read(
            &mut conn,
            "report",
            "purchases.suppliers_report",
            None,
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(only_supplier.len(), 2);
        assert!(run_purchasing_read(
            &mut conn,
            "supplier",
            "purchases.suppliers_report",
            None,
            None,
            20,
            0
        )
        .await
        .is_err());
        let picker = run_purchasing_read(
            &mut conn,
            "a",
            "purchases.return_supplier",
            Some("7"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(picker.len(), 1);
        assert_eq!(picker[0]["id"], "inv-a");
        let other = run_purchasing_read(
            &mut conn,
            "a",
            "purchases.return_supplier",
            Some("8"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(other.len(), 1);
        assert_eq!(other[0]["id"], "other-supplier");
        assert!(run_purchasing_read(
            &mut conn,
            "a",
            "purchases.return_search",
            None,
            Some("FULL"),
            20,
            0
        )
        .await
        .unwrap()
        .is_empty());
        let by_number = run_purchasing_read(
            &mut conn,
            "a",
            "purchases.detail_header",
            Some("A1"),
            None,
            2,
            0,
        )
        .await
        .unwrap();
        assert_eq!(by_number.len(), 1);
        assert_eq!(by_number[0]["id"], "inv-a");
        let lines = run_purchasing_read(
            &mut conn,
            "a",
            "purchases.detail_items",
            Some("inv-a"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["batch_number"], "BATCH-A");
        assert!(run_purchasing_read(
            &mut conn,
            "a",
            "purchases.detail_items",
            Some("inv-b"),
            None,
            20,
            0
        )
        .await
        .unwrap()
        .is_empty());
        let prior = run_purchasing_read(
            &mut conn,
            "a",
            "purchases.detail_returns",
            Some("inv-a"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(prior.len(), 1);
        let returns =
            run_purchasing_read(&mut conn, "a", "purchases.returns_list", None, None, 20, 0)
                .await
                .unwrap();
        assert_eq!(returns.len(), 2);
        assert!(!returns.iter().any(|s| s["id"] == "return-b"));
        let search = run_purchasing_read(
            &mut conn,
            "a",
            "purchases.return_search",
            None,
            Some("B1"),
            20,
            0,
        )
        .await
        .unwrap();
        assert!(search.is_empty());
        let own = run_purchasing_read(
            &mut conn,
            "a",
            "purchases.return_detail",
            Some("return-a"),
            None,
            1,
            0,
        )
        .await
        .unwrap();
        assert_eq!(own.len(), 1);
        assert!(run_purchasing_read(
            &mut conn,
            "a",
            "purchases.return_detail",
            Some("return-b"),
            None,
            1,
            0
        )
        .await
        .unwrap()
        .is_empty());
        let own_items = run_purchasing_read(
            &mut conn,
            "a",
            "purchases.return_items",
            Some("return-a"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(own_items.len(), 1);
        assert_eq!(own_items[0]["batch_number"], "BATCH-A");
        let items = run_purchasing_read(
            &mut conn,
            "a",
            "purchases.return_items",
            Some("return-b"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert!(items.is_empty());
        // A historical row whose return supplier differs from its source
        // invoice cannot be attributed to the invoice's tenant or supplier.
        sqlx::query(
            "INSERT INTO purchase_returns(id,supplier_id,user_id,purchase_invoice_id,status,created_at,reason,total_amount,refund_method)
             VALUES ('forged-supplier',8,'a','inv-a','completed','2026-10-06','forged',2,'cash')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        assert!(run_purchasing_read(
            &mut conn,
            "a",
            "purchases.return_supplier",
            Some("7"),
            None,
            20,
            0,
        )
        .await
        .unwrap()
        .is_empty());
        assert!(run_purchasing_read(
            &mut conn,
            "a",
            "purchases.return_detail",
            Some("forged-supplier"),
            None,
            1,
            0,
        )
        .await
        .unwrap()
        .is_empty());
        for actor in ["denied", "inactive", "nonexistent", "legacy"] {
            let (key, id, search, actor) = read("purchases.returns_list", None, None, actor);
            assert!(
                run_purchasing_read(&mut conn, actor, key, id, search, 20, 0)
                    .await
                    .is_err()
            );
        }
        assert!(run_purchasing_read(
            &mut conn,
            "a",
            "purchases.return_detail",
            Some("return-a"),
            None,
            200,
            0
        )
        .await
        .is_err());
        assert!(run_purchasing_read(
            &mut conn,
            "a",
            "purchases.supplier_transactions",
            Some("7 OR 1=1"),
            None,
            20,
            0
        )
        .await
        .is_err());

        // Positive-path report arithmetic on explicit, non-legacy ownership:
        // purchased stock uses paid quantity, compounded item/header taxes,
        // expenses, and the saved posted total. No foreign tenant's purchase
        // may influence the report or its aggregate totals.
        sqlx::query("UPDATE purchase_invoice_items SET tax_percent=10 WHERE invoice_id='inv-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("UPDATE purchase_invoices SET tax_percent=5,expenses=7,total_amount=110 WHERE id='inv-a'")
            .execute(&mut conn).await.unwrap();
        let scoped_report = run_purchasing_read(
            &mut conn, "report", "purchases.reports",
            Some(r#"{"status":"completed","invoiceNumber":"A1","supplierId":7,"startDate":"2026-10-01","endDate":"2026-10-01"}"#),
            None, 20, 0,
        ).await.unwrap();
        assert_eq!(scoped_report.len(), 1);
        let invoice = &scoped_report[0];
        assert_eq!(invoice["id"], "inv-a");
        assert!((invoice["gross_amount"].as_f64().unwrap() - 122.5).abs() < 0.000_001);
        assert!((invoice["discount_amount"].as_f64().unwrap() - 12.5).abs() < 0.000_001);
        assert!((invoice["total_amount"].as_f64().unwrap() - 110.0).abs() < 0.000_001);
        assert!((invoice["total_selling_amount"].as_f64().unwrap() - 120.0).abs() < 0.000_001);
        let foreign_report = run_purchasing_read(
            &mut conn,
            "b",
            "purchases.reports",
            Some(r#"{"invoiceNumber":"A1"}"#),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert!(foreign_report.is_empty());

        // A historical posted invoice must not silently lose immutable lines
        // or their saved selling amounts just because its catalog drug was
        // subsequently removed. Line cost/selling snapshots remain present.
        sqlx::query("INSERT INTO purchase_invoices (id,supplier_id,pharmacy_id,user_id,status,invoice_number,invoice_date,created_at,total_amount,payment_method,expenses,tax_percent) VALUES ('orphan-catalog',7,'tenant-a','a','completed','ORPHAN','2026-10-01','2026-10-03',30,'credit',0,0)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO purchase_invoice_items (id,invoice_id,drug_id,quantity,cost_price,selling_price,tax_percent,strips_per_box,medium_to_small,inventory_id,barcode,unit_id) VALUES (99,'orphan-catalog',999,1,30,40,0,1,1,NULL,'LEGACY-BARCODE',NULL)")
            .execute(&mut conn).await.unwrap();
        let orphan_lines = run_purchasing_read(
            &mut conn,
            "report",
            "purchases.detail_items",
            Some("orphan-catalog"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(
            orphan_lines.len(),
            1,
            "posted line was lost with its deleted catalog row"
        );
        assert_eq!(orphan_lines[0]["trade_name"], "صنف #999");
        assert_eq!(orphan_lines[0]["cost_price"].as_f64(), Some(30.0));
        let orphan_report = run_purchasing_read(
            &mut conn,
            "report",
            "purchases.reports",
            Some(r#"{"invoiceNumber":"ORPHAN"}"#),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(orphan_report.len(), 1);
        assert_eq!(
            orphan_report[0]["total_selling_amount"].as_f64(),
            Some(40.0)
        );

        // Historical lines sometimes retained the human invoice number as
        // their link. Details accept that link only when it is unambiguous;
        // the report must reconcile the exact same owned lines.
        sqlx::query("INSERT INTO purchase_invoices (id,supplier_id,pharmacy_id,user_id,status,invoice_number,invoice_date,created_at,total_amount,payment_method,expenses,tax_percent) VALUES ('historic-id',7,'tenant-a','a','completed','HIST-2020','2026-10-01','2026-10-04',45,'credit',0,0)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO purchase_invoice_items (id,invoice_id,drug_id,quantity,cost_price,selling_price,tax_percent,strips_per_box,medium_to_small,inventory_id,barcode,unit_id) VALUES (100,'HIST-2020',10,2,25,35,0,1,1,NULL,'HIST-BARCODE',NULL)")
            .execute(&mut conn).await.unwrap();
        let historic_details = run_purchasing_read(
            &mut conn,
            "report",
            "purchases.detail_items",
            Some("historic-id"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(historic_details.len(), 1);
        let historic_report = run_purchasing_read(
            &mut conn,
            "report",
            "purchases.reports",
            Some(r#"{"invoiceNumber":"HIST-2020"}"#),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(historic_report.len(), 1);
        assert_eq!(historic_report[0]["gross_amount"].as_f64(), Some(50.0));
        assert_eq!(historic_report[0]["discount_amount"].as_f64(), Some(5.0));
        assert_eq!(
            historic_report[0]["total_selling_amount"].as_f64(),
            Some(70.0)
        );
    }

    #[tokio::test]
    async fn purchase_reports_certify_posted_math_filters_permissions_and_page_boundaries() {
        use super::super::purchase_accounting_policy::{
            build_purchase_accounting_plan, PurchaseSettlementAccount,
        };

        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
          CREATE TABLE users(id TEXT,role TEXT,is_active INTEGER,pharmacy_id TEXT,permissions TEXT,full_name TEXT,username TEXT);
          INSERT INTO users VALUES
            ('report-a','pharmacist',1,'tenant-a','{"rep_can_view_purchases":true}','Reporter','reporter'),
            ('buyer-a','pharmacist',1,'tenant-a','{"can_view_purchases":true}','Buyer','buyer'),
            ('report-b','pharmacist',1,'tenant-b','{"rep_can_view_purchases":true}','Foreign','foreign'),
            ('supplier-a','pharmacist',1,'tenant-a','{"can_view_suppliers":true}','Supplier','supplier'),
            ('denied-a','pharmacist',1,'tenant-a','{}','Denied','denied'),
            ('inactive-a','owner',0,'tenant-a','{}','Inactive','inactive');
          CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name_ar TEXT);
          INSERT INTO suppliers VALUES(7,'Owned Supplier'),(8,'Other Supplier');
          CREATE TABLE purchase_invoices(
            id TEXT PRIMARY KEY,supplier_id INTEGER,pharmacy_id TEXT,user_id TEXT,
            invoice_number TEXT,invoice_date TEXT,created_at TEXT,status TEXT,payment_method TEXT,
            total_amount REAL,expenses REAL,tax_percent REAL,discount_value REAL,discount_percent REAL);
          INSERT INTO purchase_invoices VALUES
            ('cash-a',7,'tenant-a','buyer-a','A-CASH','2026-10-18','2026-10-18 10:00:00','completed','cash',105.75,7,5,5,10),
            ('credit-a',7,'tenant-a','buyer-a','A-CREDIT','2026-10-17','2026-10-17 10:00:00','completed','credit',30,0,0,0,0),
            ('check-a',8,'tenant-a','buyer-a','A-CHECK','2026-10-16','2026-10-16 10:00:00','completed','check',40,3,20,4.4,0),
            ('historic-a',7,'tenant-a','buyer-a','HIST-OLD','2026-10-15','2026-10-15 10:00:00','completed','credit',45,0,0,5,0),
            ('orphan-a',8,'tenant-a','buyer-a','A-ORPHAN','2026-10-14','2026-10-14 10:00:00','completed','credit',12,0,0,0,0),
            ('draft-a',7,'tenant-a','buyer-a','A-DRAFT','2026-10-19','2026-10-19 10:00:00','draft','credit',0,0,0,0,0),
            ('foreign-b',7,'tenant-b','report-b','B-PRIVATE','2026-10-20','2026-10-20 10:00:00','completed','cash',9000,0,0,0,0),
            ('unowned',7,NULL,'buyer-a','UNOWNED','2026-10-20','2026-10-20 11:00:00','completed','credit',8000,0,0,0,0);
          CREATE TABLE purchase_invoice_items(
            id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER,quantity REAL,
            bonus_quantity REAL,cost_price REAL,selling_price REAL,tax_percent REAL,
            discount_percent REAL,barcode TEXT,inventory_id TEXT,unit_id INTEGER);
          INSERT INTO purchase_invoice_items VALUES
            (1,'cash-a',10,2,4,50,80,10,50,'A-CASH-BARCODE',NULL,NULL),
            (2,'credit-a',10,1,0,30,NULL,0,0,'A-CREDIT-BARCODE',NULL,NULL),
            (3,'check-a',11,3,0,10,25,15,0,'A-CHECK-BARCODE',NULL,NULL),
            (4,'HIST-OLD',10,2,0,25,35,0,0,'A-HIST-BARCODE',NULL,NULL),
            (5,'orphan-a',999,2,0,6,8,0,0,'ORPHAN-BARCODE',NULL,NULL),
            (6,'foreign-b',11,1,0,9000,9999,0,0,'PRIVATE',NULL,NULL);
          ALTER TABLE purchase_invoice_items ADD COLUMN strips_per_box REAL;
          ALTER TABLE purchase_invoice_items ADD COLUMN medium_to_small REAL;
          CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,active_ingredient TEXT,official_price REAL,barcode TEXT,large_unit TEXT,medium_unit TEXT,small_unit TEXT,has_expiry INTEGER,large_to_medium INTEGER,medium_to_small INTEGER);
          INSERT INTO master_drugs VALUES
            (10,'Historical drug','Historic Drug EN','Ingredient Ten',60,'TEN','box','strip','pill',1,2,10),
            (11,'Check drug','Check Drug EN','Ingredient Eleven',25,'ELEVEN','box','strip','pill',1,2,10);
          CREATE TABLE inventory(id TEXT,pharmacy_id TEXT,expiry_date TEXT,batch_number TEXT,barcode TEXT);
          CREATE TABLE units(id INTEGER,name_en TEXT);
        "#).execute(&mut conn).await.unwrap();

        let report = run_purchasing_read(
            &mut conn,
            "report-a",
            "purchases.reports",
            Some("{}"),
            None,
            200,
            0,
        )
        .await
        .unwrap();
        assert_eq!(report.len(), 5, "completed rows of this tenant only");
        let expected = [
            ("cash-a", 122.5, 16.75, 105.75, 160.0),
            ("credit-a", 30.0, 0.0, 30.0, 60.0),
            ("check-a", 44.4, 4.4, 40.0, 75.0),
            ("historic-a", 50.0, 5.0, 45.0, 70.0),
            ("orphan-a", 12.0, 0.0, 12.0, 16.0),
        ];
        for (id, gross, discount, net, selling) in expected {
            let row = report.iter().find(|row| row["id"] == id).unwrap();
            for (field, amount) in [
                ("gross_amount", gross),
                ("discount_amount", discount),
                ("total_amount", net),
                ("total_selling_amount", selling),
            ] {
                assert!(
                    (row[field].as_f64().unwrap() - amount).abs() < 0.000_001,
                    "{id} {field} diverged from posted invoice policy"
                );
            }
        }
        // Item discount_percent is already captured in cost_price; applying
        // it again would break the immutable invoice total. Bonus stock is free.
        let total_net: f64 = report
            .iter()
            .map(|row| row["total_amount"].as_f64().unwrap())
            .sum();
        let total_gross: f64 = report
            .iter()
            .map(|row| row["gross_amount"].as_f64().unwrap())
            .sum();
        assert!((total_net - 232.75).abs() < 0.000_001);
        assert!((total_gross - 258.9).abs() < 0.000_001);
        let cash_posting = build_purchase_accounting_plan("cash", 105.75).unwrap();
        assert_eq!(
            cash_posting.settlement_account,
            PurchaseSettlementAccount::Cash
        );
        assert_eq!(cash_posting.supplier_balance_delta, 0.0);
        assert_eq!(cash_posting.supplier_transactions[0].amount, 105.75);
        assert_eq!(cash_posting.supplier_transactions[1].amount, -105.75);
        assert_eq!(cash_posting.cash_movement.unwrap().amount, 105.75);
        for (method, amount) in [("credit", 30.0), ("check", 40.0)] {
            let posting = build_purchase_accounting_plan(method, amount).unwrap();
            assert_eq!(
                posting.settlement_account,
                PurchaseSettlementAccount::Payable
            );
            assert_eq!(posting.supplier_balance_delta, amount);
            assert!(posting.cash_movement.is_none());
        }

        // The report-only permission can inspect reports and their source
        // lines, but cannot open purchasing/returns management endpoints.
        let historic = run_purchasing_read(
            &mut conn,
            "report-a",
            "purchases.detail_items",
            Some("historic-a"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(historic.len(), 1);
        let orphan = run_purchasing_read(
            &mut conn,
            "report-a",
            "purchases.detail_items",
            Some("orphan-a"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(orphan.len(), 1);
        assert_eq!(orphan[0]["trade_name"], "صنف #999");
        assert_eq!(orphan[0]["selling_price"].as_f64(), Some(8.0));
        for denied in ["supplier-a", "denied-a", "inactive-a"] {
            assert!(run_purchasing_read(
                &mut conn,
                denied,
                "purchases.reports",
                Some("{}"),
                None,
                20,
                0,
            )
            .await
            .is_err());
        }
        assert!(run_purchasing_read(
            &mut conn,
            "report-a",
            "purchases.return_search",
            None,
            Some("Drug"),
            20,
            0,
        )
        .await
        .is_err());
        let foreign = run_purchasing_read(
            &mut conn,
            "report-b",
            "purchases.reports",
            Some("{}"),
            None,
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(foreign.len(), 1);
        assert_eq!(foreign[0]["id"], "foreign-b");
        assert!(run_purchasing_read(
            &mut conn,
            "report-a",
            "purchases.reports",
            Some(r#"{"invoiceNumber":"B-PRIVATE"}"#),
            None,
            20,
            0,
        )
        .await
        .unwrap()
        .is_empty());

        for (filters, expected_ids) in [
            (r#"{"paymentMethod":"cash"}"#, vec!["cash-a"]),
            (
                r#"{"paymentMethod":"credit"}"#,
                vec!["credit-a", "historic-a", "orphan-a"],
            ),
            (r#"{"paymentMethod":"check"}"#, vec!["check-a"]),
            (r#"{"supplierId":8}"#, vec!["check-a", "orphan-a"]),
            (
                r#"{"userId":"buyer-a"}"#,
                vec!["cash-a", "credit-a", "check-a", "historic-a", "orphan-a"],
            ),
            (
                r#"{"startDate":"2026-10-16","endDate":"2026-10-17"}"#,
                vec!["credit-a", "check-a"],
            ),
            (r#"{"invoiceNumber":"HIST-OLD"}"#, vec!["historic-a"]),
            (r#"{"drugName":"Ingredient Eleven"}"#, vec!["check-a"]),
            (
                r#"{"drugName":"Historical drug"}"#,
                vec!["cash-a", "credit-a", "historic-a"],
            ),
            (r#"{"status":"draft"}"#, vec!["draft-a"]),
            (
                r#"{"status":"all"}"#,
                vec!["cash-a", "credit-a", "check-a", "historic-a", "orphan-a"],
            ),
        ] {
            let matches = run_purchasing_read(
                &mut conn,
                "report-a",
                "purchases.reports",
                Some(filters),
                None,
                200,
                0,
            )
            .await
            .unwrap();
            let ids: Vec<&str> = matches
                .iter()
                .map(|row| row["id"].as_str().unwrap())
                .collect();
            assert_eq!(ids, expected_ids, "filter {filters}");
        }
        assert!(run_purchasing_read(
            &mut conn,
            "report-a",
            "purchases.reports",
            Some("{}"),
            Some("untrusted search"),
            20,
            0,
        )
        .await
        .is_err());
        assert!(run_purchasing_read(
            &mut conn,
            "report-a",
            "purchases.reports",
            Some(r#"{"foreignTenant":"tenant-b"}"#),
            None,
            20,
            0,
        )
        .await
        .is_err());

        for index in 0..201 {
            let id = format!("extra-{index:03}");
            sqlx::query(
                "INSERT INTO purchase_invoices (id,supplier_id,pharmacy_id,user_id,invoice_number,invoice_date,created_at,status,payment_method,total_amount,expenses,tax_percent)
                 VALUES (?,7,'tenant-a','buyer-a',?,'2026-09-01','2026-09-01 10:00:00','completed','credit',1,0,0)"
            ).bind(&id).bind(&id).execute(&mut conn).await.unwrap();
        }
        let mut page_ids = Vec::new();
        for offset in [0, 200] {
            let page = run_purchasing_read(
                &mut conn,
                "report-a",
                "purchases.reports",
                Some("{}"),
                None,
                200,
                offset,
            )
            .await
            .unwrap();
            assert_eq!(page.len(), if offset == 0 { 200 } else { 6 });
            page_ids.extend(
                page.iter()
                    .map(|row| row["id"].as_str().unwrap().to_owned()),
            );
        }
        assert_eq!(page_ids.len(), 206);
        assert_eq!(
            page_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            206
        );
        assert_eq!(
            &page_ids[..5],
            &["cash-a", "credit-a", "check-a", "historic-a", "orphan-a"]
        );
        assert_eq!(page_ids.last().unwrap(), "extra-000");
        assert!(!page_ids
            .iter()
            .any(|id| id == "foreign-b" || id == "draft-a" || id == "unowned"));
        assert!(run_purchasing_read(
            &mut conn,
            "report-a",
            "purchases.reports",
            Some("{}"),
            None,
            201,
            0,
        )
        .await
        .is_err());
    }
}
