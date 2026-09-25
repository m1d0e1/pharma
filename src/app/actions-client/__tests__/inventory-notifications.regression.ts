const mockInvoke = jest.fn();

jest.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args?: unknown) => mockInvoke(command, args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => [{ name: 'barcode' }]),
  dbGet: jest.fn(async () => ({ id: 'purchase-1' })),
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

it('notifies after successful inventory imports but not failed imports', async () => {
  (importInventoryWorkbookRows as jest.Mock).mockResolvedValueOnce({ imported: 1 });
  const imported = await countInventoryChanges(() => importInventoryWorkbookAction([], []));
  expect(imported.result).toMatchObject({ success: true });
  expect(imported.listener).toHaveBeenCalledTimes(1);

  (importInventoryWorkbookRows as jest.Mock).mockRejectedValueOnce(new Error('import failed'));
  const failed = await countInventoryChanges(() => importInventoryWorkbookAction([], []));
  expect(failed.result).toMatchObject({ success: false });
  expect(failed.listener).not.toHaveBeenCalled();
});

it('notifies after native negative-sale settlement only when the command succeeds', async () => {
  const settled = await countInventoryChanges(() => settleSaleItemAction(4, 'inventory-1'));
  expect(settled.result).toMatchObject({ success: true });
  expect(settled.listener).toHaveBeenCalledTimes(1);

  mockInvoke.mockRejectedValueOnce(new Error('settlement failed'));
  const failed = await countInventoryChanges(() => settleSaleItemAction(4, 'inventory-1'));
  expect(failed.result).toMatchObject({ success: false });
  expect(failed.listener).not.toHaveBeenCalled();
});

it('notifies after completed purchase writes but not draft or failed writes', async () => {
  const completed = await countInventoryChanges(() => createPurchaseInvoiceAction({
    supplier_id: 1,
    status: 'completed',
    cart: [{ id: 1, quantity: 1, cost_price: 5 }],
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

  mockInvoke.mockRejectedValueOnce(new Error('write failed'));
  const failed = await countInventoryChanges(() => createPurchaseInvoiceAction({
    supplier_id: 1,
    status: 'completed',
    cart: [{ id: 1, quantity: 1, cost_price: 5 }],
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
    id: 'purchase-1', supplier_id: 1, cart: [],
  }));
  expect(edited.result).toMatchObject({ success: true });
  expect(edited.listener).toHaveBeenCalledTimes(1);

  const deleted = await countInventoryChanges(() => deletePurchaseInvoiceAction('purchase-1', true));
  expect(deleted.result).toMatchObject({ success: true });
  expect(deleted.listener).toHaveBeenCalledTimes(1);
});
