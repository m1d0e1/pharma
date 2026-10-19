/** @jest-environment node */
const mockInvoke=jest.fn();
const mockDb=jest.fn((..._args:unknown[])=>{throw new Error('forbidden renderer SQL');});
const mockSession=jest.fn(()=>{throw new Error('renderer actor untrusted');});
jest.mock('@/lib/env',()=>({isTauri:true}));
jest.mock('@tauri-apps/api/core',()=>({invoke:(...args:unknown[])=>mockInvoke(...args)}));
jest.mock('@/lib/db/tauri',()=>({
  dbSelect:(...args:unknown[])=>mockDb(...args),
  dbGet:(...args:unknown[])=>mockDb(...args),
  dbExecute:(...args:unknown[])=>mockDb(...args),
  dbTransaction:(...args:unknown[])=>mockDb(...args),
  generateId:()=> 'notice-request-nonce',
  normalizeDatabaseTimestamps:(v:unknown)=>v,
}));
jest.mock('@/lib/auth/local',()=>({getLocalSession:()=>mockSession(),hasUserPermissionSync:jest.fn()}));
jest.mock('@/app/actions-client/shifts',()=>({
  ensurePermanentShiftForUser:jest.fn(),getShiftForPharmacy:jest.fn(),
}));
import {addFinancialNoticeAction,getFinancialNoticesAction} from '@/app/actions-client/finance';

describe('native finance notices never trust renderer identity or ownership',()=>{
  beforeEach(()=>jest.clearAllMocks());
  it('posts a complete intent DTO to the one atomic native command',async()=>{
    mockInvoke.mockResolvedValueOnce({id:'native-adjustment'});
    expect(await addFinancialNoticeAction({
      target_type:'customer',target_id:'patient-A',type:'debit',
      amount:15,reason:'Correction',notes:'Synthetic',date:'2026-10-11',
    })).toEqual({success:true,id:'native-adjustment'});
    expect(mockInvoke).toHaveBeenCalledWith('create_financial_notice_native',{payload:{
      targetType:'customer',targetId:'patient-A',noticeType:'debit',
      amount:15,reason:'Correction',notes:'Synthetic',date:'2026-10-11',
      requestId:'notice-request-nonce',
    }});
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('forwards an explicit validated notice retry ID unchanged',async()=>{
    const request_id='df162a26-fde7-4549-a2e8-ea7e04988419';
    mockInvoke.mockResolvedValueOnce({id:'native-adjustment'});
    expect((await addFinancialNoticeAction({target_type:'pharmacy',type:'debit',amount:2,
      reason:'Retry',date:'2026-10-11',request_id})).success).toBe(true);
    expect(mockInvoke.mock.calls[0][1].payload.requestId).toBe(request_id);
  });
  it('normalizes the pharmacy notice form empty target into native null without weakening explicit target denial',async()=>{
    mockInvoke.mockResolvedValueOnce({id:'native-pharmacy-notice'});
    expect(await addFinancialNoticeAction({
      target_type:'pharmacy',target_id:'',type:'debit',amount:12.5,
      reason:'Synthetic shift adjustment',date:'2026-10-14',
    })).toEqual({success:true,id:'native-pharmacy-notice'});
    expect(mockInvoke).toHaveBeenCalledWith('create_financial_notice_native',{payload:{
      targetType:'pharmacy',targetId:null,noticeType:'debit',
      amount:12.5,reason:'Synthetic shift adjustment',notes:null,date:'2026-10-14',
      requestId:'notice-request-nonce',
    }});
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('native permission or provenance denial propagates without SQL fallback',async()=>{
    const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {
      mockInvoke.mockRejectedValueOnce(new Error('Ambiguous legacy patient'));
      const denied=await addFinancialNoticeAction({
        target_type:'customer',target_id:'shared',type:'credit',amount:5,
        reason:'Adjust',date:'2026-10-11',
      });
      expect(denied.success).toBe(false);
      mockInvoke.mockRejectedValueOnce(new Error('Legacy supplier balance cannot be assigned'));
      const supplier=await addFinancialNoticeAction({
        target_type:'supplier',target_id:'1',type:'debit',amount:5,
        reason:'Adjust',date:'2026-10-11',
      });
      expect(supplier.success).toBe(false);
      mockInvoke.mockResolvedValueOnce({});
      expect((await addFinancialNoticeAction({
        target_type:'pharmacy',type:'debit',amount:2,reason:'Test',date:'2026-10-11',
      })).success).toBe(false);
    } finally {quiet.mockRestore();}
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('all native history pages are fetched or rejected rather than silently truncated',async()=>{
    mockInvoke.mockResolvedValueOnce({rows:Array.from({length:100},(_,i)=>({id:`a-${i}`})),hasMore:true})
      .mockResolvedValueOnce({rows:[{id:'last'}],hasMore:false});
    const result=await getFinancialNoticesAction();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(101);
    expect(mockInvoke).toHaveBeenNthCalledWith(1,'list_financial_notices_native',{payload:{page:0}});
    expect(mockInvoke).toHaveBeenNthCalledWith(2,'list_financial_notices_native',{payload:{page:1}});
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('inconsistent history IPC fails closed',async()=>{
    const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {
      mockInvoke.mockResolvedValueOnce({rows:[],hasMore:true});
      expect((await getFinancialNoticesAction()).success).toBe(false);
    } finally {quiet.mockRestore();}
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
});
