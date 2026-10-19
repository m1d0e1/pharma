/** @jest-environment node */
const mockInvoke = jest.fn();
const mockGet = jest.fn();
const mockSelect = jest.fn();
let mockLocalUser: any;

jest.mock('@/lib/env', () => ({isTauri: true}));
jest.mock('@tauri-apps/api/core', () => ({invoke: (...args: any[]) => mockInvoke(...args)}));
jest.mock('@/lib/db/tauri', () => ({
  dbGet: (...args: any[]) => mockGet(...args),
  dbSelect: (...args: any[]) => mockSelect(...args),
  dbExecute: jest.fn(() => { throw new Error('renderer SQL execute forbidden'); }),
  dbTransaction: jest.fn(() => { throw new Error('renderer transaction forbidden'); }),
  generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => mockLocalUser,
  hasUserPermissionSync: (user: any,key: string) => Boolean(user?.permissions?.[key]),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {load: jest.fn(),getAllDrugs: jest.fn(() => []),enrich: jest.fn()},
}));
jest.mock('@/lib/inventory/refresh', () => ({notifyInventoryChanged: jest.fn()}));
jest.mock('@/app/actions-client/shifts', () => ({
  getShiftForPharmacy: jest.fn(() => { throw new Error('renderer shift SELECT forbidden'); }),
  ensurePermanentShiftForUser: jest.fn(() => { throw new Error('renderer shift write forbidden'); }),
}));
jest.unmock('@/app/actions-client/sales');

import {processCheckoutAction} from '@/app/actions-client/sales';

const item = {drug_id: 17,inventory_id: 'own-lot',quantity_sold: 1,
  unit_price: 10,selected_unit: 'large',item_discount_percent:0,is_negative:false};

describe('desktop checkout leaves actor, pharmacy, price and suspended-draft validation native', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Renderer-derived local user data can be stale/forged: native must never
    // accept either field as authoritative even for a UI owner.
    mockLocalUser = {id:'forged-user',pharmacy_id:'forged-foreign-tenant',role:'owner',
      permissions:{can_access_pos:true,show_suspended_invoices:true,can_change_price_sale:false}};
    mockInvoke.mockResolvedValue({sale_id:'sale-native',total_amount:10,
      points_earned:0,points_redeemed:0,loyalty_discount_amount:0,created_at:'2026-10-11'});
  });

  it('does not do raw SELECTs before native price and suspended-draft validations', async () => {
    const response=await processCheckoutAction({items:[item],status:'completed',
      payment_method:'cash',source_draft_id:'untrusted-draft-1'});
    expect(response).toMatchObject({success:true,data:{sale_id:'sale-native'}});
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke.mock.calls[0][0]).toBe('process_checkout_critical');
    const args=mockInvoke.mock.calls[0][1];
    expect(args.payload).toMatchObject({items:[item],source_draft_id:'untrusted-draft-1'});
    expect(args.payload).not.toHaveProperty('user_id');
    expect(args.payload).not.toHaveProperty('pharmacy_id');
    expect(args).not.toHaveProperty('sql');
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fails closed without falling back to renderer SQL when native rejects forged draft, price or actor', async () => {
    for (const reason of ['Source draft belongs to another pharmacy',
      'Unauthorized: can_change_price_sale permission required',
      'Checkout requires an active native user']) {
      mockInvoke.mockRejectedValueOnce(new Error(reason));
      const errorLog=jest.spyOn(console,'error').mockImplementation(() => {});
      try {
        expect(await processCheckoutAction({items:[item],source_draft_id:'untrusted-draft-1'}))
          .toMatchObject({success:false,error:reason});
      } finally {errorLog.mockRestore();}
    }
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
