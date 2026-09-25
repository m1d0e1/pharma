/** @jest-environment node */

import Database from 'better-sqlite3';

let mockDb: Database.Database;
let idCounter = 0;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => Promise<unknown>) => {
    mockDb.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback();
      mockDb.exec('COMMIT');
      return result;
    } catch (error) {
      mockDb.exec('ROLLBACK');
      throw error;
    }
  }),
  generateId: jest.fn(() => `return-${++idCounter}`),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/app/actions-client/finance', () => ({
  requireOpenShiftId: jest.fn(async () => 'shift-1'),
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));

import { createReturnAction } from '@/app/actions-client/returns';

const returnData = (quantity: number) => ({
  invoice_id: 'sale-1',
  refund_method: 'cash' as const,
  reason: 'test',
  items: [{
    sale_item_id: 1,
    inventory_id: 'lot-1',
    drug_name: 'Test drug',
    quantity,
    unit_price: 10,
    unit: 'large',
  }],
});

describe('sales return fallback atomicity', () => {
  beforeEach(() => {
    idCounter = 0;
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, patient_id TEXT, total_amount REAL,
        discount_amount REAL DEFAULT 0, payment_method TEXT, status TEXT
      );
      CREATE TABLE sales_items (
        id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER,
        quantity_sold REAL, unit_price REAL, unit TEXT, cost_price REAL,
        large_to_medium INTEGER DEFAULT 1, medium_to_small INTEGER DEFAULT 1
      );
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, no_return INTEGER DEFAULT 0, trade_name TEXT,
        medium_unit TEXT, small_unit TEXT
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, drug_id INTEGER, quantity REAL,
        unit_price REAL, cost_price REAL, strips_per_box INTEGER, medium_to_small INTEGER
      );
      CREATE TABLE returns (
        id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, pharmacy_id TEXT,
        shift_id TEXT, reason TEXT, total_refund REAL, refund_method TEXT, status TEXT
      );
      CREATE TABLE return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT,
        drug_name TEXT, quantity_returned REAL, unit_price REAL, sale_item_id INTEGER, unit TEXT
      );
      CREATE TABLE daily_journals (
        id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL
      );
      CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL);
      CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER);
      CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT);

      INSERT INTO sales_invoices VALUES ('sale-1', 'ph-1', NULL, 50, 0, 'cash', 'completed');
      INSERT INTO master_drugs VALUES (101, 0, 'Test drug', NULL, NULL);
      INSERT INTO sales_items VALUES (1, 'sale-1', 'lot-1', 101, 5, 10, 'large', 4, 1, 1);
      INSERT INTO inventory VALUES ('lot-1', 'ph-1', 101, 10, 10, 4, 1, 1);
    `);
  });

  afterEach(() => mockDb.close());

  it('rolls back the approved return and stock restoration when a late journal write fails', async () => {
    mockDb.exec(`
      CREATE TRIGGER fail_return_journal_entry
      BEFORE INSERT ON journal_entries
      BEGIN
        SELECT RAISE(ABORT, 'injected return journal failure');
      END;
    `);

    expect(await createReturnAction(returnData(2))).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM return_items').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual({ quantity: 10 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM journal_entries').get()).toEqual({ count: 0 });
  });

  it('allows successive partial returns only up to the sold quantity', async () => {
    expect(await createReturnAction(returnData(2))).toMatchObject({ success: true, totalRefund: 20 });
    expect(await createReturnAction(returnData(3))).toMatchObject({ success: true, totalRefund: 30 });
    expect(await createReturnAction(returnData(1))).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 2 });
    expect(mockDb.prepare('SELECT SUM(quantity_returned) AS quantity FROM return_items').get()).toEqual({ quantity: 5 });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual({ quantity: 15 });
  });

  it('accepts exact fractional partial returns but rejects a quantity beyond the stock tolerance', async () => {
    mockDb.prepare('UPDATE sales_invoices SET total_amount = 10 WHERE id = ?').run('sale-1');
    mockDb.prepare('UPDATE sales_items SET quantity_sold = 1 WHERE id = 1').run();

    expect(await createReturnAction(returnData(0.5))).toMatchObject({ success: true, totalRefund: 5 });
    const stockBeforeRejectedReturn = mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1');
    const refundsBeforeRejectedReturn = mockDb.prepare('SELECT COALESCE(SUM(total_refund), 0) AS total FROM returns').get();

    expect(await createReturnAction(returnData(0.504))).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual(stockBeforeRejectedReturn);
    expect(mockDb.prepare('SELECT COALESCE(SUM(total_refund), 0) AS total FROM returns').get()).toEqual(refundsBeforeRejectedReturn);
    expect(await createReturnAction(returnData(0.5))).toMatchObject({ success: true, totalRefund: 5 });
  });

  it('denies returns for delivery invoices before collection without changing stock or records', async () => {
    mockDb.prepare("UPDATE sales_invoices SET payment_method = 'delivery', status = 'completed' WHERE id = 'sale-1'").run();

    await expect(createReturnAction(returnData(1))).resolves.toEqual({
      success: false,
      error: 'يجب تسوية تحصيل فاتورة التوصيل قبل إجراء المرتجع',
    });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual({ quantity: 10 });
  });
});
