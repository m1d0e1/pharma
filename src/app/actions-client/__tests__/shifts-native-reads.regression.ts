/** @jest-environment node */

const nativeInvoke = jest.fn();
const dbSelect = jest.fn();
const dbGet = jest.fn();
const dbExecute = jest.fn();
const dbTransaction = jest.fn();
const getLocalSession = jest.fn();

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => nativeInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => dbSelect(...args),
  dbGet: (...args: unknown[]) => dbGet(...args),
  dbExecute: (...args: unknown[]) => dbExecute(...args),
  dbTransaction: (...args: unknown[]) => dbTransaction(...args),
  generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: (...args: unknown[]) => getLocalSession(...args),
  hasUserPermissionSync: jest.fn(),
}));

import {
  getCurrentShiftStatsAction,
  getShiftReceiptsAction,
  getShiftsAction,
} from '../shifts';

beforeEach(() => {
  jest.clearAllMocks();
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === 'get_shift_history_native') {
      return {
        rows: [{ id: 'trusted-shift', expected_cash_amount: 150, cash_difference: -5 }],
        has_more: true,
        next_page: 1,
      };
    }
    if (command === 'get_current_shift_stats_native') {
      return { id: 'trusted-shift', transactions: 4, revenue: 210, total_refunds: 5, expected_cash: 150 };
    }
    if (command === 'get_shift_receipts_native') {
      return [{
        id: 'invoice-1', patients: { full_name: 'Patient A', phone: '555' },
        sales_items: [{
          trade_name: 'Panadol',
          inventory: { master_drugs: { trade_name: 'Panadol' } },
        }],
      }];
    }
    throw Error('Unexpected native read command');
  });
});

it('reads shift history through a native page without forwarding identity or raw SQL', async () => {
  expect(await getShiftsAction({ status: 'closed' })).toEqual({
    success: true,
    data: [{ id: 'trusted-shift', expected_cash_amount: 150, cash_difference: -5 }],
    has_more: true,
    next_page: 1,
  });
  expect(await getShiftsAction({ status: 'all', page: 1 })).toMatchObject({ success: true });
  expect(nativeInvoke).toHaveBeenNthCalledWith(1, 'get_shift_history_native', {
    status: 'closed', page: 0,
  });
  expect(nativeInvoke).toHaveBeenNthCalledWith(2, 'get_shift_history_native', {
    status: 'all', page: 1,
  });
  expect(dbSelect).not.toHaveBeenCalled();
  expect(dbGet).not.toHaveBeenCalled();
  expect(getLocalSession).not.toHaveBeenCalled();
});

it('retains cash stats and nested receipt details returned by native trusted joins', async () => {
  expect(await getCurrentShiftStatsAction()).toEqual({
    success: true,
    data: { id: 'trusted-shift', transactions: 4, revenue: 210, total_refunds: 5, expected_cash: 150 },
  });
  expect((await getShiftReceiptsAction('trusted-shift')).data?.[0]).toMatchObject({
    patients: { full_name: 'Patient A', phone: '555' },
    sales_items: [{ inventory: { master_drugs: { trade_name: 'Panadol' } } }],
  });
  expect(nativeInvoke).toHaveBeenNthCalledWith(1, 'get_current_shift_stats_native');
  expect(nativeInvoke).toHaveBeenNthCalledWith(2, 'get_shift_receipts_native', { shiftId: 'trusted-shift' });
  expect(dbSelect).not.toHaveBeenCalled();
  expect(dbTransaction).not.toHaveBeenCalled();
  expect(dbExecute).not.toHaveBeenCalled();
});

it('returns native permission, invalid-id and stale-shift errors with no SQL fallback', async () => {
  const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  for (const [call, expectedCommand] of [
    [() => getShiftsAction({ status: 'all' }), 'get_shift_history_native'],
    [() => getCurrentShiftStatsAction(), 'get_current_shift_stats_native'],
    [() => getShiftReceiptsAction("foreign';--"), 'get_shift_receipts_native'],
  ] as const) {
    nativeInvoke.mockRejectedValueOnce(new Error('Native shift read denied'));
    expect(await call()).toMatchObject({ success: false });
    expect(nativeInvoke.mock.lastCall?.[0]).toEqual(expectedCommand);
  }
  errorLog.mockRestore();
  expect(dbSelect).not.toHaveBeenCalled();
  expect(dbGet).not.toHaveBeenCalled();
  expect(dbExecute).not.toHaveBeenCalled();
  expect(getLocalSession).not.toHaveBeenCalled();
});
