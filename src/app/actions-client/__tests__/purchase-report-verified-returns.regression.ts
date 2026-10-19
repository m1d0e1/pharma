/** @jest-environment node */
const invoke = jest.fn();
const select = jest.fn();
let actor: any;

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => invoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => select(...args), dbGet: jest.fn(), dbExecute: jest.fn(),
  dbTransaction: jest.fn(), generateId: jest.fn(), normalizeDatabaseTimestamps: (v: any) => v,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: async () => actor,
  hasUserPermissionSync: (u: any, p: string) => Boolean(u?.permissions?.[p]),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { updateDrug: jest.fn() } }));

import { getPurchasesReportsAction } from '../purchases';

const invoice = { id: 'purchase-a', pharmacy_id: 'tenant-a', invoice_number: 'A-462',
  invoice_date: '2026-10-15', status: 'completed', total_amount: 462,
  gross_amount: 462, discount_amount: 0, total_selling_amount: 600 };
const provenReturn = { return_id: 'return-a', purchase_invoice_id: 'purchase-a',
  amount_cents: 11550 };

describe('tenant-scoped verified purchase return adjustment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    actor = { id: 'reporter-a', pharmacy_id: 'tenant-a',
      permissions: { rep_can_view_purchases: true } };
    select.mockImplementation(() => { throw Error('Private generic SQL denied'); });
    invoke.mockImplementation(async (command: string, args: any) => {
      if (command !== 'db_read_scoped') throw Error('Unrecognized native command');
      if (args.queryId === 'purchases.reports') return [invoice];
      if (args.queryId === 'purchases.report_return_adjustments') return [provenReturn];
      throw Error('Unrecognized fixed query ID');
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('keeps original purchase and nets immutable posted returns regardless of return date', async () => {
    const res = await getPurchasesReportsAction({ startDate: '2026-10-15', endDate: '2026-10-15' });
    expect(res).toMatchObject({ success: true, totalCost: 462, totalReturns: 115.5,
      totalAfterReturns: 346.5, data: [{ id: 'purchase-a', total_amount: 462,
        returned_amount: 115.5, net_after_returns: 346.5 }] });
    expect(invoke.mock.calls.map(c => c[1].queryId)).toEqual([
      'purchases.reports', 'purchases.report_return_adjustments',
    ]);
    expect(select).not.toHaveBeenCalled();
    expect(invoke.mock.calls.every(c => !('pharmacyId' in c[1]) && !('sql' in c[1]))).toBe(true);
  });

  it('fails closed on a refused or incomplete native return attestation', async () => {
    invoke.mockImplementation(async (_command: string, args: any) => {
      if (args.queryId === 'purchases.reports') return [invoice];
      throw Error('Unverified tenant-owned purchase return');
    });
    expect((await getPurchasesReportsAction()).success).toBe(false);
    invoke.mockImplementation(async (_command: string, args: any) =>
      args.queryId === 'purchases.reports' ? [invoice] : [
        { ...provenReturn, amount_cents: 47000 },
      ]);
    expect((await getPurchasesReportsAction()).success).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it('rejects duplicate or untrusted return rows and leaves other invoice cohorts unaltered', async () => {
    invoke.mockImplementation(async (_command: string, args: any) =>
      args.queryId === 'purchases.reports' ? [invoice] : [provenReturn, provenReturn]);
    expect((await getPurchasesReportsAction()).success).toBe(false);
    invoke.mockImplementation(async (_command: string, args: any) =>
      args.queryId === 'purchases.reports' ? [invoice] : [
        { ...provenReturn, amount_cents: null },
      ]);
    expect((await getPurchasesReportsAction()).success).toBe(false);
  });

  it('selects invoice dates as a cohort while excluding other invoice returns and payment balances', async () => {
    invoke.mockImplementation(async (_command: string, args: any) => {
      if (args.queryId === 'purchases.reports') {
        expect(JSON.parse(args.recordId)).toMatchObject({
          startDate: '2026-10-15', endDate: '2026-10-15', status: 'completed',
        });
        return [invoice];
      }
      expect(args.recordId).toBeNull();
      expect(args.search).toBeNull();
      return [provenReturn, { return_id: 'return-b', purchase_invoice_id: 'purchase-b', amount_cents: 7000 }];
    });
    const res = await getPurchasesReportsAction({ startDate: '2026-10-15', endDate: '2026-10-15' });
    expect(res).toMatchObject({ success: true, totalCost: 462, totalReturns: 115.5,
      totalAfterReturns: 346.5, invoiceCount: 1, data: [
        { total_amount: 462, returned_amount: 115.5, net_after_returns: 346.5 },
      ] });
    expect(JSON.stringify(res)).not.toContain('321.5');
    expect(JSON.stringify(res)).not.toContain('purchase-b');
    expect(select).not.toHaveBeenCalled();
  });

  it('denies any native report row assigned to a foreign or unowned tenant', async () => {
    for (const pharmacy_id of ['tenant-b', null, 'local_default']) {
      invoke.mockImplementation(async (_command: string, args: any) =>
        args.queryId === 'purchases.reports' ? [{ ...invoice, pharmacy_id }] : [provenReturn]);
      expect((await getPurchasesReportsAction()).success).toBe(false);
    }
  });

  it('rejects duplicate invoice rows and altered source amount before computing totals', async () => {
    for (const invoices of [
      [invoice, invoice],
      [{ ...invoice, total_amount: NaN }],
      [{ ...invoice, total_amount: 462.001 }],
    ]) {
      invoke.mockImplementation(async (_command: string, args: any) =>
        args.queryId === 'purchases.reports' ? invoices : [provenReturn]);
      expect((await getPurchasesReportsAction()).success).toBe(false);
    }
  });

  it('combines multiple valid returns across a bounded native page boundary without showing unrelated invoices', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      return_id: `return-unselected-${index}`, purchase_invoice_id: 'invoice-unselected', amount_cents: 1,
    }));
    invoke.mockImplementation(async (_command: string, args: any) => {
      if (args.queryId === 'purchases.reports') return [invoice];
      return args.offset === 0 ? firstPage : [
        { ...provenReturn, return_id: 'return-1', amount_cents: 10000 },
        { ...provenReturn, return_id: 'return-2', amount_cents: 1550 },
      ];
    });
    const res = await getPurchasesReportsAction();
    expect(res).toMatchObject({ success: true, totalCost: 462, totalReturns: 115.5,
      totalAfterReturns: 346.5, data: [{ returned_amount: 115.5, net_after_returns: 346.5 }] });
    expect(invoke.mock.calls.filter(call => call[1].queryId === 'purchases.report_return_adjustments')
      .map(call => call[1].offset)).toEqual([0, 200]);
    expect(JSON.stringify(res)).not.toContain('invoice-unselected');
  });

  it('fails closed if a later return page is unavailable rather than reporting a partial adjustment', async () => {
    const page = Array.from({ length: 200 }, (_, index) => ({
      return_id: `return-${index}`, purchase_invoice_id: 'purchase-a', amount_cents: 1,
    }));
    invoke.mockImplementation(async (_command: string, args: any) => {
      if (args.queryId === 'purchases.reports') return [invoice];
      if (args.offset === 0) return page;
      throw Error('Native return page unavailable');
    });
    expect((await getPurchasesReportsAction()).success).toBe(false);
    expect(select).not.toHaveBeenCalled();
  });
});
