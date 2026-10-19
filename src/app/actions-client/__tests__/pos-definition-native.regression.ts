/** @jest-environment node */
const mockInvoke=jest.fn();
const mockDb=jest.fn((..._args:unknown[])=>{throw new Error('untrusted SQL');});
const mockSession=jest.fn(()=>{throw new Error('untrusted user');});
jest.mock('@/lib/env',()=>({isTauri:true}));
jest.mock('@tauri-apps/api/core',()=>({invoke:(...args:unknown[])=>mockInvoke(...args)}));
jest.mock('@/lib/db/tauri',()=>({
  dbSelect:(...args:unknown[])=>mockDb(...args),
  dbGet:(...args:unknown[])=>mockDb(...args),
  dbExecute:(...args:unknown[])=>mockDb(...args),
  dbTransaction:(...args:unknown[])=>mockDb(...args),
  generateId:()=> '3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
  normalizeDatabaseTimestamps:(v:unknown)=>v,
}));
jest.mock('@/lib/auth/local',()=>({getLocalSession:()=>mockSession(),hasUserPermissionSync:jest.fn()}));
jest.mock('@/app/actions-client/shifts',()=>({
  ensurePermanentShiftForUser:jest.fn(),getShiftForPharmacy:jest.fn(),
}));
import {
  addPointOfSaleAction, updatePointOfSaleAction, deletePointOfSaleAction,getPointsOfSaleAction,
} from '@/app/actions-client/finance';
const terminal={name_ar:'محطة أ',name_en:'Terminal A',location:'Front',computer_name:'Desk-1'};
describe('native financial POS terminal definitions',()=>{
  beforeEach(()=>jest.clearAllMocks());
  it('lists fixed tenant scope, never reads user identity or frontend-selected SQL',async()=>{
    mockInvoke.mockResolvedValueOnce([{id:4,name_ar:'POS A',pharmacy_id:'A'}]);
    expect(await getPointsOfSaleAction()).toMatchObject({success:true,data:[{id:4}]});
    expect(mockInvoke).toHaveBeenCalledWith('list_pos_devices_native');
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('creates zero-balance terminal despite a forged renderer current_balance',async()=>{
    mockInvoke.mockResolvedValueOnce({id:41});
    expect(await addPointOfSaleAction({...terminal,current_balance:9000})).toEqual({success:true,id:41});
    expect(mockInvoke).toHaveBeenCalledWith('create_pos_device_native',{payload:{
      requestId:'3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
      details:{nameAr:'محطة أ',nameEn:'Terminal A',location:'Front',
        computerName:'Desk-1',status:null},
    }});
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toContain('currentBalance');
  });
  it('updates status without accepting actor, pharmacy or balance selectors',async()=>{
    mockInvoke.mockResolvedValueOnce(null);
    expect(await updatePointOfSaleAction(2,{...terminal,current_balance:123,status:'inactive'}))
      .toEqual({success:true});
    expect(mockInvoke).toHaveBeenCalledWith('update_pos_device_native',{payload:{
      id:2, details: {nameAr:'محطة أ',nameEn:'Terminal A',location:'Front',
        computerName:'Desk-1',status:'inactive'},
    }});
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toContain('currentBalance');
  });
  it('sends deletion as opaque ID and honors rejection without SQL fallback',async()=>{
    const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {
      mockInvoke.mockRejectedValueOnce(new Error('Unreconciled branch balance'));
      expect((await deletePointOfSaleAction(42)).success).toBe(false);
    } finally {quiet.mockRestore();}
    expect(mockInvoke).toHaveBeenCalledWith('delete_pos_device_native',{payload:{id:42}});
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('rejects incomplete create/list response rather than unsafe fallback',async()=>{
    const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {
      mockInvoke.mockResolvedValueOnce({});
      expect((await addPointOfSaleAction(terminal)).success).toBe(false);
      mockInvoke.mockResolvedValueOnce([{id:'forged',name_ar:'x'}]);
      expect((await getPointsOfSaleAction()).success).toBe(false);
    } finally {quiet.mockRestore();}
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
});
