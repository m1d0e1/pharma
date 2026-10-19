/** @jest-environment node */

const mockInvoke = jest.fn();
const mockSelect = jest.fn();
const mockGet = jest.fn();
let mockSession: any;

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockSelect(...args),
  dbGet: (...args: any[]) => mockGet(...args),
  dbExecute: jest.fn(), dbTransaction: jest.fn(), generateId: jest.fn(),
  normalizeDatabaseTimestamps: (rows: any[]) => rows,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((actor: any, key: string) => Boolean(actor?.permissions?.[key])),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { updateDrug: jest.fn() } }));

import {
  getSuppliersAction, getSupplierTransactionsAction, getPurchasesReportsAction,
  searchPurchaseInvoicesForReturnAction, getPurchaseInvoiceDetailsAction,
  getPurchaseReturnsAction, getPurchaseReturnDetailsAction,
} from '@/app/actions-client/purchases';

describe('supplier and purchase return typed native read transport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSession = { id: 'buyer-a', pharmacy_id: 'a', role: 'pharmacist',
      permissions: { can_view_suppliers: true, can_view_purchases: true, rep_can_view_purchases: true } };
    mockInvoke.mockResolvedValue([]);
  });

  it('keeps all suppliers and statement transactions on the native authenticated boundary', async () => {
    expect((await getSuppliersAction()).success).toBe(true);
    expect((await getSuppliersAction({ reportScope: true })).success).toBe(true);
    expect((await getSupplierTransactionsAction(7)).success).toBe(true);
    expect(mockInvoke.mock.calls.map(call => call[1].queryId)).toEqual([
      'purchases.suppliers_list', 'purchases.suppliers_report', 'purchases.supplier_transactions',
    ]);
    expect(mockInvoke.mock.calls[2][1].recordId).toBe('7');
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('routes completed reports, return eligibility and return details through typed reads', async () => {
    mockInvoke.mockImplementation(async (_command: string, payload: any) =>
      payload.queryId === 'purchases.detail_header' ? [{ id: 'inv-a', tax_percent: 0 }] : []);
    expect((await getPurchasesReportsAction({ supplierId: 7, status: 'completed' })).success).toBe(true);
    expect((await searchPurchaseInvoicesForReturnAction('barcode')).success).toBe(true);
    expect((await getPurchaseInvoiceDetailsAction('inv-a')).success).toBe(true);
    expect((await getPurchaseReturnsAction({ search: 'inv', limit: 20 })).success).toBe(true);
    mockInvoke.mockResolvedValueOnce([{ id: 'return-a' }]);
    mockInvoke.mockResolvedValueOnce([{ id: 5, drug_name: 'Drug' }]);
    expect((await getPurchaseReturnDetailsAction('return-a')).success).toBe(true);
    const names = mockInvoke.mock.calls.map(call => call[1].queryId);
    expect(names).toEqual(expect.arrayContaining([
      'purchases.reports', 'purchases.return_search', 'purchases.detail_header',
      'purchases.returns_list', 'purchases.return_detail', 'purchases.return_items',
    ]));
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockInvoke.mock.calls.every(call =>
      !('sql' in call[1]) && !('pharmacyId' in call[1]) && !('actorId' in call[1]),
    )).toBe(true);
  });

  it('preserves a native string tenant-ownership denial in the purchase report action', async () => {
    const ownershipError = 'Legacy purchasing ownership needs independent tenant verification';
    mockInvoke.mockRejectedValueOnce(ownershipError);

    expect(await getPurchasesReportsAction()).toEqual({ success: false, error: ownershipError });
    expect(mockInvoke).toHaveBeenCalledWith('db_read_scoped', expect.objectContaining({
      queryId: 'purchases.reports',
    }));
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('denies missing permissions and never falls back to renderer SQL after native denial', async () => {
    mockSession.permissions = {};
    expect((await getSuppliersAction()).success).toBe(false);
    expect((await getPurchaseReturnsAction()).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    mockSession.permissions = { can_view_suppliers: true, can_view_purchases: true };
    mockInvoke.mockRejectedValue(new Error('native policy denial'));
    expect((await getSupplierTransactionsAction(7)).success).toBe(false);
    expect((await getPurchaseReturnsAction()).success).toBe(false);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
