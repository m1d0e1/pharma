/** @jest-environment node */

const mockInvoke = jest.fn();
const mockWrite = jest.fn((..._args: unknown[]) => { throw new Error('renderer SQL forbidden'); });
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(), dbGet: jest.fn(), dbExecute: (...args: unknown[]) => mockWrite(...args),
  dbTransaction: (...args: unknown[]) => mockWrite(...args), generateId: () => 'a1111111-1111-4111-8111-111111111111',
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({
    id: 'owner', pharmacy_id: 'tenant-a',
    permissions: { can_view_patients: true, acc_can_process_cash_flow: true },
  })),
  hasUserPermissionSync: jest.fn((user: any, key: string) => Boolean(user?.permissions?.[key])),
}));
jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: jest.fn() }));
jest.unmock('@/app/actions-client/patients');

import { updatePatientWalletAction } from '@/app/actions-client/patients';

const testCashStorage = new Map<string, string>();
beforeEach(() => {
  mockInvoke.mockReset();
  mockWrite.mockClear();
  testCashStorage.clear();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => testCashStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { testCashStorage.set(key, value); },
    removeItem: (key: string) => { testCashStorage.delete(key); },
  } });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    subtle: { digest: async () => new Uint8Array(32).fill(18).buffer },
  } });
});

test('a committed wallet top-up with a lost IPC reply is acknowledged using its original nonce and a native read', async () => {
  const requestId = 'a2222222-2222-4222-8222-222222222222';
  const payload = { patientId: 'qa-patient', amount: 25, notes: 'cash', requestId };
  let posted = 0;
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'top_up_patient_wallet_native') {
      posted += 1;
      if (posted > 1) throw new Error('Patient wallet top-up request already processed');
      // The native DB committed its cash, liability and wallet receipt, but
      // its IPC response was lost before the renderer received it.
      throw new Error('IPC reply lost after native commit');
    }
    if (command === 'confirm_patient_wallet_top_up_native') {
      // This witness must be read-only and verified by the live native actor,
      // tenant, patient, amount and original request ID.
      return { id: requestId, patientId: 'qa-patient', actorId: 'owner',
        pharmacyId: 'tenant-a', amountCents: 2500, balance: 25 };
    }
    throw new Error(`Unexpected native command: ${command}`);
  });

  await expect(updatePatientWalletAction('qa-patient', 25, 'cash', requestId))
    .resolves.toEqual({ success: true, balance: 25 });
  expect(posted).toBe(1);
  expect(mockInvoke).toHaveBeenNthCalledWith(2, 'confirm_patient_wallet_top_up_native', { payload });
  expect(mockWrite).not.toHaveBeenCalled();
});

test.each([
  ['missing', null],
  ['wrong nonce', { id: 'different' }],
  ['wrong patient', { patientId: 'foreign-patient' }],
  ['wrong amount', { amountCents: 2499 }],
  ['missing actor', { actorId: '' }],
  ['missing tenant', { pharmacyId: '' }],
  ['invalid balance', { balance: Number.NaN }],
])('fails closed on %s native wallet confirmation', async (_label, override) => {
  const requestId = 'a3333333-3333-4333-8333-333333333333';
  const receipt = { id: requestId, patientId: 'qa-patient', actorId: 'owner',
    pharmacyId: 'tenant-a', amountCents: 2500, balance: 25 };
  mockInvoke.mockRejectedValueOnce(new Error('native transport uncertain'))
    .mockResolvedValueOnce(override === null ? null : { ...receipt, ...override });
  expect(await updatePatientWalletAction('qa-patient', 25, 'cash', requestId)).toEqual({
    success: false, error: 'native transport uncertain',
  });
  expect(mockInvoke).toHaveBeenCalledTimes(2);
  expect(mockWrite).not.toHaveBeenCalled();
  expect(testCashStorage.has('pharma.patient.wallet.pending.v1')).toBe(true);
});

test('authorization denied by native confirmation preserves the original error and does not retry the financial write', async () => {
  mockInvoke.mockRejectedValueOnce(new Error('IPC reply unknown'))
    .mockRejectedValueOnce(new Error('Unauthorized native patient wallet top-up'));
  expect(await updatePatientWalletAction('qa-patient', 25, undefined, 'a4444444-4444-4444-8444-444444444444')).toEqual({
    success: false, error: 'IPC reply unknown',
  });
  expect(mockInvoke).toHaveBeenCalledTimes(2);
  expect(mockWrite).not.toHaveBeenCalled();
});

test('a malformed write acknowledgement needs a separately verified native witness', async () => {
  mockInvoke.mockResolvedValueOnce({ id: 'unrelated-nonce', balance: 25 })
    .mockResolvedValueOnce(null);
  expect(await updatePatientWalletAction('qa-patient', 25, undefined, 'a5555555-5555-4555-8555-555555555555'))
    .toMatchObject({ success: false });
  expect(mockInvoke).toHaveBeenCalledTimes(2);
  expect(mockWrite).not.toHaveBeenCalled();
});
