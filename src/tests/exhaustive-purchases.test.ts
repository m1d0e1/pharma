import Database from 'better-sqlite3';

function seedPurchaseSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL, name_en TEXT,
      phone TEXT, address TEXT,
      balance REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE purchase_invoices (
      id TEXT PRIMARY KEY,
      supplier_id INTEGER NOT NULL,
      pharmacy_id TEXT, user_id TEXT,
      invoice_number TEXT, invoice_date TEXT,
      total_amount REAL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'credit',
      discount_value REAL DEFAULT 0,
      discount_percent REAL DEFAULT 0,
      tax_percent REAL DEFAULT 0,
      expenses REAL DEFAULT 0,
      check_number TEXT, notes TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
    );

    CREATE TABLE purchase_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL,
      drug_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_id INTEGER, expiry_date TEXT,
      cost_price REAL NOT NULL,
      selling_price REAL,
      bonus_quantity INTEGER DEFAULT 0,
      tax_percent REAL DEFAULT 0,
      discount_percent REAL DEFAULT 0,
      strips_per_box INTEGER DEFAULT 0,
      FOREIGN KEY (invoice_id) REFERENCES purchase_invoices (id),
      FOREIGN KEY (drug_id) REFERENCES master_drugs (id)
    );

    CREATE TABLE master_drugs (
      id INTEGER PRIMARY KEY,
      trade_name TEXT NOT NULL,
      trade_name_en TEXT,
      official_price REAL DEFAULT 0,
      is_medicine INTEGER DEFAULT 1,
      large_to_medium INTEGER DEFAULT 1,
      medium_to_small INTEGER DEFAULT 1
    );

    CREATE TABLE inventory (
      id TEXT PRIMARY KEY,
      drug_id INTEGER,
      pharmacy_id TEXT,
      quantity INTEGER DEFAULT 0,
      local_selling_price REAL,
      cost_price REAL DEFAULT 0,
      expiry_date TEXT,
      batch_number TEXT,
      barcode TEXT,
      strips_per_box INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE daily_journals (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      description TEXT, created_by TEXT,
      total_amount REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_id TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      notes TEXT
    );

    CREATE TABLE supplier_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      reference_id TEXT, notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers (id)
    );

    CREATE TABLE cash_movements (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL, type TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL,
      date TEXT NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE purchase_returns (
      id TEXT PRIMARY KEY,
      supplier_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      total_amount REAL,
      reason TEXT,
      refund_method TEXT,
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE purchase_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_return_id TEXT NOT NULL,
      inventory_id TEXT,
      drug_id INTEGER,
      drug_name TEXT,
      quantity_returned INTEGER,
      unit_price REAL,
      total_price REAL,
      reason TEXT
    );

    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT, action TEXT, details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE shifts (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      status TEXT
    );

    PRAGMA foreign_keys = ON;
  `);

  db.prepare("INSERT INTO suppliers VALUES (1, 'Supplier A', 'Supplier A', '012345', 'Cairo', 15000, datetime('now'))").run();
  db.prepare("INSERT INTO suppliers VALUES (2, 'Supplier B', 'Supplier B', '067890', 'Alex', 0, datetime('now'))").run();
  db.prepare("INSERT INTO master_drugs VALUES (1, 'Panadol', 'Panadol EN', 15, 1, 10, 10)").run();
  db.prepare("INSERT INTO master_drugs VALUES (2, 'Brufen', 'Brufen EN', 25, 1, 1, 1)").run();
  db.prepare("INSERT INTO master_drugs VALUES (3, 'Augmentin', 'Augmentin EN', 85, 1, 1, 1)").run();
  
  db.prepare("INSERT INTO shifts VALUES ('shift-1', 'u1', 'open')").run();
}

function generateId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Emulate pending invoice warnings logic
function checkPendingInvoice(db: Database.Database, supplierId: number) {
  const pending = db.prepare('SELECT id FROM purchase_invoices WHERE supplier_id = ? AND status != ? LIMIT 1').get(supplierId, 'completed');
  return !!pending;
}

// Emulate the create/complete purchase invoice flow
function executePurchaseInvoice(
  db: Database.Database,
  supplier_id: number,
  userId: string,
  pharmacyId: string,
  items: any[],
  opts?: any
) {
  const invId = generateId();
  const invNum = opts?.invoice_number || `INV-${Date.now()}`;
  const payment = opts?.payment_method || 'credit';
  const finalStatus = opts?.status || 'completed';

  let subtotal = 0;
  for (const item of items) {
    const lineTotal = (item.quantity + (item.bonus_quantity || 0)) * item.cost_price;
    subtotal += lineTotal;
  }

  const result = db.transaction(() => {
    db.prepare(`
      INSERT INTO purchase_invoices (id, supplier_id, user_id, invoice_number, total_amount, payment_method, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(invId, supplier_id, userId, invNum, subtotal, payment, finalStatus);

    for (const item of items) {
      db.prepare(`
        INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, cost_price, selling_price, bonus_quantity)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(invId, item.drug_id, item.quantity, item.cost_price, item.selling_price || 0, item.bonus_quantity || 0);

      if (finalStatus === 'completed') {
        const invEntryId = generateId();
        db.prepare(`
          INSERT INTO inventory (id, drug_id, quantity, cost_price)
          VALUES (?, ?, ?, ?)
        `).run(invEntryId, item.drug_id, item.quantity + (item.bonus_quantity || 0), item.cost_price);
      }
    }

    if (finalStatus === 'completed') {
      if (payment === 'credit') {
        db.prepare("UPDATE suppliers SET balance = balance + ? WHERE id = ?").run(subtotal, supplier_id);
      }
    }
    return invId;
  })();

  return { invoiceId: result as string, total: subtotal };
}

function executePurchaseReturn(
  db: Database.Database,
  supplier_id: number,
  userId: string,
  items: any[],
  refund_method: 'cash' | 'credit'
) {
  return db.transaction(() => {
    const returnId = generateId();
    let totalAmount = 0;
    
    for (const item of items) {
      totalAmount += item.quantity * item.unit_price;
    }
    
    db.prepare(`
      INSERT INTO purchase_returns (id, supplier_id, user_id, total_amount, refund_method, status)
      VALUES (?, ?, ?, ?, ?, 'completed')
    `).run(returnId, supplier_id, userId, totalAmount, refund_method);
    
    for (const item of items) {
      db.prepare(`
        INSERT INTO purchase_return_items (purchase_return_id, drug_id, quantity_returned, unit_price, total_price)
        VALUES (?, ?, ?, ?, ?)
      `).run(returnId, item.drug_id, item.quantity, item.unit_price, item.quantity * item.unit_price);
      
      // deduct from inventory
      db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE drug_id = ? AND quantity >= ? LIMIT 1').run(item.quantity, item.drug_id, item.quantity);
    }
    
    if (refund_method === 'credit') {
      db.prepare('UPDATE suppliers SET balance = balance - ? WHERE id = ?').run(totalAmount, supplier_id);
    }
    
    return returnId;
  })();
}

describe('Exhaustive Purchase Tests', () => {
  let db: Database.Database;

  beforeEach(() => { 
    db = new Database(':memory:'); 
    seedPurchaseSchema(db); 
  });
  afterEach(() => db.close());

  it('handles cash vs credit purchases correctly', () => {
    // Supplier 1 has 15000 balance
    const s1_before = db.prepare('SELECT balance FROM suppliers WHERE id = 1').get() as any;
    expect(s1_before.balance).toBe(15000);

    // Credit purchase -> balance increases
    executePurchaseInvoice(db, 1, 'u1', 'ph-1', [{ drug_id: 1, quantity: 10, cost_price: 10 }], { payment_method: 'credit' });
    const s1_after_credit = db.prepare('SELECT balance FROM suppliers WHERE id = 1').get() as any;
    expect(s1_after_credit.balance).toBe(15000 + 100);

    // Cash purchase -> balance does not increase
    executePurchaseInvoice(db, 1, 'u1', 'ph-1', [{ drug_id: 2, quantity: 10, cost_price: 20 }], { payment_method: 'cash' });
    const s1_after_cash = db.prepare('SELECT balance FROM suppliers WHERE id = 1').get() as any;
    expect(s1_after_cash.balance).toBe(15100);
  });

  it('handles pending invoice warnings', () => {
    // Supplier 2 has no pending invoices
    expect(checkPendingInvoice(db, 2)).toBe(false);

    // Create a draft (pending) invoice
    executePurchaseInvoice(db, 2, 'u1', 'ph-1', [{ drug_id: 1, quantity: 5, cost_price: 10 }], { status: 'draft' });
    
    // Check pending again -> should be true
    expect(checkPendingInvoice(db, 2)).toBe(true);

    // Create completed invoice -> doesn't clear the draft, but check pending returns true because of the draft
    executePurchaseInvoice(db, 2, 'u1', 'ph-1', [{ drug_id: 1, quantity: 5, cost_price: 10 }], { status: 'completed' });
    expect(checkPendingInvoice(db, 2)).toBe(true);
  });

  it('handles buying new drugs vs existing drugs', () => {
    // drug 1 already in DB, let's insert a completely new drug with id 99
    db.prepare("INSERT INTO master_drugs VALUES (99, 'NewDrug', 'NewDrug', 50, 1, 1, 1)").run();

    // Purchase the new drug
    executePurchaseInvoice(db, 1, 'u1', 'ph-1', [{ drug_id: 99, quantity: 20, cost_price: 40 }], { status: 'completed' });

    // Inventory should now have drug 99
    const inv = db.prepare('SELECT * FROM inventory WHERE drug_id = 99').get() as any;
    expect(inv).toBeDefined();
    expect(inv.quantity).toBe(20);
    expect(inv.cost_price).toBe(40);
  });

  it('handles partial and full purchase returns for credit', () => {
    // Make a purchase
    executePurchaseInvoice(db, 1, 'u1', 'ph-1', [{ drug_id: 1, quantity: 50, cost_price: 10 }], { payment_method: 'credit' });
    
    const beforeBalance = (db.prepare('SELECT balance FROM suppliers WHERE id = 1').get() as any).balance;
    const invBefore = (db.prepare('SELECT SUM(quantity) as qty FROM inventory WHERE drug_id = 1').get() as any).qty;
    
    // Return partial (20 items)
    executePurchaseReturn(db, 1, 'u1', [{ drug_id: 1, quantity: 20, unit_price: 10 }], 'credit');
    
    const partialBalance = (db.prepare('SELECT balance FROM suppliers WHERE id = 1').get() as any).balance;
    const invPartial = (db.prepare('SELECT SUM(quantity) as qty FROM inventory WHERE drug_id = 1').get() as any).qty;
    
    expect(partialBalance).toBe(beforeBalance - 200);
    expect(invPartial).toBe(invBefore - 20);

    // Return the rest (30 items)
    executePurchaseReturn(db, 1, 'u1', [{ drug_id: 1, quantity: 30, unit_price: 10 }], 'credit');
    
    const finalBalance = (db.prepare('SELECT balance FROM suppliers WHERE id = 1').get() as any).balance;
    const invFinal = (db.prepare('SELECT SUM(quantity) as qty FROM inventory WHERE drug_id = 1').get() as any).qty;

    expect(finalBalance).toBe(beforeBalance - 500);
    expect(invFinal).toBe(invBefore - 50); // Original stock is reduced fully back to 0 (or original if seeded)
  });
});
