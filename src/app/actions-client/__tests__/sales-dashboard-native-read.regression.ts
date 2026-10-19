/** @jest-environment node */

const mockInvoke = jest.fn();
let mockSession: any;

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
  dbGet: jest.fn(),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, key: string) => Boolean(user?.permissions?.[key])),
}));
jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(),
  getShiftForPharmacy: jest.fn(),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), getAllDrugs: jest.fn(() => []), enrich: jest.fn((rows: any[]) => rows) },
}));

import { dbGet, dbSelect } from '@/lib/db/tauri';
import { getSalesDashboardStatsAction } from '@/app/actions-client/sales';

describe('native sales dashboard read boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = {
      id: 'reporter-a',
      role: 'pharmacist',
      pharmacy_id: 'a',
      permissions: { rep_can_view_sales: true },
    };
    mockInvoke.mockResolvedValue([{
      today_total: 160,
      yesterday_total: 70,
      delivery_count: 1,
      pending_delivery_count: 2,
      today_average: 160 / 3,
      yesterday_average: 70,
    }]);
  });

  it('routes one fixed, one-row report without renderer SQL, user, or pharmacy parameters', async () => {
    expect(await getSalesDashboardStatsAction()).toMatchObject({
      success: true,
      data: {
        todaySales: 160,
        deliveryCount: 1,
        pendingDeliveryCountText: 'يوجد 2 طلبات قيد الانتظار',
        averageInvoice: 53,
      },
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('db_read_scoped', {
      queryId: 'sales.dashboard_stats',
      recordId: null,
      limit: 1,
      offset: 0,
      search: null,
      drugId: null,
    });
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
  });

  it('refuses a denied frontend reporting permission before invoking native IPC', async () => {
    mockSession.permissions.rep_can_view_sales = false;
    expect(await getSalesDashboardStatsAction()).toEqual({ success: false, error: 'غير مصرح' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('fails closed on empty or incomplete native rows without retrying generic SQL', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const rows of [[], [{}]]) {
      mockInvoke.mockResolvedValueOnce(rows);
      expect(await getSalesDashboardStatsAction()).toMatchObject({ success: false });
    }
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
    errorLog.mockRestore();
  }, 15000);
});
