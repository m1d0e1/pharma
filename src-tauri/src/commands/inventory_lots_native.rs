//! Fixed native inventory-lot lifecycle. No untrusted SQL, actor, pharmacy,
//! unit-conversion mutation, catalog price update or global barcode write.
//! All financial writes and durable create-request witnesses are atomic.
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;
use super::stock_ledger_provenance::record_adjustment_provenance;

const MAX_QTY: f64 = 1_000_000_000.0;
const MAX_PRICE: f64 = 1_000_000_000.0;
const MAX_VALUE: f64 = 1_000_000_000_000.0;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateInventoryLotInput {
    drug_id: i64,
    quantity: f64,
    local_selling_price: f64,
    expiry_date: Option<String>,
    barcode: Option<String>,
    // Only verified catalog-state assertions, never permissions to mutate it.
    unit: Option<String>,
    // When the UI inferred its display label from a blank catalog field,
    // fail if that field was concurrently populated before this transaction.
    #[serde(default)]
    expect_null_large_unit: bool,
    large_to_medium: Option<i64>,
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteInventoryLotInput {
    id: String,
}

// An absent field preserves the current lot value; an explicit JSON null
// clears it. A plain Option<String> loses this distinction with serde.
fn nullable_update_field<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateInventoryLotInput {
    id: String,
    quantity: f64,
    local_selling_price: f64,
    // Both values must come from the edit form's originally loaded row.
    // Repeated/late submits must never silently overwrite newer stock.
    expected_quantity: f64,
    expected_local_selling_price: f64,
    reason_id: Option<i64>,
    #[serde(default, deserialize_with = "nullable_update_field")]
    expiry_date: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable_update_field")]
    barcode: Option<Option<String>>,
    // Assertions against existing catalog/lot units; never catalog writes.
    unit: Option<String>,
    large_to_medium: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdjustInventoryLotInput {
    id: String,
    expected_quantity: f64,
    quantity: f64,
    reason_id: i64,
}

#[derive(Debug, Serialize)]
pub struct InventoryLotCreated {
    success: bool,
    id: String,
    #[serde(rename = "drugId")]
    drug_id: i64,
}

#[derive(Debug, Serialize)]
pub struct InventoryLotDeleted {
    success: bool,
    id: String,
    disposition: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryLotUpdated {
    success: bool,
    id: String,
    drug_id: i64,
    quantity: f64,
}

fn bounded_money(value: f64) -> bool {
    value.is_finite()
        && (0.0..=MAX_PRICE).contains(&value)
        && (value * 100.0 - (value * 100.0).round()).abs() <= 0.00001
}

fn bounded_quantity(value: f64, positive: bool) -> bool {
    value.is_finite()
        && (0.0..=MAX_QTY).contains(&value)
        && (!positive || value > 0.0)
        // A strip of a 12-strip box is 1/12 of a large unit and has no
        // finite four-decimal representation. Preserve native f64 quantity
        // just as legacy inventory and checkout do; never round away stock.
        && (value == 0.0 || value >= 0.000_000_000_1)
}

fn nonzero_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id == id.trim()
        && !id
            .chars()
            .any(|c| c.is_control() || matches!(c, '\'' | '"' | ';') || c as u32 == 96)
}

fn valid_date(date: &str) -> bool {
    if date.len() != 10
        || date.as_bytes()[4] != b'-'
        || date.as_bytes()[7] != b'-'
        || !date
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let year = date[0..4].parse::<u32>().unwrap_or(0);
    let month = date[5..7].parse::<u32>().unwrap_or(0);
    let day = date[8..10].parse::<u32>().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    year > 0 && day >= 1 && day <= max_day
}

fn valid_barcode(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value == value.trim()
        && !value.chars().any(|c| c.is_control())
}

fn validate_create(data: &CreateInventoryLotInput) -> Result<(), String> {
    let nonce = Uuid::parse_str(&data.request_id)
        .map_err(|_| "Inventory lot requestId must be a canonical UUIDv4")?;
    if nonce.get_version_num() != 4
        || nonce.to_string() != data.request_id
        || data.drug_id <= 0
        || !bounded_quantity(data.quantity, true)
        || !bounded_money(data.local_selling_price)
        || data
            .expiry_date
            .as_deref()
            .is_some_and(|date| !valid_date(date))
        || data.barcode.as_deref().is_some_and(|b| !valid_barcode(b))
        || data
            .unit
            .as_deref()
            .is_some_and(|u| u.len() > 128 || u.chars().any(char::is_control))
        || data
            .large_to_medium
            .is_some_and(|v| !(1..=10_000).contains(&v))
    {
        return Err("Invalid inventory lot creation intent".into());
    }
    Ok(())
}

fn validate_update(data: &UpdateInventoryLotInput) -> Result<(), String> {
    if !nonzero_id(&data.id)
        || !bounded_quantity(data.quantity, false)
        || !bounded_quantity(data.expected_quantity, false)
        || !bounded_money(data.local_selling_price)
        || !bounded_money(data.expected_local_selling_price)
        || data.reason_id.is_some_and(|id| id <= 0)
        || data
            .expiry_date
            .as_ref()
            .and_then(|v| v.as_deref())
            .is_some_and(|v| !valid_date(v))
        || data
            .barcode
            .as_ref()
            .and_then(|v| v.as_deref())
            .is_some_and(|v| !valid_barcode(v))
        || data
            .unit
            .as_deref()
            .is_some_and(|u| u.len() > 128 || u.chars().any(char::is_control))
        || data
            .large_to_medium
            .is_some_and(|v| !(1..=10_000).contains(&v))
    {
        return Err("Invalid inventory lot update intent".into());
    }
    Ok(())
}

/// The request witness must bind the entire originally submitted intent, not
/// just a nonce and drug ID. Length-delimited fields avoid concatenation
/// ambiguity and keep a changed tenant/actor from claiming another receipt.
fn create_request_hash(
    data: &CreateInventoryLotInput,
    actor: &str,
    pharmacy: &str,
) -> Result<String, String> {
    let typed = serde_json::to_vec(data).map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    digest.update(b"pharma-inventory-lot-v1");
    for part in [actor.as_bytes(), pharmacy.as_bytes(), typed.as_slice()] {
        digest.update((part.len() as u64).to_le_bytes());
        digest.update(part);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(crate) async fn authorized_inventory_actor(
    conn: &mut SqliteConnection,
    actor: &str,
) -> Result<String, String> {
    let (role, pharmacy) = active_generic_actor(conn, actor).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=?
         AND COALESCE(is_active,1)=1",
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

async fn has_column(
    conn: &mut SqliteConnection,
    table: &str,
    column: &str,
) -> Result<bool, String> {
    // Only constants from this module are accepted. No renderer table name.
    let query = match table {
        "inventory" => "PRAGMA main.table_info('inventory')",
        "purchase_return_items" => "PRAGMA main.table_info('purchase_return_items')",
        _ => return Err("Unsupported inventory metadata table".into()),
    };
    let rows = sqlx::query(query)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().any(|row| {
        row.try_get::<String, _>("name")
            .is_ok_and(|name| name == column)
    }))
}

fn currency_value(quantity: f64, cost: f64) -> Result<f64, String> {
    if !bounded_quantity(quantity, false) || !bounded_money(cost) {
        return Err("Invalid lot quantity or trustworthy purchase cost".into());
    }
    let amount = quantity * cost;
    if !amount.is_finite()
        || !(0.0..=MAX_VALUE).contains(&amount)
        || (amount * 100.0 - (amount * 100.0).round()).abs() > 0.00001
    {
        return Err("Lot valuation needs an exactly representable 2-decimal amount".into());
    }
    Ok((amount * 100.0).round() / 100.0)
}

async fn barcode_uncontested(
    conn: &mut SqliteConnection,
    drug_id: i64,
    barcode: Option<&str>,
) -> Result<(), String> {
    let Some(code) = barcode else {
        return Ok(());
    };
    // Master catalog is GLOBAL; a lot's barcode can be shared only with the
    // same drug. Every pharmacy's active stock is part of uniqueness.
    let clashes: i64 = sqlx::query_scalar(
        "SELECT
           (SELECT COUNT(*) FROM main.master_drugs WHERE id<>?
                AND barcode IS NOT NULL AND TRIM(barcode)=? COLLATE NOCASE)
         + (SELECT COUNT(*) FROM main.inventory WHERE (drug_id IS NULL OR drug_id<>?)
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
            "Barcode belongs to a different drug in the global catalog or active inventory".into(),
        );
    }
    Ok(())
}

async fn audit(
    conn: &mut SqliteConnection,
    actor: &str,
    pharmacy: &str,
    action: &str,
    details: &str,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
         VALUES(?,?,?,?)",
    )
    .bind(actor)
    .bind(action)
    .bind(details)
    .bind(pharmacy)
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

async fn finish<T>(tx: Transaction<'_, Sqlite>, outcome: Result<T, String>) -> Result<T, String> {
    match outcome {
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

async fn create_lot(
    conn: &mut SqliteConnection,
    actor: &str,
    data: CreateInventoryLotInput,
) -> Result<InventoryLotCreated, String> {
    validate_create(&data)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result=async {
        let conn=&mut *tx;
        let pharmacy=authorized_inventory_actor(conn,actor).await?;
        let request_hash=create_request_hash(&data,actor,&pharmacy)?;
        let used=sqlx::query(
            "SELECT inventory_id,drug_id,pharmacy_id,created_by,payload_hash
             FROM main.inventory_lot_create_requests WHERE request_id=?",
        ).bind(&data.request_id).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
        if let Some(existing)=used {
            let inventory_id:String=existing.try_get("inventory_id").map_err(|e|e.to_string())?;
            let previous_drug:i64=existing.try_get("drug_id").map_err(|e|e.to_string())?;
            let previous_pharmacy:String=existing.try_get("pharmacy_id").map_err(|e|e.to_string())?;
            let previous_actor:String=existing.try_get("created_by").map_err(|e|e.to_string())?;
            let previous_hash:String=existing.try_get("payload_hash").map_err(|e|e.to_string())?;
            if previous_drug!=data.drug_id || previous_pharmacy!=pharmacy
                || previous_actor!=actor || previous_hash!=request_hash {
                return Err("Inventory creation nonce was reused with different intent".into());
            }
            // Lost IPC acknowledgements are safe to retry: return the same
            // original lot ID, without adding quantity, audit or shortage
            // mutations. A physically removed/moved lot must not be revived.
            let owned:Option<i64>=sqlx::query_scalar(
                "SELECT 1 FROM main.inventory WHERE id=? AND pharmacy_id=? LIMIT 1",
            ).bind(&inventory_id).bind(&pharmacy)
            .fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
            if owned.is_none() {
                return Err("Inventory request was already posted but original lot is unavailable".into());
            }
            return Ok((InventoryLotCreated{
                success:true,id:inventory_id,drug_id:data.drug_id,
            },pharmacy,false));
        }
        // A new nonce must not create duplicate physical stock while an
        // earlier committed lot in this PHARMACY has not been acknowledged.
        // Actor-only gating would let a colleague accidentally duplicate the
        // same unconfirmed physical stock after a logout/session switch.
        // Keep this AFTER same-nonce replay so lost acknowledgements can be
        // recovered without creating a second lot.
        let pending: Option<String> = sqlx::query_scalar(
            "SELECT r.request_id FROM main.inventory_lot_create_requests r
             LEFT JOIN main.inventory_lot_create_acknowledgements a
               ON a.request_id=r.request_id
             WHERE r.pharmacy_id=?
               AND a.request_id IS NULL
             LIMIT 1",
        )
        .bind(&pharmacy)
        .fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
        if pending.is_some() {
            return Err("Previous inventory creation remains unacknowledged; recover or acknowledge its original receipt before creating another lot".into());
        }
        let drug=sqlx::query(
            "SELECT id,has_expiry,large_unit,large_to_medium,medium_to_small,
                    stop_dealing,is_service,is_medicine
             FROM main.master_drugs WHERE id=? LIMIT 1",
        )
        .bind(data.drug_id).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?
        .ok_or("Selected master drug no longer exists")?;
        let expiry:Option<i64>=drug.try_get("has_expiry").map_err(|e|e.to_string())?;
        let expiry_required=expiry.unwrap_or(1)!=0;
        if expiry_required && data.expiry_date.is_none() {
            return Err("Selected expiring drug requires a valid expiryDate".into());
        }
        let stop:Option<i64>=drug.try_get("stop_dealing").map_err(|e|e.to_string())?;
        let service:Option<i64>=drug.try_get("is_service").map_err(|e|e.to_string())?;
        if stop.unwrap_or(0)!=0 || service.unwrap_or(0)!=0 {
            return Err("Retired or service master record cannot receive inventory lots".into());
        }
        let catalog_unit:Option<String>=drug.try_get("large_unit").map_err(|e|e.to_string())?;
        let catalog_large:Option<i64>=drug.try_get("large_to_medium").map_err(|e|e.to_string())?;
        let catalog_small:Option<i64>=drug.try_get("medium_to_small").map_err(|e|e.to_string())?;
        let large=catalog_large.unwrap_or(1);
        let small=catalog_small.unwrap_or(1);
        let large=if large==0 {1} else {large};
        let small=if small==0 {1} else {small};
        if !(1..=10_000).contains(&large) || !(1..=10_000).contains(&small) {
            return Err("Invalid live master-drug unit-conversion profile".into());
        }
        if (data.expect_null_large_unit && catalog_unit.as_deref().is_some_and(|u| !u.trim().is_empty()))
            || data.large_to_medium.is_some_and(|asserted|asserted!=large)
            || data.unit.as_deref().is_some_and(|asserted|{
                let asserted=asserted.trim();
                !asserted.is_empty() && catalog_unit.as_deref().unwrap_or("").trim()!=asserted
            }) {
            return Err("Stale catalog unit assertion; use separately authorized drug conversion workflow".into());
        }
        barcode_uncontested(conn,data.drug_id,data.barcode.as_deref()).await?;
        let lot_id=Uuid::new_v4().to_string();
        let has_small=has_column(conn,"inventory","medium_to_small").await?;
        // A new lot created from a manual inventory form has no verified
        // purchase cost, so assign cost_price=0; do not invent stock valuation,
        // supplier, master official price or ledger posting.
        let inserted=if has_small {
            sqlx::query(
                "INSERT INTO main.inventory
                 (id,drug_id,pharmacy_id,quantity,local_selling_price,cost_price,
                    expiry_date,barcode,strips_per_box,medium_to_small)
                 VALUES(?,?,?,?,?,0,?,?,?,?)",
            )
            .bind(&lot_id).bind(data.drug_id).bind(&pharmacy).bind(data.quantity)
            .bind(data.local_selling_price).bind(data.expiry_date.as_deref())
            .bind(data.barcode.as_deref()).bind(large).bind(small)
            .execute(&mut *conn).await
        } else {
            sqlx::query(
                "INSERT INTO main.inventory
                 (id,drug_id,pharmacy_id,quantity,local_selling_price,cost_price,
                    expiry_date,barcode,strips_per_box)
                 VALUES(?,?,?,?,?,0,?,?,?)",
            )
            .bind(&lot_id).bind(data.drug_id).bind(&pharmacy).bind(data.quantity)
            .bind(data.local_selling_price).bind(data.expiry_date.as_deref())
            .bind(data.barcode.as_deref()).bind(large)
            .execute(&mut *conn).await
        }.map_err(|e|e.to_string())?;
        if inserted.rows_affected()!=1 {return Err("Inventory lot was not inserted".into());}
        sqlx::query(
            "INSERT INTO main.inventory_lot_create_requests
             (request_id,inventory_id,drug_id,pharmacy_id,created_by,payload_hash)
             VALUES(?,?,?,?,?,?)",
        ).bind(&data.request_id).bind(&lot_id).bind(data.drug_id)
        .bind(&pharmacy).bind(actor).bind(&request_hash)
        .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        audit(conn,actor,&pharmacy,"ADD_INVENTORY",
            &format!("native-inventory-create-request={}; lot_id={}; drug_id={}; quantity={:.4}; price={:.2}",
             data.request_id,lot_id,data.drug_id,data.quantity,data.local_selling_price)).await?;
        Ok((InventoryLotCreated{success:true,id:lot_id,drug_id:data.drug_id},pharmacy,true))
    }.await;
    let result = match result {
        Ok((created, pharmacy, newly_created)) => {
            if newly_created {
                super::inventory_history::resolve_opening_shortages(
                    &mut tx,
                    data.drug_id,
                    &pharmacy,
                )
                .await
                .map(|_| created)
            } else {
                Ok(created)
            }
        }
        Err(error) => Err(error),
    };
    finish(tx, result).await
}

async fn referenced_history(
    conn: &mut SqliteConnection,
    id: &str,
    pharmacy: &str,
) -> Result<bool, String> {
    // Each reference-bearing table is checked even for zero-quantity lots.
    // Sales, retail returns and purchase receipts must have a tenant-owned
    // parent; a dangling invoice or another pharmacy is not safe to ignore.
    let rows = sqlx::query(
        "SELECT
          (SELECT COUNT(*) FROM main.sales_items WHERE inventory_id=?) sales,
          (SELECT COUNT(*) FROM main.return_items WHERE inventory_id=?) returns,
          (SELECT COUNT(*) FROM main.purchase_invoice_items WHERE inventory_id=?) purchases,
          (SELECT COUNT(*) FROM main.purchase_return_items WHERE inventory_id=?) purchase_returns,
          (SELECT COUNT(*) FROM main.stock_adjustments WHERE inventory_id=?) adjustments",
    )
    .bind(id)
    .bind(id)
    .bind(id)
    .bind(id)
    .bind(id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let sales: i64 = rows.try_get("sales").map_err(|e| e.to_string())?;
    let returns: i64 = rows.try_get("returns").map_err(|e| e.to_string())?;
    let purchases: i64 = rows.try_get("purchases").map_err(|e| e.to_string())?;
    let purchase_returns: i64 = rows
        .try_get("purchase_returns")
        .map_err(|e| e.to_string())?;
    let adjustments: i64 = rows.try_get("adjustments").map_err(|e| e.to_string())?;
    if purchase_returns != 0 {
        // purchase_returns lacks an immutable pharmacy_id in historical DBs,
        // so attribution through purchase_return_items is not provable.
        return Err("Historical supplier return has ambiguous pharmacy provenance".into());
    }
    let wrong: i64 = sqlx::query_scalar(
        "SELECT
           (SELECT COUNT(*) FROM main.sales_items s
              LEFT JOIN main.sales_invoices h ON h.id=s.invoice_id
              WHERE s.inventory_id=? AND
                (h.id IS NULL OR h.pharmacy_id IS NULL OR TRIM(h.pharmacy_id)<>?))
         + (SELECT COUNT(*) FROM main.return_items r
              LEFT JOIN main.returns h ON h.id=r.return_id
              WHERE r.inventory_id=? AND
                (h.id IS NULL OR h.pharmacy_id IS NULL OR TRIM(h.pharmacy_id)<>?))
         + (SELECT COUNT(*) FROM main.purchase_invoice_items p
              LEFT JOIN main.purchase_invoices h ON h.id=p.invoice_id
              WHERE p.inventory_id=? AND
                (h.id IS NULL OR h.pharmacy_id IS NULL OR TRIM(h.pharmacy_id)<>?))
         + (SELECT COUNT(*) FROM main.stock_adjustments a
              LEFT JOIN main.users u ON CAST(u.id AS TEXT)=CAST(a.user_id AS TEXT)
              WHERE a.inventory_id=? AND
                (u.id IS NULL OR u.pharmacy_id IS NULL OR TRIM(u.pharmacy_id)<>?))",
    )
    .bind(id)
    .bind(pharmacy)
    .bind(id)
    .bind(pharmacy)
    .bind(id)
    .bind(pharmacy)
    .bind(id)
    .bind(pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if wrong != 0 {
        return Err("Inventory lot history has foreign or unowned source records".into());
    }
    // The journal has no inventory_id foreign key. For native-created
    // voucher reference text, block physical deletion even if historic
    // adjustments were externally altered.
    let marker = format!("[lot_id={id}]");
    let journal: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM main.daily_journals WHERE instr(COALESCE(description,''),?)>0 LIMIT 1",
    )
    .bind(marker)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    Ok(sales + returns + purchases + adjustments > 0 || journal.is_some())
}

async fn posting_account(
    conn: &mut SqliteConnection,
    category: &str,
    canonical: &str,
    expense: bool,
) -> Result<i64, String> {
    let configured: Option<Option<i64>> = sqlx::query_scalar(
        "SELECT account_id FROM main.trial_balance_settings
         WHERE category=? LIMIT 1",
    )
    .bind(category)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let mapped: Option<i64> = sqlx::query_scalar(
        "SELECT a.id FROM main.trial_balance_settings s
         JOIN main.accounts a ON a.id=s.account_id
         WHERE s.category=? AND COALESCE(a.is_group,0)=0
           AND NOT EXISTS(SELECT 1 FROM main.accounts child WHERE child.parent_id=a.id)
           AND ((?=1 AND LOWER(TRIM(a.type))='expense')
             OR (?=0 AND LOWER(TRIM(a.type))='asset'))
           AND (?=1 OR a.code=?)
         ORDER BY a.id LIMIT 1",
    )
    .bind(category)
    .bind(i64::from(expense))
    .bind(i64::from(expense))
    .bind(i64::from(expense))
    .bind(canonical)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(id) = mapped {
        return Ok(id);
    }
    if configured.is_some() {
        return Err(format!(
            "Configured {category} posting account is missing, wrong type or not a leaf"
        ));
    }
    // Pre-upgrade databases may not have the dedicated adjustment expense
    // mapping. Canonical 4.1 (COGS) is the historical fallback, not a
    // renderer-supplied account identifier.
    sqlx::query_scalar(
        "SELECT a.id FROM main.accounts a WHERE a.code=?
         AND COALESCE(a.is_group,0)=0
         AND NOT EXISTS(SELECT 1 FROM main.accounts child WHERE child.parent_id=a.id)
         AND ((?=1 AND LOWER(TRIM(a.type))='expense')
           OR (?=0 AND LOWER(TRIM(a.type))='asset')) LIMIT 1",
    )
    .bind(canonical)
    .bind(i64::from(expense))
    .bind(i64::from(expense))
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Required postable inventory account {canonical} missing"))
}

async fn inventory_gain_account(conn: &mut SqliteConnection) -> Result<i64, String> {
    let configured: Option<Option<i64>> = sqlx::query_scalar(
        "SELECT account_id FROM main.trial_balance_settings
         WHERE category='inventory_adjustment_revenue' LIMIT 1",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let account: Option<i64> = sqlx::query_scalar(
        "SELECT a.id FROM main.accounts a
         LEFT JOIN main.trial_balance_settings s
           ON s.account_id=a.id AND s.category='inventory_adjustment_revenue'
         WHERE COALESCE(a.is_group,0)=0
           AND NOT EXISTS(SELECT 1 FROM main.accounts c WHERE c.parent_id=a.id)
           AND LOWER(TRIM(a.type))='revenue'
           AND ((?=1 AND s.account_id IS NOT NULL)
                OR (?=0 AND a.code='3.2'))
         ORDER BY a.id LIMIT 1",
    )
    .bind(i64::from(configured.is_some()))
    .bind(i64::from(configured.is_some()))
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    account.ok_or_else(|| {
        if configured.is_some() {
            "Configured inventory adjustment revenue account is missing, wrong type or not a leaf"
                .into()
        } else {
            "Required revenue account 3.2 for positive inventory adjustment is missing".into()
        }
    })
}

async fn update_lot_in_tx(
    tx: &mut Transaction<'_, Sqlite>,
    actor: &str,
    data: UpdateInventoryLotInput,
    stock_only: bool,
) -> Result<(InventoryLotUpdated, String, bool), String> {
    validate_update(&data)?;
    {
        let conn = &mut **tx;
        let pharmacy = authorized_inventory_actor(conn, actor).await?;
        let row = sqlx::query(
            "SELECT i.drug_id,CAST(i.quantity AS REAL) quantity,
                    CAST(i.local_selling_price AS REAL) local_selling_price,
                    CAST(i.cost_price AS REAL) cost_price,
                    typeof(i.quantity) qty_type,
                    typeof(i.local_selling_price) price_type,
                    typeof(i.cost_price) cost_type,
                    typeof(i.strips_per_box) strips_type,
                    i.strips_per_box,i.expiry_date,i.barcode,
                    m.has_expiry,m.large_unit,m.large_to_medium,
                    m.stop_dealing,m.is_service
             FROM main.inventory i
             JOIN main.master_drugs m ON m.id=i.drug_id
             WHERE i.id=? AND i.pharmacy_id IS NOT NULL
               AND TRIM(i.pharmacy_id)=? LIMIT 1",
        )
        .bind(&data.id)
        .bind(&pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Inventory lot missing, deleted or owned by another pharmacy")?;
        for field in ["qty_type", "price_type", "cost_type"] {
            let kind: String = row.try_get(field).map_err(|e| e.to_string())?;
            if !matches!(kind.as_str(), "real" | "integer") {
                return Err("Untrustworthy inventory quantity, price or cost".into());
            }
        }
        let drug_id: i64 = row.try_get("drug_id").map_err(|e| e.to_string())?;
        let previous_qty: f64 = row.try_get("quantity").map_err(|e| e.to_string())?;
        let previous_price: f64 = row
            .try_get("local_selling_price")
            .map_err(|e| e.to_string())?;
        let cost: f64 = row.try_get("cost_price").map_err(|e| e.to_string())?;
        if drug_id <= 0
            || !bounded_quantity(previous_qty, false)
            || !bounded_money(previous_price)
            || !bounded_money(cost)
        {
            return Err("Corrupt inventory lot stock or valuation".into());
        }
        if previous_qty != data.expected_quantity
            || previous_price != data.expected_local_selling_price
        {
            return Err("Inventory lot changed since the edit form was opened".into());
        }
        let lot_units: Option<i64> = match row
            .try_get::<String, _>("strips_type")
            .map_err(|e| e.to_string())?
            .as_str()
        {
            "null" => None,
            "integer" => Some(row.try_get("strips_per_box").map_err(|e| e.to_string())?),
            _ => return Err("Malformed stored lot unit conversion".into()),
        };
        let catalog_units: Option<i64> =
            row.try_get("large_to_medium").map_err(|e| e.to_string())?;
        let catalog_units = match catalog_units.unwrap_or(1) {
            0 => 1,
            v @ 1..=10_000 => v,
            _ => return Err("Invalid live catalog unit conversion".into()),
        };
        let effective_lot_units = lot_units.unwrap_or(catalog_units);
        if !(1..=10_000).contains(&effective_lot_units) {
            return Err("Invalid stored lot unit conversion".into());
        }
        let catalog_unit: Option<String> = row.try_get("large_unit").map_err(|e| e.to_string())?;
        if data
            .large_to_medium
            .is_some_and(|asserted| asserted != effective_lot_units)
            || data.unit.as_deref().is_some_and(|asserted| {
                let asserted = asserted.trim();
                !asserted.is_empty()
                    && !asserted.eq_ignore_ascii_case(catalog_unit.as_deref().unwrap_or("").trim())
            })
        {
            return Err(
                "Unit conversion is immutable in inventory editing; use catalog workflow".into(),
            );
        }
        let expiry_before: Option<String> =
            row.try_get("expiry_date").map_err(|e| e.to_string())?;
        let barcode_before: Option<String> = row.try_get("barcode").map_err(|e| e.to_string())?;
        let expiry_after = data
            .expiry_date
            .clone()
            .unwrap_or_else(|| expiry_before.clone());
        let barcode_after = data
            .barcode
            .clone()
            .unwrap_or_else(|| barcode_before.clone());
        let has_expiry: Option<i64> = row.try_get("has_expiry").map_err(|e| e.to_string())?;
        if data.expiry_date.is_some() && has_expiry.unwrap_or(1) != 0 && expiry_after.is_none() {
            return Err("Expiring drug must keep an expiry date".into());
        }
        // Historically used lots retain identifying batch metadata. A later
        // correction may adjust stock/price but not re-identify sales/returns.
        let has_history = referenced_history(conn, &data.id, &pharmacy).await?;
        if has_history && (expiry_after != expiry_before || barcode_after != barcode_before) {
            return Err("Referenced inventory lot expiry or barcode cannot be rewritten".into());
        }
        barcode_uncontested(conn, drug_id, barcode_after.as_deref()).await?;
        let stock_changed = data.quantity != previous_qty;
        if stock_changed {
            let reason = data.reason_id.ok_or("Stock adjustment requires a reason")?;
            let found: Option<i64> =
                sqlx::query_scalar("SELECT id FROM main.adjustment_reasons WHERE id=? LIMIT 1")
                    .bind(reason)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(|e| e.to_string())?;
            if found.is_none() {
                return Err("Stock adjustment reason no longer exists".into());
            }
        }
        let valuation = if stock_changed {
            currency_value((data.quantity - previous_qty).abs(), cost)?
        } else {
            0.0
        };
        let posting = if valuation > 0.0 {
            let inventory = posting_account(conn, "inventory_asset", "1.1.3", false).await?;
            let counterpart = if data.quantity > previous_qty {
                inventory_gain_account(conn).await?
            } else {
                posting_account(conn, "inventory_adjustment_expense", "4.1", true).await?
            };
            if inventory == counterpart {
                return Err("Inventory posting must use distinct balanced accounts".into());
            }
            Some((inventory, counterpart))
        } else {
            None
        };
        let changed = sqlx::query(
            "UPDATE main.inventory SET quantity=?,local_selling_price=?,
                    expiry_date=?,barcode=?,updated_at=CURRENT_TIMESTAMP
             WHERE id=? AND pharmacy_id=?
               AND quantity=? AND local_selling_price=?",
        )
        .bind(data.quantity)
        .bind(data.local_selling_price)
        .bind(expiry_after.as_deref())
        .bind(barcode_after.as_deref())
        .bind(&data.id)
        .bind(&pharmacy)
        .bind(previous_qty)
        .bind(previous_price)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if changed.rows_affected() != 1 {
            return Err("Inventory was concurrently modified".into());
        }
        if stock_changed {
            let adjustment_posted = sqlx::query(
                "INSERT INTO main.stock_adjustments
                 (inventory_id,reason_id,old_quantity,new_quantity,user_id)
                 VALUES(?,?,?,?,?)",
            )
            .bind(&data.id)
            .bind(data.reason_id)
            .bind(previous_qty)
            .bind(data.quantity)
            .bind(actor)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
            let adjustment_id = adjustment_posted.last_insert_rowid();
            let mut posted_journal_id = None;
            if let Some((inventory, counterpart)) = posting {
                let journal_id = format!("native-lot-adjust-{}", Uuid::new_v4());
                let label = if data.quantity > previous_qty {
                    "زيادة"
                } else {
                    "نقص"
                };
                let description = format!(
                    "تسوية مخزون {label} [lot_id={}] reason={:?} old_qty={previous_qty:.9} new_qty={:.9} cost={cost:.2}",
                    data.id, data.reason_id, data.quantity
                );
                sqlx::query(
                    "INSERT INTO main.daily_journals
                     (id,date,description,created_by,total_amount,pharmacy_id)
                     VALUES(?,date('now','localtime'),?,?,?,?)",
                )
                .bind(&journal_id)
                .bind(description)
                .bind(actor)
                .bind(valuation)
                .bind(&pharmacy)
                .execute(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
                let sides = if data.quantity > previous_qty {
                    [(inventory, "debit"), (counterpart, "credit")]
                } else {
                    [(counterpart, "debit"), (inventory, "credit")]
                };
                for (account, side) in sides {
                    sqlx::query(
                        "INSERT INTO main.journal_entries(journal_id,account_id,type,amount)
                         VALUES(?,?,?,?)",
                    )
                    .bind(&journal_id)
                    .bind(account)
                    .bind(side)
                    .bind(valuation)
                    .execute(&mut *conn)
                    .await
                    .map_err(|e| e.to_string())?;
                }
                posted_journal_id = Some(journal_id);
            }
            record_adjustment_provenance(
                conn,
                adjustment_id,
                &data.id,
                &pharmacy,
                actor,
                previous_qty,
                data.quantity,
                cost,
                valuation,
                posted_journal_id.as_deref(),
            )
            .await?;
        }
        audit(
            conn, actor, &pharmacy,
            if stock_only { "STOCK_ADJUSTMENT" } else { "UPDATE_INVENTORY" },
            &format!(
                "Updated tenant lot {} drug={drug_id} old_qty={previous_qty:.9} new_qty={:.9} old_price={previous_price:.2} new_price={:.2} reason={:?} valuation={valuation:.2}; expiry_changed={} barcode_changed={}",
                data.id, data.quantity, data.local_selling_price, data.reason_id,
                expiry_after != expiry_before, barcode_after != barcode_before
            ),
        ).await?;
        Ok((
            InventoryLotUpdated {
                success: true,
                id: data.id,
                drug_id,
                quantity: data.quantity,
            },
            pharmacy,
            stock_changed && data.quantity > previous_qty
                || (expiry_after != expiry_before && expiry_after.is_some()),
        ))
    }
}

async fn finish_updated_lot(
    mut tx: Transaction<'_, Sqlite>,
    result: Result<(InventoryLotUpdated, String, bool), String>,
) -> Result<InventoryLotUpdated, String> {
    let result = match result {
        Ok((updated, pharmacy, resolve_shortages)) if resolve_shortages => {
            super::inventory_history::resolve_opening_shortages(&mut tx, updated.drug_id, &pharmacy)
                .await
                .map(|_| updated)
        }
        Ok((updated, _, _)) => Ok(updated),
        Err(error) => Err(error),
    };
    finish(tx, result).await
}

async fn update_lot(
    conn: &mut SqliteConnection,
    actor: &str,
    data: UpdateInventoryLotInput,
) -> Result<InventoryLotUpdated, String> {
    validate_update(&data)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result = update_lot_in_tx(&mut tx, actor, data, false).await;
    finish_updated_lot(tx, result).await
}

async fn adjust_lot(
    conn: &mut SqliteConnection,
    actor: &str,
    data: AdjustInventoryLotInput,
) -> Result<InventoryLotUpdated, String> {
    if !nonzero_id(&data.id)
        || !bounded_quantity(data.expected_quantity, false)
        || !bounded_quantity(data.quantity, false)
        || data.quantity == data.expected_quantity
        || data.reason_id <= 0
    {
        return Err("Invalid stock adjustment intent".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result = async {
        let pharmacy = authorized_inventory_actor(&mut *tx, actor).await?;
        let row = sqlx::query(
            "SELECT typeof(local_selling_price) price_type,
                    CAST(local_selling_price AS REAL) price
             FROM main.inventory WHERE id=? AND pharmacy_id=? LIMIT 1",
        )
        .bind(&data.id)
        .bind(&pharmacy)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Inventory lot missing or belongs to another pharmacy")?;
        let kind: String = row.try_get("price_type").map_err(|e| e.to_string())?;
        if !matches!(kind.as_str(), "real" | "integer") {
            return Err("Untrustworthy inventory selling price".into());
        }
        let price: f64 = row.try_get("price").map_err(|e| e.to_string())?;
        update_lot_in_tx(
            &mut tx,
            actor,
            UpdateInventoryLotInput {
                id: data.id,
                quantity: data.quantity,
                local_selling_price: price,
                expected_quantity: data.expected_quantity,
                expected_local_selling_price: price,
                reason_id: Some(data.reason_id),
                expiry_date: None,
                barcode: None,
                unit: None,
                large_to_medium: None,
            },
            true,
        )
        .await
    }
    .await;
    finish_updated_lot(tx, result).await
}

async fn delete_lot(
    conn: &mut SqliteConnection,
    actor: &str,
    data: DeleteInventoryLotInput,
) -> Result<InventoryLotDeleted, String> {
    if !nonzero_id(&data.id) {
        return Err("Invalid inventory lot ID".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result=async {
        let conn=&mut *tx;
        let pharmacy=authorized_inventory_actor(conn,actor).await?;
        let row=sqlx::query(
            "SELECT id,drug_id,
                    CAST(quantity AS REAL) quantity,CAST(cost_price AS REAL) cost_price,
                    typeof(quantity) qty_type,typeof(cost_price) cost_type
             FROM main.inventory
             WHERE id=? AND pharmacy_id IS NOT NULL AND TRIM(pharmacy_id)=? LIMIT 1",
        ).bind(&data.id).bind(&pharmacy)
        .fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?
        .ok_or("Inventory lot missing or owned by another pharmacy")?;
        for key in ["qty_type","cost_type"] {
            let kind:String=row.try_get(key).map_err(|e|e.to_string())?;
            if !matches!(kind.as_str(),"integer"|"real") {
                return Err("Untrusted null or malformed inventory valuation".into());
            }
        }
        let quantity:f64=row.try_get("quantity").map_err(|e|e.to_string())?;
        let cost:f64=row.try_get("cost_price").map_err(|e|e.to_string())?;
        if !bounded_quantity(quantity,false) || !bounded_money(cost) {
            return Err("Corrupt negative, fractional or nonfinite inventory quantity/cost".into());
        }
        let has_history=referenced_history(conn,&data.id,&pharmacy).await?;
        if quantity>0.0 {
            let valuation=currency_value(quantity,cost)?;
            let posted=if valuation>0.0 {
                let inventory=posting_account(conn,"inventory_asset","1.1.3",false).await?;
                let adjustment=posting_account(conn,"inventory_adjustment_expense","4.1",true).await?;
                if inventory==adjustment {return Err("Cannot post inventory and expense to same account".into());}
                Some((inventory,adjustment))
            } else {None};
            let updated=sqlx::query(
                "UPDATE main.inventory SET quantity=0,updated_at=CURRENT_TIMESTAMP
                 WHERE id=? AND pharmacy_id=? AND quantity=?",
            ).bind(&data.id).bind(&pharmacy).bind(quantity)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
            if updated.rows_affected()!=1 {return Err("Inventory quantity was concurrently changed".into());}
            let adjustment_posted = sqlx::query(
                "INSERT INTO main.stock_adjustments
                 (inventory_id,reason_id,old_quantity,new_quantity,user_id)
                 VALUES(?,NULL,?,0,?)",
            ).bind(&data.id).bind(quantity).bind(actor)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
            let adjustment_id = adjustment_posted.last_insert_rowid();
            let mut posted_journal_id = None;
            if let Some((inventory,adjustment))=posted {
                let journal_id=format!("native-lot-zero-{}",Uuid::new_v4());
                let description=format!("تصفير مخزون [lot_id={}] - qty {:.4} @ cost {:.2}",
                    data.id,quantity,cost);
                sqlx::query(
                    "INSERT INTO main.daily_journals
                     (id,date,description,created_by,total_amount,pharmacy_id)
                     VALUES(?,date('now','localtime'),?,?,?,?)",
                ).bind(&journal_id).bind(description).bind(actor).bind(valuation).bind(&pharmacy)
                .execute(&mut *conn).await.map_err(|e|e.to_string())?;
                for (account,side) in [(adjustment,"debit"),(inventory,"credit")] {
                    sqlx::query(
                        "INSERT INTO main.journal_entries(journal_id,account_id,type,amount)
                         VALUES(?,?,?,?)",
                    ).bind(&journal_id).bind(account).bind(side).bind(valuation)
                    .execute(&mut *conn).await.map_err(|e|e.to_string())?;
                }
                posted_journal_id = Some(journal_id);
            }
            record_adjustment_provenance(
                conn, adjustment_id, &data.id, &pharmacy, actor,
                quantity, 0.0, cost, valuation, posted_journal_id.as_deref()
            ).await?;
            audit(conn,actor,&pharmacy,"ZERO_INVENTORY",
                &format!("Zeroed tenant inventory lot {} old_qty={quantity:.4} cost={cost:.2} valuation={valuation:.2}; referenced={has_history}",data.id)).await?;
            Ok(InventoryLotDeleted{success:true,id:data.id,disposition:"zeroed"})
        } else {
            if has_history {
                return Err("Referenced zero-quantity lot must be retained".into());
            }
            let removed=sqlx::query(
                "DELETE FROM main.inventory WHERE id=? AND pharmacy_id=?
                 AND typeof(quantity) IN ('real','integer') AND quantity=0",
            ).bind(&data.id).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
            if removed.rows_affected()!=1 {return Err("Inventory lot was concurrently changed or deleted".into());}
            audit(conn,actor,&pharmacy,"DELETE_INVENTORY",
                &format!("Deleted unused zero-quantity inventory lot {}",data.id)).await?;
            Ok(InventoryLotDeleted{success:true,id:data.id,disposition:"deleted"})
        }
    }.await;
    finish(tx, result).await
}

#[tauri::command]
pub async fn create_inventory_lot_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: CreateInventoryLotInput,
) -> Result<InventoryLotCreated, String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    create_lot(
        &mut conn,
        session.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn delete_inventory_lot_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: DeleteInventoryLotInput,
) -> Result<InventoryLotDeleted, String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    delete_lot(
        &mut conn,
        session.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn update_inventory_lot_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: UpdateInventoryLotInput,
) -> Result<InventoryLotUpdated, String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    update_lot(
        &mut conn,
        session.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn adjust_inventory_lot_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: AdjustInventoryLotInput,
) -> Result<InventoryLotUpdated, String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    adjust_lot(
        &mut conn,
        session.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
        Connection, Executor,
    };
    use std::time::Duration;

    const NONCE: &str = "a1111111-1111-4111-8111-111111111111";
    const NONCE_B: &str = "b2222222-2222-4222-8222-222222222222";

    fn payload(nonce: &str, drug: i64, quantity: f64) -> CreateInventoryLotInput {
        CreateInventoryLotInput {
            drug_id: drug,
            quantity,
            local_selling_price: 40.0,
            expiry_date: Some("2030-07-15".into()),
            barcode: None,
            unit: Some("box".into()),
            expect_null_large_unit: false,
            large_to_medium: Some(12),
            request_id: nonce.into(),
        }
    }

    async fn setup(db: &mut SqliteConnection, with_medium: bool) {
        let schema = if with_medium {
            "CREATE TABLE inventory (
              id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
              quantity INTEGER DEFAULT 0,local_selling_price REAL,cost_price REAL DEFAULT 0,
              expiry_date TEXT,barcode TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT DEFAULT CURRENT_TIMESTAMP,strips_per_box INTEGER DEFAULT 1,
              medium_to_small INTEGER DEFAULT 1)"
        } else {
            "CREATE TABLE inventory (
              id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
              quantity INTEGER DEFAULT 0,local_selling_price REAL,cost_price REAL DEFAULT 0,
              expiry_date TEXT,barcode TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT DEFAULT CURRENT_TIMESTAMP,strips_per_box INTEGER DEFAULT 1)"
        };
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,
                               pharmacy_id TEXT,is_active INTEGER);
            INSERT INTO users VALUES
              ('actor-a','cashier','{"can_manage_inventory":true}','A',1),
              ('actor-b','cashier','{"can_manage_inventory":true}','B',1),
              ('denied','cashier','{"can_manage_inventory":false}','A',1),
              ('inactive','owner','{}','A',0),('owner-a','owner','{}','A',1);
            CREATE TABLE master_drugs(
                id INTEGER PRIMARY KEY,trade_name TEXT,barcode TEXT,has_expiry INTEGER,
                large_unit TEXT,large_to_medium INTEGER,medium_to_small INTEGER,
                stop_dealing INTEGER DEFAULT 0,is_service INTEGER DEFAULT 0,
                is_medicine INTEGER DEFAULT 1,official_price REAL DEFAULT 100,
                reorder_point INTEGER,min_limit INTEGER,medium_unit TEXT,small_unit TEXT
            );
            INSERT INTO master_drugs(id,trade_name,barcode,has_expiry,
                      large_unit,large_to_medium,medium_to_small)
            VALUES(10,'A medicine','OWN-10',1,'box',12,10),
                  (20,'B medicine','FOREIGN-MASTER',0,'bottle',1,1);
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,
                status TEXT,created_at TEXT);
            CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,
                drug_id INTEGER,unit TEXT,quantity_sold REAL,is_negative INTEGER DEFAULT 0,
                large_to_medium INTEGER,medium_to_small INTEGER);
            CREATE TABLE shortages(id INTEGER PRIMARY KEY,drug_id INTEGER,
                pharmacy_id TEXT,status TEXT);
            CREATE TABLE returns(id TEXT PRIMARY KEY,pharmacy_id TEXT);
            CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT,inventory_id TEXT);
            CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT);
            CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT);
            CREATE TABLE purchase_return_items(id INTEGER PRIMARY KEY,inventory_id TEXT);
            CREATE TABLE stock_adjustments(
                id INTEGER PRIMARY KEY AUTOINCREMENT,inventory_id TEXT,reason_id INTEGER,
                old_quantity REAL,new_quantity REAL,user_id TEXT
            );
            CREATE TABLE adjustment_reasons(
                id INTEGER PRIMARY KEY,reason TEXT
            );
            INSERT INTO adjustment_reasons VALUES
                (1,'Stock count correction'),(2,'Damaged stock');
            CREATE TABLE accounts(
                id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER,type TEXT,parent_id INTEGER
            );
            INSERT INTO accounts VALUES
               (10,'1.1.3',0,'asset',NULL),(11,'4.1',0,'expense',NULL),
               (12,'4.5',0,'expense',NULL),(13,'4.9',1,'expense',NULL),
               (14,'3.1',0,'revenue',NULL),(15,'3.2',0,'revenue',NULL);
            CREATE TABLE trial_balance_settings(category TEXT PRIMARY KEY,account_id INTEGER);
            INSERT INTO trial_balance_settings VALUES
               ('inventory_asset',10),('inventory_adjustment_expense',12);
            CREATE TABLE daily_journals(
                id TEXT PRIMARY KEY,date TEXT,description TEXT,
                created_by TEXT,total_amount REAL,pharmacy_id TEXT
            );
            CREATE TABLE journal_entries(
                id INTEGER PRIMARY KEY AUTOINCREMENT,journal_id TEXT,
                account_id INTEGER,type TEXT,amount REAL
            );
            CREATE TABLE activity_log(
                id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,
                action TEXT,details TEXT,pharmacy_id TEXT
            );
        "#).execute(&mut *db).await.unwrap();
        sqlx::query(schema).execute(&mut *db).await.unwrap();
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
        sqlx::raw_sql(include_str!(
            "../../migrations/040_stock_ledger_provenance.sql"
        ))
        .execute(&mut *db)
        .await
        .unwrap();
    }

    async fn memory() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        setup(&mut db, true).await;
        db
    }

    async fn inv(
        db: &mut SqliteConnection,
        id: &str,
        drug: i64,
        tenant: &str,
        qty: f64,
        cost: f64,
        barcode: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,local_selling_price,barcode,expiry_date)
             VALUES(?,?,?,?,?,30,?,'2030-01-01')"
        ).bind(id).bind(drug).bind(tenant).bind(qty).bind(cost).bind(barcode)
        .execute(&mut *db).await.unwrap();
    }

    fn update_payload(id: &str, current: f64, next: f64) -> UpdateInventoryLotInput {
        UpdateInventoryLotInput {
            id: id.into(),
            quantity: next,
            local_selling_price: 32.0,
            expected_quantity: current,
            expected_local_selling_price: 30.0,
            reason_id: Some(1),
            expiry_date: None,
            barcode: None,
            unit: None,
            large_to_medium: None,
        }
    }

    async fn acknowledge_create(db: &mut SqliteConnection, request_id: &str) {
        sqlx::query(
            "INSERT INTO inventory_lot_create_acknowledgements
             (request_id,pharmacy_id,acknowledged_by) VALUES(?,'A','actor-a')",
        )
        .bind(request_id)
        .execute(&mut *db)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn fresh_creation_nonce_is_blocked_until_prior_receipt_is_acknowledged() {
        let mut db = memory().await;
        sqlx::query(
            "INSERT INTO users(id,role,permissions,pharmacy_id,is_active)
             VALUES('actor-c','cashier','{\"can_manage_inventory\":true}','A',1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        let original = create_lot(&mut db, "actor-a", payload(NONCE, 10, 1.0))
            .await
            .unwrap();
        let retry = create_lot(&mut db, "actor-a", payload(NONCE, 10, 1.0))
            .await
            .unwrap();
        assert_eq!(
            retry.id, original.id,
            "same exact nonce recovers lost IPC reply"
        );
        assert!(
            create_lot(&mut db, "actor-a", payload(NONCE_B, 10, 2.0))
                .await
                .is_err(),
            "fresh nonce must not multiply unacknowledged stock"
        );
        assert!(create_lot(&mut db, "actor-c", payload(NONCE_B, 10, 2.0))
            .await.is_err(), "another authorized user in the SAME pharmacy also cannot silently duplicate unacknowledged stock");
        assert_eq!(counts(&mut db).await, (1, 1, 0, 0, 1));
        acknowledge_create(&mut db, NONCE).await;
        assert!(
            create_lot(&mut db, "actor-a", payload(NONCE_B, 10, 2.0))
                .await
                .is_ok(),
            "reconciled receipt permits next legitimate lot"
        );
        assert_eq!(counts(&mut db).await, (2, 2, 0, 0, 2));
        assert!(
            create_lot(&mut db, "actor-a", payload(NONCE, 10, 1.0))
                .await
                .is_ok(),
            "exact replay remains safe after subsequent creates"
        );
    }

    async fn counts(db: &mut SqliteConnection) -> (i64, i64, i64, i64, i64) {
        let a: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM inventory")
            .fetch_one(&mut *db)
            .await
            .unwrap();
        let b: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM inventory_lot_create_requests")
            .fetch_one(&mut *db)
            .await
            .unwrap();
        let c: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM stock_adjustments")
            .fetch_one(&mut *db)
            .await
            .unwrap();
        let d: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
            .fetch_one(&mut *db)
            .await
            .unwrap();
        let e: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM activity_log")
            .fetch_one(&mut *db)
            .await
            .unwrap();
        (a, b, c, d, e)
    }

    #[test]
    fn deny_unknown_fields_and_bad_number_noncanonical_replay_and_expiry_inputs() {
        assert!(
            serde_json::from_value::<CreateInventoryLotInput>(serde_json::json!({
                "drugId":10,"quantity":1.5,"localSellingPrice":40,
                "unit":"box","largeToMedium":12,"expiryDate":"2030-07-15","requestId":NONCE
            }))
            .is_ok()
        );
        for field in [
            "actorId",
            "userId",
            "pharmacyId",
            "pharmacy_id",
            "sql",
            "mediumToSmall",
            "costPrice",
            "accountId",
            "officialPrice",
            "hasExpiry",
        ] {
            let mut data = serde_json::json!({"drugId":10,"quantity":1.0,
                "localSellingPrice":4.00,"requestId":NONCE});
            data[field] = serde_json::json!("forged");
            assert!(
                serde_json::from_value::<CreateInventoryLotInput>(data).is_err(),
                "{field}"
            );
        }
        assert!(serde_json::from_value::<DeleteInventoryLotInput>(
            serde_json::json!({"id":"lot","pharmacyId":"B"})
        )
        .is_err());
        for qty in [f64::NAN, f64::INFINITY, -1.0, 0.0, 1e-12, 1e11] {
            assert!(validate_create(&payload(NONCE, 10, qty)).is_err(), "{qty}");
        }
        assert!(validate_create(&payload(NONCE, 10, 1.0 / 12.0)).is_ok());
        for invalid in [
            "2031-02-29",
            "2030-13-01",
            "2030-00-00",
            "2030-04-31",
            "2030-1-1",
        ] {
            let mut data = payload(NONCE, 10, 1.0);
            data.expiry_date = Some(invalid.into());
            assert!(validate_create(&data).is_err(), "{invalid}");
        }
        assert!(valid_date("2032-02-29"));
        assert!(!valid_date("2100-02-29"));
        for nonce in [
            "BAD",
            "a1111111-1111-1111-8111-111111111111",
            "A1111111-1111-4111-8111-111111111111",
        ] {
            assert!(
                validate_create(&payload(nonce, 10, 1.0)).is_err(),
                "{nonce}"
            );
        }
        for invalid in [f64::NAN, f64::INFINITY, -1.0, 1.234, 1e13] {
            let mut data = payload(NONCE, 10, 1.0);
            data.local_selling_price = invalid;
            assert!(validate_create(&data).is_err(), "{invalid}");
        }
        let mut free_stock = payload(NONCE, 10, 1.0);
        free_stock.local_selling_price = 0.0;
        assert!(
            validate_create(&free_stock).is_ok(),
            "zero-priced stock is permitted by the existing inventory UI"
        );
    }

    #[tokio::test]
    async fn zero_selling_price_preserves_existing_free_stock_business_parity() {
        let mut db = memory().await;
        let mut data = payload(NONCE, 10, 1.0);
        data.local_selling_price = 0.0;
        let created = create_lot(&mut db, "actor-a", data).await.unwrap();
        let price: f64 = sqlx::query_scalar(
            "SELECT CAST(local_selling_price AS REAL) FROM inventory WHERE id=?",
        )
        .bind(created.id)
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(price, 0.0);
    }

    #[tokio::test]
    async fn one_strip_of_twelve_is_recorded_without_rounding_or_stock_loss() {
        let mut db = memory().await;
        let fractional = 1.0_f64 / 12.0;
        let created = create_lot(&mut db, "actor-a", payload(NONCE, 10, fractional))
            .await
            .unwrap();
        let stored: f64 =
            sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id=?")
                .bind(&created.id)
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(stored, fractional);
        assert!((stored * 12.0 - 1.0).abs() < 1e-10);
        let retry = create_lot(&mut db, "actor-a", payload(NONCE, 10, fractional))
            .await
            .unwrap();
        assert_eq!(retry.id, created.id);
        assert_eq!(counts(&mut db).await, (1, 1, 0, 0, 1));
    }

    #[tokio::test]
    async fn inferred_display_unit_asserts_catalog_large_unit_stayed_blank() {
        let mut db = memory().await;
        sqlx::query("UPDATE master_drugs SET large_unit=NULL WHERE id=10")
            .execute(&mut db)
            .await
            .unwrap();
        let mut inferred = payload(NONCE, 10, 1.0);
        inferred.unit = None;
        inferred.expect_null_large_unit = true;
        assert!(create_lot(&mut db, "actor-a", inferred).await.is_ok());
        sqlx::query("UPDATE master_drugs SET large_unit='bottle' WHERE id=10")
            .execute(&mut db)
            .await
            .unwrap();
        let mut stale = payload(NONCE_B, 10, 1.0);
        stale.unit = None;
        stale.expect_null_large_unit = true;
        assert!(create_lot(&mut db, "actor-a", stale).await.is_err());
        assert_eq!(counts(&mut db).await, (1, 1, 0, 0, 1));
    }

    #[tokio::test]
    async fn create_fractional_lot_expiry_fefo_and_durable_nonce_after_physical_delete() {
        let mut db = memory().await;
        let first = create_lot(&mut db, "actor-a", payload(NONCE, 10, 1.5))
            .await
            .unwrap();
        assert!(first.success);
        assert_eq!(first.drug_id, 10);
        assert_eq!(counts(&mut db).await, (1, 1, 0, 0, 1));
        let row = sqlx::query(
            "SELECT drug_id,pharmacy_id,CAST(quantity AS REAL) qty,local_selling_price,
                  cost_price,expiry_date,strips_per_box,medium_to_small
             FROM inventory WHERE id=?",
        )
        .bind(&first.id)
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(row.get::<i64, _>("drug_id"), 10);
        assert_eq!(row.get::<String, _>("pharmacy_id"), "A");
        assert_eq!(row.get::<f64, _>("qty"), 1.5);
        assert_eq!(row.get::<f64, _>("local_selling_price"), 40.0);
        assert_eq!(row.get::<f64, _>("cost_price"), 0.0);
        assert_eq!(row.get::<String, _>("expiry_date"), "2030-07-15");
        assert_eq!(row.get::<i64, _>("strips_per_box"), 12);
        assert_eq!(row.get::<i64, _>("medium_to_small"), 10);
        let drug = sqlx::query(
            "SELECT official_price,barcode,large_to_medium,medium_to_small
             FROM master_drugs WHERE id=10",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(drug.get::<f64, _>("official_price"), 100.0);
        assert_eq!(drug.get::<String, _>("barcode"), "OWN-10");
        assert_eq!(drug.get::<i64, _>("large_to_medium"), 12);
        assert_eq!(drug.get::<i64, _>("medium_to_small"), 10);
        // Same intent and nonce must recover the original acknowledgement,
        // without adding another lot or audit (lost frontend IPC reply).
        let retried = create_lot(&mut db, "actor-a", payload(NONCE, 10, 1.5))
            .await
            .unwrap();
        assert_eq!(retried.id, first.id);
        assert_eq!(counts(&mut db).await, (1, 1, 0, 0, 1));
        let mut changed = payload(NONCE, 10, 2.0);
        assert!(create_lot(&mut db, "actor-a", changed).await.is_err());
        changed = payload(NONCE, 20, 1.5);
        assert!(create_lot(&mut db, "actor-a", changed).await.is_err());
        acknowledge_create(&mut db, NONCE).await;
        let mut older = payload(NONCE_B, 10, 2.0);
        older.expiry_date = Some("2029-01-01".into());
        let older = create_lot(&mut db, "actor-a", older).await.unwrap();
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM inventory WHERE pharmacy_id='A' AND drug_id=10 ORDER BY expiry_date,id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(ids, [older.id, first.id.clone()]);
        // Force a zero lot with no historic sales/purchases/adjustments; the
        // nonce receipt is NOT foreign-keyed to this physically deleted lot.
        sqlx::query("UPDATE inventory SET quantity=0 WHERE id=?")
            .bind(&first.id)
            .execute(&mut db)
            .await
            .unwrap();
        let deleted = delete_lot(&mut db, "actor-a", DeleteInventoryLotInput { id: first.id })
            .await
            .unwrap();
        assert_eq!(deleted.disposition, "deleted");
        assert_eq!(counts(&mut db).await, (1, 2, 0, 0, 3));
        assert!(create_lot(&mut db, "actor-a", payload(NONCE, 10, 1.0))
            .await
            .is_err());
        assert_eq!(counts(&mut db).await, (1, 2, 0, 0, 3));
    }

    #[tokio::test]
    async fn master_catalog_conversion_assertions_never_mutate_shared_catalog() {
        let mut db = memory().await;
        let mut mismatch = payload(NONCE, 10, 1.0);
        mismatch.large_to_medium = Some(2);
        assert!(create_lot(&mut db, "actor-a", mismatch).await.is_err());
        let mut mismatch = payload(NONCE, 10, 1.0);
        mismatch.unit = Some("strip".into());
        assert!(create_lot(&mut db, "actor-a", mismatch).await.is_err());
        let mut missing_expiry = payload(NONCE, 10, 1.0);
        missing_expiry.expiry_date = None;
        assert!(create_lot(&mut db, "actor-a", missing_expiry)
            .await
            .is_err());
        let mut non_expiring = payload(NONCE, 20, 1.0);
        non_expiring.unit = Some("bottle".into());
        non_expiring.large_to_medium = Some(1);
        non_expiring.expiry_date = None;
        assert!(create_lot(&mut db, "actor-a", non_expiring).await.is_ok());
        assert_eq!(counts(&mut db).await, (1, 1, 0, 0, 1));
        // Disabled catalog item never receives new stock.
        db.execute("UPDATE master_drugs SET stop_dealing=1 WHERE id=10")
            .await
            .unwrap();
        assert!(create_lot(&mut db, "actor-a", payload(NONCE_B, 10, 1.0))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn recovered_shortages_are_tenant_scoped_and_atomic_with_lot_nonce_audit() {
        let mut db = memory().await;
        sqlx::raw_sql(
            "INSERT INTO shortages(id,drug_id,pharmacy_id,status) VALUES
             (1,10,'A','pending'),(2,10,'B','ordered'),(3,20,'A','pending');",
        )
        .execute(&mut db)
        .await
        .unwrap();
        let mut expired = payload(NONCE, 10, 13.0);
        expired.expiry_date = Some("2020-01-01".into());
        create_lot(&mut db, "actor-a", expired).await.unwrap();
        let before: String = sqlx::query_scalar("SELECT status FROM shortages WHERE id=1")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(before, "pending");
        acknowledge_create(&mut db, NONCE).await;
        let live = create_lot(&mut db, "actor-a", payload(NONCE_B, 10, 13.0))
            .await
            .unwrap();
        assert!(!live.id.is_empty());
        let status: Vec<String> = sqlx::query_scalar("SELECT status FROM shortages ORDER BY id")
            .fetch_all(&mut db)
            .await
            .unwrap();
        assert_eq!(status, ["received", "ordered", "pending"]);
        assert_eq!(counts(&mut db).await, (2, 2, 0, 0, 2));
    }

    #[tokio::test]
    async fn shortage_update_failure_rolls_back_inventory_witness_and_activity() {
        let mut db = memory().await;
        sqlx::raw_sql(
            "INSERT INTO shortages(id,drug_id,pharmacy_id,status)
             VALUES(1,10,'A','pending');
             CREATE TRIGGER fail_shortage
               BEFORE UPDATE ON shortages BEGIN SELECT RAISE(ABORT,'fail shortage'); END;",
        )
        .execute(&mut db)
        .await
        .unwrap();
        assert!(create_lot(&mut db, "actor-a", payload(NONCE, 10, 13.0))
            .await
            .is_err());
        assert_eq!(counts(&mut db).await, (0, 0, 0, 0, 0));
        let status: String = sqlx::query_scalar("SELECT status FROM shortages WHERE id=1")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(status, "pending");
    }

    #[tokio::test]
    async fn barcodes_global_across_master_and_live_foreign_inventory_but_same_drug_legal() {
        let mut db = memory().await;
        let mut foreign = payload(NONCE, 10, 1.0);
        foreign.barcode = Some("FOREIGN-MASTER".into());
        assert!(create_lot(&mut db, "actor-a", foreign).await.is_err());
        inv(
            &mut db,
            "foreign-stock",
            20,
            "B",
            8.0,
            2.0,
            Some("FOREIGN-LOT"),
        )
        .await;
        let mut foreign = payload(NONCE, 10, 1.0);
        foreign.barcode = Some("foreign-lot".into());
        assert!(create_lot(&mut db, "actor-a", foreign).await.is_err());
        // Unattributed historic live stock is not evidence that the barcode
        // belongs to the selected drug, even when drug_id is NULL.
        sqlx::query(
            "INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,barcode)
                     VALUES('unattributed-barcode',NULL,'B',2,0,'ORPHAN-UPC')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        let mut orphan = payload(NONCE, 10, 1.0);
        orphan.barcode = Some("orphan-upc".into());
        assert!(create_lot(&mut db, "actor-a", orphan).await.is_err());
        sqlx::query("DELETE FROM inventory WHERE id='unattributed-barcode'")
            .execute(&mut db)
            .await
            .unwrap();
        inv(&mut db, "retired-stock", 20, "B", 0.0, 0.0, Some("OLD-UPC")).await;
        let mut allowed = payload(NONCE, 10, 1.0);
        allowed.barcode = Some("OLD-UPC".into());
        assert!(create_lot(&mut db, "actor-a", allowed).await.is_ok());
        let mut same = payload(NONCE_B, 10, 1.0);
        same.barcode = Some("OWN-10".into());
        assert!(create_lot(&mut db, "actor-b", same).await.is_ok());
        assert_eq!(counts(&mut db).await, (4, 2, 0, 0, 2));
    }

    #[tokio::test]
    async fn live_actor_role_disabling_reassignment_crosspharmacy_delete_denied() {
        let mut db = memory().await;
        for actor in ["denied", "inactive", "missing"] {
            assert!(create_lot(&mut db, actor, payload(NONCE, 10, 1.0))
                .await
                .is_err());
        }
        inv(&mut db, "b-lot", 10, "B", 2.0, 2.0, None).await;
        assert!(delete_lot(
            &mut db,
            "actor-a",
            DeleteInventoryLotInput { id: "b-lot".into() }
        )
        .await
        .is_err());
        assert!(delete_lot(
            &mut db,
            "inactive",
            DeleteInventoryLotInput { id: "b-lot".into() }
        )
        .await
        .is_err());
        db.execute("UPDATE users SET permissions='{}' WHERE id='actor-a'")
            .await
            .unwrap();
        assert!(create_lot(&mut db, "actor-a", payload(NONCE, 10, 1.0))
            .await
            .is_err());
        db.execute(
            "UPDATE users SET permissions='{\"can_manage_inventory\":true}',pharmacy_id='B'
                    WHERE id='actor-a'",
        )
        .await
        .unwrap();
        let created = create_lot(&mut db, "actor-a", payload(NONCE, 10, 1.0))
            .await
            .unwrap();
        let owned: String = sqlx::query_scalar("SELECT pharmacy_id FROM inventory WHERE id=?")
            .bind(&created.id)
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(owned, "B");
        db.execute("UPDATE users SET is_active=0 WHERE id='actor-a'")
            .await
            .unwrap();
        assert!(delete_lot(
            &mut db,
            "actor-a",
            DeleteInventoryLotInput { id: created.id }
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn deletion_positive_stock_posts_balanced_cost_basis_adjustment_and_preserves_lot() {
        let mut db = memory().await;
        inv(&mut db, "cost-lot", 10, "A", 1.5, 12.00, None).await;
        let result = delete_lot(
            &mut db,
            "actor-a",
            DeleteInventoryLotInput {
                id: "cost-lot".into(),
            },
        )
        .await
        .unwrap();
        assert!(result.success);
        assert_eq!(result.disposition, "zeroed");
        let qty: f64 =
            sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id='cost-lot'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(qty, 0.0);
        assert_eq!(counts(&mut db).await, (1, 0, 1, 1, 1));
        let adjust = sqlx::query("SELECT old_quantity,new_quantity,user_id FROM stock_adjustments")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(adjust.get::<f64, _>("old_quantity"), 1.5);
        assert_eq!(adjust.get::<f64, _>("new_quantity"), 0.0);
        assert_eq!(adjust.get::<String, _>("user_id"), "actor-a");
        let journal = sqlx::query(
            "SELECT description,total_amount,created_by,pharmacy_id FROM daily_journals",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(journal.get::<f64, _>("total_amount"), 18.00);
        assert_eq!(journal.get::<String, _>("created_by"), "actor-a");
        assert_eq!(journal.get::<String, _>("pharmacy_id"), "A");
        assert!(journal
            .get::<String, _>("description")
            .contains("[lot_id=cost-lot]"));
        let entries = sqlx::query("SELECT account_id,type,amount FROM journal_entries ORDER BY id")
            .fetch_all(&mut db)
            .await
            .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].get::<i64, _>("account_id"), 12);
        assert_eq!(entries[0].get::<String, _>("type"), "debit");
        assert_eq!(entries[1].get::<i64, _>("account_id"), 10);
        assert_eq!(entries[1].get::<String, _>("type"), "credit");
        assert_eq!(entries[0].get::<f64, _>("amount"), 18.00);
        assert_eq!(entries[1].get::<f64, _>("amount"), 18.00);
        assert!(delete_lot(
            &mut db,
            "actor-a",
            DeleteInventoryLotInput {
                id: "cost-lot".into()
            }
        )
        .await
        .is_err());
        assert_eq!(counts(&mut db).await, (1, 0, 1, 1, 1));
    }

    #[tokio::test]
    async fn zero_cost_creates_recorded_adjustment_without_fabricated_zero_journal() {
        let mut db = memory().await;
        inv(&mut db, "uncosted", 10, "A", 3.0, 0.0, None).await;
        let deleted = delete_lot(
            &mut db,
            "actor-a",
            DeleteInventoryLotInput {
                id: "uncosted".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(deleted.disposition, "zeroed");
        assert_eq!(counts(&mut db).await, (1, 0, 1, 0, 1));
        assert!(delete_lot(
            &mut db,
            "actor-a",
            DeleteInventoryLotInput {
                id: "uncosted".into()
            }
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn malformed_price_quantity_and_uncertain_fractional_cent_valuation_fail_closed() {
        assert_eq!(currency_value(1.5, 12.0).unwrap(), 18.0);
        assert!(currency_value(1.3333, 12.0).is_err());
        assert!(currency_value(1e9, 1e9).is_err());
        assert!(currency_value(1.0, -1.0).is_err());
        for sql in [
            "UPDATE inventory SET quantity=-3 WHERE id='lot'",
            "UPDATE inventory SET quantity='oops' WHERE id='lot'",
            "UPDATE inventory SET quantity=1e309 WHERE id='lot'",
            "UPDATE inventory SET cost_price=-2 WHERE id='lot'",
            "UPDATE inventory SET cost_price='no-cost' WHERE id='lot'",
            "UPDATE inventory SET cost_price=1e309 WHERE id='lot'",
            "UPDATE inventory SET cost_price=2.2222 WHERE id='lot'",
            "UPDATE inventory SET quantity=1.3333 WHERE id='lot'",
        ] {
            let mut db = memory().await;
            inv(&mut db, "lot", 10, "A", 2.0, 12.0, None).await;
            db.execute(sql).await.unwrap();
            assert!(
                delete_lot(
                    &mut db,
                    "actor-a",
                    DeleteInventoryLotInput { id: "lot".into() }
                )
                .await
                .is_err(),
                "{sql}"
            );
            assert_eq!(counts(&mut db).await, (1, 0, 0, 0, 0));
        }
    }

    #[tokio::test]
    async fn historic_sales_returns_purchases_adjustments_and_unknown_purchase_returns_block_delete(
    ) {
        for (table,setup_sql) in [
           ("sales_items","INSERT INTO sales_invoices(id,pharmacy_id) VALUES('inv','A'); INSERT INTO sales_items(invoice_id,inventory_id) VALUES('inv','history')"),
           ("return_items","INSERT INTO returns VALUES('return','A'); INSERT INTO return_items(return_id,inventory_id) VALUES('return','history')"),
           ("purchase_invoice_items","INSERT INTO purchase_invoices VALUES('pinv','A'); INSERT INTO purchase_invoice_items(invoice_id,inventory_id) VALUES('pinv','history')"),
           ("stock_adjustments","INSERT INTO stock_adjustments(inventory_id,old_quantity,new_quantity,user_id) VALUES('history',5,0,'actor-a')"),
           ("purchase_return_items","INSERT INTO purchase_return_items(inventory_id) VALUES('history')"),
        ] {
            let mut db=memory().await;
            inv(&mut db,"history",10,"A",0.0,12.0,None).await;
            sqlx::raw_sql(setup_sql).execute(&mut db).await.unwrap();
            assert!(delete_lot(&mut db,"actor-a",DeleteInventoryLotInput{id:"history".into()})
                .await.is_err(),"{table}");
            assert_eq!(counts(&mut db).await.0,1);
            if table!="purchase_return_items" {
                db.execute("UPDATE inventory SET quantity=2 WHERE id='history'")
                    .await.unwrap();
                assert!(delete_lot(&mut db,"actor-a",DeleteInventoryLotInput{id:"history".into()})
                    .await.is_ok(),"{table}: in-branch existing historical references may be safely zeroed");
            }
        }
    }

    #[tokio::test]
    async fn foreign_or_unowned_historical_reference_rejects_zeroing_without_side_effects() {
        for setup_sql in [
            "INSERT INTO sales_invoices(id,pharmacy_id) VALUES('inv','B'); INSERT INTO sales_items(invoice_id,inventory_id) VALUES('inv','lot')",
            "INSERT INTO sales_items(invoice_id,inventory_id) VALUES('missing','lot')",
            "INSERT INTO returns VALUES('ret','B'); INSERT INTO return_items(return_id,inventory_id) VALUES('ret','lot')",
            "INSERT INTO purchase_invoices VALUES('pinv','B'); INSERT INTO purchase_invoice_items(invoice_id,inventory_id) VALUES('pinv','lot')",
            "INSERT INTO stock_adjustments(inventory_id,old_quantity,new_quantity,user_id) VALUES('lot',1,2,'actor-b')",
            "INSERT INTO purchase_return_items(inventory_id) VALUES('lot')",
        ] {
            let mut db=memory().await;
            inv(&mut db,"lot",10,"A",3.0,12.0,None).await;
            sqlx::raw_sql(setup_sql).execute(&mut db).await.unwrap();
            let before=counts(&mut db).await;
            assert!(delete_lot(&mut db,"actor-a",DeleteInventoryLotInput{id:"lot".into()})
                .await.is_err(),"{setup_sql}");
            assert_eq!(counts(&mut db).await,before);
            let quantity:f64=sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id='lot'")
                .fetch_one(&mut db).await.unwrap();
            assert_eq!(quantity,3.0);
        }
    }

    #[tokio::test]
    async fn missing_or_forged_postable_account_mappings_fail_closed_without_default_numeric_fallback(
    ) {
        for sql in [
            "UPDATE trial_balance_settings SET account_id=13 WHERE category='inventory_adjustment_expense'",
            "UPDATE trial_balance_settings SET account_id=14 WHERE category='inventory_adjustment_expense'",
            "UPDATE trial_balance_settings SET account_id=999 WHERE category='inventory_adjustment_expense'",
            "UPDATE trial_balance_settings SET account_id=11 WHERE category='inventory_asset'",
            "UPDATE accounts SET type='liability' WHERE id=10",
            "UPDATE accounts SET is_group=1 WHERE id=10",
            "INSERT INTO accounts VALUES(99,'1.1.3.1',0,'asset',10)",
        ] {
            let mut db=memory().await;
            inv(&mut db,"lot",10,"A",1.0,12.0,None).await;
            db.execute(sql).await.unwrap();
            assert!(delete_lot(&mut db,"actor-a",DeleteInventoryLotInput{id:"lot".into()})
                .await.is_err(),"{sql}");
            assert_eq!(counts(&mut db).await,(1,0,0,0,0));
        }
        let mut db = memory().await;
        inv(&mut db, "lot", 10, "A", 1.0, 12.0, None).await;
        db.execute(
            "DELETE FROM trial_balance_settings WHERE category='inventory_adjustment_expense'",
        )
        .await
        .unwrap();
        let result = delete_lot(
            &mut db,
            "actor-a",
            DeleteInventoryLotInput { id: "lot".into() },
        )
        .await
        .unwrap();
        assert_eq!(result.disposition, "zeroed");
        let expense: i64 =
            sqlx::query_scalar("SELECT account_id FROM journal_entries WHERE type='debit'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(expense, 11);
    }

    #[tokio::test]
    async fn journal_and_audit_and_request_receipt_failure_triggers_rollback_everything() {
        for trigger in [
            "CREATE TRIGGER sabotage_journal BEFORE INSERT ON journal_entries
                 BEGIN SELECT RAISE(ABORT,'ledger failure'); END",
            "CREATE TRIGGER sabotage_audit BEFORE INSERT ON activity_log
                 BEGIN SELECT RAISE(ABORT,'audit failure'); END",
            "CREATE TRIGGER sabotage_adjustment BEFORE INSERT ON stock_adjustments
                 BEGIN SELECT RAISE(ABORT,'adjustment failure'); END",
            "CREATE TRIGGER sabotage_provenance BEFORE INSERT ON native_stock_ledger_provenance
                 BEGIN SELECT RAISE(ABORT,'provenance failure'); END",
        ] {
            let mut db = memory().await;
            inv(&mut db, "lot", 10, "A", 2.0, 12.0, None).await;
            db.execute(trigger).await.unwrap();
            assert!(
                delete_lot(
                    &mut db,
                    "actor-a",
                    DeleteInventoryLotInput { id: "lot".into() }
                )
                .await
                .is_err(),
                "{trigger}"
            );
            assert_eq!(counts(&mut db).await, (1, 0, 0, 0, 0));
            let remaining: f64 =
                sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id='lot'")
                    .fetch_one(&mut db)
                    .await
                    .unwrap();
            assert_eq!(remaining, 2.0);
        }
        for trigger in [
            "CREATE TRIGGER sabotage_lot BEFORE INSERT ON inventory
               BEGIN SELECT RAISE(ABORT,'lot failed'); END",
            "CREATE TRIGGER sabotage_receipt BEFORE INSERT ON inventory_lot_create_requests
               BEGIN SELECT RAISE(ABORT,'receipt failed'); END",
            "CREATE TRIGGER sabotage_create_audit BEFORE INSERT ON activity_log
               BEGIN SELECT RAISE(ABORT,'audit failed'); END",
        ] {
            let mut db = memory().await;
            db.execute(trigger).await.unwrap();
            assert!(create_lot(&mut db, "actor-a", payload(NONCE, 10, 1.0))
                .await
                .is_err());
            assert_eq!(counts(&mut db).await, (0, 0, 0, 0, 0));
        }
    }

    #[tokio::test]
    async fn legacy_inventory_schema_without_medium_to_small_still_creates_compatible_lot() {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        setup(&mut db, false).await;
        let result = create_lot(&mut db, "actor-a", payload(NONCE, 10, 1.25))
            .await
            .unwrap();
        assert_eq!(result.drug_id, 10);
        let data = sqlx::query("SELECT CAST(quantity AS REAL) q,strips_per_box FROM inventory")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(data.get::<f64, _>("q"), 1.25);
        assert_eq!(data.get::<i64, _>("strips_per_box"), 12);
    }

    #[tokio::test]
    async fn concurrent_create_nonce_and_delete_quantity_have_one_committed_action() {
        let mut file = std::env::temp_dir();
        file.push(format!("pharma-lot-native-{}.sqlite", Uuid::new_v4()));
        let opt = SqliteConnectOptions::new()
            .filename(&file)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(8));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(opt)
            .await
            .unwrap();
        {
            let mut conn = pool.acquire().await.unwrap();
            setup(&mut conn, true).await;
        }
        let (a, b) = tokio::join!(
            async {
                let mut conn = pool.acquire().await.unwrap();
                create_lot(&mut conn, "actor-a", payload(NONCE, 10, 2.0)).await
            },
            async {
                let mut conn = pool.acquire().await.unwrap();
                create_lot(&mut conn, "actor-a", payload(NONCE, 10, 2.0)).await
            },
        );
        let a = a.unwrap();
        let b = b.unwrap();
        assert_eq!(
            a.id, b.id,
            "simultaneous same-nonce retries return one posted lot"
        );
        let id = a.id;
        {
            let mut conn = pool.acquire().await.unwrap();
            assert_eq!(counts(&mut conn).await, (1, 1, 0, 0, 1));
        }
        {
            let mut conn = pool.acquire().await.unwrap();
            sqlx::query("UPDATE inventory SET cost_price=12 WHERE id=?")
                .bind(&id)
                .execute(&mut *conn)
                .await
                .unwrap();
        }
        let (a, b) = tokio::join!(
            async {
                let mut conn = pool.acquire().await.unwrap();
                delete_lot(
                    &mut conn,
                    "actor-a",
                    DeleteInventoryLotInput { id: id.clone() },
                )
                .await
            },
            async {
                let mut conn = pool.acquire().await.unwrap();
                delete_lot(
                    &mut conn,
                    "actor-a",
                    DeleteInventoryLotInput { id: id.clone() },
                )
                .await
            },
        );
        assert_eq!(i64::from(a.is_ok()) + i64::from(b.is_ok()), 1);
        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(counts(&mut conn).await, (1, 1, 1, 1, 2));
        drop(conn);
        pool.close().await;
        // Windows antivirus/SQLite locks are unrelated to assertion quality.
        for _ in 0..20 {
            if std::fs::remove_file(&file).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[test]
    fn update_payload_is_strict_and_distinguishes_omitted_from_null_metadata() {
        let base = serde_json::json!({
            "id":"lot", "quantity":2, "localSellingPrice":31,
            "expectedQuantity":1, "expectedLocalSellingPrice":30,
            "reasonId":1
        });
        let unchanged: UpdateInventoryLotInput = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(unchanged.expiry_date, None);
        assert_eq!(unchanged.barcode, None);
        let mut changes = base.clone();
        changes["expiryDate"] = serde_json::Value::Null;
        changes["barcode"] = serde_json::json!("B-10");
        let parsed: UpdateInventoryLotInput = serde_json::from_value(changes).unwrap();
        assert_eq!(parsed.expiry_date, Some(None));
        assert_eq!(parsed.barcode, Some(Some("B-10".into())));
        for forged in [
            "pharmacyId",
            "actor",
            "userId",
            "drugId",
            "costPrice",
            "officialPrice",
            "accountId",
            "mediumToSmall",
            "sql",
        ] {
            let mut attempt = base.clone();
            attempt[forged] = serde_json::json!("injected");
            assert!(
                serde_json::from_value::<UpdateInventoryLotInput>(attempt).is_err(),
                "{forged}"
            );
        }
        for bad in [f64::NAN, f64::INFINITY, -0.1, 1e10, 1e-12] {
            let mut data = update_payload("lot", 2.0, bad);
            assert!(validate_update(&data).is_err(), "{bad}");
            data.quantity = 3.0;
            data.expected_quantity = bad;
            assert!(validate_update(&data).is_err(), "{bad}");
        }
        let mut invalid = update_payload("lot", 2.0, 3.0);
        invalid.expiry_date = Some(Some("2030-02-30".into()));
        assert!(validate_update(&invalid).is_err());
        invalid.expiry_date = None;
        invalid.reason_id = Some(-2);
        assert!(validate_update(&invalid).is_err());
    }

    #[tokio::test]
    async fn native_edit_is_tenant_scoped_checks_live_permission_and_detects_stale_edits() {
        let mut db = memory().await;
        inv(&mut db, "lot", 10, "A", 2.0, 12.0, None).await;
        for actor in ["actor-b", "inactive", "denied"] {
            assert!(
                update_lot(&mut db, actor, update_payload("lot", 2.0, 3.0))
                    .await
                    .is_err(),
                "{actor}"
            );
        }
        assert_eq!(counts(&mut db).await, (1, 0, 0, 0, 0));
        let saved = update_lot(&mut db, "actor-a", update_payload("lot", 2.0, 3.0))
            .await
            .unwrap();
        assert!(saved.success);
        assert_eq!(saved.drug_id, 10);
        assert_eq!(saved.quantity, 3.0);
        assert!(
            update_lot(&mut db, "actor-a", update_payload("lot", 2.0, 4.0))
                .await
                .is_err(),
            "stale quantity must not overwrite new stock"
        );
        let mut stale_price = update_payload("lot", 3.0, 4.0);
        stale_price.expected_local_selling_price = 30.0;
        assert!(update_lot(&mut db, "actor-a", stale_price).await.is_err());
        let stored: (f64, f64) = sqlx::query_as(
            "SELECT CAST(quantity AS REAL),CAST(local_selling_price AS REAL) FROM inventory WHERE id='lot'",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(stored, (3.0, 32.0));
        assert_eq!(counts(&mut db).await, (1, 0, 1, 1, 1));
        let master_price: f64 =
            sqlx::query_scalar("SELECT official_price FROM master_drugs WHERE id=10")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(
            master_price, 100.0,
            "tenant edit cannot change global catalog price"
        );
    }

    #[tokio::test]
    async fn adjustment_reasons_and_cost_bases_are_required_for_a_stock_delta() {
        let mut db = memory().await;
        inv(&mut db, "lot", 10, "A", 2.0, 12.0, None).await;
        for reason in [None, Some(999), Some(-1)] {
            let mut data = update_payload("lot", 2.0, 3.0);
            data.reason_id = reason;
            assert!(
                update_lot(&mut db, "actor-a", data).await.is_err(),
                "{reason:?}"
            );
        }
        assert_eq!(counts(&mut db).await, (1, 0, 0, 0, 0));
        let mut price_only = update_payload("lot", 2.0, 2.0);
        price_only.reason_id = None;
        price_only.expiry_date = Some(Some("2031-04-12".into()));
        price_only.barcode = Some(Some("NEW-A".into()));
        assert!(update_lot(&mut db, "actor-a", price_only).await.is_ok());
        assert_eq!(counts(&mut db).await, (1, 0, 0, 0, 1));
        let updated = sqlx::query(
            "SELECT CAST(quantity AS REAL) quantity,expiry_date,barcode FROM inventory",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(updated.get::<f64, _>("quantity"), 2.0);
        assert_eq!(updated.get::<String, _>("expiry_date"), "2031-04-12");
        assert_eq!(updated.get::<String, _>("barcode"), "NEW-A");
    }

    #[tokio::test]
    async fn positive_and_negative_adjustments_post_tenant_journals_with_correct_account_types() {
        let mut db = memory().await;
        inv(&mut db, "lot", 10, "A", 2.0, 12.0, None).await;
        update_lot(&mut db, "actor-a", update_payload("lot", 2.0, 4.0))
            .await
            .unwrap();
        let mut decrease = update_payload("lot", 4.0, 3.0);
        decrease.expected_local_selling_price = 32.0;
        decrease.local_selling_price = 29.0;
        decrease.reason_id = Some(2);
        update_lot(&mut db, "actor-a", decrease).await.unwrap();
        assert_eq!(counts(&mut db).await, (1, 0, 2, 2, 2));
        let posts = sqlx::query(
            "SELECT j.total_amount,j.created_by,j.pharmacy_id,
                    e.account_id,e.type,e.amount,a.type account_type
             FROM daily_journals j JOIN journal_entries e ON e.journal_id=j.id
             JOIN accounts a ON a.id=e.account_id ORDER BY j.rowid,e.id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(posts.len(), 4);
        for (i, (amount, account, side, kind)) in [
            (24.0, 10, "debit", "asset"),
            (24.0, 15, "credit", "revenue"),
            (12.0, 12, "debit", "expense"),
            (12.0, 10, "credit", "asset"),
        ]
        .into_iter()
        .enumerate()
        {
            let row = &posts[i];
            assert_eq!(row.get::<f64, _>("total_amount"), amount);
            assert_eq!(row.get::<f64, _>("amount"), amount);
            assert_eq!(row.get::<i64, _>("account_id"), account);
            assert_eq!(row.get::<String, _>("type"), side);
            assert_eq!(row.get::<String, _>("account_type"), kind);
            assert_eq!(row.get::<String, _>("pharmacy_id"), "A");
            assert_eq!(row.get::<String, _>("created_by"), "actor-a");
        }
        let adjustments = sqlx::query(
            "SELECT old_quantity,new_quantity,reason_id,user_id
             FROM stock_adjustments ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(adjustments[0].get::<f64, _>("old_quantity"), 2.0);
        assert_eq!(adjustments[0].get::<f64, _>("new_quantity"), 4.0);
        assert_eq!(adjustments[1].get::<f64, _>("old_quantity"), 4.0);
        assert_eq!(adjustments[1].get::<f64, _>("new_quantity"), 3.0);
        assert_eq!(adjustments[1].get::<i64, _>("reason_id"), 2);
        assert_eq!(adjustments[1].get::<String, _>("user_id"), "actor-a");
    }

    #[tokio::test]
    async fn committed_stock_provenance_is_structural_unique_and_immutable() {
        let mut db = memory().await;
        inv(&mut db, "lot", 10, "A", 2.0, 12.0, None).await;
        update_lot(&mut db, "actor-a", update_payload("lot", 2.0, 4.0))
            .await
            .unwrap();
        let row = sqlx::query(
            "SELECT p.adjustment_id,p.inventory_id,p.pharmacy_id,p.actor_id,
                    p.old_quantity,p.new_quantity,p.unit_cost_cents,
                    p.valuation_cents,p.journal_id,j.total_amount
             FROM native_stock_ledger_provenance p
             JOIN daily_journals j ON j.id=p.journal_id",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        let adjustment_id: i64 = row.get("adjustment_id");
        let journal_id: String = row.get("journal_id");
        assert_eq!(row.get::<String, _>("inventory_id"), "lot");
        assert_eq!(row.get::<String, _>("pharmacy_id"), "A");
        assert_eq!(row.get::<String, _>("actor_id"), "actor-a");
        assert_eq!(row.get::<f64, _>("old_quantity"), 2.0);
        assert_eq!(row.get::<f64, _>("new_quantity"), 4.0);
        assert_eq!(row.get::<i64, _>("unit_cost_cents"), 1200);
        assert_eq!(row.get::<i64, _>("valuation_cents"), 2400);
        assert_eq!(row.get::<f64, _>("total_amount"), 24.0);
        for tamper in [
            format!("UPDATE stock_adjustments SET new_quantity=200 WHERE id={adjustment_id}"),
            format!("DELETE FROM stock_adjustments WHERE id={adjustment_id}"),
            format!("UPDATE daily_journals SET pharmacy_id='B' WHERE id='{journal_id}'"),
            format!("DELETE FROM daily_journals WHERE id='{journal_id}'"),
            format!("UPDATE journal_entries SET amount=999 WHERE journal_id='{journal_id}'"),
            format!("DELETE FROM journal_entries WHERE journal_id='{journal_id}'"),
            format!("INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES('{journal_id}',10,'debit',24)"),
            format!("UPDATE native_stock_ledger_provenance SET pharmacy_id='B' WHERE adjustment_id={adjustment_id}"),
            format!("DELETE FROM native_stock_ledger_provenance WHERE adjustment_id={adjustment_id}"),
        ] {
            assert!(db.execute(tamper.as_str()).await.is_err(), "{tamper}");
        }
        assert_eq!(counts(&mut db).await, (1, 0, 1, 1, 1));
        let proof_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM native_stock_ledger_provenance")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(proof_count, 1);
        let claim_again = sqlx::query(
            "INSERT INTO native_stock_ledger_provenance
             (adjustment_id,inventory_id,pharmacy_id,actor_id,old_quantity,new_quantity,
              unit_cost_cents,valuation_cents,direction,journal_id,
              inventory_account_id,counterpart_account_id,counterpart_type)
             SELECT adjustment_id,inventory_id,pharmacy_id,actor_id,old_quantity,new_quantity,
                    unit_cost_cents,valuation_cents,direction,journal_id,
                    inventory_account_id,counterpart_account_id,counterpart_type
             FROM native_stock_ledger_provenance",
        )
        .execute(&mut db)
        .await;
        assert!(claim_again.is_err(), "a source may be claimed only once");
        inv(&mut db, "no-cost", 10, "A", 1.0, 0.0, None).await;
        update_lot(&mut db, "actor-a", update_payload("no-cost", 1.0, 3.0))
            .await
            .unwrap();
        let unvalued: (i64, Option<String>) = sqlx::query_as(
            "SELECT valuation_cents,journal_id FROM native_stock_ledger_provenance
             WHERE inventory_id='no-cost'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(unvalued, (0, None));
    }

    #[tokio::test]
    async fn refuses_foreign_barcode_ambiguous_history_and_unit_mutation() {
        let mut db = memory().await;
        inv(&mut db, "lot", 10, "A", 2.0, 12.0, None).await;
        inv(&mut db, "elsewhere", 20, "B", 3.0, 12.0, Some("REMOTE")).await;
        for code in ["REMOTE", "FOREIGN-MASTER"] {
            let mut data = update_payload("lot", 2.0, 2.0);
            data.barcode = Some(Some(code.into()));
            assert!(
                update_lot(&mut db, "actor-a", data).await.is_err(),
                "{code}"
            );
        }
        let mut data = update_payload("lot", 2.0, 2.0);
        data.large_to_medium = Some(20);
        assert!(update_lot(&mut db, "actor-a", data).await.is_err());
        let mut data = update_payload("lot", 2.0, 2.0);
        data.unit = Some("bottle".into());
        assert!(update_lot(&mut db, "actor-a", data).await.is_err());
        sqlx::raw_sql(
            "INSERT INTO sales_invoices(id,pharmacy_id) VALUES('sold','A');
             INSERT INTO sales_items(invoice_id,inventory_id) VALUES('sold','lot')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        let mut data = update_payload("lot", 2.0, 2.0);
        data.expiry_date = Some(Some("2040-01-01".into()));
        assert!(update_lot(&mut db, "actor-a", data).await.is_err());
        assert!(
            update_lot(&mut db, "actor-a", update_payload("lot", 2.0, 1.0))
                .await
                .is_ok(),
            "authorized adjustment of historically used lot is allowed"
        );
        assert_eq!(counts(&mut db).await, (2, 0, 1, 1, 1));
        sqlx::raw_sql(
            "INSERT INTO sales_items(invoice_id,inventory_id) VALUES('missing','elsewhere')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        assert!(
            update_lot(&mut db, "actor-b", update_payload("elsewhere", 3.0, 2.0))
                .await
                .is_err(),
            "dangling provenance must fail closed"
        );
    }

    #[tokio::test]
    async fn invalid_posting_accounts_and_unrepresentable_cost_fail_before_stock_write() {
        for sabotage in [
            "UPDATE accounts SET type='expense' WHERE code='3.2'",
            "UPDATE accounts SET is_group=1 WHERE code='3.2'",
            "UPDATE trial_balance_settings SET account_id=11 WHERE category='inventory_asset'",
            "INSERT INTO trial_balance_settings VALUES('inventory_adjustment_revenue',12)",
            "DELETE FROM accounts WHERE code='3.2'",
            "UPDATE inventory SET cost_price=2.22222 WHERE id='lot'",
        ] {
            let mut db = memory().await;
            inv(&mut db, "lot", 10, "A", 2.0, 12.0, None).await;
            db.execute(sabotage).await.unwrap();
            assert!(
                update_lot(&mut db, "actor-a", update_payload("lot", 2.0, 3.0))
                    .await
                    .is_err(),
                "{sabotage}"
            );
            assert_eq!(counts(&mut db).await, (1, 0, 0, 0, 0));
            let quantity: f64 = sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory")
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert_eq!(quantity, 2.0);
        }
        let mut db = memory().await;
        inv(&mut db, "free-lot", 10, "A", 1.0, 0.0, None).await;
        update_lot(&mut db, "actor-a", update_payload("free-lot", 1.0, 3.0))
            .await
            .unwrap();
        assert_eq!(counts(&mut db).await, (1, 0, 1, 0, 1));
    }

    #[tokio::test]
    async fn stock_update_journal_adjustment_and_audit_failures_roll_back_together() {
        for sabotage in [
            "CREATE TRIGGER sabotage BEFORE INSERT ON stock_adjustments
             BEGIN SELECT RAISE(ABORT,'stock failed'); END",
            "CREATE TRIGGER sabotage BEFORE INSERT ON daily_journals
             BEGIN SELECT RAISE(ABORT,'header failed'); END",
            "CREATE TRIGGER sabotage BEFORE INSERT ON journal_entries
             BEGIN SELECT RAISE(ABORT,'journal failed'); END",
            "CREATE TRIGGER sabotage BEFORE INSERT ON activity_log
             BEGIN SELECT RAISE(ABORT,'audit failed'); END",
            "CREATE TRIGGER sabotage BEFORE INSERT ON native_stock_ledger_provenance
             BEGIN SELECT RAISE(ABORT,'provenance failed'); END",
        ] {
            let mut db = memory().await;
            inv(&mut db, "lot", 10, "A", 2.0, 12.0, None).await;
            db.execute(sabotage).await.unwrap();
            assert!(
                update_lot(&mut db, "actor-a", update_payload("lot", 2.0, 3.0))
                    .await
                    .is_err(),
                "{sabotage}"
            );
            assert_eq!(counts(&mut db).await, (1, 0, 0, 0, 0));
            let (qty,price): (f64,f64) = sqlx::query_as(
                "SELECT CAST(quantity AS REAL),CAST(local_selling_price AS REAL) FROM inventory WHERE id='lot'",
            ).fetch_one(&mut db).await.unwrap();
            assert_eq!((qty, price), (2.0, 30.0));
        }
    }

    #[tokio::test]
    async fn simultaneous_editors_with_same_original_quantity_post_once() {
        let mut path = std::env::temp_dir();
        path.push(format!("pharma-lot-update-{}.sqlite", Uuid::new_v4()));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(&path)
                    .create_if_missing(true)
                    .busy_timeout(Duration::from_secs(8)),
            )
            .await
            .unwrap();
        {
            let mut conn = pool.acquire().await.unwrap();
            setup(&mut conn, true).await;
            inv(&mut conn, "lot", 10, "A", 2.0, 12.0, None).await;
        }
        let (a, b) = tokio::join!(
            async {
                let mut conn = pool.acquire().await.unwrap();
                update_lot(&mut conn, "actor-a", update_payload("lot", 2.0, 3.0)).await
            },
            async {
                let mut conn = pool.acquire().await.unwrap();
                update_lot(&mut conn, "actor-a", update_payload("lot", 2.0, 4.0)).await
            },
        );
        assert_eq!(i64::from(a.is_ok()) + i64::from(b.is_ok()), 1);
        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(counts(&mut conn).await, (1, 0, 1, 1, 1));
        let stored: f64 =
            sqlx::query_scalar("SELECT CAST(quantity AS REAL) FROM inventory WHERE id='lot'")
                .fetch_one(&mut *conn)
                .await
                .unwrap();
        assert!(stored == 3.0 || stored == 4.0);
        drop(conn);
        pool.close().await;
        for _ in 0..20 {
            if std::fs::remove_file(&path).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[tokio::test]
    async fn fixed_native_adjustment_uses_live_selling_price_and_preserves_tenant_boundaries() {
        let mut db = memory().await;
        inv(&mut db, "lot", 10, "A", 2.0, 12.0, Some("A-ONLY")).await;
        db.execute("UPDATE inventory SET local_selling_price=75 WHERE id='lot'")
            .await
            .unwrap();
        let input = || AdjustInventoryLotInput {
            id: "lot".into(),
            expected_quantity: 2.0,
            quantity: 4.0,
            reason_id: 1,
        };
        for actor in ["actor-b", "denied", "inactive"] {
            assert!(
                adjust_lot(&mut db, actor, input()).await.is_err(),
                "{actor}"
            );
        }
        assert!(adjust_lot(
            &mut db,
            "actor-a",
            AdjustInventoryLotInput {
                reason_id: 999,
                ..input()
            }
        )
        .await
        .is_err());
        assert_eq!(counts(&mut db).await, (1, 0, 0, 0, 0));
        let changed = adjust_lot(&mut db, "actor-a", input()).await.unwrap();
        assert_eq!(changed.quantity, 4.0);
        assert!(
            adjust_lot(&mut db, "actor-a", input()).await.is_err(),
            "stale stock view cannot post adjustment twice"
        );
        let row = sqlx::query(
            "SELECT CAST(quantity AS REAL) qty,local_selling_price,barcode
             FROM inventory WHERE id='lot'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(row.get::<f64, _>("qty"), 4.0);
        assert_eq!(row.get::<f64, _>("local_selling_price"), 75.0);
        assert_eq!(row.get::<String, _>("barcode"), "A-ONLY");
        let action: String =
            sqlx::query_scalar("SELECT action FROM activity_log ORDER BY id DESC LIMIT 1")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(action, "STOCK_ADJUSTMENT");
        assert_eq!(counts(&mut db).await, (1, 0, 1, 1, 1));
    }
}
