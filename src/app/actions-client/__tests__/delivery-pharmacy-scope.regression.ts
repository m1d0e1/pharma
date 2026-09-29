import { createFunctionTransactionDb as mockCreateFunctionTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

jest.mock('@/lib/db/tauri', () => ({
  ...(() => {
    const dbSelect = jest.fn(async () => []);
    const dbGet = jest.fn(async () => null);
    const dbExecute = jest.fn(async () => ({ rowsAffected: 1, lastInsertId: 1 }));
    return {
      dbSelect,
      dbGet,
      dbExecute,
      dbTransaction: jest.fn(async (callback: any) => callback(mockCreateFunctionTransactionDb({ select: dbSelect, get: dbGet, execute: dbExecute }))),
    };
  })(),
  generateId: jest.fn(() => 'id-1'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'user-1', role: 'admin', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: jest.fn() }));

import { closeDeliveryInvoiceAction, getPendingDeliveriesAction, getRepresentativeCashStatementAction } from '@/app/actions-client/delivery';
import { dbGet, dbSelect } from '@/lib/db/tauri';

const mockDbSelect = dbSelect as jest.Mock;
const mockDbGet = dbGet as jest.Mock;

describe('delivery pharmacy scoping', () => {
  beforeEach(() => {
    mockDbSelect.mockReset().mockResolvedValue([]);
    mockDbGet.mockReset().mockResolvedValue(null);
  });

  it('scopes the pending delivery list', async () => {
    expect((await getPendingDeliveriesAction()).success).toBe(true);
    const [sql, params] = mockDbSelect.mock.calls[0] as any[];
    expect(String(sql)).toContain('si.pharmacy_id = ?');
    expect(String(sql)).toContain('LEFT JOIN patients p ON si.patient_id = p.id');
    expect(params).toEqual(['ph-1', 'ph-1']);
  });

  it('scopes invoice lookup before closing a delivery', async () => {
    expect((await closeDeliveryInvoiceAction('inv-1', 0)).success).toBe(false);
    const [sql, params] = mockDbGet.mock.calls[0] as any[];
    expect(String(sql)).toContain('pharmacy_id = ?');
    expect(params).toEqual(['inv-1', 'ph-1', 'ph-1']);
  });

  it('scopes the representative statement and totals only pending delivery cash', async () => {
    mockDbSelect
      .mockResolvedValueOnce([
        { id: 'pending-1', total_amount: 25 },
        { id: 'pending-2', total_amount: 40 },
      ])
      .mockResolvedValueOnce([{ id: 'delivered-1', total_amount: 100 }]);

    expect(await getRepresentativeCashStatementAction()).toMatchObject({
      success: true,
      data: {
        total_pending_amount: 65,
        pending: [{ id: 'pending-1' }, { id: 'pending-2' }],
        history: [{ id: 'delivered-1' }],
      },
    });

    expect(mockDbSelect).toHaveBeenCalledTimes(2);
    for (const [sql, params] of mockDbSelect.mock.calls as any[][]) {
      expect(String(sql)).toContain('si.pharmacy_id = ?');
      expect(params).toEqual(['ph-1', 'ph-1']);
    }
    expect(String(mockDbSelect.mock.calls[0][0])).toContain("si.status = 'completed'");
    expect(String(mockDbSelect.mock.calls[1][0])).toContain("si.status = 'delivered'");
  });
});
