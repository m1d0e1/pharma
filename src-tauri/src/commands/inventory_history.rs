//! Native-scoped inventory audit and opening-balance views. Neither SQL nor
//! an actor/pharmacy ID is supplied by the renderer. Historical rows without
//! an explicit pharmacy are local-default only, never silently reassigned.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::{borrow::Cow, time::Duration};
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::{fetch_scoped_limited, reset_cancelled_read_state, ReadLimits};
use super::permission_policy::{user_can_view_purchases, user_has_permission};

// Native audit details contain references, not medicine names. A reference is
// usable only when a corresponding persisted source belongs to the actor's
// pharmacy. The unchanged audit text is never treated as a catalog identity.
fn movement_reference<'a>(details: &'a str, prefix: &str) -> Option<&'a str> {
    let reference = details.strip_prefix(prefix)?.split_whitespace().next()?;
    (reference.len() <= 256 && !reference.is_empty()).then_some(reference)
}

fn movement_document_id<'a>(details: &'a str, prefix: &str) -> Option<&'a str> {
    let (id, _) = details.strip_prefix(prefix)?.split_once(" value ")?;
    (!id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_whitespace)).then_some(id)
}

fn movement_field<'a>(details: &'a str, field: &str) -> Option<&'a str> {
    details
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix(field))
        .filter(|value| !value.is_empty() && value.len() <= 256)
}

async fn movement_names_from_rows(
    conn: &mut SqliteConnection,
    sql: &str,
    id: &str,
    pharmacy: &str,
) -> Result<Vec<String>, String> {
    // One invoice may have several drugs. Every line must resolve or the
    // result is unknown; displaying a partial set would misdescribe a sale.
    let rows = sqlx::query(sql)
        .bind(id)
        .bind(pharmacy)
        .fetch_all(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
    if rows.is_empty() || rows.len() > 200 {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for row in rows {
        let name: Option<String> = row.try_get("name").map_err(|error| error.to_string())?;
        let Some(name) = name.filter(|name| !name.trim().is_empty()) else {
            return Ok(Vec::new());
        };
        if !names.contains(&name) {
            names.push(name);
        }
    }
    Ok(names)
}

async fn movement_drug_names(
    conn: &mut SqliteConnection,
    action: &str,
    details: &str,
    actor: Option<&str>,
    pharmacy: &str,
) -> Result<Vec<String>, String> {
    const SALE_NAMES: &str = r#"
      SELECT COALESCE(NULLIF(TRIM(md.trade_name_en),''),NULLIF(TRIM(md.trade_name),'')) AS name
      FROM main.sales_invoices invoice
      JOIN main.sales_items item ON item.invoice_id=invoice.id
      LEFT JOIN main.master_drugs md ON md.id=item.drug_id
      WHERE invoice.id=? AND COALESCE(NULLIF(TRIM(invoice.pharmacy_id),''),'local_default')=?
      ORDER BY item.id LIMIT 201"#;
    const RETURN_NAMES: &str = r#"
      SELECT COALESCE(NULLIF(TRIM(md.trade_name_en),''),NULLIF(TRIM(md.trade_name),'')) AS name
      FROM main.returns ret
      JOIN main.return_items item ON item.return_id=ret.id
      LEFT JOIN main.master_drugs md ON md.id=item.drug_id
      WHERE ret.id=? AND COALESCE(NULLIF(TRIM(ret.pharmacy_id),''),'local_default')=?
      ORDER BY item.id LIMIT 201"#;
    const PURCHASE_NAMES: &str = r#"
      SELECT COALESCE(NULLIF(TRIM(md.trade_name_en),''),NULLIF(TRIM(md.trade_name),'')) AS name
      FROM main.purchase_invoices invoice
      JOIN main.purchase_invoice_items item ON item.invoice_id=invoice.id
      LEFT JOIN main.master_drugs md ON md.id=item.drug_id
      WHERE invoice.id=? AND COALESCE(NULLIF(TRIM(invoice.pharmacy_id),''),'local_default')=?
      ORDER BY item.id LIMIT 201"#;
    const PURCHASE_RETURN_NAMES: &str = r#"
      SELECT COALESCE(NULLIF(TRIM(md.trade_name_en),''),NULLIF(TRIM(md.trade_name),'')) AS name
      FROM main.purchase_returns ret
      JOIN main.native_purchase_return_provenance proof ON proof.return_id=ret.id
        AND proof.purchase_invoice_id=ret.purchase_invoice_id
        AND proof.actor_id=CAST(ret.user_id AS TEXT)
      JOIN main.purchase_invoices original ON original.id=proof.purchase_invoice_id
        AND original.pharmacy_id=proof.pharmacy_id
      JOIN main.purchase_return_items item ON item.purchase_return_id=ret.id
      LEFT JOIN main.master_drugs md ON md.id=item.drug_id
      WHERE ret.id=? AND proof.pharmacy_id=?
      ORDER BY item.id LIMIT 201"#;
    const LOT_NAMES: &str = r#"
      SELECT COALESCE(NULLIF(TRIM(md.trade_name_en),''),NULLIF(TRIM(md.trade_name),'')) AS name
      FROM main.inventory lot
      JOIN main.master_drugs md ON md.id=lot.drug_id
      WHERE lot.id=? AND COALESCE(NULLIF(TRIM(lot.pharmacy_id),''),'local_default')=?"#;

    let names = match action {
        "COMPLETE_SALE" | "SALE" => {
            if let Some(id) = movement_document_id(details, "Sale ") {
                movement_names_from_rows(conn, SALE_NAMES, id, pharmacy).await?
            } else {
                Vec::new()
            }
        }
        "CREATE_RETURN" | "RETURN" => {
            if let Some(id) = movement_document_id(details, "Return ") {
                movement_names_from_rows(conn, RETURN_NAMES, id, pharmacy).await?
            } else {
                Vec::new()
            }
        }
        "COMPLETE_PURCHASE" | "PURCHASE" => {
            if let Some(id) = movement_document_id(details, "Purchase ") {
                movement_names_from_rows(conn, PURCHASE_NAMES, id, pharmacy).await?
            } else {
                Vec::new()
            }
        }
        "PURCHASE_RETURN" => {
            if let Some(id) = details
                .strip_prefix("Purchase return ")
                .and_then(|tail| tail.split_once(" for supplier ").map(|(id, _)| id))
                .filter(|id| !id.is_empty() && id.len() <= 256 && !id.chars().any(char::is_whitespace))
            {
                movement_names_from_rows(conn, PURCHASE_RETURN_NAMES, id, pharmacy).await?
            } else {
                Vec::new()
            }
        }
        "ADD_INVENTORY" if details.starts_with("native-inventory-create-request=") => {
            let request = movement_field(details, "native-inventory-create-request=");
            let lot = movement_field(details, "lot_id=");
            let drug = movement_field(details, "drug_id=").and_then(|id| id.parse::<i64>().ok());
            if let (Some(request), Some(lot), Some(drug), Some(actor)) = (request, lot, drug, actor) {
                // The immutable request receipt retains the original catalog ID
                // after an unused, empty lot has legitimately been deleted.
                let row = sqlx::query(r#"
                    SELECT COALESCE(NULLIF(TRIM(md.trade_name_en),''),NULLIF(TRIM(md.trade_name),'')) AS name
                    FROM main.inventory_lot_create_requests receipt
                    JOIN main.master_drugs md ON md.id=receipt.drug_id
                    WHERE receipt.request_id=? AND receipt.inventory_id=? AND receipt.drug_id=?
                      AND receipt.created_by=? AND receipt.pharmacy_id=?"#)
                    .bind(request).bind(lot).bind(drug).bind(actor).bind(pharmacy)
                    .fetch_optional(&mut *conn).await.map_err(|error| error.to_string())?;
                row.and_then(|row| row.try_get::<Option<String>, _>("name").ok().flatten())
                    .into_iter().collect()
            } else {
                Vec::new()
            }
        }
        "ADD_INVENTORY" if details.starts_with("native-inventory-batch-request=") => {
            let request = movement_field(details, "native-inventory-batch-request=");
            let count = movement_field(details, "lot_count=").and_then(|v| v.parse::<usize>().ok());
            if let (Some(request), Some(count), Some(actor)) = (request, count, actor) {
                let rows = sqlx::query(r#"
                    SELECT COALESCE(NULLIF(TRIM(md.trade_name_en),''),NULLIF(TRIM(md.trade_name),'')) AS name,
                           receipt.inventory_count AS expected_count
                    FROM main.inventory_lot_import_receipts receipt
                    JOIN json_each(receipt.inventory_ids_json) ref
                    LEFT JOIN main.inventory lot ON lot.id=ref.value
                      AND COALESCE(NULLIF(TRIM(lot.pharmacy_id),''),'local_default')=receipt.pharmacy_id
                    LEFT JOIN main.master_drugs md ON md.id=lot.drug_id
                    WHERE receipt.request_id=? AND receipt.created_by=? AND receipt.pharmacy_id=?
                    ORDER BY CAST(ref.key AS INTEGER) LIMIT 201"#)
                    .bind(request).bind(actor).bind(pharmacy)
                    .fetch_all(&mut *conn).await.map_err(|error| error.to_string())?;
                if count == 0 || count > 200 || rows.len() != count
                    || rows.iter().any(|row| row.try_get::<i64, _>("expected_count").ok() != Some(count as i64))
                {
                    Vec::new()
                } else {
                    let mut names = Vec::new();
                    for row in rows {
                        let name = row.try_get::<Option<String>, _>("name").map_err(|error| error.to_string())?;
                        let Some(name) = name.filter(|s| !s.trim().is_empty()) else {
                            return Ok(Vec::new());
                        };
                        if !names.contains(&name) {
                            names.push(name);
                        }
                    }
                    names
                }
            } else {
                Vec::new()
            }
        }
        "STOCK_ADJUSTMENT" | "UPDATE_INVENTORY" => {
            let lot = movement_reference(details, "Updated tenant lot ");
            let drug = details.split_whitespace().find_map(|part| part.strip_prefix("drug="))
                .and_then(|id| id.parse::<i64>().ok());
            if let (Some(lot), Some(drug)) = (lot, drug) {
                let row = sqlx::query(r#"
                    SELECT COALESCE(NULLIF(TRIM(md.trade_name_en),''),NULLIF(TRIM(md.trade_name),'')) AS name
                    FROM main.inventory lot JOIN main.master_drugs md ON md.id=lot.drug_id
                    WHERE lot.id=? AND lot.drug_id=?
                      AND COALESCE(NULLIF(TRIM(lot.pharmacy_id),''),'local_default')=?"#)
                    .bind(lot).bind(drug).bind(pharmacy)
                    .fetch_optional(&mut *conn).await.map_err(|error| error.to_string())?;
                row.and_then(|row| row.try_get::<Option<String>, _>("name").ok().flatten())
                    .into_iter().collect()
            } else {
                Vec::new()
            }
        }
        "ZERO_INVENTORY" => {
            if let Some(lot) = movement_reference(details, "Zeroed tenant inventory lot ") {
                movement_names_from_rows(conn, LOT_NAMES, lot, pharmacy).await?
            } else {
                Vec::new()
            }
        }
        "DELETE_INVENTORY" => {
            if let Some(lot) = movement_reference(details, "Deleted unused zero-quantity inventory lot ") {
                let rows = sqlx::query(r#"
                    SELECT COALESCE(NULLIF(TRIM(md.trade_name_en),''),NULLIF(TRIM(md.trade_name),'')) AS name
                    FROM main.inventory_lot_create_requests receipt
                    JOIN main.master_drugs md ON md.id=receipt.drug_id
                    WHERE receipt.inventory_id=? AND receipt.pharmacy_id=? LIMIT 2"#)
                    .bind(lot).bind(pharmacy)
                    .fetch_all(&mut *conn).await.map_err(|error| error.to_string())?;
                if rows.len() == 1 {
                    rows[0].try_get::<Option<String>, _>("name").ok().flatten()
                        .into_iter().collect()
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        }
        "OPENING_BALANCE" => {
            let batch = details.rsplit_once(" (").and_then(|(_, batch)| batch.strip_suffix(')'))
                .filter(|batch| batch.starts_with("OPEN-") && batch.len() <= 256);
            if let Some(batch) = batch {
                let rows = sqlx::query(r#"
                    SELECT COALESCE(NULLIF(TRIM(md.trade_name_en),''),NULLIF(TRIM(md.trade_name),'')) AS name
                    FROM main.inventory lot
                    JOIN main.master_drugs md ON md.id=lot.drug_id
                    WHERE lot.batch_number=?
                      AND COALESCE(NULLIF(TRIM(lot.pharmacy_id),''),'local_default')=? LIMIT 2"#)
                    .bind(batch).bind(pharmacy)
                    .fetch_all(&mut *conn).await.map_err(|error| error.to_string())?;
                if rows.len() == 1 {
                    rows[0].try_get::<Option<String>, _>("name").ok().flatten()
                        .into_iter().collect()
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    };
    Ok(names)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryHistoryPage {
    actor_id: String,
    pharmacy_id: String,
    rows: Vec<Value>,
}

async fn scoped_inventory_history(
    conn: &mut SqliteConnection,
    actor_id: &str,
    query_id: &str,
    limit: u32,
    offset: u32,
) -> Result<InventoryHistoryPage, String> {
    if limit == 0 || limit > 200 || offset > 50_000 {
        return Err("Inventory history requires bounded pages of 1-200 records".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let permissions: Option<String> = sqlx::query(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?
    .try_get("permissions")
    .map_err(|error| error.to_string())?;
    let (permission, sql) = match query_id {
        "inventory.movements" => (
            "preview_item_movements",
            r#"WITH native_scope(tenant) AS (VALUES(?))
               SELECT al.id,CASE WHEN u.id IS NULL THEN NULL ELSE al.user_id END AS user_id,
               al.action,al.details,al.created_at,al.pharmacy_id,
               COALESCE(u.full_name,u.username,'غير محدد') AS user_name,
               u.username
               FROM main.activity_log al
               CROSS JOIN native_scope scope
               LEFT JOIN main.users u ON CAST(u.id AS TEXT)=CAST(al.user_id AS TEXT)
                 AND COALESCE(NULLIF(TRIM(u.pharmacy_id),''),'local_default')=scope.tenant
               WHERE al.action IN (
                 'ADD_INVENTORY','UPDATE_INVENTORY','DELETE_INVENTORY','ADJUST_STOCK',
                 'STOCK_ADJUSTMENT','ZERO_INVENTORY','OPENING_BALANCE','SALE',
                 'COMPLETE_SALE','RETURN','CREATE_RETURN','PURCHASE',
                 'COMPLETE_PURCHASE','PURCHASE_RETURN'
               )
                 AND (
                   NULLIF(TRIM(al.pharmacy_id),'')=scope.tenant
                   OR (
                     -- Older native sale, purchase and sales-return writers
                     -- omitted the audit tenant. Recover those three kinds
                     -- ONLY with an exact persisted document ID, its original
                     -- tenant and the matching recorded author. Unknown or
                     -- conflicting provenance remains invisible to every
                     -- tenant, including local_default.
                     NULLIF(TRIM(al.pharmacy_id),'') IS NULL
                     AND (
                       (al.action IN ('SALE','COMPLETE_SALE')
                        AND SUBSTR(al.details,1,5)='Sale '
                        AND INSTR(al.details,' value ')>6
                        AND EXISTS (
                          SELECT 1 FROM main.sales_invoices source
                          WHERE CAST(source.id AS TEXT)=SUBSTR(al.details,6,INSTR(al.details,' value ')-6)
                            AND NULLIF(TRIM(source.pharmacy_id),'')=scope.tenant
                            AND CAST(source.user_id AS TEXT)=CAST(al.user_id AS TEXT)))
                       OR (al.action IN ('PURCHASE','COMPLETE_PURCHASE')
                        AND SUBSTR(al.details,1,9)='Purchase '
                        AND INSTR(al.details,' value ')>10
                        AND EXISTS (
                          SELECT 1 FROM main.purchase_invoices source
                          WHERE CAST(source.id AS TEXT)=SUBSTR(al.details,10,INSTR(al.details,' value ')-10)
                            AND NULLIF(TRIM(source.pharmacy_id),'')=scope.tenant
                            AND CAST(source.user_id AS TEXT)=CAST(al.user_id AS TEXT)))
                       OR (al.action IN ('RETURN','CREATE_RETURN')
                        AND SUBSTR(al.details,1,7)='Return '
                        AND INSTR(al.details,' value ')>8
                        AND EXISTS (
                          SELECT 1 FROM main.returns source
                          WHERE CAST(source.id AS TEXT)=SUBSTR(al.details,8,INSTR(al.details,' value ')-8)
                            AND NULLIF(TRIM(source.pharmacy_id),'')=scope.tenant
                            AND CAST(source.user_id AS TEXT)=CAST(al.user_id AS TEXT)))
                     )
                   )
                 )
               ORDER BY al.created_at DESC,al.id DESC LIMIT ? OFFSET ?"#,
        ),
        "inventory.opening_balances" => (
            "can_view_opening_balances",
            r#"SELECT i.*,md.trade_name,md.trade_name_en
               FROM main.inventory i
               INNER JOIN main.master_drugs md ON md.id=i.drug_id
               WHERE i.batch_number LIKE 'OPEN-%'
                 AND COALESCE(NULLIF(TRIM(i.pharmacy_id),''),'local_default')=?
               ORDER BY i.created_at DESC,i.id DESC LIMIT ? OFFSET ?"#,
        ),
        _ => return Err("Unknown native inventory history query".into()),
    };
    if !user_has_permission(Some(&role), permissions.as_deref(), permission, false) {
        return Err("Authenticated role cannot view this inventory history".into());
    }
    let mut params = vec![json!(pharmacy_id)];
    params.extend([json!(limit), json!(offset)]);
    let mut rows = fetch_scoped_limited(
        conn,
        sql,
        params,
        ReadLimits {
            max_duration: Duration::from_secs(4),
            max_rows: 200,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await?;
    if query_id == "inventory.movements" {
        tokio::time::timeout(Duration::from_secs(4), async {
            // Keep enriched labels within an additional bounded IPC budget.
            let mut label_bytes = 0usize;
            for row in &mut rows {
                let action = row["action"].as_str().unwrap_or("");
                let purchase_audit = matches!(action, "PURCHASE" | "COMPLETE_PURCHASE" | "PURCHASE_RETURN");
                let details = row["details"].as_str().unwrap_or("");
                let author = row["user_id"].as_str();
                let mut names = movement_drug_names(conn, action, details, author, &pharmacy_id).await?;
                let row_bytes = names.iter().fold(0usize, |total, name| total.saturating_add(name.len()));
                if row_bytes > 4096 || label_bytes.saturating_add(row_bytes) > 256 * 1024 {
                    names.clear();
                } else {
                    label_bytes += row_bytes;
                }
                row["drug_names"] = json!(names);
                // Purchase receipt amounts are cost-sensitive. Resolve the
                // medicine name from the private source reference first, then
                // remove the raw monetary audit text from the IPC response.
                if !user_can_view_purchases(Some(&role), permissions.as_deref())
                    && purchase_audit
                {
                    row["details"] = json!("تفاصيل عملية شراء محجوبة");
                }
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| "Inventory medicine-name lookup timed out")??;
    }
    Ok(InventoryHistoryPage {
        actor_id: actor_id.to_owned(),
        pharmacy_id,
        rows,
    })
}

#[derive(Debug, Deserialize)]
pub struct OpeningBalanceInput {
    drug_id: i64,
    quantity: f64,
    cost_price: f64,
    unit_price: f64,
    expiry_date: Option<String>,
}

fn opening_business_date_valid(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit())
    {
        return false;
    }
    let year = date[0..4].parse::<u32>().unwrap_or(0);
    let month = date[5..7].parse::<u32>().unwrap_or(0);
    let day = date[8..10].parse::<u32>().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    year > 0 && day > 0 && day <= max_day
}

/// Exact effective-reorder comparison used by resolveRecoveredShortages:
/// sellable local stock > max(reorder_point/min_limit/10, last-30-days sales
/// expressed as large units). All fields and predicates are fixed native SQL.
pub(crate) async fn resolve_opening_shortages(
    tx: &mut Transaction<'_, Sqlite>,
    drug_id: i64,
    pharmacy_id: &str,
) -> Result<(), String> {
    sqlx::query(
        r#"
        UPDATE main.shortages
        SET status='received'
        WHERE drug_id=?
          AND (pharmacy_id=? OR (pharmacy_id IS NULL AND ?='local_default'))
          AND (status IN ('pending','ordered') OR status IS NULL OR status='')
          AND COALESCE((
            SELECT SUM(i.quantity)
            FROM main.inventory i
            JOIN main.master_drugs stock_md ON stock_md.id=i.drug_id
            WHERE i.drug_id=shortages.drug_id
              AND (i.pharmacy_id=? OR (i.pharmacy_id IS NULL AND ?='local_default'))
              AND i.quantity>0
              AND (COALESCE(stock_md.has_expiry,1)=0 OR i.expiry_date IS NOT NULL)
              AND (i.expiry_date IS NULL OR i.expiry_date>=DATE('now','localtime'))
          ),0) > COALESCE((
            SELECT MAX(
              COALESCE(NULLIF(md.reorder_point,0),NULLIF(md.min_limit,0),10),
              COALESCE((
                SELECT SUM(
                  CASE
                    WHEN LOWER(TRIM(COALESCE(si.unit,''))) IN ('medium','strip','شريط')
                      OR si.unit=sales_drug.medium_unit
                    THEN si.quantity_sold /
                      COALESCE(NULLIF(si.large_to_medium,0),NULLIF(sales_drug.large_to_medium,0),1)
                    WHEN LOWER(TRIM(COALESCE(si.unit,''))) IN
                      ('small','unit','pill','tablet','capsule','قرص','كبسولة')
                      OR si.unit=sales_drug.small_unit
                    THEN si.quantity_sold / (
                      COALESCE(NULLIF(si.large_to_medium,0),NULLIF(sales_drug.large_to_medium,0),1)
                      * COALESCE(NULLIF(si.medium_to_small,0),NULLIF(sales_drug.medium_to_small,0),1)
                    )
                    ELSE si.quantity_sold
                  END
                )
                FROM main.sales_items si
                JOIN main.sales_invoices inv ON inv.id=si.invoice_id
                JOIN main.master_drugs sales_drug ON sales_drug.id=si.drug_id
                WHERE si.drug_id=md.id
                  AND si.is_negative=0
                  AND (inv.status IS NULL OR inv.status='' OR
                    inv.status IN ('completed','approved','delivered'))
                  AND (inv.pharmacy_id=? OR (inv.pharmacy_id IS NULL AND ?='local_default'))
                  AND inv.created_at>=DATETIME('now','-30 days')
              ),0)
            )
            FROM main.master_drugs md
            WHERE md.id=shortages.drug_id
          ),0)
        "#,
    )
    .bind(drug_id)
    .bind(pharmacy_id)
    .bind(pharmacy_id)
    .bind(pharmacy_id)
    .bind(pharmacy_id)
    .bind(pharmacy_id)
    .bind(pharmacy_id)
    .execute(&mut **tx)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Opening-stock, double-entry journal, activity log and shortage recovery
/// are committed together. This function takes a native-authenticated actor,
/// not renderer-supplied user or pharmacy IDs.
async fn create_opening_balance(
    conn: &mut SqliteConnection,
    actor_id: &str,
    input: OpeningBalanceInput,
) -> Result<(), String> {
    let invalid = "بيانات الرصيد الافتتاحي غير صالحة";
    if input.drug_id <= 0
        || !input.quantity.is_finite()
        || input.quantity <= 0.0
        || !input.cost_price.is_finite()
        || input.cost_price < 0.0
        || !input.unit_price.is_finite()
        || input.unit_price < 0.0
        || !(input.quantity * input.cost_price).is_finite()
    {
        return Err(invalid.into());
    }
    let expiry = input
        .expiry_date
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if expiry.is_some_and(|date| !opening_business_date_valid(date)) {
        return Err(invalid.into());
    }
    // Acquire SQLite's writer reservation before reading authorization or
    // stock: the actor cannot be disabled during a concurrent authorization
    // race, nor can a failed journal leave an orphaned stock row.
    let mut tx = Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
        .await
        .map_err(|error| error.to_string())?;
    let work: Result<(), String> = async {
        let (role, pharmacy_id) = active_generic_actor(&mut tx, actor_id).await?;
        let row = sqlx::query(
            "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
        )
        .bind(actor_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
        let permissions: Option<String> =
            row.try_get("permissions").map_err(|error| error.to_string())?;
        if !user_has_permission(
            Some(&role),
            permissions.as_deref(),
            "can_view_opening_balances",
            false,
        ) && !user_has_permission(
            Some(&role),
            permissions.as_deref(),
            "can_manage_inventory",
            false,
        ) {
            return Err("Unauthorized".into());
        }
        let drug = sqlx::query(
            "SELECT COALESCE(NULLIF(large_to_medium,0),1) AS large_to_medium,
             COALESCE(NULLIF(medium_to_small,0),1) AS medium_to_small,
             COALESCE(has_expiry,1) AS has_expiry,
             COALESCE(trade_name_en,trade_name,active_ingredient) AS trade_name
             FROM main.master_drugs WHERE id=?",
        )
        .bind(input.drug_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| error.to_string())?
        .ok_or("الصنف غير موجود")?;
        let requires_expiry = drug
            .try_get::<i64, _>("has_expiry")
            .map_err(|error| error.to_string())?
            != 0;
        if requires_expiry && expiry.is_none() {
            return Err(invalid.into());
        }
        let strips_per_box: i64 = drug
            .try_get("large_to_medium")
            .map_err(|error| error.to_string())?;
        let medium_to_small: i64 = drug
            .try_get("medium_to_small")
            .map_err(|error| error.to_string())?;
        let drug_name: Option<String> = drug
            .try_get("trade_name")
            .map_err(|error| error.to_string())?;
        let label = drug_name
            .filter(|label| !label.is_empty())
            .unwrap_or_else(|| format!("صنف #{}", input.drug_id));
        let batch_number = format!("OPEN-{}", &Uuid::new_v4().to_string()[..8]);
        sqlx::query(
            "INSERT INTO main.inventory
             (id,pharmacy_id,drug_id,batch_number,expiry_date,quantity,local_selling_price,
              cost_price,strips_per_box,medium_to_small)
             VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&pharmacy_id)
        .bind(input.drug_id)
        .bind(&batch_number)
        .bind(expiry)
        .bind(input.quantity)
        .bind(input.unit_price)
        .bind(input.cost_price)
        .bind(strips_per_box)
        .bind(medium_to_small)
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
        let amount = input.quantity * input.cost_price;
        if amount > 0.000001 {
            let inventory_account = sqlx::query_scalar::<_, Option<i64>>(
                "SELECT account_id FROM main.trial_balance_settings
                 WHERE category='inventory_asset' LIMIT 1",
            )
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| error.to_string())?
            .flatten()
            .filter(|id| *id != 0)
            .unwrap_or(10);
            let equity_account = sqlx::query_scalar::<_, Option<i64>>(
                "SELECT account_id FROM main.trial_balance_settings
                 WHERE category='opening_balance_equity' LIMIT 1",
            )
            .fetch_optional(&mut *tx)
            .await
            .map_err(|error| error.to_string())?
            .flatten()
            .filter(|id| *id != 0)
            .unwrap_or(21);
            let journal_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO main.daily_journals (id,date,description,created_by,total_amount,pharmacy_id)
                 VALUES (?,DATE('now','localtime'),?,?,?,?)",
            )
            .bind(&journal_id)
            .bind(format!("رصيد افتتاحي للمخزون: {label} ({batch_number})"))
            .bind(actor_id)
            .bind(amount)
            .bind(&pharmacy_id)
            .execute(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
            for (account, entry_type) in
                [(inventory_account, "debit"), (equity_account, "credit")]
            {
                sqlx::query(
                    "INSERT INTO main.journal_entries (journal_id,account_id,type,amount)
                     VALUES (?,?,?,?)",
                )
                .bind(&journal_id)
                .bind(account)
                .bind(entry_type)
                .bind(amount)
                .execute(&mut *tx)
                .await
                .map_err(|error| error.to_string())?;
            }
        }
        sqlx::query(
            "INSERT INTO main.activity_log (user_id,action,details,pharmacy_id)
             VALUES (?,'OPENING_BALANCE',?,?)",
        )
        .bind(actor_id)
        .bind(format!(
            "رصيد افتتاحي {} من {label} ({batch_number})",
            input.quantity
        ))
        .bind(&pharmacy_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
        resolve_opening_shortages(&mut tx, input.drug_id, &pharmacy_id).await?;
        Ok(())
    }
    .await;
    match work {
        Ok(()) => tx.commit().await.map_err(|error| error.to_string()),
        Err(error) => {
            tx.rollback()
                .await
                .map_err(|rollback| format!("{error}; rollback: {rollback}"))?;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn add_opening_balance_critical(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: OpeningBalanceInput,
) -> Result<(), String> {
    let actor_guard = session.authorize_session().await?;
    let actor = actor_guard
        .as_deref()
        .ok_or("Authenticated actor required")?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|error| error.to_string())?;
    create_opening_balance(&mut conn, actor, payload).await
}

#[tauri::command]
pub async fn db_read_inventory_history(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    query_id: String,
    limit: u32,
    offset: u32,
) -> Result<InventoryHistoryPage, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|error| error.to_string())?;
    scoped_inventory_history(
        &mut conn,
        actor.as_deref().unwrap(),
        &query_id,
        limit,
        offset,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    fn opening_input(
        drug_id: i64,
        quantity: f64,
        cost_price: f64,
        expiry_date: Option<&str>,
    ) -> OpeningBalanceInput {
        OpeningBalanceInput {
            drug_id,
            quantity,
            cost_price,
            unit_price: 17.0,
            expiry_date: expiry_date.map(str::to_owned),
        }
    }

    async fn opening_fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            PRAGMA foreign_keys=ON;
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
            INSERT INTO users VALUES
              ('reader-a','cashier','{"can_view_opening_balances":true}','a',1),
              ('manager-a','pharmacist','{"can_manage_inventory":true}','a',1),
              ('blocked-a','cashier','{"can_view_opening_balances":false,"can_manage_inventory":false}','a',1),
              ('inactive-a','owner','{}','a',0),
              ('owner-b','owner','{}','b',1),
              ('owner-default','owner','{}',NULL,1);
            ALTER TABLE users ADD COLUMN username TEXT;
            UPDATE users SET username=id;
            CREATE TABLE master_drugs(
              id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,active_ingredient TEXT,
              large_to_medium INTEGER,medium_to_small INTEGER,has_expiry INTEGER,
              reorder_point REAL,min_limit REAL,medium_unit TEXT,small_unit TEXT
            );
            INSERT INTO master_drugs VALUES
              (1,'Arabic A','Drug A','Active A',10,2,1,3,2,'strip','tablet'),
              (2,'Arabic B',NULL,'Active B',1,1,0,1,1,'bottle',NULL);
            CREATE TABLE inventory(
              id TEXT PRIMARY KEY,pharmacy_id TEXT,drug_id INTEGER,batch_number TEXT,
              expiry_date TEXT,quantity REAL,local_selling_price REAL,cost_price REAL,
              strips_per_box INTEGER,medium_to_small INTEGER
            );
            INSERT INTO inventory VALUES
              ('a-existing','a',1,'LOT-A','2099-12-31',2,10,5,10,2),
              ('a-expired','a',1,'LOT-OLD','2020-01-01',99,10,5,10,2),
              ('b-existing','b',1,'LOT-B','2099-12-31',2,20,8,10,2),
              ('default-existing',NULL,2,'LOT-DEFAULT',NULL,1,1,5,1,1);
            CREATE TABLE activity_log(
              id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,
              pharmacy_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE accounts(id INTEGER PRIMARY KEY);
            INSERT INTO accounts VALUES(10),(21),(30),(40);
            CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
            INSERT INTO trial_balance_settings VALUES
              ('inventory_asset',30),('opening_balance_equity',40);
            CREATE TABLE daily_journals(
              id TEXT PRIMARY KEY,date TEXT,description TEXT,created_by TEXT,total_amount REAL,
              pharmacy_id TEXT
            );
            -- Capture what the opening-balance writer supplied before schema
            -- compatibility fills an omitted scope from mutable user records.
            CREATE TABLE journal_insert_scope_fidelity(journal_id TEXT,supplied_pharmacy TEXT);
            CREATE TRIGGER capture_journal_insert_scope BEFORE INSERT ON daily_journals
            BEGIN
              INSERT INTO journal_insert_scope_fidelity VALUES(NEW.id,NEW.pharmacy_id);
            END;
            CREATE TRIGGER daily_journals_snapshot_pharmacy_insert AFTER INSERT ON daily_journals
            WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id)=''
            BEGIN
              UPDATE daily_journals SET pharmacy_id=COALESCE(
                (SELECT NULLIF(TRIM(u.pharmacy_id),'') FROM users u
                 WHERE CAST(u.id AS TEXT)=CAST(NEW.created_by AS TEXT)
                    OR LOWER(u.username)=LOWER(CAST(NEW.created_by AS TEXT)) LIMIT 1),
                'local_default'
              ) WHERE id=NEW.id;
            END;
            CREATE TABLE journal_entries(
              journal_id TEXT,account_id INTEGER,type TEXT,amount REAL,
              FOREIGN KEY(journal_id) REFERENCES daily_journals(id)
            );
            CREATE TABLE shortages(
              id INTEGER PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,status TEXT
            );
            INSERT INTO shortages VALUES
              (1,1,'a','pending'),(2,1,'a','ordered'),
              (3,1,'b','pending'),(4,1,NULL,'pending'),(5,2,NULL,'pending');
            CREATE TABLE sales_invoices(
              id TEXT PRIMARY KEY,pharmacy_id TEXT,status TEXT,created_at TEXT
            );
            CREATE TABLE sales_items(
              id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER,is_negative INTEGER,
              quantity_sold REAL,unit TEXT,large_to_medium REAL,medium_to_small REAL
            );
            INSERT INTO sales_invoices VALUES
              ('sale-a','a','completed',datetime('now')),
              ('sale-b','b','completed',datetime('now')),
              ('sale-draft','a','draft',datetime('now'));
            INSERT INTO sales_items VALUES
              (1,'sale-a',1,0,20,'strip',10,2),
              (2,'sale-b',1,0,500,'large',10,2),
              (3,'sale-draft',1,0,900,'large',10,2);
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    #[tokio::test]
    async fn opening_balance_is_transactional_and_tenant_bound_with_exact_shortage_thresholds() {
        let mut conn = opening_fixture().await;
        create_opening_balance(
            &mut conn,
            "reader-a",
            opening_input(1, 4.0, 10.0, Some("2099-12-31")),
        )
        .await
        .unwrap();
        let opening = sqlx::query(
            "SELECT * FROM inventory WHERE batch_number LIKE 'OPEN-%' AND pharmacy_id='a'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(opening.try_get::<f64, _>("quantity").unwrap(), 4.0);
        assert_eq!(opening.try_get::<f64, _>("cost_price").unwrap(), 10.0);
        assert_eq!(
            opening.try_get::<f64, _>("local_selling_price").unwrap(),
            17.0
        );
        assert_eq!(opening.try_get::<i64, _>("strips_per_box").unwrap(), 10);
        assert_eq!(opening.try_get::<i64, _>("medium_to_small").unwrap(), 2);
        let batch: String = opening.try_get("batch_number").unwrap();
        assert!(batch.starts_with("OPEN-"));
        let journal =
            sqlx::query("SELECT date,description,created_by,total_amount FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let description: String = journal.try_get("description").unwrap();
        assert!(description.contains("Drug A"));
        assert!(description.contains(&batch));
        assert_eq!(
            journal.try_get::<String, _>("created_by").unwrap(),
            "reader-a"
        );
        assert_eq!(journal.try_get::<f64, _>("total_amount").unwrap(), 40.0);
        let entries =
            sqlx::query("SELECT account_id,type,amount FROM journal_entries ORDER BY rowid")
                .fetch_all(&mut conn)
                .await
                .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].try_get::<i64, _>("account_id").unwrap(), 30);
        assert_eq!(entries[0].try_get::<String, _>("type").unwrap(), "debit");
        assert_eq!(entries[1].try_get::<i64, _>("account_id").unwrap(), 40);
        assert_eq!(entries[1].try_get::<String, _>("type").unwrap(), "credit");
        let activity = sqlx::query("SELECT * FROM activity_log WHERE action='OPENING_BALANCE'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            activity.try_get::<String, _>("user_id").unwrap(),
            "reader-a"
        );
        assert_eq!(activity.try_get::<String, _>("pharmacy_id").unwrap(), "a");
        let details: String = activity.try_get("details").unwrap();
        assert!(details.contains(&batch));
        assert!(details.contains("Drug A"));
        let shortages = sqlx::query("SELECT id,status FROM shortages ORDER BY id")
            .fetch_all(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            shortages
                .iter()
                .map(|row| row.try_get::<String, _>("status").unwrap())
                .collect::<Vec<_>>(),
            ["received", "received", "pending", "pending", "pending"]
        );

        // Manager has only can_manage_inventory, and must use pharmacy A.
        create_opening_balance(
            &mut conn,
            "manager-a",
            opening_input(1, 1.0, 0.0, Some("2099-12-31")),
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            1
        );
        // Owner B may open stock in B but cannot recover an unrelated A
        // shortage, nor their own if recent B sales imply threshold 500.
        create_opening_balance(
            &mut conn,
            "owner-b",
            opening_input(1, 4.0, 2.0, Some("2099-12-31")),
        )
        .await
        .unwrap();
        let b_status: String = sqlx::query_scalar("SELECT status FROM shortages WHERE id=3")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(b_status, "pending");
        // A finance projection grants visibility by the persisted journal
        // tenant, never by the current or historical actor's branch.
        let journal_pharmacies: Vec<Option<String>> = sqlx::query_scalar(
            "SELECT pharmacy_id FROM daily_journals ORDER BY rowid",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(journal_pharmacies, [Some("a".into()), Some("b".into())]);
        let supplied_pharmacies: Vec<Option<String>> = sqlx::query_scalar(
            "SELECT supplied_pharmacy FROM journal_insert_scope_fidelity ORDER BY rowid",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(supplied_pharmacies, journal_pharmacies,
            "native stock journals must bind their pharmacy directly, without fallback actor lookup");
        for (tenant, expected) in [("a", 1), ("b", 1), ("local_default", 0)] {
            let visible: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM daily_journals
                 WHERE (pharmacy_id=? OR (pharmacy_id IS NULL AND ?='local_default'))",
            )
            .bind(tenant)
            .bind(tenant)
            .fetch_one(&mut conn)
            .await
            .unwrap();
            assert_eq!(visible, expected, "finance scope leaked an opening journal to {tenant}");
        }
        // Non-expiring drugs accept NULL expiry and local_default includes
        // explicit NULL historical inventory/shortage rows.
        create_opening_balance(&mut conn, "owner-default", opening_input(2, 2.0, 0.0, None))
            .await
            .unwrap();
        let default_opening: Option<String> = sqlx::query_scalar(
            "SELECT expiry_date FROM inventory WHERE pharmacy_id='local_default' AND batch_number LIKE 'OPEN-%'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(default_opening, None);
        let default_status: String = sqlx::query_scalar("SELECT status FROM shortages WHERE id=5")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(default_status, "received"); // 3 > configured reorder_point of 1
    }

    #[tokio::test]
    async fn opening_balance_denials_invalid_inputs_and_native_atomic_rollbacks() {
        let mut conn = opening_fixture().await;
        for actor in ["blocked-a", "inactive-a", "missing"] {
            assert!(create_opening_balance(
                &mut conn,
                actor,
                opening_input(1, 20.0, 10.0, Some("2099-12-31"))
            )
            .await
            .is_err());
        }
        let mut invalid = vec![
            opening_input(0, 2.0, 10.0, Some("2099-12-31")),
            opening_input(1, 0.0, 10.0, Some("2099-12-31")),
            opening_input(1, -1.0, 10.0, Some("2099-12-31")),
            opening_input(1, f64::NAN, 10.0, Some("2099-12-31")),
            opening_input(1, 1.0, -1.0, Some("2099-12-31")),
            opening_input(1, 1.0, f64::INFINITY, Some("2099-12-31")),
            opening_input(1, 1.0e308, 1.0e308, Some("2099-12-31")),
            opening_input(1, 1.0, 1.0, None),
            opening_input(1, 1.0, 1.0, Some("2027-02-29")),
            opening_input(1, 1.0, 1.0, Some("2027-13-01")),
            opening_input(1, 1.0, 1.0, Some("garbage")),
            opening_input(999, 1.0, 1.0, Some("2099-12-31")),
        ];
        invalid.push(OpeningBalanceInput {
            unit_price: f64::NEG_INFINITY,
            ..opening_input(1, 1.0, 1.0, Some("2099-12-31"))
        });
        for input in invalid {
            assert!(create_opening_balance(&mut conn, "reader-a", input)
                .await
                .is_err());
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM inventory WHERE batch_number LIKE 'OPEN-%'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );

        // A late journal failure must roll back inventory and audit.
        conn.execute(
            "CREATE TRIGGER fail_journal BEFORE INSERT ON daily_journals BEGIN SELECT RAISE(ABORT,'journal blocked'); END",
        )
        .await
        .unwrap();
        assert!(create_opening_balance(
            &mut conn,
            "reader-a",
            opening_input(1, 20.0, 10.0, Some("2099-12-31"))
        )
        .await
        .is_err());
        conn.execute("DROP TRIGGER fail_journal").await.unwrap();
        // A late shortage failure must additionally roll back the journal,
        // journal entries and OPENING_BALANCE activity.
        conn.execute(
            "CREATE TRIGGER fail_shortage BEFORE UPDATE ON shortages BEGIN SELECT RAISE(ABORT,'shortage blocked'); END",
        )
        .await
        .unwrap();
        assert!(create_opening_balance(
            &mut conn,
            "reader-a",
            opening_input(1, 20.0, 10.0, Some("2099-12-31"))
        )
        .await
        .is_err());
        for table in ["daily_journals", "journal_entries", "activity_log"] {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            let count: i64 = sqlx::query_scalar(&sql).fetch_one(&mut conn).await.unwrap();
            assert_eq!(count, 0, "non-atomic opening insert into {table}");
        }
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM inventory WHERE batch_number LIKE 'OPEN-%'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(count, 0);
        let status: String = sqlx::query_scalar("SELECT status FROM shortages WHERE id=1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(status, "pending");
    }

    #[tokio::test]
    async fn two_pharmacies_and_roles_cannot_cross_read_inventory_history() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute(
            r#"CREATE TABLE users(id TEXT,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER,full_name TEXT,username TEXT);
               INSERT INTO users VALUES
               ('owner-a','owner','{}','a',1,'Owner A','owner-a'),
               ('reader-a','cashier','{"preview_item_movements":true,"can_view_opening_balances":true}','a',1,'Reader A','reader-a'),
               ('blocked-a','cashier','{}','a',1,'Blocked','blocked'),
               ('inactive-a','owner','{}','a',0,'Inactive','inactive'),
               ('owner-b','owner','{}','b',1,'Owner B','owner-b'),
               ('owner-default','owner','{}',NULL,1,'Default','default');
               CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT,created_at TEXT);
               INSERT INTO activity_log VALUES
               (1,'owner-a','OPENING_BALANCE','A-only','a','2026-10-01'),
               (2,'owner-b','OPENING_BALANCE','B-only','b','2026-10-02'),
               (3,'owner-default','OPENING_BALANCE','Default-only',NULL,'2026-10-03'),
               (4,'owner-b','OPENING_BALANCE','A-row with B author','a','2026-10-04');
               CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT);
               CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT);
               CREATE TABLE returns(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT);
               CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT);
               INSERT INTO master_drugs VALUES(1,'Drug','Drug');
               CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,batch_number TEXT,quantity REAL,cost_price REAL,created_at TEXT);
               INSERT INTO inventory VALUES
               ('a-lot',1,'a','OPEN-A',3,5,'2026-10-01'),
               ('b-lot',1,'b','OPEN-B',55,10,'2026-10-02'),
               ('default-lot',1,NULL,'OPEN-DEFAULT',1,4,'2026-10-03'),
               ('a-normal',1,'a','PURCHASE-A',1,3,'2026-10-04');"#,
        )
        .await
        .unwrap();
        let movements =
            scoped_inventory_history(&mut conn, "reader-a", "inventory.movements", 200, 0)
                .await
                .unwrap();
        assert_eq!(movements.actor_id, "reader-a");
        assert_eq!(movements.pharmacy_id, "a");
        assert_eq!(serde_json::to_value(&movements).unwrap()["actorId"], "reader-a");
        assert_eq!(serde_json::to_value(&movements).unwrap()["pharmacyId"], "a");
        let movements = movements.rows;
        assert_eq!(movements.len(), 2);
        assert!(movements.iter().all(|row| row["details"] != "B-only"));
        assert_eq!(movements[0]["details"], "A-row with B author");
        assert_eq!(movements[0]["user_id"], Value::Null);
        assert_eq!(movements[0]["username"], Value::Null);
        let openings =
            scoped_inventory_history(&mut conn, "reader-a", "inventory.opening_balances", 200, 0)
                .await
                .unwrap();
        assert_eq!(openings.actor_id, "reader-a");
        assert_eq!(openings.pharmacy_id, "a");
        let openings = openings.rows;
        assert_eq!(openings.len(), 1);
        assert_eq!(openings[0]["id"], "a-lot");
        assert_eq!(
            scoped_inventory_history(&mut conn, "owner-b", "inventory.opening_balances", 200, 0)
                .await
                .unwrap().rows[0]["id"],
            "b-lot"
        );
        assert_eq!(
            scoped_inventory_history(
                &mut conn,
                "owner-default",
                "inventory.opening_balances",
                200,
                0
            )
            .await
            .unwrap().rows[0]["id"],
            "default-lot"
        );
        for actor in ["blocked-a", "inactive-a", "unknown"] {
            assert!(
                scoped_inventory_history(&mut conn, actor, "inventory.movements", 200, 0)
                    .await
                    .is_err()
            );
        }
        for query_id in ["inventory.other", "inventory.movements"] {
            assert!(
                scoped_inventory_history(&mut conn, "owner-a", query_id, 201, 0)
                    .await
                    .is_err()
            );
        }
        assert!(
            scoped_inventory_history(&mut conn, "owner-a", "inventory.other", 1, 0)
                .await
                .is_err()
        );
        // Each request must resolve the *current* native session's actor and
        // pharmacy; the renderer can then reject a mixed-scope page sequence.
        conn.execute("UPDATE users SET pharmacy_id='b' WHERE id='reader-a'")
            .await
            .unwrap();
        let reassigned =
            scoped_inventory_history(&mut conn, "reader-a", "inventory.movements", 200, 0)
                .await
                .unwrap();
        assert_eq!(reassigned.actor_id, "reader-a");
        assert_eq!(reassigned.pharmacy_id, "b");
        assert_eq!(reassigned.rows.len(), 1);
        assert_eq!(reassigned.rows[0]["details"], "B-only");
        let wire = serde_json::to_value(reassigned).unwrap();
        assert_eq!(wire["actorId"], "reader-a");
        assert_eq!(wire["pharmacyId"], "b");
        assert!(wire["rows"].is_array());
    }

    #[tokio::test]
    async fn movement_drug_names_require_tenant_bound_source_evidence() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER,full_name TEXT,username TEXT);
            INSERT INTO users VALUES ('owner-a','owner','{}','a',1,'Owner A','owner-a');
            CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT);
            INSERT INTO master_drugs VALUES (41,'دواء أول','Panadol'),(42,'دواء ثان','Brufen'),(43,'دواء ثالث','Augmentin');
            CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,quantity REAL,batch_number TEXT);
            INSERT INTO inventory VALUES
              ('zero-lot',43,'a',0,'ZERO-A'),('lot-b',42,'b',20,'B'),
              ('batch-a1',41,'a',4,'A1'),('batch-a2',42,'a',5,'A2'),
              ('open-a',42,'a',0,'OPEN-A');
            CREATE TABLE inventory_lot_create_requests(request_id TEXT,inventory_id TEXT,drug_id INTEGER,pharmacy_id TEXT,created_by TEXT);
            INSERT INTO inventory_lot_create_requests VALUES
              ('request-a','deleted-lot',41,'a','owner-a'),('request-b','lot-b',42,'b','owner-a');
            CREATE TABLE inventory_lot_import_receipts(request_id TEXT,created_by TEXT,pharmacy_id TEXT,inventory_ids_json TEXT,inventory_count INTEGER);
            INSERT INTO inventory_lot_import_receipts VALUES ('batch-request','owner-a','a','["batch-a1","batch-a2"]',2);
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT);
            INSERT INTO sales_invoices VALUES ('sale-a','a','owner-a'),('sale-b','b','owner-a'),('partial-sale','a','owner-a');
            CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER);
            INSERT INTO sales_items VALUES
              (1,'sale-a',41),(2,'sale-a',42),(3,'sale-a',41),(4,'sale-b',43),
              (5,'partial-sale',41),(6,'partial-sale',999);
            CREATE TABLE returns(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT);
            INSERT INTO returns VALUES ('ret-a','a','owner-a'),('ret-b','b','owner-a');
            CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT,drug_id INTEGER);
            INSERT INTO return_items VALUES (1,'ret-a',42),(2,'ret-b',43);
            CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT);
            INSERT INTO purchase_invoices VALUES ('purchase-a','a','owner-a'),('purchase-b','b','owner-a');
            CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER);
            INSERT INTO purchase_invoice_items VALUES (1,'purchase-a',43);
            -- Production purchase_returns has NO pharmacy_id column. Native
            -- immutable provenance owns the tenant on completed returns.
            CREATE TABLE purchase_returns(id TEXT PRIMARY KEY,purchase_invoice_id TEXT,user_id TEXT);
            INSERT INTO purchase_returns VALUES
              ('purchase-return-a','purchase-a','owner-a'),
              ('purchase-return-b','purchase-b','owner-a'),
              ('purchase-return-unowned','purchase-a','owner-a');
            CREATE TABLE native_purchase_return_provenance(return_id TEXT PRIMARY KEY,purchase_invoice_id TEXT,pharmacy_id TEXT,actor_id TEXT);
            INSERT INTO native_purchase_return_provenance VALUES
              ('purchase-return-a','purchase-a','a','owner-a'),
              ('purchase-return-b','purchase-b','b','owner-a');
            CREATE TABLE purchase_return_items(id INTEGER PRIMARY KEY,purchase_return_id TEXT,drug_id INTEGER);
            INSERT INTO purchase_return_items VALUES
              (1,'purchase-return-a',41),(2,'purchase-return-b',42),
              (3,'purchase-return-unowned',43);
            CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT,created_at TEXT);
            INSERT INTO activity_log VALUES
              (1,'owner-a','COMPLETE_SALE','Sale sale-a value 23','a','2026-10-01'),
              (2,'owner-a','CREATE_RETURN','Return ret-a value 5','a','2026-10-02'),
              (3,'owner-a','STOCK_ADJUSTMENT','Updated tenant lot zero-lot drug=43 old_qty=1 new_qty=0','a','2026-10-03'),
              (4,'owner-a','ADD_INVENTORY','native-inventory-create-request=request-a; lot_id=deleted-lot; drug_id=41; quantity=1','a','2026-10-04'),
              (5,'owner-a','COMPLETE_SALE','Sale sale-b value 3','a','2026-10-05'),
              (6,'owner-a','CREATE_RETURN','Return ret-b value 3','a','2026-10-06'),
              (7,'owner-a','ADD_INVENTORY','native-inventory-create-request=request-b; lot_id=lot-b; drug_id=42; quantity=1','a','2026-10-07'),
              (8,'owner-a','COMPLETE_SALE','Sale ambiguous value 3','a','2026-10-08'),
              (9,'owner-a','STOCK_ADJUSTMENT','Updated tenant lot zero-lot drug=42 old_qty=1 new_qty=0','a','2026-10-09'),
              (10,'owner-a','ADD_INVENTORY','native-inventory-batch-request=batch-request; lot_count=2; receipt_sha256=abc','a','2026-10-10'),
              (11,'owner-a','DELETE_INVENTORY','Deleted unused zero-quantity inventory lot deleted-lot','a','2026-10-11'),
              (12,'owner-a','OPENING_BALANCE','رصيد افتتاحي 1 من Brufen (OPEN-A)','a','2026-10-12'),
              (13,'owner-a','COMPLETE_SALE','Sale partial-sale value 10','a','2026-10-13'),
              (14,'owner-a','COMPLETE_PURCHASE','Purchase purchase-a value 5','a','2026-10-14'),
              (15,'owner-a','PURCHASE_RETURN','Purchase return purchase-return-a for supplier 1; value=3','a','2026-10-15'),
              (16,'owner-a','PURCHASE_RETURN','Purchase return purchase-return-b for supplier 1; value=3','a','2026-10-16'),
              (17,'owner-a','PURCHASE_RETURN','Purchase return purchase-return-unowned for supplier 1; value=3','a','2026-10-17');
        "#).execute(&mut conn).await.unwrap();

        let movements = scoped_inventory_history(&mut conn,"owner-a","inventory.movements",200,0).await.unwrap().rows;
        let names = |id: i64| movements.iter().find(|row| row["id"] == id).unwrap()["drug_names"].clone();
        assert_eq!(names(1), json!(["Panadol","Brufen"]));
        assert_eq!(names(2), json!(["Brufen"]));
        assert_eq!(names(3), json!(["Augmentin"])); // original lot has zero stock
        assert_eq!(names(4), json!(["Panadol"])); // immutable receipt survives lot deletion
        assert_eq!(names(10), json!(["Panadol","Brufen"]));
        assert_eq!(names(11), json!(["Panadol"]));
        assert_eq!(names(12), json!(["Brufen"]));
        assert_eq!(names(14), json!(["Augmentin"]));
        assert_eq!(names(15), json!(["Panadol"]));
        for id in [5,6,7,8,9,13,16,17] {
            assert_eq!(names(id), json!([]), "row {id} must not guess an item");
        }
    }

    #[tokio::test]
    async fn missing_scope_audit_requires_matching_document_tenant_and_author() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER,full_name TEXT,username TEXT);
            INSERT INTO users VALUES
              ('owner-qa','owner','{}','qa',1,'QA Owner','owner-qa'),
              ('cashier-qa','cashier','{"preview_item_movements":true}','qa',1,'QA Cashier','cashier-qa'),
              ('owner-other','owner','{}','other',1,'Other','owner-other'),
              ('owner-default','owner','{}',NULL,1,'Default','owner-default');
            CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT);
            INSERT INTO master_drugs VALUES (11,'صنف','Owned Drug');
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT);
            INSERT INTO sales_invoices VALUES
              ('qa-sale','qa','owner-qa'),('other-sale','other','owner-qa'),
              ('qa-different-author','qa','owner-other'),('legacy-sale',NULL,'owner-qa');
            CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER);
            INSERT INTO sales_items VALUES (1,'qa-sale',11);
            CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT);
            INSERT INTO purchase_invoices VALUES ('qa-purchase','qa','owner-qa');
            CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER);
            INSERT INTO purchase_invoice_items VALUES (1,'qa-purchase',11);
            CREATE TABLE returns(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT);
            INSERT INTO returns VALUES ('qa-return','qa','owner-qa');
            CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT,drug_id INTEGER);
            INSERT INTO return_items VALUES (1,'qa-return',11);
            CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT,created_at TEXT);
            INSERT INTO activity_log VALUES
              (1,'owner-qa','COMPLETE_PURCHASE','Purchase qa-purchase value 115.5',NULL,'2026-10-17 01:00:00'),
              (2,'owner-qa','COMPLETE_SALE','Sale qa-sale value 150',NULL,'2026-10-17 02:00:00'),
              (3,'owner-qa','CREATE_RETURN','Return qa-return value 150',NULL,'2026-10-17 03:00:00'),
              (4,'owner-qa','COMPLETE_SALE','Sale other-sale value 1',NULL,'2026-10-17 04:00:00'),
              (5,'owner-qa','COMPLETE_SALE','Sale qa-different-author value 1',NULL,'2026-10-17 05:00:00'),
              (6,'owner-qa','COMPLETE_SALE','Sale legacy-sale value 1',NULL,'2026-10-17 06:00:00'),
              (7,'owner-qa','COMPLETE_SALE','Sale unknown value 1',NULL,'2026-10-17 07:00:00'),
              (8,'owner-qa','COMPLETE_SALE','Sale qa-sale value 150','other','2026-10-17 08:00:00'),
              (9,'owner-qa','PURCHASE_RETURN','Purchase return qa-return for supplier 1; value=20','qa','2026-10-17 09:00:00');
            CREATE TABLE purchase_returns(id TEXT PRIMARY KEY,purchase_invoice_id TEXT,user_id TEXT);
            CREATE TABLE native_purchase_return_provenance(return_id TEXT PRIMARY KEY,purchase_invoice_id TEXT,pharmacy_id TEXT,actor_id TEXT);
            CREATE TABLE purchase_return_items(id INTEGER PRIMARY KEY,purchase_return_id TEXT,drug_id INTEGER);
        "#).execute(&mut conn).await.unwrap();

        let page = scoped_inventory_history(&mut conn, "owner-qa", "inventory.movements", 200, 0).await.unwrap();
        assert_eq!(page.rows.iter().map(|row| row["id"].as_i64().unwrap()).collect::<Vec<_>>(), [9, 3, 2, 1]);
        for id in [1, 2, 3] {
            let row = page.rows.iter().find(|row| row["id"] == id).unwrap();
            assert_eq!(row["drug_names"], json!(["Owned Drug"]));
            assert_eq!(row["created_at"], format!("2026-10-17 0{id}:00:00"));
        }
        assert!(scoped_inventory_history(&mut conn,"owner-other","inventory.movements",200,0).await.unwrap().rows.iter().all(|row| row["id"] != 1 && row["id"] != 2 && row["id"] != 3));
        assert!(scoped_inventory_history(&mut conn,"owner-default","inventory.movements",200,0).await.unwrap().rows.is_empty());

        let cashier = scoped_inventory_history(&mut conn,"cashier-qa","inventory.movements",200,0).await.unwrap();
        assert_eq!(cashier.rows.len(), 4);
        for row in cashier.rows.iter().filter(|row| row["action"] == "COMPLETE_PURCHASE" || row["action"] == "PURCHASE_RETURN") {
            assert!(!row["details"].as_str().unwrap().contains("value"), "purchase costs are private");
        }
        assert_eq!(cashier.rows.iter().find(|row| row["id"] == 1).unwrap()["drug_names"], json!(["Owned Drug"]));
    }
}
