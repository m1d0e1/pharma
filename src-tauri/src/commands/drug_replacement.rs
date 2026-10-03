use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{sqlite::SqliteConnectOptions, Connection, Row, Sqlite, SqliteConnection, Transaction};
use std::collections::HashSet;
use tauri::Manager;

#[derive(Deserialize)]
pub struct Replacement {
    source_id: i64,
    target_id: Option<i64>,
    new_drug: Option<Value>,
    edits: Option<Value>,
    confirmed_same_product: bool,
}

#[derive(Deserialize)]
pub struct GroupReplacement {
    source_ids: Vec<i64>,
    target_id: i64,
    edits: Option<Value>,
    confirmed_same_product: bool,
}

#[derive(Deserialize)]
pub struct BarcodeCorrection {
    drug_id: i64,
    conflicting_barcode: String,
    replacement_barcode: Option<String>,
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
    ("drug_catalog_links", &["master_drug_id"]),
    ("drug_catalog_field_policies", &["master_drug_id"]),
];

fn ensure_replacement_permission(role: Option<&str>, permissions: Option<&str>) -> Result<(), String> {
    if !role.is_some_and(|role| matches!(role.trim().to_ascii_lowercase().as_str(), "admin" | "owner")) {
        return Err("يلزم حساب مدير أو مالك نشط".into());
    }
    if !crate::commands::critical::user_has_permission(
        role,
        permissions,
        "can_manage_inventory",
        false,
    ) {
        return Err("Unauthorized: can_manage_inventory permission required".into());
    }
    Ok(())
}

async fn ensure_unit_conversion_edit_permission(
    tx: &mut Transaction<'_, Sqlite>,
    target_id: i64,
    edits: Option<&Value>,
    role: Option<&str>,
    permissions: Option<&str>,
) -> Result<(), String> {
    let Some(edits) = edits.and_then(Value::as_object) else {
        return Ok(());
    };
    if !edits.keys().any(|field| matches!(
        field.as_str(),
        "large_unit" | "medium_unit" | "small_unit" | "large_to_medium" | "medium_to_small"
    )) {
        return Ok(());
    }
    let current = sqlx::query(
        "SELECT large_unit,medium_unit,small_unit,large_to_medium,medium_to_small FROM master_drugs WHERE id=?",
    )
    .bind(target_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "الصنف البديل غير موجود".to_string())?;

    let mut changed = false;
    for field in ["large_unit", "medium_unit", "small_unit"] {
        let Some(value) = edits.get(field) else { continue; };
        let requested = if value.is_null() {
            "".to_string()
        } else {
            value
                .as_str()
                .ok_or_else(|| "قيمة وحدة غير صحيحة".to_string())?
                .trim()
                .to_string()
        };
        let existing = current
            .try_get::<Option<String>, _>(field)
            .unwrap_or(None)
            .unwrap_or_default()
            .trim()
            .to_string();
        changed |= requested != existing;
    }
    for field in ["large_to_medium", "medium_to_small"] {
        let Some(value) = edits.get(field) else { continue; };
        let requested = if value.is_null() || value.as_str() == Some("") {
            1.0
        } else {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
                .ok_or_else(|| "معامل الوحدة غير صحيح".to_string())?
        };
        let existing = current
            .try_get::<Option<f64>, _>(field)
            .unwrap_or(None)
            .unwrap_or(1.0);
        changed |= (requested - existing).abs() > f64::EPSILON;
    }
    if changed
        && !crate::commands::critical::user_has_permission(
            role,
            permissions,
            "can_modify_unit_conversion",
            false,
        )
    {
        return Err("Unauthorized: can_modify_unit_conversion permission required".into());
    }
    Ok(())
}

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
    // Check the granular inventory permission before creating a backup so an explicitly
    // denied admin cannot trigger disk side effects through a direct native invocation.
    let mut permission_conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(&path).read_only(true),
    )
    .await
    .map_err(|e| e.to_string())?;
    let permission_user = sqlx::query(
        "SELECT role, permissions FROM users WHERE id=? AND is_active=1",
    )
    .bind(&user_id)
    .fetch_optional(&mut permission_conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "يلزم حساب مدير أو مالك نشط".to_string())?;
    let role: Option<String> = permission_user.try_get("role").unwrap_or(None);
    let permissions: Option<String> = permission_user.try_get("permissions").unwrap_or(None);
    ensure_replacement_permission(role.as_deref(), permissions.as_deref())?;
    permission_conn.close().await.map_err(|e| e.to_string())?;
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

#[tauri::command]
pub async fn reconcile_master_drug_group(
    app: tauri::AppHandle,
    user_id: String,
    password: String,
    payload: GroupReplacement,
) -> Result<Value, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    crate::database_backup::require_backup_admin(&path, &user_id, &password).await?;
    let mut permission_conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(&path).read_only(true),
    )
    .await
    .map_err(|e| e.to_string())?;
    let permission_user = sqlx::query(
        "SELECT role, permissions FROM users WHERE id=? AND is_active=1",
    )
    .bind(&user_id)
    .fetch_optional(&mut permission_conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "يلزم حساب مدير أو مالك نشط".to_string())?;
    let role: Option<String> = permission_user.try_get("role").unwrap_or(None);
    let permissions: Option<String> = permission_user.try_get("permissions").unwrap_or(None);
    ensure_replacement_permission(role.as_deref(), permissions.as_deref())?;
    permission_conn.close().await.map_err(|e| e.to_string())?;
    let backup = crate::database_backup::create_backup(&path).await?;
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .foreign_keys(true),
    )
    .await
    .map_err(|e| e.to_string())?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    match replace_group_tx(&mut tx, &user_id, payload).await {
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

#[tauri::command]
pub async fn correct_drug_barcode_conflict(
    app: tauri::AppHandle,
    user_id: String,
    password: String,
    payload: BarcodeCorrection,
) -> Result<Value, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    crate::database_backup::require_backup_admin(&path, &user_id, &password).await?;
    let mut permission_conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(&path).read_only(true),
    )
    .await
    .map_err(|e| e.to_string())?;
    let permission_user = sqlx::query(
        "SELECT role, permissions FROM users WHERE id=? AND is_active=1",
    )
    .bind(&user_id)
    .fetch_optional(&mut permission_conn)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "يلزم حساب مدير أو مالك نشط".to_string())?;
    let role: Option<String> = permission_user.try_get("role").unwrap_or(None);
    let permissions: Option<String> = permission_user.try_get("permissions").unwrap_or(None);
    ensure_replacement_permission(role.as_deref(), permissions.as_deref())?;
    permission_conn.close().await.map_err(|e| e.to_string())?;
    let backup = crate::database_backup::create_backup(&path).await?;
    let mut conn = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(&path)
            .foreign_keys(true),
    )
    .await
    .map_err(|e| e.to_string())?;
    let mut tx = conn.begin().await.map_err(|e| e.to_string())?;
    match correct_barcode_conflict_tx(&mut tx, &user_id, payload).await {
        Ok(drug_id) => {
            tx.commit().await.map_err(|e| e.to_string())?;
            Ok(json!({"id": drug_id, "backup_path": backup.to_string_lossy()}))
        }
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    }
}

async fn correct_barcode_conflict_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: &str,
    payload: BarcodeCorrection,
) -> Result<i64, String> {
    if payload.drug_id <= 0 {
        return Err("الصنف غير صالح".into());
    }
    let old = payload.conflicting_barcode.trim();
    if old.is_empty() {
        return Err("الباركود المتعارض مطلوب".into());
    }
    let replacement = payload
        .replacement_barcode
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if replacement
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case(old))
    {
        return Err("أدخل باركوداً مختلفاً أو اتركه فارغاً لإزالة الباركود الخاطئ".into());
    }

    let admin = sqlx::query("SELECT role, permissions FROM users WHERE id=? AND is_active=1")
        .bind(user_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "يلزم حساب مدير أو مالك نشط".to_string())?;
    let role: Option<String> = admin.try_get("role").unwrap_or(None);
    let permissions: Option<String> = admin.try_get("permissions").unwrap_or(None);
    ensure_replacement_permission(role.as_deref(), permissions.as_deref())?;

    let current_barcode: Option<String> = sqlx::query_scalar(
        "SELECT barcode FROM master_drugs WHERE id=?",
    )
    .bind(payload.drug_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "الصنف لم يعد موجوداً؛ حدّث شاشة التعارض".to_string())?;

    let selected_owns_old: i64 = sqlx::query_scalar(
        "SELECT (EXISTS(SELECT 1 FROM master_drugs WHERE id=? AND TRIM(COALESCE(barcode,''))=? COLLATE NOCASE) OR EXISTS(SELECT 1 FROM inventory WHERE drug_id=? AND (quantity IS NULL OR quantity != 0) AND TRIM(COALESCE(barcode,''))=? COLLATE NOCASE))",
    )
    .bind(payload.drug_id)
    .bind(old)
    .bind(payload.drug_id)
    .bind(old)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if selected_owns_old == 0 {
        return Err("هذا الصنف لم يعد مالكاً نشطاً للباركود؛ حدّث شاشة التعارض".into());
    }

    let other_old_owner: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM (SELECT id drug_id FROM master_drugs WHERE id!=? AND TRIM(COALESCE(barcode,''))=? COLLATE NOCASE UNION SELECT drug_id FROM inventory WHERE drug_id!=? AND (quantity IS NULL OR quantity != 0) AND TRIM(COALESCE(barcode,''))=? COLLATE NOCASE)",
    )
    .bind(payload.drug_id)
    .bind(old)
    .bind(payload.drug_id)
    .bind(old)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if other_old_owner == 0 {
        return Err("تم حل تعارض هذا الباركود بالفعل؛ حدّث شاشة التعارض".into());
    }

    if let Some(new_barcode) = replacement.as_deref() {
        let new_owner: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM (SELECT id drug_id FROM master_drugs WHERE id!=? AND TRIM(COALESCE(barcode,''))=? COLLATE NOCASE UNION SELECT drug_id FROM inventory WHERE drug_id!=? AND (quantity IS NULL OR quantity != 0) AND TRIM(COALESCE(barcode,''))=? COLLATE NOCASE)",
        )
        .bind(payload.drug_id)
        .bind(new_barcode)
        .bind(payload.drug_id)
        .bind(new_barcode)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if new_owner > 0 {
            return Err("الباركود الجديد مرتبط بصنف آخر؛ اختر باركوداً فريداً".into());
        }
    }

    sqlx::query("UPDATE master_drugs SET barcode=? WHERE id=?")
        .bind(replacement.as_deref())
        .bind(payload.drug_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    let active_aliases = sqlx::query(
        "UPDATE inventory SET barcode=? WHERE drug_id=? AND (quantity IS NULL OR quantity != 0) AND TRIM(COALESCE(barcode,''))=? COLLATE NOCASE",
    )
    .bind(replacement.as_deref())
    .bind(payload.drug_id)
    .bind(old)
    .execute(&mut **tx)
    .await
    .map_err(|e| e.to_string())?
    .rows_affected();

    let still_owns_old: i64 = sqlx::query_scalar(
        "SELECT (EXISTS(SELECT 1 FROM master_drugs WHERE id=? AND TRIM(COALESCE(barcode,''))=? COLLATE NOCASE) OR EXISTS(SELECT 1 FROM inventory WHERE drug_id=? AND (quantity IS NULL OR quantity != 0) AND TRIM(COALESCE(barcode,''))=? COLLATE NOCASE))",
    )
    .bind(payload.drug_id)
    .bind(old)
    .bind(payload.drug_id)
    .bind(old)
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if still_owns_old != 0 {
        return Err("تعذر إزالة الباركود المتعارض من كل الدفعات النشطة؛ تم إلغاء التصحيح".into());
    }

    sqlx::query("INSERT INTO activity_log(user_id,action,details) VALUES (?,'CORRECT_DRUG_BARCODE_CONFLICT',?)")
        .bind(user_id)
        .bind(json!({
            "drug_id": payload.drug_id,
            "conflicting_barcode": old,
            "replacement_barcode": replacement,
            "previous_master_barcode": current_barcode,
            "active_inventory_rows_changed": active_aliases,
        }).to_string())
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    Ok(payload.drug_id)
}

async fn replace_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: &str,
    payload: Replacement,
) -> Result<i64, String> {
    replace_tx_with_allowed_collisions(tx, user_id, payload, &[], false).await
}

async fn replace_group_tx(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: &str,
    payload: GroupReplacement,
) -> Result<i64, String> {
    if !payload.confirmed_same_product || payload.target_id <= 0 || payload.source_ids.is_empty() {
        return Err("يلزم تأكيد تطابق كل الأصناف واختيار صنف نهائي واحد".into());
    }
    if payload.source_ids.iter().any(|id| *id <= 0 || *id == payload.target_id) {
        return Err("قائمة الأصناف المطلوب دمجها غير صحيحة".into());
    }
    let mut source_ids = payload.source_ids.clone();
    source_ids.sort_unstable();
    source_ids.dedup();
    if source_ids.len() != payload.source_ids.len() {
        return Err("قائمة الأصناف المطلوب دمجها تحتوي على تكرار".into());
    }
    let mut all_ids = source_ids.clone();
    all_ids.push(payload.target_id);
    let id_list = all_ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let found: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM master_drugs WHERE id IN ({id_list})"
    ))
    .fetch_one(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    if found != all_ids.len() as i64 {
        return Err("أحد الأصناف تغيّر أو لم يعد موجوداً؛ حدّث شاشة التعارض".into());
    }

    // Revalidate the identity evidence under the same write transaction. The reviewed
    // group must still share at least one active barcode now; otherwise a stale screen
    // could merge a drug whose barcode was corrected in another window after review.
    let intended_target_barcode = payload
        .edits
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|edits| edits.get("barcode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|barcode| !barcode.is_empty())
        .map(|barcode| barcode.to_ascii_lowercase());
    let mut shared_codes: Option<HashSet<String>> = None;
    for id in &all_ids {
        let codes: Vec<String> = sqlx::query_scalar(
            "SELECT LOWER(TRIM(barcode)) FROM master_drugs WHERE id=? AND TRIM(COALESCE(barcode,''))!='' UNION SELECT LOWER(TRIM(barcode)) FROM inventory WHERE drug_id=? AND (quantity IS NULL OR quantity != 0) AND TRIM(COALESCE(barcode,''))!=''",
        )
        .bind(id)
        .bind(id)
        .fetch_all(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        let mut current = codes.into_iter().collect::<HashSet<_>>();
        if *id == payload.target_id {
            if let Some(barcode) = intended_target_barcode.as_ref() {
                current.insert(barcode.clone());
            }
        }
        shared_codes = Some(match shared_codes {
            None => current,
            Some(previous) => previous.intersection(&current).cloned().collect(),
        });
    }
    if shared_codes.as_ref().map_or(true, HashSet::is_empty) {
        return Err("تغيّر تعارض الباركود منذ فتح الشاشة؛ حدّث المراجعة قبل الدمج".into());
    }

    for source_id in &source_ids {
        replace_tx_with_allowed_collisions(
            tx,
            user_id,
            Replacement {
                source_id: *source_id,
                target_id: Some(payload.target_id),
                new_drug: None,
                edits: payload.edits.clone(),
                confirmed_same_product: true,
            },
            &all_ids,
            true,
        )
        .await?;
    }
    sqlx::query("INSERT INTO activity_log(user_id,action,details) VALUES (?,'RECONCILE_MASTER_DRUG_GROUP',?)")
        .bind(user_id)
        .bind(json!({"source_ids":source_ids,"target_id":payload.target_id,"confirmed_same_product":true,"edits":payload.edits}).to_string())
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    Ok(payload.target_id)
}

async fn replace_tx_with_allowed_collisions(
    tx: &mut Transaction<'_, Sqlite>,
    user_id: &str,
    payload: Replacement,
    allowed_collision_ids: &[i64],
    allow_reviewed_conversion_edits: bool,
) -> Result<i64, String> {
    let admin = sqlx::query(
        "SELECT role, permissions FROM users WHERE id=? AND is_active=1",
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|e| e.to_string())?;
    let Some(admin) = admin else {
        return Err("يلزم حساب مدير أو مالك نشط".into());
    };
    let role: Option<String> = admin.try_get("role").unwrap_or(None);
    let permissions: Option<String> = admin.try_get("permissions").unwrap_or(None);
    ensure_replacement_permission(role.as_deref(), permissions.as_deref())?;
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
        let mut conversion_edits = serde_json::Map::new();
        for field in ["large_unit", "medium_unit", "small_unit"] {
            if let Some(value) = data
                .get(field)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                conversion_edits.insert(field.to_string(), Value::String(value.to_string()));
            }
        }
        for field in ["large_to_medium", "medium_to_small"] {
            if let Some(value) = data
                .get(field)
                .filter(|value| !value.is_null() && value.as_str() != Some(""))
            {
                conversion_edits.insert(field.to_string(), value.clone());
            }
        }
        if !conversion_edits.is_empty() {
            let conversion_edits = Value::Object(conversion_edits);
            ensure_unit_conversion_edit_permission(
                tx,
                id,
                Some(&conversion_edits),
                role.as_deref(),
                permissions.as_deref(),
            )
            .await?;
        }
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
    ensure_unit_conversion_edit_permission(
        tx,
        target_id,
        payload.edits.as_ref(),
        role.as_deref(),
        permissions.as_deref(),
    )
    .await?;
    if target_id <= 0 || target_id == payload.source_id {
        return Err("اختر صنفاً بديلاً مختلفاً".into());
    }
    if let Some(edits) = payload.edits.as_ref() {
        apply_edits(tx, target_id, edits, allow_reviewed_conversion_edits).await?;
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
        if allow_reviewed_conversion_edits
            && matches!(field, "large_to_medium" | "medium_to_small")
            && payload
                .edits
                .as_ref()
                .and_then(Value::as_object)
                .is_some_and(|edits| edits.contains_key(field))
        {
            continue;
        }
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
    let mut allowed_ids = vec![payload.source_id, target_id];
    allowed_ids.extend(allowed_collision_ids.iter().copied().filter(|id| *id > 0));
    allowed_ids.sort_unstable();
    allowed_ids.dedup();
    let allowed = allowed_ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",");
    let collision_sql = format!("WITH codes AS (SELECT barcode FROM master_drugs WHERE id IN (?,?) UNION SELECT barcode FROM inventory WHERE drug_id IN (?,?) AND (quantity IS NULL OR quantity != 0)), owners AS (SELECT id drug_id,barcode FROM master_drugs UNION SELECT drug_id,barcode FROM inventory WHERE quantity IS NULL OR quantity != 0) SELECT COUNT(*) FROM owners o JOIN codes c ON TRIM(o.barcode)=TRIM(c.barcode) COLLATE NOCASE WHERE TRIM(COALESCE(c.barcode,''))!='' AND o.drug_id NOT IN ({allowed})");
    let collision: i64 = sqlx::query_scalar(&collision_sql)
        .bind(payload.source_id).bind(target_id).bind(payload.source_id).bind(target_id)
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
    if tables.iter().any(|t| t == "drug_catalog_links") {
        let source_catalog: Option<i64> = sqlx::query_scalar(
            "SELECT catalog_drug_id FROM drug_catalog_links WHERE master_drug_id=?",
        )
        .bind(payload.source_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        let target_catalog: Option<i64> = sqlx::query_scalar(
            "SELECT catalog_drug_id FROM drug_catalog_links WHERE master_drug_id=?",
        )
        .bind(target_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if source_catalog.is_some() && target_catalog.is_none() {
            sqlx::query("UPDATE drug_catalog_links SET master_drug_id=? WHERE master_drug_id=?")
                .bind(target_id)
                .bind(payload.source_id)
                .execute(&mut **tx)
                .await
                .map_err(|e| format!("تعذر نقل رابط دليل الدواء؛ لم يتم الدمج: {e}"))?;
        }
    }
    if tables.iter().any(|t| t == "drug_catalog_field_policies") {
        sqlx::query(
            "INSERT OR IGNORE INTO drug_catalog_field_policies(master_drug_id,field_name,policy,updated_by,updated_at) SELECT ?,field_name,policy,updated_by,updated_at FROM drug_catalog_field_policies WHERE master_drug_id=?",
        )
        .bind(target_id)
        .bind(payload.source_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("تعذر نقل سياسات دليل الدواء؛ لم يتم الدمج: {e}"))?;
    }
    if tables.iter().any(|t| t == "drug_indications") {
        sqlx::query(
            "INSERT OR IGNORE INTO drug_indications(drug_id,indication_id) SELECT ?,indication_id FROM drug_indications WHERE drug_id=?",
        )
        .bind(target_id)
        .bind(payload.source_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("تعذر نقل دواعي الاستعمال؛ لم يتم الدمج: {e}"))?;
        sqlx::query("DELETE FROM drug_indications WHERE drug_id=?")
            .bind(payload.source_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("تعذر تنظيف روابط دواعي الاستعمال؛ لم يتم الدمج: {e}"))?;
    }
    if tables.iter().any(|t| t == "drug_alternatives") {
        let pair_link: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM drug_alternatives WHERE (drug_id=? AND alternative_id=?) OR (drug_id=? AND alternative_id=?)",
        )
        .bind(payload.source_id)
        .bind(target_id)
        .bind(target_id)
        .bind(payload.source_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
        if pair_link > 0 {
            return Err("الصنفان مسجلان كبدائل لبعضهما؛ راجع الروابط الطبية قبل الدمج".into());
        }
        sqlx::query(
            "INSERT OR IGNORE INTO drug_alternatives(drug_id,alternative_id) SELECT ?,alternative_id FROM drug_alternatives WHERE drug_id=? AND alternative_id!=?",
        )
        .bind(target_id)
        .bind(payload.source_id)
        .bind(target_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("تعذر نقل روابط البدائل؛ لم يتم الدمج: {e}"))?;
        sqlx::query(
            "INSERT OR IGNORE INTO drug_alternatives(drug_id,alternative_id) SELECT drug_id,? FROM drug_alternatives WHERE alternative_id=? AND drug_id!=?",
        )
        .bind(target_id)
        .bind(payload.source_id)
        .bind(target_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| format!("تعذر نقل روابط البدائل؛ لم يتم الدمج: {e}"))?;
        sqlx::query("DELETE FROM drug_alternatives WHERE drug_id=? OR alternative_id=?")
            .bind(payload.source_id)
            .bind(payload.source_id)
            .execute(&mut **tx)
            .await
            .map_err(|e| format!("تعذر تنظيف روابط البدائل؛ لم يتم الدمج: {e}"))?;
    }
    for (table, columns) in REFS {
        if !tables.iter().any(|t| t == table) {
            continue;
        }
        if matches!(*table, "drug_catalog_links" | "drug_catalog_field_policies" | "drug_indications" | "drug_alternatives") {
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
    sqlx::query("UPDATE master_drugs SET barcode=COALESCE(NULLIF(TRIM(barcode),''),?) WHERE id=?")
        .bind(source_barcode)
        .bind(target_id)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    if tables.iter().any(|t| t == "cloud_drug_mappings") {
        // A manual merge invalidates only the identities participating in the
        // merge. Unrelated cloud mappings remain valid and are needed by
        // incremental sync to avoid remapping unaffected catalog rows.
        sqlx::query("DELETE FROM cloud_drug_mappings WHERE local_drug_id IN (?,?)")
            .bind(payload.source_id)
            .bind(target_id)
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
    allow_linked_conversion_edits: bool,
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
                if changed != 0 && !(factor && allow_linked_conversion_edits) {
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
            include_str!("../../migrations/018_unit_conversion_snapshots.sql"),
        ] {
            sqlx::raw_sql(sql).execute(&mut db).await.unwrap();
        }
        let mut tx = db.begin().await.unwrap();
        crate::schema::ensure_compatibility(&mut tx).await.unwrap();
        tx.commit().await.unwrap();
        sqlx::raw_sql(r#"INSERT INTO users(id,username,role,permissions,is_active) VALUES('admin','replacement-admin','admin','{"can_view_purchases":true,"can_modify_unit_conversion":true,"can_manage_inventory":true}',1),('cashier','replacement-cashier','cashier','{}',1) ON CONFLICT(id) DO UPDATE SET role=excluded.role,permissions=excluded.permissions,is_active=1;
          INSERT INTO master_drugs(id,trade_name,barcode,official_price,large_to_medium,notes) VALUES(10,'Old name','123',20,2,'keep'),(20,'Correct name',NULL,25,2,NULL);
          INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,local_selling_price,strips_per_box,barcode,expiry_date,batch_number) VALUES('old-lot',10,'local_default',1.5,10,20,2,'123','2030-01-01','old'),('target-lot',20,'local_default',0.5,11,22,2,NULL,'2030-02-01','other');
          INSERT INTO sales_invoices(id,user_id,total_amount,status) VALUES('historical','admin',30,'completed');
          INSERT INTO sales_items(id,invoice_id,drug_id,inventory_id,quantity_sold,unit_price,cost_price) VALUES(1,'historical',10,'old-lot',1,30,10);
          INSERT INTO returns(id,invoice_id,user_id,total_refund,status) VALUES('old-return','historical','admin',15,'completed');
          INSERT INTO return_items(return_id,drug_id,inventory_id,quantity_returned,unit_price,total_price,sale_item_id) VALUES('old-return',10,'old-lot',0.5,30,15,1);
          INSERT INTO suppliers(id,name_ar) VALUES(1,'Supplier');
          INSERT INTO shortages(drug_id,requested_quantity,notes) VALUES(10,3,'keep request');
          INSERT INTO cloud_drug_mappings(cloud_id,local_drug_id,last_cloud_name) VALUES(555,10,'Old name');"#).execute(&mut db).await.unwrap();
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

    #[tokio::test]
    async fn replacement_honors_explicit_inventory_management_denial() {
        let mut db = fixture().await;
        sqlx::query(r#"UPDATE users SET permissions='{"can_view_purchases":true,"can_manage_inventory":false}' WHERE id='admin'"#)
            .execute(&mut db)
            .await
            .unwrap();

        let mut tx = db.begin().await.unwrap();
        let result = replace_tx(&mut tx, "admin", payload(Some(20), None)).await;
        tx.rollback().await.unwrap();

        assert!(
            result.unwrap_err().contains("can_manage_inventory"),
            "replacement must honor the same explicit inventory-management denial as the UI"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM master_drugs WHERE id IN (10,20)")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn replacement_preserves_unrelated_cloud_drug_mappings() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            r#"
            INSERT INTO master_drugs(id,trade_name,barcode,official_price)
            VALUES(30,'Unrelated medicine','999',15);
            INSERT INTO cloud_drug_mappings(cloud_id,local_drug_id,last_cloud_name)
            VALUES(777,30,'Unrelated medicine');
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        replace_tx(&mut tx, "admin", payload(Some(20), None))
            .await
            .unwrap();
        tx.commit().await.unwrap();

        let unrelated: Option<i64> =
            sqlx::query_scalar("SELECT local_drug_id FROM cloud_drug_mappings WHERE cloud_id=777")
                .fetch_optional(&mut db)
                .await
                .unwrap();
        assert_eq!(
            unrelated,
            Some(30),
            "merging one drug must not invalidate cloud identity mappings for unrelated drugs"
        );
        let deleted_source_mapping: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM cloud_drug_mappings WHERE local_drug_id=10")
                .fetch_one(&mut db)
                .await
                .unwrap();
        assert_eq!(
            deleted_source_mapping, 0,
            "the mapping for the deleted source identity must be invalidated"
        );
    }
    #[tokio::test]
    async fn replacement_cannot_bypass_explicit_unit_conversion_permission_denial() {
        let mut db = fixture().await;
        sqlx::query(
            r#"UPDATE users SET permissions='{"can_view_purchases":true,"can_manage_inventory":true,"can_modify_unit_conversion":false}' WHERE id='admin'"#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        let mut denied = payload(Some(20), None);
        denied.edits = Some(json!({"large_unit":"carton"}));
        let error = replace_tx(&mut tx, "admin", denied).await.unwrap_err();
        assert!(error.contains("can_modify_unit_conversion"), "{error}");
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, Option<String>>("SELECT large_unit FROM master_drugs WHERE id=20")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT drug_id FROM inventory WHERE id='old-lot'")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            10
        );

        sqlx::query("UPDATE master_drugs SET large_unit='box' WHERE id=20")
            .execute(&mut db)
            .await
            .unwrap();
        let mut tx = db.begin().await.unwrap();
        let mut unchanged = payload(Some(20), None);
        unchanged.edits = Some(json!({"large_unit":"box"}));
        assert_eq!(replace_tx(&mut tx, "admin", unchanged).await.unwrap(), 20);
        tx.commit().await.unwrap();
    }
    #[tokio::test]
    async fn replacement_with_new_target_cannot_bypass_unit_label_permission_denial() {
        let mut db = fixture().await;
        sqlx::query(
            r#"UPDATE users SET permissions='{"can_view_purchases":true,"can_manage_inventory":true,"can_modify_unit_conversion":false}' WHERE id='admin'"#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let before_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM master_drugs")
            .fetch_one(&mut db)
            .await
            .unwrap();
        let mut tx = db.begin().await.unwrap();
        let denied = payload(
            None,
            Some(json!({
                "trade_name": "Reviewed replacement",
                "trade_name_en": "Reviewed replacement",
                "official_price": 25.0,
                "barcode": "123",
                "large_unit": "carton"
            })),
        );
        let error = replace_tx(&mut tx, "admin", denied).await.unwrap_err();
        assert!(error.contains("can_modify_unit_conversion"), "{error}");
        tx.rollback().await.unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM master_drugs")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            before_count,
            "permission denial must not leave a cloned target behind"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT drug_id FROM inventory WHERE id='old-lot'")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            10,
            "permission denial must not relink inventory"
        );

        let mut tx = db.begin().await.unwrap();
        let mut denied_via_edits = payload(
            None,
            Some(json!({
                "trade_name": "Reviewed replacement",
                "trade_name_en": "Reviewed replacement",
                "official_price": 25.0,
                "barcode": "123"
            })),
        );
        denied_via_edits.edits = Some(json!({"large_unit":"carton"}));
        let error = replace_tx(&mut tx, "admin", denied_via_edits)
            .await
            .unwrap_err();
        assert!(error.contains("can_modify_unit_conversion"), "{error}");
        tx.rollback().await.unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM master_drugs")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            before_count,
            "permission denial through final edits must not leave a cloned target behind"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT drug_id FROM inventory WHERE id='old-lot'")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            10,
            "permission denial through final edits must not relink inventory"
        );
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
        sqlx::raw_sql(
            r#"
            INSERT INTO purchase_invoices(id,supplier_id,user_id,invoice_number,invoice_date,status)
            VALUES('historical-purchase',1,'admin','HIST-1','2029-01-01','completed');
            INSERT INTO purchase_invoice_items(
              id,invoice_id,drug_id,quantity,expiry_date,cost_price,selling_price,inventory_id,barcode
            ) VALUES(700,'historical-purchase',10,1,'2030-01-01',10,20,'old-lot','123');
            INSERT INTO purchase_returns(
              id,supplier_id,user_id,purchase_invoice_id,total_amount,refund_method,status
            ) VALUES('historical-purchase-return',1,'admin','historical-purchase',10,'credit','completed');
            INSERT INTO purchase_return_items(
              id,purchase_return_id,inventory_id,drug_id,drug_name,quantity_returned,
              unit_price,total_price,purchase_invoice_item_id,unit
            ) VALUES(
              701,'historical-purchase-return','old-lot',10,'Old name',1,10,10,700,'large'
            );
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();
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
        let purchase_history: (i64, String, f64) = sqlx::query_as(
            "SELECT drug_id,inventory_id,cost_price FROM purchase_invoice_items WHERE id=700",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(purchase_history, (20, "old-lot".into(), 10.0));
        let purchase_return_history: (i64, String, i64, f64) = sqlx::query_as(
            "SELECT drug_id,inventory_id,purchase_invoice_item_id,total_price FROM purchase_return_items WHERE id=701",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(
            purchase_return_history,
            (20, "old-lot".into(), 700, 10.0)
        );
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
    async fn replacement_ignores_zero_stock_historical_alias_when_checking_third_owner_collision() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            r#"
            INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,local_selling_price,strips_per_box,barcode,expiry_date,batch_number)
            VALUES('historical-alias',10,'local_default',0,10,20,2,'999','2029-01-01','old-alias');
            INSERT INTO master_drugs(id,trade_name,barcode,official_price,large_to_medium)
            VALUES(30,'Legitimate new owner','999',25,2);
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        assert_eq!(
            replace_tx(&mut tx, "admin", payload(Some(20), None))
                .await
                .unwrap(),
            20
        );
        tx.commit().await.unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT drug_id FROM inventory WHERE id='historical-alias'")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            20
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT barcode FROM master_drugs WHERE id=30")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            "999"
        );
    }
    #[tokio::test]
    async fn group_replacement_resolves_three_barcode_owners_atomically_and_rejects_an_unselected_fourth() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            r#"
            UPDATE master_drugs SET barcode='123' WHERE id=20;
            INSERT INTO master_drugs(id,trade_name,barcode,official_price,large_to_medium,notes)
            VALUES(30,'Third duplicate','123',25,2,'third note');
            INSERT INTO master_drugs(id,trade_name,barcode,official_price,large_to_medium)
            VALUES(60,'Historical zero-stock alias',NULL,25,2),
                  (99,'Shared alternative',NULL,25,2);
            INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,local_selling_price,strips_per_box,barcode,expiry_date,batch_number)
            VALUES('third-lot',30,'local_default',2,12,25,2,'123','2030-04-01','third'),
                  ('historical-zero',60,'local_default',0,12,25,2,'123','2030-04-01','historical');
            INSERT INTO sales_items(id,invoice_id,drug_id,inventory_id,quantity_sold,unit_price,cost_price)
            VALUES(2,'historical',30,'third-lot',0.5,25,12);
            INSERT OR IGNORE INTO indications(id,name_ar,name_en) VALUES(900,'اختبار','Test');
            INSERT INTO drug_indications(drug_id,indication_id) VALUES(10,900),(20,900),(30,900);
            INSERT INTO drug_alternatives(drug_id,alternative_id) VALUES(10,99),(20,99),(30,99);
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        let result = replace_group_tx(
            &mut tx,
            "admin",
            GroupReplacement {
                source_ids: vec![10, 30],
                target_id: 20,
                edits: Some(json!({"trade_name":"Canonical medicine","notes":"canonical note"})),
                confirmed_same_product: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(result, 20);
        tx.commit().await.unwrap();

        let remaining: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM master_drugs WHERE id IN (10,20,30) ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(remaining, vec![20]);
        let lots: Vec<(String, i64)> = sqlx::query_as(
            "SELECT id,drug_id FROM inventory WHERE id IN ('old-lot','target-lot','third-lot') ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert!(lots.iter().all(|(_, drug_id)| *drug_id == 20));
        let sale_drugs: Vec<i64> = sqlx::query_scalar(
            "SELECT drug_id FROM sales_items WHERE id IN (1,2) ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(sale_drugs, vec![20, 20]);
        let total_stock: f64 = sqlx::query_scalar(
            "SELECT CAST(SUM(quantity) AS REAL) FROM inventory WHERE drug_id=20",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(total_stock, 4.0);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT trade_name FROM master_drugs WHERE id=20")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            "Canonical medicine"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT notes FROM master_drugs WHERE id=20")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            "canonical note"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM drug_indications WHERE drug_id=20 AND indication_id=900",
            )
            .fetch_one(&mut db)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM drug_alternatives WHERE drug_id=20 AND alternative_id=99",
            )
            .fetch_one(&mut db)
            .await
            .unwrap(),
            1
        );
        assert!(sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut db)
            .await
            .unwrap()
            .is_empty());

        let mut tx = db.begin().await.unwrap();
        super::super::critical::save_purchase_invoice_tx(&mut tx, purchase())
            .await
            .unwrap();
        tx.commit().await.unwrap();

        sqlx::query(
            "INSERT INTO master_drugs(id,trade_name,barcode,official_price,large_to_medium) VALUES(40,'Unselected fourth','123',25,2)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO master_drugs(id,trade_name,barcode,official_price,large_to_medium) VALUES(50,'Another duplicate','123',25,2)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        let mut tx = db.begin().await.unwrap();
        let error = replace_group_tx(
            &mut tx,
            "admin",
            GroupReplacement {
                source_ids: vec![50],
                target_id: 20,
                edits: None,
                confirmed_same_product: true,
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("ثالث") || error.contains("التعارض"), "{error}");
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM master_drugs WHERE id IN (20,40,50)",
            )
            .fetch_one(&mut db)
            .await
            .unwrap(),
            3
        );
    }

    #[tokio::test]
    async fn group_replacement_can_set_reviewed_medium_and_small_units_without_rewriting_history() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            r#"
            UPDATE master_drugs
            SET barcode='123', medium_unit='old-strip', small_unit='old-tablet',
                large_to_medium=2, medium_to_small=1
            WHERE id=10;
            UPDATE master_drugs
            SET barcode='123', medium_unit='other-strip', small_unit='other-tablet',
                large_to_medium=3, medium_to_small=2
            WHERE id=20;
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let historical_before: (i64, i64) = sqlx::query_as(
            "SELECT large_to_medium, medium_to_small FROM sales_items WHERE id=1",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        let lots_before: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT id, strips_per_box, medium_to_small FROM inventory WHERE id IN ('old-lot','target-lot') ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        let target = replace_group_tx(
            &mut tx,
            "admin",
            GroupReplacement {
                source_ids: vec![10],
                target_id: 20,
                edits: Some(json!({
                    "medium_unit": "strip",
                    "small_unit": "tablet",
                    "large_to_medium": 10,
                    "medium_to_small": 10
                })),
                confirmed_same_product: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(target, 20);
        tx.commit().await.unwrap();

        let canonical: (String, String, i64, i64) = sqlx::query_as(
            "SELECT medium_unit, small_unit, large_to_medium, medium_to_small FROM master_drugs WHERE id=20",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(canonical, ("strip".into(), "tablet".into(), 10, 10));

        let historical_after: (i64, i64) = sqlx::query_as(
            "SELECT large_to_medium, medium_to_small FROM sales_items WHERE id=1",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(historical_after, historical_before);

        let lots_after: Vec<(String, i64, i64)> = sqlx::query_as(
            "SELECT id, strips_per_box, medium_to_small FROM inventory WHERE id IN ('old-lot','target-lot') ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(lots_after, lots_before);
    }

    #[tokio::test]
    async fn group_replacement_still_rejects_unresolved_conversion_mismatch() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            r#"
            UPDATE master_drugs SET barcode='123', large_to_medium=2, medium_to_small=1 WHERE id=10;
            UPDATE master_drugs SET barcode='123', large_to_medium=3, medium_to_small=2 WHERE id=20;
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        let error = replace_group_tx(
            &mut tx,
            "admin",
            GroupReplacement {
                source_ids: vec![10],
                target_id: 20,
                edits: Some(json!({"medium_unit":"strip","small_unit":"tablet"})),
                confirmed_same_product: true,
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("large_to_medium") || error.contains("medium_to_small"), "{error}");
        tx.rollback().await.unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM master_drugs WHERE id IN (10,20)")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn group_replacement_cannot_bypass_explicit_unit_conversion_permission_denial() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            r#"
            UPDATE users
            SET permissions='{"can_view_purchases":true,"can_manage_inventory":true,"can_modify_unit_conversion":false}'
            WHERE id='admin';
            UPDATE master_drugs SET barcode='123' WHERE id=20;
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        let error = replace_group_tx(
            &mut tx,
            "admin",
            GroupReplacement {
                source_ids: vec![10],
                target_id: 20,
                edits: Some(json!({
                    "medium_unit":"strip",
                    "small_unit":"tablet",
                    "large_to_medium":10,
                    "medium_to_small":10
                })),
                confirmed_same_product: true,
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("can_modify_unit_conversion"), "{error}");
        tx.rollback().await.unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM master_drugs WHERE id IN (10,20)")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            2
        );
    }

    #[tokio::test]
    async fn group_replacement_revalidates_that_all_reviewed_owners_still_share_an_active_barcode() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            r#"
            UPDATE master_drugs SET barcode='123' WHERE id=20;
            INSERT INTO master_drugs(id,trade_name,barcode,official_price,large_to_medium)
            VALUES(30,'Third duplicate','123',25,2);
            -- Simulate another window correcting this owner after the review UI loaded.
            UPDATE master_drugs SET barcode='789' WHERE id=30;
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        let error = replace_group_tx(
            &mut tx,
            "admin",
            GroupReplacement {
                source_ids: vec![10, 30],
                target_id: 20,
                edits: None,
                confirmed_same_product: true,
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("تغيّر") || error.contains("حدّث"), "{error}");
        tx.rollback().await.unwrap();

        let remaining: Vec<(i64, Option<String>)> = sqlx::query_as(
            "SELECT id,barcode FROM master_drugs WHERE id IN (10,20,30) ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(remaining.len(), 3);
        assert_eq!(remaining[2], (30, Some("789".into())));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT drug_id FROM inventory WHERE id='old-lot'")
                .fetch_one(&mut db)
                .await
                .unwrap(),
            10
        );
    }
    #[tokio::test]
    async fn group_replacement_accepts_an_explicit_pending_barcode_for_the_external_canonical_target() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            r#"
            UPDATE master_drugs SET barcode='123' WHERE id=20;
            INSERT INTO master_drugs(id,trade_name,barcode,official_price,large_to_medium)
            VALUES(30,'Edited canonical','789',25,2);
            INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,local_selling_price,strips_per_box,barcode,expiry_date,batch_number)
            VALUES('second-owner-lot',20,'local_default',2,11,25,2,'123','2030-05-01','second-owner');
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        let target = replace_group_tx(
            &mut tx,
            "admin",
            GroupReplacement {
                source_ids: vec![10, 20],
                target_id: 30,
                edits: Some(json!({"barcode":"123","trade_name":"Reviewed canonical"})),
                confirmed_same_product: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(target, 30);
        tx.commit().await.unwrap();

        let remaining: Vec<i64> = sqlx::query_scalar(
            "SELECT id FROM master_drugs WHERE id IN (10,20,30) ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(remaining, vec![30]);
        let target_row: (String, String) = sqlx::query_as(
            "SELECT trade_name,barcode FROM master_drugs WHERE id=30",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(target_row, ("Reviewed canonical".into(), "123".into()));
        let moved: Vec<i64> = sqlx::query_scalar(
            "SELECT drug_id FROM inventory WHERE id IN ('old-lot','target-lot','second-owner-lot') ORDER BY id",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert!(moved.iter().all(|drug_id| *drug_id == 30));
        assert!(sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut db)
            .await
            .unwrap()
            .is_empty());
    }
    #[tokio::test]
    async fn replacement_preserves_catalog_identity_and_policies_after_migration_027() {
        let mut db = fixture().await;
        sqlx::raw_sql(include_str!("../../migrations/027_drug_catalog_reconciliation.sql"))
            .execute(&mut db)
            .await
            .unwrap();
        sqlx::raw_sql(
            r#"
            INSERT INTO drug_catalog_links(catalog_drug_id,master_drug_id,linked_by) VALUES(10010,10,'test');
            INSERT INTO drug_catalog_field_policies(master_drug_id,field_name,policy) VALUES(10,'manufacturer','local'),(20,'manufacturer','catalog'),(10,'notes','local');
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        replace_tx(&mut tx, "admin", payload(Some(20), None))
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT master_drug_id FROM drug_catalog_links WHERE catalog_drug_id=10010",
            )
            .fetch_one(&mut db)
            .await
            .unwrap(),
            20
        );
        let policies: Vec<(String, String)> = sqlx::query_as(
            "SELECT field_name,policy FROM drug_catalog_field_policies WHERE master_drug_id=20 ORDER BY field_name",
        )
        .fetch_all(&mut db)
        .await
        .unwrap();
        assert_eq!(
            policies,
            vec![
                ("manufacturer".into(), "catalog".into()),
                ("notes".into(), "local".into()),
            ]
        );
        let suppressions: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM drug_catalog_suppressions WHERE catalog_drug_id=10010",
        )
        .fetch_one(&mut db)
        .await
        .unwrap();
        assert_eq!(suppressions, 0);

        sqlx::query(
            "INSERT INTO master_drugs(id,trade_name,barcode,official_price,large_to_medium) VALUES(30,'Linked duplicate','123',25,2)",
        )
        .execute(&mut db)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO drug_catalog_links(catalog_drug_id,master_drug_id,linked_by) VALUES(10030,30,'test')",
        )
        .execute(&mut db)
        .await
        .unwrap();
        let mut tx = db.begin().await.unwrap();
        replace_tx(&mut tx, "admin", Replacement {
            source_id: 30,
            target_id: Some(20),
            new_drug: None,
            edits: None,
            confirmed_same_product: true,
        })
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM drug_catalog_links WHERE catalog_drug_id=10030",
            )
            .fetch_one(&mut db)
            .await
            .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT reason FROM drug_catalog_suppressions WHERE catalog_drug_id=10030",
            )
            .fetch_one(&mut db)
            .await
            .unwrap(),
            "deleted_locally"
        );
    }
    #[tokio::test]
    async fn explicit_barcode_correction_moves_only_active_aliases_and_preserves_history() {
        let mut db = fixture().await;
        sqlx::raw_sql(
            r#"
            UPDATE master_drugs SET barcode='123' WHERE id=20;
            INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,cost_price,local_selling_price,strips_per_box,barcode,expiry_date,batch_number)
            VALUES('historical-zero',10,'local_default',0,10,20,2,'123','2029-01-01','old-zero');
            "#,
        )
        .execute(&mut db)
        .await
        .unwrap();

        let mut tx = db.begin().await.unwrap();
        correct_barcode_conflict_tx(
            &mut tx,
            "admin",
            BarcodeCorrection {
                drug_id: 10,
                conflicting_barcode: "123".into(),
                replacement_barcode: Some("456".into()),
            },
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT barcode FROM master_drugs WHERE id=10")
                .fetch_one(&mut db).await.unwrap(),
            "456"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT barcode FROM inventory WHERE id='old-lot'")
                .fetch_one(&mut db).await.unwrap(),
            "456"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT barcode FROM inventory WHERE id='historical-zero'")
                .fetch_one(&mut db).await.unwrap(),
            "123"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT barcode FROM master_drugs WHERE id=20")
                .fetch_one(&mut db).await.unwrap(),
            "123"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT drug_id FROM sales_items WHERE id=1")
                .fetch_one(&mut db).await.unwrap(),
            10
        );

        sqlx::query("INSERT INTO master_drugs(id,trade_name,barcode,official_price,large_to_medium) VALUES(30,'Other code owner','789',25,2)")
            .execute(&mut db).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        let error = correct_barcode_conflict_tx(
            &mut tx,
            "admin",
            BarcodeCorrection {
                drug_id: 10,
                conflicting_barcode: "456".into(),
                replacement_barcode: Some("789".into()),
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("باركود") || error.contains("barcode"), "{error}");
        tx.rollback().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT barcode FROM master_drugs WHERE id=10")
                .fetch_one(&mut db).await.unwrap(),
            "456"
        );

        sqlx::raw_sql("UPDATE master_drugs SET barcode=NULL WHERE id=10; UPDATE master_drugs SET barcode='456' WHERE id=20;")
            .execute(&mut db).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        correct_barcode_conflict_tx(
            &mut tx,
            "admin",
            BarcodeCorrection {
                drug_id: 10,
                conflicting_barcode: "456".into(),
                replacement_barcode: Some("555".into()),
            },
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT barcode FROM master_drugs WHERE id=10")
                .fetch_one(&mut db).await.unwrap(),
            "555"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT barcode FROM inventory WHERE id='old-lot'")
                .fetch_one(&mut db).await.unwrap(),
            "555"
        );
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
