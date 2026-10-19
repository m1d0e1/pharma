//! Patient account settlement for historic *unowned* patient profiles.
//!
//! A patient is never assigned to a branch here. We may settle only debt whose
//! entire origin is explicit completed CREDIT invoices in one native pharmacy.
//! Opening balances, other-branch sales, legacy unscoped patient transactions,
//! financial notices and unclear returns fail closed rather than guessing.
//! New payments receive explicit transaction provenance in migration 033.
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
pub struct PatientPaymentInput {
    patient_id: String,
    shift_id: Option<String>,
    amount: f64,
    payment_method: String,
    notes: Option<String>,
    date: String,
    request_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatientPaymentReceipt {
    id: String,
    remaining_balance: f64,
}

/// Strict read-only confirmation of an already posted 051/055 payment.
/// Never estimate debt from a current balance or accept a nonce by itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatientPaymentConfirmation {
    id: String,
    request_id: String,
    patient_id: String,
    actor_id: String,
    pharmacy_id: String,
    amount_cents: i64,
    payment_method: String,
    date: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PatientWalletTopUpInput {
    patient_id: String,
    amount: f64,
    notes: Option<String>,
    request_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatientWalletTopUpReceipt {
    id: String,
    balance: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatientWalletTopUpConfirmation {
    id: String,
    patient_id: String,
    actor_id: String,
    pharmacy_id: String,
    amount_cents: i64,
    balance: f64,
}

fn safe_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '\'' | '"' | ';' | '`'))
}

fn validate(input: &PatientPaymentInput) -> Result<(), String> {
    if !safe_text(&input.patient_id, 128)
        || !safe_text(&input.request_id, 128)
        || input
            .shift_id
            .as_deref()
            .is_some_and(|v| !safe_text(v, 128))
        || input.notes.as_deref().is_some_and(|v| {
            v.len() > 2000
                || v.chars()
                    .any(|c| c == '\0' || (c.is_control() && c != '\n' && c != '\r'))
        })
        || !input.amount.is_finite()
        || input.amount <= 0.0
        || input.amount > 1e12
        || (input.amount * 100.0 - (input.amount * 100.0).round()).abs() > 0.000_000_1
        || !matches!(input.payment_method.as_str(), "bank" | "cash")
        || !valid_date(&input.date)
    {
        return Err("Invalid native patient payment request".into());
    }
    Ok(())
}

fn valid_date(value: &str) -> bool {
    if value.len() != 10
        || !value.bytes().enumerate().all(|(i, ch)| {
            if i == 4 || i == 7 {
                ch == b'-'
            } else {
                ch.is_ascii_digit()
            }
        })
    {
        return false;
    }
    let y = value[0..4].parse::<u32>().unwrap_or(0);
    let m = value[5..7].parse::<u32>().unwrap_or(0);
    let d = value[8..10].parse::<u32>().unwrap_or(0);
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let max = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    y > 0 && d > 0 && d <= max
}

async fn account(conn: &mut SqliteConnection, category: &str, code: &str) -> Result<i64, String> {
    // A configurable category must never redirect a native patient cash or
    // receivable posting away from the canonical financial account.
    let matches: Vec<i64> = sqlx::query_scalar(
        "SELECT a.id FROM main.accounts a
         WHERE a.code=? AND COALESCE(a.is_group,0)=0
           AND (NOT EXISTS(
               SELECT 1 FROM main.trial_balance_settings t WHERE t.category=?
             ) OR EXISTS(
               SELECT 1 FROM main.trial_balance_settings t
               WHERE t.category=? AND t.account_id=a.id
             ))
         LIMIT 2",
    )
    .bind(code)
    .bind(category)
    .bind(category)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if matches.len() != 1 {
        return Err(format!(
            "Missing or unsafe patient payment account mapping for {category}"
        ));
    }
    Ok(matches[0])
}

/// Historical 033 payments lack an exact cash/journal witness. New 055 cash
/// receipts must certify their precise movement UUID before collecting again.
pub(super) async fn verify_scoped_patient_payments(
    conn: &mut SqliteConnection,
    patient: &str,
    pharmacy: &str,
) -> Result<(), String> {
    let corrupt: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM main.patient_transactions pt
         JOIN main.patient_payment_scope sc ON sc.transaction_id=pt.id
         WHERE pt.patient_id=? AND sc.pharmacy_id=?
           AND (pt.type IS NOT 'payment'
             OR typeof(pt.amount) NOT IN ('real','integer')
             OR pt.amount<=0 OR pt.amount>1000000000000
             OR abs(pt.amount*100.0-ROUND(pt.amount*100.0))>0.0000001
             OR pt.payment_method IS NULL OR pt.payment_method NOT IN ('cash','bank')
             OR pt.user_id IS NULL OR pt.date IS NULL)
         LIMIT 1",
    )
    .bind(patient)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    // V1 bank payment IDs have no link to the independent bank journal UUID.
    // A mutable +1 payment mirror can replace an actual bank20 posting and
    // reopen debt without changing a single balanced journal. Only the
    // forward 051 atomically inserted source/journal receipt establishes that
    // relation. Keep historical rows, but do not monetize them automatically.
    let unlinked_bank: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM main.patient_transactions pt
         JOIN main.patient_payment_scope sc ON sc.transaction_id=pt.id
         WHERE pt.patient_id=? AND sc.pharmacy_id=? AND pt.type='payment'
           AND pt.payment_method='bank'
           AND NOT EXISTS(SELECT 1 FROM main.native_patient_financial_journal_receipts r
                          WHERE r.source_kind='payment' AND r.source_id=pt.id
                            AND r.pharmacy_id=sc.pharmacy_id AND r.actor_id=pt.user_id
                            AND r.money_kind='bank' AND typeof(pt.amount) IN ('real','integer')
                            AND abs(r.amount_cents-pt.amount*100.0)<0.00001)
         LIMIT 1",
    )
    .bind(patient)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if unlinked_bank.is_some() {
        return Err("Patient account has unverified legacy bank settlement; independent journal review required".into());
    }
    let unlinked_cash: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM main.patient_transactions pt
         JOIN main.patient_payment_scope sc ON sc.transaction_id=pt.id
         WHERE pt.patient_id=? AND sc.pharmacy_id=? AND pt.type='payment'
           AND pt.payment_method='cash'
           AND NOT EXISTS (
             SELECT 1 FROM main.native_patient_financial_journal_receipts r
             JOIN main.cash_movements cm ON cm.id=r.cash_movement_id
             JOIN main.shifts sh ON CAST(sh.id AS TEXT)=CAST(cm.shift_id AS TEXT)
             WHERE r.source_kind='payment' AND r.source_id=pt.id
               AND r.pharmacy_id=sc.pharmacy_id AND r.actor_id=pt.user_id
               AND r.money_kind='cash' AND r.cash_movement_id IS NOT NULL
               AND typeof(pt.amount) IN ('real','integer')
               AND abs(r.amount_cents-pt.amount*100.0)<0.00001
               AND cm.source_type='patient_payment' AND cm.target_name=pt.patient_id
               AND cm.type='receipt' AND cm.category='accounts_receivable'
               AND cm.pharmacy_id=sc.pharmacy_id AND sh.pharmacy_id=sc.pharmacy_id
               AND CAST(cm.user_id AS TEXT)=pt.user_id AND cm.date=pt.date
               AND typeof(cm.amount) IN ('real','integer')
               AND abs(cm.amount*100.0-r.amount_cents)<0.00001
           ) LIMIT 1",
    )
    .bind(patient)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if unlinked_cash.is_some() {
        return Err("Patient account has unverifiable historical cash UUID; independent review required".into());
    }
    let corrupt_cash: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM main.cash_movements cm
         WHERE cm.source_type='patient_payment' AND cm.target_name=?
           AND cm.pharmacy_id=?
           AND (cm.type IS NOT 'receipt' OR cm.category IS NOT 'accounts_receivable'
             OR typeof(cm.amount) NOT IN ('real','integer')
             OR cm.amount<=0 OR cm.amount>1000000000000
             OR abs(cm.amount*100.0-ROUND(cm.amount*100.0))>0.0000001
             OR cm.user_id IS NULL OR cm.date IS NULL
             OR NOT EXISTS (SELECT 1 FROM main.shifts sh
                  WHERE CAST(sh.id AS TEXT)=CAST(cm.shift_id AS TEXT)
                    AND sh.pharmacy_id=cm.pharmacy_id))
         LIMIT 1",
    )
    .bind(patient)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    // Reject extra unclaimed/changed movements after checking exact UUIDs.
    // This count is only a guard, never proof of historical source linkage.
    let mismatched_cash: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM (
           SELECT pt.user_id AS actor,pt.date AS posted_on,1 AS item_count,pt.amount AS amount
           FROM main.patient_transactions pt
           JOIN main.patient_payment_scope sc ON sc.transaction_id=pt.id
           WHERE pt.patient_id=? AND sc.pharmacy_id=? AND pt.type='payment'
             AND pt.payment_method='cash'
           UNION ALL
           SELECT cm.user_id,cm.date,-1,-cm.amount
           FROM main.cash_movements cm
           WHERE cm.source_type='patient_payment' AND cm.target_name=?
             AND cm.pharmacy_id=?
         ) source
         GROUP BY actor,posted_on,ROUND(ABS(amount)*100.0)
         HAVING SUM(item_count)<>0
         LIMIT 1",
    )
    .bind(patient)
    .bind(pharmacy)
    .bind(patient)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if corrupt.is_some() || corrupt_cash.is_some() || mismatched_cash.is_some() {
        return Err("Unreconciled scoped patient payment source".into());
    }
    Ok(())
}

async fn payment_shift(
    conn: &mut SqliteConnection,
    actor: &str,
    pharmacy: &str,
    preferred: Option<&str>,
) -> Result<String, String> {
    // Never cross into a foreign or closed drawer via the caller's shift ID.
    if let Some(id) = preferred {
        let found: Option<String> = sqlx::query_scalar(
            "SELECT CAST(id AS TEXT) FROM main.shifts WHERE CAST(id AS TEXT)=? AND status='open'
              AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=? LIMIT 1",
        )
        .bind(id)
        .bind(pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if let Some(id) = found {
            return Ok(id);
        }
    }
    let open: Option<String> = sqlx::query_scalar(
        "SELECT CAST(id AS TEXT) FROM main.shifts WHERE status='open'
         AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
         ORDER BY start_time ASC,rowid ASC LIMIT 1",
    )
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(id) = open {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO main.shifts(id,user_id,pharmacy_id,starting_cash,status,notes)
                 VALUES(?,?,?,0,'open','وردية مشتركة أُنشئت تلقائياً')",
    )
    .bind(&id)
    .bind(actor)
    .bind(pharmacy)
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    Ok(id)
}

async fn post(
    conn: &mut SqliteConnection,
    actor: &str,
    request: PatientPaymentInput,
) -> Result<PatientPaymentReceipt, String> {
    validate(&request)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result=async {
        let conn=&mut *tx;
        let (role,pharmacy)=active_generic_actor(conn,actor).await?;
        let permissions:Option<String>=sqlx::query_scalar(
            "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1")
            .bind(actor).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        for key in ["can_view_patients","acc_can_process_cash_flow"] {
            if !user_has_permission(Some(&role),permissions.as_deref(),key,false) {
                return Err("Unauthorized native patient payment".into());
            }
        }
        if sqlx::query_scalar::<_,i64>("SELECT 1 FROM main.patient_payment_scope WHERE request_id=?")
            .bind(&request.request_id).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?.is_some() {
            return Err("Patient payment request already processed".into());
        }
        let patient=sqlx::query("SELECT full_name,CAST(COALESCE(opening_balance,0) AS REAL) AS opening_balance
                  FROM main.patients WHERE id=? LIMIT 1")
            .bind(&request.patient_id).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?
            .ok_or("Patient record not found")?;
        let name:String=patient.try_get("full_name").map_err(|e|e.to_string())?;
        let opening:f64=patient.try_get("opening_balance").map_err(|e|e.to_string())?;
        if !opening.is_finite() || opening.abs()>0.000_001 {
            return Err("Unscoped historic patient opening balance requires explicit ownership review".into());
        }
        // Historical global patient identity does not imply membership in any
        // branch. A foreign, absent or untagged-legacy debt source is ambiguous.
        let foreign:i64=sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.sales_invoices WHERE patient_id=?
             AND pharmacy_id IS NOT ?")
            .bind(&request.patient_id).bind(&pharmacy).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let legacy=super::financial_notices_native::count_untrusted_patient_transactions(
            conn, &request.patient_id, &pharmacy,
        ).await?;
        let notices:i64=sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.financial_notices n
             LEFT JOIN main.financial_notice_native_scope ns ON ns.notice_id=n.id
             WHERE n.target_type='customer' AND n.target_id=?
               AND (ns.notice_id IS NULL OR ns.pharmacy_id<>? OR n.type NOT IN ('credit','debit'))")
            .bind(&request.patient_id).bind(&pharmacy)
            .fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let ambiguous_returns:i64=sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.returns r JOIN main.sales_invoices si ON si.id=r.invoice_id
             WHERE si.patient_id=? AND r.refund_method='patient_account'
               AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
               AND r.pharmacy_id IS NOT ?")
            .bind(&request.patient_id).bind(&pharmacy).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let qualifying:i64=sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.sales_invoices WHERE patient_id=? AND payment_method='credit'
             AND pharmacy_id=?
             AND (status IS NULL OR status='' OR LOWER(status) IN ('completed','approved','delivered'))")
            .bind(&request.patient_id).bind(&pharmacy).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        if foreign>0 || legacy>0 || notices>0 || ambiguous_returns>0 || qualifying==0 {
            return Err("Patient balance provenance is ambiguous; no automatic pharmacy assignment is permitted".into());
        }
        // Return headers are editable legacy observations; do not collect
        // receivables against a refund contradicted by its finalized lines.
        super::financial_notices_native::verify_patient_account_return_amounts(
            conn,
            &request.patient_id,
            &pharmacy,
        )
        .await?;
        super::financial_notices_native::verify_proven_patient_credit_sources(
            conn,
            &request.patient_id,
            &pharmacy,
        )
        .await?;
        // A native pharmacy scope tag alone cannot certify an altered patient
        // adjustment. Share the original notice/mirror source check with the
        // notice writer before admitting that amount into the receivable.
        super::financial_notices_native::verify_native_notice_mirrors(
            conn,
            &request.patient_id,
            &pharmacy,
        )
        .await?;
        verify_scoped_patient_payments(conn, &request.patient_id, &pharmacy).await?;
        // The same canonical balance components, limited to proven current-
        // tenant debt: credit invoices - approved patient-account refunds -
        // payments that this native command previously tagged explicitly.
        let credit:f64=sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(total_amount),0) AS REAL) FROM main.sales_invoices
             WHERE patient_id=? AND payment_method='credit'
              AND pharmacy_id=?
              AND (status IS NULL OR status='' OR LOWER(status) IN ('completed','approved','delivered'))")
            .bind(&request.patient_id).bind(&pharmacy).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let refunds:f64=sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(r.total_refund),0) AS REAL) FROM main.returns r
             JOIN main.sales_invoices si ON si.id=r.invoice_id
             WHERE si.patient_id=? AND si.pharmacy_id=?
              AND r.pharmacy_id=?
              AND r.refund_method='patient_account' AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')")
            .bind(&request.patient_id).bind(&pharmacy).bind(&pharmacy)
            .fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let paid:f64=sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(pt.amount),0) AS REAL) FROM main.patient_transactions pt
             JOIN main.patient_payment_scope sc ON sc.transaction_id=pt.id
             WHERE pt.patient_id=? AND sc.pharmacy_id=? AND pt.type='payment'")
            .bind(&request.patient_id).bind(&pharmacy).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let adjustments:f64=sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(pt.amount),0) AS REAL)
             FROM main.patient_transactions pt
             JOIN main.financial_notice_native_scope ns ON ns.patient_transaction_id=pt.id
             WHERE pt.patient_id=? AND pt.type='adjustment' AND ns.pharmacy_id=?")
            .bind(&request.patient_id).bind(&pharmacy)
            .fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let outstanding=credit-refunds-paid+adjustments;
        // Receipts are exact cents; source invoices may be authentic micro-units.
        // Rounding a 0.004 historical remainder away must never create 0.004
        // of unearned cash/receivable. The sub-micro tolerance is only for
        // binary float summation of exact-cent amounts, not half-cent rounding.
        let collectible_cents=(outstanding*100.0+0.000_000_1).floor();
        if !outstanding.is_finite() || outstanding<=0.0
            || (request.amount*100.0).round()>collectible_cents {
            return Err("Payment exceeds provable outstanding patient debt".into());
        }
        let debit=account(conn,if request.payment_method=="cash" {"cash_drawer"}else{"bank_clearing"},
            if request.payment_method=="cash" {"1.1.1"} else {"1.1.4"}).await?;
        let receivable=account(conn,"accounts_receivable","1.1.2").await?;
        if debit==receivable {return Err("Patient settlement ledger accounts must be distinct".into());}
        let shift=if request.payment_method=="cash" {
            Some(payment_shift(conn,actor,&pharmacy,request.shift_id.as_deref()).await?)
        } else {None};
        let id=Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO main.patient_transactions(id,patient_id,user_id,type,amount,payment_method,notes,date)
                 VALUES(?,?,?,'payment',?,?,?,?)")
            .bind(&id).bind(&request.patient_id).bind(actor).bind(request.amount)
            .bind(&request.payment_method).bind(&request.notes).bind(&request.date)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO main.patient_payment_scope(transaction_id,pharmacy_id,request_id) VALUES(?,?,?)")
            .bind(&id).bind(&pharmacy).bind(&request.request_id)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        let cash_movement_id=if let Some(shift_id)=shift {
            let movement_id=Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO main.cash_movements
              (id,user_id,shift_id,type,category,amount,source_type,target_name,notes,date,pharmacy_id)
              VALUES(?,?,?,'receipt','accounts_receivable',?,'patient_payment',?,?,?,?)")
                .bind(&movement_id).bind(actor).bind(shift_id).bind(request.amount)
                .bind(&request.patient_id).bind(format!("دفعة من المريض {}: {}",name,request.notes.as_deref().unwrap_or("")))
                .bind(&request.date).bind(&pharmacy)
                .execute(&mut *conn).await.map_err(|e|e.to_string())?;
            Some(movement_id)
        } else {None};
        let journal=Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO main.daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
                   VALUES(?,?,?,?,?,?)")
            .bind(&journal).bind(&request.date).bind(format!("تحصيل من المريض: {}",name))
            .bind(actor).bind(request.amount).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        for (account_id,kind) in [(debit,"debit"),(receivable,"credit")] {
            sqlx::query("INSERT INTO main.journal_entries(journal_id,account_id,type,amount) VALUES(?,?,?,?)")
                .bind(&journal).bind(account_id).bind(kind).bind(request.amount)
                .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        }
        sqlx::query("INSERT INTO main.native_patient_financial_journal_receipts
              (source_kind,source_id,pharmacy_id,actor_id,journal_id,amount_cents,money_kind,cash_movement_id)
              VALUES('payment',?,?,?,?,?,?,?)")
            .bind(&id).bind(&pharmacy).bind(actor).bind(&journal)
            .bind((request.amount*100.0).round() as i64).bind(&request.payment_method)
            .bind(cash_movement_id)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
                    VALUES(?,'PATIENT_PAYMENT',?,?)")
            .bind(actor).bind(format!("Patient {} paid {} via {}",request.patient_id,request.amount,request.payment_method))
            .bind(&pharmacy).execute(&mut *conn).await.map_err(|e|e.to_string())?;
        Ok(PatientPaymentReceipt{id,remaining_balance:(outstanding-request.amount).max(0.0)})
    }.await;
    match result {
        Ok(value) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(value)
        }
        Err(err) => {
            tx.rollback()
                .await
                .map_err(|rollback| format!("{err}; rollback failed: {rollback}"))?;
            Err(err)
        }
    }
}

// The real native money handler, without opening a Tauri window. Only exposed
// to sibling Rust regression tests with disposable SQLite connections.
#[cfg(test)]
pub(super) async fn post_on_isolated_test_connection(
    conn: &mut SqliteConnection,
    actor: &str,
    request: PatientPaymentInput,
) -> Result<PatientPaymentReceipt, String> {
    post(conn, actor, request).await
}

#[tauri::command]
pub async fn post_patient_payment_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PatientPaymentInput,
) -> Result<PatientPaymentReceipt, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    post(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

/// A lost IPC ACK is not proof that money was posted. Only this read-only
/// receipt lookup can independently acknowledge the exact ORIGINAL request.
/// The historical 033 scope tag alone is insufficient: 051 balanced journal
/// and 055 exact cash UUID must both match the original immutable source.
async fn confirm_patient_payment(
    conn: &mut SqliteConnection,
    actor: &str,
    request: PatientPaymentInput,
) -> Result<Option<PatientPaymentConfirmation>, String> {
    validate(&request)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN")))
            .await.map_err(|e| e.to_string())?;
    let result = async {
        let conn = &mut *tx;
        let (role, pharmacy) = active_generic_actor(conn, actor).await?;
        let permissions: Option<String> = sqlx::query_scalar(
            "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
        )
        .bind(actor)
        .fetch_one(&mut *conn)
        .await.map_err(|e| e.to_string())?;
        for key in ["can_view_patients", "acc_can_process_cash_flow"] {
            if !user_has_permission(Some(&role), permissions.as_deref(), key, false) {
                return Err("Unauthorized native patient payment confirmation".into());
            }
        }
        let cents = (request.amount * 100.0).round() as i64;
        let matched: Option<String> = sqlx::query_scalar(
            "SELECT pt.id FROM main.patient_payment_scope sc
             JOIN main.patient_transactions pt ON pt.id=sc.transaction_id
             JOIN main.native_patient_financial_journal_receipts r
               ON r.source_kind='payment' AND r.source_id=pt.id
             JOIN main.daily_journals j ON j.id=r.journal_id
             WHERE sc.request_id=? AND sc.pharmacy_id=?
               AND pt.patient_id=? AND pt.user_id=? AND pt.type='payment'
               AND pt.date=? AND pt.payment_method=? AND pt.payment_method IN ('cash','bank')
               AND pt.notes IS ?
               AND typeof(pt.amount) IN ('real','integer') AND pt.amount>0
               AND ABS(pt.amount*100.0-?)<0.00001
               AND r.pharmacy_id=sc.pharmacy_id AND r.actor_id=pt.user_id
               AND r.money_kind=pt.payment_method AND r.amount_cents=?
               AND j.pharmacy_id=r.pharmacy_id AND CAST(j.created_by AS TEXT)=r.actor_id
               AND j.date=pt.date AND typeof(j.total_amount) IN ('real','integer')
               AND ABS(j.total_amount*100.0-r.amount_cents)<0.00001
               AND (SELECT COUNT(*) FROM main.journal_entries je
                    WHERE je.journal_id=r.journal_id)=2
               AND (SELECT COUNT(*) FROM main.journal_entries je
                    JOIN main.accounts a ON a.id=je.account_id
                    WHERE je.journal_id=r.journal_id AND je.type='credit'
                      AND a.code='1.1.2' AND COALESCE(a.is_group,0)=0
                      AND typeof(je.amount) IN ('real','integer')
                      AND ABS(je.amount*100.0-r.amount_cents)<0.00001)=1
               AND (SELECT COUNT(*) FROM main.journal_entries je
                    JOIN main.accounts a ON a.id=je.account_id
                    WHERE je.journal_id=r.journal_id AND je.type='debit'
                      AND a.code=CASE WHEN r.money_kind='cash' THEN '1.1.1' ELSE '1.1.4' END
                      AND COALESCE(a.is_group,0)=0
                      AND typeof(je.amount) IN ('real','integer')
                      AND ABS(je.amount*100.0-r.amount_cents)<0.00001)=1
               AND (
                 (r.money_kind='bank' AND r.cash_movement_id IS NULL)
                 OR (r.money_kind='cash' AND r.cash_movement_id IS NOT NULL
                   AND EXISTS (
                     SELECT 1 FROM main.cash_movements cm
                     JOIN main.shifts sh
                       ON CAST(sh.id AS TEXT)=CAST(cm.shift_id AS TEXT)
                     WHERE cm.id=r.cash_movement_id AND LENGTH(cm.id)=36
                       AND cm.source_type='patient_payment' AND cm.target_name=pt.patient_id
                       AND cm.type='receipt' AND cm.category='accounts_receivable'
                       AND cm.pharmacy_id=r.pharmacy_id AND sh.pharmacy_id=r.pharmacy_id
                       AND CAST(cm.user_id AS TEXT)=r.actor_id AND cm.date=pt.date
                       AND typeof(cm.amount) IN ('real','integer')
                       AND ABS(cm.amount*100.0-r.amount_cents)<0.00001
                   ))
               )
             LIMIT 1",
        )
        .bind(&request.request_id)
        .bind(&pharmacy)
        .bind(&request.patient_id)
        .bind(actor)
        .bind(&request.date)
        .bind(&request.payment_method)
        .bind(request.notes.as_deref())
        .bind(cents)
        .bind(cents)
        .fetch_optional(&mut *conn)
        .await.map_err(|e| e.to_string())?;
        let Some(id) = matched else { return Ok(None); };
        // A sealed payment cannot validate tenant ownership of an unrelated
        // legacy invoice. Recheck all original credit sources and payment
        // witnesses under the SAME snapshot; never manufacture owed funds.
        let foreign: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.sales_invoices
             WHERE patient_id=? AND pharmacy_id IS NOT ?",
        )
        .bind(&request.patient_id).bind(&pharmacy)
        .fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
        let verified_credit: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.sales_invoices s
             JOIN main.native_sale_cogs_provenance n ON n.sale_id=s.id
             WHERE s.patient_id=? AND s.pharmacy_id=? AND n.pharmacy_id=?
               AND s.payment_method='credit' AND n.payment_method='credit'
               AND LOWER(COALESCE(s.status,''))='completed'
               AND typeof(s.total_amount) IN ('real','integer') AND s.total_amount>=0
               AND ABS(s.total_amount*1000000.0-n.sale_micros)<=2",
        )
        .bind(&request.patient_id).bind(&pharmacy).bind(&pharmacy)
        .fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
        let ambiguous = super::financial_notices_native::count_untrusted_patient_transactions(
            conn, &request.patient_id, &pharmacy,
        ).await?;
        // A 061 directory witness, WHEN one exists, must explicitly identify
        // this pharmacy. An older 043 receipted sale may precede migration 061;
        // never manufacture ownership by backfilling such a historical row.
        let incompatible_owner: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.native_patient_directory_ownership owned
             WHERE owned.patient_id=? AND
               (owned.pharmacy_id IS NOT ? OR owned.pharmacy_id='local_default'
                OR LENGTH(owned.intent_sha256)<>64)",
        )
        .bind(&request.patient_id).bind(&pharmacy)
        .fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
        let opening: Option<f64> = sqlx::query_scalar(
            "SELECT CAST(COALESCE(opening_balance,0) AS REAL)
             FROM main.patients WHERE id=? LIMIT 1",
        ).bind(&request.patient_id).fetch_optional(&mut *conn)
            .await.map_err(|e| e.to_string())?;
        if foreign != 0 || verified_credit == 0 || ambiguous != 0 || incompatible_owner != 0 ||
            opening.map_or(true, |v| !v.is_finite() || v.abs()>0.000_001) {
            return Err("Patient payment source ownership is not independently verified".into());
        }
        super::financial_notices_native::verify_proven_patient_credit_sources(
            conn, &request.patient_id, &pharmacy,
        ).await?;
        super::financial_notices_native::verify_patient_account_return_amounts(
            conn, &request.patient_id, &pharmacy,
        ).await?;
        super::financial_notices_native::verify_native_notice_mirrors(
            conn, &request.patient_id, &pharmacy,
        ).await?;
        verify_scoped_patient_payments(conn, &request.patient_id, &pharmacy).await?;
        Ok(Some(PatientPaymentConfirmation {
            id, request_id: request.request_id, patient_id: request.patient_id,
            actor_id: actor.to_owned(), pharmacy_id: pharmacy,
            amount_cents: cents, payment_method: request.payment_method,
            date: request.date,
        }))
    }.await;
    // BEGIN, never BEGIN IMMEDIATE: no mutating SQL is executed on this path.
    tx.rollback().await.map_err(|e| e.to_string())?;
    result
}

#[tauri::command]
pub async fn confirm_patient_payment_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PatientPaymentInput,
) -> Result<Option<PatientPaymentConfirmation>, String> {
    let actor = session.authorize_session().await?;
    let pool = app.try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    confirm_patient_payment(
        &mut conn, actor.as_deref().ok_or("Login required")?, payload,
    ).await
}

fn validate_wallet_request(input: &PatientWalletTopUpInput) -> Result<i64, String> {
    if !safe_text(&input.patient_id, 128)
        || !safe_text(&input.request_id, 128)
        || input.notes.as_deref().is_some_and(|value| value.len() > 2000 || value.contains('\0'))
        || !input.amount.is_finite()
        || !(0.0..=1e12).contains(&input.amount)
        || input.amount == 0.0
        || (input.amount * 100.0 - (input.amount * 100.0).round()).abs() > 0.000_000_1
    {
        return Err("Invalid native patient wallet top-up request".into());
    }
    Ok((input.amount * 100.0).round() as i64)
}

async fn authorized_wallet_pharmacy(conn: &mut SqliteConnection, actor: &str) -> Result<String, String> {
    let (role, pharmacy) = active_generic_actor(conn, actor).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    for key in ["can_view_patients", "acc_can_process_cash_flow"] {
        if !user_has_permission(Some(&role), permissions.as_deref(), key, false) {
            return Err("Unauthorized native patient wallet top-up".into());
        }
    }
    Ok(pharmacy)
}

pub(super) async fn certified_wallet_balance(
    conn: &mut SqliteConnection,
    patient_id: &str,
    pharmacy: &str,
) -> Result<(String, f64), String> {
    let patient = sqlx::query(
        "SELECT full_name, CAST(COALESCE(wallet_balance,0) AS REAL) AS wallet_balance
         FROM main.patients WHERE id=? LIMIT 1",
    )
    .bind(patient_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or("Patient record not found")?;
    let name: String = patient.try_get("full_name").map_err(|e| e.to_string())?;
    let balance: f64 = patient.try_get("wallet_balance").map_err(|e| e.to_string())?;
    if !balance.is_finite() || balance < 0.0 || balance > 1e12 {
        return Err("Patient wallet has an invalid historical balance".into());
    }
    // Global patient IDs are not ownership proof. An authenticated native
    // sale suffices for a nonempty history. Before any sale, only a *newly*
    // native-created patient with immutable 061 directory witness and a
    // provably empty original financial history may initialize a wallet.
    let sale_counts: (i64, i64) = sqlx::query_as(
        "SELECT
           (SELECT COUNT(*) FROM main.sales_invoices si
            JOIN main.native_sale_cogs_provenance source ON source.sale_id=si.id
            WHERE si.patient_id=? AND si.pharmacy_id=? AND source.pharmacy_id=?),
           (SELECT COUNT(*) FROM main.sales_invoices si WHERE si.patient_id=?
            AND si.pharmacy_id IS NOT ?)",
    )
    .bind(patient_id)
    .bind(pharmacy)
    .bind(pharmacy)
    .bind(patient_id)
    .bind(pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if sale_counts.1 != 0
        || super::financial_notices_native::count_untrusted_patient_transactions(
            conn, patient_id, pharmacy,
        ).await? > 0
    {
        return Err("Patient wallet ownership could not be certified".into());
    }
    if sale_counts.0 == 0 {
        let pristine_owner: i64 = sqlx::query_scalar(
            "SELECT EXISTS(
               SELECT 1 FROM main.native_patient_directory_ownership owned
               JOIN main.patients patient ON patient.id=owned.patient_id
               WHERE owned.patient_id=? AND owned.pharmacy_id=?
                 AND owned.pharmacy_id<>'local_default'
                 AND length(owned.intent_sha256)=64
                 AND typeof(patient.opening_balance) IN ('integer','real')
                 AND patient.opening_balance=0
                 AND NOT EXISTS(SELECT 1 FROM main.sales_invoices s
                                WHERE s.patient_id=owned.patient_id)
                 AND NOT EXISTS(SELECT 1 FROM main.patient_transactions p
                                WHERE p.patient_id=owned.patient_id)
                 AND NOT EXISTS(SELECT 1 FROM main.financial_notices n
                                WHERE n.target_type='customer'
                                  AND n.target_id=owned.patient_id)
             )",
        )
        .bind(patient_id)
        .bind(pharmacy)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if pristine_owner != 1 {
            return Err("Patient wallet ownership could not be certified".into());
        }
        // A previously sealed 060 top-up may already have funded this still
        // sale-free wallet. The aggregate conservation proof below validates
        // that balance against only those immutable native receipts; it never
        // accepts an unexplained positive historical patient-wallet field.
    }
    // A SUM over only receipted wallet movements must not turn a missing
    // completed debit/refund receipt into a false zero. Unlike historical
    // global wallet balances, these sources explicitly name this patient and
    // tenant; their absence from 043 provenance blocks new cash collection.
    let unverified_wallet_sources: i64 = sqlx::query_scalar(
        "SELECT EXISTS(
           SELECT 1 FROM main.sales_invoices si
           WHERE si.patient_id=? AND si.pharmacy_id=?
             AND si.payment_method='wallet'
             AND LOWER(COALESCE(si.status,'')) NOT IN ('draft','cancelled')
             AND (LOWER(COALESCE(si.status,''))!='completed'
               OR NOT EXISTS (
                 SELECT 1 FROM main.native_sale_cogs_provenance n
                 WHERE n.sale_id=si.id AND n.pharmacy_id=si.pharmacy_id
                   AND typeof(si.total_amount) IN ('real','integer')
                   AND si.total_amount>=0
                   AND ABS(si.total_amount*1000000.0-n.sale_micros)<=2
               ))
         ) OR EXISTS(
           SELECT 1 FROM main.returns r
           JOIN main.sales_invoices si ON si.id=r.invoice_id
           WHERE si.patient_id=? AND si.pharmacy_id=?
             AND r.refund_method='wallet'
             AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
             AND (r.pharmacy_id IS NOT ? OR NOT EXISTS (
               SELECT 1 FROM main.native_sale_return_cogs_provenance n
               WHERE n.return_id=r.id AND n.sale_id=si.id
                 AND n.pharmacy_id=si.pharmacy_id AND n.refund_method='wallet'
                 AND typeof(r.total_refund) IN ('real','integer')
                 AND r.total_refund>=0
                 AND ABS(r.total_refund*1000000.0-n.refund_micros)<=2
             ) OR NOT EXISTS (
               SELECT 1 FROM main.native_sale_cogs_provenance original
               WHERE original.sale_id=si.id AND original.pharmacy_id=si.pharmacy_id
                 AND typeof(si.total_amount) IN ('real','integer')
                 AND si.total_amount>=0
                 AND ABS(si.total_amount*1000000.0-original.sale_micros)<=2
             ))
         )",
    )
    .bind(patient_id).bind(pharmacy)
    .bind(patient_id).bind(pharmacy).bind(pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if unverified_wallet_sources != 0 {
        return Err("Patient wallet contains unverified wallet sale or refund source".into());
    }
    // Reconcile the current wallet against independently sealed native
    // sales, refunds and all prior top-up receipt amounts.
    let wallet_sales: f64 = sqlx::query_scalar(
        "SELECT CAST(COALESCE(SUM(si.total_amount),0) AS REAL) FROM main.sales_invoices si
         JOIN main.native_sale_cogs_provenance n ON n.sale_id=si.id
         WHERE si.patient_id=? AND si.pharmacy_id=? AND n.pharmacy_id=?
           AND si.payment_method='wallet' AND LOWER(COALESCE(si.status,''))='completed'
           AND ABS(si.total_amount*1000000.0-n.sale_micros)<=2",
    )
    .bind(patient_id).bind(pharmacy).bind(pharmacy)
    .fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
    let wallet_refunds: f64 = sqlx::query_scalar(
        "SELECT CAST(COALESCE(SUM(r.total_refund),0) AS REAL) FROM main.returns r
         JOIN main.sales_invoices si ON si.id=r.invoice_id
         JOIN main.native_sale_return_cogs_provenance n ON n.return_id=r.id
         WHERE si.patient_id=? AND si.pharmacy_id=? AND r.pharmacy_id=?
           AND n.pharmacy_id=? AND n.refund_method='wallet'
           AND r.refund_method='wallet'
           AND n.sale_id=si.id AND ABS(r.total_refund*1000000.0-n.refund_micros)<=2
           AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')",
    )
    .bind(patient_id).bind(pharmacy).bind(pharmacy).bind(pharmacy)
    .fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
    let previous_cents: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount_cents),0) FROM main.native_patient_wallet_topup_receipts
         WHERE patient_id=? AND pharmacy_id=?",
    )
    .bind(patient_id).bind(pharmacy)
    .fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
    let expected = wallet_refunds + previous_cents as f64 / 100.0 - wallet_sales;
    if !expected.is_finite() || expected < -0.000_001 || (expected - balance).abs() > 0.000_001 {
        return Err("Patient wallet balance lacks verified tenant-native source history".into());
    }
    Ok((name, balance))
}

/// Wallet credit, cash intake, accounting and sealed UUID witnesses must be
/// one native BEGIN IMMEDIATE operation. Global patient ID alone is never a
/// pharmacy ownership claim. No historical wallet balance is backfilled.
pub(super) async fn wallet_top_up(
    conn: &mut SqliteConnection,
    actor: &str,
    input: PatientWalletTopUpInput,
) -> Result<PatientWalletTopUpReceipt, String> {
    let amount_cents = validate_wallet_request(&input)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result = async {
        let conn = &mut *tx;
        let pharmacy = authorized_wallet_pharmacy(conn, actor).await?;
        if sqlx::query_scalar::<_, i64>(
            "SELECT 1 FROM main.native_patient_wallet_topup_receipts WHERE request_id=?",
        )
        .bind(&input.request_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .is_some()
        {
            return Err("Patient wallet top-up request already processed".into());
        }
        let (name, balance) = certified_wallet_balance(conn, &input.patient_id, &pharmacy).await?;
        let cash_account = account(conn, "cash_drawer", "1.1.1").await?;
        let wallet_account = account(conn, "patient_wallet_liability", "2.2").await?;
        if cash_account == wallet_account {
            return Err("Wallet cash and liability accounts must differ".into());
        }
        let shift = payment_shift(conn, actor, &pharmacy, None).await?;
        let movement = Uuid::new_v4().to_string();
        let journal = Uuid::new_v4().to_string();
        let date: String = sqlx::query_scalar("SELECT date('now','localtime')")
            .fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
        sqlx::query(
            "UPDATE main.patients SET wallet_balance=COALESCE(wallet_balance,0)+? WHERE id=?",
        )
        .bind(input.amount)
        .bind(&input.patient_id)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT INTO main.cash_movements
             (id,user_id,shift_id,type,category,amount,source_type,target_name,notes,date,pharmacy_id)
             VALUES(?,?,?,'receipt','patient_wallet',?,'patient_wallet',?,?,?,?)",
        )
        .bind(&movement)
        .bind(actor)
        .bind(&shift)
        .bind(input.amount)
        .bind(&input.patient_id)
        .bind(format!("شحن محفظة {}: {}", name, input.notes.as_deref().unwrap_or("")))
        .bind(&date)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT INTO main.daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
             VALUES(?,?,?,?,?,?)",
        )
        .bind(&journal)
        .bind(&date)
        .bind(format!("شحن محفظة المريض: {}", name))
        .bind(actor)
        .bind(input.amount)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        for (id, kind) in [(cash_account, "debit"), (wallet_account, "credit")] {
            sqlx::query(
                "INSERT INTO main.journal_entries(journal_id,account_id,type,amount) VALUES(?,?,?,?)",
            )
            .bind(&journal)
            .bind(id)
            .bind(kind)
            .bind(input.amount)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        }
        sqlx::query(
            "INSERT INTO main.native_patient_wallet_topup_receipts
             (request_id,patient_id,pharmacy_id,actor_id,shift_id,cash_movement_id,journal_id,amount_cents)
             VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(&input.request_id)
        .bind(&input.patient_id)
        .bind(&pharmacy)
        .bind(actor)
        .bind(&shift)
        .bind(&movement)
        .bind(&journal)
        .bind(amount_cents)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO main.activity_log(user_id,action,details,pharmacy_id) VALUES(?,'PATIENT_WALLET_TOPUP',?,?)")
            .bind(actor).bind(format!("Patient {} wallet topped up by {}",input.patient_id,input.amount))
            .bind(&pharmacy).execute(&mut *conn).await.map_err(|e| e.to_string())?;
        Ok(PatientWalletTopUpReceipt { id: input.request_id, balance: balance + input.amount })
    }
    .await;
    match result {
        Ok(receipt) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(receipt)
        }
        Err(error) => {
            tx.rollback().await.map_err(|e| format!("{error}; rollback failed: {e}"))?;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn top_up_patient_wallet_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PatientWalletTopUpInput,
) -> Result<PatientWalletTopUpReceipt, String> {
    let actor = session.authorize_session().await?;
    let pool = app.try_state::<GuardedReadPool>().ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    wallet_top_up(&mut conn, actor.as_deref().ok_or("Login required")?, payload).await
}

/// Resolve only an uncertain IPC reply. This never posts cash or returns a
/// receipt by nonce alone: the current authenticated actor, tenant, patient,
/// exact amount and unmodified financial witnesses must all still agree.
async fn confirm_wallet_top_up(
    conn: &mut SqliteConnection,
    actor: &str,
    input: PatientWalletTopUpInput,
) -> Result<Option<PatientWalletTopUpConfirmation>, String> {
    let cents = validate_wallet_request(&input)?;
    reset_cancelled_read_state(conn).await?;
    // Keep authorization, receipt, cash/journal witness and live balance in
    // one consistent read snapshot; this command never obtains a write lock.
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN")))
            .await.map_err(|e| e.to_string())?;
    let result = async {
        let conn = &mut *tx;
        let pharmacy = authorized_wallet_pharmacy(conn, actor).await?;
        let matched: Option<i64> = sqlx::query_scalar(
            "SELECT r.amount_cents FROM main.native_patient_wallet_topup_receipts r
             JOIN main.cash_movements cm ON cm.id=r.cash_movement_id
             JOIN main.shifts sh ON CAST(sh.id AS TEXT)=CAST(r.shift_id AS TEXT)
             JOIN main.daily_journals j ON j.id=r.journal_id
             WHERE r.request_id=? AND r.patient_id=? AND r.actor_id=? AND r.pharmacy_id=?
               AND r.amount_cents=? AND r.amount_cents>0
               AND cm.shift_id=r.shift_id AND cm.user_id=r.actor_id
               AND cm.pharmacy_id=r.pharmacy_id AND sh.pharmacy_id=r.pharmacy_id
               AND cm.type='receipt' AND cm.category='patient_wallet'
               AND cm.source_type='patient_wallet' AND cm.target_name=r.patient_id
               AND typeof(cm.amount) IN ('real','integer')
               AND ABS(cm.amount*100.0-r.amount_cents)<0.00001
               AND j.created_by=r.actor_id AND j.pharmacy_id=r.pharmacy_id
               AND typeof(j.total_amount) IN ('real','integer')
               AND ABS(j.total_amount*100.0-r.amount_cents)<0.00001
               AND cm.date=j.date
               AND (SELECT COUNT(*) FROM main.journal_entries je
                    WHERE je.journal_id=r.journal_id)=2
               AND (SELECT COUNT(*) FROM main.journal_entries je
                    JOIN main.accounts a ON a.id=je.account_id
                    WHERE je.journal_id=r.journal_id AND a.code='1.1.1'
                      AND COALESCE(a.is_group,0)=0 AND je.type='debit'
                      AND typeof(je.amount) IN ('real','integer')
                      AND ABS(je.amount*100.0-r.amount_cents)<0.00001)=1
               AND (SELECT COUNT(*) FROM main.journal_entries je
                    JOIN main.accounts a ON a.id=je.account_id
                    WHERE je.journal_id=r.journal_id AND a.code='2.2'
                      AND COALESCE(a.is_group,0)=0 AND je.type='credit'
                      AND typeof(je.amount) IN ('real','integer')
                      AND ABS(je.amount*100.0-r.amount_cents)<0.00001)=1
             LIMIT 1",
        )
        .bind(&input.request_id)
        .bind(&input.patient_id)
        .bind(actor)
        .bind(&pharmacy)
        .bind(cents)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if matched.is_none() {
            // A missing, foreign, mismatched or damaged source is never proof.
            return Ok(None);
        }
        let (_, balance) = certified_wallet_balance(conn, &input.patient_id, &pharmacy).await?;
        Ok(Some(PatientWalletTopUpConfirmation {
            id: input.request_id,
            patient_id: input.patient_id,
            actor_id: actor.to_owned(),
            pharmacy_id: pharmacy,
            amount_cents: cents,
            balance,
        }))
    }.await;
    // Always roll back the read transaction (no writes are made).
    tx.rollback().await.map_err(|e| e.to_string())?;
    result
}

#[cfg(test)]
pub(super) async fn confirm_wallet_on_isolated_test_connection(
    conn: &mut SqliteConnection,
    actor: &str,
    request: PatientWalletTopUpInput,
) -> Result<Option<PatientWalletTopUpConfirmation>, String> {
    confirm_wallet_top_up(conn, actor, request).await
}

#[tauri::command]
pub async fn confirm_patient_wallet_top_up_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PatientWalletTopUpInput,
) -> Result<Option<PatientWalletTopUpConfirmation>, String> {
    let actor = session.authorize_session().await?;
    let pool = app.try_state::<GuardedReadPool>().ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    confirm_wallet_top_up(&mut conn, actor.as_deref().ok_or("Login required")?, payload).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    async fn setup_through_051() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        db.execute(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,is_active INTEGER,pharmacy_id TEXT);
            INSERT INTO users VALUES
             ('owner-a','owner','{}',1,'a'),('owner-b','owner','{}',1,'b'),
             ('pay-a','cashier','{"can_view_patients":true,"acc_can_process_cash_flow":true}',1,'a'),
             ('denied','cashier','{"can_view_patients":true}',1,'a'),
             ('inactive','owner','{}',0,'a');
            CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT,opening_balance REAL DEFAULT 0);
            INSERT INTO patients VALUES('p','Patient A',0),('mixed','Mixed',0),('historical','Historic',5),('unlinked','Unlinked',0);
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,patient_id TEXT,pharmacy_id TEXT,payment_method TEXT,status TEXT,total_amount REAL);
            INSERT INTO sales_invoices VALUES ('a-sale','p','a','credit','completed',100),
              ('a-mixed','mixed','a','credit','completed',60),('b-mixed','mixed','b','credit','completed',60),
              ('old','historical','a','credit','completed',30);
            CREATE TABLE native_sale_cogs_provenance(sale_id TEXT PRIMARY KEY,pharmacy_id TEXT,payment_method TEXT,sale_micros INTEGER);
            INSERT INTO native_sale_cogs_provenance
              SELECT id,pharmacy_id,payment_method,CAST(total_amount*1000000 AS INTEGER)
              FROM sales_invoices;
            CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,pharmacy_id TEXT,refund_method TEXT,status TEXT,total_refund REAL);
            INSERT INTO returns VALUES('a-return','a-sale','a','patient_account','approved',15);
            CREATE TABLE native_sale_return_cogs_provenance(return_id TEXT PRIMARY KEY,sale_id TEXT,pharmacy_id TEXT,refund_method TEXT,refund_micros INTEGER,actor_id TEXT);
            INSERT INTO native_sale_return_cogs_provenance VALUES('a-return','a-sale','a','patient_account',15000000,'owner-a');
            CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT,total_price REAL);
            INSERT INTO return_items VALUES(1,'a-return',15);
            CREATE TABLE patient_transactions(id TEXT PRIMARY KEY,patient_id TEXT,user_id TEXT,type TEXT,amount REAL,payment_method TEXT,notes TEXT,date TEXT);
            CREATE TABLE financial_notices(id TEXT PRIMARY KEY,target_type TEXT,target_id TEXT,type TEXT,
              user_id TEXT,amount REAL,date TEXT,pharmacy_id TEXT);
            CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER DEFAULT 0);
            INSERT INTO accounts VALUES(1,'1.1.1',0),(2,'1.1.4',0),(3,'1.1.2',0);
            CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
            INSERT INTO trial_balance_settings VALUES('cash_drawer',1),('bank_clearing',2),('accounts_receivable',3);
            CREATE TABLE shifts(id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,status TEXT,start_time TEXT,starting_cash REAL,notes TEXT);
            INSERT INTO shifts VALUES('b-shift','owner-b','b','open','2026-10-11',0,NULL);
            CREATE TABLE cash_movements(id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,type TEXT,category TEXT,amount REAL,source_type TEXT,target_name TEXT,notes TEXT,date TEXT,pharmacy_id TEXT);
            CREATE TABLE daily_journals(id TEXT PRIMARY KEY,date TEXT,description TEXT,created_by TEXT,total_amount REAL,pharmacy_id TEXT);
            CREATE TABLE journal_entries(id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
            CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
        "#).await.unwrap();
        db.execute(include_str!(
            "../../migrations/033_patient_payment_scope.sql"
        ))
        .await
        .unwrap();
        db.execute(include_str!(
            "../../migrations/036_financial_notice_provenance.sql"
        ))
        .await
        .unwrap();
        db.execute(include_str!(
            "../../migrations/051_patient_financial_journal_receipts.sql"
        ))
        .await
        .unwrap();
        db
    }

    async fn setup() -> SqliteConnection {
        let mut db = setup_through_051().await;
        db.execute(include_str!(
            "../../migrations/055_patient_cash_movement_witness.sql"
        ))
        .await
        .unwrap();
        db
    }

    fn pay(patient: &str, amount: f64, method: &str, request_id: &str) -> PatientPaymentInput {
        PatientPaymentInput {
            patient_id: patient.into(),
            shift_id: Some("b-shift".into()),
            amount,
            payment_method: method.into(),
            notes: Some("test".into()),
            date: "2026-10-11".into(),
            request_id: request_id.into(),
        }
    }
    async fn count(db: &mut SqliteConnection, table: &str) -> i64 {
        let sql = match table {
            "payments" => "SELECT COUNT(*) FROM patient_transactions",
            "scope" => "SELECT COUNT(*) FROM patient_payment_scope",
            "cash" => "SELECT COUNT(*) FROM cash_movements",
            "journal" => "SELECT COUNT(*) FROM daily_journals",
            "entries" => "SELECT COUNT(*) FROM journal_entries",
            "shifts" => "SELECT COUNT(*) FROM shifts",
            _ => panic!("bad fixture table"),
        };
        sqlx::query_scalar(sql).fetch_one(&mut *db).await.unwrap()
    }

    // The checkout transaction is private to sibling critical.rs. These
    // disposable sources therefore model its persisted invoice/stock/journal
    // outputs, but the 043 receipt is generated by the actual production
    // record_sale writer and validated by the real 043 SQLite triggers.
    // 051/055 settlement below invokes the actual native patient writer.
    async fn receipt_backed_credit_sale_fixture() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        db.execute("PRAGMA foreign_keys=ON").await.unwrap();
        db.execute(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,is_active INTEGER,pharmacy_id TEXT);
            INSERT INTO users VALUES
              ('owner-a','owner','{}',1,'tenant-a'),
              ('owner-b','owner','{}',1,'tenant-b'),
              ('cashier-a','cashier','{"can_view_patients":true,"acc_can_process_cash_flow":true}',1,'tenant-a'),
              ('readonly-a','cashier','{"can_view_patients":true}',1,'tenant-a'),
              ('inactive-a','owner','{}',0,'tenant-a');
            CREATE TABLE patients(
              id TEXT PRIMARY KEY,full_name TEXT,
              opening_balance REAL DEFAULT 0,wallet_balance REAL DEFAULT 0);
            INSERT INTO patients(id,full_name) VALUES
              ('owned-patient','Prospective patient'),('foreign-patient','Foreign patient'),
              ('pristine-patient','061-only wallet'),('historical-patient','Unwitnessed past');
            CREATE TABLE sales_invoices(
              id TEXT PRIMARY KEY,patient_id TEXT,pharmacy_id TEXT,user_id TEXT,
              payment_method TEXT,status TEXT,total_amount REAL);
            CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT,drug_id INTEGER);
            INSERT INTO inventory VALUES('tenant-a-lot','tenant-a',7),('tenant-b-lot','tenant-b',7);
            CREATE TABLE sales_items(
              id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,drug_id INTEGER,
              quantity_sold REAL,unit_price REAL,cost_price REAL,unit TEXT,
              is_negative INTEGER DEFAULT 0,large_to_medium REAL,medium_to_small REAL);
            CREATE TABLE returns(
              id TEXT PRIMARY KEY,invoice_id TEXT,pharmacy_id TEXT,
              refund_method TEXT,status TEXT,total_refund REAL);
            CREATE TABLE return_items(
              id INTEGER PRIMARY KEY,return_id TEXT,sale_item_id INTEGER,inventory_id TEXT,
              drug_id INTEGER,quantity_returned REAL,unit TEXT,total_price REAL);
            CREATE TABLE patient_transactions(
              id TEXT PRIMARY KEY,patient_id TEXT,user_id TEXT,type TEXT,amount REAL,
              payment_method TEXT,notes TEXT,date TEXT);
            CREATE TABLE financial_notices(
              id TEXT PRIMARY KEY,target_type TEXT,target_id TEXT,type TEXT,
              user_id TEXT,amount REAL,date TEXT,pharmacy_id TEXT);
            CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER DEFAULT 0);
            INSERT INTO accounts VALUES
              (1,'1.1.1',0),(2,'1.1.4',0),(3,'1.1.2',0),
              (4,'3.1',0),(5,'4.1',0),(6,'1.1.3',0),(7,'2.2',0);
            CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
            INSERT INTO trial_balance_settings VALUES
              ('cash_drawer',1),('bank_clearing',2),
              ('accounts_receivable',3),('patient_wallet_liability',7);
            CREATE TABLE shifts(
              id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,status TEXT,
              start_time TEXT,starting_cash REAL,notes TEXT);
            INSERT INTO shifts VALUES
              ('tenant-a-shift','owner-a','tenant-a','open','2026-10-17',0,NULL),
              ('tenant-b-shift','owner-b','tenant-b','open','2026-10-17',0,NULL);
            CREATE TABLE cash_movements(
              id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,type TEXT,category TEXT,
              amount REAL,source_type TEXT,target_name TEXT,notes TEXT,date TEXT,pharmacy_id TEXT);
            CREATE TABLE daily_journals(
              id TEXT PRIMARY KEY,date TEXT,description TEXT,created_by TEXT,
              total_amount REAL,pharmacy_id TEXT);
            CREATE TABLE journal_entries(
              id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
            CREATE TABLE activity_log(
              id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
        "#).await.unwrap();
        for migration in [
            include_str!("../../migrations/033_patient_payment_scope.sql"),
            include_str!("../../migrations/036_financial_notice_provenance.sql"),
            include_str!("../../migrations/043_native_sales_cogs_provenance.sql"),
            include_str!("../../migrations/051_patient_financial_journal_receipts.sql"),
            include_str!("../../migrations/055_patient_cash_movement_witness.sql"),
            include_str!("../../migrations/060_native_patient_wallet_topups.sql"),
            include_str!("../../migrations/061_native_patient_directory_ownership.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&mut db).await.unwrap();
        }
        // A test-only representation of an explicitly created 061 identity:
        // never infer ownership from sales, actors or historical patient IDs.
        db.execute(
            "INSERT INTO native_patient_directory_ownership
             (patient_id,pharmacy_id,actor_id,intent_sha256) VALUES
             ('owned-patient','tenant-a','owner-a',lower(hex(zeroblob(32)))),
             ('foreign-patient','tenant-b','owner-b',lower(hex(zeroblob(32)))),
             ('pristine-patient','tenant-a','owner-a',lower(hex(zeroblob(32))))",
        ).await.unwrap();

        for (sale, patient, actor, pharmacy, lot, journal, request) in [
            ("native-credit-a", "owned-patient", "owner-a", "tenant-a",
             "tenant-a-lot", "sale-journal-a", "7a111111-1111-4111-8111-111111111111"),
            ("native-credit-b", "foreign-patient", "owner-b", "tenant-b",
             "tenant-b-lot", "sale-journal-b", "7b222222-2222-4222-8222-222222222222"),
        ] {
            let mut tx = db.begin().await.unwrap();
            sqlx::query(
                "INSERT INTO sales_invoices
                 (id,patient_id,pharmacy_id,user_id,payment_method,status,total_amount)
                 VALUES(?,?,?,?,'credit','completed',150)",
            ).bind(sale).bind(patient).bind(pharmacy).bind(actor)
             .execute(&mut *tx).await.unwrap();
            sqlx::query(
                "INSERT INTO sales_items
                 (invoice_id,inventory_id,drug_id,quantity_sold,unit_price,cost_price,
                  unit,is_negative,large_to_medium,medium_to_small)
                 VALUES(?,?,7,1,150,60,'large',0,1,1)",
            ).bind(sale).bind(lot).execute(&mut *tx).await.unwrap();
            sqlx::query(
                "INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
                 VALUES(?,'2026-10-17','043 native credit fixture',?,210,?)",
            ).bind(journal).bind(actor).bind(pharmacy)
             .execute(&mut *tx).await.unwrap();
            for (account_id, kind, amount) in [
                (3, "debit", 150.0), (4, "credit", 150.0),
                (5, "debit", 60.0), (6, "credit", 60.0),
            ] {
                sqlx::query(
                    "INSERT INTO journal_entries(journal_id,account_id,type,amount)
                     VALUES(?,?,?,?)",
                ).bind(journal).bind(account_id).bind(kind).bind(amount)
                 .execute(&mut *tx).await.unwrap();
            }
            super::super::sales_cogs_provenance::record_sale(
                &mut tx, request, sale, actor, pharmacy, "credit", journal, 150.0, 60.0,
            ).await.expect("the real 043 source writer must seal this balanced credit sale");
            tx.commit().await.unwrap();
        }
        db
    }

    fn receipt_backed_pay(
        patient: &str, amount: f64, method: &str, request_id: &str,
    ) -> PatientPaymentInput {
        let mut request = pay(patient, amount, method, request_id);
        request.date = "2026-10-17".into();
        request.shift_id = Some("tenant-a-shift".into());
        request
    }

    fn wallet_request(
        patient: &str, amount: f64, request_id: &str,
    ) -> PatientWalletTopUpInput {
        PatientWalletTopUpInput {
            patient_id: patient.into(),
            amount,
            notes: Some("isolated exact-once wallet intent".into()),
            request_id: request_id.into(),
        }
    }

    #[tokio::test]
    async fn sealed_043_credit_then_real_051_055_cash_bank_settlement_and_lost_ack_replay() {
        let mut db = receipt_backed_credit_sale_fixture().await;
        let sale_receipts: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_sale_cogs_provenance
             WHERE payment_method='credit' AND line_count=1 AND cogs_micros=60000000",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(sale_receipts, 2, "both tenant sales need original sealed 043 evidence");

        let bank_nonce = "bank-first-response-might-be-lost";
        let bank = post(&mut db, "cashier-a", receipt_backed_pay("owned-patient", 50.0, "bank", bank_nonce))
            .await.unwrap();
        assert!((bank.remaining_balance - 100.0).abs() < 0.000001);
        let bank_lines: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT a.code,e.type,e.amount
             FROM native_patient_financial_journal_receipts r
             JOIN journal_entries e ON e.journal_id=r.journal_id
             JOIN accounts a ON a.id=e.account_id
             WHERE r.source_kind='payment' AND r.source_id=?
             ORDER BY e.type",
        ).bind(&bank.id).fetch_all(&mut db).await.unwrap();
        assert_eq!(bank_lines, vec![
            ("1.1.2".into(), "credit".into(), 50.0),
            ("1.1.4".into(), "debit".into(), 50.0),
        ]);
        assert_eq!(count(&mut db, "cash").await, 0, "bank does not touch the drawer");

        // Simulate loss of the first ACK: repeating precisely that native
        // request must not collect another 50, even with a different actor.
        let lost_ack = post(&mut db, "cashier-a", receipt_backed_pay("owned-patient", 50.0, "bank", bank_nonce)).await;
        assert!(lost_ack.as_ref().is_err_and(|e| e.contains("already processed")),
            "replay re-collected an already receipted bank transfer: {lost_ack:?}");
        let foreign_replay = post(&mut db, "owner-b", receipt_backed_pay("owned-patient", 50.0, "bank", bank_nonce)).await;
        assert!(foreign_replay.is_err(), "foreign actor replayed local settlement");
        assert_eq!(count(&mut db, "payments").await, 1);

        let cash_request = receipt_backed_pay("owned-patient", 40.0, "cash", "cash-after-bank");
        let cash = post(&mut db, "cashier-a", cash_request).await.unwrap();
        assert!((cash.remaining_balance - 60.0).abs() < 0.000001);
        let witness: (String, String, String, i64) = sqlx::query_as(
            "SELECT r.cash_movement_id,cm.shift_id,r.pharmacy_id,r.amount_cents
             FROM native_patient_financial_journal_receipts r
             JOIN cash_movements cm ON cm.id=r.cash_movement_id
             WHERE r.source_id=? AND r.source_kind='payment'
               AND cm.source_type='patient_payment' AND cm.type='receipt'
               AND cm.category='accounts_receivable'",
        ).bind(&cash.id).fetch_one(&mut db).await.unwrap();
        assert_eq!((&witness.1[..], &witness.2[..], witness.3),
            ("tenant-a-shift", "tenant-a", 4000));
        assert!(sqlx::query("UPDATE cash_movements SET amount=999 WHERE id=?")
            .bind(&witness.0).execute(&mut db).await.is_err(),
            "055 must seal the exact cash movement");
        assert_eq!(count(&mut db, "payments").await, 2);
        assert_eq!(count(&mut db, "scope").await, 2);
        assert_eq!(count(&mut db, "cash").await, 1);
        assert_eq!(count(&mut db, "journal").await, 4, "two sales + two settlements");
        assert_eq!(count(&mut db, "entries").await, 12);
    }

    #[tokio::test]
    async fn sealed_043_credit_rejects_cross_tenant_unowned_overpayment_and_atomic_failure() {
        let mut db = receipt_backed_credit_sale_fixture().await;
        let cross = post(&mut db, "cashier-a",
            receipt_backed_pay("foreign-patient", 20.0, "cash", "foreign-owned-credit")).await;
        assert!(cross.as_ref().is_err_and(|e| e.contains("provenance is ambiguous")),
            "foreign 043 source became local receivable: {cross:?}");
        let over = post(&mut db, "cashier-a",
            receipt_backed_pay("owned-patient", 150.01, "bank", "overpay-proven-credit")).await;
        assert!(over.as_ref().is_err_and(|e| e.contains("exceeds provable")),
            "overpayment was collected: {over:?}");
        db.execute(
            "INSERT INTO sales_invoices
             (id,patient_id,pharmacy_id,user_id,payment_method,status,total_amount)
             VALUES('uncertified-legacy','owned-patient',NULL,'owner-a','credit','completed',1)",
        ).await.unwrap();
        let ambiguous = post(&mut db, "cashier-a",
            receipt_backed_pay("owned-patient", 1.0, "bank", "ambiguous-legacy-credit")).await;
        assert!(ambiguous.as_ref().is_err_and(|e| e.contains("provenance is ambiguous")),
            "unowned new row must poison collection, not become free debt: {ambiguous:?}");
        assert_eq!(count(&mut db, "payments").await, 0);
        assert_eq!(count(&mut db, "journal").await, 2);
        assert_eq!(count(&mut db, "cash").await, 0);

        db.execute("DELETE FROM sales_invoices WHERE id='uncertified-legacy'").await.unwrap();
        db.execute(
            "CREATE TRIGGER force_payment_receipt_failure
             BEFORE INSERT ON native_patient_financial_journal_receipts
             BEGIN SELECT RAISE(ABORT,'isolated receipt failure'); END;",
        ).await.unwrap();
        let rolled_back = post(&mut db, "cashier-a",
            receipt_backed_pay("owned-patient", 25.0, "cash", "rollback-native-051")).await;
        assert!(rolled_back.as_ref().is_err_and(|e| e.contains("isolated receipt failure")),
            "financial receipt failure was not propagated: {rolled_back:?}");
        for table in ["payments", "scope", "cash"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} changed on rollback");
        }
        assert_eq!(count(&mut db, "journal").await, 2);
        assert_eq!(count(&mut db, "entries").await, 8);
    }

    #[tokio::test]
    async fn confirm_051_055_original_nonce_cash_bank_is_read_only_and_source_verified() {
        let mut db = receipt_backed_credit_sale_fixture().await;
        let bank = receipt_backed_pay("owned-patient", 35.0, "bank", "native-bank-original");
        let bank_post = post(&mut db, "cashier-a",
            receipt_backed_pay("owned-patient", 35.0, "bank", "native-bank-original"))
            .await.unwrap();
        let cash = receipt_backed_pay("owned-patient", 45.0, "cash", "native-cash-original");
        let cash_post = post(&mut db, "cashier-a",
            receipt_backed_pay("owned-patient", 45.0, "cash", "native-cash-original"))
            .await.unwrap();
        let before = (count(&mut db, "payments").await, count(&mut db, "scope").await,
            count(&mut db, "cash").await, count(&mut db, "journal").await,
            count(&mut db, "entries").await);
        for (input, payment_id, cents, method) in [
            (bank, bank_post.id, 3500, "bank"),
            (cash, cash_post.id, 4500, "cash"),
        ] {
            let confirmed = confirm_patient_payment(&mut db, "cashier-a", input)
                .await.unwrap().expect("051 journal and 055 cash prove the original nonce");
            assert_eq!(confirmed.id, payment_id);
            assert_eq!(confirmed.patient_id, "owned-patient");
            assert_eq!(confirmed.actor_id, "cashier-a");
            assert_eq!(confirmed.pharmacy_id, "tenant-a");
            assert_eq!(confirmed.amount_cents, cents);
            assert_eq!(confirmed.payment_method, method);
            assert_eq!(confirmed.date, "2026-10-17");
        }
        assert_eq!(before, (2, 2, 1, 4, 12));
        assert_eq!(before, (count(&mut db, "payments").await, count(&mut db, "scope").await,
            count(&mut db, "cash").await, count(&mut db, "journal").await,
            count(&mut db, "entries").await), "confirmation must never post/repost money");
    }

    #[tokio::test]
    async fn confirm_051_remains_valid_after_later_sealed_043_patient_account_refund() {
        let mut db = receipt_backed_credit_sale_fixture().await;
        let initial = receipt_backed_pay("owned-patient", 30.0, "bank", "before-later-refund");
        post(&mut db, "cashier-a",
            receipt_backed_pay("owned-patient", 30.0, "bank", "before-later-refund"))
            .await.unwrap();
        // Real 043 receipt writer, not an inferred legacy amount or direct
        // patient opening-balance edit. Source credit was previously sealed.
        db.execute("ALTER TABLE returns ADD COLUMN user_id TEXT")
            .await.unwrap();
        let sale_item: i64 = sqlx::query_scalar(
            "SELECT id FROM sales_items WHERE invoice_id='native-credit-a' LIMIT 1",
        ).fetch_one(&mut db).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        sqlx::query(
            "INSERT INTO returns
             (id,invoice_id,user_id,pharmacy_id,refund_method,status,total_refund)
             VALUES('later-refund','native-credit-a','owner-a','tenant-a',
                    'patient_account','approved',15)",
        ).execute(&mut *tx).await.unwrap();
        sqlx::query(
            "INSERT INTO return_items
             (return_id,sale_item_id,inventory_id,drug_id,quantity_returned,unit,total_price)
             VALUES('later-refund',?,'tenant-a-lot',7,0.1,'large',15)",
        ).bind(sale_item).execute(&mut *tx).await.unwrap();
        sqlx::query(
            "INSERT INTO daily_journals
             (id,date,description,created_by,total_amount,pharmacy_id)
             VALUES('later-return-journal','2026-10-17','043 receipted refund','owner-a',21,'tenant-a')",
        ).execute(&mut *tx).await.unwrap();
        for (account_id, kind, amount) in [
            (4,"debit",15.0), (6,"debit",6.0),
            (5,"credit",6.0), (3,"credit",15.0),
        ] {
            sqlx::query(
                "INSERT INTO journal_entries(journal_id,account_id,type,amount)
                 VALUES('later-return-journal',?,?,?)",
            ).bind(account_id).bind(kind).bind(amount)
                .execute(&mut *tx).await.unwrap();
        }
        super::super::sales_cogs_provenance::record_return(
            &mut tx, "c0111111-1111-4111-8111-111111111111",
            "later-refund", "native-credit-a", "owner-a", "tenant-a",
            "patient_account", "later-return-journal", 15.0, 6.0,
        ).await.expect("real 043 return writer must seal the refund source");
        tx.commit().await.unwrap();
        let confirmed = confirm_patient_payment(&mut db, "cashier-a", initial)
            .await.unwrap().expect("later authenticated return does not invalidate prior bank receipt");
        assert_eq!(confirmed.amount_cents, 3000);
        assert_eq!(count(&mut db, "payments").await, 1);
        assert_eq!(count(&mut db, "cash").await, 0);
        assert_eq!(count(&mut db, "journal").await, 4, "2 sales, bank payment, sealed refund");
    }

    #[tokio::test]
    async fn confirm_051_055_denies_wrong_nonce_actor_tenant_patient_method_date_amount_and_role() {
        let mut db = receipt_backed_credit_sale_fixture().await;
        let original = receipt_backed_pay("owned-patient", 20.0, "cash", "strict-payment-nonce");
        post(&mut db, "cashier-a",
            receipt_backed_pay("owned-patient", 20.0, "cash", "strict-payment-nonce"))
            .await.unwrap();
        for (field, changed) in [
            ("nonce", receipt_backed_pay("owned-patient",20.0,"cash","new-unproven-nonce")),
            ("patient", receipt_backed_pay("foreign-patient",20.0,"cash","strict-payment-nonce")),
            ("method", receipt_backed_pay("owned-patient",20.0,"bank","strict-payment-nonce")),
            ("amount", receipt_backed_pay("owned-patient",20.01,"cash","strict-payment-nonce")),
        ] {
            assert!(confirm_patient_payment(&mut db, "cashier-a", changed)
                .await.unwrap().is_none(), "{field} mismatch was accepted");
        }
        let mut wrong_date = receipt_backed_pay("owned-patient", 20.0, "cash", "strict-payment-nonce");
        wrong_date.date = "2026-10-16".into();
        assert!(confirm_patient_payment(&mut db,"cashier-a",wrong_date)
            .await.unwrap().is_none());
        assert!(confirm_patient_payment(&mut db, "owner-a",
            receipt_backed_pay("owned-patient", 20.0, "cash", "strict-payment-nonce"))
            .await.unwrap().is_none(), "different authorized actor cannot confirm");
        assert!(confirm_patient_payment(&mut db, "owner-b",
            receipt_backed_pay("owned-patient", 20.0, "cash", "strict-payment-nonce"))
            .await.unwrap().is_none(), "foreign pharmacy cannot confirm");
        for actor in ["readonly-a", "inactive-a", "missing-actor"] {
            assert!(confirm_patient_payment(&mut db, actor,
                receipt_backed_pay("owned-patient", 20.0, "cash", "strict-payment-nonce"))
                .await.is_err(), "{actor} was allowed to confirm payment");
        }
        assert!(confirm_patient_payment(&mut db, "cashier-a",
            receipt_backed_pay("owned-patient", 20.0, "cash", "strict-payment-nonce"))
            .await.unwrap().is_some());
        // An independent foreign invoice makes a previously claimed global
        // patient identity ambiguous; the receipt is not tenant adoption.
        db.execute(
            "INSERT INTO sales_invoices
             (id,patient_id,pharmacy_id,user_id,payment_method,status,total_amount)
             VALUES('unowned-after-payment','owned-patient','tenant-b','owner-b','credit','completed',1)",
        ).await.unwrap();
        assert!(confirm_patient_payment(&mut db, "cashier-a", original)
            .await.is_err(), "mixed-tenant credit source must fail closed");
        assert_eq!(count(&mut db, "payments").await, 1);
        assert_eq!(count(&mut db, "cash").await, 1);
    }

    #[tokio::test]
    async fn confirm_051_055_refuses_damaged_legacy_or_wrong_journal_without_mutating() {
        let mut db = receipt_backed_credit_sale_fixture().await;
        let request = receipt_backed_pay("owned-patient", 25.0, "cash", "damaged-cash-witness");
        let posted = post(&mut db, "cashier-a",
            receipt_backed_pay("owned-patient", 25.0, "cash", "damaged-cash-witness"))
            .await.unwrap();
        assert!(confirm_patient_payment(&mut db,"cashier-a",
            receipt_backed_pay("owned-patient",25.0,"cash","damaged-cash-witness"))
            .await.unwrap().is_some());
        let receipt: (String, String) = sqlx::query_as(
            "SELECT journal_id,cash_movement_id FROM native_patient_financial_journal_receipts
             WHERE source_kind='payment' AND source_id=?",
        ).bind(&posted.id).fetch_one(&mut db).await.unwrap();
        db.execute("DROP TRIGGER native_patient_cash_witness_movement_no_update")
            .await.unwrap();
        sqlx::query("UPDATE cash_movements SET amount=24 WHERE id=?")
            .bind(&receipt.1).execute(&mut db).await.unwrap();
        assert!(confirm_patient_payment(&mut db, "cashier-a", request)
            .await.unwrap().is_none(), "tampered exact cash UUID cannot confirm");
        assert_eq!(count(&mut db, "cash").await, 1);
        assert_eq!(count(&mut db, "payments").await, 1);
        // A historical 033-only source with no 051 journal must never pass.
        let old = receipt_backed_pay("owned-patient", 2.0, "bank", "unsealed-033-request");
        db.execute(
            "INSERT INTO patient_transactions(id,patient_id,user_id,type,amount,payment_method,date)
             VALUES('legacy033','owned-patient','cashier-a','payment',2,'bank','2026-10-17');
             INSERT INTO patient_payment_scope(transaction_id,pharmacy_id,request_id)
             VALUES('legacy033','tenant-a','unsealed-033-request');",
        ).await.unwrap();
        assert!(confirm_patient_payment(&mut db, "cashier-a", old)
            .await.unwrap().is_none(), "scope-only bank mirror is not a journal witness");
    }

    #[tokio::test]
    async fn prospective_061_patient_043_credit_051_055_settlement_then_060_wallet_topup() {
        let mut db = receipt_backed_credit_sale_fixture().await;
        assert_eq!(post(&mut db, "cashier-a",
            receipt_backed_pay("owned-patient", 45.0, "cash", "061-credit-cash"))
            .await.unwrap().remaining_balance, 105.0);
        let request = wallet_request("owned-patient", 25.50, "061-wallet-after-credit");
        let receipt = wallet_top_up(&mut db, "cashier-a", request).await.unwrap();
        assert_eq!(receipt.id, "061-wallet-after-credit");
        assert_eq!(receipt.balance, 25.50);
        let confirm = confirm_wallet_top_up(
            &mut db, "cashier-a",
            wallet_request("owned-patient", 25.50, "061-wallet-after-credit"),
        ).await.unwrap().expect("original actor and nonce must confirm the 060 receipt");
        assert_eq!(confirm.actor_id, "cashier-a");
        assert_eq!(confirm.pharmacy_id, "tenant-a");
        assert_eq!(confirm.patient_id, "owned-patient");
        assert_eq!(confirm.amount_cents, 2550);
        assert_eq!(confirm.balance, 25.50);
        let witnesses: (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT
                (SELECT COUNT(*) FROM native_sale_cogs_provenance WHERE pharmacy_id='tenant-a'),
                (SELECT COUNT(*) FROM native_patient_financial_journal_receipts WHERE source_kind='payment'),
                (SELECT COUNT(*) FROM native_patient_wallet_topup_receipts WHERE pharmacy_id='tenant-a'),
                (SELECT COUNT(*) FROM cash_movements WHERE pharmacy_id='tenant-a' AND type='receipt')",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(witnesses, (1, 1, 1, 2));
        let wallet_lines: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT a.code,e.type,e.amount FROM native_patient_wallet_topup_receipts r
             JOIN journal_entries e ON e.journal_id=r.journal_id
             JOIN accounts a ON a.id=e.account_id
             WHERE r.request_id='061-wallet-after-credit' ORDER BY a.code",
        ).fetch_all(&mut db).await.unwrap();
        assert_eq!(wallet_lines, vec![
            ("1.1.1".into(), "debit".into(), 25.50),
            ("2.2".into(), "credit".into(), 25.50),
        ]);
        let exact_cash: (String, String, String, f64) = sqlx::query_as(
            "SELECT cm.shift_id,cm.pharmacy_id,cm.user_id,cm.amount
             FROM native_patient_wallet_topup_receipts r
             JOIN cash_movements cm ON cm.id=r.cash_movement_id
             WHERE r.request_id='061-wallet-after-credit'
               AND cm.source_type='patient_wallet' AND cm.category='patient_wallet'",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(exact_cash, ("tenant-a-shift".into(), "tenant-a".into(), "cashier-a".into(), 25.50));
        assert!(sqlx::query(
            "UPDATE cash_movements SET amount=55
             WHERE id=(SELECT cash_movement_id FROM native_patient_wallet_topup_receipts
                       WHERE request_id='061-wallet-after-credit')",
        ).execute(&mut db).await.is_err(), "sealed 060 cash must not change");
        assert!(wallet_top_up(&mut db, "cashier-a",
            wallet_request("owned-patient", 25.50, "061-wallet-after-credit"))
            .await.unwrap_err().contains("already processed"));
        assert!(confirm_wallet_top_up(&mut db, "cashier-a",
            wallet_request("owned-patient", 25.50, "new-ambiguous-nonce"))
            .await.unwrap().is_none(),
            "unknown nonce is not acknowledgement and must never mint a new payment");
        assert!(confirm_wallet_top_up(&mut db, "owner-a",
            wallet_request("owned-patient", 25.50, "061-wallet-after-credit"))
            .await.unwrap().is_none(), "different permitted actor is not the posting actor");
        assert!(confirm_wallet_top_up(&mut db, "owner-b",
            wallet_request("owned-patient", 25.50, "061-wallet-after-credit"))
            .await.unwrap().is_none(), "foreign tenant must not confirm wallet cash");
        assert!(confirm_wallet_top_up(&mut db, "cashier-a",
            wallet_request("owned-patient", 25.51, "061-wallet-after-credit"))
            .await.unwrap().is_none(), "amount mismatch must not accept the receipt");
        assert_eq!(count(&mut db, "cash").await, 2, "all confirmations are read-only");
        assert_eq!(count(&mut db, "journal").await, 4, "two 043 sales, one 051, one 060");
    }

    #[tokio::test]
    async fn prospective_wallet_zero_history_and_financial_denials_never_adopt_legacy() {
        let mut db = receipt_backed_credit_sale_fixture().await;
        let pristine = wallet_top_up(&mut db, "cashier-a",
            wallet_request("pristine-patient", 4.25, "061-wallet-pristine"))
            .await.unwrap();
        assert_eq!(pristine.balance, 4.25);
        assert_eq!(confirm_wallet_top_up(&mut db, "cashier-a",
            wallet_request("pristine-patient", 4.25, "061-wallet-pristine"))
            .await.unwrap().unwrap().balance, 4.25);
        for actor in ["readonly-a", "inactive-a", "owner-b"] {
            assert!(wallet_top_up(&mut db, actor,
                wallet_request("pristine-patient", 2.0, &format!("deny-wallet-{actor}")))
                .await.is_err(), "{actor} was able to add tenant-a funds");
            assert!(post(&mut db, actor,
                receipt_backed_pay("owned-patient", 2.0, "cash", &format!("deny-credit-{actor}")))
                .await.is_err(), "{actor} was able to collect tenant-a credit");
        }
        assert!(wallet_top_up(&mut db, "cashier-a",
            wallet_request("foreign-patient", 3.0, "cross-tenant-wallet"))
            .await.unwrap_err().contains("ownership"));
        assert!(wallet_top_up(&mut db, "cashier-a",
            wallet_request("historical-patient", 3.0, "unowned-wallet"))
            .await.unwrap_err().contains("ownership"));
        for (amount, nonce) in [(0.0, "zero"), (-1.0, "negative"), (2.001, "fractional")] {
            assert!(wallet_top_up(&mut db, "cashier-a",
                wallet_request("pristine-patient", amount, nonce)).await.is_err());
        }
        let sealed_before = count(&mut db, "cash").await;
        db.execute("CREATE TRIGGER force_060_receipt_failure
            BEFORE INSERT ON native_patient_wallet_topup_receipts
            BEGIN SELECT RAISE(ABORT,'isolated 060 failure'); END;")
            .await.unwrap();
        assert!(wallet_top_up(&mut db, "cashier-a",
            wallet_request("pristine-patient", 10.0, "061-wallet-rollback"))
            .await.unwrap_err().contains("isolated 060 failure"));
        assert_eq!(count(&mut db, "cash").await, sealed_before);
        let (balance, receipt_count): (f64, i64) = sqlx::query_as(
            "SELECT (SELECT wallet_balance FROM patients WHERE id='pristine-patient'),
                    (SELECT COUNT(*) FROM native_patient_wallet_topup_receipts)",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!((balance, receipt_count), (4.25, 1));
    }

    #[tokio::test]
    async fn credits_settle_only_proven_native_branch_and_preserve_balanced_ledger() {
        let mut db = setup().await;
        let first = post(&mut db, "pay-a", pay("p", 20.0, "cash", "nonce-one"))
            .await
            .unwrap();
        assert!((first.remaining_balance - 65.0).abs() < 0.000001);
        assert_eq!(count(&mut db, "shifts").await, 2);
        assert_eq!(count(&mut db, "cash").await, 1);
        assert_eq!(count(&mut db, "scope").await, 1);
        let pharmacy: String = sqlx::query_scalar("SELECT pharmacy_id FROM patient_payment_scope")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(pharmacy, "a");
        let second = post(&mut db, "pay-a", pay("p", 30.0, "bank", "nonce-two"))
            .await
            .unwrap();
        assert!((second.remaining_balance - 35.0).abs() < 0.000001);
        assert_eq!(count(&mut db, "cash").await, 1);
        assert_eq!(count(&mut db, "journal").await, 2);
        assert_eq!(count(&mut db, "entries").await, 4);
        let debit: Vec<i64> = sqlx::query_scalar(
            "SELECT account_id FROM journal_entries WHERE type='debit' ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(debit, vec![1, 2]);
        assert!(post(&mut db, "pay-a", pay("p", 20.0, "cash", "nonce-one"))
            .await
            .unwrap_err()
            .contains("already processed"));
        assert_eq!(count(&mut db, "payments").await, 2);
        let over = post(&mut db, "pay-a", pay("p", 36.0, "cash", "nonce-three")).await;
        assert!(over.unwrap_err().contains("exceeds provable"));
        assert_eq!(count(&mut db, "payments").await, 2);
    }

    #[tokio::test]
    async fn native_cash_receipt_losing_its_tenant_cannot_be_reused_as_local_default() {
        let mut db = setup().await;
        db.execute(r#"
            INSERT INTO users VALUES('cash-local','owner','{}',1,'local_default');
            INSERT INTO patients VALUES('local-p','Local patient',0);
            INSERT INTO sales_invoices VALUES('local-credit','local-p','local_default','credit','completed',100);
            INSERT INTO native_sale_cogs_provenance VALUES('local-credit','local_default','credit',100000000);
        "#).await.unwrap();
        let first = post(
            &mut db,
            "cash-local",
            pay("local-p", 20.0, "cash", "local-cash-original"),
        )
        .await
        .unwrap();
        assert!((first.remaining_balance - 80.0).abs() < 0.000001);
        assert!(sqlx::query("UPDATE cash_movements SET pharmacy_id=NULL WHERE source_type='patient_payment' AND target_name='local-p'")
            .execute(&mut db).await.is_err(),"055 must seal the original cash tenant");
        let valid = post(
            &mut db,
            "cash-local",
            pay("local-p", 40.0, "bank", "after-sealed-cash-tenant"),
        )
        .await
        .unwrap();
        assert!((valid.remaining_balance - 40.0).abs() < 0.000001);
    }

    #[tokio::test]
    async fn unowned_legacy_credit_and_return_cannot_be_collected_as_local_default() {
        let mut db = setup().await;
        db.execute(r#"
            INSERT INTO users VALUES('pay-local','cashier',
              '{"can_view_patients":true,"acc_can_process_cash_flow":true}',1,'local_default');
            INSERT INTO patients VALUES('unowned','Unowned',0),('explicit-local','Explicit',0),('return-owner','Return owner',0);
            INSERT INTO sales_invoices VALUES
              ('unowned-sale','unowned',NULL,'credit','completed',100),
              ('explicit-sale','explicit-local','local_default','credit','completed',100),
              ('return-sale','return-owner','local_default','credit','completed',100);
            INSERT INTO returns VALUES('unowned-return','return-sale',NULL,'patient_account','approved',15);
            INSERT INTO return_items VALUES(2,'unowned-return',15);
            INSERT INTO native_sale_cogs_provenance VALUES
              ('explicit-sale','local_default','credit',100000000),
              ('return-sale','local_default','credit',100000000);
        "#).await.unwrap();
        let orphan = post(
            &mut db,
            "pay-local",
            pay("unowned", 40.0, "cash", "unowned-invoice"),
        )
        .await;
        assert!(
            orphan
                .as_ref()
                .is_err_and(|e| e.contains("provenance is ambiguous")),
            "An invoice without a stored tenant became collectible: {orphan:?}"
        );
        let refund = post(
            &mut db,
            "pay-local",
            pay("return-owner", 40.0, "cash", "unowned-refund"),
        )
        .await;
        assert!(
            refund
                .as_ref()
                .is_err_and(|e| e.contains("provenance is ambiguous")),
            "An unscoped historic refund became a trusted local_default refund: {refund:?}"
        );
        for table in ["payments", "scope", "cash", "journal", "entries"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} must not change");
        }
        let valid = post(
            &mut db,
            "pay-local",
            pay("explicit-local", 40.0, "cash", "explicit-local"),
        )
        .await
        .unwrap();
        assert!((valid.remaining_balance - 60.0).abs() < 0.000001);
        assert_eq!(count(&mut db, "payments").await, 1);
    }

    #[tokio::test]
    async fn compatibility_normalized_legacy_credit_cannot_create_patient_cash_or_journal() {
        let mut db = setup().await;
        db.execute(r#"
            INSERT INTO users VALUES('local','owner','{}',1,'local_default');
            INSERT INTO patients VALUES('normalized-old','Uncertified original',0);
            INSERT INTO sales_invoices VALUES('legacy-origin','normalized-old',NULL,'credit','completed',100);
            -- Reproduce the actual state after schema compatibility assigns a
            -- missing historical pharmacy to a present-day local_default.
            UPDATE sales_invoices SET pharmacy_id='local_default'
              WHERE id='legacy-origin' AND pharmacy_id IS NULL;
        "#).await.unwrap();
        let attempt = post(
            &mut db,
            "local",
            pay("normalized-old", 40.0, "cash", "normalized-legacy-payment"),
        )
        .await;
        assert!(
            attempt
                .as_ref()
                .is_err_and(|e| e.contains("unverified credit source")),
            "A compatibility-inferred legacy credit became a collectible debt: {attempt:?}"
        );
        for table in ["payments", "scope", "cash", "journal", "entries"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} was written");
        }
    }

    #[tokio::test]
    async fn original_credit_and_return_receipt_contradictions_block_new_patient_money() {
        let mut db = setup().await;
        sqlx::query("UPDATE sales_invoices SET total_amount=120 WHERE id='a-sale'")
            .execute(&mut db)
            .await
            .unwrap();
        let wrong_credit = post(&mut db, "pay-a", pay("p", 10.0, "cash", "changed-credit")).await;
        assert!(wrong_credit
            .as_ref()
            .is_err_and(|e| e.contains("unverified credit source")));
        sqlx::query("UPDATE sales_invoices SET total_amount=100 WHERE id='a-sale'")
            .execute(&mut db)
            .await
            .unwrap();
        db.execute("DELETE FROM native_sale_return_cogs_provenance WHERE return_id='a-return'")
            .await
            .unwrap();
        let no_refund = post(
            &mut db,
            "pay-a",
            pay("p", 10.0, "cash", "lost-return-source"),
        )
        .await;
        assert!(no_refund
            .as_ref()
            .is_err_and(|e| e.contains("unverified patient refund source")));
        for t in ["payments", "scope", "cash", "journal", "entries", "shifts"] {
            assert_eq!(
                count(&mut db, t).await,
                if t == "shifts" { 1 } else { 0 },
                "{t} changed after rejected write"
            );
        }
        db.execute("INSERT INTO native_sale_return_cogs_provenance VALUES('a-return','a-sale','a','patient_account',15000000,'owner-a')")
            .await.unwrap();
        let valid = post(&mut db, "pay-a", pay("p", 10.0, "cash", "restored-witness"))
            .await
            .unwrap();
        assert!((valid.remaining_balance - 75.0).abs() < 0.000001);
    }

    #[tokio::test]
    async fn native_receipted_patient_account_refund_allows_collecting_remaining_credit_debt() {
        let mut db = setup().await;
        // This is the real native sale/return 043 source shape. The return
        // also has the corresponding patient-history refund, which the old
        // fixture omitted and which previously poisoned later collections.
        db.execute(
            "INSERT INTO patient_transactions(id,patient_id,user_id,type,amount,payment_method,notes,date)
             VALUES('a-return','p','owner-a','refund',15,'patient_account','native-return','2026-10-11')",
        ).await.unwrap();
        let receipt = post(
            &mut db, "pay-a", pay("p", 25.0, "bank", "native-return-then-payment"),
        ).await.expect("A 043-receipted refund must not block collecting the remaining credit");
        assert!((receipt.remaining_balance - 60.0).abs() < 0.000001);
        assert_eq!(count(&mut db, "payments").await, 2); // refund mirror plus payment
        assert_eq!(count(&mut db, "scope").await, 1);
        assert_eq!(count(&mut db, "journal").await, 1);
    }

    #[tokio::test]
    async fn unlinked_or_mutated_refund_history_never_authorizes_patient_money() {
        for (id, amount, method, actor) in [
            ("orphan-refund", 15.0, "patient_account", "owner-a"),
            ("a-return", 15.01, "patient_account", "owner-a"),
            ("a-return", 15.0, "cash", "owner-a"),
            ("a-return", 15.0, "patient_account", "forged-actor"),
        ] {
            let mut db = setup().await;
            sqlx::query(
                "INSERT INTO patient_transactions(id,patient_id,user_id,type,amount,payment_method,notes,date)
                 VALUES(?,'p',?,'refund',?,?,'untrusted','2026-10-11')",
            ).bind(id).bind(actor).bind(amount).bind(method).execute(&mut db).await.unwrap();
            let blocked = post(
                &mut db, "pay-a", pay("p", 25.0, "bank", "reject-untrusted-refund"),
            ).await;
            assert!(
                blocked.as_ref().is_err_and(|e| e.contains("provenance is ambiguous")),
                "Unlinked or altered refund mirror {id} {amount} {method} {actor} was accepted: {blocked:?}",
            );
            assert_eq!(count(&mut db, "scope").await, 0);
            assert_eq!(count(&mut db, "journal").await, 0);
        }
    }

    #[tokio::test]
    async fn fractional_microunit_credit_does_not_allow_overcollection_by_half_cent_tolerance() {
        let mut db = setup().await;
        // A real 043 micro-unit source is not necessarily representable in
        // cents. Credit 99.996 less an approved 15.000 refund is 84.996.
        // Collecting 85.00 invents 0.004 of receivable/cash beyond the source.
        db.execute("UPDATE sales_invoices SET total_amount=99.996 WHERE id='a-sale'")
            .await
            .unwrap();
        db.execute(
            "UPDATE native_sale_cogs_provenance SET sale_micros=99996000 WHERE sale_id='a-sale'",
        )
        .await
        .unwrap();
        let too_much = post(&mut db, "pay-a", pay("p", 85.0, "cash", "subcent-overpaid")).await;
        assert!(
            too_much
                .as_ref()
                .is_err_and(|e| e.contains("exceeds provable")),
            "A cent-exact collection exceeded the source by 0.004: {too_much:?}"
        );
        for table in ["payments", "scope", "cash", "journal", "entries"] {
            assert_eq!(
                count(&mut db, table).await,
                0,
                "{table} changed on rejection"
            );
        }
        let valid = post(
            &mut db,
            "pay-a",
            pay("p", 84.99, "bank", "fractionally-bounded"),
        )
        .await
        .unwrap();
        assert!((valid.remaining_balance - 0.006).abs() < 0.0000001);
    }

    #[tokio::test]
    async fn unlinked_legacy_bank_mirror_cannot_monetize_unverifiable_receivable_again() {
        let mut db = setup().await;
        // V1 holds a bank payment but no journal ID. An unrelated balanced
        // 20 journal and a mutated +1 payment mirror cannot be joined by date,
        // actor, description or UUID without inventing the original linkage.
        db.execute(r#"
           INSERT INTO patient_transactions VALUES('old-bank','p','pay-a','payment',1,'bank','V1','2026-10-11');
           INSERT INTO patient_payment_scope(transaction_id,pharmacy_id,request_id)
             VALUES('old-bank','a','old-bank-request');
           INSERT INTO daily_journals VALUES('old-journal','2026-10-11','old bank receipt','pay-a',20,'a');
           INSERT INTO journal_entries(journal_id,account_id,type,amount)
             VALUES('old-journal',2,'debit',20),('old-journal',3,'credit',20);
        "#).await.unwrap();
        let before = (
            count(&mut db, "payments").await,
            count(&mut db, "scope").await,
            count(&mut db, "cash").await,
            count(&mut db, "journal").await,
            count(&mut db, "entries").await,
        );
        let tried = post(
            &mut db,
            "pay-a",
            pay("p", 80.0, "bank", "after-unlinked-bank"),
        )
        .await;
        assert!(
            tried
                .as_ref()
                .is_err_and(|e| e.contains("unverified legacy bank")),
            "Unlinked V1 bank cash with mutable +1 mirror made 80 collectible: {tried:?}"
        );
        assert_eq!(
            before,
            (
                count(&mut db, "payments").await,
                count(&mut db, "scope").await,
                count(&mut db, "cash").await,
                count(&mut db, "journal").await,
                count(&mut db, "entries").await
            )
        );
    }

    #[tokio::test]
    async fn migration_055_preserves_historic_cash_null_without_inferred_linkage() {
        let mut db = setup_through_051().await;
        db.execute(r#"
          INSERT INTO shifts VALUES('historic-shift','pay-a','a','open','2026-10-11',0,NULL);
          INSERT INTO patient_transactions VALUES
            ('old-cash','p','pay-a','payment',20,'cash','historic','2026-10-11');
          INSERT INTO patient_payment_scope(transaction_id,pharmacy_id,request_id)
            VALUES('old-cash','a','old-cash-request');
          INSERT INTO cash_movements(id,user_id,shift_id,type,category,amount,source_type,target_name,date,pharmacy_id)
            VALUES('old-unknown-cash','pay-a','historic-shift','receipt','accounts_receivable',20,
                   'patient_payment','p','2026-10-11','a');
          INSERT INTO daily_journals VALUES('old-cash-journal','2026-10-11','Historic','pay-a',20,'a');
          INSERT INTO journal_entries(journal_id,account_id,type,amount)
            VALUES('old-cash-journal',1,'debit',20),('old-cash-journal',3,'credit',20);
          INSERT INTO native_patient_financial_journal_receipts
            (source_kind,source_id,pharmacy_id,actor_id,journal_id,amount_cents,money_kind)
            VALUES('payment','old-cash','a','pay-a','old-cash-journal',2000,'cash');
        "#).await.unwrap();
        db.execute(include_str!("../../migrations/055_patient_cash_movement_witness.sql"))
            .await.unwrap();
        let old_link: Option<String> = sqlx::query_scalar(
            "SELECT cash_movement_id FROM native_patient_financial_journal_receipts WHERE source_id='old-cash'",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(old_link, None,"no historic cash UUID may be inferred or backfilled");
        let audit = sqlx::query(
            super::super::financial_source_reconciliation_native::NATIVE_PATIENT_FINANCIAL_JOURNAL_STRUCTURE,
        ).fetch_all(&mut db).await.unwrap();
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].try_get::<String,_>("issue_code").unwrap(),
            "native_patient_cash_witness_unverifiable");
        assert_eq!(audit[0].try_get::<String,_>("classification").unwrap(),
            "unverifiable_history");
        let blocked = post(&mut db, "pay-a", pay("p", 10.0, "bank", "after-old-null-cash")).await;
        assert!(blocked.as_ref().is_err_and(|e| e.contains("unverifiable historical cash UUID")),
            "an old NULL cash receipt became automated payment evidence: {blocked:?}");
    }

    #[tokio::test]
    async fn prospective_055_rejects_forged_cash_attributes_and_duplicate_uuid() {
        let mut db = setup().await;
        db.execute(r#"
          INSERT INTO shifts VALUES('a-shift','pay-a','a','open','2026-10-11',0,NULL);
          INSERT INTO patient_transactions VALUES
            ('synthetic-cash','p','pay-a','payment',20,'cash','new','2026-10-11');
          INSERT INTO patient_payment_scope(transaction_id,pharmacy_id,request_id)
            VALUES('synthetic-cash','a','synthetic-cash-request');
          INSERT INTO daily_journals VALUES('synthetic-journal','2026-10-11','New','pay-a',20,'a');
          INSERT INTO journal_entries(journal_id,account_id,type,amount)
            VALUES('synthetic-journal',1,'debit',20),('synthetic-journal',3,'credit',20);
          INSERT INTO cash_movements(id,user_id,shift_id,type,category,amount,source_type,target_name,date,pharmacy_id)
            VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','pay-a','a-shift','receipt','accounts_receivable',20,
                   'patient_payment','p','2026-10-11','a');
        "#).await.unwrap();
        let witness_sql = "INSERT INTO native_patient_financial_journal_receipts
            (source_kind,source_id,pharmacy_id,actor_id,journal_id,amount_cents,money_kind,cash_movement_id)
            VALUES('payment','synthetic-cash','a','pay-a','synthetic-journal',2000,'cash',?)";
        assert!(sqlx::query(witness_sql).bind(Option::<String>::None)
            .execute(&mut db).await.is_err());
        let cash_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        for (column,invalid,valid) in [
            ("source_type","expense","patient_payment"),
            ("target_name","mixed","p"),
            ("pharmacy_id","b","a"),
            ("user_id","owner-b","pay-a"),
            ("date","2026-10-12","2026-10-11"),
            ("shift_id","b-shift","a-shift"),
            ("type","disbursement","receipt"),
            ("category","other","accounts_receivable"),
        ] {
            let update=format!("UPDATE cash_movements SET {column}=? WHERE id=?");
            sqlx::query(&update).bind(invalid).bind(cash_id)
                .execute(&mut db).await.unwrap();
            assert!(sqlx::query(witness_sql).bind(cash_id)
                .execute(&mut db).await.is_err(),"055 accepted wrong {column}");
            sqlx::query(&update).bind(valid).bind(cash_id)
                .execute(&mut db).await.unwrap();
        }
        db.execute("UPDATE cash_movements SET amount=20.01 WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'")
            .await.unwrap();
        assert!(sqlx::query(witness_sql).bind(cash_id)
            .execute(&mut db).await.is_err(),"055 accepted wrong cents");
        db.execute("UPDATE cash_movements SET amount=20 WHERE id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'")
            .await.unwrap();
        sqlx::query(witness_sql).bind(cash_id).execute(&mut db).await.unwrap();

        // Another original source/journal with identical amount and actor
        // cannot share the first transaction's exact cash movement UUID.
        db.execute(r#"
          INSERT INTO patient_transactions VALUES
            ('second-cash','p','pay-a','payment',20,'cash','new','2026-10-11');
          INSERT INTO patient_payment_scope(transaction_id,pharmacy_id,request_id)
            VALUES('second-cash','a','second-cash-request');
          INSERT INTO daily_journals VALUES('second-journal','2026-10-11','New','pay-a',20,'a');
          INSERT INTO journal_entries(journal_id,account_id,type,amount)
            VALUES('second-journal',1,'debit',20),('second-journal',3,'credit',20);
        "#).await.unwrap();
        let reuse = sqlx::query(
            "INSERT INTO native_patient_financial_journal_receipts
              (source_kind,source_id,pharmacy_id,actor_id,journal_id,amount_cents,money_kind,cash_movement_id)
              VALUES('payment','second-cash','a','pay-a','second-journal',2000,'cash',?)",
        ).bind(cash_id).execute(&mut db).await;
        assert!(reuse.is_err(),"one cash UUID cannot certify two payments");
        assert!(db.execute("UPDATE shifts SET pharmacy_id='b' WHERE id='a-shift'")
            .await.is_err(),"receipted shift ownership must be sealed");
    }

    #[tokio::test]
    async fn prospective_patient_cash_has_exact_unique_sealed_movement_uuid() {
        let mut db = setup().await;
        let first = post(&mut db, "pay-a", pay("p", 20.0, "cash", "cash-link-one"))
            .await.unwrap();
        let second = post(&mut db, "pay-a", pay("p", 20.0, "cash", "cash-link-two"))
            .await.unwrap();
        let links: Vec<(String, String)> = sqlx::query_as(
            "SELECT r.source_id,r.cash_movement_id
             FROM native_patient_financial_journal_receipts r
             WHERE r.source_kind='payment' AND r.money_kind='cash'
             ORDER BY r.source_id",
        ).fetch_all(&mut db).await.unwrap();
        assert_eq!(links.len(), 2);
        assert_ne!(links[0].1, links[1].1);
        for (source, cash) in links {
            assert!(source == first.id || source == second.id);
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM cash_movements WHERE id=? AND source_type='patient_payment'
                   AND target_name='p' AND pharmacy_id='a' AND user_id='pay-a'
                   AND amount=20 AND date='2026-10-11'")
                .bind(&cash).fetch_one(&mut db).await.unwrap();
            assert_eq!(count, 1);
            assert!(sqlx::query("UPDATE cash_movements SET shift_id='b-shift' WHERE id=?")
                .bind(&cash).execute(&mut db).await.is_err(),
                "a receipted cash drawer must be immutable");
            assert!(sqlx::query("DELETE FROM cash_movements WHERE id=?")
                .bind(&cash).execute(&mut db).await.is_err(),
                "a receipted cash movement must be immutable");
        }
        assert!(post(&mut db, "pay-a", pay("p", 5.0, "bank", "bank-after-cash-link"))
            .await.is_ok());
    }

    #[tokio::test]
    async fn prospective_051_patient_bank_journal_is_exact_single_use_and_immutable() {
        let mut db = setup().await;
        let posted = post(&mut db, "pay-a", pay("p", 20.0, "bank", "bank-source-051"))
            .await
            .unwrap();
        let source_findings = sqlx::query(
            super::super::financial_source_reconciliation_native::NATIVE_PATIENT_FINANCIAL_JOURNAL_STRUCTURE,
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert!(source_findings.is_empty(), "real native 051 bank settlement must reconcile to its journal");
        let journal:String=sqlx::query_scalar("SELECT journal_id FROM native_patient_financial_journal_receipts WHERE source_kind='payment' AND source_id=?")
            .bind(&posted.id).fetch_one(&mut db).await.unwrap();
        let cents: i64 = sqlx::query_scalar(
            "SELECT amount_cents FROM native_patient_financial_journal_receipts WHERE journal_id=?",
        )
        .bind(&journal)
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(cents, 2000);
        for sql in [
            format!("UPDATE patient_transactions SET amount=1 WHERE id='{}'",posted.id),
            format!("UPDATE patient_payment_scope SET pharmacy_id='b' WHERE transaction_id='{}'",posted.id),
            format!("UPDATE daily_journals SET total_amount=1 WHERE id='{journal}'"),
            format!("UPDATE journal_entries SET amount=1 WHERE journal_id='{journal}'"),
            format!("DELETE FROM journal_entries WHERE journal_id='{journal}'"),
            format!("INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES('{journal}',1,'debit',20)"),
            format!("DELETE FROM native_patient_financial_journal_receipts WHERE source_id='{}'",posted.id),
        ] {
            assert!(sqlx::query(&sql).execute(&mut db).await.is_err(),"051 failed closed: {sql}");
        }
        let replay = post(&mut db, "pay-a", pay("p", 20.0, "bank", "bank-source-051")).await;
        assert!(replay.is_err());
        assert_eq!(count(&mut db, "payments").await, 1);
        assert_eq!(count(&mut db, "journal").await, 1);
        assert_eq!(count(&mut db, "entries").await, 2);
        let valid = post(&mut db, "pay-a", pay("p", 60.0, "bank", "bank-second-051"))
            .await
            .unwrap();
        assert!((valid.remaining_balance - 5.0).abs() < 0.000001);
    }

    #[tokio::test]
    async fn altered_prior_scoped_payment_cannot_create_new_receivables() {
        let mut db = setup().await;
        let first = post(&mut db, "pay-a", pay("p", 20.0, "cash", "prior-native"))
            .await
            .unwrap();
        assert!((first.remaining_balance - 65.0).abs() < 0.000001);
        // New 051 original-source receipt disallows even a collusive attempt
        // to reopen debt by changing the payment without its sealed journal.
        let tamper = sqlx::query("UPDATE patient_transactions SET amount=-900 WHERE id=?")
            .bind(&first.id)
            .execute(&mut db)
            .await;
        assert!(tamper.is_err());
        let forged = post(&mut db, "pay-a", pay("p", 80.0, "cash", "forged-prior")).await;
        assert!(
            forged.is_err(),
            "A negative prior native payment invented further receivables: {forged:?}"
        );
        assert_eq!(count(&mut db, "payments").await, 1);
        assert_eq!(count(&mut db, "scope").await, 1);
        assert_eq!(count(&mut db, "cash").await, 1);
        assert_eq!(count(&mut db, "journal").await, 1);
        let valid = post(&mut db, "pay-a", pay("p", 60.0, "bank", "valid-prior"))
            .await
            .unwrap();
        assert!((valid.remaining_balance - 5.0).abs() < 0.000001);
    }

    #[tokio::test]
    async fn understated_positive_prior_cash_payment_cannot_reopen_debt() {
        let mut db = setup().await;
        let first = post(&mut db, "pay-a", pay("p", 20.0, "cash", "native-cash"))
            .await
            .unwrap();
        // A positive and cent-exact 1 still contradicts the original 20 cash
        // receipt and journal; sign/cent checks alone cannot detect this.
        let tamper = sqlx::query("UPDATE patient_transactions SET amount=1 WHERE id=?")
            .bind(&first.id)
            .execute(&mut db)
            .await;
        assert!(
            tamper.is_err(),
            "Forward native patient payment source must be immutable"
        );
        let forged = post(&mut db, "pay-a", pay("p", 80.0, "bank", "reopened-debt")).await;
        assert!(
            forged.is_err(),
            "Understated native cash payment admitted additional debt collection: {forged:?}"
        );
        assert_eq!(count(&mut db, "payments").await, 1);
        assert_eq!(count(&mut db, "journal").await, 1);
        assert_eq!(count(&mut db, "cash").await, 1);
        let valid = post(&mut db, "pay-a", pay("p", 60.0, "bank", "valid-debt"))
            .await
            .unwrap();
        assert!((valid.remaining_balance - 5.0).abs() < 0.000001);
    }

    #[tokio::test]
    async fn receipted_cash_movements_cannot_be_changed_to_offset_daily_totals() {
        let mut db = setup().await;
        post(&mut db, "pay-a", pay("p", 20.0, "cash", "cash-20"))
            .await.unwrap();
        post(&mut db, "pay-a", pay("p", 30.0, "cash", "cash-30"))
            .await.unwrap();
        let first_id: String = sqlx::query_scalar(
            "SELECT id FROM cash_movements WHERE target_name='p' AND amount=20",
        ).fetch_one(&mut db).await.unwrap();
        assert!(db.execute("UPDATE cash_movements SET amount=25 WHERE target_name='p'")
            .await.is_err(),"055 must reject cash edits before net totals can hide them");
        assert_eq!(count(&mut db, "scope").await, 2);
        assert_eq!(count(&mut db, "journal").await, 2);
        assert!(sqlx::query("UPDATE cash_movements SET amount=30 WHERE id=?")
            .bind(&first_id).execute(&mut db).await.is_err());
        let valid = post(&mut db, "pay-a", pay("p", 10.0, "bank", "after-cash-seal"))
            .await.unwrap();
        assert!((valid.remaining_balance - 25.0).abs() < 0.000001);
    }

    #[tokio::test]
    async fn foreign_shift_redirect_on_native_patient_cash_blocks_further_collection() {
        let mut db = setup().await;
        post(&mut db, "pay-a", pay("p", 20.0, "cash", "cash-shift-owner"))
            .await.unwrap();
        let local_shift: String = sqlx::query_scalar(
            "SELECT shift_id FROM cash_movements WHERE target_name='p'",
        ).fetch_one(&mut db).await.unwrap();
        assert_ne!(local_shift, "b-shift");
        assert!(db.execute("UPDATE cash_movements SET shift_id='b-shift' WHERE target_name='p'")
            .await.is_err(),"055 must prevent a foreign drawer reassignment");
        assert_eq!(count(&mut db, "scope").await, 1);
        let valid = post(&mut db, "pay-a", pay("p", 10.0, "bank", "cash-sealed-shift"))
            .await.unwrap();
        assert!((valid.remaining_balance - 55.0).abs() < 0.000001);
    }

    #[tokio::test]
    async fn patient_settlement_rejects_historical_refund_header_understating_lines() {
        let mut db = setup().await;
        // The past approved patient-account return has 80 refunded in its
        // actual line, but a changed header claims only 15. It must not
        // authorize collecting 80 against the remaining 20 of the sale.
        sqlx::query("UPDATE return_items SET total_price=80 WHERE return_id='a-return'")
            .execute(&mut db)
            .await
            .unwrap();
        let forged = post(&mut db, "pay-a", pay("p", 80.0, "cash", "bad-refund")).await;
        assert!(
            forged
                .as_ref()
                .is_err_and(|e| e.contains("historical refund amounts")),
            "Historical patient refund header/line contradiction was trusted: {forged:?}"
        );
        for table in ["payments", "scope", "cash", "journal", "entries"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} must not change");
        }
        sqlx::query("UPDATE return_items SET total_price=15 WHERE return_id='a-return'")
            .execute(&mut db)
            .await
            .unwrap();
        let valid = post(&mut db, "pay-a", pay("p", 80.0, "cash", "valid-refund"))
            .await
            .unwrap();
        assert!((valid.remaining_balance - 5.0).abs() < 0.000001);
    }

    #[tokio::test]
    async fn patient_settlement_rejects_redirected_accounts_and_fractional_cents() {
        let mut db = setup().await;
        // A configured category must not turn an accounts-receivable credit
        // into a bank clearing credit, even though that journal balances.
        sqlx::query(
            "UPDATE trial_balance_settings SET account_id=2 WHERE category='accounts_receivable'",
        )
        .execute(&mut db)
        .await
        .unwrap();
        let forged_mapping = post(
            &mut db,
            "pay-a",
            pay("p", 10.0, "cash", "redirected-receivable"),
        )
        .await;
        assert!(
            forged_mapping.is_err(),
            "Untrusted receivable mapping must reject payment"
        );
        for table in ["payments", "scope", "cash", "journal", "entries"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} must not change");
        }
        sqlx::query(
            "UPDATE trial_balance_settings SET account_id=3 WHERE category='accounts_receivable'",
        )
        .execute(&mut db)
        .await
        .unwrap();
        // No fractional-cent payment can be posted to cash/receivable even
        // when it is below the account's genuine outstanding balance.
        let subcent = post(&mut db, "pay-a", pay("p", 10.001, "cash", "subcent")).await;
        assert!(
            subcent.is_err(),
            "Patient cash payment must use exact cents"
        );
        assert_eq!(count(&mut db, "payments").await, 0);
        let valid = post(&mut db, "pay-a", pay("p", 10.0, "cash", "valid-cent"))
            .await
            .unwrap();
        assert!((valid.remaining_balance - 75.0).abs() < 0.000001);
        assert_eq!(count(&mut db, "payments").await, 1);
    }

    #[tokio::test]
    async fn native_scoped_financial_notice_adjusts_proven_debt_without_accepting_legacy_rows() {
        let mut db = setup().await;
        db.execute(
            "INSERT INTO financial_notices
            (id,target_type,target_id,type,user_id,amount,date,pharmacy_id)
            VALUES('notice-native','customer','p','debit','owner-a',10,'2026-10-11','a')",
        )
        .await
        .unwrap();
        db.execute(
            "INSERT INTO patient_transactions VALUES(
            'adjust-native','p','owner-a','adjustment',10,'cash','Corrected','2026-10-11')",
        )
        .await
        .unwrap();
        db.execute(
            "INSERT INTO financial_notice_native_scope
            (notice_id,pharmacy_id,request_id,patient_transaction_id)
            VALUES('notice-native','a','native-notice-request','adjust-native')",
        )
        .await
        .unwrap();
        // A legitimate post-051 adjustment must have its own exact journal
        // witness. Earlier V1 scope+mirror alone cannot certify this source.
        db.execute(
            r#"
           INSERT INTO accounts(id,code,is_group) VALUES(4,'4.2',0);
           INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
             VALUES('notice-journal','2026-10-11','Native patient notice','owner-a',10,'a');
           INSERT INTO journal_entries(journal_id,account_id,type,amount)
             VALUES('notice-journal',3,'debit',10),('notice-journal',4,'credit',10);
           INSERT INTO native_patient_financial_journal_receipts
             (source_kind,source_id,pharmacy_id,actor_id,journal_id,amount_cents,money_kind)
             VALUES('notice','notice-native','a','owner-a','notice-journal',1000,'debit');
        "#,
        )
        .await
        .unwrap();
        // Invoice 100 - current-branch return 15 + signed adjustment 10 = 95.
        let posted = post(
            &mut db,
            "pay-a",
            pay("p", 20.0, "bank", "native-after-notice"),
        )
        .await
        .unwrap();
        assert!((posted.remaining_balance - 75.0).abs() < 0.000001);
        assert_eq!(count(&mut db, "journal").await, 2);
        assert_eq!(count(&mut db, "entries").await, 4);
        assert_eq!(count(&mut db, "scope").await, 1);
        // A scoped financial notice is not enough: its currently persisted
        // patient adjustment must still agree with the original notice source.
        sqlx::query("UPDATE patient_transactions SET amount=900 WHERE id='adjust-native'")
            .execute(&mut db)
            .await
            .unwrap();
        let forged_mirror = post(
            &mut db,
            "pay-a",
            pay("p", 10.0, "bank", "forged-notice-mirror"),
        )
        .await;
        assert!(
            forged_mirror
                .as_ref()
                .is_err_and(|e| e.contains("native notice mirror")),
            "Forged scoped native-notice adjustment was trusted: {forged_mirror:?}"
        );
        assert_eq!(count(&mut db, "payments").await, 2);
        assert_eq!(count(&mut db, "journal").await, 2);
        sqlx::query("UPDATE patient_transactions SET amount=10 WHERE id='adjust-native'")
            .execute(&mut db)
            .await
            .unwrap();
        assert!(
            db.execute(
                "UPDATE financial_notice_native_scope SET pharmacy_id='b'
             WHERE notice_id='notice-native'"
            )
            .await
            .is_err(),
            "051 scope custody must be immutable"
        );
        assert_eq!(count(&mut db, "scope").await, 1);
    }
    #[tokio::test]
    async fn v1_unlinked_customer_notice_cannot_invent_new_patient_receivable() {
        let mut db = setup().await;
        db.execute(r#"
          INSERT INTO financial_notices(id,target_type,target_id,type,user_id,amount,date,pharmacy_id)
            VALUES('old-notice','customer','p','debit','owner-a',60,'2026-10-11','a');
          INSERT INTO patient_transactions VALUES('old-adjust','p','owner-a','adjustment',60,'cash','old','2026-10-11');
          INSERT INTO financial_notice_native_scope(notice_id,pharmacy_id,request_id,patient_transaction_id)
            VALUES('old-notice','a','old-nonce','old-adjust');
        "#).await.unwrap();
        let attempt = post(
            &mut db,
            "pay-a",
            pay("p", 80.0, "bank", "after-unknown-notice"),
        )
        .await;
        assert!(
            attempt
                .as_ref()
                .is_err_and(|e| e.contains("unverified legacy notice")),
            "V1 notice without a journal link invented collectible patient balance: {attempt:?}"
        );
        for table in ["payments", "scope", "cash", "journal", "entries"] {
            assert_eq!(
                count(&mut db, table).await,
                if table == "payments" { 1 } else { 0 },
                "{table} posted on unknown journal"
            );
        }
    }

    #[tokio::test]
    async fn denies_cross_pharmacy_legacy_opening_and_untagged_transaction_without_writes() {
        let mut db = setup().await;
        for patient in ["mixed", "historical", "unlinked"] {
            assert!(
                post(&mut db, "owner-a", pay(patient, 1.0, "cash", patient))
                    .await
                    .is_err(),
                "{patient}"
            );
        }
        assert!(
            post(&mut db, "owner-b", pay("p", 1.0, "cash", "other-branch"))
                .await
                .is_err()
        );
        sqlx::query("INSERT INTO patient_transactions VALUES('legacy','p','owner-a','payment',10,'cash',NULL,'2020-01-01')")
            .execute(&mut db).await.unwrap();
        let denied = post(&mut db, "owner-a", pay("p", 10.0, "bank", "legacy-block"))
            .await
            .unwrap_err();
        assert!(denied.contains("ambiguous"));
        assert_eq!(count(&mut db, "payments").await, 1);
        assert_eq!(count(&mut db, "journal").await, 0);
        assert_eq!(count(&mut db, "cash").await, 0);
    }

    #[tokio::test]
    async fn role_deactivation_reassignment_and_historical_notices_fail_closed() {
        let mut db = setup().await;
        for actor in ["denied", "inactive", "absent"] {
            assert!(post(&mut db, actor, pay("p", 10.0, "bank", actor))
                .await
                .is_err());
        }
        sqlx::query("UPDATE users SET pharmacy_id='b' WHERE id='pay-a'")
            .execute(&mut db)
            .await
            .unwrap();
        assert!(post(&mut db, "pay-a", pay("p", 10.0, "bank", "moved"))
            .await
            .is_err());
        sqlx::query("UPDATE users SET pharmacy_id='a' WHERE id='pay-a'")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO financial_notices(id,target_type,target_id,type)
             VALUES('notice','customer','p','debit')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        assert!(post(&mut db, "pay-a", pay("p", 10.0, "bank", "notice"))
            .await
            .is_err());
        assert_eq!(count(&mut db, "payments").await, 0);
    }

    #[tokio::test]
    async fn rejected_payload_and_failed_ledger_trigger_roll_back_all_posting_rows() {
        let mut db = setup().await;
        for amount in [f64::NAN, f64::INFINITY, -1.0, 0.0, 86.0] {
            assert!(post(&mut db, "owner-a", pay("p", amount, "cash", "bad"))
                .await
                .is_err());
        }
        let bad = serde_json::json!({"patientId":"p","amount":10.0,"paymentMethod":"cash",
            "date":"2026-10-11","requestId":"nonce","pharmacyId":"b"});
        assert!(serde_json::from_value::<PatientPaymentInput>(bad).is_err());
        db.execute("CREATE TRIGGER reject_credit BEFORE INSERT ON journal_entries WHEN NEW.type='credit' BEGIN SELECT RAISE(ABORT,'synthetic journal failure'); END;")
            .await.unwrap();
        assert!(post(&mut db, "owner-a", pay("p", 10.0, "cash", "rollback"))
            .await
            .is_err());
        for t in ["payments", "scope", "cash", "journal", "entries"] {
            assert_eq!(count(&mut db, t).await, 0, "{t} must rollback");
        }
        assert_eq!(count(&mut db, "shifts").await, 1);
    }

    #[tokio::test]
    async fn native_wallet_topup_is_tenant_scoped_atomic_and_seals_both_ledger_entries() {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
          CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,is_active INTEGER,pharmacy_id TEXT);
          INSERT INTO users VALUES('owner','owner','{}',1,'tenant-a');
          CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT,wallet_balance REAL DEFAULT 0);
          INSERT INTO patients VALUES('qa-patient','QA Patient',0),('unowned','Unowned',0);
          CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,patient_id TEXT,pharmacy_id TEXT,payment_method TEXT,status TEXT,total_amount REAL);
          INSERT INTO sales_invoices VALUES('qa-sale','qa-patient','tenant-a','cash','completed',20);
          CREATE TABLE native_sale_cogs_provenance(sale_id TEXT PRIMARY KEY,pharmacy_id TEXT,sale_micros INTEGER);
          INSERT INTO native_sale_cogs_provenance VALUES('qa-sale','tenant-a',20000000);
          CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,pharmacy_id TEXT,refund_method TEXT,status TEXT,total_refund REAL);
          CREATE TABLE native_sale_return_cogs_provenance(return_id TEXT PRIMARY KEY,sale_id TEXT,pharmacy_id TEXT,refund_method TEXT,refund_micros INTEGER,actor_id TEXT);
          CREATE TABLE patient_transactions(id TEXT,patient_id TEXT,type TEXT,payment_method TEXT,amount REAL,user_id TEXT);
          CREATE TABLE patient_payment_scope(transaction_id TEXT,pharmacy_id TEXT);
          CREATE TABLE financial_notice_native_scope(patient_transaction_id TEXT,pharmacy_id TEXT,notice_id TEXT);
          CREATE TABLE financial_notices(id TEXT PRIMARY KEY,target_type TEXT,target_id TEXT,type TEXT,amount REAL);
          CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER DEFAULT 0);
          INSERT INTO accounts VALUES(6,'1.1.1',0),(7,'2.2',0);
          CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
          INSERT INTO trial_balance_settings VALUES('cash_drawer',6),('patient_wallet_liability',7);
          CREATE TABLE shifts(id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,status TEXT,start_time TEXT,starting_cash REAL,notes TEXT);
          INSERT INTO shifts VALUES('qa-shift','owner','tenant-a','open','2026-10-16 10:00:00',0,'qa');
          CREATE TABLE cash_movements(id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,type TEXT,category TEXT,amount REAL,source_type TEXT,target_name TEXT,notes TEXT,date TEXT,pharmacy_id TEXT);
          CREATE TABLE daily_journals(id TEXT PRIMARY KEY,date TEXT,description TEXT,created_by TEXT,total_amount REAL,pharmacy_id TEXT);
          CREATE TABLE journal_entries(id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
          CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
        "#).execute(&mut db).await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/060_native_patient_wallet_topups.sql"))
            .execute(&mut db).await.unwrap();
        let request = |id: &str, patient: &str| PatientWalletTopUpInput {
            patient_id: patient.into(), amount: 25.0, notes: Some("fictional QA".into()),
            request_id: id.into(),
        };
        let posted = wallet_top_up(&mut db, "owner", request("qa-once", "qa-patient"))
            .await.unwrap();
        assert_eq!(posted.id, "qa-once");
        assert_eq!(posted.balance, 25.0);
        // An extra finalized wallet debit or refund without a 043 receipt is
        // not zero-valued history. Its absence from the receipt-only SUM must
        // not make a future wallet top-up or IPC confirmation appear safe.
        db.execute("INSERT INTO sales_invoices VALUES('unreceipted-wallet-sale','qa-patient','tenant-a','wallet','completed',5)")
            .await.unwrap();
        let unreceipted_sale = wallet_top_up(&mut db, "owner", request("qa-hidden-sale", "qa-patient")).await;
        assert!(unreceipted_sale.as_ref().is_err_and(|e| e.contains("unverified wallet")),
            "Completed wallet debit without its receipt was ignored: {unreceipted_sale:?}");
        assert!(confirm_wallet_top_up(&mut db, "owner", request("qa-once", "qa-patient"))
            .await.is_err(), "Confirmed a wallet against an unreceipted debit");
        db.execute("DELETE FROM sales_invoices WHERE id='unreceipted-wallet-sale'").await.unwrap();
        db.execute("INSERT INTO returns VALUES('unreceipted-wallet-refund','qa-sale','tenant-a','wallet','approved',5)")
            .await.unwrap();
        let unreceipted_return = wallet_top_up(&mut db, "owner", request("qa-hidden-return", "qa-patient")).await;
        assert!(unreceipted_return.as_ref().is_err_and(|e| e.contains("unverified wallet")),
            "Approved wallet refund without its receipt was ignored: {unreceipted_return:?}");
        assert!(confirm_wallet_top_up(&mut db, "owner", request("qa-once", "qa-patient"))
            .await.is_err(), "Confirmed a wallet against an unreceipted refund");
        db.execute("DELETE FROM returns WHERE id='unreceipted-wallet-refund'").await.unwrap();
        // A return receipt alone is not proof of the original sold value.
        // Reproducing an imported 043-era return with a missing original sale
        // receipt, even alongside a seemingly reconciled wallet number, must
        // fail without issuing another wallet cash receipt.
        db.execute(r#"
            INSERT INTO sales_invoices VALUES('orphan-original-sale','qa-patient','tenant-a','cash','completed',5);
            INSERT INTO returns VALUES('orphan-original-refund','orphan-original-sale','tenant-a','wallet','approved',5);
            INSERT INTO native_sale_return_cogs_provenance
              VALUES('orphan-original-refund','orphan-original-sale','tenant-a','wallet',5000000,'owner');
            UPDATE patients SET wallet_balance=30 WHERE id='qa-patient';
        "#).await.unwrap();
        let unverified_original = wallet_top_up(&mut db, "owner", request("qa-missing-original", "qa-patient")).await;
        assert!(unverified_original.as_ref().is_err_and(|e| e.contains("unverified wallet")),
            "A wallet refund with no original sale receipt was collected: {unverified_original:?}");
        db.execute(r#"
            UPDATE patients SET wallet_balance=25 WHERE id='qa-patient';
            DELETE FROM native_sale_return_cogs_provenance WHERE return_id='orphan-original-refund';
            DELETE FROM returns WHERE id='orphan-original-refund';
            DELETE FROM sales_invoices WHERE id='orphan-original-sale';
        "#).await.unwrap();
        let confirmed = confirm_wallet_top_up(&mut db, "owner", request("qa-once", "qa-patient"))
            .await.unwrap().expect("same actor, tenant, patient, amount and nonce must confirm");
        assert_eq!(confirmed.id, "qa-once");
        assert_eq!(confirmed.patient_id, "qa-patient");
        assert_eq!(confirmed.actor_id, "owner");
        assert_eq!(confirmed.pharmacy_id, "tenant-a");
        assert_eq!(confirmed.amount_cents, 2500);
        assert_eq!(confirmed.balance, 25.0);
        assert!(confirm_wallet_top_up(&mut db, "owner", request("unknown", "qa-patient"))
            .await.unwrap().is_none());
        assert!(confirm_wallet_top_up(&mut db, "owner", request("qa-once", "unowned"))
            .await.unwrap().is_none());
        let mut wrong_cents = request("qa-once", "qa-patient");
        wrong_cents.amount = 25.01;
        assert!(confirm_wallet_top_up(&mut db, "owner", wrong_cents)
            .await.unwrap().is_none());
        assert!(confirm_wallet_top_up(&mut db, "unknown-actor", request("qa-once", "qa-patient"))
            .await.is_err());
        db.execute("UPDATE users SET pharmacy_id='tenant-b' WHERE id='owner'")
            .await.unwrap();
        assert!(confirm_wallet_top_up(&mut db, "owner", request("qa-once", "qa-patient"))
            .await.unwrap().is_none());
        db.execute("UPDATE users SET pharmacy_id='tenant-a', role='cashier' WHERE id='owner'")
            .await.unwrap();
        assert!(confirm_wallet_top_up(&mut db, "owner", request("qa-once", "qa-patient"))
            .await.is_err());
        db.execute("UPDATE users SET role='owner' WHERE id='owner'").await.unwrap();
        let balance: f64 = sqlx::query_scalar("SELECT wallet_balance FROM patients WHERE id='qa-patient'")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(balance, 25.0);
        let journal: (f64,f64) = sqlx::query_as(
            "SELECT (SELECT SUM(amount) FROM journal_entries WHERE type='debit'),
                    (SELECT SUM(amount) FROM journal_entries WHERE type='credit')",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(journal, (25.0,25.0));
        assert!(wallet_top_up(&mut db, "owner", request("qa-once", "qa-patient"))
            .await.unwrap_err().contains("already processed"));
        assert!(wallet_top_up(&mut db, "owner", request("foreign", "unowned"))
            .await.unwrap_err().contains("ownership"));
        sqlx::query("INSERT INTO sales_invoices VALUES('foreign-sale','qa-patient','tenant-b','cash','completed',10)")
            .execute(&mut db).await.unwrap();
        assert!(wallet_top_up(&mut db, "owner", request("qa-two", "qa-patient"))
            .await.unwrap_err().contains("ownership"));
        sqlx::query("DELETE FROM sales_invoices WHERE id='foreign-sale'").execute(&mut db).await.unwrap();
        sqlx::raw_sql("CREATE TRIGGER synthetic_wallet_audit_failure BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT,'qa audit failure'); END;")
            .execute(&mut db).await.unwrap();
        assert!(wallet_top_up(&mut db, "owner", request("qa-rollback", "qa-patient"))
            .await.unwrap_err().contains("qa audit failure"));
        let totals: (i64,i64,i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM native_patient_wallet_topup_receipts),
                    (SELECT COUNT(*) FROM daily_journals),
                    (SELECT COUNT(*) FROM cash_movements)",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(totals, (1,1,1));
        let final_balance: f64 = sqlx::query_scalar("SELECT wallet_balance FROM patients WHERE id='qa-patient'")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(final_balance, 25.0);
        db.execute("UPDATE shifts SET status='closed' WHERE id='qa-shift'")
            .await.unwrap();
        assert!(confirm_wallet_top_up(&mut db, "owner", request("qa-once", "qa-patient"))
            .await.unwrap().is_some(), "closing the historical shift must not invalidate a sealed cash witness");
        db.execute("UPDATE patients SET wallet_balance=20 WHERE id='qa-patient'")
            .await.unwrap();
        assert!(confirm_wallet_top_up(&mut db, "owner", request("qa-once", "qa-patient"))
            .await.is_err(), "a changed wallet balance must not be acknowledged");
        db.execute("UPDATE patients SET wallet_balance=25 WHERE id='qa-patient'")
            .await.unwrap();
        // Even when a damaged imported DB has its protection trigger removed,
        // receipt lookup must refuse altered journal lines and cash amounts.
        db.execute("DROP TRIGGER native_wallet_topup_entry_immutable_update")
            .await.unwrap();
        db.execute("UPDATE journal_entries SET amount=24 WHERE type='debit'").await.unwrap();
        assert!(confirm_wallet_top_up(&mut db, "owner", request("qa-once", "qa-patient"))
            .await.unwrap().is_none());
        db.execute("UPDATE journal_entries SET amount=25 WHERE type='debit'").await.unwrap();
        db.execute("DROP TRIGGER native_wallet_topup_cash_immutable_update").await.unwrap();
        db.execute("UPDATE cash_movements SET amount=24").await.unwrap();
        assert!(confirm_wallet_top_up(&mut db, "owner", request("qa-once", "qa-patient"))
            .await.unwrap().is_none());

        // Forward-only 061 witness proves a newly created zero-origin wallet,
        // without requiring a fabricated first purchase. No legacy adoption:
        // the older global patient has no native ownership receipt.
        db.execute("DROP TRIGGER synthetic_wallet_audit_failure").await.unwrap();
        db.execute("ALTER TABLE patients ADD COLUMN opening_balance REAL DEFAULT 0")
            .await.unwrap();
        sqlx::raw_sql(include_str!("../../migrations/061_native_patient_directory_ownership.sql"))
            .execute(&mut db).await.unwrap();
        db.execute(r#"
            INSERT INTO patients(id,full_name,wallet_balance,opening_balance)
              VALUES('new-native','Fresh prospect',0,0),
                    ('unowned-nonzero','Historic unknown',5,0),
                    ('new-opening','Cannot adopt opening balance',0,9);
            INSERT INTO native_patient_directory_ownership
              (patient_id,pharmacy_id,actor_id,intent_sha256)
              VALUES('new-native','tenant-a','owner',lower(hex(zeroblob(32)))),
                    ('new-opening','tenant-a','owner',lower(hex(zeroblob(32))));
        "#).await.unwrap();
        let fresh = PatientWalletTopUpInput {
            patient_id: "new-native".into(), amount: 5.0,
            notes: None, request_id: "new-native-topup-once".into(),
        };
        let first = wallet_top_up(&mut db, "owner", fresh).await;
        assert!(first.as_ref().is_ok_and(|receipt| receipt.balance == 5.0),
            "Independently owned zero-history patient must fund wallet before any sale: {first:?}");
        for patient_id in ["unowned", "unowned-nonzero", "new-opening"] {
            let denied = wallet_top_up(&mut db, "owner", PatientWalletTopUpInput {
                patient_id: patient_id.into(), amount: 5.0, notes: None,
                request_id: format!("deny-{patient_id}"),
            }).await;
            assert!(denied.is_err(), "Historic/unverified patient {patient_id} was monetized");
        }
    }
}
