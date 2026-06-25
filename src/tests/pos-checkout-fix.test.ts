/**
 * Replicates the EXACT processCheckoutAction flow to find the
 * "فشلت معالجة عملية البيع" error. Uses the same SQL statements.
 */
import Database from 'better-sqlite3';

function migrate(db: Database.Database) {
  const fs = require('fs');
  const sql = fs.readFileSync('src-tauri/migrations/001_initial.sql', 'utf8');
  db.pragma('journal_mode = WAL');
  db.exec(sql);
  // Seed session user, patient, drug
  db.prepare("UPDATE users SET pharmacy_id = 'ph-001', permissions = '{}' WHERE id = 'admin'").run();
  db.prepare("INSERT OR IGNORE INTO master_drugs (id, trade_name, official_price, is_medicine) VALUES (1, 'Panadol', 15, 1)").run();
  db.prepare("INSERT OR IGNORE INTO master_drugs (id, trade_name, official_price, is_medicine) VALUES (2, 'Brufen', 25, 1)").run();
  db.prepare("INSERT OR IGNORE INTO patients (id, full_name, credit_limit) VALUES ('pat-1', 'Test Patient', 1000)").run();
  db.prepare("INSERT INTO inventory (id, drug_id, quantity, cost_price, local_selling_price, expiry_date) VALUES ('inv-1', 1, 50, 10, 15, '2027-12-31')").run();
  db.prepare("INSERT INTO inventory (id, drug_id, quantity, cost_price, local_selling_price, expiry_date) VALUES ('inv-2', 2, 100, 18, 25, '2027-06-30')").run();
}

describe('POS Checkout Flow — Reproduce sale error', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); migrate(db); });
  afterAll(() => db.close());

  it('Step 1: Insert invoice header', () => {
    const saleId = 'test-sale-001';
    expect(() => {
      db.prepare(`
        INSERT INTO sales_invoices (id, pharmacy_id, user_id, patient_id, shift_id, total_amount, payment_method, check_number, status, discount_amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(saleId, 'ph-001', 'admin', 'pat-1', null, 150, 'cash', null, 'completed', 20);
    }).not.toThrow();
  });

  it('Step 2: Insert sales_items', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, is_negative, cost_price, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run('test-sale-001', 'inv-1', 1, 10, 15, 'large', 0, 10);
    }).not.toThrow();
  });

  it('Step 3: Update inventory', () => {
    expect(() => {
      db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(10, 'inv-1');
    }).not.toThrow();
    const inv = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-1'").get() as any;
    expect(inv.quantity).toBe(40);
  });

  it('Step 4: Insert daily_journal', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run('jour-001', '2026-06-23', 'Test sale', 'admin', 150);
    }).not.toThrow();
  });

  it('Step 5: Insert journal_entries with debit/credit', () => {
    expect(() => {
      db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run('jour-001', 6, 'debit', 150);
      db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run('jour-001', 9, 'credit', 150);
    }).not.toThrow();
  });

  it('Step 6: Insert refill_reminders', () => {
    expect(() => {
      db.prepare(`
        INSERT INTO refill_reminders (id, patient_id, drug_id, last_sold_date, next_refill_date, created_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run('rem-001', 'pat-1', 1, '2026-06-23', '2026-07-23');
    }).not.toThrow();
  });

  it('Step 7: Update patient points', () => {
    expect(() => {
      db.prepare('UPDATE patients SET points_balance = points_balance + ? WHERE id = ?').run(150, 'pat-1');
    }).not.toThrow();
    const pat = db.prepare("SELECT points_balance FROM patients WHERE id = 'pat-1'").get() as any;
    expect(pat.points_balance).toBe(150);
  });

  it('Step 8: Complete transaction — run all steps in sequence', () => {
    const saleId = 'test-sale-002';
    const result = db.transaction(() => {
      // 1. Invoice header
      db.prepare(`
        INSERT INTO sales_invoices (id, pharmacy_id, user_id, total_amount, payment_method, status, discount_amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(saleId, 'ph-001', 'admin', 300, 'credit', 'completed', 0);

      // 2. Items + inventory
      for (const item of [{ did: 1, inv: 'inv-1', qty: 5, price: 15 },
                          { did: 2, inv: 'inv-2', qty: 3, price: 25 }]) {
        db.prepare(`
          INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, cost_price, created_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(saleId, item.inv, item.did, item.qty, item.price, item.did === 1 ? 10 : 18);
        db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(item.qty, item.inv);
      }

      // 3. Journal
      const jid = 'jour-002';
      db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, ?, ?, ?, ?)")
        .run(jid, '2026-06-23', 'Bulk test', 'admin', 300);
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)").run(jid, 6, 'debit', 300);
      db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)").run(jid, 9, 'credit', 300);

      // 4. Refill reminder
      db.prepare("INSERT INTO refill_reminders (id, patient_id, drug_id, last_sold_date, next_refill_date) VALUES (?, ?, ?, ?, ?)")
        .run('rem-002', 'pat-1', 1, '2026-06-23', '2026-07-23');

      // 5. Points
      db.prepare("UPDATE patients SET points_balance = COALESCE(points_balance, 0) + ? WHERE id = ?").run(300, 'pat-1');

      return saleId;
    })();

    expect(result).toBe('test-sale-002');

    // Verify everything
    const inv = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-1'").get() as any;
    expect(inv.quantity).toBe(35); // 40 - 5 = 35
    const inv2 = db.prepare("SELECT quantity FROM inventory WHERE id = 'inv-2'").get() as any;
    expect(inv2.quantity).toBe(97); // 100 - 3

    const si = db.prepare("SELECT COUNT(*) as c FROM sales_items WHERE invoice_id = ?").get(saleId) as any;
    expect(si.c).toBe(2);
  });
});
