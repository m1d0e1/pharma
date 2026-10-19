/** @jest-environment node */

const invoke = jest.fn();
const select = jest.fn();
const get = jest.fn();
let session: any;

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => invoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => select(...args),
  dbGet: (...args: any[]) => get(...args),
  dbExecute: jest.fn(), dbTransaction: jest.fn(), generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => session,
  hasUserPermissionSync: (user: any, permission: string) => !!user?.permissions?.[permission],
}));
jest.mock('@/app/actions-client/finance', () => ({ requireOpenShiftId: jest.fn() }));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

import { getReturnsAction } from '../returns';

const owned = (id: string, date: string) => ({
  id, invoice_id: `sale-${id}`, pharmacy_id: 'tenant-a', user_id: 'returner-a',
  total_refund: 13, status: 'approved', refund_method: 'cash',
  created_at: date, user_name: null, patient_name: null, patient_id: null,
  item_count: 1, invoice_total: 120,
  invoice_date: date,
});
const item = (returnId: string) => ({
  id: 81, return_id: returnId, sale_item_id: 19, inventory_id: 'lot-a',
  drug_id: 4, trade_name_ar: 'Drug', trade_name_en: 'Drug EN',
  quantity_returned: 1, unit_price: 13, unit: 'small', total_price: 13,
});

describe('sales returns history uses trusted native projections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    session = { id: 'returner-a', pharmacy_id: 'tenant-a', role: 'cashier',
      permissions: { can_view_returns: true } };
    select.mockImplementation(() => { throw Error('PRIVATE generic renderer SQL rejected'); });
    get.mockImplementation(() => { throw Error('PRIVATE generic renderer SQL rejected'); });
    invoke.mockImplementation(async (command: string, args: any) => {
      if (command !== 'db_read_scoped') throw Error('Unexpected command');
      if (args.queryId === 'returns.list') {
        return args.offset === 0
          ? [owned('r1', '2026-10-16 11:00:00'), owned('r2', '2026-10-15 11:00:00')]
          : [];
      }
      if (args.queryId === 'returns.list_items') return [item(args.recordId)];
      throw Error('Native returns history projection missing');
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('pages searched native history and associates only matching proven lines', async () => {
    const res = await getReturnsAction({ limit: 1, offset: 0, search: 'r' });
    expect(res).toMatchObject({ success: true, hasMore: true, data: [{
      id: 'r1', invoice_id: 'sale-r1', pharmacy_id: 'tenant-a',
      items: [{ return_id: 'r1', inventory_id: 'lot-a', quantity_returned: 1 }],
    }] });
    expect(res.data).toHaveLength(1);
    expect(invoke).toHaveBeenNthCalledWith(1, 'db_read_scoped', {
      queryId: 'returns.list', recordId: null, limit: 2, offset: 0,
      search: 'r', drugId: null,
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'db_read_scoped', {
      queryId: 'returns.list_items', recordId: 'r1', limit: 200, offset: 0,
      search: null, drugId: null,
    });
    expect(select).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    for (const [, args] of invoke.mock.calls) {
      expect(args).not.toHaveProperty('sql');
      expect(args).not.toHaveProperty('pharmacyId');
      expect(args).not.toHaveProperty('actorId');
    }
  });

  it('rejects legacy, foreign, malformed and detached rows rather than displaying false ownership', async () => {
    for (const invalid of [
      { ...owned('r1', '2026-10-16'), pharmacy_id: null },
      { ...owned('r1', '2026-10-16'), pharmacy_id: 'tenant-b' },
      { ...owned('r1', '2026-10-16'), total_refund: null },
      { ...owned('r1', '2026-10-16'), item_count: 2 },
    ]) {
      invoke.mockImplementation(async (_command: string, args: any) =>
        args.queryId === 'returns.list' ? [invalid] : [item('r1')]);
      expect((await getReturnsAction()).success).toBe(false);
    }
    invoke.mockImplementation(async (_command: string, args: any) =>
      args.queryId === 'returns.list' ? [owned('r1', '2026-10-16')] : [item('r2')]);
    expect((await getReturnsAction()).success).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('fails closed on native denial, partial pages and excessive pagination', async () => {
    invoke.mockRejectedValue(new Error('Native return ownership denied'));
    expect((await getReturnsAction()).success).toBe(false);
    invoke.mockRejectedValue(new Error('Native return history contains unverified tenant-owned records'));
    expect(await getReturnsAction()).toMatchObject({
      success: false, error: 'يحتوي سجل المرتجعات على معاملات لم يتم التحقق من مصدرها أو ملكيتها',
    });
    invoke.mockResolvedValue([owned('r1', '2026-10-16'), owned('r2', '2026-10-15')]);
    expect((await getReturnsAction({ limit: 1 })).success).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('requires an explicit tenant and current permission before calling native', async () => {
    session.pharmacy_id = 'local_default';
    expect((await getReturnsAction()).success).toBe(false);
    session.pharmacy_id = 'tenant-a';
    session.permissions.can_view_returns = false;
    expect(await getReturnsAction()).toMatchObject({ success: false, error: 'غير مصرح' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
