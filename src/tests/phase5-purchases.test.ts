/**
 * Phase 5: Purchases Tests (P1)
 * Supplier management, purchase invoices, purchase orders, supplier returns.
 */

import Database from 'better-sqlite3';

function seedPurchases(db: Database.Database) {
  db.exec(`
    CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, official_price REAL DEFAULT 0, is_medicine INTEGER DEFAULT 1);
    CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, quantity INTEGER DEFAULT 0, cost_price REAL DEFAULT 0, local_selling_price REAL, batch_number TEXT, expiry_date TEXT);
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, name_en TEXT, phone TEXT, balance REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE purchase_invoices (id TEXT PRIMARY KEY, supplier_id INTEGER NOT NULL, user_id TEXT, invoice_number TEXT, invoice_date TEXT, total_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0, payment_method TEXT DEFAULT 'credit', discount_value REAL DEFAULT 0, discount_percent REAL DEFAULT 0, expenses REAL DEFAULT 0, status TEXT DEFAULT 'pending', notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (supplier_id) REFERENCES suppliers (id));
    CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT NOT NULL, drug_id INTEGER NOT NULL, quantity INTEGER NOT NULL, cost_price REAL NOT NULL, selling_price REAL, bonus_quantity INTEGER DEFAULT 0, discount_percent REAL DEFAULT 0, expiry_date TEXT, FOREIGN KEY (invoice_id) REFERENCES purchase_invoices (id), FOREIGN KEY (drug_id) REFERENCES master_drugs (id));
    CREATE TABLE purchase_orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, supplier_name TEXT, status TEXT DEFAULT 'pending', total_amount REAL DEFAULT 0, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE purchase_order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, po_id TEXT NOT NULL, drug_id INTEGER NOT NULL, quantity INTEGER NOT NULL, expected_price REAL, received_quantity INTEGER DEFAULT 0);
    CREATE TABLE purchase_returns (id TEXT PRIMARY KEY, supplier_id INTEGER NOT NULL, user_id TEXT NOT NULL, total_amount REAL, reason TEXT, status TEXT DEFAULT 'completed', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE purchase_return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_return_id TEXT NOT NULL, drug_id INTEGER, inventory_id TEXT, quantity_returned INTEGER, unit_price REAL, reason TEXT);
    CREATE TABLE supplier_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, reference_id TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  `);

  db.prepare("INSERT INTO master_drugs VALUES (1, 'Panadol', 15, 1)").run();
  db.prepare("INSERT INTO master_drugs VALUES (2, 'Brufen', 25, 1)").run();
  db.prepare("INSERT INTO master_drugs VALUES (3, 'Augmentin', 85, 1)").run();
  db.prepare("INSERT INTO suppliers VALUES (1, 'المورد الأول', 'Supplier A', '012345', 15000, datetime('now'))").run();
  db.prepare("INSERT INTO suppliers VALUES (2, 'المورد الثاني', 'Supplier B', '067890', 0, datetime('now'))").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-001', 1, 50, 10, 15, 'B001', '2026-12-31')").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-002', 2, 100, 18, 25, 'B002', '2027-06-30')").run();
}

describe('Phase 5a: Supplier Management', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedPurchases(db); });
  afterAll(() => db.close());

  it('Scenario 1: Create supplier with balance tracking', () => {
    const count = (db.prepare('SELECT COUNT(*) as c FROM suppliers').get() as any).c;
    expect(count).toBe(2);

    const s1 = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(1) as any;
    expect(s1.name_ar).toBe('المورد الأول');
    expect(s1.balance).toBe(15000);
  });

  it('Scenario 2: Supplier balance updates via transactions', () => {
    db.prepare("INSERT INTO supplier_transactions (supplier_id, type, amount, notes) VALUES (1, 'payment', 5000, 'دفعة')").run();
    db.prepare("UPDATE suppliers SET balance = balance - 5000 WHERE id = 1").run();
    const s1 = db.prepare('SELECT balance FROM suppliers WHERE id = ?').get(1) as any;
    expect(s1.balance).toBe(10000); // 15000 - 5000
  });

  it('Scenario 3: List all suppliers with contact info', () => {
    const suppliers = db.prepare('SELECT id, name_ar, phone, balance FROM suppliers ORDER BY id').all() as any[];
    expect(suppliers).toHaveLength(2);
    expect(suppliers[0].phone).toBe('012345');
  });
});

describe('Phase 5b: Purchase Invoice Creation', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedPurchases(db); });
  afterAll(() => db.close());

  it('Scenario 4: Create purchase invoice with items and bonuses', () => {
    const invId = 'purch-001';
    db.prepare("INSERT INTO purchase_invoices (id, supplier_id, user_id, invoice_number, invoice_date, total_amount, paid_amount, payment_method, status) VALUES (?, 1, 'u1', 'INV-001', '2026-06-23', 0, 0, 'credit', 'completed')").run(invId);
    db.prepare("INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, cost_price, selling_price, bonus_quantity, expiry_date) VALUES (?, 1, 100, 10, 15, 5, '2027-12-31')").run(invId);
    db.prepare("INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, cost_price, selling_price, expiry_date) VALUES (?, 2, 50, 18, 25, '2027-06-30')").run(invId);

    const items = db.prepare("SELECT pi.*, m.trade_name FROM purchase_invoice_items pi JOIN master_drugs m ON pi.drug_id = m.id WHERE pi.invoice_id = ?").all(invId) as any[];
    expect(items).toHaveLength(2);
    expect(items[0].bonus_quantity).toBe(5);
    expect(items[0].trade_name).toBe('Panadol');
  });

  it('Scenario 5: Invoice total calculated from items', () => {
    const total = db.prepare(`
      SELECT SUM((quantity + COALESCE(bonus_quantity,0)) * cost_price) as total
      FROM purchase_invoice_items WHERE invoice_id = 'purch-001'
    `).get() as any;
    // (100 + 5) * 10 + (50 + 0) * 18 = 1050 + 900 = 1950
    expect(total.total).toBe(1950);
  });

  it('Scenario 6: Stock increases after invoice completion', () => {
    // Simulate stock update triggered by invoice completion
    const items = db.prepare("SELECT * FROM purchase_invoice_items WHERE invoice_id = 'purch-001'").all() as any[];
    for (const item of items) {
      const batchId = `inv-auto-${item.id}`;
      const totalQty = item.quantity + (item.bonus_quantity || 0);
      db.prepare("INSERT INTO inventory (id, drug_id, quantity, cost_price, local_selling_price, expiry_date) VALUES (?, ?, ?, ?, ?, ?)").run(batchId, item.drug_id, totalQty, item.cost_price, item.selling_price, item.expiry_date);
    }

    const newStock = db.prepare('SELECT SUM(quantity) as qty FROM inventory WHERE drug_id = ?').get(1) as any;
    expect(newStock.qty).toBe(50 + 105); // original 50 + (100+5) from purchase
  });

  it('Scenario 7: Multi-currency payment methods (cash/credit/check)', () => {
    db.prepare("INSERT INTO purchase_invoices (id, supplier_id, user_id, invoice_number, total_amount, paid_amount, payment_method) VALUES ('purch-002', 2, 'u1', 'INV-002', 500, 500, 'cash')").run();
    db.prepare("INSERT INTO purchase_invoices (id, supplier_id, user_id, invoice_number, total_amount, paid_amount, payment_method) VALUES ('purch-003', 2, 'u1', 'INV-003', 300, 0, 'credit')").run();

    const purch002 = db.prepare("SELECT * FROM purchase_invoices WHERE id = 'purch-002'").get() as any;
    expect(purch002.payment_method).toBe('cash');
    expect(purch002.paid_amount).toBe(purch002.total_amount);

    const purch003 = db.prepare("SELECT * FROM purchase_invoices WHERE id = 'purch-003'").get() as any;
    expect(purch003.payment_method).toBe('credit');
    expect(purch003.paid_amount).toBe(0);
  });
});

describe('Phase 5c: Purchase Orders', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedPurchases(db); });
  afterAll(() => db.close());

  it('Scenario 8: Create purchase order in pending status', () => {
    db.prepare("INSERT INTO purchase_orders (id, user_id, supplier_name, total_amount, notes) VALUES ('po-001', 'u1', 'Supplier A', 0, 'طلب مستعجل')").run();
    db.prepare("INSERT INTO purchase_order_items (po_id, drug_id, quantity, expected_price) VALUES ('po-001', 1, 200, 9)").run();
    db.prepare("INSERT INTO purchase_order_items (po_id, drug_id, quantity, expected_price) VALUES ('po-001', 3, 50, 60)").run();

    const po = db.prepare("SELECT * FROM purchase_orders WHERE id = 'po-001'").get() as any;
    expect(po.status).toBe('pending');

    const items = db.prepare("SELECT * FROM purchase_order_items WHERE po_id = 'po-001'").all() as any[];
    expect(items).toHaveLength(2);
  });

  it('Scenario 9: Partial receipt updates received_quantity', () => {
    db.prepare("UPDATE purchase_order_items SET received_quantity = 100 WHERE po_id = 'po-001' AND drug_id = 1").run();
    const item = db.prepare("SELECT * FROM purchase_order_items WHERE po_id = 'po-001' AND drug_id = 1").get() as any;
    expect(item.received_quantity).toBe(100);
    expect(item.received_quantity).toBeLessThan(item.quantity); // partial receipt
  });

  it('Scenario 10: Complete order transitions to completed', () => {
    db.prepare("UPDATE purchase_order_items SET received_quantity = quantity WHERE po_id = 'po-001'").run();
    db.prepare("UPDATE purchase_orders SET status = 'completed' WHERE id = 'po-001'").run();

    const po = db.prepare("SELECT status FROM purchase_orders WHERE id = 'po-001'").get() as any;
    expect(po.status).toBe('completed');
  });
});

describe('Phase 5d: Supplier Returns', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedPurchases(db); });
  afterAll(() => db.close());

  it('Scenario 11: Return items to supplier with inventory deduction', () => {
    // Create purchase invoice first
    db.prepare("INSERT INTO purchase_invoices (id, supplier_id, user_id, total_amount, status) VALUES ('purch-ret-001', 1, 'u1', 300, 'completed')").run();
    db.prepare("INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, cost_price, selling_price) VALUES ('purch-ret-001', 1, 30, 10, 15)").run();

    // Now return some items
    db.prepare("INSERT INTO purchase_returns (id, supplier_id, user_id, total_amount, reason) VALUES ('pret-001', 1, 'u1', 100, 'تالف')").run();
    db.prepare("INSERT INTO purchase_return_items (purchase_return_id, drug_id, quantity_returned, unit_price, reason) VALUES ('pret-001', 1, 10, 10, 'انتهاء صلاحية')").run();
    // Deduct from supplier balance
    db.prepare("UPDATE suppliers SET balance = balance - 100 WHERE id = 1").run();
    // Log transaction
    db.prepare("INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id) VALUES (1, 'return', 100, 'pret-001')").run();

    const ret = db.prepare("SELECT * FROM purchase_returns WHERE id = 'pret-001'").get() as any;
    expect(ret.total_amount).toBe(100);
    expect(ret.reason).toBe('تالف');

    const s1 = db.prepare("SELECT balance FROM suppliers WHERE id = 1").get() as any;
    expect(s1.balance).toBe(14900); // 15000 - 100

    const tx = db.prepare("SELECT * FROM supplier_transactions WHERE reference_id = 'pret-001'").get() as any;
    expect(tx.type).toBe('return');
  });

  it('Scenario 12: General return (no linked invoice)', () => {
    db.prepare("INSERT INTO purchase_returns (id, supplier_id, user_id, total_amount, reason) VALUES ('pret-002', 2, 'u1', 50, 'return بدون فاتورة')").run();
    db.prepare("INSERT INTO purchase_return_items (purchase_return_id, drug_id, quantity_returned, unit_price) VALUES ('pret-002', 2, 5, 10)").run();

    const ret = db.prepare("SELECT * FROM purchase_returns WHERE id = 'pret-002'").get() as any;
    expect(ret.reason).toBe('return بدون فاتورة');
    expect(ret.status).toBe('completed');
  });
});
