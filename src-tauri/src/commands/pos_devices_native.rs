//! Fixed native POS terminal definitions. This is not the checkout command.
//! The renderer cannot change the terminal's accumulated balance or pharmacy.
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PosDetails {
    name_ar: String,
    name_en: Option<String>,
    location: Option<String>,
    computer_name: Option<String>,
    status: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PosUpdate {
    id: i64,
    details: PosDetails,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PosCreate {
    request_id: String,
    details: PosDetails,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PosId {
    id: i64,
}
#[derive(Debug, Serialize)]
pub struct PosCreated {
    id: i64,
}

fn clean(value: &str, len: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= len
        && !value.chars().any(|c| c == '\0' || c.is_control())
}
fn optional_clean(value: &str, len: usize) -> bool {
    value.len() <= len && !value.chars().any(|c| c == '\0' || c.is_control())
}
fn details_ok(details: &PosDetails) -> bool {
    clean(&details.name_ar, 256)
        && details
            .name_en
            .as_deref()
            .map_or(true, |s| optional_clean(s, 256))
        && details
            .location
            .as_deref()
            .map_or(true, |s| optional_clean(s, 256))
        && details
            .computer_name
            .as_deref()
            .map_or(true, |s| optional_clean(s, 128))
        && details
            .status
            .as_deref()
            .map_or(true, |s| matches!(s, "active" | "inactive"))
}
async fn actor_scope(
    conn: &mut SqliteConnection,
    actor: &str,
    write: bool,
) -> Result<String, String> {
    let (role, pharmacy) = active_generic_actor(conn, actor).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let allowed = if write {
        vec!["acc_can_view_pos"]
    } else {
        vec![
            "acc_can_view_pos",
            "acc_can_view_general",
            "can_select_pos_financial",
        ]
    };
    if !allowed
        .iter()
        .any(|key| user_has_permission(Some(&role), permissions.as_deref(), key, false))
    {
        return Err("Native POS device permission required".into());
    }
    Ok(pharmacy)
}
async fn create(
    conn: &mut SqliteConnection,
    actor: &str,
    input: PosCreate,
) -> Result<PosCreated, String> {
    let nonce = Uuid::parse_str(&input.request_id)
        .map_err(|_| "POS creation needs canonical UUIDv4 request nonce")?;
    if nonce.get_version_num() != 4
        || nonce.to_string() != input.request_id
        || !details_ok(&input.details)
        || input
            .details
            .status
            .as_deref()
            .is_some_and(|s| s != "active")
    {
        return Err("Invalid new POS definition".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let outcome = async {
        let conn = &mut *tx;
        let pharmacy = actor_scope(conn, actor, true).await?;
        if sqlx::query_scalar::<_,i64>(
            "SELECT 1 FROM main.finance_device_create_requests WHERE request_id=?")
            .bind(&input.request_id).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?.is_some() {
            return Err("POS creation request already processed".into());
        }
        let result = sqlx::query(
            "INSERT INTO main.points_of_sale (name_ar,name_en,location,computer_name,current_balance,status,pharmacy_id)
             VALUES(?,?,?,?,0,'active',?)")
            .bind(input.details.name_ar.trim()).bind(input.details.name_en.as_deref().map(str::trim).filter(|s|!s.is_empty()))
            .bind(input.details.location.as_deref().map(str::trim).filter(|s|!s.is_empty()))
            .bind(input.details.computer_name.as_deref().map(str::trim).filter(|s|!s.is_empty())).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e| e.to_string())?;
        let id = result.last_insert_rowid();
        sqlx::query("INSERT INTO main.finance_device_create_requests
          (request_id,kind,record_id,pharmacy_id) VALUES(?,'pos',?,?)")
          .bind(&input.request_id).bind(id).bind(&pharmacy)
          .execute(&mut *conn).await.map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO main.activity_log (user_id,action,details,pharmacy_id)
                     VALUES(?,'ADD_POS',?,?)")
            .bind(actor).bind(format!("New POS device {id}")).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e| e.to_string())?;
        Ok(PosCreated { id })
    }.await;
    match outcome {
        Ok(value) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(err) => {
            tx.rollback()
                .await
                .map_err(|e| format!("{err}; rollback failed: {e}"))?;
            Err(err)
        }
    }
}
async fn update(conn: &mut SqliteConnection, actor: &str, input: PosUpdate) -> Result<(), String> {
    if input.id <= 0 || !details_ok(&input.details) {
        return Err("Invalid POS update".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let outcome = async {
        let conn = &mut *tx;
        let pharmacy = actor_scope(conn, actor, true).await?;
        let current: Option<(String, f64)> = sqlx::query(
            "SELECT status,current_balance FROM main.points_of_sale WHERE id=?
             AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(input.id)
        .bind(&pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .map(|row| {
            Ok::<(String, f64), String>((
                row.try_get("status").map_err(|e| e.to_string())?,
                row.try_get("current_balance").map_err(|e| e.to_string())?,
            ))
        })
        .transpose()?;
        let (existing_status, balance) =
            current.ok_or("POS terminal not found in this pharmacy")?;
        let desired = input.details.status.as_deref().unwrap_or(&existing_status);
        if desired == "inactive" && (!balance.is_finite() || balance.abs() > 0.005) {
            return Err(
                "Nonzero or invalid POS balance requires settlement before disabling".into(),
            );
        }
        let rows = sqlx::query(
            "UPDATE main.points_of_sale SET name_ar=?,name_en=?,location=?,computer_name=?,status=?
             WHERE id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(input.details.name_ar.trim())
        .bind(
            input
                .details
                .name_en
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
        )
        .bind(
            input
                .details
                .location
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
        )
        .bind(
            input
                .details
                .computer_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty()),
        )
        .bind(desired)
        .bind(input.id)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if rows.rows_affected() != 1 {
            return Err("POS terminal changed during update".into());
        }
        sqlx::query(
            "INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
                     VALUES(?,'UPDATE_POS',?,?)",
        )
        .bind(actor)
        .bind(format!("Updated POS device {}", input.id))
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    match outcome {
        Ok(value) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(err) => {
            tx.rollback()
                .await
                .map_err(|e| format!("{err}; rollback failed: {e}"))?;
            Err(err)
        }
    }
}
async fn delete(conn: &mut SqliteConnection, actor: &str, id: i64) -> Result<(), String> {
    if id <= 0 {
        return Err("Invalid POS identifier".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let outcome = async {
        let conn = &mut *tx;
        let pharmacy = actor_scope(conn, actor, true).await?;
        let balance: Option<f64> = sqlx::query_scalar(
            "SELECT current_balance FROM main.points_of_sale WHERE id=?
             AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(id)
        .bind(&pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        let balance = balance.ok_or("POS terminal not found in this pharmacy")?;
        if !balance.is_finite() || balance.abs() > 0.005 {
            return Err("POS terminal has unreconciled balance".into());
        }
        // Do not erase the identity of devices already referenced by native
        // movement provenance, even if their current balance has returned to 0.
        let historic: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM main.cash_movements WHERE
             LOWER(COALESCE(source_type,'')) IN ('pos','point_of_sale','pos_transfer')
             AND CAST(target_name AS TEXT)=CAST(? AS TEXT) LIMIT 1",
        )
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if historic.is_some() {
            return Err("POS terminal has historical cash movements; disable instead".into());
        }
        // Older shift handovers recorded source_type='user_drawer' without
        // storing a terminal ID (receiver display text is not reliable
        // ownership evidence). A zero-balance POS in that pharmacy therefore
        // cannot be proven unused. Require reconciliation/soft retirement.
        let unscoped_handover: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM main.cash_movements
             WHERE LOWER(COALESCE(category,''))='handover'
               AND LOWER(COALESCE(source_type,''))='user_drawer'
               AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
             LIMIT 1",
        )
        .bind(&pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if unscoped_handover.is_some() {
            return Err(
                "Historic drawer handover has ambiguous POS destination; disable instead".into(),
            );
        }
        let removal = sqlx::query(
            "DELETE FROM main.points_of_sale WHERE id=?
             AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(id)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if removal.rows_affected() != 1 {
            return Err("POS terminal was changed concurrently".into());
        }
        sqlx::query("DELETE FROM main.trial_balance_settings WHERE category=?")
            .bind(format!("cash:{id}"))
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
                     VALUES(?,'DELETE_POS',?,?)",
        )
        .bind(actor)
        .bind(format!("Deleted zero-balance POS {id}"))
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    match outcome {
        Ok(value) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(err) => {
            tx.rollback()
                .await
                .map_err(|e| format!("{err}; rollback failed: {e}"))?;
            Err(err)
        }
    }
}
async fn list(conn: &mut SqliteConnection, actor: &str) -> Result<Vec<serde_json::Value>, String> {
    reset_cancelled_read_state(conn).await?;
    let pharmacy = actor_scope(conn, actor, false).await?;
    let rows = sqlx::query(
        "SELECT id,name_ar,name_en,location,computer_name,current_balance,
        initial_credit,initial_debit,status,created_at,pharmacy_id
        FROM main.points_of_sale
        WHERE COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
        ORDER BY id ASC LIMIT 1001",
    )
    .bind(&pharmacy)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if rows.len() > 1000 {
        return Err("POS list exceeds safe native read limit".into());
    }
    rows.into_iter()
        .map(|r| {
            Ok(serde_json::json!({
                "id":r.try_get::<i64,_>("id").map_err(|e|e.to_string())?,
                "name_ar":r.try_get::<String,_>("name_ar").map_err(|e|e.to_string())?,
                "name_en":r.try_get::<Option<String>,_>("name_en").unwrap_or(None),
                "location":r.try_get::<Option<String>,_>("location").unwrap_or(None),
                "computer_name":r.try_get::<Option<String>,_>("computer_name").unwrap_or(None),
                "current_balance":r.try_get::<Option<f64>,_>("current_balance").unwrap_or(None),
                "initial_credit":r.try_get::<Option<f64>,_>("initial_credit").unwrap_or(None),
                "initial_debit":r.try_get::<Option<f64>,_>("initial_debit").unwrap_or(None),
                "status":r.try_get::<Option<String>,_>("status").unwrap_or(None),
                "created_at":r.try_get::<Option<String>,_>("created_at").unwrap_or(None),
                "pharmacy_id":r.try_get::<Option<String>,_>("pharmacy_id").unwrap_or(None),
            }))
        })
        .collect()
}
#[tauri::command]
pub async fn create_pos_device_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PosCreate,
) -> Result<PosCreated, String> {
    let a = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    create(&mut conn, a.as_deref().ok_or("Login required")?, payload).await
}
#[tauri::command]
pub async fn update_pos_device_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PosUpdate,
) -> Result<(), String> {
    let a = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    update(&mut conn, a.as_deref().ok_or("Login required")?, payload).await
}
#[tauri::command]
pub async fn delete_pos_device_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PosId,
) -> Result<(), String> {
    let a = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    delete(&mut conn, a.as_deref().ok_or("Login required")?, payload.id).await
}
#[tauri::command]
pub async fn list_pos_devices_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<Vec<serde_json::Value>, String> {
    let a = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    list(&mut conn, a.as_deref().ok_or("Login required")?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::{Connection, Executor};
    use std::time::Duration;
    fn data(name: &str) -> PosDetails {
        PosDetails {
            name_ar: name.into(),
            name_en: Some("Terminal".into()),
            location: Some("Branch".into()),
            computer_name: None,
            status: None,
        }
    }
    fn create_input(name: &str, nonce: &str) -> PosCreate {
        PosCreate {
            details: data(name),
            request_id: nonce.into(),
        }
    }
    const NONCE1: &str = "3c56ecf8-6864-4d87-86e0-5f978a8cdf12";
    const NONCE2: &str = "e323f3b8-c9b2-4c2c-a7f2-87347c409e2e";
    async fn seed(c: &mut SqliteConnection) {
        c.execute(r#"
          CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,is_active INTEGER,pharmacy_id TEXT);
          INSERT INTO users VALUES
          ('a','owner','{}',1,'A'),('b','owner','{}',1,'B'),
          ('clerk','cashier','{"acc_can_view_pos":true}',1,'A'),
          ('reader','cashier','{"can_select_pos_financial":true}',1,'A'),
          ('denied','cashier','{}',1,'A'),('disabled','owner','{}',0,'A');
          CREATE TABLE points_of_sale(
            id INTEGER PRIMARY KEY,name_ar TEXT,name_en TEXT,location TEXT,computer_name TEXT,
            current_balance REAL DEFAULT 0,initial_credit REAL DEFAULT 0,initial_debit REAL DEFAULT 0,
            status TEXT DEFAULT 'active',created_at TEXT DEFAULT CURRENT_TIMESTAMP,pharmacy_id TEXT);
          INSERT INTO points_of_sale(id,name_ar,current_balance,status,pharmacy_id) VALUES
            (1,'A1',0,'active','A'),(2,'B1',0,'active','B'),(3,'A3',25,'active','A');
          CREATE TABLE cash_movements(id TEXT PRIMARY KEY,source_type TEXT,target_name TEXT,
            category TEXT,pharmacy_id TEXT);
          CREATE TABLE trial_balance_settings(category TEXT PRIMARY KEY,account_id INTEGER);
          INSERT INTO trial_balance_settings VALUES('cash:1',101);
          CREATE TABLE finance_device_create_requests(request_id TEXT PRIMARY KEY,
            kind TEXT,record_id INTEGER,pharmacy_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
          CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
        "#).await.unwrap();
    }
    async fn fixture() -> SqliteConnection {
        let mut c = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        seed(&mut c).await;
        c
    }
    async fn count(c: &mut SqliteConnection, sql: &str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(&mut *c).await.unwrap()
    }
    #[tokio::test]
    async fn pos_native_crud_scope_and_no_accidental_balance_edits() {
        let mut c = fixture().await;
        let created = create(&mut c, "clerk", create_input("New A", NONCE1))
            .await
            .unwrap();
        assert!(create(&mut c, "clerk", create_input("Retry", NONCE1))
            .await
            .unwrap_err()
            .contains("already processed"));
        assert_eq!(count(&mut c,&format!("SELECT COUNT(*) FROM points_of_sale WHERE id={} AND pharmacy_id='A' AND current_balance=0",created.id)).await,1);
        let own = list(&mut c, "reader").await.unwrap();
        assert!(own.iter().all(|r| r["pharmacy_id"] == "A"));
        assert!(!own.iter().any(|r| r["id"] == 2));
        let renamed = PosUpdate {
            id: created.id,
            details: data("Renamed"),
        };
        update(&mut c, "clerk", renamed).await.unwrap();
        let after: f64 =
            sqlx::query_scalar("SELECT current_balance FROM points_of_sale WHERE id=?")
                .bind(created.id)
                .fetch_one(&mut c)
                .await
                .unwrap();
        assert_eq!(after, 0.0);
        assert!(update(
            &mut c,
            "clerk",
            PosUpdate {
                id: 2,
                details: data("Forger")
            }
        )
        .await
        .is_err());
        assert!(delete(&mut c, "clerk", 2).await.is_err());
        assert!(delete(&mut c, "clerk", 3).await.is_err());
        delete(&mut c, "clerk", 1).await.unwrap();
        assert_eq!(
            count(
                &mut c,
                "SELECT COUNT(*) FROM trial_balance_settings WHERE category='cash:1'"
            )
            .await,
            0
        );
        delete(&mut c, "clerk", created.id).await.unwrap();
        assert!(create(&mut c, "clerk", create_input("Late replay", NONCE1))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn pos_actor_permissions_deactivation_reassignment_and_hostile_dto_fail_closed() {
        let mut c = fixture().await;
        for actor in ["reader", "denied", "disabled", "missing"] {
            assert!(create(&mut c, actor, create_input("Not allowed", NONCE1))
                .await
                .is_err());
        }
        assert!(list(&mut c, "denied").await.is_err());
        assert!(list(&mut c, "disabled").await.is_err());
        let payload = serde_json::json!({"nameAr":"Safe","nameEn":"Name"});
        for forbidden in [
            "pharmacyId",
            "userId",
            "role",
            "sql",
            "currentBalance",
            "accountId",
        ] {
            let mut altered = payload.clone();
            altered[forbidden] = serde_json::json!("B");
            assert!(serde_json::from_value::<PosDetails>(altered).is_err());
        }
        let mut invalid = data("x");
        invalid.status = Some("closed".into());
        assert!(create(
            &mut c,
            "a",
            PosCreate {
                details: invalid,
                request_id: NONCE1.into()
            }
        )
        .await
        .is_err());
        assert!(delete(&mut c, "a", PosId { id: 0 }.id).await.is_err());
        c.execute("UPDATE users SET pharmacy_id='B' WHERE id='clerk'")
            .await
            .unwrap();
        assert!(update(
            &mut c,
            "clerk",
            PosUpdate {
                id: 1,
                details: data("B move")
            }
        )
        .await
        .is_err());
        assert_eq!(
            count(&mut c, "SELECT COUNT(*) FROM points_of_sale").await,
            3
        );
    }
    #[tokio::test]
    async fn pos_rollback_and_historic_posting_keep_parent_and_audit() {
        let mut c = fixture().await;
        c.execute(
            "CREATE TRIGGER deny_pos_activity BEFORE INSERT ON activity_log
             BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
        )
        .await
        .unwrap();
        assert!(create(&mut c, "a", create_input("Rollback", NONCE1))
            .await
            .is_err());
        assert_eq!(
            count(&mut c, "SELECT COUNT(*) FROM points_of_sale").await,
            3
        );
        assert_eq!(
            count(
                &mut c,
                "SELECT COUNT(*) FROM finance_device_create_requests"
            )
            .await,
            0
        );
        assert!(delete(&mut c, "a", 1).await.is_err());
        assert_eq!(
            count(
                &mut c,
                "SELECT COUNT(*) FROM trial_balance_settings WHERE category='cash:1'"
            )
            .await,
            1
        );
        c.execute("DROP TRIGGER deny_pos_activity").await.unwrap();
        c.execute(
            "INSERT INTO cash_movements(id,source_type,target_name,pharmacy_id)
                   VALUES('used','pos_transfer','1','A')",
        )
        .await
        .unwrap();
        assert!(delete(&mut c, "a", 1)
            .await
            .unwrap_err()
            .contains("historical"));
        c.execute("UPDATE points_of_sale SET current_balance=0 WHERE id=3")
            .await
            .unwrap();
        update(
            &mut c,
            "a",
            PosUpdate {
                id: 3,
                details: PosDetails {
                    status: Some("inactive".into()),
                    ..data("Retired")
                },
            },
        )
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn ambiguous_old_user_drawer_handover_denies_pos_deletion_without_claiming_destination() {
        let mut c = fixture().await;
        c.execute(
            "INSERT INTO cash_movements(id,source_type,target_name,category,pharmacy_id)
            VALUES('old-unknown','user_drawer','cashier label','handover','A')",
        )
        .await
        .unwrap();
        assert!(delete(&mut c, "a", 1)
            .await
            .unwrap_err()
            .contains("ambiguous POS destination"));
        assert_eq!(
            count(&mut c, "SELECT COUNT(*) FROM points_of_sale WHERE id=1").await,
            1
        );
        assert!(
            delete(&mut c, "b", 2).await.is_ok(),
            "foreign tenant's unrelated handover cannot block that tenant"
        );
    }
    #[tokio::test]
    async fn pos_two_connections_delete_only_once_without_foreign_writes() {
        let mut path = std::env::temp_dir();
        path.push(format!("pharma-pos-device-{}.sqlite", uuid::Uuid::new_v4()));
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(8));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(opts)
            .await
            .unwrap();
        let mut c = pool.acquire().await.unwrap();
        seed(&mut c).await;
        drop(c);
        let a = pool.clone();
        let b = pool.clone();
        let (r1, r2) = tokio::join!(
            async move {
                let mut c = a.acquire().await.unwrap();
                delete(&mut c, "a", 1).await
            },
            async move {
                let mut c = b.acquire().await.unwrap();
                delete(&mut c, "a", 1).await
            }
        );
        assert_ne!(r1.is_ok(), r2.is_ok());
        let mut c = pool.acquire().await.unwrap();
        assert_eq!(
            count(&mut c, "SELECT COUNT(*) FROM points_of_sale WHERE id=1").await,
            0
        );
        assert_eq!(
            count(&mut c, "SELECT COUNT(*) FROM points_of_sale WHERE id=2").await,
            1
        );
        drop(c);
        pool.close().await;
        for _ in 0..20 {
            if std::fs::remove_file(&path).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    #[tokio::test]
    async fn pos_two_writers_cannot_create_same_request_nonce() {
        let mut path = std::env::temp_dir();
        path.push(format!("pharma-pos-create-{}.sqlite", Uuid::new_v4()));
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(8));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(opts)
            .await
            .unwrap();
        let mut c = pool.acquire().await.unwrap();
        seed(&mut c).await;
        drop(c);
        let a = pool.clone();
        let b = pool.clone();
        let (r1, r2) = tokio::join!(
            async move {
                let mut c = a.acquire().await.unwrap();
                create(&mut c, "a", create_input("A", NONCE2)).await
            },
            async move {
                let mut c = b.acquire().await.unwrap();
                create(&mut c, "a", create_input("B", NONCE2)).await
            }
        );
        assert_ne!(r1.is_ok(), r2.is_ok());
        let mut c = pool.acquire().await.unwrap();
        assert_eq!(
            count(
                &mut c,
                "SELECT COUNT(*) FROM finance_device_create_requests WHERE kind='pos'"
            )
            .await,
            1
        );
        assert_eq!(
            count(&mut c, "SELECT COUNT(*) FROM points_of_sale WHERE id>3").await,
            1
        );
        drop(c);
        pool.close().await;
        for _ in 0..20 {
            if std::fs::remove_file(&path).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
