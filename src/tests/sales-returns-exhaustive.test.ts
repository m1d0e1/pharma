/**
 * Test suite for Sales Returns and Purchase Returns logic and all options
 */
import Database from 'better-sqlite3';

function setupTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      permissions TEXT,
      pharmacy_id TEXT
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      wallet_balance REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS master_drugs (
      id INTEGER PRIMARY KEY,
      trade_name TEXT NOT NULL,
      trade_name_en TEXT,
      active_ingredient TEXT,
      barcode TEXT,
      large_to_medium INTEGER DEFAULT 1,
      medium_to_small INTEGER DEFAULT 1,
      no_return INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      pharmacy_id TEXT,
      drug_id INTEGER NOT NULL,
      batch_number TEXT,
      barcode TEXT,
      expiry_date TEXT,
      quantity REAL DEFAULT 0,
      unit_price REAL DEFAULT 0,
      cost_price REAL DEFAULT 0,
      strips_per_box INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales_invoices (
      id TEXT PRIMARY KEY,
      patient_id INTEGER,
      user_id TEXT,
      total_amount REAL,
      payment_method TEXT,
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL,
      inventory_id TEXT,
      drug_id INTEGER NOT NULL,
      quantity_sold REAL NOT NULL,
      unit_price REAL NOT NULL,
      cost_price REAL DEFAULT 0,
      unit TEXT DEFAULT 'large'
    );

    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      invoice_id TEXT,
      user_id TEXT,
      shift_id TEXT,
      reason TEXT,
      total_refund REAL,
      refund_method TEXT,
      status TEXT DEFAULT 'approved',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id TEXT NOT NULL,
      inventory_id TEXT,
      drug_id INTEGER,
      drug_name TEXT,
      quantity_returned REAL,
      unit_price REAL,
      total_price REAL,
      sale_item_id INTEGER,
      unit TEXT DEFAULT 'large'
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      balance REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS purchase_invoices (
      id TEXT PRIMARY KEY,
      pharmacy_id TEXT,
      invoice_number TEXT,
      supplier_id INTEGER,
      total_amount REAL,
      status TEXT DEFAULT 'completed',
      invoice_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchase_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL,
      drug_id INTEGER NOT NULL,
      barcode TEXT,
      quantity REAL NOT NULL,
      cost_price REAL DEFAULT 0,
      selling_price REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS purchase_return_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_return_id TEXT NOT NULL,
      purchase_invoice_item_id INTEGER,
      inventory_id TEXT,
      drug_id INTEGER,
      drug_name TEXT,
      quantity_returned REAL,
      unit_price REAL,
      total_price REAL,
      reason TEXT,
      unit TEXT DEFAULT 'large'
    );

    CREATE TABLE IF NOT EXISTS purchase_returns (
      id TEXT PRIMARY KEY,
      purchase_invoice_id TEXT,
      supplier_id INTEGER,
      user_id TEXT,
      reason TEXT,
      total_amount REAL,
      refund_method TEXT,
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS supplier_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER,
      type TEXT,
      amount REAL,
      reference_id TEXT,
      notes TEXT
    );
  `);

  return db;
}

describe('Sales Returns and Purchase Returns Logic', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
    db.prepare("INSERT INTO users VALUES ('usr-1', 'admin', 'admin', '{}', 'ph-1')").run();
    db.prepare("INSERT INTO patients (id, full_name, wallet_balance) VALUES (1, 'أحمد محمود', 50)").run();
    db.prepare("INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small) VALUES (101, 'Panadol Extra', 2, 10)").run();
    db.prepare("INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, unit_price, cost_price) VALUES ('inv-101', 'ph-1', 101, 10, 100, 70)").run();
    db.prepare("INSERT INTO sales_invoices (id, patient_id, user_id, total_amount, payment_method) VALUES ('inv-sales-1', 1, 'usr-1', 100, 'cash')").run();
    db.prepare("INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit_price, cost_price, unit) VALUES (1, 'inv-sales-1', 'inv-101', 101, 1, 100, 70, 'large')").run();
  });

  afterEach(() => {
    db.close();
  });

  it('updates patient wallet balance when refund_method is patient_account', () => {
    // Process return for patient_account
    const returnId = 'ret-1';
    const totalRefund = 50;

    db.transaction(() => {
      db.prepare(`
        INSERT INTO returns (id, invoice_id, user_id, reason, total_refund, refund_method, status)
        VALUES (?, 'inv-sales-1', 'usr-1', 'سبب التجربة', ?, 'patient_account', 'approved')
      `).run(returnId, totalRefund);

      db.prepare(`
        INSERT INTO return_items (return_id, inventory_id, drug_id, drug_name, quantity_returned, unit_price, sale_item_id, unit)
        VALUES (?, 'inv-101', 101, 'Panadol Extra', 0.5, 100, 1, 'large')
      `).run(returnId);

      db.prepare('UPDATE patients SET wallet_balance = wallet_balance + ? WHERE id = ?').run(totalRefund, 1);
    })();

    const patient = db.prepare('SELECT wallet_balance FROM patients WHERE id = 1').get() as any;
    expect(patient.wallet_balance).toBe(100); // initial 50 + 50 refund
  });

  it('restocks inventory when item is returned', () => {
    const initialInv = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-101'").get() as any;
    expect(initialInv.quantity).toBe(10);

    db.prepare('UPDATE inventory SET quantity = quantity + ? WHERE id = ?').run(1, 'inv-101');

    const updatedInv = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-101'").get() as any;
    expect(updatedInv.quantity).toBe(11);
  });

  it('handles purchase returns with credit refund method correctly', () => {
    db.prepare("INSERT INTO suppliers (id, name_ar, balance) VALUES (1, 'شركة الدواء', 500)").run();
    db.prepare("INSERT INTO purchase_invoices (id, supplier_id, total_amount) VALUES ('purch-1', 1, 500)").run();

    const returnId = 'pret-1';
    const refundAmount = 150;

    db.transaction(() => {
      db.prepare(`
        INSERT INTO purchase_returns (id, purchase_invoice_id, supplier_id, user_id, reason, total_amount, refund_method, status)
        VALUES (?, 'purch-1', 1, 'usr-1', 'تالف', ?, 'credit', 'completed')
      `).run(returnId, refundAmount);

      db.prepare(`
        INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id, notes)
        VALUES (1, 'return', ?, ?, 'مرتجع مشتريات')
      `).run(refundAmount, returnId);

      db.prepare('UPDATE suppliers SET balance = balance - ? WHERE id = ?').run(refundAmount, 1);
    })();

    const supplier = db.prepare('SELECT balance FROM suppliers WHERE id = 1').get() as any;
    expect(supplier.balance).toBe(350); // initial 500 - 150 credit refund
  });

  it('finds all historical receipts for a drug by barcode without 14-day limit', () => {
    // Drug with barcode
    db.prepare("INSERT INTO master_drugs (id, trade_name, barcode) VALUES (201, 'Augmentin 1g', '6221000999999')").run();
    db.prepare("INSERT INTO inventory (id, pharmacy_id, drug_id, barcode) VALUES ('inv-201', 'ph-1', 201, '6221000999999')").run();

    // Invoice from 60 days ago
    db.prepare("INSERT INTO sales_invoices (id, total_amount, created_at) VALUES ('inv-old-1', 120, datetime('now', '-60 days'))").run();
    db.prepare("INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price) VALUES ('inv-old-1', 'inv-201', 201, 1, 120)").run();

    // Invoice from today
    db.prepare("INSERT INTO sales_invoices (id, total_amount, created_at) VALUES ('inv-new-1', 240, datetime('now'))").run();
    db.prepare("INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price) VALUES ('inv-new-1', 'inv-201', 201, 2, 120)").run();

    // Another drug invoice (should not be returned)
    db.prepare("INSERT INTO master_drugs (id, trade_name, barcode) VALUES (202, 'Cataflam 50', '6221000888888')").run();
    db.prepare("INSERT INTO inventory (id, pharmacy_id, drug_id, barcode) VALUES ('inv-202', 'ph-1', 202, '6221000888888')").run();
    db.prepare("INSERT INTO sales_invoices (id, total_amount, created_at) VALUES ('inv-other-1', 50, datetime('now'))").run();
    db.prepare("INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price) VALUES ('inv-other-1', 'inv-202', 202, 1, 50)").run();

    // Search query matching barcode across all history
    const term = '6221000999999';
    const wildcard = `%${term}%`;
    const query = `
      SELECT DISTINCT si.id, si.total_amount, si.created_at
      FROM sales_invoices si
      LEFT JOIN sales_items sit ON sit.invoice_id = si.id
      LEFT JOIN master_drugs md ON sit.drug_id = md.id
      LEFT JOIN inventory inv ON sit.inventory_id = inv.id
      WHERE (si.status IS NULL OR si.status = 'completed' OR si.status = 'approved' OR si.status = '')
        AND (
          si.id LIKE ? OR
          md.trade_name LIKE ? OR
          md.barcode = ? OR
          inv.barcode = ? OR
          md.barcode LIKE ? OR
          inv.barcode LIKE ?
        )
      ORDER BY si.created_at DESC
    `;

    const results = db.prepare(query).all(wildcard, wildcard, term, term, wildcard, wildcard) as any[];

    expect(results).toHaveLength(2);
    expect(results.map(r => r.id)).toEqual(['inv-new-1', 'inv-old-1']);
  });

  it('finds all historical purchase receipts for a drug by barcode across suppliers', () => {
    db.prepare("INSERT INTO suppliers (id, name_ar) VALUES (10, 'المتحدة للتوزيع')").run();
    db.prepare("INSERT INTO suppliers (id, name_ar) VALUES (20, 'ابن سينا فارما')").run();

    db.prepare("INSERT INTO master_drugs (id, trade_name, barcode) VALUES (301, 'Concor 5mg', '6221111222333')").run();

    // Purchase invoice 1 from Supplier 10
    db.prepare("INSERT INTO purchase_invoices (id, invoice_number, supplier_id, total_amount, status, invoice_date) VALUES ('purch-inv-1', 'BILL-1001', 10, 500, 'completed', '2026-01-15')").run();
    db.prepare("INSERT INTO purchase_invoice_items (invoice_id, drug_id, barcode, quantity, cost_price) VALUES ('purch-inv-1', 301, '6221111222333', 10, 50)").run();

    // Purchase invoice 2 from Supplier 20
    db.prepare("INSERT INTO purchase_invoices (id, invoice_number, supplier_id, total_amount, status, invoice_date) VALUES ('purch-inv-2', 'BILL-2002', 20, 1000, 'completed', '2026-02-20')").run();
    db.prepare("INSERT INTO purchase_invoice_items (invoice_id, drug_id, barcode, quantity, cost_price) VALUES ('purch-inv-2', 301, '6221111222333', 20, 50)").run();

    // Purchase invoice with different drug
    db.prepare("INSERT INTO master_drugs (id, trade_name, barcode) VALUES (302, 'Panadol', '6229999999999')").run();
    db.prepare("INSERT INTO purchase_invoices (id, invoice_number, supplier_id, total_amount, status, invoice_date) VALUES ('purch-inv-3', 'BILL-3003', 10, 300, 'completed', '2026-03-01')").run();
    db.prepare("INSERT INTO purchase_invoice_items (invoice_id, drug_id, barcode, quantity, cost_price) VALUES ('purch-inv-3', 302, '6229999999999', 5, 60)").run();

    const term = '6221111222333';
    const wildcard = `%${term}%`;
    const query = `
      SELECT DISTINCT 
        i.id, i.invoice_number, i.supplier_id, i.total_amount, i.invoice_date,
        s.name_ar as supplier_name
      FROM purchase_invoices i
      LEFT JOIN suppliers s ON i.supplier_id = s.id
      LEFT JOIN purchase_invoice_items pii ON pii.invoice_id = i.id
      LEFT JOIN master_drugs md ON pii.drug_id = md.id
      WHERE (i.status = 'completed')
        AND (
          i.id LIKE ? OR
          i.invoice_number LIKE ? OR
          s.name_ar LIKE ? OR
          md.trade_name LIKE ? OR
          md.barcode = ? OR
          pii.barcode = ? OR
          md.barcode LIKE ? OR
          pii.barcode LIKE ? OR
          CAST(md.id AS TEXT) = ?
        )
      ORDER BY date(i.invoice_date) DESC
    `;

    const results = db.prepare(query).all(
      wildcard, wildcard, wildcard, wildcard,
      term, term,
      wildcard, wildcard,
      term
    ) as any[];

    expect(results).toHaveLength(2);
    expect(results.map(r => r.id)).toEqual(['purch-inv-2', 'purch-inv-1']);
    expect(results[0].supplier_name).toBe('ابن سينا فارما');
    expect(results[1].supplier_name).toBe('المتحدة للتوزيع');
  });
});
