/** @jest-environment node */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { createFunctionTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

// All writes in this suite go to a fresh anonymous SQLite :memory: database.
// The actor is an explicitly synthetic action-adapter fixture, NOT an authenticated
// native/Tauri session. Native authenticated posting is not simulated.
let sqlite: Database.Database;
let actor: { id: string; role: string; pharmacy_id: string; permissions: Record<string, boolean> } | null;
let seq = 0;
let rejectStockInsert = false;

jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => actor),
  hasUserPermissionSync: jest.fn((user: typeof actor, key: string) =>
    Boolean(user && user.permissions[key])),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { updateDrug: jest.fn(), reload: jest.fn(), getAllDrugs: jest.fn(() => []) },
}));
jest.mock('@/lib/db/tauri', () => ({
  generateId: jest.fn(() => `${String(++seq).padStart(8, '0')}-fixture`),
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: (db: unknown) => Promise<unknown>) => {
    sqlite.exec('BEGIN IMMEDIATE');
    const db = createFunctionTransactionDb({
      select: (sql, params = []) => sqlite.prepare(sql).all(...params),
      get: (sql, params = []) => sqlite.prepare(sql).get(...params) ?? null,
      execute: (sql, params = []) => {
        if (rejectStockInsert && /INSERT\s+INTO\s+inventory\b/i.test(sql)) {
          throw new Error('fictional stock writer unavailable');
        }
        const result = sqlite.prepare(sql).run(...params);
        return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
      },
    });
    try {
      const result = await callback(db);
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  }),
}));

// Imported only after the test-boundary mocks are installed.
import {
  createPurchaseOrderAction,
  getPurchaseOrdersAction,
  updatePurchaseOrderStatusAction,
  createPurchaseInvoiceAction,
  completePurchaseInvoiceAction,
  getSupplierTransactionsAction,
} from '@/app/actions-client/purchases';

const asTenant = (pharmacy_id: 'fictional-tenant-a' | 'fictional-tenant-b') => {
  actor = {
    id: pharmacy_id === 'fictional-tenant-a' ? 'actor-a' : 'actor-b',
    role: 'pharmacist',
    pharmacy_id,
    permissions: { can_view_restock: true, can_view_purchases: true, can_view_suppliers: true },
  };
};
const invoiceCart = (quantity: number) => [{
  id: 701, quantity, bonus_quantity: 0, cost_price: 2, selling_price: 3,
  expiry_date: '2099-12-31', strips_per_box: 1, tax_percent: 0, discount_percent: 0,
}];
const createOrder = (quantity = 8) =>
  createPurchaseOrderAction({
    supplier_name: 'Fictional Supplier', items: [{ drug_id: 701, quantity, expected_price: 2 }],
  });

describe('fictional tenant PO, independent receiving and supplier-statement contract', () => {
  beforeEach(() => {
    seq = 0;
    rejectStockInsert = false;
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
    sqlite.exec(readFileSync('src-tauri/migrations/012_shortages_pharmacy_scope.sql', 'utf8'));
    sqlite.exec(readFileSync('src-tauri/migrations/013_shift_handover_details.sql', 'utf8'));
    sqlite.exec(readFileSync('src-tauri/migrations/018_unit_conversion_snapshots.sql', 'utf8'));
    sqlite.exec('ALTER TABLE purchase_orders ADD COLUMN pharmacy_id TEXT');
    sqlite.exec('ALTER TABLE inventory ADD COLUMN medium_to_small INTEGER DEFAULT 1');
    sqlite.exec('ALTER TABLE purchase_invoice_items ADD COLUMN medium_to_small INTEGER DEFAULT 1');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      INSERT INTO users(id,username,role,pharmacy_id) VALUES
        ('actor-a','fictional-A','pharmacist','fictional-tenant-a'),
        ('actor-b','fictional-B','pharmacist','fictional-tenant-b');
      INSERT INTO suppliers(id,name_ar,balance) VALUES (31,'Fictional Supplier',0);
      INSERT INTO master_drugs(id,trade_name,trade_name_en,official_price,large_to_medium,medium_to_small)
        VALUES (701,'Synthetic Item','Synthetic Item',3,1,1);
      INSERT INTO shortages(drug_id,pharmacy_id,requested_quantity,status)
        VALUES (701,'fictional-tenant-a',8,'pending'),
               (701,'fictional-tenant-b',5,'pending');
    `);
    asTenant('fictional-tenant-a');
  });
  afterEach(() => sqlite.close());

  it('limits order listing, close and cancellation to the owning fictional tenant', async () => {
    const po = await createOrder();
    expect(po.success).toBe(true);
    expect(sqlite.prepare('SELECT pharmacy_id,status FROM purchase_orders WHERE id=?').get(po.po_id))
      .toEqual({ pharmacy_id: 'fictional-tenant-a', status: 'pending' });
    expect(sqlite.prepare('SELECT status,requested_quantity FROM shortages WHERE pharmacy_id=?')
      .get('fictional-tenant-b')).toEqual({ status: 'pending', requested_quantity: 5 });

    asTenant('fictional-tenant-b');
    expect((await getPurchaseOrdersAction()).data).toEqual([]);
    expect(await updatePurchaseOrderStatusAction(po.po_id!, 'cancelled'))
      .toMatchObject({ success: false });
    expect(await updatePurchaseOrderStatusAction(po.po_id!, 'completed'))
      .toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT status FROM purchase_orders WHERE id=?').get(po.po_id))
      .toEqual({ status: 'pending' });

    asTenant('fictional-tenant-a');
    expect(await updatePurchaseOrderStatusAction(po.po_id!, 'completed')).toEqual({ success: true });
    expect(await updatePurchaseOrderStatusAction(po.po_id!, 'completed')).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM inventory').get()).toEqual({ count: 0 });
  });

  it('receives only invoice quantity, not the order amount, and leaves the PO unlinked', async () => {
    const po = await createOrder(8);
    expect(po.success).toBe(true);
    expect(sqlite.prepare('SELECT requested_quantity,status FROM shortages WHERE pharmacy_id=?')
      .all('fictional-tenant-a')).toEqual([{ requested_quantity: 8, status: 'ordered' }]);

    const invoice = await createPurchaseInvoiceAction({
      supplier_id: 31, status: 'completed', payment_method: 'credit',
      invoice_number: 'SYNTH-PART-1', cart: invoiceCart(3),
    });
    expect(invoice).toMatchObject({ success: true, id: expect.any(String) });
    expect(sqlite.prepare('SELECT quantity,pharmacy_id FROM inventory WHERE drug_id=701').all())
      .toEqual([{ quantity: 3, pharmacy_id: 'fictional-tenant-a' }]);
    expect(sqlite.prepare('SELECT quantity,received_quantity FROM purchase_order_items WHERE po_id=?')
      .get(po.po_id)).toEqual({ quantity: 8, received_quantity: 0 });
    expect(sqlite.prepare('SELECT status FROM purchase_orders WHERE id=?').get(po.po_id))
      .toEqual({ status: 'pending' });
    expect(sqlite.prepare('SELECT status FROM shortages WHERE pharmacy_id=?').get('fictional-tenant-a'))
      .toEqual({ status: 'ordered' });
    expect(sqlite.prepare('SELECT status,requested_quantity FROM shortages WHERE pharmacy_id=?')
      .get('fictional-tenant-b')).toEqual({ status: 'pending', requested_quantity: 5 });
  });

  it('documents that repeating PO creation has no request key and creates two orders', async () => {
    const first = await createOrder(2);
    const retry = await createOrder(2);
    expect(first).toMatchObject({ success: true });
    expect(retry).toMatchObject({ success: true });
    expect(first.po_id).not.toBe(retry.po_id);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get()).toEqual({ n: 2 });
    // This observation is not a guarantee: PO-create request idempotency is
    // absent, unlike guarded native invoice-creation request receipts.
  });

  it('completes a draft receipt once and fails closed on the duplicate completion retry', async () => {
    const draft = await createPurchaseInvoiceAction({
      supplier_id: 31, status: 'draft', payment_method: 'credit',
      invoice_number: 'SYNTH-RETRY', cart: invoiceCart(4),
    });
    expect(draft.success).toBe(true);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(await completePurchaseInvoiceAction(draft.id!)).toEqual({ success: true });
    expect(await completePurchaseInvoiceAction(draft.id!)).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT SUM(quantity) AS total FROM inventory WHERE drug_id=701').get())
      .toEqual({ total: 4 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 1 });
  });

  it('rolls back draft receipt claim, supplier ledger and journals on stock insert failure', async () => {
    const draft = await createPurchaseInvoiceAction({
      supplier_id: 31, status: 'draft', payment_method: 'credit',
      invoice_number: 'SYNTH-FAIL', cart: invoiceCart(3),
    });
    expect(draft.success).toBe(true);
    rejectStockInsert = true;
    expect(await completePurchaseInvoiceAction(draft.id!)).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT status FROM purchase_invoices WHERE id=?').get(draft.id))
      .toEqual({ status: 'draft' });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM inventory').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM daily_journals').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM supplier_transactions').get()).toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT balance FROM suppliers WHERE id=31').get()).toEqual({ balance: 0 });
    rejectStockInsert = false;
    expect(await completePurchaseInvoiceAction(draft.id!)).toMatchObject({ success: true });
    expect(sqlite.prepare('SELECT SUM(quantity) AS total FROM inventory WHERE drug_id=701').get())
      .toEqual({ total: 3 });
  });

  it('does not expose another fictional tenant invoice in the shared supplier statement', async () => {
    sqlite.exec(`
      INSERT INTO purchase_invoices(id,supplier_id,pharmacy_id,user_id,status,total_amount)
        VALUES ('source-a',31,'fictional-tenant-a','actor-a','completed',11),
               ('source-b',31,'fictional-tenant-b','actor-b','completed',22);
      INSERT INTO supplier_transactions(supplier_id,type,amount,reference_id)
        VALUES (31,'invoice',11,'source-a'),(31,'invoice',22,'source-b'),
               (31,'payment',-11,'source-a'),
               (31,'payment',99,'unowned-payment');
    `);
    const a = await getSupplierTransactionsAction(31);
    expect(a).toMatchObject({ success: true });
    expect((a as any).data.map((row: any) => row.reference_id)).toEqual(['source-a', 'source-a']);

    asTenant('fictional-tenant-b');
    const b = await getSupplierTransactionsAction(31);
    expect((b as any).data.map((row: any) => row.reference_id)).toEqual(['source-b']);
    actor!.permissions.can_view_suppliers = false;
    actor!.permissions.can_view_purchases = false;
    expect(await getSupplierTransactionsAction(31)).toMatchObject({ success: false });
    actor = null;
    expect(await getSupplierTransactionsAction(31)).toMatchObject({ success: false });
  });

  it('rejects fractional ordered units instead of recording a fractional integer-schema PO', async () => {
    expect(await createOrder(1.5)).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get()).toEqual({ n: 0 });
  });
});
