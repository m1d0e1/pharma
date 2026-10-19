/** @jest-environment node */
const invoke = jest.fn();
const select = jest.fn();
const get = jest.fn();
let session: any = { id: 'returner-a', pharmacy_id: 'tenant-a', role: 'cashier',
  permissions: { can_view_returns: true } };

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => invoke(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => select(...args),
  dbGet: (...args: any[]) => get(...args),
  dbExecute: jest.fn(), dbTransaction: jest.fn(), generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => session,
  hasUserPermissionSync: (user: any, permission: string) =>
    !!user?.permissions?.[permission],
}));
jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: jest.fn() }));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

import { getInvoiceForReturnAction } from '../returns';

const selected = '3726c3df-c9cf-4e32-835a-848d045e69aa';
const header = {
  id: selected, pharmacy_id: 'tenant-a', patient_id: null,
  user_id: 'returner-a', payment_method: 'cash', status: 'completed',
  total_amount: 120, discount_amount: 10, created_at: '2026-10-16 10:00:00',
};
const sold = {
  id: 81, invoice_id: selected, inventory_id: 'owned-lot-a', drug_id: 4,
  trade_name: 'Owned Drug', trade_name_en: 'Owned Drug EN',
  active_ingredient: 'OwnIngredient', quantity_sold: 10, unit_price: 13,
  unit: 'small', large_to_medium: 10, medium_to_small: 2,
  medium_unit: 'strip', small_unit: 'tablet', large_unit: 'box',
  expiry_date: '2030-01-01',
};
const prior = { sale_item_id: 81, quantity_returned: 1, unit: 'medium' };

describe('selected return invoice detail uses strictly tenant-authorized native projections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    session = { id: 'returner-a', pharmacy_id: 'tenant-a', role: 'cashier',
      permissions: { can_view_returns: true } };
    select.mockImplementation(() => { throw Error('PRIVATE generic renderer SQL rejected'); });
    get.mockImplementation(() => { throw Error('PRIVATE generic renderer SQL rejected'); });
    invoke.mockImplementation(async (command: string, args: any) => {
      if (command !== 'db_read_scoped') throw Error('Unexpected native command');
      if (args.queryId === 'returns.invoice_header') return [header];
      if (args.queryId === 'returns.invoice_items') return args.offset === 0 ? [sold] : [];
      if (args.queryId === 'returns.invoice_prior') return args.offset === 0 ? [prior] : [];
      if (args.queryId === 'returns.invoice_refund') return [{ total: 13 }];
      throw Error('No fixed trusted native reader');
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('loads a nonempty *owned* selected QA invoice with unit-aware prior returns, no generic SQL', async () => {
    const result = await getInvoiceForReturnAction(selected);
    expect(result).toMatchObject({ success: true, data: {
      id: selected, pharmacy_id: 'tenant-a', total_amount: 120,
      already_refunded: 13, items: [{
        id: 81, drug_name: 'Owned Drug', inventory_id: 'owned-lot-a',
        quantity_sold: 10, returned_quantity: 2, unit: 'small',
        large_to_medium: 10, medium_to_small: 2,
      }],
    } });
    expect(select).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(invoke.mock.calls.map((call: any[]) => call[1].queryId)).toEqual([
      'returns.invoice_header', 'returns.invoice_items', 'returns.invoice_prior',
      'returns.invoice_refund',
    ]);
    expect(invoke.mock.calls[0]).toEqual(['db_read_scoped', {
      queryId: 'returns.invoice_header', recordId: selected,
      search: null, drugId: null, limit: 1, offset: 0,
    }]);
    for (const [, args] of invoke.mock.calls) {
      expect(args).not.toHaveProperty('sql');
      expect(args).not.toHaveProperty('pharmacyId');
      expect(args).not.toHaveProperty('userId');
    }
  });

  it('fails closed on native foreign ownership or unsupported partial response', async () => {
    for (const malformed of [
      { ...header, pharmacy_id: 'tenant-b' },
      { ...header, pharmacy_id: null },
      { ...header, pharmacy_id: 'local_default' },
      { ...header, total_amount: undefined },
    ]) {
      invoke.mockImplementation(async (_command: string, args: any) =>
        args.queryId === 'returns.invoice_header' ? [malformed] : [sold]);
      const result = await getInvoiceForReturnAction(selected);
      expect(result.success).toBe(false);
      expect(select).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    }
  });

  it('rejects unproven foreign or detached sale items without exposing a partial return', async () => {
    for (const invalid of [
      { ...sold, invoice_id: 'other-private-invoice' },
      { ...sold, inventory_id: null },
      { ...sold, id: null },
    ]) {
      invoke.mockImplementation(async (_command: string, args: any) => {
        if (args.queryId === 'returns.invoice_header') return [header];
        if (args.queryId === 'returns.invoice_items') return [invalid];
        if (args.queryId === 'returns.invoice_prior') return [prior];
        return [{ total: 0 }];
      });
      expect((await getInvoiceForReturnAction(selected)).success).toBe(false);
    }
    expect(select).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('returns a real native denial, never successful empty detail/zero refunds', async () => {
    invoke.mockRejectedValue(new Error('Authenticated return permission denied'));
    const result = await getInvoiceForReturnAction(selected);
    expect(result.success).toBe(false);
    expect(select).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses local_default and missing permission before calling native command', async () => {
    session.pharmacy_id = 'local_default';
    expect((await getInvoiceForReturnAction(selected)).success).toBe(false);
    session.pharmacy_id = 'tenant-a';
    session.permissions.can_view_returns = false;
    expect(await getInvoiceForReturnAction(selected)).toMatchObject({ success: false, error: 'غير مصرح' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
