#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod database_backup;
mod database_maintenance;
mod licensing;
mod licensing_config;
mod licensing_online;
mod legacy_upgrade_guard;
#[cfg(any(test, feature = "owner-maintenance-cli"))]
mod historical_import_authorization;
#[cfg(any(test, feature = "owner-maintenance-cli"))]
mod primary_pharmacy_copy_cli;
#[cfg(any(test, feature = "owner-maintenance-cli"))]
mod primary_pharmacy_upgrade;
#[cfg(test)]
mod native_sqlx_069_disposable_qa;
#[cfg(windows)]
mod licensing_tpm;
mod schema;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use sha2::{Digest, Sha256};
use sqlx::Connection;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};

const PURCHASE_DRAFT_ACCELERATOR: &str = "F10";

fn rollback_window_transactions(app: &tauri::AppHandle, label: &str) {
    let before = std::time::Instant::now();
    app.state::<commands::critical::DbTransactions>()
        .note_window_reset(label, before);
    let app = app.clone();
    let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = app
            .state::<commands::critical::DbTransactions>()
            .rollback_window(&label, before)
            .await
        {
            eprintln!("failed to roll back abandoned window transactions: {error}");
        }
    });
}

// ponytail: Windows exposes readonly as a single flag; Unix needs only owner-write restored.
#[allow(clippy::permissions_set_readonly_false)]
fn make_writable(path: &Path, mut permissions: fs::Permissions) -> io::Result<()> {
    #[cfg(windows)]
    permissions.set_readonly(false);
    #[cfg(unix)]
    permissions.set_mode(permissions.mode() | 0o200);
    fs::set_permissions(path, permissions)
}

#[tauri::command]
fn log_frontend_error(message: String) {
    println!("FE: {}", message);
}

/// Read-only native decision support while startup is quarantined. A valid
/// license permits seeing *aggregate* single-pharmacy scope eligibility, not
/// owner enrollment, a tenant grant, or any profile mutation. In particular,
/// this command deliberately cannot clear startup_upgrade_blocked.
#[tauri::command]
async fn primary_pharmacy_upgrade_preview(
    app: tauri::AppHandle,
) -> Result<legacy_upgrade_guard::SinglePharmacyUpgradePreview, String> {
    let state = app.state::<licensing::LicenseGuard>();
    let status = state.status();
    if !status.valid || !status.startup_upgrade_blocked || status.startup_ready {
        return Err("Legacy upgrade preview requires a valid, quarantined native profile".into());
    }
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?
        .join("pharma_local.db");
    legacy_upgrade_guard::inspect_single_pharmacy_candidate(&path).await
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeAdminMenuAccess {
    staff: bool,
    staff_manage: bool,
    staff_roles: bool,
    audit: bool,
    settings: bool,
    #[serde(default)]
    allowed_route_ids: Vec<String>,
}

impl NativeAdminMenuAccess {
    fn allows_route(&self, id: &str) -> bool {
        self.allowed_route_ids.iter().any(|allowed| allowed == id)
    }
}

#[derive(Clone, Copy)]
struct NativeRouteMenuItem {
    id: &'static str,
    label: &'static str,
    accelerator: Option<&'static str>,
}

fn create_route_submenu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    title: &str,
    access: &NativeAdminMenuAccess,
    items: &[NativeRouteMenuItem],
) -> Result<Option<Submenu<R>>, tauri::Error> {
    let visible_items: Vec<_> = items
        .iter()
        .filter(|item| access.allows_route(item.id))
        .collect();
    if visible_items.is_empty() {
        return Ok(None);
    }

    let submenu = Submenu::new(app, title, true)?;
    for item in visible_items {
        let menu_item = MenuItem::with_id(app, item.id, item.label, true, item.accelerator)?;
        submenu.append(&menu_item)?;
    }
    Ok(Some(submenu))
}

fn create_admin_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    access: NativeAdminMenuAccess,
) -> Result<Option<Submenu<R>>, tauri::Error> {
    if !access.staff
        && !access.staff_manage
        && !access.staff_roles
        && !access.audit
        && !access.settings
    {
        return Ok(None);
    }

    let admin_menu = Submenu::new(app, "الإدارة", true)?;
    for (visible, id, label) in [
        (access.staff, "staff", "أداء الموظفين"),
        (access.staff_manage, "staff_manage", "إدارة الموظفين"),
        (access.staff_roles, "staff_roles", "الوظائف والرواتب"),
        (access.audit, "audit", "سجل المراقبة"),
        (access.settings, "settings", "الإعدادات"),
    ] {
        if visible {
            let item = MenuItem::with_id(app, id, label, true, None::<&str>)?;
            admin_menu.append(&item)?;
        }
    }

    Ok(Some(admin_menu))
}

#[tauri::command]
async fn open_new_window<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    open_new_window_for_app(&app)
}

fn open_new_window_for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let url = new_window_url(app);

    let w = tauri::WebviewWindowBuilder::new(app, new_window_label(), url)
        .title("Pharma Dashboard")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .build()
        .map_err(|e| e.to_string())?;

    if let Ok(menu) = create_app_menu(app, NativeAdminMenuAccess::default()) {
        let _ = w.set_menu(menu);
    }

    w.on_menu_event(move |win, event| {
        handle_menu_event(win, event.id().as_ref());
    });

    Ok(())
}

fn new_window_label() -> String {
    format!("window_{}", uuid::Uuid::new_v4().simple())
}

fn create_app_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    admin_access: NativeAdminMenuAccess,
) -> Result<Menu<R>, tauri::Error> {
    // 1. ملف (File)
    let file_menu = Submenu::new(app, "ملف", true)?;
    let mut has_file_route = false;
    for item in [
        NativeRouteMenuItem {
            id: "pos",
            label: "فاتورة مبيعات جديدة",
            accelerator: Some("CmdOrCtrl+P"),
        },
        NativeRouteMenuItem {
            id: "purchases_new",
            label: "فاتورة مشتريات جديدة",
            accelerator: None,
        },
    ] {
        if admin_access.allows_route(item.id) {
            let menu_item = MenuItem::with_id(app, item.id, item.label, true, item.accelerator)?;
            file_menu.append(&menu_item)?;
            has_file_route = true;
        }
    }
    if admin_access.allows_route("purchases_new") {
        file_menu.append(&MenuItem::with_id(
            app,
            "purchase_save_draft",
            "حفظ فاتورة الشراء كمسودة",
            true,
            Some(PURCHASE_DRAFT_ACCELERATOR),
        )?)?;
        has_file_route = true;
    }
    if has_file_route {
        file_menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    file_menu.append(&MenuItem::with_id(
        app,
        "new_window",
        "نافذة جديدة",
        true,
        Some("CmdOrCtrl+N"),
    )?)?;
    file_menu.append(&PredefinedMenuItem::separator(app)?)?;
    file_menu.append(&MenuItem::with_id(
        app,
        "print",
        "طباعة",
        true,
        Some("CmdOrCtrl+Shift+P"),
    )?)?;
    file_menu.append(&PredefinedMenuItem::separator(app)?)?;
    file_menu.append(&MenuItem::with_id(
        app,
        "logout",
        "تسجيل الخروج",
        true,
        None::<&str>,
    )?)?;
    file_menu.append(&PredefinedMenuItem::separator(app)?)?;
    file_menu.append(&PredefinedMenuItem::quit(app, None)?)?;

    // 2. البيانات الأساسية (Master Data)
    let master_data_menu = create_route_submenu(
        app,
        "البيانات الأساسية",
        &admin_access,
        &[
            NativeRouteMenuItem {
                id: "dashboard",
                label: "لوحة التحكم (الرئيسية)",
                accelerator: Some("CmdOrCtrl+D"),
            },
            NativeRouteMenuItem {
                id: "stores_items",
                label: "الأصناف",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_alternatives",
                label: "البدائل",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_nature",
                label: "النوع",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_usage",
                label: "الاستخدام",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_units",
                label: "الوحدات",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_indications",
                label: "دواعي الاستعمال",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_drug_indications",
                label: "الاصناف ودواعي الاستخدام",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_manufacturers",
                label: "الشركات المنتجة",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_scientific_groups",
                label: "المجموعات العلمية",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_categories",
                label: "التصنيفات",
                accelerator: None,
            },
        ],
    )?;

    // 3. العمليات المخزنية (Inventory Ops)
    let inventory_ops_menu = create_route_submenu(
        app,
        "العمليات المخزنية",
        &admin_access,
        &[
            NativeRouteMenuItem {
                id: "inventory",
                label: "المخزون",
                accelerator: Some("CmdOrCtrl+I"),
            },
            NativeRouteMenuItem {
                id: "stores_shortages",
                label: "كشكول النواقص",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "inventory_item_movements",
                label: "حركات الأصناف",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "restock",
                label: "إعادة التموين",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "inventory_opening_balances",
                label: "الأرصدة الإفتتاحية",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_adjustments",
                label: "التعديلات",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_adjustment_reasons",
                label: "أسباب التعديل",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "inventory_settlement",
                label: "تسوية المخزون",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "stores_delete_items",
                label: "حذف الأصناف",
                accelerator: None,
            },
        ],
    )?;

    // 4. المبيعات (Sales)
    let sales_menu = create_route_submenu(
        app,
        "المبيعات",
        &admin_access,
        &[
            NativeRouteMenuItem {
                id: "pos",
                label: "فاتورة مبيعات جديدة",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "receipts",
                label: "الفواتير",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "sales",
                label: "المبيعات والتحصيل",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "sales_delivery",
                label: "توصيل منزلي",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "sales_cogs",
                label: "تعديل التكلفة",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "returns",
                label: "مرتجعات العملاء",
                accelerator: None,
            },
        ],
    )?;

    // 5. المشتريات (Purchases)
    let purchases_menu = create_route_submenu(
        app,
        "المشتريات",
        &admin_access,
        &[
            NativeRouteMenuItem {
                id: "purchases",
                label: "المشتريات",
                accelerator: Some("CmdOrCtrl+O"),
            },
            NativeRouteMenuItem {
                id: "purchase_orders",
                label: "أوامر الشراء",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "purchases_suppliers",
                label: "الموردون",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "purchases_returns",
                label: "مرتجعات للموردين",
                accelerator: None,
            },
        ],
    )?;

    // 6. المالية (Finance)
    let finance_menu = create_route_submenu(
        app,
        "المالية",
        &admin_access,
        &[
            NativeRouteMenuItem {
                id: "accounts",
                label: "الحسابات والمالية",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "accounts_cash_transactions",
                label: "حركة النقدية",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "finance_banks",
                label: "البنوك",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "finance_cards",
                label: "البطاقات والماكينات",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "finance_pos_management",
                label: "إدارة نقاط البيع",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "finance_accounts",
                label: "شجرة الحسابات",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "accounts_settings_trial_balance",
                label: "إعدادات ميزان المراجعة",
                accelerator: None,
            },
        ],
    )?;

    // 7. التقارير (Reports)
    let reports_menu = create_route_submenu(
        app,
        "التقارير",
        &admin_access,
        &[
            NativeRouteMenuItem {
                id: "reports",
                label: "لوحة التقارير",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "reports_sales2",
                label: "تقارير المبيعات",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "reports_purchases",
                label: "تقارير المشتريات",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "reports_trial_balance",
                label: "ميزان المراجعة",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "expenses",
                label: "المصروفات",
                accelerator: None,
            },
        ],
    )?;

    // 8. المرضى والطبية (Patients)
    let patients_menu = create_route_submenu(
        app,
        "المرضى والطبية",
        &admin_access,
        &[
            NativeRouteMenuItem {
                id: "patients",
                label: "المرضى",
                accelerator: None,
            },
            NativeRouteMenuItem {
                id: "interactions",
                label: "التفاعلات الدوائية",
                accelerator: None,
            },
        ],
    )?;

    // 9. الإدارة (Administration)
    let admin_menu = create_admin_menu(app, admin_access.clone())?;

    // 10. مساعدة (Help)
    let help_menu = Submenu::with_items(
        app,
        "مساعدة",
        true,
        &[
            &MenuItem::with_id(app, "update_program", "تحديث البرنامج", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "help_shortcuts",
                "اختصارات لوحة المفاتيح",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(app, "help_about", "عن النظام", true, None::<&str>)?,
        ],
    )?;

    let mut menu_items: Vec<&dyn IsMenuItem<R>> = vec![&help_menu];
    if let Some(ref reports_menu) = reports_menu {
        menu_items.push(reports_menu);
    }
    if let Some(ref admin_menu) = admin_menu {
        menu_items.push(admin_menu);
    }
    if let Some(ref patients_menu) = patients_menu {
        menu_items.push(patients_menu);
    }
    if let Some(ref finance_menu) = finance_menu {
        menu_items.push(finance_menu);
    }
    if let Some(ref purchases_menu) = purchases_menu {
        menu_items.push(purchases_menu);
    }
    if let Some(ref sales_menu) = sales_menu {
        menu_items.push(sales_menu);
    }
    if let Some(ref inventory_ops_menu) = inventory_ops_menu {
        menu_items.push(inventory_ops_menu);
    }
    if let Some(ref master_data_menu) = master_data_menu {
        menu_items.push(master_data_menu);
    }
    menu_items.push(&file_menu);

    Menu::with_items(app, &menu_items)
}

#[tauri::command]
fn sync_native_admin_menu<R: tauri::Runtime>(
    window: tauri::Window<R>,
    access: NativeAdminMenuAccess,
) -> Result<(), String> {
    let menu = create_app_menu(window.app_handle(), access).map_err(|error| error.to_string())?;
    window
        .set_menu(menu)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn new_window_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::WebviewUrl {
    #[cfg(not(debug_assertions))]
    let _ = app;

    #[cfg(debug_assertions)]
    {
        if let Some(dev_url) = &app.config().build.dev_url {
            return tauri::WebviewUrl::External(dev_url.clone());
        }
    }

    tauri::WebviewUrl::App("index.html".into())
}

/// Export destination is chosen by the native OS dialog, not by a renderer
/// controlled path. Never overwrite an existing file or a database. Stock
/// exports do NOT authorize a complete private finance/back-up disclosure.
#[tauri::command]
async fn save_workbook_export_native(
    app: tauri::AppHandle,
    session: tauri::State<'_, commands::auth::LocalSessionState>,
    kind: String,
    data: Vec<u8>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let required_permission = match kind.as_str() {
        "inventory" => "can_view_inventory",
        "catalog" => "can_manage_inventory",
        _ => return Err("Unsupported protected workbook export".into()),
    };
    if data.len() > 32 * 1024 * 1024 || !data.starts_with(b"PK\x03\x04") {
        return Err("Invalid or oversized Excel export".into());
    }
    let actor = session
        .authorize_session()
        .await?
        .clone()
        .ok_or("Native login is required for workbook export")?;
    // Permission may be revoked while the native Save dialog is displayed.
    // Resolve it against the live database both before and after the dialog.
    let pool = app
        .try_state::<commands::critical::GuardedReadPool>()
        .ok_or("Database initialization incomplete")?;
    async fn authorize_export(
        pool: &commands::critical::GuardedReadPool,
        actor: &str,
        permission: &str,
    ) -> Result<(), String> {
        let mut conn = pool.0.acquire().await.map_err(|e| e.to_string())?;
        let (role, _) = commands::critical::active_generic_actor(&mut conn, actor).await?;
        let permissions: Option<String> = sqlx::query_scalar(
            "SELECT permissions FROM main.users WHERE CAST(id AS TEXT)=? AND COALESCE(is_active,1)=1"
        ).bind(actor).fetch_one(&mut *conn).await.map_err(|e| e.to_string())?;
        if !commands::permission_policy::user_has_permission(
            Some(&role),
            permissions.as_deref(),
            permission,
            false,
        ) && !(permission == "can_view_inventory"
            && commands::permission_policy::user_has_permission(
                Some(&role),
                permissions.as_deref(),
                "can_manage_inventory",
                false,
            ))
        {
            return Err("Current native actor cannot export this workbook".into());
        }
        Ok(())
    }
    authorize_export(&pool, &actor, required_permission).await?;
    let suggested_name = match kind.as_str() {
        "inventory" => "inventory_export.xlsx",
        _ => "master_drugs_export.xlsx",
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Excel workbook", &["xlsx"])
        .set_file_name(suggested_name)
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let selected = receiver
        .await
        .map_err(|_| "Native export dialog closed unexpectedly")?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let destination = selected.into_path().map_err(|e| e.to_string())?;
    let destination_str = destination.to_str().ok_or("Export path is not Unicode")?;
    validate_export_file(destination_str, &data)?;
    let active_after_dialog = session
        .authorize_session()
        .await?
        .clone()
        .ok_or("Native login expired during export dialog")?;
    if active_after_dialog != actor {
        return Err("Native account changed while choosing export path".into());
    }
    authorize_export(&pool, &actor, required_permission).await?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    validate_native_export_destination(&destination, &app_data)?;
    // CREATE_NEW is the final atomic no-overwrite guard, including any
    // existing symlink/reparse-point leaf. Never use std::fs::write here.
    write_new_workbook_file(&destination, &data)?;
    Ok(Some(destination.to_string_lossy().into_owned()))
}

fn write_new_workbook_file(destination: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    // CREATE_NEW, not a preflight exists() check, prevents overwrite races.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|e| format!("Refusing to overwrite workbook export: {e}"))?;
    let outcome = file.write_all(data).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = outcome {
        // The just-created file is not an approved recovery point. Never
        // delete an existing file, only this exclusive newly created leaf.
        let _ = std::fs::remove_file(destination);
        return Err(format!("Workbook export was not completed: {error}"));
    }
    Ok(())
}

fn validate_native_export_destination(destination: &Path, app_data: &Path) -> Result<(), String> {
    if !destination.is_absolute() {
        return Err("Workbook export requires a native absolute path".into());
    }
    let parent = destination
        .parent()
        .ok_or("Workbook export directory is missing")?;
    let parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if let Ok(data) = std::fs::canonicalize(app_data) {
        if parent.starts_with(data) {
            return Err("Cannot place workbook export inside the live database directory".into());
        }
    }
    if destination.exists() || std::fs::symlink_metadata(destination).is_ok() {
        return Err("Cannot overwrite an existing workbook export".into());
    }
    Ok(())
}

fn validate_export_file(path: &str, data: &[u8]) -> Result<(), String> {
    // Renderer-originated bytes are untrusted even after a native scoped
    // inventory read. Bound the disk write and require a ZIP local-file
    // signature instead of accepting arbitrary text that begins with "PK".
    if data.len() > 32 * 1024 * 1024 {
        return Err("Export exceeds 32 MiB output limit".into());
    }
    let path = Path::new(path);
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("xlsx"))
        != Some(true)
    {
        return Err("Only .xlsx exports are allowed".into());
    }
    if !data.starts_with(b"PK\x03\x04") {
        return Err("Invalid .xlsx export data".into());
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        if !parent.is_dir() {
            return Err("Export directory does not exist".into());
        }
    }
    if path.exists()
        && path
            .symlink_metadata()
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("Refusing to overwrite a symlink".into());
    }
    Ok(())
}

// This is the independently observed, business-empty repository seed. A new
// resource requires a separately audited exact SHA and census before it may
// become a first-run installation. A license, empty user input, or a missing
// target DB never makes an arbitrary SQLite source eligible.
const FRESH_PRIMARY_SEED_SHA256: &str =
    "8ed7a0aa73b636bb95b29b03eecbb218e2e672c7ddd5ef577f2f50f4eb9e18c3";
const FRESH_PRIMARY_SEED_BYTES: u64 = 58_687_488;
const FRESH_PRIMARY_SCOPE: &str = "primary_pharmacy";

fn seed_denied(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn seed_file_sha256(file: &mut File) -> io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut block = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut block)?;
        if count == 0 {
            break;
        }
        hash.update(&block[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn refuse_existing_seed_target(destination: &Path) -> io::Result<()> {
    match fs::symlink_metadata(destination) {
        Ok(_) => return Err(io::Error::new(io::ErrorKind::AlreadyExists, "Pharmacy profile already exists")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = destination.as_os_str().to_os_string();
        sidecar.push(suffix);
        match fs::symlink_metadata(std::path::Path::new(&sidecar)) {
            Ok(_) => return Err(io::Error::new(io::ErrorKind::AlreadyExists, "Existing SQLite sidecar blocks first install")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn refuse_seed_sidecars(source: &Path) -> io::Result<()> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = source.as_os_str().to_os_string();
        sidecar.push(suffix);
        match fs::symlink_metadata(std::path::Path::new(&sidecar)) {
            Ok(_) => return Err(seed_denied("Bundled seed has active or unsafe SQLite sidecars")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

// A content pin alone does not prove the candidate is devoid of business
// history. The census also refuses populated extension tables: only the known
// static catalog/reference rows and one unscoped bootstrap owner are allowed.
async fn verify_fresh_primary_seed(
    database: &mut sqlx::SqliteConnection,
    owner_scope: Option<&str>,
) -> io::Result<()> {
    let users: Vec<(String, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT id, role, is_active, pharmacy_id FROM users",
    )
    .fetch_all(&mut *database)
    .await
    .map_err(|_| seed_denied("Fresh seed owner contract is missing"))?;
    if users.len() != 1
        || users[0].0 != "admin"
        || users[0].1 != "owner"
        || users[0].2 != 1
        || users[0].3.as_deref() != owner_scope
    {
        return Err(seed_denied("Fresh seed must have exactly one original owner"));
    }
    let ledger: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
    )
    .fetch_one(&mut *database)
    .await
    .map_err(|_| seed_denied("Cannot inspect seed migration ledger"))?;
    if ledger != 0 {
        return Err(seed_denied("Migrated history cannot be reclassified as a fresh seed"));
    }
    const REFERENCE_TABLES: &[&str] = &[
        "users",
        "accounts",
        "trial_balance_settings",
        "units",
        "scientific_groups",
        "item_natures",
        "product_categories",
        "manufacturers",
        "catalog_csv_reference",
        "master_drugs",
        "drug_interactions",
        // Content-linked full-text search indexes for the bundled drug catalog.
        "master_drugs_fts",
        "master_drugs_fts_data",
        "master_drugs_fts_idx",
        "master_drugs_fts_docsize",
        "master_drugs_fts_config",
    ];
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='table' \
         AND substr(name,1,7) COLLATE BINARY != 'sqlite_'",
    )
    .fetch_all(&mut *database)
    .await
    .map_err(|_| seed_denied("Cannot enumerate seed tables"))?;
    for table in tables {
        if REFERENCE_TABLES.contains(&table.as_str()) {
            continue;
        }
        let quoted = table.replace('"', "\"\"");
        let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM \"{quoted}\""))
            .fetch_one(&mut *database)
            .await
            .map_err(|_| seed_denied("Cannot audit an unrecognized seed table"))?;
        if count != 0 {
            return Err(seed_denied("Fresh seed contains customer or operational history"));
        }
    }
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut *database)
        .await
        .map_err(|_| seed_denied("Fresh seed integrity check failed"))?;
    let fk_error = sqlx::query("PRAGMA foreign_key_check")
        .fetch_optional(&mut *database)
        .await
        .map_err(|_| seed_denied("Fresh seed foreign-key check failed"))?;
    if integrity != "ok" || fk_error.is_some() {
        return Err(seed_denied("Fresh seed violates SQLite integrity"));
    }
    Ok(())
}

#[cfg(windows)]
fn publish_fresh_seed_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(
            existing: *const u16,
            replacement: *const u16,
            flags: u32,
        ) -> i32;
    }
    let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = destination.as_os_str().encode_wide().chain(Some(0)).collect();
    // MOVEFILE_WRITE_THROUGH, deliberately without MOVEFILE_REPLACE_EXISTING,
    // guarantees this fresh-only publication refuses a raced installed profile.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x0000_0008) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn publish_fresh_seed_no_replace(_source: &Path, _destination: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "Native fresh seed publication requires Windows no-replace rename"))
}

fn install_seed_database(source: &Path, destination: &Path) -> io::Result<()> {
    refuse_existing_seed_target(destination)?;
    refuse_seed_sidecars(source)?;
    let metadata = fs::symlink_metadata(source)?;
    if !metadata.is_file() || metadata.file_type().is_symlink()
        || metadata.len() != FRESH_PRIMARY_SEED_BYTES
    {
        return Err(seed_denied("Bundled seed is not the verified fresh snapshot"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x0400 != 0 {
            return Err(seed_denied("Bundled seed cannot be a reparse point"));
        }
    }
    let mut source_options = OpenOptions::new();
    source_options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        source_options.share_mode(0x0000_0001); // Deny source writes/deletion
    }
    let mut source_file = source_options.open(source)?;
    if seed_file_sha256(&mut source_file)? != FRESH_PRIMARY_SEED_SHA256 {
        return Err(seed_denied("Bundled seed does not match independently audited SHA-256"));
    }
    tauri::async_runtime::block_on(async {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(source)
            .read_only(true)
            .immutable(true)
            .create_if_missing(false);
        let mut reader = sqlx::SqliteConnection::connect_with(&options)
            .await
            .map_err(|_| seed_denied("Cannot read verified seed without writing"))?;
        verify_fresh_primary_seed(&mut reader, None).await?;
        reader.close().await.map_err(|_| seed_denied("Cannot close source seed reader"))
    })?;
    refuse_seed_sidecars(source)?;

    // A crash before final publication leaves only an isolated random-stage
    // copy. Never delete, overwrite, or reuse a previous .installing file.
    let parent = destination.parent().ok_or_else(|| seed_denied("No seed destination directory"))?;
    let staging_dir = parent.join(format!(".pharma-first-seed-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir(&staging_dir)?;
    let candidate = staging_dir.join("snapshot.sqlite3");
    let mut staged_writer = OpenOptions::new().write(true).create_new(true).open(&candidate)?;
    source_file.seek(SeekFrom::Start(0))?;
    if io::copy(&mut source_file, &mut staged_writer)? != FRESH_PRIMARY_SEED_BYTES {
        return Err(seed_denied("Fresh seed copy was incomplete"));
    }
    staged_writer.sync_all()?;
    drop(staged_writer);
    if seed_file_sha256(&mut source_file)? != FRESH_PRIMARY_SEED_SHA256 {
        return Err(seed_denied("Fresh seed source changed during stage"));
    }
    tauri::async_runtime::block_on(async {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&candidate)
            .create_if_missing(false)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete)
            .foreign_keys(true);
        let mut db = sqlx::SqliteConnection::connect_with(&options)
            .await
            .map_err(|_| seed_denied("Cannot initialize detached fresh seed"))?;
        verify_fresh_primary_seed(&mut db, None).await?;
        let mut tx = db.begin().await.map_err(|_| seed_denied("Cannot begin fresh seed ownership transaction"))?;
        let updated = sqlx::query(
            "UPDATE users SET pharmacy_id=? WHERE id='admin' AND role='owner' AND is_active=1 AND pharmacy_id IS NULL",
        )
        .bind(FRESH_PRIMARY_SCOPE)
        .execute(&mut *tx)
        .await
        .map_err(|_| seed_denied("Fresh seed canonical owner assignment failed"))?;
        if updated.rows_affected() != 1 {
            return Err(seed_denied("Fresh seed owner assignment was not unique"));
        }
        tx.commit().await.map_err(|_| seed_denied("Fresh seed owner transaction failed"))?;
        verify_fresh_primary_seed(&mut db, Some(FRESH_PRIMARY_SCOPE)).await?;
        let journal_mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&mut db)
            .await
            .map_err(|_| seed_denied("Cannot verify private seed journal mode"))?;
        if journal_mode != "delete" {
            return Err(seed_denied("Fresh seed must publish without WAL sidecars"));
        }
        db.close().await.map_err(|_| seed_denied("Cannot close fresh seed stage"))
    })?;
    refuse_seed_sidecars(&candidate)?;
    let mut clean = OpenOptions::new().read(true).write(true).open(&candidate)?;
    clean.sync_all()?;
    let mut header = [0u8; 20];
    clean.read_exact(&mut header)?;
    if &header[..16] != b"SQLite format 3\0" || header[18] != 1 || header[19] != 1 {
        return Err(seed_denied("Fresh seed stage is not a standalone rollback-journal SQLite file"));
    }
    drop(clean);
    refuse_existing_seed_target(destination)?;
    publish_fresh_seed_no_replace(&candidate, destination)
}

// One immutable migration definition is consumed by both the native startup
// and synthetic upgrade tests. Keep SQLx checksums and historical 001 intact.
fn app_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "initial_schema",
            sql: include_str!("../migrations/001_initial.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "performance_tuning",
            sql: include_str!("../migrations/002_performance.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "sync_metadata",
            sql: include_str!("../migrations/003_sync_metadata.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "return_items_patch",
            sql: include_str!("../migrations/004_return_items_patch.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "purchase_return_details",
            sql: include_str!("../migrations/005_purchase_return_details.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "accounting_upgrade_seed",
            sql: include_str!("../migrations/006_accounting_upgrade_seed.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "purchase_inventory_links",
            sql: include_str!("../migrations/007_purchase_inventory_links.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "patient_accounting",
            sql: include_str!("../migrations/008_patient_accounting.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "rebuild_master_drugs_fts",
            sql: include_str!("../migrations/009_rebuild_master_drugs_fts.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "shift_handover_indexes",
            sql: include_str!("../migrations/010_shift_handover_indexes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "shift_cash_difference_account",
            sql: include_str!("../migrations/011_shift_cash_difference_account.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "shortages_pharmacy_scope",
            sql: include_str!("../migrations/012_shortages_pharmacy_scope.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "shift_handover_details",
            sql: include_str!("../migrations/013_shift_handover_details.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "inventory_performance",
            sql: include_str!("../migrations/014_inventory_performance.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "shared_open_shift",
            sql: include_str!("../migrations/015_shared_open_shift.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 16,
            description: "financial_expense_wiring",
            sql: include_str!("../migrations/016_financial_expense_wiring.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "cloud_drug_identity",
            sql: include_str!("../migrations/017_cloud_drug_identity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "unit_conversion_snapshots",
            sql: include_str!("../migrations/018_unit_conversion_snapshots.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "shift_pharmacy_scope",
            sql: include_str!("../migrations/019_shift_pharmacy_scope.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "daily_snapshot_pharmacy_scope",
            sql: include_str!("../migrations/020_daily_snapshot_pharmacy_scope.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "returns_pharmacy_scope",
            sql: include_str!("../migrations/021_returns_pharmacy_scope.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 22,
            description: "finance_pharmacy_scope",
            sql: include_str!("../migrations/022_finance_pharmacy_scope.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 23,
            description: "shift_immutable_scope",
            sql: include_str!("../migrations/023_shift_immutable_scope.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 24,
            description: "commercial_papers_pharmacy_scope",
            sql: include_str!("../migrations/024_commercial_papers_pharmacy_scope.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 25,
            description: "sales_item_discount_snapshot",
            sql: include_str!("../migrations/025_sales_item_discount_snapshot.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 26,
            description: "sales_loyalty_redemption_snapshot",
            sql: include_str!("../migrations/026_sales_loyalty_redemption_snapshot.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 27,
            description: "drug_catalog_reconciliation",
            sql: include_str!("../migrations/027_drug_catalog_reconciliation.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 28,
            description: "finance_definitions_pharmacy_scope",
            sql: include_str!("../migrations/028_finance_definitions_pharmacy_scope.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 29,
            description: "shift_treasury_retained_cash",
            sql: include_str!("../migrations/029_shift_treasury_retained_cash.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 30,
            description: "relationship_lookup_indexes",
            sql: include_str!("../migrations/030_relationship_lookup_indexes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 31,
            description: "trial_balance_unique_categories",
            sql: include_str!("../migrations/031_trial_balance_unique_categories.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 32,
            description: "remove_public_owner_bootstrap_credential",
            sql: include_str!("../migrations/032_remove_public_owner_bootstrap_credential.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 33,
            description: "patient_payment_scope",
            sql: include_str!("../migrations/033_patient_payment_scope.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 34,
            description: "expense_posting_requests",
            sql: include_str!("../migrations/034_expense_posting_requests.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 35,
            description: "commercial_paper_replay",
            sql: include_str!("../migrations/035_commercial_paper_replay.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 36,
            description: "financial_notice_provenance",
            sql: include_str!("../migrations/036_financial_notice_provenance.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 37,
            description: "finance_device_create_requests",
            sql: include_str!("../migrations/037_finance_device_create_requests.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 38,
            description: "inventory_lot_create_requests",
            sql: include_str!("../migrations/038_inventory_lot_create_requests.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 39,
            description: "inventory_create_acknowledgements",
            sql: include_str!("../migrations/039_inventory_create_acknowledgements.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 40,
            description: "stock_ledger_provenance",
            sql: include_str!("../migrations/040_stock_ledger_provenance.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 41,
            description: "purchase_return_posting_provenance",
            sql: include_str!("../migrations/041_purchase_return_posting_provenance.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 42,
            description: "purchase_posting_events",
            sql: include_str!("../migrations/042_purchase_posting_events.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 43,
            description: "native_sales_cogs_provenance",
            sql: include_str!("../migrations/043_native_sales_cogs_provenance.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 44,
            description: "purchase_create_request_receipts",
            sql: include_str!("../migrations/044_purchase_create_request_receipts.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 45,
            description: "native_delivery_collection",
            sql: include_str!("../migrations/045_native_delivery_collection.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 46,
            description: "purchase_zero_delta_stock_events",
            sql: include_str!("../migrations/046_purchase_zero_delta_stock_events.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 47,
            description: "purchase_draft_create_witnesses",
            sql: include_str!("../migrations/047_purchase_draft_create_witnesses.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 48,
            description: "purchase_return_supplier_cash_provenance",
            sql: include_str!("../migrations/048_purchase_return_supplier_cash_provenance.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 49,
            description: "purchase_return_reference_indexes",
            sql: include_str!("../migrations/049_purchase_return_reference_indexes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 50,
            description: "receipted_credit_patient_ownership",
            sql: include_str!("../migrations/050_receipted_credit_patient_ownership.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 51,
            description: "patient_financial_journal_receipts",
            sql: include_str!("../migrations/051_patient_financial_journal_receipts.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 52,
            description: "explicit_local_owner_pharmacy",
            sql: include_str!("../migrations/052_explicit_local_owner_pharmacy.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 53,
            description: "ambiguous_owner_scope_review",
            sql: include_str!("../migrations/053_ambiguous_owner_scope_review.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 54,
            description: "native_supplier_partial_payment",
            sql: include_str!("../migrations/054_native_supplier_partial_payment.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 55,
            description: "patient_cash_movement_witness",
            sql: include_str!("../migrations/055_patient_cash_movement_witness.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 56,
            description: "financial_notice_cash_witness",
            sql: include_str!("../migrations/056_financial_notice_cash_witness.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 57,
            description: "supplier_cash_shift_identity_guard",
            sql: include_str!("../migrations/057_supplier_cash_shift_identity_guard.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 58,
            description: "supplier_cash_shift_replace_guard",
            sql: include_str!("../migrations/058_supplier_cash_shift_replace_guard.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 59,
            description: "supplier_payment_receipt_replace_guard",
            sql: include_str!("../migrations/059_supplier_payment_receipt_replace_guard.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 60,
            description: "native_patient_wallet_topups",
            sql: include_str!("../migrations/060_native_patient_wallet_topups.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 61,
            description: "native_patient_directory_ownership",
            sql: include_str!("../migrations/061_native_patient_directory_ownership.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 62,
            description: "native_supplier_directory_ownership",
            sql: include_str!("../migrations/062_native_supplier_directory_ownership.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 63,
            description: "unused_drug_reference_indexes",
            sql: include_str!("../migrations/063_unused_drug_reference_indexes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 64,
            description: "native_catalog_create_receipts",
            sql: include_str!("../migrations/064_native_catalog_create_receipts.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 65,
            description: "legacy_upgrade_provenance",
            sql: include_str!("../migrations/065_legacy_upgrade_provenance.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 66,
            description: "legacy_mapped_source_row_seal",
            sql: include_str!("../migrations/066_legacy_mapped_source_row_seal.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 67,
            description: "legacy_original_detail_row_seal",
            sql: include_str!("../migrations/067_legacy_original_detail_row_seal.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 68,
            description: "primary_pharmacy_typed_scope_audit",
            sql: include_str!("../migrations/068_primary_pharmacy_typed_scope_audit.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 69,
            description: "supplier_return_aware_payment_guard",
            sql: include_str!("../migrations/069_supplier_return_aware_payment_guard.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

/// Native maintenance command, never registered with Tauri IPC. The only
/// caller-selected value is a disposable stage token; independently pinned
/// owner key, owner ID, v29 source pin and verified signature are still
/// mandatory. Not compiled in normal commercial releases; only the explicitly
/// opted-in owner-maintenance-cli build supports this offline path.
#[cfg(any(test, feature = "owner-maintenance-cli"))]
fn parse_native_owner_only_stage_argument(
    args: &[std::ffi::OsString],
) -> Option<Result<String, String>> {
    if args.first().map(std::ffi::OsString::as_os_str)
        != Some(std::ffi::OsStr::new("--native-verify-owner-only-v67"))
    {
        return None;
    }
    let token = match args {
        [_, token] => token.to_str(),
        _ => None,
    };
    Some(match token {
        Some(token) if token.len() == 32
            && token.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
            Ok(token.to_owned()),
        _ => Err("Offline owner proof requires exactly one 32-hex disposable stage token".into()),
    })
}

/// Do not accidentally launch the GUI when someone tries an unavailable
/// historical-maintenance mode on an ordinary commercial executable.
#[cfg(any(test, not(feature = "owner-maintenance-cli")))]
fn is_owner_maintenance_flag(flag: &std::ffi::OsStr) -> bool {
    flag == std::ffi::OsStr::new("--native-verify-owner-only-v67")
        || flag == std::ffi::OsStr::new("--native-prepare-signed-copy-only-v52-v67")
}

fn main() {
    #[cfg(feature = "owner-maintenance-cli")]
    {
        let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
        if let Some(request) = primary_pharmacy_copy_cli::parse_stage_argument(&args) {
            // Trusted offline maintenance only; never installation or finance.
            match request.and_then(|token| primary_pharmacy_copy_cli::run(&token)) {
                Ok(()) => std::process::exit(0),
                Err(_) => {
                    eprintln!("Native signed copy-only preparation denied");
                    std::process::exit(2);
                }
            }
        }
        if let Some(request) = parse_native_owner_only_stage_argument(&args) {
            // Offline signed proof never authorizes a live profile or renderer.
            match request.and_then(|token| schema::run_native_owner_only_offline_stage(&token)) {
                Ok(_) => std::process::exit(0),
                Err(error) => {
                    eprintln!("Offline native owner custody denied: {error}");
                    std::process::exit(2);
                }
            }
        }
    }
    #[cfg(not(feature = "owner-maintenance-cli"))]
    if std::env::args_os().skip(1).any(|arg| is_owner_maintenance_flag(&arg)) {
        eprintln!("Offline owner maintenance is unavailable in commercial PHARMA");
        std::process::exit(2);
    }
    let migrations = app_migrations();

    // The renderer cannot load the SQL plugin because that would constitute
    // a second direct database IPC path outside the native licensing gate.
    // Preserve the exact existing plugin SQLx migrations, now applied only
    // after successful license validation in the trusted startup path.
    let native_migrations: Vec<sqlx::migrate::Migration> = migrations
        .iter()
        .filter(|item| matches!(item.kind, MigrationKind::Up))
        .map(|item| {
            sqlx::migrate::Migration::new(
                item.version,
                item.description.into(),
                sqlx::migrate::MigrationType::ReversibleUp,
                item.sql.into(),
                false,
            )
        })
        .collect();

    tauri::Builder::default()
        .manage(commands::critical::DbTransactions::default())
        .manage(commands::auth::LocalSessionState::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                rollback_window_transactions(window.app_handle(), window.label());
            }
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                rollback_window_transactions(webview.app_handle(), webview.label());
            }
        })
        // Application menus are global on Windows; the shortcut invokes the command directly.
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "new_window" {
                if app.state::<licensing::LicenseGuard>().enforce().is_err() {
                    return;
                }
                if let Err(err) = open_new_window_for_app(app) {
                    eprintln!("failed to open new window: {}", err);
                }
            }
        })
        .setup(move |app| {
            let menu = create_app_menu(app.handle(), NativeAdminMenuAccess::default())?;
            app.set_menu(menu)?;

            // Initialize licensing before touching the existing customer DB.
            // Unlicensed launches display only the activation UX. Activate and
            // restart to enter the normal startup/database-migration path.
            let app_data_dir = app.path().app_data_dir()?;
            let license_directory = app_data_dir.join("licensing");
            app.manage(licensing::LicenseGuard::new(license_directory));
            // License renewal does not touch pharmacy business data or bypass
            // the normal licensed-startup/restart migration gate.
            licensing_online::spawn_renewal_watcher(app.handle().clone());
            if let Err(reason) = app.state::<licensing::LicenseGuard>().check_license() {
                eprintln!("License gate: {reason}");
                return Ok(());
            }

            // Extract the seeded database from resources on first licensed run
            fs::create_dir_all(&app_data_dir)?;

            let db_path = app_data_dir.join("pharma_local.db");

            // Check ownership first: creating a copy of another tenant's
            // unresolved historical data is not itself an ownership grant.
            // Refusal is read-only and leaves the exact original database
            // unchanged; authorized custodians can stage an isolated upgrade.
            if let Err(error) = legacy_upgrade_guard::inspect_preexisting_profile(&db_path) {
                // Preserve every byte of the unresolved customer DB. A setup
                // panic would misleadingly appear as a corrupt installation;
                // instead retain the real signed-license UX in a quarantined
                // read-only information state. LicenseGuard::enforce still
                // denies ALL finance, catalog and customer-data commands.
                eprintln!("Legacy pharmacy upgrade safely refused: {error}");
                app.state::<licensing::LicenseGuard>().mark_legacy_upgrade_blocked();
                return Ok(());
            }

            // Consistent WAL-aware native VACUUM INTO creates a unique, sealed
            // and hashed recovery snapshot BEFORE any licensed forward schema
            // migration or compatibility repair. A backup failure aborts the
            // update; do not proceed with an unbacked-up customer's history.
            // Existing profiles already at the exact migration version do not
            // create a needless additional backup on every normal login.
            if legacy_upgrade_guard::requires_forward_backup(
                &db_path,
                native_migrations.len() as i64,
            )
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?
            {
                tauri::async_runtime::block_on(database_backup::create_backup(&db_path))
                    .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            }

            // The native read-only preflight already refused a zero-byte
            // existing database or orphaned WAL/journal. Absence alone may
            // trigger a fresh seed; never replace a preexisting profile.
            let should_copy_seed = !db_path.exists();

            let mut seed_candidates = Vec::new();
            if let Ok(res_dir) = app.path().resource_dir() {
                seed_candidates.push(res_dir.join("pharma_local.db"));
                seed_candidates.push(res_dir.join("resources").join("pharma_local.db"));
            }
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    seed_candidates.push(exe_dir.join("pharma_local.db"));
                    seed_candidates.push(exe_dir.join("resources").join("pharma_local.db"));
                }
            }
            let seed_path = seed_candidates.into_iter().find(|candidate| {
                candidate
                    .metadata()
                    .map(|meta| meta.len() > 0)
                    .unwrap_or(false)
            });

            if should_copy_seed {
                let seed_path = seed_path.as_ref().ok_or_else(|| {
                    io::Error::new(io::ErrorKind::NotFound, "bundled seed database not found")
                })?;
                install_seed_database(seed_path, &db_path)?;
                println!(
                    "Copied seeded database from {:?} to {:?}",
                    seed_path, db_path
                );
            }

            // Ensure destination SQLite files are NOT marked read-only on Windows
            for file_name in &[
                "pharma_local.db",
                "pharma_local.db-wal",
                "pharma_local.db-shm",
            ] {
                let path = app_data_dir.join(file_name);
                if let Ok(metadata) = fs::metadata(&path) {
                    let perms = metadata.permissions();
                    if perms.readonly() {
                        make_writable(&path, perms)?;
                    }
                }
            }

            schema::prepare_legacy_database(&db_path)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

            // Previously this ran on frontend `sql:load`. Running native
            // migrations here retains compatibility while keeping that IPC
            // permission disabled for all renderer windows.
            let licensed_read_pool = tauri::async_runtime::block_on(async {
                let options = sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&db_path).create_if_missing(false).foreign_keys(true);
                let pool = sqlx::SqlitePool::connect_with(options).await
                    .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
                let migrator = sqlx::migrate::Migrator {
                    migrations: std::borrow::Cow::Owned(native_migrations),
                    ..sqlx::migrate::Migrator::DEFAULT
                };
                migrator.run(&pool).await
                    .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
                Ok::<_, io::Error>(pool)
            })?;
            app.manage(commands::critical::GuardedReadPool(licensed_read_pool));

            // The bundled CSV is not proof of a pharmacy's historic retail
            // prices or product metadata. Existing operational profiles must
            // preserve their original catalogue and stock values on upgrade.
            // Only a database freshly seeded by THIS startup can receive
            // automatic bundled-reference repairs; separately witnessed
            // customer corrections use the copy-only offline recovery tool.
            if should_copy_seed {
                if let Some(seed_path) = seed_path {
                    match schema::repair_catalog_name_drift(&db_path, &seed_path) {
                        Ok(repaired) if repaired > 0 => {
                            println!(
                                "Corrected {repaired} freshly seeded catalog/inventory reference record(s)"
                            );
                        }
                        Ok(_) => {}
                        Err(error) => eprintln!("Fresh seed catalog repair skipped: {error}"),
                    }
                }
            }

            let main_window = app
                .get_webview_window("main")
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "main window not found"))?;
            // Hidden synthetic/background windows must remain hidden; the
            // unconditional maximize previously activated the OS foreground.
            if main_window.is_visible().unwrap_or(false) {
                if let Err(error) = main_window.maximize() {
                    eprintln!("Failed to maximize main window: {error}");
                }
            }

            // Attach window-specific menu handler
            main_window.on_menu_event(|window, event| {
                handle_menu_event(window, event.id().as_ref());
            });

            app.state::<licensing::LicenseGuard>().mark_startup_complete();
            // Only licensed, migrated native application state runs the lease
            // janitor. Webviews can disappear without a reliable close event,
            // and an abandoned BEGIN IMMEDIATE must not pin financial writes.
            let native_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticks = tokio::time::interval(std::time::Duration::from_secs(15));
                loop {
                    ticks.tick().await;
                    if let Err(error) = native_app
                        .state::<commands::critical::DbTransactions>()
                        .rollback_expired()
                        .await
                    {
                        eprintln!("Expired native transaction cleanup failed: {error}");
                    }
                }
            });
            Ok(())
        })
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:pharma_local.db", migrations)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler({
            let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            licensing::license_status,
            primary_pharmacy_upgrade_preview,
            licensing::license_install,
            licensing_online::license_activate_online,
            licensing_online::license_renew_online,
            database_backup::export_database_backup,
            database_backup::verify_database_backup_recovery_preview,
            database_backup::stage_database_recovery_rehearsal_native,
            database_maintenance::run_database_maintenance,
            commands::auth::bcrypt_hash,
            commands::auth::bcrypt_compare,
            commands::auth::authenticate_local,
            commands::auth::owner_enrollment_status,
            commands::auth::enroll_initial_owner,
            commands::auth::current_local_user,
            commands::auth::logout_local,
            commands::auth::list_staff_directory,
            commands::auth::list_local_staff_summaries,
            commands::staff_management_native::get_staff_management_data_native,
            commands::staff_management_native::add_staff_user_native,
            commands::staff_management_native::update_staff_user_native,
            commands::staff_management_native::update_staff_permissions_native,
            commands::staff_management_native::reset_staff_password_native,
            commands::auth::verify_handover_credentials,
            commands::audit::clear_audit_logs,
            commands::settings::update_pharmacy_settings,
            commands::settings::read_pharmacy_settings_scoped,
            commands::settings::update_config_value,
            commands::sync::set_sync_watermark,
            commands::inventory_repair::migrate_legacy_placeholder_inventory_scope,
            commands::critical::db_execute_guarded,
            commands::critical::db_select_guarded,
            commands::scoped_read::db_read_scoped,
            commands::scoped_read::db_read_purchasing_page,
            commands::inventory_history::db_read_inventory_history,
            commands::inventory_history::add_opening_balance_critical,
            commands::inventory_lots_native::create_inventory_lot_native,
            commands::inventory_lots_native::delete_inventory_lot_native,
            commands::inventory_lots_native::update_inventory_lot_native,
            commands::inventory_lots_native::adjust_inventory_lot_native,
            commands::inventory_create_recovery_native::list_unacknowledged_inventory_creates_native,
            commands::inventory_create_recovery_native::acknowledge_inventory_create_native,
            commands::inventory_alerts_native::read_inventory_alerts_native,
            // Fail-closed without an independently provisioned native archive
            // custodian grant. No renderer SQL, filesystem path or tenant arg.
            commands::legacy_archive_read_native::read_legacy_archive_scope_facts_native,
            commands::inventory_import_native::import_inventory_lots_native,
            commands::inventory_export_native::export_inventory_snapshot_native,
            commands::catalog_export_native::export_master_catalog_native,
            commands::catalog_export_native::read_master_catalog_cache_native,
            commands::critical::db_transaction_begin,
            commands::critical::db_transaction_finish,
            commands::critical::db_transaction_abort,
            commands::critical::process_checkout_critical,
            commands::delivery_collection_native::collect_delivery_native,
            commands::delivery_collection_native::list_pending_deliveries_native,
            commands::delivery_collection_native::confirm_delivery_collection_native,
            commands::critical::save_purchase_invoice_critical,
            commands::purchase_creation_confirmation_native::confirm_purchase_creation_native,
            commands::drug_replacement::replace_master_drug,
            commands::drug_replacement::reconcile_master_drug_group,
            commands::drug_replacement::correct_drug_barcode_conflict,
            commands::critical::delete_purchase_invoice_critical,
            commands::critical::create_return_critical,
            commands::sales_return_confirmation_native::confirm_sales_return_native,
            commands::critical::settle_negative_sale_item_critical,
            commands::settlement_reads_native::read_settlement_native,
            commands::purchase_returns::create_purchase_return_critical,
            commands::returns_scoped::list_returnable_sales_invoices_by_date,
            commands::returns_scoped::search_returnable_sales_invoices_native,
            commands::patient_statement_native::read_patient_statement_native,
            commands::shifts_native::ensure_shared_shift_native,
            commands::shifts_native::ensure_handover_shift_native,
            commands::shifts_native::current_shared_shift_native,
            commands::shifts_native::get_pharmacy_shift_native,
            commands::shifts_native::get_shift_history_native,
            commands::shifts_native::get_current_shift_stats_native,
            commands::shifts_native::get_shift_receipts_native,
            commands::shifts_native::open_shared_shift_native,
            commands::shifts_native::close_shared_shift_native,
            commands::shifts_native::force_close_pharmacy_shifts_native,
            commands::managed_staff_native::deactivate_staff_native,
            commands::managed_staff_native::close_staff_shift_and_deactivate_native,
            commands::finance_scoped::finance_read_projection,
            commands::finance_posting_native::create_cash_movement_native,
            commands::finance_posting_native::create_expense_native,
            commands::finance_posting_native::list_expenses_native,
            commands::finance_posting_native::update_paper_status_native,
            commands::finance_posting_native::create_paper_native,
            commands::finance_posting_native::delete_paper_native,
            commands::finance_posting_native::list_papers_native,
            commands::patient_directory_native::create_patient_owned_native,
            commands::patient_payments_native::post_patient_payment_native,
            commands::patient_payments_native::confirm_patient_payment_native,
            commands::supplier_create_native::create_supplier_native,
            commands::master_drug_create_native::create_master_drug_native,
            commands::patient_payments_native::top_up_patient_wallet_native,
            commands::patient_payments_native::confirm_patient_wallet_top_up_native,
            commands::supplier_payments_native::post_supplier_payment_native,
            commands::supplier_payments_native::confirm_supplier_payment_native,
            commands::financial_notices_native::create_financial_notice_native,
            commands::financial_notices_native::list_financial_notices_native,
            commands::financial_lineage_audit_native::audit_financial_lineage_native,
            commands::financial_source_reconciliation_native::reconcile_financial_sources_native,
            commands::pos_devices_native::create_pos_device_native,
            commands::pos_devices_native::update_pos_device_native,
            commands::pos_devices_native::delete_pos_device_native,
            commands::pos_devices_native::list_pos_devices_native,
            commands::banks_native::create_bank_native,
            commands::banks_native::update_bank_native,
            commands::banks_native::delete_bank_native,
            commands::banks_native::list_banks_native,
            commands::cards_native::create_card_native,
            commands::cards_native::update_card_native,
            commands::cards_native::delete_card_native,
            commands::cards_native::list_cards_native,
            commands::handover_native::process_handover_native,
            commands::handover_reads_native::get_handover_details_native,
            commands::handover_reads_native::get_shift_credit_sales_native,
            commands::manual_journals_native::create_manual_journal_native,
            open_new_window,
            sync_native_admin_menu,
            log_frontend_error,
            save_workbook_export_native,
            ];
            move |invoke: tauri::ipc::Invoke| {
                let name = invoke.message.command();
                // Transaction ABORT only rolls back an existing window-owned
                // connection. Never strand SQLite's writer lock when a lease
                // expires during a user action; COMMIT stays licensed.
                if !matches!(name, "license_status" | "license_install" | "license_activate_online" | "license_renew_online" | "db_transaction_abort") {
                    let webview = invoke.message.webview();
                    let state = webview.app_handle().state::<licensing::LicenseGuard>();
                    if let Err(reason) = state.enforce() {
                        invoke.resolver.reject(format!("License required: {reason}"));
                        return true;
                    }
                }
                commands(invoke)
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn native_menu_action(id: &str) -> Option<&'static str> {
    match id {
        "print" => Some("print"),
        "logout" => Some("logout"),
        "update_program" => Some("update"),
        "help_shortcuts" => Some("shortcuts"),
        "help_about" => Some("about"),
        "purchase_save_draft" => Some("purchase-save-draft"),
        _ => None,
    }
}

fn handle_menu_event<R: tauri::Runtime>(window: &tauri::Window<R>, id: &str) {
    if id == "new_window" {
        return;
    }
    if let Some(action) = native_menu_action(id) {
        let _ = window.emit_to(window.label(), "menu-action", action);
        return;
    }

    let route = match id {
        // Routes

        // Routes
        "pos" => "/pos",
        "purchases_new" | "purchases_new2" => "/purchases/new",
        "dashboard" => "/",
        "receipts" => "/receipts",
        "sales" => "/sales",
        "reports_sales" | "reports_sales2" => "/reports/sales",
        "sales_delivery" => "/sales/delivery",
        "sales_cogs" => "/sales/cogs",
        "inventory" => "/inventory",
        "inventory_low_stock" => "/inventory/low-stock",
        "stores_shortages" => "/stores/shortages",
        "inventory_item_movements" => "/inventory/item-movements",
        "restock" => "/restock",
        "inventory_settlement" => "/inventory/settlement",
        "inventory_opening_balances" => "/inventory/opening-balances",
        "purchases" => "/purchases",
        "purchase_orders" => "/purchase-orders",
        "purchases_suppliers" => "/purchases/suppliers",
        "purchases_returns" => "/purchases/returns",
        "purchases_general_returns" => "/purchases/general-returns",
        "returns" => "/returns",
        "stores_items" => "/stores/items",
        "stores_alternatives" => "/stores/alternatives",
        "stores_categories" => "/stores/categories",
        "stores_nature" => "/stores/nature",
        "stores_usage" => "/stores/usage",
        "stores_units" => "/stores/units",
        "stores_indications" => "/stores/indications",
        "stores_drug_indications" => "/stores/drug-indications",
        "stores_manufacturers" => "/stores/manufacturers",
        "stores_scientific_groups" => "/stores/scientific-groups",
        "stores_adjustments" => "/stores/adjustments",
        "stores_adjustment_reasons" => "/stores/adjustment-reasons",
        "stores_delete_items" => "/stores/delete-items",
        "accounts" => "/accounts",
        "accounts_cash_transactions" => "/accounts/cash-transactions",
        "finance_banks" => "/finance/banks",
        "finance_cards" => "/finance/cards",
        "finance_pos_management" => "/finance/pos-management",
        "finance_accounts" => "/finance/accounts",
        "accounts_settings_trial_balance" => "/accounts/settings/trial-balance",
        "reports" => "/reports",
        "reports_trial_balance" => "/reports/trial-balance",
        "reports_purchases" => "/reports/purchases",
        "expenses" => "/expenses",
        "patients" => "/patients",
        "interactions" => "/interactions",
        "staff" => "/staff",
        "staff_manage" => "/staff/manage",
        "staff_roles" => "/staff/roles",
        "audit" => "/audit",
        "settings" => "/settings",
        _ => return,
    };

    // Emit only to THIS window
    let _ = window.emit_to(window.label(), "menu-navigate", route);
}

#[cfg(test)]
mod tests {
    use super::{
        app_migrations, install_seed_database, native_menu_action, new_window_label, schema,
        is_owner_maintenance_flag, parse_native_owner_only_stage_argument, validate_export_file,
        validate_native_export_destination, write_new_workbook_file, FRESH_PRIMARY_SCOPE,
        FRESH_PRIMARY_SEED_SHA256, MigrationKind, NativeAdminMenuAccess,
        PURCHASE_DRAFT_ACCELERATOR,
    };
    use std::fs;

    #[test]
    fn commercial_owner_maintenance_flags_are_not_regular_launch_arguments() {
        use std::ffi::OsStr;
        assert!(is_owner_maintenance_flag(OsStr::new("--native-verify-owner-only-v67")));
        assert!(is_owner_maintenance_flag(OsStr::new("--native-prepare-signed-copy-only-v52-v67")));
        for arg in ["--help", "--version", "--start-minimized", "--native-verify-owner-only-v67-typo"] {
            assert!(!is_owner_maintenance_flag(OsStr::new(arg)));
        }
    }

    #[test]
    fn offline_owner_only_cli_accepts_stage_token_only_and_cannot_choose_trust_key() {
        use std::ffi::OsString;
        let stage = "0123456789abcdef0123456789abcdef";
        assert!(parse_native_owner_only_stage_argument(&[]).is_none(),
            "Normal Tauri launch stays unchanged");
        assert!(parse_native_owner_only_stage_argument(&[OsString::from("--help")]).is_none());
        let valid = [
            OsString::from("--native-verify-owner-only-v67"),
            OsString::from(stage),
        ];
        assert_eq!(parse_native_owner_only_stage_argument(&valid).unwrap().unwrap(), stage);
        for suffix in [
            vec![], vec![OsString::from("..")], vec![OsString::from("PHARMACY_LOCAL.DB")],
            vec![OsString::from("ABCDEF0123456789ABCDEF0123456789")],
            vec![OsString::from("0123456789abcdef0123456789abcdeg")],
            vec![OsString::from(stage), OsString::from("--owner-public-key=self")],
            vec![OsString::from(stage), OsString::from("--db=C:\\protected\\original.sqlite")],
        ] {
            let mut args = vec![OsString::from("--native-verify-owner-only-v67")];
            args.extend(suffix);
            assert!(parse_native_owner_only_stage_argument(&args).unwrap().is_err(),
                "Only one opaque disposable stage token is accepted");
        }
    }

    #[test]
    fn blank_database_with_all_native_migrations_survives_second_startup_unit_snapshot_repair() {
        let dir = std::env::temp_dir().join(format!(
            "pharma-disposable-full59-restart-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("pharma_local.db");
        tauri::async_runtime::block_on(async {
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true);
            let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
            let all = app_migrations()
                .into_iter()
                .filter(|migration| matches!(migration.kind, MigrationKind::Up))
                .map(|migration| {
                    sqlx::migrate::Migration::new(
                        migration.version,
                        migration.description.into(),
                        sqlx::migrate::MigrationType::ReversibleUp,
                        migration.sql.into(),
                        false,
                    )
                })
                .collect::<Vec<_>>();
            let migrator = sqlx::migrate::Migrator {
                migrations: std::borrow::Cow::Owned(all),
                ..sqlx::migrate::Migrator::DEFAULT
            };
            migrator.run(&pool).await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(count, 69);
            // 068 adds a prospective owner-only audit contract. Running the
            // registered migration never fabricates an owner attestation or
            // upgrades an unsigned custody observation into a grant.
            for table in [
                "native_primary_scope_audit_batches",
                "native_primary_scope_audit_originals",
                "native_primary_scope_audit_tables",
                "native_primary_scope_audit_relations",
                "native_primary_scope_audit_seals",
                "native_primary_scope_owner_attestations",
            ] {
                let observed: i64 = sqlx::query_scalar(&format!(
                    "SELECT COUNT(*) FROM \"{table}\""
                )).fetch_one(&pool).await.unwrap();
                assert_eq!(observed, 0, "Migration 068 must leave {table} empty");
            }
            pool.close().await;
        });

        // Fresh pre-license startup correctly did not touch the original seed.
        // The next licensed startup must prepare both unit columns before the
        // migration-043 immutable trigger parses NEW.large_to_medium/medium_to_small.
        let first = schema::prepare_legacy_database(&path);
        assert!(first.is_ok(), "first post-migration restart: {first:?}");
        let second = schema::prepare_legacy_database(&path);
        assert!(second.is_ok(), "subsequent idempotent restart: {second:?}");
        // SQLx/SQLite may briefly retain a file handle after block_on drops
        // its runtime on Windows. Cleanup is best-effort and must not turn a
        // successful schema restart assertion into a false product failure.
        if let Err(error) = fs::remove_dir_all(&dir) {
            eprintln!("Disposable restart test cleanup deferred: {error}");
        }
    }

    #[test]
    fn opt_in_current_v02109_history_native_sqlx_068_rehearsal_is_isolated_and_idempotent() {
        // Only run on an independently SHA-pinned COPY of the current
        // installed v29 history, already SQL-rehearsed through version 067.
        // Never open the real v0.2.109 installed profile or saved sealed source.
        let Some(source) = std::env::var_os("PHARMA_QA_CURRENT_V67_TEST_COPY") else {
            return;
        };
        let source = std::path::PathBuf::from(source);
        let local_root = std::path::PathBuf::from(
            std::env::var_os("LOCALAPPDATA").expect("Windows QA LOCALAPPDATA required"),
        ).join("pharma-disposable-data-copies");
        let parent = source.parent().expect("QA source folder");
        assert_eq!(parent.parent(), Some(local_root.as_path()), "Never use installed pharmacy profile");
        assert!(parent.file_name().unwrap().to_string_lossy()
            .starts_with("pharma-v02110-current-v67-sql-rehearsal-"));
        assert_eq!(source.file_name().unwrap(),
            "current-v02109-to-v67-SQL-ONLY-NOT-AUTHORIZED.sqlite3");
        assert!(!source.is_symlink() && !parent.is_symlink() && source.is_file());
        for suffix in ["-wal", "-shm", "-journal"] {
            assert!(!std::path::PathBuf::from(format!("{}{}", source.display(), suffix)).exists(),
                "QA-only v67 source has sidecars; refuse unsafe byte copy");
        }
        use sha2::{Digest, Sha256};
        let pinned = "12c7ef65c8c89ac473b309221c462f71589ce1bcca4ae928b0aaf430999f9880";
        let file_hash = |path: &std::path::Path| -> String {
            format!("{:x}", Sha256::digest(fs::read(path).expect("QA source readable")))
        };
        assert_eq!(file_hash(&source), pinned, "Current-data v67 source changed");
        let destination_dir = local_root.join(format!(
            "pharma-v02110-native-sqlx-068-current-data-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&destination_dir).unwrap();
        let destination = destination_dir.join("NATIVE-SQLX-068-DISPOSABLE-NOT-AUTHORIZED.sqlite3");
        let copied = fs::copy(&source, &destination).expect("Copy-only disposable source");
        assert!(copied > 1_000_000);
        assert_eq!(file_hash(&destination), pinned);
        tauri::async_runtime::block_on(async {
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&destination).create_if_missing(false);
            let pool = sqlx::SqlitePool::connect_with(options).await.unwrap();
            let originals: (i64, i64, i64) = sqlx::query_as(
                "SELECT (SELECT COUNT(*) FROM inventory), +                        (SELECT COUNT(*) FROM journal_entries), +                        (SELECT COUNT(*) FROM patients)"
            ).fetch_one(&pool).await.unwrap();
            let migrations = app_migrations().into_iter()
                .filter(|item| matches!(item.kind, MigrationKind::Up) && item.version <= 68)
                .map(|item| sqlx::migrate::Migration::new(
                    item.version, item.description.into(),
                    sqlx::migrate::MigrationType::ReversibleUp,
                    item.sql.into(), false,
                )).collect::<Vec<_>>();
            let migrator = sqlx::migrate::Migrator {
                migrations: std::borrow::Cow::Owned(migrations),
                ..sqlx::migrate::Migrator::DEFAULT
            };
            migrator.run(&pool).await.expect("Real current-history clone SQLx 067→068");
            migrator.run(&pool).await.expect("SQLx 068 startup must be idempotent");
            let version: (i64, i64) = sqlx::query_as(
                "SELECT MAX(version), COUNT(*) FROM _sqlx_migrations WHERE success=1"
            ).fetch_one(&pool).await.unwrap();
            assert_eq!(version, (68, 68));
            let after: (i64, i64, i64) = sqlx::query_as(
                "SELECT (SELECT COUNT(*) FROM inventory), +                        (SELECT COUNT(*) FROM journal_entries), +                        (SELECT COUNT(*) FROM patients)"
            ).fetch_one(&pool).await.unwrap();
            assert_eq!(after, originals, "Real-history business rows changed under 068");
            let attestations: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM native_primary_scope_owner_attestations"
            ).fetch_one(&pool).await.unwrap();
            assert_eq!(attestations, 0, "SQLx must never fabricate original owner approval");
            let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
                .fetch_one(&pool).await.unwrap();
            assert_eq!(integrity, "ok");
            let fk: Vec<(String, i64, String, i64)> = sqlx::query_as("PRAGMA foreign_key_check")
                .fetch_all(&pool).await.unwrap();
            assert!(fk.is_empty(), "Current-v29-derived clone contains FK errors");
            pool.close().await;
        });
        assert_eq!(file_hash(&source), pinned, "Never mutate current real-history source copy");
        assert!(destination.is_file(), "Retain detached native v68 for typed postflight");
    }

    #[test]
    fn native_route_allowlist_defaults_hidden_and_matches_explicit_ids() {
        let mut access = NativeAdminMenuAccess::default();
        assert!(!access.allows_route("purchases"));
        assert!(!access.allows_route("inventory"));

        access.allowed_route_ids = vec!["dashboard".into(), "pos".into()];
        assert!(access.allows_route("dashboard"));
        assert!(access.allows_route("pos"));
        assert!(!access.allows_route("purchases"));
    }

    #[test]
    fn purchase_draft_native_hotkey_maps_to_frontend_action() {
        assert_eq!(PURCHASE_DRAFT_ACCELERATOR, "F10");
        assert_eq!(
            native_menu_action("purchase_save_draft"),
            Some("purchase-save-draft")
        );
    }

    #[test]
    fn validates_xlsx_exports_only() {
        assert!(validate_export_file("inventory.xlsx", b"PK\x03\x04").is_ok());
        assert!(validate_export_file("inventory.txt", b"PK\x03\x04").is_err());
        assert!(validate_export_file("inventory.xlsx", b"not xlsx").is_err());
        assert!(validate_export_file("inventory.xlsx", b"PKarbitrary").is_err());
        assert!(validate_export_file("inventory.xlsx", &vec![b'Z'; 32 * 1024 * 1024 + 1]).is_err());
    }

    #[test]
    fn native_workbook_save_refuses_existing_files_and_database_directory() {
        let directory =
            std::env::temp_dir().join(format!("pharma-native-save-{}", uuid::Uuid::new_v4()));
        let data_dir = directory.join("database");
        let output = directory.join("exports");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(&output).unwrap();
        let sensitive = data_dir.join("pharma_local.xlsx");
        assert!(validate_native_export_destination(&sensitive, &data_dir).is_err());
        let path = output.join("inventory_export.xlsx");
        assert!(validate_native_export_destination(&path, &data_dir).is_ok());
        let bytes = b"PK\x03\x04signed export placeholder";
        write_new_workbook_file(&path, bytes).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(validate_native_export_destination(&path, &data_dir).is_err());
        assert!(write_new_workbook_file(&path, b"overwritten").is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(validate_native_export_destination(
            std::path::Path::new("relative.xlsx"),
            &data_dir
        )
        .is_err());
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn creates_unique_native_window_labels() {
        let first = new_window_label();
        let second = new_window_label();
        assert!(first.starts_with("window_"));
        assert_ne!(first, second);
    }

    #[test]
    fn installs_only_sha_pinned_business_empty_seed_atomically_with_primary_owner() {
        let dir = std::env::temp_dir().join(format!("pharma صيدلية {}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        // The repository's original seed may have retained a zero-byte WAL
        // or -shm sidecar from separate developer reads. Never erase those
        // files just to make a test pass: use a byte-exact, standalone copy
        // with no SQLite sidecars, as the isolated QA EXE package does.
        let repository_seed = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("pharma_local.db");
        let source = dir.join("clean_bundled_seed.sqlite3");
        fs::copy(&repository_seed, &source).unwrap();
        let destination = dir.join("app data.db");
        let before = super::seed_file_sha256(&mut fs::File::open(&repository_seed).unwrap()).unwrap();
        assert_eq!(before, FRESH_PRIMARY_SEED_SHA256);
        assert_eq!(super::seed_file_sha256(&mut fs::File::open(&source).unwrap()).unwrap(), before);
        // A crashed prior installation is evidence; never overwrite it.
        fs::write(destination.with_extension("db.installing"), b"old staging evidence").unwrap();

        install_seed_database(&source, &destination).unwrap();
        tauri::async_runtime::block_on(async {
            use sqlx::Connection;
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&destination)
                .read_only(true)
                .immutable(true);
            let mut db = sqlx::SqliteConnection::connect_with(&options).await.unwrap();
            super::verify_fresh_primary_seed(&mut db, Some(FRESH_PRIMARY_SCOPE))
                .await
                .unwrap();
            // SQLx migration 052 must not silently convert the new owner back
            // to local_default on first launch or after a restart.
            db.close().await.unwrap();
            let mut writable = sqlx::SqliteConnection::connect_with(
                &sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&destination)
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete),
            ).await.unwrap();
            sqlx::raw_sql(include_str!("../migrations/052_explicit_local_owner_pharmacy.sql"))
                .execute(&mut writable)
                .await
                .unwrap();
            let owner: String = sqlx::query_scalar(
                "SELECT pharmacy_id FROM users WHERE id='admin'"
            ).fetch_one(&mut writable).await.unwrap();
            assert_eq!(owner, FRESH_PRIMARY_SCOPE);
            writable.close().await.unwrap();
        });
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut path = destination.as_os_str().to_os_string();
            path.push(suffix);
            assert!(!std::path::PathBuf::from(path).exists());
        }
        assert_eq!(fs::read(destination.with_extension("db.installing")).unwrap(),
            b"old staging evidence");
        assert_eq!(super::seed_file_sha256(&mut fs::File::open(&repository_seed).unwrap()).unwrap(),
            before, "First install must never mutate the repository seed");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_every_preexisting_profile_even_if_zero_bytes_or_sqlite_sidecar() {
        let dir = std::env::temp_dir().join(format!("pharma existing db {}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("pharma_local.db");
        let destination = dir.join("pharma_local.db");
        let existing_bytes = b"existing user database must remain untouched";
        fs::write(&destination, existing_bytes).unwrap();

        let error = install_seed_database(&source, &destination).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&destination).unwrap(), existing_bytes);
        fs::write(&destination, b"").unwrap();
        assert_eq!(
            install_seed_database(&source, &destination).unwrap_err().kind(),
            std::io::ErrorKind::AlreadyExists
        );
        fs::remove_file(&destination).unwrap();
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut sidecar = destination.as_os_str().to_os_string();
            sidecar.push(suffix);
            let sidecar = std::path::PathBuf::from(sidecar);
            fs::write(&sidecar, b"uncommitted history must be preserved").unwrap();
            assert_eq!(
                install_seed_database(&source, &destination).unwrap_err().kind(),
                std::io::ErrorKind::AlreadyExists
            );
            assert!(!destination.exists());
            assert_eq!(fs::read(&sidecar).unwrap(), b"uncommitted history must be preserved");
            fs::remove_file(sidecar).unwrap();
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_modified_or_foreign_seed_without_publishing_a_profile() {
        let dir = std::env::temp_dir().join(format!("pharma foreign seed {}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("foreign_seed.db");
        let pinned = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("pharma_local.db");
        fs::copy(&pinned, &source).unwrap();
        tauri::async_runtime::block_on(async {
            use sqlx::Connection;
            let options = sqlx::sqlite::SqliteConnectOptions::new()
                .filename(&source)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete);
            let mut db = sqlx::SqliteConnection::connect_with(&options).await.unwrap();
            sqlx::query("UPDATE users SET pharmacy_id='foreign_pharmacy' WHERE id='admin'")
                .execute(&mut db)
                .await
                .unwrap();
            db.close().await.unwrap();
        });
        let destination = dir.join("pharma_local.db");
        assert!(install_seed_database(&source, &destination).is_err());
        assert!(!destination.exists());
        assert_eq!(
            super::seed_file_sha256(&mut fs::File::open(&pinned).unwrap()).unwrap(),
            FRESH_PRIMARY_SEED_SHA256
        );
        // Even an otherwise unchanged pinned file with a hot sidecar is never
        // considered a standalone seed; original sidecar bytes stay untouched.
        fs::copy(&pinned, &source).unwrap();
        let sidecar = dir.join("foreign_seed.db-wal");
        fs::write(&sidecar, b"hot WAL marker").unwrap();
        assert!(install_seed_database(&source, &destination).is_err());
        assert_eq!(fs::read(&sidecar).unwrap(), b"hot WAL marker");
        assert!(!destination.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
