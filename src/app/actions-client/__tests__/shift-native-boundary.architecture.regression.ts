/** @jest-environment node */

const mockInvoke = jest.fn();
const mockShiftRows: string[] = [];
const mockGetShiftForPharmacy = jest.fn(async () => null);
const mockEnsurePermanentShiftForUser = jest.fn(async () => {
  mockShiftRows.push('premature-shift');
  return { id: 'premature-shift' };
});

jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({
    id: 'cashier-1',
    role: 'owner',
    pharmacy_id: 'ph-1',
  })),
  hasUserPermissionSync: jest.fn(() => true),
}));
jest.mock('@/app/actions-client/shifts', () => ({
  getShiftForPharmacy: () => mockGetShiftForPharmacy(),
  ensurePermanentShiftForUser: () => mockEnsurePermanentShiftForUser(),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
  dbGet: jest.fn(),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'unused'),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), getAllDrugs: jest.fn(() => []), enrich: jest.fn((rows: unknown[]) => rows) },
}));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

jest.unmock('@/app/actions-client/sales');
import { processCheckoutAction } from '@/app/actions-client/sales';

const checkoutRequest = {
  items: [{ drug_id: 1, quantity_sold: 1, unit_price: 10 }],
  payment_method: 'cash',
  status: 'completed',
};

describe('native checkout shift ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockShiftRows.length = 0;
  });

  it.each(['completed', 'draft'] as const)(
    'does not create a shift outside the native transaction when %s checkout fails',
    async (status) => {
      mockInvoke.mockRejectedValueOnce(new Error('native checkout failed'));
      const logError = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await processCheckoutAction({ ...checkoutRequest, status })).toEqual({
          success: false,
          error: 'native checkout failed',
        });
      } finally {
        logError.mockRestore();
      }

      expect(mockShiftRows).toEqual([]);
      expect(mockEnsurePermanentShiftForUser).not.toHaveBeenCalled();
      expect(mockGetShiftForPharmacy).not.toHaveBeenCalled();
      expect(mockInvoke).toHaveBeenCalledWith('process_checkout_critical', {
        requestId: expect.any(String),
        payload: expect.objectContaining({ shift_id: null, status }),
      });
    },
  );

  it('passes a selected shift through to the native pharmacy-scoped resolver', async () => {
    mockInvoke.mockResolvedValueOnce({
      sale_id: 'sale-1',
      total_amount: 10,
      points_earned: 0,
      points_redeemed: 0,
      loyalty_discount_amount: 0,
      created_at: '2026-10-08T00:00:00Z',
    });

    expect(await processCheckoutAction({ ...checkoutRequest, shift_id: 'requested-shift' }))
      .toMatchObject({ success: true, data: { sale_id: 'sale-1' } });
    expect(mockInvoke).toHaveBeenCalledWith('process_checkout_critical', {
      requestId: expect.any(String),
      payload: expect.objectContaining({ shift_id: 'requested-shift' }),
    });
    expect(mockEnsurePermanentShiftForUser).not.toHaveBeenCalled();
    expect(mockGetShiftForPharmacy).not.toHaveBeenCalled();
  });
});
