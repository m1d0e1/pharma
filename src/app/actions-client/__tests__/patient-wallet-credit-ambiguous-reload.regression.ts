/** @jest-environment node */
import { createHash } from 'crypto';

const mockInvoke = jest.fn();
const mockGetLocalSession = jest.fn();
const mockWrite = jest.fn((..._args: unknown[]) => { throw new Error('No renderer financial SQL'); });
const mockGenerateId = jest.fn(() => 'd1111111-1111-4111-8111-111111111111');
const storage = new Map<string, string>();
let storageUnavailable = false;
const mockStorage = {
  getItem: jest.fn((key: string) => {
    if (storageUnavailable) throw new Error('storage blocked');
    return storage.get(key) ?? null;
  }),
  setItem: jest.fn((key: string, value: string) => {
    if (storageUnavailable) throw new Error('storage blocked');
    storage.set(key, value);
  }),
  removeItem: jest.fn((key: string) => {
    if (storageUnavailable) throw new Error('storage blocked');
    storage.delete(key);
  }),
};

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbGet: jest.fn(() => { throw new Error('Renderer SELECT cannot authorize wallet'); }),
  dbSelect: jest.fn(() => { throw new Error('Renderer SELECT cannot authorize wallet'); }),
  dbExecute: (...args: unknown[]) => mockWrite(args),
  dbTransaction: (...args: unknown[]) => mockWrite(args),
  generateId: () => mockGenerateId(),
  normalizeDatabaseTimestamps: (value: unknown) => value,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: () => mockGetLocalSession(),
  hasUserPermissionSync: (user: any, permission: string) => Boolean(user?.permissions?.[permission]),
}));
jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(), getShiftForPharmacy: jest.fn(),
}));
jest.unmock('@/app/actions-client/patients');
jest.unmock('@/app/actions-client/finance');

const WALLET_KEY = 'pharma.patient.wallet.pending.v1';
const CREDIT_KEY = 'pharma.patient.credit.payment.pending.v1';
const walletNonce = 'd2222222-2222-4222-8222-222222222222';
const changedNonce = 'd3333333-3333-4333-8333-333333333333';
const creditNonce = 'd4444444-4444-4444-8444-444444444444';
const patient = 'patient-secret-061';
const actor = {
  id: 'native-cashier-a',
  pharmacy_id: 'tenant-a',
  role: 'cashier',
  permissions: { can_view_patients: true, acc_can_process_cash_flow: true },
};
const pay = {
  patient_id: patient, amount: 45, payment_method: 'cash' as const,
  date: '2026-10-17', request_id: creditNonce,
};
const confirmedPayment = (nonce = creditNonce, overrides: Record<string, unknown> = {}) => ({
  id: 'independently-receipted-051-source',
  requestId: nonce, patientId: patient, actorId: actor.id,
  pharmacyId: actor.pharmacy_id, amountCents: 4500,
  paymentMethod: 'cash', date: '2026-10-17', ...overrides,
});

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function actions() {
  const { updatePatientWalletAction } =
    jest.requireActual('@/app/actions-client/patients') as typeof import('@/app/actions-client/patients');
  const { addPatientPaymentAction } =
    jest.requireActual('@/app/actions-client/finance') as typeof import('@/app/actions-client/finance');
  return { updatePatientWalletAction, addPatientPaymentAction };
}
function mockCryptoAndStorage() {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, value: mockStorage,
  });
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      subtle: {
        digest: async (_algorithm: string, input: ArrayBuffer) =>
          Uint8Array.from(createHash('sha256').update(new Uint8Array(input)).digest()).buffer,
      },
      randomUUID: jest.fn(() => 'd9999999-9999-4999-8999-999999999999'),
    },
  });
}
function silentError<T>(work: () => Promise<T>) {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  return work().finally(() => spy.mockRestore());
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockInvoke.mockReset();
  mockGetLocalSession.mockReset().mockImplementation(async () => actor);
  mockGenerateId.mockClear();
  storage.clear();
  storageUnavailable = false;
  mockCryptoAndStorage();
});
afterAll(() => {
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else Reflect.deleteProperty(globalThis, 'crypto');
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

test('060 original wallet UUID survives reload and performs native confirmation FIRST without replay', async () => {
  const { updatePatientWalletAction } = actions();
  mockInvoke
    .mockRejectedValueOnce(new Error('wallet IPC ACK lost after COMMIT'))
    .mockResolvedValueOnce(null);
  expect(await updatePatientWalletAction(patient, 25.50, 'cash', walletNonce))
    .toMatchObject({ success: false, error: 'wallet IPC ACK lost after COMMIT' });
  const hint = JSON.parse(storage.get(WALLET_KEY) ?? 'null');
  expect(hint).toMatchObject({ version: 1, requestId: walletNonce, amountCents: 2550 });
  const raw = JSON.stringify(hint);
  for (const secret of [patient, actor.id, actor.pharmacy_id]) {
    expect(raw).not.toContain(secret);
  }
  expect(hint.scopeSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(mockInvoke.mock.calls.map(([name]) => name)).toEqual([
    'top_up_patient_wallet_native', 'confirm_patient_wallet_top_up_native',
  ]);
  jest.resetModules(); // simulate a new renderer process with only persisted hint
  const next = actions();
  mockInvoke.mockReset().mockResolvedValueOnce({
    id: walletNonce, patientId: patient, actorId: actor.id,
    pharmacyId: actor.pharmacy_id, amountCents: 2550, balance: 25.5,
  });
  expect(await next.updatePatientWalletAction(patient, 25.50, 'cash', changedNonce))
    .toEqual({ success: true, balance: 25.5 });
  expect(mockInvoke).toHaveBeenCalledTimes(1);
  expect(mockInvoke.mock.calls[0]).toEqual([
    'confirm_patient_wallet_top_up_native',
    { payload: { patientId: patient, amount: 25.50, notes: 'cash', requestId: walletNonce } },
  ]);
  expect(storage.has(WALLET_KEY)).toBe(false);
  expect(mockGenerateId).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
});

test('060 recovered unknown native receipt never issues new cash, even with a new GUI UUID', async () => {
  const { updatePatientWalletAction } = actions();
  mockInvoke.mockRejectedValueOnce(new Error('wallet response lost')).mockRejectedValueOnce(new Error('offline'));
  expect((await updatePatientWalletAction(patient, 5, undefined, walletNonce)).success).toBe(false);
  jest.resetModules();
  mockInvoke.mockReset().mockResolvedValueOnce(null);
  const restored = actions();
  expect(await restored.updatePatientWalletAction(patient, 5, undefined, changedNonce))
    .toMatchObject({ success: false, error: expect.stringContaining('remains unverified') });
  expect(mockInvoke.mock.calls.map(([name]) => name))
    .toEqual(['confirm_patient_wallet_top_up_native']);
  expect(JSON.parse(storage.get(WALLET_KEY) ?? '{}').requestId).toBe(walletNonce);
  expect(mockGenerateId).not.toHaveBeenCalled();
});

test.each([
  ['account switch', { ...actor, id: 'another-actor' }, 15],
  ['tenant switch', { ...actor, pharmacy_id: 'tenant-b' }, 15],
  ['permission revoked', { ...actor, permissions: { can_view_patients: true } }, 15],
  ['amount changed', actor, 16],
])('060 persisted pending blocks %s without native cash or confirmation for new identity', async (_label, identity, amount) => {
  const { updatePatientWalletAction } = actions();
  mockInvoke.mockRejectedValueOnce(new Error('IPC uncertain')).mockResolvedValueOnce(null);
  await updatePatientWalletAction(patient, 15, undefined, walletNonce);
  jest.resetModules();
  mockGetLocalSession.mockImplementation(async () => identity);
  mockInvoke.mockReset();
  const response = await actions().updatePatientWalletAction(patient, amount, undefined, changedNonce);
  expect(response.success).toBe(false);
  expect(mockInvoke).not.toHaveBeenCalled();
  expect(storage.has(WALLET_KEY)).toBe(true);
});

test('060 typed native confirmation checks actor AND tenant, not just a matching nonce', async () => {
  const { updatePatientWalletAction } = actions();
  mockInvoke.mockRejectedValueOnce(new Error('ambiguous')).mockResolvedValueOnce(null);
  await updatePatientWalletAction(patient, 12, undefined, walletNonce);
  jest.resetModules();
  mockInvoke.mockReset().mockResolvedValueOnce({
    id: walletNonce, patientId: patient, actorId: 'other-native-actor',
    pharmacyId: 'tenant-a', amountCents: 1200, balance: 12,
  });
  expect((await actions().updatePatientWalletAction(patient, 12, undefined, changedNonce)).success)
    .toBe(false);
  expect(storage.has(WALLET_KEY)).toBe(true);
  expect(mockInvoke.mock.calls.map(([name]) => name)).toEqual(['confirm_patient_wallet_top_up_native']);
});

test('051/055 lost ACK survives reload and confirms original nonce FIRST without repost or inventing balance', async () => {
  const { addPatientPaymentAction } = actions();
  mockInvoke.mockRejectedValueOnce(new Error('credit payment IPC ACK lost'))
    .mockResolvedValueOnce(null);
  expect(await silentError(() => addPatientPaymentAction(pay)))
    .toMatchObject({ success: false, error: 'credit payment IPC ACK lost' });
  const hint = JSON.parse(storage.get(CREDIT_KEY) ?? 'null');
  expect(hint).toMatchObject({ requestId: creditNonce, amountCents: 4500, version: 1 });
  for (const secret of [patient, actor.id, actor.pharmacy_id]) {
    expect(JSON.stringify(hint)).not.toContain(secret);
  }
  expect(mockInvoke.mock.calls.map(([name]) => name))
    .toEqual(['post_patient_payment_native', 'confirm_patient_payment_native']);
  jest.resetModules();
  mockInvoke.mockReset().mockResolvedValueOnce(confirmedPayment());
  const restored = actions();
  expect(await silentError(() => restored.addPatientPaymentAction({
    ...pay, request_id: changedNonce,
  }))).toEqual({
    success: true, id: 'independently-receipted-051-source', remainingBalance: null,
  });
  expect(mockInvoke.mock.calls.map(([name]) => name))
    .toEqual(['confirm_patient_payment_native']);
  expect(mockInvoke.mock.calls[0][1].payload.requestId).toBe(creditNonce);
  expect(mockGenerateId).not.toHaveBeenCalled();
  expect(storage.has(CREDIT_KEY)).toBe(false);
});

test.each([
  ['absent', null],
  ['nonce', confirmedPayment(changedNonce)],
  ['patient', confirmedPayment(creditNonce, { patientId: 'foreign-patient' })],
  ['actor', confirmedPayment(creditNonce, { actorId: 'foreign-user' })],
  ['tenant', confirmedPayment(creditNonce, { pharmacyId: 'tenant-b' })],
  ['cents', confirmedPayment(creditNonce, { amountCents: 4501 })],
  ['method', confirmedPayment(creditNonce, { paymentMethod: 'bank' })],
  ['date', confirmedPayment(creditNonce, { date: '2026-10-16' })],
  ['id', confirmedPayment(creditNonce, { id: '' })],
])('051/055 keeps original UUID on %s invalid native source confirmation', async (_label, witness) => {
  const { addPatientPaymentAction } = actions();
  mockInvoke.mockRejectedValueOnce(new Error('ambiguous cash'))
    .mockResolvedValueOnce(null);
  expect((await silentError(() => addPatientPaymentAction(pay))).success).toBe(false);
  jest.resetModules();
  mockInvoke.mockReset().mockResolvedValueOnce(witness);
  expect(await silentError(() => actions().addPatientPaymentAction({
    ...pay, request_id: changedNonce,
  }))).toMatchObject({
    success: false, error: expect.stringContaining('not independently verified'),
  });
  expect(mockInvoke.mock.calls.map(([name]) => name))
    .toEqual(['confirm_patient_payment_native']);
  expect(mockInvoke.mock.calls[0][1].payload.requestId).toBe(creditNonce);
  expect(JSON.parse(storage.get(CREDIT_KEY) ?? '{}').requestId).toBe(creditNonce);
  expect(mockWrite).not.toHaveBeenCalled();
});

test('051/055 same-call lost IPC ACK can be resolved only by exact typed native source', async () => {
  const { addPatientPaymentAction } = actions();
  mockInvoke.mockRejectedValueOnce(new Error('reply lost after native payment COMMIT'))
    .mockResolvedValueOnce(confirmedPayment());
  expect(await addPatientPaymentAction(pay)).toEqual({
    success: true, id: 'independently-receipted-051-source', remainingBalance: null,
  });
  expect(mockInvoke.mock.calls.map(([name]) => name))
    .toEqual(['post_patient_payment_native', 'confirm_patient_payment_native']);
  expect(mockInvoke.mock.calls[1][1].payload.requestId).toBe(creditNonce);
  expect(storage.has(CREDIT_KEY)).toBe(false);
});

test.each([
  ['account switch', { ...actor, id: 'other-cashier' }, 45],
  ['tenant switch', { ...actor, pharmacy_id: 'tenant-b' }, 45],
  ['permission revoked', { ...actor, permissions: { can_view_patients: true } }, 45],
  ['changed amount', actor, 46],
])('051/055 blocks %s while the original nonce is unresolved', async (_label, identity, amount) => {
  const { addPatientPaymentAction } = actions();
  mockInvoke.mockRejectedValueOnce(new Error('reply ambiguous')).mockResolvedValueOnce(null);
  await silentError(() => addPatientPaymentAction(pay));
  jest.resetModules();
  mockInvoke.mockReset();
  mockGetLocalSession.mockImplementation(async () => identity);
  expect((await silentError(() => actions().addPatientPaymentAction({
    ...pay, amount, request_id: changedNonce,
  }))).success).toBe(false);
  expect(mockInvoke).not.toHaveBeenCalled();
  expect(storage.has(CREDIT_KEY)).toBe(true);
});

test.each(['wallet', 'credit'] as const)(
  '%s fails before posting when recovery storage is unavailable or contains a malformed pending intent',
  async kind => {
    const { addPatientPaymentAction, updatePatientWalletAction } = actions();
    const command = () => kind === 'wallet'
      ? updatePatientWalletAction(patient, 7, undefined, walletNonce)
      : addPatientPaymentAction(pay);
    storageUnavailable = true;
    expect((await silentError(async () => command())).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    storageUnavailable = false;
    storage.set(kind === 'wallet' ? WALLET_KEY : CREDIT_KEY, '{garbled');
    expect((await silentError(async () => command())).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  },
);

test('successful independently acknowledged wallet and credit operations clear original intent hints', async () => {
  const { addPatientPaymentAction, updatePatientWalletAction } = actions();
  mockInvoke.mockResolvedValueOnce({ id: walletNonce, balance: 10 });
  expect(await updatePatientWalletAction(patient, 10, undefined, walletNonce))
    .toEqual({ success: true, balance: 10 });
  expect(storage.has(WALLET_KEY)).toBe(false);
  mockInvoke.mockResolvedValueOnce({ id: 'native-payment-receipt', remainingBalance: 50 });
  expect(await addPatientPaymentAction(pay)).toEqual({
    success: true, id: 'native-payment-receipt', remainingBalance: 50,
  });
  expect(storage.has(CREDIT_KEY)).toBe(false);
  expect(mockWrite).not.toHaveBeenCalled();
});

test('zero balances are legitimate typed native replies, unlike missing/undefined balances', async () => {
  const { addPatientPaymentAction, updatePatientWalletAction } = actions();
  mockInvoke.mockResolvedValueOnce({ id: 'paid-in-full', remainingBalance: 0 });
  expect(await addPatientPaymentAction(pay)).toEqual({
    success: true, id: 'paid-in-full', remainingBalance: 0,
  });
  expect(storage.has(CREDIT_KEY)).toBe(false);
  mockInvoke.mockResolvedValueOnce({ id: 'missing-balance' });
  expect((await silentError(() => addPatientPaymentAction({ ...pay, request_id: changedNonce }))).success)
    .toBe(false);
  expect(JSON.parse(storage.get(CREDIT_KEY) ?? '{}').requestId).toBe(changedNonce);

  mockInvoke.mockRejectedValueOnce(new Error('060 posted but ACK missing')).mockResolvedValueOnce(null);
  await updatePatientWalletAction(patient, 5, undefined, walletNonce);
  jest.resetModules();
  mockInvoke.mockReset().mockResolvedValueOnce({
    id: walletNonce, patientId: patient, actorId: actor.id,
    pharmacyId: actor.pharmacy_id, amountCents: 500, balance: 0,
  });
  expect(await actions().updatePatientWalletAction(patient, 5, undefined, changedNonce))
    .toEqual({ success: true, balance: 0 });
  expect(storage.has(WALLET_KEY)).toBe(false);
});
