//! Fixed, tenant-scoped read-only projections for finance ledgers.
//! Untrusted renderer filters are scalar predicates, never SQL, actor or pharmacy.

use serde::Serialize;
use serde_json::{json, Value};
use sqlx::SqliteConnection;
use std::time::Duration;
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::{fetch_scoped_limited, reset_cancelled_read_state, ReadLimits};
use super::permission_policy::user_has_permission;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FinanceProjection {
    CashMovements,
    Journals,
    JournalEntries,
    AccountsChart,
    TrialBalance,
    TreasuryCashLedger,
}

impl FinanceProjection {
    fn parse(key: &str) -> Result<Self, String> {
        match key {
            "cash_movements" => Ok(Self::CashMovements),
            "journals" => Ok(Self::Journals),
            "journal_entries" => Ok(Self::JournalEntries),
            "accounts_chart" => Ok(Self::AccountsChart),
            "trial_balance" => Ok(Self::TrialBalance),
            "treasury_cash_ledger" => Ok(Self::TreasuryCashLedger),
            _ => Err("Unknown native finance projection".into()),
        }
    }
}

#[derive(Default)]
struct FinanceFilters<'a> {
    movement_type: Option<&'a str>,
    category: Option<&'a str>,
    date_from: Option<&'a str>,
    date_to: Option<&'a str>,
    journal_id: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceReadPage {
    actor_id: String,
    pharmacy_id: String,
    rows: Vec<Value>,
}

fn valid_calendar_date(value: &str) -> bool {
    if value.len() != 10
        || value.as_bytes()[4] != b'-'
        || value.as_bytes()[7] != b'-'
        || value
            .bytes()
            .enumerate()
            .any(|(i, b)| i != 4 && i != 7 && !b.is_ascii_digit())
    {
        return false;
    }
    let year = value[0..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<u32>().unwrap_or(0);
    let day = value[8..10].parse::<u32>().unwrap_or(0);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    year > 0 && day > 0 && day <= max_day
}

fn validate_filters(kind: FinanceProjection, filters: &FinanceFilters<'_>) -> Result<(), String> {
    if filters
        .date_from
        .is_some_and(|date| !valid_calendar_date(date))
        || filters
            .date_to
            .is_some_and(|date| !valid_calendar_date(date))
    {
        return Err("Invalid finance calendar date".into());
    }
    if filters
        .date_from
        .zip(filters.date_to)
        .is_some_and(|(a, b)| a > b)
    {
        return Err("Finance date range is reversed".into());
    }
    if filters.category.is_some_and(|value| {
        value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control)
    }) {
        return Err("Invalid finance category".into());
    }
    if filters.journal_id.is_some_and(|id| {
        id.trim().is_empty() || id.len() > 128 || id.chars().any(char::is_control)
    }) {
        return Err("Invalid journal identifier".into());
    }
    match kind {
        FinanceProjection::CashMovements
            if filters.journal_id.is_some()
                || filters
                    .movement_type
                    .is_some_and(|value| !matches!(value, "receipt" | "disbursement")) =>
        {
            Err("Invalid cash movement filters".into())
        }
        FinanceProjection::Journals
            if filters.movement_type.is_some()
                || filters.category.is_some()
                || filters.journal_id.is_some() =>
        {
            Err("Unexpected journal list filter".into())
        }
        FinanceProjection::JournalEntries
            if filters.journal_id.is_none()
                || filters.movement_type.is_some()
                || filters.category.is_some()
                || filters.date_from.is_some()
                || filters.date_to.is_some() =>
        {
            Err("Journal entry projection accepts an ID only".into())
        }
        FinanceProjection::AccountsChart
            if filters.movement_type.is_some()
                || filters.category.is_some()
                || filters.journal_id.is_some()
                || filters.date_from.is_some()
                || filters.date_to.is_some() =>
        {
            Err("Account chart projection accepts no renderer filters".into())
        }
        FinanceProjection::TrialBalance
            if filters.movement_type.is_some()
                || filters.category.is_some()
                || filters.journal_id.is_some() =>
        {
            Err("Trial balance projection accepts date filters only".into())
        }
        FinanceProjection::TreasuryCashLedger
            if filters.movement_type.is_some()
                || filters.category.is_some()
                || filters.journal_id.is_some()
                || filters.date_from.is_some()
                || filters.date_to.is_some() =>
        {
            Err("Treasury ledger projection accepts no renderer filters".into())
        }
        _ => Ok(()),
    }
}

// The global chart is reference metadata, but its balances must never silently
// exclude orphan postings or ambiguous historical ownerless journals. A
// local_default header belongs to the separate legacy bucket; it cannot be
// attributed to an independently explicit tenant. Native reports include only
// that tenant's headers and do not certify complete historical balances.
async fn verify_accounting_sources(
    conn: &mut SqliteConnection,
    actor_id: &str,
    pharmacy_id: &str,
) -> Result<(), String> {
    let explicit: Option<String> = sqlx::query_scalar(
        "SELECT pharmacy_id FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if pharmacy_id == "local_default"
        || explicit.as_deref() != Some(pharmacy_id)
        || pharmacy_id.is_empty()
    {
        return Err("Finance reporting requires independently explicit tenant ownership".into());
    }
    let legacy: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.daily_journals WHERE pharmacy_id IS NULL OR TRIM(pharmacy_id)=''",
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if legacy > 0 {
        return Err(
            "Unreconciled legacy finance journal ownership prevents complete reporting".into(),
        );
    }
    // Validate the entire input ledger (including potential orphan entries)
    // before GROUP BY or LEFT JOIN could turn missing sources into false zeros.
    let broken: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM main.journal_entries e
           LEFT JOIN main.daily_journals j ON j.id=e.journal_id
           LEFT JOIN main.accounts a ON a.id=e.account_id
           WHERE j.id IS NULL OR a.id IS NULL OR e.type IS NULL
              OR e.type NOT IN ('debit','credit')
              OR typeof(e.amount) NOT IN ('integer','real') OR e.amount < 0
              OR e.amount > 1e15 OR j.pharmacy_id IS NULL
              OR j.date IS NULL OR date(j.date) IS NULL
              OR a.is_group IS NULL OR a.is_group != 0"#,
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if broken > 0 {
        return Err("Unverifiable finance journal entry source prevents complete reporting".into());
    }
    let bad_headers: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM main.daily_journals j
           WHERE j.date IS NULL OR date(j.date) IS NULL
              OR typeof(j.total_amount) NOT IN ('real','integer')
              OR j.total_amount < 0 OR j.total_amount > 1e15
              OR NOT EXISTS (SELECT 1 FROM main.journal_entries e WHERE e.journal_id=j.id)
              OR ABS((SELECT COALESCE(SUM(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END),0)
                       FROM main.journal_entries e WHERE e.journal_id=j.id)
                   -(SELECT COALESCE(SUM(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END),0)
                       FROM main.journal_entries e WHERE e.journal_id=j.id)) > 0.005"#,
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if bad_headers > 0 {
        return Err("Unbalanced or incomplete finance journal prevents complete reporting".into());
    }
    let bad_accounts: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM main.accounts a WHERE a.id <= 0 OR a.code IS NULL
           OR TRIM(a.code)='' OR a.name_ar IS NULL OR TRIM(a.name_ar)=''
           OR a.type IS NULL OR a.type NOT IN ('asset','expense','liability','equity','revenue','income')
           OR a.is_group IS NULL OR a.is_group NOT IN (0,1) OR (a.parent_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM main.accounts p WHERE p.id=a.parent_id))"#,
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if bad_accounts > 0 {
        return Err("Invalid chart of accounts prevents complete reporting".into());
    }
    Ok(())
}

async fn read_finance_projection(
    conn: &mut SqliteConnection,
    actor_id: &str,
    key: &str,
    filters: FinanceFilters<'_>,
    limit: u32,
    offset: u32,
) -> Result<FinanceReadPage, String> {
    let kind = FinanceProjection::parse(key)?;
    if !(1..=200).contains(&limit) || offset > 50_000 {
        return Err("Finance read requires a page of 1-200 rows and offset at most 50000".into());
    }
    validate_filters(kind, &filters)?;
    reset_cancelled_read_state(conn).await?;
    // Database row and live permission check, not the renderer's stale session role/pharmacy.
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let permissions: Option<String> = sqlx::query_scalar(
        "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    )
    .bind(actor_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| err.to_string())?;
    let required = match kind {
        FinanceProjection::CashMovements => ["acc_can_process_cash_flow", "acc_can_view_general"],
        FinanceProjection::Journals | FinanceProjection::JournalEntries => {
            ["acc_can_make_daily_entries", "acc_can_view_reports"]
        }
        FinanceProjection::AccountsChart => ["acc_can_view_general", "acc_can_make_daily_entries"],
        FinanceProjection::TrialBalance => ["acc_can_view_reports", "acc_can_view_reports"],
        FinanceProjection::TreasuryCashLedger => ["acc_can_process_cash_flow", "acc_can_view_general"],
    };
    if !required
        .iter()
        .any(|key| user_has_permission(Some(&role), permissions.as_deref(), key, false))
    {
        return Err("Authenticated user cannot read this finance projection".into());
    }

    if matches!(
        kind,
        FinanceProjection::AccountsChart | FinanceProjection::TrialBalance | FinanceProjection::TreasuryCashLedger
    ) {
        verify_accounting_sources(conn, actor_id, &pharmacy_id).await?;
    }

    // All three SQL statements are fixed literals. Tenant ownership is proven
    // by the transaction's snapshotted pharmacy_id; do not infer it from staff,
    // shift or patient relations that may have changed after posting.
    let (sql, binds): (&str, Vec<Value>) = match kind {
        FinanceProjection::CashMovements => (
            r#"
            SELECT cm.*, COALESCE(u.full_name,u.username,cm.user_id) AS user_name,
                   s.status AS shift_status
            FROM main.cash_movements cm
            LEFT JOIN main.users u ON CAST(u.id AS TEXT)=CAST(cm.user_id AS TEXT)
                 AND (u.pharmacy_id=? OR (u.pharmacy_id IS NULL AND ?='local_default'))
            LEFT JOIN main.shifts s ON s.id=cm.shift_id
                 AND (s.pharmacy_id=? OR (s.pharmacy_id IS NULL AND ?='local_default'))
            WHERE (cm.pharmacy_id=? OR (cm.pharmacy_id IS NULL AND ?='local_default'))
              AND (? IS NULL OR cm.type=?)
              AND (? IS NULL OR cm.category=?)
              AND (? IS NULL OR date(cm.date)>=date(?))
              AND (? IS NULL OR date(cm.date)<=date(?))
            ORDER BY cm.created_at DESC, cm.id DESC
            LIMIT ? OFFSET ?
        "#,
            vec![
                json!(pharmacy_id),
                json!(pharmacy_id),
                json!(pharmacy_id),
                json!(pharmacy_id),
                json!(pharmacy_id),
                json!(pharmacy_id),
                json!(filters.movement_type),
                json!(filters.movement_type),
                json!(filters.category),
                json!(filters.category),
                json!(filters.date_from),
                json!(filters.date_from),
                json!(filters.date_to),
                json!(filters.date_to),
                json!(limit),
                json!(offset),
            ],
        ),
        FinanceProjection::Journals => (
            r#"
            SELECT dj.* FROM main.daily_journals dj
            WHERE (dj.pharmacy_id=? OR (dj.pharmacy_id IS NULL AND ?='local_default'))
              AND (? IS NULL OR date(dj.date)>=date(?))
              AND (? IS NULL OR date(dj.date)<=date(?))
            ORDER BY dj.date DESC, dj.created_at DESC, dj.id DESC
            LIMIT ? OFFSET ?
        "#,
            vec![
                json!(pharmacy_id),
                json!(pharmacy_id),
                json!(filters.date_from),
                json!(filters.date_from),
                json!(filters.date_to),
                json!(filters.date_to),
                json!(limit),
                json!(offset),
            ],
        ),
        FinanceProjection::JournalEntries => (
            r#"
            SELECT e.*, a.name_ar AS account_name, a.code AS account_code,
                   dj.description, dj.date,
                   CASE WHEN e.type='debit' THEN e.amount ELSE 0 END AS debit,
                   CASE WHEN e.type='credit' THEN e.amount ELSE 0 END AS credit
            FROM main.journal_entries e
            JOIN main.daily_journals dj ON e.journal_id=dj.id
            JOIN main.accounts a ON e.account_id=a.id
            WHERE e.journal_id=?
              AND (dj.pharmacy_id=? OR (dj.pharmacy_id IS NULL AND ?='local_default'))
            ORDER BY e.type DESC,e.amount DESC,e.id DESC
            LIMIT ? OFFSET ?
        "#,
            vec![
                json!(filters.journal_id),
                json!(pharmacy_id),
                json!(pharmacy_id),
                json!(limit),
                json!(offset),
            ],
        ),
        FinanceProjection::AccountsChart => (
            r#"WITH movements AS (
                SELECT e.account_id,
                  SUM(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END) AS debit,
                  SUM(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END) AS credit
                FROM main.journal_entries e
                JOIN main.daily_journals j ON j.id=e.journal_id
                WHERE j.pharmacy_id=? GROUP BY e.account_id
               )
               SELECT a.id,a.parent_id,a.code,a.name_ar,a.name_en,a.type,a.is_group,
                  COALESCE(m.debit,0) AS debit,COALESCE(m.credit,0) AS credit,
                  CASE WHEN a.is_group=1 THEN 0
                       WHEN a.type IN ('asset','expense')
                       THEN COALESCE(m.debit,0)-COALESCE(m.credit,0)
                       ELSE COALESCE(m.credit,0)-COALESCE(m.debit,0)
                  END AS balance
               FROM main.accounts a LEFT JOIN movements m ON m.account_id=a.id
               ORDER BY a.code ASC,a.id ASC LIMIT ? OFFSET ?"#,
            vec![json!(pharmacy_id), json!(limit), json!(offset)],
        ),
        FinanceProjection::TrialBalance => (
            r#"WITH entries AS (
                SELECT e.account_id,e.type,e.amount,j.date AS entry_date
                FROM main.journal_entries e
                JOIN main.daily_journals j ON j.id=e.journal_id
                WHERE j.pharmacy_id=?
               ), totals AS (
                SELECT account_id,
                  SUM(CASE WHEN ? IS NOT NULL AND entry_date<? AND type='debit' THEN amount ELSE 0 END) AS opening_debit,
                  SUM(CASE WHEN ? IS NOT NULL AND entry_date<? AND type='credit' THEN amount ELSE 0 END) AS opening_credit,
                  SUM(CASE WHEN (? IS NULL OR entry_date>=?) AND (? IS NULL OR entry_date<=?) AND type='debit' THEN amount ELSE 0 END) AS period_debit,
                  SUM(CASE WHEN (? IS NULL OR entry_date>=?) AND (? IS NULL OR entry_date<=?) AND type='credit' THEN amount ELSE 0 END) AS period_credit,
                  SUM(CASE WHEN (? IS NULL OR entry_date<=?) AND type='debit' THEN amount ELSE 0 END) AS total_debit,
                  SUM(CASE WHEN (? IS NULL OR entry_date<=?) AND type='credit' THEN amount ELSE 0 END) AS total_credit
                FROM entries GROUP BY account_id
               )
               SELECT a.id,a.parent_id,a.code,a.name_ar,a.name_en,a.type,a.is_group,
                 COALESCE(t.opening_debit,0) AS opening_debit,
                 COALESCE(t.opening_credit,0) AS opening_credit,
                 COALESCE(t.period_debit,0) AS period_debit,
                 COALESCE(t.period_credit,0) AS period_credit,
                 COALESCE(t.total_debit,0) AS total_debit,
                 COALESCE(t.total_credit,0) AS total_credit
               FROM main.accounts a LEFT JOIN totals t ON t.account_id=a.id
               ORDER BY a.code ASC,a.id ASC LIMIT ? OFFSET ?"#,
            vec![
                json!(pharmacy_id),
                json!(filters.date_from),
                json!(filters.date_from),
                json!(filters.date_from),
                json!(filters.date_from),
                json!(filters.date_from),
                json!(filters.date_from),
                json!(filters.date_to),
                json!(filters.date_to),
                json!(filters.date_from),
                json!(filters.date_from),
                json!(filters.date_to),
                json!(filters.date_to),
                json!(filters.date_to),
                json!(filters.date_to),
                json!(filters.date_to),
                json!(filters.date_to),
                json!(limit),
                json!(offset),
            ],
        ),
        FinanceProjection::TreasuryCashLedger => (
            // The posted cash account is known from the globally configured
            // chart. Historical journals must have a verified tenant at source;
            // accounts or ownerless journals may never be inferred from users.
            // Missing canonical cash metadata is NULL (unavailable), not 0.
            r#"WITH cash AS (
                   SELECT a.id FROM main.accounts a
                   WHERE a.code IN ('1.1.1', '111') AND a.type='asset' AND a.is_group=0
                   ORDER BY CASE WHEN a.code='1.1.1' THEN 0 ELSE 1 END, a.id
                   LIMIT 1
                 ), postings AS (
                   SELECT SUM(CASE WHEN e.type='debit' THEN e.amount ELSE -e.amount END) AS balance
                   FROM main.journal_entries e JOIN main.daily_journals j ON j.id=e.journal_id
                   WHERE j.pharmacy_id=? AND e.account_id=(SELECT id FROM cash)
                 )
                 SELECT CASE WHEN EXISTS(SELECT 1 FROM cash)
                         THEN COALESCE((SELECT balance FROM postings),0)
                         ELSE NULL END AS ledger_cash_balance
                 LIMIT ? OFFSET ?"#,
            vec![json!(pharmacy_id), json!(limit), json!(offset)],
        ),
    };
    let rows = fetch_scoped_limited(
        conn,
        sql,
        binds,
        ReadLimits {
            max_duration: Duration::from_secs(5),
            max_rows: limit as usize,
            max_bytes: 4 * 1024 * 1024,
        },
    )
    .await?;
    Ok(FinanceReadPage {
        actor_id: actor_id.to_string(),
        pharmacy_id,
        rows,
    })
}

#[tauri::command]
pub async fn finance_read_projection(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    query_id: String,
    movement_type: Option<String>,
    category: Option<String>,
    date_from: Option<String>,
    date_to: Option<String>,
    journal_id: Option<String>,
    limit: u32,
    offset: u32,
) -> Result<FinanceReadPage, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|err| err.to_string())?;
    read_finance_projection(
        &mut conn,
        actor.as_deref().unwrap(),
        &query_id,
        FinanceFilters {
            movement_type: movement_type.as_deref(),
            category: category.as_deref(),
            date_from: date_from.as_deref(),
            date_to: date_to.as_deref(),
            journal_id: journal_id.as_deref(),
        },
        limit,
        offset,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        conn.execute(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT, full_name TEXT, role TEXT,
                pharmacy_id TEXT, is_active INTEGER, permissions TEXT);
            INSERT INTO users VALUES
                ('owner-a','owner-a','Owner A','owner','a',1,'{}'),
                ('owner-b','owner-b','Owner B','owner','b',1,'{}'),
                ('cash-a','cash-a','Cash A','cashier','a',1,'{"acc_can_view_general":true}'),
                ('reports-a','reports-a','Reports A','cashier','a',1,'{"acc_can_view_reports":true}'),
                ('denied','denied','Denied','cashier','a',1,'{"acc_can_view_general":false,"acc_can_view_reports":false}'),
                ('inactive','inactive','Inactive','owner','a',0,'{}'),
                ('local','local','Local','owner',NULL,1,'{}');
            CREATE TABLE shifts(id TEXT PRIMARY KEY,status TEXT,pharmacy_id TEXT);
            INSERT INTO shifts VALUES ('s-a','closed','a'),('s-b','private-b','b');
            CREATE TABLE cash_movements(id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT,
                pharmacy_id TEXT, type TEXT,category TEXT,amount REAL,date TEXT,created_at TEXT);
            INSERT INTO cash_movements VALUES
                ('a-1','cash-a','s-a','a','receipt','collection',12.5,'2026-10-10','2026-10-10 12:00:00'),
                ('a-2','owner-b','s-b','a','disbursement','operating_expenses',7,'2026-10-09','2026-10-09 12:00:00'),
                ('b-1','owner-b','s-b','b','receipt','collection',900,'2026-10-10','2026-10-10 13:00:00'),
                ('legacy','local',NULL,NULL,'receipt','collection',5,'2026-10-10','2026-10-10 11:00:00');
            CREATE TABLE daily_journals(id TEXT PRIMARY KEY,pharmacy_id TEXT,date TEXT,
                created_at TEXT,description TEXT,total_amount REAL);
            INSERT INTO daily_journals VALUES
                ('j-a','a','2026-10-10','2026-10-10 12:00:00','A ledger',12.5),
                ('j-b','b','2026-10-10','2026-10-10 13:00:00','B secret',900),
                ('j-local',NULL,'2026-10-10','2026-10-10 11:00:00','Local ledger',5);
            CREATE TABLE accounts(id INTEGER PRIMARY KEY,name_ar TEXT,code TEXT);
            INSERT INTO accounts VALUES (1,'Cash','1.1.1'),(2,'Sales','3.1');
            CREATE TABLE journal_entries(id INTEGER PRIMARY KEY,journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
            INSERT INTO journal_entries VALUES
                (1,'j-a',1,'debit',12.5),(2,'j-a',2,'credit',12.5),
                (3,'j-b',1,'debit',900),(4,'j-b',2,'credit',900),
                (5,'j-local',1,'debit',5);
        "#).await.unwrap();
        conn
    }

    async fn query(
        conn: &mut SqliteConnection,
        actor: &str,
        key: &str,
        filters: FinanceFilters<'_>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<Value>, String> {
        read_finance_projection(conn, actor, key, filters, limit, offset)
            .await
            .map(|page| page.rows)
    }

    // All entries come from immutable journal headers with explicit scope.
    // Tenant B's 900-unit movements intentionally dwarf tenant A's real source
    // amounts, exposing both cross-tenant aggregation and fabricated zeros.
    async fn accounting_fixture() -> SqliteConnection {
        let mut conn = fixture().await;
        sqlx::raw_sql(
            r#"
            DELETE FROM journal_entries WHERE journal_id='j-local';
            DELETE FROM daily_journals WHERE id='j-local';
            ALTER TABLE accounts ADD COLUMN name_en TEXT;
            ALTER TABLE accounts ADD COLUMN type TEXT;
            ALTER TABLE accounts ADD COLUMN parent_id INTEGER;
            ALTER TABLE accounts ADD COLUMN is_group INTEGER DEFAULT 0;
            UPDATE accounts SET name_en='Cash Drawer',type='asset',parent_id=3 WHERE id=1;
            UPDATE accounts SET name_en='Sales Revenue',type='revenue' WHERE id=2;
            INSERT INTO accounts(id,name_ar,code,name_en,type,parent_id,is_group) VALUES
              (3,'Assets','1','Assets','asset',NULL,1),
              (4,'Unused Expense','4.5','Unused','expense',NULL,0);
            INSERT INTO daily_journals VALUES
              ('j-a-prior','a','2026-09-20','2026-09-20 11:00:00','A owned opening',4);
            INSERT INTO journal_entries(id,journal_id,account_id,type,amount) VALUES
              (6,'j-a-prior',1,'debit',4),(7,'j-a-prior',2,'credit',4);
        "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    #[tokio::test]
    async fn treasury_ledger_verifies_posted_cash_without_adopting_legacy_or_foreign_tenants() {
        let mut conn = accounting_fixture().await;
        sqlx::raw_sql(
            r#"INSERT INTO daily_journals VALUES
              ('j-legacy', 'local_default', '2026-10-10','2026-10-10 14:00:00','Legacy only',5000);
              INSERT INTO journal_entries(id,journal_id,account_id,type,amount) VALUES
              (90,'j-legacy',1,'debit',5000),(91,'j-legacy',2,'credit',5000);"#,
        ).execute(&mut conn).await.unwrap();

        for (actor, expected) in [("owner-a",16.5),("owner-b",900.0),("cash-a",16.5)] {
            let page = read_finance_projection(&mut conn, actor, "treasury_cash_ledger",
                FinanceFilters::default(),200,0).await.unwrap();
            assert_eq!(page.actor_id, actor);
            assert_eq!(page.rows.len(), 1);
            assert_eq!(page.rows[0]["ledger_cash_balance"], expected);
        }
        for actor in ["local", "reports-a", "denied", "inactive"] {
            assert!(query(&mut conn, actor, "treasury_cash_ledger",
                FinanceFilters::default(),200,0).await.is_err());
        }
        assert!(query(&mut conn, "owner-a", "treasury_cash_ledger",
            FinanceFilters { category: Some("cash_drawer"), ..Default::default() },200,0).await.is_err());

        // No cash-account metadata must be reported as unavailable, never fabricated zero.
        sqlx::query("UPDATE accounts SET code='1.1.99' WHERE id=1")
            .execute(&mut conn).await.unwrap();
        let unavailable = query(&mut conn, "owner-a", "treasury_cash_ledger",
            FinanceFilters::default(),200,0).await.unwrap();
        assert!(unavailable[0]["ledger_cash_balance"].is_null());
        sqlx::query("UPDATE accounts SET code='1.1.1' WHERE id=1")
            .execute(&mut conn).await.unwrap();

        sqlx::query("INSERT INTO journal_entries(id,journal_id,account_id,type,amount) VALUES (92,'j-a',1,'credit',1)")
            .execute(&mut conn).await.unwrap();
        assert!(query(&mut conn, "owner-a", "treasury_cash_ledger",
            FinanceFilters::default(),200,0).await.unwrap_err().contains("Unbalanced"));
        sqlx::query("DELETE FROM journal_entries WHERE id=92")
            .execute(&mut conn).await.unwrap();
        sqlx::raw_sql(
            "INSERT INTO daily_journals VALUES ('ownerless',NULL,'2026-10-10','2026-10-10','Unowned',8); \
             INSERT INTO journal_entries(id,journal_id,account_id,type,amount) VALUES \
             (93,'ownerless',1,'debit',8),(94,'ownerless',2,'credit',8);"
        ).execute(&mut conn).await.unwrap();
        assert!(query(&mut conn, "owner-a", "treasury_cash_ledger",
            FinanceFilters::default(),200,0).await.unwrap_err().contains("Unreconciled legacy"));
    }

    #[tokio::test]
    async fn foreign_legacy_bucket_does_not_block_or_enter_explicit_tenant_reports() {
        let mut conn = accounting_fixture().await;
        sqlx::raw_sql(
            r#"
            INSERT INTO daily_journals VALUES
              ('j-legacy','local_default','2026-09-01','2026-09-01 12:00:00','Unattributed historic journal',5000);
            INSERT INTO journal_entries(id,journal_id,account_id,type,amount) VALUES
              (80,'j-legacy',1,'debit',5000),(81,'j-legacy',2,'credit',5000);
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();

        for (projection, value_key, expected_a, expected_b) in [
            ("accounts_chart", "debit", 16.5, 900.0),
            ("trial_balance", "total_debit", 16.5, 900.0),
        ] {
            for (actor, expected) in [("owner-a", expected_a), ("owner-b", expected_b)] {
                let rows = query(
                    &mut conn,
                    actor,
                    projection,
                    FinanceFilters::default(),
                    200,
                    0,
                )
                .await
                .unwrap();
                let cash = rows.iter().find(|row| row["id"] == 1).unwrap();
                assert_eq!(cash[value_key], expected, "{projection} for {actor}");
            }
        }
        for projection in ["accounts_chart", "trial_balance"] {
            assert!(query(
                &mut conn,
                "local",
                projection,
                FinanceFilters::default(),
                200,
                0
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn owned_accounts_chart_has_metadata_real_balances_and_tenant_separation() {
        let mut conn = accounting_fixture().await;
        let own = query(
            &mut conn,
            "cash-a",
            "accounts_chart",
            FinanceFilters::default(),
            200,
            0,
        )
        .await
        .unwrap();
        assert_eq!(own.len(), 4);
        let cash = own.iter().find(|r| r["id"] == 1).unwrap();
        assert_eq!(cash["code"], "1.1.1");
        assert_eq!(cash["name_en"], "Cash Drawer");
        assert_eq!(cash["type"], "asset");
        assert_eq!(cash["parent_id"], 3);
        assert_eq!(cash["balance"], 16.5);
        assert_eq!(cash["debit"], 16.5);
        let sales = own.iter().find(|r| r["id"] == 2).unwrap();
        assert_eq!(sales["credit"], 16.5);
        assert_eq!(sales["balance"], 16.5);
        assert_eq!(own.iter().find(|r| r["id"] == 3).unwrap()["is_group"], 1);
        assert_eq!(own.iter().find(|r| r["id"] == 4).unwrap()["balance"], 0);
        let foreign = query(
            &mut conn,
            "owner-b",
            "accounts_chart",
            FinanceFilters::default(),
            200,
            0,
        )
        .await
        .unwrap();
        assert_eq!(
            foreign.iter().find(|r| r["id"] == 1).unwrap()["balance"],
            900.0
        );
        assert_eq!(
            query(
                &mut conn,
                "owner-a",
                "accounts_chart",
                FinanceFilters::default(),
                2,
                2
            )
            .await
            .unwrap()
            .len(),
            2
        );
        assert!(query(
            &mut conn,
            "reports-a",
            "accounts_chart",
            FinanceFilters::default(),
            200,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "denied",
            "accounts_chart",
            FinanceFilters::default(),
            200,
            0
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn trial_balance_accounts_for_opening_period_and_cumulative_by_live_tenant() {
        let mut conn = accounting_fixture().await;
        let filters = FinanceFilters {
            date_from: Some("2026-10-01"),
            date_to: Some("2026-10-10"),
            ..Default::default()
        };
        let page =
            read_finance_projection(&mut conn, "reports-a", "trial_balance", filters, 200, 0)
                .await
                .unwrap();
        assert_eq!(page.pharmacy_id, "a");
        assert_eq!(page.actor_id, "reports-a");
        let cash = page.rows.iter().find(|r| r["id"] == 1).unwrap();
        assert_eq!(cash["opening_debit"], 4.0);
        assert_eq!(cash["period_debit"], 12.5);
        assert_eq!(cash["total_debit"], 16.5);
        assert_eq!(cash["total_credit"], 0.0);
        let sales = page.rows.iter().find(|r| r["id"] == 2).unwrap();
        assert_eq!(sales["opening_credit"], 4.0);
        assert_eq!(sales["period_credit"], 12.5);
        assert_eq!(sales["total_credit"], 16.5);
        let b = query(
            &mut conn,
            "owner-b",
            "trial_balance",
            FinanceFilters::default(),
            200,
            0,
        )
        .await
        .unwrap();
        assert_eq!(
            b.iter().find(|r| r["id"] == 1).unwrap()["total_debit"],
            900.0
        );
        assert!(query(
            &mut conn,
            "cash-a",
            "trial_balance",
            FinanceFilters::default(),
            200,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "owner-a",
            "accounts_chart",
            FinanceFilters {
                date_from: Some("2026-10-01"),
                ..Default::default()
            },
            200,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "owner-a",
            "trial_balance",
            FinanceFilters {
                date_from: Some("2026-10-11"),
                date_to: Some("2026-10-01"),
                ..Default::default()
            },
            200,
            0
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn accounting_rejects_unattributed_legacy_orphan_and_unbalanced_sources() {
        let mut conn = accounting_fixture().await;
        for projection in ["accounts_chart", "trial_balance"] {
            assert!(query(
                &mut conn,
                "local",
                projection,
                FinanceFilters::default(),
                200,
                0
            )
            .await
            .is_err());
        }
        sqlx::query("INSERT INTO daily_journals VALUES ('legacy',NULL,'2026-10-09','2026-10-09','unowned',5)")
            .execute(&mut conn).await.unwrap();
        sqlx::raw_sql("INSERT INTO journal_entries(id,journal_id,account_id,type,amount) VALUES (90,'legacy',1,'debit',5),(91,'legacy',2,'credit',5)")
            .execute(&mut conn).await.unwrap();
        for projection in ["accounts_chart", "trial_balance"] {
            assert!(query(
                &mut conn,
                "owner-a",
                projection,
                FinanceFilters::default(),
                200,
                0
            )
            .await
            .unwrap_err()
            .contains("Unreconciled legacy"));
        }
        sqlx::query("DELETE FROM journal_entries WHERE journal_id='legacy'")
            .execute(&mut conn).await.unwrap();
        sqlx::query("DELETE FROM daily_journals WHERE id='legacy'")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql("INSERT INTO daily_journals VALUES ('blank-owner','  ','2026-10-09','2026-10-09','blank owner',5); INSERT INTO journal_entries(id,journal_id,account_id,type,amount) VALUES (90,'blank-owner',1,'debit',5),(91,'blank-owner',2,'credit',5);")
            .execute(&mut conn).await.unwrap();
        assert!(query(&mut conn, "owner-a", "accounts_chart", FinanceFilters::default(), 200, 0)
            .await.unwrap_err().contains("Unreconciled legacy"));
        sqlx::query("DELETE FROM journal_entries WHERE journal_id='blank-owner'")
            .execute(&mut conn).await.unwrap();
        sqlx::query("DELETE FROM daily_journals WHERE id='blank-owner'")
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO journal_entries(id,journal_id,account_id,type,amount) VALUES(80,'missing-source',1,'debit',100)")
            .execute(&mut conn).await.unwrap();
        assert!(query(
            &mut conn,
            "owner-a",
            "trial_balance",
            FinanceFilters::default(),
            200,
            0
        )
        .await
        .unwrap_err()
        .contains("Unverifiable finance journal"));
        assert!(query(&mut conn, "owner-a", "accounts_chart", FinanceFilters::default(), 200, 0)
            .await.unwrap_err().contains("Unverifiable finance journal"));
        sqlx::query("DELETE FROM journal_entries WHERE id=80")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::raw_sql("INSERT INTO daily_journals VALUES ('bad-types','a','2026-10-09','2026-10-09','Null entry types',5); INSERT INTO journal_entries(id,journal_id,account_id,type,amount) VALUES (90,'bad-types',1,NULL,5),(91,'bad-types',2,NULL,5);")
            .execute(&mut conn).await.unwrap();
        assert!(query(&mut conn, "owner-a", "trial_balance", FinanceFilters::default(), 200, 0)
            .await.unwrap_err().contains("Unverifiable finance journal"));
        sqlx::query("DELETE FROM journal_entries WHERE journal_id='bad-types'")
            .execute(&mut conn).await.unwrap();
        sqlx::query("DELETE FROM daily_journals WHERE id='bad-types'")
            .execute(&mut conn).await.unwrap();
        sqlx::query("DELETE FROM journal_entries WHERE id=2")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(query(
            &mut conn,
            "owner-a",
            "accounts_chart",
            FinanceFilters::default(),
            200,
            0
        )
        .await
        .unwrap_err()
        .contains("Unbalanced or incomplete"));
    }

    #[tokio::test]
    async fn cash_scope_dates_permissions_and_bounded_pagination() {
        let mut conn = fixture().await;
        let page = query(
            &mut conn,
            "cash-a",
            "cash_movements",
            FinanceFilters::default(),
            1,
            0,
        )
        .await
        .unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0]["id"], "a-1");
        assert_eq!(page[0]["user_name"], "Cash A");
        assert_eq!(page[0]["shift_status"], "closed");
        let second = query(
            &mut conn,
            "owner-a",
            "cash_movements",
            FinanceFilters::default(),
            1,
            1,
        )
        .await
        .unwrap();
        assert_eq!(second[0]["id"], "a-2");
        // Foreign references must not leak foreign user names or shift statuses.
        assert_eq!(second[0]["user_name"], "owner-b");
        assert!(second[0]["shift_status"].is_null());
        let income = query(
            &mut conn,
            "cash-a",
            "cash_movements",
            FinanceFilters {
                movement_type: Some("receipt"),
                date_from: Some("2026-10-10"),
                date_to: Some("2026-10-10"),
                ..Default::default()
            },
            50,
            0,
        )
        .await
        .unwrap();
        assert_eq!(income.len(), 1);
        assert_eq!(income[0]["amount"], 12.5);
        assert_eq!(
            query(
                &mut conn,
                "owner-b",
                "cash_movements",
                FinanceFilters::default(),
                50,
                0
            )
            .await
            .unwrap()
            .len(),
            1
        );
        assert_eq!(
            query(
                &mut conn,
                "local",
                "cash_movements",
                FinanceFilters::default(),
                50,
                0
            )
            .await
            .unwrap()[0]["id"],
            "legacy"
        );
        assert!(query(
            &mut conn,
            "denied",
            "cash_movements",
            FinanceFilters::default(),
            50,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "inactive",
            "cash_movements",
            FinanceFilters::default(),
            50,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "reports-a",
            "cash_movements",
            FinanceFilters::default(),
            50,
            0
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn journals_and_entries_enforce_live_pharmacy_and_role() {
        let mut conn = fixture().await;
        let authenticated = read_finance_projection(
            &mut conn,
            "reports-a",
            "journals",
            FinanceFilters::default(),
            50,
            0,
        )
        .await
        .unwrap();
        assert_eq!(authenticated.actor_id, "reports-a");
        assert_eq!(authenticated.pharmacy_id, "a");
        let journals = query(
            &mut conn,
            "reports-a",
            "journals",
            FinanceFilters::default(),
            50,
            0,
        )
        .await
        .unwrap();
        assert_eq!(journals.len(), 1);
        assert_eq!(journals[0]["id"], "j-a");
        let entries = query(
            &mut conn,
            "reports-a",
            "journal_entries",
            FinanceFilters {
                journal_id: Some("j-a"),
                ..Default::default()
            },
            50,
            0,
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(
            entries
                .iter()
                .map(|v| v["debit"].as_f64().unwrap())
                .sum::<f64>(),
            12.5
        );
        assert_eq!(
            entries
                .iter()
                .map(|v| v["credit"].as_f64().unwrap())
                .sum::<f64>(),
            12.5
        );
        assert!(entries.iter().any(|v| v["account_code"] == "1.1.1"));
        let foreign = query(
            &mut conn,
            "reports-a",
            "journal_entries",
            FinanceFilters {
                journal_id: Some("j-b"),
                ..Default::default()
            },
            50,
            0,
        )
        .await
        .unwrap();
        assert!(foreign.is_empty());
        assert!(query(
            &mut conn,
            "cash-a",
            "journals",
            FinanceFilters::default(),
            50,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "denied",
            "journal_entries",
            FinanceFilters {
                journal_id: Some("j-a"),
                ..Default::default()
            },
            50,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "inactive",
            "journals",
            FinanceFilters::default(),
            50,
            0
        )
        .await
        .is_err());
        assert_eq!(
            query(
                &mut conn,
                "local",
                "journals",
                FinanceFilters::default(),
                50,
                0
            )
            .await
            .unwrap()[0]["id"],
            "j-local"
        );
        // Reassignment and deactivation take effect on the next projection call.
        sqlx::query("UPDATE users SET pharmacy_id='b' WHERE id='reports-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            query(
                &mut conn,
                "reports-a",
                "journals",
                FinanceFilters::default(),
                50,
                0
            )
            .await
            .unwrap()[0]["id"],
            "j-b"
        );
        sqlx::query("UPDATE users SET is_active=0 WHERE id='reports-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(query(
            &mut conn,
            "reports-a",
            "journals",
            FinanceFilters::default(),
            50,
            0
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn rejects_bad_keys_filters_and_page_shapes_before_query() {
        let mut conn = fixture().await;
        assert!(query(
            &mut conn,
            "owner-a",
            "custom_SQL",
            FinanceFilters::default(),
            50,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "owner-a",
            "cash_movements",
            FinanceFilters::default(),
            201,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "owner-a",
            "journals",
            FinanceFilters::default(),
            1,
            50001
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "owner-a",
            "cash_movements",
            FinanceFilters {
                movement_type: Some("out'); SELECT * FROM users --"),
                ..Default::default()
            },
            50,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "owner-a",
            "cash_movements",
            FinanceFilters {
                date_from: Some("2026-02-30"),
                ..Default::default()
            },
            50,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "owner-a",
            "journal_entries",
            FinanceFilters {
                journal_id: Some(""),
                ..Default::default()
            },
            50,
            0
        )
        .await
        .is_err());
        assert!(query(
            &mut conn,
            "owner-a",
            "journals",
            FinanceFilters {
                category: Some("other"),
                ..Default::default()
            },
            50,
            0
        )
        .await
        .is_err());
    }
}
