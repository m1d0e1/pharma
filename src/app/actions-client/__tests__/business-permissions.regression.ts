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
  secureCache: { load: jest.fn(), getAllDrugs: jest.fn(() => []), updateDrug: jest.fn() },
}));
jest.mock('@/lib/env', () => ({ isTauri: false }));

import { processCheckoutAction } from '@/app/actions-client/sales';
import { addExpenseAction } from '@/app/actions-client/expenses';
import { addMasterDrugAction } from '@/app/actions-client/master-drugs';

const item = { drug_id: 1, quantity_sold: 1, unit_price: 100, selected_unit: 'large' };

describe('business permission enforcement', () => {
  beforeEach(() => { permissions = {}; });

  it.each([
    [{ items: [item], payment_method: 'credit' }, 'البيع الآجل'],
    [{ items: [{ ...item, is_negative: true }], payment_method: 'cash' }, 'البيع بدون رصيد'],
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
    permissions = { can_give_total_discount: true, max_invoice_discount_percent: 5 };
    const result = await processCheckoutAction({ items: [item], payment_method: 'cash', total_discount: 10 });
    expect(result).toEqual({ success: false, error: 'نسبة الخصم تتجاوز الحد المسموح (5%)' });
  });

  it('rejects inventory mutation without inventory-management permission', async () => {
    const result = await addMasterDrugAction({ trade_name: 'Blocked', official_price: 10 });
    expect(result).toEqual({ success: false, error: 'غير مصرح' });
  });
});
