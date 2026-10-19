//! Detached read-only COGS correction eligibility projection.
//!
//! This file is deliberately not registered as a Tauri command or imported
//! from commands/mod.rs. A caller must first obtain the actor from the native
//! authenticated session. It only inspects existing 043/044/046 receipts and
//! never returns a proposed cost, accounting delta, write permission or SQL
//! mutation. The absence of an immutable *corrected acquisition valuation*
//! receipt makes every candidate ineligible for posting, even if all original
//! sale and purchase source records are complete.
//!
//! Do not add 066 posting tables, a native writer or enabled UI on the strength
//! of this projection. A separate acquisition cost correction, its journal
//! account mapping and compensation of later 043 returns remain unproved.
#![allow(dead_code)]

use sqlx::{Row, SqliteConnection};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Ineligibility {
    NoOriginal043Sale,
    NoMatchingSaleLine,
    UnreceiptedOrForeignReturn,
    NoUnique044PurchaseSource,
    Changed046PurchaseQuantities,
    NoIndependentAcquisitionValuation,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ReadOnlyCogsEligibility {
    pub reason: Ineligibility,
    pub original_043_sale_seen: bool,
    pub unique_044_purchase_source_seen: bool,
    pub changed_046_quantity_events_seen: bool,
}

impl ReadOnlyCogsEligibility {
    /// The projection never certifies corrected acquisition cost or authorizes
    /// an entry in 4.1 (COGS) / 1.1.3 (inventory asset).
    pub fn can_post(&self) -> bool {
        false
    }
}

fn denied(reason: Ineligibility, sale: bool, purchase: bool, zero_delta: bool) -> ReadOnlyCogsEligibility {
    ReadOnlyCogsEligibility {
        reason,
        original_043_sale_seen: sale,
        unique_044_purchase_source_seen: purchase,
        changed_046_quantity_events_seen: zero_delta,
    }
}

/// A coherent read-only snapshot of *existing* source lineage. The actor
/// argument must come from a trusted native session, never from a renderer
/// request. The module is intentionally detached until that command exists.
///
/// Source receipt existence is not equivalent to complete historical valuation.
/// A 043 cost is the immutable ORIGINAL cost; 044 attests purchase totals, not
/// unit price correction; 046 witnesses changed quantities with zero money.
pub(crate) async fn project_cogs_correction_eligibility(
    conn: &mut SqliteConnection,
    actor: &str,
    pharmacy_id: &str,
    sale_id: &str,
    sale_item_id: i64,
) -> Result<ReadOnlyCogsEligibility, String> {
    if actor.is_empty() || actor.len() > 128 || actor.trim() != actor
        || pharmacy_id.is_empty() || pharmacy_id.len() > 128
        || pharmacy_id.trim() != pharmacy_id || pharmacy_id == "local_default"
        || sale_id.is_empty() || sale_id.len() > 256 || sale_id.trim() != sale_id
        || sale_item_id <= 0
    {
        return Err("Invalid correction source or tenant scope".into());
    }
    sqlx::query("BEGIN").execute(&mut *conn).await.map_err(|e| e.to_string())?;
    let result = async {
        // The current UI is owner-only. Checking an actor identity supplied by
        // a future authenticated command is mandatory before observing rows.
        let user = sqlx::query(
            "SELECT role,pharmacy_id FROM main.users
             WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
        ).bind(actor).fetch_optional(&mut *conn).await.map_err(|e| e.to_string())?
         .ok_or("No authenticated owner for correction projection")?;
        let role: String = user.try_get("role").map_err(|e| e.to_string())?;
        let owned_pharmacy: Option<String> =
            user.try_get("pharmacy_id").map_err(|e| e.to_string())?;
        if role.trim().to_ascii_lowercase() != "owner"
            || owned_pharmacy.as_deref() != Some(pharmacy_id) {
            return Err("COGS projection requires the current tenant's owner".into());
        }

        // A sale must have its own 043 receipt plus a coherent actor, tenant,
        // payment rail, original journal and complete line count. We never
        // accept an unreceipted legacy sale as a correction candidate.
        let sale = sqlx::query(
            "SELECT p.line_snapshot,p.line_count
             FROM main.sales_invoices s
             JOIN main.native_sale_cogs_provenance p ON p.sale_id=s.id
             JOIN main.daily_journals j ON j.id=p.journal_id
             WHERE s.id=? AND s.pharmacy_id=? AND s.status='completed'
               AND p.pharmacy_id=s.pharmacy_id
               AND p.actor_id=CAST(s.user_id AS TEXT)
               AND p.payment_method=s.payment_method
               AND j.pharmacy_id=p.pharmacy_id
               AND CAST(j.created_by AS TEXT)=p.actor_id
               AND typeof(s.total_amount) IN ('integer','real')
               AND abs(s.total_amount*1000000-p.sale_micros)<2
               AND typeof(j.total_amount) IN ('integer','real')
               AND abs(j.total_amount*1000000-(p.sale_micros+p.cogs_micros))<2
               AND json_valid(p.line_snapshot)
               AND json_type(p.line_snapshot)='array'
               AND json_array_length(p.line_snapshot)=p.line_count
               AND p.line_count=(SELECT count(*) FROM main.sales_items WHERE invoice_id=s.id)
             LIMIT 1",
        ).bind(sale_id).bind(pharmacy_id)
         .fetch_optional(&mut *conn).await.map_err(|e|e.to_string())?;
        if sale.is_none() {
            return Ok(denied(Ineligibility::NoOriginal043Sale, false, false, false));
        }

        // Immutable sale line IDs and lot identity must match the 043 snapshot.
        // The original cost is deliberately neither returned nor repurposed as
        // a corrected acquisition cost.
        let has_line: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.sales_items si
             JOIN main.inventory inv ON inv.id=si.inventory_id
             JOIN main.native_sale_cogs_provenance p ON p.sale_id=si.invoice_id
             JOIN json_each(p.line_snapshot) entry
             WHERE si.id=? AND si.invoice_id=? AND p.pharmacy_id=?
               AND inv.pharmacy_id=p.pharmacy_id AND inv.drug_id=si.drug_id
               AND COALESCE(si.is_negative,0)=0
               AND json_type(entry.value,'$.lineId')='integer'
               AND CAST(json_extract(entry.value,'$.lineId') AS INTEGER)=si.id
               AND json_type(entry.value,'$.inventoryId')='text'
               AND json_extract(entry.value,'$.inventoryId')=si.inventory_id
               AND json_type(entry.value,'$.drugId')='integer'
               AND CAST(json_extract(entry.value,'$.drugId') AS INTEGER)=si.drug_id
               AND json_extract(entry.value,'$.negative')=0
               AND typeof(si.cost_price) IN ('integer','real')
               AND abs(si.cost_price-json_extract(entry.value,'$.costPerLarge'))<0.0000001",
        ).bind(sale_item_id).bind(sale_id).bind(pharmacy_id)
         .fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        if has_line != 1 {
            return Ok(denied(Ineligibility::NoMatchingSaleLine, true, false, false));
        }

        // One completed/approved return without its matching 043 source
        // destroys completeness. A receipt from another tenant is no proof.
        let missing_returns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.returns r
             WHERE r.invoice_id=? AND lower(trim(coalesce(r.status,''))) IN ('approved','completed')
               AND (r.pharmacy_id<>? OR NOT EXISTS (
                 SELECT 1 FROM main.native_sale_return_cogs_provenance rp
                 JOIN main.daily_journals j ON j.id=rp.journal_id
                 WHERE rp.return_id=r.id AND rp.sale_id=?
                   AND rp.pharmacy_id=? AND rp.actor_id=CAST(r.user_id AS TEXT)
                   AND rp.refund_method=r.refund_method
                   AND j.pharmacy_id=rp.pharmacy_id
                   AND CAST(j.created_by AS TEXT)=rp.actor_id
                   AND rp.line_count>0
                   AND json_valid(rp.line_snapshot)
                   AND json_type(rp.line_snapshot)='array'
                   AND json_array_length(rp.line_snapshot)=rp.line_count
                   AND rp.line_count=(SELECT COUNT(*) FROM main.return_items WHERE return_id=r.id)
                   AND NOT EXISTS (
                     SELECT 1 FROM main.return_items ri
                     WHERE ri.return_id=r.id AND NOT EXISTS (
                       SELECT 1 FROM json_each(rp.line_snapshot) line
                       WHERE json_type(line.value,'$.lineId')='integer'
                         AND json_extract(line.value,'$.lineId')=ri.id
                         AND json_type(line.value,'$.originalSaleId')='text'
                         AND json_extract(line.value,'$.originalSaleId')=r.invoice_id))
                   AND typeof(r.total_refund) IN ('real','integer')
                   AND abs(r.total_refund*1000000-rp.refund_micros)<2))",
        ).bind(sale_id).bind(pharmacy_id).bind(sale_id).bind(pharmacy_id)
         .fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        if missing_returns != 0 {
            return Ok(denied(Ineligibility::UnreceiptedOrForeignReturn, true, false, false));
        }

        // Purchase 044 attests only the whole purchase total and original 042
        // journal. Even exactly one purchase line cannot attest a *new* unit
        // valuation, and another invoice for the same lot makes this unsafe.
        let purchases: Vec<String> = sqlx::query_scalar(
            "SELECT DISTINCT c.invoice_id
             FROM main.sales_items si
             JOIN main.purchase_invoice_items pi ON pi.inventory_id=si.inventory_id
               AND pi.drug_id=si.drug_id
             JOIN main.purchase_invoices p ON p.id=pi.invoice_id
             JOIN main.native_purchase_create_requests c ON c.invoice_id=p.id
             JOIN main.native_purchase_posting_events e ON e.journal_id=c.initial_journal_id
             WHERE si.id=? AND si.invoice_id=? AND p.pharmacy_id=?
               AND c.pharmacy_id=p.pharmacy_id AND c.supplier_id=p.supplier_id
               AND c.source_status='completed' AND p.status='completed'
               AND CAST(p.user_id AS TEXT)=c.actor_id AND c.actor_id=e.actor_id
               AND e.invoice_id=p.id AND e.event_kind='initial'
               AND e.pharmacy_id=p.pharmacy_id
               AND e.new_total_cents=c.source_total_cents
             LIMIT 2",
        ).bind(sale_item_id).bind(sale_id).bind(pharmacy_id)
         .fetch_all(&mut *conn).await.map_err(|e|e.to_string())?;
        if purchases.len() != 1 {
            return Ok(denied(Ineligibility::NoUnique044PurchaseSource, true, false, false));
        }
        let changed_quantity: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.native_purchase_zero_delta_stock_events
             WHERE invoice_id=? AND pharmacy_id=?",
        ).bind(&purchases[0]).bind(pharmacy_id)
         .fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
        if changed_quantity > 0 {
            return Ok(denied(Ineligibility::Changed046PurchaseQuantities, true, true, true));
        }
        // There is no independently certified acquisition cost correction in
        // 043/044/046. Returning the original sale's cost or mutable stock cost
        // here would manufacture authority to post an unsupported journal.
        Ok(denied(Ineligibility::NoIndependentAcquisitionValuation, true, true, false))
    }.await;
    sqlx::query("ROLLBACK").execute(&mut *conn).await.map_err(|e|e.to_string())?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    async fn fixture() -> SqliteConnection {
        let mut db=SqliteConnection::connect("sqlite::memory:").await.unwrap();
        db.execute(r#"
          CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,is_active INTEGER);
          INSERT INTO users VALUES ('owner-a','owner','a',1),('owner-b','owner','b',1),
                                    ('inactive','owner','a',0),('clerk','cashier','a',1);
          CREATE TABLE sales_invoices(id TEXT,pharmacy_id TEXT,user_id TEXT,payment_method TEXT,status TEXT,total_amount REAL);
          INSERT INTO sales_invoices VALUES('sale-a','a','owner-a','cash','completed',20);
          CREATE TABLE native_sale_cogs_provenance(sale_id TEXT,pharmacy_id TEXT,actor_id TEXT,
            payment_method TEXT,journal_id TEXT,sale_micros INTEGER,cogs_micros INTEGER,
            line_count INTEGER,line_snapshot TEXT);
          INSERT INTO native_sale_cogs_provenance VALUES(
            'sale-a','a','owner-a','cash','sale-journal',20000000,7000000,1,
            '[{"lineId":11,"inventoryId":"lot-a","drugId":9,"negative":false,"costPerLarge":7}]');
          CREATE TABLE daily_journals(id TEXT,pharmacy_id TEXT,created_by TEXT,total_amount REAL);
          INSERT INTO daily_journals VALUES('sale-journal','a','owner-a',27);
          CREATE TABLE inventory(id TEXT,pharmacy_id TEXT,drug_id INTEGER);
          INSERT INTO inventory VALUES('lot-a','a',9);
          CREATE TABLE sales_items(id INTEGER,invoice_id TEXT,inventory_id TEXT,drug_id INTEGER,
            is_negative INTEGER,cost_price REAL);
          INSERT INTO sales_items VALUES(11,'sale-a','lot-a',9,0,7);
          CREATE TABLE returns(id TEXT,invoice_id TEXT,pharmacy_id TEXT,user_id TEXT,status TEXT,
            refund_method TEXT,total_refund REAL);
          CREATE TABLE return_items(id INTEGER,return_id TEXT);
          CREATE TABLE native_sale_return_cogs_provenance(return_id TEXT,sale_id TEXT,
            pharmacy_id TEXT,actor_id TEXT,refund_method TEXT,journal_id TEXT,
            line_count INTEGER,refund_micros INTEGER,line_snapshot TEXT);
          CREATE TABLE purchase_invoices(id TEXT,pharmacy_id TEXT,user_id TEXT,supplier_id INTEGER,
            status TEXT);
          INSERT INTO purchase_invoices VALUES('purchase-a','a','owner-a',7,'completed');
          CREATE TABLE purchase_invoice_items(invoice_id TEXT,inventory_id TEXT,drug_id INTEGER);
          INSERT INTO purchase_invoice_items VALUES('purchase-a','lot-a',9);
          CREATE TABLE native_purchase_create_requests(invoice_id TEXT,initial_journal_id TEXT,
            pharmacy_id TEXT,supplier_id INTEGER,source_status TEXT,source_total_cents INTEGER,
            actor_id TEXT);
          INSERT INTO native_purchase_create_requests VALUES(
            'purchase-a','purchase-journal','a',7,'completed',7000,'owner-a');
          CREATE TABLE native_purchase_posting_events(journal_id TEXT,invoice_id TEXT,
            actor_id TEXT,event_kind TEXT,pharmacy_id TEXT,new_total_cents INTEGER);
          INSERT INTO native_purchase_posting_events VALUES(
            'purchase-journal','purchase-a','owner-a','initial','a',7000);
          CREATE TABLE native_purchase_zero_delta_stock_events(invoice_id TEXT,pharmacy_id TEXT);
        "#).await.unwrap();
        db
    }

    async fn inspect(db: &mut SqliteConnection) -> ReadOnlyCogsEligibility {
        project_cogs_correction_eligibility(db,"owner-a","a","sale-a",11).await.unwrap()
    }

    #[tokio::test]
    async fn matching_043_and_044_still_cannot_prove_a_new_acquisition_unit_cost() {
        let mut db=fixture().await;
        let report=inspect(&mut db).await;
        assert_eq!(report.reason,Ineligibility::NoIndependentAcquisitionValuation);
        assert!(report.original_043_sale_seen && report.unique_044_purchase_source_seen);
        assert!(!report.can_post());
        // No receipt, original journal, sale line, or source balance is touched.
        let original: f64=sqlx::query_scalar("SELECT cost_price FROM sales_items WHERE id=11")
            .fetch_one(&mut db).await.unwrap();
        assert_eq!(original,7.0);
    }

    #[tokio::test]
    async fn rejects_cross_tenant_inactive_and_nonowner_before_observing_sale() {
        let mut db=fixture().await;
        for (actor,tenant) in [("owner-b","a"),("owner-a","b"),
                                ("inactive","a"),("clerk","a")] {
            assert!(project_cogs_correction_eligibility(&mut db,actor,tenant,"sale-a",11)
                .await.is_err(), "{actor} in {tenant}");
        }
        assert!(project_cogs_correction_eligibility(&mut db,"owner-a","local_default","sale-a",11)
            .await.is_err());
    }

    #[tokio::test]
    async fn missing_sale_snapshot_and_changed_mutable_cost_are_never_eligible() {
        let mut db=fixture().await;
        db.execute("DELETE FROM native_sale_cogs_provenance").await.unwrap();
        assert_eq!(inspect(&mut db).await.reason,Ineligibility::NoOriginal043Sale);
        db.execute("INSERT INTO native_sale_cogs_provenance VALUES(
            'sale-a','a','owner-a','cash','sale-journal',20000000,7000000,1,
            '[{\"lineId\":11,\"inventoryId\":\"lot-a\",\"drugId\":9,\"negative\":false,\"costPerLarge\":7}]')")
            .await.unwrap();
        db.execute("UPDATE sales_items SET cost_price=99 WHERE id=11").await.unwrap();
        assert_eq!(inspect(&mut db).await.reason,Ineligibility::NoMatchingSaleLine);
    }

    #[tokio::test]
    async fn unreceipted_refund_and_foreign_pharmacy_refund_are_never_eligible() {
        let mut db=fixture().await;
        db.execute("INSERT INTO returns VALUES('return-a','sale-a','a','owner-a',
            'approved','cash',5)").await.unwrap();
        assert_eq!(inspect(&mut db).await.reason,Ineligibility::UnreceiptedOrForeignReturn);
        db.execute("INSERT INTO daily_journals VALUES('refund-journal','a','owner-a',8)")
            .await.unwrap();
        db.execute("INSERT INTO return_items VALUES(31,'return-a')").await.unwrap();
        db.execute("INSERT INTO native_sale_return_cogs_provenance VALUES(
            'return-a','sale-a','a','owner-a','cash','refund-journal',1,5000000,
            '[{\"lineId\":31,\"originalSaleId\":\"sale-a\"}]')")
            .await.unwrap();
        assert_eq!(inspect(&mut db).await.reason,Ineligibility::NoIndependentAcquisitionValuation);
        db.execute("UPDATE returns SET pharmacy_id='b' WHERE id='return-a'").await.unwrap();
        assert_eq!(inspect(&mut db).await.reason,Ineligibility::UnreceiptedOrForeignReturn);
    }

    #[tokio::test]
    async fn missing_or_ambiguous_044_or_046_never_authorizes_valuation() {
        let mut db=fixture().await;
        db.execute("DELETE FROM native_purchase_create_requests").await.unwrap();
        assert_eq!(inspect(&mut db).await.reason,Ineligibility::NoUnique044PurchaseSource);
        db.execute("INSERT INTO native_purchase_create_requests VALUES(
            'purchase-a','purchase-journal','a',7,'completed',7000,'owner-a')")
            .await.unwrap();
        db.execute("INSERT INTO purchase_invoices VALUES('purchase-b','a','owner-a',8,'completed')")
            .await.unwrap();
        db.execute("INSERT INTO purchase_invoice_items VALUES('purchase-b','lot-a',9)")
            .await.unwrap();
        db.execute("INSERT INTO native_purchase_create_requests VALUES(
            'purchase-b','purchase-journal-b','a',8,'completed',7000,'owner-a')")
            .await.unwrap();
        db.execute("INSERT INTO native_purchase_posting_events VALUES(
            'purchase-journal-b','purchase-b','owner-a','initial','a',7000)")
            .await.unwrap();
        assert_eq!(inspect(&mut db).await.reason,Ineligibility::NoUnique044PurchaseSource);
        db.execute("DELETE FROM purchase_invoice_items WHERE invoice_id='purchase-b'")
            .await.unwrap();
        db.execute("INSERT INTO native_purchase_zero_delta_stock_events VALUES('purchase-a','a')")
            .await.unwrap();
        assert_eq!(inspect(&mut db).await.reason,Ineligibility::Changed046PurchaseQuantities);
        assert!(!inspect(&mut db).await.can_post());
    }
}
