//! Fixed read projections for negative-stock settlement. The strict desktop
//! cannot select private sales/inventory tables through arbitrary renderer SQL.
//! The reader never attests or re-parents pre-native/legacy sales.

use serde::Serialize;
use serde_json::{json, Value};
use sqlx::{Connection, Row, SqliteConnection};
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::reset_cancelled_read_state;
use super::permission_policy::user_has_permission;

const MAX_RESULTS: usize = 100;
const RETURNS: &str = r#"
  approved_return_rows AS (
    SELECT ri.sale_item_id,r.invoice_id,
      CAST(ri.quantity_returned AS REAL) AS quantity_returned,
      COALESCE(NULLIF(TRIM(ri.unit),''),NULLIF(TRIM(si.unit),''),'large') AS return_unit,
      COALESCE(NULLIF(TRIM(si.unit),''),'large') AS sold_unit,
      MAX(COALESCE(NULLIF(CAST(si.large_to_medium AS REAL),0),1),1) AS large_to_medium,
      MAX(COALESCE(NULLIF(CAST(si.medium_to_small AS REAL),0),1),1) AS medium_to_small,
      m.medium_unit,m.small_unit
    FROM main.return_items ri
    JOIN main.returns r ON r.id=ri.return_id
    JOIN main.sales_items si ON si.id=ri.sale_item_id AND si.invoice_id=r.invoice_id
    LEFT JOIN main.master_drugs m ON m.id=si.drug_id
    JOIN main.native_sale_return_cogs_provenance ev
      ON ev.return_id=r.id AND ev.sale_id=r.invoice_id AND ev.pharmacy_id=r.pharmacy_id
    WHERE LOWER(COALESCE(r.status,'')) IN ('approved','completed') AND r.pharmacy_id=?
  ),
  approved_returns AS (
    SELECT sale_item_id,invoice_id,
      SUM(quantity_returned *
        CASE WHEN LOWER(TRIM(return_unit)) IN ('medium','strip','شريط') OR
          (TRIM(COALESCE(medium_unit,''))<>'' AND LOWER(TRIM(return_unit))=LOWER(TRIM(medium_unit)))
          THEN 1.0/large_to_medium
        WHEN LOWER(TRIM(return_unit)) IN ('small','unit','pill') OR
          (TRIM(COALESCE(small_unit,''))<>'' AND LOWER(TRIM(return_unit))=LOWER(TRIM(small_unit)))
          THEN 1.0/(large_to_medium*medium_to_small) ELSE 1 END *
        CASE WHEN LOWER(TRIM(sold_unit)) IN ('medium','strip','شريط') OR
          (TRIM(COALESCE(medium_unit,''))<>'' AND LOWER(TRIM(sold_unit))=LOWER(TRIM(medium_unit)))
          THEN large_to_medium
        WHEN LOWER(TRIM(sold_unit)) IN ('small','unit','pill') OR
          (TRIM(COALESCE(small_unit,''))<>'' AND LOWER(TRIM(sold_unit))=LOWER(TRIM(small_unit)))
          THEN large_to_medium*medium_to_small ELSE 1 END) AS returned_quantity
    FROM approved_return_rows GROUP BY sale_item_id,invoice_id
  )
"#;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementProjection {
    actor_id: String,
    pharmacy_id: String,
    rows: Vec<Value>,
}

fn safe_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.len() <= max && !text.chars().any(char::is_control)
}

fn finite_nonnegative(value: f64) -> bool {
    value.is_finite() && (0.0..=1_000_000_000.0).contains(&value)
}

async fn project(
    conn: &mut SqliteConnection,
    actor: &str,
    query_id: &str,
    drug_id: Option<i64>,
) -> Result<SettlementProjection, String> {
    if !matches!(query_id, "unsettled_sales" | "drug_batches")
        || (query_id == "drug_batches" && !drug_id.is_some_and(|n| n > 0))
        || (query_id == "unsettled_sales" && drug_id.is_some())
    {
        return Err("Invalid native stock settlement query".into());
    }
    reset_cancelled_read_state(conn).await?;
    let mut tx = conn
        .begin()
        .await
        .map_err(|_| "Cannot initialize settlement snapshot")?;
    let result = async {
        let (role, pharmacy_id) = active_generic_actor(&mut tx, actor).await?;
        if pharmacy_id.trim().is_empty() || pharmacy_id == "local_default" {
            return Err("Unverified stock settlement tenant".into());
        }
        let permissions: Option<String> = sqlx::query_scalar(
            "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
        ).bind(actor).fetch_one(&mut *tx).await.map_err(|_| "Settlement actor unavailable")?;
        if !user_has_permission(Some(&role),permissions.as_deref(),"can_view_settlement",false) {
            return Err("Stock settlement read permission denied".into());
        }
        // Do not hide any unreceipted or foreign-return source by returning an
        // apparently healthy empty list. The native 043 COGS witness is the
        // only valid origin for new prospective negative-stock settlement.
        let unverified: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.sales_items si JOIN main.sales_invoices s ON s.id=si.invoice_id
             LEFT JOIN main.native_sale_cogs_provenance p ON p.sale_id=s.id AND p.pharmacy_id=s.pharmacy_id
             WHERE si.is_negative=1 AND s.pharmacy_id=?
               AND (p.sale_id IS NULL OR LOWER(COALESCE(s.status,'')) NOT IN ('completed','approved','delivered')
                 OR si.drug_id IS NULL OR si.quantity_sold<=0 OR si.quantity_sold>1000000000)",
        ).bind(&pharmacy_id).fetch_one(&mut *tx).await.map_err(|_| "Cannot certify settlement sale sources")?;
        let bad_returns: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM main.return_items ri
             JOIN main.sales_items si ON si.id=ri.sale_item_id AND si.is_negative=1
             JOIN main.sales_invoices s ON s.id=si.invoice_id AND s.pharmacy_id=?
             JOIN main.returns r ON r.id=ri.return_id
             LEFT JOIN main.native_sale_return_cogs_provenance ev
               ON ev.return_id=r.id AND ev.sale_id=s.id AND ev.pharmacy_id=s.pharmacy_id
             WHERE LOWER(COALESCE(r.status,'')) IN ('approved','completed')
               AND (r.invoice_id<>s.id OR r.pharmacy_id IS NOT s.pharmacy_id OR ev.return_id IS NULL
                 OR CAST(ri.quantity_returned AS REAL)<=0)",
        ).bind(&pharmacy_id).fetch_one(&mut *tx).await.map_err(|_| "Cannot certify settlement return sources")?;
        if unverified != 0 || bad_returns != 0 {
            return Err("Unreceipted negative sale or return requires source review".into());
        }

        let rows = if query_id == "unsettled_sales" {
            // Fixed SQL, bounded current-tenant rows; returns are converted to
            // the unit of their original sale, not simply subtracted as boxes.
            let query = format!(
                "WITH {RETURNS} SELECT si.id AS item_id,si.invoice_id,si.drug_id,
                 CAST(si.quantity_sold AS REAL) AS quantity_sold,
                 CAST(COALESCE(ar.returned_quantity,0) AS REAL) AS returned_quantity,
                 MAX(CAST(si.quantity_sold AS REAL)-COALESCE(ar.returned_quantity,0),0) AS net_unreturned_quantity,
                 COALESCE(si.unit,'large') AS unit,CAST(si.unit_price AS REAL) AS unit_price,
                 m.trade_name,m.trade_name_en,s.created_at AS sale_date,s.created_at AS created_at,
                 (SELECT COALESCE(SUM(i.quantity),0) FROM main.inventory i
                   JOIN main.master_drugs stock_m ON stock_m.id=i.drug_id
                   WHERE i.drug_id=si.drug_id AND i.pharmacy_id=? AND i.quantity>0
                     AND COALESCE(i.batch_number,'') NOT LIKE 'RET-%'
                     AND (COALESCE(stock_m.has_expiry,1)=0 OR i.expiry_date IS NOT NULL)
                     AND (i.expiry_date IS NULL OR i.expiry_date>=DATE('now','localtime'))
                 ) AS current_stock_balance
                 FROM main.sales_items si JOIN main.sales_invoices s ON s.id=si.invoice_id
                 JOIN main.master_drugs m ON m.id=si.drug_id
                 JOIN main.native_sale_cogs_provenance p ON p.sale_id=s.id AND p.pharmacy_id=s.pharmacy_id
                 LEFT JOIN approved_returns ar ON ar.sale_item_id=si.id AND ar.invoice_id=si.invoice_id
                 WHERE si.is_negative=1 AND s.pharmacy_id=? AND LOWER(s.status) IN ('completed','approved','delivered')
                 ORDER BY s.created_at DESC,si.id DESC LIMIT 101"
            );
            sqlx::query(&query).bind(&pharmacy_id).bind(&pharmacy_id).bind(&pharmacy_id)
                .fetch_all(&mut *tx).await.map_err(|_| "Native negative sales read unavailable")?
        } else {
            // The caller cannot enumerate arbitrary master-drug stock: it must
            // first own a 043-proven pending negative sale for this drug.
            let selected = drug_id.unwrap_or_default();
            let owned: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM main.sales_items si
                 JOIN main.sales_invoices s ON s.id=si.invoice_id
                 JOIN main.native_sale_cogs_provenance p ON p.sale_id=s.id AND p.pharmacy_id=s.pharmacy_id
                 WHERE si.drug_id=? AND si.is_negative=1 AND s.pharmacy_id=?",
            ).bind(selected).bind(&pharmacy_id).fetch_one(&mut *tx).await.map_err(|_| "Settlement drug source unavailable")?;
            if owned == 0 { return Err("No verified pending negative sale for selected drug".into()); }
            let invalid: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM main.inventory i LEFT JOIN main.master_drugs m ON m.id=i.drug_id
                 WHERE i.drug_id=? AND i.pharmacy_id=? AND
                   (i.quantity<0 OR i.quantity>1000000000 OR typeof(i.quantity) NOT IN ('integer','real')
                    OR i.cost_price<0 OR typeof(i.cost_price) NOT IN ('integer','real')
                    OR (COALESCE(m.has_expiry,1)<>0 AND i.quantity>0 AND
                       (i.expiry_date IS NULL OR date(i.expiry_date) IS NULL)))",
            ).bind(selected).bind(&pharmacy_id).fetch_one(&mut *tx).await.map_err(|_| "Cannot validate settlement batch sources")?;
            if invalid != 0 { return Err("Unverifiable owned settlement batch".into()); }
            sqlx::query(
                "SELECT i.id AS inventory_id,i.id,i.batch_number,i.expiry_date,
                   CAST(i.quantity AS REAL) AS quantity,CAST(i.cost_price AS REAL) AS cost_price
                 FROM main.inventory i JOIN main.master_drugs m ON m.id=i.drug_id
                 WHERE i.drug_id=? AND i.pharmacy_id=? AND i.quantity>0
                   AND COALESCE(i.batch_number,'') NOT LIKE 'RET-%'
                   AND (COALESCE(m.has_expiry,1)=0 OR i.expiry_date IS NOT NULL)
                   AND (i.expiry_date IS NULL OR i.expiry_date>=DATE('now','localtime'))
                 ORDER BY CASE WHEN i.expiry_date IS NULL THEN 1 ELSE 0 END,
                   i.expiry_date ASC,i.created_at ASC,i.id ASC LIMIT 101",
            ).bind(selected).bind(&pharmacy_id).fetch_all(&mut *tx)
             .await.map_err(|_| "Native settlement batches unavailable")?
        };
        if rows.len() > MAX_RESULTS { return Err("Settlement projection exceeds fixed bound".into()); }
        let mut results = Vec::with_capacity(rows.len());
        for row in rows {
            if query_id == "unsettled_sales" {
                let item_id: i64 = row.try_get("item_id").map_err(|_| "Invalid sale line id")?;
                let invoice_id: String = row.try_get("invoice_id").map_err(|_| "Invalid sale invoice")?;
                let drug_id: i64 = row.try_get("drug_id").map_err(|_| "Invalid sale drug")?;
                let quantity_sold: f64 = row.try_get("quantity_sold").map_err(|_| "Invalid sale qty")?;
                let returned: f64 = row.try_get("returned_quantity").map_err(|_| "Invalid return qty")?;
                let net: f64 = row.try_get("net_unreturned_quantity").map_err(|_| "Invalid net qty")?;
                let stock: f64 = row.try_get("current_stock_balance").map_err(|_| "Invalid stock balance")?;
                let price: f64 = row.try_get("unit_price").map_err(|_| "Invalid sale price")?;
                let unit: String = row.try_get("unit").map_err(|_| "Invalid sale unit")?;
                let name: String = row.try_get("trade_name").map_err(|_| "Invalid drug name")?;
                let name_en: Option<String> = row.try_get("trade_name_en").map_err(|_| "Invalid drug name")?;
                let created: Option<String> = row.try_get("created_at").map_err(|_| "Invalid date")?;
                if item_id <= 0 || drug_id <= 0 || !safe_text(&invoice_id,128) ||
                    !safe_text(&unit,64) || !safe_text(&name,512) ||
                    name_en.as_ref().is_some_and(|n| !safe_text(n,512)) ||
                    created.as_ref().is_some_and(|n| n.len()>80 || n.chars().any(char::is_control)) ||
                    !finite_nonnegative(price) || !finite_nonnegative(stock) ||
                    !finite_nonnegative(quantity_sold) || quantity_sold==0.0 ||
                    !finite_nonnegative(returned) || returned>quantity_sold ||
                    !finite_nonnegative(net) || (net-(quantity_sold-returned)).abs()>1e-6 {
                    return Err("Invalid certified negative sale source".into());
                }
                results.push(json!({"item_id":item_id,"invoice_id":invoice_id,"drug_id":drug_id,
                  "quantity_sold":quantity_sold,"returned_quantity":returned,"net_unreturned_quantity":net,
                  "unit":unit,"unit_price":price,"trade_name":name,"trade_name_en":name_en,
                  "sale_date":created,"created_at":created,"current_stock_balance":stock}));
            } else {
                let id: String = row.try_get("inventory_id").map_err(|_| "Invalid lot identity")?;
                let batch: Option<String> = row.try_get("batch_number").map_err(|_| "Invalid batch")?;
                let expiry: Option<String> = row.try_get("expiry_date").map_err(|_| "Invalid expiry")?;
                let quantity: f64 = row.try_get("quantity").map_err(|_| "Invalid lot qty")?;
                let cost: f64 = row.try_get("cost_price").map_err(|_| "Invalid lot cost")?;
                if !safe_text(&id,128) || batch.as_ref().is_some_and(|b| b.len()>128 || b.chars().any(char::is_control)) ||
                    expiry.as_ref().is_some_and(|e| e.len()>40 || e.chars().any(char::is_control)) ||
                    !finite_nonnegative(quantity) || quantity==0.0 || !finite_nonnegative(cost) {
                    return Err("Invalid certified settlement lot source".into());
                }
                results.push(json!({"id":id,"inventory_id":id,"batch_number":batch,
                  "expiry_date":expiry,"quantity":quantity,"cost_price":cost}));
            }
        }
        Ok(SettlementProjection {actor_id:actor.to_owned(), pharmacy_id,rows:results})
    }.await;
    match result {
        Ok(rows) => {
            tx.commit()
                .await
                .map_err(|_| "Cannot commit settlement read snapshot")?;
            Ok(rows)
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn read_settlement_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    query_id: String,
    drug_id: Option<i64>,
) -> Result<SettlementProjection, String> {
    let actor = session
        .authorize_session()
        .await?
        .clone()
        .ok_or_else(|| "Authenticated native settlement required".to_owned())?
        .clone();
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or_else(|| "Native database not yet initialized".to_owned())?;
    let mut conn = pool
        .0
        .acquire()
        .await
        .map_err(|_| "Native settlement database unavailable")?;
    project(&mut conn, &actor, &query_id, drug_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    async fn certified_fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE users(id TEXT,role TEXT,pharmacy_id TEXT,permissions TEXT,is_active INTEGER);
             CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,pharmacy_id TEXT,status TEXT,created_at TEXT);
             CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,drug_id INTEGER,
                quantity_sold REAL,unit TEXT,unit_price REAL,is_negative INTEGER,
                large_to_medium INTEGER,medium_to_small INTEGER);
             CREATE TABLE native_sale_cogs_provenance(sale_id TEXT,pharmacy_id TEXT);
             CREATE TABLE returns(id TEXT,invoice_id TEXT,pharmacy_id TEXT,status TEXT);
             CREATE TABLE return_items(return_id TEXT,sale_item_id INTEGER,quantity_returned REAL,unit TEXT);
             CREATE TABLE native_sale_return_cogs_provenance(return_id TEXT,sale_id TEXT,pharmacy_id TEXT);
             CREATE TABLE master_drugs(id INTEGER,trade_name TEXT,trade_name_en TEXT,
                medium_unit TEXT,small_unit TEXT,has_expiry INTEGER);
             CREATE TABLE inventory(id TEXT,drug_id INTEGER,pharmacy_id TEXT,
                quantity REAL,cost_price REAL,expiry_date TEXT,batch_number TEXT,created_at TEXT);
             INSERT INTO users VALUES
               ('owner-a','owner','tenant-a','[]',1),
               ('owner-b','owner','tenant-b','[]',1),
               ('old','owner','local_default','[]',1),
               ('viewer','cashier','tenant-a','[]',1);
             INSERT INTO sales_invoices VALUES
               ('owned-a','tenant-a','completed','2026-10-17'),
               ('other-b','tenant-b','completed','2026-10-17');
             INSERT INTO sales_items VALUES
               (1,'owned-a',31,3,'large',4,1,1,1),
               (2,'other-b',42,15,'large',22,1,1,1);
             INSERT INTO native_sale_cogs_provenance VALUES
               ('owned-a','tenant-a'),('other-b','tenant-b');
             INSERT INTO master_drugs VALUES
               (31,'Owned catalog item','owned',NULL,NULL,1),
               (42,'Foreign catalog item','foreign',NULL,NULL,1);
             INSERT INTO inventory VALUES
               ('owned-batch',31,'tenant-a',5,2,'2099-10-16','OWNED','2026-10-16'),
               ('foreign-batch',42,'tenant-b',8,10,'2099-10-16','FOREIGN','2026-10-16');",
        ).execute(&mut conn).await.unwrap();
        conn
    }

    #[tokio::test]
    async fn tenant_scoped_negative_sales_and_batches_only_from_sealed_origin() {
        let mut conn = certified_fixture().await;
        let a = project(&mut conn, "owner-a", "unsettled_sales", None)
            .await
            .unwrap();
        assert_eq!(a.pharmacy_id, "tenant-a");
        assert_eq!(a.rows.len(), 1);
        assert_eq!(a.rows[0]["item_id"], 1);
        assert_eq!(a.rows[0]["net_unreturned_quantity"], 3.0);
        assert_eq!(a.rows[0]["current_stock_balance"], 5.0);
        let b = project(&mut conn, "owner-b", "unsettled_sales", None)
            .await
            .unwrap();
        assert_eq!(b.rows.len(), 1);
        assert_eq!(b.rows[0]["item_id"], 2);
        assert_eq!(b.rows[0]["current_stock_balance"], 8.0);
        let batches = project(&mut conn, "owner-a", "drug_batches", Some(31))
            .await
            .unwrap();
        assert_eq!(batches.rows.len(), 1);
        assert_eq!(batches.rows[0]["inventory_id"], "owned-batch");
        assert_eq!(batches.rows[0]["cost_price"], 2.0);
        assert!(project(&mut conn, "owner-a", "drug_batches", Some(42))
            .await
            .is_err());
        assert!(project(&mut conn, "old", "unsettled_sales", None)
            .await
            .is_err());
        assert!(project(&mut conn, "viewer", "unsettled_sales", None)
            .await
            .is_err());
        sqlx::query("DELETE FROM native_sale_cogs_provenance WHERE sale_id='owned-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(project(&mut conn, "owner-a", "unsettled_sales", None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn source_verified_partial_return_reconciles_and_unreceipted_return_denies() {
        let mut conn = certified_fixture().await;
        sqlx::raw_sql(
            "INSERT INTO returns VALUES('approved','owned-a','tenant-a','approved');
             INSERT INTO return_items VALUES('approved',1,1,'large');
             INSERT INTO native_sale_return_cogs_provenance VALUES('approved','owned-a','tenant-a');",
        ).execute(&mut conn).await.unwrap();
        let result = project(&mut conn, "owner-a", "unsettled_sales", None)
            .await
            .unwrap();
        assert_eq!(result.rows[0]["returned_quantity"], 1.0);
        assert_eq!(result.rows[0]["net_unreturned_quantity"], 2.0);
        sqlx::query("DELETE FROM native_sale_return_cogs_provenance WHERE return_id='approved'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(project(&mut conn, "owner-a", "unsettled_sales", None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn native_settlement_rejects_invalid_reads_without_sql_or_owner_claims() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for (kind, id) in [
            ("bad-query", None),
            ("unsettled_sales", Some(1)),
            ("drug_batches", None),
            ("drug_batches", Some(0)),
        ] {
            assert!(project(&mut conn, "owner", kind, id).await.is_err());
        }
    }

    #[test]
    fn native_settlement_rejects_corrupt_numeric_sources() {
        for n in [-1.0, f64::NAN, f64::INFINITY, 1.0e15] {
            assert!(!finite_nonnegative(n));
        }
    }
}
