//! Bounded native inventory import: new stock lots for existing master drugs.
//! No workbook SQL, existing-lot ID, master-catalog write or historical edit.
//! One BEGIN IMMEDIATE covers actor authorization, every inserted lot, shortage
//! resolution, audit, and the durable retry receipt.
use serde::{
    de::{self, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::{borrow::Cow, collections::HashSet};
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

const MAX_IMPORT_ROWS: usize = 200;
const MAX_QTY: f64 = 1_000_000_000.0;
const MAX_PRICE: f64 = 1_000_000_000.0;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryImportRow {
    drug_id: i64,
    quantity: f64,
    local_selling_price: f64,
    expiry_date: Option<String>,
    barcode: Option<String>,
    // Assertions only: these never change master_drugs or its shared units.
    unit: Option<String>,
    #[serde(default)]
    expect_null_large_unit: bool,
    large_to_medium: Option<i64>,
    medium_to_small: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryImportInput {
    request_id: String,
    #[serde(deserialize_with = "bounded_import_rows")]
    rows: Vec<InventoryImportRow>,
}

fn bounded_import_rows<'de, D>(deserializer: D) -> Result<Vec<InventoryImportRow>, D::Error>
where
    D: Deserializer<'de>,
{
    struct BoundedRows;
    impl<'de> Visitor<'de> for BoundedRows {
        type Value = Vec<InventoryImportRow>;

        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            write!(f, "an array of at most {MAX_IMPORT_ROWS} inventory rows")
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
            let mut rows = Vec::new();
            while let Some(next) = sequence.next_element::<InventoryImportRow>()? {
                if rows.len() == MAX_IMPORT_ROWS {
                    return Err(de::Error::custom("Inventory import exceeds 200 rows"));
                }
                rows.push(next);
            }
            Ok(rows)
        }
    }
    deserializer.deserialize_seq(BoundedRows)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryImportResult {
    success: bool,
    request_id: String,
    inventory_ids: Vec<String>,
    inventory_count: usize,
    replayed: bool,
}

fn is_canonical_uuid_v4(raw: &str) -> bool {
    Uuid::parse_str(raw).is_ok_and(|id| id.get_version_num() == 4 && id.to_string() == raw)
}

fn valid_money(value: f64) -> bool {
    value.is_finite()
        && !value.is_sign_negative()
        && value <= MAX_PRICE
        && (value * 100.0 - (value * 100.0).round()).abs() <= 0.00001
}

fn valid_quantity(value: f64) -> bool {
    value.is_finite() && value >= 0.000_000_000_1 && value <= MAX_QTY
}

fn valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit())
    {
        return false;
    }
    let year = date[0..4].parse::<u32>().unwrap_or(0);
    let month = date[5..7].parse::<u32>().unwrap_or(0);
    let day = date[8..10].parse::<u32>().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    year > 0 && day > 0 && day <= days
}

fn validate_import(data: &InventoryImportInput) -> Result<(), String> {
    if !is_canonical_uuid_v4(&data.request_id)
        || data.rows.is_empty()
        || data.rows.len() > MAX_IMPORT_ROWS
    {
        return Err("Inventory import requires canonical UUIDv4 and 1-200 rows".into());
    }
    for row in &data.rows {
        if row.drug_id <= 0
            || !valid_quantity(row.quantity)
            || !valid_money(row.local_selling_price)
            || row.expiry_date.as_deref().is_some_and(|d| !valid_date(d))
            || row.barcode.as_deref().is_some_and(|b| {
                b.is_empty() || b.len() > 128 || b != b.trim() || b.chars().any(char::is_control)
            })
            || row
                .unit
                .as_deref()
                .is_some_and(|u| u.len() > 128 || u.chars().any(char::is_control))
            || row
                .large_to_medium
                .is_some_and(|v| !(1..=10_000).contains(&v))
            || row
                .medium_to_small
                .is_some_and(|v| !(1..=10_000).contains(&v))
        {
            return Err(
                "Inventory import row contains invalid catalog, stock, price or unit assertion"
                    .into(),
            );
        }
    }
    Ok(())
}

fn import_hash(rows: &[InventoryImportRow], actor: &str, pharmacy: &str) -> Result<String, String> {
    // Deliberately exclude the nonce: a second nonce with identical batch
    // intent must recover the first receipt instead of duplicating stock.
    let typed = serde_json::to_vec(rows).map_err(|_| "Cannot encode inventory import intent")?;
    let mut hash = Sha256::new();
    hash.update(b"pharma-inventory-import-v1");
    for part in [actor.as_bytes(), pharmacy.as_bytes(), typed.as_slice()] {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    Ok(format!("{:x}", hash.finalize()))
}

async fn authorized_pharmacy(conn: &mut SqliteConnection, actor: &str) -> Result<String, String> {
    let (role, pharmacy) = active_generic_actor(conn, actor).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
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
    ) {
        return Err("Live inventory management permission required".into());
    }
    Ok(pharmacy)
}

async fn replay_receipt(
    conn: &mut SqliteConnection,
    actor: &str,
    pharmacy: &str,
    data: &InventoryImportInput,
    hash: &str,
) -> Result<Option<InventoryImportResult>, String> {
    let matches = sqlx::query(
        "SELECT request_id,pharmacy_id,created_by,payload_hash,
                inventory_ids_json,inventory_count
         FROM main.inventory_lot_import_receipts
         WHERE request_id=? OR payload_hash=?",
    )
    .bind(&data.request_id)
    .bind(hash)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if matches.is_empty() {
        return Ok(None);
    }
    if matches.len() != 1 {
        return Err("Inventory import nonce and payload point to conflicting receipts".into());
    }
    let receipt = &matches[0];
    let previous_request: String = receipt.try_get("request_id").map_err(|e| e.to_string())?;
    let previous_hash: String = receipt.try_get("payload_hash").map_err(|e| e.to_string())?;
    let previous_actor: String = receipt.try_get("created_by").map_err(|e| e.to_string())?;
    let previous_pharmacy: String = receipt.try_get("pharmacy_id").map_err(|e| e.to_string())?;
    let count: i64 = receipt
        .try_get("inventory_count")
        .map_err(|e| e.to_string())?;
    if previous_hash != hash || previous_actor != actor || previous_pharmacy != pharmacy {
        return Err(
            "Inventory import receipt belongs to different content, user or pharmacy".into(),
        );
    }
    let json: String = receipt
        .try_get("inventory_ids_json")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = serde_json::from_str(&json)
        .map_err(|_| "Stored inventory import receipt has invalid lot IDs")?;
    if count != data.rows.len() as i64 || ids.len() != data.rows.len() {
        return Err("Stored inventory import receipt row count is inconsistent".into());
    }
    let mut unique = HashSet::new();
    for (id, row) in ids.iter().zip(&data.rows) {
        if !is_canonical_uuid_v4(id) || !unique.insert(id) {
            return Err("Stored inventory import receipt has duplicated or invalid lot IDs".into());
        }
        // Stock quantity can legitimately have changed through sales, but
        // missing/deleted/reassigned physical lots must never be resurrected.
        let owned: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM main.inventory
             WHERE id=? AND drug_id=? AND pharmacy_id=? LIMIT 1",
        )
        .bind(id)
        .bind(row.drug_id)
        .bind(pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if owned.is_none() {
            return Err("Previously imported lot is missing, changed drug or pharmacy".into());
        }
    }
    Ok(Some(InventoryImportResult {
        success: true,
        request_id: previous_request,
        inventory_count: ids.len(),
        inventory_ids: ids,
        replayed: true,
    }))
}

async fn barcode_uncontested(
    conn: &mut SqliteConnection,
    drug_id: i64,
    barcode: Option<&str>,
) -> Result<(), String> {
    let Some(code) = barcode else {
        return Ok(());
    };
    let clashes: i64 = sqlx::query_scalar(
        "SELECT
           (SELECT COUNT(*) FROM main.master_drugs
            WHERE id<>? AND barcode IS NOT NULL AND TRIM(barcode)=? COLLATE NOCASE)
         + (SELECT COUNT(*) FROM main.inventory
            WHERE (drug_id IS NULL OR drug_id<>?)
              AND barcode IS NOT NULL AND TRIM(barcode)=? COLLATE NOCASE
              AND (quantity IS NULL OR quantity<>0))",
    )
    .bind(drug_id)
    .bind(code)
    .bind(drug_id)
    .bind(code)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if clashes != 0 {
        return Err(
            "Barcode is assigned to a different drug in the authoritative catalog or active stock"
                .into(),
        );
    }
    Ok(())
}

async fn has_small_unit_column(conn: &mut SqliteConnection) -> Result<bool, String> {
    let columns = sqlx::query("PRAGMA main.table_info('inventory')")
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(columns.iter().any(|column| {
        column
            .try_get::<String, _>("name")
            .is_ok_and(|n| n == "medium_to_small")
    }))
}

async fn insert_catalog_lot(
    conn: &mut SqliteConnection,
    pharmacy: &str,
    row: &InventoryImportRow,
    has_small_unit: bool,
) -> Result<String, String> {
    let catalog = sqlx::query(
        "SELECT has_expiry,large_unit,large_to_medium,medium_to_small,
                stop_dealing,is_service
         FROM main.master_drugs WHERE id=? LIMIT 1",
    )
    .bind(row.drug_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or("Inventory import references unknown master-drug ID")?;
    let expires: Option<i64> = catalog.try_get("has_expiry").map_err(|e| e.to_string())?;
    let retired: Option<i64> = catalog.try_get("stop_dealing").map_err(|e| e.to_string())?;
    let service: Option<i64> = catalog.try_get("is_service").map_err(|e| e.to_string())?;
    if retired.unwrap_or(0) != 0 || service.unwrap_or(0) != 0 {
        return Err("Inactive or service catalog item cannot receive stock".into());
    }
    if expires.unwrap_or(1) != 0 && row.expiry_date.is_none() {
        return Err("Expiring master drug requires a valid expiry date".into());
    }
    let large_unit: Option<String> = catalog.try_get("large_unit").map_err(|e| e.to_string())?;
    let large: Option<i64> = catalog
        .try_get("large_to_medium")
        .map_err(|e| e.to_string())?;
    let small: Option<i64> = catalog
        .try_get("medium_to_small")
        .map_err(|e| e.to_string())?;
    let normalize = |v: Option<i64>| match v.unwrap_or(1) {
        0 => 1,
        number => number,
    };
    let large = normalize(large);
    let small = normalize(small);
    if !(1..=10_000).contains(&large) || !(1..=10_000).contains(&small) {
        return Err("Invalid authoritative master-drug unit conversion".into());
    }
    if (row.expect_null_large_unit
        && large_unit
            .as_deref()
            .is_some_and(|unit| !unit.trim().is_empty()))
        || row
            .large_to_medium
            .is_some_and(|asserted| asserted != large)
        || row
            .medium_to_small
            .is_some_and(|asserted| asserted != small)
        || row.unit.as_deref().is_some_and(|asserted| {
            let asserted = asserted.trim();
            !asserted.is_empty() && large_unit.as_deref().unwrap_or("").trim() != asserted
        })
    {
        return Err(
            "Stale or mismatched unit assertion; master drug is immutable during import".into(),
        );
    }
    barcode_uncontested(conn, row.drug_id, row.barcode.as_deref()).await?;
    let id = Uuid::new_v4().to_string();
    let inserted = if has_small_unit {
        sqlx::query(
            "INSERT INTO main.inventory
             (id,drug_id,pharmacy_id,quantity,local_selling_price,cost_price,
              expiry_date,barcode,strips_per_box,medium_to_small)
             VALUES(?,?,?,?,?,0,?,?,?,?)",
        )
        .bind(&id)
        .bind(row.drug_id)
        .bind(pharmacy)
        .bind(row.quantity)
        .bind(row.local_selling_price)
        .bind(row.expiry_date.as_deref())
        .bind(row.barcode.as_deref())
        .bind(large)
        .bind(small)
        .execute(&mut *conn)
        .await
    } else {
        sqlx::query(
            "INSERT INTO main.inventory
             (id,drug_id,pharmacy_id,quantity,local_selling_price,cost_price,
              expiry_date,barcode,strips_per_box)
             VALUES(?,?,?,?,?,0,?,?,?)",
        )
        .bind(&id)
        .bind(row.drug_id)
        .bind(pharmacy)
        .bind(row.quantity)
        .bind(row.local_selling_price)
        .bind(row.expiry_date.as_deref())
        .bind(row.barcode.as_deref())
        .bind(large)
        .execute(&mut *conn)
        .await
    }
    .map_err(|e| e.to_string())?;
    if inserted.rows_affected() != 1 {
        return Err("Inventory import lot insert did not create exactly one row".into());
    }
    Ok(id)
}

async fn import_batch(
    conn: &mut SqliteConnection,
    actor: &str,
    data: InventoryImportInput,
) -> Result<InventoryImportResult, String> {
    validate_import(&data)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result: Result<InventoryImportResult, String> = async {
        let conn = &mut *tx;
        let pharmacy = authorized_pharmacy(conn, actor).await?;
        let hash = import_hash(&data.rows, actor, &pharmacy)?;
        if let Some(existing) = replay_receipt(conn, actor, &pharmacy, &data, &hash).await? {
            return Ok(existing);
        }
        // Block an unacknowledged single-lot creation before a new bulk post.
        // Recover its original receipt first; this avoids doubling a lost-IPC
        // single create as a fresh import.
        let pending: Option<String> = sqlx::query_scalar(
            "SELECT r.request_id FROM main.inventory_lot_create_requests r
             LEFT JOIN main.inventory_lot_create_acknowledgements a
               ON a.request_id=r.request_id
             WHERE r.pharmacy_id=? AND a.request_id IS NULL LIMIT 1",
        )
        .bind(&pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if pending.is_some() {
            return Err("Previous inventory creation remains unacknowledged; recover the original receipt before importing".into());
        }
        let has_small = has_small_unit_column(conn).await?;
        let mut inventory_ids = Vec::with_capacity(data.rows.len());
        let mut drugs = HashSet::new();
        for row in &data.rows {
            inventory_ids.push(insert_catalog_lot(conn, &pharmacy, row, has_small).await?);
            drugs.insert(row.drug_id);
        }
        let ids_json = serde_json::to_string(&inventory_ids)
            .map_err(|_| "Cannot encode inventory import receipt")?;
        let saved = sqlx::query(
            "INSERT INTO main.inventory_lot_import_receipts
             (request_id,pharmacy_id,created_by,payload_hash,inventory_ids_json,inventory_count)
             VALUES(?,?,?,?,?,?)",
        )
        .bind(&data.request_id)
        .bind(&pharmacy)
        .bind(actor)
        .bind(&hash)
        .bind(&ids_json)
        .bind(data.rows.len() as i64)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if saved.rows_affected() != 1 {
            return Err("Inventory import receipt was not durably inserted".into());
        }
        sqlx::query(
            "INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
             VALUES(?,'ADD_INVENTORY',?,?)",
        )
        .bind(actor)
        .bind(format!(
            "native-inventory-batch-request={}; lot_count={}; receipt_sha256={}",
            data.request_id,
            inventory_ids.len(),
            hash
        ))
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        // Shortage transitions are inside the same transaction: if any
        // resolution fails the entire import, receipt, audit and stock rollback.
        for drug_id in drugs {
            super::inventory_history::resolve_opening_shortages(&mut tx, drug_id, &pharmacy)
                .await?;
        }
        Ok(InventoryImportResult {
            success: true,
            request_id: data.request_id,
            inventory_count: inventory_ids.len(),
            inventory_ids,
            replayed: false,
        })
    }
    .await;
    match result {
        Ok(value) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(value)
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
pub async fn import_inventory_lots_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    input: InventoryImportInput,
) -> Result<InventoryImportResult, String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    import_batch(
        &mut conn,
        session.as_deref().ok_or("Login required")?,
        input,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
        Connection,
    };
    use std::time::Duration;

    const FIRST: &str = "a1111111-1111-4111-8111-111111111111";
    const SECOND: &str = "b2222222-2222-4222-8222-222222222222";

    fn row(drug: i64, barcode: Option<&str>) -> InventoryImportRow {
        InventoryImportRow {
            drug_id: drug,
            quantity: 12.5,
            local_selling_price: 18.75,
            expiry_date: if drug == 10 {
                Some("2031-02-28".into())
            } else {
                None
            },
            barcode: barcode.map(str::to_string),
            unit: Some(if drug == 10 { "box" } else { "bottle" }.into()),
            expect_null_large_unit: false,
            large_to_medium: Some(if drug == 10 { 12 } else { 1 }),
            medium_to_small: Some(if drug == 10 { 10 } else { 1 }),
        }
    }

    fn batch(nonce: &str, rows: Vec<InventoryImportRow>) -> InventoryImportInput {
        InventoryImportInput {
            request_id: nonce.into(),
            rows,
        }
    }

    async fn setup_fixture(db: &mut SqliteConnection) {
        sqlx::raw_sql(
            r#"
            CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, permissions TEXT,
                pharmacy_id TEXT,is_active INTEGER);
            INSERT INTO users VALUES
                ('actor-a','cashier','{"can_manage_inventory":true}','A',1),
                ('actor-c','cashier','{"can_manage_inventory":true}','A',1),
                ('actor-b','cashier','{"can_manage_inventory":true}','B',1),
                ('denied','cashier','{"can_manage_inventory":false}','A',1),
                ('inactive','owner','{}','A',0);
            CREATE TABLE master_drugs(
                id INTEGER PRIMARY KEY, trade_name TEXT, barcode TEXT, has_expiry INTEGER,
                large_unit TEXT, large_to_medium INTEGER, medium_to_small INTEGER,
                stop_dealing INTEGER DEFAULT 0, is_service INTEGER DEFAULT 0,
                reorder_point INTEGER, min_limit INTEGER, medium_unit TEXT, small_unit TEXT
            );
            INSERT INTO master_drugs
                (id,trade_name,barcode,has_expiry,large_unit,large_to_medium,medium_to_small)
            VALUES (10,'First','CATALOG-A',1,'box',12,10),
                   (20,'Second','CATALOG-B',0,'bottle',1,1);
            CREATE TABLE inventory(
                id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
                quantity REAL,local_selling_price REAL,cost_price REAL DEFAULT 0,
                expiry_date TEXT,barcode TEXT,strips_per_box INTEGER,medium_to_small INTEGER
            );
            CREATE TABLE shortages(id INTEGER PRIMARY KEY,drug_id INTEGER,
                pharmacy_id TEXT,status TEXT);
            INSERT INTO shortages VALUES
                (1,10,'A','pending'),(2,20,'A','ordered'),(3,10,'B','pending');
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,
                status TEXT,created_at TEXT);
            CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,
                drug_id INTEGER,unit TEXT,quantity_sold REAL,is_negative INTEGER,
                large_to_medium INTEGER,medium_to_small INTEGER);
            CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,
                action TEXT,details TEXT,pharmacy_id TEXT);
            "#,
        )
        .execute(&mut *db)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/038_inventory_lot_create_requests.sql"
        ))
        .execute(&mut *db)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/039_inventory_create_acknowledgements.sql"
        ))
        .execute(&mut *db)
        .await
        .unwrap();
    }

    async fn fixture() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        setup_fixture(&mut db).await;
        db
    }

    async fn count(db: &mut SqliteConnection, table: &str) -> i64 {
        // Test-controlled table names only, never renderer input.
        let sql = match table {
            "inventory" => "SELECT COUNT(*) FROM inventory",
            "receipts" => "SELECT COUNT(*) FROM inventory_lot_import_receipts",
            "audit" => "SELECT COUNT(*) FROM activity_log",
            _ => panic!("unsupported test table"),
        };
        sqlx::query_scalar(sql).fetch_one(db).await.unwrap()
    }

    #[tokio::test]
    async fn concurrent_retries_across_connections_and_reopen_return_only_original_receipt() {
        let file = std::env::temp_dir().join(format!(
            "pharma-inventory-batch-replay-{}.sqlite",
            Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&file)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(8));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options.clone())
            .await
            .unwrap();
        {
            let mut connection = pool.acquire().await.unwrap();
            setup_fixture(&mut connection).await;
        }
        let (first, second) = tokio::join!(
            async {
                let mut connection = pool.acquire().await.unwrap();
                import_batch(
                    &mut connection,
                    "actor-a",
                    batch(FIRST, vec![row(10, None)]),
                )
                .await
            },
            async {
                let mut connection = pool.acquire().await.unwrap();
                import_batch(
                    &mut connection,
                    "actor-a",
                    batch(FIRST, vec![row(10, None)]),
                )
                .await
            }
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_ne!(first.replayed, second.replayed);
        assert_eq!(first.inventory_ids, second.inventory_ids);
        assert_eq!(first.request_id, FIRST);
        assert_eq!(second.request_id, FIRST);
        {
            let mut connection = pool.acquire().await.unwrap();
            assert_eq!(count(&mut connection, "inventory").await, 1);
            assert_eq!(count(&mut connection, "receipts").await, 1);
            assert_eq!(count(&mut connection, "audit").await, 1);
        }
        pool.close().await;

        // A new connection simulates a different authenticated session or
        // process restart. Even a fresh nonce for identical signed intent
        // returns the original durable receipt and may not add stock.
        let mut reopened = SqliteConnection::connect_with(&options).await.unwrap();
        let again = import_batch(&mut reopened, "actor-a", batch(SECOND, vec![row(10, None)]))
            .await
            .unwrap();
        assert!(again.replayed);
        assert_eq!(again.request_id, FIRST);
        assert_eq!(again.inventory_ids, first.inventory_ids);
        assert_eq!(count(&mut reopened, "inventory").await, 1);
        assert_eq!(count(&mut reopened, "receipts").await, 1);
        assert_eq!(count(&mut reopened, "audit").await, 1);

        // A damaged or reassigned source lot must not be recreated by the
        // old receipt even when the retry uses a distinct nonce.
        sqlx::query("UPDATE inventory SET pharmacy_id='B' WHERE id=?")
            .bind(&first.inventory_ids[0])
            .execute(&mut reopened)
            .await
            .unwrap();
        assert!(
            import_batch(&mut reopened, "actor-a", batch(SECOND, vec![row(10, None)]))
                .await
                .unwrap_err()
                .contains("missing, changed drug or pharmacy")
        );
        assert_eq!(count(&mut reopened, "inventory").await, 1);
        assert_eq!(count(&mut reopened, "receipts").await, 1);
        reopened.close().await.unwrap();
        // On Windows, SQLx's blocking SQLite worker can release its file
        // handle shortly after the async connection closes. Cleanup is not
        // an inventory behavior assertion and must not make a correct
        // concurrency/replay test fail due to Windows ERROR_SHARING_VIOLATION.
        for _ in 0..30 {
            if std::fs::remove_file(&file).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn rolled_back_batch_and_competing_nonce_mutation_are_atomic_across_connections() {
        let file = std::env::temp_dir().join(format!(
            "pharma-inventory-batch-atomic-{}.sqlite",
            Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&file)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(8));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .unwrap();
        {
            let mut connection = pool.acquire().await.unwrap();
            setup_fixture(&mut connection).await;
            assert!(import_batch(
                &mut connection,
                "actor-a",
                batch(FIRST, vec![row(10, None), row(999, None)])
            )
            .await
            .unwrap_err()
            .contains("unknown master-drug"));
        }
        {
            let mut second_connection = pool.acquire().await.unwrap();
            for table in ["inventory", "receipts", "audit"] {
                assert_eq!(count(&mut second_connection, table).await, 0);
            }
            let shortage: String = sqlx::query_scalar("SELECT status FROM shortages WHERE id=1")
                .fetch_one(&mut *second_connection)
                .await
                .unwrap();
            assert_eq!(shortage, "pending");
        }

        // Two sessions reuse the same nonce with different batches. BEGIN
        // IMMEDIATE and the durable receipt permit exactly one to win.
        let (first, second) = tokio::join!(
            async {
                let mut connection = pool.acquire().await.unwrap();
                import_batch(
                    &mut connection,
                    "actor-a",
                    batch(FIRST, vec![row(10, None)]),
                )
                .await
            },
            async {
                let mut connection = pool.acquire().await.unwrap();
                import_batch(
                    &mut connection,
                    "actor-a",
                    batch(FIRST, vec![row(20, None)]),
                )
                .await
            }
        );
        assert!(first.is_ok() ^ second.is_ok());
        let rejection = first.err().or_else(|| second.err()).unwrap();
        assert!(rejection.contains("different content"));
        let mut connection = pool.acquire().await.unwrap();
        assert_eq!(count(&mut connection, "inventory").await, 1);
        assert_eq!(count(&mut connection, "receipts").await, 1);
        assert_eq!(count(&mut connection, "audit").await, 1);
        drop(connection);
        pool.close().await;
        for _ in 0..30 {
            if std::fs::remove_file(&file).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn complete_batch_persists_zero_cost_audit_shortages_and_exact_replay_receipt() {
        let mut db = fixture().await;
        let input = batch(FIRST, vec![row(10, Some("BAR-A")), row(20, None)]);
        let original = import_batch(&mut db, "actor-a", input).await.unwrap();
        assert!(original.success && !original.replayed);
        assert_eq!(original.inventory_count, 2);
        assert_eq!(count(&mut db, "inventory").await, 2);
        assert_eq!(count(&mut db, "receipts").await, 1);
        assert_eq!(count(&mut db, "audit").await, 1);
        for id in &original.inventory_ids {
            let entry = sqlx::query(
                "SELECT pharmacy_id,cost_price,strips_per_box,medium_to_small FROM inventory WHERE id=?",
            )
            .bind(id)
            .fetch_one(&mut db)
            .await
            .unwrap();
            assert_eq!(entry.get::<String, _>("pharmacy_id"), "A");
            assert_eq!(entry.get::<f64, _>("cost_price"), 0.0);
            assert!(entry.get::<i64, _>("strips_per_box") >= 1);
            assert!(entry.get::<i64, _>("medium_to_small") >= 1);
        }
        let shortage_status: String = sqlx::query_scalar("SELECT status FROM shortages WHERE id=3")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(shortage_status, "pending"); // never resolve another pharmacy
        for shortage_id in [1, 2] {
            let resolved: String = sqlx::query_scalar("SELECT status FROM shortages WHERE id=?")
                .bind(shortage_id)
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert_eq!(resolved, "received");
        }

        let same_nonce = import_batch(
            &mut db,
            "actor-a",
            batch(FIRST, vec![row(10, Some("BAR-A")), row(20, None)]),
        )
        .await
        .unwrap();
        assert!(same_nonce.replayed);
        assert_eq!(same_nonce.inventory_ids, original.inventory_ids);
        let fresh_nonce = import_batch(
            &mut db,
            "actor-a",
            batch(SECOND, vec![row(10, Some("BAR-A")), row(20, None)]),
        )
        .await
        .unwrap();
        assert!(fresh_nonce.replayed);
        assert_eq!(fresh_nonce.request_id, FIRST);
        assert_eq!(fresh_nonce.inventory_ids, original.inventory_ids);
        assert_eq!(count(&mut db, "inventory").await, 2);
        assert_eq!(count(&mut db, "receipts").await, 1);
        assert_eq!(count(&mut db, "audit").await, 1);
        let altered = import_batch(&mut db, "actor-a", batch(FIRST, vec![row(20, None)]))
            .await
            .unwrap_err();
        assert!(altered.contains("different content"));
    }

    #[tokio::test]
    async fn bad_later_row_rolls_back_every_lot_audit_receipt_and_shortage() {
        let mut db = fixture().await;
        let err = import_batch(
            &mut db,
            "actor-a",
            batch(FIRST, vec![row(10, Some("VALID")), row(999, None)]),
        )
        .await
        .unwrap_err();
        assert!(err.contains("unknown master-drug"));
        for table in ["inventory", "receipts", "audit"] {
            assert_eq!(count(&mut db, table).await, 0);
        }
        let shortage: String = sqlx::query_scalar("SELECT status FROM shortages WHERE id=1")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(shortage, "pending");

        // Failure of a *late* shortage resolution also rolls back successful
        // inserts, the durable receipt and the audit in one transaction.
        sqlx::query("DROP TABLE sales_items")
            .execute(&mut db)
            .await
            .unwrap();
        assert!(
            import_batch(&mut db, "actor-a", batch(FIRST, vec![row(10, None)]))
                .await
                .is_err()
        );
        for table in ["inventory", "receipts", "audit"] {
            assert_eq!(count(&mut db, table).await, 0);
        }
    }

    #[tokio::test]
    async fn rejects_cross_pharmacy_permission_and_missing_original_receipt_lots() {
        let mut db = fixture().await;
        for actor in ["denied", "inactive", "no-user"] {
            assert!(
                import_batch(&mut db, actor, batch(FIRST, vec![row(10, None)]))
                    .await
                    .is_err()
            );
        }
        let first = import_batch(&mut db, "actor-a", batch(FIRST, vec![row(10, None)]))
            .await
            .unwrap();
        assert!(
            import_batch(&mut db, "actor-b", batch(FIRST, vec![row(10, None)]))
                .await
                .is_err()
        );
        assert_eq!(count(&mut db, "inventory").await, 1);
        sqlx::query("UPDATE inventory SET pharmacy_id='B' WHERE id=?")
            .bind(&first.inventory_ids[0])
            .execute(&mut db)
            .await
            .unwrap();
        assert!(
            import_batch(&mut db, "actor-a", batch(FIRST, vec![row(10, None)]))
                .await
                .unwrap_err()
                .contains("missing, changed drug or pharmacy")
        );
        assert_eq!(count(&mut db, "inventory").await, 1);
    }

    #[tokio::test]
    async fn rejects_barcode_conflicts_stale_units_and_pending_single_create() {
        let mut db = fixture().await;
        assert!(import_batch(
            &mut db,
            "actor-a",
            batch(FIRST, vec![row(10, Some("catalog-b"))]),
        )
        .await
        .unwrap_err()
        .contains("Barcode"));
        sqlx::query(
            "INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,barcode)
             VALUES('old-lot',20,'B',1,'EXISTING')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        assert!(import_batch(
            &mut db,
            "actor-a",
            batch(FIRST, vec![row(10, Some("existing"))]),
        )
        .await
        .unwrap_err()
        .contains("Barcode"));
        let mut stale = row(10, None);
        stale.medium_to_small = Some(99);
        assert!(import_batch(&mut db, "actor-a", batch(FIRST, vec![stale]))
            .await
            .unwrap_err()
            .contains("unit assertion"));
        assert_eq!(count(&mut db, "receipts").await, 0);

        // The conflict can also be introduced by an earlier row of the very
        // same batch. SQLite must roll back that earlier inserted row.
        let first = row(10, Some("SHARED-BATCH-CODE"));
        let mut second = row(20, Some("shared-batch-code"));
        second.unit = Some("bottle".into());
        assert!(
            import_batch(&mut db, "actor-a", batch(FIRST, vec![first, second]))
                .await
                .unwrap_err()
                .contains("Barcode")
        );
        assert_eq!(count(&mut db, "inventory").await, 1);
        assert_eq!(count(&mut db, "receipts").await, 0);
        assert_eq!(count(&mut db, "audit").await, 0);

        sqlx::query(
            "INSERT INTO inventory_lot_create_requests
             (request_id,inventory_id,drug_id,pharmacy_id,created_by,payload_hash)
             VALUES('old-ack','old-lot',20,'A','actor-a','digest')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        assert!(
            import_batch(&mut db, "actor-a", batch(FIRST, vec![row(10, None)]))
                .await
                .unwrap_err()
                .contains("unacknowledged")
        );
        assert!(
            import_batch(&mut db, "actor-c", batch(SECOND, vec![row(10, None)]))
                .await
                .unwrap_err()
                .contains("unacknowledged"),
            "a new same-pharmacy actor cannot bypass pending create recovery through bulk import"
        );
        assert_eq!(count(&mut db, "inventory").await, 1);
    }

    #[test]
    fn ipc_type_disallows_shared_master_mutation_lot_ids_sql_and_invalid_numbers() {
        let valid = serde_json::json!({
            "requestId": FIRST,
            "rows": [{
                "drugId": 10, "quantity": 1.5, "localSellingPrice": 20.5,
                "expiryDate": "2032-02-29", "barcode": "ABC",
                "unit": "box", "largeToMedium": 12, "mediumToSmall": 10
            }]
        });
        assert!(serde_json::from_value::<InventoryImportInput>(valid.clone()).is_ok());
        for field in [
            "masterDrugRows",
            "sql",
            "pharmacyId",
            "actorId",
            "costPrice",
        ] {
            let mut hostile = valid.clone();
            hostile[field] = serde_json::json!([]);
            assert!(
                serde_json::from_value::<InventoryImportInput>(hostile).is_err(),
                "{field}"
            );
        }
        for field in [
            "id",
            "costPrice",
            "batchNumber",
            "officialPrice",
            "tradeName",
            "sql",
        ] {
            let mut hostile = valid.clone();
            hostile["rows"][0][field] = serde_json::json!("overwrite");
            assert!(
                serde_json::from_value::<InventoryImportInput>(hostile).is_err(),
                "{field}"
            );
        }
        for number in [
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            -1.0,
            0.0,
            1.0e12,
        ] {
            let mut invalid = row(10, None);
            invalid.quantity = number;
            assert!(validate_import(&batch(FIRST, vec![invalid])).is_err());
        }
        for amount in [f64::NAN, f64::INFINITY, -0.01, 4.005, 1.0e12] {
            let mut invalid = row(10, None);
            invalid.local_selling_price = amount;
            assert!(validate_import(&batch(FIRST, vec![invalid])).is_err());
        }
        assert!(validate_import(&batch(FIRST, vec![])).is_err());
        assert!(validate_import(&batch(FIRST, vec![row(10, None); 201])).is_err());
        let oversized_ipc = serde_json::to_value(batch(FIRST, vec![row(10, None); 201])).unwrap();
        assert!(serde_json::from_value::<InventoryImportInput>(oversized_ipc).is_err());
        assert!(validate_import(&batch("not-a-uuid", vec![row(10, None)])).is_err());
        let mut invalid = row(10, None);
        invalid.expiry_date = Some("2031-02-29".into());
        assert!(validate_import(&batch(FIRST, vec![invalid])).is_err());
    }
}
