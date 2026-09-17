jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => []),
  dbGet: jest.fn(),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'user-1', role: 'admin', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

import { getReportsDataAction } from '@/app/actions-client/reports';
import { getSalesReportsAction } from '@/app/actions-client/sales-reports';
import { dbSelect } from '@/lib/db/tauri';

const mockDbSelect = dbSelect as jest.Mock;

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
});
