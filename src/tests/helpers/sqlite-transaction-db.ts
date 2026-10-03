import type Database from 'better-sqlite3';
import type { TransactionDb } from '@/lib/db/tauri';

export function createFunctionTransactionDb(handlers: {
  select: (sql: string, params?: unknown[]) => Promise<any[]> | any[];
  get: (sql: string, params?: unknown[]) => Promise<any | null> | any | null;
  execute: (sql: string, params?: unknown[]) => Promise<{ rowsAffected: number; lastInsertId?: number | null }> | { rowsAffected: number; lastInsertId?: number | null };
}): TransactionDb {
  const transactionDb: TransactionDb = {
    select: async (sql, params = []) => handlers.select(sql, params),
    get: async (sql, params = []) => handlers.get(sql, params),
    execute: async (sql, params = []) => {
      const result = await handlers.execute(sql, params);
      return { rowsAffected: result.rowsAffected, lastInsertId: result.lastInsertId ?? undefined };
    },
    prepare: (sql) => ({
      all: async (...params) => handlers.select(sql, params),
      get: async (...params) => handlers.get(sql, params),
      run: async (...params) => {
        const result = await handlers.execute(sql, params);
        return {
          changes: result.rowsAffected,
          lastInsertRowid: result.lastInsertId ?? undefined,
          rowsAffected: result.rowsAffected,
          lastInsertId: result.lastInsertId ?? undefined,
        };
      },
    }),
    transaction: (callback) => (...args) => callback(transactionDb, ...args),
    exec: async (sql) => {
      const result = await handlers.execute(sql, []);
      return { rowsAffected: result.rowsAffected, lastInsertId: result.lastInsertId ?? undefined };
    },
  };
  return transactionDb;
}

export function createSqliteTransactionDb(database: Database.Database): TransactionDb {
  return createFunctionTransactionDb({
    select: async (sql, params = []) => database.prepare(sql).all(...params),
    get: async (sql, params = []) => database.prepare(sql).get(...params) ?? null,
    execute: async (sql, params = []) => {
      const result = database.prepare(sql).run(...params);
      return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
    },
  });
}
