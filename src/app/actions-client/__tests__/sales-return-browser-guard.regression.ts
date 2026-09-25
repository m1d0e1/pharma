import { dbExecute, dbGet, dbSelect, dbTransaction } from '@/lib/db/tauri';
import { requireOpenShiftId } from '@/app/actions-client/finance';
import { createReturnAction } from '@/app/actions-client/returns';
import {
  createPurchaseInvoiceAction,
  completePurchaseInvoiceAction,
  createPurchaseReturnAction,
  updateCompletedPurchaseInvoiceAction,
} from '@/app/actions-client/purchases';

jest.mock('@/lib/db/tauri', () => ({
  dbExecute: jest.fn(),
  dbGet: jest.fn(),
  dbSelect: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));
jest.mock('@/app/actions-client/finance', () => ({
  requireOpenShiftId: jest.fn(async () => 'shift-1'),
}));
jest.mock('@/lib/env', () => ({ isTauri: false }));

beforeEach(() => jest.clearAllMocks());

it('denies browser sales-return writes before shift lookup or database mutation', async () => {
  const result = await createReturnAction({
    invoice_id: 'sale-1',
    refund_method: 'cash',
    reason: 'test',
    items: [{ sale_item_id: 1, inventory_id: 'lot-1', drug_name: 'Drug', quantity: 1, unit_price: 10 }],
  });

  expect(result).toEqual({
    success: false,
    error: 'إنشاء مرتجع من المتصفح غير مدعوم لأنه يتطلب معاملة ذرية؛ استخدم تطبيق سطح المكتب',
  });
  expect(requireOpenShiftId).not.toHaveBeenCalled();
  expect(dbTransaction).not.toHaveBeenCalled();
  expect(dbExecute).not.toHaveBeenCalled();
  expect(dbGet).not.toHaveBeenCalled();
  expect(dbSelect).not.toHaveBeenCalled();
});

it.each([
  ['create', () => createPurchaseInvoiceAction({ supplier_id: 1, cart: [] })],
  ['complete', () => completePurchaseInvoiceAction('purchase-1')],
  ['edit', () => updateCompletedPurchaseInvoiceAction({ id: 'purchase-1', supplier_id: 1, cart: [] })],
  ['return', () => createPurchaseReturnAction({ purchase_invoice_id: 'purchase-1', supplier_id: 1, refund_method: 'credit', reason: 'test', items: [] })],
] as const)('denies browser purchase %s before database access', async (_name, run) => {
  expect(await run()).toMatchObject({ success: false, error: expect.stringContaining('استخدم تطبيق سطح المكتب') });
  expect(requireOpenShiftId).not.toHaveBeenCalled();
  expect(dbTransaction).not.toHaveBeenCalled();
  expect(dbExecute).not.toHaveBeenCalled();
  expect(dbGet).not.toHaveBeenCalled();
  expect(dbSelect).not.toHaveBeenCalled();
});
