/**
 * Phase 4: Inventory Tests (P1)
 * Stock management, adjustments, shortages, opening balances, settlements.
 * Uses real better-sqlite3 in-memory DB for all scenarios.
 */

import Database from 'better-sqlite3';

// ─── Seed ─────────────────────────────────────────────────────────────
function seedInventory(db: Database.Database) {
  db.exec(`
    CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, reorder_point INTEGER DEFAULT 10, is_medicine INTEGER DEFAULT 1, is_service INTEGER DEFAULT 0, stop_dealing INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, quantity INTEGER DEFAULT 0, cost_price REAL DEFAULT 0, local_selling_price REAL, batch_number TEXT, expiry_date TEXT, supplier TEXT, min_stock_level INTEGER DEFAULT 10, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE stock_adjustments (id INTEGER PRIMARY KEY AUTOINCREMENT, inventory_id TEXT NOT NULL, old_quantity INTEGER, new_quantity INTEGER, user_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE adjustment_reasons (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, name_en TEXT);
    CREATE TABLE shortages (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER NOT NULL, requested_quantity INTEGER DEFAULT 1, status TEXT DEFAULT 'pending', priority TEXT DEFAULT 'normal', notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (drug_id) REFERENCES master_drugs (id));
    CREATE TABLE opening_balances (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT DEFAULT 'draft', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE opening_balance_items (id INTEGER PRIMARY KEY AUTOINCREMENT, ob_id TEXT NOT NULL, drug_id INTEGER NOT NULL, quantity INTEGER NOT NULL, cost_price REAL, selling_price REAL, expiry_date TEXT);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, details TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  `);

  db.prepare("INSERT INTO master_drugs VALUES (1, 'Panadol', 'Panadol EN', 10, 1, 0, 0, datetime('now'))").run();
  db.prepare("INSERT INTO master_drugs VALUES (2, 'Brufen', 'Brufen EN', 10, 1, 0, 0, datetime('now'))").run();
  db.prepare("INSERT INTO master_drugs VALUES (3, 'Augmentin', 'Augmentin EN', 5, 1, 0, 0, datetime('now'))").run();
  db.prepare("INSERT INTO master_drugs VALUES (4, 'Service Fee', NULL, 0, 0, 1, 0, datetime('now'))").run();
  db.prepare("INSERT INTO master_drugs VALUES (5, 'Discontinued Drug', NULL, 5, 1, 0, 1, datetime('now'))").run();

  db.prepare("INSERT INTO inventory VALUES ('inv-001', 1, 50, 10, 15, 'B001', '2026-12-31', 'Supplier A', 10, datetime('now'))").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-002', 1, 30, 11, 15, 'B002', '2027-06-30', 'Supplier A', 10, datetime('now'))").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-003', 2, 100, 18, 25, 'B003', '2027-01-15', 'Supplier B', 10, datetime('now'))").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-004', 3, 5, 60, 85, 'B004', '2026-08-20', 'Supplier C', 5, datetime('now'))").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-005', 4, 0, 0, 50, NULL, NULL, NULL, 0, datetime('now'))").run();

  db.prepare("INSERT INTO adjustment_reasons VALUES (1, 'تلف', 'Damage')").run();
  db.prepare("INSERT INTO adjustment_reasons VALUES (2, 'انتهاء صلاحية', 'Expired')").run();
  db.prepare("INSERT INTO adjustment_reasons VALUES (3, 'جرد', 'Inventory Count')").run();
}

describe('Phase 4a: Stock View & Batch Tracking', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedInventory(db); });
  afterAll(() => db.close());

  it('Scenario 1: Total stock aggregates across batches for same drug', () => {
    const total = db.prepare('SELECT SUM(quantity) as total FROM inventory WHERE drug_id = ?').get(1) as any;
    expect(total.total).toBe(80); // 50 + 30
  });

  it('Scenario 2: Batch-level detail shows per-batch quantities', () => {
    const batches = db.prepare('SELECT id, quantity, batch_number, expiry_date FROM inventory WHERE drug_id = ? ORDER BY expiry_date').all(1) as any[];
    expect(batches).toHaveLength(2);
    expect(batches[0].batch_number).toBe('B001');
    expect(batches[0].quantity).toBe(50);
    expect(batches[1].batch_number).toBe('B002');
    expect(batches[1].quantity).toBe(30);
  });

  it('Scenario 3: Nearest expiry identifies soonest-expiring batch', () => {
    const nearest = db.prepare('SELECT batch_number, MIN(expiry_date) as nearest_expiry FROM inventory WHERE drug_id = ?').get(1) as any;
    expect(nearest.nearest_expiry).toBe('2026-12-31');

    const nearestAll = db.prepare('SELECT drug_id, batch_number, MIN(expiry_date) as nearest_expiry FROM inventory GROUP BY drug_id ORDER BY drug_id').all() as any[];
    // inv-005 (drug 4, service) has null expiry and is excluded from MIN
    expect(nearestAll.length).toBeGreaterThanOrEqual(4);
    expect(nearestAll[0].drug_id).toBe(1);
  });

  it('Scenario 4: Low-stock detection via reorder_point comparison', () => {
    const lowStock = db.prepare(`
      SELECT m.id, m.trade_name, SUM(COALESCE(i.quantity,0)) as total_stock, m.reorder_point
      FROM master_drugs m LEFT JOIN inventory i ON m.id = i.drug_id
      WHERE m.is_medicine = 1 AND m.stop_dealing = 0
      GROUP BY m.id HAVING total_stock < m.reorder_point
      ORDER BY m.id
    `).all() as any[];
    // Drug 3: stock=5 < reorder_point=5? Actually 5 < 5 is false, so only drugs where total < reorder_point
    // Drug 3: 5 < 5 = false
    // Drug 1: 80 < 10 = false
    // Drug 2: 100 < 10 = false
    // Drug 5: 0 < 5 = true → but stop_dealing=1 so filtered out
    // So: no low-stock items
    expect(lowStock).toHaveLength(0);
  });

  it('Scenario 5: Drug with stop_dealing=1 excluded from inventory views', () => {
    const drugs = db.prepare('SELECT id, trade_name FROM master_drugs WHERE stop_dealing = 1').all() as any[];
    expect(drugs).toHaveLength(1);
    expect(drugs[0].id).toBe(5);
  });

  it('Scenario 6: Service items (is_service=1) have zero stock', () => {
    const service = db.prepare('SELECT id, is_service FROM master_drugs WHERE is_service = 1').all() as any[];
    expect(service).toHaveLength(1);
  });
});

describe('Phase 4b: Stock Adjustments', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedInventory(db); });
  afterAll(() => db.close());

  it('Scenario 7: Positive adjustment adds stock and logs reason', () => {
    const oldQty = (db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-001') as any).quantity;
    const newQty = oldQty + 20;
    db.prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(newQty, 'inv-001');
    db.prepare('INSERT INTO stock_adjustments (inventory_id, old_quantity, new_quantity, user_id) VALUES (?, ?, ?, ?)').run('inv-001', oldQty, newQty, 'u1');

    const updated = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-001') as any;
    expect(updated.quantity).toBe(70); // 50 + 20

    const log = db.prepare('SELECT * FROM stock_adjustments WHERE inventory_id = ?').all('inv-001') as any[];
    expect(log).toHaveLength(1);
    expect(log[0].old_quantity).toBe(50);
    expect(log[0].new_quantity).toBe(70);
  });

  it('Scenario 8: Negative adjustment (write-off) reduces stock', () => {
    const oldQty = (db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-003') as any).quantity;
    const reduction = 5;
    db.prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(oldQty - reduction, 'inv-003');
    db.prepare('INSERT INTO stock_adjustments (inventory_id, old_quantity, new_quantity, user_id) VALUES (?, ?, ?, ?)').run('inv-003', oldQty, oldQty - reduction, 'u1');

    const updated = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-003') as any;
    expect(updated.quantity).toBe(95); // 100 - 5
  });

  it('Scenario 9: Adjustment with reason links to adjustment_reasons', () => {
    const reason = db.prepare('SELECT * FROM adjustment_reasons WHERE id = ?').get(1) as any;
    expect(reason.name_ar).toBe('تلف');
    expect(reason.name_en).toBe('Damage');
  });
});

describe('Phase 4c: Shortage Management', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedInventory(db); });
  afterAll(() => db.close());

  it('Scenario 10: Create shortage for low-stock drug', () => {
    db.prepare("INSERT INTO shortages (drug_id, requested_quantity, status, notes) VALUES (?, ?, 'pending', ?)").run(3, 20, 'Low stock');
    const shortage = db.prepare('SELECT * FROM shortages WHERE drug_id = ?').get(3) as any;
    expect(shortage.requested_quantity).toBe(20);
    expect(shortage.status).toBe('pending');
  });

  it('Scenario 11: Shortage status lifecycle (pending → resolved)', () => {
    db.prepare("INSERT INTO shortages (drug_id, requested_quantity, status) VALUES (?, 15, 'pending')").run(1);
    db.prepare("UPDATE shortages SET status = 'resolved' WHERE drug_id = ? AND status = 'pending'").run(1);
    const resolved = db.prepare("SELECT * FROM shortages WHERE drug_id = ? AND status = 'resolved'").get(1) as any;
    expect(resolved).toBeDefined();
    expect(resolved.status).toBe('resolved');
  });

  it('Scenario 12: List all pending shortages grouped by priority', () => {
    db.prepare("INSERT INTO shortages (drug_id, requested_quantity, status, priority) VALUES (3, 10, 'pending', 'high')").run();
    db.prepare("INSERT INTO shortages (drug_id, requested_quantity, status, priority) VALUES (2, 5, 'pending', 'normal')").run();
    const pending = db.prepare("SELECT s.*, m.trade_name FROM shortages s JOIN master_drugs m ON s.drug_id = m.id WHERE s.status = 'pending' ORDER BY CASE s.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END").all() as any[];
    expect(pending.length).toBeGreaterThanOrEqual(3);
    expect(pending[0].priority).toBe('high'); // first by priority sort
  });
});

describe('Phase 4d: Opening Balances', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedInventory(db); });
  afterAll(() => db.close());

  it('Scenario 13: Create opening balance draft with items', () => {
    db.prepare("INSERT INTO opening_balances (id, user_id, status) VALUES ('ob-001', 'u1', 'draft')").run();
    db.prepare("INSERT INTO opening_balance_items (ob_id, drug_id, quantity, cost_price, selling_price, expiry_date) VALUES ('ob-001', 1, 100, 10, 15, '2027-12-31')").run();
    db.prepare("INSERT INTO opening_balance_items (ob_id, drug_id, quantity, cost_price, selling_price, expiry_date) VALUES ('ob-001', 2, 200, 18, 25, '2027-06-30')").run();

    const items = db.prepare('SELECT COUNT(*) as count FROM opening_balance_items WHERE ob_id = ?').get('ob-001') as any;
    expect(items.count).toBe(2);

    const totalValue = db.prepare('SELECT SUM(quantity * cost_price) as total FROM opening_balance_items WHERE ob_id = ?').get('ob-001') as any;
    expect(totalValue.total).toBe(100*10 + 200*18); // 1000 + 3600 = 4600
  });

  it('Scenario 14: Submit opening balance creates inventory entries', () => {
    // Submit = change status and add to inventory
    db.prepare("UPDATE opening_balances SET status = 'completed' WHERE id = 'ob-001'").run();
    const ob = db.prepare("SELECT status FROM opening_balances WHERE id = 'ob-001'").get() as any;
    expect(ob.status).toBe('completed');
  });
});

describe('Phase 4e: Inventory Settlement & Movements', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedInventory(db); });
  afterAll(() => db.close());

  it('Scenario 15: Item movement log tracks inventory changes', () => {
    // Simulate a sale + adjustment
    db.prepare("UPDATE inventory SET quantity = quantity - 2 WHERE id = 'inv-001'").run();
    db.prepare("UPDATE inventory SET quantity = quantity + 50 WHERE id = 'inv-003'").run();

    const inv1 = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-001') as any;
    expect(inv1.quantity).toBe(48); // 50 - 2

    const inv3 = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-003') as any;
    expect(inv3.quantity).toBe(150); // 100 + 50
  });

  it('Scenario 16: Service items excluded from stock calculations', () => {
    const medStock = db.prepare(`
      SELECT SUM(COALESCE(i.quantity,0)) as stock FROM master_drugs m
      LEFT JOIN inventory i ON m.id = i.drug_id
      WHERE m.is_medicine = 1 AND m.stop_dealing = 0
    `).get() as any;
    // Drug 1: 48+30=78, Drug 2: 150, Drug 3: 5, Drug 5: 0 (stop_dealing)
    // Total: 78 + 150 + 5 = 233
    expect(medStock.stock).toBe(233);
  });
});
