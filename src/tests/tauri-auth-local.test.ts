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
    delete (globalThis as any).isTauri;
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

  it('isTauri is true when runtime marker exists without window.__TAURI__', () => {
    (globalThis as any).isTauri = true;
    expect(require('@/lib/env').isTauri).toBe(true);
  });
});

describe('Tauri Auth — loginLocal Tauri path', () => {
  beforeEach(() => {
    jest.resetModules();
    (window as any).__TAURI_INTERNALS__ = true;
    mockStorage.clear();
    const { invoke } = require('@tauri-apps/api/core');
    invoke.mockReset();
  });

  it('returns error for non-existent user', async () => {
    const { invoke } = require('@tauri-apps/api/core');
    invoke.mockResolvedValue({ success: false, error: 'المستخدم غير موجود' });
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('nobody', 'password');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير موجود');
  });

  it('returns error for inactive user', async () => {
    const { invoke } = require('@tauri-apps/api/core');
    invoke.mockResolvedValue({ success: false, error: 'الحساب غير نشط' });
    const { loginLocal } = await import('@/lib/auth/local');
    const result = await loginLocal('disabled_user', 'password');
    expect(result.success).toBe(false);
    expect(result.error).toContain('غير نشط');
  });

  it('uses native credential verification and does not retrieve hashes in the renderer', async () => {
    const publicUser = {
      id: 'u1', username: 'admin', role: 'owner',
      full_name: 'Admin', pharmacy_id: 'p1',
      permissions: '[]',
    };
    const { invoke } = require('@tauri-apps/api/core');
    invoke.mockResolvedValue({ success: true, user: publicUser });
    const { loginLocal } = await import('@/lib/auth/local');

    expect(await loginLocal('admin', 'password')).toMatchObject({ success: true, user: publicUser });
    expect(invoke).toHaveBeenCalledWith('authenticate_local', { username: 'admin', password: 'password' });
    const { dbGet, dbExecute } = require('@/lib/db/tauri');
    expect(dbGet).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
    expect(mockLocalStorage.pharma_session_user).not.toContain('password_hash');
  });

  it('uses native session lookup instead of restoring localStorage identity', async () => {
    mockStorage.setItem('pharma_session_user', JSON.stringify({ id: 'u1', username: 'admin' }));
    const { invoke } = require('@tauri-apps/api/core');
    invoke.mockResolvedValueOnce({
        id: 'u1', username: 'admin', role: 'owner', full_name: 'Admin',
        pharmacy_id: 'p1', permissions: '{}',
    });

    const { getClientSession } = await import('@/lib/auth/local');
    const session = await getClientSession();

    expect(session?.username).toBe('admin');
    expect(invoke).toHaveBeenCalledWith('current_local_user');
    const { dbGet } = require('@/lib/db/tauri');
    expect(dbGet).not.toHaveBeenCalled();
  });
});

describe('Tauri Auth — hasUserPermissionSync', () => {
  beforeEach(() => { jest.resetModules(); });

  it('owner has all permissions', () => {
    const { hasUserPermissionSync } = require('@/lib/auth/local');
    expect(hasUserPermissionSync({ role: 'owner', permissions: '{}' }, 'anything')).toBe(true);
  });

  it('admin follows configured permissions', () => {
    const { hasUserPermissionSync } = require('@/lib/auth/local');
    expect(hasUserPermissionSync({ role: 'admin', permissions: '{}' }, 'anything')).toBe(false);
    expect(hasUserPermissionSync({ role: 'admin', permissions: '{"anything":true}' }, 'anything')).toBe(true);
  });

  it('identifies owner/admin roles', () => {
    const { isOwnerOrAdmin } = require('@/lib/auth/local');
    expect(isOwnerOrAdmin({ role: 'owner' })).toBe(true);
    expect(isOwnerOrAdmin({ role: 'admin' })).toBe(true);
    expect(isOwnerOrAdmin({ role: 'pharmacist' })).toBe(false);
    expect(isOwnerOrAdmin(null)).toBe(false);
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
