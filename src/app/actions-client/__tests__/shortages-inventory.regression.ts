import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

let mockDb: Database.Database;
let mockSession: { id: string; role: string; pharmacy_id: string | null };

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
  generateId: jest.fn(() => 'test-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    getAllDrugs: jest.fn(() => []),
    updateDrug: jest.fn(),
    enrich: jest.fn((rows: unknown[]) => rows),
  },
}));

jest.unmock('@/app/actions-client/inventory');
jest.unmock('@/app/actions-client/shortages');

import { getLowStockAction } from '@/app/actions-client/inventory';
import {
  addToShortagesAction,
  getShortagesAction,
  syncLowStockToShortagesAction,
  updateShortageStatusAction,
} from '@/app/actions-client/shortages';

describe('inventory-linked reorder and shortage notebook regression', () => {
  beforeEach(() => {
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    mockDb = new Database(':memory:');
    mockDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/012_shortages_pharmacy_scope.sql', 'utf8'));
    mockDb.pragma('foreign_keys = ON');
    mockDb.exec(`
      INSERT INTO master_drugs (
        id, trade_name, trade_name_en, reorder_point, default_purchase_qty,
        large_to_medium, medium_to_small, medium_unit, small_unit
      ) VALUES
        (9101, 'صنف ناقص', 'Low Drug', 5, 8, 10, 10, 'شريط', 'قرص'),
        (9102, 'صنف صفري', 'Zero Drug', 0, 1, 1, 1, 'شريط', 'قرص'),
        (9103, 'صنف متوفر', 'Healthy Drug', 5, 1, 1, 1, 'شريط', 'قرص');

      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, strips_per_box, expiry_date) VALUES
        ('low-stock', NULL, 9101, 2, 10, '2099-12-31'),
        ('expired-stock', NULL, 9101, 50, 10, '2020-01-01'),
        ('other-pharmacy-stock', 'ph-2', 9101, 50, 10, '2099-12-31'),
        ('zero-stock', NULL, 9102, 0, 1, '2099-12-31'),
        ('healthy-stock', NULL, 9103, 20, 1, '2099-12-31');

      INSERT INTO sales_invoices (id, pharmacy_id, user_id, total_amount, status, created_at)
      VALUES
        ('recent-sale', NULL, 'admin', 2, 'completed', CURRENT_TIMESTAMP),
        ('draft-sale', NULL, 'admin', 100, 'draft', CURRENT_TIMESTAMP),
        ('foreign-sale', 'ph-2', 'admin', 100, 'completed', CURRENT_TIMESTAMP);

      INSERT INTO sales_items (invoice_id, drug_id, quantity_sold, unit, is_negative)
      VALUES
        ('recent-sale', 9101, 10, 'شريط', 0),
        ('recent-sale', 9101, 100, 'قرص', 0),
        ('draft-sale', 9101, 1000, 'علبة', 0),
        ('foreign-sale', 9101, 1000, 'علبة', 0);
    `);
  });

  afterEach(() => mockDb.close());

  it('keeps inventory and shortage drug joins indexable', () => {
    const inventorySource = readFileSync('src/app/actions-client/inventory.ts', 'utf8');
    const dashboardSource = readFileSync('src/app/(dashboard)/page.tsx', 'utf8');
    const shortagesSource = readFileSync('src/app/actions-client/shortages.ts', 'utf8');

    for (const [source, directJoins, castJoins] of [
      [inventorySource, [
        'i.drug_id = m.id',
        'uf.drug_id = si.drug_id',
        'm.id = ds.drug_id',
        'm.id = ms.drug_id',
      ], [
        'CAST(i.drug_id AS TEXT) = CAST(m.id AS TEXT)',
        'CAST(uf.drug_id AS TEXT) = CAST(si.drug_id AS TEXT)',
        'CAST(m.id AS TEXT) = CAST(ds.drug_id AS TEXT)',
        'CAST(m.id AS TEXT) = CAST(ms.drug_id AS TEXT)',
      ]],
      [dashboardSource, [
        'm.id = ds.drug_id',
        'm.id = ms.drug_id',
      ], [
        'CAST(m.id AS TEXT) = CAST(ds.drug_id AS TEXT)',
        'CAST(m.id AS TEXT) = CAST(ms.drug_id AS TEXT)',
      ]],
      [shortagesSource, [
        'm.id = s.drug_id',
        'ds.drug_id = s.drug_id',
      ], [
        'CAST(m.id AS TEXT) = CAST(s.drug_id AS TEXT)',
        'CAST(ds.drug_id AS TEXT) = CAST(s.drug_id AS TEXT)',
      ]],
    ] as const) {
      for (const join of directJoins) expect(source).toContain(join);
      for (const join of castJoins) expect(source).not.toContain(join);
    }
  });

  it('flows from live stock through reorder alerts into a duplicate-safe shortage workflow', async () => {
    const lowStock = await getLowStockAction(10);
    expect(lowStock.success).toBe(true);
    expect(lowStock.data?.map((item: any) => item.drug_id)).toEqual([9102, 9101]);
    expect(lowStock.data?.find((item: any) => item.drug_id === 9101)).toMatchObject({
      quantity: 2,
      reorder_point: 5,
      deficit: 3,
      avg_monthly_usage: 2,
      status: 'critical',
    });
    expect(lowStock.data?.find((item: any) => item.drug_id === 9102)).toMatchObject({
      quantity: 0,
      reorder_point: 10,
      deficit: 10,
      status: 'out_of_stock',
    });

    const firstSync = await syncLowStockToShortagesAction();
    expect(mockDb.prepare('SELECT id, drug_id, requested_quantity, status FROM shortages ORDER BY drug_id').all()).toEqual([
      expect.objectContaining({ drug_id: 9101, requested_quantity: 8, status: 'pending' }),
      expect.objectContaining({ drug_id: 9102, requested_quantity: 10, status: 'pending' }),
    ]);
    mockDb.prepare(`
      INSERT INTO shortages (drug_id, requested_quantity, status)
      VALUES (9101, 6, 'pending')
    `).run();
    const secondSync = await syncLowStockToShortagesAction();
    expect(firstSync).toMatchObject({ success: true, data: { total: 2, created: 2, updated: 0 } });
    expect(secondSync).toMatchObject({ success: true, data: { total: 2, created: 0, updated: 2 } });
    expect((mockDb.prepare('SELECT COUNT(*) AS count FROM shortages').get() as any).count).toBe(2);
    expect((mockDb.prepare('SELECT requested_quantity FROM shortages WHERE drug_id = 9101').get() as any).requested_quantity).toBe(8);

    await addToShortagesAction({ drug_id: 9101, qty: 12, notes: 'ملاحظة الفرع المحلي' });
    await addToShortagesAction({ drug_id: 9101, qty: 3 });
    expect((mockDb.prepare('SELECT COUNT(*) AS count FROM shortages WHERE drug_id = 9101').get() as any).count).toBe(1);
    expect((mockDb.prepare('SELECT requested_quantity FROM shortages WHERE drug_id = 9101').get() as any).requested_quantity).toBe(12);
    expect((mockDb.prepare('SELECT notes FROM shortages WHERE drug_id = 9101').get() as any).notes).toBe('ملاحظة الفرع المحلي');

    mockSession = { id: 'admin', role: 'owner', pharmacy_id: 'ph-2' };
    await addToShortagesAction({ drug_id: 9101, qty: 4, notes: 'ملاحظة الفرع الثاني' });
    expect((mockDb.prepare('SELECT COUNT(*) AS count FROM shortages WHERE drug_id = 9101').get() as any).count).toBe(2);
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };

    const notebook = await getShortagesAction();
    expect(notebook.data?.find((item: any) => item.drug_id === 9101)).toMatchObject({
      current_stock: 2,
      reorder_point: 5,
      deficit: 3,
      inventory_status: 'low',
    });
    const zeroItem = notebook.data?.find((item: any) => item.drug_id === 9102);
    expect(await updateShortageStatusAction(zeroItem.id, 'received')).toMatchObject({
      success: false,
      error: expect.stringContaining('إضافة الكمية'),
    });

    mockDb.prepare('UPDATE inventory SET quantity = 7 WHERE drug_id = 9101').run();
    const replenished = await getShortagesAction();
    const replenishedItem = replenished.data?.find((item: any) => item.drug_id === 9101);
    expect(replenishedItem).toMatchObject({ current_stock: 7, deficit: 0, inventory_status: 'sufficient' });

    const received = await updateShortageStatusAction(replenishedItem.id, 'received');
    expect(received.success).toBe(true);
    expect((await getShortagesAction()).data?.some((item: any) => item.drug_id === 9101)).toBe(false);
  });
});
