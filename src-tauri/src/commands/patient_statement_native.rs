//! Authenticated, read-only, strictly bounded 061-owned patient statement.
//! This is a *verified source subset*, not an accounts-receivable statement:
//! 051/055 patient payments and financial notices cannot yet be displayed
//! exhaustively by this command. Never manufacture opening/running balances.
use serde::Serialize;
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::{borrow::Cow, collections::HashMap};
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

const LIMIT: usize = 200;

#[derive(Debug, Serialize)]
pub struct StatementPatient {
    id: String,
    full_name: String,
    opening_balance: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct StatementMovement {
    r#type: &'static str,
    doc_no: String,
    date: String,
    value: f64,
    balance_effect: Option<f64>,
    payment_method: String,
    notes: Option<String>,
    user_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PatientStatement {
    patient: StatementPatient,
    movements: Vec<StatementMovement>,
    items: Vec<serde_json::Value>,
    notices: Vec<serde_json::Value>,
    #[serde(rename = "currentBalance")]
    current_balance: Option<f64>,
    unsupported_categories: Vec<&'static str>,
    scope: &'static str,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn money(amount: f64) -> Result<f64, String> {
    if !amount.is_finite()
        || !(0.0..=1_000_000_000_000.0).contains(&amount)
        || (amount * 100.0 - (amount * 100.0).round()).abs() > 0.00001
    {
        return Err("Patient statement source amount is invalid".into());
    }
    Ok(amount)
}

fn date(value: &str) -> Result<String, String> {
    if value.is_empty() || value.len() > 40 || value.chars().any(|c| c.is_control()) {
        return Err("Patient statement has unverified event date".into());
    }
    Ok(value.to_owned())
}

async fn statement(
    conn: &mut SqliteConnection,
    actor: &str,
    patient_id: &str,
) -> Result<PatientStatement, String> {
    if !valid_id(patient_id) {
        return Err("Invalid patient statement identity".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> = Transaction::begin(conn, Some(Cow::Borrowed("BEGIN")))
        .await
        .map_err(|e| e.to_string())?;
    let result: Result<PatientStatement, String> = async {
        let conn = &mut *tx;
        let (role, pharmacy) = active_generic_actor(conn, actor).await?;
        if pharmacy == "local_default" || pharmacy.trim().is_empty() {
            return Err("Patient statement requires explicit pharmacy ownership".into());
        }
        let permissions: Option<String> = sqlx::query_scalar(
            "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
        ).bind(actor).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
        if !["can_view_patients", "can_access_pos"].iter().any(|p|
            user_has_permission(Some(&role), permissions.as_deref(), p, *p == "can_access_pos")) {
            return Err("Patient statement permission denied".into());
        }
        let patient = sqlx::query(
            "SELECT p.id,p.full_name FROM main.patients p
             JOIN main.native_patient_directory_ownership own ON own.patient_id=p.id
             WHERE p.id=? AND own.pharmacy_id=? AND own.pharmacy_id<>'local_default'
               AND LENGTH(own.intent_sha256)=64 LIMIT 1",
        ).bind(patient_id).bind(&pharmacy)
         .fetch_optional(&mut *conn).await.map_err(|e| e.to_string())?
         .ok_or("Patient 061 tenant ownership is not verified")?;
        let full_name: String = patient.try_get("full_name").map_err(|e| e.to_string())?;
        if full_name.trim().is_empty() { return Err("Patient name is invalid".into()); }

        // Account payments/notices have distinct 051/055 receipts and may
        // affect outstanding debt. This first projection refuses those
        // histories rather than omitting money-bearing activity silently.
        let unsupported: i64 = sqlx::query_scalar(
            "SELECT (SELECT COUNT(*) FROM main.patient_transactions WHERE patient_id=?)
                  + (SELECT COUNT(*) FROM main.financial_notices
                       WHERE target_type='customer' AND target_id=?)",
        ).bind(patient_id).bind(patient_id).fetch_one(&mut *conn)
         .await.map_err(|e| e.to_string())?;
        if unsupported > 0 {
            return Err("Patient credit payments/notices require separately verified statement projection".into());
        }
        // Every invoice and return linked to this patient is checked before
        // any row is displayed, even when an older draft contributes no money.
        let sales = sqlx::query(
            "SELECT si.id,si.pharmacy_id,si.status,si.payment_method,si.total_amount,
                    si.created_at, si.user_id, p.sale_id AS witnessed_id,
                    p.sale_micros,p.pharmacy_id AS witnessed_owner,
                    p.payment_method AS witnessed_method,p.actor_id AS witnessed_actor,
                    j.id AS witnessed_journal,j.pharmacy_id AS journal_owner
             FROM main.sales_invoices si
             LEFT JOIN main.native_sale_cogs_provenance p ON p.sale_id=si.id
             LEFT JOIN main.daily_journals j ON j.id=p.journal_id
             WHERE si.patient_id=? ORDER BY si.created_at,si.id LIMIT 202",
        ).bind(patient_id).fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
        if sales.len()>LIMIT { return Err("Patient sales statement exceeds bounded capacity".into()); }
        let mut movements = Vec::new();
        let mut invoice_totals = HashMap::new();
        for row in sales {
            let id: String = row.try_get("id").map_err(|e| e.to_string())?;
            let tenant: Option<String> = row.try_get("pharmacy_id").map_err(|e| e.to_string())?;
            if tenant.as_deref()!=Some(&pharmacy) {
                return Err("Foreign or legacy patient sale source".into());
            }
            let status: Option<String> = row.try_get("status").map_err(|e| e.to_string())?;
            if status.as_deref()!=Some("completed") {
                if !matches!(status.as_deref(),Some("draft")|Some("suspended")) {
                    return Err("Unverified patient sale status".into());
                }
                continue;
            }
            let raw: Option<f64> = row.try_get("total_amount").map_err(|e| e.to_string())?;
            let amount = money(raw.ok_or("Missing patient sale amount")?)?;
            let method: String = row.try_get("payment_method").map_err(|e| e.to_string())?;
            let actor_id: String = row.try_get("user_id").map_err(|e| e.to_string())?;
            let witness: Option<String> = row.try_get("witnessed_id").map_err(|e| e.to_string())?;
            let micros: Option<i64> = row.try_get("sale_micros").map_err(|e| e.to_string())?;
            let owner: Option<String> = row.try_get("witnessed_owner").map_err(|e| e.to_string())?;
            let wm: Option<String> = row.try_get("witnessed_method").map_err(|e| e.to_string())?;
            let wa: Option<String> = row.try_get("witnessed_actor").map_err(|e| e.to_string())?;
            let journal: Option<String> = row.try_get("witnessed_journal").map_err(|e| e.to_string())?;
            let jo: Option<String> = row.try_get("journal_owner").map_err(|e| e.to_string())?;
            if witness.as_deref()!=Some(&id) || owner.as_deref()!=Some(&pharmacy) ||
               wm.as_deref()!=Some(&method) || wa.as_deref()!=Some(&actor_id) ||
               journal.is_none() || jo.as_deref()!=Some(&pharmacy) ||
               micros.map_or(true,|v| (amount * 1_000_000.0-v as f64).abs()>2.0) {
                return Err("Unreceipted or corrupted native patient sale".into());
            }
            let occurred: String = row.try_get("created_at").map_err(|e| e.to_string())?;
            invoice_totals.insert(id.clone(),amount);
            movements.push(StatementMovement{r#type:"فاتورة بيع",doc_no:id,date:date(&occurred)?,
                value:amount,balance_effect:None,payment_method:method,notes:None,user_name:None});
        }

        let returns = sqlx::query(
            "SELECT r.id,r.invoice_id,r.pharmacy_id,r.status,r.refund_method,r.total_refund,
                    r.created_at,r.user_id,si.pharmacy_id AS sale_owner,
                    p.return_id AS witnessed_id,p.sale_id AS witnessed_sale,
                    p.pharmacy_id AS witnessed_owner,p.refund_method AS witnessed_method,
                    p.refund_micros,p.actor_id AS witnessed_actor,
                    j.id AS witnessed_journal,j.pharmacy_id AS journal_owner
             FROM main.returns r JOIN main.sales_invoices si ON si.id=r.invoice_id
             LEFT JOIN main.native_sale_return_cogs_provenance p ON p.return_id=r.id
             LEFT JOIN main.daily_journals j ON j.id=p.journal_id
             WHERE si.patient_id=? ORDER BY r.created_at,r.id LIMIT 202",
        ).bind(patient_id).fetch_all(&mut *conn).await.map_err(|e| e.to_string())?;
        if returns.len()>LIMIT { return Err("Patient return statement exceeds bounded capacity".into()); }
        let mut refunds: HashMap<String,f64> = HashMap::new();
        for row in returns {
            let id: String = row.try_get("id").map_err(|e| e.to_string())?;
            let invoice: String = row.try_get("invoice_id").map_err(|e| e.to_string())?;
            let owner: Option<String> = row.try_get("pharmacy_id").map_err(|e| e.to_string())?;
            let sale_owner: Option<String> = row.try_get("sale_owner").map_err(|e| e.to_string())?;
            if owner.as_deref()!=Some(&pharmacy) || sale_owner.as_deref()!=Some(&pharmacy) {
                return Err("Foreign or unowned patient return".into());
            }
            let status: Option<String> = row.try_get("status").map_err(|e| e.to_string())?;
            if !matches!(status.as_deref(),Some("approved")|Some("completed")) {
                if !matches!(status.as_deref(),Some("pending")|Some("rejected")) {
                    return Err("Unverified patient return status".into());
                }
                continue;
            }
            let original = invoice_totals.get(&invoice).copied()
                .ok_or("Patient return references unverified completed invoice")?;
            let amount: f64 = money(row.try_get::<Option<f64>,_>("total_refund")
                .map_err(|e|e.to_string())?.ok_or("Missing refund")?)?;
            let method: String = row.try_get("refund_method").map_err(|e|e.to_string())?;
            let actor: String = row.try_get("user_id").map_err(|e|e.to_string())?;
            let witnessed: Option<String> = row.try_get("witnessed_id").map_err(|e|e.to_string())?;
            let ws: Option<String> = row.try_get("witnessed_sale").map_err(|e|e.to_string())?;
            let wo: Option<String> = row.try_get("witnessed_owner").map_err(|e|e.to_string())?;
            let wm: Option<String> = row.try_get("witnessed_method").map_err(|e|e.to_string())?;
            let wa: Option<String> = row.try_get("witnessed_actor").map_err(|e|e.to_string())?;
            let micros: Option<i64> = row.try_get("refund_micros").map_err(|e|e.to_string())?;
            let journal: Option<String> = row.try_get("witnessed_journal").map_err(|e|e.to_string())?;
            let jo: Option<String> = row.try_get("journal_owner").map_err(|e|e.to_string())?;
            if witnessed.as_deref()!=Some(&id) || ws.as_deref()!=Some(&invoice) ||
                wo.as_deref()!=Some(&pharmacy) || wm.as_deref()!=Some(&method) ||
                wa.as_deref()!=Some(&actor) || journal.is_none() || jo.as_deref()!=Some(&pharmacy) ||
                micros.map_or(true,|v| (amount*1_000_000.0-v as f64).abs()>2.0) {
                return Err("Unreceipted or corrupted patient sales return".into());
            }
            let sum = refunds.get(&invoice).copied().unwrap_or(0.0)+amount;
            if !sum.is_finite() || sum-original>0.000001 {
                return Err("Patient return amounts exceed verified invoice".into());
            }
            refunds.insert(invoice,sum);
            let occurred: String = row.try_get("created_at").map_err(|e|e.to_string())?;
            movements.push(StatementMovement {r#type:"مرتجع بيع",doc_no:id,date:date(&occurred)?,
                value:-amount,balance_effect:None,payment_method:method,notes:None,user_name:None});
        }

        // Read-only 060 wallet receipts. Verify their exact cash, shift and
        // balanced journal witness again: a UUID alone is not provenance.
        let wallet = sqlx::query(
            "SELECT r.request_id,r.patient_id,r.pharmacy_id,r.actor_id,r.amount_cents,
                    r.created_at,cm.id AS movement_id,cm.pharmacy_id AS cash_owner,
                    cm.user_id AS cash_actor,cm.type AS cash_type,cm.source_type,
                    cm.category,cm.target_name,cm.amount AS cash_amount,
                    sh.pharmacy_id AS shift_owner,j.id AS journal_id,
                    j.pharmacy_id AS journal_owner,j.created_by,j.total_amount,
                    (SELECT COUNT(*) FROM main.journal_entries e WHERE e.journal_id=r.journal_id) entry_count,
                    (SELECT COUNT(*) FROM main.journal_entries e JOIN main.accounts a ON a.id=e.account_id
                     WHERE e.journal_id=r.journal_id AND a.code='1.1.1' AND e.type='debit'
                       AND ABS(e.amount*100-r.amount_cents)<0.00001) cash_debits,
                    (SELECT COUNT(*) FROM main.journal_entries e JOIN main.accounts a ON a.id=e.account_id
                     WHERE e.journal_id=r.journal_id AND a.code='2.2' AND e.type='credit'
                       AND ABS(e.amount*100-r.amount_cents)<0.00001) wallet_credits
             FROM main.native_patient_wallet_topup_receipts r
             LEFT JOIN main.cash_movements cm ON cm.id=r.cash_movement_id
             LEFT JOIN main.shifts sh ON sh.id=r.shift_id AND sh.id=cm.shift_id
             LEFT JOIN main.daily_journals j ON j.id=r.journal_id
             WHERE r.patient_id=? ORDER BY r.created_at,r.request_id LIMIT 202",
        ).bind(patient_id).fetch_all(&mut *conn).await.map_err(|e|e.to_string())?;
        if wallet.len()>LIMIT { return Err("Patient wallet statement exceeds bounded capacity".into()); }
        for row in wallet {
            let id: String = row.try_get("request_id").map_err(|e|e.to_string())?;
            let owned: String = row.try_get("pharmacy_id").map_err(|e|e.to_string())?;
            let actor: String = row.try_get("actor_id").map_err(|e|e.to_string())?;
            let cents: i64 = row.try_get("amount_cents").map_err(|e|e.to_string())?;
            let cash: Option<f64> = row.try_get("cash_amount").map_err(|e|e.to_string())?;
            let j_amount: Option<f64> = row.try_get("total_amount").map_err(|e|e.to_string())?;
            let movement: Option<String> = row.try_get("movement_id").map_err(|e|e.to_string())?;
            let journal: Option<String> = row.try_get("journal_id").map_err(|e|e.to_string())?;
            let cash_owner: Option<String> = row.try_get("cash_owner").map_err(|e|e.to_string())?;
            let shift_owner: Option<String> = row.try_get("shift_owner").map_err(|e|e.to_string())?;
            let j_owner: Option<String> = row.try_get("journal_owner").map_err(|e|e.to_string())?;
            let cash_actor: Option<String> = row.try_get("cash_actor").map_err(|e|e.to_string())?;
            let created_by: Option<String> = row.try_get("created_by").map_err(|e|e.to_string())?;
            let cash_type: Option<String> = row.try_get("cash_type").map_err(|e|e.to_string())?;
            let source: Option<String> = row.try_get("source_type").map_err(|e|e.to_string())?;
            let category: Option<String> = row.try_get("category").map_err(|e|e.to_string())?;
            let target: Option<String> = row.try_get("target_name").map_err(|e|e.to_string())?;
            let entries: i64 = row.try_get("entry_count").map_err(|e|e.to_string())?;
            let debits: i64 = row.try_get("cash_debits").map_err(|e|e.to_string())?;
            let credits: i64 = row.try_get("wallet_credits").map_err(|e|e.to_string())?;
            if owned!=pharmacy || cents<=0 || movement.is_none() || journal.is_none() ||
               cash_owner.as_deref()!=Some(&pharmacy) || shift_owner.as_deref()!=Some(&pharmacy) ||
               j_owner.as_deref()!=Some(&pharmacy) || cash_actor.as_deref()!=Some(&actor) ||
               created_by.as_deref()!=Some(&actor) || cash_type.as_deref()!=Some("receipt") ||
               source.as_deref()!=Some("patient_wallet") || category.as_deref()!=Some("patient_wallet") ||
               target.as_deref()!=Some(patient_id) || entries!=2 || debits!=1 || credits!=1 ||
               cash.map_or(true,|v| (v*100.0-cents as f64).abs()>0.00001) ||
               j_amount.map_or(true,|v| (v*100.0-cents as f64).abs()>0.00001) {
                return Err("Unverified patient wallet top-up financial witness".into());
            }
            let occurred: String = row.try_get("created_at").map_err(|e|e.to_string())?;
            movements.push(StatementMovement {r#type:"شحن محفظة",doc_no:id,date:date(&occurred)?,
                value:cents as f64 / 100.0,balance_effect:None,payment_method:"cash".into(),
                notes:None,user_name:None});
        }
        let orphan_wallet_cash: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.cash_movements cm
             WHERE cm.target_name=? AND cm.source_type='patient_wallet'
               AND NOT EXISTS (SELECT 1 FROM main.native_patient_wallet_topup_receipts r
                   WHERE r.cash_movement_id=cm.id AND r.patient_id=? AND r.pharmacy_id=?)",
        ).bind(patient_id).bind(patient_id).bind(&pharmacy)
         .fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        if orphan_wallet_cash>0 { return Err("Unreceipted patient wallet cash history".into()); }
        if movements.len()>LIMIT { return Err("Patient statement exceeds verified event limit".into()); }
        movements.sort_by(|a,b| b.date.cmp(&a.date).then_with(||b.doc_no.cmp(&a.doc_no)));
        Ok(PatientStatement {
            patient:StatementPatient {id:patient_id.into(),full_name,opening_balance:None},
            movements,items:Vec::new(),notices:Vec::new(),current_balance:None,
            unsupported_categories:vec!["مدفوعات المرضى والإشعارات المالية", "الأرصدة الافتتاحية والرصيد الجاري", "تفاصيل الأصناف"],
            scope:"verified_subset",
        })
    }.await;
    tx.rollback().await.map_err(|e| e.to_string())?;
    result
}

#[tauri::command]
pub async fn read_patient_statement_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    patient_id: String,
) -> Result<PatientStatement, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    statement(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        &patient_id,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
          CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,pharmacy_id TEXT,is_active INTEGER);
          INSERT INTO users VALUES
            ('owner-a','owner','{}','tenant-a',1),
            ('owner-b','owner','{}','tenant-b',1),
            ('denied-a','cashier','{"can_view_patients":false,"can_access_pos":false}','tenant-a',1),
            ('inactive-a','owner','{}','tenant-a',0),
            ('local','owner','{}','local_default',1);
          CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT);
          INSERT INTO patients VALUES('owned-a','Owned A'),('owned-b','Owned B'),('legacy','Legacy');
          CREATE TABLE native_patient_directory_ownership(patient_id TEXT PRIMARY KEY,pharmacy_id TEXT,actor_id TEXT,intent_sha256 TEXT);
          INSERT INTO native_patient_directory_ownership VALUES
            ('owned-a','tenant-a','owner-a','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
            ('owned-b','tenant-b','owner-b','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
          CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,patient_id TEXT,pharmacy_id TEXT,status TEXT,payment_method TEXT,total_amount REAL,created_at TEXT,user_id TEXT);
          INSERT INTO sales_invoices VALUES('sale-300','owned-a','tenant-a','completed','cash',300,'2026-10-17 08:00:00','owner-a');
          CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,pharmacy_id TEXT,status TEXT,refund_method TEXT,total_refund REAL,created_at TEXT,user_id TEXT);
          CREATE TABLE native_sale_cogs_provenance(sale_id TEXT PRIMARY KEY,sale_micros INTEGER,pharmacy_id TEXT,payment_method TEXT,actor_id TEXT,journal_id TEXT);
          INSERT INTO native_sale_cogs_provenance VALUES('sale-300',300000000,'tenant-a','cash','owner-a','sale-journal');
          CREATE TABLE native_sale_return_cogs_provenance(return_id TEXT PRIMARY KEY,sale_id TEXT,pharmacy_id TEXT,refund_method TEXT,refund_micros INTEGER,actor_id TEXT,journal_id TEXT);
          CREATE TABLE daily_journals(id TEXT PRIMARY KEY,pharmacy_id TEXT,created_by TEXT,total_amount REAL);
          INSERT INTO daily_journals VALUES('sale-journal','tenant-a','owner-a',300);
          CREATE TABLE patient_transactions(patient_id TEXT);
          CREATE TABLE financial_notices(target_type TEXT,target_id TEXT);
          CREATE TABLE native_patient_wallet_topup_receipts(request_id TEXT,patient_id TEXT,pharmacy_id TEXT,actor_id TEXT,amount_cents INTEGER,created_at TEXT,cash_movement_id TEXT,journal_id TEXT,shift_id TEXT);
          CREATE TABLE cash_movements(id TEXT PRIMARY KEY,pharmacy_id TEXT,user_id TEXT,type TEXT,source_type TEXT,category TEXT,target_name TEXT,amount REAL,shift_id TEXT);
          CREATE TABLE shifts(id TEXT PRIMARY KEY,pharmacy_id TEXT);
          CREATE TABLE journal_entries(id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
          CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT);
          INSERT INTO accounts VALUES(1,'1.1.1'),(2,'2.2');
        "#).execute(&mut conn).await.unwrap();
        conn
    }

    #[tokio::test]
    async fn certified_owned_patient_sales_returns_and_wallet_have_no_fabricated_credit_balance() {
        let mut db = fixture().await;
        sqlx::raw_sql(r#"
          INSERT INTO returns VALUES('return-150','sale-300','tenant-a','approved','cash',150,'2026-10-17 09:00:00','owner-a');
          INSERT INTO native_sale_return_cogs_provenance VALUES('return-150','sale-300','tenant-a','cash',150000000,'owner-a','return-journal');
          INSERT INTO daily_journals VALUES('return-journal','tenant-a','owner-a',150);
          INSERT INTO shifts VALUES('shift-a','tenant-a');
          INSERT INTO cash_movements VALUES('cash-topup','tenant-a','owner-a','receipt','patient_wallet','patient_wallet','owned-a',25,'shift-a');
          INSERT INTO daily_journals VALUES('wallet-journal','tenant-a','owner-a',25);
          INSERT INTO journal_entries VALUES(1,'wallet-journal',1,'debit',25),(2,'wallet-journal',2,'credit',25);
          INSERT INTO native_patient_wallet_topup_receipts VALUES('topup-25','owned-a','tenant-a','owner-a',2500,'2026-10-17 10:00:00','cash-topup','wallet-journal','shift-a');
        "#).execute(&mut db).await.unwrap();
        let report = statement(&mut db, "owner-a", "owned-a").await.unwrap();
        assert_eq!(report.scope, "verified_subset");
        assert!(report.current_balance.is_none());
        assert!(report.patient.opening_balance.is_none());
        assert_eq!(report.movements.len(), 3);
        assert!(report
            .movements
            .iter()
            .any(|m| m.r#type == "فاتورة بيع" && m.value == 300.0));
        assert!(report
            .movements
            .iter()
            .any(|m| m.r#type == "مرتجع بيع" && m.value == -150.0));
        assert!(report
            .movements
            .iter()
            .any(|m| m.r#type == "شحن محفظة" && m.value == 25.0));
        assert!(report
            .unsupported_categories
            .iter()
            .any(|s| s.contains("مدفوعات")));
    }

    #[tokio::test]
    async fn patient_statement_rejects_legacy_foreign_role_and_unreceipted_sources() {
        let mut db = fixture().await;
        for (actor, patient) in [
            ("owner-a", "owned-b"),
            ("owner-a", "legacy"),
            ("local", "owned-a"),
            ("denied-a", "owned-a"),
            ("inactive-a", "owned-a"),
        ] {
            assert!(
                statement(&mut db, actor, patient).await.is_err(),
                "{actor}:{patient}"
            );
        }
        sqlx::query("DELETE FROM native_sale_cogs_provenance WHERE sale_id='sale-300'")
            .execute(&mut db)
            .await
            .unwrap();
        assert!(statement(&mut db, "owner-a", "owned-a").await.is_err());
        sqlx::query("INSERT INTO native_sale_cogs_provenance VALUES('sale-300',300000000,'tenant-a','cash','owner-a','sale-journal')")
            .execute(&mut db).await.unwrap();
        sqlx::query("INSERT INTO patient_transactions VALUES('owned-a')")
            .execute(&mut db)
            .await
            .unwrap();
        assert!(statement(&mut db, "owner-a", "owned-a").await.is_err());
        sqlx::query("DELETE FROM patient_transactions")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("UPDATE sales_invoices SET pharmacy_id='tenant-b' WHERE id='sale-300'")
            .execute(&mut db)
            .await
            .unwrap();
        assert!(statement(&mut db, "owner-a", "owned-a").await.is_err());
    }
}
