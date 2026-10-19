/** @jest-environment node */
const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
const mockDbGet = jest.fn();
const mockDbExecute = jest.fn();
const mockDbTransaction = jest.fn();
let mockIsTauri = true;

jest.mock('@/lib/env', () => ({ get isTauri() { return mockIsTauri; } }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockDbSelect(...args),
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbExecute: (...args: unknown[]) => mockDbExecute(...args),
  dbTransaction: (...args: unknown[]) => mockDbTransaction(...args),
  generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({
    id: 'untrusted-local-actor', role: 'owner', pharmacy_id: 'local-a',
  })),
  hasUserPermissionSync: jest.fn(() => true),
}));
jest.mock('@/app/actions-client/finance', () => ({
  createCashMovementAction: jest.fn(),
}));

import { getExpensesAction } from '@/app/actions-client/expenses';

const expense = (id: number) => ({
  id: `expense-${String(id).padStart(5, '0')}`,
  pharmacy_id: 'live-a',
  category: 'RENT',
  amount: 1.25,
  date: '2026-10-11',
});
const nativePage = (
  page: number, rows: any[], hasMore: boolean,
  pharmacyId = 'live-a', actorId = 'live-user',
) => ({ page, rows, hasMore, pharmacyId, actorId });

describe('bounded native expense history pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauri = true;
  });

  it('assembles all 245 expense rows in order through authenticated page DTOs', async () => {
    const rows = Array.from({ length: 245 }, (_, index) => expense(index));
    mockInvoke
      .mockResolvedValueOnce(nativePage(0, rows.slice(0, 200), true))
      .mockResolvedValueOnce(nativePage(1, rows.slice(200), false));
    const result = await getExpensesAction({
      from: '2026-10-01', to: '2026-10-31', category: 'RENT',
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(245);
    expect(result.data?.[0].id).toBe('expense-00000');
    expect(result.data?.[244].id).toBe('expense-00244');
    expect(result.data?.reduce((sum: number, row: any) => sum + row.amount, 0)).toBe(306.25);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'list_expenses_native', {
      filters: { from: '2026-10-01', to: '2026-10-31', category: 'RENT', page: 0 },
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'list_expenses_native', {
      filters: { from: '2026-10-01', to: '2026-10-31', category: 'RENT', page: 1 },
    });
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toContain('untrusted-local-actor');
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toContain('local-a');
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('fails closed without renderer SQL when active actor or pharmacy changes mid-history', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => expense(index));
    mockInvoke
      .mockResolvedValueOnce(nativePage(0, rows, true, 'a', 'user'))
      .mockResolvedValueOnce(nativePage(1, [expense(200)], false, 'b', 'user'));
    expect((await getExpensesAction()).success).toBe(false);
    mockInvoke.mockReset()
      .mockResolvedValueOnce(nativePage(0, rows, true, 'a', 'user'))
      .mockResolvedValueOnce(nativePage(1, [expense(200)], false, 'a', 'other-user'));
    expect((await getExpensesAction()).success).toBe(false);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('rejects malformed pages, duplicate records, or native authorization failures', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => expense(index));
    const badPages = [
      nativePage(1, [expense(0)], false),
      nativePage(0, rows.slice(0, 199), true),
      nativePage(0, [...rows, expense(200)], false),
      { rows: [], hasMore: false, page: 0 },
      [expense(0)],
    ];
    for (const response of badPages) {
      mockInvoke.mockReset().mockResolvedValueOnce(response);
      expect((await getExpensesAction()).success).toBe(false);
    }
    mockInvoke.mockReset()
      .mockResolvedValueOnce(nativePage(0, rows, true))
      .mockResolvedValueOnce(nativePage(1, [expense(199)], false));
    expect((await getExpensesAction()).success).toBe(false);
    mockInvoke.mockReset().mockRejectedValueOnce(new Error('Native expense permission denied'));
    expect((await getExpensesAction()).success).toBe(false);
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
  });

  it('refuses 10,001 records instead of silently truncating at 10,000', async () => {
    mockInvoke.mockImplementation((_cmd: string, args: { filters: { page: number } }) => {
      const page = args.filters.page;
      const rows = Array.from({ length: 200 }, (_, index) => expense(page * 200 + index));
      return Promise.resolve(nativePage(page, rows, true));
    });
    const result = await getExpensesAction({ category: 'all' });
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledTimes(50);
    expect(mockInvoke).toHaveBeenLastCalledWith('list_expenses_native', {
      filters: { from: null, to: null, category: 'all', page: 49 },
    });
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('accepts exactly 10,000 rows when the last native page is complete', async () => {
    mockInvoke.mockImplementation((_cmd: string, args: { filters: { page: number } }) => {
      const page = args.filters.page;
      return Promise.resolve(nativePage(page,
        Array.from({ length: 200 }, (_, index) => expense(page * 200 + index)),
        page < 49));
    });
    const result = await getExpensesAction();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(10_000);
    expect(mockInvoke).toHaveBeenCalledTimes(50);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('rejects impossible dates, reversed ranges, hostile category and failed native read', async () => {
    const filters = [
      { from: '2026-02-30' },
      { from: '2026-10-30', to: '2026-10-01' },
      { category: 'bad\0category' },
      { category: 'x'.repeat(129) },
    ];
    for (const invalid of filters) {
      expect((await getExpensesAction(invalid)).success).toBe(false);
    }
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('does not silently truncate non-Tauri web expense history either', async () => {
    mockIsTauri = false;
    const rows = Array.from({ length: 250 }, (_, index) => expense(index));
    mockDbSelect.mockImplementation((_query: string, params: unknown[]) => {
      const offset = Number(params[params.length - 1]);
      return Promise.resolve(rows.slice(offset, offset + 201));
    });
    const result = await getExpensesAction({ from: '2026-10-01', category: 'all' });
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(250);
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
    expect(mockDbSelect.mock.calls[0][0]).toContain('LIMIT 201 OFFSET ?');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('web transport rejects over-budget expense history rather than returning 10,000 partial rows', async () => {
    mockIsTauri = false;
    mockDbSelect.mockImplementation((_query: string, params: unknown[]) => {
      const offset = Number(params[params.length - 1]);
      return Promise.resolve(Array.from({ length: 201 }, (_, i) => expense(offset + i)));
    });
    const result = await getExpensesAction();
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(mockDbSelect).toHaveBeenCalledTimes(50);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
