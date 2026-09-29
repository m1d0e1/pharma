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
});
