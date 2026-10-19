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

import { getClientSession, getLocalSession, loginLocal, logoutLocal } from '@/lib/auth/local';

describe('local login audit regression', () => {
  beforeEach(() => {
    mockDbGet.mockReset();
    mockDbExecute.mockReset();
    mockInvoke.mockReset();
    localStorage.clear();
  });

  it('checks an unknown username in native login without exposing users through SQL', async () => {
    mockInvoke.mockResolvedValueOnce({ success: false, error: 'المستخدم غير موجود' });

    await expect(loginLocal('missing-user', 'secret')).resolves.toEqual({
      success: false,
      error: 'المستخدم غير موجود',
    });
    expect(mockInvoke).toHaveBeenCalledWith('authenticate_local', { username: 'missing-user', password: 'secret' });
    expect(mockDbGet).not.toHaveBeenCalled();
    expect(mockDbExecute).not.toHaveBeenCalled();
  });

  it('rejects an uninitialized staff password instead of allowing first-login account takeover', async () => {
    mockInvoke.mockResolvedValueOnce({ success: false, error: 'الحساب غير مهيأ. اطلب من المالك تعيين كلمة مرور.' });
    await expect(loginLocal('new-staff', 'attacker-chosen-password')).resolves.toEqual({
      success: false,
      error: 'الحساب غير مهيأ. اطلب من المالك تعيين كلمة مرور.',
    });
    expect(mockInvoke).toHaveBeenCalledWith('authenticate_local', { username: 'new-staff', password: 'attacker-chosen-password' });
    expect(mockDbExecute).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE users SET password_hash'), expect.anything());
    expect(localStorage.getItem('pharma_session_user')).toBeNull();
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
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'authenticate_local') {
        const { password_hash: _hash, is_active: _active, ...user } = legacyUser;
        return { success: true, user };
      }
      if (command === 'current_local_user') {
        const { password_hash: _hash, is_active: _active, ...user } = legacyUser;
        return user;
      }
      return null;
    });

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
    expect(mockInvoke).toHaveBeenCalledWith('authenticate_local', { username: 'legacy-owner', password: 'secret' });
    expect(mockDbGet).not.toHaveBeenCalled();
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

  it('does not trust a forged localStorage user ID and revokes native session at logout', async () => {
    localStorage.setItem('pharma_session_user', JSON.stringify({ id: 'attacker-chosen-owner', role: 'owner' }));
    mockInvoke.mockResolvedValueOnce(null);
    await expect(getLocalSession()).resolves.toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('current_local_user');
    expect(mockDbGet).not.toHaveBeenCalled();

    mockInvoke.mockResolvedValueOnce({ id: 'real-cashier', role: 'cashier', pharmacy_id: 'local_default' });
    await expect(getClientSession()).resolves.toMatchObject({ id: 'real-cashier', role: 'cashier' });
    expect(JSON.parse(localStorage.getItem('pharma_session_user') || '{}').id).toBe('real-cashier');

    await logoutLocal();
    expect(mockInvoke).toHaveBeenCalledWith('logout_local');
    expect(localStorage.getItem('pharma_session_user')).toBeNull();
  });

  it('does not sign out an existing desktop session after an unsuccessful login', async () => {
    localStorage.setItem('pharma_session_user', JSON.stringify({ id: 'signed-in-owner', role: 'owner' }));
    mockInvoke.mockResolvedValueOnce({ success: false, error: 'كلمة المرور غير صحيحة' });
    expect(await loginLocal('other-user', 'wrong')).toMatchObject({ success: false });
    expect(JSON.parse(localStorage.getItem('pharma_session_user') || '{}').id).toBe('signed-in-owner');
    expect(mockDbGet).not.toHaveBeenCalled();
  });
});
