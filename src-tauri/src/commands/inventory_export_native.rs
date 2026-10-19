//! Fixed native inventory workbook snapshot. The webview supplies no actor,
//! tenant, SQL, projection or paging parameters. One snapshot joins explicit
//! tenant-owned lots to their shared master records without writing either.
use serde::Serialize;
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::{borrow::Cow, collections::BTreeMap};
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

const MAX_EXPORT_ROWS: usize = 10_000;
const MAX_QUANTITY: f64 = 1_000_000_000.0;
const MAX_PRICE: f64 = 1_000_000_000.0;

/// JSON object keys inside each row intentionally match the existing Excel
/// worksheet snake_case columns. Only the two outer array keys are camelCase.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryExportSnapshot {
    inventory_rows: Vec<InventoryExportInventoryRow>,
    drug_rows: Vec<InventoryExportDrugRow>,
}

#[derive(Debug, Serialize)]
pub struct InventoryExportInventoryRow {
    id: String,
    drug_id: i64,
    pharmacy_id: String,
    quantity: f64,
    local_selling_price: f64,
    expiry_date: Option<String>,
    barcode: Option<String>,
    batch_number: Option<String>,
    strips_per_box: i64,
    medium_to_small: i64,
}

#[derive(Debug, Serialize)]
pub struct InventoryExportDrugRow {
    id: i64,
    trade_name: String,
    trade_name_en: Option<String>,
    generic_name: Option<String>,
    active_ingredient: Option<String>,
    barcode: Option<String>,
    category: Option<String>,
    manufacturer: Option<String>,
    has_expiry: i64,
    large_unit: Option<String>,
    medium_unit: Option<String>,
    small_unit: Option<String>,
    large_to_medium: i64,
    medium_to_small: i64,
}

async fn authorized_export_pharmacy(
    conn: &mut SqliteConnection,
    actor: &str,
) -> Result<String, String> {
    // Resolve the live actor/branch and permissions *inside* BEGIN IMMEDIATE.
    // Cached frontend roles, tenant hints and historic NULL pharmacy rows
    // cannot influence this command.
    let (role, pharmacy) = active_generic_actor(conn, actor).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users
         WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_manage_inventory",
        false,
    ) && !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "can_view_inventory",
        false,
    ) {
        return Err("Live inventory view or management permission required".into());
    }
    Ok(pharmacy)
}

fn bounded_text(value: &str, max_len: usize) -> bool {
    !value.is_empty() && value.len() <= max_len && !value.chars().any(char::is_control)
}

fn optional_text(value: Option<String>, max_len: usize) -> Result<Option<String>, String> {
    match value {
        None => Ok(None),
        Some(raw) if raw.trim().is_empty() => Ok(None),
        Some(raw) if bounded_text(&raw, max_len) => Ok(Some(raw)),
        _ => Err("Inventory export has malformed or oversized text".into()),
    }
}

fn optional_barcode(value: Option<String>) -> Result<Option<String>, String> {
    let barcode = optional_text(value, 128)?;
    Ok(barcode.map(|b| b.trim().to_owned()))
}

fn typed_text(
    row: &sqlx::sqlite::SqliteRow,
    name: &str,
    max_len: usize,
) -> Result<Option<String>, String> {
    optional_text(row.try_get(name).map_err(|e| e.to_string())?, max_len)
}

fn stored_number_type(
    row: &sqlx::sqlite::SqliteRow,
    name: &str,
    allow_null: bool,
) -> Result<(), String> {
    let kind: String = row.try_get(name).map_err(|e| e.to_string())?;
    if matches!(kind.as_str(), "integer" | "real") || (allow_null && kind == "null") {
        Ok(())
    } else {
        Err(format!(
            "Inventory export has malformed numeric field {name}"
        ))
    }
}

fn stored_integer_type(row: &sqlx::sqlite::SqliteRow, name: &str) -> Result<(), String> {
    let kind: String = row.try_get(name).map_err(|e| e.to_string())?;
    if matches!(kind.as_str(), "integer" | "null") {
        Ok(())
    } else {
        Err(format!(
            "Inventory export has malformed conversion field {name}"
        ))
    }
}

fn conversion(raw: Option<i64>) -> Result<i64, String> {
    let units = match raw.unwrap_or(1) {
        0 => 1,
        units => units,
    };
    if !(1..=10_000).contains(&units) {
        Err("Inventory export has invalid unit-conversion factor".into())
    } else {
        Ok(units)
    }
}

fn valid_quantity(value: f64) -> bool {
    value.is_finite() && (0.0..=MAX_QUANTITY).contains(&value)
}

fn valid_price(value: f64) -> bool {
    value.is_finite()
        && (0.0..=MAX_PRICE).contains(&value)
        && (value * 100.0 - (value * 100.0).round()).abs() <= 0.00001
}

fn decode_row(
    row: &sqlx::sqlite::SqliteRow,
    pharmacy: &str,
) -> Result<(InventoryExportInventoryRow, InventoryExportDrugRow), String> {
    for numeric in ["qty_type", "selling_price_type"] {
        stored_number_type(row, numeric, false)?;
    }
    for integer in [
        "lot_pack_type",
        "lot_small_type",
        "master_pack_type",
        "master_small_type",
        "has_expiry_type",
    ] {
        stored_integer_type(row, integer)?;
    }
    let id: String = row.try_get("lot_id").map_err(|e| e.to_string())?;
    let drug_id: i64 = row.try_get("lot_drug_id").map_err(|e| e.to_string())?;
    let owner: String = row.try_get("lot_pharmacy").map_err(|e| e.to_string())?;
    let master_id: Option<i64> = row.try_get("master_id").map_err(|e| e.to_string())?;
    if !bounded_text(&id, 128)
        || id != id.trim()
        || drug_id <= 0
        || master_id != Some(drug_id)
        || owner != pharmacy
    {
        return Err("Inventory export has orphaned, invalid or foreign lot data".into());
    }
    let quantity: f64 = row.try_get("quantity").map_err(|e| e.to_string())?;
    let local_selling_price: f64 = row
        .try_get("local_selling_price")
        .map_err(|e| e.to_string())?;
    if !valid_quantity(quantity) || !valid_price(local_selling_price) {
        return Err("Inventory export has invalid quantity or selling price".into());
    }
    let master_pack = conversion(row.try_get("master_pack").map_err(|e| e.to_string())?)?;
    let master_small = conversion(row.try_get("master_small").map_err(|e| e.to_string())?)?;
    let lot_pack: Option<i64> = row.try_get("lot_pack").map_err(|e| e.to_string())?;
    let lot_small: Option<i64> = row.try_get("lot_small").map_err(|e| e.to_string())?;
    let strips_per_box = if lot_pack.unwrap_or(0) == 0 {
        master_pack
    } else {
        conversion(lot_pack)?
    };
    let medium_to_small = if lot_small.unwrap_or(0) == 0 {
        master_small
    } else {
        conversion(lot_small)?
    };
    let name: Option<String> = typed_text(row, "trade_name", 512)?;
    let trade_name = name.ok_or("Inventory export has missing master drug identity")?;
    let has_expiry = row
        .try_get::<Option<i64>, _>("has_expiry")
        .map_err(|e| e.to_string())?
        .unwrap_or(1);
    if !matches!(has_expiry, 0 | 1) {
        return Err("Inventory export has invalid master expiry flag".into());
    }
    let own_barcode = optional_barcode(row.try_get("lot_barcode").map_err(|e| e.to_string())?)?;
    let master_barcode =
        optional_barcode(row.try_get("master_barcode").map_err(|e| e.to_string())?)?;
    let inventory = InventoryExportInventoryRow {
        id,
        drug_id,
        pharmacy_id: owner,
        quantity,
        local_selling_price,
        expiry_date: typed_text(row, "expiry_date", 64)?,
        // Sibling fallback is resolved later solely from the exported,
        // tenant-owned rows, preventing foreign-drug/branch lookup.
        barcode: own_barcode.or_else(|| master_barcode.clone()),
        batch_number: typed_text(row, "batch_number", 128)?,
        strips_per_box,
        medium_to_small,
    };
    let master = InventoryExportDrugRow {
        id: drug_id,
        trade_name,
        trade_name_en: typed_text(row, "trade_name_en", 512)?,
        generic_name: typed_text(row, "generic_name", 512)?,
        active_ingredient: typed_text(row, "active_ingredient", 512)?,
        barcode: master_barcode,
        category: typed_text(row, "category", 256)?,
        manufacturer: typed_text(row, "manufacturer", 256)?,
        has_expiry,
        large_unit: typed_text(row, "large_unit", 128)?,
        medium_unit: typed_text(row, "medium_unit", 128)?,
        small_unit: typed_text(row, "small_unit", 128)?,
        large_to_medium: master_pack,
        medium_to_small: master_small,
    };
    Ok((inventory, master))
}

async fn has_inventory_medium_to_small(conn: &mut SqliteConnection) -> Result<bool, String> {
    let rows = sqlx::query("PRAGMA main.table_info('inventory')")
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().any(|row| {
        row.try_get::<String, _>("name")
            .is_ok_and(|name| name == "medium_to_small")
    }))
}

async fn fetch_snapshot_rows(
    conn: &mut SqliteConnection,
    pharmacy: &str,
    has_medium_to_small: bool,
) -> Result<Vec<sqlx::sqlite::SqliteRow>, String> {
    let query = if has_medium_to_small {
        EXPORT_QUERY_WITH_SMALL_UNIT
    } else {
        EXPORT_QUERY_LEGACY_UNIT
    };
    sqlx::query(query)
        .bind(pharmacy)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())
}

// Fixed projection excludes financial/private fields (cost, suppliers, catalog
// pricing, tax, discounts, free-form notes, clinical indications, side effects).
// LEFT JOIN permits detection of orphan lots rather than silently dropping
// them as an INNER JOIN would. LIMIT 10001 detects overflow without truncating.
const EXPORT_QUERY_WITH_SMALL_UNIT: &str = concat!(
    "SELECT i.id lot_id,i.drug_id lot_drug_id,i.pharmacy_id lot_pharmacy,",
    " CAST(i.quantity AS REAL) quantity,typeof(i.quantity) qty_type,",
    " CAST(i.local_selling_price AS REAL) local_selling_price,",
    " typeof(i.local_selling_price) selling_price_type,",
    " i.expiry_date,i.batch_number,i.barcode lot_barcode,",
    " i.strips_per_box lot_pack,typeof(i.strips_per_box) lot_pack_type,",
    " i.medium_to_small lot_small,typeof(i.medium_to_small) lot_small_type,",
    " m.id master_id,m.trade_name,m.trade_name_en,m.generic_name,",
    " m.active_ingredient,m.barcode master_barcode,m.category,m.manufacturer,",
    " m.has_expiry,typeof(m.has_expiry) has_expiry_type,",
    " m.large_unit,m.medium_unit,m.small_unit,",
    " m.large_to_medium master_pack,typeof(m.large_to_medium) master_pack_type,",
    " m.medium_to_small master_small,typeof(m.medium_to_small) master_small_type",
    " FROM main.inventory i LEFT JOIN main.master_drugs m ON m.id=i.drug_id",
    " WHERE i.pharmacy_id=?",
    " ORDER BY i.drug_id,i.id COLLATE BINARY LIMIT 10001"
);

const EXPORT_QUERY_LEGACY_UNIT: &str = concat!(
    "SELECT i.id lot_id,i.drug_id lot_drug_id,i.pharmacy_id lot_pharmacy,",
    " CAST(i.quantity AS REAL) quantity,typeof(i.quantity) qty_type,",
    " CAST(i.local_selling_price AS REAL) local_selling_price,",
    " typeof(i.local_selling_price) selling_price_type,",
    " i.expiry_date,i.batch_number,i.barcode lot_barcode,",
    " i.strips_per_box lot_pack,typeof(i.strips_per_box) lot_pack_type,",
    " NULL lot_small,'null' lot_small_type,",
    " m.id master_id,m.trade_name,m.trade_name_en,m.generic_name,",
    " m.active_ingredient,m.barcode master_barcode,m.category,m.manufacturer,",
    " m.has_expiry,typeof(m.has_expiry) has_expiry_type,",
    " m.large_unit,m.medium_unit,m.small_unit,",
    " m.large_to_medium master_pack,typeof(m.large_to_medium) master_pack_type,",
    " m.medium_to_small master_small,typeof(m.medium_to_small) master_small_type",
    " FROM main.inventory i LEFT JOIN main.master_drugs m ON m.id=i.drug_id",
    " WHERE i.pharmacy_id=?",
    " ORDER BY i.drug_id,i.id COLLATE BINARY LIMIT 10001"
);

async fn snapshot(
    conn: &mut SqliteConnection,
    actor: &str,
) -> Result<InventoryExportSnapshot, String> {
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result = async {
        let pharmacy = authorized_export_pharmacy(&mut tx, actor).await?;
        let with_small = has_inventory_medium_to_small(&mut tx).await?;
        let rows = fetch_snapshot_rows(&mut tx, &pharmacy, with_small).await?;
        if rows.len() > MAX_EXPORT_ROWS {
            return Err(
                "Inventory export exceeds 10000 tenant lots; split export is required".into(),
            );
        }
        let mut inventory_rows = Vec::with_capacity(rows.len());
        let mut unique_drugs = BTreeMap::<i64, InventoryExportDrugRow>::new();
        let mut tenant_barcodes = BTreeMap::<i64, String>::new();
        for row in &rows {
            let (lot, drug) = decode_row(row, &pharmacy)?;
            if lot.quantity > 0.0 {
                if let Some(barcode) = &lot.barcode {
                    // The rows are ordered by (drug,id). First valid active
                    // lot barcode wins deterministically for this drug.
                    tenant_barcodes
                        .entry(lot.drug_id)
                        .or_insert_with(|| barcode.clone());
                }
            }
            // Every master row is taken from the same transaction and joined
            // to an owned lot. A global drug with no tenant stock stays hidden.
            unique_drugs.entry(drug.id).or_insert(drug);
            inventory_rows.push(lot);
        }
        for lot in &mut inventory_rows {
            if lot.barcode.is_none() {
                lot.barcode = tenant_barcodes.get(&lot.drug_id).cloned();
            }
        }
        Ok(InventoryExportSnapshot {
            inventory_rows,
            drug_rows: unique_drugs.into_values().collect(),
        })
    }
    .await;
    match result {
        Ok(snapshot) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(snapshot)
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
pub async fn export_inventory_snapshot_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<InventoryExportSnapshot, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    snapshot(&mut conn, actor.as_deref().ok_or("Login required")?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    async fn setup(conn: &mut SqliteConnection, with_small_unit: bool) {
        sqlx::raw_sql(
            r#"
            CREATE TABLE users(
                id TEXT PRIMARY KEY, role TEXT, pharmacy_id TEXT,
                permissions TEXT, is_active INTEGER
            );
            INSERT INTO users VALUES
                ('manager-a','cashier','A','{"can_manage_inventory":true}',1),
                ('viewer-a','cashier','A','{"can_view_inventory":true}',1),
                ('manager-b','cashier','B','{"can_manage_inventory":true}',1),
                ('owner-a','owner','A','{}',1),
                ('inactive-a','owner','A','{}',0),
                ('denied-a','cashier','A','{"can_manage_inventory":false,"can_view_inventory":false}',1),
                ('local-viewer','cashier','local_default','{"can_view_inventory":true}',1);
            CREATE TABLE master_drugs(
                id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,
                generic_name TEXT,active_ingredient TEXT,barcode TEXT,
                category TEXT,manufacturer TEXT,has_expiry INTEGER,
                large_unit TEXT,medium_unit TEXT,small_unit TEXT,
                large_to_medium INTEGER,medium_to_small INTEGER,
                official_price REAL,notes TEXT,side_effects TEXT
            );
            INSERT INTO master_drugs
                (id,trade_name,trade_name_en,generic_name,active_ingredient,barcode,
                 category,manufacturer,has_expiry,large_unit,medium_unit,small_unit,
                 large_to_medium,medium_to_small,official_price,notes,side_effects)
            VALUES
                (10,'Drug A','Drug A EN','generic-a','ingredient-a','MASTER-10',
                    'Category A','Manufacturer A',1,'box','strip','pill',12,10,
                    9999,'PRIVATE NOTES A','PRIVATE CLINICAL A'),
                (20,'Drug B','Drug B EN','generic-b','ingredient-b',NULL,
                    'Category B','Manufacturer B',0,'box','blister','pill',6,8,
                    9999,'PRIVATE NOTES B','PRIVATE CLINICAL B'),
                (30,'Foreign Drug','Foreign Drug EN',NULL,NULL,'FOREIGN-30',
                    NULL,NULL,1,NULL,NULL,NULL,1,1,9999,
                    'PRIVATE NOTES FOREIGN','PRIVATE CLINICAL FOREIGN');
            "#,
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        let schema = if with_small_unit {
            r#"CREATE TABLE inventory(
                id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
                quantity REAL,local_selling_price REAL,expiry_date TEXT,
                barcode TEXT,batch_number TEXT,strips_per_box INTEGER,
                medium_to_small INTEGER,cost_price REAL,supplier TEXT
            )"#
        } else {
            r#"CREATE TABLE inventory(
                id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
                quantity REAL,local_selling_price REAL,expiry_date TEXT,
                barcode TEXT,batch_number TEXT,strips_per_box INTEGER,
                cost_price REAL,supplier TEXT
            )"#
        };
        sqlx::query(schema).execute(&mut *conn).await.unwrap();
    }

    async fn memory(with_small_unit: bool) -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        setup(&mut conn, with_small_unit).await;
        conn
    }

    async fn put_lot(
        conn: &mut SqliteConnection,
        id: &str,
        drug_id: i64,
        pharmacy: Option<&str>,
        barcode: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,local_selling_price,
                                   expiry_date,barcode,batch_number,strips_per_box,
                                   cost_price,supplier)
             VALUES(?,?,?,2.5,50,'2030-01-01',?,'BATCH-A',12,12,'PRIVATE SUPPLIER')",
        )
        .bind(id)
        .bind(drug_id)
        .bind(pharmacy)
        .bind(barcode)
        .execute(&mut *conn)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn branch_isolation_never_includes_foreign_or_null_pharmacy_lots() {
        let mut conn = memory(true).await;
        put_lot(&mut conn, "local-only", 10, Some("A"), Some("LOT-A")).await;
        put_lot(&mut conn, "foreign-only", 30, Some("B"), Some("LOT-B")).await;
        put_lot(&mut conn, "unowned-historic", 20, None, Some("ORPHAN")).await;
        put_lot(
            &mut conn,
            "explicit-default",
            20,
            Some("local_default"),
            None,
        )
        .await;
        let first = snapshot(&mut conn, "manager-a").await.unwrap();
        assert_eq!(first.inventory_rows.len(), 1);
        assert_eq!(first.inventory_rows[0].id, "local-only");
        assert_eq!(first.inventory_rows[0].pharmacy_id, "A");
        assert_eq!(first.drug_rows.len(), 1);
        assert_eq!(first.drug_rows[0].id, 10);
        let other = snapshot(&mut conn, "manager-b").await.unwrap();
        assert_eq!(other.inventory_rows.len(), 1);
        assert_eq!(other.inventory_rows[0].id, "foreign-only");
        assert_eq!(other.drug_rows[0].id, 30);
        let local = snapshot(&mut conn, "local-viewer").await.unwrap();
        assert_eq!(local.inventory_rows.len(), 1);
        assert_eq!(local.inventory_rows[0].id, "explicit-default");
        assert!(local
            .inventory_rows
            .iter()
            .all(|row| row.id != "unowned-historic"));
    }

    #[tokio::test]
    async fn live_inventory_view_or_manage_permission_required_and_inactive_denied() {
        let mut conn = memory(true).await;
        put_lot(&mut conn, "a-1", 10, Some("A"), None).await;
        for actor in ["manager-a", "viewer-a", "owner-a"] {
            assert_eq!(
                snapshot(&mut conn, actor)
                    .await
                    .unwrap()
                    .inventory_rows
                    .len(),
                1,
                "{actor}"
            );
        }
        for actor in ["inactive-a", "denied-a", "missing"] {
            assert!(snapshot(&mut conn, actor).await.is_err(), "{actor}");
        }
        conn.execute(
            "UPDATE users SET permissions='{\"can_view_inventory\":false,\"can_manage_inventory\":false}'
             WHERE id='viewer-a'",
        )
        .await
        .unwrap();
        assert!(
            snapshot(&mut conn, "viewer-a").await.is_err(),
            "permission revoke is checked against live database"
        );
        conn.execute("UPDATE users SET pharmacy_id='B' WHERE id='manager-a'")
            .await
            .unwrap();
        assert!(
            snapshot(&mut conn, "manager-a")
                .await
                .unwrap()
                .inventory_rows
                .is_empty(),
            "live branch reassignment must not retain previous branch scope"
        );
    }

    #[tokio::test]
    async fn explicit_overflow_at_10001_rows_returns_error_without_truncation() {
        let mut conn = memory(true).await;
        sqlx::query(
            "WITH RECURSIVE n(x) AS (
                 SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001
             )
             INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,
                                   local_selling_price,strips_per_box)
             SELECT printf('export-%05d',x),10,'A',1,40,12 FROM n",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let error = snapshot(&mut conn, "viewer-a").await.unwrap_err();
        assert!(error.contains("exceeds 10000"), "{error}");
        // Failures roll back the BEGIN IMMEDIATE and release the connection:
        // a subsequent query can inspect all original rows unchanged.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM inventory")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 10001);
    }

    #[tokio::test]
    async fn consistent_whitelisted_join_stable_sort_and_barcode_provenance() {
        let mut conn = memory(true).await;
        put_lot(&mut conn, "z-drug-10", 10, Some("A"), Some("OWN-10")).await;
        put_lot(&mut conn, "a-drug-10", 10, Some("A"), None).await;
        put_lot(&mut conn, "a-drug-20", 20, Some("A"), None).await;
        put_lot(&mut conn, "z-drug-20", 20, Some("A"), Some("SIBLING-20")).await;
        put_lot(&mut conn, "foreign", 30, Some("B"), Some("HIDDEN-B")).await;
        let output = snapshot(&mut conn, "viewer-a").await.unwrap();
        let ids: Vec<&str> = output
            .inventory_rows
            .iter()
            .map(|v| v.id.as_str())
            .collect();
        assert_eq!(ids, ["a-drug-10", "z-drug-10", "a-drug-20", "z-drug-20"]);
        assert_eq!(
            output.drug_rows.iter().map(|v| v.id).collect::<Vec<_>>(),
            [10, 20]
        );
        assert_eq!(
            output.inventory_rows[0].barcode.as_deref(),
            Some("MASTER-10"),
            "lot without barcode prefers its own drug's global master"
        );
        assert_eq!(output.inventory_rows[1].barcode.as_deref(), Some("OWN-10"));
        assert_eq!(
            output.inventory_rows[2].barcode.as_deref(),
            Some("SIBLING-20"),
            "same-tenant same-drug sibling barcode is allowed"
        );
        assert_eq!(
            output.inventory_rows[3].barcode.as_deref(),
            Some("SIBLING-20")
        );
        let json = serde_json::to_value(&output).unwrap();
        assert!(json.get("inventoryRows").is_some());
        assert!(json.get("drugRows").is_some());
        for key in [
            "cost_price",
            "supplier",
            "official_price",
            "notes",
            "side_effects",
            "is_service",
            "password_hash",
        ] {
            assert!(!json.to_string().contains(&format!("\"{key}\"")), "{key}");
        }
        assert_eq!(output.drug_rows[0].trade_name, "Drug A");
        assert_eq!(output.drug_rows[0].large_to_medium, 12);
        assert_eq!(output.drug_rows[0].medium_to_small, 10);
        assert_eq!(output.inventory_rows[0].local_selling_price, 50.0);
    }

    #[tokio::test]
    async fn corruption_and_missing_master_fail_closed_and_rollback_snapshot() {
        let mut conn = memory(true).await;
        put_lot(&mut conn, "valid", 10, Some("A"), None).await;
        put_lot(&mut conn, "bad", 20, Some("A"), None).await;
        for sabotage in [
            "UPDATE inventory SET quantity=-3 WHERE id='bad'",
            "UPDATE inventory SET quantity='not a number' WHERE id='bad'",
            "UPDATE inventory SET local_selling_price=1.23456 WHERE id='bad'",
            "UPDATE inventory SET strips_per_box=-4 WHERE id='bad'",
            "UPDATE master_drugs SET large_to_medium='bad' WHERE id=20",
            "UPDATE inventory SET drug_id=999 WHERE id='bad'",
        ] {
            let mut tx = conn.begin().await.unwrap();
            tx.execute(sabotage).await.unwrap();
            tx.commit().await.unwrap();
            assert!(snapshot(&mut conn, "viewer-a").await.is_err(), "{sabotage}");
            // Restore the specific corrupted row without changing other lot
            // identities; an error must never leave a write lock outstanding.
            conn.execute(
                "UPDATE inventory SET drug_id=20,quantity=2.5,
                 local_selling_price=50,strips_per_box=12 WHERE id='bad'",
            )
            .await
            .unwrap();
            conn.execute("UPDATE master_drugs SET large_to_medium=6 WHERE id=20")
                .await
                .unwrap();
            assert_eq!(
                snapshot(&mut conn, "viewer-a")
                    .await
                    .unwrap()
                    .inventory_rows
                    .len(),
                2
            );
        }
        let cost: f64 = sqlx::query_scalar("SELECT cost_price FROM inventory WHERE id='valid'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(cost, 12.0, "read-only export preserves financial data");
    }

    #[tokio::test]
    async fn old_schema_without_per_lot_small_unit_reads_verified_master_factor() {
        let mut conn = memory(false).await;
        put_lot(&mut conn, "legacy", 20, Some("A"), None).await;
        let output = snapshot(&mut conn, "viewer-a").await.unwrap();
        assert_eq!(output.inventory_rows.len(), 1);
        assert_eq!(output.inventory_rows[0].strips_per_box, 12);
        assert_eq!(output.inventory_rows[0].medium_to_small, 8);
    }
}
