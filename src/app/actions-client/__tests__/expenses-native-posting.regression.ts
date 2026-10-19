/** @jest-environment node */
const mockInvoke=jest.fn();
const mockSql=jest.fn((..._args:unknown[])=>{throw new Error('generic renderer SQL forbidden');});
const mockTx=jest.fn((..._args:unknown[])=>{throw new Error('renderer transaction forbidden');});
const mockSession=jest.fn(()=>{throw new Error('renderer identity must not authorize native expense');});
jest.mock('@/lib/env',()=>({isTauri:true}));
jest.mock('@tauri-apps/api/core',()=>({invoke:(...args:unknown[])=>mockInvoke(...args)}));
jest.mock('@/lib/db/tauri',()=>({dbSelect:(...args:unknown[])=>mockSql(...args),
  dbGet:(...args:unknown[])=>mockSql(...args),dbExecute:(...args:unknown[])=>mockSql(...args),
  dbTransaction:(...args:unknown[])=>mockTx(...args),generateId:jest.fn(()=> 'expense-once'),
}));
jest.mock('@/lib/auth/local',()=>({getLocalSession:()=>mockSession(),hasUserPermissionSync:jest.fn()}));
jest.mock('@/app/actions-client/finance',()=>({createCashMovementAction:jest.fn(()=>{
  throw new Error('Detached cash posting forbidden');
})}));
import {addExpenseAction,getExpensesAction,deleteExpenseAction} from '@/app/actions-client/expenses';

const expense={category:'UTIL',amount:12.5,description:'electricity',date:'2026-10-11',
  source_type:'manual',shift_id:'foreign-shift'};

describe('desktop parent expense posts expenses+cash+journals atomically natively',()=>{
  beforeEach(()=>jest.clearAllMocks());
  it('passes one typed intent without actor, tenant, account IDs or generic SQL',async()=>{
    mockInvoke.mockResolvedValueOnce({id:'native-expense'});
    expect(await addExpenseAction(expense)).toEqual({success:true,id:'native-expense'});
    expect(mockInvoke).toHaveBeenCalledWith('create_expense_native',{
      payload:{sourceType:'manual',shiftId:'foreign-shift',requestId:'expense-once',
        category:'UTIL',amount:12.5,description:'electricity',date:'2026-10-11'},
    });
    const p=mockInvoke.mock.calls[0][1].payload;
    expect(p).not.toHaveProperty('source_type');
    expect(p).not.toHaveProperty('shift_id');
    for (const key of ['userId','user_id','pharmacyId','pharmacy_id','sql','accountId'])
      expect(p).not.toHaveProperty(key);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });
  it('preserves an explicitly supplied native expense nonce across an ambiguous transport retry', async () => {
    const sameIntent={...expense,request_id:'0b4edc83-9797-4c03-a16f-7f1584adb437'};
    mockInvoke.mockRejectedValueOnce(new Error('reply lost after native commit'))
      .mockResolvedValueOnce({id:'native-expense-posted'});
    expect((await addExpenseAction(sameIntent)).success).toBe(false);
    expect(await addExpenseAction(sameIntent)).toEqual({success:true,id:'native-expense-posted'});
    expect(mockInvoke.mock.calls.map(([command, request])=>[command, request.payload.requestId]))
      .toEqual([
        ['create_expense_native','0b4edc83-9797-4c03-a16f-7f1584adb437'],
        ['create_expense_native','0b4edc83-9797-4c03-a16f-7f1584adb437'],
      ]);
    expect(mockTx).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });
  it('fails closed on native denied/replayed/rollback errors, no detached cash call',async()=>{
    for(const message of ['Expense posting permission required','Expense request already posted',
      'synthetic parent failure']) {
      mockInvoke.mockRejectedValueOnce(new Error(message));
      const result=await addExpenseAction(expense);
      expect(result).toMatchObject({success:false});
    }
    expect(mockTx).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });
  it('rejects missing native acknowledgement and never falls back',async()=>{
    mockInvoke.mockResolvedValueOnce({});
    expect((await addExpenseAction(expense)).success).toBe(false);
    expect(mockTx).not.toHaveBeenCalled();
  });
  it('reads history only through fixed native projection and never exposes renderer tenant scope',async()=>{
    mockInvoke.mockResolvedValueOnce({rows:[{id:'local-expense',pharmacy_id:'a',amount:12.5}],
      hasMore:false,page:0,actorId:'current-actor',pharmacyId:'a'});
    expect(await getExpensesAction({from:'2026-10-01',to:'2026-10-31',category:'UTIL'}))
      .toMatchObject({success:true,data:[{id:'local-expense'}]});
    expect(mockInvoke).toHaveBeenCalledWith('list_expenses_native',{
      filters:{from:'2026-10-01',to:'2026-10-31',category:'UTIL',page:0},
    });
    expect(mockTx).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
    expect((await deleteExpenseAction('foreign-expense')).success).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
  it('does not fall back to a generic expense list SELECT when native authorization denies',async()=>{
    mockInvoke.mockRejectedValueOnce(new Error('Native expense history permission required'));
    expect((await getExpensesAction({category:'all'})).success).toBe(false);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
