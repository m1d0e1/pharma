/** @jest-environment node */
const mockInvoke=jest.fn();
const mockGeneric=jest.fn((..._args:unknown[])=>{throw new Error('forbidden renderer-selected SQL');});
const mockSession=jest.fn(()=>{throw new Error('untrusted renderer actor');});
jest.mock('@/lib/env',()=>({isTauri:true}));
jest.mock('@tauri-apps/api/core',()=>({invoke:(...args:unknown[])=>mockInvoke(...args)}));
jest.mock('@/lib/db/tauri',()=>({
  dbSelect:(...args:unknown[])=>mockGeneric(...args),dbGet:(...args:unknown[])=>mockGeneric(...args),
  dbExecute:(...args:unknown[])=>mockGeneric(...args),dbTransaction:(...args:unknown[])=>mockGeneric(...args),
  generateId:()=> 'paper-create-nonce',normalizeDatabaseTimestamps:(v:unknown)=>v,
}));
jest.mock('@/lib/auth/local',()=>({getLocalSession:()=>mockSession(),hasUserPermissionSync:jest.fn()}));
jest.mock('@/app/actions-client/shifts',()=>({ensurePermanentShiftForUser:jest.fn(),getShiftForPharmacy:jest.fn()}));
import { addPaperAction,deletePaperAction,getPapersAction } from '@/app/actions-client/finance';

const create={
  type:'check' as const,direction:'in' as const,paper_number:'CHK-778',
  bank_id:12,amount:75.25,due_date:'2026-11-05',target_name:'Synthetic Partner',
  notes:'No owner claims',
};
describe('native commercial paper CRUD is actor and tenant bound in Rust',()=>{
  beforeEach(()=>jest.clearAllMocks());
  it('creates with intent DTO only and an immutable replay nonce',async()=>{
    mockInvoke.mockResolvedValueOnce({id:'native-paper'});
    expect(await addPaperAction(create)).toEqual({success:true,id:'native-paper'});
    expect(mockInvoke).toHaveBeenCalledWith('create_paper_native',{payload:{
      paperType:'check',direction:'in',paperNumber:'CHK-778',bankId:12,
      amount:75.25,dueDate:'2026-11-05',targetName:'Synthetic Partner',
      notes:'No owner claims',requestId:'paper-create-nonce',
    }});
    expect(mockGeneric).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('forwards an explicit validated paper retry ID unchanged',async()=>{
    const request_id='30b901c2-568b-45e0-91ef-9ae75a43ae57';
    mockInvoke.mockResolvedValueOnce({id:'native-paper'});
    expect((await addPaperAction({...create,request_id})).success).toBe(true);
    expect(mockInvoke.mock.calls[0][1].payload.requestId).toBe(request_id);
  });
  it('deletes only by opaque ID, without renderer checks or cash flow calls',async()=>{
    mockInvoke.mockResolvedValueOnce(null);
    expect(await deletePaperAction('paper-a')).toEqual({success:true});
    expect(mockInvoke).toHaveBeenCalledWith('delete_paper_native',{payload:{id:'paper-a'}});
    expect(mockGeneric).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('gets all native history pages without silent truncation or generic SQL fallback',async()=>{
    mockInvoke
      .mockResolvedValueOnce({rows:Array.from({length:100},(_,i)=>({id:`a-${i}`,pharmacy_id:'branch-a'})),hasMore:true})
      .mockResolvedValueOnce({rows:[{id:'last',pharmacy_id:'branch-a'}],hasMore:false});
    const response=await getPapersAction();
    expect(response.success).toBe(true);
    expect(response.data).toHaveLength(101);
    expect(mockInvoke).toHaveBeenNthCalledWith(1,'list_papers_native',{payload:{page:0}});
    expect(mockInvoke).toHaveBeenNthCalledWith(2,'list_papers_native',{payload:{page:1}});
    expect(mockGeneric).not.toHaveBeenCalled();
  });
  it('rejects incomplete acknowledgements, malformed pages and native authorization failures',async()=>{
    const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {
      mockInvoke.mockResolvedValueOnce({});
      expect((await addPaperAction(create)).success).toBe(false);
      mockInvoke.mockResolvedValueOnce({rows:[],hasMore:true});
      expect((await getPapersAction()).success).toBe(false);
      mockInvoke.mockRejectedValueOnce(new Error('other pharmacy'));
      expect((await deletePaperAction('foreign')).success).toBe(false);
    } finally {quiet.mockRestore();}
    expect(mockGeneric).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
});
