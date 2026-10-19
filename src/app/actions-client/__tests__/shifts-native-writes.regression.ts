/** @jest-environment node */

const nativeInvoke = jest.fn();
const dbSelect = jest.fn();
const dbExecute = jest.fn();
const dbGet = jest.fn();
const dbTransaction = jest.fn();
const getLocalSession = jest.fn();
const hasUserPermissionSync = jest.fn();

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
  hasUserPermissionSync: (...args: unknown[]) => hasUserPermissionSync(...args),
}));

import {
  closeShiftAction,
  ensurePermanentShiftForUser,
  forceCloseAllShiftsAction,
  getCurrentShiftAction,
  getCurrentShiftStatsAction,
  getShiftForPharmacy,
  getShiftReceiptsAction,
  getShiftsAction,
  openShiftAction,
} from '../shifts';

beforeEach(() => {
  jest.clearAllMocks();
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === 'ensure_shared_shift_native') {
      return { id: 's-native', user_id: 'trusted-actor', start_time: '2026-10-11 09:00:00', starting_cash: 0, status: 'open' };
    }
    if (command === 'open_shared_shift_native') {
      return { shift_id: 's-native', already_open: false };
    }
    if (command === 'close_shared_shift_native') return undefined;
    if (command === 'force_close_pharmacy_shifts_native') return undefined;
    if (command === 'current_shared_shift_native') {
      return { shift: { id: 's-native',user_id: 'trusted-actor',start_time:'2026-10-11 09:00:00',starting_cash:25,status:'open' },
        suggested_starting_cash: 19 };
    }
    if (command === 'get_pharmacy_shift_native') {
      return { id:'s-native',user_id:'trusted-actor',start_time:'2026-10-11 09:00:00',starting_cash:25,status:'open' };
    }
    if (command === 'get_shift_history_native') return { rows: [], has_more: false, next_page: null };
    if (command === 'get_current_shift_stats_native') return {
      id: 's-native', transactions: 0, revenue: 0, expected_cash: 25,
    };
    if (command === 'get_shift_receipts_native') return [];
    throw new Error('Unexpected IPC command');
  });
});

it('ensures a pharmacy-wide shift without forwarding caller-supplied user/tenant/SQL', async () => {
  const result = await ensurePermanentShiftForUser("forged-actor'); DELETE FROM users; --");
  expect(result).toMatchObject({ id: 's-native', user_id: 'trusted-actor', starting_cash: 0 });
  expect(nativeInvoke).toHaveBeenCalledTimes(1);
  expect(nativeInvoke).toHaveBeenCalledWith('ensure_shared_shift_native');
  expect(dbSelect).not.toHaveBeenCalled();
  expect(dbExecute).not.toHaveBeenCalled();
  expect(dbTransaction).not.toHaveBeenCalled();
  expect(getLocalSession).not.toHaveBeenCalled();
});

it('opens using only cash/notes; no renderer actor or pharmacy can be claimed', async () => {
  expect(await openShiftAction({ starting_cash_amount: 25, opening_notes: 'بداية' })).toEqual({
    success: true, shiftId: 's-native', alreadyOpen: false,
  });
  expect(nativeInvoke).toHaveBeenCalledWith('open_shared_shift_native', {
    payload: { startingCashAmount: 25, openingNotes: 'بداية' },
  });
  expect(await openShiftAction({ starting_cash_amount: 10, user_id: 'foreign-staff' })).toMatchObject({
    success: false,
  });
  expect(nativeInvoke).toHaveBeenCalledTimes(1);
  expect(dbExecute).not.toHaveBeenCalled();
  expect(getLocalSession).not.toHaveBeenCalled();
});

it('closes a selected shift atomically through native command and preserves success response', async () => {
  expect(await closeShiftAction({
    shift_id: 'trusted-filter',
    ending_cash_amount: 154.5,
    closing_notes: 'تسوية',
  })).toEqual({ success: true });
  expect(nativeInvoke).toHaveBeenCalledWith('close_shared_shift_native', {
    payload: { shiftId: 'trusted-filter', endingCashAmount: 154.5, closingNotes: 'تسوية' },
  });
  expect(dbExecute).not.toHaveBeenCalled();
  expect(dbTransaction).not.toHaveBeenCalled();
});

it('emergency force-close uses only owner-authorized native IPC, not renderer SQL', async () => {
  expect(await forceCloseAllShiftsAction()).toEqual({ success: true });
  expect(nativeInvoke).toHaveBeenCalledWith('force_close_pharmacy_shifts_native');
  expect(nativeInvoke).toHaveBeenCalledTimes(1);
  expect(dbExecute).not.toHaveBeenCalled();
  expect(dbSelect).not.toHaveBeenCalled();
  expect(getLocalSession).not.toHaveBeenCalled();
});

it('resolves the current shift and selected shift from trusted native tenant state', async () => {
  expect(await getCurrentShiftAction()).toEqual({
    success: true,
    data: { id:'s-native',user_id:'trusted-actor',shift_start:'2026-10-11 09:00:00',
      starting_cash_amount:25,status:'open' },
    has_open_shift:true,suggested_starting_cash:19,
  });
  expect(await getShiftForPharmacy('s-native', 'forged-other-pharmacy', true)).toMatchObject({
    id:'s-native',user_id:'trusted-actor',
  });
  expect(nativeInvoke).toHaveBeenNthCalledWith(1,'current_shared_shift_native');
  expect(nativeInvoke).toHaveBeenNthCalledWith(2,'get_pharmacy_shift_native',{
    shiftId:'s-native',openOnly:true,
  });
  expect(dbSelect).not.toHaveBeenCalled();
  expect(dbGet).not.toHaveBeenCalled();
});

it('uses fixed native shift history, stats and receipts without generic SQL after migration', async () => {
  expect(await getShiftsAction({ status:'all' })).toMatchObject({ success:true, data:[] });
  expect(await getCurrentShiftStatsAction()).toMatchObject({ success:true, data:{ expected_cash:25 } });
  expect(await getShiftReceiptsAction('s-native')).toMatchObject({ success:true, data:[] });
  expect(dbSelect).not.toHaveBeenCalled();
  expect(dbGet).not.toHaveBeenCalled();
  expect(nativeInvoke).toHaveBeenNthCalledWith(1,'get_shift_history_native',{ status:'all',page:0 });
  expect(nativeInvoke).toHaveBeenNthCalledWith(2,'get_current_shift_stats_native');
  expect(nativeInvoke).toHaveBeenNthCalledWith(3,'get_shift_receipts_native',{ shiftId:'s-native' });
});

it('returns native tenant/permission/stale denials without a renderer SQL fallback', async () => {
  for (const message of [
    'Authenticated role cannot manage the shared pharmacy shift',
    'الوردية غير موجودة أو لا تخص هذه الصيدلية',
    'synthetic ledger failure',
  ]) {
    nativeInvoke.mockRejectedValueOnce(new Error(message));
    expect(await closeShiftAction({ shift_id: 'cross-tenant-shift', ending_cash_amount: 4 })).toEqual({
      success: false, error: message,
    });
  }
  nativeInvoke.mockRejectedValueOnce(new Error('Login required before changing pharmacy records'));
  await expect(ensurePermanentShiftForUser('spoof')).rejects.toThrow('Login required');
  expect(dbExecute).not.toHaveBeenCalled();
  expect(dbTransaction).not.toHaveBeenCalled();
});

it('rejects invalid cash and injected renderer transaction handles without falling back', async () => {
  expect(await openShiftAction({ starting_cash_amount: Number.POSITIVE_INFINITY })).toMatchObject({ success: false });
  expect(await closeShiftAction({ ending_cash_amount: -1 })).toMatchObject({ success: false });
  const rendererScopedTransaction = { prepare: jest.fn() };
  await expect(
    ensurePermanentShiftForUser('actor', 0, 'default', rendererScopedTransaction as any),
  ).rejects.toThrow('cannot run inside a renderer SQL transaction');
  expect(rendererScopedTransaction.prepare).not.toHaveBeenCalled();
  expect(nativeInvoke).not.toHaveBeenCalled();
  expect(dbExecute).not.toHaveBeenCalled();
});
