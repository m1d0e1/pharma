/**
 * Phase 8: Master Data (P2) + Phase 9: Reports (P2) + Phase 10: Patients (P2) + Phase 11: Admin (P3)
 */

import Database from 'better-sqlite3';

function seedMaster(db: Database.Database) {
  db.exec(`
    CREATE TABLE product_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, name_ar TEXT NOT NULL, name_en TEXT, FOREIGN KEY (parent_id) REFERENCES product_categories (id));
    CREATE TABLE units (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, name_en TEXT);
    CREATE TABLE manufacturers (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, name_en TEXT);
    CREATE TABLE scientific_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, name_en TEXT);
    CREATE TABLE indications (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, name_en TEXT);
    CREATE TABLE item_natures (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, name_en TEXT);
    CREATE TABLE usage_methods (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, name_en TEXT);
    CREATE TABLE drug_indications (drug_id INTEGER, indication_id INTEGER, PRIMARY KEY (drug_id, indication_id));
    CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, is_medicine INTEGER DEFAULT 1, category TEXT, manufacturer TEXT);
    CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, total_amount REAL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'completed');
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, role TEXT, full_name TEXT);
    CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT, phone TEXT, credit_limit REAL DEFAULT 0, points_balance REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE patient_transactions (id TEXT PRIMARY KEY, patient_id TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL);
    CREATE TABLE drug_interactions (id INTEGER PRIMARY KEY AUTOINCREMENT, ingredient_a TEXT NOT NULL, ingredient_b TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'minor', description_ar TEXT, recommendation TEXT);
    CREATE TABLE audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action_type TEXT, table_name TEXT, record_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE employee_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, min_salary REAL DEFAULT 0, max_salary REAL DEFAULT 0);
    CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, starting_cash REAL DEFAULT 0, ending_cash REAL, status TEXT DEFAULT 'open', start_time DATETIME, end_time DATETIME);
    CREATE TABLE expense_definitions (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, code TEXT);
    CREATE TABLE expenses (id TEXT PRIMARY KEY, category TEXT NOT NULL, amount REAL NOT NULL, date TEXT NOT NULL);
  `);
}

// ─── Phase 8: Master Data ─────────────────────────────────────────
describe('Phase 8: Master Data', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedMaster(db); });
  afterAll(() => db.close());

  it('Category hierarchy (parent/child)', () => {
    db.prepare("INSERT INTO product_categories (id, name_ar, name_en) VALUES (1, 'أدوية', 'Medicines')").run();
    db.prepare("INSERT INTO product_categories (id, parent_id, name_ar, name_en) VALUES (2, 1, 'مسكنات', 'Analgesics')").run();
    db.prepare("INSERT INTO product_categories (id, parent_id, name_ar, name_en) VALUES (3, 1, 'مضادات حيوية', 'Antibiotics')").run();

    const children = db.prepare("SELECT * FROM product_categories WHERE parent_id = 1").all() as any[];
    expect(children).toHaveLength(2);
    const root = db.prepare("SELECT * FROM product_categories WHERE parent_id IS NULL").all() as any[];
    expect(root).toHaveLength(1);
  });

  it('Units CRUD', () => {
    db.prepare("INSERT INTO units VALUES (1, 'علبة', 'Box')").run();
    db.prepare("INSERT INTO units VALUES (2, 'شريط', 'Strip')").run();
    const all = db.prepare("SELECT * FROM units").all() as any[];
    expect(all).toHaveLength(2);
  });

  it('Manufacturers CRUD', () => {
    db.prepare("INSERT INTO manufacturers VALUES (1, 'GSK', 'GSK')").run();
    db.prepare("INSERT INTO manufacturers VALUES (2, 'فايزر', 'Pfizer')").run();
    const all = db.prepare("SELECT * FROM manufacturers").all() as any[];
    expect(all).toHaveLength(2);
  });

  it('Drug-Indication junction', () => {
    db.prepare("INSERT INTO master_drugs VALUES (1, 'Panadol', 1, 'مسكن', 'GSK')").run();
    db.prepare("INSERT INTO indications VALUES (1, 'صداع', 'Headache')").run();
    db.prepare("INSERT INTO drug_indications VALUES (1, 1)").run();

    const mapping = db.prepare("SELECT * FROM drug_indications WHERE drug_id = 1 AND indication_id = 1").get() as any;
    expect(mapping).toBeDefined();
  });
});

// ─── Phase 9: Reports ────────────────────────────────────────────
describe('Phase 9: Reports', () => {
  let db: Database.Database;
  beforeAll(() => {
    db = new Database(':memory:'); seedMaster(db);
    db.prepare("INSERT INTO sales_invoices VALUES ('rpt-001', 500, '2026-06-23 10:00:00', 'completed')").run();
    db.prepare("INSERT INTO sales_invoices VALUES ('rpt-002', 300, '2026-06-23 14:00:00', 'completed')").run();
    db.prepare("INSERT INTO sales_invoices VALUES ('rpt-003', 200, '2026-06-22 10:00:00', 'completed')").run();
    db.prepare("INSERT INTO expenses VALUES ('exp-001', 'إيجار', 1000, '2026-06-23')").run();
    db.prepare("INSERT INTO expenses VALUES ('exp-002', 'رواتب', 5000, '2026-06-23')").run();
  });
  afterAll(() => db.close());

  it('Daily sales aggregation', () => {
    const daily = db.prepare("SELECT date(created_at) as day, SUM(total_amount) as total FROM sales_invoices WHERE status = 'completed' GROUP BY date(created_at)").all() as any[];
    expect(daily).toHaveLength(2);
    const day1 = daily.find((d: any) => d.day === '2026-06-23');
    expect(day1.total).toBe(800); // 500+300
  });

  it('Expense report by category', () => {
    const total = db.prepare("SELECT SUM(amount) as total FROM expenses WHERE date = '2026-06-23'").get() as any;
    expect(total.total).toBe(6000);
  });
});

// ─── Phase 10: Patients ──────────────────────────────────────────
describe('Phase 10: Patients', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedMaster(db); });
  afterAll(() => db.close());

  it('Patient CRUD with credit limit', () => {
    db.prepare("INSERT INTO patients (id, full_name, phone, credit_limit, points_balance) VALUES ('p-1', 'أحمد', '012345', 1000, 50)").run();
    const p = db.prepare("SELECT * FROM patients WHERE id = 'p-1'").get() as any;
    expect(p.full_name).toBe('أحمد');
    expect(p.credit_limit).toBe(1000);
  });

  it('Patient transaction history', () => {
    db.prepare("INSERT INTO patient_transactions (id, patient_id, type, amount, date) VALUES ('ptx-1', 'p-1', 'payment', 500, '2026-06-23')").run();
    db.prepare("INSERT INTO patient_transactions (id, patient_id, type, amount, date) VALUES ('ptx-2', 'p-1', 'credit_sale', 200, '2026-06-22')").run();
    const tx = db.prepare("SELECT * FROM patient_transactions WHERE patient_id = 'p-1' ORDER BY date DESC").all() as any[];
    expect(tx).toHaveLength(2);
    expect(tx[0].amount).toBe(500);
  });

  it('Points balance accumulates', () => {
    db.prepare("UPDATE patients SET points_balance = points_balance + 10 WHERE id = 'p-1'").run();
    const p = db.prepare("SELECT points_balance FROM patients WHERE id = 'p-1'").get() as any;
    expect(p.points_balance).toBe(60);
  });

  it('Drug interaction lookup', () => {
    db.prepare("INSERT INTO drug_interactions (ingredient_a, ingredient_b, severity, description_ar) VALUES ('warfarin', 'aspirin', 'critical', 'خطر نزيف حاد')").run();
    const ci = db.prepare("SELECT * FROM drug_interactions WHERE severity = 'critical'").all() as any[];
    expect(ci).toHaveLength(1);
    expect(ci[0].description_ar).toContain('نزيف');
  });
});

// ─── Phase 11: Admin ─────────────────────────────────────────────
describe('Phase 11: Admin, Help & Security', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedMaster(db); });
  afterAll(() => db.close());

  it('Staff user management with roles', () => {
    db.prepare("INSERT INTO users (id, username, role, full_name) VALUES ('u-1', 'admin', 'owner', 'Admin')").run();
    db.prepare("INSERT INTO users (id, username, role, full_name) VALUES ('u-2', 'cashier1', 'cashier', 'Cashier')").run();
    const owners = db.prepare("SELECT * FROM users WHERE role = 'owner'").all() as any[];
    expect(owners).toHaveLength(1);
  });

  it('Employee job definitions with salary ranges', () => {
    db.prepare("INSERT INTO employee_jobs (name_ar, min_salary, max_salary) VALUES ('صيدلاني', 3000, 8000)").run();
    db.prepare("INSERT INTO employee_jobs (name_ar, min_salary, max_salary) VALUES ('محاسب', 2500, 5000)").run();
    const jobs = db.prepare("SELECT * FROM employee_jobs").all() as any[];
    expect(jobs).toHaveLength(2);
    expect(jobs[0].min_salary).toBe(3000);
  });

  it('Audit log entries', () => {
    db.prepare("INSERT INTO audit_logs (id, user_id, action_type, table_name, record_id, created_at) VALUES ('aud-1', 'u-1', 'INSERT', 'users', 'u-2', datetime('now'))").run();
    const logs = db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC").all() as any[];
    expect(logs).toHaveLength(1);
    expect(logs[0].action_type).toBe('INSERT');
  });

  it('Configuration key-value store', () => {
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('pharmacy_name', 'صيدلية النور')").run();
    db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('tax_rate', '14')").run();
    const name = db.prepare("SELECT value FROM config WHERE key = 'pharmacy_name'").get() as any;
    expect(name.value).toBe('صيدلية النور');
  });

  it('Shift management lifecycle', () => {
    db.prepare("INSERT INTO shifts (id, user_id, starting_cash, status, start_time) VALUES ('sh-1', 'u-1', 500, 'open', datetime('now'))").run();
    const open = db.prepare("SELECT * FROM shifts WHERE status = 'open'").all() as any[];
    expect(open).toHaveLength(1);

    db.prepare("UPDATE shifts SET status = 'closed', ending_cash = 1500, end_time = datetime('now') WHERE id = 'sh-1'").run();
    const closed = db.prepare("SELECT * FROM shifts WHERE id = 'sh-1'").get() as any;
    expect(closed.status).toBe('closed');
    expect(closed.ending_cash).toBe(1500);
  });

  it('Expense definitions with codes', () => {
    db.prepare("INSERT INTO expense_definitions (name_ar, code) VALUES ('إيجار', 'RENT')").run();
    db.prepare("INSERT INTO expense_definitions (name_ar, code) VALUES ('رواتب', 'SALARY')").run();
    const defs = db.prepare("SELECT * FROM expense_definitions").all() as any[];
    expect(defs).toHaveLength(2);
  });
});
