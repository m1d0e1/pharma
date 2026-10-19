//! Immutable linkage for NEW native inventory adjustments and their optional
//! journals. Never infer or backfill provenance for historical adjustments.
//!
//! Integration: call only from the authenticated native stock edit/zero path,
//! AFTER stock_adjustments INSERT (use its last_insert_rowid), inventory update
//! and optional journal + TWO entries, but BEFORE COMMIT on the SAME SQLx
//! SqliteConnection under an existing BEGIN IMMEDIATE transaction. The helper
//! performs one INSERT and never begins, commits or rolls back a transaction.
//! Do not expose this helper as a renderer-invokable Tauri command.
use sqlx::{Row, SqliteConnection};

const MAX_QTY: f64 = 1_000_000_000.0;
const MAX_COST: f64 = 1_000_000_000.0;
const MAX_VALUATION: f64 = 1_000_000_000_000.0;
const MAX_ID_BYTES: usize = 256;

fn numeric(value: f64, max: f64) -> bool {
    value.is_finite() && (0.0..=max).contains(&value)
}

fn cents(value: f64, max: f64) -> Result<i64, String> {
    if !numeric(value, max) {
        return Err("Stock provenance monetary value is unbounded".into());
    }
    let result = value * 100.0;
    if !result.is_finite() || (result - result.round()).abs() > 0.00001 {
        return Err("Stock provenance money must have exact cent precision".into());
    }
    Ok(result.round() as i64)
}

fn safe_id(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn native_journal(id: &str, new_qty: f64, old_qty: f64) -> bool {
    let raw = if new_qty > old_qty {
        id.strip_prefix("native-lot-adjust-")
    } else {
        id.strip_prefix("native-lot-zero-")
            .or_else(|| id.strip_prefix("native-lot-adjust-"))
    };
    raw.and_then(|value| uuid::Uuid::parse_str(value).ok())
        .is_some()
}

/// Native-only structural receipt for a previously posted stock adjustment.
///
/// The actor and pharmacy arguments MUST be derived from the authenticated
/// native session, never from renderer values. This function independently
/// rechecks both against the live user, source adjustment and inventory row.
/// It accepts fractional stock (a strip need not be four-decimal representable).
///
/// The exact generated journal ID is linked only for nonzero valuations;
/// zero-cost stock movements are proven by a NULL journal reference.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn record_adjustment_provenance(
    conn: &mut SqliteConnection,
    adjustment_id: i64,
    inventory_id: &str,
    pharmacy: &str,
    actor: &str,
    old_qty: f64,
    new_qty: f64,
    unit_cost: f64,
    valuation: f64,
    journal_id: Option<&str>,
) -> Result<(), String> {
    if adjustment_id <= 0
        || !safe_id(inventory_id, MAX_ID_BYTES)
        || !safe_id(pharmacy, 128)
        || !safe_id(actor, 128)
        || !numeric(old_qty, MAX_QTY)
        || !numeric(new_qty, MAX_QTY)
        || old_qty == new_qty
    {
        return Err("Invalid native stock adjustment source/quantity".into());
    }
    let cost_cents = cents(unit_cost, MAX_COST)?;
    let valuation_cents = cents(valuation, MAX_VALUATION)?;
    let expected = (new_qty - old_qty).abs() * unit_cost;
    if !expected.is_finite() || (expected * 100.0 - valuation_cents as f64).abs() > 0.00001 {
        return Err("Native journal value does not equal the bounded stock cost movement".into());
    }
    match journal_id {
        None if valuation_cents != 0 => {
            return Err("Nonzero stock valuation requires a native journal".into())
        }
        Some(_) if valuation_cents == 0 => {
            return Err("Zero-valuation stock adjustment must not claim a journal".into())
        }
        Some(id) if !native_journal(id, new_qty, old_qty) => {
            return Err("Invalid native-generated stock journal ID".into())
        }
        _ => {}
    }

    // Verify independently that the entry really comes from the native
    // actor's present pharmacy, and that the stock was already updated.
    let source = sqlx::query(
        "SELECT CAST(sa.old_quantity AS REAL) AS old_quantity,
                CAST(sa.new_quantity AS REAL) AS new_quantity,
                CAST(i.quantity AS REAL) AS quantity,
                CAST(i.cost_price AS REAL) AS cost_price
         FROM main.stock_adjustments sa
         JOIN main.inventory i ON i.id=sa.inventory_id
         JOIN main.users u ON CAST(u.id AS TEXT)=CAST(sa.user_id AS TEXT)
         WHERE sa.id=? AND sa.inventory_id=? AND CAST(sa.user_id AS TEXT)=?
           AND i.pharmacy_id=? AND TRIM(i.pharmacy_id)<>''
           AND u.pharmacy_id=? AND TRIM(u.pharmacy_id)<>''
           AND COALESCE(u.is_active,1)=1
           AND typeof(sa.old_quantity) IN ('integer','real')
           AND typeof(sa.new_quantity) IN ('integer','real')
           AND typeof(i.quantity) IN ('integer','real')
           AND typeof(i.cost_price) IN ('integer','real')",
    )
    .bind(adjustment_id)
    .bind(inventory_id)
    .bind(actor)
    .bind(pharmacy)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or("Stock adjustment, tenant, lot or active actor does not match")?;
    for (field, expected) in [
        ("old_quantity", old_qty),
        ("new_quantity", new_qty),
        ("quantity", new_qty),
        ("cost_price", unit_cost),
    ] {
        let actual: f64 = source.try_get(field).map_err(|e| e.to_string())?;
        if !actual.is_finite() || (actual - expected).abs() > 0.000000001 {
            return Err(format!("Stock source {field} differs from native snapshot"));
        }
    }

    let mut inventory_account: Option<i64> = None;
    let mut counterpart_account: Option<i64> = None;
    let mut counterpart_type: Option<&'static str> = None;
    if let Some(journal) = journal_id {
        let header = sqlx::query(
            "SELECT j.total_amount
             FROM main.daily_journals j
             WHERE j.id=? AND j.pharmacy_id=? AND CAST(j.created_by AS TEXT)=?
               AND typeof(j.total_amount) IN ('real','integer')",
        )
        .bind(journal)
        .bind(pharmacy)
        .bind(actor)
        .fetch_optional(&mut *conn)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Stock journal is missing or belongs to another actor/pharmacy")?;
        let amount: f64 = header.try_get("total_amount").map_err(|e| e.to_string())?;
        if cents(amount, MAX_VALUATION)? != valuation_cents {
            return Err("Stock journal header valuation disagrees with movement".into());
        }
        let rows = sqlx::query(
            "SELECT e.type, e.amount, e.account_id,
                    a.type account_type, a.is_group,
                    EXISTS(SELECT 1 FROM main.accounts child
                           WHERE child.parent_id=a.id) has_children
             FROM main.journal_entries e
             LEFT JOIN main.accounts a ON a.id=e.account_id
             WHERE e.journal_id=? ORDER BY e.id LIMIT 3",
        )
        .bind(journal)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if rows.len() != 2 {
            return Err("Native stock journal must contain exactly two posted lines".into());
        }
        let mut saw_debit = false;
        let mut saw_credit = false;
        for row in rows {
            let side: String = row.try_get("type").map_err(|e| e.to_string())?;
            let amount: f64 = row.try_get("amount").map_err(|e| e.to_string())?;
            let account: i64 = row.try_get("account_id").map_err(|e| e.to_string())?;
            let account_type: Option<String> =
                row.try_get("account_type").map_err(|e| e.to_string())?;
            let group: Option<i64> = row.try_get("is_group").map_err(|e| e.to_string())?;
            let children: i64 = row.try_get("has_children").map_err(|e| e.to_string())?;
            if cents(amount, MAX_VALUATION)? != valuation_cents
                || group.unwrap_or(1) != 0
                || children != 0
            {
                return Err("Unbalanced or non-postable stock account entry".into());
            }
            let kind = account_type.unwrap_or_default().trim().to_ascii_lowercase();
            match side.as_str() {
                "debit" if !saw_debit => saw_debit = true,
                "credit" if !saw_credit => saw_credit = true,
                _ => return Err("Native stock journal sides must be distinct".into()),
            }
            let stock_side = if new_qty > old_qty { "debit" } else { "credit" };
            if kind == "asset" && side == stock_side {
                if inventory_account.replace(account).is_some() {
                    return Err("Repeated inventory-asset posting".into());
                }
            } else {
                let required = if new_qty > old_qty {
                    "revenue"
                } else {
                    "expense"
                };
                if kind != required || counterpart_account.replace(account).is_some() {
                    return Err("Stock counterpart account has the wrong type/direction".into());
                }
                counterpart_type = Some(if new_qty > old_qty {
                    "revenue"
                } else {
                    "expense"
                });
            }
        }
        if !saw_debit
            || !saw_credit
            || inventory_account.is_none()
            || counterpart_account.is_none()
            || inventory_account == counterpart_account
        {
            return Err("Stock journal is not balanced on inventory and counterpart".into());
        }
    }
    // Last-write in the enclosing BEGIN IMMEDIATE transaction. Unique source
    // and journal claims and SQL triggers fail closed if concurrent/replayed.
    sqlx::query(
        "INSERT INTO main.native_stock_ledger_provenance
         (adjustment_id,inventory_id,pharmacy_id,actor_id,old_quantity,new_quantity,
          unit_cost_cents,valuation_cents,direction,journal_id,
          inventory_account_id,counterpart_account_id,counterpart_type)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(adjustment_id)
    .bind(inventory_id)
    .bind(pharmacy)
    .bind(actor)
    .bind(old_qty)
    .bind(new_qty)
    .bind(cost_cents)
    .bind(valuation_cents)
    .bind(if new_qty > old_qty {
        "increase"
    } else {
        "decrease"
    })
    .bind(journal_id)
    .bind(inventory_account)
    .bind(counterpart_account)
    .bind(counterpart_type)
    .execute(&mut *conn)
    .await
    .map_err(|e| format!("Cannot record immutable stock posting: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    const GAIN: &str = "native-lot-adjust-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const LOSS: &str = "native-lot-zero-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const GAIN_2: &str = "native-lot-adjust-cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,pharmacy_id TEXT,role TEXT,is_active INTEGER);
            INSERT INTO users VALUES ('actor-a','a','manager',1),('actor-b','b','owner',1),
                ('inactive-a','a','owner',0);
            CREATE TABLE inventory(
                id TEXT PRIMARY KEY,drug_id INTEGER,pharmacy_id TEXT,
                quantity REAL,cost_price REAL
            );
            INSERT INTO inventory VALUES
              ('lot-a',10,'a',5,3),('lot-b',10,'b',6,3),('lot-free',10,'a',5,0);
            CREATE TABLE stock_adjustments(
                id INTEGER PRIMARY KEY AUTOINCREMENT,inventory_id TEXT,reason_id INTEGER,
                old_quantity REAL,new_quantity REAL,user_id TEXT
            );
            CREATE TABLE accounts(
                id INTEGER PRIMARY KEY,code TEXT,parent_id INTEGER,is_group INTEGER,type TEXT
            );
            INSERT INTO accounts VALUES (10,'1.1.3',NULL,0,'asset'),
                (11,'4.1',NULL,0,'expense'),(12,'3.2',NULL,0,'revenue'),
                (13,'4',NULL,1,'expense'),(14,'4.5',NULL,0,'expense');
            CREATE TABLE daily_journals(
                id TEXT PRIMARY KEY,date TEXT,description TEXT,created_by TEXT,
                total_amount REAL,pharmacy_id TEXT
            );
            CREATE TABLE journal_entries(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                journal_id TEXT,account_id INTEGER,type TEXT,amount REAL
            );
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/040_stock_ledger_provenance.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    async fn stock(
        conn: &mut SqliteConnection,
        id: i64,
        lot: &str,
        actor: &str,
        old: f64,
        new: f64,
    ) {
        sqlx::query("UPDATE inventory SET quantity=? WHERE id=?")
            .bind(new)
            .bind(lot)
            .execute(&mut *conn)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO stock_adjustments(id,inventory_id,old_quantity,new_quantity,user_id)
             VALUES(?,?,?,?,?)",
        )
        .bind(id)
        .bind(lot)
        .bind(old)
        .bind(new)
        .bind(actor)
        .execute(&mut *conn)
        .await
        .unwrap();
    }

    async fn journal(
        conn: &mut SqliteConnection,
        id: &str,
        actor: &str,
        pharmacy: &str,
        amount: f64,
        raise: bool,
        counterpart: i64,
    ) {
        sqlx::query(
            "INSERT INTO daily_journals
             (id,date,description,created_by,total_amount,pharmacy_id)
             VALUES(?,'2026-10-12','Native stock posting',?,?,?)",
        )
        .bind(id)
        .bind(actor)
        .bind(amount)
        .bind(pharmacy)
        .execute(&mut *conn)
        .await
        .unwrap();
        let sides = if raise {
            [(10, "debit"), (counterpart, "credit")]
        } else {
            [(counterpart, "debit"), (10, "credit")]
        };
        for (account, side) in sides {
            sqlx::query(
                "INSERT INTO journal_entries(journal_id,account_id,type,amount)
                 VALUES(?,?,?,?)",
            )
            .bind(id)
            .bind(account)
            .bind(side)
            .bind(amount)
            .execute(&mut *conn)
            .await
            .unwrap();
        }
    }

    async fn count(conn: &mut SqliteConnection) -> i64 {
        sqlx::query_scalar("SELECT COUNT(*) FROM native_stock_ledger_provenance")
            .fetch_one(&mut *conn)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn gain_attaches_structural_asset_and_revenue_posting() {
        let mut conn = fixture().await;
        conn.execute("BEGIN IMMEDIATE").await.unwrap();
        stock(&mut conn, 1, "lot-a", "actor-a", 2., 5.).await;
        journal(&mut conn, GAIN, "actor-a", "a", 9., true, 12).await;
        record_adjustment_provenance(
            &mut conn,
            1,
            "lot-a",
            "a",
            "actor-a",
            2.,
            5.,
            3.,
            9.,
            Some(GAIN),
        )
        .await
        .unwrap();
        conn.execute("COMMIT").await.unwrap();
        let row = sqlx::query(
            "SELECT pharmacy_id,actor_id,direction,unit_cost_cents,valuation_cents,
              inventory_account_id,counterpart_account_id,counterpart_type,journal_id
             FROM native_stock_ledger_provenance WHERE adjustment_id=1",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(row.try_get::<String, _>("pharmacy_id").unwrap(), "a");
        assert_eq!(row.try_get::<String, _>("actor_id").unwrap(), "actor-a");
        assert_eq!(row.try_get::<String, _>("direction").unwrap(), "increase");
        assert_eq!(row.try_get::<i64, _>("unit_cost_cents").unwrap(), 300);
        assert_eq!(row.try_get::<i64, _>("valuation_cents").unwrap(), 900);
        assert_eq!(row.try_get::<i64, _>("inventory_account_id").unwrap(), 10);
        assert_eq!(row.try_get::<i64, _>("counterpart_account_id").unwrap(), 12);
        assert_eq!(
            row.try_get::<String, _>("counterpart_type").unwrap(),
            "revenue"
        );
        assert_eq!(row.try_get::<String, _>("journal_id").unwrap(), GAIN);
    }

    #[tokio::test]
    async fn zero_cost_adjustment_provenance_requires_null_journal() {
        let mut conn = fixture().await;
        stock(&mut conn, 2, "lot-free", "actor-a", 4., 5.).await;
        record_adjustment_provenance(
            &mut conn, 2, "lot-free", "a", "actor-a", 4., 5., 0., 0., None,
        )
        .await
        .unwrap();
        assert_eq!(count(&mut conn).await, 1);
        let linked: Option<String> = sqlx::query_scalar(
            "SELECT journal_id FROM native_stock_ledger_provenance WHERE adjustment_id=2",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(linked, None);
        assert!(record_adjustment_provenance(
            &mut conn,
            2,
            "lot-free",
            "a",
            "actor-a",
            4.,
            5.,
            0.,
            1.,
            Some(GAIN)
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn decrease_reconciles_expense_and_requires_correct_journal_tenant() {
        let mut conn = fixture().await;
        stock(&mut conn, 3, "lot-a", "actor-a", 6., 5.).await;
        journal(&mut conn, LOSS, "actor-a", "b", 3., false, 11).await;
        assert!(record_adjustment_provenance(
            &mut conn,
            3,
            "lot-a",
            "a",
            "actor-a",
            6.,
            5.,
            3.,
            3.,
            Some(LOSS)
        )
        .await
        .is_err());
        assert_eq!(count(&mut conn).await, 0);
        conn.execute("UPDATE daily_journals SET pharmacy_id='a'")
            .await
            .unwrap();
        record_adjustment_provenance(
            &mut conn,
            3,
            "lot-a",
            "a",
            "actor-a",
            6.,
            5.,
            3.,
            3.,
            Some(LOSS),
        )
        .await
        .unwrap();
        assert_eq!(count(&mut conn).await, 1);
        let direction: String = sqlx::query_scalar(
            "SELECT direction FROM native_stock_ledger_provenance WHERE adjustment_id=3",
        )
        .fetch_one(&mut conn)
        .await
        .unwrap();
        assert_eq!(direction, "decrease");
    }

    #[tokio::test]
    async fn foreign_branch_inactive_actor_wrong_lot_and_source_missing_fail_closed() {
        let mut conn = fixture().await;
        stock(&mut conn, 4, "lot-b", "actor-b", 3., 6.).await;
        assert!(record_adjustment_provenance(
            &mut conn,
            4,
            "lot-b",
            "a",
            "actor-b",
            3.,
            6.,
            3.,
            9.,
            Some(GAIN)
        )
        .await
        .is_err());
        stock(&mut conn, 5, "lot-a", "inactive-a", 4., 5.).await;
        assert!(record_adjustment_provenance(
            &mut conn,
            5,
            "lot-a",
            "a",
            "inactive-a",
            4.,
            5.,
            3.,
            3.,
            Some(GAIN)
        )
        .await
        .is_err());
        assert!(record_adjustment_provenance(
            &mut conn,
            99,
            "lot-a",
            "a",
            "actor-a",
            4.,
            5.,
            3.,
            3.,
            Some(GAIN)
        )
        .await
        .is_err());
        assert!(record_adjustment_provenance(
            &mut conn,
            5,
            "lot-b",
            "b",
            "actor-b",
            4.,
            5.,
            3.,
            3.,
            Some(GAIN)
        )
        .await
        .is_err());
        assert_eq!(count(&mut conn).await, 0);
    }

    #[tokio::test]
    async fn unbalanced_unpostable_and_wrong_direction_accounts_rejected() {
        let mut conn = fixture().await;
        stock(&mut conn, 6, "lot-a", "actor-a", 3., 5.).await;
        journal(&mut conn, GAIN, "actor-a", "a", 6., true, 11).await;
        assert!(
            record_adjustment_provenance(
                &mut conn,
                6,
                "lot-a",
                "a",
                "actor-a",
                3.,
                5.,
                3.,
                6.,
                Some(GAIN)
            )
            .await
            .is_err(),
            "a gain must credit a revenue account"
        );
        conn.execute(
            "UPDATE journal_entries SET account_id=12 WHERE journal_id=
                      'native-lot-adjust-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
                      AND type='credit'",
        )
        .await
        .unwrap();
        conn.execute(
            "UPDATE journal_entries SET amount=5 WHERE journal_id=
                      'native-lot-adjust-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
                      AND type='credit'",
        )
        .await
        .unwrap();
        assert!(
            record_adjustment_provenance(
                &mut conn,
                6,
                "lot-a",
                "a",
                "actor-a",
                3.,
                5.,
                3.,
                6.,
                Some(GAIN)
            )
            .await
            .is_err(),
            "imbalanced or differing value must not be attached"
        );
        conn.execute(
            "UPDATE journal_entries SET amount=6 WHERE journal_id=
                      'native-lot-adjust-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
                      AND type='credit'",
        )
        .await
        .unwrap();
        record_adjustment_provenance(
            &mut conn,
            6,
            "lot-a",
            "a",
            "actor-a",
            3.,
            5.,
            3.,
            6.,
            Some(GAIN),
        )
        .await
        .unwrap();
        assert_eq!(count(&mut conn).await, 1);
    }

    #[tokio::test]
    async fn source_or_journal_duplicate_claims_are_unique() {
        let mut conn = fixture().await;
        stock(&mut conn, 7, "lot-a", "actor-a", 4., 5.).await;
        journal(&mut conn, GAIN, "actor-a", "a", 3., true, 12).await;
        record_adjustment_provenance(
            &mut conn,
            7,
            "lot-a",
            "a",
            "actor-a",
            4.,
            5.,
            3.,
            3.,
            Some(GAIN),
        )
        .await
        .unwrap();
        assert!(record_adjustment_provenance(
            &mut conn,
            7,
            "lot-a",
            "a",
            "actor-a",
            4.,
            5.,
            3.,
            3.,
            Some(GAIN)
        )
        .await
        .is_err());
        stock(&mut conn, 8, "lot-a", "actor-a", 4., 5.).await;
        assert!(
            record_adjustment_provenance(
                &mut conn,
                8,
                "lot-a",
                "a",
                "actor-a",
                4.,
                5.,
                3.,
                3.,
                Some(GAIN)
            )
            .await
            .is_err(),
            "same journal cannot certify two adjustments"
        );
        assert_eq!(count(&mut conn).await, 1);
    }

    #[tokio::test]
    async fn forward_only_triggers_protect_linked_source_journal_entries_without_freezing_legacy() {
        let mut conn = fixture().await;
        stock(&mut conn, 9, "lot-a", "actor-a", 4., 5.).await;
        journal(&mut conn, GAIN, "actor-a", "a", 3., true, 12).await;
        record_adjustment_provenance(
            &mut conn,
            9,
            "lot-a",
            "a",
            "actor-a",
            4.,
            5.,
            3.,
            3.,
            Some(GAIN),
        )
        .await
        .unwrap();
        for statement in [
            "UPDATE native_stock_ledger_provenance SET actor_id='actor-b' WHERE adjustment_id=9",
            "DELETE FROM native_stock_ledger_provenance WHERE adjustment_id=9",
            "UPDATE stock_adjustments SET new_quantity=6 WHERE id=9",
            "DELETE FROM stock_adjustments WHERE id=9",
            "UPDATE daily_journals SET pharmacy_id='b' WHERE id='native-lot-adjust-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
            "DELETE FROM daily_journals WHERE id='native-lot-adjust-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
            "UPDATE journal_entries SET amount=2 WHERE journal_id='native-lot-adjust-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
            "DELETE FROM journal_entries WHERE journal_id='native-lot-adjust-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'",
            "INSERT INTO journal_entries(journal_id,account_id,type,amount)
             VALUES('native-lot-adjust-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',11,'debit',3)",
        ] {
            assert!(conn.execute(statement).await.is_err(),"{statement}");
        }
        // Legacy rows with no explicit provenance must remain modifiable.
        stock(&mut conn, 10, "lot-b", "actor-b", 5., 6.).await;
        conn.execute("UPDATE stock_adjustments SET new_quantity=7 WHERE id=10")
            .await
            .unwrap();
        assert_eq!(count(&mut conn).await, 1);
    }

    #[tokio::test]
    async fn provenance_insert_rolls_back_with_native_transaction_and_no_legacy_rewrites() {
        let mut conn = fixture().await;
        conn.execute("BEGIN IMMEDIATE").await.unwrap();
        stock(&mut conn, 11, "lot-a", "actor-a", 2., 5.).await;
        journal(&mut conn, GAIN_2, "actor-a", "a", 9., true, 12).await;
        record_adjustment_provenance(
            &mut conn,
            11,
            "lot-a",
            "a",
            "actor-a",
            2.,
            5.,
            3.,
            9.,
            Some(GAIN_2),
        )
        .await
        .unwrap();
        assert_eq!(count(&mut conn).await, 1);
        conn.execute("ROLLBACK").await.unwrap();
        assert_eq!(count(&mut conn).await, 0);
        let adjustment_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM stock_adjustments WHERE id=11")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(adjustment_count, 0);
        let amount: f64 = sqlx::query_scalar("SELECT quantity FROM inventory WHERE id='lot-a'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(amount, 5.0);
        let legacy: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM native_stock_ledger_provenance")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(legacy, 0);
    }
}
