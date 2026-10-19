//! Explicitly opted-in native SQLx 068→069 verification on one SHA-pinned,
//! current-installed-derived, unsigned disposable tenant candidate.
//! This is a test-only module; it is never part of normal startup or IPC.

#[cfg(test)]
#[test]
fn opt_in_native_sqlx_069_primary_pharmacy_clone_twice() {
    if std::env::var_os("PHARMA_QA_NATIVE_SQLX69_PRIMARY_COPY")
        != Some(std::ffi::OsString::from("1"))
    {
        return;
    }

    use super::{app_migrations, MigrationKind};
    use sha2::{Digest, Sha256, Sha384};
    use std::fs::{self, OpenOptions};
    use std::io::Write;

    const SOURCE_PIN: &str = "816f49d70f0da6edb04cac8bdc5ee1af7b9ed307fd4ae0459b7e1ef7061481bb";
    const SOURCE_FOLDER: &str =
        "pharma-v02110-current-native-sqlx68-primary-scope-844cda322c1843b7809c9d9f20c259df";
    const SOURCE_FILE: &str = "NATIVE-SQLX68-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3";
    const OUTPUT_FILE: &str = "NATIVE-SQLX69-PRIMARY-PHARMACY-UNSIGNED-DISPOSABLE.sqlite3";
    const NEW_GUARD_MESSAGE: &str =
        "Supplier purchase return lacks immutable tenant-bound credit provenance";

    let root = std::path::PathBuf::from(
        std::env::var_os("LOCALAPPDATA").expect("Native 069 QA requires Windows LOCALAPPDATA"),
    )
    .join("pharma-disposable-data-copies");
    let source_parent = root.join(SOURCE_FOLDER);
    let source = source_parent.join(SOURCE_FILE);
    for component in [&root, &source_parent, &source] {
        assert!(
            !fs::symlink_metadata(component)
                .unwrap()
                .file_type()
                .is_symlink(),
            "Refuse symlinked disposable source component"
        );
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(
            !std::path::PathBuf::from(format!("{}{}", source.display(), suffix)).exists(),
            "Refuse snapshot with SQLite sidecars"
        );
    }
    let source_bytes = fs::read(&source).expect("Read pinned disposable bytes without SQLite");
    assert_eq!(source_bytes.len(), 62_689_280);
    assert_eq!(
        format!("{:x}", Sha256::digest(&source_bytes)),
        SOURCE_PIN,
        "Refuse any different v68/primary_pharmacy source"
    );

    // CREATE_NEW prevents overwriting any previous rehearsal. Only this fresh
    // clone is ever handed to SQLx; the source is read strictly as OS bytes.
    let target_dir = root.join(format!(
        "pharma-v02110-native-sqlx69-primary-scope-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir(&target_dir).expect("Create unique disposable QA directory");
    let output = target_dir.join(OUTPUT_FILE);
    let mut output_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)
        .unwrap();
    output_file.write_all(&source_bytes).unwrap();
    output_file.sync_all().unwrap();
    drop(output_file);
    assert_eq!(
        format!("{:x}", Sha256::digest(fs::read(&output).unwrap())),
        SOURCE_PIN
    );

    tauri::async_runtime::block_on(async {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&output)
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let before: (i64, i64) =
            sqlx::query_as("SELECT COUNT(*),MAX(version) FROM _sqlx_migrations WHERE success=1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(before, (68, 68));
        let prior_trigger: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='native_supplier_payment_insert_guard'"
        ).fetch_one(&pool).await.unwrap();
        assert!(!prior_trigger.contains(NEW_GUARD_MESSAGE));
        let original_sequence: i64 =
            sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name='accounts'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(original_sequence, 4829);
        let baseline: (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM native_primary_scope_audit_originals),
                    (SELECT COUNT(*) FROM native_primary_scope_audit_relations),
                    (SELECT SUM(original_physical_rows) FROM native_primary_scope_audit_tables),
                    (SELECT COUNT(*) FROM native_primary_scope_owner_attestations)",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(baseline, (7567, 147, 289816, 0));

        // Exactly the same immutable definitions and SQLx configuration as
        // licensed native startup, now scoped to an offline disposable clone.
        let migrations = app_migrations()
            .into_iter()
            .filter(|migration| matches!(migration.kind, MigrationKind::Up))
            .map(|migration| {
                sqlx::migrate::Migration::new(
                    migration.version,
                    migration.description.into(),
                    sqlx::migrate::MigrationType::ReversibleUp,
                    migration.sql.into(),
                    false,
                )
            })
            .collect::<Vec<_>>();
        let migrator = sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(migrations),
            ..sqlx::migrate::Migrator::DEFAULT
        };
        migrator
            .run(&pool)
            .await
            .expect("Native SQLx 068→069 must succeed");
        migrator
            .run(&pool)
            .await
            .expect("Second SQLx 069 run must be a no-op");

        let versions: (i64, i64, i64) = sqlx::query_as(
            "SELECT COUNT(*),MIN(version),MAX(version) FROM _sqlx_migrations WHERE success=1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(versions, (69, 1, 69));
        let row: (String, i64, Vec<u8>) = sqlx::query_as(
            "SELECT description,success,checksum FROM _sqlx_migrations WHERE version=69",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "supplier_return_aware_payment_guard");
        assert_eq!(row.1, 1);
        assert_eq!(
            row.2,
            Sha384::digest(
                include_str!("../migrations/069_supplier_return_aware_payment_guard.sql")
                    .as_bytes()
            )
            .to_vec(),
            "069 ledger must record exactly the registered SQL checksum"
        );
        let trigger: String = sqlx::query_scalar(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='native_supplier_payment_insert_guard'"
        ).fetch_one(&pool).await.unwrap();
        assert_ne!(
            trigger, prior_trigger,
            "069 must replace the 054 payment guard"
        );
        assert!(
            trigger.contains(NEW_GUARD_MESSAGE)
                && trigger.contains("native_purchase_return_line_provenance")
                && trigger.contains("native_supplier_payment_receipts"),
            "Registered 069 return-aware tenant guard is missing"
        );
        let after: (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM native_primary_scope_audit_originals),
                    (SELECT COUNT(*) FROM native_primary_scope_audit_relations),
                    (SELECT SUM(original_physical_rows) FROM native_primary_scope_audit_tables),
                    (SELECT COUNT(*) FROM native_primary_scope_owner_attestations)",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(after, baseline);
        let sequence: i64 =
            sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name='accounts'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(sequence, 4829);
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(integrity, "ok");
        let foreign_keys: Vec<(String, i64, String, i64)> =
            sqlx::query_as("PRAGMA foreign_key_check")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(foreign_keys.is_empty());
        pool.close().await;
    });
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(
            !std::path::PathBuf::from(format!("{}{}", output.display(), suffix)).exists(),
            "Migration output must be a self-contained SQLite snapshot"
        );
    }
    let after_bytes = fs::read(&output).unwrap();
    let output_pin = format!("{:x}", Sha256::digest(&after_bytes));
    assert_ne!(output_pin, SOURCE_PIN);
    assert_eq!(
        format!("{:x}", Sha256::digest(fs::read(&source).unwrap())),
        SOURCE_PIN,
        "Original disposable source was modified by native 069 QA"
    );
    let report = serde_json::json!({
        "status": "NATIVE_SQLX69_TWICE_AWAIT_INDEPENDENT_POSTFLIGHT",
        "source_sha256": SOURCE_PIN,
        "output_sha256": output_pin,
        "source_os_byte_only": true,
        "sqlx_migrations_applied": 69,
        "second_native_migration_run": "noop",
        "original_scope_originals": 7567,
        "original_graph_witnesses": 147,
        "original_physical_rows_in_audit": 289816,
        "original_account_sequence": 4829,
        "owner_attestations": 0,
        "output_path": output.display().to_string(),
    });
    let report_path = target_dir.join("native-sqlx69-rust-qa.json");
    let mut report_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&report_path)
        .unwrap();
    writeln!(
        report_file,
        "{}",
        serde_json::to_string_pretty(&report).unwrap()
    )
    .unwrap();
    report_file.sync_all().unwrap();
    println!("NATIVE_SQLX69_PRIMARY_DISPOSABLE_RESULT={report}");
}
