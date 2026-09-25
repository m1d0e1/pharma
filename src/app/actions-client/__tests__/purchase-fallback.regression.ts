/** @jest-environment node */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

let sqlite: Database.Database;
let nextId = 0;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => unknown) => {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = await callback(); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }),
  generateId: jest.fn(() => `purchase-test-${++nextId}`),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'owner', pharmacy_id: null })),
  hasUserPermissionSync: jest.fn(() => true),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { updateDrug: jest.fn() } }));
jest.mock('@/lib/env', () => ({ isTauri: false }));

import { createPurchaseInvoiceAction, completePurchaseInvoiceAction, createPurchaseReturnAction, updateCompletedPurchaseInvoiceAction } from '@/app/actions-client/purchases';

const item = (cost = 10) => ({ id: 9001, quantity: 2, bonus_quantity: 1, cost_price: cost, selling_price: 20,
  expiry_date: '2028-01-31', tax_percent: 10, discount_percent: 0, strips_per_box: 1 });

describe('purchase SQLite fallback accounting and lot safety', () => {
  beforeEach(() => {
    nextId = 0;
    sqlite = new Database(':memory:');
    for (const migration of ['001_initial', '008_patient_accounting', '011_shift_cash_difference_account', '012_shortages_pharmacy_scope', '013_shift_handover_details', '018_unit_conversion_snapshots']) {
      sqlite.exec(readFileSync(`src-tauri/migrations/${migration}.sql`, 'utf8'));
    }
    sqlite.exec('ALTER TABLE inventory ADD COLUMN medium_to_small INTEGER DEFAULT 1');
    sqlite.exec('ALTER TABLE purchase_invoice_items ADD COLUMN medium_to_small INTEGER DEFAULT 1');
    sqlite.exec('ALTER TABLE shifts ADD COLUMN pharmacy_id TEXT');
    if (!(sqlite.prepare('PRAGMA table_info(purchase_invoice_items)').all() as any[]).some(column => column.name === 'barcode')) {
      sqlite.exec('ALTER TABLE purchase_invoice_items ADD COLUMN barcode TEXT');
    }
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec("INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Supplier',0)");
    sqlite.exec("INSERT INTO master_drugs(id,trade_name,trade_name_en,barcode,official_price,large_to_medium,medium_to_small) VALUES(9001,'Drug','Drug','CODE',20,1,1)");
  });
  afterEach(() => sqlite.close());

  it('keeps identical supplier numbers in separate lots and allocates the journal total over paid and bonus stock', async () => {
    const options = { supplier_id: 1, invoice_number: 'SAME', payment_method: 'credit', status: 'completed',
      tax_percent: 5, expenses: 3, discount_value: 1, discount_percent: 10 };
    const first = await createPurchaseInvoiceAction({ ...options, cart: [item()] });
    const second = await createPurchaseInvoiceAction({ ...options, cart: [item(20)] });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const rows = sqlite.prepare('SELECT pi.id,pi.total_amount,pii.inventory_id,i.batch_number,i.quantity,i.cost_price FROM purchase_invoices pi JOIN purchase_invoice_items pii ON pii.invoice_id=pi.id JOIN inventory i ON i.id=pii.inventory_id ORDER BY pi.rowid').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows[0].inventory_id).not.toBe(rows[1].inventory_id);
    for (const [index, row] of rows.entries()) {
      const expected = (((2 * (index ? 20 : 10) * 1.1 * 1.05) + 3 - 1) * .9);
      expect(row.batch_number).toBe(`PURCHASE-${row.id}`);
      expect(row.total_amount).toBeCloseTo(expected);
      expect(row.quantity * row.cost_price).toBeCloseTo(expected);
      expect(sqlite.prepare('SELECT description,total_amount FROM daily_journals WHERE description=?').get(`Purchase invoice [id=${row.id}]`)).toMatchObject({ total_amount: row.total_amount });
    }
  });

  it('completes a draft with a linked lot and the same allocated cost', async () => {
    const draft = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'draft', payment_method: 'credit',
      tax_percent: 5, expenses: 3, discount_value: 1, discount_percent: 10, cart: [item()] });
    expect(draft.success).toBe(true);
    const completed = await completePurchaseInvoiceAction(draft.id!);
    if (!completed.success) throw new Error(completed.error);
    const row = sqlite.prepare('SELECT pi.total_amount,i.cost_price,i.quantity,pii.inventory_id FROM purchase_invoices pi JOIN purchase_invoice_items pii ON pii.invoice_id=pi.id JOIN inventory i ON i.id=pii.inventory_id WHERE pi.id=?').get(draft.id) as any;
    expect(row.inventory_id).toEqual(expect.any(String));
    expect(row.cost_price * row.quantity).toBeCloseTo(row.total_amount);
    expect(await completePurchaseInvoiceAction(draft.id!)).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT quantity FROM inventory WHERE id=?').get(row.inventory_id)).toEqual({ quantity: 3 });
  });

  it('records a cash draft completion once with its full invoice ID', async () => {
    sqlite.exec("INSERT INTO shifts(id,user_id,starting_cash,status) VALUES('open-purchase','admin',0,'open')");
    const draft = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'draft', payment_method: 'cash', cart: [item()] });
    expect(draft.success).toBe(true);
    const completed = await completePurchaseInvoiceAction(draft.id!);
    if (!completed.success) throw new Error(completed.error);
    expect(await completePurchaseInvoiceAction(draft.id!)).toMatchObject({ success: false });
    expect(sqlite.prepare("SELECT amount,notes FROM cash_movements WHERE category='purchases'").all()).toEqual([
      { amount: 22, notes: `Purchase invoice [id=${draft.id}]` },
    ]);
  });

  it('rejects a repeat return past the exact invoice quantity without changing stock', async () => {
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: [item()] });
    const source = sqlite.prepare('SELECT id,inventory_id FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id) as any;
    const payload = { purchase_invoice_id: purchase.id!, supplier_id: 1, refund_method: 'credit' as const, reason: 'test',
      items: [{ purchase_invoice_item_id: source.id, inventory_id: source.inventory_id, drug_id: 9001, drug_name: 'Drug', quantity: 1.999, unit_price: 10, unit: 'large' }] };
    expect(await createPurchaseReturnAction(payload)).toMatchObject({ success: true });
    const before = sqlite.prepare('SELECT quantity FROM inventory WHERE id=?').get(source.inventory_id);
    expect(await createPurchaseReturnAction({ ...payload, items: [{ ...payload.items[0], quantity: .002 }] })).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT quantity FROM inventory WHERE id=?').get(source.inventory_id)).toEqual(before);
  });

  it('refunds stored allocated cost and bonus stock despite a forged client price', async () => {
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit',
      tax_percent: 5, expenses: 3, discount_value: 1, discount_percent: 10, cart: [item()] });
    const source = sqlite.prepare('SELECT id,inventory_id FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id) as any;
    const lotBefore = sqlite.prepare('SELECT quantity,cost_price FROM inventory WHERE id=?').get(source.inventory_id) as any;
    const result = await createPurchaseReturnAction({ purchase_invoice_id: purchase.id!, supplier_id: 1, refund_method: 'credit', reason: 'test', items: [
      { purchase_invoice_item_id: source.id, inventory_id: source.inventory_id, drug_id: 9001, drug_name: 'forged name', quantity: 1, unit_price: 999, unit: 'large' },
    ] });
    expect(result).toMatchObject({ success: true });
    const lotAfter = sqlite.prepare('SELECT quantity,cost_price FROM inventory WHERE id=?').get(source.inventory_id) as any;
    const refund = sqlite.prepare('SELECT total_amount FROM purchase_returns WHERE id=?').get(result.id) as any;
    const expected = lotBefore.cost_price * 1.5;
    expect(lotBefore.quantity - lotAfter.quantity).toBeCloseTo(1.5);
    expect(refund.total_amount).toBeCloseTo(expected);
    expect(sqlite.prepare('SELECT drug_name,unit_price,total_price FROM purchase_return_items WHERE purchase_return_id=?').get(result.id)).toMatchObject({ drug_name: 'Drug', unit_price: expected, total_price: expected });
    const journal = sqlite.prepare('SELECT id,total_amount FROM daily_journals WHERE description=?').get(`Purchase return [id=${result.id}] [invoice=${purchase.id}]`) as any;
    expect(journal.total_amount).toBeCloseTo(expected);
    expect(sqlite.prepare('SELECT account_id,type,amount FROM journal_entries WHERE journal_id=? ORDER BY type').all(journal.id)).toEqual([
      { account_id: 10, type: 'credit', amount: expected },
      { account_id: 7, type: 'debit', amount: expected },
    ]);
  });

  it('uses the same conversion for a strip alias in validation and stock deduction', async () => {
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: [{ ...item(), strips_per_box: 10 }] });
    const source = sqlite.prepare('SELECT id,inventory_id FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id) as any;
    expect(await createPurchaseReturnAction({ purchase_invoice_id: purchase.id!, supplier_id: 1, refund_method: 'credit', reason: 'test', items: [
      { purchase_invoice_item_id: source.id, inventory_id: source.inventory_id, drug_id: 9001, drug_name: 'Drug', quantity: 5, unit_price: 999, unit: 'strip' },
    ] })).toMatchObject({ success: true });
    expect(sqlite.prepare('SELECT quantity FROM inventory WHERE id=?').get(source.inventory_id)).toEqual({ quantity: 2.25 });
    expect((sqlite.prepare('SELECT total_amount FROM purchase_returns').get() as any).total_amount).toBeCloseTo(5.5);
  });

  it('rolls back a return if its inventory journal credit fails late', async () => {
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: [item()] });
    const source = sqlite.prepare('SELECT id,inventory_id FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id) as any;
    const before = sqlite.prepare('SELECT quantity FROM inventory WHERE id=?').get(source.inventory_id);
    const supplierBefore = sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get();
    sqlite.exec("CREATE TRIGGER fail_return_credit BEFORE INSERT ON journal_entries WHEN NEW.account_id=10 AND NEW.type='credit' BEGIN SELECT RAISE(ABORT,'return journal blocked'); END");
    expect(await createPurchaseReturnAction({ purchase_invoice_id: purchase.id!, supplier_id: 1, refund_method: 'credit', reason: 'test', items: [
      { purchase_invoice_item_id: source.id, inventory_id: source.inventory_id, drug_id: 9001, drug_name: 'Drug', quantity: 1, unit_price: 999, unit: 'large' },
    ] })).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT quantity FROM inventory WHERE id=?').get(source.inventory_id)).toEqual(before);
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual(supplierBefore);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_returns').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals WHERE description LIKE ?').get('Purchase return %')).toEqual({ n: 0 });
  });

  it('rolls back stock, invoice and supplier balance if a journal entry fails', async () => {
    sqlite.exec("CREATE TRIGGER fail_purchase_entry BEFORE INSERT ON journal_entries WHEN NEW.account_id=10 BEGIN SELECT RAISE(ABORT,'journal blocked'); END");
    expect(await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: [item()] })).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual({ balance: 0 });
  });

  it('rejects a zero paid base before writing stock or accounting', async () => {
    expect(await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', expenses: 5,
      cart: [item(0)] })).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
  });

  it('saves an incomplete draft while rejecting invalid completed discounts', async () => {
    expect(await createPurchaseInvoiceAction({ supplier_id: 1, status: 'draft', payment_method: 'credit', cart: [] })).toMatchObject({ success: true });
    expect(await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', discount_percent: 101, cart: [item()] })).toMatchObject({ success: false });
    expect(await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', discount_value: 1000, cart: [item()] })).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices WHERE status=?').get('completed')).toEqual({ n: 0 });
  });

  it('rejects an edit after consumption and leaves invoice, lot and journal untouched', async () => {
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: [item()] });
    expect(purchase.success).toBe(true);
    const source = sqlite.prepare('SELECT inventory_id FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id) as any;
    sqlite.prepare('UPDATE inventory SET quantity=quantity-1 WHERE id=?').run(source.inventory_id);
    const before = sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(purchase.id);
    const journalCount = sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get();
    expect(await updateCompletedPurchaseInvoiceAction({ id: purchase.id!, supplier_id: 1, payment_method: 'credit', cart: [item(99)] })).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(purchase.id)).toEqual(before);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual(journalCount);
  });

  it('rejects historical shared lots for edit and return without side effects', async () => {
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: [item()] });
    const source = sqlite.prepare('SELECT id,inventory_id FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id) as any;
    const other = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'draft', payment_method: 'credit', cart: [item()] });
    sqlite.prepare('UPDATE purchase_invoice_items SET inventory_id=? WHERE invoice_id=?').run(source.inventory_id, other.id);
    expect(await updateCompletedPurchaseInvoiceAction({ id: purchase.id!, supplier_id: 1, payment_method: 'credit', cart: [item(99)] })).toMatchObject({ success: false });
    expect(await createPurchaseReturnAction({ purchase_invoice_id: purchase.id!, supplier_id: 1, refund_method: 'credit', reason: 'test', items: [
      { purchase_invoice_item_id: source.id, inventory_id: source.inventory_id, drug_id: 9001, drug_name: 'Drug', quantity: 1, unit_price: 10, unit: 'large' },
    ] })).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT quantity FROM inventory WHERE id=?').get(source.inventory_id)).toEqual({ quantity: 3 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_returns').get()).toEqual({ n: 0 });
  });

  it('edits only its own journal when supplier invoice numbers repeat', async () => {
    const first = await createPurchaseInvoiceAction({ supplier_id: 1, invoice_number: 'SAME', status: 'completed', payment_method: 'credit', cart: [item()] });
    const second = await createPurchaseInvoiceAction({ supplier_id: 1, invoice_number: 'SAME', status: 'completed', payment_method: 'credit', cart: [item(20)] });
    const secondJournal = sqlite.prepare('SELECT id,total_amount FROM daily_journals WHERE description=?').get(`Purchase invoice [id=${second.id}]`);
    expect(await updateCompletedPurchaseInvoiceAction({ id: first.id!, supplier_id: 1, invoice_number: 'SAME', payment_method: 'credit', cart: [item(15)] })).toMatchObject({ success: true });
    expect(sqlite.prepare('SELECT id,total_amount FROM daily_journals WHERE description=?').get(`Purchase invoice [id=${second.id}]`)).toEqual(secondJournal);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE journal_id=?').get((secondJournal as any).id)).toEqual({ n: 2 });
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual({ balance: 77 });
  });
});
