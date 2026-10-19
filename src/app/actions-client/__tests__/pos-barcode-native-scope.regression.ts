/** @jest-environment node */
const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
const mockDbGet = jest.fn();
let mockSession: any;

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockDbSelect(...args),
  dbGet: (...args: any[]) => mockDbGet(...args),
  dbExecute: jest.fn(), dbTransaction: jest.fn(), generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => mockSession,
  hasUserPermissionSync: (user: any, key: string) => Boolean(user?.permissions?.[key]),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), getAllDrugs: jest.fn(() => []), enrich: jest.fn() },
}));
jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(), getShiftForPharmacy: jest.fn(),
}));
jest.unmock('@/app/actions-client/sales');

import { barcodeLookupAction } from '@/app/actions-client/sales';

describe('native POS barcode lot search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { id: 'cashier-a', role: 'cashier', pharmacy_id: 'a',
      permissions: { can_access_pos: true } };
    mockInvoke.mockImplementation(async (command: string, args: any) => {
      if (command !== 'db_read_scoped') throw new Error('Unexpected command');
      if (args.queryId === 'pos.barcode_candidates') return [{ id: 7 }];
      if (args.queryId === 'pos.barcode_first') return [{
        id: 7,trade_name: 'Drug',trade_name_en: 'Drug',generic_name: 'Medicine',
        official_price: 100,unit_price: 110,quantity: 3,inventory_id: 'a-batch',
        large_unit: 'box',medium_unit:'strip',small_unit:'tablet',
        large_to_medium: 10,medium_to_small:10,reorder_point: 5,
        avg_cost_price: null,nearest_expiry: null,
      }];
      if (args.queryId === 'pos.barcode_batches') return [{
        inventory_id: 'a-batch',quantity:3,expiry_date:null,local_selling_price:110,
        strips_per_box:10,medium_to_small:10,cost_price:null,
      }];
      throw new Error('Native query not found');
    });
  });

  it('preserves an authorized barcode POS response without sending SQL, actor, or tenant', async () => {
    const result = await barcodeLookupAction('CODE');
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      id: 7,quantity:3,inventory_id:'a-batch',cost_price:0,
      batches:[{ inventory_id:'a-batch',quantity:3 }],
    });
    expect(mockInvoke.mock.calls.map((call: any[]) => call[1].queryId)).toEqual([
      'pos.barcode_candidates','pos.barcode_first','pos.barcode_batches',
    ]);
    for (const [, args] of mockInvoke.mock.calls) {
      expect(args.pharmacyId).toBeUndefined();
      expect(args.userId).toBeUndefined();
      expect(args.sql).toBeUndefined();
    }
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
  });

  it('detects conflicting barcodes and refuses native permission denial without fallback', async () => {
    mockInvoke.mockResolvedValueOnce([{ id: 7 },{ id: 8 }]);
    expect((await barcodeLookupAction('CODE')).success).toBe(false);
    mockInvoke.mockReset();
    mockInvoke.mockRejectedValueOnce(new Error('Native POS role denied'));
    expect((await barcodeLookupAction('CODE')).success).toBe(false);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});
