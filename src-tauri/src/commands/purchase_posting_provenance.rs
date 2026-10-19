//! Forward-only purchase lifecycle journal receipts. Only trusted native
//! callers inside their existing BEGIN IMMEDIATE transaction may invoke this.
//! Native event rows survive legitimate later invoice-line replacement.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, Sqlite, SqliteConnection, Transaction};
use uuid::Uuid;

use super::purchase_dto::NativePurchaseRequest;

/// An original native *typed* request, not a renderer-supplied hash. Stable
/// serde struct field order and numeric conversion ensure a retry must supply
/// the same request content. This is not an external signature.
pub(crate) fn purchase_draft_request_sha256(
    request: &NativePurchaseRequest,
) -> Result<String, String> {
    if request.status.as_deref() != Some("draft") || request.cart.len() > 200 {
        return Err("Expected an original bounded draft purchase request".into());
    }
    let bytes = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    if bytes.len() > 131_072 || bytes.iter().any(|byte| *byte == 0) {
        return Err("Original draft purchase request exceeds receipt bounds".into());
    }
    let hash = Sha256::digest(&bytes);
    Ok(format!("{hash:x}"))
}

/// Fingerprint the *current persisted* native source as a separate witness.
/// SQL owns the fields and order; no renderer SQL, claimed actor, or supplied
/// digest is consulted. Replacing or editing lines changes the identity.
pub(crate) async fn purchase_draft_source_sha256(
    conn: &mut SqliteConnection,
    invoice_id: &str,
    actor_id: &str,
    pharmacy: &str,
) -> Result<Option<String>, String> {
    let header: Option<String> = sqlx::query_scalar(
        "SELECT json_object('id',id,'pharmacy',pharmacy_id,'user',user_id,
          'supplier',supplier_id,'number',invoice_number,'date',invoice_date,
          'payment',payment_method,'notes',notes,'check',check_number,
          'expenses',expenses,'discountValue',discount_value,
          'discountPercent',discount_percent,'taxPercent',tax_percent,
          'status',status,'total',total_amount)
         FROM purchase_invoices WHERE id=? AND pharmacy_id=?
          AND CAST(user_id AS TEXT)=? AND status='draft'",
    )
    .bind(invoice_id)
    .bind(pharmacy)
    .bind(actor_id)
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    let Some(header) = header else {
        return Ok(None);
    };
    let lines: Vec<String> = sqlx::query_scalar(
        "SELECT json_object('line',id,'invoice',invoice_id,'drug',drug_id,
           'quantity',quantity,'unit',unit_id,'expiry',expiry_date,
           'cost',cost_price,'selling',selling_price,'bonus',bonus_quantity,
           'tax',tax_percent,'discount',discount_percent,
           'strips',strips_per_box,'mediumToSmall',medium_to_small,'barcode',barcode,
           'inventory',inventory_id)
         FROM purchase_invoice_items WHERE invoice_id=? ORDER BY id",
    )
    .bind(invoice_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;
    if lines.len() > 200 || header.len() > 32_768 || lines.iter().any(|line| line.len() > 4096) {
        return Err("Persisted draft evidence exceeds bounded witness size".into());
    }
    let mut sha = Sha256::new();
    sha.update(header.as_bytes());
    for line in lines {
        sha.update([0u8]);
        sha.update(line.as_bytes());
    }
    Ok(Some(format!("{:x}", sha.finalize())))
}

pub(crate) async fn record_purchase_draft_creation(
    tx: &mut Transaction<'_, Sqlite>,
    request_id: &str,
    invoice_id: &str,
    actor_id: &str,
    pharmacy: &str,
    original_request_sha256: &str,
) -> Result<(), String> {
    let source_sha = purchase_draft_source_sha256(&mut **tx, invoice_id, actor_id, pharmacy)
        .await?
        .ok_or("Original native draft source not available for receipt")?;
    sqlx::query(
        "INSERT INTO native_purchase_draft_create_witnesses
         (request_id,invoice_id,actor_id,pharmacy_id,original_request_sha256,original_source_sha256)
         VALUES(?,?,?,?,?,?)",
    )
    .bind(request_id)
    .bind(invoice_id)
    .bind(actor_id)
    .bind(pharmacy)
    .bind(original_request_sha256)
    .bind(source_sha)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("Cannot seal native draft original source: {e}"))?;
    Ok(())
}

fn exact_cents(value: f64) -> Result<i64, String> {
    if !value.is_finite() || value.abs() > 1_000_000_000_000.0 {
        return Err("Purchase posting money is not finite or bounded".into());
    }
    let scaled = value * 100.0;
    if (scaled - scaled.round()).abs() > 0.0001 {
        return Err("Purchase posting amount does not have cent precision".into());
    }
    Ok(scaled.round() as i64)
}

/// Durable, single-use request identity for an initial native purchase (draft
/// or completed). Capture it in the SAME writer transaction as the source,
/// inventory and initial journal; never return a prior result on nonce replay.
pub(crate) async fn record_purchase_creation(
    tx: &mut Transaction<'_, Sqlite>,
    request_id: &str,
    invoice_id: &str,
    actor_id: &str,
    pharmacy: &str,
    supplier_id: i64,
    total: f64,
) -> Result<(), String> {
    super::sales_cogs_provenance::canonical_request_id(request_id)?;
    let cents = exact_cents(total)?;
    if cents < 0 {
        return Err("Purchase creation amount is negative".into());
    }
    let source = sqlx::query(
        "SELECT status FROM purchase_invoices WHERE id=? AND pharmacy_id=? AND user_id=? AND supplier_id=?",
    )
    .bind(invoice_id)
    .bind(pharmacy)
    .bind(actor_id)
    .bind(supplier_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or("Purchase creation source is not owned by the current actor")?;
    let status: String = source.try_get("status").map_err(|e| e.to_string())?;
    if !matches!(status.as_str(), "draft" | "completed") {
        return Err("Purchase creation status is unsupported".into());
    }
    let line_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM purchase_invoice_items WHERE invoice_id=?")
            .bind(invoice_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    if !(0..=200).contains(&line_count) {
        return Err("Purchase creation has excessive lines".into());
    }
    let initial_journal: Option<String> = if status == "completed" {
        sqlx::query_scalar(
            "SELECT journal_id FROM native_purchase_posting_events
             WHERE invoice_id=? AND event_kind='initial' AND actor_id=? AND pharmacy_id=?
             ORDER BY recorded_at DESC LIMIT 1",
        )
        .bind(invoice_id)
        .bind(actor_id)
        .bind(pharmacy)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
    } else {
        None
    };
    sqlx::query(
        "INSERT INTO native_purchase_create_requests
         (request_id,invoice_id,actor_id,pharmacy_id,supplier_id,source_status,source_total_cents,source_line_count,initial_journal_id)
         VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(request_id)
    .bind(invoice_id)
    .bind(actor_id)
    .bind(pharmacy)
    .bind(supplier_id)
    .bind(status)
    .bind(cents)
    .bind(line_count)
    .bind(initial_journal)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("Native purchase create request replay or invalid source: {e}"))?;
    Ok(())
}

/// A consumed purchase can legitimately swap received quantities across lots
/// while its total value remains unchanged. Journal entries must not be
/// fabricated for a zero-cent movement: instead seal the old/new stock/lot
/// witness atomically. Legacy missing initial-journal evidence stays NULL.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn record_zero_delta_stock_edit(
    tx: &mut Transaction<'_, Sqlite>,
    invoice_id: &str,
    actor_id: &str,
    pharmacy: &str,
    supplier_id: i64,
    old_total: f64,
    new_total: f64,
    lines: &[Value],
) -> Result<(), String> {
    let old_cents = exact_cents(old_total)?;
    let new_cents = exact_cents(new_total)?;
    if old_cents != new_cents || old_cents <= 0 || lines.is_empty() || lines.len() > 200 {
        return Err("Zero-delta stock receipt requires the same positive source amount".into());
    }
    let changed = lines.iter().any(|line| {
        match (
            line.get("oldReceived").and_then(Value::as_f64),
            line.get("newReceived").and_then(Value::as_f64),
        ) {
            (Some(old), Some(new)) => (old - new).abs() > 0.000001,
            _ => false,
        }
    });
    if !changed {
        return Err("Zero-delta stock receipt has no quantity change".into());
    }
    let snapshot = serde_json::to_string(lines).map_err(|e| e.to_string())?;
    if snapshot.len() > 131_072 {
        return Err("Zero-delta stock evidence exceeds bounds".into());
    }
    let original_journal_id: Option<String> = sqlx::query_scalar(
        "SELECT journal_id FROM native_purchase_posting_events
         WHERE invoice_id=? AND pharmacy_id=? AND event_kind='initial'
         ORDER BY recorded_at DESC LIMIT 1",
    )
    .bind(invoice_id)
    .bind(pharmacy)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO native_purchase_zero_delta_stock_events
         (event_id,invoice_id,actor_id,pharmacy_id,supplier_id,total_cents,original_journal_id,line_snapshot,line_count)
         VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(invoice_id)
    .bind(actor_id)
    .bind(pharmacy)
    .bind(supplier_id)
    .bind(new_cents)
    .bind(original_journal_id)
    .bind(snapshot)
    .bind(lines.len() as i64)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("Cannot seal zero-delta purchase stock edit: {e}"))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn record_purchase_event(
    tx: &mut Transaction<'_, Sqlite>,
    invoice_id: &str,
    actor_id: &str,
    pharmacy: &str,
    supplier_id: i64,
    payment: &str,
    kind: &str,
    old_total: f64,
    new_total: f64,
    journal_id: &str,
) -> Result<(), String> {
    if !matches!(kind, "initial" | "edit_delta" | "reverse")
        || !matches!(payment, "cash" | "credit" | "check")
        || invoice_id.trim().is_empty()
        || invoice_id.len() > 256
        || actor_id.is_empty()
        || actor_id.len() > 128
        || pharmacy.trim().is_empty()
        || pharmacy.len() > 128
        || supplier_id <= 0
        || journal_id.trim().is_empty()
    {
        return Err("Untrusted purchase provenance source, actor or operation".into());
    }
    let old = exact_cents(old_total)?;
    let new = exact_cents(new_total)?;
    let signed = match kind {
        "initial" => new,
        "edit_delta" => new.checked_sub(old).ok_or("Purchase delta overflow")?,
        _ => old.checked_neg().ok_or("Purchase reversal overflow")?,
    };
    if signed == 0 || (kind == "initial" && old != 0) || (kind == "reverse" && new != 0) {
        return Err("Purchase posting event has no coherent financial movement".into());
    }
    let source = sqlx::query(
        "SELECT p.supplier_id,p.pharmacy_id,p.status,
                CAST(p.total_amount AS REAL) AS amount,
                u.pharmacy_id AS actor_pharmacy, COALESCE(u.is_active,1) AS active
         FROM purchase_invoices p
         JOIN users u ON CAST(u.id AS TEXT)=?
         WHERE p.id=?",
    )
    .bind(actor_id)
    .bind(invoice_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or("Purchase provenance source/actor is unavailable")?;
    if source.try_get::<i64, _>("supplier_id").ok() != Some(supplier_id)
        || source.try_get::<String, _>("pharmacy_id").ok().as_deref() != Some(pharmacy)
        || source
            .try_get::<String, _>("actor_pharmacy")
            .ok()
            .as_deref()
            != Some(pharmacy)
        || source.try_get::<i64, _>("active").ok() != Some(1)
        || source.try_get::<String, _>("status").ok().as_deref() != Some("completed")
    {
        return Err("Purchase provenance source is not an active tenant-owned posting".into());
    }
    let source_total: f64 = source.try_get("amount").map_err(|e| e.to_string())?;
    let required_total = if kind == "reverse" { old } else { new };
    if exact_cents(source_total)? != required_total {
        return Err("Purchase provenance source total disagrees with receipt".into());
    }
    let lines = sqlx::query(
        "SELECT id,inventory_id,drug_id,
                CAST(quantity AS REAL) AS quantity,
                CAST(COALESCE(bonus_quantity,0) AS REAL) AS bonus,
                CAST(cost_price AS REAL) AS cost,
                CAST(COALESCE(tax_percent,0) AS REAL) AS tax,
                CAST(COALESCE(discount_percent,0) AS REAL) AS discount
         FROM purchase_invoice_items WHERE invoice_id=? ORDER BY id LIMIT 201",
    )
    .bind(invoice_id)
    .fetch_all(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if lines.is_empty() || lines.len() > 200 {
        return Err("Purchase provenance source line count is invalid or excessive".into());
    }
    let mut witnesses: Vec<Value> = Vec::with_capacity(lines.len());
    for line in lines {
        let lot: Option<String> = line.try_get("inventory_id").map_err(|e| e.to_string())?;
        let lot = lot.filter(|v| !v.is_empty());
        // Historical rows may lack an original FK: preserve this ambiguity
        // when reversing, rather than synthesizing a false lot provenance.
        if lot.is_none() && kind != "reverse" {
            return Err("Purchase provenance line lacks an inventory lot".into());
        }
        let owned: Option<i64> = if let Some(ref lot_id) = lot {
            sqlx::query_scalar("SELECT 1 FROM inventory WHERE id=? AND pharmacy_id=? AND drug_id=?")
                .bind(lot_id)
                .bind(pharmacy)
                .bind(
                    line.try_get::<i64, _>("drug_id")
                        .map_err(|e| e.to_string())?,
                )
                .fetch_optional(&mut **tx)
                .await
                .map_err(|e| e.to_string())?
        } else {
            None
        };
        if lot.is_some() && owned.is_none() {
            return Err("Purchase provenance line claims a foreign or missing lot".into());
        }
        let qty: f64 = line.try_get("quantity").map_err(|e| e.to_string())?;
        let bonus: f64 = line.try_get("bonus").map_err(|e| e.to_string())?;
        let cost: f64 = line.try_get("cost").map_err(|e| e.to_string())?;
        let tax: f64 = line.try_get("tax").map_err(|e| e.to_string())?;
        let discount: f64 = line.try_get("discount").map_err(|e| e.to_string())?;
        if ![qty, bonus, cost, tax, discount]
            .iter()
            .all(|n| n.is_finite())
            || qty < 0.0
            || bonus < 0.0
            || cost < 0.0
            || qty + bonus > 1_000_000_000.0
            || tax < 0.0
            || tax > 100.0
            || discount < 0.0
            || discount > 100.0
        {
            return Err("Purchase provenance line has invalid quantitative history".into());
        }
        witnesses.push(
            json!({"lineId":line.try_get::<i64,_>("id").map_err(|e|e.to_string())?,
            "inventoryId":lot,"originalLotVerifiable":owned.is_some(),
            "drugId":line.try_get::<i64,_>("drug_id").map_err(|e|e.to_string())?,
            "quantity":qty,"bonus":bonus,"cost":cost,"tax":tax,"discount":discount}),
        );
    }
    let snapshot = serde_json::to_string(&witnesses).map_err(|e| e.to_string())?;
    if snapshot.len() > 131_072 {
        return Err("Purchase provenance line snapshot exceeds limit".into());
    }
    sqlx::query(
        "INSERT INTO native_purchase_posting_events
           (event_id,invoice_id,actor_id,pharmacy_id,supplier_id,event_kind,journal_id,
            payment_method,signed_cents,old_total_cents,new_total_cents,line_snapshot)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(invoice_id)
    .bind(actor_id)
    .bind(pharmacy)
    .bind(supplier_id)
    .bind(kind)
    .bind(journal_id)
    .bind(payment)
    .bind(signed)
    .bind(old)
    .bind(new)
    .bind(snapshot)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("Cannot persist immutable purchase journal provenance: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod creation_tests {
    use super::{record_purchase_creation, record_zero_delta_stock_edit};
    use sqlx::{Connection, SqliteConnection};
    use uuid::Uuid;

    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users(id TEXT PRIMARY KEY, pharmacy_id TEXT, is_active INTEGER);
             CREATE TABLE purchase_invoices(id TEXT PRIMARY KEY, pharmacy_id TEXT, user_id TEXT, supplier_id INTEGER, status TEXT, total_amount REAL);
             CREATE TABLE purchase_invoice_items(id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity REAL, bonus_quantity REAL);
             CREATE TABLE inventory(id TEXT PRIMARY KEY, pharmacy_id TEXT, drug_id INTEGER, quantity REAL);
             CREATE TABLE daily_journals(id TEXT PRIMARY KEY, pharmacy_id TEXT);
             CREATE TABLE native_purchase_posting_events(invoice_id TEXT, actor_id TEXT, pharmacy_id TEXT, event_kind TEXT, journal_id TEXT, new_total_cents INTEGER, recorded_at TEXT);
             INSERT INTO users VALUES ('owner-a','tenant-a',1),('owner-b','tenant-b',1);
             INSERT INTO purchase_invoices VALUES ('draft-a','tenant-a','owner-a',7,'draft',0),
               ('draft-b','tenant-a','owner-a',7,'draft',0),
               ('other-tenant','tenant-b','owner-b',7,'draft',0),
               ('completed-a','tenant-a','owner-a',7,'completed',10);
             INSERT INTO purchase_invoice_items(invoice_id) VALUES ('draft-a'),('draft-b'),('other-tenant'),('completed-a');
             INSERT INTO inventory VALUES('lot-a','tenant-a',9,6);
             UPDATE purchase_invoice_items SET inventory_id='lot-a',drug_id=9,quantity=3,bonus_quantity=0 WHERE invoice_id='completed-a';
             INSERT INTO daily_journals VALUES ('initial-a','tenant-a');
             INSERT INTO native_purchase_posting_events VALUES ('completed-a','owner-a','tenant-a','initial','initial-a',1000,'2026-10-12');",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/044_purchase_create_request_receipts.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../migrations/046_purchase_zero_delta_stock_events.sql"
        ))
        .execute(&mut conn)
        .await
        .unwrap();
        conn
    }

    #[tokio::test]
    async fn initial_purchase_nonce_is_single_use_tenant_bound_immutable_and_survives_delete() {
        let mut conn = fixture().await;
        let nonce = Uuid::new_v4().to_string();
        let mut tx = conn.begin().await.unwrap();
        record_purchase_creation(&mut tx, &nonce, "draft-a", "owner-a", "tenant-a", 7, 0.0)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        assert!(record_purchase_creation(
            &mut tx, &nonce, "draft-b", "owner-a", "tenant-a", 7, 0.0
        )
        .await
        .is_err());
        assert!(record_purchase_creation(
            &mut tx,
            &Uuid::new_v4().to_string(),
            "draft-a",
            "owner-a",
            "tenant-a",
            7,
            0.0
        )
        .await
        .is_err());
        assert!(record_purchase_creation(
            &mut tx,
            &Uuid::new_v4().to_string(),
            "other-tenant",
            "owner-a",
            "tenant-a",
            7,
            0.0
        )
        .await
        .is_err());
        assert!(record_purchase_creation(
            &mut tx,
            "not-a-uuid",
            "draft-b",
            "owner-a",
            "tenant-a",
            7,
            0.0
        )
        .await
        .is_err());
        tx.rollback().await.unwrap();
        assert!(
            sqlx::query("UPDATE native_purchase_create_requests SET invoice_id='fake'")
                .execute(&mut conn)
                .await
                .is_err()
        );
        assert!(sqlx::query("DELETE FROM native_purchase_create_requests")
            .execute(&mut conn)
            .await
            .is_err());
        sqlx::query("DELETE FROM purchase_invoices WHERE id='draft-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        let mut tx = conn.begin().await.unwrap();
        assert!(record_purchase_creation(
            &mut tx, &nonce, "draft-b", "owner-a", "tenant-a", 7, 0.0
        )
        .await
        .is_err());
        tx.rollback().await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM native_purchase_create_requests")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn completed_purchase_creation_requires_real_initial_journal_and_exact_total() {
        let mut conn = fixture().await;
        let mut tx = conn.begin().await.unwrap();
        assert!(record_purchase_creation(
            &mut tx,
            &Uuid::new_v4().to_string(),
            "completed-a",
            "owner-a",
            "tenant-a",
            7,
            9.0
        )
        .await
        .is_err());
        assert!(record_purchase_creation(
            &mut tx,
            &Uuid::new_v4().to_string(),
            "completed-a",
            "owner-b",
            "tenant-b",
            7,
            10.0
        )
        .await
        .is_err());
        tx.rollback().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        record_purchase_creation(
            &mut tx,
            &Uuid::new_v4().to_string(),
            "completed-a",
            "owner-a",
            "tenant-a",
            7,
            10.0,
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let journal: String = sqlx::query_scalar("SELECT initial_journal_id FROM native_purchase_create_requests WHERE invoice_id='completed-a'")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(journal, "initial-a");
    }

    #[tokio::test]
    async fn zero_delta_stock_receipts_reject_forged_lots_scope_and_rewriting() {
        let mut conn = fixture().await;
        let good = serde_json::json!([{
            "lineId":4,"inventoryId":"lot-a","drugId":9,"unitCost":2.0,
            "oldReceived":2.0,"newReceived":3.0,"oldAvailable":5.0,"newAvailable":6.0
        }]);
        let mut tx = conn.begin().await.unwrap();
        record_zero_delta_stock_edit(
            &mut tx,
            "completed-a",
            "owner-a",
            "tenant-a",
            7,
            10.0,
            10.0,
            good.as_array().unwrap(),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let mut tx = conn.begin().await.unwrap();
        let wrong_lot = serde_json::json!([{
            "lineId":4,"inventoryId":"foreign-lot","oldReceived":2.0,"newReceived":3.0,
            "oldAvailable":5.0,"newAvailable":6.0
        }]);
        assert!(record_zero_delta_stock_edit(
            &mut tx,
            "completed-a",
            "owner-a",
            "tenant-a",
            7,
            10.0,
            10.0,
            wrong_lot.as_array().unwrap()
        )
        .await
        .is_err());
        assert!(record_zero_delta_stock_edit(
            &mut tx,
            "completed-a",
            "owner-b",
            "tenant-b",
            7,
            10.0,
            10.0,
            good.as_array().unwrap()
        )
        .await
        .is_err());
        assert!(record_zero_delta_stock_edit(
            &mut tx,
            "completed-a",
            "owner-a",
            "tenant-a",
            7,
            10.0,
            11.0,
            good.as_array().unwrap()
        )
        .await
        .is_err());
        let unchanged = serde_json::json!([{
            "lineId":4,"inventoryId":"lot-a","oldReceived":3.0,"newReceived":3.0,
            "oldAvailable":6.0,"newAvailable":6.0
        }]);
        assert!(record_zero_delta_stock_edit(
            &mut tx,
            "completed-a",
            "owner-a",
            "tenant-a",
            7,
            10.0,
            10.0,
            unchanged.as_array().unwrap()
        )
        .await
        .is_err());
        tx.rollback().await.unwrap();
        assert!(sqlx::query(
            "UPDATE native_purchase_zero_delta_stock_events SET pharmacy_id='tenant-b'"
        )
        .execute(&mut conn)
        .await
        .is_err());
        assert!(
            sqlx::query("DELETE FROM native_purchase_zero_delta_stock_events")
                .execute(&mut conn)
                .await
                .is_err()
        );
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM native_purchase_zero_delta_stock_events")
                .fetch_one(&mut conn)
                .await
                .unwrap();
        assert_eq!(count, 1);
    }
}
