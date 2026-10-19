/** Desktop cash posting must never use generic SQL, including on IPC failure. */
const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
const mockDbExecute = jest.fn();
const mockDbTransaction = jest.fn();
const mockGenerateId = jest.fn(() => 'renderer-selected-id');
let mockSession: any;
let mockPermissions: Record<string, boolean>;

jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockDbSelect(...args),
  dbGet: jest.fn(),
  dbExecute: (...args: unknown[]) => mockDbExecute(...args),
  dbTransaction: (...args: unknown[]) => mockDbTransaction(...args),
  generateId: () => mockGenerateId(),
  normalizeDatabaseTimestamps: (rows: unknown[]) => rows,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: () => Promise.resolve(mockSession),
  hasUserPermissionSync: (_user: unknown, permission: string) => !!mockPermissions[permission],
}));
jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(),
  getShiftForPharmacy: jest.fn(),
}));

import { createCashMovementAction } from '@/app/actions-client/finance';

const cash = () => ({
  type: 'disbursement' as const,
  category: 'operating_expenses',
  sub_category: 'UTIL',
  amount: 7.25,
  source_type: 'manual',
  target_name: 'Supplier One',
  notes: 'مرافق',
  date: '2026-10-11',
  actual_date: '2026-10-10',
  shift_id: 'closed-or-foreign-shift',
});

describe('typed native cash movement posting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { id: 'stale-renderer-actor', role: 'owner', pharmacy_id: 'claimed-foreign-pharmacy' };
    mockPermissions = { acc_can_process_cash_flow: true };
  });

  it('sends typed scalar business fields only and returns native generated ID', async () => {
    mockInvoke.mockResolvedValueOnce({ id: 'native-id', journalId: 'native-journal', shiftId: 'native-shift' });
    expect(await createCashMovementAction(cash())).toEqual({ success: true, id: 'native-id' });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('create_cash_movement_native', {
      payload: {
        movementType: 'disbursement', category: 'operating_expenses',
        subCategory: 'UTIL', amount: 7.25, sourceType: 'manual',
        targetName: 'Supplier One', notes: 'مرافق',
        date: '2026-10-11', actualDate: '2026-10-10',
        shiftId: 'closed-or-foreign-shift',
      },
    });
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toContain('claimed-foreign-pharmacy');
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toContain('stale-renderer-actor');
    expect(mockGenerateId).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('validates a caller retry nonce while the native cash DTO has no request ID field', async () => {
    const request_id = 'd2d2eb8a-6421-4a94-8a8e-0be50a838235';
    mockInvoke.mockResolvedValueOnce({ id: 'native-id', journalId: 'native-journal', shiftId: 'native-shift' });
    expect((await createCashMovementAction({ ...cash(), request_id })).success).toBe(true);
    expect(mockInvoke.mock.calls[0][1].payload).not.toHaveProperty('requestId');
    expect(mockGenerateId).not.toHaveBeenCalled();
    expect((await createCashMovementAction({ ...cash(), request_id: 'not-a-uuid' })).success).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('refuses injected transactions before invoking native, without detached journal or SQL', async () => {
    const transaction = { prepare: jest.fn() } as any;
    const result = await createCashMovementAction(cash(), transaction);
    expect(result.success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(transaction.prepare).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('does not fall back to a generic transaction after an authorization or registration failure', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('native permission denied'));
    const result = await createCashMovementAction(cash());
    expect(result).toMatchObject({ success: false, error: 'native permission denied' });
    expect(mockDbExecute).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockGenerateId).not.toHaveBeenCalled();
  });

  it('rejects unrecognized or incomplete native posting acknowledgment', async () => {
    mockInvoke.mockResolvedValueOnce({ id: 'unexpected-id' });
    expect((await createCashMovementAction(cash())).success).toBe(false);
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('validates the cash schema and rejects non-finite amounts and forbidden types locally', async () => {
    for (const bad of [NaN, Infinity, -2, 0]) {
      expect((await createCashMovementAction({ ...cash(), amount: bad })).success).toBe(false);
    }
    expect((await createCashMovementAction({ ...cash(), type: 'refund' as any })).success).toBe(false);
    expect((await createCashMovementAction({ ...cash(), date: '2026-02-30' })).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('allows expense-definition writer permission but rejects unrelated or missing sessions', async () => {
    mockPermissions = { acc_can_define_expenses: true };
    mockInvoke.mockResolvedValueOnce({ id: 'native-expense', journalId: 'journal', shiftId: 'shift' });
    expect((await createCashMovementAction(cash())).success).toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect((await createCashMovementAction({ ...cash(), type: 'receipt' })).success).toBe(false);
    mockPermissions = {};
    expect((await createCashMovementAction(cash())).success).toBe(false);
    mockSession = null;
    expect((await createCashMovementAction(cash())).success).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});
