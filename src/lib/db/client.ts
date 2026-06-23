import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';

function getDatabasePath(): string {
  if (process.env.PHARMA_DB_PATH) {
    return process.env.PHARMA_DB_PATH;
  }

  // Prevent Next.js standalone tracer from copying the local database during build
  if (process.env.npm_lifecycle_event === 'build' || process.env.NEXT_PHASE === 'phase-production-build') {
    return join(process.cwd(), 'pharma_local.db');
  }

  try {
    const os = require('os');
    if (os.platform() === 'win32') {
      const appDataDb = join(os.homedir(), 'AppData', 'Roaming', 'com.pharma.system', 'pharma_local.db');
      if (existsSync(appDataDb)) {
        return appDataDb;
      }
    }
  } catch (e) {
    // Fallback if os module fails for any reason
  }

  return join(process.cwd(), 'pharma_local.db');
}

export const DB_PATH = getDatabasePath();

let db: Database.Database | null = null;
const statementCache = new Map<string, Database.Statement>();
const MAX_CACHE_SIZE = 500;

export function getDatabase(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);

    // Cache prepared statements globally to prevent query compilation overhead
    const originalPrepare = db.prepare.bind(db);
    db.prepare = function (sql: string) {
      let stmt = statementCache.get(sql);
      if (stmt) {
        // LRU behavior: move accessed item to the end (most recently used)
        statementCache.delete(sql);
        statementCache.set(sql, stmt);
      } else {
        if (statementCache.size >= MAX_CACHE_SIZE) {
          // LRU eviction: the first key is the least recently used
          const firstKey = statementCache.keys().next().value;
          if (firstKey !== undefined) {
            statementCache.delete(firstKey);
          }
        }
        stmt = originalPrepare(sql);
        statementCache.set(sql, stmt);
      }
      return stmt;
    } as any;

    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');

    // Faster writes in WAL mode
    db.pragma('synchronous = NORMAL');

    // Enable foreign keys
    db.pragma('foreign_keys = ON');

    // Set busy timeout to 5 seconds
    db.pragma('busy_timeout = 5000');

    // Larger cache size (10MB)
    db.pragma('cache_size = -10000');

    // Memory-mapped I/O (512MB) for better read performance
    db.pragma('mmap_size = 536870912');

    // Page size hint (helps with large reads)
    db.pragma('page_size = 4096');

    // Temp store in memory
    db.pragma('temp_store = MEMORY');

    // Increase WAL auto-checkpoint threshold (reduces checkpoint frequency)
    db.pragma('wal_autocheckpoint = 1000');

    // Register custom REGEXP function for advanced searching
    db.function('regexp', (pattern: string, text: string) => {
      if (!text) return 0;
      try {
        const regex = new RegExp(pattern, 'i');
        return regex.test(text) ? 1 : 0;
      } catch (e) {
        return 0;
      }
    });

    // Dynamically call initLocalDb to ensure tables, migrations, and seeds are applied on the server
    try {
      const { initLocalDb } = require('./local');
      initLocalDb();
    } catch (e) {
      console.error("Failed to initialize database tables:", e);
    }
  }

  return db;
}

export function closeDatabase(): void {
  if (db) {
    statementCache.clear();
    db.close();
    db = null;
  }
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}


export function query<T = any>(sql: string, params: any[] = []): T[] {
  const database = getDatabase();
  const stmt = database.prepare(sql);
  const results = stmt.all(...params) as T[];
  
  if (results.length > 0 && sql.toLowerCase().includes('master_drugs')) {
    try {
      const { secureCache } = require('@/lib/cache/secure_cache');
      const enriched = secureCache.enrich(results);
      if (enriched.length > 0) {
        return enriched;
      }
    } catch(e) {
      // cache not ready, return raw results
    }
  }
  return results;
}


export function execute(sql: string, params: any[] = []): RunResult {
  const database = getDatabase();
  const stmt = database.prepare(sql);
  const result = stmt.run(...params);
  return {
    changes: result.changes,
    lastInsertRowid: result.lastInsertRowid,
  };
}

export function get<T = any>(sql: string, params: any[] = []): T | undefined {
  const database = getDatabase();
  const stmt = database.prepare(sql);
  return stmt.get(...params) as T | undefined;
}


export async function transaction<T>(
  callback: (db: Database.Database) => Promise<T>
): Promise<T> {
  const database = getDatabase();
  database.exec('BEGIN TRANSACTION');
  try {
    const result = await callback(database);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}


export function generateId(): string {
  return crypto.randomUUID();
}

export function backup(backupPath: string): void {
  const database = getDatabase();
  database.backup(backupPath).step(-1);
}

export function restore(backupPath: string): void {
  closeDatabase();
  const backupDb = new Database(backupPath);
  const newDb = new Database(DB_PATH);
  backupDb.backup(newDb).step(-1);
  backupDb.close();
  newDb.close();
}

export function getDatabaseSize(): number {
  const stats = getDatabase().pragma('page_count') as { page_count: number };
  const pageSize = getDatabase().pragma('page_size') as { page_size: number };
  return stats.page_count * pageSize.page_size;
}

export function vacuum(): void {
  getDatabase().exec('VACUUM');
}

export function analyze(): void {
  getDatabase().exec('ANALYZE');
}
