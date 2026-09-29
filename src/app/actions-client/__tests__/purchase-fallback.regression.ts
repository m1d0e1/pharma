/** @jest-environment node */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';
import { secureCache } from '@/lib/cache/secure_cache';

let sqlite: Database.Database;
let nextId = 0;
let beforeTransactionHook: (() => void) | null = null;
let blockedPermissions = new Set<string>();

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => {
    const hook = beforeTransactionHook;
    beforeTransactionHook = null;
    hook?.();
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = await callback(mockCreateSqliteTransactionDb(sqlite)); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }),
  generateId: jest.fn(() => `purchase-test-${++nextId}`),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'owner', pharmacy_id: null })),
  hasUserPermissionSync: jest.fn((_user: any, permission: string) => !blockedPermissions.has(permission)),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { updateDrug: jest.fn() } }));
jest.mock('@/lib/env', () => ({ isTauri: false }));

import { addPurchaseInvoiceItemAction, createPurchaseInvoiceAction, completePurchaseInvoiceAction, createPurchaseReturnAction, updateCompletedPurchaseInvoiceAction } from '@/app/actions-client/purchases';

const item = (cost = 10) => ({ id: 9001, quantity: 2, bonus_quantity: 1, cost_price: cost, selling_price: 20,
  expiry_date: '2028-01-31', tax_percent: 10, discount_percent: 0, strips_per_box: 1 });
const plainItem = (cost = 10) => ({ ...item(cost), bonus_quantity: 0 });

describe('purchase SQLite fallback accounting and lot safety', () => {
  beforeEach(() => {
    nextId = 0;
    beforeTransactionHook = null;
    blockedPermissions = new Set();
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

  it('keeps each drug linked to its own stock when saved line ids overlap other drug ids', async () => {
    sqlite.exec("INSERT INTO master_drugs(id,trade_name,official_price,large_to_medium,medium_to_small) VALUES(100,'Drug100',30,1,1),(1,'Drug1',30,1,1)");
    const cart = [
      { ...plainItem(), id: 100, quantity: 2, cost_price: 10, tax_percent: 0 },
      { ...plainItem(), id: 1, quantity: 5, cost_price: 20, tax_percent: 0 },
    ];
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart });
    expect(purchase.success).toBe(true);
    expect(await updateCompletedPurchaseInvoiceAction({ id: purchase.id!, supplier_id: 1, payment_method: 'credit', notes: 'notes only', cart })).toMatchObject({ success: true });
    const rows = sqlite.prepare(`SELECT p.drug_id,i.drug_id AS stock_drug,i.quantity,i.cost_price
      FROM purchase_invoice_items p JOIN inventory i ON i.id=p.inventory_id
      WHERE p.invoice_id=? ORDER BY p.drug_id`).all(purchase.id);
    expect(rows).toEqual([
      { drug_id: 1, stock_drug: 1, quantity: 5, cost_price: 20 },
      { drug_id: 100, stock_drug: 100, quantity: 2, cost_price: 10 },
    ]);
  });

  it('rejects a purchase that changes the shared unit conversion without can_modify_unit_conversion', async () => {
    blockedPermissions.add('can_modify_unit_conversion');

    const result = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [{ ...plainItem(), quantity: 1, strips_per_box: 10 }],
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('معاملات التحويل') });
    expect(sqlite.prepare('SELECT large_to_medium FROM master_drugs WHERE id = 9001').get()).toEqual({ large_to_medium: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
  });

  it('rechecks conversion permission inside create transaction when the shared factor changes concurrently', async () => {
    blockedPermissions.add('can_modify_unit_conversion');
    beforeTransactionHook = () => {
      sqlite.prepare('UPDATE master_drugs SET large_to_medium = 2 WHERE id = 9001').run();
    };

    const result = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'draft',
      payment_method: 'credit',
      cart: [{ ...plainItem(), quantity: 1, strips_per_box: 1 }],
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('معاملات التحويل') });
    expect(sqlite.prepare('SELECT large_to_medium FROM master_drugs WHERE id = 9001').get()).toEqual({ large_to_medium: 2 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 0 });
  });

  it('rechecks archived-drug policy inside create transaction when catalog state changes concurrently', async () => {
    beforeTransactionHook = () => {
      sqlite.prepare('UPDATE master_drugs SET stop_dealing = 1 WHERE id = 9001').run();
    };

    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [plainItem()],
    })).toMatchObject({ success: false, error: expect.stringContaining('مؤرشف') });

    expect(sqlite.prepare('SELECT stop_dealing FROM master_drugs WHERE id=9001').get()).toEqual({ stop_dealing: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
  });

  it('matches native missing-master-drug rejection before purchase rows can become orphaned', async () => {
    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [{ ...plainItem(), id: 9999 }],
    })).toMatchObject({ success: false, error: expect.stringContaining('غير موجود') });

    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoice_items').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory WHERE drug_id=9999').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
  });

  it('rechecks archived-drug policy inside completed-edit transaction when catalog state changes concurrently', async () => {
    const purchase = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [plainItem()],
    });
    expect(purchase).toMatchObject({ success: true });
    const before = {
      invoice: sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(purchase.id),
      stock: sqlite.prepare('SELECT quantity,cost_price,expiry_date FROM inventory WHERE drug_id=9001').get(),
      balance: sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get(),
      journals: sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get(),
    };
    beforeTransactionHook = () => {
      sqlite.prepare('UPDATE master_drugs SET stop_dealing = 1 WHERE id = 9001').run();
    };

    expect(await updateCompletedPurchaseInvoiceAction({
      id: purchase.id!,
      supplier_id: 1,
      payment_method: 'credit',
      cart: [{ ...plainItem(), quantity: 3 }],
    })).toMatchObject({ success: false, error: expect.stringContaining('مؤرشف') });

    expect(sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(purchase.id)).toEqual(before.invoice);
    expect(sqlite.prepare('SELECT quantity,cost_price,expiry_date FROM inventory WHERE drug_id=9001').get()).toEqual(before.stock);
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual(before.balance);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual(before.journals);
  });

  it('rechecks catalog state when a saved draft is completed', async () => {
    const draft = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'draft',
      payment_method: 'credit',
      cart: [plainItem()],
    });
    expect(draft).toMatchObject({ success: true });
    sqlite.prepare('UPDATE master_drugs SET stop_dealing = 1 WHERE id = 9001').run();

    expect(await completePurchaseInvoiceAction(draft.id!))
      .toMatchObject({ success: false, error: expect.stringContaining('مؤرشف') });
    expect(sqlite.prepare('SELECT status,total_amount FROM purchase_invoices WHERE id=?').get(draft.id)).toEqual({
      status: 'draft',
      total_amount: 0,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual({ balance: 0 });
  });

  it('matches native completed-purchase expiry policy on create, draft completion, and completed edit', async () => {
    const expiredItem = { ...plainItem(), expiry_date: '2000-01-01' };

    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [expiredItem],
    })).toMatchObject({ success: false, error: expect.stringContaining('الصلاحية') });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });

    const draft = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'draft',
      payment_method: 'credit',
      cart: [expiredItem],
    });
    expect(draft).toMatchObject({ success: true });
    expect(await completePurchaseInvoiceAction(draft.id!))
      .toMatchObject({ success: false, error: expect.stringContaining('الصلاحية') });
    expect(sqlite.prepare('SELECT status FROM purchase_invoices WHERE id=?').get(draft.id)).toEqual({ status: 'draft' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });

    const completed = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [plainItem()],
    });
    expect(completed).toMatchObject({ success: true });
    const before = {
      invoice: sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(completed.id),
      stock: sqlite.prepare('SELECT quantity,expiry_date FROM inventory WHERE drug_id=9001').get(),
      journals: sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get(),
      balance: sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get(),
    };
    expect(await updateCompletedPurchaseInvoiceAction({
      id: completed.id!,
      supplier_id: 1,
      payment_method: 'credit',
      cart: [{ ...plainItem(), expiry_date: '2000-01-01' }],
    })).toMatchObject({ success: false, error: expect.stringContaining('الصلاحية') });
    expect(sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(completed.id)).toEqual(before.invoice);
    expect(sqlite.prepare('SELECT quantity,expiry_date FROM inventory WHERE drug_id=9001').get()).toEqual(before.stock);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual(before.journals);
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual(before.balance);
  });

  it('matches native duplicate-lot rejection before shared inventory can be created', async () => {
    const duplicateLot = [
      { ...plainItem(), quantity: 1, expiry_date: '2028-01-31' },
      { ...plainItem(), quantity: 2, expiry_date: '31/01/2028' },
    ];

    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: duplicateLot,
    })).toMatchObject({ success: false, error: expect.stringContaining('مكرر') });

    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoice_items').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual({ balance: 0 });
  });

  it('matches native purchase item price validation before persisting inventory', async () => {
    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [{ ...plainItem(), selling_price: -1 }],
    })).toMatchObject({ success: false });

    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
  });

  it('matches native purchase item percentage validation before persisting accounting', async () => {
    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [{ ...plainItem(), discount_percent: 101 }],
    })).toMatchObject({ success: false });

    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
  });

  it('keeps a shortage active when an unconsumed completed purchase edit is still below the reorder point', async () => {
    sqlite.prepare('UPDATE master_drugs SET reorder_point = 5 WHERE id = 9001').run();
    sqlite.prepare("INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, status) VALUES (9001, 'local_default', 10, 'pending')").run();

    const initial = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [{ ...plainItem(), quantity: 1 }],
    });
    expect(initial.success).toBe(true);
    expect(sqlite.prepare('SELECT status FROM shortages WHERE drug_id = 9001').get()).toEqual({ status: 'pending' });

    const edited = await updateCompletedPurchaseInvoiceAction({
      id: initial.id!,
      supplier_id: 1,
      payment_method: 'credit',
      cart: [{ ...plainItem(), quantity: 2 }],
    });
    expect(edited.success).toBe(true);
    expect(sqlite.prepare('SELECT SUM(quantity) AS quantity FROM inventory WHERE drug_id = 9001').get()).toEqual({ quantity: 2 });
    expect(sqlite.prepare('SELECT status FROM shortages WHERE drug_id = 9001').get()).toEqual({ status: 'pending' });
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

  it('keeps the original invoice date when posting a completed draft journal', async () => {
    const draft = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'draft',
      payment_method: 'credit',
      invoice_date: '2026-08-12',
      cart: [plainItem()],
    });
    expect(draft.success).toBe(true);

    expect(await completePurchaseInvoiceAction(draft.id!)).toMatchObject({ success: true });
    expect(sqlite.prepare('SELECT date FROM daily_journals WHERE description=?').get(`Purchase invoice [id=${draft.id}]`))
      .toEqual({ date: '2026-08-12' });
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

  it('matches native cash-purchase supplier history for completed create and draft completion', async () => {
    sqlite.exec("INSERT INTO shifts(id,user_id,starting_cash,status) VALUES('open-cash-history','admin',0,'open')");

    const completed = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'cash',
      cart: [plainItem()],
    });
    expect(completed).toMatchObject({ success: true });
    expect(sqlite.prepare(
      "SELECT type,amount FROM supplier_transactions WHERE reference_id=? ORDER BY id"
    ).all(completed.id)).toEqual([
      { type: 'invoice', amount: 22 },
      { type: 'payment', amount: -22 },
    ]);

    const draft = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'draft',
      payment_method: 'cash',
      cart: [plainItem()],
    });
    expect(draft).toMatchObject({ success: true });
    expect(await completePurchaseInvoiceAction(draft.id!)).toMatchObject({ success: true });
    expect(sqlite.prepare(
      "SELECT type,amount FROM supplier_transactions WHERE reference_id=? ORDER BY id"
    ).all(draft.id)).toEqual([
      { type: 'invoice', amount: 22 },
      { type: 'payment', amount: -22 },
    ]);
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual({ balance: 0 });
  });

  it('rechecks and claims draft status inside the transaction before any stock or accounting write', async () => {
    const draft = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'draft', payment_method: 'credit', cart: [item()] });
    expect(draft.success).toBe(true);
    beforeTransactionHook = () => {
      sqlite.prepare("UPDATE purchase_invoices SET status='completed' WHERE id=?").run(draft.id);
    };

    expect(await completePurchaseInvoiceAction(draft.id!)).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual({ balance: 0 });
  });

  it('re-reads the claimed draft header inside the transaction before calculating stock and accounting', async () => {
    const draft = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'draft',
      payment_method: 'credit',
      tax_percent: 0,
      cart: [plainItem()],
    });
    expect(draft.success).toBe(true);
    beforeTransactionHook = () => {
      sqlite.prepare('UPDATE purchase_invoices SET tax_percent = 100 WHERE id = ?').run(draft.id);
    };

    expect(await completePurchaseInvoiceAction(draft.id!)).toMatchObject({ success: true });
    const invoice = sqlite.prepare('SELECT tax_percent,total_amount FROM purchase_invoices WHERE id=?').get(draft.id) as any;
    expect(invoice.tax_percent).toBe(100);
    expect(invoice.total_amount).toBeCloseTo(44);
    expect(sqlite.prepare('SELECT SUM(quantity * cost_price) AS value FROM inventory WHERE drug_id=9001').get()).toEqual({ value: 44 });
  });

  it('does not append an unposted line to a completed purchase invoice', async () => {
    const purchase = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [plainItem()],
    });
    expect(purchase.success).toBe(true);
    const before = {
      lines: sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id),
      stock: sqlite.prepare('SELECT SUM(quantity) AS quantity FROM inventory WHERE drug_id=9001').get(),
      total: sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(purchase.id),
      balance: sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get(),
    };

    expect(await addPurchaseInvoiceItemAction(purchase.id!, {
      drug_id: 9001,
      quantity: 1,
      cost_price: 10,
      selling_price: 20,
      expiry_date: '2029-01-31',
      strips_per_box: 1,
    })).toMatchObject({ success: false });

    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id)).toEqual(before.lines);
    expect(sqlite.prepare('SELECT SUM(quantity) AS quantity FROM inventory WHERE drug_id=9001').get()).toEqual(before.stock);
    expect(sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(purchase.id)).toEqual(before.total);
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual(before.balance);
  });

  it('does not append a draft line when the invoice completes before the write starts', async () => {
    const draft = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'draft',
      payment_method: 'credit',
      cart: [plainItem()],
    });
    expect(draft.success).toBe(true);
    const beforeLines = sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoice_items WHERE invoice_id=?').get(draft.id);
    beforeTransactionHook = () => {
      sqlite.prepare("UPDATE purchase_invoices SET status = 'completed' WHERE id = ?").run(draft.id);
    };

    expect(await addPurchaseInvoiceItemAction(draft.id!, {
      drug_id: 9001,
      quantity: 1,
      cost_price: 10,
      selling_price: 20,
      expiry_date: '2029-02-28',
      strips_per_box: 1,
    })).toMatchObject({ success: false });

    expect(sqlite.prepare('SELECT status FROM purchase_invoices WHERE id=?').get(draft.id)).toEqual({ status: 'completed' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoice_items WHERE invoice_id=?').get(draft.id)).toEqual(beforeLines);
  });

  it('does not complete a check draft until a check number is present', async () => {
    const draft = await createPurchaseInvoiceAction({
      supplier_id: 1, status: 'draft', payment_method: 'check', check_number: '', cart: [item()],
    });
    expect(draft.success).toBe(true);

    expect(await completePurchaseInvoiceAction(draft.id!)).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT status FROM purchase_invoices WHERE id=?').get(draft.id)).toEqual({ status: 'draft' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
  });

  it('matches native purchase lifecycle validation for status, payment method, and completed checks', async () => {
    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'check',
      check_number: '   ',
      cart: [item()],
    })).toMatchObject({ success: false, error: expect.stringContaining('شيك') });

    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'wallet',
      cart: [item()],
    })).toMatchObject({ success: false });

    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'processing',
      payment_method: 'credit',
      cart: [item()],
    })).toMatchObject({ success: false });

    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
  });

  it('matches native default credit accounting when payment method is omitted', async () => {
    const purchase = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      cart: [plainItem()],
    });
    expect(purchase).toMatchObject({ success: true });

    const invoice = sqlite.prepare(
      'SELECT payment_method,total_amount FROM purchase_invoices WHERE id=?'
    ).get(purchase.id) as any;
    expect(invoice.payment_method).toBe('credit');
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual({
      balance: invoice.total_amount,
    });
    const supplierRows = sqlite.prepare(
      'SELECT type,amount,notes FROM supplier_transactions WHERE reference_id=? ORDER BY rowid'
    ).all(purchase.id) as any[];
    expect(supplierRows).toHaveLength(1);
    expect(supplierRows[0]).toMatchObject({ type: 'invoice', amount: invoice.total_amount });
    expect(supplierRows[0].notes).toContain('آجل');
    expect(sqlite.prepare(
      "SELECT COUNT(*) AS n FROM cash_movements WHERE category='purchases' AND notes=?"
    ).get('Purchase invoice [id=' + purchase.id + ']')).toEqual({ n: 0 });
  });

  it('matches native draft-completion atomicity when purchase audit persistence fails', async () => {
    const draft = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'draft',
      payment_method: 'credit',
      cart: [plainItem()],
    });
    expect(draft).toMatchObject({ success: true });
    sqlite.exec(
      "CREATE TRIGGER reject_complete_purchase_audit BEFORE INSERT ON activity_log " +
      "WHEN NEW.action='COMPLETE_PURCHASE' BEGIN SELECT RAISE(ABORT,'purchase audit blocked'); END"
    );

    expect(await completePurchaseInvoiceAction(draft.id!)).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT status,total_amount FROM purchase_invoices WHERE id=?').get(draft.id)).toEqual({
      status: 'draft',
      total_amount: 0,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual({ balance: 0 });
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
    (secureCache.updateDrug as jest.Mock).mockClear();
    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [{ ...item(), strips_per_box: 2 }],
    })).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual({ balance: 0 });
    expect(sqlite.prepare('SELECT large_to_medium FROM master_drugs WHERE id=9001').get()).toEqual({ large_to_medium: 1 });
    expect(secureCache.updateDrug).not.toHaveBeenCalled();
  });

  it('rejects a zero paid base before writing stock or accounting', async () => {
    expect(await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', expenses: 5,
      cart: [item(0)] })).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
  });

  it('matches native draft item policy while still allowing incomplete draft values', async () => {
    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'draft',
      payment_method: 'credit',
      cart: [],
    })).toMatchObject({ success: false });

    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'draft',
      payment_method: 'credit',
      cart: [{ ...plainItem(), quantity: 0 }],
    })).toMatchObject({ success: false });

    expect(await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'draft',
      payment_method: 'credit',
      cart: [{ ...plainItem(), cost_price: 0, expiry_date: '2000-01-01' }],
    })).toMatchObject({ success: true });
  });

  it('rejects invalid completed discounts after draft-policy validation', async () => {
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

  it('appends a signed credit adjustment for a consumed lot while retaining IDs, COGS and original posting', async () => {
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: [plainItem()] });
    const source = sqlite.prepare(`SELECT pii.*, i.quantity AS inventory_quantity, i.cost_price AS inventory_cost
      FROM purchase_invoice_items pii JOIN inventory i ON i.id=pii.inventory_id WHERE pii.invoice_id=?`).get(purchase.id) as any;
    const originalJournal = sqlite.prepare('SELECT id,total_amount FROM daily_journals WHERE description=?').get(`Purchase invoice [id=${purchase.id}]`) as any;
    sqlite.prepare('UPDATE inventory SET quantity=quantity-1 WHERE id=?').run(source.inventory_id);
    sqlite.prepare("INSERT INTO sales_invoices (id,total_amount,payment_method,status) VALUES ('historical-sale',20,'cash','completed')").run();
    sqlite.prepare(`INSERT INTO sales_items (invoice_id,inventory_id,drug_id,quantity_sold,unit_price,unit,cost_price)
      VALUES ('historical-sale',?,?,1,20,'large',?)`).run(source.inventory_id, 9001, source.inventory_cost);

    const edited = await updateCompletedPurchaseInvoiceAction({
      id: purchase.id!, supplier_id: 1, invoice_number: 'corrected-display-number', payment_method: 'credit', notes: 'corrected note',
      cart: [{ ...plainItem(), purchase_invoice_item_id: source.id, quantity: 1, selling_price: 25 }],
    });
    expect(edited).toMatchObject({ success: true });
    expect(sqlite.prepare('SELECT id,quantity,selling_price,inventory_id FROM purchase_invoice_items WHERE id=?').get(source.id)).toMatchObject({
      id: source.id, quantity: 1, selling_price: 25, inventory_id: source.inventory_id,
    });
    expect(sqlite.prepare('SELECT quantity,cost_price FROM inventory WHERE id=?').get(source.inventory_id)).toEqual({ quantity: 0, cost_price: source.inventory_cost });
    expect(sqlite.prepare('SELECT id,total_amount FROM daily_journals WHERE description=?').get(`Purchase invoice [id=${purchase.id}]`)).toEqual(originalJournal);
    expect(sqlite.prepare("SELECT cost_price FROM sales_items WHERE invoice_id='historical-sale'").get()).toEqual({ cost_price: source.inventory_cost });
    const adjustment = sqlite.prepare('SELECT id,total_amount FROM daily_journals WHERE description=?').get(`Purchase edit [id=${purchase.id}]`) as any;
    expect(adjustment.total_amount).toBeCloseTo(source.inventory_cost);
    expect(sqlite.prepare('SELECT account_id,type,amount FROM journal_entries WHERE journal_id=? ORDER BY id').all(adjustment.id)).toEqual([
      { account_id: 10, type: 'credit', amount: source.inventory_cost },
      { account_id: 7, type: 'debit', amount: source.inventory_cost },
    ]);
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get()).toEqual({ balance: 22 - source.inventory_cost });
    expect(sqlite.prepare("SELECT amount FROM supplier_transactions WHERE notes=?").get(`Purchase edit delta [id=${purchase.id}]`)).toEqual({ amount: -source.inventory_cost });
  });

  it('allows protected edits with historical conversion without permission to change the current master', async () => {
    const cartItem = { ...plainItem(), strips_per_box: 10 };
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: [cartItem] });
    expect(purchase.success).toBe(true);
    const source = sqlite.prepare('SELECT * FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id) as any;
    sqlite.prepare('UPDATE inventory SET quantity=quantity-1 WHERE id=?').run(source.inventory_id);
    sqlite.exec('UPDATE master_drugs SET large_to_medium=12 WHERE id=9001');
    blockedPermissions.add('can_modify_unit_conversion');
    const edit = (strips: number) => updateCompletedPurchaseInvoiceAction({
      id: purchase.id!, supplier_id: 1, payment_method: 'credit', notes: 'historical factor retained',
      cart: [{ ...cartItem, purchase_invoice_item_id: source.id, quantity: 3, selling_price: 25, strips_per_box: strips }],
    });
    expect(await edit(10)).toMatchObject({ success: true });
    expect(sqlite.prepare('SELECT quantity,strips_per_box,cost_price,local_selling_price FROM inventory WHERE id=?').get(source.inventory_id))
      .toEqual({ quantity: 2, strips_per_box: 10, cost_price: 11, local_selling_price: 25 });
    expect(await edit(12)).toMatchObject({ success: false, error: expect.stringContaining('immutable') });
    expect(sqlite.prepare('SELECT large_to_medium FROM master_drugs WHERE id=9001').get()).toEqual({ large_to_medium: 12 });
    expect(sqlite.prepare('SELECT quantity,strips_per_box FROM inventory WHERE id=?').get(source.inventory_id)).toEqual({ quantity: 2, strips_per_box: 10 });
  });

  it('rejects protected overdrafts and immutable cost, identity and conversion changes without side effects', async () => {
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: [item()] });
    const source = sqlite.prepare('SELECT * FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id) as any;
    sqlite.prepare('UPDATE inventory SET quantity=1 WHERE id=?').run(source.inventory_id);
    const baseline = () => ({
      invoice: sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(purchase.id),
      line: sqlite.prepare('SELECT id,quantity,cost_price,inventory_id FROM purchase_invoice_items WHERE id=?').get(source.id),
      inventory: sqlite.prepare('SELECT quantity,cost_price FROM inventory WHERE id=?').get(source.inventory_id),
      journals: sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get(),
    });
    const before = baseline();
    const edit = (line: any) => updateCompletedPurchaseInvoiceAction({ id: purchase.id!, supplier_id: 1, payment_method: 'credit', cart: [line] });
    expect(await edit({ ...item(), purchase_invoice_item_id: source.id, quantity: 0.1 })).toMatchObject({ success: false });
    expect(await edit({ ...item(11), purchase_invoice_item_id: source.id, quantity: 2 })).toMatchObject({ success: false });
    expect(await edit({ ...item(), purchase_invoice_item_id: source.id, id: 9002, quantity: 2 })).toMatchObject({ success: false });
    expect(await edit({ ...item(), purchase_invoice_item_id: source.id, strips_per_box: 2, quantity: 2 })).toMatchObject({ success: false });
    expect(await edit({ ...item(), purchase_invoice_item_id: 999, quantity: 2 })).toMatchObject({ success: false });
    expect(baseline()).toEqual(before);
  });

  it('rolls back a protected purchase edit when its appended journal cannot post', async () => {
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: [plainItem()] });
    const source = sqlite.prepare('SELECT * FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id) as any;
    sqlite.prepare('UPDATE inventory SET quantity=quantity-1 WHERE id=?').run(source.inventory_id);
    const before = {
      invoice: sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(purchase.id),
      line: sqlite.prepare('SELECT id,quantity,selling_price FROM purchase_invoice_items WHERE id=?').get(source.id),
      inventory: sqlite.prepare('SELECT quantity,local_selling_price FROM inventory WHERE id=?').get(source.inventory_id),
      supplier: sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get(),
      adjustments: sqlite.prepare("SELECT COUNT(*) AS n FROM daily_journals WHERE description LIKE 'Purchase edit [%'").get(),
    };
    sqlite.exec("CREATE TRIGGER fail_purchase_edit BEFORE INSERT ON journal_entries WHEN NEW.account_id=7 BEGIN SELECT RAISE(ABORT,'protected purchase journal blocked'); END");
    expect(await updateCompletedPurchaseInvoiceAction({ id: purchase.id!, supplier_id: 1, payment_method: 'credit', cart: [
      { ...plainItem(), purchase_invoice_item_id: source.id, quantity: 1, selling_price: 25 },
    ] })).toMatchObject({ success: false });
    expect({
      invoice: sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(purchase.id),
      line: sqlite.prepare('SELECT id,quantity,selling_price FROM purchase_invoice_items WHERE id=?').get(source.id),
      inventory: sqlite.prepare('SELECT quantity,local_selling_price FROM inventory WHERE id=?').get(source.inventory_id),
      supplier: sqlite.prepare('SELECT balance FROM suppliers WHERE id=1').get(),
      adjustments: sqlite.prepare("SELECT COUNT(*) AS n FROM daily_journals WHERE description LIKE 'Purchase edit [%'").get(),
    }).toEqual(before);
  });

  it('does not publish completed-edit cache changes before its transaction commits', async () => {
    const purchase = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [plainItem()],
    });
    expect(purchase.success).toBe(true);
    (secureCache.updateDrug as jest.Mock).mockClear();
    sqlite.exec("CREATE TRIGGER fail_completed_edit_journal BEFORE INSERT ON journal_entries WHEN NEW.account_id=10 BEGIN SELECT RAISE(ABORT,'completed edit journal blocked'); END");

    const result = await updateCompletedPurchaseInvoiceAction({
      id: purchase.id!,
      supplier_id: 1,
      payment_method: 'credit',
      cart: [{ ...plainItem(), strips_per_box: 2 }],
    });

    expect(result).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT large_to_medium FROM master_drugs WHERE id=9001').get()).toEqual({ large_to_medium: 1 });
    expect(secureCache.updateDrug).not.toHaveBeenCalled();
  });

  it('keeps closed-shift cash history and appends cash delta rows only to the current shared shift', async () => {
    sqlite.exec("INSERT OR IGNORE INTO users(id,username,role,pharmacy_id) VALUES('admin','admin','owner',NULL)");
    sqlite.exec("INSERT INTO shifts(id,user_id,starting_cash,status) VALUES('old-shift','admin',0,'open')");
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'cash', cart: [plainItem()] });
    const source = sqlite.prepare('SELECT * FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id) as any;
    sqlite.prepare("UPDATE shifts SET status='closed' WHERE id='old-shift'").run();
    sqlite.exec("INSERT INTO shifts(id,user_id,starting_cash,status) VALUES('current-shift','admin',0,'open')");
    sqlite.prepare('UPDATE inventory SET quantity=quantity-1 WHERE id=?').run(source.inventory_id);
    const originalCash = sqlite.prepare("SELECT id,shift_id,amount FROM cash_movements WHERE notes=?").get(`Purchase invoice [id=${purchase.id}]`);
    const result = await updateCompletedPurchaseInvoiceAction({ id: purchase.id!, supplier_id: 1, payment_method: 'cash', cart: [
      { ...plainItem(), purchase_invoice_item_id: source.id, quantity: 1 },
    ] });
    expect(result).toMatchObject({ success: true });
    expect(sqlite.prepare("SELECT id,shift_id,amount FROM cash_movements WHERE notes=?").get(`Purchase invoice [id=${purchase.id}]`)).toEqual(originalCash);
    expect(sqlite.prepare("SELECT shift_id,type,amount FROM cash_movements WHERE notes=?").get(`Purchase edit [id=${purchase.id}]`)).toEqual({
      shift_id: 'current-shift', type: 'receipt', amount: 11,
    });
    expect(sqlite.prepare("SELECT type,amount FROM supplier_transactions WHERE notes LIKE ? ORDER BY id").all(`Purchase edit %${purchase.id}%`)).toEqual([
      { type: 'invoice', amount: -11 }, { type: 'payment', amount: 11 },
    ]);
  });

  it('rejects a bonus-bearing protected quantity change because it would reallocate the unit cost', async () => {
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: [item()] });
    const source = sqlite.prepare('SELECT * FROM purchase_invoice_items WHERE invoice_id=?').get(purchase.id) as any;
    sqlite.prepare('UPDATE inventory SET quantity=quantity-1 WHERE id=?').run(source.inventory_id);
    const before = sqlite.prepare('SELECT quantity,total_amount FROM purchase_invoice_items pii JOIN purchase_invoices pi ON pi.id=pii.invoice_id WHERE pii.id=?').get(source.id);
    expect(await updateCompletedPurchaseInvoiceAction({ id: purchase.id!, supplier_id: 1, payment_method: 'credit', cart: [
      { ...item(), purchase_invoice_item_id: source.id, quantity: 1 },
    ] })).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT quantity,total_amount FROM purchase_invoice_items pii JOIN purchase_invoices pi ON pi.id=pii.invoice_id WHERE pii.id=?').get(source.id)).toEqual(before);
  });

  it('matches reordered protected lines by ID and preserves omitted selling prices', async () => {
    sqlite.exec("INSERT INTO master_drugs(id,trade_name,trade_name_en,official_price,large_to_medium,medium_to_small) VALUES(9002,'Other','Other',30,1,1)");
    const lines = [plainItem(), { ...plainItem(20), id: 9002, selling_price: 30 }];
    const purchase = await createPurchaseInvoiceAction({ supplier_id: 1, status: 'completed', payment_method: 'credit', cart: lines });
    expect(purchase.success).toBe(true);
    const sources = sqlite.prepare('SELECT * FROM purchase_invoice_items WHERE invoice_id=? ORDER BY id').all(purchase.id) as any[];
    sqlite.prepare('UPDATE inventory SET quantity=quantity-1 WHERE id=?').run(sources[0].inventory_id);
    const cart = sources.map((source, index) => ({ ...lines[index], purchase_invoice_item_id: source.id, quantity: 3, selling_price: undefined })).reverse();
    expect(await updateCompletedPurchaseInvoiceAction({ id: purchase.id!, supplier_id: 1, payment_method: 'credit', cart })).toMatchObject({ success: true });
    expect(sqlite.prepare('SELECT quantity,cost_price,local_selling_price FROM inventory ORDER BY drug_id').all()).toEqual([
      { quantity: 2, cost_price: 11, local_selling_price: 20 },
      { quantity: 3, cost_price: 22, local_selling_price: 30 },
    ]);
    for (const price of [-1, Infinity, NaN]) {
      expect(await updateCompletedPurchaseInvoiceAction({ id: purchase.id!, supplier_id: 1, payment_method: 'credit', cart: cart.map((line, index) => index ? line : { ...line, selling_price: price }) })).toMatchObject({ success: false });
    }
    expect(sqlite.prepare('SELECT total_amount FROM purchase_invoices WHERE id=?').get(purchase.id)).toEqual({ total_amount: 99 });
  });

  it('rechecks conversion permission inside completed-edit transaction when the shared factor changes concurrently', async () => {
    const purchase = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [plainItem()],
    });
    expect(purchase.success).toBe(true);

    blockedPermissions.add('can_modify_unit_conversion');
    beforeTransactionHook = () => {
      sqlite.prepare('UPDATE master_drugs SET large_to_medium = 2 WHERE id = 9001').run();
    };
    const result = await updateCompletedPurchaseInvoiceAction({
      id: purchase.id!,
      supplier_id: 1,
      payment_method: 'credit',
      cart: [{ ...plainItem(), strips_per_box: 1 }],
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('معاملات التحويل') });
    expect(sqlite.prepare('SELECT large_to_medium FROM master_drugs WHERE id = 9001').get()).toEqual({ large_to_medium: 2 });
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

  it('matches native completed-edit policy by ignoring non-finalized purchase returns', async () => {
    const purchase = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [item()],
    });
    expect(purchase).toMatchObject({ success: true });
    sqlite.prepare(`
      INSERT INTO purchase_returns
        (id, purchase_invoice_id, supplier_id, user_id, reason, total_amount, refund_method, status)
      VALUES ('cancelled-return', ?, 1, 'admin', 'cancelled', 0, 'credit', 'cancelled')
    `).run(purchase.id);

    expect(await updateCompletedPurchaseInvoiceAction({
      id: purchase.id!,
      supplier_id: 1,
      payment_method: 'credit',
      invoice_number: 'EDIT-AFTER-CANCELLED-RETURN',
      notes: 'allowed because the return never finalized',
      cart: [item()],
    })).toMatchObject({ success: true });

    expect(sqlite.prepare('SELECT invoice_number, notes FROM purchase_invoices WHERE id=?').get(purchase.id)).toEqual({
      invoice_number: 'EDIT-AFTER-CANCELLED-RETURN',
      notes: 'allowed because the return never finalized',
    });

    sqlite.prepare("UPDATE purchase_returns SET status='approved' WHERE id='cancelled-return'").run();
    const beforeFinalizedAttempt = sqlite.prepare(
      'SELECT invoice_number, notes, total_amount FROM purchase_invoices WHERE id=?'
    ).get(purchase.id);
    expect(await updateCompletedPurchaseInvoiceAction({
      id: purchase.id!,
      supplier_id: 1,
      payment_method: 'credit',
      invoice_number: 'MUST-NOT-APPLY',
      notes: 'must remain blocked after finalization',
      cart: [item()],
    })).toMatchObject({ success: false, error: expect.stringContaining('return') });
    expect(sqlite.prepare(
      'SELECT invoice_number, notes, total_amount FROM purchase_invoices WHERE id=?'
    ).get(purchase.id)).toEqual(beforeFinalizedAttempt);
  });

  it('matches native completed-edit policy for the same drug in distinct expiry lots', async () => {
    const first = { ...plainItem(), quantity: 1, expiry_date: '2028-01-31' };
    const second = { ...plainItem(), quantity: 2, expiry_date: '2029-01-31' };
    const purchase = await createPurchaseInvoiceAction({
      supplier_id: 1,
      status: 'completed',
      payment_method: 'credit',
      cart: [first, second],
    });
    expect(purchase).toMatchObject({ success: true });

    expect(await updateCompletedPurchaseInvoiceAction({
      id: purchase.id!,
      supplier_id: 1,
      payment_method: 'credit',
      invoice_number: 'TWO-LOTS-EDITED',
      cart: [first, second],
    })).toMatchObject({ success: true });

    expect(sqlite.prepare(
      'SELECT COUNT(*) AS n FROM purchase_invoice_items WHERE invoice_id=?'
    ).get(purchase.id)).toEqual({ n: 2 });
    expect(sqlite.prepare(`
      SELECT expiry_date, quantity
      FROM inventory
      WHERE batch_number = ?
      ORDER BY expiry_date
    `).all(`PURCHASE-${purchase.id}`)).toEqual([
      { expiry_date: '2028-01-31', quantity: 1 },
      { expiry_date: '2029-01-31', quantity: 2 },
    ]);
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
