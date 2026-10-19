import Database from 'better-sqlite3';

let mockDb: Database.Database;
let mockTokenSerial = 0;

jest.mock('@/lib/db/client', () => ({
  getDatabase: jest.fn(() => mockDb),
  execute: jest.fn((sql: string, params: unknown[] = []) => mockDb.prepare(sql).run(...params)),
  get: jest.fn((sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  query: jest.fn((sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
}));
jest.mock('@/lib/auth/jwt', () => ({
  generateTokenPair: jest.fn(() => ({ accessToken: 'access', refreshToken: `signed-${++mockTokenSerial}` })),
  verifyRefreshToken: jest.fn(() => 'user-1'),
}));

import {
  createSession, deleteAllUserSessions, deleteExpiredSessions, deleteSession,
  getActiveSessionCount, getSession, getUserSessions, initializeSessionsTable,
  refreshSession, updateSessionAccess, cleanupOldSessions,
} from '@/lib/auth/session';

describe('legacy server session expiry formatting and lifecycle (isolated SQLite)', () => {
  beforeEach(() => {
    mockTokenSerial = 0;
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT, pharmacy_id TEXT,
        role TEXT, permissions TEXT, is_active INTEGER
      );
      INSERT INTO users VALUES('user-1','qa-user','ph-1','owner','["rep_can_view_sales"]',1);
    `);
    initializeSessionsTable();
  });
  afterEach(() => mockDb.close());

  it('does not count ISO-8601 sessions expired earlier on the same UTC date as active', () => {
    const expired = mockDb.prepare("SELECT date('now') || 'T00:00:00.000Z' AS expires_at").get() as { expires_at: string };
    mockDb.prepare(`
      INSERT INTO sessions (id,user_id,refresh_token,expires_at,created_at,last_accessed_at)
      VALUES ('expired','user-1','signed-expired',?,datetime('now'),datetime('now'))
    `).run(expired.expires_at);
    expect(getSession('signed-expired')).toBeNull();
    expect(getUserSessions('user-1')).toEqual([]);
    expect(getActiveSessionCount('user-1')).toBe(0);
    expect(refreshSession('signed-expired')).toBeNull();
    deleteExpiredSessions();
    expect(mockDb.prepare("SELECT COUNT(*) count FROM sessions").get()).toMatchObject({ count: 0 });
  });

  it('creates and rotates an active user session while keeping tenant and permissions', () => {
    const first = createSession({
      userId: 'user-1', username: 'qa-user', pharmacyId: 'ph-1',
      role: 'owner', permissions: ['rep_can_view_sales'],
    }, { userId: 'user-1', ipAddress: '127.0.0.1', userAgent: 'isolated-qa' });
    expect(getSession(first.refreshToken)).toMatchObject({ userId: 'user-1', ipAddress: '127.0.0.1' });
    expect(getActiveSessionCount('user-1')).toBe(1);
    updateSessionAccess(first.refreshToken);
    const replacement = refreshSession(first.refreshToken, { userAgent: 'replaced-qa' });
    expect(replacement?.refreshToken).not.toBe(first.refreshToken);
    expect(getSession(first.refreshToken)).toBeNull();
    expect(getSession(replacement!.refreshToken)).toMatchObject({
      ipAddress: '127.0.0.1', userAgent: 'replaced-qa',
    });
    expect(getActiveSessionCount('user-1')).toBe(1);
    deleteSession(replacement!.refreshToken);
    expect(getActiveSessionCount('user-1')).toBe(0);
  });

  it('invalidates the refresh token when the original user is deactivated', () => {
    const first = createSession({
      userId: 'user-1', username: 'qa-user', pharmacyId: 'ph-1',
      role: 'owner', permissions: [],
    }, { userId: 'user-1' });
    mockDb.prepare('UPDATE users SET is_active=0 WHERE id=?').run('user-1');
    expect(refreshSession(first.refreshToken)).toBeNull();
    expect(getSession(first.refreshToken)).toBeNull();
  });

  it('cleans up old sessions and can revoke all current user sessions', () => {
    createSession({ userId: 'user-1', username: 'qa-user', pharmacyId: 'ph-1', role: 'owner', permissions: [] }, { userId: 'user-1' });
    mockDb.prepare("UPDATE sessions SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-31 days')").run();
    cleanupOldSessions();
    expect(getActiveSessionCount('user-1')).toBe(0);
    createSession({ userId: 'user-1', username: 'qa-user', pharmacyId: 'ph-1', role: 'owner', permissions: [] }, { userId: 'user-1' });
    deleteAllUserSessions('user-1');
    expect(getUserSessions('user-1')).toEqual([]);
  });
});
