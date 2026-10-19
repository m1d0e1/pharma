/** @jest-environment node */

const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
let actor: any;

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockDbSelect(...args),
  dbExecute: jest.fn(), dbGet: jest.fn(), dbTransaction: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => actor,
  hasUserPermissionSync: (user: any, key: string) => !!user?.permissions?.[key],
}));

import { getSalesReportsAction } from '../sales-reports';

const sale = (id: string, extra: Record<string, unknown> = {}) => ({
  id, pharmacy_id: 'tenant-a', user_id: 'seller-a', patient_id: null,
  total_amount: 300, discount_amount: 0, status: 'completed',
  payment_method: 'cash', created_at: '2026-10-10 11:00:00', ...extra,
});
const refund = (id: string, invoiceId = 'sale-a', extra: Record<string, unknown> = {}) => ({
  id, invoice_id: invoiceId, pharmacy_id: 'tenant-a', user_id: 'returner-a',
  status: 'completed', refund_method: 'cash', total_refund: 150,
  item_count: 1, invoice_total: 300, invoice_date: '2026-10-10 11:00:00',
  created_at: '2026-10-16 13:00:00', ...extra,
});

describe('native sales report joins immutable verified return receipts', () => {
  let invoicePages: unknown[][];
  let returnPages: unknown[][];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    actor = { id: 'reporter-a', pharmacy_id: 'tenant-a', role: 'owner',
      permissions: { rep_can_view_sales: true, can_view_returns: true } };
    invoicePages = [[sale('sale-a')]];
    returnPages = [[refund('return-a')]];
    mockInvoke.mockImplementation(async (command: string, args: any) => {
      if (command !== 'db_read_scoped') throw Error('Unexpected command');
      if (args.queryId === 'sales.invoices') return invoicePages[args.offset / 200] || [];
      if (args.queryId === 'returns.list') return returnPages[args.offset / 200] || [];
      throw Error('Unknown native projection');
    });
    mockDbSelect.mockImplementation(() => { throw Error('Renderer SQL is forbidden'); });
  });

  afterEach(() => jest.restoreAllMocks());

  it('reduces a tenant-owned 300 invoice by its native 150 cash refund even when returned after the invoice date window', async () => {
    const result = await getSalesReportsAction({ startDate: '2026-10-10', endDate: '2026-10-10' });
    expect(result).toMatchObject({ success: true, data: [{
      id: 'sale-a', total_amount: 300, refunded_amount: 150,
    }] });
    expect(mockInvoke).toHaveBeenCalledWith('db_read_scoped', {
      queryId: 'returns.list', recordId: null, search: null,
      drugId: null, limit: 200, offset: 0,
    });
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('treats all completed, verified return pages as one invoice refund and excludes unrelated invoice dates', async () => {
    invoicePages = [[sale('sale-a'), sale('old-sale', { created_at: '2026-09-01 11:00:00' })]];
    const first = Array.from({ length: 200 }, (_, i) =>
      refund('ret-' + i, 'old-sale', { total_refund: 1, invoice_total: 300,
        invoice_date: '2026-09-01 11:00:00' }));
    returnPages = [first, [refund('return-a', 'sale-a', { total_refund: 125 }),
      refund('return-b', 'sale-a', { total_refund: 25 })]];
    const result = await getSalesReportsAction({ startDate: '2026-10-10', endDate: '2026-10-10' });
    expect(result).toMatchObject({ success: true, data: [{
      id: 'sale-a', refunded_amount: 150,
    }] });
    expect((result as any).data).toHaveLength(1);
    expect(mockInvoke.mock.calls.filter(([, args]: any) => args.queryId === 'returns.list')
      .map(([, args]: any) => args.offset)).toEqual([0, 200]);
  });

  it('rejects unmatched, cross-tenant, mismatched invoice provenance and bogus financial rows', async () => {
    const invalid = [
      refund('return-a', 'orphan'),
      refund('return-a', 'sale-a', { pharmacy_id: 'tenant-b' }),
      refund('return-a', 'sale-a', { pharmacy_id: 'local_default' }),
      refund('return-a', 'sale-a', { invoice_total: 999 }),
      refund('return-a', 'sale-a', { invoice_date: '2026-09-10 11:00:00' }),
      refund('return-a', 'sale-a', { total_refund: -1 }),
      refund('return-a', 'sale-a', { total_refund: Number.POSITIVE_INFINITY }),
      refund('return-a', 'sale-a', { total_refund: '150' }),
      refund('return-a', 'sale-a', { status: 'pending' }),
      refund('return-a', 'sale-a', { item_count: 0 }),
    ];
    for (const row of invalid) {
      returnPages = [[row]];
      expect(await getSalesReportsAction({})).toEqual({ success: false, error: 'فشل جلب تقرير المبيعات' });
    }
  });

  it('rejects duplicated return IDs, over-refunding and invalid invoice amounts', async () => {
    for (const rows of [
      [refund('duplicate'), refund('duplicate')],
      [refund('first', 'sale-a', { total_refund: 170 }), refund('second', 'sale-a', { total_refund: 150 })],
    ]) {
      returnPages = [rows];
      expect((await getSalesReportsAction({})).success).toBe(false);
    }
    returnPages = [[refund('return-a')]];
    invoicePages = [[sale('sale-a', { total_amount: -300 })]];
    expect((await getSalesReportsAction({})).success).toBe(false);
  });

  it('rejects denied native history, malformed pages and missing final pagination page', async () => {
    mockInvoke.mockRejectedValueOnce(Error('Native returns history contains unverified tenant-owned records'));
    expect((await getSalesReportsAction({})).success).toBe(false);
    mockInvoke.mockImplementation(async (_command: string, args: any) =>
      args.queryId === 'sales.invoices' ? [sale('sale-a')] : null);
    expect((await getSalesReportsAction({})).success).toBe(false);
    mockInvoke.mockImplementation(async (_command: string, args: any) =>
      args.queryId === 'sales.invoices' ? [sale('sale-a')] :
        Array.from({ length: 200 }, (_, i) => refund('r' + i, 'sale-a', { total_refund: 0 })));
    expect((await getSalesReportsAction({})).success).toBe(false);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('keeps refund unknown for reporters without separate return-history access', async () => {
    actor.permissions.can_view_returns = false;
    const result = await getSalesReportsAction({});
    expect(result).toMatchObject({ success: true, data: [{ refunded_amount: null }] });
    expect(mockInvoke.mock.calls.map(([, args]: any) => args.queryId)).toEqual(['sales.invoices']);
  });
});
