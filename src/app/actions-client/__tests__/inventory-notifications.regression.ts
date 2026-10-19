const mockInvoke = jest.fn();

jest.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => [{ name: 'barcode' }]),
  dbGet: jest.fn(async (sql: string) => {
    if (/SELECT id, pharmacy_id, status FROM sales_invoices WHERE id = \?/i.test(sql)) {
      return { id: 'source-draft-1', pharmacy_id: 'pharmacy-1', status: 'draft' };
    }
    return { id: 'purchase-1' };
  }),
  dbExecute: jest.fn(async () => ({ rowsAffected: 1 })),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'test-id'),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'user-1', role: 'owner', pharmacy_id: 'pharmacy-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { updateDrug: jest.fn() } }));
jest.mock('@/lib/inventory/import', () => ({ importInventoryWorkbookRows: jest.fn() }));
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(async () => ({ id: 'shift-1' })),
  getShiftForPharmacy: jest.fn(async () => ({ id: 'shift-1' })),
}));
jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: jest.fn(async () => 'shift-1') }));

import { processCheckoutAction } from '@/app/actions-client/sales';
import { settleSaleItemAction } from '@/app/actions-client/settlement';
import {
  createPurchaseInvoiceAction,
  createPurchaseReturnAction,
  deletePurchaseInvoiceAction,
  updateCompletedPurchaseInvoiceAction,
} from '@/app/actions-client/purchases';
import { INVENTORY_CHANGED_EVENT } from '@/lib/inventory/refresh';
import { importInventoryWorkbookRows } from '@/lib/inventory/import';
const { importInventoryWorkbookAction } = jest.requireActual('@/app/actions-client/inventory');

function countInventoryChanges(run: () => Promise<unknown>) {
  const listener = jest.fn();
  window.addEventListener(INVENTORY_CHANGED_EVENT, listener);
  return run().finally(() => window.removeEventListener(INVENTORY_CHANGED_EVENT, listener)).then(result => ({ result, listener }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInvoke.mockResolvedValue({ sale_id: 'sale-1', total_amount: 10, created_at: '2026-09-24' });
});

it('notifies after completed POS writes only', async () => {
  const item = { drug_id: 1, quantity_sold: 1, unit_price: 10 };
  const completed = await countInventoryChanges(() => processCheckoutAction({ items: [item], status: 'completed' }));
  expect(completed.result).toMatchObject({ success: true });
  expect(completed.listener).toHaveBeenCalledTimes(1);

  const draft = await countInventoryChanges(() => processCheckoutAction({ items: [item], status: 'draft' }));
  expect(draft.result).toMatchObject({ success: true });
  expect(draft.listener).not.toHaveBeenCalled();

  mockInvoke.mockRejectedValueOnce(new Error('write failed'));
  const failed = await countInventoryChanges(() => processCheckoutAction({ items: [item], status: 'completed' }));
  expect(failed.result).toMatchObject({ success: false });
  expect(failed.listener).not.toHaveBeenCalled();
});

it('forwards a loaded source draft id to the native checkout transaction', async () => {
  const result = await processCheckoutAction({
    items: [{ drug_id: 1, quantity_sold: 1, unit_price: 10 }],
    status: 'completed',
    source_draft_id: 'source-draft-1',
  });

  expect(result).toMatchObject({ success: true });
  expect(mockInvoke).toHaveBeenCalledWith('process_checkout_critical', {
    requestId: expect.any(String),
    payload: expect.objectContaining({
      source_draft_id: 'source-draft-1',
      status: 'completed',
    }),
  });
  const checkoutPayload = mockInvoke.mock.calls.find(([command]) => command === 'process_checkout_critical')?.[1]?.payload;
  expect(checkoutPayload).not.toHaveProperty('pharmacy_id');
  expect(checkoutPayload).not.toHaveProperty('user_id');
});

it('notifies after successful inventory imports but not failed imports', async () => {
  const requestId = 'a1111111-1111-4111-8111-111111111111';
  const { generateId } = jest.requireMock('@/lib/db/tauri');
  (generateId as jest.Mock).mockReturnValue(requestId);
  const newLot = { drug_id: 101, quantity: 1, local_selling_price: 12 };
  mockInvoke.mockResolvedValueOnce({
    success: true, requestId, inventoryIds: ['native-lot-id'],
    inventoryCount: 1, replayed: false,
  });
  const imported = await countInventoryChanges(() => importInventoryWorkbookAction([newLot], []));
  expect(imported.result).toMatchObject({ success: true });
  expect(imported.listener).toHaveBeenCalledTimes(1);

  mockInvoke.mockRejectedValueOnce(new Error('Native batch rollback'));
  const failed = await countInventoryChanges(() => importInventoryWorkbookAction([newLot], []));
  expect(failed.result).toMatchObject({ success: false });
  expect(failed.listener).not.toHaveBeenCalled();
  expect(importInventoryWorkbookRows).not.toHaveBeenCalled(); // Native never opens renderer SQL.
});

it('notifies after native negative-sale settlement only when the command succeeds', async () => {
  const settled = await countInventoryChanges(() => settleSaleItemAction(4, 'inventory-1'));
  expect(settled.result).toMatchObject({ success: true });
  expect(settled.listener).toHaveBeenCalledTimes(1);
  const nativeArgs = mockInvoke.mock.calls.find(([command]) => command === 'settle_negative_sale_item_critical')?.[1];
  expect(nativeArgs?.payload).toEqual({ sale_item_id: 4, inventory_id: 'inventory-1' });
  expect(nativeArgs?.payload).not.toHaveProperty('user_id');
  expect(nativeArgs?.payload).not.toHaveProperty('pharmacy_id');

  mockInvoke.mockRejectedValueOnce(new Error('settlement failed'));
  const failed = await countInventoryChanges(() => settleSaleItemAction(4, 'inventory-1'));
  expect(failed.result).toMatchObject({ success: false });
  expect(failed.listener).not.toHaveBeenCalled();
});

it('notifies after completed purchase writes but not draft or failed writes', async () => {
  // The native purchase create protocol first reads immutable 044 evidence and
  // then expects a concrete new invoice ID. A generic sale-shaped IPC mock
  // does not constitute a successful purchase and must not emit this event.
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'confirm_purchase_creation_native') return null;
    if (command === 'save_purchase_invoice_critical') {
      return { id: 'purchase-1', total_amount: 5 };
    }
    return { sale_id: 'sale-1', total_amount: 10, created_at: '2026-09-24' };
  });
  const completed = await countInventoryChanges(() => createPurchaseInvoiceAction({
    supplier_id: 1,
    status: 'completed',
    cart: [{ id: 1, quantity: 1, cost_price: 5, expiry_date: '2099-12-31' }],
  }));
  expect(completed.result).toMatchObject({ success: true });
  expect(completed.listener).toHaveBeenCalledTimes(1);

  const draft = await countInventoryChanges(() => createPurchaseInvoiceAction({
    supplier_id: 1,
    status: 'draft',
    cart: [{ id: 1, quantity: 1, cost_price: 5 }],
  }));
  expect(draft.result).toMatchObject({ success: true });
  expect(draft.listener).not.toHaveBeenCalled();

  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'confirm_purchase_creation_native') return null;
    if (command === 'save_purchase_invoice_critical') throw new Error('write failed');
    return { sale_id: 'sale-1', total_amount: 10, created_at: '2026-09-24' };
  });
  const failed = await countInventoryChanges(() => createPurchaseInvoiceAction({
    supplier_id: 1,
    status: 'completed',
    cart: [{ id: 1, quantity: 1, cost_price: 5, expiry_date: '2099-12-31' }],
  }));
  expect(failed.result).toMatchObject({ success: false });
  expect(failed.listener).not.toHaveBeenCalled();
});

it('notifies only after successful purchase return, edit, and inventory removal writes', async () => {
  const returnInput = {
    purchase_invoice_id: 'purchase-1',
    supplier_id: 1,
    reason: 'damaged',
    refund_method: 'credit' as const,
    items: [{ purchase_invoice_item_id: 1, drug_id: 1, drug_name: 'Test drug', quantity: 1, unit_price: 5, unit: 'large' }],
  };
  const returned = await countInventoryChanges(() => createPurchaseReturnAction(returnInput));
  expect(returned.result).toMatchObject({ success: true });
  expect(returned.listener).toHaveBeenCalledTimes(1);

  mockInvoke.mockRejectedValueOnce(new Error('return failed'));
  const failedReturn = await countInventoryChanges(() => createPurchaseReturnAction(returnInput));
  expect(failedReturn.result).toMatchObject({ success: false });
  expect(failedReturn.listener).not.toHaveBeenCalled();

  const edited = await countInventoryChanges(() => updateCompletedPurchaseInvoiceAction({
    id: 'purchase-1',
    supplier_id: 1,
    cart: [{ id: 1, quantity: 1, cost_price: 5, expiry_date: '2099-12-31', strips_per_box: 1 }],
  }));
  expect(edited.result).toMatchObject({ success: true });
  expect(edited.listener).toHaveBeenCalledTimes(1);

  const deleted = await countInventoryChanges(() => deletePurchaseInvoiceAction('purchase-1', true));
  expect(deleted.result).toMatchObject({ success: true });
  expect(deleted.listener).toHaveBeenCalledTimes(1);
});
