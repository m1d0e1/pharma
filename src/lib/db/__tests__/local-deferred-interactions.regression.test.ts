/** @jest-environment node */

jest.mock('@/scripts/importInteractions', () => ({ importInteractionsFromCSV: jest.fn() }));

describe('deferred local interaction import during startup', () => {
  const originalDbPath = process.env.PHARMA_DB_PATH;

  afterEach(() => {
    try { require('../client').closeDatabase(); } catch {}
    delete (global as any).__db_initialized;
    if (originalDbPath === undefined) delete process.env.PHARMA_DB_PATH;
    else process.env.PHARMA_DB_PATH = originalDbPath;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  async function startWithImport(result: Promise<boolean>) {
    process.env.PHARMA_DB_PATH = ':memory:';
    delete (global as any).__db_initialized;
    jest.resetModules();
    const importer = require('@/scripts/importInteractions').importInteractionsFromCSV as jest.Mock;
    importer.mockReturnValue(result);
    const database = require('../client').getDatabase();
    expect(database.prepare('SELECT COUNT(*) AS count FROM drug_interactions').get().count).toBeGreaterThan(0);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(importer).toHaveBeenCalledTimes(1);
    return database;
  }

  it('reports an import returning false after the synchronous database bootstrap', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await startWithImport(Promise.resolve(false));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Deferred CSV import failed'));
  });

  it('reports an asynchronous rejection without losing the database or an unhandled rejection', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = Promise.reject(new Error('synthetic deferred CSV failure'));
    // The extra handler prevents a process-level unhandled rejection in RED,
    // leaving the startup code responsible for logging the failure itself.
    void failure.catch(() => {});
    const database = await startWithImport(failure);
    expect(database.prepare('SELECT 1 AS ok').get()).toEqual({ ok: 1 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Deferred CSV import failed'),
      expect.objectContaining({ message: 'synthetic deferred CSV failure' }),
    );
  });

  it('keeps a successful import deferred and silent', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await startWithImport(Promise.resolve(true));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Deferred CSV import failed'));
  });
});
