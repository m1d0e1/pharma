//! Atomic native shared shift opening and reconciliation.
//! All writes are fixed SQL. Renderer IDs, roles, pharmacies and SQL never
//! become authorization evidence; a native session and live users row do.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection};
use std::{collections::HashMap, time::Duration};
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::{fetch_scoped_limited, reset_cancelled_read_state, ReadLimits};
use super::permission_policy::user_has_permission;

#[derive(Debug, Serialize)]
pub struct SharedShift {
    id: String,
    user_id: String,
    start_time: Option<String>,
    starting_cash: Option<f64>,
    status: String,
}

#[derive(Debug, Serialize)]
pub struct OpenShiftResult {
    shift_id: String,
    already_open: bool,
}

#[derive(Debug, Serialize)]
pub struct CurrentShiftResult {
    shift: SharedShift,
    suggested_starting_cash: f64,
}

#[derive(Debug, Serialize)]
pub struct ShiftHistoryPage {
    rows: Vec<Value>,
    has_more: bool,
    next_page: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenShiftInput {
    starting_cash_amount: f64,
    opening_notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseShiftInput {
    shift_id: Option<String>,
    ending_cash_amount: f64,
    closing_notes: Option<String>,
}

#[derive(Clone, Copy)]
enum ShiftPermission {
    Ensure,
    Open,
    Close,
    Read,
    History,
    Receipts,
}

async fn authorized_shift_identity(
    conn: &mut SqliteConnection,
    actor_id: &str,
    action: ShiftPermission,
) -> Result<(String, String), String> {
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    let allowed = match action {
        ShiftPermission::Open => user_has_permission(
            Some(&role),
            permissions.as_deref(),
            "can_view_shifts",
            false,
        ),
        ShiftPermission::Close => user_has_permission(
            Some(&role),
            permissions.as_deref(),
            "acc_can_view_handover",
            false,
        ),
        ShiftPermission::Read => [
            "can_view_shifts",
            "can_view_receipts",
            "rep_can_view_shifts",
            "acc_can_view_handover",
            "can_access_pos",
        ]
        .iter()
        .any(|key| {
            user_has_permission(
                Some(&role),
                permissions.as_deref(),
                key,
                *key == "can_access_pos",
            )
        }),
        ShiftPermission::History => user_has_permission(
            Some(&role),
            permissions.as_deref(),
            "can_view_shifts",
            false,
        ),
        ShiftPermission::Receipts => [
            "can_view_shifts",
            "can_view_receipts",
            "rep_can_view_shifts",
        ]
        .iter()
        .any(|key| user_has_permission(Some(&role), permissions.as_deref(), key, false)),
        ShiftPermission::Ensure => ["can_view_shifts", "can_access_pos", "acc_can_view_handover"]
            .iter()
            .any(|key| {
                user_has_permission(
                    Some(&role),
                    permissions.as_deref(),
                    key,
                    *key == "can_access_pos",
                )
            }),
    };
    if !allowed {
        return Err("Authenticated role cannot manage the shared pharmacy shift".into());
    }
    Ok((role, pharmacy_id))
}

async fn authorized_shift_pharmacy(
    conn: &mut SqliteConnection,
    actor_id: &str,
    action: ShiftPermission,
) -> Result<String, String> {
    authorized_shift_identity(conn, actor_id, action)
        .await
        .map(|(_, pharmacy_id)| pharmacy_id)
}

fn validate_cash(value: f64) -> Result<(), String> {
    if !value.is_finite()
        || !(0.0..=1_000_000_000_000.0).contains(&value)
        || (value * 100.0 - (value * 100.0).round()).abs() > 0.000_001
    {
        return Err("Invalid shift cash amount".into());
    }
    Ok(())
}

fn validate_notes(notes: Option<&str>) -> Result<(), String> {
    if notes.is_some_and(|value| {
        value.len() > 2000
            || value
                .chars()
                .any(|ch| ch == '\0' || (ch.is_control() && ch != '\n'))
    }) {
        return Err("Invalid shift notes".into());
    }
    Ok(())
}

fn validate_shift_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty()
        || id.len() > 128
        || id
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '\'' | '"' | ';' | '`'))
    {
        return Err("Invalid shift identifier".into());
    }
    Ok(())
}

async fn begin_shift_write(conn: &mut SqliteConnection) -> Result<(), String> {
    reset_cancelled_read_state(conn).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

async fn finish_shift_write<T>(
    conn: &mut SqliteConnection,
    outcome: Result<T, String>,
) -> Result<T, String> {
    match outcome {
        Ok(value) => match sqlx::query("COMMIT").execute(&mut *conn).await {
            Ok(_) => Ok(value),
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(error.to_string())
            }
        },
        Err(error) => {
            let rollback = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            if let Err(failed) = rollback {
                return Err(format!("{error}; rollback: {failed}"));
            }
            Err(error)
        }
    }
}

async fn existing_open_shift(
    conn: &mut SqliteConnection,
    pharmacy_id: &str,
) -> Result<Option<SharedShift>, String> {
    let row = sqlx::query(
        "SELECT id,user_id,start_time,starting_cash,status FROM main.shifts
         WHERE LOWER(COALESCE(status,''))='open'
           AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
         ORDER BY start_time ASC,rowid ASC LIMIT 1",
    )
    .bind(pharmacy_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    row.map(|row| {
        Ok(SharedShift {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            user_id: row.try_get("user_id").map_err(|e| e.to_string())?,
            start_time: row.try_get("start_time").map_err(|e| e.to_string())?,
            starting_cash: row.try_get("starting_cash").map_err(|e| e.to_string())?,
            status: row.try_get("status").map_err(|e| e.to_string())?,
        })
    })
    .transpose()
}

async fn open_shift_by_id(
    conn: &mut SqliteConnection,
    pharmacy_id: &str,
    shift_id: &str,
) -> Result<Option<SharedShift>, String> {
    let row = sqlx::query(
        "SELECT id,user_id,start_time,starting_cash,status FROM main.shifts
         WHERE id=? AND LOWER(COALESCE(status,''))='open'
           AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
         LIMIT 1",
    )
    .bind(shift_id)
    .bind(pharmacy_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    row.map(|row| {
        Ok(SharedShift {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            user_id: row.try_get("user_id").map_err(|e| e.to_string())?,
            start_time: row.try_get("start_time").map_err(|e| e.to_string())?,
            starting_cash: row.try_get("starting_cash").map_err(|e| e.to_string())?,
            status: row.try_get("status").map_err(|e| e.to_string())?,
        })
    })
    .transpose()
}

async fn scoped_shift_by_id(
    conn: &mut SqliteConnection,
    actor_id: &str,
    shift_id: &str,
    open_only: bool,
) -> Result<Option<SharedShift>, String> {
    validate_shift_id(shift_id)?;
    reset_cancelled_read_state(conn).await?;
    let pharmacy_id = authorized_shift_pharmacy(conn, actor_id, ShiftPermission::Read).await?;
    let row = sqlx::query(
        "SELECT id,user_id,start_time,starting_cash,status FROM main.shifts
         WHERE id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
           AND (?=0 OR LOWER(COALESCE(status,''))='open') LIMIT 1",
    )
    .bind(shift_id)
    .bind(&pharmacy_id)
    .bind(open_only)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    row.map(|row| {
        Ok(SharedShift {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            user_id: row.try_get("user_id").map_err(|e| e.to_string())?,
            start_time: row.try_get("start_time").map_err(|e| e.to_string())?,
            starting_cash: row.try_get("starting_cash").map_err(|e| e.to_string())?,
            status: row.try_get("status").map_err(|e| e.to_string())?,
        })
    })
    .transpose()
}

async fn current_shared_shift(
    conn: &mut SqliteConnection,
    actor_id: &str,
) -> Result<CurrentShiftResult, String> {
    let (shift, _) = open_shared_shift(
        conn,
        actor_id,
        0.0,
        "وردية مشتركة أُنشئت تلقائياً",
        ShiftPermission::Ensure,
    )
    .await?;
    let pharmacy_id = authorized_shift_pharmacy(conn, actor_id, ShiftPermission::Ensure).await?;
    let last_closed: Option<f64> = sqlx::query_scalar(
        "SELECT ending_cash FROM main.shifts
         WHERE status!='open' AND ending_cash IS NOT NULL
           AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
         ORDER BY COALESCE(end_time,start_time) DESC LIMIT 1",
    )
    .bind(&pharmacy_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    let suggested = last_closed.unwrap_or(0.0);
    if !suggested.is_finite() {
        return Err("Previous shift cash is invalid".into());
    }
    Ok(CurrentShiftResult {
        shift,
        suggested_starting_cash: suggested,
    })
}

async fn open_shared_shift(
    conn: &mut SqliteConnection,
    actor_id: &str,
    starting_cash: f64,
    notes: &str,
    permission: ShiftPermission,
) -> Result<(SharedShift, bool), String> {
    validate_cash(starting_cash)?;
    validate_notes(Some(notes))?;
    begin_shift_write(conn).await?;
    let operation = async {
        let pharmacy_id = authorized_shift_pharmacy(conn, actor_id, permission).await?;
        if let Some(shift) = existing_open_shift(conn, &pharmacy_id).await? {
            return Ok((shift, true));
        }
        let shift_id = Uuid::new_v4().to_string();
        let inserted = sqlx::query(
            "INSERT INTO main.shifts(id,user_id,pharmacy_id,starting_cash,notes,status)
             SELECT ?,?,?,?,?,'open' WHERE NOT EXISTS (
               SELECT 1 FROM main.shifts WHERE LOWER(COALESCE(status,''))='open'
                 AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
             )",
        )
        .bind(&shift_id)
        .bind(actor_id)
        .bind(&pharmacy_id)
        .bind(starting_cash)
        .bind(notes)
        .bind(&pharmacy_id)
        .execute(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
        if inserted.rows_affected() != 1 {
            return Err("Shared shift was concurrently opened".into());
        }
        if matches!(permission, ShiftPermission::Open) {
            sqlx::query(
                "INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
                 VALUES (?,'START_SHIFT',?,?)",
            )
            .bind(actor_id)
            .bind(format!("أنشأ الوردية المشتركة بمبلغ {starting_cash}"))
            .bind(&pharmacy_id)
            .execute(&mut *conn)
            .await
            .map_err(|error| error.to_string())?;
        }
        let created = existing_open_shift(conn, &pharmacy_id)
            .await?
            .ok_or("Could not create the shared shift")?;
        Ok((created, false))
    }
    .await;
    finish_shift_write(conn, operation).await
}

async fn sum_for_shift(
    conn: &mut SqliteConnection,
    shift_id: &str,
    sql: &str,
    pharmacy_id: &str,
) -> Result<f64, String> {
    // Only fixed compile-time SQL strings from this module are used.
    sqlx::query_scalar::<_, f64>(sql)
        .bind(shift_id)
        .bind(pharmacy_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(|error| error.to_string())
}

/// Closing a shift posts a *real* cash-shortage journal when counted cash
/// differs. Validate every linked source first, including sources excluded
/// from cash totals (e.g. bank payments and main-safe movements). A foreign or
/// unowned link, SQLite text coercion, or negative money must never influence
/// a posted accounting adjustment or be silently interpreted as zero.
async fn validate_close_shift_sources(
    conn: &mut SqliteConnection,
    shift_id: &str,
    pharmacy_id: &str,
) -> Result<(), String> {
    if pharmacy_id.trim().is_empty() || pharmacy_id == "local_default" {
        return Err("Legacy shift cash ownership requires independent tenant verification".into());
    }
    let unowned: i64 = sqlx::query_scalar(
        "SELECT
           (SELECT COUNT(*) FROM main.sales_invoices WHERE shift_id=?
             AND (pharmacy_id IS NULL OR TRIM(pharmacy_id)='' OR pharmacy_id<>?))
         + (SELECT COUNT(*) FROM main.returns WHERE shift_id=?
             AND (pharmacy_id IS NULL OR TRIM(pharmacy_id)='' OR pharmacy_id<>?))
         + (SELECT COUNT(*) FROM main.cash_movements WHERE shift_id=?
             AND (pharmacy_id IS NULL OR TRIM(pharmacy_id)='' OR pharmacy_id<>?))",
    )
    .bind(shift_id)
    .bind(pharmacy_id)
    .bind(shift_id)
    .bind(pharmacy_id)
    .bind(shift_id)
    .bind(pharmacy_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if unowned != 0 {
        return Err("Shift contains foreign or unowned cash source history".into());
    }
    let malformed: i64 = sqlx::query_scalar(
        "SELECT
           (SELECT COUNT(*) FROM main.sales_invoices WHERE shift_id=?
             AND (payment_method='cash' AND (status IS NULL OR status='')
               OR total_amount IS NULL
               OR typeof(total_amount) NOT IN ('real','integer')
               OR NOT(total_amount BETWEEN 0 AND 1000000000000)
               OR ABS(total_amount*100-ROUND(total_amount*100))>0.001))
         + (SELECT COUNT(*) FROM main.returns WHERE shift_id=?
             AND (refund_method='cash' AND (status IS NULL OR status='')
               OR total_refund IS NULL
               OR typeof(total_refund) NOT IN ('real','integer')
               OR NOT(total_refund BETWEEN 0 AND 1000000000000)
               OR ABS(total_refund*100-ROUND(total_refund*100))>0.001))
         + (SELECT COUNT(*) FROM main.cash_movements WHERE shift_id=?
             AND (type NOT IN ('receipt','in','disbursement','out')
               OR amount IS NULL OR typeof(amount) NOT IN ('real','integer')
               OR NOT(amount BETWEEN 0 AND 1000000000000)
               OR ABS(amount*100-ROUND(amount*100))>0.001))",
    )
    .bind(shift_id)
    .bind(shift_id)
    .bind(shift_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if malformed != 0 {
        return Err("Malformed or unverified shift cash source prevents closure".into());
    }
    Ok(())
}

async fn account_by_setting_or_code(
    conn: &mut SqliteConnection,
    category: &str,
    code: &str,
) -> Result<Option<i64>, String> {
    let selected: Option<i64> = sqlx::query_scalar(
        "SELECT account_id FROM main.trial_balance_settings WHERE category=? LIMIT 1",
    )
    .bind(category)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| error.to_string())?
    .flatten();
    if let Some(id) = selected.filter(|id| *id > 0) {
        let exists: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM main.accounts WHERE id=? AND COALESCE(is_group,0)=0 LIMIT 1",
        )
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
        if exists.is_some() {
            return Ok(Some(id));
        }
    }
    sqlx::query_scalar(
        "SELECT id FROM main.accounts WHERE code=? AND COALESCE(is_group,0)=0 LIMIT 1",
    )
    .bind(code)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| error.to_string())
}

async fn reconcile_and_close_shift(
    conn: &mut SqliteConnection,
    actor_id: &str,
    input: &CloseShiftInput,
) -> Result<(), String> {
    validate_cash(input.ending_cash_amount)?;
    validate_notes(input.closing_notes.as_deref())?;
    if let Some(id) = input
        .shift_id
        .as_deref()
        .filter(|id| !id.is_empty() && *id != "auto")
    {
        validate_shift_id(id)?;
    }
    begin_shift_write(conn).await?;
    let result = async {
        let pharmacy_id = authorized_shift_pharmacy(conn, actor_id, ShiftPermission::Close).await?;
        let active = match input.shift_id.as_deref() {
            None | Some("") | Some("auto") => existing_open_shift(conn, &pharmacy_id)
                .await?
                .ok_or("لا توجد وردية مفتوحة لإغلاقها")?,
            Some(id) => open_shift_by_id(conn, &pharmacy_id, id)
                .await?
                .ok_or("الوردية غير موجودة أو لا تخص هذه الصيدلية")?,
        };
        let shift_id = active.id;
        let starting_cash = active.starting_cash
            .ok_or("Shift starting cash is missing or unverified")?;
        if !starting_cash.is_finite() || starting_cash < 0.0 || starting_cash > 1_000_000_000_000.0 {
            return Err("Shift starting cash is invalid".into());
        }
        validate_close_shift_sources(conn, &shift_id, &pharmacy_id).await?;
        let sales = sum_for_shift(
            conn,
            &shift_id,
            "SELECT CAST(COALESCE(SUM(total_amount),0) AS REAL) FROM main.sales_invoices
             WHERE shift_id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
               AND (status IS NULL OR status='' OR status IN ('completed','approved'))
               AND payment_method='cash'",
            &pharmacy_id,
        )
        .await?;
        let returns = sum_for_shift(
            conn,
            &shift_id,
            "SELECT CAST(COALESCE(SUM(total_refund),0) AS REAL) FROM main.returns
             WHERE shift_id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
               AND (status IS NULL OR status='' OR LOWER(status) IN ('approved','completed'))
               AND refund_method='cash'",
            &pharmacy_id,
        )
        .await?;
        let movements = sum_for_shift(
            conn,
            &shift_id,
            "SELECT CAST(COALESCE(SUM(CASE WHEN type IN ('receipt','in') THEN amount
               WHEN type IN ('disbursement','out') THEN -amount ELSE 0 END),0) AS REAL)
             FROM main.cash_movements
             WHERE shift_id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
               AND LOWER(COALESCE(source_type,'')) <> 'main_safe'",
            &pharmacy_id,
        )
        .await?;
        let expected_cash = starting_cash + sales - returns + movements;
        let difference = input.ending_cash_amount - expected_cash;
        if !difference.is_finite() {
            return Err("Shift cash reconciliation overflow".into());
        }
        let status = if difference.abs() > 5.0 {
            "discrepancy"
        } else {
            "closed"
        };
        let updated = sqlx::query(
            "UPDATE main.shifts SET end_time=CURRENT_TIMESTAMP,ending_cash=?,actual_cash=?,
             cash_difference=?,notes=?,status=?
             WHERE id=? AND LOWER(COALESCE(status,''))='open'
               AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(input.ending_cash_amount)
        .bind(input.ending_cash_amount)
        .bind(difference)
        .bind(input.closing_notes.as_deref())
        .bind(status)
        .bind(&shift_id)
        .bind(&pharmacy_id)
        .execute(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
        if updated.rows_affected() != 1 {
            return Err("تم إغلاق الوردية أو تعديلها بالفعل".into());
        }
        if difference.abs() > 0.01 {
            let cash_account = account_by_setting_or_code(conn, "cash_drawer", "1.1.1")
                .await?
                .ok_or("Shift cash drawer ledger account is missing")?;
            let diff_account =
                match account_by_setting_or_code(conn, "cash_difference", "4.3").await? {
                    Some(id) => id,
                    None => {
                        sqlx::query(
                            "INSERT OR IGNORE INTO main.accounts
                         (code,name_ar,name_en,type,is_group)
                         VALUES('4.3','عجز وزيادة الخزينة','Cash Shortage/Overage','expense',0)",
                        )
                        .execute(&mut *conn)
                        .await
                        .map_err(|error| error.to_string())?;
                        account_by_setting_or_code(conn, "cash_difference", "4.3")
                            .await?
                            .ok_or("Shift difference ledger account is missing")?
                    }
                };
            if cash_account == diff_account {
                return Err(
                    "Shift reconciliation cannot post both sides to the same ledger account".into(),
                );
            }
            let journal_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO main.daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
                 VALUES(?,date('now','localtime'),?,?,?,?)",
            )
            .bind(&journal_id)
            .bind("تسوية وردية: عجز/زيادة نقدية")
            .bind(actor_id)
            .bind(difference.abs())
            .bind(&pharmacy_id)
            .execute(&mut *conn)
            .await
            .map_err(|error| error.to_string())?;
            let (debit, credit) = if difference > 0.0 {
                (cash_account, diff_account)
            } else {
                (diff_account, cash_account)
            };
            for (account, kind) in [(debit, "debit"), (credit, "credit")] {
                sqlx::query(
                    "INSERT INTO main.journal_entries(journal_id,account_id,type,amount)
                     VALUES(?,?,?,?)",
                )
                .bind(&journal_id)
                .bind(account)
                .bind(kind)
                .bind(difference.abs())
                .execute(&mut *conn)
                .await
                .map_err(|error| error.to_string())?;
            }
        }
        sqlx::query(
            "INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
             VALUES (?,'END_SHIFT',?,?)",
        )
        .bind(actor_id)
        .bind(format!(
            "أنهى الوردية بمبلغ {}. الفرق: {:.2}",
            input.ending_cash_amount, difference,
        ))
        .bind(&pharmacy_id)
        .execute(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
        Ok(())
    }
    .await;
    finish_shift_write(conn, result).await
}

async fn force_close_pharmacy_shifts(
    conn: &mut SqliteConnection,
    actor_id: &str,
) -> Result<u64, String> {
    begin_shift_write(conn).await?;
    let result = async {
        let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
        if !role.trim().eq_ignore_ascii_case("owner") {
            return Err("Only an active authenticated owner may force-close shifts".into());
        }
        let updated = sqlx::query(
            "UPDATE main.shifts SET end_time=CURRENT_TIMESTAMP,status='closed',
             cash_difference=NULL,notes='إغلاق اضطراري من قبل المالك'
             WHERE LOWER(COALESCE(status,''))='open'
               AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(&pharmacy_id)
        .execute(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
        sqlx::query(
            "INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
             VALUES (?,'FORCE_CLOSE_SHIFTS',
               'قام المالك بإغلاق جميع الورديات المفتوحة اضطرارياً',?)",
        )
        .bind(actor_id)
        .bind(&pharmacy_id)
        .execute(&mut *conn)
        .await
        .map_err(|error| error.to_string())?;
        Ok(updated.rows_affected())
    }
    .await;
    finish_shift_write(conn, result).await
}

// Every financial subquery is independently scoped. A foreign sale/return/
// movement may carry an otherwise valid shift_id, so the shift predicate alone
// cannot establish ownership of its cash amount.
const SHIFT_HISTORY_SQL: &str = r#"
    SELECT s.id, s.start_time AS shift_start, s.end_time AS shift_end,
           s.starting_cash AS starting_cash_amount, s.ending_cash AS ending_cash_amount,
           s.actual_cash, s.transfer_amount, s.transfer_target,
           s.treasury_retained_cash, s.cash_difference, s.receiver_id,
           ru.full_name AS receiver_name, s.status, s.notes AS opening_notes,
           s.notes AS closing_notes,
           COALESCE(u.full_name,u.username,s.user_id,'غير معروف') AS full_name,
           COALESCE(u.role,'pharmacist') AS role,
           COALESCE(sales.total_sales,0) AS total_sales,
           COALESCE(rets.total_refunds,0) AS total_refunds,
           COALESCE(moves.net_movements,0) AS net_movements,
           COALESCE(moves.handover_transfers,0) AS handover_transfers
    FROM main.shifts s
    LEFT JOIN main.users u ON
      (CAST(s.user_id AS TEXT)=CAST(u.id AS TEXT)
       OR LOWER(s.user_id)=LOWER(u.username))
      AND COALESCE(NULLIF(TRIM(u.pharmacy_id),''),'local_default')=?
    LEFT JOIN main.users ru ON
      (CAST(s.receiver_id AS TEXT)=CAST(ru.id AS TEXT)
       OR LOWER(s.receiver_id)=LOWER(ru.username))
      AND COALESCE(NULLIF(TRIM(ru.pharmacy_id),''),'local_default')=?
    LEFT JOIN (
      SELECT shift_id,SUM(total_amount) AS total_sales FROM main.sales_invoices
      WHERE COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
        AND payment_method='cash'
        AND (status IS NULL OR status='' OR status IN ('completed','approved'))
      GROUP BY shift_id
    ) sales ON sales.shift_id=s.id
    LEFT JOIN (
      SELECT shift_id,SUM(total_refund) AS total_refunds FROM main.returns
      WHERE COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
        AND refund_method='cash'
        AND (status IS NULL OR status='' OR LOWER(status) IN ('approved','completed'))
      GROUP BY shift_id
    ) rets ON rets.shift_id=s.id
    LEFT JOIN (
      SELECT shift_id,
        SUM(CASE WHEN type IN ('receipt','in') THEN amount
                 WHEN type IN ('disbursement','out') THEN -amount ELSE 0 END)
          AS net_movements,
        SUM(CASE WHEN type IN ('disbursement','out') AND category='handover'
                 THEN amount ELSE 0 END) AS handover_transfers
      FROM main.cash_movements
      WHERE COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
        AND LOWER(COALESCE(source_type,'')) <> 'main_safe'
      GROUP BY shift_id
    ) moves ON moves.shift_id=s.id
    WHERE COALESCE(NULLIF(TRIM(s.pharmacy_id),''),'local_default')=?
      AND (?='all' OR s.status=?)
    ORDER BY COALESCE(datetime(s.start_time),s.start_time) DESC,s.rowid DESC
    LIMIT 101 OFFSET ?
"#;

fn shift_float(row: &Value, key: &str) -> f64 {
    row.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn shift_field(row: &Value, key: &str) -> Value {
    row.get(key).cloned().unwrap_or(Value::Null)
}

fn shift_history_record(row: &Value, show_finance: bool) -> Result<Value, String> {
    let starting = shift_float(row, "starting_cash_amount");
    let cash_sales = shift_float(row, "total_sales");
    let refunds = shift_float(row, "total_refunds");
    let movements = shift_float(row, "net_movements");
    let transferred = shift_float(row, "transfer_amount")
        .max(shift_float(row, "handover_transfers"))
        .max(0.0);
    let mut expected = starting + cash_sales - refunds + movements;
    if row
        .get("transfer_target")
        .and_then(Value::as_str)
        .is_some_and(|target| target.eq_ignore_ascii_case("next_shift"))
        && !shift_field(row, "treasury_retained_cash").is_null()
    {
        expected += transferred - shift_float(row, "treasury_retained_cash");
    }
    if !expected.is_finite() {
        return Err("Invalid shift history cash total".into());
    }
    let mut variance = Value::Null;
    if row.get("status").and_then(Value::as_str) != Some("open") {
        if !shift_field(row, "actual_cash").is_null()
            && !shift_field(row, "cash_difference").is_null()
        {
            variance = json!(shift_float(row, "cash_difference"));
        } else if !shift_field(row, "ending_cash_amount").is_null() {
            variance = json!(shift_float(row, "ending_cash_amount") - expected);
        }
    }
    // Preserve the legacy handover correction for pre-retained-cash records.
    if shift_field(row, "treasury_retained_cash").is_null()
        && !shift_field(row, "cash_difference").is_null()
        && transferred > 0.0
    {
        let stored = shift_float(row, "cash_difference");
        let raw_deficit = shift_float(row, "actual_cash") - (starting + cash_sales - refunds);
        if stored < 0.0 && (stored - raw_deficit).abs() < 2.0 {
            let drawer = if !shift_field(row, "ending_cash_amount").is_null() {
                shift_float(row, "ending_cash_amount")
            } else {
                (shift_float(row, "actual_cash") - transferred).max(0.0)
            };
            variance = json!((drawer + transferred) - (starting + cash_sales - refunds));
        }
    }
    Ok(json!({
        "id": shift_field(row,"id"),
        "shift_start": shift_field(row,"shift_start"),
        "shift_end": shift_field(row,"shift_end"),
        "starting_cash_amount": starting,
        "ending_cash_amount": shift_field(row,"ending_cash_amount"),
        "actual_cash": if show_finance { shift_field(row,"actual_cash") } else { Value::Null },
        "transfer_amount": if show_finance { json!(transferred) } else { Value::Null },
        "transfer_target": if show_finance { shift_field(row,"transfer_target") } else { Value::Null },
        "receiver_id": if show_finance { shift_field(row,"receiver_id") } else { Value::Null },
        "receiver_name": if show_finance { shift_field(row,"receiver_name") } else { Value::Null },
        "expected_cash_amount": if show_finance { json!(expected) } else { Value::Null },
        "cash_difference": if show_finance { variance } else { Value::Null },
        "status": shift_field(row,"status"),
        "opening_notes": shift_field(row,"opening_notes"),
        "closing_notes": shift_field(row,"closing_notes"),
        "profiles": {
            "full_name": shift_field(row,"full_name"),
            "role": shift_field(row,"role")
        }
    }))
}

async fn shift_history(
    conn: &mut SqliteConnection,
    actor_id: &str,
    status: &str,
    page: u32,
) -> Result<ShiftHistoryPage, String> {
    if !matches!(status, "all" | "open" | "closed" | "discrepancy") || page > 500 {
        return Err("Invalid shift history filter or page".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy) =
        authorized_shift_identity(conn, actor_id, ShiftPermission::History).await?;
    let records = fetch_scoped_limited(
        conn,
        SHIFT_HISTORY_SQL,
        vec![
            json!(pharmacy),
            json!(pharmacy),
            json!(pharmacy),
            json!(pharmacy),
            json!(pharmacy),
            json!(pharmacy),
            json!(status),
            json!(status),
            json!(page * 100),
        ],
        ReadLimits {
            max_duration: Duration::from_secs(8),
            max_rows: 101,
            max_bytes: 2 * 1024 * 1024,
        },
    )
    .await?;
    let has_more = records.len() > 100;
    let show_finance = role.eq_ignore_ascii_case("owner") || role.eq_ignore_ascii_case("admin");
    let rows = records
        .iter()
        .take(100)
        .map(|row| shift_history_record(row, show_finance))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ShiftHistoryPage {
        rows,
        has_more,
        next_page: if has_more { Some(page + 1) } else { None },
    })
}

const CURRENT_SHIFT_STATS_SQL: &str = r#"
    SELECT s.id,s.user_id,s.start_time,s.starting_cash,s.status,
       COALESCE((SELECT COUNT(*) FROM main.sales_invoices si
         WHERE si.shift_id=s.id
           AND COALESCE(NULLIF(TRIM(si.pharmacy_id),''),'local_default')=?
           AND (si.status IS NULL OR si.status='' OR si.status IN ('completed','approved','delivered'))),0)
         AS transactions,
       COALESCE((SELECT SUM(si.total_amount) FROM main.sales_invoices si
         WHERE si.shift_id=s.id
           AND COALESCE(NULLIF(TRIM(si.pharmacy_id),''),'local_default')=?
           AND (si.status IS NULL OR si.status='' OR si.status IN ('completed','approved','delivered'))),0)
         AS revenue,
       COALESCE((SELECT SUM(si.total_amount) FROM main.sales_invoices si
         WHERE si.shift_id=s.id
           AND COALESCE(NULLIF(TRIM(si.pharmacy_id),''),'local_default')=?
           AND (si.status IS NULL OR si.status='' OR si.status IN ('completed','approved'))
           AND si.payment_method='cash'),0) AS cash_revenue,
       COALESCE((SELECT SUM(r.total_refund) FROM main.returns r
         WHERE r.shift_id=s.id
           AND COALESCE(NULLIF(TRIM(r.pharmacy_id),''),'local_default')=?
           AND (r.status IS NULL OR r.status='' OR LOWER(r.status) IN ('approved','completed'))
           AND r.refund_method='cash'),0) AS total_refunds,
       COALESCE((SELECT SUM(CASE WHEN m.type IN ('receipt','in') THEN m.amount
                        WHEN m.type IN ('disbursement','out') THEN -m.amount
                        ELSE 0 END) FROM main.cash_movements m
         WHERE m.shift_id=s.id
           AND COALESCE(NULLIF(TRIM(m.pharmacy_id),''),'local_default')=?
           AND LOWER(COALESCE(m.source_type,''))<>'main_safe'),0) AS movements
    FROM main.shifts s
    WHERE s.id=?
      AND LOWER(COALESCE(s.status,''))='open'
      AND COALESCE(NULLIF(TRIM(s.pharmacy_id),''),'local_default')=?
    LIMIT 1
"#;

async fn current_shift_stats(conn: &mut SqliteConnection, actor_id: &str) -> Result<Value, String> {
    // Match the web action: ensure the shared pharmacy shift exists before
    // reading its lifetime sales and current drawer cash.
    let (shift, _) = open_shared_shift(
        conn,
        actor_id,
        0.0,
        "وردية مشتركة أُنشئت تلقائياً",
        ShiftPermission::Ensure,
    )
    .await?;
    reset_cancelled_read_state(conn).await?;
    let pharmacy = authorized_shift_pharmacy(conn, actor_id, ShiftPermission::Ensure).await?;
    let rows = fetch_scoped_limited(
        conn,
        CURRENT_SHIFT_STATS_SQL,
        vec![
            json!(pharmacy),
            json!(pharmacy),
            json!(pharmacy),
            json!(pharmacy),
            json!(pharmacy),
            json!(shift.id),
            json!(pharmacy),
        ],
        ReadLimits {
            max_duration: Duration::from_secs(5),
            max_rows: 1,
            max_bytes: 64 * 1024,
        },
    )
    .await?;
    let row = rows
        .first()
        .ok_or("Open shift was not found for this pharmacy")?;
    let expected = shift_float(row, "starting_cash") + shift_float(row, "cash_revenue")
        - shift_float(row, "total_refunds")
        + shift_float(row, "movements");
    if !expected.is_finite() {
        return Err("Shift cash total overflow".into());
    }
    Ok(json!({
        "id":shift_field(row,"id"), "user_id":shift_field(row,"user_id"),
        "start_time":shift_field(row,"start_time"), "starting_cash":shift_field(row,"starting_cash"),
        "status":shift_field(row,"status"),
        "transactions":shift_field(row,"transactions"), "revenue":shift_field(row,"revenue"),
        "total_refunds":shift_field(row,"total_refunds"), "expected_cash":expected
    }))
}

const SHIFT_RECEIPTS_SQL: &str = r#"
    SELECT si.id, si.total_amount, si.paid_amount, si.remaining_amount,
           COALESCE(NULLIF(si.payment_method,''),'cash') AS payment_method,
           si.discount_amount, si.created_at, si.status,
           CASE WHEN u.id IS NOT NULL THEN si.user_id ELSE NULL END AS user_id,
           si.patient_id, COALESCE(NULLIF(u.full_name,''),'موظف') AS staff_name,
           p.full_name AS patient_name,p.phone AS patient_phone
    FROM main.sales_invoices si
    JOIN main.shifts s ON s.id=si.shift_id
      AND COALESCE(NULLIF(TRIM(s.pharmacy_id),''),'local_default')=?
    LEFT JOIN main.users u ON CAST(u.id AS TEXT)=CAST(si.user_id AS TEXT)
      AND COALESCE(NULLIF(TRIM(u.pharmacy_id),''),'local_default')=?
    -- Historical patients have no pharmacy_id: only a tenant-owned sale
    -- may establish the association and expose this patient's name/phone.
    LEFT JOIN main.patients p ON p.id=si.patient_id
    WHERE si.shift_id=?
      AND COALESCE(NULLIF(TRIM(si.pharmacy_id),''),'local_default')=?
      AND (si.status IS NULL OR si.status='' OR si.status IN ('completed','approved','delivered'))
    ORDER BY si.created_at DESC,si.id DESC
    LIMIT 2001
"#;

const SHIFT_RECEIPT_ITEMS_SQL: &str = r#"
    SELECT si.invoice_id,si.quantity_sold,si.unit_price,si.unit,si.drug_id,
       COALESCE(NULLIF(NULLIF(md.trade_name,''),'Drug ' || md.id),
                NULLIF(NULLIF(md.trade_name_en,''),'Drug ' || md.id),
                md.trade_name,md.trade_name_en,'صنف #' || si.drug_id) AS trade_name,
       COALESCE(NULLIF(NULLIF(md.trade_name_en,''),'Drug ' || md.id),
                NULLIF(NULLIF(md.trade_name,''),'Drug ' || md.id),
                md.trade_name_en,md.trade_name,'صنف #' || si.drug_id) AS trade_name_en,
       md.large_unit,md.medium_unit,md.small_unit
    FROM main.sales_items si
    JOIN main.sales_invoices sale ON sale.id=si.invoice_id
      AND COALESCE(NULLIF(TRIM(sale.pharmacy_id),''),'local_default')=?
      AND sale.shift_id=?
      AND (sale.status IS NULL OR sale.status=''
           OR sale.status IN ('completed','approved','delivered'))
    JOIN main.shifts s ON s.id=sale.shift_id
      AND COALESCE(NULLIF(TRIM(s.pharmacy_id),''),'local_default')=?
    LEFT JOIN main.master_drugs md ON si.drug_id=md.id
    ORDER BY si.invoice_id,si.id
    LIMIT 20001
"#;

async fn shift_receipts(
    conn: &mut SqliteConnection,
    actor_id: &str,
    shift_id: &str,
) -> Result<Vec<Value>, String> {
    validate_shift_id(shift_id)?;
    reset_cancelled_read_state(conn).await?;
    let pharmacy = authorized_shift_pharmacy(conn, actor_id, ShiftPermission::Receipts).await?;
    let owns_shift: Option<String> = sqlx::query_scalar(
        "SELECT id FROM main.shifts
         WHERE id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=? LIMIT 1",
    )
    .bind(shift_id)
    .bind(&pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if owns_shift.is_none() {
        return Err("الوردية غير موجودة أو لا تخص هذه الصيدلية".into());
    }
    let invoices = fetch_scoped_limited(
        conn,
        SHIFT_RECEIPTS_SQL,
        vec![
            json!(pharmacy),
            json!(pharmacy),
            json!(shift_id),
            json!(pharmacy),
        ],
        ReadLimits {
            max_duration: Duration::from_secs(8),
            max_rows: 2001,
            max_bytes: 12 * 1024 * 1024,
        },
    )
    .await?;
    if invoices.len() > 2000 {
        return Err("Shift has more than 2000 receipts; narrow the report period".into());
    }
    if invoices.is_empty() {
        return Ok(Vec::new());
    }
    let items = fetch_scoped_limited(
        conn,
        SHIFT_RECEIPT_ITEMS_SQL,
        vec![json!(pharmacy), json!(shift_id), json!(pharmacy)],
        ReadLimits {
            max_duration: Duration::from_secs(8),
            max_rows: 20001,
            max_bytes: 16 * 1024 * 1024,
        },
    )
    .await?;
    if items.len() > 20000 {
        return Err("Shift has more than 20000 receipt items; narrow the report period".into());
    }
    let mut by_invoice: HashMap<String, Vec<Value>> = HashMap::new();
    for item in items {
        let id = item
            .get("invoice_id")
            .and_then(Value::as_str)
            .ok_or("Receipt item has no invoice id")?
            .to_owned();
        let trade_name = shift_field(&item, "trade_name");
        let trade_name_en = shift_field(&item, "trade_name_en");
        let normalized = json!({
            "quantity_sold":shift_float(&item,"quantity_sold"),
            "unit_price":shift_float(&item,"unit_price"),
            "unit":shift_field(&item,"unit"),
            "units":{
                "large":item.get("large_unit").and_then(Value::as_str)
                    .filter(|s| !s.is_empty()).unwrap_or("علبة"),
                "medium":shift_field(&item,"medium_unit"),
                "small":shift_field(&item,"small_unit")
            },
            "trade_name":trade_name,"trade_name_en":trade_name_en,
            "inventory":{"master_drugs":{
                "trade_name":item.get("trade_name").and_then(Value::as_str)
                    .filter(|s| !s.is_empty()).unwrap_or("صنف غير معروف"),
                "trade_name_en":item.get("trade_name_en").and_then(Value::as_str)
                    .unwrap_or("")
            }}
        });
        by_invoice.entry(id).or_default().push(normalized);
    }
    let mut result = Vec::with_capacity(invoices.len());
    for mut invoice in invoices {
        let id = invoice
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Receipt has no invoice id")?
            .to_owned();
        let patient_name = invoice
            .get("patient_name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let patient = match patient_name {
            Some(name) => json!({"full_name":name,"phone":shift_field(&invoice,"patient_phone")}),
            None => Value::Null,
        };
        let staff = shift_field(&invoice, "staff_name");
        let object = invoice
            .as_object_mut()
            .ok_or("Invalid receipt projection")?;
        object.insert("profiles".into(), json!({"full_name":staff}));
        object.insert("patients".into(), patient);
        object.insert(
            "sales_items".into(),
            json!(by_invoice.remove(&id).unwrap_or_default()),
        );
        result.push(invoice);
    }
    Ok(result)
}

#[tauri::command]
pub async fn get_shift_history_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    status: String,
    page: u32,
) -> Result<ShiftHistoryPage, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    shift_history(&mut conn, actor.as_deref().unwrap(), &status, page).await
}

#[tauri::command]
pub async fn get_current_shift_stats_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<Value, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    current_shift_stats(&mut conn, actor.as_deref().unwrap()).await
}

#[tauri::command]
pub async fn get_shift_receipts_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    shift_id: String,
) -> Result<Vec<Value>, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    shift_receipts(&mut conn, actor.as_deref().unwrap(), &shift_id).await
}

#[tauri::command]
pub async fn ensure_shared_shift_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<SharedShift, String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    let (shift, _) = open_shared_shift(
        &mut conn,
        session.as_deref().unwrap(),
        0.0,
        "وردية مشتركة أُنشئت تلقائياً",
        ShiftPermission::Ensure,
    )
    .await?;
    Ok(shift)
}

/// Handover's implicit shared-shift bootstrap has a stricter permission than
/// generic POS/shift startup. Authorization is re-read inside BEGIN IMMEDIATE;
/// the renderer does not nominate an actor, tenant or shift owner.
#[tauri::command]
pub async fn ensure_handover_shift_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<SharedShift, String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|error| error.to_string())?;
    let (shift, _) = open_shared_shift(
        &mut conn,
        session.as_deref().ok_or("Login required")?,
        0.0,
        "وردية مشتركة أُنشئت تلقائياً للتسليم",
        ShiftPermission::Close,
    )
    .await?;
    // The preexisting legacy schema can contain more than one open shift.
    // Never display one arbitrarily as if a handover could settle them all.
    let pharmacy = authorized_shift_pharmacy(
        &mut conn,
        session.as_deref().ok_or("Login required")?,
        ShiftPermission::Close,
    )
    .await?;
    let open_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.shifts WHERE LOWER(COALESCE(status,''))='open'
         AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
    )
    .bind(&pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if open_count != 1 {
        return Err("Multiple open shifts require manual reconciliation".into());
    }
    // Old NULL/blank pharmacy shifts are not safe handover targets: the
    // settlement command deliberately rejects them, even for local_default.
    let stored_pharmacy: Option<String> =
        sqlx::query_scalar("SELECT pharmacy_id FROM main.shifts WHERE id=?")
            .bind(&shift.id)
            .fetch_one(&mut *conn)
            .await
            .map_err(|error| error.to_string())?;
    if stored_pharmacy.as_deref() != Some(pharmacy.as_str()) {
        return Err("Legacy unowned shift requires manual reconciliation".into());
    }
    Ok(shift)
}

#[tauri::command]
pub async fn current_shared_shift_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<CurrentShiftResult, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    current_shared_shift(&mut conn, actor.as_deref().unwrap()).await
}

#[tauri::command]
pub async fn get_pharmacy_shift_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    shift_id: String,
    open_only: bool,
) -> Result<Option<SharedShift>, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    scoped_shift_by_id(&mut conn, actor.as_deref().unwrap(), &shift_id, open_only).await
}

#[tauri::command]
pub async fn open_shared_shift_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: OpenShiftInput,
) -> Result<OpenShiftResult, String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    let (shift, already_open) = open_shared_shift(
        &mut conn,
        session.as_deref().unwrap(),
        payload.starting_cash_amount,
        payload
            .opening_notes
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("وردية مشتركة"),
        ShiftPermission::Open,
    )
    .await?;
    Ok(OpenShiftResult {
        shift_id: shift.id,
        already_open,
    })
}

#[tauri::command]
pub async fn close_shared_shift_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: CloseShiftInput,
) -> Result<(), String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    reconcile_and_close_shift(&mut conn, session.as_deref().unwrap(), &payload).await
}

#[tauri::command]
pub async fn force_close_pharmacy_shifts_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
) -> Result<(), String> {
    let session = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    force_close_pharmacy_shifts(&mut conn, session.as_deref().unwrap()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{sqlite::SqliteConnectOptions, Connection};

    #[test]
    fn shift_cash_open_and_close_require_exact_finite_cents() {
        for invalid in [20.001, -0.01, f64::NAN, f64::INFINITY, 1_000_000_000_000.01] {
            assert!(validate_cash(invalid).is_err(), "invalid shift cash accepted: {invalid}");
        }
        for valid in [0.0, 0.01, 25.13, 462.0, 1_000_000_000_000.0] {
            assert!(validate_cash(valid).is_ok(), "valid shift cash rejected: {valid}");
        }
    }

    async fn fixture(conn: &mut SqliteConnection) {
        sqlx::raw_sql(
            r#"
            CREATE TABLE users(
                id TEXT PRIMARY KEY,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER
            );
            CREATE TABLE shifts(
                id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,start_time TEXT DEFAULT CURRENT_TIMESTAMP,
                end_time TEXT,starting_cash REAL DEFAULT 0,ending_cash REAL,actual_cash REAL,
                cash_difference REAL,notes TEXT,status TEXT DEFAULT 'open'
            );
            CREATE TABLE sales_invoices(
                id TEXT PRIMARY KEY,shift_id TEXT,pharmacy_id TEXT,total_amount REAL,
                status TEXT,payment_method TEXT
            );
            CREATE TABLE returns(
                id TEXT PRIMARY KEY,shift_id TEXT,pharmacy_id TEXT,total_refund REAL,
                status TEXT,refund_method TEXT
            );
            CREATE TABLE cash_movements(
                id TEXT PRIMARY KEY,shift_id TEXT,pharmacy_id TEXT,amount REAL,type TEXT,
                source_type TEXT
            );
            CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT UNIQUE,is_group INTEGER DEFAULT 0,
                name_ar TEXT,name_en TEXT,type TEXT);
            CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
            CREATE TABLE daily_journals(
                id TEXT PRIMARY KEY,date TEXT,description TEXT,created_by TEXT,
                total_amount REAL,pharmacy_id TEXT
            );
            CREATE TABLE journal_entries(
                id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,type TEXT,amount REAL
            );
            CREATE TABLE activity_log(
                id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT
            );
            INSERT INTO users VALUES
              ('actor-a','cashier','{"can_view_shifts":true,"can_access_pos":true,"acc_can_view_handover":true}','A',1),
              ('actor-b','cashier','{"can_view_shifts":true,"can_access_pos":true,"acc_can_view_handover":true}','B',1),
              ('owner-a','owner','{}','A',1),
              ('denied-a','cashier','{"can_view_shifts":false,"can_access_pos":false,"acc_can_view_handover":false}','A',1),
              ('inactive-a','owner','{}','A',0);
            INSERT INTO accounts VALUES
              (6,'1.1.1',0,'الصندوق','Cash Drawer','asset'),
              (20,'4.3',0,'عجز وزيادة الخزينة','Cash Shortage/Overage','expense');
            INSERT INTO trial_balance_settings VALUES('cash_drawer',6),('cash_difference',20);
            "#,
        ).execute(&mut *conn).await.unwrap();
    }

    fn close(shift_id: Option<&str>, ending_cash: f64) -> CloseShiftInput {
        CloseShiftInput {
            shift_id: shift_id.map(str::to_string),
            ending_cash_amount: ending_cash,
            closing_notes: Some("تسوية".to_string()),
        }
    }

    async fn projection_fixture(conn: &mut SqliteConnection) {
        fixture(conn).await;
        sqlx::raw_sql(
            r#"
            ALTER TABLE users ADD COLUMN username TEXT;
            ALTER TABLE users ADD COLUMN full_name TEXT;
            ALTER TABLE shifts ADD COLUMN transfer_amount REAL DEFAULT 0;
            ALTER TABLE shifts ADD COLUMN transfer_target TEXT;
            ALTER TABLE shifts ADD COLUMN treasury_retained_cash REAL;
            ALTER TABLE shifts ADD COLUMN receiver_id TEXT;
            ALTER TABLE sales_invoices ADD COLUMN user_id TEXT;
            ALTER TABLE sales_invoices ADD COLUMN patient_id TEXT;
            ALTER TABLE sales_invoices ADD COLUMN paid_amount REAL;
            ALTER TABLE sales_invoices ADD COLUMN remaining_amount REAL;
            ALTER TABLE sales_invoices ADD COLUMN discount_amount REAL;
            ALTER TABLE sales_invoices ADD COLUMN created_at TEXT;
            ALTER TABLE cash_movements ADD COLUMN category TEXT;
            CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT,phone TEXT);
            CREATE TABLE master_drugs(
              id INTEGER PRIMARY KEY,trade_name TEXT,trade_name_en TEXT,
              large_unit TEXT,medium_unit TEXT,small_unit TEXT
            );
            CREATE TABLE sales_items(
              id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER,
              quantity_sold REAL,unit_price REAL,unit TEXT
            );
            UPDATE users SET username=id,full_name=id;
            INSERT INTO patients VALUES
              ('patient-a','Patient A','A-PHONE'),('patient-b','Patient B','B-PHONE');
            INSERT INTO master_drugs VALUES (1,'Drug 1','Good English','Box','Strip','Pill');
        "#,
        )
        .execute(&mut *conn)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn native_history_filters_transactions_and_redacts_non_admin_cash_fields() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        projection_fixture(&mut conn).await;
        let (shift, _) = open_shared_shift(&mut conn, "actor-a", 100.0, "A", ShiftPermission::Open)
            .await
            .unwrap();
        let (foreign, _) =
            open_shared_shift(&mut conn, "actor-b", 200.0, "B", ShiftPermission::Open)
                .await
                .unwrap();
        sqlx::query(
            "INSERT INTO sales_invoices(id,shift_id,pharmacy_id,total_amount,status,payment_method)
             VALUES('sales-a',?,'A',60,'completed','cash'),
                   ('spoof-b',?,'B',999,'completed','cash')",
        )
        .bind(&shift.id)
        .bind(&shift.id)
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO returns(id,shift_id,pharmacy_id,total_refund,status,refund_method)
             VALUES('return-a',?,'A',10,'approved','cash'),
                   ('spoof-return',?,'B',400,'approved','cash')",
        )
        .bind(&shift.id)
        .bind(&shift.id)
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO cash_movements(id,shift_id,pharmacy_id,amount,type,source_type,category)
             VALUES('cash-a',?,'A',5,'receipt',NULL,'manual'),
                   ('spoof-cash',?,'B',200,'receipt',NULL,'manual'),
                   ('safe-a',?,'A',500,'receipt','main_safe','manual')",
        )
        .bind(&shift.id)
        .bind(&shift.id)
        .bind(&shift.id)
        .execute(&mut conn)
        .await
        .unwrap();
        let owner = shift_history(&mut conn, "owner-a", "all", 0).await.unwrap();
        assert_eq!(owner.rows.len(), 1);
        assert!(!owner.has_more);
        assert_eq!(owner.rows[0]["expected_cash_amount"], 155.0);
        assert_eq!(owner.rows[0]["starting_cash_amount"], 100.0);
        let cashier = shift_history(&mut conn, "actor-a", "open", 0)
            .await
            .unwrap();
        assert_eq!(cashier.rows.len(), 1);
        assert_eq!(cashier.rows[0]["expected_cash_amount"], Value::Null);
        assert_eq!(cashier.rows[0]["transfer_amount"], Value::Null);
        assert_eq!(
            shift_history(&mut conn, "actor-a", "closed", 0)
                .await
                .unwrap()
                .rows
                .len(),
            0
        );
        assert!(shift_history(&mut conn, "actor-a", "closed' OR 1=1", 0)
            .await
            .is_err());
        assert!(shift_history(&mut conn, "actor-a", "all", 501)
            .await
            .is_err());
        assert!(shift_history(&mut conn, "denied-a", "all", 0)
            .await
            .is_err());
        assert!(shift_history(&mut conn, "inactive-a", "all", 0)
            .await
            .is_err());
        assert!(shift_history(&mut conn, "missing", "all", 0).await.is_err());
        let b = shift_history(&mut conn, "actor-b", "all", 0).await.unwrap();
        assert_eq!(b.rows[0]["id"], foreign.id);
    }

    #[tokio::test]
    async fn native_history_pages_without_silently_dropping_shift_101() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        projection_fixture(&mut conn).await;
        sqlx::raw_sql(
            r#"
            WITH RECURSIVE seq(n) AS (
              SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<101
            )
            INSERT INTO shifts(id,user_id,pharmacy_id,starting_cash,status,start_time)
              SELECT printf('history-%03d',n),'actor-a','A',n,'closed',
                     printf('2026-09-%02d 09:00:00',((n-1)%28)+1)
              FROM seq;
        "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let first = shift_history(&mut conn, "owner-a", "all", 0).await.unwrap();
        assert_eq!(first.rows.len(), 100);
        assert!(first.has_more);
        assert_eq!(first.next_page, Some(1));
        let second = shift_history(&mut conn, "owner-a", "all", 1).await.unwrap();
        assert_eq!(second.rows.len(), 1);
        assert!(!second.has_more);
        assert_eq!(second.next_page, None);
        assert_ne!(first.rows[0]["id"], second.rows[0]["id"]);
    }

    #[tokio::test]
    async fn native_history_preserves_next_shift_handover_and_legacy_variance_correction() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        projection_fixture(&mut conn).await;
        sqlx::raw_sql(
            "INSERT INTO shifts(id,user_id,pharmacy_id,starting_cash,ending_cash,actual_cash,
                                 transfer_amount,transfer_target,treasury_retained_cash,
                                 cash_difference,status)
             VALUES('handover','actor-a','A',100,60,60,20,'next_shift',50,10,'closed'),
                   ('legacy','actor-a','A',100,60,90,20,NULL,NULL,-10,'closed');
             INSERT INTO cash_movements(id,shift_id,pharmacy_id,amount,type,source_type,category)
             VALUES('move-handover','handover','A',20,'disbursement',NULL,'handover'),
                   ('move-legacy','legacy','A',20,'disbursement',NULL,'handover');",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let history = shift_history(&mut conn, "owner-a", "all", 0).await.unwrap();
        let handover = history
            .rows
            .iter()
            .find(|row| row["id"] == "handover")
            .unwrap();
        assert_eq!(handover["expected_cash_amount"], 50.0);
        assert_eq!(handover["cash_difference"], 10.0);
        let legacy = history
            .rows
            .iter()
            .find(|row| row["id"] == "legacy")
            .unwrap();
        assert_eq!(legacy["expected_cash_amount"], 80.0);
        assert_eq!(legacy["cash_difference"], -20.0);
    }

    #[tokio::test]
    async fn native_stats_preserves_cash_and_delivered_revenue_formula_with_tenant_scope() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        projection_fixture(&mut conn).await;
        let (shift, _) = open_shared_shift(&mut conn, "actor-a", 100.0, "A", ShiftPermission::Open)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sales_invoices(id,shift_id,pharmacy_id,total_amount,status,payment_method)
             VALUES('cash-a',?,'A',80,'completed','cash'),
                   ('delivery-a',?,'A',50,'delivered','cash'),
                   ('credit-a',?,'A',20,'approved','credit'),
                   ('foreign-b',?,'B',900,'approved','cash')",
        )
        .bind(&shift.id)
        .bind(&shift.id)
        .bind(&shift.id)
        .bind(&shift.id)
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO returns(id,shift_id,pharmacy_id,total_refund,status,refund_method)
             VALUES('refund-a',?,'A',10,'approved','cash'),
                   ('refund-b',?,'B',100,'approved','cash')",
        )
        .bind(&shift.id)
        .bind(&shift.id)
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO cash_movements(id,shift_id,pharmacy_id,amount,type,source_type,category)
             VALUES('in-a',?,'A',12,'receipt',NULL,'manual'),
                   ('out-a',?,'A',2,'disbursement',NULL,'manual'),
                   ('safe-a',?,'A',500,'receipt','main_safe','manual'),
                   ('spoof-b',?,'B',800,'receipt',NULL,'manual')",
        )
        .bind(&shift.id)
        .bind(&shift.id)
        .bind(&shift.id)
        .bind(&shift.id)
        .execute(&mut conn)
        .await
        .unwrap();
        let stats = current_shift_stats(&mut conn, "actor-a").await.unwrap();
        assert_eq!(stats["transactions"], 3);
        assert_eq!(stats["revenue"], 150.0);
        assert_eq!(stats["total_refunds"], 10.0);
        assert_eq!(stats["expected_cash"], 180.0);
        assert!(current_shift_stats(&mut conn, "inactive-a").await.is_err());
        assert!(current_shift_stats(&mut conn, "denied-a").await.is_err());
    }

    #[tokio::test]
    async fn native_receipts_require_trusted_shift_and_sale_before_joining_patient_or_drugs() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        projection_fixture(&mut conn).await;
        sqlx::query(
            "INSERT INTO users(id,role,permissions,pharmacy_id,is_active,username,full_name)
             VALUES('receipts-a','cashier',
                    '{\"can_view_shifts\":false,\"can_view_receipts\":true,\"can_access_pos\":false}',
                    'A',1,'receipts-a','Receipts Staff')"
        ).execute(&mut conn).await.unwrap();
        let (a, _) = open_shared_shift(&mut conn, "actor-a", 10.0, "A", ShiftPermission::Open)
            .await
            .unwrap();
        let (b, _) = open_shared_shift(&mut conn, "actor-b", 10.0, "B", ShiftPermission::Open)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO sales_invoices(id,shift_id,pharmacy_id,user_id,patient_id,total_amount,status,payment_method,created_at)
             VALUES('invoice-a',?,'A','actor-a','patient-a',60,'delivered',NULL,'2026-10-11'),
                   ('foreign-attached',?,'B','actor-b','patient-b',700,'completed','cash','2026-10-11'),
                   ('invoice-b',?,'B','actor-b','patient-b',70,'completed','cash','2026-10-11')"
        ).bind(&a.id).bind(&a.id).bind(&b.id)
          .execute(&mut conn).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO sales_items(invoice_id,drug_id,quantity_sold,unit_price,unit)
               VALUES('invoice-a',1,2,30,'large'),
                     ('foreign-attached',1,1,700,'large'),
                     ('invoice-b',1,1,70,'large')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let receipts = shift_receipts(&mut conn, "actor-a", &a.id).await.unwrap();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0]["id"], "invoice-a");
        assert_eq!(receipts[0]["patients"]["phone"], "A-PHONE");
        assert_eq!(receipts[0]["sales_items"][0]["trade_name"], "Good English");
        assert_eq!(receipts[0]["sales_items"][0]["units"]["large"], "Box");
        assert_eq!(
            shift_receipts(&mut conn, "receipts-a", &a.id)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(shift_history(&mut conn, "receipts-a", "all", 0)
            .await
            .is_err());
        let text = serde_json::to_string(&receipts).unwrap();
        assert!(!text.contains("B-PHONE"));
        assert!(!text.contains("foreign-attached"));
        assert!(shift_receipts(&mut conn, "actor-a", &b.id).await.is_err());
        assert!(shift_receipts(&mut conn, "actor-a", "missing")
            .await
            .is_err());
        assert!(
            shift_receipts(&mut conn, "actor-a", "x'; DROP TABLE shifts;--")
                .await
                .is_err()
        );
        assert!(shift_receipts(&mut conn, "denied-a", &a.id).await.is_err());
        assert!(shift_receipts(&mut conn, "inactive-a", &a.id)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn native_open_shifts_share_one_pharmacy_drawer_and_reject_denied_or_inactive_users() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        fixture(&mut conn).await;
        let (a, exists) = open_shared_shift(
            &mut conn,
            "actor-a",
            100.0,
            "وردية مشتركة",
            ShiftPermission::Open,
        )
        .await
        .unwrap();
        assert!(!exists);
        assert_eq!(a.user_id, "actor-a");
        assert_eq!(a.starting_cash, Some(100.0));
        let (repeat, already) = open_shared_shift(
            &mut conn,
            "owner-a",
            999.0,
            "different",
            ShiftPermission::Open,
        )
        .await
        .unwrap();
        assert!(already);
        assert_eq!(repeat.id, a.id);
        assert_eq!(repeat.starting_cash, Some(100.0));
        let (b, _) = open_shared_shift(&mut conn, "actor-b", 30.0, "B", ShiftPermission::Open)
            .await
            .unwrap();
        assert_ne!(a.id, b.id);
        for denied in ["denied-a", "inactive-a", "missing"] {
            assert!(
                open_shared_shift(&mut conn, denied, 0.0, "denied", ShiftPermission::Open)
                    .await
                    .is_err()
            );
            assert!(
                reconcile_and_close_shift(&mut conn, denied, &close(Some(&a.id), 100.0))
                    .await
                    .is_err()
            );
        }
        assert!(open_shared_shift(
            &mut conn,
            "actor-a",
            f64::INFINITY,
            "bad",
            ShiftPermission::Open
        )
        .await
        .is_err());
        assert!(
            open_shared_shift(&mut conn, "actor-a", -1.0, "bad", ShiftPermission::Open)
                .await
                .is_err()
        );
        let audits: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM activity_log WHERE action='START_SHIFT' AND pharmacy_id='A'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(audits, 1);
    }

    #[tokio::test]
    async fn native_close_uses_same_cash_formula_and_double_entry_with_pharmacy_bound_totals() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        fixture(&mut conn).await;
        let (shift, _) = open_shared_shift(
            &mut conn,
            "actor-a",
            100.0,
            "opening",
            ShiftPermission::Open,
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO sales_invoices VALUES('sale-a',?,'A',80,'completed','cash')")
            .bind(&shift.id)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_invoices VALUES('pending',?,'A',500,'draft','cash')")
            .bind(&shift.id)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO returns VALUES('ret',?,'A',20,'approved','cash')")
            .bind(&shift.id)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cash_movements VALUES('in',?,'A',15,'receipt',NULL)")
            .bind(&shift.id)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cash_movements VALUES('out',?,'A',5,'disbursement',NULL)")
            .bind(&shift.id)
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cash_movements VALUES('safe',?,'A',200,'receipt','main_safe')")
            .bind(&shift.id)
            .execute(&mut conn)
            .await
            .unwrap();
        // 100 + 80 - 20 + (15 - 5) = 170, actual 160 => shortage -10.
        reconcile_and_close_shift(&mut conn, "actor-a", &close(Some(&shift.id), 160.0))
            .await
            .unwrap();
        let row: (String, f64, f64, f64) = sqlx::query_as(
            "SELECT status,ending_cash,actual_cash,cash_difference FROM shifts WHERE id=?",
        )
        .bind(&shift.id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(row, ("discrepancy".into(), 160.0, 160.0, -10.0));
        let entries: Vec<(i64, String, f64)> =
            sqlx::query_as("SELECT account_id,type,amount FROM journal_entries ORDER BY id")
                .fetch_all(&mut conn)
                .await
                .unwrap();
        assert_eq!(
            entries,
            vec![(20, "debit".into(), 10.0), (6, "credit".into(), 10.0)]
        );
        let amount: f64 = sqlx::query_scalar("SELECT total_amount FROM daily_journals")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(amount, 10.0);
        let journal_pharmacy: String = sqlx::query_scalar("SELECT pharmacy_id FROM daily_journals")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(journal_pharmacy, "A");
        let audits: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM activity_log WHERE action='END_SHIFT' AND pharmacy_id='A'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(audits, 1);
        assert!(
            reconcile_and_close_shift(&mut conn, "actor-a", &close(Some(&shift.id), 160.0))
                .await
                .is_err()
        );
        let journal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(journal_count, 1);
    }

    #[tokio::test]
    async fn native_close_cash_reconciliation_counts_cash_sale_and_refund_once_but_not_bank() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        fixture(&mut conn).await;
        let (shift, _) =
            open_shared_shift(&mut conn, "actor-a", 0.0, "opening", ShiftPermission::Open)
                .await
                .unwrap();
        sqlx::query(
            "INSERT INTO sales_invoices VALUES
            ('cash-300',?,'A',300,'completed','cash'),
            ('bank-25',?,'A',25,'completed','visa')",
        )
        .bind(&shift.id)
        .bind(&shift.id)
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO returns VALUES
            ('cash-refund-150',?,'A',150,'approved','cash'),
            ('bank-refund-25',?,'A',25,'completed','bank')",
        )
        .bind(&shift.id)
        .bind(&shift.id)
        .execute(&mut conn)
        .await
        .unwrap();
        reconcile_and_close_shift(&mut conn, "actor-a", &close(Some(&shift.id), 150.0))
            .await
            .unwrap();
        let row: (String, f64) =
            sqlx::query_as("SELECT status,cash_difference FROM shifts WHERE id=?")
                .bind(&shift.id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(row, ("closed".into(), 0.0));
        let journals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            journals, 0,
            "normal cash accounting must not post a fabricated variance"
        );
    }

    #[tokio::test]
    async fn native_close_rejects_foreign_legacy_corrupt_and_unknown_history_without_posting() {
        for (label, sql) in [
            ("foreign sale", "INSERT INTO sales_invoices VALUES('foreign','shift-a','B',999,'completed','cash')"),
            ("unowned sale", "INSERT INTO sales_invoices VALUES('unowned','shift-a',NULL,999,'completed','cash')"),
            ("unowned refund", "INSERT INTO returns VALUES('unowned','shift-a',NULL,200,'approved','cash')"),
            ("negative cash sale", "INSERT INTO sales_invoices VALUES('negative','shift-a','A',-20,'completed','cash')"),
            ("text cash refund", "INSERT INTO returns VALUES('text','shift-a','A','garbage','approved','cash')"),
            ("orphan movement", "INSERT INTO cash_movements VALUES('orphan','shift-a',NULL,20,'receipt',NULL)"),
            ("negative movement", "INSERT INTO cash_movements VALUES('negative','shift-a','A',-10,'receipt',NULL)"),
            ("unknown movement", "INSERT INTO cash_movements VALUES('unknown','shift-a','A',10,'adjustment',NULL)"),
        ] {
            let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
            fixture(&mut conn).await;
            sqlx::query("INSERT INTO shifts(id,user_id,pharmacy_id,starting_cash,status)
                VALUES('shift-a','actor-a','A',0,'open')")
                .execute(&mut conn).await.unwrap();
            sqlx::query(sql).execute(&mut conn).await.unwrap();
            assert!(reconcile_and_close_shift(&mut conn, "actor-a", &close(Some("shift-a"), 0.0))
                .await.is_err(), "{label}");
            let state: (String, Option<f64>) = sqlx::query_as(
                "SELECT status,cash_difference FROM shifts WHERE id='shift-a'")
                .fetch_one(&mut conn).await.unwrap();
            assert_eq!(state, ("open".into(), None), "{label} must keep drawer open");
            let journal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
                .fetch_one(&mut conn).await.unwrap();
            assert_eq!(journal_count, 0, "{label} must not post a cash journal");
        }
    }

    #[tokio::test]
    async fn native_close_rejects_foreign_and_stale_shift_identifiers() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        fixture(&mut conn).await;
        let (a, _) = open_shared_shift(&mut conn, "actor-a", 50.0, "A", ShiftPermission::Open)
            .await
            .unwrap();
        let (b, _) = open_shared_shift(&mut conn, "actor-b", 60.0, "B", ShiftPermission::Open)
            .await
            .unwrap();
        assert!(
            reconcile_and_close_shift(&mut conn, "actor-a", &close(Some(&b.id), 50.0))
                .await
                .is_err()
        );
        for hostile in ["x'; DROP TABLE shifts;--", "id\0hidden"] {
            assert!(
                reconcile_and_close_shift(&mut conn, "actor-a", &close(Some(hostile), 50.0))
                    .await
                    .is_err()
            );
        }
        assert!(
            reconcile_and_close_shift(&mut conn, "actor-a", &close(Some("stale"), 50.0))
                .await
                .is_err()
        );
        let status: String = sqlx::query_scalar("SELECT status FROM shifts WHERE id=?")
            .bind(&a.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(status, "open");
        // No stale/foreign denial changes another tenant's cash or journal.
        assert!(
            sqlx::query_scalar::<_, String>("SELECT status FROM shifts WHERE id=?")
                .bind(&b.id)
                .fetch_one(&mut conn)
                .await
                .unwrap()
                == "open"
        );
        // Some legacy databases may carry two pre-constraint open rows.
        // Explicit same-tenant selection must close the selected row, not
        // silently close the first open shift or reject a legitimate drawer.
        sqlx::query(
            "INSERT INTO shifts(id,user_id,pharmacy_id,starting_cash,status)
             VALUES('legacy-second-open','actor-a','A',25,'open')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        reconcile_and_close_shift(
            &mut conn,
            "actor-a",
            &close(Some("legacy-second-open"), 25.0),
        )
        .await
        .unwrap();
        let selected: String =
            sqlx::query_scalar("SELECT status FROM shifts WHERE id='legacy-second-open'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(selected, "closed");
        let first: String = sqlx::query_scalar("SELECT status FROM shifts WHERE id=?")
            .bind(&a.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(first, "open");
    }

    #[tokio::test]
    async fn native_emergency_force_close_is_owner_only_pharmacy_scoped_and_atomic() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        fixture(&mut conn).await;
        let (a, _) = open_shared_shift(&mut conn, "actor-a", 80.0, "A", ShiftPermission::Open)
            .await
            .unwrap();
        let (b, _) = open_shared_shift(&mut conn, "actor-b", 90.0, "B", ShiftPermission::Open)
            .await
            .unwrap();
        for denied in ["actor-a", "denied-a", "inactive-a", "missing"] {
            assert!(force_close_pharmacy_shifts(&mut conn, denied)
                .await
                .is_err());
        }
        let after_denials: String = sqlx::query_scalar("SELECT status FROM shifts WHERE id=?")
            .bind(&a.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(after_denials, "open");
        sqlx::raw_sql(
            "CREATE TRIGGER reject_force_audit BEFORE INSERT ON activity_log
             WHEN NEW.action='FORCE_CLOSE_SHIFTS'
             BEGIN SELECT RAISE(ABORT,'forced audit rollback'); END;",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        assert!(force_close_pharmacy_shifts(&mut conn, "owner-a")
            .await
            .is_err());
        let after_rollback: String = sqlx::query_scalar("SELECT status FROM shifts WHERE id=?")
            .bind(&a.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(after_rollback, "open");
        sqlx::query("DROP TRIGGER reject_force_audit")
            .execute(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            force_close_pharmacy_shifts(&mut conn, "owner-a")
                .await
                .unwrap(),
            1
        );
        let closed: String = sqlx::query_scalar("SELECT status FROM shifts WHERE id=?")
            .bind(&a.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(closed, "closed");
        let foreign: String = sqlx::query_scalar("SELECT status FROM shifts WHERE id=?")
            .bind(&b.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(foreign, "open");
        let audit_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM activity_log WHERE action='FORCE_CLOSE_SHIFTS' AND pharmacy_id='A'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!(audit_count, 1);
    }

    #[tokio::test]
    async fn handover_shift_bootstrap_requires_live_handover_permission_not_only_pos_access() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        fixture(&mut conn).await;
        // A cashier may have POS access but explicitly lack handover rights.
        sqlx::query("UPDATE users SET permissions=? WHERE id='actor-a'")
            .bind(r#"{"can_access_pos":true,"can_view_shifts":true,"acc_can_view_handover":false}"#)
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(open_shared_shift(
            &mut conn,
            "actor-a",
            0.0,
            "handover",
            ShiftPermission::Close
        )
        .await
        .is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shifts")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 0, "denial must not create a shared shift");
        // The old generic POS bootstrap is independently authorized.
        let (pos_shift, _) =
            open_shared_shift(&mut conn, "actor-a", 0.0, "POS", ShiftPermission::Ensure)
                .await
                .unwrap();
        assert_eq!(pos_shift.status, "open");
        assert!(
            open_shared_shift(
                &mut conn,
                "actor-a",
                0.0,
                "handover",
                ShiftPermission::Close
            )
            .await
            .is_err(),
            "having an existing shift does not bypass live permission"
        );
        sqlx::query("UPDATE users SET permissions=? WHERE id='actor-a'")
            .bind(r#"{"can_access_pos":true,"acc_can_view_handover":true}"#)
            .execute(&mut conn)
            .await
            .unwrap();
        let (handover_shift, already_open) = open_shared_shift(
            &mut conn,
            "actor-a",
            0.0,
            "handover",
            ShiftPermission::Close,
        )
        .await
        .unwrap();
        assert!(already_open);
        assert_eq!(handover_shift.id, pos_shift.id);
        assert!(open_shared_shift(
            &mut conn,
            "inactive-a",
            0.0,
            "handover",
            ShiftPermission::Close
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn native_current_and_selected_shift_reads_never_use_caller_pharmacy_claims() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        fixture(&mut conn).await;
        let (a, _) = open_shared_shift(&mut conn, "actor-a", 25.0, "A", ShiftPermission::Open)
            .await
            .unwrap();
        let (b, _) = open_shared_shift(&mut conn, "actor-b", 90.0, "B", ShiftPermission::Open)
            .await
            .unwrap();
        let current = current_shared_shift(&mut conn, "actor-a").await.unwrap();
        assert_eq!(current.shift.id, a.id);
        assert_eq!(current.suggested_starting_cash, 0.0);
        assert!(scoped_shift_by_id(&mut conn, "actor-a", &b.id, false)
            .await
            .unwrap()
            .is_none());
        assert!(scoped_shift_by_id(&mut conn, "denied-a", &a.id, false)
            .await
            .is_err());
        assert!(scoped_shift_by_id(&mut conn, "inactive-a", &a.id, false)
            .await
            .is_err());
        let own = scoped_shift_by_id(&mut conn, "actor-a", &a.id, true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(own.starting_cash, Some(25.0));
        reconcile_and_close_shift(&mut conn, "actor-a", &close(Some(&a.id), 25.0))
            .await
            .unwrap();
        assert!(scoped_shift_by_id(&mut conn, "actor-a", &a.id, true)
            .await
            .unwrap()
            .is_none());
        assert!(scoped_shift_by_id(&mut conn, "actor-a", &a.id, false)
            .await
            .unwrap()
            .is_some());
        let next = current_shared_shift(&mut conn, "actor-a").await.unwrap();
        assert_ne!(next.shift.id, a.id);
        assert_eq!(next.suggested_starting_cash, 25.0);
    }

    #[tokio::test]
    async fn native_close_rollback_restores_shift_if_journal_or_audit_fails() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        fixture(&mut conn).await;
        let (shift, _) = open_shared_shift(&mut conn, "actor-a", 100.0, "A", ShiftPermission::Open)
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TRIGGER deny_journal BEFORE INSERT ON journal_entries
             BEGIN SELECT RAISE(ABORT,'synthetic ledger failure'); END;",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        assert!(
            reconcile_and_close_shift(&mut conn, "actor-a", &close(Some(&shift.id), 90.0))
                .await
                .is_err()
        );
        let (status, ending, diff): (String, Option<f64>, Option<f64>) =
            sqlx::query_as("SELECT status,ending_cash,cash_difference FROM shifts WHERE id=?")
                .bind(&shift.id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(status, "open");
        assert!(ending.is_none() && diff.is_none());
        let journals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(journals, 0);
        sqlx::query("DROP TRIGGER deny_journal")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql(
            "CREATE TRIGGER deny_close_audit BEFORE INSERT ON activity_log
             WHEN NEW.action='END_SHIFT'
             BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        assert!(
            reconcile_and_close_shift(&mut conn, "actor-a", &close(Some(&shift.id), 100.0))
                .await
                .is_err()
        );
        let status_after: String = sqlx::query_scalar("SELECT status FROM shifts WHERE id=?")
            .bind(&shift.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(status_after, "open");
    }

    #[tokio::test]
    async fn native_begin_immediate_serializes_two_openers_and_prevents_close_replay() {
        let path = std::env::temp_dir().join(format!(
            "pharma-shift-native-synthetic-{}.db",
            Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(std::time::Duration::from_secs(4));
        let mut first = SqliteConnection::connect_with(&options).await.unwrap();
        fixture(&mut first).await;
        let mut second = SqliteConnection::connect_with(&options).await.unwrap();
        let (a, b) = tokio::join!(
            open_shared_shift(&mut first, "actor-a", 25.0, "first", ShiftPermission::Open),
            open_shared_shift(
                &mut second,
                "owner-a",
                90.0,
                "second",
                ShiftPermission::Open
            ),
        );
        let (a, b) = (a.unwrap(), b.unwrap());
        assert_eq!(a.0.id, b.0.id);
        assert_ne!(a.1, b.1);
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM shifts WHERE pharmacy_id='A' AND status='open'",
        )
        .fetch_one(&mut first)
        .await
        .unwrap();
        assert_eq!(count, 1);
        let close_a = close(Some(&a.0.id), 25.0);
        let close_b = close(Some(&a.0.id), 25.0);
        let (close_one, close_two) = tokio::join!(
            reconcile_and_close_shift(&mut first, "actor-a", &close_a),
            reconcile_and_close_shift(&mut second, "owner-a", &close_b),
        );
        assert_ne!(close_one.is_ok(), close_two.is_ok());
        let audits: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM activity_log WHERE action='END_SHIFT'")
                .fetch_one(&mut first)
                .await
                .unwrap();
        assert_eq!(audits, 1);
        first.close().await.unwrap();
        second.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn production_001_through_032_compatibility_supports_real_atomic_native_shift_lifecycle()
    {
        // Isolated synthetic SQLite file using the actual licensed startup
        // migration list and compatibility order. Never touch bundled or
        // operator-managed databases.
        let path = std::env::temp_dir().join(format!(
            "pharma-shift-full-schema-synthetic-{}.db",
            Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(std::time::Duration::from_secs(4));
        let all = crate::app_migrations();
        assert_eq!(all.len(), 69);
        let migrations: Vec<sqlx::migrate::Migration> = all
            .into_iter()
            .map(|item| {
                sqlx::migrate::Migration::new(
                    item.version,
                    item.description.into(),
                    sqlx::migrate::MigrationType::ReversibleUp,
                    item.sql.into(),
                    false,
                )
            })
            .collect();
        let first = sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(migrations[..1].to_vec()),
            ..sqlx::migrate::Migrator::DEFAULT
        };
        let complete = sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(migrations),
            ..sqlx::migrate::Migrator::DEFAULT
        };
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        first.run(&mut conn).await.unwrap();
        conn.close().await.unwrap();
        let path_for_prepare = path.clone();
        let refused = tokio::task::spawn_blocking(move || {
            crate::schema::prepare_legacy_database(&path_for_prepare)
        })
        .await
        .unwrap();
        assert!(refused.is_err(), "Existing v001 source may not bypass native owner review");
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        // Setup of this entirely synthetic migration-001 fixture is test-only,
        // never a replacement for guarded real-customer preparation.
        crate::schema::prepare_registered_001_synthetic_test_connection(&mut conn)
            .await.unwrap();
        complete.run(&mut conn).await.unwrap();
        sqlx::query(
            "INSERT INTO users(id,username,role,permissions,pharmacy_id,is_active)
            VALUES('synthetic-shift-actor','synthetic-shift-actor','cashier',
              '{\"can_view_shifts\":true,\"acc_can_view_handover\":true}',
              'A',1)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let (created, already) = open_shared_shift(
            &mut conn,
            "synthetic-shift-actor",
            40.0,
            "Synthetic drawer",
            ShiftPermission::Open,
        )
        .await
        .unwrap();
        assert!(!already);
        reconcile_and_close_shift(
            &mut conn,
            "synthetic-shift-actor",
            &close(Some(&created.id), 44.0),
        )
        .await
        .unwrap();
        let (status, difference): (String, f64) =
            sqlx::query_as("SELECT status,cash_difference FROM shifts WHERE id=?")
                .bind(&created.id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(status, "closed");
        assert_eq!(difference, 4.0);
        let (journal_pharmacy, journal_amount): (String, f64) =
            sqlx::query_as("SELECT pharmacy_id,total_amount FROM daily_journals LIMIT 1")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(journal_pharmacy, "A");
        assert_eq!(journal_amount, 4.0);
        assert!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations WHERE success=1")
                .fetch_one(&mut conn)
                .await
                .unwrap()
                >= 32
        );
        conn.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }
}
