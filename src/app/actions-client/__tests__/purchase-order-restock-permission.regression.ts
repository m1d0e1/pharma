import { createFunctionTransactionDb as mockCreateFunctionTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

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

jest.mock('@/lib/db/tauri', () => {
  const dbSelect = jest.fn(async (sql: string) => {
    if (sql.includes('SELECT id FROM master_drugs')) return [{ id: 101 }];
    return [];
  });
  const dbGet = jest.fn(async () => null);
  const dbExecute = jest.fn(async () => ({ rowsAffected: 1, lastInsertId: 1 }));
  return {
    dbSelect,
    dbGet,
    dbExecute,
    dbTransaction: jest.fn(async (callback: any) => callback(mockCreateFunctionTransactionDb({ select: dbSelect, get: dbGet, execute: dbExecute }))),
    generateId: jest.fn(() => '12345678-restock-test'),
  };
});

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), getAllDrugs: jest.fn(() => []), updateDrug: jest.fn() },
}));
jest.mock('@/lib/env', () => ({ isTauri: false }));

import { createPurchaseInvoiceAction, createPurchaseOrderAction, getDrugInventoryQuantityAction, getPurchaseOrdersAction, updatePurchaseOrderStatusAction } from '@/app/actions-client/purchases';
import { getRoutePermission } from '@/lib/auth/roles';

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

  it('lets the same restock-only user close the purchase order they are allowed to create', async () => {
    expect(await updatePurchaseOrderStatusAction('PO-12345678', 'completed')).toEqual({ success: true });
  });

  it('lets the same restock-only user load the purchase-order list used by the orders page', async () => {
    expect(await getPurchaseOrdersAction()).toEqual({ success: true, data: [] });
  });

  it('lets restock-only users read local stock while composing a purchase order', async () => {
    expect(await getDrugInventoryQuantityAction(101)).toEqual({ success: true, data: 0 });
  });

  it('keeps the purchase-orders route reachable through either purchase or restock permission', () => {
    expect(getRoutePermission('/purchase-orders')).toEqual(['can_view_purchases', 'can_view_restock']);
  });

  it('still denies purchase-order creation when neither restock nor purchase permission is present', async () => {
    permissions = {};
    expect(await createPurchaseOrderAction({
      supplier_name: 'Blocked Supplier',
      items: [{ drug_id: 101, quantity: 1, expected_price: 1 }],
    })).toEqual({ success: false, error: 'Unauthorized' });
  });
});
