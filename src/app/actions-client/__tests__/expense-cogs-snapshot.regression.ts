import Database from 'better-sqlite3';

let mockDb: Database.Database;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'id-1'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'owner', role: 'owner', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/app/actions-client/finance', () => ({
  createCashMovementAction: jest.fn(),
}));

import { getExpenseSummaryAction } from '@/app/actions-client/expenses';

describe('expense P&L historical COGS snapshots', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE expenses (
        id TEXT PRIMARY KEY, user_id TEXT, category TEXT, amount REAL,
        description TEXT, date TEXT, pharmacy_id TEXT
      );
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, total_amount REAL,
        status TEXT, created_at TEXT
      );
      CREATE TABLE sales_items (
        id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER,
        quantity_sold REAL, unit TEXT, cost_price REAL, is_negative INTEGER DEFAULT 0,
        large_to_medium INTEGER DEFAULT 1, medium_to_small INTEGER DEFAULT 1
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY, drug_id INTEGER, strips_per_box INTEGER DEFAULT 1,
        medium_to_small INTEGER DEFAULT 1
      );
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, medium_unit TEXT, small_unit TEXT,
        large_to_medium INTEGER DEFAULT 1, medium_to_small INTEGER DEFAULT 1
      );
      CREATE TABLE returns (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, total_refund REAL,
        status TEXT, created_at TEXT
      );
      CREATE TABLE return_items (
        id INTEGER PRIMARY KEY, return_id TEXT, inventory_id TEXT, drug_id INTEGER,
        quantity_returned REAL, unit TEXT, sale_item_id INTEGER
      );

      INSERT INTO master_drugs
        (id, medium_unit, small_unit, large_to_medium, medium_to_small)
      VALUES (1, 'strip', 'tablet', 4, 5);
      INSERT INTO inventory (id, drug_id, strips_per_box, medium_to_small)
      VALUES ('lot-1', 1, 4, 5);
      INSERT INTO sales_invoices (id, pharmacy_id, total_amount, status, created_at)
      VALUES ('sale-1', 'ph-1', 10, 'completed', '2026-08-10 12:00:00');
      INSERT INTO sales_items
        (id, invoice_id, inventory_id, drug_id, quantity_sold, unit, cost_price, large_to_medium, medium_to_small)
      VALUES (1, 'sale-1', 'lot-1', 1, 2, 'medium', 20, 10, 5);
    `);
  });

  afterEach(() => mockDb.close());

  it('keeps monthly COGS on the conversion captured when the sale happened', async () => {
    const result = await getExpenseSummaryAction('2026-08');

    expect(result).toMatchObject({
      success: true,
      data: {
        totalRevenue: 10,
        totalCOGS: 4,
        netProfit: 6,
      },
    });
  });

  it('reverses returned COGS using the same historical sale conversion', async () => {
    mockDb.exec(`
      INSERT INTO returns (id, pharmacy_id, total_refund, status, created_at)
      VALUES ('return-1', 'ph-1', 5, 'completed', '2026-08-11 12:00:00');
      INSERT INTO return_items
        (id, return_id, inventory_id, drug_id, quantity_returned, unit, sale_item_id)
      VALUES (1, 'return-1', 'lot-1', 1, 1, 'medium', 1);
    `);

    const result = await getExpenseSummaryAction('2026-08');

    expect(result).toMatchObject({
      success: true,
      data: {
        totalRevenue: 10,
        totalReturns: 5,
        totalCOGS: 2,
        netProfit: 3,
      },
    });
  });
});
