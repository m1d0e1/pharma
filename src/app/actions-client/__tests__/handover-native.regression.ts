/** @jest-environment node */
const mockInvoke=jest.fn();
const mockDb=jest.fn((..._args:unknown[])=>{throw new Error('generic renderer SQL forbidden');});
const mockSession=jest.fn(()=>{throw new Error('renderer session is not authority');});
jest.mock('@/lib/env',()=>({isTauri:true}));
jest.mock('@tauri-apps/api/core',()=>({invoke:(...args:unknown[])=>mockInvoke(...args)}));
jest.mock('@/lib/db/tauri',()=>({
  dbSelect:(...args:unknown[])=>mockDb(...args),
  dbGet:(...args:unknown[])=>mockDb(...args),
  dbExecute:(...args:unknown[])=>mockDb(...args),
  dbTransaction:(...args:unknown[])=>mockDb(...args),
  generateId:()=> '3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
}));
jest.mock('@/lib/auth/local',()=>({
  getLocalSession:()=>mockSession(),hasUserPermissionSync:jest.fn(),verifyPassword:jest.fn(),
}));
jest.mock('@/app/actions-client/shifts',()=>({
  ensurePermanentShiftForUser:jest.fn(),getShiftForPharmacy:jest.fn(),
}));
jest.mock('@/lib/finance/drawer',()=>({loadHandoverDetails:jest.fn()}));
import {
  getHandoverDetailsAction,getShiftCreditSalesAction,processHandoverAction,getOpenShiftHandoverAction,
} from '@/app/actions-client/handover';

const input={
  shiftId:'shift-A',actualCash:100,transferAmount:75,transferTargetId:'4',
  transferTargetType:'bank' as const,receiverUsername:'receiver-A',
  receiverPasswordHash:'entered-secret',notes:'Cash transfer',autoOpenNewShift:true,
};
const confirmation={
  difference:0,remainingCash:25,status:'closed',newShiftId:'shift-B',
  startingCash:25,receiverId:'receiver-id',transferTargetType:'bank',
};
describe('desktop handover never delegates parent financial posting to renderer SQL',()=>{
  beforeEach(()=>{jest.clearAllMocks();});
  it('passes just financial intent and receiver password for locked native verification',async()=>{
    mockInvoke.mockResolvedValueOnce(confirmation);
    expect(await processHandoverAction(input)).toMatchObject({success:true,...confirmation});
    expect(mockInvoke).toHaveBeenCalledWith('process_handover_native',{payload:{
      shiftId:'shift-A',actualCash:100,transferAmount:75,
      transferTargetType:'bank',transferTargetId:'4',
      receiverUsername:'receiver-A',receiverPassword:'entered-secret',
      notes:'Cash transfer',requestId:'3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
    }});
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toMatch(/pharmacyId|userId|role|accountId|passwordHash|sql/i);
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('blocks managed user closure until a complete owner-authorized native operation exists',async()=>{
    const error=jest.spyOn(console,'error').mockImplementation(()=>{});
    try{
      expect((await processHandoverAction({...input,closeOnly:true,managedUserId:'owner'})).success).toBe(false);
      expect((await processHandoverAction({...input,deactivateManagedUser:true})).success).toBe(false);
    }finally{error.mockRestore();}
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('native failure and malformed reply never fall back to stale SQL',async()=>{
    const error=jest.spyOn(console,'error').mockImplementation(()=>{});
    try{
      mockInvoke.mockRejectedValueOnce(new Error('Foreign destination'));
      expect((await processHandoverAction(input)).success).toBe(false);
      mockInvoke.mockResolvedValueOnce({...confirmation,remainingCash:Infinity});
      expect((await processHandoverAction(input)).success).toBe(false);
    }finally{error.mockRestore();}
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('surfaces safe native receiver or shift rejection from Tauri string errors',async()=>{
    const error=jest.spyOn(console,'error').mockImplementation(()=>{});
    try{
      mockInvoke.mockRejectedValueOnce('Receiver authentication failed or account is not active in this pharmacy');
      expect(await processHandoverAction(input)).toMatchObject({
        success:false,error:'Receiver authentication failed or account is not active in this pharmacy',
      });
      mockInvoke.mockRejectedValueOnce('Shift was closed, replaced or belongs to another pharmacy');
      expect(await processHandoverAction(input)).toMatchObject({
        success:false,error:'Shift was closed, replaced or belongs to another pharmacy',
      });
      mockInvoke.mockRejectedValueOnce('database internal: SELECT password_hash');
      expect(await processHandoverAction(input)).toMatchObject({
        success:false,error:'فشل إتمام عملية التسليم',
      });
    }finally{error.mockRestore();}
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('reads only native tenant-filtered shift cash snapshot',async()=>{
    mockInvoke.mockResolvedValueOnce({actorId:'actor-A',pharmacyId:'A',data:{
      id:'shift-A',status:'open',starting_cash:25,expected_cash:100}});
    expect(await getHandoverDetailsAction('shift-A')).toMatchObject({
      success:true,data:{id:'shift-A',expected_cash:100},
    });
    expect(mockInvoke).toHaveBeenCalledWith('get_handover_details_native',{payload:{shiftId:'shift-A'}});
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('bootstraps handover shift only via permission-gated native command',async()=>{
    mockInvoke.mockResolvedValueOnce({
      id:'shift-A',user_id:'staff-A',start_time:null,starting_cash:0,status:'open',
    });
    expect(await getOpenShiftHandoverAction()).toMatchObject({
      success:true,data:{id:'shift-A',status:'open'},
    });
    expect(mockInvoke).toHaveBeenCalledWith('ensure_handover_shift_native');
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
    mockInvoke.mockResolvedValueOnce({id:'shift-A',user_id:'staff-A',status:'closed',starting_cash:0});
    expect((await getOpenShiftHandoverAction()).success).toBe(false);
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('reads bounded native credit sales without global patient SQL join',async()=>{
    mockInvoke.mockResolvedValueOnce({
      actorId:'actor-A',pharmacyId:'A',shiftId:'shift-A',
      rows:[{id:'sale-1',credit_amount:25,patient_name:'عميل آجل'}]});
    expect((await getShiftCreditSalesAction('shift-A')).data).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledWith('get_shift_credit_sales_native',{payload:{shiftId:'shift-A'}});
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('denies broken financial projection rather than returning potentially incomplete figures',async()=>{
    const error=jest.spyOn(console,'error').mockImplementation(()=>{});
    try{
      mockInvoke.mockResolvedValueOnce({actorId:'actor-A',pharmacyId:'A',data:{
        id:'shift-A',status:'open',starting_cash:25,expected_cash:'100'}});
      expect((await getHandoverDetailsAction('shift-A')).success).toBe(false);
      mockInvoke.mockResolvedValueOnce({
        actorId:'actor-A',pharmacyId:'A',shiftId:'shift-A',rows:[{id:'sale-1',credit_amount:'25'}]});
      expect((await getShiftCreditSalesAction('shift-A')).success).toBe(false);
    }finally{error.mockRestore();}
    expect(mockDb).not.toHaveBeenCalled();
  });
});
