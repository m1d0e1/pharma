const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
const mockDbGet = jest.fn();
let mockSession: any = { id: 'owner-a', role: 'owner', pharmacy_id: 'untrusted-renderer-pharmacy' };
let mockHasPermission = true;
const nativePage = (rows: any[], pharmacyId = 'live-a', actorId = 'owner-a') => ({
  rows, pharmacyId, actorId,
});

jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockDbSelect(...args),
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(),
  normalizeDatabaseTimestamps: (rows: unknown[]) => rows,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: () => Promise.resolve(mockSession),
  hasUserPermissionSync: () => mockHasPermission,
}));
jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(),
  getShiftForPharmacy: jest.fn(),
}));
jest.mock('@/lib/env', () => ({ isTauri: true }));

import {
  getCashMovementsAction,
  getJournalsAction,
  getJournalDetailsAction,
} from '@/app/actions-client/finance';

describe('native finance ledger read boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { id: 'owner-a', role: 'owner', pharmacy_id: 'untrusted-renderer-pharmacy' };
    mockHasPermission = true;
  });

  it('reads typed cash movement pages with filters without passing renderer pharmacy or SQL', async () => {
    mockInvoke
      .mockResolvedValueOnce(nativePage(Array.from({ length: 200 }, (_, index) => ({ id: `cash-${index}`, amount: 1 }))))
      .mockResolvedValueOnce(nativePage([{ id: 'cash-200', amount: 2 }]));

    const result = await getCashMovementsAction({
      type: 'receipt', category: 'collection', dateFrom: '2026-10-01', dateTo: '2026-10-11',
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(201);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'finance_read_projection', {
      queryId: 'cash_movements', movementType: 'receipt', category: 'collection',
      dateFrom: '2026-10-01', dateTo: '2026-10-11', limit: 200, offset: 0,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'finance_read_projection', {
      queryId: 'cash_movements', movementType: 'receipt', category: 'collection',
      dateFrom: '2026-10-01', dateTo: '2026-10-11', limit: 200, offset: 200,
    });
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toContain('untrusted-renderer-pharmacy');
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
  });

  it('preserves journal balances and rejects foreign details as an empty list from native boundary', async () => {
    mockInvoke
      .mockResolvedValueOnce(nativePage([{ id: 'j-a', total_amount: 12.5 }]))
      .mockResolvedValueOnce(nativePage([]))
      .mockResolvedValueOnce(nativePage([
        { journal_id: 'j-a', type: 'debit', amount: 12.5, debit: 12.5, credit: 0 },
        { journal_id: 'j-a', type: 'credit', amount: 12.5, debit: 0, credit: 12.5 },
      ]));
    const journals = await getJournalsAction({ dateFrom: '2026-10-01' });
    expect(journals.data).toEqual([{ id: 'j-a', total_amount: 12.5 }]);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'finance_read_projection', {
      queryId: 'journals', dateFrom: '2026-10-01', limit: 200, offset: 0,
    });
    expect((await getJournalDetailsAction('foreign-id')).data).toEqual([]);
    const details = await getJournalDetailsAction('j-a');
    expect(details.data?.reduce((sum: number, entry: any) => sum + entry.debit, 0)).toBe(12.5);
    expect(details.data?.reduce((sum: number, entry: any) => sum + entry.credit, 0)).toBe(12.5);
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'finance_read_projection', {
      queryId: 'journal_entries', journalId: 'foreign-id', limit: 200, offset: 0,
    });
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('fails closed on native error without a generic renderer SQL fallback', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Not registered / native permission denied'));
    const result = await getCashMovementsAction();
    expect(result.success).toBe(false);
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
  });

  it('refuses stale local permission or missing session before IPC', async () => {
    mockHasPermission = false;
    expect((await getJournalsAction()).success).toBe(false);
    mockSession = null;
    mockHasPermission = true;
    expect((await getCashMovementsAction()).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('rejects overflowing 10,000-row lists instead of rendering partial accounting totals', async () => {
    const full = Array.from({ length: 200 }, (_, index) => ({ id: `id-${index}`, amount: 1 }));
    mockInvoke.mockImplementation((_: string, args: { offset: number }) =>
      Promise.resolve(nativePage(args.offset === 10_000 ? [{ id: 'overflow' }] : full)));
    const result = await getCashMovementsAction();
    expect(result.success).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(51);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('fails closed if the signed-in actor or live pharmacy changes between pages', async () => {
    const full = Array.from({ length: 200 }, (_, index) => ({ id: `cash-${index}` }));
    mockInvoke
      .mockResolvedValueOnce(nativePage(full, 'ph-a'))
      .mockResolvedValueOnce(nativePage([{ id: 'foreign' }], 'ph-b'));
    expect((await getCashMovementsAction()).success).toBe(false);
    expect(mockDbSelect).not.toHaveBeenCalled();
    mockInvoke.mockReset()
      .mockResolvedValueOnce(nativePage(full, 'ph-a', 'owner-a'))
      .mockResolvedValueOnce(nativePage([{ id: 'other-actor' }], 'ph-a', 'owner-b'));
    expect((await getJournalsAction()).success).toBe(false);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});
