/** @jest-environment node */
const mockInvoke=jest.fn();
const mockDb=jest.fn((..._args:unknown[])=>{throw new Error('generic renderer SQL forbidden');});
const mockSession=jest.fn(()=>{throw new Error('untrusted renderer identity');});
jest.mock('@/lib/env',()=>({isTauri:true}));
jest.mock('@tauri-apps/api/core',()=>({invoke:(...args:unknown[])=>mockInvoke(...args)}));
jest.mock('@/lib/db/tauri',()=>({dbSelect:(...args:unknown[])=>mockDb(...args),
  dbGet:(...args:unknown[])=>mockDb(...args),dbExecute:(...args:unknown[])=>mockDb(...args),
  dbTransaction:(...args:unknown[])=>mockDb(...args),generateId:jest.fn(),normalizeDatabaseTimestamps:(v:unknown)=>v}));
jest.mock('@/lib/auth/local',()=>({getLocalSession:()=>mockSession(),hasUserPermissionSync:jest.fn()}));
jest.mock('@/app/actions-client/shifts',()=>({ensurePermanentShiftForUser:jest.fn(),getShiftForPharmacy:jest.fn()}));
import {updatePaperStatusAction} from '@/app/actions-client/finance';

describe('secure desktop commercial paper lifecycle',()=>{
  beforeEach(()=>jest.clearAllMocks());
  it('moves paper and cash journal in one native IPC without renderer user, pharmacy or SQL',async()=>{
    mockInvoke.mockResolvedValueOnce({changed:true});
    expect(await updatePaperStatusAction('paper-a','cashed','2026-10-11'))
      .toEqual({success:true});
    expect(mockInvoke).toHaveBeenCalledWith('update_paper_status_native',{
      payload:{id:'paper-a',newStatus:'cashed',actionDate:'2026-10-11'},
    });
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('preserves no-change replay and native denial, not a detached cash write',async()=>{
    mockInvoke.mockResolvedValueOnce({changed:false});
    expect(await updatePaperStatusAction('paper-a','cashed','2026-10-11'))
      .toEqual({success:true});
    for(const reason of ['Commercial paper not found in native pharmacy',
      'Commercial paper cash posting permission required','synthetic credit failure']) {
      mockInvoke.mockRejectedValueOnce(new Error(reason));
      const error=jest.spyOn(console,'error').mockImplementation(()=>{});
      try {expect((await updatePaperStatusAction('foreign','cashed','2026-10-11')).success).toBe(false);}
      finally {error.mockRestore();}
    }
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('rejects incomplete native acknowledgment',async()=>{
    mockInvoke.mockResolvedValueOnce({});
    const error=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {expect((await updatePaperStatusAction('paper-a','pending','2026-10-11')).success).toBe(false);}
    finally {error.mockRestore();}
    expect(mockDb).not.toHaveBeenCalled();
  });
});
