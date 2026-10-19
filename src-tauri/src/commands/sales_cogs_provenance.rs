//! Native sale/COGS and sale-return/COGS immutable source receipts.
//! Callers use the same BEGIN IMMEDIATE as stock, journal and customer money.
use serde_json::{json, Value};
use sqlx::{Row, Sqlite, Transaction};
use uuid::Uuid;

fn micros(value: f64) -> Result<i64, String> {
    if !value.is_finite() || !(0.0..=1_000_000_000_000.0).contains(&value) {
        return Err("Sale or COGS financial value is invalid".into());
    }
    let scaled = value * 1_000_000.0;
    if !scaled.is_finite() || scaled > 1_000_000_000_000_000_000.0 {
        return Err("Sale or COGS value exceeds financial receipt bounds".into());
    }
    Ok(scaled.round() as i64)
}

pub(crate) fn canonical_request_id(request_id: &str) -> Result<(), String> {
    let id = Uuid::parse_str(request_id).map_err(|_| "Financial request requires UUIDv4")?;
    if id.get_version_num() != 4 || id.to_string() != request_id {
        return Err("Financial request requires canonical UUIDv4".into());
    }
    Ok(())
}

async fn source_lines(
    tx: &mut Transaction<'_, Sqlite>,
    source_id: &str,
    pharmacy: &str,
    sales_return: bool,
) -> Result<(usize, String), String> {
    let sql = if sales_return {
        "SELECT ri.id,ri.inventory_id,ri.drug_id,ri.sale_item_id,
                CAST(ri.quantity_returned AS REAL) quantity_returned,
                ri.unit,CAST(ri.total_price AS REAL) total_price,
                si.invoice_id original_invoice,si.drug_id original_drug,
                CAST(si.cost_price AS REAL) cost_price,
                i.pharmacy_id lot_pharmacy,i.drug_id lot_drug
         FROM return_items ri
         JOIN returns r ON r.id=ri.return_id
         JOIN sales_items si ON si.id=ri.sale_item_id AND si.invoice_id=r.invoice_id
         LEFT JOIN inventory i ON i.id=ri.inventory_id
         WHERE ri.return_id=? ORDER BY ri.id LIMIT 201"
    } else {
        "SELECT si.id,si.inventory_id,si.drug_id,
                CAST(si.quantity_sold AS REAL) quantity_sold,
                CAST(si.unit_price AS REAL) unit_price,
                CAST(si.cost_price AS REAL) cost_price,
                si.unit,si.is_negative,
                CAST(si.large_to_medium AS REAL) large_to_medium,
                CAST(si.medium_to_small AS REAL) medium_to_small,
                i.pharmacy_id lot_pharmacy,i.drug_id lot_drug
         FROM sales_items si LEFT JOIN inventory i ON i.id=si.inventory_id
         WHERE si.invoice_id=? ORDER BY si.id LIMIT 201"
    };
    let rows = sqlx::query(sql)
        .bind(source_id)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    if rows.is_empty() || rows.len() > 200 {
        return Err("Financial source line count exceeds native bound".into());
    }
    let mut lines: Vec<Value> = Vec::with_capacity(rows.len());
    for row in rows {
        let inventory_id: Option<String> =
            row.try_get("inventory_id").map_err(|e| e.to_string())?;
        let drug_id: i64 = row.try_get("drug_id").map_err(|e| e.to_string())?;
        if sales_return {
            let sold_drug: i64 = row.try_get("original_drug").map_err(|e| e.to_string())?;
            if drug_id != sold_drug {
                return Err("Financial return line contradicts original sold drug".into());
            }
        }
        let stock_scope: Option<String> = row.try_get("lot_pharmacy").unwrap_or(None);
        let stock_drug: Option<i64> = row.try_get("lot_drug").unwrap_or(None);
        let negative = if sales_return {
            false
        } else {
            row.try_get::<i64, _>("is_negative").unwrap_or(0) != 0
        };
        if ((!sales_return && !negative) || inventory_id.is_some())
            && (stock_scope.as_deref() != Some(pharmacy) || stock_drug != Some(drug_id))
        {
            return Err("Financial source line claims foreign or missing inventory".into());
        }
        if !sales_return && negative && inventory_id.is_some() {
            return Err("Negative sale must not claim a stocked lot".into());
        }
        let quantity: f64 = if sales_return {
            row.try_get("quantity_returned")
                .map_err(|e| e.to_string())?
        } else {
            row.try_get("quantity_sold").map_err(|e| e.to_string())?
        };
        let cost: f64 = row.try_get("cost_price").map_err(|e| e.to_string())?;
        if !quantity.is_finite()
            || quantity <= 0.0
            || quantity > 1_000_000_000.0
            || !cost.is_finite()
            || cost < 0.0
            || cost > 1_000_000_000_000.0
        {
            return Err("Financial source contains unbounded cost or quantity".into());
        }
        let price: f64 = if sales_return {
            row.try_get("total_price").map_err(|e| e.to_string())?
        } else {
            row.try_get("unit_price").map_err(|e| e.to_string())?
        };
        if !price.is_finite() || !(0.0..=1_000_000_000_000.0).contains(&price) {
            return Err("Financial source contains unbounded selling value".into());
        }
        let mut witness = json!({
            "lineId": row.try_get::<i64,_>("id").map_err(|e|e.to_string())?,
            "inventoryId":inventory_id,"drugId":drug_id,"quantity":quantity,
            "costPerLarge":cost,"value":price,"negative":negative,
            "unit":row.try_get::<Option<String>,_>("unit").unwrap_or(None),
        });
        if sales_return {
            witness["originalSaleItemId"] = json!(row
                .try_get::<i64, _>("sale_item_id")
                .map_err(|e| e.to_string())?);
            witness["originalSaleId"] = json!(row
                .try_get::<String, _>("original_invoice")
                .map_err(|e| e.to_string())?);
        } else {
            witness["largeToMedium"] =
                json!(row.try_get::<f64, _>("large_to_medium").unwrap_or(1.0));
            witness["mediumToSmall"] =
                json!(row.try_get::<f64, _>("medium_to_small").unwrap_or(1.0));
        }
        lines.push(witness);
    }
    let json = serde_json::to_string(&lines).map_err(|e| e.to_string())?;
    if json.len() > 131_072 {
        return Err("Financial receipt source snapshot too large".into());
    }
    Ok((lines.len(), json))
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn record_sale(
    tx: &mut Transaction<'_, Sqlite>,
    request_id: &str,
    sale_id: &str,
    actor_id: &str,
    pharmacy: &str,
    method: &str,
    journal_id: &str,
    revenue: f64,
    cogs: f64,
) -> Result<(), String> {
    canonical_request_id(request_id)?;
    let (count, snapshot) = source_lines(tx, sale_id, pharmacy, false).await?;
    sqlx::query(
        "INSERT INTO native_sale_cogs_provenance
           (sale_id,request_id,pharmacy_id,actor_id,journal_id,payment_method,
            sale_micros,cogs_micros,line_count,line_snapshot)
         VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(sale_id)
    .bind(request_id)
    .bind(pharmacy)
    .bind(actor_id)
    .bind(journal_id)
    .bind(method)
    .bind(micros(revenue)?)
    .bind(micros(cogs)?)
    .bind(count as i64)
    .bind(snapshot)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("Native sale/COGS posting receipt rejected: {e}"))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn record_return(
    tx: &mut Transaction<'_, Sqlite>,
    request_id: &str,
    return_id: &str,
    sale_id: &str,
    actor_id: &str,
    pharmacy: &str,
    method: &str,
    journal_id: &str,
    refund: f64,
    cogs: f64,
) -> Result<(), String> {
    canonical_request_id(request_id)?;
    let (count, snapshot) = source_lines(tx, return_id, pharmacy, true).await?;
    sqlx::query(
        "INSERT INTO native_sale_return_cogs_provenance
           (return_id,request_id,sale_id,pharmacy_id,actor_id,journal_id,refund_method,
            refund_micros,cogs_micros,line_count,line_snapshot)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(return_id)
    .bind(request_id)
    .bind(sale_id)
    .bind(pharmacy)
    .bind(actor_id)
    .bind(journal_id)
    .bind(method)
    .bind(micros(refund)?)
    .bind(micros(cogs)?)
    .bind(count as i64)
    .bind(snapshot)
    .execute(&mut **tx)
    .await
    .map_err(|e| format!("Native sales return/COGS reversal receipt rejected: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor, SqliteConnection};
    #[test]
    fn replay_nonce_is_canonical_and_money_has_bounded_micro_precision() {
        let good = Uuid::new_v4().to_string();
        assert!(canonical_request_id(&good).is_ok());
        for id in ["", "not-a-uuid", "00000000-0000-0000-0000-000000000000"] {
            assert!(canonical_request_id(id).is_err());
        }
        assert!(micros(f64::NAN).is_err());
        assert!(micros(-1.0).is_err());
        assert_eq!(micros(1.234567).unwrap(), 1_234_567);
    }

    #[tokio::test]
    async fn receipted_return_requires_the_original_sold_drug_not_just_a_local_lot() {
        // Disposable in-memory 043 schema and native posting receipts. No app
        // handle, live database, signed IPC or persistent patient record.
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        db.execute("PRAGMA foreign_keys=ON").await.unwrap();
        db.execute(
            r#"
            CREATE TABLE users(id TEXT PRIMARY KEY,pharmacy_id TEXT,is_active INTEGER);
            CREATE TABLE sales_invoices(id TEXT PRIMARY KEY,user_id TEXT,pharmacy_id TEXT,
                status TEXT,payment_method TEXT,total_amount REAL);
            CREATE TABLE inventory(id TEXT PRIMARY KEY,pharmacy_id TEXT,drug_id INTEGER);
            CREATE TABLE sales_items(id INTEGER PRIMARY KEY,invoice_id TEXT,inventory_id TEXT,
                drug_id INTEGER,quantity_sold REAL,unit_price REAL,cost_price REAL,unit TEXT,
                is_negative INTEGER,large_to_medium REAL,medium_to_small REAL);
            CREATE TABLE returns(id TEXT PRIMARY KEY,invoice_id TEXT,user_id TEXT,
                pharmacy_id TEXT,total_refund REAL,refund_method TEXT,status TEXT);
            CREATE TABLE return_items(id INTEGER PRIMARY KEY,return_id TEXT,inventory_id TEXT,
                drug_id INTEGER,sale_item_id INTEGER,quantity_returned REAL,unit TEXT,total_price REAL);
            CREATE TABLE daily_journals(id TEXT PRIMARY KEY,pharmacy_id TEXT,
                created_by TEXT,total_amount REAL);
            CREATE TABLE accounts(id INTEGER PRIMARY KEY,code TEXT);
            CREATE TABLE journal_entries(journal_id TEXT,account_id INTEGER,type TEXT,amount REAL);
            INSERT INTO users VALUES('actor-a','tenant-a',1);
            INSERT INTO sales_invoices VALUES('sale-a','actor-a','tenant-a','completed','cash',20);
            INSERT INTO inventory VALUES
                ('sold-lot','tenant-a',101),
                ('same-drug-restock-lot','tenant-a',101),
                ('wrong-drug-lot','tenant-a',202);
            INSERT INTO sales_items VALUES(15,'sale-a','sold-lot',101,2,10,2,'large',0,1,1);
            INSERT INTO returns VALUES
                ('return-good','sale-a','actor-a','tenant-a',10,'patient_account','approved'),
                ('return-forged','sale-a','actor-a','tenant-a',10,'patient_account','approved');
            INSERT INTO return_items VALUES
                (31,'return-good','same-drug-restock-lot',101,15,1,'large',10),
                (32,'return-forged','wrong-drug-lot',202,15,1,'large',10);
            INSERT INTO accounts VALUES(1,'3.1'),(2,'1.1.3'),(3,'4.1'),(4,'1.1.1');
            INSERT INTO daily_journals VALUES
                ('journal-good','tenant-a','actor-a',12),
                ('journal-forged','tenant-a','actor-a',12);
            INSERT INTO journal_entries VALUES
                ('journal-good',1,'debit',10),('journal-good',2,'debit',2),
                ('journal-good',3,'credit',2),('journal-good',4,'credit',10),
                ('journal-forged',1,'debit',10),('journal-forged',2,'debit',2),
                ('journal-forged',3,'credit',2),('journal-forged',4,'credit',10);
            "#,
        )
        .await
        .unwrap();
        db.execute(include_str!(
            "../../migrations/043_native_sales_cogs_provenance.sql"
        ))
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        record_return(
            &mut tx,
            &Uuid::new_v4().to_string(),
            "return-good",
            "sale-a",
            "actor-a",
            "tenant-a",
            "patient_account",
            "journal-good",
            10.0,
            2.0,
        )
        .await
        .expect("a partial return restocked in a distinct same-drug lot must be receipted");
        let original_snapshot: String = sqlx::query_scalar(
            "SELECT line_snapshot FROM native_sale_return_cogs_provenance WHERE return_id='return-good'",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&original_snapshot).unwrap();
        assert_eq!(parsed[0]["originalSaleItemId"], 15);
        assert_eq!(parsed[0]["drugId"], 101);
        assert_eq!(parsed[0]["inventoryId"], "same-drug-restock-lot");

        // 043 already validates the posted journal, actor, sale, tenant and
        // return totals. The forged item also names a real, SAME-tenant lot,
        // but that lot's drug 202 was never sold by sale item 15 (drug 101).
        let forged = record_return(
            &mut tx,
            &Uuid::new_v4().to_string(),
            "return-forged",
            "sale-a",
            "actor-a",
            "tenant-a",
            "patient_account",
            "journal-forged",
            10.0,
            2.0,
        )
        .await;
        assert!(
            forged.as_ref().is_err_and(|error| error.contains("original sold drug")),
            "A same-tenant lot for a different drug was receipted as an original sale return: {forged:?}",
        );
        let receipt_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM native_sale_return_cogs_provenance")
                .fetch_one(&mut *tx)
                .await
                .unwrap();
        assert_eq!(
            receipt_count, 1,
            "forged source must add no new financial receipt"
        );
        let journal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM daily_journals")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(
            journal_count, 2,
            "source witness cannot alter existing journals"
        );
        tx.rollback().await.unwrap();
    }
}
