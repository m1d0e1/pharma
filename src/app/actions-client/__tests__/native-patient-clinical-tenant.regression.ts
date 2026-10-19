import { dbSelect } from '@/lib/db/tauri';
import { invoke } from '@tauri-apps/api/core';
import { checkDrugInteractions } from '@/app/actions-client/interactions';

jest.mock('@/lib/env', () => ({isTauri: true, isClient: true}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => {throw Error('Generic clinical SQL is forbidden');}),
  dbGet: jest.fn(),dbExecute: jest.fn(),dbTransaction: jest.fn(),
}));
jest.mock('@tauri-apps/api/core', () => ({invoke: jest.fn()}));

beforeEach(() => jest.clearAllMocks());

it('checks an owned patient allergy only through the authenticated native checkout projection', async()=>{
  (invoke as jest.Mock).mockResolvedValue([{allergen:'QA allergen',severity:'critical'}]);
  const outcome=await checkDrugInteractions(['QA allergen'], 'owned-patient');
  expect(outcome.success).toBe(true);
  expect(outcome.data?.allergies).toHaveLength(1);
  expect(outcome.data?.hasCritical).toBe(true);
  expect(invoke).toHaveBeenCalledWith('db_read_scoped',expect.objectContaining({
    queryId:'patients.checkout_allergies',recordId:'owned-patient',limit:200,offset:0,
  }));
  expect(dbSelect).not.toHaveBeenCalled();
});

it('rejects legacy or foreign patients without silently declaring no allergies', async()=>{
  (invoke as jest.Mock).mockRejectedValue(Error('Patient tenant ownership cannot be verified'));
  const outcome=await checkDrugInteractions(['QA allergen'],'legacy-patient');
  expect(outcome.success).toBe(false);
  expect(dbSelect).not.toHaveBeenCalled();
});

it('fails closed when clinical history may be truncated at the native page limit',async()=>{
  (invoke as jest.Mock).mockResolvedValue(Array.from({length:200},()=>({allergen:'allergy',severity:'critical'})));
  const outcome=await checkDrugInteractions(['QA allergen'],'owned-patient');
  expect(outcome.success).toBe(false);
  expect(dbSelect).not.toHaveBeenCalled();
});
