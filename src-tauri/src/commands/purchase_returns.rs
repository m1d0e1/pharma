use crate::commands::critical::{purchase_inventory_paid_factor, user_can_view_purchases};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, SqliteConnection};
use std::collections::HashSet;
use tauri::Manager;
use uuid::Uuid;

const LOCAL_PHARMACY: &str = "local_default";

#[derive(Clone, Debug, Deserialize)]
pub struct PurchaseReturnPayload {
    pub purchase_invoice_id: String,
    pub supplier_id: i64,
    pub user_id: String,
    pub pharmacy_id: Option<String>,
    pub reason: Option<String>,
    pub refund_method: String,
    pub items: Vec<PurchaseReturnItem>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PurchaseReturnItem {
    pub purchase_invoice_item_id: i64,
    pub quantity: f64,
    pub unit: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PurchaseReturnResult {
    pub return_id: String,
    pub total_amount: f64,
}

struct PreparedLine {
    purchase_invoice_item_id: i64,
    inventory_id: String,
    drug_id: i64,
    drug_name: String,
    quantity: f64,
    unit: String,
    unit_price: f64,
    total_price: f64,
    stock_quantity: f64,
}

#[tauri::command]
pub async fn create_purchase_return_critical(
    app: tauri::AppHandle,
    payload: PurchaseReturnPayload,
) -> Result<PurchaseReturnResult, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("pharma_local.db");
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| error.to_string())?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut connection)
        .await
        .map_err(|error| error.to_string())?;
    run_purchase_return_transaction(&mut connection, payload).await
}

pub(crate) async fn run_purchase_return_transaction(
    connection: &mut SqliteConnection,
    payload: PurchaseReturnPayload,
) -> Result<PurchaseReturnResult, String> {
    // ponytail: BEGIN IMMEDIATE serializes validation with the stock/accounting write.
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
    let result = create_purchase_return_on_connection(connection, &payload).await;
    match result {
        Ok(result) => {
            sqlx::query("COMMIT")
                .execute(&mut *connection)
                .await
                .map_err(|error| error.to_string())?;
            Ok(result)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
        }
    }
}

pub(crate) async fn create_purchase_return_on_connection(
    connection: &mut SqliteConnection,
    payload: &PurchaseReturnPayload,
) -> Result<PurchaseReturnResult, String> {
    validate_payload(payload)?;

    let invoice = sqlx::query(
        r#"
        SELECT supplier_id, pharmacy_id, status,
               CAST(COALESCE(tax_percent, 0) AS REAL) AS tax_percent,
               CAST(COALESCE(expenses, 0) AS REAL) AS expenses,
               CAST(COALESCE(discount_value, 0) AS REAL) AS discount_value,
               CAST(COALESCE(discount_percent, 0) AS REAL) AS discount_percent
        FROM purchase_invoices WHERE id = ?
        "#,
    )
    .bind(payload.purchase_invoice_id.trim())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "Completed purchase invoice not found".to_string())?;
    let status: String = invoice.try_get("status").unwrap_or_default();
    if status != "completed" {
        return Err("Completed purchase invoice not found".into());
    }
    let supplier_id: i64 = invoice
        .try_get("supplier_id")
        .map_err(|_| "Purchase invoice has an invalid supplier".to_string())?;
    if supplier_id != payload.supplier_id {
        return Err("Purchase invoice does not belong to the selected supplier".into());
    }
    if sqlx::query("SELECT 1 FROM suppliers WHERE id = ?")
        .bind(supplier_id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Err("Purchase invoice supplier no longer exists".into());
    }

    let invoice_pharmacy = normalize_pharmacy(
        invoice
            .try_get::<Option<String>, _>("pharmacy_id")
            .ok()
            .flatten()
            .as_deref(),
    );
    let session_pharmacy = normalize_pharmacy(payload.pharmacy_id.as_deref());
    if invoice_pharmacy != session_pharmacy {
        return Err("Purchase invoice belongs to another pharmacy".into());
    }

    let user = sqlx::query(
        "SELECT id, pharmacy_id, role, permissions FROM users WHERE id = ? AND COALESCE(is_active, 1) = 1",
    )
    .bind(payload.user_id.trim())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| error.to_string())?
    .ok_or_else(|| "Session user no longer exists or is inactive".to_string())?;
    let user_id: String = user
        .try_get("id")
        .map_err(|_| "Session user has an invalid identity".to_string())?;
    let user_role: Option<String> = user.try_get("role").unwrap_or(None);
    let user_permissions: Option<String> = user.try_get("permissions").unwrap_or(None);
    if !user_can_view_purchases(user_role.as_deref(), user_permissions.as_deref()) {
        return Err("Unauthorized: can_view_purchases permission required".into());
    }
    let user_pharmacy = normalize_pharmacy(
        user.try_get::<Option<String>, _>("pharmacy_id")
            .ok()
            .flatten()
            .as_deref(),
    );
    if user_pharmacy != session_pharmacy {
        return Err("Session pharmacy does not match the current user".into());
    }

    let invoice_tax: f64 = invoice.try_get("tax_percent").unwrap_or(0.0);
    let invoice_expenses: f64 = invoice.try_get("expenses").unwrap_or(0.0);
    let invoice_discount_value: f64 = invoice.try_get("discount_value").unwrap_or(0.0);
    let invoice_discount_percent: f64 = invoice.try_get("discount_percent").unwrap_or(0.0);
    if !invoice_tax.is_finite()
        || invoice_tax < 0.0
        || !invoice_expenses.is_finite()
        || invoice_expenses < 0.0
        || !invoice_discount_value.is_finite()
        || invoice_discount_value < 0.0
        || !invoice_discount_percent.is_finite()
        || !(0.0..=100.0).contains(&invoice_discount_percent)
    {
        return Err("Purchase invoice has invalid stored totals".into());
    }
    let raw_items_total: f64 = sqlx::query_scalar(
        r#"
        SELECT CAST(COALESCE(SUM(
          CAST(quantity AS REAL) * CAST(cost_price AS REAL)
          * (1 + CAST(COALESCE(tax_percent, 0) AS REAL) / 100.0)
        ), 0) AS REAL)
        FROM purchase_invoice_items WHERE invoice_id = ?
        "#,
    )
    .bind(payload.purchase_invoice_id.trim())
    .fetch_one(&mut *connection)
    .await
    .map_err(|error| error.to_string())?;
    let taxed_items_total = raw_items_total * (1.0 + invoice_tax / 100.0);
    if !taxed_items_total.is_finite() || taxed_items_total <= 0.0 {
        return Err("Purchase invoice has no refundable item value".into());
    }
    let paid_factor = purchase_inventory_paid_factor(
        taxed_items_total,
        invoice_expenses,
        invoice_discount_value,
        invoice_discount_percent,
    );

    let mut prepared = Vec::with_capacity(payload.items.len());
    let mut total_amount = 0.0;
    for item in &payload.items {
        let line = sqlx::query(
            r#"
            SELECT pii.id,
                   pii.drug_id,
                   CAST(pii.quantity AS REAL) AS purchased_quantity,
                   pii.inventory_id,
                   CAST(pii.cost_price AS REAL) AS cost_price,
                   CAST(COALESCE(pii.bonus_quantity, 0) AS REAL) AS bonus_quantity,
                   CAST(COALESCE(pii.tax_percent, 0) AS REAL) AS line_tax_percent,
                   CAST(COALESCE(pii.discount_percent, 0) AS REAL) AS line_discount_percent,
                   CAST(COALESCE(NULLIF(pii.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS REAL) AS large_to_medium,
                   CAST(COALESCE(NULLIF(md.medium_to_small, 0), 1) AS REAL) AS medium_to_small,
                   COALESCE(NULLIF(md.trade_name, ''), 'Drug ' || pii.drug_id) AS drug_name
            FROM purchase_invoice_items pii
            LEFT JOIN master_drugs md ON md.id = pii.drug_id
            WHERE pii.id = ? AND pii.invoice_id = ?
            "#,
        )
        .bind(item.purchase_invoice_item_id)
        .bind(payload.purchase_invoice_id.trim())
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            "One or more return lines do not belong to the selected purchase invoice".to_string()
        })?;

        let drug_id: i64 = line
            .try_get("drug_id")
            .map_err(|_| "Purchase invoice line has an invalid drug".to_string())?;
        let inventory_id = line
            .try_get::<Option<String>, _>("inventory_id")
            .ok()
            .flatten()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                format!(
                    "Purchase invoice line {} has no inventory link",
                    item.purchase_invoice_item_id
                )
            })?;
        let purchased_quantity: f64 = line.try_get("purchased_quantity").unwrap_or(0.0);
        let cost_price: f64 = line.try_get("cost_price").unwrap_or(f64::NAN);
        let bonus_quantity: f64 = line.try_get("bonus_quantity").unwrap_or(0.0);
        let line_tax_percent: f64 = line.try_get("line_tax_percent").unwrap_or(0.0);
        let line_discount_percent: f64 = line.try_get("line_discount_percent").unwrap_or(0.0);
        let large_to_medium: f64 = line.try_get("large_to_medium").unwrap_or(1.0);
        let medium_to_small: f64 = line.try_get("medium_to_small").unwrap_or(1.0);
        if !purchased_quantity.is_finite()
            || purchased_quantity <= 0.0
            || !cost_price.is_finite()
            || cost_price < 0.0
            || !bonus_quantity.is_finite()
            || bonus_quantity < 0.0
            || !line_tax_percent.is_finite()
            || line_tax_percent < 0.0
            || !line_discount_percent.is_finite()
            || !(0.0..=100.0).contains(&line_discount_percent)
            || !large_to_medium.is_finite()
            || large_to_medium <= 0.0
            || !medium_to_small.is_finite()
            || medium_to_small <= 0.0
        {
            return Err(format!(
                "Purchase invoice line {} has invalid stored values",
                item.purchase_invoice_item_id
            ));
        }

        let unit = canonical_unit(item.unit.as_deref())?;
        let factor = match unit {
            "medium" => large_to_medium,
            "small" => large_to_medium * medium_to_small,
            _ => 1.0,
        };
        let returned_paid_quantity = item.quantity / factor;
        // Bonus stock carries the paid units' cost, so return it proportionally.
        let stock_quantity =
            returned_paid_quantity * ((purchased_quantity + bonus_quantity) / purchased_quantity);
        // cost_price is already post-line-discount in the purchase workflow.
        let paid_large_unit_price = cost_price
            * (1.0 + line_tax_percent / 100.0)
            * (1.0 + invoice_tax / 100.0)
            * paid_factor;
        let paid_line_total = purchased_quantity * paid_large_unit_price;
        let unit_price = paid_large_unit_price / factor;
        let total_price = item.quantity * unit_price;
        if !stock_quantity.is_finite() || !unit_price.is_finite() || !total_price.is_finite() {
            return Err("Purchase return calculation is invalid".into());
        }

        let prior = sqlx::query(
            r#"
            SELECT CAST(pri.quantity_returned AS REAL) AS quantity_returned,
                   COALESCE(pri.unit, 'large') AS unit,
                   CAST(COALESCE(pri.total_price, 0) AS REAL) AS total_price
            FROM purchase_return_items pri
            JOIN purchase_returns pr ON pr.id = pri.purchase_return_id
            WHERE pr.purchase_invoice_id = ? AND pr.status = 'completed'
              AND (
                pri.purchase_invoice_item_id = ?
                OR (
                  pri.purchase_invoice_item_id IS NULL
                  AND pri.inventory_id = ?
                  AND pri.drug_id = ?
                )
              )
            "#,
        )
        .bind(payload.purchase_invoice_id.trim())
        .bind(item.purchase_invoice_item_id)
        .bind(&inventory_id)
        .bind(drug_id)
        .fetch_all(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
        let mut previously_returned = 0.0;
        let mut previous_refund = 0.0;
        for returned in prior {
            let quantity: f64 = returned.try_get("quantity_returned").unwrap_or(0.0);
            let previous_unit: String = returned.try_get("unit").unwrap_or_else(|_| "large".into());
            let previous_factor = match canonical_unit(Some(&previous_unit))? {
                "medium" => large_to_medium,
                "small" => large_to_medium * medium_to_small,
                _ => 1.0,
            };
            previously_returned += quantity / previous_factor;
            previous_refund += returned
                .try_get::<f64, _>("total_price")
                .unwrap_or(0.0)
                .max(0.0);
        }
        if previously_returned + returned_paid_quantity > purchased_quantity + 0.005 {
            let remaining = (purchased_quantity - previously_returned).max(0.0);
            return Err(format!(
                "Return quantity exceeds the invoice remainder ({remaining:.2} large units available)"
            ));
        }
        if previous_refund + total_price > paid_line_total + 0.005 {
            return Err(
                "Return value exceeds the amount paid for the purchase invoice line".into(),
            );
        }

        let inventory = sqlx::query(
            r#"
            SELECT CAST(quantity AS REAL) AS quantity
            FROM inventory
            WHERE id = ? AND drug_id = ?
              AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
            "#,
        )
        .bind(&inventory_id)
        .bind(drug_id)
        .bind(&invoice_pharmacy)
        .bind(&invoice_pharmacy)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            "The purchase invoice inventory batch no longer exists in this pharmacy".to_string()
        })?;
        let available: f64 = inventory.try_get("quantity").unwrap_or(0.0);
        if available + 0.005 < stock_quantity {
            return Err(format!(
                "Insufficient inventory for {}",
                line.try_get::<String, _>("drug_name")
                    .unwrap_or_else(|_| format!("drug {drug_id}"))
            ));
        }

        total_amount += total_price;
        prepared.push(PreparedLine {
            purchase_invoice_item_id: item.purchase_invoice_item_id,
            inventory_id,
            drug_id,
            drug_name: line
                .try_get("drug_name")
                .unwrap_or_else(|_| format!("Drug {drug_id}")),
            quantity: item.quantity,
            unit: unit.into(),
            unit_price,
            total_price,
            stock_quantity,
        });
    }
    if !total_amount.is_finite() {
        return Err("Purchase return total is invalid".into());
    }

    let return_id = Uuid::new_v4().to_string();
    let reason = payload
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    sqlx::query(
        r#"
        INSERT INTO purchase_returns
          (id, purchase_invoice_id, supplier_id, user_id, reason, total_amount, refund_method, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')
        "#,
    )
    .bind(&return_id)
    .bind(payload.purchase_invoice_id.trim())
    .bind(supplier_id)
    .bind(&user_id)
    .bind(reason)
    .bind(total_amount)
    .bind(&payload.refund_method)
    .execute(&mut *connection)
    .await
    .map_err(|error| error.to_string())?;

    for line in prepared {
        let stock = sqlx::query(
            r#"
            UPDATE inventory
            SET quantity = CASE WHEN quantity - ? < 0.0001 THEN 0 ELSE quantity - ? END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND drug_id = ?
              AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
              AND quantity + 0.005 >= ?
            "#,
        )
        .bind(line.stock_quantity)
        .bind(line.stock_quantity)
        .bind(&line.inventory_id)
        .bind(line.drug_id)
        .bind(&invoice_pharmacy)
        .bind(&invoice_pharmacy)
        .bind(line.stock_quantity)
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
        if stock.rows_affected() != 1 {
            return Err(format!(
                "Inventory changed for {}; please retry",
                line.drug_name
            ));
        }

        sqlx::query(
            r#"
            INSERT INTO purchase_return_items
              (purchase_return_id, purchase_invoice_item_id, inventory_id, drug_id, drug_name,
               quantity_returned, unit_price, total_price, unit, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&return_id)
        .bind(line.purchase_invoice_item_id)
        .bind(&line.inventory_id)
        .bind(line.drug_id)
        .bind(&line.drug_name)
        .bind(line.quantity)
        .bind(line.unit_price)
        .bind(line.total_price)
        .bind(&line.unit)
        .bind(reason)
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
    }

    let default_note = if payload.refund_method == "cash" {
        "Cash purchase return"
    } else {
        "Purchase return"
    };
    sqlx::query(
        "INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, 'return', ?, ?, ?)",
    )
    .bind(supplier_id)
    .bind(total_amount)
    .bind(&return_id)
    .bind(reason.unwrap_or(default_note))
    .execute(&mut *connection)
    .await
    .map_err(|error| error.to_string())?;

    if payload.refund_method == "credit" {
        let updated =
            sqlx::query("UPDATE suppliers SET balance = COALESCE(balance, 0) - ? WHERE id = ?")
                .bind(total_amount)
                .bind(supplier_id)
                .execute(&mut *connection)
                .await
                .map_err(|error| error.to_string())?;
        if updated.rows_affected() != 1 {
            return Err("Purchase invoice supplier no longer exists".into());
        }
    } else {
        let permanent_shift_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO shifts (id, user_id, status) SELECT ?, ?, 'open' WHERE NOT EXISTS (SELECT 1 FROM shifts WHERE CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open')",
        )
        .bind(&permanent_shift_id)
        .bind(&user_id)
        .bind(&user_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
        let shift_id = sqlx::query_scalar::<_, String>(
            "SELECT id FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY start_time DESC LIMIT 1",
        )
        .bind(&user_id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
        sqlx::query(
            r#"
            INSERT INTO cash_movements
              (id, user_id, shift_id, type, category, amount, notes, date)
            VALUES (?, ?, ?, 'in', 'purchase_return', ?, ?, DATE('now', 'localtime'))
            "#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&user_id)
        .bind(shift_id)
        .bind(total_amount)
        .bind(reason.unwrap_or("Cash purchase return"))
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
        sqlx::query(
            "INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, 'payment', ?, ?, 'Cash purchase return refund')",
        )
        .bind(supplier_id)
        .bind(-total_amount)
        .bind(&return_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| error.to_string())?;
    }

    let journal_id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, DATE('now', 'localtime'), ?, ?, ?)",
    )
    .bind(&journal_id)
    .bind(format!("Purchase return {return_id}"))
    .bind(&user_id)
    .bind(total_amount)
    .execute(&mut *connection)
    .await
    .map_err(|error| error.to_string())?;
    let inventory_account = account_id(connection, "inventory_asset", "1.1.3").await?;
    let debit_account = if payload.refund_method == "credit" {
        account_id(connection, "accounts_payable", "2.1").await?
    } else {
        account_id(connection, "cash_drawer", "1.1.1").await?
    };
    insert_journal_entry(
        connection,
        &journal_id,
        debit_account,
        "debit",
        total_amount,
    )
    .await?;
    insert_journal_entry(
        connection,
        &journal_id,
        inventory_account,
        "credit",
        total_amount,
    )
    .await?;

    Ok(PurchaseReturnResult {
        return_id,
        total_amount,
    })
}

async fn account_id(
    connection: &mut SqliteConnection,
    category: &str,
    expected_code: &str,
) -> Result<i64, String> {
    if let Some(id) = sqlx::query_scalar::<_, i64>(
        "SELECT a.id FROM trial_balance_settings t JOIN accounts a ON a.id = t.account_id WHERE t.category = ? AND a.code = ? LIMIT 1",
    )
    .bind(category)
    .bind(expected_code)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| error.to_string())?
    {
        return Ok(id);
    }
    sqlx::query_scalar::<_, i64>("SELECT id FROM accounts WHERE code = ?")
        .bind(expected_code)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| {
            format!(
                "Accounting setup is missing '{}' (account code {}); restart after installing the update",
                category, expected_code
            )
        })
}

async fn insert_journal_entry(
    connection: &mut SqliteConnection,
    journal_id: &str,
    account_id: i64,
    entry_type: &str,
    amount: f64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)",
    )
    .bind(journal_id)
    .bind(account_id)
    .bind(entry_type)
    .bind(amount)
    .execute(&mut *connection)
    .await
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn validate_payload(payload: &PurchaseReturnPayload) -> Result<(), String> {
    if payload.purchase_invoice_id.trim().is_empty()
        || payload.supplier_id <= 0
        || payload.user_id.trim().is_empty()
        || payload.items.is_empty()
        || !matches!(payload.refund_method.as_str(), "cash" | "credit")
    {
        return Err("Invalid purchase return data".into());
    }
    let mut ids = HashSet::with_capacity(payload.items.len());
    for item in &payload.items {
        if item.purchase_invoice_item_id <= 0 || !item.quantity.is_finite() || item.quantity <= 0.0
        {
            return Err("Invalid purchase return item".into());
        }
        canonical_unit(item.unit.as_deref())?;
        if !ids.insert(item.purchase_invoice_item_id) {
            return Err("Duplicate purchase invoice lines are not allowed in one return".into());
        }
    }
    Ok(())
}

fn canonical_unit(unit: Option<&str>) -> Result<&'static str, String> {
    match unit.unwrap_or("large").trim().to_ascii_lowercase().as_str() {
        "large" | "box" => Ok("large"),
        "medium" | "strip" => Ok("medium"),
        "small" | "unit" | "pill" => Ok("small"),
        _ => Err("Invalid purchase return unit".into()),
    }
}

fn normalize_pharmacy(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(LOCAL_PHARMACY)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;
    use tokio::time::{sleep, Duration};

    async fn connect_test(path: &Path) -> SqliteConnection {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut connection = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("PRAGMA busy_timeout = 5000")
            .execute(&mut connection)
            .await
            .unwrap();
        connection
    }

    fn payload(quantity: f64) -> PurchaseReturnPayload {
        PurchaseReturnPayload {
            purchase_invoice_id: "purchase-1".into(),
            supplier_id: 7,
            user_id: "user-1".into(),
            pharmacy_id: Some(LOCAL_PHARMACY.into()),
            reason: Some("damaged".into()),
            refund_method: "credit".into(),
            items: vec![PurchaseReturnItem {
                purchase_invoice_item_id: 11,
                quantity,
                unit: Some("medium".into()),
            }],
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn derives_price_and_conversion_and_serializes_over_returns() {
        let path =
            std::env::temp_dir().join(format!("pharma-purchase-return-{}.db", Uuid::new_v4()));
        let mut first = connect_test(&path).await;
        sqlx::raw_sql(
            r#"
            CREATE TABLE users (id TEXT PRIMARY KEY, pharmacy_id TEXT, role TEXT, permissions TEXT, is_active INTEGER);
            CREATE TABLE suppliers (id INTEGER PRIMARY KEY, balance REAL);
            CREATE TABLE purchase_invoices (id TEXT PRIMARY KEY, supplier_id INTEGER, pharmacy_id TEXT, status TEXT, tax_percent REAL, expenses REAL, discount_value REAL, discount_percent REAL);
            CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, large_to_medium INTEGER, medium_to_small INTEGER);
            CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity REAL, cost_price REAL, updated_at TEXT);
            CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY, invoice_id TEXT, drug_id INTEGER, quantity REAL, cost_price REAL, bonus_quantity REAL, tax_percent REAL, discount_percent REAL, strips_per_box INTEGER, inventory_id TEXT);
            CREATE TABLE purchase_returns (id TEXT PRIMARY KEY, purchase_invoice_id TEXT, supplier_id INTEGER, user_id TEXT, reason TEXT, total_amount REAL, refund_method TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE purchase_return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_return_id TEXT, purchase_invoice_item_id INTEGER, inventory_id TEXT, drug_id INTEGER, drug_name TEXT, quantity_returned REAL, unit_price REAL, total_price REAL, unit TEXT, reason TEXT);
            CREATE TABLE supplier_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER, type TEXT, amount REAL, reference_id TEXT, notes TEXT);
            CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, start_time TEXT);
            CREATE TABLE cash_movements (id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT, type TEXT, category TEXT, amount REAL, notes TEXT, date TEXT);
            CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT);
            CREATE TABLE trial_balance_settings (category TEXT PRIMARY KEY, account_id INTEGER);
            CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL);
            CREATE TABLE journal_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id TEXT, account_id INTEGER, type TEXT, amount REAL);

            INSERT INTO users VALUES ('user-1', NULL, 'cashier', '{"can_view_purchases":true}', 1);
            INSERT INTO suppliers VALUES (7, 500);
            INSERT INTO accounts VALUES (60, '1.1.1'), (70, '2.1'), (100, '1.1.3');
            INSERT INTO trial_balance_settings VALUES ('cash_drawer', 60), ('accounts_payable', 70), ('inventory_asset', 100);
            INSERT INTO purchase_invoices VALUES ('purchase-1', 7, NULL, 'completed', 5, 0, 0, 10);
            INSERT INTO master_drugs VALUES (42, 'Stored Drug', 99, 10);
            INSERT INTO inventory VALUES ('exact-lot', 42, NULL, 3, 83.16, NULL);
            INSERT INTO purchase_invoice_items VALUES (11, 'purchase-1', 42, 2, 120, 1, 10, 0, 12, 'exact-lot');
            "#,
        )
        .execute(&mut first)
        .await
        .unwrap();

        sqlx::query("UPDATE users SET permissions = '{}' WHERE id = 'user-1'")
            .execute(&mut first)
            .await
            .unwrap();
        let permission_error = run_purchase_return_transaction(&mut first, payload(1.0))
            .await
            .unwrap_err();
        assert!(permission_error.contains("can_view_purchases"));
        sqlx::query("UPDATE users SET permissions = ? WHERE id = 'user-1'")
            .bind(serde_json::to_string(r#"{"can_view_purchases":true}"#).unwrap())
            .execute(&mut first)
            .await
            .unwrap();

        let tampered: PurchaseReturnPayload = serde_json::from_value(json!({
            "purchase_invoice_id": "purchase-1",
            "supplier_id": 7,
            "user_id": "user-1",
            "pharmacy_id": "local_default",
            "reason": "damaged",
            "refund_method": "credit",
            "items": [{
                "purchase_invoice_item_id": 11,
                "quantity": 6,
                "unit": "medium",
                "drug_id": 999,
                "inventory_id": "attacker-lot",
                "unit_price": 0.01
            }]
        }))
        .unwrap();
        let result = run_purchase_return_transaction(&mut first, tampered)
            .await
            .unwrap();
        assert!((result.total_amount - 62.37).abs() < 0.001);
        let saved = sqlx::query(
            "SELECT inventory_id, drug_id, unit_price, total_price FROM purchase_return_items",
        )
        .fetch_one(&mut first)
        .await
        .unwrap();
        assert_eq!(saved.get::<String, _>("inventory_id"), "exact-lot");
        assert_eq!(saved.get::<i64, _>("drug_id"), 42);
        assert!((saved.get::<f64, _>("unit_price") - 10.395).abs() < 0.001);
        assert!((saved.get::<f64, _>("total_price") - 62.37).abs() < 0.001);
        let journal = sqlx::query(
            r#"
            SELECT dj.total_amount,
                   SUM(CASE WHEN je.type = 'debit' THEN je.amount ELSE 0 END) AS debits,
                   SUM(CASE WHEN je.type = 'credit' THEN je.amount ELSE 0 END) AS credits,
                   MAX(CASE WHEN je.type = 'debit' THEN je.account_id END) AS debit_account,
                   MAX(CASE WHEN je.type = 'credit' THEN je.account_id END) AS credit_account
            FROM daily_journals dj JOIN journal_entries je ON je.journal_id = dj.id
            GROUP BY dj.id
            "#,
        )
        .fetch_one(&mut first)
        .await
        .unwrap();
        assert!((journal.get::<f64, _>("total_amount") - 62.37).abs() < 0.001);
        assert!((journal.get::<f64, _>("debits") - 62.37).abs() < 0.001);
        assert!((journal.get::<f64, _>("credits") - 62.37).abs() < 0.001);
        assert_eq!(journal.get::<i64, _>("debit_account"), 70);
        assert_eq!(journal.get::<i64, _>("credit_account"), 100);
        let stock_after_first =
            sqlx::query("SELECT quantity, cost_price FROM inventory WHERE id = 'exact-lot'")
                .fetch_one(&mut first)
                .await
                .unwrap();
        let first_carrying_value_removed = (3.0 - stock_after_first.get::<f64, _>("quantity"))
            * stock_after_first.get::<f64, _>("cost_price");
        assert!((first_carrying_value_removed - journal.get::<f64, _>("credits")).abs() < 0.001);

        let mut duplicate = payload(1.0);
        duplicate.items.push(duplicate.items[0].clone());
        assert!(run_purchase_return_transaction(&mut first, duplicate)
            .await
            .unwrap_err()
            .contains("Duplicate"));

        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut first)
            .await
            .unwrap();
        create_purchase_return_on_connection(&mut first, &payload(12.0))
            .await
            .unwrap();

        let mut second = connect_test(&path).await;
        let concurrent = tokio::spawn(async move {
            let result = run_purchase_return_transaction(&mut second, payload(12.0)).await;
            second.close().await.unwrap();
            result
        });
        sleep(Duration::from_millis(50)).await;
        sqlx::query("COMMIT").execute(&mut first).await.unwrap();

        let error = concurrent.await.unwrap().unwrap_err();
        assert!(error.contains("invoice remainder"), "{error}");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM purchase_returns")
            .fetch_one(&mut first)
            .await
            .unwrap();
        assert_eq!(count, 2);
        let journal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
            .fetch_one(&mut first)
            .await
            .unwrap();
        assert_eq!(journal_count, 2);
        let remaining_stock: f64 =
            sqlx::query_scalar("SELECT quantity FROM inventory WHERE id = 'exact-lot'")
                .fetch_one(&mut first)
                .await
                .unwrap();
        assert!((remaining_stock - 0.75).abs() < 0.001);
        let total_inventory_credit: f64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(amount), 0) FROM journal_entries WHERE type = 'credit' AND account_id = 100",
        )
        .fetch_one(&mut first)
        .await
        .unwrap();
        assert!(((3.0 - remaining_stock) * 83.16 - total_inventory_credit).abs() < 0.001);
        first.close().await.unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }
}
