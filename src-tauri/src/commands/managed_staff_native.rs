//! Owner-managed staff deactivation and sole-drawer closure. The native
//! authenticated actor is authoritative; only scalar IDs and cash intent come
//! from the renderer. Never open a successor shift during managed closure.
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::{verify_handover_password_on_connection, LocalSessionState};
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;

const MAX_CASH: f64 = 1_000_000_000_000.0;
const AUDIT_CREATE: &str = "CLOSE_USER_SHIFT_AND_DEACTIVATE";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedCloseInput {
    user_id: String,
    shift_id: String,
    actual_cash: f64,
    authorizer_password: String,
    notes: Option<String>,
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeactivateStaffInput {
    user_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCloseResult {
    success: bool,
    user_id: String,
    shift_id: String,
    actual_cash: f64,
    difference: f64,
    status: String,
}

#[derive(Debug, Serialize)]
pub struct ManagedOpenShift {
    id: String,
    start_time: Option<String>,
    expected_cash: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeactivateStaffResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    open_shift: Option<ManagedOpenShift>,
}

fn valid_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 128
        && value == value.trim()
        && !value
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '\'' | '"' | ';') || ch as u32 == 96)
}

fn valid_notes(notes: Option<&str>) -> bool {
    notes.map_or(true, |notes| {
        notes.len() <= 2000
            && !notes
                .chars()
                .any(|ch| ch == '\0' || (ch.is_control() && ch != '\n'))
    })
}

fn cents(value: f64) -> bool {
    value.is_finite()
        && value.abs() <= MAX_CASH
        && (value * 100.0 - (value * 100.0).round()).abs() <= 0.000_01
}

fn validate_close(input: &ManagedCloseInput) -> Result<(), String> {
    let nonce = Uuid::parse_str(&input.request_id)
        .map_err(|_| "Managed closure requires a canonical UUID-v4 requestId")?;
    if !valid_id(&input.user_id)
        || !valid_id(&input.shift_id)
        || !valid_notes(input.notes.as_deref())
        || input.authorizer_password.is_empty()
        || input.authorizer_password.trim().is_empty()
        || nonce.get_version_num() != 4
        || nonce.to_string() != input.request_id
        || !cents(input.actual_cash)
        || input.actual_cash < 0.0
    {
        return Err("Invalid owner-managed staff closure request".into());
    }
    Ok(())
}

fn validation_target(target: &str, actor: &str) -> Result<(), String> {
    if !valid_id(target) || target == actor {
        return Err("Invalid or self-selected target user".into());
    }
    Ok(())
}

async fn active_owner(conn: &mut SqliteConnection, actor: &str) -> Result<String, String> {
    let (role, pharmacy) = active_generic_actor(conn, actor).await?;
    if !role.trim().eq_ignore_ascii_case("owner") {
        return Err("Only an active authenticated pharmacy owner may deactivate staff".into());
    }
    Ok(pharmacy)
}

async fn verified_target(
    conn: &mut SqliteConnection,
    actor: &str,
    target: &str,
    pharmacy: &str,
) -> Result<(), String> {
    validation_target(target, actor)?;
    let target_row = sqlx::query(
        "SELECT role,username FROM main.users WHERE CAST(id AS TEXT)=?
         AND COALESCE(is_active,1)=1
         AND pharmacy_id IS NOT NULL AND TRIM(pharmacy_id)<>''
         AND TRIM(pharmacy_id)=? LIMIT 1",
    )
    .bind(target)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let target_row = target_row.ok_or("Target staff not active or belongs to another pharmacy")?;
    let role: Option<String> = target_row.try_get("role").map_err(|e| e.to_string())?;
    let username: Option<String> = target_row.try_get("username").map_err(|e| e.to_string())?;
    let role = role.ok_or("Target staff has an invalid role")?;
    // A user may have been reassigned while their immutable old-branch shift
    // remains open. Never disable the account and strand that foreign drawer.
    let foreign_open: Option<String> = sqlx::query_scalar(
        "SELECT id FROM main.shifts
         WHERE CAST(user_id AS TEXT)=?
           AND LOWER(COALESCE(status,''))='open'
           AND (pharmacy_id IS NULL OR TRIM(pharmacy_id)='' OR TRIM(pharmacy_id)<>?)
         LIMIT 1",
    )
    .bind(target)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if foreign_open.is_some() {
        return Err("Target has an unresolved foreign or unowned open shift".into());
    }
    // Old shift.user_id values may contain a username instead of immutable
    // users.id. Even if the row appears in this pharmacy, attribution through
    // an alias is not sufficiently reliable for irreversible deactivation.
    if let Some(username) = username.filter(|name| !name.trim().is_empty()) {
        let legacy: Option<String> = sqlx::query_scalar(
            "SELECT id FROM main.shifts WHERE LOWER(COALESCE(status,''))='open'
             AND LOWER(CAST(user_id AS TEXT))=LOWER(?) AND CAST(user_id AS TEXT)<>?
             LIMIT 1",
        )
        .bind(username.trim())
        .bind(target)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if legacy.is_some() {
            return Err("Legacy username-linked open shift requires manual reconciliation".into());
        }
    }
    if role.eq_ignore_ascii_case("owner") {
        let other_owners: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.users WHERE COALESCE(is_active,1)=1
             AND LOWER(TRIM(COALESCE(role,'')))='owner'
             AND TRIM(COALESCE(pharmacy_id,''))=?
             AND CAST(id AS TEXT)<>?",
        )
        .bind(pharmacy)
        .bind(target)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if other_owners < 1 {
            return Err("Cannot deactivate the last active owner of a pharmacy".into());
        }
    }
    Ok(())
}

#[derive(Debug)]
struct OpenShift {
    id: String,
    user_id: String,
    start_time: Option<String>,
    starting_cash: f64,
}

async fn open_shifts(
    conn: &mut SqliteConnection,
    pharmacy: &str,
) -> Result<Vec<OpenShift>, String> {
    let rows = sqlx::query(
        "SELECT id,CAST(user_id AS TEXT) user_id,start_time,
            CAST(starting_cash AS REAL) starting_cash,
            typeof(starting_cash) opening_kind, pharmacy_id,
            CAST(transfer_amount AS REAL) transfer_amount,
            typeof(transfer_amount) prior_kind
         FROM main.shifts
         WHERE LOWER(COALESCE(status,''))='open'
           AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
         ORDER BY start_time,id LIMIT 2",
    )
    .bind(pharmacy)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let mut shifts = Vec::with_capacity(rows.len());
    for row in rows {
        let raw_tenant: Option<String> = row.try_get("pharmacy_id").map_err(|e| e.to_string())?;
        let tenant = raw_tenant.ok_or("Unowned open shift requires manual reconciliation")?;
        if tenant.trim().is_empty() || tenant.trim() != pharmacy {
            return Err("Unowned or foreign open shift cannot be closed".into());
        }
        for key in ["opening_kind", "prior_kind"] {
            let kind: String = row.try_get(key).map_err(|e| e.to_string())?;
            if !matches!(kind.as_str(), "null" | "integer" | "real") {
                return Err("Malformed open shift cash storage".into());
            }
        }
        let prior: Option<f64> = row.try_get("transfer_amount").map_err(|e| e.to_string())?;
        if prior.is_some_and(|value| !cents(value) || value.abs() > 0.005) {
            return Err("Open shift has unresolved legacy transfers".into());
        }
        let starting: Option<f64> = row.try_get("starting_cash").map_err(|e| e.to_string())?;
        let starting = starting.unwrap_or(0.0);
        if !cents(starting) || starting < 0.0 {
            return Err("Invalid open shift starting cash".into());
        }
        shifts.push(OpenShift {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            user_id: row.try_get("user_id").map_err(|e| e.to_string())?,
            start_time: row.try_get("start_time").map_err(|e| e.to_string())?,
            starting_cash: starting,
        });
    }
    Ok(shifts)
}

// Use explicitly typed source verification for the entire shift, not only
// completed rows: foreign or orphaned links must block owner deactivation.
async fn validate_history(
    conn: &mut SqliteConnection,
    shift: &str,
    pharmacy: &str,
) -> Result<(), String> {
    let foreign: i64 = sqlx::query_scalar(
        "SELECT
           (SELECT COUNT(*) FROM main.sales_invoices WHERE shift_id=?
               AND (pharmacy_id IS NULL OR TRIM(pharmacy_id)='' OR TRIM(pharmacy_id)<>?))
         + (SELECT COUNT(*) FROM main.returns WHERE shift_id=?
               AND (pharmacy_id IS NULL OR TRIM(pharmacy_id)='' OR TRIM(pharmacy_id)<>?))
         + (SELECT COUNT(*) FROM main.cash_movements WHERE shift_id=?
               AND (pharmacy_id IS NULL OR TRIM(pharmacy_id)='' OR TRIM(pharmacy_id)<>?))",
    )
    .bind(shift)
    .bind(pharmacy)
    .bind(shift)
    .bind(pharmacy)
    .bind(shift)
    .bind(pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if foreign != 0 {
        return Err("Shift has foreign or unowned accounting history".into());
    }
    let invalid: i64 = sqlx::query_scalar(
        "SELECT
           (SELECT COUNT(*) FROM main.sales_invoices WHERE shift_id=?
             AND payment_method='cash'
             AND (total_amount IS NULL OR typeof(total_amount) NOT IN ('real','integer')
                  OR NOT(total_amount BETWEEN 0 AND 1000000000000)))
         + (SELECT COUNT(*) FROM main.returns WHERE shift_id=?
             AND refund_method='cash'
             AND (total_refund IS NULL OR typeof(total_refund) NOT IN ('real','integer')
                  OR NOT(total_refund BETWEEN 0 AND 1000000000000)))
         + (SELECT COUNT(*) FROM main.cash_movements WHERE shift_id=?
             AND (type NOT IN ('receipt','in','disbursement','out') OR amount IS NULL
                  OR typeof(amount) NOT IN ('real','integer')
                  OR NOT(amount BETWEEN 0 AND 1000000000000)))",
    )
    .bind(shift)
    .bind(shift)
    .bind(shift)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if invalid != 0 {
        return Err("Malformed accounting source prevents automatic staff closure".into());
    }
    Ok(())
}

async fn checked_history(
    conn: &mut SqliteConnection,
    query: &'static str,
    shift: &str,
    pharmacy: &str,
) -> Result<f64, String> {
    let value: f64 = sqlx::query_scalar(query)
        .bind(shift)
        .bind(pharmacy)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    if !cents(value) {
        return Err("Nonfinite, fractional-cent or overflowed shift history".into());
    }
    Ok(value)
}

async fn reconcile(
    conn: &mut SqliteConnection,
    shift: &OpenShift,
    pharmacy: &str,
) -> Result<f64, String> {
    validate_history(conn, &shift.id, pharmacy).await?;
    let sales = checked_history(
        conn,
        "SELECT CAST(COALESCE(SUM(CAST(total_amount AS REAL)),0) AS REAL)
         FROM main.sales_invoices
         WHERE shift_id=? AND pharmacy_id=?
           AND payment_method='cash'
           AND (status IS NULL OR status='' OR status IN ('completed','approved'))",
        &shift.id,
        pharmacy,
    )
    .await?;
    let refunds = checked_history(
        conn,
        "SELECT CAST(COALESCE(SUM(CAST(total_refund AS REAL)),0) AS REAL)
         FROM main.returns WHERE shift_id=? AND pharmacy_id=?
           AND refund_method='cash'
           AND (status IS NULL OR status='' OR LOWER(status) IN ('approved','completed'))",
        &shift.id,
        pharmacy,
    )
    .await?;
    let movements = checked_history(
        conn,
        "SELECT CAST(COALESCE(SUM(CASE WHEN type IN ('receipt','in') THEN CAST(amount AS REAL)
                WHEN type IN ('disbursement','out') THEN -CAST(amount AS REAL)
                ELSE NULL END),0) AS REAL)
         FROM main.cash_movements WHERE shift_id=? AND pharmacy_id=?
           AND LOWER(COALESCE(source_type,''))<>'main_safe'",
        &shift.id,
        pharmacy,
    )
    .await?;
    let expected = shift.starting_cash + sales - refunds + movements;
    if !cents(expected) {
        return Err("Shift expected cash is not a finite two-decimal amount".into());
    }
    Ok(expected)
}

fn replay_prefix(nonce: &str) -> String {
    format!("managed-staff-close-request={nonce};")
}

async fn account(conn: &mut SqliteConnection, category: &str, code: &str) -> Result<i64, String> {
    let id: Option<i64> = sqlx::query_scalar(
        "SELECT a.id FROM main.trial_balance_settings s
         JOIN main.accounts a ON a.id=s.account_id
         WHERE s.category=? AND a.code=? AND COALESCE(a.is_group,0)=0
           AND NOT EXISTS(SELECT 1 FROM main.accounts c WHERE c.parent_id=a.id)
         ORDER BY a.id LIMIT 1",
    )
    .bind(category)
    .bind(code)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(id) = id {
        return Ok(id);
    }
    sqlx::query_scalar(
        "SELECT a.id FROM main.accounts a WHERE a.code=?
         AND COALESCE(a.is_group,0)=0
         AND NOT EXISTS(SELECT 1 FROM main.accounts c WHERE c.parent_id=a.id)
         LIMIT 1",
    )
    .bind(code)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Required cash reconciliation account {code} missing or not a leaf"))
}

async fn post_variance(
    conn: &mut SqliteConnection,
    actor: &str,
    pharmacy: &str,
    shift: &str,
    request_id: &str,
    difference: f64,
) -> Result<(), String> {
    if difference.abs() <= 0.005 {
        return Ok(());
    }
    let drawer = account(conn, "cash_drawer", "1.1.1").await?;
    let variance = account(conn, "cash_difference", "4.3").await?;
    if drawer == variance {
        return Err("Difference ledger cannot equal drawer account".into());
    }
    let amount = difference.abs();
    let movement_id = format!("managed-variance-{request_id}");
    sqlx::query(
        "INSERT INTO main.cash_movements
         (id,user_id,shift_id,type,category,amount,target_name,notes,date,pharmacy_id)
         VALUES(?,?,?,?,'cash_adjustment',?,'تسوية الجرد',?,
           date('now','localtime'),?)",
    )
    .bind(&movement_id)
    .bind(actor)
    .bind(shift)
    .bind(if difference > 0.0 {
        "receipt"
    } else {
        "disbursement"
    })
    .bind(amount)
    .bind(format!("تسوية إغلاق وردية موظف: {difference:.2}"))
    .bind(pharmacy)
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let journal_id = format!("managed-variance-journal-{request_id}");
    sqlx::query(
        "INSERT INTO main.daily_journals
          (id,date,description,created_by,total_amount,pharmacy_id)
         VALUES(?,date('now','localtime'),'تسوية وردية: عجز/زيادة نقدية',?,?,?)",
    )
    .bind(&journal_id)
    .bind(actor)
    .bind(amount)
    .bind(pharmacy)
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let (debit, credit) = if difference > 0.0 {
        (drawer, variance)
    } else {
        (variance, drawer)
    };
    for (id, side) in [(debit, "debit"), (credit, "credit")] {
        sqlx::query(
            "INSERT INTO main.journal_entries(journal_id,account_id,type,amount)
             VALUES(?,?,?,?)",
        )
        .bind(&journal_id)
        .bind(id)
        .bind(side)
        .bind(amount)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn audit(
    conn: &mut SqliteConnection,
    actor: &str,
    action: &str,
    details: String,
    pharmacy: &str,
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

async fn finish<T>(tx: Transaction<'_, Sqlite>, result: Result<T, String>) -> Result<T, String> {
    match result {
        Ok(value) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(error) => {
            tx.rollback()
                .await
                .map_err(|e| format!("{error}; rollback failed: {e}"))?;
            Err(error)
        }
    }
}

async fn close_locked(
    conn: &mut SqliteConnection,
    actor: &str,
    input: ManagedCloseInput,
) -> Result<ManagedCloseResult, String> {
    validate_close(&input)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result = async {
        let conn = &mut *tx;
        let pharmacy = active_owner(conn, actor).await?;
        let verified = verify_handover_password_on_connection(
            conn,
            actor,
            "authorizer",
            None,
            &input.authorizer_password,
        )
        .await?;
        if verified.as_deref() != Some(actor) {
            return Err("Owner authorization credential is invalid".into());
        }
        verified_target(conn, actor, &input.user_id, &pharmacy).await?;
        let audit_prefix = replay_prefix(&input.request_id);
        let replayed: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM main.activity_log
             WHERE action='CLOSE_USER_SHIFT_AND_DEACTIVATE'
               AND substr(details,1,length(?))=? LIMIT 1",
        )
        .bind(&audit_prefix)
        .bind(&audit_prefix)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if replayed.is_some() {
            return Err("Managed closure requestId has already been processed".into());
        }
        let shifts = open_shifts(conn, &pharmacy).await?;
        if shifts.len() != 1 {
            return Err("Pharmacy open shift state is ambiguous or missing".into());
        }
        let shift = &shifts[0];
        if shift.id != input.shift_id || shift.user_id != input.user_id {
            return Err("Selected sole open pharmacy shift does not belong to target staff".into());
        }
        let expected = reconcile(conn, shift, &pharmacy).await?;
        let difference = input.actual_cash - expected;
        if !cents(difference) {
            return Err("Invalid or overflowed managed closure difference".into());
        }
        let status = if difference.abs() > 5.0 {
            "discrepancy"
        } else {
            "closed"
        };
        post_variance(
            conn,
            actor,
            &pharmacy,
            &shift.id,
            &input.request_id,
            difference,
        )
        .await?;
        // Treasury movement is internal to the pharmacy: no bank/POS ledger
        // transfer and no next shift. The entire actual drawer enters treasury.
        if input.actual_cash > 0.0 {
            sqlx::query(
                "INSERT INTO main.cash_movements
                 (id,user_id,shift_id,type,category,amount,source_type,
                    target_name,notes,date,pharmacy_id)
                 VALUES(?,?,?,'disbursement','handover',?,'user_drawer',
                    'الخزينة الرئيسية - إغلاق حساب مستخدم',?,
                    date('now','localtime'),?)",
            )
            .bind(format!("managed-treasury-{}", input.request_id))
            .bind(actor)
            .bind(&input.shift_id)
            .bind(input.actual_cash)
            .bind(input.notes.as_deref().unwrap_or("تسليم درج - إغلاق موظف"))
            .bind(&pharmacy)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        }
        let updated = sqlx::query(
            "UPDATE main.shifts SET end_time=CURRENT_TIMESTAMP,
              ending_cash=0,actual_cash=?,transfer_amount=?,
              transfer_target='treasury',treasury_retained_cash=?,
              cash_difference=?,receiver_id=NULL,notes=?,status=?
             WHERE id=? AND CAST(user_id AS TEXT)=?
               AND LOWER(COALESCE(status,''))='open'
               AND pharmacy_id IS NOT NULL AND TRIM(pharmacy_id)=?",
        )
        .bind(input.actual_cash)
        .bind(input.actual_cash)
        .bind(input.actual_cash)
        .bind(difference)
        .bind(&input.notes)
        .bind(status)
        .bind(&input.shift_id)
        .bind(&input.user_id)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            return Err("Shift was changed before closure".into());
        }
        let disabled = sqlx::query(
            "UPDATE main.users SET is_active=0 WHERE CAST(id AS TEXT)=?
             AND COALESCE(is_active,1)=1 AND TRIM(COALESCE(pharmacy_id,''))=?
             AND (LOWER(TRIM(COALESCE(role,'')))<>'owner' OR EXISTS (
                  SELECT 1 FROM main.users other
                   WHERE CAST(other.id AS TEXT)<>?
                     AND LOWER(TRIM(COALESCE(other.role,'')))='owner'
                     AND COALESCE(other.is_active,1)=1
                     AND TRIM(COALESCE(other.pharmacy_id,''))=?
             ))",
        )
        .bind(&input.user_id)
        .bind(&pharmacy)
        .bind(&input.user_id)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if disabled.rows_affected() != 1 {
            return Err(
                "Managed target became inactive or last owner safeguard blocked closure".into(),
            );
        }
        audit(
            conn,
            actor,
            AUDIT_CREATE,
            format!(
                "{audit_prefix} target={} shift={} actual={:.2} expected={:.2} difference={:.2}",
                input.user_id, input.shift_id, input.actual_cash, expected, difference
            ),
            &pharmacy,
        )
        .await?;
        Ok(ManagedCloseResult {
            success: true,
            user_id: input.user_id,
            shift_id: input.shift_id,
            actual_cash: input.actual_cash,
            difference,
            status: status.into(),
        })
    }
    .await;
    finish(tx, result).await
}

async fn deactivate_locked(
    conn: &mut SqliteConnection,
    actor: &str,
    input: DeactivateStaffInput,
) -> Result<DeactivateStaffResult, String> {
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result = async {
        let conn = &mut *tx;
        let pharmacy = active_owner(conn, actor).await?;
        verified_target(conn, actor, &input.user_id, &pharmacy).await?;
        let shifts = open_shifts(conn, &pharmacy).await?;
        if shifts.len() > 1 {
            return Err("Multiple active shifts block staff deactivation".into());
        }
        if let Some(shift) = shifts.first() {
            if shift.user_id == input.user_id {
                let expected = reconcile(conn, shift, &pharmacy).await?;
                return Ok(DeactivateStaffResult {
                    success: false,
                    code: Some("OPEN_SHIFT"),
                    open_shift: Some(ManagedOpenShift {
                        id: shift.id.clone(),
                        start_time: shift.start_time.clone(),
                        expected_cash: expected,
                    }),
                });
            }
        }
        let updated = sqlx::query(
            "UPDATE main.users SET is_active=0
             WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1
               AND TRIM(COALESCE(pharmacy_id,''))=?
               AND (LOWER(TRIM(COALESCE(role,'')))<>'owner' OR EXISTS (
                 SELECT 1 FROM main.users other
                 WHERE CAST(other.id AS TEXT)<>?
                   AND COALESCE(other.is_active,1)=1
                   AND LOWER(TRIM(COALESCE(other.role,'')))='owner'
                   AND TRIM(COALESCE(other.pharmacy_id,''))=?
               ))",
        )
        .bind(&input.user_id)
        .bind(&pharmacy)
        .bind(&input.user_id)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            return Err("Target changed or last owner safeguard blocked deactivation".into());
        }
        audit(
            conn,
            actor,
            "DEACTIVATE_USER",
            format!("Owner disabled inactive-shift staff {}", input.user_id),
            &pharmacy,
        )
        .await?;
        Ok(DeactivateStaffResult {
            success: true,
            code: None,
            open_shift: None,
        })
    }
    .await;
    finish(tx, result).await
}

#[tauri::command]
pub async fn close_staff_shift_and_deactivate_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: ManagedCloseInput,
) -> Result<ManagedCloseResult, String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    close_locked(
        &mut conn,
        session.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn deactivate_staff_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: DeactivateStaffInput,
) -> Result<DeactivateStaffResult, String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    deactivate_locked(
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
    const PASSWORD: &str = "Owner!Managed-Close-2026";

    fn close(user: &str, shift: &str, actual: f64, nonce: &str) -> ManagedCloseInput {
        ManagedCloseInput {
            user_id: user.into(),
            shift_id: shift.into(),
            actual_cash: actual,
            authorizer_password: PASSWORD.into(),
            notes: Some("مراجعة مالك".into()),
            request_id: nonce.into(),
        }
    }

    async fn setup(conn: &mut SqliteConnection) {
        sqlx::raw_sql(
            r#"
          PRAGMA foreign_keys=ON;
          CREATE TABLE users(
            id TEXT PRIMARY KEY,username TEXT,role TEXT,pharmacy_id TEXT,
            is_active INTEGER,permissions TEXT,password_hash TEXT
          );
          CREATE TABLE shifts(
            id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,status TEXT,
            starting_cash REAL,start_time TEXT DEFAULT CURRENT_TIMESTAMP,
            end_time TEXT,ending_cash REAL,actual_cash REAL,transfer_amount REAL,
            transfer_target TEXT,treasury_retained_cash REAL,cash_difference REAL,
            receiver_id TEXT,notes TEXT
          );
          CREATE TABLE sales_invoices(
            id TEXT PRIMARY KEY,shift_id TEXT,pharmacy_id TEXT,status TEXT,
            payment_method TEXT,total_amount REAL
          );
          CREATE TABLE returns(
            id TEXT PRIMARY KEY,shift_id TEXT,pharmacy_id TEXT,status TEXT,
            refund_method TEXT,total_refund REAL
          );
          CREATE TABLE cash_movements(
            id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,pharmacy_id TEXT,
            type TEXT,category TEXT,amount REAL,source_type TEXT,
            target_name TEXT,notes TEXT,date TEXT
          );
          CREATE TABLE accounts(
            id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER DEFAULT 0,parent_id INTEGER
          );
          INSERT INTO accounts VALUES
            (1,'1.1.1',0,NULL),(2,'4.3',0,NULL),(3,'1.1.4',0,NULL);
          CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
          INSERT INTO trial_balance_settings VALUES('cash_drawer',1),('cash_difference',2);
          CREATE TABLE daily_journals(
            id TEXT PRIMARY KEY,date TEXT,description TEXT,created_by TEXT,
            total_amount REAL,pharmacy_id TEXT
          );
          CREATE TABLE journal_entries(
            id INTEGER PRIMARY KEY AUTOINCREMENT,journal_id TEXT,
            account_id INTEGER,type TEXT,amount REAL,
            FOREIGN KEY(journal_id) REFERENCES daily_journals(id)
          );
          CREATE TABLE activity_log(
            id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,
            action TEXT,details TEXT,pharmacy_id TEXT
          );
          INSERT INTO shifts(id,user_id,pharmacy_id,status,starting_cash) VALUES
            ('shift-a','staff-a','A','open',100),
            ('shift-b','staff-b','B','open',60);
          INSERT INTO sales_invoices VALUES
            ('sale-a','shift-a','A','completed','cash',75),
            ('visa-a','shift-a','A','completed','visa',999),
            ('sale-b','shift-b','B','completed','cash',20);
          INSERT INTO returns VALUES
            ('refund-a','shift-a','A','approved','cash',10);
          INSERT INTO cash_movements
            (id,user_id,shift_id,pharmacy_id,type,category,amount,source_type)
            VALUES
            ('receipts','staff-a','shift-a','A','receipt','collection',20,'manual'),
            ('outgo','staff-a','shift-a','A','disbursement','expense',5,'manual'),
            ('main-safe','staff-a','shift-a','A','receipt','collection',200,'main_safe');
        "#,
        )
        .execute(&mut *conn)
        .await
        .unwrap();
        let hash = bcrypt::hash(PASSWORD, 4).unwrap();
        let boot_hash = bcrypt::hash("admin", 4).unwrap();
        for (id, role, pharmacy, active, passwd) in [
            ("owner-a", "owner", "A", 1, hash.as_str()),
            ("second-owner-a", "owner", "A", 1, hash.as_str()),
            ("staff-a", "cashier", "A", 1, hash.as_str()),
            ("staff-b", "cashier", "B", 1, hash.as_str()),
            ("owner-b", "owner", "B", 1, hash.as_str()),
            ("denied-a", "cashier", "A", 1, hash.as_str()),
            ("inactive-a", "owner", "A", 0, hash.as_str()),
            ("boot-a", "owner", "A", 1, boot_hash.as_str()),
        ] {
            sqlx::query(
                "INSERT INTO users(id,username,role,pharmacy_id,is_active,password_hash)
                       VALUES(?,?,?,?,?,?)",
            )
            .bind(id)
            .bind(id)
            .bind(role)
            .bind(pharmacy)
            .bind(active)
            .bind(passwd)
            .execute(&mut *conn)
            .await
            .unwrap();
        }
    }

    async fn memory() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        setup(&mut conn).await;
        conn
    }

    async fn target_active(conn: &mut SqliteConnection, id: &str) -> i64 {
        sqlx::query_scalar("SELECT is_active FROM users WHERE id=?")
            .bind(id)
            .fetch_one(&mut *conn)
            .await
            .unwrap()
    }

    async fn counts(conn: &mut SqliteConnection) -> (i64, i64, i64, i64) {
        let journals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        let lines: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM journal_entries")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        let movements: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM cash_movements WHERE id LIKE 'managed-%'")
                .fetch_one(&mut *conn)
                .await
                .unwrap();
        let logs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM activity_log")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        (journals, lines, movements, logs)
    }

    #[test]
    fn strict_dto_rejects_untrusted_identity_sql_and_malformed_money_or_nonce() {
        let valid = serde_json::json!({
            "userId":"staff-a","shiftId":"shift-a","actualCash":185.0,
            "authorizerPassword":PASSWORD,"requestId":NONCE
        });
        assert!(serde_json::from_value::<ManagedCloseInput>(valid.clone()).is_ok());
        for field in [
            "actorId",
            "pharmacyId",
            "sql",
            "transferAmount",
            "accountId",
            "receiverId",
            "managedUserId",
            "deactivateManagedUser",
        ] {
            let mut invalid = valid.clone();
            invalid[field] = serde_json::json!("forged");
            assert!(
                serde_json::from_value::<ManagedCloseInput>(invalid).is_err(),
                "{field}"
            );
        }
        assert!(serde_json::from_value::<DeactivateStaffInput>(
            serde_json::json!({"userId":"staff-a","actorId":"owner-b"})
        )
        .is_err());
        assert!(serde_json::from_value::<ManagedCloseInput>(
            serde_json::json!({"userId":"staff-a","shiftId":"shift-a","actualCash":"185.00",
                "authorizerPassword":PASSWORD,"requestId":NONCE})
        )
        .is_err());
        for (id, actual, nonce) in [
            ("staff-a", f64::INFINITY, NONCE),
            ("staff-a", f64::NAN, NONCE),
            ("staff-a", -1.0, NONCE),
            ("staff-a", 1.234, NONCE),
            ("staff-a", 1e13, NONCE),
            ("staff-a", 0.0, "bad-nonce"),
            ("staff-a", 0.0, "a1111111-1111-1111-8111-111111111111"),
        ] {
            let payload = close(id, "shift-a", actual, nonce);
            assert!(validate_close(&payload).is_err(), "{actual}:{nonce}");
        }
        assert!(validation_target("owner-a", "owner-a").is_err());
        assert!(validation_target("staff-a' OR 1=1", "owner-a").is_err());
        let mut bad = close("staff-a", "shift-a", 1.0, NONCE);
        bad.notes = Some("\u{0000}sql".into());
        assert!(validate_close(&bad).is_err());
    }

    #[tokio::test]
    async fn exact_treasury_close_matches_native_drawer_and_deactivates_without_new_shift() {
        let mut conn = memory().await;
        // 100 starting +75 sale -10 return +20 receipt -5 outgoing =180.
        let result = close_locked(
            &mut conn,
            "owner-a",
            close("staff-a", "shift-a", 180.0, NONCE),
        )
        .await
        .unwrap();
        assert_eq!(result.difference, 0.0);
        assert_eq!(result.actual_cash, 180.0);
        assert_eq!(result.status, "closed");
        assert_eq!(target_active(&mut conn, "staff-a").await, 0);
        let shift = sqlx::query(
            "SELECT status,ending_cash,actual_cash,transfer_amount,transfer_target,
             treasury_retained_cash,cash_difference,receiver_id FROM shifts WHERE id='shift-a'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(shift.get::<String, _>("status"), "closed");
        for (col, value) in [
            ("ending_cash", 0.0),
            ("actual_cash", 180.0),
            ("transfer_amount", 180.0),
            ("treasury_retained_cash", 180.0),
            ("cash_difference", 0.0),
        ] {
            assert_eq!(shift.get::<f64, _>(col), value, "{col}");
        }
        assert_eq!(shift.get::<String, _>("transfer_target"), "treasury");
        assert_eq!(shift.get::<Option<String>, _>("receiver_id"), None);
        assert_eq!(counts(&mut conn).await, (0, 0, 1, 1));
        let move_row = sqlx::query(
            "SELECT user_id,type,source_type,amount,pharmacy_id FROM cash_movements
              WHERE id LIKE 'managed-treasury-%'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(move_row.get::<String, _>("user_id"), "owner-a");
        assert_eq!(move_row.get::<String, _>("type"), "disbursement");
        assert_eq!(move_row.get::<String, _>("source_type"), "user_drawer");
        assert_eq!(move_row.get::<f64, _>("amount"), 180.0);
        assert_eq!(move_row.get::<String, _>("pharmacy_id"), "A");
        let open: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM shifts WHERE status='open' AND pharmacy_id='A'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(open, 0);
        let audit = sqlx::query("SELECT user_id,action,details,pharmacy_id FROM activity_log")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(audit.get::<String, _>("user_id"), "owner-a");
        assert_eq!(audit.get::<String, _>("action"), AUDIT_CREATE);
        assert!(audit.get::<String, _>("details").contains(NONCE));
        assert_eq!(audit.get::<String, _>("pharmacy_id"), "A");
        assert!(close_locked(
            &mut conn,
            "owner-a",
            close("staff-a", "shift-a", 180.0, NONCE)
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn positive_and_negative_variance_get_cash_adjustment_and_balanced_tenant_journal() {
        for (difference, actual, debit, credit) in [
            (5.20_f64, 185.20_f64, 1_i64, 2_i64),
            (-11.25_f64, 168.75_f64, 2_i64, 1_i64),
        ] {
            let mut conn = memory().await;
            let result = close_locked(
                &mut conn,
                "owner-a",
                close("staff-a", "shift-a", actual, NONCE),
            )
            .await
            .unwrap();
            assert_eq!(
                result.status,
                if difference.abs() > 5.0 {
                    "discrepancy"
                } else {
                    "closed"
                }
            );
            assert!((result.difference - difference).abs() < 0.0000001);
            assert_eq!(target_active(&mut conn, "staff-a").await, 0);
            assert_eq!(counts(&mut conn).await, (1, 2, 2, 1));
            let journal =
                sqlx::query("SELECT created_by,total_amount,pharmacy_id FROM daily_journals")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(journal.get::<String, _>("created_by"), "owner-a");
            assert_eq!(journal.get::<String, _>("pharmacy_id"), "A");
            assert!((journal.get::<f64, _>("total_amount") - difference.abs()).abs() < 0.0000001);
            let entries =
                sqlx::query("SELECT account_id,type,amount FROM journal_entries ORDER BY id")
                    .fetch_all(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(entries[0].get::<i64, _>("account_id"), debit);
            assert_eq!(entries[1].get::<i64, _>("account_id"), credit);
            assert_eq!(entries[0].get::<String, _>("type"), "debit");
            assert_eq!(entries[1].get::<String, _>("type"), "credit");
            assert!(
                (entries[0].get::<f64, _>("amount") - entries[1].get::<f64, _>("amount")).abs()
                    < 1e-9
            );
            let adjustment = sqlx::query(
                "SELECT type,amount FROM cash_movements WHERE id LIKE 'managed-variance-%'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap();
            assert_eq!(
                adjustment.get::<String, _>("type"),
                if difference > 0.0 {
                    "receipt"
                } else {
                    "disbursement"
                }
            );
            assert!((adjustment.get::<f64, _>("amount") - difference.abs()).abs() < 0.0000001);
        }
    }

    #[tokio::test]
    async fn actor_role_password_target_and_ownership_are_live_and_reject_forgery() {
        let mut conn = memory().await;
        for actor in ["denied-a", "inactive-a", "nonexistent", "owner-b"] {
            assert!(
                close_locked(&mut conn, actor, close("staff-a", "shift-a", 180.0, NONCE))
                    .await
                    .is_err()
            );
        }
        assert!(close_locked(
            &mut conn,
            "owner-a",
            close("owner-a", "shift-a", 180.0, NONCE)
        )
        .await
        .is_err());
        assert!(close_locked(
            &mut conn,
            "owner-a",
            close("staff-b", "shift-b", 180.0, NONCE)
        )
        .await
        .is_err());
        assert!(close_locked(
            &mut conn,
            "owner-a",
            close("staff-a", "shift-b", 180.0, NONCE)
        )
        .await
        .is_err());
        let mut bad = close("staff-a", "shift-a", 180.0, NONCE);
        bad.authorizer_password = "wrong credential".into();
        assert!(close_locked(&mut conn, "owner-a", bad).await.is_err());
        let mut bad = close("staff-a", "shift-a", 180.0, NONCE);
        bad.authorizer_password = "admin".into();
        assert!(close_locked(&mut conn, "owner-a", bad).await.is_err());
        conn.execute("UPDATE users SET role='cashier' WHERE id='owner-a'")
            .await
            .unwrap();
        assert!(close_locked(
            &mut conn,
            "owner-a",
            close("staff-a", "shift-a", 180.0, NONCE)
        )
        .await
        .is_err());
        conn.execute("UPDATE users SET role='owner', pharmacy_id='B' WHERE id='owner-a'")
            .await
            .unwrap();
        assert!(close_locked(
            &mut conn,
            "owner-a",
            close("staff-a", "shift-a", 180.0, NONCE)
        )
        .await
        .is_err());
        conn.execute("UPDATE users SET role='owner', pharmacy_id='A' WHERE id='owner-a'")
            .await
            .unwrap();
        conn.execute("UPDATE users SET is_active=0 WHERE id='staff-a'")
            .await
            .unwrap();
        assert!(close_locked(
            &mut conn,
            "owner-a",
            close("staff-a", "shift-a", 180.0, NONCE)
        )
        .await
        .is_err());
        assert_eq!(counts(&mut conn).await, (0, 0, 0, 0));
    }

    #[tokio::test]
    async fn last_owner_protection_applies_even_on_live_role_changes() {
        let mut conn = memory().await;
        assert!(deactivate_locked(
            &mut conn,
            "owner-a",
            DeactivateStaffInput {
                user_id: "owner-a".into()
            }
        )
        .await
        .is_err());
        conn.execute("UPDATE users SET is_active=0 WHERE id='second-owner-a'")
            .await
            .unwrap();
        assert!(deactivate_locked(
            &mut conn,
            "owner-a",
            DeactivateStaffInput {
                user_id: "owner-a".into()
            }
        )
        .await
        .is_err());
        // Authorizer is owner-a and target is owner with sole open shift;
        // target could become last owner while the writer lock is held, but
        // owner guard rejects self before any mutation.
        conn.execute("UPDATE users SET role='owner' WHERE id='staff-a'")
            .await
            .unwrap();
        let close = close_locked(
            &mut conn,
            "owner-a",
            close("staff-a", "shift-a", 180.0, NONCE),
        )
        .await
        .unwrap();
        assert_eq!(close.status, "closed");
        assert_eq!(target_active(&mut conn, "staff-a").await, 0);
        assert_eq!(target_active(&mut conn, "owner-a").await, 1);
    }

    #[tokio::test]
    async fn deactivation_preview_then_atomic_no_shift_disable_with_audit() {
        let mut conn = memory().await;
        let first = deactivate_locked(
            &mut conn,
            "owner-a",
            DeactivateStaffInput {
                user_id: "staff-a".into(),
            },
        )
        .await
        .unwrap();
        assert!(!first.success);
        assert_eq!(first.code, Some("OPEN_SHIFT"));
        assert_eq!(first.open_shift.as_ref().unwrap().id, "shift-a");
        assert_eq!(first.open_shift.as_ref().unwrap().expected_cash, 180.0);
        assert_eq!(target_active(&mut conn, "staff-a").await, 1);
        assert_eq!(counts(&mut conn).await, (0, 0, 0, 0));
        let ui = serde_json::to_value(&first).unwrap();
        assert_eq!(ui["openShift"]["expected_cash"], 180.0);
        assert!(ui["openShift"]["start_time"].is_string());
        conn.execute("UPDATE shifts SET status='closed' WHERE id='shift-a'")
            .await
            .unwrap();
        let done = deactivate_locked(
            &mut conn,
            "owner-a",
            DeactivateStaffInput {
                user_id: "staff-a".into(),
            },
        )
        .await
        .unwrap();
        assert!(done.success);
        assert_eq!(done.code, None);
        assert_eq!(target_active(&mut conn, "staff-a").await, 0);
        assert_eq!(counts(&mut conn).await, (0, 0, 0, 1));
        assert!(deactivate_locked(
            &mut conn,
            "owner-a",
            DeactivateStaffInput {
                user_id: "staff-a".into()
            }
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn no_open_shift_deactivation_rejects_crossbranch_inactive_and_last_owner() {
        let mut conn = memory().await;
        assert!(deactivate_locked(
            &mut conn,
            "denied-a",
            DeactivateStaffInput {
                user_id: "staff-a".into()
            }
        )
        .await
        .is_err());
        assert!(deactivate_locked(
            &mut conn,
            "owner-a",
            DeactivateStaffInput {
                user_id: "staff-b".into()
            }
        )
        .await
        .is_err());
        assert!(deactivate_locked(
            &mut conn,
            "owner-a",
            DeactivateStaffInput {
                user_id: "inactive-a".into()
            }
        )
        .await
        .is_err());
        conn.execute("UPDATE shifts SET status='closed' WHERE id='shift-a'")
            .await
            .unwrap();
        conn.execute("UPDATE users SET pharmacy_id='B' WHERE id='staff-a'")
            .await
            .unwrap();
        assert!(deactivate_locked(
            &mut conn,
            "owner-a",
            DeactivateStaffInput {
                user_id: "staff-a".into()
            }
        )
        .await
        .is_err());
        assert_eq!(target_active(&mut conn, "staff-a").await, 1);
        assert_eq!(counts(&mut conn).await, (0, 0, 0, 0));
    }

    #[tokio::test]
    async fn ambiguous_multiple_or_unowned_open_shifts_and_foreign_history_fail_closed() {
        let mut conn = memory().await;
        conn.execute("INSERT INTO shifts(id,user_id,pharmacy_id,status,starting_cash) VALUES('second-a','staff-a','A','open',0)")
            .await.unwrap();
        assert!(close_locked(
            &mut conn,
            "owner-a",
            close("staff-a", "shift-a", 180.0, NONCE)
        )
        .await
        .is_err());
        assert!(deactivate_locked(
            &mut conn,
            "owner-a",
            DeactivateStaffInput {
                user_id: "staff-a".into()
            }
        )
        .await
        .is_err());
        conn.execute("DELETE FROM shifts WHERE id='second-a'")
            .await
            .unwrap();
        conn.execute("UPDATE shifts SET pharmacy_id=NULL WHERE id='shift-a'")
            .await
            .unwrap();
        assert!(close_locked(
            &mut conn,
            "owner-a",
            close("staff-a", "shift-a", 180.0, NONCE)
        )
        .await
        .is_err());
        conn.execute("UPDATE shifts SET pharmacy_id='A' WHERE id='shift-a'")
            .await
            .unwrap();
        conn.execute("INSERT INTO sales_invoices VALUES('foreign-sale','shift-a','B','completed','cash',999)")
            .await.unwrap();
        assert!(close_locked(
            &mut conn,
            "owner-a",
            close("staff-a", "shift-a", 180.0, NONCE)
        )
        .await
        .is_err());
        assert!(deactivate_locked(
            &mut conn,
            "owner-a",
            DeactivateStaffInput {
                user_id: "staff-a".into()
            }
        )
        .await
        .is_err());
        assert_eq!(target_active(&mut conn, "staff-a").await, 1);
        assert_eq!(counts(&mut conn).await, (0, 0, 0, 0));
    }

    #[tokio::test]
    async fn target_linked_foreign_or_legacy_username_open_shift_cannot_be_stranded() {
        for foreign_tenant in [Some("B"), None, Some("")] {
            let mut conn = memory().await;
            conn.execute("UPDATE shifts SET status='closed' WHERE id='shift-a'")
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO shifts(id,user_id,pharmacy_id,status,starting_cash)
                 VALUES('unresolved','staff-a',?,'open',0)",
            )
            .bind(foreign_tenant)
            .execute(&mut conn)
            .await
            .unwrap();
            assert!(deactivate_locked(
                &mut conn,
                "owner-a",
                DeactivateStaffInput {
                    user_id: "staff-a".into()
                },
            )
            .await
            .is_err());
            assert_eq!(target_active(&mut conn, "staff-a").await, 1);
            assert_eq!(counts(&mut conn).await, (0, 0, 0, 0));
        }
        for tenant in ["A", "B"] {
            let mut conn = memory().await;
            sqlx::query("UPDATE users SET username='new-staff-alias' WHERE id='staff-a'")
                .execute(&mut conn)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO shifts(id,user_id,pharmacy_id,status,starting_cash)
                 VALUES('alias-shift','new-staff-alias',?,'open',0)",
            )
            .bind(tenant)
            .execute(&mut conn)
            .await
            .unwrap();
            assert!(close_locked(
                &mut conn,
                "owner-a",
                close("staff-a", "shift-a", 180.0, NONCE),
            )
            .await
            .is_err());
            assert!(deactivate_locked(
                &mut conn,
                "owner-a",
                DeactivateStaffInput {
                    user_id: "staff-a".into()
                },
            )
            .await
            .is_err());
            assert_eq!(target_active(&mut conn, "staff-a").await, 1);
            assert_eq!(counts(&mut conn).await, (0, 0, 0, 0));
        }
    }

    #[tokio::test]
    async fn malformed_nonfinite_fractional_history_or_prior_transfer_fail_closed() {
        let mut conn = memory().await;
        for sql in [
            "UPDATE sales_invoices SET total_amount='bogus' WHERE id='sale-a'",
            "UPDATE sales_invoices SET total_amount=1e309 WHERE id='sale-a'",
            "UPDATE sales_invoices SET total_amount=-1 WHERE id='sale-a'",
            "UPDATE sales_invoices SET total_amount=1000000000001 WHERE id='sale-a'",
            "UPDATE sales_invoices SET total_amount=75.003 WHERE id='sale-a'",
            "UPDATE cash_movements SET amount='bad' WHERE id='receipts'",
            "UPDATE cash_movements SET type='unknown' WHERE id='receipts'",
            "UPDATE shifts SET starting_cash=1e309 WHERE id='shift-a'",
            "UPDATE shifts SET transfer_amount=5 WHERE id='shift-a'",
        ] {
            let mut each = memory().await;
            each.execute(sql).await.unwrap();
            assert!(
                close_locked(
                    &mut each,
                    "owner-a",
                    close("staff-a", "shift-a", 180.0, NONCE)
                )
                .await
                .is_err(),
                "{sql}"
            );
            assert_eq!(target_active(&mut each, "staff-a").await, 1);
            assert_eq!(counts(&mut each).await, (0, 0, 0, 0));
        }
        // Keep outer fixture alive to catch reuse and ensure no side effects.
        assert_eq!(counts(&mut conn).await, (0, 0, 0, 0));
    }

    #[tokio::test]
    async fn trigger_failures_roll_back_variance_movements_shift_user_and_audit() {
        let mut conn = memory().await;
        for (create_trigger,drop_trigger) in [
            (
              "CREATE TRIGGER fail_entries BEFORE INSERT ON journal_entries BEGIN SELECT RAISE(ABORT,'fail entries'); END",
              "DROP TRIGGER fail_entries"
            ),
            (
              "CREATE TRIGGER fail_log BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT,'fail log'); END",
              "DROP TRIGGER fail_log"
            ),
            (
              "CREATE TRIGGER fail_user BEFORE UPDATE OF is_active ON users BEGIN SELECT RAISE(ABORT,'fail staff update'); END",
              "DROP TRIGGER fail_user"
            ),
        ] {
            conn.execute(create_trigger).await.unwrap();
            assert!(close_locked(&mut conn,"owner-a",close("staff-a","shift-a",185.20,NONCE)).await.is_err());
            assert_eq!(counts(&mut conn).await,(0,0,0,0));
            assert_eq!(target_active(&mut conn,"staff-a").await,1);
            let state:String=sqlx::query_scalar("SELECT status FROM shifts WHERE id='shift-a'")
                .fetch_one(&mut conn).await.unwrap();
            assert_eq!(state,"open");
            conn.execute(drop_trigger).await.unwrap();
        }
        close_locked(
            &mut conn,
            "owner-a",
            close("staff-a", "shift-a", 185.20, NONCE),
        )
        .await
        .unwrap();
        assert_eq!(counts(&mut conn).await, (1, 2, 2, 1));
        assert_eq!(target_active(&mut conn, "staff-a").await, 0);
    }

    #[tokio::test]
    async fn concurrent_two_writers_same_nonce_post_close_once_and_no_next_shift() {
        let mut path = std::env::temp_dir();
        path.push(format!("pharma-managed-staff-{}.sqlite", Uuid::new_v4()));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(8));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .unwrap();
        {
            let mut db = pool.acquire().await.unwrap();
            setup(&mut db).await;
        }
        let (a, b) = tokio::join!(
            async {
                let mut db = pool.acquire().await.unwrap();
                close_locked(
                    &mut db,
                    "owner-a",
                    close("staff-a", "shift-a", 185.20, NONCE),
                )
                .await
            },
            async {
                let mut db = pool.acquire().await.unwrap();
                close_locked(
                    &mut db,
                    "owner-a",
                    close("staff-a", "shift-a", 185.20, NONCE),
                )
                .await
            },
        );
        assert_eq!(i64::from(a.is_ok()) + i64::from(b.is_ok()), 1);
        let mut db = pool.acquire().await.unwrap();
        assert_eq!(target_active(&mut db, "staff-a").await, 0);
        assert_eq!(counts(&mut db).await, (1, 2, 2, 1));
        let open: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM shifts WHERE status='open' AND pharmacy_id='A'",
        )
        .fetch_one(&mut *db)
        .await
        .unwrap();
        assert_eq!(open, 0);
        drop(db);
        pool.close().await;
        for _ in 0..20 {
            if std::fs::remove_file(&path).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
