jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => []),
  dbGet: jest.fn(async () => ({})),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'user-1', role: 'admin', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

import {
  getDashboardKPIsAction,
  getReportsDataAction,
  getSalesTrendAction,
} from '@/app/actions-client/reports';
import { getSalesReportsAction } from '@/app/actions-client/sales-reports';
import { dbGet, dbSelect } from '@/lib/db/tauri';

const mockDbSelect = dbSelect as jest.Mock;
const mockDbGet = dbGet as jest.Mock;

describe('report pharmacy scoping', () => {
  beforeEach(() => mockDbSelect.mockClear());

  it('keeps dashboard report queries inside the signed-in pharmacy', async () => {
    expect((await getReportsDataAction()).success).toBe(true);
    expect(mockDbSelect).toHaveBeenCalledTimes(3);
    for (const [sql, params] of mockDbSelect.mock.calls as any[][]) {
      expect(String(sql)).toContain('pharmacy_id = ?');
      expect(String(sql)).toContain('status');
      expect(String(sql)).toContain('completed');
      expect(params).toContain('ph-1');
    }
  });

  it('scopes invoice search to the signed-in pharmacy', async () => {
    expect((await getSalesReportsAction({})).success).toBe(true);
    const [sql, params] = mockDbSelect.mock.calls[0] as any[];
    expect(String(sql)).toContain('si.pharmacy_id = ?');
    expect(String(sql)).toContain("si.status IN ('completed', 'approved', 'delivered')");
    expect(params).toContain('ph-1');
  });

  it('scopes KPI and trend queries to the signed-in pharmacy', async () => {
    expect((await getDashboardKPIsAction()).success).toBe(true);
    expect(mockDbGet.mock.calls.length).toBeGreaterThanOrEqual(6);
    for (const [sql, params] of mockDbGet.mock.calls.filter(([sql]) =>
      /sales_invoices|journal_entries|stock_adjustments|inventory/i.test(String(sql))
    ) as any[][]) {
      expect(String(sql)).toContain('pharmacy_id');
      expect(params).toContain('ph-1');
    }

    mockDbSelect.mockClear();
    expect((await getSalesTrendAction(7)).success).toBe(true);
    const [sql, params] = mockDbSelect.mock.calls[0] as any[];
    expect(String(sql)).toContain('pharmacy_id');
    expect(params).toContain('ph-1');
  });
});
