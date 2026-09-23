let permissions: Record<string, boolean> = {};

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({
    id: 'restock-user',
    role: 'pharmacist',
    pharmacy_id: 'ph-1',
    permissions,
  })),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.role === 'owner' || user?.permissions?.[key] === true),
}));

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string) => {
    if (sql.includes('SELECT id FROM master_drugs')) return [{ id: 101 }];
    return [];
  }),
  dbGet: jest.fn(async () => null),
  dbExecute: jest.fn(async () => ({ rowsAffected: 1, lastInsertId: 1 })),
  dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
  generateId: jest.fn(() => '12345678-restock-test'),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), getAllDrugs: jest.fn(() => []), updateDrug: jest.fn() },
}));
jest.mock('@/lib/env', () => ({ isTauri: false }));

import { createPurchaseInvoiceAction, createPurchaseOrderAction } from '@/app/actions-client/purchases';

describe('purchase-order permission bridge from restock', () => {
  beforeEach(() => {
    permissions = { can_view_restock: true };
    jest.clearAllMocks();
  });

  it('allows the purchase-order handoff offered by restock/shortages without granting full purchase access', async () => {
    const order = await createPurchaseOrderAction({
      supplier_name: 'Restock Supplier',
      items: [{ drug_id: 101, quantity: 4, expected_price: 12.5 }],
    });
    expect(order).toEqual({ success: true, po_id: 'PO-12345678' });

    const invoice = await createPurchaseInvoiceAction({ supplier_id: 1, cart: [] });
    expect(invoice).toEqual({ success: false, error: 'Unauthorized' });
  });

  it('still denies purchase-order creation when neither restock nor purchase permission is present', async () => {
    permissions = {};
    expect(await createPurchaseOrderAction({
      supplier_name: 'Blocked Supplier',
      items: [{ drug_id: 101, quantity: 1, expected_price: 1 }],
    })).toEqual({ success: false, error: 'Unauthorized' });
  });
});
