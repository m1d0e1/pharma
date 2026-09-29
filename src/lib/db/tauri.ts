// Database Abstraction Layer for Tauri and Web
import { isTauri as isTauriEnv } from '@/lib/env';

export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const isServer = typeof window === 'undefined' || process.env.JEST_WORKER_ID !== undefined;

let tauriDbPromise: Promise<any> | null = null;
let tauriWriteQueue: Promise<unknown> = Promise.resolve();

const sqliteUtcTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const utcTimestampColumn = /(?:_at|_time|_on|^shift_start$|^shift_end$|^last_login$)$/;

export function normalizeDatabaseTimestamps<T>(rows: T[]): T[] {
  const sample = rows.find(
    row => row !== null && typeof row === 'object' && !Array.isArray(row)
  ) as Record<string, unknown> | undefined;

  // Every row in a SQL result has the same columns. Most large lookups contain no
  // timestamps, so avoid walking and cloning every value in those result sets.
  const timestampKeys = sample
    ? Object.keys(sample).filter(key => utcTimestampColumn.test(key))
    : [];
  if (timestampKeys.length === 0) return rows;

  return rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const record = row as Record<string, unknown>;
    let normalized: Record<string, unknown> | null = null;

    for (const key of timestampKeys) {
      const value = record[key];
      if (typeof value === 'string' && sqliteUtcTimestamp.test(value)) {
        normalized ??= { ...record };
        normalized[key] = `${value.replace(' ', 'T')}Z`;
      }
    }

    return (normalized ?? row) as T;
  });
}

async function executeTauri(
  sql: string,
  params: any[] = [],
  txId: string | null = null
): Promise<{ rowsAffected: number; lastInsertId?: number }> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('db_execute_guarded', { sql, params, txId });
}

async function selectTauriTransaction<T = any>(txId: string, sql: string, params: any[] = []): Promise<T[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  return normalizeDatabaseTimestamps(await invoke<T[]>('db_select_guarded', { sql, params, txId }));
}

function enqueueTauriWrite<T>(run: () => Promise<T>): Promise<T> {
  const next = tauriWriteQueue.then(run, run);
  tauriWriteQueue = next.catch(() => undefined);
  return next;
}

export function runTauriStandaloneWrite(
  sql: string,
  params: any[] = []
): Promise<{ rowsAffected: number; lastInsertId?: number }> {
  return enqueueTauriWrite(() => executeTauri(sql, params, null));
}

export interface TransactionDb {
  select: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
  get: <T = any>(sql: string, params?: any[]) => Promise<T | null>;
  execute: (sql: string, params?: any[]) => Promise<{ rowsAffected: number; lastInsertId?: number }>;
  prepare: (sql: string) => {
    all: (...params: any[]) => Promise<any[]>;
    get: (...params: any[]) => Promise<any | null>;
    run: (...params: any[]) => Promise<{
      changes: number;
      lastInsertRowid?: number;
      rowsAffected: number;
      lastInsertId?: number;
    }>;
  };
  transaction: <TArgs extends any[], TResult>(callback: (db: TransactionDb, ...args: TArgs) => Promise<TResult>) => (...args: TArgs) => Promise<TResult>;
  exec: (sql: string) => Promise<{ rowsAffected: number; lastInsertId?: number }>;
}

function normalizeParams(params: any[]): any[] {
  const values = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return values.map(value => value === undefined ? null : value);
}

function createTransactionDb(
  select: <T = any>(sql: string, params?: any[]) => Promise<T[]>,
  execute: (sql: string, params?: any[]) => Promise<{ rowsAffected: number; lastInsertId?: number }>
): TransactionDb {
  const transactionDb: TransactionDb = {
    select: (sql, params = []) => select(sql, normalizeParams(params)),
    get: async (sql, params = []) => {
      const rows = await select(sql, normalizeParams(params));
      return rows.length > 0 ? rows[0] : null;
    },
    execute: (sql, params = []) => execute(sql, normalizeParams(params)),
    prepare: (sql: string) => ({
      all: (...params: any[]) => select(sql, normalizeParams(params)),
      get: async (...params: any[]) => {
        const rows = await select(sql, normalizeParams(params));
        return rows.length > 0 ? rows[0] : null;
      },
      run: async (...params: any[]) => {
        const result = await execute(sql, normalizeParams(params));
        return {
          changes: result.rowsAffected,
          lastInsertRowid: result.lastInsertId,
          rowsAffected: result.rowsAffected,
          lastInsertId: result.lastInsertId,
        };
      },
    }),
    transaction: (callback) => (...args) => callback(transactionDb, ...args),
    exec: (sql: string) => execute(sql, []),
  };
  return transactionDb;
}

async function getTauriDb() {
  if (!tauriDbPromise) {
    tauriDbPromise = (async () => {
      const DatabasePlugin = (await import('@tauri-apps/plugin-sql')).default;
      const database = await DatabasePlugin.load('sqlite:pharma_local.db');
      return database;
    })().catch(error => {
      tauriDbPromise = null;
      throw error;
    });
  }
  return tauriDbPromise;
}

export async function dbSelect<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const safeParams = params.map(p => p === undefined ? null : p);
  if (isServer) {
    // Server-side: import and query better-sqlite3 directly (web dev mode)
    const { query } = require('./client');
    return normalizeDatabaseTimestamps(query(sql, safeParams));
  }

  if (isTauriEnv) {
    const db = await getTauriDb();
    return normalizeDatabaseTimestamps(await db.select(sql, safeParams));
  }

  // Web client-side: call database server action
  const { serverDbSelect } = await import('@/app/actions-client/db');
  const result = await serverDbSelect(sql, safeParams);
  if (!result.success) throw new Error(result.error || 'Database query failed');
  return normalizeDatabaseTimestamps((result.data || []) as T[]);
}

export async function dbGet<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const results = await dbSelect<T>(sql, params);
  return results.length > 0 ? results[0] : null;
}

export async function dbExecute(
  sql: string,
  params: any[] = []
): Promise<{ rowsAffected: number; lastInsertId?: number }> {
  // Map undefined to null to prevent serialization errors in Tauri IPC
  const safeParams = params.map(p => p === undefined ? null : p);
  if (isServer) {
    // Server-side: import and execute better-sqlite3 directly (web dev mode)
    const { execute } = require('./client');
    const result = execute(sql, safeParams);
    return {
      rowsAffected: result.changes,
      lastInsertId: Number(result.lastInsertRowid),
    };
  }

  if (isTauriEnv) {
    await getTauriDb();
    return runTauriStandaloneWrite(sql, safeParams);
  }

  // Web client-side: call database server action
  const { serverDbExecute } = await import('@/app/actions-client/db');
  const result = await serverDbExecute(sql, safeParams);
  if (!result.success) throw new Error(result.error || 'Database execution failed');
  return result.data;
}

export async function dbTransaction<T>(callback: (transactionDb: TransactionDb) => Promise<T>): Promise<T> {
  if (isServer) {
    const { transaction } = require('./client');
    return transaction(async () => {
      return await callback(createTransactionDb(dbSelect, dbExecute));
    });
  }

  if (isTauriEnv) {
    return runTauriTransaction(await getTauriDb(), callback);
  }

  // Web client-side: execute the callback directly to run queries sequentially.
  return await callback(createTransactionDb(dbSelect, dbExecute));
}

export async function runTauriTransaction<T>(_db: any, callback: (transactionDb: TransactionDb) => Promise<T>): Promise<T> {
  const run = async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const txId = await invoke<string>('db_transaction_begin');
    const transactionDb = createTransactionDb(
      <TRow = any>(sql: string, params: any[] = []) => selectTauriTransaction<TRow>(txId, sql, params),
      (sql: string, params: any[] = []) => executeTauri(sql, params, txId)
    );
    try {
      const result = await callback(transactionDb);
      await invoke('db_transaction_finish', { txId, commit: true });
      return result;
    } catch (error) {
      try {
        await invoke('db_transaction_finish', { txId, commit: false });
      } catch (rollbackError) {
        console.error('Failed to rollback Tauri transaction:', rollbackError);
      }
      throw error;
    }
  };

  return enqueueTauriWrite(run);
}
