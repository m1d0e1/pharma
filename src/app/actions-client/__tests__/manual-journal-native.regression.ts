/** @jest-environment node */
const mockInvoke=jest.fn();
const mockDb=jest.fn((..._args:unknown[])=>{throw new Error('renderer-selected SQL forbidden');});
const mockSession=jest.fn(()=>{throw new Error('renderer identity forbidden');});
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
import {createManualJournalAction} from '@/app/actions-client/finance';

describe('native manual voucher posting',()=>{
  const data={date:'2026-10-11',description:'Adjustment',entries:[
    {account_id:8,type:'debit' as const,amount:14.25},
    {account_id:6,type:'credit' as const,amount:14.25,notes:'note'},
  ]};
  beforeEach(()=>jest.clearAllMocks());
  it('posts exact string cents without renderer identities or SQL',async()=>{
    mockInvoke.mockResolvedValueOnce({id:'manual-3c56ecf8-6864-4d87-86e0-5f978a8cdf12',totalAmount:14.25});
    expect(await createManualJournalAction(data)).toMatchObject({success:true});
    expect(mockInvoke).toHaveBeenCalledWith('create_manual_journal_native',{
      payload:{
        requestId:'3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
        date:'2026-10-11',description:'Adjustment',
        entries:[
          {accountId:8,type:'debit',amount:'14.25',notes:null},
          {accountId:6,type:'credit',amount:'14.25',notes:'note'},
        ],
      },
    });
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('rejects fractional cent and invalid account before IPC',async()=>{
    const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {
      expect((await createManualJournalAction({...data,entries:[
        {...data.entries[0],amount:14.251},data.entries[1]]})).success).toBe(false);
      expect((await createManualJournalAction({...data,entries:[
        {...data.entries[0],account_id:-5},data.entries[1]]})).success).toBe(false);
    } finally {quiet.mockRestore();}
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('native errors and missing acknowledgements never fall back to detached SQL',async()=>{
    const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {
      mockInvoke.mockRejectedValueOnce(new Error('Forbidden manual journal role'));
      expect((await createManualJournalAction(data)).success).toBe(false);
      mockInvoke.mockResolvedValueOnce({});
      expect((await createManualJournalAction(data)).success).toBe(false);
    } finally {quiet.mockRestore();}
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
});
