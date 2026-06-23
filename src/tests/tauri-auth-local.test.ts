const mockLocalStorage: Record<string, string> = {};
const mockStorage = {
  getItem: jest.fn((k: string) => mockLocalStorage[k] ?? null),
  setItem: jest.fn((k: string, v: string) => { mockLocalStorage[k] = v; }),
  removeItem: jest.fn((k: string) => { delete mockLocalStorage[k]; }),
  clear: jest.fn(() => { Object.keys(mockLocalStorage).forEach(k => delete mockLocalStorage[k]); }),
  get length() { return Object.keys(mockLocalStorage).length; },
  key: jest.fn((i: number) => Object.keys(mockLocalStorage)[i] ?? null),
};
Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, configurable: true });

jest.mock('@/lib/db/tauri', () => ({
  dbGet: jest.fn(),
  dbExecute: jest.fn(),
}));

jest.mock('uuid', () => ({ v4: () => '00000000-0000-0000-0000-000000000000' }));

jest.mock('@tauri-apps/api/core', () => ({
  invoke: jest.fn(),
}));

describe('Tauri Auth — Environment Detection', () => {
  beforeEach(() => {
    jest.resetModules();
    delete (window as any).__TAURI__;
    delete (window as any).__TAURI_INTERNALS__;
    mockStorage.clear();
  });

  it('isTauri is false when no Tauri globals exist', () => {
    expect(require('@/lib/env').isTauri).toBe(false);
  });

  it('isTauri is true when __TAURI_INTERNALS__ is set on window', () => {
    (window as any).__TAURI_INTERNALS__ = true;
    expect(require('@/lib/env').isTauri).toBe(true);
  });

  it('isTauri is true when __TAURI__ is set on window', () => {
    (window as any).__TAURI__ = true;
    expect(require('@/lib/env').isTauri).toBe(true);
  });
});

describe('Tauri Auth — loginLocal Tauri path', () => {
  beforeEach(() => {
    jest.resetModules();
    (window as any).__TAURI_INTERNALS__ = true;
    mockStorage.clear();
  });

  it('returns error for non-existent user', async () => {
    const { dbGet } = require('@/lib/db/tauri');
    dbGet.mockResolvedValue(null);
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('nobody');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير موجود');
  });

  it('returns error for inactive user', async () => {
    const { dbGet } = require('@/lib/db/tauri');
    dbGet.mockResolvedValue({ id: 'u1', is_active: 0, password_hash: null });
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('disabled_user');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير نشط');
  });

  it('logs login activity on success', async () => {
    const { dbGet, dbExecute } = require('@/lib/db/tauri');
    dbGet.mockResolvedValue({
      id: 'u1', username: 'admin', role: 'owner',
      full_name: 'Admin', pharmacy_id: 'p1',
      permissions: '[]', is_active: 1, password_hash: '$2b$12$hash',
    });
    const { invoke } = require('@tauri-apps/api/core');
    invoke.mockResolvedValue(true);
    const { loginLocal } = await import('@/lib/auth/local');

    await loginLocal('admin', 'password');
    expect(dbExecute).toHaveBeenCalledWith(
      expect.stringContaining("'LOGIN'"),
      expect.arrayContaining(['u1'])
    );
  });
});

describe('Tauri Auth — hasUserPermissionSync', () => {
  beforeEach(() => { jest.resetModules(); });

  it('owner has all permissions', () => {
    const { hasUserPermissionSync } = require('@/lib/auth/local');
    expect(hasUserPermissionSync({ role: 'owner', permissions: '{}' }, 'anything')).toBe(true);
  });

  it('admin has all permissions', () => {
    const { hasUserPermissionSync } = require('@/lib/auth/local');
    expect(hasUserPermissionSync({ role: 'admin', permissions: '{}' }, 'anything')).toBe(true);
  });

  it('returns false for user with no permissions', () => {
    const { hasUserPermissionSync } = require('@/lib/auth/local');
    expect(hasUserPermissionSync({ role: 'cashier' }, 'manage_inventory')).toBe(false);
  });

  it('checks JSON string permissions correctly', () => {
    const { hasUserPermissionSync } = require('@/lib/auth/local');
    const user = { role: 'cashier', permissions: '{"can_sell": true, "can_manage_inventory": false}' };
    expect(hasUserPermissionSync(user, 'can_sell')).toBe(true);
    expect(hasUserPermissionSync(user, 'can_manage_inventory')).toBe(false);
  });

  it('handles deeply nested JSON permission strings', () => {
    const { hasUserPermissionSync } = require('@/lib/auth/local');
    const user = { role: 'cashier', permissions: JSON.stringify(JSON.stringify('{"can_sell": true}')) };
    expect(hasUserPermissionSync(user, 'can_sell')).toBe(true);
  });

  it('checks truthy permission values', () => {
    const { hasUserPermissionSync } = require('@/lib/auth/local');
    const user = { role: 'cashier', permissions: '{"can_sell": "true", "edit_price": 1}' };
    expect(hasUserPermissionSync(user, 'can_sell')).toBe(true);
    expect(hasUserPermissionSync(user, 'edit_price')).toBe(true);
  });
});
