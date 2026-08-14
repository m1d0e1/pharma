use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, Sqlite, SqliteConnection, Transaction};
use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
};
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
    #[serde(default, deserialize_with = "de_opt_i64")]
    pub purchase_invoice_item_id: Option<i64>,
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
    pub user_id: String,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub pharmacy_id: Option<String>,
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
    #[allow(dead_code)]
    pub inventory_id: Option<String>,
    pub drug_name: String,
    #[serde(default, deserialize_with = "de_f64")]
    pub quantity: f64,
    #[serde(default, deserialize_with = "de_f64")]
    #[allow(dead_code)]
    pub unit_price: f64,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub unit: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReturnResult {
    pub return_id: String,
    pub total_refund: f64,
}

#[derive(Debug, Deserialize)]
pub struct NegativeStockSettlementPayload {
    #[serde(deserialize_with = "de_i64")]
    pub sale_item_id: i64,
    pub inventory_id: String,
    pub pharmacy_id: String,
    pub user_id: String,
}

#[derive(Debug, Serialize)]
pub struct NegativeStockSettlementResult {
    pub sale_item_id: i64,
    pub inventory_id: String,
    pub deducted_quantity: f64,
    pub cogs_amount: f64,
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
    let result = delete_purchase_invoice_tx(
        &mut tx,
        &payload.invoice_id,
        payload.remove_inventory,
        &payload.user_id,
        payload.pharmacy_id.as_deref(),
    )
    .await;
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

#[tauri::command]
pub async fn settle_negative_sale_item_critical(
    app: tauri::AppHandle,
    payload: NegativeStockSettlementPayload,
) -> Result<NegativeStockSettlementResult, String> {
    if payload.sale_item_id <= 0
        || payload.inventory_id.trim().is_empty()
        || payload.pharmacy_id.trim().is_empty()
        || payload.user_id.trim().is_empty()
    {
        return Err("Invalid negative-stock settlement request".into());
    }

    let mut conn = open_app_connection(&app).await?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    let result = settle_negative_sale_item_tx(&mut tx, &payload).await;
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

async fn resolve_open_shift(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: &str,
    requested_shift_id: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(shift_id) = requested_shift_id.filter(|id| !id.trim().is_empty()) {
        return sqlx::query(
            "SELECT id FROM shifts WHERE id = ? AND CAST(user_id AS TEXT) = ? AND LOWER(COALESCE(status, '')) = 'open'",
        )
        .bind(shift_id)
        .bind(user_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .map(|row| row.try_get("id").map_err(|e| e.to_string()))
        .transpose()?
        .ok_or_else(|| "Selected shift is not open for this user".to_string())
        .map(Some);
    }

    sqlx::query(
        "SELECT id FROM shifts WHERE CAST(user_id AS TEXT) = ? AND LOWER(COALESCE(status, '')) = 'open' ORDER BY start_time DESC LIMIT 1",
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .map(|row| row.try_get("id").map_err(|e| e.to_string()))
    .transpose()
}

async fn create_return_tx(
    tx: &mut Transaction<'_, Sqlite>,
    payload: ReturnPayload,
) -> Result<ReturnResult, String> {
    let mut payload = payload;
    if payload.items.is_empty()
        || payload
            .items
            .iter()
            .any(|item| !item.quantity.is_finite() || item.quantity <= 0.0)
    {
        return Err("Invalid return items".into());
    }
    if !matches!(
        payload.refund_method.as_str(),
        "cash" | "patient_account" | "wallet" | "bank"
    ) {
        return Err("Refund method must be cash, patient_account, wallet, or bank".into());
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

    if sqlx::query("SELECT 1 FROM users WHERE CAST(id AS TEXT) = ?")
        .bind(&payload.user_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err(format!("Return user '{}' does not exist", payload.user_id));
    }

    payload.shift_id =
        resolve_open_shift(tx, &payload.user_id, payload.shift_id.as_deref()).await?;

    let invoice = sqlx::query(
        "SELECT patient_id, pharmacy_id, payment_method, status, CAST(total_amount AS REAL) AS total_amount, CAST(COALESCE(discount_amount, 0) AS REAL) AS discount_amount FROM sales_invoices WHERE id = ?",
    )
        .bind(&payload.invoice_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Invoice not found".to_string())?;
    let invoice_status = invoice
        .try_get::<Option<String>, _>("status")
        .unwrap_or(None)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !invoice_status.is_empty() && invoice_status != "completed" && invoice_status != "approved" {
        return Err("Only completed sales invoices can be returned".into());
    }
    if payload.refund_method == "patient_account" || payload.refund_method == "wallet" {
        let invoice_patient = invoice
            .try_get::<Option<String>, _>("patient_id")
            .unwrap_or(None);
        if invoice_patient.is_none() {
            return Err("Patient account refund requires a patient linked to the invoice".into());
        }
    }
    let invoice_pharmacy_raw = invoice
        .try_get::<Option<String>, _>("pharmacy_id")
        .unwrap_or(None);
    let invoice_pharmacy = normalize_pharmacy_id(invoice_pharmacy_raw.as_deref());
    let requested_pharmacy = normalize_pharmacy_id(payload.pharmacy_id.as_deref());
    if requested_pharmacy != invoice_pharmacy {
        return Err("Sales invoice belongs to another pharmacy".into());
    }

    let invoice_gross: f64 = sqlx::query(
        "SELECT CAST(COALESCE(SUM(quantity_sold * unit_price), 0) AS REAL) AS gross FROM sales_items WHERE invoice_id = ?",
    )
    .bind(&payload.invoice_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .try_get("gross")
    .unwrap_or(0.0);
    let discount_amount: f64 = invoice.try_get("discount_amount").unwrap_or(0.0);
    let invoice_total = invoice
        .try_get::<Option<f64>, _>("total_amount")
        .unwrap_or(None)
        .unwrap_or_else(|| (invoice_gross - discount_amount).max(0.0));
    if !invoice_gross.is_finite()
        || invoice_gross < 0.0
        || !invoice_total.is_finite()
        || invoice_total < 0.0
    {
        return Err("Sales invoice has invalid totals".into());
    }
    let already_refunded: f64 = sqlx::query(
        "SELECT CAST(COALESCE(SUM(total_refund), 0) AS REAL) AS refunded FROM returns WHERE invoice_id = ? AND LOWER(COALESCE(status, '')) IN ('approved', 'completed')",
    )
    .bind(&payload.invoice_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .try_get("refunded")
    .unwrap_or(0.0);
    if !already_refunded.is_finite() || already_refunded < 0.0 {
        return Err("Sales invoice has invalid prior refunds".into());
    }
    let remaining_invoice_refund = (invoice_total - already_refunded).max(0.0);
    if payload.refund_method == "patient_account" || payload.refund_method == "wallet" {
        let invoice_patient = invoice
            .try_get::<Option<String>, _>("patient_id")
            .unwrap_or(None);
        if invoice_patient.is_none()
            || payload
                .patient_id
                .as_ref()
                .is_some_and(|id| Some(id) != invoice_patient.as_ref())
        {
            return Err("Patient refunds require the invoice patient".into());
        }
        payload.patient_id = invoice_patient;
    }

    struct PreparedReturn {
        sale_item_id: i64,
        drug_id: Option<i64>,
        inventory_id: Option<String>,
        cost_price: f64,
        sold_unit: String,
        sold_unit_price: f64,
        returned_in_sold_unit: f64,
        restock_qty: f64,
        inventory_selling_price: f64,
        gross_line_refund: f64,
        line_refund: f64,
    }

    let mut requested_by_sale_item = HashMap::<i64, f64>::new();
    let mut prepared_items = Vec::with_capacity(payload.items.len());
    let mut gross_requested_refund = 0.0;
    for item in &payload.items {
        let sale_item_id = item
            .sale_item_id
            .ok_or_else(|| "Return item must reference a sale item".to_string())?;
        let sold = sqlx::query(
            "SELECT CAST(si.quantity_sold AS REAL) AS quantity_sold, CAST(si.unit_price AS REAL) AS unit_price, CAST(si.cost_price AS REAL) AS cost_price, si.unit, si.drug_id, si.inventory_id, COALESCE(md.no_return, 0) AS no_return, md.trade_name FROM sales_items si LEFT JOIN master_drugs md ON si.drug_id = md.id WHERE si.id = ? AND si.invoice_id = ?",
        )
        .bind(sale_item_id)
        .bind(&payload.invoice_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Sale item {} not found", sale_item_id))?;
        if sold.try_get::<i64, _>("no_return").unwrap_or(0) != 0 {
            let name: String = sold
                .try_get("trade_name")
                .unwrap_or_else(|_| item.drug_name.clone());
            return Err(format!("Item \"{}\" cannot be returned", name));
        }

        let sold_qty: f64 = sold.try_get("quantity_sold").unwrap_or(0.0);
        let sold_unit_price: f64 = sold.try_get("unit_price").unwrap_or(0.0);
        if !sold_unit_price.is_finite() || sold_unit_price < 0.0 {
            return Err(format!("Invalid sale price for {}", item.drug_name));
        }
        let sold_unit: String = sold.try_get("unit").unwrap_or_else(|_| "large".into());
        let drug_id: Option<i64> = sold.try_get("drug_id").ok();
        let inventory_id: Option<String> = sold.try_get("inventory_id").ok();
        let cost_price: f64 = sold.try_get("cost_price").unwrap_or(0.0);
        let returned: f64 = sqlx::query(
            "SELECT CAST(COALESCE(SUM(ri.quantity_returned), 0) AS REAL) as total FROM return_items ri JOIN returns r ON ri.return_id = r.id WHERE r.invoice_id = ? AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed') AND ri.sale_item_id = ?",
        )
        .bind(&payload.invoice_id)
        .bind(sale_item_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .try_get("total")
        .unwrap_or(0.0);
        let unit = item.unit.as_deref().unwrap_or("large");
        let returned_in_sold_unit = return_quantity_in_sale_unit(
            tx,
            drug_id,
            inventory_id.as_deref(),
            item.quantity,
            unit,
            &sold_unit,
        )
        .await?;
        let requested = requested_by_sale_item.entry(sale_item_id).or_default();
        *requested += returned_in_sold_unit;
        if *requested > sold_qty - returned + 0.005 {
            return Err(format!(
                "Return quantity exceeds remaining quantity for {}",
                item.drug_name
            ));
        }
        let restock_qty =
            return_restock_qty(tx, drug_id, inventory_id.as_deref(), item.quantity, unit).await?;
        let gross_line_refund = returned_in_sold_unit * sold_unit_price;
        if !restock_qty.is_finite() || restock_qty <= 0.0 {
            return Err(format!("Invalid restock quantity for {}", item.drug_name));
        }
        gross_requested_refund += gross_line_refund;
        prepared_items.push(PreparedReturn {
            sale_item_id,
            drug_id,
            inventory_id,
            cost_price,
            sold_unit,
            sold_unit_price,
            returned_in_sold_unit,
            restock_qty,
            inventory_selling_price: gross_line_refund / restock_qty,
            gross_line_refund,
            line_refund: 0.0,
        });
    }

    let paid_ratio = if invoice_gross > 0.0 {
        invoice_total / invoice_gross
    } else {
        0.0
    };
    if !paid_ratio.is_finite() || paid_ratio < 0.0 {
        return Err("Sales invoice has an invalid discount allocation".into());
    }
    let proposed_refund = gross_requested_refund * paid_ratio;
    let total_refund = proposed_refund.min(remaining_invoice_refund);
    let prepared_count = prepared_items.len();
    let mut allocated_refund = 0.0;
    for (index, prepared) in prepared_items.iter_mut().enumerate() {
        prepared.line_refund = if index + 1 == prepared_count {
            total_refund - allocated_refund
        } else if gross_requested_refund > 0.0 {
            total_refund * (prepared.gross_line_refund / gross_requested_refund)
        } else {
            0.0
        };
        allocated_refund += prepared.line_refund;
    }

    let return_id = uuid::Uuid::new_v4().to_string();
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
    for (item, prepared) in payload.items.iter().zip(prepared_items) {
        let inventory_id = ensure_return_inventory(
            tx,
            prepared.inventory_id.as_deref(),
            prepared.drug_id,
            Some(&invoice_pharmacy),
            prepared.inventory_selling_price,
        )
        .await?;

        sqlx::query("INSERT INTO return_items (return_id, inventory_id, drug_id, drug_name, quantity_returned, unit_price, sale_item_id, unit, total_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&return_id)
            .bind(&inventory_id)
            .bind(prepared.drug_id)
            .bind(&item.drug_name)
            .bind(prepared.returned_in_sold_unit)
            .bind(prepared.sold_unit_price)
            .bind(prepared.sale_item_id)
            .bind(&prepared.sold_unit)
            .bind(prepared.line_refund)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;

        sqlx::query("UPDATE inventory SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(prepared.restock_qty)
            .bind(&inventory_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        total_cogs_reversal += prepared.cost_price * prepared.restock_qty;
    }

    apply_return_accounting(tx, &payload, &return_id, total_refund, total_cogs_reversal).await?;
    Ok(ReturnResult {
        return_id,
        total_refund,
    })
}

pub(crate) async fn save_purchase_invoice_tx(
    tx: &mut Transaction<'_, Sqlite>,
    payload: PurchasePayload,
) -> Result<PurchaseResult, String> {
    let mut payload = payload;
    payload.pharmacy_id = Some(normalize_pharmacy_id(payload.pharmacy_id.as_deref()));
    let is_draft = payload.status.as_deref() == Some("draft");
    if !is_draft {
        let supplied_invoice_date = payload.invoice_date.is_some();
        payload.invoice_date = normalize_valid_date_ymd(payload.invoice_date.as_deref())
            .map_err(|error| format!("Invalid purchase invoice date: {error}"))?;
        if supplied_invoice_date && payload.invoice_date.is_none() {
            return Err("Completed purchase invoice date cannot be empty".into());
        }
        for item in &mut payload.cart {
            item.expiry_date = normalize_valid_date_ymd(item.expiry_date.as_deref())
                .map_err(|error| format!("Invalid expiry date for drug {}: {error}", item.id))?;
            if item.expiry_date.is_none() {
                return Err(format!(
                    "Completed purchase requires an expiry date for drug {}",
                    item.id
                ));
            }
        }
    }
    let (items_total, inventory_paid_factor) = validate_purchase_payload(&payload)?;
    if !is_draft {
        let today: String = sqlx::query_scalar("SELECT DATE('now', 'localtime')")
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        if payload.invoice_date.is_none() {
            payload.invoice_date = Some(today.clone());
        }
        for item in &payload.cart {
            if item
                .expiry_date
                .as_deref()
                .is_some_and(|expiry| expiry < today.as_str())
            {
                return Err(format!(
                    "Expiry date for drug {} is already expired",
                    item.id
                ));
            }
        }
    }
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
    let batch_number = purchase_batch_number(payload.invoice_number.as_deref(), &invoice_id);
    let invoice_date = payload
        .invoice_date
        .clone()
        .unwrap_or_else(|| "DATE('now', 'localtime')".into());

    let supplier_row = sqlx::query("SELECT id FROM suppliers WHERE id = ?")
        .bind(payload.supplier_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let effective_supplier_id: i64 = supplier_row
        .ok_or_else(|| format!("Purchase supplier {} does not exist", payload.supplier_id))?
        .try_get("id")
        .map_err(|e| format!("Invalid purchase supplier id: {e}"))?;

    let user_row = sqlx::query(
        "SELECT id, pharmacy_id, role, permissions FROM users WHERE CAST(id AS TEXT) = ? AND COALESCE(is_active, 1) = 1",
    )
        .bind(&payload.user_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let effective_user_id: String = user_row
        .as_ref()
        .ok_or_else(|| format!("Purchase user '{}' does not exist", payload.user_id))?
        .try_get("id")
        .map_err(|e| format!("Invalid purchase user id: {e}"))?;
    let user_role = user_row
        .as_ref()
        .and_then(|row| row.try_get::<Option<String>, _>("role").ok())
        .flatten();
    let user_permissions = user_row
        .as_ref()
        .and_then(|row| row.try_get::<Option<String>, _>("permissions").ok())
        .flatten();
    if !user_can_view_purchases(user_role.as_deref(), user_permissions.as_deref()) {
        return Err("Unauthorized: can_view_purchases permission required".into());
    }
    let user_pharmacy_id = user_row
        .as_ref()
        .and_then(|row| row.try_get::<Option<String>, _>("pharmacy_id").ok())
        .flatten();
    if normalize_pharmacy_id(user_pharmacy_id.as_deref())
        != normalize_pharmacy_id(payload.pharmacy_id.as_deref())
    {
        return Err("Purchase pharmacy does not match the current user".into());
    }
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
    if let Some(old) = sqlx::query("SELECT supplier_id, total_amount, payment_method, status, invoice_number, pharmacy_id FROM purchase_invoices WHERE id = ?")
        .bind(&invoice_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
    {
        let old_status: String = old.try_get("status").unwrap_or_default();
        if old_status == "completed" {
            ensure_no_finalized_purchase_returns(tx, &invoice_id, "edit").await?;
            editing_completed = true;
            reverse_completed_purchase(
                tx,
                &invoice_id,
                &old,
                &payload,
                inventory_paid_factor,
            )
            .await?;
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

        if final_status == "completed" && !editing_completed {
            let total_received = item.quantity + item.bonus_quantity;
            let net_unit_cost = if total_received > 0.0 {
                item_total * inventory_paid_factor / total_received
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
                &batch_number,
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
                &batch_number,
            )
            .await?
            .ok_or_else(|| format!("Inventory link missing for drug {}", item.id))?;
            if let Some(barcode) = item
                .barcode
                .as_deref()
                .map(str::trim)
                .filter(|barcode| !barcode.is_empty())
            {
                sqlx::query(
                    "UPDATE inventory SET barcode = ? WHERE id = ? AND (barcode IS NULL OR barcode = '')",
                )
                .bind(barcode)
                .bind(&inventory_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
            }
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
        apply_purchase_accounting(
            tx,
            &payload,
            &invoice_id,
            final_total,
            payment_method,
            effective_supplier_id,
            &effective_user_id,
        )
        .await?;
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

async fn settle_negative_sale_item_tx(
    tx: &mut Transaction<'_, Sqlite>,
    payload: &NegativeStockSettlementPayload,
) -> Result<NegativeStockSettlementResult, String> {
    let sale_item = sqlx::query(
        r#"
        SELECT si.drug_id,
               CAST(si.quantity_sold AS REAL) AS quantity_sold,
               si.unit,
               COALESCE(si.is_negative, 0) AS is_negative,
               s.pharmacy_id
        FROM sales_items si
        JOIN sales_invoices s ON s.id = si.invoice_id
        WHERE si.id = ?
        "#,
    )
    .bind(payload.sale_item_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Sale item not found".to_string())?;

    if sale_item.try_get::<i64, _>("is_negative").unwrap_or(0) != 1 {
        return Err("Sale item is already settled or is not negative stock".into());
    }

    let drug_id: i64 = sale_item
        .try_get("drug_id")
        .map_err(|_| "Negative sale item is missing its drug".to_string())?;
    let quantity_sold: f64 = sale_item.try_get("quantity_sold").unwrap_or(0.0);
    if !quantity_sold.is_finite() || quantity_sold <= 0.0 {
        return Err("Negative sale item has an invalid quantity".into());
    }
    let sold_unit = sale_item
        .try_get::<Option<String>, _>("unit")
        .unwrap_or(None)
        .unwrap_or_else(|| "large".into());
    let sale_pharmacy = sale_item
        .try_get::<Option<String>, _>("pharmacy_id")
        .unwrap_or(None)
        .unwrap_or_else(|| "local_default".into());
    if sale_pharmacy != payload.pharmacy_id {
        return Err("Sale item belongs to another pharmacy".into());
    }

    let batch = sqlx::query(
        r#"
        SELECT CAST(i.quantity AS REAL) AS quantity,
               CAST(COALESCE(i.cost_price, 0) AS REAL) AS cost_price,
               COALESCE(NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium,
               COALESCE(NULLIF(md.medium_to_small, 0), 1) AS medium_to_small,
               md.medium_unit,
               md.small_unit
        FROM inventory i
        LEFT JOIN master_drugs md ON md.id = i.drug_id
        WHERE i.id = ?
          AND i.drug_id = ?
          AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
          AND (i.expiry_date IS NULL OR i.expiry_date >= DATE('now', 'localtime'))
        "#,
    )
    .bind(&payload.inventory_id)
    .bind(drug_id)
    .bind(&sale_pharmacy)
    .bind(&sale_pharmacy)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| {
        "Selected inventory batch has the wrong drug/pharmacy or is expired".to_string()
    })?;

    let batch_quantity: f64 = batch.try_get("quantity").unwrap_or(0.0);
    let cost_price: f64 = batch.try_get("cost_price").unwrap_or(0.0);
    let large_to_medium = batch
        .try_get::<i64, _>("large_to_medium")
        .unwrap_or(1)
        .max(1) as f64;
    let medium_to_small = batch
        .try_get::<i64, _>("medium_to_small")
        .unwrap_or(1)
        .max(1) as f64;
    let medium_unit = batch
        .try_get::<Option<String>, _>("medium_unit")
        .ok()
        .flatten();
    let small_unit = batch
        .try_get::<Option<String>, _>("small_unit")
        .ok()
        .flatten();
    let deduction_quantity = sale_stock_qty(
        quantity_sold,
        &sold_unit,
        large_to_medium,
        medium_to_small,
        medium_unit.as_deref(),
        small_unit.as_deref(),
    );
    if !deduction_quantity.is_finite() || deduction_quantity <= 0.0 {
        return Err("Negative sale item has invalid unit conversion".into());
    }
    if !batch_quantity.is_finite() || batch_quantity + 0.000_001 < deduction_quantity {
        return Err("Selected inventory batch has insufficient stock".into());
    }
    if !cost_price.is_finite() || cost_price < 0.0 {
        return Err("Selected inventory batch has an invalid cost price".into());
    }
    let cogs_amount = cost_price * deduction_quantity;
    if !cogs_amount.is_finite() {
        return Err("Negative-stock settlement cost is invalid".into());
    }

    let sale_update = sqlx::query(
        "UPDATE sales_items SET inventory_id = ?, is_negative = 0, cost_price = ? WHERE id = ? AND is_negative = 1 AND drug_id = ?",
    )
    .bind(&payload.inventory_id)
    .bind(cost_price)
    .bind(payload.sale_item_id)
    .bind(drug_id)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if sale_update.rows_affected() != 1 {
        return Err("Sale item was already settled".into());
    }

    let stock_update = sqlx::query(
        r#"
        UPDATE inventory
        SET quantity = CASE WHEN quantity - ? < 0.000001 THEN 0 ELSE quantity - ? END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND drug_id = ?
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
          AND (expiry_date IS NULL OR expiry_date >= DATE('now', 'localtime'))
          AND quantity + 0.000001 >= ?
        "#,
    )
    .bind(deduction_quantity)
    .bind(deduction_quantity)
    .bind(&payload.inventory_id)
    .bind(drug_id)
    .bind(&sale_pharmacy)
    .bind(&sale_pharmacy)
    .bind(deduction_quantity)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if stock_update.rows_affected() != 1 {
        return Err("Selected inventory batch no longer has sufficient stock".into());
    }

    let journal_id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, DATE('now', 'localtime'), ?, ?, ?)",
    )
    .bind(&journal_id)
    .bind(format!(
        "Negative stock settlement item {}",
        payload.sale_item_id
    ))
    .bind(&payload.user_id)
    .bind(cogs_amount)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    let inventory_account = account_id(tx, "inventory_asset", "1.1.3").await?;
    let cogs_account = account_id(tx, "cogs_expense", "4.1").await?;
    insert_journal_entry(tx, &journal_id, cogs_account, "debit", cogs_amount).await?;
    insert_journal_entry(tx, &journal_id, inventory_account, "credit", cogs_amount).await?;

    sqlx::query(
        "INSERT INTO activity_log (user_id, action, details) VALUES (?, 'SETTLE_NEGATIVE_STOCK', ?)",
    )
    .bind(&payload.user_id)
    .bind(format!(
        "Settled sale item {} from inventory batch {}",
        payload.sale_item_id, payload.inventory_id
    ))
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    Ok(NegativeStockSettlementResult {
        sale_item_id: payload.sale_item_id,
        inventory_id: payload.inventory_id.clone(),
        deducted_quantity: deduction_quantity,
        cogs_amount,
    })
}

async fn process_checkout_tx(
    tx: &mut Transaction<'_, Sqlite>,
    payload: CheckoutPayload,
    total_amount: f64,
) -> Result<CheckoutResult, String> {
    if !total_amount.is_finite()
        || total_amount < 0.0
        || payload.items.iter().any(|item| {
            !item.quantity_sold.is_finite()
                || item.quantity_sold <= 0.0
                || !item.unit_price.is_finite()
                || item.unit_price < 0.0
        })
    {
        return Err("Invalid checkout amounts".into());
    }
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

    let mut shift_id_to_use = payload.shift_id.clone().filter(|s| !s.trim().is_empty());
    if shift_id_to_use.is_none() {
        if !payload.user_id.trim().is_empty() {
            if let Ok(Some(open_shift_id)) = sqlx::query_scalar::<_, String>(
                "SELECT id FROM shifts WHERE CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open' ORDER BY start_time DESC LIMIT 1"
            )
            .bind(&payload.user_id)
            .fetch_optional(&mut **tx)
            .await
            {
                shift_id_to_use = Some(open_shift_id);
            }
        }
        if shift_id_to_use.is_none() {
            let auto_shift_id = uuid::Uuid::new_v4().to_string();
            let auto_user_id = if payload.user_id.trim().is_empty() { "admin" } else { payload.user_id.trim() };
            if sqlx::query(
                "INSERT INTO shifts (id, user_id, start_time, starting_cash, status) VALUES (?, ?, CURRENT_TIMESTAMP, 0, 'open')"
            )
            .bind(&auto_shift_id)
            .bind(auto_user_id)
            .execute(&mut **tx)
            .await
            .is_ok()
            {
                shift_id_to_use = Some(auto_shift_id);
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
    .bind(&shift_id_to_use)
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
            SELECT md.trade_name, md.trade_name_en, md.active_ingredient, md.large_to_medium, md.medium_to_small, md.medium_unit, md.small_unit,
                   COALESCE(MAX(i.strips_per_box), 1) as max_strips
            FROM master_drugs md
            LEFT JOIN inventory i ON CAST(i.drug_id AS TEXT) = CAST(md.id AS TEXT)
              AND (i.pharmacy_id IS ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
              AND (i.expiry_date IS NULL OR i.expiry_date >= DATE('now', 'localtime'))
            WHERE CAST(md.id AS TEXT) = CAST(? AS TEXT)
            GROUP BY md.id
            "#,
        )
        .bind(&payload.pharmacy_id)
        .bind(&payload.pharmacy_id)
        .bind(item.drug_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

        let is_placeholder = |s: &str| {
            let t = s.trim();
            t.is_empty() || (t.to_lowercase().starts_with("drug ") || t.to_lowercase().starts_with("drug #"))
        };

        let drug_name = drug
            .as_ref()
            .and_then(|r| {
                let trade_name = r.try_get::<String, _>("trade_name").ok().unwrap_or_default();
                let trade_en = r.try_get::<String, _>("trade_name_en").ok().unwrap_or_default();
                let active = r.try_get::<String, _>("active_ingredient").ok().unwrap_or_default();
                if !is_placeholder(&trade_en) {
                    Some(trade_en)
                } else if !is_placeholder(&trade_name) {
                    Some(trade_name)
                } else if !is_placeholder(&active) {
                    Some(active)
                } else if !trade_name.is_empty() {
                    Some(trade_name)
                } else if !trade_en.is_empty() {
                    Some(trade_en)
                } else {
                    None
                }
            })
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
        let fallback_deduction_qty = sale_stock_qty(
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

        let selected_batch = if let Some(inventory_id) = &item.inventory_id {
            Some(
                sqlx::query(
                    "SELECT CAST(quantity AS REAL) AS quantity, strips_per_box FROM inventory WHERE id = ? AND drug_id = ? AND (pharmacy_id IS ? OR (pharmacy_id IS NULL AND ? = 'local_default')) AND (expiry_date IS NULL OR expiry_date >= DATE('now', 'localtime'))",
                )
                .bind(inventory_id)
                .bind(item.drug_id)
                .bind(&payload.pharmacy_id)
                .bind(&payload.pharmacy_id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Selected inventory batch is invalid or expired".to_string())?,
            )
        } else {
            None
        };
        let selected_stock = selected_batch
            .as_ref()
            .and_then(|row| row.try_get::<f64, _>("quantity").ok())
            .unwrap_or(0.0);
        let selected_large_to_medium = selected_batch
            .as_ref()
            .and_then(|row| row.try_get::<i64, _>("strips_per_box").ok())
            .filter(|value| *value > 0)
            .map(|value| value as f64)
            .unwrap_or(actual_large_to_medium);
        let selected_deduction_qty = sale_stock_qty(
            item.quantity_sold,
            &item.selected_unit,
            selected_large_to_medium,
            medium_to_small,
            medium_unit.as_deref(),
            small_unit.as_deref(),
        );
        if item.inventory_id.is_some() && selected_stock + 0.005 < selected_deduction_qty {
            return Err(format!(
                "Selected inventory batch has insufficient stock for \"{}\" (available: {:.2})",
                drug_name, selected_stock
            ));
        }
        let selected_inventory_id = item.inventory_id.as_deref();
        let deduction_qty = if selected_inventory_id.is_some() {
            selected_deduction_qty
        } else {
            fallback_deduction_qty
        };

        let stock_total: f64 = if selected_inventory_id.is_some() {
            selected_stock
        } else {
            sqlx::query(
                "SELECT CAST(COALESCE(SUM(quantity), 0) AS REAL) as total FROM inventory WHERE drug_id = ? AND (pharmacy_id IS ? OR (pharmacy_id IS NULL AND ? = 'local_default')) AND (expiry_date IS NULL OR expiry_date >= DATE('now', 'localtime'))",
            )
            .bind(item.drug_id)
            .bind(&payload.pharmacy_id)
            .bind(&payload.pharmacy_id)
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
                WHERE drug_id = ? AND (pharmacy_id IS ? OR (pharmacy_id IS NULL AND ? = 'local_default')) AND quantity > 0 AND (expiry_date IS NULL OR expiry_date >= DATE('now', 'localtime'))
                ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, created_at ASC
                "#,
            )
            .bind(item.drug_id)
            .bind(&payload.pharmacy_id)
            .bind(&payload.pharmacy_id)
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

        let cash = account_id(tx, "cash_drawer", "1.1.1").await?;
        let receivable = account_id(tx, "accounts_receivable", "1.1.2").await?;
        let sales = account_id(tx, "sales_revenue", "3.1").await?;
        let inventory = account_id(tx, "inventory_asset", "1.1.3").await?;
        let cogs = account_id(tx, "cogs_expense", "4.1").await?;
        let debit = match payload.payment_method.as_str() {
            "credit" => receivable,
            "wallet" => account_id(tx, "patient_wallet_liability", "2.2").await?,
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

fn normalize_valid_date_ymd(input: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = input else {
        return Ok(None);
    };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }

    let parts: Vec<&str> = value.split(&['/', '-'][..]).collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err(format!("Invalid calendar date '{value}'"));
    }

    let (year_text, month_text, day_text) = if parts[0].len() == 4 {
        (parts[0], parts[1], parts[2])
    } else if parts[2].len() == 4 {
        (parts[2], parts[1], parts[0])
    } else {
        return Err(format!("Invalid calendar date '{value}'"));
    };
    if !year_text.chars().all(|c| c.is_ascii_digit())
        || !month_text.chars().all(|c| c.is_ascii_digit())
        || !day_text.chars().all(|c| c.is_ascii_digit())
    {
        return Err(format!("Invalid calendar date '{value}'"));
    }

    let year = year_text
        .parse::<i32>()
        .map_err(|_| format!("Invalid calendar date '{value}'"))?;
    let month = month_text
        .parse::<u32>()
        .map_err(|_| format!("Invalid calendar date '{value}'"))?;
    let day = day_text
        .parse::<u32>()
        .map_err(|_| format!("Invalid calendar date '{value}'"))?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if year <= 0 || day == 0 || day > max_day {
        return Err(format!("Invalid calendar date '{value}'"));
    }

    Ok(Some(format!("{year:04}-{month:02}-{day:02}")))
}

fn normalize_pharmacy_id(input: Option<&str>) -> String {
    input
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local_default")
        .to_string()
}

pub(crate) fn user_can_view_purchases(role: Option<&str>, permissions: Option<&str>) -> bool {
    if role
        .is_some_and(|role| matches!(role.trim().to_ascii_lowercase().as_str(), "owner" | "admin"))
    {
        return true;
    }

    let Some(raw_permissions) = permissions else {
        return false;
    };
    let mut value = Value::String(raw_permissions.to_string());
    for _ in 0..3 {
        let Value::String(encoded) = &value else {
            break;
        };
        value = match serde_json::from_str(encoded) {
            Ok(decoded) => decoded,
            Err(_) => return false,
        };
    }

    let Some(permission) = value
        .as_object()
        .and_then(|permissions| permissions.get("can_view_purchases"))
    else {
        return false;
    };
    match permission {
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64() == Some(1.0),
        Value::String(value) => matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1"),
        _ => false,
    }
}

fn purchase_item_total(item: &PurchaseItem, invoice_tax_percent: f64) -> f64 {
    item.quantity
        * item.cost_price
        * (1.0 + item.tax_percent / 100.0)
        * (1.0 + invoice_tax_percent / 100.0)
}

// ponytail: one rule keeps purchased stock and its later return on the same net cost.
pub(crate) fn purchase_inventory_paid_factor(
    items_total: f64,
    expenses: f64,
    discount_value: f64,
    discount_percent: f64,
) -> f64 {
    if items_total <= f64::EPSILON {
        return 1.0;
    }
    let invoice_base = items_total + expenses;
    ((invoice_base - discount_value).max(0.0) / items_total) * (1.0 - discount_percent / 100.0)
}

fn validate_purchase_payload(payload: &PurchasePayload) -> Result<(f64, f64), String> {
    if payload.supplier_id <= 0 || payload.user_id.trim().is_empty() {
        return Err("Invalid purchase identity".into());
    }
    if !matches!(
        payload.status.as_deref().unwrap_or("completed"),
        "draft" | "completed"
    ) {
        return Err("Invalid purchase status".into());
    }
    if !matches!(
        payload.payment_method.as_deref().unwrap_or("credit"),
        "cash" | "credit" | "check"
    ) {
        return Err("Invalid purchase payment method".into());
    }
    if payload.status.as_deref() != Some("draft")
        && payload.payment_method.as_deref() == Some("check")
        && payload
            .check_number
            .as_deref()
            .map(str::trim)
            .filter(|number| !number.is_empty())
            .is_none()
    {
        return Err("Check number is required for check purchases".into());
    }
    if !payload.expenses.is_finite()
        || payload.expenses < 0.0
        || !payload.discount_value.is_finite()
        || payload.discount_value < 0.0
        || !payload.discount_percent.is_finite()
        || !(0.0..=100.0).contains(&payload.discount_percent)
        || !payload.tax_percent.is_finite()
        || !(0.0..=100.0).contains(&payload.tax_percent)
    {
        return Err("Invalid purchase totals".into());
    }
    validate_purchase_items(&payload.cart)?;
    if payload.status.as_deref() != Some("draft")
        && payload.cart.iter().any(|item| item.cost_price <= 0.0)
    {
        return Err("Completed purchase items require a positive cost price".into());
    }
    let items_total: f64 = payload
        .cart
        .iter()
        .map(|item| purchase_item_total(item, payload.tax_percent))
        .sum();
    let invoice_base = items_total + payload.expenses;
    if !items_total.is_finite()
        || (payload.status.as_deref() != Some("draft") && items_total <= 0.0)
        || !invoice_base.is_finite()
        || payload.discount_value > invoice_base + 0.000_001
    {
        return Err("Invalid purchase discount".into());
    }
    Ok((
        items_total,
        purchase_inventory_paid_factor(
            items_total,
            payload.expenses,
            payload.discount_value,
            payload.discount_percent,
        ),
    ))
}

fn validate_purchase_items(items: &[PurchaseItem]) -> Result<(), String> {
    if items.is_empty() {
        return Err("Purchase items are required".into());
    }
    let mut lots = HashSet::with_capacity(items.len());
    for item in items {
        if !item.quantity.is_finite() || item.quantity <= 0.0 {
            return Err(format!("Invalid quantity for drug {}", item.id));
        }
        if !item.cost_price.is_finite() || item.cost_price < 0.0 {
            return Err(format!("Invalid cost price for drug {}", item.id));
        }
        if !item.bonus_quantity.is_finite() || item.bonus_quantity < 0.0 {
            return Err(format!("Invalid bonus quantity for drug {}", item.id));
        }
        if item
            .selling_price
            .is_some_and(|price| !price.is_finite() || price < 0.0)
            || !item.tax_percent.is_finite()
            || !(0.0..=100.0).contains(&item.tax_percent)
            || !item.discount_percent.is_finite()
            || !(0.0..=100.0).contains(&item.discount_percent)
        {
            return Err(format!("Invalid price or percentage for drug {}", item.id));
        }
        if item.strips_per_box <= 0 {
            return Err(format!("Invalid unit conversion for drug {}", item.id));
        }
        let normalized_expiry = normalize_date_ymd(item.expiry_date.as_deref());
        if !lots.insert((item.id, normalized_expiry)) {
            return Err(format!(
                "Duplicate purchase lot for drug {}; combine lines with the same expiry date",
                item.id
            ));
        }
    }
    Ok(())
}

fn purchase_batch_number(invoice_number: Option<&str>, invoice_id: &str) -> String {
    invoice_number
        .filter(|number| !number.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("BATCH-{}", &invoice_id[..invoice_id.len().min(8)]))
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
    if let Some(id) =
        find_inventory_for_batch(tx, drug_id, pharmacy_id, expiry_date, batch_number).await?
    {
        let existing = sqlx::query(
            "SELECT CAST(COALESCE(quantity, 0) AS REAL) AS quantity, CAST(COALESCE(cost_price, 0) AS REAL) AS cost_price FROM inventory WHERE id = ?",
        )
        .bind(&id)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        let existing_quantity: f64 = existing.try_get("quantity").unwrap_or(0.0);
        let existing_cost: f64 = existing.try_get("cost_price").unwrap_or(0.0);
        let merged_quantity = existing_quantity + quantity;
        let merged_cost = if merged_quantity > f64::EPSILON {
            (existing_quantity * existing_cost + quantity * cost_price) / merged_quantity
        } else {
            cost_price
        };
        sqlx::query(
            "UPDATE inventory SET quantity = ?, pharmacy_id = COALESCE(pharmacy_id, ?), local_selling_price = ?, cost_price = ?, expiry_date = ?, batch_number = ?, strips_per_box = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(merged_quantity)
        .bind(pharmacy_id)
        .bind(selling_price)
        .bind(merged_cost)
        .bind(expiry_date)
        .bind(batch_number)
        .bind(strips_per_box)
        .bind(&id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        consolidate_inventory_rows(tx, drug_id, pharmacy_id, expiry_date, batch_number, &id)
            .await?;
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
    batch_number: &str,
) -> Result<Option<String>, String> {
    let row = sqlx::query(
        "SELECT id FROM inventory WHERE drug_id = ? AND (pharmacy_id IS ? OR (pharmacy_id IS NULL AND ? = 'local_default')) AND expiry_date IS ? AND batch_number IS ? ORDER BY CASE WHEN pharmacy_id IS ? THEN 0 ELSE 1 END, created_at ASC LIMIT 1",
    )
    .bind(drug_id)
    .bind(pharmacy_id)
    .bind(pharmacy_id)
    .bind(expiry_date)
    .bind(batch_number)
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
    pharmacy_id: Option<&str>,
    expiry_date: Option<&str>,
    batch_number: &str,
    keep_id: &str,
) -> Result<(), String> {
    let aggregate = sqlx::query(
        "SELECT COUNT(*) AS rows, CAST(COALESCE(SUM(quantity), 0) AS REAL) AS total_quantity, CAST(COALESCE(SUM(quantity * COALESCE(cost_price, 0)), 0) AS REAL) AS carrying_value FROM inventory WHERE drug_id = ? AND (pharmacy_id IS ? OR (pharmacy_id IS NULL AND ? = 'local_default')) AND expiry_date IS ? AND batch_number IS ?",
    )
    .bind(drug_id)
    .bind(pharmacy_id)
    .bind(pharmacy_id)
    .bind(expiry_date)
    .bind(batch_number)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    let row_count: i64 = aggregate.try_get("rows").unwrap_or(0);
    let total_quantity: f64 = aggregate.try_get("total_quantity").unwrap_or(0.0);
    let carrying_value: f64 = aggregate.try_get("carrying_value").unwrap_or(0.0);

    if row_count > 1 {
        let weighted_cost = if total_quantity.abs() > f64::EPSILON {
            carrying_value / total_quantity
        } else {
            0.0
        };
        sqlx::query("UPDATE inventory SET quantity = ?, cost_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(total_quantity)
            .bind(weighted_cost)
            .bind(keep_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("UPDATE inventory SET quantity = 0, updated_at = CURRENT_TIMESTAMP WHERE drug_id = ? AND (pharmacy_id IS ? OR (pharmacy_id IS NULL AND ? = 'local_default')) AND expiry_date IS ? AND batch_number IS ? AND id <> ?")
            .bind(drug_id)
            .bind(pharmacy_id)
            .bind(pharmacy_id)
            .bind(expiry_date)
            .bind(batch_number)
            .bind(keep_id)
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
    inventory_paid_factor: f64,
) -> Result<(), String> {
    struct OldPurchaseLine {
        id: i64,
        drug_id: i64,
        quantity: f64,
        expiry: Option<String>,
        inventory_id: Option<String>,
    }

    let old_rows = sqlx::query(
        "SELECT id, drug_id, CAST(quantity + COALESCE(bonus_quantity, 0) AS REAL) AS quantity, expiry_date, inventory_id FROM purchase_invoice_items WHERE invoice_id = ? ORDER BY id",
    )
    .bind(invoice_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    let mut old_items = Vec::with_capacity(old_rows.len());
    for row in old_rows {
        let expiry_raw: Option<String> = row.try_get("expiry_date").unwrap_or(None);
        old_items.push(OldPurchaseLine {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            drug_id: row.try_get("drug_id").map_err(|e| e.to_string())?,
            quantity: row.try_get("quantity").map_err(|e| e.to_string())?,
            expiry: normalize_date_ymd(expiry_raw.as_deref()),
            inventory_id: row.try_get("inventory_id").unwrap_or(None),
        });
    }
    let old_pharmacy_id: Option<String> = old_invoice.try_get("pharmacy_id").unwrap_or(None);
    let old_invoice_number: Option<String> = old_invoice.try_get("invoice_number").unwrap_or(None);
    let old_batch_number = purchase_batch_number(old_invoice_number.as_deref(), invoice_id);
    let new_pharmacy_id = payload.pharmacy_id.as_deref();
    let new_batch_number = purchase_batch_number(payload.invoice_number.as_deref(), invoice_id);
    let old_pharmacy_scope = normalize_pharmacy_id(old_pharmacy_id.as_deref());
    let new_pharmacy_scope = normalize_pharmacy_id(new_pharmacy_id);

    let mut original_by_inventory = HashMap::<String, (i64, f64)>::new();
    for old_item in &mut old_items {
        let inventory_id = match old_item.inventory_id.as_ref() {
            Some(id) => id.clone(),
            None => find_inventory_for_batch(
                tx,
                old_item.drug_id,
                old_pharmacy_id.as_deref(),
                old_item.expiry.as_deref(),
                &old_batch_number,
            )
            .await?
            .ok_or_else(|| {
                format!(
                    "Linked inventory batch missing for purchase item {}",
                    old_item.id
                )
            })?,
        };
        consolidate_inventory_rows(
            tx,
            old_item.drug_id,
            old_pharmacy_id.as_deref(),
            old_item.expiry.as_deref(),
            &old_batch_number,
            &inventory_id,
        )
        .await?;
        let entry = original_by_inventory
            .entry(inventory_id.clone())
            .or_insert((old_item.drug_id, 0.0));
        if entry.0 != old_item.drug_id {
            return Err("Purchase inventory link points to the wrong drug".into());
        }
        entry.1 += old_item.quantity;
        old_item.inventory_id = Some(inventory_id);
    }
    for (inventory_id, (drug_id, original_quantity)) in &original_by_inventory {
        let available: f64 = sqlx::query(
            "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE id = ? AND drug_id = ?",
        )
        .bind(inventory_id)
        .bind(drug_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Linked inventory batch {} is missing", inventory_id))?
        .try_get("quantity")
        .map_err(|e| e.to_string())?;
        if available + 0.000_001 < *original_quantity {
            return Err(format!(
                "Cannot edit completed purchase; inventory for drug {} has already been consumed",
                drug_id
            ));
        }
    }

    let mut old_to_new = vec![None; old_items.len()];
    let mut new_matched = vec![false; payload.cart.len()];

    for (new_index, new_item) in payload.cart.iter().enumerate() {
        let Some(line_id) = new_item.purchase_invoice_item_id else {
            continue;
        };
        let old_index = old_items
            .iter()
            .position(|old| old.id == line_id)
            .ok_or_else(|| {
                format!(
                    "Purchase invoice item {} does not belong to this invoice",
                    line_id
                )
            })?;
        if old_to_new[old_index].is_some() {
            return Err(format!(
                "Purchase invoice item {} was supplied more than once",
                line_id
            ));
        }
        if old_items[old_index].drug_id != new_item.id {
            return Err(format!(
                "Purchase invoice item {} does not match drug {}",
                line_id, new_item.id
            ));
        }
        old_to_new[old_index] = Some(new_index);
        new_matched[new_index] = true;
    }

    for (new_index, new_item) in payload.cart.iter().enumerate() {
        if new_matched[new_index] {
            continue;
        }
        let new_expiry = normalize_date_ymd(new_item.expiry_date.as_deref());
        if let Some(old_index) = old_items.iter().enumerate().position(|(index, old)| {
            old_to_new[index].is_none() && old.drug_id == new_item.id && old.expiry == new_expiry
        }) {
            old_to_new[old_index] = Some(new_index);
            new_matched[new_index] = true;
        }
    }

    for (old_index, old_item) in old_items.iter().enumerate() {
        let drug_id = old_item.drug_id;
        let old_qty = old_item.quantity;
        let old_expiry = old_item.expiry.as_deref();
        let new_item = old_to_new[old_index].map(|new_index| &payload.cart[new_index]);
        let new_qty = new_item
            .map(|item| item.quantity + item.bonus_quantity)
            .unwrap_or(0.0);

        let inv_id = match old_item.inventory_id.as_ref() {
            Some(id) => id.clone(),
            None => find_inventory_for_batch(
                tx,
                drug_id,
                old_pharmacy_id.as_deref(),
                old_expiry,
                &old_batch_number,
            )
            .await?
            .ok_or_else(|| format!("Inventory batch missing for drug {}", drug_id))?,
        };
        consolidate_inventory_rows(
            tx,
            drug_id,
            old_pharmacy_id.as_deref(),
            old_expiry,
            &old_batch_number,
            &inv_id,
        )
        .await?;
        let inv = sqlx::query(
            "SELECT CAST(quantity AS REAL) as quantity FROM inventory WHERE id = ? AND drug_id = ?",
        )
        .bind(&inv_id)
        .bind(drug_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Linked inventory batch missing for drug {}", drug_id))?;
        let inv_qty: f64 = inv.try_get("quantity").map_err(|e| e.to_string())?;
        let new_expiry = new_item.and_then(|item| normalize_date_ymd(item.expiry_date.as_deref()));
        let same_batch = new_item.is_some()
            && new_expiry.as_deref() == old_expiry
            && new_pharmacy_scope == old_pharmacy_scope
            && new_batch_number == old_batch_number;
        let amount_to_remove = if same_batch {
            (old_qty - new_qty).max(0.0)
        } else {
            old_qty
        };
        if inv_qty + 0.000_001 < amount_to_remove {
            return Err(format!(
                "Cannot edit purchase; drug {} stock has already been sold",
                drug_id
            ));
        }
        if let Some(new_item) = new_item {
            let net_unit_cost = if new_qty > 0.0 {
                purchase_item_total(new_item, payload.tax_percent) * inventory_paid_factor / new_qty
            } else {
                new_item.cost_price
            };
            if same_batch {
                sqlx::query("UPDATE inventory SET quantity = quantity + ?, local_selling_price = ?, cost_price = ?, batch_number = ?, strips_per_box = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                    .bind(new_qty - old_qty)
                    .bind(new_item.selling_price.unwrap_or(0.0))
                    .bind(net_unit_cost)
                    .bind(&new_batch_number)
                    .bind(new_item.strips_per_box)
                    .bind(&inv_id)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| e.to_string())?;
            } else {
                sqlx::query("UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                    .bind(old_qty)
                    .bind(&inv_id)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| e.to_string())?;
                add_purchase_inventory(
                    tx,
                    drug_id,
                    new_pharmacy_id,
                    new_qty,
                    new_item.selling_price.unwrap_or(0.0),
                    net_unit_cost,
                    new_expiry.as_deref(),
                    &new_batch_number,
                    new_item.strips_per_box,
                )
                .await?;
            }
        } else {
            sqlx::query("UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(old_qty)
                .bind(&inv_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    for (new_index, new_item) in payload.cart.iter().enumerate() {
        if new_matched[new_index] {
            continue;
        }
        let total_received = new_item.quantity + new_item.bonus_quantity;
        let net_unit_cost = if total_received > 0.0 {
            purchase_item_total(new_item, payload.tax_percent) * inventory_paid_factor
                / total_received
        } else {
            new_item.cost_price
        };
        let expiry = normalize_date_ymd(new_item.expiry_date.as_deref());
        add_purchase_inventory(
            tx,
            new_item.id,
            new_pharmacy_id,
            total_received,
            new_item.selling_price.unwrap_or(0.0),
            net_unit_cost,
            expiry.as_deref(),
            &new_batch_number,
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

async fn ensure_no_finalized_purchase_returns(
    tx: &mut Transaction<'_, Sqlite>,
    invoice_id: &str,
    operation: &str,
) -> Result<(), String> {
    if sqlx::query(
        "SELECT 1 FROM purchase_returns WHERE purchase_invoice_id = ? AND LOWER(COALESCE(status, '')) IN ('completed', 'approved') LIMIT 1",
    )
    .bind(invoice_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .is_some()
    {
        return Err(format!(
            "Cannot {} purchase invoice; delete its completed purchase returns first",
            operation
        ));
    }
    Ok(())
}

pub(crate) async fn delete_purchase_invoice_tx(
    tx: &mut Transaction<'_, Sqlite>,
    invoice_id: &str,
    remove_inventory: bool,
    user_id: &str,
    pharmacy_id: Option<&str>,
) -> Result<(), String> {
    let requested_pharmacy = normalize_pharmacy_id(pharmacy_id);
    let user = sqlx::query(
        "SELECT pharmacy_id, role, permissions FROM users WHERE CAST(id AS TEXT) = ? AND COALESCE(is_active, 1) = 1",
    )
    .bind(user_id.trim())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Purchase user does not exist or is inactive".to_string())?;
    let user_role: Option<String> = user.try_get("role").unwrap_or(None);
    let user_permissions: Option<String> = user.try_get("permissions").unwrap_or(None);
    if !user_can_view_purchases(user_role.as_deref(), user_permissions.as_deref()) {
        return Err("Unauthorized: can_view_purchases permission required".into());
    }
    let user_pharmacy: Option<String> = user.try_get("pharmacy_id").unwrap_or(None);
    if normalize_pharmacy_id(user_pharmacy.as_deref()) != requested_pharmacy {
        return Err("Purchase pharmacy does not match the current user".into());
    }

    let invoice = sqlx::query("SELECT supplier_id, total_amount, payment_method, status, invoice_number, pharmacy_id FROM purchase_invoices WHERE id = ?")
        .bind(invoice_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Purchase invoice not found".to_string())?;
    let invoice_pharmacy: Option<String> = invoice.try_get("pharmacy_id").unwrap_or(None);
    if normalize_pharmacy_id(invoice_pharmacy.as_deref()) != requested_pharmacy {
        return Err("Purchase invoice belongs to another pharmacy".into());
    }

    let status: String = invoice.try_get("status").unwrap_or_default();
    if status == "completed" {
        ensure_no_finalized_purchase_returns(tx, invoice_id, "delete").await?;
    }
    if status == "completed" && remove_inventory {
        let pharmacy_id: Option<String> = invoice.try_get("pharmacy_id").unwrap_or(None);
        let invoice_number: Option<String> = invoice.try_get("invoice_number").unwrap_or(None);
        let batch_number = purchase_batch_number(invoice_number.as_deref(), invoice_id);
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
                None => find_inventory_for_batch(
                    tx,
                    drug_id,
                    pharmacy_id.as_deref(),
                    expiry.as_deref(),
                    &batch_number,
                )
                .await?
                .ok_or_else(|| format!("Inventory batch missing for drug {}", drug_id))?,
            };
            let available: f64 = sqlx::query(
                "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE id = ? AND drug_id = ?",
            )
            .bind(&inventory_id)
            .bind(drug_id)
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

    if status == "completed" && remove_inventory {
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
    supplier_id: i64,
    user_id: &str,
) -> Result<(), String> {
    let journal_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, COALESCE(?, DATE('now', 'localtime')), ?, ?, ?)")
        .bind(&journal_id)
        .bind(&payload.invoice_date)
        .bind(format!("Purchase invoice {}", payload.invoice_number.as_deref().unwrap_or(&invoice_id[..8])))
        .bind(user_id)
        .bind(total_amount)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let cash = account_id(tx, "cash_drawer", "1.1.1").await?;
    let payable = account_id(tx, "accounts_payable", "2.1").await?;
    let inventory = account_id(tx, "inventory_asset", "1.1.3").await?;
    insert_journal_entry(tx, &journal_id, inventory, "debit", total_amount).await?;

    let supplier_note = format!(
        "Purchase invoice {}",
        payload.invoice_number.as_deref().unwrap_or(invoice_id)
    );
    sqlx::query("INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, 'invoice', ?, ?, ?)")
        .bind(supplier_id)
        .bind(total_amount)
        .bind(invoice_id)
        .bind(&supplier_note)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    if payment_method == "credit" || payment_method == "check" {
        sqlx::query("UPDATE suppliers SET balance = balance + ? WHERE id = ?")
            .bind(total_amount)
            .bind(supplier_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        insert_journal_entry(tx, &journal_id, payable, "credit", total_amount).await?;
    } else {
        sqlx::query("INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes) VALUES (?, 'payment', ?, ?, ?)")
            .bind(supplier_id)
            .bind(-total_amount)
            .bind(invoice_id)
            .bind(format!("Cash payment for {supplier_note}"))
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        insert_journal_entry(tx, &journal_id, cash, "credit", total_amount).await?;
        if let Some(open_shift) =
            sqlx::query("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'")
                .bind(user_id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|e| e.to_string())?
        {
            let shift_id: String = open_shift.try_get("id").map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO cash_movements (id, user_id, shift_id, type, amount, category, notes, date) VALUES (?, ?, ?, 'disbursement', ?, 'purchases', ?, DATE('now', 'localtime'))")
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(user_id)
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
    selling_price: f64,
) -> Result<String, String> {
    let pharmacy_scope = normalize_pharmacy_id(pharmacy_id);
    if let Some(id) = inventory_id {
        if sqlx::query("SELECT 1 FROM inventory WHERE id = ? AND drug_id IS ? AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))")
            .bind(id)
            .bind(drug_id)
            .bind(&pharmacy_scope)
            .bind(&pharmacy_scope)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Ok(id.to_string());
        }
    }
    let drug_id = drug_id.ok_or_else(|| "Return item is missing drug id".to_string())?;

    if let Some(row) = sqlx::query(
        "SELECT id FROM inventory WHERE drug_id = ? AND (pharmacy_id IS ? OR (pharmacy_id IS NULL AND ? = 'local_default')) ORDER BY CASE WHEN pharmacy_id IS ? THEN 0 ELSE 1 END, CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, created_at ASC LIMIT 1",
    )
        .bind(drug_id)
        .bind(&pharmacy_scope)
        .bind(&pharmacy_scope)
        .bind(&pharmacy_scope)
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
    sqlx::query("INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, expiry_date, quantity, local_selling_price, cost_price, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
        .bind(&id)
        .bind(&pharmacy_scope)
        .bind(drug_id)
        .bind(batch)
        .bind(selling_price)
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

    let cash = account_id(tx, "cash_drawer", "1.1.1").await?;
    let receivable = account_id(tx, "accounts_receivable", "1.1.2").await?;
    let sales = account_id(tx, "sales_revenue", "3.1").await?;
    let inventory = account_id(tx, "inventory_asset", "1.1.3").await?;
    let cogs = account_id(tx, "cogs_expense", "4.1").await?;
    let credit_account = match payload.refund_method.as_str() {
        "patient_account" => receivable,
        "wallet" => account_id(tx, "patient_wallet_liability", "2.2").await?,
        "bank" => account_id(tx, "bank_clearing", "1.1.4").await?,
        _ => cash,
    };

    insert_journal_entry(tx, &journal_id, sales, "debit", total_refund).await?;
    insert_journal_entry(tx, &journal_id, credit_account, "credit", total_refund).await?;
    if total_cogs_reversal > 0.0 {
        insert_journal_entry(tx, &journal_id, inventory, "debit", total_cogs_reversal).await?;
        insert_journal_entry(tx, &journal_id, cogs, "credit", total_cogs_reversal).await?;
    }

    if payload.refund_method == "wallet" {
        let patient_id = payload
            .patient_id
            .as_deref()
            .ok_or_else(|| "Wallet returns require the invoice patient".to_string())?;
        let update = sqlx::query(
            "UPDATE patients SET wallet_balance = COALESCE(wallet_balance, 0) + ? WHERE id = ?",
        )
        .bind(total_refund)
        .bind(patient_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if update.rows_affected() != 1 {
            return Err("Invoice patient no longer exists".into());
        }
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
    expected_code: &str,
) -> Result<i64, String> {
    let row = sqlx::query("SELECT a.id FROM trial_balance_settings t JOIN accounts a ON a.id = t.account_id WHERE t.category = ? AND a.code = ? LIMIT 1")
        .bind(category)
        .bind(expected_code)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(id) = row.and_then(|r| r.try_get::<i64, _>("id").ok()) {
        return Ok(id);
    }
    sqlx::query("SELECT id FROM accounts WHERE code = ?")
        .bind(expected_code)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .and_then(|r| r.try_get::<i64, _>("id").ok())
        .ok_or_else(|| {
            format!(
                "Accounting setup is missing '{}' (account code {}); restart after installing the update",
                category, expected_code
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
        purchase_inventory_paid_factor, return_quantity_in_sale_unit, return_restock_qty,
        sale_stock_qty, save_purchase_invoice_tx, settle_negative_sale_item_tx,
        user_can_view_purchases, validate_purchase_items, validate_write_sql, CheckoutItem,
        CheckoutPayload, NegativeStockSettlementPayload, PurchaseItem, PurchasePayload, ReturnItem,
        ReturnPayload,
    };
    use crate::commands::purchase_returns::{
        run_purchase_return_transaction, PurchaseReturnItem, PurchaseReturnPayload,
    };
    use sqlx::{Connection, Row, SqliteConnection};

    async fn current_fresh_schema() -> SqliteConnection {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut connection)
            .await
            .unwrap();
        for migration in [
            include_str!("../../migrations/001_initial.sql"),
            include_str!("../../migrations/002_performance.sql"),
            include_str!("../../migrations/003_sync_metadata.sql"),
            include_str!("../../migrations/004_return_items_patch.sql"),
            include_str!("../../migrations/005_purchase_return_details.sql"),
            include_str!("../../migrations/006_accounting_upgrade_seed.sql"),
            include_str!("../../migrations/007_purchase_inventory_links.sql"),
            include_str!("../../migrations/008_patient_accounting.sql"),
            include_str!("../../migrations/009_rebuild_master_drugs_fts.sql"),
        ] {
            sqlx::raw_sql(migration)
                .execute(&mut connection)
                .await
                .unwrap();
        }
        connection
    }

    #[test]
    fn purchase_permission_parser_matches_frontend() {
        assert!(user_can_view_purchases(Some("owner"), None));
        assert!(user_can_view_purchases(Some("ADMIN"), Some("{}")));
        assert!(user_can_view_purchases(
            Some("cashier"),
            Some(r#"{"can_view_purchases":"true"}"#),
        ));
        assert!(user_can_view_purchases(
            Some("cashier"),
            Some(r#""{\"can_view_purchases\":1}""#),
        ));
        assert!(!user_can_view_purchases(
            Some("cashier"),
            Some(r#"{"can_view_purchases":false}"#),
        ));
        assert!(!user_can_view_purchases(Some("cashier"), Some("invalid")));
    }

    fn fresh_purchase_line(
        expiry: &str,
        quantity: f64,
        bonus_quantity: f64,
        line_id: Option<i64>,
    ) -> PurchaseItem {
        PurchaseItem {
            purchase_invoice_item_id: line_id,
            id: 90_001,
            quantity,
            unit_id: Some(1),
            expiry_date: Some(expiry.into()),
            cost_price: 100.0,
            selling_price: Some(150.0),
            bonus_quantity,
            tax_percent: 10.0,
            discount_percent: 33.333_333,
            strips_per_box: 10,
            barcode: Some("CUSTOM-90001".into()),
        }
    }

    fn fresh_purchase(
        id: &str,
        invoice_number: &str,
        payment_method: &str,
        status: &str,
        cart: Vec<PurchaseItem>,
    ) -> PurchasePayload {
        PurchasePayload {
            id: Some(id.into()),
            supplier_id: 1,
            pharmacy_id: Some("fresh-pharmacy".into()),
            user_id: "fresh-admin".into(),
            invoice_number: Some(invoice_number.into()),
            invoice_date: Some("2026-08-12".into()),
            payment_method: Some(payment_method.into()),
            notes: Some("fresh lifecycle".into()),
            check_number: (payment_method == "check").then(|| "CHK-001".into()),
            expenses: 0.0,
            discount_value: 0.0,
            discount_percent: 0.0,
            tax_percent: 5.0,
            status: Some(status.into()),
            cart,
        }
    }

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
        let mut payload: PurchasePayload = serde_json::from_value(serde_json::json!({
            "supplier_id": "10",
            "user_id": "u1",
            "expenses": "2.5",
            "discount_value": "",
            "cart": [{
                "purchase_invoice_item_id": "55",
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
        assert_eq!(payload.cart[0].purchase_invoice_item_id, Some(55));
        assert_eq!(payload.cart[0].quantity, 10.0);
        assert_eq!(payload.cart[0].unit_id, None);
        assert_eq!(payload.cart[0].selling_price, Some(12.0));
        assert_eq!(payload.cart[0].strips_per_box, 10);
        assert!(validate_purchase_items(&payload.cart).is_ok());
        payload.cart[0].quantity = 0.0;
        assert!(validate_purchase_items(&payload.cart).is_err());
        payload.cart[0].quantity = 1.0;
        payload.cart[0].cost_price = -1.0;
        assert!(validate_purchase_items(&payload.cart).is_err());
        payload.cart[0].cost_price = 1.0;
        payload.cart[0].bonus_quantity = -1.0;
        assert!(validate_purchase_items(&payload.cart).is_err());
        payload.cart[0].bonus_quantity = 0.0;
        payload.cart[0].strips_per_box = 0;
        assert!(validate_purchase_items(&payload.cart).is_err());
        payload.cart[0].strips_per_box = 10;
        payload.cart[0].expiry_date = Some("13/08/2030".into());
        payload.cart.push(PurchaseItem {
            purchase_invoice_item_id: None,
            id: 123,
            quantity: 2.0,
            unit_id: None,
            expiry_date: Some("2030-08-13".into()),
            cost_price: 8.0,
            selling_price: Some(12.0),
            bonus_quantity: 0.0,
            tax_percent: 0.0,
            discount_percent: 0.0,
            strips_per_box: 10,
            barcode: None,
        });
        assert!(validate_purchase_items(&payload.cart)
            .unwrap_err()
            .contains("Duplicate purchase lot"));
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
    async fn purchase_inventory_scopes_pharmacy_expiry_and_batch() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity INTEGER, local_selling_price REAL, cost_price REAL, expiry_date TEXT, batch_number TEXT, strips_per_box INTEGER, created_at TEXT, updated_at TEXT)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, batch_number, created_at) VALUES ('old', 4463, NULL, 1, 20, '2026-07-22', 'INV-1', '2026-01-01'), ('old-duplicate', 4463, NULL, 2, 10, '2026-07-22', 'INV-1', '2026-01-02')")
            .execute(&mut conn)
            .await
            .unwrap();

        let mut tx = conn.begin().await.unwrap();
        add_purchase_inventory(
            &mut tx,
            4463,
            Some("local_default"),
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
            Some("local_default"),
            5.0,
            69.0,
            40.0,
            Some("2026-07-22"),
            "INV-2",
            1,
        )
        .await
        .unwrap();
        add_purchase_inventory(
            &mut tx,
            4463,
            Some("ph-002"),
            4.0,
            69.0,
            40.0,
            Some("2026-07-22"),
            "INV-1",
            1,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let row = sqlx::query("SELECT COUNT(*) as rows, SUM(quantity) as qty FROM inventory WHERE drug_id = 4463 AND quantity > 0")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(row.try_get::<i64, _>("rows").unwrap(), 3);
        assert_eq!(row.try_get::<i64, _>("qty").unwrap(), 18);
        let legacy: f64 = sqlx::query(
            "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE id = 'old'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("quantity")
        .unwrap();
        assert_eq!(legacy, 9.0);
        let merged_carrying_value: f64 = sqlx::query_scalar(
            "SELECT CAST(quantity * cost_price AS REAL) FROM inventory WHERE id = 'old'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!((merged_carrying_value - (20.0 + 2.0 * 10.0 + 6.0 * 40.0)).abs() < 0.001);
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'old-duplicate'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0.0
        );
    }

    #[tokio::test]
    async fn completed_purchase_reduction_and_taxes_update_inventory() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, large_to_medium INTEGER, barcode TEXT)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity INTEGER, local_selling_price REAL, cost_price REAL, expiry_date TEXT, barcode TEXT, batch_number TEXT, strips_per_box INTEGER, created_at TEXT, updated_at TEXT)",
            "CREATE TABLE purchase_invoices (id TEXT PRIMARY KEY, supplier_id INTEGER, pharmacy_id TEXT, user_id TEXT, invoice_number TEXT, invoice_date TEXT, payment_method TEXT, notes TEXT, check_number TEXT, expenses REAL, discount_value REAL, discount_percent REAL, tax_percent REAL, status TEXT, total_amount REAL)",
            "CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT, drug_id INTEGER, quantity INTEGER, unit_id INTEGER, expiry_date TEXT, cost_price REAL, selling_price REAL, bonus_quantity INTEGER, tax_percent REAL, discount_percent REAL, strips_per_box INTEGER, inventory_id TEXT)",
            "CREATE TABLE purchase_returns (purchase_invoice_id TEXT, status TEXT)",
            "CREATE TABLE suppliers (id INTEGER PRIMARY KEY, balance REAL)",
            "CREATE TABLE users (id TEXT PRIMARY KEY, pharmacy_id TEXT, role TEXT, permissions TEXT, is_active INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT)",
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
        let nested_purchase_permissions =
            serde_json::to_string(r#"{"can_view_purchases":true}"#).unwrap();
        sqlx::query("INSERT INTO users (id, pharmacy_id, role, permissions, is_active) VALUES ('admin', 'ph-001', 'cashier', ?, 1)")
            .bind(&nested_purchase_permissions)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO accounts (id, code) VALUES (6, '1.1.1'), (7, '2.1'), (10, '1.1.3')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO trial_balance_settings (category, account_id) VALUES ('cash_drawer', 6), ('accounts_payable', 7), ('inventory_asset', 10)")
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
                purchase_invoice_item_id: None,
                id: 4463,
                quantity,
                unit_id: None,
                expiry_date: Some("2099-08-13".into()),
                cost_price: 10.0,
                selling_price: Some(20.0),
                bonus_quantity: 0.0,
                tax_percent: 10.0,
                discount_percent: 0.0,
                strips_per_box: 1,
                barcode: None,
            }],
        };

        let mut missing_supplier = purchase(1.0);
        missing_supplier.supplier_id = 999;
        let mut tx = conn.begin().await.unwrap();
        let supplier_error = save_purchase_invoice_tx(&mut tx, missing_supplier)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(supplier_error.contains("supplier 999 does not exist"));

        let mut missing_user = purchase(1.0);
        missing_user.user_id = "missing-user".into();
        let mut tx = conn.begin().await.unwrap();
        let user_error = save_purchase_invoice_tx(&mut tx, missing_user)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(user_error.contains("user 'missing-user' does not exist"));
        let invoice_count: i64 = sqlx::query("SELECT COUNT(*) AS total FROM purchase_invoices")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("total")
            .unwrap();
        assert_eq!(invoice_count, 0);

        sqlx::query("UPDATE users SET permissions = '{}' WHERE id = 'admin'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let permission_error = save_purchase_invoice_tx(&mut tx, purchase(1.0))
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(permission_error.contains("can_view_purchases"));
        sqlx::query("UPDATE users SET permissions = ? WHERE id = 'admin'")
            .bind(&nested_purchase_permissions)
            .execute(&mut conn)
            .await
            .unwrap();

        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, purchase(6.0))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let cash_history = sqlx::query(
            "SELECT COUNT(*) AS rows, CAST(COALESCE(SUM(amount), 0) AS REAL) AS net FROM supplier_transactions WHERE reference_id = 'purchase-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(cash_history.try_get::<i64, _>("rows").unwrap(), 2);
        assert!(cash_history.try_get::<f64, _>("net").unwrap().abs() < 0.001);
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT CAST(balance AS REAL) FROM suppliers WHERE id = 1"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0.0
        );

        sqlx::query("INSERT INTO purchase_returns VALUES ('purchase-1', 'approved')")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let linked_return_error = save_purchase_invoice_tx(&mut tx, purchase(5.0))
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(linked_return_error.contains("completed purchase returns"));
        let mut tx = conn.begin().await.unwrap();
        let linked_return_delete_error =
            delete_purchase_invoice_tx(&mut tx, "purchase-1", true, "admin", Some("ph-001"))
                .await
                .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(linked_return_delete_error.contains("completed purchase returns"));
        let unchanged_invoice_quantity: f64 = sqlx::query("SELECT CAST(quantity AS REAL) AS quantity FROM purchase_invoice_items WHERE invoice_id = 'purchase-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("quantity")
            .unwrap();
        let unchanged_inventory_quantity: f64 = sqlx::query("SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE drug_id = 4463 AND batch_number = 'INV-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("quantity")
            .unwrap();
        assert_eq!(unchanged_invoice_quantity, 6.0);
        assert_eq!(unchanged_inventory_quantity, 6.0);
        sqlx::query("DELETE FROM purchase_returns WHERE purchase_invoice_id = 'purchase-1'")
            .execute(&mut conn)
            .await
            .unwrap();

        sqlx::query(
            "UPDATE inventory SET quantity = 5 WHERE drug_id = 4463 AND batch_number = 'INV-1'",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let consumed_inventory_error = save_purchase_invoice_tx(&mut tx, purchase(5.0))
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(consumed_inventory_error.contains("already been consumed"));
        let unchanged_invoice_quantity: f64 = sqlx::query("SELECT CAST(quantity AS REAL) AS quantity FROM purchase_invoice_items WHERE invoice_id = 'purchase-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("quantity")
            .unwrap();
        let consumed_inventory_quantity: f64 = sqlx::query("SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE drug_id = 4463 AND batch_number = 'INV-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("quantity")
            .unwrap();
        assert_eq!(unchanged_invoice_quantity, 6.0);
        assert_eq!(consumed_inventory_quantity, 5.0);
        sqlx::query(
            "UPDATE inventory SET quantity = 6 WHERE drug_id = 4463 AND batch_number = 'INV-1'",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let mut tx = conn.begin().await.unwrap();
        let edited = save_purchase_invoice_tx(&mut tx, purchase(5.0))
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let inventory = sqlx::query("SELECT quantity, cost_price FROM inventory WHERE drug_id = 4463 AND expiry_date = '2099-08-13'")
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

        sqlx::query("UPDATE users SET permissions = '{}' WHERE id = 'admin'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let permission_error =
            delete_purchase_invoice_tx(&mut tx, "purchase-1", true, "admin", Some("ph-001"))
                .await
                .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(permission_error.contains("can_view_purchases"));
        sqlx::query("UPDATE users SET permissions = ? WHERE id = 'admin'")
            .bind(&nested_purchase_permissions)
            .execute(&mut conn)
            .await
            .unwrap();

        let mut tx = conn.begin().await.unwrap();
        delete_purchase_invoice_tx(&mut tx, "purchase-1", true, "admin", Some("ph-001"))
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
        let reversed_journal_count: i64 = sqlx::query(
            "SELECT COUNT(*) AS total FROM daily_journals WHERE description = 'Purchase invoice INV-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("total")
        .unwrap();
        assert_eq!(reversed_journal_count, 0);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM supplier_transactions WHERE reference_id = 'purchase-1'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );

        let mut kept_purchase = purchase(5.0);
        kept_purchase.payment_method = Some("credit".into());
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, kept_purchase)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        delete_purchase_invoice_tx(&mut tx, "purchase-1", false, "admin", Some("ph-001"))
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
        let supplier_balance: f64 =
            sqlx::query("SELECT CAST(balance AS REAL) AS balance FROM suppliers WHERE id = 1")
                .fetch_one(&mut conn)
                .await
                .unwrap()
                .try_get("balance")
                .unwrap();
        assert!((supplier_balance - 57.75).abs() < 0.001);
        let kept_supplier_transaction = sqlx::query(
            "SELECT COUNT(*) AS total, CAST(COALESCE(SUM(amount), 0) AS REAL) AS amount FROM supplier_transactions WHERE reference_id = 'purchase-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            kept_supplier_transaction
                .try_get::<i64, _>("total")
                .unwrap(),
            1
        );
        assert!(
            (kept_supplier_transaction
                .try_get::<f64, _>("amount")
                .unwrap()
                - 57.75)
                .abs()
                < 0.001
        );
        let kept_journal_count: i64 = sqlx::query(
            "SELECT COUNT(*) AS total FROM daily_journals WHERE description = 'Purchase invoice INV-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("total")
        .unwrap();
        assert_eq!(kept_journal_count, 1);

        let purchase_line =
            |expiry: &str, quantity: f64, purchase_invoice_item_id: Option<i64>| PurchaseItem {
                purchase_invoice_item_id,
                id: 4463,
                quantity,
                unit_id: None,
                expiry_date: Some(expiry.into()),
                cost_price: 10.0,
                selling_price: Some(20.0),
                bonus_quantity: 0.0,
                tax_percent: 0.0,
                discount_percent: 0.0,
                strips_per_box: 1,
                barcode: None,
            };
        let duplicate_purchase = |cart| PurchasePayload {
            id: Some("purchase-duplicates".into()),
            supplier_id: 1,
            pharmacy_id: Some("ph-001".into()),
            user_id: "admin".into(),
            invoice_number: Some("INV-DUP".into()),
            invoice_date: Some("2026-07-19".into()),
            payment_method: Some("credit".into()),
            notes: None,
            check_number: None,
            expenses: 0.0,
            discount_value: 0.0,
            discount_percent: 0.0,
            tax_percent: 0.0,
            status: Some("completed".into()),
            cart,
        };
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(
            &mut tx,
            duplicate_purchase(vec![
                purchase_line("2027-01-01", 6.0, None),
                purchase_line("2027-02-01", 4.0, None),
                purchase_line("2027-04-01", 2.0, None),
            ]),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let january_line_id: i64 = sqlx::query(
            "SELECT id FROM purchase_invoice_items WHERE invoice_id = 'purchase-duplicates' AND expiry_date = '2027-01-01'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("id")
        .unwrap();

        let mut tx = conn.begin().await.unwrap();
        let edited_duplicates = save_purchase_invoice_tx(
            &mut tx,
            duplicate_purchase(vec![
                purchase_line("2027-02-01", 3.0, None),
                purchase_line("2027-03-01", 5.0, None),
                purchase_line("2027-01-01", 2.0, Some(january_line_id)),
            ]),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(edited_duplicates.total_amount, 100.0);

        for (expiry, expected) in [
            ("2027-01-01", 2.0),
            ("2027-02-01", 3.0),
            ("2027-03-01", 5.0),
            ("2027-04-01", 0.0),
        ] {
            let quantity: f64 = sqlx::query(
                "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE drug_id = 4463 AND batch_number = 'INV-DUP' AND expiry_date = ?",
            )
            .bind(expiry)
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("quantity")
            .unwrap();
            assert_eq!(quantity, expected, "wrong quantity for expiry {expiry}");
        }
        let accounting = sqlx::query(
            "SELECT st.supplier_id, dj.created_by FROM supplier_transactions st JOIN daily_journals dj ON dj.description = 'Purchase invoice INV-DUP' WHERE st.reference_id = 'purchase-duplicates'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(accounting.try_get::<i64, _>("supplier_id").unwrap(), 1);
        assert_eq!(
            accounting.try_get::<String, _>("created_by").unwrap(),
            "admin"
        );

        let legacy_purchase = |pharmacy_id: Option<&str>, quantity: f64| PurchasePayload {
            id: Some("purchase-legacy".into()),
            supplier_id: 1,
            pharmacy_id: pharmacy_id.map(str::to_string),
            user_id: "admin".into(),
            invoice_number: Some("INV-LEGACY".into()),
            invoice_date: Some("2026-07-19".into()),
            payment_method: Some("cash".into()),
            notes: None,
            check_number: None,
            expenses: 0.0,
            discount_value: 0.0,
            discount_percent: 0.0,
            tax_percent: 0.0,
            status: Some("completed".into()),
            cart: vec![purchase_line("2028-01-01", quantity, None)],
        };
        sqlx::query("UPDATE users SET pharmacy_id = NULL WHERE id = 'admin'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, legacy_purchase(None, 4.0))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, legacy_purchase(Some("local_default"), 3.0))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let legacy = sqlx::query("SELECT COUNT(*) AS rows, CAST(SUM(quantity) AS REAL) AS quantity FROM inventory WHERE drug_id = 4463 AND batch_number = 'INV-LEGACY' AND expiry_date = '2028-01-01'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(legacy.try_get::<i64, _>("rows").unwrap(), 1);
        assert_eq!(legacy.try_get::<f64, _>("quantity").unwrap(), 3.0);
    }

    #[tokio::test]
    async fn fresh_schema_purchase_lifecycle_covers_stock_money_returns_and_deletion() {
        let mut conn = current_fresh_schema().await;
        sqlx::query(
            r#"
            INSERT INTO users (id, username, role, full_name, pharmacy_id, is_active)
            VALUES ('fresh-admin', 'fresh-admin', 'admin', 'Fresh Admin', 'fresh-pharmacy', 1);
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO suppliers (id, name_ar, balance) VALUES (1, 'Fresh Supplier', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            r#"
            INSERT INTO master_drugs
              (id, trade_name, trade_name_en, active_ingredient, official_price, barcode,
               large_unit, medium_unit, small_unit, large_to_medium, medium_to_small)
            VALUES
              (90001, 'دواء مخصص', 'CUSTOM FRESH DRUG', 'TEST INGREDIENT', 150, NULL,
               'Box', 'Strip', 'Tablet', 10, 10)
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO shifts (id, user_id, starting_cash, status) VALUES ('fresh-shift', 'fresh-admin', 500, 'open')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO accounts (code, name_ar, type, is_group) VALUES ('9.9', 'Wrong legacy mapping', 'asset', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("UPDATE trial_balance_settings SET account_id = (SELECT id FROM accounts WHERE code = '9.9') WHERE category = 'cash_drawer'")
            .execute(&mut conn)
            .await
            .unwrap();

        let mut invalid = fresh_purchase(
            "invalid-purchase",
            "INVALID",
            "cash",
            "completed",
            vec![fresh_purchase_line("2030-01-01", 1.0, 0.0, None)],
        );
        invalid.discount_percent = 101.0;
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, invalid)
            .await
            .unwrap_err()
            .contains("Invalid purchase totals"));
        tx.rollback().await.unwrap();

        let mut invalid_invoice_date = fresh_purchase(
            "invalid-invoice-date",
            "INVALID-DATE",
            "cash",
            "completed",
            vec![fresh_purchase_line("2030-01-01", 1.0, 0.0, None)],
        );
        invalid_invoice_date.invoice_date = Some("2026-02-30".into());
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, invalid_invoice_date)
            .await
            .unwrap_err()
            .contains("Invalid purchase invoice date"));
        tx.rollback().await.unwrap();

        let invalid_expiry = fresh_purchase(
            "invalid-expiry",
            "INVALID-EXPIRY",
            "cash",
            "completed",
            vec![fresh_purchase_line("2030-02-30", 1.0, 0.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, invalid_expiry)
            .await
            .unwrap_err()
            .contains("Invalid expiry date"));
        tx.rollback().await.unwrap();

        let expired = fresh_purchase(
            "expired-purchase",
            "EXPIRED",
            "cash",
            "completed",
            vec![fresh_purchase_line("2000-01-01", 1.0, 0.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, expired)
            .await
            .unwrap_err()
            .contains("already expired"));
        tx.rollback().await.unwrap();

        let mut missing_expiry = fresh_purchase(
            "missing-expiry",
            "MISSING-EXPIRY",
            "cash",
            "completed",
            vec![fresh_purchase_line("2030-01-01", 1.0, 0.0, None)],
        );
        missing_expiry.cart[0].expiry_date = None;
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, missing_expiry)
            .await
            .unwrap_err()
            .contains("requires an expiry date"));
        tx.rollback().await.unwrap();

        let duplicate_lot = fresh_purchase(
            "duplicate-lot",
            "DUPLICATE-LOT",
            "cash",
            "completed",
            vec![
                fresh_purchase_line("13/08/2030", 1.0, 0.0, None),
                fresh_purchase_line("2030-08-13", 1.0, 0.0, None),
            ],
        );
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, duplicate_lot)
            .await
            .unwrap_err()
            .contains("Duplicate purchase lot"));
        tx.rollback().await.unwrap();

        let pending = fresh_purchase(
            "pending-purchase",
            "PENDING",
            "cash",
            "pending",
            vec![fresh_purchase_line("2030-01-01", 1.0, 0.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, pending)
            .await
            .unwrap_err()
            .contains("Invalid purchase status"));
        tx.rollback().await.unwrap();

        let mut wrong_pharmacy = fresh_purchase(
            "wrong-pharmacy",
            "WRONG-PHARMACY",
            "cash",
            "completed",
            vec![fresh_purchase_line("2030-01-01", 1.0, 0.0, None)],
        );
        wrong_pharmacy.pharmacy_id = Some("another-pharmacy".into());
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, wrong_pharmacy)
            .await
            .unwrap_err()
            .contains("pharmacy does not match"));
        tx.rollback().await.unwrap();

        let mut missing_check = fresh_purchase(
            "missing-check",
            "MISSING-CHECK",
            "check",
            "completed",
            vec![fresh_purchase_line("2030-01-01", 1.0, 0.0, None)],
        );
        missing_check.check_number = None;
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, missing_check)
            .await
            .unwrap_err()
            .contains("Check number is required"));
        tx.rollback().await.unwrap();

        let mut zero_cost = fresh_purchase(
            "zero-cost",
            "ZERO-COST",
            "cash",
            "completed",
            vec![fresh_purchase_line("2030-01-01", 1.0, 0.0, None)],
        );
        zero_cost.cart[0].cost_price = 0.0;
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, zero_cost)
            .await
            .unwrap_err()
            .contains("positive cost price"));
        tx.rollback().await.unwrap();

        sqlx::query("UPDATE users SET is_active = 0 WHERE id = 'fresh-admin'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(
            &mut tx,
            fresh_purchase(
                "inactive-user",
                "INACTIVE-USER",
                "cash",
                "completed",
                vec![fresh_purchase_line("2030-01-01", 1.0, 0.0, None)],
            ),
        )
        .await
        .unwrap_err()
        .contains("does not exist"));
        tx.rollback().await.unwrap();
        sqlx::query("UPDATE users SET is_active = 1 WHERE id = 'fresh-admin'")
            .execute(&mut conn)
            .await
            .unwrap();

        let draft = fresh_purchase(
            "fresh-cash",
            "FRESH-CASH",
            "cash",
            "draft",
            vec![fresh_purchase_line("2030-01-01", 4.0, 1.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        let draft_result = save_purchase_invoice_tx(&mut tx, draft).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(draft_result.total_amount, 0.0);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM inventory")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
        let draft_link: Option<String> = sqlx::query_scalar(
            "SELECT inventory_id FROM purchase_invoice_items WHERE invoice_id = 'fresh-cash'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!(draft_link.is_none());

        let mut cash = fresh_purchase(
            "fresh-cash",
            "FRESH-CASH",
            "cash",
            "completed",
            vec![
                fresh_purchase_line("2030-01-01", 4.0, 1.0, None),
                fresh_purchase_line("2031-01-01", 2.0, 0.0, None),
            ],
        );
        cash.expenses = 5.0;
        cash.discount_value = 10.0;
        cash.discount_percent = 10.0;
        cash.invoice_date = None;
        let mut tx = conn.begin().await.unwrap();
        let completed = save_purchase_invoice_tx(&mut tx, cash).await.unwrap();
        tx.commit().await.unwrap();
        assert!((completed.total_amount - 619.2).abs() < 0.001);
        let stored_default_date: String = sqlx::query_scalar(
            "SELECT invoice_date FROM purchase_invoices WHERE id = 'fresh-cash'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let database_today: String = sqlx::query_scalar("SELECT DATE('now', 'localtime')")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(stored_default_date, database_today);
        let cash_supplier_history = sqlx::query(
            "SELECT COUNT(*) AS rows, CAST(COALESCE(SUM(amount), 0) AS REAL) AS net, CAST(MAX(CASE WHEN type = 'invoice' THEN amount END) AS REAL) AS invoice_amount, CAST(MIN(CASE WHEN type = 'payment' THEN amount END) AS REAL) AS payment_amount FROM supplier_transactions WHERE reference_id = 'fresh-cash'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(cash_supplier_history.get::<i64, _>("rows"), 2);
        assert!(cash_supplier_history.get::<f64, _>("net").abs() < 0.001);
        assert!(
            (cash_supplier_history.get::<f64, _>("invoice_amount") - completed.total_amount).abs()
                < 0.001
        );
        assert!(
            (cash_supplier_history.get::<f64, _>("payment_amount") + completed.total_amount).abs()
                < 0.001
        );
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT CAST(balance AS REAL) FROM suppliers WHERE id = 1"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0.0
        );

        let lots = sqlx::query(
            r#"
            SELECT COUNT(*) AS rows,
                   CAST(SUM(i.quantity) AS REAL) AS quantity,
                   CAST(SUM(i.quantity * i.cost_price) AS REAL) AS carrying_value,
                   COUNT(DISTINCT i.expiry_date) AS expiries,
                   COUNT(DISTINCT pii.inventory_id) AS linked_lots,
                   MIN(i.barcode) AS barcode,
                   MIN(md.trade_name_en) AS trade_name
            FROM purchase_invoice_items pii
            JOIN inventory i ON i.id = pii.inventory_id
            JOIN master_drugs md ON md.id = pii.drug_id
            WHERE pii.invoice_id = 'fresh-cash'
            "#,
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(lots.get::<i64, _>("rows"), 2);
        assert_eq!(lots.get::<f64, _>("quantity"), 7.0);
        assert_eq!(lots.get::<i64, _>("expiries"), 2);
        assert_eq!(lots.get::<i64, _>("linked_lots"), 2);
        assert_eq!(lots.get::<String, _>("barcode"), "CUSTOM-90001");
        assert_eq!(lots.get::<String, _>("trade_name"), "CUSTOM FRESH DRUG");
        let paid_factor = purchase_inventory_paid_factor(693.0, 5.0, 10.0, 10.0);
        assert!((lots.get::<f64, _>("carrying_value") - 693.0 * paid_factor).abs() < 0.001);
        assert!((lots.get::<f64, _>("carrying_value") - completed.total_amount).abs() < 0.001);
        let master_barcode: String =
            sqlx::query_scalar("SELECT barcode FROM master_drugs WHERE id = 90001")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(master_barcode, "CUSTOM-90001");

        let pos_stock = sqlx::query(
            r#"
            SELECT COUNT(*) AS batches, CAST(SUM(quantity) AS REAL) AS quantity
            FROM inventory
            WHERE drug_id = 90001 AND pharmacy_id = 'fresh-pharmacy'
              AND quantity > 0 AND expiry_date >= '2026-08-12'
            "#,
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(pos_stock.get::<i64, _>("batches"), 2);
        assert_eq!(pos_stock.get::<f64, _>("quantity"), 7.0);
        let cash_movement: f64 = sqlx::query_scalar(
            "SELECT amount FROM cash_movements WHERE category = 'purchases' AND shift_id = 'fresh-shift'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!((cash_movement - completed.total_amount).abs() < 0.001);
        let cash_journal_code: String = sqlx::query_scalar(
            r#"
            SELECT a.code FROM daily_journals dj
            JOIN journal_entries je ON je.journal_id = dj.id
            JOIN accounts a ON a.id = je.account_id
            WHERE dj.description = 'Purchase invoice FRESH-CASH' AND je.type = 'credit'
            "#,
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(cash_journal_code, "1.1.1");

        let cash_lines = sqlx::query(
            "SELECT id, expiry_date FROM purchase_invoice_items WHERE invoice_id = 'fresh-cash' ORDER BY expiry_date",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        let january_id = cash_lines[0].get::<i64, _>("id");
        let next_january_id = cash_lines[1].get::<i64, _>("id");
        let mut edited_cash = fresh_purchase(
            "fresh-cash",
            "FRESH-CASH",
            "cash",
            "completed",
            vec![
                fresh_purchase_line("2030-01-01", 3.0, 1.0, Some(january_id)),
                fresh_purchase_line("2031-01-01", 2.0, 0.0, Some(next_january_id)),
            ],
        );
        edited_cash.expenses = 5.0;
        edited_cash.discount_value = 10.0;
        edited_cash.discount_percent = 10.0;
        let mut tx = conn.begin().await.unwrap();
        let edited = save_purchase_invoice_tx(&mut tx, edited_cash)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!((edited.total_amount - 515.25).abs() < 0.001);
        let edited_cash_history = sqlx::query(
            "SELECT COUNT(*) AS rows, CAST(COALESCE(SUM(amount), 0) AS REAL) AS net, CAST(MAX(CASE WHEN type = 'invoice' THEN amount END) AS REAL) AS invoice_amount FROM supplier_transactions WHERE reference_id = 'fresh-cash'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(edited_cash_history.get::<i64, _>("rows"), 2);
        assert!(edited_cash_history.get::<f64, _>("net").abs() < 0.001);
        assert!(
            (edited_cash_history.get::<f64, _>("invoice_amount") - edited.total_amount).abs()
                < 0.001
        );
        let edited_quantities = sqlx::query(
            r#"
            SELECT expiry_date, CAST(quantity AS REAL) AS quantity
            FROM inventory WHERE batch_number = 'FRESH-CASH' ORDER BY expiry_date
            "#,
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(edited_quantities.len(), 2);
        assert_eq!(edited_quantities[0].get::<f64, _>("quantity"), 4.0);
        assert_eq!(edited_quantities[1].get::<f64, _>("quantity"), 2.0);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM cash_movements WHERE category = 'purchases' AND notes = 'Purchase invoice FRESH-CASH'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1
        );

        let edited_cash_line = sqlx::query(
            r#"
            SELECT pii.id, pii.inventory_id, CAST(i.quantity AS REAL) AS quantity,
                   CAST(i.cost_price AS REAL) AS cost_price
            FROM purchase_invoice_items pii
            JOIN inventory i ON i.id = pii.inventory_id
            WHERE pii.invoice_id = 'fresh-cash' AND pii.expiry_date = '2030-01-01'
            "#,
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let edited_cash_line_id = edited_cash_line.get::<i64, _>("id");
        let edited_cash_inventory_id = edited_cash_line.get::<String, _>("inventory_id");
        let quantity_before_return = edited_cash_line.get::<f64, _>("quantity");
        let cost_before_return = edited_cash_line.get::<f64, _>("cost_price");
        let adjusted_return = run_purchase_return_transaction(
            &mut conn,
            PurchaseReturnPayload {
                purchase_invoice_id: "fresh-cash".into(),
                supplier_id: 1,
                user_id: "fresh-admin".into(),
                pharmacy_id: Some("fresh-pharmacy".into()),
                reason: Some("adjusted cash return".into()),
                refund_method: "cash".into(),
                items: vec![PurchaseReturnItem {
                    purchase_invoice_item_id: edited_cash_line_id,
                    quantity: 10.0,
                    unit: Some("medium".into()),
                }],
            },
        )
        .await
        .unwrap();
        assert!((adjusted_return.total_amount - 103.05).abs() < 0.001);
        let quantity_after_return: f64 =
            sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id = ?")
                .bind(&edited_cash_inventory_id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let carrying_value_returned =
            (quantity_before_return - quantity_after_return) * cost_before_return;
        assert!((carrying_value_returned - adjusted_return.total_amount).abs() < 0.001);
        let return_inventory_credit: f64 = sqlx::query_scalar(
            r#"
            SELECT je.amount
            FROM daily_journals dj
            JOIN journal_entries je ON je.journal_id = dj.id
            JOIN trial_balance_settings t ON t.account_id = je.account_id
            WHERE dj.description = ? AND t.category = 'inventory_asset' AND je.type = 'credit'
            LIMIT 1
            "#,
        )
        .bind(format!("Purchase return {}", adjusted_return.return_id))
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!((return_inventory_credit - carrying_value_returned).abs() < 0.001);
        let cash_refund: f64 = sqlx::query_scalar(
            "SELECT amount FROM cash_movements WHERE category = 'purchase_return' AND notes = 'adjusted cash return'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!((cash_refund - adjusted_return.total_amount).abs() < 0.001);

        let check = fresh_purchase(
            "fresh-check",
            "FRESH-CHECK",
            "check",
            "completed",
            vec![fresh_purchase_line("2032-01-01", 1.0, 0.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        let check_result = save_purchase_invoice_tx(&mut tx, check).await.unwrap();
        tx.commit().await.unwrap();
        let stored_check: String = sqlx::query_scalar(
            "SELECT check_number FROM purchase_invoices WHERE id = 'fresh-check'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(stored_check, "CHK-001");

        let credit = fresh_purchase(
            "fresh-credit",
            "FRESH-CREDIT",
            "credit",
            "completed",
            vec![fresh_purchase_line("2033-01-01", 2.0, 1.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        let credit_result = save_purchase_invoice_tx(&mut tx, credit).await.unwrap();
        tx.commit().await.unwrap();
        let supplier_balance: f64 =
            sqlx::query_scalar("SELECT CAST(balance AS REAL) FROM suppliers WHERE id = 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert!(
            (supplier_balance - check_result.total_amount - credit_result.total_amount).abs()
                < 0.001
        );

        let credit_line_id: i64 = sqlx::query_scalar(
            "SELECT id FROM purchase_invoice_items WHERE invoice_id = 'fresh-credit'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let returned = run_purchase_return_transaction(
            &mut conn,
            PurchaseReturnPayload {
                purchase_invoice_id: "fresh-credit".into(),
                supplier_id: 1,
                user_id: "fresh-admin".into(),
                pharmacy_id: Some("fresh-pharmacy".into()),
                reason: Some("unit conversion regression".into()),
                refund_method: "credit".into(),
                items: vec![PurchaseReturnItem {
                    purchase_invoice_item_id: credit_line_id,
                    quantity: 10.0,
                    unit: Some("medium".into()),
                }],
            },
        )
        .await
        .unwrap();
        assert!((returned.total_amount - 115.5).abs() < 0.001);
        let returned_line = sqlx::query(
            r#"
            SELECT pri.unit, CAST(pri.quantity_returned AS REAL) AS returned,
                   i.expiry_date, CAST(i.quantity AS REAL) AS remaining
            FROM purchase_return_items pri
            JOIN inventory i ON i.id = pri.inventory_id
            WHERE pri.purchase_return_id = ?
            "#,
        )
        .bind(&returned.return_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(returned_line.get::<String, _>("unit"), "medium");
        assert_eq!(returned_line.get::<f64, _>("returned"), 10.0);
        assert_eq!(returned_line.get::<String, _>("expiry_date"), "2033-01-01");
        assert!((returned_line.get::<f64, _>("remaining") - 1.5).abs() < 0.001);

        sqlx::query(
            "INSERT INTO users (id, username, role, full_name, pharmacy_id, is_active) VALUES ('other-admin', 'other-admin', 'admin', 'Other Admin', 'other-pharmacy', 1)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let cross_pharmacy_delete = delete_purchase_invoice_tx(
            &mut tx,
            "fresh-check",
            true,
            "other-admin",
            Some("other-pharmacy"),
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(cross_pharmacy_delete.contains("another pharmacy"));

        let mut tx = conn.begin().await.unwrap();
        delete_purchase_invoice_tx(
            &mut tx,
            "fresh-check",
            true,
            "fresh-admin",
            Some("fresh-pharmacy"),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM purchase_invoices WHERE id = 'fresh-check'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE batch_number = 'FRESH-CHECK'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0.0
        );

        let keep = fresh_purchase(
            "fresh-keep",
            "FRESH-KEEP",
            "credit",
            "completed",
            vec![fresh_purchase_line("2034-01-01", 1.0, 0.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, keep).await.unwrap();
        tx.commit().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        delete_purchase_invoice_tx(
            &mut tx,
            "fresh-keep",
            false,
            "fresh-admin",
            Some("fresh-pharmacy"),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE batch_number = 'FRESH-KEEP'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1.0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM supplier_transactions WHERE reference_id = 'fresh-keep'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1
        );
        assert!(sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut conn)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            "ok"
        );
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
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, pharmacy_id TEXT, drug_id INTEGER, batch_number TEXT, expiry_date TEXT, quantity REAL, unit_price REAL, local_selling_price REAL, cost_price REAL, strips_per_box INTEGER, created_at TEXT, updated_at TEXT)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT, pharmacy_id TEXT, total_amount REAL, discount_amount REAL, payment_method TEXT, status TEXT)",
            "CREATE TABLE users (id TEXT PRIMARY KEY)",
            "CREATE TABLE shifts (id TEXT, user_id TEXT, status TEXT, start_time TEXT)",
            "CREATE TABLE patients (id TEXT PRIMARY KEY, wallet_balance REAL)",
            "CREATE TABLE sales_items (id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold INTEGER, unit_price REAL, unit TEXT, cost_price INTEGER)",
            "CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, shift_id TEXT, reason TEXT, total_refund REAL, refund_method TEXT, status TEXT)",
            "CREATE TABLE return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT, drug_name TEXT, quantity_returned INTEGER, unit_price REAL)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::query("INSERT INTO master_drugs VALUES (4463, 'COLONA', 0, 10, 2), (4464, 'MISSING LOT', 0, 10, 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO accounts (id, code) VALUES (6, '1.1.1'), (8, '1.1.2'), (9, '3.1'), (10, '1.1.3'), (11, '4.1')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users VALUES ('admin')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory VALUES ('batch-2027', 'ph-1', 4463, 'B-27', '2027-08-13', 0, 69, 69, 40, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO patients VALUES ('patient-1', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sales_invoices VALUES ('invoice-1', 'patient-1', 'ph-1', 62.1, 6.9, 'cash', 'completed')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sales_items VALUES (1, 'invoice-1', 'batch-2027', 4463, 1, 69, 'large', 40)").execute(&mut conn).await.unwrap();

        let invalid_return = |user_id: &str, pharmacy_id: &str| ReturnPayload {
            invoice_id: "invoice-1".into(),
            user_id: user_id.into(),
            pharmacy_id: Some(pharmacy_id.into()),
            shift_id: None,
            refund_method: "cash".into(),
            reason: None,
            patient_id: None,
            items: vec![ReturnItem {
                sale_item_id: Some(1),
                inventory_id: None,
                drug_name: "COLONA".into(),
                quantity: 1.0,
                unit_price: 69.0,
                unit: Some("large".into()),
            }],
        };
        let mut tx = conn.begin().await.unwrap();
        let user_error = create_return_tx(&mut tx, invalid_return("missing-user", "ph-1"))
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(user_error.contains("does not exist"));
        let mut tx = conn.begin().await.unwrap();
        let pharmacy_error = create_return_tx(&mut tx, invalid_return("admin", "ph-2"))
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(pharmacy_error.contains("another pharmacy"));
        let mut unsupported_refund = invalid_return("admin", "ph-1");
        unsupported_refund.refund_method = "coupon".into();
        let mut tx = conn.begin().await.unwrap();
        let refund_method_error = create_return_tx(&mut tx, unsupported_refund)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(refund_method_error.contains("Refund method"));

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
                unit_price: 999.0,
                unit: Some("medium".into()),
            }],
        };
        let mut tx = conn.begin().await.unwrap();
        let result = create_return_tx(&mut tx, payload).await.unwrap();
        tx.commit().await.unwrap();
        assert!((result.total_refund - 12.42).abs() < 0.000_001);

        let batch =
            sqlx::query("SELECT quantity, expiry_date FROM inventory WHERE id = 'batch-2027'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let restored: f64 = batch.try_get("quantity").unwrap();
        let expiry: String = batch.try_get("expiry_date").unwrap();
        let return_item = sqlx::query(
            "SELECT quantity_returned, unit_price, unit FROM return_items WHERE sale_item_id = 1",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let returned: f64 = return_item.try_get("quantity_returned").unwrap();
        let derived_unit_price: f64 = return_item.try_get("unit_price").unwrap();
        let persisted_unit: String = return_item.try_get("unit").unwrap();
        assert!((restored - 0.2).abs() < 0.000_001);
        assert!((returned - 0.2).abs() < 0.000_001);
        assert!((derived_unit_price - 69.0).abs() < 0.000_001);
        assert_eq!(persisted_unit, "large");
        assert_eq!(expiry, "2027-08-13");
        assert!((1.0 - returned - 0.8).abs() < 0.000_001);
        sqlx::query("UPDATE returns SET status = 'completed' WHERE invoice_id = 'invoice-1'")
            .execute(&mut conn)
            .await
            .unwrap();

        sqlx::query("INSERT INTO sales_invoices VALUES ('invoice-2', NULL, 'ph-1', 10, 0, 'cash', 'completed')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_items VALUES (2, 'invoice-2', 'missing-batch', 4464, 2, 5, 'medium', 30)")
            .execute(&mut conn)
            .await
            .unwrap();
        let missing_lot_return = ReturnPayload {
            invoice_id: "invoice-2".into(),
            user_id: "admin".into(),
            pharmacy_id: Some("ph-1".into()),
            shift_id: None,
            refund_method: "cash".into(),
            reason: Some("missing original lot".into()),
            patient_id: None,
            items: vec![ReturnItem {
                sale_item_id: Some(2),
                inventory_id: Some("spoofed-batch".into()),
                drug_name: "MISSING LOT".into(),
                quantity: 4.0,
                unit_price: 999.0,
                unit: Some("small".into()),
            }],
        };
        let mut tx = conn.begin().await.unwrap();
        let missing_lot_result = create_return_tx(&mut tx, missing_lot_return).await.unwrap();
        tx.commit().await.unwrap();
        assert!((missing_lot_result.total_refund - 10.0).abs() < 0.000_001);
        let replacement_lot = sqlx::query("SELECT quantity, local_selling_price FROM inventory WHERE drug_id = 4464 AND pharmacy_id = 'ph-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let replacement_quantity: f64 = replacement_lot.try_get("quantity").unwrap();
        let replacement_price: f64 = replacement_lot.try_get("local_selling_price").unwrap();
        assert!((replacement_quantity - 0.2).abs() < 0.000_001);
        assert!((replacement_price - 50.0).abs() < 0.000_001);
        let missing_lot_item = sqlx::query("SELECT quantity_returned, unit_price, unit, total_price FROM return_items WHERE sale_item_id = 2")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            missing_lot_item
                .try_get::<i64, _>("quantity_returned")
                .unwrap(),
            2
        );
        assert_eq!(
            missing_lot_item.try_get::<f64, _>("unit_price").unwrap(),
            5.0
        );
        assert_eq!(
            missing_lot_item.try_get::<String, _>("unit").unwrap(),
            "medium"
        );
        assert_eq!(
            missing_lot_item.try_get::<f64, _>("total_price").unwrap(),
            10.0
        );

        sqlx::query("INSERT INTO inventory VALUES ('cross-branch', 'ph-2', 4464, 'CROSS', '2029-01-01', 0, 10, 10, 30, 10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_invoices VALUES ('invoice-3', NULL, 'ph-1', 10, 0, 'cash', 'completed')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_items VALUES (3, 'invoice-3', 'cross-branch', 4464, 1, 10, 'large', 30)")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        create_return_tx(
            &mut tx,
            ReturnPayload {
                invoice_id: "invoice-3".into(),
                user_id: "admin".into(),
                pharmacy_id: Some("ph-1".into()),
                shift_id: None,
                refund_method: "cash".into(),
                reason: None,
                patient_id: None,
                items: vec![ReturnItem {
                    sale_item_id: Some(3),
                    inventory_id: None,
                    drug_name: "MISSING LOT".into(),
                    quantity: 1.0,
                    unit_price: 10.0,
                    unit: Some("large".into()),
                }],
            },
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let cross_branch_stock: f64 = sqlx::query(
            "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE id = 'cross-branch'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("quantity")
        .unwrap();
        assert_eq!(cross_branch_stock, 0.0);

        sqlx::query("UPDATE sales_invoices SET payment_method = 'credit' WHERE id = 'invoice-1'")
            .execute(&mut conn)
            .await
            .unwrap();
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
        assert!((receivable_credit - 12.42).abs() < 0.000_001);

        let duplicate_lines = ReturnPayload {
            invoice_id: "invoice-1".into(),
            user_id: "admin".into(),
            pharmacy_id: Some("ph-1".into()),
            shift_id: None,
            refund_method: "patient_account".into(),
            reason: Some("duplicate".into()),
            patient_id: None,
            items: vec![
                ReturnItem {
                    sale_item_id: Some(1),
                    inventory_id: Some("batch-2027".into()),
                    drug_name: "COLONA".into(),
                    quantity: 0.4,
                    unit_price: 69.0,
                    unit: Some("large".into()),
                },
                ReturnItem {
                    sale_item_id: Some(1),
                    inventory_id: Some("batch-2027".into()),
                    drug_name: "COLONA".into(),
                    quantity: 0.4,
                    unit_price: 69.0,
                    unit: Some("large".into()),
                },
            ],
        };
        let mut tx = conn.begin().await.unwrap();
        let duplicate_error = create_return_tx(&mut tx, duplicate_lines)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(duplicate_error.contains("exceeds remaining quantity"));

        let full_return = ReturnPayload {
            invoice_id: "invoice-1".into(),
            user_id: "admin".into(),
            pharmacy_id: Some("ph-1".into()),
            shift_id: None,
            refund_method: "patient_account".into(),
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
        let discounted_refund_total: f64 = sqlx::query(
            "SELECT CAST(SUM(total_refund) AS REAL) AS total FROM returns WHERE invoice_id = 'invoice-1' AND status IN ('approved', 'completed')",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("total")
        .unwrap();
        assert!((discounted_refund_total - 62.1).abs() < 0.000_001);

        let excessive = ReturnPayload {
            invoice_id: "invoice-1".into(),
            user_id: "admin".into(),
            pharmacy_id: Some("ph-1".into()),
            shift_id: None,
            refund_method: "patient_account".into(),
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
    async fn negative_stock_settlement_is_scoped_guarded_and_accounted_once() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, large_to_medium INTEGER, medium_to_small INTEGER, medium_unit TEXT, small_unit TEXT)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity REAL, cost_price REAL, expiry_date TEXT, strips_per_box INTEGER, updated_at TEXT)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, pharmacy_id TEXT)",
            "CREATE TABLE sales_items (id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold REAL, unit TEXT, is_negative INTEGER, cost_price REAL)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT)",
            "CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO master_drugs VALUES (1, 10, 2, 'strip', 'pill'), (2, 1, 1, NULL, NULL)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO accounts (id, code) VALUES (10, '1.1.3'), (11, '4.1')")
            .execute(&mut conn)
            .await
            .unwrap();
        for sql in [
            "INSERT INTO inventory VALUES ('wrong-drug', 2, 'ph-1', 5, 40, '2099-01-01', 1, NULL)",
            "INSERT INTO inventory VALUES ('wrong-pharmacy', 1, 'ph-2', 5, 40, '2099-01-01', 10, NULL)",
            "INSERT INTO inventory VALUES ('expired', 1, 'ph-1', 5, 40, '2000-01-01', 10, NULL)",
            "INSERT INTO inventory VALUES ('insufficient', 1, 'ph-1', 0.1, 40, '2099-01-01', 10, NULL)",
            "INSERT INTO inventory VALUES ('valid', 1, 'ph-1', 1, 40, '2099-01-01', 10, NULL)",
            "INSERT INTO inventory VALUES ('legacy-local', 1, NULL, 2, 25, '2099-01-01', 10, NULL)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO sales_invoices VALUES ('sale-ph-1', 'ph-1'), ('sale-local', NULL)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sales_items VALUES (1, 'sale-ph-1', NULL, 1, 4, 'small', 1, 0), (2, 'sale-local', NULL, 1, 1, 'large', 1, 0)")
            .execute(&mut conn)
            .await
            .unwrap();

        let payload = |sale_item_id: i64, inventory_id: &str, pharmacy_id: &str| {
            NegativeStockSettlementPayload {
                sale_item_id,
                inventory_id: inventory_id.into(),
                pharmacy_id: pharmacy_id.into(),
                user_id: "admin".into(),
            }
        };

        for invalid_batch in ["wrong-drug", "wrong-pharmacy", "expired", "legacy-local"] {
            let mut tx = conn.begin().await.unwrap();
            let error = settle_negative_sale_item_tx(&mut tx, &payload(1, invalid_batch, "ph-1"))
                .await
                .unwrap_err();
            tx.rollback().await.unwrap();
            assert!(error.contains("wrong drug/pharmacy or is expired"));
        }
        let mut tx = conn.begin().await.unwrap();
        let insufficient =
            settle_negative_sale_item_tx(&mut tx, &payload(1, "insufficient", "ph-1"))
                .await
                .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(insufficient.contains("insufficient stock"));

        let mut tx = conn.begin().await.unwrap();
        let result = settle_negative_sale_item_tx(&mut tx, &payload(1, "valid", "ph-1"))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!((result.deducted_quantity - 0.2).abs() < 0.000_001);
        assert!((result.cogs_amount - 8.0).abs() < 0.000_001);

        let stock: f64 = sqlx::query(
            "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE id = 'valid'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("quantity")
        .unwrap();
        assert!((stock - 0.8).abs() < 0.000_001);
        let settled = sqlx::query(
            "SELECT inventory_id, is_negative, CAST(cost_price AS REAL) AS cost_price FROM sales_items WHERE id = 1",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            settled.try_get::<String, _>("inventory_id").unwrap(),
            "valid"
        );
        assert_eq!(settled.try_get::<i64, _>("is_negative").unwrap(), 0);
        assert_eq!(settled.try_get::<f64, _>("cost_price").unwrap(), 40.0);
        let journal_count: i64 = sqlx::query("SELECT COUNT(*) AS total FROM daily_journals WHERE description = 'Negative stock settlement item 1'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("total")
            .unwrap();
        let entries = sqlx::query(
            "SELECT account_id, type, CAST(amount AS REAL) AS amount FROM journal_entries",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(journal_count, 1);
        assert_eq!(entries.len(), 2);
        assert!(entries
            .iter()
            .any(|row| row.try_get::<i64, _>("account_id").unwrap() == 11
                && row.try_get::<String, _>("type").unwrap() == "debit"
                && (row.try_get::<f64, _>("amount").unwrap() - 8.0).abs() < 0.000_001));
        assert!(entries
            .iter()
            .any(|row| row.try_get::<i64, _>("account_id").unwrap() == 10
                && row.try_get::<String, _>("type").unwrap() == "credit"
                && (row.try_get::<f64, _>("amount").unwrap() - 8.0).abs() < 0.000_001));

        let mut tx = conn.begin().await.unwrap();
        let duplicate = settle_negative_sale_item_tx(&mut tx, &payload(1, "valid", "ph-1"))
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(duplicate.contains("already settled"));
        let unchanged_journals: i64 = sqlx::query("SELECT COUNT(*) AS total FROM daily_journals")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("total")
            .unwrap();
        assert_eq!(unchanged_journals, 1);

        let mut tx = conn.begin().await.unwrap();
        let legacy =
            settle_negative_sale_item_tx(&mut tx, &payload(2, "legacy-local", "local_default"))
                .await
                .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(legacy.deducted_quantity, 1.0);
        assert_eq!(legacy.cogs_amount, 25.0);
        let legacy_stock: f64 = sqlx::query(
            "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE id = 'legacy-local'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("quantity")
        .unwrap();
        assert_eq!(legacy_stock, 1.0);
    }

    #[tokio::test]
    async fn checkout_handles_batch_fallback_and_wallet_accounting() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, large_to_medium INTEGER, medium_to_small INTEGER, medium_unit TEXT, small_unit TEXT)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity INTEGER, cost_price REAL, expiry_date TEXT, created_at TEXT, updated_at TEXT, strips_per_box INTEGER)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, pharmacy_id TEXT, user_id TEXT, patient_id TEXT, shift_id TEXT, total_amount REAL, payment_method TEXT, check_number TEXT, status TEXT, discount_amount REAL, created_at TEXT)",
            "CREATE TABLE sales_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold REAL, unit_price REAL, unit TEXT, is_negative INTEGER, cost_price REAL, created_at TEXT)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT)",
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
        sqlx::query("INSERT INTO accounts (id, code) VALUES (6, '1.1.1'), (8, '1.1.2'), (9, '3.1'), (10, '1.1.3'), (11, '4.1'), (12, '2.2')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO trial_balance_settings VALUES ('patient_wallet_liability', 12)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, created_at, strips_per_box) VALUES ('empty', 4463, NULL, 0, 40, '2999-01-01', '2026-01-01', 10), ('full', 4463, NULL, 7, 40, '2999-01-01', '2026-01-02', 10), ('other-pharmacy', 4463, 'ph-002', 7, 40, '2998-01-01', '2026-01-01', 10), ('expired', 4463, NULL, 7, 40, '2000-01-01', '2026-01-01', 10)")
            .execute(&mut conn)
            .await
            .unwrap();

        let cash_payload = |inventory_id: Option<&str>| CheckoutPayload {
            pharmacy_id: "local_default".into(),
            user_id: "admin".into(),
            items: vec![CheckoutItem {
                drug_id: 4463,
                inventory_id: inventory_id.map(str::to_string),
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
        let location_error =
            process_checkout_tx(&mut tx, cash_payload(Some("other-pharmacy")), 69.0)
                .await
                .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(location_error.contains("invalid or expired"));
        let mut tx = conn.begin().await.unwrap();
        let expiry_error = process_checkout_tx(&mut tx, cash_payload(Some("expired")), 69.0)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(expiry_error.contains("invalid or expired"));

        let mut tx = conn.begin().await.unwrap();
        let selected_empty_error = process_checkout_tx(&mut tx, cash_payload(Some("empty")), 69.0)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(selected_empty_error.contains("Selected inventory batch has insufficient stock"));

        let mut tx = conn.begin().await.unwrap();
        process_checkout_tx(&mut tx, cash_payload(None), 69.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let full_qty: i64 = sqlx::query("SELECT quantity FROM inventory WHERE id = 'full'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("quantity")
            .unwrap();
        assert_eq!(full_qty, 6);
        let other_qty: i64 =
            sqlx::query("SELECT quantity FROM inventory WHERE id = 'other-pharmacy'")
                .fetch_one(&mut conn)
                .await
                .unwrap()
                .try_get("quantity")
                .unwrap();
        assert_eq!(other_qty, 7);

        sqlx::query("INSERT INTO patients VALUES ('p1', 300, 100, 'bronze', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        let wallet_payload = CheckoutPayload {
            pharmacy_id: "local_default".into(),
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
