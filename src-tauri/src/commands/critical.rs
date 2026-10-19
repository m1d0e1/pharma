use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteRow},
    Column, Connection, Row, Sqlite, SqliteConnection, Transaction, TypeInfo, ValueRef,
};
use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    str::FromStr,
    time::{Duration, Instant},
};
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::inventory_units::{large_quantity_in_unit, sale_stock_qty, unit_quantity_in_large};
use super::loyalty_policy::{loyalty_points, loyalty_redemption_value};
use super::permission_policy::{normalize_pharmacy_id, user_permission_number};
pub(crate) use super::permission_policy::{user_can_view_purchases, user_has_permission};
use super::purchase_accounting_policy::{
    build_purchase_accounting_plan, PurchaseSettlementAccount,
};
use super::purchase_dto::NativePurchaseRequest;
#[cfg(test)]
pub(crate) use super::purchase_dto::PurchaseItem;
pub use super::purchase_dto::PurchasePayload;
pub(crate) use super::purchase_policy::purchase_inventory_paid_factor;
#[cfg(test)]
use super::purchase_policy::validate_purchase_items;
use super::purchase_policy::{
    inferred_single_container, normalize_date_ymd, normalize_valid_date_ymd, purchase_item_total,
    validate_completed_purchase_expiry_with_non_expiring, validate_purchase_payload,
};
use super::serde_compat::{de_f64, de_i64, de_opt_i64, de_opt_string};

#[derive(Default)]
pub struct DbTransactions {
    connections: tokio::sync::Mutex<HashMap<String, GuardedTransaction>>,
    window_resets: std::sync::Mutex<HashMap<String, Instant>>,
}

/// The licensed startup path owns this pool. It is never exposed through the
/// renderer SQL plugin and is not constructed before migrations succeed.
pub struct GuardedReadPool(pub sqlx::SqlitePool);

// Renderer-held generic transactions must never own a SQLite writer forever
// after a lost IPC reply or hung webview. Fixed native posting commands have
// their own atomic RAII transactions and are not subject to this lease.
const MAX_GUARDED_TRANSACTION_AGE: Duration = Duration::from_secs(120);

struct GuardedTransaction {
    owner_window_label: String,
    owner_actor_id: String,
    started_at: Instant,
    connection: SqliteConnection,
}

impl DbTransactions {
    fn ensure_live(&self, transaction: &GuardedTransaction) -> Result<(), String> {
        if transaction.started_at.elapsed() >= MAX_GUARDED_TRANSACTION_AGE {
            return Err("Native transaction expired; restart the operation".into());
        }
        if self
            .window_resets
            .lock()
            .unwrap()
            .get(&transaction.owner_window_label)
            .is_some_and(|reset| *reset >= transaction.started_at)
        {
            return Err("Transaction window was reloaded or closed".into());
        }
        Ok(())
    }

    pub(crate) fn note_window_reset(&self, label: &str, before: Instant) {
        self.window_resets
            .lock()
            .unwrap()
            .entry(label.to_string())
            .and_modify(|reset| *reset = (*reset).max(before))
            .or_insert(before);
    }

    async fn register(&self, tx_id: String, transaction: GuardedTransaction) -> Result<(), String> {
        let mut connections = self.connections.lock().await;
        if let Err(error) = self.ensure_live(&transaction) {
            transaction
                .connection
                .close()
                .await
                .map_err(|e| e.to_string())?;
            return Err(error);
        }
        connections.insert(tx_id, transaction);
        Ok(())
    }

    async fn finish(
        &self,
        tx_id: &str,
        window_label: &str,
        actor_id: Option<&str>,
        commit: bool,
    ) -> Result<(), String> {
        let mut connections = self.connections.lock().await;
        owned_transaction_connection(&mut connections, tx_id, window_label)?;
        let mut transaction = connections.remove(tx_id).unwrap();
        let result = async {
            super::guarded_read::reset_cancelled_read_state(&mut transaction.connection).await?;
            if commit {
                let actor_id = actor_id.ok_or("Login required before changing pharmacy records")?;
                ensure_transaction_actor(&transaction, actor_id)?;
                // Expired renderer-owned work must fail before performing any
                // further database lookup; the finish error path rolls it back.
                self.ensure_live(&transaction)?;
                active_generic_actor(&mut transaction.connection, actor_id).await?;
                self.ensure_live(&transaction)?;
            }
            sqlx::query(if commit { "COMMIT" } else { "ROLLBACK" })
                .execute(&mut transaction.connection)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        .await;
        if result.is_err() {
            let _ = sqlx::query("ROLLBACK")
                .execute(&mut transaction.connection)
                .await;
        }
        transaction
            .connection
            .close()
            .await
            .map_err(|e| e.to_string())?;
        result
    }

    pub(crate) async fn rollback_all(&self) -> Result<(), String> {
        self.rollback_matching(|_| true).await
    }

    /// Called by the licensed native startup watchdog, not by renderer SQL.
    /// Timeout releases abandoned writer locks and discards all uncommitted
    /// business, journal and inventory changes atomically.
    pub(crate) async fn rollback_expired(&self) -> Result<(), String> {
        self.rollback_matching(|tx| tx.started_at.elapsed() >= MAX_GUARDED_TRANSACTION_AGE)
            .await
    }

    pub(crate) async fn rollback_window(&self, label: &str, before: Instant) -> Result<(), String> {
        self.note_window_reset(label, before);
        self.rollback_matching(|transaction| {
            transaction.owner_window_label == label && transaction.started_at <= before
        })
        .await
    }

    async fn rollback_matching(
        &self,
        matches: impl Fn(&GuardedTransaction) -> bool,
    ) -> Result<(), String> {
        let mut connections = self.connections.lock().await;
        let ids: Vec<_> = connections
            .iter()
            .filter(|(_, tx)| matches(tx))
            .map(|(id, _)| id.clone())
            .collect();
        let mut first_error = None;
        for id in ids {
            if let Some(mut transaction) = connections.remove(&id) {
                let _ =
                    super::guarded_read::reset_cancelled_read_state(&mut transaction.connection)
                        .await;
                if let Err(error) = sqlx::query("ROLLBACK")
                    .execute(&mut transaction.connection)
                    .await
                {
                    first_error.get_or_insert_with(|| error.to_string());
                }
                // Closing is a rollback fallback and releases SQLite's writer lock even on SQL failure.
                if let Err(error) = transaction.connection.close().await {
                    first_error.get_or_insert_with(|| error.to_string());
                }
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

fn ensure_transaction_actor(
    transaction: &GuardedTransaction,
    actor_id: &str,
) -> Result<(), String> {
    if transaction.owner_actor_id != actor_id {
        return Err("Transaction belongs to another authenticated user".into());
    }
    Ok(())
}

fn ensure_transaction_owner(
    owner_window_label: &str,
    caller_window_label: &str,
) -> Result<(), String> {
    if owner_window_label != caller_window_label {
        return Err("Transaction belongs to another window".into());
    }
    Ok(())
}

fn owned_transaction_connection<'a>(
    connections: &'a mut HashMap<String, GuardedTransaction>,
    tx_id: &str,
    caller_window_label: &str,
) -> Result<&'a mut SqliteConnection, String> {
    let transaction = connections
        .get_mut(tx_id)
        .ok_or_else(|| "Transaction not found".to_string())?;
    ensure_transaction_owner(&transaction.owner_window_label, caller_window_label)?;
    Ok(&mut transaction.connection)
}

#[derive(Debug, Deserialize)]
pub struct CheckoutPayload {
    pub pharmacy_id: String,
    pub user_id: String,
    pub items: Vec<CheckoutItem>,
    pub patient_id: Option<String>,
    pub shift_id: Option<String>,
    #[serde(default)]
    pub source_draft_id: Option<String>,
    pub payment_method: String,
    pub check_number: Option<String>,
    pub status: String,
    #[serde(default, deserialize_with = "de_f64")]
    pub total_discount: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub additional_fees: f64,
    #[serde(default, deserialize_with = "de_i64")]
    pub points_to_redeem: i64,
}

/// IPC-only checkout request. Neither actor identity nor pharmacy ownership
/// exists in this deserializable shape: the licensed native session and an
/// active database user determine both inside the writer transaction. A
/// forged renderer user_id/pharmacy_id property is rejected, not ignored.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeCheckoutRequest {
    pub items: Vec<CheckoutItem>,
    pub patient_id: Option<String>,
    pub shift_id: Option<String>,
    #[serde(default)]
    pub source_draft_id: Option<String>,
    pub payment_method: String,
    pub check_number: Option<String>,
    pub status: String,
    #[serde(default, deserialize_with = "de_f64")]
    pub total_discount: f64,
    #[serde(default, deserialize_with = "de_f64")]
    pub additional_fees: f64,
    #[serde(default, deserialize_with = "de_i64")]
    pub points_to_redeem: i64,
}

impl NativeCheckoutRequest {
    fn into_owned_checkout(self, actor_id: String, pharmacy_id: String) -> CheckoutPayload {
        CheckoutPayload {
            user_id: actor_id,
            pharmacy_id,
            items: self.items,
            patient_id: self.patient_id,
            shift_id: self.shift_id,
            source_draft_id: self.source_draft_id,
            payment_method: self.payment_method,
            check_number: self.check_number,
            status: self.status,
            total_discount: self.total_discount,
            additional_fees: self.additional_fees,
            points_to_redeem: self.points_to_redeem,
        }
    }
}

async fn native_checkout_owned_payload(
    tx: &mut Transaction<'_, Sqlite>,
    actor_id: &str,
    request: NativeCheckoutRequest,
) -> Result<CheckoutPayload, String> {
    // The live row and pharmacy are read after BEGIN IMMEDIATE, never from
    // renderer input or an earlier localStorage/UI session snapshot.
    let pharmacy_id = active_native_actor_pharmacy(tx, actor_id).await?;
    Ok(request.into_owned_checkout(actor_id.to_string(), pharmacy_id))
}

async fn active_native_actor_pharmacy(
    tx: &mut Transaction<'_, Sqlite>,
    actor_id: &str,
) -> Result<String, String> {
    let actor_pharmacy: Option<Option<String>> = sqlx::query_scalar(
        "SELECT pharmacy_id FROM users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|error| error.to_string())?;
    let explicitly_stored = actor_pharmacy.ok_or("Checkout requires an active native user")?;
    let normalized = normalize_pharmacy_id(explicitly_stored.as_deref());
    if explicitly_stored.as_deref() != Some(normalized.as_str())
        || normalized == "local_default"
    {
        // Native POS, customer refunds, purchase maintenance and negative-stock
        // settlement must not treat 052's compatibility local_default as
        // independent original-owner custody of money or inventory.
        return Err("Financial posting requires an explicitly owned pharmacy, not historical local_default".into());
    }
    Ok(normalized)
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
    #[serde(default, deserialize_with = "de_f64")]
    pub item_discount_percent: f64,
    pub selected_unit: String,
    #[serde(default)]
    pub is_negative: bool,
}

#[derive(Debug, Serialize)]
pub struct CheckoutResult {
    pub sale_id: String,
    pub total_amount: f64,
    pub points_earned: i64,
    pub points_redeemed: i64,
    pub loyalty_discount_amount: f64,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct PurchaseResult {
    pub id: String,
    pub total_amount: f64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
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

// Only a native live login and the current users row can assign financial
// returns to a user/pharmacy. The renderer supplies business intent, never
// its own authorization or tenant identity.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeReturnRequest {
    pub invoice_id: String,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub shift_id: Option<String>,
    pub refund_method: String,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub reason: Option<String>,
    #[serde(default, deserialize_with = "de_opt_string")]
    pub patient_id: Option<String>,
    pub items: Vec<ReturnItem>,
}

impl NativeReturnRequest {
    fn validate(&self) -> Result<(), String> {
        // Renderer JSON is not a trusted batch interface. Stop oversized
        // financial mutations before opening the native writer transaction.
        if self.invoice_id.trim().is_empty()
            || self.invoice_id.len() > 256
            || self.items.is_empty()
            || self.items.len() > 200
            || self.shift_id.as_deref().is_some_and(|id| id.len() > 256)
            || self.patient_id.as_deref().is_some_and(|id| id.len() > 256)
            || self
                .reason
                .as_deref()
                .is_some_and(|reason| reason.len() > 2048)
            || self.items.iter().any(|item| {
                item.sale_item_id.unwrap_or_default() <= 0
                    || item.drug_name.len() > 256
                    || item
                        .inventory_id
                        .as_deref()
                        .is_some_and(|id| id.len() > 256)
                    || item.unit.as_deref().is_some_and(|unit| unit.len() > 64)
                    || !item.quantity.is_finite()
                    || item.quantity <= 0.0
                    || item.quantity > 1_000_000_000.0
                    || !item.unit_price.is_finite()
                    || item.unit_price < 0.0
                    || item.unit_price > 1_000_000_000.0
            })
        {
            return Err("Invalid or oversized native sales return request".into());
        }
        Ok(())
    }

    fn with_native_owner(self, actor_id: &str, pharmacy_id: String) -> ReturnPayload {
        ReturnPayload {
            invoice_id: self.invoice_id,
            user_id: actor_id.to_string(),
            pharmacy_id: Some(pharmacy_id),
            shift_id: self.shift_id,
            refund_method: self.refund_method,
            reason: self.reason,
            patient_id: self.patient_id,
            items: self.items,
        }
    }
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

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NativeNegativeStockSettlementRequest {
    #[serde(deserialize_with = "de_i64")]
    pub sale_item_id: i64,
    pub inventory_id: String,
}

impl NativeNegativeStockSettlementRequest {
    fn validate(&self) -> Result<(), String> {
        if self.sale_item_id <= 0
            || self.inventory_id.trim().is_empty()
            || self.inventory_id.len() > 256
        {
            return Err("Invalid negative-stock settlement request".into());
        }
        Ok(())
    }

    fn with_native_owner(
        self,
        actor_id: &str,
        pharmacy_id: String,
    ) -> NegativeStockSettlementPayload {
        NegativeStockSettlementPayload {
            sale_item_id: self.sale_item_id,
            inventory_id: self.inventory_id,
            pharmacy_id,
            user_id: actor_id.to_string(),
        }
    }
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
    window: tauri::WebviewWindow,
    transactions: State<'_, DbTransactions>,
    session: State<'_, LocalSessionState>,
    sql: String,
    params: Vec<Value>,
    tx_id: Option<String>,
) -> Result<DbExecuteResult, String> {
    validate_write_sql(&sql)?;
    let actor = session.authorize_session().await?;
    let actor_id = actor.as_deref().unwrap();
    if let Some(tx_id) = tx_id {
        let mut connections = transactions.connections.lock().await;
        let transaction = connections.get(&tx_id).ok_or("Transaction not found")?;
        transactions.ensure_live(transaction)?;
        ensure_transaction_actor(transaction, actor_id)?;
        let conn = owned_transaction_connection(&mut connections, &tx_id, window.label())?;
        authorize_generic_write(conn, actor_id, &sql).await?;
        return execute_guarded_on_connection(conn, &sql, params).await;
    }

    let mut conn = open_app_connection(&app).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    let result = async {
        authorize_generic_write(&mut conn, actor_id, &sql).await?;
        execute_guarded_on_connection(&mut conn, &sql, params).await
    }
    .await;
    match result {
        Ok(result) => {
            sqlx::query("COMMIT")
                .execute(&mut conn)
                .await
                .map_err(|e| e.to_string())?;
            Ok(result)
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut conn).await;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn db_select_guarded(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    transactions: State<'_, DbTransactions>,
    session: State<'_, LocalSessionState>,
    sql: String,
    params: Vec<Value>,
    tx_id: Option<String>,
) -> Result<Vec<Value>, String> {
    validate_read_sql(&sql)?;
    let actor = session.authorize_session().await?;
    let actor_id = actor.as_deref().unwrap();
    let Some(tx_id) = tx_id else {
        // The SQL plugin does not preload a pool (and its renderer load
        // permission is intentionally revoked). Use the native pool created
        // only after successful licensed migrations.
        let pool = app
            .try_state::<GuardedReadPool>()
            .ok_or("Database initialization has not completed")?;
        let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
        return select_guarded_on_connection(&mut conn, actor_id, &sql, params).await;
    };
    let mut connections = transactions.connections.lock().await;
    let transaction = connections.get(&tx_id).ok_or("Transaction not found")?;
    transactions.ensure_live(transaction)?;
    ensure_transaction_actor(transaction, actor_id)?;
    let conn = owned_transaction_connection(&mut connections, &tx_id, window.label())?;

    select_guarded_on_connection(conn, actor_id, &sql, params).await
}

async fn select_guarded_on_connection(
    conn: &mut SqliteConnection,
    actor_id: &str,
    sql: &str,
    params: Vec<Value>,
) -> Result<Vec<Value>, String> {
    validate_read_sql(sql)?;
    super::guarded_read::reset_cancelled_read_state(conn).await?;
    active_generic_actor(conn, actor_id).await?;
    // SQLite, not a handwritten CTE parser, enforces that WITH ... UPDATE cannot write.
    sqlx::query("PRAGMA query_only = ON")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    // The bounded reader installs the SQLite authorizer that enforces
    // clinical isolation at statement preparation. Do not install an outer
    // authorizer here: SQLite only keeps the *last* installed callback.
    let result = super::guarded_read::fetch_limited(
        conn,
        sql,
        params,
        super::guarded_read::DEFAULT_READ_LIMITS,
    )
    .await;
    let reset = sqlx::query("PRAGMA query_only = OFF").execute(conn).await;
    match (result, reset) {
        (Ok(rows), Ok(_)) => Ok(rows),
        (Err(error), _) => Err(error),
        (_, Err(error)) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn db_transaction_begin(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    transactions: State<'_, DbTransactions>,
    session: State<'_, LocalSessionState>,
) -> Result<String, String> {
    let actor = session.authorize_session().await?;
    let started_at = Instant::now();
    let mut conn = open_app_connection(&app).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    if let Err(error) = active_generic_actor(&mut conn, actor.as_deref().unwrap()).await {
        let _ = conn.close().await;
        return Err(error);
    }

    let tx_id = Uuid::new_v4().to_string();
    transactions
        .register(
            tx_id.clone(),
            GuardedTransaction {
                owner_window_label: window.label().to_string(),
                owner_actor_id: actor.as_deref().unwrap().to_string(),
                started_at,
                connection: conn,
            },
        )
        .await?;
    Ok(tx_id)
}

#[tauri::command]
pub async fn db_transaction_finish(
    window: tauri::WebviewWindow,
    transactions: State<'_, DbTransactions>,
    session: State<'_, LocalSessionState>,
    tx_id: String,
    commit: bool,
) -> Result<(), String> {
    // Rollback remains available after logout; it cannot commit another actor's work.
    let actor = if commit {
        Some(session.authorize_session().await?)
    } else {
        None
    };
    transactions
        .finish(
            &tx_id,
            window.label(),
            actor.as_ref().and_then(|actor| actor.as_deref()),
            commit,
        )
        .await
}

/// Abort can always release an in-flight transaction, even if the license
/// expired after BEGIN. This endpoint never commits and still enforces window
/// ownership of the transaction identifier. All mutations remain license gated.
#[tauri::command]
pub async fn db_transaction_abort(
    window: tauri::WebviewWindow,
    transactions: State<'_, DbTransactions>,
    tx_id: String,
) -> Result<(), String> {
    transactions
        .finish(&tx_id, window.label(), None, false)
        .await
}

pub(crate) async fn active_generic_actor(
    conn: &mut SqliteConnection,
    actor_id: &str,
) -> Result<(String, String), String> {
    let row = sqlx::query("SELECT role, pharmacy_id FROM users WHERE CAST(id AS TEXT) = ? AND COALESCE(is_active,1) = 1")
        .bind(actor_id).fetch_optional(conn).await.map_err(|e| e.to_string())?
        .ok_or("Authenticated user is inactive or missing")?;
    let role: Option<String> = row.try_get("role").map_err(|e| e.to_string())?;
    let pharmacy_id: Option<String> = row.try_get("pharmacy_id").map_err(|e| e.to_string())?;
    Ok((
        role.unwrap_or_default(),
        normalize_pharmacy_id(pharmacy_id.as_deref()),
    ))
}

async fn authorize_generic_write(
    conn: &mut SqliteConnection,
    actor_id: &str,
    sql: &str,
) -> Result<(), String> {
    // SQL's write-target table alone is not an authorization boundary:
    // INSERT/UPDATE can read unrelated private tables via subqueries, and
    // historical patients/clinical/finance tables lack tenant ownership.
    // Until each writer is migrated to native-owned, actor-scoped commands,
    // a release must refuse renderer-provided SQL entirely rather than risk
    // cross-pharmacy data extraction or unauthorized patient modification.
    if cfg!(pharma_security_release) || cfg!(pharma_strict_renderer_sql_qa) {
        return Err("Generic renderer SQL writes are disabled in secure releases; a typed native command is required".into());
    }
    validate_write_sql(sql)?;
    super::guarded_read::reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let table = write_target_table(sql).ok_or("Could not determine SQL write target")?;
    if matches!(
        table.as_str(),
        "users" | "employee_jobs" | "drug_interactions"
    ) && !role.trim().eq_ignore_ascii_case("owner")
    {
        return Err("Only the owner can manage staff or interaction reference records".into());
    }
    if !table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Unsupported SQL write target".into());
    }
    let columns: Vec<String> = sqlx::query(&format!("PRAGMA main.table_info(\"{table}\")"))
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .iter()
        .map(|row| row.get("name"))
        .collect();
    if columns.iter().any(|column| column == "pharmacy_id") {
        // Connection-local guards cover actual OLD/NEW rows, including unscoped SQL and upserts.
        // Global/shared tables deliberately keep their existing scope semantics.
        let actor_column = ["user_id", "created_by"]
            .into_iter()
            .find(|key| columns.iter().any(|c| c == key));
        let scope = |row: &str| {
            let actor_scope = actor_column.map(|column| format!(
                "(SELECT NULLIF(TRIM(u.pharmacy_id), '') FROM users u WHERE CAST(u.id AS TEXT) = CAST({row}.{column} AS TEXT) OR LOWER(u.username) = LOWER(CAST({row}.{column} AS TEXT)) LIMIT 1),"
            )).unwrap_or_default();
            let shift_scope = if table == "cash_movements"
                && columns.iter().any(|c| c == "shift_id")
            {
                format!("(SELECT NULLIF(TRIM(s.pharmacy_id), '') FROM shifts s WHERE s.id = {row}.shift_id LIMIT 1),")
            } else {
                String::new()
            };
            format!("COALESCE(NULLIF(TRIM({row}.pharmacy_id), ''), {shift_scope} {actor_scope} 'local_default')")
        };
        let pharmacy = pharmacy_id.replace('\'', "''");
        let old = scope("OLD");
        let new = scope("NEW");
        // REPLACE must run DELETE guards too, otherwise a conflicting other-pharmacy row can disappear.
        sqlx::query("PRAGMA recursive_triggers = ON")
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        for (event, condition) in [
            ("INSERT", format!("{new} <> '{pharmacy}'")),
            (
                "UPDATE",
                format!("{old} <> '{pharmacy}' OR {new} <> '{pharmacy}'"),
            ),
            ("DELETE", format!("{old} <> '{pharmacy}'")),
        ] {
            let guard = format!("CREATE TEMP TRIGGER IF NOT EXISTS native_scope_{table}_{event} BEFORE {event} ON main.\"{table}\" WHEN {condition} BEGIN SELECT RAISE(ABORT, 'Record belongs to another pharmacy'); END");
            sqlx::query(&guard)
                .execute(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

async fn execute_guarded_on_connection(
    conn: &mut SqliteConnection,
    sql: &str,
    params: Vec<Value>,
) -> Result<DbExecuteResult, String> {
    let mut query = sqlx::query(sql);
    for param in params {
        query = bind_json_value(query, param);
    }
    let result = query.execute(&mut *conn).await;
    // Scoped REPLACE guards need recursion only for this statement, not subsequent catalog writes.
    let reset = sqlx::query("PRAGMA recursive_triggers = OFF")
        .execute(conn)
        .await;
    let result = result.map_err(|e| e.to_string())?;
    reset.map_err(|e| e.to_string())?;

    Ok(DbExecuteResult {
        rows_affected: result.rows_affected(),
        last_insert_id: result.last_insert_rowid(),
    })
}

pub(super) fn sqlite_row_to_json(row: &SqliteRow) -> Result<Value, String> {
    let mut object = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(index).map_err(|e| e.to_string())?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            match raw.type_info().name() {
                "INTEGER" => Value::Number(
                    row.try_get::<i64, _>(index)
                        .map_err(|e| e.to_string())?
                        .into(),
                ),
                "REAL" => {
                    Number::from_f64(row.try_get::<f64, _>(index).map_err(|e| e.to_string())?)
                        .map(Value::Number)
                        .unwrap_or(Value::Null)
                }
                "TEXT" => {
                    Value::String(row.try_get::<String, _>(index).map_err(|e| e.to_string())?)
                }
                "BLOB" => serde_json::to_value(
                    row.try_get::<Vec<u8>, _>(index)
                        .map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?,
                kind => return Err(format!("Unsupported SQLite value type '{}'", kind)),
            }
        };
        object.insert(column.name().to_string(), value);
    }
    Ok(Value::Object(object))
}

#[tauri::command]
pub async fn process_checkout_critical(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: NativeCheckoutRequest,
    request_id: String,
) -> Result<CheckoutResult, String> {
    super::sales_cogs_provenance::canonical_request_id(&request_id)?;
    let actor_guard = session.authorize_session().await?;
    let actor_id = actor_guard
        .as_deref()
        .ok_or("Login required before checkout")?;
    if payload.items.is_empty() {
        return Err("Cart is empty".into());
    }
    if payload.payment_method == "delivery" && payload.patient_id.is_none() {
        return Err("Delivery checkout requires a patient".into());
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

    let mut tx = begin_critical_transaction(&mut conn).await?;
    let result = async {
        let owned = native_checkout_owned_payload(&mut tx, actor_id, payload).await?;
        process_checkout_tx_with_request(&mut tx, owned, total_amount, &request_id).await
    }
    .await;
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
    session: State<'_, LocalSessionState>,
    payload: NativePurchaseRequest,
    expected_existing_status: Option<String>,
    request_id: Option<String>,
) -> Result<PurchaseResult, String> {
    let _actor_guard = session.authorize_session().await?;
    let actor_id = _actor_guard.as_deref().ok_or("Purchase login required")?;
    let mut conn = open_app_connection(&app).await?;

    let mut tx = begin_critical_transaction(&mut conn).await?;
    let result = async {
        let pharmacy_id = active_native_actor_pharmacy(&mut tx, actor_id).await?;
        // Creating a new invoice, even an editable draft, MUST have a durable
        // native request nonce. A same-nonce retry cannot create a new invoice
        // after an ambiguous IPC success or after its original was deleted.
        let is_creation = expected_existing_status.is_none();
        let original_draft_sha = if is_creation && payload.status.as_deref() == Some("draft") {
            Some(super::purchase_posting_provenance::purchase_draft_request_sha256(&payload)?)
        } else {
            None
        };
        if is_creation {
            super::sales_cogs_provenance::canonical_request_id(
                request_id
                    .as_deref()
                    .ok_or("Purchase create request UUIDv4 required")?,
            )?;
        }
        let supplier_id = payload.supplier_id;
        let result = save_purchase_invoice_tx_checked(
            &mut tx,
            payload.with_native_owner(actor_id, &pharmacy_id),
            expected_existing_status.as_deref(),
        )
        .await?;
        if is_creation {
            super::purchase_posting_provenance::record_purchase_creation(
                &mut tx,
                request_id.as_deref().unwrap(),
                &result.id,
                actor_id,
                &pharmacy_id,
                supplier_id,
                result.total_amount,
            )
            .await?;
            if let Some(digest) = original_draft_sha.as_deref() {
                super::purchase_posting_provenance::record_purchase_draft_creation(
                    &mut tx,
                    request_id.as_deref().unwrap(),
                    &result.id,
                    actor_id,
                    &pharmacy_id,
                    digest,
                )
                .await?;
            }
        }
        Ok(result)
    }
    .await;
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
    session: State<'_, LocalSessionState>,
    payload: DeletePurchasePayload,
) -> Result<(), String> {
    let _actor_guard = session.authorize_session().await?;
    let actor_id = _actor_guard.as_deref().ok_or("Purchase login required")?;
    let mut conn = open_app_connection(&app).await?;
    let mut tx = begin_critical_transaction(&mut conn).await?;
    let result = async {
        let pharmacy_id = active_native_actor_pharmacy(&mut tx, actor_id).await?;
        delete_purchase_invoice_tx(
            &mut tx,
            &payload.invoice_id,
            payload.remove_inventory,
            actor_id,
            Some(&pharmacy_id),
        )
        .await
    }
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
    session: State<'_, LocalSessionState>,
    payload: NativeReturnRequest,
    request_id: String,
) -> Result<ReturnResult, String> {
    super::sales_cogs_provenance::canonical_request_id(&request_id)?;
    let actor_guard = session.authorize_session().await?;
    let actor_id = actor_guard.as_deref().ok_or("Return login required")?;
    payload.validate()?;
    let mut conn = open_app_connection(&app).await?;
    let mut tx = begin_critical_transaction(&mut conn).await?;
    let result = async {
        let pharmacy_id = active_native_actor_pharmacy(&mut tx, actor_id).await?;
        create_return_tx_with_request(
            &mut tx,
            payload.with_native_owner(actor_id, pharmacy_id),
            &request_id,
        )
        .await
    }
    .await;
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
    session: State<'_, LocalSessionState>,
    payload: NativeNegativeStockSettlementRequest,
) -> Result<NegativeStockSettlementResult, String> {
    let actor_guard = session.authorize_session().await?;
    let actor_id = actor_guard.as_deref().ok_or("Settlement login required")?;
    payload.validate()?;

    let mut conn = open_app_connection(&app).await?;
    let mut tx = begin_critical_transaction(&mut conn).await?;
    let result = async {
        let pharmacy_id = active_native_actor_pharmacy(&mut tx, actor_id).await?;
        let owned = payload.with_native_owner(actor_id, pharmacy_id);
        settle_negative_sale_item_tx(&mut tx, &owned).await
    }
    .await;
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

async fn begin_critical_transaction(
    conn: &mut SqliteConnection,
) -> Result<Transaction<'_, Sqlite>, String> {
    Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
        .await
        .map_err(|e| e.to_string())
}

pub(super) fn bind_json_value<'q>(
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

// Comments are SQLite whitespace, but the small write-target parser is not a
// full SQLite parser. Reject comments outside quoted values before inspecting
// protected tables; user-entered strings and identifiers remain supported.
fn has_sql_comment(sql: &str) -> bool {
    let bytes = sql.as_bytes();
    let mut quote: Option<u8> = None;
    let mut i = 0;
    while i < bytes.len() {
        let current = bytes[i];
        let next = bytes.get(i + 1).copied();
        if let Some(ending) = quote {
            if current == ending {
                if next == Some(ending) {
                    i += 1; // doubled SQL quote escape
                } else {
                    quote = None;
                }
            }
        } else {
            match current {
                b'\'' | b'"' | b'`' => quote = Some(current),
                b'[' => quote = Some(b']'),
                b'-' if next == Some(b'-') => return true,
                b'/' if next == Some(b'*') => return true,
                _ => {}
            }
        }
        i += 1;
    }
    false
}

fn validate_write_sql(sql: &str) -> Result<(), String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("Empty SQL is not allowed".into());
    }

    let upper = trimmed.to_ascii_uppercase();
    if has_sql_comment(trimmed) {
        return Err("SQL comments are not allowed in generic writes".into());
    }
    let first = upper.split_whitespace().next().unwrap_or("");
    if !matches!(first, "INSERT" | "UPDATE" | "DELETE") {
        return Err(format!("SQL command '{}' is not allowed", first));
    }

    let target = write_target_table(trimmed)
        .ok_or_else(|| "Could not determine SQL write target".to_string())?;
    // Suppliers and their ledger are shared legacy rows with no independent
    // pharmacy owner. A generic renderer SQL write cannot establish ownership
    // from the current actor or a supplier ID. Native supplier payment and
    // purchase commands use their own transactional, source-bound writes.
    // Future native supplier provenance tables must never acquire this bypass.
    if matches!(target.as_str(), "suppliers" | "supplier_transactions")
        || target.starts_with("native_supplier_")
    {
        return Err("Supplier directory and ledger writes require typed native commands".into());
    }
    // Clinical rows predate pharmacy ownership. Generic SQL must never be
    // permitted to adopt an old patient by forging the new ownership witness,
    // mutate a foreign patient, or rewrite medicine/wallet source history.
    if matches!(target.as_str(),
        "patients" | "patient_allergies" | "patient_conditions"
        | "patient_transactions" | "refill_reminders"
    ) || target.starts_with("native_patient_") {
        return Err("Patient directory and clinical writes require typed native commands".into());
    }
    if target == "_sqlx_migrations" || target.starts_with("sqlite_") {
        return Err("Writes to internal database metadata are not allowed".into());
    }
    if target == "config" {
        return Err("Configuration writes require a typed settings command".into());
    }
    if target == "sync_metadata" {
        return Err("Sync metadata writes require a typed sync command".into());
    }
    if target == "activity_log" {
        let normalized = upper.split_whitespace().collect::<Vec<_>>().join(" ");
        if matches!(first, "UPDATE" | "DELETE")
            || normalized.starts_with("INSERT OR ")
            || normalized.contains(" ON CONFLICT")
        {
            return Err("Audit history can only be appended through generic SQL".into());
        }
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

fn write_target_table(sql: &str) -> Option<String> {
    fn normalize_identifier(token: &str) -> String {
        let bare = token
            .split('(')
            .next()
            .unwrap_or(token)
            .trim_end_matches(';')
            .split('.')
            .next_back()
            .unwrap_or(token)
            .trim_matches(|character| matches!(character, '"' | '\'' | '`' | '[' | ']'));
        bare.to_ascii_lowercase()
    }

    let mut tokens = sql.trim().trim_end_matches(';').split_whitespace();
    let verb = tokens.next()?.to_ascii_uppercase();
    let target = match verb.as_str() {
        "INSERT" => {
            let mut next = tokens.next()?;
            if next.eq_ignore_ascii_case("OR") {
                tokens.next()?;
                next = tokens.next()?;
            }
            if !next.eq_ignore_ascii_case("INTO") {
                return None;
            }
            tokens.next()?
        }
        "UPDATE" => {
            let mut next = tokens.next()?;
            if next.eq_ignore_ascii_case("OR") {
                tokens.next()?;
                next = tokens.next()?;
            }
            next
        }
        "DELETE" => {
            if !tokens.next()?.eq_ignore_ascii_case("FROM") {
                return None;
            }
            tokens.next()?
        }
        _ => return None,
    };
    // SQLite permits `main . config` and `main. config`; our lightweight
    // tokenizer cannot safely resolve split schema qualifiers. Reject these
    // uncommon spellings rather than accidentally allowing a protected table.
    if target.ends_with('.')
        || tokens
            .clone()
            .next()
            .is_some_and(|next| next == "." || next.starts_with('.'))
    {
        return None;
    }
    Some(normalize_identifier(target))
}

fn validate_read_sql(sql: &str) -> Result<(), String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("Empty SQL is not allowed".into());
    }

    let upper = trimmed.to_ascii_uppercase();
    let first = upper.split_whitespace().next().unwrap_or("");
    if !matches!(first, "SELECT" | "WITH") {
        return Err(format!(
            "SQL command '{}' is not allowed for transactional reads",
            first
        ));
    }
    if upper.contains("ATTACH") || upper.contains("DETACH") || upper.contains("LOAD_EXTENSION") {
        return Err("SQL command contains a blocked operation".into());
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
    let pharmacy_id = sqlx::query_scalar::<_, String>(
        r#"
        SELECT COALESCE(NULLIF(TRIM(pharmacy_id), ''), 'local_default')
        FROM users
        WHERE CAST(id AS TEXT) = CAST(? AS TEXT)
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Shift user does not exist".to_string())?;

    if let Some(shift_id) = requested_shift_id.filter(|id| !id.trim().is_empty()) {
        if let Some(row) = sqlx::query(
            r#"
            SELECT s.id
            FROM shifts s
            WHERE s.id = ?
              AND LOWER(COALESCE(s.status, '')) = 'open'
              AND COALESCE(NULLIF(TRIM(s.pharmacy_id), ''), 'local_default') = ?
            "#,
        )
        .bind(shift_id)
        .bind(&pharmacy_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        {
            return row.try_get("id").map(Some).map_err(|e| e.to_string());
        }
    }

    if let Some(row) = sqlx::query(
        r#"
        SELECT s.id
        FROM shifts s
        WHERE LOWER(COALESCE(s.status, '')) = 'open'
          AND COALESCE(NULLIF(TRIM(s.pharmacy_id), ''), 'local_default') = ?
        ORDER BY s.rowid ASC
        LIMIT 1
        "#,
    )
    .bind(&pharmacy_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    {
        return row.try_get("id").map(Some).map_err(|e| e.to_string());
    }

    let shift_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO shifts (id, user_id, pharmacy_id, status)
        SELECT ?, ?, ?, 'open'
        WHERE NOT EXISTS (
          SELECT 1
          FROM shifts s
          WHERE LOWER(COALESCE(s.status, '')) = 'open'
            AND COALESCE(NULLIF(TRIM(s.pharmacy_id), ''), 'local_default') = ?
        )
        "#,
    )
    .bind(&shift_id)
    .bind(user_id)
    .bind(&pharmacy_id)
    .bind(&pharmacy_id)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    sqlx::query_scalar::<_, String>(
        r#"
        SELECT s.id
        FROM shifts s
        WHERE LOWER(COALESCE(s.status, '')) = 'open'
          AND COALESCE(NULLIF(TRIM(s.pharmacy_id), ''), 'local_default') = ?
        ORDER BY s.rowid ASC
        LIMIT 1
        "#,
    )
    .bind(&pharmacy_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())
}

async fn create_return_tx(
    tx: &mut Transaction<'_, Sqlite>,
    payload: ReturnPayload,
) -> Result<ReturnResult, String> {
    create_return_tx_with_request(tx, payload, &uuid::Uuid::new_v4().to_string()).await
}

async fn create_return_tx_with_request(
    tx: &mut Transaction<'_, Sqlite>,
    payload: ReturnPayload,
    request_id: &str,
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
    let user = sqlx::query(
        "SELECT pharmacy_id, role, permissions FROM users WHERE CAST(id AS TEXT) = CAST(? AS TEXT) AND COALESCE(is_active, 1) = 1",
    )
    .bind(&payload.user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Unauthorized: active user required".to_string())?;
    let user_role: Option<String> = user.try_get("role").ok();
    let user_permissions: Option<String> = user.try_get("permissions").ok();
    if !user_has_permission(
        user_role.as_deref(),
        user_permissions.as_deref(),
        "can_view_returns",
        false,
    ) {
        return Err("Unauthorized: can_view_returns permission required".into());
    }
    let user_pharmacy = normalize_pharmacy_id(
        user.try_get::<Option<String>, _>("pharmacy_id")
            .unwrap_or(None)
            .as_deref(),
    );
    let requested_pharmacy = normalize_pharmacy_id(payload.pharmacy_id.as_deref());
    if user_pharmacy != requested_pharmacy {
        return Err("User belongs to another pharmacy".into());
    }

    payload.shift_id =
        resolve_open_shift(tx, &payload.user_id, payload.shift_id.as_deref()).await?;

    let invoice = sqlx::query(
        "SELECT patient_id, pharmacy_id, payment_method, status, CAST(total_amount AS REAL) AS total_amount, CAST(COALESCE(discount_amount, 0) AS REAL) AS discount_amount, CAST(COALESCE(points_earned, 0) AS INTEGER) AS points_earned FROM sales_invoices WHERE id = ?",
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
    if !invoice_status.is_empty()
        && invoice_status != "completed"
        && invoice_status != "approved"
        && invoice_status != "delivered"
    {
        return Err("Only completed sales invoices can be returned".into());
    }
    if invoice
        .try_get::<Option<String>, _>("payment_method")
        .unwrap_or(None)
        .as_deref()
        .is_some_and(|method| method.eq_ignore_ascii_case("delivery"))
        && invoice_status != "delivered"
    {
        return Err("يجب تسوية تحصيل فاتورة التوصيل قبل إجراء المرتجع".into());
    }
    let invoice_patient = invoice
        .try_get::<Option<String>, _>("patient_id")
        .unwrap_or(None);
    let invoice_points_earned: i64 = invoice.try_get("points_earned").unwrap_or(0);
    let (invoice_points_redeemed, invoice_loyalty_discount_amount) =
        sales_invoice_loyalty_snapshot(tx, &payload.invoice_id).await?;
    if invoice_points_redeemed < 0
        || !invoice_loyalty_discount_amount.is_finite()
        || invoice_loyalty_discount_amount < 0.0
    {
        return Err("Sales invoice has invalid loyalty snapshot".into());
    }
    if (payload.refund_method == "patient_account" || payload.refund_method == "wallet")
        && invoice_patient.is_none()
    {
        return Err("Patient account refund requires a patient linked to the invoice".into());
    }
    let invoice_pharmacy_raw = invoice
        .try_get::<Option<String>, _>("pharmacy_id")
        .unwrap_or(None);
    let invoice_pharmacy = normalize_pharmacy_id(invoice_pharmacy_raw.as_deref());
    if requested_pharmacy != invoice_pharmacy {
        return Err("Sales invoice belongs to another pharmacy".into());
    }
    if invoice_pharmacy_raw.as_deref() != Some(requested_pharmacy.as_str())
        || requested_pharmacy == "local_default"
    {
        return Err("Historical sales return requires independently reconciled pharmacy ownership".into());
    }
    // The 043 receipt is the source that establishes actual sale, actor,
    // journal and acquisition COGS. The UI's stricter read-only search is not
    // authorization for direct invocation of this financial writer; enforce
    // the same source relationship here before refunding or restocking.
    let original_sale_receipts: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM native_sale_cogs_provenance proof
         JOIN sales_invoices original ON original.id=proof.sale_id
         JOIN daily_journals journal ON journal.id=proof.journal_id
         WHERE proof.sale_id=? AND original.pharmacy_id=?
           AND proof.pharmacy_id=original.pharmacy_id
           AND proof.actor_id=CAST(original.user_id AS TEXT)
           AND proof.payment_method=original.payment_method
           AND typeof(original.total_amount) IN ('integer','real')
           AND ABS(proof.sale_micros-original.total_amount*1000000)<2
           AND proof.line_count>0 AND proof.line_count=(
               SELECT COUNT(*) FROM sales_items items WHERE items.invoice_id=original.id)
           AND journal.pharmacy_id=original.pharmacy_id
           AND CAST(journal.created_by AS TEXT)=proof.actor_id
           AND ABS(journal.total_amount*1000000-(proof.sale_micros+proof.cogs_micros))<2",
    )
    .bind(&payload.invoice_id)
    .bind(&invoice_pharmacy)
    .fetch_one(&mut **tx)
    .await
    .map_err(|_| "Sales return requires verifiable original native 043 sale and COGS receipt".to_string())?;
    if original_sale_receipts != 1 {
        return Err("Sales return requires verifiable original native 043 sale and COGS receipt".into());
    }
    if let Some(patient_id) = invoice_patient.as_deref() {
        // A pharmacy-owned invoice never grants ownership of the global
        // historical patient row. Patient balances/points may only be
        // changed for a patient created with an explicit native witness.
        require_patient_directory_ownership(tx, patient_id, &user_pharmacy).await?;
    }

    let unresolved_legacy_returns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM return_items ri JOIN returns r ON ri.return_id = r.id WHERE r.invoice_id = ? AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed') AND ri.sale_item_id IS NULL",
    )
    .bind(&payload.invoice_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if unresolved_legacy_returns > 0 {
        return Err("Legacy return history has unresolved sale-item lineage".into());
    }
    let unreconciled_refunds: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM returns r
         WHERE r.invoice_id = ?
           AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
           AND (typeof(r.total_refund) NOT IN ('real', 'integer')
             OR NOT EXISTS (SELECT 1 FROM return_items ri WHERE ri.return_id = r.id)
             OR EXISTS (SELECT 1 FROM return_items ri WHERE ri.return_id = r.id
                 AND (typeof(ri.total_price) NOT IN ('real', 'integer')
                   OR ri.total_price < 0))
             OR r.total_refund < 0
             OR abs(r.total_refund - (SELECT COALESCE(SUM(ri.total_price), 0)
                 FROM return_items ri WHERE ri.return_id = r.id)) > 0.005)
         LIMIT 1",
    )
    .bind(&payload.invoice_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if unreconciled_refunds.is_some() {
        return Err("Sales return history has unreconciled historical refund amounts".into());
    }
    let prior_gross_returned = if invoice_points_redeemed > 0 {
        finalized_sales_return_gross(tx, &payload.invoice_id).await?
    } else {
        0.0
    };

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
    let invoice_payment_method = invoice
        .try_get::<Option<String>, _>("payment_method")
        .unwrap_or(None)
        .unwrap_or_default()
        .to_ascii_lowercase();
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
    let merchandise_total = (invoice_gross - discount_amount).max(0.0);
    let refundable_invoice_total =
        if invoice_status == "delivered" && invoice_payment_method == "delivery" {
            invoice_total.min(merchandise_total)
        } else {
            invoice_total
        };
    let remaining_invoice_refund = (refundable_invoice_total - already_refunded).max(0.0);
    if payload.refund_method == "patient_account" || payload.refund_method == "wallet" {
        if invoice_patient.is_none()
            || payload
                .patient_id
                .as_ref()
                .is_some_and(|id| Some(id) != invoice_patient.as_ref())
        {
            return Err("Patient refunds require the invoice patient".into());
        }
        payload.patient_id = invoice_patient.clone();
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
        large_to_medium: f64,
        medium_to_small: f64,
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
            r#"
            SELECT CAST(si.quantity_sold AS REAL) AS quantity_sold,
                   CAST(si.unit_price AS REAL) AS unit_price,
                   CAST(si.cost_price AS REAL) AS cost_price,
                   si.unit, si.drug_id, si.inventory_id,
                   COALESCE(md.no_return, 0) AS no_return, md.trade_name,
                   COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium,
                   COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(i.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1) AS medium_to_small,
                   md.medium_unit,
                   md.small_unit
            FROM sales_items si
            LEFT JOIN inventory i ON i.id = si.inventory_id
            LEFT JOIN master_drugs md ON si.drug_id = md.id
            WHERE si.id = ? AND si.invoice_id = ?
            "#,
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
        let historical_large_to_medium = sold
            .try_get::<i64, _>("large_to_medium")
            .unwrap_or(1)
            .max(1) as f64;
        let historical_medium_to_small = sold
            .try_get::<i64, _>("medium_to_small")
            .unwrap_or(1)
            .max(1) as f64;
        let medium_unit = sold
            .try_get::<Option<String>, _>("medium_unit")
            .ok()
            .flatten();
        let small_unit = sold
            .try_get::<Option<String>, _>("small_unit")
            .ok()
            .flatten();
        let prior_returns = sqlx::query(
            "SELECT CAST(COALESCE(ri.quantity_returned, 0) AS REAL) AS quantity_returned, ri.unit FROM return_items ri JOIN returns r ON ri.return_id = r.id WHERE r.invoice_id = ? AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed') AND ri.sale_item_id = ?",
        )
        .bind(&payload.invoice_id)
        .bind(sale_item_id)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        let mut returned = 0.0;
        for prior in prior_returns {
            let prior_quantity: f64 = prior.try_get("quantity_returned").unwrap_or(0.0);
            let prior_unit = prior
                .try_get::<Option<String>, _>("unit")
                .unwrap_or(None)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| sold_unit.clone());
            let prior_large = unit_quantity_in_large(
                prior_quantity,
                &prior_unit,
                historical_large_to_medium,
                historical_medium_to_small,
                medium_unit.as_deref(),
                small_unit.as_deref(),
            );
            returned += large_quantity_in_unit(
                prior_large,
                &sold_unit,
                historical_large_to_medium,
                historical_medium_to_small,
                medium_unit.as_deref(),
                small_unit.as_deref(),
            );
        }
        let unit = item.unit.as_deref().unwrap_or("large");
        let restock_qty = unit_quantity_in_large(
            item.quantity,
            unit,
            historical_large_to_medium,
            historical_medium_to_small,
            medium_unit.as_deref(),
            small_unit.as_deref(),
        );
        let returned_in_sold_unit = large_quantity_in_unit(
            restock_qty,
            &sold_unit,
            historical_large_to_medium,
            historical_medium_to_small,
            medium_unit.as_deref(),
            small_unit.as_deref(),
        );
        let requested = requested_by_sale_item.entry(sale_item_id).or_default();
        *requested += returned_in_sold_unit;
        if *requested > sold_qty - returned + 0.000_001 {
            return Err(format!(
                "Return quantity exceeds remaining quantity for {}",
                item.drug_name
            ));
        }
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
            large_to_medium: historical_large_to_medium,
            medium_to_small: historical_medium_to_small,
            inventory_selling_price: gross_line_refund / restock_qty,
            gross_line_refund,
            line_refund: 0.0,
        });
    }

    let paid_ratio = if invoice_gross > 0.0 {
        refundable_invoice_total / invoice_gross
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
    sqlx::query("INSERT INTO returns (id, invoice_id, user_id, pharmacy_id, shift_id, reason, total_refund, refund_method, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved')")
        .bind(&return_id)
        .bind(&payload.invoice_id)
        .bind(&payload.user_id)
        .bind(&invoice_pharmacy)
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
            prepared.cost_price,
            prepared.restock_qty,
            prepared.large_to_medium,
            prepared.medium_to_small,
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

    let posted_journal =
        apply_return_accounting(tx, &payload, &return_id, total_refund, total_cogs_reversal)
            .await?;
    super::sales_cogs_provenance::record_return(
        tx,
        request_id,
        &return_id,
        &payload.invoice_id,
        &payload.user_id,
        &invoice_pharmacy,
        &payload.refund_method,
        &posted_journal,
        total_refund,
        total_cogs_reversal,
    )
    .await?;
    if invoice_points_earned > 0 && invoice_total > 0.0 {
        if let Some(patient_id) = invoice_patient.as_deref() {
            let target_reversed = |refunded: f64| -> i64 {
                if refunded + 0.005 >= invoice_total {
                    invoice_points_earned
                } else {
                    ((invoice_points_earned as f64) * (refunded.max(0.0) / invoice_total)).floor()
                        as i64
                }
            };
            let points_to_reverse = (target_reversed(already_refunded + total_refund)
                - target_reversed(already_refunded))
            .max(0);
            if points_to_reverse > 0 {
                // Earned points may already have been spent on a later sale. Keep the
                // unrecovered amount as loyalty debt instead of silently forgiving it.
                sqlx::query("UPDATE patients SET points_balance = COALESCE(points_balance, 0) - ? WHERE id = ?")
                    .bind(points_to_reverse)
                    .bind(patient_id)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    if invoice_points_redeemed > 0 && invoice_gross > 0.0 {
        if let Some(patient_id) = invoice_patient.as_deref() {
            let target_restored = |gross_returned: f64| -> i64 {
                if gross_returned + 0.005 >= invoice_gross {
                    invoice_points_redeemed
                } else {
                    ((invoice_points_redeemed as f64) * (gross_returned.max(0.0) / invoice_gross))
                        .floor() as i64
                }
            };
            let points_to_restore =
                (target_restored(prior_gross_returned + gross_requested_refund)
                    - target_restored(prior_gross_returned))
                .max(0);
            if points_to_restore > 0 {
                sqlx::query(
                    "UPDATE patients SET points_balance = COALESCE(points_balance, 0) + ? WHERE id = ?",
                )
                .bind(points_to_restore)
                .bind(patient_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(ReturnResult {
        return_id,
        total_refund,
    })
}

// Preflight JavaScript reads are advisory: assert the expected lifecycle state
// under the same SQLite writer transaction that applies stock and accounting.
async fn save_purchase_invoice_tx_checked(
    tx: &mut Transaction<'_, Sqlite>,
    payload: PurchasePayload,
    expected_existing_status: Option<&str>,
) -> Result<PurchaseResult, String> {
    if expected_existing_status.is_none() {
        if let Some(id) = payload.id.as_deref().filter(|id| !id.trim().is_empty()) {
            // A renderer could otherwise omit its optimistic-concurrency
            // status and force an arbitrary edit to an existing posted/draft
            // invoice, bypassing the checked lifecycle UI. Keep compatibility
            // with new caller-provided invoice IDs that do not yet exist.
            let exists: Option<i64> =
                sqlx::query_scalar("SELECT 1 FROM purchase_invoices WHERE id=? LIMIT 1")
                    .bind(id)
                    .fetch_optional(&mut **tx)
                    .await
                    .map_err(|error| error.to_string())?;
            if exists.is_some() {
                return Err(
                    "Existing purchases require a checked original lifecycle status".into(),
                );
            }
        }
    }
    if let Some(expected) = expected_existing_status {
        if !matches!(expected, "draft" | "completed") {
            return Err("Invalid expected purchase invoice status".into());
        }
        if expected == "completed" && payload.status.as_deref() == Some("draft") {
            return Err("A completed purchase cannot be saved as a draft".into());
        }
        let invoice_id = payload
            .id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .ok_or("An existing purchase invoice ID is required")?;
        let current_status: Option<String> =
            sqlx::query_scalar("SELECT COALESCE(status, '') FROM purchase_invoices WHERE id = ?")
                .bind(invoice_id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        if current_status.as_deref() != Some(expected) {
            return Err("Purchase invoice changed or was deleted; reload before saving".into());
        }
    }
    save_purchase_invoice_tx(tx, payload).await
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
        let drug_ids: HashSet<i64> = payload.cart.iter().map(|item| item.id).collect();
        let mut non_expiring_drug_ids = HashSet::new();
        if !drug_ids.is_empty() {
            let sql = format!(
                "SELECT id FROM master_drugs WHERE id IN ({}) AND COALESCE(has_expiry, 1) = 0",
                std::iter::repeat("?")
                    .take(drug_ids.len())
                    .collect::<Vec<_>>()
                    .join(",")
            );
            let mut query = sqlx::query(&sql);
            for drug_id in &drug_ids {
                query = query.bind(drug_id);
            }
            for row in query
                .fetch_all(&mut **tx)
                .await
                .map_err(|e| e.to_string())?
            {
                non_expiring_drug_ids.insert(row.get::<i64, _>("id"));
            }
        }
        validate_completed_purchase_expiry_with_non_expiring(
            &payload.cart,
            &today,
            &non_expiring_drug_ids,
        )?;
    }
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
    // Supplier invoice numbers are not unique lot identifiers.
    let batch_number = format!("PURCHASE-{invoice_id}");
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
    let mut barcode_owners: HashMap<String, i64> = HashMap::new();
    let mut changes_master_conversion = false;
    for item in &payload.cart {
        let drug_row = sqlx::query(
            "SELECT COALESCE(stop_dealing, 0) AS stop_dealing,
                    COALESCE(NULLIF(large_to_medium, 0), 1) AS large_to_medium,
                    trade_name, trade_name_en, large_unit, medium_unit, small_unit
             FROM master_drugs
             WHERE id = ?",
        )
        .bind(item.id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        let Some(drug_row) = drug_row else {
            return Err(format!(
                "Drug {} no longer exists; remove it and add it again",
                item.id
            ));
        };
        let stopped = drug_row
            .try_get::<i64, _>("stop_dealing")
            .unwrap_or_default();
        if stopped == 1 {
            return Err(
                "هذا الصنف مؤرشف أو متوقف؛ أزله من الفاتورة أو أعد تفعيله من إدارة الأصناف".into(),
            );
        }
        let current_large_to_medium = drug_row
            .try_get::<i64, _>("large_to_medium")
            .unwrap_or(1)
            .max(1);
        // These fields were formerly checked in the renderer before native
        // IPC. Keep single-container validation authoritative in the native
        // writer transaction when generic renderer SELECT is unavailable.
        if item.strips_per_box != 1
            && inferred_single_container(
                drug_row
                    .try_get::<Option<String>, _>("trade_name")
                    .ok()
                    .flatten()
                    .as_deref(),
                drug_row
                    .try_get::<Option<String>, _>("trade_name_en")
                    .ok()
                    .flatten()
                    .as_deref(),
                drug_row
                    .try_get::<Option<String>, _>("large_unit")
                    .ok()
                    .flatten()
                    .as_deref(),
                drug_row
                    .try_get::<Option<String>, _>("medium_unit")
                    .ok()
                    .flatten()
                    .as_deref(),
                drug_row
                    .try_get::<Option<String>, _>("small_unit")
                    .ok()
                    .flatten()
                    .as_deref(),
                current_large_to_medium,
            )
        {
            return Err("Single-container purchase conversion must equal one".into());
        }
        changes_master_conversion |= item.strips_per_box.max(1) != current_large_to_medium;
        if let Some(barcode) = item
            .barcode
            .as_deref()
            .map(str::trim)
            .filter(|barcode| !barcode.is_empty())
        {
            let normalized = barcode.to_lowercase();
            if barcode_owners
                .insert(normalized, item.id)
                .is_some_and(|owner| owner != item.id)
            {
                return Err("Barcode is already assigned to another drug".into());
            }
            let conflict = sqlx::query_scalar::<_, i64>(
                r#"
                SELECT id FROM master_drugs
                WHERE id != ? AND barcode IS NOT NULL AND TRIM(barcode) = ? COLLATE NOCASE
                UNION ALL
                SELECT CAST(drug_id AS INTEGER) FROM inventory
                WHERE drug_id != ? AND barcode IS NOT NULL AND TRIM(barcode) = ? COLLATE NOCASE
                  AND (quantity IS NULL OR quantity != 0)
                LIMIT 1
                "#,
            )
            .bind(item.id)
            .bind(barcode)
            .bind(item.id)
            .bind(barcode)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
            if conflict.is_some() {
                return Err("Barcode is already assigned to another drug".into());
            }
        }
    }

    let old_invoice = sqlx::query("SELECT * FROM purchase_invoices WHERE id = ?")
        .bind(&invoice_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(old) = old_invoice.as_ref() {
        let old_pharmacy_id: Option<String> = old.try_get("pharmacy_id").unwrap_or(None);
        if normalize_pharmacy_id(old_pharmacy_id.as_deref())
            != normalize_pharmacy_id(payload.pharmacy_id.as_deref())
        {
            return Err("Purchase invoice belongs to another pharmacy".into());
        }
        let old_status: String = old.try_get("status").unwrap_or_default();
        if old_status == "completed" {
            ensure_no_finalized_purchase_returns(tx, &invoice_id, "edit").await?;
            if let Some(result) = edit_consumed_purchase(
                tx,
                &invoice_id,
                old,
                &payload,
                items_total,
                inventory_paid_factor,
            )
            .await?
            {
                return Ok(result);
            }
        }
    }
    // Protected edits preserve the original lot conversion without rewriting the master.
    if changes_master_conversion
        && !user_has_permission(
            user_role.as_deref(),
            user_permissions.as_deref(),
            "can_modify_unit_conversion",
            false,
        )
    {
        return Err("Unauthorized: can_modify_unit_conversion permission required".into());
    }
    let mut editing_completed = false;
    if let Some(old) = old_invoice {
        if old.try_get::<String, _>("status").unwrap_or_default() == "completed" {
            editing_completed = true;
            reverse_completed_purchase(tx, &invoice_id, &old, &payload, inventory_paid_factor)
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
        let medium_to_small = drug_medium_to_small(tx, item.id).await?;
        let inserted_item = sqlx::query(
            "INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, unit_id, expiry_date, cost_price, selling_price, bonus_quantity, tax_percent, discount_percent, strips_per_box, medium_to_small, barcode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
        .bind(medium_to_small)
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
            }
        }

        let item_total = purchase_item_total(item, payload.tax_percent);

        if final_status == "completed" && !editing_completed {
            // INVARIANT: item.quantity must be in large units (boxes).
            // The purchase UI enforces box-quantity entry. No unit
            // conversion is applied here. Bonus stock is treated as
            // received inventory alongside paid stock.
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

            resolve_shortage_if_stock_recovered(tx, item.id, payload.pharmacy_id.as_deref())
                .await?;
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
        let posted_journal = apply_purchase_accounting(
            tx,
            &payload,
            &invoice_id,
            final_total,
            payment_method,
            effective_supplier_id,
            &effective_user_id,
        )
        .await?;
        super::purchase_posting_provenance::record_purchase_event(
            tx,
            &invoice_id,
            &effective_user_id,
            payload
                .pharmacy_id
                .as_deref()
                .ok_or("Purchase pharmacy missing")?,
            effective_supplier_id,
            payment_method,
            "initial",
            0.0,
            final_total,
            &posted_journal,
        )
        .await?;

        let action = if editing_completed {
            "EDIT_COMPLETED_PURCHASE"
        } else {
            "COMPLETE_PURCHASE"
        };
        sqlx::query("INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)")
            .bind(&effective_user_id)
            .bind(action)
            .bind(format!("Purchase {} value {}", invoice_id, final_total))
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
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

async fn sales_invoice_loyalty_snapshot(
    tx: &mut Transaction<'_, Sqlite>,
    invoice_id: &str,
) -> Result<(i64, f64), String> {
    let row = sqlx::query(
        "SELECT CAST(COALESCE(points_redeemed, 0) AS INTEGER) AS points_redeemed, CAST(COALESCE(loyalty_discount_amount, 0) AS REAL) AS loyalty_discount_amount FROM sales_invoices WHERE id = ?",
    )
    .bind(invoice_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Invoice not found".to_string())?;
    Ok((
        row.try_get::<i64, _>("points_redeemed").unwrap_or(0),
        row.try_get::<f64, _>("loyalty_discount_amount")
            .unwrap_or(0.0),
    ))
}

async fn finalized_sales_return_gross(
    tx: &mut Transaction<'_, Sqlite>,
    invoice_id: &str,
) -> Result<f64, String> {
    let rows = sqlx::query(
        r#"
        SELECT CAST(COALESCE(ri.quantity_returned, 0) AS REAL) AS quantity_returned,
               COALESCE(NULLIF(ri.unit, ''), NULLIF(si.unit, ''), 'large') AS return_unit,
               COALESCE(NULLIF(si.unit, ''), 'large') AS sold_unit,
               CAST(COALESCE(si.unit_price, 0) AS REAL) AS sold_unit_price,
               COALESCE(NULLIF(si.large_to_medium, 0), 1) AS large_to_medium,
               COALESCE(NULLIF(si.medium_to_small, 0), 1) AS medium_to_small,
               md.medium_unit,
               md.small_unit
        FROM return_items ri
        JOIN returns r ON r.id = ri.return_id
        JOIN sales_items si ON si.id = ri.sale_item_id AND si.invoice_id = r.invoice_id
        LEFT JOIN master_drugs md ON md.id = si.drug_id
        WHERE r.invoice_id = ?
          AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
          AND ri.sale_item_id IS NOT NULL
        "#,
    )
    .bind(invoice_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;

    let mut gross = 0.0;
    for row in rows {
        let quantity: f64 = row.try_get("quantity_returned").unwrap_or(0.0);
        let sold_unit_price: f64 = row.try_get("sold_unit_price").unwrap_or(0.0);
        if !quantity.is_finite()
            || quantity < 0.0
            || !sold_unit_price.is_finite()
            || sold_unit_price < 0.0
        {
            return Err("Sales return history has invalid loyalty basis".into());
        }
        let return_unit: String = row
            .try_get("return_unit")
            .unwrap_or_else(|_| "large".into());
        let sold_unit: String = row.try_get("sold_unit").unwrap_or_else(|_| "large".into());
        let large_to_medium = row.try_get::<i64, _>("large_to_medium").unwrap_or(1).max(1) as f64;
        let medium_to_small = row.try_get::<i64, _>("medium_to_small").unwrap_or(1).max(1) as f64;
        let medium_unit = row
            .try_get::<Option<String>, _>("medium_unit")
            .unwrap_or(None);
        let small_unit = row
            .try_get::<Option<String>, _>("small_unit")
            .unwrap_or(None);
        let large_quantity = unit_quantity_in_large(
            quantity,
            &return_unit,
            large_to_medium,
            medium_to_small,
            medium_unit.as_deref(),
            small_unit.as_deref(),
        );
        let sold_quantity = large_quantity_in_unit(
            large_quantity,
            &sold_unit,
            large_to_medium,
            medium_to_small,
            medium_unit.as_deref(),
            small_unit.as_deref(),
        );
        gross += sold_quantity * sold_unit_price;
    }
    if !gross.is_finite() || gross < 0.0 {
        return Err("Sales return history has invalid loyalty basis".into());
    }
    Ok(gross)
}

async fn patient_outstanding_debt(
    tx: &mut Transaction<'_, Sqlite>,
    patient_id: &str,
) -> Result<f64, String> {
    let row = sqlx::query(
        r#"
        SELECT CAST(
          (SELECT COALESCE(CAST(opening_balance AS REAL), 0) FROM patients WHERE id = ?) +
          (SELECT COALESCE(SUM(CAST(total_amount AS REAL)), 0) FROM sales_invoices WHERE patient_id = ? AND payment_method = 'credit' AND (status IS NULL OR status = '' OR LOWER(status) IN ('completed', 'approved', 'delivered'))) -
          (SELECT COALESCE(SUM(CAST(r.total_refund AS REAL)), 0) FROM returns r JOIN sales_invoices si ON r.invoice_id = si.id WHERE si.patient_id = ? AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed') AND r.refund_method = 'patient_account') -
          (SELECT COALESCE(SUM(ABS(CAST(amount AS REAL))), 0) FROM patient_transactions WHERE patient_id = ? AND type = 'payment') +
          (SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) FROM patient_transactions WHERE patient_id = ? AND type = 'adjustment') +
          (SELECT COALESCE(SUM(CASE WHEN fn.type = 'debit' THEN ABS(CAST(fn.amount AS REAL)) WHEN fn.type = 'credit' THEN -ABS(CAST(fn.amount AS REAL)) ELSE 0 END), 0)
             FROM financial_notices fn
            WHERE fn.target_type = 'customer' AND fn.target_id = ?
              AND (
                SELECT COUNT(*) FROM financial_notices ranked_notice
                 WHERE ranked_notice.target_type = 'customer'
                   AND ranked_notice.target_id = fn.target_id
                   AND ranked_notice.type = fn.type
                   AND ABS(CAST(ranked_notice.amount AS REAL) - CAST(fn.amount AS REAL)) < 0.000001
                   AND COALESCE(ranked_notice.date, '') = COALESCE(fn.date, '')
                   AND COALESCE(ranked_notice.user_id, '') = COALESCE(fn.user_id, '')
                   AND COALESCE(ranked_notice.reason, '') = COALESCE(fn.reason, '')
                   AND ranked_notice.rowid <= fn.rowid
              ) > (
                SELECT COUNT(*) FROM patient_transactions mirrored
                 WHERE mirrored.patient_id = fn.target_id
                   AND mirrored.type = 'adjustment'
                   AND ABS(CAST(mirrored.amount AS REAL) - CASE WHEN fn.type = 'debit' THEN ABS(CAST(fn.amount AS REAL)) WHEN fn.type = 'credit' THEN -ABS(CAST(fn.amount AS REAL)) ELSE 0 END) < 0.000001
                   AND COALESCE(mirrored.date, '') = COALESCE(fn.date, '')
                   AND COALESCE(mirrored.user_id, '') = COALESCE(fn.user_id, '')
                   AND COALESCE(mirrored.notes, '') = COALESCE(fn.reason, '')
              )
          )
        AS REAL) AS outstanding_balance
        "#,
    )
    .bind(patient_id)
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

/// A native-created patient directory witness is proof of identity, not proof
/// that all existing credit, repayment, return and notice amounts belong to
/// that pharmacy. Verify the sources before the credit-limit calculation can
/// authorize a new financially binding sale. No historical rows are assigned.
async fn verified_checkout_credit_debt(
    tx: &mut Transaction<'_, Sqlite>,
    patient_id: &str,
    pharmacy: &str,
) -> Result<f64, String> {
    if pharmacy.is_empty() || pharmacy == "local_default" {
        return Err("Patient credit provenance requires an explicit native tenant".into());
    }
    let opening: Option<f64> = sqlx::query_scalar(
        "SELECT CAST(opening_balance AS REAL) FROM main.patients WHERE id=?",
    )
    .bind(patient_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if opening.map_or(true, |value| !value.is_finite() || value.abs() > 0.000001) {
        return Err("Patient credit provenance has an unowned opening balance".into());
    }
    let foreign_sales: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.sales_invoices
         WHERE patient_id=? AND pharmacy_id IS NOT ?",
    )
    .bind(patient_id)
    .bind(pharmacy)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if foreign_sales != 0 {
        return Err("Patient credit provenance includes foreign or unscoped sales".into());
    }
    super::financial_notices_native::verify_proven_patient_credit_sources(
        &mut **tx, patient_id, pharmacy,
    )
    .await?;
    let prior_refunds: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.returns r
         JOIN main.sales_invoices s ON s.id=r.invoice_id
         WHERE s.patient_id=? AND r.refund_method='patient_account'
           AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')",
    )
    .bind(patient_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if prior_refunds > 0 {
        super::financial_notices_native::verify_patient_account_return_amounts(
            &mut **tx, patient_id, pharmacy,
        )
        .await?;
    }
    let transactions: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.patient_transactions WHERE patient_id=?",
    )
    .bind(patient_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if transactions > 0 {
        if super::financial_notices_native::count_untrusted_patient_transactions(
            &mut **tx, patient_id, pharmacy,
        )
        .await? != 0
        {
            return Err("Patient credit provenance has an unverified payment or refund".into());
        }
        super::patient_payments_native::verify_scoped_patient_payments(
            &mut **tx, patient_id, pharmacy,
        )
        .await?;
    }
    let notices: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.financial_notices
         WHERE target_type='customer' AND target_id=?",
    )
    .bind(patient_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if notices > 0 {
        let unscoped: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.financial_notices n
             LEFT JOIN main.financial_notice_native_scope scope ON scope.notice_id=n.id
             WHERE n.target_type='customer' AND n.target_id=?
               AND (n.pharmacy_id IS NOT ? OR scope.pharmacy_id IS NOT ?)",
        )
        .bind(patient_id)
        .bind(pharmacy)
        .bind(pharmacy)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if unscoped != 0 {
            return Err("Patient credit provenance has an unscoped financial notice".into());
        }
        super::financial_notices_native::verify_native_notice_mirrors(
            &mut **tx, patient_id, pharmacy,
        )
        .await?;
    }
    let debt = patient_outstanding_debt(tx, patient_id).await?;
    if !debt.is_finite() || debt.abs() > 1e12 {
        return Err("Patient credit provenance balance is not bounded".into());
    }
    Ok(debt)
}

async fn settle_negative_sale_item_tx(
    tx: &mut Transaction<'_, Sqlite>,
    payload: &NegativeStockSettlementPayload,
) -> Result<NegativeStockSettlementResult, String> {
    let user = sqlx::query(
        "SELECT pharmacy_id, role, permissions FROM users WHERE CAST(id AS TEXT) = CAST(? AS TEXT) AND COALESCE(is_active, 1) = 1",
    )
    .bind(&payload.user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Unauthorized: active user required".to_string())?;
    let user_role: Option<String> = user.try_get("role").ok();
    let user_permissions: Option<String> = user.try_get("permissions").ok();
    if !user_has_permission(
        user_role.as_deref(),
        user_permissions.as_deref(),
        "can_manage_inventory",
        false,
    ) {
        return Err("Unauthorized: can_manage_inventory permission required".into());
    }
    let user_pharmacy = normalize_pharmacy_id(
        user.try_get::<Option<String>, _>("pharmacy_id")
            .unwrap_or(None)
            .as_deref(),
    );
    if user_pharmacy != normalize_pharmacy_id(Some(&payload.pharmacy_id)) {
        return Err("User belongs to another pharmacy".into());
    }

    let sale_item = sqlx::query(
        r#"
        SELECT si.drug_id,si.invoice_id AS sale_id,
               CAST(si.quantity_sold AS REAL) AS quantity_sold,
               si.unit,
               COALESCE(NULLIF(si.large_to_medium, 0), 1) AS historical_large_to_medium,
               COALESCE(NULLIF(si.medium_to_small, 0), 1) AS historical_medium_to_small,
               md.medium_unit,
               md.small_unit,
               COALESCE(si.is_negative, 0) AS is_negative,
               s.pharmacy_id,
               COALESCE(s.status, '') AS sale_status
        FROM sales_items si
        JOIN sales_invoices s ON s.id = si.invoice_id
        LEFT JOIN master_drugs md ON md.id = si.drug_id
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
    let sale_status = sale_item
        .try_get::<String, _>("sale_status")
        .unwrap_or_default()
        .to_lowercase();
    if !matches!(sale_status.as_str(), "completed" | "approved" | "delivered") {
        return Err("Cannot settle stock for a sale that is not finalized".into());
    }

    let drug_id: i64 = sale_item
        .try_get("drug_id")
        .map_err(|_| "Negative sale item is missing its drug".to_string())?;
    let quantity_sold: f64 = sale_item.try_get("quantity_sold").unwrap_or(0.0);
    if !quantity_sold.is_finite() || quantity_sold <= 0.0 || quantity_sold > 1_000_000_000.0 {
        return Err("Negative sale item has an invalid quantity".into());
    }
    let sold_unit = sale_item
        .try_get::<Option<String>, _>("unit")
        .unwrap_or(None)
        .unwrap_or_else(|| "large".into());
    let historical_large_to_medium = sale_item
        .try_get::<i64, _>("historical_large_to_medium")
        .unwrap_or(1)
        .max(1) as f64;
    let historical_medium_to_small = sale_item
        .try_get::<i64, _>("historical_medium_to_small")
        .unwrap_or(1)
        .max(1) as f64;
    let historical_medium_unit = sale_item
        .try_get::<Option<String>, _>("medium_unit")
        .ok()
        .flatten();
    let historical_small_unit = sale_item
        .try_get::<Option<String>, _>("small_unit")
        .ok()
        .flatten();
    let sale_id: String = sale_item.try_get("sale_id").map_err(|e| e.to_string())?;
    let sale_pharmacy: String = sale_item
        .try_get::<Option<String>, _>("pharmacy_id")
        .unwrap_or(None)
        .ok_or("Negative sale has no verified pharmacy; operator review required")?;
    if sale_pharmacy != payload.pharmacy_id {
        return Err("Sale item belongs to another pharmacy".into());
    }
    let original_receipt = sqlx::query(
        "SELECT line_snapshot,pharmacy_id FROM native_sale_cogs_provenance WHERE sale_id=?",
    )
    .bind(&sale_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(receipt) = original_receipt.as_ref() {
        if receipt
            .try_get::<String, _>("pharmacy_id")
            .map_err(|e| e.to_string())?
            != sale_pharmacy
        {
            return Err("Original sale/COGS receipt has conflicting tenant scope".into());
        }
    }
    let original_receipt: Option<String> = original_receipt
        .map(|row| row.try_get("line_snapshot").map_err(|e| e.to_string()))
        .transpose()?;
    if let Some(snapshot) = original_receipt.as_deref() {
        let original_line_count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM json_each(?) WHERE
              json_valid(value) AND CAST(json_extract(value,'$.lineId') AS INTEGER)=?
              AND json_extract(value,'$.negative')=1
              AND json_type(value,'$.inventoryId')='null'
              AND CAST(json_extract(value,'$.drugId') AS INTEGER)=?
              AND ABS(CAST(json_extract(value,'$.quantity') AS REAL)-?)<0.0000001
              AND CAST(json_extract(value,'$.costPerLarge') AS REAL)=0",
        )
        .bind(snapshot)
        .bind(payload.sale_item_id)
        .bind(drug_id)
        .bind(quantity_sold)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if original_line_count != 1 {
            return Err("Negative-stock settlement does not match original sale evidence".into());
        }
    }
    // An approved return changes the quantity/cost to settle. For a 043
    // protected sale, an unreceipted or foreign return must never reduce COGS.
    if original_receipt.is_some() {
        let missing: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM return_items ri JOIN returns r ON r.id=ri.return_id
             LEFT JOIN native_sale_return_cogs_provenance ev
               ON ev.return_id=r.id AND ev.sale_id=? AND ev.pharmacy_id=?
             WHERE ri.sale_item_id=? AND r.invoice_id=?
               AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
               AND (r.pharmacy_id IS NOT ? OR ev.return_id IS NULL)",
        )
        .bind(&sale_id)
        .bind(&sale_pharmacy)
        .bind(payload.sale_item_id)
        .bind(&sale_id)
        .bind(&sale_pharmacy)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if missing != 0 {
            return Err("Sale return lacks original tenant-bound COGS reversal evidence".into());
        }
    }
    let prior_returns = sqlx::query(
        r#"
        SELECT CAST(COALESCE(ri.quantity_returned, 0) AS REAL) AS quantity_returned,
               ri.unit
        FROM return_items ri
        JOIN returns r ON r.id = ri.return_id
        JOIN sales_items si ON si.id = ri.sale_item_id
        WHERE ri.sale_item_id = ?
          AND r.invoice_id = si.invoice_id AND r.pharmacy_id = ?
          AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
        "#,
    )
    .bind(payload.sale_item_id)
    .bind(&sale_pharmacy)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    let mut approved_returned_quantity = 0.0;
    for prior in prior_returns {
        let prior_quantity: f64 = prior.try_get("quantity_returned").unwrap_or(0.0);
        let prior_unit = prior
            .try_get::<Option<String>, _>("unit")
            .unwrap_or(None)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| sold_unit.clone());
        let prior_large = unit_quantity_in_large(
            prior_quantity,
            &prior_unit,
            historical_large_to_medium,
            historical_medium_to_small,
            historical_medium_unit.as_deref(),
            historical_small_unit.as_deref(),
        );
        approved_returned_quantity += large_quantity_in_unit(
            prior_large,
            &sold_unit,
            historical_large_to_medium,
            historical_medium_to_small,
            historical_medium_unit.as_deref(),
            historical_small_unit.as_deref(),
        );
    }
    if !approved_returned_quantity.is_finite()
        || approved_returned_quantity < 0.0
        || approved_returned_quantity > quantity_sold
    {
        return Err("Negative sale item has an invalid returned quantity".into());
    }
    let net_unreturned_quantity = quantity_sold - approved_returned_quantity;
    let batch = sqlx::query(
        r#"
        SELECT CAST(i.quantity AS REAL) AS quantity,
               CAST(COALESCE(i.cost_price, 0) AS REAL) AS cost_price,
               COALESCE(NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium,
               COALESCE(NULLIF(i.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1) AS medium_to_small,
               md.medium_unit,
               md.small_unit
        FROM inventory i
        LEFT JOIN master_drugs md ON md.id = i.drug_id
        WHERE i.id = ?
          AND i.drug_id = ?
          AND i.pharmacy_id = ?
          AND COALESCE(i.batch_number, '') NOT LIKE 'RET-%'
          AND (COALESCE(md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
          AND (i.expiry_date IS NULL OR i.expiry_date >= DATE('now', 'localtime'))
        "#,
    )
    .bind(&payload.inventory_id)
    .bind(drug_id)
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
        net_unreturned_quantity,
        &sold_unit,
        large_to_medium,
        medium_to_small,
        medium_unit.as_deref(),
        small_unit.as_deref(),
    );
    if !deduction_quantity.is_finite() || deduction_quantity < 0.0 {
        return Err("Negative sale item has invalid unit conversion".into());
    }
    if !batch_quantity.is_finite() || batch_quantity < deduction_quantity {
        return Err("Selected inventory batch has insufficient stock".into());
    }
    if !cost_price.is_finite() || cost_price < 0.0 || cost_price > 1_000_000_000_000.0 {
        return Err("Selected inventory batch has an invalid cost price".into());
    }
    // A 042 initial purchase snapshot stores its *raw* line price, NOT the
    // post-tax/discount/bonus carrying cost in inventory. For the narrow
    // unedited, single-line acquisition class, however, the entire immutable
    // purchase journal (042) and request receipt (044) belongs to this one
    // witnessed lot: posted cents / originally received boxes is its booked
    // unit cost. Validate that evidence before consuming stock or posting
    // COGS, even when the mutable inventory price was changed to zero.
    // Do not guess a value for unrelated zero-cost stock, mixed invoice
    // lines, older manual/import origins, or later 042/046 purchase edits.
    // Those classes need their own complete acquisition witnesses.
    {
        let acquisition_tables: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN
             ('native_purchase_posting_events','native_purchase_create_requests',
              'native_purchase_zero_delta_stock_events')",
        )
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if (1..3).contains(&acquisition_tables) {
            return Err("Settlement purchase provenance schema is incomplete".into());
        }
        if acquisition_tables == 3 {
            let origins = sqlx::query(
                "SELECT e.invoice_id,e.pharmacy_id,e.line_snapshot,e.new_total_cents,
                        c.invoice_id AS created_purchase,
                        CAST(json_extract(line.value,'$.drugId') AS INTEGER) AS source_drug,
                        CAST(json_extract(line.value,'$.quantity') AS REAL) AS paid_quantity,
                        CAST(json_extract(line.value,'$.bonus') AS REAL) AS bonus_quantity,
                        json_extract(line.value,'$.originalLotVerifiable') AS verified_lot,
                        (SELECT COUNT(*) FROM native_purchase_posting_events later
                           WHERE later.invoice_id=e.invoice_id AND later.event_kind<>'initial')
                          AS later_postings,
                        (SELECT COUNT(*) FROM native_purchase_zero_delta_stock_events edit
                           WHERE edit.invoice_id=e.invoice_id) AS zero_delta_edits
                 FROM native_purchase_posting_events e
                 JOIN json_each(e.line_snapshot) line ON json_valid(line.value)
                 LEFT JOIN native_purchase_create_requests c
                   ON c.invoice_id=e.invoice_id AND c.initial_journal_id=e.journal_id
                  AND c.source_status='completed' AND c.pharmacy_id=e.pharmacy_id
                  AND c.actor_id=e.actor_id AND c.source_total_cents=e.new_total_cents
                 WHERE e.event_kind='initial'
                   AND json_extract(line.value,'$.inventoryId')=?
                 LIMIT 3",
            )
            .bind(&payload.inventory_id)
            .fetch_all(&mut **tx)
            .await
            .map_err(|_| "Cannot inspect immutable purchase lot origins")?;
            if origins.len() > 1 {
                return Err("Settlement lot has conflicting immutable purchase origins".into());
            }
            if let Some(origin) = origins.first() {
                let source_pharmacy: String = origin
                    .try_get("pharmacy_id")
                    .map_err(|_| "Invalid purchase origin tenant")?;
                let purchase_id: String = origin
                    .try_get("invoice_id")
                    .map_err(|_| "Invalid purchase origin invoice")?;
                if source_pharmacy != sale_pharmacy
                    || origin.try_get::<i64, _>("source_drug").ok() != Some(drug_id)
                    || origin.try_get::<i64, _>("verified_lot").ok() != Some(1)
                    || origin
                        .try_get::<Option<String>, _>("created_purchase")
                        .ok()
                        .flatten()
                        .as_deref()
                        != Some(purchase_id.as_str())
                {
                    return Err(
                        "Settlement lot lacks tenant-owned immutable purchase origin".into(),
                    );
                }
                let snapshot: String = origin
                    .try_get("line_snapshot")
                    .map_err(|_| "Invalid purchase origin source snapshot")?;
                let altered = origin.try_get::<i64, _>("later_postings").unwrap_or(-1) != 0
                    || origin.try_get::<i64, _>("zero_delta_edits").unwrap_or(-1) != 0;
                // An edited or multi-line purchase can have a legitimate
                // weighted carrying cost not recoverable from this single
                // initial event. Never equate raw price with booked cost.
                if !altered
                    && sqlx::query_scalar::<_, i64>("SELECT json_array_length(?)")
                        .bind(&snapshot)
                        .fetch_one(&mut **tx)
                        .await
                        .map_err(|_| "Invalid original purchase receipt")?
                        == 1
                {
                    let paid: f64 = origin
                        .try_get("paid_quantity")
                        .map_err(|_| "Invalid witnessed purchase quantity")?;
                    let bonus: f64 = origin
                        .try_get("bonus_quantity")
                        .map_err(|_| "Invalid witnessed purchase bonus")?;
                    let cents: i64 = origin
                        .try_get("new_total_cents")
                        .map_err(|_| "Invalid witnessed purchase amount")?;
                    let received = paid + bonus;
                    if !paid.is_finite()
                        || paid <= 0.0
                        || !bonus.is_finite()
                        || bonus < 0.0
                        || !received.is_finite()
                        || received > 1_000_000_000.0
                        || cents <= 0
                        || !((cost_price * received * 100.0) - cents as f64).is_finite()
                        || ((cost_price * received * 100.0) - cents as f64).abs() > 0.500_1
                    {
                        return Err("Settlement lot contradicts immutable purchase cost".into());
                    }
                }
            }
        }
    }
    let cogs_quantity = sale_stock_qty(
        net_unreturned_quantity,
        &sold_unit,
        large_to_medium,
        medium_to_small,
        medium_unit.as_deref(),
        small_unit.as_deref(),
    );
    let cogs_amount = cost_price * cogs_quantity;
    if !cogs_amount.is_finite() || cogs_amount > 1_000_000_000_000.0 {
        return Err("Negative-stock settlement cost is invalid".into());
    }

    let protected = original_receipt.is_some();
    let settlement_journal = if cogs_amount > 0.0 {
        Some(uuid::Uuid::new_v4().to_string())
    } else {
        None
    };
    if protected {
        // The pre-registered immutable event authorizes one precise
        // negative-to-stock transition under the same BEGIN IMMEDIATE.
        // Deferred journal FK ensures a crash/failed post rolls it all back.
        sqlx::query(
            "INSERT INTO native_sale_negative_settlement_provenance
              (sale_item_id,sale_id,actor_id,pharmacy_id,inventory_id,stock_quantity,
               unit_cost,cogs_micros,journal_id)
             VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .bind(payload.sale_item_id)
        .bind(&sale_id)
        .bind(&payload.user_id)
        .bind(&payload.pharmacy_id)
        .bind(&payload.inventory_id)
        .bind(deduction_quantity)
        .bind(cost_price)
        .bind((cogs_amount * 1_000_000.0).round() as i64)
        .bind(settlement_journal.as_deref())
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("Cannot protect negative-sale settlement: {e}"))?;
    }

    // The 043 sale witness seals the conversion at checkout. A later batch
    // may have a different packing ratio: use it for actual stock/COGS, but
    // never rewrite the receipted original conversion.
    let sale_update = if protected {
        sqlx::query(
            "UPDATE sales_items SET inventory_id=?,is_negative=0,cost_price=?
             WHERE id=? AND is_negative=1 AND drug_id=?",
        )
        .bind(&payload.inventory_id)
        .bind(cost_price)
        .bind(payload.sale_item_id)
        .bind(drug_id)
        .execute(&mut **tx)
        .await
    } else {
        sqlx::query(
            "UPDATE sales_items SET inventory_id=?,is_negative=0,cost_price=?,large_to_medium=?,medium_to_small=?
             WHERE id=? AND is_negative=1 AND drug_id=?",
        )
        .bind(&payload.inventory_id)
        .bind(cost_price)
        .bind(large_to_medium)
        .bind(medium_to_small)
        .bind(payload.sale_item_id)
        .bind(drug_id)
        .execute(&mut **tx)
        .await
    }
    .map_err(|e| e.to_string())?;
    if sale_update.rows_affected() != 1 {
        return Err("Sale item was already settled".into());
    }

    if deduction_quantity > 0.0 {
        let stock_update = sqlx::query(
            r#"
            UPDATE inventory
            SET quantity = quantity - ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND drug_id = ?
              AND pharmacy_id = ?
              AND (
                COALESCE(
                  (SELECT md.has_expiry FROM master_drugs md WHERE md.id = inventory.drug_id),
                  1
                ) = 0
                OR expiry_date IS NOT NULL
              )
              AND (expiry_date IS NULL OR expiry_date >= DATE('now', 'localtime'))
              AND quantity >= ?
            "#,
        )
        .bind(deduction_quantity)
        .bind(&payload.inventory_id)
        .bind(drug_id)
        .bind(&sale_pharmacy)
        .bind(deduction_quantity)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if stock_update.rows_affected() != 1 {
            return Err("Selected inventory batch no longer has sufficient stock".into());
        }
    }

    if cogs_amount > 0.0 {
        let journal_id = settlement_journal
            .as_deref()
            .ok_or("COGS settlement journal missing")?;
        sqlx::query(
            "INSERT INTO daily_journals (id, date, description, created_by, total_amount, pharmacy_id) VALUES (?, DATE('now', 'localtime'), ?, ?, ?, ?)",
        )
        .bind(&journal_id)
        .bind(format!(
            "Negative stock settlement item {}",
            payload.sale_item_id
        ))
        .bind(&payload.user_id)
        .bind(cogs_amount)
        .bind(&payload.pharmacy_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        let inventory_account = account_id(tx, "inventory_asset", "1.1.3").await?;
        let cogs_account = account_id(tx, "cogs_expense", "4.1").await?;
        insert_journal_entry(tx, &journal_id, cogs_account, "debit", cogs_amount).await?;
        insert_journal_entry(tx, &journal_id, inventory_account, "credit", cogs_amount).await?;
    }

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

/// Global historical patient IDs have no safe tenant owner. Only the
/// forward-only immutable native witness can authorize a financial mutation.
async fn require_patient_directory_ownership(
    tx: &mut Transaction<'_, Sqlite>,
    patient_id: &str,
    pharmacy_id: &str,
) -> Result<(), String> {
    let owned = sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM native_patient_directory_ownership WHERE patient_id = ? AND pharmacy_id = ? LIMIT 1",
    )
    .bind(patient_id)
    .bind(pharmacy_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| "Patient tenant ownership cannot be verified".to_string())?;
    if owned != Some(1) {
        return Err("Patient tenant ownership cannot be verified".into());
    }
    Ok(())
}

async fn process_checkout_tx(
    tx: &mut Transaction<'_, Sqlite>,
    payload: CheckoutPayload,
    total_amount: f64,
) -> Result<CheckoutResult, String> {
    process_checkout_tx_with_request(tx, payload, total_amount, &uuid::Uuid::new_v4().to_string())
        .await
}

async fn process_checkout_tx_with_request(
    tx: &mut Transaction<'_, Sqlite>,
    payload: CheckoutPayload,
    mut total_amount: f64,
    request_id: &str,
) -> Result<CheckoutResult, String> {
    if !matches!(payload.status.as_str(), "draft" | "completed") {
        return Err("Invalid checkout status".into());
    }
    if !matches!(
        payload.payment_method.as_str(),
        "cash" | "credit" | "check" | "visa" | "delivery" | "wallet"
    ) {
        return Err("Invalid checkout payment method".into());
    }
    if payload.payment_method == "delivery" && payload.patient_id.is_none() {
        return Err("Delivery checkout requires a patient".into());
    }
    let normalized_check_number = payload
        .check_number
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if payload.status == "completed"
        && payload.payment_method == "check"
        && normalized_check_number.is_none()
    {
        return Err("Check number is required for completed check checkout".into());
    }
    if !total_amount.is_finite()
        || total_amount < 0.0
        || !payload.additional_fees.is_finite()
        || payload.additional_fees < 0.0
        || !payload.total_discount.is_finite()
        || payload.total_discount < 0.0
        || payload.items.iter().any(|item| {
            !item.quantity_sold.is_finite()
                || item.quantity_sold <= 0.0
                || !item.unit_price.is_finite()
                || item.unit_price < 0.0
        })
    {
        return Err("Invalid checkout amounts".into());
    }
    if payload.points_to_redeem < 0
        || (payload.points_to_redeem > 0 && payload.points_to_redeem < 100)
    {
        return Err("Loyalty points to redeem must be 0 or at least 100".into());
    }
    if payload.points_to_redeem > 0 && payload.status != "completed" {
        return Err("Loyalty points can only be redeemed on completed checkout".into());
    }
    if payload.points_to_redeem > 0 && payload.patient_id.is_none() {
        return Err("Loyalty redemption requires a patient".into());
    }
    let merchandise_gross: f64 = payload
        .items
        .iter()
        .map(|item| item.quantity_sold * item.unit_price)
        .sum();
    let loyalty_discount_amount = loyalty_redemption_value(payload.points_to_redeem);
    let eligible_merchandise_after_manual_discount =
        (merchandise_gross - payload.total_discount).max(0.0);
    if loyalty_discount_amount > eligible_merchandise_after_manual_discount + 0.000_001 {
        return Err("Loyalty discount exceeds merchandise value after manual discount".into());
    }
    let combined_discount = payload.total_discount + loyalty_discount_amount;
    total_amount = checkout_total(&payload.items, combined_discount, payload.additional_fees);
    if !total_amount.is_finite() || total_amount < -0.000_001 {
        return Err("Invalid checkout amounts".into());
    }
    total_amount = total_amount.max(0.0);
    // Delivery cash collection (045) settles the immutable 043 receivable in
    // integer cents. Never create a completed delivery with a fractional-cent
    // receivable that cannot later be collected without rewriting history.
    // Other payment methods retain their established pricing policy.
    if payload.status == "completed" && payload.payment_method == "delivery" {
        let cents = total_amount * 100.0;
        if total_amount > 1_000_000_000.0 || (cents - cents.round()).abs() > 0.000_000_1 {
            return Err(
                "Delivery checkout amount must be collectable in exact cents and within the native collection limit".into(),
            );
        }
    }

    let user = sqlx::query(
        "SELECT pharmacy_id, role, permissions FROM users WHERE CAST(id AS TEXT) = CAST(? AS TEXT) AND COALESCE(is_active, 1) = 1",
    )
    .bind(&payload.user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Unauthorized: active user required".to_string())?;
    let user_role: Option<String> = user.try_get("role").ok();
    let user_permissions: Option<String> = user.try_get("permissions").ok();
    let user_pharmacy = normalize_pharmacy_id(
        user.try_get::<Option<String>, _>("pharmacy_id")
            .unwrap_or(None)
            .as_deref(),
    );
    if user_pharmacy != normalize_pharmacy_id(Some(&payload.pharmacy_id)) {
        return Err("User belongs to another pharmacy".into());
    }
    if let Some(patient_id) = payload.patient_id.as_deref() {
        // A historical global patient ID is not proof of ownership. This
        // check runs inside the same native checkout writer transaction and
        // fails closed for pre-migration/legacy rows without a new witness.
        require_patient_directory_ownership(tx, patient_id, &user_pharmacy).await?;
    }
    if !user_has_permission(
        user_role.as_deref(),
        user_permissions.as_deref(),
        "can_access_pos",
        true,
    ) {
        return Err("Unauthorized: can_access_pos permission required".into());
    }
    if payload.status == "draft"
        && !user_has_permission(
            user_role.as_deref(),
            user_permissions.as_deref(),
            "suspended_can_save_invoice",
            false,
        )
    {
        return Err("Unauthorized: suspended_can_save_invoice permission required".into());
    }
    if payload.source_draft_id.is_some()
        && !user_has_permission(
            user_role.as_deref(),
            user_permissions.as_deref(),
            "show_suspended_invoices",
            false,
        )
    {
        return Err("Unauthorized: show_suspended_invoices permission required".into());
    }
    if payload.payment_method == "credit"
        && !user_has_permission(
            user_role.as_deref(),
            user_permissions.as_deref(),
            "can_sell_credit",
            false,
        )
    {
        return Err("Unauthorized: can_sell_credit permission required".into());
    }
    let can_sell_no_stock = user_has_permission(
        user_role.as_deref(),
        user_permissions.as_deref(),
        "can_sell_no_stock",
        false,
    );
    if payload.status != "completed"
        && payload.items.iter().any(|item| item.is_negative)
        && !can_sell_no_stock
    {
        return Err("Unauthorized: can_sell_no_stock permission required".into());
    }
    if payload
        .items
        .iter()
        .any(|item| item.item_discount_percent > 0.0)
        && !user_has_permission(
            user_role.as_deref(),
            user_permissions.as_deref(),
            "can_discount_sale_item",
            false,
        )
    {
        return Err("Unauthorized: can_discount_sale_item permission required".into());
    }
    if payload.total_discount > 0.0 {
        if !user_has_permission(
            user_role.as_deref(),
            user_permissions.as_deref(),
            "can_give_total_discount",
            false,
        ) {
            return Err("Unauthorized: can_give_total_discount permission required".into());
        }
        let gross = merchandise_gross;
        let maximum = user_permission_number(
            user_role.as_deref(),
            user_permissions.as_deref(),
            "max_invoice_discount_percent",
            0.0,
        );
        if gross > 0.0 && payload.total_discount / gross * 100.0 > maximum + 0.000001 {
            return Err("Invoice discount exceeds the permitted maximum".into());
        }
    }
    if !user_has_permission(
        user_role.as_deref(),
        user_permissions.as_deref(),
        "can_change_price_sale",
        false,
    ) {
        for item in &payload.items {
            let price = sqlx::query(
                r#"
                SELECT CAST(COALESCE(MIN(i.local_selling_price), md.official_price, 0) AS REAL) AS large_price,
                       CAST(COALESCE(NULLIF(MAX(i.strips_per_box), 0), NULLIF(md.large_to_medium, 0), 1) AS REAL) AS large_to_medium,
                       CAST(COALESCE(NULLIF(MAX(i.medium_to_small), 0), NULLIF(md.medium_to_small, 0), 1) AS REAL) AS medium_to_small,
                       md.medium_unit, md.small_unit
                FROM master_drugs md
                LEFT JOIN inventory i ON CAST(i.drug_id AS TEXT) = CAST(md.id AS TEXT)
                  AND (? IS NULL OR i.id = ?)
                  AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
                  AND i.quantity > 0
                  AND (COALESCE(md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
                  AND (i.expiry_date IS NULL OR i.expiry_date >= DATE('now', 'localtime'))
                WHERE CAST(md.id AS TEXT) = CAST(? AS TEXT)
                GROUP BY md.id
                "#,
            )
            .bind(item.inventory_id.as_deref())
            .bind(item.inventory_id.as_deref())
            .bind(&payload.pharmacy_id)
            .bind(&payload.pharmacy_id)
            .bind(item.drug_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Checkout drug does not exist".to_string())?;
            let large_price: f64 = price.try_get("large_price").map_err(|e| e.to_string())?;
            let large_to_medium: f64 = price
                .try_get("large_to_medium")
                .map_err(|e| e.to_string())?;
            let medium_to_small: f64 = price
                .try_get("medium_to_small")
                .map_err(|e| e.to_string())?;
            let medium_unit: Option<String> = price.try_get("medium_unit").ok();
            let small_unit: Option<String> = price.try_get("small_unit").ok();
            let mut expected = unit_quantity_in_large(
                large_price,
                &item.selected_unit,
                large_to_medium,
                medium_to_small,
                medium_unit.as_deref(),
                small_unit.as_deref(),
            );
            expected *= 1.0 - item.item_discount_percent / 100.0;
            if (expected - item.unit_price).abs() > 0.011 {
                return Err("Unauthorized: can_change_price_sale permission required".into());
            }
        }
    }
    if let Some(source_draft_id) = payload.source_draft_id.as_deref() {
        let source_draft =
            sqlx::query("SELECT pharmacy_id, status FROM sales_invoices WHERE id = ?")
                .bind(source_draft_id)
                .fetch_optional(&mut **tx)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "Source draft does not exist".to_string())?;
        let source_pharmacy = normalize_pharmacy_id(
            source_draft
                .try_get::<Option<String>, _>("pharmacy_id")
                .unwrap_or(None)
                .as_deref(),
        );
        if source_pharmacy != normalize_pharmacy_id(Some(&payload.pharmacy_id)) {
            return Err("Source draft belongs to another pharmacy".into());
        }
        let source_status: String = source_draft.try_get("status").unwrap_or_default();
        if source_status != "draft" {
            return Err("Source invoice is no longer a draft".into());
        }
        sqlx::query("DELETE FROM sales_items WHERE invoice_id = ?")
            .bind(source_draft_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        let deleted = sqlx::query("DELETE FROM sales_invoices WHERE id = ? AND status = 'draft'")
            .bind(source_draft_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        if deleted.rows_affected() != 1 {
            return Err("Source draft changed while checkout was being processed".into());
        }
    }
    let sale_id = uuid::Uuid::new_v4().to_string();
    let mut points_earned = 0_i64;

    let mut patient_loyalty_level: Option<String> = None;
    if let Some(patient_id) = &payload.patient_id {
        let patient = sqlx::query(
            "SELECT CAST(COALESCE(credit_limit, 0) AS REAL) AS credit_limit, CAST(COALESCE(wallet_balance, 0) AS REAL) AS wallet_balance, CAST(COALESCE(points_balance, 0) AS INTEGER) AS points_balance, loyalty_level FROM patients WHERE id = ?",
        )
        .bind(patient_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Checkout patient does not exist".to_string())?;
        if payload.status == "completed" {
            let credit_limit: f64 = patient.try_get("credit_limit").unwrap_or(0.0);
            let wallet_balance: f64 = patient.try_get("wallet_balance").unwrap_or(0.0);
            patient_loyalty_level = patient.try_get("loyalty_level").ok();

            if payload.payment_method == "credit" {
                if !credit_limit.is_finite() || credit_limit < 0.0 || credit_limit > 1e12 {
                    return Err("Patient credit limit is invalid".into());
                }
                let current_debt = verified_checkout_credit_debt(
                    tx, patient_id, &user_pharmacy,
                ).await?;
                if current_debt + total_amount > credit_limit {
                    return Err("Credit limit exceeded".into());
                }
            }

            if payload.payment_method == "wallet" {
                if !wallet_balance.is_finite() || wallet_balance < total_amount {
                    return Err("Insufficient wallet balance".into());
                }
                // A global patient-wallet field is not a source of spendable
                // money on its own. Reuse the native 043/060 reconciliation
                // under this checkout's existing writer transaction.
                let (_, certified) =
                    super::patient_payments_native::certified_wallet_balance(
                        &mut **tx, patient_id, &user_pharmacy,
                    )
                    .await
                    .map_err(|e| format!("unverified wallet source: {e}"))?;
                if total_amount > certified {
                    return Err("Insufficient wallet balance".into());
                }
            }
            if payload.points_to_redeem > 0 {
                let claimed = sqlx::query(
                        "UPDATE patients SET points_balance = COALESCE(points_balance, 0) - ? WHERE id = ? AND COALESCE(points_balance, 0) >= ?",
                    )
                    .bind(payload.points_to_redeem)
                    .bind(patient_id)
                    .bind(payload.points_to_redeem)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| e.to_string())?;
                if claimed.rows_affected() != 1 {
                    let available = sqlx::query_scalar::<_, i64>(
                            "SELECT CAST(COALESCE(points_balance, 0) AS INTEGER) FROM patients WHERE id = ?",
                        )
                        .bind(patient_id)
                        .fetch_optional(&mut **tx)
                        .await
                        .map_err(|e| e.to_string())?
                        .unwrap_or(0);
                    return Err(format!(
                        "Insufficient loyalty points ({} available)",
                        available.max(0)
                    ));
                }
                sqlx::query(
                        "INSERT INTO activity_log (user_id, action, details) VALUES (?, 'REDEEM_POINTS', ?)",
                    )
                    .bind(&payload.user_id)
                    .bind(format!(
                        "Redeemed {} points = {:.2} EGP on sale {}",
                        payload.points_to_redeem, loyalty_discount_amount, sale_id
                    ))
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    let shift_id_to_use = resolve_open_shift(
        tx,
        &payload.user_id,
        payload.shift_id.as_deref().filter(|s| !s.trim().is_empty()),
    )
    .await?;

    sqlx::query(
        r#"
        INSERT INTO sales_invoices
          (id, pharmacy_id, user_id, patient_id, shift_id, total_amount, payment_method, check_number, status, discount_amount, paid_amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        "#,
    )
    .bind(&sale_id)
    .bind(&payload.pharmacy_id)
    .bind(&payload.user_id)
    .bind(&payload.patient_id)
    .bind(&shift_id_to_use)
    .bind(total_amount)
    .bind(&payload.payment_method)
    .bind(&normalized_check_number)
    .bind(&payload.status)
    .bind(combined_discount)
    .bind(if payload.status == "completed" && payload.payment_method == "cash" {
        total_amount
    } else {
        0.0
    })
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if payload.points_to_redeem > 0 {
        let snapshot = sqlx::query(
            "UPDATE sales_invoices SET points_redeemed = ?, loyalty_discount_amount = ? WHERE id = ?",
        )
        .bind(payload.points_to_redeem)
        .bind(loyalty_discount_amount)
        .bind(&sale_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if snapshot.rows_affected() != 1 {
            return Err("Failed to store loyalty redemption snapshot".into());
        }
    }

    let mut total_cogs = 0.0_f64;
    for item in &payload.items {
        let drug = sqlx::query(
            r#"
            SELECT md.trade_name, md.trade_name_en, md.active_ingredient, md.large_to_medium, md.medium_to_small, md.medium_unit, md.small_unit, md.stop_dealing, COALESCE(md.has_expiry, 1) AS has_expiry
            FROM master_drugs md
            WHERE CAST(md.id AS TEXT) = CAST(? AS TEXT)
            "#,
        )
        .bind(item.drug_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

        if drug
            .as_ref()
            .and_then(|row| row.try_get::<i64, _>("stop_dealing").ok())
            .unwrap_or(0)
            == 1
        {
            return Err(
                "هذا الصنف مؤرشف أو متوقف؛ أزله من الفاتورة أو أعد تفعيله من إدارة الأصناف".into(),
            );
        }
        let is_placeholder = |s: &str| {
            let t = s.trim();
            t.is_empty()
                || (t.to_lowercase().starts_with("drug ") || t.to_lowercase().starts_with("drug #"))
        };

        let drug_name = drug
            .as_ref()
            .and_then(|r| {
                let trade_name = r
                    .try_get::<String, _>("trade_name")
                    .ok()
                    .unwrap_or_default();
                let trade_en = r
                    .try_get::<String, _>("trade_name_en")
                    .ok()
                    .unwrap_or_default();
                let active = r
                    .try_get::<String, _>("active_ingredient")
                    .ok()
                    .unwrap_or_default();
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
        let medium_unit = drug
            .as_ref()
            .and_then(|r| r.try_get::<String, _>("medium_unit").ok());
        let small_unit = drug
            .as_ref()
            .and_then(|r| r.try_get::<String, _>("small_unit").ok());
        let requires_expiry = drug
            .as_ref()
            .and_then(|r| r.try_get::<i64, _>("has_expiry").ok())
            .unwrap_or(1)
            != 0;

        if payload.status != "completed" {
            insert_sale_item(
                tx,
                &sale_id,
                None,
                item,
                item.quantity_sold,
                item.is_negative,
                0.0,
                large_to_medium,
                medium_to_small,
            )
            .await?;
            continue;
        }

        let selected_inventory_id = item.inventory_id.as_deref();
        if let Some(inventory_id) = selected_inventory_id.filter(|_| item.is_negative) {
            // Negative-stock permission only authorizes an unlinked shortage
            // for the *selected drug*. It must not turn a missing, expired or
            // foreign lot ID into an apparently valid source choice.
            let selected_quantity: Option<f64> = sqlx::query_scalar(
                "SELECT CAST(quantity AS REAL) FROM inventory
                 WHERE id = ? AND drug_id = ?
                   AND (pharmacy_id IS ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
                   AND (? = 0 OR expiry_date IS NOT NULL)
                   AND (expiry_date IS NULL OR expiry_date >= DATE('now', 'localtime'))",
            )
            .bind(inventory_id)
            .bind(item.drug_id)
            .bind(&payload.pharmacy_id)
            .bind(&payload.pharmacy_id)
            .bind(if requires_expiry { 1_i64 } else { 0_i64 })
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
            match selected_quantity {
                Some(quantity) if quantity.is_finite() && quantity >= 0.0 => {}
                _ => return Err("Selected inventory batch is missing, invalid or belongs to another drug/pharmacy".into()),
            }
        }
        let batches = if let Some(inventory_id) = selected_inventory_id {
            sqlx::query(
                r#"
                SELECT id, CAST(quantity AS REAL) AS quantity, cost_price, strips_per_box, medium_to_small
                FROM inventory
                WHERE id = ? AND drug_id = ?
                  AND (pharmacy_id IS ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
                  AND quantity > 0
                  AND (? = 0 OR expiry_date IS NOT NULL)
                  AND (expiry_date IS NULL OR expiry_date >= DATE('now', 'localtime'))
                "#,
            )
            .bind(inventory_id)
            .bind(item.drug_id)
            .bind(&payload.pharmacy_id)
            .bind(&payload.pharmacy_id)
            .bind(if requires_expiry { 1_i64 } else { 0_i64 })
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
        } else {
            sqlx::query(
                r#"
                SELECT id, CAST(quantity AS REAL) AS quantity, cost_price, strips_per_box, medium_to_small
                FROM inventory
                WHERE drug_id = ? AND (pharmacy_id IS ? OR (pharmacy_id IS NULL AND ? = 'local_default')) AND quantity > 0 AND (? = 0 OR expiry_date IS NOT NULL) AND (expiry_date IS NULL OR expiry_date >= DATE('now', 'localtime'))
                ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, created_at ASC
                "#,
            )
            .bind(item.drug_id)
            .bind(&payload.pharmacy_id)
            .bind(&payload.pharmacy_id)
            .bind(if requires_expiry { 1_i64 } else { 0_i64 })
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
        };

        if selected_inventory_id.is_some() && batches.is_empty() && !item.is_negative {
            return Err(
                "Selected inventory batch has insufficient stock, is for the wrong drug/pharmacy or is expired"
                    .to_string(),
            );
        }

        let selected_unit_capacity = batches.iter().fold(0.0_f64, |total, batch| {
            let batch_qty = batch.try_get::<f64, _>("quantity").unwrap_or(0.0);
            let batch_large_to_medium = batch
                .try_get::<i64, _>("strips_per_box")
                .ok()
                .filter(|value| *value > 0)
                .map(|value| value as f64)
                .unwrap_or(large_to_medium);
            let batch_medium_to_small = batch
                .try_get::<i64, _>("medium_to_small")
                .ok()
                .filter(|value| *value > 0)
                .map(|value| value as f64)
                .unwrap_or(medium_to_small);
            let stock_per_selected_unit = sale_stock_qty(
                1.0,
                &item.selected_unit,
                batch_large_to_medium,
                batch_medium_to_small,
                medium_unit.as_deref(),
                small_unit.as_deref(),
            );
            total + batch_qty / stock_per_selected_unit
        });
        if !item.is_negative && selected_unit_capacity < item.quantity_sold {
            return Err(format!(
                "Insufficient stock for \"{}\" (available: {:.2} {})",
                drug_name, selected_unit_capacity, item.selected_unit
            ));
        }

        let mut remaining_selected_units = item.quantity_sold;
        for batch in batches {
            if remaining_selected_units <= 0.0 {
                break;
            }
            let batch_id: String = batch.try_get("id").map_err(|e| e.to_string())?;
            let batch_qty: f64 = batch.try_get("quantity").unwrap_or(0.0);
            let cost_price: f64 = batch.try_get("cost_price").unwrap_or(0.0);
            let batch_large_to_medium = batch
                .try_get::<i64, _>("strips_per_box")
                .ok()
                .filter(|value| *value > 0)
                .map(|value| value as f64)
                .unwrap_or(large_to_medium);
            let batch_medium_to_small = batch
                .try_get::<i64, _>("medium_to_small")
                .ok()
                .filter(|value| *value > 0)
                .map(|value| value as f64)
                .unwrap_or(medium_to_small);
            let stock_per_selected_unit = sale_stock_qty(
                1.0,
                &item.selected_unit,
                batch_large_to_medium,
                batch_medium_to_small,
                medium_unit.as_deref(),
                small_unit.as_deref(),
            );
            let batch_capacity = batch_qty / stock_per_selected_unit;
            let quantity_in_selected_unit = remaining_selected_units.min(batch_capacity);
            let deduct = quantity_in_selected_unit * stock_per_selected_unit;

            let stock_update = sqlx::query("UPDATE inventory SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND quantity >= ?")
                .bind(deduct)
                .bind(&batch_id)
                .bind(deduct)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
            if stock_update.rows_affected() != 1 {
                return Err(format!(
                    "Inventory changed while processing \"{}\"; please retry",
                    drug_name
                ));
            }
            insert_sale_item(
                tx,
                &sale_id,
                Some(&batch_id),
                item,
                quantity_in_selected_unit,
                false,
                cost_price,
                batch_large_to_medium,
                batch_medium_to_small,
            )
            .await?;

            total_cogs += cost_price * deduct;
            remaining_selected_units -= quantity_in_selected_unit;
        }

        if remaining_selected_units > 0.0 {
            if item.is_negative {
                if !can_sell_no_stock {
                    return Err("Unauthorized: can_sell_no_stock permission required".into());
                }
                insert_sale_item(
                    tx,
                    &sale_id,
                    None,
                    item,
                    remaining_selected_units,
                    true,
                    0.0,
                    large_to_medium,
                    medium_to_small,
                )
                .await?;
            } else {
                return Err(format!(
                    "Inventory changed while processing \"{}\"; please retry",
                    drug_name
                ));
            }
        }

        sqlx::query(
            r#"
            INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, status)
            SELECT
                md.id,
                ?,
                MAX(1, COALESCE(NULLIF(md.default_purchase_qty, 0), NULLIF(md.reorder_point, 0), NULLIF(md.min_limit, 0), 1)),
                'pending'
            FROM master_drugs md
            WHERE md.id = ?
              AND COALESCE((
                  SELECT SUM(i.quantity)
                  FROM inventory i
                  WHERE i.drug_id = md.id
                    AND (i.pharmacy_id IS ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
                    AND (COALESCE(md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
                    AND (i.expiry_date IS NULL OR i.expiry_date >= DATE('now', 'localtime'))
              ), 0) <= 0.0001
              AND NOT EXISTS (
                  SELECT 1
                  FROM shortages s
                  WHERE s.drug_id = md.id AND s.pharmacy_id = ? AND s.status IN ('pending', 'ordered')
              )
            "#,
        )
        .bind(&payload.pharmacy_id)
        .bind(item.drug_id)
        .bind(&payload.pharmacy_id)
        .bind(&payload.pharmacy_id)
        .bind(&payload.pharmacy_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    if payload.status == "completed" {
        let journal_id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO daily_journals (id, date, description, created_by, total_amount, pharmacy_id) VALUES (?, DATE('now', 'localtime'), ?, ?, ?, ?)",
        )
        .bind(&journal_id)
        .bind(format!("Sales invoice {}", &sale_id[..8]))
        .bind(&payload.user_id)
        .bind(total_amount + total_cogs)
        .bind(&payload.pharmacy_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

        let cash = account_id(tx, "cash_drawer", "1.1.1").await?;
        let receivable = account_id(tx, "accounts_receivable", "1.1.2").await?;
        let sales = account_id(tx, "sales_revenue", "3.1").await?;
        let inventory = account_id(tx, "inventory_asset", "1.1.3").await?;
        let cogs = account_id(tx, "cogs_expense", "4.1").await?;
        let debit = match payload.payment_method.as_str() {
            "credit" | "delivery" => receivable,
            "wallet" => account_id(tx, "patient_wallet_liability", "2.2").await?,
            "visa" | "check" => account_id(tx, "bank_clearing", "1.1.4").await?,
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
        super::sales_cogs_provenance::record_sale(
            tx,
            request_id,
            &sale_id,
            &payload.user_id,
            &payload.pharmacy_id,
            &payload.payment_method,
            &journal_id,
            total_amount,
            total_cogs,
        )
        .await?;
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
            sqlx::query("UPDATE sales_invoices SET points_earned = ? WHERE id = ?")
                .bind(points_earned)
                .bind(&sale_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }

        sqlx::query(
            "INSERT INTO activity_log (user_id, action, details) VALUES (?, 'COMPLETE_SALE', ?)",
        )
        .bind(&payload.user_id)
        .bind(format!("Sale {} value {}", sale_id, total_amount))
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    let stored_created_at: String =
        sqlx::query_scalar("SELECT created_at FROM sales_invoices WHERE id = ?")
            .bind(&sale_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    let created_at = if stored_created_at.ends_with('Z') || stored_created_at.contains('+') {
        stored_created_at
    } else {
        format!("{}Z", stored_created_at.replace(' ', "T"))
    };

    Ok(CheckoutResult {
        sale_id,
        total_amount,
        points_earned,
        points_redeemed: payload.points_to_redeem,
        loyalty_discount_amount,
        created_at,
    })
}

fn purchase_batch_number(invoice_number: Option<&str>, invoice_id: &str) -> String {
    invoice_number
        .filter(|number| !number.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("BATCH-{}", &invoice_id[..invoice_id.len().min(8)]))
}

// ponytail: These parameters mirror one purchase-item row and keep call sites explicit.
#[allow(clippy::too_many_arguments)]
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
    let medium_to_small = drug_medium_to_small(tx, drug_id).await?;
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
            "UPDATE inventory SET quantity = ?, pharmacy_id = COALESCE(pharmacy_id, ?), local_selling_price = ?, cost_price = ?, expiry_date = ?, batch_number = ?, strips_per_box = ?, medium_to_small = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(merged_quantity)
        .bind(pharmacy_id)
        .bind(selling_price)
        .bind(merged_cost)
        .bind(expiry_date)
        .bind(batch_number)
        .bind(strips_per_box)
        .bind(medium_to_small)
        .bind(&id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        consolidate_inventory_rows(tx, drug_id, pharmacy_id, expiry_date, batch_number, &id)
            .await?;
    } else {
        sqlx::query(
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price, expiry_date, batch_number, strips_per_box, medium_to_small, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
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
        .bind(medium_to_small)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn resolve_shortage_if_stock_recovered(
    tx: &mut Transaction<'_, Sqlite>,
    drug_id: i64,
    pharmacy_id: Option<&str>,
) -> Result<(), String> {
    let pharmacy_scope = normalize_pharmacy_id(pharmacy_id);
    sqlx::query(
        r#"
        UPDATE shortages
        SET status = 'received'
        WHERE drug_id = ?
          AND COALESCE(NULLIF(TRIM(pharmacy_id), ''), 'local_default') = ?
          AND (status IN ('pending', 'ordered') OR status IS NULL OR status = '')
          AND COALESCE((
            SELECT SUM(i.quantity)
            FROM inventory i
            JOIN master_drugs stock_md ON stock_md.id = i.drug_id
            WHERE i.drug_id = shortages.drug_id
              AND COALESCE(NULLIF(TRIM(i.pharmacy_id), ''), 'local_default') = ?
              AND i.quantity > 0
              AND (COALESCE(stock_md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
              AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
          ), 0) > COALESCE((
            SELECT MAX(
              COALESCE(NULLIF(md.reorder_point, 0), NULLIF(md.min_limit, 0), 10),
              COALESCE((
                SELECT SUM(
                  CASE
                    WHEN LOWER(TRIM(COALESCE(si.unit, ''))) IN ('medium', 'strip', 'شريط') OR si.unit = sales_drug.medium_unit
                      THEN si.quantity_sold / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(sales_drug.large_to_medium, 0), 1)
                    WHEN LOWER(TRIM(COALESCE(si.unit, ''))) IN ('small', 'unit', 'pill', 'tablet', 'capsule', 'قرص', 'كبسولة') OR si.unit = sales_drug.small_unit
                      THEN si.quantity_sold / (
                        COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(sales_drug.large_to_medium, 0), 1)
                        * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(sales_drug.medium_to_small, 0), 1)
                      )
                    ELSE si.quantity_sold
                  END
                )
                FROM sales_items si
                JOIN sales_invoices inv ON inv.id = si.invoice_id
                JOIN master_drugs sales_drug ON sales_drug.id = si.drug_id
                WHERE si.drug_id = md.id
                  AND si.is_negative = 0
                  AND (inv.status IS NULL OR inv.status = '' OR inv.status IN ('completed', 'approved', 'delivered'))
                  AND COALESCE(NULLIF(TRIM(inv.pharmacy_id), ''), 'local_default') = ?
                  AND inv.created_at >= datetime('now', '-30 days')
              ), 0)
            )
            FROM master_drugs md
            WHERE md.id = shortages.drug_id
          ), 0)
        "#,
    )
    .bind(drug_id)
    .bind(&pharmacy_scope)
    .bind(&pharmacy_scope)
    .bind(&pharmacy_scope)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn drug_medium_to_small(
    tx: &mut Transaction<'_, Sqlite>,
    drug_id: i64,
) -> Result<i64, String> {
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT CAST(COALESCE(NULLIF(medium_to_small, 0), 1) AS INTEGER) FROM master_drugs WHERE id = ?",
    )
    .bind(drug_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or(1)
    .max(1))
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

pub(crate) async fn ensure_exclusive_purchase_inventory(
    connection: &mut sqlx::SqliteConnection,
    inventory_id: &str,
    invoice_id: &str,
) -> Result<(), String> {
    // Historic purchase-item inventory IDs are not an authorization boundary.
    // Validate the *actual* linked stock's pharmacy against the persisted
    // invoice before any editor, deletion or return can change its quantity.
    // A broken cross-pharmacy link must be reconciled, never silently followed.
    let belongs_to_invoice_pharmacy: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM inventory i JOIN purchase_invoices p ON p.id = ? \
         WHERE i.id = ? \
         AND COALESCE(NULLIF(TRIM(i.pharmacy_id), ''), 'local_default') = \
             COALESCE(NULLIF(TRIM(p.pharmacy_id), ''), 'local_default') LIMIT 1",
    )
    .bind(invoice_id)
    .bind(inventory_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    if belongs_to_invoice_pharmacy.is_none() {
        return Err("Purchase inventory link is missing or belongs to another pharmacy".into());
    }
    // Do not guess how historic merged stock belongs to individual invoices.
    let shared = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM purchase_invoice_items pii JOIN purchase_invoices pi ON pi.id = pii.invoice_id JOIN inventory i ON i.id = ? WHERE pi.id <> ? AND pi.status = 'completed' AND (pii.inventory_id = i.id OR (pii.inventory_id IS NULL AND pii.drug_id = i.drug_id AND date(pii.expiry_date) IS date(i.expiry_date) AND COALESCE(pi.pharmacy_id, 'local_default') = COALESCE(i.pharmacy_id, 'local_default') AND i.batch_number = COALESCE(NULLIF(TRIM(pi.invoice_number), ''), 'BATCH-' || SUBSTR(pi.id, 1, 8))))",
    )
    .bind(inventory_id)
    .bind(invoice_id)
    .fetch_one(connection)
    .await
    .map_err(|e| e.to_string())?;
    if shared > 0 {
        return Err("This historical inventory batch is shared by multiple purchases; reconcile its quantities and costs before editing, deleting, or returning it".into());
    }
    Ok(())
}

// ponytail: preserve posted history; corrections change only the linked stock and post a delta.
// Cost revaluation of sold units requires a separate accounting workflow, not an invoice edit.
async fn edit_consumed_purchase(
    tx: &mut Transaction<'_, Sqlite>,
    invoice_id: &str,
    old: &sqlx::sqlite::SqliteRow,
    payload: &PurchasePayload,
    items_total: f64,
    paid_factor: f64,
) -> Result<Option<PurchaseResult>, String> {
    let rows = sqlx::query("SELECT p.*, CAST(i.quantity AS REAL) AS available, CAST(i.cost_price AS REAL) AS stock_cost, i.drug_id AS stock_drug, i.pharmacy_id AS stock_pharmacy, i.expiry_date AS stock_expiry, i.strips_per_box AS stock_strips, i.medium_to_small AS stock_small, i.barcode AS stock_barcode, (SELECT COUNT(*) FROM sales_items si WHERE si.inventory_id = p.inventory_id) AS sale_refs FROM purchase_invoice_items p LEFT JOIN inventory i ON i.id = p.inventory_id WHERE p.invoice_id = ? ORDER BY p.id")
        .bind(invoice_id).fetch_all(&mut **tx).await.map_err(|e| e.to_string())?;
    let number = |row: &sqlx::sqlite::SqliteRow, field: &str| -> f64 {
        row.try_get::<f64, _>(field)
            .unwrap_or_else(|_| row.try_get::<i64, _>(field).unwrap_or(0) as f64)
    };
    let marker = format!("Purchase edit [id={invoice_id}]");
    let adjusted =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM daily_journals WHERE description = ?")
            .bind(&marker)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            > 0;
    let consumed = rows.iter().any(|row| {
        number(row, "sale_refs") > 0.0
            || row
                .try_get::<Option<f64>, _>("available")
                .ok()
                .flatten()
                .is_some_and(|available| {
                    available + 0.000_001 < number(row, "quantity") + number(row, "bonus_quantity")
                })
    });
    if !consumed && !adjusted {
        return Ok(None);
    }
    let blocked = "بعد البيع: لا يمكن تغيير المورد أو الدفع أو التاريخ أو الأصناف أو الصلاحية أو تحويل الوحدات أو صافي تكلفة الوحدة. يمكن تعديل الكمية المتبقية وسعر البيع المستقبلي والملاحظات ورقم الفاتورة";
    let old_pharmacy: Option<String> = old.try_get("pharmacy_id").unwrap_or(None);
    let payment: String = old.try_get("payment_method").map_err(|e| e.to_string())?;
    let old_date: Option<String> = old.try_get("invoice_date").unwrap_or(None);
    let old_check: Option<String> = old.try_get("check_number").unwrap_or(None);
    if payload.status.as_deref() != Some("completed")
        || number(old, "supplier_id") != payload.supplier_id as f64
        || payment != payload.payment_method.as_deref().unwrap_or("credit")
        || normalize_pharmacy_id(old_pharmacy.as_deref())
            != normalize_pharmacy_id(payload.pharmacy_id.as_deref())
        || normalize_date_ymd(old_date.as_deref())
            != normalize_date_ymd(payload.invoice_date.as_deref())
        || old_check.as_deref().unwrap_or("").trim()
            != payload.check_number.as_deref().unwrap_or("").trim()
        || (number(old, "expenses") - payload.expenses).abs() > 0.000_001
        || (number(old, "discount_value") - payload.discount_value).abs() > 0.000_001
        || (number(old, "discount_percent") - payload.discount_percent).abs() > 0.000_001
        || (number(old, "tax_percent") - payload.tax_percent).abs() > 0.000_001
        || rows.len() != payload.cart.len()
    {
        return Err(blocked.into());
    }

    let old_items_total: f64 = rows
        .iter()
        .map(|row| {
            number(row, "quantity")
                * number(row, "cost_price")
                * (1.0 + number(row, "tax_percent") / 100.0)
                * (1.0 + number(old, "tax_percent") / 100.0)
        })
        .sum();
    let old_factor = purchase_inventory_paid_factor(
        old_items_total,
        number(old, "expenses"),
        number(old, "discount_value"),
        number(old, "discount_percent"),
    );
    let new_total = items_total * paid_factor;
    let old_total = number(old, "total_amount");
    if (old_items_total * old_factor - old_total).abs() > 0.005 {
        return Err("يلزم تسوية إجمالي الفاتورة التاريخية قبل تعديلها".into());
    }
    let mut matched = HashSet::new();
    let mut audit_lines = Vec::new();
    for item in &payload.cart {
        let candidates: Vec<_> = rows
            .iter()
            .filter(|row| {
                if let Some(line_id) = item.purchase_invoice_item_id {
                    return row.try_get::<i64, _>("id").ok() == Some(line_id);
                }
                let expiry: Option<String> = row.try_get("expiry_date").unwrap_or(None);
                number(row, "drug_id") == item.id as f64
                    && normalize_date_ymd(expiry.as_deref())
                        == normalize_date_ymd(item.expiry_date.as_deref())
            })
            .collect();
        if candidates.len() != 1 {
            return Err("تعذر مطابقة سطر الفاتورة بأمان؛ أعد فتح الفاتورة".into());
        }
        let row = candidates[0];
        let line_id: i64 = row.try_get("id").map_err(|e| e.to_string())?;
        if !matched.insert(line_id) {
            return Err("سطر فاتورة مكرر".into());
        }
        let inventory_id: String = row
            .try_get::<Option<String>, _>("inventory_id")
            .ok()
            .flatten()
            .ok_or("دفعة تاريخية غير مرتبطة؛ يلزم تسويتها قبل التعديل")?;
        ensure_exclusive_purchase_inventory(tx, &inventory_id, invoice_id).await?;
        // More than one line sharing a lot cannot be corrected independently.
        if rows
            .iter()
            .filter(|other| {
                other.try_get::<String, _>("inventory_id").ok().as_deref()
                    == Some(inventory_id.as_str())
            })
            .count()
            != 1
        {
            return Err("دفعة مشتركة بين أسطر؛ يلزم تسويتها قبل التعديل".into());
        }
        let old_expiry: Option<String> = row.try_get("expiry_date").unwrap_or(None);
        let stock_expiry: Option<String> = row.try_get("stock_expiry").unwrap_or(None);
        let stock_pharmacy: Option<String> = row.try_get("stock_pharmacy").unwrap_or(None);
        let old_unit: Option<i64> = row.try_get("unit_id").unwrap_or(None);
        let old_barcode: Option<String> = row
            .try_get::<Option<String>, _>("barcode")
            .ok()
            .flatten()
            .filter(|b| !b.trim().is_empty())
            .or_else(|| {
                row.try_get::<Option<String>, _>("stock_barcode")
                    .ok()
                    .flatten()
            });
        if number(row, "drug_id") != item.id as f64
            || number(row, "stock_drug") != item.id as f64
            || old_unit != item.unit_id
            || normalize_date_ymd(old_expiry.as_deref())
                != normalize_date_ymd(item.expiry_date.as_deref())
            || normalize_date_ymd(stock_expiry.as_deref())
                != normalize_date_ymd(old_expiry.as_deref())
            || normalize_pharmacy_id(stock_pharmacy.as_deref())
                != normalize_pharmacy_id(payload.pharmacy_id.as_deref())
            || number(row, "strips_per_box").max(1.0) != item.strips_per_box as f64
            || number(row, "stock_strips").max(1.0) != item.strips_per_box as f64
            || number(row, "medium_to_small").max(1.0) != number(row, "stock_small").max(1.0)
            || (number(row, "bonus_quantity") - item.bonus_quantity).abs() > 0.000_001
            || (number(row, "cost_price") - item.cost_price).abs() > 0.000_001
            || (number(row, "tax_percent") - item.tax_percent).abs() > 0.000_001
            || (number(row, "discount_percent") - item.discount_percent).abs() > 0.000_001
            || old_barcode.as_deref().unwrap_or("").trim()
                != item.barcode.as_deref().unwrap_or("").trim()
        {
            return Err(blocked.into());
        }
        let old_qty = number(row, "quantity") + number(row, "bonus_quantity");
        let new_qty = item.quantity + item.bonus_quantity;
        let available = number(row, "available");
        let remaining = available + new_qty - old_qty;
        if !remaining.is_finite() || available < 0.0 || remaining < -0.000_001 {
            return Err(
                "لا يمكن تقليل كمية الشراء عن الكمية المستهلكة؛ لن يتم تغيير المخزون".into(),
            );
        }
        let old_cost = number(row, "quantity")
            * number(row, "cost_price")
            * (1.0 + number(row, "tax_percent") / 100.0)
            * (1.0 + number(old, "tax_percent") / 100.0)
            * old_factor
            / old_qty;
        let new_cost = purchase_item_total(item, payload.tax_percent) * paid_factor / new_qty;
        if !old_cost.is_finite()
            || !new_cost.is_finite()
            || (new_cost - old_cost).abs() > 0.000_001
            || (number(row, "stock_cost") - old_cost).abs() > 0.000_001
        {
            return Err(blocked.into());
        }
        sqlx::query("UPDATE inventory SET quantity = ?, local_selling_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
            .bind(remaining.max(0.0)).bind(item.selling_price.unwrap_or(number(row, "selling_price"))).bind(&inventory_id)
            .execute(&mut **tx).await.map_err(|e| e.to_string())?;
        sqlx::query("UPDATE purchase_invoice_items SET quantity = ?, bonus_quantity = ?, cost_price = ?, selling_price = ?, tax_percent = ?, discount_percent = ? WHERE id = ?")
            .bind(item.quantity).bind(item.bonus_quantity).bind(item.cost_price).bind(item.selling_price.unwrap_or(number(row, "selling_price"))).bind(item.tax_percent).bind(item.discount_percent).bind(line_id)
            .execute(&mut **tx).await.map_err(|e| e.to_string())?;
        if new_qty > old_qty + 0.000_001 && remaining > 0.0 {
            resolve_shortage_if_stock_recovered(tx, item.id, payload.pharmacy_id.as_deref())
                .await?;
        }
        audit_lines.push(serde_json::json!({"lineId":line_id,"inventoryId":inventory_id,"drugId":item.id,"unitCost":old_cost,"oldReceived":old_qty,"newReceived":new_qty,"oldAvailable":available,"newAvailable":remaining.max(0.0),"oldSellingPrice":number(row,"selling_price"),"newSellingPrice":item.selling_price}));
    }
    let delta = new_total - old_total;
    let mut delta_journal: Option<String> = None;
    if delta.abs() > 0.000_001 {
        let journal_id = uuid::Uuid::new_v4().to_string();
        let inventory = account_id(tx, "inventory_asset", "1.1.3").await?;
        let counter = if payment == "cash" {
            account_id(tx, "cash_drawer", "1.1.1").await?
        } else {
            account_id(tx, "accounts_payable", "2.1").await?
        };
        sqlx::query("INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id) VALUES (?,DATE('now','localtime'),?,?,?,?)")
            .bind(&journal_id).bind(&marker).bind(&payload.user_id).bind(delta.abs())
            .bind(payload.pharmacy_id.as_deref()).execute(&mut **tx).await.map_err(|e| e.to_string())?;
        insert_journal_entry(
            tx,
            &journal_id,
            inventory,
            if delta > 0.0 { "debit" } else { "credit" },
            delta.abs(),
        )
        .await?;
        insert_journal_entry(
            tx,
            &journal_id,
            counter,
            if delta > 0.0 { "credit" } else { "debit" },
            delta.abs(),
        )
        .await?;
        sqlx::query("INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id,notes) VALUES (?,'invoice',?,?,?)")
            .bind(payload.supplier_id).bind(delta).bind(invoice_id).bind(&marker).execute(&mut **tx).await.map_err(|e| e.to_string())?;
        if payment == "cash" {
            let shift_id = resolve_open_shift(tx, &payload.user_id, None)
                .await?
                .ok_or("يلزم فتح وردية لتسوية فرق فاتورة الشراء النقدية")?;
            sqlx::query("INSERT INTO cash_movements(id,user_id,shift_id,type,amount,category,notes,date) VALUES (?,?,?,?,?,'purchases',?,DATE('now','localtime'))")
                .bind(uuid::Uuid::new_v4().to_string()).bind(&payload.user_id).bind(shift_id).bind(if delta > 0.0 { "disbursement" } else { "receipt" }).bind(delta.abs()).bind(&marker).execute(&mut **tx).await.map_err(|e| e.to_string())?;
            sqlx::query("INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id,notes) VALUES (?,'payment',?,?,?)")
                .bind(payload.supplier_id).bind(-delta).bind(invoice_id).bind(&marker).execute(&mut **tx).await.map_err(|e| e.to_string())?;
        } else {
            sqlx::query("UPDATE suppliers SET balance = balance + ? WHERE id = ?")
                .bind(delta)
                .bind(payload.supplier_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        // The source amount is updated below; seal this journal only AFTER
        // its new total is stored, still within the native writer transaction.
        delta_journal = Some(journal_id);
    }
    sqlx::query("UPDATE purchase_invoices SET invoice_number = ?, notes = ?, expenses = ?, discount_value = ?, discount_percent = ?, tax_percent = ?, total_amount = ? WHERE id = ?")
        .bind(&payload.invoice_number).bind(&payload.notes).bind(payload.expenses).bind(payload.discount_value).bind(payload.discount_percent).bind(payload.tax_percent).bind(new_total).bind(invoice_id)
        .execute(&mut **tx).await.map_err(|e| e.to_string())?;
    if delta_journal.is_none()
        && audit_lines.iter().any(|line| {
            line["newReceived"]
                .as_f64()
                .zip(line["oldReceived"].as_f64())
                .is_some_and(|(new, old)| (new - old).abs() > 0.000_001)
        })
    {
        super::purchase_posting_provenance::record_zero_delta_stock_edit(
            tx,
            invoice_id,
            &payload.user_id,
            payload
                .pharmacy_id
                .as_deref()
                .ok_or("Purchase pharmacy missing")?,
            payload.supplier_id,
            old_total,
            new_total,
            &audit_lines,
        )
        .await?;
    }
    if let Some(journal_id) = delta_journal {
        super::purchase_posting_provenance::record_purchase_event(
            tx,
            invoice_id,
            &payload.user_id,
            payload
                .pharmacy_id
                .as_deref()
                .ok_or("Purchase pharmacy missing")?,
            payload.supplier_id,
            &payment,
            "edit_delta",
            old_total,
            new_total,
            &journal_id,
        )
        .await?;
    }
    sqlx::query("INSERT INTO activity_log(user_id,action,details) VALUES (?,'EDIT_COMPLETED_PURCHASE',?)")
        .bind(&payload.user_id).bind(serde_json::json!({"invoiceId":invoice_id,"oldTotal":old_total,"newTotal":new_total,"delta":delta,"lines":audit_lines,"oldNumber":old.try_get::<Option<String>,_>("invoice_number").ok().flatten(),"newNumber":payload.invoice_number,"oldNotes":old.try_get::<Option<String>,_>("notes").ok().flatten(),"newNotes":payload.notes}).to_string())
        .execute(&mut **tx).await.map_err(|e| e.to_string())?;
    Ok(Some(PurchaseResult {
        id: invoice_id.to_string(),
        total_amount: new_total,
    }))
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
    let new_batch_number = format!("PURCHASE-{invoice_id}");
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
        ensure_exclusive_purchase_inventory(tx, &inventory_id, invoice_id).await?;
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
            && new_pharmacy_scope == old_pharmacy_scope;
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
                let medium_to_small = drug_medium_to_small(tx, drug_id).await?;
                sqlx::query("UPDATE inventory SET quantity = quantity + ?, local_selling_price = ?, cost_price = ?, batch_number = ?, strips_per_box = ?, medium_to_small = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                    .bind(new_qty - old_qty)
                    .bind(new_item.selling_price.unwrap_or(0.0))
                    .bind(net_unit_cost)
                    .bind(&new_batch_number)
                    .bind(new_item.strips_per_box)
                    .bind(medium_to_small)
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

    reverse_purchase_accounting(tx, invoice_id, old_invoice, &payload.user_id).await
}

async fn reverse_purchase_accounting(
    tx: &mut Transaction<'_, Sqlite>,
    invoice_id: &str,
    old_invoice: &sqlx::sqlite::SqliteRow,
    actor_id: &str,
) -> Result<(), String> {
    let old_total: f64 = old_invoice.try_get("total_amount").unwrap_or(0.0);
    let old_supplier_id: i64 = old_invoice.try_get("supplier_id").unwrap_or(0);
    let old_payment: String = old_invoice.try_get("payment_method").unwrap_or_default();
    let prior_receipted: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM native_purchase_posting_events
         WHERE invoice_id=? AND event_kind IN ('initial','edit_delta')",
    )
    .bind(invoice_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    // Purchase invoices and purchase returns share an untyped reference_id
    // namespace. Historical return rows can lack 041 receipts/048 protection;
    // never delete another source's supplier ledger based only on its text ID.
    let supplier_rows = sqlx::query(
        "SELECT supplier_id, type, CAST(amount AS REAL) AS amount
         FROM supplier_transactions WHERE reference_id = ?",
    )
    .bind(invoice_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    let expected_payment_rows = usize::from(old_payment == "cash");
    let mut invoice_rows = 0usize;
    let mut payment_rows = 0usize;
    let mut valid_supplier_source = true;
    for row in &supplier_rows {
        let supplier_id: i64 = row.try_get("supplier_id").map_err(|e| e.to_string())?;
        let row_type: String = row.try_get("type").map_err(|e| e.to_string())?;
        let amount: f64 = row.try_get("amount").map_err(|e| e.to_string())?;
        if supplier_id != old_supplier_id || !amount.is_finite() {
            valid_supplier_source = false;
        } else if row_type == "invoice" && (amount - old_total).abs() < 0.000_002 {
            invoice_rows += 1;
        } else if row_type == "payment"
            && expected_payment_rows == 1
            && (amount + old_total).abs() < 0.000_002
        {
            payment_rows += 1;
        } else {
            valid_supplier_source = false;
        }
    }
    if !valid_supplier_source
        || invoice_rows != 1
        || payment_rows != expected_payment_rows
        || supplier_rows.len() != 1 + expected_payment_rows
    {
        return Err("Purchase supplier ledger reference is ambiguous or unverifiable; reconcile before reversing".into());
    }
    if prior_receipted > 0 {
        // Never erase a journal sealed by migration 042. A legitimate full
        // correction/withdrawal appends an equal and opposite journal first.
        // The old journal, entries and source snapshot remain inspectable.
        let pharmacy: Option<String> = old_invoice.try_get("pharmacy_id").unwrap_or(None);
        let pharmacy = pharmacy
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .ok_or("Cannot reverse a purchase without explicit tenant lineage")?;
        let reversal_id = uuid::Uuid::new_v4().to_string();
        let inventory = account_id(tx, "inventory_asset", "1.1.3").await?;
        let counter = if old_payment == "cash" {
            account_id(tx, "cash_drawer", "1.1.1").await?
        } else {
            account_id(tx, "accounts_payable", "2.1").await?
        };
        sqlx::query(
            "INSERT INTO daily_journals
             (id,date,description,created_by,total_amount,pharmacy_id)
             VALUES(?,DATE('now','localtime'),?,?,?,?)",
        )
        .bind(&reversal_id)
        .bind(format!("Native purchase reversal [id={invoice_id}]"))
        .bind(actor_id)
        .bind(old_total)
        .bind(pharmacy)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        insert_journal_entry(tx, &reversal_id, inventory, "credit", old_total).await?;
        insert_journal_entry(tx, &reversal_id, counter, "debit", old_total).await?;
        super::purchase_posting_provenance::record_purchase_event(
            tx,
            invoice_id,
            actor_id,
            pharmacy,
            old_supplier_id,
            &old_payment,
            "reverse",
            old_total,
            0.0,
            &reversal_id,
        )
        .await?;
    }
    if old_payment == "credit" || old_payment == "check" {
        sqlx::query("UPDATE suppliers SET balance = balance - ? WHERE id = ?")
            .bind(old_total)
            .bind(old_supplier_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    sqlx::query(
        "DELETE FROM supplier_transactions
         WHERE reference_id = ? AND supplier_id = ? AND type IN ('invoice','payment')",
    )
        .bind(invoice_id)
        .bind(old_supplier_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;

    let invoice_number: Option<String> = old_invoice.try_get("invoice_number").ok();
    let exact_marker = format!("[id={invoice_id}]");
    let has_exact =
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM daily_journals WHERE description = ?")
            .bind(format!("Purchase invoice {exact_marker}"))
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            > 0;
    let mut markers = vec![exact_marker];
    if !has_exact {
        // Legacy descriptions used non-unique numbers. Refuse ambiguous reversal.
        let invoice_prefix: String = invoice_id.chars().take(8).collect();
        let collisions = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM purchase_invoices WHERE id <> ? AND status = 'completed' AND (invoice_number = ? OR SUBSTR(id, 1, 8) = ?)",
        )
        .bind(invoice_id).bind(&invoice_number).bind(&invoice_prefix)
        .fetch_one(&mut **tx).await.map_err(|e| e.to_string())?;
        if collisions > 0 {
            return Err("Historical purchase accounting has a shared invoice reference; reconcile it before editing or deleting this invoice".into());
        }
        markers.extend([invoice_prefix, invoice_id.to_string()]);
        if let Some(number) = invoice_number.filter(|v| !v.trim().is_empty()) {
            markers.push(number);
        }
    }

    // Historical cash movements were keyed only by a human-readable note.
    // Never erase another tenant's similarly named movement or choose between
    // multiple unreceipted candidates. The whole purchase reversal rolls back
    // if its original cash source cannot be established.
    let invoice_pharmacy: Option<String> = old_invoice.try_get("pharmacy_id").unwrap_or(None);
    let invoice_pharmacy = normalize_pharmacy_id(invoice_pharmacy.as_deref());
    let mut original_cash_movement: Option<String> = None;
    let mut original_legacy_journal: Option<String> = None;
    for marker in markers {
        let desc = format!("Purchase invoice {}", marker);
        let journals = sqlx::query(
            "SELECT dj.id, dj.pharmacy_id, u.pharmacy_id AS creator_pharmacy
             FROM daily_journals dj
             LEFT JOIN users u ON CAST(u.id AS TEXT)=CAST(dj.created_by AS TEXT)
             WHERE dj.description = ?",
        )
            .bind(&desc)
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        for journal in journals {
            if prior_receipted > 0 {
                // Those journal entries must remain intact alongside the
                // native reversing entry. Historical text claims alone are
                // not authority to delete a sealed original.
                continue;
            }
            let journal_pharmacy: Option<String> =
                journal.try_get("pharmacy_id").map_err(|e| e.to_string())?;
            let creator_pharmacy: Option<String> =
                journal.try_get("creator_pharmacy").map_err(|e| e.to_string())?;
            if original_legacy_journal.is_some()
                || normalize_pharmacy_id(journal_pharmacy.as_deref()) != invoice_pharmacy
                || normalize_pharmacy_id(creator_pharmacy.as_deref()) != invoice_pharmacy
            {
                return Err("Historical purchase journal source is ambiguous; reconcile before reversing".into());
            }
            let journal_id: String = journal.try_get("id").map_err(|e| e.to_string())?;
            original_legacy_journal = Some(journal_id.clone());
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
        let cash_rows = sqlx::query(
            "SELECT cm.id, cm.type, CAST(cm.amount AS REAL) AS amount,
                    s.pharmacy_id AS shift_pharmacy, u.pharmacy_id AS user_pharmacy
             FROM cash_movements cm
             LEFT JOIN shifts s ON s.id=cm.shift_id
             LEFT JOIN users u ON CAST(u.id AS TEXT)=CAST(cm.user_id AS TEXT)
             WHERE cm.category='purchases' AND cm.notes=?",
        )
        .bind(&desc)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        for movement in cash_rows {
            let shift_pharmacy: Option<String> =
                movement.try_get("shift_pharmacy").map_err(|e| e.to_string())?;
            let user_pharmacy: Option<String> =
                movement.try_get("user_pharmacy").map_err(|e| e.to_string())?;
            let kind: String = movement.try_get("type").map_err(|e| e.to_string())?;
            let amount: f64 = movement.try_get("amount").map_err(|e| e.to_string())?;
            if old_payment != "cash"
                || original_cash_movement.is_some()
                || kind != "disbursement"
                || !amount.is_finite()
                || (amount - old_total).abs() > 0.000_002
                || normalize_pharmacy_id(shift_pharmacy.as_deref()) != invoice_pharmacy
                || normalize_pharmacy_id(user_pharmacy.as_deref()) != invoice_pharmacy
            {
                return Err("Purchase cash movement source is ambiguous; reconcile before reversing".into());
            }
            original_cash_movement = Some(movement.try_get("id").map_err(|e| e.to_string())?);
        }
    }
    if old_payment == "cash" && original_cash_movement.is_none() {
        return Err("Purchase cash movement source is missing; reconcile before reversing".into());
    }
    if let Some(movement_id) = original_cash_movement {
        sqlx::query("DELETE FROM cash_movements WHERE id=?")
            .bind(movement_id)
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
        if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM daily_journals WHERE description = ?")
            .bind(format!("Purchase edit [id={invoice_id}]"))
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            > 0
        {
            return Err(
                "لا يمكن حذف فاتورة لها تسويات بعد البيع؛ استخدم مرتجع شراء للحفاظ على القيود"
                    .into(),
            );
        }
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
            ensure_exclusive_purchase_inventory(tx, &inventory_id, invoice_id).await?;
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
        reverse_purchase_accounting(tx, invoice_id, &invoice, user_id).await?;
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
) -> Result<String, String> {
    let accounting_plan = build_purchase_accounting_plan(payment_method, total_amount)?;
    let journal_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO daily_journals (id, date, description, created_by, total_amount, pharmacy_id) VALUES (?, COALESCE(?, DATE('now', 'localtime')), ?, ?, ?, ?)")
        .bind(&journal_id)
        .bind(&payload.invoice_date)
        .bind(format!("Purchase invoice [id={invoice_id}]"))
        .bind(user_id)
        .bind(total_amount)
        .bind(payload.pharmacy_id.as_deref())
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
    for supplier_transaction in &accounting_plan.supplier_transactions {
        let notes = if supplier_transaction.transaction_type == "payment" {
            format!("Cash payment for {supplier_note}")
        } else {
            supplier_note.clone()
        };
        // Persist the actual purchase's tender terms rather than inheriting
        // the legacy supplier_transactions.payment_method DEFAULT 'cash'.
        // In particular, the invoice ledger is NOT evidence of cash tender
        // when the source purchase and journal are on supplier credit.
        sqlx::query("INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, payment_method, notes) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(supplier_id)
            .bind(supplier_transaction.transaction_type)
            .bind(supplier_transaction.amount)
            .bind(invoice_id)
            .bind(payment_method)
            .bind(notes)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    if accounting_plan.supplier_balance_delta != 0.0 {
        sqlx::query("UPDATE suppliers SET balance = balance + ? WHERE id = ?")
            .bind(accounting_plan.supplier_balance_delta)
            .bind(supplier_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    let settlement_account = match accounting_plan.settlement_account {
        PurchaseSettlementAccount::Payable => payable,
        PurchaseSettlementAccount::Cash => cash,
    };
    insert_journal_entry(tx, &journal_id, settlement_account, "credit", total_amount).await?;

    if let Some(cash_movement) = accounting_plan.cash_movement {
        let shift_id = resolve_open_shift(tx, user_id, None)
            .await?
            .ok_or_else(|| "تعذر إنشاء الوردية المشتركة".to_string())?;
        sqlx::query("INSERT INTO cash_movements (id, user_id, shift_id, type, amount, category, notes, date) VALUES (?, ?, ?, ?, ?, 'purchases', ?, DATE('now', 'localtime'))")
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(user_id)
            .bind(shift_id)
            .bind(cash_movement.movement_type)
            .bind(cash_movement.amount)
            .bind(format!("Purchase invoice [id={invoice_id}]"))
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(journal_id)
}

// These parameters mirror the historical sale row used to recreate a return lot.
#[allow(clippy::too_many_arguments)]
async fn ensure_return_inventory(
    tx: &mut Transaction<'_, Sqlite>,
    inventory_id: Option<&str>,
    drug_id: Option<i64>,
    pharmacy_id: Option<&str>,
    selling_price: f64,
    cost_price: f64,
    restock_qty: f64,
    large_to_medium: f64,
    medium_to_small: f64,
) -> Result<String, String> {
    let pharmacy_scope = normalize_pharmacy_id(pharmacy_id);
    if let Some(id) = inventory_id {
        if let Some(current_cost) = sqlx::query_scalar::<_, f64>("SELECT cost_price FROM inventory WHERE id = ? AND drug_id IS ? AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))")
            .bind(id)
            .bind(drug_id)
            .bind(&pharmacy_scope)
            .bind(&pharmacy_scope)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
        {
            if !current_cost.is_finite() || current_cost < 0.0 {
                return Err("Return source inventory has invalid carrying cost".into());
            }
            // The reversal books historical COGS. A revalued present-day lot
            // cannot absorb that stock without changing its carrying value.
            if (current_cost * restock_qty * 100.0).round()
                == (cost_price * restock_qty * 100.0).round()
            {
                return Ok(id.to_string());
            }
        }
    }
    let drug_id = drug_id.ok_or_else(|| "Return item is missing drug id".to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    let batch = format!("RET-{}", &id[..8]);
    sqlx::query("INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, expiry_date, quantity, local_selling_price, cost_price, strips_per_box, medium_to_small, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
        .bind(&id)
        .bind(&pharmacy_scope)
        .bind(drug_id)
        .bind(batch)
        .bind(selling_price)
        .bind(cost_price)
        .bind(large_to_medium.max(1.0))
        .bind(medium_to_small.max(1.0))
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    Ok(id)
}

#[allow(dead_code)]
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
    let row = sqlx::query("SELECT COALESCE(NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium, COALESCE(NULLIF(i.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1) AS medium_to_small, md.medium_unit, md.small_unit FROM master_drugs md LEFT JOIN inventory i ON i.id = ? WHERE md.id = ?")
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
    let medium_unit = row
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("medium_unit").ok())
        .flatten();
    let small_unit = row
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("small_unit").ok())
        .flatten();
    Ok(unit_quantity_in_large(
        quantity,
        unit,
        large_to_medium,
        medium_to_small,
        medium_unit.as_deref(),
        small_unit.as_deref(),
    ))
}

#[allow(dead_code)]
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
    let row = sqlx::query("SELECT COALESCE(NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium, COALESCE(NULLIF(i.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1) AS medium_to_small, md.medium_unit, md.small_unit FROM master_drugs md LEFT JOIN inventory i ON i.id = ? WHERE md.id = ?")
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
    let medium_unit = row
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("medium_unit").ok())
        .flatten();
    let small_unit = row
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>, _>("small_unit").ok())
        .flatten();
    Ok(large_quantity_in_unit(
        large_qty,
        sale_unit,
        large_to_medium,
        medium_to_small,
        medium_unit.as_deref(),
        small_unit.as_deref(),
    ))
}

async fn apply_return_accounting(
    tx: &mut Transaction<'_, Sqlite>,
    payload: &ReturnPayload,
    return_id: &str,
    total_refund: f64,
    total_cogs_reversal: f64,
) -> Result<String, String> {
    let journal_id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO daily_journals (id, date, description, created_by, total_amount, pharmacy_id) VALUES (?, DATE('now', 'localtime'), ?, ?, ?, ?)")
        .bind(&journal_id)
        .bind(format!("Sales return {}", &payload.invoice_id[..payload.invoice_id.len().min(8)]))
        .bind(&payload.user_id)
        .bind(total_refund + total_cogs_reversal)
        .bind(payload.pharmacy_id.as_deref())
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

    if payload.refund_method == "patient_account" {
        if let Some(patient_id) = payload.patient_id.as_deref() {
            // Link this history mirror to its immutable 043 return source.
            let tx_id = return_id;
            let notes = format!(
                "مرتجع مبيعات فاتورة #{}",
                &payload.invoice_id[..payload.invoice_id.len().min(8)]
            );
            sqlx::query(
                "INSERT INTO patient_transactions (id, patient_id, user_id, type, amount, payment_method, notes, date) VALUES (?, ?, ?, 'refund', ?, 'patient_account', ?, DATE('now', 'localtime'))",
            )
            .bind(tx_id)
            .bind(patient_id)
            .bind(&payload.user_id)
            .bind(total_refund)
            .bind(notes)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        }
    }

    sqlx::query(
        "INSERT INTO activity_log (user_id, action, details) VALUES (?, 'CREATE_RETURN', ?)",
    )
    .bind(&payload.user_id)
    .bind(format!("Return {} value {}", return_id, total_refund))
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    Ok(journal_id)
}

#[allow(clippy::too_many_arguments)]
async fn insert_sale_item(
    tx: &mut Transaction<'_, Sqlite>,
    sale_id: &str,
    inventory_id: Option<&str>,
    item: &CheckoutItem,
    quantity_sold: f64,
    is_negative: bool,
    cost_price: f64,
    large_to_medium: f64,
    medium_to_small: f64,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, item_discount_percent, unit, is_negative, cost_price, large_to_medium, medium_to_small, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    )
    .bind(sale_id)
    .bind(inventory_id)
    .bind(item.drug_id)
    .bind(quantity_sold)
    .bind(item.unit_price)
    .bind(item.item_discount_percent)
    .bind(&item.selected_unit)
    .bind(if is_negative { 1 } else { 0 })
    .bind(cost_price)
    .bind(large_to_medium)
    .bind(medium_to_small)
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

#[cfg(test)]
mod tests {
    /// Test-only source provenance for old hand-built return fixtures. This
    /// inserts through the *real 043 guards*, rather than skipping the new
    /// writer's requirement for a receipted original sale. No production
    /// source is ever backfilled by this helper.
    async fn seal_test_sale_source_for_return(
        conn: &mut SqliteConnection,
        sale_id: &str,
        actor: &str,
    ) {
        let (scope, method, amount, line_count, cost): (String, String, f64, i64, f64) =
            sqlx::query_as(
                "SELECT s.pharmacy_id,s.payment_method,CAST(s.total_amount AS REAL),
                  COUNT(li.id),CAST(COALESCE(SUM(li.quantity_sold*li.cost_price),0) AS REAL)
                 FROM sales_invoices s JOIN sales_items li ON li.invoice_id=s.id
                 WHERE s.id=? GROUP BY s.id",
            )
            .bind(sale_id)
            .fetch_one(&mut *conn).await.unwrap();
        sqlx::query("UPDATE sales_invoices SET user_id=? WHERE id=?")
            .bind(actor).bind(sale_id).execute(&mut *conn).await.unwrap();
        let journal_id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id) VALUES(?,DATE('now'),'Synthetic native 043 purchase-origin fixture',?,?,?)")
            .bind(&journal_id).bind(actor).bind(amount+cost).bind(&scope)
            .execute(&mut *conn).await.unwrap();
        for (code, kind, value) in [
            ("1.1.1", "debit", amount),
            ("4.1", "debit", cost),
            ("3.1", "credit", amount),
            ("1.1.3", "credit", cost),
        ] {
            let account_id: i64 = sqlx::query_scalar("SELECT id FROM accounts WHERE code=?")
                .bind(code).fetch_one(&mut *conn).await.unwrap();
            sqlx::query("INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES(?,?,?,?)")
                .bind(&journal_id).bind(account_id).bind(kind).bind(value)
                .execute(&mut *conn).await.unwrap();
        }
        let witness_lines = vec![serde_json::json!({"synthetic":"fixture"}); line_count as usize];
        sqlx::query(
            "INSERT INTO native_sale_cogs_provenance
               (sale_id,request_id,pharmacy_id,actor_id,journal_id,payment_method,
                sale_micros,cogs_micros,line_count,line_snapshot)
             VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(sale_id).bind(uuid::Uuid::new_v4().to_string())
        .bind(&scope).bind(actor).bind(&journal_id).bind(method)
        .bind((amount*1_000_000.0).round() as i64)
        .bind((cost*1_000_000.0).round() as i64)
        .bind(line_count).bind(serde_json::to_string(&witness_lines).unwrap())
        .execute(&mut *conn).await.unwrap();
    }
    #[test]
    fn generic_renderer_sql_cannot_provision_or_rewrite_shared_supplier_directory_or_ledger() {
        // A supplier id and its balance have no tenant column. Even an active
        // owner cannot safely mutate them through a renderer-selected query.
        for sql in [
            "INSERT INTO suppliers (name_ar) VALUES ('Forged')",
            "INSERT OR REPLACE INTO main.suppliers (id,name_ar) VALUES (7,'Forged')",
            "UPDATE suppliers SET balance=999 WHERE id=7",
            "DELETE FROM suppliers WHERE id=7",
            "INSERT INTO supplier_transactions (supplier_id,type,amount) VALUES (7,'payment',999)",
            "UPDATE supplier_transactions SET amount=999 WHERE supplier_id=7",
            "DELETE FROM supplier_transactions WHERE supplier_id=7",
            "DELETE FROM native_supplier_payment_receipts WHERE supplier_id=7",
            "INSERT INTO native_supplier_directory_ownership(supplier_id,pharmacy_id) VALUES(7,'foreign')",
        ] {
            assert!(
                super::validate_write_sql(sql).is_err(),
                "Renderer SQL could mutate unowned supplier history: {sql}"
            );
        }
    }

    #[test]
    fn generic_renderer_sql_cannot_forge_patient_ownership_or_mutate_clinical_rows() {
        for sql in [
            "INSERT INTO patients(id,full_name) VALUES('legacy','Claimed')",
            "UPDATE patients SET wallet_balance=999 WHERE id='legacy'",
            "DELETE FROM patients WHERE id='legacy'",
            "INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id) VALUES('legacy','tenant-b','owner-b')",
            "UPDATE native_patient_directory_ownership SET pharmacy_id='tenant-b'",
            "DELETE FROM native_patient_directory_ownership WHERE patient_id='legacy'",
            "INSERT INTO patient_transactions(patient_id,amount) VALUES('legacy',999)",
            "DELETE FROM patient_allergies WHERE patient_id='legacy'",
            "UPDATE patient_conditions SET condition_name='claimed' WHERE patient_id='legacy'",
            "DELETE FROM refill_reminders WHERE patient_id='legacy'",
            "INSERT INTO native_patient_wallet_topup_receipts(id,patient_id) VALUES('fake','legacy')",
        ] {
            assert!(super::validate_write_sql(sql).is_err(),
                "Renderer SQL may not claim/alter unowned clinical history: {sql}");
        }
    }

    #[cfg(pharma_security_release)]
    #[tokio::test]
    async fn secure_release_refuses_all_renderer_selected_sql_writes_even_for_active_owner() {
        let mut conn = sqlx::SqliteConnection::connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,is_active INTEGER)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users VALUES('owner','owner','branch-a',1)")
            .execute(&mut conn)
            .await
            .unwrap();
        for sql in [
            "UPDATE users SET role='cashier'",
            "INSERT INTO users SELECT * FROM users",
            "DELETE FROM users",
            "UPDATE inventory SET quantity=(SELECT COUNT(*) FROM patients)",
        ] {
            let error = super::authorize_generic_write(&mut conn, "owner", sql)
                .await
                .unwrap_err();
            assert!(
                error.contains("Generic renderer SQL writes are disabled"),
                "{sql}"
            );
        }
    }
    use super::{
        add_purchase_inventory, begin_critical_transaction, checkout_total, create_return_tx,
        create_return_tx_with_request, delete_purchase_invoice_tx,
        ensure_exclusive_purchase_inventory, ensure_transaction_actor, ensure_transaction_owner,
        large_quantity_in_unit, loyalty_points, owned_transaction_connection,
        patient_outstanding_debt, process_checkout_tx, process_checkout_tx_with_request,
        purchase_inventory_paid_factor, resolve_open_shift, return_quantity_in_sale_unit,
        return_restock_qty, sale_stock_qty, save_purchase_invoice_tx,
        save_purchase_invoice_tx_checked, settle_negative_sale_item_tx, unit_quantity_in_large,
        user_can_view_purchases, user_has_permission, user_permission_number,
        validate_purchase_items, validate_read_sql, validate_write_sql, CheckoutItem,
        CheckoutPayload, DbTransactions, GuardedTransaction, NegativeStockSettlementPayload,
        PurchaseItem, PurchasePayload, ReturnItem, ReturnPayload, MAX_GUARDED_TRANSACTION_AGE,
    };
    #[cfg(not(pharma_security_release))]
    use super::{
        authorize_generic_write, execute_guarded_on_connection, select_guarded_on_connection,
    };
    use crate::commands::purchase_returns::{
        run_purchase_return_transaction, PurchaseReturnItem, PurchaseReturnPayload,
    };
    use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
    use std::{
        collections::HashMap,
        time::{Duration, Instant},
    };
    use uuid::Uuid;

    #[tokio::test]
    async fn all_builds_reject_existing_purchase_edit_without_expected_status() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,status TEXT,pharmacy_id TEXT);
          INSERT INTO purchase_invoices VALUES('posted','completed','branch-b');",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let payload: PurchasePayload = serde_json::from_value(serde_json::json!({
            "id":"posted", "supplier_id":1,"status":"draft", "cart":[]
        }))
        .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let error = save_purchase_invoice_tx_checked(&mut tx, payload, None)
            .await
            .unwrap_err();
        assert!(error.contains("checked original lifecycle status"));
        tx.rollback().await.unwrap();
        let status: String =
            sqlx::query_scalar("SELECT status FROM purchase_invoices WHERE id='posted'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(status, "completed");
    }

    #[tokio::test]
    async fn native_checkout_ipc_never_accepts_renderer_actor_or_pharmacy_claims() {
        let raw = serde_json::json!({
            "items": [{ "drug_id": 9, "inventory_id": null,
                "quantity_sold": 1.0, "unit_price": 12.0,
                "selected_unit":"large", "is_negative":false }],
            "patient_id": null, "shift_id": null, "source_draft_id": null,
            "payment_method":"cash", "check_number":null, "status":"completed",
            "total_discount": 0, "additional_fees":0, "points_to_redeem":0
        });
        for key in [
            "user_id",
            "pharmacy_id",
            "userId",
            "pharmacyId",
            "role",
            "sql",
        ] {
            let mut forged = raw.clone();
            forged[key] = serde_json::json!("attacker-branch-b");
            assert!(
                serde_json::from_value::<super::NativeCheckoutRequest>(forged).is_err(),
                "Forged checkout IPC field {key} must not be accepted"
            );
        }
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users(id TEXT PRIMARY KEY, pharmacy_id TEXT, is_active INTEGER);
          INSERT INTO users VALUES('a','branch-a',1),('b','branch-b',1),('off','branch-a',0);",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let owned = super::native_checkout_owned_payload(
            &mut tx,
            "a",
            serde_json::from_value(raw.clone()).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(owned.user_id, "a");
        assert_eq!(owned.pharmacy_id, "branch-a");
        let foreign = super::native_checkout_owned_payload(
            &mut tx,
            "b",
            serde_json::from_value(raw.clone()).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(foreign.user_id, "b");
        assert_eq!(foreign.pharmacy_id, "branch-b");
        assert!(super::native_checkout_owned_payload(
            &mut tx,
            "off",
            serde_json::from_value(raw.clone()).unwrap()
        )
        .await
        .is_err());
        assert!(super::native_checkout_owned_payload(
            &mut tx,
            "unknown",
            serde_json::from_value(raw.clone()).unwrap()
        )
        .await
        .is_err());
        // The login actor is trusted; a staff move occurring before the writer
        // reservation changes the resulting checkout tenant automatically.
        sqlx::query("UPDATE users SET pharmacy_id='branch-b' WHERE id='a'")
            .execute(&mut *tx)
            .await
            .unwrap();
        let moved = super::native_checkout_owned_payload(
            &mut tx,
            "a",
            serde_json::from_value(raw).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(moved.pharmacy_id, "branch-b");
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn native_purchase_ipc_requires_database_owned_identity_and_denies_forged_claims() {
        let raw = serde_json::json!({
            "id": "new-id", "supplier_id": "1", "status": "draft",
            "cart": [{"id":"123","quantity":"2","cost_price":"4.5"}]
        });
        for injected in [
            "user_id",
            "pharmacy_id",
            "userId",
            "pharmacyId",
            "role",
            "sql",
        ] {
            let mut forged = raw.clone();
            forged[injected] = serde_json::json!("another-pharmacy");
            assert!(
                serde_json::from_value::<super::NativePurchaseRequest>(forged).is_err(),
                "Forbidden renderer purchase claim {injected} was accepted"
            );
        }
        for key in [
            "user_id",
            "pharmacy_id",
            "userId",
            "pharmacyId",
            "role",
            "sql",
        ] {
            let mut forged = serde_json::json!({"invoice_id":"i1","remove_inventory":true});
            forged[key] = serde_json::json!("malicious");
            assert!(
                serde_json::from_value::<super::DeletePurchasePayload>(forged).is_err(),
                "Forbidden purchase delete field {key} was accepted"
            );
        }
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE users(id TEXT, pharmacy_id TEXT, is_active INTEGER);
            INSERT INTO users VALUES('active','branch-a',1),('foreign','branch-b',1),('disabled','branch-a',0);")
            .execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let pharmacy = super::active_native_actor_pharmacy(&mut tx, "active")
            .await
            .unwrap();
        let owned: super::PurchasePayload =
            serde_json::from_value::<super::NativePurchaseRequest>(raw.clone())
                .unwrap()
                .with_native_owner("active", &pharmacy);
        assert_eq!(
            (owned.user_id.as_str(), owned.pharmacy_id.as_deref()),
            ("active", Some("branch-a"))
        );
        assert_eq!(owned.cart[0].id, 123);
        let other = super::active_native_actor_pharmacy(&mut tx, "foreign")
            .await
            .unwrap();
        assert_eq!(other, "branch-b");
        assert!(super::active_native_actor_pharmacy(&mut tx, "disabled")
            .await
            .is_err());
        assert!(super::active_native_actor_pharmacy(&mut tx, "absent")
            .await
            .is_err());
        sqlx::query("UPDATE users SET pharmacy_id='branch-b' WHERE id='active'")
            .execute(&mut *tx)
            .await
            .unwrap();
        let moved = super::active_native_actor_pharmacy(&mut tx, "active")
            .await
            .unwrap();
        assert_eq!(moved, "branch-b");
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn native_sales_return_and_negative_settlement_reject_renderer_tenant_and_actor_claims() {
        let raw_return = serde_json::json!({
            "invoice_id": "s-1", "shift_id": null, "refund_method": "cash",
            "reason": "customer return", "patient_id": null,
            "items": [{"sale_item_id": 11, "inventory_id": "lot-1",
                       "drug_name": "Drug", "quantity": 1, "unit_price": 5, "unit": "large"}]
        });
        let raw_settlement = serde_json::json!({
            "sale_item_id": 11, "inventory_id": "lot-1"
        });
        assert!(
            serde_json::from_value::<super::NativeReturnRequest>(raw_return.clone())
                .unwrap()
                .validate()
                .is_ok()
        );
        assert!(
            serde_json::from_value::<super::NativeNegativeStockSettlementRequest>(
                raw_settlement.clone()
            )
            .unwrap()
            .validate()
            .is_ok()
        );
        for invalid in [
            serde_json::json!({ "quantity": 0 }),
            serde_json::json!({ "quantity": 1_000_000_001 }),
            serde_json::json!({ "sale_item_id": -1 }),
            serde_json::json!({ "drug_name": "x".repeat(257) }),
        ] {
            let mut request = raw_return.clone();
            let object = invalid.as_object().unwrap();
            for (key, value) in object {
                request["items"][0][key.as_str()] = value.clone();
            }
            assert!(
                serde_json::from_value::<super::NativeReturnRequest>(request)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
        let mut too_many = raw_return.clone();
        too_many["items"] = serde_json::json!(vec![raw_return["items"][0].clone(); 201]);
        assert!(
            serde_json::from_value::<super::NativeReturnRequest>(too_many)
                .unwrap()
                .validate()
                .is_err()
        );
        let mut enormous_lot = raw_settlement.clone();
        enormous_lot["inventory_id"] = serde_json::json!("x".repeat(257));
        assert!(
            serde_json::from_value::<super::NativeNegativeStockSettlementRequest>(enormous_lot)
                .unwrap()
                .validate()
                .is_err()
        );
        for key in [
            "user_id",
            "pharmacy_id",
            "userId",
            "pharmacyId",
            "role",
            "sql",
        ] {
            let mut forged_return = raw_return.clone();
            forged_return[key] = serde_json::json!("other-branch");
            assert!(
                serde_json::from_value::<super::NativeReturnRequest>(forged_return).is_err(),
                "Untrusted return field {key} was accepted"
            );
            let mut forged_settlement = raw_settlement.clone();
            forged_settlement[key] = serde_json::json!("other-branch");
            assert!(
                serde_json::from_value::<super::NativeNegativeStockSettlementRequest>(
                    forged_settlement
                )
                .is_err(),
                "Untrusted settlement field {key} was accepted"
            );
        }
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users(id TEXT PRIMARY KEY, pharmacy_id TEXT, is_active INTEGER);
                       INSERT INTO users VALUES('allowed','branch-1',1),('disabled','branch-1',0);",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let pharmacy = super::active_native_actor_pharmacy(&mut tx, "allowed")
            .await
            .unwrap();
        let native_return =
            serde_json::from_value::<super::NativeReturnRequest>(raw_return.clone())
                .unwrap()
                .with_native_owner("allowed", pharmacy.clone());
        let native_settlement =
            serde_json::from_value::<super::NativeNegativeStockSettlementRequest>(
                raw_settlement.clone(),
            )
            .unwrap()
            .with_native_owner("allowed", pharmacy);
        assert_eq!(
            (
                native_return.user_id.as_str(),
                native_return.pharmacy_id.as_deref()
            ),
            ("allowed", Some("branch-1"))
        );
        assert_eq!(
            (
                native_settlement.user_id.as_str(),
                native_settlement.pharmacy_id.as_str()
            ),
            ("allowed", "branch-1")
        );
        sqlx::query("UPDATE users SET pharmacy_id='branch-2' WHERE id='allowed'")
            .execute(&mut *tx)
            .await
            .unwrap();
        let moved = super::active_native_actor_pharmacy(&mut tx, "allowed")
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_value::<super::NativeReturnRequest>(raw_return)
                .unwrap()
                .with_native_owner("allowed", moved.clone())
                .pharmacy_id
                .as_deref(),
            Some("branch-2")
        );
        assert_eq!(
            serde_json::from_value::<super::NativeNegativeStockSettlementRequest>(raw_settlement)
                .unwrap()
                .with_native_owner("allowed", moved)
                .pharmacy_id,
            "branch-2"
        );
        assert!(super::active_native_actor_pharmacy(&mut tx, "disabled")
            .await
            .is_err());
        assert!(super::active_native_actor_pharmacy(&mut tx, "unknown")
            .await
            .is_err());
        tx.rollback().await.unwrap();
    }

    async fn current_fresh_schema() -> SqliteConnection {
        let connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        current_fresh_schema_on_connection(connection).await
    }

    async fn current_fresh_schema_on_connection(mut connection: SqliteConnection) -> SqliteConnection {
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
            include_str!("../../migrations/010_shift_handover_indexes.sql"),
            include_str!("../../migrations/011_shift_cash_difference_account.sql"),
            include_str!("../../migrations/012_shortages_pharmacy_scope.sql"),
            include_str!("../../migrations/013_shift_handover_details.sql"),
            include_str!("../../migrations/014_inventory_performance.sql"),
            include_str!("../../migrations/015_shared_open_shift.sql"),
            include_str!("../../migrations/016_financial_expense_wiring.sql"),
            include_str!("../../migrations/017_cloud_drug_identity.sql"),
            include_str!("../../migrations/018_unit_conversion_snapshots.sql"),
            include_str!("../../migrations/019_shift_pharmacy_scope.sql"),
            include_str!("../../migrations/020_daily_snapshot_pharmacy_scope.sql"),
        ] {
            sqlx::raw_sql(migration)
                .execute(&mut connection)
                .await
                .unwrap();
        }
        let mut transaction = connection.begin().await.unwrap();
        crate::schema::ensure_compatibility(&mut transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/041_purchase_return_posting_provenance.sql"
        ))
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/042_purchase_posting_events.sql"
        ))
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/043_native_sales_cogs_provenance.sql"
        ))
        .execute(&mut connection)
        .await
        .unwrap();
        for migration in [
            include_str!("../../migrations/044_purchase_create_request_receipts.sql"),
            include_str!("../../migrations/045_native_delivery_collection.sql"),
            include_str!("../../migrations/046_purchase_zero_delta_stock_events.sql"),
            include_str!("../../migrations/047_purchase_draft_create_witnesses.sql"),
        ] {
            sqlx::raw_sql(migration)
                .execute(&mut connection)
                .await
                .unwrap();
        }
        sqlx::raw_sql(include_str!("../../migrations/061_native_patient_directory_ownership.sql"))
            .execute(&mut connection).await.unwrap();
        connection
    }

    #[tokio::test]
    async fn shared_open_shift_is_isolated_by_pharmacy() {
        let mut connection = current_fresh_schema().await;
        sqlx::query("DELETE FROM shifts")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO users (id, username, role, pharmacy_id, is_active) VALUES ('shift-ph-1', 'shift-ph-1', 'owner', 'ph-1', 1), ('shift-ph-2', 'shift-ph-2', 'owner', 'ph-2', 1)"
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let mut first_tx = connection.begin().await.unwrap();
        let first = resolve_open_shift(&mut first_tx, "shift-ph-1", None)
            .await
            .unwrap()
            .unwrap();
        first_tx.commit().await.unwrap();

        let mut second_tx = connection.begin().await.unwrap();
        let second = resolve_open_shift(&mut second_tx, "shift-ph-2", Some(&first))
            .await
            .unwrap()
            .unwrap();
        second_tx.commit().await.unwrap();

        assert_ne!(first, second);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT user_id FROM shifts WHERE id = ?")
                .bind(&first)
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            "shift-ph-1"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT user_id FROM shifts WHERE id = ?")
                .bind(&second)
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            "shift-ph-2"
        );
    }

    #[tokio::test]
    async fn cash_purchase_requires_resolved_shared_shift_before_commit() {
        let mut connection = current_fresh_schema().await;
        sqlx::query("DELETE FROM shifts")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            r#"
            INSERT INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
            VALUES ('fresh-admin', 'fresh-admin', 'admin', 'Fresh Admin', 'fresh-pharmacy',
                    '{"can_view_purchases":true,"can_modify_unit_conversion":true}', 1)
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query("INSERT INTO suppliers (id, name_ar, balance) VALUES (1, 'Fresh Supplier', 0)")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            r#"
            INSERT INTO master_drugs
              (id, trade_name, trade_name_en, official_price, large_to_medium, medium_to_small)
            VALUES (90001, 'دواء مخصص', 'CUSTOM FRESH DRUG', 150, 10, 10)
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TRIGGER block_shared_shift_creation
            BEFORE INSERT ON shifts
            BEGIN
              SELECT RAISE(IGNORE);
            END;
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let mut tx = connection.begin().await.unwrap();
        let error = save_purchase_invoice_tx(
            &mut tx,
            fresh_purchase(
                "cash-no-shift",
                "CASH-NO-SHIFT",
                "cash",
                "completed",
                vec![fresh_purchase_line("2099-01-01", 1.0, 0.0, None)],
            ),
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();

        assert!(error.contains("تعذر إنشاء الوردية المشتركة"));
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM purchase_invoices WHERE id = 'cash-no-shift'"
            )
            .fetch_one(&mut connection)
            .await
            .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM cash_movements WHERE category = 'purchases'"
            )
            .fetch_one(&mut connection)
            .await
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn completed_purchase_allows_null_expiry_only_for_non_expiring_master_drug() {
        let mut connection = current_fresh_schema().await;
        sqlx::query(
            r#"
            INSERT INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
            VALUES ('fresh-admin', 'fresh-admin', 'admin', 'Fresh Admin', 'fresh-pharmacy',
                    '{"can_view_purchases":true,"can_modify_unit_conversion":true}', 1)
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        sqlx::query("INSERT INTO suppliers (id, name_ar, balance) VALUES (1, 'Fresh Supplier', 0)")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            r#"
            INSERT INTO master_drugs
              (id, trade_name, trade_name_en, official_price, large_to_medium, medium_to_small, has_expiry)
            VALUES (90001, 'دواء بدون صلاحية', 'NON EXPIRING DRUG', 150, 10, 10, 0)
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let mut line = fresh_purchase_line("", 1.0, 0.0, None);
        line.expiry_date = None;
        let mut tx = connection.begin().await.unwrap();
        save_purchase_invoice_tx(
            &mut tx,
            fresh_purchase(
                "non-expiring-purchase",
                "NON-EXPIRING",
                "credit",
                "completed",
                vec![line],
            ),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let expiry: Option<String> = sqlx::query_scalar(
            "SELECT expiry_date FROM inventory WHERE drug_id = 90001 AND pharmacy_id = 'fresh-pharmacy'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(expiry, None);

        sqlx::query("UPDATE master_drugs SET has_expiry = 1 WHERE id = 90001")
            .execute(&mut connection)
            .await
            .unwrap();
        let mut tracked_line = fresh_purchase_line("", 1.0, 0.0, None);
        tracked_line.expiry_date = None;
        let mut tx = connection.begin().await.unwrap();
        let error = save_purchase_invoice_tx(
            &mut tx,
            fresh_purchase(
                "tracked-missing-expiry",
                "TRACKED-MISSING",
                "credit",
                "completed",
                vec![tracked_line],
            ),
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(error.contains("expiry date"), "unexpected error: {error}");
    }

    #[test]
    fn purchase_permission_parser_matches_frontend() {
        assert!(user_can_view_purchases(Some("owner"), None));
        assert!(!user_can_view_purchases(Some("ADMIN"), Some("{}")));
        assert!(!user_can_view_purchases(
            Some("ADMIN"),
            Some(r#"{"can_view_purchases":false}"#),
        ));
        assert!(user_can_view_purchases(
            Some("ADMIN"),
            Some(r#"{"can_view_purchases":true}"#),
        ));
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

    #[test]
    fn pos_permissions_honor_explicit_denial_and_legacy_accounts() {
        assert!(user_has_permission(
            Some("owner"),
            Some("{}"),
            "can_access_pos",
            true
        ));
        assert!(user_has_permission(
            Some("pharmacist"),
            None,
            "can_access_pos",
            true
        ));
        for stored in [
            "{}",
            "[]",
            "",
            "{bad",
            "null",
            "true",
            "123",
            r#"{"can_access_pos":null}"#,
        ] {
            assert!(
                !user_has_permission(Some("pharmacist"), Some(stored), "can_access_pos", true),
                "{stored}"
            );
        }
        assert!(user_has_permission(
            Some("cashier"),
            Some(r#"["can_access_pos"]"#),
            "can_access_pos",
            true
        ));
        assert!(!user_has_permission(
            Some("pharmacist"),
            Some(r#"{"can_access_pos":false}"#),
            "can_access_pos",
            true,
        ));
        assert!(user_has_permission(
            Some("cashier"),
            Some(r#""{\"can_discount_sale_item\":true}""#),
            "can_discount_sale_item",
            false,
        ));
        assert_eq!(
            user_permission_number(
                Some("cashier"),
                Some(r#"{"max_invoice_discount_percent":"7.5"}"#),
                "max_invoice_discount_percent",
                0.0,
            ),
            7.5,
        );
    }

    #[test]
    fn unit_conversion_matrix_round_trips_boxes_strips_and_tablets() {
        let large_to_medium = 12.0;
        let medium_to_small = 10.0;
        let equivalents = [
            ("large", 1.0),
            ("medium", 12.0),
            ("strip", 12.0),
            ("small", 120.0),
            ("unit", 120.0),
            ("pill", 120.0),
        ];

        for (source_unit, source_quantity) in equivalents {
            let large = unit_quantity_in_large(
                source_quantity,
                source_unit,
                large_to_medium,
                medium_to_small,
                None,
                None,
            );
            assert!((large - 1.0).abs() < 0.000_001, "{source_unit}");
            for (target_unit, expected_quantity) in equivalents {
                let converted = large_quantity_in_unit(
                    large,
                    target_unit,
                    large_to_medium,
                    medium_to_small,
                    None,
                    None,
                );
                assert!(
                    (converted - expected_quantity).abs() < 0.000_001,
                    "{source_unit} -> {target_unit}"
                );
            }
        }

        assert!(
            (unit_quantity_in_large(12.0, "شريط", 12.0, 10.0, None, None) - 1.0).abs() < 0.000_001
        );
        assert!(
            (unit_quantity_in_large(12.0, "Blister", 12.0, 10.0, Some("blister"), Some("Tablet"))
                - 1.0)
                .abs()
                < 0.000_001
        );
        assert!(
            (large_quantity_in_unit(1.0, "Tablet", 12.0, 10.0, Some("Blister"), Some("tablet"))
                - 120.0)
                .abs()
                < 0.000_001
        );
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

    #[tokio::test]
    async fn credit_purchase_with_catalog_missing_barcode_and_conversion_posts_stock_and_journal() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active) VALUES ('fresh-admin','fresh-admin','owner','fresh-pharmacy',1);
             INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Synthetic supplier',0);
             INSERT INTO master_drugs(id,trade_name,trade_name_en,official_price,base_price,has_expiry,large_to_medium,medium_to_small,barcode)
               VALUES(16793,'Synthetic medicine','PANADOL EXTRA 24 F.C. TABS',54,0,1,0,1,NULL);",
        ).execute(&mut conn).await.unwrap();
        let mut item = fresh_purchase_line("2099-10-30", 1.0, 0.0, None);
        item.id = 16793;
        item.cost_price = 54.0;
        item.selling_price = Some(54.0);
        item.strips_per_box = 1;
        item.barcode = None;
        item.tax_percent = 0.0;
        item.discount_percent = 0.0;
        let mut payload = fresh_purchase("synthetic-qa-shaped", "SYNTHETIC-001", "credit", "completed", vec![item]);
        payload.tax_percent = 0.0;
        let mut tx = conn.begin().await.unwrap();
        let result = save_purchase_invoice_tx_checked(&mut tx, payload, None).await.unwrap();
        assert!((result.total_amount - 54.0).abs() < 0.000001);
        super::super::purchase_posting_provenance::record_purchase_creation(
            &mut tx, "12345678-abcd-4abc-8abc-123456789abc", &result.id,
            "fresh-admin", "fresh-pharmacy", 1, result.total_amount,
        ).await.unwrap();
        tx.commit().await.unwrap();
        let balance: f64 = sqlx::query_scalar("SELECT balance FROM suppliers WHERE id=1")
            .fetch_one(&mut conn).await.unwrap();
        assert!((balance - 54.0).abs() < 0.000001);
        let invoice_method: String = sqlx::query_scalar(
            "SELECT payment_method FROM supplier_transactions
             WHERE supplier_id=1 AND type='invoice' AND reference_id='synthetic-qa-shaped'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(invoice_method, "credit", "new supplier invoice metadata must reflect the posted credit purchase, not the historical cash default");
        let stock: f64 = sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE drug_id=16793 AND pharmacy_id='fresh-pharmacy'")
            .fetch_one(&mut conn).await.unwrap();
        assert!((stock - 1.0).abs() < 0.000001);
        let (debits, credits): (f64, f64) = sqlx::query_as(
            "SELECT SUM(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END), SUM(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END)
             FROM native_purchase_posting_events p JOIN daily_journals j ON j.id=p.journal_id
             JOIN journal_entries e ON e.journal_id=j.id WHERE p.invoice_id='synthetic-qa-shaped'",
        ).fetch_one(&mut conn).await.unwrap();
        assert!((debits - 54.0).abs() < 0.000001);
        assert!((credits - debits).abs() < 0.000001);
    }

    #[tokio::test]
    async fn reversing_purchase_rejects_foreign_legacy_return_ledger_with_same_reference() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active) VALUES
                ('fresh-admin','fresh-admin','owner','fresh-pharmacy',1),
                ('foreign-admin','foreign-admin','owner','foreign-pharmacy',1);
             INSERT INTO suppliers(id,name_ar,balance) VALUES
                (1,'Local supplier',0),(2,'Foreign supplier',-10);
             INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
                VALUES(90001,'Synthetic medicine',150,10,1);
             INSERT INTO purchase_invoices(id,supplier_id,pharmacy_id,user_id,status,invoice_number,total_amount)
                VALUES('foreign-original',2,'foreign-pharmacy','foreign-admin','completed','FOREIGN',10);
             INSERT INTO purchase_returns(id,supplier_id,user_id,purchase_invoice_id,total_amount,status)
                VALUES('shared-ref',2,'foreign-admin','foreign-original',10,'completed');
             INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id,notes)
                VALUES(2,'return',10,'shared-ref','Historical foreign purchase return');",
        ).execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx_checked(
            &mut tx,
            fresh_purchase(
                "shared-ref",
                "LOCAL-001",
                "credit",
                "completed",
                vec![fresh_purchase_line("2099-12-31", 1.0, 0.0, None)],
            ),
            None,
        ).await.unwrap();
        tx.commit().await.unwrap();

        let mut tx = conn.begin().await.unwrap();
        let error = delete_purchase_invoice_tx(
            &mut tx, "shared-ref", true, "fresh-admin", Some("fresh-pharmacy"),
        ).await.unwrap_err();
        assert!(error.contains("supplier ledger reference is ambiguous"), "{error}");
        tx.rollback().await.unwrap();
        let foreign_ledger: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM supplier_transactions
             WHERE supplier_id=2 AND type='return' AND reference_id='shared-ref'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(foreign_ledger, 1, "Unreceipted foreign purchase-return history must survive a local purchase reversal");
        let local_ledger: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM supplier_transactions WHERE supplier_id=1 AND reference_id='shared-ref'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(local_ledger, 1, "Ambiguous reversal must not erase the original local supplier ledger");
        let local_invoice: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM purchase_invoices WHERE id='shared-ref' AND pharmacy_id='fresh-pharmacy'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(local_invoice, 1);
    }

    #[tokio::test]
    async fn reversing_cash_purchase_preserves_foreign_cash_movement_with_matching_note() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active) VALUES
                ('fresh-admin','fresh-admin','owner','fresh-pharmacy',1),
                ('foreign-admin','foreign-admin','owner','foreign-pharmacy',1);
             INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Local supplier',0);
             INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
                VALUES(90001,'Synthetic medicine',150,10,1);
             INSERT INTO shifts(id,user_id,pharmacy_id,status)
                VALUES('foreign-shift','foreign-admin','foreign-pharmacy','open');",
        ).execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx_checked(
            &mut tx,
            fresh_purchase(
                "shared-cash", "LOCAL-CASH", "cash", "completed",
                vec![fresh_purchase_line("2099-12-31", 1.0, 0.0, None)],
            ), None,
        ).await.unwrap();
        tx.commit().await.unwrap();
        sqlx::query(
            "INSERT INTO cash_movements(id,user_id,shift_id,type,category,amount,notes,date)
             VALUES('foreign-cash','foreign-admin','foreign-shift','disbursement',
                    'purchases',99,'Purchase invoice [id=shared-cash]','2026-10-13')",
        ).execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let error = delete_purchase_invoice_tx(
            &mut tx, "shared-cash", true, "fresh-admin", Some("fresh-pharmacy"),
        ).await.unwrap_err();
        assert!(error.contains("cash movement source is ambiguous"), "{error}");
        tx.rollback().await.unwrap();
        let foreign_cash: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM cash_movements WHERE id='foreign-cash' AND user_id='foreign-admin'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(foreign_cash, 1, "Foreign financial cash history must survive a local purchase reversal");
        let local_cash: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM cash_movements
             WHERE user_id='fresh-admin' AND notes='Purchase invoice [id=shared-cash]'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(local_cash, 1, "Failed reversal must preserve the original local movement");
        let invoice: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM purchase_invoices WHERE id='shared-cash'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(invoice, 1);
    }

    #[tokio::test]
    async fn ordinary_cash_purchase_delete_reverses_only_its_own_stock_cash_and_supplier_ledger() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active)
               VALUES('fresh-admin','fresh-admin','owner','fresh-pharmacy',1);
             INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Local supplier',0);
             INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
               VALUES(90001,'Synthetic medicine',150,10,1);",
        ).execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx_checked(
            &mut tx,
            fresh_purchase(
                "normal-cash-delete", "NORMAL-CASH", "cash", "completed",
                vec![fresh_purchase_line("2099-12-31", 2.0, 0.0, None)],
            ),
            None,
        ).await.unwrap();
        tx.commit().await.unwrap();
        let original_cash: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM cash_movements WHERE notes='Purchase invoice [id=normal-cash-delete]'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(original_cash, 1);
        let mut tx = conn.begin().await.unwrap();
        delete_purchase_invoice_tx(
            &mut tx, "normal-cash-delete", true, "fresh-admin", Some("fresh-pharmacy"),
        ).await.unwrap();
        tx.commit().await.unwrap();
        let (invoices, supplier_rows, cash_rows): (i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM purchase_invoices WHERE id='normal-cash-delete'),
                    (SELECT COUNT(*) FROM supplier_transactions WHERE reference_id='normal-cash-delete'),
                    (SELECT COUNT(*) FROM cash_movements WHERE notes='Purchase invoice [id=normal-cash-delete]')",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!((invoices, supplier_rows, cash_rows), (0, 0, 0));
        let remaining_stock: f64 = sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(quantity),0) AS REAL)
             FROM inventory WHERE drug_id=90001 AND pharmacy_id='fresh-pharmacy'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(remaining_stock, 0.0);
    }

    #[tokio::test]
    async fn reversing_unreceipted_purchase_preserves_foreign_journal_with_matching_description() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active) VALUES
                ('fresh-admin','fresh-admin','owner','fresh-pharmacy',1),
                ('foreign-admin','foreign-admin','owner','foreign-pharmacy',1);
             INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Local supplier',10);
             INSERT INTO purchase_invoices(id,supplier_id,user_id,pharmacy_id,status,payment_method,total_amount,invoice_number)
                VALUES('shared-journal',1,'fresh-admin','fresh-pharmacy','completed','credit',10,'LOCAL-JOURNAL');
             INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id)
                VALUES(1,'invoice',10,'shared-journal');
             INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
                VALUES('local-journal','2026-10-13','Purchase invoice [id=shared-journal]',
                    'fresh-admin',10,'fresh-pharmacy'),
                    ('foreign-journal','2026-10-13','Purchase invoice [id=shared-journal]',
                    'foreign-admin',10,'foreign-pharmacy');
             INSERT INTO journal_entries(journal_id,account_id,type,amount)
                VALUES('local-journal',10,'debit',10),('local-journal',7,'credit',10),
                    ('foreign-journal',10,'debit',10),('foreign-journal',7,'credit',10);",
        ).execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let error = delete_purchase_invoice_tx(
            &mut tx, "shared-journal", true, "fresh-admin", Some("fresh-pharmacy"),
        ).await.unwrap_err();
        assert!(error.contains("journal source is ambiguous"), "{error}");
        tx.rollback().await.unwrap();
        let foreign_journal: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM daily_journals WHERE id='foreign-journal' AND pharmacy_id='foreign-pharmacy'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(foreign_journal, 1, "A foreign journal must never be deleted based only on a matching description");
        let original_journal: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM daily_journals WHERE id='local-journal' AND pharmacy_id='fresh-pharmacy'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(original_journal, 1);
        let invoice: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM purchase_invoices WHERE id='shared-journal'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(invoice, 1);
    }

    #[tokio::test]
    async fn legacy_credit_purchase_missing_supplier_source_does_not_create_negative_payable_on_delete() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active)
               VALUES('fresh-admin','fresh-admin','owner','fresh-pharmacy',1);
             INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Synthetic legacy supplier',0);
             INSERT INTO purchase_invoices(id,supplier_id,user_id,pharmacy_id,status,payment_method,total_amount,invoice_number)
               VALUES('missing-source',1,'fresh-admin','fresh-pharmacy','completed','credit',10,'MISSING-SOURCE');",
        ).execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let result = delete_purchase_invoice_tx(
            &mut tx, "missing-source", true, "fresh-admin", Some("fresh-pharmacy"),
        ).await;
        assert!(result.is_err(), "An unverifiable legacy supplier obligation must not silently debit payable");
        tx.rollback().await.unwrap();
        let balance: f64 = sqlx::query_scalar("SELECT CAST(balance AS REAL) FROM suppliers WHERE id=1")
            .fetch_one(&mut conn).await.unwrap();
        let invoice: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM purchase_invoices WHERE id='missing-source'")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!((balance, invoice), (0.0, 1));
    }

    #[tokio::test]
    async fn missing_cash_supplier_payment_blocks_purchase_stock_and_journal_reversal_atomically() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active)
               VALUES('fresh-admin','fresh-admin','owner','fresh-pharmacy',1);
             INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Supplier',0);
             INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
               VALUES(90001,'Synthetic medicine',150,10,1);",
        ).execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx_checked(
            &mut tx,
            fresh_purchase(
                "missing-cash-payment", "CASH-BROKEN", "cash", "completed",
                vec![fresh_purchase_line("2099-12-31", 2.0, 0.0, None)],
            ),
            None,
        ).await.unwrap();
        tx.commit().await.unwrap();
        let before: (f64, i64, i64) = sqlx::query_as(
            "SELECT
              (SELECT CAST(SUM(quantity) AS REAL) FROM inventory WHERE drug_id=90001),
              (SELECT COUNT(*) FROM daily_journals),
              (SELECT COUNT(*) FROM cash_movements WHERE notes='Purchase invoice [id=missing-cash-payment]')",
        ).fetch_one(&mut conn).await.unwrap();
        assert!(before.0 > 0.0 && before.1 > 0 && before.2 == 1);
        // Synthetic corruption: historical payable evidence loses just the paid leg.
        sqlx::query(
            "DELETE FROM supplier_transactions
             WHERE reference_id='missing-cash-payment' AND type='payment'",
        ).execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        assert!(delete_purchase_invoice_tx(
            &mut tx, "missing-cash-payment", true, "fresh-admin", Some("fresh-pharmacy"),
        ).await.unwrap_err().contains("supplier ledger reference"));
        tx.rollback().await.unwrap();
        let after: (f64, i64, i64) = sqlx::query_as(
            "SELECT
              (SELECT CAST(SUM(quantity) AS REAL) FROM inventory WHERE drug_id=90001),
              (SELECT COUNT(*) FROM daily_journals),
              (SELECT COUNT(*) FROM cash_movements WHERE notes='Purchase invoice [id=missing-cash-payment]')",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(before, after, "A rejected cash reversal must preserve stock, journals and cash");
        let invoice: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM purchase_invoices WHERE id='missing-cash-payment'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(invoice, 1);
    }

    #[tokio::test]
    async fn native_cash_checkout_refuses_legacy_null_and_052_placeholder_owner() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
               VALUES(90001,'Synthetic Panadol',46,1,1);
             INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,local_selling_price,expiry_date,strips_per_box,medium_to_small)
               VALUES('qa-panadol-lot',90001,'local_default',10,35,46,'2099-12-31',1,1);",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let unscoped_owner: Option<String> =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='admin'")
                .fetch_one(&mut conn).await.unwrap();
        assert_eq!(unscoped_owner, None);
        let request = serde_json::json!({
            "items": [{"drug_id":90001,"inventory_id":"qa-panadol-lot",
                "quantity_sold":2,"unit_price":46,"item_discount_percent":0,
                "selected_unit":"large","is_negative":false}],
            "patient_id":null,"shift_id":null,"payment_method":"cash",
            "check_number":null,"status":"completed","total_discount":0,
            "additional_fees":0,"points_to_redeem":0
        });
        let mut before = conn.begin().await.unwrap();
        let denied_before = super::native_checkout_owned_payload(
            &mut before, "admin", serde_json::from_value(request.clone()).unwrap(),
        ).await.err().expect("NULL historical actor must be rejected");
        assert!(denied_before.contains("explicitly owned pharmacy"), "{denied_before}");
        before.rollback().await.unwrap();
        let uncommitted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales_invoices")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(uncommitted, 0);
        // Simulate a licensed 051 installation being upgraded. Migration 043
        // remains unchanged and still requires an explicitly scoped actor.
        sqlx::raw_sql(include_str!("../../migrations/052_explicit_local_owner_pharmacy.sql"))
            .execute(&mut conn).await.unwrap();
        let normalized: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='admin'")
                .fetch_one(&mut conn).await.unwrap();
        assert_eq!(normalized, "local_default");
        let mut tx = conn.begin().await.unwrap();
        let requested = serde_json::from_value(request).unwrap();
        let denied_after = super::native_checkout_owned_payload(&mut tx, "admin", requested)
            .await.err().expect("052's placeholder is not original-owner proof");
        assert!(denied_after.contains("explicitly owned pharmacy"), "{denied_after}");
        tx.rollback().await.unwrap();
        let stock: f64 = sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id='qa-panadol-lot'")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(stock, 10.0);
        for table in ["native_sale_cogs_provenance","sales_invoices","daily_journals","cash_movements"] {
            let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(&mut conn).await.unwrap();
            assert_eq!(count,0,"denied financial checkout altered {table}");
        }
    }

    #[tokio::test]
    async fn selected_pos_lots_keep_cash_credit_cogs_journal_and_receipt_ids_joined() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active)
               VALUES('lot-owner','lot-owner','owner','lot-pharmacy',1);
             INSERT INTO patients(id,full_name,credit_limit,opening_balance)
               VALUES('lot-credit-patient','Lot credit patient',500,0);
             INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
               VALUES(90002,'Selected lot sale',30,1,1);
             INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,local_selling_price,expiry_date,strips_per_box)
               VALUES('chosen-cash-lot',90002,'lot-pharmacy',6,12,30,'2099-12-31',1),
                     ('chosen-credit-lot',90002,'lot-pharmacy',6,5,30,'2099-12-31',1),
                     ('foreign-lot',90002,'other-pharmacy',6,1,30,'2099-12-31',1);",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        // This is a *newly created* synthetic patient for the test tenant;
        // legacy global IDs never acquire a witness by inferred association.
        sqlx::query("INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256) VALUES('lot-credit-patient','lot-pharmacy','lot-owner',lower(hex(zeroblob(32))))")
            .execute(&mut conn).await.unwrap();

        for (method, lot_id, quantity, unit_cost, patient_id, request_id) in [
            ("cash", "chosen-cash-lot", 2.0, 12.0, None, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            ("credit", "chosen-credit-lot", 3.0, 5.0, Some("lot-credit-patient"), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        ] {
            let revenue = quantity * 30.0;
            let cogs = quantity * unit_cost;
            let payload = CheckoutPayload {
                pharmacy_id: "lot-pharmacy".into(),
                user_id: "lot-owner".into(),
                items: vec![CheckoutItem {
                    drug_id: 90002,
                    inventory_id: Some(lot_id.into()),
                    quantity_sold: quantity,
                    unit_price: 30.0,
                    item_discount_percent: 0.0,
                    selected_unit: "large".into(),
                    is_negative: false,
                }],
                patient_id: patient_id.map(str::to_owned),
                shift_id: None,
                source_draft_id: None,
                payment_method: method.into(),
                check_number: None,
                status: "completed".into(),
                total_discount: 0.0,
                additional_fees: 0.0,
                points_to_redeem: 0,
            };
            let mut tx = conn.begin().await.unwrap();
            let sale = process_checkout_tx_with_request(&mut tx, payload, revenue, request_id)
                .await
                .unwrap();
            tx.commit().await.unwrap();

            let source: (String, String, Option<String>, f64, f64) = sqlx::query_as(
                "SELECT pharmacy_id,user_id,patient_id,CAST(total_amount AS REAL),CAST(paid_amount AS REAL)
                 FROM sales_invoices WHERE id=? AND status='completed' AND payment_method=?",
            )
            .bind(&sale.sale_id)
            .bind(method)
            .fetch_one(&mut conn)
            .await
            .unwrap();
            assert_eq!(source.0, "lot-pharmacy");
            assert_eq!(source.1, "lot-owner");
            assert_eq!(source.2.as_deref(), patient_id);
            assert_eq!(source.3, revenue);
            assert_eq!(source.4, if method == "cash" { revenue } else { 0.0 });

            let line: (i64, String, i64, f64, f64) = sqlx::query_as(
                "SELECT id,inventory_id,drug_id,CAST(quantity_sold AS REAL),CAST(cost_price AS REAL)
                 FROM sales_items WHERE invoice_id=?",
            )
            .bind(&sale.sale_id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
            assert_eq!(line.1, lot_id, "the sale line must claim the chosen specific lot");
            assert_eq!(line.2, 90002);
            assert_eq!((line.3, line.4), (quantity, unit_cost));

            let receipt: (String, String, String, String, String, i64, i64, i64, String) =
                sqlx::query_as(
                    "SELECT request_id,actor_id,pharmacy_id,payment_method,journal_id,
                            sale_micros,cogs_micros,line_count,line_snapshot
                     FROM native_sale_cogs_provenance WHERE sale_id=?",
                )
                .bind(&sale.sale_id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(receipt.0, request_id);
            assert_eq!(receipt.1, "lot-owner");
            assert_eq!(receipt.2, "lot-pharmacy");
            assert_eq!(receipt.3, method);
            assert_eq!(receipt.5, (revenue * 1_000_000.0) as i64);
            assert_eq!(receipt.6, (cogs * 1_000_000.0) as i64);
            assert_eq!(receipt.7, 1);
            let lines: serde_json::Value = serde_json::from_str(&receipt.8).unwrap();
            assert_eq!(lines[0]["lineId"], line.0);
            assert_eq!(lines[0]["inventoryId"], lot_id);
            assert_eq!(lines[0]["drugId"], 90002);
            assert_eq!(lines[0]["quantity"], quantity);
            assert_eq!(lines[0]["costPerLarge"], unit_cost);
            assert_eq!(lines[0]["negative"], false);

            let journal: (String, String, f64) = sqlx::query_as(
                "SELECT pharmacy_id,created_by,CAST(total_amount AS REAL) FROM daily_journals WHERE id=?",
            )
            .bind(&receipt.4)
            .fetch_one(&mut conn)
            .await
            .unwrap();
            assert_eq!((journal.0.as_str(), journal.1.as_str()), ("lot-pharmacy", "lot-owner"));
            assert_eq!(journal.2, revenue + cogs);
            let entries: Vec<(String, String, f64)> = sqlx::query_as(
                "SELECT a.code,je.type,CAST(je.amount AS REAL)
                 FROM journal_entries je JOIN accounts a ON a.id=je.account_id
                 WHERE je.journal_id=? ORDER BY a.code",
            )
            .bind(&receipt.4)
            .fetch_all(&mut conn)
            .await
            .unwrap();
            assert_eq!(entries, vec![
                ((if method == "cash" { "1.1.1" } else { "1.1.2" }).into(), "debit".into(), revenue),
                ("1.1.3".into(), "credit".into(), cogs),
                ("3.1".into(), "credit".into(), revenue),
                ("4.1".into(), "debit".into(), cogs),
            ], "the selected lot's COGS and the payment account must share the sale's receipted journal");

            let chosen_stock: f64 = sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?")
                .bind(lot_id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(chosen_stock, 6.0 - quantity);
            let other_lot = if method == "cash" { "chosen-credit-lot" } else { "chosen-cash-lot" };
            let preserved_stock: f64 = sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?")
                .bind(other_lot)
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(preserved_stock, if method == "cash" { 6.0 } else { 4.0 });
            let foreign_stock: f64 = sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id='foreign-lot'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(foreign_stock, 6.0, "a foreign pharmacy's lot must never be decremented");
        }
    }

    #[tokio::test]
    async fn owner_scope_upgrade_leaves_ambiguous_multi_pharmacy_owner_unclaimed() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active)
               VALUES('foreign','foreign','cashier','ph-2',1);",
        )
        .execute(&mut conn).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/052_explicit_local_owner_pharmacy.sql"))
            .execute(&mut conn).await.unwrap();
        let original_owner: Option<String> =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='admin'")
                .fetch_one(&mut conn).await.unwrap();
        assert_eq!(original_owner, None, "ambiguous owner scope must stay unresolved");
        let foreign_scope: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM users WHERE id='foreign'")
                .fetch_one(&mut conn).await.unwrap();
        assert_eq!(foreign_scope, "ph-2");
    }

    #[tokio::test]
    async fn compatibility_native_purchase_credit_sale_return_payment_conserves_sources() {
        let mut conn = current_fresh_schema().await;
        // The standard compatibility-normalized, 043/044-posted fixture adds
        // the 033/036 and 048-051 native-money tables used by this cross-flow.
        // A separate startup regression validates the full 001-051 migration ledger.
        for sql in [
            include_str!("../../migrations/033_patient_payment_scope.sql"),
            include_str!("../../migrations/036_financial_notice_provenance.sql"),
            include_str!("../../migrations/048_purchase_return_supplier_cash_provenance.sql"),
            include_str!("../../migrations/049_purchase_return_reference_indexes.sql"),
            include_str!("../../migrations/050_receipted_credit_patient_ownership.sql"),
            include_str!("../../migrations/051_patient_financial_journal_receipts.sql"),
            include_str!("../../migrations/055_patient_cash_movement_witness.sql"),
            include_str!("../../migrations/056_financial_notice_cash_witness.sql"),
        ] {
            sqlx::raw_sql(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active)
               VALUES('fresh-admin','fresh-admin','owner','fresh-pharmacy',1);
             INSERT INTO patients(id,full_name,credit_limit,opening_balance)
               VALUES('native-patient','Isolated patient',200,0);
             INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Synthetic supplier',0);
             INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
               VALUES(90001,'Synthetic drug',50,1,1);",
        ).execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256) VALUES('native-patient','fresh-pharmacy','fresh-admin',lower(hex(zeroblob(32))))")
            .execute(&mut conn).await.unwrap();

        let mut purchase_line = fresh_purchase_line("2099-12-31", 2.0, 0.0, None);
        purchase_line.selling_price = Some(50.0);
        let mut tx = conn.begin().await.unwrap();
        let purchase = save_purchase_invoice_tx_checked(
            &mut tx, fresh_purchase(
                "native-link-purchase", "NATIVE-LINK", "credit", "completed",
                vec![purchase_line],
            ), None,
        ).await.unwrap();
        super::super::purchase_posting_provenance::record_purchase_creation(
            &mut tx, "11111111-1111-4111-8111-111111111111",
            &purchase.id, "fresh-admin", "fresh-pharmacy", 1, purchase.total_amount,
        ).await.unwrap();
        tx.commit().await.unwrap();
        let lot: String = sqlx::query_scalar(
            "SELECT inventory_id FROM purchase_invoice_items WHERE invoice_id='native-link-purchase'",
        ).fetch_one(&mut conn).await.unwrap();

        let mut tx = conn.begin().await.unwrap();
        let sale = process_checkout_tx_with_request(
            &mut tx,
            CheckoutPayload {
                pharmacy_id: "fresh-pharmacy".into(),
                user_id: "fresh-admin".into(),
                patient_id: Some("native-patient".into()),
                shift_id: None,
                source_draft_id: None,
                payment_method: "credit".into(),
                status: "completed".into(),
                check_number: None,
                total_discount: 0.0,
                additional_fees: 0.0,
                points_to_redeem: 0,
                items: vec![CheckoutItem {
                    drug_id: 90001,
                    inventory_id: Some(lot.clone()),
                    quantity_sold: 2.0,
                    unit_price: 50.0,
                    item_discount_percent: 0.0,
                    selected_unit: "large".into(),
                    is_negative: false,
                }],
            },
            100.0, "22222222-2222-4222-8222-222222222222",
        ).await.unwrap();
        tx.commit().await.unwrap();
        let sale_item: i64 = sqlx::query_scalar(
            "SELECT id FROM sales_items WHERE invoice_id=?",
        ).bind(&sale.sale_id).fetch_one(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let returned = create_return_tx_with_request(
            &mut tx,
            ReturnPayload {
                invoice_id: sale.sale_id.clone(),
                user_id: "fresh-admin".into(),
                pharmacy_id: Some("fresh-pharmacy".into()),
                shift_id: None,
                refund_method: "patient_account".into(),
                reason: Some("partial 043 return".into()),
                patient_id: Some("native-patient".into()),
                items: vec![ReturnItem {
                    sale_item_id: Some(sale_item),
                    inventory_id: Some(lot.clone()),
                    drug_name: "Synthetic drug".into(),
                    quantity: 1.0,
                    unit_price: 50.0,
                    unit: Some("large".into()),
                }],
            },
            "33333333-3333-4333-8333-333333333333",
        ).await.unwrap();
        tx.commit().await.unwrap();
        assert!((returned.total_refund - 50.0).abs() < 0.000001);
        let refund_mirror: (String, f64) = sqlx::query_as(
            "SELECT id,CAST(amount AS REAL) FROM patient_transactions
             WHERE patient_id='native-patient' AND type='refund'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(refund_mirror.0, returned.return_id);
        assert!((refund_mirror.1 - 50.0).abs() < 0.000001);
        let receipt: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_sale_return_cogs_provenance
             WHERE return_id=? AND pharmacy_id='fresh-pharmacy'",
        ).bind(&returned.return_id).fetch_one(&mut conn).await.unwrap();
        assert_eq!(receipt, 1);

        let payment: super::super::patient_payments_native::PatientPaymentInput =
            serde_json::from_value(serde_json::json!({
                "patientId":"native-patient",
                "shiftId":null, "amount":25.0, "paymentMethod":"cash",
                "notes":"043 return followed by 051 native settlement",
                "date":"2026-10-13", "requestId":"native-source-chain-payment"
            })).unwrap();
        super::super::patient_payments_native::post_on_isolated_test_connection(
            &mut conn, "fresh-admin", payment,
        ).await.expect("Authentically receipted 043 patient refund must permit remaining 051 debt collection");
        let payable: f64 = sqlx::query_scalar(
            "SELECT CAST(amount AS REAL) FROM patient_transactions
             WHERE patient_id='native-patient' AND type='payment'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(payable, 25.0);
        let remaining: f64 = sqlx::query_scalar(
            "SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?",
        ).bind(&lot).fetch_one(&mut conn).await.unwrap();
        assert_eq!(remaining, 1.0);
        let unbalanced: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM (
               SELECT journal_id,
                 SUM(CASE WHEN type='debit' THEN amount ELSE -amount END) AS delta
               FROM journal_entries GROUP BY journal_id HAVING ABS(delta)>0.000001
             )",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(unbalanced, 0, "Purchase, POS, return and payment journals must all balance");
        let recorded: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_patient_financial_journal_receipts
             WHERE source_kind='payment' AND pharmacy_id='fresh-pharmacy'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(recorded, 1);
    }

    #[tokio::test]
    async fn isolated_tenant_purchase_sale_return_supplier_payment_and_purchase_return_reconcile() {
        // Exactly one transient SQLite connection, never an installed QA DB.
        // The owner and supplier are synthetic pre-provisioned test fixtures,
        // not a claim that first-owner enrollment can provision a real tenant.
        let mut conn = current_fresh_schema().await;
        for migration in [
            include_str!("../../migrations/048_purchase_return_supplier_cash_provenance.sql"),
            include_str!("../../migrations/049_purchase_return_reference_indexes.sql"),
            include_str!("../../migrations/054_native_supplier_partial_payment.sql"),
            include_str!("../../migrations/057_supplier_cash_shift_identity_guard.sql"),
            include_str!("../../migrations/058_supplier_cash_shift_replace_guard.sql"),
            include_str!("../../migrations/059_supplier_payment_receipt_replace_guard.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&mut conn).await.unwrap();
        }
        // Production creates this via 053; the compact 001-020 compatibility
        // test schema omits other 053-referenced finance migrations.
        sqlx::query("CREATE TABLE native_owner_scope_review(owner_id TEXT PRIMARY KEY)")
            .execute(&mut conn).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO users(id,username,role,pharmacy_id,is_active)
               VALUES('fresh-admin','fresh-admin','owner','fresh-pharmacy',1);
             INSERT INTO users(id,username,role,pharmacy_id,permissions,is_active)
               VALUES('report-fresh','report-fresh','pharmacist','fresh-pharmacy','{"rep_can_view_purchases":true}',1),
                     ('report-other','report-other','pharmacist','other-pharmacy','{"rep_can_view_purchases":true}',1),
                     ('owner-other','owner-other','owner','other-pharmacy','{}',1);
             INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Synthetic supplier',0),(2,'Other synthetic supplier',0);
             INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
               VALUES(90001,'Synthetic drug',150,1,1);
             INSERT INTO patients(id,full_name,credit_limit,opening_balance)
               VALUES('synthetic-patient','Synthetic patient',1000,0);"#,
        ).execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256) VALUES('synthetic-patient','fresh-pharmacy','fresh-admin',lower(hex(zeroblob(32))))")
            .execute(&mut conn).await.unwrap();

        let mut tx = conn.begin().await.unwrap();
        let purchase = save_purchase_invoice_tx_checked(
            &mut tx,
            fresh_purchase(
                "integrated-purchase", "IN-MEM-INVOICE", "credit", "completed",
                vec![fresh_purchase_line("2099-12-31", 4.0, 0.0, None)],
            ),
            None,
        ).await.unwrap();
        super::super::purchase_posting_provenance::record_purchase_creation(
            &mut tx, "f1111111-1111-4111-8111-111111111111",
            &purchase.id, "fresh-admin", "fresh-pharmacy", 1, purchase.total_amount,
        ).await.unwrap();
        tx.commit().await.unwrap();
        let posted_total = purchase.total_amount;
        // Posting policy: 4 paid boxes * 100 net cost * 1.10 item tax *
        // 1.05 invoice tax = 462.00; display-only line discount is not
        // re-applied to the already-net stored cost_price.
        assert!((posted_total - 462.0).abs() < 0.000001);
        let original_payable: f64 = sqlx::query_scalar("SELECT balance FROM suppliers WHERE id=1")
            .fetch_one(&mut conn).await.unwrap();
        assert!((original_payable-posted_total).abs()<0.001);
        let supplier_origin: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT type,payment_method,CAST(amount AS REAL)
             FROM supplier_transactions WHERE supplier_id=1 AND reference_id=? ORDER BY id",
        ).bind(&purchase.id).fetch_all(&mut conn).await.unwrap();
        assert_eq!(supplier_origin, vec![("invoice".into(), "credit".into(), posted_total)],
            "credit purchase must post exactly one supplier invoice, with no implicit cash payment");
        let purchase_witness: (i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM native_purchase_create_requests
                     WHERE invoice_id=? AND pharmacy_id='fresh-pharmacy'
                       AND source_status='completed' AND source_total_cents=46200),
                    (SELECT COUNT(*) FROM native_purchase_posting_events
                     WHERE invoice_id=? AND pharmacy_id='fresh-pharmacy'
                       AND event_kind='initial' AND payment_method='credit' AND signed_cents=46200)",
        ).bind(&purchase.id).bind(&purchase.id).fetch_one(&mut conn).await.unwrap();
        assert_eq!(purchase_witness, (1, 1), "native purchase and payable must have one original posting each");
        let (line_id, lot_id, cost_per_large): (i64, String, f64) = sqlx::query_as(
            "SELECT pi.id,pi.inventory_id,i.cost_price FROM purchase_invoice_items pi
             JOIN inventory i ON i.id=pi.inventory_id WHERE pi.invoice_id=?",
        ).bind(&purchase.id).fetch_one(&mut conn).await.unwrap();
        let initial_stock: f64 = sqlx::query_scalar(
            "SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?"
        ).bind(&lot_id).fetch_one(&mut conn).await.unwrap();
        assert!((initial_stock-4.0).abs()<0.000001);
        assert!((cost_per_large-115.5).abs()<0.000001);
        // The chosen lot is the sole source of this COGS. Neither a supplied
        // foreign lot nor an invented ID may become a negative-sale shortcut.
        let rejected_lot = |id: &str| CheckoutPayload {
            pharmacy_id: "fresh-pharmacy".into(),
            user_id: "fresh-admin".into(),
            patient_id: None,
            shift_id: None,
            source_draft_id: None,
            payment_method: "cash".into(),
            status: "completed".into(),
            check_number: None,
            total_discount: 0.0,
            additional_fees: 0.0,
            points_to_redeem: 0,
            items: vec![CheckoutItem {
                drug_id: 90001, inventory_id: Some(id.into()),
                quantity_sold: 10.0, unit_price: 150.0,
                item_discount_percent: 0.0, selected_unit: "large".into(),
                is_negative: true,
            }],
        };
        let mut tx = conn.begin().await.unwrap();
        sqlx::query("INSERT INTO inventory(id,pharmacy_id,drug_id,quantity,cost_price,expiry_date) VALUES
             ('foreign-pos-choice','other-pharmacy',90001,10,1,'2099-12-31'),
             ('expired-pos-choice','fresh-pharmacy',90001,10,1,'2000-01-01'),
             ('negative-pos-choice','fresh-pharmacy',90001,-1,1,'2099-12-31')")
            .execute(&mut *tx).await.unwrap();
        for invalid_lot in ["foreign-pos-choice", "expired-pos-choice", "negative-pos-choice", "missing-pos-choice"] {
            let rejected = process_checkout_tx_with_request(
                &mut tx, rejected_lot(invalid_lot), 1500.0,
                "f9999999-9999-4999-8999-999999999999",
            ).await.unwrap_err();
            assert!(rejected.contains("Selected inventory batch"), "{invalid_lot}: {rejected}");
        }
        tx.rollback().await.unwrap();
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM sales_invoices")
            .fetch_one(&mut conn).await.unwrap(), 0,
            "invalid negative selected lots must roll back without a sale or financial receipt");
        // A genuinely owned lot can still sell available stock and preserve
        // the rest as an explicitly negative, zero-COGS shortage line.
        let mut tx = conn.begin().await.unwrap();
        let shortage_sale = process_checkout_tx_with_request(
            &mut tx, rejected_lot(&lot_id), 1500.0,
            "f8888888-8888-4888-8888-888888888888",
        ).await.expect("valid selected lot may create an authorized shortage");
        let shortage_lines: Vec<(Option<String>, i64, f64)> = sqlx::query_as(
            "SELECT inventory_id,is_negative,CAST(cost_price AS REAL)
             FROM sales_items WHERE invoice_id=? ORDER BY id",
        ).bind(&shortage_sale.sale_id).fetch_all(&mut *tx).await.unwrap();
        assert_eq!(shortage_lines, vec![
            (Some(lot_id.clone()), 0, cost_per_large),
            (None, 1, 0.0),
        ], "only physically deducted stock contributes to immediate COGS");
        let shortage_cogs: i64 = sqlx::query_scalar(
            "SELECT cogs_micros FROM native_sale_cogs_provenance WHERE sale_id=?",
        ).bind(&shortage_sale.sale_id).fetch_one(&mut *tx).await.unwrap();
        assert_eq!(shortage_cogs, 462_000_000,
            "four purchased boxes are costed while six unlinked shortage boxes await settlement");
        tx.rollback().await.unwrap();
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT quantity FROM inventory WHERE id=?")
            .bind(&lot_id).fetch_one(&mut conn).await.unwrap(),4,
            "rolled-back shortage rehearsal must preserve the positive integration source lot");
        // Read the positive financial projection through the actual native
        // permission- and tenant-checked report API, not fixture-only SQL.
        let purchase_report = super::super::purchasing_reads_native::run_purchasing_read(
            &mut conn, "report-fresh", "purchases.reports",
            Some(r#"{"status":"completed","invoiceNumber":"IN-MEM-INVOICE"}"#),
            None, 20, 0,
        ).await.unwrap();
        assert_eq!(purchase_report.len(), 1);
        assert_eq!(purchase_report[0]["id"], purchase.id);
        assert!((purchase_report[0]["gross_amount"].as_f64().unwrap()-462.0).abs()<0.000001);
        assert!((purchase_report[0]["total_amount"].as_f64().unwrap()-462.0).abs()<0.000001);
        assert!((purchase_report[0]["discount_amount"].as_f64().unwrap()).abs()<0.000001);
        assert!((purchase_report[0]["total_selling_amount"].as_f64().unwrap()-600.0).abs()<0.000001);
        assert!(super::super::purchasing_reads_native::run_purchasing_read(
            &mut conn, "report-other", "purchases.reports", Some("{}"), None, 20, 0,
        ).await.unwrap().is_empty());

        let mut tx = conn.begin().await.unwrap();
        let sale = process_checkout_tx_with_request(
            &mut tx,
            CheckoutPayload {
                pharmacy_id: "fresh-pharmacy".into(),
                user_id: "fresh-admin".into(),
                patient_id: Some("synthetic-patient".into()),
                shift_id: None,
                source_draft_id: None,
                payment_method: "credit".into(),
                status: "completed".into(),
                check_number: None,
                total_discount: 0.0,
                additional_fees: 0.0,
                points_to_redeem: 0,
                items: vec![CheckoutItem {
                    drug_id: 90001, inventory_id: Some(lot_id.clone()),
                    quantity_sold: 2.0, unit_price: 150.0,
                    item_discount_percent: 0.0, selected_unit: "large".into(),
                    is_negative: false,
                }],
            },
            300.0,
            "f2222222-2222-4222-8222-222222222222",
        ).await.unwrap();
        tx.commit().await.unwrap();
        let cogs_micros: i64 = sqlx::query_scalar(
            "SELECT cogs_micros FROM native_sale_cogs_provenance
             WHERE sale_id=? AND pharmacy_id='fresh-pharmacy'",
        ).bind(&sale.sale_id).fetch_one(&mut conn).await.unwrap();
        assert_eq!(cogs_micros, 231_000_000, "2 sold large boxes x 115.50 posted cost");
        assert!((cogs_micros as f64/1_000_000.0 - 2.0*cost_per_large).abs()<0.01);
        let (sold_inventory, sold_cost): (String, f64) = sqlx::query_as(
            "SELECT inventory_id,CAST(cost_price AS REAL) FROM sales_items WHERE invoice_id=?",
        ).bind(&sale.sale_id).fetch_one(&mut conn).await.unwrap();
        assert_eq!((sold_inventory.as_str(),sold_cost),(lot_id.as_str(),cost_per_large),
            "source sale line must carry the exact purchase lot and its nonzero posted cost");
        let cogs_snapshot: String = sqlx::query_scalar(
            "SELECT line_snapshot FROM native_sale_cogs_provenance WHERE sale_id=?",
        ).bind(&sale.sale_id).fetch_one(&mut conn).await.unwrap();
        let cogs_lines: serde_json::Value = serde_json::from_str(&cogs_snapshot).unwrap();
        assert_eq!(cogs_lines[0]["inventoryId"],lot_id);
        assert_eq!(cogs_lines[0]["costPerLarge"],115.5);
        let tampered_cost = sqlx::query("UPDATE sales_items SET cost_price=0 WHERE invoice_id=?")
            .bind(&sale.sale_id).execute(&mut conn).await;
        assert!(tampered_cost.is_err(),"receipted cost must reject post-sale provenance tampering");
        let tampered_receipt = sqlx::query(
            "UPDATE native_sale_cogs_provenance SET cogs_micros=0 WHERE sale_id=?",
        ).bind(&sale.sale_id).execute(&mut conn).await;
        assert!(tampered_receipt.is_err(),"native COGS receipt must be immutable");
        // This retry has valid inventory and stages both a stock deduction and
        // an unlinked negative shortage. Its reused 043 request nonce fails at
        // final receipt insertion: the caller's rollback must undo everything.
        let mut replay = conn.begin().await.unwrap();
        let late_replay = process_checkout_tx_with_request(
            &mut replay, rejected_lot(&lot_id), 1500.0,
            "f2222222-2222-4222-8222-222222222222",
        ).await.unwrap_err();
        assert!(late_replay.contains("receipt rejected"), "{late_replay}");
        replay.rollback().await.unwrap();
        let committed_after_replay: (i64, i64, f64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM sales_invoices),
                    (SELECT COUNT(*) FROM native_sale_cogs_provenance),
                    (SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?)",
        ).bind(&lot_id).fetch_one(&mut conn).await.unwrap();
        assert_eq!(committed_after_replay, (1, 1, 2.0),
            "failed nonzero-COGS negative sale must neither consume stock nor duplicate a native receipt");
        let after_sale: f64 = sqlx::query_scalar(
            "SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?"
        ).bind(&lot_id).fetch_one(&mut conn).await.unwrap();
        assert!((after_sale-2.0).abs()<0.000001);

        let sale_item: i64 = sqlx::query_scalar(
            "SELECT id FROM sales_items WHERE invoice_id=?",
        ).bind(&sale.sale_id).fetch_one(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let sale_return = create_return_tx_with_request(
            &mut tx,
            ReturnPayload {
                invoice_id: sale.sale_id.clone(),
                user_id: "fresh-admin".into(),
                pharmacy_id: Some("fresh-pharmacy".into()),
                shift_id: None,
                refund_method: "patient_account".into(),
                reason: Some("Synthetic costed stock return".into()),
                patient_id: Some("synthetic-patient".into()),
                items: vec![ReturnItem {
                    sale_item_id: Some(sale_item),
                    inventory_id: Some(lot_id.clone()),
                    drug_name: "Synthetic drug".into(),
                    quantity: 1.0,
                    unit_price: 150.0,
                    unit: Some("large".into()),
                }],
            },
            "f3333333-3333-4333-8333-333333333333",
        ).await.unwrap();
        tx.commit().await.unwrap();
        assert!((sale_return.total_refund-150.0).abs()<0.01);
        let reverse_cogs: i64 = sqlx::query_scalar(
            "SELECT cogs_micros FROM native_sale_return_cogs_provenance
             WHERE return_id=? AND pharmacy_id='fresh-pharmacy'",
        ).bind(&sale_return.return_id).fetch_one(&mut conn).await.unwrap();
        assert_eq!(reverse_cogs, 115_500_000, "1 returned large box restores exact COGS");
        let (return_journal, return_snapshot): (String, String) = sqlx::query_as(
            "SELECT journal_id,line_snapshot FROM native_sale_return_cogs_provenance
             WHERE return_id=? AND sale_id=?",
        ).bind(&sale_return.return_id).bind(&sale.sale_id)
          .fetch_one(&mut conn).await.unwrap();
        let returned_lines: serde_json::Value = serde_json::from_str(&return_snapshot).unwrap();
        assert_eq!(returned_lines[0]["inventoryId"], lot_id);
        assert_eq!(returned_lines[0]["originalSaleItemId"], sale_item);
        assert!((returned_lines[0]["costPerLarge"].as_f64().unwrap()-cost_per_large).abs() < 0.000001);
        let return_entries: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT a.code,je.type,CAST(je.amount AS REAL)
             FROM journal_entries je JOIN accounts a ON a.id=je.account_id
             WHERE je.journal_id=? ORDER BY a.code",
        ).bind(&return_journal).fetch_all(&mut conn).await.unwrap();
        assert_eq!(return_entries, vec![
            ("1.1.2".into(),"credit".into(),150.0),
            ("1.1.3".into(),"debit".into(),cost_per_large),
            ("3.1".into(),"debit".into(),150.0),
            ("4.1".into(),"credit".into(),cost_per_large),
        ], "the original lot cost returns to inventory in the same receipted patient refund journal");
        let forged_return_cost = sqlx::query(
            "UPDATE native_sale_return_cogs_provenance SET cogs_micros=0 WHERE return_id=?",
        ).bind(&sale_return.return_id).execute(&mut conn).await;
        assert!(forged_return_cost.is_err(),"original sales-return COGS reversal is immutable");
        let after_sale_return: f64 = sqlx::query_scalar(
            "SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?"
        ).bind(&lot_id).fetch_one(&mut conn).await.unwrap();
        assert!((after_sale_return-3.0).abs()<0.000001);

        // Report-only access never grants purchase-return mutation, and a
        // separate explicitly owned pharmacy cannot claim this source lot.
        for (actor, pharmacy) in [
            ("report-fresh", "fresh-pharmacy"),
            ("owner-other", "other-pharmacy"),
        ] {
            let denied = run_purchase_return_transaction(
                &mut conn,
                PurchaseReturnPayload {
                    purchase_invoice_id: purchase.id.clone(),
                    supplier_id: 1,
                    user_id: actor.into(),
                    pharmacy_id: Some(pharmacy.into()),
                    reason: Some("Cross-role/pharmacy mutation check".into()),
                    refund_method: "credit".into(),
                    items: vec![PurchaseReturnItem {
                        purchase_invoice_item_id: line_id,
                        quantity: 1.0,
                        unit: Some("large".into()),
                    }],
                },
            ).await;
            assert!(denied.is_err(), "{actor} must not return a purchase it cannot modify");
            let unchanged: f64 = sqlx::query_scalar(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?"
            ).bind(&lot_id).fetch_one(&mut conn).await.unwrap();
            assert_eq!(unchanged, 3.0);
        }

        // Supplier payment must precede the first purchase return: 054 rejects
        // suppliers with any existing purchase-return history by design.
        let bank_payment: super::super::supplier_payments_native::SupplierPaymentInput =
            serde_json::from_value(serde_json::json!({
                "supplierId":1, "amount":25.0, "paymentMethod":"bank",
                "date":"2026-10-16", "notes":"Synthetic supplier partial settlement",
                "requestId":"f4444444-4444-4444-8444-444444444444"
            })).unwrap();
        let posted = super::super::supplier_payments_native::post_on_isolated_test_connection(
            &mut conn, "fresh-admin", bank_payment,
        ).await.expect("Genuine single-invoice tenant-owned payable must settle natively");
        let posted_value = serde_json::to_value(&posted).unwrap();
        assert!((posted_value["remainingBalance"].as_f64().unwrap() - (posted_total-25.0)).abs()<0.01);
        let payment_id = posted_value["id"].as_str().unwrap();
        let supplier_receipt: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM native_supplier_payment_receipts
             WHERE id=? AND pharmacy_id='fresh-pharmacy'
               AND invoice_id='integrated-purchase' AND amount_cents=2500
               AND payment_method='bank'",
        ).bind(payment_id).fetch_one(&mut conn).await.unwrap();
        assert_eq!(supplier_receipt,1);

        let blocked_partial_return = run_purchase_return_transaction(
            &mut conn,
            PurchaseReturnPayload {
                purchase_invoice_id: purchase.id.clone(),
                supplier_id: 1,
                user_id: "fresh-admin".into(),
                pharmacy_id: Some("fresh-pharmacy".into()),
                reason: Some("Return original supplier lot after partial payment".into()),
                refund_method: "credit".into(),
                items: vec![PurchaseReturnItem {
                    purchase_invoice_item_id: line_id,
                    quantity: 1.0,
                    unit: Some("large".into()),
                }],
            },
        ).await.unwrap_err();
        assert!(blocked_partial_return.contains("supplier payment history")
            || blocked_partial_return.contains("reconcile its paid portion"),
            "{blocked_partial_return}");
        assert_eq!(sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM purchase_returns WHERE purchase_invoice_id='integrated-purchase'")
            .fetch_one(&mut conn).await.unwrap(),0);
        let stock_at_end: f64 = sqlx::query_scalar(
            "SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?"
        ).bind(&lot_id).fetch_one(&mut conn).await.unwrap();
        assert!((stock_at_end-3.0).abs()<0.000001);
        let payable_at_end: f64 = sqlx::query_scalar(
            "SELECT balance FROM suppliers WHERE id=1"
        ).fetch_one(&mut conn).await.unwrap();
        assert!((payable_at_end - (posted_total-25.0)).abs()<0.01);
        assert!((payable_at_end - 437.0).abs() < 0.000001);
        assert!((4.0 - 2.0 + 1.0 - stock_at_end).abs() < 0.000001,
            "received - sold + sales-return = remaining stock when unsafe supplier return refused");
        assert_eq!(cogs_micros - reverse_cogs, 115_500_000,
            "net realized COGS must equal the one net-sold large box");
        let supplier_ledger: f64 = sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(CASE WHEN type='invoice' THEN amount
               WHEN type='return' THEN -amount ELSE -amount END),0) AS REAL)
             FROM supplier_transactions WHERE supplier_id=1",
        ).fetch_one(&mut conn).await.unwrap();
        assert!((supplier_ledger-payable_at_end).abs()<0.01);
        let supplier_postings: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT type,payment_method,CAST(amount AS REAL)
             FROM supplier_transactions WHERE supplier_id=1 ORDER BY id",
        ).fetch_all(&mut conn).await.unwrap();
        assert_eq!(supplier_postings.len(),2,"original credit invoice and one payment; no unsupported return");
        assert_eq!(supplier_postings.iter().filter(|(kind,_,_)| kind == "invoice").count(),1,
            "sales, sales returns and supplier settlements cannot duplicate a supplier invoice");
        assert_eq!(supplier_postings[0], ("invoice".into(),"credit".into(),posted_total));
        let patient_net: f64 = sqlx::query_scalar(
            "SELECT CAST((SELECT COALESCE(SUM(total_amount),0) FROM sales_invoices
              WHERE id=? AND pharmacy_id='fresh-pharmacy' AND patient_id='synthetic-patient')
             -(SELECT COALESCE(SUM(total_refund),0) FROM returns
              WHERE invoice_id=? AND pharmacy_id='fresh-pharmacy'
                AND status IN ('completed','approved')) AS REAL)"
        ).bind(&sale.sale_id).bind(&sale.sale_id).fetch_one(&mut conn).await.unwrap();
        assert!((patient_net-150.0).abs()<0.000001, "300 credit sale less 150 patient-account refund");

        // A second explicitly owned pharmacy may post to its *own* supplier
        // and lot; native report projections must not infer ownership from
        // the shared catalog or leak these otherwise valid positive rows.
        let mut foreign_payload = fresh_purchase(
            "other-tenant-purchase", "OTHER-TENANT-INVOICE", "credit", "completed",
            vec![fresh_purchase_line("2099-11-30", 2.0, 0.0, None)],
        );
        foreign_payload.user_id = "owner-other".into();
        foreign_payload.pharmacy_id = Some("other-pharmacy".into());
        foreign_payload.supplier_id = 2;
        let mut tx = conn.begin().await.unwrap();
        let foreign_purchase = save_purchase_invoice_tx_checked(&mut tx, foreign_payload, None)
            .await.unwrap();
        assert!((foreign_purchase.total_amount - 231.0).abs() < 0.000001);
        super::super::purchase_posting_provenance::record_purchase_creation(
            &mut tx, "f5555555-5555-4555-8555-555555555555",
            &foreign_purchase.id, "owner-other", "other-pharmacy", 2,
            foreign_purchase.total_amount,
        ).await.unwrap();
        tx.commit().await.unwrap();
        let own_rows = super::super::purchasing_reads_native::run_purchasing_read(
            &mut conn, "report-fresh", "purchases.reports", Some("{}"), None, 20, 0,
        ).await.unwrap();
        let other_rows = super::super::purchasing_reads_native::run_purchasing_read(
            &mut conn, "report-other", "purchases.reports", Some("{}"), None, 20, 0,
        ).await.unwrap();
        assert_eq!(own_rows.len(),1);
        assert_eq!(other_rows.len(),1);
        assert_eq!(own_rows[0]["id"], "integrated-purchase");
        assert_eq!(other_rows[0]["id"], "other-tenant-purchase");
        assert!((other_rows[0]["gross_amount"].as_f64().unwrap()-231.0).abs()<0.000001);
        assert!((other_rows[0]["total_amount"].as_f64().unwrap()-231.0).abs()<0.000001);
        assert!((other_rows[0]["total_selling_amount"].as_f64().unwrap()-300.0).abs()<0.000001);
        let own_lots: f64 = sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(quantity),0) AS REAL) FROM inventory WHERE pharmacy_id='fresh-pharmacy'"
        ).fetch_one(&mut conn).await.unwrap();
        let other_lots: f64 = sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(quantity),0) AS REAL) FROM inventory WHERE pharmacy_id='other-pharmacy'"
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!((own_lots, other_lots), (3.0, 2.0));
        let unbalanced: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM (
               SELECT journal_id FROM journal_entries GROUP BY journal_id
               HAVING ABS(SUM(CASE WHEN type='debit' THEN amount ELSE -amount END))>0.000001
             )",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(unbalanced,0,"all purchase, COGS, refund, and supplier journals must balance");
    }

    #[tokio::test]
    async fn original_nonempty_draft_witness_and_044_nonce_are_atomic_on_replay() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active)
               VALUES('fresh-admin','fresh-admin','owner','fresh-pharmacy',1);
             INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Supplier',0);
             INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
               VALUES(90001,'Regular medicine',150,10,1);",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let nonce = "23456789-abcd-4abc-8abc-123456789abc";
        let raw: super::NativePurchaseRequest = serde_json::from_value(serde_json::json!({
            "id":"new-witness-draft", "supplier_id":1,"status":"draft",
            "invoice_number":"DRAFT-047","invoice_date":"2026-08-12","payment_method":"credit",
            "notes":"original draft","tax_percent":5,
            "cart":[{"id":90001,"quantity":2,"unit_id":1,"expiry_date":"2099-01-01",
              "cost_price":100,"selling_price":150,"bonus_quantity":0,
              "tax_percent":10,"discount_percent":0,"strips_per_box":10}]
        }))
        .unwrap();
        let digest =
            super::super::purchase_posting_provenance::purchase_draft_request_sha256(&raw).unwrap();
        let mut tx = conn.begin().await.unwrap();
        let result = save_purchase_invoice_tx_checked(
            &mut tx,
            raw.with_native_owner("fresh-admin", "fresh-pharmacy"),
            None,
        )
        .await
        .unwrap();
        super::super::purchase_posting_provenance::record_purchase_creation(
            &mut tx,
            nonce,
            &result.id,
            "fresh-admin",
            "fresh-pharmacy",
            1,
            result.total_amount,
        )
        .await
        .unwrap();
        super::super::purchase_posting_provenance::record_purchase_draft_creation(
            &mut tx,
            nonce,
            &result.id,
            "fresh-admin",
            "fresh-pharmacy",
            &digest,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let (receipt_count, witness_count): (i64, i64) = (
            sqlx::query_scalar(
                "SELECT count(*) FROM native_purchase_create_requests WHERE request_id=?",
            )
            .bind(nonce)
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            sqlx::query_scalar(
                "SELECT count(*) FROM native_purchase_draft_create_witnesses WHERE request_id=?",
            )
            .bind(nonce)
            .fetch_one(&mut conn)
            .await
            .unwrap(),
        );
        assert_eq!((receipt_count, witness_count), (1, 1));

        // Distinct draft ID, same request: even a successfully written new
        // source must roll back when 044 rejects the reused original nonce.
        let mut tx = conn.begin().await.unwrap();
        let replay = fresh_purchase(
            "replayed-draft",
            "DRAFT-047-RETRY",
            "credit",
            "draft",
            vec![fresh_purchase_line("2099-01-01", 2.0, 0.0, None)],
        );
        let attempted = save_purchase_invoice_tx_checked(&mut tx, replay, None)
            .await
            .unwrap();
        assert!(
            super::super::purchase_posting_provenance::record_purchase_creation(
                &mut tx,
                nonce,
                &attempted.id,
                "fresh-admin",
                "fresh-pharmacy",
                1,
                attempted.total_amount,
            )
            .await
            .is_err()
        );
        tx.rollback().await.unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM purchase_invoices WHERE id='replayed-draft'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(count, 0, "Ambiguous replay must not create a second draft");
    }

    #[tokio::test]
    async fn native_purchase_rejects_single_container_conversion_without_mutating_stock_or_invoice()
    {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active)
          VALUES ('fresh-admin','fresh-admin','owner','fresh-pharmacy',1);
          INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Supplier',0);
          INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
          VALUES(90001,'DEXATROL EYE/EAR DROPS 5 ML',150,5,1);",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let mut line = fresh_purchase_line("2099-01-01", 1.0, 0.0, None);
        line.strips_per_box = 5;
        let mut valid_line = fresh_purchase_line("2099-01-01", 1.0, 0.0, None);
        valid_line.strips_per_box = 1;
        let mut tx = conn.begin().await.unwrap();
        let error = save_purchase_invoice_tx(
            &mut tx,
            fresh_purchase(
                "single-container-invalid",
                "BOTTLE-1",
                "credit",
                "draft",
                vec![line],
            ),
        )
        .await
        .unwrap_err();
        assert!(
            error.contains("Single-container purchase conversion"),
            "{error}"
        );
        tx.rollback().await.unwrap();
        let invoices: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM purchase_invoices")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let stock: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM inventory")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!((invoices, stock), (0, 0));
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(
            &mut tx,
            fresh_purchase(
                "single-container-valid",
                "BOTTLE-2",
                "credit",
                "draft",
                vec![valid_line],
            ),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let factor: i64 =
            sqlx::query_scalar("SELECT large_to_medium FROM master_drugs WHERE id=90001")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(factor, 1);
    }

    #[tokio::test]
    async fn stale_purchase_invoice_state_cannot_recreate_or_downgrade_posted_records() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql("INSERT INTO users(id,username,role,pharmacy_id,is_active) VALUES ('fresh-admin','fresh-admin','owner','fresh-pharmacy',1); INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Supplier',0); INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small) VALUES(90001,'Drug',150,10,1);")
            .execute(&mut conn).await.unwrap();

        let purchase = |id: &str, status: &str| {
            fresh_purchase(
                id,
                "INV-1",
                "credit",
                status,
                vec![fresh_purchase_line("2099-01-01", 4.0, 0.0, None)],
            )
        };

        // A deleted draft must never be re-created by a stale edit whose JS
        // preflight previously saw an existing invoice.
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, purchase("deleted-draft", "draft"))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        sqlx::query("DELETE FROM purchase_invoice_items WHERE invoice_id = 'deleted-draft'")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("DELETE FROM purchase_invoices WHERE id = 'deleted-draft'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let missing = save_purchase_invoice_tx_checked(
            &mut tx,
            purchase("deleted-draft", "completed"),
            Some("draft"),
        )
        .await;
        assert!(missing.unwrap_err().contains("reload"));
        tx.rollback().await.unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM purchase_invoices WHERE id = 'deleted-draft'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(count, 0);

        // An edit of a completed invoice must not be silently accepted as
        // a draft save even when its original JS preflight is stale.
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, purchase("posted", "completed"))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let before_stock: f64 =
            sqlx::query_scalar("SELECT CAST(SUM(quantity) AS REAL) FROM inventory")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let before_balance: f64 =
            sqlx::query_scalar("SELECT CAST(balance AS REAL) FROM suppliers WHERE id = 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let before_journals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let stale_draft =
            save_purchase_invoice_tx_checked(&mut tx, purchase("posted", "draft"), Some("draft"))
                .await;
        assert!(stale_draft.unwrap_err().contains("reload"));
        tx.rollback().await.unwrap();
        let current_status: String =
            sqlx::query_scalar("SELECT status FROM purchase_invoices WHERE id = 'posted'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let after_stock: f64 =
            sqlx::query_scalar("SELECT CAST(SUM(quantity) AS REAL) FROM inventory")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let after_balance: f64 =
            sqlx::query_scalar("SELECT CAST(balance AS REAL) FROM suppliers WHERE id = 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let after_journals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(current_status, "completed");
        assert_eq!(
            (after_stock, after_balance, after_journals),
            (before_stock, before_balance, before_journals)
        );

        let mut tx = conn.begin().await.unwrap();
        let stale_edit = save_purchase_invoice_tx_checked(
            &mut tx,
            purchase("posted", "completed"),
            Some("draft"),
        )
        .await;
        assert!(stale_edit.is_err());
        tx.rollback().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let downgrade = save_purchase_invoice_tx_checked(
            &mut tx,
            purchase("posted", "draft"),
            Some("completed"),
        )
        .await;
        assert!(downgrade
            .unwrap_err()
            .contains("cannot be saved as a draft"));
        tx.rollback().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx_checked(
            &mut tx,
            purchase("posted", "completed"),
            Some("completed")
        )
        .await
        .is_ok());
        tx.commit().await.unwrap();
    }

    #[tokio::test]
    async fn consumed_purchase_edits_preserve_sales_costs_and_post_only_deltas() {
        for payment in ["cash", "credit"] {
            let mut conn = current_fresh_schema().await;
            sqlx::raw_sql("INSERT INTO users(id,username,role,pharmacy_id,is_active) VALUES ('fresh-admin','fresh-admin','owner','fresh-pharmacy',1); INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Supplier',0); INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small) VALUES(90001,'Drug',150,10,1);")
                .execute(&mut conn).await.unwrap();
            let purchase = |quantity, line_id| {
                fresh_purchase(
                    "guarded",
                    "N1",
                    payment,
                    "completed",
                    vec![fresh_purchase_line("2099-01-01", quantity, 0.0, line_id)],
                )
            };
            let mut tx = conn.begin().await.unwrap();
            save_purchase_invoice_tx(&mut tx, purchase(10.0, None))
                .await
                .unwrap();
            tx.commit().await.unwrap();
            let line = sqlx::query(
                "SELECT id,inventory_id FROM purchase_invoice_items WHERE invoice_id='guarded'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap();
            let line_id: i64 = line.try_get("id").unwrap();
            let inventory_id: String = line.try_get("inventory_id").unwrap();
            let mut tx = conn.begin().await.unwrap();
            let sale = process_checkout_tx(
                &mut tx,
                CheckoutPayload {
                    pharmacy_id: "fresh-pharmacy".into(),
                    user_id: "fresh-admin".into(),
                    patient_id: None,
                    shift_id: None,
                    source_draft_id: None,
                    payment_method: "cash".into(),
                    status: "completed".into(),
                    check_number: None,
                    total_discount: 0.0,
                    additional_fees: 0.0,
                    points_to_redeem: 0,
                    items: vec![CheckoutItem {
                        drug_id: 90001,
                        inventory_id: Some(inventory_id.clone()),
                        quantity_sold: 4.0,
                        unit_price: 150.0,
                        item_discount_percent: 0.0,
                        selected_unit: "large".into(),
                        is_negative: false,
                    }],
                },
                600.0,
            )
            .await
            .unwrap();
            tx.commit().await.unwrap();
            let old_cash: f64 = sqlx::query_scalar("SELECT CAST(COALESCE(SUM(amount),0) AS REAL) FROM cash_movements WHERE notes='Purchase invoice [id=guarded]'").fetch_one(&mut conn).await.unwrap();
            sqlx::query("UPDATE shifts SET status='closed'")
                .execute(&mut conn)
                .await
                .unwrap();
            for (qty, expected) in [(8.0, 4.0), (12.0, 8.0), (4.0, 0.0)] {
                let mut payload = purchase(qty, Some(line_id));
                payload.cart[0].selling_price = Some(160.0);
                payload.notes = Some("corrected".into());
                let mut tx = conn.begin().await.unwrap();
                save_purchase_invoice_tx(&mut tx, payload).await.unwrap();
                tx.commit().await.unwrap();
                let stock: f64 =
                    sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?")
                        .bind(&inventory_id)
                        .fetch_one(&mut conn)
                        .await
                        .unwrap();
                assert!((stock - expected).abs() < 0.000_001);
                let still_linked: String = sqlx::query_scalar(
                    "SELECT inventory_id FROM purchase_invoice_items WHERE id=?",
                )
                .bind(line_id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
                assert_eq!(still_linked, inventory_id);
            }
            let cost: f64 = sqlx::query_scalar(
                "SELECT CAST(cost_price AS REAL) FROM sales_items WHERE invoice_id=?",
            )
            .bind(&sale.sale_id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
            assert!((cost - 115.5).abs() < 0.000_001);
            let invoice_journals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals WHERE description='Purchase invoice [id=guarded]'").fetch_one(&mut conn).await.unwrap();
            assert_eq!(invoice_journals, 1);
            let original_cash: f64 = sqlx::query_scalar("SELECT CAST(COALESCE(SUM(amount),0) AS REAL) FROM cash_movements WHERE notes='Purchase invoice [id=guarded]'").fetch_one(&mut conn).await.unwrap();
            assert_eq!(original_cash, old_cash);
            let edit_net: f64 = sqlx::query_scalar("SELECT CAST(SUM(CASE WHEN je.type='debit' THEN je.amount ELSE -je.amount END) AS REAL) FROM journal_entries je JOIN daily_journals dj ON dj.id=je.journal_id WHERE dj.description='Purchase edit [id=guarded]'").fetch_one(&mut conn).await.unwrap();
            assert!(edit_net.abs() < 0.000_001);
            let supplier: f64 =
                sqlx::query_scalar("SELECT CAST(balance AS REAL) FROM suppliers WHERE id=1")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert!((supplier - if payment == "credit" { 462.0 } else { 0.0 }).abs() < 0.000_001);
            if payment == "cash" {
                let adjustments: f64 = sqlx::query_scalar("SELECT CAST(SUM(CASE WHEN type='disbursement' THEN amount ELSE -amount END) AS REAL) FROM cash_movements WHERE notes='Purchase edit [id=guarded]'").fetch_one(&mut conn).await.unwrap();
                assert!((adjustments + 693.0).abs() < 0.000_001);
                let old_shift_adjustments: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cash_movements cm JOIN shifts s ON s.id=cm.shift_id WHERE cm.notes='Purchase edit [id=guarded]' AND s.status='closed'").fetch_one(&mut conn).await.unwrap();
                assert_eq!(old_shift_adjustments, 0);
            }
            // A replay has no new accounting effect, and failed changes roll back entirely.
            let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            let mut tx = conn.begin().await.unwrap();
            save_purchase_invoice_tx(&mut tx, purchase(4.0, Some(line_id)))
                .await
                .unwrap();
            tx.commit().await.unwrap();
            for case in 0..5 {
                let mut invalid = purchase(4.0, Some(line_id));
                match case {
                    0 => invalid.cart[0].quantity = 3.5,
                    1 => invalid.cart[0].cost_price = 110.0,
                    2 => invalid.cart[0].strips_per_box = 12,
                    3 => invalid.cart[0].expiry_date = Some("2099-02-01".into()),
                    _ => {
                        invalid.payment_method =
                            Some(if payment == "cash" { "credit" } else { "cash" }.into())
                    }
                }
                let mut tx = conn.begin().await.unwrap();
                assert!(save_purchase_invoice_tx(&mut tx, invalid).await.is_err());
                tx.rollback().await.unwrap();
            }
            let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(before, after);
            sqlx::raw_sql("CREATE TRIGGER reject_edit_audit BEFORE INSERT ON activity_log WHEN NEW.action='EDIT_COMPLETED_PURCHASE' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").execute(&mut conn).await.unwrap();
            let mut tx = conn.begin().await.unwrap();
            assert!(
                save_purchase_invoice_tx(&mut tx, purchase(5.0, Some(line_id)))
                    .await
                    .is_err()
            );
            tx.rollback().await.unwrap();
            let qty: f64 =
                sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?")
                    .bind(&inventory_id)
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(qty, 0.0);
            let mut tx = conn.begin().await.unwrap();
            assert!(delete_purchase_invoice_tx(
                &mut tx,
                "guarded",
                true,
                "fresh-admin",
                Some("fresh-pharmacy")
            )
            .await
            .unwrap_err()
            .contains("تسويات"));
            tx.rollback().await.unwrap();
        }
    }

    #[tokio::test]
    async fn protected_purchase_retains_historical_conversion_without_master_edit_permission() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql("INSERT INTO users(id,username,role,pharmacy_id,is_active) VALUES ('fresh-admin','fresh-admin','owner','fresh-pharmacy',1); INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Supplier',0); INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small) VALUES(90001,'Drug',150,10,1);")
            .execute(&mut conn).await.unwrap();
        let purchase = |quantity, line_id| {
            fresh_purchase(
                "conversion-history",
                "N1",
                "credit",
                "completed",
                vec![fresh_purchase_line("2099-01-01", quantity, 0.0, line_id)],
            )
        };
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, purchase(10.0, None))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let line_id: i64 = sqlx::query_scalar(
            "SELECT id FROM purchase_invoice_items WHERE invoice_id='conversion-history'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(r#"UPDATE inventory SET quantity=6 WHERE drug_id=90001;
            UPDATE master_drugs SET large_to_medium=12 WHERE id=90001;
            UPDATE users SET role='pharmacist', permissions='{"can_view_purchases":true,"can_modify_unit_conversion":false}' WHERE id='fresh-admin';"#)
            .execute(&mut conn).await.unwrap();
        let mut payload = purchase(12.0, Some(line_id));
        payload.cart[0].selling_price = Some(160.0);
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, payload).await.unwrap();
        tx.commit().await.unwrap();
        let row = sqlx::query("SELECT CAST(quantity AS REAL) AS quantity,strips_per_box,CAST(cost_price AS REAL) AS cost_price,CAST(local_selling_price AS REAL) AS local_selling_price FROM inventory WHERE drug_id=90001").fetch_one(&mut conn).await.unwrap();
        assert_eq!(row.get::<f64, _>("quantity"), 8.0);
        assert_eq!(row.get::<i64, _>("strips_per_box"), 10);
        assert!((row.get::<f64, _>("cost_price") - 115.5).abs() < 0.000_001);
        assert_eq!(row.get::<f64, _>("local_selling_price"), 160.0);
        let master: i64 =
            sqlx::query_scalar("SELECT large_to_medium FROM master_drugs WHERE id=90001")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(master, 12);
        let mut invalid = purchase(12.0, Some(line_id));
        invalid.cart[0].strips_per_box = 12;
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, invalid).await.is_err());
        tx.rollback().await.unwrap();
    }

    #[test]
    fn calculates_checkout_money() {
        let items = vec![
            CheckoutItem {
                drug_id: 1,
                inventory_id: None,
                quantity_sold: 2.0,
                unit_price: 10.0,
                item_discount_percent: 0.0,
                selected_unit: "large".into(),
                is_negative: false,
            },
            CheckoutItem {
                drug_id: 2,
                inventory_id: None,
                quantity_sold: 3.0,
                unit_price: 5.0,
                item_discount_percent: 0.0,
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
            "CREATE TABLE patient_transactions (patient_id TEXT, type TEXT, amount INTEGER, date TEXT, user_id TEXT, notes TEXT)",
            "CREATE TABLE financial_notices (target_type TEXT, target_id TEXT, type TEXT, amount INTEGER, date TEXT, user_id TEXT, reason TEXT)",
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
        sqlx::query("INSERT INTO returns VALUES ('credit-sale', 20, 'patient_account', 'APPROVED'), ('credit-sale', 10, 'cash', 'approved'), ('credit-sale', 50, 'patient_account', 'pending')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO patient_transactions VALUES ('p1', 'payment', 30, '2026-08-01', 'u1', NULL), ('p1', 'adjustment', -10, '2026-08-02', 'u1', 'legacy'), ('p1', 'adjustment', 5, '2026-08-03', 'u1', 'legacy'), ('p1', 'adjustment', -7, '2026-08-04', 'u1', 'paired')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO financial_notices VALUES ('customer', 'p1', 'credit', 7, '2026-08-04', 'u1', 'paired'), ('customer', 'p1', 'debit', 12, '2026-08-05', 'u1', 'imported')")
            .execute(&mut conn)
            .await
            .unwrap();

        let mut tx = conn.begin().await.unwrap();
        let debt = patient_outstanding_debt(&mut tx, "p1").await.unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(debt, 100.0);

        sqlx::query("INSERT INTO financial_notices VALUES ('customer', 'p1', 'credit', 7, '2026-08-04', 'u1', 'paired')")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let debt_with_identical_import = patient_outstanding_debt(&mut tx, "p1").await.unwrap();
        tx.rollback().await.unwrap();
        assert_eq!(debt_with_identical_import, 93.0);
    }

    #[test]
    fn guards_renderer_write_sql() {
        assert!(validate_write_sql("INSERT INTO activity_log VALUES (?, ?, ?)").is_ok());
        assert!(validate_write_sql(
            "INSERT INTO main.\"activity_log\" (user_id, action, details) VALUES (?, ?, ?)"
        )
        .is_ok());
        assert!(validate_write_sql(
            "INSERT OR REPLACE INTO activity_log (id, action) VALUES (1, 'LOGIN')"
        )
        .is_err());
        assert!(validate_write_sql(
            "insert or replace into main.\"activity_log\" (id, action) values (1, 'LOGIN')"
        )
        .is_err());
        assert!(validate_write_sql("INSERT INTO activity_log (id, action) VALUES (1, 'LOGIN') ON CONFLICT(id) DO UPDATE SET action='HIDDEN'").is_err());
        assert!(validate_write_sql("INSERT INTO /*comment*/ activity_log (id, action) VALUES (1, 'LOGIN') ON CONFLICT(id) DO UPDATE SET action='HIDDEN'").is_err());
        assert!(validate_write_sql("INSERT INTO activity_log(id, action) VALUES(1, 'LOGIN') ON/**/CONFLICT(id) DO UPDATE SET action='HIDDEN'").is_err());
        assert!(validate_write_sql("UPDATE users SET full_name = ? WHERE id = ?").is_ok());
        assert!(validate_write_sql("DELETE FROM activity_log WHERE id = ?").is_err());
        assert!(validate_write_sql("UPDATE activity_log SET details = '' WHERE id = ?").is_err());
        assert!(validate_write_sql("BEGIN IMMEDIATE").is_err());
        assert!(validate_write_sql("COMMIT").is_err());
        assert!(validate_write_sql("ROLLBACK").is_err());
        assert!(validate_write_sql("VACUUM").is_err());
        assert!(validate_write_sql("ANALYZE").is_err());
        assert!(validate_write_sql("CREATE TABLE unsafe(id INTEGER)").is_err());
        assert!(validate_write_sql("ALTER TABLE users ADD COLUMN unsafe TEXT").is_err());
        assert!(validate_write_sql("SELECT * FROM users").is_err());
        assert!(validate_write_sql("DELETE FROM users; DROP TABLE users").is_err());
        assert!(validate_write_sql("PRAGMA writable_schema = 1").is_err());
        assert!(validate_write_sql("DELETE FROM _sqlx_migrations WHERE version = 30").is_err());
        assert!(validate_write_sql("UPDATE main.\"_sqlx_migrations\" SET success = 0").is_err());
        assert!(
            validate_write_sql("INSERT INTO sqlite_sequence(name, seq) VALUES ('users', 0)")
                .is_err()
        );
        assert!(validate_write_sql("DELETE FROM [sqlite_stat1]").is_err());
        assert!(validate_write_sql("UPDATE config SET value = ? WHERE key = ?").is_err());
        assert!(validate_write_sql("INSERT INTO config(key, value) VALUES (?, ?)").is_err());
        assert!(validate_write_sql(
            "INSERT OR REPLACE INTO sync_metadata(table_name, last_synced_at) VALUES (?, ?)"
        )
        .is_err());
        // SQLite accepts comments as whitespace and single-quoted identifiers.
        // A renderer must not use either to bypass the typed protected-table commands.
        assert!(validate_write_sql(
            "INSERT INTO /* obscured */ config (key, value) VALUES ('k', 'v')"
        )
        .is_err());
        assert!(validate_write_sql("UPDATE/**/sync_metadata SET last_synced_at='now'").is_err());
        assert!(validate_write_sql("DELETE FROM 'config'").is_err());
        assert!(
            validate_write_sql("INSERT INTO 'sync_metadata' (table_name) VALUES ('x')").is_err()
        );
        assert!(
            validate_write_sql("INSERT INTO main . config (key, value) VALUES ('k', 'v')").is_err()
        );
        assert!(
            validate_write_sql("INSERT INTO main. config (key, value) VALUES ('k', 'v')").is_err()
        );
        assert!(
            validate_write_sql("UPDATE main . 'sync_metadata' SET last_synced_at = 'today'")
                .is_err()
        );
        assert!(validate_write_sql("DELETE FROM 'activity_log' WHERE id = 1").is_err());
        assert!(validate_write_sql("UPDATE 'main'.'_sqlx_migrations' SET success = 0").is_err());
        assert!(validate_write_sql("INSERT INTO inventory (notes) VALUES ('lot--safe')").is_ok());
        assert!(validate_write_sql(
            "UPDATE users SET full_name = 'something /* literal */' WHERE id = ?"
        )
        .is_ok());
    }

    #[tokio::test]
    async fn sqlite_accepts_quoted_and_spaced_protected_table_targets() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE config (key TEXT, value TEXT)")
            .execute(&mut conn)
            .await
            .unwrap();
        for statement in [
            "INSERT INTO 'config' (key, value) VALUES ('quoted', '1')",
            "INSERT INTO main . config (key, value) VALUES ('spaced', '2')",
            "INSERT INTO main. config (key, value) VALUES ('qualified', '3')",
            "INSERT INTO /* comment */ config (key, value) VALUES ('commented', '4')",
        ] {
            sqlx::query(statement).execute(&mut conn).await.unwrap();
            assert!(validate_write_sql(statement).is_err());
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM config")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 4);
    }

    #[test]
    fn native_transaction_handles_belong_to_the_creating_window() {
        assert!(ensure_transaction_owner("main", "main").is_ok());
        assert!(ensure_transaction_owner("window_1", "window_1").is_ok());
        assert!(ensure_transaction_owner("main", "window_1").is_err());
        assert!(ensure_transaction_owner("window_1", "main").is_err());
    }

    #[tokio::test]
    async fn another_window_cannot_use_or_release_an_active_transaction() {
        let connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        let mut connections = HashMap::new();
        connections.insert(
            "tx-1".into(),
            GuardedTransaction {
                owner_window_label: "main".into(),
                owner_actor_id: "owner".into(),
                started_at: Instant::now(),
                connection,
            },
        );
        assert!(owned_transaction_connection(&mut connections, "tx-1", "window_1").is_err());
        assert!(owned_transaction_connection(&mut connections, "missing", "main").is_err());
        assert!(connections.contains_key("tx-1"));

        let conn = owned_transaction_connection(&mut connections, "tx-1", "main").unwrap();
        sqlx::query("CREATE TEMP TABLE session_guard (id INTEGER)")
            .execute(conn)
            .await
            .unwrap();
        assert!(connections.contains_key("tx-1"));
    }

    #[cfg(not(pharma_security_release))]
    #[tokio::test]
    async fn generic_staff_writes_require_an_active_native_owner() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, pharmacy_id TEXT, is_active INTEGER); INSERT INTO users VALUES ('owner','owner','a',1),('admin','admin','a',1),('inactive','owner','a',0);")
            .execute(&mut conn).await.unwrap();
        assert!(
            authorize_generic_write(&mut conn, "missing", "UPDATE users SET role='owner'")
                .await
                .is_err()
        );
        assert!(
            authorize_generic_write(&mut conn, "inactive", "UPDATE users SET role='owner'")
                .await
                .is_err()
        );
        for table in ["users", "employee_jobs", "drug_interactions"] {
            let sql = format!("DELETE FROM {table}");
            assert!(
                authorize_generic_write(&mut conn, "admin", &sql)
                    .await
                    .is_err(),
                "{table}"
            );
        }
        assert!(
            authorize_generic_write(&mut conn, "owner", "UPDATE users SET role='admin'")
                .await
                .is_ok()
        );
    }

    #[cfg(not(pharma_security_release))]
    #[tokio::test]
    async fn generic_write_scope_preserves_other_pharmacies_and_allows_local_rows() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, pharmacy_id TEXT, is_active INTEGER); INSERT INTO users VALUES ('owner','owner','a',1),('other','admin','b',1); CREATE TABLE inventory (id TEXT PRIMARY KEY, pharmacy_id TEXT, quantity REAL); INSERT INTO inventory VALUES ('a','a',5),('b','b',9);")
            .execute(&mut conn).await.unwrap();
        let sql = "UPDATE inventory SET quantity=0";
        authorize_generic_write(&mut conn, "owner", sql)
            .await
            .unwrap();
        assert!(sqlx::query(sql).execute(&mut conn).await.is_err());
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT SUM(quantity) FROM inventory")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            14.0
        );
        sqlx::query("UPDATE inventory SET quantity=4 WHERE id='a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            sqlx::query("UPDATE inventory SET pharmacy_id='b' WHERE id='a'")
                .execute(&mut conn)
                .await
                .is_err()
        );
        assert!(
            sqlx::query("INSERT OR REPLACE INTO inventory VALUES ('b','a',0)")
                .execute(&mut conn)
                .await
                .is_err()
        );

        authorize_generic_write(&mut conn, "owner", "UPDATE users SET role='owner'")
            .await
            .unwrap();
        assert!(
            sqlx::query("UPDATE users SET role='owner' WHERE id='other'")
                .execute(&mut conn)
                .await
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT role FROM users WHERE id='other'")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            "admin"
        );
    }

    #[tokio::test]
    async fn abandoned_window_rolls_back_only_its_transactions_and_releases_writer_lock() {
        let path = std::env::temp_dir().join(format!("pharma-guard-{}.db", Uuid::new_v4()));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut writer = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE balances (amount INTEGER)")
            .execute(&mut writer)
            .await
            .unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut writer)
            .await
            .unwrap();
        sqlx::query("INSERT INTO balances VALUES (5)")
            .execute(&mut writer)
            .await
            .unwrap();
        let transactions = DbTransactions::default();
        let started_at = Instant::now();
        transactions.connections.lock().await.insert(
            "abandoned".into(),
            GuardedTransaction {
                owner_window_label: "main".into(),
                owner_actor_id: "owner".into(),
                started_at,
                connection: writer,
            },
        );
        let other = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        transactions.connections.lock().await.insert(
            "other".into(),
            GuardedTransaction {
                owner_window_label: "window_1".into(),
                owner_actor_id: "owner".into(),
                started_at,
                connection: other,
            },
        );
        {
            let connections = transactions.connections.lock().await;
            assert!(
                ensure_transaction_actor(connections.get("abandoned").unwrap(), "other-user")
                    .is_err()
            );
            assert!(
                ensure_transaction_actor(connections.get("abandoned").unwrap(), "owner").is_ok()
            );
        }
        transactions
            .rollback_window("main", Instant::now())
            .await
            .unwrap();
        assert!(!transactions
            .connections
            .lock()
            .await
            .contains_key("abandoned"));
        assert!(transactions.connections.lock().await.contains_key("other"));
        let mut next = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut next)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM balances")
                .fetch_one(&mut next)
                .await
                .unwrap(),
            0
        );
        sqlx::query("ROLLBACK").execute(&mut next).await.unwrap();
        next.close().await.unwrap();
        transactions.rollback_all().await.unwrap_err(); // The other test connection did not BEGIN.
        assert!(transactions.connections.lock().await.is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn expired_renderer_transaction_cannot_commit_and_watchdog_releases_sqlite_writer() {
        let path = std::env::temp_dir().join(format!("pharma-expired-tx-{}.db", Uuid::new_v4()));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut writer = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::raw_sql("CREATE TABLE balances(amount INTEGER); BEGIN IMMEDIATE; INSERT INTO balances VALUES(900);")
            .execute(&mut writer).await.unwrap();
        let transactions = DbTransactions::default();
        transactions
            .register(
                "expired".into(),
                GuardedTransaction {
                    owner_window_label: "main".into(),
                    owner_actor_id: "actor".into(),
                    started_at: Instant::now()
                        - MAX_GUARDED_TRANSACTION_AGE
                        - Duration::from_secs(1),
                    connection: writer,
                },
            )
            .await
            .unwrap_err();
        // `register` must fail before ownership starts when transaction took
        // too long to begin; closing it rolls back its uncommitted writes.
        let mut next = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut next)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM balances")
                .fetch_one(&mut next)
                .await
                .unwrap(),
            0
        );
        sqlx::query("ROLLBACK").execute(&mut next).await.unwrap();
        next.close().await.unwrap();

        let mut writer = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::raw_sql("BEGIN IMMEDIATE; INSERT INTO balances VALUES(100);")
            .execute(&mut writer)
            .await
            .unwrap();
        transactions.connections.lock().await.insert(
            "orphan".into(),
            GuardedTransaction {
                owner_window_label: "main".into(),
                owner_actor_id: "actor".into(),
                started_at: Instant::now() - MAX_GUARDED_TRANSACTION_AGE - Duration::from_secs(1),
                connection: writer,
            },
        );
        assert!(transactions
            .finish("orphan", "main", Some("actor"), true)
            .await
            .unwrap_err()
            .contains("expired"));
        assert!(transactions.connections.lock().await.is_empty());

        let mut writer = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::raw_sql("BEGIN IMMEDIATE; INSERT INTO balances VALUES(200);")
            .execute(&mut writer)
            .await
            .unwrap();
        transactions.connections.lock().await.insert(
            "abandoned".into(),
            GuardedTransaction {
                owner_window_label: "main".into(),
                owner_actor_id: "actor".into(),
                started_at: Instant::now() - MAX_GUARDED_TRANSACTION_AGE - Duration::from_secs(1),
                connection: writer,
            },
        );
        transactions.rollback_expired().await.unwrap();
        assert!(transactions.connections.lock().await.is_empty());
        let mut next = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut next)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM balances")
                .fetch_one(&mut next)
                .await
                .unwrap(),
            0
        );
        sqlx::query("ROLLBACK").execute(&mut next).await.unwrap();
        next.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn rollback_only_abort_requires_window_ownership_not_current_license_or_actor() {
        let path = std::env::temp_dir().join(format!("pharma-abort-{}.db", Uuid::new_v4()));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut writer = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::raw_sql("CREATE TABLE ledger (amount INTEGER); BEGIN IMMEDIATE; INSERT INTO ledger VALUES (100);")
            .execute(&mut writer).await.unwrap();
        let transactions = DbTransactions::default();
        transactions
            .register(
                "expiring-tx".into(),
                GuardedTransaction {
                    owner_window_label: "main".into(),
                    owner_actor_id: "cashier".into(),
                    started_at: Instant::now(),
                    connection: writer,
                },
            )
            .await
            .unwrap();
        // A different window cannot abort another window's in-flight write.
        assert!(transactions
            .finish("expiring-tx", "window_2", None, false)
            .await
            .is_err());
        assert!(transactions
            .connections
            .lock()
            .await
            .contains_key("expiring-tx"));
        // Even after logout or license expiry, rollback must release the lock.
        transactions
            .finish("expiring-tx", "main", None, false)
            .await
            .unwrap();
        assert!(transactions.connections.lock().await.is_empty());
        let mut next = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut next)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM ledger")
            .fetch_one(&mut next)
            .await
            .unwrap();
        assert_eq!(count, 0, "aborted transaction must not commit records");
        sqlx::query("ROLLBACK").execute(&mut next).await.unwrap();
        next.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn reset_blocks_both_pending_registration_and_queued_commit() {
        let transactions = DbTransactions::default();
        let started_at = Instant::now();
        let connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        transactions.note_window_reset("main", Instant::now());
        assert!(transactions
            .register(
                "pending".into(),
                GuardedTransaction {
                    owner_window_label: "main".into(),
                    owner_actor_id: "owner".into(),
                    started_at,
                    connection,
                }
            )
            .await
            .is_err());
        assert!(transactions.connections.lock().await.is_empty());

        let started_at = Instant::now();
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE users (id TEXT, role TEXT, pharmacy_id TEXT, is_active INTEGER); INSERT INTO users VALUES ('owner','owner','a',1); BEGIN IMMEDIATE; UPDATE users SET role='admin';")
            .execute(&mut connection).await.unwrap();
        transactions
            .register(
                "registered".into(),
                GuardedTransaction {
                    owner_window_label: "main".into(),
                    owner_actor_id: "owner".into(),
                    started_at,
                    connection,
                },
            )
            .await
            .unwrap();
        transactions.note_window_reset("main", Instant::now());
        assert!(transactions
            .ensure_live(
                transactions
                    .connections
                    .lock()
                    .await
                    .get("registered")
                    .unwrap()
            )
            .is_err());
        let error = transactions
            .finish("registered", "main", Some("owner"), true)
            .await
            .unwrap_err();
        assert!(error.contains("reloaded or closed"));
        assert!(transactions.connections.lock().await.is_empty());
    }

    #[cfg(not(pharma_security_release))]
    #[tokio::test]
    async fn reused_native_read_pool_survives_missing_query_without_poisoning_next_reader() {
        // Ordinary dashboard/stock/report lookups share a native SQLx pool.
        // A failed query must not strand query_only or make subsequent pages fail.
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        {
            let mut connection = pool.acquire().await.unwrap();
            sqlx::raw_sql(
                "CREATE TABLE users (id TEXT, role TEXT, pharmacy_id TEXT, is_active INTEGER);
                INSERT INTO users VALUES ('staff','cashier','ph-a',1);
                CREATE TABLE inventory (id TEXT, quantity INTEGER);
                INSERT INTO inventory VALUES ('lot-a',3);",
            )
            .execute(&mut *connection)
            .await
            .unwrap();
            let rows = select_guarded_on_connection(
                &mut connection,
                "staff",
                "SELECT id, quantity FROM inventory",
                vec![],
            )
            .await
            .unwrap();
            assert_eq!(rows, vec![serde_json::json!({"id":"lot-a","quantity":3})]);
            assert!(select_guarded_on_connection(
                &mut connection,
                "staff",
                "SELECT quantity FROM nonexistent_qa_table",
                vec![]
            )
            .await
            .is_err());
            let query_only: i64 = sqlx::query_scalar("PRAGMA query_only")
                .fetch_one(&mut *connection)
                .await
                .unwrap();
            assert_eq!(
                query_only, 0,
                "a failed pooled read must restore connection flags"
            );
        }
        // The actual pooled connection is acquired a second time, as happens
        // when switching from one application screen to another.
        let mut connection = pool.acquire().await.unwrap();
        let rows = select_guarded_on_connection(&mut connection, "staff",
            "WITH stock AS (SELECT quantity FROM inventory) SELECT SUM(quantity) AS total FROM stock", vec![])
            .await.unwrap();
        assert_eq!(rows, vec![serde_json::json!({"total":3})]);
        assert!(select_guarded_on_connection(
            &mut connection,
            "missing",
            "SELECT id FROM inventory",
            vec![]
        )
        .await
        .is_err());
    }

    #[cfg(not(pharma_security_release))]
    #[tokio::test]
    async fn cancelled_full_guarded_select_allows_subsequent_authorized_write_on_same_pool_connection(
    ) {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        {
            let mut conn = pool.acquire().await.unwrap();
            sqlx::raw_sql(
                "CREATE TABLE users (id TEXT,role TEXT,pharmacy_id TEXT,is_active INTEGER);
                INSERT INTO users VALUES ('owner','owner','a',1);
                CREATE TABLE inventory (id TEXT,pharmacy_id TEXT,quantity REAL);
                INSERT INTO inventory VALUES ('lot','a',5);",
            )
            .execute(&mut *conn)
            .await
            .unwrap();
        }
        let (started, ready) = tokio::sync::oneshot::channel::<()>();
        let reader_pool = pool.clone();
        let read = tokio::spawn(async move {
            let mut conn = reader_pool.acquire().await.unwrap();
            let _ = started.send(());
            select_guarded_on_connection(&mut conn, "owner",
                "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT MAX(x) FROM n", vec![]).await
        });
        ready.await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
        assert!(
            !read.is_finished(),
            "the expensive statement must still be running at cancellation"
        );
        read.abort();

        let quantity = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let mut conn = pool.acquire().await.unwrap();
            authorize_generic_write(
                &mut conn,
                "owner",
                "UPDATE inventory SET quantity=6 WHERE id='lot'",
            )
            .await
            .unwrap();
            execute_guarded_on_connection(
                &mut conn,
                "UPDATE inventory SET quantity=6 WHERE id='lot'",
                vec![],
            )
            .await
            .unwrap();
            sqlx::query_scalar::<_, f64>("SELECT quantity FROM inventory WHERE id='lot'")
                .fetch_one(&mut *conn)
                .await
                .unwrap()
        })
        .await
        .expect("canceled statement must not strand the SQLite worker");
        assert_eq!(quantity, 6.0);
    }

    #[cfg(not(pharma_security_release))]
    #[tokio::test]
    async fn native_reads_allow_ctes_but_cannot_write_and_restore_transaction_mode() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE users (id TEXT, role TEXT, pharmacy_id TEXT, is_active INTEGER); INSERT INTO users VALUES ('owner','owner','local_default',1),('inactive','owner','local_default',0); CREATE TABLE balances (amount INTEGER); INSERT INTO balances VALUES (5); BEGIN IMMEDIATE;")
            .execute(&mut conn).await.unwrap();
        for actor in ["", "missing", "inactive"] {
            assert!(select_guarded_on_connection(
                &mut conn,
                actor,
                "SELECT amount FROM balances",
                vec![]
            )
            .await
            .is_err());
        }
        let rows = select_guarded_on_connection(
            &mut conn,
            "owner",
            "WITH b AS (SELECT amount FROM balances) SELECT amount FROM b",
            vec![],
        )
        .await
        .unwrap();
        assert_eq!(rows, vec![serde_json::json!({"amount":5})]);
        let columns = select_guarded_on_connection(
            &mut conn,
            "owner",
            "SELECT name FROM pragma_table_info(?)",
            vec![serde_json::json!("balances")],
        )
        .await
        .unwrap();
        assert_eq!(columns, vec![serde_json::json!({"name":"amount"})]);
        for sql in [
            "UPDATE balances SET amount=99 RETURNING amount",
            "WITH b AS (SELECT 1) UPDATE balances SET amount=99 RETURNING amount",
            "SELECT amount FROM balances; UPDATE balances SET amount=99",
            "PRAGMA query_only=OFF",
        ] {
            assert!(
                select_guarded_on_connection(&mut conn, "owner", sql, vec![])
                    .await
                    .is_err(),
                "{sql}"
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT amount FROM balances")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap(),
                5
            );
        }
        sqlx::query("UPDATE balances SET amount=6")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("COMMIT").execute(&mut conn).await.unwrap();
    }

    #[cfg(not(pharma_security_release))]
    #[tokio::test]
    async fn generic_guards_preserve_real_schema_scope_triggers_and_fts() {
        let mut conn = current_fresh_schema().await;
        sqlx::query("INSERT INTO users (id,username,role,pharmacy_id,is_active) VALUES ('generic-owner','generic-owner','owner','ph-a',1)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO master_drugs (id,trade_name,trade_name_en) VALUES (90002,'Generic Drug','Generic Drug')")
            .execute(&mut conn).await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut conn)
            .await
            .unwrap();
        for sql in [
            "INSERT INTO inventory (id,drug_id,pharmacy_id,quantity) VALUES ('generic-lot',90002,'ph-a',5)",
            "INSERT OR REPLACE INTO inventory (id,drug_id,pharmacy_id,quantity) VALUES ('generic-lot',90002,'ph-a',6)",
            "INSERT INTO shifts (id,user_id,status) VALUES ('generic-shift','generic-owner','open')",
            "INSERT INTO cash_movements (id,user_id,shift_id,type,category,amount,date) VALUES ('generic-cash','generic-owner','generic-shift','in','other',10,'2026-10-09')",
            "INSERT INTO daily_journals (id,date,description,created_by,total_amount) VALUES ('generic-journal','2026-10-09','test','generic-owner',10)",
            "INSERT INTO expenses (id,user_id,category,amount,date) VALUES ('generic-expense','generic-owner','test',2,'2026-10-09')",
            "INSERT INTO activity_log (user_id,action,details) VALUES ('generic-owner','TEST','test')",
            "UPDATE master_drugs SET trade_name_en='Generic Updated' WHERE id=90002",
        ] {
            authorize_generic_write(&mut conn, "generic-owner", sql).await.unwrap();
            execute_guarded_on_connection(&mut conn, sql, vec![]).await.unwrap();
        }
        sqlx::query("COMMIT").execute(&mut conn).await.unwrap();
        for (table, id) in [
            ("shifts", "generic-shift"),
            ("cash_movements", "generic-cash"),
            ("daily_journals", "generic-journal"),
            ("expenses", "generic-expense"),
        ] {
            assert_eq!(
                sqlx::query_scalar::<_, String>(&format!(
                    "SELECT pharmacy_id FROM {table} WHERE id=?"
                ))
                .bind(id)
                .fetch_one(&mut conn)
                .await
                .unwrap(),
                "ph-a"
            );
        }
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT pharmacy_id FROM activity_log WHERE user_id='generic-owner'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            "ph-a"
        );
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE id='generic-lot'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            6.0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("PRAGMA recursive_triggers")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM master_drugs_fts WHERE master_drugs_fts MATCH 'Updated'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1
        );
    }

    #[test]
    fn guards_transactional_read_sql() {
        assert!(validate_read_sql("SELECT id FROM users WHERE id = ?").is_ok());
        assert!(validate_read_sql("UPDATE users SET username = ?").is_err());
        assert!(validate_read_sql("PRAGMA table_info(users)").is_err());
        assert!(validate_read_sql("SELECT 1; DELETE FROM users").is_err());
    }

    #[cfg(not(pharma_security_release))]
    #[tokio::test]
    async fn renderer_sql_reads_cannot_extract_unowned_patients_via_joins_or_ctes() {
        // Real Windows QA reproduced a tenant-B owner seeing private
        // patient names from tenant-A historical sales. Arbitrary renderer
        // SELECT is not an ownership boundary, including WITH/joins.
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,is_active INTEGER);\
             CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT,phone TEXT);\
             CREATE TABLE patient_allergies(patient_id TEXT,allergen TEXT);\
             CREATE TABLE patient_conditions(patient_id TEXT,condition_name TEXT);\
             CREATE TABLE patient_transactions(patient_id TEXT,amount REAL);\
             CREATE TABLE refill_reminders(patient_id TEXT,note TEXT);\
             CREATE TABLE native_patient_wallet_topup_receipts(patient_id TEXT,amount REAL);\
             CREATE TABLE native_patient_financial_journal_receipts(patient_id TEXT,amount REAL);\
             CREATE TABLE config(key TEXT,value TEXT);\
             INSERT INTO users VALUES('owner-b','owner','tenant-b',1);\
             INSERT INTO patients VALUES('legacy-patient','PRIVATE PATIENT','SECRET PHONE');\
             INSERT INTO patient_allergies VALUES('legacy-patient','SENSITIVE CONDITION');\
             INSERT INTO config VALUES('pharmacy_name','test');\
             CREATE VIEW patient_private_view AS SELECT full_name FROM patients;",
        )
        .execute(&mut conn).await.unwrap();
        // Regression for an already-prepared/cached permissive SQLx read.
        let primed = sqlx::query("SELECT full_name,phone FROM patients")
            .fetch_all(&mut conn).await.unwrap();
        assert_eq!(primed.len(), 1);
        for sql in [
            "SELECT full_name,phone FROM patients",
            "WITH previous AS (SELECT id,full_name FROM patients) SELECT * FROM previous",
            "SELECT c.value,(SELECT phone FROM patients LIMIT 1) FROM config c",
            "SELECT p.full_name,a.allergen FROM patients p LEFT JOIN patient_allergies a ON a.patient_id=p.id",
            "SELECT full_name FROM main.\"patients\"",
            "SELECT full_name FROM patient_private_view",
            "SELECT allergen FROM patient_allergies",
            "SELECT condition_name FROM patient_conditions",
            "SELECT amount FROM patient_transactions",
            "SELECT note FROM refill_reminders",
            "SELECT amount FROM native_patient_wallet_topup_receipts",
            "SELECT amount FROM native_patient_financial_journal_receipts",
        ] {
            assert!(select_guarded_on_connection(&mut conn, "owner-b", sql, vec![]).await.is_err(),
                    "Generic SQL must not disclose tenant-unowned clinical records: {sql}");
        }
        let allowed = select_guarded_on_connection(&mut conn, "owner-b",
            "SELECT value FROM config WHERE key='pharmacy_name'", vec![]).await.unwrap();
        assert_eq!(allowed.len(), 1, "Unrelated reference/config reads must still work");
    }

    #[tokio::test]
    async fn patient_financial_mutation_requires_new_immutable_tenant_witness() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT NOT NULL);\
                       INSERT INTO patients VALUES('legacy','HISTORICAL');\
                       INSERT INTO patients VALUES('new-a','A PATIENT');\
                       INSERT INTO patients VALUES('new-b','B PATIENT');")
            .execute(&mut conn).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/061_native_patient_directory_ownership.sql"))
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256) VALUES('new-a','tenant-a','owner-a',lower(hex(zeroblob(32)))),('new-b','tenant-b','owner-b',lower(hex(zeroblob(32))))")
            .execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        for patient_id in ["legacy", "new-b", "missing"] {
            assert!(super::require_patient_directory_ownership(&mut tx, patient_id, "tenant-a").await.is_err(),
                "A historical, nonexistent or foreign patient must not be changed: {patient_id}");
        }
        assert!(super::require_patient_directory_ownership(&mut tx, "new-a", "tenant-a").await.is_ok());
        assert!(super::require_patient_directory_ownership(&mut tx, "new-a", "local_default").await.is_err());
        tx.rollback().await.unwrap();
        assert!(sqlx::query("UPDATE native_patient_directory_ownership SET pharmacy_id='tenant-b' WHERE patient_id='new-a'")
            .execute(&mut conn).await.is_err(), "Native ownership cannot be reassigned");
        assert!(sqlx::query("DELETE FROM patients WHERE id='new-a'")
            .execute(&mut conn).await.is_err(), "Witnessed patient identity must survive deletion attempts");
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
        sqlx::query("CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, medium_to_small INTEGER)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity INTEGER, local_selling_price REAL, cost_price REAL, expiry_date TEXT, batch_number TEXT, strips_per_box INTEGER, medium_to_small INTEGER, created_at TEXT, updated_at TEXT)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO master_drugs VALUES (4463, 1)")
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
    async fn exclusive_purchase_inventory_rejects_historical_shared_links() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, batch_number TEXT, expiry_date TEXT)",
            "CREATE TABLE purchase_invoices (id TEXT PRIMARY KEY, status TEXT, pharmacy_id TEXT, invoice_number TEXT)",
            "CREATE TABLE purchase_invoice_items (invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, expiry_date TEXT)",
            "INSERT INTO inventory VALUES ('shared', 1, 'ph-1', 'INV-OLD', '2030-01-01')",
            "INSERT INTO purchase_invoices VALUES ('purchase-a', 'completed', 'ph-1', 'INV-OLD'), ('purchase-b', 'completed', 'ph-1', 'INV-OLD')",
            "INSERT INTO purchase_invoice_items VALUES ('purchase-a', 'shared', 1, '2030-01-01'), ('purchase-b', 'shared', 1, '2030-01-01')",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        assert!(
            ensure_exclusive_purchase_inventory(&mut conn, "shared", "purchase-a")
                .await
                .unwrap_err()
                .contains("shared by multiple purchases")
        );
    }

    #[tokio::test]
    async fn exclusive_purchase_inventory_rejects_cross_pharmacy_historical_link() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, batch_number TEXT, expiry_date TEXT)",
            "CREATE TABLE purchase_invoices (id TEXT PRIMARY KEY, status TEXT, pharmacy_id TEXT, invoice_number TEXT)",
            "CREATE TABLE purchase_invoice_items (invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, expiry_date TEXT)",
            "INSERT INTO inventory VALUES ('own-lot', 1, 'ph-a', 'A', '2030-01-01'), ('other-lot', 1, 'ph-b', 'B', '2030-01-01')",
            "INSERT INTO purchase_invoices VALUES ('invoice-a', 'completed', 'ph-a', 'A')",
            "INSERT INTO purchase_invoice_items VALUES ('invoice-a', 'other-lot', 1, '2030-01-01')",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        let error = ensure_exclusive_purchase_inventory(&mut conn, "other-lot", "invoice-a")
            .await
            .unwrap_err();
        assert!(error.contains("another pharmacy"));
        assert!(
            ensure_exclusive_purchase_inventory(&mut conn, "own-lot", "invoice-a")
                .await
                .is_ok()
        );
        assert!(
            ensure_exclusive_purchase_inventory(&mut conn, "absent-lot", "invoice-a")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn deleting_completed_purchase_cannot_debit_cross_pharmacy_linked_stock() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql("INSERT INTO users(id,username,role,pharmacy_id,is_active) VALUES ('fresh-admin','fresh-admin','owner','fresh-pharmacy',1); INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Supplier',0); INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small) VALUES(90001,'Drug',150,10,1);")
            .execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(
            &mut tx,
            fresh_purchase(
                "linked-invoice",
                "INV-LINK",
                "credit",
                "completed",
                vec![fresh_purchase_line("2099-01-01", 5.0, 0.0, None)],
            ),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let inventory_id: String = sqlx::query_scalar(
            "SELECT inventory_id FROM purchase_invoice_items WHERE invoice_id = 'linked-invoice'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        // Simulate a corrupt or historically incorrect inventory link; a
        // pharmacy-A invoice must not reduce pharmacy-B stock.
        sqlx::query("UPDATE inventory SET pharmacy_id = 'other-pharmacy' WHERE id = ?")
            .bind(&inventory_id)
            .execute(&mut conn)
            .await
            .unwrap();
        let quantity_before: f64 =
            sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id = ?")
                .bind(&inventory_id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let error = delete_purchase_invoice_tx(
            &mut tx,
            "linked-invoice",
            true,
            "fresh-admin",
            Some("fresh-pharmacy"),
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(error.contains("another pharmacy"));
        let quantity_after: f64 =
            sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id = ?")
                .bind(&inventory_id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(quantity_before, quantity_after);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM purchase_invoices WHERE id = 'linked-invoice'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn completed_purchase_reduction_and_taxes_update_inventory() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, large_unit TEXT, large_to_medium INTEGER, medium_to_small INTEGER, medium_unit TEXT, small_unit TEXT, barcode TEXT, stop_dealing INTEGER DEFAULT 0, min_limit REAL, reorder_point REAL, has_expiry INTEGER DEFAULT 1)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity INTEGER, local_selling_price REAL, cost_price REAL, expiry_date TEXT, barcode TEXT, batch_number TEXT, strips_per_box INTEGER, medium_to_small INTEGER, created_at TEXT, updated_at TEXT)",
            "CREATE TABLE purchase_invoices (id TEXT PRIMARY KEY, supplier_id INTEGER, pharmacy_id TEXT, user_id TEXT, invoice_number TEXT, invoice_date TEXT, payment_method TEXT, notes TEXT, check_number TEXT, expenses REAL, discount_value REAL, discount_percent REAL, tax_percent REAL, status TEXT, total_amount REAL)",
            "CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT, drug_id INTEGER, quantity INTEGER, unit_id INTEGER, expiry_date TEXT, cost_price REAL, selling_price REAL, bonus_quantity INTEGER, tax_percent REAL, discount_percent REAL, strips_per_box INTEGER, medium_to_small INTEGER, inventory_id TEXT, barcode TEXT)",
            "CREATE TABLE purchase_returns (purchase_invoice_id TEXT, status TEXT)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, pharmacy_id TEXT, status TEXT, created_at TEXT)",
            "CREATE TABLE sales_items (invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold REAL, unit TEXT, is_negative INTEGER DEFAULT 0, large_to_medium REAL, medium_to_small REAL)",
            "CREATE TABLE suppliers (id INTEGER PRIMARY KEY, balance REAL)",
            "CREATE TABLE users (id TEXT PRIMARY KEY, pharmacy_id TEXT, role TEXT, permissions TEXT, is_active INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT)",
            // Match the real schema's payment_method column. The previous
            // abbreviated fixture masked a legacy DEFAULT 'cash' ambiguity.
            "CREATE TABLE supplier_transactions (supplier_id INTEGER, type TEXT, amount REAL, reference_id TEXT, payment_method TEXT DEFAULT 'cash', notes TEXT)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL, pharmacy_id TEXT)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE cash_movements (id TEXT, user_id TEXT, shift_id TEXT, type TEXT, amount REAL, category TEXT, notes TEXT, date TEXT)",
            "CREATE TABLE shifts (id TEXT, user_id TEXT, pharmacy_id TEXT, status TEXT)",
            "CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT)",
            "CREATE TABLE shortages (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER, pharmacy_id TEXT, requested_quantity REAL, status TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::query("INSERT INTO master_drugs (id, medium_to_small) VALUES (4463, 1)")
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
        // This isolated legacy-style test constructs its own minimal schema.
        // Install the REAL forward-only purchase provenance guards before
        // exercising new completed native postings.
        sqlx::raw_sql(include_str!(
            "../../migrations/042_purchase_posting_events.sql"
        ))
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
        sqlx::query("UPDATE master_drugs SET stop_dealing=1")
            .execute(&mut *tx)
            .await
            .unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, purchase(6.0))
            .await
            .unwrap_err()
            .contains("مؤرشف"));
        tx.rollback().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, purchase(6.0))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let native_purchase_proof: (String, i64, i64) = sqlx::query_as(
            "SELECT journal_id,signed_cents,
              json_array_length(line_snapshot)
             FROM native_purchase_posting_events
             WHERE invoice_id='purchase-1' AND event_kind='initial' LIMIT 1",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(native_purchase_proof.1, 6930);
        assert_eq!(native_purchase_proof.2, 1);
        let tamper = sqlx::query("UPDATE daily_journals SET total_amount=1 WHERE id=?")
            .bind(&native_purchase_proof.0)
            .execute(&mut conn)
            .await;
        assert!(
            tamper.is_err(),
            "sealed source journal must reject mutations"
        );
        let delete_entries = sqlx::query("DELETE FROM journal_entries WHERE journal_id=?")
            .bind(&native_purchase_proof.0)
            .execute(&mut conn)
            .await;
        assert!(
            delete_entries.is_err(),
            "sealed journal entries must remain"
        );
        let foreign_claim = sqlx::query(
            "INSERT INTO native_purchase_posting_events
             (event_id,invoice_id,actor_id,pharmacy_id,supplier_id,event_kind,
              journal_id,payment_method,signed_cents,old_total_cents,new_total_cents,line_snapshot)
             SELECT ?,invoice_id,actor_id,'foreign-branch',supplier_id,event_kind,
               journal_id,payment_method,signed_cents,old_total_cents,new_total_cents,line_snapshot
             FROM native_purchase_posting_events LIMIT 1",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .execute(&mut conn)
        .await;
        assert!(
            foreign_claim.is_err(),
            "cross-tenant or duplicate journal evidence cannot be forged"
        );
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
        let unchanged_inventory_quantity: f64 = sqlx::query("SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE drug_id = 4463 AND batch_number = 'PURCHASE-purchase-1'")
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
            "UPDATE inventory SET quantity = 5 WHERE drug_id = 4463 AND batch_number = 'PURCHASE-purchase-1'",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let consumed_inventory_error = save_purchase_invoice_tx(&mut tx, purchase(0.5))
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(consumed_inventory_error.contains("الكمية المستهلكة"));
        let unchanged_invoice_quantity: f64 = sqlx::query("SELECT CAST(quantity AS REAL) AS quantity FROM purchase_invoice_items WHERE invoice_id = 'purchase-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("quantity")
            .unwrap();
        let consumed_inventory_quantity: f64 = sqlx::query("SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE drug_id = 4463 AND batch_number = 'PURCHASE-purchase-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("quantity")
            .unwrap();
        assert_eq!(unchanged_invoice_quantity, 6.0);
        assert_eq!(consumed_inventory_quantity, 5.0);
        sqlx::query(
            "UPDATE inventory SET quantity = 6 WHERE drug_id = 4463 AND batch_number = 'PURCHASE-purchase-1'",
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
            "SELECT COUNT(*) AS total FROM daily_journals WHERE description = 'Purchase invoice [id=purchase-1]'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("total")
        .unwrap();
        assert_eq!(
            reversed_journal_count, 2,
            "completed native purchase journals remain after explicit reversing posts"
        );
        let preserved: (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*),SUM(CASE WHEN event_kind='reverse' THEN 1 ELSE 0 END)
             FROM native_purchase_posting_events WHERE invoice_id='purchase-1'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(preserved, (4, 2));
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
            "SELECT COUNT(*) AS total FROM daily_journals WHERE description = 'Purchase invoice [id=purchase-1]'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("total")
        .unwrap();
        assert_eq!(
            kept_journal_count, 3,
            "sequential protected invoice completions retain all historical journal originals"
        );

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
                "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE drug_id = 4463 AND batch_number = 'PURCHASE-purchase-duplicates' AND expiry_date = ?",
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
            "SELECT st.supplier_id, dj.created_by FROM supplier_transactions st JOIN daily_journals dj ON dj.description = 'Purchase invoice [id=purchase-duplicates]' WHERE st.reference_id = 'purchase-duplicates'",
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
        let unscoped = save_purchase_invoice_tx(&mut tx, legacy_purchase(None, 4.0))
            .await
            .unwrap_err();
        assert!(
            unscoped.contains("tenant-owned"),
            "a NULL historical actor cannot be certified as a new native posting"
        );
        tx.rollback().await.unwrap();
        sqlx::query("UPDATE users SET pharmacy_id = 'local_default' WHERE id = 'admin'")
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
        let legacy = sqlx::query("SELECT COUNT(*) AS rows, CAST(SUM(quantity) AS REAL) AS quantity FROM inventory WHERE drug_id = 4463 AND batch_number = 'PURCHASE-purchase-legacy' AND expiry_date = '2028-01-01'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(legacy.try_get::<i64, _>("rows").unwrap(), 1);
        assert_eq!(legacy.try_get::<f64, _>("quantity").unwrap(), 3.0);
    }

    #[tokio::test]
    async fn purchase_conversion_change_requires_backend_permission() {
        let mut conn = current_fresh_schema().await;
        sqlx::query(
            r#"INSERT INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
               VALUES ('conversion-user', 'conversion-user', 'cashier', 'Conversion User', 'ph-1',
                       '{"can_view_purchases":true,"can_modify_unit_conversion":false}', 1)"#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO suppliers (id, name_ar, balance) VALUES (101, 'Supplier', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO master_drugs
               (id, trade_name, trade_name_en, official_price, large_to_medium, medium_to_small)
             VALUES (90101, 'دواء تحويل', 'CONVERSION DRUG', 100, 10, 1)",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let payload = PurchasePayload {
            id: Some("conversion-draft".into()),
            supplier_id: 101,
            pharmacy_id: Some("ph-1".into()),
            user_id: "conversion-user".into(),
            invoice_number: Some("CONV-1".into()),
            invoice_date: Some("2026-09-27".into()),
            payment_method: Some("credit".into()),
            notes: None,
            check_number: None,
            expenses: 0.0,
            discount_value: 0.0,
            discount_percent: 0.0,
            tax_percent: 0.0,
            status: Some("draft".into()),
            cart: vec![PurchaseItem {
                purchase_invoice_item_id: None,
                id: 90101,
                quantity: 1.0,
                unit_id: None,
                expiry_date: None,
                cost_price: 10.0,
                selling_price: Some(20.0),
                bonus_quantity: 0.0,
                tax_percent: 0.0,
                discount_percent: 0.0,
                strips_per_box: 1,
                barcode: None,
            }],
        };

        let mut tx = conn.begin().await.unwrap();
        let result = save_purchase_invoice_tx(&mut tx, payload).await;
        tx.rollback().await.unwrap();

        assert!(
            result
                .unwrap_err()
                .contains("can_modify_unit_conversion"),
            "backend must enforce conversion permission even when the renderer invokes the command directly"
        );
        let conversion: i64 =
            sqlx::query_scalar("SELECT large_to_medium FROM master_drugs WHERE id = 90101")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(conversion, 10);
    }

    #[tokio::test]
    async fn fresh_schema_purchase_lifecycle_covers_stock_money_returns_and_deletion() {
        let mut conn = current_fresh_schema().await;
        sqlx::query(
            r#"
            INSERT INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
            VALUES ('fresh-admin', 'fresh-admin', 'admin', 'Fresh Admin', 'fresh-pharmacy',
                    '{"can_view_purchases":true,"can_modify_unit_conversion":true}', 1);
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
               large_unit, medium_unit, small_unit, large_to_medium, medium_to_small, reorder_point)
            VALUES
              (90001, 'دواء مخصص', 'CUSTOM FRESH DRUG', 'TEST INGREDIENT', 150, NULL,
               'Box', 'Strip', 'Tablet', 10, 10, 5)
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, status)
            VALUES
              (90001, 'fresh-pharmacy', 7, 'pending'),
              (90001, 'fresh-pharmacy', 7, 'ordered'),
              (90001, 'fresh-pharmacy', 7, NULL),
              (90001, 'fresh-pharmacy', 7, ''),
              (90001, 'other-pharmacy', 7, 'pending')
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
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM shortages WHERE drug_id = 90001 AND pharmacy_id = 'fresh-pharmacy' AND status = 'received'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );

        sqlx::query(
            r#"
            CREATE TRIGGER block_shortage_receipt
            BEFORE UPDATE OF status ON shortages
            WHEN NEW.status = 'received'
            BEGIN
              SELECT RAISE(FAIL, 'blocked shortage receipt');
            END
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let blocked = save_purchase_invoice_tx(
            &mut tx,
            fresh_purchase(
                "blocked-purchase",
                "BLOCKED-PURCHASE",
                "cash",
                "completed",
                vec![fresh_purchase_line("2032-01-01", 11.0, 0.0, None)],
            ),
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(blocked.contains("blocked shortage receipt"));
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM purchase_invoices WHERE id = 'blocked-purchase'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM inventory")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
        sqlx::query("DROP TRIGGER block_shortage_receipt")
            .execute(&mut conn)
            .await
            .unwrap();

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
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM shortages WHERE drug_id = 90001 AND pharmacy_id = 'fresh-pharmacy' AND status = 'received'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            4
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT status FROM shortages WHERE drug_id = 90001 AND pharmacy_id = 'other-pharmacy'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            "pending"
        );
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
        let cash_terms: Vec<String> = sqlx::query_scalar(
            "SELECT payment_method FROM supplier_transactions WHERE reference_id='fresh-cash' ORDER BY id",
        ).fetch_all(&mut conn).await.unwrap();
        assert_eq!(cash_terms, vec!["cash", "cash"]);
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
            WHERE dj.description = 'Purchase invoice [id=fresh-cash]' AND je.type = 'credit'
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
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM activity_log WHERE action = 'COMPLETE_PURCHASE'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM activity_log WHERE action = 'EDIT_COMPLETED_PURCHASE'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1
        );
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
            FROM inventory WHERE batch_number = 'PURCHASE-fresh-cash' ORDER BY expiry_date
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
                "SELECT COUNT(*) FROM cash_movements WHERE category = 'purchases' AND notes = 'Purchase invoice [id=fresh-cash]'",
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
        let missing_native_receipt = run_purchase_return_transaction(
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
        .unwrap_err();
        assert!(missing_native_receipt.contains("042/044"), "{missing_native_receipt}");
        let quantity_after_return: f64 =
            sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id = ?")
                .bind(&edited_cash_inventory_id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(quantity_before_return, quantity_after_return,
            "a cash return against an edited, unreceipted native source must not take stock");
        assert!(cost_before_return >= 0.0);
        assert_eq!(sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM purchase_returns WHERE purchase_invoice_id='fresh-cash'")
            .fetch_one(&mut conn).await.unwrap(),0);
        assert_eq!(sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM cash_movements WHERE category='purchase_return' AND notes='adjusted cash return'")
            .fetch_one(&mut conn).await.unwrap(),0);

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
        let check_ledger_terms: String = sqlx::query_scalar(
            "SELECT payment_method FROM supplier_transactions WHERE type='invoice' AND reference_id='fresh-check'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(check_ledger_terms, "check");

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
        let credit_return_refused = run_purchase_return_transaction(
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
        .unwrap_err();
        assert!(credit_return_refused.contains("042/044"), "{credit_return_refused}");
        assert_eq!(sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM purchase_returns WHERE purchase_invoice_id='fresh-credit'")
            .fetch_one(&mut conn).await.unwrap(),0);

        sqlx::query(
            r#"INSERT INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
               VALUES ('other-admin', 'other-admin', 'admin', 'Other Admin', 'other-pharmacy',
                       '{"can_view_purchases":true}', 1)"#,
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
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE batch_number = 'PURCHASE-fresh-check'",
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
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE batch_number = 'PURCHASE-fresh-keep'",
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
        sqlx::query(
            "INSERT INTO master_drugs (id, trade_name, trade_name_en, barcode, official_price) VALUES (90002, 'OTHER DRUG', 'OTHER DRUG', 'OTHER-CODE', 10)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let mut conflicting_line = fresh_purchase_line("2035-01-01", 1.0, 0.0, None);
        conflicting_line.id = 90_002;
        let conflicting = fresh_purchase(
            "fresh-barcode-conflict",
            "FRESH-BARCODE-CONFLICT",
            "credit",
            "completed",
            vec![conflicting_line],
        );
        let mut tx = conn.begin().await.unwrap();
        assert!(save_purchase_invoice_tx(&mut tx, conflicting)
            .await
            .unwrap_err()
            .contains("Barcode"));
        tx.rollback().await.unwrap();
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
    async fn partial_purchase_receipt_keeps_shortage_active_below_reorder_point() {
        let mut conn = current_fresh_schema().await;
        sqlx::query(
            r#"INSERT INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
               VALUES ('fresh-admin', 'fresh-admin', 'admin', 'Fresh Admin', 'fresh-pharmacy',
                       '{"can_view_purchases":true,"can_modify_unit_conversion":true}', 1)"#,
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
              (id, trade_name, trade_name_en, official_price, large_to_medium, medium_to_small, reorder_point)
            VALUES (90001, 'دواء جزئي', 'PARTIAL DRUG', 25, 1, 1, 5)
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, status) VALUES (90001, 'fresh-pharmacy', 10, 'pending')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO shifts (id, user_id, starting_cash, status) VALUES ('fresh-shift', 'fresh-admin', 0, 'open')")
            .execute(&mut conn)
            .await
            .unwrap();

        let purchase = fresh_purchase(
            "partial-shortage-purchase",
            "PARTIAL-SHORTAGE",
            "cash",
            "completed",
            vec![fresh_purchase_line("2030-01-01", 1.0, 0.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, purchase).await.unwrap();
        tx.commit().await.unwrap();

        let status: String = sqlx::query_scalar(
            "SELECT status FROM shortages WHERE drug_id = 90001 AND pharmacy_id = 'fresh-pharmacy'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(status, "pending");
        let active_stock: f64 = sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(quantity), 0) AS REAL) FROM inventory WHERE drug_id = 90001 AND pharmacy_id = 'fresh-pharmacy' AND (expiry_date IS NULL OR expiry_date >= date('now', 'localtime'))",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(active_stock, 1.0);
    }

    #[tokio::test]
    async fn purchase_receipt_keeps_shortage_active_below_default_reorder_limit() {
        let mut conn = current_fresh_schema().await;
        sqlx::query(
            r#"INSERT INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
               VALUES ('fresh-admin', 'fresh-admin', 'admin', 'Fresh Admin', 'fresh-pharmacy',
                       '{"can_view_purchases":true,"can_modify_unit_conversion":true}', 1)"#,
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
              (id, trade_name, trade_name_en, official_price, large_to_medium, medium_to_small,
               min_limit, reorder_point)
            VALUES (90001, 'دواء افتراضي', 'DEFAULT LIMIT DRUG', 25, 1, 1, 0, 0)
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, status) VALUES (90001, 'fresh-pharmacy', 10, 'pending')",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let purchase = fresh_purchase(
            "default-limit-shortage-purchase",
            "DEFAULT-LIMIT-SHORTAGE",
            "credit",
            "completed",
            vec![fresh_purchase_line("2030-01-01", 5.0, 0.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, purchase).await.unwrap();
        tx.commit().await.unwrap();

        let status: String = sqlx::query_scalar(
            "SELECT status FROM shortages WHERE drug_id = 90001 AND pharmacy_id = 'fresh-pharmacy'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(status, "pending");
    }

    #[tokio::test]
    async fn purchase_receipt_keeps_shortage_active_below_recent_sales_demand() {
        let mut conn = current_fresh_schema().await;
        sqlx::query(
            r#"INSERT INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
               VALUES ('fresh-admin', 'fresh-admin', 'admin', 'Fresh Admin', 'fresh-pharmacy',
                       '{"can_view_purchases":true,"can_modify_unit_conversion":true}', 1)"#,
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
              (id, trade_name, trade_name_en, official_price, large_to_medium, medium_to_small, reorder_point)
            VALUES (90001, 'دواء طلب حديث', 'RECENT DEMAND DRUG', 25, 1, 1, 2)
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, status) VALUES (90001, 'fresh-pharmacy', 10, 'pending')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO sales_invoices
              (id, pharmacy_id, user_id, total_amount, payment_method, status, created_at)
            VALUES ('recent-demand-sale', 'fresh-pharmacy', 'fresh-admin', 80, 'cash', 'completed', CURRENT_TIMESTAMP)
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO sales_items
              (invoice_id, drug_id, quantity_sold, unit_price, unit, is_negative, large_to_medium, medium_to_small)
            VALUES ('recent-demand-sale', 90001, 8, 10, 'large', 0, 1, 1)
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let purchase = fresh_purchase(
            "recent-demand-shortage-purchase",
            "RECENT-DEMAND-SHORTAGE",
            "credit",
            "completed",
            vec![fresh_purchase_line("2030-01-01", 5.0, 0.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, purchase).await.unwrap();
        tx.commit().await.unwrap();

        let status: String = sqlx::query_scalar(
            "SELECT status FROM shortages WHERE drug_id = 90001 AND pharmacy_id = 'fresh-pharmacy'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(status, "pending");
    }

    #[tokio::test]
    async fn purchase_receipt_recovers_shortage_with_historical_small_unit_alias_demand() {
        let mut conn = current_fresh_schema().await;
        sqlx::query(
            r#"INSERT INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
               VALUES ('fresh-admin', 'fresh-admin', 'admin', 'Fresh Admin', 'fresh-pharmacy',
                       '{"can_view_purchases":true,"can_modify_unit_conversion":true}', 1)"#,
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
              (id, trade_name, trade_name_en, official_price, large_unit, medium_unit, small_unit,
               large_to_medium, medium_to_small, min_limit, reorder_point)
            VALUES (90001, 'دواء وحدات قديمة', 'LEGACY UNIT DRUG', 25, 'Box', 'Custom Strip', 'Custom Small',
                    10, 10, 0, 0)
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, status) VALUES (90001, 'fresh-pharmacy', 11, 'pending')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO sales_invoices
              (id, pharmacy_id, user_id, total_amount, payment_method, status, created_at)
            VALUES ('legacy-small-demand-sale', 'fresh-pharmacy', 'fresh-admin', 100, 'cash', 'completed', CURRENT_TIMESTAMP)
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            r#"
            INSERT INTO sales_items
              (invoice_id, drug_id, quantity_sold, unit_price, unit, is_negative, large_to_medium, medium_to_small)
            VALUES ('legacy-small-demand-sale', 90001, 100, 1, 'Tablet', 0, 10, 10)
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let purchase = fresh_purchase(
            "legacy-small-shortage-purchase",
            "LEGACY-SMALL-SHORTAGE",
            "credit",
            "completed",
            vec![fresh_purchase_line("2030-01-01", 11.0, 0.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        save_purchase_invoice_tx(&mut tx, purchase).await.unwrap();
        tx.commit().await.unwrap();

        let status: String = sqlx::query_scalar(
            "SELECT status FROM shortages WHERE drug_id = 90001 AND pharmacy_id = 'fresh-pharmacy'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(status, "received");
    }

    #[tokio::test]
    async fn purchase_save_cannot_replace_another_pharmacy_draft() {
        let mut conn = current_fresh_schema().await;
        sqlx::query(
            r#"INSERT INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
               VALUES
                 ('fresh-admin', 'fresh-admin', 'admin', 'Fresh Admin', 'fresh-pharmacy',
                  '{"can_view_purchases":true,"can_modify_unit_conversion":true}', 1),
                 ('other-admin', 'other-admin', 'admin', 'Other Admin', 'other-pharmacy',
                  '{"can_view_purchases":true,"can_modify_unit_conversion":true}', 1)"#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO suppliers (id, name_ar, balance) VALUES (1, 'Fresh Supplier', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO master_drugs (id, trade_name, trade_name_en, official_price, large_to_medium, medium_to_small) VALUES (90001, 'دواء', 'DRUG', 150, 10, 10)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO purchase_invoices (id, supplier_id, pharmacy_id, user_id, invoice_number, invoice_date, payment_method, status) VALUES ('foreign-draft', 1, 'other-pharmacy', 'other-admin', 'FOREIGN', '2026-08-12', 'credit', 'draft')",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let payload = fresh_purchase(
            "foreign-draft",
            "TAKEOVER",
            "credit",
            "draft",
            vec![fresh_purchase_line("2030-01-01", 1.0, 0.0, None)],
        );
        let mut tx = conn.begin().await.unwrap();
        let error = save_purchase_invoice_tx(&mut tx, payload)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();

        assert!(
            error.contains("another pharmacy"),
            "unexpected error: {error}"
        );
        let row = sqlx::query("SELECT pharmacy_id, user_id, invoice_number FROM purchase_invoices WHERE id = 'foreign-draft'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("pharmacy_id"), "other-pharmacy");
        assert_eq!(row.get::<String, _>("user_id"), "other-admin");
        assert_eq!(row.get::<String, _>("invoice_number"), "FOREIGN");
    }

    #[tokio::test]
    async fn sales_return_unit_math_uses_selected_unit() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, large_to_medium INTEGER, medium_to_small INTEGER, medium_unit TEXT, small_unit TEXT)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE inventory (id TEXT PRIMARY KEY, strips_per_box INTEGER, medium_to_small INTEGER)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO master_drugs (id, large_to_medium, medium_to_small, medium_unit, small_unit) VALUES (4463, 10, 1, 'blister', 'tablet')",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let mut tx = conn.begin().await.unwrap();
        let restock = return_restock_qty(&mut tx, Some(4463), None, 1.0, "medium")
            .await
            .unwrap();
        let restock_strip = return_restock_qty(&mut tx, Some(4463), None, 1.0, "strip")
            .await
            .unwrap();
        let restock_arabic = return_restock_qty(&mut tx, Some(4463), None, 1.0, "شريط")
            .await
            .unwrap();
        let restock_custom = return_restock_qty(&mut tx, Some(4463), None, 1.0, "Blister")
            .await
            .unwrap();
        let returned_in_box =
            return_quantity_in_sale_unit(&mut tx, Some(4463), None, 1.0, "medium", "large")
                .await
                .unwrap();
        let returned_in_custom_small =
            return_quantity_in_sale_unit(&mut tx, Some(4463), None, 1.0, "large", "Tablet")
                .await
                .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(restock, 0.1);
        assert_eq!(restock_strip, 0.1);
        assert_eq!(restock_arabic, 0.1);
        assert_eq!(restock_custom, 0.1);
        assert_eq!(returned_in_box, 0.1);
        assert_eq!(returned_in_custom_small, 10.0);
    }

    #[tokio::test]
    async fn sales_return_rejects_finalized_header_understating_historical_line_refunds() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, no_return INTEGER, large_to_medium INTEGER, medium_to_small INTEGER, medium_unit TEXT, small_unit TEXT)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, pharmacy_id TEXT, drug_id INTEGER, batch_number TEXT, expiry_date TEXT, quantity REAL, unit_price REAL, local_selling_price REAL, cost_price REAL, strips_per_box INTEGER, medium_to_small INTEGER, created_at TEXT, updated_at TEXT)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT, pharmacy_id TEXT, total_amount REAL, discount_amount REAL, payment_method TEXT, status TEXT, points_earned INTEGER DEFAULT 0, points_redeemed INTEGER DEFAULT 0, loyalty_discount_amount REAL DEFAULT 0, user_id TEXT)",
            "CREATE TABLE users (id TEXT PRIMARY KEY, pharmacy_id TEXT, role TEXT, permissions TEXT, is_active INTEGER DEFAULT 1)",
            "CREATE TABLE shifts (id TEXT, user_id TEXT, pharmacy_id TEXT, status TEXT, start_time TEXT)",
            "CREATE TABLE patients (id TEXT PRIMARY KEY, wallet_balance REAL, points_balance REAL DEFAULT 0)",
            "CREATE TABLE sales_items (id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold REAL, unit_price REAL, unit TEXT, cost_price REAL, large_to_medium INTEGER DEFAULT 1, medium_to_small INTEGER DEFAULT 1)",
            "CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, pharmacy_id TEXT, shift_id TEXT, reason TEXT, total_refund REAL, refund_method TEXT, status TEXT)",
            "CREATE TABLE return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT, drug_id INTEGER, drug_name TEXT, quantity_returned REAL, unit_price REAL, sale_item_id INTEGER, unit TEXT DEFAULT 'large', total_price REAL)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL, pharmacy_id TEXT)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT)",
            "CREATE TABLE patient_transactions (id TEXT PRIMARY KEY, patient_id TEXT, user_id TEXT, type TEXT, amount REAL, payment_method TEXT, notes TEXT, date TEXT)",
            "CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, details TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::raw_sql(include_str!(
            "../../migrations/043_native_sales_cogs_provenance.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(
            r#"
            INSERT INTO users(id,pharmacy_id,role,permissions)
              VALUES('return-actor','ph-1','admin','{"can_view_returns":true}');
            INSERT INTO master_drugs(id,trade_name,no_return,large_to_medium,medium_to_small)
              VALUES(42,'Drug',0,1,1);
            INSERT INTO accounts(id,code)
              VALUES(6,'1.1.1'),(8,'1.1.2'),(9,'3.1'),(10,'1.1.3'),(11,'4.1');
            INSERT INTO inventory(id,pharmacy_id,drug_id,batch_number,quantity,
              local_selling_price,cost_price,strips_per_box,medium_to_small)
              VALUES('historical-sale-lot','ph-1',42,'sale-lot',0,100,40,1,1);
            INSERT INTO sales_invoices(id,pharmacy_id,total_amount,discount_amount,
              payment_method,status,points_earned)
              VALUES('historical-sale','ph-1',100,0,'cash','completed',0);
            INSERT INTO sales_items(id,invoice_id,inventory_id,drug_id,quantity_sold,
              unit_price,unit,cost_price,large_to_medium,medium_to_small)
              VALUES(10,'historical-sale','historical-sale-lot',42,1,100,'large',40,1,1);
            -- The previous finalized cash payout follows the historical line's
            -- 80 amount, but its parent claims only 20 was refunded.
            INSERT INTO returns(id,invoice_id,user_id,pharmacy_id,total_refund,
              refund_method,status)
              VALUES('old-sale-return','historical-sale','return-actor','ph-1',
                20,'cash','completed');
            INSERT INTO return_items(return_id,inventory_id,drug_id,drug_name,
              quantity_returned,unit_price,sale_item_id,unit,total_price)
              VALUES('old-sale-return','historical-sale-lot',42,'Drug',
                0.5,100,10,'large',80);
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let request = || ReturnPayload {
            invoice_id: "historical-sale".into(),
            user_id: "return-actor".into(),
            pharmacy_id: Some("ph-1".into()),
            shift_id: None,
            refund_method: "cash".into(),
            reason: None,
            patient_id: None,
            items: vec![ReturnItem {
                sale_item_id: Some(10),
                inventory_id: Some("historical-sale-lot".into()),
                drug_name: "Drug".into(),
                quantity: 0.5,
                unit_price: 100.0,
                unit: Some("large".into()),
            }],
        };
        let mut tx = conn.begin().await.unwrap();
        let error = create_return_tx(&mut tx, request()).await.unwrap_err();
        tx.rollback().await.unwrap();
        assert!(error.contains("original native 043"), "{error}");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM returns")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE id='historical-sale-lot'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0.0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );

        // Correcting a mutable historical amount does not authenticate the
        // original sale. Never mint a new 043 return solely because the old
        // source's amounts happen to reconcile after hand editing this fixture.
        sqlx::query("UPDATE returns SET total_refund=80 WHERE id='old-sale-return'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let denied = create_return_tx(&mut tx, request()).await.unwrap_err();
        tx.rollback().await.unwrap();
        assert!(denied.contains("original native 043"), "{denied}");
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM returns")
            .fetch_one(&mut conn).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn sales_return_restores_original_batch_and_tracks_remaining() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, no_return INTEGER, large_to_medium INTEGER, medium_to_small INTEGER, medium_unit TEXT, small_unit TEXT)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, pharmacy_id TEXT, drug_id INTEGER, batch_number TEXT, expiry_date TEXT, quantity REAL, unit_price REAL, local_selling_price REAL, cost_price REAL, strips_per_box INTEGER, medium_to_small INTEGER, created_at TEXT, updated_at TEXT)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT, pharmacy_id TEXT, total_amount REAL, discount_amount REAL, payment_method TEXT, status TEXT, points_earned INTEGER DEFAULT 0, points_redeemed INTEGER DEFAULT 0, loyalty_discount_amount REAL DEFAULT 0, user_id TEXT)",
            "CREATE TABLE users (id TEXT PRIMARY KEY, pharmacy_id TEXT, role TEXT, permissions TEXT, is_active INTEGER DEFAULT 1)",
            "CREATE TABLE shifts (id TEXT, user_id TEXT, pharmacy_id TEXT, status TEXT, start_time TEXT)",
            "CREATE TABLE patients (id TEXT PRIMARY KEY, wallet_balance REAL, points_balance REAL DEFAULT 0)",
            "CREATE TABLE sales_items (id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold REAL, unit_price REAL, unit TEXT, cost_price REAL, large_to_medium INTEGER DEFAULT 1, medium_to_small INTEGER DEFAULT 1)",
            "CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, pharmacy_id TEXT, shift_id TEXT, reason TEXT, total_refund REAL, refund_method TEXT, status TEXT)",
            "CREATE TABLE return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT, drug_id INTEGER, drug_name TEXT, quantity_returned INTEGER, unit_price REAL, sale_item_id INTEGER, unit TEXT DEFAULT 'large', total_price REAL)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL, pharmacy_id TEXT)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT)",
            "CREATE TABLE patient_transactions (id TEXT PRIMARY KEY, patient_id TEXT, user_id TEXT, type TEXT, amount REAL, payment_method TEXT, notes TEXT, date TEXT)",
            "CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, details TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::raw_sql(include_str!(
            "../../migrations/043_native_sales_cogs_provenance.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO master_drugs VALUES (4463, 'COLONA', 0, 10, 2, 'blister', 'tablet'), (4464, 'MISSING LOT', 0, 10, 2, 'blister', 'tablet')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO accounts (id, code) VALUES (6, '1.1.1'), (8, '1.1.2'), (9, '3.1'), (10, '1.1.3'), (11, '4.1')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users (id, pharmacy_id, role, permissions) VALUES ('admin', 'ph-1', 'admin', json_object('can_view_returns', 1)), ('denied', 'ph-1', 'pharmacist', '{}')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory VALUES ('batch-2027', 'ph-1', 4463, 'B-27', '2027-08-13', 0, 69, 69, 40, 10, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)").execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO patients VALUES ('patient-1', 0, 100)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/061_native_patient_directory_ownership.sql"))
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256) VALUES('patient-1','ph-1','admin',lower(hex(zeroblob(32))))")
            .execute(&mut conn).await.unwrap();
        sqlx::query(
            "INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, discount_amount, payment_method, status, points_earned) VALUES ('invoice-1', 'patient-1', 'ph-1', 62.1, 6.9, 'cash', 'completed', 62)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sales_items VALUES (1, 'invoice-1', 'batch-2027', 4463, 1, 69, 'large', 40, 10, 2)").execute(&mut conn).await.unwrap();
        seal_test_sale_source_for_return(&mut conn, "invoice-1", "admin").await;

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
        assert!(user_error.contains("active user required"));
        let mut tx = conn.begin().await.unwrap();
        let permission_error = create_return_tx(&mut tx, invalid_return("denied", "ph-1"))
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(permission_error.contains("can_view_returns"));
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

        let mut precision_overage = invalid_return("admin", "ph-1");
        precision_overage.items[0].quantity = 1.004;
        let mut tx = conn.begin().await.unwrap();
        let precision_error = create_return_tx(&mut tx, precision_overage)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(precision_error.contains("exceeds remaining quantity"));

        // A returned unit must not be added to a currently revalued lot at
        // cost 25 while its native COGS-reversal journal debits inventory 40.
        sqlx::query("UPDATE inventory SET cost_price=25 WHERE id='batch-2027'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let return_on_revalued_lot = create_return_tx(
            &mut tx,
            ReturnPayload {
                invoice_id: "invoice-1".into(),
                user_id: "admin".into(),
                pharmacy_id: Some("ph-1".into()),
                shift_id: None,
                refund_method: "cash".into(),
                reason: Some("historical COGS cost must remain conserved".into()),
                patient_id: None,
                items: vec![ReturnItem {
                    sale_item_id: Some(1),
                    inventory_id: Some("batch-2027".into()),
                    drug_name: "COLONA".into(),
                    quantity: 0.2,
                    unit_price: 69.0,
                    unit: Some("large".into()),
                }],
            },
        )
        .await
        .unwrap();
        let returned_lot: String =
            sqlx::query_scalar("SELECT inventory_id FROM return_items WHERE return_id=?")
                .bind(&return_on_revalued_lot.return_id)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        let returned_carrying_cost: f64 =
            sqlx::query_scalar("SELECT cost_price FROM inventory WHERE id=?")
                .bind(&returned_lot)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        let stocked_quantity: f64 = sqlx::query_scalar("SELECT quantity FROM inventory WHERE id=?")
            .bind(&returned_lot)
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        let inventory_debit: f64 = sqlx::query_scalar(
            "SELECT e.amount FROM native_sale_return_cogs_provenance p
             JOIN journal_entries e ON e.journal_id=p.journal_id
             WHERE p.return_id=? AND e.account_id=10 AND e.type='debit'",
        )
        .bind(&return_on_revalued_lot.return_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_ne!(
            returned_lot, "batch-2027",
            "Revalued original stock must not absorb a historical-cost return"
        );
        assert_eq!(returned_carrying_cost, 40.0);
        assert!((stocked_quantity - 0.2).abs() < 0.000_001);
        assert!((inventory_debit - stocked_quantity * returned_carrying_cost).abs() < 0.000_001);
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT quantity FROM inventory WHERE id='batch-2027'")
                .fetch_one(&mut *tx)
                .await
                .unwrap(),
            0.0
        );
        tx.rollback().await.unwrap();
        sqlx::query("UPDATE inventory SET cost_price=40 WHERE id='batch-2027'")
            .execute(&mut conn)
            .await
            .unwrap();

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
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT CAST(points_balance AS INTEGER) FROM patients WHERE id = 'patient-1'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            88
        );

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

        // Legacy releases persisted return_items.quantity_returned in the selected return unit.
        // A prior 1-medium return against a sale recorded in small units must therefore be
        // converted before deciding how much of that sale can still be returned.
        sqlx::query("INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, discount_amount, payment_method, status, points_earned) VALUES ('legacy-unit-return', NULL, 'ph-1', 10, 0, 'cash', 'completed', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price, large_to_medium, medium_to_small) VALUES (9, 'legacy-unit-return', 'batch-2027', 4463, 10, 1, 'small', 40, 10, 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        seal_test_sale_source_for_return(&mut conn, "legacy-unit-return", "admin").await;
        sqlx::query("INSERT INTO returns (id, invoice_id, user_id, pharmacy_id, shift_id, reason, total_refund, refund_method, status) VALUES ('legacy-unit-prior', 'legacy-unit-return', 'admin', 'ph-1', NULL, 'legacy', 2, 'cash', 'approved')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO return_items (return_id, inventory_id, drug_id, drug_name, quantity_returned, unit_price, sale_item_id, unit, total_price) VALUES ('legacy-unit-prior', 'batch-2027', 4463, 'COLONA', 1, 1, 9, 'medium', 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let legacy_over_return = create_return_tx(
            &mut tx,
            ReturnPayload {
                invoice_id: "legacy-unit-return".into(),
                user_id: "admin".into(),
                pharmacy_id: Some("ph-1".into()),
                shift_id: None,
                refund_method: "cash".into(),
                reason: Some("legacy unit remainder".into()),
                patient_id: None,
                items: vec![ReturnItem {
                    sale_item_id: Some(9),
                    inventory_id: Some("batch-2027".into()),
                    drug_name: "COLONA".into(),
                    quantity: 9.0,
                    unit_price: 1.0,
                    unit: Some("small".into()),
                }],
            },
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(legacy_over_return.contains("exceeds remaining quantity"));

        sqlx::query("INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, discount_amount, payment_method, status, points_earned) VALUES ('legacy-null-return', NULL, 'ph-1', 5, 0, 'cash', 'completed', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price, large_to_medium, medium_to_small) VALUES (10, 'legacy-null-return', 'batch-2027', 4463, 5, 1, 'large', 40, 10, 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        seal_test_sale_source_for_return(&mut conn, "legacy-null-return", "admin").await;
        sqlx::query("INSERT INTO returns (id, invoice_id, user_id, pharmacy_id, shift_id, reason, total_refund, refund_method, status) VALUES ('legacy-null-prior', 'legacy-null-return', 'admin', 'ph-1', NULL, 'legacy', 3, 'cash', 'approved')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO return_items (return_id, inventory_id, drug_id, drug_name, quantity_returned, unit_price, sale_item_id, unit, total_price) VALUES ('legacy-null-prior', 'batch-2027', 4463, 'COLONA', 3, 1, NULL, 'large', 3)")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let legacy_null_error = create_return_tx(
            &mut tx,
            ReturnPayload {
                invoice_id: "legacy-null-return".into(),
                user_id: "admin".into(),
                pharmacy_id: Some("ph-1".into()),
                shift_id: None,
                refund_method: "cash".into(),
                reason: Some("legacy unresolved lineage".into()),
                patient_id: None,
                items: vec![ReturnItem {
                    sale_item_id: Some(10),
                    inventory_id: Some("batch-2027".into()),
                    drug_name: "COLONA".into(),
                    quantity: 3.0,
                    unit_price: 1.0,
                    unit: Some("large".into()),
                }],
            },
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(legacy_null_error.contains("Legacy"), "{legacy_null_error}");

        sqlx::query(
            "UPDATE master_drugs SET large_to_medium = 20, medium_to_small = 5 WHERE id = 4463",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE inventory SET strips_per_box = 20, medium_to_small = 5 WHERE id = 'batch-2027'",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("UPDATE returns SET status = 'completed' WHERE invoice_id = 'invoice-1'")
            .execute(&mut conn)
            .await
            .unwrap();

        sqlx::query("INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, discount_amount, payment_method, status, points_earned) VALUES ('invoice-2', NULL, 'ph-1', 10, 0, 'cash', 'delivered', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price, large_to_medium, medium_to_small) VALUES (2, 'invoice-2', 'missing-batch', 4464, 2, 5, 'medium', 30, 10, 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("UPDATE sales_invoices SET status='completed' WHERE id='invoice-2'")
            .execute(&mut conn).await.unwrap();
        seal_test_sale_source_for_return(&mut conn, "invoice-2", "admin").await;
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
        let replacement_lot = sqlx::query("SELECT quantity, local_selling_price, cost_price, expiry_date FROM inventory WHERE drug_id = 4464 AND pharmacy_id = 'ph-1'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let replacement_quantity: f64 = replacement_lot.try_get("quantity").unwrap();
        let replacement_price: f64 = replacement_lot.try_get("local_selling_price").unwrap();
        let replacement_cost: f64 = replacement_lot.try_get("cost_price").unwrap();
        let replacement_expiry: Option<String> = replacement_lot.try_get("expiry_date").unwrap();
        assert!((replacement_quantity - 0.2).abs() < 0.000_001);
        assert!((replacement_price - 50.0).abs() < 0.000_001);
        assert!((replacement_cost - 30.0).abs() < 0.000_001);
        assert!(replacement_expiry.is_none());
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

        sqlx::query("INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, discount_amount, payment_method, status, points_earned) VALUES ('delivery-return', NULL, 'ph-1', 22, 0, 'delivery', 'delivered', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price, large_to_medium, medium_to_small) VALUES (4, 'delivery-return', 'batch-2027', 4463, 1, 20, 'large', 40, 10, 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        sqlx::query("UPDATE sales_invoices SET status = 'completed' WHERE id = 'delivery-return'")
            .execute(&mut *tx)
            .await
            .unwrap();
        let mut pending_delivery = invalid_return("admin", "ph-1");
        pending_delivery.invoice_id = "delivery-return".into();
        pending_delivery.items[0].sale_item_id = Some(4);
        assert!(create_return_tx(&mut tx, pending_delivery)
            .await
            .unwrap_err()
            .contains("تسوية تحصيل"));
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM returns WHERE invoice_id = 'delivery-return'"
            )
            .fetch_one(&mut *tx)
            .await
            .unwrap(),
            0
        );
        tx.rollback().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let delivery_denied = create_return_tx(
            &mut tx,
            ReturnPayload {
                invoice_id: "delivery-return".into(),
                user_id: "admin".into(),
                pharmacy_id: Some("ph-1".into()),
                shift_id: None,
                refund_method: "cash".into(),
                reason: Some("delivery merchandise return".into()),
                patient_id: None,
                items: vec![ReturnItem {
                    sale_item_id: Some(4),
                    inventory_id: Some("batch-2027".into()),
                    drug_name: "COLONA".into(),
                    quantity: 1.0,
                    unit_price: 999.0,
                    unit: Some("large".into()),
                }],
            },
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(delivery_denied.contains("original native 043"), "{delivery_denied}");
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

        sqlx::query("INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, expiry_date, quantity, unit_price, local_selling_price, cost_price, strips_per_box, medium_to_small, created_at, updated_at) VALUES ('cross-branch', 'ph-2', 4464, 'CROSS', '2029-01-01', 0, 10, 10, 30, 10, 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, discount_amount, payment_method, status, points_earned) VALUES ('invoice-3', NULL, 'ph-1', 10, 0, 'cash', 'completed', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price, large_to_medium, medium_to_small) VALUES (3, 'invoice-3', 'cross-branch', 4464, 1, 10, 'large', 30, 10, 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        seal_test_sale_source_for_return(&mut conn, "invoice-3", "admin").await;
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

        // A protected 043 sale payment rail cannot be reclassified to obtain
        // a different refund. The customer may still opt for account credit
        // on this original cash sale without changing its source record.
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
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT CAST(points_balance AS INTEGER) FROM patients WHERE id = 'patient-1'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            76
        );
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

        sqlx::query("INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, discount_amount, payment_method, status, points_earned) VALUES ('rollback-return', NULL, 'ph-1', 10, 0, 'cash', 'completed', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price, large_to_medium, medium_to_small) VALUES (5, 'rollback-return', 'batch-2027', 4463, 1, 10, 'large', 40, 10, 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        seal_test_sale_source_for_return(&mut conn, "rollback-return", "admin").await;
        sqlx::raw_sql("CREATE TRIGGER reject_return_audit BEFORE INSERT ON activity_log WHEN NEW.action='CREATE_RETURN' BEGIN SELECT RAISE(ABORT,'injected return audit failure'); END;")
            .execute(&mut conn)
            .await
            .unwrap();
        let stock_before_audit_failure: f64 =
            sqlx::query_scalar("SELECT quantity FROM inventory WHERE id = 'batch-2027'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let returns_before_audit_failure: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM returns WHERE invoice_id = 'rollback-return'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let journals_before_audit_failure: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let audit_failure = create_return_tx(
            &mut tx,
            ReturnPayload {
                invoice_id: "rollback-return".into(),
                user_id: "admin".into(),
                pharmacy_id: Some("ph-1".into()),
                shift_id: None,
                refund_method: "cash".into(),
                reason: Some("audit rollback".into()),
                patient_id: None,
                items: vec![ReturnItem {
                    sale_item_id: Some(5),
                    inventory_id: Some("batch-2027".into()),
                    drug_name: "COLONA".into(),
                    quantity: 1.0,
                    unit_price: 10.0,
                    unit: Some("large".into()),
                }],
            },
        )
        .await;
        assert!(
            audit_failure.is_err(),
            "return must fail when its audit write fails"
        );
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT quantity FROM inventory WHERE id = 'batch-2027'")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            stock_before_audit_failure
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM returns WHERE invoice_id = 'rollback-return'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            returns_before_audit_failure
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            journals_before_audit_failure
        );

        sqlx::query("DROP TRIGGER reject_return_audit")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, discount_amount, payment_method, status, points_earned) VALUES ('patient-ledger-rollback', 'patient-1', 'ph-1', 10, 0, 'credit', 'completed', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price, large_to_medium, medium_to_small) VALUES (6, 'patient-ledger-rollback', 'batch-2027', 4463, 1, 10, 'large', 40, 10, 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        seal_test_sale_source_for_return(&mut conn, "patient-ledger-rollback", "admin").await;
        sqlx::raw_sql("CREATE TRIGGER reject_patient_refund BEFORE INSERT ON patient_transactions WHEN NEW.type='refund' BEGIN SELECT RAISE(ABORT,'injected patient refund failure'); END;")
            .execute(&mut conn)
            .await
            .unwrap();
        let patient_stock_before: f64 =
            sqlx::query_scalar("SELECT quantity FROM inventory WHERE id = 'batch-2027'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let patient_failure = create_return_tx(
            &mut tx,
            ReturnPayload {
                invoice_id: "patient-ledger-rollback".into(),
                user_id: "admin".into(),
                pharmacy_id: Some("ph-1".into()),
                shift_id: None,
                refund_method: "patient_account".into(),
                reason: Some("patient ledger rollback".into()),
                patient_id: Some("patient-1".into()),
                items: vec![ReturnItem {
                    sale_item_id: Some(6),
                    inventory_id: Some("batch-2027".into()),
                    drug_name: "COLONA".into(),
                    quantity: 1.0,
                    unit_price: 10.0,
                    unit: Some("large".into()),
                }],
            },
        )
        .await;
        assert!(
            patient_failure.is_err(),
            "patient-account return must fail when its patient ledger write fails"
        );
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT quantity FROM inventory WHERE id = 'batch-2027'")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            patient_stock_before
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM returns WHERE invoice_id = 'patient-ledger-rollback'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );

        sqlx::query("INSERT INTO patients VALUES ('loyalty-return-patient', 0, 380)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256) VALUES('loyalty-return-patient','ph-1','admin',lower(hex(zeroblob(32))))")
            .execute(&mut conn).await.unwrap();
        sqlx::query(
            "INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, discount_amount, payment_method, status, points_earned, points_redeemed, loyalty_discount_amount) VALUES ('loyalty-return', 'loyalty-return-patient', 'ph-1', 80, 20, 'cash', 'completed', 80, 200, 20)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price, large_to_medium, medium_to_small) VALUES (20, 'loyalty-return', 'batch-2027', 4463, 2, 50, 'large', 40, 10, 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        seal_test_sale_source_for_return(&mut conn, "loyalty-return", "admin").await;
        let loyalty_return = |reason: &str| ReturnPayload {
            invoice_id: "loyalty-return".into(),
            user_id: "admin".into(),
            pharmacy_id: Some("ph-1".into()),
            shift_id: None,
            refund_method: "cash".into(),
            reason: Some(reason.into()),
            patient_id: Some("loyalty-return-patient".into()),
            items: vec![ReturnItem {
                sale_item_id: Some(20),
                inventory_id: Some("batch-2027".into()),
                drug_name: "COLONA".into(),
                quantity: 1.0,
                unit_price: 50.0,
                unit: Some("large".into()),
            }],
        };
        let mut tx = conn.begin().await.unwrap();
        let partial_loyalty_return = create_return_tx(&mut tx, loyalty_return("half"))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!((partial_loyalty_return.total_refund - 40.0).abs() < 0.000_001);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT CAST(points_balance AS INTEGER) FROM patients WHERE id = 'loyalty-return-patient'")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            440
        );
        // The customer spends the remaining earned points before returning the rest of the earning sale.
        sqlx::query("UPDATE patients SET points_balance = 0 WHERE id = 'loyalty-return-patient'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let full_loyalty_return = create_return_tx(&mut tx, loyalty_return("full"))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!((full_loyalty_return.total_refund - 40.0).abs() < 0.000_001);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT CAST(points_balance AS INTEGER) FROM patients WHERE id = 'loyalty-return-patient'")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            60
        );
    }

    #[tokio::test]
    async fn sales_return_bank_and_wallet_accounting_are_native_and_atomic() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, no_return INTEGER, large_to_medium INTEGER, medium_to_small INTEGER, medium_unit TEXT, small_unit TEXT)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, pharmacy_id TEXT, drug_id INTEGER, batch_number TEXT, expiry_date TEXT, quantity REAL, unit_price REAL, local_selling_price REAL, cost_price REAL, strips_per_box INTEGER, medium_to_small INTEGER, created_at TEXT, updated_at TEXT)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT, pharmacy_id TEXT, total_amount REAL, discount_amount REAL, payment_method TEXT, status TEXT, points_earned INTEGER DEFAULT 0, points_redeemed INTEGER DEFAULT 0, loyalty_discount_amount REAL DEFAULT 0)",
            "CREATE TABLE users (id TEXT PRIMARY KEY, pharmacy_id TEXT, role TEXT, permissions TEXT, is_active INTEGER DEFAULT 1)",
            "CREATE TABLE shifts (id TEXT, user_id TEXT, pharmacy_id TEXT, status TEXT, start_time TEXT)",
            "CREATE TABLE patients (id TEXT PRIMARY KEY, wallet_balance REAL, points_balance REAL DEFAULT 0)",
            "CREATE TABLE sales_items (id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold REAL, unit_price REAL, unit TEXT, cost_price REAL, large_to_medium INTEGER DEFAULT 1, medium_to_small INTEGER DEFAULT 1)",
            "CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, pharmacy_id TEXT, shift_id TEXT, reason TEXT, total_refund REAL, refund_method TEXT, status TEXT)",
            "CREATE TABLE return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT, drug_id INTEGER, drug_name TEXT, quantity_returned REAL, unit_price REAL, sale_item_id INTEGER, unit TEXT DEFAULT 'large', total_price REAL)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL, pharmacy_id TEXT)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT)",
            "CREATE TABLE patient_transactions (id TEXT PRIMARY KEY, patient_id TEXT, user_id TEXT, type TEXT, amount REAL, payment_method TEXT, notes TEXT, date TEXT)",
            "CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, details TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::raw_sql(include_str!(
            "../../migrations/043_native_sales_cogs_provenance.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO accounts (id, code) VALUES (6,'1.1.1'),(8,'1.1.2'),(9,'3.1'),(10,'1.1.3'),(11,'4.1'),(12,'1.1.4'),(13,'2.2')")
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO trial_balance_settings (category, account_id) VALUES ('bank_clearing',12),('patient_wallet_liability',13)")
            .execute(&mut conn).await.unwrap();
        sqlx::query(
            r#"INSERT INTO users (id, pharmacy_id, role, permissions, is_active)
                       VALUES ('return-user','ph-1','pharmacist','{"can_view_returns":true}',1)"#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO shifts VALUES ('shift-1','return-user','ph-1','open',CURRENT_TIMESTAMP)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO patients VALUES ('patient-1',5,0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/061_native_patient_directory_ownership.sql"))
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256) VALUES('patient-1','ph-1','return-user',lower(hex(zeroblob(32))))")
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO master_drugs VALUES (77,'RETURN DRUG',0,1,1,NULL,NULL)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory VALUES ('bank-lot','ph-1',77,'B1','2030-01-01',0,20,20,5,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),('wallet-lot','ph-1',77,'W1','2030-01-01',0,30,30,6,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),('wallet-fail-lot','ph-1',77,'WF1','2030-01-01',0,15,15,4,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO sales_invoices VALUES ('bank-invoice',NULL,'ph-1',20,0,'visa','completed',0,0,0),('wallet-invoice','patient-1','ph-1',30,0,'wallet','completed',0,0,0),('wallet-fail','patient-1','ph-1',15,0,'wallet','completed',0,0,0)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO sales_items VALUES (71,'bank-invoice','bank-lot',77,1,20,'large',5,1,1),(72,'wallet-invoice','wallet-lot',77,1,30,'large',6,1,1),(73,'wallet-fail','wallet-fail-lot',77,1,15,'large',4,1,1)")
            .execute(&mut conn).await.unwrap();
        sqlx::query("ALTER TABLE sales_invoices ADD COLUMN user_id TEXT")
            .execute(&mut conn).await.unwrap();
        for sale_id in ["bank-invoice", "wallet-invoice", "wallet-fail"] {
            seal_test_sale_source_for_return(&mut conn, sale_id, "return-user").await;
        }

        let make_return =
            |invoice_id: &str, item_id: i64, lot: &str, amount: f64, method: &str| ReturnPayload {
                invoice_id: invoice_id.into(),
                user_id: "return-user".into(),
                pharmacy_id: Some("ph-1".into()),
                shift_id: Some("shift-1".into()),
                refund_method: method.into(),
                reason: None,
                patient_id: None,
                items: vec![ReturnItem {
                    sale_item_id: Some(item_id),
                    inventory_id: Some(lot.into()),
                    drug_name: "RETURN DRUG".into(),
                    quantity: 1.0,
                    unit_price: amount,
                    unit: Some("large".into()),
                }],
            };

        let return_request_id = uuid::Uuid::new_v4().to_string();
        let mut tx = conn.begin().await.unwrap();
        let bank = create_return_tx_with_request(
            &mut tx,
            make_return("bank-invoice", 71, "bank-lot", 20.0, "bank"),
            &return_request_id,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert!((bank.total_refund - 20.0).abs() < 0.000_001);
        let bank_credit: f64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(je.amount),0) FROM journal_entries je
             JOIN daily_journals dj ON dj.id=je.journal_id
             WHERE dj.description='Sales return bank-inv' AND je.account_id=12 AND je.type='credit'",
        ).fetch_one(&mut conn).await.unwrap();
        assert!((bank_credit - 20.0).abs() < 0.000_001);
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT request_id FROM native_sale_return_cogs_provenance WHERE return_id=?",
            )
            .bind(&bank.return_id)
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            return_request_id
        );
        assert!(
            sqlx::query("UPDATE returns SET status='pending' WHERE id=?")
                .bind(&bank.return_id)
                .execute(&mut conn)
                .await
                .is_err(),
            "a sealed refund must not be reclassified as pending"
        );
        sqlx::query("UPDATE returns SET status='completed' WHERE id=?")
            .bind(&bank.return_id)
            .execute(&mut conn)
            .await
            .unwrap();
        let wallet_stock_before_replay: f64 =
            sqlx::query_scalar("SELECT quantity FROM inventory WHERE id='wallet-lot'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let nonce_replay = create_return_tx_with_request(
            &mut tx,
            make_return("wallet-invoice", 72, "wallet-lot", 30.0, "wallet"),
            &return_request_id,
        )
        .await
        .unwrap_err();
        assert!(nonce_replay.contains("receipt rejected"), "{nonce_replay}");
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT quantity FROM inventory WHERE id='wallet-lot'",)
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            wallet_stock_before_replay
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM returns WHERE invoice_id='wallet-invoice'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );

        sqlx::raw_sql("CREATE TRIGGER reject_wallet_return_audit BEFORE INSERT ON activity_log WHEN NEW.action='CREATE_RETURN' BEGIN SELECT RAISE(ABORT,'wallet audit failure'); END;")
            .execute(&mut conn).await.unwrap();
        let wallet_before: f64 =
            sqlx::query_scalar("SELECT wallet_balance FROM patients WHERE id='patient-1'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let fail_stock_before: f64 =
            sqlx::query_scalar("SELECT quantity FROM inventory WHERE id='wallet-fail-lot'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let failure = create_return_tx(
            &mut tx,
            make_return("wallet-fail", 73, "wallet-fail-lot", 15.0, "wallet"),
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(failure.contains("wallet audit failure"));
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT wallet_balance FROM patients WHERE id='patient-1'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            wallet_before
        );
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT quantity FROM inventory WHERE id='wallet-fail-lot'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            fail_stock_before
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM returns WHERE invoice_id='wallet-fail'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );
        sqlx::query("DROP TRIGGER reject_wallet_return_audit")
            .execute(&mut conn)
            .await
            .unwrap();

        let mut tx = conn.begin().await.unwrap();
        let wallet = create_return_tx(
            &mut tx,
            make_return("wallet-invoice", 72, "wallet-lot", 30.0, "wallet"),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert!((wallet.total_refund - 30.0).abs() < 0.000_001);
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT wallet_balance FROM patients WHERE id='patient-1'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            wallet_before + 30.0
        );
        let wallet_credit: f64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(je.amount),0) FROM journal_entries je
             JOIN daily_journals dj ON dj.id=je.journal_id
             WHERE dj.description='Sales return wallet-i' AND je.account_id=13 AND je.type='credit'",
        ).fetch_one(&mut conn).await.unwrap();
        assert!((wallet_credit - 30.0).abs() < 0.000_001);
    }

    #[tokio::test]
    async fn negative_stock_settlement_is_scoped_guarded_and_accounted_once() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, large_to_medium INTEGER, medium_to_small INTEGER, medium_unit TEXT, small_unit TEXT, has_expiry INTEGER DEFAULT 1)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity REAL, cost_price REAL, expiry_date TEXT, strips_per_box INTEGER, updated_at TEXT, medium_to_small INTEGER, batch_number TEXT)",
            "CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, permissions TEXT, is_active INTEGER, pharmacy_id TEXT)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, pharmacy_id TEXT, status TEXT)",
            "CREATE TABLE sales_items (id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold REAL, unit TEXT, unit_price REAL, is_negative INTEGER, cost_price REAL, large_to_medium INTEGER DEFAULT 1, medium_to_small INTEGER DEFAULT 1)",
            "CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, status TEXT, pharmacy_id TEXT)",
            "CREATE TABLE return_items (return_id TEXT, sale_item_id INTEGER, quantity_returned REAL, unit TEXT)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL, pharmacy_id TEXT)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT)",
            "CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::raw_sql(include_str!(
            "../../migrations/043_native_sales_cogs_provenance.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(
            "ALTER TABLE sales_invoices ADD COLUMN user_id TEXT;
             ALTER TABLE sales_invoices ADD COLUMN total_amount REAL;
             ALTER TABLE sales_invoices ADD COLUMN payment_method TEXT;",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO users VALUES ('admin', 'owner', '{}', 1, 'ph-1'), ('viewer', 'pharmacist', '{\"can_view_settlement\":true,\"can_manage_inventory\":false}', 1, 'ph-1'), ('foreign-admin', 'owner', '{}', 1, 'ph-2'), ('local-admin', 'owner', '{}', 1, NULL)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO master_drugs VALUES (1, 10, 2, 'strip', 'pill', 1), (2, 1, 1, NULL, NULL, 1), (3, 2, 2, 'blister', 'tablet', 1)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO accounts (id, code) VALUES (10, '1.1.3'), (11, '4.1')")
            .execute(&mut conn)
            .await
            .unwrap();
        for sql in [
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at) VALUES ('wrong-drug', 2, 'ph-1', 5, 40, '2099-01-01', 1, NULL)",
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at) VALUES ('wrong-pharmacy', 1, 'ph-2', 5, 40, '2099-01-01', 10, NULL)",
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at) VALUES ('expired', 1, 'ph-1', 5, 40, '2000-01-01', 10, NULL)",
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at) VALUES ('insufficient', 1, 'ph-1', 0.1, 40, '2099-01-01', 10, NULL)",
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at) VALUES ('valid', 1, 'ph-1', 1, 40, '2099-01-01', 10, NULL)",
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at) VALUES ('zero-cost', 1, 'ph-1', 1, 0, '2099-01-01', 10, NULL)",
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at) VALUES ('return-aware', 1, 'ph-1', 0.5, 40, '2099-01-01', 10, NULL)",
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at) VALUES ('fully-returned', 1, 'ph-1', 0.2, 40, '2099-01-01', 10, NULL)",
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at) VALUES ('legacy-local', 1, NULL, 2, 25, '2099-01-01', 10, NULL)",
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at, medium_to_small) VALUES ('batch-conversion', 3, 'ph-1', 1, 100, '2099-01-01', 2, NULL, 10)",
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at, medium_to_small) VALUES ('legacy-return-unit', 3, 'ph-1', 1, 100, '2099-01-01', 2, NULL, 10)",
            "INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, strips_per_box, updated_at, batch_number) VALUES ('return-only', 1, 'ph-1', 1, 0, '2099-01-01', 10, NULL, 'RET-test')",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO sales_invoices (id,pharmacy_id,status) VALUES ('sale-ph-1', 'ph-1', 'completed'), ('sale-local', NULL, NULL), ('sale-return-aware', 'ph-1', 'completed'), ('sale-fully-returned', 'ph-1', 'completed'), ('sale-draft', 'ph-1', 'draft'), ('sale-batch-conversion', 'ph-1', 'completed'), ('sale-legacy-return-unit', 'ph-1', 'completed')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit, is_negative, cost_price, large_to_medium, medium_to_small) VALUES (1, 'sale-ph-1', NULL, 1, 4, 'small', 1, 0, 10, 2), (2, 'sale-local', NULL, 1, 1, 'large', 1, 0, 10, 2), (3, 'sale-return-aware', NULL, 1, 4, 'small', 1, 0, 10, 2), (4, 'sale-fully-returned', NULL, 1, 4, 'small', 1, 0, 10, 2), (5, 'sale-draft', NULL, 1, 1, 'large', 1, 0, 10, 2), (6, 'sale-batch-conversion', NULL, 3, 1, 'small', 1, 0, 2, 2), (7, 'sale-legacy-return-unit', NULL, 3, 10, 'small', 1, 0, 2, 2)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO returns VALUES ('approved-return', 'sale-return-aware', 'APPROVED','ph-1'), ('completed-return', 'sale-return-aware', 'completed','ph-1'), ('pending-return', 'sale-return-aware', 'pending','ph-1'), ('full-return', 'sale-fully-returned', 'approved','ph-1'), ('legacy-unit-approved', 'sale-legacy-return-unit', 'approved','ph-1'), ('legacy-unit-pending', 'sale-legacy-return-unit', 'pending','ph-1')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO return_items VALUES ('approved-return', 3, 1, 'small'), ('completed-return', 3, 1, 'small'), ('pending-return', 3, 1, 'small'), ('full-return', 4, 4, ''), ('legacy-unit-approved', 7, 1, 'blister'), ('legacy-unit-pending', 7, 10, 'blister')")
        .execute(&mut conn)
        .await
        .unwrap();

        // Test the actual 043 source/journal trigger, not a fake receipt table.
        // An unreceipted approved return must not reduce the later COGS posting.
        sqlx::raw_sql(
            "INSERT INTO accounts(id,code) VALUES(12,'1.1.1'),(13,'3.1');
             UPDATE sales_invoices SET user_id='admin',total_amount=10,payment_method='cash'
               WHERE id='sale-ph-1';
             INSERT INTO daily_journals(id,created_by,total_amount,pharmacy_id)
               VALUES('original-sale','admin',10,'ph-1');
             INSERT INTO journal_entries VALUES('original-sale',12,'debit',10);
             INSERT INTO journal_entries VALUES('original-sale',13,'credit',10);
             INSERT INTO native_sale_cogs_provenance
               (sale_id,request_id,pharmacy_id,actor_id,journal_id,payment_method,
                sale_micros,cogs_micros,line_count,line_snapshot)
               VALUES('sale-ph-1','12345678-abcd-4abc-8abc-123456789abc','ph-1','admin',
                'original-sale','cash',10000000,0,1,
                '[{\"lineId\":1,\"inventoryId\":null,\"drugId\":1,\"quantity\":4,\"costPerLarge\":0,\"negative\":true}]');
             INSERT INTO returns VALUES('unreceipted-forged','sale-ph-1','approved','ph-1');
             INSERT INTO return_items VALUES('unreceipted-forged',1,3,'small');",
        ).execute(&mut conn).await.unwrap();

        let payload_for =
            |sale_item_id: i64, inventory_id: &str, pharmacy_id: &str, user_id: &str| {
                NegativeStockSettlementPayload {
                    sale_item_id,
                    inventory_id: inventory_id.into(),
                    pharmacy_id: pharmacy_id.into(),
                    user_id: user_id.into(),
                }
            };
        let payload = |sale_item_id: i64, inventory_id: &str, pharmacy_id: &str| {
            payload_for(sale_item_id, inventory_id, pharmacy_id, "admin")
        };

        let mut tx = conn.begin().await.unwrap();
        let forged = settle_negative_sale_item_tx(&mut tx, &payload(1, "valid", "ph-1"))
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(forged.contains("lacks original tenant-bound COGS reversal"));
        sqlx::query("DELETE FROM return_items WHERE return_id='unreceipted-forged'")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("DELETE FROM returns WHERE id='unreceipted-forged'")
            .execute(&mut conn)
            .await
            .unwrap();

        let mut tx = conn.begin().await.unwrap();
        let permission_error =
            settle_negative_sale_item_tx(&mut tx, &payload_for(1, "valid", "ph-1", "viewer"))
                .await
                .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(permission_error.contains("can_manage_inventory"));

        let mut tx = conn.begin().await.unwrap();
        let user_pharmacy_error = settle_negative_sale_item_tx(
            &mut tx,
            &payload_for(1, "valid", "ph-1", "foreign-admin"),
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(user_pharmacy_error.contains("another pharmacy"));

        let mut tx = conn.begin().await.unwrap();
        let draft_error = settle_negative_sale_item_tx(&mut tx, &payload(5, "valid", "ph-1"))
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(draft_error.contains("not finalized"));
        let draft_still_negative: i64 =
            sqlx::query("SELECT is_negative FROM sales_items WHERE id = 5")
                .fetch_one(&mut conn)
                .await
                .unwrap()
                .try_get("is_negative")
                .unwrap();
        assert_eq!(draft_still_negative, 1);
        let untouched_valid_stock: f64 = sqlx::query(
            "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE id = 'valid'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("quantity")
        .unwrap();
        assert_eq!(untouched_valid_stock, 1.0);

        for invalid_batch in [
            "wrong-drug",
            "wrong-pharmacy",
            "expired",
            "legacy-local",
            "return-only",
        ] {
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
        sqlx::query(
            "UPDATE inventory SET quantity=0.1999995,cost_price=1000000000 WHERE id='insufficient'",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let fractional_short =
            settle_negative_sale_item_tx(&mut tx, &payload(1, "insufficient", "ph-1"))
                .await
                .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(fractional_short.contains("insufficient stock"));
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT quantity FROM inventory WHERE id='insufficient'")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0.1999995
        );
        sqlx::query("UPDATE inventory SET quantity=0.1,cost_price=40 WHERE id='insufficient'")
            .execute(&mut conn)
            .await
            .unwrap();

        // A zero-cost legacy/gift stock origin has no 042 purchase price to
        // infer. Do not invent a nonzero COGS posting or classify that class
        // as a tampered *purchase* solely because its carrying price is zero.
        // This savepoint-like outer transaction rolls back the trial so the
        // same protected 043 sale can be settled against the later valid lot.
        let mut tx = conn.begin().await.unwrap();
        let zero = settle_negative_sale_item_tx(&mut tx, &payload(1, "zero-cost", "ph-1"))
            .await
            .unwrap();
        assert_eq!(zero.cogs_amount, 0.0);
        assert!((zero.deducted_quantity - 0.2).abs() < 0.000_001);
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT quantity FROM inventory WHERE id='zero-cost'")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            1.0,
        );

        // Different current lot conversions are legitimate. They affect
        // actual stock quantity, never the original 043 receipt's sale ratios.
        sqlx::query("UPDATE inventory SET strips_per_box=5,medium_to_small=4 WHERE id='valid'")
            .execute(&mut conn)
            .await
            .unwrap();
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
        let original_conversion: (i64, i64) =
            sqlx::query_as("SELECT large_to_medium,medium_to_small FROM sales_items WHERE id=1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(original_conversion, (10, 2));
        let journal_count: i64 = sqlx::query("SELECT COUNT(*) AS total FROM daily_journals WHERE description = 'Negative stock settlement item 1'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("total")
            .unwrap();
        let entries = sqlx::query(
            "SELECT e.account_id, e.type, CAST(e.amount AS REAL) AS amount FROM journal_entries e
             JOIN daily_journals j ON j.id=e.journal_id WHERE j.description='Negative stock settlement item 1'",
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
        assert_eq!(unchanged_journals, 2);

        let mut tx = conn.begin().await.unwrap();
        let return_aware =
            settle_negative_sale_item_tx(&mut tx, &payload(3, "return-aware", "ph-1"))
                .await
                .unwrap();
        tx.commit().await.unwrap();
        assert!((return_aware.deducted_quantity - 0.1).abs() < 0.000_001);
        assert!((return_aware.cogs_amount - 4.0).abs() < 0.000_001);
        let return_aware_stock: f64 = sqlx::query(
            "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE id = 'return-aware'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("quantity")
        .unwrap();
        assert!((return_aware_stock - 0.4).abs() < 0.000_001);
        let return_aware_entries = sqlx::query(
            "SELECT je.account_id, je.type, CAST(je.amount AS REAL) AS amount FROM journal_entries je JOIN daily_journals dj ON dj.id = je.journal_id WHERE dj.description = 'Negative stock settlement item 3'",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(return_aware_entries.len(), 2);
        assert!(return_aware_entries
            .iter()
            .all(|row| { (row.try_get::<f64, _>("amount").unwrap() - 4.0).abs() < 0.000_001 }));

        // A historically inconsistent completed return above the original
        // sold amount must not be silently clamped to zero COGS.
        sqlx::query(
            "UPDATE return_items SET quantity_returned=4.0000005 WHERE return_id='full-return'",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let excessive_return =
            settle_negative_sale_item_tx(&mut tx, &payload(4, "fully-returned", "ph-1"))
                .await
                .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(
            excessive_return.contains("invalid returned quantity"),
            "{excessive_return}"
        );
        sqlx::query("UPDATE return_items SET quantity_returned=4 WHERE return_id='full-return'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let fully_returned =
            settle_negative_sale_item_tx(&mut tx, &payload(4, "fully-returned", "ph-1"))
                .await
                .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(fully_returned.deducted_quantity, 0.0);
        assert_eq!(fully_returned.cogs_amount, 0.0);
        let fully_returned_stock: f64 = sqlx::query(
            "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE id = 'fully-returned'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("quantity")
        .unwrap();
        assert_eq!(fully_returned_stock, 0.2);
        let fully_returned_journals: i64 = sqlx::query("SELECT COUNT(*) AS total FROM daily_journals WHERE description = 'Negative stock settlement item 4'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("total")
            .unwrap();
        assert_eq!(fully_returned_journals, 0);
        let fully_returned_status: i64 =
            sqlx::query("SELECT is_negative FROM sales_items WHERE id = 4")
                .fetch_one(&mut conn)
                .await
                .unwrap()
                .try_get("is_negative")
                .unwrap();
        assert_eq!(fully_returned_status, 0);

        let mut tx = conn.begin().await.unwrap();
        let unowned_legacy = settle_negative_sale_item_tx(
            &mut tx,
            &payload_for(2, "legacy-local", "local_default", "local-admin"),
        )
        .await
        .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(unowned_legacy.contains("not finalized"));
        let legacy_stock: f64 = sqlx::query(
            "SELECT CAST(quantity AS REAL) AS quantity FROM inventory WHERE id = 'legacy-local'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap()
        .try_get("quantity")
        .unwrap();
        assert_eq!(legacy_stock, 2.0);

        let mut tx = conn.begin().await.unwrap();
        let batch_conversion =
            settle_negative_sale_item_tx(&mut tx, &payload(6, "batch-conversion", "ph-1"))
                .await
                .unwrap();
        tx.commit().await.unwrap();
        assert!((batch_conversion.deducted_quantity - 0.05).abs() < 0.000_001);
        assert!((batch_conversion.cogs_amount - 5.0).abs() < 0.000_001);
        let batch_stock: f64 = sqlx::query_scalar(
            "SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'batch-conversion'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!((batch_stock - 0.95).abs() < 0.000_001);
        let settled_snapshot = sqlx::query(
            "SELECT inventory_id, large_to_medium, medium_to_small FROM sales_items WHERE id = 6",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            settled_snapshot
                .try_get::<String, _>("inventory_id")
                .unwrap(),
            "batch-conversion"
        );
        assert_eq!(
            settled_snapshot
                .try_get::<i64, _>("large_to_medium")
                .unwrap(),
            2
        );
        assert_eq!(
            settled_snapshot
                .try_get::<i64, _>("medium_to_small")
                .unwrap(),
            10
        );
        let batch_journal_amount: f64 = sqlx::query_scalar(
            "SELECT CAST(amount AS REAL) FROM journal_entries je JOIN daily_journals dj ON dj.id = je.journal_id WHERE dj.description = 'Negative stock settlement item 6' AND je.type = 'debit'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!((batch_journal_amount - 5.0).abs() < 0.000_001);

        let mut tx = conn.begin().await.unwrap();
        let legacy_return_unit =
            settle_negative_sale_item_tx(&mut tx, &payload(7, "legacy-return-unit", "ph-1"))
                .await
                .unwrap();
        tx.commit().await.unwrap();
        assert!((legacy_return_unit.deducted_quantity - 0.4).abs() < 0.000_001);
        assert!((legacy_return_unit.cogs_amount - 40.0).abs() < 0.000_001);
        let legacy_return_stock: f64 = sqlx::query_scalar(
            "SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'legacy-return-unit'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!((legacy_return_stock - 0.6).abs() < 0.000_001);
    }

    #[tokio::test]
    async fn native_negative_settlement_uses_receipted_purchase_cost_and_seals_one_balanced_event()
    {
        // Only a disposable in-memory database. Unlike a hand-seeded lot or
        // synthetic adjustment journal, both the sale's 043 evidence and the
        // purchase's 044 posting receipt originate from their actual writers.
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active)
               VALUES('fresh-admin','fresh-admin','owner','fresh-pharmacy',1),
                     ('foreign-admin','foreign-admin','owner','foreign-pharmacy',1);
             INSERT INTO suppliers(id,name_ar,balance)
               VALUES(1,'In-memory supplier',0);
             INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
               VALUES(90001,'In-memory settlement medicine',150,1,1);",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let mut tx = conn.begin().await.unwrap();
        let sale = process_checkout_tx_with_request(
            &mut tx,
            CheckoutPayload {
                pharmacy_id: "fresh-pharmacy".into(),
                user_id: "fresh-admin".into(),
                patient_id: None,
                shift_id: None,
                source_draft_id: None,
                payment_method: "cash".into(),
                status: "completed".into(),
                check_number: None,
                total_discount: 0.0,
                additional_fees: 0.0,
                points_to_redeem: 0,
                items: vec![CheckoutItem {
                    drug_id: 90001,
                    inventory_id: None,
                    quantity_sold: 2.0,
                    unit_price: 150.0,
                    item_discount_percent: 0.0,
                    selected_unit: "large".into(),
                    is_negative: true,
                }],
            },
            300.0,
            "e1111111-1111-4111-8111-111111111111",
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let line_id: i64 = sqlx::query_scalar(
            "SELECT id FROM sales_items WHERE invoice_id=? AND is_negative=1
               AND inventory_id IS NULL AND cost_price=0",
        )
        .bind(&sale.sale_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let original: (i64, String, String) = sqlx::query_as(
            "SELECT cogs_micros,journal_id,line_snapshot FROM native_sale_cogs_provenance
             WHERE sale_id=? AND pharmacy_id='fresh-pharmacy'",
        )
        .bind(&sale.sale_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(original.0, 0, "negative sale has no fictional initial COGS");

        // The stock and unit cost below must be an outcome of a prospective
        // native purchase, not a manually inserted inventory price.
        let mut tx = conn.begin().await.unwrap();
        let purchase = save_purchase_invoice_tx_checked(
            &mut tx,
            fresh_purchase(
                "in-memory-settlement-purchase",
                "IN-MEM-SETTLEMENT",
                "credit",
                "completed",
                vec![fresh_purchase_line("2099-12-31", 4.0, 0.0, None)],
            ),
            None,
        )
        .await
        .unwrap();
        super::super::purchase_posting_provenance::record_purchase_creation(
            &mut tx,
            "e2222222-2222-4222-8222-222222222222",
            &purchase.id,
            "fresh-admin",
            "fresh-pharmacy",
            1,
            purchase.total_amount,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        let (batch_id, posted_cost, purchased_quantity): (String, f64, f64) = sqlx::query_as(
            "SELECT pi.inventory_id,CAST(i.cost_price AS REAL),CAST(i.quantity AS REAL)
             FROM purchase_invoice_items pi JOIN inventory i ON i.id=pi.inventory_id
             WHERE pi.invoice_id=? AND i.pharmacy_id='fresh-pharmacy' AND i.drug_id=90001",
        )
        .bind(&purchase.id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(purchased_quantity, 4.0);
        assert!((posted_cost - 115.5).abs() < 0.000_001);
        let purchase_receipts: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_purchase_create_requests r
             JOIN native_purchase_posting_events e
               ON e.invoice_id=r.invoice_id AND e.journal_id=r.initial_journal_id
                 AND e.event_kind='initial' AND e.pharmacy_id=r.pharmacy_id
             WHERE r.invoice_id=? AND r.pharmacy_id='fresh-pharmacy'
               AND r.actor_id='fresh-admin' AND r.source_status='completed'",
        )
        .bind(&purchase.id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(purchase_receipts, 1);

        // The persisted lot price is mutable, whereas 042 seals the initial
        // purchase journal and received quantity. A forged carrying price
        // must not become native COGS even for a correctly owned inventory ID.
        for forged_unit_cost in [posted_cost + 25.0, 0.0] {
            sqlx::query("UPDATE inventory SET cost_price=? WHERE id=?")
                .bind(forged_unit_cost)
                .bind(&batch_id)
                .execute(&mut conn)
                .await
                .unwrap();
            let mut tx = conn.begin().await.unwrap();
            let forged_cost = settle_negative_sale_item_tx(
                &mut tx,
                &NegativeStockSettlementPayload {
                    sale_item_id: line_id,
                    inventory_id: batch_id.clone(),
                    pharmacy_id: "fresh-pharmacy".into(),
                    user_id: "fresh-admin".into(),
                },
            )
            .await
            .unwrap_err();
            tx.rollback().await.unwrap();
            assert!(
                forged_cost.contains("immutable purchase cost"),
                "{forged_cost}"
            );
        }
        sqlx::query("UPDATE inventory SET cost_price=? WHERE id=?")
            .bind(posted_cost)
            .bind(&batch_id)
            .execute(&mut conn)
            .await
            .unwrap();

        // Authorization, tenant ownership and selected lot cost all come
        // from persisted server-side records. A foreign owner cannot settle.
        let settle = |actor: &str| NegativeStockSettlementPayload {
            sale_item_id: line_id,
            inventory_id: batch_id.clone(),
            pharmacy_id: "fresh-pharmacy".into(),
            user_id: actor.into(),
        };
        let mut tx = conn.begin().await.unwrap();
        let unauthorized = settle_negative_sale_item_tx(&mut tx, &settle("foreign-admin"))
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(unauthorized.contains("another pharmacy"), "{unauthorized}");
        let before_settle: (i64, f64, i64) = sqlx::query_as(
            "SELECT (SELECT is_negative FROM sales_items WHERE id=?),
                    (SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?),
                    (SELECT COUNT(*) FROM native_sale_negative_settlement_provenance
                     WHERE sale_item_id=?)",
        )
        .bind(line_id)
        .bind(&batch_id)
        .bind(line_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            before_settle,
            (1, 4.0, 0),
            "a foreign actor cannot consume stock or leave a settlement receipt"
        );

        let mut tx = conn.begin().await.unwrap();
        let posted = settle_negative_sale_item_tx(&mut tx, &settle("fresh-admin"))
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(posted.sale_item_id, line_id);
        assert_eq!(posted.inventory_id, batch_id);
        assert!((posted.deducted_quantity - 2.0).abs() < 0.000_001);
        assert!((posted.cogs_amount - 2.0 * posted_cost).abs() < 0.000_001);

        let (settlement_journal, recorded_cogs, recorded_stock, recorded_cost): (
            String,
            i64,
            f64,
            f64,
        ) = sqlx::query_as(
            "SELECT journal_id,cogs_micros,stock_quantity,unit_cost
                 FROM native_sale_negative_settlement_provenance
                 WHERE sale_item_id=? AND sale_id=? AND pharmacy_id='fresh-pharmacy'",
        )
        .bind(line_id)
        .bind(&sale.sale_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            recorded_cogs,
            (posted.cogs_amount * 1_000_000.0).round() as i64
        );
        assert_eq!(recorded_stock, 2.0);
        assert_eq!(recorded_cost, posted_cost);
        let (journal_tenant, journal_actor, journal_amount): (String, String, f64) =
            sqlx::query_as(
                "SELECT pharmacy_id,created_by,total_amount FROM daily_journals WHERE id=?",
            )
            .bind(&settlement_journal)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            (journal_tenant.as_str(), journal_actor.as_str()),
            ("fresh-pharmacy", "fresh-admin")
        );
        assert!((journal_amount - posted.cogs_amount).abs() < 0.000_001);
        let journal_lines: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT a.code,e.type,CAST(e.amount AS REAL)
             FROM journal_entries e JOIN accounts a ON a.id=e.account_id
             WHERE e.journal_id=? ORDER BY a.code",
        )
        .bind(&settlement_journal)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            journal_lines,
            vec![
                ("1.1.3".into(), "credit".into(), posted.cogs_amount),
                ("4.1".into(), "debit".into(), posted.cogs_amount),
            ]
        );
        let (stock_after, item_cost, item_negative, item_batch): (f64, f64, i64, String) =
            sqlx::query_as(
                "SELECT CAST(i.quantity AS REAL),CAST(si.cost_price AS REAL),
                        si.is_negative,si.inventory_id
                 FROM sales_items si JOIN inventory i ON i.id=si.inventory_id
                 WHERE si.id=?",
            )
            .bind(line_id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(stock_after, 2.0);
        assert_eq!(item_cost, posted_cost);
        assert_eq!(item_negative, 0);
        assert_eq!(item_batch, batch_id);
        let original_after: (i64, String, String) = sqlx::query_as(
            "SELECT cogs_micros,journal_id,line_snapshot FROM native_sale_cogs_provenance
             WHERE sale_id=?",
        )
        .bind(&sale.sale_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            original_after, original,
            "043 sale evidence cannot be revised"
        );

        let mut tx = conn.begin().await.unwrap();
        assert!(
            settle_negative_sale_item_tx(&mut tx, &settle("fresh-admin"))
                .await
                .unwrap_err()
                .contains("already settled")
        );
        tx.rollback().await.unwrap();
        let unique: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_sale_negative_settlement_provenance WHERE sale_item_id=?",
        )
        .bind(line_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(unique, 1, "a retry cannot post a second COGS correction");
        assert!(
            sqlx::query("UPDATE daily_journals SET total_amount=0 WHERE id=?")
                .bind(&settlement_journal)
                .execute(&mut conn)
                .await
                .is_err(),
            "the receipted correction journal stays immutable"
        );
    }

    #[tokio::test]
    async fn checkout_rejects_unverified_wallet_balance_and_foreign_credit_history() {
        let mut conn = current_fresh_schema().await;
        sqlx::raw_sql(r#"
            INSERT INTO users(id,username,role,pharmacy_id,is_active)
              VALUES('pos-finance-owner','pos-finance-owner','owner','qa-wallet',1);
            INSERT INTO patients(id,full_name,credit_limit,wallet_balance,opening_balance)
              VALUES('qa-finance-patient','Disposable patient',100,20,0);
            INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256)
              VALUES('qa-finance-patient','qa-wallet','pos-finance-owner',lower(hex(zeroblob(32))));
            INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
              VALUES(987650,'Disposable medicine',20,1,1);
            INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,local_selling_price,expiry_date,strips_per_box)
              VALUES('qa-finance-lot',987650,'qa-wallet',5,10,20,'2099-12-31',1);
        "#).execute(&mut conn).await.unwrap();
        let checkout = |method: &str| CheckoutPayload {
            pharmacy_id: "qa-wallet".into(),
            user_id: "pos-finance-owner".into(),
            items: vec![CheckoutItem {
                drug_id: 987650, inventory_id: Some("qa-finance-lot".into()),
                quantity_sold: 1.0, unit_price: 20.0, item_discount_percent: 0.0,
                selected_unit: "large".into(), is_negative: false,
            }],
            patient_id: Some("qa-finance-patient".into()), shift_id: None,
            source_draft_id: None, payment_method: method.into(),
            check_number: None, status: "completed".into(), total_discount: 0.0,
            additional_fees: 0.0, points_to_redeem: 0,
        };
        // The historic global wallet_balance alone must not fund native POS.
        let mut tx = conn.begin().await.unwrap();
        let unknown_wallet = process_checkout_tx(&mut tx, checkout("wallet"), 20.0).await;
        assert!(unknown_wallet.as_ref().is_err_and(|e| e.contains("unverified wallet")),
            "Unreceipted patient wallet was spent: {unknown_wallet:?}");
        tx.rollback().await.unwrap();

        // An old/foreign credit invoice with no branch receipt cannot be
        // treated as this prospective patient's available credit-limit basis.
        sqlx::query("INSERT INTO sales_invoices(id,patient_id,pharmacy_id,payment_method,status,total_amount,user_id) VALUES('qa-unowned-credit','qa-finance-patient',NULL,'credit','completed',20,'pos-finance-owner')")
            .execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let unknown_credit = process_checkout_tx(&mut tx, checkout("credit"), 20.0).await;
        assert!(unknown_credit.as_ref().is_err_and(|e| e.contains("provenance")),
            "Foreign/NULL credit source authorized native spend: {unknown_credit:?}");
        tx.rollback().await.unwrap();
        let counted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales_invoices")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(counted, 1, "Rejected checkouts created durable sales");
    }

    #[tokio::test]
    async fn checkout_handles_batch_fallback_and_wallet_accounting() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, active_ingredient TEXT, official_price REAL, large_to_medium INTEGER, medium_to_small INTEGER, medium_unit TEXT, small_unit TEXT, min_limit REAL, reorder_point REAL, default_purchase_qty REAL, stop_dealing INTEGER DEFAULT 0, has_expiry INTEGER DEFAULT 1)",
            "CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity REAL, cost_price REAL, local_selling_price REAL, expiry_date TEXT, created_at TEXT, updated_at TEXT, strips_per_box INTEGER, medium_to_small INTEGER)",
            "CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, permissions TEXT, is_active INTEGER, pharmacy_id TEXT)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, pharmacy_id TEXT, user_id TEXT, patient_id TEXT, shift_id TEXT, total_amount REAL, payment_method TEXT, check_number TEXT, status TEXT, discount_amount REAL, paid_amount REAL DEFAULT 0, remaining_amount REAL DEFAULT 0, points_earned INTEGER DEFAULT 0, points_redeemed INTEGER DEFAULT 0, loyalty_discount_amount REAL DEFAULT 0, created_at TEXT)",
            "CREATE TABLE sales_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold REAL, unit_price REAL, item_discount_percent REAL DEFAULT 0, unit TEXT, is_negative INTEGER, cost_price REAL, large_to_medium INTEGER DEFAULT 1, medium_to_small INTEGER DEFAULT 1, created_at TEXT)",
            "CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL, pharmacy_id TEXT)",
            "CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL)",
            "CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER)",
            "CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT)",
            "CREATE TABLE patients (id TEXT PRIMARY KEY, credit_limit REAL, wallet_balance REAL, loyalty_level TEXT, points_balance INTEGER, opening_balance REAL DEFAULT 0)",
            "CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, pharmacy_id TEXT, start_time TEXT, status TEXT)",
            "CREATE TABLE returns (invoice_id TEXT, total_refund REAL, refund_method TEXT, status TEXT)",
            "CREATE TABLE return_items (id INTEGER PRIMARY KEY,return_id TEXT,inventory_id TEXT,drug_id INTEGER,sale_item_id INTEGER,quantity_returned REAL,unit TEXT,total_price REAL)",
            "CREATE TABLE patient_transactions (patient_id TEXT, type TEXT, amount REAL, date TEXT, user_id TEXT, notes TEXT)",
            "CREATE TABLE financial_notices (target_type TEXT, target_id TEXT, type TEXT, amount REAL, date TEXT, user_id TEXT, reason TEXT)",
            "CREATE TABLE refill_reminders (id TEXT, patient_id TEXT, drug_id INTEGER, last_sold_date TEXT, next_refill_date TEXT, created_at TEXT)",
            "CREATE TABLE shortages (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER, pharmacy_id TEXT NOT NULL DEFAULT 'local_default', requested_quantity REAL, status TEXT)",
            "CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::raw_sql(include_str!(
            "../../migrations/043_native_sales_cogs_provenance.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        // Newly authored test actors and patients belong to an explicit QA
        // pharmacy, not the historical local_default ownership quarantine.
        sqlx::raw_sql(include_str!("../../migrations/061_native_patient_directory_ownership.sql"))
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO users VALUES ('admin', 'owner', '{}', 1, 'qa-pos'), ('foreign-admin', 'owner', '{}', 1, 'ph-2'), ('limited-pos', 'pharmacist', '{\"can_access_pos\":true,\"can_change_price_sale\":true,\"suspended_can_save_invoice\":false,\"can_sell_no_stock\":false}', 1, 'qa-pos'), ('price-pos', 'pharmacist', '{\"can_access_pos\":true,\"can_sell_no_stock\":false}', 1, 'qa-pos')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO master_drugs (id, trade_name, official_price, large_to_medium, medium_to_small, default_purchase_qty) VALUES (4463, 'COLONA', 69, 10, 1, 8)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO accounts (id, code) VALUES (6, '1.1.1'), (8, '1.1.2'), (9, '3.1'), (10, '1.1.3'), (11, '4.1'), (12, '2.2'), (13, '1.1.4')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO trial_balance_settings VALUES ('patient_wallet_liability', 12)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, created_at, strips_per_box) VALUES ('empty', 4463, 'qa-pos', 0, 40, '2999-01-01', '2026-01-01', 10), ('full', 4463, 'qa-pos', 7, 40, '2999-01-01', '2026-01-02', 10), ('other-pharmacy', 4463, 'ph-002', 7, 40, '2998-01-01', '2026-01-01', 10), ('expired', 4463, 'qa-pos', 7, 40, '2000-01-01', '2026-01-01', 10), ('unknown-expiry-return', 4463, 'qa-pos', 2, 40, NULL, '2026-01-03', 10)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("UPDATE inventory SET local_selling_price = 69 WHERE id = 'full'")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE inventory SET local_selling_price = 10 WHERE id = 'unknown-expiry-return'",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let cash_payload = |inventory_id: Option<&str>| CheckoutPayload {
            pharmacy_id: "qa-pos".into(),
            user_id: "admin".into(),
            items: vec![CheckoutItem {
                drug_id: 4463,
                inventory_id: inventory_id.map(str::to_string),
                quantity_sold: 1.0,
                unit_price: 69.0,
                item_discount_percent: 0.0,
                selected_unit: "large".into(),
                is_negative: false,
            }],
            patient_id: None,
            shift_id: None,
            source_draft_id: None,
            payment_method: "cash".into(),
            check_number: None,
            status: "completed".into(),
            total_discount: 0.0,
            additional_fees: 0.0,
            points_to_redeem: 0,
        };

        // Reproduce a fractional stock shortage that a completed checkout
        // previously hid under its 1e-6 tolerance while charging the full
        // requested sale. It must not post a partial line at the full price.
        sqlx::query(
            "UPDATE inventory SET quantity=0.9999995,cost_price=1000000000 WHERE id='full'",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let short = process_checkout_tx(&mut tx, cash_payload(Some("full")), 69.0)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(short.contains("Insufficient stock"), "{short}");
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT quantity FROM inventory WHERE id='full'")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0.9999995
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
        // An explicitly authorized negative sale is different: preserve the
        // genuine shortage as its own receipted negative line, not a rounded
        // disappearance from the charged quantity.
        sqlx::query("UPDATE inventory SET cost_price=40 WHERE id='full'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut explicit_shortage = cash_payload(Some("full"));
        explicit_shortage.items[0].is_negative = true;
        let mut tx = conn.begin().await.unwrap();
        let sale = process_checkout_tx(&mut tx, explicit_shortage, 69.0)
            .await
            .unwrap();
        let sale_lines: (f64, i64) = sqlx::query_as(
            "SELECT SUM(quantity_sold),SUM(is_negative) FROM sales_items WHERE invoice_id=?",
        )
        .bind(&sale.sale_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert!((sale_lines.0 - 1.0).abs() < 1e-12);
        assert_eq!(sale_lines.1, 1);
        tx.rollback().await.unwrap();
        sqlx::query("UPDATE inventory SET quantity=7,cost_price=40 WHERE id='full'")
            .execute(&mut conn)
            .await
            .unwrap();

        for (fees, discount) in [
            (-69.0, 0.0),
            (f64::NAN, 0.0),
            (0.0, -1.0),
            (0.0, f64::INFINITY),
        ] {
            let mut invalid = cash_payload(Some("full"));
            invalid.additional_fees = fees;
            invalid.total_discount = discount;
            let mut tx = conn.begin().await.unwrap();
            assert_eq!(
                process_checkout_tx(&mut tx, invalid, 0.0)
                    .await
                    .unwrap_err(),
                "Invalid checkout amounts"
            );
            tx.rollback().await.unwrap();
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT quantity FROM inventory WHERE id = 'full'")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            7.0
        );

        let mut invalid_payment = cash_payload(Some("full"));
        invalid_payment.payment_method = "crypto".into();
        let mut tx = conn.begin().await.unwrap();
        assert_eq!(
            process_checkout_tx(&mut tx, invalid_payment, 69.0)
                .await
                .unwrap_err(),
            "Invalid checkout payment method"
        );
        tx.rollback().await.unwrap();

        let mut missing_check_number = cash_payload(Some("full"));
        missing_check_number.payment_method = "check".into();
        missing_check_number.check_number = Some("   ".into());
        let mut tx = conn.begin().await.unwrap();
        assert_eq!(
            process_checkout_tx(&mut tx, missing_check_number, 69.0)
                .await
                .unwrap_err(),
            "Check number is required for completed check checkout"
        );
        tx.rollback().await.unwrap();

        let mut strict_price = cash_payload(None);
        strict_price.user_id = "price-pos".into();
        let mut tx = conn.begin().await.unwrap();
        process_checkout_tx(&mut tx, strict_price, 69.0)
            .await
            .expect("unknown-expiry stock must not lower the validated checkout price");
        tx.rollback().await.unwrap();

        for (unit, price) in [
            ("medium", 6.9),
            ("strip", 6.9),
            ("شريط", 6.9),
            ("Blister", 6.9),
            ("small", 3.45),
            ("unit", 3.45),
            ("pill", 3.45),
            ("Tablet", 3.45),
        ] {
            let mut tx = conn.begin().await.unwrap();
            sqlx::query("UPDATE master_drugs SET medium_unit = 'Blister', small_unit = 'tablet', medium_to_small = 2 WHERE id = 4463")
                .execute(&mut *tx).await.unwrap();
            sqlx::query("UPDATE inventory SET medium_to_small = 2 WHERE id = 'full'")
                .execute(&mut *tx)
                .await
                .unwrap();
            let mut sale = cash_payload(Some("full"));
            sale.user_id = "price-pos".into();
            sale.items[0].selected_unit = unit.into();
            sale.items[0].unit_price = price;
            process_checkout_tx(&mut tx, sale, price)
                .await
                .unwrap_or_else(|error| {
                    panic!("restricted cashier must sell {unit} at its configured price: {error}")
                });
            let stock: f64 = sqlx::query_scalar(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'full'",
            )
            .fetch_one(&mut *tx)
            .await
            .unwrap();
            assert!(
                (stock - (7.0 - price / 69.0)).abs() < 0.000_001,
                "{unit} price validation and stock conversion must agree"
            );
            let mut changed_price = cash_payload(Some("full"));
            changed_price.user_id = "price-pos".into();
            changed_price.items[0].selected_unit = unit.into();
            changed_price.items[0].unit_price = price + 1.0;
            assert_eq!(
                process_checkout_tx(&mut tx, changed_price, price + 1.0)
                    .await
                    .unwrap_err(),
                "Unauthorized: can_change_price_sale permission required"
            );
            tx.rollback().await.unwrap();
        }

        let mut invalid_status = cash_payload(Some("full"));
        invalid_status.status = "voided".into();
        let mut tx = conn.begin().await.unwrap();
        assert_eq!(
            process_checkout_tx(&mut tx, invalid_status, 69.0)
                .await
                .unwrap_err(),
            "Invalid checkout status"
        );
        tx.rollback().await.unwrap();

        let mut invalid_redemption = cash_payload(Some("full"));
        invalid_redemption.points_to_redeem = 50;
        let mut tx = conn.begin().await.unwrap();
        assert_eq!(
            process_checkout_tx(&mut tx, invalid_redemption, 69.0)
                .await
                .unwrap_err(),
            "Loyalty points to redeem must be 0 or at least 100"
        );
        tx.rollback().await.unwrap();

        let mut forbidden_draft = cash_payload(Some("full"));
        forbidden_draft.user_id = "limited-pos".into();
        forbidden_draft.status = "draft".into();
        let mut tx = conn.begin().await.unwrap();
        assert_eq!(
            process_checkout_tx(&mut tx, forbidden_draft, 69.0)
                .await
                .unwrap_err(),
            "Unauthorized: suspended_can_save_invoice permission required"
        );
        tx.rollback().await.unwrap();

        let mut replenished_without_negative_permission = cash_payload(None);
        replenished_without_negative_permission.user_id = "limited-pos".into();
        replenished_without_negative_permission.items[0].is_negative = true;
        let mut tx = conn.begin().await.unwrap();
        let replenished_without_negative_permission_sale =
            process_checkout_tx(&mut tx, replenished_without_negative_permission, 69.0)
                .await
                .unwrap();
        let stored_negative: i64 =
            sqlx::query_scalar("SELECT is_negative FROM sales_items WHERE invoice_id = ?")
                .bind(&replenished_without_negative_permission_sale.sale_id)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(stored_negative, 0);
        tx.rollback().await.unwrap();

        let mut stale_negative = cash_payload(None);
        stale_negative.items[0].is_negative = true;
        let mut tx = conn.begin().await.unwrap();
        let replenished_sale = process_checkout_tx(&mut tx, stale_negative, 69.0)
            .await
            .unwrap();
        let remaining_stock: f64 =
            sqlx::query_scalar("SELECT quantity FROM inventory WHERE id = 'full'")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert!((remaining_stock - 6.0).abs() < 0.000_001);
        let replenished_line = sqlx::query(
            "SELECT inventory_id, is_negative, cost_price FROM sales_items WHERE invoice_id = ?",
        )
        .bind(&replenished_sale.sale_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(
            replenished_line
                .try_get::<String, _>("inventory_id")
                .unwrap(),
            "full"
        );
        assert_eq!(
            replenished_line.try_get::<i64, _>("is_negative").unwrap(),
            0
        );
        assert!(
            (replenished_line.try_get::<f64, _>("cost_price").unwrap() - 40.0).abs() < 0.000_001
        );
        tx.rollback().await.unwrap();

        let mut discounted_draft = cash_payload(Some("full"));
        discounted_draft.status = "draft".into();
        discounted_draft.items[0].unit_price = 62.1;
        discounted_draft.items[0].item_discount_percent = 10.0;
        let mut tx = conn.begin().await.unwrap();
        let draft_result = process_checkout_tx(&mut tx, discounted_draft, 62.1)
            .await
            .unwrap();
        let saved_discount: f64 = sqlx::query_scalar(
            "SELECT item_discount_percent FROM sales_items WHERE invoice_id = ?",
        )
        .bind(&draft_result.sale_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert!((saved_discount - 10.0).abs() < 0.000_001);
        tx.rollback().await.unwrap();

        let mut foreign_user_payload = cash_payload(Some("full"));
        foreign_user_payload.user_id = "foreign-admin".into();
        let mut tx = conn.begin().await.unwrap();
        let user_pharmacy_error = process_checkout_tx(&mut tx, foreign_user_payload, 69.0)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(user_pharmacy_error.contains("another pharmacy"));

        let mut stale_patient = cash_payload(Some("full"));
        stale_patient.patient_id = Some("missing-patient".into());
        let stock_before_missing_patient: f64 =
            sqlx::query_scalar("SELECT quantity FROM inventory WHERE id = 'full'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let sales_before_missing_patient: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sales_invoices")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let missing_patient = process_checkout_tx(&mut tx, stale_patient, 69.0)
            .await
            .unwrap_err();
        assert_eq!(missing_patient, "Patient tenant ownership cannot be verified");
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT quantity FROM inventory WHERE id = 'full'")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            stock_before_missing_patient
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            sales_before_missing_patient
        );

        let mut tx = conn.begin().await.unwrap();
        sqlx::query("UPDATE master_drugs SET stop_dealing=1 WHERE id=4463")
            .execute(&mut *tx)
            .await
            .unwrap();
        let archived = process_checkout_tx(&mut tx, cash_payload(Some("full")), 69.0)
            .await
            .unwrap_err();
        assert!(archived.contains("مؤرشف"));
        tx.rollback().await.unwrap();
        let unchanged: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales_invoices")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(unchanged, 0);
        let mut tx = conn.begin().await.unwrap();
        let auto_shift_sale = process_checkout_tx(&mut tx, cash_payload(Some("full")), 69.0)
            .await
            .unwrap();
        assert_eq!(auto_shift_sale.total_amount, 69.0);
        let stored_created_at: String =
            sqlx::query_scalar("SELECT created_at FROM sales_invoices WHERE id = ?")
                .bind(&auto_shift_sale.sale_id)
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(
            auto_shift_sale.created_at,
            format!("{}Z", stored_created_at.replace(' ', "T"))
        );
        let auto_shift_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM shifts WHERE user_id = 'admin' AND status = 'open'",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(auto_shift_count, 1);
        tx.rollback().await.unwrap();

        let mut anonymous_delivery = cash_payload(Some("full"));
        anonymous_delivery.payment_method = "delivery".into();
        let mut tx = conn.begin().await.unwrap();
        let anonymous_delivery_error = process_checkout_tx(&mut tx, anonymous_delivery, 69.0)
            .await
            .unwrap_err();
        assert_eq!(
            anonymous_delivery_error,
            "Delivery checkout requires a patient"
        );
        tx.rollback().await.unwrap();
        sqlx::query("INSERT INTO patients (id, credit_limit, wallet_balance, loyalty_level, points_balance) VALUES ('delivery-patient', 0, 0, 'bronze', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256) VALUES('delivery-patient','qa-pos','admin',lower(hex(zeroblob(32))))")
            .execute(&mut conn).await.unwrap();
        // Regression: an otherwise valid 69.005 native delivery would seal an
        // immutable 043 receivable that 045 refuses to collect. Fail before
        // inserting a sale, journal or stock movement, not on collection day.
        let mut fractional_delivery = cash_payload(Some("full"));
        fractional_delivery.payment_method = "delivery".into();
        fractional_delivery.patient_id = Some("delivery-patient".into());
        fractional_delivery.additional_fees = 0.005;
        let sale_count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales_invoices")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let journal_count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let stock_before: f64 =
            sqlx::query_scalar("SELECT quantity FROM inventory WHERE id='full'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let precision_error = process_checkout_tx(&mut tx, fractional_delivery, 69.005)
            .await
            .unwrap_err();
        assert!(precision_error.contains("exact cents"), "{precision_error}");
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            sale_count_before
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            journal_count_before
        );
        assert_eq!(
            sqlx::query_scalar::<_, f64>("SELECT quantity FROM inventory WHERE id='full'")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            stock_before
        );
        let mut delivery_payload = cash_payload(Some("full"));
        delivery_payload.payment_method = "delivery".into();
        delivery_payload.patient_id = Some("delivery-patient".into());
        let mut tx = conn.begin().await.unwrap();
        process_checkout_tx(&mut tx, delivery_payload, 69.0)
            .await
            .unwrap();
        let delivery_debit_account: i64 = sqlx::query_scalar(
            "SELECT je.account_id
             FROM journal_entries je
             JOIN daily_journals dj ON dj.id = je.journal_id
             WHERE je.type = 'debit' AND dj.description LIKE 'Sales invoice %'
             ORDER BY dj.rowid DESC LIMIT 1",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert_eq!(delivery_debit_account, 8);
        tx.rollback().await.unwrap();

        sqlx::query("INSERT INTO shifts (id, user_id, start_time, status) VALUES ('shift-1', 'admin', CURRENT_TIMESTAMP, 'open')")
            .execute(&mut conn)
            .await
            .unwrap();

        let mut tx = conn.begin().await.unwrap();
        let location_error =
            process_checkout_tx(&mut tx, cash_payload(Some("other-pharmacy")), 69.0)
                .await
                .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(location_error.contains("Selected inventory batch"));
        let mut tx = conn.begin().await.unwrap();
        let expiry_error = process_checkout_tx(&mut tx, cash_payload(Some("expired")), 69.0)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(expiry_error.contains("Selected inventory batch"));

        let mut tx = conn.begin().await.unwrap();
        let unknown_expiry_error =
            process_checkout_tx(&mut tx, cash_payload(Some("unknown-expiry-return")), 69.0)
                .await
                .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(unknown_expiry_error.contains("Selected inventory batch"));

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

        let sale_audits: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM activity_log WHERE action = 'COMPLETE_SALE'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(sale_audits, 1);

        let full_qty: f64 = sqlx::query("SELECT quantity FROM inventory WHERE id = 'full'")
            .fetch_one(&mut conn)
            .await
            .unwrap()
            .try_get("quantity")
            .unwrap();
        assert_eq!(full_qty, 6.0);
        let other_qty: f64 =
            sqlx::query("SELECT quantity FROM inventory WHERE id = 'other-pharmacy'")
                .fetch_one(&mut conn)
                .await
                .unwrap()
                .try_get("quantity")
                .unwrap();
        assert_eq!(other_qty, 7.0);

        sqlx::query("INSERT INTO patients (id, credit_limit, wallet_balance, loyalty_level, points_balance) VALUES ('redeem-patient', 0, 0, 'bronze', 150)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256) VALUES('redeem-patient','qa-pos','admin',lower(hex(zeroblob(32))))")
            .execute(&mut conn).await.unwrap();
        let mut redeem_payload = cash_payload(Some("full"));
        redeem_payload.user_id = "limited-pos".into();
        redeem_payload.patient_id = Some("redeem-patient".into());
        redeem_payload.points_to_redeem = 100;
        let mut tx = conn.begin().await.unwrap();
        let redeemed_sale = process_checkout_tx(&mut tx, redeem_payload, 69.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert!((redeemed_sale.total_amount - 59.0).abs() < 0.000_001);
        assert_eq!(redeemed_sale.points_redeemed, 100);
        assert!((redeemed_sale.loyalty_discount_amount - 10.0).abs() < 0.000_001);
        assert_eq!(redeemed_sale.points_earned, 59);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT CAST(points_balance AS INTEGER) FROM patients WHERE id = 'redeem-patient'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            109
        );
        let redemption_snapshot = sqlx::query(
            "SELECT CAST(discount_amount AS REAL) AS discount_amount, CAST(points_redeemed AS INTEGER) AS points_redeemed, CAST(loyalty_discount_amount AS REAL) AS loyalty_discount_amount FROM sales_invoices WHERE id = ?",
        )
        .bind(&redeemed_sale.sale_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!(
            (redemption_snapshot
                .try_get::<f64, _>("discount_amount")
                .unwrap()
                - 10.0)
                .abs()
                < 0.000_001
        );
        assert_eq!(
            redemption_snapshot
                .try_get::<i64, _>("points_redeemed")
                .unwrap(),
            100
        );
        assert!(
            (redemption_snapshot
                .try_get::<f64, _>("loyalty_discount_amount")
                .unwrap()
                - 10.0)
                .abs()
                < 0.000_001
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM activity_log WHERE action = 'REDEEM_POINTS'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1
        );

        let mut combined_discount_payload = cash_payload(Some("full"));
        combined_discount_payload.patient_id = Some("redeem-patient".into());
        combined_discount_payload.total_discount = 5.0;
        combined_discount_payload.points_to_redeem = 100;
        let mut tx = conn.begin().await.unwrap();
        let combined_discount_sale = process_checkout_tx(&mut tx, combined_discount_payload, 64.0)
            .await
            .unwrap();
        assert!((combined_discount_sale.total_amount - 54.0).abs() < 0.000_001);
        let combined_discount_snapshot: f64 = sqlx::query_scalar(
            "SELECT CAST(discount_amount AS REAL) FROM sales_invoices WHERE id = ?",
        )
        .bind(&combined_discount_sale.sale_id)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        assert!((combined_discount_snapshot - 15.0).abs() < 0.000_001);
        tx.rollback().await.unwrap();

        sqlx::query("UPDATE patients SET points_balance = 99 WHERE id = 'redeem-patient'")
            .execute(&mut conn)
            .await
            .unwrap();
        let insufficient_stock_before = sqlx::query_scalar::<_, f64>(
            "SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'full'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let insufficient_sales_before =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let insufficient_audits_before = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM activity_log WHERE action = 'REDEEM_POINTS'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let insufficient_journals_before =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let mut insufficient_redemption = cash_payload(Some("full"));
        insufficient_redemption.patient_id = Some("redeem-patient".into());
        insufficient_redemption.points_to_redeem = 100;
        let mut tx = conn.begin().await.unwrap();
        let insufficient_error = process_checkout_tx(&mut tx, insufficient_redemption, 69.0)
            .await
            .unwrap_err();
        tx.rollback().await.unwrap();
        assert!(
            insufficient_error.contains("Insufficient loyalty points"),
            "{insufficient_error}"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            insufficient_sales_before
        );
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'full'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            insufficient_stock_before
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM activity_log WHERE action = 'REDEEM_POINTS'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            insufficient_audits_before
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            insufficient_journals_before
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT CAST(points_balance AS INTEGER) FROM patients WHERE id = 'redeem-patient'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            99
        );

        sqlx::query("INSERT INTO patients (id, credit_limit, wallet_balance, loyalty_level, points_balance) VALUES ('p1', 300, 0, 'bronze', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256) VALUES('p1','qa-pos','admin',lower(hex(zeroblob(32))))")
            .execute(&mut conn).await.unwrap();
        // Fund the new 061-owned wallet with a *real* 060 native cash and
        // liability receipt. A manually assigned wallet_balance=100 is not
        // patient money and cannot authorize a wallet-funded POS checkout.
        sqlx::raw_sql(r#"
            CREATE TABLE IF NOT EXISTS cash_movements(
              id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,type TEXT,
              category TEXT,amount REAL,source_type TEXT,target_name TEXT,
              notes TEXT,date TEXT,pharmacy_id TEXT);
            CREATE TABLE IF NOT EXISTS patient_payment_scope(
              transaction_id TEXT,pharmacy_id TEXT,request_id TEXT);
            CREATE TABLE IF NOT EXISTS financial_notice_native_scope(
              patient_transaction_id TEXT,pharmacy_id TEXT,notice_id TEXT);
        "#).execute(&mut conn).await.unwrap();
        // This old POS fixture intentionally uses reduced synthetic tables.
        // Supply the production 060 reader/writer columns for its new genuine
        // wallet-funding receipt, without changing actual application schema.
        for (table, required) in [
            ("patients", vec![("full_name", "TEXT"), ("opening_balance", "REAL DEFAULT 0")]),
            ("patient_transactions", vec![("id", "TEXT"), ("payment_method", "TEXT")]),
            ("returns", vec![("id", "TEXT"), ("pharmacy_id", "TEXT")]),
            ("shifts", vec![("starting_cash", "REAL DEFAULT 0"), ("notes", "TEXT")]),
            ("accounts", vec![("is_group", "INTEGER DEFAULT 0")]),
            ("activity_log", vec![("pharmacy_id", "TEXT")]),
        ] {
            let columns: Vec<String> = sqlx::query_scalar(
                "SELECT name FROM pragma_table_info(?)",
            ).bind(table).fetch_all(&mut conn).await.unwrap();
            for (column, kind) in required {
                if !columns.iter().any(|present| present == column) {
                    sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind}"))
                        .execute(&mut conn).await.unwrap();
                }
            }
        }
        sqlx::query("UPDATE patients SET full_name='Disposable POS wallet' WHERE id='p1'")
            .execute(&mut conn).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/060_native_patient_wallet_topups.sql"))
            .execute(&mut conn).await.unwrap();
        let funded: super::super::patient_payments_native::PatientWalletTopUpInput =
            serde_json::from_value(serde_json::json!({
                "patientId": "p1", "amount": 100.0, "notes": "Disposable POS funding",
                "requestId": "qa-pos-wallet-funded-once"
            })).unwrap();
        let _funding = super::super::patient_payments_native::wallet_top_up(
            &mut conn, "admin", funded,
        ).await.unwrap();
        let funded_balance: f64 = sqlx::query_scalar(
            "SELECT CAST(wallet_balance AS REAL) FROM patients WHERE id='p1'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(funded_balance, 100.0);
        let wallet_payload = CheckoutPayload {
            pharmacy_id: "qa-pos".into(),
            user_id: "admin".into(),
            items: vec![CheckoutItem {
                drug_id: 4463,
                inventory_id: Some("full".into()),
                quantity_sold: 1.0,
                unit_price: 69.0,
                item_discount_percent: 0.0,
                selected_unit: "large".into(),
                is_negative: false,
            }],
            patient_id: Some("p1".into()),
            shift_id: None,
            source_draft_id: None,
            payment_method: "wallet".into(),
            check_number: None,
            status: "completed".into(),
            total_discount: 0.0,
            additional_fees: 0.0,
            points_to_redeem: 0,
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

        let boundary_payload =
            |patient_id: &str, payment_method: &str, amount: f64| CheckoutPayload {
                pharmacy_id: "qa-pos".into(),
                user_id: "admin".into(),
                items: vec![CheckoutItem {
                    drug_id: 4463,
                    inventory_id: Some("full".into()),
                    quantity_sold: 1.0,
                    unit_price: amount,
                    item_discount_percent: 0.0,
                    selected_unit: "large".into(),
                    is_negative: false,
                }],
                patient_id: Some(patient_id.into()),
                shift_id: None,
                source_draft_id: None,
                payment_method: payment_method.into(),
                check_number: None,
                status: "completed".into(),
                total_discount: 0.0,
                additional_fees: 0.0,
                points_to_redeem: 0,
            };

        sqlx::query("UPDATE patients SET wallet_balance = 31 WHERE id = 'p1'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        process_checkout_tx(&mut tx, boundary_payload("p1", "wallet", 31.0), 31.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let wallet_after_exact: f64 =
            sqlx::query_scalar("SELECT CAST(wallet_balance AS REAL) FROM patients WHERE id = 'p1'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert!(wallet_after_exact.abs() < 0.000_001);

        sqlx::query("UPDATE patients SET wallet_balance = 30.99 WHERE id = 'p1'")
            .execute(&mut conn)
            .await
            .unwrap();
        let wallet_reject_stock: f64 =
            sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'full'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let wallet_reject_sales: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales_invoices")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let wallet_reject_journals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        assert_eq!(
            process_checkout_tx(&mut tx, boundary_payload("p1", "wallet", 31.0), 31.0)
                .await
                .unwrap_err(),
            "Insufficient wallet balance"
        );
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            wallet_reject_sales
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            wallet_reject_journals
        );
        assert!(
            (sqlx::query_scalar::<_, f64>(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'full'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap()
                - wallet_reject_stock)
                .abs()
                < 0.000_001
        );

        sqlx::query("INSERT INTO patients (id, credit_limit, wallet_balance, loyalty_level, points_balance) VALUES ('p2', 69, 0, 'bronze', 0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256) VALUES('p2','qa-pos','admin',lower(hex(zeroblob(32))))")
            .execute(&mut conn).await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        process_checkout_tx(&mut tx, boundary_payload("p2", "credit", 69.0), 69.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let credit_reject_stock: f64 =
            sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'full'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let credit_reject_sales: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sales_invoices")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        assert_eq!(
            process_checkout_tx(&mut tx, boundary_payload("p2", "credit", 0.01), 0.01)
                .await
                .unwrap_err(),
            "Credit limit exceeded"
        );
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            credit_reject_sales
        );
        assert!(
            (sqlx::query_scalar::<_, f64>(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'full'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap()
                - credit_reject_stock)
                .abs()
                < 0.000_001
        );

        sqlx::query("UPDATE inventory SET quantity = 1 WHERE id = 'full'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        process_checkout_tx(&mut tx, cash_payload(Some("full")), 69.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let shortage = sqlx::query(
            "SELECT drug_id, CAST(requested_quantity AS REAL) AS requested_quantity, status FROM shortages",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(shortage.try_get::<i64, _>("drug_id").unwrap(), 4463);
        assert_eq!(
            shortage.try_get::<f64, _>("requested_quantity").unwrap(),
            8.0
        );
        assert_eq!(shortage.try_get::<String, _>("status").unwrap(), "pending");

        sqlx::query("UPDATE inventory SET quantity = 1 WHERE id = 'full'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        process_checkout_tx(&mut tx, cash_payload(Some("full")), 69.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let shortage_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM shortages WHERE drug_id = 4463 AND status IN ('pending', 'ordered')",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(shortage_count, 1);

        sqlx::query("INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small, medium_unit, small_unit) VALUES (5000, 'MIXED LOT', 12, 2, 'strip', 'tablet')")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, cost_price, expiry_date, created_at, strips_per_box) VALUES ('mixed-10', 5000, 'qa-pos', 1, 100, '2999-01-01', '2026-01-01', 10), ('mixed-12', 5000, 'qa-pos', 1, 120, '2999-02-01', '2026-01-02', 12)")
            .execute(&mut conn)
            .await
            .unwrap();
        let mixed_payload = CheckoutPayload {
            pharmacy_id: "qa-pos".into(),
            user_id: "admin".into(),
            items: vec![CheckoutItem {
                drug_id: 5000,
                inventory_id: None,
                quantity_sold: 12.0,
                unit_price: 5.0,
                item_discount_percent: 0.0,
                selected_unit: "medium".into(),
                is_negative: false,
            }],
            patient_id: None,
            shift_id: None,
            source_draft_id: None,
            payment_method: "cash".into(),
            check_number: None,
            status: "completed".into(),
            total_discount: 0.0,
            additional_fees: 0.0,
            points_to_redeem: 0,
        };
        let mut tx = conn.begin().await.unwrap();
        let mixed_sale = process_checkout_tx(&mut tx, mixed_payload, 60.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let mixed_10_qty: f64 = sqlx::query_scalar(
            "SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'mixed-10'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let mixed_12_qty: f64 = sqlx::query_scalar(
            "SELECT CAST(quantity AS REAL) FROM inventory WHERE id = 'mixed-12'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!(mixed_10_qty.abs() < 0.000_001);
        assert!((mixed_12_qty - (5.0 / 6.0)).abs() < 0.000_001);

        let mixed_lines = sqlx::query(
            "SELECT inventory_id, CAST(quantity_sold AS REAL) AS quantity_sold FROM sales_items WHERE invoice_id = ? ORDER BY id",
        )
        .bind(&mixed_sale.sale_id)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(mixed_lines.len(), 2);
        assert_eq!(
            mixed_lines[0].try_get::<String, _>("inventory_id").unwrap(),
            "mixed-10"
        );
        assert!(
            (mixed_lines[0].try_get::<f64, _>("quantity_sold").unwrap() - 10.0).abs() < 0.000_001
        );
        assert_eq!(
            mixed_lines[1].try_get::<String, _>("inventory_id").unwrap(),
            "mixed-12"
        );
        assert!(
            (mixed_lines[1].try_get::<f64, _>("quantity_sold").unwrap() - 2.0).abs() < 0.000_001
        );

        let visa_payload = CheckoutPayload {
            pharmacy_id: "qa-pos".into(),
            user_id: "admin".into(),
            items: vec![CheckoutItem {
                drug_id: 5000,
                inventory_id: Some("mixed-12".into()),
                quantity_sold: 1.0,
                unit_price: 1.0,
                item_discount_percent: 0.0,
                selected_unit: "small".into(),
                is_negative: false,
            }],
            patient_id: None,
            shift_id: None,
            source_draft_id: None,
            payment_method: "visa".into(),
            check_number: None,
            status: "completed".into(),
            total_discount: 0.0,
            additional_fees: 0.0,
            points_to_redeem: 0,
        };
        let mut tx = conn.begin().await.unwrap();
        process_checkout_tx(&mut tx, visa_payload, 1.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let bank_debit: f64 = sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(amount), 0) AS REAL) FROM journal_entries WHERE account_id = 13 AND type = 'debit'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!((bank_debit - 1.0).abs() < 0.000_001);

        // A loaded POS draft is a replaceable source record, not a permanent invoice.
        // Re-saving it must keep exactly one draft, completing it must consume the draft,
        // and any later validation failure must roll the source deletion back atomically.
        let mut draft_payload = cash_payload(Some("full"));
        draft_payload.status = "draft".into();
        let mut tx = conn.begin().await.unwrap();
        let first_draft = process_checkout_tx(&mut tx, draft_payload, 69.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let mut failing_resume = cash_payload(Some("empty"));
        failing_resume.source_draft_id = Some(first_draft.sale_id.clone());
        let mut tx = conn.begin().await.unwrap();
        assert!(process_checkout_tx(&mut tx, failing_resume, 69.0)
            .await
            .is_err());
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sales_invoices WHERE id = ? AND status = 'draft'"
            )
            .bind(&first_draft.sale_id)
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1
        );

        let mut replacement_payload = cash_payload(Some("full"));
        replacement_payload.status = "draft".into();
        replacement_payload.source_draft_id = Some(first_draft.sale_id.clone());
        let mut tx = conn.begin().await.unwrap();
        let replacement = process_checkout_tx(&mut tx, replacement_payload, 69.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices WHERE id = ?")
                .bind(&first_draft.sale_id)
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sales_invoices WHERE status = 'draft'"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1
        );

        sqlx::query("UPDATE inventory SET quantity = 2 WHERE id = 'full'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut completed_resume = cash_payload(Some("full"));
        completed_resume.source_draft_id = Some(replacement.sale_id.clone());
        let mut tx = conn.begin().await.unwrap();
        let completed = process_checkout_tx(&mut tx, completed_resume, 69.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices WHERE id = ?")
                .bind(&replacement.sale_id)
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT status FROM sales_invoices WHERE id = ?")
                .bind(&completed.sale_id)
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            "completed"
        );
        let proof_journal: String = sqlx::query_scalar(
            "SELECT journal_id FROM native_sale_cogs_provenance WHERE sale_id=?",
        )
        .bind(&completed.sale_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert!(
            sqlx::query("UPDATE daily_journals SET total_amount=0 WHERE id=?")
                .bind(&proof_journal)
                .execute(&mut conn)
                .await
                .is_err(),
            "new sale and COGS journals are immutable"
        );
        assert!(
            sqlx::query("DELETE FROM sales_items WHERE invoice_id=?")
                .bind(&completed.sale_id)
                .execute(&mut conn)
                .await
                .is_err(),
            "sale-line deletion cannot erase original stock/COGS witnesses"
        );
        assert!(
            sqlx::query("UPDATE sales_invoices SET status='draft' WHERE id=?")
                .bind(&completed.sale_id)
                .execute(&mut conn)
                .await
                .is_err(),
            "sealed completed sale must not be silently reclassified as draft"
        );
        sqlx::query("UPDATE inventory SET quantity=5 WHERE id='full'")
            .execute(&mut conn)
            .await
            .unwrap();
        let checkout_request_id = uuid::Uuid::new_v4().to_string();
        let mut tx = conn.begin().await.unwrap();
        let first = process_checkout_tx_with_request(
            &mut tx,
            cash_payload(Some("full")),
            69.0,
            &checkout_request_id,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let available_after_first: f64 =
            sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id='full'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        let mut tx = conn.begin().await.unwrap();
        let duplicate = process_checkout_tx_with_request(
            &mut tx,
            cash_payload(Some("full")),
            69.0,
            &checkout_request_id,
        )
        .await
        .unwrap_err();
        assert!(duplicate.contains("receipt rejected"), "{duplicate}");
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE id='full'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            available_after_first
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM native_sale_cogs_provenance WHERE request_id=?",
            )
            .bind(&checkout_request_id)
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices WHERE id=?",)
                .bind(&first.sale_id)
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn patient_debt_counts_all_realized_sale_statuses_but_not_drafts() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            "CREATE TABLE patients (id TEXT PRIMARY KEY, opening_balance REAL DEFAULT 0)",
            "CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT, total_amount REAL, payment_method TEXT, status TEXT)",
            "CREATE TABLE returns (invoice_id TEXT, total_refund REAL, refund_method TEXT, status TEXT)",
            "CREATE TABLE patient_transactions (patient_id TEXT, type TEXT, amount REAL, date TEXT, user_id TEXT, notes TEXT)",
            "CREATE TABLE financial_notices (target_type TEXT, target_id TEXT, type TEXT, amount REAL, date TEXT, user_id TEXT, reason TEXT)",
        ] {
            sqlx::query(sql).execute(&mut conn).await.unwrap();
        }
        sqlx::query("INSERT INTO patients VALUES ('p1', 100)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sales_invoices VALUES
             ('completed','p1',10,'credit','completed'),
             ('approved','p1',20,'credit','approved'),
             ('delivered','p1',30,'credit','delivered'),
             ('legacy-null','p1',40,'credit',NULL),
             ('legacy-blank','p1',50,'credit',''),
             ('draft','p1',900,'credit','draft')",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        let mut tx = conn.begin().await.unwrap();
        assert_eq!(
            patient_outstanding_debt(&mut tx, "p1").await.unwrap(),
            250.0
        );
        tx.rollback().await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_native_checkouts_same_lot_commit_once_and_lost_ack_nonce_recovers_receipt() {
        // This is a NEW disposable SQLite database, populated only from the
        // existing in-memory schema. Never open an installed or archived DB.
        struct DisposableRaceDb(std::path::PathBuf);
        impl Drop for DisposableRaceDb {
            fn drop(&mut self) {
                for suffix in ["", "-journal", "-wal", "-shm"] {
                    let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
                }
            }
        }
        let scratch = DisposableRaceDb(std::env::temp_dir().join(format!(
            "pharma-native-pos-race-{}.db",
            Uuid::new_v4()
        )));
        // Match the existing Windows-safe delivery race fixture: seed the
        // unique disposable file directly. VACUUM INTO from an in-memory DB
        // can report success without reliably publishing a reopenable path.
        let seed_options = SqliteConnectOptions::new()
            .filename(&scratch.0)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut seed = current_fresh_schema_on_connection(
            SqliteConnection::connect_with(&seed_options).await.unwrap(),
        ).await;
        sqlx::raw_sql(
            "INSERT INTO users(id,username,role,pharmacy_id,is_active)
               VALUES('race-owner','race-owner','owner','race-tenant',1);
             INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small)
               VALUES(91007,'Race test drug',30,1,1);
             INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,local_selling_price,expiry_date,strips_per_box)
               VALUES('race-lot',91007,'race-tenant',1,12,30,'2099-12-31',1);",
        )
        .execute(&mut seed)
        .await
        .unwrap();
        seed.close().await.unwrap();
        assert!(
            scratch.0.is_file() && std::fs::metadata(&scratch.0).unwrap().len() > 0,
            "the disposable native POS race fixture must exist on disk before reopen"
        );

        let options = SqliteConnectOptions::new()
            .filename(&scratch.0)
            .create_if_missing(false)
            .foreign_keys(true);
        let mut winner_conn = SqliteConnection::connect_with(&options).await.unwrap();
        let mut rival_conn = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("PRAGMA busy_timeout=3000")
            .execute(&mut rival_conn)
            .await
            .unwrap();
        let request = || super::NativeCheckoutRequest {
            items: vec![CheckoutItem {
                drug_id: 91007,
                inventory_id: Some("race-lot".into()),
                quantity_sold: 1.0,
                unit_price: 30.0,
                item_discount_percent: 0.0,
                selected_unit: "large".into(),
                is_negative: false,
            }],
            patient_id: None,
            shift_id: None,
            source_draft_id: None,
            payment_method: "cash".into(),
            check_number: None,
            status: "completed".into(),
            total_discount: 0.0,
            additional_fees: 0.0,
            points_to_redeem: 0,
        };
        let winning_nonce = "a1111111-1111-4111-8111-111111111111";
        let losing_nonce = "b2222222-2222-4222-8222-222222222222";

        // Reserve the SQLite writer on one physical connection before the
        // other begins its *own* native checkout attempt on the same lot.
        let mut winner_tx = begin_critical_transaction(&mut winner_conn).await.unwrap();
        let (attempt_sender, attempt_receiver) = tokio::sync::oneshot::channel::<()>();
        let rival_request = request;
        let rival = tokio::spawn(async move {
            let _ = attempt_sender.send(());
            let mut tx = begin_critical_transaction(&mut rival_conn).await?;
            let owned =
                super::native_checkout_owned_payload(&mut tx, "race-owner", rival_request()).await?;
            let posted =
                process_checkout_tx_with_request(&mut tx, owned, 30.0, losing_nonce).await;
            match posted {
                Ok(sale) => {
                    tx.commit().await.map_err(|e| e.to_string())?;
                    Ok::<_, String>(sale.sale_id)
                }
                Err(error) => {
                    tx.rollback().await.map_err(|e| e.to_string())?;
                    Err(error)
                }
            }
        });
        attempt_receiver.await.unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(
            !rival.is_finished(),
            "competing native checkout must wait for the first SQLite writer"
        );

        let owned =
            super::native_checkout_owned_payload(&mut winner_tx, "race-owner", request())
                .await
                .unwrap();
        let acknowledged =
            process_checkout_tx_with_request(&mut winner_tx, owned, 30.0, winning_nonce)
                .await
                .unwrap();
        assert_eq!(acknowledged.total_amount, 30.0);
        winner_tx.commit().await.unwrap();
        // Simulate an IPC response lost after the real commit.
        drop(acknowledged);
        let competing = tokio::time::timeout(Duration::from_secs(5), rival)
            .await
            .expect("waiting contender must finish after writer commit")
            .unwrap()
            .unwrap_err();
        assert!(
            competing.contains("insufficient stock"),
            "the loser must recheck the committed lot rather than oversell: {competing}"
        );

        // No ACK is needed to recover authoritative original intent: lookup
        // only the immutable 043 native receipt by the persisted UUIDv4 nonce.
        let (sale_id, journal_id, sale_micros, cogs_micros, line_count, snapshot):
            (String, String, i64, i64, i64, String) = sqlx::query_as(
                "SELECT sale_id,journal_id,sale_micros,cogs_micros,line_count,line_snapshot
                 FROM native_sale_cogs_provenance
                 WHERE request_id=? AND pharmacy_id='race-tenant' AND actor_id='race-owner'
                   AND payment_method='cash'",
            )
            .bind(winning_nonce)
            .fetch_one(&mut winner_conn)
            .await
            .unwrap();
        assert_eq!((sale_micros, cogs_micros, line_count), (30_000_000, 12_000_000, 1));
        let source: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
        assert_eq!(source[0]["inventoryId"], "race-lot");
        assert_eq!(source[0]["quantity"], 1.0);
        assert_eq!(source[0]["costPerLarge"], 12.0);
        let (source_status, source_pharmacy, source_actor): (String, String, String) =
            sqlx::query_as("SELECT status,pharmacy_id,user_id FROM sales_invoices WHERE id=?")
                .bind(&sale_id)
                .fetch_one(&mut winner_conn)
                .await
                .unwrap();
        assert_eq!((source_status.as_str(), source_pharmacy.as_str(), source_actor.as_str()),
            ("completed", "race-tenant", "race-owner"));
        let receipts: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_sale_cogs_provenance
             WHERE request_id IN (?,?)",
        )
        .bind(winning_nonce)
        .bind(losing_nonce)
        .fetch_one(&mut winner_conn)
        .await
        .unwrap();
        assert_eq!(receipts, 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM sales_invoices")
                .fetch_one(&mut winner_conn).await.unwrap(),
            1,
            "rejected contender cannot leave a second sale"
        );
        let remaining: f64 = sqlx::query_scalar(
            "SELECT CAST(quantity AS REAL) FROM inventory WHERE id='race-lot'",
        )
        .fetch_one(&mut winner_conn)
        .await
        .unwrap();
        assert_eq!(remaining, 0.0);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM inventory WHERE quantity<0")
                .fetch_one(&mut winner_conn).await.unwrap(),
            0
        );
        let journal: (String, String, f64) = sqlx::query_as(
            "SELECT pharmacy_id,CAST(created_by AS TEXT),CAST(total_amount AS REAL)
             FROM daily_journals WHERE id=?",
        )
        .bind(&journal_id)
        .fetch_one(&mut winner_conn)
        .await
        .unwrap();
        assert_eq!(journal, ("race-tenant".into(), "race-owner".into(), 42.0));
        let entries: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT a.code,je.type,CAST(je.amount AS REAL) FROM journal_entries je
             JOIN accounts a ON a.id=je.account_id WHERE je.journal_id=? ORDER BY a.code",
        )
        .bind(&journal_id)
        .fetch_all(&mut winner_conn)
        .await
        .unwrap();
        assert_eq!(entries, vec![
            ("1.1.1".into(), "debit".into(), 30.0),
            ("1.1.3".into(), "credit".into(), 12.0),
            ("3.1".into(), "credit".into(), 30.0),
            ("4.1".into(), "debit".into(), 12.0),
        ]);

        // Test nonce uniqueness independently of stock exhaustion. The
        // replenishment is uncommitted and rolled back, preserving final stock.
        let mut replay = begin_critical_transaction(&mut winner_conn).await.unwrap();
        sqlx::query("UPDATE inventory SET quantity=1 WHERE id='race-lot'")
            .execute(&mut *replay).await.unwrap();
        let owned =
            super::native_checkout_owned_payload(&mut replay, "race-owner", request())
                .await
                .unwrap();
        let duplicate =
            process_checkout_tx_with_request(&mut replay, owned, 30.0, winning_nonce)
                .await
                .unwrap_err();
        assert!(
            duplicate.contains("receipt rejected"),
            "lost-ACK retry must never double-post the original nonce: {duplicate}"
        );
        replay.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT CAST(quantity AS REAL) FROM inventory WHERE id='race-lot'"
            ).fetch_one(&mut winner_conn).await.unwrap(),
            0.0
        );
        winner_conn.close().await.unwrap();
    }

    #[tokio::test]
    async fn critical_transaction_reserves_the_sqlite_writer_before_validation_reads() {
        let path =
            std::env::temp_dir().join(format!("pharma-critical-immediate-{}.db", Uuid::new_v4()));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut first = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("PRAGMA journal_mode=DELETE")
            .execute(&mut first)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)")
            .execute(&mut first)
            .await
            .unwrap();
        sqlx::query("INSERT INTO probe(id, value) VALUES (1, 1)")
            .execute(&mut first)
            .await
            .unwrap();

        let mut second = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("PRAGMA busy_timeout=50")
            .execute(&mut second)
            .await
            .unwrap();

        let mut tx = begin_critical_transaction(&mut first).await.unwrap();
        let value: i64 = sqlx::query_scalar("SELECT value FROM probe WHERE id=1")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(value, 1);

        let competing_write = sqlx::query("UPDATE probe SET value=2 WHERE id=1")
            .execute(&mut second)
            .await;
        assert!(
            competing_write.is_err(),
            "BEGIN IMMEDIATE must reserve the writer before validation reads"
        );

        sqlx::query("UPDATE probe SET value=3 WHERE id=1")
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();

        sqlx::query("UPDATE probe SET value=4 WHERE id=1")
            .execute(&mut second)
            .await
            .unwrap();
        drop(second);
        drop(first);
        let _ = std::fs::remove_file(path);
    }
}
