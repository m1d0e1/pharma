//! Global shared master catalog is readable through a fixed, bounded native
//! command only. This never transfers write ownership of the catalog to a
//! pharmacy or trusts a renderer-supplied SQL, actor, projection or filter.
use serde_json::{json, Value};
use sqlx::{Connection, Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::permission_policy::user_has_permission;

const CACHE_PAGE_SIZE: usize = 200;
const CACHE_MAX_DRUGS: usize = 30_000;

/// Global catalog metadata is common reference data. Inventory quantities,
/// acquisition costs, supplier fields and tenant-private rows are absent.
/// Assemble bounded keyset pages within one read transaction so the renderer
/// never receives a partial or inconsistent cache on concurrent catalog edits.
async fn read_catalog_cache(
    conn: &mut SqliteConnection,
    actor: &str,
) -> Result<Vec<Value>, String> {
    let mut tx = conn.begin().await.map_err(|error| error.to_string())?;
    let result = async {
        let (role, _) = active_generic_actor(&mut tx, actor).await?;
        let permissions: Option<String> = sqlx::query_scalar(
            "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
        )
        .bind(actor)
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
        let can_use_catalog = user_has_permission(
            Some(&role), permissions.as_deref(), "can_access_pos", true,
        ) || user_has_permission(
            Some(&role), permissions.as_deref(), "can_view_stores", false,
        );
        if !can_use_catalog {
            return Err("Native catalog access requires live POS or inventory-view permission".into());
        }

        // The count is taken inside the same snapshot and independently
        // checked after page assembly. A missing page cannot become a
        // successful partial cache, even if the final page query fails.
        let expected_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM main.master_drugs")
            .fetch_one(&mut *tx).await.map_err(|error| error.to_string())?;
        if !(0..=CACHE_MAX_DRUGS as i64).contains(&expected_rows) {
            return Err("Global catalog exceeds native 30000-drug cache limit".into());
        }

        let mut last_id = 0_i64;
        let mut drugs = Vec::new();
        loop {
            // Keyset pagination preserves the complete source ordering across
            // 200-row batches. All batches share the same SQLite snapshot.
            let page = sqlx::query(
                "SELECT id,trade_name,trade_name_en,generic_name,active_ingredient,barcode,
                        manufacturer,is_medicine,is_service,stop_dealing,official_price,has_expiry,
                        large_unit,medium_unit,small_unit,large_to_medium,medium_to_small
                 FROM main.master_drugs WHERE id>? ORDER BY id ASC LIMIT 200",
            )
            .bind(last_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(|error| error.to_string())?;
            if page.is_empty() { break; }
            let page_len = page.len();
            for row in page {
                if drugs.len() >= CACHE_MAX_DRUGS {
                    return Err("Global catalog exceeds native 30000-drug cache limit".into());
                }
                let id: i64 = row.try_get("id").map_err(|error| error.to_string())?;
                let name: String = row.try_get("trade_name").map_err(|error| error.to_string())?;
                let price: f64 = row.try_get("official_price").map_err(|error| error.to_string())?;
                if id <= last_id || name.trim().is_empty() || name.len() > 512 ||
                    name.chars().any(char::is_control) || !price.is_finite() ||
                    !(0.0..=1_000_000_000.0).contains(&price) {
                    return Err("Global catalog contains invalid identity or price".into());
                }
                let text = |column| -> Result<Option<String>, String> {
                    let value: Option<String> = row.try_get(column).map_err(|error| error.to_string())?;
                    if value.as_ref().is_some_and(|text| text.len() > 1024 || text.chars().any(char::is_control)) {
                        return Err("Global catalog contains invalid text field".into());
                    }
                    Ok(value)
                };
                let flag = |column| -> Result<i64, String> {
                    let value: Option<i64> = row.try_get(column).map_err(|error| error.to_string())?;
                    match value {
                        Some(value @ (0 | 1)) => Ok(value),
                        _ => Err("Global catalog contains invalid drug classification or expiry".into()),
                    }
                };
                let conversion = |column| -> Result<Option<i64>, String> {
                    let value: Option<i64> = row.try_get(column).map_err(|error| error.to_string())?;
                    if value.is_some_and(|value| !(1..=10000).contains(&value)) {
                        return Err("Global catalog contains invalid unit conversion".into());
                    }
                    Ok(value)
                };
                let stop: Option<i64> = row.try_get("stop_dealing").map_err(|error| error.to_string())?;
                if stop.is_some_and(|value| value != 0 && value != 1) {
                    return Err("Global catalog contains invalid archived status".into());
                }
                drugs.push(json!({
                    "id":id, "trade_name":name,
                    "trade_name_en":text("trade_name_en")?,
                    "generic_name":text("generic_name")?,
                    "active_ingredient":text("active_ingredient")?,
                    "barcode":text("barcode")?,
                    "manufacturer":text("manufacturer")?,
                    "is_medicine":flag("is_medicine")?,
                    "is_service":flag("is_service")?,
                    "stop_dealing":stop,
                    "official_price":price,
                    "has_expiry":flag("has_expiry")?,
                    "large_unit":text("large_unit")?,
                    "medium_unit":text("medium_unit")?,
                    "small_unit":text("small_unit")?,
                    "large_to_medium":conversion("large_to_medium")?,
                    "medium_to_small":conversion("medium_to_small")?
                }));
                last_id = id;
            }
            if page_len < CACHE_PAGE_SIZE { break; }
        }
        if drugs.len() as i64 != expected_rows {
            return Err("Global catalog cache read is incomplete".into());
        }
        Ok(drugs)
    }.await;
    match result {
        Ok(rows) => {
            tx.commit().await.map_err(|error| error.to_string())?;
            Ok(rows)
        }
        Err(error) => {
            tx.rollback().await.map_err(|rollback| format!("{error}; rollback: {rollback}"))?;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn read_master_catalog_cache_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<Vec<Value>, String> {
    let actor = session.authorize_session().await?.clone()
        .ok_or("Native login required")?;
    let pool = app.try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|error| error.to_string())?;
    read_catalog_cache(&mut conn, &actor).await
}

async fn catalog_export(conn: &mut SqliteConnection, actor: &str) -> Result<Vec<Value>, String> {
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result = async {
        let (role, _) = active_generic_actor(&mut tx, actor).await?;
        let permissions: Option<String> = sqlx::query_scalar(
            "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
        ).bind(actor).fetch_one(&mut *tx).await.map_err(|e| e.to_string())?;
        if !user_has_permission(Some(&role), permissions.as_deref(), "can_manage_inventory", false) {
            return Err("Live native catalog-management permission required".into());
        }
        // No renderer-provided catalog SQL. This is an explicitly bounded
        // projection, never SELECT * (which could leak private catalog fields).
        let rows = sqlx::query(
            "SELECT id,trade_name,trade_name_en,generic_name,active_ingredient,
                    barcode,official_price,large_unit,medium_unit,small_unit,
                    large_to_medium,medium_to_small,category,manufacturer,stop_dealing
             FROM main.master_drugs ORDER BY id LIMIT 10001"
        ).fetch_all(&mut *tx).await.map_err(|e| e.to_string())?;
        if rows.len() > 10000 {
            return Err("Global catalog export exceeds 10000 drugs; use approved paginated export".into());
        }
        let mut export = Vec::with_capacity(rows.len());
        for row in rows {
            let id: i64 = row.try_get("id").map_err(|e| e.to_string())?;
            let name: Option<String> = row.try_get("trade_name").map_err(|e| e.to_string())?;
            let price: f64 = row.try_get("official_price").map_err(|e| e.to_string())?;
            let large: Option<i64> = row.try_get("large_to_medium").map_err(|e| e.to_string())?;
            let small: Option<i64> = row.try_get("medium_to_small").map_err(|e| e.to_string())?;
            if id <= 0 || !name.as_ref().is_some_and(|name| !name.trim().is_empty() && name.len() <= 512) ||
               !price.is_finite() || !(0.0..=1_000_000_000.0).contains(&price) ||
               !(1..=10000).contains(&large.unwrap_or(1)) ||
               !(1..=10000).contains(&small.unwrap_or(1)) {
                return Err("Global master catalog contains invalid financial/unit data".into());
            }
            let text = |key| -> Result<Option<String>, String> {
                let value: Option<String> = row.try_get(key).map_err(|e| e.to_string())?;
                if value.as_ref().is_some_and(|text| text.len() > 1024 || text.chars().any(char::is_control)) {
                    return Err("Global master catalog contains invalid export text".into());
                }
                Ok(value)
            };
            export.push(json!({
                "id":id, "trade_name":name,
                "trade_name_en":text("trade_name_en")?,
                "generic_name":text("generic_name")?,
                "active_ingredient":text("active_ingredient")?,
                "barcode":text("barcode")?,
                "official_price":price,
                "large_unit":text("large_unit")?,
                "medium_unit":text("medium_unit")?,
                "small_unit":text("small_unit")?,
                "large_to_medium":large.unwrap_or(1),
                "medium_to_small":small.unwrap_or(1),
                "category":text("category")?,
                "manufacturer":text("manufacturer")?,
                "stop_dealing":row.try_get::<Option<i64>,_>("stop_dealing").map_err(|e| e.to_string())?.unwrap_or(0)
            }));
        }
        Ok(export)
    }.await;
    match result {
        Ok(rows) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(rows)
        }
        Err(error) => {
            tx.rollback()
                .await
                .map_err(|e| format!("{error}; rollback: {e}"))?;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn export_master_catalog_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<Vec<Value>, String> {
    let actor = session
        .authorize_session()
        .await?
        .clone()
        .ok_or("Native login required")?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    catalog_export(&mut conn, &actor).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,permissions TEXT,is_active INTEGER);
            INSERT INTO users VALUES
               ('manager','cashier','branch-a','{"can_manage_inventory":true}',1),
               ('denied','cashier','branch-b','{"can_manage_inventory":false}',1),
               ('inactive','owner','branch-a','{}',0);
            CREATE TABLE master_drugs (
                id INTEGER, trade_name TEXT,trade_name_en TEXT,generic_name TEXT,
                active_ingredient TEXT,barcode TEXT,official_price REAL,
                large_unit TEXT,medium_unit TEXT,small_unit TEXT,
                large_to_medium INTEGER,medium_to_small INTEGER,
                category TEXT,manufacturer TEXT,stop_dealing INTEGER,
                private_medical_notes TEXT);
            INSERT INTO master_drugs
                (id,trade_name,official_price,large_to_medium,medium_to_small,private_medical_notes)
            VALUES(11,'Global Drug',15.50,12,10,'DO NOT LEAK');
        "#).execute(&mut conn).await.unwrap();
        conn
    }

    #[tokio::test]
    async fn global_master_export_is_live_permission_checked_and_does_not_leak_private_fields() {
        let mut conn = fixture().await;
        let data = catalog_export(&mut conn, "manager").await.unwrap();
        assert_eq!(data.len(), 1);
        assert_eq!(data[0]["id"], 11);
        assert_eq!(data[0]["official_price"], 15.50);
        assert!(!data[0].to_string().contains("DO NOT LEAK"));
        for user in ["denied", "inactive", "missing"] {
            assert!(catalog_export(&mut conn, user).await.is_err());
        }
        sqlx::query("UPDATE users SET permissions='{}' WHERE id='manager'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(catalog_export(&mut conn, "manager").await.is_err());
    }

    #[tokio::test]
    async fn corrupt_master_price_is_rejected_and_source_rows_never_change() {
        let mut conn = fixture().await;
        sqlx::query("UPDATE master_drugs SET official_price=-1 WHERE id=11")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(catalog_export(&mut conn, "manager").await.is_err());
        let raw: f64 = sqlx::query_scalar("SELECT official_price FROM master_drugs WHERE id=11")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(raw, -1.0);
    }

    async fn cache_fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,permissions TEXT,is_active INTEGER);
            INSERT INTO users VALUES
              ('pos-a','cashier','tenant-a','{"can_access_pos":true}',1),
              ('stores-b','pharmacist','tenant-b','{"can_view_stores":true}',1),
              ('legacy','owner','local_default','{}',1),
              ('denied','cashier','tenant-a','{"can_access_pos":false,"can_view_stores":false}',1),
              ('inactive','owner','tenant-a','{}',0);
            CREATE TABLE master_drugs(
              id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,generic_name TEXT,
              active_ingredient TEXT,barcode TEXT,manufacturer TEXT,
              is_medicine INTEGER,is_service INTEGER,stop_dealing INTEGER,
              official_price REAL,has_expiry INTEGER,large_unit TEXT,
              medium_unit TEXT,small_unit TEXT,large_to_medium INTEGER,
              medium_to_small INTEGER,private_medical_notes TEXT);
            WITH RECURSIVE catalog_id(id) AS
              (SELECT 1 UNION ALL SELECT id+1 FROM catalog_id WHERE id<25004)
            INSERT INTO master_drugs(
              id,trade_name,is_medicine,is_service,stop_dealing,official_price,
              has_expiry,large_to_medium,medium_to_small,private_medical_notes)
            SELECT id,'Global drug '||id,1,0,0,id/10.0,
              CASE WHEN id=123 THEN 0 ELSE 1 END,12,10,'PRIVATE-DO-NOT-LEAK'
            FROM catalog_id;
        "#).execute(&mut conn).await.unwrap();
        conn
    }

    #[tokio::test]
    async fn native_catalog_cache_reads_all_25k_in_one_ordered_authenticated_snapshot() {
        let mut conn = cache_fixture().await;
        let from_pos_a = read_catalog_cache(&mut conn, "pos-a").await.unwrap();
        assert_eq!(from_pos_a.len(), 25004);
        assert_eq!(from_pos_a[0]["id"], 1);
        assert_eq!(from_pos_a[199]["id"], 200);
        assert_eq!(from_pos_a[200]["id"], 201);
        assert_eq!(from_pos_a[25003]["id"], 25004);
        assert_eq!(from_pos_a[122]["has_expiry"], 0);
        assert_eq!(from_pos_a[122]["is_medicine"], 1);
        assert_eq!(from_pos_a[122]["is_service"], 0);
        assert_eq!(from_pos_a[122]["large_to_medium"], 12);
        assert!(!from_pos_a[122].to_string().contains("PRIVATE-DO-NOT-LEAK"));
        // Catalog names are globally shared reference data; the tenant check
        // limits actor permissions, never borrows another branch's inventory.
        let from_stores_b = read_catalog_cache(&mut conn, "stores-b").await.unwrap();
        assert_eq!(from_stores_b.len(), from_pos_a.len());
        assert_eq!(from_stores_b[122], from_pos_a[122]);
        for actor in ["denied", "inactive", "missing"] {
            assert!(read_catalog_cache(&mut conn, actor).await.is_err());
        }
        sqlx::query("UPDATE users SET permissions='{}' WHERE id='pos-a'")
            .execute(&mut conn).await.unwrap();
        assert!(read_catalog_cache(&mut conn, "pos-a").await.is_err());
    }

    #[tokio::test]
    async fn native_catalog_cache_fails_closed_on_corruption_and_oversize_without_writes() {
        let mut conn = cache_fixture().await;
        sqlx::query("UPDATE master_drugs SET has_expiry=NULL WHERE id=201")
            .execute(&mut conn).await.unwrap();
        assert!(read_catalog_cache(&mut conn, "pos-a").await.unwrap_err()
            .contains("classification or expiry"));
        let raw: Option<i64> = sqlx::query_scalar("SELECT has_expiry FROM master_drugs WHERE id=201")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(raw, None);
        sqlx::query("UPDATE master_drugs SET has_expiry=1 WHERE id=201")
            .execute(&mut conn).await.unwrap();

        sqlx::raw_sql(r#"
            WITH RECURSIVE extra(id) AS
              (SELECT 25005 UNION ALL SELECT id+1 FROM extra WHERE id<=30000)
            INSERT INTO master_drugs(id,trade_name,is_medicine,is_service,stop_dealing,
              official_price,has_expiry,large_to_medium,medium_to_small)
            SELECT id,'Additional global drug',1,0,0,1.0,1,12,10 FROM extra;
        "#).execute(&mut conn).await.unwrap();
        assert!(read_catalog_cache(&mut conn, "pos-a").await.unwrap_err()
            .contains("30000-drug cache limit"));
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM master_drugs")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(rows, 30001);
    }
}
