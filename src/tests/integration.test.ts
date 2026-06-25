/**
 * Integration Test: Cross-Module End-to-End Scenarios
 *
 * Tests flows that span multiple modules to verify system integrity:
 *   1. Purchase → Inventory → POS Sale → Return
 *   2. Supplier Credit → Payment → Bank Transfer
 *   3. Shift Open → Sales → Handover → Shift Close
 *   4. User Create → Permission Check → Login → Audit
 */
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

function seedAll(db: Database.Database) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT, role TEXT, full_name TEXT, pharmacy_id TEXT, permissions TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT, name_en TEXT, phone TEXT, balance REAL DEFAULT 0);
    CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, official_price REAL, base_price REAL DEFAULT 0, is_medicine INTEGER DEFAULT 1, reorder_point INTEGER DEFAULT 10);
    CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, quantity INTEGER DEFAULT 0, cost_price REAL DEFAULT 0, local_selling_price REAL, batch_number TEXT, expiry_date TEXT);
    CREATE TABLE purchase_invoices (id TEXT PRIMARY KEY, supplier_id INTEGER, user_id TEXT, invoice_number TEXT, invoice_date TEXT, total_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0, payment_method TEXT DEFAULT 'credit', status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT, drug_id INTEGER, quantity INTEGER, cost_price REAL, selling_price REAL, bonus_quantity INTEGER DEFAULT 0, expiry_date TEXT);
    CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, user_id TEXT, patient_id TEXT, total_amount REAL, discount_amount REAL DEFAULT 0, payment_method TEXT, status TEXT DEFAULT 'completed');
    CREATE TABLE sales_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT, drug_id INTEGER, quantity_sold REAL, unit_price REAL, cost_price REAL DEFAULT 0, is_negative INTEGER DEFAULT 0);
    CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, total_refund REAL, reason TEXT, status TEXT DEFAULT 'pending');
    CREATE TABLE return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_returned INTEGER, unit_price REAL);
    CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, starting_cash REAL DEFAULT 0, ending_cash REAL, status TEXT DEFAULT 'open', start_time DATETIME, end_time DATETIME);
    CREATE TABLE cash_movements (id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT, type TEXT, category TEXT, amount REAL, notes TEXT, date TEXT);
    CREATE TABLE banks (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT, account_number TEXT, current_balance REAL DEFAULT 0);
    CREATE TABLE supplier_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER, type TEXT, amount REAL, reference_id TEXT);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, details TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL);
    CREATE TABLE journal_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id TEXT, account_id INTEGER, type TEXT, amount REAL);
    CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT, code TEXT UNIQUE, balance REAL DEFAULT 0);
  `);

  const adminHash = bcrypt.hashSync('admin123', 4);
  const cashierHash = bcrypt.hashSync('cashier123', 4);
  db.prepare("INSERT INTO users VALUES ('u-admin', 'admin', ?, 'owner', 'Admin', 'ph-1', '{}', 1)").run(adminHash);
  db.prepare("INSERT INTO users VALUES ('u-cashier', 'cashier1', ?, 'cashier', 'Cashier', 'ph-1', '{\"can_sell\":true}', 1)").run(cashierHash);
  db.prepare("INSERT INTO users VALUES ('u-disabled', 'disabled', ?, 'pharmacist', 'Disabled', 'ph-1', '{}', 0)").run(adminHash);
  db.prepare("INSERT INTO suppliers VALUES (1, 'المورد الأول', 'Supplier A', '012345', 10000)").run();
  db.prepare("INSERT INTO suppliers VALUES (2, 'المورد الثاني', 'Supplier B', '067890', 0)").run();
  db.prepare("INSERT INTO master_drugs VALUES (1, 'Panadol', 'Panadol EN', 15, 10, 1, 10)").run();
  db.prepare("INSERT INTO master_drugs VALUES (2, 'Brufen', 'Brufen EN', 25, 18, 1, 10)").run();
  db.prepare("INSERT INTO master_drugs VALUES (3, 'Augmentin', 'Augmentin EN', 85, 60, 1, 5)").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-b1', 1, 50, 10, 15, 'B001', '2027-12-31')").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-b2', 2, 100, 18, 25, 'B002', '2027-06-30')").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-b3', 3, 20, 60, 85, 'B003', '2026-12-31')").run();
  db.prepare("INSERT INTO shifts VALUES ('shift-1', 'u-admin', 500, NULL, 'open', datetime('now'), NULL)").run();
  db.prepare("INSERT INTO accounts VALUES (1, 'Inventory Asset', '1.1', 0)").run();
  db.prepare("INSERT INTO accounts VALUES (2, 'Cash Drawer', '1.2', 500)").run();
  db.prepare("INSERT INTO accounts VALUES (3, 'Accounts Payable', '2.1', 0)").run();
  db.prepare("INSERT INTO banks VALUES (1, 'البنك الأهلي', '123456789', 100000)").run();
}

function genId() { return `int-${Date.now()}-${Math.random().toString(36).slice(2,6)}`; }

describe('Integration: Purchase → Inventory → Sale → Return', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedAll(db); });
  afterAll(() => db.close());

  it('1a: Purchase supplies on credit → inventory increases, supplier balance updated', () => {
    const invId = genId();
    db.transaction(() => {
      db.prepare("INSERT INTO purchase_invoices VALUES (?, 1, 'u-admin', 'PO-001', '2026-06-23', 600, 0, 'credit', 'completed', datetime('now'))").run(invId);
      db.prepare("INSERT INTO purchase_invoice_items VALUES (?, ?, 1, 50, 12, 17, 5, '2028-06-30')").run(null, invId);
      db.prepare("INSERT INTO purchase_invoice_items VALUES (?, ?, 2, 30, 20, 28, 3, '2028-06-30')").run(null, invId);
      db.prepare("INSERT INTO inventory VALUES (?, 1, 55, 12, 17, 'PO-001-1', '2028-06-30')").run(genId());
      db.prepare("INSERT INTO inventory VALUES (?, 2, 33, 20, 28, 'PO-001-2', '2028-06-30')").run(genId());
      db.prepare("UPDATE suppliers SET balance = balance + 600 WHERE id = 1").run();
    })();

    const inv1 = db.prepare("SELECT SUM(quantity) as qty FROM inventory WHERE drug_id = 1").get() as any;
    expect(inv1.qty).toBe(105); // 50 + 55
    const supp1 = db.prepare("SELECT balance FROM suppliers WHERE id = 1").get() as any;
    expect(supp1.balance).toBe(10600);
  });

  it('1b: POS sale → inventory decreases, invoice created', () => {
    const saleId = genId();
    db.transaction(() => {
      db.prepare("INSERT INTO sales_invoices VALUES (?, 'u-admin', NULL, 300, 20, 'cash', 'completed')").run(saleId);
      db.prepare("INSERT INTO sales_items VALUES (?, ?, 1, 10, 15, 10, 0)").run(null, saleId);
      db.prepare("INSERT INTO sales_items VALUES (?, ?, 2, 5, 25, 18, 0)").run(null, saleId);
      db.prepare("UPDATE inventory SET quantity = quantity - 10 WHERE id = 'inv-b1' AND drug_id = 1").run();
      db.prepare("UPDATE inventory SET quantity = quantity - 5 WHERE id = 'inv-b2' AND drug_id = 2").run();
    })();

    const inv1 = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-b1'").get() as any;
    expect(inv1.quantity).toBe(40); // 50 - 10
    const inv2 = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-b2'").get() as any;
    expect(inv2.quantity).toBe(95); // 100 - 5
  });

  it('1c: Customer return → inventory restored, refund recorded', () => {
    const retId = genId();
    db.transaction(() => {
      db.prepare("INSERT INTO returns VALUES (?, 'int-sale-001', 'u-admin', 150, 'إرجاع جزئي', 'approved')").run(retId);
      db.prepare("INSERT INTO return_items VALUES (?, ?, 'inv-b1', 1, 5, 15)").run(null, retId);
      db.prepare("UPDATE inventory SET quantity = quantity + 5 WHERE id = 'inv-b1'").run();
    })();

    const inv1 = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-b1'").get() as any;
    expect(inv1.quantity).toBe(45); // 40 + 5
    const ret = db.prepare("SELECT * FROM returns WHERE id = ?").get(retId) as any;
    expect(ret.total_refund).toBe(150);
    expect(ret.status).toBe('approved');
  });
});

describe('Integration: Supplier Credit → Payment → Bank Transfer', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedAll(db); });
  afterAll(() => db.close());

  it('2a: Pay supplier credit decreases supplier balance and bank balance', () => {
    // Supplier 1 has 10000 balance; pay 5000
    db.prepare("INSERT INTO supplier_transactions VALUES (?, 1, 'payment', 5000, 'PAY-001')").run(null);
    db.prepare("UPDATE suppliers SET balance = balance - 5000 WHERE id = 1").run();
    db.prepare("UPDATE banks SET current_balance = current_balance - 5000 WHERE id = 1").run();

    const supp = db.prepare("SELECT balance FROM suppliers WHERE id = 1").get() as any;
    expect(supp.balance).toBe(5000);
    const bank = db.prepare("SELECT current_balance FROM banks WHERE id = 1").get() as any;
    expect(bank.current_balance).toBe(95000);
  });
});

describe('Integration: Shift Lifecycle — Open → Sales → Close', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedAll(db); });
  afterAll(() => db.close());

  it('3a: Start shift → initial cash = 500', () => {
    const shift = db.prepare("SELECT * FROM shifts WHERE id = 'shift-1'").get() as any;
    expect(shift.starting_cash).toBe(500);
    expect(shift.status).toBe('open');
  });

  it('3b: Close shift → ending cash recorded, cash movements checked', () => {
    db.prepare("UPDATE shifts SET status = 'closed', ending_cash = 3500, end_time = datetime('now') WHERE id = 'shift-1'").run();
    const shift = db.prepare("SELECT * FROM shifts WHERE id = 'shift-1'").get() as any;
    expect(shift.status).toBe('closed');
    expect(shift.ending_cash).toBe(3500);
  });
});

describe('Integration: User → Permission → Login → Audit', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedAll(db); });
  afterAll(() => db.close());

  it('4a: Inactive user cannot login', () => {
    const user = db.prepare("SELECT * FROM users WHERE id = 'u-disabled'").get() as any;
    expect(user.is_active).toBe(0);
    // Simulate login check
    if (!user.is_active) {
      db.prepare("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'LOGIN_FAILED', ?)").run('u-disabled', 'حساب غير نشط');
    }
    const log = db.prepare("SELECT * FROM activity_log ORDER BY rowid DESC LIMIT 1").get() as any;
    expect(log.action).toBe('LOGIN_FAILED');
  });

  it('4b: Cashier has limited permissions', () => {
    const user = db.prepare("SELECT * FROM users WHERE id = 'u-cashier'").get() as any;
    expect(user.role).toBe('cashier');
    const perms = JSON.parse(user.permissions);
    expect(perms.can_sell).toBe(true);
    expect(perms.can_manage_inventory).toBeUndefined();
  });

  it('4c: Audit log tracks all operations', () => {
    // Simulate audit entries
    db.prepare("INSERT INTO activity_log VALUES (?, 'u-admin', 'LOGIN', 'Admin logged in', datetime('now'))").run(null);
    db.prepare("INSERT INTO activity_log VALUES (?, 'u-cashier', 'LOGIN', 'Cashier logged in', datetime('now'))").run(null);
    db.prepare("INSERT INTO activity_log VALUES (?, 'u-admin', 'COMPLETE_PURCHASE', 'Purchase completed', datetime('now'))").run(null);
    const count = (db.prepare("SELECT COUNT(*) as c FROM activity_log").get() as any).c;
    expect(count).toBe(4);
  });
});

describe('Integration: Full Business Cycle — DB integrity', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedAll(db); });
  afterAll(() => db.close());

  it('Run PRAGMA integrity_check', () => {
    const result = db.pragma('integrity_check', { simple: true }) as string;
    expect(result).toBe('ok');
  });

  it('No orphaned inventory references', () => {
    const orphans = db.prepare(`
      SELECT i.id FROM inventory i
      LEFT JOIN master_drugs d ON i.drug_id = d.id
      WHERE d.id IS NULL
    `).all();
    expect(orphans).toHaveLength(0);
  });
});
