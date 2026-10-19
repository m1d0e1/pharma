//! Fixed tenant-owned handover details and shift credit sales projections.
//! No renderer SQL, actor, tenant, permissions or arbitrary projection key.
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

const MAX_COMPONENT: f64 = 1_000_000_000_000.0;
const MAX_TOTAL: f64 = 1_000_000_000_000_000.0;
const MAX_CREDIT_ROWS: usize = 1000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoverDetailsInput {
    shift_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftCreditSalesInput {
    shift_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct HandoverDetails {
    id: String,
    user_id: String,
    start_time: Option<String>,
    end_time: Option<String>,
    status: Option<String>,
    starting_cash: f64,
    previous_transfers: f64,
    user_name: String,
    cash_sales: f64,
    visa_sales: f64,
    credit_sales: f64,
    returns: f64,
    receipts: f64,
    disbursements: f64,
    handover_movements: f64,
    transferred_so_far: f64,
    expected_cash: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeHandoverDetails {
    actor_id: String,
    pharmacy_id: String,
    data: HandoverDetails,
}

#[derive(Debug, Serialize)]
pub struct CreditSale {
    id: String,
    invoice_number: String,
    total_amount: f64,
    paid_amount: f64,
    credit_amount: f64,
    created_at: Option<String>,
    notes: Option<String>,
    // patients has no trusted tenant provenance in current schema.
    patient_id: Option<String>,
    patient_name: String,
    patient_phone: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeShiftCreditSales {
    actor_id: String,
    pharmacy_id: String,
    shift_id: Option<String>,
    rows: Vec<CreditSale>,
}

#[derive(Debug)]
struct ShiftRow {
    id: String,
    user_id: String,
    start_time: Option<String>,
    end_time: Option<String>,
    status: Option<String>,
    starting_cash: f64,
    previous_transfers: f64,
    user_name: String,
}

fn valid_shift_id(value: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > 128
        || value
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '\'' | '"' | ';') || ch as u32 == 96)
    {
        return Err("Invalid shift identifier".into());
    }
    Ok(())
}

fn finite_component(value: f64, label: &str) -> Result<f64, String> {
    if !value.is_finite() || value.abs() > MAX_COMPONENT {
        return Err(format!("Invalid or nonfinite {label}"));
    }
    Ok(value)
}

fn finite_total(value: f64, label: &str) -> Result<f64, String> {
    if !value.is_finite() || value.abs() > MAX_TOTAL {
        return Err(format!("Overflow or nonfinite {label}"));
    }
    Ok(value)
}

fn calculate_drawer(
    shift: ShiftRow,
    cash_sales: f64,
    visa_sales: f64,
    credit_sales: f64,
    returns: f64,
    receipts: f64,
    disbursements: f64,
    handover_movements: f64,
) -> Result<HandoverDetails, String> {
    let cash_sales = finite_total(cash_sales, "cash sales")?;
    let visa_sales = finite_total(visa_sales, "visa sales")?;
    let credit_sales = finite_total(credit_sales, "credit sales")?;
    let returns = finite_total(returns, "cash returns")?;
    let receipts = finite_total(receipts, "cash receipts")?;
    let disbursements = finite_total(disbursements, "cash disbursements")?;
    let handover_movements = finite_total(handover_movements, "handover movements")?;
    let transferred_so_far = finite_total(
        shift.previous_transfers.max(handover_movements),
        "transfers",
    )?;
    let unrecorded_transfers = (shift.previous_transfers - handover_movements).max(0.0);
    // Exact parity with drawer.ts; recorded handovers are already disbursements.
    let expected_cash = finite_total(
        shift.starting_cash + cash_sales + receipts
            - disbursements
            - returns
            - unrecorded_transfers,
        "expected cash",
    )?;
    Ok(HandoverDetails {
        id: shift.id,
        user_id: shift.user_id,
        start_time: shift.start_time,
        end_time: shift.end_time,
        status: shift.status,
        starting_cash: shift.starting_cash,
        previous_transfers: shift.previous_transfers,
        user_name: shift.user_name,
        cash_sales,
        visa_sales,
        credit_sales,
        returns,
        receipts,
        disbursements,
        handover_movements,
        transferred_so_far,
        expected_cash,
    })
}

async fn trusted_pharmacy(conn: &mut SqliteConnection, actor: &str) -> Result<String, String> {
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
        "acc_can_view_handover",
        false,
    ) {
        return Err("Authenticated role cannot view handover details".into());
    }
    Ok(pharmacy)
}

async fn shift_by_id(
    conn: &mut SqliteConnection,
    pharmacy: &str,
    shift_id: &str,
    open_only: bool,
) -> Result<ShiftRow, String> {
    valid_shift_id(shift_id)?;
    let row = sqlx::query(
        "SELECT s.id,s.user_id,s.start_time,s.end_time,s.status,
           CAST(COALESCE(s.starting_cash,0) AS REAL) AS starting_cash,
           CAST(COALESCE(s.transfer_amount,0) AS REAL) AS previous_transfers,
           typeof(s.starting_cash) AS starting_cash_storage,
           typeof(s.transfer_amount) AS transfer_storage,
           COALESCE((
             SELECT COALESCE(NULLIF(TRIM(u.full_name),''),u.username)
             FROM main.users u
             WHERE CAST(u.id AS TEXT)=CAST(s.user_id AS TEXT)
               AND COALESCE(NULLIF(TRIM(u.pharmacy_id),''),'local_default')=?
             LIMIT 1
           ), 'غير معروف') AS user_name
         FROM main.shifts s
         WHERE s.id=?
           AND COALESCE(NULLIF(TRIM(s.pharmacy_id),''),'local_default')=?
           AND (?=0 OR LOWER(COALESCE(s.status,''))='open') LIMIT 1",
    )
    .bind(pharmacy)
    .bind(shift_id)
    .bind(pharmacy)
    .bind(i64::from(open_only))
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or("Shift missing, closed or belongs to another pharmacy")?;
    for field in ["starting_cash_storage", "transfer_storage"] {
        let storage: String = row.try_get(field).map_err(|e| e.to_string())?;
        if !matches!(storage.as_str(), "null" | "integer" | "real") {
            return Err("Shift contains malformed cash amount storage".into());
        }
    }
    let opening: Option<f64> = row.try_get("starting_cash").map_err(|e| e.to_string())?;
    let previous: Option<f64> = row
        .try_get("previous_transfers")
        .map_err(|e| e.to_string())?;
    Ok(ShiftRow {
        id: row.try_get("id").map_err(|e| e.to_string())?,
        user_id: row.try_get("user_id").map_err(|e| e.to_string())?,
        start_time: row.try_get("start_time").map_err(|e| e.to_string())?,
        end_time: row.try_get("end_time").map_err(|e| e.to_string())?,
        status: row.try_get("status").map_err(|e| e.to_string())?,
        starting_cash: finite_component(opening.unwrap_or(0.0), "starting cash")?,
        previous_transfers: finite_component(previous.unwrap_or(0.0), "previous transfers")?,
        user_name: row.try_get("user_name").map_err(|e| e.to_string())?,
    })
}

async fn current_open_shift(
    conn: &mut SqliteConnection,
    pharmacy: &str,
) -> Result<Option<String>, String> {
    let shifts = sqlx::query_scalar::<_, String>(
        "SELECT id FROM main.shifts WHERE LOWER(COALESCE(status,''))='open'
         AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
         ORDER BY start_time DESC,id DESC LIMIT 2",
    )
    .bind(pharmacy)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if shifts.len() > 1 {
        return Err("Multiple open shifts in pharmacy; manual reconciliation required".into());
    }
    Ok(shifts.into_iter().next())
}

async fn read_handover(
    conn: &mut SqliteConnection,
    actor: &str,
    shift_id: &str,
) -> Result<NativeHandoverDetails, String> {
    valid_shift_id(shift_id)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> = Transaction::begin(conn, Some(Cow::Borrowed("BEGIN")))
        .await
        .map_err(|e| e.to_string())?;
    let result = async {
        let conn = &mut *tx;
        let pharmacy = trusted_pharmacy(conn, actor).await?;
        let shift = shift_by_id(conn, &pharmacy, shift_id, false).await?;
        let sales = sqlx::query(
            "SELECT
              CAST(COALESCE(SUM(CASE WHEN si.payment_method='cash'
                THEN CAST(COALESCE(si.total_amount,0) AS REAL) ELSE 0 END),0) AS REAL) cash_sales,
              CAST(COALESCE(SUM(CASE WHEN si.payment_method='visa'
                THEN CAST(COALESCE(si.total_amount,0) AS REAL) ELSE 0 END),0) AS REAL) visa_sales,
              CAST(COALESCE(SUM(CASE
                WHEN si.remaining_amount IS NOT NULL
                  AND CAST(si.remaining_amount AS REAL)>0
                  THEN CAST(si.remaining_amount AS REAL)
                WHEN si.payment_method='credit'
                  THEN MAX(CAST(COALESCE(si.total_amount,0) AS REAL) -
                    CAST(COALESCE(si.paid_amount,0) AS REAL),0)
                ELSE 0 END),0) AS REAL) credit_sales,
              COALESCE(SUM(CASE WHEN
                 (si.total_amount IS NOT NULL AND
                    (typeof(si.total_amount) NOT IN ('integer','real')
                     OR ABS(CAST(si.total_amount AS REAL))>1000000000000))
                 OR (si.paid_amount IS NOT NULL AND
                    (typeof(si.paid_amount) NOT IN ('integer','real')
                     OR ABS(CAST(si.paid_amount AS REAL))>1000000000000))
                 OR (si.remaining_amount IS NOT NULL AND
                    (typeof(si.remaining_amount) NOT IN ('integer','real')
                     OR ABS(CAST(si.remaining_amount AS REAL))>1000000000000))
                  THEN 1 ELSE 0 END),0) bad
             FROM main.sales_invoices si
             WHERE si.shift_id=?
               AND COALESCE(NULLIF(TRIM(si.pharmacy_id),''),'local_default')=?
               AND (si.status IS NULL OR si.status='' OR
                    si.status IN ('completed','approved'))",
        )
        .bind(shift_id)
        .bind(&pharmacy)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if sales.try_get::<i64, _>("bad").map_err(|e| e.to_string())? != 0 {
            return Err("Invalid sales amounts in handover shift".into());
        }
        let cash_sales = sales
            .try_get::<f64, _>("cash_sales")
            .map_err(|e| e.to_string())?;
        let visa_sales = sales
            .try_get::<f64, _>("visa_sales")
            .map_err(|e| e.to_string())?;
        let credit_sales = sales
            .try_get::<f64, _>("credit_sales")
            .map_err(|e| e.to_string())?;
        let returned = sqlx::query(
            "SELECT CAST(COALESCE(SUM(CAST(COALESCE(r.total_refund,0) AS REAL)),0) AS REAL) amount,
               COALESCE(SUM(CASE WHEN r.total_refund IS NOT NULL AND
                  (typeof(r.total_refund) NOT IN ('integer','real')
                   OR ABS(CAST(r.total_refund AS REAL))>1000000000000)
                  THEN 1 ELSE 0 END),0) bad
             FROM main.returns r WHERE r.shift_id=?
               AND COALESCE(NULLIF(TRIM(r.pharmacy_id),''),'local_default')=?
               AND r.refund_method='cash'
               AND (r.status IS NULL OR r.status='' OR
                 LOWER(r.status) IN ('approved','completed'))",
        )
        .bind(shift_id)
        .bind(&pharmacy)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if returned
            .try_get::<i64, _>("bad")
            .map_err(|e| e.to_string())?
            != 0
        {
            return Err("Invalid cash refund amounts in handover shift".into());
        }
        let returns = returned
            .try_get::<f64, _>("amount")
            .map_err(|e| e.to_string())?;
        let movement = sqlx::query(
            "SELECT
               CAST(COALESCE(SUM(CASE WHEN cm.type IN ('receipt','in')
                 THEN CAST(COALESCE(cm.amount,0) AS REAL) ELSE 0 END),0) AS REAL) receipts,
               CAST(COALESCE(SUM(CASE WHEN cm.type IN ('disbursement','out')
                 THEN CAST(COALESCE(cm.amount,0) AS REAL) ELSE 0 END),0) AS REAL) disbursements,
               CAST(COALESCE(SUM(CASE WHEN cm.type IN ('disbursement','out')
                 AND cm.category='handover'
                 THEN CAST(COALESCE(cm.amount,0) AS REAL) ELSE 0 END),0) AS REAL) handovers,
               COALESCE(SUM(CASE WHEN cm.amount IS NOT NULL AND
                 (typeof(cm.amount) NOT IN ('integer','real')
                  OR ABS(CAST(cm.amount AS REAL))>1000000000000)
                  THEN 1 ELSE 0 END),0) bad
             FROM main.cash_movements cm WHERE cm.shift_id=?
               AND COALESCE(NULLIF(TRIM(cm.pharmacy_id),''),'local_default')=?
               AND LOWER(COALESCE(cm.source_type,'')) <> 'main_safe'",
        )
        .bind(shift_id)
        .bind(&pharmacy)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if movement
            .try_get::<i64, _>("bad")
            .map_err(|e| e.to_string())?
            != 0
        {
            return Err("Invalid cash movement amounts in handover shift".into());
        }
        let details = calculate_drawer(
            shift,
            cash_sales,
            visa_sales,
            credit_sales,
            returns,
            movement.try_get("receipts").map_err(|e| e.to_string())?,
            movement
                .try_get("disbursements")
                .map_err(|e| e.to_string())?,
            movement.try_get("handovers").map_err(|e| e.to_string())?,
        )?;
        Ok(NativeHandoverDetails {
            actor_id: actor.into(),
            pharmacy_id: pharmacy,
            data: details,
        })
    }
    .await;
    match result {
        Ok(value) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(e) => Err(e),
    }
}

async fn read_credit_sales(
    conn: &mut SqliteConnection,
    actor: &str,
    requested_shift_id: Option<&str>,
) -> Result<NativeShiftCreditSales, String> {
    if let Some(id) = requested_shift_id {
        valid_shift_id(id)?;
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> = Transaction::begin(conn, Some(Cow::Borrowed("BEGIN")))
        .await
        .map_err(|e| e.to_string())?;
    let result = async {
        let conn = &mut *tx;
        let pharmacy = trusted_pharmacy(conn, actor).await?;
        let shift_id = match requested_shift_id {
            Some(id) => Some(shift_by_id(conn, &pharmacy, id, true).await?.id),
            None => current_open_shift(conn, &pharmacy).await?,
        };
        let mut sales = Vec::new();
        if let Some(id) = shift_id.as_deref() {
            // Fail explicitly if more than 1000: never silently truncate.
            let rows = sqlx::query(
                "SELECT si.id,
                    CAST(si.total_amount AS REAL) AS total_amount,
                    CAST(si.paid_amount AS REAL) AS paid_amount,
                    CAST(si.remaining_amount AS REAL) AS remaining_amount,
                    typeof(si.total_amount) AS total_storage,
                    typeof(si.paid_amount) AS paid_storage,
                    typeof(si.remaining_amount) AS remaining_storage,
                    si.created_at,si.check_number,si.payment_method
                 FROM main.sales_invoices si WHERE si.shift_id=?
                   AND COALESCE(NULLIF(TRIM(si.pharmacy_id),''),'local_default')=?
                   AND (si.payment_method='credit' OR
                     (si.remaining_amount IS NOT NULL AND
                      CAST(si.remaining_amount AS REAL)>0))
                   AND (si.status IS NULL OR si.status='' OR
                       si.status IN ('completed','approved'))
                 ORDER BY si.created_at DESC,si.id DESC LIMIT 1001",
            )
            .bind(id)
            .bind(&pharmacy)
            .fetch_all(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
            if rows.len() > MAX_CREDIT_ROWS {
                return Err("Shift credit sales exceed 1000 invoices; narrow or export".into());
            }
            sales.reserve(rows.len());
            for row in rows {
                for field in ["total_storage", "paid_storage", "remaining_storage"] {
                    let kind: String = row.try_get(field).map_err(|e| e.to_string())?;
                    if !matches!(kind.as_str(), "null" | "integer" | "real") {
                        return Err("Credit invoice contains malformed numeric storage".into());
                    }
                }
                let invoice_id: String = row.try_get("id").map_err(|e| e.to_string())?;
                let total_amount = finite_component(
                    row.try_get::<Option<f64>, _>("total_amount")
                        .map_err(|e| e.to_string())?
                        .unwrap_or(0.0),
                    "credit invoice total",
                )?;
                let paid_amount = finite_component(
                    row.try_get::<Option<f64>, _>("paid_amount")
                        .map_err(|e| e.to_string())?
                        .unwrap_or(0.0),
                    "credit invoice paid",
                )?;
                let remaining = row
                    .try_get::<Option<f64>, _>("remaining_amount")
                    .map_err(|e| e.to_string())?
                    .map(|value| finite_component(value, "credit invoice remaining"))
                    .transpose()?;
                let payment: Option<String> =
                    row.try_get("payment_method").map_err(|e| e.to_string())?;
                let outstanding = if remaining.is_some_and(|v| v > 0.0) {
                    remaining.unwrap_or(0.0)
                } else if payment.as_deref() == Some("credit") {
                    (total_amount - paid_amount).max(0.0)
                } else {
                    0.0
                };
                sales.push(CreditSale {
                    invoice_number: invoice_id.clone(),
                    id: invoice_id,
                    total_amount,
                    paid_amount,
                    credit_amount: finite_component(outstanding, "outstanding credit")?,
                    created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
                    notes: row.try_get("check_number").map_err(|e| e.to_string())?,
                    patient_id: None,
                    patient_name: "عميل آجل".into(),
                    patient_phone: None,
                });
            }
        }
        Ok(NativeShiftCreditSales {
            actor_id: actor.into(),
            pharmacy_id: pharmacy,
            shift_id,
            rows: sales,
        })
    }
    .await;
    match result {
        Ok(value) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn get_handover_details_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: HandoverDetailsInput,
) -> Result<NativeHandoverDetails, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    read_handover(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        &payload.shift_id,
    )
    .await
}

#[tauri::command]
pub async fn get_shift_credit_sales_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: ShiftCreditSalesInput,
) -> Result<NativeShiftCreditSales, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    read_credit_sales(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload.shift_id.as_deref(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users(
                id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,is_active INTEGER,
                permissions TEXT, username TEXT,full_name TEXT
            );
            INSERT INTO users VALUES
              ('staff-a','cashier','A',1,'{"acc_can_view_handover":true}','staffa','Actor A'),
              ('staff-b','cashier','B',1,'{"acc_can_view_handover":true}','staffb','Actor B'),
              ('owner-a','owner','A',1,'{}','ownera','Owner A'),
              ('owner-b','owner','B',1,'{}','ownerb','Owner B'),
              ('denied-a','cashier','A',1,'{"acc_can_view_handover":false}','denied','Denied'),
              ('disabled-a','owner','A',0,'{}','disabled','Disabled'),
              ('no-permission','cashier','A',1,NULL,'unknown','Unknown');
            CREATE TABLE shifts(
                id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,
                start_time TEXT,end_time TEXT,status TEXT,starting_cash REAL,
                transfer_amount REAL
            );
            INSERT INTO shifts VALUES
              ('shift-a','staff-a','A','2026-10-10 08:00',NULL,'open',100,30),
              ('shift-b','staff-b','B','2026-10-10 09:00',NULL,'open',500,0),
              ('closed-a','staff-a','A','2026-10-09 08:00','2026-10-09 17:00','closed',20,0);
            CREATE TABLE sales_invoices(
                id TEXT PRIMARY KEY,shift_id TEXT,pharmacy_id TEXT,
                status TEXT,payment_method TEXT,total_amount REAL,paid_amount REAL,
                remaining_amount REAL,created_at TEXT,check_number TEXT,patient_id TEXT
            );
            INSERT INTO sales_invoices VALUES
              ('cash-a','shift-a','A','completed','cash',50,50,0,'2026-10-10 08:05',NULL,NULL),
              ('visa-a','shift-a','A','approved','visa',120,120,0,'2026-10-10 08:06',NULL,NULL),
              ('credit-a','shift-a','A','completed','credit',100,40,60,'2026-10-10 08:07','memo','patient-b'),
              ('partial-a','shift-a','A','completed','visa',20,0,20,'2026-10-10 08:08',NULL,'patient-b'),
              ('void-a','shift-a','A','cancelled','credit',999,0,999,'2026-10-10 08:09',NULL,NULL),
              ('cash-wrong-tenant','shift-a','B','completed','cash',800,800,0,'2026-10-10 08:10',NULL,NULL),
              ('credit-wrong-tenant','shift-a','B','completed','credit',900,0,900,'2026-10-10 08:11',NULL,NULL),
              ('credit-b','shift-b','B','completed','credit',50,10,40,'2026-10-10 09:10',NULL,NULL);
            CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT,phone TEXT);
            INSERT INTO patients VALUES('patient-b','PRIVATE B NAME','PRIVATE B PHONE');
            CREATE TABLE returns(
                id TEXT PRIMARY KEY,shift_id TEXT,pharmacy_id TEXT,total_refund REAL,
                status TEXT,refund_method TEXT
            );
            INSERT INTO returns VALUES
              ('r-a','shift-a','A',10,'approved','cash'),
              ('r-visa','shift-a','A',900,'approved','visa'),
              ('r-void','shift-a','A',500,'pending','cash'),
              ('r-foreign','shift-a','B',750,'approved','cash');
            CREATE TABLE cash_movements(
                id TEXT PRIMARY KEY,shift_id TEXT,pharmacy_id TEXT,amount REAL,
                type TEXT,source_type TEXT,category TEXT
            );
            INSERT INTO cash_movements VALUES
              ('receipt-a','shift-a','A',15,'receipt',NULL,'collection'),
              ('disbursement-a','shift-a','A',9,'out',NULL,'personal'),
              ('handover-a','shift-a','A',5,'disbursement','user_drawer','handover'),
              ('main-safe','shift-a','A',600,'out','main_safe','handover'),
              ('receipt-foreign','shift-a','B',990,'receipt',NULL,'collection');
            "#,
        ).execute(&mut conn).await.unwrap();
        conn
    }

    #[test]
    fn strict_no_renderer_sql_actor_tenant_selectors_and_shift_id_validation() {
        assert!(serde_json::from_value::<HandoverDetailsInput>(
            serde_json::json!({"shiftId":"shift-a"})
        )
        .is_ok());
        for field in ["actorId", "pharmacyId", "sql", "userId", "projection"] {
            let mut value = serde_json::json!({"shiftId":"shift-a"});
            value[field] = serde_json::json!("arbitrary");
            assert!(
                serde_json::from_value::<HandoverDetailsInput>(value).is_err(),
                "{field}"
            );
        }
        assert!(serde_json::from_value::<ShiftCreditSalesInput>(
            serde_json::json!({"shiftId":null})
        )
        .is_ok());
        for id in [
            "",
            "  ",
            "x;DROP TABLE users",
            "s\nx",
            "' OR 1=1",
            "shift-a\u{0060}",
        ] {
            assert!(valid_shift_id(id).is_err(), "id: {id}");
        }
    }

    #[tokio::test]
    async fn handover_matches_legacy_drawer_formula_with_tenant_scoped_components() {
        let mut conn = fixture().await;
        let read = read_handover(&mut conn, "staff-a", "shift-a")
            .await
            .unwrap();
        assert_eq!(read.actor_id, "staff-a");
        assert_eq!(read.pharmacy_id, "A");
        let details = read.data;
        assert_eq!(details.id, "shift-a");
        assert_eq!(details.user_name, "Actor A");
        assert_eq!(details.starting_cash, 100.0);
        assert_eq!(details.previous_transfers, 30.0);
        assert_eq!(details.cash_sales, 50.0);
        assert_eq!(details.visa_sales, 140.0);
        assert_eq!(details.credit_sales, 80.0);
        assert_eq!(details.returns, 10.0);
        assert_eq!(details.receipts, 15.0);
        assert_eq!(details.disbursements, 14.0);
        assert_eq!(details.handover_movements, 5.0);
        assert_eq!(details.transferred_so_far, 30.0);
        assert_eq!(details.expected_cash, 116.0);
        let serialized = serde_json::to_value(&details).unwrap();
        for name in [
            "id",
            "start_time",
            "previous_transfers",
            "user_name",
            "visa_sales",
            "credit_sales",
            "returns",
            "receipts",
            "disbursements",
            "handover_movements",
            "transferred_so_far",
            "expected_cash",
        ] {
            assert!(serialized.get(name).is_some(), "missing {name}");
        }
        let closed = read_handover(&mut conn, "owner-a", "closed-a")
            .await
            .unwrap();
        assert_eq!(closed.data.expected_cash, 20.0);
    }

    #[tokio::test]
    async fn tenant_scope_denial_disabled_role_change_reassignment_and_shift_owner_leak() {
        let mut conn = fixture().await;
        for actor in ["denied-a", "disabled-a", "no-permission", "ghost"] {
            assert!(
                read_handover(&mut conn, actor, "shift-a").await.is_err(),
                "{actor}"
            );
            assert!(
                read_credit_sales(&mut conn, actor, Some("shift-a"))
                    .await
                    .is_err(),
                "{actor}"
            );
        }
        assert!(read_handover(&mut conn, "staff-a", "shift-b")
            .await
            .is_err());
        assert!(read_credit_sales(&mut conn, "staff-a", Some("shift-b"))
            .await
            .is_err());
        assert!(read_credit_sales(&mut conn, "staff-a", Some("closed-a"))
            .await
            .is_err());
        conn.execute("UPDATE users SET role='cashier', permissions='{}' WHERE id='staff-a'")
            .await
            .unwrap();
        assert!(read_handover(&mut conn, "staff-a", "shift-a")
            .await
            .is_err());
        conn.execute("UPDATE users SET permissions='{\"acc_can_view_handover\":true}', pharmacy_id='B' WHERE id='staff-a'")
            .await.unwrap();
        assert!(read_handover(&mut conn, "staff-a", "shift-a")
            .await
            .is_err());
        let b = read_handover(&mut conn, "staff-a", "shift-b")
            .await
            .unwrap();
        assert_eq!(b.pharmacy_id, "B");
        // A reassigned shift owner from B is not a trusted A display name.
        let a = read_handover(&mut conn, "owner-a", "shift-a")
            .await
            .unwrap();
        assert_eq!(a.data.user_name, "غير معروف");
        conn.execute("UPDATE users SET is_active=0 WHERE id='staff-a'")
            .await
            .unwrap();
        assert!(read_handover(&mut conn, "staff-a", "shift-b")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn shift_credit_sales_scopes_invoice_branch_and_redacts_unowned_patient() {
        let mut conn = fixture().await;
        let result = read_credit_sales(&mut conn, "staff-a", Some("shift-a"))
            .await
            .unwrap();
        assert_eq!(result.actor_id, "staff-a");
        assert_eq!(result.pharmacy_id, "A");
        assert_eq!(result.shift_id.as_deref(), Some("shift-a"));
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0].id, "partial-a");
        assert_eq!(result.rows[0].credit_amount, 20.0);
        assert_eq!(result.rows[1].id, "credit-a");
        assert_eq!(result.rows[1].credit_amount, 60.0);
        assert_eq!(result.rows[1].invoice_number, "credit-a");
        assert_eq!(result.rows[1].notes.as_deref(), Some("memo"));
        for invoice in result.rows {
            assert_eq!(invoice.patient_id, None);
            assert_eq!(invoice.patient_name, "عميل آجل");
            assert_eq!(invoice.patient_phone, None);
            let view = serde_json::to_string(&invoice).unwrap();
            assert!(!view.contains("PRIVATE B NAME"));
            assert!(!view.contains("PRIVATE B PHONE"));
            assert!(!view.contains("patient-b"));
        }
        let b = read_credit_sales(&mut conn, "owner-b", Some("shift-b"))
            .await
            .unwrap();
        assert_eq!(b.rows.len(), 1);
        assert_eq!(b.rows[0].credit_amount, 40.0);
        assert_eq!(
            read_credit_sales(&mut conn, "owner-a", None)
                .await
                .unwrap()
                .rows
                .len(),
            2
        );
        conn.execute("UPDATE shifts SET status='closed' WHERE id='shift-a'")
            .await
            .unwrap();
        assert!(read_credit_sales(&mut conn, "owner-a", None)
            .await
            .unwrap()
            .rows
            .is_empty());
    }

    #[tokio::test]
    async fn rejects_nonfinite_and_non_numeric_shift_components_without_cross_tenant_poison() {
        let mut conn = fixture().await;
        sqlx::query("UPDATE sales_invoices SET total_amount=? WHERE id='cash-wrong-tenant'")
            .bind(f64::INFINITY)
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(read_handover(&mut conn, "owner-a", "shift-a").await.is_ok());
        let bad_sales = [
            ("cash-a", "total_amount"),
            ("credit-a", "paid_amount"),
            ("credit-a", "remaining_amount"),
        ];
        for (invoice, column) in bad_sales {
            let sql = match column {
                "total_amount" => "UPDATE sales_invoices SET total_amount=? WHERE id=?",
                "paid_amount" => "UPDATE sales_invoices SET paid_amount=? WHERE id=?",
                "remaining_amount" => "UPDATE sales_invoices SET remaining_amount=? WHERE id=?",
                _ => unreachable!(),
            };
            sqlx::query(sql)
                .bind(f64::INFINITY)
                .bind(invoice)
                .execute(&mut conn)
                .await
                .unwrap();
            assert!(
                read_handover(&mut conn, "owner-a", "shift-a")
                    .await
                    .is_err(),
                "{column}"
            );
            sqlx::query(sql)
                .bind(1.0_f64)
                .bind(invoice)
                .execute(&mut conn)
                .await
                .unwrap();
        }
        conn.execute("UPDATE shifts SET starting_cash=1e309 WHERE id='shift-a'")
            .await
            .unwrap();
        assert!(read_handover(&mut conn, "owner-a", "shift-a")
            .await
            .is_err());
        conn.execute("UPDATE shifts SET starting_cash=100,transfer_amount=0 WHERE id='shift-a'")
            .await
            .unwrap();
        conn.execute("UPDATE cash_movements SET amount=1e309 WHERE id='receipt-a'")
            .await
            .unwrap();
        assert!(read_handover(&mut conn, "owner-a", "shift-a")
            .await
            .is_err());
        conn.execute("UPDATE cash_movements SET amount=15 WHERE id='receipt-a'")
            .await
            .unwrap();
        conn.execute("UPDATE returns SET total_refund=1e309 WHERE id='r-a'")
            .await
            .unwrap();
        assert!(read_handover(&mut conn, "owner-a", "shift-a")
            .await
            .is_err());
        conn.execute("UPDATE returns SET total_refund=10 WHERE id='r-a'")
            .await
            .unwrap();
        conn.execute("UPDATE sales_invoices SET paid_amount='malformed' WHERE id='credit-a'")
            .await
            .unwrap();
        assert!(read_handover(&mut conn, "owner-a", "shift-a")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn credit_invoice_amount_validation_rejects_nonfinite_and_overflow() {
        let mut conn = fixture().await;
        sqlx::query("UPDATE sales_invoices SET paid_amount=? WHERE id='credit-a'")
            .bind(f64::INFINITY)
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(read_credit_sales(&mut conn, "owner-a", Some("shift-a"))
            .await
            .is_err());
        conn.execute("UPDATE sales_invoices SET paid_amount=0 WHERE id='credit-a'")
            .await
            .unwrap();
        conn.execute("UPDATE sales_invoices SET total_amount=1e309 WHERE id='credit-a'")
            .await
            .unwrap();
        assert!(read_credit_sales(&mut conn, "owner-a", Some("shift-a"))
            .await
            .is_err());
        assert!(calculate_drawer(
            ShiftRow {
                id: "s".into(),
                user_id: "u".into(),
                start_time: None,
                end_time: None,
                status: None,
                starting_cash: 1e12,
                previous_transfers: 0.0,
                user_name: "u".into(),
            },
            1e15,
            0.0,
            0.0,
            0.0,
            1e15,
            0.0,
            0.0,
        )
        .is_err());
    }

    #[tokio::test]
    async fn exactly_1000_credit_invoices_allowed_but_1001_explicitly_fail() {
        let mut conn = fixture().await;
        conn.execute("DELETE FROM sales_invoices WHERE shift_id='shift-a' AND pharmacy_id='A'")
            .await
            .unwrap();
        conn.execute(
            "WITH RECURSIVE batch(n) AS (
               SELECT 0 UNION ALL SELECT n+1 FROM batch WHERE n<999
             )
             INSERT INTO sales_invoices(
               id,shift_id,pharmacy_id,status,payment_method,total_amount,paid_amount,
               remaining_amount,created_at
             )
             SELECT printf('credit-%04d',n),'shift-a','A','completed','credit',1,0,1,
                 '2026-10-11 09:00' FROM batch",
        )
        .await
        .unwrap();
        assert_eq!(
            read_credit_sales(&mut conn, "owner-a", Some("shift-a"))
                .await
                .unwrap()
                .rows
                .len(),
            1000
        );
        conn.execute(
            "INSERT INTO sales_invoices(id,shift_id,pharmacy_id,status,payment_method,total_amount,paid_amount)
             VALUES('overflow-credit','shift-a','A','completed','credit',1,0)",
        ).await.unwrap();
        let err = read_credit_sales(&mut conn, "owner-a", Some("shift-a"))
            .await
            .unwrap_err();
        assert!(err.contains("1000"), "{err}");
        // Same-shift foreign-tenant records cannot cause local truncation.
        conn.execute("DELETE FROM sales_invoices WHERE id='overflow-credit'")
            .await
            .unwrap();
        conn.execute(
            "INSERT INTO sales_invoices(id,shift_id,pharmacy_id,status,payment_method,total_amount)
             VALUES('foreign-large','shift-a','B','completed','credit',1)",
        )
        .await
        .unwrap();
        assert_eq!(
            read_credit_sales(&mut conn, "owner-a", Some("shift-a"))
                .await
                .unwrap()
                .rows
                .len(),
            1000
        );
    }

    #[tokio::test]
    async fn aggregate_sum_overflow_fails_not_infinity_or_silent_saturation() {
        let mut conn = fixture().await;
        conn.execute("DELETE FROM sales_invoices WHERE shift_id='shift-a' AND pharmacy_id='A'")
            .await
            .unwrap();
        conn.execute(
            "WITH RECURSIVE batch(n) AS (
               SELECT 0 UNION ALL SELECT n+1 FROM batch WHERE n<1100
             )
             INSERT INTO sales_invoices(id,shift_id,pharmacy_id,status,payment_method,total_amount)
             SELECT printf('huge-%04d',n),'shift-a','A','completed','cash',1000000000000.0 FROM batch",
        ).await.unwrap();
        let err = read_handover(&mut conn, "owner-a", "shift-a")
            .await
            .unwrap_err();
        assert!(
            err.to_lowercase().contains("overflow") || err.to_lowercase().contains("nonfinite"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn no_open_shift_or_duplicate_open_shifts_do_not_create_shifts_or_disclose_foreign_rows()
    {
        let mut conn = fixture().await;
        conn.execute("UPDATE shifts SET status='closed' WHERE id='shift-a'")
            .await
            .unwrap();
        let absent = read_credit_sales(&mut conn, "owner-a", None).await.unwrap();
        assert_eq!(absent.shift_id, None);
        assert!(absent.rows.is_empty());
        conn.execute("UPDATE shifts SET status='open' WHERE id='shift-a'")
            .await
            .unwrap();
        conn.execute(
            "INSERT INTO shifts(id,user_id,pharmacy_id,status,starting_cash,start_time)
             VALUES('second-a','staff-a','A','open',0,'2026-10-11 10:00')",
        )
        .await
        .unwrap();
        assert!(read_credit_sales(&mut conn, "owner-a", None).await.is_err());
        assert_eq!(
            read_credit_sales(&mut conn, "owner-b", None)
                .await
                .unwrap()
                .shift_id
                .as_deref(),
            Some("shift-b")
        );
    }
}
