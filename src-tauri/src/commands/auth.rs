use crate::licensing::LicenseGuard;
use bcrypt::{hash, verify, DEFAULT_COST};
use serde::Serialize;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, SqliteConnection};
use tauri::{Manager, State};

#[derive(Default)]
// ponytail: one app-wide lock preserves existing shared-login semantics;
// use per-window sessions only if independent window logins are needed.
pub struct LocalSessionState(tokio::sync::RwLock<Option<String>>);

impl LocalSessionState {
    pub(crate) async fn authorize_session(
        &self,
    ) -> Result<tokio::sync::RwLockReadGuard<'_, Option<String>>, String> {
        let actor = self.0.read().await;
        if actor.is_none() {
            return Err("Login required before changing pharmacy records".into());
        }
        Ok(actor)
    }

    // Keep the login/logout lock until the native financial transaction ends.
    // A renderer-controlled user_id cannot stand in for a logged-in actor.
    pub(crate) async fn authorize_actor(
        &self,
        requested_user_id: &str,
    ) -> Result<tokio::sync::RwLockReadGuard<'_, Option<String>>, String> {
        let actor = self.0.read().await;
        match actor.as_deref() {
            Some(id) if !requested_user_id.trim().is_empty() && id == requested_user_id.trim() => {
                Ok(actor)
            }
            Some(_) => Err("Authenticated user does not match transaction actor".into()),
            None => Err("Login required before changing pharmacy records".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalUser {
    pub id: String,
    pub username: String,
    pub role: Option<String>,
    pub full_name: Option<String>,
    pub pharmacy_id: Option<String>,
    pub permissions: Option<String>,
}

#[derive(Serialize)]
pub struct LocalLoginResult {
    pub success: bool,
    pub user: Option<LocalUser>,
    pub error: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct LocalStaffSummary {
    id: String,
    username: String,
    full_name: Option<String>,
    role: Option<String>,
    has_password: bool,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct StaffDirectoryEntry {
    id: String,
    username: String,
    full_name: Option<String>,
    role: Option<String>,
    is_active: i64,
    job_name_ar: Option<String>,
    job_name_en: Option<String>,
}

// The basic staff selector is shared by shift workflows across roles.
// Derive its tenant from the native authenticated actor, never renderer SQL.
async fn list_staff_directory_on_connection(
    conn: &mut SqliteConnection,
    actor_id: &str,
) -> Result<Vec<StaffDirectoryEntry>, String> {
    let (_, pharmacy) = super::critical::active_generic_actor(conn, actor_id).await?;
    let rows = sqlx::query(
        "SELECT CAST(u.id AS TEXT) AS id, u.username, u.full_name, u.role, COALESCE(u.is_active,1) AS is_active, \
         ej.name_ar AS job_name_ar, ej.name_en AS job_name_en \
         FROM users u LEFT JOIN employee_jobs ej ON u.job_id = ej.id \
         WHERE COALESCE(u.is_active,1) = 1 \
         AND COALESCE(NULLIF(TRIM(u.pharmacy_id),''),'local_default') = ? \
         ORDER BY u.full_name ASC, u.username ASC",
    )
    .bind(&pharmacy)
    .fetch_all(conn)
    .await
    .map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|row| {
            Ok(StaffDirectoryEntry {
                id: row.try_get("id").map_err(|e| e.to_string())?,
                username: row.try_get("username").map_err(|e| e.to_string())?,
                full_name: row.try_get("full_name").map_err(|e| e.to_string())?,
                role: row.try_get("role").map_err(|e| e.to_string())?,
                is_active: row.try_get("is_active").map_err(|e| e.to_string())?,
                job_name_ar: row.try_get("job_name_ar").map_err(|e| e.to_string())?,
                job_name_en: row.try_get("job_name_en").map_err(|e| e.to_string())?,
            })
        })
        .collect()
}

// Privileged credential lookups stay in native code. Generic renderer SQL
// cannot obtain password_hash, even indirectly through COUNT/CASE/SELECT *.
async fn list_staff_summaries_on_connection(
    conn: &mut SqliteConnection,
    actor_id: &str,
) -> Result<Vec<LocalStaffSummary>, String> {
    let (role, pharmacy) = super::critical::active_generic_actor(conn, actor_id).await?;
    if !role.trim().eq_ignore_ascii_case("owner") {
        return Err("Only the owner can list local staff".into());
    }
    let rows = sqlx::query(
        "SELECT CAST(id AS TEXT) AS id, username, full_name, role, \
         CASE WHEN password_hash IS NOT NULL AND password_hash != '' THEN 1 ELSE 0 END AS has_password \
         FROM users WHERE COALESCE(is_active, 1) = 1 \
         AND COALESCE(NULLIF(TRIM(pharmacy_id), ''), 'local_default') = ? ORDER BY username"
    ).bind(pharmacy).fetch_all(conn).await.map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|row| {
            Ok(LocalStaffSummary {
                id: row.try_get("id").map_err(|e| e.to_string())?,
                username: row.try_get("username").map_err(|e| e.to_string())?,
                full_name: row.try_get("full_name").map_err(|e| e.to_string())?,
                role: row.try_get("role").map_err(|e| e.to_string())?,
                has_password: row
                    .try_get::<i64, _>("has_password")
                    .map_err(|e| e.to_string())?
                    == 1,
            })
        })
        .collect()
}

pub(crate) async fn verify_handover_password_on_connection(
    conn: &mut SqliteConnection,
    actor_id: &str,
    kind: &str,
    username: Option<&str>,
    password: &str,
) -> Result<Option<String>, String> {
    let (role, pharmacy) = super::critical::active_generic_actor(conn, actor_id).await?;
    // Match native login semantics: existing passwords are not byte-capped.
    // A length cutoff here would strand holders of long UTF-8 passwords.
    if password.is_empty() {
        return Ok(None);
    }
    let row = match kind {
        "authorizer" => {
            if !role.trim().eq_ignore_ascii_case("owner") {
                return Err("Owner authorization required".into());
            }
            sqlx::query(
                "SELECT CAST(id AS TEXT) AS id, password_hash FROM users \
                WHERE CAST(id AS TEXT) = ? AND COALESCE(is_active, 1) = 1 \
                AND COALESCE(NULLIF(TRIM(pharmacy_id), ''), 'local_default') = ?",
            )
            .bind(actor_id)
            .bind(&pharmacy)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|e| e.to_string())?
        }
        "receiver" => {
            let requested = username.unwrap_or("").trim();
            if requested.is_empty() || requested.len() > 256 {
                return Ok(None);
            }
            sqlx::query(
                "SELECT CAST(id AS TEXT) AS id, password_hash FROM users \
                WHERE username = ? AND COALESCE(is_active, 1) = 1 \
                AND COALESCE(NULLIF(TRIM(pharmacy_id), ''), 'local_default') = ?",
            )
            .bind(requested)
            .bind(&pharmacy)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|e| e.to_string())?
        }
        _ => return Err("Unsupported handover credential operation".into()),
    };
    let Some(row) = row else { return Ok(None) };
    let stored: Option<String> = row.try_get("password_hash").map_err(|e| e.to_string())?;
    let Some(stored) = stored.filter(|hash| !hash.is_empty()) else {
        return Ok(None);
    };
    if verify("admin", &stored).unwrap_or(false) || !verify(password, &stored).unwrap_or(false) {
        return Ok(None);
    }
    row.try_get("id").map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_staff_directory(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<Vec<StaffDirectoryEntry>, String> {
    let actor = session.authorize_session().await?;
    let mut conn = auth_connection(&app).await?;
    list_staff_directory_on_connection(&mut conn, actor.as_deref().unwrap()).await
}

#[tauri::command]
pub async fn list_local_staff_summaries(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<Vec<LocalStaffSummary>, String> {
    let actor = session.authorize_session().await?;
    let mut conn = auth_connection(&app).await?;
    list_staff_summaries_on_connection(&mut conn, actor.as_deref().unwrap()).await
}

#[tauri::command]
pub async fn verify_handover_credentials(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    kind: String,
    username: Option<String>,
    password: String,
) -> Result<Option<String>, String> {
    let actor = session.authorize_session().await?;
    let mut conn = auth_connection(&app).await?;
    verify_handover_password_on_connection(
        &mut conn,
        actor.as_deref().unwrap(),
        &kind,
        username.as_deref(),
        &password,
    )
    .await
}

fn login_failure(error: &str) -> LocalLoginResult {
    LocalLoginResult {
        success: false,
        user: None,
        error: Some(error.to_string()),
    }
}

// The historical published seed contains a universal password for the
// canonical owner. Never allow it to create a native session, even on an
// upgraded installation with other staff/business records. An owner who
// already changed their password remains unaffected.
fn owner_uses_public_seed_password(stored_hash: &str) -> bool {
    // current_local_user is invoked repeatedly by page guards. Bcrypt is
    // intentionally expensive; the same immutable bcrypt hash always yields
    // the same answer. Cache only that comparison, never the actor, role,
    // active state, tenant, or permissions (all are read from SQLite anew).
    // Exact hash equality also invalidates this result on password rotation.
    static LAST_CHECK: std::sync::OnceLock<std::sync::Mutex<Option<(String, bool)>>> =
        std::sync::OnceLock::new();
    let mut last = LAST_CHECK
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((previous_hash, result)) = last.as_ref() {
        if previous_hash == stored_hash {
            return *result;
        }
    }
    let result = verify("admin", stored_hash).unwrap_or(false);
    *last = Some((stored_hash.to_owned(), result));
    result
}

pub(crate) async fn owner_enrollment_pending_on_connection(
    conn: &mut SqliteConnection,
) -> Result<bool, String> {
    let row = sqlx::query(
        "SELECT role, password_hash, COALESCE(is_active, 1) AS active \
         FROM users WHERE CAST(id AS TEXT) = 'admin' LIMIT 1",
    )
    .fetch_optional(conn)
    .await
    .map_err(|e| e.to_string())?;
    let Some(row) = row else { return Ok(false) };
    let role: Option<String> = row.try_get("role").map_err(|e| e.to_string())?;
    let active: i64 = row.try_get("active").map_err(|e| e.to_string())?;
    if role.as_deref() != Some("owner") || active != 1 {
        return Ok(false);
    }
    let stored: Option<String> = row.try_get("password_hash").map_err(|e| e.to_string())?;
    Ok(stored.as_deref().map_or(true, |value| {
        value.is_empty() || owner_uses_public_seed_password(value)
    }))
}

// Licensing's DPAPI-protected online renewal credential is never returned
// over IPC. The operator must know and re-enter the original activation code.
// Manual signed-license installs without that stored proof fail closed.
fn valid_operator_enrollment_proof(
    stored: &[u8],
    supplied: &str,
    license_id: &str,
    fingerprint: &str,
) -> bool {
    if supplied.len() != 43
        || !supplied
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(stored) else {
        return false;
    };
    if value.get("license_id").and_then(|v| v.as_str()) != Some(license_id)
        || value.get("machine_fingerprint").and_then(|v| v.as_str()) != Some(fingerprint)
    {
        return false;
    }
    let Some(expected) = value.get("activation_code").and_then(|v| v.as_str()) else {
        return false;
    };
    if expected.len() != 43 {
        return false;
    }
    // Fixed-size, length-checked byte comparison. Do not log either secret.
    let mismatch = supplied
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    mismatch == 0
}

fn validate_owner_enrollment_password(password: &str) -> Result<(), String> {
    let bytes = password.len();
    if !(14..=72).contains(&bytes)
        || password.chars().any(|c| c.is_control())
        || !password.bytes().any(|b| b.is_ascii_lowercase())
        || !password.bytes().any(|b| b.is_ascii_uppercase())
        || !password.bytes().any(|b| b.is_ascii_digit())
        || !password.bytes().any(|b| b.is_ascii_punctuation())
        || password.to_ascii_lowercase().contains("admin")
    {
        return Err("Owner password must be 14-72 bytes with upper/lowercase letters, digits and symbols, without 'admin'".into());
    }
    Ok(())
}

// Called only after native DPAPI/license proof verification; never pass a
// renderer-supplied actor, pharmacy ID, SQL, or authorization boolean.
pub(crate) async fn enroll_owner_on_connection(
    conn: &mut SqliteConnection,
    new_password: &str,
) -> Result<(), String> {
    enroll_owner_on_connection_with_mode(conn, new_password, false).await
}

/// Only the pristine seeded, single-owner profile may enroll using a
/// machine-bound signed offline-term license. An old unclaimed historical
/// archive must never become the owner's simply because a license was issued.
async fn fresh_empty_business_profile(conn: &mut SqliteConnection) -> Result<bool, String> {
    let other_users: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM users WHERE CAST(id AS TEXT) <> 'admin'",
    ).fetch_one(&mut *conn).await.map_err(|_| "Offline owner setup requires a fresh pharmacy profile")?;
    if other_users != 0 {
        return Ok(false);
    }
    // These are fixed application schema names, never renderer input.
    // Require every table and zero historical financial/stock/customer
    // records, including a preexisting audit trail, before owner bootstrap.
    for table in [
        "activity_log", "patients", "suppliers", "inventory",
        "sales_invoices", "sales_items", "purchase_invoices",
        "purchase_invoice_items", "purchase_returns", "purchase_return_items",
        "returns", "return_items", "stock_adjustments", "cash_movements",
        "patient_transactions", "supplier_transactions", "daily_journals",
        "journal_entries",
    ] {
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{table}\""))
            .fetch_one(&mut *conn).await
            .map_err(|_| "Offline owner setup requires a fresh pharmacy profile")?;
        if count != 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn enroll_owner_on_connection_with_mode(
    conn: &mut SqliteConnection,
    new_password: &str,
    offline_fresh_only: bool,
) -> Result<(), String> {
    validate_owner_enrollment_password(new_password)?;
    let new_hash = hash(new_password, DEFAULT_COST).map_err(|e| e.to_string())?;
    // A write reservation before reading the row serializes competing
    // processes/windows. A loser observes the committed password and fails.
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    let operation = async {
        // Evaluate the empty-business invariant AFTER BEGIN IMMEDIATE, not
        // before it: no concurrent writer can slip historical rows in between.
        if offline_fresh_only && !fresh_empty_business_profile(conn).await? {
            return Err("Offline owner setup is only available on a new empty pharmacy".into());
        }
        if !owner_enrollment_pending_on_connection(conn).await? {
            return Err("Owner enrollment is not available".to_string());
        }
        let updated = sqlx::query(
            "UPDATE users SET password_hash = ? WHERE id = 'admin' \
             AND role = 'owner' AND COALESCE(is_active, 1) = 1",
        )
        .bind(&new_hash)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            return Err("Owner enrollment state changed".into());
        }
        sqlx::query(
            "INSERT INTO activity_log(user_id, action, details) \
             VALUES ('admin', 'OWNER_ENROLLED', 'Initial native owner password configured')",
        )
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    }
    .await;
    match operation {
        Ok(()) => {
            sqlx::query("COMMIT")
                .execute(conn)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(conn).await;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn owner_enrollment_status(app: tauri::AppHandle) -> Result<bool, String> {
    let mut conn = auth_connection(&app).await?;
    owner_enrollment_pending_on_connection(&mut conn).await
}

#[tauri::command]
pub async fn enroll_initial_owner(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    transactions: State<'_, super::critical::DbTransactions>,
    activation_code: String,
    new_password: String,
) -> Result<(), String> {
    // No existing actor may be carried into a sensitive setup transition.
    let actor = session.0.write().await;
    if actor.is_some() {
        return Err("Log out before owner enrollment".into());
    }
    transactions.rollback_all().await?;
    let guard = app.state::<LicenseGuard>();
    guard.enforce()?;
    let status = guard.status();
    if !status.valid || !status.startup_ready {
        return Err("A valid, restarted license is required".into());
    }
    if status.offline_term && activation_code.is_empty() {
        // A genuinely signed, valid, machine-bound offline-term grant was
        // already verified by LicenseGuard. It authorizes FIRST enrollment
        // of a business-empty, fresh seed only. This is not a path to adopt
        // old pharmacy data, or to skip the historic finance/owner guard.
        let mut conn = auth_connection(&app).await?;
        return enroll_owner_on_connection_with_mode(
            &mut conn, &new_password, true,
        ).await;
    }
    let stored = guard
        .load_online_credential()
        .map_err(|_| "Online activation proof is required to enroll the owner")?;
    if !valid_operator_enrollment_proof(
        &stored,
        &activation_code,
        status.license_id.as_deref().unwrap_or(""),
        &status.machine_fingerprint,
    ) {
        return Err("Operator activation proof rejected".into());
    }
    let mut conn = auth_connection(&app).await?;
    enroll_owner_on_connection(&mut conn, &new_password).await
}

async fn auth_connection(app: &tauri::AppHandle) -> Result<SqliteConnection, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .busy_timeout(std::time::Duration::from_secs(5))
        .foreign_keys(true);
    SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())
}

pub(crate) async fn authenticate_on_connection(
    conn: &mut SqliteConnection,
    username: &str,
    password: &str,
) -> Result<LocalLoginResult, String> {
    let username = username.trim();
    if owner_enrollment_pending_on_connection(conn).await? {
        return Ok(login_failure(
            "Owner enrollment required before local login",
        ));
    }
    let row = sqlx::query(
        "SELECT CAST(id AS TEXT) AS id, username, role, full_name, pharmacy_id, permissions, password_hash, COALESCE(is_active,1) AS active FROM users WHERE username = ? LIMIT 1"
    ).bind(username).fetch_optional(&mut *conn).await.map_err(|e| e.to_string())?;

    let Some(row) = row else {
        sqlx::query(
            "INSERT INTO activity_log (user_id, action, details) VALUES (NULL, 'LOGIN_FAILED', ?)",
        )
        .bind(format!("محاولة دخول فاشلة: المستخدم {username} غير موجود"))
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        return Ok(login_failure("المستخدم غير موجود"));
    };
    let id: String = row.try_get("id").map_err(|e| e.to_string())?;
    if row.try_get::<i64, _>("active").unwrap_or(0) != 1 {
        sqlx::query(
            "INSERT INTO activity_log (user_id, action, details) VALUES (?, 'LOGIN_FAILED', ?)",
        )
        .bind(&id)
        .bind("محاولة دخول فاشلة: الحساب غير نشط")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        return Ok(login_failure("الحساب غير نشط"));
    }
    let stored_hash: Option<String> = row.try_get("password_hash").map_err(|e| e.to_string())?;
    let Some(stored_hash) = stored_hash.filter(|h| !h.is_empty()) else {
        sqlx::query(
            "INSERT INTO activity_log (user_id, action, details) VALUES (?, 'LOGIN_FAILED', ?)",
        )
        .bind(&id)
        .bind("محاولة دخول فاشلة: الحساب غير مهيأ")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        return Ok(login_failure(
            "الحساب غير مهيأ. اطلب من المالك تعيين كلمة مرور.",
        ));
    };
    if verify("admin", &stored_hash).unwrap_or(false) {
        return Ok(login_failure(
            "Public default credentials are disabled; enroll the owner",
        ));
    }
    if password.trim().is_empty() || !verify(password, &stored_hash).unwrap_or(false) {
        sqlx::query(
            "INSERT INTO activity_log (user_id, action, details) VALUES (?, 'LOGIN_FAILED', ?)",
        )
        .bind(&id)
        .bind("محاولة دخول فاشلة: كلمة مرور خاطئة")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        return Ok(login_failure("كلمة المرور غير صحيحة"));
    }

    // Installed native migration 053 quarantines legacy owner scopes when
    // another tenant is visible in any commercial or finance source. This
    // check reads an immutable native marker, never a renderer-supplied role,
    // tenant, or approval. It is deliberately after password verification:
    // unauthenticated callers cannot enumerate disputed owner accounts.
    let scope_review_installed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='native_owner_scope_review'",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if scope_review_installed != 0 {
        let disputed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_owner_scope_review WHERE owner_id=?",
        )
        .bind(&id)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        let role: Option<String> = row.try_get("role").map_err(|e| e.to_string())?;
        let pharmacy: Option<String> =
            row.try_get("pharmacy_id").map_err(|e| e.to_string())?;
        let unscoped_owner = role
            .as_deref()
            .is_some_and(|role| role.eq_ignore_ascii_case("owner"))
            && pharmacy.as_deref().unwrap_or("").trim().is_empty();
        if disputed != 0 || unscoped_owner {
            sqlx::query(
                "INSERT INTO activity_log(user_id,action,details) VALUES (?,'LOGIN_FAILED','Owner tenant scope requires independent review')",
            )
            .bind(&id)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
            return Ok(login_failure("Owner tenant scope requires independent review"));
        }
    }

    let user = LocalUser {
        id,
        username: row.try_get("username").map_err(|e| e.to_string())?,
        role: row.try_get("role").map_err(|e| e.to_string())?,
        full_name: row.try_get("full_name").map_err(|e| e.to_string())?,
        pharmacy_id: row.try_get("pharmacy_id").map_err(|e| e.to_string())?,
        permissions: row.try_get("permissions").map_err(|e| e.to_string())?,
    };
    sqlx::query("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'LOGIN', ?)")
        .bind(&user.id)
        .bind(format!(
            "تسجيل دخول للمستخدم: {}",
            user.full_name.as_deref().unwrap_or(&user.username)
        ))
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(LocalLoginResult {
        success: true,
        user: Some(user),
        error: None,
    })
}

async fn authenticate_and_set_actor(
    actor: &mut Option<String>,
    conn: &mut SqliteConnection,
    username: &str,
    password: &str,
) -> Result<LocalLoginResult, String> {
    let result = authenticate_on_connection(conn, username, password).await?;
    if let Some(user) = &result.user {
        *actor = Some(user.id.clone())
    }
    Ok(result)
}

#[tauri::command]
pub async fn authenticate_local(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    transactions: State<'_, super::critical::DbTransactions>,
    username: String,
    password: String,
) -> Result<LocalLoginResult, String> {
    let mut actor = session.0.write().await;
    // Login audit writes also need the previous renderer's writer lock released.
    transactions.rollback_all().await?;
    let mut conn = auth_connection(&app).await?;
    if owner_enrollment_pending_on_connection(&mut conn).await? {
        *actor = None;
        return Ok(login_failure(
            "Owner enrollment required before local login",
        ));
    }
    authenticate_and_set_actor(&mut actor, &mut conn, &username, &password).await
}

#[tauri::command]
pub async fn current_local_user(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    transactions: State<'_, super::critical::DbTransactions>,
) -> Result<Option<LocalUser>, String> {
    let actor = session.0.read().await;
    let Some(actor_id) = actor.clone() else {
        return Ok(None);
    };
    let mut conn = auth_connection(&app).await?;
    if owner_enrollment_pending_on_connection(&mut conn).await? {
        drop(actor);
        transactions.rollback_all().await?;
        *session.0.write().await = None;
        return Ok(None);
    }
    let row = sqlx::query(
        "SELECT CAST(id AS TEXT) AS id, username, role, full_name, pharmacy_id, permissions FROM users WHERE CAST(id AS TEXT) = ? AND COALESCE(is_active,1) = 1"
    ).bind(&actor_id).fetch_optional(&mut conn).await.map_err(|e| e.to_string())?;
    let Some(row) = row else {
        drop(actor);
        let mut actor = session.0.write().await;
        if actor.as_deref() == Some(actor_id.as_str()) {
            transactions.rollback_all().await?;
            *actor = None;
        }
        return Ok(None);
    };
    let user = LocalUser {
        id: row.try_get("id").map_err(|e| e.to_string())?,
        username: row.try_get("username").map_err(|e| e.to_string())?,
        role: row.try_get("role").map_err(|e| e.to_string())?,
        full_name: row.try_get("full_name").map_err(|e| e.to_string())?,
        pharmacy_id: row.try_get("pharmacy_id").map_err(|e| e.to_string())?,
        permissions: row.try_get("permissions").map_err(|e| e.to_string())?,
    };
    Ok(Some(user))
}

#[tauri::command]
pub async fn logout_local(
    session: State<'_, LocalSessionState>,
    transactions: State<'_, super::critical::DbTransactions>,
) -> Result<(), String> {
    let mut actor = session.0.write().await;
    *actor = None;
    transactions.rollback_all().await
}

#[tauri::command]
pub fn bcrypt_hash(password: String) -> Result<String, String> {
    hash(password, DEFAULT_COST).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn bcrypt_compare(password: String, hash: String) -> Result<bool, String> {
    verify(password, &hash).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enrollment_users_sql() -> &'static str {
        "CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, full_name TEXT, \
         pharmacy_id TEXT, permissions TEXT, password_hash TEXT, is_active INTEGER); \
         CREATE TABLE activity_log (id INTEGER PRIMARY KEY, user_id TEXT, action TEXT, details TEXT);"
    }

    #[tokio::test]
    async fn manual_offline_owner_setup_only_accepts_business_empty_single_owner_seed() {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(enrollment_users_sql()).execute(&mut db).await.unwrap();
        for name in [
            "patients", "suppliers", "inventory", "sales_invoices",
            "sales_items", "purchase_invoices", "purchase_invoice_items",
            "purchase_returns", "purchase_return_items", "returns",
            "return_items", "stock_adjustments", "cash_movements",
            "patient_transactions", "supplier_transactions",
            "daily_journals", "journal_entries",
        ] {
            sqlx::raw_sql(&format!("CREATE TABLE \"{name}\" (id TEXT)"))
                .execute(&mut db).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO users(id,username,role,password_hash,is_active) VALUES('admin','admin','owner',NULL,1)",
        ).execute(&mut db).await.unwrap();
        assert!(fresh_empty_business_profile(&mut db).await.unwrap());
        // The valid signed offline-term grant is checked by LicenseGuard;
        // this inner test verifies the DB race-bound invariant independently.
        enroll_owner_on_connection_with_mode(
            &mut db, "S3cure!OfflineOwner2026", true,
        ).await.unwrap();
        assert!(!owner_enrollment_pending_on_connection(&mut db).await.unwrap());
        assert!(authenticate_on_connection(
            &mut db, "admin", "S3cure!OfflineOwner2026",
        ).await.unwrap().success);
        assert!(enroll_owner_on_connection_with_mode(
            &mut db, "N3xt!OfflineOwner2026", true,
        ).await.is_err(), "A consumed enrollment cannot be replayed");
    }

    #[tokio::test]
    async fn manual_offline_owner_setup_never_claims_business_history_or_staff() {
        for dirty_table in ["sales_invoices", "patients", "journal_entries"] {
            let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
            sqlx::raw_sql(enrollment_users_sql()).execute(&mut db).await.unwrap();
            for name in [
                "patients", "suppliers", "inventory", "sales_invoices",
                "sales_items", "purchase_invoices", "purchase_invoice_items",
                "purchase_returns", "purchase_return_items", "returns",
                "return_items", "stock_adjustments", "cash_movements",
                "patient_transactions", "supplier_transactions",
                "daily_journals", "journal_entries",
            ] {
                sqlx::raw_sql(&format!("CREATE TABLE \"{name}\" (id TEXT)"))
                    .execute(&mut db).await.unwrap();
            }
            sqlx::query(
                "INSERT INTO users(id,username,role,password_hash,is_active) VALUES('admin','admin','owner',NULL,1)",
            ).execute(&mut db).await.unwrap();
            sqlx::query(&format!("INSERT INTO \"{dirty_table}\" VALUES('original-history')"))
                .execute(&mut db).await.unwrap();
            assert!(!fresh_empty_business_profile(&mut db).await.unwrap());
            assert!(enroll_owner_on_connection_with_mode(
                &mut db, "S3cure!OfflineOwner2026", true,
            ).await.is_err(), "Historical {dirty_table} must refuse offline owner adoption");
            assert!(owner_enrollment_pending_on_connection(&mut db).await.unwrap());
            let unchanged: i64 = sqlx::query_scalar(
                &format!("SELECT COUNT(*) FROM \"{dirty_table}\""),
            ).fetch_one(&mut db).await.unwrap();
            assert_eq!(unchanged, 1);
        }
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(enrollment_users_sql()).execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO users(id,role,is_active) VALUES('admin','owner',1),('staff','cashier',1)")
            .execute(&mut db).await.unwrap();
        assert!(!fresh_empty_business_profile(&mut db).await.unwrap(),
            "Extra staff must refuse even when business tables are absent");
    }

    #[tokio::test]
    async fn repeated_native_session_owner_probe_is_fast_and_observes_password_rotation() {
        // Models current_local_user's native enrollment check on every page.
        // Only synthetic in-memory state is used, and role/hash are read anew.
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(enrollment_users_sql())
            .execute(&mut conn)
            .await
            .unwrap();
        let safe_hash = hash("Rotated!OwnerPassword2026", 10).unwrap();
        sqlx::query(
            "INSERT INTO users(id,username,role,password_hash,is_active) VALUES('admin','admin','owner',?,1)"
        )
        .bind(&safe_hash)
        .execute(&mut conn)
        .await
        .unwrap();

        assert!(!owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
        let start = std::time::Instant::now();
        for _ in 0..8 {
            assert!(!owner_enrollment_pending_on_connection(&mut conn)
                .await
                .unwrap());
        }
        let duration = start.elapsed();
        eprintln!("eight native owner session probes after warmup: {duration:?}");
        assert!(
            duration < std::time::Duration::from_millis(200),
            "unchanged owner hashes must not re-run expensive bcrypt on every page: {duration:?}"
        );

        let unsafe_hash = hash("admin", 4).unwrap();
        sqlx::query("UPDATE users SET password_hash=? WHERE id='admin'")
            .bind(unsafe_hash)
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
        sqlx::query("UPDATE users SET role='pharmacist' WHERE id='admin'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(!owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
        sqlx::query("UPDATE users SET role='owner' WHERE id='admin'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
        sqlx::query("UPDATE users SET password_hash=? WHERE id='admin'")
            .bind(safe_hash)
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(!owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
        sqlx::query("UPDATE users SET is_active=0 WHERE id='admin'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(!owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
    }

    #[test]
    fn owner_enrollment_requires_reentered_dpapi_license_proof_and_a_strong_password() {
        let code = "A".repeat(43);
        let stored = serde_json::json!({
            "license_id": "license-owner-A",
            "machine_fingerprint": "f".repeat(64),
            "activation_code": code,
        })
        .to_string();
        assert!(valid_operator_enrollment_proof(
            stored.as_bytes(),
            &code,
            "license-owner-A",
            &"f".repeat(64),
        ));
        for bad in ["B".repeat(43), "A".repeat(42), "A".repeat(44)] {
            assert!(!valid_operator_enrollment_proof(
                stored.as_bytes(),
                &bad,
                "license-owner-A",
                &"f".repeat(64),
            ));
        }
        assert!(!valid_operator_enrollment_proof(
            stored.as_bytes(),
            &code,
            "license-other",
            &"f".repeat(64),
        ));
        assert!(!valid_operator_enrollment_proof(
            stored.as_bytes(),
            &code,
            "license-owner-A",
            &"e".repeat(64),
        ));
        assert!(!valid_operator_enrollment_proof(
            br#"{"activation_code":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#,
            &code,
            "license-owner-A",
            &"f".repeat(64),
        ));
        assert!(!valid_operator_enrollment_proof(
            b"corrupted dpapi json",
            &code,
            "license-owner-A",
            &"f".repeat(64),
        ));
        assert!(validate_owner_enrollment_password("S3cure!OwnerPass2026").is_ok());
        for weak in [
            "admin",
            "password",
            "NoDigits!Present",
            "lowercaseonly1234!",
            "UPPERCASEONLY1234!",
            "NoSymbol1234Secure",
            "AdmIn!StrongPass2026",
            "One!2",
            "A".repeat(73).as_str(),
        ] {
            assert!(validate_owner_enrollment_password(weak).is_err(), "{weak}");
        }
    }

    #[tokio::test]
    async fn seeded_default_owner_and_other_staff_cannot_login_before_proven_enrollment() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(enrollment_users_sql())
            .execute(&mut conn)
            .await
            .unwrap();
        let default_hash = hash("admin", 4).unwrap();
        let staff_hash = hash("Staff!SecurePass2026", 4).unwrap();
        sqlx::query("INSERT INTO users(id,username,role,password_hash,is_active) VALUES('admin','admin','owner',?,1)")
            .bind(&default_hash).execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO users(id,username,role,password_hash,is_active) VALUES('staff','staff','cashier',?,1)")
            .bind(&staff_hash).execute(&mut conn).await.unwrap();
        assert!(owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
        for (username, password) in [("admin", "admin"), ("staff", "Staff!SecurePass2026")] {
            let result = authenticate_on_connection(&mut conn, username, password)
                .await
                .unwrap();
            assert!(!result.success);
            assert!(result.user.is_none());
        }
        enroll_owner_on_connection(&mut conn, "S3cure!OwnerPass2026")
            .await
            .unwrap();
        assert!(!owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
        assert!(
            !authenticate_on_connection(&mut conn, "admin", "admin")
                .await
                .unwrap()
                .success
        );
        assert!(
            authenticate_on_connection(&mut conn, "admin", "S3cure!OwnerPass2026")
                .await
                .unwrap()
                .success
        );
        assert!(
            authenticate_on_connection(&mut conn, "staff", "Staff!SecurePass2026")
                .await
                .unwrap()
                .success
        );
        let retained_staff_hash: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id='staff'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(retained_staff_hash, staff_hash);
        assert!(enroll_owner_on_connection(&mut conn, "N3xt!OwnerPass2026")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn renamed_legacy_seed_owner_must_still_rotate_its_public_password() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(enrollment_users_sql())
            .execute(&mut conn)
            .await
            .unwrap();
        let default_hash = hash("admin", 4).unwrap();
        sqlx::query("INSERT INTO users(id,username,role,password_hash,is_active) VALUES('admin','renamed-owner','owner',?,1)")
            .bind(default_hash).execute(&mut conn).await.unwrap();
        assert!(owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
        assert!(
            !authenticate_on_connection(&mut conn, "renamed-owner", "admin")
                .await
                .unwrap()
                .success
        );
        enroll_owner_on_connection(&mut conn, "S3cure!OwnerPass2026")
            .await
            .unwrap();
        assert!(
            authenticate_on_connection(&mut conn, "renamed-owner", "S3cure!OwnerPass2026")
                .await
                .unwrap()
                .success
        );
    }

    #[tokio::test]
    async fn empty_owner_can_enroll_but_preexisting_custom_owner_is_not_rewritten() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(enrollment_users_sql())
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql("INSERT INTO users(id,username,role,password_hash,is_active) VALUES('admin','admin','owner',NULL,1)")
            .execute(&mut conn).await.unwrap();
        assert!(owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
        enroll_owner_on_connection(&mut conn, "S3cure!OwnerPass2026")
            .await
            .unwrap();
        assert!(
            authenticate_on_connection(&mut conn, "admin", "S3cure!OwnerPass2026")
                .await
                .unwrap()
                .success
        );
        let original: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id='admin'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert!(enroll_owner_on_connection(&mut conn, "N3xt!OwnerPass2026")
            .await
            .is_err());
        let preserved: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id='admin'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(original, preserved);
        assert!(!owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn upgraded_admin_with_a_real_password_and_existing_staff_never_reenters_enrollment() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(enrollment_users_sql())
            .execute(&mut conn)
            .await
            .unwrap();
        let original_hash = hash("AlreadyChanged!Owner2026", 4).unwrap();
        sqlx::query("INSERT INTO users(id,username,role,password_hash,is_active) VALUES('admin','admin','owner',?,1)")
            .bind(&original_hash).execute(&mut conn).await.unwrap();
        sqlx::raw_sql("INSERT INTO users(id,username,role,password_hash,is_active) VALUES('staff','staff','cashier',NULL,1)")
            .execute(&mut conn).await.unwrap();
        assert!(!owner_enrollment_pending_on_connection(&mut conn)
            .await
            .unwrap());
        assert!(
            enroll_owner_on_connection(&mut conn, "S3cure!OwnerPass2026")
                .await
                .is_err()
        );
        assert!(
            authenticate_on_connection(&mut conn, "admin", "AlreadyChanged!Owner2026")
                .await
                .unwrap()
                .success
        );
        let still_original: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id='admin'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(still_original, original_hash);
        let staff_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id='staff'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(staff_count, 1);
    }

    #[tokio::test]
    async fn owner_enrollment_rolls_back_when_audit_insert_fails() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT, role TEXT, password_hash TEXT, is_active INTEGER); \
            INSERT INTO users VALUES('admin','admin','owner',NULL,1);")
            .execute(&mut conn).await.unwrap();
        assert!(
            enroll_owner_on_connection(&mut conn, "S3cure!OwnerPass2026")
                .await
                .is_err()
        );
        let stored: Option<String> =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id='admin'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert!(stored.is_none());
    }

    #[tokio::test]
    async fn concurrent_owner_enrollments_allow_one_winner_and_reject_replays() {
        // Two independent native processes/connections to one synthetic file,
        // never the bundled or customer DB. BEGIN IMMEDIATE must serialize.
        let path = std::env::temp_dir().join(format!(
            "pharma-owner-enrollment-{}.db",
            uuid::Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(std::time::Duration::from_secs(4));
        let mut first = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::raw_sql(enrollment_users_sql())
            .execute(&mut first)
            .await
            .unwrap();
        sqlx::raw_sql("INSERT INTO users(id,username,role,password_hash,is_active) VALUES('admin','admin','owner',NULL,1)")
            .execute(&mut first).await.unwrap();
        let mut second = SqliteConnection::connect_with(&options).await.unwrap();
        let (one, two) = tokio::join!(
            enroll_owner_on_connection(&mut first, "F1rst!OwnerPass2026"),
            enroll_owner_on_connection(&mut second, "S3cond!OwnerPass2026"),
        );
        assert_ne!(one.is_ok(), two.is_ok(), "exactly one credential must win");
        let winner = if one.is_ok() {
            "F1rst!OwnerPass2026"
        } else {
            "S3cond!OwnerPass2026"
        };
        assert!(
            authenticate_on_connection(&mut first, "admin", winner)
                .await
                .unwrap()
                .success
        );
        assert!(!owner_enrollment_pending_on_connection(&mut second)
            .await
            .unwrap());
        assert!(
            enroll_owner_on_connection(&mut second, "R3play!OwnerPass2026")
                .await
                .is_err()
        );
        let audits: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM activity_log WHERE action = 'OWNER_ENROLLED'")
                .fetch_one(&mut first)
                .await
                .unwrap();
        assert_eq!(audits, 1);
        first.close().await.unwrap();
        second.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn staff_directory_scopes_shared_jobs_to_active_users_in_the_native_actor_pharmacy() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE employee_jobs (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
             CREATE TABLE users (id TEXT, username TEXT, full_name TEXT, role TEXT,
                job_id INTEGER, pharmacy_id TEXT, is_active INTEGER, password_hash TEXT);
             INSERT INTO employee_jobs VALUES (1, 'صيدلي', 'Pharmacist'), (2, 'كاشير', 'Cashier');
             INSERT INTO users VALUES
               ('owner-a','owner-a','Alpha','owner',NULL,'ph-a',1,'secret-owner'),
               ('cashier-a','cashier-a','Bravo','cashier',2,'ph-a',1,'secret-cashier'),
               ('pharmacist-a','pharmacist-a','Bravo','pharmacist',1,'ph-a',1,'secret-pharm'),
               ('mystery-a','mystery-a','Delta','unexpected-role',NULL,'ph-a',1,'secret-other'),
               ('inactive-a','inactive-a','Charlie','cashier',2,'ph-a',0,'secret-inactive'),
               ('null-active-a','null-active-a','Empty','cashier',1,'ph-a',NULL,'secret-null'),
               ('owner-b','owner-b','Foreign','owner',1,'ph-b',1,'secret-foreign'),
               ('staff-b','staff-b','Foreign Staff','cashier',2,'ph-b',1,'secret-foreign'),
               ('default-owner','default-owner','Default Owner','owner',NULL,NULL,1,'secret-default'),
               ('default-staff','default-staff','Default Staff','cashier',2,NULL,1,'secret-default'),
               ('blank-default','blank-default','Blank Default','cashier',2,'',NULL,'secret-blank'),
               ('explicit-default','explicit-default','Explicit Default','cashier',1,'local_default',1,'secret-default');",
        )
        .execute(&mut conn)
        .await
        .unwrap();

        // This is the legacy shared-shift selector, so active roles may all read it.
        for actor in ["owner-a", "cashier-a", "pharmacist-a", "mystery-a"] {
            let rows = list_staff_directory_on_connection(&mut conn, actor)
                .await
                .unwrap();
            assert_eq!(
                rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
                ["owner-a", "cashier-a", "pharmacist-a", "mystery-a", "null-active-a"]
            );
            assert!(rows.iter().all(|row| row.is_active == 1));
            assert_eq!(rows[1].job_name_ar.as_deref(), Some("كاشير"));
            assert_eq!(rows[1].job_name_en.as_deref(), Some("Cashier"));
            assert_eq!(rows[2].job_name_en.as_deref(), Some("Pharmacist"));
            assert_eq!(
                serde_json::to_value(&rows[0]).unwrap(),
                serde_json::json!({
                    "id":"owner-a", "username":"owner-a", "full_name":"Alpha",
                    "role":"owner", "is_active":1, "job_name_ar":null, "job_name_en":null
                })
            );
            let serialized = serde_json::to_string(&rows).unwrap();
            assert!(!serialized.contains("password_hash"));
            assert!(!serialized.contains("secret-"));
            assert!(!serialized.contains("Foreign"));
        }

        let foreign = list_staff_directory_on_connection(&mut conn, "owner-b")
            .await
            .unwrap();
        assert_eq!(
            foreign.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["owner-b", "staff-b"]
        );
        let default = list_staff_directory_on_connection(&mut conn, "default-owner")
            .await
            .unwrap();
        assert_eq!(
            default.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["blank-default", "default-owner", "default-staff", "explicit-default"]
        );
        assert!(default.iter().all(|row| row.is_active == 1));
        assert!(list_staff_directory_on_connection(&mut conn, "inactive-a")
            .await
            .is_err());
        assert!(list_staff_directory_on_connection(&mut conn, "absent-user")
            .await
            .is_err());
        assert!(
            list_staff_directory_on_connection(&mut conn, "null-active-a")
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn native_staff_summary_and_handover_verification_keep_hashes_and_other_pharmacies_private(
    ) {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users (id TEXT, username TEXT, role TEXT, full_name TEXT,
            pharmacy_id TEXT, is_active INTEGER, password_hash TEXT);",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let hash_str = hash("secret-qa", 4).unwrap();
        for (id, username, role, pharmacy, active) in [
            ("owner-a", "owner-a", "owner", "a", 1),
            ("staff-a", "staff-a", "cashier", "a", 1),
            ("owner-b", "owner-b", "owner", "b", 1),
            ("disabled-a", "disabled-a", "cashier", "a", 0),
        ] {
            sqlx::query("INSERT INTO users(id,username,role,pharmacy_id,is_active,password_hash) VALUES(?,?,?,?,?,?)")
                .bind(id).bind(username).bind(role).bind(pharmacy).bind(active).bind(&hash_str)
                .execute(&mut conn).await.unwrap();
        }
        let users = list_staff_summaries_on_connection(&mut conn, "owner-a")
            .await
            .unwrap();
        assert_eq!(users.len(), 2);
        assert!(users.iter().all(|u| u.has_password && u.id.ends_with("-a")));
        assert!(!serde_json::to_string(&users).unwrap().contains(&hash_str));
        assert!(list_staff_summaries_on_connection(&mut conn, "staff-a")
            .await
            .is_err());
        assert!(verify_handover_password_on_connection(
            &mut conn,
            "staff-a",
            "authorizer",
            None,
            "secret-qa"
        )
        .await
        .is_err());
        assert_eq!(
            verify_handover_password_on_connection(
                &mut conn,
                "owner-a",
                "authorizer",
                None,
                "secret-qa"
            )
            .await
            .unwrap()
            .as_deref(),
            Some("owner-a")
        );
        assert_eq!(
            verify_handover_password_on_connection(
                &mut conn,
                "owner-a",
                "receiver",
                Some("staff-a"),
                "secret-qa"
            )
            .await
            .unwrap()
            .as_deref(),
            Some("staff-a")
        );
        assert!(verify_handover_password_on_connection(
            &mut conn,
            "owner-a",
            "receiver",
            Some("owner-b"),
            "secret-qa"
        )
        .await
        .unwrap()
        .is_none());
        assert!(verify_handover_password_on_connection(
            &mut conn,
            "owner-a",
            "receiver",
            Some("disabled-a"),
            "secret-qa"
        )
        .await
        .unwrap()
        .is_none());
        assert!(verify_handover_password_on_connection(
            &mut conn,
            "owner-a",
            "receiver",
            Some("staff-a"),
            "wrong"
        )
        .await
        .unwrap()
        .is_none());
        let long_utf8_password = "م".repeat(170);
        sqlx::query("UPDATE users SET password_hash = ? WHERE id='owner-a'")
            .bind(hash(&long_utf8_password, 4).unwrap())
            .execute(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            verify_handover_password_on_connection(
                &mut conn,
                "owner-a",
                "authorizer",
                None,
                &long_utf8_password
            )
            .await
            .unwrap()
            .as_deref(),
            Some("owner-a")
        );
    }

    #[tokio::test]
    async fn session_lifecycle_does_not_use_a_renderer_supplied_user_id() {
        let session = LocalSessionState::default();
        assert!(session.0.read().await.is_none());
        *session.0.write().await = Some("real-user".into());
        assert_eq!(session.0.read().await.as_deref(), Some("real-user"));
        *session.0.write().await = None;
        assert!(session.0.read().await.is_none());
    }

    #[tokio::test]
    async fn financial_actor_requires_native_login_and_blocks_account_switch() {
        let session = LocalSessionState::default();
        assert!(session.authorize_session().await.is_err());
        assert!(session.authorize_actor("owner").await.is_err());
        *session.0.write().await = Some("cashier".into());
        assert!(session.authorize_actor("owner").await.is_err());
        assert!(session.authorize_actor("").await.is_err());
        let lease = session.authorize_actor("cashier").await.unwrap();
        assert_eq!(
            session.authorize_session().await.unwrap().as_deref(),
            Some("cashier")
        );
        assert!(session.0.try_write().is_err());
        // An existing transaction can finish while another command waits for SQLite's writer.
        let same_actor = session.authorize_actor("cashier").await.unwrap();
        drop(same_actor);
        drop(lease);
        *session.0.write().await = None;
        assert!(session.authorize_actor("cashier").await.is_err());
    }

    #[tokio::test]
    async fn local_login_rejects_absent_user_without_changing_a_database() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE users (id TEXT, username TEXT, role TEXT, full_name TEXT, pharmacy_id TEXT, permissions TEXT, password_hash TEXT, is_active INTEGER); CREATE TABLE activity_log (id INTEGER PRIMARY KEY, user_id TEXT, action TEXT, details TEXT);")
            .execute(&mut conn).await.unwrap();
        let result = authenticate_on_connection(&mut conn, "unknown", "guess")
            .await
            .unwrap();
        assert!(!result.success);
        assert!(result.user.is_none());
        let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(users, 0);
    }

    #[tokio::test]
    async fn local_login_accepts_existing_owner_without_reseeding_credentials() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE users (id TEXT, username TEXT, role TEXT, full_name TEXT, pharmacy_id TEXT, permissions TEXT, password_hash TEXT, is_active INTEGER); CREATE TABLE activity_log (id INTEGER PRIMARY KEY, user_id TEXT, action TEXT, details TEXT);")
            .execute(&mut conn).await.unwrap();
        let original_hash = hash("existing-pass", 4).unwrap();
        sqlx::query("INSERT INTO users (id,username,role,pharmacy_id,permissions,password_hash,is_active) VALUES ('owner','owner','owner',NULL,'[]',?,1)")
            .bind(&original_hash).execute(&mut conn).await.unwrap();
        let accepted = authenticate_on_connection(&mut conn, " owner ", "existing-pass")
            .await
            .unwrap();
        assert!(accepted.success);
        let user = accepted.user.unwrap();
        assert_eq!(user.id, "owner");
        assert_eq!(user.pharmacy_id, None);
        assert_eq!(user.permissions.as_deref(), Some("[]"));
        assert!(!serde_json::to_string(&user)
            .unwrap()
            .contains("password_hash"));
        let preserved_hash: String =
            sqlx::query_scalar("SELECT password_hash FROM users WHERE id='owner'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(preserved_hash, original_hash);
        let mut actor = Some("existing-session".to_string());
        let failed = authenticate_and_set_actor(&mut actor, &mut conn, "owner", "wrong-password")
            .await
            .unwrap();
        assert!(!failed.success);
        assert_eq!(actor.as_deref(), Some("existing-session"));
        let accepted = authenticate_and_set_actor(&mut actor, &mut conn, "owner", "existing-pass")
            .await
            .unwrap();
        assert!(accepted.success);
        assert_eq!(actor.as_deref(), Some("owner"));
        let wrong = authenticate_on_connection(&mut conn, "owner", "wrong-password")
            .await
            .unwrap();
        assert!(!wrong.success);
        assert!(wrong.user.is_none());
        sqlx::query("UPDATE users SET is_active=0 WHERE id='owner'")
            .execute(&mut conn)
            .await
            .unwrap();
        let inactive = authenticate_on_connection(&mut conn, "owner", "existing-pass")
            .await
            .unwrap();
        assert!(!inactive.success);
        assert!(inactive.user.is_none());
        let failed_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM activity_log WHERE action='LOGIN_FAILED'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(failed_count, 3);
    }

    #[tokio::test]
    async fn reviewed_scope_marker_prevents_owner_login_without_rewriting_credentials() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users (id TEXT, username TEXT, role TEXT, full_name TEXT, pharmacy_id TEXT, permissions TEXT, password_hash TEXT, is_active INTEGER);
             CREATE TABLE activity_log (id INTEGER PRIMARY KEY, user_id TEXT, action TEXT, details TEXT);
             CREATE TABLE native_owner_scope_review (owner_id TEXT PRIMARY KEY, reason TEXT);
             INSERT INTO native_owner_scope_review VALUES ('admin','Foreign tenant in legacy finance');"
        ).execute(&mut conn).await.unwrap();
        let original_hash = hash("StrongOwner!Test2026", 4).unwrap();
        sqlx::query("INSERT INTO users(id,username,role,pharmacy_id,password_hash,is_active) VALUES ('admin','admin','owner','local_default',?,1)")
            .bind(&original_hash).execute(&mut conn).await.unwrap();
        let result = authenticate_on_connection(&mut conn, "admin", "StrongOwner!Test2026").await.unwrap();
        assert!(!result.success, "A 052-assigned owner must not authenticate while its scope is under review");
        assert!(result.user.is_none());
        let preserved_hash: String = sqlx::query_scalar("SELECT password_hash FROM users WHERE id='admin'")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(preserved_hash, original_hash);
    }

    #[test]
    fn test_bcrypt_hash_produces_valid_hash() {
        let result = bcrypt_hash("test_password123".into());
        assert!(result.is_ok());
        let hash_str = result.unwrap();
        assert!(hash_str.starts_with("$2b$"));
        assert!(hash_str.len() >= 50);
    }

    #[test]
    fn test_bcrypt_compare_correct_password() {
        let password = "securePass!42".to_string();
        let hash_str = bcrypt_hash(password.clone()).unwrap();
        let result = bcrypt_compare(password, hash_str).unwrap();
        assert!(result);
    }

    #[test]
    fn test_bcrypt_compare_wrong_password() {
        let hash_str = bcrypt_hash("real_password".into()).unwrap();
        let result = bcrypt_compare("wrong_password".into(), hash_str).unwrap();
        assert!(!result);
    }

    #[test]
    fn test_bcrypt_compare_invalid_hash() {
        let result = bcrypt_compare("password".into(), "not_a_valid_hash".into());
        assert!(result.is_err());
    }

    #[test]
    fn test_bcrypt_compare_empty_password() {
        let hash_str = bcrypt_hash("".into()).unwrap();
        let result = bcrypt_compare("".into(), hash_str.clone()).unwrap();
        assert!(result);
        let wrong = bcrypt_compare("x".into(), hash_str).unwrap();
        assert!(!wrong);
    }

    #[test]
    fn test_bcrypt_hash_different_each_time() {
        let a = bcrypt_hash("same".into()).unwrap();
        let b = bcrypt_hash("same".into()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn test_bcrypt_cost_stays_reasonable() {
        let start = std::time::Instant::now();
        bcrypt_hash("perf_test".into()).unwrap();
        let elapsed = start.elapsed();
        // bcrypt cost ~10-12 takes 50-800ms on modern hardware
        assert!(elapsed.as_millis() < 5000);
    }
}
