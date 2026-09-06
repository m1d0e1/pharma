use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::path::{Path, PathBuf};
use tauri::Manager;

async fn check_integrity(connection: &mut SqliteConnection) -> Result<(), String> {
    let results: Vec<String> = sqlx::query_scalar("PRAGMA quick_check")
        .fetch_all(connection)
        .await
        .map_err(|e| format!("Database cannot be backed up safely: {e}"))?;
    if results != ["ok"] {
        return Err("Database integrity check failed. Keep the database and its WAL together; do not replace them with the seed database.".into());
    }
    Ok(())
}

pub async fn create_backup(source: &Path) -> Result<PathBuf, String> {
    let options = SqliteConnectOptions::new().filename(source).read_only(true);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|e| e.to_string())?;
    check_integrity(&mut connection).await?;
    let directory = source
        .parent()
        .ok_or("Database directory is missing")?
        .join("backups");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    // ponytail: SQLite takes the consistent snapshot, including committed WAL pages.
    // A new private directory prevents overwriting any earlier recovery point.
    let directory = directory.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let destination = directory.join("pharma_local.db.partial");
    sqlx::query("VACUUM INTO ?")
        .bind(destination.to_str().ok_or("Invalid backup path")?)
        .execute(&mut connection)
        .await
        .map_err(|e| format!("Backup failed; do not use the incomplete file: {e}"))?;
    connection.close().await.map_err(|e| e.to_string())?;
    let mut backup = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&destination)
            .read_only(true),
    )
    .await
    .map_err(|e| e.to_string())?;
    check_integrity(&mut backup).await?;
    backup.close().await.map_err(|e| e.to_string())?;
    std::fs::OpenOptions::new()
        .write(true)
        .open(&destination)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    let complete = directory.join("pharma_local.db");
    std::fs::rename(&destination, &complete).map_err(|e| e.to_string())?;
    Ok(complete)
}

async fn require_backup_admin(source: &Path, user_id: &str, password: &str) -> Result<(), String> {
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(source).read_only(true),
    )
    .await
    .map_err(|e| e.to_string())?;
    let hash: Option<String> = sqlx::query_scalar(
        "SELECT password_hash FROM users WHERE id = ? AND is_active = 1 AND role IN ('owner', 'admin')",
    ).bind(user_id).fetch_optional(&mut connection).await.map_err(|e| e.to_string())?.flatten();
    if !hash.is_some_and(|hash| bcrypt::verify(password, &hash).unwrap_or(false)) {
        return Err("يلزم حساب مدير أو مالك نشط وكلمة مرور صحيحة لحفظ نسخة كاملة".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn export_database_backup(
    app: tauri::AppHandle,
    user_id: String,
    password: String,
) -> Result<String, String> {
    let source = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    require_backup_admin(&source, &user_id, &password).await?;
    create_backup(&source)
        .await
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn backup_includes_live_wal_and_never_overwrites_previous_snapshot() {
        let directory =
            std::env::temp_dir().join(format!("pharma-backup-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let source = directory.join("source.db");
        let mut writer = SqliteConnection::connect_with(
            &SqliteConnectOptions::new()
                .filename(&source)
                .create_if_missing(true),
        )
        .await
        .unwrap();
        sqlx::raw_sql("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            CREATE TABLE inventory (id INTEGER PRIMARY KEY, quantity REAL);
            CREATE TABLE users (id TEXT, role TEXT, is_active INTEGER, password_hash TEXT);
            INSERT INTO users VALUES ('admin', 'admin', 1, NULL), ('cashier', 'cashier', 1, NULL), ('disabled', 'owner', 0, NULL);
            INSERT INTO inventory VALUES (1, 2.5);")
            .execute(&mut writer).await.unwrap();
        assert!(source.with_extension("db-wal").metadata().unwrap().len() > 0);
        sqlx::query("UPDATE users SET password_hash = ?")
            .bind(bcrypt::hash("test-password", 4).unwrap())
            .execute(&mut writer)
            .await
            .unwrap();
        assert!(require_backup_admin(&source, "admin", "test-password")
            .await
            .is_ok());
        assert!(require_backup_admin(&source, "admin", "wrong-password")
            .await
            .is_err());
        for user in ["cashier", "disabled", "unknown"] {
            assert!(require_backup_admin(&source, user, "test-password")
                .await
                .is_err());
        }
        let first = create_backup(&source).await.unwrap();
        sqlx::query("UPDATE inventory SET quantity = 3.5")
            .execute(&mut writer)
            .await
            .unwrap();
        let second = create_backup(&source).await.unwrap();
        assert_ne!(first, second);
        for (path, expected) in [(&first, 2.5), (&second, 3.5)] {
            assert!(!path.with_extension("db-wal").exists());
            // Open a copy with no source files or sidecars alongside it.
            let standalone = directory.join(format!("{}.db", uuid::Uuid::new_v4()));
            std::fs::copy(path, &standalone).unwrap();
            let mut reader = SqliteConnection::connect_with(
                &SqliteConnectOptions::new()
                    .filename(standalone)
                    .read_only(true),
            )
            .await
            .unwrap();
            let quantity: f64 = sqlx::query_scalar("SELECT quantity FROM inventory")
                .fetch_one(&mut reader)
                .await
                .unwrap();
            assert_eq!(quantity, expected);
            reader.close().await.unwrap();
        }
        let quantity: f64 = sqlx::query_scalar("SELECT quantity FROM inventory")
            .fetch_one(&mut writer)
            .await
            .unwrap();
        assert_eq!(quantity, 3.5);
        writer.close().await.unwrap();
        let corrupt = directory.join("corrupt.db");
        std::fs::write(&corrupt, b"not a SQLite database").unwrap();
        assert!(create_backup(&corrupt).await.is_err());
        assert!(create_backup(&directory.join("missing.db")).await.is_err());
        assert!(!directory.join("missing.db").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
