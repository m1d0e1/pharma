//! Prospective patient creation. Legacy patient rows have no tenant owner.
//! This command inserts both the patient and its immutable tenant witness in
//! one native transaction; an existing legacy patient can never be adopted.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::permission_policy::user_has_permission;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewOwnedPatient {
    request_id: String,
    full_name: String,
    name_en: Option<String>,
    phone: Option<String>,
    mobile: Option<String>,
    address: Option<String>,
    area: Option<String>,
    birth_date: Option<String>,
    gender: Option<String>,
    insurance_number: Option<String>,
    car_number: Option<String>,
    credit_limit: f64,
    opening_balance: f64,
    point_value: f64,
    customer_type: String,
    payment_method: String,
    notes: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct OwnedPatientReceipt {
    pub id: String,
}

fn valid_optional(value: Option<&str>, max: usize) -> bool {
    value.map_or(true, |text| {
        text.len() <= max
            && !text.chars().any(|c| c == '\0' || (c.is_control() && c != '\n' && c != '\r'))
    })
}

fn validate(request: &NewOwnedPatient) -> Result<(), String> {
    if request.request_id.len() < 16
        || request.request_id.len() > 128
        || !request.request_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        || request.full_name.trim().chars().count() < 3
        || !valid_optional(Some(&request.full_name), 200)
        || !valid_optional(request.name_en.as_deref(), 200)
        || !valid_optional(request.phone.as_deref(), 32)
        || !valid_optional(request.mobile.as_deref(), 32)
        || !valid_optional(request.address.as_deref(), 500)
        || !valid_optional(request.area.as_deref(), 200)
        || !valid_optional(request.birth_date.as_deref(), 30)
        || !valid_optional(request.gender.as_deref(), 20)
        || !valid_optional(request.insurance_number.as_deref(), 100)
        || !valid_optional(request.car_number.as_deref(), 100)
        || !valid_optional(request.notes.as_deref(), 2000)
        || !valid_optional(Some(&request.customer_type), 50)
        || !valid_optional(Some(&request.payment_method), 50)
        || !request.credit_limit.is_finite()
        || request.credit_limit < 0.0
        || !request.point_value.is_finite()
        || request.point_value < 0.0
        || request.opening_balance != 0.0
    {
        return Err("Invalid new patient request; opening balances require separately audited posting".into());
    }
    Ok(())
}

async fn create_owned_patient(
    conn: &mut SqliteConnection,
    actor_id: &str,
    request: NewOwnedPatient,
) -> Result<OwnedPatientReceipt, String> {
    validate(&request)?;
    let intent = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&request).map_err(|error| error.to_string())?)
    );
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|error| error.to_string())?;
    let result: Result<OwnedPatientReceipt, String> = async {
        let (role, pharmacy_id) = active_generic_actor(&mut *tx, actor_id).await?;
        if pharmacy_id == "local_default" || pharmacy_id.trim().is_empty() {
            return Err("Legacy patient ownership needs independent tenant verification".into());
        }
        let permissions: Option<String> = sqlx::query_scalar(
            "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
        )
        .bind(actor_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
        if !user_has_permission(
            Some(&role),
            permissions.as_deref(),
            "can_view_patients",
            false,
        ) {
            return Err("Patient directory permission denied".into());
        }
        // A replay of the same native request is idempotent for its original
        // actor and tenant; it never reattributes an existing legacy row.
        let already_owned: Option<(String, String, String)> = sqlx::query_as(
            "SELECT pharmacy_id,actor_id,intent_sha256 FROM main.native_patient_directory_ownership WHERE patient_id=?",
        )
        .bind(&request.request_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
        if let Some((owner, creator, persisted_intent)) = already_owned {
            if owner == pharmacy_id && creator == actor_id && persisted_intent == intent {
                return Ok(OwnedPatientReceipt { id: request.request_id });
            }
            return Err("Patient creation request conflicts with its immutable original intent".into());
        }
        sqlx::query(
            "INSERT INTO main.patients
            (id,full_name,name_en,phone,mobile,address,area,birth_date,gender,
             insurance_number,car_number,credit_limit,opening_balance,points_balance,
             point_value,customer_type,payment_method,notes)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?)",
        )
        .bind(&request.request_id)
        .bind(request.full_name.trim())
        .bind(request.name_en.as_deref())
        .bind(request.phone.as_deref())
        .bind(request.mobile.as_deref())
        .bind(request.address.as_deref())
        .bind(request.area.as_deref())
        .bind(request.birth_date.as_deref())
        .bind(request.gender.as_deref())
        .bind(request.insurance_number.as_deref())
        .bind(request.car_number.as_deref())
        .bind(request.credit_limit)
        .bind(request.point_value)
        .bind(&request.customer_type)
        .bind(&request.payment_method)
        .bind(request.notes.as_deref())
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
        sqlx::query(
            "INSERT INTO main.native_patient_directory_ownership(patient_id,pharmacy_id,actor_id,intent_sha256)
             VALUES(?,?,?,?)",
        )
        .bind(&request.request_id)
        .bind(pharmacy_id)
        .bind(actor_id)
        .bind(intent)
        .execute(&mut *tx)
        .await
        .map_err(|error| error.to_string())?;
        Ok(OwnedPatientReceipt { id: request.request_id })
    }
    .await;
    match result {
        Ok(receipt) => {
            tx.commit().await.map_err(|error| error.to_string())?;
            Ok(receipt)
        }
        Err(error) => {
            tx.rollback().await.map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn create_patient_owned_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: NewOwnedPatient,
) -> Result<OwnedPatientReceipt, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|error| error.to_string())?;
    create_owned_patient(
        &mut conn,
        actor.as_deref().ok_or("Login required to create a patient")?,
        payload,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    fn request(id: &str) -> NewOwnedPatient {
        NewOwnedPatient {
            request_id: id.into(),
            full_name: "Owned patient".into(),
            name_en: None,
            phone: Some("01012345678".into()),
            mobile: None,
            address: None,
            area: None,
            birth_date: None,
            gender: None,
            insurance_number: None,
            car_number: None,
            credit_limit: 200.0,
            opening_balance: 0.0,
            point_value: 1.0,
            customer_type: "individual".into(),
            payment_method: "cash".into(),
            notes: None,
        }
    }

    #[tokio::test]
    async fn create_and_replay_is_immutable_owned_and_cannot_claim_legacy_patient() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"CREATE TABLE users(id TEXT,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
            INSERT INTO users VALUES
              ('creator-a','pharmacist','{"can_view_patients":true}','tenant-a',1),
              ('creator-b','pharmacist','{"can_view_patients":true}','tenant-b',1),
              ('legacy-owner','owner','{}','local_default',1),
              ('blocked','cashier','{}','tenant-a',1);
            CREATE TABLE patients(
              id TEXT PRIMARY KEY,full_name TEXT,name_en TEXT,phone TEXT,mobile TEXT,address TEXT,
              area TEXT,birth_date TEXT,gender TEXT,insurance_number TEXT,car_number TEXT,
              credit_limit REAL,opening_balance REAL,points_balance REAL,point_value REAL,
              customer_type TEXT,payment_method TEXT,notes TEXT
            );
            INSERT INTO patients(id,full_name,phone) VALUES
              ('legacy-id-00000000','Legacy secret','01099999999');
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!("../../migrations/061_native_patient_directory_ownership.sql"))
            .execute(&mut conn)
            .await
            .unwrap();

        let id = "new-patient-0000001";
        assert_eq!(
            create_owned_patient(&mut conn, "creator-a", request(id))
                .await.unwrap().id,
            id
        );
        assert_eq!(
            create_owned_patient(&mut conn, "creator-a", request(id))
                .await.unwrap().id,
            id
        );
        let witness: (String, String, String) = sqlx::query_as(
            "SELECT pharmacy_id,actor_id,intent_sha256 FROM native_patient_directory_ownership WHERE patient_id=?",
        ).bind(id).fetch_one(&mut conn).await.unwrap();
        assert_eq!((&witness.0, &witness.1), (&"tenant-a".to_string(), &"creator-a".to_string()));
        assert_eq!(witness.2.len(), 64);
        let mut altered = request(id);
        altered.credit_limit = 9000.0;
        assert!(create_owned_patient(&mut conn, "creator-a", altered).await.is_err());
        assert!(create_owned_patient(&mut conn, "creator-b", request(id)).await.is_err());
        assert!(create_owned_patient(&mut conn, "blocked", request("blocked-patient-001")).await.is_err());
        assert!(create_owned_patient(&mut conn, "legacy-owner", request("legacy-patient-001")).await.is_err());
        assert!(create_owned_patient(&mut conn, "creator-a", request("legacy-id-00000000")).await.is_err());
        assert!(sqlx::query("UPDATE native_patient_directory_ownership SET pharmacy_id='tenant-b' WHERE patient_id=?")
            .bind(id).execute(&mut conn).await.is_err());
        assert!(sqlx::query("DELETE FROM native_patient_directory_ownership WHERE patient_id=?")
            .bind(id).execute(&mut conn).await.is_err());
        assert!(sqlx::query("DELETE FROM patients WHERE id=?")
            .bind(id).execute(&mut conn).await.is_err());
        let legacy: (String,) = sqlx::query_as("SELECT full_name FROM patients WHERE id='legacy-id-00000000'")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(legacy.0, "Legacy secret");
    }
}
