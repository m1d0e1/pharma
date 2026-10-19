/** @jest-environment node */
const mockInvoke = jest.fn();
const mockGenericSql = jest.fn((..._args: unknown[]) => { throw new Error('Strict renderer SQL denied'); });
let mockSession: any;
const nativePage = (rows: any[], pharmacyId = 'tenant-a', actorId = 'owner-a') => ({ actorId, pharmacyId, rows });
const account = (id: number, code: string, type: string, is_group: number, debit = 0, credit = 0) => ({
  id, code, name_ar: `حساب ${code}`, name_en: `Account ${code}`, type, is_group,
  parent_id: is_group || type === 'revenue' ? null : 1, debit, credit,
  balance: type === 'asset' || type === 'expense' ? debit - credit : credit - debit,
});
const trial = (id: number, code: string, type: string, is_group: number, overrides: any = {}) => ({
  id, code, name_ar: `حساب ${code}`, name_en: `Account ${code}`, type, is_group,
  parent_id: is_group || type === 'revenue' ? null : 1,
  opening_debit: 0, opening_credit: 0, period_debit: 0, period_credit: 0,
  total_debit: 0, total_credit: 0, ...overrides,
});

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockGenericSql(...args),
  dbGet: (...args: unknown[]) => mockGenericSql(...args),
  dbExecute: (...args: unknown[]) => mockGenericSql(...args),
  dbTransaction: (...args: unknown[]) => mockGenericSql(...args),
  generateId: jest.fn(), normalizeDatabaseTimestamps: (rows: unknown[]) => rows,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: (user: any, key: string) => Boolean(user?.permissions?.[key]),
}));
jest.mock('@/app/actions-client/shifts', () => ({ ensurePermanentShiftForUser: jest.fn(), getShiftForPharmacy: jest.fn() }));

import { getAccountsAction, getTrialBalanceAction } from '@/app/actions-client/finance';

beforeEach(() => {
  jest.clearAllMocks();
  mockSession = { id: 'owner-a', role: 'owner', pharmacy_id: 'untrusted-renderer-pharmacy', permissions: {
    acc_can_view_general: true, acc_can_view_reports: true,
  } };
});

it('loads full owned account chart and derives parent balance from native leaf totals', async () => {
  mockInvoke.mockResolvedValueOnce(nativePage([
    account(1, '1', 'asset', 1),
    account(2, '1.1', 'asset', 0, 30, 5),
    account(3, '3.1', 'revenue', 0, 2, 27),
  ]));
  const result = await getAccountsAction();
  expect(result.success).toBe(true);
  expect(result.data).toEqual([
    expect.objectContaining({ id: 1, code: '1', is_group: 1, balance: 25 }),
    expect.objectContaining({ id: 2, code: '1.1', balance: 25 }),
    expect.objectContaining({ id: 3, code: '3.1', balance: 25 }),
  ]);
  expect(mockInvoke).toHaveBeenCalledWith('finance_read_projection', {
    queryId: 'accounts_chart', limit: 200, offset: 0,
  });
  expect(JSON.stringify(mockInvoke.mock.calls)).not.toContain('untrusted-renderer-pharmacy');
  expect(mockGenericSql).not.toHaveBeenCalled();
});

it('preserves opening/period/cumulative debits and credits from typed tenant-owned trial balance', async () => {
  mockInvoke.mockResolvedValueOnce(nativePage([
    trial(1, '1', 'asset', 1),
    trial(2, '1.1', 'asset', 0, {
      opening_debit: 4, opening_credit: 1, period_debit: 25, period_credit: 2,
      total_debit: 29, total_credit: 3,
    }),
    trial(3, '3.1', 'revenue', 0, { total_debit: 3, total_credit: 29 }),
  ]));
  const result = await getTrialBalanceAction('2026-10-01', '2026-10-10');
  expect(result.success).toBe(true);
  expect(result.data).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 2, opening_net_debit: 3, opening_net_credit: 0, net_debit: 26, net_credit: 0, period_debit: 25 }),
    expect.objectContaining({ id: 3, net_credit: 26, net_debit: 0 }),
  ]));
  expect(mockInvoke).toHaveBeenCalledWith('finance_read_projection', {
    queryId: 'trial_balance', dateFrom: '2026-10-01', dateTo: '2026-10-10', limit: 200, offset: 0,
  });
  expect(mockGenericSql).not.toHaveBeenCalled();
});

it('rejects denied, local_default, missing chart, and malformed native acknowledgements without false-zero success or renderer SQL fallback', async () => {
  mockInvoke.mockRejectedValueOnce('Unreconciled legacy journal ownership');
  expect((await getTrialBalanceAction()).success).toBe(false);
  mockInvoke.mockResolvedValueOnce(nativePage([account(1, '1', 'asset', 1)], 'local_default'));
  expect((await getAccountsAction()).success).toBe(false);
  mockInvoke.mockResolvedValueOnce(nativePage([]));
  expect((await getAccountsAction()).success).toBe(false);
  mockInvoke.mockResolvedValueOnce(nativePage([{ id: 1, code: '1', name_ar: 'Incomplete' }]));
  expect((await getTrialBalanceAction()).success).toBe(false);
  expect(mockGenericSql).not.toHaveBeenCalled();
});

it('rejects swapped source actors/scopes mid-page, invalid dates and missing local permission', async () => {
  mockInvoke.mockResolvedValueOnce(nativePage([account(1, '1', 'asset', 1)], 'tenant-a', 'another-actor'));
  expect((await getAccountsAction()).success).toBe(false);
  expect((await getTrialBalanceAction('2026-02-31')).success).toBe(false);
  expect(mockInvoke).toHaveBeenCalledTimes(1);
  mockSession.permissions = {};
  expect((await getAccountsAction()).success).toBe(false);
  expect((await getTrialBalanceAction()).success).toBe(false);
  expect(mockGenericSql).not.toHaveBeenCalled();
});
