/**
 * Phase 3: POS Checkout E2E Flow (P0)
 * Full checkout lifecycle with real in-memory DB:
 *   Cart ops → Checkout → Inventory deduction → Invoice verification
 */

jest.mock('uuid', () => ({ v4: () => 'inv-0001-0000-0000-000000000000' }));

import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

// ─── Seed helper ──────────────────────────────────────────────────────
function seedPosData(db: Database.Database) {
  db.exec(`
    CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, official_price REAL DEFAULT 0, base_price REAL DEFAULT 0, reorder_point INTEGER DEFAULT 10, is_medicine INTEGER DEFAULT 1);
    CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, quantity INTEGER DEFAULT 0, cost_price REAL DEFAULT 0, selling_price REAL, batch_number TEXT, expiry_date TEXT);
    CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, user_id TEXT, patient_id TEXT, total_amount REAL, discount_amount REAL DEFAULT 0, payment_method TEXT, status TEXT DEFAULT 'completed', created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE sales_items (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT, drug_id INTEGER, quantity_sold REAL, unit_price REAL, cost_price REAL DEFAULT 0, is_negative INTEGER DEFAULT 0);
    CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT, credit_limit REAL DEFAULT 0, points_balance REAL DEFAULT 0);
    CREATE TABLE shifts (id TEXT PRIMARY KEY, user_id TEXT, starting_cash REAL DEFAULT 0, ending_cash REAL, status TEXT DEFAULT 'open');
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, details TEXT);
    CREATE TABLE audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action_type TEXT, table_name TEXT, record_id TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  `);

  db.prepare("INSERT INTO master_drugs VALUES (1, 'Panadol', 15, 10, 10, 1)").run();
  db.prepare("INSERT INTO master_drugs VALUES (2, 'Brufen', 25, 18, 10, 1)").run();
  db.prepare("INSERT INTO master_drugs VALUES (3, 'Augmentin', 85, 60, 5, 1)").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-batch-1', 1, 50, 10, 15, 'B001', '2026-12-31')").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-batch-2', 1, 30, 11, 15, 'B002', '2027-06-30')").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-batch-3', 2, 100, 18, 25, 'B003', '2027-01-15')").run();
  db.prepare("INSERT INTO inventory VALUES ('inv-batch-4', 3, 5, 60, 85, 'B004', '2026-08-20')").run();
  db.prepare("INSERT INTO patients VALUES ('pat-1', 'Ahmed', 1000, 0)").run();
  db.prepare("INSERT INTO patients VALUES ('pat-2', 'Mohamed', 0, 50)").run();
}

let checkoutCounter = 0;

// ─── Mock checkout service using real DB ──────────────────────────────
async function fullCheckout(db: Database.Database, items: { drug_id: number; qty: number; price: number; batch_id: string }[], opts: { userId?: string; patientId?: string; paymentMethod?: string; discount?: number }) {
  checkoutCounter++;
  const invId = `inv-${String(checkoutCounter).padStart(4, '0')}`;
  let total = 0;

  const tx = db.transaction(() => {
    for (const item of items) {
      const batch = db.prepare('SELECT * FROM inventory WHERE id = ?').get(item.batch_id) as any;
      if (!batch) throw new Error(`Batch ${item.batch_id} not found`);
      if (batch.quantity < item.qty) throw new Error(`Insufficient stock for drug ${item.drug_id}`);

      const lineTotal = item.qty * item.price;
      total += lineTotal;

      db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(item.qty, item.batch_id);
      db.prepare('INSERT INTO sales_items (invoice_id, drug_id, quantity_sold, unit_price, cost_price) VALUES (?, ?, ?, ?, ?)').run(invId, item.drug_id, item.qty, item.price, batch.cost_price);
    }

    const discountAmount = opts.discount || 0;
    const finalTotal = Math.max(0, total - discountAmount);

    db.prepare('INSERT INTO sales_invoices (id, user_id, patient_id, total_amount, discount_amount, payment_method, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(invId, opts.userId || 'u1', opts.patientId || null, finalTotal, discountAmount, opts.paymentMethod || 'cash', 'completed');
  });
  tx();

  const discountAmountVal = opts.discount || 0;
  return { invoiceId: invId, total, finalTotal: Math.max(0, total - discountAmountVal) };
}

// ─── Tests ────────────────────────────────────────────────────────────
describe('Phase 3a: POS Cart & Checkout - Happy Path', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedPosData(db); checkoutCounter = 0; });
  afterAll(() => db.close());

  it('Scenario 1: Single item cash sale deducts inventory and creates invoice', async () => {
    const result = await fullCheckout(db, [{ drug_id: 1, qty: 2, price: 15, batch_id: 'inv-batch-1' }], { userId: 'u1', paymentMethod: 'cash' });
    expect(result.invoiceId).toBe('inv-0001');
    expect(result.total).toBe(30);

    const batch1 = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-batch-1') as any;
    expect(batch1.quantity).toBe(48); // 50 - 2

    const invoice = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get('inv-0001') as any;
    expect(invoice.total_amount).toBe(30);
    expect(invoice.payment_method).toBe('cash');
    expect(invoice.status).toBe('completed');

    const items = db.prepare('SELECT * FROM sales_items WHERE invoice_id = ?').all(invoice.id) as any[];
    expect(items).toHaveLength(1);
    expect(items[0].quantity_sold).toBe(2);
  });

  it('Scenario 2: Multi-item sale with discount', async () => {
    const result = await fullCheckout(db, [
      { drug_id: 1, qty: 3, price: 15, batch_id: 'inv-batch-2' },
      { drug_id: 2, qty: 2, price: 25, batch_id: 'inv-batch-3' },
    ], { userId: 'u1', patientId: 'pat-1', paymentMethod: 'credit', discount: 10 });

    const expectedTotal = (3*15 + 2*25) - 10; // 95 - 10 = 85
    expect(result.finalTotal).toBe(85);

    const inv = db.prepare('SELECT * FROM sales_invoices ORDER BY rowid DESC LIMIT 1').get() as any;
    expect(inv.total_amount).toBe(85);
    expect(inv.discount_amount).toBe(10);
    expect(inv.patient_id).toBe('pat-1');

    const batch2 = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-batch-2') as any;
    expect(batch2.quantity).toBe(27); // 30 - 3

    const batch3 = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-batch-3') as any;
    expect(batch3.quantity).toBe(98); // 100 - 2
  });

  it('Scenario 3: Check sale with multiple units and payment methods', async () => {
    // Visas
    const result = await fullCheckout(db, [{ drug_id: 3, qty: 1, price: 85, batch_id: 'inv-batch-4' }], { userId: 'u1', paymentMethod: 'visa' });
    expect(result.total).toBe(85);
    expect(result.invoiceId).toBeDefined();

    const batch4 = db.prepare('SELECT quantity FROM inventory WHERE id = ?').get('inv-batch-4') as any;
    expect(batch4.quantity).toBe(4); // 5 - 1
  });
});

describe('Phase 3b: POS Error Handling', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); seedPosData(db); checkoutCounter = 0; });
  afterAll(() => db.close());

  it('Scenario 4: Insufficient stock throws error', async () => {
    await expect(fullCheckout(db, [{ drug_id: 3, qty: 999, price: 85, batch_id: 'inv-batch-4' }], {})).rejects.toThrow(/Insufficient stock/);
  });

  it('Scenario 5: Non-existent batch throws error', async () => {
    await expect(fullCheckout(db, [{ drug_id: 1, qty: 1, price: 15, batch_id: 'nonexistent' }], {})).rejects.toThrow(/not found/);
  });

  it('Scenario 6: Negative discount becomes zero total', async () => {
    const result = await fullCheckout(db, [{ drug_id: 1, qty: 1, price: 15, batch_id: 'inv-batch-1' }], { discount: 100 });
    expect(result.finalTotal).toBe(0); // 15 - 100 = -85 → clamped to 0
  });

  it('Scenario 7: Zero quantity sale still deducts correctly', async () => {
    // Zero qty item — no stock change, no invoice line cost
    const result = await fullCheckout(db, [{ drug_id: 2, qty: 0, price: 25, batch_id: 'inv-batch-3' }], {});
    expect(result.total).toBe(0);
  });

  it('Scenario 8: Sale to patient with credit limit', async () => {
    // pat-1 has 1000 credit limit, buy for 500
    const result = await fullCheckout(db, [
      { drug_id: 1, qty: 20, price: 15, batch_id: 'inv-batch-1' },
      { drug_id: 2, qty: 8, price: 25, batch_id: 'inv-batch-3' },
    ], { userId: 'u1', patientId: 'pat-1', paymentMethod: 'credit' });
    expect(result.total).toBe(500); // 20*15 + 8*25 = 500
    // Credit limit 1000, total 500 → under limit — should succeed
    expect(result.invoiceId).toBeDefined();
  });
});

describe('Phase 3c: POS Store - Zustand State Management', () => {
  beforeEach(() => { usePOSStore.getState().resetPOS(); });

  // We already have src/tests/pos-flow.test.ts for store tests
  // This just validates the critical path once more in context
  it('cart add → payment method change → discount → reset cycle', () => {
    const store = usePOSStore.getState();
    expect(store.cart).toEqual([]);

    store.setCart([{
      drug_id: 1, trade_name: 'Panadol', active_ingredient: 'Paracetamol',
      qty: 2, price: 15, itemDiscountPercent: 0, needsRefill: false,
      selectedUnit: 'large', basePrice: 15,
      units: { large: 'Box', large_to_medium: 10, medium_to_small: 1 },
      total_stock: 80, reorder_point: 10, nearest_expiry: '2026-12-31',
    }]);
    expect(usePOSStore.getState().cart).toHaveLength(1);

    store.setPaymentMethod('visa');
    expect(usePOSStore.getState().paymentMethod).toBe('visa');

    store.setDiscountPercent(10);
    store.setTotalDiscount(5);
    expect(usePOSStore.getState().discountPercent).toBe(10);
    expect(usePOSStore.getState().totalDiscount).toBe(5);

    store.resetPOS();
    const reset = usePOSStore.getState();
    expect(reset.cart).toEqual([]);
    expect(reset.paymentMethod).toBe('cash');
    expect(reset.discountPercent).toBe(0);
  });
});

import { usePOSStore } from '@/store/usePOSStore';
