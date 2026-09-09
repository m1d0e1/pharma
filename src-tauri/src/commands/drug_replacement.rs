use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, Sqlite, SqliteConnection, Transaction};
use tauri::Manager;

#[derive(Deserialize)]
pub struct Replacement {
    source_id: i64,
    target_id: Option<i64>,
    new_drug: Option<Value>,
    edits: Option<Value>,
    confirmed_same_product: bool,
}

const REFS: &[(&str, &[&str])] = &[
    ("inventory", &["drug_id"]),
    ("sales_items", &["drug_id"]),
    ("return_items", &["drug_id"]),
    ("purchase_invoice_items", &["drug_id"]),
    ("purchase_return_items", &["drug_id"]),
    ("purchase_order_items", &["drug_id"]),
    ("opening_balance_items", &["drug_id"]),
    ("refill_reminders", &["drug_id"]),
    ("shortages", &["drug_id"]),
    ("drug_indications", &["drug_id"]),
    ("drug_alternatives", &["drug_id", "alternative_id"]),
];
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[tauri::command]
pub async fn replace_master_drug(
    app: tauri::AppHandle,
    user_id: String,
    password: String,
    payload: Replacement,
) -> Result<Value, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    // This operation affects historical/clinical links: require a real active admin and password.
    crate::database_backup::require_backup_admin(&path, &user_id, &password).await?;
    let backup = crate::database_backup::create_backup(&path).await?;
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .foreign_keys(true),
    )
    .await
    .map_err(|e| e.to_string())?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    match replace_tx(&mut tx, &user_id, payload).await {
        Ok(target) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(json!({"id": target, "backup_path": backup.to_string_lossy()}))
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

async fn replace_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: &str,
    payload: Replacement,
) -> Result<i64, String> {
    let admin: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM users WHERE id=? AND is_active=1 AND role IN ('admin','owner')",
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if admin != 1 {
        return Err("يلزم حساب مدير أو مالك نشط".into());
    }
    if !payload.confirmed_same_product
        || payload.source_id <= 0
        || payload.target_id.is_some() == payload.new_drug.is_some()
    {
        return Err("يلزم تأكيد تطابق الدواء والتركيز والشكل وحجم العبوة واختيار بديل واحد".into());
    }
    // Acquire a write lock before inspecting references; a concurrent purchase cannot add a late link.
    let locked = sqlx::query("UPDATE master_drugs SET id=id WHERE id=?")
        .bind(payload.source_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    if locked.rows_affected() != 1 {
        return Err("الصنف القديم غير موجود؛ حدّث القائمة".into());
    }
    let target_id = if let Some(id) = payload.target_id {
        id
    } else {
        let data = payload
            .new_drug
            .as_ref()
            .and_then(Value::as_object)
            .ok_or("بيانات الصنف البديل غير صحيحة")?;
        let name = data
            .get("trade_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let price = data
            .get("official_price")
            .and_then(Value::as_f64)
            .ok_or("سعر البيع غير صحيح")?;
        if name.is_empty() || !price.is_finite() || price < 0.0 {
            return Err("اسم الصنف وسعر البيع مطلوبان".into());
        }
        // Clone operational/custom settings rather than resetting stock rules when correcting a name.
        let columns = sqlx::query("PRAGMA table_info(master_drugs)")
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
            .iter()
            .map(|r| r.get::<String, _>("name"))
            .filter(|c| c != "id")
            .map(|c| quote(&c))
            .collect::<Vec<_>>()
            .join(",");
        let id: i64 = sqlx::query_scalar(&format!("INSERT INTO master_drugs({columns}) SELECT {columns} FROM master_drugs WHERE id=? RETURNING id"))
            .bind(payload.source_id).fetch_one(&mut **tx).await.map_err(|e| e.to_string())?;
        for field in [
            "trade_name",
            "trade_name_en",
            "generic_name",
            "active_ingredient",
            "manufacturer",
            "category",
            "large_unit",
            "medium_unit",
            "small_unit",
        ] {
            if let Some(value) = data
                .get(field)
                .and_then(Value::as_str)
                .filter(|s| !field.ends_with("_unit") || !s.trim().is_empty())
            {
                sqlx::query(&format!("UPDATE master_drugs SET {field}=? WHERE id=?"))
                    .bind(value.trim())
                    .bind(id)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        sqlx::query("UPDATE master_drugs SET trade_name_en=? WHERE id=?")
            .bind(
                data.get("trade_name_en")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(name)
                    .trim(),
            )
            .bind(id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        for field in ["large_to_medium", "medium_to_small"] {
            if let Some(value) = data
                .get(field)
                .filter(|v| !v.is_null() && v.as_str() != Some(""))
            {
                let factor = value
                    .as_f64()
                    .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
                    .ok_or("معامل الوحدة غير صحيح")?;
                if !factor.is_finite() || factor < 1.0 || factor.fract() != 0.0 {
                    return Err("معامل الوحدة غير صحيح".into());
                }
                sqlx::query(&format!("UPDATE master_drugs SET {field}=? WHERE id=?"))
                    .bind(factor)
                    .bind(id)
                    .execute(&mut **tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        sqlx::query("UPDATE master_drugs SET official_price=? WHERE id=?")
            .bind(price)
            .bind(id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(barcode) = data
            .get("barcode")
            .and_then(Value::as_str)
            .filter(|b| !b.trim().is_empty())
        {
            let owned: i64 = sqlx::query_scalar("SELECT (EXISTS(SELECT 1 FROM master_drugs WHERE id=? AND TRIM(barcode)=? COLLATE NOCASE) OR EXISTS(SELECT 1 FROM inventory WHERE drug_id=? AND TRIM(barcode)=? COLLATE NOCASE))")
                .bind(payload.source_id).bind(barcode.trim()).bind(payload.source_id).bind(barcode.trim()).fetch_one(&mut **tx).await.map_err(|e| e.to_string())?;
            if owned == 0 {
                return Err("الباركود المقترح غير مرتبط بالصنف القديم".into());
            }
            sqlx::query("UPDATE master_drugs SET barcode=? WHERE id=?")
                .bind(barcode.trim())
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
        }
        id
    };
    if target_id <= 0 || target_id == payload.source_id {
        return Err("اختر صنفاً بديلاً مختلفاً".into());
    }
    if let Some(edits) = payload.edits.as_ref() {
        apply_edits(tx, target_id, edits).await?;
    }
    let pair = sqlx::query("SELECT s.trade_name source_name,t.trade_name target_name,s.barcode source_barcode,t.barcode target_barcode FROM master_drugs s JOIN master_drugs t ON t.id=? WHERE s.id=?")
        .bind(target_id).bind(payload.source_id).fetch_optional(&mut **tx).await.map_err(|e| e.to_string())?.ok_or("الصنف البديل غير موجود")?;
    for field in [
        "large_to_medium",
        "medium_to_small",
        "is_service",
        "is_medicine",
        "has_expiry",
        "no_return",
        "prevent_fractions",
    ] {
        let default = if matches!(
            field,
            "large_to_medium" | "medium_to_small" | "is_medicine" | "has_expiry"
        ) {
            1
        } else {
            0
        };
        let differs: i64 = sqlx::query_scalar(&format!("SELECT COALESCE(s.{field},{default}) != COALESCE(t.{field},{default}) FROM master_drugs s,master_drugs t WHERE s.id=? AND t.id=?"))
            .bind(payload.source_id).bind(target_id).fetch_one(&mut **tx).await.map_err(|e| e.to_string())?;
        if differs != 0 {
            return Err(format!(
                "لا يمكن الدمج بأمان: اختلاف إعداد {field}. راجع وحدات العبوة وقواعد الصنف أولاً"
            ));
        }
    }
    let source_barcode: Option<String> = pair.try_get("source_barcode").unwrap_or(None);
    let target_barcode: Option<String> = pair.try_get("target_barcode").unwrap_or(None);
    let old = source_barcode.as_deref().unwrap_or("").trim();
    let new = target_barcode.as_deref().unwrap_or("").trim();
    if !old.is_empty() && !new.is_empty() && !old.eq_ignore_ascii_case(new) {
        return Err("للصنفين باركودان مختلفان؛ يلزم مراجعة الباركود قبل الدمج".into());
    }
    let collision: i64 = sqlx::query_scalar("WITH codes AS (SELECT barcode FROM master_drugs WHERE id IN (?,?) UNION SELECT barcode FROM inventory WHERE drug_id IN (?,?)), owners AS (SELECT id drug_id,barcode FROM master_drugs UNION SELECT drug_id,barcode FROM inventory) SELECT COUNT(*) FROM owners o JOIN codes c ON TRIM(o.barcode)=TRIM(c.barcode) COLLATE NOCASE WHERE TRIM(COALESCE(c.barcode,''))!='' AND o.drug_id NOT IN (?,?)")
        .bind(payload.source_id).bind(target_id).bind(payload.source_id).bind(target_id).bind(payload.source_id).bind(target_id)
        .fetch_one(&mut **tx).await.map_err(|e| e.to_string())?;
    if collision > 0 {
        return Err("الباركود مرتبط بصنف ثالث؛ يلزم تصحيح التعارض أولاً".into());
    }
    let metadata = [
        "id",
        "trade_name",
        "trade_name_en",
        "generic_name",
        "active_ingredient",
        "official_price",
        "category",
        "manufacturer",
        "barcode",
        "created_at",
    ];
    for column in sqlx::query("PRAGMA table_info(master_drugs)")
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
    {
        let field: String = column.get("name");
        if metadata.contains(&field.as_str()) {
            continue;
        }
        let field = quote(&field);
        if payload
            .edits
            .as_ref()
            .and_then(Value::as_object)
            .is_some_and(|e| e.contains_key(field.trim_matches('"')))
        {
            continue;
        }
        let conflict: i64 = sqlx::query_scalar(&format!("SELECT s.{field} IS NOT NULL AND s.{field} != '' AND t.{field} IS NOT NULL AND t.{field} != '' AND s.{field} IS NOT t.{field} FROM master_drugs s,master_drugs t WHERE s.id=? AND t.id=?"))
            .bind(payload.source_id).bind(target_id).fetch_one(&mut **tx).await.map_err(|e| e.to_string())?;
        if conflict != 0 {
            return Err(format!("إعدادات مخصصة متعارضة {field}؛ راجعها قبل الدمج"));
        }
        sqlx::query(&format!("UPDATE master_drugs SET {field}=(SELECT {field} FROM master_drugs WHERE id=?) WHERE id=? AND ({field} IS NULL OR {field}='')"))
            .bind(payload.source_id).bind(target_id).execute(&mut **tx).await.map_err(|e| e.to_string())?;
    }
    let tables: Vec<String> = sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'master_drugs_fts%'")
        .fetch_all(&mut **tx).await.map_err(|e| e.to_string())?;
    // Fail closed on a future schema with references this transaction does not understand.
    for table in &tables {
        if table == "cloud_drug_mappings" {
            continue;
        }
        let allowed = REFS
            .iter()
            .find(|(t, _)| t == table)
            .map(|(_, cols)| *cols)
            .unwrap_or(&[]);
        for column in sqlx::query(&format!("PRAGMA table_info({})", quote(table)))
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
        {
            let name: String = column.get("name");
            if matches!(
                name.as_str(),
                "drug_id" | "alternative_id" | "product_id" | "local_drug_id"
            ) && !allowed.contains(&name.as_str())
            {
                return Err(format!("مرجع غير مدعوم: {table}.{name}"));
            }
        }
        for fk in sqlx::query(&format!("PRAGMA foreign_key_list({})", quote(table)))
            .fetch_all(&mut **tx)
            .await
            .map_err(|e| e.to_string())?
        {
            if fk.get::<String, _>("table") == "master_drugs"
                && !allowed.contains(&fk.get::<String, _>("from").as_str())
            {
                return Err(format!("مرجع غير مدعوم: {table}"));
            }
        }
    }
    for (table, columns) in REFS {
        if !tables.iter().any(|t| t == table) {
            continue;
        }
        for column in *columns {
            sqlx::query(&format!("UPDATE {table} SET {column}=? WHERE {column}=?"))
                .bind(target_id)
                .bind(payload.source_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| format!("تعذر نقل روابط {table}؛ لم يتم الدمج: {e}"))?;
        }
    }
    if tables.iter().any(|t| t == "drug_alternatives") {
        let self_link: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM drug_alternatives WHERE drug_id=? AND alternative_id=?",
        )
        .bind(target_id)
        .bind(target_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if self_link > 0 {
            return Err("الصنفان مسجلان كبدائل لبعضهما؛ راجع الروابط الطبية قبل الدمج".into());
        }
    }
    sqlx::query("UPDATE master_drugs SET barcode=COALESCE(NULLIF(TRIM(barcode),''),?) WHERE id=?")
        .bind(source_barcode)
        .bind(target_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    if tables.iter().any(|t| t == "cloud_drug_mappings") {
        sqlx::query("DELETE FROM cloud_drug_mappings")
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    sqlx::query("DELETE FROM master_drugs WHERE id=?")
        .bind(payload.source_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    if !sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .is_empty()
    {
        return Err("فشل التحقق من سلامة روابط البيانات؛ تم إلغاء الدمج".into());
    }
    if payload
        .edits
        .as_ref()
        .and_then(|e| e.get("official_price"))
        .is_some()
    {
        // Explicit price correction affects future sales, not costs or historical receipts.
        sqlx::query("UPDATE inventory SET local_selling_price=(SELECT official_price FROM master_drugs WHERE id=?),updated_at=CURRENT_TIMESTAMP WHERE drug_id=?")
            .bind(target_id).bind(target_id).execute(&mut **tx).await.map_err(|e| e.to_string())?;
    }
    sqlx::query("INSERT INTO activity_log(user_id,action,details) VALUES (?,'REPLACE_MASTER_DRUG',?)")
        .bind(user_id).bind(json!({"source_id":payload.source_id,"target_id":target_id,"source_name":pair.get::<String,_>("source_name"),"target_name":pair.get::<String,_>("target_name"),"confirmed_same_product":true,"edits":payload.edits}).to_string())
        .execute(&mut **tx).await.map_err(|e| e.to_string())?;
    Ok(target_id)
}

async fn apply_edits(
    tx: &mut Transaction<'_, Sqlite>,
    id: i64,
    edits: &Value,
) -> Result<(), String> {
    let edits = edits.as_object().ok_or("تعديلات الصنف غير صحيحة")?;
    const TEXT: &[&str] = &[
        "trade_name",
        "trade_name_en",
        "generic_name",
        "active_ingredient",
        "barcode",
        "category",
        "manufacturer",
        "origin",
        "notes",
        "large_unit",
        "medium_unit",
        "small_unit",
        "code_2",
        "item_nature",
        "scientific_group",
        "usage_method",
        "active_ingredient_ratio",
        "indications",
        "side_effects",
    ];
    const NUMBERS: &[&str] = &[
        "official_price",
        "large_to_medium",
        "medium_to_small",
        "min_limit",
        "max_limit",
        "reorder_point",
        "default_purchase_qty",
        "tax_percent",
        "discount_percent",
    ];
    const FLAGS: &[&str] = &[
        "is_medicine",
        "is_service",
        "is_refrigerated",
        "is_chronic",
        "has_expiry",
        "no_return",
        "prevent_fractions",
        "stop_dealing",
        "is_table",
    ];
    for (field, value) in edits {
        if TEXT.contains(&field.as_str()) {
            let text = if value.is_null() {
                ""
            } else {
                value.as_str().ok_or("قيمة نصية غير صحيحة")?.trim()
            };
            if field == "trade_name" && text.is_empty() {
                return Err("اسم الصنف مطلوب".into());
            }
            sqlx::query(&format!(
                "UPDATE master_drugs SET {}=? WHERE id=?",
                quote(field)
            ))
            .bind(text)
            .bind(id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        } else if NUMBERS.contains(&field.as_str()) || FLAGS.contains(&field.as_str()) {
            let factor = matches!(field.as_str(), "large_to_medium" | "medium_to_small");
            let number = if value.is_null() || value.as_str() == Some("") {
                if factor {
                    1.0
                } else {
                    0.0
                }
            } else {
                value
                    .as_f64()
                    .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
                    .ok_or("قيمة رقمية غير صحيحة")?
            };
            if !number.is_finite()
                || number < 0.0
                || (factor && (number < 1.0 || number.fract() != 0.0))
                || (FLAGS.contains(&field.as_str()) && number != 0.0 && number != 1.0)
                || (field.ends_with("_percent") && number > 100.0)
            {
                return Err(format!("قيمة غير صحيحة: {field}"));
            }
            if factor
                || matches!(
                    field.as_str(),
                    "is_service" | "is_medicine" | "has_expiry" | "no_return" | "prevent_fractions"
                )
            {
                let default = if factor || matches!(field.as_str(), "is_medicine" | "has_expiry") {
                    1
                } else {
                    0
                };
                let changed: i64 = sqlx::query_scalar(&format!(
                    "SELECT COALESCE({}, {}) != ? FROM master_drugs WHERE id=?",
                    quote(field),
                    default
                ))
                .bind(number)
                .bind(id)
                .fetch_one(&mut **tx)
                .await
                .map_err(|e| e.to_string())?;
                if changed != 0 {
                    for (table, columns) in REFS {
                        let exists: i64 = sqlx::query_scalar(
                            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
                        )
                        .bind(table)
                        .fetch_one(&mut **tx)
                        .await
                        .map_err(|e| e.to_string())?;
                        if exists == 0 {
                            continue;
                        }
                        for column in *columns {
                            let linked: i64 = sqlx::query_scalar(&format!(
                                "SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=?)"
                            ))
                            .bind(id)
                            .fetch_one(&mut **tx)
                            .await
                            .map_err(|e| e.to_string())?;
                            if linked != 0 {
                                return Err(format!("لا يمكن تغيير {field} لصنف له مخزون أو سجل؛ ستتغير حسابات العبوة. تبقى البيانات دون تغيير"));
                            }
                        }
                    }
                }
            }
            sqlx::query(&format!(
                "UPDATE master_drugs SET {}=? WHERE id=?",
                quote(field)
            ))
            .bind(number)
            .bind(id)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
        } else {
            return Err(format!("حقل غير قابل للتعديل: {field}"));
        }
    }
    let invalid: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM master_drugs WHERE id=? AND COALESCE(max_limit,0)>0 AND min_limit>max_limit").bind(id).fetch_one(&mut **tx).await.map_err(|e| e.to_string())?;
    if invalid != 0 {
        return Err("الحد الأقصى أقل من الحد الأدنى".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture() -> SqliteConnection {
        let mut db = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        for sql in [
            include_str!("../../migrations/001_initial.sql"),
            include_str!("../../migrations/006_accounting_upgrade_seed.sql"),
            include_str!("../../migrations/008_patient_accounting.sql"),
            include_str!("../../migrations/009_rebuild_master_drugs_fts.sql"),
            include_str!("../../migrations/011_shift_cash_difference_account.sql"),
            include_str!("../../migrations/017_cloud_drug_identity.sql"),
        ] {
            sqlx::raw_sql(sql).execute(&mut db).await.unwrap();
        }
        sqlx::raw_sql("INSERT INTO users(id,username,role,is_active) VALUES('admin','replacement-admin','admin',1),('cashier','replacement-cashier','cashier',1) ON CONFLICT(id) DO UPDATE SET role=excluded.role,is_active=1;
          INSERT INTO master_drugs(id,trade_name,barcode,official_price,large_to_medium,notes) VALUES(10,'Old name','123',20,2,'keep'),(20,'Correct name',NULL,25,2,NULL);
          INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,local_selling_price,strips_per_box,barcode,expiry_date,batch_number) VALUES('old-lot',10,'local_default',1.5,10,20,2,'123','2030-01-01','old'),('target-lot',20,'local_default',0.5,11,22,2,NULL,'2030-02-01','other');
          INSERT INTO sales_invoices(id,user_id,total_amount,status) VALUES('historical','admin',30,'completed');
          INSERT INTO sales_items(id,invoice_id,drug_id,inventory_id,quantity_sold,unit_price,cost_price) VALUES(1,'historical',10,'old-lot',1,30,10);
          INSERT INTO returns(id,invoice_id,user_id,total_refund,status) VALUES('old-return','historical','admin',15,'completed');
          INSERT INTO return_items(return_id,drug_id,inventory_id,quantity_returned,unit_price,total_price,sale_item_id) VALUES('old-return',10,'old-lot',0.5,30,15,1);
          INSERT INTO suppliers(id,name_ar) VALUES(1,'Supplier');
          INSERT INTO shortages(drug_id,requested_quantity,notes) VALUES(10,3,'keep request');
          INSERT INTO cloud_drug_mappings(cloud_id,local_drug_id,last_cloud_name) VALUES(555,10,'Old name');").execute(&mut db).await.unwrap();
        db
    }
    fn payload(target: Option<i64>, new_drug: Option<Value>) -> Replacement {
        Replacement {
            source_id: 10,
            target_id: target,
            new_drug,
            edits: None,
            confirmed_same_product: true,
        }
    }
    fn purchase() -> super::super::critical::PurchasePayload {
        serde_json::from_value(json!({"supplier_id":1,"user_id":"admin","invoice_number":"new-purchase","status":"completed","cart":[{"id":20,"quantity":1,"cost_price":10,"selling_price":25,"expiry_date":"2030-03-01","strips_per_box":2,"barcode":"123"}]})).unwrap()
    }
    #[tokio::test]
    async fn moved_catalog_barcode_with_old_batch_alias_can_be_corrected_and_purchased() {
        let mut db = fixture().await;
        sqlx::raw_sql("UPDATE master_drugs SET barcode=NULL WHERE id=10; UPDATE master_drugs SET barcode='123' WHERE id=20;").execute(&mut db).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        assert!(
            super::super::critical::save_purchase_invoice_tx(&mut tx, purchase())
                .await
                .is_err()
        );
        tx.rollback().await.unwrap();
        let mut tx = db.begin().await.unwrap();
        let mut p = payload(Some(20), None);
        p.edits = Some(
            json!({"trade_name":"Reviewed medicine","trade_name_en":"Reviewed medicine","official_price":45,"active_ingredient":"Reviewed ingredient","manufacturer":"Reviewed company","notes":"","is_refrigerated":1,"reorder_point":5}),
        );
        replace_tx(&mut tx, "admin", p).await.unwrap();
        tx.commit().await.unwrap();
        let drug: (String,String,String,String,i64) = sqlx::query_as("SELECT trade_name,barcode,active_ingredient,notes,is_refrigerated FROM master_drugs WHERE id=20").fetch_one(&mut db).await.unwrap();
        assert_eq!(
            drug,
            (
                "Reviewed medicine".into(),
                "123".into(),
                "Reviewed ingredient".into(),
                "".into(),
                1
            )
        );
        let amounts: (f64,f64,f64) = sqlx::query_as("SELECT CAST(SUM(quantity) AS REAL),MIN(local_selling_price),SUM(quantity*cost_price) FROM inventory WHERE drug_id=20").fetch_one(&mut db).await.unwrap();
        assert_eq!(amounts, (2.0, 45.0, 20.5));
        let historical_price: f64 =
            sqlx::query_scalar("SELECT unit_price FROM sales_items WHERE id=1")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(historical_price, 30.0);
        let mut tx = db.begin().await.unwrap();
        let mut invoice = purchase();
        invoice.cart[0].selling_price = Some(45.0);
        super::super::critical::save_purchase_invoice_tx(&mut tx, invoice)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let total: f64 = sqlx::query_scalar(
            "SELECT CAST(SUM(quantity) AS REAL) FROM inventory WHERE drug_id=20",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(total, 3.0);
    }
    #[tokio::test]
    async fn invalid_edits_and_history_unit_changes_rollback_the_entire_replacement() {
        let mut db = fixture().await;
        for edits in [
            json!({"id":100}),
            json!({"official_price":-1}),
            json!({"discount_percent":101}),
            json!({"trade_name":""}),
            json!({"large_to_medium":3}),
            json!({"is_service":1}),
            json!({"min_limit":10,"max_limit":2}),
        ] {
            let mut tx = db.begin().await.unwrap();
            let mut p = payload(Some(20), None);
            p.edits = Some(edits);
            assert!(replace_tx(&mut tx, "admin", p).await.is_err());
            tx.rollback().await.unwrap();
            let state: (i64, f64) = sqlx::query_as(
                "SELECT drug_id,local_selling_price FROM inventory WHERE id='old-lot'",
            )
            .fetch_one(&mut db)
            .await
            .unwrap();
            assert_eq!(state, (10, 20.0));
        }
    }
    #[tokio::test]
    async fn replacement_unblocks_purchase_and_preserves_lots_history_and_search() {
        let mut db = fixture().await;
        let mut tx = db.begin().await.unwrap();
        assert!(
            super::super::critical::save_purchase_invoice_tx(&mut tx, purchase())
                .await
                .is_err()
        );
        tx.rollback().await.unwrap();
        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            replace_tx(&mut tx, "admin", payload(Some(20), None))
                .await
                .unwrap(),
            20
        );
        tx.commit().await.unwrap();
        let lots: Vec<(String,i64,f64,f64,f64)> = sqlx::query_as("SELECT id,drug_id,CAST(quantity AS REAL),cost_price,local_selling_price FROM inventory ORDER BY id").fetch_all(&mut db).await.unwrap();
        assert_eq!(
            lots,
            vec![
                ("old-lot".into(), 20, 1.5, 10.0, 20.0),
                ("target-lot".into(), 20, 0.5, 11.0, 22.0)
            ]
        );
        let sale: (i64, String, f64) =
            sqlx::query_as("SELECT drug_id,inventory_id,unit_price FROM sales_items WHERE id=1")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(sale, (20, "old-lot".into(), 30.0));
        let returned: (i64, i64, f64) =
            sqlx::query_as("SELECT drug_id,sale_item_id,total_price FROM return_items")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(returned, (20, 1, 15.0));
        let drug: (String, String) =
            sqlx::query_as("SELECT barcode,notes FROM master_drugs WHERE id=20")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(drug, ("123".into(), "keep".into()));
        let old_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM master_drugs WHERE id=10")
            .fetch_one(&mut db)
            .await
            .unwrap();
        assert_eq!(old_count, 0);
        sqlx::query(
            "INSERT INTO master_drugs_fts(master_drugs_fts,rank) VALUES('integrity-check',1)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        let mut tx = db.begin().await.unwrap();
        super::super::critical::save_purchase_invoice_tx(&mut tx, purchase())
            .await
            .unwrap();
        tx.commit().await.unwrap();
        let total: f64 = sqlx::query_scalar(
            "SELECT CAST(SUM(quantity) AS REAL) FROM inventory WHERE drug_id=20",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(total, 3.0);
        assert!(sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut db)
            .await
            .unwrap()
            .is_empty());
        let mut tx = db.begin().await.unwrap();
        assert!(replace_tx(&mut tx, "admin", payload(Some(20), None))
            .await
            .is_err());
        tx.rollback().await.unwrap();
    }
    #[tokio::test]
    async fn new_name_reuses_barcode_without_resetting_inventory_or_unit_rules() {
        let mut db = fixture().await;
        let mut tx = db.begin().await.unwrap();
        let id = replace_tx(&mut tx,"admin",payload(None,Some(json!({"trade_name":"Replacement name","trade_name_en":"Replacement name","barcode":"123","official_price":40,"large_to_medium":2})))).await.unwrap();
        tx.commit().await.unwrap();
        let drug: (String, String, f64, i64) = sqlx::query_as(
            "SELECT trade_name,barcode,official_price,large_to_medium FROM master_drugs WHERE id=?",
        )
        .bind(id)
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(drug, ("Replacement name".into(), "123".into(), 40.0, 2));
        let lot: (i64,f64,f64) = sqlx::query_as("SELECT drug_id,CAST(quantity AS REAL),local_selling_price FROM inventory WHERE id='old-lot'").fetch_one(&mut db).await.unwrap();
        assert_eq!(lot, (id, 1.5, 20.0));
    }
    #[tokio::test]
    async fn unsafe_or_unauthorized_replacements_rollback_without_deleting_anything() {
        let mut db = fixture().await;
        for case in 0..7 {
            let mut tx = db.begin().await.unwrap();
            let mut p = payload(Some(20), None);
            let mut user = "admin";
            match case {
                0 => user = "cashier",
                1 => p.confirmed_same_product = false,
                2 => {
                    sqlx::query("UPDATE master_drugs SET large_to_medium=3 WHERE id=20")
                        .execute(&mut *tx)
                        .await
                        .unwrap();
                }
                3 => {
                    sqlx::query("INSERT INTO master_drugs(id,trade_name,barcode) VALUES(30,'Third medicine','123')").execute(&mut *tx).await.unwrap();
                }
                4 => {
                    sqlx::query("CREATE TABLE unknown_references(drug_id INTEGER)")
                        .execute(&mut *tx)
                        .await
                        .unwrap();
                }
                5 => {
                    sqlx::query("INSERT INTO drug_alternatives VALUES(10,20)")
                        .execute(&mut *tx)
                        .await
                        .unwrap();
                }
                _ => {
                    p = payload(
                        None,
                        Some(
                            json!({"trade_name":"Invalid units","official_price":1,"large_to_medium":3}),
                        ),
                    );
                }
            }
            assert!(replace_tx(&mut tx, user, p).await.is_err(), "case {case}");
            tx.rollback().await.unwrap();
            let unchanged: (i64, f64) = sqlx::query_as(
                "SELECT drug_id,CAST(quantity AS REAL) FROM inventory WHERE id='old-lot'",
            )
            .fetch_one(&mut db)
            .await
            .unwrap();
            assert_eq!(unchanged, (10, 1.5));
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM master_drugs")
                .fetch_one(&mut db)
                .await
                .unwrap();
            assert_eq!(count, 2);
        }
    }
}
