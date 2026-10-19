//! Typed owner-only staff management. The authenticated native session owns
//! actor and pharmacy scope; renderer payloads contain only requested fields.
use bcrypt::{hash, DEFAULT_COST};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{Connection, Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;

const PERMISSION_KEYS: &[&str] = &[
    "can_access_pos",
    "can_change_price_sale",
    "can_view_stock_sale",
    "can_sell_no_stock",
    "can_discount_sale_item",
    "can_give_total_discount",
    "max_invoice_discount_percent",
    "can_sell_credit",
    "show_suspended_invoices",
    "suspended_can_save_invoice",
    "can_view_sales",
    "can_view_receipts",
    "can_view_returns",
    "can_make_exchanges",
    "can_view_delivery",
    "can_view_cogs",
    "can_view_settlement",
    "can_view_purchases",
    "can_view_suppliers",
    "can_view_stores",
    "can_manage_inventory",
    "can_modify_unit_conversion",
    "preview_item_movements",
    "can_view_low_stock",
    "can_view_restock",
    "can_view_opening_balances",
    "can_view_patients",
    "can_view_interactions",
    "can_delete_patients",
    "acc_can_view_general",
    "acc_can_view_pos",
    "acc_can_view_bank_accounts",
    "acc_can_define_expenses",
    "acc_can_process_cash_flow",
    "acc_can_view_securities",
    "acc_can_make_daily_entries",
    "acc_can_view_notifications",
    "acc_can_collect_credit_cards",
    "acc_can_view_reports",
    "can_select_pos_financial",
    "can_view_expenses",
    "can_view_shifts",
    "acc_can_view_handover",
    "rep_can_view_sales",
    "rep_can_view_purchases",
    "rep_can_view_financial",
    "rep_can_view_shifts",
    "rep_can_view_activity",
    "can_view_audit",
    "can_view_settings",
    "can_view_staff_manage",
    "can_view_staff_roles",
    "national_id",
    "address",
    "birth_date",
    "qualification",
    "mobile",
    "gender",
    "social_status",
    "is_delivery_rep",
];
const PROFILE_KEYS: &[&str] = &[
    "national_id",
    "address",
    "birth_date",
    "qualification",
    "mobile",
    "gender",
    "social_status",
];
const OWNER_ONLY_KEYS: &[&str] = &[
    "can_view_staff_manage",
    "can_view_staff_roles",
    "rep_can_view_activity",
    "can_view_cogs",
];

#[derive(Debug, Serialize)]
pub struct StaffManagementUser {
    id: String,
    username: String,
    full_name: Option<String>,
    role: Option<String>,
    is_active: i64,
    permissions: Option<String>,
    job_id: Option<i64>,
    qualification: Option<String>,
    hire_date: Option<String>,
    shift: Option<String>,
    code: Option<String>,
    job_name_ar: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct StaffJob {
    id: i64,
    name_ar: String,
    name_en: Option<String>,
    min_salary: Option<f64>,
    max_salary: Option<f64>,
    created_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffManagementData {
    users: Vec<StaffManagementUser>,
    jobs: Vec<StaffJob>,
}

#[derive(Debug, Serialize)]
pub struct StaffMutationResult {
    success: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddStaffInput {
    username: String,
    full_name: String,
    role: String,
    password: Option<String>,
    permissions: Value,
    job_id: Option<i64>,
    qualification: Option<String>,
    hire_date: Option<String>,
    shift: Option<String>,
    code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateStaffInput {
    user_id: String,
    username: String,
    full_name: String,
    role: String,
    password: Option<String>,
    job_id: Option<i64>,
    qualification: Option<String>,
    hire_date: Option<String>,
    shift: Option<String>,
    code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePermissionsInput {
    user_id: String,
    permissions: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResetPasswordInput {
    user_id: String,
    new_password: String,
}

fn valid_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value == value.trim()
        && value.len() <= 128
        && !value.chars().any(char::is_control)
}

fn valid_text(value: &str, max: usize, required: bool) -> bool {
    value.len() <= max
        && !value.chars().any(|c| c == '\0')
        && (!required || !value.trim().is_empty())
}

fn valid_role(role: &str) -> bool {
    matches!(role, "owner" | "admin" | "pharmacist" | "cashier")
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.len() < 8
        || !password.chars().any(|c| c.is_ascii_uppercase())
        || !password.chars().any(|c| c.is_ascii_lowercase())
        || !password.chars().any(|c| c.is_ascii_digit())
        || !password.chars().any(|c| !c.is_ascii_alphanumeric())
    {
        return Err("Password must contain at least 8 characters and uppercase, lowercase, number, and symbol".into());
    }
    Ok(())
}

fn optional_text(value: Option<String>, max: usize) -> Result<Option<String>, String> {
    match value {
        Some(value) if !valid_text(&value, max, false) => Err("Invalid staff profile field".into()),
        Some(value) if value.is_empty() => Ok(None),
        value => Ok(value),
    }
}

fn sanitize_permissions(input: &Value, restrict_owner_only: bool) -> Value {
    let Some(source) = input.as_object() else {
        return Value::Object(Map::new());
    };
    let mut output = Map::new();
    for &key in PERMISSION_KEYS {
        if restrict_owner_only && OWNER_ONLY_KEYS.contains(&key) {
            continue;
        }
        let Some(value) = source.get(key) else {
            continue;
        };
        if PROFILE_KEYS.contains(&key) {
            output.insert(
                key.into(),
                Value::String(value.as_str().unwrap_or_default().into()),
            );
        } else if key == "max_invoice_discount_percent" {
            let number = value
                .as_f64()
                .unwrap_or_else(|| value.as_str().and_then(|v| v.parse().ok()).unwrap_or(0.0));
            output.insert(key.into(), Value::from(number.clamp(0.0, 100.0)));
        } else {
            let enabled = value == &Value::Bool(true)
                || value == &Value::String("true".into())
                || value.as_i64() == Some(1);
            output.insert(key.into(), Value::Bool(enabled));
        }
    }
    Value::Object(output)
}

async fn active_owner(conn: &mut SqliteConnection, actor: &str) -> Result<String, String> {
    let (role, pharmacy) = active_generic_actor(conn, actor).await?;
    if !role.trim().eq_ignore_ascii_case("owner") {
        return Err("Only an active authenticated owner may manage staff".into());
    }
    Ok(pharmacy)
}

async fn begin_write(conn: &mut SqliteConnection) -> Result<Transaction<'_, Sqlite>, String> {
    reset_cancelled_read_state(conn).await?;
    Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
        .await
        .map_err(|e| e.to_string())
}

async fn read_management(
    conn: &mut SqliteConnection,
    actor: &str,
) -> Result<StaffManagementData, String> {
    reset_cancelled_read_state(conn).await?;
    let pharmacy = active_owner(conn, actor).await?;
    let rows = sqlx::query(
        "SELECT CAST(u.id AS TEXT) id,u.username,u.full_name,u.role,COALESCE(u.is_active,1) is_active,u.permissions,
         u.job_id,u.qualification,u.hire_date,u.shift,u.code,ej.name_ar job_name_ar
         FROM users u LEFT JOIN employee_jobs ej ON u.job_id=ej.id
         WHERE COALESCE(u.is_active,1)=1 AND COALESCE(NULLIF(TRIM(u.pharmacy_id),''),'local_default')=?
         ORDER BY u.full_name,u.username",
    )
    .bind(&pharmacy)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let users = rows
        .into_iter()
        .map(|row| {
            Ok(StaffManagementUser {
                id: row.try_get("id").map_err(|e| e.to_string())?,
                username: row.try_get("username").map_err(|e| e.to_string())?,
                full_name: row.try_get("full_name").map_err(|e| e.to_string())?,
                role: row.try_get("role").map_err(|e| e.to_string())?,
                is_active: row.try_get("is_active").map_err(|e| e.to_string())?,
                permissions: row.try_get("permissions").map_err(|e| e.to_string())?,
                job_id: row.try_get("job_id").map_err(|e| e.to_string())?,
                qualification: row.try_get("qualification").map_err(|e| e.to_string())?,
                hire_date: row.try_get("hire_date").map_err(|e| e.to_string())?,
                shift: row.try_get("shift").map_err(|e| e.to_string())?,
                code: row.try_get("code").map_err(|e| e.to_string())?,
                job_name_ar: row.try_get("job_name_ar").map_err(|e| e.to_string())?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let rows = sqlx::query("SELECT id,name_ar,name_en,min_salary,max_salary,created_at FROM employee_jobs ORDER BY name_ar")
        .fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
    let jobs = rows
        .into_iter()
        .map(|row| {
            Ok(StaffJob {
                id: row.try_get("id").map_err(|e| e.to_string())?,
                name_ar: row.try_get("name_ar").map_err(|e| e.to_string())?,
                name_en: row.try_get("name_en").map_err(|e| e.to_string())?,
                min_salary: row.try_get("min_salary").map_err(|e| e.to_string())?,
                max_salary: row.try_get("max_salary").map_err(|e| e.to_string())?,
                created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(StaffManagementData { users, jobs })
}

async fn audit(
    conn: &mut SqliteConnection,
    actor: &str,
    pharmacy: &str,
    action: &str,
    details: String,
) -> Result<(), String> {
    sqlx::query("INSERT INTO activity_log(user_id,action,details,pharmacy_id) VALUES(?,?,?,?)")
        .bind(actor)
        .bind(action)
        .bind(details)
        .bind(pharmacy)
        .execute(conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

async fn add_staff(
    conn: &mut SqliteConnection,
    actor: &str,
    input: AddStaffInput,
) -> Result<StaffMutationResult, String> {
    if !valid_text(&input.username, 256, true)
        || input.username != input.username.trim()
        || !valid_text(&input.full_name, 512, true)
        || !valid_role(&input.role)
    {
        return Err("Invalid staff account fields".into());
    }
    if let Some(password) = input.password.as_deref() {
        validate_password(password)?;
    }
    let qualification = optional_text(input.qualification, 512)?;
    let hire_date = optional_text(input.hire_date, 64)?;
    let shift = optional_text(input.shift, 128)?;
    let code = optional_text(input.code, 128)?;
    let permissions = serde_json::to_string(&sanitize_permissions(
        &input.permissions,
        input.role != "owner",
    ))
    .map_err(|e| e.to_string())?;
    let mut tx = begin_write(conn).await?;
    let pharmacy = active_owner(&mut tx, actor).await?;
    let password_hash = input
        .password
        .as_deref()
        .map(|p| hash(p, DEFAULT_COST).map_err(|e| e.to_string()))
        .transpose()?;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO users(id,username,full_name,role,password_hash,permissions,job_id,qualification,hire_date,shift,code,pharmacy_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(&id).bind(&input.username).bind(&input.full_name).bind(&input.role).bind(password_hash).bind(permissions)
        .bind(input.job_id).bind(qualification).bind(hire_date).bind(shift).bind(code).bind(&pharmacy)
        .execute(&mut *tx).await.map_err(|e| e.to_string())?;
    audit(
        &mut tx,
        actor,
        &pharmacy,
        "ADD_USER",
        format!("Added staff user: {} ({})", input.username, input.role),
    )
    .await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(StaffMutationResult { success: true })
}

async fn update_staff(
    conn: &mut SqliteConnection,
    actor: &str,
    input: UpdateStaffInput,
) -> Result<StaffMutationResult, String> {
    if !valid_id(&input.user_id)
        || !valid_text(&input.username, 256, true)
        || input.username != input.username.trim()
        || !valid_text(&input.full_name, 512, true)
        || !valid_role(&input.role)
    {
        return Err("Invalid staff account fields".into());
    }
    if let Some(password) = input.password.as_deref() {
        validate_password(password)?;
    }
    let qualification = optional_text(input.qualification, 512)?;
    let hire_date = optional_text(input.hire_date, 64)?;
    let shift = optional_text(input.shift, 128)?;
    let code = optional_text(input.code, 128)?;
    let mut tx = begin_write(conn).await?;
    let pharmacy = active_owner(&mut tx, actor).await?;
    let password_hash = input
        .password
        .as_deref()
        .map(|p| hash(p, DEFAULT_COST).map_err(|e| e.to_string()))
        .transpose()?;
    let target_role: Option<String> = sqlx::query_scalar("SELECT role FROM users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1 AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?")
        .bind(&input.user_id).bind(&pharmacy).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
    let target_role =
        target_role.ok_or("Staff user missing, inactive, or belongs to another pharmacy")?;
    if target_role.eq_ignore_ascii_case("owner") && !input.role.eq_ignore_ascii_case("owner") {
        let owners: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE COALESCE(is_active,1)=1 AND LOWER(TRIM(COALESCE(role,'')))='owner' AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?")
            .bind(&pharmacy).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
        if owners <= 1 {
            return Err("Cannot demote the last active owner".into());
        }
    }
    let updated = if let Some(password_hash) = password_hash {
        sqlx::query("UPDATE users SET username=?,full_name=?,role=?,password_hash=?,job_id=?,qualification=?,hire_date=?,shift=?,code=? WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1 AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?")
            .bind(&input.username).bind(&input.full_name).bind(&input.role).bind(password_hash).bind(input.job_id).bind(qualification).bind(hire_date).bind(shift).bind(code).bind(&input.user_id).bind(&pharmacy).execute(&mut *tx).await
    } else {
        sqlx::query("UPDATE users SET username=?,full_name=?,role=?,job_id=?,qualification=?,hire_date=?,shift=?,code=? WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1 AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?")
            .bind(&input.username).bind(&input.full_name).bind(&input.role).bind(input.job_id).bind(qualification).bind(hire_date).bind(shift).bind(code).bind(&input.user_id).bind(&pharmacy).execute(&mut *tx).await
    }.map_err(|e| e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("Staff account changed while being updated".into());
    }
    if target_role.eq_ignore_ascii_case("owner") && input.role != "owner" {
        // A demoted owner must not retain stored owner-only grants that become
        // delegable by role changes, including permissions from legacy data.
        let saved: Option<String> = sqlx::query_scalar(
            "SELECT permissions FROM users WHERE CAST(id AS TEXT)=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(&input.user_id)
        .bind(&pharmacy)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let decoded = saved
            .as_deref()
            .and_then(|value| serde_json::from_str::<Value>(value).ok())
            .unwrap_or(Value::Null);
        let permissions = serde_json::to_string(&sanitize_permissions(&decoded, true))
            .map_err(|e| e.to_string())?;
        sqlx::query("UPDATE users SET permissions=? WHERE CAST(id AS TEXT)=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?")
            .bind(permissions)
            .bind(&input.user_id)
            .bind(&pharmacy)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    audit(
        &mut tx,
        actor,
        &pharmacy,
        "UPDATE_USER",
        format!("Updated staff user: {}", input.username),
    )
    .await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(StaffMutationResult { success: true })
}

async fn update_permissions(
    conn: &mut SqliteConnection,
    actor: &str,
    input: UpdatePermissionsInput,
) -> Result<StaffMutationResult, String> {
    if !valid_id(&input.user_id) {
        return Err("Invalid staff user".into());
    }
    let mut tx = begin_write(conn).await?;
    let pharmacy = active_owner(&mut tx, actor).await?;
    let row = sqlx::query("SELECT username,role FROM users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1 AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?")
        .bind(&input.user_id).bind(&pharmacy).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?.ok_or("Staff user missing, inactive, or belongs to another pharmacy")?;
    let username: String = row.try_get("username").map_err(|e| e.to_string())?;
    let role: Option<String> = row.try_get("role").map_err(|e| e.to_string())?;
    let permissions = serde_json::to_string(&sanitize_permissions(
        &input.permissions,
        !role.as_deref().unwrap_or("").eq_ignore_ascii_case("owner"),
    ))
    .map_err(|e| e.to_string())?;
    let updated = sqlx::query("UPDATE users SET permissions=? WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1 AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?")
        .bind(permissions).bind(&input.user_id).bind(&pharmacy).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("Staff account changed while being updated".into());
    }
    audit(
        &mut tx,
        actor,
        &pharmacy,
        "UPDATE_PERMISSIONS",
        format!("Updated permissions for staff user: {username}"),
    )
    .await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(StaffMutationResult { success: true })
}

async fn reset_password(
    conn: &mut SqliteConnection,
    actor: &str,
    input: ResetPasswordInput,
) -> Result<StaffMutationResult, String> {
    if !valid_id(&input.user_id) {
        return Err("Invalid staff user".into());
    }
    validate_password(&input.new_password)?;
    let mut tx = begin_write(conn).await?;
    let pharmacy = active_owner(&mut tx, actor).await?;
    let password_hash = hash(&input.new_password, DEFAULT_COST).map_err(|e| e.to_string())?;
    let username: Option<String> = sqlx::query_scalar("SELECT username FROM users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1 AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?")
        .bind(&input.user_id).bind(&pharmacy).fetch_optional(&mut *tx).await.map_err(|e| e.to_string())?;
    let username =
        username.ok_or("Staff user missing, inactive, or belongs to another pharmacy")?;
    let updated = sqlx::query("UPDATE users SET password_hash=? WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1 AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?")
        .bind(password_hash).bind(&input.user_id).bind(&pharmacy).execute(&mut *tx).await.map_err(|e| e.to_string())?;
    if updated.rows_affected() != 1 {
        return Err("Staff account changed while being updated".into());
    }
    audit(
        &mut tx,
        actor,
        &pharmacy,
        "PASSWORD_RESET",
        format!("Reset password for staff user: {username}"),
    )
    .await?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(StaffMutationResult { success: true })
}

async fn command_connection(
    app: &tauri::AppHandle,
) -> Result<sqlx::pool::PoolConnection<sqlx::Sqlite>, String> {
    app.try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?
        .0
        .acquire()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_staff_management_data_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<StaffManagementData, String> {
    let actor = session.authorize_session().await?;
    let mut conn = command_connection(&app).await?;
    read_management(&mut conn, actor.as_deref().ok_or("Login required")?).await
}

macro_rules! mutation_command {
    ($name:ident, $input:ty, $handler:ident) => {
        #[tauri::command]
        pub async fn $name(
            app: tauri::AppHandle,
            session: State<'_, LocalSessionState>,
            payload: $input,
        ) -> Result<StaffMutationResult, String> {
            let actor = session.authorize_session().await?;
            let mut conn = command_connection(&app).await?;
            $handler(
                &mut conn,
                actor.as_deref().ok_or("Login required")?,
                payload,
            )
            .await
        }
    };
}
mutation_command!(add_staff_user_native, AddStaffInput, add_staff);
mutation_command!(update_staff_user_native, UpdateStaffInput, update_staff);
mutation_command!(
    update_staff_permissions_native,
    UpdatePermissionsInput,
    update_permissions
);
mutation_command!(
    reset_staff_password_native,
    ResetPasswordInput,
    reset_password
);

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    async fn db() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        db.execute(r#"
          CREATE TABLE employee_jobs(id INTEGER PRIMARY KEY,name_ar TEXT NOT NULL,name_en TEXT,min_salary REAL,max_salary REAL,created_at TEXT);
          CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,full_name TEXT,role TEXT,pharmacy_id TEXT,is_active INTEGER DEFAULT 1,password_hash TEXT,permissions TEXT,job_id INTEGER,qualification TEXT,hire_date TEXT,shift TEXT,code TEXT UNIQUE);
          CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
          INSERT INTO employee_jobs VALUES(1,'صيدلي','Pharmacist',10,20,'2026-01-01');
          INSERT INTO users VALUES
            ('owner-a','owner-a','Owner A','owner','A',1,NULL,'{}',NULL,NULL,NULL,NULL,NULL),
            ('owner-b','owner-b','Owner B','owner','B',1,NULL,'{}',NULL,NULL,NULL,NULL,NULL),
            ('admin-a','admin-a','Admin A','admin','A',1,NULL,'{}',NULL,NULL,NULL,NULL,NULL),
            ('inactive-a','inactive-a','Inactive A','admin','A',0,NULL,'{}',NULL,NULL,NULL,NULL,NULL),
            ('staff-b','staff-b','Staff B','admin','B',1,NULL,'{}',NULL,NULL,NULL,NULL,NULL);
        "#).await.unwrap();
        db
    }

    fn add_input() -> AddStaffInput {
        AddStaffInput {
            username: "new-a".into(),
            full_name: "New A".into(),
            role: "pharmacist".into(),
            password: Some("Strong!Pass1".into()),
            permissions: serde_json::json!({"can_view_sales":true,"unknown":true}),
            job_id: Some(1),
            qualification: Some("BPharm".into()),
            hire_date: Some("2026-10-15".into()),
            shift: Some("morning".into()),
            code: Some("N-1".into()),
        }
    }

    #[tokio::test]
    async fn read_is_live_owner_only_active_and_pharmacy_scoped() {
        let mut db = db().await;
        let data = read_management(&mut db, "owner-a").await.unwrap();
        assert_eq!(
            data.users.iter().map(|u| u.id.as_str()).collect::<Vec<_>>(),
            vec!["admin-a", "owner-a"]
        );
        assert_eq!(data.jobs.len(), 1);
        for denied in ["missing", "inactive-a", "admin-a", "owner-b"] {
            let result = read_management(&mut db, denied).await;
            if denied == "owner-b" {
                assert_eq!(result.unwrap().users.len(), 2);
            } else {
                assert!(result.is_err(), "{denied}");
            }
        }
    }

    #[tokio::test]
    async fn legacy_nullable_active_cashier_is_visible_and_permissions_remain_revocable() {
        let mut db = db().await;
        sqlx::query(
            "UPDATE users SET role='cashier',is_active=NULL,\
             permissions='{\"can_access_pos\":true,\"can_view_interactions\":true}'\
             WHERE id='admin-a'",
        )
        .execute(&mut db)
        .await
        .unwrap();

        let staff = read_management(&mut db, "owner-a").await.unwrap();
        let cashier = staff.users.iter().find(|user| user.id == "admin-a")
            .expect("nullable-active cashier is still login-eligible and must be owner-manageable");
        assert_eq!(cashier.is_active, 1);
        assert!(read_management(&mut db, "admin-a").await.is_err());
        let revoke = || UpdatePermissionsInput {
            user_id: "admin-a".into(),
            permissions: serde_json::json!({
                "can_access_pos": false,
                "can_view_interactions": false,
                "can_view_staff_manage": true
            }),
        };
        for actor in ["admin-a", "owner-b", "inactive-a"] {
            assert!(update_permissions(&mut db, actor, revoke()).await.is_err(), "{actor}");
        }
        update_permissions(&mut db, "owner-a", revoke()).await.unwrap();
        let saved: String = sqlx::query_scalar("SELECT permissions FROM users WHERE id='admin-a'")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), serde_json::json!({
            "can_access_pos": false,
            "can_view_interactions": false
        }));

        db.execute("UPDATE users SET is_active=0 WHERE id='admin-a'").await.unwrap();
        assert!(!read_management(&mut db, "owner-a").await.unwrap().users
            .iter().any(|user| user.id == "admin-a"));
        assert!(update_permissions(&mut db, "owner-a", revoke()).await.is_err());
    }

    #[tokio::test]
    async fn mutations_reject_missing_inactive_nonowner_and_cross_branch_targets() {
        let mut db = db().await;
        for actor in ["missing", "inactive-a", "admin-a"] {
            assert!(add_staff(&mut db, actor, add_input()).await.is_err());
        }
        for target in ["missing", "inactive-a", "staff-b"] {
            assert!(reset_password(
                &mut db,
                "owner-a",
                ResetPasswordInput {
                    user_id: target.into(),
                    new_password: "Strong!Pass1".into()
                }
            )
            .await
            .is_err());
            assert!(update_permissions(
                &mut db,
                "owner-a",
                UpdatePermissionsInput {
                    user_id: target.into(),
                    permissions: serde_json::json!({"can_view_sales":true})
                }
            )
            .await
            .is_err());
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM activity_log")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn ui_advertised_interactions_permission_survives_native_staff_update() {
        let mut db = db().await;
        for allowed in [true, false] {
            update_permissions(
                &mut db,
                "owner-a",
                UpdatePermissionsInput {
                    user_id: "admin-a".into(),
                    permissions: serde_json::json!({
                        "can_view_interactions": allowed,
                        "can_view_patients": false,
                        "can_view_staff_manage": true,
                    }),
                },
            )
            .await
            .unwrap();

            let saved: String =
                sqlx::query_scalar("SELECT permissions FROM users WHERE id='admin-a'")
                    .fetch_one(&mut db)
                    .await
                    .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&saved).unwrap(),
                serde_json::json!({
                    "can_view_interactions": allowed,
                    "can_view_patients": false,
                }),
            );
        }
    }

    #[tokio::test]
    async fn creating_restricted_staff_never_persists_owner_only_permissions() {
        let mut db = db().await;
        let restricted = serde_json::json!({
            "can_access_pos": true,
            "can_view_staff_manage": true,
            "can_view_staff_roles": true,
            "rep_can_view_activity": true,
            "can_view_cogs": true,
        });
        for (username, role) in [
            ("created-admin", "admin"),
            ("created-pharmacist", "pharmacist"),
            ("created-cashier", "cashier"),
        ] {
            let mut input = add_input();
            input.username = username.into();
            input.role = role.into();
            input.code = None;
            input.permissions = restricted.clone();
            add_staff(&mut db, "owner-a", input).await.unwrap();

            let stored: String = sqlx::query_scalar("SELECT permissions FROM users WHERE username=?")
                .bind(username)
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&stored).unwrap(),
                serde_json::json!({ "can_access_pos": true }),
                "owner-only permissions leaked into newly created {role} account",
            );
        }

        let mut owner = add_input();
        owner.username = "second-owner".into();
        owner.role = "owner".into();
        owner.code = None;
        owner.permissions = restricted.clone();
        add_staff(&mut db, "owner-a", owner).await.unwrap();
        let stored: String = sqlx::query_scalar("SELECT permissions FROM users WHERE username='second-owner'")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), restricted);
    }

    #[tokio::test]
    async fn demoting_an_owner_drops_owner_only_permissions() {
        let mut db = db().await;
        sqlx::query("INSERT INTO users(id,username,role,pharmacy_id,is_active) VALUES ('owner-a-2','owner-a-2','owner','A',1)")
            .execute(&mut db).await.unwrap();
        sqlx::query("UPDATE users SET permissions=? WHERE id='owner-a'")
            .bind(r#"{"can_access_pos":true,"can_view_cogs":true,"can_view_staff_manage":true,"can_view_staff_roles":true,"rep_can_view_activity":true}"#)
            .execute(&mut db).await.unwrap();

        update_staff(
            &mut db,
            "owner-a-2",
            UpdateStaffInput {
                user_id: "owner-a".into(),
                username: "owner-a".into(),
                full_name: "Former Owner".into(),
                role: "pharmacist".into(),
                password: None,
                job_id: None,
                qualification: None,
                hire_date: None,
                shift: None,
                code: None,
            },
        )
        .await.unwrap();

        let row = sqlx::query("SELECT role,permissions FROM users WHERE id='owner-a'")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(row.get::<String, _>("role"), "pharmacist");
        let stored: String = row.get("permissions");
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(),
            serde_json::json!({"can_access_pos": true}));
    }

    #[tokio::test]
    async fn success_preserves_unrelated_fields_scopes_data_and_audits() {
        let mut db = db().await;
        add_staff(&mut db, "owner-a", add_input()).await.unwrap();
        let id: String = sqlx::query_scalar("SELECT id FROM users WHERE username='new-a'")
            .fetch_one(&mut db)
            .await
            .unwrap();
        update_staff(
            &mut db,
            "owner-a",
            UpdateStaffInput {
                user_id: id.clone(),
                username: "new-a-2".into(),
                full_name: "New Name".into(),
                role: "admin".into(),
                password: None,
                job_id: None,
                qualification: None,
                hire_date: None,
                shift: None,
                code: None,
            },
        )
        .await
        .unwrap();
        update_permissions(&mut db, "owner-a", UpdatePermissionsInput { user_id: id.clone(), permissions: serde_json::json!({"can_view_sales":true,"can_view_cogs":true,"can_view_staff_manage":true,"unknown":true}) }).await.unwrap();
        reset_password(
            &mut db,
            "owner-a",
            ResetPasswordInput {
                user_id: id.clone(),
                new_password: "Other!Pass2".into(),
            },
        )
        .await
        .unwrap();
        let row = sqlx::query("SELECT username,full_name,role,pharmacy_id,is_active,password_hash,permissions FROM users WHERE id=?").bind(id).fetch_one(&mut db).await.unwrap();
        assert_eq!(row.get::<String, _>("username"), "new-a-2");
        assert_eq!(row.get::<String, _>("full_name"), "New Name");
        assert_eq!(row.get::<String, _>("role"), "admin");
        assert_eq!(row.get::<String, _>("pharmacy_id"), "A");
        assert_eq!(row.get::<i64, _>("is_active"), 1);
        assert!(bcrypt::verify("Other!Pass2", &row.get::<String, _>("password_hash")).unwrap());
        assert_eq!(
            row.get::<String, _>("permissions"),
            r#"{"can_view_sales":true}"#
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM activity_log WHERE pharmacy_id='A'")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            4
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE pharmacy_id='B'")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            2
        );
    }
}
