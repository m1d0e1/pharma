/** @jest-environment node */
const mockNative = jest.fn();
const mockRendererSql = jest.fn((..._args: unknown[]) => { throw Error('Private renderer SQL is forbidden'); });
const mockActor = jest.fn(async (..._args: unknown[]): Promise<any> => ({
  id: 'qa-owner', pharmacy_id: 'qa-alerts', role: 'owner', permissions: '[]',
}));

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockNative(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockRendererSql(...args),
  dbGet: (...args: unknown[]) => mockRendererSql(...args),
  dbExecute: (...args: unknown[]) => mockRendererSql(...args),
  dbTransaction: (...args: unknown[]) => mockRendererSql(...args),
  dbReadScopedAll: (...args: unknown[]) => mockRendererSql(...args),
  generateId: () => 'unused-id',
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: (...args: unknown[]) => mockActor(...args),
  hasUserPermissionSync: jest.fn(() => false),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { load: jest.fn(), updateDrug: jest.fn() } }));
jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));
jest.unmock('@/app/actions-client/inventory');

import { getInventoryAlertsAction } from '../inventory';

const ownedAlert = {
  id: 'qa-owned-lot', drug_id: 101, alert_type: 'low_stock', quantity: 2,
  expiry_date: null, trade_name: 'QA catalog item', trade_name_en: 'QA item',
  active_ingredient: null, manufacturer: null,
};
const owned = {
  actorId: 'qa-owner', pharmacyId: 'qa-alerts',
  alerts: [ownedAlert], counts: { lowStock: 1, expiring: 0, expired: 0, total: 1 },
};

describe('strict native inventory header alerts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockActor.mockResolvedValue({ id: 'qa-owner', pharmacy_id: 'qa-alerts', role: 'owner', permissions: '[]' });
    mockNative.mockResolvedValue(owned);
  });

  it('reads only the tenant-bound typed native projection with no renderer SQL', async () => {
    const result = await getInventoryAlertsAction();
    expect(result).toEqual({ success: true, data: { alerts: [ownedAlert], counts: owned.counts } });
    expect(mockNative).toHaveBeenCalledTimes(1);
    expect(mockNative).toHaveBeenCalledWith('read_inventory_alerts_native');
    expect(mockRendererSql).not.toHaveBeenCalled();
  });

  it('does not claim global or legacy local-default stock ownership', async () => {
    mockActor.mockResolvedValue({ id: 'qa-owner', pharmacy_id: null, role: 'owner' });
    expect((await getInventoryAlertsAction()).success).toBe(false);
    expect(mockNative).not.toHaveBeenCalled();
    mockActor.mockResolvedValue({ id: 'qa-owner', pharmacy_id: 'qa-alerts', role: 'owner' });
    mockNative.mockResolvedValue({ ...owned, pharmacyId: 'local_default' });
    expect((await getInventoryAlertsAction()).success).toBe(false);
    mockNative.mockResolvedValue({ ...owned, actorId: 'foreign-actor' });
    expect((await getInventoryAlertsAction()).success).toBe(false);
    expect(mockRendererSql).not.toHaveBeenCalled();
  });

  it('rejects partial, fictitious zero, foreign data and invalid dates as an error, not an empty header', async () => {
    for (const malformed of [
      null,
      { ...owned, counts: { ...owned.counts, total: 0 } },
      { ...owned, counts: { ...owned.counts, lowStock: 0 } },
      { ...owned, alerts: [{ ...ownedAlert, quantity: Number.NaN }] },
      { ...owned, alerts: [{ ...ownedAlert, quantity: -1 }] },
      { ...owned, alerts: [{ ...ownedAlert, drug_id: -5 }] },
      { ...owned, alerts: [{ ...ownedAlert, trade_name: '\u0000private' }] },
      { ...owned, alerts: [{ ...ownedAlert, alert_type: 'supplier_payable' }] },
      { ...owned, alerts: [{ ...ownedAlert, alert_type: 'expired', expiry_date: 'not-a-date' }],
        counts: { lowStock: 0, expired: 1, expiring: 0, total: 1 } },
    ]) {
      mockNative.mockResolvedValueOnce(malformed);
      const result = await getInventoryAlertsAction();
      expect(result.success).toBe(false);
      expect(result.data).toBeUndefined();
    }
    expect(mockRendererSql).not.toHaveBeenCalled();
  });

  it('preserves native failure as explicitly unavailable, never a success with fabricated zero', async () => {
    mockNative.mockRejectedValueOnce(new Error('Synthetic guarded read rejected'));
    const result = await getInventoryAlertsAction();
    expect(result).toEqual({ success: false, error: 'فشل جلب تنبيهات المخزون' });
    expect(mockRendererSql).not.toHaveBeenCalled();
  });
});
