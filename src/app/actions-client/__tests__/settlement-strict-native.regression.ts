/** @jest-environment node */
const mockInvoke = jest.fn<Promise<any>, unknown[]>();
const mockSql = jest.fn((..._args: unknown[]) => { throw Error('Private finance SQL must remain denied'); });
const mockUser = jest.fn<Promise<any>, []>(async () => ({ id: 'actor-a',pharmacy_id: 'tenant-a',role:'owner' }));

jest.mock('@/lib/env',()=>({isTauri:true}));
jest.mock('@tauri-apps/api/core',()=>({invoke:(...args:unknown[])=>mockInvoke(...args)}));
jest.mock('@/lib/db/tauri',()=>({dbSelect:(...args:unknown[])=>mockSql(...args)}));
jest.mock('@/lib/auth/local',()=>({
  getLocalSession:()=>mockUser(),hasUserPermissionSync:()=>true,
}));
jest.mock('@/lib/inventory/refresh',()=>({notifyInventoryChanged:jest.fn()}));

import { getNegativeStockInvoicesAction, getUnsettledSalesAction, getDrugBatchesAction } from '../settlement';

const sale = { item_id:5, invoice_id:'owned-sale', drug_id:12, trade_name:'Source Drug',
  trade_name_en:null, unit:'large',unit_price:15,quantity_sold:3,
  returned_quantity:1,net_unreturned_quantity:2,current_stock_balance:4,
  sale_date:'2026-10-17',created_at:'2026-10-17' };
const lot = { id:'lot-verified',inventory_id:'lot-verified', batch_number:'source',
  expiry_date:'2099-01-01',quantity:4,cost_price:2 };
const projection = (rows: unknown[], pharmacyId='tenant-a', actorId='actor-a') =>
  ({rows,pharmacyId,actorId});

describe('strict native negative-stock settlement read boundary', () => {
  beforeEach(()=>{ jest.clearAllMocks(); mockUser.mockResolvedValue({id:'actor-a',pharmacy_id:'tenant-a',role:'owner'}); });

  it('projects only authenticated received negative sales and scoped eligible batches',async()=>{
    mockInvoke.mockResolvedValueOnce(projection([sale])).mockResolvedValueOnce(projection([lot]));
    const rows = await getUnsettledSalesAction();
    expect(rows).toEqual({success:true,data:[sale]});
    const batches = await getDrugBatchesAction(12);
    expect(batches).toEqual({success:true,data:[lot]});
    expect(mockInvoke).toHaveBeenNthCalledWith(1,'read_settlement_native',{queryId:'unsettled_sales',drugId:null});
    expect(mockInvoke).toHaveBeenNthCalledWith(2,'read_settlement_native',{queryId:'drug_batches',drugId:12});
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('preserves old invoice-list shape through the same certified source without SQL',async()=>{
    mockInvoke.mockResolvedValue(projection([sale]));
    const result = await getNegativeStockInvoicesAction();
    expect(result.success).toBe(true);
    expect(result.data).toEqual([expect.objectContaining({id:5,item_id:5,net_unreturned_quantity:2})]);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects source permission, actor, pharmacy, negative and unsupported legacy data, not fake zero',async()=>{
    const invalid = [
      projection([], 'local_default'), projection([], 'foreign'), projection([], 'tenant-a','rogue'),
      projection([{...sale,quantity_sold:-1}]), projection([{...sale,net_unreturned_quantity:3}]),
      projection([{...sale,item_id:0}]), projection([{...sale,trade_name:'\u0000private'}]),
      projection(Array(101).fill(sale)), {},null,
    ];
    for (const wrong of invalid) {
      mockInvoke.mockResolvedValueOnce(wrong);
      const result = await getUnsettledSalesAction();
      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
    }
    mockUser.mockResolvedValueOnce({id:'actor-a',pharmacy_id:'local_default',role:'owner'});
    const denied = await getDrugBatchesAction(12);
    expect(denied.success).toBe(false);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects invalid lot/unknown drug and propagates native denial without retry SQL',async()=>{
    mockInvoke.mockResolvedValueOnce(projection([{...lot,quantity:NaN}]));
    expect((await getDrugBatchesAction(12)).success).toBe(false);
    mockInvoke.mockRejectedValueOnce(Error('Synthetic unreceipted legacy sale'));
    expect((await getUnsettledSalesAction()).success).toBe(false);
    expect((await getDrugBatchesAction(0)).success).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
