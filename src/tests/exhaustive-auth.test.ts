/**
 * Exhaustive Auth Module Tests
 *
 * Covers 43 scenarios across 6 domains:
 *   Password   (23–29) — 7 tests
 *   JWT        (30–37) — 8 tests
 *   Permission (14–22) — 9 tests
 *   Login Web  ( 1–13) — 13 tests
 *   Session    (38–43) — 6 tests
 *   TOTAL                  43 tests
 *
 * All imports are dynamic (await import(...)) so each describe block can
 * set its own mocks via jest.doMock + jest.resetModules in beforeEach.
 */

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long-for-hs256';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-chars-long-hs256';
(process.env as Record<string, string>).NODE_ENV = 'test';

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// Mock uuid at top level because its ESM dist can't be parsed by Jest
jest.mock('uuid', () => {
  let counter = 0;
  return { v4: jest.fn(() => `uuid-${++counter}`) };
});

// ─── Shared constants ─────────────────────────────────────────────────
const VALID_PW = 'Admin@123';
const ADMIN_ID = '123e4567-e89b-12d3-a456-426614174000';
const PHARMACY_ID = '123e4567-e89b-12d3-a456-426614174001';

// =====================================================================
// PASSWORD SCENARIOS (23 – 29)
// =====================================================================
describe('23–29: Password Scenarios', () => {
  test('23: bcrypt produces valid hash', () => {
    const hash = bcrypt.hashSync(VALID_PW, 4);
    expect(hash).toMatch(/^\$2[abxy]\$\d+\$/);
    expect(hash.startsWith('$2')).toBe(true);
  });

  test('24: correct password matches hash', () => {
    const hash = bcrypt.hashSync(VALID_PW, 4);
    expect(bcrypt.compareSync(VALID_PW, hash)).toBe(true);
  });

  test('25: wrong password does not match hash', () => {
    const hash = bcrypt.hashSync(VALID_PW, 4);
    expect(bcrypt.compareSync('WrongPass@456', hash)).toBe(false);
  });

  test('26: empty-string password can be hashed (raw bcrypt)', () => {
    const hash = bcrypt.hashSync('', 4);
    expect(hash).toMatch(/^\$2[abxy]\$\d+\$/);
    expect(bcrypt.compareSync('', hash)).toBe(true);
  });

  test('27: Unicode / UTF-8 password round-trips', () => {
    const pwd = 'P@ssw0rd_日本語_العربية_😊';
    const hash = bcrypt.hashSync(pwd, 4);
    expect(bcrypt.compareSync(pwd, hash)).toBe(true);
  });

  test('28: very long password (500+ chars) round-trips', () => {
    const long = 'A1@' + 'x'.repeat(497);
    const hash = bcrypt.hashSync(long, 4);
    expect(bcrypt.compareSync(long, hash)).toBe(true);
  });

  test('29: bcrypt cost factor is >= 4', () => {
    const hash = bcrypt.hashSync(VALID_PW, 4);
    const cost = parseInt(hash.split('$')[2], 10);
    expect(cost).toBeGreaterThanOrEqual(4);
  });
});

// =====================================================================
// JWT SCENARIOS (30 – 37)
// dynamic import because jwt.ts reads process.env.JWT_SECRET at module init
// =====================================================================
describe('30–37: JWT Scenarios', () => {
  const PAYLOAD = {
    userId: ADMIN_ID,
    username: 'testadmin',
    pharmacyId: PHARMACY_ID,
    role: 'owner' as const,
    permissions: ['manage_inventory', 'manage_staff'],
  };

  test('30: generateAccessToken produces valid JWT', async () => {
    const { generateAccessToken } = await import('@/lib/auth/jwt');
    const token = generateAccessToken(PAYLOAD);
    const decoded = jwt.decode(token) as any;
    expect(decoded).toBeTruthy();
    expect(decoded.username).toBe('testadmin');
    expect(decoded.role).toBe('owner');
    expect(decoded.userId).toBe(ADMIN_ID);
    expect(decoded.pharmacyId).toBe(PHARMACY_ID);
    expect(decoded.exp).toBeDefined();
    expect(decoded.iat).toBeDefined();
  });

  test('31: generateRefreshToken produces valid JWT', async () => {
    const { generateRefreshToken } = await import('@/lib/auth/jwt');
    const token = generateRefreshToken(ADMIN_ID);
    const decoded = jwt.decode(token) as any;
    expect(decoded).toBeTruthy();
    expect(decoded.type).toBe('refresh');
    expect(decoded.userId).toBe(ADMIN_ID);
  });

  test('32: verifyAccessToken succeeds on valid token', async () => {
    const { generateAccessToken, verifyAccessToken } = await import('@/lib/auth/jwt');
    const token = generateAccessToken(PAYLOAD);
    const payload = verifyAccessToken(token);
    expect(payload.userId).toBe(ADMIN_ID);
    expect(payload.role).toBe('owner');
    expect(payload.permissions).toEqual(['manage_inventory', 'manage_staff']);
  });

  test('33: verifyAccessToken throws on expired token', async () => {
    const { verifyAccessToken } = await import('@/lib/auth/jwt');
    const token = jwt.sign(PAYLOAD, process.env.JWT_SECRET!, { expiresIn: '0s' });
    expect(() => verifyAccessToken(token)).toThrow('Token expired');
  });

  test('34: verifyAccessToken throws on tampered signature', async () => {
    const { generateAccessToken, verifyAccessToken } = await import('@/lib/auth/jwt');
    const token = generateAccessToken(PAYLOAD) + 'tampered';
    expect(() => verifyAccessToken(token)).toThrow('Invalid token');
  });

  test('35: verifyAccessToken throws on malformed token', async () => {
    const { verifyAccessToken } = await import('@/lib/auth/jwt');
    expect(() => verifyAccessToken('not-a-jwt-at-all')).toThrow('Invalid token');
  });

  test('36: verifyRefreshToken returns userId', async () => {
    const { generateRefreshToken, verifyRefreshToken } = await import('@/lib/auth/jwt');
    const token = generateRefreshToken(ADMIN_ID);
    const userId = verifyRefreshToken(token);
    expect(userId).toBe(ADMIN_ID);
  });

  test('37: token expiry boundary — unexpired token passes', async () => {
    const { generateAccessToken, decodeToken } = await import('@/lib/auth/jwt');
    const token = generateAccessToken(PAYLOAD);
    const decoded = decodeToken(token) as any;
    expect(decoded.exp * 1000).toBeGreaterThan(Date.now());
  });
});

// =====================================================================
// PERMISSION SCENARIOS (14 – 22)
// =====================================================================
describe('14–22: Permission Scenarios — hasUserPermissionSync', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.doMock('@/lib/db/tauri', () => ({ dbGet: jest.fn(), dbExecute: jest.fn() }));
  });

  test('14: valid permission returns true', async () => {
    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    expect(hasUserPermissionSync({ role: 'cashier', permissions: '{"can_sell":true}' }, 'can_sell')).toBe(true);
  });

  test('15: missing permission returns false', async () => {
    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    expect(hasUserPermissionSync({ role: 'cashier', permissions: '{"can_sell":true}' }, 'can_manage_inventory')).toBe(false);
  });

  test('16: null / undefined user returns false', async () => {
    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    expect(hasUserPermissionSync(null, 'anything')).toBe(false);
    expect(hasUserPermissionSync(undefined as any, 'anything')).toBe(false);
  });

  test('17: single-nest JSON string permission resolves correctly', async () => {
    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    const user = { role: 'cashier', permissions: JSON.stringify('{"can_sell":true}') };
    expect(hasUserPermissionSync(user, 'can_sell')).toBe(true);
  });

  test('18: double-nested (double-encoded) JSON permission resolves correctly', async () => {
    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    const double = JSON.stringify(JSON.stringify('{"can_sell":true}'));
    const user = { role: 'cashier', permissions: double };
    expect(hasUserPermissionSync(user, 'can_sell')).toBe(true);
  });

  test('19: already-parsed object permissions work', async () => {
    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    const user = { role: 'cashier', permissions: { can_sell: true } };
    expect(hasUserPermissionSync(user, 'can_sell')).toBe(true);
  });

  test('20: truthy and falsy permission values', async () => {
    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    const user = { role: 'cashier', permissions: '{"flag_a":true,"flag_b":"true","flag_c":1,"flag_d":false,"flag_e":"false"}' };
    expect(hasUserPermissionSync(user, 'flag_a')).toBe(true);
    expect(hasUserPermissionSync(user, 'flag_b')).toBe(true);
    expect(hasUserPermissionSync(user, 'flag_c')).toBe(true);
    expect(hasUserPermissionSync(user, 'flag_d')).toBe(false);
    expect(hasUserPermissionSync(user, 'flag_e')).toBe(false);
  });

  test('21: owner and admin roles bypass permission checks', async () => {
    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    expect(hasUserPermissionSync({ role: 'owner', permissions: '[]' }, 'anything')).toBe(true);
    expect(hasUserPermissionSync({ role: 'admin', permissions: '{}' }, 'anything')).toBe(true);
  });

  test('22: empty / absent permissions object returns false', async () => {
    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    expect(hasUserPermissionSync({ role: 'cashier', permissions: '{}' }, 'anything')).toBe(false);
    expect(hasUserPermissionSync({ role: 'cashier', permissions: { can_sell: false } }, 'can_sell')).toBe(false);
    expect(hasUserPermissionSync({ role: 'cashier' } as any, 'anything')).toBe(false);
  });
});

// =====================================================================
// LOGIN SCENARIOS — Web (JWT) mode (1 – 13)
// =====================================================================
describe('1–13: Login Scenarios — Web (JWT)', () => {
  const ADMIN_HASH = bcrypt.hashSync(VALID_PW, 4);
  const FAIL_LIMIT = 5;

  // In-memory "DB" shared across all mocks for a single test
  interface UserRow {
    id: string; username: string; password_hash: string; role: string;
    pharmacy_id: string; full_name: string; permissions: string; is_active: number;
  }
  interface SessionRow {
    id: string; user_id: string; refresh_token: string; expires_at: string;
  }

  let storeUsers: UserRow[];
  let storeSessions: SessionRow[];

  beforeEach(() => {
    jest.resetModules();
    storeUsers = [
      {
        id: ADMIN_ID, username: 'admin', password_hash: ADMIN_HASH, role: 'owner',
        pharmacy_id: PHARMACY_ID, full_name: 'Admin',
        permissions: '["manage_inventory","manage_staff","process_sales"]', is_active: 1
      },
      {
        id: 'disabled-uuid', username: 'disabled', password_hash: ADMIN_HASH, role: 'pharmacist',
        pharmacy_id: PHARMACY_ID, full_name: 'Disabled', permissions: '["process_sales"]', is_active: 0
      },
    ];
    storeSessions = [];

    const db = {
      get: jest.fn((sql: string, params: any[]) => {
        if (sql.includes('FROM users')) {
          return storeUsers.find(u => u.username === params[0] || u.id === params[0]);
        }
        return undefined;
      }),
      execute: jest.fn((sql: string, params: any[]) => {
        if (sql.includes('INSERT INTO sessions')) {
          storeSessions.push({ id: params[0], user_id: params[1], refresh_token: params[2], expires_at: params[3] });
        }
        if (sql.includes('UPDATE users SET password_hash')) {
          const u = storeUsers.find(x => x.id === params[1]);
          if (u) u.password_hash = params[0];
        }
        if (sql.includes('DELETE FROM sessions')) {
          if (sql.includes('WHERE user_id')) {
            storeSessions = storeSessions.filter(s => s.user_id !== params[0]);
          } else {
            storeSessions = storeSessions.filter(s => s.refresh_token !== params[0]);
          }
        }
        return { changes: 1, lastInsertRowid: 1 };
      }),
      query: jest.fn((sql: string, params: any[]) => {
        if (sql.includes('FROM sessions WHERE user_id')) return storeSessions.filter(s => s.user_id === params[0]);
        if (sql.includes('FROM sessions WHERE refresh_token')) return storeSessions.filter(s => s.refresh_token === params[0]);
        return [];
      }),
    };

    jest.doMock('@/lib/db/client', () => ({
      getDatabase: jest.fn(() => ({
        exec: jest.fn(), prepare: jest.fn(() => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() })),
        pragma: jest.fn(() => ({})), function: jest.fn(),
        backup: jest.fn(() => ({ step: jest.fn() })), close: jest.fn(),
      })),
      execute: db.execute,
      get: db.get,
      query: db.query,
    }));
    jest.doMock('@/lib/shifts/service', () => ({
      getOpenShift: jest.fn(() => null),
      startShift: jest.fn(() => ({ id: 'shift-001' })),
    }));
    jest.doMock('@/lib/auth/password', () => ({
      hashPassword: jest.fn((pwd: string) => bcrypt.hashSync(pwd, 4)),
      verifyPassword: jest.fn((pwd: string, hash: string) => bcrypt.compareSync(pwd, hash)),
      validatePassword: jest.fn(() => ({ valid: true, errors: [] })),
    }));
  });

  test('1: Login with correct credentials returns JWT token pair', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: 'admin', password: VALID_PW });
    expect(result.success).toBe(true);
    expect(result.token).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.user?.role).toBe('owner');
  });

  test('2: Wrong password returns error', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: 'admin', password: 'WrongPass@456' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid username or password');
  });

  test('3: Inactive user login returns error', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: 'disabled', password: VALID_PW });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Account is inactive');
  });

  test('4: Non-existent user returns error', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: 'nobody_here', password: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid username or password');
  });

  test('5: Empty fields fail gracefully', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: '', password: '' });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('6: SQL injection in username is neutralized', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: "' OR 1=1 --", password: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid username or password');
  });

  test('7: XSS attempt in username is harmless', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: '<script>alert("xss")</script>', password: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid username or password');
  });

  test('8: Very long username (>50 chars) is rejected', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: 'a'.repeat(51), password: VALID_PW });
    expect(result.success).toBe(false);
  });

  test('9: Unicode / emoji in username is handled', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: 'مستخدم_عربي', password: VALID_PW });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid username or password');
  });

  test('10: Whitespace-only password fails', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: 'admin', password: '   ' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid username or password');
  });

  test('11: Null / undefined values fail gracefully', async () => {
    const { login } = await import('@/lib/auth/service');
    const r1 = await login({ username: null as any, password: null as any });
    expect(r1.success).toBe(false);
    const r2 = await login({ username: undefined as any, password: undefined as any });
    expect(r2.success).toBe(false);
  });

  test('12: 5 failed attempts do NOT lock the account', async () => {
    const { login } = await import('@/lib/auth/service');
    for (let i = 0; i < FAIL_LIMIT; i++) {
      const fail = await login({ username: 'admin', password: 'WrongPass@456' });
      expect(fail.success).toBe(false);
    }
    const success = await login({ username: 'admin', password: VALID_PW });
    expect(success.success).toBe(true);
  });

  test('13: Sequential login/logout cycles succeed', async () => {
    const { login, logout } = await import('@/lib/auth/service');
    for (let i = 0; i < 3; i++) {
      const r = await login({ username: 'admin', password: VALID_PW });
      expect(r.success).toBe(true);
      if (r.refreshToken) {
        await logout({ refreshToken: r.refreshToken });
      }
    }
  });
});

// =====================================================================
// LOGIN SCENARIOS — Tauri (localStorage) mode
// =====================================================================
describe('1–13: Login Scenarios — Tauri (localStorage)', () => {
  let localStore: Record<string, string>;

  beforeEach(() => {
    jest.resetModules();
    localStore = {};
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: jest.fn((k: string) => localStore[k] ?? null),
        setItem: jest.fn((k: string, v: string) => { localStore[k] = v; }),
        removeItem: jest.fn((k: string) => { delete localStore[k]; }),
        clear: jest.fn(() => { Object.keys(localStore).forEach(k => delete localStore[k]); }),
      },
      configurable: true,
    });

    (window as any).__TAURI_INTERNALS__ = {};

    const users: Record<string, any> = {
      admin: {
        id: ADMIN_ID, username: 'admin', password_hash: bcrypt.hashSync(VALID_PW, 4),
        role: 'owner', full_name: 'Admin', pharmacy_id: PHARMACY_ID,
        permissions: '["manage_inventory","manage_staff","process_sales"]', is_active: 1,
      },
      disabled: {
        id: 'disabled-uuid', username: 'disabled', password_hash: bcrypt.hashSync('disabled@789', 4),
        role: 'pharmacist', full_name: 'Disabled', pharmacy_id: PHARMACY_ID,
        permissions: '{}', is_active: 0,
      },
    };

    jest.doMock('@/lib/db/tauri', () => ({
      dbGet: jest.fn((sql: string, params: any[]) => {
        const user = Object.values(users).find((u: any) => u.username === params[0] || u.id === params[0]);
        return Promise.resolve(user || null);
      }),
      dbExecute: jest.fn(() => Promise.resolve({ rowsAffected: 1 })),
    }));

    jest.doMock('@tauri-apps/api/core', () => ({
      invoke: jest.fn((cmd: string, args: any) => {
        if (cmd === 'bcrypt_compare') {
          return Promise.resolve(bcrypt.compareSync(args.password, args.hash));
        }
        if (cmd === 'bcrypt_hash') {
          return Promise.resolve(bcrypt.hashSync(args.password, 4));
        }
        return Promise.resolve(true);
      }),
    }));
  });

  afterEach(() => { delete (window as any).__TAURI_INTERNALS__; });

  test('1: Login stores session in localStorage', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('admin', VALID_PW);
    expect(result.success).toBe(true);
    const stored = JSON.parse(localStore['pharma_session_user']);
    expect(stored.role).toBe('owner');
  });

  test('2: Wrong password returns Arabic error', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('admin', 'WRONG');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير صحيحة');
  });

  test('3: Inactive user returns Arabic error', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('disabled', 'disabled@789');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير نشط');
  });

  test('4: Non-existent user returns Arabic error', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('nobody');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير موجود');
  });

  test('5: Empty fields return error', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('', '');
    expect(result.success).toBe(false);
  });

  test('6: SQL injection in username is neutralized', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal("' OR 1=1 --", 'x');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير موجود');
  });

  test('7: XSS attempt in username is harmless', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('<script>alert("xss")</script>', 'x');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير موجود');
  });

  test('8: Very long username does not crash', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('x'.repeat(1001), VALID_PW);
    expect(result.success).toBe(false);
  });

  test('9: Unicode / special-char username', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('مستخدم_اختبار', VALID_PW);
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير موجود');
  });

  test('10: Whitespace-only password fails', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('admin', '   ');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير صحيحة');
  });

  test('11: No-password login works when password is optional', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('admin');
    expect(result.success).toBe(true);
  });

  test('12: 5 failed attempts do not lock account', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    for (let i = 0; i < 5; i++) {
      const fail = await loginLocal('admin', 'WrongPass@456');
      expect(fail.success).toBe(false);
    }
    const success = await loginLocal('admin', VALID_PW);
    expect(success.success).toBe(true);
  });

  test('13: Sequential login/logout cycles succeed', async () => {
    const { loginLocal, logoutLocal } = await import('@/lib/auth/local');
    for (let i = 0; i < 3; i++) {
      const r = await loginLocal('admin', VALID_PW);
      expect(r.success).toBe(true);
      expect(localStore['pharma_session_user']).toBeDefined();
      await logoutLocal();
      expect(localStore['pharma_session_user']).toBeUndefined();
    }
  });
});

// =====================================================================
// SESSION SCENARIOS (38 – 43)
// =====================================================================
describe('38–43: Session Scenarios', () => {
  let localStore: Record<string, string>;

  beforeEach(() => {
    jest.resetModules();
    localStore = {};
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: jest.fn((k: string) => localStore[k] ?? null),
        setItem: jest.fn((k: string, v: string) => { localStore[k] = v; }),
        removeItem: jest.fn((k: string) => { delete localStore[k]; }),
        clear: jest.fn(() => { Object.keys(localStore).forEach(k => delete localStore[k]); }),
      },
      configurable: true,
    });
    delete (window as any).__TAURI_INTERNALS__;
    delete (globalThis as any).__MOCK_SESSION__;
  });

  test('38: getLocalSession returns user when session exists', async () => {
    (globalThis as any).__MOCK_SESSION__ = {
      id: ADMIN_ID, username: 'admin', role: 'owner',
      pharmacy_id: PHARMACY_ID, permissions: '["manage_staff"]',
    };
    const { getLocalSession } = await import('@/lib/auth/local');
    const session = await getLocalSession();
    expect(session).not.toBeNull();
    expect(session?.username).toBe('admin');
    expect(session?.role).toBe('owner');
  });

  test('39: getLocalSession returns null when no session exists', async () => {
    const { getLocalSession } = await import('@/lib/auth/local');
    const session = await getLocalSession();
    expect(session).toBeNull();
  });

  test('40: getLocalSession returns null when user deleted from DB', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    localStore['pharma_session_user'] = JSON.stringify({
      id: ADMIN_ID, username: 'admin', role: 'owner', pharmacy_id: PHARMACY_ID, permissions: '[]',
    });

    jest.doMock('@/lib/db/tauri', () => ({
      dbGet: jest.fn(() => Promise.resolve(null)),
      dbExecute: jest.fn(() => Promise.resolve({ rowsAffected: 1 })),
    }));
    jest.doMock('@tauri-apps/api/core', () => ({
      invoke: jest.fn(() => Promise.resolve(true)),
    }));

    const { getLocalSession } = await import('@/lib/auth/local');
    const session = await getLocalSession();
    expect(session).toBeNull();
  });

  test('41: getClientSession returns null when DB fails', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    localStore['pharma_session_user'] = JSON.stringify({
      id: ADMIN_ID, username: 'admin', role: 'owner', pharmacy_id: PHARMACY_ID, permissions: '[]',
    });

    jest.doMock('@/lib/db/tauri', () => ({
      dbGet: jest.fn(() => Promise.reject(new Error('DB connection lost'))),
      dbExecute: jest.fn(() => Promise.reject(new Error('DB connection lost'))),
    }));
    jest.doMock('@tauri-apps/api/core', () => ({
      invoke: jest.fn(() => Promise.resolve(true)),
    }));

    const { getClientSession } = await import('@/lib/auth/local');
    const session = await getClientSession();
    expect(session).toBeNull();
  });

  test('42: Logout clears localStorage', async () => {
    (window as any).__TAURI_INTERNALS__ = {};
    localStore['pharma_session_user'] = JSON.stringify({
      id: ADMIN_ID, username: 'admin', role: 'owner',
    });

    jest.doMock('@/lib/db/tauri', () => ({
      dbGet: jest.fn(() => Promise.resolve({
        id: ADMIN_ID, username: 'admin', role: 'owner', full_name: 'Admin',
        pharmacy_id: PHARMACY_ID, permissions: '[]',
      })),
      dbExecute: jest.fn(() => Promise.resolve({ rowsAffected: 1 })),
    }));
    jest.doMock('@tauri-apps/api/core', () => ({
      invoke: jest.fn(() => Promise.resolve(true)),
    }));

    const { logoutLocal } = await import('@/lib/auth/local');
    await logoutLocal();
    expect(localStore['pharma_session_user']).toBeUndefined();
  });

  test('43: Role-based access permission boundaries', async () => {
    // This test uses hasUserPermissionSync which needs the tauri mock
    jest.doMock('@/lib/db/tauri', () => ({ dbGet: jest.fn(), dbExecute: jest.fn() }));
    const { hasUserPermissionSync } = await import('@/lib/auth/local');

    expect(hasUserPermissionSync({ role: 'owner', permissions: '{}' }, 'can_manage_inventory')).toBe(true);
    expect(hasUserPermissionSync({ role: 'admin', permissions: '{}' }, 'can_manage_inventory')).toBe(true);
    expect(hasUserPermissionSync({ role: 'manager', permissions: '{"can_manage_inventory":true}' }, 'can_manage_inventory')).toBe(true);
    expect(hasUserPermissionSync({ role: 'manager', permissions: '{}' }, 'can_manage_inventory')).toBe(false);
    expect(hasUserPermissionSync({ role: 'pharmacist', permissions: '{"can_view_patients":true}' }, 'can_view_patients')).toBe(true);
    expect(hasUserPermissionSync({ role: 'pharmacist', permissions: '{}' }, 'can_manage_inventory')).toBe(false);
    expect(hasUserPermissionSync({ role: 'cashier', permissions: '{"process_sales":true}' }, 'process_sales')).toBe(true);
    expect(hasUserPermissionSync({ role: 'cashier', permissions: '{}' }, 'can_manage_inventory')).toBe(false);
  });
});
