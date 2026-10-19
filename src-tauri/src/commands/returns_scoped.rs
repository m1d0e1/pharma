//! Native, tenant-bound returnable sales invoice date list and text search.
//! Renderer supplies only a date/search filter. Actor, permission and tenant
//! are established from the native session and live users row on every call.

use serde_json::{json, Value};
use sqlx::{Row, SqliteConnection};
use std::time::Duration;
use tauri::{Manager, State};

use super::auth::LocalSessionState;
use super::critical::{active_generic_actor, GuardedReadPool};
use super::guarded_read::{fetch_scoped_limited, reset_cancelled_read_state, ReadLimits};
use super::permission_policy::user_has_permission;

fn valid_business_date(value: &str) -> bool {
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
    year != 0 && day != 0 && day <= days
}

fn valid_invoice_id(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 128
        // Historic invoices may contain Arabic, slash, colon or spaces.
        // Only reject control characters and dangerous SQL delimiters.
        && value.chars().all(|c| !c.is_control() && !matches!(c, '\'' | '"' | ';' | '`'))
}


async fn query_returnable_invoices(
    conn: &mut SqliteConnection,
    actor_id: &str,
    date: &str,
) -> Result<Vec<Value>, String> {
    if !valid_business_date(date) {
        return Err("Invalid return invoice calendar date".into());
    }
    let pharmacy_id=authorized_return_reader(conn,actor_id).await?;
    read_verified_returnable(conn,&pharmacy_id,None,Some(date),None).await
}

// Date list and search share one strict forward-only 043 sale/return witness,
// explicitly owned inventory and 061-owned patient directory projection. An
// incomplete matched sale blocks the entire result, never masquerades as zero.
const RETURNABLE_SEARCH_SQL: &str = r#"
 SELECT s.id,s.patient_id,s.status,s.total_amount,s.created_at,s.payment_method,
        staff.full_name AS user_name,patient.full_name AS patient_name,
        CASE WHEN s.status='completed'
          AND typeof(s.total_amount) IN ('integer','real') AND s.total_amount>=0
          AND staff.id IS NOT NULL
          AND (s.patient_id IS NULL OR patient_owner.patient_id IS NOT NULL)
          AND EXISTS (
            SELECT 1 FROM main.native_sale_cogs_provenance proof
            JOIN main.daily_journals journal ON journal.id=proof.journal_id
              AND journal.pharmacy_id=s.pharmacy_id
              AND CAST(journal.created_by AS TEXT)=proof.actor_id
              AND ABS(journal.total_amount*1000000-(proof.sale_micros+proof.cogs_micros))<2
            WHERE proof.sale_id=s.id AND proof.pharmacy_id=s.pharmacy_id
              AND proof.actor_id=CAST(s.user_id AS TEXT)
              AND proof.payment_method=s.payment_method
              AND ABS(proof.sale_micros-s.total_amount*1000000)<2
              AND proof.line_count>0 AND proof.line_count=(
                SELECT COUNT(*) FROM main.sales_items WHERE invoice_id=s.id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM main.sales_items line
            LEFT JOIN main.inventory lot ON lot.id=line.inventory_id
              AND lot.pharmacy_id=s.pharmacy_id AND lot.drug_id=line.drug_id
            LEFT JOIN main.master_drugs drug ON drug.id=line.drug_id
            WHERE line.invoice_id=s.id AND (line.inventory_id IS NULL OR lot.id IS NULL
              OR drug.id IS NULL OR typeof(line.quantity_sold) NOT IN ('integer','real')
              OR line.quantity_sold<=0 OR typeof(line.unit_price) NOT IN ('integer','real')
              OR line.unit_price<0)
          )
          AND NOT EXISTS (
            SELECT 1 FROM main.returns r
            LEFT JOIN main.native_sale_return_cogs_provenance proof
              ON proof.return_id=r.id AND proof.sale_id=s.id
              AND proof.pharmacy_id=s.pharmacy_id
              AND proof.actor_id=CAST(r.user_id AS TEXT)
              AND proof.refund_method=r.refund_method
              AND ABS(proof.refund_micros-r.total_refund*1000000)<2
              AND proof.line_count>0 AND proof.line_count=(
                SELECT COUNT(*) FROM main.return_items WHERE return_id=r.id)
            LEFT JOIN main.daily_journals journal ON journal.id=proof.journal_id
              AND journal.pharmacy_id=s.pharmacy_id
              AND CAST(journal.created_by AS TEXT)=proof.actor_id
              AND ABS(journal.total_amount*1000000-(proof.refund_micros+proof.cogs_micros))<2
            WHERE r.invoice_id=s.id AND (r.pharmacy_id IS NULL OR r.pharmacy_id<>s.pharmacy_id
              OR (LOWER(COALESCE(r.status,'')) IN ('approved','completed')
                  AND (proof.return_id IS NULL OR journal.id IS NULL
                    OR typeof(r.total_refund) NOT IN ('integer','real') OR r.total_refund<0)))
          )
          AND NOT EXISTS (
            SELECT 1 FROM main.return_items line
            JOIN main.returns r ON r.id=line.return_id
            LEFT JOIN main.sales_items sold ON sold.id=line.sale_item_id
              AND sold.invoice_id=s.id
            LEFT JOIN main.inventory lot ON lot.id=line.inventory_id
              AND lot.pharmacy_id=s.pharmacy_id AND lot.drug_id=line.drug_id
            WHERE r.invoice_id=s.id AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
              AND (sold.id IS NULL OR lot.id IS NULL OR sold.inventory_id<>line.inventory_id
                   OR sold.drug_id<>line.drug_id
                   OR typeof(line.quantity_returned) NOT IN ('integer','real')
                   OR line.quantity_returned<=0 OR line.unit IS NULL OR TRIM(line.unit)='')
          )
        THEN 1 ELSE 0 END AS provenance_ok,
        CASE WHEN EXISTS (
          SELECT 1 FROM main.sales_items sold
          JOIN main.inventory lot ON lot.id=sold.inventory_id
            AND lot.pharmacy_id=s.pharmacy_id AND lot.drug_id=sold.drug_id
          JOIN main.master_drugs drug ON drug.id=sold.drug_id
          WHERE sold.invoice_id=s.id AND sold.quantity_sold>COALESCE((
            SELECT SUM((CASE
              WHEN LOWER(TRIM(COALESCE(NULLIF(TRIM(line.unit),''),sold.unit,'large')))
                   IN ('medium','strip','شريط')
                OR LOWER(TRIM(COALESCE(NULLIF(TRIM(line.unit),''),sold.unit,'large')))
                   =LOWER(TRIM(COALESCE(drug.medium_unit,'')))
              THEN CAST(line.quantity_returned AS REAL)/COALESCE(
                NULLIF(sold.large_to_medium,0),NULLIF(lot.strips_per_box,0),
                NULLIF(drug.large_to_medium,0),1)
              WHEN LOWER(TRIM(COALESCE(NULLIF(TRIM(line.unit),''),sold.unit,'large')))
                   IN ('small','unit','pill')
                OR LOWER(TRIM(COALESCE(NULLIF(TRIM(line.unit),''),sold.unit,'large')))
                   =LOWER(TRIM(COALESCE(drug.small_unit,'')))
              THEN CAST(line.quantity_returned AS REAL)/(
                COALESCE(NULLIF(sold.large_to_medium,0),NULLIF(lot.strips_per_box,0),
                         NULLIF(drug.large_to_medium,0),1)
                * COALESCE(NULLIF(sold.medium_to_small,0),NULLIF(lot.medium_to_small,0),
                           NULLIF(drug.medium_to_small,0),1))
              ELSE CAST(line.quantity_returned AS REAL) END)
              * CASE
                WHEN LOWER(TRIM(COALESCE(sold.unit,'large'))) IN ('medium','strip','شريط')
                  OR LOWER(TRIM(COALESCE(sold.unit,'large')))=LOWER(TRIM(COALESCE(drug.medium_unit,'')))
                THEN COALESCE(NULLIF(sold.large_to_medium,0),NULLIF(lot.strips_per_box,0),
                              NULLIF(drug.large_to_medium,0),1)
                WHEN LOWER(TRIM(COALESCE(sold.unit,'large'))) IN ('small','unit','pill')
                  OR LOWER(TRIM(COALESCE(sold.unit,'large')))=LOWER(TRIM(COALESCE(drug.small_unit,'')))
                THEN COALESCE(NULLIF(sold.large_to_medium,0),NULLIF(lot.strips_per_box,0),
                              NULLIF(drug.large_to_medium,0),1)
                     * COALESCE(NULLIF(sold.medium_to_small,0),NULLIF(lot.medium_to_small,0),
                                NULLIF(drug.medium_to_small,0),1)
                ELSE 1 END)
            FROM main.return_items line
            JOIN main.returns r ON r.id=line.return_id
            WHERE line.sale_item_id=sold.id AND r.invoice_id=s.id
              AND r.pharmacy_id=s.pharmacy_id
              AND LOWER(COALESCE(r.status,'')) IN ('approved','completed')
          ),0)
        ) THEN 1 ELSE 0 END AS has_remaining
 FROM main.sales_invoices s
 LEFT JOIN main.users staff ON CAST(staff.id AS TEXT)=CAST(s.user_id AS TEXT)
   AND staff.pharmacy_id=s.pharmacy_id
 LEFT JOIN main.native_patient_directory_ownership patient_owner
   ON patient_owner.patient_id=s.patient_id AND patient_owner.pharmacy_id=s.pharmacy_id
 LEFT JOIN main.patients patient ON patient.id=patient_owner.patient_id
 WHERE s.pharmacy_id=?
   AND (s.status IS NULL OR s.status<>'draft')
   AND (? IS NULL OR datetime(s.created_at)>=datetime('now','-' || ? || ' days'))
   AND (? IS NULL OR date(s.created_at,'localtime')=?)
   AND (?=0 OR (s.id LIKE ? ESCAPE '\' OR patient.full_name LIKE ? ESCAPE '\'
     OR EXISTS (
       SELECT 1 FROM main.sales_items line
       LEFT JOIN main.inventory lot ON lot.id=line.inventory_id
         AND lot.pharmacy_id=s.pharmacy_id
       LEFT JOIN main.master_drugs drug ON drug.id=line.drug_id
       WHERE line.invoice_id=s.id AND (
         drug.trade_name LIKE ? ESCAPE '\' OR drug.trade_name_en LIKE ? ESCAPE '\'
         OR drug.active_ingredient LIKE ? ESCAPE '\'
         OR drug.barcode LIKE ? ESCAPE '\' OR lot.barcode LIKE ? ESCAPE '\'
         OR CAST(drug.id AS TEXT)=?
       )
     )))
 ORDER BY s.created_at DESC,s.id DESC
 LIMIT CASE WHEN ?=1 THEN 101 ELSE 10001 END
"#;

async fn authorized_return_reader(conn: &mut SqliteConnection,actor_id: &str) -> Result<String,String> {
    reset_cancelled_read_state(conn).await?;
    let (role, pharmacy_id) = active_generic_actor(conn, actor_id).await?;
    let actor = sqlx::query(
        "SELECT pharmacy_id,permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1",
    ).bind(actor_id).fetch_one(&mut *conn).await.map_err(|e|e.to_string())?;
    let explicit_pharmacy: Option<String> = actor.try_get("pharmacy_id").map_err(|e|e.to_string())?;
    let permissions: Option<String> = actor.try_get("permissions").map_err(|e|e.to_string())?;
    if pharmacy_id=="local_default" || explicit_pharmacy.as_deref()!=Some(pharmacy_id.as_str()) {
        return Err("Native return search requires an explicitly owned tenant".into());
    }
    if !user_has_permission(Some(&role),permissions.as_deref(),"can_view_returns",false) {
        return Err("Authenticated user cannot search sale returns".into());
    }
    Ok(pharmacy_id)
}

async fn read_verified_returnable(
    conn: &mut SqliteConnection,
    pharmacy_id: &str,
    days: Option<u32>,
    date: Option<&str>,
    search: Option<&str>,
) -> Result<Vec<Value>,String> {
    let search_mode=search.is_some();
    let mut escaped=String::new();
    for c in search.unwrap_or_default().chars() {
        if matches!(c,'%'|'_'|'\\') { escaped.push('\\'); }
        escaped.push(c);
    }
    let wildcard=format!("%{escaped}%");
    let max_rows=if search_mode {101}else{10001};
    let matches=fetch_scoped_limited(
        conn, RETURNABLE_SEARCH_SQL,
        vec![
            json!(pharmacy_id),json!(days),json!(days),json!(date),json!(date),
            json!(i32::from(search_mode)),
            json!(wildcard),json!(wildcard),json!(wildcard),json!(wildcard),
            json!(wildcard),json!(wildcard),json!(wildcard),json!(search),
            json!(i32::from(search_mode)),
        ],
        ReadLimits {max_duration:Duration::from_secs(8),max_rows,max_bytes:16*1024*1024},
    ).await?;
    if matches.len()>=max_rows {
        return Err("Native return invoice list exceeds its safety limit".into());
    }
    let mut eligible=Vec::new();
    for mut invoice in matches {
        if invoice.get("id").and_then(Value::as_str).map_or(true,|id|!valid_invoice_id(id))
            || invoice.get("provenance_ok").and_then(Value::as_i64)!=Some(1)
        {
            return Err("Matched sale has unverified 043 provenance or tenant ownership".into());
        }
        let remaining=invoice.get("has_remaining").and_then(Value::as_i64);
        if !matches!(remaining,Some(0)|Some(1)) {
            return Err("Native return search has an invalid stock remainder".into());
        }
        if remaining==Some(1) {
            if let Some(fields)=invoice.as_object_mut() {
                fields.remove("provenance_ok");
                fields.remove("has_remaining");
            }
            eligible.push(invoice);
        }
    }
    Ok(eligible)
}

async fn query_returnable_search(
    conn: &mut SqliteConnection,
    actor_id: &str,
    search_term: &str,
    days: Option<u32>,
) -> Result<Vec<Value>, String> {
    let term=search_term.trim();
    if term.is_empty() || term.len()>128 || term.chars().any(char::is_control)
        || days.is_some_and(|window| !(1..=3650).contains(&window)) {
        return Err("Invalid native sales return search term or date window".into());
    }
    let pharmacy_id=authorized_return_reader(conn,actor_id).await?;
    read_verified_returnable(conn,&pharmacy_id,days,None,Some(term)).await
}

#[tauri::command]
pub async fn search_returnable_sales_invoices_native(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    search_term: String,
    days: Option<u32>,
) -> Result<Vec<Value>, String> {
    let actor=session.authorize_session().await?;
    let pool=app.try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn=pool.0.acquire().await.map_err(|e|e.to_string())?;
    query_returnable_search(&mut conn,actor.as_deref().unwrap(),&search_term,days).await
}

#[tauri::command]
pub async fn list_returnable_sales_invoices_by_date(
    app: tauri::AppHandle,
    session: State<'_, LocalSessionState>,
    date: String,
) -> Result<Vec<Value>, String> {
    let actor = session.authorize_session().await?;
    let pool = app
        .try_state::<GuardedReadPool>()
        .ok_or("Database initialization has not completed")?;
    let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
    query_returnable_invoices(&mut conn, actor.as_deref().unwrap(), &date).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    async fn fixture() -> SqliteConnection {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY, role TEXT, permissions TEXT,
                               pharmacy_id TEXT, is_active INTEGER, full_name TEXT);
            CREATE TABLE patients(id TEXT PRIMARY KEY, full_name TEXT);
            CREATE TABLE native_patient_directory_ownership(patient_id TEXT PRIMARY KEY,pharmacy_id TEXT);
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY, patient_id TEXT, user_id TEXT,
                pharmacy_id TEXT, total_amount REAL, payment_method TEXT, status TEXT, created_at TEXT);
            CREATE TABLE inventory(id TEXT PRIMARY KEY, pharmacy_id TEXT, strips_per_box REAL,
                                   medium_to_small REAL,drug_id INTEGER,barcode TEXT);
            CREATE TABLE master_drugs(id INTEGER PRIMARY KEY, medium_unit TEXT, small_unit TEXT,
                                      large_to_medium REAL, medium_to_small REAL,
                                      trade_name TEXT,trade_name_en TEXT,active_ingredient TEXT,barcode TEXT);
            CREATE TABLE sales_items(id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT,
                drug_id INTEGER, quantity_sold REAL, unit TEXT, large_to_medium REAL,
                medium_to_small REAL,unit_price REAL);
            CREATE TABLE returns(id TEXT PRIMARY KEY, invoice_id TEXT, pharmacy_id TEXT, status TEXT,
                user_id TEXT,refund_method TEXT,total_refund REAL);
            CREATE TABLE return_items(id INTEGER PRIMARY KEY, return_id TEXT, sale_item_id INTEGER,
                quantity_returned REAL, unit TEXT,inventory_id TEXT,drug_id INTEGER);
            CREATE TABLE daily_journals(id TEXT PRIMARY KEY,pharmacy_id TEXT,created_by TEXT,total_amount REAL);
            CREATE TABLE native_sale_cogs_provenance(sale_id TEXT PRIMARY KEY,pharmacy_id TEXT,
                actor_id TEXT,payment_method TEXT,journal_id TEXT,sale_micros INTEGER,
                cogs_micros INTEGER,line_count INTEGER);
            CREATE TABLE native_sale_return_cogs_provenance(return_id TEXT PRIMARY KEY,sale_id TEXT,
                pharmacy_id TEXT,actor_id TEXT,refund_method TEXT,journal_id TEXT,
                refund_micros INTEGER,cogs_micros INTEGER,line_count INTEGER);
        "#).execute(&mut conn).await.unwrap();
        sqlx::raw_sql(r#"
            INSERT INTO users VALUES
              ('owner-a','owner','{}','ph-a',1,'Owner A'),
              ('returns-a','cashier','{"can_view_returns":true}','ph-a',1,'Returns A'),
              ('denied-a','cashier','{"can_view_returns":false}','ph-a',1,'Denied A'),
              ('inactive-a','owner','{}','ph-a',0,'Inactive A'),
              ('returns-b','cashier','{"can_view_returns":true}','ph-b',1,'Returns B'),
              ('local','owner','{}',NULL,1,'Default Owner');
            INSERT INTO patients VALUES ('patient-1','Patient One'),('patient-b','Patient B');
            INSERT INTO native_patient_directory_ownership VALUES('patient-1','ph-a'),('patient-b','ph-b');
            INSERT INTO inventory VALUES
              ('lot-a','ph-a',10,2,1,'a-lot'),
              ('lot-b','ph-b',10,2,1,'b-lot'),
              ('lot-local',NULL,10,2,1,'local-lot');
            INSERT INTO master_drugs VALUES(1,'strip','pill',10,2,'Paracetamol',NULL,NULL,'code-1');
            INSERT INTO sales_invoices VALUES
              ('invoice-a','patient-1','returns-a','ph-a',100,'cash','completed','2026-10-10 12:00:00'),
              ('invoice-b','patient-b','returns-b','ph-b',100,'cash','completed','2026-10-10 11:00:00'),
              ('invoice-local',NULL,'local',NULL,20,'cash','delivered','2026-10-10 10:00:00'),
              ('invoice-draft',NULL,'returns-a','ph-a',40,'cash','draft','2026-10-10 13:00:00');
            INSERT INTO sales_items VALUES
              (1,'invoice-a','lot-a',1,10,'small',10,2,10),
              (2,'invoice-b','lot-b',1,10,'small',10,2,10),
              (3,'invoice-local','lot-local',1,1,'large',10,2,20),
              (4,'invoice-draft','lot-a',1,2,'large',10,2,20);
            INSERT INTO returns VALUES('returned-a','invoice-a','ph-a','approved','returns-a','cash',20);
            INSERT INTO return_items VALUES(1,'returned-a',1,2,'medium','lot-a',1);
            INSERT INTO daily_journals VALUES
                ('j-sale-a','ph-a','returns-a',100),
                ('j-sale-b','ph-b','returns-b',100),
                ('j-return-a','ph-a','returns-a',20);
            INSERT INTO native_sale_cogs_provenance VALUES
                ('invoice-a','ph-a','returns-a','cash','j-sale-a',100000000,0,1),
                ('invoice-b','ph-b','returns-b','cash','j-sale-b',100000000,0,1);
            INSERT INTO native_sale_return_cogs_provenance VALUES
                ('returned-a','invoice-a','ph-a','returns-a','cash','j-return-a',20000000,0,1);
        "#).execute(&mut conn).await.unwrap();
        conn
    }

    #[tokio::test]
    async fn tenant_isolation_role_denials_and_projection() {
        let mut conn = fixture().await;
        let a = query_returnable_invoices(&mut conn, "returns-a", "2026-10-10")
            .await
            .unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0]["id"], "invoice-a");
        assert_eq!(a[0]["user_name"], "Returns A");
        assert_eq!(a[0]["patient_name"], "Patient One");
        assert_eq!(a[0]["total_amount"].as_f64(), Some(100.0));
        assert_eq!(a[0]["status"], "completed");
        assert_eq!(a[0]["payment_method"], "cash");
        assert_eq!(a[0].as_object().unwrap().len(), 8);
        let b = query_returnable_invoices(&mut conn, "returns-b", "2026-10-10")
            .await
            .unwrap();
        assert_eq!(
            b.iter().map(|v| &v["id"]).collect::<Vec<_>>(),
            vec![&json!("invoice-b")]
        );
        assert!(query_returnable_invoices(&mut conn, "local", "2026-10-10")
            .await.is_err(),"legacy local_default cannot adopt unreceipted sales");
        assert!(
            query_returnable_invoices(&mut conn, "denied-a", "2026-10-10")
                .await
                .is_err()
        );
        assert!(
            query_returnable_invoices(&mut conn, "inactive-a", "2026-10-10")
                .await
                .is_err()
        );
        assert!(
            query_returnable_invoices(&mut conn, "unknown", "2026-10-10")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn finalized_return_units_and_statuses_retain_original_meaning() {
        let mut conn = fixture().await;
        // 2 medium units returned on a sale of 10 small units => 4 small.
        assert_eq!(
            query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
                .await
                .unwrap()
                .len(),
            1
        );
        sqlx::query("UPDATE return_items SET quantity_returned=5 WHERE id=1")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
                .await
                .unwrap()
                .is_empty()
        );
        sqlx::query("UPDATE returns SET status='pending' WHERE id='returned-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert_eq!(
            query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
                .await
                .unwrap()
                .len(),
            1
        );
        sqlx::query("UPDATE returns SET status='completed' WHERE id='returned-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
                .await
                .unwrap()
                .is_empty()
        );
        sqlx::query("UPDATE return_items SET quantity_returned=3,unit=NULL WHERE id=1")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
            .await.is_err(),"malformed finalized returns must block date list");
        sqlx::query("UPDATE return_items SET unit='   ' WHERE id=1")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
            .await.is_err(),"blank finalized return units must block date list");
        sqlx::query("UPDATE return_items SET unit='medium',quantity_returned=2 WHERE id=1")
            .execute(&mut conn).await.unwrap();
        sqlx::query("UPDATE sales_invoices SET status='approved' WHERE id='invoice-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
            .await.is_err(),"043 only seals completed sales");
        sqlx::query("UPDATE sales_invoices SET status='' WHERE id='invoice-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
            .await.is_err(),"legacy blank-status sources cannot masquerade as posted");
        sqlx::query("UPDATE sales_invoices SET status=NULL WHERE id='invoice-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
            .await.is_err(),"NULL-status sales cannot masquerade as posted");
    }

    #[tokio::test]
    async fn hostile_date_and_invoice_ids_fail_closed() {
        let mut conn = fixture().await;
        for date in [
            "2026-10-10' OR 1=1 --",
            "2026-02-30",
            "2026-10-10\0",
            "2026-1-1",
            "",
        ] {
            assert!(query_returnable_invoices(&mut conn, "owner-a", date)
                .await
                .is_err());
        }
        sqlx::query("UPDATE sales_invoices SET id=? WHERE id='invoice-a'")
            .bind("invoice-a' OR 1=1 --")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("UPDATE sales_items SET invoice_id=? WHERE id=1")
            .bind("invoice-a' OR 1=1 --")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(
            query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
                .await
                .is_err()
        );
        assert!(valid_invoice_id("فاتورة/2026: رقم ١٢٣"));
        assert!(valid_invoice_id("INV/2026-A 1"));
        assert!(!valid_invoice_id("INV'; DROP TABLE users; --"));
        assert!(!valid_invoice_id("id\0hidden"));
    }

    #[tokio::test]
    async fn foreign_user_and_inventory_links_cannot_expose_foreign_pharmacy() {
        let mut conn = fixture().await;
        sqlx::query("UPDATE sales_invoices SET user_id='returns-b' WHERE id='invoice-a'")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("UPDATE sales_items SET inventory_id='lot-b' WHERE id=1")
            .execute(&mut conn)
            .await
            .unwrap();
        // A forged foreign lot may not make an otherwise local invoice
        // eligible for return even though the sale/master drug exist.
        assert!(query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
            .await.is_err(),"foreign lot/actor contradictions must block rather than fake zero");
        sqlx::query("UPDATE sales_items SET inventory_id='lot-a' WHERE id=1")
            .execute(&mut conn)
            .await
            .unwrap();
        assert!(query_returnable_invoices(&mut conn,"owner-a","2026-10-10")
            .await.is_err(),"unowned actor mismatch cannot return an invoice");
        sqlx::query("UPDATE sales_invoices SET user_id='returns-a' WHERE id='invoice-a'")
            .execute(&mut conn).await.unwrap();
        let local = query_returnable_invoices(&mut conn, "owner-a", "2026-10-10")
            .await
            .unwrap();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0]["id"], "invoice-a");
        // The foreign actor was restored to returns-a above. Once the sealed
        // source and live staff tenant agree, the owned staff name is valid.
        assert_eq!(local[0]["user_name"], "Returns A");
    }

    #[tokio::test]
    async fn production_migration_chain_blocks_unreceipted_return_date_read() {
        // Exercise the full registered SQLx migration and legacy compatibility
        // sequence as native startup on a unique synthetic temp database.
        // Never load a bundled/customer database.
        let app_migrations = crate::app_migrations();
        assert_eq!(app_migrations.len(), 69);
        let migrator = sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(
                app_migrations
                    .into_iter()
                    .map(|entry| {
                        sqlx::migrate::Migration::new(
                            entry.version,
                            entry.description.into(),
                            sqlx::migrate::MigrationType::ReversibleUp,
                            entry.sql.into(),
                            false,
                        )
                    })
                    .collect(),
            ),
            ..sqlx::migrate::Migrator::DEFAULT
        };
        let path = std::env::temp_dir().join(format!(
            "pharma-returns-native-synthetic-{}.db",
            uuid::Uuid::new_v4()
        ));
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        let first = sqlx::migrate::Migrator {
            migrations: std::borrow::Cow::Owned(migrator.migrations[..1].to_vec()),
            ..sqlx::migrate::Migrator::DEFAULT
        };
        first.run(&mut conn).await.unwrap();
        conn.close().await.unwrap();
        // Registered v001 is historical to the public preparer. Confirm that
        // it is now refused, then use the test-only connection helper to set
        // up this NEW synthetic fixture; it is not customer authorization.
        let prepare_path = path.clone();
        let refused = tokio::task::spawn_blocking(move || crate::schema::prepare_legacy_database(&prepare_path))
            .await
            .unwrap();
        assert!(refused.is_err(), "Public v001 historic preparer must fail closed");
        let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
        crate::schema::prepare_registered_001_synthetic_test_connection(&mut conn)
            .await.unwrap();
        migrator.run(&mut conn).await.unwrap();
        sqlx::query(
            "INSERT INTO users(id,username,role,permissions,pharmacy_id,is_active) \
            VALUES('real-returns','real-returns','cashier','{\"can_view_returns\":true}','ph-a',1)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO master_drugs(id,trade_name,large_to_medium,medium_to_small) \
            VALUES(98765,'Synthetic',10,2)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO inventory(id,pharmacy_id,drug_id,quantity,strips_per_box) \
            VALUES('synthetic-lot','ph-a',98765,10,10)",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sales_invoices(id,user_id,pharmacy_id,total_amount,status,created_at) \
            VALUES('real-migrated-invoice','real-returns','ph-a',50,'completed','2026-10-10 10:00:00')")
            .execute(&mut conn).await.unwrap();
        sqlx::query(
            "INSERT INTO sales_items(invoice_id,inventory_id,drug_id,quantity_sold,unit) \
            VALUES('real-migrated-invoice','synthetic-lot',98765,1,'large')",
        )
        .execute(&mut conn)
        .await
        .unwrap();
        assert!(query_returnable_invoices(&mut conn,"real-returns","2026-10-10")
            .await.unwrap_err().contains("unverified 043"),
            "migrated legacy sale without 043 receipt cannot look returnable");
        conn.close().await.unwrap();
        std::fs::remove_file(path).unwrap();
    }

    // Synthetic memory-only sources; never connect a disposable QA or customer
    // database. Both the real forward 043 fields and tenant owners are present.
    async fn strict_search_fixture() -> SqliteConnection {
        let mut conn=SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,permissions TEXT,
                pharmacy_id TEXT,is_active INTEGER,full_name TEXT);
            CREATE TABLE patients(id TEXT PRIMARY KEY,full_name TEXT);
            CREATE TABLE native_patient_directory_ownership(patient_id TEXT PRIMARY KEY,pharmacy_id TEXT);
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,patient_id TEXT,user_id TEXT,
                pharmacy_id TEXT,total_amount REAL,payment_method TEXT,status TEXT,created_at TEXT);
            CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT,drug_id INTEGER,
                barcode TEXT,strips_per_box REAL,medium_to_small REAL);
            CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT,
                trade_name_en TEXT,active_ingredient TEXT,barcode TEXT,medium_unit TEXT,
                small_unit TEXT,large_to_medium REAL,medium_to_small REAL);
            CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,
                drug_id INTEGER,quantity_sold REAL,unit_price REAL,unit TEXT,
                large_to_medium REAL,medium_to_small REAL);
            CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,pharmacy_id TEXT,
                user_id TEXT,refund_method TEXT,status TEXT,total_refund REAL);
            CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT,sale_item_id INTEGER,
                inventory_id TEXT,drug_id INTEGER,quantity_returned REAL,unit TEXT);
            CREATE TABLE daily_journals(id TEXT PRIMARY KEY,pharmacy_id TEXT,created_by TEXT,total_amount REAL);
            CREATE TABLE native_sale_cogs_provenance(sale_id TEXT PRIMARY KEY,pharmacy_id TEXT,
                actor_id TEXT,payment_method TEXT,journal_id TEXT,sale_micros INTEGER,
                cogs_micros INTEGER,line_count INTEGER);
            CREATE TABLE native_sale_return_cogs_provenance(return_id TEXT PRIMARY KEY,sale_id TEXT,
                pharmacy_id TEXT,actor_id TEXT,refund_method TEXT,journal_id TEXT,
                refund_micros INTEGER,cogs_micros INTEGER,line_count INTEGER);
            INSERT INTO users VALUES
                ('owner-a','owner','{}','tenant-a',1,'Staff A'),
                ('owner-b','owner','{}','tenant-b',1,'Staff B'),
                ('denied-a','cashier','{"can_view_returns":false}','tenant-a',1,'Denied A'),
                ('inactive-a','owner','{}','tenant-a',0,'Inactive A'),
                ('legacy','owner','{}',NULL,1,'Legacy Owner'),
                ('alias','owner','{}','local_default',1,'Alias Owner');
            INSERT INTO patients VALUES
                ('patient-a','Owned Alice'),('patient-b','Foreign Bob'),
                ('patient-legacy','Unowned Patient');
            INSERT INTO native_patient_directory_ownership VALUES
                ('patient-a','tenant-a'),('patient-b','tenant-b');
            INSERT INTO master_drugs VALUES(132,'Panadol Extra','Panadol','paracetamol',
                '6221000999','strip','pill',10,2);
            INSERT INTO inventory VALUES
                ('lot-a','tenant-a',132,'LOT-OWNED-1',10,2),
                ('lot-b','tenant-b',132,'LOT-FOREIGN-1',10,2),
                ('lot-legacy',NULL,132,'LOT-LEGACY-1',10,2);
            INSERT INTO sales_invoices VALUES
                ('3726c3df-owned','patient-a','owner-a','tenant-a',40,'cash','completed','2026-10-17 09:30:00'),
                ('3726c3df-foreign','patient-b','owner-b','tenant-b',40,'cash','completed','2026-10-17 09:30:00'),
                ('3726c3df-legacy','patient-legacy','legacy',NULL,40,'cash','completed','2026-10-17 09:30:00');
            INSERT INTO sales_items VALUES
                (1,'3726c3df-owned','lot-a',132,4,10,'large',10,2),
                (2,'3726c3df-foreign','lot-b',132,4,10,'large',10,2),
                (3,'3726c3df-legacy','lot-legacy',132,4,10,'large',10,2);
            INSERT INTO daily_journals VALUES
                ('sale-journal-a','tenant-a','owner-a',60),
                ('sale-journal-b','tenant-b','owner-b',60);
            INSERT INTO native_sale_cogs_provenance VALUES
                ('3726c3df-owned','tenant-a','owner-a','cash','sale-journal-a',40000000,20000000,1),
                ('3726c3df-foreign','tenant-b','owner-b','cash','sale-journal-b',40000000,20000000,1);
        "#).execute(&mut conn).await.unwrap();
        conn
    }

    #[tokio::test]
    async fn search_043_sale_prefix_drug_barcode_patient_and_two_tenant_isolation() {
        let mut conn=strict_search_fixture().await;
        for term in ["3726c3df", "Panadol", "6221000999", "LOT-OWNED-1", "Owned Alice", "132"] {
            let found=query_returnable_search(&mut conn,"owner-a",term,None).await.unwrap();
            assert_eq!(found.len(),1,"expected one explicitly owned 043 sale for {term}");
            assert_eq!(found[0]["id"],"3726c3df-owned");
            assert_eq!(found[0]["patient_name"],"Owned Alice");
            assert!(found[0].get("provenance_ok").is_none());
            assert_eq!(found[0].as_object().unwrap().len(),8);
        }
        assert!(query_returnable_search(&mut conn,"owner-a","Foreign Bob",None)
            .await.unwrap().is_empty());
        assert!(query_returnable_search(&mut conn,"owner-a","LOT-FOREIGN",None)
            .await.unwrap().is_empty());
        let foreign=query_returnable_search(&mut conn,"owner-b","3726c3df",None).await.unwrap();
        assert_eq!(foreign.len(),1);
        assert_eq!(foreign[0]["id"],"3726c3df-foreign");
        assert_eq!(foreign[0]["patient_name"],"Foreign Bob");
        for actor in ["denied-a","inactive-a","legacy","alias","unknown"] {
            assert!(query_returnable_search(&mut conn,actor,"3726c3df",None)
                .await.is_err(),"{actor} must never adopt local_default or bypass permission");
        }
        assert!(query_returnable_search(&mut conn,"owner-a","%",None)
            .await.unwrap().is_empty(),"literal wildcard must be escaped");
        assert!(query_returnable_search(&mut conn,"owner-a","x",Some(0)).await.is_err());
        assert!(query_returnable_search(&mut conn,"owner-a","x",Some(3651)).await.is_err());
        assert!(query_returnable_search(&mut conn,"owner-a","x\0",None).await.is_err());
    }

    #[tokio::test]
    async fn search_rejects_orphan_043_sales_foreign_lots_and_unowned_patients() {
        let mut conn=strict_search_fixture().await;
        sqlx::raw_sql(r#"
            INSERT INTO sales_invoices VALUES
                ('orphan-043','patient-a','owner-a','tenant-a',30,'cash','completed','2026-10-17 09:31:00');
            INSERT INTO sales_items VALUES(4,'orphan-043','lot-a',132,3,10,'large',10,2);
        "#).execute(&mut conn).await.unwrap();
        let orphan=query_returnable_search(&mut conn,"owner-a","orphan-043",None).await;
        assert!(orphan.unwrap_err().contains("unverified 043"));

        sqlx::query("UPDATE sales_items SET inventory_id='lot-b' WHERE id=1")
            .execute(&mut conn).await.unwrap();
        assert!(query_returnable_search(&mut conn,"owner-a","3726c3df-owned",None)
            .await.unwrap_err().contains("provenance"));
        sqlx::query("UPDATE sales_items SET inventory_id='lot-a' WHERE id=1")
            .execute(&mut conn).await.unwrap();

        sqlx::query("UPDATE sales_invoices SET patient_id='patient-b' WHERE id='3726c3df-owned'")
            .execute(&mut conn).await.unwrap();
        assert!(query_returnable_search(&mut conn,"owner-a","3726c3df-owned",None)
            .await.unwrap_err().contains("provenance"));
        assert!(query_returnable_search(&mut conn,"owner-a","Foreign Bob",None)
            .await.unwrap().is_empty(),"foreign patient names must not match owned searches");
        sqlx::query("UPDATE sales_invoices SET patient_id='patient-legacy' WHERE id='3726c3df-owned'")
            .execute(&mut conn).await.unwrap();
        assert!(query_returnable_search(&mut conn,"owner-a","3726c3df-owned",None).await.is_err());
    }

    #[tokio::test]
    async fn search_requires_prior_return_043_receipt_and_remainder_in_original_sale_unit() {
        let mut conn=strict_search_fixture().await;
        sqlx::raw_sql(r#"
            INSERT INTO returns VALUES('ret-a','3726c3df-owned','tenant-a','owner-a',
                'cash','approved',10);
            INSERT INTO return_items VALUES(1,'ret-a',1,'lot-a',132,1,'large');
        "#).execute(&mut conn).await.unwrap();
        assert!(query_returnable_search(&mut conn,"owner-a","3726c3df-owned",None)
            .await.unwrap_err().contains("unverified 043"));
        sqlx::raw_sql(r#"
            INSERT INTO daily_journals VALUES('return-journal-a','tenant-a','owner-a',15);
            INSERT INTO native_sale_return_cogs_provenance VALUES
                ('ret-a','3726c3df-owned','tenant-a','owner-a','cash',
                 'return-journal-a',10000000,5000000,1);
        "#).execute(&mut conn).await.unwrap();
        assert_eq!(query_returnable_search(&mut conn,"owner-a","3726c3df-owned",None)
            .await.unwrap().len(),1);
        sqlx::query("UPDATE return_items SET quantity_returned=4 WHERE id=1")
            .execute(&mut conn).await.unwrap();
        assert!(query_returnable_search(&mut conn,"owner-a","3726c3df-owned",None)
            .await.unwrap().is_empty(),"fully returned invoice is not eligible");
        sqlx::query("UPDATE returns SET pharmacy_id='tenant-b' WHERE id='ret-a'")
            .execute(&mut conn).await.unwrap();
        assert!(query_returnable_search(&mut conn,"owner-a","3726c3df-owned",None)
            .await.is_err(),"foreign return references must block source");
    }

    #[tokio::test]
    async fn date_picker_requires_043_sale_and_owned_061_patient_without_legacy_aliases() {
        let mut conn=strict_search_fixture().await;
        let owned=query_returnable_invoices(&mut conn,"owner-a","2026-10-17").await.unwrap();
        assert_eq!(owned.len(),1);
        assert_eq!(owned[0]["id"],"3726c3df-owned");
        assert_eq!(owned[0]["patient_name"],"Owned Alice");
        assert_eq!(owned[0]["status"],"completed");
        assert_eq!(owned[0]["patient_id"],"patient-a");
        assert_eq!(owned[0].as_object().unwrap().len(),8);
        let foreign=query_returnable_invoices(&mut conn,"owner-b","2026-10-17").await.unwrap();
        assert_eq!(foreign.len(),1);
        assert_eq!(foreign[0]["id"],"3726c3df-foreign");
        assert_eq!(foreign[0]["patient_name"],"Foreign Bob");
        assert!(query_returnable_invoices(&mut conn,"legacy","2026-10-17")
            .await.is_err(),"NULL tenant cannot adopt the local_default directory");
        assert!(query_returnable_invoices(&mut conn,"alias","2026-10-17")
            .await.is_err(),"explicit local_default alias is not verified ownership");

        sqlx::query("UPDATE sales_invoices SET patient_id='patient-b' WHERE id='3726c3df-owned'")
            .execute(&mut conn).await.unwrap();
        assert!(query_returnable_invoices(&mut conn,"owner-a","2026-10-17")
            .await.unwrap_err().contains("unverified 043"),
            "foreign patient reference blocks the date list rather than exposing name");
        sqlx::query("UPDATE sales_invoices SET patient_id='patient-a' WHERE id='3726c3df-owned'")
            .execute(&mut conn).await.unwrap();
        sqlx::raw_sql(r#"
            INSERT INTO sales_invoices VALUES('orphan-date','patient-a','owner-a',
                'tenant-a',30,'cash','completed','2026-10-17 11:00:00');
            INSERT INTO sales_items VALUES(10,'orphan-date','lot-a',132,3,10,'large',10,2);
        "#).execute(&mut conn).await.unwrap();
        assert!(query_returnable_invoices(&mut conn,"owner-a","2026-10-17")
            .await.unwrap_err().contains("unverified 043"),
            "orphan tenant-owned sale must not silently disappear as a fake zero");
    }
}
