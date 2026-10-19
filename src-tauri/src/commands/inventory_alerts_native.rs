//! Inventory alert projection for the dashboard header. Unlike the legacy
//! renderer prepared SQL, every private inventory row is selected by a fixed
//! query after authenticating the actual native actor and explicit tenant.
//! No renderer SQL, pharmacy, actor, dates or permission claims are accepted.

use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{Connection, Row, SqliteConnection};
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

const MAX_ALERTS_PER_KIND: usize = 10;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryAlertsNative {
    actor_id: String,
    pharmacy_id: String,
    alerts: Vec<Value>,
    counts: AlertCounts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlertCounts {
    low_stock: usize,
    expiring: usize,
    expired: usize,
    total: usize,
}

fn alert_row(row: &sqlx::sqlite::SqliteRow, kind: &str) -> Result<Value, String> {
    let id: String = row
        .try_get::<String, _>("id")
        .map_err(|_| "Invalid inventory alert identity")?;
    let drug_id: i64 = row
        .try_get("drug_id")
        .map_err(|_| "Invalid inventory alert drug")?;
    let name: String = row
        .try_get("trade_name")
        .map_err(|_| "Invalid inventory alert name")?;
    let name_en: Option<String> = row
        .try_get("trade_name_en")
        .map_err(|_| "Invalid inventory alert name")?;
    let ingredient: Option<String> = row
        .try_get("active_ingredient")
        .map_err(|_| "Invalid inventory alert ingredient")?;
    let manufacturer: Option<String> = row
        .try_get("manufacturer")
        .map_err(|_| "Invalid inventory alert manufacturer")?;
    let quantity: Option<f64> = row
        .try_get("quantity")
        .map_err(|_| "Invalid inventory alert quantity")?;
    let expiry: Option<String> = row
        .try_get("expiry_date")
        .map_err(|_| "Invalid inventory alert date")?;
    if id.trim().is_empty()
        || id.len() > 128
        || drug_id <= 0
        || name.trim().is_empty()
        || name.len() > 512
        || name.chars().any(char::is_control)
        || [
            name_en.as_deref(),
            ingredient.as_deref(),
            manufacturer.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|text| text.len() > 1024 || text.chars().any(char::is_control))
        || quantity.is_some_and(|value| !value.is_finite() || !(0.0..=1e12).contains(&value))
        || (kind == "low_stock" && quantity.is_none())
        || (kind != "low_stock"
            && expiry.as_ref().map_or(true, |date| {
                date.len() != 10
                    || date.as_bytes()[4] != b'-'
                    || date.as_bytes()[7] != b'-'
                    || date
                        .bytes()
                        .enumerate()
                        .any(|(idx, ch)| idx != 4 && idx != 7 && !ch.is_ascii_digit())
            }))
    {
        return Err("Invalid or unverified native inventory alert source".into());
    }
    Ok(json!({
        "id":id,"drug_id":drug_id,"alert_type":kind,"quantity":quantity,
        "expiry_date":expiry,"trade_name":name,"trade_name_en":name_en,
        "active_ingredient":ingredient,"manufacturer":manufacturer,
    }))
}

async fn read_owned_alerts(
    conn: &mut SqliteConnection,
    actor_id: &str,
) -> Result<InventoryAlertsNative, String> {
    reset_cancelled_read_state(conn).await?;
    // One read snapshot prevents a stock change between the three kinds from
    // masquerading as a coherent UI summary. This transaction has no writes.
    let mut tx = conn.begin().await.map_err(|error| error.to_string())?;
    let result = async {
        let (role, pharmacy_id) = active_generic_actor(&mut tx, actor_id).await?;
        if pharmacy_id == "local_default" || pharmacy_id.trim().is_empty() {
            return Err("Inventory alerts require a verified explicit tenant".into());
        }
        let permission: Option<String> = sqlx::query_scalar(
            "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
        ).bind(actor_id).fetch_one(&mut *tx).await.map_err(|_| "Native inventory alert actor unavailable")?;
        if !user_has_permission(Some(&role), permission.as_deref(), "can_view_stores", false)
            && !user_has_permission(Some(&role), permission.as_deref(), "can_access_pos", true) {
            return Err("Native inventory alert permission denied".into());
        }

        // A corrupt or unowned lot is NOT assumed to have zero stock, so
        // prevent misleading healthy/low-stock summaries for the same tenant.
        let invalid: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.inventory i
             LEFT JOIN main.master_drugs m ON m.id=i.drug_id
             WHERE i.pharmacy_id=? AND (m.id IS NULL
               OR typeof(i.quantity) NOT IN ('integer','real')
               OR i.quantity<0 OR i.quantity>1000000000000
               OR (COALESCE(m.has_expiry,1)<>0 AND i.quantity>0 AND
                   (i.expiry_date IS NULL OR date(i.expiry_date) IS NULL)))",
        ).bind(&pharmacy_id).fetch_one(&mut *tx).await.map_err(|_| "Native inventory alert source scan unavailable")?;
        if invalid != 0 {
            return Err("Native inventory alerts contain unverifiable owned stock".into());
        }

        let low = sqlx::query(
            "SELECT CAST(m.id AS TEXT) id,m.id drug_id,
                 CAST(SUM(i.quantity) AS REAL) quantity,
                 NULL AS expiry_date,m.trade_name,m.trade_name_en,m.active_ingredient,m.manufacturer
             FROM main.inventory i JOIN main.master_drugs m ON m.id=i.drug_id
             WHERE i.pharmacy_id=? AND COALESCE(m.stop_dealing,0)=0
               AND (COALESCE(m.has_expiry,1)=0 OR i.expiry_date IS NOT NULL)
               AND (i.expiry_date IS NULL OR date(i.expiry_date)>=date('now','localtime'))
             GROUP BY m.id
             HAVING SUM(i.quantity)<=COALESCE(NULLIF(m.reorder_point,0),NULLIF(m.min_limit,0),10)
             ORDER BY SUM(i.quantity) ASC,m.id ASC LIMIT 10",
        ).bind(&pharmacy_id).fetch_all(&mut *tx).await.map_err(|_| "Native low-stock alerts unavailable")?;
        let expiring = sqlx::query(
            "SELECT CAST(i.id AS TEXT) id,i.drug_id,CAST(i.quantity AS REAL) quantity,
                 i.expiry_date,m.trade_name,m.trade_name_en,m.active_ingredient,m.manufacturer
             FROM main.inventory i JOIN main.master_drugs m ON m.id=i.drug_id
             WHERE i.pharmacy_id=? AND i.quantity>0 AND COALESCE(m.has_expiry,1)<>0
               AND date(i.expiry_date)>date('now','localtime')
               AND date(i.expiry_date)<=date('now','localtime','+3 months')
             ORDER BY i.expiry_date ASC,i.id ASC LIMIT 10",
        ).bind(&pharmacy_id).fetch_all(&mut *tx).await.map_err(|_| "Native expiry alerts unavailable")?;
        let expired = sqlx::query(
            "SELECT CAST(i.id AS TEXT) id,i.drug_id,CAST(i.quantity AS REAL) quantity,
                 i.expiry_date,m.trade_name,m.trade_name_en,m.active_ingredient,m.manufacturer
             FROM main.inventory i JOIN main.master_drugs m ON m.id=i.drug_id
             WHERE i.pharmacy_id=? AND i.quantity>0 AND COALESCE(m.has_expiry,1)<>0
               AND date(i.expiry_date)<=date('now','localtime')
             ORDER BY i.expiry_date ASC,i.id ASC LIMIT 10",
        ).bind(&pharmacy_id).fetch_all(&mut *tx).await.map_err(|_| "Native expired-stock alerts unavailable")?;
        if low.len() > MAX_ALERTS_PER_KIND || expiring.len() > MAX_ALERTS_PER_KIND || expired.len() > MAX_ALERTS_PER_KIND {
            return Err("Native inventory alerts exceeded fixed budget".into());
        }
        let counts = AlertCounts { low_stock:low.len(), expiring:expiring.len(), expired:expired.len(), total:low.len()+expiring.len()+expired.len() };
        let mut alerts = Vec::with_capacity(counts.total);
        for row in &expired { alerts.push(alert_row(row,"expired")?); }
        for row in &expiring { alerts.push(alert_row(row,"expiring")?); }
        for row in &low { alerts.push(alert_row(row,"low_stock")?); }
        Ok(InventoryAlertsNative { actor_id:actor_id.to_owned(),pharmacy_id,alerts,counts })
    }.await;
    match result {
        Ok(data) => {
            tx.commit()
                .await
                .map_err(|_| "Cannot finish native inventory alert read")?;
            Ok(data)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn read_inventory_alerts_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<InventoryAlertsNative, String> {
    let actor = session
        .authorize_session()
        .await?
        .clone()
        .ok_or_else(|| "Authenticated inventory alerts actor required".to_string())?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or_else(|| "Native database initialization is incomplete".to_string())?;
    let mut conn = pool
        .0
        .acquire()
        .await
        .map_err(|_| "Native inventory alert database unavailable")?;
    read_owned_alerts(&mut conn, &actor).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    async fn fixture() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users(id TEXT PRIMARY KEY,pharmacy_id TEXT,role TEXT,permissions TEXT,is_active INTEGER);
             CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,
               active_ingredient TEXT,manufacturer TEXT,has_expiry INTEGER,stop_dealing INTEGER,
               reorder_point REAL,min_limit REAL);
             CREATE TABLE inventory(id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
               quantity REAL,expiry_date TEXT);
             INSERT INTO users VALUES('a','tenant-a','owner','[]',1),('b','tenant-b','owner','[]',1),
              ('legacy','local_default','owner','[]',1),('clerk','tenant-a','cashier','[]',1);
             INSERT INTO master_drugs VALUES(1,'Owned One','Own',NULL,NULL,1,0,4,0),
               (2,'Other Two','Other',NULL,NULL,1,0,4,0),
               (3,'Expired Three','Old',NULL,NULL,1,0,4,0);
             INSERT INTO inventory VALUES('a1',1,'tenant-a',2,date('now','+2 years')),
               ('b1',2,'tenant-b',2,date('now','+2 years')),
               ('a3',3,'tenant-a',1,date('now','-2 days')),
               ('unowned',2,NULL,1,date('now','+1 day'));",
        ).execute(&mut db).await.unwrap();
        db
    }

    #[tokio::test]
    async fn tenant_owned_alerts_exclude_foreign_and_null_legacy_stock() {
        let mut conn = fixture().await;
        let own = read_owned_alerts(&mut conn, "a").await.unwrap();
        assert_eq!(own.pharmacy_id, "tenant-a");
        assert_eq!(own.counts.low_stock, 1);
        assert_eq!(own.counts.expired, 1);
        assert_eq!(own.counts.expiring, 0);
        assert_eq!(own.counts.total, 2);
        assert_eq!(own.alerts[0]["id"], "a3");
        assert_eq!(own.alerts[1]["id"], "1");
        assert_eq!(own.alerts[1]["quantity"], 2.0);
        let other = read_owned_alerts(&mut conn, "b").await.unwrap();
        assert_eq!(other.counts.total, 1);
        assert_eq!(other.alerts[0]["trade_name"], "Other Two");
        assert!(read_owned_alerts(&mut conn, "legacy").await.is_err());
    }

    #[tokio::test]
    async fn alert_reader_denies_unprivileged_and_invalid_sources_without_fabricated_zero() {
        let mut conn = fixture().await;
        assert!(read_owned_alerts(&mut conn, "clerk").await.is_err());
        sqlx::query("UPDATE inventory SET quantity=-1 WHERE id='a1'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(read_owned_alerts(&mut conn, "a").await.is_err());
        sqlx::query("UPDATE inventory SET quantity=2 WHERE id='a1'")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("UPDATE inventory SET drug_id=987654 WHERE id='a1'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(read_owned_alerts(&mut conn, "a").await.is_err());
    }
}
