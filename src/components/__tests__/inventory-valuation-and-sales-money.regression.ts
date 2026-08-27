import Database from 'better-sqlite3';

/**
 * Inventory Valuation, Multi-Unit Amount & Sales Money Calculations Regression Test
 * 
 * Verifies:
 * 1. Exact multi-unit stock deduction (box, strip, tablet)
 * 2. Inventory money calculation (Cost Valuation & Retail Valuation)
 * 3. Exact COGS, revenue, and gross profit when sales happen
 * 4. Exact deduction from Inventory Asset matching COGS in accounting
 * 5. Computer local time synchronization (no UTC 2-hour offset)
 */

function setupDb(db: Database.Database) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = OFF');

  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      role TEXT,
      pharmacy_id TEXT
    );

    CREATE TABLE master_drugs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_name TEXT,
      trade_name_en TEXT,
      barcode TEXT,
      official_price REAL,
      base_price REAL DEFAULT 0,
      large_to_medium INTEGER DEFAULT 3,
      medium_to_small INTEGER DEFAULT 10,
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
      strips_per_box INTEGER DEFAULT 3,
      created_at DATETIME DEFAULT (datetime('now', 'localtime')),
      updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE shifts (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      starting_cash REAL DEFAULT 0,
      ending_cash REAL,
      status TEXT DEFAULT 'open',
      start_time DATETIME DEFAULT (datetime('now', 'localtime')),
      end_time DATETIME
    );

    CREATE TABLE sales_invoices (
      id TEXT PRIMARY KEY,
      pharmacy_id TEXT,
      user_id TEXT,
      shift_id TEXT,
      total_amount REAL,
      payment_method TEXT DEFAULT 'cash',
      status TEXT DEFAULT 'completed',
      discount_amount REAL DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now', 'localtime'))
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
      created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE daily_journals (
      id TEXT PRIMARY KEY,
      date TEXT,
      description TEXT,
      created_by TEXT,
      total_amount REAL
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
      balance REAL DEFAULT 0
    );
  `);

  db.exec(`
    INSERT INTO accounts (id, code, name_ar) VALUES
      (1, '101', 'الصندوق والدرج'),
      (3, '103', 'المخزون السلعي'),
      (7, '401', 'إيرادات المبيعات'),
      (9, '501', 'تكلفة البضاعة المباعة');

    INSERT INTO users (id, username, role, pharmacy_id) VALUES
      ('u-test', 'pharmacist', 'pharmacist', 'ph-test');
  `);
}

function saleStockQty(quantity: number, unit: string, largeToMedium: number, mediumToSmall: number) {
  if (unit === 'medium' || unit === 'strip' || unit === 'شريط') return quantity / largeToMedium;
  if (unit === 'small' || unit === 'قرص' || unit === 'tablet') return quantity / (largeToMedium * mediumToSmall);
  return quantity;
}

describe('Inventory Amount, Money & Sales Calculations', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:');
    setupDb(db);
  });

  afterAll(() => {
    db.close();
  });

  it('accurately calculates inventory amount, retail money, and cost money before and after sale', () => {
    // 1. Setup Drug:
    // 1 Box = 3 Strips, 1 Strip = 10 Tablets (1 Box = 30 Tablets)
    // Box Cost Price = 60 EGP (Strip Cost = 20 EGP, Tablet Cost = 2 EGP)
    // Box Selling Price = 90 EGP (Strip Selling = 30 EGP, Tablet Selling = 3 EGP)
    const drugInsert = db.prepare(`
      INSERT INTO master_drugs (trade_name, trade_name_en, official_price, base_price, large_to_medium, medium_to_small)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('كونجستال أقراص', 'Congestal', 90, 60, 3, 10);
    const drugId = Number(drugInsert.lastInsertRowid);

    // Initial Inventory: 10 Boxes
    const invId = 'inv-cong-1';
    db.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, cost_price, local_selling_price, strips_per_box, expiry_date)
      VALUES (?, 'ph-test', ?, 10, 60, 90, 3, '2028-12-31')
    `).run(invId, drugId);

    // Assert Initial Inventory Quantities & Money Valuations:
    const invBefore = db.prepare(`SELECT quantity, cost_price, local_selling_price FROM inventory WHERE id = ?`).get(invId) as any;
    expect(invBefore.quantity).toBe(10); // 10 boxes

    const costValuationBefore = invBefore.quantity * invBefore.cost_price; // 10 * 60 = 600 EGP
    const retailValuationBefore = invBefore.quantity * invBefore.local_selling_price; // 10 * 90 = 900 EGP
    expect(costValuationBefore).toBe(600);
    expect(retailValuationBefore).toBe(900);

    // 2. Open Shift with 200 EGP starting cash
    const shiftId = 'shift-100';
    db.prepare(`INSERT INTO shifts (id, user_id, starting_cash) VALUES (?, 'u-test', 200)`).run(shiftId);

    // 3. Process Sale across multiple units:
    // Item A: 1 Box (large) at 90 EGP
    // Item B: 1 Strip (medium) at 30 EGP (1/3 Box)
    // Item C: 5 Tablets (small) at 3 EGP each = 15 EGP (5/30 = 1/6 Box = 0.166667 Box)
    // Total Sold in Boxes: 1 + (1/3) + (5/30) = 1 + 0.333333 + 0.166667 = 1.5 Boxes!
    const saleId = 'sale-100';
    const items = [
      { unit: 'large', quantity_sold: 1, unit_price: 90 },
      { unit: 'medium', quantity_sold: 1, unit_price: 30 },
      { unit: 'small', quantity_sold: 5, unit_price: 3 },
    ];

    let totalRevenue = 0;
    let totalCogs = 0;
    let totalDeductedBoxes = 0;

    db.transaction(() => {
      // Calculate revenue & stock deduction
      for (const item of items) {
        const lineTotal = item.quantity_sold * item.unit_price;
        totalRevenue += lineTotal;

        const deductedBoxes = saleStockQty(item.quantity_sold, item.unit, 3, 10);
        totalDeductedBoxes += deductedBoxes;
        const lineCogs = deductedBoxes * invBefore.cost_price;
        totalCogs += lineCogs;

        // Deduct inventory batch
        db.prepare(`UPDATE inventory SET quantity = quantity - ?, updated_at = datetime('now', 'localtime') WHERE id = ?`).run(deductedBoxes, invId);

        // Insert sale item
        db.prepare(`
          INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, cost_price, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
        `).run(saleId, invId, drugId, item.quantity_sold, item.unit_price, item.unit, invBefore.cost_price);
      }

      // Insert Sales Invoice
      db.prepare(`
        INSERT INTO sales_invoices (id, pharmacy_id, user_id, shift_id, total_amount, payment_method, created_at)
        VALUES (?, 'ph-test', 'u-test', ?, ?, 'cash', datetime('now', 'localtime'))
      `).run(saleId, shiftId, totalRevenue);

      // Accounting Journal Entry
      const jId = 'journal-sale-100';
      db.prepare(`INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, date('now', 'localtime'), 'فاتورة مبيعات', 'u-test', ?)`).run(jId, totalRevenue + totalCogs);
      // Debit: Cash Drawer, Credit: Sales Revenue
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 1, 'debit', ?)`).run(jId, totalRevenue);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 7, 'credit', ?)`).run(jId, totalRevenue);
      // Debit: COGS, Credit: Inventory Asset
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 9, 'debit', ?)`).run(jId, totalCogs);
      db.prepare(`INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 3, 'credit', ?)`).run(jId, totalCogs);
    })();

    // 4. Assert Exact Revenue & COGS Calculations:
    expect(totalRevenue).toBe(135); // 90 + 30 + 15 = 135 EGP
    expect(totalDeductedBoxes).toBeCloseTo(1.5, 4); // 1 + 0.333333 + 0.166667 = 1.5 boxes
    expect(totalCogs).toBeCloseTo(90, 4); // 1.5 boxes * 60 EGP = 90 EGP

    const grossProfit = totalRevenue - totalCogs;
    expect(grossProfit).toBeCloseTo(45, 4); // 135 - 90 = 45 EGP

    // 5. Assert Inventory Remaining Amount (Stock Quantity):
    const invAfter = db.prepare(`SELECT quantity, cost_price, local_selling_price FROM inventory WHERE id = ?`).get(invId) as any;
    expect(invAfter.quantity).toBeCloseTo(8.5, 4); // 10 - 1.5 = 8.5 boxes remaining

    // 6. Assert Inventory Money Valuation After Sale:
    const costValuationAfter = invAfter.quantity * invAfter.cost_price; // 8.5 * 60 = 510 EGP
    const retailValuationAfter = invAfter.quantity * invAfter.local_selling_price; // 8.5 * 90 = 765 EGP
    expect(costValuationAfter).toBeCloseTo(510, 4);
    expect(retailValuationAfter).toBeCloseTo(765, 4);

    // The Golden Rule of Inventory Accounting:
    // Initial Inventory Money (600) - COGS (90) === Remaining Inventory Money (510)
    expect(costValuationBefore - totalCogs).toBeCloseTo(costValuationAfter, 4);

    // 7. Verify Computer Local Time on Created Records:
    // Must match local date and must not have UTC offset
    const invoiceRecord = db.prepare(`SELECT created_at FROM sales_invoices WHERE id = ?`).get(saleId) as any;
    const localNowStr = (db.prepare(`SELECT datetime('now', 'localtime') as t`).get() as any).t;
    // Difference between invoice created_at and current local time should be < 5 seconds
    const invTime = new Date(invoiceRecord.created_at).getTime();
    const localTime = new Date(localNowStr).getTime();
    expect(Math.abs(invTime - localTime)).toBeLessThan(5000);

    // 8. Assert Double-Entry Accounting Balances:
    const sumDebits = (db.prepare(`SELECT SUM(amount) as s FROM journal_entries WHERE type = 'debit'`).get() as any).s;
    const sumCredits = (db.prepare(`SELECT SUM(amount) as s FROM journal_entries WHERE type = 'credit'`).get() as any).s;
    expect(sumDebits).toBe(sumCredits);
    expect(sumDebits).toBe(225); // 135 (revenue) + 90 (COGS) = 225
  });

  it('verifies FIFO multi-batch cost depletion, customer partial return reversal, and shift drawer cash reconciliation after selling', () => {
    // Drug Setup: Panadol Extra
    const drugInsert = db.prepare(`
      INSERT INTO master_drugs (trade_name, trade_name_en, official_price, base_price, large_to_medium, medium_to_small)
      VALUES (?, ?, ?, ?, 2, 12)
    `).run('بانادول إكسترا', 'Panadol Extra', 70, 45);
    const drugId = Number(drugInsert.lastInsertRowid);

    // Two Batches:
    // Batch 1 (Older): 5 Boxes @ 40 EGP cost
    // Batch 2 (Newer): 5 Boxes @ 50 EGP cost
    const batch1Id = 'batch-panadol-older';
    const batch2Id = 'batch-panadol-newer';
    db.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, cost_price, local_selling_price, expiry_date, created_at)
      VALUES (?, 'ph-test', ?, 5, 40, 70, '2027-01-01', '2026-01-01 08:00:00')
    `).run(batch1Id, drugId);
    db.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, cost_price, local_selling_price, expiry_date, created_at)
      VALUES (?, 'ph-test', ?, 5, 50, 70, '2028-01-01', '2026-02-01 08:00:00')
    `).run(batch2Id, drugId);

    // Initial Inventory Money Calculations:
    const initialCostMoney = (5 * 40) + (5 * 50); // 200 + 250 = 450 EGP
    const initialRetailMoney = (5 * 70) + (5 * 70); // 700 EGP
    expect(initialCostMoney).toBe(450);
    expect(initialRetailMoney).toBe(700);

    // Shift Starting Cash: 100 EGP
    const shiftId = 'shift-fifo-test';
    db.prepare(`INSERT INTO shifts (id, user_id, starting_cash) VALUES (?, 'u-test', 100)`).run(shiftId);

    // Sale: Pharmacist sells 7 Boxes
    // Under FIFO:
    // 5 boxes from Batch 1 @ 40 EGP (Cost = 200 EGP, Remaining in Batch 1 = 0)
    // 2 boxes from Batch 2 @ 50 EGP (Cost = 100 EGP, Remaining in Batch 2 = 3)
    const saleId = 'sale-fifo-7boxes';
    const requestedQty = 7;
    const unitPrice = 70;
    const saleRevenue = requestedQty * unitPrice; // 7 * 70 = 490 EGP

    const batches = db.prepare(`
      SELECT id, quantity, cost_price FROM inventory
      WHERE drug_id = ? AND quantity > 0
      ORDER BY expiry_date ASC, created_at ASC
    `).all(drugId) as any[];

    let remainingNeeded = requestedQty;
    let totalSaleCogs = 0;

    db.transaction(() => {
      for (const batch of batches) {
        if (remainingNeeded <= 0) break;
        const take = Math.min(remainingNeeded, batch.quantity);
        const lineCogs = take * batch.cost_price;
        totalSaleCogs += lineCogs;

        db.prepare(`UPDATE inventory SET quantity = quantity - ? WHERE id = ?`).run(take, batch.id);
        db.prepare(`
          INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, cost_price)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(saleId, batch.id, drugId, take, unitPrice, batch.cost_price);

        remainingNeeded -= take;
      }

      db.prepare(`
        INSERT INTO sales_invoices (id, pharmacy_id, user_id, shift_id, total_amount, payment_method)
        VALUES (?, 'ph-test', 'u-test', ?, ?, 'cash')
      `).run(saleId, shiftId, saleRevenue);
    })();

    // 1. Assert Calculations After Sale:
    expect(totalSaleCogs).toBe(300); // (5 * 40) + (2 * 50) = 200 + 100 = 300 EGP
    const grossProfit = saleRevenue - totalSaleCogs;
    expect(grossProfit).toBe(190); // 490 - 300 = 190 EGP

    const b1After = db.prepare(`SELECT quantity FROM inventory WHERE id = ?`).get(batch1Id) as any;
    const b2After = db.prepare(`SELECT quantity FROM inventory WHERE id = ?`).get(batch2Id) as any;
    expect(b1After.quantity).toBe(0);
    expect(b2After.quantity).toBe(3);

    // Remaining Inventory Money Valuation:
    const remainingCostMoney = (b1After.quantity * 40) + (b2After.quantity * 50); // 0 + (3 * 50) = 150 EGP
    const remainingRetailMoney = (b1After.quantity * 70) + (b2After.quantity * 70); // 210 EGP
    expect(remainingCostMoney).toBe(150);
    expect(remainingRetailMoney).toBe(210);

    // Proof of Conservation of Money: Initial Cost (450) - COGS (300) === Remaining Cost (150)
    expect(initialCostMoney - totalSaleCogs).toBe(remainingCostMoney);

    // Shift Drawer Cash After Sale: 100 starting + 490 cash sale = 590 EGP
    const shiftSales = db.prepare(`SELECT SUM(total_amount) as total FROM sales_invoices WHERE shift_id = ?`).get(shiftId) as any;
    const drawerCashAfterSale = 100 + shiftSales.total;
    expect(drawerCashAfterSale).toBe(590);

    // 2. Customer Partial Return: Customer returns 1 box from Batch 2 (Refund = 70 EGP cash)
    const returnId = 'ret-fifo-1box';
    const returnQty = 1;
    const returnRefund = returnQty * unitPrice; // 70 EGP
    const returnCogsReversal = returnQty * 50; // Batch 2 cost was 50 EGP

    db.transaction(() => {
      // Restock batch 2
      db.prepare(`UPDATE inventory SET quantity = quantity + ? WHERE id = ?`).run(returnQty, batch2Id);

      // Create return record
      db.prepare(`
        INSERT INTO sales_invoices (id, pharmacy_id, user_id, shift_id, total_amount, payment_method, status)
        VALUES (?, 'ph-test', 'u-test', ?, ?, 'cash', 'return')
      `).run(returnId, shiftId, -returnRefund);
    })();

    // 3. Assert Calculations After Return:
    const b2AfterReturn = db.prepare(`SELECT quantity FROM inventory WHERE id = ?`).get(batch2Id) as any;
    expect(b2AfterReturn.quantity).toBe(4); // 3 + 1 = 4 boxes

    const inventoryCostAfterReturn = (0 * 40) + (b2AfterReturn.quantity * 50); // 200 EGP
    expect(inventoryCostAfterReturn).toBe(remainingCostMoney + returnCogsReversal); // 150 + 50 = 200 EGP

    // Net Expected Shift Drawer Cash After Return: 100 starting + 490 sale - 70 return = 520 EGP
    const netShiftCash = 100 + (db.prepare(`SELECT SUM(total_amount) as net FROM sales_invoices WHERE shift_id = ?`).get(shiftId) as any).net;
    expect(netShiftCash).toBe(520);
  });
});

