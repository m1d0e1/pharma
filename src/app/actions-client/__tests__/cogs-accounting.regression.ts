import Database from 'better-sqlite3';

let mockDb: Database.Database;
let mockUser: any = { id: 'owner', role: 'owner' };

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
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
  generateId: jest.fn(() => `journal-${Math.random()}`),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockUser),
  hasUserPermissionSync: jest.fn(() => true),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: {} }));

import { getSoldItemsForCogsAdjustmentAction, updateSoldItemCostAction } from '@/app/actions-client/cogs';

describe('sold-item COGS accounting correction', () => {
  beforeEach(() => {
    mockUser = { id: 'owner', role: 'owner' };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, active_ingredient TEXT, large_to_medium REAL, medium_to_small REAL);
      CREATE TABLE inventory (id TEXT PRIMARY KEY, strips_per_box REAL, cost_price REAL);
      CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, status TEXT, created_at TEXT);
      CREATE TABLE sales_items (id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold REAL, unit TEXT, cost_price REAL);
      CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, status TEXT);
      CREATE TABLE return_items (return_id TEXT, sale_item_id INTEGER, quantity_returned REAL);
      CREATE TABLE trial_balance_settings (category TEXT PRIMARY KEY, account_id INTEGER);
      CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL);
      CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL);
      CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, details TEXT);

      INSERT INTO master_drugs VALUES (1, 'Drug', 'Drug', 'Ingredient', 10, 2);
      INSERT INTO inventory VALUES ('batch', 10, 50);
      INSERT INTO sales_invoices VALUES ('sale', 'completed', '2026-09-17 10:00:00');
      INSERT INTO sales_items VALUES (1, 'sale', 'batch', 1, 10, 'medium', 50);
      INSERT INTO returns VALUES ('return', 'sale', 'approved');
      INSERT INTO return_items VALUES ('return', 1, 2);
      INSERT INTO trial_balance_settings VALUES ('cogs_expense', 11), ('inventory_asset', 10);
    `);
  });

  afterEach(() => mockDb.close());

  it('keeps COGS correction owner-only even when a non-owner has the old view flag', async () => {
    mockUser = { id: 'admin', role: 'admin', permissions: { can_view_cogs: true } };

    expect(await getSoldItemsForCogsAdjustmentAction('Drug')).toEqual({ success: false, error: 'غير مصرح' });
    expect(await updateSoldItemCostAction(1, 55)).toEqual({ success: false, error: 'غير مصرح' });
    expect((mockDb.prepare('SELECT cost_price FROM sales_items WHERE id = 1').get() as any).cost_price).toBe(50);
  });

  it('lists only realized sales and allows delivered-sale correction', async () => {
    mockDb.exec(`
      INSERT INTO sales_invoices VALUES
        ('delivered-sale', 'delivered', '2026-09-17 11:00:00'),
        ('approved-sale', 'approved', '2026-09-17 12:00:00'),
        ('legacy-null-sale', NULL, '2026-09-17 13:00:00'),
        ('legacy-blank-sale', '', '2026-09-17 14:00:00'),
        ('draft-sale', 'draft', '2026-09-17 15:00:00');
      INSERT INTO sales_items VALUES
        (2, 'delivered-sale', 'batch', 1, 1, 'large', 40),
        (3, 'approved-sale', 'batch', 1, 1, 'large', 40),
        (4, 'legacy-null-sale', 'batch', 1, 1, 'large', 40),
        (5, 'legacy-blank-sale', 'batch', 1, 1, 'large', 40),
        (6, 'draft-sale', 'batch', 1, 1, 'large', 40);
    `);

    const listed = await getSoldItemsForCogsAdjustmentAction('Drug');
    expect(listed.success).toBe(true);
    expect((listed.data as any[]).map(item => item.id).sort()).toEqual([1, 2, 3, 4, 5]);

    expect(await updateSoldItemCostAction(2, 45)).toEqual({ success: true });
    expect((mockDb.prepare('SELECT cost_price FROM sales_items WHERE id = 2').get() as any).cost_price).toBe(45);
    expect((await updateSoldItemCostAction(6, 45)).success).toBe(false);
  });

  it('journals only the net unreturned base-quantity cost delta in both directions', async () => {
    expect(await updateSoldItemCostAction(1, 55)).toEqual({ success: true });
    expect((mockDb.prepare('SELECT cost_price FROM sales_items WHERE id = 1').get() as any).cost_price).toBe(55);
    expect(mockDb.prepare('SELECT account_id, type, amount FROM journal_entries ORDER BY rowid').all()).toEqual([
      { account_id: 11, type: 'debit', amount: 4 },
      { account_id: 10, type: 'credit', amount: 4 },
    ]);

    expect(await updateSoldItemCostAction(1, 45)).toEqual({ success: true });
    expect(mockDb.prepare('SELECT account_id, type, amount FROM journal_entries ORDER BY rowid DESC LIMIT 2').all().reverse()).toEqual([
      { account_id: 10, type: 'debit', amount: 8 },
      { account_id: 11, type: 'credit', amount: 8 },
    ]);
  });

  it('rejects invalid cost before changing accounting state', async () => {
    expect((await updateSoldItemCostAction(1, 0)).success).toBe(false);
    expect((mockDb.prepare('SELECT cost_price FROM sales_items WHERE id = 1').get() as any).cost_price).toBe(50);
    expect((mockDb.prepare('SELECT COUNT(*) AS n FROM daily_journals').get() as any).n).toBe(0);
  });
});
