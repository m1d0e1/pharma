/** @jest-environment node */

import { createHash, webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';

const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
const mockDbExecute = jest.fn();
const mockDbTransaction = jest.fn();
const mockInventoryChanged = jest.fn();
const mockReturnStorage = new Map<string, string>();
const originalLineSha256 = createHash('sha256')
  .update(JSON.stringify([[31, 'synthetic-lot-101', 1000000, 'large']])).digest('hex');
let mockPermissions = {
  can_access_pos: true, can_sell_no_stock: false, can_view_returns: true,
};
let mockActiveActor = 'synthetic-local-session';
let mockActiveTenant = 'synthetic-visible-tenant';

// This is a transport contract test only. Mock invoke DOES NOT simulate native
// permission checks, SQLite transactions, or Rust idempotency implementation.
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockDbSelect(...args),
  dbGet: jest.fn(),
  dbExecute: (...args: unknown[]) => mockDbExecute(...args),
  dbTransaction: (...args: unknown[]) => mockDbTransaction(...args),
  generateId: jest.fn(() => 'unused-fixture'),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({
    id: mockActiveActor,
    pharmacy_id: mockActiveTenant,
    role: 'pharmacist',
    permissions: mockPermissions,
  })),
  hasUserPermissionSync: jest.fn((user: any, key: keyof typeof mockPermissions) => Boolean(user?.permissions?.[key])),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), enrich: jest.fn(), getAllDrugs: jest.fn(() => []) },
}));
jest.mock('@/lib/inventory/refresh', () => ({
  notifyInventoryChanged: () => mockInventoryChanged(),
}));
jest.mock('@/app/actions-client/finance', () => ({
  requireOpenShiftId: jest.fn(() => { throw new Error('no renderer shift writes'); }),
}));
jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(() => { throw new Error('no renderer shift writes'); }),
  getShiftForPharmacy: jest.fn(() => { throw new Error('no renderer shift reads'); }),
}));

import { processCheckoutAction } from '@/app/actions-client/sales';
import { createReturnAction, nativeSalesReturnRecoveryPending, confirmPendingSalesReturnAction } from '@/app/actions-client/returns';

const checkout = {
  request_id: 'synthetic-checkout-nonce-100',
  status: 'completed',
  payment_method: 'cash',
  items: [{
    drug_id: 101,
    inventory_id: 'synthetic-lot-101',
    quantity_sold: 2,
    unit_price: 15,
    selected_unit: 'large',
    item_discount_percent: 0,
    is_negative: false,
  }],
};
const refund = {
  request_id: 'befbfb97-906e-4955-9807-b8c3da60fc0a',
  invoice_id: 'synthetic-sale-100',
  refund_method: 'cash' as const,
  reason: 'synthetic refund after a previously committed checkout',
  expected_total_refund: 15,
  items: [{
    sale_item_id: 31,
    inventory_id: 'synthetic-lot-101',
    drug_name: 'Synthetic product',
    quantity: 1,
    unit_price: 15,
    unit: 'large',
  }],
};

describe('native sale → return IPC safety boundary (mocked invoke, no real native writes)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoke.mockReset();
    mockReturnStorage.clear();
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      localStorage: {
        getItem: (key: string) => mockReturnStorage.get(key) ?? null,
        setItem: (key: string, value: string) => { mockReturnStorage.set(key, value); },
        removeItem: (key: string) => { mockReturnStorage.delete(key); },
      },
    } });
    mockPermissions = {
      can_access_pos: true, can_sell_no_stock: false, can_view_returns: true,
    };
    mockActiveActor = 'synthetic-local-session';
    mockActiveTenant = 'synthetic-visible-tenant';
  });

  it('rejects a malformed native checkout success envelope before notifying inventory or claiming a committed sale', async () => {
    mockInvoke.mockResolvedValue({ sale_id: '', total_amount: null });

    const result = await processCheckoutAction(checkout);
    expect(result).toMatchObject({ success: false });
    expect(mockInvoke).toHaveBeenCalledWith('process_checkout_critical', {
      requestId: checkout.request_id,
      payload: expect.objectContaining({ items: checkout.items }),
    });
    expect(mockInventoryChanged).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it('rejects a malformed native refund success envelope before notifying inventory or claiming a refund', async () => {
    mockInvoke.mockResolvedValue({ return_id: '', total_refund: undefined });

    expect(await createReturnAction(refund)).toMatchObject({ success: false });
    expect(mockInvoke).toHaveBeenCalledWith('create_return_critical', {
      requestId: refund.request_id,
      payload: expect.objectContaining({ invoice_id: refund.invoice_id }),
    });
    expect(mockInventoryChanged).not.toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('preserves an actionable native string rejection for a denied refund without reporting a write', async () => {
    const nativeDenial = 'Native sale return failed: original receipt requires reconciliation';
    mockInvoke.mockRejectedValueOnce(nativeDenial);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await createReturnAction(refund)).toEqual({ success: false, error: nativeDenial });
    } finally {
      consoleError.mockRestore();
    }
    expect(mockInventoryChanged).not.toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('uses read-only original 043 receipt confirmation after an uncertain refund reply', async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error('synthetic dropped checkout acknowledgment'))
      .mockResolvedValueOnce({
        sale_id: 'synthetic-sale-100',
        total_amount: 30,
        points_earned: 0,
        points_redeemed: 0,
        loyalty_discount_amount: 0,
        created_at: '2026-10-15',
      })
      .mockRejectedValueOnce(new Error('synthetic dropped return acknowledgment'))
      .mockResolvedValueOnce({
        id: 'synthetic-return-200', requestId: refund.request_id,
        invoiceId: refund.invoice_id, actorId: 'synthetic-local-session',
        pharmacyId: 'synthetic-visible-tenant', refundMethod: 'cash',
        amountCents: 1500, lineSha256: originalLineSha256,
      });

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await processCheckoutAction(checkout)).toMatchObject({ success: false });
      expect(await processCheckoutAction(checkout)).toMatchObject({
        success: true, data: { sale_id: 'synthetic-sale-100' },
      });
      expect(await createReturnAction(refund)).toMatchObject({ success: false });
      expect(await createReturnAction(refund)).toMatchObject({ success: true, returnId: 'synthetic-return-200' });
    } finally {
      consoleError.mockRestore();
    }

    expect(mockInvoke.mock.calls.map(call => [call[0], call[1].requestId])).toEqual([
      ['process_checkout_critical', checkout.request_id],
      ['process_checkout_critical', checkout.request_id],
      ['create_return_critical', refund.request_id],
      ['confirm_sales_return_native', undefined],
    ]);
    expect(mockInvoke.mock.calls.every(call => !('user_id' in call[1].payload) && !('pharmacy_id' in call[1].payload))).toBe(true);
    expect(mockInventoryChanged).toHaveBeenCalledTimes(2);
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('blocks negative-stock checkout without permission before any native sale or refund transaction', async () => {
    expect(await processCheckoutAction({
      ...checkout,
      items: [{ ...checkout.items[0], is_negative: true, inventory_id: null }],
    })).toMatchObject({ success: false, error: 'غير مصرح بالبيع بدون رصيد' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockInventoryChanged).not.toHaveBeenCalled();
  });

  it('persists a privacy-limited hint before the original write and never reposts on absent receipt', async () => {
    mockInvoke.mockImplementationOnce(async () => {
      const saved = [...mockReturnStorage.values()][0];
      expect(saved).not.toContain(refund.reason);
      expect(saved).not.toContain(refund.items[0].drug_name);
      expect(JSON.parse(saved)).toEqual(expect.objectContaining({
        requestId: refund.request_id, invoiceId: refund.invoice_id, rail: 'cash',
        amountCents: 1500, lineSha256: originalLineSha256,
        scopeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }));
      throw new Error('original write ACK lost');
    }).mockResolvedValueOnce(null);
    expect(await createReturnAction(refund)).toMatchObject({ success: false });
    expect(nativeSalesReturnRecoveryPending()).toBe(true);
    expect(await confirmPendingSalesReturnAction()).toMatchObject({ success: false });
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
      'create_return_critical', 'confirm_sales_return_native',
    ]);
    expect(nativeSalesReturnRecoveryPending()).toBe(true);
  });

  it.each([
    ['foreign actor', { actorId: 'foreign-actor' }],
    ['foreign tenant', { pharmacyId: 'foreign-tenant' }],
    ['wrong rail', { refundMethod: 'bank' }],
    ['wrong amount', { amountCents: 1501 }],
    ['changed line digest', { lineSha256: 'b'.repeat(64) }],
  ])('leaves the original nonce unresolved on %s confirmation', async (_case, changes) => {
    mockInvoke.mockRejectedValueOnce(new Error('ACK dropped'))
      .mockResolvedValueOnce({
        id: 'return-200', requestId: refund.request_id, invoiceId: refund.invoice_id,
        actorId: 'synthetic-local-session', pharmacyId: 'synthetic-visible-tenant',
        refundMethod: 'cash', amountCents: 1500, lineSha256: originalLineSha256,
        ...changes,
      });
    expect(await createReturnAction(refund)).toMatchObject({ success: false });
    expect(await confirmPendingSalesReturnAction()).toMatchObject({ success: false });
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
      'create_return_critical', 'confirm_sales_return_native',
    ]);
    expect(nativeSalesReturnRecoveryPending()).toBe(true);
  });

  it('blocks corrupt storage, missing crypto and failed persistence before any financial IPC', async () => {
    mockReturnStorage.set('pharma:sales-return-native-ack:v1', '{broken');
    expect(nativeSalesReturnRecoveryPending()).toBe(true);
    expect(await createReturnAction(refund)).toMatchObject({ success: false });
    expect(mockInvoke).not.toHaveBeenCalled();
    mockReturnStorage.clear();
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    expect(await createReturnAction(refund)).toMatchObject({ success: false });
    expect(mockInvoke).not.toHaveBeenCalled();
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
    const setter = jest.spyOn(globalThis.window.localStorage, 'setItem')
      .mockImplementation(() => { throw new Error('quota full'); });
    try {
      expect(await createReturnAction(refund)).toMatchObject({ success: false });
      expect(mockInvoke).not.toHaveBeenCalled();
    } finally {
      setter.mockRestore();
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
    expect(nativeSalesReturnRecoveryPending()).toBe(true);
    expect(await createReturnAction(refund)).toMatchObject({ success: false });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it.each([
    ['changed refund cents', { expected_total_refund: 16 }],
    ['changed refund rail', { refund_method: 'bank' }],
    ['changed original line amount', { items: [{ ...refund.items[0], quantity: 2 }] }],
    ['changed reason', { reason: 'new reason after lost ACK' }],
    ['new request nonce', { request_id: '7af3f19f-6d8a-4fb1-aaea-839a6a824c34' }],
  ])('does not consume a pending original 043 intent with %s', async (_case, change) => {
    mockInvoke.mockRejectedValueOnce(new Error('Original write may have committed'))
      .mockResolvedValueOnce({
        id: 'return-original', requestId: refund.request_id, invoiceId: refund.invoice_id,
        actorId: mockActiveActor, pharmacyId: mockActiveTenant, refundMethod: 'cash',
        amountCents: 1500, lineSha256: originalLineSha256,
      });
    expect(await createReturnAction(refund)).toMatchObject({ success: false });
    const originalMarker = [...mockReturnStorage.values()][0];
    expect(await createReturnAction({ ...refund, ...change } as typeof refund)).toMatchObject({ success: false });
    expect([...mockReturnStorage.values()][0]).toEqual(originalMarker);
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual(['create_return_critical']);
  });

  it.each([
    ['actor', 'foreign-actor', 'synthetic-visible-tenant', false],
    ['tenant', 'synthetic-local-session', 'foreign-tenant', false],
    ['permission', 'synthetic-local-session', 'synthetic-visible-tenant', true],
  ])('keeps original marker if native confirmation resolves after %s changes', async (_case, switchedActor, switchedTenant, revoke) => {
    mockInvoke.mockRejectedValueOnce(new Error('Lost refund acknowledgment'));
    expect(await createReturnAction(refund)).toMatchObject({ success: false });
    let resolveConfirmation!: (value: unknown) => void;
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>(resolve => { signalReadStarted = resolve; });
    mockInvoke.mockImplementationOnce(() => new Promise(resolve => {
      resolveConfirmation = resolve;
      signalReadStarted();
    }));
    const confirmation = confirmPendingSalesReturnAction();
    await readStarted;
    mockActiveActor = switchedActor;
    mockActiveTenant = switchedTenant;
    if (revoke) mockPermissions.can_view_returns = false;
    resolveConfirmation({
      id: 'return-original', requestId: refund.request_id, invoiceId: refund.invoice_id,
      actorId: 'synthetic-local-session', pharmacyId: 'synthetic-visible-tenant',
      refundMethod: 'cash', amountCents: 1500, lineSha256: originalLineSha256,
    });
    expect(await confirmation).toMatchObject({ success: false });
    expect(nativeSalesReturnRecoveryPending()).toBe(true);
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
      'create_return_critical', 'confirm_sales_return_native',
    ]);
  });

  it.each([
    ['actor', 'foreign-actor', 'synthetic-visible-tenant', false],
    ['tenant', 'synthetic-local-session', 'foreign-tenant', false],
    ['permission', 'synthetic-local-session', 'synthetic-visible-tenant', true],
  ])('must retain durable refund hint when a successful write ACK arrives after %s changed', async (_case, switchedActor, switchedTenant, revoke) => {
    let resolvePosting!: (value: unknown) => void;
    let started!: () => void;
    const postingStarted = new Promise<void>(resolve => { started = resolve; });
    mockInvoke.mockImplementationOnce(() => new Promise(resolve => {
      resolvePosting = resolve;
      started();
    }));
    const attempt = createReturnAction(refund);
    await postingStarted;
    mockActiveActor = switchedActor;
    mockActiveTenant = switchedTenant;
    if (revoke) mockPermissions.can_view_returns = false;
    resolvePosting({ return_id: 'return-original', total_refund: 15 });
    expect(await attempt).toMatchObject({ success: false });
    expect(nativeSalesReturnRecoveryPending()).toBe(true);
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual(['create_return_critical']);
  });

  it('pins exactly the original source and preview before asynchronous auth can expose mutable form data', async () => {
    const mutable = {
      ...refund, items: refund.items.map(item => ({ ...item })),
    };
    mockInvoke.mockResolvedValueOnce({ return_id: 'return-original', total_refund: 15 });
    const attempt = createReturnAction(mutable);
    mutable.expected_total_refund = 18;
    mutable.items[0].quantity = 2;
    mutable.refund_method = 'bank' as 'cash';
    mutable.reason = 'changed after click';
    expect(await attempt).toMatchObject({ success: true, totalRefund: 15 });
    expect(mockInvoke).toHaveBeenCalledWith('create_return_critical', {
      requestId: refund.request_id,
      payload: expect.objectContaining({
        refund_method: 'cash', reason: refund.reason,
        items: [expect.objectContaining({ quantity: 1 })],
      }),
    });
    expect(nativeSalesReturnRecoveryPending()).toBe(false);
  });
});
