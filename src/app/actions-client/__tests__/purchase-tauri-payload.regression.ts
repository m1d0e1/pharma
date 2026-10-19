const mockInvoke = jest.fn(async (_command: string, _args?: unknown) => ({ id: 'purchase-1' }));
const mockDbSelect = jest.fn(async (sql: string, _params: unknown[] = []) => {
  if (/FROM\s+master_drugs/i.test(sql)) return [{ id: 9001, large_to_medium: 10 }];
  return [{ name: 'barcode' }];
});
const mockDbGet = jest.fn(async (..._args: unknown[]) => ({ id: 'purchase-1' }));
let canModifyUnitConversion = true;

jest.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
}));

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (sql: string, params?: unknown[]) => mockDbSelect(sql, params),
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbExecute: jest.fn(async () => ({ rowsAffected: 0, lastInsertId: null })),
  dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
  generateId: jest.fn(() => 'test-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'owner', pharmacy_id: 'pharmacy-1' })),
  hasUserPermissionSync: jest.fn((_user: unknown, permission: string) =>
    permission === 'can_modify_unit_conversion' ? canModifyUnitConversion : true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { updateDrug: jest.fn() },
}));

jest.mock('@/lib/env', () => ({ isTauri: true }));

import { createPurchaseInvoiceAction, deletePurchaseInvoiceAction, updateCompletedPurchaseInvoiceAction } from '@/app/actions-client/purchases';

describe('Tauri purchase payload regressions', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    mockDbSelect.mockClear();
    mockDbGet.mockReset().mockResolvedValue({ id: 'purchase-1' });
    canModifyUnitConversion = true;
  });

  it('preserves item barcode when updating a completed purchase', async () => {
    const result = await updateCompletedPurchaseInvoiceAction({
      id: 'purchase-1',
      supplier_id: 7,
      cart: [{
        id: 9001,
        purchase_invoice_item_id: 42,
        quantity: 2,
        unit_id: 1,
        expiry_date: '2099-12-31',
        cost_price: 10,
        selling_price: 15,
        bonus_quantity: 0,
        tax_percent: 0,
        discount_percent: 0,
        strips_per_box: 1,
        barcode: '6221234567890',
      }],
    });

    expect(result.success).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith('save_purchase_invoice_critical', {
      expectedExistingStatus: 'completed',
      payload: expect.objectContaining({
        id: 'purchase-1',
        cart: [expect.objectContaining({
          purchase_invoice_item_id: 42,
          barcode: '6221234567890',
        })],
      }),
    });
    expect((mockInvoke.mock.calls[0][1] as any)?.payload).not.toHaveProperty('pharmacy_id');
    expect((mockInvoke.mock.calls[0][1] as any)?.payload).not.toHaveProperty('user_id');
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('defers historical conversion validation to the native transaction for completed edits', async () => {
    canModifyUnitConversion = false;

    const result = await updateCompletedPurchaseInvoiceAction({
      id: 'purchase-1',
      supplier_id: 7,
      cart: [{
        id: 9001,
        purchase_invoice_item_id: 42,
        quantity: 2,
        cost_price: 10,
        selling_price: 15,
        expiry_date: '2099-12-31',
      }],
    });

    expect(result.success).toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith('save_purchase_invoice_critical', {
      expectedExistingStatus: 'completed',
      payload: expect.objectContaining({ cart: [expect.objectContaining({ strips_per_box: 1 })] }),
    });
    expect(mockDbSelect).not.toHaveBeenCalled();
    mockInvoke.mockRejectedValueOnce(new Error('Unauthorized: can_modify_unit_conversion permission required'));
    const rejected = await updateCompletedPurchaseInvoiceAction({
      id: 'purchase-1', supplier_id: 7,
      cart: [{ id: 9001, quantity: 2, cost_price: 10, expiry_date: '2099-12-31' }],
    });
    expect(rejected).toMatchObject({ success: false, error: expect.stringContaining('can_modify_unit_conversion') });
  });

  it('uses native draft-only precondition when replacing a saved draft, but not for new invoices', async () => {
    const payload = {
      supplier_id: 7,
      payment_method: 'credit',
      status: 'draft',
      cart: [{ id: 9001, quantity: 1, cost_price: 10, expiry_date: '2099-12-31' }],
    };
    const existing = await createPurchaseInvoiceAction({ ...payload, id: 'purchase-1' });
    expect(existing).toMatchObject({ success: true });
    expect(mockInvoke).toHaveBeenCalledWith('save_purchase_invoice_critical', {
      expectedExistingStatus: 'draft',
      requestId: null,
      payload: expect.objectContaining({ id: 'purchase-1' }),
    });
    expect(mockDbGet).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();

    mockInvoke.mockClear();
    const fresh = await createPurchaseInvoiceAction(payload);
    expect(fresh).toMatchObject({ success: true });
    expect(mockInvoke).toHaveBeenCalledWith('save_purchase_invoice_critical', {
      expectedExistingStatus: null,
      requestId: expect.any(String),
      payload: expect.not.objectContaining({ id: 'purchase-1' }),
    });
  });

  it('scopes purchase deletion to the signed-in pharmacy and forwards the authoritative native payload', async () => {
    const result = await deletePurchaseInvoiceAction('purchase-1', true);

    expect(result).toEqual({ success: true });
    // Native command owns the actual tenant/existence check inside its write
    // transaction; no generic renderer SELECT is legal in secure release.
    expect(mockDbGet).not.toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith('delete_purchase_invoice_critical', {
      payload: {
        invoice_id: 'purchase-1',
        remove_inventory: true,
      },
    });
  });

  it('does not invoke native purchase deletion for an invoice outside the signed-in pharmacy', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Purchase invoice belongs to another pharmacy'));

    const result = await deletePurchaseInvoiceAction('foreign-purchase', false);

    expect(result).toEqual({ success: false, error: 'Purchase invoice belongs to another pharmacy' });
    expect(mockInvoke).toHaveBeenCalledWith('delete_purchase_invoice_critical', {
      payload: expect.objectContaining({ invoice_id: 'foreign-purchase' }),
    });
    expect(mockDbGet).not.toHaveBeenCalled();
  });
});
