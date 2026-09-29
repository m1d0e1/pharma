import Database from 'better-sqlite3';

let mockDb: Database.Database;
let sessionQueue: any[];

jest.mock('@/lib/auth/local', () => ({
  ...jest.requireActual('@/lib/auth/local'),
  getLocalSession: jest.fn(async () => sessionQueue.shift() ?? null),
  hashPassword: jest.fn(async () => 'test-password-hash'),
}));

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'generated-id'),
}));

import { deleteUserAction, updateUserAction } from '@/app/actions-client/users';

describe('staff last-owner concurrency', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT,
        full_name TEXT,
        role TEXT,
        pharmacy_id TEXT,
        is_active INTEGER DEFAULT 1,
        password_hash TEXT,
        permissions TEXT,
        job_id INTEGER,
        qualification TEXT,
        hire_date TEXT,
        shift TEXT,
        code TEXT
      );
      CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT);
      CREATE TABLE shifts (id TEXT, user_id TEXT, pharmacy_id TEXT, status TEXT, start_time TEXT);
      INSERT INTO users (id, username, full_name, role, pharmacy_id, is_active) VALUES
        ('owner-a', 'owner-a', 'Owner A', 'owner', 'ph-1', 1),
        ('owner-b', 'owner-b', 'Owner B', 'owner', 'ph-1', 1);
    `);
    sessionQueue = [
      { id: 'owner-a', role: 'owner', pharmacy_id: 'ph-1' },
      { id: 'owner-b', role: 'owner', pharmacy_id: 'ph-1' },
    ];
  });

  afterEach(() => mockDb.close());

  it('allows only one of two concurrent owner demotions in the same pharmacy', async () => {
    const [first, second] = await Promise.all([
      updateUserAction('owner-b', { username: 'owner-b', full_name: 'Owner B', role: 'admin' }),
      updateUserAction('owner-a', { username: 'owner-a', full_name: 'Owner A', role: 'admin' }),
    ]);

    expect([first.success, second.success].filter(Boolean)).toHaveLength(1);
    expect((mockDb.prepare(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE role = 'owner' AND is_active = 1 AND pharmacy_id = 'ph-1'
    `).get() as { count: number }).count).toBe(1);
  });

  it('allows only one of two owners to concurrently deactivate the other owner', async () => {
    const [first, second] = await Promise.all([
      deleteUserAction('owner-b'),
      deleteUserAction('owner-a'),
    ]);

    expect([first.success, second.success].filter(Boolean)).toHaveLength(1);
    expect((mockDb.prepare(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE role = 'owner' AND is_active = 1 AND pharmacy_id = 'ph-1'
    `).get() as { count: number }).count).toBe(1);
  });
});
