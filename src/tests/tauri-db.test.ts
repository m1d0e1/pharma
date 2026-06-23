jest.mock('uuid', () => ({ v4: () => '00000000-0000-0000-0000-000000000000' }));

// Note: In Jest (jsdom), isServer is always true due to JEST_WORKER_ID check.
// Tauri/web client branches require integration test environment with real window.
// These tests verify the server branch routing only.

describe('Tauri DB — Server branch (isServer = true)', () => {
  beforeEach(() => { jest.resetModules(); });

  it('dbSelect routes to better-sqlite3 query', async () => {
    const mockQuery = jest.fn(() => [{ id: 1, name: 'test' }]);
    jest.doMock('@/lib/db/client', () => ({
      query: mockQuery,
      execute: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
      transaction: jest.fn((cb) => cb()),
    }));
    const { dbSelect } = await import('@/lib/db/tauri');
    const result = await dbSelect('SELECT * FROM users');
    expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM users', []);
    expect(result).toEqual([{ id: 1, name: 'test' }]);
  });

  it('dbExecute routes to better-sqlite3 execute', async () => {
    const mockExecute = jest.fn(() => ({ changes: 3, lastInsertRowid: 99 }));
    jest.doMock('@/lib/db/client', () => ({
      query: jest.fn(() => []),
      execute: mockExecute,
      transaction: jest.fn((cb) => cb()),
    }));
    const { dbExecute } = await import('@/lib/db/tauri');
    const result = await dbExecute('DELETE FROM test');
    expect(mockExecute).toHaveBeenCalledWith('DELETE FROM test', []);
    expect(result.rowsAffected).toBe(3);
  });

  it('dbTransaction executes callback', async () => {
    jest.doMock('@/lib/db/client', () => ({
      query: jest.fn(() => []),
      execute: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
      transaction: jest.fn(async (cb: Function) => await cb()),
    }));
    const { dbTransaction } = await import('@/lib/db/tauri');
    const callback = jest.fn(() => Promise.resolve('transaction-result'));
    const result = await dbTransaction(callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(result).toBe('transaction-result');
  });

  it('dbGet returns first row from dbSelect', async () => {
    jest.doMock('@/lib/db/client', () => ({
      query: jest.fn(() => [{ id: 42 }]),
      execute: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
      transaction: jest.fn((cb) => cb()),
    }));
    const { dbGet } = await import('@/lib/db/tauri');
    const row = await dbGet('SELECT * FROM users LIMIT 1');
    expect(row).toEqual({ id: 42 });
  });

  it('dbGet returns null for empty result', async () => {
    jest.doMock('@/lib/db/client', () => ({
      query: jest.fn(() => []),
      execute: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
      transaction: jest.fn((cb) => cb()),
    }));
    const { dbGet } = await import('@/lib/db/tauri');
    const row = await dbGet('SELECT * FROM users WHERE 0=1');
    expect(row).toBeNull();
  });
});
