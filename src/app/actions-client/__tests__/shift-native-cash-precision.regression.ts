/** @jest-environment node */
const nativeInvoke = jest.fn();
const forbiddenSql = jest.fn((..._args: unknown[]) => { throw new Error('Renderer SQL forbidden in desktop shift writes'); });

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => nativeInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => forbiddenSql(...args),
  dbGet: (...args: unknown[]) => forbiddenSql(...args),
  dbExecute: (...args: unknown[]) => forbiddenSql(...args),
  dbTransaction: (...args: unknown[]) => forbiddenSql(...args),
  generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(() => { throw new Error('Renderer identity forbidden'); }),
  hasUserPermissionSync: jest.fn(),
}));

import { openShiftAction, closeShiftAction } from '../shifts';

describe('desktop shift opening and closing require exact finite cents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    nativeInvoke.mockImplementation(async (command: string) => {
      if (command === 'open_shared_shift_native') return { shift_id: 'owned-shift', already_open: false };
      if (command === 'close_shared_shift_native') return undefined;
      throw Error('Unexpected native shift command');
    });
  });

  it('rejects fractional cents and invalid floats before a shift can be opened or closed', async () => {
    for (const invalid of [20.001, -0.01, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect((await openShiftAction({ starting_cash_amount: invalid })).success).toBe(false);
      expect((await closeShiftAction({ shift_id: 'owned-shift', ending_cash_amount: invalid })).success).toBe(false);
    }
    expect(nativeInvoke).not.toHaveBeenCalled();
    expect(forbiddenSql).not.toHaveBeenCalled();
  });

  it('preserves exact cents and delegates authorization/tenant ownership to native IPC', async () => {
    expect((await openShiftAction({ starting_cash_amount: 25.13 })).success).toBe(true);
    expect((await closeShiftAction({ shift_id: 'owned-shift', ending_cash_amount: 25.13 })).success).toBe(true);
    expect(nativeInvoke).toHaveBeenNthCalledWith(1, 'open_shared_shift_native', {
      payload: { startingCashAmount: 25.13, openingNotes: null },
    });
    expect(nativeInvoke).toHaveBeenNthCalledWith(2, 'close_shared_shift_native', {
      payload: { shiftId: 'owned-shift', endingCashAmount: 25.13, closingNotes: null },
    });
    expect(forbiddenSql).not.toHaveBeenCalled();
  });
});
