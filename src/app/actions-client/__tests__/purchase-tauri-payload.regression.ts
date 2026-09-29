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

import { deletePurchaseInvoiceAction, updateCompletedPurchaseInvoiceAction } from '@/app/actions-client/purchases';

describe('Tauri purchase payload regressions', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
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
      payload: expect.objectContaining({
        id: 'purchase-1',
        pharmacy_id: 'pharmacy-1',
        cart: [expect.objectContaining({
          purchase_invoice_item_id: 42,
          barcode: '6221234567890',
        })],
      }),
    });
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
      payload: expect.objectContaining({ cart: [expect.objectContaining({ strips_per_box: 1 })] }),
    });
    mockInvoke.mockRejectedValueOnce(new Error('Unauthorized: can_modify_unit_conversion permission required'));
    const rejected = await updateCompletedPurchaseInvoiceAction({
      id: 'purchase-1', supplier_id: 7,
      cart: [{ id: 9001, quantity: 2, cost_price: 10, expiry_date: '2099-12-31' }],
    });
    expect(rejected).toMatchObject({ success: false, error: expect.stringContaining('can_modify_unit_conversion') });
  });

  it('scopes purchase deletion to the signed-in pharmacy and forwards the authoritative native payload', async () => {
    const result = await deletePurchaseInvoiceAction('purchase-1', true);

    expect(result).toEqual({ success: true });
    expect(mockDbGet).toHaveBeenCalledWith(
      expect.stringContaining('pharmacy_id'),
      ['purchase-1', 'pharmacy-1', 'pharmacy-1'],
    );
    expect(mockInvoke).toHaveBeenCalledWith('delete_purchase_invoice_critical', {
      payload: {
        invoice_id: 'purchase-1',
        remove_inventory: true,
        user_id: 'admin',
        pharmacy_id: 'pharmacy-1',
      },
    });
  });

  it('does not invoke native purchase deletion for an invoice outside the signed-in pharmacy', async () => {
    mockDbGet.mockResolvedValueOnce(null);

    const result = await deletePurchaseInvoiceAction('foreign-purchase', false);

    expect(result).toEqual({ success: false, error: 'Purchase invoice not found in this pharmacy' });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
