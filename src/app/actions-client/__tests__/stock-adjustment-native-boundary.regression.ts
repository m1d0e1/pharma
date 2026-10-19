/** @jest-environment node */
const mockInvoke = jest.fn();
const mockSql = jest.fn((..._args: unknown[]) => { throw new Error('renderer SQL is forbidden in native adjustment'); });
const mockSession = jest.fn(() => { throw new Error('renderer session must not authorize inventory'); });
const mockNotify = jest.fn();

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockSql(...args),
  dbGet: (...args: unknown[]) => mockSql(...args),
  dbExecute: (...args: unknown[]) => mockSql(...args),
  dbTransaction: (...args: unknown[]) => mockSql(...args),
  generateId: jest.fn(() => 'mock-id'),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: () => mockSession(),
  hasUserPermissionSync: jest.fn(() => false),
}));
jest.mock('@/lib/inventory/refresh', () => ({
  notifyDrugCatalogChanged: jest.fn(),
  notifyInventoryChanged: () => mockNotify(),
}));
jest.unmock('@/app/actions-client/master-drugs');
import { createStockAdjustmentAction } from '@/app/actions-client/master-drugs';

describe('native stock adjustment authorization boundary', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => error.mockRestore());

  it('forwards only the trusted-native intent and optimistic original quantity', async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, id: 'lot-tenant-a' });
    expect(await createStockAdjustmentAction('lot-tenant-a', {
      old_quantity: 1.5, new_quantity: 1 / 12, reason_id: 2, notes: 'no actor, ledger or pharmacy',
    })).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledWith('adjust_inventory_lot_native', {
      payload: { id: 'lot-tenant-a', expectedQuantity: 1.5, quantity: 1 / 12, reasonId: 2 },
    });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed input, foreign tenant denial and forged ACK without SQL fallback', async () => {
    expect((await createStockAdjustmentAction('lot-a', {
      old_quantity: 1, new_quantity: -1, reason_id: 2,
    })).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    mockInvoke.mockRejectedValueOnce(new Error('cross tenant'));
    expect((await createStockAdjustmentAction('lot-a', {
      old_quantity: 1, new_quantity: 2, reason_id: 2,
    })).success).toBe(false);
    mockInvoke.mockResolvedValueOnce({ success: true, id: 'another-tenant-lot' });
    expect((await createStockAdjustmentAction('lot-a', {
      old_quantity: 1, new_quantity: 2, reason_id: 2,
    })).success).toBe(false);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
