-- 001_initial.sql

-- 1. Configuration & Core Systems
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS employee_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  min_salary REAL DEFAULT 0,
  max_salary REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  permissions TEXT DEFAULT '{"can_sell": true, "can_manage_inventory": false}',
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (job_id) REFERENCES employee_jobs (id)
);

-- 2. Drug Master System
CREATE TABLE IF NOT EXISTS master_drugs (
  id INTEGER PRIMARY KEY,
  trade_name TEXT NOT NULL,
  trade_name_en TEXT,
  generic_name TEXT,
  active_ingredient TEXT,
  barcode TEXT,
  official_price REAL DEFAULT 0,
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
  code_2 TEXT,
  item_nature TEXT,
  scientific_group TEXT,
  usage_method TEXT,
  active_ingredient_ratio TEXT,
  is_table INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- FTS5 Virtual Table for master_drugs
CREATE VIRTUAL TABLE IF NOT EXISTS master_drugs_fts USING fts5(
  id UNINDEXED,
  trade_name,
  trade_name_en,
  generic_name,
  active_ingredient,
  content='master_drugs',
  content_rowid='id'
);

-- Triggers for FTS5 Sync
CREATE TRIGGER IF NOT EXISTS master_drugs_ai AFTER INSERT ON master_drugs BEGIN
  INSERT INTO master_drugs_fts(id, trade_name, trade_name_en, generic_name, active_ingredient)
  VALUES (new.id, new.trade_name, new.trade_name_en, new.generic_name, new.active_ingredient);
END;

CREATE TRIGGER IF NOT EXISTS master_drugs_ad AFTER DELETE ON master_drugs BEGIN
  INSERT INTO master_drugs_fts(master_drugs_fts, id, trade_name, trade_name_en, generic_name, active_ingredient)
  VALUES('delete', old.id, old.trade_name, old.trade_name_en, old.generic_name, old.active_ingredient);
END;

CREATE TRIGGER IF NOT EXISTS master_drugs_au AFTER UPDATE ON master_drugs BEGIN
  INSERT INTO master_drugs_fts(master_drugs_fts, id, trade_name, trade_name_en, generic_name, active_ingredient)
  VALUES('delete', old.id, old.trade_name, old.trade_name_en, old.generic_name, old.active_ingredient);
  INSERT INTO master_drugs_fts(id, trade_name, trade_name_en, generic_name, active_ingredient)
  VALUES (new.id, new.trade_name, new.trade_name_en, new.generic_name, new.active_ingredient);
END;

-- 3. Patient Management
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
  wallet_balance REAL DEFAULT 0,
  loyalty_level TEXT DEFAULT 'bronze',
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. Inventory
CREATE TABLE IF NOT EXISTS inventory (
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
  FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
);

-- 5. Sales & Invoices
CREATE TABLE IF NOT EXISTS sales_invoices (
  id TEXT PRIMARY KEY,
  pharmacy_id TEXT,
  user_id TEXT,
  patient_id TEXT,
  shift_id TEXT,
  total_amount REAL,
  payment_method TEXT,
  check_number TEXT,
  status TEXT DEFAULT 'completed',
  discount_amount REAL DEFAULT 0,
  paid_amount REAL DEFAULT 0,
  remaining_amount REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (patient_id) REFERENCES patients (id)
);

CREATE TABLE IF NOT EXISTS sales_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT,
  inventory_id TEXT,
  drug_id INTEGER,
  quantity_sold REAL,
  unit_price REAL,
  unit TEXT DEFAULT 'large',
  is_negative INTEGER DEFAULT 0,
  cost_price REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES sales_invoices (id),
  FOREIGN KEY (inventory_id) REFERENCES inventory (id),
  FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
);

-- 6. Shifts & Activity Logging
CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  end_time DATETIME,
  starting_cash REAL DEFAULT 0,
  ending_cash REAL,
  status TEXT DEFAULT 'open',
  notes TEXT,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id)
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

-- 7. Safety & Clinical profiles
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

-- 8. Returns & Refunds
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES sales_invoices (id),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (shift_id) REFERENCES shifts (id)
);

CREATE TABLE IF NOT EXISTS return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL,
  inventory_id TEXT,
  drug_name TEXT,
  quantity_returned INTEGER,
  unit_price REAL,
  FOREIGN KEY (return_id) REFERENCES returns (id),
  FOREIGN KEY (inventory_id) REFERENCES inventory (id)
);

-- 9. Suppliers & Purchases
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

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  supplier_name TEXT,
  status TEXT DEFAULT 'pending',
  total_amount REAL DEFAULT 0,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id TEXT NOT NULL,
  drug_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  expected_price REAL,
  received_quantity INTEGER DEFAULT 0,
  FOREIGN KEY (po_id) REFERENCES purchase_orders (id),
  FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
);

-- 10. Financial System
CREATE TABLE IF NOT EXISTS banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  account_number TEXT,
  branch TEXT,
  current_balance REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER,
  code TEXT UNIQUE NOT NULL,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  type TEXT NOT NULL,
  is_group INTEGER DEFAULT 0,
  balance REAL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (parent_id) REFERENCES accounts (id)
);

CREATE TABLE IF NOT EXISTS daily_journals (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  description TEXT,
  created_by TEXT,
  total_amount REAL NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  notes TEXT,
  FOREIGN KEY (journal_id) REFERENCES daily_journals (id),
  FOREIGN KEY (account_id) REFERENCES accounts (id)
);

CREATE TABLE IF NOT EXISTS trial_balance_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  target_name TEXT,
  account_id INTEGER,
  FOREIGN KEY (account_id) REFERENCES accounts (id)
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

CREATE TABLE IF NOT EXISTS expense_definitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name_ar TEXT NOT NULL,
  name_en TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT,
  date TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS commercial_papers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  direction TEXT NOT NULL,
  paper_number TEXT,
  bank_id INTEGER,
  amount REAL NOT NULL,
  due_date TEXT,
  status TEXT DEFAULT 'pending',
  target_name TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bank_id) REFERENCES banks (id)
);

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

-- 11. Administrative & Metadata Tables
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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users (id)
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
  FOREIGN KEY (drug_id) REFERENCES master_drugs (id),
  FOREIGN KEY (unit_id) REFERENCES units (id)
);

CREATE TABLE IF NOT EXISTS shortages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drug_id INTEGER NOT NULL,
  requested_quantity INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
  FOREIGN KEY (reason_id) REFERENCES adjustment_reasons (id),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

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

-- 12. Seeding Critical Drug Interactions
INSERT OR IGNORE INTO drug_interactions (ingredient_a, ingredient_b, severity, description_ar, description_en, recommendation) VALUES
('warfarin', 'aspirin', 'critical', 'خطر نزيف حاد - لا يجمع بين الوارفارين والأسبرين', 'High bleeding risk', 'استخدام بديل أو مراقبة INR'),
('warfarin', 'ibuprofen', 'critical', 'خطر نزيف معوي حاد', 'GI bleeding risk', 'تجنب الجمع واستخدام باراسيتامول'),
('methotrexate', 'trimethoprim', 'critical', 'سمية نخاع العظم', 'Bone marrow toxicity', 'تجنب الجمع بينهما'),
('simvastatin', 'erythromycin', 'critical', 'خطر تحلل العضلات', 'Rhabdomyolysis risk', 'استخدام مضاد حيوي بديل'),
('metformin', 'contrast dye', 'critical', 'حماض لبني خطير', 'Lactic acidosis', 'إيقاف الميتفورمين 48 ساعة قبل وبعد الصبغة'),
('sildenafil', 'nitroglycerin', 'critical', 'انخفاض ضغط دم حاد مهدد للحياة', 'Severe hypotension', 'ممنوع الجمع نهائياً'),
('clopidogrel', 'omeprazole', 'critical', 'تقليل فعالية كلوبيدوجريل', 'Reduced clopidogrel efficacy', 'استبدال بالبانتوبرازول'),
('ciprofloxacin', 'antacids', 'major', 'تقليل امتصاص السيبروفلوكساسين بشكل كبير', 'Reduced absorption', 'فصل 2 ساعة على الأقل'),
('amlodipine', 'simvastatin', 'major', 'زيادة خطر آلام العضلات', 'Myopathy risk increased', 'لا يتجاوز 20 مجم سيمفاستاتين'),
('lisinopril', 'spironolactone', 'major', 'ارتفاع خطير في البوتاسيوم', 'Hyperkalemia risk', 'مراقبة مستوى البوتاسيوم بانتظام'),
('atenolol', 'verapamil', 'major', 'بطء شديد في ضربات القلب', 'Severe bradycardia', 'تجنب الجمع'),
('fluoxetine', 'tramadol', 'major', 'خطر متلازمة السيروتونين', 'Serotonin syndrome', 'تجنب أو مراقبة دقيقة'),
('amoxicillin', 'methotrexate', 'major', 'زيادة سمية الميثوتريكسات', 'MTX toxicity increased', 'مراقبة وظائف الكلى والدم'),
('diclofenac', 'null', 'major', 'ارتفاع مستوى الليثيوم في الدم', 'Lithium toxicity', 'مراقبة مستوى الليثيوم'),
('metformin', 'glimepiride', 'moderate', 'خطر هبوط سكر الدم', 'Hypoglycemia risk', 'مراقبة السكر بانتظام'),
('atorvastatin', 'clarithromycin', 'major', 'زيادة مستوى الستاتين وخطر تحلل العضلات', 'Increased statin levels', 'تعليق الستاتين أثناء المضاد الحيوي'),
('paracetamol', 'warfarin', 'moderate', 'زيادة طفيفة في تأثير الوارفارين', 'Slightly increased INR', 'مراقبة INR عند الاستخدام المنتظم'),
('metformin', 'alcohol', 'moderate', 'زيادة خطر الحماض اللبني', 'Lactic acidosis risk', 'تجنب الكحول'),
('captopril', 'potassium supplements', 'moderate', 'ارتفاع البوتاسيوم', 'Hyperkalemia', 'مراقبة البوتاسيوم'),
('amoxicillin', 'oral contraceptives', 'moderate', 'قد يقلل فعالية حبوب منع الحمل', 'Reduced OCP efficacy', 'استخدام وسيلة إضافية'),
('ibuprofen', 'aspirin', 'moderate', 'تقليل التأثير الواقي للقلب للأسبرين', 'Reduced cardioprotection', 'تناول الأسبرين قبل الأيبوبروفين بساعة'),
('omeprazole', 'iron supplements', 'moderate', 'تقليل امتصاص الحديد', 'Reduced iron absorption', 'فصل الجرعات أو استخدام فيتامين C'),
('ciprofloxacin', 'theophylline', 'major', 'زيادة سمية الثيوفيللين', 'Theophylline toxicity', 'تقليل جرعة الثيوفيللين أو اختيار مضاد حيوي آخر'),
('prednisolone', 'ibuprofen', 'moderate', 'زيادة خطر قرحة المعدة', 'GI ulcer risk', 'إضافة واقي معدة'),
('insulin', 'beta blockers', 'moderate', 'قد يخفي أعراض هبوط السكر', 'Masks hypoglycemia symptoms', 'مراقبة السكر بعناية');

-- 13. Unique index to prevent duplicate interactions
CREATE UNIQUE INDEX IF NOT EXISTS uidx_interactions ON drug_interactions(ingredient_a, ingredient_b);

-- 14. Indexes for performance
CREATE INDEX IF NOT EXISTS idx_inventory_drug_id ON inventory(drug_id);
CREATE INDEX IF NOT EXISTS idx_inventory_expiry_date ON inventory(expiry_date);
CREATE INDEX IF NOT EXISTS idx_sales_items_invoice_id ON sales_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_sales_items_drug_id ON sales_items(drug_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_patient_id ON sales_invoices(patient_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_created_at ON sales_invoices(created_at);
CREATE INDEX IF NOT EXISTS idx_master_drugs_barcode ON master_drugs(barcode);
CREATE INDEX IF NOT EXISTS idx_master_drugs_trade_name_en ON master_drugs(trade_name_en);

-- 14. Seed Default Admin User (username: admin, password: admin)
INSERT OR IGNORE INTO users (id, username, password_hash, role, full_name, permissions)
VALUES (
  'admin',
  'admin',
  '$2b$12$.FYM9XhLwanE5PdySaxB2uMwZwwLpF9fI6HXf/2XArluRQt0kfvVm',
  'owner',
  'System Administrator',
  '["view_dashboard","view_reports","manage_inventory","manage_staff","process_sales","manage_patients","view_all_sales","manage_settings","void_transactions","manage_shifts","manage_pharmacy","export_data","import_data","view_audit_logs"]'
);
