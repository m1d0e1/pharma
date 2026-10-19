import { closeDeliveryInvoiceAction, getPendingDeliveriesAction } from '@/app/actions-client/delivery';
import { invoke } from '@tauri-apps/api/core';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({ getLocalSession: jest.fn(), hasUserPermissionSync: jest.fn() }));
jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: jest.fn() }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(), dbExecute: jest.fn(), dbGet: jest.fn(),
  dbTransaction: jest.fn(), generateId: jest.fn(),
}));

const ipc = invoke as jest.Mock;
const NONCE = '12345678-aaaa-4aaa-8aaa-123456789abc';
const invoiceId = 'native-delivery-1';
const fee = 2.25;
const payload = { saleId: invoiceId, deliveryFee: fee, requestId: NONCE };
const proof = { id: `delivery-${NONCE}`, saleId: invoiceId, deliveryFee: fee, collectedAmount: 22.25 };
const invalidConfirmations: Array<[string, (sale: string) => typeof proof | null]> = [
  ['missing receipt', () => null],
  ['wrong sale', () => ({ ...proof, saleId: 'foreign-sale' })],
  ['wrong fee', sale => ({ ...proof, saleId: sale, deliveryFee: 7.25 })],
  ['wrong nonce', sale => ({ ...proof, saleId: sale, id: 'delivery-ffffffff-ffff-4fff-8fff-ffffffffffff' })],
  ['incorrect amount', sale => ({ ...proof, saleId: sale, collectedAmount: 0 })],
];

describe('native delivery pages and IPC receipt recovery', () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

  beforeEach(() => {
    ipc.mockReset();
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { randomUUID: jest.fn().mockReturnValue(NONCE) },
    });
  });

  afterAll(() => {
    if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
    else delete (globalThis as { crypto?: Crypto }).crypto;
  });

  it('transports the server keyset and reports pages as incomplete while hasMore is true', async () => {
    const nextCursor = { createdAt: '2026-10-12 10:00:00', id: 'sale-100' };
    ipc.mockResolvedValueOnce({ rows: [{ id: 'sale-101' }], hasMore: true, nextCursor })
      .mockResolvedValueOnce({ rows: [{ id: 'sale-100' }], hasMore: false, nextCursor: null });
    const first = await getPendingDeliveriesAction();
    expect(first).toMatchObject({ success: true, hasMore: true, nextCursor, data: [{ id: 'sale-101' }] });
    const second = await getPendingDeliveriesAction(nextCursor);
    expect(second).toMatchObject({ success: true, hasMore: false, nextCursor: null });
    expect(ipc).toHaveBeenNthCalledWith(1, 'list_pending_deliveries_native', { cursor: null });
    expect(ipc).toHaveBeenNthCalledWith(2, 'list_pending_deliveries_native', { cursor: nextCursor });
  });

  it('rejects an incomplete page rather than silently reporting a complete queue', async () => {
    ipc.mockResolvedValueOnce({ rows: [], hasMore: true, nextCursor: null });
    expect(await getPendingDeliveriesAction()).toMatchObject({ success: false });
  });

  it('recovers a committed collection with one write and a strictly matching read-only acknowledgement', async () => {
    ipc.mockRejectedValueOnce(new Error('IPC reply lost'))
      .mockResolvedValueOnce(proof);
    expect(await closeDeliveryInvoiceAction(invoiceId, fee)).toEqual({ success: true });
    expect(ipc).toHaveBeenCalledTimes(2);
    expect(ipc).toHaveBeenNthCalledWith(1, 'collect_delivery_native', { payload });
    expect(ipc).toHaveBeenNthCalledWith(2, 'confirm_delivery_collection_native', { payload });
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1);
  });

  it.each(invalidConfirmations)('does not accept %s as financial success', async (label, makeReceipt) => {
    const sale = `unverified-${label.replace(/ /g, '-')}`;
    const error = new Error('IPC result unknown');
    ipc.mockRejectedValueOnce(error).mockResolvedValueOnce(makeReceipt(sale));
    const result = await closeDeliveryInvoiceAction(sale, fee);
    expect(result).toMatchObject({ success: false, error: error.message });
    expect(ipc).toHaveBeenCalledTimes(2);
    expect(ipc).toHaveBeenNthCalledWith(2, 'confirm_delivery_collection_native', {
      payload: { saleId: sale, deliveryFee: fee, requestId: NONCE },
    });
  });

  it('preserves its nonce on an unresolved failure, but never invokes the financial write twice within one action', async () => {
    const sale = 'unknown-outcome-sale';
    ipc.mockRejectedValueOnce(new Error('initial timeout'))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('retry rejected'))
      .mockResolvedValueOnce(null);
    expect((await closeDeliveryInvoiceAction(sale, fee)).success).toBe(false);
    expect((await closeDeliveryInvoiceAction(sale, fee)).success).toBe(false);
    expect(ipc).toHaveBeenCalledTimes(4);
    expect(ipc).toHaveBeenNthCalledWith(1, 'collect_delivery_native', {
      payload: { saleId: sale, deliveryFee: fee, requestId: NONCE },
    });
    expect(ipc).toHaveBeenNthCalledWith(3, 'collect_delivery_native', {
      payload: { saleId: sale, deliveryFee: fee, requestId: NONCE },
    });
    expect(globalThis.crypto.randomUUID).toHaveBeenCalledTimes(1);
  });
});
