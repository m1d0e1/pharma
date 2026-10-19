/** @jest-environment node */

let mockSession: any;
let mockNativeRows: Record<string, any[]>;
const mockInvoke = jest.fn();
const mockSelect = jest.fn(async (_sql?: string, _params?: any[]) => { throw new Error('Renderer SQL cannot read business data'); });
const mockGet = jest.fn(async (_sql?: string, _params?: any[]) => { throw new Error('Renderer SQL cannot read business data'); });
const nativePage = (rows: any[], actorId = 'reader-a', pharmacyId = 'ph-a') => ({
  actorId, pharmacyId, rows,
});

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockSelect(args[0], args[1]),
  dbGet: (...args: any[]) => mockGet(args[0], args[1]),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  dbReadScopedAll: jest.fn(),
  generateId: jest.fn(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, permission: string) =>
    user?.role === 'owner' || user?.permissions?.[permission] === true),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), reload: jest.fn(), updateDrug: jest.fn() },
}));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));
jest.unmock('@/app/actions-client/inventory');

import { getMovementsAction, getOpeningBalancesAction } from '@/app/actions-client/inventory';

describe('inventory history native tenant and role boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = {
      id: 'reader-a', pharmacy_id: 'ph-a', role: 'cashier',
      permissions: { preview_item_movements: true, can_view_opening_balances: true },
    };
    mockNativeRows = {
      'inventory.movements': [{ id: 1, action: 'OPENING_BALANCE', details: 'A movement' }],
      'inventory.opening_balances': [{ id: 'lot-a', quantity: 3, trade_name: 'Drug A' }],
    };
    mockInvoke.mockImplementation(async (command: string, args: any) => {
      if (command !== 'db_read_inventory_history') throw new Error('Unexpected command');
      return nativePage(mockNativeRows[args.queryId].slice(args.offset, args.offset + args.limit));
    });
  });

  it('loads both existing screens through exact native operations without renderer SQL', async () => {
    expect(await getMovementsAction()).toEqual({
      success: true,
      data: [{ id: 1, action: 'OPENING_BALANCE', details: 'A movement' }],
    });
    expect(await getOpeningBalancesAction()).toEqual({
      success: true,
      data: [{ id: 'lot-a', quantity: 3, trade_name: 'Drug A' }],
    });
    expect(mockInvoke.mock.calls).toEqual([
      ['db_read_inventory_history', { queryId: 'inventory.movements', limit: 200, offset: 0 }],
      ['db_read_inventory_history', { queryId: 'inventory.opening_balances', limit: 200, offset: 0 }],
    ]);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('preserves all rows through native pages rather than silently truncating', async () => {
    mockNativeRows['inventory.movements'] = Array.from({ length: 401 }, (_, id) => ({ id }));
    const result = await getMovementsAction();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(401);
    expect(mockInvoke.mock.calls.map((call: any[]) => call[1].offset)).toEqual([0, 200, 400]);
  });

  it.each(['inventory.movements', 'inventory.opening_balances'] as const)(
    'refuses %s when the authorized pharmacy changes between native pages',
    async (queryId) => {
      const allRows = Array.from({ length: 200 }, (_, id) => ({ id }));
      mockNativeRows[queryId] = allRows;
      mockInvoke
        .mockReset()
        .mockResolvedValueOnce(nativePage(allRows, 'reader-a', 'ph-a'))
        .mockResolvedValueOnce(nativePage([{ id: 'foreign-tenant' }], 'reader-a', 'ph-b'));
      const result = queryId === 'inventory.movements'
        ? await getMovementsAction()
        : await getOpeningBalancesAction();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/scope changed/i);
      expect(mockInvoke).toHaveBeenCalledTimes(2);
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockGet).not.toHaveBeenCalled();
    },
  );

  it('refuses a different authorized actor even when pharmacy stays the same', async () => {
    const full = Array.from({ length: 200 }, (_, id) => ({ id }));
    mockInvoke
      .mockReset()
      .mockResolvedValueOnce(nativePage(full, 'reader-a', 'ph-a'))
      .mockResolvedValueOnce(nativePage([{ id: 200 }], 'reader-b', 'ph-a'));
    const result = await getMovementsAction();
    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(result.error).toMatch(/scope changed/i);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it.each([
    ['old bare array', [{ id: 1 }]],
    ['missing actor ID', { pharmacyId: 'ph-a', rows: [{ id: 1 }] }],
    ['missing pharmacy ID', { actorId: 'reader-a', rows: [{ id: 1 }] }],
    ['empty actor ID', nativePage([{ id: 1 }], '', 'ph-a')],
    ['empty pharmacy ID', nativePage([{ id: 1 }], 'reader-a', '')],
    ['nonarray rows', { actorId: 'reader-a', pharmacyId: 'ph-a', rows: {} }],
    ['oversized page', nativePage(Array.from({ length: 201 }, (_, id) => ({ id })))],
  ])('rejects invalid native inventory envelope: %s', async (_case, response) => {
    mockInvoke.mockReset().mockResolvedValueOnce(response);
    const result = await getMovementsAction();
    expect(result.success).toBe(false);
    expect(result.data).toEqual([]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('does not use unscoped SQL when native enforcement denies access', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Authenticated role cannot view this inventory history'));
    const denied = await getMovementsAction();
    expect(denied.success).toBe(false);
    expect(mockSelect).not.toHaveBeenCalled();
    mockSession.permissions = {};
    expect((await getOpeningBalancesAction()).success).toBe(false);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});
