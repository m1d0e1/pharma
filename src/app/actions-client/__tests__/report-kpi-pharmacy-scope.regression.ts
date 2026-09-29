import Database from 'better-sqlite3';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => callback(mockCreateSqliteTransactionDb(mockDb))),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'u1', role: 'owner', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/app/actions-client/shifts', () => ({
  getShiftForPharmacy: jest.fn(async () => null),
}));

import { getDashboardKPIsAction, getSalesTrendAction } from '@/app/actions-client/reports';

describe('report KPI pharmacy scope', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, pharmacy_id TEXT);
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY,
        pharmacy_id TEXT,
        payment_method TEXT,
        status TEXT,
        total_amount REAL,
        created_at TEXT
      );
      CREATE TABLE sales_items (
        invoice_id TEXT,
        drug_id INTEGER,
        quantity_sold REAL,
        unit TEXT,
        cost_price REAL,
        large_to_medium REAL,
        medium_to_small REAL
      );
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY,
        large_to_medium REAL,
        medium_to_small REAL,
        reorder_point REAL,
        medium_unit TEXT,
        small_unit TEXT
      );
      CREATE TABLE accounts (id INTEGER PRIMARY KEY);
      CREATE TABLE trial_balance_settings (category TEXT PRIMARY KEY, account_id INTEGER);
      CREATE TABLE daily_journals (id TEXT PRIMARY KEY, created_by TEXT, pharmacy_id TEXT);
      CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL);
     CREATE TABLE inventory (
       id TEXT PRIMARY KEY,
       pharmacy_id TEXT,
       drug_id INTEGER,
       quantity REAL,
        cost_price REAL,
        expiry_date TEXT
     );
      CREATE TABLE stock_adjustments (
        inventory_id TEXT,
        old_quantity REAL,
        new_quantity REAL,
        created_at TEXT
      );
      CREATE TABLE returns (
        id TEXT PRIMARY KEY,
        invoice_id TEXT,
        user_id TEXT,
        pharmacy_id TEXT,
        total_refund REAL,
        status TEXT,
        created_at TEXT
      );

      INSERT INTO users VALUES ('u1', 'ph-1'), ('u2', 'ph-2');
      INSERT INTO accounts VALUES (6);
      INSERT INTO trial_balance_settings VALUES ('cash_drawer', 6);

      INSERT INTO sales_invoices VALUES
        ('ph1-delivered', 'ph-1', 'cash', 'delivered', 100, datetime('now')),
        ('ph1-delivery', 'ph-1', 'delivery', 'completed', 50, datetime('now')),
        ('ph2-sale', 'ph-2', 'delivery', 'completed', 200, datetime('now'));

      INSERT INTO daily_journals VALUES ('j1', 'u1', 'ph-1'), ('j2', 'u2', 'ph-2');
      INSERT INTO journal_entries VALUES ('j1', 6, 'debit', 30), ('j2', 6, 'debit', 90);

      INSERT INTO master_drugs VALUES (1, 1, 1, 5, 'strip', 'tablet');
     INSERT INTO inventory VALUES
        ('i1', 'ph-1', 1, 2, 10, NULL),
        ('i2', 'ph-2', 1, 1, 10, NULL);
      INSERT INTO stock_adjustments VALUES
        ('i1', 4, 2, datetime('now')),
        ('i2', 6, 1, datetime('now'));

      INSERT INTO returns VALUES
        ('r1', NULL, 'u1', 'ph-1', 10, 'approved', datetime('now')),
        ('r2', NULL, 'u2', 'ph-2', 20, 'approved', datetime('now'));
    `);
  });

  afterEach(() => mockDb.close());

  it('keeps KPI money/stock values scoped and keeps delivered sales realized', async () => {
    expect(await getDashboardKPIsAction()).toMatchObject({
      success: true,
      data: {
        sales_today: 150,
        gross_profit_today: 150,
        liquidity: 30,
        pending_delivery_cash: 50,
        shrinkage_today: 20,
        stock_alerts_count: 1,
      },
    });
  });

  it('uses custom master unit labels when calculating report KPI COGS', async () => {
    mockDb.exec(`
      DELETE FROM sales_items;
      DELETE FROM sales_invoices;
      UPDATE master_drugs
      SET large_to_medium = 10, medium_to_small = 1, medium_unit = 'blister', small_unit = 'tablet'
      WHERE id = 1;
      INSERT INTO sales_invoices VALUES
        ('custom-unit-sale', 'ph-1', 'cash', 'completed', 200, datetime('now'));
      INSERT INTO sales_items
        (invoice_id, drug_id, quantity_sold, unit, cost_price, large_to_medium, medium_to_small)
      VALUES ('custom-unit-sale', 1, 10, 'blister', 100, 10, 1);
    `);

    expect(await getDashboardKPIsAction()).toMatchObject({
      success: true,
      data: {
        sales_today: 200,
        gross_profit_today: 100,
      },
    });
  });

  it('scopes sales and general returns in the trend by pharmacy', async () => {
    const result = await getSalesTrendAction(1);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data?.[0]).toMatchObject({
      sales: 150,
      returns: 10,
      net_sales: 140,
    });
  });

  it('counts low-stock alerts per drug after aggregating all pharmacy batches', async () => {
    mockDb.prepare("DELETE FROM inventory WHERE pharmacy_id = 'ph-1'").run();
    mockDb.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, cost_price) VALUES
        ('ph1-batch-a', 'ph-1', 1, 3, 10),
        ('ph1-batch-b', 'ph-1', 1, 3, 12)
    `).run();

    const result = await getDashboardKPIsAction();

    expect(result).toMatchObject({
      success: true,
      data: { stock_alerts_count: 0 },
    });
  });

  it('ignores expired inventory when calculating report stock alerts', async () => {
    mockDb.prepare("DELETE FROM inventory WHERE pharmacy_id = 'ph-1'").run();
    mockDb.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, cost_price, expiry_date) VALUES
        ('ph1-usable', 'ph-1', 1, 1, 10, date('now', '+30 days')),
        ('ph1-expired', 'ph-1', 1, 100, 10, date('now', '-1 day'))
    `).run();

    const result = await getDashboardKPIsAction();

    expect(result).toMatchObject({
      success: true,
      data: { stock_alerts_count: 1 },
    });
  });
});
