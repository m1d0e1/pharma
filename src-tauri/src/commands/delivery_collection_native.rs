//! Atomic collection of a receipted, completed delivery sale.
//! The sale's original financial values and 043 journal remain immutable.
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
const DELIVERY_PAGE_SIZE: usize = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryCollectionInput {
    sale_id: String,
    delivery_fee: f64,
    request_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryCollectionPosted {
    id: String,
    sale_id: String,
    collected_amount: f64,
    delivery_fee: f64,
}

#[derive(Debug, Serialize)]
pub struct PendingNativeDelivery {
    id: String,
    created_at: String,
    total_amount: f64,
    patient_name: Option<String>,
    patient_phone: Option<String>,
    patient_address: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryQueueCursor {
    created_at: String,
    id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingNativeDeliveryPage {
    rows: Vec<PendingNativeDelivery>,
    has_more: bool,
    next_cursor: Option<DeliveryQueueCursor>,
}

fn validated_cursor(
    cursor: Option<DeliveryQueueCursor>,
) -> Result<Option<DeliveryQueueCursor>, String> {
    if let Some(ref cursor) = cursor {
        if cursor.id.is_empty()
            || cursor.id.len() > 128
            || cursor.id.trim() != cursor.id
            || cursor.created_at.len() > 64
            || cursor.id.chars().any(char::is_control)
            || cursor.created_at.chars().any(char::is_control)
        {
            return Err("Invalid delivery pagination cursor".into());
        }
    }
    Ok(cursor)
}

async fn pending_delivery_page(
    conn: &mut SqliteConnection,
    actor: &str,
    cursor: Option<DeliveryQueueCursor>,
) -> Result<PendingNativeDeliveryPage, String> {
    let cursor = validated_cursor(cursor)?;
    let pharmacy = collection_actor(conn, actor).await?;
    // Fixed SQL: renderer has no generic SELECT on private sales/patients in
    // secure release. Only receipted same-tenant deliveries are actionable.
    let rows = sqlx::query(
        "SELECT s.id,COALESCE(s.created_at,'') created_at,s.total_amount,
                p.full_name patient_name,p.phone patient_phone,p.address patient_address
         FROM main.sales_invoices s
         JOIN main.native_sale_cogs_provenance proof ON proof.sale_id=s.id
              AND proof.pharmacy_id=s.pharmacy_id AND proof.payment_method='delivery'
         -- Patient identity is an existing global catalog (001 has no patient
         -- pharmacy_id). Its details are exposed only through this tenant-owned
         -- sale's verified patient foreign key, never by arbitrary renderer SQL.
         LEFT JOIN main.patients p ON p.id=s.patient_id
         WHERE s.pharmacy_id=? AND s.payment_method='delivery' AND s.status='completed'
           -- The 045 cash writer can only collect an original whole-cent A/R.
           -- Fractional 043 amounts require independent finance resolution,
           -- never a silently rounded tender in this operator queue.
           AND proof.sale_micros % 10000=0
           AND typeof(s.total_amount) IN ('integer','real')
           AND s.total_amount BETWEEN 0 AND 1000000000
           AND abs(s.total_amount*100-proof.sale_micros/10000.0)<0.0000001
           AND NOT EXISTS(SELECT 1 FROM main.native_delivery_collection_receipts receipt
                          WHERE receipt.sale_id=s.id)
           AND (? IS NULL OR COALESCE(s.created_at,'') < ?
                OR (COALESCE(s.created_at,'') = ? AND s.id < ?))
         ORDER BY COALESCE(s.created_at,'') DESC,s.id DESC LIMIT 101",
    )
    .bind(&pharmacy)
    .bind(cursor.as_ref().map(|value| value.created_at.as_str()))
    .bind(cursor.as_ref().map(|value| value.created_at.as_str()))
    .bind(cursor.as_ref().map(|value| value.created_at.as_str()))
    .bind(cursor.as_ref().map(|value| value.id.as_str()))
    .fetch_all(conn)
    .await
    .map_err(|e| format!("Cannot read scoped native delivery queue: {e}"))?;
    let has_more = rows.len() > DELIVERY_PAGE_SIZE;
    let rows: Vec<PendingNativeDelivery> = rows
        .into_iter()
        .take(DELIVERY_PAGE_SIZE)
        .map(|row| {
            let total: f64 = row.try_get("total_amount").map_err(|e| e.to_string())?;
            if !total.is_finite() || !(0.0..=1_000_000_000.0).contains(&total) {
                return Err("Native delivery queue contains invalid financial amount".into());
            }
            Ok(PendingNativeDelivery {
                id: row.try_get("id").map_err(|e| e.to_string())?,
                created_at: row
                    .try_get::<Option<String>, _>("created_at")
                    .map_err(|e| e.to_string())?
                    .unwrap_or_default(),
                total_amount: total,
                patient_name: row.try_get("patient_name").map_err(|e| e.to_string())?,
                patient_phone: row.try_get("patient_phone").map_err(|e| e.to_string())?,
                patient_address: row.try_get("patient_address").map_err(|e| e.to_string())?,
            })
        })
        .collect::<Result<_, String>>()?;
    let next_cursor = if has_more {
        rows.last().map(|row| DeliveryQueueCursor {
            created_at: row.created_at.clone(),
            id: row.id.clone(),
        })
    } else {
        None
    };
    Ok(PendingNativeDeliveryPage {
        rows,
        has_more,
        next_cursor,
    })
}

#[tauri::command]
pub async fn list_pending_deliveries_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    cursor: Option<DeliveryQueueCursor>,
) -> Result<PendingNativeDeliveryPage, String> {
    let actor = session.authorize_session().await?;
    let actor = actor
        .as_deref()
        .ok_or("Login required to list deliveries")?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    pending_delivery_page(&mut conn, actor, cursor).await
}

fn validate_input(input: &DeliveryCollectionInput) -> Result<i64, String> {
    let request_id = Uuid::parse_str(&input.request_id)
        .map_err(|_| "Collection requires a canonical UUIDv4 requestId")?;
    if request_id.get_version_num() != 4 || request_id.to_string() != input.request_id {
        return Err("Collection requires a canonical UUIDv4 requestId".into());
    }
    if input.sale_id.is_empty()
        || input.sale_id.len() > 128
        || input.sale_id.trim() != input.sale_id
        || input.sale_id.chars().any(char::is_control)
    {
        return Err("Invalid delivery sale ID".into());
    }
    exact_cents(input.delivery_fee)
}

fn exact_cents(value: f64) -> Result<i64, String> {
    if !value.is_finite() || value < 0.0 || value > MAX_CENTS as f64 / 100.0 {
        return Err("Collection amount exceeds finite monetary bounds".into());
    }
    let rounded = (value * 100.0).round();
    if (value * 100.0 - rounded).abs() > 0.000_000_1 {
        return Err("Collection fee must have exact cent precision".into());
    }
    Ok(rounded as i64)
}

async fn collection_actor(conn: &mut SqliteConnection, actor: &str) -> Result<String, String> {
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
        "can_view_delivery",
        false,
    ) {
        return Err("Authenticated user cannot collect deliveries".into());
    }
    if pharmacy.is_empty() || pharmacy.len() > 128 {
        return Err("Invalid authenticated pharmacy".into());
    }
    Ok(pharmacy)
}

async fn verified_account(
    conn: &mut SqliteConnection,
    category: &str,
    code: &str,
    kind: &str,
) -> Result<i64, String> {
    // A configured mapping may narrow the canonical account, never redirect
    // cash, receivables or fee revenue to another account or a group.
    sqlx::query_scalar(
        "SELECT a.id FROM main.accounts a
         WHERE a.code=? AND a.type=? AND COALESCE(a.is_group,0)=0
           AND NOT EXISTS(SELECT 1 FROM main.accounts child WHERE child.parent_id=a.id)
           AND (
             NOT EXISTS(SELECT 1 FROM main.trial_balance_settings t WHERE t.category=?)
             OR EXISTS(
               SELECT 1 FROM main.trial_balance_settings t
               WHERE t.category=? AND t.account_id=a.id AND t.target_type='account'
             )
           ) LIMIT 1",
    )
    .bind(code)
    .bind(kind)
    .bind(category)
    .bind(category)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("Missing or unsafe accounting mapping for {category}"))
}

async fn posting_and_sale(
    conn: &mut SqliteConnection,
    sale_id: &str,
    pharmacy: &str,
) -> Result<i64, String> {
    let source = sqlx::query(
        "SELECT CAST(s.total_amount AS REAL) total, p.sale_micros, p.cogs_micros,
                p.journal_id, p.actor_id
         FROM main.sales_invoices s
         JOIN main.native_sale_cogs_provenance p
           ON p.sale_id=s.id AND p.pharmacy_id=s.pharmacy_id
         WHERE s.id=? AND s.pharmacy_id=? AND s.payment_method='delivery'
           AND s.status='completed' AND p.payment_method='delivery'",
    )
    .bind(sale_id)
    .bind(pharmacy)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or("Delivery is missing, belongs to another pharmacy, was already collected, or lacks verifiable native sale provenance")?;

    let amount: f64 = source.try_get("total").map_err(|e| e.to_string())?;
    let sale_micros: i64 = source.try_get("sale_micros").map_err(|e| e.to_string())?;
    let cogs_micros: i64 = source.try_get("cogs_micros").map_err(|e| e.to_string())?;
    let original_cents = exact_cents(amount)?;
    if sale_micros < 0 || sale_micros != original_cents * 10_000 || cogs_micros < 0 {
        return Err("Original sale amount is inconsistent with immutable posting".into());
    }
    let journal_id: String = source.try_get("journal_id").map_err(|e| e.to_string())?;
    let original_actor: String = source.try_get("actor_id").map_err(|e| e.to_string())?;
    // Require the *known source journal*, its tenant, its original actor and
    // the actual accounts. Description searches and client mappings cannot
    // prove the receivable exists. Reject legacy cash-classified deliveries.
    let valid: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM main.daily_journals j
         WHERE j.id=? AND j.pharmacy_id=? AND CAST(j.created_by AS TEXT)=?
           AND typeof(j.total_amount) IN ('real','integer')
           AND abs(j.total_amount*1000000-(?+?))<2
           AND EXISTS (
             SELECT 1 FROM main.journal_entries e
             JOIN main.accounts a ON a.id=e.account_id
             WHERE e.journal_id=j.id GROUP BY e.journal_id
             HAVING count(*)=CASE WHEN ?>0 THEN 4 ELSE 2 END
               AND abs(sum(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END)
                       -sum(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END))<0.000001
               AND sum(CASE WHEN a.code='1.1.2' AND e.type='debit'
                             AND abs(e.amount*1000000-?)<1 THEN 1 ELSE 0 END)=1
               AND sum(CASE WHEN a.code='3.1' AND e.type='credit'
                             AND abs(e.amount*1000000-?)<1 THEN 1 ELSE 0 END)=1
               AND sum(CASE WHEN a.code='4.1' AND e.type='debit'
                             AND abs(e.amount*1000000-?)<1 THEN 1 ELSE 0 END)
                    =CASE WHEN ?>0 THEN 1 ELSE 0 END
               AND sum(CASE WHEN a.code='1.1.3' AND e.type='credit'
                             AND abs(e.amount*1000000-?)<1 THEN 1 ELSE 0 END)
                    =CASE WHEN ?>0 THEN 1 ELSE 0 END
           )",
    )
    .bind(journal_id)
    .bind(pharmacy)
    .bind(original_actor)
    .bind(sale_micros)
    .bind(cogs_micros)
    .bind(cogs_micros)
    .bind(sale_micros)
    .bind(sale_micros)
    .bind(cogs_micros)
    .bind(cogs_micros)
    .bind(cogs_micros)
    .bind(cogs_micros)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if valid != 1 {
        return Err("Original delivery journal is not an authentic receivable posting".into());
    }
    Ok(original_cents)
}

async fn collect_with_lock(
    conn: &mut SqliteConnection,
    actor: &str,
    input: DeliveryCollectionInput,
) -> Result<DeliveryCollectionPosted, String> {
    let fee_cents = validate_input(&input)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN IMMEDIATE")))
            .await
            .map_err(|e| e.to_string())?;
    let result = async {
        let conn = &mut *tx;
        let pharmacy = collection_actor(conn, actor).await?;
        let replay: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.native_delivery_collection_receipts WHERE request_id=? OR sale_id=?",
        )
        .bind(&input.request_id)
        .bind(&input.sale_id)
        .fetch_one(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if replay != 0 {
            return Err("Delivery has already been collected or requestId has already been used".into());
        }
        let sale_cents = posting_and_sale(conn, &input.sale_id, &pharmacy).await?;
        let total_cents = sale_cents
            .checked_add(fee_cents)
            .filter(|amount| (1..=MAX_CENTS).contains(amount))
            .ok_or("Collected amount exceeds monetary bounds")?;

        let shift_rows = sqlx::query(
            "SELECT id FROM main.shifts WHERE pharmacy_id=? AND status='open' LIMIT 2",
        )
        .bind(&pharmacy)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        if shift_rows.len() != 1 {
            return Err("Collection requires exactly one open shift in this pharmacy".into());
        }
        let shift_id: String = shift_rows[0].try_get("id").map_err(|e| e.to_string())?;
        let cash = verified_account(conn, "cash_drawer", "1.1.1", "asset").await?;
        let receivable =
            verified_account(conn, "accounts_receivable", "1.1.2", "asset").await?;
        let fee_revenue =
            verified_account(conn, "other_cash_income", "3.2", "revenue").await?;

        let receipt_id = format!("delivery-{}", input.request_id);
        let movement_id = format!("delivery-cash-{}", input.request_id);
        let journal_id = format!("delivery-journal-{}", input.request_id);
        let total = total_cents as f64 / 100.0;
        let sale = sale_cents as f64 / 100.0;
        let fee = fee_cents as f64 / 100.0;
        sqlx::query(
            "INSERT INTO main.daily_journals
             (id,date,description,created_by,total_amount,pharmacy_id)
             VALUES(?,DATE('now','localtime'),?,?,?,?)",
        )
        .bind(&journal_id)
        .bind(format!("Delivery cash collection: {}", input.sale_id))
        .bind(actor)
        .bind(total)
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        for (account, kind, value) in [
            (cash, "debit", total),
            (receivable, "credit", sale),
            (fee_revenue, "credit", fee),
        ] {
            if value == 0.0 {
                continue;
            }
            sqlx::query(
                "INSERT INTO main.journal_entries(journal_id,account_id,type,amount)
                 VALUES(?,?,?,?)",
            )
            .bind(&journal_id)
            .bind(account)
            .bind(kind)
            .bind(value)
            .execute(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;
        }
        sqlx::query(
            "INSERT INTO main.cash_movements
             (id,user_id,shift_id,type,category,amount,notes,date,pharmacy_id,source_type)
             VALUES(?,?,?,'receipt','delivery',?,?,DATE('now','localtime'),?,'delivery_collection')",
        )
        .bind(&movement_id)
        .bind(actor)
        .bind(&shift_id)
        .bind(total)
        .bind(format!("Delivery sale {} (fee {:.2})", input.sale_id, fee))
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        // 045 insert guard independently verifies the source, tenant, posting,
        // shift, ledger and cash movement. AFTER INSERT transitions status.
        sqlx::query(
            "INSERT INTO main.native_delivery_collection_receipts
             (id,request_id,sale_id,pharmacy_id,actor_id,shift_id,journal_id,
              movement_id,sale_cents,fee_cents,total_cents)
             VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&receipt_id)
        .bind(&input.request_id)
        .bind(&input.sale_id)
        .bind(&pharmacy)
        .bind(actor)
        .bind(&shift_id)
        .bind(&journal_id)
        .bind(&movement_id)
        .bind(sale_cents)
        .bind(fee_cents)
        .bind(total_cents)
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("Delivery collection receipt rejected: {e}"))?;
        sqlx::query(
            "INSERT INTO main.activity_log(user_id,action,details,pharmacy_id)
             VALUES(?,'DELIVERY_COLLECTED_NATIVE',?,?)",
        )
        .bind(actor)
        .bind(format!("request={}; sale={}; amount_cents={total_cents}; fee_cents={fee_cents}", input.request_id, input.sale_id))
        .bind(&pharmacy)
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
        Ok(DeliveryCollectionPosted {
            id: receipt_id,
            sale_id: input.sale_id,
            collected_amount: total,
            delivery_fee: fee,
        })
    }
    .await;
    match result {
        Ok(posted) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(posted)
        }
        Err(error) => {
            tx.rollback()
                .await
                .map_err(|failed| format!("{error}; rollback: {failed}"))?;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn collect_delivery_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: DeliveryCollectionInput,
) -> Result<DeliveryCollectionPosted, String> {
    let actor = session.authorize_session().await?;
    let actor = actor
        .as_deref()
        .ok_or("Login is required to collect deliveries")?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    collect_with_lock(&mut conn, actor, payload).await
}

// Resolve an unknown IPC outcome by inspecting the committed receipt. This
// path never retries a financial write. A nonce alone, or a sale alone, cannot
// acknowledge another actor's tender or a different fee.
async fn confirmed_collection(
    conn: &mut SqliteConnection,
    actor: &str,
    input: &DeliveryCollectionInput,
) -> Result<Option<DeliveryCollectionPosted>, String> {
    let fee_cents = validate_input(input)?;
    reset_cancelled_read_state(conn).await?;
    let pharmacy = collection_actor(conn, actor).await?;
    let row = sqlx::query(
        "SELECT r.id,r.total_cents
         FROM main.native_delivery_collection_receipts r
         JOIN main.sales_invoices s ON s.id=r.sale_id AND s.pharmacy_id=r.pharmacy_id
         JOIN main.native_sale_cogs_provenance p
           ON p.sale_id=s.id AND p.pharmacy_id=r.pharmacy_id
         JOIN main.daily_journals j ON j.id=r.journal_id
         JOIN main.cash_movements m ON m.id=r.movement_id
         JOIN main.shifts sh ON sh.id=r.shift_id
         WHERE r.request_id=? AND r.sale_id=? AND r.pharmacy_id=?
           AND CAST(r.actor_id AS TEXT)=? AND r.fee_cents=?
           AND r.id=? AND r.journal_id=? AND r.movement_id=?
           AND s.status='delivered' AND s.payment_method='delivery'
           AND p.payment_method='delivery'
           AND typeof(s.total_amount) IN ('integer','real')
           AND abs(s.total_amount*100-r.sale_cents)<0.000001
           AND p.sale_micros=r.sale_cents*10000
           AND r.total_cents=r.sale_cents+r.fee_cents AND r.total_cents>0
           AND j.pharmacy_id=r.pharmacy_id AND CAST(j.created_by AS TEXT)=r.actor_id
           AND typeof(j.total_amount) IN ('integer','real')
           AND abs(j.total_amount*100-r.total_cents)<0.000001
           AND m.pharmacy_id=r.pharmacy_id AND CAST(m.user_id AS TEXT)=r.actor_id
           AND m.shift_id=r.shift_id AND sh.pharmacy_id=r.pharmacy_id
           AND m.type='receipt' AND m.category='delivery'
           AND m.source_type='delivery_collection'
           AND typeof(m.amount) IN ('integer','real')
           AND abs(m.amount*100-r.total_cents)<0.000001
           AND EXISTS(
             SELECT 1 FROM main.journal_entries e
             JOIN main.accounts a ON a.id=e.account_id
             WHERE e.journal_id=r.journal_id GROUP BY e.journal_id
             HAVING count(*)=CASE WHEN r.sale_cents>0 AND r.fee_cents>0 THEN 3 ELSE 2 END
               AND abs(sum(CASE WHEN e.type='debit' THEN e.amount ELSE 0 END)
                       -sum(CASE WHEN e.type='credit' THEN e.amount ELSE 0 END))<0.000001
               AND sum(CASE WHEN a.code='1.1.1' AND a.type='asset'
                   AND e.type='debit' AND abs(e.amount*100-r.total_cents)<0.000001
                   THEN 1 ELSE 0 END)=1
               AND sum(CASE WHEN a.code='1.1.2' AND a.type='asset'
                   AND e.type='credit' AND abs(e.amount*100-r.sale_cents)<0.000001
                   THEN 1 ELSE 0 END)=CASE WHEN r.sale_cents>0 THEN 1 ELSE 0 END
               AND sum(CASE WHEN a.code='3.2' AND a.type='revenue'
                   AND e.type='credit' AND abs(e.amount*100-r.fee_cents)<0.000001
                   THEN 1 ELSE 0 END)=CASE WHEN r.fee_cents>0 THEN 1 ELSE 0 END
           ) LIMIT 1",
    )
    .bind(&input.request_id)
    .bind(&input.sale_id)
    .bind(&pharmacy)
    .bind(actor)
    .bind(fee_cents)
    .bind(format!("delivery-{}", input.request_id))
    .bind(format!("delivery-journal-{}", input.request_id))
    .bind(format!("delivery-cash-{}", input.request_id))
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| format!("Unable to confirm native delivery receipt: {e}"))?;
    row.map(|row| {
        let total_cents: i64 = row.try_get("total_cents").map_err(|e| e.to_string())?;
        if !(1..=MAX_CENTS).contains(&total_cents) {
            return Err("Invalid confirmed collection total".into());
        }
        Ok(DeliveryCollectionPosted {
            id: row.try_get("id").map_err(|e| e.to_string())?,
            sale_id: input.sale_id.clone(),
            collected_amount: total_cents as f64 / 100.0,
            delivery_fee: fee_cents as f64 / 100.0,
        })
    })
    .transpose()
}

#[tauri::command]
pub async fn confirm_delivery_collection_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: DeliveryCollectionInput,
) -> Result<Option<DeliveryCollectionPosted>, String> {
    let actor = session.authorize_session().await?;
    let actor = actor
        .as_deref()
        .ok_or("Login required to confirm collection")?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    confirmed_collection(&mut conn, actor, &payload).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqliteConnectOptions;
    use sqlx::Connection;

    const REQUEST: &str = "12345678-aaaa-4aaa-8aaa-123456789abc";

    async fn fixture(initial_debit_code: &str) -> SqliteConnection {
        let conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        fixture_with_connection(conn, initial_debit_code).await
    }

    async fn fixture_with_connection(
        mut conn: SqliteConnection,
        initial_debit_code: &str,
    ) -> SqliteConnection {
        sqlx::raw_sql(
            r#"
            PRAGMA foreign_keys=ON;
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,is_active INTEGER,permissions TEXT);
            INSERT INTO users VALUES
              ('owner-a','owner','A',1,'{}'),
              ('owner-b','owner','B',1,'{}'),
              ('denied-a','cashier','A',1,'{"can_view_delivery":false}'),
              ('inactive-a','owner','A',0,'{}');
            CREATE TABLE shifts(id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,status TEXT);
            INSERT INTO shifts VALUES ('open-a','owner-a','A','open'),('open-b','owner-b','B','open');
            CREATE TABLE sales_invoices(
              id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,status TEXT,
              payment_method TEXT,total_amount REAL
            );
            INSERT INTO sales_invoices VALUES ('sale-a','owner-a','A','completed','delivery',20.00);
            CREATE TABLE sales_items(
              id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,drug_id INTEGER,
              is_negative INTEGER,cost_price REAL,quantity_sold REAL,unit_price REAL,
              unit TEXT,large_to_medium REAL,medium_to_small REAL
            );
            INSERT INTO sales_items VALUES(1,'sale-a',NULL,1,1,0,1,20,'large',1,1);
            CREATE TABLE returns(
              id TEXT PRIMARY KEY,invoice_id TEXT,user_id TEXT,pharmacy_id TEXT,
              status TEXT,total_refund REAL,refund_method TEXT
            );
            CREATE TABLE return_items(
              id INTEGER PRIMARY KEY,return_id TEXT,inventory_id TEXT,drug_id INTEGER,
              sale_item_id INTEGER,quantity_returned REAL,unit TEXT,total_price REAL
            );
            CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT,drug_id INTEGER);
            CREATE TABLE accounts(
              id INTEGER PRIMARY KEY,code TEXT UNIQUE, parent_id INTEGER,
              type TEXT,is_group INTEGER
            );
            INSERT INTO accounts VALUES
              (6,'1.1.1',NULL,'asset',0),(8,'1.1.2',NULL,'asset',0),
              (9,'3.1',NULL,'revenue',0),(10,'1.1.3',NULL,'asset',0),
              (11,'4.1',NULL,'expense',0),(12,'3.2',NULL,'revenue',0);
            CREATE TABLE trial_balance_settings(category TEXT UNIQUE,account_id INTEGER,target_type TEXT);
            INSERT INTO trial_balance_settings VALUES
              ('cash_drawer',6,'account'),('accounts_receivable',8,'account'),
              ('other_cash_income',12,'account');
            CREATE TABLE daily_journals(
              id TEXT PRIMARY KEY,date TEXT,description TEXT,created_by TEXT,
              total_amount REAL,pharmacy_id TEXT
            );
            CREATE TABLE journal_entries(
              id INTEGER PRIMARY KEY AUTOINCREMENT,journal_id TEXT,account_id INTEGER,
              type TEXT,amount REAL
            );
            CREATE TABLE cash_movements(
              id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,type TEXT,category TEXT,
              amount REAL,notes TEXT,date TEXT,pharmacy_id TEXT,source_type TEXT
            );
            CREATE TABLE activity_log(user_id TEXT,action TEXT,details TEXT,pharmacy_id TEXT);
            "#,
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/043_native_sales_cogs_provenance.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        let debit_id = if initial_debit_code == "1.1.2" { 8 } else { 6 };
        sqlx::query("INSERT INTO daily_journals VALUES('original','2026-10-12','Original sale','owner-a',20,'A')")
            .execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES('original',?,'debit',20)")
            .bind(debit_id).execute(&mut conn).await.unwrap();
        sqlx::query("INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES('original',9,'credit',20)")
            .execute(&mut conn).await.unwrap();
        sqlx::query(
            "INSERT INTO native_sale_cogs_provenance
             (sale_id,request_id,pharmacy_id,actor_id,journal_id,payment_method,
              sale_micros,cogs_micros,line_count,line_snapshot)
             VALUES('sale-a','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A','owner-a',
                    'original','delivery',20000000,0,1,'[{}]')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/045_native_delivery_collection.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    fn request(sale: &str, fee: f64, id: &str) -> DeliveryCollectionInput {
        DeliveryCollectionInput {
            sale_id: sale.to_string(),
            delivery_fee: fee,
            request_id: id.to_string(),
        }
    }

    #[tokio::test]
    async fn fractional_delivery_is_not_presented_as_collectible_cash() {
        let mut conn = fixture("1.1.2").await;
        sqlx::raw_sql(
            "ALTER TABLE sales_invoices ADD COLUMN created_at TEXT;
             ALTER TABLE sales_invoices ADD COLUMN patient_id TEXT;
             CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT,phone TEXT,address TEXT);
             INSERT INTO sales_invoices(id,user_id,pharmacy_id,status,payment_method,total_amount,created_at)
               VALUES('sale-fraction','owner-a','A','completed','delivery',20.004,'2026-10-12');
             INSERT INTO sales_items(invoice_id,drug_id,is_negative,cost_price,quantity_sold,unit_price,unit,large_to_medium,medium_to_small)
               VALUES('sale-fraction',1,1,0,1,20.004,'large',1,1);
             INSERT INTO daily_journals VALUES('original-fraction','2026-10-12','Fractional delivery','owner-a',20.004,'A');
             INSERT INTO journal_entries(journal_id,account_id,type,amount)
               VALUES('original-fraction',8,'debit',20.004),('original-fraction',9,'credit',20.004);
             INSERT INTO native_sale_cogs_provenance
               (sale_id,request_id,pharmacy_id,actor_id,journal_id,payment_method,sale_micros,cogs_micros,line_count,line_snapshot)
               VALUES('sale-fraction','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','A','owner-a','original-fraction','delivery',20004000,0,1,'[{}]');",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        assert!(
            collect_with_lock(&mut conn, "owner-a", request("sale-fraction", 0.0, REQUEST))
                .await
                .is_err(),
            "An original 20.004 receivable cannot be collected as a whole-cent cash amount"
        );
        let page = pending_delivery_page(&mut conn, "owner-a", None)
            .await
            .unwrap();
        assert_eq!(
            page.rows
                .iter()
                .map(|row| row.id.as_str())
                .collect::<Vec<_>>(),
            vec!["sale-a"]
        );
    }

    #[tokio::test]
    async fn pending_queue_never_uses_renderer_sql_or_shows_foreign_or_collected_sales() {
        let mut conn = fixture("1.1.2").await;
        sqlx::raw_sql(
            "ALTER TABLE sales_invoices ADD COLUMN created_at TEXT;
             ALTER TABLE sales_invoices ADD COLUMN patient_id TEXT;
             CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT,phone TEXT,address TEXT);
             INSERT INTO patients VALUES('patient-a','Alice','555','Branch A');
             UPDATE sales_invoices SET patient_id='patient-a',created_at='2026-10-12 12:00:00'
             WHERE id='sale-a';",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        let queue = pending_delivery_page(&mut conn, "owner-a", None)
            .await
            .unwrap();
        assert_eq!(queue.rows.len(), 1);
        assert!(!queue.has_more);
        assert_eq!(queue.rows[0].id, "sale-a");
        assert_eq!(queue.rows[0].patient_name.as_deref(), Some("Alice"));
        assert_eq!(queue.rows[0].total_amount, 20.0);
        assert!(pending_delivery_page(&mut conn, "denied-a", None)
            .await
            .is_err());
        assert!(pending_delivery_page(&mut conn, "inactive-a", None)
            .await
            .is_err());
        assert!(pending_delivery_page(&mut conn, "owner-b", None)
            .await
            .unwrap()
            .rows
            .is_empty());
        collect_with_lock(&mut conn, "owner-a", request("sale-a", 2.25, REQUEST))
            .await
            .unwrap();
        assert!(pending_delivery_page(&mut conn, "owner-a", None)
            .await
            .unwrap()
            .rows
            .is_empty());
    }

    #[tokio::test]
    async fn keyset_queue_lets_operators_clear_over_200_pending_sales() {
        let mut conn = fixture("1.1.2").await;
        sqlx::raw_sql(
            "ALTER TABLE sales_invoices ADD COLUMN created_at TEXT;
             ALTER TABLE sales_invoices ADD COLUMN patient_id TEXT;
             CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT,phone TEXT,address TEXT);
             UPDATE sales_invoices SET created_at='2026-10-12 12:00:00';",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        for index in 0..205 {
            let sale = format!("sale-{index:03}");
            let journal = format!("original-{index:03}");
            let nonce = format!("12345678-1234-4123-8123-{index:012}");
            sqlx::query(
                "INSERT INTO sales_invoices(id,user_id,pharmacy_id,status,payment_method,total_amount,created_at)
                 VALUES(?,'owner-a','A','completed','delivery',20,'2026-10-12 12:00:00')",
            ).bind(&sale).execute(&mut conn).await.unwrap();
            sqlx::query("INSERT INTO sales_items(invoice_id,drug_id,is_negative,cost_price,quantity_sold,unit_price,unit,large_to_medium,medium_to_small) VALUES(?,1,1,0,1,20,'large',1,1)")
                .bind(&sale).execute(&mut conn).await.unwrap();
            sqlx::query(
                "INSERT INTO daily_journals VALUES(?,'2026-10-12','Sale','owner-a',20,'A')",
            )
            .bind(&journal)
            .execute(&mut conn)
            .await
            .unwrap();
            sqlx::query("INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES(?,8,'debit',20),(?,9,'credit',20)")
                .bind(&journal).bind(&journal).execute(&mut conn).await.unwrap();
            sqlx::query(
                "INSERT INTO native_sale_cogs_provenance
                 (sale_id,request_id,pharmacy_id,actor_id,journal_id,payment_method,
                  sale_micros,cogs_micros,line_count,line_snapshot)
                 VALUES(?,?,'A','owner-a',?,'delivery',20000000,0,1,'[{}]')",
            )
            .bind(&sale)
            .bind(nonce)
            .bind(&journal)
            .execute(&mut conn)
            .await
            .unwrap();
        }
        let mut cursor = None;
        let mut ids = std::collections::HashSet::new();
        let mut sizes = Vec::new();
        loop {
            let page = pending_delivery_page(&mut conn, "owner-a", cursor)
                .await
                .unwrap();
            sizes.push(page.rows.len());
            for row in page.rows {
                assert!(ids.insert(row.id), "Cursor repeated a sale");
            }
            if !page.has_more {
                assert!(page.next_cursor.is_none());
                break;
            }
            cursor = page.next_cursor;
            assert!(cursor.is_some());
        }
        assert_eq!(sizes, vec![100, 100, 6]);
        assert_eq!(ids.len(), 206);
        assert!(pending_delivery_page(&mut conn, "owner-b", None)
            .await
            .unwrap()
            .rows
            .is_empty());
        assert!(pending_delivery_page(
            &mut conn,
            "owner-a",
            Some(DeliveryQueueCursor {
                created_at: "2026-10-12".into(),
                id: "sale-000\n".into()
            })
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn unknown_ipc_ack_requires_same_actor_tenant_nonce_sale_and_fee() {
        let mut conn = fixture("1.1.2").await;
        let original = request("sale-a", 2.25, REQUEST);
        assert!(confirmed_collection(&mut conn, "owner-a", &original)
            .await
            .unwrap()
            .is_none());
        collect_with_lock(&mut conn, "owner-a", request("sale-a", 2.25, REQUEST))
            .await
            .unwrap();
        let confirmed = confirmed_collection(&mut conn, "owner-a", &original)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(confirmed.id, format!("delivery-{REQUEST}"));
        assert_eq!(confirmed.sale_id, "sale-a");
        assert_eq!(confirmed.delivery_fee, 2.25);
        assert_eq!(confirmed.collected_amount, 22.25);
        for wrong in [
            request("sale-a", 2.26, REQUEST),
            request("other-sale", 2.25, REQUEST),
            request("sale-a", 2.25, "12345678-aaaa-4aaa-8aaa-123456789abd"),
        ] {
            assert!(confirmed_collection(&mut conn, "owner-a", &wrong)
                .await
                .unwrap()
                .is_none());
        }
        assert!(confirmed_collection(&mut conn, "owner-b", &original)
            .await
            .unwrap()
            .is_none());
        assert!(confirmed_collection(&mut conn, "denied-a", &original)
            .await
            .is_err());
        sqlx::query("UPDATE shifts SET status='closed' WHERE id='open-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            confirmed_collection(&mut conn, "owner-a", &original)
                .await
                .unwrap()
                .is_some(),
            "Closed shifts must not hide a legitimate historical receipt"
        );
        sqlx::query("UPDATE users SET pharmacy_id='B' WHERE id='owner-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(confirmed_collection(&mut conn, "owner-a", &original)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn collection_balances_new_journal_and_preserves_original_sale() {
        let mut conn = fixture("1.1.2").await;
        let posted = collect_with_lock(&mut conn, "owner-a", request("sale-a", 2.25, REQUEST))
            .await
            .unwrap();
        assert_eq!(posted.collected_amount, 22.25);
        assert_eq!(posted.delivery_fee, 2.25);
        let (status, total): (String, f64) =
            sqlx::query_as("SELECT status,total_amount FROM sales_invoices WHERE id='sale-a'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(status, "delivered");
        assert_eq!(total, 20.0);
        let posting: Vec<(String, String, f64)> = sqlx::query_as(
            "SELECT a.code,e.type,e.amount FROM journal_entries e
             JOIN accounts a ON a.id=e.account_id WHERE e.journal_id=?
             ORDER BY e.id",
        )
        .bind(format!("delivery-journal-{REQUEST}"))
        .fetch_all(&mut conn)
        .await
        .unwrap();
        assert_eq!(
            posting,
            vec![
                ("1.1.1".into(), "debit".into(), 22.25),
                ("1.1.2".into(), "credit".into(), 20.0),
                ("3.2".into(), "credit".into(), 2.25),
            ]
        );
        let original_entries: i64 =
            sqlx::query_scalar("SELECT count(*) FROM journal_entries WHERE journal_id='original'")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(original_entries, 2);
        let mut protected = [
            "UPDATE sales_invoices SET total_amount=30 WHERE id='sale-a'",
            "UPDATE native_delivery_collection_receipts SET fee_cents=0 WHERE sale_id='sale-a'",
            "UPDATE journal_entries SET amount=5 WHERE journal_id='original'",
            "UPDATE journal_entries SET amount=5 WHERE journal_id LIKE 'delivery-journal-%'",
            "DELETE FROM cash_movements WHERE id LIKE 'delivery-cash-%'",
        ];
        for statement in protected.iter_mut() {
            assert!(
                sqlx::query(statement).execute(&mut conn).await.is_err(),
                "{statement}"
            );
        }
        assert!(
            collect_with_lock(&mut conn, "owner-a", request("sale-a", 2.25, REQUEST))
                .await
                .is_err()
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM native_delivery_collection_receipts")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn two_independent_collectors_cannot_double_post_one_delivery() {
        // Use a real *synthetic* SQLite file rather than two handles to the
        // same in-memory connection: BEGIN IMMEDIATE must arbitrate actual
        // concurrent writers across connections and preserve one financial
        // source/receipt, even when each operator request has a unique nonce.
        let path = std::env::temp_dir().join(format!(
            "pharma-delivery-collect-race-{}.db",
            Uuid::new_v4()
        ));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(std::time::Duration::from_secs(3));
        // Build a synthetic committed fixture directly on disk. In-memory
        // VACUUM INTO is not a reliable path-publication fixture on Windows.
        let seed = fixture_with_connection(
            SqliteConnection::connect_with(&options).await.unwrap(),
            "1.1.2",
        )
        .await;
        seed.close().await.unwrap();
        assert!(path.is_file());

        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(false)
            .foreign_keys(true)
            .busy_timeout(std::time::Duration::from_secs(3));
        let mut first = SqliteConnection::connect_with(&options).await.unwrap();
        let mut second = SqliteConnection::connect_with(&options).await.unwrap();
        let nonce_a = Uuid::new_v4().to_string();
        let nonce_b = Uuid::new_v4().to_string();
        let (a, b) = tokio::join!(
            collect_with_lock(&mut first, "owner-a", request("sale-a", 2.25, &nonce_a)),
            collect_with_lock(&mut second, "owner-a", request("sale-a", 2.25, &nonce_b)),
        );
        assert_eq!(a.is_ok() as u8 + b.is_ok() as u8, 1, "{a:?} | {b:?}");
        let posted = a.ok().or_else(|| b.ok()).unwrap();
        assert_eq!(posted.collected_amount, 22.25);
        let receipt_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM native_delivery_collection_receipts")
                .fetch_one(&mut first)
                .await
                .unwrap();
        let cash_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM cash_movements WHERE source_type='delivery_collection'",
        )
        .fetch_one(&mut first)
        .await
        .unwrap();
        let journal_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM daily_journals WHERE id LIKE 'delivery-journal-%'",
        )
        .fetch_one(&mut first)
        .await
        .unwrap();
        assert_eq!((receipt_count, cash_count, journal_count), (1, 1, 1));
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT status FROM sales_invoices WHERE id='sale-a'")
                .fetch_one(&mut first)
                .await
                .unwrap(),
            "delivered"
        );
        // The original receivable posting is never rewritten by either
        // participant, including the one that lost the writer race.
        assert_eq!(
            sqlx::query_scalar::<_, f64>(
                "SELECT total_amount FROM sales_invoices WHERE id='sale-a'"
            )
            .fetch_one(&mut first)
            .await
            .unwrap(),
            20.0
        );
        first.close().await.unwrap();
        second.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn rejects_wrong_tenant_permission_shift_mapping_and_cash_classification() {
        let mut conn = fixture("1.1.2").await;
        for actor in ["owner-b", "denied-a", "inactive-a"] {
            assert!(
                collect_with_lock(&mut conn, actor, request("sale-a", 1.0, REQUEST))
                    .await
                    .is_err()
            );
        }
        assert!(
            collect_with_lock(&mut conn, "owner-a", request("nonexistent", 1.0, REQUEST))
                .await
                .is_err()
        );
        sqlx::query("UPDATE shifts SET status='closed' WHERE id='open-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            collect_with_lock(&mut conn, "owner-a", request("sale-a", 1.0, REQUEST))
                .await
                .is_err()
        );
        sqlx::query("UPDATE shifts SET status='open' WHERE id='open-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("UPDATE trial_balance_settings SET account_id=8 WHERE category='cash_drawer'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            collect_with_lock(&mut conn, "owner-a", request("sale-a", 1.0, REQUEST))
                .await
                .is_err()
        );
        let mut cash_posted = fixture("1.1.1").await;
        assert!(
            collect_with_lock(&mut cash_posted, "owner-a", request("sale-a", 1.0, REQUEST))
                .await
                .is_err()
        );
        let receipts: i64 =
            sqlx::query_scalar("SELECT count(*) FROM native_delivery_collection_receipts")
                .fetch_one(&mut cash_posted)
                .await
                .unwrap();
        assert_eq!(receipts, 0);
    }

    #[test]
    fn bounded_cents_and_uuid() {
        assert_eq!(exact_cents(12.34).unwrap(), 1234);
        for value in [f64::NAN, f64::INFINITY, -1.0, 0.001, 1_000_000_000.01] {
            assert!(exact_cents(value).is_err());
        }
        let input = DeliveryCollectionInput {
            sale_id: "sale-1".into(),
            delivery_fee: 1.25,
            request_id: Uuid::new_v4().to_string(),
        };
        assert_eq!(validate_input(&input).unwrap(), 125);
        assert!(validate_input(&DeliveryCollectionInput {
            request_id: Uuid::nil().to_string(),
            ..input
        })
        .is_err());
    }
}
