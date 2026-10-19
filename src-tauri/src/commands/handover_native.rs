//! Atomic normal shared-drawer handover. Managed-staff account closures are
//! intentionally not implemented here and fail serde's unknown-field policy.
//! The authenticated session and live SQLite actor/receiver are authoritative.
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::{verify_handover_password_on_connection, LocalSessionState};
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

const MAX_CASH: f64 = 1_000_000_000_000.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalHandoverInput {
    shift_id: String,
    actual_cash: f64,
    transfer_amount: f64,
    transfer_target_type: String,
    transfer_target_id: Option<String>,
    receiver_username: String,
    receiver_password: String,
    notes: Option<String>,
    request_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalHandoverPosted {
    difference: f64,
    remaining_cash: f64,
    status: String,
    new_shift_id: String,
    starting_cash: f64,
    receiver_id: String,
    transfer_target_type: String,
}

fn text_ok(text: &str, cap: usize) -> bool {
    !text.trim().is_empty()
        && text.len() <= cap
        && !text.chars().any(|c| c == '\0' || c.is_control())
}
fn notes_ok(text: Option<&str>) -> bool {
    text.map_or(true, |notes| {
        notes.len() <= 2000
            && !notes
                .chars()
                .any(|c| c == '\0' || (c.is_control() && c != '\n'))
    })
}
fn cash_ok(value: f64) -> bool {
    value.is_finite()
        && (0.0..=MAX_CASH).contains(&value)
        && (value * 100.0 - (value * 100.0).round()).abs() <= 0.000_001
}
fn validate(input: &NormalHandoverInput) -> Result<Option<i64>, String> {
    if !text_ok(&input.shift_id, 128)
        || !text_ok(&input.request_id, 128)
        || !text_ok(&input.receiver_username, 256)
        || !(16..=128).contains(&input.request_id.len())
        || input.receiver_password.is_empty()
        || input.receiver_password.trim().is_empty()
        || !notes_ok(input.notes.as_deref())
        || !cash_ok(input.actual_cash)
        || !cash_ok(input.transfer_amount)
        || input.transfer_amount > input.actual_cash
        || !matches!(
            input.transfer_target_type.as_str(),
            "bank" | "pos" | "treasury" | "next_shift"
        )
    {
        return Err("Invalid normal handover intent or cash amount".into());
    }
    let target = match input.transfer_target_type.as_str() {
        "bank" | "pos" => {
            let raw = input
                .transfer_target_id
                .as_deref()
                .ok_or("Destination ID required")?;
            if raw.is_empty()
                || raw.starts_with('+')
                || (raw.len() > 15)
                || !raw.bytes().all(|b| b.is_ascii_digit())
            {
                return Err("Invalid handover destination ID".into());
            }
            let id = raw.parse::<i64>().map_err(|_| "Invalid destination ID")?;
            if id <= 0 {
                return Err("Invalid destination ID".into());
            }
            Some(id)
        }
        _ => {
            if input
                .transfer_target_id
                .as_deref()
                .is_some_and(|id| !id.is_empty())
            {
                return Err("Internal handover must not select a destination account".into());
            }
            None
        }
    };
    Ok(target)
}

async fn live_pharmacy(conn: &mut SqliteConnection, actor: &str) -> Result<String, String> {
    let (role, pharmacy) = active_generic_actor(conn, actor).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
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
        return Err("Native normal handover permission required".into());
    }
    Ok(pharmacy)
}

async fn account(conn: &mut SqliteConnection, category: &str, code: &str) -> Result<i64, String> {
    // Configured policy wins only for its canonical code and a leaf account.
    // A forged/retired foreign-target settings row cannot direct bank funds.
    let mapped: Option<i64> = sqlx::query_scalar(
        "SELECT a.id FROM main.trial_balance_settings t JOIN main.accounts a
         ON a.id=t.account_id WHERE t.category=? AND a.code=?
         AND COALESCE(a.is_group,0)=0 ORDER BY a.id LIMIT 1",
    )
    .bind(category)
    .bind(code)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(value) = mapped {
        return Ok(value);
    }
    sqlx::query_scalar(
        "SELECT id FROM main.accounts WHERE code=?
         AND COALESCE(is_group,0)=0 LIMIT 1",
    )
    .bind(code)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Required handover posting leaf account {code} missing"))
}

async fn destination_bank_account(
    conn: &mut SqliteConnection,
    bank_id: i64,
) -> Result<i64, String> {
    // Legacy finance.ts supports a per-bank leaf mapping in
    // trial_balance_settings category bank:<id>. The ID is only used AFTER
    // verifying the destination bank belongs to the authenticated tenant.
    // Never accept a renderer-provided ledger account ID.
    let target = format!("bank:{bank_id}");
    let mapping: Option<Option<i64>> = sqlx::query_scalar(
        "SELECT account_id FROM main.trial_balance_settings WHERE category=? LIMIT 1",
    )
    .bind(target)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(mapped) = mapping {
        let account_id = mapped.ok_or("Bank-specific mapping has no account")?;
        let found: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM main.accounts WHERE id=? AND COALESCE(is_group,0)=0 LIMIT 1",
        )
        .bind(account_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        return found
            .ok_or_else(|| "Bank-specific posting account is missing or a group".to_string());
    }
    account(conn, "bank_clearing", "1.1.4").await
}

async fn post_journal(
    conn: &mut SqliteConnection,
    actor: &str,
    pharmacy: &str,
    memo: &str,
    amount: f64,
    debit: i64,
    credit: i64,
) -> Result<(), String> {
    if debit == credit || amount <= 0.0 || !amount.is_finite() {
        return Err("Invalid balanced handover journal".into());
    }
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO main.daily_journals
       (id,date,description,created_by,total_amount,pharmacy_id)
       VALUES(?,date('now','localtime'),?,?,?,?)",
    )
    .bind(&id)
    .bind(memo)
    .bind(actor)
    .bind(amount)
    .bind(pharmacy)
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    for (account, side) in [(debit, "debit"), (credit, "credit")] {
        sqlx::query(
            "INSERT INTO main.journal_entries(journal_id,account_id,type,amount)
           VALUES(?,?,?,?)",
        )
        .bind(&id)
        .bind(account)
        .bind(side)
        .bind(amount)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn checked_sum(
    conn: &mut SqliteConnection,
    sql: &'static str,
    shift: &str,
    pharmacy: &str,
) -> Result<f64, String> {
    let total: Option<f64> = sqlx::query_scalar(sql)
        .bind(shift)
        .bind(pharmacy)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    let value = total.ok_or("Ambiguous or invalid handover amount")?;
    if !value.is_finite() || value.abs() > MAX_CASH {
        return Err("Invalid or overflowed handover history".into());
    }
    Ok(value)
}

async fn reconcile(
    conn: &mut SqliteConnection,
    shift: &str,
    pharmacy: &str,
    starting: f64,
) -> Result<f64, String> {
    // The shared shift cannot include unowned or other-branch payments even
    // when they would not affect cash today: old ambiguous links need manual
    // reconciliation, not guessing a tenant.
    let mismatches: i64 = sqlx::query_scalar(
        "SELECT
          (SELECT COUNT(*) FROM main.sales_invoices WHERE shift_id=?
            AND (NULLIF(TRIM(pharmacy_id),'') IS NULL OR pharmacy_id<>?))
        + (SELECT COUNT(*) FROM main.returns WHERE shift_id=?
            AND (NULLIF(TRIM(pharmacy_id),'') IS NULL OR pharmacy_id<>?))
        + (SELECT COUNT(*) FROM main.cash_movements WHERE shift_id=?
            AND (NULLIF(TRIM(pharmacy_id),'') IS NULL OR pharmacy_id<>?))",
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
    if mismatches > 0 {
        return Err("Shift contains foreign or unowned payment history".into());
    }
    let malformed: i64 = sqlx::query_scalar(
        "SELECT (SELECT COUNT(*) FROM main.sales_invoices WHERE shift_id=? AND
             payment_method='cash' AND (total_amount IS NULL
                OR typeof(total_amount) NOT IN ('real','integer') OR total_amount<0))
           + (SELECT COUNT(*) FROM main.returns WHERE shift_id=? AND
             refund_method='cash' AND (total_refund IS NULL
                OR typeof(total_refund) NOT IN ('real','integer') OR total_refund<0))
           + (SELECT COUNT(*) FROM main.cash_movements WHERE shift_id=? AND
             (type NOT IN ('receipt','in','disbursement','out') OR amount IS NULL
               OR typeof(amount) NOT IN ('real','integer') OR amount<0))",
    )
    .bind(shift)
    .bind(shift)
    .bind(shift)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if malformed > 0 {
        return Err("Shift contains malformed accounting history".into());
    }
    let sales = checked_sum(
        conn,
        "SELECT CAST(COALESCE(SUM(total_amount),0) AS REAL) FROM main.sales_invoices
       WHERE shift_id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
       AND (status IS NULL OR status='' OR status IN ('completed','approved'))
       AND payment_method='cash'",
        shift,
        pharmacy,
    )
    .await?;
    let refunds = checked_sum(
        conn,
        "SELECT CAST(COALESCE(SUM(total_refund),0) AS REAL) FROM main.returns
       WHERE shift_id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
       AND (status IS NULL OR status='' OR LOWER(status) IN ('approved','completed'))
       AND refund_method='cash'",
        shift,
        pharmacy,
    )
    .await?;
    let movements = checked_sum(
        conn,
        "SELECT CAST(COALESCE(SUM(CASE
       WHEN type IN ('receipt','in') THEN amount
       WHEN type IN ('disbursement','out') THEN -amount
       ELSE NULL END),0) AS REAL) FROM main.cash_movements
       WHERE shift_id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
       AND LOWER(COALESCE(source_type,''))<>'main_safe'",
        shift,
        pharmacy,
    )
    .await?;
    // Historical nonzero previous transfers lacking a corresponding movement
    // cannot be safely reissued into a newer shared shift.
    let prior: Option<f64> = sqlx::query_scalar(
        "SELECT transfer_amount FROM main.shifts WHERE id=? AND
        COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
    )
    .bind(shift)
    .bind(pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if prior.is_some_and(|amount| !amount.is_finite() || amount.abs() > 0.005) {
        return Err("Old shift contains unresolved prior transfers".into());
    }
    if !starting.is_finite() || starting < 0.0 || starting > MAX_CASH {
        return Err("Invalid starting cash on open shift".into());
    }
    let expected = starting + sales - refunds + movements;
    if !expected.is_finite() || expected.abs() > MAX_CASH {
        return Err("Handover expected cash overflow".into());
    }
    Ok(expected)
}

async fn execute_normal(
    conn: &mut SqliteConnection,
    actor: &str,
    input: NormalHandoverInput,
) -> Result<NormalHandoverPosted, String> {
    let target = validate(&input)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let outcome=async {
        let conn=&mut *tx;
        let pharmacy=live_pharmacy(conn,actor).await?;
        let receiver_id=verify_handover_password_on_connection(
            conn,actor,"receiver",Some(&input.receiver_username),&input.receiver_password
        ).await?.ok_or("Receiver authentication failed or account is not active in this pharmacy")?;
        // The credential helper has just re-read live password_hash, active
        // state and tenant under our writer lock. No renderer receiver ID.
        let open_shift_rows=sqlx::query(
            "SELECT id,starting_cash,pharmacy_id FROM main.shifts
             WHERE LOWER(COALESCE(status,''))='open'
             AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=? LIMIT 2",
        ).bind(&pharmacy).fetch_all(&mut *conn).await.map_err(|e|e.to_string())?;
        if open_shift_rows.len()!=1 {return Err("Shared pharmacy shift state is ambiguous".into());}
        let raw_tenant:Option<String>=open_shift_rows[0].try_get("pharmacy_id")
            .map_err(|e|e.to_string())?;
        if raw_tenant.as_deref().map_or(true,|raw|raw.trim().is_empty()) {
            return Err("Unowned legacy shared shift cannot be handed over without reconciliation".into());
        }
        let current:&str=open_shift_rows[0].try_get("id").map_err(|e|e.to_string())?;
        if current!=input.shift_id {return Err("Shift was closed, replaced or belongs to another pharmacy".into());}
        // Check receiver-selected destination ownership even when the
        // transferred amount is zero; never accept an invalid foreign bank or
        // disabled POS as a recorded target in this pharmacy's audit trail.
        if matches!(input.transfer_target_type.as_str(),"bank"|"pos") {
            let target_id=target.ok_or("Handover destination missing")?;
            let sql=if input.transfer_target_type=="bank" {
                "SELECT id FROM main.banks WHERE id=?
                 AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?"
            } else {
                "SELECT id FROM main.points_of_sale WHERE id=?
                 AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
                 AND COALESCE(status,'active')='active'"
            };
            let owned:Option<i64>=sqlx::query_scalar(sql).bind(target_id).bind(&pharmacy)
               .fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
            if owned.is_none() {
                return Err("Selected handover destination is not active in the current pharmacy".into());
            }
        }
        let starting:Option<f64>=open_shift_rows[0].try_get("starting_cash").map_err(|e|e.to_string())?;
        let expected=reconcile(conn,current,&pharmacy,starting.unwrap_or(0.0)).await?;
        let difference=input.actual_cash-expected;
        if !difference.is_finite() || difference.abs()>MAX_CASH {
            return Err("Invalid handover discrepancy".into());
        }
        let internal=input.transfer_target_type=="next_shift";
        let carried=if internal {input.transfer_amount}
            else {input.actual_cash-input.transfer_amount};
        let retained=if input.transfer_target_type=="treasury" {
            input.transfer_amount
        } else if internal { input.actual_cash-input.transfer_amount } else {0.0};
        if !carried.is_finite() || carried<0.0 || !retained.is_finite() || retained<0.0 {
            return Err("Invalid transfer disposition".into());
        }
        let status=if difference.abs()>5.0 {"discrepancy"} else {"closed"};
        let drawer=if (difference.abs()>0.005)
            || (input.transfer_target_type=="bank" && input.transfer_amount>0.0) {
            Some(account(conn,"cash_drawer","1.1.1").await?)
        } else {None};
        let bank=if input.transfer_target_type=="bank" && input.transfer_amount>0.0 {
            Some(destination_bank_account(conn,target.ok_or("Destination ID missing")?).await?)
        } else {None};
        let variance=if difference.abs()>0.005 {
            Some(account(conn,"cash_difference","4.3").await?)
        } else {None};
        let next=Uuid::new_v4().to_string();
        if difference.abs()>0.005 {
            sqlx::query("INSERT INTO main.cash_movements
             (id,user_id,shift_id,type,category,amount,target_name,notes,date,pharmacy_id)
             VALUES(?,?,?,?,'cash_adjustment',?,'تسوية الجرد',?,date('now','localtime'),?)")
            .bind(Uuid::new_v4().to_string()).bind(actor).bind(&input.shift_id)
            .bind(if difference>0.0 {"receipt"}else{"disbursement"})
            .bind(difference.abs()).bind(format!("تسوية تسليم: {:.2}",difference))
            .bind(&pharmacy).execute(&mut *conn).await.map_err(|e|e.to_string())?;
        }
        if input.transfer_amount>0.0 {
            sqlx::query("INSERT INTO main.cash_movements
             (id,user_id,shift_id,type,category,amount,source_type,target_name,notes,date,pharmacy_id)
             VALUES(?,?,?,'disbursement','handover',?,'user_drawer',?,?,date('now','localtime'),?)")
            .bind(Uuid::new_v4().to_string()).bind(actor).bind(&input.shift_id)
            .bind(input.transfer_amount).bind(&input.receiver_username)
            .bind(input.notes.as_deref().unwrap_or("تسليم درج")).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        }
        if input.transfer_amount>0.0 && matches!(input.transfer_target_type.as_str(),"bank"|"pos") {
            let id=target.ok_or("Destination ID missing")?;
            let query=if input.transfer_target_type=="bank" {
                "UPDATE main.banks SET current_balance=current_balance+?
                 WHERE id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
                 AND current_balance IS NOT NULL AND typeof(current_balance) IN ('real','integer')
                 AND current_balance BETWEEN -1000000000000 AND 1000000000000
                 AND current_balance+? BETWEEN -1000000000000 AND 1000000000000"
            } else {
                "UPDATE main.points_of_sale SET current_balance=current_balance+?
                 WHERE id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
                 AND current_balance IS NOT NULL AND typeof(current_balance) IN ('real','integer')
                 AND current_balance BETWEEN -1000000000000 AND 1000000000000
                 AND current_balance+? BETWEEN -1000000000000 AND 1000000000000
                 AND COALESCE(status,'active')='active'"
            };
            let updated=sqlx::query(query).bind(input.transfer_amount).bind(id)
                .bind(&pharmacy).bind(input.transfer_amount)
                .execute(&mut *conn).await.map_err(|e|e.to_string())?;
            if updated.rows_affected()!=1 {return Err("Destination is invalid, inactive or belongs to another pharmacy".into());}
        }
        if let Some(bank)=bank {
            post_journal(conn,actor,&pharmacy,"تسليم درج: تحويل إلى البنك",
                input.transfer_amount,bank,drawer.ok_or("Missing drawer account")?).await?;
        }
        if let Some(variance)=variance {
            let (debit,credit)=if difference>0.0 {
                (drawer.ok_or("Missing drawer account")?,variance)
            } else {(variance,drawer.ok_or("Missing drawer account")?)};
            post_journal(conn,actor,&pharmacy,"تسوية وردية: عجز/زيادة نقدية",
                difference.abs(),debit,credit).await?;
        }
        let updated=sqlx::query(
            "UPDATE main.shifts SET end_time=CURRENT_TIMESTAMP,ending_cash=?,actual_cash=?,
             transfer_amount=COALESCE(transfer_amount,0)+?,transfer_target=?,
             treasury_retained_cash=?,cash_difference=?,receiver_id=?,notes=?,status=?
             WHERE id=? AND LOWER(COALESCE(status,''))='open'
             AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(carried).bind(input.actual_cash).bind(input.transfer_amount)
        .bind(&input.transfer_target_type).bind(retained).bind(difference)
        .bind(&receiver_id).bind(&input.notes).bind(status)
        .bind(&input.shift_id).bind(&pharmacy)
        .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        if updated.rows_affected()!=1 {return Err("Shift already handed over".into());}
        let opened=sqlx::query(
            "INSERT INTO main.shifts(id,user_id,pharmacy_id,starting_cash,notes,status)
             SELECT ?,?,?,?,?,'open' WHERE NOT EXISTS(
                 SELECT 1 FROM main.shifts WHERE LOWER(COALESCE(status,''))='open'
                   AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
             )",
        )
        .bind(&next).bind(actor).bind(&pharmacy).bind(carried)
        .bind(format!("وردية مشتركة بعد تسليم {}",input.shift_id)).bind(&pharmacy)
        .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        if opened.rows_affected()!=1 {return Err("New shared shift collision; handover rolled back".into());}
        for (action,details) in [
            ("START_SHIFT",format!("Opened shared shift {next} after {}",input.shift_id)),
            ("HANDOVER",format!("request={} shift={} next={} receiver={} expected={:.2} actual={:.2} transferred={:.2} difference={:.2} destination={}",
                input.request_id,input.shift_id,next,receiver_id,expected,input.actual_cash,
                input.transfer_amount,difference,input.transfer_target_type))
        ] {
            sqlx::query("INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
               VALUES(?,?,?,?)")
             .bind(actor).bind(action).bind(details).bind(&pharmacy)
             .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        }
        Ok(NormalHandoverPosted {
            difference,remaining_cash:carried,status:status.into(),new_shift_id:next,
            starting_cash:carried,receiver_id,transfer_target_type:input.transfer_target_type,
        })
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

#[tauri::command]
pub async fn process_handover_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: NormalHandoverInput,
) -> Result<NormalHandoverPosted, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Native handover database unavailable")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    execute_normal(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::{Connection, Executor};
    use std::time::Duration;

    fn payload(kind: &str, amount: f64, actual: f64) -> NormalHandoverInput {
        NormalHandoverInput {
            shift_id: "shared-a".into(),
            actual_cash: actual,
            transfer_amount: amount,
            transfer_target_type: kind.into(),
            transfer_target_id: if kind == "bank" {
                Some("10".into())
            } else if kind == "pos" {
                Some("20".into())
            } else {
                None
            },
            receiver_username: "receiver-a".into(),
            receiver_password: "Receiver!SecurePass2026".into(),
            notes: Some("Handover audit".into()),
            request_id: format!("handover-{}-once-0001", kind),
        }
    }
    async fn setup(conn: &mut SqliteConnection) {
        conn.execute(r#"
           CREATE TABLE users (id TEXT PRIMARY KEY,username TEXT,role TEXT,pharmacy_id TEXT,
             permissions TEXT,is_active INTEGER,password_hash TEXT);
           CREATE TABLE shifts (id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,
             status TEXT DEFAULT 'open',starting_cash REAL DEFAULT 0,
             start_time TEXT DEFAULT CURRENT_TIMESTAMP,end_time TEXT,ending_cash REAL,
             actual_cash REAL,transfer_amount REAL,transfer_target TEXT,
             treasury_retained_cash REAL,cash_difference REAL,receiver_id TEXT,notes TEXT);
           CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,shift_id TEXT,pharmacy_id TEXT,
             status TEXT,payment_method TEXT,total_amount REAL);
           CREATE TABLE returns(id TEXT PRIMARY KEY,shift_id TEXT,pharmacy_id TEXT,
             status TEXT,refund_method TEXT,total_refund REAL);
           CREATE TABLE cash_movements(id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,
             pharmacy_id TEXT,type TEXT,category TEXT,amount REAL,source_type TEXT,
             target_name TEXT,notes TEXT,date TEXT);
           CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER DEFAULT 0);
           INSERT INTO accounts VALUES (1,'1.1.1',0),(2,'1.1.4',0),(3,'4.3',0),(4,'7.7',1);
           CREATE TABLE trial_balance_settings(category TEXT PRIMARY KEY,account_id INTEGER);
           INSERT INTO trial_balance_settings VALUES ('cash_drawer',1),
             ('bank_clearing',2),('cash_difference',3);
           CREATE TABLE daily_journals(id TEXT PRIMARY KEY,date TEXT,
             description TEXT,created_by TEXT,total_amount REAL,pharmacy_id TEXT);
           CREATE TABLE journal_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,journal_id TEXT,
             account_id INTEGER,type TEXT,amount REAL);
           CREATE TABLE banks(id INTEGER PRIMARY KEY,pharmacy_id TEXT,current_balance REAL);
           INSERT INTO banks VALUES(10,'A',25),(11,'B',100);
           CREATE TABLE points_of_sale(id INTEGER PRIMARY KEY,pharmacy_id TEXT,
             current_balance REAL,status TEXT);
           INSERT INTO points_of_sale VALUES(20,'A',50,'active'),
             (21,'B',75,'active'),(22,'A',5,'inactive');
           CREATE TABLE activity_log(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,
             action TEXT,details TEXT,pharmacy_id TEXT);
           INSERT INTO shifts(id,user_id,pharmacy_id,status,starting_cash) VALUES
             ('shared-a','actor-a','A','open',100),
             ('shared-b','actor-b','B','open',70);
           INSERT INTO sales_invoices VALUES('s-a','shared-a','A','completed','cash',80),
             ('s-noncash','shared-a','A','completed','visa',900),
             ('s-b','shared-b','B','completed','cash',35);
           INSERT INTO returns VALUES('r-a','shared-a','A','approved','cash',10);
           INSERT INTO cash_movements(id,user_id,shift_id,pharmacy_id,type,category,amount,source_type)
             VALUES ('income','actor-a','shared-a','A','receipt','collection',20,'manual'),
             ('outgo','actor-a','shared-a','A','disbursement','expense',5,'manual'),
             ('safe','actor-a','shared-a','A','receipt','collection',1000,'main_safe');
        "#).await.unwrap();
        let hash = bcrypt::hash("Receiver!SecurePass2026", 4).unwrap();
        let default_hash = bcrypt::hash("admin", 4).unwrap();
        for (id, name, role, tenant, perms, active, hash) in [
            (
                "actor-a",
                "actor-a",
                "cashier",
                "A",
                r#"{"acc_can_view_handover":true}"#,
                1,
                None,
            ),
            ("actor-b", "actor-b", "owner", "B", "{}", 1, None),
            (
                "denied",
                "denied",
                "cashier",
                "A",
                r#"{"acc_can_view_handover":false}"#,
                1,
                None,
            ),
            ("inactive", "inactive", "owner", "A", "{}", 0, None),
            (
                "receiver-a",
                "receiver-a",
                "cashier",
                "A",
                "{}",
                1,
                Some(hash.as_str()),
            ),
            (
                "receiver-b",
                "receiver-b",
                "cashier",
                "B",
                "{}",
                1,
                Some(hash.as_str()),
            ),
            (
                "bootstrap",
                "bootstrap",
                "cashier",
                "A",
                "{}",
                1,
                Some(default_hash.as_str()),
            ),
        ] {
            sqlx::query("INSERT INTO users(id,username,role,pharmacy_id,permissions,is_active,password_hash)
                  VALUES(?,?,?,?,?,?,?)")
              .bind(id).bind(name).bind(role).bind(tenant).bind(perms).bind(active).bind(hash)
              .execute(&mut *conn).await.unwrap();
        }
    }
    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        setup(&mut conn).await;
        conn
    }
    async fn count(conn: &mut SqliteConnection, table: &str) -> i64 {
        let sql = match table {
            "movements" => "SELECT COUNT(*) FROM cash_movements",
            "shifts" => "SELECT COUNT(*) FROM shifts",
            "journals" => "SELECT COUNT(*) FROM daily_journals",
            "entries" => "SELECT COUNT(*) FROM journal_entries",
            "audit" => "SELECT COUNT(*) FROM activity_log",
            _ => panic!("unrecognized test table"),
        };
        sqlx::query_scalar(sql).fetch_one(&mut *conn).await.unwrap()
    }

    #[tokio::test]
    async fn synthetic_c_treasury_handover_60_counted_20_transferred_to_admin() {
        let mut conn = fixture().await;
        // Reproduce C's known business amounts on disposable native SQLite.
        // Existing fixture activity references shared-a, not this new drawer.
        let hash = bcrypt::hash("Receiver!SecurePass2026", 4).unwrap();
        sqlx::query("INSERT INTO users(id,username,role,pharmacy_id,permissions,is_active,password_hash)
            VALUES('admin','admin','owner','A','{}',1,?)")
            .bind(hash).execute(&mut conn).await.unwrap();
        conn.execute(r#"
            INSERT INTO shifts(id,user_id,pharmacy_id,status,starting_cash)
              VALUES('qa-open-shift','admin','A','closed',100);
            UPDATE shifts SET status='closed' WHERE id='shared-a';
            UPDATE shifts SET status='open' WHERE id='qa-open-shift';
            INSERT INTO cash_movements(id,user_id,shift_id,pharmacy_id,type,category,amount,source_type)
              VALUES('synthetic-supplier-cash','admin','qa-open-shift','A',
                     'disbursement','accounts_payable',40,'supplier_payment');
        "#).await.unwrap();
        let mut input = payload("treasury", 20.0, 60.0);
        input.shift_id = "qa-open-shift".into();
        input.receiver_username = "admin".into();
        let posted = execute_normal(&mut conn, "admin", input).await.unwrap();
        assert_eq!(posted.difference, 0.0);
        assert_eq!(posted.status, "closed");
        assert_eq!(posted.remaining_cash, 40.0);
        assert_eq!(posted.receiver_id, "admin");
        let (old_status, transferred, retained): (String, f64, f64) = sqlx::query_as(
            "SELECT status,transfer_amount,treasury_retained_cash FROM shifts WHERE id='qa-open-shift'",
        ).fetch_one(&mut conn).await.unwrap();
        assert_eq!((old_status.as_str(), transferred, retained), ("closed", 20.0, 20.0));
        let carried: f64 = sqlx::query_scalar(
            "SELECT starting_cash FROM shifts WHERE id=? AND status='open' AND pharmacy_id='A'",
        ).bind(&posted.new_shift_id).fetch_one(&mut conn).await.unwrap();
        assert_eq!(carried, 40.0);
        assert_eq!(count(&mut conn, "journals").await, 0);
        assert_eq!(count(&mut conn, "movements").await, 5);
    }

    #[tokio::test]
    async fn next_shift_reconciles_cash_sales_refunds_movements_and_rotates_atomically() {
        let mut conn = fixture().await;
        // expected: 100 + 80 - 10 +20 -5 = 185, main_safe +1000 omitted.
        let posted = execute_normal(&mut conn, "actor-a", payload("next_shift", 70.0, 185.0))
            .await
            .unwrap();
        assert_eq!(posted.difference, 0.0);
        assert_eq!(posted.remaining_cash, 70.0);
        assert_eq!(posted.starting_cash, 70.0);
        assert_eq!(posted.status, "closed");
        assert_eq!(posted.receiver_id, "receiver-a");
        let old = sqlx::query(
            "SELECT status,transfer_target,actual_cash,ending_cash,
          treasury_retained_cash,receiver_id FROM shifts WHERE id='shared-a'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(old.get::<String, _>("status"), "closed");
        assert_eq!(old.get::<String, _>("transfer_target"), "next_shift");
        assert_eq!(old.get::<f64, _>("actual_cash"), 185.0);
        assert_eq!(old.get::<f64, _>("ending_cash"), 70.0);
        assert_eq!(old.get::<f64, _>("treasury_retained_cash"), 115.0);
        assert_eq!(old.get::<String, _>("receiver_id"), "receiver-a");
        let next: Option<f64> = sqlx::query_scalar(
            "SELECT starting_cash FROM shifts
            WHERE id=? AND status='open' AND pharmacy_id='A'",
        )
        .bind(&posted.new_shift_id)
        .fetch_optional(&mut conn)
        .await
        .unwrap();
        assert_eq!(next, Some(70.0));
        assert_eq!(count(&mut conn, "movements").await, 4);
        assert_eq!(count(&mut conn, "journals").await, 0);
        assert_eq!(count(&mut conn, "audit").await, 2);
        assert!(
            execute_normal(&mut conn, "actor-a", payload("next_shift", 70.0, 185.0))
                .await
                .is_err()
        ); // Old shared ID cannot hand over twice.
        assert_eq!(count(&mut conn, "movements").await, 4);
    }

    #[tokio::test]
    async fn bank_transfer_and_discrepancy_journals_are_balanced_and_scoped() {
        let mut conn = fixture().await;
        let posted = execute_normal(&mut conn, "actor-a", payload("bank", 60.0, 170.0))
            .await
            .unwrap();
        assert_eq!(posted.difference, -15.0);
        assert_eq!(posted.status, "discrepancy");
        assert_eq!(posted.remaining_cash, 110.0);
        let balance: f64 = sqlx::query_scalar("SELECT current_balance FROM banks WHERE id=10")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(balance, 85.0);
        assert_eq!(count(&mut conn, "movements").await, 5); // adjustment + handover
        assert_eq!(count(&mut conn, "journals").await, 2);
        assert_eq!(count(&mut conn, "entries").await, 4);
        let rows = sqlx::query(
            "SELECT j.description,j.pharmacy_id,e.account_id,e.type,e.amount
           FROM daily_journals j JOIN journal_entries e ON j.id=e.journal_id
           ORDER BY j.description,e.id",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        let mut bank_entries = Vec::new();
        let mut difference_entries = Vec::new();
        for row in rows {
            assert_eq!(row.get::<String, _>("pharmacy_id"), "A");
            let entry = (
                row.get::<i64, _>("account_id"),
                row.get::<String, _>("type"),
                row.get::<f64, _>("amount"),
            );
            if row.get::<String, _>("description").contains("البنك") {
                bank_entries.push(entry);
            } else {
                difference_entries.push(entry);
            }
        }
        assert_eq!(
            bank_entries,
            vec![(2, "debit".into(), 60.0), (1, "credit".into(), 60.0)]
        );
        assert_eq!(
            difference_entries,
            vec![(3, "debit".into(), 15.0), (1, "credit".into(), 15.0)]
        );
    }

    #[tokio::test]
    async fn signed_negative_bank_opening_and_custom_bank_leaf_post_correctly() {
        let mut conn = fixture().await;
        sqlx::query("UPDATE banks SET current_balance=-75 WHERE id=10")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO accounts VALUES(5,'1.1.4.10',0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO trial_balance_settings VALUES('bank:10',5)")
            .execute(&mut conn)
            .await
            .unwrap();
        let transfer = execute_normal(&mut conn, "actor-a", payload("bank", 40.0, 185.0))
            .await
            .unwrap();
        assert_eq!(transfer.remaining_cash, 145.0);
        let negative_after: f64 =
            sqlx::query_scalar("SELECT current_balance FROM banks WHERE id=10")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(negative_after, -35.0);
        let linked: Vec<i64> = sqlx::query_scalar(
            "SELECT e.account_id FROM journal_entries e
          JOIN daily_journals j ON j.id=e.journal_id WHERE e.type='debit'",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(linked, vec![5]);
        let mut second = fixture().await;
        sqlx::query("INSERT INTO trial_balance_settings VALUES('bank:10',4)")
            .execute(&mut second)
            .await
            .unwrap(); // group, never post to a group account.
        assert!(
            execute_normal(&mut second, "actor-a", payload("bank", 40.0, 185.0))
                .await
                .is_err()
        );
        assert_eq!(count(&mut second, "journals").await, 0);
        assert_eq!(count(&mut second, "shifts").await, 2);
    }

    #[tokio::test]
    async fn treasury_and_pos_destinations_preserve_carried_float_and_scope() {
        let mut conn = fixture().await;
        let treasury = execute_normal(&mut conn, "actor-a", payload("treasury", 25.0, 185.0))
            .await
            .unwrap();
        assert_eq!(treasury.remaining_cash, 160.0);
        let kept: f64 = sqlx::query_scalar(
            "SELECT treasury_retained_cash FROM shifts
            WHERE id='shared-a'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(kept, 25.0);
        assert_eq!(count(&mut conn, "journals").await, 0);
        // Reset a disposable open shift instead of reusing already closed old.
        sqlx::query("UPDATE shifts SET status='open',transfer_amount=0 WHERE id='shared-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("UPDATE shifts SET status='closed' WHERE id=?")
            .bind(&treasury.new_shift_id)
            .execute(&mut conn)
            .await
            .unwrap();
        // Remove the first handover's disbursement from synthetic history.
        conn.execute("DELETE FROM cash_movements WHERE category='handover'")
            .await
            .unwrap();
        let pos = execute_normal(&mut conn, "actor-a", payload("pos", 30.0, 185.0))
            .await
            .unwrap();
        assert_eq!(pos.remaining_cash, 155.0);
        let balance: f64 =
            sqlx::query_scalar("SELECT current_balance FROM points_of_sale WHERE id=20")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(balance, 80.0);
        assert_eq!(count(&mut conn, "journals").await, 0);
    }

    #[tokio::test]
    async fn unauthorized_inactive_receiver_wrong_password_cross_branch_fail_closed() {
        let mut conn = fixture().await;
        for actor in ["denied", "inactive", "missing", "actor-b"] {
            assert!(
                execute_normal(&mut conn, actor, payload("bank", 40.0, 185.0))
                    .await
                    .is_err()
            );
        }
        let mut input = payload("bank", 40.0, 185.0);
        input.receiver_username = "receiver-b".into();
        assert!(execute_normal(&mut conn, "actor-a", input).await.is_err());
        let mut input = payload("bank", 40.0, 185.0);
        input.receiver_password = "wrong-password".into();
        assert!(execute_normal(&mut conn, "actor-a", input).await.is_err());
        let mut input = payload("bank", 40.0, 185.0);
        input.receiver_username = "bootstrap".into();
        input.receiver_password = "admin".into();
        assert!(execute_normal(&mut conn, "actor-a", input).await.is_err());
        sqlx::query("UPDATE users SET is_active=0 WHERE id='receiver-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            execute_normal(&mut conn, "actor-a", payload("bank", 40.0, 185.0))
                .await
                .is_err()
        );
        assert_eq!(count(&mut conn, "movements").await, 3);
        assert_eq!(count(&mut conn, "journals").await, 0);
        assert_eq!(count(&mut conn, "audit").await, 0);
        assert_eq!(count(&mut conn, "shifts").await, 2);
    }

    #[tokio::test]
    async fn live_staff_role_and_pharmacy_reassignment_denied_without_stale_snapshot() {
        let mut conn = fixture().await;
        sqlx::query("UPDATE users SET pharmacy_id='B' WHERE id='actor-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            execute_normal(&mut conn, "actor-a", payload("bank", 20.0, 185.0))
                .await
                .is_err()
        );
        sqlx::query("UPDATE users SET pharmacy_id='A',permissions='{}' WHERE id='actor-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            execute_normal(&mut conn, "actor-a", payload("bank", 20.0, 185.0))
                .await
                .is_err()
        );
        sqlx::query("UPDATE users SET role='owner',is_active=0 WHERE id='actor-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            execute_normal(&mut conn, "actor-a", payload("bank", 20.0, 185.0))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn bad_dates_amounts_destination_and_managed_modes_never_write() {
        let mut conn = fixture().await;
        let inputs = [
            (f64::NAN, 0.0),
            (f64::INFINITY, 0.0),
            (-1.0, 0.0),
            (1.001, 0.0),
            (50.0, 50.001),
            (1e12 + 1.0, 0.0),
        ];
        for (actual, transfer) in inputs {
            assert!(
                execute_normal(&mut conn, "actor-a", payload("bank", transfer, actual))
                    .await
                    .is_err()
            );
        }
        let mut foreign = payload("bank", 50.0, 185.0);
        foreign.transfer_target_id = Some("11".into());
        assert!(execute_normal(&mut conn, "actor-a", foreign).await.is_err());
        let mut inactive = payload("pos", 50.0, 185.0);
        inactive.transfer_target_id = Some("22".into());
        assert!(execute_normal(&mut conn, "actor-a", inactive)
            .await
            .is_err());
        let mut invalid = payload("bank", 50.0, 185.0);
        invalid.transfer_target_id = Some("1 OR 1=1".into());
        assert!(execute_normal(&mut conn, "actor-a", invalid).await.is_err());
        let valid = serde_json::json!({
            "shiftId":"shared-a","actualCash":185.0,"transferAmount":50.0,
            "transferTargetType":"bank","transferTargetId":"10",
            "receiverUsername":"receiver-a","receiverPassword":"password",
            "requestId":"handover-typed-once-0001"
        });
        for key in [
            "userId",
            "actorId",
            "pharmacyId",
            "receiverId",
            "receiverPasswordHash",
            "receiverRole",
            "passwordHash",
            "sql",
            "accountId",
            "managedUserId",
            "closeOnly",
            "deactivateManagedUser",
            "autoOpenNewShift",
        ] {
            let mut forged = valid.clone();
            forged[key] = serde_json::json!("attacker");
            assert!(
                serde_json::from_value::<NormalHandoverInput>(forged).is_err(),
                "{key}"
            );
        }
        assert_eq!(count(&mut conn, "movements").await, 3);
        assert_eq!(count(&mut conn, "journals").await, 0);
    }

    #[tokio::test]
    async fn foreign_unowned_and_malformed_history_require_reconciliation() {
        for sql in [
            "INSERT INTO sales_invoices VALUES('foreign','shared-a','B','completed','cash',12)",
            "INSERT INTO sales_invoices VALUES('unowned','shared-a',NULL,'completed','cash',12)",
            "INSERT INTO returns VALUES('bad','shared-a',NULL,'completed','cash',9)",
            "INSERT INTO cash_movements(id,user_id,shift_id,pharmacy_id,type,amount)
               VALUES('orphan','actor-a','shared-a',NULL,'receipt',10)",
            "INSERT INTO cash_movements(id,user_id,shift_id,pharmacy_id,type,amount)
               VALUES('unknown','actor-a','shared-a','A','adjustment',10)",
            "INSERT INTO cash_movements(id,user_id,shift_id,pharmacy_id,type,amount)
               VALUES('negative','actor-a','shared-a','A','receipt',-10)",
            "UPDATE shifts SET transfer_amount=30 WHERE id='shared-a'",
        ] {
            let mut conn = fixture().await;
            conn.execute(sql).await.unwrap();
            assert!(
                execute_normal(&mut conn, "actor-a", payload("bank", 20.0, 185.0))
                    .await
                    .is_err(),
                "SQL case: {sql}"
            );
            assert_eq!(
                count(&mut conn, "movements").await,
                if sql.contains("cash_movements") { 4 } else { 3 }
            );
            assert_eq!(count(&mut conn, "audit").await, 0);
        }
    }

    #[tokio::test]
    async fn all_ledger_or_audit_failures_roll_back_destination_shift_and_adjustment() {
        for broken in [
            "CREATE TRIGGER deny_credit BEFORE INSERT ON journal_entries WHEN NEW.type='credit'
                BEGIN SELECT RAISE(ABORT,'synthetic credit failure'); END",
            "CREATE TRIGGER deny_audit BEFORE INSERT ON activity_log
                BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
        ] {
            let mut conn = fixture().await;
            conn.execute(broken).await.unwrap();
            assert!(
                execute_normal(&mut conn, "actor-a", payload("bank", 50.0, 170.0))
                    .await
                    .is_err()
            );
            assert_eq!(count(&mut conn, "movements").await, 3);
            assert_eq!(count(&mut conn, "shifts").await, 2);
            assert_eq!(count(&mut conn, "journals").await, 0);
            assert_eq!(count(&mut conn, "entries").await, 0);
            assert_eq!(count(&mut conn, "audit").await, 0);
            let balance: f64 = sqlx::query_scalar("SELECT current_balance FROM banks WHERE id=10")
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(balance, 25.0);
            let status: String =
                sqlx::query_scalar("SELECT status FROM shifts WHERE id='shared-a'")
                    .fetch_one(&mut conn)
                    .await
                    .unwrap();
            assert_eq!(status, "open");
        }
        let mut conn = fixture().await;
        sqlx::query("DELETE FROM accounts WHERE code='1.1.4'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            execute_normal(&mut conn, "actor-a", payload("bank", 50.0, 170.0))
                .await
                .is_err()
        );
        assert_eq!(count(&mut conn, "journals").await, 0);
    }

    #[tokio::test]
    async fn two_connections_handover_same_shift_only_one_commits() {
        let mut path = std::env::temp_dir();
        path.push(format!("pharma-handover-{}.sqlite", Uuid::new_v4()));
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(8));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(opts)
            .await
            .unwrap();
        let mut seed = pool.acquire().await.unwrap();
        setup(&mut seed).await;
        drop(seed);
        let left = pool.clone();
        let right = pool.clone();
        let (a, b) = tokio::join!(
            async move {
                let mut conn = left.acquire().await.unwrap();
                execute_normal(&mut conn, "actor-a", payload("bank", 50.0, 185.0)).await
            },
            async move {
                let mut conn = right.acquire().await.unwrap();
                execute_normal(&mut conn, "actor-a", payload("bank", 50.0, 185.0)).await
            }
        );
        assert_eq!(a.is_ok() as u8 + b.is_ok() as u8, 1);
        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(count(&mut conn, "shifts").await, 3);
        assert_eq!(count(&mut conn, "movements").await, 4);
        assert_eq!(count(&mut conn, "audit").await, 2);
        let balance: f64 = sqlx::query_scalar("SELECT current_balance FROM banks WHERE id=10")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
        assert_eq!(balance, 75.0);
        drop(conn);
        pool.close().await;
        drop(pool);
        for _ in 0..20 {
            if std::fs::remove_file(&path).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
