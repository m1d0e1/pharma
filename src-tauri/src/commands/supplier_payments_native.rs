//! A deliberately bounded supplier settlement: one unedited, receipted credit
//! invoice with no other supplier history. Historical global supplier balances
//! and mixed-tenant ledgers cannot establish a payable owner.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupplierPaymentInput {
    supplier_id: i64,
    amount: f64,
    payment_method: String,
    date: String,
    notes: Option<String>,
    request_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierPaymentPosted {
    id: String,
    remaining_balance: f64,
}

/// Read-only proof of a prior 054 posting after a missing WebView IPC reply.
/// A receipt UUID or mutable supplier balance on its own is never sufficient.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplierPaymentConfirmation {
    id: String,
    supplier_id: i64,
    invoice_id: String,
    actor_id: String,
    pharmacy_id: String,
    amount_cents: i64,
    remaining_balance: f64,
}

/// Recovery proof accepts a hash of optional free-text notes, not the notes
/// themselves. The browser must not persist private supplier correspondence.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmSupplierPaymentInput {
    supplier_id: i64,
    amount: f64,
    payment_method: String,
    date: String,
    request_id: String,
    notes_sha256: String,
}

fn note_digest(notes: Option<&str>) -> String {
    format!("{:x}", Sha256::digest(notes.unwrap_or("").as_bytes()))
}

fn valid_date(value: &str) -> bool {
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
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    year > 0 && day > 0 && day <= days
}

fn cents(amount: f64) -> Result<i64, String> {
    if !amount.is_finite()
        || amount <= 0.0
        || amount > 1_000_000_000_000.0
        || (amount * 100.0 - (amount * 100.0).round()).abs() > 0.0000001
    {
        return Err("Supplier tender must be a positive exact-cent amount".into());
    }
    Ok((amount * 100.0).round() as i64)
}

fn validate(input: &SupplierPaymentInput) -> Result<i64, String> {
    let id =
        Uuid::parse_str(&input.request_id).map_err(|_| "Invalid supplier payment request ID")?;
    if id.get_version_num() != 4
        || id.to_string() != input.request_id
        || input.supplier_id <= 0
        || !matches!(input.payment_method.as_str(), "cash" | "bank")
        || !valid_date(&input.date)
        || input
            .notes
            .as_deref()
            .is_some_and(|s| s.len() > 500 || s.chars().any(char::is_control))
    {
        return Err("Invalid supplier payment request".into());
    }
    cents(input.amount)
}

async fn account(conn: &mut SqliteConnection, category: &str, code: &str) -> Result<i64, String> {
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT a.id FROM accounts a WHERE a.code=? AND COALESCE(a.is_group,0)=0
         AND (NOT EXISTS(SELECT 1 FROM trial_balance_settings t WHERE t.category=?)
              OR EXISTS(SELECT 1 FROM trial_balance_settings t
                        WHERE t.category=? AND t.account_id=a.id)) LIMIT 2",
    )
    .bind(code)
    .bind(category)
    .bind(category)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if ids.len() != 1 {
        return Err("Supplier payment requires unique canonical ledger accounts".into());
    }
    Ok(ids[0])
}

/// A prior credit purchase return reduces the same supplier payable only if
/// the *actual* 041/048 immutable source, tenant, item lines, journal and
/// supplier return ledger still agree. Legacy/unreceipted, cash and mixed
/// supplier returns are deliberately not adopted for new money collection.
/// Called only after BEGIN IMMEDIATE, so no concurrent writer may alter proof.
async fn certified_credit_returns(
    conn: &mut SqliteConnection,
    supplier_id: i64,
    invoice_id: &str,
    pharmacy: &str,
) -> Result<(i64, i64), String> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM purchase_returns WHERE supplier_id=?",
    )
    .bind(supplier_id)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if count == 0 {
        return Ok((0, 0));
    }
    let suspicious: i64 = sqlx::query_scalar(
        r#"SELECT EXISTS(
             SELECT 1 FROM purchase_returns pr
             LEFT JOIN native_purchase_return_provenance rp ON rp.return_id=pr.id
             WHERE pr.supplier_id=? AND (
                rp.return_id IS NULL OR rp.supplier_id<>pr.supplier_id
                OR rp.purchase_invoice_id<>? OR pr.purchase_invoice_id<>?
                OR rp.pharmacy_id<>? OR pr.refund_method<>'credit'
                OR rp.refund_method<>'credit' OR lower(trim(pr.status))<>'completed'
                OR CAST(pr.user_id AS TEXT)<>rp.actor_id
                OR typeof(pr.total_amount) NOT IN ('integer','real')
                OR abs(pr.total_amount*100-rp.amount_cents)>0.0001
                OR rp.amount_cents<=0 OR rp.line_count<1
                OR (SELECT COUNT(*) FROM purchase_return_items ri
                    WHERE ri.purchase_return_id=pr.id)<>rp.line_count
                OR (SELECT COUNT(*) FROM native_purchase_return_line_provenance l
                    WHERE l.return_id=pr.id)<>rp.line_count
                OR abs(COALESCE((
                    SELECT SUM(l.refund_value) FROM native_purchase_return_line_provenance l
                    WHERE l.return_id=pr.id),0)*100-rp.amount_cents)>0.0001
                OR EXISTS(SELECT 1 FROM native_purchase_return_line_provenance l
                    LEFT JOIN purchase_return_items ri ON ri.id=l.return_item_id
                    LEFT JOIN purchase_invoice_items pi ON pi.id=l.purchase_invoice_item_id
                    LEFT JOIN inventory i ON i.id=l.inventory_id
                    WHERE l.return_id=pr.id AND (
                      ri.id IS NULL OR pi.id IS NULL OR i.id IS NULL
                      OR ri.purchase_return_id IS NOT pr.id
                      OR ri.purchase_invoice_item_id IS NOT l.purchase_invoice_item_id
                      OR ri.inventory_id IS NOT l.inventory_id
                      OR pi.invoice_id IS NOT rp.purchase_invoice_id
                      OR pi.inventory_id IS NOT l.inventory_id
                      OR i.pharmacy_id IS NOT rp.pharmacy_id
                      OR i.drug_id IS NOT pi.drug_id
                      OR ri.drug_id IS NOT pi.drug_id
                      OR typeof(pi.cost_price) NOT IN ('integer','real')
                      OR pi.cost_price<0
                      OR typeof(i.cost_price) NOT IN ('integer','real')
                      OR i.cost_price<0
                      OR typeof(ri.quantity_returned) NOT IN ('integer','real')
                      OR abs(ri.quantity_returned-l.quantity_returned)>0.000000001
                      OR typeof(ri.total_price) NOT IN ('integer','real')
                      OR abs(ri.total_price-l.refund_value)>0.0001))
                OR NOT EXISTS(SELECT 1 FROM daily_journals j
                    WHERE j.id=rp.journal_id AND j.pharmacy_id=rp.pharmacy_id
                      AND CAST(j.created_by AS TEXT)=rp.actor_id
                      AND typeof(j.total_amount) IN ('integer','real')
                      AND abs(j.total_amount*100-rp.amount_cents)<0.0001)
                OR (SELECT COUNT(*) FROM journal_entries je
                    WHERE je.journal_id=rp.journal_id)<>2
                OR (SELECT COUNT(*) FROM journal_entries je JOIN accounts a ON a.id=je.account_id
                    WHERE je.journal_id=rp.journal_id AND je.type='debit'
                      AND a.code='2.1' AND COALESCE(a.is_group,0)=0
                      AND abs(je.amount*100-rp.amount_cents)<0.0001)<>1
                OR (SELECT COUNT(*) FROM journal_entries je JOIN accounts a ON a.id=je.account_id
                    WHERE je.journal_id=rp.journal_id AND je.type='credit'
                      AND a.code='1.1.3' AND COALESCE(a.is_group,0)=0
                      AND abs(je.amount*100-rp.amount_cents)<0.0001)<>1
                OR (SELECT COUNT(*) FROM supplier_transactions st
                    WHERE st.reference_id=pr.id AND st.supplier_id=pr.supplier_id
                      AND st.type='return' AND typeof(st.amount) IN ('real','integer')
                      AND abs(st.amount*100-rp.amount_cents)<0.0001)<>1
                OR (SELECT COUNT(*) FROM supplier_transactions st
                    WHERE st.reference_id=pr.id)<>1
                OR EXISTS(SELECT 1 FROM cash_movements cm
                    WHERE cm.source_type='purchase_return' AND cm.target_name=pr.id)
             ))"#,
    )
    .bind(supplier_id)
    .bind(invoice_id)
    .bind(invoice_id)
    .bind(pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if suspicious != 0 {
        return Err("Supplier has an unreceipted, cross-tenant or mismatched purchase return".into());
    }
    let (credited_cents, receipts): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(rp.amount_cents),0),COUNT(*)
         FROM native_purchase_return_provenance rp
         WHERE rp.supplier_id=? AND rp.purchase_invoice_id=? AND rp.pharmacy_id=?
           AND rp.refund_method='credit'",
    )
    .bind(supplier_id)
    .bind(invoice_id)
    .bind(pharmacy)
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if receipts != count || credited_cents < 0 {
        return Err("Supplier purchase-return provenance count is incomplete".into());
    }
    Ok((credited_cents, receipts))
}

async fn pay_with_lock(
    conn: &mut SqliteConnection,
    actor: &str,
    input: SupplierPaymentInput,
) -> Result<SupplierPaymentPosted, String> {
    let amount_cents = validate(&input)?;
    // A retry after a lost native IPC response must satisfy the *same strict
    // original-source/journal/ledger confirmation* as an explicit recovery
    // lookup. A row containing the same UUID and mutable supplier notes is
    // not, by itself, proof that the original debit committed correctly.
    let replay_confirmation = ConfirmSupplierPaymentInput {
        supplier_id: input.supplier_id,
        amount: input.amount,
        payment_method: input.payment_method.clone(),
        date: input.date.clone(),
        request_id: input.request_id.clone(),
        notes_sha256: note_digest(input.notes.as_deref()),
    };
    let mut is_replay = false;
    reset_cancelled_read_state(conn).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;
    let result = async {
        let (role, pharmacy) = active_generic_actor(conn,actor).await?;
        let user = sqlx::query("SELECT permissions,pharmacy_id FROM users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1")
            .bind(actor).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let explicit_pharmacy: Option<String> = user.try_get("pharmacy_id").map_err(|e|e.to_string())?;
        // NULL/blank/local_default are historical compatibility labels, not
        // independently proven ownership of a payable. Recovery confirmation
        // already refuses local_default. The writer must apply the identical
        // eligibility rule *before* creating money, a journal or receipt.
        if explicit_pharmacy.as_deref()!=Some(pharmacy.as_str()) || pharmacy=="local_default" {
            return Err("Supplier payment requires explicit owned pharmacy".into());
        }
        let permissions:Option<String> = user.try_get("permissions").map_err(|e|e.to_string())?;
        if !user_has_permission(Some(&role),permissions.as_deref(),"can_view_suppliers",false)
            || !user_has_permission(Some(&role),permissions.as_deref(),"acc_can_process_cash_flow",false) {
            return Err("Authenticated role cannot settle suppliers".into());
        }
        let quarantined: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM native_owner_scope_review WHERE owner_id=? LIMIT 1"
        ).bind(actor).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
        if quarantined.is_some() { return Err("Pharmacy owner scope requires independent review".into()); }
        // An ambiguous IPC response can be retried with the same persisted ID.
        let prior = sqlx::query("SELECT r.id,r.actor_id,r.pharmacy_id,r.supplier_id,r.amount_cents,
                 r.payment_method,r.payment_date,r.balance_after_cents,st.notes AS ledger_notes
                 FROM native_supplier_payment_receipts r
                 JOIN supplier_transactions st ON st.id=r.supplier_transaction_id
                   AND st.supplier_id=r.supplier_id
                 WHERE r.request_id=?")
            .bind(&input.request_id).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
        if let Some(prior) = prior {
            let same = prior.get::<String,_>("actor_id")==actor
                && prior.get::<String,_>("pharmacy_id")==pharmacy
                && prior.get::<i64,_>("supplier_id")==input.supplier_id
                && prior.get::<i64,_>("amount_cents")==amount_cents
                && prior.get::<String,_>("payment_method")==input.payment_method
                && prior.get::<String,_>("payment_date")==input.date
                && prior.try_get::<Option<String>,_>("ledger_notes")
                    .map_err(|e|e.to_string())?.as_deref()==input.notes.as_deref();
            if !same { return Err("Supplier payment request ID already belongs to another intent".into()); }
            is_replay = true;
            return Ok(SupplierPaymentPosted {
                id:prior.get("id"),
                remaining_balance:prior.get::<i64,_>("balance_after_cents") as f64/100.0,
            });
        }
        // A supplier row is global. Only the *sole* native-receipted credit
        // invoice and its exact ledger allow us to prove this payable's tenant.
        let source = sqlx::query(
            "SELECT p.id,p.total_amount,s.balance,c.source_total_cents
             FROM purchase_invoices p JOIN suppliers s ON s.id=p.supplier_id
             JOIN native_purchase_create_requests c ON c.invoice_id=p.id
             JOIN native_purchase_posting_events e ON e.journal_id=c.initial_journal_id
             WHERE p.supplier_id=? AND p.pharmacy_id=? AND p.status='completed'
               AND p.payment_method='credit' AND c.source_status='completed'
               AND c.pharmacy_id=? AND c.supplier_id=p.supplier_id
               AND CAST(p.user_id AS TEXT)=c.actor_id AND c.actor_id=e.actor_id
               AND e.invoice_id=p.id AND e.event_kind='initial'
               AND e.payment_method='credit' AND e.pharmacy_id=?
               AND e.supplier_id=p.supplier_id AND e.new_total_cents=c.source_total_cents
               AND (SELECT count(*) FROM purchase_invoices allp WHERE allp.supplier_id=p.supplier_id)=1
               AND (SELECT count(*) FROM native_purchase_posting_events ev WHERE ev.invoice_id=p.id)=1"
        ).bind(input.supplier_id).bind(&pharmacy).bind(&pharmacy).bind(&pharmacy)
         .fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?
         .ok_or("Supplier ownership is unverifiable; reconcile legacy or mixed history before payment")?;
        let invoice_id: String=source.try_get("id").map_err(|e|e.to_string())?;
        let original_cents: i64=source.try_get("source_total_cents").map_err(|e|e.to_string())?;
        let invoice_total: f64=source.try_get("total_amount").map_err(|e|e.to_string())?;
        let current_balance: f64=source.try_get("balance").map_err(|e|e.to_string())?;
        if cents(invoice_total)?!=original_cents || !current_balance.is_finite()
           || current_balance<0.01 || (current_balance*100.0-(current_balance*100.0).round()).abs()>0.0000001 {
            return Err("Supplier payable source or balance is not cent-exact".into());
        }
        let before=(current_balance*100.0).round() as i64;
        let paid: i64=sqlx::query_scalar(
            "SELECT COALESCE(SUM(amount_cents),0) FROM native_supplier_payment_receipts WHERE supplier_id=?"
        ).bind(input.supplier_id).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let supplier_rows: i64=sqlx::query_scalar(
            "SELECT COUNT(*) FROM supplier_transactions WHERE supplier_id=?"
        ).bind(input.supplier_id).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let good_invoice_rows:i64=sqlx::query_scalar(
            "SELECT COUNT(*) FROM supplier_transactions WHERE supplier_id=? AND type='invoice' AND reference_id=?
             AND typeof(amount) IN ('real','integer') AND abs(amount*100-?)<0.0001"
        ).bind(input.supplier_id).bind(&invoice_id).bind(original_cents)
         .fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let prior_count:i64=sqlx::query_scalar(
            "SELECT count(*) FROM native_supplier_payment_receipts WHERE supplier_id=? AND invoice_id=? AND pharmacy_id=?"
        ).bind(input.supplier_id).bind(&invoice_id).bind(&pharmacy)
         .fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        let (returned_cents, return_rows) =
            certified_credit_returns(conn, input.supplier_id, &invoice_id, &pharmacy).await?;
        let expected_balance = original_cents.checked_sub(paid)
            .and_then(|remaining| remaining.checked_sub(returned_cents))
            .ok_or("Supplier payable deductions exceed original credited cost")?;
        if before!=expected_balance || before<amount_cents
            || good_invoice_rows!=1 || supplier_rows!=prior_count+return_rows+1 {
            return Err("Supplier balance or supplier ledger lacks canonical provenance".into());
        }
        let shift = if input.payment_method=="cash" {
            let shifts:Vec<String>=sqlx::query_scalar(
                "SELECT CAST(id AS TEXT) FROM shifts WHERE pharmacy_id=? AND lower(trim(status))='open' LIMIT 2"
            ).bind(&pharmacy).fetch_all(&mut *conn).await.map_err(|e|e.to_string())?;
            if shifts.len()!=1 { return Err("Supplier cash settlement requires exactly one open owned shift".into()); }
            Some(shifts[0].clone())
        } else { None };
        let payable=account(conn,"accounts_payable","2.1").await?;
        let funding=if shift.is_some() {
            account(conn,"cash_drawer","1.1.1").await?
        } else {
            account(conn,"bank_clearing","1.1.4").await?
        };
        if payable==funding { return Err("Supplier payable and funding accounts must differ".into()); }
        let id=Uuid::new_v4().to_string();
        let journal_id=Uuid::new_v4().to_string();
        let movement_id=shift.as_ref().map(|_|Uuid::new_v4().to_string());
        let entry=sqlx::query(
            "INSERT INTO supplier_transactions(supplier_id,user_id,type,amount,reference_id,payment_method,notes,date)
             VALUES(?,?,'payment',?,?,?, ?,?)"
        ).bind(input.supplier_id).bind(actor).bind(input.amount)
         .bind(format!("supplier-payment:{id}")).bind(&input.payment_method)
         .bind(&input.notes).bind(&input.date)
         .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        let transaction_id=entry.last_insert_rowid();
        if let (Some(shift),Some(movement_id))=(shift.as_ref(),movement_id.as_ref()) {
            sqlx::query(
                "INSERT INTO cash_movements(id,user_id,shift_id,type,category,amount,source_type,target_name,notes,date,pharmacy_id)
                 VALUES(?,?,?,'disbursement','accounts_payable',?,'supplier_payment',?,?,?,?)"
            ).bind(movement_id).bind(actor).bind(shift).bind(input.amount)
             .bind(&id).bind(&input.notes).bind(&input.date).bind(&pharmacy)
             .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        }
        sqlx::query("INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id) VALUES(?,?,?,?,?,?)")
            .bind(&journal_id).bind(&input.date).bind(format!("Supplier payment {id}"))
            .bind(actor).bind(input.amount).bind(&pharmacy)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        for (account,side) in [(payable,"debit"),(funding,"credit")] {
            sqlx::query("INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES(?,?,?,?)")
                .bind(&journal_id).bind(account).bind(side).bind(input.amount)
                .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        }
        sqlx::query(
            "INSERT INTO native_supplier_payment_receipts
             (id,request_id,supplier_id,invoice_id,supplier_transaction_id,pharmacy_id,actor_id,
              amount_cents,payment_method,payment_date,journal_id,cash_movement_id,
              balance_before_cents,balance_after_cents)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
        ).bind(&id).bind(&input.request_id).bind(input.supplier_id)
         .bind(&invoice_id).bind(transaction_id).bind(&pharmacy).bind(actor)
         .bind(amount_cents).bind(&input.payment_method).bind(&input.date)
         .bind(&journal_id).bind(&movement_id).bind(before).bind(before-amount_cents)
         .execute(&mut *conn).await.map_err(|e|format!("Supplier posting provenance refused commit: {e}"))?;
        let updated=sqlx::query("UPDATE suppliers SET balance=? WHERE id=? AND abs(balance*100-?)<0.0001")
            .bind((before-amount_cents) as f64/100.0).bind(input.supplier_id).bind(before)
            .execute(&mut *conn).await.map_err(|e|e.to_string())?;
        if updated.rows_affected()!=1 { return Err("Supplier balance changed during settlement".into()); }
        sqlx::query("INSERT INTO activity_log(user_id,action,details,pharmacy_id) VALUES(?,'SUPPLIER_PAYMENT',?,?)")
            .bind(actor).bind(format!("Receipted supplier payment {id}"))
            .bind(&pharmacy).execute(&mut *conn).await.map_err(|e|e.to_string())?;
        Ok(SupplierPaymentPosted { id,remaining_balance:(before-amount_cents) as f64/100.0 })
    }.await;
    match result {
        Ok(value) => match sqlx::query("COMMIT").execute(&mut *conn).await {
            Ok(_) => {
                if !is_replay {
                    return Ok(value);
                }
                // The writer lock is released before beginning the read-only
                // snapshot. Only an independently complete 042/044/054 and
                // 041/048 (when returned) receipt may acknowledge a retry.
                match confirm_payment_without_posting(conn, actor, replay_confirmation).await? {
                    Some(proven)
                        if proven.id == value.id
                            && (proven.remaining_balance - value.remaining_balance).abs()
                                < 0.000001 =>
                    {
                        Ok(value)
                    }
                    _ => Err(
                        "Supplier payment prior request lacks verifiable financial provenance; reconcile before retry"
                            .into(),
                    ),
                }
            }
            Err(e) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
                Err(e.to_string())
            }
        },
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(error)
        }
    }
}

async fn confirm_payment_without_posting(
    conn: &mut SqliteConnection,
    actor: &str,
    input: ConfirmSupplierPaymentInput,
) -> Result<Option<SupplierPaymentConfirmation>, String> {
    let amount_cents = validate(&SupplierPaymentInput {
        supplier_id: input.supplier_id, amount: input.amount,
        payment_method: input.payment_method.clone(), date: input.date.clone(),
        notes: None, request_id: input.request_id.clone(),
    })?;
    if input.notes_sha256.len()!=64 || !input.notes_sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("Invalid supplier confirmation notes digest".into());
    }
    reset_cancelled_read_state(conn).await?;
    // One coherent SQLite read snapshot. Do not acquire a write lock, update a
    // receipt, create a request ID, or try the payment writer from here.
    sqlx::query("BEGIN").execute(&mut *conn).await.map_err(|e| e.to_string())?;
    let result = async {
        let (role, pharmacy) = active_generic_actor(conn, actor).await?;
        let actor_row = sqlx::query(
            "SELECT pharmacy_id,permissions FROM main.users
             WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
        ).bind(actor).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
        let explicit: Option<String> = actor_row.try_get("pharmacy_id").map_err(|e| e.to_string())?;
        let perms: Option<String> = actor_row.try_get("permissions").map_err(|e| e.to_string())?;
        if explicit.as_deref()!=Some(pharmacy.as_str()) || pharmacy=="local_default" ||
            !user_has_permission(Some(&role),perms.as_deref(),"can_view_suppliers",false) ||
            !user_has_permission(Some(&role),perms.as_deref(),"acc_can_process_cash_flow",false) {
            return Err("Current user cannot certify supplier settlement".into());
        }
        let quarantined: Option<i64> = sqlx::query_scalar(
            "SELECT 1 FROM main.native_owner_scope_review WHERE owner_id=? LIMIT 1",
        ).bind(actor).fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
        if quarantined.is_some() {return Err("Owner scope requires independent review".into());}

        // This binds the WHOLE original supplier intent, its 042/044 source,
        // 054 receipt, mutable supplier transaction and current balance. A
        // later valid payment is allowed but all such receipts must be scoped.
        let match_row = sqlx::query(r#"
          SELECT r.id, r.invoice_id, r.balance_after_cents,
                 st.notes AS ledger_notes
          FROM main.native_supplier_payment_receipts r
          JOIN main.supplier_transactions st ON st.id=r.supplier_transaction_id
          JOIN main.purchase_invoices p ON p.id=r.invoice_id
          JOIN main.native_purchase_create_requests c ON c.invoice_id=p.id
          JOIN main.native_purchase_posting_events e ON e.journal_id=c.initial_journal_id
          JOIN main.suppliers s ON s.id=r.supplier_id
          JOIN main.daily_journals j ON j.id=r.journal_id
          WHERE r.request_id=? AND r.supplier_id=? AND r.actor_id=?
            AND r.pharmacy_id=? AND r.amount_cents=?
            AND r.payment_method=? AND r.payment_date=?
            AND r.balance_before_cents-r.balance_after_cents=r.amount_cents
            AND st.supplier_id=r.supplier_id AND st.user_id=r.actor_id
            AND st.type='payment' AND st.payment_method=r.payment_method
            AND st.date=r.payment_date AND st.reference_id='supplier-payment:'||r.id
            AND typeof(st.amount) IN ('integer','real')
            AND abs(st.amount*100-r.amount_cents)<0.00001
            AND p.supplier_id=r.supplier_id AND p.pharmacy_id=r.pharmacy_id
            AND p.status='completed' AND p.payment_method='credit'
            AND CAST(p.user_id AS TEXT)=c.actor_id AND c.actor_id=e.actor_id
            AND c.source_status='completed' AND c.pharmacy_id=r.pharmacy_id
            AND c.supplier_id=r.supplier_id AND e.invoice_id=p.id
            AND e.event_kind='initial' AND e.payment_method='credit'
            AND e.pharmacy_id=r.pharmacy_id AND e.supplier_id=r.supplier_id
            AND e.new_total_cents=c.source_total_cents
            AND typeof(p.total_amount) IN ('integer','real')
            AND abs(p.total_amount*100-c.source_total_cents)<0.00001
            AND typeof(s.balance) IN ('integer','real')
            -- Subsequent independently 041/048-receipted CREDIT purchase
            -- returns reduce the payable. Compare to the full current source
            -- evolution, not the historic 054 balance_after snapshot.
            AND abs(s.balance*100 - (c.source_total_cents-
              (SELECT COALESCE(SUM(allr.amount_cents),0)
               FROM main.native_supplier_payment_receipts allr
               WHERE allr.supplier_id=r.supplier_id)-
              (SELECT COALESCE(SUM(pr.amount_cents),0)
               FROM main.native_purchase_return_provenance pr
               WHERE pr.supplier_id=r.supplier_id AND pr.purchase_invoice_id=r.invoice_id
                 AND pr.pharmacy_id=r.pharmacy_id AND pr.refund_method='credit')))<0.00001
            AND (SELECT COUNT(*) FROM main.purchase_invoices pi
                 WHERE pi.supplier_id=r.supplier_id)=1
            AND (SELECT COUNT(*) FROM main.native_purchase_posting_events pe
                 WHERE pe.invoice_id=p.id)=1
            -- The invoice ledger row is distinct from the immutable 042/044
            -- receipt. A matching total row count cannot replace proof that
            -- the original supplier credit was actually entered at full cost.
            AND (SELECT COUNT(*) FROM main.supplier_transactions original_st
                 WHERE original_st.supplier_id=r.supplier_id
                   AND original_st.type='invoice'
                   AND original_st.reference_id=r.invoice_id
                   AND typeof(original_st.amount) IN ('integer','real')
                   AND abs(original_st.amount*100-c.source_total_cents)<0.00001)=1
            -- Every later return must be backed by its original immutable
            -- 041 witness; legacy, foreign or mismatched claims are not proof.
            AND NOT EXISTS(
              SELECT 1 FROM main.purchase_returns pr
              LEFT JOIN main.native_purchase_return_provenance rp ON rp.return_id=pr.id
              WHERE pr.supplier_id=r.supplier_id AND (
                rp.return_id IS NULL OR rp.supplier_id<>r.supplier_id
                OR rp.purchase_invoice_id<>r.invoice_id OR rp.pharmacy_id<>r.pharmacy_id
                OR pr.purchase_invoice_id<>r.invoice_id
                OR lower(trim(pr.status))<>'completed'
                OR pr.refund_method<>rp.refund_method
                OR typeof(pr.total_amount) NOT IN ('integer','real')
                OR abs(pr.total_amount*100-rp.amount_cents)>0.00001
                OR CAST(pr.user_id AS TEXT)<>rp.actor_id
                OR NOT EXISTS(SELECT 1 FROM main.daily_journals rj
                     WHERE rj.id=rp.journal_id AND rj.pharmacy_id=rp.pharmacy_id
                       AND CAST(rj.created_by AS TEXT)=rp.actor_id
                       AND typeof(rj.total_amount) IN ('integer','real')
                       AND abs(rj.total_amount*100-rp.amount_cents)<0.00001)
                OR (SELECT COUNT(*) FROM main.journal_entries rje
                    WHERE rje.journal_id=rp.journal_id)<>2
                OR (SELECT COUNT(*) FROM main.journal_entries rje
                    JOIN main.accounts a ON a.id=rje.account_id
                    WHERE rje.journal_id=rp.journal_id AND rje.type='debit'
                    AND a.code=CASE WHEN rp.refund_method='credit' THEN '2.1' ELSE '1.1.1' END
                    AND COALESCE(a.is_group,0)=0 AND typeof(rje.amount) IN ('real','integer')
                    AND abs(rje.amount*100-rp.amount_cents)<0.00001)<>1
                OR (SELECT COUNT(*) FROM main.journal_entries rje
                    JOIN main.accounts a ON a.id=rje.account_id
                    WHERE rje.journal_id=rp.journal_id AND rje.type='credit'
                    AND a.code='1.1.3' AND COALESCE(a.is_group,0)=0
                    AND typeof(rje.amount) IN ('real','integer')
                    AND abs(rje.amount*100-rp.amount_cents)<0.00001)<>1
                OR (SELECT COUNT(*) FROM main.supplier_transactions st2
                    WHERE st2.reference_id=rp.return_id AND st2.type='return'
                      AND st2.supplier_id=rp.supplier_id AND typeof(st2.amount) IN ('real','integer')
                      AND abs(st2.amount*100-rp.amount_cents)<0.00001)<>1
                OR (rp.refund_method='cash' AND
                    ((SELECT COUNT(*) FROM main.supplier_transactions st2
                      WHERE st2.reference_id=rp.return_id AND st2.type='payment'
                       AND st2.supplier_id=rp.supplier_id AND typeof(st2.amount) IN ('real','integer')
                       AND abs(st2.amount*100+rp.amount_cents)<0.00001)<>1
                     OR (SELECT COUNT(*) FROM main.cash_movements cm
                       JOIN main.shifts sh
                         ON CAST(sh.id AS TEXT)=CAST(cm.shift_id AS TEXT)
                       WHERE cm.source_type='purchase_return' AND cm.target_name=rp.return_id
                         AND cm.type='receipt' AND cm.category='purchase_return'
                         AND CAST(cm.user_id AS TEXT)=rp.actor_id
                         AND cm.pharmacy_id=rp.pharmacy_id AND sh.pharmacy_id=rp.pharmacy_id
                         AND typeof(cm.amount) IN ('real','integer')
                         AND abs(cm.amount*100-rp.amount_cents)<0.00001)<>1))
                OR (rp.refund_method='credit' AND EXISTS(
                    SELECT 1 FROM main.cash_movements cm
                    WHERE cm.source_type='purchase_return' AND cm.target_name=rp.return_id))
              ))
            AND NOT EXISTS(SELECT 1 FROM main.native_supplier_payment_receipts other
              WHERE other.supplier_id=r.supplier_id
                AND (other.invoice_id<>r.invoice_id OR other.pharmacy_id<>r.pharmacy_id))
            AND (SELECT COUNT(*) FROM main.supplier_transactions sx
                 WHERE sx.supplier_id=r.supplier_id)=1+
                (SELECT COUNT(*) FROM main.native_supplier_payment_receipts sr
                 WHERE sr.supplier_id=r.supplier_id)+
                (SELECT COALESCE(SUM(CASE WHEN pr.refund_method='cash' THEN 2 ELSE 1 END),0)
                 FROM main.native_purchase_return_provenance pr
                 WHERE pr.supplier_id=r.supplier_id AND pr.purchase_invoice_id=r.invoice_id
                   AND pr.pharmacy_id=r.pharmacy_id)
            AND j.pharmacy_id=r.pharmacy_id AND CAST(j.created_by AS TEXT)=r.actor_id
            AND j.date=r.payment_date AND typeof(j.total_amount) IN ('real','integer')
            AND abs(j.total_amount*100-r.amount_cents)<0.00001
            AND (SELECT COUNT(*) FROM main.journal_entries je
                 WHERE je.journal_id=j.id)=2
            AND (SELECT COUNT(*) FROM main.journal_entries je
                 JOIN main.accounts a ON a.id=je.account_id
                 WHERE je.journal_id=j.id AND je.type='debit' AND a.code='2.1'
                   AND COALESCE(a.is_group,0)=0 AND typeof(je.amount) IN ('real','integer')
                   AND abs(je.amount*100-r.amount_cents)<0.00001)=1
            AND (SELECT COUNT(*) FROM main.journal_entries je
                 JOIN main.accounts a ON a.id=je.account_id
                 WHERE je.journal_id=j.id AND je.type='credit'
                   AND a.code=CASE WHEN r.payment_method='cash' THEN '1.1.1' ELSE '1.1.4' END
                   AND COALESCE(a.is_group,0)=0 AND typeof(je.amount) IN ('real','integer')
                   AND abs(je.amount*100-r.amount_cents)<0.00001)=1
            AND ((r.payment_method='bank' AND r.cash_movement_id IS NULL
                    AND NOT EXISTS(SELECT 1 FROM main.cash_movements cm
                     WHERE cm.source_type='supplier_payment' AND cm.target_name=r.id))
              OR (r.payment_method='cash' AND EXISTS(
                    SELECT 1 FROM main.cash_movements cm
                    JOIN main.shifts sh ON CAST(sh.id AS TEXT)=CAST(cm.shift_id AS TEXT)
                    WHERE cm.id=r.cash_movement_id AND cm.target_name=r.id
                     AND cm.source_type='supplier_payment' AND cm.type='disbursement'
                     AND cm.category='accounts_payable' AND cm.pharmacy_id=r.pharmacy_id
                     AND sh.pharmacy_id=r.pharmacy_id
                     AND CAST(cm.user_id AS TEXT)=r.actor_id
                     AND cm.date=r.payment_date AND typeof(cm.amount) IN ('real','integer')
                     AND abs(cm.amount*100-r.amount_cents)<0.00001)
                  AND (SELECT COUNT(*) FROM main.cash_movements cm
                       WHERE cm.source_type='supplier_payment' AND cm.target_name=r.id)=1))
          LIMIT 1
        "#)
        .bind(&input.request_id).bind(input.supplier_id).bind(actor).bind(&pharmacy)
        .bind(amount_cents).bind(&input.payment_method).bind(&input.date)
        .fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
        let Some(row) = match_row else {return Ok(None)};
        let ledger_notes: Option<String> = row.try_get("ledger_notes").map_err(|e|e.to_string())?;
        if note_digest(ledger_notes.as_deref())!=input.notes_sha256 {return Ok(None)};
        Ok(Some(SupplierPaymentConfirmation {
            id: row.try_get("id").map_err(|e|e.to_string())?,
            supplier_id: input.supplier_id,
            invoice_id: row.try_get("invoice_id").map_err(|e|e.to_string())?,
            actor_id: actor.to_owned(), pharmacy_id: pharmacy,
            amount_cents,
            remaining_balance: row.try_get::<i64,_>("balance_after_cents")
                .map_err(|e|e.to_string())? as f64 / 100.0,
        }))
    }.await;
    // Ending a read snapshot can never post a supplier ledger entry.
    sqlx::query("ROLLBACK").execute(&mut *conn).await.map_err(|e|e.to_string())?;
    result
}

#[tauri::command]
pub async fn confirm_supplier_payment_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: ConfirmSupplierPaymentInput,
) -> Result<Option<SupplierPaymentConfirmation>, String> {
    let actor = session.authorize_session().await?;
    let pool = app.try_state::<GuardedReadPool>()
        .ok_or("Database is not initialized")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    confirm_payment_without_posting(
        &mut conn, actor.as_deref().ok_or("Login required")?, payload,
    ).await
}

// Exercise the real locked native settlement against the same disposable SQLx
// connection as a purchase/receiving/returns regression. This is not IPC and
// is never compiled into the shipped binary.
#[cfg(test)]
pub(crate) async fn post_on_isolated_test_connection(
    connection: &mut SqliteConnection,
    actor_id: &str,
    payload: SupplierPaymentInput,
) -> Result<SupplierPaymentPosted, String> {
    pay_with_lock(connection, actor_id, payload).await
}

// Test-only read-back uses the production recovery predicate, never a
// surrogate receipt lookup or a GUI profile.
#[cfg(test)]
pub(super) async fn confirm_on_isolated_test_connection(
    connection: &mut SqliteConnection,
    actor_id: &str,
    payload: ConfirmSupplierPaymentInput,
) -> Result<Option<SupplierPaymentConfirmation>, String> {
    confirm_payment_without_posting(connection, actor_id, payload).await
}

#[tauri::command]
pub async fn post_supplier_payment_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: SupplierPaymentInput,
) -> Result<SupplierPaymentPosted, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database is not initialized")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    pay_with_lock(
        &mut conn,
        actor.as_deref().ok_or("Login required")?,
        payload,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    fn payment(request: &str, method: &str, amount: f64) -> SupplierPaymentInput {
        SupplierPaymentInput {
            supplier_id: 7,
            amount,
            payment_method: method.into(),
            date: "2026-10-14".into(),
            notes: Some("Synthetic partial settlement".into()),
            request_id: request.into(),
        }
    }

    fn confirmation(request: &str, method: &str, amount: f64) -> ConfirmSupplierPaymentInput {
        ConfirmSupplierPaymentInput {
            supplier_id: 7, amount, payment_method: method.into(),
            date: "2026-10-14".into(),
            notes_sha256: note_digest(Some("Synthetic partial settlement")),
            request_id: request.into(),
        }
    }

    async fn fixture() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        db.execute(r#"
          CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,pharmacy_id TEXT,is_active INTEGER,permissions TEXT);
          INSERT INTO users VALUES ('owner-a','owner','a',1,'{}'),
            ('owner-b','owner','b',1,'{}'),('inactive','owner','a',0,'{}');
          CREATE TABLE native_owner_scope_review(owner_id TEXT PRIMARY KEY);
          CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name_ar TEXT,balance REAL);
          INSERT INTO suppliers VALUES(7,'Synthetic supplier',100);
          CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY,supplier_id INTEGER,pharmacy_id TEXT,
            status TEXT,payment_method TEXT,total_amount REAL,user_id TEXT);
          INSERT INTO purchase_invoices VALUES('invoice-1',7,'a','completed','credit',100,'owner-a');
          CREATE TABLE native_purchase_create_requests(invoice_id TEXT PRIMARY KEY,initial_journal_id TEXT,
            pharmacy_id TEXT,supplier_id INTEGER,source_status TEXT,source_total_cents INTEGER,actor_id TEXT);
          INSERT INTO native_purchase_create_requests VALUES('invoice-1','original-journal','a',7,'completed',10000,'owner-a');
          CREATE TABLE native_purchase_posting_events(journal_id TEXT PRIMARY KEY,invoice_id TEXT,
            event_kind TEXT,pharmacy_id TEXT,supplier_id INTEGER,payment_method TEXT,new_total_cents INTEGER,actor_id TEXT);
          INSERT INTO native_purchase_posting_events VALUES('original-journal','invoice-1','initial','a',7,'credit',10000,'owner-a');
          CREATE TABLE purchase_returns(id TEXT PRIMARY KEY,supplier_id INTEGER,
            purchase_invoice_id TEXT,status TEXT,refund_method TEXT,
            total_amount REAL,user_id TEXT);
          -- Existing 041 sidecar is installed in upgraded pharmacy databases.
          -- The focused 054 fixture has no returns but must expose its fixed
          -- schema so read-only confirmation can verify absent future events.
          CREATE TABLE native_purchase_return_provenance(
            return_id TEXT PRIMARY KEY, purchase_invoice_id TEXT,
            pharmacy_id TEXT, actor_id TEXT, supplier_id INTEGER,
            journal_id TEXT, refund_method TEXT, amount_cents INTEGER);
          CREATE TABLE supplier_transactions(id INTEGER PRIMARY KEY AUTOINCREMENT,supplier_id INTEGER,
            user_id TEXT,type TEXT,amount REAL,reference_id TEXT,payment_method TEXT,notes TEXT,date TEXT);
          INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id)
            VALUES(7,'invoice',100,'invoice-1');
          CREATE TABLE shifts(id TEXT PRIMARY KEY,pharmacy_id TEXT,status TEXT);
          INSERT INTO shifts VALUES('shift-a','a','open'),('shift-b','b','open');
          CREATE TABLE cash_movements(id TEXT PRIMARY KEY,user_id TEXT,shift_id TEXT,type TEXT,
            category TEXT,amount REAL,source_type TEXT,target_name TEXT,notes TEXT,date TEXT,pharmacy_id TEXT);
          CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT,is_group INTEGER DEFAULT 0);
          INSERT INTO accounts VALUES(1,'2.1',0),(2,'1.1.1',0),(3,'1.1.4',0);
          CREATE TABLE trial_balance_settings(category TEXT,account_id INTEGER);
          CREATE TABLE daily_journals(id TEXT PRIMARY KEY,date TEXT,description TEXT,
            created_by TEXT,total_amount REAL,pharmacy_id TEXT);
          CREATE TABLE journal_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,journal_id TEXT,
            account_id INTEGER,type TEXT,amount REAL);
          CREATE TABLE activity_log(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT,
            action TEXT,details TEXT,pharmacy_id TEXT);
        "#).await.unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/054_native_supplier_partial_payment.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/057_supplier_cash_shift_identity_guard.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/058_supplier_cash_shift_replace_guard.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/059_supplier_payment_receipt_replace_guard.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        db
    }

    // Upgrade the original lightweight 054 fixture to genuine 042/044 native
    // receipts. The receipt INSERT triggers execute here, rather than putting
    // pre-trusted names in lookalike tables. Entirely in-memory SQLite.
    async fn original_receipted_purchase_fixture() -> SqliteConnection {
        original_receipted_purchase_fixture_with_scope("a").await
    }

    async fn original_receipted_purchase_fixture_with_scope(scope: &str) -> SqliteConnection {
        let mut db = fixture().await;
        if scope != "a" {
            sqlx::query("UPDATE users SET pharmacy_id=? WHERE id='owner-a'")
                .bind(scope).execute(&mut db).await.unwrap();
            sqlx::query("UPDATE purchase_invoices SET pharmacy_id=? WHERE id='invoice-1'")
                .bind(scope).execute(&mut db).await.unwrap();
            sqlx::query("UPDATE shifts SET pharmacy_id=? WHERE id='shift-a'")
                .bind(scope).execute(&mut db).await.unwrap();
        }
        db.execute("DROP TABLE native_purchase_create_requests")
            .await
            .unwrap();
        db.execute("DROP TABLE native_purchase_posting_events")
            .await
            .unwrap();
        db.execute(
            "CREATE TABLE purchase_invoice_items(
                id INTEGER PRIMARY KEY, invoice_id TEXT, quantity REAL,
                cost_price REAL, retail_price REAL
             )",
        )
        .await
        .unwrap();
        // Four units cost 25 each; intentionally unrelated retail reference
        // 190 cannot establish historical acquisition cost.
        db.execute(
            "INSERT INTO purchase_invoice_items VALUES(1,'invoice-1',4,25,190)",
        )
        .await
        .unwrap();
        db.execute("INSERT INTO accounts VALUES(4,'1.1.3',0)")
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
             VALUES('original-journal','2026-10-14','Synthetic purchase','owner-a',100,?)",
        ).bind(scope).execute(&mut db).await.unwrap();
        db.execute(
            "INSERT INTO journal_entries(journal_id,account_id,type,amount)
             VALUES('original-journal',4,'debit',100),
                   ('original-journal',1,'credit',100)",
        )
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/042_purchase_posting_events.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO native_purchase_posting_events
               (event_id,invoice_id,actor_id,pharmacy_id,supplier_id,event_kind,
                journal_id,payment_method,signed_cents,old_total_cents,new_total_cents,line_snapshot)
               VALUES('b08bc3d5-e24f-46ca-a534-71b75df19a51','invoice-1','owner-a',?,7,'initial',
                      'original-journal','credit',10000,0,10000,
                      '[{"sourceLineId":1,"quantity":4,"costPrice":25}]')"#,
        ).bind(scope).execute(&mut db).await.unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/044_purchase_create_request_receipts.sql"
        ))
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO native_purchase_create_requests
             (request_id,invoice_id,actor_id,pharmacy_id,supplier_id,source_status,
              source_total_cents,source_line_count,initial_journal_id)
             VALUES('a753a0be-19bc-428e-915e-0757ec06c6eb','invoice-1','owner-a',?,7,
                    'completed',10000,1,'original-journal')",
        ).bind(scope).execute(&mut db).await.unwrap();
        db
    }

    #[tokio::test]
    async fn local_default_receipted_supplier_payment_must_refuse_before_money_or_ack() {
        // A legacy placeholder can only be promoted through independently
        // authorized primary_pharmacy custody. It is NOT a settlement scope.
        // Before the fix a genuinely 042/044-receipted placeholder purchase
        // could post, whereas confirm_payment_without_posting denied its ACK.
        let mut db = original_receipted_purchase_fixture_with_scope("local_default").await;
        let error = pay_with_lock(
            &mut db,"owner-a",payment("77dd0222-91ec-47f8-8847-00bc11ad3eda","bank",12.50)
        ).await.unwrap_err();
        assert!(error.contains("explicit owned pharmacy"),"unexpected legacy writer gate: {error}");
        for target in ["supplier","cash","receipt","activity"] {
            assert_eq!(count(&mut db,target).await,0,"{target} must remain unchanged");
        }
        assert_eq!(count(&mut db,"journal").await,1);
        assert_eq!(count(&mut db,"entries").await,2);
        let current: f64=sqlx::query_scalar("SELECT balance FROM suppliers WHERE id=7")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(current,100.0);
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(
            "77dd0222-91ec-47f8-8847-00bc11ad3eda","bank",12.50
        )).await.is_err(),"Legacy confirmer must also deny payment");
    }

    #[tokio::test]
    async fn actual_042_044_purchase_actor_lineage_guards_054_payment_and_nonce_rollback() {
        let request = "b639f2b5-027f-48ce-a136-1ef4c82997d8";
        let mut db = original_receipted_purchase_fixture().await;
        // 042/044 immutable receipts were accepted by their real SQL guards.
        let source: (String, String, String, i64) = sqlx::query_as(
            "SELECT c.actor_id,e.actor_id,p.user_id,c.source_total_cents
             FROM native_purchase_create_requests c
             JOIN native_purchase_posting_events e ON e.journal_id=c.initial_journal_id
             JOIN purchase_invoices p ON p.id=c.invoice_id",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(source, ("owner-a".into(), "owner-a".into(), "owner-a".into(), 10000));

        // A purchase's mutable actor was reassigned after its immutable
        // creation/posting. This may not convert a receipted supplier payable
        // into another actor's unverified source for new settlement.
        db.execute("UPDATE purchase_invoices SET user_id='owner-b' WHERE id='invoice-1'")
            .await
            .unwrap();
        let error = pay_with_lock(&mut db, "owner-a", payment(request, "bank", 12.50))
            .await
            .unwrap_err();
        assert!(
            error.contains("unverifiable") || error.contains("lineage"),
            "Unexpected purchase-actor lineage rejection: {error}"
        );
        for table in ["supplier", "cash", "receipt", "activity"] {
            assert_eq!(count(&mut db, table).await, 0, "{table} leaked after denial");
        }
        assert_eq!(count(&mut db, "journal").await, 1); // original 042 only
        assert_eq!(count(&mut db, "entries").await, 2); // original 042 only
        let untouched_balance: f64 =
            sqlx::query_scalar("SELECT balance FROM suppliers WHERE id=7")
                .fetch_one(&mut db).await.unwrap();
        assert_eq!(untouched_balance, 100.0);

        db.execute("UPDATE purchase_invoices SET user_id='owner-a' WHERE id='invoice-1'")
            .await
            .unwrap();
        assert!(pay_with_lock(&mut db, "owner-b", payment(request, "bank", 12.50))
            .await.is_err(), "Foreign pharmacy cannot claim native payment");
        let posted = pay_with_lock(&mut db, "owner-a", payment(request, "bank", 12.50))
            .await.unwrap();
        assert_eq!(posted.remaining_balance, 87.50);
        let again = pay_with_lock(&mut db, "owner-a", payment(request, "bank", 12.50))
            .await.unwrap();
        assert_eq!(again.id, posted.id);
        assert!(pay_with_lock(&mut db, "owner-a", payment(request, "bank", 15.0))
            .await.is_err(), "Same nonce cannot alter supplier payment amount");
        assert_eq!(count(&mut db, "receipt").await, 1);
        assert_eq!(count(&mut db, "supplier").await, 1);
        assert_eq!(count(&mut db, "cash").await, 0);
        assert_eq!(count(&mut db, "journal").await, 2);
        assert_eq!(count(&mut db, "entries").await, 4);
        let receipts: (String, i64, i64, String) = sqlx::query_as(
            "SELECT r.invoice_id,r.balance_before_cents,r.balance_after_cents,r.pharmacy_id
             FROM native_supplier_payment_receipts r WHERE r.request_id=?",
        ).bind(request).fetch_one(&mut db).await.unwrap();
        assert_eq!(receipts, ("invoice-1".into(), 10000, 8750, "a".into()));
        let retail_reference: f64 = sqlx::query_scalar(
            "SELECT retail_price FROM purchase_invoice_items WHERE id=1"
        ).fetch_one(&mut db).await.unwrap();
        assert_eq!(retail_reference, 190.0);
        // Settlement takes original 042/044 received cost (100.00), never
        // derives purchase value from the 190.00 unrelated retail reference.

        // A late 054 receipt insertion failure occurs after the native
        // supplier ledger and journal have been inserted. Their rollback
        // must preserve the genuine 042/044 purchase source and balance.
        let mut failed = original_receipted_purchase_fixture().await;
        failed.execute(
            "CREATE TRIGGER qa_block_054_receipt
             BEFORE INSERT ON native_supplier_payment_receipts
             BEGIN SELECT RAISE(ABORT,'Synthetic 054 receipt denial'); END",
        ).await.unwrap();
        assert!(pay_with_lock(&mut failed, "owner-a", payment(request, "bank", 12.50))
            .await.is_err());
        for table in ["supplier", "cash", "receipt", "activity"] {
            assert_eq!(count(&mut failed, table).await, 0, "{table} survived rollback");
        }
        assert_eq!(count(&mut failed, "journal").await, 1);
        assert_eq!(count(&mut failed, "entries").await, 2);
        let balance: f64 = sqlx::query_scalar("SELECT balance FROM suppliers WHERE id=7")
            .fetch_one(&mut failed).await.unwrap();
        assert_eq!(balance, 100.0);
        let original_receipts: (i64, i64) = sqlx::query_as(
            "SELECT (SELECT COUNT(*) FROM native_purchase_posting_events),
                    (SELECT COUNT(*) FROM native_purchase_create_requests)",
        ).fetch_one(&mut failed).await.unwrap();
        assert_eq!(original_receipts, (1, 1));
    }

    #[tokio::test]
    async fn original_042_044_054_supplier_payment_confirmation_is_read_only_actor_owned_and_exact() {
        let nonce = "11d8ed28-d9ec-4d4e-9172-81d8541aaaf4";
        let mut db = original_receipted_purchase_fixture().await;
        let intent = payment(nonce,"bank",12.50);
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",12.50))
            .await.unwrap().is_none(),"Unposted request must not be confirmed");
        let posted = pay_with_lock(&mut db,"owner-a",intent).await.unwrap();
        let proof = confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",12.50))
            .await.unwrap().expect("Existing original 054 receipt should be independently certifiable");
        assert_eq!(proof.id,posted.id);
        assert_eq!(proof.invoice_id,"invoice-1");
        assert_eq!(proof.actor_id,"owner-a");
        assert_eq!(proof.pharmacy_id,"a");
        assert_eq!(proof.supplier_id,7);
        assert_eq!(proof.amount_cents,1250);
        assert_eq!(proof.remaining_balance,87.50);
        assert!(confirm_payment_without_posting(&mut db,"owner-b",confirmation(nonce,"bank",12.50))
            .await.unwrap().is_none(),"Foreign tenant must never confirm");
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"cash",12.50))
            .await.unwrap().is_none(),"Wrong funding rail is not proof");
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",12.51))
            .await.unwrap().is_none(),"Different amount is not proof");
        let mut wrong_notes=confirmation(nonce,"bank",12.50);
        wrong_notes.notes_sha256=note_digest(Some("Changed after IPC loss"));
        assert!(confirm_payment_without_posting(&mut db,"owner-a",wrong_notes)
            .await.unwrap().is_none(),"Ledger notes are part of exact intent");
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(
            "469d6110-5e3a-4a24-9382-2eaad36f1e52","bank",12.50))
            .await.unwrap().is_none(),"A different nonce must never confirm");
        assert_eq!(count(&mut db,"receipt").await,1);
        assert_eq!(count(&mut db,"supplier").await,1);
        assert_eq!(count(&mut db,"journal").await,2);
        assert_eq!(count(&mut db,"entries").await,4);

        // Receipt immutability does not excuse a later inconsistent mutable
        // balance/extra supplier ledger claim. The postflight must fail closed.
        db.execute("UPDATE suppliers SET balance=50 WHERE id=7").await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",12.50))
            .await.unwrap().is_none());
        db.execute("UPDATE suppliers SET balance=87.5 WHERE id=7").await.unwrap();
        db.execute("INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id)
                    VALUES(7,'payment',5,'unreceipted-side-record')").await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",12.50))
            .await.unwrap().is_none());
    }

    #[tokio::test]
    async fn previously_receipted_supplier_payment_remains_confirmable_after_a_later_sealed_credit_return() {
        let nonce="6f26823c-3cb1-4663-a37f-f90c744548e0";
        let mut db=original_receipted_purchase_fixture().await;
        pay_with_lock(&mut db,"owner-a",payment(nonce,"bank",12.50)).await.unwrap();
        // The true receipted-purchase fixture already has the canonical
        // inventory asset account and the contemporary return columns.
        // Synthetic 041-shaped later return in disposable sqlite::memory:.
        // The REAL 041/048 receipt constraints are independently covered in
        // purchase_return modules and the live immutable QA read-only test.
        sqlx::raw_sql(r#"
          INSERT INTO purchase_returns
           (id,supplier_id,purchase_invoice_id,status,refund_method,total_amount,user_id)
           VALUES('later-credit',7,'invoice-1','completed','credit',20,'owner-a');
          INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
           VALUES('later-return-journal','2026-10-14','Synthetic 041 return','owner-a',20,'a');
          INSERT INTO journal_entries(journal_id,account_id,type,amount)
           VALUES('later-return-journal',1,'debit',20),('later-return-journal',4,'credit',20);
          INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id)
           VALUES(7,'return',20,'later-credit');
          INSERT INTO native_purchase_return_provenance
           (return_id,purchase_invoice_id,pharmacy_id,actor_id,supplier_id,journal_id,refund_method,amount_cents)
           VALUES('later-credit','invoice-1','a','owner-a',7,'later-return-journal','credit',2000);
          UPDATE suppliers SET balance=67.50 WHERE id=7;
        "#).execute(&mut db).await.unwrap();
        let confirmed=confirm_payment_without_posting(
            &mut db,"owner-a",confirmation(nonce,"bank",12.50)).await.unwrap();
        assert!(confirmed.is_some(),"later sealed credit return should not erase original 054 source");
        assert_eq!(confirmed.unwrap().remaining_balance,87.50,
            "original post-payment balance remains an immutable historic snapshot");
        assert_eq!(count(&mut db,"receipt").await,1);
        db.execute("UPDATE suppliers SET balance=85 WHERE id=7").await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",12.50))
            .await.unwrap().is_none(),"tampered current payable must block read-only confirmation");
        db.execute("UPDATE suppliers SET balance=67.50 WHERE id=7").await.unwrap();
        db.execute("INSERT INTO purchase_returns(id,supplier_id,purchase_invoice_id,status,refund_method,total_amount,user_id)
          VALUES('legacy-no-041',7,'invoice-1','completed','credit',5,'owner-a')").await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",12.50))
            .await.unwrap().is_none(),"unreceipted added return must not be counted as verified balance");
    }

    #[tokio::test]
    async fn confirmation_after_041_cash_refund_requires_original_actor_and_owned_shift() {
        let nonce = "75e04b4a-7fd5-4437-ae3d-e6eebf6913d9";
        let mut db = original_receipted_purchase_fixture().await;
        let posted = pay_with_lock(&mut db, "owner-a", payment(nonce, "bank", 12.50))
            .await.unwrap();
        // A cash return is a separate inventory reversal and cash receipt.
        // It leaves the credit supplier balance unchanged, unlike a credit
        // return. These are synthetic post-041/048-shaped entries; the fixture
        // has genuine 042/044 insert-guarded purchase receipts.
        sqlx::raw_sql(r#"
          INSERT INTO purchase_returns
           (id,supplier_id,purchase_invoice_id,status,refund_method,total_amount,user_id)
           VALUES('later-cash',7,'invoice-1','completed','cash',15,'owner-a');
          INSERT INTO daily_journals(id,date,description,created_by,total_amount,pharmacy_id)
           VALUES('later-cash-journal','2026-10-14','Synthetic 041 cash return','owner-a',15,'a');
          INSERT INTO journal_entries(journal_id,account_id,type,amount)
           VALUES('later-cash-journal',2,'debit',15),('later-cash-journal',4,'credit',15);
          INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id)
           VALUES(7,'return',15,'later-cash'),(7,'payment',-15,'later-cash');
          INSERT INTO cash_movements
           (id,user_id,shift_id,type,category,amount,source_type,target_name,pharmacy_id)
           VALUES('later-cash-movement','owner-a','shift-a','receipt','purchase_return',
                  15,'purchase_return','later-cash','a');
          INSERT INTO native_purchase_return_provenance
           (return_id,purchase_invoice_id,pharmacy_id,actor_id,supplier_id,journal_id,refund_method,amount_cents)
           VALUES('later-cash','invoice-1','a','owner-a',7,'later-cash-journal','cash',1500);
        "#).execute(&mut db).await.unwrap();
        let expected = confirmation(nonce, "bank", 12.50);
        let verified = confirm_payment_without_posting(&mut db, "owner-a", expected)
            .await.unwrap().expect("Canonical 041 cash refund must retain earlier 054 proof");
        assert_eq!(verified.id, posted.id);
        assert_eq!(verified.remaining_balance, 87.50);
        assert_eq!(count(&mut db,"receipt").await, 1);
        assert_eq!(count(&mut db,"cash").await, 1);

        // Mimic forensic corruption in disposable memory. 048 prevents these
        // edits on a migrated database, while the reader must also fail closed
        // if the cash source/actor or shift ownership no longer matches.
        db.execute("UPDATE cash_movements SET user_id='owner-b' WHERE id='later-cash-movement'")
            .await.unwrap();
        assert!(confirm_payment_without_posting(&mut db, "owner-a", confirmation(nonce,"bank",12.50))
            .await.unwrap().is_none(),"Foreign cashier cannot certify historical 041 refund");
        db.execute("UPDATE cash_movements SET user_id='owner-a' WHERE id='later-cash-movement'")
            .await.unwrap();
        db.execute("UPDATE shifts SET pharmacy_id='b' WHERE id='shift-a'")
            .await.unwrap();
        assert!(confirm_payment_without_posting(&mut db, "owner-a", confirmation(nonce,"bank",12.50))
            .await.unwrap().is_none(),"Foreign shift owner cannot certify historical 041 cash refund");
        assert_eq!(count(&mut db,"receipt").await,1);
    }

    #[tokio::test]
    async fn confirmation_rechecks_original_invoice_ledger_after_retained_054_receipt() {
        let nonce="9e2d0e60-3480-4c3f-a19a-ab905684be0e";
        let mut db=original_receipted_purchase_fixture().await;
        let posted=pay_with_lock(&mut db,"owner-a",payment(nonce,"bank",17.35))
            .await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",17.35))
            .await.unwrap().is_some());
        // The installed 054 migration forbids all these mutations. Simulate
        // a partially damaged / restored historical ledger in memory only,
        // with the overall row count and native receipt still untouched.
        db.execute("DROP TRIGGER native_supplier_payment_invoice_ledger_no_update")
            .await.unwrap();
        db.execute("UPDATE supplier_transactions SET amount=101
                    WHERE supplier_id=7 AND type='invoice' AND reference_id='invoice-1'")
            .await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",17.35))
            .await.unwrap().is_none(),"Wrong invoice cost must not certify an existing payment");
        db.execute("UPDATE supplier_transactions SET amount=100,reference_id='foreign-invoice'
                    WHERE supplier_id=7 AND type='invoice'")
            .await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",17.35))
            .await.unwrap().is_none(),"An unrelated invoice ledger reference must not certify");
        assert_eq!(count(&mut db,"receipt").await,1);
        assert_eq!(count(&mut db,"supplier").await,1);
        assert_eq!(posted.remaining_balance,82.65);
    }

    #[tokio::test]
    async fn multi_invoice_or_unreceipted_supplier_history_blocks_054_recovery_confirmation() {
        let nonce="18a5d641-fb54-41eb-a353-89ae8573d57f";
        let mut db=original_receipted_purchase_fixture().await;
        pay_with_lock(&mut db,"owner-a",payment(nonce,"bank",10.0))
            .await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",10.0))
            .await.unwrap().is_some());

        // The shared supplier ID must not inherit another tenant's invoice,
        // even if the original 054 receipt remains immutable and cent-exact.
        db.execute(
            "INSERT INTO purchase_invoices
             VALUES('foreign-invoice',7,'b','completed','credit',5,'owner-b')",
        ).await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",10.0))
            .await.unwrap().is_none(),"Second supplier invoice makes ownership ambiguous");
        db.execute("DELETE FROM purchase_invoices WHERE id='foreign-invoice'")
            .await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",10.0))
            .await.unwrap().is_some(),"Removing synthetic extraneous row restores original evidence");

        db.execute("INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id)
                    VALUES(7,'payment',5,'unreceipted-legacy-history')")
            .await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",10.0))
            .await.unwrap().is_none(),"Unknown payment history is not a 054 receipt");
        assert_eq!(count(&mut db,"receipt").await,1);
        assert_eq!(count(&mut db,"supplier").await,2); // Synthetic unreceipted row only
    }

    #[tokio::test]
    async fn native_054_recovery_requires_live_owning_actor_and_unchanged_payment_rail() {
        let nonce="9649161e-d344-4a2c-be62-4598b8a5b017";
        let mut db=original_receipted_purchase_fixture().await;
        pay_with_lock(&mut db,"owner-a",payment(nonce,"cash",17.35))
            .await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"cash",17.35))
            .await.unwrap().is_some(),"Owned cash rail with 054 shift/ledger proof");
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"bank",17.35))
            .await.unwrap().is_none(),"Bank cannot confirm cash receipt");
        assert!(confirm_payment_without_posting(&mut db,"owner-b",confirmation(nonce,"cash",17.35))
            .await.unwrap().is_none(),"Other pharmacy cannot claim cash receipt");

        db.execute("INSERT INTO native_owner_scope_review(owner_id) VALUES('owner-a')")
            .await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"cash",17.35))
            .await.is_err(),"Owner quarantine must deny recovery proof");
        db.execute("DELETE FROM native_owner_scope_review WHERE owner_id='owner-a'")
            .await.unwrap();
        db.execute("UPDATE users SET is_active=0 WHERE id='owner-a'")
            .await.unwrap();
        assert!(confirm_payment_without_posting(&mut db,"owner-a",confirmation(nonce,"cash",17.35))
            .await.is_err(),"Inactive owner cannot certify old payment");
        assert_eq!(count(&mut db,"receipt").await,1);
    }

    async fn count(db: &mut SqliteConnection, table: &str) -> i64 {
        let sql = match table {
            "supplier" => "SELECT count(*) FROM supplier_transactions WHERE type='payment'",
            "cash" => "SELECT count(*) FROM cash_movements",
            "journal" => "SELECT count(*) FROM daily_journals",
            "entries" => "SELECT count(*) FROM journal_entries",
            "receipt" => "SELECT count(*) FROM native_supplier_payment_receipts",
            "activity" => "SELECT count(*) FROM activity_log",
            _ => panic!("Unknown synthetic table"),
        };
        sqlx::query_scalar(sql).fetch_one(&mut *db).await.unwrap()
    }

    #[tokio::test]
    async fn receipted_cash_then_bank_partial_payment_and_replay_are_canonical() {
        let mut db = fixture().await;
        let nonce = "ae4b5ce9-a8df-46f3-bb9d-5d4d67c80615";
        let first = pay_with_lock(&mut db, "owner-a", payment(nonce, "cash", 35.75))
            .await
            .unwrap();
        assert_eq!(first.remaining_balance, 64.25);
        assert_eq!(count(&mut db, "receipt").await, 1);
        assert_eq!(count(&mut db, "cash").await, 1);
        assert_eq!(count(&mut db, "entries").await, 2);
        let cash: f64 = sqlx::query_scalar("SELECT amount FROM cash_movements WHERE target_name=?")
            .bind(&first.id)
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(cash, 35.75);
        let intact = sqlx::query(
            super::super::financial_source_reconciliation_native::NATIVE_SUPPLIER_PAYMENT_FINANCIAL,
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert!(
            intact.is_empty(),
            "Native supplier payment must reconcile all recorded legs"
        );
        let again = pay_with_lock(&mut db, "owner-a", payment(nonce, "cash", 35.75))
            .await
            .unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(count(&mut db, "receipt").await, 1);
        assert!(
            pay_with_lock(&mut db, "owner-a", payment(nonce, "cash", 40.0))
                .await
                .is_err()
        );
        let second = pay_with_lock(
            &mut db,
            "owner-a",
            payment("c7187644-557e-4789-b054-19c543831274", "bank", 14.25),
        )
        .await
        .unwrap();
        assert_eq!(second.remaining_balance, 50.0);
        assert_eq!(count(&mut db, "cash").await, 1);
        assert_eq!(count(&mut db, "journal").await, 2);
        assert_eq!(count(&mut db, "supplier").await, 2);
        let payable: f64 = sqlx::query_scalar("SELECT balance FROM suppliers WHERE id=7")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(payable, 50.0);
        for statement in [
            format!("DELETE FROM cash_movements WHERE target_name='{}'",first.id),
            format!("UPDATE supplier_transactions SET amount=999 WHERE reference_id='supplier-payment:{}'",first.id),
            format!("DELETE FROM native_supplier_payment_receipts WHERE id='{}'",first.id),
            format!("INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id) VALUES(7,'payment',35.75,'supplier-payment:{}')",first.id),
        ] { assert!(sqlx::query(&statement).execute(&mut db).await.is_err(),"{statement}"); }
        // Forensic test models external database damage after disabling only
        // the synthetic cash deletion guard, never a production DB.
        db.execute("DROP TRIGGER native_supplier_payment_cash_no_update")
            .await
            .unwrap();
        sqlx::query("UPDATE cash_movements SET amount=99 WHERE target_name=?")
            .bind(&first.id)
            .execute(&mut db)
            .await
            .unwrap();
        let damaged = sqlx::query(
            super::super::financial_source_reconciliation_native::NATIVE_SUPPLIER_PAYMENT_FINANCIAL,
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(damaged.len(), 1);
        assert_eq!(
            damaged[0].get::<String, _>("issue_code"),
            "supplier_payment_receipt_cash_conflict"
        );
    }

    #[tokio::test]
    async fn supplier_payment_nonce_cannot_acknowledge_a_different_immutable_audit_note() {
        let mut db = fixture().await;
        let request_id = Uuid::new_v4().to_string();
        let mut original = payment(&request_id, "cash", 25.0);
        original.notes = Some("Signed supplier cash handoff".into());
        let posted = pay_with_lock(&mut db, "owner-a", original).await.unwrap();
        assert_eq!(posted.remaining_balance, 75.0);

        // Replaying a real payment nonce must not acknowledge contradictory
        // immutable ledger metadata as though that new intent had posted.
        let mut changed = payment(&request_id, "cash", 25.0);
        changed.notes = Some("Payment for a different invoice".into());
        let denied = pay_with_lock(&mut db, "owner-a", changed).await.unwrap_err();
        assert_eq!(denied, "Supplier payment request ID already belongs to another intent");

        let supplier_note: Option<String> = sqlx::query_scalar(
            "SELECT st.notes FROM supplier_transactions st
             JOIN native_supplier_payment_receipts r ON r.supplier_transaction_id=st.id
             WHERE r.request_id=?",
        )
        .bind(&request_id)
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(supplier_note.as_deref(), Some("Signed supplier cash handoff"));
        assert_eq!(count(&mut db, "supplier").await, 1);
        assert_eq!(count(&mut db, "receipt").await, 1);
        assert_eq!(count(&mut db, "journal").await, 1);
        assert_eq!(count(&mut db, "cash").await, 1);
        let supplier_balance: f64 = sqlx::query_scalar("SELECT balance FROM suppliers WHERE id=7")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(supplier_balance, 75.0);

        let mut matching = payment(&request_id, "cash", 25.0);
        matching.notes = Some("Signed supplier cash handoff".into());
        let retry = pay_with_lock(&mut db, "owner-a", matching).await.unwrap();
        assert_eq!(retry.id, posted.id);
        assert_eq!(retry.remaining_balance, 75.0);
        assert_eq!(count(&mut db, "receipt").await, 1);
        assert_eq!(count(&mut db, "entries").await, 2);
    }

    #[tokio::test]
    async fn unauthorized_ambiguous_or_invalid_supplier_money_never_writes() {
        let mut db = fixture().await;
        let nonce = "ae4b5ce9-a8df-46f3-bb9d-5d4d67c80615";
        assert!(
            pay_with_lock(&mut db, "owner-b", payment(nonce, "cash", 15.0))
                .await
                .is_err()
        );
        assert!(
            pay_with_lock(&mut db, "inactive", payment(nonce, "cash", 15.0))
                .await
                .is_err()
        );
        assert!(
            pay_with_lock(&mut db, "owner-a", payment(nonce, "check", 15.0))
                .await
                .is_err()
        );
        assert!(
            pay_with_lock(&mut db, "owner-a", payment(nonce, "cash", 15.001))
                .await
                .is_err()
        );
        assert!(
            pay_with_lock(&mut db, "owner-a", payment(nonce, "cash", 101.0))
                .await
                .is_err()
        );
        db.execute("INSERT INTO trial_balance_settings VALUES('accounts_payable',3)")
            .await.unwrap();
        assert!(pay_with_lock(&mut db,"owner-a",payment(nonce,"cash",15.0)).await.is_err());
        db.execute("DELETE FROM trial_balance_settings").await.unwrap();
        sqlx::query(
            "INSERT INTO purchase_invoices VALUES('foreign-invoice',7,'b','completed','credit',5,'owner-b')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        assert!(
            pay_with_lock(&mut db, "owner-a", payment(nonce, "cash", 15.0))
                .await
                .is_err()
        );
        sqlx::query("DELETE FROM purchase_invoices WHERE id='foreign-invoice'")
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id) VALUES(7,'payment',2,'old-unknown')")
            .execute(&mut db).await.unwrap();
        assert!(
            pay_with_lock(&mut db, "owner-a", payment(nonce, "cash", 15.0))
                .await
                .is_err()
        );
        assert_eq!(count(&mut db, "receipt").await, 0);
        assert_eq!(count(&mut db, "cash").await, 0);
        assert_eq!(count(&mut db, "journal").await, 0);
        assert_eq!(count(&mut db, "supplier").await, 1); // legacy synthetic precondition only
    }

    #[tokio::test]
    async fn journal_or_receipt_failure_rolls_back_supplier_shift_and_balance() {
        let mut db = fixture().await;
        db.execute("CREATE TRIGGER block_supplier_receipt BEFORE INSERT ON native_supplier_payment_receipts BEGIN SELECT RAISE(ABORT,'synthetic refused receipt'); END")
            .await.unwrap();
        assert!(pay_with_lock(
            &mut db,
            "owner-a",
            payment("ae4b5ce9-a8df-46f3-bb9d-5d4d67c80615", "cash", 12.50)
        )
        .await
        .is_err());
        for table in [
            "supplier", "cash", "journal", "entries", "receipt", "activity",
        ] {
            assert_eq!(count(&mut db, table).await, 0, "{table} did not roll back");
        }
        let balance: f64 = sqlx::query_scalar("SELECT balance FROM suppliers WHERE id=7")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(balance, 100.0);
    }

    #[tokio::test]
    async fn receipted_supplier_cash_seals_shift_identity_after_closure() {
        let mut db = fixture().await;
        let posted = pay_with_lock(
            &mut db,
            "owner-a",
            payment("89c4f931-4d5b-4f9e-9fb9-e54e8f36de12", "cash", 20.0),
        )
        .await
        .unwrap();
        db.execute("UPDATE shifts SET status='closed' WHERE id='shift-a'")
            .await
            .unwrap();
        for statement in [
            "UPDATE shifts SET pharmacy_id='b' WHERE id='shift-a'",
            "UPDATE shifts SET id='foreign-shift' WHERE id='shift-a'",
            "DELETE FROM shifts WHERE id='shift-a'",
        ] {
            assert!(
                db.execute(statement).await.is_err(),
                "Immutable 054 cash receipt allowed shift identity damage: {statement}"
            );
        }
        let shift: (String, String) =
            sqlx::query_as("SELECT pharmacy_id,status FROM shifts WHERE id='shift-a'")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(shift, ("a".into(), "closed".into()));
        assert_eq!(count(&mut db, "receipt").await, 1);
        assert_eq!(count(&mut db, "cash").await, 1);
        assert_eq!(posted.remaining_balance, 80.0);
    }

    #[tokio::test]
    async fn supplier_cash_shift_cannot_be_replaced_when_sqlite_recursive_triggers_are_off() {
        let mut db = fixture().await;
        pay_with_lock(
            &mut db,
            "owner-a",
            payment("e2d5e4d1-2916-4592-b275-8e7c56a739f2", "cash", 20.0),
        )
        .await
        .unwrap();
        db.execute("UPDATE shifts SET status='closed' WHERE id='shift-a'")
            .await
            .unwrap();
        db.execute("PRAGMA recursive_triggers=OFF").await.unwrap();
        assert!(
            db.execute("INSERT OR REPLACE INTO shifts (id,pharmacy_id,status) VALUES ('shift-a','b','closed')")
                .await
                .is_err(),
            "INSERT OR REPLACE bypassed sealed 054 source-linked shift identity"
        );
        let owner: String = sqlx::query_scalar("SELECT pharmacy_id FROM shifts WHERE id='shift-a'")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(owner, "a");
        assert_eq!(count(&mut db, "receipt").await, 1);
    }

    #[tokio::test]
    async fn supplier_bank_receipt_cannot_be_replaced_after_unreceipted_ledger_noise() {
        let mut db = fixture().await;
        let posted = pay_with_lock(
            &mut db,
            "owner-a",
            payment("22a4d08c-4a37-4650-9a34-4431e011065e", "bank", 20.0),
        )
        .await
        .unwrap();
        db.execute("PRAGMA recursive_triggers=OFF").await.unwrap();
        // This deliberately untrusted row is created ONLY on a disposable
        // in-memory fixture. It exposes the 054 INSERT guard's prior-count
        // assumption and must not permit REPLACE to bypass immutability.
        db.execute(
            "INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id)
             VALUES(7,'misc',0,'unreceipted-qa-noise')",
        )
        .await
        .unwrap();
        assert!(
            sqlx::query(
                "INSERT OR REPLACE INTO native_supplier_payment_receipts
                 (id,request_id,supplier_id,invoice_id,supplier_transaction_id,
                  pharmacy_id,actor_id,amount_cents,payment_method,payment_date,
                  journal_id,cash_movement_id,balance_before_cents,balance_after_cents,recorded_at)
                 SELECT id,request_id,supplier_id,invoice_id,supplier_transaction_id,
                        pharmacy_id,actor_id,amount_cents,payment_method,payment_date,
                        journal_id,cash_movement_id,8000,6000,recorded_at
                 FROM native_supplier_payment_receipts WHERE id=?",
            )
            .bind(&posted.id)
            .execute(&mut db)
            .await
            .is_err(),
            "054 bank receipt allowed INSERT OR REPLACE to rewrite immutable balance history"
        );
        let balances: (i64, i64) = sqlx::query_as(
            "SELECT balance_before_cents,balance_after_cents
             FROM native_supplier_payment_receipts WHERE id=?",
        )
        .bind(&posted.id)
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(balances, (10000, 8000));
        assert_eq!(count(&mut db, "receipt").await, 1);
    }
}
