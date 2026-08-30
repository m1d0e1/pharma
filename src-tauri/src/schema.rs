use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, Row, Sqlite, SqliteConnection, Transaction};
use std::path::Path;
use std::str::FromStr;
use tauri::Manager;

#[allow(dead_code)]
struct ChecksumRepair {
    version: i64,
    migration: &'static str,
    current_lf: &'static str,
    current_crlf: &'static str,
    legacy: &'static [&'static str],
}

fn current_checksum(repair: &ChecksumRepair) -> &'static str {
    if repair
        .migration
        .as_bytes()
        .windows(2)
        .any(|bytes| bytes == b"\r\n")
    {
        repair.current_crlf
    } else {
        repair.current_lf
    }
}

fn checksum_requires_repair(repair: &ChecksumRepair, checksum: &str) -> Result<bool, String> {
    if checksum == current_checksum(repair) {
        Ok(false)
    } else if checksum == repair.current_lf
        || checksum == repair.current_crlf
        || repair.legacy.contains(&checksum)
    {
        Ok(true)
    } else {
        Err(format!(
            "unrecognized checksum for migration {}",
            repair.version
        ))
    }
}

const CHECKSUM_REPAIRS: &[ChecksumRepair] = &[
    ChecksumRepair {
        version: 1,
        migration: include_str!("../migrations/001_initial.sql"),
        current_lf: "BFCAAC7B5A1CEFC3C3C01F8E7DCC3CDB0D83447A39799B4FEAE46D97702BAF1FCD121650AF47C362BA020C4A83F99279",
        current_crlf: "42525F4D4569F70C306E310A9FA815167E3FFA7A8292BD5C2C4E403C49A30B8FFE42EC6DF1ECEA833E510D2843B6DCB7",
        legacy: &[
            "0A8DCA8624A89F518DA7B2D5C08BC364F3B675242BD57CC105E8B610B194E093325389EBF974166C8B7B082BEA0C111A",
            "00AEEB1683D8487B39C5B75AFACE44217DECC16A11A972E83E364A62A20F3AEA9126BCB2BCB6E3DBF4C368CF1E1162AA",
            "6EF41382A6590B2E6A487DB0D9560F9F826E203BA07ED7065E71016C53083911A864F55EFA6C204DDA6272167F8E6BDC",
            "BEC57847DA8403B63C28258329D6F9EEEB7FC894B1496393DCBB6527AAB25D7045EFE661B6BE6473B68C6A579C49A153",
            "F82014A0B12E5F2148E15B27514F88C074C127EA08140C38889D59CAC54695EF9BA4194FC77168A621732F9627A20AA2",
            "78532E45F393BD746018E6EC48E3DD3D661145347E5A0716C28424B1347B2F3BD98F4C7B70C9562950286660AFA22B6C",
            "2A80B93C05E98DF0C64648ED4C88215B5F0985853E4F389A2D2F82C721C7BDFA37823009D1FEA14B92E9AC979C0BB56A",
            "DE4E784D7C8659F5683F96DBD3C66E62D5A5EE715EC147C9E5E17D6915A97CF583065DE96F58C54450DF785BD6854D42",
        ],
    },
    ChecksumRepair {
        version: 2,
        migration: include_str!("../migrations/002_performance.sql"),
        current_lf: "8EE8A3F6C60E775A2E251D7566E966D8D23C6F3BFD43EBB6453C7C817B7B46C649D7D6C3611B1311B9BFF86922FFFD9C",
        current_crlf: "AFF13C262E80C34FF3F115DD6FB5C463760D247EB8B7B6705D0C775DE426E85F70D055F9DBEF1D3EDFF157E3D981261C",
        legacy: &[
            "1D375CF6D1CC6170CA5EC70CE930AD0F9F4D6E0355E5A7ED2637E683D5721A96D62D53C37E573E260B617513DF883375",
            "EB5B98F60883978153907406799C9010EE82FD3B6233E54E3EF0ABE66C182CC4B967378D5C2F431F4180AE8544F7B049",
        ],
    },
    ChecksumRepair {
        version: 4,
        migration: include_str!("../migrations/004_return_items_patch.sql"),
        current_lf: "CF8CB76E3264BA762F3CC260B56FB253BEF65AD4C7B80D6E7DA2F950AB9AD5A88CB0DB45072EF2ECE5E3C553AD00D85F",
        current_crlf: "CCCC9C702E8C1C1D270BF2F43F4F7441C9FCAA3A83A074268BC8E1B52051B8B74E18BA70B79E6D8D1EC8E6948451CA3D",
        legacy: &["DC6E060272C078A60806DDBE5DBCC30F42837A45725E0A02163D72863B6F5523E2A51618D4215AEE0E3721748C90125D"],
    },
    ChecksumRepair {
        version: 5,
        migration: include_str!("../migrations/005_purchase_return_details.sql"),
        current_lf: "06CDB339DAF88B9A19B495D4F48AEB5450A3AEA9EE02BB36E69C6C4ABE3F7FA6BA4C0657841FEE7F0102ABFCC2115DC7",
        current_crlf: "EF47F00BA64B2FA378D716E2AD3325AB6E1938B2A97A9F0AD2CE6F047224CA0896896805EB3213B23613F310619F58C3",
        legacy: &["5EDF8FB853589FF8E8C5DE39B9A3432B940C4DB1BC1F0A43438C2B14D376DB187063BDE0F6C55E34C4C2EE261AA3F5A7"],
    },
    ChecksumRepair {
        version: 7,
        migration: include_str!("../migrations/007_purchase_inventory_links.sql"),
        current_lf: "ADD70A4E03CA17C0E204F600C91803410D880921B6C6A2504D39309E684CA58B2B7B2CA683BDF3E1EB7ABA6EE96C64AE",
        current_crlf: "1AF436DBA20429D9EF69ECA504162C15D8DA72A70758C5B53AAEE9B33D46A699704D8DC5F11C425E3D2E9F4A09175A63",
        legacy: &["48DF50E8B76D93E61F77DEB39E7498CFA1D34B6A7AB76DC1E773320F1B1D448C43B191746F5958858AD1C6F75C6E6013"],
    },
    ChecksumRepair {
        version: 12,
        migration: include_str!("../migrations/012_shortages_pharmacy_scope.sql"),
        current_lf: "9B61A35D24740028564415DEBDAAFAC4034BE186059935E7E953102758B57FCF46493EED076DFCB3C4F4D4F6438E7FBE",
        current_crlf: "53A4E46FF6E3475A2E1CED2A37AB65C6F41B3066B07C7A1E4FD7A5499902B0C76B656359EAA13C76BA36609EBB5C71A0",
        legacy: &[
            "390BDCB64ED1FBE1C12E844281BB50251DED58D07B2B1AFB54F80BCE2B179E6C8E1026153452274980FC2271C2B6C1C6",
            "439E557C6F5CF1D421B704D34066717BDD3FF61D6FFA77B13BF51638F6FD4FD7FB70BBF6F32E4534E921A985E909B01A",
        ],
    },
];

fn options(path: &Path) -> Result<SqliteConnectOptions, String> {
    SqliteConnectOptions::from_str(&format!("sqlite:{}", path.display()))
        .map(|options| options.create_if_missing(true).foreign_keys(true))
        .map_err(|error| error.to_string())
}

async fn connect(path: &Path) -> Result<SqliteConnection, String> {
    let mut connection = SqliteConnection::connect_with(&options(path)?)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("PRAGMA busy_timeout = 5000")
        .execute(&mut connection)
        .await
        .map_err(|e| e.to_string())?;
    Ok(connection)
}

async fn table_exists(executor: &mut SqliteConnection, table: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?)",
    )
    .bind(table)
    .fetch_one(executor)
    .await
}

async fn has_column(
    transaction: &mut Transaction<'_, Sqlite>,
    table: &str,
    column: &str,
) -> Result<bool, sqlx::Error> {
    let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
        .fetch_all(&mut **transaction)
        .await?;
    Ok(rows
        .iter()
        .any(|row| row.get::<String, _>("name") == column))
}

async fn add_column(
    transaction: &mut Transaction<'_, Sqlite>,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), sqlx::Error> {
    if !has_column(transaction, table, column).await? {
        sqlx::raw_sql(&format!("ALTER TABLE {table} ADD COLUMN {definition}"))
            .execute(&mut **transaction)
            .await?;
    }
    Ok(())
}

async fn repair_unambiguous_shift_links(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<u64, sqlx::Error> {
    let shifts_ready = has_column(transaction, "shifts", "user_id").await?
        && has_column(transaction, "shifts", "start_time").await?
        && has_column(transaction, "shifts", "end_time").await?;
    if !shifts_ready {
        return Ok(0);
    }

    let mut repaired = 0;
    if has_column(transaction, "sales_invoices", "user_id").await?
        && has_column(transaction, "sales_invoices", "shift_id").await?
        && has_column(transaction, "sales_invoices", "status").await?
        && has_column(transaction, "sales_invoices", "created_at").await?
    {
        repaired += sqlx::query(
            r#"
            UPDATE sales_invoices AS invoice
            SET shift_id = (
              SELECT MIN(shift.id)
              FROM shifts shift
              WHERE shift.user_id = invoice.user_id
                AND datetime(invoice.created_at) >= datetime(shift.start_time)
                AND (shift.end_time IS NULL OR datetime(invoice.created_at) <= datetime(shift.end_time))
              HAVING COUNT(*) = 1
            )
            WHERE invoice.shift_id IS NULL
              AND LOWER(COALESCE(invoice.status, '')) IN ('completed', 'delivered')
              AND (
                SELECT COUNT(*)
                FROM shifts shift
                WHERE shift.user_id = invoice.user_id
                  AND datetime(invoice.created_at) >= datetime(shift.start_time)
                  AND (shift.end_time IS NULL OR datetime(invoice.created_at) <= datetime(shift.end_time))
              ) = 1
            "#,
        )
        .execute(&mut **transaction)
        .await?
        .rows_affected();
    }

    if has_column(transaction, "returns", "user_id").await?
        && has_column(transaction, "returns", "shift_id").await?
        && has_column(transaction, "returns", "status").await?
        && has_column(transaction, "returns", "created_at").await?
    {
        repaired += sqlx::query(
            r#"
            UPDATE returns AS customer_return
            SET shift_id = (
              SELECT MIN(shift.id)
              FROM shifts shift
              WHERE shift.user_id = customer_return.user_id
                AND datetime(customer_return.created_at) >= datetime(shift.start_time)
                AND (shift.end_time IS NULL OR datetime(customer_return.created_at) <= datetime(shift.end_time))
              HAVING COUNT(*) = 1
            )
            WHERE customer_return.shift_id IS NULL
              AND LOWER(COALESCE(customer_return.status, '')) IN ('approved', 'completed')
              AND (
                SELECT COUNT(*)
                FROM shifts shift
                WHERE shift.user_id = customer_return.user_id
                  AND datetime(customer_return.created_at) >= datetime(shift.start_time)
                  AND (shift.end_time IS NULL OR datetime(customer_return.created_at) <= datetime(shift.end_time))
              ) = 1
            "#,
        )
        .execute(&mut **transaction)
        .await?
        .rows_affected();
    }

    Ok(repaired)
}

async fn ensure_compatibility(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<(), sqlx::Error> {
    sqlx::raw_sql(
        r#"
        CREATE TABLE IF NOT EXISTS purchase_returns (
          id TEXT PRIMARY KEY,
          supplier_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          purchase_invoice_id TEXT,
          reason TEXT,
          total_amount REAL,
          refund_method TEXT DEFAULT 'credit',
          status TEXT DEFAULT 'completed',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
        );

        CREATE TABLE IF NOT EXISTS purchase_return_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          purchase_return_id TEXT NOT NULL,
          inventory_id TEXT,
          drug_id INTEGER,
          drug_name TEXT,
          quantity_returned INTEGER,
          unit_price REAL,
          total_price REAL,
          reason TEXT,
          purchase_invoice_item_id INTEGER,
          unit TEXT DEFAULT 'large',
          FOREIGN KEY (purchase_return_id) REFERENCES purchase_returns (id)
        );

        CREATE TABLE IF NOT EXISTS returns (
          id TEXT PRIMARY KEY,
          invoice_id TEXT,
          user_id TEXT,
          shift_id TEXT,
          reason TEXT,
          total_refund REAL,
          refund_method TEXT DEFAULT 'cash',
          status TEXT DEFAULT 'pending',
          approved_by TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS suppliers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          name_en TEXT,
          phone TEXT,
          address TEXT,
          balance REAL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS supplier_transactions (
          id TEXT PRIMARY KEY,
          supplier_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          payment_method TEXT DEFAULT 'cash',
          notes TEXT,
          date TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS return_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          return_id TEXT,
          inventory_id TEXT,
          drug_id INTEGER,
          drug_name TEXT,
          quantity_returned REAL,
          unit_price REAL,
          total_price REAL,
          sale_item_id INTEGER,
          unit TEXT DEFAULT 'large'
        );

        CREATE TABLE IF NOT EXISTS refill_reminders (
          id TEXT PRIMARY KEY,
          patient_id TEXT,
          drug_id INTEGER,
          last_sold_date TEXT,
          next_refill_date TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (patient_id) REFERENCES patients (id),
          FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
        );

        CREATE TABLE IF NOT EXISTS patient_allergies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id TEXT NOT NULL,
          allergen TEXT NOT NULL,
          severity TEXT DEFAULT 'moderate',
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (patient_id) REFERENCES patients (id)
        );

        CREATE TABLE IF NOT EXISTS patient_conditions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id TEXT NOT NULL,
          condition_name TEXT NOT NULL,
          diagnosed_date TEXT,
          medications TEXT,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (patient_id) REFERENCES patients (id)
        );

        CREATE TABLE IF NOT EXISTS patient_transactions (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          payment_method TEXT DEFAULT 'cash',
          notes TEXT,
          date TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (patient_id) REFERENCES patients (id),
          FOREIGN KEY (user_id) REFERENCES users (id)
        );

        CREATE TABLE IF NOT EXISTS financial_notices (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          reason TEXT,
          notes TEXT,
          date TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id)
        );

        CREATE TABLE IF NOT EXISTS cash_movements (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          shift_id TEXT,
          type TEXT NOT NULL,
          category TEXT NOT NULL,
          sub_category TEXT,
          amount REAL NOT NULL,
          source_type TEXT,
          target_name TEXT,
          notes TEXT,
          date TEXT NOT NULL,
          actual_date TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id),
          FOREIGN KEY (shift_id) REFERENCES shifts (id)
        );

        CREATE TABLE IF NOT EXISTS stock_adjustments (
          id TEXT PRIMARY KEY,
          pharmacy_id TEXT,
          user_id TEXT NOT NULL,
          inventory_id TEXT NOT NULL,
          old_quantity REAL,
          new_quantity REAL,
          adjustment_quantity REAL NOT NULL,
          reason TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS shortages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          drug_id INTEGER NOT NULL,
          pharmacy_id TEXT NOT NULL DEFAULT 'local_default',
          requested_quantity REAL DEFAULT 1,
          priority TEXT DEFAULT 'normal',
          status TEXT DEFAULT 'pending',
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
        );

        CREATE TABLE IF NOT EXISTS config (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS drug_indications (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER, indication TEXT);
        CREATE TABLE IF NOT EXISTS drug_interactions (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_1_id INTEGER, drug_2_id INTEGER, severity TEXT, description TEXT);
        CREATE TABLE IF NOT EXISTS drug_alternatives (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER, alternative_drug_id INTEGER);
        CREATE TABLE IF NOT EXISTS indications (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS usage_methods (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS scientific_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS item_natures (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS manufacturers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS product_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS employee_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT, name_en TEXT, min_salary REAL DEFAULT 0, max_salary REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, category TEXT, amount REAL, notes TEXT, user_id TEXT, date TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS expense_definitions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS banks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS credit_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS points_of_sale (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS commercial_papers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        CREATE TABLE IF NOT EXISTS opening_balances (id TEXT PRIMARY KEY, date TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS opening_balance_items (id INTEGER PRIMARY KEY AUTOINCREMENT, opening_balance_id TEXT, drug_id INTEGER, quantity REAL, cost_price REAL);
        CREATE TABLE IF NOT EXISTS adjustment_reasons (id INTEGER PRIMARY KEY AUTOINCREMENT, reason TEXT);
        CREATE TABLE IF NOT EXISTS purchase_orders (id TEXT PRIMARY KEY, supplier_id INTEGER, status TEXT DEFAULT 'pending', total_amount REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS purchase_order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT, drug_id INTEGER, quantity INTEGER, cost_price REAL);
        CREATE TABLE IF NOT EXISTS sync_metadata (key TEXT PRIMARY KEY, value TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);

        CREATE VIRTUAL TABLE IF NOT EXISTS master_drugs_fts USING fts5(
          trade_name,
          trade_name_en,
          active_ingredient,
          barcode,
          content='master_drugs',
          content_rowid='id'
        );
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    // Older fallback databases used an incompatible shortage shape. Rebuild it once so
    // every UI path can use the same auto-increment id and requested_quantity columns.
    if !has_column(transaction, "shortages", "requested_quantity").await?
        && has_column(transaction, "shortages", "quantity_needed").await?
    {
        sqlx::raw_sql(
            r#"
            CREATE TABLE shortages_compat (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              drug_id INTEGER NOT NULL,
              pharmacy_id TEXT NOT NULL DEFAULT 'local_default',
              requested_quantity REAL DEFAULT 1,
              priority TEXT DEFAULT 'normal',
              status TEXT DEFAULT 'pending',
              notes TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
            );

            INSERT INTO shortages_compat (
              drug_id, pharmacy_id, requested_quantity, priority, status, notes, created_at
            )
            SELECT
              drug_id,
              'local_default',
              MAX(1, COALESCE(quantity_needed, 1)),
              COALESCE(priority, 'normal'),
              COALESCE(status, 'pending'),
              notes,
              COALESCE(created_at, CURRENT_TIMESTAMP)
            FROM shortages
            WHERE drug_id IS NOT NULL;

            DROP TABLE shortages;
            ALTER TABLE shortages_compat RENAME TO shortages;
            "#,
        )
        .execute(&mut **transaction)
        .await?;
    }

    for (table, column, definition) in [
        ("master_drugs", "base_price", "base_price REAL DEFAULT 0"),
        ("master_drugs", "code_2", "code_2 TEXT"),
        ("master_drugs", "item_nature", "item_nature TEXT"),
        ("master_drugs", "scientific_group", "scientific_group TEXT"),
        ("master_drugs", "usage_method", "usage_method TEXT"),
        (
            "master_drugs",
            "active_ingredient_ratio",
            "active_ingredient_ratio TEXT",
        ),
        ("master_drugs", "is_table", "is_table INTEGER DEFAULT 0"),
        ("master_drugs", "indications", "indications TEXT"),
        ("master_drugs", "side_effects", "side_effects TEXT"),
        ("master_drugs", "no_return", "no_return INTEGER DEFAULT 0"),
        ("master_drugs", "barcode", "barcode TEXT"),
        ("master_drugs", "generic_name", "generic_name TEXT"),
        ("master_drugs", "manufacturer", "manufacturer TEXT"),
        (
            "master_drugs",
            "is_medicine",
            "is_medicine INTEGER DEFAULT 1",
        ),
        ("master_drugs", "is_service", "is_service INTEGER DEFAULT 0"),
        (
            "master_drugs",
            "is_refrigerated",
            "is_refrigerated INTEGER DEFAULT 0",
        ),
        ("master_drugs", "is_chronic", "is_chronic INTEGER DEFAULT 0"),
        ("master_drugs", "has_expiry", "has_expiry INTEGER DEFAULT 1"),
        ("master_drugs", "origin", "origin TEXT"),
        ("master_drugs", "notes", "notes TEXT"),
        ("master_drugs", "min_limit", "min_limit REAL DEFAULT 0"),
        ("master_drugs", "max_limit", "max_limit REAL DEFAULT 0"),
        (
            "master_drugs",
            "reorder_point",
            "reorder_point REAL DEFAULT 0",
        ),
        (
            "master_drugs",
            "default_purchase_qty",
            "default_purchase_qty REAL DEFAULT 1",
        ),
        (
            "master_drugs",
            "prevent_fractions",
            "prevent_fractions INTEGER DEFAULT 0",
        ),
        ("master_drugs", "tax_percent", "tax_percent REAL DEFAULT 0"),
        (
            "master_drugs",
            "discount_percent",
            "discount_percent REAL DEFAULT 0",
        ),
        (
            "master_drugs",
            "stop_dealing",
            "stop_dealing INTEGER DEFAULT 0",
        ),
        (
            "inventory",
            "min_stock_level",
            "min_stock_level INTEGER DEFAULT 5",
        ),
        ("inventory", "supplier", "supplier TEXT"),
        ("inventory", "unit_price", "unit_price REAL"),
        ("inventory", "barcode", "barcode TEXT"),
        (
            "inventory",
            "strips_per_box",
            "strips_per_box INTEGER DEFAULT 1",
        ),
        ("purchase_invoices", "expenses", "expenses REAL DEFAULT 0"),
        (
            "purchase_invoices",
            "discount_value",
            "discount_value REAL DEFAULT 0",
        ),
        (
            "purchase_invoices",
            "discount_percent",
            "discount_percent REAL DEFAULT 0",
        ),
        ("purchase_invoices", "updated_at", "updated_at DATETIME"),
        (
            "sales_invoices",
            "paid_amount",
            "paid_amount REAL DEFAULT 0",
        ),
        (
            "sales_invoices",
            "remaining_amount",
            "remaining_amount REAL DEFAULT 0",
        ),
        ("returns", "approved_by", "approved_by TEXT"),
        ("return_items", "drug_id", "drug_id INTEGER"),
        ("return_items", "total_price", "total_price REAL"),
        ("return_items", "sale_item_id", "sale_item_id INTEGER"),
        ("return_items", "unit", "unit TEXT DEFAULT 'large'"),
        (
            "purchase_invoice_items",
            "strips_per_box",
            "strips_per_box INTEGER DEFAULT 1",
        ),
        (
            "purchase_invoice_items",
            "inventory_id",
            "inventory_id TEXT",
        ),
        ("purchase_invoice_items", "barcode", "barcode TEXT"),
        (
            "purchase_returns",
            "purchase_invoice_id",
            "purchase_invoice_id TEXT",
        ),
        (
            "purchase_return_items",
            "purchase_invoice_item_id",
            "purchase_invoice_item_id INTEGER",
        ),
        ("purchase_return_items", "unit", "unit TEXT DEFAULT 'large'"),
        ("patients", "name_en", "name_en TEXT"),
        (
            "patients",
            "loyalty_level",
            "loyalty_level TEXT DEFAULT 'silver'",
        ),
        (
            "patients",
            "opening_balance",
            "opening_balance REAL DEFAULT 0",
        ),
        (
            "patients",
            "wallet_balance",
            "wallet_balance REAL DEFAULT 0",
        ),
        (
            "patients",
            "points_balance",
            "points_balance REAL DEFAULT 0",
        ),
        ("financial_notices", "target_type", "target_type TEXT"),
        ("financial_notices", "target_id", "target_id TEXT"),
        ("shifts", "ending_cash", "ending_cash REAL"),
        ("shifts", "notes", "notes TEXT"),
        ("shifts", "actual_cash", "actual_cash REAL"),
        ("shifts", "transfer_amount", "transfer_amount REAL DEFAULT 0"),
        ("shifts", "transfer_target", "transfer_target TEXT"),
        ("shifts", "cash_difference", "cash_difference REAL DEFAULT 0"),
        ("shifts", "receiver_id", "receiver_id TEXT"),
        ("cash_movements", "sub_category", "sub_category TEXT"),
        ("cash_movements", "actual_date", "actual_date TEXT"),
        ("cash_movements", "source_type", "source_type TEXT"),
        ("cash_movements", "target_name", "target_name TEXT"),
        ("shortages", "priority", "priority TEXT DEFAULT 'normal'"),
        ("shortages", "notes", "notes TEXT"),
        (
            "shortages",
            "pharmacy_id",
            "pharmacy_id TEXT NOT NULL DEFAULT 'local_default'",
        ),
        (
            "shortages",
            "requested_quantity",
            "requested_quantity REAL DEFAULT 1",
        ),
        (
            "shortages",
            "status",
            "status TEXT DEFAULT 'pending'",
        ),
        (
            "shortages",
            "created_at",
            "created_at DATETIME DEFAULT CURRENT_TIMESTAMP",
        ),
        ("suppliers", "balance", "balance REAL DEFAULT 0"),
        ("suppliers", "phone", "phone TEXT"),
        ("suppliers", "address", "address TEXT"),
        ("suppliers", "name_en", "name_en TEXT"),
        ("users", "username", "username TEXT"),
        ("users", "password_hash", "password_hash TEXT"),
        ("users", "role", "role TEXT DEFAULT 'cashier'"),
        ("users", "full_name", "full_name TEXT"),
        ("users", "pharmacy_id", "pharmacy_id TEXT"),
        (
            "users",
            "permissions",
            "permissions TEXT DEFAULT '{\"can_sell\": true, \"can_manage_inventory\": false}'",
        ),
        ("users", "is_active", "is_active INTEGER DEFAULT 1"),
        ("users", "job_id", "job_id INTEGER"),
        ("users", "qualification", "qualification TEXT"),
        ("users", "hire_date", "hire_date TEXT"),
        ("users", "shift", "shift TEXT"),
        ("users", "code", "code TEXT"),
        ("sales_invoices", "notes", "notes TEXT"),
        ("adjustment_reasons", "name_ar", "name_ar TEXT"),
        ("adjustment_reasons", "name_en", "name_en TEXT"),
        ("adjustment_reasons", "reason", "reason TEXT"),
        ("master_drugs", "trade_name_en", "trade_name_en TEXT"),
        ("employee_jobs", "name_ar", "name_ar TEXT"),
        ("employee_jobs", "name_en", "name_en TEXT"),
        ("employee_jobs", "min_salary", "min_salary REAL DEFAULT 0"),
        ("employee_jobs", "max_salary", "max_salary REAL DEFAULT 0"),
        ("employee_jobs", "created_at", "created_at DATETIME"),
    ] {
        add_column(transaction, table, column, definition).await?;
    }

    // ponytail: only one matching user/time window is safe to repair automatically.
    repair_unambiguous_shift_links(transaction).await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_shortages_pharmacy_drug_status ON shortages(pharmacy_id, drug_id, status)",
    )
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_shortages_pharmacy_status ON shortages(pharmacy_id, status)",
    )
    .execute(&mut **transaction)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_shortages_drug_id ON shortages(drug_id)",
    )
    .execute(&mut **transaction)
    .await?;

    let user_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&mut **transaction)
        .await
        .unwrap_or(0);
    if user_count == 0 {
        sqlx::raw_sql(
            r#"
            INSERT OR IGNORE INTO users (id, username, password_hash, role, full_name, permissions, is_active)
            VALUES (
              'admin',
              'admin',
              '$2b$12$.FYM9XhLwanE5PdySaxB2uMwZwwLpF9fI6HXf/2XArluRQt0kfvVm',
              'owner',
              'System Administrator',
              '{"view_dashboard":true,"view_reports":true,"manage_inventory":true,"manage_staff":true,"process_sales":true,"manage_patients":true,"view_all_sales":true,"manage_settings":true,"void_transactions":true,"manage_shifts":true,"manage_pharmacy":true,"export_data":true,"import_data":true,"view_audit_logs":true,"can_sell":true,"can_view_patients":true,"can_view_sales":true,"can_manage_inventory":true,"can_view_reports":true,"can_manage_users":true,"can_manage_settings":true,"can_view_shifts":true,"can_manage_shifts":true,"can_view_returns":true,"can_view_purchases":true}',
              1
            );
            "#,
        )
        .execute(&mut **transaction)
        .await?;
    }

    sqlx::raw_sql(
        r#"
        UPDATE purchase_invoices
        SET updated_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
        WHERE updated_at IS NULL;

        CREATE TRIGGER IF NOT EXISTS purchase_invoices_set_updated_at
        AFTER INSERT ON purchase_invoices
        WHEN NEW.updated_at IS NULL
        BEGIN
          UPDATE purchase_invoices SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
        END;

        UPDATE employee_jobs
        SET name_ar = 'وظيفة'
        WHERE (name_ar IS NULL OR name_ar = '');

        CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_activity_log_action ON activity_log(action);
        CREATE INDEX IF NOT EXISTS idx_shifts_status ON shifts(status);
        CREATE INDEX IF NOT EXISTS idx_shifts_user_status ON shifts(user_id, status) WHERE status = 'open';
        CREATE INDEX IF NOT EXISTS idx_purchase_items_inventory_id ON purchase_invoice_items(inventory_id);
        CREATE INDEX IF NOT EXISTS idx_inventory_barcode ON inventory(barcode) WHERE barcode IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_inventory_drug_qty_expiry ON inventory(drug_id, quantity, expiry_date) WHERE quantity > 0;
        CREATE INDEX IF NOT EXISTS idx_inventory_pharmacy_qty_exp ON inventory(pharmacy_id, quantity, expiry_date) WHERE quantity > 0;

        -- Old completed receipts predate inventory_id. Prefer their exact receipt
        -- batch; otherwise link only one unambiguous, sufficiently stocked lot.
        UPDATE purchase_invoice_items
        SET inventory_id = (
          SELECT MIN(i.id)
          FROM purchase_invoices pi
          JOIN inventory i
            ON i.drug_id = purchase_invoice_items.drug_id
           AND COALESCE(NULLIF(TRIM(i.pharmacy_id), ''), 'local_default') =
               COALESCE(NULLIF(TRIM(pi.pharmacy_id), ''), 'local_default')
           AND COALESCE(
                 CASE WHEN i.expiry_date LIKE '__/__/____'
                      THEN substr(i.expiry_date, 7, 4) || '-' || substr(i.expiry_date, 4, 2) || '-' || substr(i.expiry_date, 1, 2)
                      ELSE NULLIF(TRIM(i.expiry_date), '') END,
                 ''
               ) = COALESCE(
                 CASE WHEN purchase_invoice_items.expiry_date LIKE '__/__/____'
                      THEN substr(purchase_invoice_items.expiry_date, 7, 4) || '-' || substr(purchase_invoice_items.expiry_date, 4, 2) || '-' || substr(purchase_invoice_items.expiry_date, 1, 2)
                      ELSE NULLIF(TRIM(purchase_invoice_items.expiry_date), '') END,
                 ''
               )
           AND NULLIF(TRIM(i.batch_number), '') = COALESCE(
                 NULLIF(TRIM(pi.invoice_number), ''),
                 'BATCH-' || substr(pi.id, 1, 8)
               )
          WHERE pi.id = purchase_invoice_items.invoice_id
            AND LOWER(COALESCE(pi.status, '')) = 'completed'
          HAVING COUNT(*) = 1
        )
        WHERE inventory_id IS NULL;

        -- ponytail: ambiguity is safer than a wrong historical link. If several
        -- compatible lots exist, leave the receipt unlinked for manual resolution.
        UPDATE purchase_invoice_items
        SET inventory_id = (
          SELECT MIN(i.id)
          FROM purchase_invoices pi
          JOIN inventory i
            ON i.drug_id = purchase_invoice_items.drug_id
           AND COALESCE(NULLIF(TRIM(i.pharmacy_id), ''), 'local_default') =
               COALESCE(NULLIF(TRIM(pi.pharmacy_id), ''), 'local_default')
           AND COALESCE(
                 CASE WHEN i.expiry_date LIKE '__/__/____'
                      THEN substr(i.expiry_date, 7, 4) || '-' || substr(i.expiry_date, 4, 2) || '-' || substr(i.expiry_date, 1, 2)
                      ELSE NULLIF(TRIM(i.expiry_date), '') END,
                 ''
               ) = COALESCE(
                 CASE WHEN purchase_invoice_items.expiry_date LIKE '__/__/____'
                      THEN substr(purchase_invoice_items.expiry_date, 7, 4) || '-' || substr(purchase_invoice_items.expiry_date, 4, 2) || '-' || substr(purchase_invoice_items.expiry_date, 1, 2)
                      ELSE NULLIF(TRIM(purchase_invoice_items.expiry_date), '') END,
                 ''
               )
           AND CAST(i.quantity AS REAL) + 0.000001 >=
               CAST(purchase_invoice_items.quantity + COALESCE(purchase_invoice_items.bonus_quantity, 0) AS REAL)
          WHERE pi.id = purchase_invoice_items.invoice_id
            AND LOWER(COALESCE(pi.status, '')) = 'completed'
          HAVING COUNT(*) = 1
        )
        WHERE inventory_id IS NULL;

        -- Self-heal placeholder Drug xxxx names in master_drugs if the other name field holds the real name
        UPDATE master_drugs
        SET trade_name = trade_name_en
        WHERE (trade_name IS NULL OR TRIM(trade_name) = '' OR trade_name GLOB 'Drug [0-9]*' OR trade_name GLOB 'Drug #[0-9]*')
          AND trade_name_en IS NOT NULL AND TRIM(trade_name_en) != ''
          AND trade_name_en NOT GLOB 'Drug [0-9]*' AND trade_name_en NOT GLOB 'Drug #[0-9]*';

        UPDATE master_drugs
        SET trade_name_en = trade_name
        WHERE (trade_name_en IS NULL OR TRIM(trade_name_en) = '' OR trade_name_en GLOB 'Drug [0-9]*' OR trade_name_en GLOB 'Drug #[0-9]*')
          AND trade_name IS NOT NULL AND TRIM(trade_name) != ''
          AND trade_name NOT GLOB 'Drug [0-9]*' AND trade_name NOT GLOB 'Drug #[0-9]*';

        INSERT OR IGNORE INTO units (id, name_ar, name_en) VALUES
          (1, 'علبة', 'Box'), (2, 'شريط', 'Strip'), (3, 'قرص', 'Pill'),
          (4, 'كبسولة', 'Capsule'), (5, 'أمبول', 'Ampoule'), (6, 'فيال', 'Vial'),
          (7, 'زجاجة', 'Bottle'), (8, 'أنبوبة', 'Tube'), (9, 'كيس', 'Sachet'),
          (10, 'قطرة', 'Drops'), (11, 'حقنة', 'Syringe');

        INSERT OR IGNORE INTO item_natures (id, name_ar, name_en) VALUES
          (1, 'أدوية', 'Drugs'), (2, 'مستلزمات طبية', 'Medical Supplies'),
          (3, 'مستحضرات تجميل', 'Cosmetics'), (4, 'أجهزة طبية', 'Medical Devices'),
          (5, 'مكملات غذائية', 'Nutritional Supplements'), (6, 'مواد تعقيم', 'Disinfectants'),
          (7, 'حفاضات ومستلزمات الأطفال', 'Baby Products'),
          (8, 'منتجات الأم والطفل', 'Mother & Baby Care');

        CREATE TABLE IF NOT EXISTS supplier_transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          supplier_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          amount REAL NOT NULL,
          reference_id TEXT,
          notes TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
        );
        CREATE INDEX IF NOT EXISTS idx_supplier_transactions_supplier ON supplier_transactions(supplier_id);
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    // Seed rows added to old migrations are not replayed on upgrades. Keep every
    // account used by purchase/POS transactions self-healing on each startup.
    sqlx::raw_sql(
        r#"
        INSERT OR IGNORE INTO accounts (code, name_ar, name_en, type, is_group) VALUES
          ('1.1.1', 'الصندوق', 'Cash Drawer', 'asset', 0),
          ('2.1', 'دائنون', 'Accounts Payable', 'liability', 0),
          ('1.1.2', 'حسابات العملاء', 'Accounts Receivable', 'asset', 0),
          ('3.1', 'إيرادات المبيعات', 'Sales Revenue', 'revenue', 0),
          ('1.1.3', 'المخزون السلعي', 'Inventory Asset', 'asset', 0),
          ('4.1', 'تكلفة البضاعة المباعة', 'Cost of Goods Sold', 'expense', 0),
          ('1.1.4', 'تسويات البنوك', 'Bank Clearing', 'asset', 0),
          ('2.2', 'أرصدة محافظ العملاء', 'Patient Wallet Liability', 'liability', 0),
          ('4.2', 'تسويات حسابات العملاء', 'Customer Adjustments', 'expense', 0),
          ('3.9', 'حقوق ملكية الأرصدة الافتتاحية', 'Opening Balance Equity', 'equity', 0);

        WITH required(category, code) AS (VALUES
          ('cash_drawer', '1.1.1'),
          ('accounts_payable', '2.1'),
          ('accounts_receivable', '1.1.2'),
          ('sales_revenue', '3.1'),
          ('inventory_asset', '1.1.3'),
          ('cogs_expense', '4.1'),
          ('bank_clearing', '1.1.4'),
          ('patient_wallet_liability', '2.2'),
          ('customer_adjustments', '4.2'),
          ('opening_balance_equity', '3.9')
        )
        UPDATE trial_balance_settings
        SET account_id = (
          SELECT a.id FROM required r JOIN accounts a ON a.code = r.code
          WHERE r.category = trial_balance_settings.category
        )
        WHERE category IN (SELECT category FROM required)
          AND COALESCE(
                (SELECT a.code FROM accounts a WHERE a.id = trial_balance_settings.account_id),
                ''
              ) <> (SELECT r.code FROM required r WHERE r.category = trial_balance_settings.category);

        WITH required(category, code) AS (VALUES
          ('cash_drawer', '1.1.1'),
          ('accounts_payable', '2.1'),
          ('accounts_receivable', '1.1.2'),
          ('sales_revenue', '3.1'),
          ('inventory_asset', '1.1.3'),
          ('cogs_expense', '4.1'),
          ('bank_clearing', '1.1.4'),
          ('patient_wallet_liability', '2.2'),
          ('customer_adjustments', '4.2'),
          ('opening_balance_equity', '3.9')
        )
        INSERT INTO trial_balance_settings (category, target_type, account_id)
        SELECT r.category, 'account', a.id
        FROM required r JOIN accounts a ON a.code = r.code
        WHERE NOT EXISTS (
          SELECT 1
          FROM trial_balance_settings s JOIN accounts mapped ON mapped.id = s.account_id
          WHERE s.category = r.category
        );
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    // Deduplicate trial_balance_settings: keep the highest-id row per category.
    // Pre-UNIQUE-constraint databases may have accumulated duplicate entries from
    // repeated startup seeds. Safe to run on every startup — no-op if no duplicates.
    sqlx::raw_sql(
        r#"
        DELETE FROM trial_balance_settings
        WHERE id NOT IN (
          SELECT MAX(id) FROM trial_balance_settings GROUP BY category
        );
        "#,
    )
    .execute(&mut **transaction)
    .await?;

    Ok(())
}

async fn prepare_connection(connection: &mut SqliteConnection) -> Result<(), String> {
    if !table_exists(connection, "_sqlx_migrations")
        .await
        .map_err(|e| e.to_string())?
    {
        // Bundled and pre-plugin databases have a complete schema but no migration
        // ledger. Repair those; let the plugin initialize a genuinely blank file.
        if !table_exists(connection, "purchase_invoices")
            .await
            .map_err(|e| e.to_string())?
        {
            return Ok(());
        }
        let mut transaction = connection.begin().await.map_err(|e| e.to_string())?;
        ensure_compatibility(&mut transaction)
            .await
            .map_err(|e| e.to_string())?;
        return transaction.commit().await.map_err(|e| e.to_string());
    }

    let applied = sqlx::query(
        "SELECT version, hex(checksum) AS checksum FROM _sqlx_migrations WHERE success = 1",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|e| e.to_string())?;
    let mut repairs = Vec::new();
    for row in applied {
        let version = row.get::<i64, _>("version");
        let checksum = row.get::<String, _>("checksum");
        let Some(repair) = CHECKSUM_REPAIRS
            .iter()
            .find(|repair| repair.version == version)
        else {
            continue;
        };
        if !checksum_requires_repair(repair, &checksum)? {
            continue;
        }
        repairs.push((repair, checksum));
    }
    let mut transaction = connection.begin().await.map_err(|e| e.to_string())?;
    ensure_compatibility(&mut transaction)
        .await
        .map_err(|e| e.to_string())?;
    for (repair, checksum) in repairs {
        sqlx::query(&format!(
            "UPDATE _sqlx_migrations SET checksum = X'{}' WHERE version = ? AND hex(checksum) = ?",
            current_checksum(repair)
        ))
        .bind(repair.version)
        .bind(checksum)
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;
    }
    transaction.commit().await.map_err(|e| e.to_string())
}

pub fn prepare_legacy_database(path: &Path) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        let mut connection = connect(path).await?;
        prepare_connection(&mut connection).await
    })
}

async fn repair_catalog_name_drift_on_connection(
    connection: &mut SqliteConnection,
    seed_path: &Path,
) -> Result<u64, String> {
    let seed_path = seed_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "''");
    sqlx::query(&format!("ATTACH DATABASE '{seed_path}' AS bundled_catalog"))
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string())?;

    let repair_result = async {
        let mut transaction = connection.begin().await.map_err(|e| e.to_string())?;
        sqlx::raw_sql(
            r#"
            CREATE TEMP TABLE catalog_identity_repairs (
              source_id INTEGER PRIMARY KEY,
              target_id INTEGER NOT NULL UNIQUE,
              trade_name TEXT NOT NULL,
              trade_name_en TEXT
            );

            INSERT OR IGNORE INTO catalog_identity_repairs (
              source_id, target_id, trade_name, trade_name_en
            )
            SELECT live.id, duplicate.id, seed.trade_name, seed.trade_name_en
            FROM main.master_drugs live
            JOIN bundled_catalog.master_drugs seed ON seed.id = live.id
            JOIN bundled_catalog.master_drugs duplicate
              ON duplicate.id != seed.id
             AND live.trade_name = duplicate.trade_name COLLATE NOCASE
            JOIN main.master_drugs live_duplicate ON live_duplicate.id = duplicate.id
            WHERE TRIM(COALESCE(seed.trade_name, '')) != ''
              AND TRIM(COALESCE(live.trade_name, '')) != ''
              AND live.trade_name != seed.trade_name COLLATE NOCASE
              AND TRIM(COALESCE(live.active_ingredient, '')) != ''
              AND TRIM(COALESCE(live.category, '')) != ''
              AND TRIM(COALESCE(live.manufacturer, '')) != ''
              AND live.active_ingredient = seed.active_ingredient COLLATE NOCASE
              AND live.category = seed.category COLLATE NOCASE
              AND live.manufacturer = seed.manufacturer COLLATE NOCASE
              AND (
                TRIM(COALESCE(live.trade_name_en, '')) = ''
                OR live.trade_name_en = duplicate.trade_name COLLATE NOCASE
                OR (
                  TRIM(COALESCE(duplicate.trade_name_en, '')) != ''
                  AND live.trade_name_en = duplicate.trade_name_en COLLATE NOCASE
                )
              )
              AND live_duplicate.active_ingredient = duplicate.active_ingredient COLLATE NOCASE
              AND live_duplicate.category = duplicate.category COLLATE NOCASE
              AND live_duplicate.manufacturer = duplicate.manufacturer COLLATE NOCASE
              AND (
                seed.active_ingredient != duplicate.active_ingredient COLLATE NOCASE
                OR seed.category != duplicate.category COLLATE NOCASE
                OR seed.manufacturer != duplicate.manufacturer COLLATE NOCASE
              );

            -- The legacy import attached the next visible catalog name to the old numeric ID.
            -- Move every business reference to that name's canonical ID before restoring names.
            UPDATE inventory
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = inventory.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE sales_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = sales_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE refill_reminders
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = refill_reminders.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE return_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = return_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE purchase_invoice_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = purchase_invoice_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE purchase_order_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = purchase_order_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE purchase_return_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = purchase_return_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE opening_balance_items
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = opening_balance_items.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE shortages
            SET drug_id = (SELECT target_id FROM catalog_identity_repairs WHERE source_id = shortages.drug_id)
            WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

            UPDATE master_drugs
            SET
              trade_name = (
                SELECT repair.trade_name
                FROM catalog_identity_repairs repair
                WHERE repair.source_id = master_drugs.id
              ),
              trade_name_en = (
                SELECT repair.trade_name_en
                FROM catalog_identity_repairs repair
                WHERE repair.source_id = master_drugs.id
              )
            WHERE id IN (SELECT source_id FROM catalog_identity_repairs);
            "#,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?;

        if has_column(&mut transaction, "drug_indications", "indication_id")
            .await
            .map_err(|e| e.to_string())?
        {
            sqlx::raw_sql(
                r#"
                CREATE TEMP TABLE repaired_drug_indications AS
                SELECT
                  COALESCE(repair.target_id, relation.drug_id) AS drug_id,
                  relation.indication_id
                FROM drug_indications relation
                LEFT JOIN catalog_identity_repairs repair ON repair.source_id = relation.drug_id;
                DELETE FROM drug_indications;
                INSERT OR IGNORE INTO drug_indications (drug_id, indication_id)
                SELECT drug_id, indication_id FROM repaired_drug_indications;
                DROP TABLE repaired_drug_indications;
                "#,
            )
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        } else {
            sqlx::query(
                r#"
                UPDATE drug_indications
                SET drug_id = (
                  SELECT target_id FROM catalog_identity_repairs
                  WHERE source_id = drug_indications.drug_id
                )
                WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs)
                "#,
            )
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        }

        if has_column(&mut transaction, "drug_alternatives", "alternative_id")
            .await
            .map_err(|e| e.to_string())?
        {
            sqlx::raw_sql(
                r#"
                CREATE TEMP TABLE repaired_drug_alternatives AS
                SELECT
                  COALESCE(drug_repair.target_id, relation.drug_id) AS drug_id,
                  COALESCE(alternative_repair.target_id, relation.alternative_id) AS alternative_id
                FROM drug_alternatives relation
                LEFT JOIN catalog_identity_repairs drug_repair
                  ON drug_repair.source_id = relation.drug_id
                LEFT JOIN catalog_identity_repairs alternative_repair
                  ON alternative_repair.source_id = relation.alternative_id;
                DELETE FROM drug_alternatives;
                INSERT OR IGNORE INTO drug_alternatives (drug_id, alternative_id)
                SELECT drug_id, alternative_id FROM repaired_drug_alternatives;
                DROP TABLE repaired_drug_alternatives;
                "#,
            )
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        } else {
            sqlx::raw_sql(
                r#"
                UPDATE drug_alternatives
                SET drug_id = (
                  SELECT target_id FROM catalog_identity_repairs
                  WHERE source_id = drug_alternatives.drug_id
                )
                WHERE drug_id IN (SELECT source_id FROM catalog_identity_repairs);

                UPDATE drug_alternatives
                SET alternative_drug_id = (
                  SELECT target_id FROM catalog_identity_repairs
                  WHERE source_id = drug_alternatives.alternative_drug_id
                )
                WHERE alternative_drug_id IN (SELECT source_id FROM catalog_identity_repairs);
                "#,
            )
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        }

        let repaired: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM catalog_identity_repairs")
            .fetch_one(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;

        // Legacy workbooks wrote 1 when the per-lot pack factor was blank. Repair only
        // untouched lots; any transactional history makes the lot value authoritative.
        let unit_repairs = sqlx::query(
            r#"
            UPDATE inventory
            SET strips_per_box = (
              SELECT md.large_to_medium FROM master_drugs md WHERE md.id = inventory.drug_id
            )
            WHERE COALESCE(strips_per_box, 1) = 1
              AND COALESCE((
                SELECT md.large_to_medium FROM master_drugs md WHERE md.id = inventory.drug_id
              ), 1) > 1
              AND NOT EXISTS (SELECT 1 FROM sales_items WHERE inventory_id = inventory.id)
              AND NOT EXISTS (SELECT 1 FROM return_items WHERE inventory_id = inventory.id)
              AND NOT EXISTS (SELECT 1 FROM purchase_invoice_items WHERE inventory_id = inventory.id)
              AND NOT EXISTS (SELECT 1 FROM purchase_return_items WHERE inventory_id = inventory.id)
              AND NOT EXISTS (SELECT 1 FROM stock_adjustments WHERE inventory_id = inventory.id)
            "#,
        )
        .execute(&mut *transaction)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected() as i64;
        sqlx::query("DROP TABLE catalog_identity_repairs")
            .execute(&mut *transaction)
            .await
            .map_err(|e| e.to_string())?;
        transaction.commit().await.map_err(|e| e.to_string())?;
        Ok::<u64, String>((repaired + unit_repairs) as u64)
    }
    .await;

    let detach_result = sqlx::query("DETACH DATABASE bundled_catalog")
        .execute(&mut *connection)
        .await
        .map_err(|e| e.to_string());

    match (repair_result, detach_result) {
        (Ok(repaired), Ok(_)) => Ok(repaired),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub fn repair_catalog_name_drift(path: &Path, seed_path: &Path) -> Result<u64, String> {
    tauri::async_runtime::block_on(async {
        let mut connection = connect(path).await?;
        repair_catalog_name_drift_on_connection(&mut connection, seed_path).await
    })
}

#[tauri::command]
pub fn ensure_schema_compatibility(app: tauri::AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pharma_local.db");
    tauri::async_runtime::block_on(async {
        let mut connection = connect(&path).await?;
        let mut transaction = connection.begin().await.map_err(|e| e.to_string())?;
        ensure_compatibility(&mut transaction)
            .await
            .map_err(|e| e.to_string())?;
        transaction.commit().await.map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_only_known_legacy_checksums() {
        let repair = &CHECKSUM_REPAIRS[0];
        assert_eq!(checksum_requires_repair(repair, repair.legacy[0]), Ok(true));
        assert_eq!(
            checksum_requires_repair(repair, current_checksum(repair)),
            Ok(false)
        );
        assert!(checksum_requires_repair(repair, "UNKNOWN").is_err());
    }

    #[tokio::test]
    async fn repairs_only_unambiguous_historical_shift_links() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE shifts (
              id TEXT PRIMARY KEY, user_id TEXT, start_time TEXT, end_time TEXT
            );
            CREATE TABLE sales_invoices (
              id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT, status TEXT, created_at TEXT
            );
            CREATE TABLE returns (
              id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT, status TEXT, created_at TEXT
            );
            INSERT INTO shifts VALUES
              ('shift-one', 'user-one', '2026-08-14 10:00:00', '2026-08-14 12:00:00'),
              ('shift-overlap', 'user-one', '2026-08-14 11:00:00', '2026-08-14 13:00:00'),
              ('shift-two', 'user-two', '2026-08-14 10:00:00', '2026-08-14 12:00:00');
            INSERT INTO sales_invoices VALUES
              ('unique-sale', 'user-one', NULL, 'completed', '2026-08-14 10:30:00'),
              ('ambiguous-sale', 'user-one', NULL, 'completed', '2026-08-14 11:30:00'),
              ('outside-sale', 'user-one', NULL, 'completed', '2026-08-14 09:30:00'),
              ('draft-sale', 'user-one', NULL, 'draft', '2026-08-14 10:30:00'),
              ('other-user-sale', 'user-two', NULL, 'delivered', '2026-08-14 10:30:00'),
              ('existing-sale', 'user-one', 'manual-shift', 'completed', '2026-08-14 10:30:00');
            INSERT INTO returns VALUES
              ('unique-return', 'user-two', NULL, 'approved', '2026-08-14 10:45:00'),
              ('pending-return', 'user-two', NULL, 'pending', '2026-08-14 10:45:00');
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        let mut transaction = connection.begin().await.unwrap();
        assert_eq!(
            repair_unambiguous_shift_links(&mut transaction)
                .await
                .unwrap(),
            3
        );
        transaction.commit().await.unwrap();

        let links: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT id, shift_id FROM sales_invoices ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            links,
            vec![
                ("ambiguous-sale".into(), None),
                ("draft-sale".into(), None),
                ("existing-sale".into(), Some("manual-shift".into())),
                ("other-user-sale".into(), Some("shift-two".into())),
                ("outside-sale".into(), None),
                ("unique-sale".into(), Some("shift-one".into())),
            ]
        );
        let return_links: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT id, shift_id FROM returns ORDER BY id")
                .fetch_all(&mut connection)
                .await
                .unwrap();
        assert_eq!(
            return_links,
            vec![
                ("pending-return".into(), None),
                ("unique-return".into(), Some("shift-two".into())),
            ]
        );

        let mut transaction = connection.begin().await.unwrap();
        assert_eq!(
            repair_unambiguous_shift_links(&mut transaction)
                .await
                .unwrap(),
            0
        );
        transaction.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn repairs_only_high_confidence_duplicate_catalog_name_drift() {
        let seed_path =
            std::env::temp_dir().join(format!("pharma-catalog-seed-{}.db", uuid::Uuid::new_v4()));
        let live_path =
            std::env::temp_dir().join(format!("pharma-catalog-live-{}.db", uuid::Uuid::new_v4()));
        let mut seed = connect(&seed_path).await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY,
              trade_name TEXT,
              trade_name_en TEXT,
              active_ingredient TEXT,
              category TEXT,
              manufacturer TEXT,
              official_price REAL,
              large_to_medium INTEGER
            );
            INSERT INTO master_drugs VALUES
              (417, 'AGIOLAX', NULL, 'ISPAGHULA', 'laxative', 'VIATRIS', 150, NULL),
              (429, 'AIG ESOMEPRAZOLE', NULL, 'ESOMEPRAZOLE', 'ppi', 'PLANET CURE', 296, NULL),
              (500, 'ORIGINAL CUSTOM', NULL, 'CUSTOM ACTIVE', 'custom', 'CUSTOM MAKER', 10, NULL),
              (501, 'ORIGINAL TWO', NULL, 'SECOND ACTIVE', 'second', 'SECOND MAKER', 20, NULL),
              (502, 'ORIGINAL THREE', NULL, 'THIRD ACTIVE', 'third', 'THIRD MAKER', 30, NULL),
              (600, 'ALPHA', NULL, 'ACTIVE A', 'category a', 'MAKER A', 40, NULL),
              (601, 'BETA', NULL, 'ACTIVE B', 'category b', 'MAKER B', 50, NULL),
              (602, 'GAMMA', NULL, 'ACTIVE C', 'category c', 'MAKER C', 60, NULL);
            CREATE INDEX idx_seed_master_drugs_trade_name ON master_drugs(trade_name COLLATE NOCASE);
            "#,
        )
        .execute(&mut seed)
        .await
        .unwrap();
        seed.close().await.unwrap();

        let mut live = connect(&live_path).await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY,
              trade_name TEXT,
              trade_name_en TEXT,
              active_ingredient TEXT,
              category TEXT,
              manufacturer TEXT,
              official_price REAL,
              large_to_medium INTEGER
            );
            CREATE TABLE inventory (
              id TEXT PRIMARY KEY,
              drug_id INTEGER,
              quantity REAL,
              strips_per_box INTEGER
            );
            CREATE TABLE sales_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE refill_reminders (id TEXT PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE return_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE purchase_order_items (id INTEGER PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE purchase_return_items (id INTEGER PRIMARY KEY, drug_id INTEGER, inventory_id TEXT);
            CREATE TABLE stock_adjustments (id INTEGER PRIMARY KEY, inventory_id TEXT);
            CREATE TABLE opening_balance_items (id INTEGER PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE shortages (id INTEGER PRIMARY KEY, drug_id INTEGER);
            CREATE TABLE drug_indications (
              drug_id INTEGER,
              indication_id INTEGER,
              PRIMARY KEY (drug_id, indication_id)
            );
            CREATE TABLE drug_alternatives (
              drug_id INTEGER,
              alternative_id INTEGER,
              PRIMARY KEY (drug_id, alternative_id)
            );
            CREATE VIRTUAL TABLE master_drugs_fts USING fts5(
              trade_name,
              trade_name_en,
              content='master_drugs',
              content_rowid='id'
            );
            CREATE TRIGGER master_drugs_au AFTER UPDATE ON master_drugs BEGIN
              INSERT INTO master_drugs_fts(master_drugs_fts, rowid, trade_name, trade_name_en)
              VALUES ('delete', OLD.id, OLD.trade_name, OLD.trade_name_en);
              INSERT INTO master_drugs_fts(rowid, trade_name, trade_name_en)
              VALUES (NEW.id, NEW.trade_name, NEW.trade_name_en);
            END;
            INSERT INTO master_drugs VALUES
              (417, 'AIG ESOMEPRAZOLE', 'AIG ESOMEPRAZOLE', 'ISPAGHULA', 'laxative', 'VIATRIS', 292, 1),
              (429, 'AIG ESOMEPRAZOLE', 'AIG ESOMEPRAZOLE', 'ESOMEPRAZOLE', 'ppi', 'PLANET CURE', 292, 2),
              (500, 'USER LABEL', 'USER LABEL EN', 'CUSTOM ACTIVE', 'custom', 'CUSTOM MAKER', 11, 3),
              (501, 'AIG ESOMEPRAZOLE', 'AIG ESOMEPRAZOLE', 'SECOND ACTIVE', 'second', 'USER MAKER', 21, 4),
              (502, 'AIG ESOMEPRAZOLE', 'Custom English Translation', 'THIRD ACTIVE', 'third', 'THIRD MAKER', 31, 5),
              (600, 'BETA', 'BETA', 'ACTIVE A', 'category a', 'MAKER A', 41, 6),
              (601, 'GAMMA', 'GAMMA', 'ACTIVE B', 'category b', 'MAKER B', 51, 7),
              (602, 'GAMMA', 'GAMMA', 'ACTIVE C', 'category c', 'MAKER C', 61, 8);
            INSERT INTO master_drugs_fts(rowid, trade_name, trade_name_en)
            SELECT id, trade_name, trade_name_en FROM master_drugs;
            INSERT INTO inventory VALUES
              ('lot-417', 417, 0.5, 2),
              ('lot-600', 600, 1, 7),
              ('lot-601', 601, 2, 8),
              ('lot-unit', 500, 1, 1);
            INSERT INTO sales_items VALUES (1, 417, 'lot-417');
            INSERT INTO refill_reminders VALUES ('refill-1', 417);
            INSERT INTO return_items VALUES (1, 417, 'lot-417');
            INSERT INTO purchase_invoice_items VALUES (1, 417, 'lot-417');
            INSERT INTO purchase_order_items VALUES (1, 417);
            INSERT INTO purchase_return_items VALUES (1, 417, 'lot-417');
            INSERT INTO opening_balance_items VALUES (1, 417);
            INSERT INTO shortages VALUES (1, 417);
            INSERT INTO drug_indications VALUES (417, 1), (429, 1);
            INSERT INTO drug_alternatives VALUES (417, 600), (429, 601);
            "#,
        )
        .execute(&mut live)
        .await
        .unwrap();

        let repaired = repair_catalog_name_drift_on_connection(&mut live, &seed_path)
            .await
            .unwrap();
        assert_eq!(repaired, 4);

        let repaired_row = sqlx::query(
            "SELECT trade_name, trade_name_en, official_price, large_to_medium FROM master_drugs WHERE id = 417",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(repaired_row.get::<String, _>("trade_name"), "AGIOLAX");
        assert_eq!(repaired_row.get::<Option<String>, _>("trade_name_en"), None);
        assert_eq!(repaired_row.get::<f64, _>("official_price"), 292.0);
        assert_eq!(repaired_row.get::<i64, _>("large_to_medium"), 1);

        for (id, expected_name) in [
            (429, "AIG ESOMEPRAZOLE"),
            (500, "USER LABEL"),
            (501, "AIG ESOMEPRAZOLE"),
            (502, "AIG ESOMEPRAZOLE"),
            (600, "ALPHA"),
            (601, "BETA"),
            (602, "GAMMA"),
        ] {
            let actual: String =
                sqlx::query_scalar("SELECT trade_name FROM master_drugs WHERE id = ?")
                    .bind(id)
                    .fetch_one(&mut live)
                    .await
                    .unwrap();
            assert_eq!(actual, expected_name);
        }
        let inventory: (i64, f64) =
            sqlx::query_as("SELECT drug_id, quantity FROM inventory WHERE id = 'lot-417'")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(inventory, (429, 0.5));

        let repaired_unit_factor: i64 =
            sqlx::query_scalar("SELECT strips_per_box FROM inventory WHERE id = 'lot-unit'")
                .fetch_one(&mut live)
                .await
                .unwrap();
        assert_eq!(repaired_unit_factor, 3);

        let chained_inventory: Vec<(String, i64)> = sqlx::query_as(
            "SELECT id, drug_id FROM inventory WHERE id IN ('lot-600', 'lot-601') ORDER BY id",
        )
        .fetch_all(&mut live)
        .await
        .unwrap();
        assert_eq!(
            chained_inventory,
            vec![("lot-600".into(), 601), ("lot-601".into(), 602)]
        );

        for table in [
            "sales_items",
            "refill_reminders",
            "return_items",
            "purchase_invoice_items",
            "purchase_order_items",
            "purchase_return_items",
            "opening_balance_items",
            "shortages",
        ] {
            let remapped: i64 = sqlx::query_scalar(&format!("SELECT drug_id FROM {table} LIMIT 1"))
                .fetch_one(&mut live)
                .await
                .unwrap();
            assert_eq!(remapped, 429, "{table} kept the drifted catalog ID");
        }

        let indication_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM drug_indications WHERE drug_id = 429 AND indication_id = 1",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(indication_rows, 1);
        let alternative_rows: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM drug_alternatives WHERE drug_id = 429 AND alternative_id = 601",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(alternative_rows, 1);

        let display_name: String = sqlx::query_scalar(
            "SELECT COALESCE(NULLIF(TRIM(trade_name_en), ''), trade_name) FROM master_drugs WHERE id = 417",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(display_name, "AGIOLAX");
        let fts_matches: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM master_drugs_fts WHERE master_drugs_fts MATCH 'AGIOLAX' AND rowid = 417",
        )
        .fetch_one(&mut live)
        .await
        .unwrap();
        assert_eq!(fts_matches, 1);

        assert_eq!(
            repair_catalog_name_drift_on_connection(&mut live, &seed_path)
                .await
                .unwrap(),
            0
        );

        live.close().await.unwrap();
        std::fs::remove_file(seed_path).unwrap();
        std::fs::remove_file(live_path).unwrap();
    }

    #[tokio::test]
    async fn upgrades_v014_schema_and_normalizes_its_checksum() {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT NOT NULL);
            CREATE TABLE suppliers (id INTEGER PRIMARY KEY);
            CREATE TABLE users (id TEXT PRIMARY KEY);
            CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
            CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT);
            CREATE TABLE return_items (id INTEGER PRIMARY KEY);
            CREATE TABLE inventory (
              id TEXT PRIMARY KEY,
              drug_id INTEGER,
              pharmacy_id TEXT,
              quantity REAL,
              expiry_date TEXT,
              batch_number TEXT
            );
            CREATE TABLE purchase_invoices (
              id TEXT PRIMARY KEY,
              pharmacy_id TEXT,
              invoice_number TEXT,
              status TEXT,
              created_at DATETIME
            );
            CREATE TABLE purchase_invoice_items (
              id INTEGER PRIMARY KEY,
              invoice_id TEXT,
              drug_id INTEGER,
              quantity REAL,
              bonus_quantity REAL,
              expiry_date TEXT
            );
            CREATE TABLE activity_log (id INTEGER PRIMARY KEY, action TEXT, created_at DATETIME);
            CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, status TEXT);
            CREATE TABLE units (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
            CREATE TABLE item_natures (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
            CREATE TABLE accounts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              code TEXT NOT NULL UNIQUE,
              name_ar TEXT NOT NULL,
              name_en TEXT,
              type TEXT NOT NULL,
              is_group INTEGER DEFAULT 0
            );
            CREATE TABLE trial_balance_settings (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              category TEXT NOT NULL UNIQUE,
              target_type TEXT NOT NULL,
              account_id INTEGER
            );
            INSERT INTO accounts (code, name_ar, name_en, type, is_group)
            VALUES ('9.9', 'Legacy account', 'Legacy account', 'asset', 0);
            INSERT INTO trial_balance_settings (category, target_type, account_id)
            SELECT 'legacy_setting', 'account', id FROM accounts WHERE code = '9.9';
            CREATE TABLE _sqlx_migrations (
              version BIGINT PRIMARY KEY,
              description TEXT NOT NULL,
              installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              success BOOLEAN NOT NULL,
              checksum BLOB NOT NULL,
              execution_time BIGINT NOT NULL
            );
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (1, 'initial_schema', 1, X'F82014A0B12E5F2148E15B27514F88C074C127EA08140C38889D59CAC54695EF9BA4194FC77168A621732F9627A20AA2', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (2, 'performance_tuning', 1, X'EB5B98F60883978153907406799C9010EE82FD3B6233E54E3EF0ABE66C182CC4B967378D5C2F431F4180AE8544F7B049', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (4, 'return_items_patch', 1, X'DC6E060272C078A60806DDBE5DBCC30F42837A45725E0A02163D72863B6F5523E2A51618D4215AEE0E3721748C90125D', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (5, 'purchase_return_details', 1, X'5EDF8FB853589FF8E8C5DE39B9A3432B940C4DB1BC1F0A43438C2B14D376DB187063BDE0F6C55E34C4C2EE261AA3F5A7', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (7, 'purchase_inventory_links', 1, X'48DF50E8B76D93E61F77DEB39E7498CFA1D34B6A7AB76DC1E773320F1B1D448C43B191746F5958858AD1C6F75C6E6013', 0);
            INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES (12, 'shortages_pharmacy_scope', 1, X'390BDCB64ED1FBE1C12E844281BB50251DED58D07B2B1AFB54F80BCE2B179E6C8E1026153452274980FC2271C2B6C1C6', 0);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        prepare_connection(&mut connection).await.unwrap();

        for repair in CHECKSUM_REPAIRS {
            let checksum: String =
                sqlx::query_scalar("SELECT hex(checksum) FROM _sqlx_migrations WHERE version = ?")
                    .bind(repair.version)
                    .fetch_one(&mut connection)
                    .await
                    .unwrap();
            assert_eq!(checksum, current_checksum(repair));
        }

        let mut transaction = connection.begin().await.unwrap();
        ensure_compatibility(&mut transaction).await.unwrap();
        transaction.commit().await.unwrap();

        for (table, column) in [
            ("master_drugs", "base_price"),
            ("master_drugs", "indications"),
            ("return_items", "sale_item_id"),
            ("purchase_invoice_items", "barcode"),
            ("purchase_returns", "purchase_invoice_id"),
            ("patients", "opening_balance"),
            ("patients", "wallet_balance"),
            ("patients", "points_balance"),
            ("financial_notices", "target_type"),
            ("financial_notices", "target_id"),
            ("cash_movements", "source_type"),
            ("cash_movements", "target_name"),
            ("shortages", "pharmacy_id"),
            ("shortages", "priority"),
            ("shortages", "notes"),
            ("shortages", "requested_quantity"),
            ("shortages", "status"),
            ("shortages", "created_at"),
        ] {
            let rows = sqlx::query(&format!("PRAGMA table_info({table})"))
                .fetch_one(&mut connection)
                .await
                .unwrap();
            assert_eq!(rows.get::<String, _>("name"), "id");
            let mut transaction = connection.begin().await.unwrap();
            assert!(has_column(&mut transaction, table, column).await.unwrap());
            transaction.commit().await.unwrap();
        }

        for (category, code) in [
            ("bank_clearing", "1.1.4"),
            ("patient_wallet_liability", "2.2"),
            ("customer_adjustments", "4.2"),
            ("opening_balance_equity", "3.9"),
        ] {
            let mapped_code: String = sqlx::query_scalar(
                "SELECT a.code FROM trial_balance_settings s JOIN accounts a ON a.id = s.account_id WHERE s.category = ?",
            )
            .bind(category)
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(mapped_code, code);
        }

        for table in [
            "refill_reminders",
            "patient_allergies",
            "patient_conditions",
            "patient_transactions",
            "financial_notices",
            "cash_movements",
        ] {
            assert!(
                table_exists(&mut connection, table).await.unwrap(),
                "{table}"
            );
        }

        sqlx::query(
            "INSERT INTO patients (id, full_name) VALUES ('legacy-patient', 'Legacy Patient')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let patient_balances = sqlx::query(
            "SELECT opening_balance, wallet_balance, points_balance FROM patients WHERE id = 'legacy-patient'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(patient_balances.get::<f64, _>("opening_balance"), 0.0);
        assert_eq!(patient_balances.get::<f64, _>("wallet_balance"), 0.0);
        assert_eq!(patient_balances.get::<f64, _>("points_balance"), 0.0);

        // A later startup with already-normalized checksums must still repair schema drift.
        sqlx::query("ALTER TABLE master_drugs DROP COLUMN side_effects")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("DELETE FROM trial_balance_settings WHERE category = 'bank_clearing'")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("DELETE FROM accounts WHERE code = '1.1.4'")
            .execute(&mut connection)
            .await
            .unwrap();
        prepare_connection(&mut connection).await.unwrap();
        let mut transaction = connection.begin().await.unwrap();
        assert!(has_column(&mut transaction, "master_drugs", "side_effects")
            .await
            .unwrap());
        transaction.commit().await.unwrap();
        let bank_mapping_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM trial_balance_settings s JOIN accounts a ON a.id = s.account_id WHERE s.category = 'bank_clearing' AND a.code = '1.1.4'",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(bank_mapping_count, 1);
    }

    async fn representative_purchase_database(v239: bool) -> SqliteConnection {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::raw_sql(
            r#"
            CREATE TABLE users (id TEXT PRIMARY KEY);
            CREATE TABLE master_drugs (
              id INTEGER PRIMARY KEY,
              trade_name TEXT NOT NULL,
              large_to_medium INTEGER,
              medium_to_small INTEGER
            );
            CREATE TABLE inventory (
              id TEXT PRIMARY KEY,
              drug_id INTEGER,
              pharmacy_id TEXT,
              quantity INTEGER DEFAULT 0,
              local_selling_price REAL,
              cost_price REAL DEFAULT 0,
              expiry_date TEXT,
              barcode TEXT,
              batch_number TEXT,
              min_stock_level INTEGER DEFAULT 10,
              supplier TEXT,
              unit_price REAL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              strips_per_box INTEGER DEFAULT 1,
              FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
            );
            CREATE TABLE suppliers (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name_ar TEXT NOT NULL,
              balance REAL DEFAULT 0
            );
            CREATE TABLE purchase_invoices (
              id TEXT PRIMARY KEY,
              supplier_id INTEGER NOT NULL,
              pharmacy_id TEXT,
              user_id TEXT,
              invoice_number TEXT,
              invoice_date TEXT,
              total_amount REAL DEFAULT 0,
              paid_amount REAL DEFAULT 0,
              payment_method TEXT DEFAULT 'credit',
              status TEXT DEFAULT 'pending',
              notes TEXT,
              check_number TEXT,
              expenses REAL DEFAULT 0,
              discount_value REAL DEFAULT 0,
              discount_percent REAL DEFAULT 0,
              tax_percent REAL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
              FOREIGN KEY (user_id) REFERENCES users (id)
            );
            CREATE TABLE supplier_transactions (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              supplier_id INTEGER NOT NULL,
              type TEXT NOT NULL,
              amount REAL NOT NULL,
              reference_id TEXT,
              notes TEXT,
              FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
            );
            CREATE TABLE accounts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              code TEXT NOT NULL UNIQUE,
              name_ar TEXT NOT NULL,
              name_en TEXT,
              type TEXT NOT NULL,
              is_group INTEGER DEFAULT 0
            );
            CREATE TABLE trial_balance_settings (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              category TEXT NOT NULL,
              target_type TEXT,
              account_id INTEGER,
              FOREIGN KEY (account_id) REFERENCES accounts (id)
            );
            CREATE TABLE daily_journals (
              id TEXT PRIMARY KEY,
              date TEXT NOT NULL,
              description TEXT,
              created_by TEXT,
              total_amount REAL NOT NULL,
              FOREIGN KEY (created_by) REFERENCES users (id)
            );
            CREATE TABLE journal_entries (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              journal_id TEXT NOT NULL,
              account_id INTEGER NOT NULL,
              type TEXT NOT NULL,
              amount REAL NOT NULL,
              FOREIGN KEY (journal_id) REFERENCES daily_journals (id),
              FOREIGN KEY (account_id) REFERENCES accounts (id)
            );
            CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT NOT NULL);
            CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, patient_id TEXT);
            CREATE TABLE return_items (id INTEGER PRIMARY KEY);
            CREATE TABLE activity_log (id INTEGER PRIMARY KEY, action TEXT, created_at DATETIME);
            CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, status TEXT);
            CREATE TABLE units (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
            CREATE TABLE item_natures (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
            CREATE TABLE _sqlx_migrations (
              version BIGINT PRIMARY KEY,
              description TEXT NOT NULL,
              installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              success BOOLEAN NOT NULL,
              checksum BLOB NOT NULL,
              execution_time BIGINT NOT NULL
            );
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();

        if v239 {
            sqlx::raw_sql(
                r#"
                CREATE TABLE purchase_invoice_items (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  invoice_id TEXT NOT NULL,
                  drug_id INTEGER NOT NULL,
                  quantity INTEGER NOT NULL,
                  unit_id INTEGER,
                  expiry_date TEXT,
                  cost_price REAL NOT NULL,
                  selling_price REAL,
                  bonus_quantity INTEGER DEFAULT 0,
                  tax_percent REAL DEFAULT 0,
                  discount_percent REAL DEFAULT 0,
                  strips_per_box INTEGER DEFAULT 1,
                  inventory_id TEXT,
                  FOREIGN KEY (invoice_id) REFERENCES purchase_invoices (id),
                  FOREIGN KEY (drug_id) REFERENCES master_drugs (id),
                  FOREIGN KEY (inventory_id) REFERENCES inventory (id) ON DELETE SET NULL
                );
                CREATE TABLE purchase_returns (
                  id TEXT PRIMARY KEY,
                  supplier_id INTEGER NOT NULL,
                  user_id TEXT NOT NULL,
                  purchase_invoice_id TEXT,
                  reason TEXT,
                  total_amount REAL,
                  refund_method TEXT DEFAULT 'credit',
                  status TEXT DEFAULT 'completed',
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
                );
                CREATE TABLE purchase_return_items (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  purchase_return_id TEXT NOT NULL,
                  inventory_id TEXT,
                  drug_id INTEGER,
                  drug_name TEXT,
                  quantity_returned INTEGER,
                  unit_price REAL,
                  total_price REAL,
                  reason TEXT,
                  purchase_invoice_item_id INTEGER,
                  unit TEXT DEFAULT 'large',
                  FOREIGN KEY (purchase_return_id) REFERENCES purchase_returns (id)
                );
                INSERT INTO accounts (id, code, name_ar, name_en, type, is_group) VALUES
                  (6, '1.1.1', 'Cash', 'Cash Drawer', 'asset', 0),
                  (7, '2.1', 'Payable', 'Accounts Payable', 'liability', 0),
                  (8, '1.1.2', 'Receivable', 'Accounts Receivable', 'asset', 0),
                  (9, '3.1', 'Sales', 'Sales Revenue', 'revenue', 0),
                  (10, '1.1.3', 'Inventory', 'Inventory Asset', 'asset', 0),
                  (11, '4.1', 'COGS', 'Cost of Goods Sold', 'expense', 0);
                INSERT INTO trial_balance_settings (category, target_type, account_id) VALUES
                  ('cash_drawer', 'account', 6),
                  ('accounts_receivable', 'account', 8),
                  ('sales_revenue', 'account', 9),
                  ('inventory_asset', 'account', 10),
                  ('cogs_expense', 'account', 11);
                INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES
                  (1, 'initial_schema', 1, X'BEC57847DA8403B63C28258329D6F9EEEB7FC894B1496393DCBB6527AAB25D7045EFE661B6BE6473B68C6A579C49A153', 0),
                  (2, 'performance_tuning', 1, X'1D375CF6D1CC6170CA5EC70CE930AD0F9F4D6E0355E5A7ED2637E683D5721A96D62D53C37E573E260B617513DF883375', 0),
                  (3, 'sync_metadata', 1, X'AC4D263917A382C814AD54B4018090D5B867C42B949BAB27F208A1675F92DDB2B7DBA20363793E32F541509388D6A5F6', 0),
                  (4, 'return_items_patch', 1, X'CF8CB76E3264BA762F3CC260B56FB253BEF65AD4C7B80D6E7DA2F950AB9AD5A88CB0DB45072EF2ECE5E3C553AD00D85F', 0),
                  (5, 'purchase_return_details', 1, X'06CDB339DAF88B9A19B495D4F48AEB5450A3AEA9EE02BB36E69C6C4ABE3F7FA6BA4C0657841FEE7F0102ABFCC2115DC7', 0),
                  (6, 'accounting_upgrade_seed', 1, X'8C1DEC5BFB088CCB52A98D085D81F34EFC948B37B2E6DE2946F067BAEA8D07F419C8E064553B850E9417EF03312E7D7A', 0),
                  (7, 'purchase_inventory_links', 1, X'ADD70A4E03CA17C0E204F600C91803410D880921B6C6A2504D39309E684CA58B2B7B2CA683BDF3E1EB7ABA6EE96C64AE', 0),
                  (8, 'patient_accounting', 1, X'09BB9D9AFA5BE22F074E9073ECEBA993227E4FE23CC90FEAB5F442B4A4FCD772456F4202856F49E6F653E4BFA8439D65', 0);
                "#,
            )
            .execute(&mut connection)
            .await
            .unwrap();
        } else {
            sqlx::raw_sql(
                r#"
                CREATE TABLE purchase_invoice_items (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  invoice_id TEXT NOT NULL,
                  drug_id INTEGER NOT NULL,
                  quantity INTEGER NOT NULL,
                  unit_id INTEGER,
                  expiry_date TEXT,
                  cost_price REAL NOT NULL,
                  selling_price REAL,
                  bonus_quantity INTEGER DEFAULT 0,
                  tax_percent REAL DEFAULT 0,
                  discount_percent REAL DEFAULT 0,
                  FOREIGN KEY (invoice_id) REFERENCES purchase_invoices (id),
                  FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
                );
                INSERT INTO accounts (id, code, name_ar, name_en, type, is_group)
                VALUES (6, '9.9', 'Legacy account', 'Legacy account', 'asset', 0);
                INSERT INTO trial_balance_settings (category, target_type, account_id)
                VALUES ('cash_drawer', 'account', 6);
                INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
                VALUES (1, 'initial_schema', 1, X'78532E45F393BD746018E6EC48E3DD3D661145347E5A0716C28424B1347B2F3BD98F4C7B70C9562950286660AFA22B6C', 0);
                "#,
            )
            .execute(&mut connection)
            .await
            .unwrap();
        }

        sqlx::raw_sql(
            r#"
            INSERT INTO users (id) VALUES ('legacy-purchase-user');
            INSERT INTO suppliers (id, name_ar, balance) VALUES (70, 'Legacy Supplier', 0);
            INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small) VALUES
              (9100, 'Exact legacy lot', 10, 1),
              (9101, 'Unique fallback lot', 10, 1),
              (9102, 'Ambiguous legacy lot', 10, 1);
            INSERT INTO inventory
              (id, drug_id, pharmacy_id, quantity, expiry_date, batch_number)
            VALUES
              ('legacy-exact', 9100, 'local_default', 6, '2028-12-31', 'LEGACY-EXACT'),
              ('legacy-fallback', 9101, NULL, 8, '2028-12-31', 'OLD-BATCH'),
              ('legacy-ambiguous-a', 9102, 'local_default', 6, '2028-12-31', 'OLD-A'),
              ('legacy-ambiguous-b', 9102, 'local_default', 6, '2028-12-31', 'OLD-B');
            INSERT INTO purchase_invoices
              (id, supplier_id, pharmacy_id, user_id, invoice_number, invoice_date,
               payment_method, status)
            VALUES
              ('legacy-exact-invoice', 70, NULL, 'legacy-purchase-user', 'LEGACY-EXACT', '2026-01-01', 'credit', 'completed'),
              ('legacy-fallback-invoice', 70, 'local_default', 'legacy-purchase-user', 'NEW-BATCH', '2026-01-01', 'credit', 'completed'),
              ('legacy-ambiguous-invoice', 70, 'local_default', 'legacy-purchase-user', 'NEW-AMBIGUOUS', '2026-01-01', 'credit', 'completed');
            INSERT INTO purchase_invoice_items
              (invoice_id, drug_id, quantity, expiry_date, cost_price, bonus_quantity)
            VALUES
              ('legacy-exact-invoice', 9100, 6, '31/12/2028', 10, 0),
              ('legacy-fallback-invoice', 9101, 6, '31/12/2028', 10, 0),
              ('legacy-ambiguous-invoice', 9102, 6, '31/12/2028', 10, 0);
            "#,
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection
    }

    #[tokio::test]
    async fn upgraded_purchase_schemas_support_inventory_links_returns_and_accounting() {
        for (label, v239) in [("v0.2.14", false), ("v0.2.39", true)] {
            let mut connection = representative_purchase_database(v239).await;
            prepare_connection(&mut connection).await.unwrap();

            let linked_lots = sqlx::query(
                "SELECT invoice_id, inventory_id FROM purchase_invoice_items WHERE invoice_id LIKE 'legacy-%' ORDER BY invoice_id",
            )
            .fetch_all(&mut connection)
            .await
            .unwrap();
            let links: std::collections::HashMap<String, Option<String>> = linked_lots
                .into_iter()
                .map(|row| {
                    (
                        row.get::<String, _>("invoice_id"),
                        row.try_get::<Option<String>, _>("inventory_id").unwrap(),
                    )
                })
                .collect();
            assert_eq!(
                links["legacy-exact-invoice"].as_deref(),
                Some("legacy-exact")
            );
            assert_eq!(
                links["legacy-fallback-invoice"].as_deref(),
                Some("legacy-fallback")
            );
            assert_eq!(links["legacy-ambiguous-invoice"], None);

            let mut transaction = connection.begin().await.unwrap();
            for column in ["strips_per_box", "inventory_id", "barcode"] {
                assert!(
                    has_column(&mut transaction, "purchase_invoice_items", column)
                        .await
                        .unwrap(),
                    "{label} is missing purchase_invoice_items.{column}"
                );
            }
            assert!(
                has_column(&mut transaction, "purchase_invoices", "updated_at")
                    .await
                    .unwrap(),
                "{label} is missing purchase_invoices.updated_at"
            );
            transaction.commit().await.unwrap();

            for (category, code) in [
                ("cash_drawer", "1.1.1"),
                ("accounts_payable", "2.1"),
                ("accounts_receivable", "1.1.2"),
                ("sales_revenue", "3.1"),
                ("inventory_asset", "1.1.3"),
                ("cogs_expense", "4.1"),
            ] {
                let mapped_code: String = sqlx::query_scalar(
                    "SELECT a.code FROM trial_balance_settings s JOIN accounts a ON a.id = s.account_id WHERE s.category = ? LIMIT 1",
                )
                .bind(category)
                .fetch_one(&mut connection)
                .await
                .unwrap();
                assert_eq!(mapped_code, code, "{label} has a bad {category} mapping");
            }

            let mut transaction = connection.begin().await.unwrap();
            sqlx::raw_sql(
                r#"
                INSERT INTO users (id) VALUES ('purchase-user');
                INSERT INTO suppliers (id, name_ar, balance) VALUES (77, 'Supplier', 0);
                INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small)
                VALUES (9001, 'Upgrade Drug', 10, 1);
                INSERT INTO inventory
                  (id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price,
                   expiry_date, barcode, batch_number, strips_per_box)
                VALUES ('upgrade-lot', 9001, 'local_default', 6, 15, 10,
                        '2028-12-31', '6220000009001', 'UPGRADE-1', 10);
                INSERT INTO purchase_invoices
                  (id, supplier_id, pharmacy_id, user_id, invoice_number, invoice_date,
                   total_amount, payment_method, status, tax_percent)
                VALUES ('upgrade-invoice', 77, 'local_default', 'purchase-user', 'UPGRADE-1',
                        '2026-08-12', 63, 'credit', 'completed', 5);
                INSERT INTO purchase_invoice_items
                  (invoice_id, drug_id, quantity, expiry_date, cost_price, selling_price,
                   tax_percent, strips_per_box, inventory_id, barcode)
                VALUES ('upgrade-invoice', 9001, 6, '2028-12-31', 10, 15,
                        5, 10, 'upgrade-lot', '6220000009001');
                INSERT INTO supplier_transactions
                  (supplier_id, type, amount, reference_id, notes)
                VALUES (77, 'invoice', 63, 'upgrade-invoice', 'Upgrade purchase');
                UPDATE suppliers SET balance = balance + 63 WHERE id = 77;
                INSERT INTO daily_journals
                  (id, date, description, created_by, total_amount)
                VALUES ('upgrade-journal', '2026-08-12', 'Purchase invoice UPGRADE-1',
                        'purchase-user', 63);
                "#,
            )
            .execute(&mut *transaction)
            .await
            .unwrap();
            let inventory_account: i64 = sqlx::query_scalar(
                "SELECT account_id FROM trial_balance_settings WHERE category = 'inventory_asset' LIMIT 1",
            )
            .fetch_one(&mut *transaction)
            .await
            .unwrap();
            let payable_account: i64 = sqlx::query_scalar(
                "SELECT account_id FROM trial_balance_settings WHERE category = 'accounts_payable' LIMIT 1",
            )
            .fetch_one(&mut *transaction)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('upgrade-journal', ?, 'debit', 63), ('upgrade-journal', ?, 'credit', 63)",
            )
            .bind(inventory_account)
            .bind(payable_account)
            .execute(&mut *transaction)
            .await
            .unwrap();
            sqlx::raw_sql(
                r#"
                INSERT INTO purchase_returns
                  (id, purchase_invoice_id, supplier_id, user_id, total_amount, refund_method, status)
                VALUES ('upgrade-return', 'upgrade-invoice', 77, 'purchase-user', 10.5, 'credit', 'completed');
                INSERT INTO purchase_return_items
                  (purchase_return_id, purchase_invoice_item_id, inventory_id, drug_id,
                   drug_name, quantity_returned, unit_price, total_price, unit)
                SELECT 'upgrade-return', id, 'upgrade-lot', 9001, 'Upgrade Drug', 1, 10.5, 10.5, 'large'
                FROM purchase_invoice_items WHERE invoice_id = 'upgrade-invoice';
                "#,
            )
            .execute(&mut *transaction)
            .await
            .unwrap();
            transaction.commit().await.unwrap();

            let linked: (String, String, String) = sqlx::query_as(
                "SELECT pii.inventory_id, pii.barcode, i.batch_number FROM purchase_invoice_items pii JOIN inventory i ON i.id = pii.inventory_id WHERE pii.invoice_id = 'upgrade-invoice'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(
                linked,
                (
                    "upgrade-lot".into(),
                    "6220000009001".into(),
                    "UPGRADE-1".into()
                )
            );
            let journal_entries: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM journal_entries WHERE journal_id = 'upgrade-journal'",
            )
            .fetch_one(&mut connection)
            .await
            .unwrap();
            assert_eq!(journal_entries, 2, "{label} purchase journal is incomplete");
            let fk_errors = sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(&mut connection)
                .await
                .unwrap();
            assert!(fk_errors.is_empty(), "{label} has foreign-key errors");
        }
    }

    #[tokio::test]
    async fn repairs_untracked_seeded_database_but_leaves_blank_database_for_migrations() {
        let mut seeded = representative_purchase_database(false).await;
        sqlx::query("DROP TABLE _sqlx_migrations")
            .execute(&mut seeded)
            .await
            .unwrap();
        prepare_connection(&mut seeded).await.unwrap();

        let mut transaction = seeded.begin().await.unwrap();
        assert!(
            has_column(&mut transaction, "purchase_invoice_items", "barcode")
                .await
                .unwrap()
        );
        assert!(
            has_column(&mut transaction, "purchase_invoices", "updated_at")
                .await
                .unwrap()
        );
        transaction.commit().await.unwrap();
        let inventory_code: String = sqlx::query_scalar(
            "SELECT a.code FROM trial_balance_settings s JOIN accounts a ON a.id = s.account_id WHERE s.category = 'inventory_asset' LIMIT 1",
        )
        .fetch_one(&mut seeded)
        .await
        .unwrap();
        assert_eq!(inventory_code, "1.1.3");

        let mut blank = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        prepare_connection(&mut blank).await.unwrap();
        assert!(!table_exists(&mut blank, "purchase_invoices").await.unwrap());
    }
}
