#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod database_backup;
mod schema;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
use tauri_plugin_sql::{Migration, MigrationKind};

const PURCHASE_DRAFT_ACCELERATOR: &str = "F10";

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
            let menu_item =
                MenuItem::with_id(app, item.id, item.label, true, item.accelerator)?;
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
            NativeRouteMenuItem { id: "dashboard", label: "لوحة التحكم (الرئيسية)", accelerator: Some("CmdOrCtrl+D") },
            NativeRouteMenuItem { id: "stores_items", label: "الأصناف", accelerator: None },
            NativeRouteMenuItem { id: "stores_alternatives", label: "البدائل", accelerator: None },
            NativeRouteMenuItem { id: "stores_nature", label: "النوع", accelerator: None },
            NativeRouteMenuItem { id: "stores_usage", label: "الاستخدام", accelerator: None },
            NativeRouteMenuItem { id: "stores_units", label: "الوحدات", accelerator: None },
            NativeRouteMenuItem { id: "stores_indications", label: "دواعي الاستعمال", accelerator: None },
            NativeRouteMenuItem { id: "stores_drug_indications", label: "الاصناف ودواعي الاستخدام", accelerator: None },
            NativeRouteMenuItem { id: "stores_manufacturers", label: "الشركات المنتجة", accelerator: None },
            NativeRouteMenuItem { id: "stores_scientific_groups", label: "المجموعات العلمية", accelerator: None },
            NativeRouteMenuItem { id: "stores_categories", label: "التصنيفات", accelerator: None },
        ],
    )?;

    // 3. العمليات المخزنية (Inventory Ops)
    let inventory_ops_menu = create_route_submenu(
        app,
        "العمليات المخزنية",
        &admin_access,
        &[
            NativeRouteMenuItem { id: "inventory", label: "المخزون", accelerator: Some("CmdOrCtrl+I") },
            NativeRouteMenuItem { id: "stores_shortages", label: "كشكول النواقص", accelerator: None },
            NativeRouteMenuItem { id: "inventory_item_movements", label: "حركات الأصناف", accelerator: None },
            NativeRouteMenuItem { id: "restock", label: "إعادة التموين", accelerator: None },
            NativeRouteMenuItem { id: "inventory_opening_balances", label: "الأرصدة الإفتتاحية", accelerator: None },
            NativeRouteMenuItem { id: "stores_adjustments", label: "التعديلات", accelerator: None },
            NativeRouteMenuItem { id: "stores_adjustment_reasons", label: "أسباب التعديل", accelerator: None },
            NativeRouteMenuItem { id: "inventory_settlement", label: "تسوية المخزون", accelerator: None },
            NativeRouteMenuItem { id: "stores_delete_items", label: "حذف الأصناف", accelerator: None },
        ],
    )?;

    // 4. المبيعات (Sales)
    let sales_menu = create_route_submenu(
        app,
        "المبيعات",
        &admin_access,
        &[
            NativeRouteMenuItem { id: "pos", label: "فاتورة مبيعات جديدة", accelerator: None },
            NativeRouteMenuItem { id: "receipts", label: "الفواتير", accelerator: None },
            NativeRouteMenuItem { id: "sales", label: "المبيعات والتحصيل", accelerator: None },
            NativeRouteMenuItem { id: "sales_delivery", label: "توصيل منزلي", accelerator: None },
            NativeRouteMenuItem { id: "sales_cogs", label: "تعديل التكلفة", accelerator: None },
            NativeRouteMenuItem { id: "sales_settlement", label: "تسوية المبيعات", accelerator: None },
            NativeRouteMenuItem { id: "returns", label: "مرتجعات العملاء", accelerator: None },
        ],
    )?;

    // 5. المشتريات (Purchases)
    let purchases_menu = create_route_submenu(
        app,
        "المشتريات",
        &admin_access,
        &[
            NativeRouteMenuItem { id: "purchases", label: "المشتريات", accelerator: Some("CmdOrCtrl+O") },
            NativeRouteMenuItem { id: "purchase_orders", label: "أوامر الشراء", accelerator: None },
            NativeRouteMenuItem { id: "purchases_suppliers", label: "الموردون", accelerator: None },
            NativeRouteMenuItem { id: "purchases_returns", label: "مرتجعات للموردين", accelerator: None },
        ],
    )?;

    // 6. المالية (Finance)
    let finance_menu = create_route_submenu(
        app,
        "المالية",
        &admin_access,
        &[
            NativeRouteMenuItem { id: "accounts", label: "الحسابات والمالية", accelerator: None },
            NativeRouteMenuItem { id: "accounts_cash_transactions", label: "حركة النقدية", accelerator: None },
            NativeRouteMenuItem { id: "finance_banks", label: "البنوك", accelerator: None },
            NativeRouteMenuItem { id: "finance_cards", label: "البطاقات والماكينات", accelerator: None },
            NativeRouteMenuItem { id: "finance_pos_management", label: "إدارة نقاط البيع", accelerator: None },
            NativeRouteMenuItem { id: "finance_accounts", label: "شجرة الحسابات", accelerator: None },
            NativeRouteMenuItem { id: "accounts_settings_trial_balance", label: "إعدادات ميزان المراجعة", accelerator: None },
        ],
    )?;

    // 7. التقارير (Reports)
    let reports_menu = create_route_submenu(
        app,
        "التقارير",
        &admin_access,
        &[
            NativeRouteMenuItem { id: "reports", label: "لوحة التقارير", accelerator: None },
            NativeRouteMenuItem { id: "reports_sales2", label: "تقارير المبيعات", accelerator: None },
            NativeRouteMenuItem { id: "reports_purchases", label: "تقارير المشتريات", accelerator: None },
            NativeRouteMenuItem { id: "reports_trial_balance", label: "ميزان المراجعة", accelerator: None },
            NativeRouteMenuItem { id: "expenses", label: "المصروفات", accelerator: None },
        ],
    )?;

    // 8. المرضى والطبية (Patients)
    let patients_menu = create_route_submenu(
        app,
        "المرضى والطبية",
        &admin_access,
        &[
            NativeRouteMenuItem { id: "patients", label: "المرضى", accelerator: None },
            NativeRouteMenuItem { id: "interactions", label: "التفاعلات الدوائية", accelerator: None },
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

#[tauri::command]
async fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    validate_export_file(&path, &data)?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

fn validate_export_file(path: &str, data: &[u8]) -> Result<(), String> {
    let path = Path::new(path);
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("xlsx"))
        != Some(true)
    {
        return Err("Only .xlsx exports are allowed".into());
    }
    if !data.starts_with(b"PK") {
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

fn install_seed_database(source: &Path, destination: &Path) -> io::Result<()> {
    match destination.metadata() {
        Ok(metadata) if metadata.len() > 0 => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "refusing to replace an existing database",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }

    let source_len = source.metadata()?.len();
    if source_len < 16 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "seed database is truncated",
        ));
    }

    let mut source_file = File::open(source)?;
    let mut header = [0_u8; 16];
    source_file.read_exact(&mut header)?;
    if &header != b"SQLite format 3\0" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "seed database is not SQLite",
        ));
    }
    source_file.seek(SeekFrom::Start(0))?;

    let mut temp_name = destination.as_os_str().to_owned();
    temp_name.push(".installing");
    let temp_path = std::path::PathBuf::from(temp_name);
    if temp_path.exists() {
        fs::remove_file(&temp_path)?;
    }

    let copy_result = (|| {
        let mut temp_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        let copied = io::copy(&mut source_file, &mut temp_file)?;
        if copied != source_len {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "seed database copy is incomplete",
            ));
        }
        temp_file.sync_all()
    })();
    if let Err(error) = copy_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    if destination.exists() {
        fs::remove_file(destination)?; // destination is known to be empty
    }
    fs::rename(temp_path, destination)
}

fn main() {
    // Ported SQL migrations matching Next.js SQLite schema
    let migrations = vec![
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
    ];

    tauri::Builder::default()
        .manage(commands::critical::DbTransactions::default())
        // Application menus are global on Windows; the shortcut invokes the command directly.
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "new_window" {
                if let Err(err) = open_new_window_for_app(app) {
                    eprintln!("failed to open new window: {}", err);
                }
            }
        })
        .setup(|app| {
            let menu = create_app_menu(app.handle(), NativeAdminMenuAccess::default())?;
            app.set_menu(menu)?;

            // Extract the seeded database from resources on first run
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;

            let db_path = app_data_dir.join("pharma_local.db");

            let should_copy_seed =
                !db_path.exists() || fs::metadata(&db_path).map(|m| m.len() == 0).unwrap_or(true);

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

            if let Some(seed_path) = seed_path {
                match schema::repair_catalog_name_drift(&db_path, &seed_path) {
                    Ok(repaired) if repaired > 0 => {
                        println!(
                            "Corrected {repaired} catalog/inventory price record(s) locally from the bundled CSV reference"
                        );
                    }
                    Ok(_) => {}
                    Err(error) => eprintln!("Catalog identity repair skipped: {error}"),
                }
            }

            let main_window = app
                .get_webview_window("main")
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "main window not found"))?;
            if let Err(error) = main_window.maximize() {
                eprintln!("Failed to maximize main window: {error}");
            }

            // Attach window-specific menu handler
            main_window.on_menu_event(|window, event| {
                handle_menu_event(window, event.id().as_ref());
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
        .invoke_handler(tauri::generate_handler![
            database_backup::export_database_backup,
            commands::auth::bcrypt_hash,
            commands::auth::bcrypt_compare,
            commands::critical::db_execute_guarded,
            commands::critical::db_select_guarded,
            commands::critical::db_transaction_begin,
            commands::critical::db_transaction_finish,
            commands::critical::process_checkout_critical,
            commands::critical::save_purchase_invoice_critical,
            commands::drug_replacement::replace_master_drug,
            commands::drug_replacement::reconcile_master_drug_group,
            commands::drug_replacement::correct_drug_barcode_conflict,
            commands::critical::delete_purchase_invoice_critical,
            commands::critical::create_return_critical,
            commands::critical::settle_negative_sale_item_critical,
            commands::purchase_returns::create_purchase_return_critical,
            schema::ensure_schema_compatibility,
            open_new_window,
            sync_native_admin_menu,
            log_frontend_error,
            write_binary_file,
        ])
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
        "sales_settlement" => "/sales/settlement",
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
        install_seed_database, native_menu_action, new_window_label, validate_export_file,
        NativeAdminMenuAccess, PURCHASE_DRAFT_ACCELERATOR,
    };
    use std::fs;

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
    }

    #[test]
    fn creates_unique_native_window_labels() {
        let first = new_window_label();
        let second = new_window_label();
        assert!(first.starts_with("window_"));
        assert_ne!(first, second);
    }

    #[test]
    fn installs_seed_atomically_in_unicode_path() {
        let dir = std::env::temp_dir().join(format!("pharma صيدلية {}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("seed.db");
        let destination = dir.join("app data.db");
        let mut bytes = b"SQLite format 3\0".to_vec();
        bytes.extend_from_slice(b"seed payload");
        fs::write(&source, &bytes).unwrap();
        fs::write(destination.with_extension("db.installing"), b"partial").unwrap();

        install_seed_database(&source, &destination).unwrap();

        assert_eq!(fs::read(&destination).unwrap(), bytes);
        assert!(!destination.with_extension("db.installing").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_to_replace_existing_nonempty_database() {
        let dir = std::env::temp_dir().join(format!("pharma existing db {}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("seed.db");
        let destination = dir.join("pharma_local.db");
        let mut seed_bytes = b"SQLite format 3\0".to_vec();
        seed_bytes.extend_from_slice(b"new seed payload");
        let existing_bytes = b"existing user database must remain untouched";
        fs::write(&source, &seed_bytes).unwrap();
        fs::write(&destination, existing_bytes).unwrap();

        let error = install_seed_database(&source, &destination).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&destination).unwrap(), existing_bytes);
        assert!(!destination.with_extension("db.installing").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
