use crate::commands::auth::LocalSessionState;
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tauri::{Manager, State};

async fn run_database_maintenance_on_connection(
    connection: &mut SqliteConnection,
    user_id: &str,
) -> Result<(), String> {
    let is_owner: i64 = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
          SELECT 1
          FROM users
          WHERE CAST(id AS TEXT) = CAST(? AS TEXT)
            AND COALESCE(is_active, 1) = 1
            AND LOWER(TRIM(COALESCE(role, ''))) = 'owner'
        )
        "#,
    )
    .bind(user_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    if is_owner != 1 {
        return Err("Unauthorized: active owner account required for database maintenance".into());
    }

    sqlx::query("VACUUM")
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("ANALYZE")
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn run_database_maintenance(
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
    let result = run_database_maintenance_on_connection(&mut connection, &user_id).await;
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
              is_active INTEGER DEFAULT 1
            );
            CREATE TABLE inventory (id INTEGER PRIMARY KEY, quantity REAL);
            CREATE INDEX idx_inventory_quantity ON inventory(quantity);
            INSERT INTO users(id, role, is_active) VALUES
              ('owner', 'owner', 1),
              ('admin', 'admin', 1),
              ('disabled-owner', 'owner', 0);
            INSERT INTO inventory VALUES (1, 3.5);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection
    }

    #[tokio::test]
    async fn maintenance_requires_an_active_owner_and_keeps_database_healthy() {
        let mut connection = test_connection().await;

        for user_id in ["admin", "disabled-owner", "missing"] {
            assert!(
                run_database_maintenance_on_connection(&mut connection, user_id)
                    .await
                    .is_err()
            );
        }

        run_database_maintenance_on_connection(&mut connection, "owner")
            .await
            .unwrap();
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");
        let analyzed: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_stat1 WHERE tbl = 'inventory' AND idx = 'idx_inventory_quantity'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(analyzed, 1);
    }
}
