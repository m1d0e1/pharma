let permissions: Record<string, unknown> = {};
const session = { id: 'admin-1', role: 'admin', pharmacy_id: 'local_default' };

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ ...session, permissions })),
  getPermissionValue: jest.fn(async (key: string, fallback: unknown) => permissions[key] ?? fallback),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.role === 'owner' || user?.permissions?.[key] === true),
}));

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => { throw new Error('database should not be reached'); }),
  dbGet: jest.fn(async () => { throw new Error('database should not be reached'); }),
  dbExecute: jest.fn(async () => { throw new Error('database should not be reached'); }),
  dbTransaction: jest.fn(async () => { throw new Error('database should not be reached'); }),
  generateId: jest.fn(() => 'id-1'),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), getAllDrugs: jest.fn(() => []), updateDrug: jest.fn(), addDrug: jest.fn() },
}));
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.unmock('@/app/actions-client/inventory');

import { processCheckoutAction } from '@/app/actions-client/sales';
import { addExpenseAction } from '@/app/actions-client/expenses';
import {
  addDrugAlternativeAction,
  addDrugIndicationAction,
  addDrugInteractionAction,
  addMasterDrugAction,
  addProductCategoryAction,
  addUsageMethodAction,
  deleteDrugIndicationAction,
  deleteProductCategoryAction,
  importMasterDrugWorkbookAction,
  removeDrugAlternativeAction,
  removeDrugInteractionAction,
  updateProductCategoryAction,
} from '@/app/actions-client/master-drugs';
import { importInventoryWorkbookAction } from '@/app/actions-client/inventory';
import { createPurchaseInvoiceAction } from '@/app/actions-client/purchases';
import { addToShortagesAction } from '@/app/actions-client/shortages';
import { dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';
import { secureCache } from '@/lib/cache/secure_cache';

const item = { drug_id: 1, quantity_sold: 1, unit_price: 100, selected_unit: 'large' };

describe('business permission enforcement', () => {
  beforeEach(() => { permissions = { can_access_pos: true }; });

  it.each([
    [{ items: [item], payment_method: 'credit' }, 'البيع الآجل'],
    [{ items: [{ ...item, is_negative: true }], payment_method: 'cash' }, 'البيع بدون رصيد'],
    [{ items: [{ ...item, unit_price: 90, item_discount_percent: 10 }], payment_method: 'cash' }, 'خصم الصنف'],
    [{ items: [item], payment_method: 'cash', status: 'draft' }, 'الفواتير المعلقة'],
    [{ items: [item], payment_method: 'cash', total_discount: 1 }, 'خصم إجمالي'],
  ])('rejects a POS operation whose checkbox is disabled', async (request, message) => {
    const result = await processCheckoutAction(request);
    expect(result).toEqual(expect.objectContaining({ success: false, error: expect.stringContaining(message) }));
  });

  it('rejects expense creation without the expense-definition permission', async () => {
    const result = await addExpenseAction({ category: 'rent', amount: 10, description: '', date: '2026-08-31' });
    expect(result).toEqual({ success: false, error: 'غير مصرح' });
  });

  it('enforces the configured maximum invoice discount', async () => {
    permissions = { can_access_pos: true, can_give_total_discount: true, max_invoice_discount_percent: 5 };
    const result = await processCheckoutAction({ items: [item], payment_method: 'cash', total_discount: 10 });
    expect(result).toEqual({ success: false, error: 'نسبة الخصم تتجاوز الحد المسموح (5%)' });
  });

  it('rejects inventory mutation without inventory-management permission', async () => {
    const result = await addMasterDrugAction({ trade_name: 'Blocked', official_price: 10 });
    expect(result).toEqual({ success: false, error: 'غير مصرح' });
  });

  it('rejects shared master-data mutation without inventory-management permission', async () => {
    const result = await addUsageMethodAction({ name_ar: 'Blocked' });
    expect(result.success).toBe(false);
  });

  it('rejects product-category mutations without inventory-management permission before touching the database', async () => {
    expect(await addProductCategoryAction({ name_ar: 'Blocked category' })).toEqual({ success: false, error: 'غير مصرح' });
    expect(await updateProductCategoryAction(1, { name_ar: 'Blocked category' })).toEqual({ success: false, error: 'غير مصرح' });
    expect(await deleteProductCategoryAction(1)).toEqual({ success: false, error: 'غير مصرح' });
  });

  it('rejects linked master-data mutations without inventory-management permission before touching the database', async () => {
    expect(await addDrugIndicationAction(1, 2)).toEqual({ success: false, error: 'غير مصرح' });
    expect(await deleteDrugIndicationAction(1, 2)).toEqual({ success: false, error: 'غير مصرح' });
    expect(await addDrugAlternativeAction(1, 2)).toEqual({ success: false, error: 'غير مصرح' });
    expect(await removeDrugAlternativeAction(1, 2)).toEqual({ success: false, error: 'غير مصرح' });
    expect(await addDrugInteractionAction('A', 'B')).toEqual({ success: false, error: 'غير مصرح' });
    expect(await removeDrugInteractionAction(1)).toEqual({ success: false, error: 'غير مصرح' });
  });

  it('rejects master-catalog workbook import at the action boundary without inventory-management permission', async () => {
    const result = await importMasterDrugWorkbookAction([{ trade_name: 'Blocked import' }]);
    expect(result).toEqual({ success: false, error: 'غير مصرح' });
  });

  it('rejects inventory workbook import at the action boundary without inventory-management permission', async () => {
    const result = await importInventoryWorkbookAction([{ drug_id: 1, quantity: 1 }], [{ id: 1, trade_name: 'Blocked' }]);
    expect(result).toEqual({ success: false, error: 'غير مصرح' });
  });

  it('rejects purchase creation without purchase permission before touching the database', async () => {
    const result = await createPurchaseInvoiceAction({ supplier_id: 1, cart: [] });
    expect(result).toEqual({ success: false, error: 'Unauthorized' });
  });

  it('rejects shortage mutation without restock permission before touching the database', async () => {
    const result = await addToShortagesAction({ drug_id: 1, qty: 1 });
    expect(result).toEqual({ success: false, error: 'غير مصرح' });
  });

  it('preserves manual interaction provenance when routing an authorized UI mutation through the action boundary', async () => {
    permissions = { can_manage_inventory: true };
    (dbGet as jest.Mock).mockResolvedValueOnce(null);
    (dbExecute as jest.Mock).mockResolvedValue({ rowsAffected: 1 });

    expect(await addDrugInteractionAction('ING-A', 'Food X', 'food')).toEqual({ success: true });
    expect(dbExecute).toHaveBeenCalledWith(
      'INSERT INTO drug_interactions (ingredient_a, ingredient_b, severity, source) VALUES (?, ?, ?, ?)',
      ['ING-A', 'Food X', 'food', 'MANUAL']
    );
  });

  it('keeps the loaded catalog cache coherent after an authorized manual drug add', async () => {
    permissions = { can_manage_inventory: true };
    (dbTransaction as jest.Mock).mockImplementationOnce(async (callback: () => unknown) => callback());
    (dbExecute as jest.Mock).mockResolvedValue({ rowsAffected: 1, lastInsertId: 321 });
    (secureCache.addDrug as jest.Mock).mockClear();

    expect(await addMasterDrugAction({
      trade_name: 'Paged Cache Drug',
      trade_name_en: 'Paged Cache Drug',
      official_price: 15,
      active_ingredient: 'Cache Ingredient',
    })).toEqual({ success: true, id: 321 });

    expect(secureCache.addDrug).toHaveBeenCalledWith(expect.objectContaining({
      id: 321,
      trade_name: 'Paged Cache Drug',
      trade_name_en: 'Paged Cache Drug',
      active_ingredient: 'Cache Ingredient',
      official_price: 15,
      is_medicine: 1,
      is_service: 0,
      stop_dealing: 0,
    }));
  });
});
