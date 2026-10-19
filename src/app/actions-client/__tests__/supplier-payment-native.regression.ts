const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
const mockDbExecute = jest.fn();
const mockDbTransaction = jest.fn();

jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockDbSelect(...args),
  dbGet: jest.fn(),
  dbExecute: (...args: unknown[]) => mockDbExecute(...args),
  dbTransaction: (...args: unknown[]) => mockDbTransaction(...args),
  generateId: jest.fn(() => 'not-a-request-id'),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'renderer-id', role: 'cashier', pharmacy_id: 'forged-branch' })),
  hasUserPermissionSync: jest.fn(() => true),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { updateDrug: jest.fn() } }));

import { addSupplierPaymentAction } from '@/app/actions-client/purchases';

const payment = {
  supplier_id: 7, amount: 12.50, payment_method: 'cash' as const,
  date: '2026-10-14', request_id: '8b939d7f-26c1-4627-8ff3-4d5263a48a90',
};

beforeEach(() => {
  jest.clearAllMocks();
});

it('submits a stable typed supplier partial-payment intent without renderer SQL or actor/tenant claims', async () => {
  mockInvoke.mockResolvedValueOnce({ id: 'payment-1', remainingBalance: 87.5 });
  expect(await addSupplierPaymentAction(payment)).toEqual({ success: true, remainingBalance: 87.5 });
  expect(mockInvoke).toHaveBeenCalledWith('post_supplier_payment_native', {
    payload: { supplierId: 7, amount: 12.50, paymentMethod: 'cash', date: '2026-10-14',
      requestId: payment.request_id, notes: null },
  });
  expect(JSON.stringify(mockInvoke.mock.calls)).not.toMatch(/renderer-id|forged-branch/);
  expect(mockDbTransaction).not.toHaveBeenCalled();
  expect(mockDbSelect).not.toHaveBeenCalled();
  expect(mockDbExecute).not.toHaveBeenCalled();
});

it('fails closed when native posting rejects legacy ownership', async () => {
  mockInvoke.mockRejectedValueOnce(new Error('Supplier ownership is unverifiable'));
  expect(await addSupplierPaymentAction(payment)).toMatchObject({ success: false, error: 'Supplier ownership is unverifiable' });
  expect(mockDbTransaction).not.toHaveBeenCalled();
  expect(mockDbExecute).not.toHaveBeenCalled();
});

it('preserves a verified ownership refusal when native posting rejects with a string', async () => {
  const ownershipDenial = 'Supplier ownership is unverifiable; reconcile legacy or mixed history before payment';
  mockInvoke.mockRejectedValueOnce(ownershipDenial);

  expect(await addSupplierPaymentAction(payment)).toEqual({ success: false, error: ownershipDenial });
  expect(mockDbTransaction).not.toHaveBeenCalled();
  expect(mockDbExecute).not.toHaveBeenCalled();
});

it('returns a readable failure and no renderer SQL fallback when a native posting rejection is null', async () => {
  mockInvoke.mockRejectedValueOnce(null);

  expect(await addSupplierPaymentAction(payment)).toEqual({
    success: false, error: 'فشل تسجيل الدفعة للمورد',
  });
  expect(mockDbTransaction).not.toHaveBeenCalled();
  expect(mockDbExecute).not.toHaveBeenCalled();
});

it('does not post an unsupported cheque or an intent without a retained request ID', async () => {
  expect(await addSupplierPaymentAction({ ...payment, payment_method: 'check', check_number: 'CHK-1' }))
    .toMatchObject({ success: false });
  expect(await addSupplierPaymentAction({ ...payment, request_id: undefined }))
    .toMatchObject({ success: false });
  expect(mockInvoke).not.toHaveBeenCalled();
  expect(mockDbTransaction).not.toHaveBeenCalled();
});

it('rejects incomplete native acknowledgments without generic ledger fallback', async () => {
  mockInvoke.mockResolvedValueOnce({ id: 'receipt-without-balance' });
  expect(await addSupplierPaymentAction(payment)).toMatchObject({ success: false });
  expect(mockDbTransaction).not.toHaveBeenCalled();
});
