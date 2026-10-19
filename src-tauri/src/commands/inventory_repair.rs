use super::{auth::LocalSessionState, critical::active_generic_actor};
use serde::Serialize;
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};

const LEGACY_PHARMACY_ID: &str = "placeholder-id";
const DEFAULT_PHARMACY_ID: &str = "local_default";
const DUMMY_DRUG_ID: i64 = 100001;
const COLLIDING_BARCODE: &str = "6221025003843";
const DUMMY_BARCODE: &str = "TEMP-100001";
// All tables here can carry their own pharmacy snapshot in the canonical
// schema. Older partial databases/isolated fixtures may omit some of them.
const TENANT_OWNED_HISTORY_TABLES: &[&str] = &[
    "sales_invoices",
    "purchase_invoices",
    "returns",
    "shifts",
    "shortages",
    "purchase_orders",
    "activity_log",
];

#[derive(Debug, Serialize, PartialEq)]
pub struct OrphanedInventoryItem {
    id: String,
    drug_id: i64,
    trade_name: String,
    quantity: f64,
    barcode: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPharmacyScopeMigrationResult {
    affected_items: Vec<OrphanedInventoryItem>,
    migrated_rows: u64,
    barcode_rows_updated: u64,
    changed: bool,
}

fn is_placeholder_dummy_name(value: &str) -> bool {
    let lowered = value.trim().to_ascii_lowercase();
    let Some(rest) = lowered.strip_prefix("drug") else {
        return false;
    };
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('#').unwrap_or(rest).trim_start();
    rest == "100001"
}

async fn migrate_legacy_placeholder_inventory_scope_on_connection(
    connection: &mut SqliteConnection,
    actor_id: &str,
) -> Result<LegacyPharmacyScopeMigrationResult, String> {
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(connection, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;

    let result = async {
        let (role, pharmacy_id) = active_generic_actor(&mut *tx, actor_id).await?;
        // This is a one-time repair for a known *single-pharmacy* legacy
        // placeholder, not an ordinary staff operation or a tenant migration.
        // NULL rows in a multi-pharmacy database have ambiguous ownership;
        // never silently reassign another branch's inventory to local_default.
        if !role.trim().eq_ignore_ascii_case("owner") || pharmacy_id != DEFAULT_PHARMACY_ID {
            return Err("Only the local-default pharmacy owner can approve legacy inventory repair".into());
        }
        let multiple_tenants: i64 = sqlx::query_scalar(
            "SELECT CASE WHEN EXISTS(SELECT 1 FROM users \
             WHERE COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default') <> 'local_default') \
             OR EXISTS(SELECT 1 FROM inventory \
             WHERE COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default') \
               NOT IN ('local_default','placeholder-id')) THEN 1 ELSE 0 END",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        if multiple_tenants != 0 {
            return Err("Ambiguous multi-pharmacy legacy inventory ownership requires an explicit migration review".into());
        }
        // A branch can retain invoices/returns/activity after its last user
        // and inventory row have been removed. Those historical pharmacy
        // snapshots must also rule out relabeling unowned legacy lots.
        for table in TENANT_OWNED_HISTORY_TABLES {
            let exists: i64 = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
            )
            .bind(table)
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if exists == 0 {
                continue;
            }
            // Trusted constant table names only, never SQL identifiers from IPC.
            let columns = sqlx::query(&format!("PRAGMA table_info(\"{table}\")"))
                .fetch_all(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            if !columns
                .iter()
                .any(|column| column.get::<String, _>("name") == "pharmacy_id")
            {
                // Empty legacy fixture tables are harmless. Populated tables
                // lacking a tenant snapshot have ambiguous ownership.
                let has_rows: i64 = sqlx::query_scalar(&format!(
                    "SELECT EXISTS(SELECT 1 FROM \"{table}\")"
                ))
                .fetch_one(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                if has_rows != 0 {
                    return Err(format!(
                        "Ambiguous legacy {table} ownership requires an explicit migration review"
                    ));
                }
                continue;
            }
            let foreign_rows: i64 = sqlx::query_scalar(&format!(
                "SELECT EXISTS(SELECT 1 FROM \"{table}\" WHERE COALESCE(NULLIF(TRIM(pharmacy_id), ''), 'local_default') <> 'local_default')"
            ))
            .fetch_one(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
            if foreign_rows != 0 {
                return Err(format!(
                    "Ambiguous multi-pharmacy {table} history requires an explicit migration review"
                ));
            }
        }
        let affected_rows = sqlx::query(
            r#"
            SELECT
              i.id,
              i.drug_id,
              COALESCE(NULLIF(m.trade_name, ''), NULLIF(m.trade_name_en, ''), 'صنف #' || i.drug_id) AS trade_name,
              CAST(i.quantity AS REAL) AS quantity,
              NULLIF(TRIM(i.barcode), '') AS barcode
            FROM inventory i
            LEFT JOIN master_drugs m ON m.id = i.drug_id
            WHERE (i.pharmacy_id = ? OR i.pharmacy_id IS NULL)
              AND CAST(i.quantity AS REAL) > 0
            ORDER BY i.drug_id, i.id
            "#,
        )
        .bind(LEGACY_PHARMACY_ID)
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        let affected_items = affected_rows
            .into_iter()
            .map(|row| OrphanedInventoryItem {
                id: row.get("id"),
                drug_id: row.get("drug_id"),
                trade_name: row.get("trade_name"),
                quantity: row.get("quantity"),
                barcode: row.try_get::<Option<String>, _>("barcode").unwrap_or(None),
            })
            .collect::<Vec<_>>();

        let scope_update = sqlx::query(
            "UPDATE inventory SET pharmacy_id = ? WHERE pharmacy_id = ? OR pharmacy_id IS NULL",
        )
        .bind(DEFAULT_PHARMACY_ID)
        .bind(LEGACY_PHARMACY_ID)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        let unused_dummy = sqlx::query(
            r#"
            SELECT m.trade_name, m.trade_name_en
            FROM master_drugs m
            WHERE m.id = ?
              AND (
                TRIM(COALESCE(m.barcode, '')) = ?
                OR EXISTS (
                  SELECT 1 FROM inventory i
                  WHERE i.drug_id = m.id
                    AND TRIM(COALESCE(i.barcode, '')) = ?
                )
              )
              AND NOT EXISTS (SELECT 1 FROM sales_items si WHERE si.drug_id = m.id)
              AND NOT EXISTS (SELECT 1 FROM purchase_invoice_items pii WHERE pii.drug_id = m.id)
              AND NOT EXISTS (SELECT 1 FROM inventory i WHERE i.drug_id = m.id AND COALESCE(i.quantity, 0) != 0)
              AND NOT EXISTS (SELECT 1 FROM master_drugs other WHERE other.id != m.id AND TRIM(other.barcode) = ? COLLATE NOCASE)
              AND NOT EXISTS (SELECT 1 FROM inventory other WHERE other.drug_id != m.id AND TRIM(other.barcode) = ? COLLATE NOCASE)
            LIMIT 1
            "#,
        )
        .bind(DUMMY_DRUG_ID)
        .bind(COLLIDING_BARCODE)
        .bind(COLLIDING_BARCODE)
        .bind(DUMMY_BARCODE)
        .bind(DUMMY_BARCODE)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        let mut barcode_rows_updated = 0_u64;
        if let Some(row) = unused_dummy {
            let names = [
                row.try_get::<Option<String>, _>("trade_name").unwrap_or(None),
                row.try_get::<Option<String>, _>("trade_name_en").unwrap_or(None),
            ]
            .into_iter()
            .flatten()
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>();
            if !names.is_empty() && names.iter().all(|name| is_placeholder_dummy_name(name)) {
                barcode_rows_updated += sqlx::query(
                    "UPDATE master_drugs SET barcode = ? WHERE id = ? AND TRIM(COALESCE(barcode, '')) = ?",
                )
                .bind(DUMMY_BARCODE)
                .bind(DUMMY_DRUG_ID)
                .bind(COLLIDING_BARCODE)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?
                .rows_affected();
                barcode_rows_updated += sqlx::query(
                    "UPDATE inventory SET barcode = ? WHERE drug_id = ? AND TRIM(COALESCE(barcode, '')) = ?",
                )
                .bind(DUMMY_BARCODE)
                .bind(DUMMY_DRUG_ID)
                .bind(COLLIDING_BARCODE)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?
                .rows_affected();
            }
        }

        let migrated_rows = scope_update.rows_affected();
        Ok::<_, String>(LegacyPharmacyScopeMigrationResult {
            affected_items,
            migrated_rows,
            barcode_rows_updated,
            changed: migrated_rows > 0 || barcode_rows_updated > 0,
        })
    }
    .await;

    match result {
        Ok(value) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn migrate_legacy_placeholder_inventory_scope(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<LegacyPharmacyScopeMigrationResult, String> {
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
    let result = migrate_legacy_placeholder_inventory_scope_on_connection(
        &mut connection,
        actor.as_deref().unwrap(),
    )
    .await;
    let close_result = connection.close().await.map_err(|e| e.to_string());
    match result {
        Ok(value) => {
            close_result?;
            Ok(value)
        }
        Err(error) => {
            let _ = close_result;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_connection() -> SqliteConnection {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, barcode TEXT
            );
            CREATE TABLE inventory (
              id TEXT PRIMARY KEY, drug_id INTEGER NOT NULL, quantity REAL NOT NULL DEFAULT 0,
              pharmacy_id TEXT, barcode TEXT
            );
            CREATE TABLE sales_items (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER);
            CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER);
            CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, pharmacy_id TEXT, is_active INTEGER);
            INSERT INTO users VALUES ('owner', 'owner', 'local_default', 1), ('inactive', 'owner', 'local_default', 0);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection
    }

    #[tokio::test]
    async fn placeholder_scope_repair_preserves_rows_and_clears_only_unused_dummy_collision() {
        let mut connection = test_connection().await;
        sqlx::raw_sql(
            r#"
            INSERT INTO master_drugs VALUES
              (1319, 'Antodine 40 legacy', 'Antodine 40 legacy', '6221025003843'),
              (100099, 'Official', 'Official', '6221025003843'),
              (100001, 'Drug 100001', 'Drug #100001', '6221025003843'),
              (2000, 'LAMIFEN', 'LAMIFEN', NULL);
            INSERT INTO inventory VALUES
              ('legacy-1319', 1319, 1.3333333336666668, 'placeholder-id', '6221025003843'),
              ('legacy-lamifen', 2000, 4, NULL, NULL),
              ('dummy-zero', 100001, 0, 'placeholder-id', '6221025003843'),
              ('official-stock', 100099, 2, 'local_default', '6221025003843');
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let result =
            migrate_legacy_placeholder_inventory_scope_on_connection(&mut connection, "owner")
                .await
                .unwrap();
        assert!(result.changed);
        assert_eq!(result.migrated_rows, 3);
        assert_eq!(result.barcode_rows_updated, 2);
        assert_eq!(result.affected_items.len(), 2);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM inventory WHERE pharmacy_id IS NULL OR pharmacy_id = 'placeholder-id'"
            )
            .fetch_one(&mut connection)
            .await
            .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT barcode FROM master_drugs WHERE id = 100001")
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            DUMMY_BARCODE
        );

        let rerun =
            migrate_legacy_placeholder_inventory_scope_on_connection(&mut connection, "owner")
                .await
                .unwrap();
        assert_eq!(rerun.migrated_rows, 0);
        assert_eq!(rerun.barcode_rows_updated, 0);
        assert!(!rerun.changed);
    }

    #[tokio::test]
    async fn placeholder_scope_repair_does_not_rewrite_dummy_with_purchase_history() {
        let mut connection = test_connection().await;
        sqlx::raw_sql(
            r#"
            INSERT INTO master_drugs VALUES (100001, 'Drug 100001', 'Drug 100001', '6221025003843');
            INSERT INTO inventory VALUES ('dummy-history', 100001, 0, 'local_default', '6221025003843');
            INSERT INTO purchase_invoice_items(drug_id) VALUES (100001);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let result =
            migrate_legacy_placeholder_inventory_scope_on_connection(&mut connection, "owner")
                .await
                .unwrap();
        assert!(!result.changed);
        assert_eq!(result.barcode_rows_updated, 0);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT barcode FROM master_drugs WHERE id = 100001")
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            COLLIDING_BARCODE
        );
    }

    #[tokio::test]
    async fn placeholder_scope_repair_rejects_missing_or_inactive_actor_without_mutating_data() {
        let mut connection = test_connection().await;
        sqlx::raw_sql(
            r#"
            INSERT INTO master_drugs VALUES (1319, 'Legacy', 'Legacy', '6221025003843');
            INSERT INTO inventory VALUES ('legacy-row', 1319, 1.25, 'placeholder-id', '6221025003843');
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        for actor in ["missing", "inactive"] {
            assert!(migrate_legacy_placeholder_inventory_scope_on_connection(
                &mut connection,
                actor
            )
            .await
            .is_err());
        }
        let (quantity, pharmacy_id, barcode): (f64, String, String) = sqlx::query_as(
            "SELECT quantity, pharmacy_id, barcode FROM inventory WHERE id = 'legacy-row'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(quantity, 1.25);
        assert_eq!(pharmacy_id, LEGACY_PHARMACY_ID);
        assert_eq!(barcode, COLLIDING_BARCODE);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT barcode FROM master_drugs WHERE id = 1319")
                .fetch_one(&mut connection)
                .await
                .unwrap(),
            COLLIDING_BARCODE
        );
    }

    #[tokio::test]
    async fn placeholder_scope_repair_refuses_staff_or_ambiguous_cross_tenant_data() {
        let mut connection = test_connection().await;
        sqlx::raw_sql(
            "INSERT INTO users VALUES ('cashier', 'cashier', 'local_default', 1), ('owner-b', 'owner', 'branch-b', 1); \
             INSERT INTO master_drugs VALUES (1319, 'Legacy', 'Legacy', NULL); \
             INSERT INTO inventory VALUES ('legacy', 1319, 3, 'placeholder-id', NULL), \
             ('other', 1319, 2, 'branch-b', NULL);",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        for actor in ["cashier", "owner-b", "owner"] {
            assert!(migrate_legacy_placeholder_inventory_scope_on_connection(
                &mut connection,
                actor
            )
            .await
            .is_err());
        }
        let legacy: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM inventory WHERE id='legacy'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(legacy, LEGACY_PHARMACY_ID);
        let other: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM inventory WHERE id='other'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(other, "branch-b");
    }

    #[tokio::test]
    async fn placeholder_scope_repair_refuses_foreign_invoice_only_and_preserves_null_stock() {
        let mut connection = test_connection().await;
        sqlx::raw_sql(
            "CREATE TABLE sales_invoices(id TEXT PRIMARY KEY, pharmacy_id TEXT); \
             INSERT INTO sales_invoices VALUES ('branch-b-history','branch-b'); \
             INSERT INTO master_drugs VALUES(1319,'Legacy','Legacy',NULL); \
             INSERT INTO inventory VALUES ('legacy-null',1319,2,NULL,NULL), \
             ('legacy-placeholder',1319,3,'placeholder-id',NULL);",
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let error =
            migrate_legacy_placeholder_inventory_scope_on_connection(&mut connection, "owner")
                .await
                .unwrap_err();
        assert!(error.contains("multi-pharmacy"));
        let scopes: Vec<(String, Option<String>, f64)> =
            sqlx::query_as("SELECT id, pharmacy_id, quantity FROM inventory ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            scopes,
            vec![
                ("legacy-null".into(), None, 2.0),
                (
                    "legacy-placeholder".into(),
                    Some("placeholder-id".into()),
                    3.0
                ),
            ]
        );
        let foreign_invoice: String = sqlx::query_scalar(
            "SELECT pharmacy_id FROM sales_invoices WHERE id='branch-b-history'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(foreign_invoice, "branch-b");
    }

    #[tokio::test]
    async fn placeholder_scope_repair_rejects_populated_history_without_pharmacy_snapshot() {
        let mut connection = test_connection().await;
        sqlx::raw_sql(
            "CREATE TABLE returns(id TEXT PRIMARY KEY); \
             INSERT INTO returns VALUES('legacy-unknown-owner'); \
             INSERT INTO master_drugs VALUES(1319,'Legacy','Legacy',NULL); \
             INSERT INTO inventory VALUES('legacy-null',1319,1,NULL,NULL);",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let error =
            migrate_legacy_placeholder_inventory_scope_on_connection(&mut connection, "owner")
                .await
                .unwrap_err();
        assert!(error.contains("Ambiguous legacy returns ownership"));
        let pharmacy: Option<String> =
            sqlx::query_scalar("SELECT pharmacy_id FROM inventory WHERE id='legacy-null'")
                .fetch_one(&mut connection)
                .await
                .unwrap();
        assert_eq!(pharmacy, None);
    }
}
