//! Strict read-only resolution of one ambiguous native 043 sales return.
//!
//! This module is intentionally unregistered. Registration in commands/mod.rs
//! and main.rs requires a separate reviewed change. No posting or fallback
//! generic SQL read is permitted. A null result NEVER authorizes resubmission.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use std::borrow::Cow;
use tauri::{Manager, State};
use uuid::Uuid;

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SalesReturnConfirmationInput {
    request_id: String,
    invoice_id: String,
    refund_method: String,
    amount_cents: i64,
    line_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SalesReturnConfirmation {
    id: String,
    request_id: String,
    invoice_id: String,
    actor_id: String,
    pharmacy_id: String,
    refund_method: String,
    amount_cents: i64,
    line_sha256: String,
}

fn valid_input(input: &SalesReturnConfirmationInput) -> Result<(), String> {
    let nonce = Uuid::parse_str(&input.request_id)
        .map_err(|_| "Invalid original 043 sales return UUIDv4")?;
    if nonce.get_version_num() != 4 || nonce.to_string() != input.request_id
        || input.invoice_id.is_empty() || input.invoice_id.trim() != input.invoice_id
        || input.invoice_id.len() > 256
        || !matches!(input.refund_method.as_str(), "cash" | "bank" | "wallet" | "patient_account")
        || !(0..=100_000_000_000_000).contains(&input.amount_cents)
        || input.line_sha256.len() != 64
        || !input.line_sha256.bytes().all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase())
    {
        return Err("Invalid original sales return receipt confirmation payload".into());
    }
    Ok(())
}

fn line_digest(lines: &[(i64, String, i64, String)]) -> String {
    let bytes = serde_json::to_vec(lines).expect("validated bounded line tuple serialization");
    let hash = Sha256::digest(bytes);
    hash.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn confirm(
    conn: &mut SqliteConnection,
    actor: &str,
    input: SalesReturnConfirmationInput,
) -> Result<Option<SalesReturnConfirmation>, String> {
    valid_input(&input)?;
    reset_cancelled_read_state(conn).await?;
    let mut tx: Transaction<'_, Sqlite> =
        Transaction::begin(conn, Some(Cow::Borrowed("BEGIN")))
            .await.map_err(|error| error.to_string())?;
    let checked = async {
        let conn = &mut *tx;
        let (role, pharmacy) = active_generic_actor(conn, actor).await?;
        if pharmacy == "local_default" || pharmacy.trim().is_empty() {
            return Err("Sales return confirmation requires verified native tenant".into());
        }
        let permissions: Option<String> = sqlx::query_scalar(
            "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=?
               AND COALESCE(is_active,1)=1",
        ).bind(actor).fetch_one(&mut *conn).await.map_err(|error| error.to_string())?;
        if !user_has_permission(Some(&role), permissions.as_deref(), "can_view_returns", false) {
            return Err("Unauthorized native sales return receipt confirmation".into());
        }
        let original: Option<(String, i64)> = sqlx::query_as(
            "SELECT r.id,p.cogs_micros
             FROM main.native_sale_return_cogs_provenance p
             JOIN main.returns r ON r.id=p.return_id
             JOIN main.sales_invoices sale ON sale.id=r.invoice_id
             JOIN main.native_sale_cogs_provenance original ON original.sale_id=sale.id
             JOIN main.daily_journals j ON j.id=p.journal_id
             WHERE p.request_id=? AND r.invoice_id=? AND p.sale_id=?
               AND p.actor_id=? AND p.pharmacy_id=?
               AND r.pharmacy_id=p.pharmacy_id
               AND sale.pharmacy_id=p.pharmacy_id AND original.pharmacy_id=p.pharmacy_id
               AND original.actor_id=CAST(sale.user_id AS TEXT)
               AND p.actor_id=CAST(r.user_id AS TEXT)
               AND lower(trim(r.status)) IN ('approved','completed')
               AND p.refund_method=? AND r.refund_method=p.refund_method
               AND p.refund_micros=?*10000
               AND typeof(r.total_refund) IN ('integer','real')
               AND abs(r.total_refund*1000000-p.refund_micros)<2
               AND p.cogs_micros>=0 AND p.line_count>0 AND p.line_count<=200
               AND json_valid(p.line_snapshot) AND json_type(p.line_snapshot)='array'
               AND json_array_length(p.line_snapshot)=p.line_count
               AND p.line_count=(SELECT COUNT(*) FROM main.return_items WHERE return_id=r.id)
               AND j.pharmacy_id=p.pharmacy_id
               AND CAST(j.created_by AS TEXT)=p.actor_id
               AND typeof(j.total_amount) IN ('real','integer')
               AND abs(j.total_amount*1000000-(p.refund_micros+p.cogs_micros))<2
               AND (SELECT COUNT(*) FROM main.journal_entries je WHERE je.journal_id=j.id)
                   =CASE WHEN p.cogs_micros>0 THEN 4 ELSE 2 END
               AND (SELECT COUNT(*) FROM main.journal_entries je
                    JOIN main.accounts a ON a.id=je.account_id
                    WHERE je.journal_id=j.id AND a.code='3.1' AND COALESCE(a.is_group,0)=0
                      AND je.type='debit' AND abs(je.amount*1000000-p.refund_micros)<2)=1
               AND (SELECT COUNT(*) FROM main.journal_entries je
                    JOIN main.accounts a ON a.id=je.account_id
                    WHERE je.journal_id=j.id AND a.code=
                      CASE p.refund_method
                        WHEN 'cash' THEN '1.1.1' WHEN 'bank' THEN '1.1.4'
                        WHEN 'wallet' THEN '2.2' ELSE '1.1.2' END
                      AND COALESCE(a.is_group,0)=0 AND je.type='credit'
                      AND abs(je.amount*1000000-p.refund_micros)<2)=1
               AND (SELECT COUNT(*) FROM main.journal_entries je
                    JOIN main.accounts a ON a.id=je.account_id
                    WHERE je.journal_id=j.id AND a.code='1.1.3' AND COALESCE(a.is_group,0)=0
                      AND je.type='debit' AND abs(je.amount*1000000-p.cogs_micros)<2)
                   =CASE WHEN p.cogs_micros>0 THEN 1 ELSE 0 END
               AND (SELECT COUNT(*) FROM main.journal_entries je
                    JOIN main.accounts a ON a.id=je.account_id
                    WHERE je.journal_id=j.id AND a.code='4.1' AND COALESCE(a.is_group,0)=0
                      AND je.type='credit' AND abs(je.amount*1000000-p.cogs_micros)<2)
                   =CASE WHEN p.cogs_micros>0 THEN 1 ELSE 0 END
             LIMIT 1",
        )
        .bind(&input.request_id).bind(&input.invoice_id).bind(&input.invoice_id)
        .bind(actor).bind(&pharmacy).bind(&input.refund_method).bind(input.amount_cents)
        .fetch_optional(&mut *conn).await.map_err(|error| error.to_string())?;
        let Some((return_id, _cogs_micros)) = original else { return Ok(None) };

        // Independent read of the actual 043 source lines; never trust lines
        // supplied after reload and never reconstruct them from the renderer's
        // current form. Missing, foreign, changed or duplicate lines fail.
        let rows = sqlx::query(
            "SELECT ri.id,ri.sale_item_id,ri.inventory_id,ri.quantity_returned,ri.unit
             FROM main.return_items ri
             JOIN main.sales_items sold ON sold.id=ri.sale_item_id
               AND sold.invoice_id=?
             JOIN main.inventory lot ON lot.id=ri.inventory_id
               AND lot.pharmacy_id=? AND lot.drug_id=sold.drug_id
             WHERE ri.return_id=? ORDER BY ri.sale_item_id",
        ).bind(&input.invoice_id).bind(&pharmacy).bind(&return_id)
        .fetch_all(&mut *conn).await.map_err(|error| error.to_string())?;
        if rows.is_empty() || rows.len() > 200 { return Ok(None); }
        let mut tuples = Vec::with_capacity(rows.len());
        let mut previous = 0_i64;
        for row in rows {
            let line_id: i64 = row.try_get("id").map_err(|e|e.to_string())?;
            let sale_line: i64 = row.try_get("sale_item_id").map_err(|e|e.to_string())?;
            let lot: String = row.try_get("inventory_id").map_err(|e|e.to_string())?;
            let quantity: f64 = row.try_get("quantity_returned").map_err(|e|e.to_string())?;
            let unit: String = row.try_get("unit").map_err(|e|e.to_string())?;
            let scaled = quantity * 1_000_000.0;
            if line_id<=0 || sale_line<=previous || lot.is_empty()
                || !quantity.is_finite() || scaled<=0.0
                || scaled > i64::MAX as f64 || (scaled-scaled.round()).abs()>0.000001
                || !matches!(unit.as_str(),"large"|"medium"|"small") {
                return Ok(None);
            }
            // Read the original immutable 043 snapshot line: a changed source
            // identity or lot must not produce a matching confirmation.
            let witness: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM main.native_sale_return_cogs_provenance p
                 JOIN json_each(p.line_snapshot) snap
                 WHERE p.return_id=? AND json_extract(snap.value,'$.lineId')=?
                   AND json_extract(snap.value,'$.originalSaleItemId')=?
                   AND json_extract(snap.value,'$.originalSaleId')=?
                   AND json_extract(snap.value,'$.inventoryId')=?
                   AND abs(json_extract(snap.value,'$.quantity')-?)<0.000001
                   AND json_extract(snap.value,'$.unit')=?",
            ).bind(&return_id).bind(line_id).bind(sale_line).bind(&input.invoice_id)
             .bind(&lot).bind(quantity).bind(&unit)
             .fetch_one(&mut *conn).await.map_err(|error| error.to_string())?;
            if witness != 1 { return Ok(None); }
            previous = sale_line;
            tuples.push((sale_line,lot,scaled.round() as i64,unit));
        }
        let digest = line_digest(&tuples);
        if digest != input.line_sha256 { return Ok(None); }
        Ok(Some(SalesReturnConfirmation {
            id:return_id, request_id:input.request_id, invoice_id:input.invoice_id,
            actor_id:actor.to_string(), pharmacy_id:pharmacy,
            refund_method:input.refund_method, amount_cents:input.amount_cents,
            line_sha256:digest,
        }))
    }.await;
    // Rollback a read transaction explicitly. Confirmation never writes.
    tx.rollback().await.map_err(|error|error.to_string())?;
    checked
}

#[tauri::command]
pub async fn confirm_sales_return_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    payload: SalesReturnConfirmationInput,
) -> Result<Option<SalesReturnConfirmation>, String> {
    let actor = session.authorize_session().await?;
    let actor = actor.as_deref().ok_or("Native session required for return confirmation")?;
    let pool = app.try_state::<GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    let mut conn=pool.0.acquire().await.map_err(|error|error.to_string())?;
    confirm(&mut conn,actor,payload).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_line_hash_matches_browser_canonical_tuple_serialization() {
        let lines=vec![(31_i64,"lot-a".to_string(),1_000_000_i64,"large".to_string())];
        let expected=Sha256::digest(br#"[[31,"lot-a",1000000,"large"]]"#);
        assert_eq!(line_digest(&lines),expected.iter().map(|b|format!("{b:02x}")).collect::<String>());
        let changed=vec![(31_i64,"lot-b".to_string(),1_000_000_i64,"large".to_string())];
        assert_ne!(line_digest(&lines),line_digest(&changed));
    }
    #[test]
    fn rejects_noncanonical_nonce_rail_amount_and_digest() {
        let good=SalesReturnConfirmationInput {
            request_id:"9ef93271-6f48-4cfa-807a-d2041e5805dd".into(),
            invoice_id:"sale-a".into(),refund_method:"cash".into(),
            amount_cents:1500,line_sha256:"a".repeat(64),
        };
        assert!(valid_input(&good).is_ok());
        assert!(valid_input(&SalesReturnConfirmationInput{refund_method:"credit".into(),..good.clone()}).is_err());
        assert!(valid_input(&SalesReturnConfirmationInput{amount_cents:-1,..good.clone()}).is_err());
        assert!(valid_input(&SalesReturnConfirmationInput{line_sha256:"INVALID".into(),..good.clone()}).is_err());
        assert!(valid_input(&SalesReturnConfirmationInput{request_id:"9EF93271-6F48-4CFA-807A-D2041E5805DD".into(),..good}).is_err());
    }
}
