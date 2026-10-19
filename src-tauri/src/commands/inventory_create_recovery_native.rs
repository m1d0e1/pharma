//! Native, cross-session creation receipt recovery. A committed stock
//! creation without a separately acknowledged receipt blocks any new nonce
//! for that actor and pharmacy until an operator reconciles the original lot.
//! This is durable in the licensed pharmacy SQLite DB, not a webview cache.
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::GuardedReadPool;
use super::guarded_read::reset_cancelled_read_state;
use super::inventory_lots_native::authorized_inventory_actor;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AcknowledgeInventoryCreateInput {
    request_id: String,
    inventory_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingInventoryCreate {
    request_id: String,
    inventory_id: String,
    created_by: String,
    drug_id: i64,
    quantity: f64,
    local_selling_price: f64,
    expiry_date: Option<String>,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgedInventoryCreate {
    success: bool,
    request_id: String,
    inventory_id: String,
}

fn canonical_request_id(request: &str) -> bool {
    Uuid::parse_str(request)
        .ok()
        .is_some_and(|uuid| uuid.get_version_num() == 4 && uuid.to_string() == request)
}

async fn list_unacknowledged(
    conn: &mut SqliteConnection,
    actor: &str,
) -> Result<Vec<PendingInventoryCreate>, String> {
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result = async {
        let conn = &mut *tx;
        let pharmacy = authorized_inventory_actor(conn, actor).await?;
        let rows = sqlx::query(
            "SELECT r.request_id,r.inventory_id,r.created_by,r.drug_id,r.created_at,
                    CAST(i.quantity AS REAL) AS quantity,i.local_selling_price,i.expiry_date
             FROM main.inventory_lot_create_requests r
             LEFT JOIN main.inventory_lot_create_acknowledgements a
                 ON a.request_id=r.request_id
             LEFT JOIN main.inventory i
                 ON i.id=r.inventory_id AND i.pharmacy_id=r.pharmacy_id
             WHERE r.pharmacy_id=? AND a.request_id IS NULL
             ORDER BY r.created_at,r.request_id LIMIT 101",
        )
        .bind(&pharmacy)
        .fetch_all(conn)
        .await
        .map_err(|e| e.to_string())?;
        if rows.len() > 100 {
            return Err("Too many unresolved inventory creations; operator review required".into());
        }
        rows.into_iter()
            .map(|row| {
                // A deleted or detached lot must never be silently
                // acknowledged, as the parent request cannot be replayed.
                let quantity: f64 = row
                    .try_get::<Option<f64>, _>("quantity")
                    .map_err(|e| e.to_string())?
                    .ok_or("Unresolved stock creation has unavailable original lot")?;
                Ok(PendingInventoryCreate {
                    request_id: row.try_get("request_id").map_err(|e| e.to_string())?,
                    inventory_id: row.try_get("inventory_id").map_err(|e| e.to_string())?,
                    created_by: row.try_get("created_by").map_err(|e| e.to_string())?,
                    drug_id: row.try_get("drug_id").map_err(|e| e.to_string())?,
                    quantity,
                    local_selling_price: row
                        .try_get("local_selling_price")
                        .map_err(|e| e.to_string())?,
                    expiry_date: row.try_get("expiry_date").map_err(|e| e.to_string())?,
                    created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
                })
            })
            .collect()
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

async fn acknowledge(
    conn: &mut SqliteConnection,
    actor: &str,
    data: AcknowledgeInventoryCreateInput,
) -> Result<AcknowledgedInventoryCreate, String> {
    if !canonical_request_id(&data.request_id)
        || data.inventory_id.trim() != data.inventory_id
        || data.inventory_id.is_empty()
        || data.inventory_id.len() > 128
    {
        return Err("Invalid inventory creation acknowledgement".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result = async {
        let conn = &mut *tx;
        let pharmacy = authorized_inventory_actor(conn, actor).await?;
        let owns: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM main.inventory_lot_create_requests r
             JOIN main.inventory i ON i.id=r.inventory_id
              AND i.pharmacy_id=r.pharmacy_id AND i.drug_id=r.drug_id
             WHERE r.request_id=? AND r.inventory_id=?
               AND r.pharmacy_id=?",
        )
        .bind(&data.request_id)
        .bind(&data.inventory_id)
        .bind(&pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if owns.is_none() {
            return Err(
                "Original inventory receipt is unavailable or belongs to another pharmacy".into(),
            );
        }
        let changed = sqlx::query(
            "INSERT INTO main.inventory_lot_create_acknowledgements
                  (request_id,pharmacy_id,acknowledged_by)
             VALUES (?,?,?) ON CONFLICT(request_id) DO NOTHING",
        )
        .bind(&data.request_id)
        .bind(&pharmacy)
        .bind(actor)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected();
        if changed == 1 {
            sqlx::query(
                "INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
                 VALUES(?,'ACK_INVENTORY_CREATE',?,?)",
            )
            .bind(actor)
            .bind(format!(
                "Acknowledged existing stock lot {}",
                data.inventory_id
            ))
            .bind(&pharmacy)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        } else {
            let existing: Option<i64> = sqlx::query_scalar(
                "SELECT 1 FROM main.inventory_lot_create_acknowledgements
                 WHERE request_id=? AND pharmacy_id=?",
            )
            .bind(&data.request_id)
            .bind(&pharmacy)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
            if existing.is_none() {
                return Err("Conflicting inventory creation acknowledgement".into());
            }
        }
        Ok(AcknowledgedInventoryCreate {
            success: true,
            request_id: data.request_id,
            inventory_id: data.inventory_id,
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
pub async fn list_unacknowledged_inventory_creates_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<Vec<PendingInventoryCreate>, String> {
    let identity = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    list_unacknowledged(&mut conn, identity.as_deref().ok_or("Login required")?).await
}

#[tauri::command]
pub async fn acknowledge_inventory_create_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: AcknowledgeInventoryCreateInput,
) -> Result<AcknowledgedInventoryCreate, String> {
    let identity = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    acknowledge(
        &mut conn,
        identity.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    const REQUEST: &str = "a1111111-1111-4111-8111-111111111111";
    async fn fixture() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
            INSERT INTO users VALUES
              ('actor-a','cashier','{"can_manage_inventory":true}','branch-a',1),
              ('actor-c','cashier','{"can_manage_inventory":true}','branch-a',1),
              ('actor-b','cashier','{"can_manage_inventory":true}','branch-b',1),
              ('denied','cashier','{"can_manage_inventory":false}','branch-a',1);
            CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
              quantity REAL,local_selling_price REAL,expiry_date TEXT);
            INSERT INTO inventory VALUES('stock-a',10,'branch-a',2.5,12.50,'2030-12-31');
            CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/038_inventory_lot_create_requests.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/039_inventory_create_acknowledgements.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO inventory_lot_create_requests
             (request_id,inventory_id,drug_id,pharmacy_id,created_by,payload_hash)
             VALUES(?,?,?,?,?,?)",
        )
        .bind(REQUEST)
        .bind("stock-a")
        .bind(10_i64)
        .bind("branch-a")
        .bind("actor-a")
        .bind("hash")
        .execute(&mut db)
        .await
        .unwrap();
        db
    }

    fn intent(id: &str) -> AcknowledgeInventoryCreateInput {
        AcknowledgeInventoryCreateInput {
            request_id: REQUEST.into(),
            inventory_id: id.into(),
        }
    }

    #[tokio::test]
    async fn unresolved_receipt_survives_new_connection_and_ack_is_idempotent() {
        let mut db = fixture().await;
        let pending = list_unacknowledged(&mut db, "actor-a").await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].quantity, 2.5);
        assert_eq!(pending[0].inventory_id, "stock-a");
        assert_eq!(pending[0].created_by, "actor-a");
        assert!(list_unacknowledged(&mut db, "actor-b")
            .await
            .unwrap()
            .is_empty());
        // All live inventory managers in a branch must see the same pending
        // original. A user switch cannot hide unresolved stock and bypass
        // the native new-nonce creation gate.
        assert_eq!(
            list_unacknowledged(&mut db, "actor-c").await.unwrap().len(),
            1
        );
        let ack = acknowledge(&mut db, "actor-a", intent("stock-a"))
            .await
            .unwrap();
        assert_eq!(ack.inventory_id, "stock-a");
        acknowledge(&mut db, "actor-a", intent("stock-a"))
            .await
            .unwrap();
        assert!(list_unacknowledged(&mut db, "actor-a")
            .await
            .unwrap()
            .is_empty());
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM inventory_lot_create_acknowledgements")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(count, 1);
        let audits: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM activity_log")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(audits, 1);
    }

    #[tokio::test]
    async fn exhausted_integer_quantity_lot_still_has_recoverable_create_receipt() {
        // Existing installed pharmacy databases use INTEGER inventory.quantity.
        // Once a synthetic lot reaches zero, SQLx must not reject its receipt
        // simply because the original lot quantity is an SQLite INTEGER.
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
            INSERT INTO users VALUES('actor-a','owner','{}','branch-a',1);
            CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
              quantity INTEGER,local_selling_price REAL,expiry_date TEXT);
            INSERT INTO inventory VALUES('stock-a',10,'branch-a',0,24.0,'2028-12-31');
            CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
            "#,
        ).execute(&mut db).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/038_inventory_lot_create_requests.sql"))
            .execute(&mut db).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/039_inventory_create_acknowledgements.sql"))
            .execute(&mut db).await.unwrap();
        sqlx::query(
            "INSERT INTO inventory_lot_create_requests
             (request_id,inventory_id,drug_id,pharmacy_id,created_by,payload_hash)
             VALUES(?,?,?,?,?,?)",
        )
        .bind(REQUEST).bind("stock-a").bind(10_i64).bind("branch-a")
        .bind("actor-a").bind("hash").execute(&mut db).await.unwrap();

        let pending = list_unacknowledged(&mut db, "actor-a").await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].quantity, 0.0);
        let receipt = acknowledge(&mut db, "actor-a", intent("stock-a")).await.unwrap();
        assert!(receipt.success);
        assert!(list_unacknowledged(&mut db, "actor-a").await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn same_pharmacy_inventory_manager_can_audit_reconcile_colleague_lost_ack() {
        let mut db = fixture().await;
        acknowledge(&mut db, "actor-c", intent("stock-a"))
            .await
            .unwrap();
        assert!(list_unacknowledged(&mut db, "actor-a")
            .await
            .unwrap()
            .is_empty());
        acknowledge(&mut db, "actor-a", intent("stock-a"))
            .await
            .unwrap();
        let acknowledging: String = sqlx::query_scalar(
            "SELECT acknowledged_by FROM inventory_lot_create_acknowledgements WHERE request_id=?",
        )
        .bind(REQUEST)
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(acknowledging, "actor-c");
        let audits: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM activity_log")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(audits, 1);
    }

    #[tokio::test]
    async fn foreign_actor_missing_lot_and_reassigned_actor_cannot_ack() {
        let mut db = fixture().await;
        assert!(acknowledge(&mut db, "actor-b", intent("stock-a"))
            .await
            .is_err());
        assert!(acknowledge(&mut db, "denied", intent("stock-a"))
            .await
            .is_err());
        assert!(acknowledge(&mut db, "actor-a", intent("other-lot"))
            .await
            .is_err());
        sqlx::query("UPDATE users SET pharmacy_id='branch-b' WHERE id='actor-a'")
            .execute(&mut db)
            .await
            .unwrap();
        assert!(acknowledge(&mut db, "actor-a", intent("stock-a"))
            .await
            .is_err());
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM inventory_lot_create_acknowledgements")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn ack_audit_failure_rolls_back_then_recovery_remains_visible() {
        let mut db = fixture().await;
        sqlx::query(
            "CREATE TRIGGER abort_ack_audit BEFORE INSERT ON activity_log
             BEGIN SELECT RAISE(ABORT,'forced audit failure'); END",
        )
        .execute(&mut db)
        .await
        .unwrap();
        assert!(acknowledge(&mut db, "actor-a", intent("stock-a"))
            .await
            .is_err());
        assert_eq!(
            list_unacknowledged(&mut db, "actor-a").await.unwrap().len(),
            1
        );
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM inventory_lot_create_acknowledgements")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(count, 0);
    }
}
