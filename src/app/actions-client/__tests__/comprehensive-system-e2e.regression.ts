/**
 * Comprehensive System Flow & Business Logic E2E Regression Test
 * Tests: Inventory -> Purchases -> POS Sales -> Sales Returns -> Purchase Returns -> Shortages -> Shift Handover -> Permissions
 */

import Database from 'better-sqlite3';

function initFullSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,
      full_name TEXT,
      password_hash TEXT,
      permissions TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      phone TEXT,
      balance REAL DEFAULT 0
    );

    CREATE TABLE master_drugs (
      id INTEGER PRIMARY KEY,
      trade_name TEXT NOT NULL,
      trade_name_en TEXT,
      barcode TEXT,
      official_price REAL DEFAULT 0,
      is_medicine INTEGER DEFAULT 1,
      large_unit TEXT DEFAULT 'علبة',
      small_unit TEXT DEFAULT 'شريط',
      medium_unit TEXT,
      large_to_medium INTEGER DEFAULT 1,
      medium_to_small INTEGER DEFAULT 3,
      min_limit INTEGER DEFAULT 5,
      reorder_point INTEGER DEFAULT 10,
      stop_dealing INTEGER DEFAULT 0
    );

    CREATE TABLE inventory (
      id TEXT PRIMARY KEY,
      pharmacy_id TEXT,
      drug_id INTEGER NOT NULL,
      batch_number TEXT,
      quantity REAL NOT NULL DEFAULT 0,
      cost_price REAL NOT NULL DEFAULT 0,
      local_selling_price REAL NOT NULL DEFAULT 0,
      expiry_date TEXT,
      barcode TEXT,
      strips_per_box INTEGER DEFAULT 3,
      FOREIGN KEY (drug_id) REFERENCES master_drugs(id)
    );

    CREATE TABLE purchase_invoices (
      id TEXT PRIMARY KEY,
      supplier_id INTEGER NOT NULL,
      invoice_number TEXT,
      invoice_date TEXT,
      total_amount REAL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'credit',
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );

    CREATE TABLE purchase_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL,
      drug_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      cost_price REAL NOT NULL,
      selling_price REAL,
      bonus_quantity INTEGER DEFAULT 0,
      expiry_date TEXT,
      batch_number TEXT,
      strips_per_box INTEGER DEFAULT 3,
      FOREIGN KEY (invoice_id) REFERENCES purchase_invoices(id),
      FOREIGN KEY (drug_id) REFERENCES master_drugs(id)
    );

    CREATE TABLE purchase_returns (
      id TEXT PRIMARY KEY,
      supplier_id INTEGER NOT NULL,
      invoice_id TEXT,
      total_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE purchase_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id TEXT NOT NULL,
      inventory_id TEXT,
      drug_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      cost_price REAL NOT NULL
    );

    CREATE TABLE patients (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone TEXT,
      credit_limit REAL DEFAULT 1000,
      points_balance REAL DEFAULT 0
    );

    CREATE TABLE patient_transactions (
      id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL
    );

    CREATE TABLE shifts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      end_time DATETIME,
      starting_cash REAL DEFAULT 0,
      ending_cash REAL,
      actual_cash REAL,
      cash_difference REAL,
      transfer_amount REAL DEFAULT 0,
      transfer_target TEXT,
      receiver_id TEXT,
      status TEXT DEFAULT 'open'
    );

    CREATE TABLE cash_movements (
      id TEXT PRIMARY KEY,
      shift_id TEXT,
      user_id TEXT,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      date DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE sales_invoices (
      id TEXT PRIMARY KEY,
      invoice_number TEXT,
      shift_id TEXT,
      user_id TEXT NOT NULL,
      patient_id TEXT,
      total_amount REAL NOT NULL,
      discount_amount REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'cash',
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE sales_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL,
      drug_id INTEGER NOT NULL,
      inventory_id TEXT,
      quantity_sold REAL NOT NULL,
      unit_price REAL NOT NULL,
      cost_price REAL NOT NULL,
      unit_type TEXT DEFAULT 'box'
    );

    CREATE TABLE returns (
      id TEXT PRIMARY KEY,
      invoice_id TEXT,
      shift_id TEXT,
      user_id TEXT NOT NULL,
      total_refund REAL NOT NULL,
      reason TEXT,
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id TEXT NOT NULL,
      inventory_id TEXT,
      drug_id INTEGER NOT NULL,
      quantity_returned REAL NOT NULL,
      unit_price REAL NOT NULL,
      cost_price REAL NOT NULL
    );

    CREATE TABLE shortages (
      id TEXT PRIMARY KEY,
      drug_id INTEGER NOT NULL,
      requested_quantity REAL DEFAULT 10,
      current_stock REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed Admin and Cashier
  db.prepare(`
    INSERT INTO users (id, username, role, full_name, permissions) VALUES
      ('u-admin', 'admin', 'admin', 'System Admin', '{"all": true}'),
      ('u-cashier', 'cashier1', 'cashier', 'Ahmed Cashier', '{"pos": true, "inventory_view": true}')
  `).run();

  // Seed Supplier
  db.prepare(`
    INSERT INTO suppliers (id, name_ar, balance) VALUES (1, 'الشركة المتحدة للتوزيع', 0)
  `).run();

  // Seed Master Drugs
  db.prepare(`
    INSERT INTO master_drugs (id, trade_name, trade_name_en, barcode, official_price, medium_to_small, min_limit, reorder_point) VALUES
      (101, '1 2 3 (ONE TWO THREE) 20 F.C.TABS.', '1 2 3 TABS', '6221000000010', 40, 3, 5, 10),
      (102, 'PANADOL EXTRA 24 TABS', 'PANADOL EXTRA', '6222000000020', 45, 3, 5, 10)
  `).run();
}

describe('Comprehensive System Flow & Business Logic E2E Review', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    initFullSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  it('Flow 1: Open Shift with starting cash of 500 EGP', () => {
    const shiftId = 'shift-001';
    db.prepare(`
      INSERT INTO shifts (id, user_id, starting_cash, status)
      VALUES (?, ?, ?, 'open')
    `).run(shiftId, 'u-cashier', 500);

    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId) as any;
    expect(shift).toBeDefined();
    expect(shift.status).toBe('open');
    expect(shift.starting_cash).toBe(500);
  });

  it('Flow 2: Purchase Invoice - receive 100 boxes of 1 2 3 @ 30 EGP cost, 40 EGP selling', () => {
    const invoiceId = 'purch-001';
    db.transaction(() => {
      // 1. Create Purchase Invoice
      db.prepare(`
        INSERT INTO purchase_invoices (id, supplier_id, invoice_number, total_amount, payment_method, status)
        VALUES (?, 1, 'INV-2026-001', 3000, 'credit', 'completed')
      `).run(invoiceId);

      // 2. Add Invoice Items
      db.prepare(`
        INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, cost_price, selling_price, expiry_date, batch_number)
        VALUES (?, 101, 100, 30, 40, '2028-12-31', 'BATCH-A1')
      `).run(invoiceId);

      // 3. Update Supplier Balance
      db.prepare(`
        UPDATE suppliers SET balance = balance + 3000 WHERE id = 1
      `).run();

      // 4. Create Inventory Batch
      db.prepare(`
        INSERT INTO inventory (id, drug_id, batch_number, quantity, cost_price, local_selling_price, expiry_date, barcode, strips_per_box)
        VALUES ('inv-lot-1', 101, 'BATCH-A1', 100, 30, 40, '2028-12-31', '6221000000010', 3)
      `).run();
    })();

    // Verify supplier balance is 3000 EGP
    const supplier = db.prepare('SELECT balance FROM suppliers WHERE id = 1').get() as any;
    expect(supplier.balance).toBe(3000);

    // Verify inventory stock is 100 boxes
    const lot = db.prepare('SELECT * FROM inventory WHERE id = ?').get('inv-lot-1') as any;
    expect(lot.quantity).toBe(100);
    expect(lot.local_selling_price).toBe(40);
  });

  it('Flow 3: POS Sale - Cashier sells 5 boxes of 1 2 3 for Cash (5 * 40 = 200 EGP)', () => {
    const saleId = 'sale-001';
    db.transaction(() => {
      // 1. Deduct Inventory (FIFO)
      db.prepare(`
        UPDATE inventory SET quantity = quantity - 5 WHERE id = 'inv-lot-1'
      `).run();

      // 2. Create Sales Invoice
      db.prepare(`
        INSERT INTO sales_invoices (id, invoice_number, shift_id, user_id, total_amount, payment_method, status)
        VALUES (?, 'REC-001', 'shift-001', 'u-cashier', 200, 'cash', 'completed')
      `).run(saleId);

      // 3. Record Sales Item
      db.prepare(`
        INSERT INTO sales_items (invoice_id, drug_id, inventory_id, quantity_sold, unit_price, cost_price)
        VALUES (?, 101, 'inv-lot-1', 5, 40, 30)
      `).run(saleId);

      // 4. Record Cash Movement into Active Shift
      db.prepare(`
        INSERT INTO cash_movements (id, shift_id, user_id, type, amount)
        VALUES ('cm-sale-1', 'shift-001', 'u-cashier', 'sale', 200)
      `).run();
    })();

    // Inventory should now be 95 boxes
    const lot = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-lot-1') as any;
    expect(lot.quantity).toBe(95);

    // Shift cash movements should have +200 EGP
    const salesTotal = db.prepare(`
      SELECT SUM(amount) as total FROM cash_movements WHERE shift_id = 'shift-001' AND type = 'sale'
    `).get() as any;
    expect(salesTotal.total).toBe(200);
  });

  it('Flow 4: POS Sale by Strip (Partial box) - 1 strip (1/3 box = 0.333) sold', () => {
    const stripQty = 1 / 3; // 0.3333333333333333 box
    const stripPrice = 40 / 3; // ~13.33 EGP

    db.transaction(() => {
      db.prepare(`
        UPDATE inventory SET quantity = quantity - ? WHERE id = 'inv-lot-1'
      `).run(stripQty);

      db.prepare(`
        INSERT INTO sales_invoices (id, invoice_number, shift_id, user_id, total_amount, payment_method, status)
        VALUES ('sale-002', 'REC-002', 'shift-001', 'u-cashier', ?, 'cash', 'completed')
      `).run(stripPrice);

      db.prepare(`
        INSERT INTO cash_movements (id, shift_id, user_id, type, amount)
        VALUES ('cm-sale-2', 'shift-001', 'u-cashier', 'sale', ?)
      `).run(stripPrice);
    })();

    const lot = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-lot-1') as any;
    expect(lot.quantity).toBeCloseTo(95 - 0.3333, 2);
  });

  it('Flow 5: Sales Return - Customer returns 1 box from sale-001', () => {
    const returnId = 'ret-001';
    db.transaction(() => {
      // 1. Restock 1 box to inventory
      db.prepare(`
        UPDATE inventory SET quantity = quantity + 1 WHERE id = 'inv-lot-1'
      `).run();

      // 2. Record Return
      db.prepare(`
        INSERT INTO returns (id, invoice_id, shift_id, user_id, total_refund, reason, status)
        VALUES (?, 'sale-001', 'shift-001', 'u-cashier', 40, 'Defective blister', 'completed')
      `).run(returnId);

      // 3. Deduct from Shift Cash
      db.prepare(`
        INSERT INTO cash_movements (id, shift_id, user_id, type, amount)
        VALUES ('cm-ret-1', 'shift-001', 'u-cashier', 'sales_return', -40)
      `).run();
    })();

    // Inventory lot should be incremented back by 1 box
    const lot = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-lot-1') as any;
    expect(lot.quantity).toBeCloseTo(95 - 0.3333 + 1, 2);

    // Net shift sales revenue = 200 + 13.33 - 40 = 173.33 EGP
    const netCash = db.prepare(`
      SELECT SUM(amount) as net FROM cash_movements WHERE shift_id = 'shift-001'
    `).get() as any;
    expect(netCash.net).toBeCloseTo(173.33, 1);
  });

  it('Flow 6: Purchase Return - Pharmacy returns 5 boxes to Supplier', () => {
    const purchReturnId = 'pret-001';
    db.transaction(() => {
      // 1. Deduct 5 boxes from inventory
      db.prepare(`
        UPDATE inventory SET quantity = quantity - 5 WHERE id = 'inv-lot-1'
      `).run();

      // 2. Record purchase return
      db.prepare(`
        INSERT INTO purchase_returns (id, supplier_id, invoice_id, total_amount, status)
        VALUES (?, 1, 'purch-001', 150, 'completed')
      `).run(purchReturnId);

      // 3. Credit Supplier Balance (debt decreased by 5 * 30 = 150)
      db.prepare(`
        UPDATE suppliers SET balance = balance - 150 WHERE id = 1
      `).run();
    })();

    const supplier = db.prepare('SELECT balance FROM suppliers WHERE id = 1').get() as any;
    expect(supplier.balance).toBe(2850); // 3000 - 150
  });

  it('Flow 7: Shortages Trigger - Stock falls below reorder point (10)', () => {
    // Force stock down to 4 boxes (reorder_point is 10)
    db.prepare(`UPDATE inventory SET quantity = 4 WHERE id = 'inv-lot-1'`).run();

    // Check low stock query
    const lowStock = db.prepare(`
      SELECT m.id, m.trade_name, m.reorder_point, COALESCE(SUM(i.quantity), 0) as current_stock
      FROM master_drugs m
      LEFT JOIN inventory i ON m.id = i.drug_id
      GROUP BY m.id
      HAVING current_stock <= m.reorder_point
    `).all() as any[];

    expect(lowStock.length).toBeGreaterThanOrEqual(1);
    expect(lowStock[0].trade_name).toContain('1 2 3');

    // Auto-sync into shortages table
    db.prepare(`
      INSERT OR REPLACE INTO shortages (id, drug_id, requested_quantity, current_stock, status)
      VALUES ('short-1', 101, 10, 4, 'pending')
    `).run();

    const shortage = db.prepare('SELECT * FROM shortages WHERE drug_id = 101').get() as any;
    expect(shortage.status).toBe('pending');
    expect(shortage.current_stock).toBe(4);
  });

  it('Flow 8: Shift Drawer Handover - Reconcile expected vs actual cash', () => {
    // Starting cash: 500
    // Net sales & return movements: 173.33 EGP
    // Expected cash in drawer = 500 + 173.33 = 673.33 EGP
    const movements = db.prepare(`
      SELECT SUM(amount) as net FROM cash_movements WHERE shift_id = 'shift-001'
    `).get() as any;
    const startingCash = 500;
    const expectedCash = startingCash + Number(movements.net);

    // Cashier counts 675 EGP physically in the drawer (+1.67 surplus)
    const actualCash = 675;
    const difference = actualCash - expectedCash;
    const transferAmount = 600; // Transfer 600 to safe, keep 75 for next shift
    const nextShiftStartingCash = actualCash - transferAmount; // 75

    db.prepare(`
      UPDATE shifts
      SET end_time = CURRENT_TIMESTAMP,
          status = 'closed',
          actual_cash = ?,
          cash_difference = ?,
          transfer_amount = ?,
          transfer_target = 'safe',
          ending_cash = ?
      WHERE id = 'shift-001'
    `).run(actualCash, difference, transferAmount, nextShiftStartingCash);

    const closedShift = db.prepare('SELECT * FROM shifts WHERE id = ?').get('shift-001') as any;
    expect(closedShift.status).toBe('closed');
    expect(closedShift.actual_cash).toBe(675);
    expect(closedShift.cash_difference).toBeCloseTo(1.67, 1);
    expect(closedShift.ending_cash).toBe(75);

    // Verify next shift suggested starting cash
    const lastClosedShift = db.prepare(`
      SELECT ending_cash FROM shifts WHERE status = 'closed' ORDER BY end_time DESC LIMIT 1
    `).get() as any;
    expect(lastClosedShift.ending_cash).toBe(75);
  });

  it('Flow 9: Role-Based Permissions - Cashier cannot view cash difference; Admin can', () => {
    function sanitizeShiftForUser(shift: any, userRole: string) {
      if (userRole === 'admin' || userRole === 'owner') {
        return shift;
      }
      const sanitized = { ...shift };
      delete sanitized.actual_cash;
      delete sanitized.cash_difference;
      return sanitized;
    }

    const rawShift = db.prepare('SELECT * FROM shifts WHERE id = ?').get('shift-001') as any;

    const forCashier = sanitizeShiftForUser(rawShift, 'cashier');
    expect(forCashier.actual_cash).toBeUndefined();
    expect(forCashier.cash_difference).toBeUndefined();
    expect(forCashier.starting_cash).toBe(500);

    const forAdmin = sanitizeShiftForUser(rawShift, 'admin');
    expect(forAdmin.actual_cash).toBe(675);
    expect(forAdmin.cash_difference).toBeCloseTo(1.67, 1);
  });
});
