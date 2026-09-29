import Database from 'better-sqlite3';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let mockSession: any;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => callback(mockCreateSqliteTransactionDb(mockDb))),
  generateId: jest.fn(() => 'test-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, permission: string) => Boolean(user?.permissions?.[permission])),
}));

jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(),
  getShiftForPharmacy: jest.fn(),
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));

import { getSalesDashboardStatsAction } from '@/app/actions-client/sales';

describe('sales dashboard pharmacy scope', () => {
  beforeEach(() => {
    mockSession = {
      id: 'u1',
      role: 'admin',
      pharmacy_id: 'ph-1',
      permissions: { rep_can_view_sales: true },
    };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY,
        pharmacy_id TEXT,
        total_amount REAL,
        payment_method TEXT,
        status TEXT,
        created_at TEXT
      );

      INSERT INTO sales_invoices VALUES
        ('ph1-today', 'ph-1', 100, 'cash', 'completed', datetime('now')),
        ('ph1-delivery', 'ph-1', 40, 'delivery', 'completed', datetime('now')),
        ('ph2-today', 'ph-2', 900, 'cash', 'completed', datetime('now')),
        ('ph2-delivery', 'ph-2', 600, 'delivery', 'completed', datetime('now')),
        ('ph1-yesterday', 'ph-1', 70, 'cash', 'completed', datetime('now', '-1 day')),
        ('ph2-yesterday', 'ph-2', 700, 'cash', 'completed', datetime('now', '-1 day'));
    `);
  });

  afterEach(() => mockDb.close());

  it('keeps sales dashboard aggregates inside the signed-in pharmacy', async () => {
    expect(await getSalesDashboardStatsAction()).toMatchObject({
      success: true,
      data: {
        todaySales: 140,
        deliveryCount: 1,
        pendingDeliveryCountText: 'يوجد 1 طلبات قيد الانتظار',
        averageInvoice: 70,
      },
    });
  });

  it('uses the same finalized-sale statuses as reports and excludes draft/cancelled deliveries', async () => {
    mockDb.exec(`
      INSERT INTO sales_invoices VALUES
        ('ph1-approved', 'ph-1', 30, 'cash', 'approved', datetime('now')),
        ('ph1-legacy', 'ph-1', 20, 'cash', NULL, datetime('now')),
        ('ph1-draft-delivery', 'ph-1', 500, 'delivery', 'draft', datetime('now')),
        ('ph1-cancelled-delivery', 'ph-1', 600, 'delivery', 'cancelled', datetime('now'));
    `);

    expect(await getSalesDashboardStatsAction()).toMatchObject({
      success: true,
      data: {
        todaySales: 190,
        deliveryCount: 1,
        averageInvoice: 48,
      },
    });
  });
});
