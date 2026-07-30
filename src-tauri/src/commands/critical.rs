use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, Sqlite, SqliteConnection, Transaction};
use std::{collections::HashMap, str::FromStr};
use tauri::{Manager, State};
use uuid::Uuid;

#[derive(Default)]
pub struct DbTransactions {
    connections: tokio::sync::Mutex<HashMap<String, SqliteConnection>>,
}

#[derive(Debug, Deserialize)]
pub struct CheckoutPayload {
    pub pharmacy_id: String,
    pub user_id: String,
    pub items: Vec<CheckoutItem>,
    pub patient_id: Option<String>,
    pub shift_id: Option<String>,
    pub payment_method: String,
    pub check_number: Option<String>,
    pub status: String,
    #[serde(default, deserialize_with = "de_f64")]
    pub total_discount: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub additional_fees: f64,
}

#[derive(Debug, Deserialize)]
pub struct CheckoutItem {
    #[serde(deserialize_with = "de_i64")]
    pub drug_id: i64,
    pub inventory_id: Option<String>,
    #[serde(default, deserialize_with = "de_f64")]
    pub quantity_sold: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub unit_price: f64,
    pub selected_unit: String,
    #[serde(default)]
    pub is_negative: bool,
}

#[derive(Debug, Serialize)]
pub struct CheckoutResult {
    pub sale_id: String,
    pub total_amount: f64,
    pub points_earned: i64,
}

#[derive(Debug, Deserialize)]
pub struct PurchasePayload {
    #[serde(default, deserialize_with = "de_opt_string")]
    pub id: Option<String>,
    #[serde(deserialize_with = "de_i64")]
    pub supplier_id: i64,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub pharmacy_id: Option<String>,
    #[serde(default, deserialize_with = "de_string")]
    pub user_id: String,
    pub invoice_number: Option<String>,
    pub invoice_date: Option<String>,
    pub payment_method: Option<String>,
    pub notes: Option<String>,
    pub check_number: Option<String>,
    #[serde(default, deserialize_with = "de_f64")]
    pub expenses: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub discount_value: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub discount_percent: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub tax_percent: f64,
    pub status: Option<String>,
    #[serde(default)]
    pub cart: Vec<PurchaseItem>,
}

#[derive(Debug, Deserialize)]
pub struct PurchaseItem {
    #[serde(deserialize_with = "de_i64")]
    pub id: i64,
    #[serde(default, deserialize_with = "de_f64")]
    pub quantity: f64,
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub unit_id: Option<i64>,
    pub expiry_date: Option<String>,
    #[serde(default, deserialize_with = "de_f64")]
    pub cost_price: f64,
    #[serde(default, deserialize_with = "de_opt_f64")]
    pub selling_price: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub bonus_quantity: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub tax_percent: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub discount_percent: f64,
    #[serde(default = "one_i64", deserialize_with = "de_i64")]
    pub strips_per_box: i64,
    pub barcode: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PurchaseResult {
    pub id: String,
    pub total_amount: f64,
}

#[derive(Debug, Deserialize)]
pub struct DeletePurchasePayload {
    pub invoice_id: String,
    #[serde(default)]
    pub remove_inventory: bool,
}

#[derive(Debug, Deserialize)]
pub struct ReturnPayload {
    pub invoice_id: String,
    pub user_id: String,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub pharmacy_id: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub shift_id: Option<String>,
    pub refund_method: String,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub reason: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub patient_id: Option<String>,
    pub items: Vec<ReturnItem>,
}

#[derive(Debug, Deserialize)]
pub struct ReturnItem {
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub sale_item_id: Option<i64>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub inventory_id: Option<String>,
    pub drug_name: String,
    #[serde(default, deserialize_with = "de_f64")]
    pub quantity: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub unit_price: f64,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub unit: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReturnResult {
    pub return_id: String,
    pub total_refund: f64,
}

#[derive(Debug, Serialize)]
pub struct DbExecuteResult {
    #[serde(rename = "rowsAffected")]
    pub rows_affected: u64,
    #[serde(rename = "lastInsertId")]
    pub last_insert_id: i64,
}

#[tauri::command]
pub async fn db_execute_guarded(
    app: tauri::AppHandle,
    transactions: State<'_, DbTransactions>,
    sql: String,
    params: Vec<Value>,
    tx_id: Option<String>,
) -> Result<DbExecuteResult, String> {
    validate_write_sql(&sql)?;
    if let Some(tx_id) = tx_id {
        let mut connections = transactions.connections.lock().await;
        let conn = connections
            .get_mut(&tx_id)
            .ok_or_else(|| "Transaction not found".to_string())?;
        return execute_guarded_on_connection(conn, &sql, params).await;
    }

    let mut conn = open_app_connection(&app).await?;
    execute_guarded_on_connection(&mut conn, &sql, params).await
}

#[tauri::command]
pub async fn db_transaction_begin(
    app: tauri::AppHandle,
    transactions: State<'_, DbTransactions>,
) -> Result<String, String> {
    let mut conn = open_app_connection(&app).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;

    let tx_id = Uuid::new_v4().to_string();
    transactions
        .connections
        .lock()
        .await
        .insert(tx_id.clone(), conn);
    Ok(tx_id)
}

#[tauri::command]
pub async fn db_transaction_finish(
    transactions: State<'_, DbTransactions>,
    tx_id: String,
    commit: bool,
) -> Result<(), String> {
    let sql = if commit { "COMMIT" } else { "ROLLBACK" };
    let mut connections = transactions.connections.lock().await;
    let conn = connections
        .get_mut(&tx_id)
        .ok_or_else(|| "Transaction not found".to_string())?;
    sqlx::query(sql)
        .execute(conn)
        .await
        .map_err(|e| e.to_string())?;
    connections.remove(&tx_id);
    Ok(())
}

async fn execute_guarded_on_connection(
    conn: &mut SqliteConnection,
    sql: &str,
    params: Vec<Value>,
) -> Result<DbExecuteResult, String> {
    let mut query = sqlx::query(&sql);
    for param in params {
        query = bind_json_value(query, param);
    }
    let result = query.execute(conn).await.map_err(|e| e.to_string())?;

    Ok(DbExecuteResult {
        rows_affected: result.rows_affected(),
        last_insert_id: result.last_insert_rowid(),
    })
}

#[tauri::command]
pub async fn process_checkout_critical(
    app: tauri::AppHandle,
    payload: CheckoutPayload,
) -> Result<CheckoutResult, String> {
    if payload.items.is_empty() {
        return Err("Cart is empty".into());
    }
    if (payload.payment_method == "credit" || payload.payment_method == "wallet")
        && payload.patient_id.is_none()
    {
        return Err("Patient is required for credit or wallet payment".into());
    }

    let total_amount = checkout_total(
        &payload.items,
        payload.total_discount,
        payload.additional_fees,
    );
    let mut conn = open_app_connection(&app).await?;

    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let result = process_checkout_tx(&mut tx, payload, total_amount).await;
    match result {
        Ok(result) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(result)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn save_purchase_invoice_critical(
    app: tauri::AppHandle,
    payload: PurchasePayload,
) -> Result<PurchaseResult, String> {
    let mut conn = open_app_connection(&app).await?;

    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let result = save_purchase_invoice_tx(&mut tx, payload).await;
    match result {
        Ok(result) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(result)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn delete_purchase_invoice_critical(
    app: tauri::AppHandle,
    payload: DeletePurchasePayload,
) -> Result<(), String> {
    let mut conn = open_app_connection(&app).await?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let result =
        delete_purchase_invoice_tx(&mut tx, &payload.invoice_id, payload.remove_inventory).await;
    match result {
        Ok(()) => tx.commit().await.map_err(|e| e.to_string()),
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn create_return_critical(
    app: tauri::AppHandle,
    payload: ReturnPayload,
) -> Result<ReturnResult, String> {
    if payload.items.is_empty() {
        return Err("Return items are required".into());
    }
    let mut conn = open_app_connection(&app).await?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let result = create_return_tx(&mut tx, payload).await;
    match result {
        Ok(result) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(result)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

async fn open_app_connection(app: &tauri::AppHandle) -> Result<SqliteConnection, String> {
    let db_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    let options = SqliteConnectOptions::from_str(&format!("sqlite:{}", db_path.display()))
        .map_err(|e| e.to_string())?
        .create_if_missing(true)
        .foreign_keys(true);
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn bind_json_value<'q>(
    query: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    value: Value,
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match value {
        Value::Null => query.bind(Option::<String>::None),
        Value::Bool(v) => query.bind(if v { 1_i64 } else { 0_i64 }),
        Value::Number(v) => {
            if let Some(i) = v.as_i64() {
                query.bind(i)
            } else if let Some(u) = v.as_u64() {
                query.bind(u as i64)
            } else {
                query.bind(v.as_f64().unwrap_or_default())
            }
        }
        Value::String(v) => query.bind(v),
        other => query.bind(other.to_string()),
    }
}

fn validate_write_sql(sql: &str) -> Result<(), String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("Empty SQL is not allowed".into());
    }

    let upper = trimmed.to_ascii_uppercase();
    let first = upper.split_whitespace().next().unwrap_or("");
    if !matches!(
        first,
        "INSERT"
            | "UPDATE"
            | "DELETE"
            | "CREATE"
            | "ALTER"
            | "VACUUM"
            | "ANALYZE"
            | "BEGIN"
            | "COMMIT"
            | "ROLLBACK"
    ) {
        return Err(format!("SQL command '{}' is not allowed", first));
    }

    for token in ["ATTACH", "DETACH", "DROP", "PRAGMA", "LOAD_EXTENSION"] {
        if upper.contains(token) {
            return Err("SQL command contains a blocked operation".into());
        }
    }

    let semicolons = trimmed.matches(';').count();
    if semicolons > 1 || (semicolons == 1 && !trimmed.ends_with(';')) {
        return Err("Multiple SQL statements are not allowed".into());
    }

    Ok(())
}

async fn create_return_tx(
    tx: &mut Transaction<'_, Sqlite>,
    payload: ReturnPayload,
) -> Result<ReturnResult, String> {
    if payload.items.is_empty()
        || payload
            .items
            .iter()
            .any(|item| item.quantity <= 0.0 || item.unit_price < 0.0)
    {
        return Err("Invalid return items".into());
    }
    sqlx::query("ALTER TABLE return_items ADD COLUMN sale_item_id INTEGER")
        .execute(&mut **tx)
        .await
        .ok();
    sqlx::query("ALTER TABLE return_items ADD COLUMN unit TEXT")
        .execute(&mut **tx)
        .await
        .ok();
    sqlx::query("ALTER TABLE return_items ADD COLUMN drug_id INTEGER")
        .execute(&mut **tx)
        .await
        .ok();
    sqlx::query("ALTER TABLE return_items ADD COLUMN total_price REAL")
        .execute(&mut **tx)
        .await
        .ok();

    let invoice = sqlx::query("SELECT patient_id FROM sales_invoices WHERE id = ?")
        .bind(&payload.invoice_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Invoice not found".to_string())?;
    if payload.refund_method == "patient_account" {
        let invoice_patient = invoice
            .try_get::<Option<String>, _>("patient_id")
            .unwrap_or(None);
        if invoice_patient.is_none()
            || payload
                .patient_id
                .as_ref()
                .is_some_and(|id| Some(id) != invoice_patient.as_ref())
        {
            return Err("Patient-account returns require the invoice patient".into());
        }
    }

    for item in &payload.items {
        if let Some(sale_item_id) = item.sale_item_id {
            if let Some(drug) = sqlx::query(
                "SELECT md.no_return, md.trade_name FROM sales_items si LEFT JOIN master_drugs md ON si.drug_id = md.id WHERE si.id = ?",
            )
            .bind(sale_item_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            {
                let no_return: i64 = drug.try_get("no_return").unwrap_or(0);
                if no_return != 0 {
                    let name: String = drug.try_get("trade_name").unwrap_or_else(|_| item.drug_name.clone());
                    return Err(format!("Item \"{}\" cannot be returned", name));
                }
            }

            let sold = sqlx::query(
                "SELECT CAST(quantity_sold AS REAL) AS quantity_sold, unit, drug_id, inventory_id FROM sales_items WHERE id = ? AND invoice_id = ?",
            )
            .bind(sale_item_id)
            .bind(&payload.invoice_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Sale item {} not found", sale_item_id))?;
            let sold_qty: f64 = sold.try_get("quantity_sold").unwrap_or(0.0);
            let sold_unit: String = sold.try_get("unit").unwrap_or_else(|_| "large".into());
            let drug_id: Option<i64> = sold.try_get("drug_id").ok();
            let inventory_id: Option<String> = sold.try_get("inventory_id").ok();
            let returned: f64 = sqlx::query(
                "SELECT CAST(COALESCE(SUM(ri.quantity_returned), 0) AS REAL) as total FROM return_items ri JOIN returns r ON ri.return_id = r.id WHERE r.invoice_id = ? AND r.status = 'approved' AND ri.sale_item_id = ?",
            )
            .bind(&payload.invoice_id)
            .bind(sale_item_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            .try_get("total")
            .unwrap_or(0.0);
            let requested = return_quantity_in_sale_unit(
                tx,
                drug_id,
                inventory_id.as_deref(),
                item.quantity,
                item.unit.as_deref().unwrap_or("large"),
                &sold_unit,
            )
            .await?;
            if requested > sold_qty - returned + 0.005 {
                return Err(format!(
                    "Return quantity exceeds remaining quantity for {}",
                    item.drug_name
                ));
            }
        }
    }

    let return_id = uuid::Uuid::new_v4().to_string();
    let total_refund: f64 = payload
        .items
        .iter()
        .map(|item| item.quantity * item.unit_price)
        .sum();
    sqlx::query("INSERT INTO returns (id, invoice_id, user_id, shift_id, reason, total_refund, refund_method, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')")
        .bind(&return_id)
        .bind(&payload.invoice_id)
        .bind(&payload.user_id)
        .bind(&payload.shift_id)
        .bind(&payload.reason)
        .bind(total_refund)
        .bind(&payload.refund_method)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let mut total_cogs_reversal = 0.0;
    for item in &payload.items {
        let sale_item = if let Some(id) = item.sale_item_id {
            sqlx::query(
                "SELECT drug_id, CAST(cost_price AS REAL) AS cost_price, unit, inventory_id FROM sales_items WHERE id = ?",
            )
            .bind(id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
        } else {
            None
        };
        let drug_id: Option<i64> = sale_item.as_ref().and_then(|r| r.try_get("drug_id").ok());
        let cost_price: f64 = sale_item
            .as_ref()
            .and_then(|r| r.try_get("cost_price").ok())
            .unwrap_or(0.0);
        let sold_unit = sale_item
            .as_ref()
            .and_then(|r| r.try_get::<String, _>("unit").ok())
            .unwrap_or_else(|| "large".into());
        let original_inventory_id = sale_item
            .as_ref()
            .and_then(|r| r.try_get::<String, _>("inventory_id").ok())
            .or_else(|| item.inventory_id.clone());
        let inventory_id = ensure_return_inventory(
            tx,
            original_inventory_id.as_deref(),
            drug_id,
            payload.pharmacy_id.as_deref(),
            item.unit_price,
        )
        .await?;

        let unit = item.unit.as_deref().unwrap_or("large");
        let returned_in_sold_unit = return_quantity_in_sale_unit(
            tx,
            drug_id,
            Some(&inventory_id),
            item.quantity,
            unit,
            &sold_unit,
        )
        .await?;
        sqlx::query("INSERT INTO return_items (return_id, inventory_id, drug_id, drug_name, quantity_returned, unit_price, sale_item_id, unit, total_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&return_id)
            .bind(&inventory_id)
            .bind(drug_id)
            .bind(&item.drug_name)
            .bind(returned_in_sold_unit)
            .bind(item.unit_price)
            .bind(item.sale_item_id)
            .bind(unit)
            .bind(item.quantity * item.unit_price)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;

        let restock_qty =
            return_restock_qty(tx, drug_id, Some(&inventory_id), item.quantity, unit).await?;
        sqlx::query("UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(restock_qty)
            .bind(&inventory_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        total_cogs_reversal += cost_price * restock_qty;
    }

    apply_return_accounting(tx, &payload, &return_id, total_refund, total_cogs_reversal).await?;
    Ok(ReturnResult {
        return_id,
        total_refund,
    })
}

async fn save_purchase_invoice_tx(
    tx: &mut Transaction<'_, Sqlite>,
    payload: PurchasePayload,
) -> Result<PurchaseResult, String> {
    sqlx::query("ALTER TABLE purchase_invoice_items ADD COLUMN inventory_id TEXT")
        .execute(&mut **tx)
        .await
        .ok();
    sqlx::query("ALTER TABLE purchase_invoice_items ADD COLUMN barcode TEXT")
        .execute(&mut **tx)
        .await
        .ok();
    let invoice_id = payload
        .id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let status = payload.status.as_deref().unwrap_or("completed");
    let final_status = if status == "draft" {
        "draft"
    } else {
        "completed"
    };
    let payment_method = payload.payment_method.as_deref().unwrap_or("credit");
    let invoice_date = payload
        .invoice_date
        .clone()
        .unwrap_or_else(|| "DATE('now', 'localtime')".into());

    let supplier_row = sqlx::query("SELECT id FROM suppliers WHERE id = ? OR CAST(id AS TEXT) = ?")
        .bind(payload.supplier_id)
        .bind(payload.supplier_id.to_string())
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let effective_supplier_id: i64 = if let Some(row) = supplier_row {
        row.try_get("id").unwrap_or(payload.supplier_id)
    } else {
        let first_sup = sqlx::query("SELECT id FROM suppliers ORDER BY id ASC LIMIT 1")
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(fs) = first_sup {
            fs.try_get("id").unwrap_or(payload.supplier_id)
        } else {
            return Err("المورد المحدد غير موجود، يرجى اختيار المورد من القائمة".into());
        }
    };

    let user_row = sqlx::query("SELECT id FROM users WHERE id = ? OR CAST(id AS TEXT) = ?")
        .bind(&payload.user_id)
        .bind(&payload.user_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let effective_user_id: String = if let Some(row) = user_row {
        row.try_get("id")
            .unwrap_or_else(|_| payload.user_id.clone())
    } else {
        let first_usr = sqlx::query("SELECT id FROM users ORDER BY created_at ASC LIMIT 1")
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(fu) = first_usr {
            fu.try_get("id").unwrap_or_else(|_| payload.user_id.clone())
        } else {
            payload.user_id.clone()
        }
    };
    for item in &payload.cart {
        if sqlx::query("SELECT 1 FROM master_drugs WHERE id = ?")
            .bind(item.id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Err(format!(
                "Drug {} no longer exists; remove it and add it again",
                item.id
            ));
        }
    }

    let mut editing_completed = false;
    if let Some(old) = sqlx::query("SELECT supplier_id, total_amount, payment_method, status, invoice_number FROM purchase_invoices WHERE id = ?")
        .bind(&invoice_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
    {
        let old_status: String = old.try_get("status").unwrap_or_default();
        if old_status == "completed" {
            editing_completed = true;
            reverse_completed_purchase(tx, &invoice_id, &old, &payload).await?;
        }
        sqlx::query("DELETE FROM purchase_invoice_items WHERE invoice_id = ?")
            .bind(&invoice_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("DELETE FROM purchase_invoices WHERE id = ?")
            .bind(&invoice_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    sqlx::query(
        r#"
        INSERT INTO purchase_invoices
          (id, supplier_id, pharmacy_id, user_id, invoice_number, invoice_date, payment_method, notes, check_number, expenses, discount_value, discount_percent, tax_percent, status)
        VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'DATE(''now'', ''localtime'')' THEN DATE('now', 'localtime') ELSE ? END, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&invoice_id)
    .bind(effective_supplier_id)
    .bind(&payload.pharmacy_id)
    .bind(&effective_user_id)
    .bind(&payload.invoice_number)
    .bind(&invoice_date)
    .bind(&invoice_date)
    .bind(payment_method)
    .bind(&payload.notes)
    .bind(&payload.check_number)
    .bind(payload.expenses)
    .bind(payload.discount_value)
    .bind(payload.discount_percent)
    .bind(payload.tax_percent)
    .bind(final_status)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    let mut items_total = 0.0;
    for item in &payload.cart {
        let expiry = normalize_date_ymd(item.expiry_date.as_deref());
        let inserted_item = sqlx::query(
            "INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, unit_id, expiry_date, cost_price, selling_price, bonus_quantity, tax_percent, discount_percent, strips_per_box, barcode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&invoice_id)
        .bind(item.id)
        .bind(item.quantity)
        .bind(item.unit_id)
        .bind(&expiry)
        .bind(item.cost_price)
        .bind(item.selling_price)
        .bind(item.bonus_quantity)
        .bind(item.tax_percent)
        .bind(item.discount_percent)
        .bind(item.strips_per_box)
        .bind(&item.barcode)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        let purchase_item_id = inserted_item.last_insert_rowid();

        if item.strips_per_box > 0 {
            sqlx::query("UPDATE master_drugs SET large_to_medium = ? WHERE id = ?")
                .bind(item.strips_per_box)
                .bind(item.id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }

        if let Some(ref bc) = item.barcode {
            if !bc.trim().is_empty() {
                sqlx::query("UPDATE master_drugs SET barcode = ? WHERE id = ? AND (barcode IS NULL OR barcode = '')")
                    .bind(bc)
                    .bind(item.id)
                    .execute(&mut **tx)
                    .await
                    .ok();
                sqlx::query("UPDATE inventory SET barcode = ? WHERE drug_id = ? AND (barcode IS NULL OR barcode = '')")
                    .bind(bc)
                    .bind(item.id)
                    .execute(&mut **tx)
                    .await
                    .ok();
            }
        }

        let item_total = purchase_item_total(item, payload.tax_percent);
        items_total += item_total;

        if final_status == "completed" && !editing_completed {
            let total_received = item.quantity + item.bonus_quantity;
            let net_unit_cost = if total_received > 0.0 {
                item_total / total_received
            } else {
                item.cost_price
            };
            add_purchase_inventory(
                tx,
                item.id,
                payload.pharmacy_id.as_deref(),
                total_received,
                item.selling_price.unwrap_or(0.0),
                net_unit_cost,
                expiry.as_deref(),
                payload
                    .invoice_number
                    .as_deref()
                    .unwrap_or(&format!("BATCH-{}", &invoice_id[..8])),
                item.strips_per_box,
            )
            .await?;
        }

        if final_status == "completed" {
            let inventory_id = find_inventory_for_batch(
                tx,
                item.id,
                payload.pharmacy_id.as_deref(),
                expiry.as_deref(),
            )
            .await?
            .ok_or_else(|| format!("Inventory link missing for drug {}", item.id))?;
            sqlx::query("UPDATE purchase_invoice_items SET inventory_id = ? WHERE id = ?")
                .bind(inventory_id)
                .bind(purchase_item_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    let invoice_discount_pct = (items_total + payload.expenses - payload.discount_value)
        * (payload.discount_percent / 100.0);
    let final_total = if final_status == "completed" {
        items_total + payload.expenses - payload.discount_value - invoice_discount_pct
    } else {
        0.0
    };

    sqlx::query("UPDATE purchase_invoices SET total_amount = ? WHERE id = ?")
        .bind(final_total)
        .bind(&invoice_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    if final_status == "completed" {
        apply_purchase_accounting(tx, &payload, &invoice_id, final_total, payment_method).await?;
    }

    Ok(PurchaseResult {
        id: invoice_id,
        total_amount: final_total,
    })
}

fn checkout_total(items: &[CheckoutItem], discount: f64, additional_fees: f64) -> f64 {
    items
        .iter()
        .map(|item| item.unit_price * item.quantity_sold)
        .sum::<f64>()
        + additional_fees
        - discount
}

async fn patient_outstanding_debt(
    tx: &mut Transaction<'_, Sqlite>,
    patient_id: &str,
) -> Result<f64, String> {
    let row = sqlx::query(
        r#"
        SELECT CAST(
          (SELECT COALESCE(CAST(opening_balance AS REAL), 0) FROM patients WHERE id = ?) +
          (SELECT COALESCE(SUM(CAST(total_amount AS REAL)), 0) FROM sales_invoices WHERE patient_id = ? AND payment_method = 'credit' AND status = 'completed') -
          (SELECT COALESCE(SUM(CAST(r.total_refund AS REAL)), 0) FROM returns r JOIN sales_invoices si ON r.invoice_id = si.id WHERE si.patient_id = ? AND (r.status = 'approved' OR r.status = 'completed') AND r.refund_method = 'patient_account') -
          (SELECT COALESCE(SUM(ABS(CAST(amount AS REAL))), 0) FROM patient_transactions WHERE patient_id = ? AND type = 'payment') +
          (SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) FROM patient_transactions WHERE patient_id = ? AND type = 'adjustment')
        AS REAL) AS outstanding_balance
        "#,
    )
    .bind(patient_id)
    .bind(patient_id)
    .bind(patient_id)
    .bind(patient_id)
    .bind(patient_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.try_get("outstanding_balance").unwrap_or(0.0))
}

fn sale_stock_qty(
    quantity: f64,
    unit: &str,
    large_to_medium: f64,
    medium_to_small: f64,
    medium_unit: Option<&str>,
    small_unit: Option<&str>,
) -> f64 {
    if unit == "medium"
        || unit == "strip"
        || unit == "\u{0634}\u{0631}\u{064a}\u{0637}"
        || medium_unit == Some(unit)
    {
        quantity / large_to_medium
    } else if unit == "small" || small_unit == Some(unit) {
        quantity / (large_to_medium * medium_to_small)
    } else {
        quantity
    }
}

async fn process_checkout_tx(
    tx: &mut Transaction<'_, Sqlite>,
    payload: CheckoutPayload,
    total_amount: f64,
) -> Result<CheckoutResult, String> {
    let sale_id = uuid::Uuid::new_v4().to_string();
    let mut points_earned = 0_i64;

    let mut patient_loyalty_level: Option<String> = None;
    if payload.status == "completed" {
        if let Some(patient_id) = &payload.patient_id {
            if let Some(patient) = sqlx::query(
                "SELECT CAST(COALESCE(credit_limit, 0) AS REAL) AS credit_limit, CAST(COALESCE(wallet_balance, 0) AS REAL) AS wallet_balance, loyalty_level FROM patients WHERE id = ?",
            )
            .bind(patient_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            {
                let credit_limit: f64 = patient.try_get("credit_limit").unwrap_or(0.0);
                let wallet_balance: f64 = patient.try_get("wallet_balance").unwrap_or(0.0);
                patient_loyalty_level = patient.try_get("loyalty_level").ok();

                if payload.payment_method == "credit" {
                    let current_debt = patient_outstanding_debt(tx, patient_id).await?;
                    if current_debt + total_amount > credit_limit {
                        return Err("Credit limit exceeded".into());
                    }
                }

                if payload.payment_method == "wallet" && total_amount > wallet_balance {
                    return Err("Insufficient wallet balance".into());
                }
            }
        }
    }

    sqlx::query(
        r#"
        INSERT INTO sales_invoices
          (id, pharmacy_id, user_id, patient_id, shift_id, total_amount, payment_method, check_number, status, discount_amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(&sale_id)
    .bind(&payload.pharmacy_id)
    .bind(&payload.user_id)
    .bind(&payload.patient_id)
    .bind(&payload.shift_id)
    .bind(total_amount)
    .bind(&payload.payment_method)
    .bind(&payload.check_number)
    .bind(&payload.status)
    .bind(payload.total_discount)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    let mut total_cogs = 0.0_f64;
    for item in &payload.items {
        let drug = sqlx::query(
            r#"
            SELECT md.trade_name, md.large_to_medium, md.medium_to_small, md.medium_unit, md.small_unit,
                   COALESCE(MAX(i.strips_per_box), 1) as max_strips
            FROM master_drugs md
            LEFT JOIN inventory i ON i.drug_id = md.id
            WHERE md.id = ?
            GROUP BY md.id
            "#,
        )
        .bind(item.drug_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

        let drug_name = drug
            .as_ref()
            .and_then(|r| r.try_get::<String, _>("trade_name").ok())
            .unwrap_or_else(|| format!("Drug #{}", item.drug_id));
        let large_to_medium = drug
            .as_ref()
            .and_then(|r| r.try_get::<i64, _>("large_to_medium").ok())
            .unwrap_or(1)
            .max(1) as f64;
        let medium_to_small = drug
            .as_ref()
            .and_then(|r| r.try_get::<i64, _>("medium_to_small").ok())
            .unwrap_or(1)
            .max(1) as f64;
        let max_strips = drug
            .as_ref()
            .and_then(|r| r.try_get::<i64, _>("max_strips").ok())
            .unwrap_or(1)
            .max(1) as f64;
        let medium_unit = drug
            .as_ref()
            .and_then(|r| r.try_get::<String, _>("medium_unit").ok());
        let small_unit = drug
            .as_ref()
            .and_then(|r| r.try_get::<String, _>("small_unit").ok());

        let actual_large_to_medium = if max_strips > 1.0 {
            max_strips
        } else {
            large_to_medium
        };
        let deduction_qty = sale_stock_qty(
            item.quantity_sold,
            &item.selected_unit,
            actual_large_to_medium,
            medium_to_small,
            medium_unit.as_deref(),
            small_unit.as_deref(),
        );

        if payload.status != "completed" {
            insert_sale_item(
                tx,
                &sale_id,
                None,
                item,
                item.quantity_sold,
                item.is_negative,
                0.0,
            )
            .await?;
            continue;
        }

        if item.is_negative {
            insert_sale_item(tx, &sale_id, None, item, item.quantity_sold, true, 0.0).await?;
            continue;
        }

        let selected_inventory_id = if let Some(inventory_id) = &item.inventory_id {
            let selected_stock: f64 = sqlx::query(
                "SELECT CAST(COALESCE(SUM(quantity), 0) AS REAL) as total FROM inventory WHERE id = ?",
            )
            .bind(inventory_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            .try_get("total")
            .unwrap_or(0.0);
            if selected_stock + 0.005 >= deduction_qty {
                Some(inventory_id.as_str())
            } else {
                None
            }
        } else {
            None
        };

        let stock_total: f64 = if let Some(inventory_id) = selected_inventory_id {
            sqlx::query("SELECT CAST(COALESCE(SUM(quantity), 0) AS REAL) as total FROM inventory WHERE id = ?")
                .bind(inventory_id)
                .fetch_one(&mut **tx)
                .await
                .map_err(|e| e.to_string())?
                .try_get("total")
                .unwrap_or(0.0)
        } else {
            sqlx::query(
                "SELECT CAST(COALESCE(SUM(quantity), 0) AS REAL) as total FROM inventory WHERE drug_id = ? AND (expiry_date IS NULL OR expiry_date >= DATE('now', 'localtime'))",
            )
            .bind(item.drug_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            .try_get("total")
            .unwrap_or(0.0)
        };
        if stock_total + 0.005 < deduction_qty {
            return Err(format!(
                "Insufficient stock for \"{}\" (available: {:.2})",
                drug_name, stock_total
            ));
        }

        let batches = if let Some(inventory_id) = selected_inventory_id {
            sqlx::query("SELECT id, CAST(quantity AS REAL) as quantity, cost_price FROM inventory WHERE id = ?")
                .bind(inventory_id)
                .fetch_all(&mut **tx)
                .await
                .map_err(|e| e.to_string())?
        } else {
            sqlx::query(
                r#"
                SELECT id, CAST(quantity AS REAL) as quantity, cost_price
                FROM inventory
                WHERE drug_id = ? AND quantity > 0 AND (expiry_date IS NULL OR expiry_date >= DATE('now', 'localtime'))
                ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, created_at ASC
                "#,
            )
            .bind(item.drug_id)
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
        };

        let mut remaining = deduction_qty;
        for batch in batches {
            if remaining <= 0.0001 {
                break;
            }
            let batch_id: String = batch.try_get("id").map_err(|e| e.to_string())?;
            let batch_qty: f64 = batch.try_get("quantity").unwrap_or(0.0);
            let cost_price: f64 = batch.try_get("cost_price").unwrap_or(0.0);
            let deduct = if batch_qty + 0.005 >= remaining {
                remaining.min(batch_qty)
            } else {
                batch_qty
            };
            let batch_prop = deduct / deduction_qty;
            let quantity_in_selected_unit = item.quantity_sold * batch_prop;

            sqlx::query("UPDATE inventory SET quantity = CASE WHEN quantity - ? < 0.0001 THEN 0 ELSE quantity - ? END, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(deduct)
                .bind(deduct)
                .bind(&batch_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
            insert_sale_item(
                tx,
                &sale_id,
                Some(&batch_id),
                item,
                quantity_in_selected_unit,
                false,
                cost_price,
            )
            .await?;

            total_cogs += cost_price * deduct;
            remaining -= deduct;
        }
    }

    if payload.status == "completed" {
        let journal_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, DATE('now', 'localtime'), ?, ?, ?)",
        )
        .bind(&journal_id)
        .bind(format!("Sales invoice {}", &sale_id[..8]))
        .bind(&payload.user_id)
        .bind(total_amount + total_cogs)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

        let cash = account_id(tx, "cash_drawer", 6).await?;
        let receivable = account_id(tx, "accounts_receivable", 8).await?;
        let sales = account_id(tx, "sales_revenue", 9).await?;
        let inventory = account_id(tx, "inventory_asset", 10).await?;
        let cogs = account_id(tx, "cogs_expense", 11).await?;
        let debit = match payload.payment_method.as_str() {
            "credit" => receivable,
            "wallet" => account_id(tx, "patient_wallet_liability", 0).await?,
            _ => cash,
        };

        insert_journal_entry(tx, &journal_id, debit, "debit", total_amount).await?;
        insert_journal_entry(tx, &journal_id, sales, "credit", total_amount).await?;
        if payload.payment_method == "wallet" {
            if let Some(patient_id) = &payload.patient_id {
                sqlx::query("UPDATE patients SET wallet_balance = wallet_balance - ? WHERE id = ?")
                    .bind(total_amount)
                    .bind(patient_id)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        if total_cogs > 0.0 {
            insert_journal_entry(tx, &journal_id, cogs, "debit", total_cogs).await?;
            insert_journal_entry(tx, &journal_id, inventory, "credit", total_cogs).await?;
        }
    }

    if payload.status == "completed" {
        if let Some(patient_id) = &payload.patient_id {
            for item in &payload.items {
                let days = match item.selected_unit.as_str() {
                    "large" => 30.0,
                    "medium" => 10.0,
                    _ => 3.0,
                };
                let refill_id = uuid::Uuid::new_v4().to_string();
                let modifier = format!("+{} days", (days * item.quantity_sold).round() as i64);
                sqlx::query(
                    "INSERT INTO refill_reminders (id, patient_id, drug_id, last_sold_date, next_refill_date, created_at) VALUES (?, ?, ?, DATE('now', 'localtime'), DATE('now', 'localtime', ?), CURRENT_TIMESTAMP)",
                )
                .bind(refill_id)
                .bind(patient_id)
                .bind(item.drug_id)
                .bind(modifier)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
            }

            points_earned = loyalty_points(total_amount, patient_loyalty_level.as_deref());
            if points_earned > 0 {
                sqlx::query("UPDATE patients SET points_balance = COALESCE(points_balance, 0) + ? WHERE id = ?")
                    .bind(points_earned)
                    .bind(patient_id)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(CheckoutResult {
        sale_id,
        total_amount,
        points_earned,
    })
}

fn one_i64() -> i64 {
    1
}

fn de_f64<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => 0.0,
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) if s.trim().is_empty() => 0.0,
        Value::String(s) => s.trim().parse::<f64>().map_err(de::Error::custom)?,
        other => return Err(de::Error::custom(format!("expected number, got {other}"))),
    })
}

fn de_opt_f64<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => None,
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => None,
        Value::String(s) => Some(s.trim().parse::<f64>().map_err(de::Error::custom)?),
        other => {
            return Err(de::Error::custom(format!(
                "expected optional number, got {other}"
            )))
        }
    })
}

fn de_i64<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => 0,
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_u64().map(|v| v as i64))
            .or_else(|| n.as_f64().map(|v| v as i64))
            .unwrap_or(0),
        Value::String(s) if s.trim().is_empty() => 0,
        Value::String(s) => parse_i64_lossless(s.trim()).map_err(de::Error::custom)?,
        other => return Err(de::Error::custom(format!("expected integer, got {other}"))),
    })
}

fn de_opt_i64<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => None,
        Value::Number(n) => n
            .as_i64()
            .or_else(|| n.as_u64().map(|v| v as i64))
            .or_else(|| n.as_f64().map(|v| v as i64)),
        Value::String(s) if s.trim().is_empty() => None,
        Value::String(s) => Some(parse_i64_lossless(s.trim()).map_err(de::Error::custom)?),
        other => {
            return Err(de::Error::custom(format!(
                "expected optional integer, got {other}"
            )))
        }
    })
}

fn de_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => String::new(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s,
        Value::Bool(b) => b.to_string(),
        other => return Err(de::Error::custom(format!("expected string, got {other}"))),
    })
}

fn de_opt_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::Null => None,
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if s.trim().is_empty() => None,
        Value::String(s) => Some(s),
        Value::Bool(b) => Some(b.to_string()),
        other => {
            return Err(de::Error::custom(format!(
                "expected optional string, got {other}"
            )))
        }
    })
}

fn parse_i64_lossless(value: &str) -> Result<i64, String> {
    if let Ok(parsed) = value.parse::<i64>() {
        return Ok(parsed);
    }
    let parsed = value.parse::<f64>().map_err(|e| e.to_string())?;
    if parsed.fract() != 0.0 {
        return Err(format!("expected whole number, got {value}"));
    }
    Ok(parsed as i64)
}

fn normalize_date_ymd(input: Option<&str>) -> Option<String> {
    let value = input?.trim();
    if value.is_empty() {
        return None;
    }
    let parts: Vec<&str> = value.split(&['/', '-'][..]).collect();
    if parts.len() == 3 && parts[0].len() <= 2 && parts[2].len() == 4 {
        return Some(format!("{}-{:0>2}-{:0>2}", parts[2], parts[1], parts[0]));
    }
    Some(value.to_string())
}

fn purchase_item_total(item: &PurchaseItem, invoice_tax_percent: f64) -> f64 {
    item.quantity
        * item.cost_price
        * (1.0 + item.tax_percent / 100.0)
        * (1.0 + invoice_tax_percent / 100.0)
}

async fn add_purchase_inventory(
    tx: &mut Transaction<'_, Sqlite>,
    drug_id: i64,
    pharmacy_id: Option<&str>,
    quantity: f64,
    selling_price: f64,
    cost_price: f64,
    expiry_date: Option<&str>,
    batch_number: &str,
    strips_per_box: i64,
) -> Result<(), String> {
    if let Some(id) = find_inventory_for_batch(tx, drug_id, pharmacy_id, expiry_date).await? {
        sqlx::query(
            "UPDATE inventory SET quantity = quantity + ?, pharmacy_id = COALESCE(pharmacy_id, ?), local_selling_price = ?, cost_price = ?, expiry_date = ?, batch_number = ?, strips_per_box = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(quantity)
        .bind(pharmacy_id)
        .bind(selling_price)
        .bind(cost_price)
        .bind(expiry_date)
        .bind(batch_number)
        .bind(strips_per_box)
        .bind(&id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        consolidate_inventory_rows(tx, drug_id, expiry_date, &id).await?;
    } else {
        sqlx::query(
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price, expiry_date, batch_number, strips_per_box, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(drug_id)
        .bind(pharmacy_id)
        .bind(quantity)
        .bind(selling_price)
        .bind(cost_price)
        .bind(expiry_date)
        .bind(batch_number)
        .bind(strips_per_box)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn find_inventory_for_batch(
    tx: &mut Transaction<'_, Sqlite>,
    drug_id: i64,
    pharmacy_id: Option<&str>,
    expiry_date: Option<&str>,
) -> Result<Option<String>, String> {
    let row = sqlx::query(
        "SELECT id FROM inventory WHERE drug_id = ? AND (expiry_date = ? OR (expiry_date IS NULL AND ? IS NULL)) ORDER BY CASE WHEN pharmacy_id = ? THEN 0 WHEN pharmacy_id IS NULL THEN 1 ELSE 2 END, created_at ASC LIMIT 1",
    )
    .bind(drug_id)
    .bind(expiry_date)
    .bind(expiry_date)
    .bind(pharmacy_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    row.map(|r| r.try_get("id").map_err(|e| e.to_string()))
        .transpose()
}

async fn find_inventory_for_drug(
    tx: &mut Transaction<'_, Sqlite>,
    drug_id: i64,
    pharmacy_id: Option<&str>,
) -> Result<Option<String>, String> {
    let row = sqlx::query(
        "SELECT id FROM inventory WHERE drug_id = ? ORDER BY CASE WHEN pharmacy_id = ? THEN 0 WHEN pharmacy_id IS NULL THEN 1 ELSE 2 END, created_at ASC LIMIT 1",
    )
    .bind(drug_id)
    .bind(pharmacy_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    row.map(|r| r.try_get("id").map_err(|e| e.to_string()))
        .transpose()
}

async fn consolidate_inventory_rows(
    tx: &mut Transaction<'_, Sqlite>,
    drug_id: i64,
    expiry_date: Option<&str>,
    keep_id: &str,
) -> Result<(), String> {
    let extra: f64 = sqlx::query(
        "SELECT CAST(COALESCE(SUM(quantity), 0) AS REAL) as total FROM inventory WHERE drug_id = ? AND id <> ? AND (expiry_date = ? OR (expiry_date IS NULL AND ? IS NULL))",
    )
    .bind(drug_id)
    .bind(keep_id)
    .bind(expiry_date)
    .bind(expiry_date)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .try_get("total")
    .unwrap_or(0.0);

    if extra != 0.0 {
        sqlx::query("UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(extra)
            .bind(keep_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("UPDATE inventory SET quantity = 0, updated_at = CURRENT_TIMESTAMP WHERE drug_id = ? AND id <> ? AND (expiry_date = ? OR (expiry_date IS NULL AND ? IS NULL))")
            .bind(drug_id)
            .bind(keep_id)
            .bind(expiry_date)
            .bind(expiry_date)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

async fn reverse_completed_purchase(
    tx: &mut Transaction<'_, Sqlite>,
    invoice_id: &str,
    old_invoice: &sqlx::sqlite::SqliteRow,
    payload: &PurchasePayload,
) -> Result<(), String> {
    let old_items = sqlx::query(
        "SELECT drug_id, CAST(quantity AS REAL) as quantity, CAST(COALESCE(bonus_quantity, 0) AS REAL) as bonus_quantity, expiry_date FROM purchase_invoice_items WHERE invoice_id = ?",
    )
    .bind(invoice_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    let pharmacy_id = payload.pharmacy_id.as_deref();
    let batch_number = payload
        .invoice_number
        .as_deref()
        .unwrap_or(&invoice_id[..invoice_id.len().min(8)]);

    for item in &old_items {
        let drug_id: i64 = item.try_get("drug_id").map_err(|e| e.to_string())?;
        let old_qty: f64 = item.try_get("quantity").map_err(|e| e.to_string())?;
        let old_bonus: f64 = item.try_get("bonus_quantity").map_err(|e| e.to_string())?;
        let old_qty = old_qty + old_bonus;
        let old_expiry_raw: Option<String> = item.try_get("expiry_date").unwrap_or(None);
        let old_expiry = normalize_date_ymd(old_expiry_raw.as_deref());
        let new_item = payload
            .cart
            .iter()
            .find(|candidate| candidate.id == drug_id);
        let new_qty = new_item
            .map(|new_item| new_item.quantity + new_item.bonus_quantity)
            .unwrap_or(0.0);

        let exact_id =
            find_inventory_for_batch(tx, drug_id, pharmacy_id, old_expiry.as_deref()).await?;
        let inv_id = if let Some(id) = exact_id {
            consolidate_inventory_rows(tx, drug_id, old_expiry.as_deref(), &id).await?;
            id
        } else {
            find_inventory_for_drug(tx, drug_id, pharmacy_id)
                .await?
                .ok_or_else(|| format!("Inventory row missing for drug {}", drug_id))?
        };
        let inv =
            sqlx::query("SELECT CAST(quantity AS REAL) as quantity FROM inventory WHERE id = ?")
                .bind(&inv_id)
                .fetch_one(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        let inv_qty: f64 = inv.try_get("quantity").map_err(|e| e.to_string())?;
        let new_expiry = new_item.and_then(|item| normalize_date_ymd(item.expiry_date.as_deref()));
        let same_expiry = new_item.is_some() && new_expiry == old_expiry;
        let amount_to_remove = if same_expiry {
            (old_qty - new_qty).max(0.0)
        } else {
            old_qty
        };
        if inv_qty < amount_to_remove {
            return Err(format!(
                "Cannot edit purchase; drug {} stock has already been sold",
                drug_id
            ));
        }
        if let Some(new_item) = new_item {
            let net_unit_cost = if new_qty > 0.0 {
                purchase_item_total(new_item, payload.tax_percent) / new_qty
            } else {
                new_item.cost_price
            };
            if same_expiry {
                sqlx::query("UPDATE inventory SET quantity = quantity + ?, local_selling_price = ?, cost_price = ?, batch_number = ?, strips_per_box = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                    .bind(new_qty - old_qty)
                    .bind(new_item.selling_price.unwrap_or(0.0))
                    .bind(net_unit_cost)
                    .bind(batch_number)
                    .bind(new_item.strips_per_box)
                    .bind(inv_id)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| e.to_string())?;
            } else {
                sqlx::query("UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                    .bind(old_qty)
                    .bind(inv_id)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| e.to_string())?;
                add_purchase_inventory(
                    tx,
                    drug_id,
                    pharmacy_id,
                    new_qty,
                    new_item.selling_price.unwrap_or(0.0),
                    net_unit_cost,
                    new_expiry.as_deref(),
                    batch_number,
                    new_item.strips_per_box,
                )
                .await?;
            }
        } else {
            sqlx::query("UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(old_qty)
                .bind(inv_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    for new_item in payload.cart.iter().filter(|new_item| {
        !old_items
            .iter()
            .any(|old| old.try_get::<i64, _>("drug_id").ok() == Some(new_item.id))
    }) {
        let total_received = new_item.quantity + new_item.bonus_quantity;
        let net_unit_cost = if total_received > 0.0 {
            purchase_item_total(new_item, payload.tax_percent) / total_received
        } else {
            new_item.cost_price
        };
        let expiry = normalize_date_ymd(new_item.expiry_date.as_deref());
        add_purchase_inventory(
            tx,
            new_item.id,
            pharmacy_id,
            total_received,
            new_item.selling_price.unwrap_or(0.0),
            net_unit_cost,
            expiry.as_deref(),
            batch_number,
            new_item.strips_per_box,
        )
        .await?;
    }

    reverse_purchase_accounting(tx, invoice_id, old_invoice).await
}

async fn reverse_purchase_accounting(
    tx: &mut Transaction<'_, Sqlite>,
    invoice_id: &str,
    old_invoice: &sqlx::sqlite::SqliteRow,
) -> Result<(), String> {
    let old_total: f64 = old_invoice.try_get("total_amount").unwrap_or(0.0);
    let old_supplier_id: i64 = old_invoice.try_get("supplier_id").unwrap_or(0);
    let old_payment: String = old_invoice.try_get("payment_method").unwrap_or_default();
    if old_payment == "credit" || old_payment == "check" {
        sqlx::query("UPDATE suppliers SET balance = balance - ? WHERE id = ?")
            .bind(old_total)
            .bind(old_supplier_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    sqlx::query("DELETE FROM supplier_transactions WHERE reference_id = ?")
        .bind(invoice_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let invoice_number: Option<String> = old_invoice.try_get("invoice_number").ok();
    let invoice_prefix = &invoice_id[..invoice_id.len().min(8)];
    let mut markers = vec![invoice_prefix.to_string(), invoice_id.to_string()];
    if let Some(number) = invoice_number.filter(|v| !v.trim().is_empty()) {
        markers.push(number);
    }

    for marker in markers {
        let desc = format!("Purchase invoice {}", marker);
        let journals = sqlx::query("SELECT id FROM daily_journals WHERE description = ?")
            .bind(&desc)
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        for journal in journals {
            let journal_id: String = journal.try_get("id").map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM journal_entries WHERE journal_id = ?")
                .bind(&journal_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
            sqlx::query("DELETE FROM daily_journals WHERE id = ?")
                .bind(journal_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        sqlx::query("DELETE FROM cash_movements WHERE category = 'purchases' AND notes = ?")
            .bind(desc)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn delete_purchase_invoice_tx(
    tx: &mut Transaction<'_, Sqlite>,
    invoice_id: &str,
    remove_inventory: bool,
) -> Result<(), String> {
    let invoice = sqlx::query("SELECT supplier_id, total_amount, payment_method, status, invoice_number, pharmacy_id FROM purchase_invoices WHERE id = ?")
        .bind(invoice_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Purchase invoice not found".to_string())?;

    if sqlx::query("SELECT 1 FROM purchase_returns WHERE purchase_invoice_id = ? LIMIT 1")
        .bind(invoice_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("Delete the linked purchase returns before deleting this invoice".into());
    }

    let status: String = invoice.try_get("status").unwrap_or_default();
    if status == "completed" && remove_inventory {
        let pharmacy_id: Option<String> = invoice.try_get("pharmacy_id").unwrap_or(None);
        let items = sqlx::query("SELECT drug_id, CAST(quantity + COALESCE(bonus_quantity, 0) AS REAL) AS quantity, expiry_date, inventory_id FROM purchase_invoice_items WHERE invoice_id = ?")
            .bind(invoice_id)
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;

        for item in items {
            let drug_id: i64 = item.try_get("drug_id").map_err(|e| e.to_string())?;
            let quantity: f64 = item.try_get("quantity").map_err(|e| e.to_string())?;
            let linked_id: Option<String> = item.try_get("inventory_id").unwrap_or(None);
            let expiry: Option<String> = item.try_get("expiry_date").unwrap_or(None);
            let inventory_id = match linked_id {
                Some(id) => id,
                None => {
                    find_inventory_for_batch(tx, drug_id, pharmacy_id.as_deref(), expiry.as_deref())
                        .await?
                        .ok_or_else(|| format!("Inventory row missing for drug {}", drug_id))?
                }
            };
            let available: f64 = sqlx::query(
                "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE id = ?",
            )
            .bind(&inventory_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Linked inventory row missing for drug {}", drug_id))?
            .try_get("quantity")
            .map_err(|e| e.to_string())?;
            if available + 0.000001 < quantity {
                return Err(format!(
                    "Cannot remove invoice stock for drug {}; part of it has already been sold",
                    drug_id
                ));
            }
            sqlx::query("UPDATE inventory SET quantity = MAX(0, quantity - ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(quantity)
                .bind(inventory_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    if status == "completed" {
        reverse_purchase_accounting(tx, invoice_id, &invoice).await?;
    }
    sqlx::query("DELETE FROM purchase_invoice_items WHERE invoice_id = ?")
        .bind(invoice_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM purchase_invoices WHERE id = ?")
        .bind(invoice_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn apply_purchase_accounting(
    tx: &mut Transaction<'_, Sqlite>,
    payload: &PurchasePayload,
    invoice_id: &str,
    total_amount: f64,
    payment_method: &str,
) -> Result<(), String> {
    let journal_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, COALESCE(?, DATE('now', 'localtime')), ?, ?, ?)")
        .bind(&journal_id)
        .bind(&payload.invoice_date)
        .bind(format!("Purchase invoice {}", payload.invoice_number.as_deref().unwrap_or(&invoice_id[..8])))
        .bind(&payload.user_id)
        .bind(total_amount)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let cash = account_id(tx, "cash_drawer", 6).await?;
    let payable = account_id(tx, "accounts_payable", 7).await?;
    let inventory = account_id(tx, "inventory_asset", 10).await?;
    insert_journal_entry(tx, &journal_id, inventory, "debit", total_amount).await?;

    if payment_method == "credit" || payment_method == "check" {
        sqlx::query("UPDATE suppliers SET balance = balance + ? WHERE id = ?")
            .bind(total_amount)
            .bind(payload.supplier_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, 'invoice', ?, ?, ?)")
            .bind(payload.supplier_id)
            .bind(total_amount)
            .bind(invoice_id)
            .bind(format!("Purchase invoice {}", payload.invoice_number.as_deref().unwrap_or(invoice_id)))
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        insert_journal_entry(tx, &journal_id, payable, "credit", total_amount).await?;
    } else {
        insert_journal_entry(tx, &journal_id, cash, "credit", total_amount).await?;
        if let Some(open_shift) =
            sqlx::query("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'")
                .bind(&payload.user_id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|e| e.to_string())?
        {
            let shift_id: String = open_shift.try_get("id").map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO cash_movements (id, user_id, shift_id, type, amount, category, notes, date) VALUES (?, ?, ?, 'disbursement', ?, 'purchases', ?, DATE('now', 'localtime'))")
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(&payload.user_id)
                .bind(shift_id)
                .bind(total_amount)
                .bind(format!("Purchase invoice {}", payload.invoice_number.as_deref().unwrap_or(invoice_id)))
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

async fn ensure_return_inventory(
    tx: &mut Transaction<'_, Sqlite>,
    inventory_id: Option<&str>,
    drug_id: Option<i64>,
    pharmacy_id: Option<&str>,
    unit_price: f64,
) -> Result<String, String> {
    if let Some(id) = inventory_id {
        if sqlx::query("SELECT 1 FROM inventory WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Ok(id.to_string());
        }
    }
    let drug_id = drug_id.ok_or_else(|| "Return item is missing drug id".to_string())?;

    if let Some(row) = sqlx::query("SELECT id FROM inventory WHERE drug_id = ? LIMIT 1")
        .bind(drug_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
    {
        if let Ok(existing_id) = row.try_get::<String, _>("id") {
            return Ok(existing_id);
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let batch = format!("RET-{}", &id[..8]);
    sqlx::query("INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, expiry_date, quantity, unit_price, cost_price, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
        .bind(&id)
        .bind(pharmacy_id)
        .bind(drug_id)
        .bind(batch)
        .bind(unit_price)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    Ok(id)
}

async fn return_restock_qty(
    tx: &mut Transaction<'_, Sqlite>,
    drug_id: Option<i64>,
    inventory_id: Option<&str>,
    quantity: f64,
    unit: &str,
) -> Result<f64, String> {
    let Some(drug_id) = drug_id else {
        return Ok(quantity);
    };
    let row = sqlx::query("SELECT COALESCE(NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium, md.medium_to_small FROM master_drugs md LEFT JOIN inventory i ON i.id = ? WHERE md.id = ?")
        .bind(inventory_id)
        .bind(drug_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    let large_to_medium = row
        .as_ref()
        .and_then(|r| r.try_get::<i64, _>("large_to_medium").ok())
        .unwrap_or(1)
        .max(1) as f64;
    let medium_to_small = row
        .as_ref()
        .and_then(|r| r.try_get::<i64, _>("medium_to_small").ok())
        .unwrap_or(1)
        .max(1) as f64;
    Ok(match unit {
        "medium" | "شريط" => quantity / large_to_medium,
        "small" => quantity / (large_to_medium * medium_to_small),
        _ => quantity,
    })
}

async fn return_quantity_in_sale_unit(
    tx: &mut Transaction<'_, Sqlite>,
    drug_id: Option<i64>,
    inventory_id: Option<&str>,
    quantity: f64,
    return_unit: &str,
    sale_unit: &str,
) -> Result<f64, String> {
    let large_qty = return_restock_qty(tx, drug_id, inventory_id, quantity, return_unit).await?;
    let Some(drug_id) = drug_id else {
        return Ok(large_qty);
    };
    let row = sqlx::query("SELECT COALESCE(NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium, md.medium_to_small FROM master_drugs md LEFT JOIN inventory i ON i.id = ? WHERE md.id = ?")
        .bind(inventory_id)
        .bind(drug_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    let large_to_medium = row
        .as_ref()
        .and_then(|r| r.try_get::<i64, _>("large_to_medium").ok())
        .unwrap_or(1)
        .max(1) as f64;
    let medium_to_small = row
        .as_ref()
        .and_then(|r| r.try_get::<i64, _>("medium_to_small").ok())
        .unwrap_or(1)
        .max(1) as f64;
    Ok(match sale_unit {
        "medium" | "شريط" => large_qty * large_to_medium,
        "small" => large_qty * large_to_medium * medium_to_small,
        _ => large_qty,
    })
}

async fn apply_return_accounting(
    tx: &mut Transaction<'_, Sqlite>,
    payload: &ReturnPayload,
    return_id: &str,
    total_refund: f64,
    total_cogs_reversal: f64,
) -> Result<(), String> {
    let journal_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, DATE('now', 'localtime'), ?, ?, ?)")
        .bind(&journal_id)
        .bind(format!("Sales return {}", &payload.invoice_id[..payload.invoice_id.len().min(8)]))
        .bind(&payload.user_id)
        .bind(total_refund + total_cogs_reversal)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let cash = account_id(tx, "cash_drawer", 6).await?;
    let receivable = account_id(tx, "accounts_receivable", 8).await?;
    let sales = account_id(tx, "sales_revenue", 9).await?;
    let inventory = account_id(tx, "inventory_asset", 10).await?;
    let cogs = account_id(tx, "cogs_expense", 11).await?;
    let credit_account = if payload.refund_method == "patient_account" {
        receivable
    } else {
        cash
    };

    insert_journal_entry(tx, &journal_id, sales, "debit", total_refund).await?;
    insert_journal_entry(tx, &journal_id, credit_account, "credit", total_refund).await?;
    if total_cogs_reversal > 0.0 {
        insert_journal_entry(tx, &journal_id, inventory, "debit", total_cogs_reversal).await?;
        insert_journal_entry(tx, &journal_id, cogs, "credit", total_cogs_reversal).await?;
    }

    sqlx::query(
        "INSERT INTO activity_log (user_id, action, details) VALUES (?, 'CREATE_RETURN', ?)",
    )
    .bind(&payload.user_id)
    .bind(format!("Return {} value {}", return_id, total_refund))
    .execute(&mut **tx)
    .await
    .ok();
    Ok(())
}

async fn insert_sale_item(
    tx: &mut Transaction<'_, Sqlite>,
    sale_id: &str,
    inventory_id: Option<&str>,
    item: &CheckoutItem,
    quantity_sold: f64,
    is_negative: bool,
    cost_price: f64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, is_negative, cost_price, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    )
    .bind(sale_id)
    .bind(inventory_id)
    .bind(item.drug_id)
    .bind(quantity_sold)
    .bind(item.unit_price)
    .bind(&item.selected_unit)
    .bind(if is_negative { 1 } else { 0 })
    .bind(cost_price)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn account_id(
    tx: &mut Transaction<'_, Sqlite>,
    category: &str,
    fallback: i64,
) -> Result<i64, String> {
    let row = sqlx::query("SELECT a.id FROM trial_balance_settings t JOIN accounts a ON a.id = t.account_id WHERE t.category = ? LIMIT 1")
        .bind(category)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(id) = row.and_then(|r| r.try_get::<i64, _>("id").ok()) {
        return Ok(id);
    }
    sqlx::query("SELECT id FROM accounts WHERE id = ?")
        .bind(fallback)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .and_then(|r| r.try_get::<i64, _>("id").ok())
        .ok_or_else(|| {
            format!(
                "Accounting setup is missing '{}'; restart after installing the update",
                category
            )
        })
}

async fn insert_journal_entry(
    tx: &mut Transaction<'_, Sqlite>,
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
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn loyalty_points(total_amount: f64, loyalty_level: Option<&str>) -> i64 {
    let multiplier = match loyalty_level {
        Some("platinum") => 2.0,
        Some("gold") => 1.5,
        Some("silver") => 1.2,
        _ => 1.0,
    };
    (total_amount * multiplier).floor() as i64
}

#[cfg(test)]
mod tests {
    use super::{
        add_purchase_inventory, checkout_total, create_return_tx, delete_purchase_invoice_tx,
        loyalty_points, patient_outstanding_debt, process_checkout_tx,
        return_quantity_in_sale_unit, return_restock_qty, sale_stock_qty, save_purchase_invoice_tx,
        validate_write_sql, CheckoutItem, CheckoutPayload, PurchaseItem, PurchasePayload,
        ReturnItem, ReturnPayload,
    };
    use sqlx::{Connection, Row, SqliteConnection};

    #[test]
    fn calculates_checkout_money() {
        let items = vec![
            CheckoutItem {
                drug_id: 1,
                inventory_id: None,
                quantity_sold: 2.0,
                unit_price: 10.0,
                selected_unit: "large".into(),
                is_negative: false,
            },
            CheckoutItem {
                drug_id: 2,
                inventory_id: None,
                quantity_sold: 3.0,
                unit_price: 5.0,
                selected_unit: "large".into(),
                is_negative: false,
            },
        ];
        assert_eq!(checkout_total(&items, 4.0, 2.0), 33.0);
        assert_eq!(loyalty_points(33.0, Some("gold")), 49);
    }

    #[tokio::test]
    async fn patient_debt_uses_only_receivable_movements() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE patients (id TEXT PRIMARY KEY, opening_balance INTEGER)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT, total_amount INTEGER, payment_method TEXT, status TEXT)",
            "CREATE TABLE returns (invoice_id TEXT, total_refund INTEGER, refund_method TEXT, status TEXT)",
            "CREATE TABLE patient_transactions (patient_id TEXT, type TEXT, amount INTEGER)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::query("INSERT INTO patients VALUES ('p1', 50)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_invoices VALUES ('credit-sale', 'p1', 100, 'credit', 'completed'), ('cash-sale', 'p1', 50, 'cash', 'completed')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO returns VALUES ('credit-sale', 20, 'patient_account', 'approved'), ('credit-sale', 10, 'cash', 'approved'), ('credit-sale', 50, 'patient_account', 'pending')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO patient_transactions VALUES ('p1', 'payment', 30), ('p1', 'adjustment', -10), ('p1', 'adjustment', 5)")
            .execute(&mut conn)
            .await
            .unwrap();

        let mut tx = conn.begin().await.unwrap();
        let debt = patient_outstanding_debt(&mut tx, "p1").await.unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(debt, 95.0);
    }

    #[test]
    fn guards_renderer_write_sql() {
        assert!(validate_write_sql("INSERT INTO activity_log VALUES (?, ?, ?)").is_ok());
        assert!(validate_write_sql("BEGIN IMMEDIATE").is_ok());
        assert!(validate_write_sql("SELECT * FROM users").is_err());
        assert!(validate_write_sql("DELETE FROM users; DROP TABLE users").is_err());
        assert!(validate_write_sql("PRAGMA writable_schema = 1").is_err());
    }

    #[test]
    fn accepts_purchase_numeric_strings() {
        let payload: PurchasePayload = serde_json::from_value(serde_json::json!({
            "supplier_id": "10",
            "user_id": "u1",
            "expenses": "2.5",
            "discount_value": "",
            "cart": [{
                "id": "123",
                "quantity": "10",
                "unit_id": "",
                "cost_price": "7.5",
                "selling_price": "12",
                "bonus_quantity": "1",
                "tax_percent": "14",
                "discount_percent": "0",
                "strips_per_box": "10"
            }]
        }))
        .unwrap();
        assert_eq!(payload.supplier_id, 10);
        assert_eq!(payload.expenses, 2.5);
        assert_eq!(payload.cart[0].id, 123);
        assert_eq!(payload.cart[0].quantity, 10.0);
        assert_eq!(payload.cart[0].unit_id, None);
        assert_eq!(payload.cart[0].selling_price, Some(12.0));
        assert_eq!(payload.cart[0].strips_per_box, 10);
    }

    #[test]
    fn accepts_checkout_numeric_strings() {
        let payload: CheckoutPayload = serde_json::from_value(serde_json::json!({
            "pharmacy_id": "ph-001",
            "user_id": "admin",
            "items": [{
                "drug_id": "3421",
                "inventory_id": "inv-cardixin",
                "quantity_sold": "1",
                "unit_price": "36.5",
                "selected_unit": "large"
            }],
            "payment_method": "cash",
            "status": "completed",
            "total_discount": "0",
            "additional_fees": "0"
        }))
        .unwrap();
        assert_eq!(payload.items[0].drug_id, 3421);
        assert_eq!(payload.items[0].quantity_sold, 1.0);
        assert_eq!(payload.items[0].unit_price, 36.5);
        assert_eq!(
            checkout_total(
                &payload.items,
                payload.total_discount,
                payload.additional_fees
            ),
            36.5
        );
    }

    #[test]
    fn checkout_unit_deduction_uses_selected_unit() {
        assert_eq!(sale_stock_qty(1.0, "large", 10.0, 1.0, None, None), 1.0);
        assert_eq!(sale_stock_qty(1.0, "medium", 10.0, 1.0, None, None), 0.1);
        assert_eq!(sale_stock_qty(1.0, "strip", 10.0, 1.0, None, None), 0.1);
        assert_eq!(
            sale_stock_qty(
                1.0,
                "\u{0634}\u{0631}\u{064a}\u{0637}",
                10.0,
                1.0,
                None,
                None
            ),
            0.1
        );
    }

    #[tokio::test]
    async fn purchase_inventory_merges_only_matching_expiry() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity INTEGER, local_selling_price REAL, cost_price REAL, expiry_date TEXT, batch_number TEXT, strips_per_box INTEGER, created_at TEXT, updated_at TEXT)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, expiry_date, created_at) VALUES ('old', 4463, NULL, 1, '2026-07-22', '2026-01-01')")
            .execute(&mut conn)
            .await
            .unwrap();

        let mut tx = conn.begin().await.unwrap();
        add_purchase_inventory(
            &mut tx,
            4463,
            Some("ph-001"),
            6.0,
            69.0,
            40.0,
            Some("2026-07-22"),
            "INV-1",
            1,
        )
        .await
        .unwrap();
        add_purchase_inventory(
            &mut tx,
            4463,
            Some("ph-001"),
            5.0,
            69.0,
            40.0,
            Some("2026-08-13"),
            "INV-2",
            1,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let row = sqlx::query("SELECT COUNT(*) as rows, SUM(quantity) as qty FROM inventory WHERE drug_id = 4463 AND quantity > 0")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(row.try_get::<i64, _>("rows").unwrap(), 2);
        assert_eq!(row.try_get::<i64, _>("qty").unwrap(), 12);
    }

    #[tokio::test]
    async fn completed_purchase_reduction_and_taxes_update_inventory() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, large_to_medium INTEGER)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity INTEGER, local_selling_price REAL, cost_price REAL, expiry_date TEXT, batch_number TEXT, strips_per_box INTEGER, created_at TEXT, updated_at TEXT)",
            "CREATE TABLE purchase_invoices (id TEXT PRIMARY KEY, supplier_id INTEGER, pharmacy_id TEXT, user_id TEXT, invoice_number TEXT, invoice_date TEXT, payment_method TEXT, notes TEXT, check_number TEXT, expenses REAL, discount_value REAL, discount_percent REAL, tax_percent REAL, status TEXT, total_amount REAL)",
            "CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT, drug_id INTEGER, quantity INTEGER, unit_id INTEGER, expiry_date TEXT, cost_price REAL, selling_price REAL, bonus_quantity INTEGER, tax_percent REAL, discount_percent REAL, strips_per_box INTEGER, inventory_id TEXT)",
            "CREATE TABLE purchase_returns (purchase_invoice_id TEXT)",
            "CREATE TABLE suppliers (id INTEGER PRIMARY KEY, balance REAL)",
            "CREATE TABLE users (id TEXT PRIMARY KEY)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY)",
            "CREATE TABLE supplier_transactions (supplier_id INTEGER, type TEXT, amount REAL, reference_id TEXT, notes TEXT)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE cash_movements (id TEXT, user_id TEXT, shift_id TEXT, type TEXT, amount REAL, category TEXT, notes TEXT, date TEXT)",
            "CREATE TABLE shifts (id TEXT, user_id TEXT, status TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::query("INSERT INTO master_drugs (id) VALUES (4463)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO suppliers (id, balance) VALUES (1, 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users (id) VALUES ('admin')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO accounts (id) VALUES (6), (7), (10)")
            .execute(&mut conn)
            .await
            .unwrap();

        let purchase = |quantity| PurchasePayload {
            id: Some("purchase-1".into()),
            supplier_id: 1,
            pharmacy_id: Some("ph-001".into()),
            user_id: "admin".into(),
            invoice_number: Some("INV-1".into()),
            invoice_date: Some("2026-07-19".into()),
            payment_method: Some("cash".into()),
            notes: None,
            check_number: None,
            expenses: 0.0,
            discount_value: 0.0,
            discount_percent: 0.0,
            tax_percent: 5.0,
            status: Some("completed".into()),
            cart: vec![PurchaseItem {
                id: 4463,
                quantity,
                unit_id: None,
                expiry_date: Some("2026-08-13".into()),
                cost_price: 10.0,
                selling_price: Some(20.0),
                bonus_quantity: 0.0,
                tax_percent: 10.0,
                discount_percent: 0.0,
                strips_per_box: 1,
            }],
        };

        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, purchase(6.0))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let edited = save_purchase_invoice_tx(&mut tx, purchase(5.0))
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let inventory = sqlx::query("SELECT quantity, cost_price FROM inventory WHERE drug_id = 4463 AND expiry_date = '2026-08-13'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(inventory.try_get::<i64, _>("quantity").unwrap(), 5);
        assert!((inventory.try_get::<f64, _>("cost_price").unwrap() - 11.55).abs() < 0.001);
        assert!((edited.total_amount - 57.75).abs() < 0.001);

        let linked: Option<String> = sqlx::query(
            "SELECT inventory_id FROM purchase_invoice_items WHERE invoice_id = 'purchase-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("inventory_id")
        .unwrap();
        assert!(linked.is_some());

        let mut tx = conn.begin().await.unwrap();
        delete_purchase_invoice_tx(&mut tx, "purchase-1", true)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let remaining: f64 = sqlx::query(
            "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE drug_id = 4463",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("quantity")
        .unwrap();
        assert_eq!(remaining, 0.0);

        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, purchase(5.0))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        delete_purchase_invoice_tx(&mut tx, "purchase-1", false)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let kept: f64 = sqlx::query(
            "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE drug_id = 4463",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("quantity")
        .unwrap();
        assert_eq!(kept, 5.0);
    }

    #[tokio::test]
    async fn sales_return_unit_math_uses_selected_unit() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, large_to_medium INTEGER, medium_to_small INTEGER)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE inventory (id TEXT PRIMARY KEY, strips_per_box INTEGER)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO master_drugs (id, large_to_medium, medium_to_small) VALUES (4463, 10, 1)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let mut tx = conn.begin().await.unwrap();
        let restock = return_restock_qty(&mut tx, Some(4463), None, 1.0, "medium")
            .await
            .unwrap();
        let returned_in_box =
            return_quantity_in_sale_unit(&mut tx, Some(4463), None, 1.0, "medium", "large")
                .await
                .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(restock, 0.1);
        assert_eq!(returned_in_box, 0.1);
    }

    #[tokio::test]
    async fn sales_return_restores_original_batch_and_tracks_remaining() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, no_return INTEGER, large_to_medium INTEGER, medium_to_small INTEGER)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, pharmacy_id TEXT, drug_id INTEGER, batch_number TEXT, expiry_date TEXT, quantity REAL, unit_price REAL, cost_price REAL, strips_per_box INTEGER, created_at TEXT, updated_at TEXT)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT)",
            "CREATE TABLE patients (id TEXT PRIMARY KEY, wallet_balance REAL)",
            "CREATE TABLE sales_items (id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold INTEGER, unit_price REAL, unit TEXT, cost_price INTEGER)",
            "CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, shift_id TEXT, reason TEXT, total_refund REAL, refund_method TEXT, status TEXT)",
            "CREATE TABLE return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT, drug_name TEXT, quantity_returned INTEGER, unit_price REAL)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::query("INSERT INTO master_drugs VALUES (4463, 'COLONA', 0, 10, 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO accounts (id) VALUES (6), (8), (9), (10), (11)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory VALUES ('batch-2027', 'ph-1', 4463, 'B-27', '2027-08-13', 0, 69, 40, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO patients VALUES ('patient-1', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_invoices VALUES ('invoice-1', 'patient-1')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_items VALUES (1, 'invoice-1', 'batch-2027', 4463, 1, 69, 'large', 40)").execute(&mut conn).await.unwrap();

        let payload = ReturnPayload {
            invoice_id: "invoice-1".into(),
            user_id: "admin".into(),
            pharmacy_id: Some("ph-1".into()),
            shift_id: None,
            refund_method: "cash".into(),
            reason: Some("partial".into()),
            patient_id: None,
            items: vec![ReturnItem {
                sale_item_id: Some(1),
                inventory_id: Some("wrong-batch".into()),
                drug_name: "COLONA".into(),
                quantity: 2.0,
                unit_price: 6.9,
                unit: Some("medium".into()),
            }],
        };
        let mut tx = conn.begin().await.unwrap();
        create_return_tx(&mut tx, payload).await.unwrap();
        tx.commit().await.unwrap();

        let batch =
            sqlx::query("SELECT quantity, expiry_date FROM inventory WHERE id = 'batch-2027'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let restored: f64 = batch.try_get("quantity").unwrap();
        let expiry: String = batch.try_get("expiry_date").unwrap();
        let returned: f64 =
            sqlx::query("SELECT quantity_returned FROM return_items WHERE sale_item_id = 1")
                .fetch_one(&mut conn)
                .await
                .unwrap()
                .try_get("quantity_returned")
                .unwrap();
        assert!((restored - 0.2).abs() < 0.000_001);
        assert!((returned - 0.2).abs() < 0.000_001);
        assert_eq!(expiry, "2027-08-13");
        assert!((1.0 - returned - 0.8).abs() < 0.000_001);

        let patient_return = ReturnPayload {
            invoice_id: "invoice-1".into(),
            user_id: "admin".into(),
            pharmacy_id: Some("ph-1".into()),
            shift_id: None,
            refund_method: "patient_account".into(),
            reason: None,
            patient_id: None,
            items: vec![ReturnItem {
                sale_item_id: Some(1),
                inventory_id: Some("batch-2027".into()),
                drug_name: "COLONA".into(),
                quantity: 4.0,
                unit_price: 3.45,
                unit: Some("small".into()),
            }],
        };
        let mut tx = conn.begin().await.unwrap();
        create_return_tx(&mut tx, patient_return).await.unwrap();
        tx.commit().await.unwrap();
        let wallet: f64 = sqlx::query("SELECT wallet_balance FROM patients WHERE id = 'patient-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("wallet_balance")
            .unwrap();
        let receivable_credit: f64 = sqlx::query(
            "SELECT CAST(COALESCE(SUM(amount), 0) AS REAL) AS total FROM journal_entries WHERE account_id = 8 AND type = 'credit'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("total")
        .unwrap();
        assert_eq!(wallet, 0.0);
        assert!((receivable_credit - 13.8).abs() < 0.000_001);

        let full_return = ReturnPayload {
            invoice_id: "invoice-1".into(),
            user_id: "admin".into(),
            pharmacy_id: Some("ph-1".into()),
            shift_id: None,
            refund_method: "cash".into(),
            reason: Some("complete".into()),
            patient_id: None,
            items: vec![ReturnItem {
                sale_item_id: Some(1),
                inventory_id: Some("batch-2027".into()),
                drug_name: "COLONA".into(),
                quantity: 0.6,
                unit_price: 69.0,
                unit: Some("large".into()),
            }],
        };
        let mut tx = conn.begin().await.unwrap();
        create_return_tx(&mut tx, full_return).await.unwrap();
        tx.commit().await.unwrap();
        let final_stock: f64 =
            sqlx::query("SELECT quantity FROM inventory WHERE id = 'batch-2027'")
                .fetch_one(&mut conn)
                .await
                .unwrap()
                .try_get("quantity")
                .unwrap();
        assert!((final_stock - 1.0).abs() < 0.000_001);

        let excessive = ReturnPayload {
            invoice_id: "invoice-1".into(),
            user_id: "admin".into(),
            pharmacy_id: Some("ph-1".into()),
            shift_id: None,
            refund_method: "cash".into(),
            reason: Some("too much".into()),
            patient_id: None,
            items: vec![ReturnItem {
                sale_item_id: Some(1),
                inventory_id: Some("batch-2027".into()),
                drug_name: "COLONA".into(),
                quantity: 1.0,
                unit_price: 6.9,
                unit: Some("medium".into()),
            }],
        };
        let mut tx = conn.begin().await.unwrap();
        let error = create_return_tx(&mut tx, excessive).await.unwrap_err();
        tx.rollback().await.unwrap();
        assert!(error.contains("exceeds remaining quantity"));
    }

    #[tokio::test]
    async fn checkout_handles_batch_fallback_and_wallet_accounting() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, large_to_medium INTEGER, medium_to_small INTEGER, medium_unit TEXT, small_unit TEXT)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, quantity INTEGER, cost_price REAL, expiry_date TEXT, created_at TEXT, updated_at TEXT, strips_per_box INTEGER)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, pharmacy_id TEXT, user_id TEXT, patient_id TEXT, shift_id TEXT, total_amount REAL, payment_method TEXT, check_number TEXT, status TEXT, discount_amount REAL, created_at TEXT)",
            "CREATE TABLE sales_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold REAL, unit_price REAL, unit TEXT, is_negative INTEGER, cost_price REAL, created_at TEXT)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY)",
            "CREATE TABLE patients (id TEXT PRIMARY KEY, credit_limit INTEGER, wallet_balance INTEGER, loyalty_level TEXT, points_balance INTEGER)",
            "CREATE TABLE returns (invoice_id TEXT, total_refund REAL, refund_method TEXT, status TEXT)",
            "CREATE TABLE patient_transactions (patient_id TEXT, type TEXT, amount REAL)",
            "CREATE TABLE refill_reminders (id TEXT, patient_id TEXT, drug_id INTEGER, last_sold_date TEXT, next_refill_date TEXT, created_at TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::query("INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small) VALUES (4463, 'COLONA', 10, 1)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO accounts (id) VALUES (6), (8), (9), (10), (11), (12)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO trial_balance_settings VALUES ('patient_wallet_liability', 12)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory (id, drug_id, quantity, cost_price, expiry_date, created_at, strips_per_box) VALUES ('empty', 4463, 0, 40, '2027-01-01', '2026-01-01', 10), ('full', 4463, 7, 40, '2027-01-01', '2026-01-02', 10)")
            .execute(&mut conn)
            .await
            .unwrap();

        let payload = CheckoutPayload {
            pharmacy_id: "ph-001".into(),
            user_id: "admin".into(),
            items: vec![CheckoutItem {
                drug_id: 4463,
                inventory_id: Some("empty".into()),
                quantity_sold: 1.0,
                unit_price: 69.0,
                selected_unit: "large".into(),
                is_negative: false,
            }],
            patient_id: None,
            shift_id: None,
            payment_method: "cash".into(),
            check_number: None,
            status: "completed".into(),
            total_discount: 0.0,
            additional_fees: 0.0,
        };

        let mut tx = conn.begin().await.unwrap();
        process_checkout_tx(&mut tx, payload, 69.0).await.unwrap();
        tx.commit().await.unwrap();

        let full_qty: i64 = sqlx::query("SELECT quantity FROM inventory WHERE id = 'full'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("quantity")
            .unwrap();
        assert_eq!(full_qty, 6);

        sqlx::query("INSERT INTO patients VALUES ('p1', 300, 100, 'bronze', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        let wallet_payload = CheckoutPayload {
            pharmacy_id: "ph-001".into(),
            user_id: "admin".into(),
            items: vec![CheckoutItem {
                drug_id: 4463,
                inventory_id: Some("full".into()),
                quantity_sold: 1.0,
                unit_price: 69.0,
                selected_unit: "large".into(),
                is_negative: false,
            }],
            patient_id: Some("p1".into()),
            shift_id: None,
            payment_method: "wallet".into(),
            check_number: None,
            status: "completed".into(),
            total_discount: 0.0,
            additional_fees: 0.0,
        };
        let mut tx = conn.begin().await.unwrap();
        process_checkout_tx(&mut tx, wallet_payload, 69.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let wallet: f64 = sqlx::query(
            "SELECT CAST(wallet_balance AS REAL) AS wallet_balance FROM patients WHERE id = 'p1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("wallet_balance")
        .unwrap();
        let wallet_debit: f64 = sqlx::query("SELECT CAST(COALESCE(SUM(amount), 0) AS REAL) AS total FROM journal_entries WHERE account_id = 12 AND type = 'debit'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("total")
            .unwrap();
        assert_eq!(wallet, 31.0);
        assert_eq!(wallet_debit, 69.0);
    }
}
