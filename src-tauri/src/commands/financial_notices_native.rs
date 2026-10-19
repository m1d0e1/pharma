//! Native financial-notice authorization and atomic accounting.
//!
//! Patients and suppliers predate branch ownership. Customer notices are only
//! permitted for a provably single-branch credit history with zero unscoped
//! transactions/notices. Supplier adjustments and their globally shared balance
//! are deliberately not supported until owner-approved provenance reconciliation.
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
pub struct NoticeInput {
    target_type: String,
    target_id: Option<String>,
    notice_type: String,
    amount: f64,
    reason: String,
    notes: Option<String>,
    date: String,
    request_id: String,
}
#[derive(Debug, Serialize)]
pub struct NoticePosted {
    id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoticePageInput {
    page: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticePage {
    rows: Vec<serde_json::Value>,
    has_more: bool,
}

fn safe_text(v: &str, max: usize, allow_lines: bool) -> bool {
    !v.trim().is_empty()
        && v.len() <= max
        && !v
            .chars()
            .any(|c| c == '\0' || (c.is_control() && !(allow_lines && matches!(c, '\r' | '\n'))))
}
fn date_ok(v: &str) -> bool {
    if v.len() != 10
        || !v.bytes().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
    {
        return false;
    }
    let y = v[0..4].parse::<u32>().unwrap_or(0);
    let m = v[5..7].parse::<u32>().unwrap_or(0);
    let d = v[8..10].parse::<u32>().unwrap_or(0);
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
fn cents(v: f64) -> Option<i64> {
    if !v.is_finite() || v <= 0.0 || v > 1e10 {
        return None;
    }
    let scaled = v * 100.0;
    let rounded = scaled.round();
    if (scaled - rounded).abs() > 1e-7 {
        return None;
    }
    Some(rounded as i64)
}
fn validate(input: &NoticeInput) -> Result<(), String> {
    if !matches!(
        input.target_type.as_str(),
        "customer" | "pharmacy" | "supplier"
    ) || !matches!(input.notice_type.as_str(), "credit" | "debit")
        || !date_ok(&input.date)
        || cents(input.amount).is_none()
        || !safe_text(&input.reason, 512, false)
        || !safe_text(&input.request_id, 128, false)
        || input
            .target_id
            .as_deref()
            .is_some_and(|s| !safe_text(s, 128, false))
        || input.notes.as_deref().is_some_and(|s| {
            s.len() > 2000
                || s.chars()
                    .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\r' | '\n')))
        })
        || (input.target_type == "pharmacy" && input.target_id.is_some())
        || (input.target_type != "pharmacy" && input.target_id.is_none())
    {
        return Err("Invalid native financial notice input".into());
    }
    Ok(())
}
async fn authorized(conn: &mut SqliteConnection, actor: &str) -> Result<String, String> {
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
        "acc_can_view_notifications",
        false,
    ) {
        return Err("Native financial-notice permission required".into());
    }
    Ok(pharmacy)
}
async fn account(conn: &mut SqliteConnection, category: &str, code: &str) -> Result<i64, String> {
    // An edited trial-balance setting cannot redirect a native notice away
    // from the canonical financial account, even if both sides still balance.
    let matches: Vec<i64> = sqlx::query_scalar(
        "SELECT a.id FROM main.accounts a
         WHERE a.code=? AND COALESCE(a.is_group,0)=0
           AND (NOT EXISTS(
               SELECT 1 FROM main.trial_balance_settings t WHERE t.category=?
             ) OR EXISTS(
               SELECT 1 FROM main.trial_balance_settings t
               WHERE t.category=? AND t.account_id=a.id
             )) LIMIT 2",
    )
    .bind(code)
    .bind(category)
    .bind(category)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if matches.len() != 1 {
        return Err(format!(
            "Missing or unsafe financial notice account mapping for {category}"
        ));
    }
    Ok(matches[0])
}
/// Both native patient-money writers share this exact provenance gate. A
/// patient-account return is trusted only when its patient-history row uses
/// the immutable 043 return ID and matches the original source, tenant and
/// amount. Legacy random-ID or altered refund mirrors remain untrusted.
pub(super) async fn count_untrusted_patient_transactions(
    conn: &mut SqliteConnection,
    patient: &str,
    pharmacy: &str,
) -> Result<i64, String> {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.patient_transactions pt
         LEFT JOIN main.patient_payment_scope pay ON pay.transaction_id=pt.id
         LEFT JOIN main.financial_notice_native_scope ns ON ns.patient_transaction_id=pt.id
         WHERE pt.patient_id=? AND NOT (
           (pt.type='payment' AND COALESCE(pay.pharmacy_id,'')=? AND ns.notice_id IS NULL)
           OR (pt.type='adjustment' AND COALESCE(ns.pharmacy_id,'')=? AND pay.transaction_id IS NULL)
           OR (pt.type='refund' AND pt.payment_method='patient_account'
               AND pay.transaction_id IS NULL AND ns.patient_transaction_id IS NULL
               AND typeof(pt.amount) IN ('real','integer') AND pt.amount>=0
               AND EXISTS (
                 SELECT 1 FROM main.returns r
                 JOIN main.sales_invoices s ON s.id=r.invoice_id
                 JOIN main.native_sale_return_cogs_provenance p ON p.return_id=r.id
                 WHERE r.id=pt.id AND s.patient_id=pt.patient_id
                   AND s.pharmacy_id=? AND r.pharmacy_id=? AND p.pharmacy_id=?
                   AND p.sale_id=s.id AND pt.user_id=p.actor_id
                   AND r.refund_method='patient_account'
                   AND p.refund_method=r.refund_method
                   AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
                   AND typeof(r.total_refund) IN ('real','integer') AND r.total_refund>=0
                   AND abs(pt.amount*1000000.0-p.refund_micros)<=2
                   AND abs(r.total_refund*1000000.0-p.refund_micros)<=2
               ))
         )",
    )
    .bind(patient).bind(pharmacy).bind(pharmacy)
    .bind(pharmacy).bind(pharmacy).bind(pharmacy)
    .fetch_one(conn).await.map_err(|e|e.to_string())
}

/// The same no-invented-ownership rule as patient payment settlement, but
/// accepts exclusively tagged earlier native notice adjustments.
async fn verify_patient(
    conn: &mut SqliteConnection,
    id: &str,
    pharmacy: &str,
) -> Result<(), String> {
    let opening: Option<f64> = sqlx::query_scalar(
        "SELECT CAST(COALESCE(opening_balance,0) AS REAL) FROM main.patients WHERE id=? LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if opening.map_or(true, |v| !v.is_finite() || v.abs() > 0.000001) {
        return Err("Patient opening balance lacks trusted branch provenance".into());
    }
    let foreign: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.sales_invoices WHERE patient_id=?
         AND pharmacy_id IS NOT ?",
    )
    .bind(id)
    .bind(pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let owned:i64=sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.sales_invoices WHERE patient_id=? AND payment_method='credit'
         AND pharmacy_id=?
         AND (status IS NULL OR status='' OR LOWER(status) IN ('completed','approved','delivered'))")
        .bind(id).bind(pharmacy).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
    let ambiguous_returns: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.returns r JOIN main.sales_invoices si ON si.id=r.invoice_id
         WHERE si.patient_id=? AND r.refund_method='patient_account'
         AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
         AND r.pharmacy_id IS NOT ?",
    )
    .bind(id)
    .bind(pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let untrusted_notice:i64=sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.financial_notices n LEFT JOIN main.financial_notice_native_scope sc
         ON sc.notice_id=n.id WHERE n.target_type='customer' AND n.target_id=?
         AND (sc.notice_id IS NULL OR sc.pharmacy_id<>? OR n.type NOT IN ('credit','debit'))")
        .bind(id).bind(pharmacy).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
    let untrusted_transactions=count_untrusted_patient_transactions(conn,id,pharmacy).await?;
    if foreign > 0
        || owned == 0
        || ambiguous_returns > 0
        || untrusted_notice > 0
        || untrusted_transactions > 0
    {
        return Err("Ambiguous legacy patient; no pharmacy ownership is inferred".into());
    }
    verify_patient_account_return_amounts(conn, id, pharmacy).await?;
    verify_proven_patient_credit_sources(conn, id, pharmacy).await?;
    verify_native_notice_mirrors(conn, id, pharmacy).await?;
    super::patient_payments_native::verify_scoped_patient_payments(conn, id, pharmacy).await?;
    Ok(())
}

/// Startup compatibility historically filled NULL tenant IDs from a mutable
/// user row or local_default. A present-day branch string is NOT original
/// credit provenance. Only the forward native 043 sale/return witnesses permit
/// new patient receivable money operations; older sources await independent
/// historical review rather than a fabricated ownership backfill.
pub(crate) async fn verify_proven_patient_credit_sources(
    conn: &mut SqliteConnection,
    patient: &str,
    pharmacy: &str,
) -> Result<(), String> {
    let unverified_sale: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM main.sales_invoices s
         LEFT JOIN main.native_sale_cogs_provenance p ON p.sale_id=s.id
         WHERE s.patient_id=? AND s.payment_method='credit'
           AND (s.status IS NULL OR s.status='' OR LOWER(s.status) IN ('completed','approved','delivered'))
           AND (s.pharmacy_id IS NOT ? OR p.sale_id IS NULL
             OR p.pharmacy_id IS NOT s.pharmacy_id OR p.payment_method IS NOT 'credit'
             OR typeof(s.total_amount) NOT IN ('integer','real')
             OR s.total_amount<0 OR s.total_amount>1000000000000
             OR typeof(p.sale_micros) IS NOT 'integer'
             OR abs(s.total_amount*1000000.0-p.sale_micros)>2)
         LIMIT 1",
    )
    .bind(patient)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if unverified_sale.is_some() {
        return Err(
            "Patient debt has unverified credit source; independent history review required".into(),
        );
    }
    let unverified_return: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM main.returns r
         JOIN main.sales_invoices s ON s.id=r.invoice_id
         LEFT JOIN main.native_sale_return_cogs_provenance p ON p.return_id=r.id
         WHERE s.patient_id=? AND r.refund_method='patient_account'
           AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
           AND (r.pharmacy_id IS NOT ? OR p.return_id IS NULL
             OR p.sale_id IS NOT s.id OR p.pharmacy_id IS NOT r.pharmacy_id
             OR p.refund_method IS NOT 'patient_account'
             OR typeof(r.total_refund) NOT IN ('integer','real')
             OR r.total_refund<0 OR r.total_refund>1000000000000
             OR typeof(p.refund_micros) IS NOT 'integer'
             OR abs(r.total_refund*1000000.0-p.refund_micros)>2)
         LIMIT 1",
    )
    .bind(patient)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if unverified_return.is_some() {
        return Err("Patient debt has unverified patient refund source; independent history review required".into());
    }
    Ok(())
}

/// Finalized patient-account refunds reduce receivables. A mutable return
/// header cannot override contradictory persisted item-line refunds. This
/// establishes current source consistency, not historical authenticity.
pub(super) async fn verify_patient_account_return_amounts(
    conn: &mut SqliteConnection,
    patient: &str,
    pharmacy: &str,
) -> Result<(), String> {
    let inconsistent: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM main.returns r
         JOIN main.sales_invoices si ON si.id=r.invoice_id
         WHERE si.patient_id=?
           AND COALESCE(NULLIF(TRIM(si.pharmacy_id),''),'local_default')=?
           AND COALESCE(NULLIF(TRIM(r.pharmacy_id),''),'local_default')=?
           AND r.refund_method='patient_account'
           AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
           AND (typeof(r.total_refund) NOT IN ('integer','real')
             OR r.total_refund<0 OR r.total_refund>1000000000000
             OR NOT EXISTS (SELECT 1 FROM main.return_items ri WHERE ri.return_id=r.id)
             OR EXISTS (SELECT 1 FROM main.return_items ri WHERE ri.return_id=r.id
                  AND (typeof(ri.total_price) NOT IN ('integer','real')
                    OR ri.total_price<0 OR ri.total_price>1000000000000))
             OR abs(r.total_refund - (SELECT COALESCE(SUM(ri.total_price),0)
                  FROM main.return_items ri WHERE ri.return_id=r.id))>0.005)
         LIMIT 1",
    )
    .bind(patient)
    .bind(pharmacy)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if inconsistent.is_some() {
        return Err("Patient balance has unreconciled historical refund amounts".into());
    }
    Ok(())
}

/// Reuse in patient-payment settlement: a native scope tag is not itself
/// evidence that its patient debt mirror still matches the originating notice.
/// This accepts earlier native notices with independent journal UUIDs.
pub(super) async fn verify_native_notice_mirrors(
    conn: &mut SqliteConnection,
    patient: &str,
    pharmacy: &str,
) -> Result<(), String> {
    let inconsistent: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.financial_notice_native_scope sc
         LEFT JOIN main.financial_notices n ON n.id=sc.notice_id
         LEFT JOIN main.patient_transactions pt ON pt.id=sc.patient_transaction_id
         WHERE ((n.target_type='customer' AND n.target_id=?) OR pt.patient_id=?)
           AND (sc.pharmacy_id IS NOT ? OR n.pharmacy_id IS NOT sc.pharmacy_id
                OR n.target_type IS NOT 'customer' OR n.type NOT IN ('credit','debit')
                OR pt.type IS NOT 'adjustment' OR n.target_id IS NOT pt.patient_id
                OR n.user_id IS NOT pt.user_id OR n.date IS NOT pt.date
                OR typeof(n.amount) NOT IN ('integer','real')
                OR typeof(pt.amount) NOT IN ('integer','real')
                OR n.amount<=0 OR n.amount>10000000000
                OR pt.amount IS NOT CASE WHEN n.type='credit' THEN -n.amount ELSE n.amount END)",
    )
    .bind(patient)
    .bind(patient)
    .bind(pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if inconsistent != 0 {
        return Err("Ambiguous legacy patient; native notice mirror contradicts its source".into());
    }
    // 036 linked a notice to its patient adjustment, but not to any journal.
    // A mutable, correctly mirrored V1 notice can therefore invent debt while
    // the historical journal stays unchanged (or never existed). New 051
    // sources have a durable journal receipt; old V1 stays for audit/review,
    // but cannot authorize more money or notices without independent proof.
    let unlinked: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM main.financial_notices n
         JOIN main.financial_notice_native_scope sc ON sc.notice_id=n.id
         WHERE n.target_type='customer' AND n.target_id=? AND sc.pharmacy_id=?
           AND NOT EXISTS(SELECT 1 FROM main.native_patient_financial_journal_receipts r
                WHERE r.source_kind='notice' AND r.source_id=n.id
                  AND r.pharmacy_id=sc.pharmacy_id AND r.actor_id=n.user_id
                  AND r.money_kind=n.type AND typeof(n.amount) IN ('real','integer')
                  AND abs(r.amount_cents-n.amount*100.0)<0.00001)
         LIMIT 1",
    )
    .bind(patient)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if unlinked.is_some() {
        return Err("Patient account has unverified legacy notice journal; independent finance review required".into());
    }
    Ok(())
}
async fn post_with_lock(
    conn: &mut SqliteConnection,
    actor: &str,
    input: NoticeInput,
) -> Result<NoticePosted, String> {
    validate(&input)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result = async {
        let conn = &mut *tx;
        let pharmacy = authorized(conn, actor).await?;
        if input.target_type == "supplier" {
            // Suppliers and their aggregated balance lack row-level ownership.
            return Err(
                "Legacy shared supplier balance requires approved provenance reconciliation".into(),
            );
        }
        let replay: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM main.financial_notice_native_scope WHERE request_id=? LIMIT 1",
        )
        .bind(&input.request_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if replay.is_some() {
            return Err("Financial notice request already posted".into());
        }
        if let Some(patient) = input.target_id.as_deref() {
            verify_patient(conn, patient, &pharmacy).await?;
        }
        // Pharmacy notices post to physical cash drawer 1.1.1. An unassigned
        // cash adjustment would make shift closure disagree with its journal.
        let drawer_shift = if input.target_type == "pharmacy" {
            let shifts: Vec<String> = sqlx::query_scalar(
                "SELECT CAST(id AS TEXT) FROM main.shifts
                 WHERE pharmacy_id=? AND LOWER(COALESCE(status,''))='open' LIMIT 2",
            )
            .bind(&pharmacy)
            .fetch_all(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
            if shifts.len() != 1 {
                return Err("Pharmacy cash notice requires exactly one open owned shift".into());
            }
            Some(shifts[0].clone())
        } else {
            None
        };
        let target = if input.target_type == "customer" {
            account(conn, "accounts_receivable", "1.1.2").await?
        } else {
            account(conn, "cash_drawer", "1.1.1").await?
        };
        let adjustment = account(conn, "customer_adjustments", "4.2").await?;
        if target == adjustment {
            return Err("Financial notice must use distinct posting accounts".into());
        }
        let id = Uuid::new_v4().to_string();
        let patient_tx = if input.target_type == "customer" {
            Some(Uuid::new_v4().to_string())
        } else {
            None
        };
        let journal = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO main.financial_notices
            (id,user_id,target_type,target_id,type,amount,reason,notes,date,pharmacy_id)
            VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&id)
        .bind(actor)
        .bind(&input.target_type)
        .bind(&input.target_id)
        .bind(&input.notice_type)
        .bind(input.amount)
        .bind(&input.reason)
        .bind(&input.notes)
        .bind(&input.date)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if let (Some(patient), Some(transaction_id)) =
            (input.target_id.as_deref(), patient_tx.as_deref())
        {
            let signed = if input.notice_type == "credit" {
                -input.amount
            } else {
                input.amount
            };
            sqlx::query(
                "INSERT INTO main.patient_transactions
                (id,patient_id,user_id,type,amount,notes,date) VALUES(?,?,?,'adjustment',?,?,?)",
            )
            .bind(transaction_id)
            .bind(patient)
            .bind(actor)
            .bind(signed)
            .bind(&input.reason)
            .bind(&input.date)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        }
        sqlx::query(
            "INSERT INTO main.financial_notice_native_scope
            (notice_id,pharmacy_id,request_id,patient_transaction_id) VALUES(?,?,?,?)",
        )
        .bind(&id)
        .bind(&pharmacy)
        .bind(&input.request_id)
        .bind(&patient_tx)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT INTO main.daily_journals
            (id,date,description,created_by,total_amount,pharmacy_id) VALUES(?,?,?,?,?,?)",
        )
        .bind(&journal)
        .bind(&input.date)
        .bind(format!("إشعار {}: {}", input.notice_type, input.reason))
        .bind(actor)
        .bind(input.amount)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        let target_kind = if input.notice_type == "credit" {
            "credit"
        } else {
            "debit"
        };
        let offset_kind = if target_kind == "credit" {
            "debit"
        } else {
            "credit"
        };
        for (account_id, kind) in [(target, target_kind), (adjustment, offset_kind)] {
            sqlx::query(
                "INSERT INTO main.journal_entries
                (journal_id,account_id,type,amount) VALUES(?,?,?,?)",
            )
            .bind(&journal)
            .bind(account_id)
            .bind(kind)
            .bind(input.amount)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        }
        sqlx::query(
            "INSERT INTO main.native_patient_financial_journal_receipts
              (source_kind,source_id,pharmacy_id,actor_id,journal_id,amount_cents,money_kind)
              VALUES('notice',?,?,?,?,?,?)",
        )
        .bind(&id)
        .bind(&pharmacy)
        .bind(actor)
        .bind(&journal)
        .bind((input.amount * 100.0).round() as i64)
        .bind(&input.notice_type)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if let Some(shift_id) = drawer_shift {
            let movement_type = if input.notice_type == "debit" {
                "receipt"
            } else {
                "disbursement"
            };
            let movement_id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO main.cash_movements
                 (id,user_id,shift_id,type,category,amount,source_type,target_name,date,pharmacy_id)
                 VALUES(?,?,?,?,'financial_notice',?,'financial_notice',?,?,?)",
            )
            .bind(&movement_id)
            .bind(actor)
            .bind(&shift_id)
            .bind(movement_type)
            .bind(input.amount)
            .bind(&id)
            .bind(&input.date)
            .bind(&pharmacy)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
            sqlx::query(
                "INSERT INTO main.native_financial_notice_cash_witnesses
                  (notice_id,journal_id,cash_movement_id,shift_id,pharmacy_id,actor_id,amount_cents)
                  VALUES(?,?,?,?,?,?,?)",
            )
            .bind(&id)
            .bind(&journal)
            .bind(&movement_id)
            .bind(&shift_id)
            .bind(&pharmacy)
            .bind(actor)
            .bind((input.amount * 100.0).round() as i64)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        }
        sqlx::query(
            "INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
            VALUES(?,'FINANCIAL_NOTICE',?,?)",
        )
        .bind(actor)
        .bind(format!(
            "Notice {} {} {}",
            id, input.notice_type, input.amount
        ))
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        Ok(NoticePosted { id })
    }
    .await;
    match result {
        Ok(v) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(v)
        }
        Err(e) => {
            tx.rollback()
                .await
                .map_err(|err| format!("{e}; rollback failed: {err}"))?;
            Err(e)
        }
    }
}
async fn read_with_scope(
    conn: &mut SqliteConnection,
    actor: &str,
    page: u32,
) -> Result<NoticePage, String> {
    if page > 499 {
        return Err("Financial notice history page limit exceeded".into());
    }
    reset_cancelled_read_state(conn).await?;
    let pharmacy = authorized(conn, actor).await?;
    // No legacy 'ownership' from potentially reassigned user rows is trusted.
    // Refuse to hide old notices or project global patient/supplier identities.
    let legacy: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.financial_notices n
         LEFT JOIN main.financial_notice_native_scope s ON s.notice_id=n.id
         WHERE COALESCE(NULLIF(TRIM(n.pharmacy_id),''),'local_default')=?
           AND (s.notice_id IS NULL OR s.pharmacy_id<>?)",
    )
    .bind(&pharmacy)
    .bind(&pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if legacy > 0 {
        return Err(
            "Legacy financial notices require provenance reconciliation before display".into(),
        );
    }
    let rows = sqlx::query(
        "SELECT n.id,n.user_id,n.target_type,n.target_id,n.type,n.amount,
      n.reason,n.notes,n.date,n.created_at,n.pharmacy_id,
      u.full_name AS user_name,CASE WHEN n.target_type='customer'
      THEN COALESCE(p.full_name,'عميل') ELSE 'الصيدلية / عام' END AS target_name
      FROM main.financial_notices n
      JOIN main.financial_notice_native_scope s ON s.notice_id=n.id AND s.pharmacy_id=?
      LEFT JOIN main.users u ON u.id=n.user_id
        AND COALESCE(NULLIF(TRIM(u.pharmacy_id),''),'local_default')=?
      LEFT JOIN main.patients p ON n.target_type='customer' AND n.target_id=p.id
      WHERE COALESCE(NULLIF(TRIM(n.pharmacy_id),''),'local_default')=?
      ORDER BY n.created_at DESC,n.id DESC LIMIT 101 OFFSET ?",
    )
    .bind(&pharmacy)
    .bind(&pharmacy)
    .bind(&pharmacy)
    .bind(i64::from(page) * 100)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let more = rows.len() > 100;
    let mut values = Vec::with_capacity(rows.len().min(100));
    for row in rows.into_iter().take(100) {
        values.push(serde_json::json!({
            "id":row.try_get::<String,_>("id").map_err(|e|e.to_string())?,
            "user_id":row.try_get::<String,_>("user_id").map_err(|e|e.to_string())?,
            "target_type":row.try_get::<String,_>("target_type").map_err(|e|e.to_string())?,
            "target_id":row.try_get::<Option<String>,_>("target_id").unwrap_or(None),
            "type":row.try_get::<String,_>("type").map_err(|e|e.to_string())?,
            "amount":row.try_get::<f64,_>("amount").map_err(|e|e.to_string())?,
            "reason":row.try_get::<Option<String>,_>("reason").unwrap_or(None),
            "notes":row.try_get::<Option<String>,_>("notes").unwrap_or(None),
            "date":row.try_get::<String,_>("date").map_err(|e|e.to_string())?,
            "created_at":row.try_get::<Option<String>,_>("created_at").unwrap_or(None),
            "pharmacy_id":row.try_get::<Option<String>,_>("pharmacy_id").unwrap_or(None),
            "user_name":row.try_get::<Option<String>,_>("user_name").unwrap_or(None),
            "target_name":row.try_get::<String,_>("target_name").map_err(|e|e.to_string())?,
        }));
    }
    Ok(NoticePage {
        rows: values,
        has_more: more,
    })
}
#[tauri::command]
pub async fn create_financial_notice_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: NoticeInput,
) -> Result<NoticePosted, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    post_with_lock(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}
#[tauri::command]
pub async fn list_financial_notices_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: NoticePageInput,
) -> Result<NoticePage, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    read_with_scope(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload.page,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use sqlx::{Connection, Executor};
    use std::time::Duration;
    async fn seed(conn: &mut SqliteConnection) {
        conn.execute(r#"
          CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,is_active INTEGER,permissions TEXT,full_name TEXT);
          INSERT INTO users VALUES
           ('a','owner','branch-a',1,'{}','Owner A'),('b','owner','branch-b',1,'{}','Owner B'),
           ('permitted','cashier','branch-a',1,'{"acc_can_view_notifications":true}','Clerk'),
           ('denied','cashier','branch-a',1,'{}','Denied'),
           ('disabled','owner','branch-a',0,'{}','Disabled');
          CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT,opening_balance REAL);
          INSERT INTO patients VALUES ('p','Patient A',0),('shared','Shared',0),('legacy','Legacy',0),('opening','Opening',50);
          CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,patient_id TEXT,payment_method TEXT,pharmacy_id TEXT,status TEXT,total_amount REAL);
          INSERT INTO sales_invoices VALUES
            ('a-sale','p','credit','branch-a','completed',100),
            ('shared-a','shared','credit','branch-a','completed',70),
            ('shared-b','shared','credit','branch-b','completed',10),
            ('legacy-a','legacy','credit','branch-a','completed',12),
            ('opening-a','opening','credit','branch-a','completed',100);
          CREATE TABLE native_sale_cogs_provenance(sale_id TEXT PRIMARY KEY,pharmacy_id TEXT,payment_method TEXT,sale_micros INTEGER);
          INSERT INTO native_sale_cogs_provenance
            SELECT id,pharmacy_id,payment_method,CAST(total_amount*1000000 AS INTEGER)
            FROM sales_invoices;
          CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,refund_method TEXT,status TEXT,pharmacy_id TEXT,total_refund REAL);
          CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT,total_price REAL);
          CREATE TABLE native_sale_return_cogs_provenance(return_id TEXT PRIMARY KEY,sale_id TEXT,pharmacy_id TEXT,refund_method TEXT,refund_micros INTEGER,actor_id TEXT);
          CREATE TABLE patient_transactions(id TEXT PRIMARY KEY,patient_id TEXT,user_id TEXT,type TEXT,amount REAL,payment_method TEXT,notes TEXT,date TEXT);
          INSERT INTO patient_transactions VALUES('legacy-tx','legacy','a','adjustment',2,'cash','legacy','2026-10-11');
          CREATE TABLE patient_payment_scope(transaction_id TEXT PRIMARY KEY,pharmacy_id TEXT,request_id TEXT);
          CREATE TABLE financial_notices(id TEXT PRIMARY KEY,user_id TEXT,target_type TEXT,target_id TEXT,type TEXT,amount REAL,reason TEXT,notes TEXT,date TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,pharmacy_id TEXT);
          CREATE TABLE financial_notice_native_scope(notice_id TEXT PRIMARY KEY,pharmacy_id TEXT,
            request_id TEXT UNIQUE,patient_transaction_id TEXT UNIQUE);
          CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER);
          INSERT INTO accounts VALUES (1,'1.1.1',0),(2,'1.1.2',0),(3,'4.2',0),(4,'4',1);
          CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
          INSERT INTO trial_balance_settings VALUES('cash_drawer',1),('accounts_receivable',2),('customer_adjustments',3);
          CREATE TABLE daily_journals(id TEXT PRIMARY KEY,date TEXT,description TEXT,created_by TEXT,total_amount REAL,pharmacy_id TEXT);
          CREATE TABLE shifts(id TEXT PRIMARY KEY,pharmacy_id TEXT,status TEXT,starting_cash REAL);
          INSERT INTO shifts VALUES('a-shift','branch-a','open',100),('local-shift','local_default','open',0);
          CREATE TABLE cash_movements(id TEXT PRIMARY KEY,user_id TEXT,type TEXT,category TEXT,amount REAL,source_type TEXT,target_name TEXT,date TEXT,pharmacy_id TEXT,shift_id TEXT);
          CREATE TABLE journal_entries(id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
          CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
          CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name_ar TEXT,balance REAL);
          INSERT INTO suppliers VALUES(1,'Global Supplier',5);
        "#).await.unwrap();
        conn.execute(include_str!(
            "../../migrations/051_patient_financial_journal_receipts.sql"
        ))
        .await
        .unwrap();
        conn.execute(include_str!(
            "../../migrations/055_patient_cash_movement_witness.sql"
        ))
        .await
        .unwrap();
        conn.execute(include_str!(
            "../../migrations/056_financial_notice_cash_witness.sql"
        ))
        .await
        .unwrap();
    }
    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        seed(&mut conn).await;
        conn
    }
    fn notice(target: &str, nonce: &str, notice_type: &str) -> NoticeInput {
        NoticeInput {
            target_type: target.into(),
            target_id: if target == "pharmacy" {
                None
            } else {
                Some("p".into())
            },
            notice_type: notice_type.into(),
            amount: 12.5,
            reason: "Correction".into(),
            notes: Some("Test".into()),
            date: "2026-10-11".into(),
            request_id: nonce.into(),
        }
    }
    async fn count(db: &mut SqliteConnection, table: &str) -> i64 {
        let q = match table {
            "notices" => "SELECT COUNT(*) FROM financial_notices",
            "scope" => "SELECT COUNT(*) FROM financial_notice_native_scope",
            "patient" => "SELECT COUNT(*) FROM patient_transactions",
            "journal" => "SELECT COUNT(*) FROM daily_journals",
            "entries" => "SELECT COUNT(*) FROM journal_entries",
            "activity" => "SELECT COUNT(*) FROM activity_log",
            "cash" => "SELECT COUNT(*) FROM cash_movements",
            _ => panic!("unknown table"),
        };
        sqlx::query_scalar(q).fetch_one(&mut *db).await.unwrap()
    }
    #[tokio::test]
    async fn scoped_customer_notice_posts_balanced_journal_and_payment_mirror() {
        let mut db = fixture().await;
        let created = post_with_lock(&mut db, "permitted", notice("customer", "nonce-a", "debit"))
            .await
            .unwrap();
        assert!(!created.id.is_empty());
        for (table, n) in [
            ("notices", 1),
            ("scope", 1),
            ("patient", 2),
            ("journal", 1),
            ("entries", 2),
            ("activity", 1),
        ] {
            assert_eq!(count(&mut db, table).await, n, "{table}");
        }
        let entries: Vec<(String, f64)> =
            sqlx::query("SELECT type,amount FROM journal_entries ORDER BY id")
                .fetch_all(&mut db)
                .await
                .unwrap()
                .iter()
                .map(|r| (r.get("type"), r.get("amount")))
                .collect();
        assert_eq!(
            entries,
            vec![("debit".into(), 12.5), ("credit".into(), 12.5)]
        );
        let balance: f64 = sqlx::query_scalar(
            "SELECT SUM(amount) FROM patient_transactions WHERE type='adjustment'",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(balance, 14.5);
        assert!(
            post_with_lock(&mut db, "permitted", notice("customer", "nonce-a", "debit"))
                .await
                .unwrap_err()
                .contains("already posted")
        );
        let listed = read_with_scope(&mut db, "permitted", 0).await.unwrap();
        assert_eq!(listed.rows.len(), 1);
        assert_eq!(listed.rows[0]["target_name"], "Patient A");
        assert_eq!(listed.rows[0]["pharmacy_id"], "branch-a");
        // A legitimate, natively posted first adjustment remains a valid
        // source for subsequent adjustments to this same patient.
        assert!(post_with_lock(
            &mut db,
            "permitted",
            notice("customer", "nonce-b", "credit")
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn customer_notice_cannot_infer_local_default_ownership_from_unscoped_credit() {
        let mut db = fixture().await;
        db.execute(
            r#"
            INSERT INTO users VALUES('owner-local','owner','local_default',1,'{}','Local owner');
            INSERT INTO patients VALUES('unowned','Unowned',0),('explicit-local','Explicit',0);
            INSERT INTO sales_invoices VALUES
              ('unowned-sale','unowned','credit',NULL,'completed',100),
              ('explicit-sale','explicit-local','credit','local_default','completed',100);
            INSERT INTO native_sale_cogs_provenance VALUES('explicit-sale','local_default','credit',100000000);
        "#,
        )
        .await
        .unwrap();
        let mut payload = notice("customer", "unowned-notice", "credit");
        payload.target_id = Some("unowned".into());
        let wrong = post_with_lock(&mut db, "owner-local", payload).await;
        assert!(
            wrong
                .as_ref()
                .is_err_and(|e| e.contains("Ambiguous legacy patient")),
            "A credit invoice with no pharmacy authorized a notice: {wrong:?}"
        );
        assert_eq!(count(&mut db, "notices").await, 0);
        assert_eq!(count(&mut db, "journal").await, 0);
        let mut legitimate = notice("customer", "explicit-notice", "credit");
        legitimate.target_id = Some("explicit-local".into());
        assert!(post_with_lock(&mut db, "owner-local", legitimate)
            .await
            .is_ok());
        assert_eq!(count(&mut db, "notices").await, 1);
    }
    #[tokio::test]
    async fn normalized_legacy_credit_cannot_authorize_customer_notice() {
        let mut db = fixture().await;
        db.execute(r#"
            INSERT INTO users VALUES('local','owner','local_default',1,'{}','Local owner');
            INSERT INTO patients VALUES('normalized-old','Uncertified',0);
            INSERT INTO sales_invoices VALUES('old-source','normalized-old','credit',NULL,'completed',100);
            UPDATE sales_invoices SET pharmacy_id='local_default'
              WHERE id='old-source' AND pharmacy_id IS NULL;
        "#).await.unwrap();
        let mut input = notice("customer", "normalized-notice", "debit");
        input.target_id = Some("normalized-old".into());
        let attempted = post_with_lock(&mut db, "local", input).await;
        assert!(
            attempted
                .as_ref()
                .is_err_and(|e| e.contains("unverified credit source")),
            "A compatibility-inferred patient credit authorized notice: {attempted:?}"
        );
        for table in ["notices", "scope", "journal", "entries", "activity"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} was written");
        }
    }
    #[tokio::test]
    async fn customer_notice_cannot_rely_on_orphaned_local_default_cash_receipt() {
        let mut db = fixture().await;
        db.execute(r#"
            INSERT INTO users VALUES('local','owner','local_default',1,'{}','Local');
            INSERT INTO patients VALUES('local-p','Local patient',0);
            INSERT INTO sales_invoices VALUES('local-credit','local-p','credit','local_default','completed',100);
            INSERT INTO native_sale_cogs_provenance VALUES('local-credit','local_default','credit',100000000);
            INSERT INTO patient_transactions VALUES('paid-local','local-p','local','payment',20,'cash','Native','2026-10-11');
            INSERT INTO patient_payment_scope VALUES('paid-local','local_default','cash-request');
            INSERT INTO cash_movements VALUES('cash-local','local','receipt','accounts_receivable',20,'patient_payment','local-p','2026-10-11',NULL,'local-shift');
        "#).await.unwrap();
        let mut request = notice("customer", "after-null-cash", "debit");
        request.target_id = Some("local-p".into());
        let result = post_with_lock(&mut db, "local", request).await;
        assert!(
            result
                .as_ref()
                .is_err_and(|e| e.contains("unverifiable historical cash UUID")),
            "An orphaned receipt without tenant authorized a new notice: {result:?}"
        );
        for table in ["notices", "journal", "entries", "activity"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} changed on denial");
        }
        db.execute("UPDATE cash_movements SET pharmacy_id='local_default' WHERE id='cash-local'")
            .await
            .unwrap();
        let mut valid = notice("customer", "after-valid-cash", "debit");
        valid.target_id = Some("local-p".into());
        // Repairing a mutable tenant field cannot establish the missing
        // prospective 055 source -> exact cash UUID witness for an old payment.
        let repaired = post_with_lock(&mut db, "local", valid).await;
        assert!(repaired.as_ref().is_err_and(|e| e.contains("unverifiable historical cash UUID")),
            "A tenant edit fabricated historic cash UUID provenance: {repaired:?}");
        for table in ["notices", "journal", "entries", "activity"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} changed after tenant edit");
        }
    }
    #[tokio::test]
    async fn altered_native_notice_mirror_cannot_authorize_more_patient_debt() {
        let mut db = fixture().await;
        post_with_lock(&mut db, "a", notice("customer", "first-native", "credit"))
            .await
            .unwrap();
        // This native source created a -12.50 patient adjustment; altering only
        // its mirrored transaction to +900 would invent debt without a notice.
        sqlx::query(
            "UPDATE patient_transactions SET amount=900
             WHERE id=(SELECT patient_transaction_id FROM financial_notice_native_scope
                       WHERE request_id='first-native')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        let notices_before = count(&mut db, "notices").await;
        let journals_before = count(&mut db, "journal").await;
        let entries_before = count(&mut db, "entries").await;
        let result = post_with_lock(
            &mut db,
            "a",
            notice("customer", "after-corrupt-mirror", "debit"),
        )
        .await;
        assert!(
            result
                .as_ref()
                .is_err_and(|e| e.contains("Ambiguous legacy patient")),
            "A forged patient adjustment mirror passed as a native notice source: {result:?}"
        );
        assert_eq!(count(&mut db, "notices").await, notices_before);
        assert_eq!(count(&mut db, "journal").await, journals_before);
        assert_eq!(count(&mut db, "entries").await, entries_before);
    }
    #[tokio::test]
    async fn customer_notice_rejects_corrupt_prior_scoped_patient_payment() {
        let mut db = fixture().await;
        db.execute(
            "INSERT INTO patient_transactions(id,patient_id,user_id,type,amount,payment_method,date)
             VALUES('prior-payment','p','a','payment',-900,'cash','2026-10-11')",
        )
        .await
        .unwrap();
        db.execute(
            "INSERT INTO patient_payment_scope(transaction_id,pharmacy_id,request_id)
             VALUES('prior-payment','branch-a','prior-payment-nonce')",
        )
        .await
        .unwrap();
        db.execute(
            "INSERT INTO cash_movements
             VALUES('prior-cash','a','receipt','accounts_receivable',20,
                    'patient_payment','p','2026-10-11','branch-a','a-shift')",
        )
        .await
        .unwrap();
        let forged = post_with_lock(&mut db, "a", notice("customer", "bad-prior", "debit")).await;
        assert!(
            forged
                .as_ref()
                .is_err_and(|e| e.contains("unverifiable historical cash UUID")),
            "Prior impossible negative patient payment was trusted: {forged:?}"
        );
        assert_eq!(count(&mut db, "notices").await, 0);
        assert_eq!(count(&mut db, "journal").await, 0);
        assert_eq!(count(&mut db, "entries").await, 0);
        db.execute("UPDATE patient_transactions SET amount=20 WHERE id='prior-payment'")
            .await
            .unwrap();
        // A repaired numeric mirror does not retroactively link the pre-055
        // payment to any exact, immutable cash movement UUID.
        let repaired = post_with_lock(&mut db, "a", notice("customer", "valid-prior", "debit"))
            .await;
        assert!(repaired.as_ref().is_err_and(|e| e.contains("unverifiable historical cash UUID")),
            "Changing an old amount inferred historic cash UUID provenance: {repaired:?}");
        for table in ["notices", "journal", "entries", "activity"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} changed after amount edit");
        }
    }
    #[tokio::test]
    async fn unlinked_legacy_bank_payment_cannot_authorize_further_customer_notice() {
        let mut db = fixture().await;
        db.execute(r#"
          INSERT INTO patient_transactions VALUES('legacy-bank','p','a','payment',1,'bank','old','2026-10-11');
          INSERT INTO patient_payment_scope VALUES('legacy-bank','branch-a','old-bank-request');
          INSERT INTO daily_journals VALUES('legacy-journal','2026-10-11','old bank','a',20,'branch-a');
          INSERT INTO journal_entries(journal_id,account_id,type,amount)
           VALUES('legacy-journal',1,'debit',20),('legacy-journal',2,'credit',20);
        "#).await.unwrap();
        let before = (
            count(&mut db, "notices").await,
            count(&mut db, "journal").await,
            count(&mut db, "entries").await,
            count(&mut db, "patient").await,
        );
        let attempt =
            post_with_lock(&mut db, "a", notice("customer", "after-old-bank", "debit")).await;
        assert!(
            attempt
                .as_ref()
                .is_err_and(|e| e.contains("unverified legacy bank")),
            "Historic bank source has no inspectable journal ID: {attempt:?}"
        );
        assert_eq!(
            before,
            (
                count(&mut db, "notices").await,
                count(&mut db, "journal").await,
                count(&mut db, "entries").await,
                count(&mut db, "patient").await
            )
        );
    }
    #[tokio::test]
    async fn prospective_051_notice_journal_is_linked_and_cannot_be_rewritten() {
        let mut db = fixture().await;
        let posted = post_with_lock(
            &mut db,
            "a",
            notice("customer", "notice-source-051", "credit"),
        )
        .await
        .unwrap();
        let source_findings = sqlx::query(
            super::super::financial_source_reconciliation_native::NATIVE_PATIENT_FINANCIAL_JOURNAL_STRUCTURE,
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert!(source_findings.is_empty(), "real native 051 notice must reconcile to its patient mirror and journal");
        let journal:String=sqlx::query_scalar(
            "SELECT journal_id FROM native_patient_financial_journal_receipts WHERE source_kind='notice' AND source_id=?")
            .bind(&posted.id).fetch_one(&mut db).await.unwrap();
        let cents: i64 = sqlx::query_scalar(
            "SELECT amount_cents FROM native_patient_financial_journal_receipts WHERE journal_id=?",
        )
        .bind(&journal)
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(cents, 1250);
        for sql in [
            format!("UPDATE financial_notices SET amount=900 WHERE id='{}'",posted.id),
            format!("UPDATE financial_notice_native_scope SET pharmacy_id='branch-b' WHERE notice_id='{}'",posted.id),
            format!("UPDATE daily_journals SET total_amount=900 WHERE id='{journal}'"),
            format!("DELETE FROM journal_entries WHERE journal_id='{journal}'"),
            format!("DELETE FROM native_patient_financial_journal_receipts WHERE source_id='{}'",posted.id),
        ] {
            assert!(sqlx::query(&sql).execute(&mut db).await.is_err(),"051 notice mutation succeeded: {sql}");
        }
        assert!(post_with_lock(
            &mut db,
            "a",
            notice("customer", "notice-source-051", "credit")
        )
        .await
        .is_err());
        assert_eq!(count(&mut db, "notices").await, 1);
        assert_eq!(count(&mut db, "entries").await, 2);
        assert!(post_with_lock(
            &mut db,
            "a",
            notice("customer", "second-notice-051", "debit")
        )
        .await
        .is_ok());
    }
    #[tokio::test]
    async fn v1_unchained_patient_notice_does_not_authorize_further_adjustment() {
        let mut db = fixture().await;
        db.execute(r#"
          INSERT INTO financial_notices(id,user_id,target_type,target_id,type,amount,date,pharmacy_id)
           VALUES('historic-v1','a','customer','p','debit',30,'2026-10-11','branch-a');
          INSERT INTO patient_transactions VALUES('historic-adjust','p','a','adjustment',30,'cash','historic','2026-10-11');
          INSERT INTO financial_notice_native_scope VALUES('historic-v1','branch-a','historic-nonce','historic-adjust');
        "#).await.unwrap();
        let attempt = post_with_lock(
            &mut db,
            "a",
            notice("customer", "subsequent-v1-notice", "debit"),
        )
        .await;
        assert!(
            attempt
                .as_ref()
                .is_err_and(|e| e.contains("unverified legacy notice")),
            "A V1 patient notice without a journal link made a second adjustment: {attempt:?}"
        );
        assert_eq!(count(&mut db, "journal").await, 0);
        assert_eq!(count(&mut db, "notices").await, 1);
    }
    #[tokio::test]
    async fn customer_notice_rejects_historical_refund_header_understating_lines() {
        let mut db = fixture().await;
        db.execute("INSERT INTO returns VALUES('refund','a-sale','patient_account','completed','branch-a',15)")
            .await.unwrap();
        db.execute("INSERT INTO native_sale_return_cogs_provenance VALUES('refund','a-sale','branch-a','patient_account',15000000,'a')")
            .await.unwrap();
        db.execute("INSERT INTO return_items VALUES(1,'refund',80)")
            .await
            .unwrap();
        let forged =
            post_with_lock(&mut db, "a", notice("customer", "wrong-refund", "debit")).await;
        assert!(
            forged
                .as_ref()
                .is_err_and(|e| e.contains("historical refund amounts")),
            "Contradictory finalized patient refund admitted a new notice: {forged:?}"
        );
        assert_eq!(count(&mut db, "notices").await, 0);
        assert_eq!(count(&mut db, "journal").await, 0);
        assert_eq!(count(&mut db, "entries").await, 0);
        db.execute("UPDATE return_items SET total_price=15 WHERE return_id='refund'")
            .await
            .unwrap();
        post_with_lock(&mut db, "a", notice("customer", "valid-refund", "debit"))
            .await
            .unwrap();
        assert_eq!(count(&mut db, "notices").await, 1);
    }

    #[tokio::test]
    async fn native_receipted_patient_refund_allows_notice_but_unlinked_mirror_does_not() {
        let mut db = fixture().await;
        db.execute("INSERT INTO returns VALUES('refund','a-sale','patient_account','completed','branch-a',15)")
            .await.unwrap();
        db.execute("INSERT INTO native_sale_return_cogs_provenance VALUES('refund','a-sale','branch-a','patient_account',15000000,'a')")
            .await.unwrap();
        db.execute("INSERT INTO return_items VALUES(1,'refund',15)")
            .await.unwrap();
        db.execute("INSERT INTO patient_transactions VALUES('refund','p','a','refund',15,'patient_account','native-return','2026-10-11')")
            .await.unwrap();
        post_with_lock(&mut db, "a", notice("customer", "after-native-refund", "debit"))
            .await.expect("An authentic 043 return must not block its patient's financial notice");
        assert_eq!(count(&mut db, "notices").await, 1);

        let mut missing = fixture().await;
        missing.execute("INSERT INTO patient_transactions VALUES('unbound','p','a','refund',15,'patient_account','legacy-unbound','2026-10-11')")
            .await.unwrap();
        assert!(post_with_lock(&mut missing, "a", notice("customer", "unbound-refund", "debit"))
            .await.unwrap_err().contains("Ambiguous legacy patient"));
        assert_eq!(count(&mut missing, "notices").await, 0);
    }
    #[tokio::test]
    async fn configured_notice_accounts_cannot_redirect_canonical_posting() {
        for (category, account_id, target_type) in [
            ("accounts_receivable", 1, "customer"),
            ("customer_adjustments", 1, "customer"),
            ("customer_adjustments", 2, "pharmacy"),
        ] {
            let mut db = fixture().await;
            sqlx::query("UPDATE trial_balance_settings SET account_id=? WHERE category=?")
                .bind(account_id)
                .bind(category)
                .execute(&mut db)
                .await
                .unwrap();
            let result =
                post_with_lock(&mut db, "a", notice(target_type, "unsafe-mapping", "debit")).await;
            assert!(
                result
                    .as_ref()
                    .is_err_and(|e| e.contains("account mapping")),
                "unsafe {category} redirected a native notice: {result:?}"
            );
            assert_eq!(count(&mut db, "notices").await, 0);
            assert_eq!(count(&mut db, "journal").await, 0);
            assert_eq!(count(&mut db, "entries").await, 0);
        }
    }
    #[tokio::test]
    async fn wrong_branch_legacy_supplier_disabled_and_reassigned_actor_reject_without_writes() {
        let mut db = fixture().await;
        for actor in ["b", "disabled", "denied", "missing"] {
            assert!(
                post_with_lock(&mut db, actor, notice("customer", actor, "debit"))
                    .await
                    .is_err()
            );
            if actor != "b" {
                assert!(read_with_scope(&mut db, actor, 0).await.is_err());
            }
        }
        for (patient, nonce) in [
            ("shared", "shared"),
            ("opening", "opening"),
            ("legacy", "legacy"),
        ] {
            let mut value = notice("customer", nonce, "credit");
            value.target_id = Some(patient.into());
            assert!(post_with_lock(&mut db, "a", value).await.is_err());
        }
        let mut supplier = notice("supplier", "supplier", "debit");
        supplier.target_id = Some("1".into());
        assert!(post_with_lock(&mut db, "a", supplier).await.is_err());
        db.execute("UPDATE users SET role='cashier',permissions='{}' WHERE id='a'")
            .await
            .unwrap();
        assert!(
            post_with_lock(&mut db, "a", notice("pharmacy", "role-change", "debit"))
                .await
                .is_err()
        );
        assert_eq!(count(&mut db, "notices").await, 0);
        assert_eq!(count(&mut db, "journal").await, 0);
        assert_eq!(count(&mut db, "scope").await, 0);
        let global: f64 = sqlx::query_scalar("SELECT balance FROM suppliers WHERE id=1")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(global, 5.0);
    }
    #[tokio::test]
    async fn notice_invalid_dto_legacy_read_and_audit_ledger_failures_roll_back() {
        let mut db = fixture().await;
        let mut forged = serde_json::json!({"targetType":"pharmacy","noticeType":"credit",
            "amount":12.5,"reason":"valid","date":"2026-10-11","requestId":"f"});
        for claim in ["pharmacyId", "userId", "role", "sql", "accountId"] {
            forged[claim] = serde_json::json!("evil");
            assert!(serde_json::from_value::<NoticeInput>(forged.clone()).is_err());
            forged.as_object_mut().unwrap().remove(claim);
        }
        for invalid in [f64::NAN, f64::INFINITY, 0.0, 12.501] {
            let mut x = notice("pharmacy", "bad", "debit");
            x.amount = invalid;
            assert!(post_with_lock(&mut db, "a", x).await.is_err());
        }
        let mut x = notice("pharmacy", "bad-date", "debit");
        x.date = "2026-02-30".into();
        assert!(post_with_lock(&mut db, "a", x).await.is_err());
        db.execute(
            "CREATE TRIGGER block_credit BEFORE INSERT ON journal_entries
          WHEN NEW.type='credit' BEGIN SELECT RAISE(ABORT,'synthetic ledger failure'); END",
        )
        .await
        .unwrap();
        assert!(
            post_with_lock(&mut db, "a", notice("customer", "credit-failure", "debit"))
                .await
                .is_err()
        );
        for table in ["notices", "scope", "journal", "entries", "activity"] {
            assert_eq!(count(&mut db, table).await, 0, "{table}");
        }
        assert_eq!(count(&mut db, "patient").await, 1);
        db.execute("DROP TRIGGER block_credit").await.unwrap();
        db.execute("INSERT INTO financial_notices(id,user_id,target_type,target_id,type,amount,reason,date,pharmacy_id)
          VALUES('unscoped','a','customer','p','debit',2,'old','2026-10-11','branch-a')").await.unwrap();
        assert!(read_with_scope(&mut db, "a", 0)
            .await
            .unwrap_err()
            .contains("Legacy"));
        assert!(
            post_with_lock(&mut db, "a", notice("customer", "ambiguous", "debit"))
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn pharmacy_notice_posts_real_shift_cash_movement_matching_051_journal() {
        let mut db = fixture().await;
        let posted = post_with_lock(&mut db, "a", notice("pharmacy", "drawer-notice", "debit"))
            .await.expect("An active owner with an open same-pharmacy drawer may post a notice");
        let cash: f64 = sqlx::query_scalar(
            "SELECT CAST(COALESCE(SUM(CASE WHEN type IN ('receipt','in') THEN amount
                 WHEN type IN ('disbursement','out') THEN -amount ELSE 0 END),0) AS REAL)
             FROM cash_movements WHERE shift_id='a-shift' AND pharmacy_id='branch-a'
               AND source_type='financial_notice' AND target_name=?",
        ).bind(&posted.id).fetch_one(&mut db).await.unwrap();
        assert!((cash - 12.5).abs() < 0.000001,
            "051 notice journal increased physical cash but shift ledger missed it: {cash}");
        let journal_debit: f64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(e.amount),0) FROM native_patient_financial_journal_receipts r
             JOIN journal_entries e ON e.journal_id=r.journal_id
             WHERE r.source_kind='notice' AND r.source_id=? AND e.type='debit'",
        ).bind(&posted.id).fetch_one(&mut db).await.unwrap();
        assert!((journal_debit - cash).abs() < 0.000001);
        assert_eq!(count(&mut db, "scope").await, 1);
        let contradictions = sqlx::query(
            super::super::financial_source_reconciliation_native::NATIVE_PATIENT_FINANCIAL_JOURNAL_STRUCTURE,
        ).fetch_all(&mut db).await.unwrap();
        assert!(contradictions.is_empty(), "real 051 pharmacy notice must reconcile its journal");
    }

    #[tokio::test]
    async fn prospective_notice_cash_movement_is_sealed_after_shift_closure() {
        let mut db = fixture().await;
        let posted = post_with_lock(&mut db, "a", notice("pharmacy", "sealed-cash-056", "debit"))
            .await.unwrap();
        let cash_id: String = sqlx::query_scalar(
            "SELECT id FROM cash_movements WHERE source_type='financial_notice' AND target_name=?",
        ).bind(&posted.id).fetch_one(&mut db).await.unwrap();
        db.execute("UPDATE shifts SET status='closed' WHERE id='a-shift'")
            .await.unwrap();
        let tamper = sqlx::query("UPDATE cash_movements SET amount=99 WHERE id=?")
            .bind(&cash_id).execute(&mut db).await;
        assert!(tamper.is_err(), "Receipted pharmacy notice cash changed after shift closure: {tamper:?}");
        let original: f64 = sqlx::query_scalar("SELECT amount FROM cash_movements WHERE id=?")
            .bind(&cash_id).fetch_one(&mut db).await.unwrap();
        assert_eq!(original, 12.5);
    }

    #[tokio::test]
    async fn prospective_056_notice_debit_credit_have_distinct_exact_cash_witnesses() {
        let mut db = fixture().await;
        for (kind, movement_type, nonce) in [
            ("debit", "receipt", "notice-056-debit"),
            ("credit", "disbursement", "notice-056-credit"),
        ] {
            let posted = post_with_lock(&mut db, "a", notice("pharmacy", nonce, kind))
                .await.unwrap();
            let row = sqlx::query(
                "SELECT w.cash_movement_id,w.journal_id,w.amount_cents,m.type,m.shift_id,
                        m.source_type,m.target_name,m.pharmacy_id,m.user_id
                 FROM native_financial_notice_cash_witnesses w
                 JOIN cash_movements m ON m.id=w.cash_movement_id
                 WHERE w.notice_id=?",
            ).bind(&posted.id).fetch_one(&mut db).await.unwrap();
            assert_eq!(row.get::<i64,_>("amount_cents"),1250);
            assert_eq!(row.get::<String,_>("type"),movement_type);
            assert_eq!(row.get::<String,_>("shift_id"),"a-shift");
            assert_eq!(row.get::<String,_>("source_type"),"financial_notice");
            assert_eq!(row.get::<String,_>("target_name"),posted.id);
            assert_eq!(row.get::<String,_>("pharmacy_id"),"branch-a");
            assert_eq!(row.get::<String,_>("user_id"),"a");
            let journal: String = sqlx::query_scalar(
                "SELECT journal_id FROM native_patient_financial_journal_receipts
                 WHERE source_kind='notice' AND source_id=?",
            ).bind(&posted.id).fetch_one(&mut db).await.unwrap();
            assert_eq!(row.get::<String,_>("journal_id"),journal);
        }
        let count: i64=sqlx::query_scalar(
            "SELECT COUNT(DISTINCT cash_movement_id) FROM native_financial_notice_cash_witnesses",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(count,2);
    }

    #[tokio::test]
    async fn prospective_056_witness_failure_rolls_back_every_notice_money_row() {
        let mut db = fixture().await;
        db.execute("CREATE TRIGGER synthetic_block_056 BEFORE INSERT ON native_financial_notice_cash_witnesses
           BEGIN SELECT RAISE(ABORT,'synthetic 056 witness fault'); END;")
            .await.unwrap();
        let failed=post_with_lock(&mut db,"a",notice("pharmacy","notice-056-rollback","debit")).await;
        assert!(failed.as_ref().is_err_and(|e|e.contains("synthetic 056 witness fault")),
            "A missing exact 056 witness committed notice cash: {failed:?}");
        for table in ["notices","scope","journal","entries","activity","cash"] {
            assert_eq!(count(&mut db,table).await,0,"{table} escaped witness rollback");
        }
        let witnesses: i64=sqlx::query_scalar(
            "SELECT COUNT(*) FROM native_financial_notice_cash_witnesses",
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(witnesses,0);
    }

    #[tokio::test]
    async fn pharmacy_cash_notices_reject_ambiguous_shift_and_roll_back_cash_writer_failure() {
        let mut db = fixture().await;
        db.execute("UPDATE shifts SET status='closed' WHERE id='a-shift'")
            .await.unwrap();
        let no_shift = post_with_lock(&mut db, "a", notice("pharmacy", "no-shift", "debit")).await;
        assert!(no_shift.as_ref().is_err_and(|e| e.contains("exactly one open owned shift")));
        db.execute("UPDATE shifts SET status='open' WHERE id='a-shift'")
            .await.unwrap();
        db.execute("INSERT INTO shifts VALUES('duplicate-shift','branch-a','open',0)")
            .await.unwrap();
        let multiple = post_with_lock(&mut db, "a", notice("pharmacy", "two-shifts", "credit")).await;
        assert!(multiple.as_ref().is_err_and(|e| e.contains("exactly one open owned shift")));
        db.execute("DELETE FROM shifts WHERE id='duplicate-shift'").await.unwrap();
        for table in ["notices", "scope", "journal", "entries", "activity", "cash"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} mutated on rejected shift");
        }
        db.execute("CREATE TRIGGER refuse_finance_cash BEFORE INSERT ON cash_movements
            WHEN NEW.source_type='financial_notice'
            BEGIN SELECT RAISE(ABORT,'synthetic cash failure'); END;")
            .await.unwrap();
        let failed = post_with_lock(&mut db, "a", notice("pharmacy", "cash-writer-failure", "debit")).await;
        assert!(failed.as_ref().is_err_and(|e| e.contains("synthetic cash failure")),
            "Synthetic cash writer failure did not abort the full 051 journal: {failed:?}");
        for table in ["notices", "scope", "journal", "entries", "activity", "cash"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} mutated on writer rollback");
        }
        db.execute("DROP TRIGGER refuse_finance_cash").await.unwrap();
        let credit = post_with_lock(&mut db, "a", notice("pharmacy", "valid-cash-credit", "credit"))
            .await.unwrap();
        let signed: f64 = sqlx::query_scalar(
            "SELECT CAST(SUM(CASE WHEN type='receipt' THEN amount ELSE -amount END) AS REAL)
             FROM cash_movements WHERE source_type='financial_notice' AND target_name=?
               AND shift_id='a-shift' AND pharmacy_id='branch-a'",
        ).bind(&credit.id).fetch_one(&mut db).await.unwrap();
        assert!((signed + 12.5).abs() < 0.000001);
        assert_eq!(count(&mut db, "scope").await, 1);
        assert_eq!(count(&mut db, "entries").await, 2);
        assert!(post_with_lock(&mut db, "a", notice("pharmacy", "valid-cash-credit", "credit"))
            .await.is_err());
        assert_eq!(count(&mut db, "cash").await, 1);
    }

    #[tokio::test]
    async fn nonce_replay_serializes_across_two_writers_in_disposable_file() {
        let mut path = std::env::temp_dir();
        path.push(format!("pharma-native-notice-{}.sqlite", Uuid::new_v4()));
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(8));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(opts)
            .await
            .unwrap();
        let mut seed_conn = pool.acquire().await.unwrap();
        seed(&mut seed_conn).await;
        drop(seed_conn);
        let (p1, p2) = (pool.clone(), pool.clone());
        let (first, second) = tokio::join!(
            async move {
                let mut c = p1.acquire().await.unwrap();
                post_with_lock(&mut c, "a", notice("pharmacy", "race", "debit")).await
            },
            async move {
                let mut c = p2.acquire().await.unwrap();
                post_with_lock(&mut c, "a", notice("pharmacy", "race", "debit")).await
            }
        );
        assert_ne!(first.is_ok(), second.is_ok());
        let mut c = pool.acquire().await.unwrap();
        assert_eq!(count(&mut c, "scope").await, 1);
        assert_eq!(count(&mut c, "entries").await, 2);
        drop(c);
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
