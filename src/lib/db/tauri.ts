// Database Abstraction Layer for Tauri and Web
import { v4 as uuidv4 } from 'uuid';

export function generateId(): string {
  return uuidv4();
}

const isTauriEnv = () => typeof window !== 'undefined' && (
  (window as any).__TAURI__ !== undefined || 
  (window as any).__TAURI_INTERNALS__ !== undefined
);
const isServer = typeof window === 'undefined' || process.env.JEST_WORKER_ID !== undefined;

let tauriDb: any = null;

async function getTauriDb() {
  if (!tauriDb) {
    const DatabasePlugin = (await import('@tauri-apps/plugin-sql')).default;
    tauriDb = await DatabasePlugin.load('sqlite:pharma_local.db');
  }
  return tauriDb;
}

export async function dbSelect<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  if (isServer) {
    // Server-side: import and query better-sqlite3 directly (web dev mode)
    const { query } = require('./client');
    return query(sql, params);
  }

  if (isTauriEnv()) {
    const db = await getTauriDb();
    return db.select(sql, params);
  }

  // Web client-side: call database server action
  const { serverDbSelect } = await import('@/app/actions-client/db');
  const result = await serverDbSelect(sql, params);
  if (!result.success) throw new Error(result.error || 'Database query failed');
  return result.data || [];
}

export async function dbGet<T = any>(sql: string, params: any[] = []): Promise<T | null> {
  const results = await dbSelect<T>(sql, params);
  return results.length > 0 ? results[0] : null;
}

export async function dbExecute(
  sql: string,
  params: any[] = []
): Promise<{ rowsAffected: number; lastInsertId?: number }> {
  if (isServer) {
    // Server-side: import and execute better-sqlite3 directly (web dev mode)
    const { execute } = require('./client');
    const result = execute(sql, params);
    return {
      rowsAffected: result.changes,
      lastInsertId: Number(result.lastInsertRowid),
    };
  }

  if (isTauriEnv()) {
    const db = await getTauriDb();
    const result = await db.execute(sql, params);
    return {
      rowsAffected: result.rowsAffected,
      lastInsertId: result.lastInsertId,
    };
  }

  // Web client-side: call database server action
  const { serverDbExecute } = await import('@/app/actions-client/db');
  const result = await serverDbExecute(sql, params);
  if (!result.success) throw new Error(result.error || 'Database execution failed');
  return result.data;
}

export async function dbTransaction<T>(callback: () => Promise<T>): Promise<T> {
  if (isServer) {
    const { transaction } = require('./client');
    return transaction(async () => {
      return await callback();
    });
  }

  if (isTauriEnv()) {
    // Tauri's plugin-sql connection pool distributes queries across connections.
    // Manual transaction commands (BEGIN/COMMIT) cause pool deadlocks/database locks.
    // We execute the operations directly as atomic statements.
    return await callback();
  }

  // Web client-side: execute the callback directly to run queries sequentially.
  return await callback();
}
