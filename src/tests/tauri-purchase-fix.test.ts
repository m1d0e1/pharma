/**
 * Replicates the exact purchase createInvoice flow using the same
 * db wrapper pattern as src/app/actions-client/purchases.ts
 * to reproduce and verify the fix for "فشل في تسجيل الفاتورة"
 */
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

function migrate(db: Database.Database) {
  const sql = require('fs').readFileSync('src-tauri/migrations/001_initial.sql', 'utf8');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(sql);
  db.exec(require('fs').readFileSync('src-tauri/migrations/005_purchase_return_details.sql', 'utf8'));
  // Seed test data
  const hash = bcrypt.hashSync('admin', 4);
  db.prepare("UPDATE users SET pharmacy_id = 'ph-001', permissions = '{}' WHERE id = 'admin'").run();
  db.prepare("INSERT OR IGNORE INTO master_drugs (id, trade_name, trade_name_en, official_price, is_medicine, reorder_point) VALUES (1, 'Panadol', 'Panadol EN', 15, 1, 10)").run();
  db.prepare("INSERT OR IGNORE INTO master_drugs (id, trade_name, trade_name_en, official_price, is_medicine, reorder_point) VALUES (2, 'Brufen', 'Brufen EN', 25, 1, 10)").run();
  db.prepare("INSERT OR IGNORE INTO suppliers VALUES (1, 'المورد الأول', 'Supplier A', '012345', 'Cairo', 10000, datetime('now'))").run();
  db.prepare("INSERT OR IGNORE INTO accounts (id, name_ar, code, balance) VALUES (1, 'Inventory Asset', '1.1.1', 0)").run();
  db.prepare("INSERT OR IGNORE INTO accounts (id, name_ar, code, balance) VALUES (2, 'Cash Drawer', '1.2.1', 0)").run();
  db.prepare("INSERT OR IGNORE INTO accounts (id, name_ar, code, balance) VALUES (3, 'Accounts Payable', '2.1.1', 0)").run();
}

function genId() { return `fix-${Date.now()}-${Math.random().toString(36).slice(2,6)}`; }

describe('Tauri Purchase Flow Fix — Verify createPurchaseInvoiceAction SQL', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); migrate(db); });
  afterAll(() => db.close());

  it('inserts purchase_invoice header with all fields', () => {
    const id = genId();
    db.prepare(`
      INSERT INTO purchase_invoices (id, supplier_id, pharmacy_id, user_id, invoice_number, invoice_date, 
        payment_method, notes, check_number, expenses, discount_value, discount_percent, tax_percent, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, 1, 'ph-001', 'admin', 'INV-001', '2026-06-23',
      'credit', null, null, 0, 0, 0, 0, 'completed');

    const inv = db.prepare("SELECT * FROM purchase_invoices WHERE id = ?").get(id) as any;
    expect(inv).toBeDefined();
    expect(inv.supplier_id).toBe(1);
    expect(inv.status).toBe('completed');
  });

  it('inserts purchase_invoice_items with strips_per_box column', () => {
    const invId = genId();
    db.prepare("INSERT INTO purchase_invoices (id, supplier_id, status) VALUES (?, 1, 'completed')").run(invId);

    // This is the EXACT INSERT that was failing — strips_per_box column
    expect(() => {
      db.prepare(`
        INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, unit_id, expiry_date, cost_price, selling_price, bonus_quantity, tax_percent, discount_percent, strips_per_box)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(invId, 1, 100, null, null, 10, 15, 5, 0, 0, 1);
    }).not.toThrow();

    const item = db.prepare("SELECT * FROM purchase_invoice_items WHERE invoice_id = ?").get(invId) as any;
    expect(item.quantity).toBe(100);
    expect(item.bonus_quantity).toBe(5);
    expect(item.strips_per_box).toBe(1);
  });

  it('inserts purchase_return_items with drug_name and total_price', () => {
    db.prepare("INSERT INTO purchase_returns (id, supplier_id, user_id, reason, total_amount, status) VALUES ('ret-1', 1, 'admin', 'تلف', 200, 'completed')").run();
    expect(() => {
      db.prepare(`
        INSERT INTO purchase_return_items (purchase_return_id, inventory_id, drug_id, drug_name, quantity_returned, unit_price, total_price, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ret-1', null, 1, 'Panadol', 10, 20, 200, 'تلف');
    }).not.toThrow();

    const ri = db.prepare("SELECT * FROM purchase_return_items WHERE purchase_return_id = 'ret-1'").get() as any;
    expect(ri.drug_name).toBe('Panadol');
    expect(ri.total_price).toBe(200);
  });

  it('links a purchase return to its invoice, item, and expiry batch', () => {
    const invoiceId = genId();
    const inventoryId = genId();
    const returnId = genId();
    db.prepare("INSERT INTO purchase_invoices (id, supplier_id, user_id, invoice_number, invoice_date, total_amount, status) VALUES (?, 1, 'admin', 'SUP-42', '2026-07-19', 300, 'completed')").run(invoiceId);
    const purchaseItem = db.prepare("INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, expiry_date, cost_price) VALUES (?, 1, 10, '2027-08-13', 30)").run(invoiceId);
    db.prepare("INSERT INTO inventory (id, drug_id, quantity, expiry_date, batch_number) VALUES (?, 1, 8, '2027-08-13', 'B-42')").run(inventoryId);
    db.prepare("INSERT INTO purchase_returns (id, purchase_invoice_id, supplier_id, user_id, total_amount) VALUES (?, ?, 1, 'admin', 60)").run(returnId, invoiceId);
    db.prepare("INSERT INTO purchase_return_items (purchase_return_id, purchase_invoice_item_id, inventory_id, drug_id, quantity_returned, unit_price, total_price, unit) VALUES (?, ?, ?, 1, 2, 30, 60, 'large')").run(returnId, Number(purchaseItem.lastInsertRowid), inventoryId);

    const detail = db.prepare(`
      SELECT pr.purchase_invoice_id, pi.invoice_number, pri.purchase_invoice_item_id,
             pri.quantity_returned, pri.unit, i.expiry_date, i.batch_number
      FROM purchase_returns pr
      JOIN purchase_invoices pi ON pi.id = pr.purchase_invoice_id
      JOIN purchase_return_items pri ON pri.purchase_return_id = pr.id
      JOIN inventory i ON i.id = pri.inventory_id
      WHERE pr.id = ?
    `).get(returnId) as any;
    expect(detail).toMatchObject({ invoice_number: 'SUP-42', quantity_returned: 2, unit: 'large', expiry_date: '2027-08-13', batch_number: 'B-42' });
  });

  it('inserts cash_movements with correct column names', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, notes, date)
        VALUES (?, ?, ?, 'disbursement', 'purchases', ?, ?, ?)
      `).run(genId(), 'admin', null, 500, 'دفعة مورد', '2026-06-23');
    }).not.toThrow();
  });

  it('adds purchase quantity to the existing inventory row', () => {
    const existingId = genId();
    db.prepare(`
      INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price, expiry_date, batch_number, strips_per_box)
      VALUES (?, 1, 'ph-001', 10, 15, 10, '2027-01-01', 'OLD', 1)
    `).run(existingId);

    const existing = db.prepare(`
      SELECT id
      FROM inventory
      WHERE drug_id = ? AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? IS NULL))
      ORDER BY created_at ASC
      LIMIT 1
    `).get(1, 'ph-001', 'ph-001') as any;

    db.prepare(`
      UPDATE inventory
      SET quantity = quantity + ?,
          local_selling_price = ?,
          cost_price = ?,
          expiry_date = ?,
          batch_number = ?,
          strips_per_box = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(105, 15, 10, '2027-12-31', 'BATCH-001', 1, existing.id);

    const rows = db.prepare('SELECT quantity FROM inventory WHERE drug_id = 1 AND pharmacy_id = ?').all('ph-001') as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(115);
  });

  it('keeps selling price, purchase cost, and exported barcode distinct', () => {
    db.prepare("INSERT INTO inventory (id, drug_id, quantity, local_selling_price, cost_price, barcode) VALUES (?, 2, 2, 25, 10, 'INV-BC'), (?, 2, 3, 25, 20, NULL)")
      .run(genId(), genId());
    db.prepare('UPDATE master_drugs SET official_price = 30 WHERE id = 2').run();
    db.prepare('UPDATE inventory SET local_selling_price = 30 WHERE drug_id = 2').run();

    const rows = db.prepare(`
      SELECT i.local_selling_price AS selling_price,
             COALESCE(NULLIF(i.barcode, ''), NULLIF(md.barcode, ''), (
               SELECT ii.barcode FROM inventory ii
               WHERE ii.drug_id = i.drug_id AND ii.barcode IS NOT NULL AND ii.barcode != '' LIMIT 1
             )) AS barcode
      FROM inventory i JOIN master_drugs md ON md.id = i.drug_id WHERE i.drug_id = 2
    `).all() as any[];
    const purchasePrice = db.prepare('SELECT SUM(quantity * cost_price) / SUM(quantity) AS value FROM inventory WHERE drug_id = 2').get() as any;
    expect(rows.every(row => row.selling_price === 30 && row.barcode === 'INV-BC')).toBe(true);
    expect(purchasePrice.value).toBe(16);
  });

  it('restores an imported inventory barcode to the drug master too', () => {
    db.prepare(`
      INSERT INTO master_drugs (id, trade_name, barcode) VALUES (3, 'Imported', NULL)
      ON CONFLICT(id) DO UPDATE SET barcode=excluded.barcode
    `).run();
    db.prepare("INSERT INTO inventory (id, drug_id, barcode) VALUES (?, 3, '6221234567890')").run(genId());
    db.prepare(`
      UPDATE master_drugs SET barcode = (
        SELECT barcode FROM inventory WHERE drug_id = master_drugs.id AND barcode IS NOT NULL LIMIT 1
      ) WHERE id = 3
    `).run();
    expect((db.prepare('SELECT barcode FROM master_drugs WHERE id = 3').get() as any).barcode).toBe('6221234567890');
  });
});

describe('Tauri Purchase Flow — Schema Integrity', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); migrate(db); });
  afterAll(() => db.close());

  it('purchase_invoice_items has strips_per_box column', () => {
    const cols = db.prepare("PRAGMA table_info(purchase_invoice_items)").all() as any[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('strips_per_box');
  });

  it('purchase_returns table exists', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const names = tables.map(t => t.name);
    expect(names).toContain('purchase_returns');
    expect(names).toContain('purchase_return_items');
    const returnColumns = db.prepare("PRAGMA table_info(purchase_returns)").all() as any[];
    const itemColumns = db.prepare("PRAGMA table_info(purchase_return_items)").all() as any[];
    expect(returnColumns.map(c => c.name)).toContain('purchase_invoice_id');
    expect(itemColumns.map(c => c.name)).toEqual(expect.arrayContaining(['purchase_invoice_item_id', 'unit']));
  });

  it('cash_movements has notes, user_id, date columns', () => {
    const cols = db.prepare("PRAGMA table_info(cash_movements)").all() as any[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('notes');
    expect(colNames).toContain('user_id');
    expect(colNames).toContain('date');
  });

  it('repairs accounting mappings on databases upgraded from migration 1', () => {
    db.prepare('DELETE FROM trial_balance_settings').run();
    db.prepare('DELETE FROM accounts WHERE id >= 6').run();
    db.prepare("INSERT INTO accounts (id, code, name_ar, type) VALUES (6, 'custom', 'Custom', 'asset')").run();
    db.exec(require('fs').readFileSync('src-tauri/migrations/006_accounting_upgrade_seed.sql', 'utf8'));

    const mappings = db.prepare(`
      SELECT t.category, a.code FROM trial_balance_settings t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.category IN ('cash_drawer','accounts_payable','accounts_receivable','sales_revenue','inventory_asset','cogs_expense')
    `).all() as any[];
    expect(mappings).toHaveLength(6);
    expect(mappings).toContainEqual({ category: 'inventory_asset', code: '1.1.3' });
  });

  it('integrity check passes', () => {
    const result = db.pragma('integrity_check', { simple: true }) as string;
    expect(result).toBe('ok');
  });
});

describe('Tauri Purchase Flow — Full Business Transaction', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); migrate(db); });
  afterAll(() => db.close());

  it('complete purchase lifecycle: header → items → inventory → accounting', () => {
    db.pragma('foreign_keys = OFF');
    const invId = genId();
    const result = db.transaction(() => {
      // 1. Header
      db.prepare(`
        INSERT INTO purchase_invoices (id, supplier_id, pharmacy_id, user_id, invoice_number, invoice_date, payment_method, status)
        VALUES (?, 1, 'ph-001', 'admin', 'TX-TEST', '2026-06-23', 'credit', 'completed')
      `).run(invId);

      // 2. Items with strips_per_box
      db.prepare(`
        INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, cost_price, selling_price, bonus_quantity, strips_per_box)
        VALUES (?, 1, 50, 12, 17, 5, 1)
      `).run(invId);

      // 3. Inventory
      db.prepare(`
        INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price, expiry_date, strips_per_box)
        VALUES (?, 1, 'ph-001', 55, 17, 12, '2028-06-30', 1)
      `).run(genId());

      // 4. Update total
      db.prepare("UPDATE purchase_invoices SET total_amount = 600 WHERE id = ?").run(invId);

      // 5. Accounting
      const jid = genId();
      db.prepare("INSERT INTO daily_journals (id, date, description, total_amount) VALUES (?, '2026-06-23', 'TX-TEST', 600)").run(jid);
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 1, 'debit', 600)").run(jid);

      // 6. Supplier balance
      db.prepare("UPDATE suppliers SET balance = balance + 600 WHERE id = 1").run();
      db.prepare("INSERT INTO supplier_transactions (supplier_id, type, amount, reference_id) VALUES (1, 'invoice', 600, ?)").run(invId);

      return invId;
    })();

    expect(result).toBeDefined();
    const inv = db.prepare("SELECT * FROM purchase_invoices WHERE id = ?").get(invId) as any;
    expect(inv.total_amount).toBe(600);
    const supp = db.prepare("SELECT balance FROM suppliers WHERE id = 1").get() as any;
    expect(supp.balance).toBe(10600);
    const invQty = db.prepare("SELECT SUM(quantity) as qty FROM inventory WHERE drug_id = 1").get() as any;
    expect(invQty.qty).toBe(55);
  });
});
