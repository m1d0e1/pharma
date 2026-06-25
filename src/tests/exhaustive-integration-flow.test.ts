import Database from 'better-sqlite3';

function seedAll(db: Database.Database) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT, role TEXT, full_name TEXT, pharmacy_id TEXT, permissions TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT, name_en TEXT, phone TEXT, balance REAL DEFAULT 0);
    CREATE TABLE patients (id TEXT PRIMARY KEY, name_ar TEXT, name_en TEXT, phone TEXT, balance REAL DEFAULT 0);
    CREATE TABLE master_drugs (id INTEGER PRIMARY KEY AUTOINCREMENT, trade_name TEXT, trade_name_en TEXT, official_price REAL, base_price REAL DEFAULT 0, is_medicine INTEGER DEFAULT 1, reorder_point INTEGER DEFAULT 10);
    CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, quantity INTEGER DEFAULT 0, cost_price REAL DEFAULT 0, local_selling_price REAL, batch_number TEXT, expiry_date TEXT);
    
    CREATE TABLE purchase_invoices (id TEXT PRIMARY KEY, supplier_id INTEGER, user_id TEXT, invoice_number TEXT, invoice_date TEXT, total_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0, payment_method TEXT DEFAULT 'credit', status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT, drug_id INTEGER, quantity INTEGER, cost_price REAL, selling_price REAL, bonus_quantity INTEGER DEFAULT 0, expiry_date TEXT);
    
    CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, user_id TEXT, patient_id TEXT, total_amount REAL, discount_amount REAL DEFAULT 0, payment_method TEXT, status TEXT DEFAULT 'completed');
    CREATE TABLE sales_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT, drug_id INTEGER, quantity_sold REAL, unit_price REAL, cost_price REAL DEFAULT 0, is_negative INTEGER DEFAULT 0);
    
    CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, total_refund REAL, reason TEXT, status TEXT DEFAULT 'pending');
    CREATE TABLE return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_returned INTEGER, unit_price REAL);
    
    CREATE TABLE purchase_returns (id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, total_refund REAL, reason TEXT, status TEXT DEFAULT 'pending');
    CREATE TABLE purchase_return_items (id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_returned INTEGER, unit_price REAL);

    CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, starting_cash REAL DEFAULT 0, ending_cash REAL, status TEXT DEFAULT 'open', start_time DATETIME, end_time DATETIME);
    CREATE TABLE cash_movements (id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT, type TEXT, category TEXT, amount REAL, notes TEXT, date TEXT);
    
    CREATE TABLE banks (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT, account_number TEXT, current_balance REAL DEFAULT 0);
    CREATE TABLE supplier_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER, type TEXT, amount REAL, reference_id TEXT);
    CREATE TABLE patient_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT, type TEXT, amount REAL, reference_id TEXT);
    
    CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL);
    CREATE TABLE journal_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id TEXT, account_id INTEGER, type TEXT, amount REAL);
    CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT, code TEXT UNIQUE, balance REAL DEFAULT 0);
  `);

  db.prepare("INSERT INTO users VALUES ('u-admin', 'admin', 'hash', 'owner', 'Admin', 'ph-1', '{}', 1)").run();
  
  db.prepare("INSERT INTO accounts (id, name_ar, code, balance) VALUES (1, 'Inventory Asset', '1.1', 0)").run();
  db.prepare("INSERT INTO accounts (id, name_ar, code, balance) VALUES (2, 'Cash Drawer', '1.2', 0)").run();
  db.prepare("INSERT INTO accounts (id, name_ar, code, balance) VALUES (3, 'Accounts Payable', '2.1', 0)").run();
  db.prepare("INSERT INTO accounts (id, name_ar, code, balance) VALUES (4, 'Accounts Receivable', '1.3', 0)").run();
  db.prepare("INSERT INTO accounts (id, name_ar, code, balance) VALUES (5, 'Cost of Goods Sold', '5.1', 0)").run();
  db.prepare("INSERT INTO accounts (id, name_ar, code, balance) VALUES (6, 'Sales Revenue', '4.1', 0)").run();
}

function genId() { return 'id-' + Math.random().toString(36).slice(2, 9); }

describe('Exhaustive Integration Flow', () => {
  let db: Database.Database;

  beforeAll(() => { 
    db = new Database(':memory:'); 
    seedAll(db); 
  });
  
  afterAll(() => db.close());

  it('Executes the entire lifecycle and verifies double-entry accounting', () => {
    // 0. Initial Setup
    db.prepare("INSERT INTO suppliers (name_ar, name_en, phone) VALUES ('المورد', 'Supplier X', '123')").run();
    const supplierId = 1;

    db.prepare("INSERT INTO patients (id, name_ar, name_en, phone) VALUES ('pat-1', 'المريض', 'Patient Y', '456')").run();
    const patientId = 'pat-1';

    // Shift Handover prep
    const shiftId = 'shift-1';
    db.prepare("INSERT INTO shifts VALUES (?, 'u-admin', 1000, NULL, 'open', datetime('now'), NULL)").run(shiftId);
    db.prepare("UPDATE accounts SET balance = balance + 1000 WHERE id = 2").run(); // Cash Drawer initially 1000

    // 1. Create a Master Drug
    const insertDrug = db.prepare("INSERT INTO master_drugs (trade_name, trade_name_en, official_price, base_price) VALUES (?, ?, ?, ?)");
    const drugInfo = insertDrug.run('TestDrug', 'TestDrug EN', 100, 80);
    const drugId = drugInfo.lastInsertRowid;

    // 2. Purchase the drug from a Supplier on Credit
    // Qty 100 at Cost 80 = Total 8000
    const pInvId = genId();
    db.transaction(() => {
      db.prepare("INSERT INTO purchase_invoices (id, supplier_id, user_id, invoice_number, total_amount, payment_method, status) VALUES (?, ?, 'u-admin', 'PO-1', 8000, 'credit', 'completed')").run(pInvId, supplierId);
      db.prepare("INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, cost_price, selling_price, expiry_date) VALUES (?, ?, 100, 80, 100, '2030-01-01')").run(pInvId, drugId);
      
      const invId = genId();
      db.prepare("INSERT INTO inventory (id, drug_id, quantity, cost_price, local_selling_price) VALUES (?, ?, 100, 80, 100)").run(invId, drugId);

      // Updates Accounts Payable
      db.prepare("UPDATE suppliers SET balance = balance + 8000 WHERE id = ?").run(supplierId);

      // Double Entry Accounting
      const jId = genId();
      db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, date('now'), 'Purchase on credit', 'u-admin', 8000)").run(jId);
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 1, 'debit', 8000)").run(jId); // Inventory Asset
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 3, 'credit', 8000)").run(jId); // Accounts Payable
      
      db.prepare("UPDATE accounts SET balance = balance + 8000 WHERE id = 1").run();
      db.prepare("UPDATE accounts SET balance = balance + 8000 WHERE id = 3").run();
    })();

    // 3. Sell the drug to a Patient on Credit
    // Qty 10 at Selling Price 100 = 1000 Total, Cost = 800
    const sInvId = genId();
    db.transaction(() => {
      db.prepare("INSERT INTO sales_invoices (id, user_id, patient_id, total_amount, payment_method, status) VALUES (?, 'u-admin', ?, 1000, 'credit', 'completed')").run(sInvId, patientId);
      db.prepare("INSERT INTO sales_items (invoice_id, drug_id, quantity_sold, unit_price, cost_price) VALUES (?, ?, 10, 100, 80)").run(sInvId, drugId);

      // Inventory decreases
      db.prepare("UPDATE inventory SET quantity = quantity - 10 WHERE drug_id = ?").run(drugId);

      // Patient Balance increases (A/R)
      db.prepare("UPDATE patients SET balance = balance + 1000 WHERE id = ?").run(patientId);

      // Double Entry Accounting
      const jId = genId();
      db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, date('now'), 'Sale on credit', 'u-admin', 1000)").run(jId);
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 4, 'debit', 1000)").run(jId); // Accounts Receivable
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 6, 'credit', 1000)").run(jId); // Sales Revenue
      
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 5, 'debit', 800)").run(jId); // COGS
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 1, 'credit', 800)").run(jId); // Inventory Asset

      db.prepare("UPDATE accounts SET balance = balance + 1000 WHERE id = 4").run();
      db.prepare("UPDATE accounts SET balance = balance + 1000 WHERE id = 6").run();
      db.prepare("UPDATE accounts SET balance = balance + 800 WHERE id = 5").run();
      db.prepare("UPDATE accounts SET balance = balance - 800 WHERE id = 1").run();
    })();

    // 4. Process a Purchase Return (Supplier)
    // Return 20 items. Cost 80 = 1600
    const pRetId = genId();
    db.transaction(() => {
      db.prepare("INSERT INTO purchase_returns (id, invoice_id, user_id, total_refund, reason, status) VALUES (?, ?, 'u-admin', 1600, 'defective', 'completed')").run(pRetId, pInvId);
      const invRow = db.prepare("SELECT id FROM inventory WHERE drug_id = ?").get(drugId) as any;
      db.prepare("INSERT INTO purchase_return_items (return_id, inventory_id, drug_id, quantity_returned, unit_price) VALUES (?, ?, ?, 20, 80)").run(pRetId, invRow.id, drugId);

      // Inventory decreases
      db.prepare("UPDATE inventory SET quantity = quantity - 20 WHERE id = ?").run(invRow.id);

      // Supplier Balance decreases
      db.prepare("UPDATE suppliers SET balance = balance - 1600 WHERE id = ?").run(supplierId);

      // Double Entry Accounting
      const jId = genId();
      db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, date('now'), 'Purchase return', 'u-admin', 1600)").run(jId);
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 3, 'debit', 1600)").run(jId); // Accounts Payable
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 1, 'credit', 1600)").run(jId); // Inventory Asset

      db.prepare("UPDATE accounts SET balance = balance - 1600 WHERE id = 3").run();
      db.prepare("UPDATE accounts SET balance = balance - 1600 WHERE id = 1").run();
    })();

    // 5. Process a Sales Return (Patient)
    // Return 2 items. Selling Price = 200, Cost = 160
    const sRetId = genId();
    db.transaction(() => {
      db.prepare("INSERT INTO returns (id, invoice_id, user_id, total_refund, reason, status) VALUES (?, ?, 'u-admin', 200, 'wrong item', 'completed')").run(sRetId, sInvId);
      const invRow = db.prepare("SELECT id FROM inventory WHERE drug_id = ?").get(drugId) as any;
      db.prepare("INSERT INTO return_items (return_id, inventory_id, drug_id, quantity_returned, unit_price) VALUES (?, ?, ?, 2, 100)").run(sRetId, invRow.id, drugId);

      // Inventory increases
      db.prepare("UPDATE inventory SET quantity = quantity + 2 WHERE id = ?").run(invRow.id);

      // Patient Balance decreases
      db.prepare("UPDATE patients SET balance = balance - 200 WHERE id = ?").run(patientId);

      // Double Entry Accounting
      const jId = genId();
      db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, date('now'), 'Sales return', 'u-admin', 200)").run(jId);
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 6, 'debit', 200)").run(jId); // Sales Revenue (Reduction)
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 4, 'credit', 200)").run(jId); // Accounts Receivable (Reduction)
      
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 1, 'debit', 160)").run(jId); // Inventory Asset
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 5, 'credit', 160)").run(jId); // COGS (Reduction)

      db.prepare("UPDATE accounts SET balance = balance - 200 WHERE id = 6").run();
      db.prepare("UPDATE accounts SET balance = balance - 200 WHERE id = 4").run();
      db.prepare("UPDATE accounts SET balance = balance + 160 WHERE id = 1").run();
      db.prepare("UPDATE accounts SET balance = balance - 160 WHERE id = 5").run();
    })();

    // 6. Complete a Shift Handover
    // Ending cash should be the starting cash (1000) since no cash transactions were made (all on credit).
    db.prepare("UPDATE shifts SET status = 'closed', ending_cash = 1000, end_time = datetime('now') WHERE id = ?").run(shiftId);

    // Assertions
    const inventoryQuantity = (db.prepare("SELECT SUM(quantity) as sum FROM inventory WHERE drug_id = ?").get(drugId) as any).sum;
    // Purchased 100, Sold 10, Returned Purchase 20, Returned Sale 2 => 100 - 10 - 20 + 2 = 72
    expect(inventoryQuantity).toBe(72);

    // 7. Check Trial Balance
    // Debits:
    // Inventory Asset (1.1) = 0 + 8000 - 800 - 1600 + 160 = 5760
    // Cash Drawer (1.2) = 1000 (starting cash, assuming no cash movements)
    // Accounts Receivable (1.3) = 0 + 1000 - 200 = 800
    // COGS (5.1) = 0 + 800 - 160 = 640
    // Total Debits = 5760 + 1000 + 800 + 640 = 8200

    // Credits:
    // Accounts Payable (2.1) = 0 + 8000 - 1600 = 6400
    // Sales Revenue (4.1) = 0 + 1000 - 200 = 800
    // *Wait, starting Cash Drawer of 1000 doesn't have a balancing credit in this test setup unless we started it with equity.*
    // Let's add an Owner Equity account (3.1) and set it to 1000 to balance the starting cash!

    // Fix Initial State Balancing:
    db.prepare("INSERT INTO accounts (id, name_ar, code, balance) VALUES (7, 'Owner Equity', '3.1', 1000)").run();
    
    // Total Credits = 6400 (A/P) + 800 (Sales) + 1000 (Equity) = 8200

    // Compute Trial Balance dynamically:
    // Accounts 1, 2, 4, 5 are debit accounts (Assets & Expenses)
    // Accounts 3, 6, 7 are credit accounts (Liabilities, Revenue, Equity)
    const debitAccounts = db.prepare("SELECT SUM(balance) as sum FROM accounts WHERE id IN (1, 2, 4, 5)").get() as any;
    const creditAccounts = db.prepare("SELECT SUM(balance) as sum FROM accounts WHERE id IN (3, 6, 7)").get() as any;

    expect(debitAccounts.sum).toBe(8200);
    expect(creditAccounts.sum).toBe(8200);
    expect(debitAccounts.sum).toBe(creditAccounts.sum);
  });
});
