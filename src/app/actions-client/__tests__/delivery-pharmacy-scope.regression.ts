jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => []),
  dbGet: jest.fn(async () => null),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
  generateId: jest.fn(() => 'id-1'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'user-1', role: 'admin', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: jest.fn() }));

import { closeDeliveryInvoiceAction, getPendingDeliveriesAction } from '@/app/actions-client/delivery';
import { dbGet, dbSelect } from '@/lib/db/tauri';

const mockDbSelect = dbSelect as jest.Mock;
const mockDbGet = dbGet as jest.Mock;

describe('delivery pharmacy scoping', () => {
  beforeEach(() => {
    mockDbSelect.mockClear();
    mockDbGet.mockClear();
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
});
