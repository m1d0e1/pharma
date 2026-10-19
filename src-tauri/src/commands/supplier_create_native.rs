//! Forward-only supplier provisioning. Legacy global IDs remain unowned.
//! This command never accepts a renderer actor or pharmacy and never creates
//! ledger, invoice, payable balance, or financial source evidence.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupplierCreateInput {
    request_id: String,
    name_ar: String,
    name_en: Option<String>,
    phone: Option<String>,
    address: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SupplierCreated {
    id: i64,
    request_id: String,
}

fn trimmed(raw: &str, max: usize, required: bool) -> Result<String, String> {
    let text = raw.trim();
    if text.len() > max || text.chars().any(char::is_control) || (required && text.is_empty()) {
        return Err("Invalid supplier create directory details".into());
    }
    Ok(text.to_string())
}

fn optional(raw: Option<&str>, max: usize) -> Result<Option<String>, String> {
    raw.map(|value| trimmed(value, max, false))
        .transpose()
        .map(|value| value.filter(|text| !text.is_empty()))
}

struct ValidatedSupplier {
    name_ar: String,
    name_en: Option<String>,
    phone: Option<String>,
    address: Option<String>,
    fingerprint: String,
}

fn validate(input: &SupplierCreateInput) -> Result<ValidatedSupplier, String> {
    let request =
        Uuid::parse_str(&input.request_id).map_err(|_| "Invalid supplier create request ID")?;
    if request.get_version_num() != 4 || request.to_string() != input.request_id {
        return Err("Supplier create request requires a canonical UUIDv4".into());
    }
    let name_ar = trimmed(&input.name_ar, 160, true)?;
    let name_en = optional(input.name_en.as_deref(), 160)?;
    let phone = optional(input.phone.as_deref(), 64)?;
    let address = optional(input.address.as_deref(), 512)?;
    // Exactly canonical original intent is pinned for replay; never hash the
    // untrusted actor, tenant or request ID as an authorization substitute.
    let serialized = serde_json::to_vec(&(&name_ar, &name_en, &phone, &address))
        .map_err(|_| "Invalid supplier create fingerprint")?;
    let fingerprint = Sha256::digest(serialized)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(ValidatedSupplier {
        name_ar,
        name_en,
        phone,
        address,
        fingerprint,
    })
}

async fn create_with_actor(
    conn: &mut SqliteConnection,
    actor: &str,
    input: SupplierCreateInput,
) -> Result<SupplierCreated, String> {
    let value = validate(&input)?;
    reset_cancelled_read_state(conn).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    let created = async {
        // Check the *live* row inside the writer reservation, not cached
        // renderer role/permissions or a supplied pharmacy string.
        let (role, pharmacy) = active_generic_actor(conn, actor).await?;
        let user = sqlx::query(
            "SELECT pharmacy_id,permissions FROM users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1"
        ).bind(actor).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
        let explicit: Option<String> = user.try_get("pharmacy_id").map_err(|e| e.to_string())?;
        let permissions: Option<String> = user.try_get("permissions").map_err(|e| e.to_string())?;
        // local_default historical ownership has not been independently
        // reconciled; do not expose a new-tenant write by weakening its guard.
        if pharmacy.eq_ignore_ascii_case("local_default") || explicit.as_deref() != Some(pharmacy.as_str())
            || pharmacy.is_empty() || pharmacy.len() > 128
        {
            return Err("Supplier create requires independently explicit tenant ownership".into());
        }
        if !matches!(role.trim().to_ascii_lowercase().as_str(), "owner" | "admin")
            || !user_has_permission(Some(&role), permissions.as_deref(), "can_view_suppliers", false)
        {
            return Err("Supplier directory creation requires owner/admin supplier permission".into());
        }
        let in_review: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM native_owner_scope_review WHERE owner_id=? LIMIT 1"
        ).bind(actor).fetch_optional(&mut *conn).await.map_err(|e| e.to_string())?;
        if in_review.is_some() {
            return Err("Supplier creator tenant requires independent owner-scope review".into());
        }
        let prior = sqlx::query(
            "SELECT supplier_id,pharmacy_id,actor_id,payload_sha256 FROM native_supplier_directory_ownership WHERE request_id=?"
        ).bind(&input.request_id).fetch_optional(&mut *conn).await.map_err(|e| e.to_string())?;
        if let Some(old) = prior {
            let same = old.get::<String, _>("pharmacy_id") == pharmacy
                && old.get::<String, _>("actor_id") == actor
                && old.get::<String, _>("payload_sha256") == value.fingerprint;
            if !same {
                return Err("Supplier create request ID already belongs to another actor, tenant or intent".into());
            }
            return Ok(SupplierCreated { id: old.get("supplier_id"), request_id: input.request_id });
        }
        let inserted = sqlx::query(
            "INSERT INTO suppliers(name_ar,name_en,phone,address,balance) VALUES(?,?,?,?,0)"
        ).bind(&value.name_ar).bind(&value.name_en).bind(&value.phone).bind(&value.address)
         .execute(&mut *conn).await.map_err(|e| e.to_string())?;
        let supplier_id = inserted.last_insert_rowid();
        sqlx::query(
            "INSERT INTO native_supplier_directory_ownership(supplier_id,pharmacy_id,actor_id,request_id,payload_sha256) VALUES (?,?,?,?,?)"
        ).bind(supplier_id).bind(&pharmacy).bind(actor).bind(&input.request_id)
         .bind(&value.fingerprint).execute(&mut *conn)
         .await.map_err(|e| format!("Supplier tenant ownership provenance refused commit: {e}"))?;
        sqlx::query("INSERT INTO activity_log(user_id,action,details,pharmacy_id) VALUES (?,'SUPPLIER_NATIVE_CREATE',?,?)")
            .bind(actor).bind(format!("Supplier {supplier_id} created with immutable tenant provenance"))
            .bind(&pharmacy).execute(&mut *conn).await.map_err(|e| e.to_string())?;
        Ok(SupplierCreated { id: supplier_id, request_id: input.request_id })
    }.await;
    match created {
        Ok(answer) => match sqlx::query("COMMIT").execute(&mut *conn).await {
            Ok(_) => Ok(answer),
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(error.to_string())
            }
        },
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn create_supplier_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: SupplierCreateInput,
) -> Result<SupplierCreated, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database is not initialized")?;
    let mut connection = pool.0.acquire().await.map_err(|e| e.to_string())?;
    create_with_actor(
        &mut connection,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{sqlite::SqliteConnectOptions, Connection};
    use std::time::Duration;

    const OWNERSHIP_MIGRATION: &str =
        include_str!("../../migrations/062_native_supplier_directory_ownership.sql");
    const NONCE: &str = "7718d3cc-b985-4e8a-b838-89bc976a08cf";

    fn payload(request_id: &str, name: &str) -> SupplierCreateInput {
        SupplierCreateInput {
            request_id: request_id.into(),
            name_ar: name.into(),
            name_en: Some("English".into()),
            phone: Some("0101".into()),
            address: Some("Cairo".into()),
        }
    }

    async fn setup_on(mut conn: SqliteConnection) -> SqliteConnection {
        sqlx::raw_sql(
            r#"PRAGMA foreign_keys=ON;
               CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,permissions TEXT,is_active INTEGER);
               CREATE TABLE suppliers(id INTEGER PRIMARY KEY AUTOINCREMENT,name_ar TEXT NOT NULL,name_en TEXT,phone TEXT,address TEXT,balance REAL DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
               CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,supplier_id INTEGER,pharmacy_id TEXT,user_id TEXT,status TEXT,payment_method TEXT);
               CREATE TABLE purchase_returns(id TEXT PRIMARY KEY,purchase_invoice_id TEXT,supplier_id INTEGER,user_id TEXT);
               CREATE TABLE supplier_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,supplier_id INTEGER,type TEXT,amount REAL,reference_id TEXT,user_id TEXT,payment_method TEXT);
               CREATE TABLE native_supplier_payment_receipts(id TEXT PRIMARY KEY,supplier_id INTEGER,pharmacy_id TEXT,actor_id TEXT);
               CREATE TABLE native_purchase_create_requests(invoice_id TEXT,pharmacy_id TEXT);
               CREATE TABLE native_purchase_posting_events(invoice_id TEXT);
               CREATE TABLE native_owner_scope_review(owner_id TEXT);
               CREATE TABLE activity_log(user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
               INSERT INTO users VALUES
                 ('a','owner','tenant-a','{}',1),('a-admin','admin','tenant-a','{"can_view_suppliers":true}',1),
                 ('a-viewer','cashier','tenant-a','{"can_view_suppliers":true}',1),
                 ('a-no-permission','admin','tenant-a','{"can_view_suppliers":false}',1),
                 ('a-inactive','owner','tenant-a','{}',0),
                 ('b','owner','tenant-b','{}',1),('legacy','owner','local_default','{}',1),
                 ('unscoped','owner',NULL,'{}',1),('quarantine','owner','tenant-a','{}',1);
               INSERT INTO native_owner_scope_review(owner_id) VALUES('quarantine');
               INSERT INTO suppliers(id,name_ar,balance) VALUES(7,'Legacy mixed tenant supplier',50);
               INSERT INTO purchase_invoices VALUES('old-a',7,'tenant-a','a','completed','credit'),
                 ('old-b',7,'tenant-b','b','completed','credit'),
                 ('old-unscoped',7,NULL,'legacy','completed','credit');
               INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id) VALUES(7,'invoice',50,'old-a');"#,
        ).execute(&mut conn).await.unwrap();
        sqlx::raw_sql(OWNERSHIP_MIGRATION)
            .execute(&mut conn)
            .await
            .unwrap();
        conn
    }

    async fn setup() -> SqliteConnection {
        setup_on(SqliteConnection::connect("sqlite::memory:").await.unwrap()).await
    }

    #[tokio::test]
    async fn prospective_create_and_exact_idempotent_nonce_never_claim_legacy_ids() {
        let mut conn = setup().await;
        let first = create_with_actor(&mut conn, "a", payload(NONCE, "Native new"))
            .await
            .unwrap();
        assert!(first.id > 7);
        let retry = create_with_actor(&mut conn, "a", payload(NONCE, "Native new"))
            .await
            .unwrap();
        assert_eq!(retry, first);
        for (actor, title) in [
            ("b", "Native new"),
            ("a-admin", "Native new"),
            ("a", "Changed intent"),
        ] {
            assert!(create_with_actor(&mut conn, actor, payload(NONCE, title))
                .await
                .is_err());
        }
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM suppliers")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            2
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM native_supplier_directory_ownership"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM activity_log")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            1
        );
        let legacy: (String, f64) =
            sqlx::query_as("SELECT name_ar,balance FROM suppliers WHERE id=7")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(legacy, ("Legacy mixed tenant supplier".into(), 50.0));
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM purchase_invoices WHERE supplier_id=7"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            3
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM native_supplier_directory_ownership WHERE supplier_id=7"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );
        assert!(sqlx::query("INSERT INTO native_supplier_directory_ownership(supplier_id,pharmacy_id,actor_id,request_id,payload_sha256) VALUES (7,'tenant-a','a','bad','aaaa')")
            .execute(&mut conn).await.is_err());
    }

    #[tokio::test]
    async fn denied_actor_or_legacy_scope_never_writes_directory_receipt_or_audit() {
        let mut conn = setup().await;
        for actor in [
            "a-viewer",
            "a-no-permission",
            "a-inactive",
            "unscoped",
            "legacy",
            "quarantine",
            "missing",
        ] {
            assert!(
                create_with_actor(&mut conn, actor, payload(NONCE, "Declined"))
                    .await
                    .is_err(),
                "{actor}"
            );
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM suppliers")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM native_supplier_directory_ownership"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM activity_log")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
        assert!(
            create_with_actor(&mut conn, "a", payload("bad", "Bad nonce"))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn new_ownership_blocks_foreign_invoices_returns_replay_and_contact_rewrite() {
        let mut conn = setup().await;
        let owned = create_with_actor(&mut conn, "a", payload(NONCE, "Tenant-owned"))
            .await
            .unwrap();
        let sid = owned.id;
        let statements=[
            format!("INSERT INTO purchase_invoices VALUES('foreign',{sid},'tenant-b','b','draft','credit')"),
            format!("INSERT INTO purchase_invoices VALUES('foreign-null',{sid},NULL,'a','draft','credit')"),
            format!("INSERT INTO purchase_invoices VALUES('wrong-actor',{sid},'tenant-a','b','draft','credit')"),
            format!("UPDATE purchase_invoices SET supplier_id={sid} WHERE id='old-a'"),
            format!("UPDATE suppliers SET name_ar='foreign claimed' WHERE id={sid}"),
            format!("DELETE FROM suppliers WHERE id={sid}"),
            format!("INSERT OR REPLACE INTO suppliers(id,name_ar,balance) VALUES({sid},'replaced',0)"),
            format!("UPDATE native_supplier_directory_ownership SET pharmacy_id='tenant-b' WHERE supplier_id={sid}"),
            format!("DELETE FROM native_supplier_directory_ownership WHERE supplier_id={sid}"),
            format!("INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id) VALUES({sid},'invoice',1,'old-b')"),
            format!("INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id) VALUES({sid},'misc',1,'old-a')"),
        ];
        for statement in statements {
            assert!(
                sqlx::query(&statement).execute(&mut conn).await.is_err(),
                "Guard accepted: {statement}"
            );
        }
        sqlx::query(&format!(
            "INSERT INTO purchase_invoices VALUES('owned',{sid},'tenant-a','a','draft','credit')"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        for statement in [
            format!("UPDATE purchase_invoices SET pharmacy_id='tenant-b' WHERE id='owned'"),
            format!("UPDATE purchase_invoices SET supplier_id=7 WHERE id='owned'"),
            format!("INSERT OR REPLACE INTO purchase_invoices VALUES('owned',7,'tenant-b','b','draft','credit')"),
            format!("INSERT OR REPLACE INTO purchase_invoices VALUES('owned',{sid},'tenant-a','a','completed','credit')"),
            format!("INSERT INTO purchase_returns VALUES('fake','owned',{sid},'b')"),
            format!("INSERT INTO purchase_returns VALUES('fake','old-b',{sid},'b')"),
        ] {
            assert!(sqlx::query(&statement).execute(&mut conn).await.is_err(),"Guard accepted: {statement}");
        }
        sqlx::query("PRAGMA recursive_triggers=OFF")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(sqlx::query(&format!("INSERT OR REPLACE INTO purchase_invoices VALUES('old-a',{sid},'tenant-a','a','completed','credit')"))
            .execute(&mut conn).await.is_err());
        assert!(sqlx::query(&format!(
            "INSERT OR REPLACE INTO suppliers(id,name_ar,balance) VALUES({sid},'replacement',0)"
        ))
        .execute(&mut conn)
        .await
        .is_err());
        sqlx::query(&format!(
            "INSERT INTO purchase_returns VALUES('real-return','owned',{sid},'a')"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        assert!(sqlx::query(&format!(
            "INSERT OR REPLACE INTO purchase_returns VALUES('real-return','owned',{sid},'a')"
        ))
        .execute(&mut conn)
        .await
        .is_err());
        assert!(
            sqlx::query("UPDATE purchase_returns SET supplier_id=7 WHERE id='real-return'")
                .execute(&mut conn)
                .await
                .is_err()
        );
        assert!(
            sqlx::query("DELETE FROM purchase_returns WHERE id='real-return'")
                .execute(&mut conn)
                .await
                .is_err()
        );
        let st=sqlx::query(&format!("INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id) VALUES ({sid},'return',1,'real-return')"))
            .execute(&mut conn).await.unwrap().last_insert_rowid();
        assert!(sqlx::query(&format!("INSERT OR REPLACE INTO supplier_transactions(id,supplier_id,type,amount,reference_id) VALUES ({st},{sid},'return',999,'real-return')"))
            .execute(&mut conn).await.is_err());
        assert!(sqlx::query(&format!("INSERT OR REPLACE INTO supplier_transactions(id,supplier_id,type,amount,reference_id) VALUES ({st},7,'invoice',999,'old-a')"))
            .execute(&mut conn).await.is_err());
        assert!(sqlx::query(&format!("INSERT OR REPLACE INTO supplier_transactions(id,supplier_id,type,amount,reference_id) VALUES (1,{sid},'return',999,'real-return')"))
            .execute(&mut conn).await.is_err());
        assert!(sqlx::query(&format!(
            "UPDATE supplier_transactions SET amount=10 WHERE supplier_id={sid}"
        ))
        .execute(&mut conn)
        .await
        .is_err());
        assert!(sqlx::query(&format!(
            "DELETE FROM supplier_transactions WHERE supplier_id={sid}"
        ))
        .execute(&mut conn)
        .await
        .is_err());
        let stale = ("Legacy mixed tenant supplier", 50.0);
        let global: (String, f64) =
            sqlx::query_as("SELECT name_ar,balance FROM suppliers WHERE id=7")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!((global.0.as_str(), global.1), stale);
    }

    #[tokio::test]
    async fn aborted_witness_insert_rolls_back_supplier_and_audit_together() {
        let mut conn = setup().await;
        sqlx::raw_sql("CREATE TRIGGER qa_deny_witness BEFORE INSERT ON native_supplier_directory_ownership BEGIN SELECT RAISE(ABORT,'simulate failed provenance'); END;")
            .execute(&mut conn).await.unwrap();
        assert!(
            create_with_actor(&mut conn, "a", payload(NONCE, "Rollback"))
                .await
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM suppliers")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM activity_log")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM native_supplier_directory_ownership"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn audit_failure_also_rolls_back_new_supplier_and_immutable_witness() {
        let mut conn = setup().await;
        sqlx::raw_sql("CREATE TRIGGER qa_deny_supplier_audit BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT,'simulate audit disk failure'); END;")
            .execute(&mut conn).await.unwrap();
        assert!(
            create_with_actor(&mut conn, "a", payload(NONCE, "Atomic source"))
                .await
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM suppliers")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM native_supplier_directory_ownership"
            )
            .fetch_one(&mut conn)
            .await
            .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM activity_log")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn concurrent_create_retry_on_two_connections_yields_one_owned_id() {
        let path = std::env::temp_dir().join(format!(
            "pharma-owned-supplier-unit-{}.sqlite",
            Uuid::new_v4()
        ));
        // Only this UUID-named temporary unit-test file, never an installed
        // AppData profile, is initialized with the same synthetic schema.
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(5))
            .foreign_keys(true);
        let mut first = setup_on(SqliteConnection::connect_with(&opts).await.unwrap()).await;
        let mut second = SqliteConnection::connect_with(&opts).await.unwrap();
        let (left, right) = tokio::join!(
            create_with_actor(
                &mut first,
                "a",
                payload(NONCE, "Concurrent native supplier")
            ),
            create_with_actor(
                &mut second,
                "a",
                payload(NONCE, "Concurrent native supplier")
            ),
        );
        assert_eq!(left.unwrap(), right.unwrap());
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM native_supplier_directory_ownership"
            )
            .fetch_one(&mut first)
            .await
            .unwrap(),
            1
        );
        first.close().await.unwrap();
        second.close().await.unwrap();
        std::fs::remove_file(&path).unwrap();
    }
}
