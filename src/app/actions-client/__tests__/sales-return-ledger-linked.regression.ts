/** @jest-environment node */
import Database from 'better-sqlite3';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let mockActor: { id: string; role: string; pharmacy_id: string } | null;
let mockId = 0;

// Strictly synthetic SQLite :memory: -- never open application DB/native bridge.
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => {
    mockDb.exec('BEGIN IMMEDIATE');
    try {
      const value = await callback(mockCreateSqliteTransactionDb(mockDb));
      mockDb.exec('COMMIT');
      return value;
    } catch (error) {
      mockDb.exec('ROLLBACK');
      throw error;
    }
  }),
  generateId: jest.fn(() => `linked-fixture-${++mockId}`),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => mockActor,
  hasUserPermissionSync: (actor: any, permission: string) => Boolean(actor && permission === 'can_view_returns'),
}));
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: jest.fn(async () => 'mock-shift-1') }));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

import { createReturnAction, getReturnsAction } from '@/app/actions-client/returns';

const returnRequest = (quantity: number) => ({
  invoice_id: 'sale-fixture-1',
  refund_method: 'cash' as const,
  reason: 'synthetic return',
  items: [{
    sale_item_id: 71,
    inventory_id: 'lot-fixture-1',
    drug_name: 'Fixture carton',
    quantity,
    unit_price: 20,
    unit: 'large',
  }],
});

describe('in-memory completed-sale seed → real return/restock → return listing → accounting', () => {
  beforeEach(() => {
    mockId = 0;
    mockActor = { id: 'synthetic-cashier', role: 'pharmacist', pharmacy_id: 'tenant-A' };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, patient_id TEXT, total_amount REAL,
        discount_amount REAL DEFAULT 0, payment_method TEXT, status TEXT,
        user_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        points_earned INTEGER DEFAULT 0, points_redeemed INTEGER DEFAULT 0,
        loyalty_discount_amount REAL DEFAULT 0
      );
      CREATE TABLE sales_items (
        id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER,
        quantity_sold REAL, unit_price REAL, unit TEXT, cost_price REAL,
        large_to_medium INTEGER, medium_to_small INTEGER
      );
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, no_return INTEGER, trade_name TEXT,
        trade_name_en TEXT, medium_unit TEXT, small_unit TEXT
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, drug_id INTEGER, quantity REAL,
        batch_number TEXT, expiry_date TEXT, unit_price REAL, cost_price REAL,
        strips_per_box INTEGER, medium_to_small INTEGER
      );
      CREATE TABLE returns (
        id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, pharmacy_id TEXT,
        shift_id TEXT, reason TEXT, total_refund REAL, refund_method TEXT,
        status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE return_items (
        id INTEGER PRIMARY KEY, return_id TEXT, inventory_id TEXT,
        drug_id INTEGER, drug_name TEXT, quantity_returned REAL, unit_price REAL,
        sale_item_id INTEGER, unit TEXT
      );
      CREATE TABLE users (id TEXT PRIMARY KEY, full_name TEXT);
      CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT, wallet_balance REAL, points_balance REAL);
      CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT,
        created_by TEXT, total_amount REAL);
      CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL);
      CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER);
      CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT);

      INSERT INTO sales_invoices (id,pharmacy_id,total_amount,payment_method,status,user_id)
        VALUES ('sale-fixture-1','tenant-A',40,'cash','completed','synthetic-cashier');
      INSERT INTO master_drugs VALUES (901,0,'صنف اختباري','Synthetic Carton','strip','pill');
      INSERT INTO sales_items VALUES (71,'sale-fixture-1','lot-fixture-1',901,2,20,'large',8,2,3);
      -- Seed represents a previously committed sale decrement (6→4), not an actual checkout.
      INSERT INTO inventory VALUES ('lot-fixture-1','tenant-A',901,4,'synthetic-batch','2099-12-30',20,8,2,3);
      INSERT INTO users VALUES ('synthetic-cashier','Fixture Cashier');
      INSERT INTO trial_balance_settings VALUES
        ('cash_drawer',6),('accounts_receivable',8),('sales_revenue',9),
        ('inventory_asset',10),('cogs_expense',11),('bank_clearing',12),
        ('patient_wallet_liability',13);
    `);
  });

  afterEach(() => mockDb.close());

  it('conserves partial refund, stock, and balanced journal while resolving the returned drug name from original sale lineage', async () => {
    expect(await createReturnAction(returnRequest(0.5))).toMatchObject({ success: true, totalRefund: 10 });
    expect(await createReturnAction(returnRequest(1.5))).toMatchObject({ success: true, totalRefund: 30 });
    expect(await createReturnAction(returnRequest(0.1))).toMatchObject({ success: false });

    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-fixture-1'))
      .toEqual({ quantity: 6 });
    expect(mockDb.prepare('SELECT SUM(total_refund) AS total FROM returns').get()).toEqual({ total: 40 });
    const ledger = mockDb.prepare(`
      SELECT je.type, SUM(je.amount) AS amount FROM journal_entries je
      GROUP BY je.type
    `).all() as Array<{ type: string; amount: number }>;
    expect(ledger.find(entry => entry.type === 'debit')?.amount).toBe(ledger.find(entry => entry.type === 'credit')?.amount);
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 2 });

    const history = await getReturnsAction({ limit: 20 });
    expect(history.success).toBe(true);
    expect(history.data).toHaveLength(2);
    expect(history.data![0].items).toMatchObject([{
      sale_item_id: 71,
      drug_name: 'Fixture carton',
      trade_name_en: 'Synthetic Carton',
    }]);
  });

  it('rejects a foreign tenant return before restock/journal and does not reveal the foreign history', async () => {
    mockActor = { id: 'synthetic-cashier-B', role: 'pharmacist', pharmacy_id: 'tenant-B' };
    expect(await createReturnAction(returnRequest(1))).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-fixture-1')).toEqual({ quantity: 4 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
    expect(await getReturnsAction({ limit: 20 })).toMatchObject({ success: true, data: [] });
  });

  it('rolls back stock, refund, journal, and audit when a late journal insert rejects', async () => {
    mockDb.exec(`
      CREATE TRIGGER fail_linked_refund_journal BEFORE INSERT ON journal_entries
      BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END;
    `);
    const priorConsole = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await createReturnAction(returnRequest(1))).toMatchObject({ success: false });
    } finally {
      priorConsole.mockRestore();
    }
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-fixture-1')).toEqual({ quantity: 4 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM return_items').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM activity_log').get()).toEqual({ count: 0 });
  });

  it('fails closed rather than returning partial financial history when its child-item read fails after a committed refund', async () => {
    expect(await createReturnAction(returnRequest(1))).toMatchObject({ success: true, totalRefund: 20 });
    mockDb.exec('DROP TABLE return_items');
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await getReturnsAction({ limit: 10 })).toEqual({
        success: false,
        error: 'فشل جلب المرتجعات',
      });
    } finally {
      log.mockRestore();
    }
    expect(mockDb.prepare('SELECT SUM(total_refund) AS total FROM returns').get()).toEqual({ total: 20 });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-fixture-1')).toEqual({ quantity: 5 });
  });
});
