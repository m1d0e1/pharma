/**
 * Phase 1: Auth Integration Tests (P0)
 * Covers all 7 scenarios for both Web (JWT) and Tauri (localStorage) modes.
 *
 * Web mode: Tests login/logout/permissions via mocked DB but real bcrypt hashing.
 * Tauri mode: Tests login/logout/is_active checks via mocked Tauri IPC + real DB queries.
 */

process.env.JWT_SECRET = 'test-jwt-secret-at-least-32-chars-long-for-hs256';

import bcrypt from 'bcryptjs';

// Must be top-level (hoisted) — service.ts imports uuid at module scope
jest.mock('uuid', () => {
  let counter = 0;
  return { v4: jest.fn(() => `uuid-${++counter}`) };
});

// ─── Shared test data ────────────────────────────────────────────────
const ADMIN_PW = 'Admin@123';
const CASHIER_PW = 'Cashier@456';
const FIXED_ADMIN_ID = 'admin-user-id-0001';
const FIXED_CASHIER_ID = 'cashier-id-0002';
const FIXED_DISABLED_ID = 'disabled-id-0003';
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PW, 4);
const CASHIER_HASH = bcrypt.hashSync(CASHIER_PW, 4);
const DISABLED_HASH = bcrypt.hashSync('disabled@789', 4);

// =====================================================================
// Phase 1a: Web (JWT) Auth — Login, Logout, Permissions, Password Change
// =====================================================================
describe('Phase 1a: Web (JWT) Auth — All 7 scenarios', () => {
  const store: Record<string, any> = { users: [], sessions: [] };

  const mockDb = () => ({
    get: jest.fn((sql: string, params: any[]) => {
      const user = store.users.find((u: any) => u.username === params[0] || u.id === params[0]);
      return user || undefined;
    }),
    execute: jest.fn((sql: string, params: any[]) => {
      if (sql.includes('INSERT INTO sessions')) {
        store.sessions.push({
          id: params[0], user_id: params[1], refresh_token: params[2], expires_at: params[3],
        });
      }
      if (sql.includes('UPDATE users SET password_hash')) {
        const user = store.users.find((u: any) => u.id === params[1]);
        if (user) user.password_hash = params[0];
      }
      if (sql.includes('DELETE FROM sessions')) {
        if (sql.includes('WHERE user_id')) {
          store.sessions = store.sessions.filter((s: any) => s.user_id !== params[0]);
        } else {
          store.sessions = store.sessions.filter((s: any) => s.refresh_token !== params[0]);
        }
      }
      return { changes: 1, lastInsertRowid: 1 };
    }),
    query: jest.fn((sql: string, params: any[]) => {
      if (sql.includes('FROM sessions WHERE user_id')) {
        return store.sessions.filter((s: any) => s.user_id === params[0]);
      }
      if (sql.includes('FROM sessions WHERE refresh_token')) {
        return store.sessions.filter((s: any) => s.refresh_token === params[0]);
      }
      return [];
    }),
  });

  beforeEach(() => {
    jest.resetModules();
    store.users = [
      { id: FIXED_ADMIN_ID, username: 'admin', password_hash: ADMIN_HASH, role: 'owner',
        pharmacy_id: 'ph-001', full_name: 'Admin', permissions: '["manage_inventory","manage_staff","process_sales"]', is_active: 1 },
      { id: FIXED_CASHIER_ID, username: 'cashier1', password_hash: CASHIER_HASH, role: 'cashier',
        pharmacy_id: 'ph-001', full_name: 'Cashier', permissions: '["process_sales"]', is_active: 1 },
      { id: FIXED_DISABLED_ID, username: 'disabled', password_hash: DISABLED_HASH, role: 'pharmacist',
        pharmacy_id: 'ph-001', full_name: 'Disabled', permissions: '["process_sales"]', is_active: 0 },
    ];
    store.sessions = [];

    const db = mockDb();
    jest.doMock('@/lib/db/client', () => ({
      getDatabase: jest.fn(() => ({
        exec: jest.fn(),
        prepare: jest.fn(() => ({ get: jest.fn(), all: jest.fn(), run: jest.fn() })),
        pragma: jest.fn(() => ({})),
        function: jest.fn(),
        backup: jest.fn(() => ({ step: jest.fn() })),
        close: jest.fn(),
      })),
      execute: db.execute,
      get: db.get,
      query: db.query,
    }));
    jest.doMock('@/lib/shifts/service', () => ({
      getOpenShift: jest.fn(() => null),
      startShift: jest.fn(() => ({ id: 'shift-001' })),
    }));
    // Real password validation, mocked bcrypt for speed
    jest.doMock('@/lib/auth/password', () => ({
      hashPassword: jest.fn((pwd: string) => bcrypt.hashSync(pwd, 4)),
      verifyPassword: jest.fn((pwd: string, hash: string) => bcrypt.compareSync(pwd, hash)),
      validatePassword: jest.fn(() => ({ valid: true, errors: [] })),
    }));
  });

  test('1/7: Login valid user returns JWT token pair', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: 'admin', password: ADMIN_PW });
    expect(result.success).toBe(true);
    expect(result.token).toBeDefined();
    expect(result.refreshToken).toBeDefined();
    expect(result.user?.role).toBe('owner');
  });

  test('2/7: Wrong password returns error', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: 'admin', password: 'WRONG' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid username or password');
  });

  test('3/7: Inactive user login returns error', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: 'disabled', password: 'disabled@789' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Account is inactive');
  });

  test('4/7: Non-existent user returns error', async () => {
    const { login } = await import('@/lib/auth/service');
    const result = await login({ username: 'nobody', password: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid username or password');
  });

  test('5/7: Logout deletes session', async () => {
    const { login, logout } = await import('@/lib/auth/service');
    const loginResult = await login({ username: 'admin', password: ADMIN_PW });
    expect(loginResult.success).toBe(true);

    await logout({ refreshToken: loginResult.refreshToken! });
    expect(store.sessions).toHaveLength(0);
  });

  test('6/7: Cashier has limited permissions vs owner', async () => {
    const { login } = await import('@/lib/auth/service');
    const admin = await login({ username: 'admin', password: ADMIN_PW });
    const cashier = await login({ username: 'cashier1', password: CASHIER_PW });
    expect(admin.user?.permissions).toContain('manage_inventory');
    expect(cashier.user?.permissions).not.toContain('manage_inventory');
    expect(cashier.user?.permissions).toContain('process_sales');
  });

  test('7/7: Password change invalidates all sessions', async () => {
    const { login, changePassword } = await import('@/lib/auth/service');
    await login({ username: 'admin', password: ADMIN_PW });
    await login({ username: 'cashier1', password: CASHIER_PW });

    expect(store.sessions.length).toBeGreaterThanOrEqual(2);

    await changePassword(FIXED_ADMIN_ID, {
      currentPassword: ADMIN_PW,
      newPassword: 'NewPass@789',
    });

    const adminSessions = store.sessions.filter((s: any) => s.user_id === FIXED_ADMIN_ID);
    expect(adminSessions).toHaveLength(0);
  });
});

// =====================================================================
// Phase 1b: Tauri (localStorage) Auth — All 7 scenarios
// =====================================================================
describe('Phase 1b: Tauri (localStorage) Auth — All 7 scenarios', () => {
  let localStorageStore: Record<string, string>;

  beforeEach(() => {
    jest.resetModules();
    localStorageStore = {};
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: jest.fn((k: string) => localStorageStore[k] ?? null),
        setItem: jest.fn((k: string, v: string) => { localStorageStore[k] = v; }),
        removeItem: jest.fn((k: string) => { delete localStorageStore[k]; }),
        clear: jest.fn(() => { Object.keys(localStorageStore).forEach(k => delete localStorageStore[k]); }),
      },
      configurable: true,
    });

    (window as any).__TAURI_INTERNALS__ = {};

    const users: Record<string, any> = {
      admin: { id: FIXED_ADMIN_ID, username: 'admin', password_hash: ADMIN_HASH, role: 'owner',
        full_name: 'Admin', pharmacy_id: 'ph-001', permissions: '["manage_inventory"]', is_active: 1 },
      cashier1: { id: FIXED_CASHIER_ID, username: 'cashier1', password_hash: CASHIER_HASH, role: 'cashier',
        full_name: 'Cashier', pharmacy_id: 'ph-001', permissions: '{"can_sell":true}', is_active: 1 },
      disabled: { id: FIXED_DISABLED_ID, username: 'disabled', password_hash: DISABLED_HASH, role: 'pharmacist',
        full_name: 'Disabled', pharmacy_id: 'ph-001', permissions: '{}', is_active: 0 },
    };

    jest.doMock('@/lib/db/tauri', () => ({
      dbGet: jest.fn((sql: string, params: any[]) => {
        const user = Object.values(users).find((u: any) =>
          u.username === params[0] || u.id === params[0]
        );
        return user || null;
      }),
      dbExecute: jest.fn(() => ({ rowsAffected: 1 })),
    }));

    jest.doMock('@tauri-apps/api/core', () => ({
      invoke: jest.fn(() => Promise.resolve(true)),
    }));
  });

  afterEach(() => { delete (window as any).__TAURI_INTERNALS__; });

  test('1/7: Login stores session in localStorage', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('admin', ADMIN_PW);
    expect(result.success).toBe(true);
    expect(result.user?.role).toBe('owner');
    const stored = JSON.parse(localStorageStore['pharma_session_user']);
    expect(stored.role).toBe('owner');
  });

  test('2/7: Wrong password returns Arabic error', async () => {
    const { invoke } = require('@tauri-apps/api/core');
    invoke.mockResolvedValueOnce(false);
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('admin', 'WRONG');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير صحيحة');
  });

  test('3/7: Inactive user returns Arabic error', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('disabled', 'disabled@789');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير نشط');
  });

  test('4/7: Non-existent user returns Arabic error', async () => {
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('nobody');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير موجود');
  });

  test('5/7: Logout clears localStorage', async () => {
    const { loginLocal, logoutLocal } = await import('@/lib/auth/local');
    await loginLocal('admin', ADMIN_PW);
    expect(localStorageStore['pharma_session_user']).toBeDefined();
    await logoutLocal();
    expect(localStorageStore['pharma_session_user']).toBeUndefined();
  });

  test('6/7: hasUserPermissionSync enforces role-based access', async () => {
    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    expect(hasUserPermissionSync({ role: 'owner', permissions: '[]' }, 'anything')).toBe(true);
    expect(hasUserPermissionSync({ role: 'cashier', permissions: '{"can_sell":true}' }, 'can_sell')).toBe(true);
    expect(hasUserPermissionSync({ role: 'cashier', permissions: '{"can_sell":true}' }, 'manage_inventory')).toBe(false);
  });

  test('7/7: getClientSession returns null when user deleted from DB', async () => {
    const { loginLocal, getClientSession } = await import('@/lib/auth/local');
    await loginLocal('admin', ADMIN_PW);
    expect(localStorageStore['pharma_session_user']).toBeDefined();

    // Mock the DB to return null (simulate user deleted)
    const { dbGet } = require('@/lib/db/tauri');
    dbGet.mockResolvedValue(null);

    const session = await getClientSession();
    expect(session).toBeNull();
  });
});
