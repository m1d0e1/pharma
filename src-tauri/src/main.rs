// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use tauri::{Manager, Emitter};
use tauri::menu::{Menu, Submenu, MenuItem, PredefinedMenuItem};
use tauri_plugin_sql::{Migration, MigrationKind};
use std::fs;

fn main() {
    // Ported SQL migrations matching Next.js SQLite schema
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial_schema",
            sql: include_str!("../migrations/001_initial.sql"),
            kind: MigrationKind::Up,
        }
    ];

    tauri::Builder::default()
        .setup(|app| {
            // 1. ملف (File)
            let file_menu = Submenu::with_items(app, "ملف", true, &[
                &MenuItem::with_id(app, "pos", "فاتورة مبيعات جديدة", true, Some("CmdOrCtrl+P"))?,
                &MenuItem::with_id(app, "purchases_new", "فاتورة مشتريات جديدة", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "new_window", "نافذة جديدة", true, Some("CmdOrCtrl+N"))?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "print", "طباعة", true, Some("CmdOrCtrl+Shift+P"))?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "logout", "تسجيل الخروج", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ])?;

            // 2. البيانات الأساسية (Master Data)
            let master_data_menu = Submenu::with_items(app, "البيانات الأساسية", true, &[
                &MenuItem::with_id(app, "dashboard", "لوحة التحكم (الرئيسية)", true, Some("CmdOrCtrl+D"))?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "stores_items", "الأصناف", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_alternatives", "البدائل", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_nature", "النوع", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_usage", "الاستخدام", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_units", "الوحدات", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_indications", "دواعي الاستعمال", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_drug_indications", "الاصناف ودواعي الاستخدام", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_manufacturers", "الشركات المنتجة", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_scientific_groups", "المجموعات العلمية", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_categories", "التصنيفات", true, None::<&str>)?,
            ])?;

            // 3. العمليات المخزنية (Inventory Ops)
            let inventory_ops_menu = Submenu::with_items(app, "العمليات المخزنية", true, &[
                &MenuItem::with_id(app, "inventory", "المخزون", true, Some("CmdOrCtrl+I"))?,
                &MenuItem::with_id(app, "stores_shortages", "كشكول النواقص", true, None::<&str>)?,
                &MenuItem::with_id(app, "inventory_item_movements", "حركات الأصناف", true, None::<&str>)?,
                &MenuItem::with_id(app, "restock", "إعادة التموين", true, None::<&str>)?,
                &MenuItem::with_id(app, "inventory_opening_balances", "الأرصدة الإفتتاحية", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_adjustments", "التعديلات", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_adjustment_reasons", "أسباب التعديل", true, None::<&str>)?,
                &MenuItem::with_id(app, "inventory_settlement", "تسوية المخزون", true, None::<&str>)?,
                &MenuItem::with_id(app, "stores_delete_items", "حذف الأصناف", true, None::<&str>)?,
            ])?;

            // 4. المبيعات (Sales)
            let sales_menu = Submenu::with_items(app, "المبيعات", true, &[
                &MenuItem::with_id(app, "receipts", "الفواتير", true, None::<&str>)?,
                &MenuItem::with_id(app, "sales", "المبيعات والتحصيل", true, None::<&str>)?,
                &MenuItem::with_id(app, "sales_delivery", "توصيل منزلي", true, None::<&str>)?,
                &MenuItem::with_id(app, "sales_cogs", "تعديل التكلفة", true, None::<&str>)?,
                &MenuItem::with_id(app, "sales_settlement", "تسوية المبيعات", true, None::<&str>)?,
                &MenuItem::with_id(app, "returns", "مرتجعات العملاء", true, None::<&str>)?,
            ])?;

            // 5. المشتريات (Purchases)
            let purchases_menu = Submenu::with_items(app, "المشتريات", true, &[
                &MenuItem::with_id(app, "purchases", "المشتريات", true, Some("CmdOrCtrl+O"))?,
                &MenuItem::with_id(app, "purchase_orders", "أوامر الشراء", true, None::<&str>)?,
                &MenuItem::with_id(app, "purchases_suppliers", "الموردون", true, None::<&str>)?,
                &MenuItem::with_id(app, "purchases_returns", "مرتجعات للموردين", true, None::<&str>)?,
                &MenuItem::with_id(app, "purchases_general_returns", "مرتجعات عامة", true, None::<&str>)?,
            ])?;

            // 6. المالية (Finance)
            let finance_menu = Submenu::with_items(app, "المالية", true, &[
                &MenuItem::with_id(app, "accounts", "الحسابات والمالية", true, None::<&str>)?,
                &MenuItem::with_id(app, "accounts_cash_transactions", "حركة النقدية", true, None::<&str>)?,
                &MenuItem::with_id(app, "finance_handover", "تسليم الدرج", true, None::<&str>)?,
                &MenuItem::with_id(app, "finance_banks", "البنوك", true, None::<&str>)?,
                &MenuItem::with_id(app, "finance_cards", "البطاقات والماكينات", true, None::<&str>)?,
                &MenuItem::with_id(app, "finance_pos_management", "إدارة نقاط البيع", true, None::<&str>)?,
                &MenuItem::with_id(app, "finance_accounts", "شجرة الحسابات", true, None::<&str>)?,
                &MenuItem::with_id(app, "accounts_settings_trial_balance", "إعدادات ميزان المراجعة", true, None::<&str>)?,
            ])?;

            // 7. التقارير (Reports)
            let reports_menu = Submenu::with_items(app, "التقارير", true, &[
                &MenuItem::with_id(app, "reports", "لوحة التقارير", true, None::<&str>)?,
                &MenuItem::with_id(app, "reports_sales2", "تقارير المبيعات", true, None::<&str>)?,
                &MenuItem::with_id(app, "reports_purchases", "تقارير المشتريات", true, None::<&str>)?,
                &MenuItem::with_id(app, "reports_trial_balance", "ميزان المراجعة", true, None::<&str>)?,
                &MenuItem::with_id(app, "expenses", "المصروفات", true, None::<&str>)?,
                &MenuItem::with_id(app, "shifts", "الشفتات النقدية", true, None::<&str>)?,
            ])?;

            // 8. المرضى والطبية (Patients)
            let patients_menu = Submenu::with_items(app, "المرضى والطبية", true, &[
                &MenuItem::with_id(app, "patients", "المرضى", true, None::<&str>)?,
                &MenuItem::with_id(app, "interactions", "التفاعلات الدوائية", true, None::<&str>)?,
            ])?;

            // 9. الإدارة (Administration)
            let admin_menu = Submenu::with_items(app, "الإدارة", true, &[
                &MenuItem::with_id(app, "staff", "أداء الموظفين", true, None::<&str>)?,
                &MenuItem::with_id(app, "staff_manage", "إدارة الموظفين", true, None::<&str>)?,
                &MenuItem::with_id(app, "staff_roles", "الوظائف والرواتب", true, None::<&str>)?,
                &MenuItem::with_id(app, "audit", "سجل المراقبة", true, None::<&str>)?,
                &MenuItem::with_id(app, "settings", "الإعدادات", true, None::<&str>)?,
            ])?;

            // 10. مساعدة (Help)
            let help_menu = Submenu::with_items(app, "مساعدة", true, &[
                &MenuItem::with_id(app, "update_program", "تحديث البرنامج", true, None::<&str>)?,
                &PredefinedMenuItem::separator(app)?,
                &MenuItem::with_id(app, "help_shortcuts", "اختصارات لوحة المفاتيح", true, None::<&str>)?,
                &MenuItem::with_id(app, "help_about", "عن النظام", true, None::<&str>)?,
            ])?;

            let menu = Menu::with_items(app, &[
                &help_menu,
                &reports_menu,
                &admin_menu,
                &patients_menu,
                &finance_menu,
                &purchases_menu,
                &sales_menu,
                &inventory_ops_menu,
                &master_data_menu,
                &file_menu,
            ])?;
            app.set_menu(menu)?;

            // Extract the seeded database from resources on first run
            let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
            
            fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
            
            let db_path = app_data_dir.join("pharma_local.db");
            
            if !db_path.exists() {
                let resource_path = app.path()
                    .resource_dir()
                    .expect("failed to get resource dir")
                    .join("pharma_local.db");
                
                    if resource_path.exists() {
                        fs::copy(&resource_path, &db_path).expect("failed to copy seeded database");
                        println!("Copied seeded database to {:?}", db_path);
                    }
                }
                
                let main_window = app.get_webview_window("main").unwrap();
                main_window.maximize().unwrap();
                
                // Attach window-specific menu handler
                main_window.on_menu_event(|window, event| {
                    handle_menu_event(window, event.id().as_ref());
                });
                
                Ok(())
            })
            .plugin(
                tauri_plugin_sql::Builder::default()
                    .add_migrations("sqlite:pharma_local.db", migrations)
                    .build()
            )
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_shell::init())
            .invoke_handler(tauri::generate_handler![
                commands::auth::bcrypt_hash,
                commands::auth::bcrypt_compare,
            ])
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
}

fn handle_menu_event(window: &tauri::Window, id: &str) {
    let route = match id {
        // Actions
        "new_window" => {
            let app = window.app_handle();
            let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string();
            if let Ok(w) = tauri::WebviewWindowBuilder::new(
                app,
                format!("window_{}", timestamp),
                tauri::WebviewUrl::App("/".into())
            )
            .title("Pharma Dashboard")
            .inner_size(1280.0, 800.0)
            .min_inner_size(800.0, 600.0)
            .build() {
                if let Some(menu) = app.menu() {
                    let _ = w.set_menu(menu);
                }
                let _ = w.maximize();
                w.on_menu_event(|win, event| {
                    handle_menu_event(win, event.id().as_ref());
                });
            }
            return;
        }
        "print" => {
            let _ = window.emit("menu-action", "print");
            return;
        }
        "logout" => {
            let _ = window.emit("menu-action", "logout");
            return;
        }
        "update_program" => {
            let _ = window.emit("menu-action", "update");
            return;
        }
        "help_shortcuts" => {
            let _ = window.emit("menu-action", "shortcuts");
            return;
        }
        "help_about" => {
            let _ = window.emit("menu-action", "about");
            return;
        }
        
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
        "finance_handover" => "/finance/handover",
        "finance_banks" => "/finance/banks",
        "finance_cards" => "/finance/cards",
        "finance_pos_management" => "/finance/pos-management",
        "finance_accounts" => "/finance/accounts",
        "accounts_settings_trial_balance" => "/accounts/settings/trial-balance",
        "reports" => "/reports",
        "reports_trial_balance" => "/reports/trial-balance",
        "reports_purchases" => "/reports/purchases",
        "expenses" => "/expenses",
        "shifts" => "/shifts",
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
    let _ = window.emit("menu-navigate", route);
}
