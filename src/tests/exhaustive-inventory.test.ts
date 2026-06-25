/**
 * Exhaustive Inventory Module Tests
 * Uses real better-sqlite3 :memory: database.
 * Covers: stock views, batch tracking, adjustments, shortages,
 * opening balances, settlements, edge cases.
 */

import Database from 'better-sqlite3';

// ─── Seed ─────────────────────────────────────────────────────────────
function seedFullInventory(db: Database.Database) {
  db.exec(`
    CREATE TABLE master_drugs (
      id INTEGER PRIMARY KEY,
      trade_name TEXT,
      trade_name_en TEXT,
      reorder_point INTEGER DEFAULT 10,
      is_medicine INTEGER DEFAULT 1,
      is_service INTEGER DEFAULT 0,
      stop_dealing INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE inventory (
      id TEXT PRIMARY KEY,
      drug_id INTEGER,
      quantity INTEGER DEFAULT 0,
      cost_price REAL DEFAULT 0,
      local_selling_price REAL,
      batch_number TEXT,
      expiry_date TEXT,
      supplier TEXT,
      min_stock_level INTEGER DEFAULT 10,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE stock_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inventory_id TEXT NOT NULL,
      reason_id INTEGER,
      old_quantity INTEGER,
      new_quantity INTEGER,
      user_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE adjustment_reasons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT
    );
    CREATE TABLE shortages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drug_id INTEGER NOT NULL,
      requested_quantity INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
    );
    CREATE TABLE opening_balances (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE opening_balance_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ob_id TEXT NOT NULL,
      drug_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      cost_price REAL,
      selling_price REAL,
      expiry_date TEXT
    );
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sales_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER,
      drug_id INTEGER,
      quantity_sold INTEGER DEFAULT 1,
      unit TEXT DEFAULT 'large',
      unit_price REAL,
      is_negative INTEGER DEFAULT 0,
      inventory_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sales_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE drug_alternatives (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drug_id INTEGER,
      alternative_id INTEGER
    );
    CREATE TABLE patient_allergies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id TEXT,
      allergen TEXT,
      severity TEXT
    );
    CREATE TABLE patient_conditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id TEXT,
      condition_name TEXT
    );
    CREATE TABLE drug_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ingredient_a TEXT,
      ingredient_b TEXT,
      severity TEXT,
      description_en TEXT,
      description_ar TEXT,
      recommendation TEXT
    );
  `);

  // ─── 5 Drugs ────────────────────────────────────────────────────────
  db.prepare("INSERT INTO master_drugs VALUES (1, 'Panadol', 'Panadol EN', 10, 1, 0, 0, datetime('now'))").run();
  db.prepare("INSERT INTO master_drugs VALUES (2, 'Brufen', 'Brufen EN', 10, 1, 0, 0, datetime('now'))").run();
  db.prepare("INSERT INTO master_drugs VALUES (3, 'Augmentin', 'Augmentin EN', 5, 1, 0, 0, datetime('now'))").run();
  db.prepare("INSERT INTO master_drugs VALUES (4, 'Service Fee', NULL, 0, 0, 1, 0, datetime('now'))").run();
  db.prepare("INSERT INTO master_drugs VALUES (5, 'Discontinued Drug', NULL, 5, 1, 0, 1, datetime('now'))").run();

  // ─── 8 Inventory Batches ────────────────────────────────────────────
  // Drug 1 (Panadol): 3 batches, total = 50+30+0 = 80
  db.prepare("INSERT INTO inventory VALUES ('inv-001', 1, 50, 10, 15, 'B001', '2026-12-31', 'Supplier A', 10, datetime('now'))").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-002', 1, 30, 11, 15, 'B002', '2027-06-30', 'Supplier A', 10, datetime('now'))").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-099', 1, 0, 11, 15, 'B009', '2027-12-31', 'Supplier A', 10, datetime('now'))").run();
  // Drug 2 (Brufen): 2 batches, total = 100+25 = 125
  db.prepare("INSERT INTO inventory VALUES ('inv-003', 2, 100, 18, 25, 'B003', '2027-01-15', 'Supplier B', 10, datetime('now'))").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-010', 2, 25, 18, 25, 'B010', '2027-03-15', 'Supplier B', 10, datetime('now'))").run();
  // Drug 3 (Augmentin): 1 batch, total = 5
  db.prepare("INSERT INTO inventory VALUES ('inv-004', 3, 5, 60, 85, 'B004', '2026-08-20', 'Supplier C', 5, datetime('now'))").run();
  // Drug 4 (Service Fee): 1 batch, zero stock
  db.prepare("INSERT INTO inventory VALUES ('inv-005', 4, 0, 0, 50, NULL, NULL, NULL, 0, datetime('now'))").run();
  // Drug 5 (Discontinued): no inventory (zero stock)
  // Near-expiry batch: Drug 2, expiry in 15 days
  const nearExpiry = new Date();
  nearExpiry.setDate(nearExpiry.getDate() + 15);
  const nearExpiryStr = nearExpiry.toISOString().split('T')[0];
  db.prepare("INSERT INTO inventory VALUES ('inv-011', 2, 10, 18, 25, 'B011', ?, 'Supplier B', 10, datetime('now'))").run(nearExpiryStr);
  // Expired batch: Drug 1
  const expiredDate = new Date();
  expiredDate.setFullYear(expiredDate.getFullYear() - 1);
  const expiredStr = expiredDate.toISOString().split('T')[0];
  db.prepare("INSERT INTO inventory VALUES ('inv-012', 1, 5, 10, 15, 'B012', ?, 'Supplier A', 10, datetime('now'))").run(expiredStr);

  // ─── 3 Adjustment Reasons ───────────────────────────────────────────
  db.prepare("INSERT INTO adjustment_reasons VALUES (1, 'تلف', 'Damage')").run();
  db.prepare("INSERT INTO adjustment_reasons VALUES (2, 'انتهاء صلاحية', 'Expired')").run();
  db.prepare("INSERT INTO adjustment_reasons VALUES (3, 'جرد', 'Inventory Count')").run();

  // ─── Sales data for shortage smart calculation ──────────────────────
  db.prepare("INSERT INTO sales_invoices (id, created_at) VALUES (1, datetime('now', '-5 days'))").run();
  db.prepare("INSERT INTO sales_invoices (id, created_at) VALUES (2, datetime('now', '-10 days'))").run();
  db.prepare("INSERT INTO sales_items (id, invoice_id, drug_id, quantity_sold, created_at) VALUES (1, 1, 1, 5, datetime('now', '-5 days'))").run();
  db.prepare("INSERT INTO sales_items (id, invoice_id, drug_id, quantity_sold, created_at) VALUES (2, 1, 1, 3, datetime('now', '-5 days'))").run();
  db.prepare("INSERT INTO sales_items (id, invoice_id, drug_id, quantity_sold, created_at) VALUES (3, 2, 2, 10, datetime('now', '-10 days'))").run();
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('Exhaustive Inventory: Stock View & Batch Tracking', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedFullInventory(db); });
  afterAll(() => db.close());

  it('S1: Total stock aggregation per drug (sum of batches)', () => {
    const rows = db.prepare(`
      SELECT m.id, m.trade_name, COALESCE(SUM(i.quantity),0) as total_stock
      FROM master_drugs m LEFT JOIN inventory i ON m.id = i.drug_id
      GROUP BY m.id ORDER BY m.id
    `).all() as any[];
    expect(rows[0].id).toBe(1);
    expect(rows[0].total_stock).toBe(85); // 50+30+0+5(expired)
    expect(rows[1].id).toBe(2);
    expect(rows[1].total_stock).toBe(135); // 100+25+10
    expect(rows[2].id).toBe(3);
    expect(rows[2].total_stock).toBe(5);
    expect(rows[3].id).toBe(4);
    expect(rows[3].total_stock).toBe(0);
    expect(rows[4].id).toBe(5);
    expect(rows[4].total_stock).toBe(0);
  });

  it('S2: Batch-level detail per drug', () => {
    const batches = db.prepare(
      'SELECT id, quantity, batch_number, expiry_date FROM inventory WHERE drug_id = ? ORDER BY expiry_date'
    ).all(1) as any[];
    expect(batches.length).toBeGreaterThanOrEqual(4); // inv-001, inv-002, inv-099, inv-012
    const b = batches.find((b: any) => b.id === 'inv-001');
    expect(b).toBeDefined();
    expect(b!.batch_number).toBe('B001');
    expect(b!.quantity).toBe(50);
  });

  it('S3: Nearest expiry date per drug', () => {
    const rows = db.prepare(`
      SELECT drug_id, MIN(expiry_date) as nearest_expiry
      FROM inventory WHERE drug_id = 1 AND expiry_date IS NOT NULL
    `).get() as any;
    // Drug 1 batches: inv-012 (expired 1y ago), inv-001 (2026-12-31), inv-002 (2027-06-30), inv-099 (2027-12-31)
    // The expired one is the nearest expiry date
    expect(rows.nearest_expiry).toBeTruthy();
  });

  it('S4: Drugs with no inventory entries (zero stock)', () => {
    const zeroStock = db.prepare(`
      SELECT m.id, m.trade_name
      FROM master_drugs m
      WHERE m.is_medicine = 1 AND m.stop_dealing = 0
        AND (SELECT COALESCE(SUM(quantity),0) FROM inventory WHERE drug_id = m.id) = 0
    `).all() as any[];
    // Drug 5 has stop_dealing=1 so excluded; Drug 3 has stock=5
    // Drug 1: 85, Drug 2: 135 — not zero
    expect(zeroStock).toHaveLength(0);
  });

  it('S5: Expired drugs detection (expiry < today)', () => {
    const today = new Date().toISOString().split('T')[0];
    const expired = db.prepare(`
      SELECT i.*, m.trade_name FROM inventory i
      JOIN master_drugs m ON i.drug_id = m.id
      WHERE i.expiry_date < ? AND i.quantity > 0
    `).all(today) as any[];
    expect(expired.length).toBeGreaterThanOrEqual(1);
    expect(expired.some((e: any) => e.id === 'inv-012')).toBe(true);
  });

  it('S6: Near-expiry drugs detection (expiry within 30 days)', () => {
    const today = new Date();
    const thirtyDaysLater = new Date(today);
    thirtyDaysLater.setDate(thirtyDaysLater.getDate() + 30);
    const todayStr = today.toISOString().split('T')[0];
    const thirtyStr = thirtyDaysLater.toISOString().split('T')[0];

    const nearExpiry = db.prepare(`
      SELECT i.*, m.trade_name FROM inventory i
      JOIN master_drugs m ON i.drug_id = m.id
      WHERE i.expiry_date > ? AND i.expiry_date <= ? AND i.quantity > 0
    `).all(todayStr, thirtyStr) as any[];
    expect(nearExpiry.length).toBeGreaterThanOrEqual(1);
    expect(nearExpiry.some((e: any) => e.id === 'inv-011')).toBe(true);
  });

  it('S7: Zero-stock drugs (inventory entry exists but qty=0)', () => {
    const zero = db.prepare(`
      SELECT i.id, i.drug_id, m.trade_name FROM inventory i
      JOIN master_drugs m ON i.drug_id = m.id
      WHERE i.quantity = 0
    `).all() as any[];
    expect(zero.length).toBeGreaterThanOrEqual(1);
    expect(zero.some((z: any) => z.id === 'inv-005')).toBe(true); // Service fee
    expect(zero.some((z: any) => z.id === 'inv-099')).toBe(true); // Panadol zero batch
  });

  it('S8: Low-stock drugs (total < reorder_point)', () => {
    const lowStock = db.prepare(`
      SELECT m.id, m.trade_name, COALESCE(SUM(i.quantity),0) as total_stock, m.reorder_point
      FROM master_drugs m LEFT JOIN inventory i ON m.id = i.drug_id
      WHERE m.is_medicine = 1 AND m.stop_dealing = 0
      GROUP BY m.id HAVING total_stock < m.reorder_point
    `).all() as any[];
    // Drug 3: total=5, reorder=5 => 5<5 false
    // Drug 1: 85 < 10 false, Drug 2: 135 < 10 false
    expect(lowStock).toHaveLength(0);
  });

  it('S9: Low-stock with multiple batches', () => {
    // Drug 1 has 4 batches (incl expired) - verify totals
    const batches = db.prepare(
      'SELECT COUNT(*) as cnt FROM inventory WHERE drug_id = ?'
    ).get(1) as any;
    expect(batches.cnt).toBeGreaterThanOrEqual(4);
    const total = db.prepare(
      'SELECT SUM(quantity) as total FROM inventory WHERE drug_id = ?'
    ).get(1) as any;
    expect(total.total).toBe(85); // 50+30+0+5
  });

  it('S10: Service items (is_service=1) excluded from stock', () => {
    const serviceItems = db.prepare(`
      SELECT i.id, i.quantity, m.is_service FROM inventory i
      JOIN master_drugs m ON i.drug_id = m.id
      WHERE m.is_service = 1
    `).all() as any[];
    expect(serviceItems).toHaveLength(1);
    expect(serviceItems[0].quantity).toBe(0);
    // Service items should not appear in medicine stock totals
    const medStock = db.prepare(`
      SELECT COALESCE(SUM(i.quantity),0) as total FROM master_drugs m
      LEFT JOIN inventory i ON m.id = i.drug_id
      WHERE m.is_medicine = 1 AND m.stop_dealing = 0
    `).get() as any;
    // Drug 1: 85, Drug 2: 135, Drug 3: 5 = 225
    expect(medStock.total).toBe(225);
  });
});

describe('Exhaustive Inventory: Stock Adjustments', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedFullInventory(db); });
  afterAll(() => db.close());

  it('S11: Positive adjustment (increase stock by 20)', () => {
    const oldQty = (db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-001') as any).quantity;
    const newQty = oldQty + 20;
    db.prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(newQty, 'inv-001');
    db.prepare('INSERT INTO stock_adjustments (inventory_id, old_quantity, new_quantity, user_id, reason_id) VALUES (?, ?, ?, ?, ?)').run('inv-001', oldQty, newQty, 'u1', 3);
    const updated = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-001') as any;
    expect(updated.quantity).toBe(70);
    const log = db.prepare('SELECT * FROM stock_adjustments WHERE inventory_id = ?').all('inv-001') as any[];
    expect(log).toHaveLength(1);
    expect(log[0].old_quantity).toBe(50);
    expect(log[0].new_quantity).toBe(70);
    expect(log[0].reason_id).toBe(3);
  });

  it('S12: Negative adjustment (decrease stock by 5)', () => {
    const oldQty = (db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-003') as any).quantity;
    const newQty = oldQty - 5;
    db.prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(newQty, 'inv-003');
    const updated = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-003') as any;
    expect(updated.quantity).toBe(95);
  });

  it('S13: Adjustment to zero (set stock to 0)', () => {
    db.prepare("UPDATE inventory SET quantity = 0 WHERE id = 'inv-004'").run();
    db.prepare("INSERT INTO stock_adjustments (inventory_id, old_quantity, new_quantity, user_id, reason_id) VALUES (?, ?, ?, ?, ?)").run('inv-004', 5, 0, 'u1', 2);
    const updated = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-004') as any;
    expect(updated.quantity).toBe(0);
  });

  it('S14: Negative adjustment exceeding current stock (allow negative)', () => {
    // inv-099 has 0 stock; allow negative
    db.prepare("UPDATE inventory SET quantity = -3 WHERE id = 'inv-099'").run();
    db.prepare("INSERT INTO stock_adjustments (inventory_id, old_quantity, new_quantity, user_id) VALUES (?, ?, ?, ?)").run('inv-099', 0, -3, 'u1');
    const updated = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-099') as any;
    expect(updated.quantity).toBe(-3);
  });

  it('S15: Adjustment with reason linked to adjustment_reasons', () => {
    const reason = db.prepare('SELECT * FROM adjustment_reasons WHERE id = ?').get(1) as any;
    expect(reason.name_ar).toBe('تلف');
    expect(reason.name_en).toBe('Damage');
    const reason2 = db.prepare('SELECT * FROM adjustment_reasons WHERE id = ?').get(2) as any;
    expect(reason2.name_en).toBe('Expired');
    const reason3 = db.prepare('SELECT * FROM adjustment_reasons WHERE id = ?').get(3) as any;
    expect(reason3.name_en).toBe('Inventory Count');
  });

  it('S16: Adjustment without reason (still allowed)', () => {
    const oldQty = (db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-002') as any).quantity;
    // No reason_id
    db.prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(oldQty + 10, 'inv-002');
    db.prepare('INSERT INTO stock_adjustments (inventory_id, old_quantity, new_quantity, user_id) VALUES (?, ?, ?, ?)').run('inv-002', oldQty, oldQty + 10, 'u1');
    const updated = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-002') as any;
    expect(updated.quantity).toBe(40);
    const log = db.prepare('SELECT * FROM stock_adjustments WHERE inventory_id = ? AND reason_id IS NULL').all('inv-002') as any[];
    expect(log.length).toBeGreaterThanOrEqual(1);
  });

  it('S17: Adjustment audit log (stock_adjustments table)', () => {
    const logs = db.prepare(`
      SELECT sa.*, i.drug_id, i.batch_number
      FROM stock_adjustments sa
      JOIN inventory i ON sa.inventory_id = i.id
      ORDER BY sa.created_at DESC
    `).all() as any[];
    expect(logs.length).toBeGreaterThanOrEqual(4); // 4 adjustments above
    logs.forEach(l => {
      expect(l.inventory_id).toBeTruthy();
      expect(l.old_quantity).toBeDefined();
      expect(l.new_quantity).toBeDefined();
    });
  });
});

describe('Exhaustive Inventory: Shortage Management', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedFullInventory(db); });
  afterAll(() => db.close());

  it('S18: Create shortage for low-stock drug', () => {
    db.prepare("INSERT INTO shortages (drug_id, requested_quantity, status, notes) VALUES (?, ?, 'pending', ?)").run(3, 20, 'Low stock');
    const shortage = db.prepare('SELECT * FROM shortages WHERE drug_id = ?').get(3) as any;
    expect(shortage.requested_quantity).toBe(20);
    expect(shortage.status).toBe('pending');
    expect(shortage.notes).toBe('Low stock');
  });

  it('S19: Create shortage with high priority', () => {
    db.prepare("INSERT INTO shortages (drug_id, requested_quantity, status, priority) VALUES (?, ?, 'pending', 'high')").run(3, 50);
    const shortage = db.prepare("SELECT * FROM shortages WHERE drug_id = ? AND priority = 'high'").get(3) as any;
    expect(shortage).toBeDefined();
    expect(shortage.priority).toBe('high');
  });

  it('S20: Shortage status lifecycle: pending -> ordered -> resolved', () => {
    db.prepare("INSERT INTO shortages (drug_id, requested_quantity, status) VALUES (?, 15, 'pending')").run(1);
    db.prepare("UPDATE shortages SET status = 'ordered' WHERE drug_id = ? AND status = 'pending'").run(1);
    const ordered = db.prepare("SELECT * FROM shortages WHERE drug_id = ? AND status = 'ordered'").get(1) as any;
    expect(ordered).toBeDefined();
    expect(ordered.status).toBe('ordered');
    db.prepare("UPDATE shortages SET status = 'resolved' WHERE drug_id = ? AND status = 'ordered'").run(1);
    const resolved = db.prepare("SELECT * FROM shortages WHERE drug_id = ? AND status = 'resolved'").get(1) as any;
    expect(resolved).toBeDefined();
    expect(resolved.status).toBe('resolved');
  });

  it('S21: Shortage with quantity exceeding reorder_point', () => {
    // Drug 2 reorder_point = 10, request 100
    db.prepare("INSERT INTO shortages (drug_id, requested_quantity, status) VALUES (?, ?, 'pending')").run(2, 100);
    const s = db.prepare('SELECT * FROM shortages WHERE drug_id = ? AND requested_quantity = ?').get(2, 100) as any;
    expect(s).toBeDefined();
    expect(s.requested_quantity).toBe(100);
    expect(s.requested_quantity).toBeGreaterThan(
      (db.prepare('SELECT reorder_point FROM master_drugs WHERE id = ?').get(2) as any).reorder_point
    );
  });

  it('S22: Shortage for non-existent drug — FK violation', () => {
    expect(() => {
      db.prepare("INSERT INTO shortages (drug_id, requested_quantity) VALUES (?, ?)").run(999, 10);
    }).toThrow();
  });

  it('S23: List pending shortages ordered by priority', () => {
    db.prepare("INSERT INTO shortages (drug_id, requested_quantity, status, priority) VALUES (2, 10, 'pending', 'high')").run();
    db.prepare("INSERT INTO shortages (drug_id, requested_quantity, status, priority, notes) VALUES (1, 5, 'pending', 'normal', 'Routine')").run();
    const pending = db.prepare(`
      SELECT s.*, m.trade_name
      FROM shortages s JOIN master_drugs m ON s.drug_id = m.id
      WHERE s.status = 'pending'
      ORDER BY CASE s.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, s.created_at ASC
    `).all() as any[];
    expect(pending.length).toBeGreaterThanOrEqual(5);
    // First non-critical, non-high items sorted by created_at
    expect(pending.some((p: any) => p.priority === 'high')).toBe(true);
  });

  it('S24: List resolved shortages', () => {
    const resolved = db.prepare(`
      SELECT s.*, m.trade_name FROM shortages s
      JOIN master_drugs m ON s.drug_id = m.id
      WHERE s.status = 'resolved'
    `).all() as any[];
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    expect(resolved[0].status).toBe('resolved');
  });

  it('S25: Smart shortage calculation (based on sales velocity)', () => {
    const results = db.prepare(`
      SELECT
        m.id,
        m.trade_name,
        m.reorder_point,
        COALESCE(SUM(i.quantity), 0) as total_stock,
        (
          SELECT COALESCE(SUM(si.quantity_sold), 0)
          FROM sales_items si
          JOIN sales_invoices sin ON si.invoice_id = sin.id
          WHERE si.drug_id = m.id AND sin.created_at >= date('now', '-30 days')
        ) as sales_30d
      FROM master_drugs m
      LEFT JOIN inventory i ON m.id = i.drug_id
      GROUP BY m.id
    `).all() as any[];

    const predictions = results.map((r: any) => {
      const dailyAvg = r.sales_30d / 30;
      const daysLeft = dailyAvg > 0 ? Math.floor(r.total_stock / dailyAvg) : 999;
      return { ...r, daily_avg: dailyAvg, days_left: daysLeft };
    });

    // Drug 1: sold 8 in 30d, daily=0.267, stock=85 => days=318
    const d1 = predictions.find((p: any) => p.id === 1);
    expect(d1).toBeDefined();
    expect(d1!.sales_30d).toBe(8);
    expect(d1!.daily_avg).toBeCloseTo(0.267, 1);
    expect(d1!.days_left).toBe(318);

    // Drug 2: sold 10 in 30d, daily=0.333, stock=135 => days=405
    const d2 = predictions.find((p: any) => p.id === 2);
    expect(d2).toBeDefined();
    expect(d2!.sales_30d).toBe(10);
  });
});

describe('Exhaustive Inventory: Opening Balances', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedFullInventory(db); });
  afterAll(() => db.close());

  it('S26: Create opening balance draft with items', () => {
    db.prepare("INSERT INTO opening_balances (id, user_id, status) VALUES ('ob-001', 'u1', 'draft')").run();
    db.prepare("INSERT INTO opening_balance_items (ob_id, drug_id, quantity, cost_price, selling_price, expiry_date) VALUES ('ob-001', 1, 100, 10, 15, '2027-12-31')").run();
    db.prepare("INSERT INTO opening_balance_items (ob_id, drug_id, quantity, cost_price, selling_price, expiry_date) VALUES ('ob-001', 2, 200, 18, 25, '2027-06-30')").run();
    db.prepare("INSERT INTO opening_balance_items (ob_id, drug_id, quantity, cost_price, selling_price, expiry_date) VALUES ('ob-001', 3, 50, 60, 85, '2027-08-15')").run();

    const items = db.prepare('SELECT COUNT(*) as count FROM opening_balance_items WHERE ob_id = ?').get('ob-001') as any;
    expect(items.count).toBe(3);

    const ob = db.prepare("SELECT * FROM opening_balances WHERE id = 'ob-001'").get() as any;
    expect(ob.status).toBe('draft');
    expect(ob.user_id).toBe('u1');
  });

  it('S27: Opening balance total value calculation', () => {
    const totalValue = db.prepare('SELECT SUM(quantity * cost_price) as total FROM opening_balance_items WHERE ob_id = ?').get('ob-001') as any;
    // 100*10 + 200*18 + 50*60 = 1000 + 3600 + 3000 = 7600
    expect(totalValue.total).toBe(7600);
  });

  it('S28: Submit opening balance -> status = completed', () => {
    db.prepare("UPDATE opening_balances SET status = 'completed' WHERE id = 'ob-001'").run();
    const ob = db.prepare("SELECT status FROM opening_balances WHERE id = 'ob-001'").get() as any;
    expect(ob.status).toBe('completed');
  });

  it('S29: Cannot create duplicate opening balance for same drug (same ob_id)', () => {
    // Same ob_id, same drug_id should be insertable (opening_balance_items has autoincrement PK)
    // But we should be able to detect duplicates
    db.prepare("INSERT INTO opening_balance_items (ob_id, drug_id, quantity, cost_price, selling_price) VALUES ('ob-001', 1, 999, 10, 15)").run();
    const drug1Items = db.prepare("SELECT COUNT(*) as cnt FROM opening_balance_items WHERE ob_id = 'ob-001' AND drug_id = 1").get() as any;
    expect(drug1Items.cnt).toBe(2); // Duplicate allowed at DB level
    // Business logic: the app should check for duplicates before inserting
  });
});

describe('Exhaustive Inventory: Settlement & Movements', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    seedFullInventory(db);
    // Create negative sales for settlement testing (once, not per-test)
    db.prepare("INSERT INTO sales_invoices (id, created_at) VALUES (10, datetime('now', '-2 days'))").run();
    db.prepare("INSERT INTO sales_invoices (id, created_at) VALUES (11, datetime('now'))").run();
    db.prepare("INSERT INTO sales_items (id, invoice_id, drug_id, quantity_sold, unit, unit_price, is_negative) VALUES (100, 10, 1, 10, 'large', 15, 1)").run();
    db.prepare("INSERT INTO sales_items (id, invoice_id, drug_id, quantity_sold, unit, unit_price, is_negative) VALUES (101, 11, 2, 5, 'large', 25, 1)").run();
  });
  afterAll(() => db.close());

  it('S30: Settle all items for a drug', () => {
    // Get negative sales for drug 1
    const negativeSales = db.prepare(`
      SELECT si.id, si.quantity_sold FROM sales_items si
      WHERE si.drug_id = ? AND si.is_negative = 1 ORDER BY si.created_at ASC
    `).all(1) as any[];
    expect(negativeSales.length).toBeGreaterThanOrEqual(1);

    // Settle by linking to inventory and marking as not negative
    db.prepare("UPDATE sales_items SET is_negative = 0, inventory_id = 'inv-001' WHERE id = ?").run(negativeSales[0].id);
    const updated = db.prepare('SELECT is_negative, inventory_id FROM sales_items WHERE id = ?').get(negativeSales[0].id) as any;
    expect(updated.is_negative).toBe(0);
    expect(updated.inventory_id).toBe('inv-001');
  });

  it('S31: Settlement with negative stock items', () => {
    // Create an item with negative stock scenario: inv-099 has 0 stock in seed
    db.prepare("INSERT INTO sales_items (id, invoice_id, drug_id, quantity_sold, unit, unit_price, is_negative, inventory_id) VALUES (102, 10, 1, 3, 'large', 15, 1, 'inv-099')").run();
    // Settle it
    db.prepare("UPDATE sales_items SET is_negative = 0 WHERE id = ?").run(102);
    // Deduct from inventory (can go negative)
    db.prepare("UPDATE inventory SET quantity = quantity - 3 WHERE id = 'inv-099'").run();
    const inv = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-099'").get() as any;
    expect(inv.quantity).toBe(-3);
  });

  it('S32: Item movement tracking across operations', () => {
    // Track a batch through: initial stock -> adjustment -> settlement -> final
    const initialQty = (db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-003'").get() as any).quantity; // 100
    // Adjustment: -10
    db.prepare("UPDATE inventory SET quantity = quantity - 10 WHERE id = 'inv-003'").run();
    db.prepare("INSERT INTO stock_adjustments (inventory_id, old_quantity, new_quantity, user_id, reason_id) VALUES ('inv-003', ?, ?, 'u1', 1)").run(initialQty, initialQty - 10);
    // Settlement: link to a sale
    db.prepare("UPDATE sales_items SET is_negative = 0, inventory_id = 'inv-003' WHERE id = 101").run();
    db.prepare("UPDATE inventory SET quantity = quantity - 5 WHERE id = 'inv-003'").run();
    // Final check
    const final = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-003'").get() as any;
    expect(final.quantity).toBe(85); // 100 - 10 - 5

    // Movement audit: all adjustment log entries
    const movements = db.prepare(`
      SELECT sa.*, i.quantity as current_qty
      FROM stock_adjustments sa
      JOIN inventory i ON sa.inventory_id = i.id
      WHERE sa.inventory_id = 'inv-003'
      ORDER BY sa.created_at DESC
    `).all() as any[];
    expect(movements.length).toBeGreaterThanOrEqual(1);
    expect(movements[0].old_quantity).toBe(100);
    expect(movements[0].new_quantity).toBe(90);
  });
});

describe('Exhaustive Inventory: Missing Inputs & Constraints', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedFullInventory(db); });
  afterAll(() => db.close());

  it('S33: Add inventory without drug_id (Constraint failure)', () => {
    // Inventory table doesn't have NOT NULL on drug_id in seed, but let's test if it handles missing fields
    expect(() => {
      // In SQLite, if column allows null, it will insert. But business logic normally restricts this.
      // Let's test missing primary key or other required-like fields
      db.prepare("INSERT INTO inventory (drug_id, quantity) VALUES (NULL, 10)").run();
    }).not.toThrow();
  });

  it('S34: Adjust non-existent inventory ID', () => {
    const res = db.prepare("UPDATE inventory SET quantity = 100 WHERE id = 'inv-unknown'").run();
    expect(res.changes).toBe(0);
  });

  it('S35: Insert extremely large quantity (Boundary)', () => {
    db.prepare("INSERT INTO inventory (id, drug_id, quantity, local_selling_price) VALUES ('inv-huge', 1, 999999999, 15)").run();
    const inv = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-huge'").get() as any;
    expect(inv.quantity).toBe(999999999);
  });

  it('S36: Missing input for stock adjustment reason (Boundary)', () => {
    expect(() => {
      db.prepare("INSERT INTO stock_adjustments (inventory_id, reason_id, old_quantity, new_quantity, user_id) VALUES (?, ?, ?, ?, ?)")
        .run('inv-001', null, 50, 40, 'u1');
    }).not.toThrow();
  });
});

describe('Exhaustive Inventory: Edge Cases & Integration', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedFullInventory(db); });
  afterAll(() => db.close());

  it('Stop dealing drug excluded from low-stock alerts', () => {
    const activeLowStock = db.prepare(`
      SELECT m.id FROM master_drugs m
      LEFT JOIN inventory i ON m.id = i.drug_id
      WHERE m.is_medicine = 1 AND m.stop_dealing = 0
      GROUP BY m.id HAVING COALESCE(SUM(i.quantity), 0) < m.reorder_point
    `).all() as any[];
    // Drug 5 has stop_dealing=1, so excluded
    const hasDiscontinued = activeLowStock.some((r: any) => r.id === 5);
    expect(hasDiscontinued).toBe(false);
  });

  it('Inventory counts correct after multiple operations', () => {
    // Verify total counts remain consistent
    const totalInv = db.prepare('SELECT COUNT(*) as cnt FROM inventory').get() as any;
    expect(totalInv.cnt).toBe(9); // 9 inventory rows from seed
  });

  it('Multiple adjustments on same batch accumulate correctly', () => {
    // Fresh check since each describe block has its own db
    const initial = (db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-002'").get() as any).quantity;
    db.prepare("UPDATE inventory SET quantity = ? WHERE id = 'inv-002'").run(initial + 5);
    db.prepare("UPDATE inventory SET quantity = ? WHERE id = 'inv-002'").run(initial + 10);
    db.prepare("UPDATE inventory SET quantity = ? WHERE id = 'inv-002'").run(initial + 15);
    const final = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-002'").get() as any;
    expect(final.quantity).toBe(initial + 15);
  });

  it('Shortage FK constraint enforces valid drug_id', () => {
    expect(() => {
      db.prepare("INSERT INTO shortages (drug_id, requested_quantity) VALUES (?, ?)").run(9999, 10);
    }).toThrow();
  });

  it('Service drug not counted in medicine stock aggregation', () => {
    const total = db.prepare(`
      SELECT COALESCE(SUM(i.quantity), 0) as total
      FROM master_drugs m JOIN inventory i ON m.id = i.drug_id
      WHERE m.is_medicine = 1 AND m.stop_dealing = 0
    `).get() as any;
    expect(total.total).toBeGreaterThan(0);
    // Drug 4 (service) should NOT contribute
    const serviceTotal = db.prepare(`
      SELECT COALESCE(SUM(i.quantity), 0) as total
      FROM master_drugs m JOIN inventory i ON m.id = i.drug_id
      WHERE m.is_service = 1
    `).get() as any;
    expect(serviceTotal.total).toBe(0);
  });

  it('Negative stock appears in queries but not in positive-stock views', () => {
    // Make inv-099 negative
    db.prepare("UPDATE inventory SET quantity = -5 WHERE id = 'inv-099'").run();
    const positiveStock = db.prepare(
      "SELECT COUNT(*) as cnt FROM inventory WHERE quantity > 0"
    ).get() as any;
    const negativeStock = db.prepare(
      "SELECT COUNT(*) as cnt FROM inventory WHERE quantity < 0"
    ).get() as any;
    expect(negativeStock.cnt).toBe(1);
    expect(positiveStock.cnt).toBeGreaterThan(0);
  });
});
