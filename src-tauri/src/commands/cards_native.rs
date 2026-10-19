//! Fixed tenant-owned card/terminal CRUD, opening ledger and bounded list.
//! No identity, tenant, SQL, account, or journal selectors are accepted.
use serde::{Deserialize, Serialize};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

const MAX_CENTS: i64 = 100_000_000_000;
const PAGE_SIZE: i64 = 100;
const MAX_PAGE: u32 = 500;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateCardInput {
    request_id: String,
    name_ar: String,
    name_en: Option<String>,
    bank_id: Option<i64>,
    commission_pct: Option<f64>,
    // Decimal string, signed, exactly 2 places. Floats may round away cents.
    opening_balance: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateCardInput {
    id: i64,
    name_ar: String,
    name_en: Option<String>,
    bank_id: Option<i64>,
    commission_pct: Option<f64>,
    // Balance intentionally cannot be changed in a metadata update.
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardIdInput {
    id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardListInput {
    page: u32,
}

#[derive(Debug, Serialize)]
pub struct CardRow {
    id: i64,
    name_ar: String,
    name_en: Option<String>,
    bank_id: Option<i64>,
    commission_pct: f64,
    current_balance: f64,
    pharmacy_id: String,
    created_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardPage {
    rows: Vec<CardRow>,
    has_more: bool,
    next_page: Option<u32>,
    page: u32,
    actor_id: String,
    pharmacy_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardCreated {
    id: i64,
    journal_id: Option<String>,
}

struct CardFields {
    name_ar: String,
    name_en: Option<String>,
    bank_id: Option<i64>,
    commission_pct: f64,
}

fn validate_name(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn fields(
    name_ar: &str,
    name_en: Option<&str>,
    bank_id: Option<i64>,
    commission_pct: Option<f64>,
) -> Result<CardFields, String> {
    if !validate_name(name_ar, 256)
        || name_en.is_some_and(|name| !name.trim().is_empty() && !validate_name(name, 256))
        || bank_id.is_some_and(|id| id <= 0)
    {
        return Err("Invalid card name, optional name or bank id".into());
    }
    let pct = commission_pct.unwrap_or(0.0);
    if !pct.is_finite() || !(0.0..=100.0).contains(&pct) {
        return Err("Card commission must be 0..100".into());
    }
    Ok(CardFields {
        name_ar: name_ar.trim().into(),
        name_en: name_en
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        bank_id,
        commission_pct: pct,
    })
}

fn exact_cents(raw: &str) -> Result<i64, String> {
    let (negative, value) = match raw.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, raw),
    };
    let (whole, fraction) = value
        .split_once('.')
        .ok_or("Opening balance must be a two-decimal string")?;
    if whole.is_empty()
        || whole.len() > 12
        || fraction.len() != 2
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || !fraction.bytes().all(|c| c.is_ascii_digit())
    {
        return Err("Opening balance must be a two-decimal string".into());
    }
    let cents = whole
        .parse::<i64>()
        .map_err(|_| "Invalid opening balance")?
        .checked_mul(100)
        .and_then(|amount| {
            fraction
                .parse::<i64>()
                .ok()
                .and_then(|p| amount.checked_add(p))
        })
        .ok_or("Opening balance overflow")?;
    if cents > MAX_CENTS {
        return Err("Opening balance exceeds safe maximum".into());
    }
    Ok(if negative { -cents } else { cents })
}

fn nonce(input: &str) -> Result<(), String> {
    let id = Uuid::parse_str(input).map_err(|_| "Canonical UUID-v4 requestId required")?;
    if id.get_version_num() != 4 || id.to_string() != input {
        return Err("Canonical lowercase UUID-v4 requestId required".into());
    }
    Ok(())
}

async fn actor_pharmacy(conn: &mut SqliteConnection, actor: &str) -> Result<String, String> {
    // Live actor permissions/tenant are reloaded after the writer lock.
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
        "acc_can_collect_credit_cards",
        false,
    ) {
        return Err("Card/terminal access denied".into());
    }
    Ok(pharmacy)
}

async fn owned_bank(
    conn: &mut SqliteConnection,
    id: Option<i64>,
    pharmacy: &str,
) -> Result<(), String> {
    if let Some(id) = id {
        let found: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM main.banks WHERE id=?
             AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=? LIMIT 1",
        )
        .bind(id)
        .bind(pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if found.is_none() {
            return Err("Bank does not exist in this pharmacy".into());
        }
    }
    Ok(())
}

async fn posting_account(
    conn: &mut SqliteConnection,
    category: &str,
    code: &str,
) -> Result<i64, String> {
    let configured: Option<i64> = sqlx::query_scalar(
        "SELECT a.id FROM main.trial_balance_settings s
         JOIN main.accounts a ON a.id=s.account_id
         WHERE s.category=? AND a.code=? AND COALESCE(a.is_group,0)=0
           AND NOT EXISTS(SELECT 1 FROM main.accounts c WHERE c.parent_id=a.id)
         LIMIT 1",
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
        "SELECT a.id FROM main.accounts a
         WHERE a.code=? AND COALESCE(a.is_group,0)=0
           AND NOT EXISTS(SELECT 1 FROM main.accounts c WHERE c.parent_id=a.id)
         LIMIT 1",
    )
    .bind(code)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Missing postable core account: {code}"))
}

async fn audit(
    conn: &mut SqliteConnection,
    actor: &str,
    action: &str,
    details: &str,
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

async fn finish<T>(tx: Transaction<'_, Sqlite>, outcome: Result<T, String>) -> Result<T, String> {
    match outcome {
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

fn create_prefix(nonce: &str) -> String {
    format!("card-create-request={nonce};")
}

async fn create_locked(
    conn: &mut SqliteConnection,
    actor: &str,
    input: CreateCardInput,
) -> Result<CardCreated, String> {
    nonce(&input.request_id)?;
    let card = fields(
        &input.name_ar,
        input.name_en.as_deref(),
        input.bank_id,
        input.commission_pct,
    )?;
    let cents = exact_cents(input.opening_balance.as_deref().unwrap_or("0.00"))?;
    let journal_id = format!("card-opening-{}", input.request_id);
    let audit_prefix = create_prefix(&input.request_id);
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let outcome = async {
        let conn = &mut *tx;
        let pharmacy = actor_pharmacy(conn, actor).await?;
        // The consolidated forward-only 037 finance_device_create_requests
        // table is the durable, globally unique nonce witness, including
        // after deletion of a zero-balance terminal.
        let already: Option<String> = sqlx::query_scalar(
            "SELECT request_id FROM main.finance_device_create_requests
             WHERE request_id=? LIMIT 1",
        )
        .bind(&input.request_id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if already.is_some() {
            return Err("Card requestId already processed".into());
        }
        let replay: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM main.activity_log WHERE action='ADD_CARD'
             AND substr(details,1,length(?))=? LIMIT 1",
        )
        .bind(&audit_prefix)
        .bind(&audit_prefix)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if replay.is_some() {
            return Err("Card requestId already processed".into());
        }
        let journal_exists: Option<String> =
            sqlx::query_scalar("SELECT id FROM main.daily_journals WHERE id=? LIMIT 1")
                .bind(&journal_id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
        if journal_exists.is_some() {
            return Err("Card requestId already posted".into());
        }
        owned_bank(conn, card.bank_id, &pharmacy).await?;
        let accounts = if cents != 0 {
            let clearing = posting_account(conn, "bank_clearing", "1.1.4").await?;
            let equity = posting_account(conn, "opening_balance_equity", "3.9").await?;
            if clearing == equity {
                return Err("Card opening accounts must differ".into());
            }
            Some((clearing, equity))
        } else {
            None
        };
        let result = sqlx::query(
            "INSERT INTO main.credit_cards
             (name_ar,name_en,bank_id,commission_pct,current_balance,pharmacy_id)
             VALUES(?,?,?,?,?,?)",
        )
        .bind(&card.name_ar)
        .bind(&card.name_en)
        .bind(card.bank_id)
        .bind(card.commission_pct)
        .bind(cents as f64 / 100.0)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        let id = result.last_insert_rowid();
        if let Some((clearing, equity)) = accounts {
            let amount = cents.abs() as f64 / 100.0;
            sqlx::query(
                "INSERT INTO main.daily_journals
                 (id,date,description,created_by,total_amount,pharmacy_id)
                 VALUES(?,DATE('now','localtime'),?,?,?,?)",
            )
            .bind(&journal_id)
            .bind(format!(
                "رصيد افتتاحي لماكينة الدفع: {} [card_id={id}]",
                card.name_ar
            ))
            .bind(actor)
            .bind(amount)
            .bind(&pharmacy)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
            let entries = if cents > 0 {
                [(clearing, "debit"), (equity, "credit")]
            } else {
                [(equity, "debit"), (clearing, "credit")]
            };
            for (account, entry_type) in entries {
                sqlx::query(
                    "INSERT INTO main.journal_entries(journal_id,account_id,type,amount)
                     VALUES(?,?,?,?)",
                )
                .bind(&journal_id)
                .bind(account)
                .bind(entry_type)
                .bind(amount)
                .execute(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
        sqlx::query(
            "INSERT INTO main.finance_device_create_requests
             (request_id,kind,record_id,pharmacy_id) VALUES(?,'card',?,?)",
        )
        .bind(&input.request_id)
        .bind(id)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        audit(
            conn,
            actor,
            "ADD_CARD",
            &format!("{audit_prefix} card_id={id}; cents={cents}"),
            &pharmacy,
        )
        .await?;
        Ok(CardCreated {
            id,
            journal_id: (cents != 0).then_some(journal_id),
        })
    }
    .await;
    finish(tx, outcome).await
}

async fn update_locked(
    conn: &mut SqliteConnection,
    actor: &str,
    input: UpdateCardInput,
) -> Result<(), String> {
    if input.id <= 0 {
        return Err("Invalid card id".into());
    }
    let card = fields(
        &input.name_ar,
        input.name_en.as_deref(),
        input.bank_id,
        input.commission_pct,
    )?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let outcome = async {
        let conn = &mut *tx;
        let pharmacy = actor_pharmacy(conn, actor).await?;
        owned_bank(conn, card.bank_id, &pharmacy).await?;
        let result = sqlx::query(
            "UPDATE main.credit_cards SET name_ar=?,name_en=?,bank_id=?,commission_pct=?
             WHERE id=? AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(&card.name_ar)
        .bind(&card.name_en)
        .bind(card.bank_id)
        .bind(card.commission_pct)
        .bind(input.id)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if result.rows_affected() != 1 {
            return Err("Card does not exist in the active branch".into());
        }
        audit(
            conn,
            actor,
            "UPDATE_CARD",
            &format!("Updated card terminal {}", input.id),
            &pharmacy,
        )
        .await
    }
    .await;
    finish(tx, outcome).await
}

async fn has_known_reference(
    conn: &mut SqliteConnection,
    table: &str,
    id: i64,
) -> Result<bool, String> {
    // Tables/columns are all compile-time allowlisted; never renderer SQL.
    let (pragma, queries): (&str, [&str; 3]) = match table {
        "card_transactions" => (
            "PRAGMA main.table_info('card_transactions')",
            [
                "SELECT 1 FROM main.card_transactions WHERE card_id=? LIMIT 1",
                "SELECT 1 FROM main.card_transactions WHERE credit_card_id=? LIMIT 1",
                "SELECT 1 FROM main.card_transactions WHERE terminal_id=? LIMIT 1",
            ],
        ),
        "sales_invoices" => (
            "PRAGMA main.table_info('sales_invoices')",
            [
                "SELECT 1 FROM main.sales_invoices WHERE card_id=? LIMIT 1",
                "SELECT 1 FROM main.sales_invoices WHERE credit_card_id=? LIMIT 1",
                "SELECT 1 FROM main.sales_invoices WHERE terminal_id=? LIMIT 1",
            ],
        ),
        _ => return Err("Invalid card reference table".into()),
    };
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT name FROM main.sqlite_master WHERE type='table' AND name=? LIMIT 1",
    )
    .bind(table)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if existing.is_none() {
        return Ok(false);
    }
    let names = sqlx::query(pragma)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|row| row.try_get::<String, _>("name").map_err(|e| e.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    for (index, name) in ["card_id", "credit_card_id", "terminal_id"]
        .iter()
        .enumerate()
    {
        if names.iter().any(|column| column == name) {
            let found: Option<i64> = sqlx::query_scalar(queries[index])
                .bind(id)
                .fetch_optional(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
            if found.is_some() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

async fn delete_locked(
    conn: &mut SqliteConnection,
    actor: &str,
    input: CardIdInput,
) -> Result<(), String> {
    if input.id <= 0 {
        return Err("Invalid card id".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let outcome = async {
        let conn = &mut *tx;
        let pharmacy = actor_pharmacy(conn, actor).await?;
        let balance: Option<Option<f64>> = sqlx::query_scalar(
            "SELECT current_balance FROM main.credit_cards WHERE id=?
             AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?",
        )
        .bind(input.id)
        .bind(&pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        let balance = balance
            .ok_or("Card does not exist in the active branch")?
            .ok_or("Card has unknown balance")?;
        if !balance.is_finite() || balance != 0.0 {
            return Err("Card must have exactly zero balance before deletion".into());
        }
        let journal: Option<String> = sqlx::query_scalar(
            "SELECT id FROM main.daily_journals
             WHERE COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
               AND instr(description,?)>0 LIMIT 1",
        )
        .bind(&pharmacy)
        .bind(format!("[card_id={}]", input.id))
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if journal.is_some()
            || has_known_reference(conn, "card_transactions", input.id).await?
            || has_known_reference(conn, "sales_invoices", input.id).await?
        {
            return Err("Card has historic journal, transaction or sale references".into());
        }
        let deleted = sqlx::query(
            "DELETE FROM main.credit_cards WHERE id=?
             AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
               AND current_balance=0",
        )
        .bind(input.id)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if deleted.rows_affected() != 1 {
            return Err("Card changed during deletion".into());
        }
        audit(
            conn,
            actor,
            "DELETE_CARD",
            &format!("Deleted zero-balance unused card {}", input.id),
            &pharmacy,
        )
        .await
    }
    .await;
    finish(tx, outcome).await
}

async fn list_scoped(
    conn: &mut SqliteConnection,
    actor: &str,
    page: u32,
) -> Result<CardPage, String> {
    if page > MAX_PAGE {
        return Err("Card list page window exceeded".into());
    }
    reset_cancelled_read_state(conn).await?;
    let pharmacy = actor_pharmacy(conn, actor).await?;
    let rows = sqlx::query(
        "SELECT id,name_ar,name_en,bank_id,CAST(commission_pct AS REAL) AS commission_pct,
                CAST(current_balance AS REAL) AS current_balance,
                COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default') AS pharmacy_id,
                created_at
         FROM main.credit_cards
         WHERE COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
         ORDER BY name_ar ASC,id ASC LIMIT 101 OFFSET ?",
    )
    .bind(&pharmacy)
    .bind(i64::from(page) * PAGE_SIZE)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let has_more = rows.len() > PAGE_SIZE as usize;
    let mut data = Vec::with_capacity(rows.len().min(PAGE_SIZE as usize));
    for row in rows.into_iter().take(PAGE_SIZE as usize) {
        data.push(CardRow {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            name_ar: row.try_get("name_ar").map_err(|e| e.to_string())?,
            name_en: row.try_get("name_en").map_err(|e| e.to_string())?,
            bank_id: row.try_get("bank_id").map_err(|e| e.to_string())?,
            commission_pct: row.try_get("commission_pct").map_err(|e| e.to_string())?,
            current_balance: row.try_get("current_balance").map_err(|e| e.to_string())?,
            pharmacy_id: row.try_get("pharmacy_id").map_err(|e| e.to_string())?,
            created_at: row.try_get("created_at").map_err(|e| e.to_string())?,
        });
    }
    Ok(CardPage {
        rows: data,
        has_more,
        next_page: has_more.then_some(page + 1),
        page,
        actor_id: actor.to_owned(),
        pharmacy_id: pharmacy,
    })
}

#[tauri::command]
pub async fn create_card_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: CreateCardInput,
) -> Result<CardCreated, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    create_locked(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn update_card_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: UpdateCardInput,
) -> Result<(), String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    update_locked(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn delete_card_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: CardIdInput,
) -> Result<(), String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    delete_locked(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn list_cards_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: CardListInput,
) -> Result<CardPage, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    list_scoped(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload.page,
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

    const NONCE_1: &str = "a1111111-1111-4111-8111-111111111111";
    const NONCE_2: &str = "b2222222-2222-4222-8222-222222222222";
    const NONCE_3: &str = "c3333333-3333-4333-8333-333333333333";

    fn create(nonce: &str, balance: &str, bank: Option<i64>) -> CreateCardInput {
        CreateCardInput {
            request_id: nonce.into(),
            name_ar: "ماكينة فرع ألف".into(),
            name_en: Some("Branch A".into()),
            bank_id: bank,
            commission_pct: Some(1.5),
            opening_balance: Some(balance.into()),
        }
    }

    fn update(id: i64, bank: Option<i64>) -> UpdateCardInput {
        UpdateCardInput {
            id,
            name_ar: "اسم جديد".into(),
            name_en: None,
            bank_id: bank,
            commission_pct: Some(2.25),
        }
    }

    async fn fixture(conn: &mut SqliteConnection) {
        sqlx::raw_sql(
            r#"
            PRAGMA foreign_keys=ON;
            CREATE TABLE users(
                id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,
                is_active INTEGER,permissions TEXT
            );
            INSERT INTO users VALUES
                ('owner-a','owner','A',1,'{}'),
                ('owner-b','owner','B',1,'{}'),
                ('staff-a','pharmacist','A',1,'{"acc_can_collect_credit_cards":true}'),
                ('denied-a','admin','A',1,'{"acc_can_collect_credit_cards":false}'),
                ('disabled-a','owner','A',0,'{}'),
                ('empty-a','cashier','A',1,NULL);
            CREATE TABLE banks(
                id INTEGER PRIMARY KEY,name_ar TEXT,pharmacy_id TEXT,current_balance REAL
            );
            INSERT INTO banks VALUES(1,'Bank A','A',0),(2,'Bank B','B',0),
              (3,'Legacy',NULL,0);
            CREATE TABLE credit_cards(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name_ar TEXT NOT NULL,name_en TEXT,bank_id INTEGER,
                commission_pct REAL DEFAULT 0,current_balance REAL DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,pharmacy_id TEXT,
                FOREIGN KEY(bank_id) REFERENCES banks(id)
            );
            CREATE TABLE accounts(
                id INTEGER PRIMARY KEY,parent_id INTEGER,code TEXT UNIQUE,
                is_group INTEGER DEFAULT 0
            );
            INSERT INTO accounts VALUES
                (1,NULL,'1.1.4',0),(2,NULL,'3.9',0),(3,NULL,'2',1);
            CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
            INSERT INTO trial_balance_settings VALUES
                ('bank_clearing',1),('opening_balance_equity',2);
            CREATE TABLE daily_journals(
                id TEXT PRIMARY KEY,date TEXT,description TEXT,
                created_by TEXT,total_amount REAL,pharmacy_id TEXT
            );
            CREATE TABLE journal_entries(
                id INTEGER PRIMARY KEY AUTOINCREMENT,journal_id TEXT,account_id INTEGER,
                type TEXT,amount REAL,
                FOREIGN KEY(journal_id) REFERENCES daily_journals(id)
            );
            CREATE TABLE activity_log(
                id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT
            );
            CREATE TABLE finance_device_create_requests(
                request_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL CHECK(kind IN ('bank','card','pos')),
                record_id INTEGER NOT NULL,pharmacy_id TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,payment_method TEXT,pharmacy_id TEXT);
            "#,
        )
        .execute(&mut *conn)
        .await
        .unwrap();
    }

    async fn memory() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        fixture(&mut conn).await;
        conn
    }

    async fn count(conn: &mut SqliteConnection, name: &str) -> i64 {
        let sql = match name {
            "cards" => "SELECT COUNT(*) FROM credit_cards",
            "journals" => "SELECT COUNT(*) FROM daily_journals",
            "lines" => "SELECT COUNT(*) FROM journal_entries",
            "requests" => "SELECT COUNT(*) FROM finance_device_create_requests",
            "audit" => "SELECT COUNT(*) FROM activity_log",
            _ => panic!("unsupported test count"),
        };
        sqlx::query_scalar(sql).fetch_one(&mut *conn).await.unwrap()
    }

    async fn all_zero(conn: &mut SqliteConnection) {
        for name in ["cards", "journals", "lines", "requests", "audit"] {
            assert_eq!(count(conn, name).await, 0, "{name}");
        }
    }

    #[test]
    fn rejects_unknown_renderer_identity_sql_or_balance_mutation_fields() {
        let good = serde_json::json!({
            "requestId":NONCE_1,"nameAr":"فرع أ",
            "bankId":1,"commissionPct":1.5,"openingBalance":"-4.25"
        });
        assert!(serde_json::from_value::<CreateCardInput>(good.clone()).is_ok());
        for (field, value) in [
            ("userId", serde_json::json!("owner-b")),
            ("pharmacyId", serde_json::json!("B")),
            ("journalId", serde_json::json!("fake")),
            ("accountId", serde_json::json!(99)),
            ("sql", serde_json::json!("DROP TABLE credit_cards")),
            ("currentBalance", serde_json::json!(12345)),
        ] {
            let mut invalid = good.clone();
            invalid[field] = value;
            assert!(
                serde_json::from_value::<CreateCardInput>(invalid).is_err(),
                "{field}"
            );
        }
        assert!(
            serde_json::from_value::<CreateCardInput>(serde_json::json!({
                "requestId":NONCE_1,"nameAr":"فرع أ","openingBalance":1.255
            }))
            .is_err()
        );
        for field in ["currentBalance", "openingBalance", "pharmacyId", "sql"] {
            let mut payload = serde_json::json!({"id":1,"nameAr":"فرع أ"});
            payload[field] = serde_json::json!(3);
            assert!(
                serde_json::from_value::<UpdateCardInput>(payload).is_err(),
                "{field}"
            );
        }
        assert!(serde_json::from_value::<CardIdInput>(serde_json::json!({
            "id":1,"pharmacyId":"B"
        }))
        .is_err());
        assert!(serde_json::from_value::<CardListInput>(serde_json::json!({
            "page":0,"sql":"select *"
        }))
        .is_err());
    }

    #[test]
    fn validates_signed_exact_cents_names_commission_and_nonce() {
        for invalid in [
            "1",
            "1.2",
            "1.234",
            "+1.00",
            " 1.00",
            "1.00 ",
            "-0.001",
            "1e2",
            "1,000.00",
            "NaN",
            "1000000000.01",
            "-1000000000.01",
        ] {
            assert!(exact_cents(invalid).is_err(), "amount: {invalid}");
        }
        assert_eq!(exact_cents("0.00").unwrap(), 0);
        assert_eq!(exact_cents("-1.01").unwrap(), -101);
        assert_eq!(exact_cents("1000000000.00").unwrap(), MAX_CENTS);
        assert!(fields("  ", None, None, None).is_err());
        assert!(fields("A\0B", None, None, None).is_err());
        assert!(fields("A", Some("EN\ninvalid"), None, None).is_err());
        assert!(fields("A", None, Some(-10), None).is_err());
        for percent in [f64::NAN, f64::INFINITY, -1.0, 100.01] {
            assert!(fields("A", None, None, Some(percent)).is_err());
        }
        for bad in [
            "same-nonce",
            "A1111111-1111-4111-8111-111111111111",
            "a1111111-1111-1111-8111-111111111111",
        ] {
            assert!(nonce(bad).is_err());
        }
    }

    #[tokio::test]
    async fn posts_positive_opening_as_balanced_tenant_journal_with_durable_request_and_audit() {
        let mut conn = memory().await;
        let posted = create_locked(&mut conn, "staff-a", create(NONCE_1, "125.35", Some(1)))
            .await
            .unwrap();
        assert_eq!(
            posted.journal_id.as_deref(),
            Some(format!("card-opening-{NONCE_1}").as_str())
        );
        let row = sqlx::query(
            "SELECT pharmacy_id,bank_id,current_balance,commission_pct,name_ar
             FROM credit_cards WHERE id=?",
        )
        .bind(posted.id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("pharmacy_id"), "A");
        assert_eq!(row.get::<i64, _>("bank_id"), 1);
        assert_eq!(row.get::<f64, _>("current_balance"), 125.35);
        assert_eq!(row.get::<f64, _>("commission_pct"), 1.5);
        let journal = sqlx::query(
            "SELECT created_by,pharmacy_id,total_amount,description FROM daily_journals",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(journal.get::<String, _>("created_by"), "staff-a");
        assert_eq!(journal.get::<String, _>("pharmacy_id"), "A");
        assert_eq!(journal.get::<f64, _>("total_amount"), 125.35);
        assert!(journal
            .get::<String, _>("description")
            .contains(&format!("[card_id={}]", posted.id)));
        let entries = sqlx::query("SELECT account_id,type,amount FROM journal_entries ORDER BY id")
            .fetch_all(&mut conn)
            .await
            .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].get::<i64, _>("account_id"), 1);
        assert_eq!(entries[0].get::<String, _>("type"), "debit");
        assert_eq!(entries[1].get::<i64, _>("account_id"), 2);
        assert_eq!(entries[1].get::<String, _>("type"), "credit");
        assert!(entries
            .iter()
            .all(|row| row.get::<f64, _>("amount") == 125.35));
        let replay =
            sqlx::query("SELECT kind,record_id,pharmacy_id FROM finance_device_create_requests")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(replay.get::<String, _>("kind"), "card");
        assert_eq!(replay.get::<i64, _>("record_id"), posted.id);
        assert_eq!(replay.get::<String, _>("pharmacy_id"), "A");
        let audit = sqlx::query("SELECT user_id,action,details,pharmacy_id FROM activity_log")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(audit.get::<String, _>("user_id"), "staff-a");
        assert_eq!(audit.get::<String, _>("action"), "ADD_CARD");
        assert_eq!(audit.get::<String, _>("pharmacy_id"), "A");
        assert!(audit.get::<String, _>("details").contains(NONCE_1));
    }

    #[tokio::test]
    async fn negative_balance_reverses_debit_and_credit_and_zero_skips_posting() {
        let mut conn = memory().await;
        create_locked(&mut conn, "owner-a", create(NONCE_1, "-14.20", None))
            .await
            .unwrap();
        let entries = sqlx::query("SELECT account_id,type,amount FROM journal_entries ORDER BY id")
            .fetch_all(&mut conn)
            .await
            .unwrap();
        assert_eq!(entries[0].get::<i64, _>("account_id"), 2);
        assert_eq!(entries[0].get::<String, _>("type"), "debit");
        assert_eq!(entries[1].get::<i64, _>("account_id"), 1);
        assert_eq!(entries[1].get::<String, _>("type"), "credit");
        assert!(entries
            .iter()
            .all(|entry| entry.get::<f64, _>("amount") == 14.20));
        let zero = create_locked(&mut conn, "owner-b", create(NONCE_2, "0.00", Some(2)))
            .await
            .unwrap();
        assert!(zero.journal_id.is_none());
        assert_eq!(count(&mut conn, "journals").await, 1);
        assert_eq!(count(&mut conn, "requests").await, 2);
        assert_eq!(count(&mut conn, "audit").await, 2);
    }

    #[tokio::test]
    async fn denied_disabled_role_downgrade_and_reassignment_enforce_live_database_actor() {
        let mut conn = memory().await;
        for actor in ["denied-a", "disabled-a", "empty-a", "deleted-a"] {
            assert!(
                create_locked(&mut conn, actor, create(NONCE_1, "5.00", None))
                    .await
                    .is_err()
            );
            all_zero(&mut conn).await;
        }
        conn.execute("UPDATE users SET role='cashier', permissions='{}' WHERE id='staff-a'")
            .await
            .unwrap();
        assert!(
            create_locked(&mut conn, "staff-a", create(NONCE_1, "5.00", None))
                .await
                .is_err()
        );
        all_zero(&mut conn).await;
        conn.execute("UPDATE users SET role='pharmacist', permissions='{\"acc_can_collect_credit_cards\":true}',pharmacy_id='B' WHERE id='staff-a'")
            .await.unwrap();
        let card = create_locked(&mut conn, "staff-a", create(NONCE_1, "5.00", Some(2)))
            .await
            .unwrap();
        let own_pharmacy: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM credit_cards WHERE id=?")
                .bind(card.id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(own_pharmacy, "B");
        conn.execute("UPDATE users SET is_active=0 WHERE id='staff-a'")
            .await
            .unwrap();
        assert!(update_locked(&mut conn, "staff-a", update(card.id, None))
            .await
            .is_err());
        assert!(
            delete_locked(&mut conn, "staff-a", CardIdInput { id: card.id })
                .await
                .is_err()
        );
        assert!(list_scoped(&mut conn, "staff-a", 0).await.is_err());
    }

    #[tokio::test]
    async fn rejects_foreign_bank_and_foreign_card_on_create_update_delete() {
        let mut conn = memory().await;
        assert!(
            create_locked(&mut conn, "owner-a", create(NONCE_1, "10.00", Some(2)))
                .await
                .is_err()
        );
        all_zero(&mut conn).await;
        let a = create_locked(&mut conn, "owner-a", create(NONCE_1, "0.00", Some(1)))
            .await
            .unwrap();
        let b = create_locked(&mut conn, "owner-b", create(NONCE_2, "0.00", Some(2)))
            .await
            .unwrap();
        assert!(update_locked(&mut conn, "owner-a", update(a.id, Some(2)))
            .await
            .is_err());
        assert!(update_locked(&mut conn, "owner-a", update(b.id, None))
            .await
            .is_err());
        assert!(
            delete_locked(&mut conn, "owner-a", CardIdInput { id: b.id })
                .await
                .is_err()
        );
        let a_bank: Option<i64> = sqlx::query_scalar("SELECT bank_id FROM credit_cards WHERE id=?")
            .bind(a.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(a_bank, Some(1));
        let b_bank: Option<i64> = sqlx::query_scalar("SELECT bank_id FROM credit_cards WHERE id=?")
            .bind(b.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(b_bank, Some(2));
        assert_eq!(count(&mut conn, "cards").await, 2);
    }

    #[tokio::test]
    async fn update_changes_only_metadata_and_never_balance_or_journal() {
        let mut conn = memory().await;
        let a = create_locked(&mut conn, "owner-a", create(NONCE_1, "12.34", Some(1)))
            .await
            .unwrap();
        update_locked(&mut conn, "owner-a", update(a.id, None))
            .await
            .unwrap();
        let row = sqlx::query(
            "SELECT name_ar,bank_id,current_balance,commission_pct FROM credit_cards WHERE id=?",
        )
        .bind(a.id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("name_ar"), "اسم جديد");
        assert_eq!(row.get::<Option<i64>, _>("bank_id"), None);
        assert_eq!(row.get::<f64, _>("current_balance"), 12.34);
        assert_eq!(row.get::<f64, _>("commission_pct"), 2.25);
        assert_eq!(count(&mut conn, "journals").await, 1);
        assert_eq!(count(&mut conn, "lines").await, 2);
        assert_eq!(count(&mut conn, "audit").await, 2);
    }

    #[tokio::test]
    async fn zero_balance_delete_refuses_existing_opening_and_optional_transaction_sale_links() {
        let mut conn = memory().await;
        let a = create_locked(&mut conn, "owner-a", create(NONCE_1, "5.00", None))
            .await
            .unwrap();
        assert!(
            delete_locked(&mut conn, "owner-a", CardIdInput { id: a.id })
                .await
                .is_err()
        );
        conn.execute("UPDATE credit_cards SET current_balance=0 WHERE id=1")
            .await
            .unwrap();
        // Even after settlement, a visible historic opening voucher anchors the card.
        assert!(
            delete_locked(&mut conn, "owner-a", CardIdInput { id: a.id })
                .await
                .is_err()
        );
        let b = create_locked(&mut conn, "owner-a", create(NONCE_2, "0.00", None))
            .await
            .unwrap();
        conn.execute("ALTER TABLE sales_invoices ADD COLUMN terminal_id INTEGER")
            .await
            .unwrap();
        sqlx::query("INSERT INTO sales_invoices(id,payment_method,pharmacy_id,terminal_id) VALUES('sale','visa','A',?)")
            .bind(b.id).execute(&mut conn).await.unwrap();
        assert!(
            delete_locked(&mut conn, "owner-a", CardIdInput { id: b.id })
                .await
                .is_err()
        );
        conn.execute("DELETE FROM sales_invoices").await.unwrap();
        conn.execute("CREATE TABLE card_transactions(id INTEGER,credit_card_id INTEGER)")
            .await
            .unwrap();
        sqlx::query("INSERT INTO card_transactions VALUES(1,?)")
            .bind(b.id)
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            delete_locked(&mut conn, "owner-a", CardIdInput { id: b.id })
                .await
                .is_err()
        );
        conn.execute("DELETE FROM card_transactions").await.unwrap();
        delete_locked(&mut conn, "owner-a", CardIdInput { id: b.id })
            .await
            .unwrap();
        assert_eq!(count(&mut conn, "cards").await, 1);
        assert_eq!(count(&mut conn, "requests").await, 2);
        assert!(
            create_locked(&mut conn, "owner-a", create(NONCE_2, "0.00", None))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn creation_and_metadata_audit_failures_rollback_all_writes_and_nonce() {
        let mut conn = memory().await;
        conn.execute(
            "CREATE TRIGGER fail_entry BEFORE INSERT ON journal_entries
             BEGIN SELECT RAISE(ABORT,'fail entry'); END",
        )
        .await
        .unwrap();
        assert!(
            create_locked(&mut conn, "owner-a", create(NONCE_1, "5.00", None))
                .await
                .is_err()
        );
        all_zero(&mut conn).await;
        conn.execute("DROP TRIGGER fail_entry").await.unwrap();
        conn.execute(
            "CREATE TRIGGER fail_audit BEFORE INSERT ON activity_log
             BEGIN SELECT RAISE(ABORT,'fail audit'); END",
        )
        .await
        .unwrap();
        assert!(
            create_locked(&mut conn, "owner-a", create(NONCE_1, "0.00", None))
                .await
                .is_err()
        );
        all_zero(&mut conn).await;
        conn.execute("DROP TRIGGER fail_audit").await.unwrap();
        let a = create_locked(&mut conn, "owner-a", create(NONCE_1, "0.00", None))
            .await
            .unwrap();
        conn.execute(
            "CREATE TRIGGER fail_update_audit BEFORE INSERT ON activity_log
             WHEN NEW.action='UPDATE_CARD'
             BEGIN SELECT RAISE(ABORT,'fail update'); END",
        )
        .await
        .unwrap();
        assert!(update_locked(&mut conn, "owner-a", update(a.id, None))
            .await
            .is_err());
        let name: String = sqlx::query_scalar("SELECT name_ar FROM credit_cards WHERE id=?")
            .bind(a.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(name, "ماكينة فرع ألف");
        conn.execute("DROP TRIGGER fail_update_audit")
            .await
            .unwrap();
        conn.execute(
            "CREATE TRIGGER fail_delete_audit BEFORE INSERT ON activity_log
             WHEN NEW.action='DELETE_CARD'
             BEGIN SELECT RAISE(ABORT,'fail delete'); END",
        )
        .await
        .unwrap();
        assert!(
            delete_locked(&mut conn, "owner-a", CardIdInput { id: a.id })
                .await
                .is_err()
        );
        assert_eq!(count(&mut conn, "cards").await, 1);
        assert_eq!(count(&mut conn, "audit").await, 1);
    }

    #[tokio::test]
    async fn bounded_branch_scoped_list_covers_100_plus_records_with_permission_denial() {
        let mut conn = memory().await;
        for number in 0..102 {
            sqlx::query(
                "INSERT INTO credit_cards(name_ar,commission_pct,current_balance,pharmacy_id)
                 VALUES(?,0,0,'A')",
            )
            .bind(format!("Card {number:03}"))
            .execute(&mut conn)
            .await
            .unwrap();
        }
        conn.execute(
            "INSERT INTO credit_cards(name_ar,current_balance,pharmacy_id) VALUES('Foreign',0,'B')",
        )
        .await
        .unwrap();
        let first = list_scoped(&mut conn, "owner-a", 0).await.unwrap();
        assert_eq!(first.rows.len(), 100);
        assert!(first.has_more);
        assert_eq!(first.next_page, Some(1));
        assert!(first.rows.iter().all(|card| card.pharmacy_id == "A"));
        let second = list_scoped(&mut conn, "owner-a", 1).await.unwrap();
        assert_eq!(second.rows.len(), 2);
        assert!(!second.has_more);
        assert_eq!(second.next_page, None);
        assert_eq!(first.rows[0].name_ar, "Card 000");
        assert_eq!(second.rows[1].name_ar, "Card 101");
        assert_eq!(
            list_scoped(&mut conn, "owner-b", 0)
                .await
                .unwrap()
                .rows
                .len(),
            1
        );
        assert!(list_scoped(&mut conn, "denied-a", 0).await.is_err());
        assert!(list_scoped(&mut conn, "owner-a", 501).await.is_err());
    }

    #[tokio::test]
    async fn concurrent_replay_posts_exactly_once_on_two_database_connections() {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "pharma-native-card-nonce-{}.sqlite",
            Uuid::new_v4()
        ));
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
            let mut conn = pool.acquire().await.unwrap();
            fixture(&mut conn).await;
        }
        let (first, second) = tokio::join!(
            async {
                let mut conn = pool.acquire().await.unwrap();
                create_locked(&mut conn, "owner-a", create(NONCE_3, "42.25", None)).await
            },
            async {
                let mut conn = pool.acquire().await.unwrap();
                create_locked(&mut conn, "owner-a", create(NONCE_3, "42.25", None)).await
            }
        );
        assert_eq!(u8::from(first.is_ok()) + u8::from(second.is_ok()), 1);
        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(count(&mut conn, "cards").await, 1);
        assert_eq!(count(&mut conn, "journals").await, 1);
        assert_eq!(count(&mut conn, "lines").await, 2);
        assert_eq!(count(&mut conn, "requests").await, 1);
        assert_eq!(count(&mut conn, "audit").await, 1);
        drop(conn);
        pool.close().await;
        // Windows may retain a SQLite file handle briefly after a pool closes.
        // Cleanup is best-effort and must not turn verified ledger assertions
        // into a flaky failure caused by an unrelated antivirus/file lock.
        for _ in 0..20 {
            if std::fs::remove_file(&path).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
