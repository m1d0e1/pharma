//! Fixed native bank directory writes/reads.
//! Renderer-selected SQL, actors, pharmacies, posting account IDs and balances
//! on UPDATE are never accepted. Financial changes are atomic with audit.
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

const MAX_BALANCE: f64 = 1_000_000_000_000.0;
const MAX_SAFE_JS_ID: i64 = 9_007_199_254_740_991;
const BANK_PAGE_SIZE: i64 = 100;
const LAST_BANK_PAGE: u32 = 499;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBankInput {
    name_ar: String,
    name_en: Option<String>,
    account_number: Option<String>,
    branch: Option<String>,
    current_balance: Option<f64>,
    // A renderer retry must not create a second bank and opening journal.
    request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateBankInput {
    id: i64,
    name_ar: String,
    name_en: Option<String>,
    account_number: Option<String>,
    branch: Option<String>,
    // Deliberately NO current_balance: this command cannot adjust posted funds.
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BankIdInput {
    id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListBanksInput {
    page: u32,
}

#[derive(Debug, Serialize)]
pub struct BankCreated {
    id: i64,
}

#[derive(Debug, Serialize)]
pub struct BankRow {
    id: i64,
    name_ar: String,
    name_en: Option<String>,
    account_number: Option<String>,
    branch: Option<String>,
    current_balance: f64,
    pharmacy_id: Option<String>,
    created_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankPage {
    rows: Vec<BankRow>,
    has_more: bool,
    page: u32,
    actor_id: String,
    pharmacy_id: String,
}

fn valid_text(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn optional_text(value: &Option<String>, max_bytes: usize) -> Result<Option<String>, String> {
    match value {
        Some(raw) if raw.trim().is_empty() => Ok(None),
        Some(raw) if valid_text(raw, max_bytes) => Ok(Some(raw.trim().to_string())),
        Some(_) => Err("Invalid bank text field".into()),
        None => Ok(None),
    }
}

struct BankNames {
    name_ar: String,
    name_en: Option<String>,
    account_number: Option<String>,
    branch: Option<String>,
}

fn bank_names(
    name_ar: &str,
    name_en: &Option<String>,
    account_number: &Option<String>,
    branch: &Option<String>,
) -> Result<BankNames, String> {
    if !valid_text(name_ar, 256) {
        return Err("A valid bank Arabic name is required".into());
    }
    Ok(BankNames {
        name_ar: name_ar.trim().to_string(),
        name_en: optional_text(name_en, 256)?,
        account_number: optional_text(account_number, 128)?,
        branch: optional_text(branch, 256)?,
    })
}

fn validate_balance(value: Option<f64>) -> Result<f64, String> {
    let amount = value.unwrap_or(0.0);
    if !amount.is_finite()
        || amount.abs() > MAX_BALANCE
        || ((amount * 100.0) - (amount * 100.0).round()).abs() > 0.000_001
    {
        return Err("Invalid opening balance: finite cents required".into());
    }
    Ok(amount)
}

fn valid_request_id(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

async fn authorize_bank(
    conn: &mut SqliteConnection,
    actor: &str,
    write: bool,
) -> Result<String, String> {
    let (role, pharmacy) = active_generic_actor(conn, actor).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let permitted = [
        "acc_can_view_bank_accounts",
        "acc_can_view_handover",
        "acc_can_view_general",
    ]
    .iter()
    .take(if write { 1 } else { 3 })
    .any(|permission| user_has_permission(Some(&role), permissions.as_deref(), permission, false));
    if !permitted {
        return Err("Native bank directory permission required".into());
    }
    Ok(pharmacy)
}

async fn opening_account(
    conn: &mut SqliteConnection,
    category: &str,
    code: &str,
) -> Result<i64, String> {
    // Exactly matches the finance.ts mapping rule: a configured mapping is
    // honored only if it points to the canonical code. Group rows are forbidden
    // for double-entry posting regardless of their configuration.
    let configured: Option<i64> = sqlx::query_scalar(
        "SELECT a.id FROM main.trial_balance_settings t
         JOIN main.accounts a ON a.id=t.account_id
         WHERE t.category=? AND a.code=? AND COALESCE(a.is_group,0)=0
         ORDER BY a.id LIMIT 1",
    )
    .bind(category)
    .bind(code)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if let Some(id) = configured {
        return Ok(id);
    }
    sqlx::query_scalar(
        "SELECT id FROM main.accounts WHERE code=? AND COALESCE(is_group,0)=0 LIMIT 1",
    )
    .bind(code)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Required bank opening ledger account {code} is missing or a group"))
}

async fn log_bank(
    conn: &mut SqliteConnection,
    actor: &str,
    pharmacy: &str,
    action: &str,
    details: String,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO main.activity_log(user_id,action,details,pharmacy_id) VALUES(?,?,?,?)",
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

async fn create_with_lock(
    conn: &mut SqliteConnection,
    actor: &str,
    input: CreateBankInput,
) -> Result<BankCreated, String> {
    let names = bank_names(
        &input.name_ar,
        &input.name_en,
        &input.account_number,
        &input.branch,
    )?;
    let opening = validate_balance(input.current_balance)?;
    if !valid_request_id(&input.request_id) {
        return Err("Invalid bank create request identifier".into());
    }
    reset_cancelled_read_state(conn).await?;
    // Even validation/authorization of the live actor happens inside the
    // SQLite writer reservation, never before another window's update.
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let outcome = async {
        let conn = &mut *tx;
        let pharmacy = authorize_bank(conn, actor, true).await?;
        // Global, append-only request witness. This is intentionally not a
        // foreign key to banks: deleting a zero-balance directory row must
        // never make an old create nonce valid again. Migration 037 provides
        // this forward-only table; before that migration the write fails
        // closed rather than creating a replayable bank.
        let duplicate: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM main.finance_device_create_requests
             WHERE request_id=? LIMIT 1",
        )
        .bind(&input.request_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if duplicate.is_some() {
            return Err("Bank create request has already been processed".into());
        }
        let accounts = if opening != 0.0 {
            let bank_account = opening_account(conn, "bank_clearing", "1.1.4").await?;
            let equity_account = opening_account(conn, "opening_balance_equity", "3.9").await?;
            if bank_account == equity_account {
                return Err("Bank and equity opening accounts must differ".into());
            }
            Some((bank_account, equity_account))
        } else {
            None
        };
        let id = sqlx::query(
            "INSERT INTO main.banks
             (name_ar,name_en,account_number,branch,current_balance,pharmacy_id)
             VALUES(?,?,?,?,?,?)",
        )
        .bind(&names.name_ar)
        .bind(&names.name_en)
        .bind(&names.account_number)
        .bind(&names.branch)
        .bind(opening)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .last_insert_rowid();
        if id <= 0 || id > MAX_SAFE_JS_ID {
            return Err("Bank insert returned invalid identifier".into());
        }
        if let Some((bank_account, equity_account)) = accounts {
            let journal = Uuid::new_v4().to_string();
            // The explicit bank ID is a durable history anchor for deletions.
            // Bare bank names from legacy journals cannot safely identify a
            // specific financial account, so the delete guard stays conservative.
            let description = format!("[bank-opening:{id}] رصيد افتتاحي للبنك: {}", names.name_ar);
            sqlx::query(
                "INSERT INTO main.daily_journals
                 (id,date,description,created_by,total_amount,pharmacy_id)
                 VALUES(?,date('now','localtime'),?,?,?,?)",
            )
            .bind(&journal)
            .bind(description)
            .bind(actor)
            .bind(opening.abs())
            .bind(&pharmacy)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
            let (debit, credit) = if opening > 0.0 {
                (bank_account, equity_account)
            } else {
                (equity_account, bank_account)
            };
            for (account, kind) in [(debit, "debit"), (credit, "credit")] {
                sqlx::query(
                    "INSERT INTO main.journal_entries(journal_id,account_id,type,amount)
                     VALUES(?,?,?,?)",
                )
                .bind(&journal)
                .bind(account)
                .bind(kind)
                .bind(opening.abs())
                .execute(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
        sqlx::query(
            "INSERT INTO main.finance_device_create_requests
             (request_id,kind,record_id,pharmacy_id) VALUES(?,'bank',?,?)",
        )
        .bind(&input.request_id)
        .bind(id)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        log_bank(
            conn,
            actor,
            &pharmacy,
            "ADD_BANK",
            format!("إضافة حساب بنكي #{id}: {}", names.name_ar),
        )
        .await?;
        Ok(BankCreated { id })
    }
    .await;
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

async fn update_with_lock(
    conn: &mut SqliteConnection,
    actor: &str,
    input: UpdateBankInput,
) -> Result<(), String> {
    if input.id <= 0 || input.id > MAX_SAFE_JS_ID {
        return Err("Invalid bank identifier".into());
    }
    let names = bank_names(
        &input.name_ar,
        &input.name_en,
        &input.account_number,
        &input.branch,
    )?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let outcome = async {
        let conn = &mut *tx;
        let pharmacy = authorize_bank(conn, actor, true).await?;
        let updated = sqlx::query(
            "UPDATE main.banks SET name_ar=?,name_en=?,account_number=?,branch=?
             WHERE id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(&names.name_ar)
        .bind(&names.name_en)
        .bind(&names.account_number)
        .bind(&names.branch)
        .bind(input.id)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if updated.rows_affected() != 1 {
            return Err("Bank not found in authenticated pharmacy".into());
        }
        log_bank(
            conn,
            actor,
            &pharmacy,
            "UPDATE_BANK",
            format!("تعديل حساب بنكي #{}: {}", input.id, names.name_ar),
        )
        .await
    }
    .await;
    match outcome {
        Ok(()) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(err) => {
            tx.rollback()
                .await
                .map_err(|e| format!("{err}; rollback failed: {e}"))?;
            Err(err)
        }
    }
}

async fn referenced_financially(
    conn: &mut SqliteConnection,
    id: i64,
    pharmacy: &str,
    name: &str,
) -> Result<bool, String> {
    let id_text = id.to_string();
    let tagged = format!("bank:{id}");
    let journal_prefix = format!("[bank-opening:{id}]");
    let legacy_label = format!("رصيد افتتاحي للبنك: {}", name.trim());
    // Card or paper relationships are GLOBAL, not pharmacy-filtered. A
    // pre-upgrade foreign row pointing to this ID still blocks deletion.
    let attached: i64 = sqlx::query_scalar(
        "SELECT (
          (SELECT COUNT(*) FROM main.credit_cards WHERE bank_id=?)
          + (SELECT COUNT(*) FROM main.commercial_papers WHERE bank_id=?)
          + (SELECT COUNT(*) FROM main.trial_balance_settings
             WHERE category=? OR (LOWER(COALESCE(target_type,''))='bank'
               AND (target_id=? OR target_id=?)))
          + (SELECT COUNT(*) FROM main.cash_movements
             WHERE target_name IN (?,?)
                OR (LOWER(COALESCE(source_type,'')) LIKE '%bank%'
                    AND target_name=?))
        )",
    )
    .bind(id)
    .bind(id)
    .bind(&tagged)
    .bind(&id_text)
    .bind(&tagged)
    .bind(&id_text)
    .bind(&tagged)
    .bind(name)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if attached > 0 {
        return Ok(true);
    }
    let bank_history: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.daily_journals j
         WHERE COALESCE(NULLIF(TRIM(j.pharmacy_id),''),'local_default')=?
           AND (substr(COALESCE(j.description,''),1,length(?))=?
                OR j.description=?)
           ",
    )
    .bind(pharmacy)
    .bind(&journal_prefix)
    .bind(&journal_prefix)
    .bind(&legacy_label)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if bank_history > 0 {
        return Ok(true);
    }
    // Bank-clearing (1.1.4) is intentionally shared across bank IDs; historical
    // journals without a reliable bank-ID link cannot be attributed safely.
    // If this pharmacy has ANY bank clearing postings, decline deletion rather
    // than assume the retired bank never held funds.
    let ambiguous_history: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.journal_entries e
         JOIN main.daily_journals j ON j.id=e.journal_id
         JOIN main.accounts a ON a.id=e.account_id
         WHERE a.code='1.1.4'
           AND COALESCE(NULLIF(TRIM(j.pharmacy_id),''),'local_default')=?",
    )
    .bind(pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    Ok(ambiguous_history > 0)
}

async fn delete_with_lock(
    conn: &mut SqliteConnection,
    actor: &str,
    input: BankIdInput,
) -> Result<(), String> {
    if input.id <= 0 || input.id > MAX_SAFE_JS_ID {
        return Err("Invalid bank identifier".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let outcome = async {
        let conn = &mut *tx;
        let pharmacy = authorize_bank(conn, actor, true).await?;
        let row = sqlx::query(
            "SELECT name_ar,current_balance FROM main.banks
             WHERE id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(input.id)
        .bind(&pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Bank not found in authenticated pharmacy")?;
        let name: String = row.try_get("name_ar").map_err(|e| e.to_string())?;
        let balance: Option<f64> = row.try_get("current_balance").map_err(|e| e.to_string())?;
        // No epsilon here: a small but nonzero REAL balance is still funds.
        if !matches!(balance,Some(value) if value.is_finite() && value==0.0) {
            return Err("Bank still has a nonzero or invalid balance; reversal required".into());
        }
        if referenced_financially(conn, input.id, &pharmacy, &name).await? {
            return Err(
                "Bank has historical financial references; deletion requires reconciliation".into(),
            );
        }
        let result = sqlx::query(
            "DELETE FROM main.banks WHERE id=? AND current_balance=0
              AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(input.id)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if result.rows_affected() != 1 {
            return Err("Bank changed before deletion".into());
        }
        // Never DELETE FROM trial_balance_settings: its unscoped custom
        // account mapping may be shared by legacy bank IDs or tenants.
        log_bank(
            conn,
            actor,
            &pharmacy,
            "DELETE_BANK",
            format!("حذف حساب بنكي #{}", input.id),
        )
        .await
    }
    .await;
    match outcome {
        Ok(()) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(err) => {
            tx.rollback()
                .await
                .map_err(|e| format!("{err}; rollback failed: {e}"))?;
            Err(err)
        }
    }
}

async fn list_with_live_actor(
    conn: &mut SqliteConnection,
    actor: &str,
    input: ListBanksInput,
) -> Result<BankPage, String> {
    if input.page > LAST_BANK_PAGE {
        return Err("Bank directory page is out of range".into());
    }
    reset_cancelled_read_state(conn).await?;
    let pharmacy = authorize_bank(conn, actor, false).await?;
    let rows = sqlx::query(
        "SELECT id,name_ar,name_en,account_number,branch,
                current_balance,
                COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default') AS pharmacy_id,created_at
         FROM main.banks
         WHERE COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
         ORDER BY name_ar COLLATE BINARY ASC,id ASC LIMIT 101 OFFSET ?",
    )
    .bind(&pharmacy)
    .bind(i64::from(input.page) * BANK_PAGE_SIZE)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let has_more = rows.len() > BANK_PAGE_SIZE as usize;
    let rows = rows
        .into_iter()
        .take(BANK_PAGE_SIZE as usize)
        .map(|row| {
            Ok(BankRow {
                id: row.try_get("id").map_err(|e| e.to_string())?,
                name_ar: row.try_get("name_ar").map_err(|e| e.to_string())?,
                name_en: row.try_get("name_en").map_err(|e| e.to_string())?,
                account_number: row.try_get("account_number").map_err(|e| e.to_string())?,
                branch: row.try_get("branch").map_err(|e| e.to_string())?,
                current_balance: row
                    .try_get::<Option<f64>, _>("current_balance")
                    .map_err(|e| e.to_string())?
                    .ok_or("Bank balance is null")?,
                pharmacy_id: row.try_get("pharmacy_id").map_err(|e| e.to_string())?,
                created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    if rows
        .iter()
        .any(|row| !row.current_balance.is_finite() || row.id <= 0 || row.id > MAX_SAFE_JS_ID)
    {
        return Err("Bank directory contains an unsafe ID or non-finite financial balance".into());
    }
    Ok(BankPage {
        rows,
        has_more,
        page: input.page,
        actor_id: actor.into(),
        pharmacy_id: pharmacy,
    })
}

#[tauri::command]
pub async fn create_bank_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: CreateBankInput,
) -> Result<BankCreated, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Native bank database unavailable")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    create_with_lock(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn update_bank_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: UpdateBankInput,
) -> Result<(), String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Native bank database unavailable")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    update_with_lock(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn delete_bank_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: BankIdInput,
) -> Result<(), String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Native bank database unavailable")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    delete_with_lock(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn list_banks_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: ListBanksInput,
) -> Result<BankPage, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Native bank database unavailable")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    list_with_live_actor(
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

    fn create(request: &str, balance: f64) -> CreateBankInput {
        CreateBankInput {
            name_ar: "البنك التجريبي".into(),
            name_en: Some("Example Bank".into()),
            account_number: Some("123456789".into()),
            branch: Some("Cairo".into()),
            current_balance: Some(balance),
            request_id: request.into(),
        }
    }
    fn update(id: i64) -> UpdateBankInput {
        UpdateBankInput {
            id,
            name_ar: "حساب معدل".into(),
            name_en: None,
            account_number: Some("AA100".into()),
            branch: None,
        }
    }
    async fn schema(conn: &mut SqliteConnection) {
        conn.execute(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,
                is_active INTEGER,permissions TEXT);
            INSERT INTO users VALUES
              ('owner-a','owner','a',1,'{}'),
              ('owner-b','owner','b',1,'{}'),
              ('local','owner',NULL,1,'{}'),
              ('banker','cashier','a',1,'{"acc_can_view_bank_accounts":true}'),
              ('read-handover','cashier','a',1,'{"acc_can_view_handover":true}'),
              ('read-general','cashier','a',1,'{"acc_can_view_general":true}'),
              ('denied','cashier','a',1,'{"acc_can_view_bank_accounts":false}'),
              ('inactive','owner','a',0,'{}');
            CREATE TABLE banks(id INTEGER PRIMARY KEY AUTOINCREMENT,
              name_ar TEXT NOT NULL,name_en TEXT,account_number TEXT,branch TEXT,
              current_balance REAL DEFAULT 0,pharmacy_id TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER DEFAULT 0);
            INSERT INTO accounts VALUES (14,'1.1.4',0),(15,'3.9',0),(16,'4.1',1);
            CREATE TABLE trial_balance_settings(
              category TEXT PRIMARY KEY,target_type TEXT,target_id TEXT,target_name TEXT,account_id INTEGER);
            INSERT INTO trial_balance_settings VALUES
              ('bank_clearing','account',NULL,NULL,14),
              ('opening_balance_equity','account',NULL,NULL,15);
            CREATE TABLE daily_journals(id TEXT PRIMARY KEY,date TEXT,
              description TEXT,created_by TEXT,total_amount REAL,pharmacy_id TEXT);
            CREATE TABLE journal_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,
              journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
            CREATE TABLE activity_log(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,
              action TEXT,details TEXT,pharmacy_id TEXT);
            CREATE TABLE credit_cards(id INTEGER PRIMARY KEY,bank_id INTEGER,pharmacy_id TEXT);
            CREATE TABLE commercial_papers(id TEXT PRIMARY KEY,bank_id INTEGER,pharmacy_id TEXT);
            CREATE TABLE cash_movements(id TEXT PRIMARY KEY,source_type TEXT,target_name TEXT);
            CREATE TABLE finance_device_create_requests(
              request_id TEXT PRIMARY KEY,kind TEXT NOT NULL
                CHECK(kind IN ('bank','card','pos')),
              record_id INTEGER NOT NULL,pharmacy_id TEXT NOT NULL,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        "#).await.unwrap();
    }
    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        schema(&mut conn).await;
        conn
    }
    async fn n(conn: &mut SqliteConnection, table: &str) -> i64 {
        let sql = match table {
            "banks" => "SELECT COUNT(*) FROM banks",
            "journals" => "SELECT COUNT(*) FROM daily_journals",
            "entries" => "SELECT COUNT(*) FROM journal_entries",
            "audit" => "SELECT COUNT(*) FROM activity_log",
            "requests" => "SELECT COUNT(*) FROM finance_device_create_requests",
            _ => panic!("unknown table"),
        };
        sqlx::query_scalar(sql).fetch_one(&mut *conn).await.unwrap()
    }

    #[tokio::test]
    async fn signed_openings_create_balanced_debit_credit_and_tenant_audit() {
        let mut conn = fixture().await;
        let positive = create_with_lock(
            &mut conn,
            "banker",
            create("bank-create-positive-00001", 123.45),
        )
        .await
        .unwrap();
        let negative = create_with_lock(
            &mut conn,
            "owner-b",
            create("bank-create-negative-00002", -57.25),
        )
        .await
        .unwrap();
        let zero = create_with_lock(&mut conn, "local", create("bank-create-zero-00000003", 0.0))
            .await
            .unwrap();
        assert_eq!(n(&mut conn, "banks").await, 3);
        assert_eq!(n(&mut conn, "journals").await, 2);
        assert_eq!(n(&mut conn, "entries").await, 4);
        assert_eq!(n(&mut conn, "audit").await, 3);
        assert_eq!(n(&mut conn, "requests").await, 3);
        let rows = sqlx::query(
            "SELECT j.pharmacy_id,j.description,j.total_amount,e.account_id,e.type,e.amount
             FROM daily_journals j JOIN journal_entries e ON e.journal_id=j.id
             ORDER BY j.id,e.id",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        let pa: Vec<_> = rows
            .iter()
            .filter(|r| r.get::<String, _>("pharmacy_id") == "a")
            .collect();
        assert_eq!(pa.len(), 2);
        assert!(pa.iter().all(|r| r
            .get::<String, _>("description")
            .contains(&format!("[bank-opening:{}]", positive.id))));
        assert_eq!(
            pa.iter().map(|r| r.get::<f64, _>("amount")).sum::<f64>(),
            246.90
        );
        let debit: i64 = sqlx::query_scalar(
            "SELECT e.account_id FROM journal_entries e
             JOIN daily_journals j ON j.id=e.journal_id
             WHERE j.pharmacy_id='a' AND e.type='debit'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        let credit: i64 = sqlx::query_scalar(
            "SELECT e.account_id FROM journal_entries e
             JOIN daily_journals j ON j.id=e.journal_id
             WHERE j.pharmacy_id='a' AND e.type='credit'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!((debit, credit), (14, 15));
        let negatives: Vec<(i64, String)> = sqlx::query(
            "SELECT e.account_id,e.type FROM journal_entries e JOIN daily_journals j
             ON j.id=e.journal_id WHERE j.pharmacy_id='b' ORDER BY e.id",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap()
        .iter()
        .map(|r| (r.get("account_id"), r.get("type")))
        .collect();
        assert_eq!(negatives, vec![(15, "debit".into()), (14, "credit".into())]);
        let local_balance: f64 = sqlx::query_scalar("SELECT current_balance FROM banks WHERE id=?")
            .bind(zero.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(local_balance, 0.0);
        let pharmacy: String = sqlx::query_scalar("SELECT pharmacy_id FROM banks WHERE id=?")
            .bind(zero.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(pharmacy, "local_default");
        let b_pharmacy: String = sqlx::query_scalar("SELECT pharmacy_id FROM banks WHERE id=?")
            .bind(negative.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(b_pharmacy, "b");
    }

    #[tokio::test]
    async fn create_rejects_forged_identity_numerics_and_replay_without_mutation() {
        let mut conn = fixture().await;
        let success = create_with_lock(
            &mut conn,
            "owner-a",
            create("nonce-replay-create-00001", 12.5),
        )
        .await
        .unwrap();
        assert!(success.id > 0);
        assert!(create_with_lock(
            &mut conn,
            "owner-a",
            create("nonce-replay-create-00001", 12.5)
        )
        .await
        .unwrap_err()
        .contains("already been processed"));
        assert!(create_with_lock(
            &mut conn,
            "owner-b",
            create("nonce-replay-create-00001", 12.5)
        )
        .await
        .is_err()); // Global nonce, even cross-tenant.
        for (number, which) in [
            (f64::NAN, "nan"),
            (f64::INFINITY, "infinity"),
            (1_000_000_000_000.01, "over"),
            (0.001, "fractional-cent"),
        ] {
            let value = create(&format!("bank-invalid-money-{which}"), number);
            assert!(create_with_lock(&mut conn, "owner-a", value).await.is_err());
        }
        let mut empty = create("bank-invalid-name-00003", 0.0);
        empty.name_ar = "   ".into();
        assert!(create_with_lock(&mut conn, "owner-a", empty).await.is_err());
        let mut control = create("bank-invalid-control-00004", 0.0);
        control.name_en = Some("Bank\0X".into());
        assert!(create_with_lock(&mut conn, "owner-a", control)
            .await
            .is_err());
        let mut invalid_nonce = create("invalid", 0.0);
        invalid_nonce.request_id = "x".into();
        assert!(create_with_lock(&mut conn, "owner-a", invalid_nonce)
            .await
            .is_err());
        for actor in [
            "denied",
            "inactive",
            "nonexistent",
            "read-handover",
            "read-general",
        ] {
            assert!(create_with_lock(
                &mut conn,
                actor,
                create(&format!("bank-actor-denied-{actor}"), 0.0)
            )
            .await
            .is_err());
        }
        let mut forged = serde_json::json!({
            "nameAr":"Bank", "currentBalance":10, "requestId":"bank-forged-create-00001",
        });
        for field in [
            "actorId",
            "userId",
            "pharmacyId",
            "role",
            "sql",
            "accountId",
        ] {
            forged[field] = "attacker".into();
            assert!(serde_json::from_value::<CreateBankInput>(forged.clone()).is_err());
            forged.as_object_mut().unwrap().remove(field);
        }
        let update_claim = serde_json::json!({"id":success.id,"nameAr":"Bank","currentBalance":0});
        assert!(serde_json::from_value::<UpdateBankInput>(update_claim).is_err());
        assert!(serde_json::from_value::<BankIdInput>(
            serde_json::json!({"id":success.id,"pharmacyId":"b"})
        )
        .is_err());
        assert_eq!(n(&mut conn, "banks").await, 1);
        assert_eq!(n(&mut conn, "journals").await, 1);
        assert_eq!(n(&mut conn, "entries").await, 2);
        assert_eq!(n(&mut conn, "requests").await, 1);
    }

    #[tokio::test]
    async fn bank_create_missing_leaf_or_abort_trigger_rolls_back_bank_ledger_nonce_audit() {
        let mut conn = fixture().await;
        sqlx::query("UPDATE accounts SET is_group=1 WHERE code='3.9'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(create_with_lock(
            &mut conn,
            "owner-a",
            create("bank-invalid-group-00001", 5.0)
        )
        .await
        .is_err());
        sqlx::query("UPDATE accounts SET is_group=0 WHERE code='3.9'")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("DELETE FROM trial_balance_settings WHERE category='bank_clearing'")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("DELETE FROM accounts WHERE code='1.1.4'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(create_with_lock(
            &mut conn,
            "owner-a",
            create("bank-missing-account-00002", 5.0)
        )
        .await
        .is_err());
        sqlx::query("INSERT INTO accounts VALUES (14,'1.1.4',0)")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO trial_balance_settings
             (category,target_type,account_id) VALUES('bank_clearing','account',14)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn.execute("CREATE TRIGGER abort_credit BEFORE INSERT ON journal_entries
            WHEN NEW.type='credit' BEGIN SELECT RAISE(ABORT,'synthetic journal credit failure'); END")
            .await.unwrap();
        assert!(create_with_lock(
            &mut conn,
            "owner-a",
            create("bank-abort-credit-000003", 5.0)
        )
        .await
        .is_err());
        conn.execute("DROP TRIGGER abort_credit").await.unwrap();
        conn.execute(
            "CREATE TRIGGER abort_audit BEFORE INSERT ON activity_log
            BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
        )
        .await
        .unwrap();
        assert!(
            create_with_lock(&mut conn, "owner-a", create("bank-abort-audit-000004", 5.0))
                .await
                .is_err()
        );
        conn.execute("DROP TRIGGER abort_audit").await.unwrap();
        for table in ["banks", "journals", "entries", "requests", "audit"] {
            assert_eq!(n(&mut conn, table).await, 0, "{table}");
        }
        // Even after a previous failed nonce insert, the original retry can
        // succeed once the operator repairs the database/account.
        assert!(create_with_lock(
            &mut conn,
            "owner-a",
            create("bank-abort-credit-000003", 5.0)
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn updates_are_tenant_bounded_do_not_change_balance_and_audit_rolls_back() {
        let mut conn = fixture().await;
        let bank = create_with_lock(
            &mut conn,
            "owner-a",
            create("bank-update-protected-001", 20.0),
        )
        .await
        .unwrap();
        let before: i64 = n(&mut conn, "audit").await;
        assert!(update_with_lock(&mut conn, "owner-b", update(bank.id))
            .await
            .is_err());
        assert!(update_with_lock(&mut conn, "denied", update(bank.id))
            .await
            .is_err());
        assert!(update_with_lock(&mut conn, "inactive", update(bank.id))
            .await
            .is_err());
        assert!(update_with_lock(&mut conn, "owner-a", update(0))
            .await
            .is_err());
        assert_eq!(n(&mut conn, "audit").await, before);
        update_with_lock(&mut conn, "owner-a", update(bank.id))
            .await
            .unwrap();
        let updated = sqlx::query(
            "SELECT name_ar,current_balance,account_number,pharmacy_id
             FROM banks WHERE id=?",
        )
        .bind(bank.id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(updated.get::<String, _>("name_ar"), "حساب معدل");
        assert_eq!(updated.get::<f64, _>("current_balance"), 20.0);
        assert_eq!(updated.get::<String, _>("account_number"), "AA100");
        assert_eq!(updated.get::<String, _>("pharmacy_id"), "a");
        conn.execute(
            "CREATE TRIGGER refuse_bank_update_audit BEFORE INSERT ON activity_log
             WHEN NEW.action='UPDATE_BANK' BEGIN SELECT RAISE(ABORT,'synthetic update audit'); END",
        )
        .await
        .unwrap();
        let mut changed = update(bank.id);
        changed.name_ar = "ممنوع".into();
        assert!(update_with_lock(&mut conn, "owner-a", changed)
            .await
            .is_err());
        let still: String = sqlx::query_scalar("SELECT name_ar FROM banks WHERE id=?")
            .bind(bank.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(still, "حساب معدل");
        conn.execute("DROP TRIGGER refuse_bank_update_audit")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn deletion_requires_true_zero_and_no_global_or_historical_links() {
        let mut conn = fixture().await;
        let positive = create_with_lock(
            &mut conn,
            "owner-a",
            create("bank-delete-positive-0001", 10.0),
        )
        .await
        .unwrap();
        // Even a forged balance update to zero cannot erase an opening ledger.
        sqlx::query("UPDATE banks SET current_balance=0 WHERE id=?")
            .bind(positive.id)
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            delete_with_lock(&mut conn, "owner-a", BankIdInput { id: positive.id })
                .await
                .is_err()
        );
        let good = create_with_lock(
            &mut conn,
            "owner-a",
            create("bank-delete-empty-000002", 0.0),
        )
        .await
        .unwrap();
        let checks = [
            "INSERT INTO credit_cards VALUES(1,?, 'b')",
            "INSERT INTO commercial_papers VALUES('paper-b',?,'b')",
        ];
        for statement in checks {
            sqlx::query(statement)
                .bind(good.id)
                .execute(&mut conn)
                .await
                .unwrap();
            assert!(
                delete_with_lock(&mut conn, "owner-a", BankIdInput { id: good.id })
                    .await
                    .is_err()
            );
            sqlx::query("DELETE FROM credit_cards WHERE bank_id=?")
                .bind(good.id)
                .execute(&mut conn)
                .await
                .unwrap();
            sqlx::query("DELETE FROM commercial_papers WHERE bank_id=?")
                .bind(good.id)
                .execute(&mut conn)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO trial_balance_settings VALUES(?,'bank',?,NULL,14)")
            .bind(format!("bank:{}", good.id))
            .bind(good.id.to_string())
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            delete_with_lock(&mut conn, "owner-a", BankIdInput { id: good.id })
                .await
                .is_err()
        );
        sqlx::query("DELETE FROM trial_balance_settings WHERE category=?")
            .bind(format!("bank:{}", good.id))
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("INSERT INTO cash_movements VALUES('movement','bank_transfer',?)")
            .bind(format!("bank:{}", good.id))
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            delete_with_lock(&mut conn, "owner-a", BankIdInput { id: good.id })
                .await
                .is_err()
        );
        conn.execute("DELETE FROM cash_movements").await.unwrap();
        // Ambiguous shared 1.1.4 accounting history for the same tenant also
        // blocks deletion, even if the old row held zero and had no cards.
        assert!(
            delete_with_lock(&mut conn, "owner-a", BankIdInput { id: good.id })
                .await
                .is_err()
        );
        let other = create_with_lock(
            &mut conn,
            "owner-b",
            create("bank-delete-branchb-0003", 0.0),
        )
        .await
        .unwrap();
        assert!(
            delete_with_lock(&mut conn, "owner-a", BankIdInput { id: other.id })
                .await
                .is_err()
        );
        delete_with_lock(&mut conn, "owner-b", BankIdInput { id: other.id })
            .await
            .unwrap();
        let deleted: Option<i64> = sqlx::query_scalar("SELECT id FROM banks WHERE id=?")
            .bind(other.id)
            .fetch_optional(&mut conn)
            .await
            .unwrap();
        assert!(deleted.is_none());
        let replay = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM finance_device_create_requests WHERE request_id=?",
        )
        .bind("bank-delete-branchb-0003")
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(replay, 1);
        assert!(create_with_lock(
            &mut conn,
            "owner-b",
            create("bank-delete-branchb-0003", 0.0)
        )
        .await
        .is_err());
        sqlx::query("UPDATE banks SET current_balance=0.001 WHERE id=?")
            .bind(good.id)
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            delete_with_lock(&mut conn, "owner-a", BankIdInput { id: good.id })
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn list_paginates_deterministically_and_rechecks_live_roles_pharmacy() {
        let mut conn = fixture().await;
        for index in 0..205_u32 {
            sqlx::query(
                "INSERT INTO banks
              (name_ar,current_balance,pharmacy_id) VALUES ('Same Name',0,'a')",
            )
            .execute(&mut conn)
            .await
            .unwrap();
            if index < 3 {
                sqlx::query(
                    "INSERT INTO banks
                 (name_ar,current_balance,pharmacy_id) VALUES ('Foreign',777,'b')",
                )
                .execute(&mut conn)
                .await
                .unwrap();
            }
        }
        conn.execute("INSERT INTO banks(name_ar,current_balance) VALUES ('Legacy',0)")
            .await
            .unwrap();
        let first = list_with_live_actor(&mut conn, "read-handover", ListBanksInput { page: 0 })
            .await
            .unwrap();
        let next = list_with_live_actor(&mut conn, "read-handover", ListBanksInput { page: 1 })
            .await
            .unwrap();
        let last = list_with_live_actor(&mut conn, "read-handover", ListBanksInput { page: 2 })
            .await
            .unwrap();
        assert_eq!(first.rows.len(), 100);
        assert_eq!(next.rows.len(), 100);
        assert_eq!(last.rows.len(), 5);
        assert!(first.has_more && next.has_more && !last.has_more);
        assert_eq!(first.pharmacy_id, "a");
        assert_eq!(first.actor_id, "read-handover");
        let ids: std::collections::HashSet<i64> = first
            .rows
            .iter()
            .chain(next.rows.iter())
            .chain(last.rows.iter())
            .map(|row| row.id)
            .collect();
        assert_eq!(ids.len(), 205);
        assert!(first
            .rows
            .iter()
            .chain(next.rows.iter())
            .chain(last.rows.iter())
            .all(|row| row.pharmacy_id.as_deref() == Some("a")));
        assert_eq!(
            list_with_live_actor(&mut conn, "read-general", ListBanksInput { page: 0 })
                .await
                .unwrap()
                .rows
                .len(),
            100
        );
        assert_eq!(
            list_with_live_actor(&mut conn, "local", ListBanksInput { page: 0 })
                .await
                .unwrap()
                .rows[0]
                .name_ar,
            "Legacy"
        );
        assert!(
            list_with_live_actor(&mut conn, "denied", ListBanksInput { page: 0 })
                .await
                .is_err()
        );
        assert!(
            list_with_live_actor(&mut conn, "inactive", ListBanksInput { page: 0 })
                .await
                .is_err()
        );
        assert!(
            list_with_live_actor(&mut conn, "owner-a", ListBanksInput { page: 500 })
                .await
                .is_err()
        );
        for field in ["pharmacyId", "actorId", "sql", "limit"] {
            let mut dto = serde_json::json!({"page":0});
            dto[field] = serde_json::json!("b");
            assert!(serde_json::from_value::<ListBanksInput>(dto).is_err());
        }
        sqlx::query("UPDATE users SET pharmacy_id='b' WHERE id='read-handover'")
            .execute(&mut conn)
            .await
            .unwrap();
        let changed = list_with_live_actor(&mut conn, "read-handover", ListBanksInput { page: 0 })
            .await
            .unwrap();
        assert_eq!(changed.pharmacy_id, "b");
        assert_eq!(changed.rows.len(), 3);
        sqlx::query("UPDATE users SET permissions='{}' WHERE id='read-handover'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            list_with_live_actor(&mut conn, "read-handover", ListBanksInput { page: 0 })
                .await
                .is_err()
        );
        sqlx::query("UPDATE users SET is_active=0 WHERE id='read-handover'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            list_with_live_actor(&mut conn, "read-handover", ListBanksInput { page: 0 })
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn bank_creator_reassignment_and_role_loss_fail_inside_writer() {
        let mut conn = fixture().await;
        let first = create_with_lock(&mut conn, "banker", create("bank-reassign-first-0001", 0.0))
            .await
            .unwrap();
        sqlx::query("UPDATE users SET pharmacy_id='b' WHERE id='banker'")
            .execute(&mut conn)
            .await
            .unwrap();
        let after = create_with_lock(
            &mut conn,
            "banker",
            create("bank-reassign-second-0002", 0.0),
        )
        .await
        .unwrap();
        let first_pharmacy: String = sqlx::query_scalar("SELECT pharmacy_id FROM banks WHERE id=?")
            .bind(first.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        let after_pharmacy: String = sqlx::query_scalar("SELECT pharmacy_id FROM banks WHERE id=?")
            .bind(after.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!((first_pharmacy, after_pharmacy), ("a".into(), "b".into()));
        assert!(update_with_lock(&mut conn, "banker", update(first.id))
            .await
            .is_err());
        sqlx::query("UPDATE users SET permissions='{}' WHERE id='banker'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            create_with_lock(&mut conn, "banker", create("bank-role-revoked-00003", 0.0))
                .await
                .is_err()
        );
        assert!(
            delete_with_lock(&mut conn, "banker", BankIdInput { id: after.id })
                .await
                .is_err()
        );
        sqlx::query("UPDATE users SET role='owner',is_active=0 WHERE id='banker'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            create_with_lock(&mut conn, "banker", create("bank-inactive-owner-0004", 0.0))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn two_writer_creates_same_nonce_commit_once_and_concurrent_deletes_one_winner() {
        let mut path = std::env::temp_dir();
        path.push(format!("pharma-banks-native-{}.sqlite", Uuid::new_v4()));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(8));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .unwrap();
        let mut seeded = pool.acquire().await.unwrap();
        schema(&mut seeded).await;
        drop(seeded);
        let left = pool.clone();
        let right = pool.clone();
        let (a, b) = tokio::join!(
            async move {
                let mut conn = left.acquire().await.unwrap();
                create_with_lock(
                    &mut conn,
                    "owner-a",
                    create("bank-race-create-same-0001", 50.0),
                )
                .await
            },
            async move {
                let mut conn = right.acquire().await.unwrap();
                create_with_lock(
                    &mut conn,
                    "owner-a",
                    create("bank-race-create-same-0001", 50.0),
                )
                .await
            },
        );
        assert_eq!(a.is_ok() as u8 + b.is_ok() as u8, 1);
        let mut verify = pool.acquire().await.unwrap();
        assert_eq!(n(&mut verify, "banks").await, 1);
        assert_eq!(n(&mut verify, "journals").await, 1);
        assert_eq!(n(&mut verify, "entries").await, 2);
        assert_eq!(n(&mut verify, "requests").await, 1);
        let deletable = create_with_lock(
            &mut verify,
            "owner-a",
            create("bank-race-delete-empty-002", 0.0),
        )
        .await
        .unwrap()
        .id;
        let branch_b_deletable = create_with_lock(
            &mut verify,
            "owner-b",
            create("bank-race-delete-branchb-3", 0.0),
        )
        .await
        .unwrap()
        .id;
        drop(verify);
        let left = pool.clone();
        let right = pool.clone();
        let (a, b) = tokio::join!(
            async move {
                let mut conn = left.acquire().await.unwrap();
                delete_with_lock(
                    &mut conn,
                    "owner-b",
                    BankIdInput {
                        id: branch_b_deletable,
                    },
                )
                .await
            },
            async move {
                let mut conn = right.acquire().await.unwrap();
                delete_with_lock(
                    &mut conn,
                    "owner-b",
                    BankIdInput {
                        id: branch_b_deletable,
                    },
                )
                .await
            },
        );
        assert_eq!(a.is_ok() as u8 + b.is_ok() as u8, 1);
        let mut verify = pool.acquire().await.unwrap();
        assert_eq!(n(&mut verify, "banks").await, 2);
        assert_eq!(n(&mut verify, "requests").await, 3);
        drop(verify);
        let left = pool.clone();
        let right = pool.clone();
        let (a, b) = tokio::join!(
            async move {
                let mut conn = left.acquire().await.unwrap();
                delete_with_lock(&mut conn, "owner-a", BankIdInput { id: deletable }).await
            },
            async move {
                let mut conn = right.acquire().await.unwrap();
                delete_with_lock(&mut conn, "owner-a", BankIdInput { id: deletable }).await
            }
        );
        // A previous bank clearing entry in the same tenant makes *both*
        // deletion attempts fail safe: no detached/ambiguous historic funds.
        assert!(a.is_err() && b.is_err());
        let mut verify = pool.acquire().await.unwrap();
        assert_eq!(n(&mut verify, "banks").await, 2);
        drop(verify);
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
