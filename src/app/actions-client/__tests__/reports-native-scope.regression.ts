/** @jest-environment node */
const mockInvoke = jest.fn();
const mockSelect = jest.fn();
const mockGet = jest.fn();
const mockExecute = jest.fn();
let mockSession: any = {
  id: 'reporter-a', pharmacy_id: 'pharmacy-a', role: 'cashier',
  permissions: { rep_can_view_sales: true },
};

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockSelect(...args),
  dbGet: (...args: any[]) => mockGet(...args),
  dbExecute: (...args: any[]) => mockExecute(...args),
  dbTransaction: jest.fn(),
  normalizeDatabaseTimestamps: (rows: any[]) => rows,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => mockSession,
  hasUserPermissionSync: (user: any, key: string) => Boolean(user?.permissions?.[key]),
}));
jest.mock('@/lib/time', () => ({ localDate: () => '2026-10-11' }));

import { getDashboardKPIsAction, getReportsDataAction, getSalesTrendAction } from '@/app/actions-client/reports';

describe('native pharmacy sales reports never trust renderer SQL or tenant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { id: 'reporter-a', pharmacy_id: 'pharmacy-a', role: 'cashier',
      permissions: { rep_can_view_sales: true } };
    mockInvoke.mockImplementation(async (command: string, args: any) => {
      if (command !== 'db_read_scoped') throw new Error('Unrecognized native command');
      if (args.queryId === 'reports.trend') return [{ date: '2026-10-11', sales: 12, returns: 2, net_sales: 10 }];
      if (args.queryId === 'reports.sales_history') {
        return args.offset === 0 ? [{ created_at: '2026-10-11', total_amount: 12 }] : [];
      }
      if (args.queryId === 'reports.top_drugs') return [{ trade_name: 'Medicine', quantity_sold: 2 }];
      if (args.queryId === 'reports.categories') return [{ category: 'A', quantity_sold: 2 }];
      if (args.queryId === 'reports.total_units') return [{ total: 2 }];
      if (args.queryId === 'reports.kpis') return [{
        sales_today: 120, gross_profit_today: 45, liquidity: 70,
        pending_delivery_cash: 20, shrinkage_today: 4, stock_alerts_count: 3,
      }];
      throw new Error('Query ID not authorized');
    });
  });

  it('routes bounded sales trends through native IDs, not SQL or a claimed pharmacy', async () => {
    const result = await getSalesTrendAction(7);
    expect(result).toEqual({ success: true, data: [
      { date: '2026-10-11', sales: 12, returns: 2, net_sales: 10 },
    ] });
    expect(mockInvoke).toHaveBeenCalledWith('db_read_scoped', {
      queryId: 'reports.trend', recordId: null, limit: 200, offset: 0,
      search: '7', drugId: null,
    });
    const args = mockInvoke.mock.calls[0][1];
    expect(args.userId).toBeUndefined();
    expect(args.pharmacyId).toBeUndefined();
    expect(args.sql).toBeUndefined();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('preserves all four report response projections through native operations', async () => {
    const result = await getReportsDataAction();
    expect(result).toEqual({ success: true, data: {
      salesHistoryRaw: [{ created_at: '2026-10-11', total_amount: 12 }],
      topDrugsRaw: [{ trade_name: 'Medicine', quantity_sold: 2 }],
      categoryRaw: [{ category: 'A', quantity_sold: 2 }],
      totalUnitsSold: 2,
    } });
    expect(mockInvoke.mock.calls.map((call: any[]) => call[1].queryId)).toEqual([
      'reports.sales_history', 'reports.top_drugs', 'reports.categories', 'reports.total_units',
    ]);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('keeps the full KPI response under native authorization without renderer SQL', async () => {
    const response = await getDashboardKPIsAction();
    expect(response).toEqual({ success: true, data: {
      sales_today: 120, gross_profit_today: 45, liquidity: 70,
      pending_delivery_cash: 20, shrinkage_today: 4, stock_alerts_count: 3,
    } });
    expect(mockInvoke).toHaveBeenCalledWith('db_read_scoped', {
      queryId: 'reports.kpis', recordId: null, search: '1', limit: 1, offset: 0, drugId: null,
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('continues paginating rather than silently truncating reports over 200 rows', async () => {
    mockInvoke.mockImplementation(async (_command: string, args: any) => {
      if (args.queryId !== 'reports.trend') return [];
      return args.offset === 0 ? Array.from({ length: 200 }, (_, day) => ({ day })) :
        [{ day: 200 }];
    });
    const result = await getSalesTrendAction(201);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(201);
    expect(mockInvoke.mock.calls.map((call: any[]) => call[1].offset)).toEqual([0, 200]);
  });

  it('fails closed for native denial and malformed reporting ranges', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Authenticated role cannot view reports'));
    expect((await getReportsDataAction()).success).toBe(false);
    expect(mockSelect).not.toHaveBeenCalled();
    expect((await getSalesTrendAction(367)).success).toBe(false);
    mockSession.permissions = {};
    expect((await getSalesTrendAction(7)).success).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(4);
  });
});
