use super::{
    auth::LocalSessionState, critical::active_generic_actor, permission_policy::user_has_permission,
};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tauri::{Manager, State};

fn validate_sync_table(table_name: &str) -> Result<&str, String> {
    match table_name {
        "cloud_drugs" | "cloud_drug_interactions" => Ok(table_name),
        _ => Err("Unsupported sync metadata table".into()),
    }
}

async fn set_sync_watermark_on_connection(
    connection: &mut SqliteConnection,
    actor_id: &str,
    table_name: &str,
    last_synced_at: &str,
) -> Result<(), String> {
    let table_name = validate_sync_table(table_name)?;
    if last_synced_at.trim().is_empty() {
        return Err("Sync timestamp is required".into());
    }
    // The renderer is not the source of truth for a remote catalog cursor.
    // A forged 2099 watermark permanently suppresses incremental downloads.
    // Only bounded UTC RFC3339 timestamps close to or behind the database's
    // current clock are accepted. A future-proof verified native sync cursor
    // will eventually supersede this renderer-originated timestamp.
    let valid_shape = last_synced_at.len() >= 20
        && last_synced_at.len() <= 32
        && last_synced_at.as_bytes().get(10) == Some(&b'T')
        && last_synced_at.ends_with('Z')
        && last_synced_at.as_bytes().get(4) == Some(&b'-')
        && last_synced_at.as_bytes().get(7) == Some(&b'-')
        && last_synced_at.as_bytes().get(13) == Some(&b':')
        && last_synced_at.as_bytes().get(16) == Some(&b':')
        && last_synced_at.as_bytes()[..19]
            .iter()
            .enumerate()
            .all(|(index, b)| matches!(index, 4 | 7 | 10 | 13 | 16) || b.is_ascii_digit())
        && (last_synced_at.len() == 20
            || (last_synced_at.as_bytes().get(19) == Some(&b'.')
                && last_synced_at.as_bytes()[20..last_synced_at.len() - 1]
                    .iter()
                    .all(u8::is_ascii_digit)));
    if !valid_shape {
        return Err("Sync timestamp must be a UTC ISO-8601 date".into());
    }
    let (role, _) = active_generic_actor(connection, actor_id).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_manage_inventory",
        false,
    ) {
        return Err("Catalog sync watermark requires inventory-management permission".into());
    }
    let timestamp_is_valid: i64 = sqlx::query_scalar(
        "SELECT CASE WHEN strftime('%s', ?) IS NOT NULL \
         AND CAST(strftime('%s', ?) AS INTEGER) >= 0 \
         AND CAST(strftime('%s', ?) AS INTEGER) <= CAST(strftime('%s','now') AS INTEGER) + 300 \
         THEN 1 ELSE 0 END",
    )
    .bind(last_synced_at)
    .bind(last_synced_at)
    .bind(last_synced_at)
    .fetch_one(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    if timestamp_is_valid != 1 {
        return Err("Sync watermark is invalid or is too far in the future".into());
    }
    sqlx::query("INSERT OR REPLACE INTO sync_metadata (table_name, last_synced_at) VALUES (?, ?)")
        .bind(table_name)
        .bind(last_synced_at)
        .execute(connection)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_sync_watermark(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    table_name: String,
    last_synced_at: String,
) -> Result<(), String> {
    let actor = session.authorize_session().await?;
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
    let result = set_sync_watermark_on_connection(
        &mut connection,
        actor.as_deref().unwrap(),
        &table_name,
        &last_synced_at,
    )
    .await;
    let close_result = connection.close().await.map_err(|e| e.to_string());
    result.and(close_result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sync_watermark_accepts_only_known_public_catalog_tables() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE users (id TEXT, role TEXT, pharmacy_id TEXT, is_active INTEGER, permissions TEXT); INSERT INTO users VALUES ('owner','owner','local_default',1,'{}'), ('inactive','owner','local_default',0,'{}'), ('cashier','cashier','local_default',1,'{}'), ('manager','manager','local_default',1,'{\"can_manage_inventory\":true}');")
            .execute(&mut connection).await.unwrap();
        sqlx::query(
            "CREATE TABLE sync_metadata (table_name TEXT PRIMARY KEY, last_synced_at TEXT)",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        assert!(set_sync_watermark_on_connection(
            &mut connection,
            "owner",
            "users",
            "2026-10-05T12:00:00Z"
        )
        .await
        .is_err());
        assert!(
            set_sync_watermark_on_connection(&mut connection, "owner", "cloud_drugs", "")
                .await
                .is_err()
        );
        for bad in ["2099-01-01T00:00:00Z", "tomorrow", "2026-13-05T12:00:00Z"] {
            assert!(
                set_sync_watermark_on_connection(&mut connection, "owner", "cloud_drugs", bad)
                    .await
                    .is_err()
            );
        }

        let now: String = sqlx::query_scalar("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now')")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        assert!(
            set_sync_watermark_on_connection(&mut connection, "cashier", "cloud_drugs", &now)
                .await
                .is_err()
        );
        set_sync_watermark_on_connection(
            &mut connection,
            "manager",
            "cloud_drug_interactions",
            &now,
        )
        .await
        .unwrap();

        set_sync_watermark_on_connection(
            &mut connection,
            "owner",
            "cloud_drugs",
            "2026-10-05T12:00:00Z",
        )
        .await
        .unwrap();
        let value: String = sqlx::query_scalar(
            "SELECT last_synced_at FROM sync_metadata WHERE table_name = 'cloud_drugs'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(value, "2026-10-05T12:00:00Z");
        for actor in ["", "missing", "inactive"] {
            assert!(set_sync_watermark_on_connection(
                &mut connection,
                actor,
                "cloud_drugs",
                "2099-01-01T00:00:00Z"
            )
            .await
            .is_err());
        }
        let preserved: String = sqlx::query_scalar(
            "SELECT last_synced_at FROM sync_metadata WHERE table_name='cloud_drugs'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(preserved, value);
    }
}
