/** @jest-environment node */

const mockInvoke = jest.fn();
const mockDbSelect = jest.fn();
const mockDbGet = jest.fn();
const mockDbExecute = jest.fn();
const mockDbTransaction = jest.fn();
const mockGenerateId = jest.fn();
const mockNotifyInventoryChanged = jest.fn();
let mockSession: any;
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
  dbReadScopedAll: jest.fn(),
  generateId: (...args: unknown[]) => mockGenerateId(...args),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((actor: any, permission: string) =>
    actor?.role === 'owner' || Boolean(actor?.permissions?.[permission])),
}));
jest.mock('@/lib/inventory/refresh', () => ({
  notifyInventoryChanged: (...args: unknown[]) => mockNotifyInventoryChanged(...args),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), updateDrug: jest.fn(), getAllDrugs: jest.fn(() => []) },
}));

jest.unmock('@/app/actions-client/inventory');
import { addOpeningBalanceAction } from '@/app/actions-client/inventory';

const opening = {
  drug_id: 101,
  quantity: 4,
  cost_price: 10,
  unit_price: 17,
  expiry_date: '2099-12-31',
};

describe('opening balance typed native transactional boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauri = true;
    mockSession = {
      id: 'reader-a',
      pharmacy_id: 'a',
      role: 'cashier',
      permissions: { can_view_opening_balances: true },
    };
    mockInvoke.mockResolvedValue(undefined);
  });

  it.each([
    ['opening balances permission', { can_view_opening_balances: true }],
    ['inventory management permission', { can_manage_inventory: true }],
  ])('sends %s through one typed native command without renderer identity or SQL', async (_, permissions) => {
    mockSession.permissions = permissions;
    expect(await addOpeningBalanceAction(opening)).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('add_opening_balance_critical', {
      payload: opening,
    });
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
    expect(mockNotifyInventoryChanged).toHaveBeenCalledTimes(1);
  });

  it('rejects missing permissions and invalid amounts before any native writes', async () => {
    mockSession.permissions = {};
    expect(await addOpeningBalanceAction(opening)).toEqual({ success: false, error: 'Unauthorized' });
    mockSession.permissions = { can_view_opening_balances: true };
    for (const data of [
      { ...opening, quantity: 0 },
      { ...opening, quantity: Number.NaN },
      { ...opening, cost_price: -1 },
      { ...opening, cost_price: Number.POSITIVE_INFINITY },
      { ...opening, unit_price: -1 },
      { ...opening, unit_price: Number.NEGATIVE_INFINITY },
    ]) {
      expect(await addOpeningBalanceAction(data)).toEqual({
        success: false, error: 'بيانات الرصيد الافتتاحي غير صالحة',
      });
    }
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDbTransaction).not.toHaveBeenCalled();
    expect(mockNotifyInventoryChanged).not.toHaveBeenCalled();
  });

  it('fails closed on a native journal or shortage error without renderer-SQL retry', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('shortage recovery failed; transaction rolled back'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await addOpeningBalanceAction(opening)).toEqual({
      success: false, error: 'shortage recovery failed; transaction rolled back',
    });
    spy.mockRestore();
    expect(mockDbTransaction).not.toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
    expect(mockDbGet).not.toHaveBeenCalled();
    expect(mockNotifyInventoryChanged).not.toHaveBeenCalled();
  });

  it('keeps the web fallback stock, accounting, audit and recovered-shortage steps', async () => {
    mockIsTauri = false;
    mockGenerateId
      .mockReturnValueOnce('batch-test-abc')
      .mockReturnValueOnce('inventory-test-id')
      .mockReturnValueOnce('journal-test-id');
    mockDbGet.mockResolvedValue({
      large_to_medium: 6,
      medium_to_small: 2,
      has_expiry: 1,
      trade_name: 'Drug A',
    });
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const makePrepared = (sql: string) => ({
      run: jest.fn(async (...params: unknown[]) => {
        executed.push({ sql, params });
        return { rowsAffected: 1 };
      }),
      get: jest.fn(async () => {
        if (/current_stock/i.test(sql)) return { current_stock: 12, reorder_threshold: 10 };
        if (/opening_balance_equity/i.test(sql)) return { account_id: 40 };
        if (/inventory_asset/i.test(sql)) return { account_id: 30 };
        return null;
      }),
      all: jest.fn(async () => []),
    });
    mockDbTransaction.mockImplementation(async (callback: (db: any) => Promise<unknown>) =>
      callback({ prepare: makePrepared }));
    expect(await addOpeningBalanceAction(opening)).toEqual({ success: true });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDbTransaction).toHaveBeenCalledTimes(1);
    expect(executed.some(entry =>
      /INSERT INTO inventory/.test(entry.sql) &&
      entry.params.includes('a') &&
      entry.params.includes(17) &&
      entry.params.includes(10) &&
      entry.params.includes(6),
    )).toBe(true);
    expect(executed.some(entry =>
      /daily_journals/.test(entry.sql) && entry.params.includes(40),
    )).toBe(true);
    expect(executed.filter(entry => /INSERT INTO journal_entries/.test(entry.sql))).toHaveLength(2);
    expect(executed.some(entry =>
      /INSERT INTO activity_log/.test(entry.sql) &&
      entry.params.includes('OPENING_BALANCE') &&
      entry.params.includes('a'),
    )).toBe(true);
    expect(executed.some(entry => /UPDATE shortages/.test(entry.sql))).toBe(true);
    expect(mockNotifyInventoryChanged).toHaveBeenCalledTimes(1);
  });
});
