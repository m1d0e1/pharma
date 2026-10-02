/** @jest-environment jsdom */

describe('secure cache auto-preload boundary', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    delete process.env.NEXT_PUBLIC_TAURI;
    delete (globalThis as any).isTauri;
    delete (window as any).__TAURI__;
    delete (window as any).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.unmock('@/lib/db/tauri');
    jest.unmock('@/lib/env');
  });

  test('does not start SQLite cache loading merely because a browser-like window exists', async () => {
    const dbSelect = jest.fn().mockResolvedValue([]);
    jest.doMock('@/lib/db/tauri', () => ({ dbSelect }));
    jest.doMock('@/lib/env', () => ({ isClient: true, isTauri: false }));

    require('@/lib/cache/secure_cache');
    jest.advanceTimersByTime(501);
    await Promise.resolve();
    await Promise.resolve();

    expect(dbSelect).not.toHaveBeenCalled();
  });

  test('keeps the intended eager preload in the Tauri runtime', async () => {
    const dbSelect = jest.fn().mockResolvedValue([]);
    jest.doMock('@/lib/db/tauri', () => ({ dbSelect }));
    jest.doMock('@/lib/env', () => ({ isClient: true, isTauri: true }));

    require('@/lib/cache/secure_cache');
    jest.advanceTimersByTime(501);
    await Promise.resolve();
    await Promise.resolve();

    expect(dbSelect).toHaveBeenCalledTimes(1);
  });

  test('hydrates has_expiry into cached master drugs used by downstream purchase search', async () => {
    const dbSelect = jest.fn().mockResolvedValue([{
      id: 101,
      trade_name: 'Non Expiring Drug',
      trade_name_en: 'Non Expiring Drug',
      generic_name: '',
      active_ingredient: '',
      barcode: 'NO-EXP-101',
      manufacturer: '',
      is_medicine: 1,
      is_service: 0,
      stop_dealing: 0,
      official_price: 20,
      has_expiry: 0,
      large_unit: 'Box',
      medium_unit: 'Strip',
      small_unit: 'Tablet',
      large_to_medium: 2,
      medium_to_small: 10,
    }]);
    jest.doMock('@/lib/db/tauri', () => ({ dbSelect }));
    jest.doMock('@/lib/env', () => ({ isClient: true, isTauri: false }));

    const { secureCache } = require('@/lib/cache/secure_cache');
    await secureCache.load();

    expect(dbSelect).toHaveBeenCalledTimes(1);
    expect(dbSelect.mock.calls[0][0]).toContain('has_expiry');
    expect(secureCache.getDrug(101)).toMatchObject({ id: 101, has_expiry: 0 });
  });

  test('reloads the catalog cache when another Tauri window broadcasts a drug identity change', async () => {
    const oldDrug = {
      id: 10, trade_name: 'Old duplicate', trade_name_en: 'Old duplicate', generic_name: '',
      active_ingredient: '', barcode: '123', manufacturer: '', is_medicine: 1, is_service: 0,
      stop_dealing: 0, official_price: 20, has_expiry: 1,
      large_unit: 'Box', medium_unit: null, small_unit: null, large_to_medium: 1, medium_to_small: 1,
    };
    const canonicalDrug = { ...oldDrug, id: 20, trade_name: 'Canonical', trade_name_en: 'Canonical' };
    const dbSelect = jest.fn()
      .mockResolvedValueOnce([oldDrug])
      .mockResolvedValueOnce([canonicalDrug]);
    jest.doMock('@/lib/db/tauri', () => ({ dbSelect }));
    jest.doMock('@/lib/env', () => ({ isClient: true, isTauri: true }));

    const { secureCache } = require('@/lib/cache/secure_cache');
    jest.advanceTimersByTime(501);
    await Promise.resolve();
    await Promise.resolve();
    expect(secureCache.getDrug(10)).toMatchObject({ id: 10 });

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'pharma:drug-identity-updated',
      newValue: JSON.stringify({ sourceIds: [10], targetId: 20, nonce: 'other-window' }),
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(dbSelect).toHaveBeenCalledTimes(2);
    expect(secureCache.getDrug(10)).toBeUndefined();
    expect(secureCache.getDrug(20)).toMatchObject({ id: 20, trade_name: 'Canonical' });
  });

  test('reloads the catalog cache when another Tauri window broadcasts a catalog metadata update', async () => {
    const before = {
      id: 101, trade_name: 'Before Catalog Update', trade_name_en: 'Before Catalog Update', generic_name: '',
      active_ingredient: '', barcode: 'CAT-101', manufacturer: 'Old Manufacturer', is_medicine: 1, is_service: 0,
      stop_dealing: 0, official_price: 20, has_expiry: 1,
      large_unit: 'Box', medium_unit: null, small_unit: null, large_to_medium: 1, medium_to_small: 1,
    };
    const after = { ...before, manufacturer: 'Updated Manufacturer', official_price: 25 };
    const dbSelect = jest.fn()
      .mockResolvedValueOnce([before])
      .mockResolvedValueOnce([after]);
    jest.doMock('@/lib/db/tauri', () => ({ dbSelect }));
    jest.doMock('@/lib/env', () => ({ isClient: true, isTauri: true }));

    const { secureCache } = require('@/lib/cache/secure_cache');
    jest.advanceTimersByTime(501);
    await Promise.resolve();
    await Promise.resolve();
    expect(secureCache.getDrug(101)).toMatchObject({ manufacturer: 'Old Manufacturer', official_price: 20 });

    window.dispatchEvent(new StorageEvent('storage', {
      key: 'pharma:drug-catalog-updated',
      newValue: 'other-window-catalog-update',
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(dbSelect).toHaveBeenCalledTimes(2);
    expect(secureCache.getDrug(101)).toMatchObject({ manufacturer: 'Updated Manufacturer', official_price: 25 });
  });

  test('does not let an older in-flight load reinsert a deleted drug after reload', async () => {
    const oldDrug = {
      id: 10, trade_name: 'Old duplicate', trade_name_en: 'Old duplicate', generic_name: '',
      active_ingredient: '', barcode: '123', manufacturer: '', is_medicine: 1, is_service: 0,
      stop_dealing: 0, official_price: 20, has_expiry: 1,
      large_unit: 'Box', medium_unit: null, small_unit: null, large_to_medium: 1, medium_to_small: 1,
    };
    const canonicalDrug = { ...oldDrug, id: 20, trade_name: 'Canonical', trade_name_en: 'Canonical' };

    let resolveOld!: (rows: typeof oldDrug[]) => void;
    let resolveCanonical!: (rows: typeof canonicalDrug[]) => void;
    const oldLoad = new Promise<typeof oldDrug[]>(resolve => { resolveOld = resolve; });
    const canonicalLoad = new Promise<typeof canonicalDrug[]>(resolve => { resolveCanonical = resolve; });
    const dbSelect = jest.fn()
      .mockReturnValueOnce(oldLoad)
      .mockReturnValueOnce(canonicalLoad);
    jest.doMock('@/lib/db/tauri', () => ({ dbSelect }));
    jest.doMock('@/lib/env', () => ({ isClient: true, isTauri: false }));

    const { secureCache } = require('@/lib/cache/secure_cache');
    const staleLoadPromise = secureCache.load();
    await Promise.resolve();
    expect(dbSelect).toHaveBeenCalledTimes(1);

    const reloadPromise = secureCache.reload();
    await Promise.resolve();
    expect(dbSelect).toHaveBeenCalledTimes(2);

    resolveCanonical([canonicalDrug]);
    await reloadPromise;
    resolveOld([oldDrug]);
    await staleLoadPromise;

    expect(secureCache.getDrug(10)).toBeUndefined();
    expect(secureCache.getDrug(20)).toMatchObject({ id: 20, trade_name: 'Canonical' });
    expect(secureCache.getAllDrugs()).toEqual([canonicalDrug]);
  });
});
