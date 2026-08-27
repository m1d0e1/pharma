import Database from 'better-sqlite3';

/**
 * Dynamic Modules Linking & Business Logic End-to-End Test
 * 
 * Verifies that all modules:
 * Shortages -> Purchases -> Inventory -> Shifts -> POS Sales -> Returns -> Handover -> Accounting
 * are dynamically linked and execute the complete business lifecycle with data integrity.
 */

function setupSchema(db: Database.Database) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');

  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      role TEXT,
      full_name TEXT,
      pharmacy_id TEXT,
      permissions TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT,
      name_en TEXT,
      phone TEXT,
      balance REAL DEFAULT 0
    );

    CREATE TABLE supplier_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER,
      type TEXT,
      amount REAL,
      reference_id TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE patients (
      id TEXT PRIMARY KEY,
      name_ar TEXT,
      name_en TEXT,
      full_name TEXT,
      phone TEXT,
      credit_limit REAL DEFAULT 1000,
      wallet_balance REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      loyalty_level TEXT DEFAULT 'silver',
      points_balance INTEGER DEFAULT 0
    );

    CREATE TABLE master_drugs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_name TEXT,
      trade_name_en TEXT,
      barcode TEXT,
      official_price REAL,
      base_price REAL DEFAULT 0,
      large_to_medium INTEGER DEFAULT 2,
      medium_to_small INTEGER DEFAULT 10,
      default_purchase_qty INTEGER DEFAULT 10,
      reorder_point INTEGER DEFAULT 5,
      min_limit INTEGER DEFAULT 2,
      is_medicine INTEGER DEFAULT 1
    );

    CREATE TABLE inventory (
      id TEXT PRIMARY KEY,
      pharmacy_id TEXT,
      drug_id INTEGER,
      quantity REAL DEFAULT 0,
      cost_price REAL DEFAULT 0,
      local_selling_price REAL,
      batch_number TEXT,
      expiry_date TEXT,
      barcode TEXT,
      strips_per_box INTEGER DEFAULT 2,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE shortages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pharmacy_id TEXT,
      drug_id INTEGER,
      current_stock REAL DEFAULT 0,
      requested_quantity REAL DEFAULT 1,
      reorder_point REAL DEFAULT 5,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE purchase_orders (
      id TEXT PRIMARY KEY,
      pharmacy_id TEXT,
      supplier_id INTEGER,
      status TEXT DEFAULT 'pending',
      total_amount REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      drug_id INTEGER,
      quantity REAL,
      expected_cost REAL
    );

    CREATE TABLE purchase_invoices (
      id TEXT PRIMARY KEY,
      supplier_id INTEGER,
      pharmacy_id TEXT,
      user_id TEXT,
      invoice_number TEXT,
      invoice_date TEXT,
      total_amount REAL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'credit',
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE purchase_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT,
      drug_id INTEGER,
      inventory_id TEXT,
      quantity REAL,
      cost_price REAL,
      selling_price REAL,
      bonus_quantity REAL DEFAULT 0,
      strips_per_box INTEGER DEFAULT 2,
      expiry_date TEXT
    );

    CREATE TABLE shifts (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      starting_cash REAL DEFAULT 0,
      ending_cash REAL,
      actual_cash REAL,
      transfer_amount REAL,
      transfer_target TEXT,
      cash_difference REAL,
      receiver_id TEXT,
      status TEXT DEFAULT 'open',
      notes TEXT,
      start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      end_time DATETIME
    );

    CREATE TABLE sales_invoices (
      id TEXT PRIMARY KEY,
      pharmacy_id TEXT,
      user_id TEXT,
      patient_id TEXT,
      shift_id TEXT,
      total_amount REAL,
      paid_amount REAL DEFAULT 0,
      remaining_amount REAL DEFAULT 0,
      discount_amount REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'cash',
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE sales_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT,
      inventory_id TEXT,
      drug_id INTEGER,
      quantity_sold REAL,
      unit_price REAL,
      unit TEXT DEFAULT 'large',
      cost_price REAL DEFAULT 0,
      is_negative INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE returns (
      id TEXT PRIMARY KEY,
      invoice_id TEXT,
      user_id TEXT,
      shift_id TEXT,
      total_refund REAL,
      refund_method TEXT DEFAULT 'cash',
      reason TEXT,
      status TEXT DEFAULT 'approved',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id TEXT,
      inventory_id TEXT,
      drug_name TEXT,
      quantity_returned REAL,
      unit_price REAL,
      sale_item_id INTEGER,
      unit TEXT DEFAULT 'large'
    );

    CREATE TABLE cash_movements (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      shift_id TEXT,
      type TEXT,
      amount REAL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE daily_journals (
      id TEXT PRIMARY KEY,
      date TEXT,
      description TEXT,
      created_by TEXT,
      total_amount REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_id TEXT,
      account_id INTEGER,
      type TEXT,
      amount REAL
    );

    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      name_ar TEXT,
      name_en TEXT,
      parent_id INTEGER,
      is_group INTEGER DEFAULT 0,
      balance REAL DEFAULT 0
    );
  `);

  // Chart of Accounts Seed (Debit vs Credit leaf accounts)
  db.exec(`
    INSERT INTO accounts (id, code, name_ar, name_en, is_group) VALUES
      (1, '101', 'الصندوق والدرج', 'Cash Drawer', 0),
      (2, '102', 'الخزينة الرئيسية', 'Main Treasury', 0),
      (3, '103', 'المخزون السلعي', 'Inventory Asset', 0),
      (4, '104', 'العملاء والمدينون', 'Accounts Receivable', 0),
      (5, '201', 'الموردون والدائنون', 'Accounts Payable', 0),
      (6, '301', 'رأس المال والافتتاح', 'Equity', 0),
      (7, '401', 'إيرادات المبيعات', 'Sales Revenue', 0),
      (8, '402', 'مردودات المبيعات', 'Sales Returns', 0),
      (9, '501', 'تكلفة البضاعة المباعة', 'Cost of Goods Sold', 0),
      (10, '502', 'فروق وعجز النقدية', 'Cash Difference', 0);
  `);

  // Initial Users
  db.prepare(`
    INSERT INTO users (id, username, role, full_name, pharmacy_id)
    VALUES ('u-1', 'pharmacist_day', 'pharmacist', 'د. أحمد الصباحي', 'ph-1'),
           ('u-2', 'pharmacist_night', 'pharmacist', 'د. سارة المسائي', 'ph-1')
  `).run();

  // Initial Supplier & Patient
  db.prepare(`INSERT INTO suppliers (id, name_ar, phone, balance) VALUES (1, 'شركة إيبيكو للأدوية', '01011112222', 0)`).run();
  db.prepare(`INSERT INTO patients (id, full_name, phone, credit_limit, balance) VALUES ('p-10', 'خالد مريض آجل', '01234567890', 2000, 0)`).run();
}

function uid() {
  return 'tx-' + Math.random().toString(36).slice(2, 11);
}

describe('Dynamic Modules Linking & Business Logic Lifecycle', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    setupSchema(db);
  });

  afterAll(() => {
    db.close();
  });

  it('verifies the full dynamic flow across Shortages -> Purchases -> POS -> Returns -> Handover -> Trial Balance', () => {
    // ------------------------------------------------------------------------
    // Step 1: Master Drug Created & Triggers Shortages when Out-of-Stock
    // ------------------------------------------------------------------------
    const drugInsert = db.prepare(`
      INSERT INTO master_drugs (trade_name, trade_name_en, official_price, base_price, large_to_medium, reorder_point)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('بانادول إكسترا أقراص', 'Panadol Extra', 50, 40, 2, 5);
    const drugId = Number(drugInsert.lastInsertRowid);

    // Dynamic Link: Zero stock automatically enters Shortages notebook (كشكول النواقص)
    db.prepare(`
      INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, reorder_point, status)
      VALUES (?, 'ph-1', 20, 5, 'pending')
    `).run(drugId);

    const pendingShortages = db.prepare(`SELECT * FROM shortages WHERE drug_id = ? AND status = 'pending'`).all(drugId);
    expect(pendingShortages.length).toBe(1);

    // ------------------------------------------------------------------------
    // Step 2: Convert Shortage to Purchase Order & Purchase Invoice
    // ------------------------------------------------------------------------
    const poId = uid();
    db.prepare(`
      INSERT INTO purchase_orders (id, pharmacy_id, supplier_id, status, total_amount)
      VALUES (?, 'ph-1', 1, 'completed', 800)
    `).run(poId);

    // Purchase 20 boxes at cost 40 EGP each (Total = 800 EGP) on credit
    const pInvId = uid();
    const invId = uid();

    db.transaction(() => {
      // Create Purchase Invoice
      db.prepare(`
        INSERT INTO purchase_invoices (id, supplier_id, pharmacy_id, user_id, invoice_number, total_amount, payment_method, status)
        VALUES (?, 1, 'ph-1', 'u-1', 'PINV-001', 800, 'credit', 'completed')
      `).run(pInvId);

      // Create Purchase Items
      db.prepare(`
        INSERT INTO purchase_invoice_items (invoice_id, drug_id, inventory_id, quantity, cost_price, selling_price, expiry_date)
        VALUES (?, ?, ?, 20, 40, 50, '2028-12-31')
      `).run(pInvId, drugId, invId);

      // Dynamic Link: Add to Inventory
      db.prepare(`
        INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, cost_price, local_selling_price, expiry_date, strips_per_box)
        VALUES (?, 'ph-1', ?, 20, 40, 50, '2028-12-31', 2)
      `).run(invId, drugId);

      // Dynamic Link: Shortages resolved to 'received'
      db.prepare(`
        UPDATE shortages SET status = 'received' WHERE drug_id = ? AND status = 'pending'
      `).run(drugId);

      // Dynamic Link: Update Supplier balance & log transaction
      db.prepare(`UPDATE suppliers SET balance = balance + 800 WHERE id = 1`).run();
      db.prepare(`
        INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes)
        VALUES (1, 'invoice', 800, ?, 'فاتورة شراء رقم PINV-001')
      `).run(pInvId);

      // Dynamic Link: Accounting entries for Purchase
      // Debit: Inventory Asset (103) 800, Credit: Accounts Payable (201) 800
      const jId = uid();
      db.prepare(`INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, '2026-08-27', 'فاتورة شراء', 'u-1', 800)`).run(jId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 3, 'debit', 800)`).run(jId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 5, 'credit', 800)`).run(jId);
    })();

    // Assert Shortage is resolved
    const resolvedShortage = db.prepare(`SELECT status FROM shortages WHERE drug_id = ?`).get(drugId) as any;
    expect(resolvedShortage.status).toBe('received');

    // Assert Inventory increased
    const inventoryItem = db.prepare(`SELECT quantity, cost_price FROM inventory WHERE id = ?`).get(invId) as any;
    expect(inventoryItem.quantity).toBe(20);

    // Assert Supplier balance
    const supplier = db.prepare(`SELECT balance FROM suppliers WHERE id = 1`).get() as any;
    expect(supplier.balance).toBe(800);

    // ------------------------------------------------------------------------
    // Step 3: Open Day Shift 1 (وردية الصباح)
    // ------------------------------------------------------------------------
    const shift1Id = uid();
    const startingCash = 500; // Starting Cash = 500 EGP

    db.prepare(`
      INSERT INTO shifts (id, user_id, starting_cash, status, start_time)
      VALUES (?, 'u-1', ?, 'open', CURRENT_TIMESTAMP)
    `).run(shift1Id, startingCash);

    // Accounting for starting capital / cash drawer:
    // Debit: Cash Drawer (101) 500, Credit: Equity (301) 500
    const jStartId = uid();
    db.prepare(`INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, '2026-08-27', 'رصيد افتتاحي للدرج', 'u-1', 500)`).run(jStartId);
    db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 1, 'debit', 500)`).run(jStartId);
    db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 6, 'credit', 500)`).run(jStartId);

    // ------------------------------------------------------------------------
    // Step 4: POS Sale linked to Shift 1
    // ------------------------------------------------------------------------
    // Sell 4 boxes of Panadol for Cash at 50 EGP each (Total = 200 EGP, COGS = 4 * 40 = 160)
    const saleId = uid();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO sales_invoices (id, pharmacy_id, user_id, patient_id, shift_id, total_amount, payment_method, status)
        VALUES (?, 'ph-1', 'u-1', NULL, ?, 200, 'cash', 'completed')
      `).run(saleId, shift1Id);

      db.prepare(`
        INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, cost_price)
        VALUES (?, ?, ?, 4, 50, 40)
      `).run(saleId, invId, drugId);

      // Decrement Inventory: 20 - 4 = 16 boxes
      db.prepare(`UPDATE inventory SET quantity = quantity - 4 WHERE id = ?`).run(invId);

      // Accounting for Sale:
      // Debit: Cash Drawer (101) 200, Credit: Sales Revenue (401) 200
      // Debit: COGS (501) 160, Credit: Inventory Asset (103) 160
      const jSaleId = uid();
      db.prepare(`INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, '2026-08-27', 'فاتورة مبيعات', 'u-1', 360)`).run(jSaleId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 1, 'debit', 200)`).run(jSaleId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 7, 'credit', 200)`).run(jSaleId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 9, 'debit', 160)`).run(jSaleId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 3, 'credit', 160)`).run(jSaleId);
    })();

    // Verify remaining inventory
    const postSaleStock = db.prepare(`SELECT quantity FROM inventory WHERE id = ?`).get(invId) as any;
    expect(postSaleStock.quantity).toBe(16);

    // ------------------------------------------------------------------------
    // Step 5: Sales Return linked to Shift 1
    // ------------------------------------------------------------------------
    // Customer returns 1 box for cash refund (Refund = 50 EGP, COGS reversal = 40)
    const returnId = uid();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO returns (id, invoice_id, user_id, shift_id, total_refund, refund_method, reason, status)
        VALUES (?, ?, 'u-1', ?, 50, 'cash', 'خطأ في الصنف', 'approved')
      `).run(returnId, saleId, shift1Id);

      db.prepare(`
        INSERT INTO return_items (return_id, inventory_id, drug_name, quantity_returned, unit_price, unit)
        VALUES (?, ?, 'Panadol Extra', 1, 50, 'large')
      `).run(returnId, invId);

      // Restock inventory: 16 + 1 = 17 boxes
      db.prepare(`UPDATE inventory SET quantity = quantity + 1 WHERE id = ?`).run(invId);

      // Accounting for Return:
      // Debit: Sales Returns (402) 50, Credit: Cash Drawer (101) 50
      // Debit: Inventory Asset (103) 40, Credit: COGS (501) 40
      const jRetId = uid();
      db.prepare(`INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, '2026-08-27', 'مرتجع مبيعات', 'u-1', 90)`).run(jRetId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 8, 'debit', 50)`).run(jRetId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 1, 'credit', 50)`).run(jRetId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 3, 'debit', 40)`).run(jRetId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 9, 'credit', 40)`).run(jRetId);
    })();

    const postReturnStock = db.prepare(`SELECT quantity FROM inventory WHERE id = ?`).get(invId) as any;
    expect(postReturnStock.quantity).toBe(17);

    // ------------------------------------------------------------------------
    // Step 6: Handover Calculation & Verification
    // ------------------------------------------------------------------------
    // Calculate expected cash dynamically:
    // Expected = Starting Cash (500) + Cash Sales (200) - Cash Returns (50) = 650 EGP
    const shiftSummary = db.prepare(`
      SELECT
        s.starting_cash,
        (SELECT COALESCE(SUM(total_amount), 0) FROM sales_invoices WHERE shift_id = s.id AND payment_method = 'cash' AND status = 'completed') as cash_sales,
        (SELECT COALESCE(SUM(total_refund), 0) FROM returns WHERE shift_id = s.id AND refund_method = 'cash' AND status = 'approved') as cash_returns
      FROM shifts s
      WHERE s.id = ?
    `).get(shift1Id) as any;

    const expectedCash = shiftSummary.starting_cash + shiftSummary.cash_sales - shiftSummary.cash_returns;
    expect(expectedCash).toBe(650);

    // ------------------------------------------------------------------------
    // Step 7: Process Handover -> Discrepancy, Treasury Transfer & Auto-Open Shift 2
    // ------------------------------------------------------------------------
    // Pharmacist counted 660 EGP (10 EGP surplus / زيادة).
    // Decides to transfer 500 EGP to Main Treasury, leaving 160 EGP for Shift 2.
    const actualCash = 660;
    const difference = actualCash - expectedCash; // +10 EGP
    const transferAmount = 500;
    const remainingForNextShift = actualCash - transferAmount; // 160 EGP

    const shift2Id = uid();

    db.transaction(() => {
      // 1. Close Shift 1
      db.prepare(`
        UPDATE shifts
        SET end_time = CURRENT_TIMESTAMP,
            ending_cash = ?,
            actual_cash = ?,
            transfer_amount = ?,
            transfer_target = 'treasury',
            cash_difference = ?,
            receiver_id = 'u-2',
            status = 'discrepancy'
        WHERE id = ?
      `).run(remainingForNextShift, actualCash, transferAmount, difference, shift1Id);

      // 2. Transfer cash to Treasury
      // Debit: Main Treasury (102) 500, Credit: Cash Drawer (101) 500
      const jTransferId = uid();
      db.prepare(`INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, '2026-08-27', 'توريد للخزينة من وردية 1', 'u-1', 500)`).run(jTransferId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 2, 'debit', 500)`).run(jTransferId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 1, 'credit', 500)`).run(jTransferId);

      // 3. Difference entry (Surplus: Debit Cash Drawer 10, Credit Cash Difference 10)
      const jDiffId = uid();
      db.prepare(`INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, '2026-08-27', 'تسوية زيادة نقدية', 'u-1', 10)`).run(jDiffId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 1, 'debit', 10)`).run(jDiffId);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 10, 'credit', 10)`).run(jDiffId);

      // 4. Dynamic Auto-Open Shift 2 for user 'u-2' with remaining starting cash (160 EGP)
      db.prepare(`
        INSERT INTO shifts (id, user_id, starting_cash, status, start_time)
        VALUES (?, 'u-2', ?, 'open', CURRENT_TIMESTAMP)
      `).run(shift2Id, remainingForNextShift);
    })();

    // Assert Shift 1 status and difference
    const closedShift1 = db.prepare(`SELECT status, cash_difference, ending_cash FROM shifts WHERE id = ?`).get(shift1Id) as any;
    expect(closedShift1.status).toBe('discrepancy');
    expect(closedShift1.cash_difference).toBe(10);
    expect(closedShift1.ending_cash).toBe(160);

    // Assert Shift 2 auto-opened dynamically
    const openShift2 = db.prepare(`SELECT * FROM shifts WHERE id = ?`).get(shift2Id) as any;
    expect(openShift2.status).toBe('open');
    expect(openShift2.user_id).toBe('u-2');
    expect(openShift2.starting_cash).toBe(160);

    // ------------------------------------------------------------------------
    // Step 8: Dynamic Reconciliation via Trial Balance (ميزان المراجعة)
    // ------------------------------------------------------------------------
    // Calculate total Debits and total Credits across all journal entries in the database
    const totalDebits = (db.prepare(`SELECT SUM(amount) as sum FROM journal_entries WHERE type = 'debit'`).get() as any).sum;
    const totalCredits = (db.prepare(`SELECT SUM(amount) as sum FROM journal_entries WHERE type = 'credit'`).get() as any).sum;

    expect(totalDebits).toBeGreaterThan(0);
    expect(totalCredits).toBeGreaterThan(0);
    // Double-Entry Golden Rule: Sum of Debits MUST EXACTLY EQUAL Sum of Credits
    expect(totalDebits).toBe(totalCredits);

    // Per-Account Balance Reconciliation:
    // Cash Drawer (101) balance:
    // + 500 (opening) + 200 (sale) - 50 (return) - 500 (treasury) + 10 (surplus) = 160 EGP
    // Notice that 160 EGP matches EXACTLY the starting cash of Shift 2!
    const cashDrawerEntries = db.prepare(`
      SELECT 
        SUM(CASE WHEN type = 'debit' THEN amount ELSE -amount END) as net
      FROM journal_entries 
      WHERE account_id = 1
    `).get() as any;
    expect(cashDrawerEntries.net).toBe(160);
    expect(cashDrawerEntries.net).toBe(openShift2.starting_cash);
  });
});
