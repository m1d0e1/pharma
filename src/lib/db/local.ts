import { getDatabase } from './client';
import { applyIndexes } from './indexes';

// Lazy Proxy to avoid module-load circular dependency and TDZ ReferenceError
const db = new Proxy({} as any, {
  get(target, prop) {
    return Reflect.get(getDatabase(), prop);
  }
});

// Single process-wide initialization guard (works in both Next.js and Electron)
if (!(global as any).__db_initialized) {
  (global as any).__db_initialized = false;
}

// Create tables for local operation
export function initLocalDb() {
  if ((global as any).__db_initialized) {
    return db;
  }
  // Mark initialized immediately to prevent re-entrant calls
  (global as any).__db_initialized = true;

  // 1. Pharmacy Config
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT,
      role TEXT,
      full_name TEXT,
      pharmacy_id TEXT,
      job_id INTEGER,
      qualification TEXT,
      hire_date TEXT,
      shift TEXT,
      code TEXT UNIQUE,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS employee_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      min_salary REAL DEFAULT 0,
      max_salary REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      pharmacy_id TEXT,
      action_type TEXT,
      action TEXT,
      table_name TEXT,
      resource TEXT,
      record_id TEXT,
      resource_id TEXT,
      details TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration: Add permissions column if missing
  const columns = db.prepare("PRAGMA table_info(users)").all() as any[];
  if (!columns.some(c => c.name === 'permissions')) {
    db.exec('ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT \'{"can_sell": true, "can_manage_inventory": false}\'');
  }
  if (!columns.some(c => c.name === 'is_active')) {
    db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1');
  }
  
  // Migration: Add new HR columns to users
  const userHrCols = [
    { name: 'job_id', type: 'INTEGER' },
    { name: 'qualification', type: 'TEXT' },
    { name: 'hire_date', type: 'TEXT' },
    { name: 'shift', type: 'TEXT' },
    { name: 'code', type: 'TEXT' }
  ];
  for (const col of userHrCols) {
    if (!columns.some(c => c.name === col.name)) {
      try { db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.type}`); } catch (e) {}
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS master_drugs (
      id INTEGER PRIMARY KEY,
      trade_name TEXT NOT NULL,
      trade_name_en TEXT,
      generic_name TEXT,
      active_ingredient TEXT,
      barcode TEXT,
      official_price REAL DEFAULT 0,
      base_price REAL DEFAULT 0,
      category TEXT,
      manufacturer TEXT,
      is_medicine INTEGER DEFAULT 1,
      is_service INTEGER DEFAULT 0,
      is_refrigerated INTEGER DEFAULT 0,
      is_chronic INTEGER DEFAULT 0,
      has_expiry INTEGER DEFAULT 1,
      no_return INTEGER DEFAULT 0,
      origin TEXT,
      notes TEXT,
      large_unit TEXT,
      small_unit TEXT,
      medium_unit TEXT,
      large_to_medium INTEGER,
      medium_to_small INTEGER,
      min_limit INTEGER,
      max_limit INTEGER,
      reorder_point INTEGER,
      default_purchase_qty INTEGER,
      prevent_fractions INTEGER DEFAULT 0,
      tax_percent REAL DEFAULT 0,
      discount_percent REAL DEFAULT 0,
      stop_dealing INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration: Add missing columns to master_drugs if they don't exist
  const drugColumns = db.prepare("PRAGMA table_info(master_drugs)").all() as any[];
  const requiredColumns = [
    { name: 'trade_name_en', type: 'TEXT' },
    { name: 'active_ingredient', type: 'TEXT' },
    { name: 'barcode', type: 'TEXT' },
    { name: 'official_price', type: 'REAL DEFAULT 0' },
    { name: 'is_medicine', type: 'INTEGER DEFAULT 1' },
    { name: 'is_service', type: 'INTEGER DEFAULT 0' },
    { name: 'is_refrigerated', type: 'INTEGER DEFAULT 0' },
    { name: 'is_chronic', type: 'INTEGER DEFAULT 0' },
    { name: 'has_expiry', type: 'INTEGER DEFAULT 1' },
    { name: 'no_return', type: 'INTEGER DEFAULT 0' },
    { name: 'origin', type: 'TEXT' },
    { name: 'notes', type: 'TEXT' },
    { name: 'large_unit', type: 'TEXT' },
    { name: 'small_unit', type: 'TEXT' },
    { name: 'medium_unit', type: 'TEXT' },
    { name: 'large_to_medium', type: 'INTEGER' },
    { name: 'medium_to_small', type: 'INTEGER' },
    { name: 'min_limit', type: 'INTEGER' },
    { name: 'max_limit', type: 'INTEGER' },
    { name: 'reorder_point', type: 'INTEGER' },
    { name: 'default_purchase_qty', type: 'INTEGER' },
    { name: 'prevent_fractions', type: 'INTEGER DEFAULT 0' },
    { name: 'tax_percent', type: 'REAL DEFAULT 0' },
    { name: 'discount_percent', type: 'REAL DEFAULT 0' },
    { name: 'stop_dealing', type: 'INTEGER DEFAULT 0' },
    { name: 'code_2', type: 'TEXT' },
    { name: 'item_nature', type: 'TEXT' },
    { name: 'scientific_group', type: 'TEXT' },
    { name: 'usage_method', type: 'TEXT' },
    { name: 'active_ingredient_ratio', type: 'TEXT' },
    { name: 'is_table', type: 'INTEGER DEFAULT 0' }
  ];

  for (const col of requiredColumns) {
    if (!drugColumns.some(c => c.name === col.name)) {
      try {
        db.exec(`ALTER TABLE master_drugs ADD COLUMN ${col.name} ${col.type}`);
      } catch (e) {
        console.error(`Failed to add column ${col.name}:`, e);
      }
    }
  }

  // FTS5 Implementation for fast searching
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS master_drugs_fts USING fts5(
        id UNINDEXED,
        trade_name,
        trade_name_en,
        generic_name,
        active_ingredient,
        content='master_drugs',
        content_rowid='id'
      );

      -- Triggers to keep FTS index in sync
      CREATE TRIGGER IF NOT EXISTS master_drugs_ai AFTER INSERT ON master_drugs BEGIN
        INSERT INTO master_drugs_fts(rowid, trade_name, trade_name_en, generic_name, active_ingredient)
        VALUES (new.id, new.trade_name, new.trade_name_en, new.generic_name, new.active_ingredient);
      END;

      CREATE TRIGGER IF NOT EXISTS master_drugs_ad AFTER DELETE ON master_drugs BEGIN
        INSERT INTO master_drugs_fts(master_drugs_fts, rowid, trade_name, trade_name_en, generic_name, active_ingredient)
        VALUES('delete', old.id, old.trade_name, old.trade_name_en, old.generic_name, old.active_ingredient);
      END;

      CREATE TRIGGER IF NOT EXISTS master_drugs_au AFTER UPDATE ON master_drugs BEGIN
        INSERT INTO master_drugs_fts(master_drugs_fts, rowid, trade_name, trade_name_en, generic_name, active_ingredient)
        VALUES('delete', old.id, old.trade_name, old.trade_name_en, old.generic_name, old.active_ingredient);
        INSERT INTO master_drugs_fts(rowid, trade_name, trade_name_en, generic_name, active_ingredient)
        VALUES (new.id, new.trade_name, new.trade_name_en, new.generic_name, new.active_ingredient);
      END;
    `);

    // Initial sync if FTS table is empty
    const ftsCount = db.prepare("SELECT count(*) as count FROM master_drugs_fts").get() as any;
    if (ftsCount.count === 0) {
      db.exec(`
      INSERT INTO master_drugs_fts(rowid, trade_name, trade_name_en, generic_name, active_ingredient)
      SELECT id, trade_name, trade_name_en, generic_name, active_ingredient FROM master_drugs;
      `);
    }
  } catch (e) {
    console.error("FTS5 Setup Error (might not be supported):", e);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      name_en TEXT,
      phone TEXT,
      mobile TEXT,
      address TEXT,
      area TEXT,
      birth_date TEXT,
      gender TEXT,
      insurance_number TEXT,
      car_number TEXT,
      credit_limit REAL DEFAULT 0,
      opening_balance REAL DEFAULT 0,
      points_balance REAL DEFAULT 0,
      point_value REAL DEFAULT 1,
      customer_type TEXT DEFAULT 'individual',
      payment_method TEXT DEFAULT 'cash',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration: Add missing columns to patients
  let colInfo = db.prepare("PRAGMA table_info(patients)").all() as any[];
  const requiredPatientCols = [
    { name: 'mobile', type: 'TEXT' },
    { name: 'area', type: 'TEXT' },
    { name: 'car_number', type: 'TEXT' },
    { name: 'opening_balance', type: 'REAL DEFAULT 0' },
    { name: 'point_value', type: 'REAL DEFAULT 1' },
    { name: 'payment_method', type: 'TEXT DEFAULT \'cash\'' },
    { name: 'wallet_balance', type: 'REAL DEFAULT 0' },
    { name: 'loyalty_level', type: 'TEXT DEFAULT \'bronze\'' }
  ];

  for (const col of requiredPatientCols) {
    if (!colInfo.some(c => c.name === col.name)) {
      try {
        db.exec(`ALTER TABLE patients ADD COLUMN ${col.name} ${col.type}`);
      } catch (e) {
        console.error(`Failed to add column ${col.name} to patients:`, e);
      }
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      drug_id INTEGER,
      pharmacy_id TEXT,
      quantity INTEGER DEFAULT 0,
      local_selling_price REAL,
      cost_price REAL DEFAULT 0,
      expiry_date TEXT,
      barcode TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration: Add cost_price to inventory if missing
  colInfo = db.prepare("PRAGMA table_info(inventory)").all() as any[];
  if (!colInfo.some(c => c.name === 'cost_price')) {
    db.exec('ALTER TABLE inventory ADD COLUMN cost_price REAL DEFAULT 0');
  }
  // Migration: Add batch_number to inventory for lot tracking
  if (!colInfo.some(c => c.name === 'batch_number')) {
    try { db.exec('ALTER TABLE inventory ADD COLUMN batch_number TEXT'); } catch (e: any) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }
  // Migration: Add min_stock_level to inventory if missing
  if (!colInfo.some(c => c.name === 'min_stock_level')) {
    try { db.exec('ALTER TABLE inventory ADD COLUMN min_stock_level INTEGER DEFAULT 10'); } catch (e: any) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }
  // Migration: Add supplier to inventory if missing
  if (!colInfo.some(c => c.name === 'supplier')) {
    try { db.exec('ALTER TABLE inventory ADD COLUMN supplier TEXT'); } catch (e: any) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }
  // Migration: Add unit_price to inventory if missing
  if (!colInfo.some(c => c.name === 'unit_price')) {
    try { db.exec('ALTER TABLE inventory ADD COLUMN unit_price REAL DEFAULT 0'); } catch (e: any) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }
  // Migration: Add strips_per_box to inventory if missing
  if (!colInfo.some(c => c.name === 'strips_per_box')) {
    try { db.exec('ALTER TABLE inventory ADD COLUMN strips_per_box INTEGER DEFAULT 1'); } catch (e: any) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }

  // Migration: Add strips_per_box to purchase_invoice_items if missing
  const piiColInfo = db.prepare("PRAGMA table_info(purchase_invoice_items)").all() as any[];
  if (!piiColInfo.some(c => c.name === 'strips_per_box')) {
    try { db.exec('ALTER TABLE purchase_invoice_items ADD COLUMN strips_per_box INTEGER DEFAULT 1'); } catch (e: any) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }


  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_invoices (
      id TEXT PRIMARY KEY,
      pharmacy_id TEXT,
      user_id TEXT,
      patient_id TEXT,
      total_amount REAL,
      payment_method TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT,
      inventory_id TEXT,
      drug_id INTEGER,
      quantity_sold REAL,
      unit_price REAL,
      unit TEXT,
      is_negative INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      end_time DATETIME,
      starting_cash REAL DEFAULT 0,
      ending_cash REAL,
      status TEXT DEFAULT 'open',
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS refill_reminders (
      id TEXT PRIMARY KEY,
      patient_id TEXT,
      drug_id INTEGER,
      last_sold_date TEXT,
      next_refill_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Drug Interaction Safety System
    CREATE TABLE IF NOT EXISTS drug_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingredient_a TEXT NOT NULL COLLATE NOCASE,
      ingredient_b TEXT NOT NULL COLLATE NOCASE,
      severity TEXT NOT NULL DEFAULT 'minor',
      description_ar TEXT,
      description_en TEXT,
      recommendation TEXT,
      source TEXT DEFAULT 'WHO'
    );

    -- Patient Clinical Profile
    CREATE TABLE IF NOT EXISTS patient_allergies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id TEXT NOT NULL,
      allergen TEXT NOT NULL,
      severity TEXT DEFAULT 'moderate',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS patient_conditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id TEXT NOT NULL,
      condition_name TEXT NOT NULL,
      diagnosed_date TEXT,
      medications TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Returns & Refunds
    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      invoice_id TEXT,
      user_id TEXT NOT NULL,
      shift_id TEXT,
      reason TEXT,
      total_refund REAL,
      refund_method TEXT DEFAULT 'cash',
      status TEXT DEFAULT 'pending',
      approved_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id TEXT NOT NULL,
      inventory_id TEXT,
      drug_name TEXT,
      quantity_returned INTEGER,
      unit_price REAL
    );

    -- Shortages & Reordering
    CREATE TABLE IF NOT EXISTS shortages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drug_id INTEGER NOT NULL,
      requested_quantity INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Expense Tracking
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Purchase Orders
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      supplier_name TEXT,
      status TEXT DEFAULT 'pending', -- pending, completed, cancelled
      total_amount REAL DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id TEXT NOT NULL,
      drug_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      expected_price REAL,
      received_quantity INTEGER DEFAULT 0
    );

    -- Bilingual Administrative Tables
    CREATE TABLE IF NOT EXISTS units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT
    );

    CREATE TABLE IF NOT EXISTS scientific_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT
    );

    CREATE TABLE IF NOT EXISTS indications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT
    );

    CREATE TABLE IF NOT EXISTS item_natures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT
    );

    CREATE TABLE IF NOT EXISTS adjustment_reasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT
    );

    CREATE TABLE IF NOT EXISTS product_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      FOREIGN KEY (parent_id) REFERENCES product_categories (id)
    );

    CREATE TABLE IF NOT EXISTS manufacturers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT
    );

    CREATE TABLE IF NOT EXISTS opening_balances (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      notes TEXT,
      status TEXT DEFAULT 'draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS opening_balance_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ob_id TEXT NOT NULL,
      drug_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_id INTEGER,
      expiry_date TEXT,
      selling_price REAL,
      cost_price REAL,
      discount_pct REAL DEFAULT 0,
      FOREIGN KEY (ob_id) REFERENCES opening_balances (id),
      FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
    );

    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id TEXT NOT NULL,
      reason_id INTEGER,
      old_quantity INTEGER,
      new_quantity INTEGER,
      user_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (inventory_id) REFERENCES inventory (id),
      FOREIGN KEY (reason_id) REFERENCES adjustment_reasons (id)
    );

    -- Relationship Tables
    CREATE TABLE IF NOT EXISTS drug_indications (
      drug_id INTEGER,
      indication_id INTEGER,
      PRIMARY KEY (drug_id, indication_id),
      FOREIGN KEY (drug_id) REFERENCES master_drugs (id),
      FOREIGN KEY (indication_id) REFERENCES indications (id)
    );

    CREATE TABLE IF NOT EXISTS drug_alternatives (
      drug_id INTEGER,
      alternative_id INTEGER,
      PRIMARY KEY (drug_id, alternative_id),
      FOREIGN KEY (drug_id) REFERENCES master_drugs (id),
      FOREIGN KEY (alternative_id) REFERENCES master_drugs (id)
    );

    -- Purchases System
    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      phone TEXT,
      address TEXT,
      balance REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id TEXT PRIMARY KEY,
      supplier_id INTEGER NOT NULL,
      pharmacy_id TEXT,
      user_id TEXT,
      invoice_number TEXT,
      invoice_date TEXT,
      total_amount REAL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'credit', -- cash, credit
      status TEXT DEFAULT 'pending', -- pending, completed
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
    );

    CREATE TABLE IF NOT EXISTS purchase_invoice_items (
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

    CREATE TABLE IF NOT EXISTS purchase_returns (
      id TEXT PRIMARY KEY,
      purchase_invoice_id TEXT,
      supplier_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      reason TEXT,
      total_amount REAL,
      refund_method TEXT DEFAULT 'credit',
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS supplier_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      type TEXT NOT NULL, -- invoice, payment, return, adjustment
      amount REAL NOT NULL,
      reference_id TEXT, 
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
    );

    -- Patient Financial Transactions
    CREATE TABLE IF NOT EXISTS patient_transactions (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL, -- payment, refund, adjustment, credit_payment
      amount REAL NOT NULL,
      payment_method TEXT DEFAULT 'cash',
      notes TEXT,
      date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (patient_id) REFERENCES patients (id)
    );

    -- Financial Notices / Adjustments (Image 4)
    CREATE TABLE IF NOT EXISTS financial_notices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      target_type TEXT NOT NULL, -- customer, supplier, pharmacy
      target_id TEXT,
      type TEXT NOT NULL, -- credit (خصم), debit (إضافة)
      amount REAL NOT NULL,
      reason TEXT,
      notes TEXT,
      date TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Cash Movements (Image 2, 3, 5)
    CREATE TABLE IF NOT EXISTS cash_movements (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      shift_id TEXT,
      type TEXT NOT NULL, -- disbursement (صرف), receipt (توريد)
      category TEXT NOT NULL,
      sub_category TEXT,
      amount REAL NOT NULL,
      source_type TEXT,
      target_name TEXT,
      notes TEXT,
      date TEXT NOT NULL,
      actual_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Points of Sale (Image 3)
    CREATE TABLE IF NOT EXISTS points_of_sale (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      location TEXT,
      computer_name TEXT,
      current_balance REAL DEFAULT 0,
      initial_credit REAL DEFAULT 0,
      initial_debit REAL DEFAULT 0,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Expense Definitions (Image 4, 5)
    CREATE TABLE IF NOT EXISTS expense_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Banking System
    CREATE TABLE IF NOT EXISTS banks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      account_number TEXT,
      branch TEXT,
      current_balance REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Commercial Papers (Checks/Promissory Notes)
    CREATE TABLE IF NOT EXISTS commercial_papers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL, -- check, promissory_note
      direction TEXT NOT NULL, -- in (وارد), out (صادر)
      paper_number TEXT,
      bank_id INTEGER,
      amount REAL NOT NULL,
      due_date TEXT,
      status TEXT DEFAULT 'pending', -- pending, cashed, bounced, cancelled
      target_name TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bank_id) REFERENCES banks (id)
    );

    -- Credit Cards & Terminals
    CREATE TABLE IF NOT EXISTS credit_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      bank_id INTEGER,
      commission_pct REAL DEFAULT 0,
      current_balance REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bank_id) REFERENCES banks (id)
    );

    -- Accounts & Chart of Accounts (Image 4)
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER,
      code TEXT UNIQUE NOT NULL,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      type TEXT NOT NULL, -- asset, liability, equity, income, expense
      is_group INTEGER DEFAULT 0, -- 1 if it can have children, 0 if it's a leaf/entry account
      balance REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES accounts (id)
    );

    -- Daily Journals (Image 4)
    CREATE TABLE IF NOT EXISTS daily_journals (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      description TEXT,
      created_by TEXT,
      total_amount REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_id TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      type TEXT NOT NULL, -- debit, credit
      amount REAL NOT NULL,
      notes TEXT,
      FOREIGN KEY (journal_id) REFERENCES daily_journals (id),
      FOREIGN KEY (account_id) REFERENCES accounts (id)
    );

    CREATE TABLE IF NOT EXISTS trial_balance_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL, -- e.g., 'bank', 'cash', 'expense', 'delivery'
      target_type TEXT, -- sub-category
      target_id TEXT, 
      target_name TEXT,
      account_id INTEGER,
      FOREIGN KEY (account_id) REFERENCES accounts (id)
    );

    CREATE TABLE IF NOT EXISTS daily_financial_snapshots (
      date TEXT PRIMARY KEY,
      total_sales REAL DEFAULT 0,
      total_returns REAL DEFAULT 0,
      total_cash_movements REAL DEFAULT 0,
      net_profit REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Performance Indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sales_items_invoice ON sales_items(invoice_id);
    CREATE INDEX IF NOT EXISTS idx_sales_items_drug ON sales_items(drug_id);
    CREATE INDEX IF NOT EXISTS idx_inventory_drug ON inventory(drug_id);
    CREATE INDEX IF NOT EXISTS idx_sales_invoices_patient ON sales_invoices(patient_id);
    CREATE INDEX IF NOT EXISTS idx_sales_invoices_date ON sales_invoices(created_at);
    CREATE INDEX IF NOT EXISTS idx_patient_tx_date ON patient_transactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_patient_tx_patient ON patient_transactions(patient_id);
  `);

  // Migration: Add new columns to purchase_invoices
  const purchaseColumns = db.prepare("PRAGMA table_info(purchase_invoices)").all() as any[];
  const requiredPurchaseCols = [
    { name: 'check_number', type: 'TEXT' },
    { name: 'expenses', type: 'REAL DEFAULT 0' },
    { name: 'discount_value', type: 'REAL DEFAULT 0' },
    { name: 'discount_percent', type: 'REAL DEFAULT 0' },
    { name: 'tax_percent', type: 'REAL DEFAULT 0' },
    { name: 'status', type: "TEXT DEFAULT 'pending'" }
  ];

  for (const col of requiredPurchaseCols) {
    if (!purchaseColumns.some(c => c.name === col.name)) {
      try {
        db.exec(`ALTER TABLE purchase_invoices ADD COLUMN ${col.name} ${col.type}`);
      } catch (e) {
        console.error(`Failed to add column ${col.name} to purchase_invoices:`, e);
      }
    }
  }
  
  const addColumnSafely = (table: string, col: string, type: string) => {
    if (!/^[a-z_]+$/.test(col)) throw new Error(`Invalid column name: ${col}`);
    if (!/^[a-z_ ()\d']+$/i.test(type)) throw new Error(`Invalid column type: ${type}`);
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    } catch (e: any) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  };

  // Migration: Add shift_id to sales_invoices if missing
  const salesColumns = db.prepare("PRAGMA table_info(sales_invoices)").all() as any[];
  if (!salesColumns.some(c => c.name === 'shift_id')) {
    addColumnSafely('sales_invoices', 'shift_id', 'TEXT');
  }

  // Migration: Add discount columns to sales_invoices if missing
  if (!salesColumns.some(c => c.name === 'discount_amount')) {
    addColumnSafely('sales_invoices', 'discount_amount', 'REAL DEFAULT 0');
  }

  // Migration: Add status and check_number to sales_invoices
  if (!salesColumns.some(c => c.name === 'status')) {
    addColumnSafely('sales_invoices', 'status', "TEXT DEFAULT 'completed'");
  }
  if (!salesColumns.some(c => c.name === 'check_number')) {
    addColumnSafely('sales_invoices', 'check_number', "TEXT");
  }
  if (!salesColumns.some(c => c.name === 'paid_amount')) {
    addColumnSafely('sales_invoices', 'paid_amount', "REAL DEFAULT 0");
  }
  if (!salesColumns.some(c => c.name === 'remaining_amount')) {
    addColumnSafely('sales_invoices', 'remaining_amount', "REAL DEFAULT 0");
  }

  // Migration: Add shift_id and refund_method to returns
  const returnColumns = db.prepare("PRAGMA table_info(returns)").all() as any[];
  if (!returnColumns.some(c => c.name === 'shift_id')) {
    addColumnSafely('returns', 'shift_id', 'TEXT');
  }
  if (!returnColumns.some(c => c.name === 'refund_method')) {
    addColumnSafely('returns', 'refund_method', "TEXT DEFAULT 'cash'");
  }

  // Migration: Add created_by to daily_journals if missing
  const journalColumns = db.prepare("PRAGMA table_info(daily_journals)").all() as any[];
  if (!journalColumns.some(c => c.name === 'created_by')) {
    addColumnSafely('daily_journals', 'created_by', 'TEXT');
  }


  // Migration: Add unit and is_negative columns to sales_items
  const itemColumns = db.prepare("PRAGMA table_info(sales_items)").all() as any[];
  
  if (!itemColumns.some(c => c.name === 'unit')) {
    addColumnSafely('sales_items', 'unit', "TEXT DEFAULT 'large'");
  }
  if (!itemColumns.some(c => c.name === 'is_negative')) {
    addColumnSafely('sales_items', 'is_negative', "INTEGER DEFAULT 0");
  }
  if (!itemColumns.some(c => c.name === 'cost_price')) {
    addColumnSafely('sales_items', 'cost_price', "REAL DEFAULT 0");
  }
  if (!itemColumns.some(c => c.name === 'drug_id')) {
    addColumnSafely('sales_items', 'drug_id', "INTEGER");
    db.exec(`
      UPDATE sales_items 
      SET drug_id = (SELECT drug_id FROM inventory WHERE inventory.id = sales_items.inventory_id)
      WHERE drug_id IS NULL AND inventory_id IS NOT NULL
    `);
  }

  // Seed drug interactions if table is empty or has very few records (missing CSV data)
  const interactionCount = db.prepare('SELECT COUNT(*) as count FROM drug_interactions').get() as any;
  if (interactionCount.count < 1000) {
    seedDrugInteractions(db);
    
    // Also try to import from CSV if available for a much larger dataset
    import('@/scripts/importInteractions').then(mod => {
      mod.importInteractionsFromCSV(db);
    }).catch(err => {
      console.warn('Deferred CSV import failed (likely missing file or environment):', err);
    });
  }

  // Seed default admin user (username: admin, password: admin) if not exists
  const adminExists = db.prepare("SELECT COUNT(*) as count FROM users WHERE username = 'admin'").get() as any;
  if (adminExists.count === 0) {
    try {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, full_name, permissions)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        'admin',
        'admin',
        '$2b$12$.FYM9XhLwanE5PdySaxB2uMwZwwLpF9fI6HXf/2XArluRQt0kfvVm',
        'owner',
        'System Administrator',
        '["view_dashboard","view_reports","manage_inventory","manage_staff","process_sales","manage_patients","view_all_sales","manage_settings","void_transactions","manage_shifts","manage_pharmacy","export_data","import_data","view_audit_logs"]'
      );
    } catch (e) {
      console.warn('Failed to seed default admin user:', e);
    }
  }

  // Seed default TEST_USER if not exists
  const testUserExists = db.prepare("SELECT COUNT(*) as count FROM users WHERE id = 'TEST_USER'").get() as any;
  if (testUserExists.count === 0) {
    try {
      db.prepare(`
        INSERT INTO users (id, username, password_hash, role, full_name, is_active, permissions)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(
        'TEST_USER',
        'test_user',
        '$2b$12$LJ3m4ys3Lk0TSwHnbfOMiOXPm1Qlq5Gz0mN0MxH3K9X5G8q2rK1uO',
        'pharmacist',
        'مستخدم تجريبي',
        '{"can_sell": true, "can_manage_inventory": false}'
      );
    } catch (e) {
      console.warn('Failed to seed default test user:', e);
    }
  }

  // Apply performance indexes
  try {
    applyIndexes();
  } catch (e) {
    console.warn('Failed to apply database indexes:', e);
  }

  // One-time sync: populate categories, scientific groups & manufacturers from master_drugs
  try {
    db.exec(`
      INSERT INTO product_categories (name_ar)
      SELECT DISTINCT 
        UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2))
      FROM master_drugs 
      WHERE category IS NOT NULL 
        AND TRIM(category) != '' 
        AND LENGTH(TRIM(category)) > 2
        AND UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2)) NOT IN (SELECT name_ar FROM product_categories);
      
      INSERT INTO scientific_groups (name_ar)
      SELECT DISTINCT 
        UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2))
      FROM master_drugs 
      WHERE category IS NOT NULL 
        AND TRIM(category) != '' 
        AND LENGTH(TRIM(category)) > 2
        AND UPPER(SUBSTR(TRIM(category), 1, 1)) || LOWER(SUBSTR(TRIM(category), 2)) NOT IN (SELECT name_ar FROM scientific_groups);
      
      INSERT INTO manufacturers (name_ar)
      SELECT DISTINCT 
        UPPER(SUBSTR(TRIM(manufacturer), 1, 1)) || LOWER(SUBSTR(TRIM(manufacturer), 2))
      FROM master_drugs 
      WHERE manufacturer IS NOT NULL 
        AND TRIM(manufacturer) != '' 
        AND LENGTH(TRIM(manufacturer)) > 2
        AND UPPER(SUBSTR(TRIM(manufacturer), 1, 1)) || LOWER(SUBSTR(TRIM(manufacturer), 2)) NOT IN (SELECT name_ar FROM manufacturers);
    `);
  } catch (e) {
    console.warn('Failed to sync from master_drugs:', e);
  }

  // Seed units if empty
  const unitsCount = db.prepare('SELECT COUNT(*) as count FROM units').get() as { count: number };
  if (unitsCount.count === 0) {
    const units = [
      { ar: 'علبة', en: 'Box' },
      { ar: 'شريط', en: 'Strip' },
      { ar: 'قرص', en: 'Pill' },
      { ar: 'كبسولة', en: 'Capsule' },
      { ar: 'أمبول', en: 'Ampoule' },
      { ar: 'فيال', en: 'Vial' },
      { ar: 'زجاجة', en: 'Bottle' },
      { ar: 'أنبوبة', en: 'Tube' },
      { ar: 'كيس', en: 'Sachet' },
      { ar: 'قطرة', en: 'Drops' },
      { ar: 'حقنة', en: 'Syringe' }
    ];
    const insertUnit = db.prepare('INSERT INTO units (name_ar, name_en) VALUES (?, ?)');
    const seedUnits = db.transaction((list: typeof units) => {
      for (const u of list) insertUnit.run(u.ar, u.en);
    });
    seedUnits(units);
  }

  // Fix malformed dates (DD/MM/YYYY to YYYY-MM-DD)
  try {
    const malformedDates = db.prepare("SELECT id, expiry_date FROM inventory WHERE expiry_date LIKE '%/%'").all();
    if (malformedDates.length > 0) {
      const updateStmt = db.prepare("UPDATE inventory SET expiry_date = ? WHERE id = ?");
      const fixTransaction = db.transaction((rows: any[]) => {
        for (const r of rows) {
          if (r.expiry_date) {
            const p = r.expiry_date.split('/');
            if (p.length === 3) {
              const nd = `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
              updateStmt.run(nd, r.id);
            }
          }
        }
      });
      fixTransaction(malformedDates);
    }

    const malformedInvoiceDates = db.prepare("SELECT rowid, expiry_date FROM purchase_invoice_items WHERE expiry_date LIKE '%/%'").all();
    if (malformedInvoiceDates.length > 0) {
      const updateStmt = db.prepare("UPDATE purchase_invoice_items SET expiry_date = ? WHERE rowid = ?");
      const fixTransaction = db.transaction((rows: any[]) => {
        for (const r of rows) {
          if (r.expiry_date) {
            const p = r.expiry_date.split('/');
            if (p.length === 3) {
              const nd = `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
              updateStmt.run(nd, r.rowid);
            }
          }
        }
      });
      fixTransaction(malformedInvoiceDates);
    }
  } catch (e) {
    console.error("Failed to fix dates:", e);
  }

  return db;
}

function seedDrugInteractions(database: any) {
  const interactions = [
    // Critical interactions
    { a: 'warfarin', b: 'aspirin', severity: 'critical', ar: 'خطر نزيف حاد - لا يجمع بين الوارفارين والأسبرين', en: 'High bleeding risk', rec: 'استخدام بديل أو مراقبة INR' },
    { a: 'warfarin', b: 'ibuprofen', severity: 'critical', ar: 'خطر نزيف معوي حاد', en: 'GI bleeding risk', rec: 'تجنب الجمع واستخدام باراسيتامول' },
    { a: 'methotrexate', b: 'trimethoprim', severity: 'critical', ar: 'سمية نخاع العظم', en: 'Bone marrow toxicity', rec: 'تجنب الجمع بينهما' },
    { a: 'simvastatin', b: 'erythromycin', severity: 'critical', ar: 'خطر تحلل العضلات', en: 'Rhabdomyolysis risk', rec: 'استخدام مضاد حيوي بديل' },
    { a: 'metformin', b: 'contrast dye', severity: 'critical', ar: 'حماض لبني خطير', en: 'Lactic acidosis', rec: 'إيقاف الميتفورمين 48 ساعة قبل وبعد الصبغة' },
    { a: 'sildenafil', b: 'nitroglycerin', severity: 'critical', ar: 'انخفاض ضغط دم حاد مهدد للحياة', en: 'Severe hypotension', rec: 'ممنوع الجمع نهائياً' },
    { a: 'clopidogrel', b: 'omeprazole', severity: 'critical', ar: 'تقليل فعالية كلوبيدوجريل', en: 'Reduced clopidogrel efficacy', rec: 'استبدال بالبانتوبرازول' },
    // Major interactions
    { a: 'ciprofloxacin', b: 'antacids', severity: 'major', ar: 'تقليل امتصاص السيبروفلوكساسين بشكل كبير', en: 'Reduced absorption', rec: 'فصل 2 ساعة على الأقل' },
    { a: 'amlodipine', b: 'simvastatin', severity: 'major', ar: 'زيادة خطر آلام العضلات', en: 'Myopathy risk increased', rec: 'لا يتجاوز 20 مجم سيمفاستاتين' },
    { a: 'lisinopril', b: 'spironolactone', severity: 'major', ar: 'ارتفاع خطير في البوتاسيوم', en: 'Hyperkalemia risk', rec: 'مراقبة مستوى البوتاسيوم بانتظام' },
    { a: 'atenolol', b: 'verapamil', severity: 'major', ar: 'بطء شديد في ضربات القلب', en: 'Severe bradycardia', rec: 'تجنب الجمع' },
    { a: 'fluoxetine', b: 'tramadol', severity: 'major', ar: 'خطر متلازمة السيروتونين', en: 'Serotonin syndrome', rec: 'تجنب أو مراقبة دقيقة' },
    { a: 'amoxicillin', b: 'methotrexate', severity: 'major', ar: 'زيادة سمية الميثوتريكسات', en: 'MTX toxicity increased', rec: 'مراقبة وظائف الكلى والدم' },
    { a: 'diclofenac', b: 'lithium', severity: 'major', ar: 'ارتفاع مستوى الليثيوم في الدم', en: 'Lithium toxicity', rec: 'مراقبة مستوى الليثيوم' },
    { a: 'metformin', b: 'glimepiride', severity: 'moderate', ar: 'خطر هبوط سكر الدم', en: 'Hypoglycemia risk', rec: 'مراقبة السكر بانتظام' },
    { a: 'atorvastatin', b: 'clarithromycin', severity: 'major', ar: 'زيادة مستوى الستاتين وخطر تحلل العضلات', en: 'Increased statin levels', rec: 'تعليق الستاتين أثناء المضاد الحيوي' },
    // Moderate interactions
    { a: 'paracetamol', b: 'warfarin', severity: 'moderate', ar: 'زيادة طفيفة في تأثير الوارفارين', en: 'Slightly increased INR', rec: 'مراقبة INR عند الاستخدام المنتظم' },
    { a: 'metformin', b: 'alcohol', severity: 'moderate', ar: 'زيادة خطر الحماض اللبني', en: 'Lactic acidosis risk', rec: 'تجنب الكحول' },
    { a: 'captopril', b: 'potassium supplements', severity: 'moderate', ar: 'ارتفاع البوتاسيوم', en: 'Hyperkalemia', rec: 'مراقبة البوتاسيوم' },
    { a: 'amoxicillin', b: 'oral contraceptives', severity: 'moderate', ar: 'قد يقلل فعالية حبوب منع الحمل', en: 'Reduced OCP efficacy', rec: 'استخدام وسيلة إضافية' },
    { a: 'ibuprofen', b: 'aspirin', severity: 'moderate', ar: 'تقليل التأثير الواقي للقلب للأسبرين', en: 'Reduced cardioprotection', rec: 'تناول الأسبرين قبل الأيبوبروفين بساعة' },
    { a: 'omeprazole', b: 'iron supplements', severity: 'moderate', ar: 'تقليل امتصاص الحديد', en: 'Reduced iron absorption', rec: 'فصل الجرعات أو استخدام فيتامين C' },
    { a: 'ciprofloxacin', b: 'theophylline', severity: 'major', ar: 'زيادة سمية الثيوفيللين', en: 'Theophylline toxicity', rec: 'تقليل جرعة الثيوفيللين أو اختيار مضاد حيوي آخر' },
    { a: 'prednisolone', b: 'ibuprofen', severity: 'moderate', ar: 'زيادة خطر قرحة المعدة', en: 'GI ulcer risk', rec: 'إضافة واقي معدة' },
    { a: 'insulin', b: 'beta blockers', severity: 'moderate', ar: 'قد يخفي أعراض هبوط السكر', en: 'Masks hypoglycemia symptoms', rec: 'مراقبة السكر بعناية' },
  ];

  const stmt = database.prepare(`
    INSERT INTO drug_interactions (ingredient_a, ingredient_b, severity, description_ar, description_en, recommendation) 
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = database.transaction((items: typeof interactions) => {
    for (const i of items) {
      stmt.run(i.a, i.b, i.severity, i.ar, i.en, i.rec);
    }
  });

  insertMany(interactions);
}

export function logActivity(userId: string, action: string, details: string) {
  try {
    db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)')
      .run(userId, action, details);
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
}

/**
 * Clear activity logs
 * IMPORTANT: Caller must verify owner role before calling this
 */
export function clearAuditLogs() {
  try {
    db.prepare('DELETE FROM activity_log').run();
    return true;
  } catch (error) {
    console.error('Failed to clear activity logs:', error);
    return false;
  }
}

export default db;
