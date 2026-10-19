/** @jest-environment node */
const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
const mockCacheLoad = jest.fn();
let mockSession: any;

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockDbSelect(...args), dbGet: jest.fn(),
  dbExecute: jest.fn(), dbTransaction: jest.fn(), generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => mockSession,
  hasUserPermissionSync: (user: any, key: string) => Boolean(user?.permissions?.[key]),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: (...args: any[]) => mockCacheLoad(...args), getAllDrugs: jest.fn() },
}));
jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(), getShiftForPharmacy: jest.fn(),
}));
jest.unmock('@/app/actions-client/sales');

import { searchDrugsAction } from '@/app/actions-client/sales';

describe('desktop POS free-text drug search through native role/pharmacy scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { id: 'a', pharmacy_id: 'claimed-forgery', role: 'cashier',
      permissions: { can_access_pos: true } };
    mockInvoke.mockImplementation(async (command: string, args: any) => {
      if (command !== 'db_read_scoped') throw new Error('Wrong command');
      if (args.queryId === 'pos.search_candidates') return [{
        id: 17,trade_name:'Paracetamol',trade_name_en:'Paracetamol',
        active_ingredient:'acetaminophen',category:'Analgesic',official_price:100,
        total_stock:8,min_price:110,avg_cost_price:null,nearest_expiry:'2030-12-01',
        max_strips:10,large_to_medium:10,medium_to_small:10,reorder_point:12,
        large_unit:'box',medium_unit:'strip',small_unit:'tablet',
      }];
      if (args.queryId === 'pos.barcode_batches') return [{
        inventory_id:'native-a-lot',quantity:8,expiry_date:'2030-12-01',
        local_selling_price:110,strips_per_box:10,medium_to_small:10,cost_price:null,
      }];
      throw new Error('Unauthorized query');
    });
  });

  it('retains POS response and never sends renderer actor, tenant, generic SQL or reads cache', async () => {
    const result = await searchDrugsAction('Paracetamol', 20);
    expect(result).toMatchObject({ success:true, data:[{
      id:17,total_stock:8,min_price:110,cost_price:0,needs_reorder:true,
      profit_margin:null,batches:[{inventory_id:'native-a-lot',quantity:8,unit_price:110}],
      units:{large:'box',medium:'strip',small:'tablet',large_to_medium:10,medium_to_small:10},
    }] });
    expect(mockInvoke.mock.calls.some(([, args]: any[]) => args.queryId === 'pos.search_candidates')).toBe(true);
    for (const [, args] of mockInvoke.mock.calls) {
      expect(args).not.toHaveProperty('sql');
      expect(args).not.toHaveProperty('pharmacyId');
      expect(args).not.toHaveProperty('userId');
      expect(args).not.toHaveProperty('permissions');
    }
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockCacheLoad).not.toHaveBeenCalled();
  });

  it('uses fixed ingredient mode, deduplicates variants and does not fall back after denial', async () => {
    const active = await searchDrugsAction('acetaminophen', 10, true);
    expect(active.success).toBe(true);
    expect(mockInvoke.mock.calls.find(([, args]: any[]) => args.queryId === 'pos.search_candidates')[1].recordId).toBe('ingredient');
    mockInvoke.mockReset();
    mockInvoke.mockRejectedValue(new Error('Native authorization rejected actor'));
    const denied = await searchDrugsAction('acetaminophen', 10, true);
    expect(denied.success).toBe(false);
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockCacheLoad).not.toHaveBeenCalled();
  });

  it('refuses malformed limits and UI permission denial without database fallback', async () => {
    expect((await searchDrugsAction('Paracetamol', 5000)).success).toBe(false);
    expect((await searchDrugsAction('a\0b', 20)).success).toBe(false);
    mockSession.permissions.can_access_pos = false;
    expect((await searchDrugsAction('Paracetamol', 20)).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});
