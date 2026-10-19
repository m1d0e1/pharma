/** @jest-environment node */
const mockInvoke = jest.fn();
const mockTransaction = jest.fn((..._args: unknown[]) => { throw new Error('renderer transaction forbidden'); });
const mockWrite = jest.fn((..._args: unknown[]) => { throw new Error('renderer SQL forbidden'); });
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(), dbGet: jest.fn(), dbExecute: (...args: unknown[]) => mockWrite(...args),
  dbTransaction: (...args: unknown[]) => mockTransaction(...args), generateId: () => 'a1111111-1111-4111-8111-111111111111',
}));
jest.mock('@/lib/auth/local', () => ({
  // Current-session identity is a mocked NATIVE authenticated snapshot.
  getLocalSession: jest.fn(async () => ({ id: 'owner', pharmacy_id: 'tenant-a',
    permissions: { can_view_patients: true, acc_can_process_cash_flow: true } })),
  hasUserPermissionSync: jest.fn((user: any, key: string) => Boolean(user?.permissions?.[key])),
}));
jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: jest.fn() }));
jest.unmock('@/app/actions-client/patients');
import { updatePatientWalletAction } from '@/app/actions-client/patients';

const testCashStorage = new Map<string, string>();
beforeEach(() => {
  testCashStorage.clear();
  mockInvoke.mockReset();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => testCashStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { testCashStorage.set(key, value); },
    removeItem: (key: string) => { testCashStorage.delete(key); },
  } });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    subtle: { digest: async () => new Uint8Array(32).fill(17).buffer },
  } });
});

test('wallet top-up uses one native authorized cash+liability transaction, never renderer SQL', async () => {
  mockInvoke.mockResolvedValueOnce({ id: 'a1111111-1111-4111-8111-111111111111', balance: 25 });
  await expect(updatePatientWalletAction('qa-patient', 25, 'fictional cash receipt')).resolves.toEqual({
    success: true, balance: 25,
  });
  expect(mockInvoke).toHaveBeenCalledWith('top_up_patient_wallet_native', {
    payload: { patientId: 'qa-patient', amount: 25, notes: 'fictional cash receipt', requestId: 'a1111111-1111-4111-8111-111111111111' },
  });
  expect(mockTransaction).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
  expect(mockInvoke).toHaveBeenCalledTimes(1);
});

test('wallet top-up preserves native scope rejection and has no renderer fallback', async () => {
  mockInvoke.mockRejectedValueOnce('Patient wallet ownership could not be certified');
  expect(await updatePatientWalletAction('other-branch-patient', 5)).toEqual({
    success: false, error: 'Patient wallet ownership could not be certified',
  });
  expect(mockTransaction).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
  expect(testCashStorage.has('pharma.patient.wallet.pending.v1')).toBe(true);
});
