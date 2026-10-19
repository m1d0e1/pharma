/** @jest-environment node */
import { getMasterDrugAction, searchInventoryAction, searchMasterDrugsAction } from '@/app/actions-client/master-drugs';
import { secureCache } from '@/lib/cache/secure_cache';
import { dbSelect } from '@/lib/db/tauri';
import { invoke } from '@tauri-apps/api/core';

jest.mock('@/lib/env', () => ({ isTauri: true, isClient: true }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => { throw Error('Strict native SQL: renderer SELECT refused'); }),
  dbGet: jest.fn(), dbExecute: jest.fn(), dbTransaction: jest.fn(), generateId: jest.fn(),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    getAllDrugs: jest.fn(),
    updateDrug: jest.fn(),
  },
}));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
let mockSession: any;
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, key: string) =>
    user?.permissions?.[key] === true),
}));

const catalog = [
  { id: 132, trade_name: 'Test catalog gel',
    trade_name_en: 'ACNEBLESS FACIAL CLEANSING GEL 200 ML', generic_name: 'Gel',
    active_ingredient: 'Cleansing', official_price: 150, barcode: 'CATALOG-BARCODE',
    is_medicine: 1, is_service: 0, stop_dealing: 0, has_expiry: 1 },
  { id: 133, trade_name: 'Service', trade_name_en: 'Clinical Service',
    official_price: 50, barcode: 'SERVICE', is_medicine: 0, is_service: 1, stop_dealing: 0 },
];

describe('strict native catalog and private inventory search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (secureCache.load as jest.Mock).mockResolvedValue(undefined);
    (secureCache.getAllDrugs as jest.Mock).mockReturnValue(catalog);
    (secureCache as any).getDrug = jest.fn((id: number) => catalog.find(item => item.id === id));
    mockSession = { id: 'inventory-owner', pharmacy_id: 'owned-branch',
      permissions: { can_manage_inventory: true } };
  });

  it('filters verified native reference catalog without ANY renderer SQL fallback', async () => {
    const result = await searchMasterDrugsAction({ query: 'ACNEBLESS', status: 'active' });
    expect(result).toMatchObject({
      success: true, data: [{ id: 132, official_price: 150, purchase_price: null }],
    });
    expect(dbSelect).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('supports deterministic native-cache filters, counts and pages with strict SQL disabled', async () => {
    const result = await searchMasterDrugsAction({
      query: '', type: 'all', page: 2, pageSize: 1,
    });
    expect(result).toMatchObject({
      success: true, total: 2, page: 2, pages: 2, pageSize: 1,
      data: [{ id: 132 }],
    });
    // Arabic locale sorting may place the English Service name first.
    expect(result.data).toHaveLength(1);
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('does not treat unavailable or unverified native cache as an empty catalog', async () => {
    (secureCache.load as jest.Mock).mockRejectedValueOnce('Native catalog denied');
    const denied = await searchMasterDrugsAction({ query: 'ACNEBLESS', status: 'active' });
    expect(denied).toMatchObject({ success: false, error: expect.any(String) });
    expect(denied.data).toBeUndefined();
    expect(dbSelect).not.toHaveBeenCalled();
    (secureCache.getAllDrugs as jest.Mock).mockImplementationOnce(() => { throw Error('unverified'); });
    expect(await searchMasterDrugsAction({ query: 'Gel' })).toMatchObject({ success: false });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('uses only native checked reference metadata for a purchase-invoice drug deep link', async () => {
    const result = await getMasterDrugAction(132);
    expect(result).toMatchObject({ success: true, data: {
      id: 132, trade_name: 'Test catalog gel',
      base_price: null, purchase_price: null,
    } });
    expect(dbSelect).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(await getMasterDrugAction(999)).toMatchObject({ success: true, data: null });
    expect(await getMasterDrugAction(-1)).toMatchObject({ success: false });
    mockSession.permissions.can_manage_inventory = false;
    expect(await getMasterDrugAction(132)).toMatchObject({ success: false });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('uses only actor-scoped typed native inventory search, preserving redacted acquisition costs', async () => {
    (invoke as jest.Mock).mockResolvedValueOnce([{
      id: 'owned-lot', drug_id: 132, trade_name: 'Test catalog gel',
      trade_name_en: 'ACNEBLESS FACIAL CLEANSING GEL 200 ML',
      quantity: 2, cost_price: null,
    }]);
    const result = await searchInventoryAction('ACNEBLESS');
    expect(result).toMatchObject({ success: true, data: [{
      id: 'owned-lot', drug_id: 132, cost_price: null,
    }] });
    expect(invoke).toHaveBeenCalledWith('db_read_scoped', {
      queryId: 'inventory.enriched', recordId: null, search: 'ACNEBLESS',
      drugId: null, limit: 20, offset: 0,
    });
    expect(dbSelect).not.toHaveBeenCalled();
  });

  it('fails closed on denied, malformed or cross-contract native inventory replies', async () => {
    expect(await searchInventoryAction('  ')).toMatchObject({ success: true, data: [] });
    expect(invoke).not.toHaveBeenCalled();
    (invoke as jest.Mock).mockRejectedValueOnce('Authenticated role cannot view pharmacy inventory');
    expect(await searchInventoryAction('drug')).toMatchObject({ success: false });
    (invoke as jest.Mock).mockResolvedValueOnce([{ id: 'x', drug_id: 'malformed' }]);
    expect(await searchInventoryAction('drug')).toMatchObject({ success: false });
    expect(dbSelect).not.toHaveBeenCalled();
  });
});
