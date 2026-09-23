import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

let mockDb: Database.Database;
let mockSession: { id: string; role: string; pharmacy_id: string | null; permissions?: unknown };

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
jest.unmock('@/app/actions-client/master-drugs');

import {
  getDrugDetailsFullAction,
  getInventoryAlertsAction,
  getInventoryListAction,
  getLowStockAction,
  getMovementsAction,
  getOpeningBalancesAction,
} from '@/app/actions-client/inventory';
import { createStockAdjustmentAction } from '@/app/actions-client/master-drugs';

describe('inventory read models preserve pharmacy boundaries', () => {
  beforeEach(() => {
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    mockDb = new Database(':memory:');
    mockDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
    // Native startup adds these compatibility columns before actions can run.
    mockDb.exec(`
      ALTER TABLE sales_items ADD COLUMN large_to_medium INTEGER DEFAULT 1;
      ALTER TABLE sales_items ADD COLUMN medium_to_small INTEGER DEFAULT 1;
      ALTER TABLE activity_log ADD COLUMN pharmacy_id TEXT;
    `);
    mockDb.pragma('foreign_keys = ON');
    mockDb.exec(`
      INSERT INTO master_drugs (id, trade_name, trade_name_en)
      VALUES (9201, 'دواء اختبار الفروع', 'Scoped inventory drug');

      INSERT INTO inventory (
        id, pharmacy_id, drug_id, batch_number, quantity,
        local_selling_price, expiry_date
      ) VALUES
        ('local-active', NULL, 9201, 'LOCAL-ACTIVE', 2, 10, '2099-12-31'),
        ('local-expired', NULL, 9201, 'OPEN-LOCAL', 3, 11, '2020-01-01'),
        ('foreign-active', 'ph-2', 9201, 'FOREIGN-ACTIVE', 7, 20, '2099-12-31'),
        ('foreign-expired', 'ph-2', 9201, 'OPEN-FOREIGN', 11, 21, '2020-01-01');
    `);
  });

  afterEach(() => mockDb.close());

  it('scopes inventory lists, drug totals/batches, alerts, and opening balances to the signed-in pharmacy', async () => {
    const localList = await getInventoryListAction();
    expect(localList.success).toBe(true);
    expect(localList.data?.map((item: any) => item.id).sort()).toEqual([
      'local-active',
      'local-expired',
    ]);

    const localDetails = await getDrugDetailsFullAction(9201);
    expect(localDetails.success).toBe(true);
    expect(localDetails.data?.total_stock).toBe(5);
    expect(localDetails.data?.min_price).toBe(10);
    expect(localDetails.data?.expiry_batches.map((batch: any) => batch.batch_number).sort()).toEqual([
      'LOCAL-ACTIVE',
      'OPEN-LOCAL',
    ]);

    const localAlerts = await getInventoryAlertsAction();
    expect(localAlerts.success).toBe(true);
    expect(localAlerts.data?.alerts.map((alert: any) => alert.id)).toContain('local-expired');
    expect(localAlerts.data?.alerts.map((alert: any) => alert.id)).not.toContain('foreign-expired');
    expect(localAlerts.data?.counts.lowStock).toBe(1);

    const localOpening = await getOpeningBalancesAction();
    expect(localOpening.success).toBe(true);
    expect(localOpening.data?.map((item: any) => item.id)).toEqual(['local-expired']);

    mockSession = { id: 'admin', role: 'owner', pharmacy_id: 'ph-2' };

    const foreignList = await getInventoryListAction();
    expect(foreignList.success).toBe(true);
    expect(foreignList.data?.map((item: any) => item.id).sort()).toEqual([
      'foreign-active',
      'foreign-expired',
    ]);

    const foreignDetails = await getDrugDetailsFullAction(9201);
    expect(foreignDetails.success).toBe(true);
    expect(foreignDetails.data?.total_stock).toBe(18);
    expect(foreignDetails.data?.min_price).toBe(20);
    expect(foreignDetails.data?.expiry_batches.map((batch: any) => batch.batch_number).sort()).toEqual([
      'FOREIGN-ACTIVE',
      'OPEN-FOREIGN',
    ]);

    const foreignAlerts = await getInventoryAlertsAction();
    expect(foreignAlerts.success).toBe(true);
    expect(foreignAlerts.data?.alerts.map((alert: any) => alert.id)).toContain('foreign-expired');
    expect(foreignAlerts.data?.alerts.map((alert: any) => alert.id)).not.toContain('local-expired');
    expect(foreignAlerts.data?.counts.lowStock).toBe(1);

    const foreignOpening = await getOpeningBalancesAction();
    expect(foreignOpening.success).toBe(true);
    expect(foreignOpening.data?.map((item: any) => item.id)).toEqual(['foreign-expired']);
  });

  it('opens the exact alert drug instead of another in-stock drug with the same name', async () => {
    mockDb.exec(`
      INSERT INTO master_drugs (id, trade_name, trade_name_en)
      VALUES (9202, 'دواء اختبار الفروع', 'Scoped inventory drug');

      INSERT INTO inventory (
        id, pharmacy_id, drug_id, batch_number, quantity,
        local_selling_price, expiry_date
      ) VALUES ('same-name-stock', NULL, 9202, 'SAME-NAME', 0.5, 12, '2099-12-31');

      UPDATE inventory SET quantity = 0 WHERE id = 'local-active';
    `);

    const exactList = await getInventoryListAction('Scoped inventory drug', 9201);

    expect(exactList.success).toBe(true);
    // After the rebuy-alert fix, drugId filter also excludes qty=0 lots
    expect(exactList.data?.map((item: any) => item.drug_id)).toEqual([9201]);
    expect(exactList.data?.map((item: any) => item.quantity)).toEqual([3]);
  });

  it('returns every scoped matching lot and preserves cost and retail valuation inputs beyond 1,000 lots', async () => {
    mockDb.prepare(`
      INSERT INTO master_drugs (id, trade_name, trade_name_en)
      VALUES (9301, 'تقييم مخزون مجمع', 'Bulk valuation medicine')
    `).run();
    const insertLot = mockDb.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, quantity, cost_price, local_selling_price, expiry_date)
      VALUES (?, ?, 9301, ?, ?, ?, ?, '2099-12-31')
    `);
    for (let index = 0; index < 1001; index += 1) {
      insertLot.run(
        `bulk-local-${index}`,
        null,
        `BULK-${index}`,
        index === 1000 ? 0.25 : 1,
        7,
        12.5,
      );
    }
    insertLot.run('bulk-foreign', 'ph-2', 'BULK-FOREIGN', 99, 100, 200);

    const result = await getInventoryListAction('Bulk valuation medicine');

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1001);
    expect(result.data?.every((item: any) => item.drug_id === 9301)).toBe(true);
    expect(result.data?.some((item: any) => item.id === 'bulk-foreign')).toBe(false);
    expect(result.data?.reduce((total: number, item: any) => total + item.quantity, 0)).toBeCloseTo(1000.25);
    expect(result.data?.reduce((total: number, item: any) => total + item.quantity * item.cost_price, 0)).toBeCloseTo(7001.75);
    expect(result.data?.reduce((total: number, item: any) => total + item.quantity * item.local_selling_price, 0)).toBeCloseTo(12503.125);
  });

  it('uses only finalized sales, including delivered invoices, for consumption and low-stock demand', async () => {
    mockDb.exec(`
      INSERT INTO sales_invoices (id, user_id, total_amount, status, pharmacy_id, created_at) VALUES
        ('sale-completed', 'admin', 20, 'completed', NULL, CURRENT_TIMESTAMP),
        ('sale-delivered', 'admin', 30, 'delivered', NULL, CURRENT_TIMESTAMP),
        ('sale-draft', 'admin', 50, 'draft', NULL, CURRENT_TIMESTAMP),
        ('sale-cancelled', 'admin', 70, 'cancelled', NULL, CURRENT_TIMESTAMP),
        ('sale-foreign', 'admin', 110, 'completed', 'ph-2', CURRENT_TIMESTAMP);
      INSERT INTO sales_items (invoice_id, drug_id, quantity_sold, unit_price, unit, is_negative) VALUES
        ('sale-completed', 9201, 2, 10, 'large', 0),
        ('sale-delivered', 9201, 3, 10, 'large', 0),
        ('sale-draft', 9201, 5, 10, 'large', 0),
        ('sale-cancelled', 9201, 7, 10, 'large', 0),
        ('sale-foreign', 9201, 11, 10, 'large', 0);
    `);

    const details = await getDrugDetailsFullAction(9201);
    expect(details.success).toBe(true);
    expect(details.data?.consumption_stats).toEqual([
      expect.objectContaining({ net_sales: 5, transactions: 2 }),
    ]);

    const lowStock = await getLowStockAction(10);
    const item = lowStock.data?.find((row: any) => row.drug_id === 9201);
    expect(item).toEqual(expect.objectContaining({ avg_monthly_usage: 5 }));
  });

  it('keeps stock adjustments in the local pharmacy, rejects negative quantity, and posts valuation entries', async () => {
    mockDb.exec(`
      UPDATE inventory SET cost_price = 5 WHERE id = 'local-active';
      INSERT OR IGNORE INTO adjustment_reasons (id, name_ar) VALUES (9001, 'تصحيح اختبار');
    `);

    expect(await createStockAdjustmentAction('local-active', { reason_id: 9001, old_quantity: 2, new_quantity: -1 })).toEqual({
      success: false,
      error: 'الكمية الجديدة غير صالحة',
    });

    expect((await createStockAdjustmentAction('local-active', { reason_id: 9001, old_quantity: 2, new_quantity: 4 })).success).toBe(true);
    expect(mockDb.prepare("SELECT quantity FROM inventory WHERE id = 'local-active'").get()).toEqual({ quantity: 4 });
    expect(mockDb.prepare("SELECT quantity FROM inventory WHERE id = 'foreign-active'").get()).toEqual({ quantity: 7 });
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM stock_adjustments WHERE inventory_id = 'local-active'").get()).toEqual({ count: 1 });
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM journal_entries WHERE journal_id = 'test-id'").get()).toEqual({ count: 2 });
  });

  it('includes stock adjustments and zeroing in item movements', async () => {
    mockDb.prepare(`INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)`).run('admin', 'STOCK_ADJUSTMENT', 'fractional adjustment');
    mockDb.prepare(`INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)`).run('admin', 'ZERO_INVENTORY', 'manual zero');

    const movements = await getMovementsAction();
    expect(movements.success).toBe(true);
    expect(movements.data?.map((row: any) => row.action)).toEqual(expect.arrayContaining([
      'STOCK_ADJUSTMENT',
      'ZERO_INVENTORY',
    ]));
  });
});
