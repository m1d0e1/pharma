//! Standalone cash postings. No renderer SQL, user ID, pharmacy ID, account ID
//! or journal ID is accepted. One BEGIN IMMEDIATE covers shift + both ledgers.
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
pub struct CashMovementInput {
    movement_type: String,
    category: String,
    sub_category: Option<String>,
    amount: f64,
    source_type: Option<String>,
    target_name: Option<String>,
    notes: Option<String>,
    date: String,
    actual_date: Option<String>,
    shift_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashMovementPosted {
    id: String,
    journal_id: String,
    shift_id: String,
}

fn valid_date(value: &str) -> bool {
    if value.len() != 10
        || value.as_bytes()[4] != b'-'
        || value.as_bytes()[7] != b'-'
        || value
            .bytes()
            .enumerate()
            .any(|(i, byte)| i != 4 && i != 7 && !byte.is_ascii_digit())
    {
        return false;
    }
    let year = value[0..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..10].parse::<u32>().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    year > 0 && day > 0 && day <= days
}

fn valid_text(value: &str, limit: usize, multiline: bool) -> bool {
    !value.trim().is_empty()
        && value.len() <= limit
        && !value
            .chars()
            .any(|ch| ch == '\0' || (ch.is_control() && !(multiline && matches!(ch, '\n' | '\r'))))
}

// Cash posted from a patient, supplier, return or security source needs the
// dedicated native writer and its original source receipt. A manual category
// or source_type string is not evidence that money belongs to that source.
fn source_bound_cash_kind(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "collection"
            | "patient"
            | "account_receivable"
            | "accounts_receivable"
            | "supplier_payment"
            | "accounts_payable"
            | "patient_wallet"
            | "patient_payment"
            | "patient_wallet_topup"
            | "patient_wallet_top_up"
            | "commercial_paper"
            | "financial_notice"
            | "purchase_return"
            | "sale_return"
            | "sales_return"
            | "purchase_invoice"
            | "sales_invoice"
    )
}

async fn require_explicit_finance_scope(
    conn: &mut SqliteConnection,
    actor: &str,
    normalized: &str,
    raw: Option<&str>,
) -> Result<(), String> {
    if raw != Some(normalized)
        || normalized.is_empty()
        || normalized.eq_ignore_ascii_case("local_default")
    {
        return Err("Native money posting requires an explicitly owned pharmacy".into());
    }
    let disputed: Option<i64> = sqlx::query_scalar(
        "SELECT 1 FROM main.native_owner_scope_review WHERE owner_id=? LIMIT 1",
    )
    .bind(actor)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if disputed.is_some() {
        return Err("Native money posting requires independent owner-scope review".into());
    }
    Ok(())
}

fn validate(input: &CashMovementInput) -> Result<(), String> {
    if !matches!(input.movement_type.as_str(), "receipt" | "disbursement")
        || !input.amount.is_finite()
        || !(0.0..=1_000_000_000_000.0).contains(&input.amount)
        || input.amount == 0.0
        || !valid_date(&input.date)
        || input
            .actual_date
            .as_deref()
            .is_some_and(|date| !valid_date(date))
        || !valid_text(&input.category, 128, false)
        || input
            .sub_category
            .as_deref()
            .is_some_and(|value| !valid_text(value, 128, false))
        || input
            .source_type
            .as_deref()
            .is_some_and(|value| !valid_text(value, 128, false))
        || input
            .target_name
            .as_deref()
            .is_some_and(|value| !valid_text(value, 256, false))
        || input
            .notes
            .as_deref()
            .is_some_and(|value| !valid_text(value, 2000, true))
        || input
            .shift_id
            .as_deref()
            .is_some_and(|value| !valid_text(value, 128, false))
    {
        return Err("Invalid cash movement payload".into());
    }
    if source_bound_cash_kind(&input.category)
        || input
            .source_type
            .as_deref()
            .is_some_and(source_bound_cash_kind)
        || input
            .sub_category
            .as_deref()
            .is_some_and(source_bound_cash_kind)
    {
        return Err("Source-bound cash movement requires its dedicated native posting command".into());
    }
    Ok(())
}

fn canonical(category: &str) -> Option<(&'static str, &'static str)> {
    match category {
        "collection" | "patient" | "accounts_receivable" => Some(("accounts_receivable", "1.1.2")),
        "supplier_payment" | "accounts_payable" => Some(("accounts_payable", "2.1")),
        "patient_wallet" => Some(("patient_wallet_liability", "2.2")),
        "pharmacy" => Some(("opening_balance_equity", "3.9")),
        "supplier" => Some(("supplier_cash_adjustments", "3.3")),
        "other" => Some(("other_cash_income", "3.2")),
        "personal" => Some(("owner_drawings", "3.8")),
        "operating_expenses" => Some(("general_operating_expenses", "4.4")),
        _ => None,
    }
}

async fn valid_account(conn: &mut SqliteConnection, id: i64) -> Result<Option<i64>, String> {
    if id <= 0 {
        return Ok(None);
    }
    sqlx::query_scalar("SELECT id FROM main.accounts WHERE id=? AND COALESCE(is_group,0)=0")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| err.to_string())
}

async fn configured_account(
    conn: &mut SqliteConnection,
    category: &str,
    target: Option<&str>,
) -> Result<Option<i64>, String> {
    if let Some(target) = target {
        let targeted: Option<i64> = sqlx::query_scalar(
            "SELECT account_id FROM main.trial_balance_settings
             WHERE category=? AND (target_name=? OR target_type=?) LIMIT 1",
        )
        .bind(category)
        .bind(target)
        .bind(target)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
        if let Some(account_id) = targeted {
            return valid_account(conn, account_id).await;
        }
    }
    let account_id: Option<i64> = sqlx::query_scalar(
        "SELECT account_id FROM main.trial_balance_settings WHERE category=? LIMIT 1",
    )
    .bind(category)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    match account_id {
        Some(id) => valid_account(conn, id).await,
        None => Ok(None),
    }
}

async fn canonical_account(
    conn: &mut SqliteConnection,
    category: &str,
    code: &str,
) -> Result<i64, String> {
    // Preserve JS fallback rules: configured mapping only applies if its account
    // code matches the known canonical code. Never post to a group account.
    let configured: Option<i64> = sqlx::query_scalar(
        "SELECT a.id FROM main.trial_balance_settings t
         JOIN main.accounts a ON a.id=t.account_id
         WHERE t.category=? AND a.code=? AND COALESCE(a.is_group,0)=0 LIMIT 1",
    )
    .bind(category)
    .bind(code)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    if let Some(id) = configured {
        return Ok(id);
    }
    sqlx::query_scalar(
        "SELECT id FROM main.accounts WHERE code=? AND COALESCE(is_group,0)=0 LIMIT 1",
    )
    .bind(code)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| err.to_string())?
    .ok_or_else(|| format!("Required accounting account {code} is missing"))
}

async fn reject_source_bound_account(
    conn: &mut SqliteConnection,
    account_id: i64,
) -> Result<(), String> {
    let code: Option<String> = sqlx::query_scalar(
        "SELECT code FROM main.accounts WHERE id=? AND COALESCE(is_group,0)=0",
    )
    .bind(account_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|error| error.to_string())?;
    if matches!(code.as_deref(), Some("1.1.2" | "2.1" | "2.2")) {
        return Err("Manual cash or expense postings cannot use receivable, payable or patient wallet accounts".into());
    }
    Ok(())
}

async fn category_account(
    conn: &mut SqliteConnection,
    input: &CashMovementInput,
) -> Result<i64, String> {
    if input.category == "operating_expenses" {
        if let Some(sub_category) = input.sub_category.as_deref() {
            let expense_id: Option<i64> = sqlx::query_scalar(
                "SELECT id FROM main.expense_definitions
                 WHERE code=? OR name_ar=? OR LOWER(name_en)=LOWER(?) LIMIT 1",
            )
            .bind(sub_category)
            .bind(sub_category)
            .bind(sub_category)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|err| err.to_string())?;
            if let Some(expense_id) = expense_id {
                if let Some(id) =
                    configured_account(conn, &format!("expense:{expense_id}"), None).await?
                {
                    return Ok(id);
                }
            }
        }
    }
    if let Some(account) =
        configured_account(conn, &input.category, input.target_name.as_deref()).await?
    {
        return Ok(account);
    }
    let (canonical_category, code) =
        canonical(&input.category).ok_or("No configured account for cash movement category")?;
    canonical_account(conn, canonical_category, code).await
}

async fn resolve_shift(
    conn: &mut SqliteConnection,
    actor: &str,
    pharmacy: &str,
    proposed: Option<&str>,
) -> Result<String, String> {
    if let Some(requested) = proposed {
        let valid: Option<String> = sqlx::query_scalar(
            "SELECT CAST(id AS TEXT) FROM main.shifts WHERE CAST(id AS TEXT)=?
             AND LOWER(COALESCE(status,''))='open'
             AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=? LIMIT 1",
        )
        .bind(requested)
        .bind(pharmacy)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|err| err.to_string())?;
        if let Some(id) = valid {
            return Ok(id);
        }
        // Old or foreign shift is not authority for any pharmacy. Match previous
        // stale-shift behavior by selecting this pharmacy's open shift instead.
    }
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT CAST(id AS TEXT) FROM main.shifts WHERE LOWER(COALESCE(status,''))='open'
         AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
         ORDER BY start_time ASC,rowid ASC LIMIT 1",
    )
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let shift_id = Uuid::new_v4().to_string();
    let inserted = sqlx::query(
        "INSERT INTO main.shifts (id,user_id,pharmacy_id,starting_cash,notes,status)
         SELECT ?,?,?,0,?,'open' WHERE NOT EXISTS (
          SELECT 1 FROM main.shifts WHERE LOWER(COALESCE(status,''))='open'
          AND COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?)",
    )
    .bind(&shift_id)
    .bind(actor)
    .bind(pharmacy)
    .bind("وردية مشتركة أُنشئت تلقائياً")
    .bind(pharmacy)
    .execute(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    if inserted.rows_affected() != 1 {
        return Err("Concurrent shared shift creation was rejected".into());
    }
    Ok(shift_id)
}

async fn post_with_lock(
    conn: &mut SqliteConnection,
    actor: &str,
    input: CashMovementInput,
) -> Result<CashMovementPosted, String> {
    validate(&input)?;
    reset_cancelled_read_state(conn).await?;
    // SQLx Transaction auto-rolls back on cancellation/drop, including when
    // the renderer window closes while a native write is in flight.
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|err| err.to_string())?;
    let attempt = async {
        let conn = &mut *tx;
        let (role, pharmacy) = active_generic_actor(conn, actor).await?;
        let user = sqlx::query(
            "SELECT permissions,pharmacy_id FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1"
        ).bind(actor).fetch_one(&mut *conn).await.map_err(|err| err.to_string())?;
        let permissions: Option<String> = user.try_get("permissions").map_err(|err| err.to_string())?;
        let raw_pharmacy: Option<String> = user.try_get("pharmacy_id").map_err(|err| err.to_string())?;
        require_explicit_finance_scope(conn,actor,&pharmacy,raw_pharmacy.as_deref()).await?;
        let process = user_has_permission(Some(&role),permissions.as_deref(),"acc_can_process_cash_flow",false);
        let expense_only = input.movement_type == "disbursement" && input.category == "operating_expenses"
            && user_has_permission(Some(&role),permissions.as_deref(),"acc_can_define_expenses",false);
        if !process && !expense_only { return Err("Authenticated role cannot post cash movements".into()); }
        // Resolve both account IDs before any ledger insert. Trigger/constraint
        // failure at any later point still rolls back shift and all entries.
        let cash_account = canonical_account(conn,"cash_drawer","1.1.1").await?;
        let category_account = category_account(conn,&input).await?;
        reject_source_bound_account(conn,category_account).await?;
        if cash_account == category_account {
            return Err("Cash and category accounts must differ for a journal".into());
        }
        let shift_id = resolve_shift(conn,actor,&pharmacy,input.shift_id.as_deref()).await?;
        let id = Uuid::new_v4().to_string();
        let journal_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO main.cash_movements
             (id,user_id,shift_id,type,category,sub_category,amount,source_type,target_name,notes,date,actual_date,pharmacy_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
        ).bind(&id).bind(actor).bind(&shift_id).bind(&input.movement_type)
            .bind(&input.category).bind(&input.sub_category).bind(input.amount)
            .bind(&input.source_type).bind(&input.target_name).bind(&input.notes)
            .bind(&input.date).bind(&input.actual_date).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|err| err.to_string())?;
        let description = format!("{} نقدية: {} - {}",if input.movement_type=="receipt" {"قبض"} else {"صرف"},input.category,input.notes.as_deref().unwrap_or(""));
        sqlx::query(
            "INSERT INTO main.daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
             VALUES (?,?,?,?,?,?)"
        ).bind(&journal_id).bind(&input.date).bind(description).bind(actor).bind(input.amount).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|err| err.to_string())?;
        let (debit,credit) = if input.movement_type=="receipt" {
            (cash_account, category_account)
        } else { (category_account,cash_account) };
        for (account_id, entry_type) in [(debit,"debit"),(credit,"credit")] {
            sqlx::query("INSERT INTO main.journal_entries(journal_id,account_id,type,amount) VALUES (?,?,?,?)")
                .bind(&journal_id).bind(account_id).bind(entry_type).bind(input.amount)
                .execute(&mut *conn).await.map_err(|err| err.to_string())?;
        }
        Ok(CashMovementPosted {id,journal_id,shift_id})
    }.await;
    match attempt {
        Ok(posted) => {
            tx.commit().await.map_err(|err| err.to_string())?;
            Ok(posted)
        }
        Err(err) => {
            tx.rollback()
                .await
                .map_err(|rollback| format!("{err}; rollback failed: {rollback}"))?;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn create_cash_movement_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: CashMovementInput,
) -> Result<CashMovementPosted, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|err| err.to_string())?;
    post_with_lock(&mut conn, actor.as_deref().unwrap(), payload).await
}

/// Entire expense + cash movement + balanced journal on one native writer.
/// The earlier renderer nested-transaction path cannot be used in a secure
/// release, and calling the standalone cash command after inserting an expense
/// would produce a dangerous detached commit.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpensePostingInput {
    category: String,
    amount: f64,
    description: String,
    date: String,
    source_type: Option<String>,
    shift_id: Option<String>,
    request_id: String,
}

#[derive(Debug, Serialize)]
pub struct ExpensePosted {
    pub id: String,
}

async fn post_expense_with_lock(
    conn: &mut SqliteConnection,
    actor: &str,
    input: ExpensePostingInput,
) -> Result<ExpensePosted, String> {
    if !valid_text(&input.category, 128, false)
        || !valid_text(&input.description, 2000, true)
        || !valid_text(&input.request_id, 128, false)
        || input
            .shift_id
            .as_deref()
            .is_some_and(|v| !valid_text(v, 128, false))
        || input
            .source_type
            .as_deref()
            .is_some_and(|v| !valid_text(v, 128, false))
        || !input.amount.is_finite()
        || input.amount <= 0.0
        || input.amount > 1e12
        || !valid_date(&input.date)
        || input.source_type.as_deref().is_some_and(source_bound_cash_kind)
    {
        return Err("Invalid native expense posting".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result=async {
        let conn=&mut *tx;
        let (role,pharmacy)=active_generic_actor(conn,actor).await?;
        let user=sqlx::query(
            "SELECT permissions,pharmacy_id FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1")
            .bind(actor).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let permissions:Option<String>=user.try_get("permissions").map_err(|e|e.to_string())?;
        let raw_pharmacy:Option<String>=user.try_get("pharmacy_id").map_err(|e|e.to_string())?;
        require_explicit_finance_scope(conn,actor,&pharmacy,raw_pharmacy.as_deref()).await?;
        if !["acc_can_define_expenses","acc_can_process_cash_flow"].iter().any(|permission|
            user_has_permission(Some(&role),permissions.as_deref(),permission,false)) {
            return Err("Expense posting permission required".into());
        }
        // An explicit request nonce prevents double expense posting after IPC
        // retries, without ever accepting a renderer-selected expense ID.
        let already:Option<i64>=sqlx::query_scalar(
            "SELECT 1 FROM main.expense_posting_requests WHERE request_id=? LIMIT 1")
            .bind(&input.request_id).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
        if already.is_some() {return Err("Expense request already posted".into());}
        let movement=CashMovementInput {
            movement_type:"disbursement".into(),category:"operating_expenses".into(),
            sub_category:Some(input.category.clone()),amount:input.amount,
            source_type:input.source_type.clone(),target_name:None,
            notes:Some(input.description.clone()),date:input.date.clone(),actual_date:None,
            shift_id:input.shift_id.clone(),
        };
        let drawer=canonical_account(conn,"cash_drawer","1.1.1").await?;
        let category_account=category_account(conn,&movement).await?;
        reject_source_bound_account(conn,category_account).await?;
        if category_account==drawer {return Err("Expense cash and debit ledger accounts must differ".into());}
        let shift=resolve_shift(conn,actor,&pharmacy,movement.shift_id.as_deref()).await?;
        let expense_id=Uuid::new_v4().to_string();
        let cash_id=Uuid::new_v4().to_string();
        let journal_id=Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO main.expenses(id,user_id,category,amount,description,date,pharmacy_id)
                     VALUES(?,?,?,?,?,?,?)")
            .bind(&expense_id).bind(actor).bind(&input.category).bind(input.amount)
            .bind(&input.description).bind(&input.date).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO main.cash_movements
            (id,user_id,shift_id,type,category,sub_category,amount,source_type,notes,date,pharmacy_id)
            VALUES(?,?,?,'disbursement','operating_expenses',?,?,?,?,?,?)")
            .bind(&cash_id).bind(actor).bind(&shift).bind(&input.category).bind(input.amount)
            .bind(&input.source_type).bind(&input.description).bind(&input.date).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO main.daily_journals
            (id,date,description,created_by,total_amount,pharmacy_id) VALUES(?,?,?,?,?,?)")
            .bind(&journal_id).bind(&input.date)
            .bind(format!("صرف نقدية: operating_expenses - {}",input.description))
            .bind(actor).bind(input.amount).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        for (account_id,kind) in [(category_account,"debit"),(drawer,"credit")] {
            sqlx::query("INSERT INTO main.journal_entries(journal_id,account_id,type,amount) VALUES(?,?,?,?)")
                .bind(&journal_id).bind(account_id).bind(kind).bind(input.amount)
                .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        }
        sqlx::query("INSERT INTO main.expense_posting_requests(request_id,expense_id,pharmacy_id) VALUES(?,?,?)")
            .bind(&input.request_id).bind(&expense_id).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO main.activity_log(user_id,action,details,pharmacy_id) VALUES(?,'ADD_EXPENSE',?,?)")
            .bind(actor).bind(format!("{}: {} - {}",input.category,input.amount,input.description))
            .bind(&pharmacy).execute(&mut *conn).await.map_err(|e|e.to_string())?;
        Ok(ExpensePosted{id:expense_id})
    }.await;
    match result {
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
pub async fn create_expense_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: ExpensePostingInput,
) -> Result<ExpensePosted, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    post_expense_with_lock(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpenseListFilters {
    from: Option<String>,
    to: Option<String>,
    category: Option<String>,
    #[serde(default)]
    page: u32,
}

const EXPENSE_PAGE_SIZE: u32 = 200;
// UI allows at most 10,000 complete expense records per read. Page 49
// can report has_more, but the client MUST reject that overflow.
const EXPENSE_LAST_PAGE: u32 = 49;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpensePage {
    rows: Vec<serde_json::Value>,
    has_more: bool,
    page: u32,
    actor_id: String,
    pharmacy_id: String,
}

async fn read_expenses(
    conn: &mut SqliteConnection,
    actor: &str,
    filter: ExpenseListFilters,
) -> Result<ExpensePage, String> {
    if filter.from.as_deref().is_some_and(|d| !valid_date(d))
        || filter.to.as_deref().is_some_and(|d| !valid_date(d))
        || filter
            .category
            .as_deref()
            .is_some_and(|c| c != "all" && !valid_text(c, 128, false))
        || (filter
            .from
            .as_ref()
            .zip(filter.to.as_ref())
            .is_some_and(|(a, b)| a > b))
        || filter.page > EXPENSE_LAST_PAGE
    {
        return Err("Invalid native expense report filters".into());
    }
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy) = active_generic_actor(conn, actor).await?;
    let perms: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users
       WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if !user_has_permission(Some(&role), perms.as_deref(), "can_view_expenses", false) {
        return Err("Native expense history permission required".into());
    }
    let rows = sqlx::query(
        "SELECT e.id,e.user_id,e.category,CAST(e.amount AS REAL) AS amount,
      e.description,e.date,e.created_at,e.pharmacy_id,u.full_name AS user_name
      FROM main.expenses e LEFT JOIN main.users u ON u.id=e.user_id
      AND COALESCE(NULLIF(TRIM(u.pharmacy_id),''),'local_default')=?
      WHERE COALESCE(NULLIF(TRIM(e.pharmacy_id),''),'local_default')=?
       AND (? IS NULL OR e.date>=?) AND (? IS NULL OR e.date<=?)
       AND (? IS NULL OR e.category=?)
      ORDER BY e.date DESC,e.created_at DESC,e.id DESC LIMIT 201 OFFSET ?",
    )
    .bind(&pharmacy)
    .bind(&pharmacy)
    .bind(filter.from.as_deref())
    .bind(filter.from.as_deref())
    .bind(filter.to.as_deref())
    .bind(filter.to.as_deref())
    .bind(filter.category.as_deref().filter(|s| *s != "all"))
    .bind(filter.category.as_deref().filter(|s| *s != "all"))
    .bind(i64::from(filter.page) * i64::from(EXPENSE_PAGE_SIZE))
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let has_more = rows.len() > EXPENSE_PAGE_SIZE as usize;
    let rows = rows
        .into_iter()
        .take(EXPENSE_PAGE_SIZE as usize)
        .map(|row| {
            Ok(serde_json::json!({
              "id":row.try_get::<String,_>("id").map_err(|e|e.to_string())?,
              "user_id":row.try_get::<String,_>("user_id").map_err(|e|e.to_string())?,
              "category":row.try_get::<String,_>("category").map_err(|e|e.to_string())?,
              "amount":row.try_get::<f64,_>("amount").map_err(|e|e.to_string())?,
              "description":row.try_get::<Option<String>,_>("description").unwrap_or(None),
              "date":row.try_get::<String,_>("date").map_err(|e|e.to_string())?,
              "created_at":row.try_get::<Option<String>,_>("created_at").unwrap_or(None),
              "pharmacy_id":row.try_get::<Option<String>,_>("pharmacy_id").unwrap_or(None),
              "user_name":row.try_get::<Option<String>,_>("user_name").unwrap_or(None),
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(ExpensePage {
        rows,
        has_more,
        page: filter.page,
        actor_id: actor.to_string(),
        pharmacy_id: pharmacy,
    })
}

#[tauri::command]
pub async fn list_expenses_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    filters: ExpenseListFilters,
) -> Result<ExpensePage, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    read_expenses(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        filters,
    )
    .await
}

/// Safe commercial paper lifecycle: the status change and, when cashed, the
/// shift cash posting and journal are a SINGLE writer transaction. Replays of
/// an already cashed paper cannot create additional movements.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaperStatusInput {
    id: String,
    new_status: String,
    action_date: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperStatusResult {
    changed: bool,
}

async fn update_paper_status_with_lock(
    conn: &mut SqliteConnection,
    actor: &str,
    input: PaperStatusInput,
) -> Result<PaperStatusResult, String> {
    if !valid_text(&input.id, 128, false)
        || !valid_date(&input.action_date)
        || !matches!(
            input.new_status.as_str(),
            "pending" | "cashed" | "bounced" | "cancelled"
        )
    {
        return Err("Invalid native commercial paper status request".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let outcome=async {
        let conn=&mut *tx;
        let (role,pharmacy)=active_generic_actor(conn,actor).await?;
        let user=sqlx::query(
            "SELECT permissions,pharmacy_id FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1")
            .bind(actor).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let permissions:Option<String>=user.try_get("permissions").map_err(|e|e.to_string())?;
        let raw_pharmacy:Option<String>=user.try_get("pharmacy_id").map_err(|e|e.to_string())?;
        require_explicit_finance_scope(conn,actor,&pharmacy,raw_pharmacy.as_deref()).await?;
        if !user_has_permission(Some(&role),permissions.as_deref(),"acc_can_view_securities",false) {
            return Err("Cannot update commercial papers without native securities permission".into());
        }
        let paper=sqlx::query("SELECT status,direction,type,paper_number,target_name,CAST(amount AS REAL) AS amount
            FROM main.commercial_papers WHERE id=?
             AND pharmacy_id=? LIMIT 1")
            .bind(&input.id).bind(&pharmacy).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?
            .ok_or("Commercial paper not found in native pharmacy")?;
        let status:String=paper.try_get("status").map_err(|e|e.to_string())?;
        if status==input.new_status {return Ok(PaperStatusResult{changed:false});}
        if status=="cashed" {return Err("A posted commercial paper requires a separate reversal".into());}
        if !matches!(status.as_str(),"pending"|"bounced"|"cancelled") {
            return Err("Unknown prior commercial paper state".into());
        }
        if input.new_status=="cashed" && !user_has_permission(
            Some(&role),permissions.as_deref(),"acc_can_process_cash_flow",false) {
            return Err("Commercial paper cash posting permission required".into());
        }
        let amount:f64=paper.try_get("amount").map_err(|e|e.to_string())?;
        let direction:String=paper.try_get("direction").map_err(|e|e.to_string())?;
        if input.new_status=="cashed" && (!amount.is_finite() || amount<=0.0 || amount>1e12 || !matches!(direction.as_str(),"in"|"out")) {
            return Err("Invalid commercial paper amount or direction".into());
        }
        let updated=sqlx::query("UPDATE main.commercial_papers SET status=? WHERE id=? AND status=?
          AND pharmacy_id=?")
          .bind(&input.new_status).bind(&input.id).bind(status).bind(&pharmacy)
          .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        if updated.rows_affected()!=1 {return Err("Commercial paper status changed concurrently".into());}
        if input.new_status=="cashed" {
            // A historic pending/bounced row may already have a linked cash
            // movement after an old partial failure. Never post it twice.
            let previously_posted:Option<i64>=sqlx::query_scalar(
                "SELECT 1 FROM main.cash_movements WHERE source_type='commercial_paper'
                 AND target_name=? LIMIT 1")
                .bind(&input.id).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
            if previously_posted.is_some() {
                return Err("Commercial paper already has a cash posting; manual reconciliation required".into());
            }
            let paper_type:String=paper.try_get("type").map_err(|e|e.to_string())?;
            let number:Option<String>=paper.try_get("paper_number").unwrap_or(None);
            let target:Option<String>=paper.try_get("target_name").unwrap_or(None);
            let note=format!("تحصيل/صرف {} رقم {} - {}",
                if paper_type=="check" {"شيك"} else {"كمبيالة"},number.unwrap_or_default(),target.unwrap_or_default());
            if !valid_text(&note,2000,true) {return Err("Commercial paper memo too large".into());}
            let category=if direction=="in" {"collection"} else {"supplier_payment"};
            let movement=CashMovementInput {movement_type:if direction=="in" {"receipt"}else{"disbursement"}.into(),
                category:category.into(),sub_category:None,amount,source_type:Some("commercial_paper".into()),
                target_name:Some(input.id.clone()),notes:Some(note.clone()),date:input.action_date.clone(),
                actual_date:None,shift_id:None};
            let cash_account=canonical_account(conn,"cash_drawer","1.1.1").await?;
            let balance_account=category_account(conn,&movement).await?;
            if cash_account==balance_account {return Err("Commercial paper ledger accounts cannot match".into());}
            let shift=resolve_shift(conn,actor,&pharmacy,None).await?;
            let journal_id=Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO main.cash_movements
              (id,user_id,shift_id,type,category,amount,source_type,target_name,notes,date,pharmacy_id)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)")
                .bind(Uuid::new_v4().to_string()).bind(actor).bind(shift)
                .bind(&movement.movement_type).bind(&movement.category).bind(amount)
                .bind("commercial_paper").bind(&input.id).bind(&note).bind(&input.action_date).bind(&pharmacy)
                .execute(&mut *conn).await.map_err(|e|e.to_string())?;
            sqlx::query("INSERT INTO main.daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
                        VALUES(?,?,?,?,?,?)")
                .bind(&journal_id).bind(&input.action_date)
                .bind(format!("{} نقدية: {} - {}",if direction=="in" {"قبض"}else{"صرف"},category,note))
                .bind(actor).bind(amount).bind(&pharmacy)
                .execute(&mut *conn).await.map_err(|e|e.to_string())?;
            let (debit,credit)=if direction=="in" {(cash_account,balance_account)}
                else {(balance_account,cash_account)};
            for (id,kind) in [(debit,"debit"),(credit,"credit")] {
                sqlx::query("INSERT INTO main.journal_entries(journal_id,account_id,type,amount)
                            VALUES(?,?,?,?)")
                    .bind(&journal_id).bind(id).bind(kind).bind(amount)
                    .execute(&mut *conn).await.map_err(|e|e.to_string())?;
            }
        }
        sqlx::query("INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
                    VALUES(?,'UPDATE_PAPER_STATUS',?,?)")
            .bind(actor).bind(format!("Paper {} status {}",input.id,input.new_status)).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        Ok(PaperStatusResult{changed:true})
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
pub async fn update_paper_status_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PaperStatusInput,
) -> Result<PaperStatusResult, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    update_paper_status_with_lock(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

// Commercial-paper creation, deletion and reading share the same actor/tenant
// policy as the native settlement command. Renderer-selected SQL and identity
// fields are not part of any DTO.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaperCreateInput {
    paper_type: String,
    direction: String,
    paper_number: String,
    bank_id: Option<i64>,
    amount: f64,
    due_date: String,
    target_name: String,
    notes: Option<String>,
    request_id: String,
}

#[derive(Debug, Serialize)]
pub struct PaperCreated {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaperDeleteInput {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaperPageInput {
    page: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaperPage {
    rows: Vec<serde_json::Value>,
    has_more: bool,
}

async fn paper_actor(conn: &mut SqliteConnection, actor: &str) -> Result<String, String> {
    let (role, pharmacy) = active_generic_actor(conn, actor).await?;
    let user = sqlx::query(
        "SELECT permissions,pharmacy_id FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let permissions: Option<String> = user.try_get("permissions").map_err(|e| e.to_string())?;
    let raw_pharmacy: Option<String> = user.try_get("pharmacy_id").map_err(|e| e.to_string())?;
    require_explicit_finance_scope(conn,actor,&pharmacy,raw_pharmacy.as_deref()).await?;
    if !user_has_permission(
        Some(&role),
        permissions.as_deref(),
        "acc_can_view_securities",
        false,
    ) {
        return Err("Native commercial securities permission required".into());
    }
    Ok(pharmacy)
}

async fn create_paper_with_lock(
    conn: &mut SqliteConnection,
    actor: &str,
    input: PaperCreateInput,
) -> Result<PaperCreated, String> {
    if !matches!(input.paper_type.as_str(), "check" | "promissory_note")
        || !matches!(input.direction.as_str(), "in" | "out")
        || !valid_text(&input.paper_number, 128, false)
        || !valid_text(&input.target_name, 256, false)
        || !valid_date(&input.due_date)
        || !valid_text(&input.request_id, 128, false)
        || input.bank_id.is_some_and(|id| id <= 0)
        || input.notes.as_deref().is_some_and(|s| {
            s.len() > 2000
                || s.chars()
                    .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r')))
        })
        || !input.amount.is_finite()
        || input.amount <= 0.0
        || input.amount > 1e12
    {
        return Err("Invalid native commercial paper create request".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result=async {
        let conn=&mut *tx;
        let pharmacy=paper_actor(conn,actor).await?;
        let duplicate:Option<i64>=sqlx::query_scalar(
            "SELECT 1 FROM main.commercial_paper_create_requests WHERE request_id=? LIMIT 1")
            .bind(&input.request_id).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
        if duplicate.is_some() {return Err("Commercial paper request already processed".into());}
        if let Some(bank_id)=input.bank_id {
            let owned:Option<i64>=sqlx::query_scalar(
                "SELECT id FROM main.banks WHERE id=? AND pharmacy_id=?")
                .bind(bank_id).bind(&pharmacy)
                .fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
            if owned.is_none(){return Err("Commercial paper bank belongs to another pharmacy or does not exist".into());}
        }
        let id=Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO main.commercial_papers
            (id,type,direction,paper_number,bank_id,amount,due_date,status,target_name,notes,pharmacy_id)
            VALUES(?,?,?,?,?,?,?,'pending',?,?,?)")
            .bind(&id).bind(&input.paper_type).bind(&input.direction).bind(&input.paper_number)
            .bind(input.bank_id).bind(input.amount).bind(&input.due_date)
            .bind(&input.target_name).bind(&input.notes).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO main.commercial_paper_create_requests(request_id,paper_id,pharmacy_id)
            VALUES(?,?,?)")
            .bind(&input.request_id).bind(&id).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        sqlx::query("INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
                     VALUES(?,'ADD_COMMERCIAL_PAPER',?,?)")
            .bind(actor).bind(format!("Paper {} {}",id,input.paper_number)).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        Ok(PaperCreated{id})
    }.await;
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

async fn delete_paper_with_lock(
    conn: &mut SqliteConnection,
    actor: &str,
    input: PaperDeleteInput,
) -> Result<(), String> {
    if !valid_text(&input.id, 128, false) {
        return Err("Invalid commercial paper identifier".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result=async {
        let conn=&mut *tx;
        let pharmacy=paper_actor(conn,actor).await?;
        let status:Option<String>=sqlx::query_scalar(
            "SELECT status FROM main.commercial_papers WHERE id=?
             AND pharmacy_id=?")
            .bind(&input.id).bind(&pharmacy)
            .fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
        let status=status.ok_or("Commercial paper not found in native pharmacy")?;
        if !matches!(status.as_str(),"pending"|"bounced"|"cancelled") {
            return Err("Posted or unknown commercial paper cannot be deleted; reversal required".into());
        }
        // Legacy pending papers can already have a cash movement following a
        // historic partially failed workflow. Never erase the audit anchor.
        let movement:Option<i64>=sqlx::query_scalar(
            "SELECT 1 FROM main.cash_movements WHERE source_type='commercial_paper' AND target_name=? LIMIT 1")
            .bind(&input.id).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
        if movement.is_some(){return Err("Existing paper cash posting requires manual reconciliation".into());}
        let deleted=sqlx::query("DELETE FROM main.commercial_papers WHERE id=? AND status=?
          AND pharmacy_id=?")
            .bind(&input.id).bind(&status).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        if deleted.rows_affected()!=1{return Err("Commercial paper changed concurrently".into());}
        sqlx::query("INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
                     VALUES(?,'DELETE_PAPER',?,?)")
            .bind(actor).bind(format!("Deleted unposted paper {}",input.id)).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        Ok(())
    }.await;
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

async fn read_papers(
    conn: &mut SqliteConnection,
    actor: &str,
    input: PaperPageInput,
) -> Result<PaperPage, String> {
    if input.page > 499 {
        return Err("Commercial paper page limit exceeded".into());
    }
    reset_cancelled_read_state(conn).await?;
    let pharmacy = paper_actor(conn, actor).await?;
    let rows = sqlx::query(
        "SELECT id,type,direction,paper_number,bank_id,
          CAST(amount AS REAL) AS amount,due_date,status,target_name,notes,created_at,pharmacy_id
          FROM main.commercial_papers
          WHERE COALESCE(NULLIF(TRIM(pharmacy_id),''),'local_default')=?
          ORDER BY due_date ASC,id ASC LIMIT 101 OFFSET ?",
    )
    .bind(&pharmacy)
    .bind(i64::from(input.page) * 100)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let has_more = rows.len() > 100;
    let mut output = Vec::with_capacity(rows.len().min(100));
    for row in rows.into_iter().take(100) {
        output.push(serde_json::json!({
            "id":row.try_get::<String,_>("id").map_err(|e|e.to_string())?,
            "type":row.try_get::<String,_>("type").map_err(|e|e.to_string())?,
            "direction":row.try_get::<String,_>("direction").map_err(|e|e.to_string())?,
            "paper_number":row.try_get::<Option<String>,_>("paper_number").unwrap_or(None),
            "bank_id":row.try_get::<Option<i64>,_>("bank_id").unwrap_or(None),
            "amount":row.try_get::<f64,_>("amount").map_err(|e|e.to_string())?,
            "due_date":row.try_get::<Option<String>,_>("due_date").unwrap_or(None),
            "status":row.try_get::<Option<String>,_>("status").unwrap_or(None),
            "target_name":row.try_get::<Option<String>,_>("target_name").unwrap_or(None),
            "notes":row.try_get::<Option<String>,_>("notes").unwrap_or(None),
            "created_at":row.try_get::<Option<String>,_>("created_at").unwrap_or(None),
            "pharmacy_id":row.try_get::<Option<String>,_>("pharmacy_id").unwrap_or(None),
        }));
    }
    Ok(PaperPage {
        rows: output,
        has_more,
    })
}

#[tauri::command]
pub async fn create_paper_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PaperCreateInput,
) -> Result<PaperCreated, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    create_paper_with_lock(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn delete_paper_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PaperDeleteInput,
) -> Result<(), String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    delete_paper_with_lock(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[tauri::command]
pub async fn list_papers_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: PaperPageInput,
) -> Result<PaperPage, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    read_papers(
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

    fn input(movement_type: &str, category: &str) -> CashMovementInput {
        CashMovementInput {
            movement_type: movement_type.into(),
            category: category.into(),
            sub_category: None,
            amount: 12.5,
            source_type: None,
            target_name: None,
            notes: None,
            date: "2026-10-11".into(),
            actual_date: None,
            shift_id: None,
        }
    }
    async fn seed_fixture(conn: &mut SqliteConnection) {
        conn.execute(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,is_active INTEGER,permissions TEXT);
            INSERT INTO users VALUES
                ('owner-a','owner','a',1,'{}'),('owner-b','owner','b',1,'{}'),
                ('cashier-a','cashier','a',1,'{"acc_can_process_cash_flow":true}'),
                ('expenses-a','cashier','a',1,'{"acc_can_define_expenses":true}'),
                ('denied','cashier','a',1,'{"acc_can_process_cash_flow":false}'),
                ('inactive','owner','a',0,'{}'),('local','owner',NULL,1,'{}'),
                ('blank','owner',' ',1,'{}'),('placeholder','owner','local_default',1,'{}'),
                ('review','owner','a',1,'{}');
            CREATE TABLE native_owner_scope_review(owner_id TEXT PRIMARY KEY);
            INSERT INTO native_owner_scope_review VALUES('review');
            CREATE TABLE shifts(id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,starting_cash REAL,notes TEXT,
                status TEXT,start_time TEXT);
            INSERT INTO shifts VALUES ('foreign','owner-b','b',0,'','open','2026-10-10'),
                ('old-a','owner-a','a',0,'','closed','2026-10-09');
            CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER DEFAULT 0);
            INSERT INTO accounts VALUES
                (1,'1.1.1',0),(2,'1.1.2',0),(3,'4.4',0),(4,'3.2',0),(5,'3.9',0),(6,'2.1',0),(7,'4.1',1),
                (8,'6.1',0),(9,'6.2',0);
            CREATE TABLE trial_balance_settings(category TEXT,target_type TEXT,target_name TEXT,account_id INTEGER);
            INSERT INTO trial_balance_settings VALUES ('cash_drawer','account',NULL,1),
                ('collection','VIP','Specific',9),
                ('targeted_misc','VIP','Specific',9),
                ('expense:3',NULL,NULL,8);
            CREATE TABLE expense_definitions(id INTEGER PRIMARY KEY,code TEXT,name_ar TEXT,name_en TEXT);
            INSERT INTO expense_definitions VALUES (3,'UTIL','مرافق','Utilities');
            CREATE TABLE cash_movements(id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,type TEXT,
                category TEXT,sub_category TEXT,amount REAL,source_type TEXT,target_name TEXT,notes TEXT,
                date TEXT,actual_date TEXT,pharmacy_id TEXT);
            CREATE TABLE daily_journals(id TEXT PRIMARY KEY,date TEXT,description TEXT,created_by TEXT,
                total_amount REAL,pharmacy_id TEXT);
            CREATE TABLE journal_entries(id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
            CREATE TABLE expenses(id TEXT PRIMARY KEY,user_id TEXT,category TEXT,amount REAL,description TEXT,date TEXT,pharmacy_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE expense_posting_requests(request_id TEXT PRIMARY KEY,expense_id TEXT,pharmacy_id TEXT);
            CREATE TABLE activity_log(id INTEGER PRIMARY KEY,user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
            ALTER TABLE users ADD COLUMN full_name TEXT;
            UPDATE users SET full_name='Cashier A' WHERE id='cashier-a';
            CREATE TABLE banks(id INTEGER PRIMARY KEY,pharmacy_id TEXT,name_ar TEXT);
            INSERT INTO banks VALUES(1,'a','Bank A'),(2,'b','Bank B'),(3,NULL,'Legacy Bank');
            CREATE TABLE commercial_papers(id TEXT PRIMARY KEY,type TEXT,direction TEXT,
              paper_number TEXT,target_name TEXT,amount REAL,status TEXT,pharmacy_id TEXT,
              bank_id INTEGER,due_date TEXT,notes TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
            INSERT INTO commercial_papers(id,type,direction,paper_number,target_name,amount,status,pharmacy_id) VALUES
              ('incoming-a','check','in','A1','Customer A',25,'pending','a'),
              ('outgoing-a','promissory_note','out','A2','Supplier A',30,'pending','a'),
              ('foreign-b','check','in','B1','Customer B',50,'pending','b'),
              ('already','check','in','A3','Customer A',10,'cashed','a');
            CREATE TABLE commercial_paper_create_requests(request_id TEXT PRIMARY KEY,
              paper_id TEXT UNIQUE,pharmacy_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
        "#).await.unwrap();
    }
    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        seed_fixture(&mut conn).await;
        conn
    }
    async fn count(conn: &mut SqliteConnection, table: &str) -> i64 {
        let sql = match table {
            "cash" => "SELECT COUNT(*) FROM cash_movements",
            "shifts" => "SELECT COUNT(*) FROM shifts",
            "journals" => "SELECT COUNT(*) FROM daily_journals",
            "entries" => "SELECT COUNT(*) FROM journal_entries",
            "expenses" => "SELECT COUNT(*) FROM expenses",
            "requests" => "SELECT COUNT(*) FROM expense_posting_requests",
            "activity" => "SELECT COUNT(*) FROM activity_log",
            "papers_cashed" => "SELECT COUNT(*) FROM commercial_papers WHERE status='cashed'",
            _ => panic!("invalid table"),
        };
        sqlx::query_scalar(sql).fetch_one(&mut *conn).await.unwrap()
    }

    fn expense(nonce: &str) -> ExpensePostingInput {
        ExpensePostingInput {
            category: "UTIL".into(),
            amount: 17.5,
            description: "Electricity for this branch".into(),
            date: "2026-10-11".into(),
            source_type: Some("manual".into()),
            shift_id: Some("foreign".into()),
            request_id: nonce.into(),
        }
    }

    #[tokio::test]
    async fn parent_expense_posts_single_tenant_owned_cash_and_balanced_journal() {
        let mut conn = fixture().await;
        let posted = post_expense_with_lock(&mut conn, "expenses-a", expense("expense-1"))
            .await
            .unwrap();
        assert!(!posted.id.is_empty());
        for table in ["expenses", "cash", "journals", "requests", "activity"] {
            assert_eq!(count(&mut conn, table).await, 1, "{table}");
        }
        assert_eq!(count(&mut conn, "entries").await, 2);
        assert_eq!(count(&mut conn, "shifts").await, 3);
        let accounts: Vec<i64> =
            sqlx::query_scalar("SELECT account_id FROM journal_entries ORDER BY id")
                .fetch_all(&mut conn)
                .await
                .unwrap();
        assert_eq!(accounts, vec![8, 1]);
        let pharmacy: String = sqlx::query_scalar("SELECT pharmacy_id FROM expenses WHERE id=?")
            .bind(&posted.id)
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(pharmacy, "a");
        let shift: String = sqlx::query_scalar("SELECT shift_id FROM cash_movements LIMIT 1")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_ne!(shift, "foreign");
        assert!(
            post_expense_with_lock(&mut conn, "expenses-a", expense("expense-1"))
                .await
                .unwrap_err()
                .contains("already posted")
        );
        assert_eq!(count(&mut conn, "expenses").await, 1);
    }

    #[tokio::test]
    async fn unproven_actor_scope_cannot_create_cash_expenses_or_commercial_papers() {
        let mut conn = fixture().await;
        for actor in ["local", "blank", "placeholder", "review"] {
            let cash = post_with_lock(&mut conn, actor, input("receipt", "other"))
                .await.unwrap_err();
            assert!(cash.contains("pharmacy") || cash.contains("review"), "{cash}");
            assert!(post_expense_with_lock(&mut conn, actor, expense(&format!("expense-{actor}")))
                .await.is_err());
            assert!(create_paper_with_lock(&mut conn, actor, new_paper(actor, None))
                .await.is_err());
            assert!(update_paper_status_with_lock(&mut conn, actor, paper("incoming-a", "cashed"))
                .await.is_err());
        }
        for table in ["cash", "shifts", "journals", "entries", "expenses", "requests", "activity"] {
            assert_eq!(count(&mut conn,table).await,if table=="shifts" {2} else {0}, "{table}");
        }
        assert_eq!(count(&mut conn,"papers_cashed").await,1);
    }

    #[tokio::test]
    async fn generic_cash_cannot_impersonate_source_bound_money_or_redirect_accounts() {
        let mut conn = fixture().await;
        for category in [
            "collection", "patient", "accounts_receivable", "account_receivable",
            "supplier_payment", "accounts_payable", "patient_wallet", " PATIENT_WALLET ",
        ] {
            let denied = post_with_lock(&mut conn,"owner-a",input("receipt",category))
                .await.unwrap_err();
            assert!(denied.contains("dedicated native"),"{category}: {denied}");
        }
        for source in ["patient_payment","supplier_payment","patient_wallet",
            "commercial_paper","financial_notice","purchase_return"," SALE_RETURN "] {
            let mut forged = input("receipt","other");
            forged.source_type = Some(source.to_string());
            assert!(post_with_lock(&mut conn,"owner-a",forged).await
                .unwrap_err().contains("dedicated native"),"{source}");
        }
        let mut forged = input("receipt","other");
        forged.sub_category = Some("accounts_payable".into());
        assert!(post_with_lock(&mut conn,"owner-a",forged).await.is_err());

        // A custom category can also be configured to point at the protected
        // account even without mentioning the account in the IPC payload.
        conn.execute("INSERT INTO trial_balance_settings(category,account_id) VALUES('cash-alias',6)")
            .await.unwrap();
        let denied = post_with_lock(&mut conn,"owner-a",input("receipt","cash-alias"))
            .await.unwrap_err();
        assert!(denied.contains("Manual cash or expense postings"),"{denied}");
        let mut forged_expense=expense("forged-expense-source");
        forged_expense.source_type=Some("supplier_payment".into());
        assert!(post_expense_with_lock(&mut conn,"owner-a",forged_expense)
            .await.unwrap_err().contains("Invalid native expense posting"));
        conn.execute("UPDATE trial_balance_settings SET account_id=6 WHERE category='expense:3'")
            .await.unwrap();
        assert!(post_expense_with_lock(&mut conn,"owner-a",expense("forged-expense-account"))
            .await.unwrap_err().contains("Manual cash or expense postings"));
        assert_eq!(count(&mut conn,"shifts").await,2);
        for table in ["cash","journals","entries","expenses","requests"] {
            assert_eq!(count(&mut conn,table).await,0,"{table}");
        }
    }

    #[tokio::test]
    async fn ambiguous_expense_reply_retry_preserves_exact_source_cash_and_double_entry_identity() {
        let mut conn = fixture().await;
        let initial = expense("same-native-money-intent-20261015");
        // The business transaction may have committed even if IPC lost the
        // receipt. The second call must never create a second native posting.
        let posted = post_expense_with_lock(&mut conn, "expenses-a", initial)
            .await
            .unwrap();
        let rejected = post_expense_with_lock(
            &mut conn,
            "expenses-a",
            expense("same-native-money-intent-20261015"),
        )
        .await
        .unwrap_err();
        assert!(rejected.contains("already posted"), "{rejected}");

        // A same-nonce *different* financial amount may not change the
        // existing source, expense, cash movement, or its ledger.
        let mut changed = expense("same-native-money-intent-20261015");
        changed.amount = 999.5;
        assert!(post_expense_with_lock(&mut conn, "owner-a", changed)
            .await
            .unwrap_err()
            .contains("already posted"));

        for name in ["expenses", "cash", "journals", "requests", "activity"] {
            assert_eq!(count(&mut conn, name).await, 1, "{name}");
        }
        assert_eq!(count(&mut conn, "entries").await, 2);

        let request: (String, String) = sqlx::query_as(
            "SELECT expense_id,pharmacy_id FROM expense_posting_requests WHERE request_id=?",
        )
        .bind("same-native-money-intent-20261015")
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(request, (posted.id.clone(), "a".to_string()));
        let expense_row: (String, String, String, f64) = sqlx::query_as(
            "SELECT user_id,pharmacy_id,category,amount FROM expenses WHERE id=?",
        )
        .bind(&posted.id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(expense_row, ("expenses-a".into(), "a".into(), "UTIL".into(), 17.5));

        let cash: (String, String, String, String, f64) = sqlx::query_as(
            "SELECT user_id,pharmacy_id,type,sub_category,amount FROM cash_movements",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(cash, (
            "expenses-a".into(), "a".into(), "disbursement".into(),
            "UTIL".into(), 17.5,
        ));
        let journal: (String, String, f64) = sqlx::query_as(
            "SELECT created_by,pharmacy_id,total_amount FROM daily_journals",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(journal, ("expenses-a".into(), "a".into(), 17.5));
        let entries: Vec<(String, i64, f64)> = sqlx::query_as(
            "SELECT type,account_id,amount FROM journal_entries ORDER BY type",
        )
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(entries, vec![
            ("credit".into(), 1, 17.5),
            ("debit".into(), 8, 17.5),
        ]);
        assert_eq!(entries[0].2, entries[1].2);
        assert_eq!(entries[0].2, cash.4);
        assert_eq!(entries[0].2, expense_row.3);
        assert_eq!(entries[0].2, journal.2);
    }

    #[tokio::test]
    async fn expense_nonce_and_balanced_posting_survive_sqlite_connection_reopen() {
        // Only a fresh, random, disposable TEMP file is written. Reopening the
        // connection is not a signed Tauri startup or license acceptance test.
        let path = std::env::temp_dir().join(format!(
            "pharma-expense-reopen-{}.sqlite",
            Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        seed_fixture(&mut conn).await;
        let nonce = "expense-reopened-lost-ack-20261015";
        let original = post_expense_with_lock(&mut conn, "expenses-a", expense(nonce))
            .await
            .unwrap();
        conn.close().await.unwrap();

        let mut reopened = SqliteConnection::connect_with(&options).await.unwrap();
        let duplicate = post_expense_with_lock(&mut reopened, "expenses-a", expense(nonce))
            .await
            .unwrap_err();
        assert!(duplicate.contains("already posted"), "{duplicate}");
        // A foreign branch cannot use the original nonce to create a second
        // posting or to change the saved receipt. No receipt lookup is exposed.
        assert!(post_expense_with_lock(&mut reopened, "owner-b", expense(nonce))
            .await
            .is_err());
        let saved: (String, String) = sqlx::query_as(
            "SELECT expense_id, pharmacy_id FROM expense_posting_requests WHERE request_id=?",
        )
        .bind(nonce)
        .fetch_one(&mut reopened)
        .await
        .unwrap();
        assert_eq!(saved, (original.id.clone(), "a".into()));
        let expense_source: (String, String, f64) = sqlx::query_as(
            "SELECT user_id, pharmacy_id, amount FROM expenses WHERE id=?",
        )
        .bind(&original.id)
        .fetch_one(&mut reopened)
        .await
        .unwrap();
        assert_eq!(expense_source, ("expenses-a".into(), "a".into(), 17.5));
        for table in ["expenses", "cash", "journals", "requests", "activity"] {
            assert_eq!(count(&mut reopened, table).await, 1, "{table}");
        }
        assert_eq!(count(&mut reopened, "entries").await, 2);
        let debits_and_credits: Vec<(String, i64, f64)> = sqlx::query_as(
            "SELECT type,account_id,amount FROM journal_entries ORDER BY type",
        )
        .fetch_all(&mut reopened)
        .await
        .unwrap();
        assert_eq!(debits_and_credits, vec![
            ("credit".into(), 1, 17.5),
            ("debit".into(), 8, 17.5),
        ]);
        let movement: (String, String, f64) = sqlx::query_as(
            "SELECT user_id,pharmacy_id,amount FROM cash_movements",
        )
        .fetch_one(&mut reopened)
        .await
        .unwrap();
        assert_eq!(movement, ("expenses-a".into(), "a".into(), 17.5));
        reopened.close().await.unwrap();
        std::fs::remove_file(&path).unwrap();
    }

    #[tokio::test]
    async fn two_expense_windows_with_the_same_nonce_commit_at_most_once() {
        // Exercise the actual SQLite writer lock and nonce uniqueness across
        // two independent connections, not a single mocked frontend callback.
        let path = std::env::temp_dir().join(format!(
            "pharma-expense-two-writers-{}.sqlite",
            Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(5));
        let mut first = SqliteConnection::connect_with(&options).await.unwrap();
        seed_fixture(&mut first).await;
        let mut second = SqliteConnection::connect_with(&options).await.unwrap();
        let nonce = "two-independent-windows-one-expense-intent";
        let (one, two) = tokio::join!(
            post_expense_with_lock(&mut first, "expenses-a", expense(nonce)),
            post_expense_with_lock(&mut second, "expenses-a", expense(nonce)),
        );
        let winners = usize::from(one.is_ok()) + usize::from(two.is_ok());
        assert_eq!(winners, 1, "first={one:?}; second={two:?}");
        let posted_id = one.ok().or_else(|| two.ok()).unwrap().id;
        let saved: (String, String) = sqlx::query_as(
            "SELECT expense_id,pharmacy_id FROM expense_posting_requests WHERE request_id=?",
        )
        .bind(nonce)
        .fetch_one(&mut first)
        .await
        .unwrap();
        assert_eq!(saved, (posted_id, "a".into()));
        for table in ["expenses", "cash", "journals", "requests", "activity"] {
            assert_eq!(count(&mut first, table).await, 1, "{table}");
        }
        assert_eq!(count(&mut first, "entries").await, 2);
        let money: (f64, f64, f64) = sqlx::query_as(
            "SELECT (SELECT amount FROM expenses),
                    (SELECT amount FROM cash_movements),
                    (SELECT total_amount FROM daily_journals)",
        )
        .fetch_one(&mut first)
        .await
        .unwrap();
        assert_eq!(money, (17.5, 17.5, 17.5));
        let ledger: Vec<(String, f64)> = sqlx::query_as(
            "SELECT type,amount FROM journal_entries ORDER BY type",
        )
        .fetch_all(&mut first)
        .await
        .unwrap();
        assert_eq!(ledger, vec![("credit".into(), 17.5), ("debit".into(), 17.5)]);
        second.close().await.unwrap();
        first.close().await.unwrap();
        std::fs::remove_file(&path).unwrap();
    }

    #[tokio::test]
    async fn parent_expense_denies_disabled_foreign_missing_role_and_invalid_inputs() {
        let mut conn = fixture().await;
        for actor in ["inactive", "denied", "not-found"] {
            assert!(post_expense_with_lock(&mut conn, actor, expense(actor))
                .await
                .is_err());
        }
        let mut bad = expense("bad");
        bad.amount = f64::NAN;
        assert!(post_expense_with_lock(&mut conn, "owner-a", bad)
            .await
            .is_err());
        let mut forged = serde_json::json!({"category":"UTIL","amount":17.5,
            "description":"Electric","date":"2026-10-11","requestId":"nonce"});
        for field in ["pharmacyId", "userId", "role", "sql", "accountId"] {
            forged[field] = serde_json::json!("branch-b");
            assert!(serde_json::from_value::<ExpensePostingInput>(forged.clone()).is_err());
            forged.as_object_mut().unwrap().remove(field);
        }
        assert_eq!(count(&mut conn, "expenses").await, 0);
        assert_eq!(count(&mut conn, "cash").await, 0);
    }

    #[tokio::test]
    async fn parent_expense_rolls_back_on_missing_account_and_credit_trigger_failure() {
        let mut conn = fixture().await;
        conn.execute(
            "CREATE TRIGGER refuse_cash_credit BEFORE INSERT ON journal_entries
          WHEN NEW.type='credit' BEGIN SELECT RAISE(ABORT,'synthetic parent failure'); END;",
        )
        .await
        .unwrap();
        assert!(
            post_expense_with_lock(&mut conn, "owner-a", expense("rollback"))
                .await
                .is_err()
        );
        for table in [
            "expenses", "cash", "journals", "entries", "requests", "activity",
        ] {
            assert_eq!(count(&mut conn, table).await, 0, "{table}");
        }
        assert_eq!(count(&mut conn, "shifts").await, 2);
        conn.execute("DROP TRIGGER refuse_cash_credit")
            .await
            .unwrap();
        conn.execute("DELETE FROM accounts WHERE code='1.1.1'")
            .await
            .unwrap();
        assert!(
            post_expense_with_lock(&mut conn, "owner-a", expense("missing-account"))
                .await
                .is_err()
        );
        assert_eq!(count(&mut conn, "expenses").await, 0);
    }

    #[tokio::test]
    async fn native_expense_list_filters_and_tenant_scope_survive_live_role_changes() {
        let mut conn = fixture().await;
        post_expense_with_lock(&mut conn, "owner-a", expense("a-1"))
            .await
            .unwrap();
        post_expense_with_lock(&mut conn, "owner-b", expense("b-1"))
            .await
            .unwrap();
        let filters = || ExpenseListFilters {
            from: Some("2026-10-01".into()),
            to: Some("2026-10-31".into()),
            category: Some("UTIL".into()),
            page: 0,
        };
        let result = read_expenses(&mut conn, "owner-a", filters())
            .await
            .unwrap();
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0]["pharmacy_id"], "a");
        assert_eq!(result.pharmacy_id, "a");
        assert_eq!(result.actor_id, "owner-a");
        assert!(read_expenses(&mut conn, "denied", filters()).await.is_err());
        assert!(read_expenses(&mut conn, "inactive", filters())
            .await
            .is_err());
        sqlx::query("UPDATE users SET role='cashier',permissions='{}' WHERE id='owner-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(read_expenses(&mut conn, "owner-a", filters())
            .await
            .is_err());
        // Synthetic stored JSON restored through a bound scalar.
        sqlx::query("UPDATE users SET permissions=? WHERE id='owner-a'")
            .bind(r#"{"can_view_expenses":true}"#)
            .execute(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            read_expenses(&mut conn, "owner-a", filters())
                .await
                .unwrap()
                .rows
                .len(),
            1
        );
        let mut invalid = filters();
        invalid.from = Some("2026-02-30".into());
        assert!(read_expenses(&mut conn, "owner-a", invalid).await.is_err());
    }

    #[tokio::test]
    async fn native_expense_history_pages_245_rows_without_losing_tenants_or_ties() {
        let mut conn = fixture().await;
        // Every matching row shares one created_at, so id is the required
        // deterministic final ordering key across page boundaries.
        for number in 0..245_u32 {
            sqlx::query(
                "INSERT INTO expenses
               (id,user_id,category,amount,description,date,pharmacy_id,created_at)
               VALUES (?,?,?,?,?,?,?,?)",
            )
            .bind(format!("exp-{number:04}"))
            .bind("owner-a")
            .bind(if number < 235 { "UTIL" } else { "RENT" })
            .bind(1.25_f64)
            .bind("Synthetic expense")
            .bind(if number < 235 {
                "2026-10-11"
            } else {
                "2026-10-10"
            })
            .bind("a")
            .bind("2026-10-11 12:00:00")
            .execute(&mut conn)
            .await
            .unwrap();
        }
        for id in ["b-one", "b-two", "b-three"] {
            sqlx::query("INSERT INTO expenses
               (id,user_id,category,amount,date,pharmacy_id) VALUES (?,'owner-b','UTIL',990,'2026-10-11','b')")
               .bind(id).execute(&mut conn).await.unwrap();
        }
        sqlx::query(
            "INSERT INTO expenses
            (id,user_id,category,amount,date,pharmacy_id) VALUES
            ('legacy','local','UTIL',5,'2026-10-11',NULL)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let filters = |page| ExpenseListFilters {
            from: None,
            to: None,
            category: None,
            page,
        };
        let first = read_expenses(&mut conn, "owner-a", filters(0))
            .await
            .unwrap();
        let next = read_expenses(&mut conn, "owner-a", filters(1))
            .await
            .unwrap();
        assert_eq!(
            (first.rows.len(), first.has_more, first.page),
            (200, true, 0)
        );
        assert_eq!((next.rows.len(), next.has_more, next.page), (45, false, 1));
        assert_eq!(first.actor_id, "owner-a");
        assert_eq!(first.pharmacy_id, "a");
        let ids: Vec<String> = first
            .rows
            .iter()
            .chain(next.rows.iter())
            .map(|row| row["id"].as_str().unwrap().to_string())
            .collect();
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), 245);
        assert_eq!(ids[0], "exp-0234");
        assert_eq!(ids[199], "exp-0035");
        assert_eq!(ids[200], "exp-0034");
        assert_eq!(ids[244], "exp-0235");
        assert!(first
            .rows
            .iter()
            .chain(next.rows.iter())
            .all(|v| v["pharmacy_id"] == "a"));
        let filtered = read_expenses(
            &mut conn,
            "owner-a",
            ExpenseListFilters {
                from: Some("2026-10-10".into()),
                to: Some("2026-10-10".into()),
                category: Some("RENT".into()),
                page: 0,
            },
        )
        .await
        .unwrap();
        assert_eq!(filtered.rows.len(), 10);
        assert!(!filtered.has_more);
        assert!(read_expenses(
            &mut conn,
            "owner-a",
            ExpenseListFilters {
                from: Some("2026-10-12".into()),
                to: Some("2026-10-10".into()),
                category: None,
                page: 0,
            }
        )
        .await
        .is_err());
        assert!(read_expenses(
            &mut conn,
            "owner-a",
            ExpenseListFilters {
                from: Some("2026-02-30".into()),
                to: None,
                category: None,
                page: 0,
            }
        )
        .await
        .is_err());
        assert!(read_expenses(
            &mut conn,
            "owner-a",
            ExpenseListFilters {
                from: None,
                to: None,
                category: Some("X\0Y".into()),
                page: 0,
            }
        )
        .await
        .is_err());
        assert!(read_expenses(&mut conn, "owner-a", filters(50))
            .await
            .is_err());
        for forged in ["actorId", "pharmacyId", "sql", "userId", "permission"] {
            let mut input = serde_json::json!({"page":0,"category":"UTIL"});
            input[forged] = serde_json::json!("b");
            assert!(serde_json::from_value::<ExpenseListFilters>(input).is_err());
        }
        assert_eq!(
            read_expenses(&mut conn, "local", filters(0))
                .await
                .unwrap()
                .rows[0]["id"],
            "legacy"
        );
        assert!(read_expenses(&mut conn, "owner-b", filters(0))
            .await
            .unwrap()
            .rows
            .iter()
            .all(|v| v["pharmacy_id"] == "b"));
    }

    #[tokio::test]
    async fn native_expense_reassignment_and_revocation_are_checked_for_every_page() {
        let mut conn = fixture().await;
        for (id, pharmacy) in [("first-a", "a"), ("second-a", "a"), ("first-b", "b")] {
            sqlx::query(
                "INSERT INTO expenses(id,user_id,category,amount,date,pharmacy_id)
                VALUES (?,'owner-b','UTIL',11,'2026-10-11',?)",
            )
            .bind(id)
            .bind(pharmacy)
            .execute(&mut conn)
            .await
            .unwrap();
        }
        let filters = || ExpenseListFilters {
            from: None,
            to: None,
            category: None,
            page: 0,
        };
        assert_eq!(
            read_expenses(&mut conn, "owner-a", filters())
                .await
                .unwrap()
                .rows
                .len(),
            2
        );
        sqlx::query("UPDATE users SET pharmacy_id='b' WHERE id='owner-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        let changed = read_expenses(&mut conn, "owner-a", filters())
            .await
            .unwrap();
        assert_eq!(changed.pharmacy_id, "b");
        assert_eq!(changed.rows.len(), 1);
        assert_eq!(changed.rows[0]["id"], "first-b");
        sqlx::query("UPDATE users SET role='cashier',permissions='{}' WHERE id='owner-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(read_expenses(&mut conn, "owner-a", filters())
            .await
            .is_err());
        sqlx::query("UPDATE users SET permissions=? WHERE id='owner-a'")
            .bind(r#"{"can_view_expenses":true}"#)
            .execute(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            read_expenses(&mut conn, "owner-a", filters())
                .await
                .unwrap()
                .rows
                .len(),
            1
        );
        sqlx::query("UPDATE users SET is_active=0 WHERE id='owner-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(read_expenses(&mut conn, "owner-a", filters())
            .await
            .is_err());
        assert!(read_expenses(&mut conn, "denied", filters()).await.is_err());
    }

    #[tokio::test]
    async fn native_expense_10001_rows_signal_overflow_and_reject_extra_pages() {
        let mut conn = fixture().await;
        sqlx::query(
            "WITH RECURSIVE rownum(n) AS (
            SELECT 1 UNION ALL SELECT n+1 FROM rownum WHERE n<10001
          ) INSERT INTO expenses (id,user_id,category,amount,date,pharmacy_id,created_at)
            SELECT printf('row-%06d',n),'owner-a','UTIL',1,'2026-10-11','a',
                   '2026-10-11 00:00:00' FROM rownum",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let page = read_expenses(
            &mut conn,
            "owner-a",
            ExpenseListFilters {
                from: None,
                to: None,
                category: None,
                page: 49,
            },
        )
        .await
        .unwrap();
        assert_eq!(page.rows.len(), 200);
        assert!(page.has_more);
        assert!(read_expenses(
            &mut conn,
            "owner-a",
            ExpenseListFilters {
                from: None,
                to: None,
                category: None,
                page: 50,
            }
        )
        .await
        .is_err());
    }

    fn paper(id: &str, status: &str) -> PaperStatusInput {
        PaperStatusInput {
            id: id.into(),
            new_status: status.into(),
            action_date: "2026-10-11".into(),
        }
    }

    fn new_paper(nonce: &str, bank: Option<i64>) -> PaperCreateInput {
        PaperCreateInput {
            paper_type: "check".into(),
            direction: "in".into(),
            paper_number: "CHK-102".into(),
            bank_id: bank,
            amount: 135.5,
            due_date: "2026-11-15".into(),
            target_name: "Supplier A".into(),
            notes: Some("Synthetic note".into()),
            request_id: nonce.into(),
        }
    }

    #[tokio::test]
    async fn paper_creation_scopes_bank_and_replay_with_balanced_lifecycle_parity() {
        let mut conn = fixture().await;
        let created =
            create_paper_with_lock(&mut conn, "owner-a", new_paper("new-request", Some(1)))
                .await
                .unwrap();
        let scope: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM commercial_papers WHERE id=?")
                .bind(&created.id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(scope, "a");
        assert!(
            create_paper_with_lock(&mut conn, "owner-a", new_paper("new-request", Some(1)))
                .await
                .unwrap_err()
                .contains("already processed")
        );
        assert!(
            create_paper_with_lock(&mut conn, "owner-a", new_paper("foreign-bank", Some(2)))
                .await
                .is_err()
        );
        assert!(
            create_paper_with_lock(&mut conn, "owner-a", new_paper("foreign-bank", Some(3)))
                .await
                .is_err()
        );
        let listed = read_papers(&mut conn, "owner-a", PaperPageInput { page: 0 })
            .await
            .unwrap();
        assert!(listed.rows.iter().any(|p| p["id"] == created.id));
        assert!(listed.rows.iter().all(|p| p["pharmacy_id"] == "a"));
        update_paper_status_with_lock(&mut conn, "owner-a", paper(&created.id, "cashed"))
            .await
            .unwrap();
        assert!(
            delete_paper_with_lock(&mut conn, "owner-a", PaperDeleteInput { id: created.id })
                .await
                .is_err()
        );
        assert_eq!(count(&mut conn, "cash").await, 1);
        assert_eq!(count(&mut conn, "entries").await, 2);
    }

    #[tokio::test]
    async fn paper_native_operations_reject_disabled_reassigned_roles_and_forged_payload() {
        let mut conn = fixture().await;
        for actor in ["inactive", "denied", "not-found"] {
            assert!(
                create_paper_with_lock(&mut conn, actor, new_paper(actor, None))
                    .await
                    .is_err()
            );
            assert!(read_papers(&mut conn, actor, PaperPageInput { page: 0 })
                .await
                .is_err());
            assert!(delete_paper_with_lock(
                &mut conn,
                actor,
                PaperDeleteInput {
                    id: "incoming-a".into()
                }
            )
            .await
            .is_err());
        }
        assert!(delete_paper_with_lock(
            &mut conn,
            "owner-a",
            PaperDeleteInput {
                id: "foreign-b".into()
            }
        )
        .await
        .is_err());
        assert!(
            read_papers(&mut conn, "owner-a", PaperPageInput { page: 500 })
                .await
                .is_err()
        );
        let mut malformed = serde_json::json!({"paperType":"check","direction":"in",
            "paperNumber":"A","amount":20,"dueDate":"2026-10-11",
            "targetName":"A","requestId":"nonce"});
        for field in ["pharmacyId", "userId", "role", "accountId", "sql"] {
            malformed[field] = serde_json::json!("b");
            assert!(serde_json::from_value::<PaperCreateInput>(malformed.clone()).is_err());
            malformed.as_object_mut().unwrap().remove(field);
        }
        let mut bad = new_paper("bad", None);
        bad.amount = f64::INFINITY;
        assert!(create_paper_with_lock(&mut conn, "owner-a", bad)
            .await
            .is_err());
        let mut bad = new_paper("bad", None);
        bad.due_date = "2026-02-30".into();
        assert!(create_paper_with_lock(&mut conn, "owner-a", bad)
            .await
            .is_err());
        conn.execute("UPDATE users SET role='cashier',permissions='{}' WHERE id='owner-a'")
            .await
            .unwrap();
        assert!(
            create_paper_with_lock(&mut conn, "owner-a", new_paper("reassigned", None))
                .await
                .is_err()
        );
        assert!(
            read_papers(&mut conn, "owner-a", PaperPageInput { page: 0 })
                .await
                .is_err()
        );
        assert_eq!(count(&mut conn, "cash").await, 0);
        let requests: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM commercial_paper_create_requests")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(requests, 0);
    }

    #[tokio::test]
    async fn paper_create_and_delete_are_atomic_and_preserve_historic_cash_anchor() {
        let mut conn = fixture().await;
        conn.execute("CREATE TRIGGER refuse_paper_log BEFORE INSERT ON activity_log
          WHEN NEW.action='ADD_COMMERCIAL_PAPER' BEGIN SELECT RAISE(ABORT,'synthetic paper audit failure'); END")
          .await.unwrap();
        assert!(
            create_paper_with_lock(&mut conn, "owner-a", new_paper("rollback", None))
                .await
                .is_err()
        );
        let requests: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM commercial_paper_create_requests")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(requests, 0);
        let new_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM commercial_papers WHERE paper_number='CHK-102'",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(new_rows, 0);
        conn.execute("DROP TRIGGER refuse_paper_log").await.unwrap();
        let first = create_paper_with_lock(&mut conn, "owner-a", new_paper("persisted", None))
            .await
            .unwrap();
        conn.execute("CREATE TRIGGER refuse_paper_delete_log BEFORE INSERT ON activity_log
          WHEN NEW.action='DELETE_PAPER' BEGIN SELECT RAISE(ABORT,'synthetic delete audit failure'); END").await.unwrap();
        assert!(delete_paper_with_lock(
            &mut conn,
            "owner-a",
            PaperDeleteInput {
                id: first.id.clone()
            }
        )
        .await
        .is_err());
        assert!(
            read_papers(&mut conn, "owner-a", PaperPageInput { page: 0 })
                .await
                .unwrap()
                .rows
                .iter()
                .any(|p| p["id"] == first.id)
        );
        conn.execute("DROP TRIGGER refuse_paper_delete_log")
            .await
            .unwrap();
        conn.execute("INSERT INTO cash_movements(id,user_id,type,category,amount,source_type,target_name,pharmacy_id)
          VALUES('historic-paper-posting','owner-a','receipt','collection',135.5,'commercial_paper',
          (SELECT paper_id FROM commercial_paper_create_requests WHERE request_id='persisted'),'a')")
          .await.unwrap();
        assert!(delete_paper_with_lock(
            &mut conn,
            "owner-a",
            PaperDeleteInput {
                id: first.id.clone()
            }
        )
        .await
        .unwrap_err()
        .contains("manual reconciliation"));
        conn.execute("DELETE FROM cash_movements WHERE id='historic-paper-posting'")
            .await
            .unwrap();
        delete_paper_with_lock(&mut conn, "owner-a", PaperDeleteInput { id: first.id })
            .await
            .unwrap();
        assert!(
            create_paper_with_lock(&mut conn, "owner-a", new_paper("persisted", None))
                .await
                .unwrap_err()
                .contains("already processed")
        );
    }

    #[tokio::test]
    async fn paper_read_pages_are_bounded_scoped_and_reject_role_change() {
        let mut conn = fixture().await;
        for i in 0..205 {
            sqlx::query("INSERT INTO commercial_papers(id,type,direction,paper_number,target_name,amount,status,pharmacy_id,due_date)
              VALUES(?,'check','in',?,'A',1,'pending','a','2026-10-11')")
              .bind(format!("synthetic-{i:04}")).bind(format!("{i:04}"))
              .execute(&mut conn).await.unwrap();
        }
        let a = read_papers(&mut conn, "owner-a", PaperPageInput { page: 0 })
            .await
            .unwrap();
        let b = read_papers(&mut conn, "owner-a", PaperPageInput { page: 1 })
            .await
            .unwrap();
        let c = read_papers(&mut conn, "owner-a", PaperPageInput { page: 2 })
            .await
            .unwrap();
        // Three existing branch-A papers plus 205 new rows.
        assert_eq!((a.rows.len(), b.rows.len(), c.rows.len()), (100, 100, 8));
        assert!(a.has_more && b.has_more && !c.has_more);
        assert!(a
            .rows
            .iter()
            .chain(b.rows.iter())
            .chain(c.rows.iter())
            .all(|p| p["pharmacy_id"] == "a"));
        conn.execute("UPDATE users SET is_active=0 WHERE id='owner-a'")
            .await
            .unwrap();
        assert!(
            read_papers(&mut conn, "owner-a", PaperPageInput { page: 0 })
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn simultaneous_paper_creation_with_same_nonce_posts_once_across_connections() {
        let mut path = std::env::temp_dir();
        path.push(format!("pharma-paper-replay-{}.sqlite", Uuid::new_v4()));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(Duration::from_secs(8));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .unwrap();
        let mut setup = pool.acquire().await.unwrap();
        seed_fixture(&mut setup).await;
        drop(setup);
        let p1 = pool.clone();
        let p2 = pool.clone();
        let (first, second) = tokio::join!(
            async move {
                let mut conn = p1.acquire().await.unwrap();
                create_paper_with_lock(&mut conn, "owner-a", new_paper("same-nonce", Some(1))).await
            },
            async move {
                let mut conn = p2.acquire().await.unwrap();
                create_paper_with_lock(&mut conn, "owner-a", new_paper("same-nonce", Some(1))).await
            },
        );
        assert_ne!(first.is_ok(), second.is_ok());
        let mut conn = pool.acquire().await.unwrap();
        let paper_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM commercial_papers WHERE paper_number='CHK-102'",
        )
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        let nonce_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM commercial_paper_create_requests WHERE request_id='same-nonce'",
        )
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        assert_eq!((paper_count, nonce_count), (1, 1));
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

    #[tokio::test]
    async fn paper_transition_posts_one_balanced_tenant_journal_and_denies_replay() {
        let mut conn = fixture().await;
        let first =
            update_paper_status_with_lock(&mut conn, "owner-a", paper("incoming-a", "cashed"))
                .await
                .unwrap();
        assert!(first.changed);
        assert_eq!(count(&mut conn, "cash").await, 1);
        assert_eq!(count(&mut conn, "journals").await, 1);
        assert_eq!(count(&mut conn, "entries").await, 2);
        let second =
            update_paper_status_with_lock(&mut conn, "owner-a", paper("incoming-a", "cashed"))
                .await
                .unwrap();
        assert!(!second.changed);
        assert_eq!(count(&mut conn, "cash").await, 1);
        assert!(update_paper_status_with_lock(
            &mut conn,
            "owner-a",
            paper("incoming-a", "bounced")
        )
        .await
        .unwrap_err()
        .contains("reversal"));
        let entry: Vec<i64> =
            sqlx::query_scalar("SELECT account_id FROM journal_entries ORDER BY id")
                .fetch_all(&mut conn)
                .await
                .unwrap();
        // The configured 'collection' account (9) takes precedence over the
        // canonical receivables fallback (2), matching cash posting policy.
        assert_eq!(entry, vec![1, 9]);
        let second =
            update_paper_status_with_lock(&mut conn, "owner-a", paper("outgoing-a", "cashed"))
                .await
                .unwrap();
        assert!(second.changed);
        let debit: i64 = sqlx::query_scalar(
            "SELECT account_id FROM journal_entries WHERE type='debit' ORDER BY id DESC LIMIT 1",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(debit, 6);
        let pharmacy: Vec<String> =
            sqlx::query_scalar("SELECT pharmacy_id FROM daily_journals ORDER BY id")
                .fetch_all(&mut conn)
                .await
                .unwrap();
        assert_eq!(pharmacy, vec!["a".to_string(), "a".to_string()]);
    }

    #[tokio::test]
    async fn paper_transition_does_not_accept_forged_tenant_disabled_role_or_foreign_id() {
        let mut conn = fixture().await;
        for actor in ["denied", "inactive", "not-found"] {
            assert!(
                update_paper_status_with_lock(&mut conn, actor, paper("incoming-a", "cashed"))
                    .await
                    .is_err()
            );
        }
        assert!(
            update_paper_status_with_lock(&mut conn, "owner-a", paper("foreign-b", "cashed"))
                .await
                .is_err()
        );
        let mut forged =
            serde_json::json!({"id":"incoming-a","newStatus":"cashed","actionDate":"2026-10-11"});
        for claim in ["userId", "pharmacyId", "accountId", "role", "sql"] {
            forged[claim] = serde_json::json!("b");
            assert!(serde_json::from_value::<PaperStatusInput>(forged.clone()).is_err());
            forged.as_object_mut().unwrap().remove(claim);
        }
        assert_eq!(count(&mut conn, "cash").await, 0);
        assert_eq!(count(&mut conn, "papers_cashed").await, 1);
    }

    #[tokio::test]
    async fn failed_paper_credit_entry_rolls_back_status_shift_cash_and_journal() {
        let mut conn = fixture().await;
        conn.execute(
            "CREATE TRIGGER refuse_paper_credit BEFORE INSERT ON journal_entries
          WHEN NEW.type='credit' BEGIN SELECT RAISE(ABORT,'synthetic credit failure'); END;",
        )
        .await
        .unwrap();
        assert!(
            update_paper_status_with_lock(&mut conn, "owner-a", paper("incoming-a", "cashed"))
                .await
                .is_err()
        );
        assert_eq!(count(&mut conn, "cash").await, 0);
        assert_eq!(count(&mut conn, "journals").await, 0);
        assert_eq!(count(&mut conn, "entries").await, 0);
        assert_eq!(count(&mut conn, "shifts").await, 2);
        let status: String =
            sqlx::query_scalar("SELECT status FROM commercial_papers WHERE id='incoming-a'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(status, "pending");
    }

    #[tokio::test]
    async fn historic_partially_posted_paper_cannot_generate_second_cash_movement() {
        let mut conn = fixture().await;
        conn.execute("INSERT INTO cash_movements(id,user_id,type,category,amount,source_type,target_name,pharmacy_id)
           VALUES('historical-paper-cash','owner-a','receipt','collection',25,'commercial_paper','incoming-a','a')")
           .await.unwrap();
        let err =
            update_paper_status_with_lock(&mut conn, "owner-a", paper("incoming-a", "cashed"))
                .await
                .unwrap_err();
        assert!(err.contains("manual reconciliation"), "{err}");
        let status: String =
            sqlx::query_scalar("SELECT status FROM commercial_papers WHERE id='incoming-a'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(status, "pending");
        assert_eq!(count(&mut conn, "cash").await, 1);
        assert_eq!(count(&mut conn, "journals").await, 0);
    }
    #[tokio::test]
    async fn receipt_and_disbursement_post_balanced_and_scoped() {
        let mut conn = fixture().await;
        let posted = post_with_lock(&mut conn, "cashier-a", input("receipt", "other"))
            .await
            .unwrap();
        assert_eq!(count(&mut conn, "shifts").await, 3);
        assert_eq!(count(&mut conn, "cash").await, 1);
        assert_eq!(count(&mut conn, "journals").await, 1);
        assert_eq!(count(&mut conn, "entries").await, 2);
        let amounts: Vec<(String, i64, f64)> =
            sqlx::query("SELECT type,account_id,amount FROM journal_entries ORDER BY id")
                .fetch_all(&mut conn)
                .await
                .unwrap()
                .iter()
                .map(|row| (row.get("type"), row.get("account_id"), row.get("amount")))
                .collect();
        assert_eq!(
            amounts,
            vec![("debit".into(), 1, 12.5), ("credit".into(), 4, 12.5)]
        );
        let pharmacy: String =
            sqlx::query_scalar("SELECT pharmacy_id FROM cash_movements WHERE id=?")
                .bind(posted.id)
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(pharmacy, "a");
        let mut out = input("disbursement", "operating_expenses");
        out.sub_category = Some("UTIL".into());
        let second = post_with_lock(&mut conn, "expenses-a", out).await.unwrap();
        assert_eq!(second.shift_id, posted.shift_id);
        let last: Vec<i64> = sqlx::query_scalar(
            "SELECT account_id FROM journal_entries WHERE journal_id=? ORDER BY id",
        )
        .bind(second.journal_id)
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(last, vec![8, 1]);
        assert_eq!(count(&mut conn, "shifts").await, 3);
    }
    #[tokio::test]
    async fn targeted_mapping_and_closed_foreign_shift_never_cross_scope() {
        let mut conn = fixture().await;
        let mut targeted = input("receipt", "targeted_misc");
        targeted.target_name = Some("Specific".into());
        targeted.shift_id = Some("foreign".into());
        let posted = post_with_lock(&mut conn, "owner-a", targeted)
            .await
            .unwrap();
        assert_ne!(posted.shift_id, "foreign");
        let credit: i64 = sqlx::query_scalar(
            "SELECT account_id FROM journal_entries WHERE journal_id=? AND type='credit'",
        )
        .bind(posted.journal_id)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(credit, 9);
        let mut stale = input("receipt", "targeted_misc");
        stale.shift_id = Some("old-a".into());
        assert_eq!(
            post_with_lock(&mut conn, "owner-a", stale)
                .await
                .unwrap()
                .shift_id,
            posted.shift_id
        );
    }
    #[tokio::test]
    async fn rejects_inactive_denied_bad_payload_and_missing_accounts_with_full_rollback() {
        let mut conn = fixture().await;
        for actor in ["inactive", "denied", "not-found"] {
            assert!(
                post_with_lock(&mut conn, actor, input("receipt", "collection"))
                    .await
                    .is_err()
            );
        }
        assert!(
            post_with_lock(&mut conn, "expenses-a", input("receipt", "collection"))
                .await
                .is_err()
        );
        for invalid in [f64::NAN, f64::INFINITY, 0.0, -10.0] {
            let mut value = input("receipt", "collection");
            value.amount = invalid;
            assert!(post_with_lock(&mut conn, "owner-a", value).await.is_err());
        }
        let mut invalid = input("receipt", "collection");
        invalid.date = "2026-02-30".into();
        assert!(post_with_lock(&mut conn, "owner-a", invalid).await.is_err());
        let mut invalid = input("refund", "collection");
        invalid.shift_id = Some("foreign".into());
        assert!(post_with_lock(&mut conn, "owner-a", invalid).await.is_err());
        assert!(
            post_with_lock(&mut conn, "owner-a", input("receipt", "unknown-category"))
                .await
                .is_err()
        );
        assert_eq!(count(&mut conn, "shifts").await, 2);
        assert_eq!(count(&mut conn, "cash").await, 0);
        assert_eq!(count(&mut conn, "journals").await, 0);
        assert_eq!(count(&mut conn, "entries").await, 0);
        sqlx::query("DELETE FROM accounts WHERE code='1.1.1'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            post_with_lock(&mut conn, "owner-a", input("receipt", "other"))
                .await
                .is_err()
        );
        assert_eq!(count(&mut conn, "shifts").await, 2);
        assert_eq!(count(&mut conn, "cash").await, 0);
    }
    #[tokio::test]
    async fn after_write_error_every_table_and_shift_rolls_back() {
        let mut conn = fixture().await;
        conn.execute(
            r#"CREATE TRIGGER refuse_credit BEFORE INSERT ON journal_entries
              WHEN NEW.type='credit' BEGIN SELECT RAISE(ABORT,'synthetic credit error'); END"#,
        )
        .await
        .unwrap();
        assert!(
            post_with_lock(&mut conn, "owner-a", input("receipt", "other"))
                .await
                .is_err()
        );
        assert_eq!(count(&mut conn, "cash").await, 0);
        assert_eq!(count(&mut conn, "shifts").await, 2);
        assert_eq!(count(&mut conn, "journals").await, 0);
        assert_eq!(count(&mut conn, "entries").await, 0);
    }
    #[tokio::test]
    async fn sequential_repeat_has_distinct_ids_one_shared_shift_and_live_role_change_denies() {
        let mut conn = fixture().await;
        let first = post_with_lock(&mut conn, "owner-a", input("receipt", "other"))
            .await
            .unwrap();
        let second = post_with_lock(&mut conn, "owner-a", input("receipt", "other"))
            .await
            .unwrap();
        assert_ne!(first.id, second.id);
        assert_ne!(first.journal_id, second.journal_id);
        assert_eq!(first.shift_id, second.shift_id);
        assert_eq!(count(&mut conn, "shifts").await, 3);
        sqlx::query("UPDATE users SET role='cashier',permissions='{}' WHERE id='owner-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            post_with_lock(&mut conn, "owner-a", input("receipt", "other"))
                .await
                .is_err()
        );
        assert_eq!(count(&mut conn, "cash").await, 2);
    }

    #[tokio::test]
    async fn concurrent_postings_serialize_the_same_open_shift_and_both_journals() {
        // Independent SQLite connections against one throwaway database
        // exercise the real BEGIN IMMEDIATE writer-lock boundary.
        let mut path = std::env::temp_dir();
        path.push(format!(
            "pharma-finance-native-test-{}.sqlite",
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
        let mut seeded = pool.acquire().await.unwrap();
        seed_fixture(&mut seeded).await;
        drop(seeded);
        let first_pool = pool.clone();
        let second_pool = pool.clone();
        let (first, second) = tokio::join!(
            async move {
                let mut conn = first_pool.acquire().await.unwrap();
                post_with_lock(&mut conn, "cashier-a", input("receipt", "other")).await
            },
            async move {
                let mut conn = second_pool.acquire().await.unwrap();
                post_with_lock(&mut conn, "cashier-a", input("receipt", "other")).await
            },
        );
        let first = first.unwrap();
        let second = second.unwrap();
        assert_ne!(first.id, second.id);
        assert_ne!(first.journal_id, second.journal_id);
        assert_eq!(first.shift_id, second.shift_id);
        let mut conn = pool.acquire().await.unwrap();
        assert_eq!(count(&mut conn, "shifts").await, 3);
        assert_eq!(count(&mut conn, "cash").await, 2);
        assert_eq!(count(&mut conn, "journals").await, 2);
        assert_eq!(count(&mut conn, "entries").await, 4);
        drop(conn);
        pool.close().await;
        drop(pool);
        // Windows may release SQLite file handles just after pool.close().
        // Cleanup is best effort and is not part of posting correctness.
        for _ in 0..20 {
            if std::fs::remove_file(&path).is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
