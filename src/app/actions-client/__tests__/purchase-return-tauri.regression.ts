const mockInvoke = jest.fn(async (_command?: string, _args?: unknown) => ({ return_id: 'return-1', total_amount: 62.37 }));

jest.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
}));

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
  dbGet: jest.fn(),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'user-1', pharmacy_id: null })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { updateDrug: jest.fn() },
}));

jest.mock('@/lib/env', () => ({ isTauri: true }));

import { createPurchaseReturnAction } from '@/app/actions-client/purchases';

it('sends only return intent and session identity to the atomic Tauri command', async () => {
  const result = await createPurchaseReturnAction({
    purchase_invoice_id: 'purchase-1',
    supplier_id: 7,
    reason: 'damaged',
    refund_method: 'credit',
    items: [{
      purchase_invoice_item_id: 11,
      inventory_id: 'attacker-lot',
      drug_id: 999,
      drug_name: 'Tampered',
      quantity: 6,
      unit_price: 0.01,
      unit: 'medium',
    }],
  });

  expect(result).toEqual({ success: true, id: 'return-1' });
  expect(mockInvoke).toHaveBeenCalledWith('create_purchase_return_critical', {
    payload: {
      purchase_invoice_id: 'purchase-1',
      supplier_id: 7,
      user_id: 'user-1',
      pharmacy_id: 'local_default',
      reason: 'damaged',
      refund_method: 'credit',
      items: [{ purchase_invoice_item_id: 11, quantity: 6, unit: 'medium' }],
    },
  });
});
