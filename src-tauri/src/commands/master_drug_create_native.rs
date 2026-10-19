//! Forward-only master-drug creation through a trusted native writer.
//! Master drug metadata is global. The immutable receipt identifies which
//! explicitly scoped actor created it, but never grants cross-tenant stock.
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
pub struct MasterDrugCreateInput {
    request_id: String,
    trade_name: String,
    trade_name_en: Option<String>,
    generic_name: Option<String>,
    active_ingredient: Option<String>,
    barcode: Option<String>,
    official_price: f64,
    category: Option<String>,
    manufacturer: Option<String>,
    large_unit: Option<String>,
    medium_unit: Option<String>,
    small_unit: Option<String>,
    large_to_medium: Option<i64>,
    medium_to_small: Option<i64>,
    has_expiry: bool,
    is_medicine: bool,
    is_service: Option<bool>,
    is_refrigerated: Option<bool>,
    is_chronic: Option<bool>,
    no_return: Option<bool>,
    prevent_fractions: Option<bool>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct MasterDrugCreated {
    success: bool,
    id: i64,
}

#[derive(Debug, Serialize)]
struct CatalogDetails {
    trade_name: String,
    trade_name_en: Option<String>,
    generic_name: Option<String>,
    active_ingredient: Option<String>,
    barcode: Option<String>,
    official_price: f64,
    category: Option<String>,
    manufacturer: Option<String>,
    large_unit: Option<String>,
    medium_unit: Option<String>,
    small_unit: Option<String>,
    large_to_medium: Option<i64>,
    medium_to_small: Option<i64>,
    has_expiry: bool,
    is_medicine: bool,
    is_service: bool,
    is_refrigerated: bool,
    is_chronic: bool,
    no_return: bool,
    prevent_fractions: bool,
}

fn required_text(input: &str, max: usize) -> Result<String, String> {
    let normalized = input.trim();
    if normalized.is_empty() || normalized.len() > max || normalized.chars().any(char::is_control) {
        return Err("Master drug requires a valid nonempty name".into());
    }
    Ok(normalized.to_owned())
}

fn optional_text(input: Option<&str>, max: usize) -> Result<Option<String>, String> {
    input
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            if value.len() > max || value.chars().any(char::is_control) {
                Err("Invalid master drug catalog field".into())
            } else {
                Ok(value.to_owned())
            }
        })
        .transpose()
}

fn validate(input: &MasterDrugCreateInput) -> Result<(CatalogDetails, String), String> {
    let request =
        Uuid::parse_str(&input.request_id).map_err(|_| "Invalid master drug create request ID")?;
    if request.get_version_num() != 4 || request.to_string() != input.request_id {
        return Err("Master drug creation requires canonical UUIDv4 request ID".into());
    }
    if !input.official_price.is_finite() || input.official_price < 0.0 {
        return Err("Explicit finite nonnegative official price required".into());
    }
    for factor in [input.large_to_medium, input.medium_to_small]
        .into_iter()
        .flatten()
    {
        if !(1..=1_000_000).contains(&factor) {
            return Err("Unit conversion must be a positive whole-number factor".into());
        }
    }
    let details = CatalogDetails {
        trade_name: required_text(&input.trade_name, 160)?,
        trade_name_en: optional_text(input.trade_name_en.as_deref(), 160)?,
        generic_name: optional_text(input.generic_name.as_deref(), 160)?,
        active_ingredient: optional_text(input.active_ingredient.as_deref(), 512)?,
        barcode: optional_text(input.barcode.as_deref(), 128)?,
        official_price: input.official_price,
        category: optional_text(input.category.as_deref(), 160)?,
        manufacturer: optional_text(input.manufacturer.as_deref(), 160)?,
        large_unit: optional_text(input.large_unit.as_deref(), 80)?,
        medium_unit: optional_text(input.medium_unit.as_deref(), 80)?,
        small_unit: optional_text(input.small_unit.as_deref(), 80)?,
        large_to_medium: input.large_to_medium,
        medium_to_small: input.medium_to_small,
        has_expiry: input.has_expiry,
        is_medicine: input.is_medicine,
        is_service: input.is_service.unwrap_or(false),
        is_refrigerated: input.is_refrigerated.unwrap_or(false),
        is_chronic: input.is_chronic.unwrap_or(false),
        no_return: input.no_return.unwrap_or(false),
        prevent_fractions: input.prevent_fractions.unwrap_or(false),
    };
    let bytes = serde_json::to_vec(&details).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    Ok((details, hash))
}

async fn create_with_actor(
    conn: &mut SqliteConnection,
    actor: &str,
    payload: MasterDrugCreateInput,
) -> Result<MasterDrugCreated, String> {
    let (details, hash) = validate(&payload)?;
    reset_cancelled_read_state(conn).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    let outcome = async {
        // The current session actor is resolved by the native command entry
        // point; re-read its LIVE permissions and explicit tenant inside the
        // writer reservation. Never accept either from renderer payload.
        let (role, pharmacy) = active_generic_actor(conn, actor).await?;
        let row = sqlx::query(
            "SELECT pharmacy_id,permissions FROM users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
        )
        .bind(actor)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        let explicit_tenant: Option<String> = row.try_get("pharmacy_id").map_err(|e| e.to_string())?;
        let permissions: Option<String> = row.try_get("permissions").map_err(|e| e.to_string())?;
        if pharmacy.is_empty()
            || pharmacy.len() > 128
            || pharmacy.eq_ignore_ascii_case("local_default")
            || explicit_tenant.as_deref() != Some(pharmacy.as_str())
        {
            return Err("Native catalog creation requires independently explicit tenant ownership".into());
        }
        if !matches!(role.trim().to_ascii_lowercase().as_str(), "owner" | "admin")
            || !user_has_permission(
                Some(&role),
                permissions.as_deref(),
                "can_manage_inventory",
                false,
            )
        {
            return Err("Native catalog creation requires owner/admin can_manage_inventory".into());
        }
        let needs_review: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM native_owner_scope_review WHERE owner_id=? LIMIT 1",
        )
        .bind(actor)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if needs_review.is_some() {
            return Err("Catalog creator tenant requires independent owner-scope review".into());
        }

        let previous = sqlx::query(
            "SELECT drug_id,actor_id,pharmacy_id,payload_sha256 FROM native_master_drug_create_receipts WHERE request_id=?",
        )
        .bind(&payload.request_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if let Some(previous) = previous {
            if previous.get::<String, _>("actor_id") != actor
                || previous.get::<String, _>("pharmacy_id") != pharmacy
                || previous.get::<String, _>("payload_sha256") != hash
            {
                return Err("Master drug request ID belongs to another actor, tenant or intent".into());
            }
            let id: i64 = previous.get("drug_id");
            let still_exists: Option<i64> =
                sqlx::query_scalar("SELECT id FROM master_drugs WHERE id=?")
                    .bind(id)
                    .fetch_optional(&mut *conn)
                    .await
                    .map_err(|e| e.to_string())?;
            if still_exists != Some(id) {
                return Err("Master drug receipt refers to missing catalog metadata".into());
            }
            return Ok(MasterDrugCreated { success: true, id });
        }

        // The global catalog is shared across pharmacies: a positive or NULL
        // stock quantity reserves its lot barcode regardless of tenant.
        if let Some(code) = details.barcode.as_deref() {
            let conflict: i64 = sqlx::query_scalar(
                "SELECT (EXISTS(SELECT 1 FROM master_drugs WHERE lower(trim(barcode))=lower(?) AND trim(coalesce(barcode,''))<>'') OR EXISTS(SELECT 1 FROM inventory WHERE (quantity IS NULL OR quantity != 0) AND lower(trim(barcode))=lower(?) AND trim(coalesce(barcode,''))<>''))",
            )
            .bind(code)
            .bind(code)
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
            if conflict != 0 {
                return Err("Barcode is already assigned to another drug".into());
            }
        }

        let result = sqlx::query(
            "INSERT INTO master_drugs (trade_name,trade_name_en,generic_name,active_ingredient,barcode,
              official_price,category,manufacturer,large_unit,medium_unit,small_unit,
              large_to_medium,medium_to_small,has_expiry,is_medicine,is_service,
              is_refrigerated,is_chronic,no_return,prevent_fractions)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&details.trade_name)
        .bind(&details.trade_name_en)
        .bind(&details.generic_name)
        .bind(&details.active_ingredient)
        .bind(&details.barcode)
        .bind(details.official_price)
        .bind(&details.category)
        .bind(&details.manufacturer)
        .bind(&details.large_unit)
        .bind(&details.medium_unit)
        .bind(&details.small_unit)
        .bind(details.large_to_medium)
        .bind(details.medium_to_small)
        .bind(details.has_expiry as i64)
        .bind(details.is_medicine as i64)
        .bind(details.is_service as i64)
        .bind(details.is_refrigerated as i64)
        .bind(details.is_chronic as i64)
        .bind(details.no_return as i64)
        .bind(details.prevent_fractions as i64)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        let id = result.last_insert_rowid();
        sqlx::query(
            "INSERT INTO native_master_drug_create_receipts
             (request_id,drug_id,actor_id,pharmacy_id,payload_sha256) VALUES(?,?,?,?,?)",
        )
        .bind(&payload.request_id)
        .bind(id)
        .bind(actor)
        .bind(&pharmacy)
        .bind(&hash)
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("Native catalog receipt refused commit: {e}"))?;
        sqlx::query(
            "INSERT INTO activity_log(user_id,action,details,pharmacy_id)
             VALUES (?,'MASTER_DRUG_NATIVE_CREATE',?,?)",
        )
        .bind(actor)
        .bind(format!("Master drug {id} created through typed native catalog path"))
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        Ok(MasterDrugCreated { success: true, id })
    }
    .await;
    match outcome {
        Ok(created) => match sqlx::query("COMMIT").execute(&mut *conn).await {
            Ok(_) => Ok(created),
            Err(e) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(e.to_string())
            }
        },
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn create_master_drug_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: MasterDrugCreateInput,
) -> Result<MasterDrugCreated, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database is not initialized")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    create_with_actor(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    const MIGRATION: &str = include_str!("../../migrations/064_native_catalog_create_receipts.sql");
    const NONCE: &str = "8a15f4b3-a0ed-4b28-bf9f-a287b5017b4e";
    const NONCE_2: &str = "83518d1a-f11b-4399-84e0-d1ec3bc87b11";
    const NONCE_3: &str = "96185dc0-1766-47ee-9e3e-1d883b9626ba";

    fn payload(nonce: &str, name: &str, barcode: Option<&str>) -> MasterDrugCreateInput {
        MasterDrugCreateInput {
            request_id: nonce.into(),
            trade_name: name.into(),
            trade_name_en: Some("English name".into()),
            generic_name: None,
            active_ingredient: Some("test ingredient".into()),
            barcode: barcode.map(str::to_owned),
            official_price: 25.5,
            category: Some("Medicines".into()),
            manufacturer: None,
            large_unit: Some("Box".into()),
            medium_unit: None,
            small_unit: None,
            large_to_medium: Some(10),
            medium_to_small: None,
            has_expiry: true,
            is_medicine: true,
            is_service: None,
            is_refrigerated: None,
            is_chronic: None,
            no_return: None,
            prevent_fractions: None,
        }
    }

    async fn setup() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"PRAGMA foreign_keys=ON;
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,permissions TEXT,is_active INTEGER);
            CREATE TABLE native_owner_scope_review(owner_id TEXT PRIMARY KEY);
            CREATE TABLE master_drugs(
                id INTEGER PRIMARY KEY,trade_name TEXT NOT NULL,trade_name_en TEXT,
                generic_name TEXT,active_ingredient TEXT,barcode TEXT,official_price REAL,
                category TEXT,manufacturer TEXT,large_unit TEXT,medium_unit TEXT,small_unit TEXT,
                large_to_medium INTEGER,medium_to_small INTEGER,has_expiry INTEGER,
                is_medicine INTEGER,is_service INTEGER,is_refrigerated INTEGER,is_chronic INTEGER,
                no_return INTEGER,prevent_fractions INTEGER
            );
            CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,barcode TEXT,quantity REAL);
            CREATE TABLE activity_log(user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
            INSERT INTO users VALUES
              ('owner','owner','tenant-a','{}',1),
              ('admin','admin','tenant-a','{"can_manage_inventory":true}',1),
              ('denied','admin','tenant-a','{"can_manage_inventory":false}',1),
              ('cashier','cashier','tenant-a','{"can_manage_inventory":true}',1),
              ('disabled','owner','tenant-a','{}',0),
              ('foreign','owner','tenant-b','{}',1),
              ('local','owner','local_default','{}',1),
              ('missing-scope','owner',NULL,'{}',1),
              ('review','owner','tenant-a','{}',1);
            INSERT INTO native_owner_scope_review VALUES('review');
            INSERT INTO master_drugs(id,trade_name,barcode,official_price)
              VALUES(10,'Historical catalogue row','BAR-OLD',99);
            INSERT INTO inventory VALUES('other-tenant-lot',10,'LOT-USED',3),
                                        ('historic-zero-lot',10,'LOT-FREE',0);"#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(MIGRATION).execute(&mut conn).await.unwrap();
        conn
    }

    async fn count(conn: &mut SqliteConnection, table: &str) -> i64 {
        let sql = match table {
            "master_drugs" => "SELECT COUNT(*) FROM master_drugs",
            "native_master_drug_create_receipts" => {
                "SELECT COUNT(*) FROM native_master_drug_create_receipts"
            }
            "activity_log" => "SELECT COUNT(*) FROM activity_log",
            _ => panic!("Unexpected fixture table"),
        };
        sqlx::query_scalar(sql).fetch_one(conn).await.unwrap()
    }

    #[tokio::test]
    async fn exact_retry_is_idempotent_but_changed_intent_actor_and_tenant_reject() {
        let mut conn = setup().await;
        let created = create_with_actor(
            &mut conn,
            "owner",
            payload(NONCE, "New catalog", Some("NEW-CODE")),
        )
        .await
        .unwrap();
        assert_eq!(created.success, true);
        assert!(created.id > 10);
        assert_eq!(
            create_with_actor(
                &mut conn,
                "owner",
                payload(NONCE, "New catalog", Some("NEW-CODE"))
            )
            .await
            .unwrap(),
            created
        );
        for (actor, name) in [
            ("admin", "New catalog"),
            ("foreign", "New catalog"),
            ("owner", "Other pack"),
        ] {
            assert!(
                create_with_actor(&mut conn, actor, payload(NONCE, name, Some("NEW-CODE")))
                    .await
                    .is_err()
            );
        }
        assert_eq!(count(&mut conn, "master_drugs").await, 2);
        assert_eq!(
            count(&mut conn, "native_master_drug_create_receipts").await,
            1
        );
        assert_eq!(count(&mut conn, "activity_log").await, 1);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT trade_name FROM master_drugs WHERE id=10")
                .fetch_one(&mut conn)
                .await
                .unwrap(),
            "Historical catalogue row"
        );
        // Legacy catalog metadata has no prospective insertion marker and
        // cannot be retroactively adopted through a forged receipt.
        assert!(sqlx::query(
            "INSERT INTO native_master_drug_create_receipts(request_id,drug_id,actor_id,pharmacy_id,payload_sha256)
             VALUES(?,10,'owner','tenant-a',?)",
        )
        .bind(NONCE_2)
        .bind("0".repeat(64))
        .execute(&mut conn)
        .await
        .is_err());
    }

    #[tokio::test]
    async fn requires_active_owner_or_admin_inventory_permission_and_independent_tenant() {
        let mut conn = setup().await;
        for actor in [
            "denied",
            "cashier",
            "disabled",
            "local",
            "missing-scope",
            "review",
            "absent",
        ] {
            assert!(
                create_with_actor(&mut conn, actor, payload(NONCE, "Denied catalog", None))
                    .await
                    .is_err(),
                "{actor}"
            );
        }
        assert_eq!(count(&mut conn, "master_drugs").await, 1);
        assert_eq!(
            count(&mut conn, "native_master_drug_create_receipts").await,
            0
        );
        assert_eq!(count(&mut conn, "activity_log").await, 0);
        assert!(
            create_with_actor(&mut conn, "admin", payload(NONCE, "Allowed", None))
                .await
                .is_ok()
        );
        assert_eq!(
            count(&mut conn, "native_master_drug_create_receipts").await,
            1
        );
    }

    #[tokio::test]
    async fn global_barcode_claim_checks_master_and_active_foreign_lots_but_not_name_or_empty_stock(
    ) {
        let mut conn = setup().await;
        for code in ["  bar-old  ", "lot-used"] {
            let result = create_with_actor(
                &mut conn,
                "foreign",
                payload(NONCE, "Historical catalogue row", Some(code)),
            )
            .await;
            assert!(result.unwrap_err().contains("Barcode"), "{code}");
        }
        // A zero-quantity historical lot does not own the barcode. Names may
        // legitimately repeat for distinct packs and need human review.
        let created = create_with_actor(
            &mut conn,
            "foreign",
            payload(NONCE_2, "Historical catalogue row", Some("LOT-FREE")),
        )
        .await
        .unwrap();
        assert!(created.id > 10);
        assert_eq!(count(&mut conn, "master_drugs").await, 2);
        let stored: (f64, i64, i64, String) = sqlx::query_as(
            "SELECT official_price,has_expiry,large_to_medium,barcode FROM master_drugs WHERE id=?",
        )
        .bind(created.id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(stored, (25.5, 1, 10, "LOT-FREE".into()));
    }

    #[tokio::test]
    async fn failed_receipt_rolls_back_master_insert_without_partial_audit() {
        let mut conn = setup().await;
        sqlx::query(
            "CREATE TRIGGER refuse_new_catalog_receipt BEFORE INSERT ON native_master_drug_create_receipts BEGIN SELECT RAISE(ABORT,'Synthetic receipt refusal'); END",
        ).execute(&mut conn).await.unwrap();
        let err = create_with_actor(&mut conn, "owner", payload(NONCE, "Atomic create", None))
            .await
            .unwrap_err();
        assert!(err.contains("Native catalog receipt refused commit"));
        assert_eq!(count(&mut conn, "master_drugs").await, 1);
        assert_eq!(
            count(&mut conn, "native_master_drug_create_receipts").await,
            0
        );
        assert_eq!(count(&mut conn, "activity_log").await, 0);
    }

    #[tokio::test]
    async fn invalid_intent_is_denied_and_immutable_receipts_cannot_be_rewritten() {
        let mut conn = setup().await;
        let mut invalid = payload("not-a-uuid", "Invalid", None);
        assert!(create_with_actor(&mut conn, "owner", invalid)
            .await
            .is_err());
        invalid = payload(NONCE, "  ", None);
        assert!(create_with_actor(&mut conn, "owner", invalid)
            .await
            .is_err());
        invalid = payload(NONCE, "Nonfinite", None);
        invalid.official_price = f64::INFINITY;
        assert!(create_with_actor(&mut conn, "owner", invalid)
            .await
            .is_err());
        invalid = payload(NONCE, "Bad conversion", None);
        invalid.large_to_medium = Some(0);
        assert!(create_with_actor(&mut conn, "owner", invalid)
            .await
            .is_err());
        let id = create_with_actor(&mut conn, "owner", payload(NONCE_3, "Valid", None))
            .await
            .unwrap()
            .id;
        assert!(sqlx::query(
            "UPDATE native_master_drug_create_receipts SET actor_id='foreign' WHERE drug_id=?"
        )
        .bind(id)
        .execute(&mut conn)
        .await
        .is_err());
        assert!(
            sqlx::query("DELETE FROM native_master_drug_create_receipts WHERE drug_id=?")
                .bind(id)
                .execute(&mut conn)
                .await
                .is_err()
        );
        assert!(sqlx::query(
            "INSERT OR REPLACE INTO master_drugs(id,trade_name) VALUES(?, 'Replaced')"
        )
        .bind(id)
        .execute(&mut conn)
        .await
        .is_err());
        assert!(sqlx::query("DELETE FROM master_drugs WHERE id=?")
            .bind(id)
            .execute(&mut conn)
            .await
            .is_err());
        assert_eq!(count(&mut conn, "master_drugs").await, 2);
        assert_eq!(
            count(&mut conn, "native_master_drug_create_receipts").await,
            1
        );
    }
}
