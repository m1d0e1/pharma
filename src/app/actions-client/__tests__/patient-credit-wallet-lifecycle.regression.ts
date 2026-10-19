/** @jest-environment node */
/**
 * Desktop patient finance integration boundary, not a renderer-side money
 * simulation. Actual 043/051/055/060 writers are exercised separately by
 * in-memory Rust tests; these mocks assert native-only intents and ACK policy.
 */
const mockInvoke = jest.fn();
const mockWrite = jest.fn((..._args: unknown[]) => {
  throw new Error('renderer SQL must not post tenant patient money');
});
const mockRead = jest.fn((..._args: unknown[]) => {
  throw new Error('renderer SQL must not infer historical patient ownership');
});
const mockGenerateId = jest.fn(() => 'b0333333-3333-4333-8333-333333333333');
let mockUser: any;
const testMoneyStorage = new Map<string, string>();

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockRead(...args),
  dbGet: (...args: unknown[]) => mockRead(...args),
  dbExecute: (...args: unknown[]) => mockWrite(...args),
  dbTransaction: (...args: unknown[]) => mockWrite(...args),
  generateId: () => mockGenerateId(),
  normalizeDatabaseTimestamps: (data: unknown) => data,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: () => Promise.resolve(mockUser),
  hasUserPermissionSync: (user: any, key: string) => Boolean(user?.permissions?.[key]),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), getAllDrugs: jest.fn(() => []), enrich: jest.fn() },
}));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));
jest.mock('@/app/actions-client/shifts', () => ({
  getShiftForPharmacy: jest.fn(() => { throw new Error('renderer shift read forbidden'); }),
  ensurePermanentShiftForUser: jest.fn(() => { throw new Error('renderer shift write forbidden'); }),
}));
jest.unmock('@/app/actions-client/patients');
jest.unmock('@/app/actions-client/finance');
jest.unmock('@/app/actions-client/sales');

import {
  addPatientAction, getPatientForPosAction, updatePatientWalletAction,
} from '@/app/actions-client/patients';
import { addPatientPaymentAction } from '@/app/actions-client/finance';
import { processCheckoutAction } from '@/app/actions-client/sales';

const patientId = '061-owner-patient-00000001';
const patient = {
  full_name: 'Prospective native patient',
  credit_limit: 200,
  opening_balance: 0,
  points_balance: 0,
  point_value: 1,
  customer_type: 'individual',
  payment_method: 'cash',
};
const item = {
  drug_id: 90001, inventory_id: 'tenant-a-verified-lot',
  quantity_sold: 1, unit_price: 150, item_discount_percent: 0,
  selected_unit: 'large', is_negative: false,
};
const credit = {
  status: 'completed', payment_method: 'credit',
  patient_id: patientId, request_id: '043-original-credit-request',
  total_discount: 0, additional_fees: 0, points_to_redeem: 0, items: [item],
};
const payment = {
  patient_id: patientId, amount: 40, payment_method: 'cash' as const,
  date: '2026-10-17', notes: 'verified 043 receivable',
  request_id: 'b0111111-1111-4111-8111-111111111111',
};
const suppressLoggedError = async <T>(operation: () => Promise<T>): Promise<T> => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try { return await operation(); } finally { spy.mockRestore(); }
};

beforeEach(() => {
  jest.clearAllMocks();
  // mockResolvedValueOnce/mockRejectedValueOnce must not leak queued replies
  // between tests; clearing call history alone preserves those intentions.
  mockInvoke.mockReset();
  testMoneyStorage.clear();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => testMoneyStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { testMoneyStorage.set(key, value); },
    removeItem: (key: string) => { testMoneyStorage.delete(key); },
  } });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    subtle: { digest: async () => new Uint8Array(32).fill(20).buffer },
  } });
  mockUser = {
    id: 'renderer-claimed-actor', pharmacy_id: 'tenant-a', role: 'cashier',
    permissions: { can_view_patients: true, can_access_pos: true,
      can_sell_credit: true, acc_can_process_cash_flow: true },
  };
});

test('prospective 061 creation, owned POS lookup, and credit checkout require distinct native operations', async () => {
  mockInvoke
    .mockResolvedValueOnce({ id: patientId })
    .mockResolvedValueOnce([{ id: patientId, full_name: patient.full_name,
      credit_limit: 200, opening_balance: 0, outstanding_balance: 0,
      wallet_balance: 0 }])
    .mockResolvedValueOnce({ sale_id: 'genuine-checkout-source', total_amount: 150,
      points_earned: 0, points_redeemed: 0 });
  expect(await addPatientAction(patient, patientId)).toEqual({ success: true, id: patientId });
  expect((await getPatientForPosAction(patientId)).data).toMatchObject({
    id: patientId, credit_limit: 200, opening_balance: 0,
  });
  expect(await processCheckoutAction(credit)).toMatchObject({
    success: true, data: { sale_id: 'genuine-checkout-source', total_amount: 150 },
  });
  expect(mockInvoke.mock.calls.map(([name]) => name)).toEqual([
    'create_patient_owned_native', 'db_read_scoped', 'process_checkout_critical',
  ]);
  expect(mockInvoke.mock.calls[0][1].payload).toMatchObject({
    requestId: patientId, creditLimit: 200, openingBalance: 0,
  });
  expect(mockInvoke.mock.calls[2][1]).toMatchObject({
    requestId: credit.request_id,
    payload: { patient_id: patientId, payment_method: 'credit', status: 'completed', items: [item] },
  });
  for (const args of [mockInvoke.mock.calls[0][1].payload, mockInvoke.mock.calls[2][1].payload]) {
    expect(args).not.toHaveProperty('user_id');
    expect(args).not.toHaveProperty('pharmacy_id');
  }
  expect(mockRead).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
});

test('credit permission and native ownership/credit limit denials do not mint sources', async () => {
  mockUser.permissions.can_sell_credit = false;
  expect((await processCheckoutAction(credit)).success).toBe(false);
  expect(mockInvoke).not.toHaveBeenCalled();
  mockUser.permissions.can_sell_credit = true;
  for (const denial of [
    'Patient tenant ownership cannot be verified',
    'Patient credit limit exceeded',
    'Incomplete native 043 sale provenance',
  ]) {
    mockInvoke.mockRejectedValueOnce(new Error(denial));
    expect(await suppressLoggedError(() => processCheckoutAction(credit)))
      .toMatchObject({ success: false, error: denial });
  }
  mockInvoke.mockResolvedValueOnce({ id: 'wrong-061-request' });
  expect((await addPatientAction(patient, patientId)).success).toBe(false);
  expect(mockWrite).not.toHaveBeenCalled();
});

test('051/055 settlement keeps its payment nonce; lost ACK is not assumed success or retried as new cash', async () => {
  mockInvoke.mockResolvedValueOnce({ id: 'native-payment', remainingBalance: 110 });
  expect(await addPatientPaymentAction(payment)).toEqual({
    success: true, id: 'native-payment', remainingBalance: 110,
  });
  expect(mockInvoke.mock.calls[0]).toEqual([
    'post_patient_payment_native', { payload: {
      patientId, shiftId: null, amount: 40, paymentMethod: 'cash',
      notes: 'verified 043 receivable', date: '2026-10-17',
      requestId: payment.request_id,
    } },
  ]);
  mockInvoke.mockRejectedValueOnce(new Error('IPC ACK lost after native commit'));
  expect(await suppressLoggedError(() => addPatientPaymentAction({
    ...payment, request_id: 'b0222222-2222-4222-8222-222222222222',
  }))).toMatchObject({ success: false, error: 'IPC ACK lost after native commit' });
  expect(mockInvoke.mock.calls.map(([name]) => name)).toEqual([
    'post_patient_payment_native', 'post_patient_payment_native',
    'confirm_patient_payment_native',
  ]);
  // A recovered original 051/055 intent MUST be confirmed with native
  // receipt proof first, not replayed even if the GUI supplied a new nonce.
  expect(await suppressLoggedError(() => addPatientPaymentAction({
    ...payment, request_id: 'b0222222-2222-4222-8222-222222222222',
  }))).toMatchObject({
    success: false, error: expect.stringContaining('not independently verified'),
  });
  expect(mockInvoke.mock.calls.map(([name]) => name)).toEqual([
    'post_patient_payment_native', 'post_patient_payment_native',
    'confirm_patient_payment_native', 'confirm_patient_payment_native',
  ]);
  expect(mockInvoke.mock.calls[3][1].payload.requestId).toBe('b0222222-2222-4222-8222-222222222222');
  expect(testMoneyStorage.has('pharma.patient.credit.payment.pending.v1')).toBe(true);
  expect(mockGenerateId).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
});

test('060 lost-ACK confirmation authenticates the original nonce and never repeats cash posting', async () => {
  const originalNonce = 'b0444444-4444-4444-8444-444444444444';
  const payload = { patientId, amount: 25.5, notes: 'native cash', requestId: originalNonce };
  mockInvoke.mockRejectedValueOnce(new Error('IPC ACK lost after 060 COMMIT'))
    .mockResolvedValueOnce({
      id: originalNonce, patientId, actorId: 'renderer-claimed-actor',
      pharmacyId: 'tenant-a', amountCents: 2550, balance: 25.5,
    });
  expect(await updatePatientWalletAction(patientId, 25.5, 'native cash', originalNonce))
    .toEqual({ success: true, balance: 25.5 });
  expect(mockInvoke.mock.calls).toEqual([
    ['top_up_patient_wallet_native', { payload }],
    ['confirm_patient_wallet_top_up_native', { payload }],
  ]);
  expect(mockGenerateId).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
});

test.each([
  ['foreign tenant', { pharmacyId: '' }],
  ['wrong nonce', { id: 'new-ambiguous-nonce' }],
  ['wrong patient', { patientId: 'foreign-patient' }],
  ['wrong cents', { amountCents: 2551 }],
  ['missing actor', { actorId: '' }],
])('060 rejects %s confirmation without retry, guessing ownership or minting new nonce', async (_label, change) => {
  const originalNonce = 'b0555555-5555-4555-8555-555555555555';
  mockInvoke.mockRejectedValueOnce(new Error('IPC reply uncertain'))
    .mockResolvedValueOnce({
      id: originalNonce, patientId, actorId: 'renderer-claimed-actor',
      pharmacyId: 'tenant-a', amountCents: 2550, balance: 25.5, ...change,
    });
  expect(await suppressLoggedError(
    () => updatePatientWalletAction(patientId, 25.5, 'cash', originalNonce),
  )).toMatchObject({ success: false, error: 'IPC reply uncertain' });
  expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
    'top_up_patient_wallet_native', 'confirm_patient_wallet_top_up_native',
  ]);
  expect(mockInvoke.mock.calls[0][1].payload.requestId).toBe(originalNonce);
  expect(mockInvoke.mock.calls[1][1].payload.requestId).toBe(originalNonce);
  expect(mockGenerateId).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
});

test('permission, tenant and unverified wallet history fail closed with native source reason', async () => {
  for (const denial of [
    'Unauthorized native patient wallet top-up',
    'Patient wallet ownership could not be certified',
    'Patient wallet balance lacks verified tenant-native source history',
    'Patient wallet top-up request already processed',
  ]) {
    // Independent modeled attempts start in separate disposable profiles.
    // The production action never silently clears a prior unresolved nonce.
    testMoneyStorage.clear();
    mockInvoke.mockRejectedValueOnce(new Error(denial)).mockResolvedValueOnce(null);
    expect(await suppressLoggedError(
      () => updatePatientWalletAction(patientId, 5, undefined, 'b0666666-6666-4666-8666-666666666666'),
    )).toEqual({ success: false, error: denial });
  }
  expect(mockInvoke.mock.calls.filter(([command]) => command === 'top_up_patient_wallet_native'))
    .toHaveLength(4);
  expect(mockWrite).not.toHaveBeenCalled();
});
