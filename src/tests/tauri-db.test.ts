jest.mock('uuid', () => ({ v4: () => '00000000-0000-0000-0000-000000000000' }));

// Most tests exercise the server branch; the native routing regression below
// temporarily selects the Tauri environment in jsdom.

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

  it('runTauriTransaction commits successful work', async () => {
    const calls: string[] = [];
    jest.doMock('@tauri-apps/api/core', () => ({
      invoke: jest.fn((command: string, args?: any) => {
        calls.push(command === 'db_transaction_finish' ? `${command}:${args.commit}` : command);
        return Promise.resolve(command === 'db_transaction_begin' ? 'tx-1' : {});
      }),
    }));
    const { runTauriTransaction } = await import('@/lib/db/tauri');

    const result = await runTauriTransaction(null, async () => {
      calls.push('WORK');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(calls).toEqual(['db_transaction_begin', 'WORK', 'db_transaction_finish:true']);
  });

  it('runTauriTransaction rolls back failed work', async () => {
    const calls: string[] = [];
    jest.doMock('@tauri-apps/api/core', () => ({
      invoke: jest.fn((command: string, args?: any) => {
        calls.push(command === 'db_transaction_finish' ? `${command}:${args.commit}` : command);
        return Promise.resolve(command === 'db_transaction_begin' ? 'tx-1' : {});
      }),
    }));
    const { runTauriTransaction } = await import('@/lib/db/tauri');

    await expect(runTauriTransaction(null, async () => {
      calls.push('WORK');
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(calls).toEqual(['db_transaction_begin', 'WORK', 'db_transaction_abort']);
  });

  it('aborts an open native transaction when license denial blocks committing it', async () => {
    const invoke = jest.fn((command: string, args?: any) => {
      if (command === 'db_transaction_begin') return Promise.resolve('tx-expiring');
      if (command === 'db_transaction_finish' && args?.commit) {
        return Promise.reject(new Error('License required: License has expired'));
      }
      if (command === 'db_transaction_abort') return Promise.resolve();
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    jest.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const { runTauriTransaction } = await import('@/lib/db/tauri');

    await expect(runTauriTransaction(null, async () => 'completed')).rejects.toThrow('License required');
    expect(invoke).toHaveBeenCalledWith('db_transaction_finish', { txId: 'tx-expiring', commit: true });
    expect(invoke).toHaveBeenCalledWith('db_transaction_abort', { txId: 'tx-expiring' });
  });

  it('binds transactional reads and writes to the explicit transaction id', async () => {
    const invoke = jest.fn((command: string, args?: any) => {
      if (command === 'db_transaction_begin') return Promise.resolve('tx-bound');
      if (command === 'db_execute_guarded') return Promise.resolve({ rowsAffected: 1, lastInsertId: 7 });
      if (command === 'db_select_guarded') return Promise.resolve([{ id: 7 }]);
      if (command === 'db_transaction_finish') return Promise.resolve({});
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    jest.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const { runTauriTransaction } = await import('@/lib/db/tauri');

    const result = await runTauriTransaction(null, async (db) => {
      await db.prepare('INSERT INTO test(name) VALUES (?)').run('bound');
      return await db.prepare('SELECT id FROM test WHERE name = ?').get('bound');
    });

    expect(result).toEqual({ id: 7 });
    expect(invoke).toHaveBeenCalledWith('db_execute_guarded', expect.objectContaining({ txId: 'tx-bound' }));
    expect(invoke).toHaveBeenCalledWith('db_select_guarded', expect.objectContaining({ txId: 'tx-bound' }));
    expect(invoke).toHaveBeenCalledWith('db_transaction_finish', { txId: 'tx-bound', commit: true });
  });

  it('reuses the explicit transaction context for nested transaction helpers', async () => {
    const invoke = jest.fn((command: string, args?: any) => {
      if (command === 'db_transaction_begin') return Promise.resolve('tx-outer');
      if (command === 'db_execute_guarded') return Promise.resolve({ rowsAffected: 1, lastInsertId: 1 });
      if (command === 'db_transaction_finish') return Promise.resolve({});
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    jest.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const { runTauriTransaction } = await import('@/lib/db/tauri');

    await runTauriTransaction(null, async (db) => {
      const nested = db.transaction(async (nestedDb) => {
        await nestedDb.prepare('UPDATE test SET name = ? WHERE id = ?').run('nested', 1);
      });
      await nested();
    });

    expect(invoke.mock.calls.filter(([command]) => command === 'db_transaction_begin')).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('db_execute_guarded', expect.objectContaining({ txId: 'tx-outer' }));
  });

  it('serializes unrelated transactions and keeps rollback/success contexts isolated', async () => {
    let txCounter = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const finishes: Array<{ txId: string; commit: boolean }> = [];
    const invoke = jest.fn((command: string, args?: any) => {
      if (command === 'db_transaction_begin') {
        const txId = `tx-${++txCounter}`;
        if (txId === 'tx-1') markFirstStarted();
        return Promise.resolve(txId);
      }
      if (command === 'db_execute_guarded') return Promise.resolve({ rowsAffected: 1, lastInsertId: 1 });
      if (command === 'db_transaction_finish') {
        finishes.push(args);
        return Promise.resolve({});
      }
      if (command === 'db_transaction_abort') {
        finishes.push({ txId: args.txId, commit: false });
        return Promise.resolve({});
      }
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    jest.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const { runTauriTransaction } = await import('@/lib/db/tauri');

    const first = runTauriTransaction(null, async (db) => {
      await db.prepare('UPDATE test SET name = ? WHERE id = ?').run('first', 1);
      await firstGate;
      throw new Error('rollback-first');
    });
    await firstStarted;

    const second = runTauriTransaction(null, async (db) => {
      await db.prepare('UPDATE test SET name = ? WHERE id = ?').run('second', 2);
      return 'second-ok';
    });

    expect(invoke.mock.calls.filter(([command]) => command === 'db_transaction_begin')).toHaveLength(1);
    releaseFirst();
    await expect(first).rejects.toThrow('rollback-first');
    await expect(second).resolves.toBe('second-ok');

    expect(invoke.mock.calls.filter(([command]) => command === 'db_transaction_begin')).toHaveLength(2);
    expect(finishes).toEqual([
      { txId: 'tx-1', commit: false },
      { txId: 'tx-2', commit: true },
    ]);
    const writeTxIds = invoke.mock.calls
      .filter(([command]) => command === 'db_execute_guarded')
      .map(([, args]) => args.txId);
    expect(writeTxIds).toEqual(['tx-1', 'tx-2']);
  });

  it('queues an unrelated standalone Tauri write until the active transaction finishes', async () => {
    let releaseTransaction!: () => void;
    let markTransactionStarted!: () => void;
    const transactionGate = new Promise<void>(resolve => { releaseTransaction = resolve; });
    const transactionStarted = new Promise<void>(resolve => { markTransactionStarted = resolve; });
    const invoke = jest.fn((command: string, args?: any) => {
      if (command === 'db_transaction_begin') {
        markTransactionStarted();
        return Promise.resolve('tx-active');
      }
      if (command === 'db_execute_guarded') return Promise.resolve({ rowsAffected: 1, lastInsertId: 1 });
      if (command === 'db_transaction_finish') return Promise.resolve({});
      return Promise.reject(new Error(`Unexpected command: ${command}`));
    });
    jest.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const { runTauriStandaloneWrite, runTauriTransaction } = await import('@/lib/db/tauri');

    const transaction = runTauriTransaction(null, async (db) => {
      await db.prepare('UPDATE test SET name = ? WHERE id = ?').run('inside', 1);
      await transactionGate;
    });
    await transactionStarted;

    const standalone = runTauriStandaloneWrite('UPDATE test SET name = ? WHERE id = ?', ['outside', 2]);
    await Promise.resolve();
    expect(invoke.mock.calls.some(([command, args]) =>
      command === 'db_execute_guarded' && args?.params?.[0] === 'outside')).toBe(false);

    releaseTransaction();
    await transaction;
    await standalone;

    const standaloneCall = invoke.mock.calls.find(([command, args]) =>
      command === 'db_execute_guarded' && args?.params?.[0] === 'outside');
    expect(standaloneCall?.[1]?.txId).toBeNull();
    const finishIndex = invoke.mock.calls.findIndex(([command]) => command === 'db_transaction_finish');
    const standaloneIndex = invoke.mock.calls.findIndex(([command, args]) =>
      command === 'db_execute_guarded' && args?.params?.[0] === 'outside');
    expect(standaloneIndex).toBeGreaterThan(finishIndex);
  });
});

describe('Tauri DB — guarded standalone reads', () => {
  it('routes reads through the native guard and normalizes timestamps', async () => {
    const oldWorkerId = process.env.JEST_WORKER_ID;
    const oldTauriFlag = process.env.NEXT_PUBLIC_TAURI;
    delete process.env.JEST_WORKER_ID;
    process.env.NEXT_PUBLIC_TAURI = '1';
    jest.resetModules();

    const pluginSelect = jest.fn();
    const pluginLoad = jest.fn(async () => ({ select: pluginSelect }));
    const invoke = jest.fn(async () => [{ created_at: '2026-10-09 12:34:56' }]);
    jest.doMock('@tauri-apps/plugin-sql', () => ({ __esModule: true, default: { load: pluginLoad } }));
    jest.doMock('@tauri-apps/api/core', () => ({ invoke }));

    try {
      const { dbSelect } = await import('@/lib/db/tauri');
      const rows = await dbSelect('SELECT created_at FROM users WHERE id = ?', [undefined]);

      expect(pluginLoad).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledWith('db_select_guarded', {
        sql: 'SELECT created_at FROM users WHERE id = ?',
        params: [null],
        txId: null,
      });
      expect(pluginSelect).not.toHaveBeenCalled();
      expect(rows).toEqual([{ created_at: '2026-10-09T12:34:56Z' }]);
    } finally {
      if (oldWorkerId === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = oldWorkerId;
      if (oldTauriFlag === undefined) delete process.env.NEXT_PUBLIC_TAURI;
      else process.env.NEXT_PUBLIC_TAURI = oldTauriFlag;
      jest.resetModules();
    }
  });

  it('uses a tenant-bound native query ID instead of renderer SQL for inventory paging', async () => {
    const oldWorker = process.env.JEST_WORKER_ID;
    const oldFlag = process.env.NEXT_PUBLIC_TAURI;
    delete process.env.JEST_WORKER_ID;
    process.env.NEXT_PUBLIC_TAURI = '1';
    jest.resetModules();
    const invoke = jest.fn(async (command: string, args: any) => {
      if (command !== 'db_read_scoped') throw new Error('Unexpected native command');
      return args.offset === 0 ? [{ id: 'pharmacy-owned', created_at: '2026-10-09 12:34:56' }] : [];
    });
    jest.doMock('@tauri-apps/api/core', () => ({ invoke }));
    try {
      const { dbReadScopedAll } = await import('@/lib/db/tauri');
      const rows = await dbReadScopedAll('inventory.enriched', { search: 'aspirin' });
      expect(rows).toEqual([{ id: 'pharmacy-owned', created_at: '2026-10-09T12:34:56Z' }]);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledWith('db_read_scoped', {
        queryId: 'inventory.enriched', recordId: null,
        limit: 200, offset: 0, search: 'aspirin', drugId: null,
      });
    } finally {
      if (oldWorker === undefined) delete process.env.JEST_WORKER_ID;
      else process.env.JEST_WORKER_ID = oldWorker;
      if (oldFlag === undefined) delete process.env.NEXT_PUBLIC_TAURI;
      else process.env.NEXT_PUBLIC_TAURI = oldFlag;
      jest.resetModules();
    }
  });

  it('removes direct SQL plugin permissions so all business DB calls use native licensing guard', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const capability = JSON.parse(fs.readFileSync(
      path.resolve(process.cwd(), 'src-tauri/capabilities/default.json'), 'utf8'
    ));

    expect(capability.permissions).not.toContain('sql:allow-load');
    expect(capability.permissions).not.toContain('sql:allow-close');
    expect(capability.permissions).not.toContain('sql:allow-select');
    expect(capability.permissions).not.toContain('sql:default');
  });
});
