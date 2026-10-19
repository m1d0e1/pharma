/** @jest-environment node */
// No native process or real database: intentionally permissive renderer SQL mocks
// expose supplier CRUD that would bypass native supplier/tenant provisioning.
const mockSelect = jest.fn();
const mockGet = jest.fn();
const mockExecute = jest.fn();
const mockInvoke = jest.fn();
let mockSession: any;

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockSelect(...args),
  dbGet: (...args: any[]) => mockGet(...args),
  dbExecute: (...args: any[]) => mockExecute(...args),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'test-id'),
  normalizeDatabaseTimestamps: (rows: any[]) => rows,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: (user: any, permission: string) => Boolean(
    user?.role === 'owner' || user?.permissions?.[permission] === true
  ),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { updateDrug: jest.fn() },
}));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

import {
  addSupplierAction,
  updateSupplierAction,
  deleteSupplierAction,
  getSuppliersAction,
  getSupplierTransactionsAction,
} from '@/app/actions-client/purchases';

describe('supplier directory native actor boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoke.mockReset();
    mockSession = { id: 'actor-1', role: 'owner', pharmacy_id: 'ph-1', permissions: {} };
    mockSelect.mockResolvedValue([]);
    mockGet.mockResolvedValue({
      purchase_count: 0, return_count: 0, transaction_count: 0, notice_count: 0,
    });
    mockExecute.mockResolvedValue({ rowsAffected: 1, lastInsertId: 51 });
    mockInvoke.mockResolvedValue([]);
  });

  it.each([
    ['update', () => updateSupplierAction(51, { name_ar: 'Renamed supplier' })],
    ['delete', () => deleteSupplierAction(51)],
  ])('fails closed for native %s without a typed writer even if generic SQL would acknowledge writes', async (_operation, run) => {
    const result = await run();
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect((result as any).error.length).toBeGreaterThan(0);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('continues to use native tenant-owned query IDs for directory, report, and statement reads', async () => {
    mockInvoke
      .mockResolvedValueOnce([{ id: 51, name_ar: 'Owned supplier', balance: null }])
      .mockResolvedValueOnce([{ id: 51, name_ar: 'Owned supplier' }])
      .mockResolvedValueOnce([{ id: 1, supplier_id: 51, type: 'invoice' }]);

    expect(await getSuppliersAction()).toMatchObject({
      success: true, data: [{ id: 51, balance: null }],
    });
    expect(await getSuppliersAction({ reportScope: true })).toMatchObject({
      success: true, data: [{ id: 51 }],
    });
    expect(await getSupplierTransactionsAction(51)).toMatchObject({
      success: true, data: [{ supplier_id: 51 }],
    });
    expect(mockInvoke.mock.calls.map(([command, args]) => [command, args.queryId, args.recordId])).toEqual([
      ['db_read_scoped', 'purchases.suppliers_list', null],
      ['db_read_scoped', 'purchases.suppliers_report', null],
      ['db_read_scoped', 'purchases.supplier_transactions', '51'],
    ]);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('retrieves supplier statements beyond the first page without silently hiding financial history', async () => {
    const firstPage = Array.from({ length: 200 }, (_unused, i) => ({ id: i + 1, supplier_id: 51, type: 'invoice' }));
    mockInvoke.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([
      { id: 201, supplier_id: 51, type: 'payment' },
    ]);

    const statement = await getSupplierTransactionsAction(51);
    expect(statement).toMatchObject({ success: true });
    expect((statement as any).data).toHaveLength(201);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'db_read_scoped', expect.objectContaining({
      queryId: 'purchases.supplier_transactions', recordId: '51', limit: 200, offset: 0,
    }));
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'db_read_scoped', expect.objectContaining({
      queryId: 'purchases.supplier_transactions', recordId: '51', limit: 200, offset: 200,
    }));
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('does not reinterpret native scoped-read denial as an empty successful directory', async () => {
    mockInvoke.mockRejectedValue(new Error('Legacy purchasing ownership needs independent tenant verification'));
    expect(await getSuppliersAction()).toMatchObject({ success: false });
    expect(await getSuppliersAction({ reportScope: true })).toMatchObject({ success: false });
    expect(await getSupplierTransactionsAction(51)).toMatchObject({ success: false });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('preserves the known ownership-verification denial when Tauri rejects with a string', async () => {
    mockInvoke.mockRejectedValue('Legacy purchasing ownership needs independent tenant verification');
    expect(await getSuppliersAction()).toMatchObject({
      success: false,
      error: 'Legacy purchasing ownership needs independent tenant verification',
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('preserves an ownership denial from a string-rejected native supplier statement', async () => {
    mockInvoke.mockRejectedValue('Legacy purchasing ownership needs independent tenant verification');

    expect(await getSupplierTransactionsAction(51)).toEqual({
      success: false,
      error: 'Legacy purchasing ownership needs independent tenant verification',
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fails closed with a readable statement error when native IPC rejects without an Error object', async () => {
    mockInvoke.mockRejectedValue(null);

    expect(await getSupplierTransactionsAction(51)).toEqual({
      success: false,
      error: 'فشل تحميل كشف حساب المورد',
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated supplier mutation without invoking native or SQL commands', async () => {
    mockSession = null;
    expect(await addSupplierAction({ name_ar: 'Denied' })).toMatchObject({ success: false });
    expect(await updateSupplierAction(1, { name_ar: 'Denied' })).toMatchObject({ success: false });
    expect(await deleteSupplierAction(1)).toMatchObject({ success: false });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
