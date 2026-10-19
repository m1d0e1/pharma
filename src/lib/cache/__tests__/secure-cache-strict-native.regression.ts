/** @jest-environment jsdom */

describe('strict Tauri master-drug cache bootstrap', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.unmock('@/lib/db/tauri');
    jest.unmock('@/lib/env');
    jest.unmock('@/lib/auth/local');
    jest.unmock('@tauri-apps/api/core');
  });

  const validRow = (id = 15) => ({
    id, trade_name: `Global drug ${id}`, trade_name_en: null, generic_name: null,
    active_ingredient: null, barcode: `QA-${id}`, manufacturer: null,
    is_medicine: 1, is_service: 0, stop_dealing: 0, official_price: 7.5,
    has_expiry: 0, large_unit: 'Box', medium_unit: null, small_unit: null,
    large_to_medium: 12, medium_to_small: 10,
  });

  it('hydrates complete public native metadata without private renderer SQL or export permissions', async () => {
    const dbSelect = jest.fn(() => Promise.reject(new Error('strict renderer SQL blocked')));
    const invoke = jest.fn().mockResolvedValue([validRow(15), validRow(21)]);
    jest.doMock('@/lib/env', () => ({ isTauri: true }));
    jest.doMock('@/lib/db/tauri', () => ({ dbSelect }));
    jest.doMock('@tauri-apps/api/core', () => ({ invoke }));
    jest.doMock('@/lib/auth/local', () => ({ getLocalSession: jest.fn().mockResolvedValue({ id: 'qa-user', pharmacy_id: 'qa-owned', role: 'owner' }) }));

    const { secureCache } = require('@/lib/cache/secure_cache');
    await secureCache.load();
    expect(secureCache.getAvailability()).toBe('loaded');
    expect(secureCache.getAllDrugs()).toHaveLength(2);
    expect(secureCache.getDrug(15)).toMatchObject({ id: 15, has_expiry: 0, is_service: 0, large_to_medium: 12 });
    expect(secureCache.enrich([{ drug_id: 21, trade_name: 'SECURE' }])[0]).toMatchObject({ trade_name: 'Global drug 21' });
    expect(dbSelect).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('read_master_catalog_cache_native');
  });

  it('fails closed on native denial or missing integrity fields without manufacturing empty catalog', async () => {
    const dbSelect = jest.fn();
    const invoke = jest.fn().mockRejectedValueOnce(new Error('Unauthorized private SQL payload'))
      .mockResolvedValueOnce([{ ...validRow(), has_expiry: undefined }]);
    jest.doMock('@/lib/env', () => ({ isTauri: true }));
    jest.doMock('@/lib/db/tauri', () => ({ dbSelect }));
    jest.doMock('@tauri-apps/api/core', () => ({ invoke }));
    jest.doMock('@/lib/auth/local', () => ({ getLocalSession: jest.fn().mockResolvedValue({ id: 'qa-user', pharmacy_id: 'qa-owned' }) }));

    const { secureCache } = require('@/lib/cache/secure_cache');
    await expect(secureCache.reload()).rejects.toThrow(/native.*catalog.*unavailable/i);
    expect(secureCache.getAvailability()).toBe('unavailable');
    expect(() => secureCache.getAllDrugs()).toThrow(/native.*catalog.*unavailable/i);
    await expect(secureCache.load()).rejects.toThrow(/native.*catalog.*unavailable/i);
    expect(dbSelect).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('waits for native authentication before declaring availability unavailable', async () => {
    const dbSelect = jest.fn();
    const invoke = jest.fn().mockResolvedValue([validRow()]);
    const getLocalSession = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'qa-user' });
    jest.doMock('@/lib/env', () => ({ isTauri: true }));
    jest.doMock('@/lib/db/tauri', () => ({ dbSelect }));
    jest.doMock('@tauri-apps/api/core', () => ({ invoke }));
    jest.doMock('@/lib/auth/local', () => ({ getLocalSession }));

    const { secureCache } = require('@/lib/cache/secure_cache');
    await secureCache.load();
    expect(secureCache.getAvailability()).toBe('not_loaded');
    await secureCache.load();
    expect(secureCache.getAvailability()).toBe('loaded');
    expect(dbSelect).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
