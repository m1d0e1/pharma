use super::auth::LocalSessionState;
use super::permission_policy::normalize_pharmacy_id;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};

async fn clear_audit_logs_on_connection(
    connection: &mut SqliteConnection,
    user_id: &str,
) -> Result<(), String> {
    // Verify owner status under the same SQLite write lock as the log deletion.
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(connection, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let user = sqlx::query(
        r#"
        SELECT role, pharmacy_id
        FROM users
        WHERE CAST(id AS TEXT) = CAST(? AS TEXT)
          AND COALESCE(is_active, 1) = 1
        LIMIT 1
        "#,
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Unauthorized: active owner account required".to_string())?;
    let role = user
        .try_get::<Option<String>, _>("role")
        .unwrap_or(None)
        .unwrap_or_default();
    if !role.trim().eq_ignore_ascii_case("owner") {
        return Err("Unauthorized: owner account required to clear audit logs".into());
    }
    let pharmacy_id = normalize_pharmacy_id(
        user.try_get::<Option<String>, _>("pharmacy_id")
            .unwrap_or(None)
            .as_deref(),
    );

    if let Err(error) = sqlx::query(
        "DELETE FROM activity_log WHERE pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default')",
    )
    .bind(&pharmacy_id)
    .bind(&pharmacy_id)
    .execute(&mut *tx)
    .await
    {
        let _ = tx.rollback().await;
        return Err(error.to_string());
    }
    if let Err(error) = sqlx::query(
        "INSERT INTO activity_log (user_id, pharmacy_id, action, details) VALUES (?, ?, 'CLEAR_LOGS', ?)",
    )
    .bind(user_id)
    .bind(&pharmacy_id)
    .bind("قام المالك بمسح جميع سجلات النشاط")
    .execute(&mut *tx)
    .await
    {
        let _ = tx.rollback().await;
        return Err(error.to_string());
    }
    tx.commit().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn clear_audit_logs(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    user_id: String,
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
    let result = clear_audit_logs_on_connection(&mut connection, &user_id).await;
    let close_result = connection.close().await.map_err(|e| e.to_string());
    result.and(close_result)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_connection() -> SqliteConnection {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users (
              id TEXT PRIMARY KEY,
              role TEXT,
              pharmacy_id TEXT,
              is_active INTEGER DEFAULT 1
            );
            CREATE TABLE activity_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id TEXT,
              pharmacy_id TEXT,
              action TEXT,
              details TEXT
            );
            INSERT INTO users VALUES
              ('owner-a', 'owner', 'ph-a', 1),
              ('owner-b', 'owner', 'ph-b', 1),
              ('admin-a', 'admin', 'ph-a', 1),
              ('disabled-owner', 'owner', 'ph-a', 0);
            INSERT INTO activity_log(user_id, pharmacy_id, action, details) VALUES
              ('owner-a', 'ph-a', 'A1', 'a'),
              ('owner-b', 'ph-b', 'B1', 'b');
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection
    }

    #[tokio::test]
    async fn clear_audit_logs_is_owner_only_and_pharmacy_scoped() {
        let mut connection = test_connection().await;
        for user_id in ["admin-a", "disabled-owner", "missing"] {
            assert!(clear_audit_logs_on_connection(&mut connection, user_id)
                .await
                .is_err());
        }

        clear_audit_logs_on_connection(&mut connection, "owner-a")
            .await
            .unwrap();
        let remaining: Vec<(String, String)> =
            sqlx::query_as("SELECT pharmacy_id, action FROM activity_log ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            remaining,
            vec![
                ("ph-b".into(), "B1".into()),
                ("ph-a".into(), "CLEAR_LOGS".into()),
            ]
        );
    }
}
