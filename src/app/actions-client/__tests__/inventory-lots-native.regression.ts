/** @jest-environment node */

let mockIsTauri = true;
const mockInvoke = jest.fn();
const mockSql = jest.fn((..._args: unknown[]) => { throw new Error('renderer SQL is forbidden on native lot writes'); });
const mockSession = jest.fn((..._args: unknown[]): any => { throw new Error('renderer session cannot authorize native lot writes'); });
const mockPermission = jest.fn(() => false);
const mockGenerateId = jest.fn(() => '3c56ecf8-6864-4d87-86e0-5f978a8cdf12');
const mockNotify = jest.fn();
const mockReload = jest.fn();

jest.mock('@/lib/env', () => ({ get isTauri() { return mockIsTauri; } }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockSql(...args),
  dbGet: (...args: unknown[]) => mockSql(...args),
  dbExecute: (...args: unknown[]) => mockSql(...args),
  dbTransaction: (...args: unknown[]) => mockSql(...args),
  dbReadScopedAll: (...args: unknown[]) => mockSql(...args),
  generateId: () => mockGenerateId(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: (...args: unknown[]) => mockSession(...args),
  hasUserPermissionSync: (...args: unknown[]) => mockPermission(),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), reload: (...args: unknown[]) => mockReload(...args), updateDrug: jest.fn() },
}));
jest.mock('@/lib/inventory/refresh', () => ({
  notifyInventoryChanged: (...args: unknown[]) => mockNotify(...args),
}));
jest.unmock('@/app/actions-client/inventory');

import {
  addInventoryAction, deleteInventoryAction, updateInventoryAction,
  getPendingInventoryCreationsAction, acknowledgePendingInventoryCreationAction,
  importInventoryWorkbookAction,
} from '@/app/actions-client/inventory';

const lot = {
  drug_id: 101,
  quantity: 4.5,
  local_selling_price: 24.75,
  expiry_date: '2029-12-31',
  barcode: '  LOT-ABC  ',
};
const nativeCreated = { success: true, id: 'server-generated-lot', drugId: 101 };

describe('native inventory lot creation and deletion', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauri = true;
    mockInvoke.mockImplementation((command: string, args?: { payload?: { requestId?: string; inventoryId?: string } }) => {
      if (command === 'acknowledge_inventory_create_native') {
        return Promise.resolve({
          success: true,
          requestId: args?.payload?.requestId,
          inventoryId: args?.payload?.inventoryId,
        });
      }
      if (command === 'delete_inventory_lot_native') {
        return Promise.resolve({ success: true, id: (args as any)?.payload?.id, disposition: 'zeroed' });
      }
      return Promise.resolve(nativeCreated);
    });
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => consoleError.mockRestore());

  const expectNoRendererAuthority = () => {
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
    expect(mockPermission).not.toHaveBeenCalled();
    expect(mockReload).not.toHaveBeenCalled(); // Existing reload uses renderer SQL and local session.
  };

  it('creates a native lot with a generated request nonce, normalizes barcode and ignores forged tenant/actor', async () => {
    mockInvoke.mockResolvedValueOnce(nativeCreated);

    const result = await addInventoryAction({
      ...lot,
      pharmacy_id: 'forged-pharmacy',
      user_id: 'forged-owner',
      actorId: 'forged-owner',
      role: 'owner',
      official_price: 0.01,
    } as any);

    expect(result).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('create_inventory_lot_native', {
      payload: {
        drugId: 101,
        quantity: 4.5,
        localSellingPrice: 24.75,
        expiryDate: '2029-12-31',
        barcode: 'LOT-ABC',
        unit: null,
        largeToMedium: null,
        expectNullLargeUnit: false,
        requestId: '3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
      },
    });
    // Never auto-acknowledge: a lost *acknowledgement* reply would otherwise
    // clear the native pending gate without UI certainty after restart.
    expect(mockInvoke).not.toHaveBeenCalledWith(
      'acknowledge_inventory_create_native', expect.anything(),
    );
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toMatch(/pharmacy_id|pharmacyId|actorId|user_id|official_price|officialPrice/i);
    expect(mockGenerateId).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expectNoRendererAuthority();
  });

  it('preserves null optional barcode and non-expiring date in native payload', async () => {
    mockInvoke.mockResolvedValueOnce({ ...nativeCreated, id: 'lot-without-expiry' });
    expect(await addInventoryAction({ ...lot, expiry_date: null, barcode: '   ' })).toEqual({ success: true });
    expect(mockInvoke.mock.calls[0][1].payload).toEqual({
      drugId: 101, quantity: 4.5, localSellingPrice: 24.75,
      expiryDate: null, barcode: null,
      unit: null, largeToMedium: null, expectNullLargeUnit: false,
      requestId: '3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
    });
    expectNoRendererAuthority();
  });

  it('passes modal unit/conversion values only as native catalog assertions without converting or editing prices', async () => {
    mockInvoke.mockResolvedValueOnce(nativeCreated);
    expect(await addInventoryAction({ ...lot, unit: ' علبة ', large_to_medium: 12 })).toEqual({ success: true });
    expect(mockInvoke.mock.calls[0][1].payload).toEqual({
      drugId: 101, quantity: 4.5, localSellingPrice: 24.75,
      expiryDate: '2029-12-31', barcode: 'LOT-ABC',
      unit: 'علبة', largeToMedium: 12, expectNullLargeUnit: false,
      requestId: '3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
    });
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toMatch(/setLarge|officialPrice|catalogPrice|pharmacyId/i);
    expectNoRendererAuthority();
  });

  it('carries an explicit blank-catalog-unit precondition only when requested, not for omitted units', async () => {
    mockInvoke.mockResolvedValueOnce(nativeCreated);
    const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(await addInventoryAction({
      ...lot, unit: null, large_to_medium: 1,
      expect_null_large_unit: true, request_id: requestId,
    })).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledWith('create_inventory_lot_native', {
      payload: {
        drugId: 101, quantity: 4.5, localSellingPrice: 24.75,
        expiryDate: '2029-12-31', barcode: 'LOT-ABC',
        unit: null, largeToMedium: 1,
        expectNullLargeUnit: true, requestId,
      },
    });
    expect(mockGenerateId).not.toHaveBeenCalled();
    expectNoRendererAuthority();
  });

  it.each(['true', 1, null, {}, []])('rejects nonboolean blank-unit preconditions before IPC: %p', async value => {
    expect((await addInventoryAction({ ...lot, expect_null_large_unit: value } as any)).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockGenerateId).not.toHaveBeenCalled();
    expectNoRendererAuthority();
  });

  it('preserves a supplied canonical UUIDv4 across an ambiguous failed ACK and a successful replay', async () => {
    const requestId = '12345678-1234-4abc-9def-0123456789ab';
    mockInvoke.mockRejectedValueOnce(new Error('ACK lost after commit')).mockResolvedValueOnce(nativeCreated);

    expect(await addInventoryAction({ ...lot, request_id: requestId })).toEqual({ success: false, error: 'فشل إضافة الصنف' });
    expect(await addInventoryAction({ ...lot, request_id: requestId })).toEqual({ success: true });
    expect(mockInvoke.mock.calls.map((call: any[]) => call[1].payload.requestId)).toEqual([requestId, requestId]);
    expect(mockGenerateId).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expectNoRendererAuthority();
  });

  it.each([
    '', 'not-a-uuid', '12345678-1234-1abc-9def-0123456789ab',
    '12345678-1234-4abc-7def-0123456789ab',
    '12345678-1234-4ABC-9DEF-0123456789AB',
    '12345678-1234-4abc-9def-0123456789ab ',
    null, 12345,
  ])('rejects malformed caller-supplied request_id without allocating a fresh nonce or touching SQL: %p', async requestId => {
    expect(await addInventoryAction({ ...lot, request_id: requestId } as any)).toMatchObject({
      success: false, error: expect.stringContaining('بيانات الإدخال غير صالحة'),
    });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockGenerateId).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expectNoRendererAuthority();
  });

  it.each([
    { unit: 'pack instead of vial' },
    { unit: 'strip', large_to_medium: 4 },
    { large_to_medium: 10 },
  ])('fails closed when native catalog rejects a requested unit/conversion change: %p', async fields => {
    mockInvoke.mockRejectedValueOnce(new Error('Stale catalog unit assertion; use conversion workflow'));
    expect(await addInventoryAction({ ...lot, ...fields })).toEqual({ success: false, error: 'فشل إضافة الصنف' });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockNotify).not.toHaveBeenCalled();
    expectNoRendererAuthority();
  });

  it.each([
    { ...lot, quantity: -1 },
    { ...lot, local_selling_price: -1 },
    { ...lot, expiry_date: '2029-02-30' },
    { ...lot, drug_id: -12 },
    { ...lot, quantity: Infinity },
  ])('rejects invalid native creation input before calling Rust: %p', async input => {
    expect((await addInventoryAction(input)).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expectNoRendererAuthority();
  });

  it.each([null, undefined, '', '   ', false, [], {}])(
    'does not turn a missing native creation selling price into a free lot: %p',
    async rawPrice => {
      expect((await addInventoryAction({ ...lot, local_selling_price: rawPrice } as any)).success).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockGenerateId).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
      expectNoRendererAuthority();
    },
  );

  it('preserves intentionally entered numeric zero as a valid native selling price', async () => {
    expect(await addInventoryAction({ ...lot, local_selling_price: 0 })).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledWith('create_inventory_lot_native', {
      payload: expect.objectContaining({ localSellingPrice: 0 }),
    });
    expectNoRendererAuthority();
  });

  it('retains a nonblank numeric selling price entered as HTML form text', async () => {
    expect(await addInventoryAction({ ...lot, local_selling_price: '24.75' } as any)).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledWith('create_inventory_lot_native', {
      payload: expect.objectContaining({ localSellingPrice: 24.75 }),
    });
    expectNoRendererAuthority();
  });

  it.each([
    null, [], undefined, {},
    { success: 'true', id: 'lot-a' },
    { success: true },
    { success: true, id: '' , drugId: 101 },
    { success: true, id: 100, drugId: 101 },
    { success: true, id: 'lot-a' },
    { success: true, id: 'lot-a', drugId: 999 },
    { success: true, id: 'lot-a', drugId: '101' },
    { success: true, id: 'lot-a', drugId: 101, error: 'not saved' },
    { success: false, code: 'TENANT_DENIED' },
  ])('fails closed on malformed or unsuccessful native creation ACK: %p', async ack => {
    mockInvoke.mockResolvedValueOnce(ack);
    expect(await addInventoryAction(lot)).toEqual({ success: false, error: 'فشل إضافة الصنف' });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockNotify).not.toHaveBeenCalled();
    expectNoRendererAuthority();
  });

  it.each(['Staff cannot manage inventory', 'Different tenant', 'Barcode owned by another drug', 'Expiry required'])
    ('treats native creation denial as final: %s', async message => {
      mockInvoke.mockRejectedValueOnce(new Error(message));
      expect(await addInventoryAction(lot)).toEqual({ success: false, error: 'فشل إضافة الصنف' });
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockNotify).not.toHaveBeenCalled();
      expectNoRendererAuthority();
    });

  it('deletes a lot by native owner/tenant-checked ID and confirms zeroing disposition', async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, id: 'lot-1', disposition: 'zeroed' });
    expect(await deleteInventoryAction({ id: 'lot-1', pharmacy_id: 'forged-tenant', userId: 'forged-actor' } as any))
      .toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('delete_inventory_lot_native', { payload: { id: 'lot-1' } });
    expect(mockGenerateId).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expectNoRendererAuthority();
  });

  it('accepts a correctly identified native physical-delete ACK', async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, id: 'lot-2', disposition: 'deleted' });
    expect(await deleteInventoryAction({ id: 'lot-2' })).toEqual({ success: true });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expectNoRendererAuthority();
  });

  it.each([
    null, [], {},
    { success: true },
    { success: 'true', id: 'lot-1', disposition: 'zeroed' },
    { success: true, id: 'foreign-lot', disposition: 'deleted' },
    { success: true, id: 'lot-1', disposition: 'unknown' },
    { success: true, id: 'lot-1', disposition: 'zeroed', error: 'failed' },
    { success: false, code: 'TENANT_DENIED' },
  ])('fails closed on malformed or forged native deletion ACK: %p', async ack => {
    mockInvoke.mockResolvedValueOnce(ack);
    expect(await deleteInventoryAction({ id: 'lot-1' })).toEqual({ success: false, error: 'فشل حذف الصنف.' });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockNotify).not.toHaveBeenCalled();
    expectNoRendererAuthority();
  });

  it.each(['Not part of pharmacy', 'Deletion requires admin', 'History prevents physical deletion'])
    ('does not fall back to renderer SQL when native deletion is denied: %s', async message => {
      mockInvoke.mockRejectedValueOnce(new Error(message));
      expect(await deleteInventoryAction({ id: 'lot-1' })).toEqual({ success: false, error: 'فشل حذف الصنف.' });
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      expect(mockNotify).not.toHaveBeenCalled();
      expectNoRendererAuthority();
    });

  it('validates lot ID before native deletion', async () => {
    expect((await deleteInventoryAction({ id: '' })).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expectNoRendererAuthority();
  });

  it('keeps confirmed native writes successful even if inventory notifications throw', async () => {
    mockNotify.mockImplementation(() => { throw new Error('Local storage disabled'); });
    mockInvoke
      .mockResolvedValueOnce({ ...nativeCreated, id: 'lot-3' });
    expect(await addInventoryAction(lot)).toEqual({ success: true });
    expect(await deleteInventoryAction({ id: 'lot-3' })).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockNotify).toHaveBeenCalledTimes(2);
    expectNoRendererAuthority();
  });

  it('retains web session permissions and never routes browser requests through Tauri IPC', async () => {
    mockIsTauri = false;
    mockSession.mockReturnValue({ id: 'web-owner', role: 'owner', pharmacy_id: 'web-pharmacy' });
    mockPermission.mockReturnValue(false);

    expect(await addInventoryAction(lot)).toMatchObject({
      success: false, error: expect.stringContaining('صلاحية إضافة'),
    });
    expect(await deleteInventoryAction({ id: 'lot-1' })).toMatchObject({
      success: false, error: expect.stringContaining('صلاحية حذف'),
    });
    expect(mockSession).toHaveBeenCalledTimes(2);
    expect(mockPermission).toHaveBeenCalledTimes(2);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe('native update and durable creation recovery boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauri = true;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const update = {
    id: 'stock-a', quantity: 2.5, local_selling_price: 12,
    expected_quantity: 3, expected_local_selling_price: 11.5,
    reason_id: 1, large_to_medium: 12,
  };

  it('updates through native compare-and-swap and never trusts renderer actor, pharmacy or journal', async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, id: 'stock-a' });
    expect(await updateInventoryAction({
      ...update, user_id: 'owner', pharmacy_id: 'other', cost_price: 1, account_id: 10,
    } as any)).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledWith('update_inventory_lot_native', {
      payload: {
        id: 'stock-a', quantity: 2.5, localSellingPrice: 12,
        expectedQuantity: 3, expectedLocalSellingPrice: 11.5,
        reasonId: 1, expiryDate: undefined, barcode: undefined,
        unit: null, largeToMedium: 12,
      },
    });
    expect(JSON.stringify(mockInvoke.mock.calls)).not.toMatch(/pharmacy_id|pharmacyId|user_id|actorId|accountId|costPrice/);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
    expect(mockReload).not.toHaveBeenCalled();
  });

  it('rejects missing CAS witness and malformed/denied update replies without renderer SQL fallback', async () => {
    expect((await updateInventoryAction({ id: 'stock-a', quantity: 3, local_selling_price: 12 })).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    mockInvoke.mockResolvedValueOnce({ success: true, id: 'other-stock' });
    expect((await updateInventoryAction(update)).success).toBe(false);
    mockInvoke.mockRejectedValueOnce(new Error('foreign tenant'));
    expect((await updateInventoryAction(update)).success).toBe(false);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });

  it.each([null, undefined, '', '   ', false, [], {}])(
    'rejects an empty or nonnumeric selling price before the native update can zero retail pricing: %p',
    async rawPrice => {
      expect((await updateInventoryAction({ ...update, local_selling_price: rawPrice } as any)).success).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockSql).not.toHaveBeenCalled();
      expect(mockSession).not.toHaveBeenCalled();
    },
  );

  it('preserves intentionally entered zero as an explicitly authorized native update value', async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, id: 'stock-a' });
    expect(await updateInventoryAction({ ...update, local_selling_price: 0 })).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledWith('update_inventory_lot_native', {
      payload: expect.objectContaining({ localSellingPrice: 0 }),
    });
  });

  it('preserves nonblank numeric text from the native lot price edit field', async () => {
    mockInvoke.mockResolvedValueOnce({ success: true, id: 'stock-a' });
    expect(await updateInventoryAction({ ...update, local_selling_price: '12.50' } as any)).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledWith('update_inventory_lot_native', {
      payload: expect.objectContaining({ localSellingPrice: 12.5 }),
    });
  });

  it('lists only structurally valid native scoped pending receipts and confirms an exact ACK', async () => {
    const requestId = 'a1111111-1111-4111-8111-111111111111';
    mockInvoke.mockResolvedValueOnce([{
      requestId, inventoryId: 'stock-a', createdBy: 'actor-a', drugId: 10, quantity: 1,
      localSellingPrice: 12, expiryDate: null, createdAt: '2026-10-11',
    }]);
    expect(await getPendingInventoryCreationsAction()).toMatchObject({ success: true, data: [{ requestId }] });
    mockInvoke.mockResolvedValueOnce({ success: true, requestId, inventoryId: 'stock-a' });
    expect(await acknowledgePendingInventoryCreationAction(requestId, 'stock-a')).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenLastCalledWith('acknowledge_inventory_create_native', {
      payload: { requestId, inventoryId: 'stock-a' },
    });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });

  it('surfaces a native inventory recovery denial without opening a new stock creation path', async () => {
    mockInvoke.mockRejectedValueOnce('Live inventory management permission required');
    expect(await getPendingInventoryCreationsAction()).toEqual({
      success: false,
      error: 'Live inventory management permission required',
    });
    expect(mockInvoke).toHaveBeenCalledWith('list_unacknowledged_inventory_creates_native');
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });

  it('fails closed on forged recovery replies and lost ACK without duplicate allocation', async () => {
    const requestId = 'a1111111-1111-4111-8111-111111111111';
    mockInvoke.mockResolvedValueOnce([{
      requestId, inventoryId: 'stock-a', createdBy: 'actor-a', drugId: 10, quantity: Infinity,
      localSellingPrice: 12, expiryDate: null, createdAt: '2026-10-11',
    }]);
    expect((await getPendingInventoryCreationsAction()).success).toBe(false);
    mockInvoke.mockResolvedValueOnce({ success: true, requestId, inventoryId: 'foreign-stock' });
    expect((await acknowledgePendingInventoryCreationAction(requestId, 'stock-a')).success).toBe(false);
    mockInvoke.mockRejectedValueOnce(new Error('native create ACK response lost'));
    expect((await addInventoryAction({ ...lot, request_id: requestId })).success).toBe(false);
    // No separate automatic ACK is issued; a durable pending receipt will
    // remain visible across modal closure/restart for explicit reconciliation.
    expect(mockInvoke).toHaveBeenCalledTimes(3);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('imports bounded stock through one native batch and never grants master-catalog or tenant authority', async () => {
    mockInvoke.mockResolvedValueOnce({
      success: true, requestId: '3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
      inventoryIds: ['new-stock-a'], inventoryCount: 1, replayed: false,
    });
    const result = await importInventoryWorkbookAction([{
      drug_id: 101, quantity: 2, local_selling_price: 12.5,
      expiry_date: '2031-05-01', strips_per_box: 12, barcode: 'STOCK-A',
    }], []);
    expect(result).toEqual({
      success: true, data: { inventoryCount: 1, masterDrugCount: 0 }, replayed: false,
    });
    expect(mockInvoke).toHaveBeenCalledWith('import_inventory_lots_native', {
      input: {
        requestId: '3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
        rows: [{
          drugId: 101, quantity: 2, localSellingPrice: 12.5,
          expiryDate: '2031-05-01', barcode: 'STOCK-A',
          unit: null, expectNullLargeUnit: false,
          largeToMedium: 12, mediumToSmall: null,
        }],
      },
    });
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
    expect(mockReload).not.toHaveBeenCalled();
  });

  it('denies imported historical IDs, master catalog upserts, oversized files and bad native ACK without renderer fallback', async () => {
    const safe = { drug_id: 101, quantity: 1, local_selling_price: 12 };
    expect((await importInventoryWorkbookAction([{ ...safe, id: 'historic-lot' }], [])).success).toBe(false);
    expect((await importInventoryWorkbookAction([safe], [{ id: 101, trade_name: 'Changed' }])).success).toBe(false);
    expect((await importInventoryWorkbookAction(Array.from({ length: 201 }, () => safe), [])).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    mockInvoke.mockResolvedValueOnce({
      success: true, requestId: '3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
      inventoryIds: [], inventoryCount: 1, replayed: false,
    });
    expect((await importInventoryWorkbookAction([safe], [])).success).toBe(false);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockSession).not.toHaveBeenCalled();
  });
});
