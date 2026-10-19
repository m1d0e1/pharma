/** @jest-environment node */
const mockInvoke = jest.fn();
const mockGenericSql = jest.fn((..._args: unknown[]) => { throw new Error('Strict renderer SQL denied'); });
const mockDrawerSnapshot = jest.fn(() => { throw new Error('Drawer SQL is not native scoped'); });
let mockSession: any;

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
jest.mock('@/lib/finance/drawer', () => ({ getOpenDrawerSnapshot: () => mockDrawerSnapshot() }));
jest.mock('@/app/actions-client/shifts', () => ({ ensurePermanentShiftForUser: jest.fn(), getShiftForPharmacy: jest.fn() }));

import { getTreasuryDashboardAction } from '@/app/actions-client/finance';

const nativePage = (rows: unknown[], pharmacyId = 'qa_lifecycle_20261016', actorId = 'owner-a') => ({ rows, pharmacyId, actorId });

beforeEach(() => {
  jest.clearAllMocks();
  mockSession = { id: 'owner-a', pharmacy_id: 'untrusted-local_default', permissions: { acc_can_view_general: true } };
});

it('reads native journal cash (150) without claiming unverified physical drawer or safe cash', async () => {
  mockInvoke.mockResolvedValueOnce(nativePage([{ ledger_cash_balance: 150 }]));

  const result = await getTreasuryDashboardAction();
  expect(result).toMatchObject({
    success: true,
    data: { ledgerCashBalance: 150, treasuryBalance: null, drawerBalance: null,
      todayReceipts: null, todayExpenses: null, totalShiftHandovers: null,
      drawerShiftId: null, counts: { treasury: null, receipts: null, expenses: null, handovers: null },
      detailCount: null, details: [] },
  });
  expect(mockInvoke).toHaveBeenCalledTimes(1);
  expect(mockInvoke).toHaveBeenCalledWith('finance_read_projection', {
    queryId: 'treasury_cash_ledger', limit: 200, offset: 0,
  });
  expect(JSON.stringify(mockInvoke.mock.calls)).not.toContain('untrusted-local_default');
  expect(mockGenericSql).not.toHaveBeenCalled();
  expect(mockDrawerSnapshot).not.toHaveBeenCalled();
});

it('refuses unverifiable native accounting, switched actor, local_default, and malformed ledger', async () => {
  mockInvoke.mockRejectedValueOnce('Unreconciled legacy journal ownership');
  expect((await getTreasuryDashboardAction()).success).toBe(false);
  mockInvoke.mockResolvedValueOnce(nativePage([{ ledger_cash_balance: 150 }], 'local_default'));
  expect((await getTreasuryDashboardAction()).success).toBe(false);
  mockInvoke.mockResolvedValueOnce(nativePage([{ ledger_cash_balance: 150 }], 'tenant-a', 'other-actor'));
  expect((await getTreasuryDashboardAction()).success).toBe(false);
  mockInvoke.mockResolvedValueOnce(nativePage([{ ledger_cash_balance: 0 }, { ledger_cash_balance: 150 }]));
  expect((await getTreasuryDashboardAction()).success).toBe(false);
  mockInvoke.mockResolvedValueOnce(nativePage([{ ledger_cash_balance: '150' }]));
  expect((await getTreasuryDashboardAction()).success).toBe(false);
  mockInvoke.mockResolvedValueOnce(nativePage([{ ledger_cash_balance: null }]));
  expect((await getTreasuryDashboardAction()).data?.ledgerCashBalance).toBeNull();
  expect(mockGenericSql).not.toHaveBeenCalled();
  expect(mockDrawerSnapshot).not.toHaveBeenCalled();
});

it('returns explicit detail unavailability and requires local cash permissions', async () => {
  const detail = await getTreasuryDashboardAction('treasury');
  expect(detail).toMatchObject({ success: false });
  expect(detail.error).toMatch(/غير متاح/);
  expect(mockInvoke).not.toHaveBeenCalled();
  mockSession.permissions = {};
  expect(await getTreasuryDashboardAction()).toMatchObject({ success: false, error: 'غير مصرح' });
  expect(mockInvoke).not.toHaveBeenCalled();
});
