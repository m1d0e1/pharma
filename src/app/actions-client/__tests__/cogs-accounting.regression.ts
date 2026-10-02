import Database from 'better-sqlite3';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let mockUser: any = { id: 'owner', role: 'owner', pharmacy_id: 'ph-1' };

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => {
    mockDb.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback(mockCreateSqliteTransactionDb(mockDb));
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
    mockUser = { id: 'owner', role: 'owner', pharmacy_id: 'ph-1' };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, active_ingredient TEXT, large_to_medium REAL, medium_to_small REAL, medium_unit TEXT, small_unit TEXT);
      CREATE TABLE inventory (id TEXT PRIMARY KEY, strips_per_box REAL, medium_to_small REAL, cost_price REAL);
      CREATE TABLE sales_invoices (id TEXT PRIMARY KEY, status TEXT, created_at TEXT, pharmacy_id TEXT);
      CREATE TABLE sales_items (id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER, quantity_sold REAL, unit TEXT, cost_price REAL, large_to_medium REAL DEFAULT 1, medium_to_small REAL DEFAULT 1);
      CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, status TEXT);
      CREATE TABLE return_items (return_id TEXT, sale_item_id INTEGER, quantity_returned REAL, unit TEXT);
      CREATE TABLE trial_balance_settings (category TEXT PRIMARY KEY, account_id INTEGER);
      CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL, pharmacy_id TEXT);
      CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL);
      CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT, details TEXT, pharmacy_id TEXT);

      INSERT INTO master_drugs VALUES (1, 'Drug', 'Drug', 'Ingredient', 10, 2, 'strip', 'tablet');
      INSERT INTO inventory VALUES ('batch', 10, 2, 50);
      INSERT INTO sales_invoices VALUES ('sale', 'completed', '2026-09-17 10:00:00', 'ph-1');
      INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit, cost_price, large_to_medium, medium_to_small)
      VALUES (1, 'sale', 'batch', 1, 10, 'medium', 50, 10, 2);
      INSERT INTO returns VALUES ('return', 'sale', 'approved');
      INSERT INTO return_items VALUES ('return', 1, 2, NULL);
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
        ('delivered-sale', 'delivered', '2026-09-17 11:00:00', 'ph-1'),
        ('approved-sale', 'approved', '2026-09-17 12:00:00', 'ph-1'),
        ('legacy-null-sale', NULL, '2026-09-17 13:00:00', 'ph-1'),
        ('legacy-blank-sale', '', '2026-09-17 14:00:00', 'ph-1'),
        ('draft-sale', 'draft', '2026-09-17 15:00:00', 'ph-1');
      INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit, cost_price) VALUES
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
    expect(mockDb.prepare('SELECT pharmacy_id FROM daily_journals ORDER BY rowid LIMIT 1').get()).toEqual({ pharmacy_id: 'ph-1' });
    expect(mockDb.prepare("SELECT pharmacy_id FROM activity_log WHERE action = 'COGS_ADJUSTMENT' ORDER BY id LIMIT 1").get()).toEqual({ pharmacy_id: 'ph-1' });

    expect(await updateSoldItemCostAction(1, 45)).toEqual({ success: true });
    expect(mockDb.prepare('SELECT account_id, type, amount FROM journal_entries ORDER BY rowid DESC LIMIT 2').all().reverse()).toEqual([
      { account_id: 10, type: 'debit', amount: 8 },
      { account_id: 11, type: 'credit', amount: 8 },
    ]);
  });

  it('treats a blank historical return unit as the original sale unit', async () => {
    mockDb.prepare("UPDATE return_items SET unit = '   ' WHERE return_id = 'return'").run();

    expect(await updateSoldItemCostAction(1, 55)).toEqual({ success: true });
    expect(mockDb.prepare('SELECT account_id, type, amount FROM journal_entries ORDER BY rowid').all()).toEqual([
      { account_id: 11, type: 'debit', amount: 4 },
      { account_id: 10, type: 'credit', amount: 4 },
    ]);
  });

  it('converts finalized historical return units into the original sale unit before journaling COGS delta', async () => {
    mockDb.exec(`
      UPDATE master_drugs SET medium_unit = 'blister', small_unit = 'tablet' WHERE id = 1;
      INSERT INTO sales_invoices VALUES ('small-sale', 'completed', '2026-09-17 16:00:00', 'ph-1');
      INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit, cost_price, large_to_medium, medium_to_small)
      VALUES (7, 'small-sale', 'batch', 1, 10, 'tablet', 50, 10, 2);
      INSERT INTO returns VALUES ('small-return', 'small-sale', 'approved');
      INSERT INTO return_items VALUES ('small-return', 7, 1, 'blister');
    `);

    expect(await updateSoldItemCostAction(7, 55)).toEqual({ success: true });
    expect(mockDb.prepare('SELECT account_id, type, amount FROM journal_entries ORDER BY rowid').all()).toEqual([
      { account_id: 11, type: 'debit', amount: 2 },
      { account_id: 10, type: 'credit', amount: 2 },
    ]);
    expect((mockDb.prepare("SELECT details FROM activity_log WHERE action = 'COGS_ADJUSTMENT'").get() as any).details)
      .toContain('net quantity 0.4');
  });

  it('scopes listing and adjustment to the owner pharmacy while preserving local_default legacy NULL rows', async () => {
    mockDb.exec(`
      INSERT INTO sales_invoices VALUES
        ('ph-2-sale', 'completed', '2026-09-17 17:00:00', 'ph-2'),
        ('ph-2-legacy-status-sale', NULL, '2026-09-17 17:30:00', 'ph-2'),
        ('legacy-local-sale', 'completed', '2026-09-17 18:00:00', NULL);
      INSERT INTO sales_items (id, invoice_id, inventory_id, drug_id, quantity_sold, unit, cost_price) VALUES
        (20, 'ph-2-sale', 'batch', 1, 1, 'large', 40),
        (22, 'ph-2-legacy-status-sale', 'batch', 1, 1, 'large', 40),
        (21, 'legacy-local-sale', 'batch', 1, 1, 'large', 40);
    `);

    const ph1List = await getSoldItemsForCogsAdjustmentAction('Drug');
    expect(ph1List.success).toBe(true);
    expect((ph1List.data as any[]).map(item => item.id)).not.toContain(20);
    expect((ph1List.data as any[]).map(item => item.id)).not.toContain(22);
    expect((ph1List.data as any[]).map(item => item.id)).not.toContain(21);
    expect((await updateSoldItemCostAction(20, 45)).success).toBe(false);
    expect((mockDb.prepare('SELECT cost_price FROM sales_items WHERE id = 20').get() as any).cost_price).toBe(40);

    mockUser = { id: 'local-owner', role: 'owner', pharmacy_id: 'local_default' };
    const localList = await getSoldItemsForCogsAdjustmentAction('Drug');
    expect(localList.success).toBe(true);
    expect((localList.data as any[]).map(item => item.id)).toContain(21);
    expect((localList.data as any[]).map(item => item.id)).not.toContain(20);
    expect(await updateSoldItemCostAction(21, 45)).toEqual({ success: true });
    expect((mockDb.prepare('SELECT cost_price FROM sales_items WHERE id = 21').get() as any).cost_price).toBe(45);
    expect(mockDb.prepare('SELECT pharmacy_id FROM daily_journals ORDER BY rowid DESC LIMIT 1').get()).toEqual({ pharmacy_id: 'local_default' });
    expect(mockDb.prepare("SELECT pharmacy_id FROM activity_log WHERE action = 'COGS_ADJUSTMENT' ORDER BY id DESC LIMIT 1").get()).toEqual({ pharmacy_id: 'local_default' });
  });

  it('rejects invalid cost before changing accounting state', async () => {
    expect((await updateSoldItemCostAction(1, 0)).success).toBe(false);
    expect((mockDb.prepare('SELECT cost_price FROM sales_items WHERE id = 1').get() as any).cost_price).toBe(50);
    expect((mockDb.prepare('SELECT COUNT(*) AS n FROM daily_journals').get() as any).n).toBe(0);
  });
});
