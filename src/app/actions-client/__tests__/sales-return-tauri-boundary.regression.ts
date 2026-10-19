/** @jest-environment node */

import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';

const mockInvoke = jest.fn();
const mockRequireOpenShiftId = jest.fn(async (..._args: any[]) => 'outside-created-shift');
const mockReturnStorage = new Map<string, string>();

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => mockInvoke(...args) }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({
    id: 'return-user',
    role: 'pharmacist',
    pharmacy_id: 'ph-1',
    permissions: { can_view_returns: true },
  })),
  hasUserPermissionSync: jest.fn((_user: any, permission: string) => permission === 'can_view_returns'),
}));
jest.mock('@/app/actions-client/finance', () => ({
  requireOpenShiftId: (...args: any[]) => mockRequireOpenShiftId(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
  dbGet: jest.fn(),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'unused'),
}));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

import { createReturnAction } from '@/app/actions-client/returns';

describe('native sales-return transaction boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReturnStorage.clear();
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      localStorage: {
        getItem: (key: string) => mockReturnStorage.get(key) ?? null,
        setItem: (key: string, value: string) => { mockReturnStorage.set(key, value); },
        removeItem: (key: string) => { mockReturnStorage.delete(key); },
      },
    } });
    mockInvoke.mockResolvedValue({ return_id: 'return-native', total_refund: 10 });
  });

  it('lets the native transaction resolve/create the shift instead of mutating shifts before invoke', async () => {
    const result = await createReturnAction({
      request_id: '59f56841-2142-46bc-aea7-d6b7b931690a',
      invoice_id: 'sale-1',
      shift_id: 'requested-shift',
      refund_method: 'cash',
      reason: 'test',
      expected_total_refund: 10,
      items: [{
        sale_item_id: 1,
        inventory_id: 'lot-1',
        drug_name: 'Drug',
        quantity: 1,
        unit_price: 10,
        unit: 'large',
      }],
    });

    expect(result).toEqual({ success: true, returnId: 'return-native', totalRefund: 10 });
    expect(mockRequireOpenShiftId).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith('create_return_critical', {
      requestId: expect.any(String),
      payload: expect.objectContaining({ shift_id: 'requested-shift' }),
    });
    const payload = mockInvoke.mock.calls[0][1].payload;
    expect(payload).not.toHaveProperty('user_id');
    expect(payload).not.toHaveProperty('pharmacy_id');
  });
});
