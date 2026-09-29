const mockDbGet = jest.fn();
const mockDbExecute = jest.fn();
const mockInvoke = jest.fn();

jest.mock('@/lib/db/tauri', () => ({
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbExecute: (...args: unknown[]) => mockDbExecute(...args),
}));

jest.mock('@/lib/env', () => ({ isTauri: true, isClient: true }));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { getLocalSession, loginLocal } from '@/lib/auth/local';

describe('local login audit regression', () => {
  beforeEach(() => {
    mockDbGet.mockReset();
    mockDbExecute.mockReset();
    mockInvoke.mockReset();
    localStorage.clear();
  });

  it('records an unknown username without violating the users foreign key', async () => {
    mockDbGet.mockResolvedValue(null);
    mockDbExecute.mockResolvedValue({ rowsAffected: 1 });

    await expect(loginLocal('missing-user', 'secret')).resolves.toEqual({
      success: false,
      error: 'المستخدم غير موجود',
    });
    expect(mockDbExecute).toHaveBeenCalledWith(
      expect.stringContaining('LOGIN_FAILED'),
      [null, expect.stringContaining('missing-user')],
    );
  });

  it('keeps a pre-scope active user with a null pharmacy usable without changing its existing credentials or permissions', async () => {
    const legacyUser = {
      id: 'legacy-owner',
      username: 'legacy-owner',
      password_hash: 'existing-hash',
      role: 'owner',
      full_name: 'Legacy Owner',
      pharmacy_id: null,
      permissions: '{"can_view_sales":true}',
      is_active: 1,
    };
    mockDbGet.mockResolvedValue(legacyUser);
    mockDbExecute.mockResolvedValue({ rowsAffected: 1 });
    mockInvoke.mockResolvedValue(true);

    await expect(loginLocal(' legacy-owner ', 'secret')).resolves.toEqual({
      success: true,
      user: {
        id: 'legacy-owner',
        username: 'legacy-owner',
        role: 'owner',
        full_name: 'Legacy Owner',
        pharmacy_id: null,
        permissions: '{"can_view_sales":true}',
      },
    });
    expect(mockInvoke).toHaveBeenCalledWith('bcrypt_compare', {
      password: 'secret',
      hash: 'existing-hash',
    });
    expect(mockDbExecute.mock.calls.some(([sql]) => String(sql).includes('UPDATE users SET password_hash'))).toBe(false);
    expect(JSON.parse(localStorage.getItem('pharma_session_user') || '{}')).toMatchObject({
      id: 'legacy-owner',
      pharmacy_id: null,
      permissions: '{"can_view_sales":true}',
    });

    await expect(getLocalSession()).resolves.toMatchObject({
      id: 'legacy-owner',
      pharmacy_id: null,
      permissions: '{"can_view_sales":true}',
    });
  });
});
