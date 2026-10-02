import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let mockSession: { id: string; role: string; pharmacy_id: string | null; permissions?: unknown };

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => callback(mockCreateSqliteTransactionDb(mockDb))),
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

jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

jest.unmock('@/app/actions-client/inventory');
jest.unmock('@/app/actions-client/master-drugs');

import {
  addInventoryAction,
  addOpeningBalanceAction,
  getDrugDetailsFullAction,
  getInventoryAlertsAction,
  getInventoryListAction,
  getLowStockAction,
  getMovementsAction,
  getOpeningBalancesAction,
} from '@/app/actions-client/inventory';
import { createStockAdjustmentAction } from '@/app/actions-client/master-drugs';
import { notifyInventoryChanged } from '@/lib/inventory/refresh';

describe('inventory read models preserve pharmacy boundaries', () => {
  beforeEach(() => {
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    mockDb = new Database(':memory:');
    mockDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
    // Native startup adds these compatibility columns before actions can run.
    mockDb.exec(`
      ALTER TABLE sales_items ADD COLUMN large_to_medium INTEGER DEFAULT 1;
      ALTER TABLE sales_items ADD COLUMN medium_to_small INTEGER DEFAULT 1;
      ALTER TABLE inventory ADD COLUMN medium_to_small INTEGER DEFAULT 1;
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

  it('keeps reorder alerts scoped to usable inventory in the signed-in pharmacy', async () => {
    mockDb.exec(`
      INSERT INTO master_drugs (id, trade_name, trade_name_en, reorder_point, has_expiry) VALUES
        (9401, 'أجنبي فقط', 'Foreign only reorder', 5, 1),
        (9402, 'منتهي فقط', 'Expired only reorder', 5, 1),
        (9403, 'محلي صفري', 'Local zero reorder', 5, 1),
        (9404, 'صلاحية مجهولة', 'Unknown expiry reorder', 5, 1);

      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date) VALUES
        ('foreign-only-reorder', 'ph-2', 9401, 1, 10, '2099-12-31'),
        ('expired-only-reorder', NULL, 9402, 1, 10, '2020-01-01'),
        ('local-zero-reorder', NULL, 9403, 0, 10, '2099-12-31'),
        ('unknown-expiry-reorder', NULL, 9404, 5, 10, NULL);
    `);

    const local = await getLowStockAction(10);
    expect(local.success).toBe(true);
    expect(local.data?.map((row: any) => row.drug_id)).toContain(9403);
    expect(local.data?.find((row: any) => row.drug_id === 9404)).toEqual(
      expect.objectContaining({ current_stock: 0, quantity: 0 }),
    );
    expect(local.data?.map((row: any) => row.drug_id)).not.toContain(9401);
    expect(local.data?.map((row: any) => row.drug_id)).not.toContain(9402);

    const localAlerts = await getInventoryAlertsAction();
    expect(localAlerts.success).toBe(true);
    expect(localAlerts.data?.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 9404, alert_type: 'low_stock', quantity: 0 }),
    ]));

    mockSession = { id: 'admin', role: 'owner', pharmacy_id: 'ph-2' };
    const foreign = await getLowStockAction(10);
    expect(foreign.success).toBe(true);
    expect(foreign.data?.map((row: any) => row.drug_id)).toContain(9401);
    expect(foreign.data?.map((row: any) => row.drug_id)).not.toContain(9403);
  });

  it('normalizes mixed sale units to large units for box-per-month consumption', async () => {
    mockDb.exec(`
      UPDATE master_drugs
      SET large_to_medium = 10, medium_to_small = 2, medium_unit = 'strip', small_unit = 'tablet'
      WHERE id = 9201;
      INSERT INTO sales_invoices (id, user_id, total_amount, status, pharmacy_id, created_at)
      VALUES ('mixed-unit-consumption', 'admin', 100, 'completed', NULL, CURRENT_TIMESTAMP);
      INSERT INTO sales_items (
        invoice_id, drug_id, quantity_sold, unit_price, unit, is_negative, large_to_medium, medium_to_small
      ) VALUES
        ('mixed-unit-consumption', 9201, 10, 2, 'medium', 0, 10, 2),
        ('mixed-unit-consumption', 9201, 20, 1, 'small', 0, 10, 2);
    `);

    const details = await getDrugDetailsFullAction(9201);

    expect(details.success).toBe(true);
    expect(details.data?.consumption_stats).toEqual([
      expect.objectContaining({ net_sales: 2, transactions: 2 }),
    ]);
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
    expect(notifyInventoryChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps generated stock-adjustment movements visible to a non-default pharmacy', async () => {
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: 'ph-2' };
    mockDb.exec(`
      UPDATE inventory SET cost_price = 5 WHERE id = 'foreign-active';
      INSERT OR IGNORE INTO adjustment_reasons (id, name_ar) VALUES (9001, 'تصحيح اختبار');
    `);

    const adjustment = await createStockAdjustmentAction('foreign-active', {
      reason_id: 9001,
      old_quantity: 7,
      new_quantity: 8,
    });
    expect(adjustment.success).toBe(true);

    const movements = await getMovementsAction();
    expect(movements.success).toBe(true);
    expect(movements.data?.filter((row: any) => row.action === 'STOCK_ADJUSTMENT')).toEqual([
      expect.objectContaining({ pharmacy_id: 'ph-2' }),
    ]);
  });

  it('keeps generated opening-balance movements visible to a non-default pharmacy', async () => {
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: 'ph-2' };

    const opening = await addOpeningBalanceAction({
      drug_id: 9201,
      quantity: 1,
      cost_price: 0,
      unit_price: 12,
      expiry_date: '2099-12-31',
    });

    expect(opening.success).toBe(true);
    const movements = await getMovementsAction();
    expect(movements.success).toBe(true);
    expect(movements.data?.filter((row: any) => row.action === 'OPENING_BALANCE')).toEqual([
      expect.objectContaining({ pharmacy_id: 'ph-2' }),
    ]);
    expect(mockDb.prepare("SELECT pharmacy_id, quantity FROM inventory WHERE id = 'test-id'").get()).toEqual({
      pharmacy_id: 'ph-2',
      quantity: 1,
    });
  });

  it('allows null inventory expiry only for non-expiring master drugs', async () => {
    mockDb.prepare('UPDATE master_drugs SET has_expiry = 0 WHERE id = 9201').run();

    const nonExpiring = await addInventoryAction({
      drug_id: 9201,
      quantity: 1,
      local_selling_price: 12,
      expiry_date: null,
    });
    expect(nonExpiring.success).toBe(true);
    expect(mockDb.prepare("SELECT expiry_date FROM inventory WHERE id = 'test-id'").get()).toEqual({ expiry_date: null });
  });

  it('rejects null inventory expiry for expiring master drugs', async () => {
    mockDb.prepare('UPDATE master_drugs SET has_expiry = 1 WHERE id = 9201').run();

    const expiring = await addInventoryAction({
      drug_id: 9201,
      quantity: 1,
      local_selling_price: 12,
      expiry_date: null,
    });
    expect(expiring.success).toBe(false);
    expect(expiring.error).toContain('تاريخ الصلاحية');
    expect((mockDb.prepare("SELECT COUNT(*) AS total FROM inventory WHERE id = 'test-id'").get() as any).total).toBe(0);
  });

  it('allows a null opening-balance expiry only for non-expiring drugs', async () => {
    mockDb.prepare('UPDATE master_drugs SET has_expiry = 0 WHERE id = 9201').run();

    const opening = await addOpeningBalanceAction({
      drug_id: 9201,
      quantity: 1,
      cost_price: 0,
      unit_price: 12,
      expiry_date: null,
    });

    expect(opening.success).toBe(true);
    expect(mockDb.prepare("SELECT expiry_date FROM inventory WHERE id = 'test-id'").get()).toEqual({ expiry_date: null });
  });

  it('rejects a null opening-balance expiry for an expiring drug', async () => {
    mockDb.prepare('UPDATE master_drugs SET has_expiry = 1 WHERE id = 9201').run();

    const opening = await addOpeningBalanceAction({
      drug_id: 9201,
      quantity: 1,
      cost_price: 0,
      unit_price: 12,
      expiry_date: null,
    });

    expect(opening.success).toBe(false);
    expect((mockDb.prepare("SELECT COUNT(*) AS total FROM inventory WHERE id = 'test-id'").get() as any).total).toBe(0);
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

  it('includes the canonical sale, return, and purchase events emitted by current workflows', async () => {
    const insert = mockDb.prepare(`INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)`);
    insert.run('admin', 'COMPLETE_SALE', 'Sale sale-1 value 15');
    insert.run('admin', 'CREATE_RETURN', 'Return ret-1 value 5');
    insert.run('admin', 'COMPLETE_PURCHASE', 'Purchase purchase-1 completed');

    const movements = await getMovementsAction();
    expect(movements.success).toBe(true);
    expect(movements.data?.map((row: any) => row.action)).toEqual(expect.arrayContaining([
      'COMPLETE_SALE',
      'CREATE_RETURN',
      'COMPLETE_PURCHASE',
    ]));
  });

  it('does not silently hide older item movements beyond 1,000 rows', async () => {
    const insertMovement = mockDb.prepare(`
      INSERT INTO activity_log (user_id, action, details, pharmacy_id, created_at)
      VALUES ('admin', 'ADD_INVENTORY', ?, NULL, ?)
    `);
    const batch = mockDb.transaction(() => {
      for (let index = 0; index < 1001; index += 1) {
        insertMovement.run(`أضيفت دفعة ${index} من Scoped inventory drug`, `2026-09-${String((index % 27) + 1).padStart(2, '0')} 12:00:00`);
      }
    });
    batch();

    const movements = await getMovementsAction();

    expect(movements.success).toBe(true);
    expect(movements.data).toHaveLength(1001);
  });

  it('does not silently hide opening-balance rows beyond 100 records', async () => {
    const insertOpening = mockDb.prepare(`
      INSERT INTO inventory (
        id, pharmacy_id, drug_id, batch_number, quantity, cost_price, local_selling_price, expiry_date, created_at
      ) VALUES (?, NULL, 9201, ?, 1, 5, 10, '2099-12-31', ?)
    `);
    const batch = mockDb.transaction(() => {
      for (let index = 0; index < 101; index += 1) {
        insertOpening.run(
          `opening-history-${index}`,
          `OPEN-HISTORY-${index}`,
          `2026-09-${String((index % 27) + 1).padStart(2, '0')} 12:00:00`,
        );
      }
    });
    batch();

    const balances = await getOpeningBalancesAction();

    expect(balances.success).toBe(true);
    expect(balances.data).toHaveLength(102);
  });
});
