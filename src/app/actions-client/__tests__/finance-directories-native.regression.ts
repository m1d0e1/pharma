/** @jest-environment node */
const mockInvoke=jest.fn();
const mockDb=jest.fn((..._args:unknown[])=>{throw new Error('Renderer SQL forbidden');});
const mockSession=jest.fn(()=>{throw new Error('Renderer identity forbidden');});
jest.mock('@/lib/env',()=>({isTauri:true}));
jest.mock('@tauri-apps/api/core',()=>({invoke:(...args:unknown[])=>mockInvoke(...args)}));
jest.mock('@/lib/db/tauri',()=>({
  dbSelect:(...args:unknown[])=>mockDb(...args),dbGet:(...args:unknown[])=>mockDb(...args),
  dbExecute:(...args:unknown[])=>mockDb(...args),dbTransaction:(...args:unknown[])=>mockDb(...args),
  generateId:()=> '3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
  normalizeDatabaseTimestamps:(v:unknown)=>v,
}));
jest.mock('@/lib/auth/local',()=>({getLocalSession:()=>mockSession(),hasUserPermissionSync:jest.fn()}));
jest.mock('@/app/actions-client/shifts',()=>({ensurePermanentShiftForUser:jest.fn(),getShiftForPharmacy:jest.fn()}));
import {
  addBankAction,updateBankAction,deleteBankAction,getBanksAction,
  addCardAction,updateCardAction,deleteCardAction,getCardsAction,
} from '@/app/actions-client/finance';
describe('desktop bank, card and POS definition operations use fixed native IPC',()=>{
  beforeEach(()=>jest.clearAllMocks());
  it('creates signed opening bank balance and nonce as a single native request',async()=>{
    mockInvoke.mockResolvedValueOnce({id:6});
    expect(await addBankAction({name_ar:'Bank A',account_number:'0123',current_balance:-120.5}))
      .toEqual({success:true,id:6});
    expect(mockInvoke).toHaveBeenCalledWith('create_bank_native',{payload:{
      requestId:'3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
      nameAr:'Bank A',nameEn:null,accountNumber:'0123',branch:null,currentBalance:-120.5,
    }});
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('forwards explicit bank and card retry IDs unchanged',async()=>{
    const bankRequest='c2602c9f-73bd-4644-990b-fd6f4ac30bdf';
    const cardRequest='0c14d9e4-a7f5-4317-8d57-27094bed7ba6';
    mockInvoke.mockResolvedValueOnce({id:6}).mockResolvedValueOnce({id:17});
    expect((await addBankAction({name_ar:'Bank',request_id:bankRequest})).success).toBe(true);
    expect((await addCardAction({name_ar:'Card',request_id:cardRequest})).success).toBe(true);
    expect(mockInvoke.mock.calls.map(([,request])=>request.payload.requestId))
      .toEqual([bankRequest,cardRequest]);
  });
  it('metadata bank updates exclude mutable financial balance',async()=>{
    mockInvoke.mockResolvedValueOnce(null);
    expect(await updateBankAction(6,{name_ar:'Bank B',current_balance:999})).toEqual({success:true});
    expect(mockInvoke).toHaveBeenCalledWith('update_bank_native',{payload:{
      id:6,nameAr:'Bank B',nameEn:null,accountNumber:null,branch:null,
    }});
    mockInvoke.mockResolvedValueOnce(null);
    expect(await deleteBankAction(6)).toEqual({success:true});
    expect(mockInvoke).toHaveBeenCalledWith('delete_bank_native',{payload:{id:6}});
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toContain('currentBalance');
  });
  it('card creation preserves exact signed decimal cents; no detached ledger',async()=>{
    mockInvoke.mockResolvedValueOnce({id:17,journalId:'bank-opening'});
    expect(await addCardAction({name_ar:'Visa Machine',bank_id:4,commission_pct:1.25,current_balance:-53.17}))
      .toEqual({success:true,id:17});
    expect(mockInvoke).toHaveBeenCalledWith('create_card_native',{payload:{
      requestId:'3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
      nameAr:'Visa Machine',nameEn:null,bankId:4,commissionPct:1.25,openingBalance:'-53.17',
    }});
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('rejects noncent card input before native and trusts native role+bank checks',async()=>{
    const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {
      expect((await addCardAction({name_ar:'card',current_balance:20.001})).success).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
      mockInvoke.mockRejectedValueOnce(new Error('Foreign bank'));
      expect((await addCardAction({name_ar:'card',bank_id:400,current_balance:0})).success).toBe(false);
    } finally{quiet.mockRestore();}
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('card metadata update excludes currentBalance and deletion is native-only',async()=>{
    mockInvoke.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await updateCardAction(3,{name_ar:'Updated',bank_id:9,commission_pct:1,current_balance:500}))
      .toEqual({success:true});
    expect(await deleteCardAction(3)).toEqual({success:true});
    expect(mockInvoke).toHaveBeenNthCalledWith(1,'update_card_native',{payload:{
      id:3,nameAr:'Updated',nameEn:null,bankId:9,commissionPct:1,
    }});
    expect(mockInvoke).toHaveBeenNthCalledWith(2,'delete_card_native',{payload:{id:3}});
    expect(mockSession).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('native bank history consumes complete tenant-stable pages',async()=>{
    mockInvoke.mockResolvedValueOnce({
      actorId:'admin',pharmacyId:'A',page:0,hasMore:true,
      rows:Array.from({length:100},(_,i)=>({id:i+1,name_ar:'Bank',pharmacy_id:'A'})),
    }).mockResolvedValueOnce({
      actorId:'admin',pharmacyId:'A',page:1,hasMore:false,
      rows:[{id:101,name_ar:'Last',pharmacy_id:'A'}],
    });
    expect((await getBanksAction()).data).toHaveLength(101);
    expect(mockInvoke).toHaveBeenNthCalledWith(1,'list_banks_native',{payload:{page:0}});
    expect(mockInvoke).toHaveBeenNthCalledWith(2,'list_banks_native',{payload:{page:1}});
    expect(mockDb).not.toHaveBeenCalled();
  });
  it('cross-pharmacy card history response cannot be combined with earlier page',async()=>{
    mockInvoke.mockResolvedValueOnce({
      actorId:'admin',pharmacyId:'A',page:0,hasMore:true,
      rows:Array.from({length:100},(_,i)=>({id:i+1,name_ar:'Terminal',pharmacy_id:'A'})),
    }).mockResolvedValueOnce({
      actorId:'admin',pharmacyId:'B',page:1,hasMore:false,
      rows:[{id:101,name_ar:'Other',pharmacy_id:'B'}],
    });
    const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});
    try{ expect((await getCardsAction()).success).toBe(false); }finally{quiet.mockRestore();}
    expect(mockDb).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
  it('incomplete acknowledgement and duplicate list IDs are rejected without renderer SQL fallback',async()=>{
    const quiet=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {
      mockInvoke.mockResolvedValueOnce({});
      expect((await addBankAction({name_ar:'test'})).success).toBe(false);
      mockInvoke.mockResolvedValueOnce({actorId:'admin',pharmacyId:'A',page:0,
        hasMore:false,rows:[{id:1,name_ar:'a',pharmacy_id:'A'},{id:1,name_ar:'dup',pharmacy_id:'A'}]});
      expect((await getCardsAction()).success).toBe(false);
    }finally{quiet.mockRestore();}
    expect(mockDb).not.toHaveBeenCalled();
  });
});
