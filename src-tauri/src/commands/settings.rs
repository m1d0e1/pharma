use super::auth::LocalSessionState;
use super::critical::GuardedReadPool;
use super::permission_policy::{normalize_pharmacy_id, user_has_permission};
use serde::Deserialize;
use sqlx::{
    sqlite::SqliteConnectOptions, Connection, QueryBuilder, Row, Sqlite, SqliteConnection,
    Transaction,
};
use std::borrow::Cow;
use std::collections::HashMap;
use tauri::{Manager, State};

#[derive(Debug, Deserialize)]
pub struct PharmacySettingsPayload {
    #[serde(default)]
    name: String,
    #[serde(default)]
    name_en: String,
    #[serde(default)]
    phone: String,
    #[serde(default)]
    address: String,
    #[serde(default)]
    commercial_registry: String,
    #[serde(default)]
    tax_card: String,
    #[serde(default)]
    owner_name: String,
    #[serde(default)]
    owner_address: String,
    #[serde(default)]
    owner_phone: String,
    #[serde(default)]
    owner_mobile: String,
    #[serde(default)]
    manager_name: String,
    #[serde(default)]
    manager_address: String,
    #[serde(default)]
    manager_phone: String,
    #[serde(default)]
    manager_mobile: String,
}

const PHARMACY_IDENTITY_CONFIG_KEYS: [&str; 14] = [
    "pharmacy_name",
    "pharmacy_name_en",
    "pharmacy_phone",
    "pharmacy_address",
    "pharmacy_commercial_registry",
    "pharmacy_tax_card",
    "pharmacy_owner_name",
    "pharmacy_owner_address",
    "pharmacy_owner_phone",
    "pharmacy_owner_mobile",
    "pharmacy_manager_name",
    "pharmacy_manager_address",
    "pharmacy_manager_phone",
    "pharmacy_manager_mobile",
];

async fn settings_user_scope(
    connection: &mut SqliteConnection,
    user_id: &str,
) -> Result<String, String> {
    let user = sqlx::query(
        r#"
        SELECT role, permissions, pharmacy_id
        FROM users
        WHERE CAST(id AS TEXT) = CAST(? AS TEXT)
          AND COALESCE(is_active, 1) = 1
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Unauthorized: active settings user required".to_string())?;
    let role = user.try_get::<Option<String>, _>("role").unwrap_or(None);
    let permissions = user
        .try_get::<Option<String>, _>("permissions")
        .unwrap_or(None);
    if !user_has_permission(
        role.as_deref(),
        permissions.as_deref(),
        "can_view_settings",
        false,
    ) {
        return Err("Unauthorized: can_view_settings permission required".into());
    }
    Ok(normalize_pharmacy_id(
        user.try_get::<Option<String>, _>("pharmacy_id")
            .unwrap_or(None)
            .as_deref(),
    ))
}

/// Pharmacy identity is private branch configuration, not generic renderer SQL.
/// Return only known setting keys through native DB-derived actor scope. A
/// read transaction prevents account reassignment between role and row checks.
async fn read_pharmacy_settings_on_connection(
    connection: &mut SqliteConnection,
    actor_id: &str,
) -> Result<HashMap<String, String>, String> {
    let mut tx = connection
        .begin()
        .await
        .map_err(|error| error.to_string())?;
    let pharmacy_id = settings_user_scope(&mut tx, actor_id).await?;
    let mut scoped_keys = Vec::with_capacity(PHARMACY_IDENTITY_CONFIG_KEYS.len());
    for key in PHARMACY_IDENTITY_CONFIG_KEYS {
        scoped_keys.push(if pharmacy_id == "local_default" {
            key.to_string()
        } else {
            format!("pharmacy:{pharmacy_id}:{key}")
        });
    }
    let mut builder =
        QueryBuilder::<Sqlite>::new("SELECT key,value FROM main.config WHERE key IN (");
    let mut separated = builder.separated(",");
    for key in &scoped_keys {
        separated.push_bind(key);
    }
    separated.push_unseparated(")");
    let rows = builder
        .build()
        .fetch_all(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
    let mut by_scoped_key = HashMap::new();
    for row in rows {
        let key: String = row.try_get("key").map_err(|error| error.to_string())?;
        let value: Option<String> = row.try_get("value").map_err(|error| error.to_string())?;
        let value = value.unwrap_or_default();
        if value.len() > 16 * 1024 {
            return Err("Pharmacy settings field exceeds native read limit".into());
        }
        by_scoped_key.insert(key, value);
    }
    let mut output = HashMap::new();
    for (base, scoped) in PHARMACY_IDENTITY_CONFIG_KEYS.iter().zip(scoped_keys.iter()) {
        if let Some(value) = by_scoped_key.get(scoped) {
            output.insert((*base).to_string(), value.clone());
        }
    }
    tx.commit().await.map_err(|error| error.to_string())?;
    Ok(output)
}

#[tauri::command]
pub async fn read_pharmacy_settings_scoped(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<HashMap<String, String>, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|error| error.to_string())?;
    read_pharmacy_settings_on_connection(&mut conn, actor.as_deref().unwrap()).await
}

async fn update_pharmacy_settings_on_connection(
    connection: &mut SqliteConnection,
    user_id: &str,
    payload: PharmacySettingsPayload,
) -> Result<(), String> {
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(connection, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let pharmacy_id = settings_user_scope(&mut tx, user_id).await?;

    let entries = [
        ("pharmacy_name", payload.name),
        ("pharmacy_name_en", payload.name_en),
        ("pharmacy_phone", payload.phone),
        ("pharmacy_address", payload.address),
        ("pharmacy_commercial_registry", payload.commercial_registry),
        ("pharmacy_tax_card", payload.tax_card),
        ("pharmacy_owner_name", payload.owner_name),
        ("pharmacy_owner_address", payload.owner_address),
        ("pharmacy_owner_phone", payload.owner_phone),
        ("pharmacy_owner_mobile", payload.owner_mobile),
        ("pharmacy_manager_name", payload.manager_name),
        ("pharmacy_manager_address", payload.manager_address),
        ("pharmacy_manager_phone", payload.manager_phone),
        ("pharmacy_manager_mobile", payload.manager_mobile),
    ];

    for (base_key, value) in entries {
        let scoped_key = if pharmacy_id == "local_default" {
            base_key.to_string()
        } else {
            format!("pharmacy:{pharmacy_id}:{base_key}")
        };
        if let Err(error) = sqlx::query(
            r#"
            INSERT INTO config (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            "#,
        )
        .bind(scoped_key)
        .bind(value)
        .execute(&mut *tx)
        .await
        {
            let _ = tx.rollback().await;
            return Err(error.to_string());
        }
    }
    tx.commit().await.map_err(|e| e.to_string())
}

async fn update_config_value_on_connection(
    connection: &mut SqliteConnection,
    user_id: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("Configuration key is required".into());
    }
    // The caller supplies base keys only. Native code constructs pharmacy-scoped
    // keys from the current user's database assignment, not renderer input.
    if key.trim().to_ascii_lowercase().starts_with("pharmacy:") {
        return Err(
            "Pharmacy-scoped configuration keys must be set through the native scope".into(),
        );
    }
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(connection, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let pharmacy_id = settings_user_scope(&mut tx, user_id).await?;
    // This renderer-facing typed mutation is intentionally limited to known
    // pharmacy identity fields. Arbitrary config keys include GLOBAL schema
    // migration and data-repair markers; even a local-default delegated
    // settings user must not be able to rewrite those maintenance controls.
    if !PHARMACY_IDENTITY_CONFIG_KEYS.contains(&key) {
        return Err(
            "Unsupported configuration key; privileged native maintenance is required".into(),
        );
    }
    let scoped_key =
        if PHARMACY_IDENTITY_CONFIG_KEYS.contains(&key) && pharmacy_id != "local_default" {
            format!("pharmacy:{pharmacy_id}:{key}")
        } else {
            key.to_string()
        };
    sqlx::query(
        r#"
        INSERT INTO config (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
    )
    .bind(scoped_key)
    .bind(value)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_pharmacy_settings(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    user_id: String,
    payload: PharmacySettingsPayload,
) -> Result<(), String> {
    let _actor_guard = session.authorize_actor(&user_id).await?;
    let source = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    let options = SqliteConnectOptions::new()
        .filename(source)
        .create_if_missing(false)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    let result = update_pharmacy_settings_on_connection(&mut connection, &user_id, payload).await;
    let close_result = connection.close().await.map_err(|e| e.to_string());
    result.and(close_result)
}

#[tauri::command]
pub async fn update_config_value(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    user_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    let _actor_guard = session.authorize_actor(&user_id).await?;
    let source = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    let options = SqliteConnectOptions::new()
        .filename(source)
        .create_if_missing(false)
        .foreign_keys(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    let result = update_config_value_on_connection(&mut connection, &user_id, &key, &value).await;
    let close_result = connection.close().await.map_err(|e| e.to_string());
    result.and(close_result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(name: &str) -> PharmacySettingsPayload {
        PharmacySettingsPayload {
            name: name.into(),
            name_en: "English".into(),
            phone: "111".into(),
            address: "Address".into(),
            commercial_registry: "CR".into(),
            tax_card: "TAX".into(),
            owner_name: "Owner".into(),
            owner_address: "Owner Address".into(),
            owner_phone: "222".into(),
            owner_mobile: "333".into(),
            manager_name: "Manager".into(),
            manager_address: "Manager Address".into(),
            manager_phone: "444".into(),
            manager_mobile: "555".into(),
        }
    }

    async fn test_connection() -> SqliteConnection {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users (
              id TEXT PRIMARY KEY,
              role TEXT,
              permissions TEXT,
              pharmacy_id TEXT,
              is_active INTEGER DEFAULT 1
            );
            CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
            INSERT INTO users VALUES
              ('owner-a', 'owner', '{}', 'ph-a', 1),
              ('manager-a', 'manager', '{"can_view_settings":true}', 'ph-a', 1),
              ('admin-denied', 'admin', '{"can_view_settings":false}', 'ph-a', 1),
              ('owner-local', 'owner', '{}', NULL, 1),
              ('owner-disabled', 'owner', '{}', 'ph-a', 0);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection
    }

    #[tokio::test]
    async fn pharmacy_settings_are_permission_checked_atomic_and_pharmacy_scoped() {
        let mut connection = test_connection().await;

        for user_id in ["admin-denied", "owner-disabled", "missing"] {
            assert!(update_pharmacy_settings_on_connection(
                &mut connection,
                user_id,
                payload("blocked")
            )
            .await
            .is_err());
        }

        update_pharmacy_settings_on_connection(&mut connection, "manager-a", payload("Pharmacy A"))
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM config WHERE key LIKE 'pharmacy:ph-a:pharmacy_%'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(count, 14);
        let name: String = sqlx::query_scalar(
            "SELECT value FROM config WHERE key = 'pharmacy:ph-a:pharmacy_name'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(name, "Pharmacy A");

        update_pharmacy_settings_on_connection(&mut connection, "owner-local", payload("Local"))
            .await
            .unwrap();
        let local_name: String =
            sqlx::query_scalar("SELECT value FROM config WHERE key = 'pharmacy_name'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(local_name, "Local");
    }

    #[tokio::test]
    async fn config_value_updates_are_permission_checked_and_scope_identity_keys() {
        let mut connection = test_connection().await;
        sqlx::query("INSERT INTO config (key, value) VALUES ('pharmacy:ph-b:pharmacy_name', 'Other Pharmacy')")
            .execute(&mut connection).await.unwrap();
        assert!(update_config_value_on_connection(
            &mut connection,
            "admin-denied",
            "unrelated_global_setting",
            "blocked"
        )
        .await
        .is_err());

        for key in [
            "pharmacy:ph-b:pharmacy_name",
            "pharmacy:ph-a:pharmacy_name",
            " pharmacy:ph-b:pharmacy_phone",
        ] {
            assert!(
                update_config_value_on_connection(&mut connection, "manager-a", key, "forged")
                    .await
                    .is_err()
            );
        }
        let scoped_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM config WHERE key LIKE 'pharmacy:%'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(scoped_count, 1);
        let other_pharmacy_name: String = sqlx::query_scalar(
            "SELECT value FROM config WHERE key = 'pharmacy:ph-b:pharmacy_name'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(other_pharmacy_name, "Other Pharmacy");

        update_config_value_on_connection(
            &mut connection,
            "manager-a",
            "pharmacy_name",
            "Pharmacy A",
        )
        .await
        .unwrap();
        assert!(update_config_value_on_connection(
            &mut connection,
            "manager-a",
            "unrelated_global_setting",
            "enabled",
        )
        .await
        .is_err());
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT value FROM config WHERE key = 'pharmacy:ph-a:pharmacy_name'"
            )
            .fetch_one(&mut connection)
            .await
            .unwrap(),
            "Pharmacy A"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM config WHERE key = 'unrelated_global_setting'"
            )
            .fetch_one(&mut connection)
            .await
            .unwrap(),
            0
        );
        assert!(update_config_value_on_connection(
            &mut connection,
            "owner-local",
            "unrelated_global_setting",
            "enabled",
        )
        .await
        .is_err());

        update_config_value_on_connection(
            &mut connection,
            "owner-local",
            "pharmacy_name",
            "Local Default",
        )
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM config WHERE key = 'pharmacy_name'")
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            "Local Default"
        );
    }

    #[tokio::test]
    async fn native_settings_read_hides_other_branches_and_global_maintenance_keys() {
        let mut connection = test_connection().await;
        sqlx::raw_sql(
            "INSERT INTO config(key,value) VALUES \
             ('pharmacy:ph-a:pharmacy_name','A private'), \
             ('pharmacy:ph-b:pharmacy_name','B private'), \
             ('pharmacy_name','Local private'), \
             ('legacy_patient_wallet_review_status','Sensitive internal marker'), \
             ('pharmacy:ph-a:pharmacy_phone','111');",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let a = read_pharmacy_settings_on_connection(&mut connection, "manager-a")
            .await
            .unwrap();
        assert_eq!(
            a.get("pharmacy_name").map(String::as_str),
            Some("A private")
        );
        assert_eq!(a.get("pharmacy_phone").map(String::as_str), Some("111"));
        assert_eq!(a.len(), 2);
        let local = read_pharmacy_settings_on_connection(&mut connection, "owner-local")
            .await
            .unwrap();
        assert_eq!(
            local.get("pharmacy_name").map(String::as_str),
            Some("Local private")
        );
        assert_eq!(local.len(), 1);
        for denied in ["admin-denied", "owner-disabled", "missing"] {
            assert!(
                read_pharmacy_settings_on_connection(&mut connection, denied)
                    .await
                    .is_err()
            );
        }
    }
}
