//! Typed, paginated native read boundary. Renderer chooses only a known query
//! ID and scalar values; it cannot submit SQL or its claimed pharmacy/user.
//! This is the migration target for legacy db_select_guarded callers.

use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection};
use std::time::Duration;
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::{fetch_scoped_limited, reset_cancelled_read_state, ReadLimits};
use super::permission_policy::user_has_permission;
use super::purchasing_reads_native::run_purchasing_read;

#[derive(Clone, Copy, Debug)]
enum ScopedQuery {
    Inventory,
    SalesInvoices,
    SalesItems,
    OwnerUsers,
}

impl ScopedQuery {
    fn parse(key: &str) -> Result<Self, String> {
        match key {
            "inventory.list" => Ok(Self::Inventory),
            "sales.invoices" => Ok(Self::SalesInvoices),
            "sales.items" => Ok(Self::SalesItems),
            "staff.owner_list" => Ok(Self::OwnerUsers),
            _ => Err("Unknown native scoped read; arbitrary business SQL is not authorized".into()),
        }
    }
}

async fn run_typed_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    key: &str,
    row_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    let query = ScopedQuery::parse(key)?;
    if limit == 0 || limit > 200 || offset > 50_000 {
        return Err(
            "Native paginated read requires a page of 1-200 rows and bounded offset".into(),
        );
    }
    if row_id.is_some_and(|id| id.is_empty() || id.len() > 128 || id.contains('\0')) {
        return Err("Record identifier is invalid".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    if matches!(query, ScopedQuery::OwnerUsers) && !role.trim().eq_ignore_ascii_case("owner") {
        return Err("Only the authenticated pharmacy owner may list staff".into());
    }
    let row = sqlx::query(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let permissions: Option<String> = row.try_get("permissions").map_err(|e| e.to_string())?;
    let inventory_manager = user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_manage_inventory",
        false,
    );
    let sales_reporter = user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "rep_can_view_sales",
        false,
    );
    let pos_operator =
        user_has_permission(Some(&role), permissions.as_deref(), "can_access_pos", true);
    let allowed = match query {
        ScopedQuery::Inventory => inventory_manager || pos_operator,
        ScopedQuery::SalesInvoices | ScopedQuery::SalesItems => sales_reporter || pos_operator,
        ScopedQuery::OwnerUsers => role.trim().eq_ignore_ascii_case("owner"),
    };
    if !allowed {
        return Err(
            "Authenticated role lacks permission to read the requested pharmacy records".into(),
        );
    }
    // All SQL is a native immutable literal and each tenant is derived from
    // the current database-authenticated actor, never renderer parameters.
    let statement = match query {
        ScopedQuery::Inventory if inventory_manager => {
            "SELECT t.* FROM main.inventory t \
            WHERE COALESCE(NULLIF(TRIM(t.pharmacy_id),''),'local_default')=? \
            AND (? IS NULL OR CAST(t.id AS TEXT)=?) ORDER BY t.id LIMIT ? OFFSET ?"
        }
        ScopedQuery::Inventory => {
            "SELECT t.id,t.drug_id,t.pharmacy_id,t.quantity,t.expiry_date, \
            t.barcode,t.batch_number,t.local_selling_price,t.strips_per_box FROM main.inventory t \
            WHERE COALESCE(NULLIF(TRIM(t.pharmacy_id),''),'local_default')=? \
            AND (? IS NULL OR CAST(t.id AS TEXT)=?) ORDER BY t.id LIMIT ? OFFSET ?"
        }
        ScopedQuery::SalesInvoices if sales_reporter => {
            "SELECT t.* FROM main.sales_invoices t \
            WHERE COALESCE(NULLIF(TRIM(t.pharmacy_id),''),'local_default')=? \
            AND (? IS NULL OR CAST(t.id AS TEXT)=?) ORDER BY t.id LIMIT ? OFFSET ?"
        }
        ScopedQuery::SalesInvoices => {
            "SELECT t.* FROM main.sales_invoices t \
            WHERE COALESCE(NULLIF(TRIM(t.pharmacy_id),''),'local_default')=? \
            AND CAST(t.user_id AS TEXT)=? \
            AND (? IS NULL OR CAST(t.id AS TEXT)=?) ORDER BY t.id LIMIT ? OFFSET ?"
        }
        ScopedQuery::SalesItems if sales_reporter => {
            "SELECT t.* FROM main.sales_items t \
            INNER JOIN main.sales_invoices invoice ON invoice.id=t.invoice_id \
            WHERE COALESCE(NULLIF(TRIM(invoice.pharmacy_id),''),'local_default')=? \
            AND (? IS NULL OR CAST(t.id AS TEXT)=?) ORDER BY t.id LIMIT ? OFFSET ?"
        }
        ScopedQuery::SalesItems => {
            "SELECT t.* FROM main.sales_items t \
            INNER JOIN main.sales_invoices invoice ON invoice.id=t.invoice_id \
            WHERE COALESCE(NULLIF(TRIM(invoice.pharmacy_id),''),'local_default')=? \
            AND CAST(invoice.user_id AS TEXT)=? \
            AND (? IS NULL OR CAST(t.id AS TEXT)=?) ORDER BY t.id LIMIT ? OFFSET ?"
        }
        ScopedQuery::OwnerUsers => {
            "SELECT t.id,t.username,t.full_name,t.role,t.is_active,t.pharmacy_id \
            FROM main.users t WHERE COALESCE(NULLIF(TRIM(t.pharmacy_id),''),'local_default')=? \
            AND (? IS NULL OR CAST(t.id AS TEXT)=?) ORDER BY t.id LIMIT ? OFFSET ?"
        }
    };
    let mut params = vec![json!(pharmacy_id)];
    if matches!(query, ScopedQuery::SalesInvoices | ScopedQuery::SalesItems) && !sales_reporter {
        params.push(json!(actor_id));
    }
    params.extend([json!(row_id), json!(row_id), json!(limit), json!(offset)]);
    fetch_scoped_limited(
        conn,
        statement,
        params,
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: 200,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await
}

/// A selected sales return must preserve the invoice's actual lines and the
/// finalized prior-return ledger. The date picker alone is not an authorization
/// witness; every fixed projection rechecks the live actor, owned invoice and
/// all referenced stock/return provenance, without accepting renderer SQL.
async fn run_return_invoice_detail_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    query_id: &str,
    invoice_id: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    let is_single = matches!(query_id, "returns.invoice_header" | "returns.invoice_refund");
    if !matches!(
        query_id,
        "returns.invoice_header"
            | "returns.invoice_items"
            | "returns.invoice_prior"
            | "returns.invoice_refund"
    ) || invoice_id.trim().is_empty()
        || invoice_id.len() > 128
        || invoice_id.chars().any(|c| c.is_control())
        || !(1..=200).contains(&limit)
        || offset > 50_000
        || (is_single && (limit != 1 || offset != 0))
    {
        return Err("Invalid return invoice native detail request".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    if pharmacy_id == "local_default" || pharmacy_id.trim().is_empty() {
        return Err("Legacy return invoice ownership needs independent tenant verification".into());
    }
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_view_returns",
        false,
    ) {
        return Err("Authenticated actor cannot read return invoice details".into());
    }
    let invoice_is_owned: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.sales_invoices
         WHERE id=? AND pharmacy_id=?
           AND (status IS NULL OR status='' OR status IN ('completed','approved','delivered'))",
    )
    .bind(invoice_id)
    .bind(&pharmacy_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if invoice_is_owned != 1 {
        return Err("Return invoice is missing or has unverified tenant provenance".into());
    }

    // Unknown inventory ownership, missing drug references, cross-pharmacy
    // returns, orphan return lines, and unlinked historic returns make the
    // quantity/refund preview untrustworthy. Reject *all* projections so that
    // the renderer can never replace uncertainty with a zero balance.
    let uncertain: i64 = sqlx::query_scalar(
        r#"SELECT EXISTS(
             SELECT 1 FROM main.sales_invoices invoice
             WHERE invoice.id=? AND NOT EXISTS(
               SELECT 1 FROM main.native_sale_cogs_provenance sale_proof
               JOIN main.daily_journals j ON j.id=sale_proof.journal_id
               WHERE sale_proof.sale_id=invoice.id
                 AND sale_proof.pharmacy_id=?
                 AND sale_proof.actor_id=invoice.user_id
                 AND j.pharmacy_id=sale_proof.pharmacy_id
                 AND ABS(sale_proof.sale_micros-invoice.total_amount*1000000)<2
                 AND sale_proof.line_count=(
                   SELECT COUNT(*) FROM main.sales_items WHERE invoice_id=invoice.id
                 )
             )
           ) OR EXISTS(
             SELECT 1 FROM main.sales_invoices invoice
             WHERE invoice.id=? AND invoice.patient_id IS NOT NULL
               AND NOT EXISTS(
                 SELECT 1 FROM main.native_patient_directory_ownership witness
                 WHERE witness.patient_id=invoice.patient_id
                   AND witness.pharmacy_id=?
               )
           ) OR EXISTS(
             SELECT 1 FROM main.sales_items si
             LEFT JOIN main.inventory inv
               ON inv.id=si.inventory_id AND inv.pharmacy_id=?
             LEFT JOIN main.master_drugs md ON md.id=si.drug_id
             WHERE si.invoice_id=?
               AND (si.inventory_id IS NULL OR inv.id IS NULL OR md.id IS NULL
                    OR inv.drug_id IS NULL OR inv.drug_id<>si.drug_id
                    OR si.quantity_sold IS NULL OR si.quantity_sold<=0
                    OR si.unit_price IS NULL OR si.unit_price<0)
           ) OR EXISTS(
             SELECT 1 FROM main.returns r WHERE r.invoice_id=?
               AND (r.pharmacy_id IS NULL OR r.pharmacy_id<>?
                    OR (LOWER(COALESCE(r.status,'')) IN ('approved','completed')
                        AND (r.total_refund IS NULL OR r.total_refund<0)))
           ) OR EXISTS(
             SELECT 1 FROM main.return_items ri
             JOIN main.returns r ON r.id=ri.return_id
             WHERE r.invoice_id=?
               AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
               AND (ri.sale_item_id IS NULL
                    OR ri.quantity_returned IS NULL OR ri.quantity_returned<=0
                    OR NOT EXISTS(
                      SELECT 1 FROM main.sales_items si
                      WHERE si.id=ri.sale_item_id AND si.invoice_id=?
                        AND ri.inventory_id IS NOT NULL AND ri.inventory_id=si.inventory_id
                    ))
           ) OR EXISTS(
             SELECT 1 FROM main.returns r WHERE r.invoice_id=?
               AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
               AND NOT EXISTS(SELECT 1 FROM main.return_items ri WHERE ri.return_id=r.id)
           ) OR EXISTS(
             SELECT 1 FROM main.returns r WHERE r.invoice_id=?
               AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
               AND NOT EXISTS(
                 SELECT 1 FROM main.native_sale_return_cogs_provenance prior_proof
                 JOIN main.daily_journals j ON j.id=prior_proof.journal_id
                 WHERE prior_proof.return_id=r.id
                   AND prior_proof.sale_id=r.invoice_id
                   AND prior_proof.pharmacy_id=?
                   AND prior_proof.actor_id=r.user_id
                   AND j.pharmacy_id=prior_proof.pharmacy_id
                   AND ABS(prior_proof.refund_micros-r.total_refund*1000000)<2
                   AND prior_proof.line_count=(
                     SELECT COUNT(*) FROM main.return_items WHERE return_id=r.id
                   )
               )
           )"#,
    )
    .bind(invoice_id)
    .bind(&pharmacy_id)
    .bind(invoice_id)
    .bind(&pharmacy_id)
    .bind(&pharmacy_id)
    .bind(invoice_id)
    .bind(invoice_id)
    .bind(&pharmacy_id)
    .bind(invoice_id)
    .bind(invoice_id)
    .bind(invoice_id)
    .bind(invoice_id)
    .bind(&pharmacy_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if uncertain != 0 {
        return Err("Return invoice stock or prior return ownership is incomplete".into());
    }
    let (sql, params, max_rows): (&str, Vec<Value>, usize) = match query_id {
        "returns.invoice_header" => (
            r#"SELECT inv.id,inv.pharmacy_id,inv.user_id,inv.patient_id,
                  inv.total_amount,inv.discount_amount,inv.paid_amount,
                  inv.remaining_amount,inv.created_at,inv.status,inv.payment_method,
                  CAST(NULL AS TEXT) AS patient_name,
                  CAST(NULL AS TEXT) AS user_name
               FROM main.sales_invoices inv
               WHERE inv.id=? AND inv.pharmacy_id=? LIMIT 1"#,
            vec![json!(invoice_id),json!(pharmacy_id)],
            1,
        ),
        "returns.invoice_items" => (
            r#"SELECT si.id,si.invoice_id,si.inventory_id,si.drug_id,
                  si.quantity_sold,si.unit_price,si.unit,
                  md.trade_name,md.trade_name_en,md.active_ingredient,
                  md.large_unit,md.medium_unit,md.small_unit,
                  COALESCE(NULLIF(si.large_to_medium,0),NULLIF(inv.strips_per_box,0),
                           NULLIF(md.large_to_medium,0),1) AS large_to_medium,
                  COALESCE(NULLIF(si.medium_to_small,0),NULLIF(inv.medium_to_small,0),
                           NULLIF(md.medium_to_small,0),1) AS medium_to_small,
                  inv.expiry_date
               FROM main.sales_items si
               INNER JOIN main.sales_invoices invoice
                 ON invoice.id=si.invoice_id AND invoice.pharmacy_id=?
               INNER JOIN main.inventory inv
                 ON inv.id=si.inventory_id AND inv.pharmacy_id=?
               INNER JOIN main.master_drugs md ON md.id=si.drug_id
               WHERE si.invoice_id=? ORDER BY si.id LIMIT ? OFFSET ?"#,
            vec![json!(pharmacy_id),json!(pharmacy_id),json!(invoice_id),json!(limit),json!(offset)],
            limit as usize,
        ),
        "returns.invoice_prior" => (
            r#"SELECT ri.sale_item_id,ri.quantity_returned,ri.unit
               FROM main.return_items ri
               INNER JOIN main.returns r ON r.id=ri.return_id
               INNER JOIN main.sales_invoices invoice
                 ON invoice.id=r.invoice_id AND invoice.pharmacy_id=?
               WHERE r.invoice_id=? AND r.pharmacy_id=?
                 AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
               ORDER BY r.created_at,r.id,ri.id LIMIT ? OFFSET ?"#,
            vec![json!(pharmacy_id),json!(invoice_id),json!(pharmacy_id),json!(limit),json!(offset)],
            limit as usize,
        ),
        "returns.invoice_refund" => (
            r#"SELECT COALESCE(SUM(r.total_refund),0) AS total
               FROM main.returns r INNER JOIN main.sales_invoices invoice
                 ON invoice.id=r.invoice_id AND invoice.pharmacy_id=?
               WHERE r.invoice_id=? AND r.pharmacy_id=?
                 AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')"#,
            vec![json!(pharmacy_id),json!(invoice_id),json!(pharmacy_id)],
            1,
        ),
        _ => unreachable!(),
    };
    fetch_scoped_limited(
        conn,
        sql,
        params,
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows,
            max_bytes: 2 * 1024 * 1024,
        },
    ).await
}

// The register is a fixed projection of immutable posted return receipts and
// their posted original sales. Unowned legacy rows, unreceipted rows, detached
// sale lines and lots have no tenant provenance and cannot enter this CTE.
// The only bound scope is the tenant of the database-authenticated actor.
const VERIFIED_RETURN_HISTORY_CTE: &str = r#"
WITH scope AS (SELECT ? AS tenant), verified AS (
  SELECT r.id,r.invoice_id,r.pharmacy_id,r.user_id,r.reason,
         r.total_refund,r.refund_method,r.status,r.created_at,
         sale.patient_id,receipt.line_count AS item_count,
         sale.total_amount AS invoice_total,sale.created_at AS invoice_date,
         u.full_name AS user_name,p.full_name AS patient_name
  FROM main.returns r
  JOIN main.native_sale_return_cogs_provenance receipt
    ON receipt.return_id=r.id AND receipt.sale_id=r.invoice_id
    AND receipt.pharmacy_id=r.pharmacy_id AND receipt.actor_id=r.user_id
    AND receipt.refund_method=r.refund_method
    AND ABS(receipt.refund_micros-r.total_refund*1000000)<2
    AND receipt.line_count>0 AND receipt.line_count=(
      SELECT COUNT(*) FROM main.return_items WHERE return_id=r.id)
  JOIN main.daily_journals return_journal
    ON return_journal.id=receipt.journal_id
    AND return_journal.pharmacy_id=receipt.pharmacy_id
    AND CAST(return_journal.created_by AS TEXT)=receipt.actor_id
    AND ABS(return_journal.total_amount*1000000-
            (receipt.refund_micros+receipt.cogs_micros))<2
  JOIN main.sales_invoices sale
    ON sale.id=r.invoice_id AND sale.pharmacy_id=r.pharmacy_id
    AND sale.status='completed' AND sale.total_amount>=0
  JOIN main.native_sale_cogs_provenance sale_receipt
    ON sale_receipt.sale_id=sale.id AND sale_receipt.pharmacy_id=sale.pharmacy_id
    AND sale_receipt.actor_id=sale.user_id
    AND sale_receipt.payment_method=sale.payment_method
    AND ABS(sale_receipt.sale_micros-sale.total_amount*1000000)<2
    AND sale_receipt.line_count>0 AND sale_receipt.line_count=(
      SELECT COUNT(*) FROM main.sales_items WHERE invoice_id=sale.id)
  JOIN main.daily_journals sale_journal
    ON sale_journal.id=sale_receipt.journal_id
    AND sale_journal.pharmacy_id=sale_receipt.pharmacy_id
    AND CAST(sale_journal.created_by AS TEXT)=sale_receipt.actor_id
    AND ABS(sale_journal.total_amount*1000000-
            (sale_receipt.sale_micros+sale_receipt.cogs_micros))<2
  JOIN main.users u ON CAST(u.id AS TEXT)=CAST(r.user_id AS TEXT)
    AND u.pharmacy_id=r.pharmacy_id
  LEFT JOIN main.native_patient_directory_ownership patient_owner
    ON patient_owner.patient_id=sale.patient_id
    AND patient_owner.pharmacy_id=r.pharmacy_id
  LEFT JOIN main.patients p ON p.id=patient_owner.patient_id
  WHERE r.pharmacy_id=(SELECT tenant FROM scope)
    AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
    AND r.total_refund>=0
    AND NOT EXISTS (
      SELECT 1 FROM main.sales_items sold
      LEFT JOIN main.inventory lot ON lot.id=sold.inventory_id
        AND lot.pharmacy_id=r.pharmacy_id AND lot.drug_id=sold.drug_id
      LEFT JOIN main.master_drugs drug ON drug.id=sold.drug_id
      WHERE sold.invoice_id=sale.id
        AND (sold.inventory_id IS NULL OR lot.id IS NULL OR drug.id IS NULL
          OR sold.quantity_sold IS NULL OR sold.quantity_sold<=0
          OR sold.unit_price IS NULL OR sold.unit_price<0)
    )
    AND NOT EXISTS (
      SELECT 1 FROM main.return_items line
      LEFT JOIN main.sales_items sold ON sold.id=line.sale_item_id
        AND sold.invoice_id=sale.id
      LEFT JOIN main.inventory lot ON lot.id=line.inventory_id
        AND lot.pharmacy_id=r.pharmacy_id
      LEFT JOIN main.master_drugs drug ON drug.id=line.drug_id
      WHERE line.return_id=r.id
        AND (line.sale_item_id IS NULL OR sold.id IS NULL OR
          line.inventory_id IS NULL OR
          lot.id IS NULL OR drug.id IS NULL OR
          line.drug_id IS NULL OR line.drug_id<>sold.drug_id OR
          lot.drug_id<>sold.drug_id OR
          line.quantity_returned IS NULL OR line.quantity_returned<=0 OR
          line.unit IS NULL OR TRIM(line.unit)='' OR
          line.unit_price IS NULL OR line.unit_price<0 OR
          line.total_price IS NULL OR line.total_price<0)
    )
)
"#;

async fn run_return_history_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    query_id: &str,
    record_id: Option<&str>,
    search: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    if !(1..=200).contains(&limit) || offset>50_000 ||
       !matches!(query_id,"returns.list" | "returns.list_items") ||
       (query_id=="returns.list" && record_id.is_some()) ||
       (query_id=="returns.list_items" && (record_id.is_none() || search.is_some())) ||
       record_id.is_some_and(|id| id.trim().is_empty() || id.len()>128 ||
           id.chars().any(|c| c.is_control())) ||
       search.is_some_and(|s| s.len()>512 || s.chars().count()>128 ||
           s.chars().any(|c| c.is_control())) {
        return Err("Invalid native return history request".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id)=active_generic_actor(conn,actor_id).await?;
    if pharmacy_id.trim().is_empty() || pharmacy_id=="local_default" {
        return Err("Legacy return history tenant ownership cannot be inferred".into());
    }
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    ).bind(actor_id).fetch_one(&mut *conn).await.map_err(|error|error.to_string())?;
    if !user_has_permission(Some(&role), permissions.as_deref(), "can_view_returns", false) {
        return Err("Authenticated actor cannot view return history".into());
    }
    // Every explicitly owned row in the register must have a complete receipt
    // and sale/lot lineage. Omitting a damaged, unposted or pending row would
    // misrepresent the register as complete (possibly even as empty). Unowned
    // legacy rows are excluded: none can be attributed to the current tenant.
    let completeness_sql=format!("{VERIFIED_RETURN_HISTORY_CTE}
      SELECT EXISTS(SELECT 1 FROM main.returns owned
        WHERE owned.pharmacy_id=? AND (? IS NULL OR owned.id=?)
          AND NOT EXISTS(SELECT 1 FROM verified proven WHERE proven.id=owned.id))");
    let incompleteness: i64=sqlx::query_scalar(&completeness_sql)
        .bind(&pharmacy_id).bind(&pharmacy_id)
        .bind(record_id).bind(record_id)
        .fetch_one(&mut *conn).await.map_err(|error|error.to_string())?;
    if incompleteness!=0 {
        return Err("Native return history contains unverified tenant-owned records".into());
    }
    let mut params=vec![json!(pharmacy_id)];
    let sql=if query_id=="returns.list" {
        let search=search.map(str::trim).filter(|s| !s.is_empty());
        let escaped=search.map(|s| {
            let mut escaped=String::with_capacity(s.len());
            for c in s.chars() {
                if matches!(c, '%'|'_'|'\\') { escaped.push('\\'); }
                escaped.push(c);
            }
            format!("%{escaped}%")
        });
        params.extend([
            json!(escaped),json!(escaped),json!(escaped),
            json!(escaped),json!(escaped),json!(limit),json!(offset),
        ]);
        format!("{VERIFIED_RETURN_HISTORY_CTE}
          SELECT * FROM verified r WHERE (? IS NULL OR
            r.id LIKE ? ESCAPE '\\' OR r.invoice_id LIKE ? ESCAPE '\\'
            OR COALESCE(r.patient_name,'') LIKE ? ESCAPE '\\'
            OR COALESCE(r.user_name,'') LIKE ? ESCAPE '\\')
          ORDER BY r.created_at DESC,r.id DESC LIMIT ? OFFSET ?")
    } else {
        params.extend([json!(record_id),json!(limit),json!(offset)]);
        format!("{VERIFIED_RETURN_HISTORY_CTE}
          SELECT line.id,line.return_id,line.inventory_id,line.drug_id,
                 line.quantity_returned,line.unit_price,line.total_price,
                 line.sale_item_id,line.unit,drug.trade_name AS trade_name_ar,
                 drug.trade_name_en
          FROM main.return_items line
          JOIN verified r ON r.id=line.return_id
          JOIN main.sales_items sold ON sold.id=line.sale_item_id
             AND sold.invoice_id=r.invoice_id AND sold.drug_id=line.drug_id
          JOIN main.inventory lot ON lot.id=line.inventory_id
             AND lot.pharmacy_id=r.pharmacy_id AND lot.drug_id=line.drug_id
          JOIN main.master_drugs drug ON drug.id=line.drug_id
          WHERE r.id=? ORDER BY line.id LIMIT ? OFFSET ?")
    };
    fetch_scoped_limited(conn,&sql,params,ReadLimits {
        max_duration:Duration::from_secs(4),max_rows:limit as usize,
        max_bytes:2*1024*1024,
    }).await
}

/// Inventory-list view used by the renderer. The actor and tenant are always
/// read from the live native session; search text and drug ID are filters only.
async fn run_inventory_enriched_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    search: Option<&str>,
    drug_id: Option<i64>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    if limit == 0 || limit > 200 || offset > 50_000 {
        return Err("Native inventory pagination requires 1-200 rows and bounded offset".into());
    }
    if drug_id.is_some_and(|id| id <= 0) {
        return Err("Drug identifier is invalid".into());
    }
    let search = search.map(str::trim).filter(|text| !text.is_empty());
    if search.is_some_and(|text| text.len() > 128 || text.contains('\0')) {
        return Err("Inventory search term is invalid".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let row = sqlx::query(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    let permissions: Option<String> = row
        .try_get("permissions")
        .map_err(|error| error.to_string())?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_view_stores",
        false,
    ) {
        return Err("Authenticated role cannot view pharmacy inventory".into());
    }
    let can_view_cost = user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_manage_inventory",
        false,
    );
    let search = if drug_id.is_none() { search } else { None };
    let like = search.map(|text| format!("%{text}%"));
    // Explicit projections preserve the inventory action's existing mapping;
    // neither arbitrary SQL nor claimed pharmacy IDs arrive from the renderer.
    let sql = r#"SELECT i.id,i.drug_id,i.quantity,i.expiry_date,i.local_selling_price,
               CASE WHEN ?=1 THEN i.cost_price ELSE NULL END AS cost_price,i.strips_per_box,
               COALESCE(NULLIF(i.barcode,''),NULLIF(m.barcode,'')) AS barcode,
               i.barcode AS lot_barcode,m.barcode AS drug_barcode,
               m.trade_name,m.trade_name_en,m.generic_name,m.active_ingredient,
               m.category,m.manufacturer,m.large_to_medium
               FROM main.inventory i JOIN main.master_drugs m ON i.drug_id=m.id
               WHERE i.quantity > 0
                 AND COALESCE(NULLIF(TRIM(i.pharmacy_id),''),'local_default')=?
                 AND (? IS NULL OR i.drug_id=?)
                 AND (? IS NULL OR i.barcode=? OR m.barcode=?
                   OR m.trade_name LIKE ? OR m.trade_name_en LIKE ?
                   OR m.generic_name LIKE ? OR m.active_ingredient LIKE ?)
               ORDER BY i.expiry_date ASC,i.id ASC LIMIT ? OFFSET ?"#;
    fetch_scoped_limited(
        conn,
        sql,
        vec![
            json!(can_view_cost),
            json!(pharmacy_id),
            json!(drug_id),
            json!(drug_id),
            json!(search),
            json!(search),
            json!(search),
            json!(like),
            json!(like),
            json!(like),
            json!(like),
            json!(limit),
            json!(offset),
        ],
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: 200,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await
}

/// A fixed, one-row native sales report. SQL, actor, and pharmacy cannot be
/// supplied by the renderer; the existing local calendar/status rules apply.
async fn run_sales_dashboard_stats_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
) -> Result<Vec<Value>, String> {
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let row = sqlx::query(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let permissions: Option<String> = row.try_get("permissions").map_err(|e| e.to_string())?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "rep_can_view_sales",
        false,
    ) {
        return Err("Authenticated role cannot view sales reporting".into());
    }
    let sql = r#"
        SELECT
          COALESCE(SUM(CASE WHEN DATE(t.created_at,'localtime')=DATE('now','localtime')
            AND (t.status IS NULL OR t.status='' OR t.status IN ('completed','approved','delivered'))
            THEN t.total_amount ELSE 0 END),0) AS today_total,
          COALESCE(SUM(CASE WHEN DATE(t.created_at,'localtime')=DATE('now','-1 day','localtime')
            AND (t.status IS NULL OR t.status='' OR t.status IN ('completed','approved','delivered'))
            THEN t.total_amount ELSE 0 END),0) AS yesterday_total,
          COALESCE(SUM(CASE WHEN t.payment_method='delivery'
            AND DATE(t.created_at,'localtime')=DATE('now','localtime')
            AND (t.status IS NULL OR t.status='' OR t.status IN ('completed','approved','delivered'))
            THEN 1 ELSE 0 END),0) AS delivery_count,
          COALESCE(SUM(CASE WHEN t.payment_method='delivery' AND t.status='completed'
            THEN 1 ELSE 0 END),0) AS pending_delivery_count,
          COALESCE(AVG(CASE WHEN DATE(t.created_at,'localtime')=DATE('now','localtime')
            AND (t.status IS NULL OR t.status='' OR t.status IN ('completed','approved','delivered'))
            THEN t.total_amount END),0) AS today_average,
          COALESCE(AVG(CASE WHEN DATE(t.created_at,'localtime')=DATE('now','-1 day','localtime')
            AND (t.status IS NULL OR t.status='' OR t.status IN ('completed','approved','delivered'))
            THEN t.total_amount END),0) AS yesterday_average
        FROM main.sales_invoices t
        WHERE (t.pharmacy_id=? OR (t.pharmacy_id IS NULL AND ?='local_default'))
        LIMIT 1
    "#;
    fetch_scoped_limited(
        conn,
        sql,
        vec![json!(pharmacy_id), json!(pharmacy_id)],
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: 1,
            max_bytes: 4096,
        },
    )
    .await
}

/// Suspended POS invoice retrieval is a three-part, fixed SQL read contract.
/// Every part rechecks the native actor and its pharmacy; an invoice ID from the
/// renderer is a *filter*, never evidence that the caller owns the invoice.
async fn run_suspended_invoice_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    query_id: &str,
    record_id: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    if limit == 0 || limit > 200 || offset > 50_000 {
        return Err("Suspended invoice read requires a bounded page".into());
    }
    let invoice_id = match query_id {
        "sales.suspended.list" if record_id.is_none() => None,
        "sales.suspended.items" | "sales.suspended.batches" => {
            match record_id.filter(|id| !id.is_empty() && id.len() <= 128 && !id.contains('\0')) {
                Some(id) => Some(id),
                None => return Err("A valid suspended invoice ID is required".into()),
            }
        }
        _ => return Err("Unknown suspended invoice query or unexpected record ID".into()),
    };
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let row = sqlx::query(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let permissions: Option<String> = row.try_get("permissions").map_err(|e| e.to_string())?;
    if !user_has_permission(Some(&role), permissions.as_deref(), "can_access_pos", true)
        || !user_has_permission(
            Some(&role),
            permissions.as_deref(),
            "show_suspended_invoices",
            false,
        )
    {
        return Err("Authenticated role cannot view suspended POS invoices".into());
    }

    let (statement, mut params) = match query_id {
        "sales.suspended.list" => (
            r#"SELECT si.id,si.total_amount,si.created_at,
                p.full_name AS patient_name,si.patient_id,si.payment_method,
                si.check_number,si.discount_amount
                FROM main.sales_invoices si
                LEFT JOIN main.patients p ON si.patient_id=p.id
                WHERE si.pharmacy_id=? AND si.status='draft'
                ORDER BY si.created_at DESC,si.id DESC LIMIT ? OFFSET ?"#,
            vec![json!(pharmacy_id)],
        ),
        "sales.suspended.items" => (
            r#"SELECT si.drug_id,si.quantity_sold AS qty,si.unit_price AS price,
                COALESCE(si.item_discount_percent,0) AS item_discount_percent,
                si.unit AS selectedUnit,si.is_negative,
                md.trade_name,md.trade_name_en,md.active_ingredient,
                md.large_unit,md.medium_unit,md.small_unit,
                md.large_to_medium,md.medium_to_small,md.official_price
                FROM main.sales_items si
                INNER JOIN main.sales_invoices invoice ON invoice.id=si.invoice_id
                LEFT JOIN main.master_drugs md ON si.drug_id=md.id
                WHERE invoice.id=? AND invoice.pharmacy_id=? AND invoice.status='draft'
                ORDER BY si.id ASC LIMIT ? OFFSET ?"#,
            vec![json!(invoice_id), json!(pharmacy_id)],
        ),
        "sales.suspended.batches" => (
            r#"SELECT i.id AS inventory_id,i.drug_id,i.quantity,i.expiry_date,
                i.local_selling_price,i.strips_per_box,i.medium_to_small
                FROM main.inventory i
                WHERE i.drug_id IN (
                    SELECT DISTINCT si.drug_id FROM main.sales_items si
                    INNER JOIN main.sales_invoices invoice ON invoice.id=si.invoice_id
                    WHERE invoice.id=? AND invoice.pharmacy_id=? AND invoice.status='draft'
                      AND COALESCE(si.is_negative,0)=0
                )
                  AND (i.pharmacy_id=? OR (i.pharmacy_id IS NULL AND ?='local_default'))
                  AND i.quantity>0
                  AND (COALESCE((
                    SELECT md.has_expiry FROM main.master_drugs md WHERE md.id=i.drug_id
                  ),1)=0 OR i.expiry_date IS NOT NULL)
                  AND (i.expiry_date IS NULL OR i.expiry_date>=DATE('now','localtime'))
                ORDER BY CASE WHEN i.expiry_date IS NULL THEN 1 ELSE 0 END,
                         i.expiry_date ASC,i.created_at ASC,i.id ASC LIMIT ? OFFSET ?"#,
            vec![
                json!(invoice_id),
                json!(pharmacy_id),
                json!(pharmacy_id),
                json!(pharmacy_id),
            ],
        ),
        _ => return Err("Unknown suspended invoice query".into()),
    };
    params.extend([json!(limit), json!(offset)]);
    fetch_scoped_limited(
        conn,
        statement,
        params,
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: 200,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await
}

/// Fixed purchase-invoice list with keyset pagination. record_id carries a
/// JSON [created_at,id] cursor only; actor, permissions and tenant come from
/// the authenticated native user, never from the renderer.
async fn run_purchase_invoice_list_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    cursor: Option<&str>,
    limit: u32,
) -> Result<Vec<Value>, String> {
    if limit == 0 || limit > 200 {
        return Err("Purchase invoice list page size must be 1-200".into());
    }
    let cursor: Option<(Option<String>, String)> = cursor
        .map(|text| {
            if text.len() > 768 || text.contains('\0') {
                return Err("Invalid purchase invoice keyset cursor".to_string());
            }
            let (created_at, id): (Option<String>, String) =
                serde_json::from_str(text).map_err(|_| "Malformed purchase invoice cursor")?;
            if id.is_empty()
                || id.len() > 256
                || id.contains('\0')
                || created_at
                    .as_ref()
                    .is_some_and(|date| date.len() > 256 || date.contains('\0'))
            {
                return Err("Invalid purchase invoice keyset cursor".into());
            }
            Ok((created_at, id))
        })
        .transpose()?;

    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    if pharmacy_id == "local_default" {
        return Err("Legacy purchasing ownership needs independent tenant verification".into());
    }
    let row = sqlx::query(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let permissions: Option<String> = row.try_get("permissions").map_err(|e| e.to_string())?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_view_purchases",
        false,
    ) {
        return Err("Authenticated role cannot view purchase invoices".into());
    }

    // Preserve invoice.*, the original INNER supplier join and drug name
    // aggregation. A user linked across pharmacies must not disclose unrelated
    // staff personal data.
    let sql = r#"
        SELECT i.*, s.name_ar AS supplier_name, s.phone AS supplier_phone,
               u.full_name AS user_name,
               (
                 SELECT GROUP_CONCAT(md.trade_name, ' ')
                 FROM main.purchase_invoice_items pii
                 JOIN main.master_drugs md ON pii.drug_id=md.id
                 WHERE pii.invoice_id=i.id
               ) AS drug_names
        FROM main.purchase_invoices i
        JOIN main.suppliers s ON i.supplier_id=s.id
        LEFT JOIN main.users u ON i.user_id=u.id
          AND COALESCE(NULLIF(TRIM(u.pharmacy_id),''),'local_default')=?
        WHERE i.pharmacy_id=?
          AND (
            ?=0
            OR (? IS NOT NULL AND (
              i.created_at < ?
              OR (i.created_at=? AND CAST(i.id AS TEXT)<?)
              OR i.created_at IS NULL
            ))
            OR (? IS NULL AND i.created_at IS NULL AND CAST(i.id AS TEXT)<?)
          )
        ORDER BY i.created_at DESC, CAST(i.id AS TEXT) DESC
        LIMIT ?
    "#;
    let (cursor_date, cursor_id) = cursor
        .map(|(created_at, id)| (created_at, Some(id)))
        .unwrap_or((None, None));
    fetch_scoped_limited(
        conn,
        sql,
        vec![
            json!(pharmacy_id),
            json!(pharmacy_id),
            json!(if cursor_id.is_some() { 1 } else { 0 }),
            json!(cursor_date),
            json!(cursor_date),
            json!(cursor_date),
            json!(cursor_id),
            json!(cursor_date),
            json!(cursor_id),
            json!(limit),
        ],
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: 200,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await
}

/// The draft picker exposes exactly the original six invoice/supplier fields.
/// An internal timestamp is added solely for stable keyset traversal and
/// removed by the frontend before returning the public action result.
async fn run_purchase_draft_list_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    cursor: Option<&str>,
    limit: u32,
) -> Result<Vec<Value>, String> {
    if limit == 0 || limit > 200 {
        return Err("Purchase draft page size must be 1-200".into());
    }
    let cursor: Option<(Option<String>, String)> = cursor
        .map(|raw| {
            if raw.len() > 768 || raw.contains('\0') {
                return Err("Invalid purchase draft keyset cursor".to_string());
            }
            let (created_at, id): (Option<String>, String) =
                serde_json::from_str(raw).map_err(|_| "Malformed purchase draft cursor")?;
            if id.is_empty()
                || id.len() > 256
                || id.contains('\0')
                || created_at
                    .as_ref()
                    .is_some_and(|value| value.len() > 256 || value.contains('\0'))
            {
                return Err("Invalid purchase draft keyset cursor".into());
            }
            Ok((created_at, id))
        })
        .transpose()?;
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    if pharmacy_id == "local_default" {
        return Err("Legacy purchasing ownership needs independent tenant verification".into());
    }
    let row = sqlx::query(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    let permissions: Option<String> = row
        .try_get("permissions")
        .map_err(|error| error.to_string())?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_view_purchases",
        false,
    ) {
        return Err("Authenticated role cannot view purchase drafts".into());
    }
    let (cursor_date, cursor_id) = cursor
        .map(|(created_at, id)| (created_at, Some(id)))
        .unwrap_or((None, None));
    fetch_scoped_limited(
        conn,
        r#"
          SELECT pi.id,pi.invoice_number,pi.invoice_date,pi.supplier_id,
                 s.name_ar AS supplier_name,pi.total_amount,
                 pi.created_at AS __cursor_created_at
          FROM main.purchase_invoices pi
          JOIN main.suppliers s ON pi.supplier_id=s.id
          WHERE pi.status='draft'
            AND pi.pharmacy_id=?
            AND (
              ?=0
              OR (? IS NOT NULL AND (
                pi.created_at < ?
                OR (pi.created_at=? AND CAST(pi.id AS TEXT)<?)
                OR pi.created_at IS NULL
              ))
              OR (? IS NULL AND pi.created_at IS NULL AND CAST(pi.id AS TEXT)<?)
            )
          ORDER BY pi.created_at DESC,CAST(pi.id AS TEXT) DESC
          LIMIT ?
        "#,
        vec![
            json!(pharmacy_id),
            json!(if cursor_id.is_some() { 1 } else { 0 }),
            json!(cursor_date),
            json!(cursor_date),
            json!(cursor_date),
            json!(cursor_id),
            json!(cursor_date),
            json!(cursor_id),
            json!(limit),
        ],
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: 200,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await
}

/// Returns zero or one complete invoice. Missing and foreign-pharmacy IDs are
/// indistinguishable to the renderer. Never trust caller-supplied branch IDs.
async fn run_purchase_invoice_get_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    invoice_id: &str,
) -> Result<Vec<Value>, String> {
    if invoice_id.is_empty() || invoice_id.len() > 256 || invoice_id.contains('\0') {
        return Err("Invalid purchase invoice ID".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    if pharmacy_id == "local_default" {
        return Err("Legacy purchasing ownership needs independent tenant verification".into());
    }
    let row = sqlx::query(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    let permissions: Option<String> = row
        .try_get("permissions")
        .map_err(|error| error.to_string())?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_view_purchases",
        false,
    ) {
        return Err("Authenticated role cannot view purchase invoices".into());
    }
    fetch_scoped_limited(
        conn,
        r#"SELECT i.* FROM main.purchase_invoices i
           WHERE i.id=? AND i.pharmacy_id=?
           LIMIT 1"#,
        vec![json!(invoice_id), json!(pharmacy_id)],
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: 1,
            max_bytes: 256 * 1024,
        },
    )
    .await
}

/// Dashboard reads use fixed projections; only the authenticated actor's
/// current pharmacy and permission set determine which rows are visible.
async fn run_dashboard_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    query_id: &str,
) -> Result<Vec<Value>, String> {
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let can_view_reports = user_has_permission(
        Some(&role), permissions.as_deref(), "rep_can_view_sales", false,
    );
    let can_view_audit = user_has_permission(
        Some(&role), permissions.as_deref(), "can_view_audit", false,
    );
    if matches!(query_id, "dashboard.trend" | "dashboard.top_items" | "dashboard.recent_sales")
        && !can_view_reports
    {
        return Err("Authenticated role cannot view pharmacy sales reports".into());
    }
    if query_id == "dashboard.audit_logs" && !can_view_audit {
        return Err("Authenticated role cannot view pharmacy audit logs".into());
    }

    let (sql, params, max_rows) = match query_id {
        "dashboard.drug_count" => (
            "SELECT COUNT(*) AS count FROM main.master_drugs".to_string(),
            vec![],
            1,
        ),
        "dashboard.trend" => (
            r#"WITH RECURSIVE dates(date) AS (
                 SELECT date('now', '-29 days', 'localtime')
                 UNION ALL SELECT date(date, '+1 day') FROM dates
                   WHERE date < date('now', 'localtime')
               )
               SELECT d.date,
                 (SELECT COALESCE(SUM(total_amount), 0) FROM main.sales_invoices
                  WHERE date(created_at, 'localtime') = d.date
                    AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
                    AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))) AS sales,
                 (SELECT COALESCE(SUM(total_refund), 0) FROM main.returns r
                  WHERE date(r.created_at, 'localtime') = d.date
                    AND LOWER(COALESCE(status, '')) IN ('approved', 'completed')
                    AND (r.pharmacy_id = ? OR (r.pharmacy_id IS NULL AND ? = 'local_default'))) AS returns,
                 (SELECT COALESCE(SUM(
                   CASE
                     WHEN (si.unit IN ('medium', 'strip', 'شريط') OR si.unit = m.medium_unit) AND COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1) > 0
                       THEN (si.quantity_sold / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1)) * COALESCE(NULLIF(si.cost_price, 0), i.cost_price, m.base_price, 0)
                     WHEN (si.unit = 'small' OR si.unit = m.small_unit) AND (COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1) * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(m.medium_to_small, 0), 1)) > 0
                       THEN (si.quantity_sold / (COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1) * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(m.medium_to_small, 0), 1))) * COALESCE(NULLIF(si.cost_price, 0), i.cost_price, m.base_price, 0)
                     ELSE si.quantity_sold * COALESCE(NULLIF(si.cost_price, 0), i.cost_price, m.base_price, 0)
                   END
                 ), 0)
                 FROM main.sales_items si
                 LEFT JOIN main.inventory i ON si.inventory_id = i.id
                 LEFT JOIN main.master_drugs m ON COALESCE(si.drug_id, i.drug_id) = m.id
                 WHERE si.invoice_id IN (
                   SELECT id FROM main.sales_invoices
                   WHERE date(created_at, 'localtime') = d.date
                     AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
                     AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
                 )) - (
                   SELECT COALESCE(SUM(
                     COALESCE(NULLIF(si.cost_price, 0), i.cost_price, m.base_price, 0) *
                     CASE
                       WHEN COALESCE(NULLIF(TRIM(ri.unit), ''), NULLIF(TRIM(si.unit), ''), 'large') IN ('medium', 'strip', 'شريط')
                         OR COALESCE(NULLIF(TRIM(ri.unit), ''), NULLIF(TRIM(si.unit), ''), 'large') = m.medium_unit
                         THEN ri.quantity_returned / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(i.strips_per_box, 0), NULLIF(m.large_to_medium, 0), 1)
                       WHEN COALESCE(NULLIF(TRIM(ri.unit), ''), NULLIF(TRIM(si.unit), ''), 'large') = 'small'
                         OR COALESCE(NULLIF(TRIM(ri.unit), ''), NULLIF(TRIM(si.unit), ''), 'large') = m.small_unit
                         THEN ri.quantity_returned / (COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(i.strips_per_box, 0), NULLIF(m.large_to_medium, 0), 1) * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(i.medium_to_small, 0), NULLIF(m.medium_to_small, 0), 1))
                       ELSE ri.quantity_returned
                     END
                   ), 0)
                   FROM main.return_items ri
                   JOIN main.returns rr ON rr.id = ri.return_id
                   LEFT JOIN main.sales_items si ON si.id = ri.sale_item_id
                   LEFT JOIN main.inventory i ON i.id = COALESCE(ri.inventory_id, si.inventory_id)
                   LEFT JOIN main.master_drugs m ON m.id = COALESCE(ri.drug_id, si.drug_id, i.drug_id)
                   WHERE date(rr.created_at, 'localtime') = d.date
                     AND LOWER(COALESCE(rr.status, '')) IN ('approved', 'completed')
                     AND (rr.pharmacy_id = ? OR (rr.pharmacy_id IS NULL AND ? = 'local_default'))
                 ) AS cogs
               FROM dates d ORDER BY d.date ASC"#.to_string(),
            vec![
                json!(pharmacy_id), json!(pharmacy_id),
                json!(pharmacy_id), json!(pharmacy_id),
                json!(pharmacy_id), json!(pharmacy_id),
                json!(pharmacy_id), json!(pharmacy_id),
            ],
            30,
        ),
        "dashboard.top_items" => (
            r#"SELECT COALESCE(NULLIF(m.trade_name_en, ''), m.trade_name, 'بدون اسم') AS name,
                 SUM(CASE
                   WHEN si.unit IN ('medium', 'strip', 'شريط') OR si.unit = m.medium_unit
                     THEN si.quantity_sold / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1)
                   WHEN si.unit = 'small' OR si.unit = m.small_unit
                     THEN si.quantity_sold / (COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1) * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(m.medium_to_small, 0), 1))
                   ELSE si.quantity_sold END) AS quantity,
                 SUM(si.quantity_sold * si.unit_price) AS revenue
               FROM main.sales_items si
               JOIN main.sales_invoices s ON si.invoice_id = s.id
               JOIN main.inventory i ON si.inventory_id = i.id
               JOIN main.master_drugs m ON i.drug_id = m.id
               WHERE date(s.created_at, 'localtime') >= date('now', '-29 days', 'localtime')
                 AND (s.status IS NULL OR s.status = '' OR s.status IN ('completed', 'approved', 'delivered'))
                 AND (s.pharmacy_id = ? OR (s.pharmacy_id IS NULL AND ? = 'local_default'))
               GROUP BY i.drug_id, name ORDER BY quantity DESC LIMIT 5"#.to_string(),
            vec![json!(pharmacy_id), json!(pharmacy_id)],
            5,
        ),
        "dashboard.recent_sales" => (
            r#"SELECT s.*, p.full_name AS patient_name
               FROM main.sales_invoices s LEFT JOIN main.patients p ON s.patient_id = p.id
               WHERE (s.pharmacy_id = ? OR (s.pharmacy_id IS NULL AND ? = 'local_default'))
                 AND (s.status IS NULL OR s.status = '' OR s.status IN ('completed', 'approved', 'delivered'))
               ORDER BY s.created_at DESC LIMIT 5"#.to_string(),
            vec![json!(pharmacy_id), json!(pharmacy_id)],
            5,
        ),
        "dashboard.audit_logs" => (
            r#"SELECT a.*, u.full_name FROM main.activity_log a
               JOIN main.users u ON a.user_id = u.id
               WHERE (a.pharmacy_id = ? OR (a.pharmacy_id IS NULL AND ? = 'local_default'))
               ORDER BY a.created_at DESC LIMIT 5"#.to_string(),
            vec![json!(pharmacy_id), json!(pharmacy_id)],
            5,
        ),
        _ => return Err("Unknown native dashboard read".into()),
    };
    fetch_scoped_limited(
        conn,
        &sql,
        params,
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await
}

/// Fixed native reporting projections. Renderer values are page size/offset
/// and a bounded number of days, not user IDs, pharmacy IDs, or SQL fragments.
async fn run_sales_reporting_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    query_id: &str,
    days: u32,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    if days == 0 || days > 366 || limit == 0 || limit > 200 || offset > 50_000 {
        return Err("Native sales reporting window or page is invalid".into());
    }
    if matches!(
        query_id,
        "reports.top_drugs" | "reports.categories" | "reports.total_units" | "reports.kpis"
    ) && (offset != 0 || limit != 1)
    {
        return Err("Reporting aggregate does not accept pagination".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "rep_can_view_sales",
        false,
    ) {
        return Err("Authenticated role cannot view pharmacy sales reports".into());
    }
    // The day modifier is derived solely from a checked positive integer.
    let modifier = format!("-{} days", days - 1);
    let status = "(inv.status IS NULL OR inv.status='' OR inv.status IN ('completed','approved','delivered'))";
    let (sql, params, max_rows) = match query_id {
        "reports.trend" => (
            r#"WITH RECURSIVE dates(day) AS (
                  SELECT DATE('now',?,'localtime')
                  UNION ALL SELECT DATE(day,'+1 day') FROM dates
                    WHERE day < DATE('now','localtime')
               ), daily_sales AS (
                  SELECT DATE(created_at,'localtime') AS day, SUM(total_amount) AS total
                  FROM main.sales_invoices
                  WHERE (status IS NULL OR status='' OR status IN ('completed','approved','delivered'))
                  AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
                  GROUP BY DATE(created_at,'localtime')
               ), daily_returns AS (
                  SELECT DATE(created_at,'localtime') AS day,SUM(total_refund) AS total
                  FROM main.returns WHERE LOWER(COALESCE(status,'')) IN ('approved','completed')
                  AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
                  GROUP BY DATE(created_at,'localtime')
               )
               SELECT d.day AS date,COALESCE(s.total,0) AS sales,
                      COALESCE(r.total,0) AS returns,
                      COALESCE(s.total,0)-COALESCE(r.total,0) AS net_sales
               FROM dates d LEFT JOIN daily_sales s ON s.day=d.day
               LEFT JOIN daily_returns r ON r.day=d.day ORDER BY d.day LIMIT ? OFFSET ?"#.to_string(),
            vec![json!(modifier), json!(pharmacy_id), json!(pharmacy_id), json!(limit), json!(offset)],
            limit as usize,
        ),
        "reports.sales_history" => (
            r#"SELECT inv.created_at,DATE(inv.created_at,'localtime') AS local_date,
                      inv.total_amount
                FROM main.sales_invoices inv
                WHERE DATE(inv.created_at,'localtime') >= DATE('now',?,'localtime')
                  AND COALESCE(NULLIF(TRIM(inv.pharmacy_id),''),'local_default')=?
                  AND (inv.status IS NULL OR inv.status='' OR inv.status IN ('completed','approved','delivered'))
                ORDER BY inv.created_at,inv.id LIMIT ? OFFSET ?"#.to_string(),
            vec![json!(modifier), json!(pharmacy_id), json!(limit), json!(offset)],
            limit as usize,
        ),
        "reports.top_drugs" | "reports.categories" => {
            let group = if query_id == "reports.top_drugs" { "md.trade_name" } else { "md.category" };
            let output = if query_id == "reports.top_drugs" { "trade_name" } else { "category" };
            let max = if query_id == "reports.top_drugs" { 5 } else { 6 };
            // These identifiers are ONLY compile-time literals selected by
            // query ID, never values supplied by the renderer.
            let sql = format!(
                "SELECT {group} AS {output}, SUM(CASE
                   WHEN si.unit IN ('medium','strip','شريط') OR si.unit=md.medium_unit
                     THEN si.quantity_sold / COALESCE(NULLIF(si.large_to_medium,0),NULLIF(md.large_to_medium,0),1)
                   WHEN si.unit='small' OR si.unit=md.small_unit
                     THEN si.quantity_sold / (COALESCE(NULLIF(si.large_to_medium,0),NULLIF(md.large_to_medium,0),1)
                          * COALESCE(NULLIF(si.medium_to_small,0),NULLIF(md.medium_to_small,0),1))
                   ELSE si.quantity_sold END) AS quantity_sold
                 FROM main.sales_items si
                 JOIN main.sales_invoices inv ON inv.id=si.invoice_id
                 JOIN main.master_drugs md ON md.id=si.drug_id
                 WHERE DATE(inv.created_at,'localtime') >= DATE('now',?,'localtime')
                   AND COALESCE(NULLIF(TRIM(inv.pharmacy_id),''),'local_default')=?
                   AND {status}
                 GROUP BY {group} ORDER BY quantity_sold DESC LIMIT {max}"
            );
            (
                sql,
                vec![json!(modifier), json!(pharmacy_id)],
                max as usize,
            )
        }
        "reports.kpis" => (
            r#"WITH actor_tenant(pharmacy) AS (SELECT ?),
                 sales_today AS (
                   SELECT COALESCE(SUM(inv.total_amount),0) AS total FROM main.sales_invoices inv
                   WHERE DATE(inv.created_at,'localtime')=DATE('now','localtime')
                     AND (inv.status IS NULL OR inv.status='' OR inv.status IN ('completed','approved','delivered'))
                     AND COALESCE(NULLIF(TRIM(inv.pharmacy_id),''),'local_default')=(SELECT pharmacy FROM actor_tenant)
                 ), costs_today AS (
                   SELECT COALESCE(SUM(CASE
                     WHEN (si.unit IN ('medium','strip','شريط') OR si.unit=md.medium_unit)
                       THEN si.quantity_sold / COALESCE(NULLIF(si.large_to_medium,0),NULLIF(md.large_to_medium,0),1)*si.cost_price
                     WHEN (si.unit='small' OR si.unit=md.small_unit)
                       THEN si.quantity_sold / (COALESCE(NULLIF(si.large_to_medium,0),NULLIF(md.large_to_medium,0),1)
                         * COALESCE(NULLIF(si.medium_to_small,0),NULLIF(md.medium_to_small,0),1))*si.cost_price
                     ELSE si.quantity_sold*si.cost_price END),0) AS total
                   FROM main.sales_items si JOIN main.sales_invoices inv ON inv.id=si.invoice_id
                   LEFT JOIN main.master_drugs md ON md.id=si.drug_id
                   WHERE DATE(inv.created_at,'localtime')=DATE('now','localtime')
                     AND (inv.status IS NULL OR inv.status='' OR inv.status IN ('completed','approved','delivered'))
                     AND COALESCE(NULLIF(TRIM(inv.pharmacy_id),''),'local_default')=(SELECT pharmacy FROM actor_tenant)
                 )
                 SELECT (SELECT total FROM sales_today) AS sales_today,
                   (SELECT total FROM sales_today)-(SELECT total FROM costs_today) AS gross_profit_today,
                   (SELECT COALESCE(SUM(CASE WHEN je.type='debit' THEN je.amount ELSE -je.amount END),0)
                    FROM main.journal_entries je JOIN main.daily_journals dj ON dj.id=je.journal_id
                    WHERE je.account_id=COALESCE((SELECT account_id FROM main.trial_balance_settings
                       WHERE category='cash_drawer' LIMIT 1),6)
                      AND COALESCE(NULLIF(TRIM(dj.pharmacy_id),''),'local_default')=(SELECT pharmacy FROM actor_tenant)) AS liquidity,
                   (SELECT COALESCE(SUM(total_amount),0) FROM main.sales_invoices
                    WHERE payment_method='delivery' AND status='completed'
                      AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=(SELECT pharmacy FROM actor_tenant)) AS pending_delivery_cash,
                   (SELECT COALESCE(SUM((sa.old_quantity-sa.new_quantity)*i.cost_price),0)
                    FROM main.stock_adjustments sa JOIN main.inventory i ON i.id=sa.inventory_id
                    WHERE DATE(sa.created_at,'localtime')=DATE('now','localtime')
                      AND sa.new_quantity<sa.old_quantity
                      AND COALESCE(NULLIF(TRIM(i.pharmacy_id),''),'local_default')=(SELECT pharmacy FROM actor_tenant)) AS shrinkage_today,
                   (SELECT COUNT(*) FROM (
                      SELECT i.drug_id FROM main.inventory i LEFT JOIN main.master_drugs m ON m.id=i.drug_id
                      WHERE COALESCE(NULLIF(TRIM(i.pharmacy_id),''),'local_default')=(SELECT pharmacy FROM actor_tenant)
                        AND (i.expiry_date IS NULL OR i.expiry_date>=DATE('now','localtime'))
                      GROUP BY i.drug_id HAVING SUM(CASE WHEN COALESCE(m.has_expiry,1)=0 OR i.expiry_date IS NOT NULL
                        THEN COALESCE(i.quantity,0) ELSE 0 END) <= COALESCE(MAX(m.reorder_point),5)
                   )) AS stock_alerts_count"#.to_string(),
            vec![json!(pharmacy_id)],
            1,
        ),
        "reports.total_units" => (
            format!(
                "SELECT COALESCE(SUM(si.quantity_sold),0) AS total
                 FROM main.sales_items si JOIN main.sales_invoices inv ON inv.id=si.invoice_id
                 WHERE DATE(inv.created_at,'localtime')>=DATE('now',?,'localtime')
                   AND COALESCE(NULLIF(TRIM(inv.pharmacy_id),''),'local_default')=? AND {status}"
            ),
            vec![json!(modifier), json!(pharmacy_id)],
            1,
        ),
        _ => return Err("Unknown native sales reporting query".into()),
    };
    fetch_scoped_limited(
        conn,
        &sql,
        params,
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await
}

/// Patient names referenced by invoices this pharmacy is entitled to report.
/// This is not a general ownership inference for the legacy patients table:
/// it exposes ONLY the original report picker projection through tenant-bound
/// completed invoices. Ambiguous cross-branch patient balances remain blocked.
async fn run_invoice_patient_picker_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    if limit == 0 || limit > 200 || offset > 50_000 {
        return Err("Patient report picker requires a bounded page".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "rep_can_view_sales",
        false,
    ) && !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_view_patients",
        false,
    ) {
        return Err("Authenticated role cannot list invoice-linked patients".into());
    }
    fetch_scoped_limited(
        conn,
        r#"SELECT p.id,p.full_name,p.name_en FROM main.patients p
           WHERE EXISTS(SELECT 1 FROM main.sales_invoices inv
             WHERE inv.patient_id=p.id
             AND COALESCE(NULLIF(TRIM(inv.pharmacy_id),''),'local_default')=?
             AND (inv.status IS NULL OR inv.status='' OR inv.status IN ('completed','approved','delivered')))
           ORDER BY p.full_name,p.id LIMIT ? OFFSET ?"#,
        vec![json!(pharmacy_id),json!(limit),json!(offset)],
        ReadLimits { max_duration: Duration::from_secs(4),max_rows: limit as usize,max_bytes:2*1024*1024 },
    ).await
}

/// Private patient reads require an immutable native creation witness. An
/// invoice association does not establish ownership of the legacy patient
/// directory, wallet, allergies, or global account balance.
async fn run_owned_patient_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    query_id: &str,
    patient_id: Option<&str>,
    search: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    let is_search = query_id == "patients.pos_search";
    let is_allergy_check = query_id == "patients.checkout_allergies";
    let is_single = matches!(query_id, "patients.pos_get" | "patients.profile");
    if !(1..=200).contains(&limit)
        || offset > 50_000
        || (is_single && (limit != 1 || offset != 0))
        || (is_single && patient_id.is_none())
        || (!is_single && !is_allergy_check && patient_id.is_some())
        || (is_allergy_check && patient_id.is_none())
        || (!is_search && search.is_some())
        || (is_search && search.is_some_and(|term| term.trim().len() < 2))
        || patient_id.is_some_and(|id| id.trim().is_empty() || id.len() > 128 || id.contains('\0'))
        || search.is_some_and(|term| term.len() > 128 || term.contains('\0'))
        || !matches!(query_id, "patients.directory" | "patients.pos_search" | "patients.pos_get" | "patients.profile" | "patients.checkout_allergies")
    {
        return Err("Invalid owned patient read or filter".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    if pharmacy_id == "local_default" || pharmacy_id.trim().is_empty() {
        return Err("Legacy patient ownership needs independent tenant verification".into());
    }
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    let can_view = user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_view_patients",
        false,
    );
    let can_pos = user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_access_pos",
        true,
    );
    if !(if matches!(query_id, "patients.directory" | "patients.profile") {
        can_view
    } else {
        can_view || can_pos
    }) {
        return Err("Patient directory permission denied".into());
    }
    // Do not quietly hide an owned patient once an unscoped transaction,
    // notice or foreign sale makes their account balance unprovable. The UI
    // must enter an error state instead of displaying a reduced directory.
    let uncertain: i64 = sqlx::query_scalar(
        r#"SELECT EXISTS(
          SELECT 1 FROM main.native_patient_directory_ownership owned
          WHERE owned.pharmacy_id=? AND (? IS NULL OR owned.patient_id=?)
            AND (
              EXISTS(SELECT 1 FROM main.sales_invoices other WHERE other.patient_id=owned.patient_id
                  AND COALESCE(NULLIF(TRIM(other.pharmacy_id),''),'local_default')<>?)
              OR EXISTS(SELECT 1 FROM main.patient_transactions pt WHERE pt.patient_id=owned.patient_id)
              OR EXISTS(SELECT 1 FROM main.financial_notices fn
                  WHERE fn.target_type='customer' AND fn.target_id=owned.patient_id)
            )
        )"#,
    )
    .bind(&pharmacy_id)
    .bind(patient_id)
    .bind(patient_id)
    .bind(&pharmacy_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if uncertain != 0 {
        return Err("Owned patient financial provenance is incomplete".into());
    }
    if is_allergy_check {
        let patient_id = patient_id.ok_or("Authenticated owned patient required")?;
        // No historic patient can be adopted by searching an old sale or by
        // supplying its global ID. Only migration 061's forward-created,
        // immutable witness permits the POS clinical safety read.
        let witness: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM main.native_patient_directory_ownership owned
             JOIN main.patients p ON p.id=owned.patient_id
             WHERE owned.patient_id=? AND owned.pharmacy_id=? LIMIT 1",
        )
        .bind(patient_id)
        .bind(&pharmacy_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
        if witness != Some(1) {
            return Err("Patient tenant ownership cannot be verified".into());
        }
        return fetch_scoped_limited(
            conn,
            "SELECT a.allergen,a.severity FROM main.patient_allergies a
             JOIN main.native_patient_directory_ownership owned
               ON owned.patient_id=a.patient_id AND owned.pharmacy_id=?
             WHERE a.patient_id=? ORDER BY a.id LIMIT ? OFFSET ?",
            vec![json!(pharmacy_id),json!(patient_id),json!(limit),json!(offset)],
            ReadLimits {
                max_duration: Duration::from_secs(4),
                max_rows: limit as usize,
                max_bytes: 512 * 1024,
            },
        )
        .await;
    }
    let pattern = search.map(|text| {
        format!(
            "%{}%",
            text.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
        )
    });
    // POS-only staff may use the financial checkout snapshot but must never
    // receive private medical notes or the full patient identity dossier.
    let projection = if matches!(query_id, "patients.pos_search" | "patients.pos_get") {
        "p.id,p.full_name,p.phone,p.credit_limit,p.wallet_balance,p.opening_balance,p.payment_method,p.points_balance"
    } else {
        "p.*"
    };
    let statement = format!(r#"SELECT {projection},
        CAST(COALESCE(p.opening_balance,0)
          + COALESCE((SELECT SUM(CAST(si.total_amount AS REAL))
              FROM main.sales_invoices si WHERE si.patient_id=p.id
                AND si.pharmacy_id=? AND si.payment_method='credit'
                AND (si.status IS NULL OR si.status='' OR LOWER(si.status) IN ('completed','approved','delivered'))),0)
          - COALESCE((SELECT SUM(CAST(r.total_refund AS REAL))
              FROM main.returns r JOIN main.sales_invoices si ON si.id=r.invoice_id
              WHERE si.patient_id=p.id AND si.pharmacy_id=? AND r.pharmacy_id=?
                AND r.refund_method='patient_account'
                AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')),0)
          AS REAL) AS outstanding_balance
        FROM main.patients p
        JOIN main.native_patient_directory_ownership owned
          ON owned.patient_id=p.id AND owned.pharmacy_id=?
        WHERE (? IS NULL OR p.id=?)
          AND (? IS NULL OR p.full_name LIKE ? ESCAPE '\' OR p.phone LIKE ? ESCAPE '\')
          AND NOT EXISTS (SELECT 1 FROM main.sales_invoices other
              WHERE other.patient_id=p.id AND COALESCE(NULLIF(TRIM(other.pharmacy_id),''),'local_default')<>?)
          AND NOT EXISTS (SELECT 1 FROM main.patient_transactions pt WHERE pt.patient_id=p.id)
          AND NOT EXISTS (SELECT 1 FROM main.financial_notices fn
              WHERE fn.target_type='customer' AND fn.target_id=p.id)
        ORDER BY p.full_name,p.id LIMIT ? OFFSET ?"#);
    fetch_scoped_limited(
        conn,
        &statement,
        vec![
            json!(pharmacy_id),
            json!(pharmacy_id),
            json!(pharmacy_id),
            json!(pharmacy_id),
            json!(patient_id),
            json!(patient_id),
            json!(pattern),
            json!(pattern),
            json!(pattern),
            json!(pharmacy_id),
            json!(limit),
            json!(offset),
        ],
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: limit as usize,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await
}

/// POS barcode inventory is pharmacy-sensitive even though drug metadata is
/// public. Fixed native projections recheck active actor and POS permission.
/// Non-inventory managers must never receive acquisition costs.
async fn run_pos_barcode_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    query_id: &str,
    barcode: Option<&str>,
    drug_id: Option<i64>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    if limit == 0 || limit > 200 || offset > 50_000 {
        return Err("POS barcode query requires a bounded result page".into());
    }
    match query_id {
        "pos.barcode_candidates" if limit != 2 || offset != 0 || drug_id.is_some() => {
            return Err("Barcode candidates require a two-row lookup".into())
        }
        "pos.barcode_first" if limit != 1 || offset != 0 || drug_id.is_some() => {
            return Err("Barcode first match requires one row".into())
        }
        "pos.barcode_batches" if barcode.is_some() || drug_id.map_or(true, |id| id <= 0) => {
            return Err("POS batches require a valid drug ID".into())
        }
        "pos.barcode_candidates" | "pos.barcode_first" => {}
        "pos.barcode_batches" => {}
        _ => return Err("Unknown POS barcode query".into()),
    }
    let barcode = if matches!(query_id, "pos.barcode_candidates" | "pos.barcode_first") {
        Some(
            barcode
                .map(str::trim)
                .filter(|text| !text.is_empty() && text.len() <= 128 && !text.contains('\0'))
                .ok_or("Barcode search term is invalid")?,
        )
    } else {
        None
    };
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if !user_has_permission(Some(&role), permissions.as_deref(), "can_access_pos", true) {
        return Err("Authenticated user cannot access pharmacy POS stock".into());
    }
    let show_cost = user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_manage_inventory",
        false,
    );
    let (statement, params) = match query_id {
        "pos.barcode_candidates" => (
            r#"SELECT DISTINCT md.id FROM main.master_drugs md
               INNER JOIN main.inventory i ON i.drug_id=md.id
               WHERE (i.barcode=? COLLATE NOCASE OR md.barcode=? COLLATE NOCASE)
                 AND COALESCE(md.stop_dealing,0)=0
                 AND COALESCE(NULLIF(TRIM(i.pharmacy_id),''),'local_default')=?
                 AND i.quantity>0 AND (COALESCE(md.has_expiry,1)=0 OR i.expiry_date IS NOT NULL)
                 AND (i.expiry_date IS NULL OR i.expiry_date>=DATE('now','localtime'))
               ORDER BY md.id LIMIT 2"#,
            vec![json!(barcode), json!(barcode), json!(pharmacy_id)],
        ),
        "pos.barcode_first" => (
            r#"SELECT md.id,md.trade_name,md.trade_name_en,md.generic_name,md.active_ingredient,
                      md.category,md.official_price,md.large_unit,md.medium_unit,md.small_unit,
                      md.large_to_medium,md.medium_to_small,md.reorder_point,
                      i.local_selling_price AS unit_price,
                      CASE WHEN ? THEN i.cost_price ELSE NULL END AS avg_cost_price,
                      i.quantity,i.expiry_date AS nearest_expiry,i.strips_per_box,i.id AS inventory_id
               FROM main.master_drugs md JOIN main.inventory i ON i.drug_id=md.id
               WHERE (i.barcode=? COLLATE NOCASE OR md.barcode=? COLLATE NOCASE)
                 AND COALESCE(md.stop_dealing,0)=0
                 AND COALESCE(NULLIF(TRIM(i.pharmacy_id),''),'local_default')=?
                 AND i.quantity>0 AND (COALESCE(md.has_expiry,1)=0 OR i.expiry_date IS NOT NULL)
                 AND (i.expiry_date IS NULL OR i.expiry_date>=DATE('now','localtime'))
               ORDER BY CASE WHEN i.expiry_date IS NULL THEN 1 ELSE 0 END,
                        i.expiry_date ASC,i.created_at ASC,i.id ASC LIMIT 1"#,
            vec![
                json!(show_cost),
                json!(barcode),
                json!(barcode),
                json!(pharmacy_id),
            ],
        ),
        "pos.barcode_batches" => (
            r#"SELECT i.id AS inventory_id,i.quantity,i.expiry_date,i.local_selling_price,
                      CASE WHEN ? THEN i.cost_price ELSE NULL END AS cost_price,
                      i.strips_per_box,i.medium_to_small
               FROM main.inventory i LEFT JOIN main.master_drugs md ON md.id=i.drug_id
               WHERE i.drug_id=? AND COALESCE(NULLIF(TRIM(i.pharmacy_id),''),'local_default')=?
                 AND i.quantity>0 AND (COALESCE(md.has_expiry,1)=0 OR i.expiry_date IS NOT NULL)
                 AND (i.expiry_date IS NULL OR i.expiry_date>=DATE('now','localtime'))
               ORDER BY CASE WHEN i.expiry_date IS NULL THEN 1 ELSE 0 END,
                        i.expiry_date ASC,i.created_at ASC,i.id ASC LIMIT ? OFFSET ?"#,
            vec![
                json!(show_cost),
                json!(drug_id),
                json!(pharmacy_id),
                json!(limit),
                json!(offset),
            ],
        ),
        _ => unreachable!(),
    };
    fetch_scoped_limited(
        conn,
        statement,
        params,
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: limit as usize,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await
}

/// Search the shared drug catalogue without allowing the renderer to select
/// inventory from another pharmacy. The catalogue is public reference data;
/// stock, price and barcode-lot matching are bound to the authenticated actor.
async fn run_pos_drug_candidates_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    term: Option<&str>,
    mode: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    if limit == 0 || limit > 200 || offset > 50_000 {
        return Err("POS drug search requires a bounded page".into());
    }
    let ingredient = match mode {
        Some("ingredient") => true,
        Some("name") => false,
        _ => return Err("POS drug search mode is invalid".into()),
    };
    let term = term
        .map(str::trim)
        .filter(|term| !term.is_empty() && term.len() <= 128 && !term.contains('\0'))
        .ok_or("POS drug search term is invalid")?;
    // SQL LIKE metacharacters are user data, not query operators.
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if !user_has_permission(Some(&role), permissions.as_deref(), "can_access_pos", true) {
        return Err("Authenticated user cannot search POS drugs".into());
    }
    let show_cost = user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_manage_inventory",
        false,
    );
    let statement = r#"SELECT md.id, md.barcode, md.trade_name, md.trade_name_en,
          md.generic_name, md.active_ingredient, md.category, md.official_price,
          md.large_unit, md.medium_unit, md.small_unit, md.large_to_medium,
          md.medium_to_small, md.reorder_point,
          COALESCE(SUM(i.quantity),0) AS total_stock,
          MIN(i.local_selling_price) AS min_price,
          CASE WHEN ? THEN AVG(i.cost_price) ELSE NULL END AS avg_cost_price,
          MIN(i.expiry_date) AS nearest_expiry, MAX(i.strips_per_box) AS max_strips
       FROM main.master_drugs md
       LEFT JOIN main.inventory i ON i.drug_id=md.id
         AND COALESCE(NULLIF(TRIM(i.pharmacy_id),''),'local_default')=?
         AND i.quantity>0 AND (COALESCE(md.has_expiry,1)=0 OR i.expiry_date IS NOT NULL)
         AND (i.expiry_date IS NULL OR i.expiry_date>=DATE('now','localtime'))
       WHERE COALESCE(md.stop_dealing,0)=0
         AND COALESCE(md.trade_name,'') <> 'SECURE'
         AND COALESCE(md.trade_name_en,'') <> 'SECURE'
         AND ((? AND (md.active_ingredient LIKE ? ESCAPE '\' OR md.generic_name LIKE ? ESCAPE '\'))
           OR (NOT ? AND (md.trade_name LIKE ? ESCAPE '\' OR md.trade_name_en LIKE ? ESCAPE '\'
                 OR md.barcode=? COLLATE NOCASE OR CAST(md.id AS TEXT)=?
                 OR EXISTS (SELECT 1 FROM main.inventory bar
                      WHERE bar.drug_id=md.id AND bar.barcode=? COLLATE NOCASE
                        AND COALESCE(NULLIF(TRIM(bar.pharmacy_id),''),'local_default')=?
                        AND bar.quantity>0
                        AND (COALESCE(md.has_expiry,1)=0 OR bar.expiry_date IS NOT NULL)
                        AND (bar.expiry_date IS NULL OR bar.expiry_date>=DATE('now','localtime'))))))
       GROUP BY md.id
       ORDER BY CASE WHEN SUM(i.quantity)>0 THEN 0 ELSE 1 END, md.id
       LIMIT ? OFFSET ?"#;
    fetch_scoped_limited(
        conn,
        statement,
        vec![
            json!(show_cost),
            json!(pharmacy_id),
            json!(ingredient),
            json!(pattern),
            json!(pattern),
            json!(ingredient),
            json!(pattern),
            json!(pattern),
            json!(term),
            json!(term),
            json!(term),
            json!(pharmacy_id),
            json!(limit),
            json!(offset),
        ],
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: limit as usize,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await
}

/// Shift reports are financial data. Authorize the immutable shift against
/// the native actor's pharmacy before returning any related row. The renderer
/// can supply a shift ID as a filter, never a tenant or permission claim.
async fn run_shift_report_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    query_id: &str,
    shift_id: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    if shift_id.trim().is_empty()
        || shift_id.len() > 128
        || shift_id.contains('\0')
        || limit == 0
        || limit > 200
        || offset > 50_000
    {
        return Err("Invalid native shift report identifier or page".into());
    }
    if query_id == "reports.shift_header" && (limit != 1 || offset != 0) {
        return Err("Shift report header requires one row".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "rep_can_view_shifts",
        false,
    ) {
        return Err("Authenticated role cannot view pharmacy shift reports".into());
    }
    // The shift is a pharmacy-owned immutable accounting boundary. Read it
    // first, rather than trusting the caller to prevalidate an ID in JS.
    let is_owned: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM main.shifts s WHERE s.id=? AND COALESCE(NULLIF(TRIM(s.pharmacy_id),''),'local_default')=? LIMIT 1",
    )
    .bind(shift_id)
    .bind(&pharmacy_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if is_owned.is_none() {
        return Err("Shift is not owned by the authenticated pharmacy".into());
    }
    let (sql, params) = match query_id {
        "reports.shift_header" => (
            "SELECT s.*,u.full_name AS staff_name FROM main.shifts s
             JOIN main.users u ON u.id=s.user_id
             WHERE s.id=? AND COALESCE(NULLIF(TRIM(s.pharmacy_id),''),'local_default')=? LIMIT 1",
            vec![json!(shift_id), json!(pharmacy_id)],
        ),
        "reports.shift_sales" => (
            "SELECT payment_method,COUNT(*) AS count,SUM(total_amount) AS total,
                    SUM(COALESCE(paid_amount,total_amount)) AS paid,
                    SUM(COALESCE(remaining_amount,0)) AS remaining
             FROM main.sales_invoices WHERE shift_id=?
               AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
               AND EXISTS (SELECT 1 FROM main.shifts s WHERE s.id=shift_id
                 AND COALESCE(NULLIF(TRIM(s.pharmacy_id),''),'local_default')=?)
               AND (status IS NULL OR status='' OR status IN ('completed','approved','delivered'))
             GROUP BY payment_method ORDER BY payment_method LIMIT ? OFFSET ?",
            vec![
                json!(shift_id),
                json!(pharmacy_id),
                json!(pharmacy_id),
                json!(limit),
                json!(offset),
            ],
        ),
        "reports.shift_returns" => (
            "SELECT refund_method,COUNT(*) AS count,SUM(total_refund) AS total
             FROM main.returns WHERE shift_id=?
               AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
               AND EXISTS (SELECT 1 FROM main.shifts s WHERE s.id=shift_id
                 AND COALESCE(NULLIF(TRIM(s.pharmacy_id),''),'local_default')=?)
               AND (status IS NULL OR status='' OR LOWER(status) IN ('approved','completed'))
             GROUP BY refund_method ORDER BY refund_method LIMIT ? OFFSET ?",
            vec![
                json!(shift_id),
                json!(pharmacy_id),
                json!(pharmacy_id),
                json!(limit),
                json!(offset),
            ],
        ),
        "reports.shift_movements" => (
            "SELECT type,category,SUM(amount) AS total FROM main.cash_movements
             WHERE shift_id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
               AND EXISTS (SELECT 1 FROM main.shifts s WHERE s.id=shift_id
                 AND COALESCE(NULLIF(TRIM(s.pharmacy_id),''),'local_default')=?)
               AND LOWER(COALESCE(source_type,''))<>'main_safe'
             GROUP BY type,category ORDER BY type,category LIMIT ? OFFSET ?",
            vec![
                json!(shift_id),
                json!(pharmacy_id),
                json!(pharmacy_id),
                json!(limit),
                json!(offset),
            ],
        ),
        _ => return Err("Unknown native shift report query".into()),
    };
    fetch_scoped_limited(
        conn,
        sql,
        params,
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: limit as usize,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await
}

/// Authenticated fixed projections for the stock count/adjustment screen.
/// The previously used renderer SELECT against inventory was rejected by the
/// strict desktop policy. Both search and adjustment reason options are
/// read-only; no renderer-selected SQL, actor or tenant reaches this source.
async fn run_stock_adjustment_source_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    query_id: &str,
    search: Option<&str>,
    limit: u32,
    offset: u32,
) -> Result<Vec<Value>, String> {
    let reasons = query_id == "inventory.adjustment_reasons";
    let text = if reasons {
        if search.is_some() || limit != 100 || offset != 0 {
            return Err("Adjustment reasons require a fixed hundred-row page".into());
        }
        None
    } else if query_id == "inventory.adjustment_lots" {
        if limit != 20 || offset != 0 {
            return Err("Adjustment stock search requires a fixed twenty-row page".into());
        }
        Some(search.map(str::trim).filter(|s| s.len() >= 3 && s.len() <= 128
            && !s.chars().any(char::is_control))
            .ok_or("Invalid stock adjustment search")?)
    } else {
        return Err("Unknown stock adjustment source".into());
    };
    reset_cancelled_read_state(conn).await?;
    let (role, tenant) = active_generic_actor(conn, actor_id).await?;
    if tenant.is_empty() || tenant == "local_default" {
        return Err("Stock adjustments require independently owned pharmacy".into());
    }
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if !user_has_permission(Some(&role), permissions.as_deref(), "can_manage_inventory", false) {
        return Err("Authenticated role cannot adjust pharmacy inventory".into());
    }
    if reasons {
        return fetch_scoped_limited(
            conn,
            "SELECT id,name_ar,name_en FROM main.adjustment_reasons
             WHERE id>0 AND name_ar IS NOT NULL ORDER BY id LIMIT 100",
            vec![],
            ReadLimits { max_duration: Duration::from_secs(4), max_rows: 100, max_bytes: 256 * 1024 },
        ).await;
    }
    let term = text.unwrap();
    let escaped = term.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    // Stock zero is a legitimate adjustment source. The existing enriched
    // inventory query deliberately omits zero lots, so it cannot be reused.
    fetch_scoped_limited(
        conn,
        r#"SELECT i.id,i.drug_id,CAST(i.quantity AS REAL) AS quantity,
                  m.trade_name,m.trade_name_en,
                  COALESCE(NULLIF(i.barcode,''),NULLIF(m.barcode,'')) AS barcode
           FROM main.inventory i JOIN main.master_drugs m ON m.id=i.drug_id
           WHERE i.pharmacy_id=? AND typeof(i.quantity) IN ('real','integer')
             AND i.quantity>=0
             AND (m.trade_name LIKE ? ESCAPE '\' COLLATE NOCASE
               OR m.trade_name_en LIKE ? ESCAPE '\' COLLATE NOCASE
               OR i.barcode=? COLLATE NOCASE OR m.barcode=? COLLATE NOCASE)
           ORDER BY i.id ASC LIMIT 20"#,
        vec![json!(tenant),json!(pattern),json!(pattern),json!(term),json!(term)],
        ReadLimits { max_duration: Duration::from_secs(4), max_rows: 20, max_bytes: 256 * 1024 },
    ).await
}

#[tauri::command]
pub async fn db_read_scoped(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    query_id: String,
    record_id: Option<String>,
    limit: u32,
    offset: u32,
    search: Option<String>,
    drug_id: Option<i64>,
) -> Result<Vec<Value>, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    if matches!(query_id.as_str(), "returns.list" | "returns.list_items") {
        if drug_id.is_some() {
            return Err("Return history does not accept drug filters".into());
        }
        return run_return_history_query(
            &mut conn,
            actor.as_deref().ok_or("Authenticated return actor required")?,
            &query_id,record_id.as_deref(),search.as_deref(),limit,offset,
        ).await;
    }
    if matches!(
        query_id.as_str(),
        "returns.invoice_header"
            | "returns.invoice_items"
            | "returns.invoice_prior"
            | "returns.invoice_refund"
    ) {
        if search.is_some() || drug_id.is_some() {
            return Err("Return invoice detail does not accept search or drug filters".into());
        }
        return run_return_invoice_detail_query(
            &mut conn,
            actor.as_deref().ok_or("Authenticated return actor required")?,
            &query_id,
            record_id.as_deref().ok_or("Return invoice ID is required")?,
            limit,
            offset,
        )
        .await;
    }
    if matches!(
        query_id.as_str(),
        "reports.shift_header"
            | "reports.shift_sales"
            | "reports.shift_returns"
            | "reports.shift_movements"
    ) {
        if search.is_some() || drug_id.is_some() {
            return Err("Shift report does not accept search or drug filters".into());
        }
        return run_shift_report_query(
            &mut conn,
            actor.as_deref().unwrap(),
            &query_id,
            record_id
                .as_deref()
                .ok_or("Shift report requires a shift ID")?,
            limit,
            offset,
        )
        .await;
    }
    if query_id == "pos.search_candidates" {
        if drug_id.is_some() {
            return Err("POS text search cannot accept a drug identifier".into());
        }
        return run_pos_drug_candidates_query(
            &mut conn,
            actor.as_deref().unwrap(),
            search.as_deref(),
            record_id.as_deref(),
            limit,
            offset,
        )
        .await;
    }
    if matches!(
        query_id.as_str(),
        "pos.barcode_candidates" | "pos.barcode_first" | "pos.barcode_batches"
    ) {
        if record_id.is_some() {
            return Err("POS barcode query cannot accept a record ID".into());
        }
        return run_pos_barcode_query(
            &mut conn,
            actor.as_deref().unwrap(),
            &query_id,
            search.as_deref(),
            drug_id,
            limit,
            offset,
        )
        .await;
    }
    if query_id == "patients.report_picker" {
        if record_id.is_some() || search.is_some() || drug_id.is_some() {
            return Err("Patient report picker does not accept personal or SQL filters".into());
        }
        return run_invoice_patient_picker_query(
            &mut conn,
            actor.as_deref().unwrap(),
            limit,
            offset,
        )
        .await;
    }
    if matches!(
        query_id.as_str(),
        "patients.directory" | "patients.pos_search" | "patients.pos_get" | "patients.profile" | "patients.checkout_allergies"
    ) {
        if drug_id.is_some() {
            return Err("Patient read does not accept drug filters".into());
        }
        return run_owned_patient_query(
            &mut conn,
            actor.as_deref().ok_or("Login required")?,
            &query_id,
            record_id.as_deref(),
            search.as_deref(),
            limit,
            offset,
        )
        .await;
    }
    if matches!(
        query_id.as_str(),
        "dashboard.drug_count"
            | "dashboard.trend"
            | "dashboard.top_items"
            | "dashboard.recent_sales"
            | "dashboard.audit_logs"
    ) {
        let expected_limit = if query_id == "dashboard.trend" {
            30
        } else if query_id == "dashboard.drug_count" {
            1
        } else {
            5
        };
        if record_id.is_some() || search.is_some() || drug_id.is_some()
            || limit != expected_limit || offset != 0
        {
            return Err("Dashboard read does not accept renderer filters or pagination".into());
        }
        return run_dashboard_query(&mut conn, actor.as_deref().unwrap(), &query_id).await;
    }
    if matches!(
        query_id.as_str(),
        "reports.trend"
            | "reports.sales_history"
            | "reports.top_drugs"
            | "reports.categories"
            | "reports.total_units"
            | "reports.kpis"
    ) {
        if record_id.is_some() || drug_id.is_some() {
            return Err("Reports do not accept record or drug identifiers".into());
        }
        // Report window is a decimal integer, not a date expression/SQL.
        let days = search
            .as_deref()
            .ok_or("Report window is required")?
            .parse::<u32>()
            .map_err(|_| "Report window is invalid")?;
        return run_sales_reporting_query(
            &mut conn,
            actor.as_deref().unwrap(),
            &query_id,
            days,
            limit,
            offset,
        )
        .await;
    }
    if matches!(query_id.as_str(), "inventory.adjustment_reasons" | "inventory.adjustment_lots") {
        if record_id.is_some() || drug_id.is_some() {
            return Err("Stock adjustment source does not accept record or drug identifiers".into());
        }
        return run_stock_adjustment_source_query(
            &mut conn,
            actor.as_deref().ok_or("Stock adjustment requires authenticated actor")?,
            &query_id,
            search.as_deref(),
            limit,
            offset,
        )
        .await;
    }
    if query_id == "inventory.enriched" {
        return run_inventory_enriched_query(
            &mut conn,
            actor.as_deref().unwrap(),
            search.as_deref(),
            drug_id,
            limit,
            offset,
        )
        .await;
    }
    if query_id == "sales.dashboard_stats" {
        if record_id.is_some() || search.is_some() || drug_id.is_some() || limit != 1 || offset != 0
        {
            return Err("Sales dashboard requires one aggregate row without filters".into());
        }
        return run_sales_dashboard_stats_query(&mut conn, actor.as_deref().unwrap()).await;
    }
    if matches!(
        query_id.as_str(),
        "sales.suspended.list" | "sales.suspended.items" | "sales.suspended.batches"
    ) {
        if search.is_some() || drug_id.is_some() {
            return Err("Suspended invoice read does not accept search/drug filters".into());
        }
        return run_suspended_invoice_query(
            &mut conn,
            actor.as_deref().unwrap(),
            &query_id,
            record_id.as_deref(),
            limit,
            offset,
        )
        .await;
    }
    if query_id == "purchases.invoices_list" {
        if offset != 0 || search.is_some() || drug_id.is_some() {
            return Err("Purchase invoice list accepts a keyset cursor and page size only".into());
        }
        return run_purchase_invoice_list_query(
            &mut conn,
            actor.as_deref().unwrap(),
            record_id.as_deref(),
            limit,
        )
        .await;
    }
    if query_id == "purchases.drafts_list" {
        if offset != 0 || search.is_some() || drug_id.is_some() {
            return Err("Purchase drafts accept only a keyset cursor and page size".into());
        }
        return run_purchase_draft_list_query(
            &mut conn,
            actor.as_deref().unwrap(),
            record_id.as_deref(),
            limit,
        )
        .await;
    }
    if query_id == "purchases.invoice_get" {
        if limit != 1 || offset != 0 || search.is_some() || drug_id.is_some() {
            return Err("Purchase invoice lookup requires one ID and one row".into());
        }
        return run_purchase_invoice_get_query(
            &mut conn,
            actor.as_deref().unwrap(),
            record_id
                .as_deref()
                .ok_or("Purchase invoice ID is required")?,
        )
        .await;
    }
    if query_id.starts_with("purchases.") {
        if drug_id.is_some() {
            return Err("Purchasing reads cannot take renderer drug identifiers".into());
        }
        return run_purchasing_read(
            &mut conn,
            actor.as_deref().unwrap(),
            &query_id,
            record_id.as_deref(),
            search.as_deref(),
            limit,
            offset,
        )
        .await;
    }
    if search.is_some() || drug_id.is_some() {
        return Err("Unexpected filter on native scoped query".into());
    }
    run_typed_query(
        &mut conn,
        actor.as_deref().unwrap(),
        &query_id,
        record_id.as_deref(),
        limit,
        offset,
    )
    .await
}

/// A purchasing page carries the same immutable database-authenticated actor
/// and pharmacy as its rows, so the renderer can reject a changed-session
/// response before appending another page. It cannot choose an actor or tenant.
async fn run_purchasing_page_query(
    conn: &mut SqliteConnection,
    actor_id: &str,
    query_id: &str,
    cursor: Option<&str>,
    limit: u32,
) -> Result<Value, String> {
    if !matches!(query_id, "purchases.invoices_list" | "purchases.drafts_list") {
        return Err("Purchasing page supports only invoice and draft lists".into());
    }
    if !(1..=200).contains(&limit) {
        return Err("Purchasing page size must be 1-200".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (_, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    if pharmacy_id == "local_default" {
        return Err("Legacy purchasing ownership needs independent tenant verification".into());
    }
    // Each existing reader independently rechecks role/permissions/tenant and
    // executes its own fixed, tenant-bound keyset SQL on this same connection.
    let rows = match query_id {
        "purchases.invoices_list" => {
            run_purchase_invoice_list_query(conn, actor_id, cursor, limit).await?
        }
        "purchases.drafts_list" => {
            run_purchase_draft_list_query(conn, actor_id, cursor, limit).await?
        }
        _ => unreachable!(),
    };
    Ok(json!({ "actorId": actor_id, "pharmacyId": pharmacy_id, "rows": rows }))
}

#[tauri::command]
pub async fn db_read_purchasing_page(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    query_id: String,
    cursor: Option<String>,
    limit: u32,
) -> Result<Value, String> {
    let actor = session.authorize_session().await?;
    let actor_id = actor.as_deref().ok_or("Authenticated actor required")?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|error| error.to_string())?;
    run_purchasing_page_query(&mut conn, actor_id, &query_id, cursor.as_deref(), limit).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    #[tokio::test]
    async fn strict_native_return_register_requires_immutable_receipts_and_owned_lots() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
          CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER,full_name TEXT);
          INSERT INTO users VALUES
            ('a','cashier','{"can_view_returns":true}','tenant-a',1,'A cashier'),
            ('b','cashier','{"can_view_returns":true}','tenant-b',1,'B cashier'),
            ('denied','cashier','{}','tenant-a',1,'Denied'),
            ('inactive','owner','{}','tenant-a',0,'Inactive'),
            ('legacy','owner','{}','local_default',1,'Legacy');
          CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT);
          INSERT INTO patients VALUES('patient-a','Owned patient'),('patient-b','Private patient');
          CREATE TABLE native_patient_directory_ownership(patient_id TEXT PRIMARY KEY,pharmacy_id TEXT);
          INSERT INTO native_patient_directory_ownership VALUES('patient-a','tenant-a');
          CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT,patient_id TEXT,
            total_amount REAL,created_at TEXT,status TEXT,payment_method TEXT);
          INSERT INTO sales_invoices VALUES
            ('sale-a','tenant-a','a','patient-a',120,'2026-10-16','completed','cash'),
            ('sale-b','tenant-b','b','patient-b',220,'2026-10-16','completed','cash'),
            ('sale-legacy',NULL,'legacy',NULL,999,'2026-10-16','completed','cash'),
            ('sale-pending','tenant-a','a',NULL,50,'2026-10-16','pending','cash'),
            ('sale-no-source','tenant-a','a',NULL,60,'2026-10-16','completed','cash'),
            ('sale-foreign-lot','tenant-a','a',NULL,80,'2026-10-16','completed','cash');
          CREATE TABLE daily_journals(id TEXT PRIMARY KEY,pharmacy_id TEXT,created_by TEXT,total_amount REAL);
          INSERT INTO daily_journals VALUES
            ('sale-journal-a','tenant-a','a',120),('return-journal-a','tenant-a','a',13),
            ('sale-journal-b','tenant-b','b',220),('return-journal-b','tenant-b','b',25),
            ('return-journal-legacy','tenant-a','a',6),
            ('sale-journal-pending','tenant-a','a',50),('return-journal-pending','tenant-a','a',5),
            ('return-journal-no-source','tenant-a','a',6),
            ('sale-journal-foreign-lot','tenant-a','a',80),('return-journal-foreign-lot','tenant-a','a',8);
          CREATE TABLE native_sale_cogs_provenance(sale_id TEXT PRIMARY KEY,pharmacy_id TEXT,
            actor_id TEXT,journal_id TEXT,payment_method TEXT,sale_micros INTEGER,cogs_micros INTEGER,line_count INTEGER);
          INSERT INTO native_sale_cogs_provenance VALUES
            ('sale-a','tenant-a','a','sale-journal-a','cash',120000000,0,1),
            ('sale-b','tenant-b','b','sale-journal-b','cash',220000000,0,1),
            ('sale-pending','tenant-a','a','sale-journal-pending','cash',50000000,0,1),
            ('sale-foreign-lot','tenant-a','a','sale-journal-foreign-lot','cash',80000000,0,1);
          CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,pharmacy_id TEXT,user_id TEXT,
            shift_id TEXT,reason TEXT,total_refund REAL,refund_method TEXT,status TEXT,
            approved_by TEXT,created_at TEXT);
          INSERT INTO returns VALUES
            ('return-a','sale-a','tenant-a','a',NULL,'reason a',13,'cash','approved',NULL,'2026-10-16 11:00:00'),
            ('return-b','sale-b','tenant-b','b',NULL,'reason b',25,'cash','completed',NULL,'2026-10-16 11:00:00'),
            ('legacy-unowned','sale-legacy',NULL,'legacy',NULL,NULL,9,'cash','approved',NULL,'2026-10-16 12:00:00'),
            ('unreceipted','sale-a','tenant-a','a',NULL,NULL,4,'cash','approved',NULL,'2026-10-16 12:00:00'),
            ('return-pending','sale-pending','tenant-a','a',NULL,NULL,5,'cash','approved',NULL,'2026-10-16 12:00:00'),
            ('return-no-source','sale-no-source','tenant-a','a',NULL,NULL,6,'cash','approved',NULL,'2026-10-16 12:00:00'),
            ('return-foreign-lot','sale-foreign-lot','tenant-a','a',NULL,NULL,8,'cash','approved',NULL,'2026-10-16 12:00:00');
          CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT,drug_id INTEGER);
          INSERT INTO inventory VALUES('lot-a','tenant-a',4),('lot-a-restock','tenant-a',4),('lot-b','tenant-b',4);
          CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT);
          INSERT INTO master_drugs VALUES(4,'Verified drug','Verified drug EN');
          CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,
            drug_id INTEGER,quantity_sold REAL,unit_price REAL);
          INSERT INTO sales_items VALUES
            (11,'sale-a','lot-a',4,10,12),(12,'sale-b','lot-b',4,10,22),
            (13,'sale-legacy','lot-a',4,1,999),(14,'sale-pending','lot-a',4,5,10),
            (15,'sale-no-source','lot-a',4,6,10),(16,'sale-foreign-lot','lot-b',4,8,10);
          CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT,inventory_id TEXT,drug_id INTEGER,
            quantity_returned REAL,unit_price REAL,total_price REAL,sale_item_id INTEGER,unit TEXT);
          INSERT INTO return_items VALUES
            (1,'return-a','lot-a',4,1,13,13,11,'small'),
            (2,'return-b','lot-b',4,1,25,25,12,'large'),
            (3,'legacy-unowned','lot-a',4,1,9,9,13,'small'),
            (4,'unreceipted','lot-a',4,1,4,4,11,'small'),
            (5,'return-pending','lot-a',4,1,5,5,14,'small'),
            (6,'return-no-source','lot-a',4,1,6,6,15,'small'),
            (7,'return-foreign-lot','lot-b',4,1,8,8,16,'small');
          CREATE TABLE native_sale_return_cogs_provenance(return_id TEXT PRIMARY KEY,sale_id TEXT,
            pharmacy_id TEXT,actor_id TEXT,journal_id TEXT,refund_method TEXT,
            refund_micros INTEGER,cogs_micros INTEGER,line_count INTEGER);
          INSERT INTO native_sale_return_cogs_provenance VALUES
            ('return-a','sale-a','tenant-a','a','return-journal-a','cash',13000000,0,1),
            ('return-b','sale-b','tenant-b','b','return-journal-b','cash',25000000,0,1),
            ('return-pending','sale-pending','tenant-a','a','return-journal-pending','cash',5000000,0,1),
            ('return-no-source','sale-no-source','tenant-a','a','return-journal-no-source','cash',6000000,0,1),
            ('return-foreign-lot','sale-foreign-lot','tenant-a','a','return-journal-foreign-lot','cash',8000000,0,1);
        "#).execute(&mut conn).await.unwrap();

        assert!(run_return_history_query(&mut conn,"a","returns.list",None,None,100,0).await.is_err(),
            "owned unreceipted, unposted or cross-lot records require an explicit register error");
        sqlx::query("DELETE FROM returns WHERE id IN ('unreceipted','return-pending','return-no-source','return-foreign-lot')")
            .execute(&mut conn).await.unwrap();
        let a=run_return_history_query(&mut conn,"a","returns.list",None,None,100,0).await.unwrap();
        let b=run_return_history_query(&mut conn,"b","returns.list",None,None,100,0).await.unwrap();
        assert_eq!(a.len(),1,"legacy unowned rows must never be attributed to tenant A");
        assert_eq!(b.len(),1);
        assert_eq!(a[0]["id"],"return-a");
        assert_eq!(a[0]["patient_name"],"Owned patient");
        assert_eq!(a[0]["user_name"],"A cashier");
        assert_eq!(a[0]["invoice_total"].as_f64(),Some(120.0));
        assert_eq!(b[0]["id"],"return-b");
        assert!(b[0]["patient_name"].is_null(),"legacy unowned patient names cannot be attributed");
        let items=run_return_history_query(&mut conn,"a","returns.list_items",Some("return-a"),None,200,0).await.unwrap();
        assert_eq!(items.len(),1);
        assert_eq!(items[0]["id"],1);
        assert_eq!(items[0]["trade_name_ar"],"Verified drug");
        assert!(run_return_history_query(&mut conn,"a","returns.list_items",Some("return-b"),None,200,0).await.unwrap().is_empty());
        assert!(run_return_history_query(&mut conn,"a","returns.list",None,Some("return-%"),100,0).await.unwrap().is_empty(),"search wildcards are literal");
        let matched=run_return_history_query(&mut conn,"a","returns.list",None,Some("Owned patient"),100,0).await.unwrap();
        assert_eq!(matched.len(),1);
        for actor in ["denied","inactive","legacy"] {
            assert!(run_return_history_query(&mut conn,actor,"returns.list",None,None,100,0).await.is_err());
        }
        sqlx::query("UPDATE return_items SET inventory_id='lot-b' WHERE id=1")
            .execute(&mut conn).await.unwrap();
        assert!(run_return_history_query(&mut conn,"a","returns.list",None,None,100,0).await.is_err());
        sqlx::query("UPDATE return_items SET inventory_id='lot-a' WHERE id=1")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE return_items SET inventory_id='lot-a-restock' WHERE id=1")
            .execute(&mut conn).await.unwrap();
        let revalued_lot=run_return_history_query(&mut conn,"a","returns.list_items",Some("return-a"),None,200,0).await.unwrap();
        assert_eq!(revalued_lot.len(),1,"a native return may restock to a newly minted same-tenant lot");
        assert_eq!(revalued_lot[0]["inventory_id"],"lot-a-restock");
        sqlx::query("UPDATE return_items SET inventory_id='lot-a' WHERE id=1")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE daily_journals SET pharmacy_id='tenant-b' WHERE id='return-journal-a'")
            .execute(&mut conn).await.unwrap();
        assert!(run_return_history_query(&mut conn,"a","returns.list",None,None,100,0).await.is_err());
        sqlx::query("UPDATE daily_journals SET pharmacy_id='tenant-a' WHERE id='return-journal-a'")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE sales_invoices SET status='pending' WHERE id='sale-a'")
            .execute(&mut conn).await.unwrap();
        assert!(run_return_history_query(&mut conn,"a","returns.list",None,None,100,0).await.is_err());
        sqlx::query("UPDATE sales_invoices SET status='completed' WHERE id='sale-a'")
            .execute(&mut conn).await.unwrap();
        sqlx::query("DELETE FROM native_sale_cogs_provenance WHERE sale_id='sale-a'")
            .execute(&mut conn).await.unwrap();
        assert!(run_return_history_query(&mut conn,"a","returns.list",None,None,100,0).await.is_err());
    }

    #[tokio::test]
    async fn selected_return_invoice_native_details_bind_actor_tenant_and_prior_lines() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
          CREATE TABLE users(id TEXT,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
          INSERT INTO users VALUES
            ('returns-a','cashier','{"can_view_returns":true}','tenant-a',1),
            ('returns-b','cashier','{"can_view_returns":true}','tenant-b',1),
            ('denied','cashier','{}','tenant-a',1),
            ('local','owner','{}','local_default',1),
            ('disabled','owner','{}','tenant-a',0);
          CREATE TABLE sales_invoices(
            id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT,patient_id TEXT,
            total_amount REAL,discount_amount REAL,paid_amount REAL,remaining_amount REAL,
            created_at TEXT,status TEXT,payment_method TEXT
          );
          INSERT INTO sales_invoices VALUES
            ('qa-owned','tenant-a','returns-a',NULL,120,10,120,0,'2026-10-16 10:00:00','completed','cash'),
            ('qa-foreign','tenant-b','returns-b',NULL,500,0,500,0,'2026-10-16 10:00:00','completed','cash'),
            ('qa-legacy',NULL,'local',NULL,999,0,999,0,'2026-10-16 10:00:00','completed','cash');
          CREATE TABLE native_patient_directory_ownership(
            patient_id TEXT PRIMARY KEY,pharmacy_id TEXT
          );
          CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT,drug_id INTEGER,strips_per_box REAL,medium_to_small REAL,expiry_date TEXT);
          INSERT INTO inventory VALUES ('lot-a','tenant-a',4,10,2,'2030-01-01'),
            ('lot-b','tenant-b',4,10,2,'2030-01-01');
          CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,
            active_ingredient TEXT,large_unit TEXT,medium_unit TEXT,small_unit TEXT,
            large_to_medium REAL,medium_to_small REAL);
          INSERT INTO master_drugs VALUES(4,'Owned Drug','Owned Drug EN','Ingredient','box','strip','tablet',10,2);
          CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,drug_id INTEGER,
            quantity_sold REAL,unit_price REAL,unit TEXT,large_to_medium REAL,medium_to_small REAL);
          INSERT INTO sales_items VALUES
            (81,'qa-owned','lot-a',4,10,13,'small',10,2),
            (82,'qa-foreign','lot-b',4,2,25,'large',10,2);
          CREATE TABLE daily_journals(id TEXT PRIMARY KEY,pharmacy_id TEXT);
          INSERT INTO daily_journals VALUES('journal-sale-a','tenant-a'),('journal-return-a','tenant-a');
          CREATE TABLE native_sale_cogs_provenance(
            sale_id TEXT PRIMARY KEY,pharmacy_id TEXT,actor_id TEXT,
            journal_id TEXT,sale_micros INTEGER,line_count INTEGER
          );
          INSERT INTO native_sale_cogs_provenance VALUES
            ('qa-owned','tenant-a','returns-a','journal-sale-a',120000000,1);
          CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,pharmacy_id TEXT,
            user_id TEXT,created_at TEXT,status TEXT,total_refund REAL);
          CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT,sale_item_id INTEGER,
            inventory_id TEXT,quantity_returned REAL,unit TEXT);
          CREATE TABLE native_sale_return_cogs_provenance(
            return_id TEXT PRIMARY KEY,sale_id TEXT,pharmacy_id TEXT,actor_id TEXT,
            journal_id TEXT,refund_micros INTEGER,line_count INTEGER
          );
          INSERT INTO returns VALUES
            ('prior-a','qa-owned','tenant-a','returns-a','2026-10-16 11:00:00','approved',13),
            ('prior-b','qa-foreign','tenant-b','returns-b','2026-10-16 11:00:00','approved',25);
          INSERT INTO return_items VALUES
            (1,'prior-a',81,'lot-a',1,'medium'),(2,'prior-b',82,'lot-b',1,'large');
          INSERT INTO native_sale_return_cogs_provenance VALUES
            ('prior-a','qa-owned','tenant-a','returns-a','journal-return-a',13000000,1);
        "#).execute(&mut conn).await.unwrap();
        let header = run_return_invoice_detail_query(
            &mut conn,"returns-a","returns.invoice_header","qa-owned",1,0
        ).await.unwrap();
        assert_eq!(header[0]["id"],"qa-owned");
        assert_eq!(header[0]["pharmacy_id"],"tenant-a");
        assert!(header[0]["patient_name"].is_null());
        let items = run_return_invoice_detail_query(
            &mut conn,"returns-a","returns.invoice_items","qa-owned",200,0
        ).await.unwrap();
        assert_eq!(items.len(),1);
        assert_eq!(items[0]["id"],81);
        assert_eq!(items[0]["trade_name"],"Owned Drug");
        assert_eq!(items[0]["large_to_medium"].as_f64(),Some(10.0));
        let prior = run_return_invoice_detail_query(
            &mut conn,"returns-a","returns.invoice_prior","qa-owned",200,0
        ).await.unwrap();
        assert_eq!(prior.len(),1);
        assert_eq!(prior[0]["sale_item_id"],81);
        assert_eq!(prior[0]["quantity_returned"].as_f64(),Some(1.0));
        let refund = run_return_invoice_detail_query(
            &mut conn,"returns-a","returns.invoice_refund","qa-owned",1,0
        ).await.unwrap();
        assert_eq!(refund[0]["total"].as_f64(),Some(13.0));
        for (actor, invoice) in [
            ("returns-a","qa-foreign"),("returns-b","qa-owned"),
            ("returns-a","qa-legacy"),("local","qa-legacy"),
            ("denied","qa-owned"),("disabled","qa-owned"),
        ] {
            assert!(run_return_invoice_detail_query(
                &mut conn,actor,"returns.invoice_header",invoice,1,0
            ).await.is_err(), "{actor} must not read {invoice}");
        }
        sqlx::query("DELETE FROM native_sale_cogs_provenance WHERE sale_id='qa-owned'")
            .execute(&mut conn).await.unwrap();
        assert!(run_return_invoice_detail_query(
            &mut conn,"returns-a","returns.invoice_header","qa-owned",1,0
        ).await.is_err(), "unreceipted historical sale has no native financial witness");
        sqlx::query("INSERT INTO native_sale_cogs_provenance VALUES
          ('qa-owned','tenant-a','returns-a','journal-sale-a',120000000,1)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("DELETE FROM native_sale_return_cogs_provenance WHERE return_id='prior-a'")
            .execute(&mut conn).await.unwrap();
        assert!(run_return_invoice_detail_query(
            &mut conn,"returns-a","returns.invoice_prior","qa-owned",200,0
        ).await.is_err(), "unreceipted finalized return must block quantity/revenue preview");
        sqlx::query("INSERT INTO native_sale_return_cogs_provenance VALUES
          ('prior-a','qa-owned','tenant-a','returns-a','journal-return-a',13000000,1)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE return_items SET inventory_id='lot-b' WHERE id=1")
            .execute(&mut conn).await.unwrap();
        assert!(run_return_invoice_detail_query(
            &mut conn,"returns-a","returns.invoice_prior","qa-owned",200,0
        ).await.is_err(), "prior return lot cannot silently differ from sold lot");
        sqlx::query("UPDATE return_items SET inventory_id='lot-a' WHERE id=1")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE returns SET pharmacy_id='tenant-b' WHERE id='prior-a'")
            .execute(&mut conn).await.unwrap();
        assert!(run_return_invoice_detail_query(
            &mut conn,"returns-a","returns.invoice_refund","qa-owned",1,0
        ).await.is_err());
        sqlx::query("UPDATE returns SET pharmacy_id='tenant-a' WHERE id='prior-a'")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE return_items SET sale_item_id=NULL WHERE id=1")
            .execute(&mut conn).await.unwrap();
        assert!(run_return_invoice_detail_query(
            &mut conn,"returns-a","returns.invoice_prior","qa-owned",200,0
        ).await.is_err());
        sqlx::query("UPDATE return_items SET sale_item_id=81 WHERE id=1")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE sales_items SET inventory_id='lot-b' WHERE id=81")
            .execute(&mut conn).await.unwrap();
        assert!(run_return_invoice_detail_query(
            &mut conn,"returns-a","returns.invoice_items","qa-owned",200,0
        ).await.is_err());
    }

    #[tokio::test]
    async fn prospective_owned_patient_directory_pos_and_profile_never_claim_legacy_rows() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"CREATE TABLE users(id TEXT,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
               INSERT INTO users VALUES
                 ('a','pharmacist','{"can_view_patients":true,"can_access_pos":true}','tenant-a',1),
                 ('a-pos','cashier','{"can_access_pos":true}','tenant-a',1),
                 ('b','owner','{}','tenant-b',1),
                 ('old','owner','{}','local_default',1),
                 ('denied','cashier','{}','tenant-a',1),
                 ('inactive','owner','{}','tenant-a',0);
               CREATE TABLE patients(
                 id TEXT PRIMARY KEY,full_name TEXT,phone TEXT,credit_limit REAL,
                 opening_balance REAL,wallet_balance REAL,points_balance REAL,
                 payment_method TEXT,notes TEXT
               );
               INSERT INTO patients VALUES
                 ('new-a','Fresh A','01011111111',100,0,0,0,'cash','PRIVATE MEDICAL NOTE'),
                 ('new-b','Foreign PRIVATE','01099999999',9000,0,400,999,'credit','FOREIGN NOTE'),
                 ('old-global','Old PRIVATE','01022222222',9000,0,500,999,'cash','LEGACY NOTE');
               CREATE TABLE sales_invoices(
                 id TEXT,patient_id TEXT,pharmacy_id TEXT,status TEXT,
                 payment_method TEXT,total_amount REAL
               );
               INSERT INTO sales_invoices VALUES
                 ('a1','new-a','tenant-a','completed','credit',12.50),
                 ('old1','old-global','tenant-a','completed','credit',1000),
                 ('old2','old-global','tenant-b','completed','credit',500);
               CREATE TABLE returns(
                 id TEXT,invoice_id TEXT,pharmacy_id TEXT,refund_method TEXT,status TEXT,total_refund REAL
               );
               CREATE TABLE patient_transactions(patient_id TEXT,type TEXT,amount REAL);
               CREATE TABLE patient_allergies(id INTEGER PRIMARY KEY,patient_id TEXT,allergen TEXT,severity TEXT);
               INSERT INTO patient_allergies VALUES
                 (1,'new-a','qa-allergen','critical'),
                 (2,'new-b','FOREIGN ALLERGEN','critical'),
                 (3,'old-global','LEGACY ALLERGEN','critical');
               CREATE TABLE financial_notices(target_type TEXT,target_id TEXT);
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/061_native_patient_directory_ownership.sql"))
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256)
             VALUES ('new-a','tenant-a','a',?),('new-b','tenant-b','b',?)",
        )
        .bind("a".repeat(64))
        .bind("b".repeat(64))
        .execute(&mut conn)
        .await
        .unwrap();
        let directory = run_owned_patient_query(&mut conn, "a", "patients.directory", None, None, 200, 0)
            .await.unwrap();
        assert_eq!(directory.len(), 1);
        assert_eq!(directory[0]["id"], "new-a");
        assert_eq!(directory[0]["outstanding_balance"], 12.5);
        // A full patient-directory reader may see its *own* patient's notes.
        // Never mistake an owned clinical field for evidence that a foreign
        // or anonymous patient has leaked into the result set.
        assert_eq!(directory[0]["notes"], "PRIVATE MEDICAL NOTE");
        let directory_json = serde_json::to_string(&directory).unwrap();
        assert!(!directory_json.contains("Foreign PRIVATE"));
        assert!(!directory_json.contains("Old PRIVATE"));
        assert!(!directory_json.contains("FOREIGN NOTE"));
        assert!(!directory_json.contains("LEGACY NOTE"));
        let pos = run_owned_patient_query(
            &mut conn, "a-pos", "patients.pos_search", None, Some("Fresh"), 25, 0
        ).await.unwrap();
        assert_eq!(pos.len(), 1);
        assert_eq!(pos[0]["phone"], "01011111111");
        assert!(pos[0].get("notes").is_none());
        assert!(!serde_json::to_string(&pos).unwrap().contains("PRIVATE MEDICAL"));
        let allergy = run_owned_patient_query(
            &mut conn, "a-pos", "patients.checkout_allergies", Some("new-a"), None, 200, 0,
        ).await.unwrap();
        assert_eq!(allergy.len(), 1);
        assert_eq!(allergy[0]["allergen"], "qa-allergen");
        assert!(allergy[0].get("patient_id").is_none(), "Only clinical checkout fields can be projected");
        assert!(run_owned_patient_query(
            &mut conn, "a-pos", "patients.checkout_allergies", Some("new-b"), None, 200, 0,
        ).await.is_err(), "Foreign patient ID must not reveal clinical allergies");
        assert!(run_owned_patient_query(
            &mut conn, "a-pos", "patients.checkout_allergies", Some("old-global"), None, 200, 0,
        ).await.is_err(), "Legacy global patient must remain unowned");
        assert!(run_owned_patient_query(
            &mut conn, "denied", "patients.checkout_allergies", Some("new-a"), None, 200, 0,
        ).await.is_err());
        assert!(run_owned_patient_query(&mut conn, "a-pos", "patients.directory", None, None, 200, 0).await.is_err());
        assert!(run_owned_patient_query(&mut conn, "denied", "patients.pos_search", None, Some("Fresh"), 25, 0).await.is_err());
        assert!(run_owned_patient_query(&mut conn, "inactive", "patients.directory", None, None, 200, 0).await.is_err());
        assert!(run_owned_patient_query(&mut conn, "old", "patients.directory", None, None, 200, 0).await.is_err());
        let missing = run_owned_patient_query(
            &mut conn, "a", "patients.profile", Some("old-global"), None, 1, 0
        ).await.unwrap();
        assert!(missing.is_empty());
        let b = run_owned_patient_query(&mut conn, "b", "patients.directory", None, None, 200, 0)
            .await.unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0]["id"], "new-b");
        sqlx::query(
            "INSERT INTO patient_transactions(patient_id,type,amount) VALUES('new-a','payment',5)"
        ).execute(&mut conn).await.unwrap();
        assert!(run_owned_patient_query(&mut conn, "a", "patients.directory", None, None, 200, 0).await.is_err());
        assert!(run_owned_patient_query(
            &mut conn, "a-pos", "patients.pos_get", Some("new-a"), None, 1, 0
        ).await.is_err());
    }

    #[tokio::test]
    async fn purchasing_page_envelope_binds_active_actor_and_tenant_for_both_keyset_lists() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(
                id TEXT PRIMARY KEY,role TEXT,is_active INTEGER,pharmacy_id TEXT,
                permissions TEXT,full_name TEXT
            );
            INSERT INTO users VALUES
              ('buyer-a','pharmacist',1,'a','{"can_view_purchases":true}','Buyer A'),
              ('buyer-b','pharmacist',1,'b','{"can_view_purchases":true}','Buyer B'),
              ('blocked-a','cashier',1,'a','{"can_view_purchases":false}','Blocked'),
              ('inactive-a','owner',0,'a','{}','Inactive'),
              ('legacy-owner','owner',1,NULL,'{}','Legacy Owner'),
              ('legacy-staff','pharmacist',1,'local_default','{"can_view_purchases":true}','Legacy Staff');
            CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name_ar TEXT,phone TEXT);
            INSERT INTO suppliers VALUES (1,'A Supplier','101'),(2,'B Supplier','202');
            CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT);
            INSERT INTO master_drugs VALUES (41,'A drug'),(42,'B drug');
            CREATE TABLE purchase_invoice_items(invoice_id TEXT,drug_id INTEGER);
            INSERT INTO purchase_invoice_items VALUES ('a-invoice',41),('b-private',42);
            CREATE TABLE purchase_invoices(
                id TEXT PRIMARY KEY,supplier_id INTEGER,pharmacy_id TEXT,user_id TEXT,
                created_at TEXT,status TEXT,invoice_number TEXT,invoice_date TEXT,total_amount REAL
            );
            INSERT INTO purchase_invoices VALUES
              ('a-invoice',1,'a','buyer-a','2026-10-10','completed','A-1','2026-10-10',10),
              ('a-draft',1,'a','buyer-a','2026-10-09','draft','A-D','2026-10-09',5),
              ('b-private',2,'b','buyer-b','2026-10-12','completed','SECRET','2026-10-12',99),
              ('b-draft',2,'b','buyer-b','2026-10-11','draft','SECRET-D','2026-10-11',91),
              ('legacy-null',1,NULL,'legacy-owner','2026-10-13','draft','LEGACY','2026-10-13',77),
              ('legacy-explicit',1,'local_default','legacy-staff','2026-10-14','draft','LEGACY-2','2026-10-14',88);
        "#).execute(&mut conn).await.unwrap();

        let page = run_purchasing_page_query(
            &mut conn, "buyer-a", "purchases.invoices_list", None, 1,
        ).await.unwrap();
        assert_eq!(page["actorId"], "buyer-a");
        assert_eq!(page["pharmacyId"], "a");
        assert_eq!(page["rows"].as_array().unwrap().len(), 1);
        assert_eq!(page["rows"][0]["id"], "a-invoice");
        assert_eq!(page["rows"][0]["drug_names"], "A drug");
        let cursor = serde_json::to_string(&("2026-10-10", "a-invoice")).unwrap();
        let next = run_purchasing_page_query(
            &mut conn, "buyer-a", "purchases.invoices_list", Some(&cursor), 1,
        ).await.unwrap();
        assert_eq!(next["actorId"], "buyer-a");
        assert_eq!(next["pharmacyId"], "a");
        assert_eq!(next["rows"][0]["id"], "a-draft");
        let exhausted = run_purchasing_page_query(
            &mut conn, "buyer-a", "purchases.invoices_list",
            Some(&serde_json::to_string(&("2026-10-09", "a-draft")).unwrap()), 1,
        ).await.unwrap();
        assert_eq!(exhausted["rows"], json!([]));

        let draft = run_purchasing_page_query(
            &mut conn, "buyer-a", "purchases.drafts_list", None, 200,
        ).await.unwrap();
        assert_eq!(draft["actorId"], "buyer-a");
        assert_eq!(draft["pharmacyId"], "a");
        assert_eq!(draft["rows"].as_array().unwrap().len(), 1);
        assert_eq!(draft["rows"][0]["id"], "a-draft");
        assert_eq!(draft["rows"][0]["__cursor_created_at"], "2026-10-09");
        assert_eq!(
            run_purchasing_page_query(&mut conn, "buyer-b", "purchases.invoices_list", None, 200)
                .await.unwrap()["rows"][0]["id"],
            "b-private"
        );
        assert_eq!(
            run_purchasing_page_query(&mut conn, "buyer-b", "purchases.drafts_list", None, 200)
                .await.unwrap()["rows"][0]["id"],
            "b-draft"
        );

        for actor in ["blocked-a", "inactive-a", "legacy-owner", "legacy-staff", "missing"] {
            for key in ["purchases.invoices_list", "purchases.drafts_list"] {
                assert!(
                    run_purchasing_page_query(&mut conn, actor, key, None, 200)
                        .await.is_err(),
                    "{actor} gained access to {key}"
                );
            }
        }
        for key in ["purchases.reports", "purchases.invoice_get", "purchases.detail_header", "sales.invoices", ""] {
            assert!(
                run_purchasing_page_query(&mut conn, "buyer-a", key, None, 200)
                    .await.is_err(),
                "{key} escaped the two-list allowlist"
            );
        }
        for limit in [0, 201] {
            assert!(run_purchasing_page_query(
                &mut conn, "buyer-a", "purchases.invoices_list", None, limit,
            ).await.is_err());
        }
        assert!(run_purchasing_page_query(
            &mut conn, "buyer-a", "purchases.drafts_list", Some("not-json"), 200,
        ).await.is_err());
    }

    #[tokio::test]
    async fn native_shift_report_rechecks_pharmacy_role_and_transaction_ownership() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute(r#"CREATE TABLE users(id TEXT,full_name TEXT,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
          INSERT INTO users VALUES('owner-a','Owner A','owner','{}','a',1),
            ('owner-b','Owner B','owner','{}','b',1),
            ('staff-a','Staff A','cashier','{"rep_can_view_shifts":true}','a',1),
            ('denied','Denied','cashier','{}','a',1),
            ('inactive','Gone','owner','{}','a',0);
          CREATE TABLE shifts(id TEXT,user_id TEXT,pharmacy_id TEXT,starting_cash REAL,status TEXT);
          INSERT INTO shifts VALUES('sa','owner-a','a',100,'closed'),('sb','owner-b','b',900,'closed');
          CREATE TABLE sales_invoices(id TEXT,shift_id TEXT,pharmacy_id TEXT,payment_method TEXT,
            total_amount REAL,paid_amount REAL,remaining_amount REAL,status TEXT);
          INSERT INTO sales_invoices VALUES
            ('a1','sa','a','cash',75,70,5,'completed'),
            ('a-draft','sa','a','cash',1000,1000,0,'draft'),
            ('b1','sb','b','cash',900,900,0,'completed'),
            ('foreign-link','sa','b','cash',7000,7000,0,'completed');
          CREATE TABLE returns(id TEXT,shift_id TEXT,pharmacy_id TEXT,refund_method TEXT,total_refund REAL,status TEXT);
          INSERT INTO returns VALUES('a-return','sa','a','cash',15,'approved'),
            ('bad-return','sa','b','cash',600,'approved'),('b-return','sb','b','cash',700,'completed');
          CREATE TABLE cash_movements(id TEXT,shift_id TEXT,pharmacy_id TEXT,type TEXT,category TEXT,amount REAL,source_type TEXT);
          INSERT INTO cash_movements VALUES('one','sa','a','receipt','deposit',5,'manual'),
            ('safe','sa','a','out','handover',55,'main_safe'),
            ('foreign-linked','sa','b','receipt','deposit',1500,'manual'),
            ('two','sb','b','out','handover',900,'manual');"#).await.unwrap();
        let header =
            run_shift_report_query(&mut conn, "staff-a", "reports.shift_header", "sa", 1, 0)
                .await
                .unwrap();
        assert_eq!(header.len(), 1);
        assert_eq!(header[0]["staff_name"], "Owner A");
        assert_eq!(header[0]["starting_cash"], json!(100.0));
        let sales =
            run_shift_report_query(&mut conn, "staff-a", "reports.shift_sales", "sa", 200, 0)
                .await
                .unwrap();
        assert_eq!(sales.len(), 1);
        assert_eq!(sales[0]["total"], json!(75.0));
        let returns =
            run_shift_report_query(&mut conn, "staff-a", "reports.shift_returns", "sa", 200, 0)
                .await
                .unwrap();
        assert_eq!(returns.len(), 1);
        assert_eq!(returns[0]["total"], json!(15.0));
        let movement = run_shift_report_query(
            &mut conn,
            "staff-a",
            "reports.shift_movements",
            "sa",
            200,
            0,
        )
        .await
        .unwrap();
        assert_eq!(movement.len(), 1);
        assert_eq!(movement[0]["total"], json!(5.0));
        assert!(
            run_shift_report_query(&mut conn, "staff-a", "reports.shift_header", "sb", 1, 0)
                .await
                .is_err()
        );
        assert_eq!(
            run_shift_report_query(&mut conn, "owner-b", "reports.shift_sales", "sb", 200, 0)
                .await
                .unwrap()[0]["total"],
            json!(900.0)
        );
        for actor in ["denied", "inactive", "unknown"] {
            assert!(
                run_shift_report_query(&mut conn, actor, "reports.shift_header", "sa", 1, 0)
                    .await
                    .is_err()
            );
        }
        assert!(
            run_shift_report_query(&mut conn, "staff-a", "reports.shift_header", "sa", 200, 0)
                .await
                .is_err()
        );
        assert!(run_shift_report_query(
            &mut conn,
            "staff-a",
            "reports.shift_sales",
            "sa\0bad",
            200,
            0
        )
        .await
        .is_err());
        assert!(
            run_shift_report_query(&mut conn, "staff-a", "reports.shift_sales", "sa", 201, 0)
                .await
                .is_err()
        );
        assert!(run_shift_report_query(
            &mut conn,
            "staff-a",
            "reports.shift_sales",
            "sa",
            200,
            50_001
        )
        .await
        .is_err());
        assert!(run_shift_report_query(
            &mut conn,
            "staff-a",
            "reports.shift_unknown",
            "sa",
            200,
            0
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn native_pos_text_search_is_pharmacy_scoped_redacts_cost_and_rejects_filters() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute(r#"CREATE TABLE users(id TEXT,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
            INSERT INTO users VALUES('cash-a','cashier','{"can_access_pos":true}','a',1),
              ('owner-a','owner','{}','a',1),('owner-b','owner','{}','b',1),
              ('denied','cashier','{"can_access_pos":false}','a',1),
              ('inactive','owner','{}','a',0);
            CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,barcode TEXT,trade_name TEXT,trade_name_en TEXT,
              generic_name TEXT,active_ingredient TEXT,category TEXT,official_price REAL,large_unit TEXT,
              medium_unit TEXT,small_unit TEXT,large_to_medium REAL,medium_to_small REAL,
              reorder_point INTEGER,stop_dealing INTEGER,has_expiry INTEGER);
            INSERT INTO master_drugs VALUES
              (1,'PUBLIC1','Paracetamol','Paracetamol','Pain','acetaminophen','analgesic',50,'box','strip','tablet',10,10,5,0,0),
              (2,'PUBLIC2','Foreign','Foreign','Pain','ibuprofen','analgesic',40,'box','strip','tablet',10,10,5,0,0),
              (3,'SECRET','Hidden','Hidden','Pain','acetaminophen','analgesic',50,'box','strip','tablet',10,10,5,1,0),
              (4,'PERCENT','100% Pure','100% Pure','Pain','acetaminophen','analgesic',60,'box','strip','tablet',10,10,5,0,0);
            CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,quantity REAL,
              expiry_date TEXT,local_selling_price REAL,cost_price REAL,strips_per_box INTEGER,
              medium_to_small INTEGER,barcode TEXT,created_at TEXT);
            INSERT INTO inventory VALUES
              ('a',1,'a',7,NULL,60,11,10,10,'ALOT',datetime('now')),
              ('b',1,'b',800,NULL,200,100,10,10,'BLOT',datetime('now')),
              ('foreign',2,'b',99,NULL,88,44,10,10,'FOREIGN-BAR',datetime('now')),
              ('expired',2,'a',55,'2000-01-01',88,33,10,10,'OLD',datetime('now')),
              ('stop',3,'a',10,NULL,99,11,10,10,'HIDDEN',datetime('now'));
        "#).await.unwrap();
        let cash = run_pos_drug_candidates_query(
            &mut conn,
            "cash-a",
            Some("Paracetamol"),
            Some("name"),
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(cash.len(), 1);
        assert_eq!(cash[0]["id"], json!(1));
        assert_eq!(cash[0]["total_stock"], json!(7.0));
        assert_eq!(cash[0]["min_price"], json!(60.0));
        assert!(cash[0]["avg_cost_price"].is_null());
        let own = run_pos_drug_candidates_query(
            &mut conn,
            "owner-a",
            Some("Paracetamol"),
            Some("name"),
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(own[0]["avg_cost_price"], json!(11.0));
        let foreign = run_pos_drug_candidates_query(
            &mut conn,
            "owner-b",
            Some("Paracetamol"),
            Some("name"),
            20,
            0,
        )
        .await
        .unwrap();
        assert_eq!(foreign[0]["total_stock"], json!(800.0));
        assert_eq!(foreign[0]["avg_cost_price"], json!(100.0));
        assert!(run_pos_drug_candidates_query(
            &mut conn,
            "cash-a",
            Some("FOREIGN-BAR"),
            Some("name"),
            20,
            0
        )
        .await
        .unwrap()
        .is_empty());
        assert!(run_pos_drug_candidates_query(
            &mut conn,
            "cash-a",
            Some("HIDDEN"),
            Some("name"),
            20,
            0
        )
        .await
        .unwrap()
        .is_empty());
        assert_eq!(
            run_pos_drug_candidates_query(&mut conn, "cash-a", Some("ALOT"), Some("name"), 20, 0)
                .await
                .unwrap()[0]["id"],
            json!(1)
        );
        assert_eq!(
            run_pos_drug_candidates_query(
                &mut conn,
                "cash-a",
                Some("acetaminophen"),
                Some("ingredient"),
                20,
                0
            )
            .await
            .unwrap()
            .len(),
            2
        );
        assert_eq!(
            run_pos_drug_candidates_query(&mut conn, "cash-a", Some("100%"), Some("name"), 20, 0)
                .await
                .unwrap()[0]["id"],
            json!(4)
        );
        assert_eq!(
            run_pos_drug_candidates_query(&mut conn, "cash-a", Some("%"), Some("name"), 20, 0)
                .await
                .unwrap()[0]["id"],
            json!(4)
        );
        assert!(
            run_pos_drug_candidates_query(&mut conn, "cash-a", Some("_"), Some("name"), 20, 0)
                .await
                .unwrap()
                .is_empty()
        );
        for bad_actor in ["denied", "inactive", "unknown"] {
            assert!(run_pos_drug_candidates_query(
                &mut conn,
                bad_actor,
                Some("Paracetamol"),
                Some("name"),
                20,
                0
            )
            .await
            .is_err());
        }
        for bad_mode in [None, Some("owner"), Some("name' OR 1=1 --")] {
            assert!(run_pos_drug_candidates_query(
                &mut conn,
                "owner-a",
                Some("Paracetamol"),
                bad_mode,
                20,
                0
            )
            .await
            .is_err());
        }
        assert!(run_pos_drug_candidates_query(
            &mut conn,
            "cash-a",
            Some("Paracetamol"),
            Some("name"),
            201,
            0
        )
        .await
        .is_err());
        assert!(run_pos_drug_candidates_query(
            &mut conn,
            "cash-a",
            Some("Paracetamol"),
            Some("name"),
            20,
            50_001
        )
        .await
        .is_err());
        assert!(run_pos_drug_candidates_query(
            &mut conn,
            "cash-a",
            Some("bad\0term"),
            Some("name"),
            20,
            0
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn native_pos_barcode_enforces_pharmacy_role_and_inventory_cost_redaction() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute(r#"CREATE TABLE users(id TEXT,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
            INSERT INTO users VALUES('a','cashier','{"can_access_pos":true}','branch-a',1),
              ('a-owner','owner','{}','branch-a',1),
              ('blocked','cashier','{"can_access_pos":false}','branch-a',1),
              ('b','owner','{}','branch-b',1),('inactive','owner','{}','branch-a',0);
            CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,barcode TEXT,trade_name TEXT,trade_name_en TEXT,
              generic_name TEXT,active_ingredient TEXT,category TEXT,official_price REAL,large_unit TEXT,
              medium_unit TEXT,small_unit TEXT,large_to_medium REAL,medium_to_small REAL,
              reorder_point INTEGER,stop_dealing INTEGER,has_expiry INTEGER);
            INSERT INTO master_drugs VALUES(1,'CODE','A','A','A','A','C',100,'box','strip','tablet',10,10,5,0,0),
              (2,'CODE','B','B','B','B','C',200,'box','strip','tablet',10,10,5,0,0);
            CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,quantity REAL,
              expiry_date TEXT,local_selling_price REAL,cost_price REAL,strips_per_box INTEGER,
              medium_to_small INTEGER,barcode TEXT,created_at TEXT);
            INSERT INTO inventory VALUES('a-lot',1,'branch-a',6,NULL,120,23,10,10,'CODE',datetime('now')),
              ('b-lot',2,'branch-b',8,NULL,225,79,10,10,'CODE',datetime('now'));"#)
            .await.unwrap();
        let a = run_pos_barcode_query(
            &mut conn,
            "a",
            "pos.barcode_candidates",
            Some("CODE"),
            None,
            2,
            0,
        )
        .await
        .unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["id"], json!(1));
        let first = run_pos_barcode_query(
            &mut conn,
            "a",
            "pos.barcode_first",
            Some("CODE"),
            None,
            1,
            0,
        )
        .await
        .unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["inventory_id"], "a-lot");
        assert!(first[0]["avg_cost_price"].is_null());
        let own = run_pos_barcode_query(
            &mut conn,
            "a-owner",
            "pos.barcode_first",
            Some("CODE"),
            None,
            1,
            0,
        )
        .await
        .unwrap();
        assert_eq!(own[0]["avg_cost_price"], json!(23.0));
        let batches =
            run_pos_barcode_query(&mut conn, "a", "pos.barcode_batches", None, Some(1), 200, 0)
                .await
                .unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0]["inventory_id"], "a-lot");
        assert!(batches[0]["cost_price"].is_null());
        assert!(run_pos_barcode_query(
            &mut conn,
            "a",
            "pos.barcode_batches",
            None,
            Some(2),
            200,
            0
        )
        .await
        .unwrap()
        .is_empty());
        assert_eq!(
            run_pos_barcode_query(
                &mut conn,
                "b",
                "pos.barcode_candidates",
                Some("CODE"),
                None,
                2,
                0
            )
            .await
            .unwrap()[0]["id"],
            json!(2)
        );
        for actor in ["blocked", "inactive", "unknown"] {
            assert!(run_pos_barcode_query(
                &mut conn,
                actor,
                "pos.barcode_first",
                Some("CODE"),
                None,
                1,
                0
            )
            .await
            .is_err());
        }
        assert!(run_pos_barcode_query(
            &mut conn,
            "a",
            "pos.barcode_candidates",
            Some("CODE"),
            None,
            3,
            0
        )
        .await
        .is_err());
        assert!(run_pos_barcode_query(
            &mut conn,
            "a",
            "pos.barcode_batches",
            None,
            Some(0),
            200,
            0
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn invoice_linked_patient_picker_scopes_completed_sales_and_roles_without_claiming_patient_ownership(
    ) {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute(r#"CREATE TABLE users(id TEXT,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
            INSERT INTO users VALUES('report-a','cashier','{"rep_can_view_sales":true}','a',1),
              ('patient-a','cashier','{"can_view_patients":true}','a',1),
              ('denied-a','cashier','{}','a',1),('owner-b','owner','{}','b',1),
              ('inactive-a','owner','{}','a',0);
            CREATE TABLE patients(id TEXT,full_name TEXT,name_en TEXT,phone TEXT,notes TEXT);
            INSERT INTO patients VALUES('only-a','Alpha','Alpha','1','secret-a'),
              ('only-b','Beta','Beta','2','secret-b'),
              ('draft-a','Draft','Draft','3','draft'),
              ('shared','Shared','Shared','4','do-not-infer'),
              ('unlinked','Unlinked','Unlinked','5','unlinked');
            CREATE TABLE sales_invoices(id TEXT,patient_id TEXT,pharmacy_id TEXT,status TEXT);
            INSERT INTO sales_invoices VALUES('a1','only-a','a','completed'),
              ('a2','shared','a','delivered'),('b1','only-b','b','completed'),
              ('b2','shared','b','completed'),('a3','draft-a','a','draft');"#)
            .await.unwrap();
        let a = run_invoice_patient_picker_query(&mut conn, "report-a", 200, 0)
            .await
            .unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[0]["id"], "only-a");
        assert_eq!(a[1]["id"], "shared");
        assert!(a
            .iter()
            .all(|patient| patient.get("phone").is_none() && patient.get("notes").is_none()));
        assert_eq!(
            run_invoice_patient_picker_query(&mut conn, "patient-a", 200, 0)
                .await
                .unwrap()
                .len(),
            2
        );
        let b = run_invoice_patient_picker_query(&mut conn, "owner-b", 200, 0)
            .await
            .unwrap();
        assert_eq!(b.len(), 2);
        assert_eq!(b[0]["id"], "only-b");
        assert!(
            run_invoice_patient_picker_query(&mut conn, "denied-a", 200, 0)
                .await
                .is_err()
        );
        assert!(
            run_invoice_patient_picker_query(&mut conn, "inactive-a", 200, 0)
                .await
                .is_err()
        );
        assert!(
            run_invoice_patient_picker_query(&mut conn, "report-a", 201, 0)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn kpi_dashboard_values_are_native_scoped_to_actor_pharmacy() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute(
            r#"CREATE TABLE users(id TEXT,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
               INSERT INTO users VALUES
                 ('a','owner','{}','a',1),('b','owner','{}','b',1),
                 ('denied','cashier','{}','a',1);
               CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,created_at TEXT,status TEXT,total_amount REAL,payment_method TEXT);
               INSERT INTO sales_invoices VALUES
                 ('sa','a',datetime('now'),'completed',100,'cash'),
                 ('sb','b',datetime('now'),'completed',5000,'cash'),
                 ('sd','a',datetime('now'),'draft',999,'cash'),
                 ('del','a',datetime('now'),'completed',40,'delivery');
               CREATE TABLE master_drugs(id INTEGER,medium_unit TEXT,small_unit TEXT,
                 large_to_medium REAL,medium_to_small REAL,has_expiry INTEGER,reorder_point REAL);
               INSERT INTO master_drugs VALUES(1,'strip','tablet',10,10,0,5);
               CREATE TABLE sales_items(invoice_id TEXT,drug_id INTEGER,quantity_sold REAL,
                 unit TEXT,large_to_medium REAL,medium_to_small REAL,cost_price REAL);
               INSERT INTO sales_items VALUES('sa',1,2,'large',10,10,10),
                 ('sb',1,80,'large',10,10,30),('del',1,1,'large',10,10,10);
               CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
               INSERT INTO trial_balance_settings VALUES('cash_drawer',6);
               CREATE TABLE daily_journals(id TEXT,pharmacy_id TEXT);
               INSERT INTO daily_journals VALUES('ja','a'),('jb','b');
               CREATE TABLE journal_entries(journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
               INSERT INTO journal_entries VALUES('ja',6,'debit',90),('jb',6,'debit',900);
               CREATE TABLE inventory(id TEXT,drug_id INTEGER,pharmacy_id TEXT,cost_price REAL,
                 quantity REAL,expiry_date TEXT);
               INSERT INTO inventory VALUES('ia',1,'a',10,2,NULL),('ib',1,'b',40,2,NULL);
               CREATE TABLE stock_adjustments(inventory_id TEXT,created_at TEXT,
                 old_quantity REAL,new_quantity REAL);
               INSERT INTO stock_adjustments VALUES('ia',datetime('now'),8,2),
                 ('ib',datetime('now'),12,2);"#,
        ).await.unwrap();
        let a = run_sales_reporting_query(&mut conn, "a", "reports.kpis", 1, 1, 0)
            .await
            .unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["sales_today"], json!(140.0));
        assert_eq!(a[0]["gross_profit_today"], json!(110.0));
        assert_eq!(a[0]["liquidity"], json!(90.0));
        assert_eq!(a[0]["pending_delivery_cash"], json!(40.0));
        assert_eq!(a[0]["shrinkage_today"], json!(60.0));
        assert_eq!(a[0]["stock_alerts_count"], json!(1));
        let b = run_sales_reporting_query(&mut conn, "b", "reports.kpis", 1, 1, 0)
            .await
            .unwrap();
        assert_eq!(b[0]["sales_today"], json!(5000.0));
        assert_eq!(b[0]["liquidity"], json!(900.0));
        assert_eq!(b[0]["pending_delivery_cash"].as_f64(), Some(0.0));
        assert!(
            run_sales_reporting_query(&mut conn, "denied", "reports.kpis", 1, 1, 0)
                .await
                .is_err()
        );
        assert!(
            run_sales_reporting_query(&mut conn, "a", "reports.kpis", 1, 1, 1)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn dashboard_trend_preserves_medium_sale_and_return_costs_and_tenant_scope() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        // Native sale/return created_at is stored in UTC (CURRENT_TIMESTAMP).
        // The dashboard applies 'localtime' once when assigning a report day;
        // seeding already-local timestamps would apply the offset twice.
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
            INSERT INTO users VALUES('report-a','cashier','{"rep_can_view_sales":true}','a',1);
            CREATE TABLE sales_invoices(id TEXT,pharmacy_id TEXT,status TEXT,total_amount REAL,created_at TEXT);
            INSERT INTO sales_invoices VALUES
              ('sale-a','a','completed',30,datetime('now')),
              ('sale-b','b','completed',900,datetime('now'));
            CREATE TABLE sales_items(id INTEGER,invoice_id TEXT,inventory_id TEXT,drug_id INTEGER,
              unit TEXT,quantity_sold REAL,cost_price REAL,large_to_medium REAL,medium_to_small REAL);
            INSERT INTO sales_items VALUES
              (1,'sale-a','lot-a',10,'medium',2,0,10,10),
              (2,'sale-b','lot-b',10,'medium',80,0,10,10);
            CREATE TABLE inventory(id TEXT,drug_id INTEGER,pharmacy_id TEXT,cost_price REAL,
              strips_per_box REAL,medium_to_small REAL);
            INSERT INTO inventory VALUES('lot-a',10,'a',100,10,10),('lot-b',10,'b',500,10,10);
            CREATE TABLE master_drugs(id INTEGER,medium_unit TEXT,small_unit TEXT,
              large_to_medium REAL,medium_to_small REAL,base_price REAL);
            INSERT INTO master_drugs VALUES(10,'strip','tablet',10,10,50);
            CREATE TABLE returns(id TEXT,pharmacy_id TEXT,status TEXT,total_refund REAL,created_at TEXT);
            INSERT INTO returns VALUES
              ('return-a','a','approved',5,datetime('now')),
              ('return-b','b','approved',200,datetime('now'));
            CREATE TABLE return_items(return_id TEXT,sale_item_id INTEGER,inventory_id TEXT,
              drug_id INTEGER,quantity_returned REAL,unit TEXT);
            INSERT INTO return_items VALUES('return-a',1,'lot-a',10,1,'medium'),
              ('return-b',2,'lot-b',10,30,'medium');
        "#).execute(&mut conn).await.unwrap();

        let rows = run_dashboard_query(&mut conn, "report-a", "dashboard.trend")
            .await
            .unwrap();
        let today = sqlx::query_scalar::<_, String>("SELECT date('now','localtime')")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let today = rows.iter().find(|row| row["date"] == today).unwrap();
        assert_eq!(today["sales"], json!(30.0));
        assert_eq!(today["returns"], json!(5.0));
        // Two medium units at 100 per large unit cost 20; the returned
        // medium unit removes 10, leaving COGS 10. Tenant B is excluded.
        assert_eq!(today["cogs"], json!(10.0));
        assert_eq!(rows.len(), 30);
    }

    #[tokio::test]
    async fn sales_report_views_require_native_reporting_role_and_hide_foreign_pharmacy() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute(
            r#"CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,is_active INTEGER,permissions TEXT);
                INSERT INTO users VALUES
                  ('owner-a','owner','a',1,'{}'),
                  ('report-a','cashier','a',1,'{"rep_can_view_sales":true}'),
                  ('denied-a','cashier','a',1,'{}'),
                  ('inactive-a','owner','a',0,'{}'),
                  ('owner-b','owner','b',1,'{}'),
                  ('owner-local','owner',NULL,1,'{}');
                CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,created_at TEXT,
                   status TEXT,total_amount REAL);
                INSERT INTO sales_invoices VALUES
                  ('a1','a',datetime('now'),'completed',13),
                  ('a-draft','a',datetime('now'),'draft',700),
                  ('b1','b',datetime('now'),'completed',9000),
                  ('legacy',NULL,datetime('now'),'completed',200);
                CREATE TABLE returns(id TEXT,pharmacy_id TEXT,created_at TEXT,status TEXT,total_refund REAL);
                INSERT INTO returns VALUES
                  ('a-r','a',datetime('now'),'approved',3),
                  ('b-r','b',datetime('now'),'approved',500),
                  ('legacy-r',NULL,datetime('now'),'approved',20);
                CREATE TABLE master_drugs(id INTEGER,trade_name TEXT,category TEXT,medium_unit TEXT,small_unit TEXT,
                  large_to_medium REAL,medium_to_small REAL);
                INSERT INTO master_drugs VALUES(5,'Medicine','A', 'strip','tablet',10,10);
                CREATE TABLE sales_items(invoice_id TEXT,drug_id INTEGER,quantity_sold REAL,unit TEXT,
                  large_to_medium REAL,medium_to_small REAL);
                INSERT INTO sales_items VALUES
                  ('a1',5,2,'large',10,10), ('b1',5,900,'large',10,10),
                  ('legacy',5,3,'large',10,10);"#,
        ).await.unwrap();

        let a = run_sales_reporting_query(&mut conn, "report-a", "reports.trend", 7, 7, 0)
            .await
            .unwrap();
        assert_eq!(a.len(), 7);
        assert_eq!(a.last().unwrap()["sales"], json!(13.0));
        assert_eq!(a.last().unwrap()["returns"], json!(3.0));
        let b = run_sales_reporting_query(&mut conn, "owner-b", "reports.trend", 1, 1, 0)
            .await
            .unwrap();
        assert_eq!(b[0]["sales"], json!(9000.0));
        assert_eq!(b[0]["returns"], json!(500.0));
        let local = run_sales_reporting_query(&mut conn, "owner-local", "reports.trend", 1, 1, 0)
            .await
            .unwrap();
        assert_eq!(local[0]["sales"], json!(200.0));
        let history =
            run_sales_reporting_query(&mut conn, "report-a", "reports.sales_history", 30, 200, 0)
                .await
                .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["total_amount"], json!(13.0));
        let drugs = run_sales_reporting_query(&mut conn, "report-a", "reports.top_drugs", 30, 1, 0)
            .await
            .unwrap();
        assert_eq!(drugs[0]["quantity_sold"], json!(2.0));
        let units =
            run_sales_reporting_query(&mut conn, "report-a", "reports.total_units", 30, 1, 0)
                .await
                .unwrap();
        assert_eq!(units[0]["total"], json!(2.0));
        for actor in ["denied-a", "inactive-a", "unknown"] {
            assert!(
                run_sales_reporting_query(&mut conn, actor, "reports.trend", 7, 7, 0)
                    .await
                    .is_err()
            );
        }
        for days in [0, 367] {
            assert!(
                run_sales_reporting_query(&mut conn, "owner-a", "reports.trend", days, 1, 0)
                    .await
                    .is_err()
            );
        }
        assert!(
            run_sales_reporting_query(&mut conn, "owner-a", "reports.other", 30, 1, 0)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn typed_queries_scope_rows_and_hide_staff_credentials() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute("CREATE TABLE users(id TEXT,username TEXT,full_name TEXT,role TEXT,is_active INTEGER,pharmacy_id TEXT,password_hash TEXT,permissions TEXT);
            INSERT INTO users VALUES('owner-a','a','A','owner',1,'a','secret-a','{}'),('cashier-a','ca','C','cashier',1,'a','secret-ca','{\"can_access_pos\":true}'),('owner-b','b','B','owner',1,'b','secret-b','{}'),('blocked-a','blocked','D','cashier',1,'a','secret-blocked','{\"can_access_pos\":false}');
            CREATE TABLE inventory(id TEXT,pharmacy_id TEXT,quantity INTEGER,drug_id INTEGER,expiry_date TEXT,barcode TEXT,batch_number TEXT,local_selling_price REAL,strips_per_box INTEGER,cost_price REAL);
            INSERT INTO inventory VALUES('ia','a',1,1,NULL,NULL,NULL,10,1,55),('ib','b',99,1,NULL,NULL,NULL,100,1,99);
            CREATE TABLE sales_invoices(id TEXT,pharmacy_id TEXT,user_id TEXT);
            INSERT INTO sales_invoices VALUES('sa','a','cashier-a'),('sa-owner','a','owner-a'),('sb','b','owner-b');
            CREATE TABLE sales_items(id INTEGER,invoice_id TEXT,total INTEGER);
            INSERT INTO sales_items VALUES(1,'sa',10),(2,'sb',90),(3,'sa-owner',44);")
            .await.unwrap();
        for (name, key, expected) in [
            ("cashier-a", "inventory.list", "ia"),
            ("cashier-a", "sales.invoices", "sa"),
        ] {
            let rows = run_typed_query(&mut conn, name, key, None, 100, 0)
                .await
                .unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["id"], expected);
        }
        let items = run_typed_query(&mut conn, "cashier-a", "sales.items", None, 20, 0)
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], 1);
        let public_inventory =
            run_typed_query(&mut conn, "cashier-a", "inventory.list", None, 20, 0)
                .await
                .unwrap();
        assert!(public_inventory[0].get("cost_price").is_none());
        let private_inventory =
            run_typed_query(&mut conn, "owner-a", "inventory.list", None, 20, 0)
                .await
                .unwrap();
        assert_eq!(private_inventory[0]["cost_price"], 55.0);
        let owner_invoices = run_typed_query(&mut conn, "owner-a", "sales.invoices", None, 20, 0)
            .await
            .unwrap();
        assert_eq!(owner_invoices.len(), 2);
        let staff = run_typed_query(&mut conn, "owner-a", "staff.owner_list", None, 20, 0)
            .await
            .unwrap();
        assert_eq!(staff.len(), 3);
        assert!(staff.iter().all(|row| row.get("password_hash").is_none()));
        assert!(
            run_typed_query(&mut conn, "cashier-a", "staff.owner_list", None, 20, 0)
                .await
                .is_err()
        );
        assert!(
            run_typed_query(&mut conn, "cashier-a", "users", None, 20, 0)
                .await
                .is_err()
        );
        assert!(
            run_typed_query(&mut conn, "cashier-a", "inventory.list", Some("ib"), 20, 0)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            run_typed_query(&mut conn, "blocked-a", "inventory.list", None, 20, 0)
                .await
                .is_err()
        );
        assert!(
            run_typed_query(&mut conn, "blocked-a", "sales.invoices", None, 20, 0)
                .await
                .is_err()
        );
        assert!(
            run_typed_query(&mut conn, "cashier-a", "inventory.list", None, 10000, 0)
                .await
                .is_err()
        );
        assert!(
            run_typed_query(&mut conn, "inactive", "inventory.list", None, 20, 0)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn synthetic_single_pharmacy_scope_repair_retains_actual_native_role_permissions() {
        // SYNTHETIC ONLY: This in-memory fixture contains no original data and
        // the test's explicit updates are NOT a historical authorization path.
        // The native reader must not absorb NULL or local_default by itself:
        // only an externally reviewed, separately performed scope mapping can
        // make a source visible. Role permissions still apply afterwards.
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,full_name TEXT,
               role TEXT,is_active INTEGER,pharmacy_id TEXT,password_hash TEXT,permissions TEXT);
            INSERT INTO users VALUES
              ('owner','owner','Owner','owner',1,'primary_pharmacy','owner-private','{}'),
              ('pharmacist','staff','Staff','pharmacist',1,'primary_pharmacy','staff-private',
                 '{"can_manage_inventory":false,"can_access_pos":true,"rep_can_view_sales":false}'),
              ('reporter','report','Report','admin',1,'primary_pharmacy','report-private',
                 '{"rep_can_view_sales":true,"can_access_pos":false,"can_manage_inventory":false}'),
              ('inactive','inactive','Inactive','owner',0,'primary_pharmacy','hash','{}'),
              ('outsider','other','Foreign','owner',1,'pharmacy_two','hash','{}');
            CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT,quantity INTEGER,
               drug_id INTEGER,expiry_date TEXT,barcode TEXT,batch_number TEXT,
               local_selling_price REAL,strips_per_box INTEGER,cost_price REAL);
            INSERT INTO inventory VALUES
              ('lot-placeholder','local_default',7,1,NULL,NULL,NULL,13,1,9.0017),
              ('lot-null',NULL,11,1,NULL,NULL,NULL,12,1,5.019),
              ('foreign-lot','pharmacy_two',90,1,NULL,NULL,NULL,99,1,30);
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT);
            INSERT INTO sales_invoices VALUES
              ('sale-placeholder','local_default','pharmacist'),
              ('sale-null',NULL,'owner'),
              ('foreign-sale','pharmacy_two','outsider');
            CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,total INTEGER);
            INSERT INTO sales_items VALUES
              (1,'sale-placeholder',21),(2,'sale-null',34),(3,'foreign-sale',900);
        "#).await.unwrap();

        assert!(run_typed_query(&mut conn,"owner","inventory.list",None,20,0)
            .await.unwrap().is_empty());
        assert!(run_typed_query(&mut conn,"owner","sales.invoices",None,20,0)
            .await.unwrap().is_empty());

        // The authorized-mapping mechanism is intentionally NOT present in
        // this test: mutate ONLY the fresh RAM fixture to exercise the typed
        // reader after an independently completed hypothetical repair.
        for table in ["inventory", "sales_invoices"] {
            let sql = format!("UPDATE {table} SET pharmacy_id='primary_pharmacy' \
                WHERE pharmacy_id IS NULL OR pharmacy_id='local_default'");
            sqlx::query(&sql).execute(&mut conn).await.unwrap();
        }
        let owner_stock = run_typed_query(&mut conn,"owner","inventory.list",None,20,0)
            .await.unwrap();
        assert_eq!(owner_stock.len(),2);
        assert!(owner_stock.iter().all(|row| row.get("cost_price").is_some()));
        assert!(owner_stock.iter().any(|row| row["cost_price"]==json!(9.0017)));
        let owner_sales = run_typed_query(&mut conn,"owner","sales.invoices",None,20,0)
            .await.unwrap();
        assert_eq!(owner_sales.len(),2);

        let staff_stock = run_typed_query(&mut conn,"pharmacist","inventory.list",None,20,0)
            .await.unwrap();
        assert_eq!(staff_stock.len(),2);
        assert!(staff_stock.iter().all(|row| row.get("cost_price").is_none()));
        let staff_sales = run_typed_query(&mut conn,"pharmacist","sales.invoices",None,20,0)
            .await.unwrap();
        assert_eq!(staff_sales.len(),1);
        assert_eq!(staff_sales[0]["id"],"sale-placeholder");
        assert_eq!(run_typed_query(&mut conn,"reporter","sales.items",None,20,0)
            .await.unwrap().len(),2);
        assert!(run_typed_query(&mut conn,"reporter","inventory.list",None,20,0)
            .await.is_err());
        assert!(run_typed_query(&mut conn,"inactive","inventory.list",None,20,0)
            .await.is_err());
        assert_eq!(run_typed_query(&mut conn,"outsider","inventory.list",None,20,0)
            .await.unwrap().len(),1);
        assert_eq!(run_typed_query(&mut conn,"owner","staff.owner_list",None,20,0)
            .await.unwrap().len(),4);
        assert!(run_typed_query(&mut conn,"pharmacist","staff.owner_list",None,20,0)
            .await.is_err());
    }

    #[tokio::test]
    async fn stock_adjustment_sources_use_authenticated_owned_rows_and_include_zero_lots() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,is_active INTEGER,permissions TEXT);
            INSERT INTO users VALUES
              ('owner-a','owner','tenant-a',1,'{}'),
              ('blocked-a','cashier','tenant-a',1,'{"can_manage_inventory":false}'),
              ('owner-b','owner','tenant-b',1,'{}'),
              ('legacy','owner','local_default',1,'{}');
            CREATE TABLE adjustment_reasons(id INTEGER PRIMARY KEY,name_ar TEXT,name_en TEXT);
            INSERT INTO adjustment_reasons VALUES(2,'Physical stock count','Count');
            CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,barcode TEXT);
            INSERT INTO master_drugs VALUES(17,'5%rx blend','RX blend','M-17');
            CREATE TABLE inventory(id TEXT,drug_id INTEGER,pharmacy_id TEXT,quantity REAL,barcode TEXT);
            INSERT INTO inventory VALUES
              ('zero-a',17,'tenant-a',0,'A-LOT'),
              ('five-a',17,'tenant-a',5,NULL),
              ('foreign-b',17,'tenant-b',100,NULL),
              ('unowned',17,NULL,50,NULL),
              ('legacy-lot',17,'local_default',99,NULL);
        "#).execute(&mut conn).await.unwrap();
        let reasons = run_stock_adjustment_source_query(
            &mut conn,"owner-a","inventory.adjustment_reasons",None,100,0,
        ).await.unwrap();
        assert_eq!(reasons.len(), 1);
        assert_eq!(reasons[0]["id"], 2);
        let lots = run_stock_adjustment_source_query(
            &mut conn,"owner-a","inventory.adjustment_lots",Some("5%rx"),20,0,
        ).await.unwrap();
        assert_eq!(lots.len(), 2);
        assert_eq!(lots[0]["id"], "five-a");
        assert_eq!(lots[1]["id"], "zero-a");
        assert_eq!(lots[1]["quantity"], 0.0);
        assert!(run_stock_adjustment_source_query(
            &mut conn,"blocked-a","inventory.adjustment_lots",Some("5%rx"),20,0,
        ).await.is_err());
        assert!(run_stock_adjustment_source_query(
            &mut conn,"legacy","inventory.adjustment_reasons",None,100,0,
        ).await.is_err());
        assert!(run_stock_adjustment_source_query(
            &mut conn,"owner-a","inventory.adjustment_lots",Some("%"),20,0,
        ).await.is_err());
        assert!(run_stock_adjustment_source_query(
            &mut conn,"owner-a","inventory.adjustment_reasons",Some("SELECT"),100,0,
        ).await.is_err());
        let b = run_stock_adjustment_source_query(
            &mut conn,"owner-b","inventory.adjustment_lots",Some("5%rx"),20,0,
        ).await.unwrap();
        assert_eq!(b.len(),1);
        assert_eq!(b[0]["id"],"foreign-b");
    }

    #[tokio::test]
    async fn enriched_inventory_read_is_tenant_bound_searchable_and_role_guarded() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT,role TEXT,is_active INTEGER,pharmacy_id TEXT,permissions TEXT);
            INSERT INTO users VALUES
              ('staff-a','pharmacist',1,'a','{"can_view_stores":true,"can_manage_inventory":true}'),
              ('staff-b','pharmacist',1,'b','{"can_view_stores":true}'),
              ('viewer-a','cashier',1,'a','{"can_view_stores":true,"can_manage_inventory":false}'),
              ('owner-a','owner',1,'a','{}'),
              ('blocked-a','cashier',1,'a','{"can_view_stores":false}');
            CREATE TABLE master_drugs(id INTEGER,barcode TEXT,trade_name TEXT,trade_name_en TEXT,
              generic_name TEXT,active_ingredient TEXT,category TEXT,manufacturer TEXT,large_to_medium INTEGER);
            INSERT INTO master_drugs VALUES(3,'PUBLIC','Aspirin','Aspirin','ASA','ASA','pain','M',10);
            CREATE TABLE inventory(id TEXT,pharmacy_id TEXT,quantity INTEGER,drug_id INTEGER,
              expiry_date TEXT,local_selling_price REAL,cost_price REAL,strips_per_box INTEGER,barcode TEXT);
            INSERT INTO inventory VALUES
              ('own-a','a',4,3,'2027-01-01',12,8,10,NULL),
              ('foreign-b','b',40,3,'2027-01-01',99,90,10,'SAME'),
              ('empty-a','a',0,3,'2027-01-01',12,8,10,NULL);
        "#).execute(&mut conn).await.unwrap();
        let own = run_inventory_enriched_query(&mut conn, "staff-a", Some("Aspirin"), None, 200, 0)
            .await
            .unwrap();
        assert_eq!(own.len(), 1);
        assert_eq!(own[0]["id"], "own-a");
        assert_eq!(own[0]["cost_price"], 8.0);
        assert_eq!(own[0]["trade_name"], "Aspirin");
        let viewer = run_inventory_enriched_query(&mut conn, "viewer-a", None, None, 200, 0)
            .await
            .unwrap();
        assert_eq!(viewer.len(), 1);
        assert_eq!(viewer[0]["id"], "own-a");
        assert!(viewer[0]["cost_price"].is_null());
        let owner = run_inventory_enriched_query(&mut conn, "owner-a", None, None, 200, 0)
            .await
            .unwrap();
        assert_eq!(owner[0]["cost_price"], 8.0);
        assert!(
            run_inventory_enriched_query(&mut conn, "staff-a", Some("SAME"), None, 200, 0)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            run_inventory_enriched_query(&mut conn, "staff-a", None, Some(999), 200, 0)
                .await
                .unwrap()
                .is_empty()
        );
        let other = run_inventory_enriched_query(&mut conn, "staff-b", None, None, 200, 0)
            .await
            .unwrap();
        assert_eq!(other.len(), 1);
        assert_eq!(other[0]["id"], "foreign-b");
        assert!(other[0]["cost_price"].is_null());
        assert!(
            run_inventory_enriched_query(&mut conn, "blocked-a", None, None, 200, 0)
                .await
                .is_err()
        );
        assert!(run_inventory_enriched_query(
            &mut conn,
            "staff-a",
            Some(&"x".repeat(129)),
            None,
            200,
            0
        )
        .await
        .is_err());
        assert!(
            run_inventory_enriched_query(&mut conn, "staff-a", None, None, 201, 0)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn sales_dashboard_report_denies_unprivileged_roles_and_never_combines_pharmacies() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT,role TEXT,is_active INTEGER,pharmacy_id TEXT,permissions TEXT);
            INSERT INTO users VALUES
              ('reporter-a','cashier',1,'a','{"rep_can_view_sales":true}'),
              ('reporter-b','admin',1,'b','{"rep_can_view_sales":true}'),
              ('blocked-a','cashier',1,'a','{"can_access_pos":true,"rep_can_view_sales":false}'),
              ('owner-a','owner',1,'a','{}'),
              ('owner-default','owner',1,NULL,'{}'),
              ('inactive-b','cashier',0,'b','{"rep_can_view_sales":true}');
            CREATE TABLE sales_invoices(id TEXT,pharmacy_id TEXT,total_amount REAL,
              payment_method TEXT,status TEXT,created_at TEXT);
            INSERT INTO sales_invoices VALUES
              ('a-today','a',100,'cash','completed',datetime('now')),
              ('a-delivery','a',40,'delivery','completed',datetime('now')),
              ('a-legacy','a',20,'cash',NULL,datetime('now')),
              ('a-yesterday','a',70,'cash','approved',datetime('now','-1 day')),
              ('a-draft','a',1000,'delivery','draft',datetime('now')),
              ('a-cancelled','a',300,'delivery','cancelled',datetime('now')),
              ('b-today','b',900,'cash','completed',datetime('now')),
              ('b-delivery','b',600,'delivery','completed',datetime('now')),
              ('b-yesterday','b',700,'cash','delivered',datetime('now','-1 day')),
              ('default-today',NULL,999,'cash','completed',datetime('now'));
        "#).execute(&mut conn).await.unwrap();

        let a = run_sales_dashboard_stats_query(&mut conn, "reporter-a")
            .await
            .unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["today_total"], 160.0);
        assert_eq!(a[0]["yesterday_total"], 70.0);
        assert_eq!(a[0]["delivery_count"], 1);
        assert_eq!(a[0]["pending_delivery_count"], 1);
        assert!((a[0]["today_average"].as_f64().unwrap() - 160.0 / 3.0).abs() < 0.01);
        assert_eq!(a[0]["yesterday_average"], 70.0);

        let b = run_sales_dashboard_stats_query(&mut conn, "reporter-b")
            .await
            .unwrap();
        assert_eq!(b[0]["today_total"], 1500.0);
        assert_eq!(b[0]["yesterday_total"], 700.0);
        assert_eq!(b[0]["delivery_count"], 1);
        assert_eq!(b[0]["today_average"], 750.0);
        assert_eq!(
            run_sales_dashboard_stats_query(&mut conn, "owner-a")
                .await
                .unwrap(),
            a
        );
        let local_default = run_sales_dashboard_stats_query(&mut conn, "owner-default")
            .await
            .unwrap();
        assert_eq!(local_default[0]["today_total"], 999.0);
        assert!(run_sales_dashboard_stats_query(&mut conn, "blocked-a")
            .await
            .is_err());
        assert!(run_sales_dashboard_stats_query(&mut conn, "inactive-b")
            .await
            .is_err());
        assert!(run_sales_dashboard_stats_query(&mut conn, "unknown")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn suspended_invoice_parts_require_pos_and_visibility_and_scope_every_child_row() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT,role TEXT,is_active INTEGER,pharmacy_id TEXT,permissions TEXT);
            INSERT INTO users VALUES
              ('cashier-a','cashier',1,'a','{"can_access_pos":true,"show_suspended_invoices":true}'),
              ('owner-b','owner',1,'b','{}'),
              ('owner-default','owner',1,NULL,'{}'),
              ('blocked-show','cashier',1,'a','{"can_access_pos":true,"show_suspended_invoices":false}'),
              ('blocked-pos','cashier',1,'a','{"can_access_pos":false,"show_suspended_invoices":true}'),
              ('reporter-a','pharmacist',1,'a','{"rep_can_view_sales":true}'),
              ('inactive-a','owner',0,'a','{}');
            CREATE TABLE patients(id TEXT,full_name TEXT);
            INSERT INTO patients VALUES('patient-a','Patient A'),('patient-b','Patient B');
            CREATE TABLE sales_invoices(id TEXT,pharmacy_id TEXT,status TEXT,
              patient_id TEXT,total_amount REAL,created_at TEXT,payment_method TEXT,
              check_number TEXT,discount_amount REAL);
            INSERT INTO sales_invoices VALUES
              ('draft-a1','a','draft','patient-a',19,'2026-10-10','check','CHK-1',2),
              ('draft-a2','a','draft',NULL,8,'2026-10-09','cash',NULL,0),
              ('completed-a','a','completed',NULL,100,'2026-10-11','cash',NULL,0),
              ('draft-b','b','draft','patient-b',900,'2026-10-11','cash',NULL,0),
              ('draft-default','local_default','draft',NULL,30,'2026-10-08','cash',NULL,0);
            CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,has_expiry INTEGER,
              trade_name TEXT,trade_name_en TEXT,active_ingredient TEXT,
              large_unit TEXT,medium_unit TEXT,small_unit TEXT,
              large_to_medium INTEGER,medium_to_small INTEGER,official_price REAL);
            INSERT INTO master_drugs VALUES
              (1,1,'Drug A','Drug A','A','box','strip','tablet',10,2,15),
              (2,1,'Drug B','Drug B','B','box','strip','tablet',10,1,50),
              (3,0,'Drug C','Drug C','C','box','bottle',NULL,1,1,20);
            CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER,
              quantity_sold REAL,unit_price REAL,item_discount_percent REAL,
              unit TEXT,is_negative INTEGER);
            INSERT INTO sales_items VALUES
              (11,'draft-a1',1,1,15,10,'large',0),
              (12,'draft-a1',2,1,4,0,'large',1),
              (13,'draft-b',1,5,900,0,'large',0),
              (14,'completed-a',1,1,10,0,'large',0),
              (15,'draft-default',3,1,20,0,'large',0);
            CREATE TABLE inventory(id TEXT,pharmacy_id TEXT,drug_id INTEGER,quantity INTEGER,
              expiry_date TEXT,local_selling_price REAL,strips_per_box INTEGER,
              medium_to_small INTEGER,created_at TEXT);
            INSERT INTO inventory VALUES
              ('valid-a','a',1,4,'2099-12-31',17,10,2,'2026-10-01'),
              ('expired-a','a',1,7,'2020-01-01',16,10,2,'2026-10-01'),
              ('zero-a','a',1,0,'2099-12-31',14,10,2,'2026-10-01'),
              ('unknown-a','a',1,6,NULL,14,10,2,'2026-10-01'),
              ('negative-a','a',2,20,'2099-12-31',50,10,1,'2026-10-01'),
              ('foreign-b','b',1,100,'2099-12-31',90,10,2,'2026-10-01'),
              ('default-null',NULL,3,2,NULL,22,1,1,'2026-10-01');
        "#).execute(&mut conn).await.unwrap();

        let list =
            run_suspended_invoice_query(&mut conn, "cashier-a", "sales.suspended.list", None, 1, 0)
                .await
                .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], "draft-a1");
        assert_eq!(list[0]["patient_name"], "Patient A");
        assert_eq!(list[0]["check_number"], "CHK-1");
        let next =
            run_suspended_invoice_query(&mut conn, "cashier-a", "sales.suspended.list", None, 1, 1)
                .await
                .unwrap();
        assert_eq!(next[0]["id"], "draft-a2");
        assert!(run_suspended_invoice_query(
            &mut conn,
            "cashier-a",
            "sales.suspended.list",
            Some("draft-b"),
            200,
            0,
        )
        .await
        .is_err());

        let items = run_suspended_invoice_query(
            &mut conn,
            "cashier-a",
            "sales.suspended.items",
            Some("draft-a1"),
            200,
            0,
        )
        .await
        .unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["drug_id"], 1);
        assert_eq!(items[0]["item_discount_percent"], 10.0);
        assert_eq!(items[0]["selectedUnit"], "large");
        let batches = run_suspended_invoice_query(
            &mut conn,
            "cashier-a",
            "sales.suspended.batches",
            Some("draft-a1"),
            200,
            0,
        )
        .await
        .unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0]["inventory_id"], "valid-a");
        assert_eq!(batches[0]["quantity"], 4);

        for query in ["sales.suspended.items", "sales.suspended.batches"] {
            assert!(run_suspended_invoice_query(
                &mut conn,
                "cashier-a",
                query,
                Some("draft-b"),
                200,
                0,
            )
            .await
            .unwrap()
            .is_empty());
            assert!(run_suspended_invoice_query(
                &mut conn,
                "cashier-a",
                query,
                Some("completed-a"),
                200,
                0,
            )
            .await
            .unwrap()
            .is_empty());
            assert!(
                run_suspended_invoice_query(&mut conn, "cashier-a", query, None, 200, 0,)
                    .await
                    .is_err()
            );
        }
        let b =
            run_suspended_invoice_query(&mut conn, "owner-b", "sales.suspended.list", None, 200, 0)
                .await
                .unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0]["id"], "draft-b");
        let b_batches = run_suspended_invoice_query(
            &mut conn,
            "owner-b",
            "sales.suspended.batches",
            Some("draft-b"),
            200,
            0,
        )
        .await
        .unwrap();
        assert_eq!(b_batches.len(), 1);
        assert_eq!(b_batches[0]["inventory_id"], "foreign-b");
        let default = run_suspended_invoice_query(
            &mut conn,
            "owner-default",
            "sales.suspended.batches",
            Some("draft-default"),
            200,
            0,
        )
        .await
        .unwrap();
        assert_eq!(default.len(), 1);
        assert_eq!(default[0]["inventory_id"], "default-null");

        for actor in [
            "blocked-show",
            "blocked-pos",
            "reporter-a",
            "inactive-a",
            "unknown",
        ] {
            for query in [
                "sales.suspended.list",
                "sales.suspended.items",
                "sales.suspended.batches",
            ] {
                let record = if query == "sales.suspended.list" {
                    None
                } else {
                    Some("draft-a1")
                };
                assert!(
                    run_suspended_invoice_query(&mut conn, actor, query, record, 200, 0,)
                        .await
                        .is_err(),
                    "{actor} {query}"
                );
            }
        }
        assert!(run_suspended_invoice_query(
            &mut conn,
            "cashier-a",
            "sales.suspended.items",
            Some("draft-a1"),
            201,
            0,
        )
        .await
        .is_err());
        assert!(run_suspended_invoice_query(
            &mut conn,
            "cashier-a",
            "sales.suspended.batches",
            Some("draft-a1"),
            200,
            50_001,
        )
        .await
        .is_err());
        assert!(run_suspended_invoice_query(
            &mut conn,
            "cashier-a",
            "sales.suspended.items",
            Some("x\0z"),
            200,
            0,
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn purchase_invoice_list_is_role_tenant_and_keyset_scoped_without_losing_list_fields() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, is_active INTEGER,
                pharmacy_id TEXT, full_name TEXT, permissions TEXT);
            INSERT INTO users VALUES
              ('buyer-a','pharmacist',1,'a','Buyer A','{"can_view_purchases":true}'),
              ('buyer-b','admin',1,'b','Buyer B','{"can_view_purchases":true}'),
              ('owner-default','owner',1,NULL,'Owner Default','{}'),
              ('staff-default','pharmacist',1,'local_default','Legacy Staff','{"can_view_purchases":true}'),
              ('blocked-a','cashier',1,'a','Blocked A','{"can_access_pos":true,"can_view_purchases":false}'),
              ('no-purchases-b','pharmacist',1,'b','No Purchases','{"rep_can_view_sales":true}'),
              ('inactive-a','owner',0,'a','Inactive','{}');
            CREATE TABLE suppliers(id INTEGER PRIMARY KEY, name_ar TEXT, phone TEXT);
            INSERT INTO suppliers VALUES(7,'Supplier Shared','0100'),(8,'Supplier B','0200');
            CREATE TABLE purchase_invoices(
                id TEXT PRIMARY KEY,supplier_id INTEGER,pharmacy_id TEXT,user_id TEXT,
                created_at TEXT,status TEXT,invoice_number TEXT,total_amount REAL,notes TEXT
            );
            INSERT INTO purchase_invoices VALUES
              ('a-detail',7,'a','buyer-a','2026-10-20','completed','INV-A',17,'A notes'),
              ('a-null',7,'a','buyer-a',NULL,'draft','NULL-DATE',1,'null date'),
              ('a-foreign-user',7,'a','buyer-b','2026-10-19','completed','FOREIGN-USER',3,'linked across branches'),
              ('b-detail',8,'b','buyer-b','2027-01-01','completed','INV-B',999,'B notes'),
              ('default-invoice',7,NULL,'owner-default','2026-10-15','completed','INV-DEFAULT',5,'legacy default'),
              ('explicit-default',7,'local_default','staff-default','2026-10-16','completed','INV-EXPLICIT',6,'legacy explicit');
            CREATE TABLE master_drugs(id INTEGER PRIMARY KEY, trade_name TEXT);
            INSERT INTO master_drugs VALUES(1,'Drug One'),(2,'Drug Two');
            CREATE TABLE purchase_invoice_items(invoice_id TEXT,drug_id INTEGER);
            INSERT INTO purchase_invoice_items VALUES
              ('a-detail',1),('a-detail',2),('b-detail',2);
        "#).execute(&mut conn).await.unwrap();
        for idx in 0..205 {
            sqlx::query(
                "INSERT INTO purchase_invoices(id,supplier_id,pharmacy_id,user_id,created_at,status,invoice_number,total_amount)
                 VALUES (?,7,'a','buyer-a','2026-10-10','completed',?,10)",
            )
            .bind(format!("a-{idx:03}"))
            .bind(format!("INV-{idx:03}"))
            .execute(&mut conn)
            .await
            .unwrap();
        }

        let first = run_purchase_invoice_list_query(&mut conn, "buyer-a", None, 200)
            .await
            .unwrap();
        assert_eq!(first.len(), 200);
        assert_eq!(first[0]["id"], "a-detail");
        assert_eq!(first[0]["supplier_name"], "Supplier Shared");
        assert_eq!(first[0]["supplier_phone"], "0100");
        assert_eq!(first[0]["user_name"], "Buyer A");
        assert_eq!(first[0]["drug_names"], "Drug One Drug Two");
        assert_eq!(first[0]["invoice_number"], "INV-A");
        assert_eq!(first[0]["notes"], "A notes");
        assert_eq!(first[1]["id"], "a-foreign-user");
        assert!(first[1]["user_name"].is_null()); // Cross-branch staff details redacted

        let mut all = first.clone();
        let mut cursor = serde_json::to_string(&(
            first.last().unwrap()["created_at"].as_str(),
            first.last().unwrap()["id"].as_str().unwrap(),
        ))
        .unwrap();
        let second = run_purchase_invoice_list_query(&mut conn, "buyer-a", Some(&cursor), 200)
            .await
            .unwrap();
        assert_eq!(second.len(), 8);
        assert_eq!(second.last().unwrap()["id"], "a-null");
        all.extend(second.iter().cloned());
        cursor = serde_json::to_string(&(Option::<String>::None, "a-null")).unwrap();
        assert!(
            run_purchase_invoice_list_query(&mut conn, "buyer-a", Some(&cursor), 200)
                .await
                .unwrap()
                .is_empty()
        );
        let mut distinct = std::collections::HashSet::new();
        for row in &all {
            assert!(distinct.insert(row["id"].as_str().unwrap()));
            assert_ne!(row["id"], "b-detail");
            assert_ne!(row["id"], "default-invoice");
        }
        assert_eq!(all.len(), 208);

        let b = run_purchase_invoice_list_query(&mut conn, "buyer-b", None, 200)
            .await
            .unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0]["id"], "b-detail");
        assert_eq!(b[0]["supplier_name"], "Supplier B");
        assert_eq!(b[0]["user_name"], "Buyer B");
        assert_eq!(b[0]["drug_names"], "Drug Two");
        for legacy_actor in ["owner-default", "staff-default"] {
            assert!(
                run_purchase_invoice_list_query(&mut conn, legacy_actor, None, 200)
                    .await
                    .is_err(),
                "ambiguous legacy actor {legacy_actor} must not list invoices"
            );
        }
        for actor in ["blocked-a", "no-purchases-b", "inactive-a", "missing"] {
            assert!(
                run_purchase_invoice_list_query(&mut conn, actor, None, 200)
                    .await
                    .is_err(),
                "unexpected invoice access for {actor}"
            );
        }
        for cursor in ["not-json", r#"["2026-10-20",""]"#, r#"["2026-10-20",1]"#] {
            assert!(
                run_purchase_invoice_list_query(&mut conn, "buyer-a", Some(cursor), 200)
                    .await
                    .is_err(),
                "invalid cursor accepted: {cursor}"
            );
        }
        for limit in [0, 201] {
            assert!(
                run_purchase_invoice_list_query(&mut conn, "buyer-a", None, limit)
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn purchase_drafts_and_detail_enforce_two_tenants_permissions_and_null_semantics() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,is_active INTEGER,pharmacy_id TEXT,permissions TEXT);
            INSERT INTO users VALUES
              ('reader-a','cashier',1,'a','{"can_view_purchases":true}'),
              ('reader-b','pharmacist',1,'b','{"can_view_purchases":true}'),
              ('owner-default','owner',1,NULL,'{}'),
              ('staff-default','pharmacist',1,'local_default','{"can_view_purchases":true}'),
              ('blocked-a','cashier',1,'a','{"can_view_purchases":false}'),
              ('only-sales','cashier',1,'a','{"rep_can_view_sales":true}'),
              ('inactive-a','owner',0,'a','{}');
            CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name_ar TEXT);
            INSERT INTO suppliers VALUES(1,'Supplier A'),(2,'Supplier B');
            CREATE TABLE purchase_invoices(
                id TEXT PRIMARY KEY,supplier_id INTEGER,pharmacy_id TEXT,user_id TEXT,
                status TEXT,invoice_number TEXT,invoice_date TEXT,total_amount REAL,
                created_at TEXT,updated_at TEXT,notes TEXT
            );
            INSERT INTO purchase_invoices VALUES
              ('a-newest',1,'a','reader-a','draft','A-1','2026-10-10',17,
                '2026-10-20 10:00:00','2026-10-20 10:01:00','private A'),
              ('a-tie',1,'a','reader-a','draft','A-2',NULL,18,
                '2026-10-20 10:00:00',NULL,'A tie'),
              ('a-null',1,'a','reader-a','draft','A-NULL','2026-10-09',20,
                NULL,NULL,'null timestamp'),
              ('a-finished',1,'a','reader-a','completed','A-DONE',NULL,19,
                '2026-10-21 00:00:00',NULL,'not draft'),
              ('b-secret',2,'b','reader-b','draft','SECRET',NULL,999,
                '2027-01-01 00:00:00',NULL,'private B'),
              ('default-null',1,NULL,'owner-default','draft','LEGACY',NULL,11,
                '2026-10-21 00:00:00',NULL,'default only'),
              ('default-explicit',1,'local_default','staff-default','draft','LEGACY-EXPLICIT',NULL,12,
                '2026-10-22 00:00:00',NULL,'legacy explicit only'),
              ('a-missing-supplier',999,'a','reader-a','draft','ORPHAN',NULL,15,
                '2026-10-23 00:00:00',NULL,'excluded by supplier INNER join');
        "#).execute(&mut conn).await.unwrap();
        for idx in 0..205 {
            sqlx::query(
                "INSERT INTO purchase_invoices
                 (id,supplier_id,pharmacy_id,user_id,status,invoice_number,invoice_date,
                  total_amount,created_at)
                 VALUES (?,1,'a','reader-a','draft',?,NULL,3,'2026-10-15 10:00:00')",
            )
            .bind(format!("a-draft-{idx:03}"))
            .bind(format!("DRAFT-{idx:03}"))
            .execute(&mut conn)
            .await
            .unwrap();
        }

        let first = run_purchase_draft_list_query(&mut conn, "reader-a", None, 200)
            .await
            .unwrap();
        assert_eq!(first.len(), 200);
        assert_eq!(first[0]["id"], "a-tie"); // same timestamp; tie-break id
        assert_eq!(first[1]["id"], "a-newest");
        assert_eq!(first[0]["supplier_name"], "Supplier A");
        assert_eq!(first[0]["invoice_date"], Value::Null);
        assert_eq!(first[0]["total_amount"], 18.0);
        assert_eq!(first[0]["__cursor_created_at"], "2026-10-20 10:00:00");
        assert_eq!(first[0].as_object().unwrap().len(), 7); // six fields + keyset only
        let cursor = serde_json::to_string(&(
            first.last().unwrap()["__cursor_created_at"].as_str(),
            first.last().unwrap()["id"].as_str().unwrap(),
        ))
        .unwrap();
        let second = run_purchase_draft_list_query(&mut conn, "reader-a", Some(&cursor), 200)
            .await
            .unwrap();
        assert_eq!(second.len(), 8);
        assert_eq!(second.last().unwrap()["id"], "a-null");
        let mut seen = std::collections::HashSet::new();
        for row in first.iter().chain(second.iter()) {
            assert!(seen.insert(row["id"].as_str().unwrap()));
            assert_ne!(row["id"], "b-secret");
            assert_ne!(row["id"], "default-null");
            assert_ne!(row["id"], "a-finished");
            assert_ne!(row["id"], "a-missing-supplier");
        }
        assert_eq!(seen.len(), 208);
        let after_null = serde_json::to_string(&(Option::<String>::None, "a-null")).unwrap();
        assert!(
            run_purchase_draft_list_query(&mut conn, "reader-a", Some(&after_null), 200)
                .await
                .unwrap()
                .is_empty()
        );

        let b = run_purchase_draft_list_query(&mut conn, "reader-b", None, 200)
            .await
            .unwrap();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0]["id"], "b-secret");
        for legacy_actor in ["owner-default", "staff-default"] {
            assert!(
                run_purchase_draft_list_query(&mut conn, legacy_actor, None, 200)
                    .await
                    .is_err(),
                "ambiguous legacy actor {legacy_actor} must not list drafts"
            );
        }

        let detail = run_purchase_invoice_get_query(&mut conn, "reader-a", "a-newest")
            .await
            .unwrap();
        assert_eq!(detail.len(), 1);
        assert_eq!(detail[0]["notes"], "private A");
        assert_eq!(detail[0]["created_at"], "2026-10-20 10:00:00");
        assert_eq!(detail[0]["updated_at"], "2026-10-20 10:01:00");
        assert_eq!(detail[0]["status"], "draft");
        assert_eq!(detail[0].as_object().unwrap().len(), 11); // raw invoice.*, no join/meta fields
        for other in ["b-secret", "default-null", "missing", "a-newest' OR 1=1--"] {
            assert!(run_purchase_invoice_get_query(&mut conn, "reader-a", other)
                .await
                .unwrap()
                .is_empty());
        }
        assert_eq!(
            run_purchase_invoice_get_query(&mut conn, "reader-b", "b-secret")
                .await
                .unwrap()[0]["notes"],
            "private B"
        );
        for legacy_actor in ["owner-default", "staff-default"] {
            for legacy_invoice in ["default-null", "default-explicit"] {
                assert!(
                    run_purchase_invoice_get_query(&mut conn, legacy_actor, legacy_invoice)
                        .await
                        .is_err(),
                    "ambiguous legacy actor {legacy_actor} must not see {legacy_invoice}"
                );
            }
        }

        for actor in ["blocked-a", "only-sales", "inactive-a", "missing"] {
            assert!(
                run_purchase_draft_list_query(&mut conn, actor, None, 200)
                    .await
                    .is_err(),
                "drafts actor {actor}"
            );
            assert!(
                run_purchase_invoice_get_query(&mut conn, actor, "a-newest")
                    .await
                    .is_err(),
                "detail actor {actor}"
            );
        }
        for limit in [0, 201] {
            assert!(
                run_purchase_draft_list_query(&mut conn, "reader-a", None, limit)
                    .await
                    .is_err()
            );
        }
        for bad in ["not-json", r#"["2026-10-20",""]"#, r#"["2026-10-20",2]"#] {
            assert!(
                run_purchase_draft_list_query(&mut conn, "reader-a", Some(bad), 200)
                    .await
                    .is_err()
            );
        }
        for id in ["", "x\0y"] {
            assert!(run_purchase_invoice_get_query(&mut conn, "reader-a", id)
                .await
                .is_err());
        }
    }
}
