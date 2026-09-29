import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

let sqlite: Database.Database;
let mockSession: any;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  generateId: jest.fn(() => 'permission-test-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, permission: string) =>
    user?.role === 'owner'
      || user?.permissions?.[permission] === true
      || (Array.isArray(user?.permissions) && user.permissions.includes(permission))),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    reload: jest.fn(async () => undefined),
    updateDrug: jest.fn(),
  },
}));

jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

jest.unmock('@/app/actions-client/inventory');

import { getDrugDetailsFullAction, getInventoryListAction } from '@/app/actions-client/inventory';

describe('inventory read permission boundaries', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
    sqlite.exec(`
      ALTER TABLE sales_items ADD COLUMN large_to_medium INTEGER DEFAULT 1;
      ALTER TABLE sales_items ADD COLUMN medium_to_small INTEGER DEFAULT 1;
      INSERT INTO master_drugs (id, trade_name, trade_name_en, official_price)
      VALUES (7001, 'دواء صلاحيات', 'Permission Drug', 50);
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, cost_price, local_selling_price, expiry_date)
      VALUES ('permission-lot', 'ph-1', 7001, 3, 20, 50, '2099-12-31');
      INSERT INTO suppliers (id, name_ar, balance)
      VALUES (77, 'مورد اختبار', 0);
      INSERT INTO purchase_invoices (id, supplier_id, invoice_number, invoice_date, total_amount, pharmacy_id)
      VALUES ('permission-purchase', 77, 'P-77', '2026-09-01', 20, 'ph-1');
      INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, cost_price, selling_price, tax_percent, discount_percent)
      VALUES ('permission-purchase', 7001, 1, 20, 50, 5, 2);
    `);
    mockSession = { id: 'viewer', role: 'pharmacist', pharmacy_id: 'ph-1', permissions: {} };
  });

  afterEach(() => sqlite.close());

  it('rejects inventory list and item details without can_view_stores', async () => {
    expect(await getInventoryListAction()).toMatchObject({ success: false });
    expect(await getDrugDetailsFullAction(7001)).toMatchObject({ success: false });
  });

  it('does not expose supplier purchase pricing to a store-only viewer', async () => {
    mockSession.permissions = { can_view_stores: true };

    const details = await getDrugDetailsFullAction(7001);

    expect(details.success).toBe(true);
    expect(details.data?.supplier_history).toEqual([]);
  });

  it('keeps POS drug details readable without exposing purchase pricing', async () => {
    mockSession.permissions = { can_access_pos: true };

    const details = await getDrugDetailsFullAction(7001);

    expect(details.success).toBe(true);
    expect(details.data?.trade_name_en).toBe('Permission Drug');
    expect(details.data?.supplier_history).toEqual([]);
  });

  it('exposes supplier purchase history when purchase permission is also granted', async () => {
    mockSession.permissions = { can_view_stores: true, can_view_purchases: true };

    const details = await getDrugDetailsFullAction(7001);

    expect(details.success).toBe(true);
    expect(details.data?.supplier_history).toEqual([
      expect.objectContaining({ supplier_id: 77, cost_price: 20, selling_price: 50, tax_percent: 5, discount_percent: 2 }),
    ]);
  });
});
