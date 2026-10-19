/** @jest-environment node */
const mockInvoke=jest.fn();
const mockSql=jest.fn((..._args:unknown[]) => { throw new Error('generic renderer SQL disabled'); });
const mockTx=jest.fn((..._args:unknown[]) => { throw new Error('renderer SQL transaction disabled'); });
const mockGenerateId=jest.fn(() => 'a6666666-6666-4666-8666-666666666666');
jest.mock('@/lib/env', () => ({isTauri:true}));
jest.mock('@tauri-apps/api/core', () => ({invoke:(...args:unknown[])=>mockInvoke(...args)}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect:(...args:unknown[])=>mockSql(...args),dbGet:(...args:unknown[])=>mockSql(...args),
  dbExecute:(...args:unknown[])=>mockSql(...args),dbTransaction:(...args:unknown[])=>mockTx(...args),
  generateId:()=>mockGenerateId(),normalizeDatabaseTimestamps:(v:unknown)=>v,
}));
jest.mock('@/lib/auth/local', () => ({
  // Authenticated native session stub, not a renderer SQL identity guess.
  getLocalSession:jest.fn(async()=>({id:'native-cashier-a',pharmacy_id:'tenant-a',
    permissions:{can_view_patients:true,acc_can_process_cash_flow:true}})),
  hasUserPermissionSync:jest.fn((user:any,key:string)=>Boolean(user?.permissions?.[key])),
}));
jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser:jest.fn(),getShiftForPharmacy:jest.fn(),
}));
import {addPatientPaymentAction} from '@/app/actions-client/finance';

const payment={patient_id:'shared-global-patient',shift_id:'foreign-or-stale-shift',
  amount:12.5,payment_method:'cash' as const,notes:'source verified by Rust',date:'2026-10-11'};

const testPaymentStorage=new Map<string,string>();
describe('native patient payment tenant ownership boundary',()=>{
  beforeEach(()=>{
    jest.clearAllMocks();
    mockInvoke.mockReset();
    testPaymentStorage.clear();
    Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
      getItem:(key:string)=>testPaymentStorage.get(key)??null,
      setItem:(key:string,value:string)=>{testPaymentStorage.set(key,value);},
      removeItem:(key:string)=>{testPaymentStorage.delete(key);},
    }});
    Object.defineProperty(globalThis,'crypto',{configurable:true,value:{
      subtle:{digest:async()=>new Uint8Array(32).fill(19).buffer},
    }});
  });
  it('passes only patient/shift filters, not a claimed user, role, pharmacy, SQL or account ID',async()=>{
    mockInvoke.mockResolvedValueOnce({id:'native-payment-id',remainingBalance:40});
    expect(await addPatientPaymentAction(payment)).toEqual({
      success:true,id:'native-payment-id',remainingBalance:40,
    });
    expect(mockInvoke).toHaveBeenCalledWith('post_patient_payment_native',{
      payload:{patientId:'shared-global-patient',shiftId:'foreign-or-stale-shift',
        amount:12.5,paymentMethod:'cash',notes:'source verified by Rust',
        date:'2026-10-11',requestId:'a6666666-6666-4666-8666-666666666666'},
    });
    const serialized=JSON.stringify(mockInvoke.mock.calls);
    for(const forbidden of ['pharmacy_id','pharmacyId','user_id','userId','role','accountId','sql']) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('forwards an explicit validated payment retry ID unchanged',async()=>{
    const request_id='6696bcae-5fd7-451d-91e8-6a658f673d1c';
    mockInvoke.mockResolvedValueOnce({id:'native-payment-id',remainingBalance:40});
    expect((await addPatientPaymentAction({...payment,request_id})).success).toBe(true);
    expect(mockInvoke.mock.calls[0][1].payload.requestId).toBe(request_id);
    expect(mockGenerateId).not.toHaveBeenCalled();
  });

  it('preserves native ambiguity, disabled-actor, cross-branch, replay and rollback denial without fallback',async()=>{
    for(const error of [
      'Patient balance provenance is ambiguous; no automatic pharmacy assignment is permitted',
      'Unauthorized native patient payment','Patient payment request already processed',
      'synthetic journal failure',
    ]) {
      // Each iteration models a new isolated profile/transaction. In real
      // operation an unresolved receipt keeps its nonce and BLOCKS reposts.
      testPaymentStorage.clear();
      mockInvoke.mockRejectedValueOnce(new Error(error));
      const spy=jest.spyOn(console,'error').mockImplementation(()=>{});
      try {expect(await addPatientPaymentAction(payment)).toMatchObject({success:false,error});}
      finally {spy.mockRestore();}
      expect(testPaymentStorage.has('pharma.patient.credit.payment.pending.v1')).toBe(true);
    }
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });
  it('preserves a plain-string Tauri patient-payment rejection instead of hiding its native reason',async()=>{
    const denial='Payment exceeds provable outstanding patient debt';
    mockInvoke.mockRejectedValueOnce(denial);
    const spy=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {
      expect(await addPatientPaymentAction(payment)).toEqual({success:false,error:denial});
    } finally {spy.mockRestore();}
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('rejects invalid amounts and incomplete native receipt instead of assuming settlement committed',async()=>{
    for(const amount of [0,-1,Infinity,NaN]) {
      const spy=jest.spyOn(console,'error').mockImplementation(()=>{});
      try {expect((await addPatientPaymentAction({...payment,amount})).success).toBe(false);}
      finally {spy.mockRestore();}
    }
    expect(mockInvoke).not.toHaveBeenCalled();
    mockInvoke.mockResolvedValueOnce({id:'partial-native-receipt'});
    const spy=jest.spyOn(console,'error').mockImplementation(()=>{});
    try {expect((await addPatientPaymentAction(payment)).success).toBe(false);} finally {spy.mockRestore();}
    expect(mockSql).not.toHaveBeenCalled();
  });
});
