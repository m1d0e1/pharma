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

import {
  getDrugDetailsFullAction,
  getInventoryAlertsAction,
  getInventoryListAction,
  getOpeningBalancesAction,
} from '@/app/actions-client/inventory';

describe('inventory read models preserve pharmacy boundaries', () => {
  beforeEach(() => {
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    mockDb = new Database(':memory:');
    mockDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
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
});
