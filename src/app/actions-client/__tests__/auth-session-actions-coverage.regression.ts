const mockInvoke = jest.fn();
const mockGetLocalSession = jest.fn();
const mockLogoutLocal = jest.fn();
const mockLoginLocal = jest.fn();
const mockDbSelect = jest.fn();
const mockDbGet = jest.fn();
const mockDbExecute = jest.fn();

jest.mock('@/lib/env', () => ({ isTauri: true, isClient: true }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: (...args: unknown[]) => mockGetLocalSession(...args),
  logoutLocal: (...args: unknown[]) => mockLogoutLocal(...args),
  loginLocal: (...args: unknown[]) => mockLoginLocal(...args),
}));
jest.mock('@/lib/auth/staff-policy', () => ({
  isStaffOwner: (user: { role?: string } | null) => user?.role === 'owner',
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockDbSelect(...args),
  dbGet: (...args: unknown[]) => mockDbGet(...args),
  dbExecute: (...args: unknown[]) => mockDbExecute(...args),
  dbTransaction: jest.fn(),
}));
jest.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import {
  getCurrentUserAction, getLocalSessionAction, getLocalUsersAction,
  getOwnerEnrollmentStatusAction, enrollInitialOwnerAction,
  loginLocalAction,
} from '@/app/actions-client/auth';

describe('authenticated renderer auth actions use native session authority', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockGetLocalSession.mockReset();
    mockLogoutLocal.mockReset();
    mockLoginLocal.mockReset();
    mockDbSelect.mockReset();
    mockDbGet.mockReset();
    mockDbExecute.mockReset();
  });

  it('does not return a user or invoke privileged staff listing without a session', async () => {
    mockGetLocalSession.mockResolvedValue(null);
    expect(await getCurrentUserAction()).toEqual({ success: false, error: 'No session' });
    expect(await getLocalSessionAction()).toBeNull();
    expect(await getLocalUsersAction()).toEqual({ success: false, error: 'غير مصرح - للمالك فقط' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it('returns only public profile fields and denies cashier user enumeration', async () => {
    mockGetLocalSession.mockResolvedValue({
      id: 'cashier-a', username: 'cashier', role: 'cashier',
      pharmacy_id: 'ph-a', full_name: 'Cashier A', password_hash: 'secret-hash',
    });
    const current = await getCurrentUserAction();
    expect(current).toEqual({
      success: true, user: { id: 'cashier-a', full_name: 'Cashier A', role: 'cashier', pharmacy_id: 'ph-a' },
    });
    expect(JSON.stringify(current)).not.toContain('password_hash');
    expect(await getLocalSessionAction()).toEqual({
      id: 'cashier-a', username: 'cashier', full_name: 'Cashier A', role: 'cashier', pharmacy_id: 'ph-a',
    });
    expect(await getLocalUsersAction()).toMatchObject({ success: false });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('lists staff for owner only through fixed native IPC and propagates native errors safely', async () => {
    mockGetLocalSession.mockResolvedValue({ id: 'owner-a', role: 'owner', pharmacy_id: 'ph-a' });
    mockInvoke.mockResolvedValueOnce([{ id: 'cashier-a', username: 'cashier', has_password: true }]);
    expect(await getLocalUsersAction()).toEqual({
      success: true, data: [{ id: 'cashier-a', username: 'cashier', has_password: true }],
    });
    expect(mockInvoke).toHaveBeenCalledWith('list_local_staff_summaries');
    expect(mockDbSelect).not.toHaveBeenCalled();
    mockInvoke.mockRejectedValueOnce(new Error('Native owner session revoked'));
    expect(await getLocalUsersAction()).toEqual({ success: false, error: 'Failed to fetch users' });
  });

  it('preserves fail-closed behavior if native session retrieval throws', async () => {
    mockGetLocalSession.mockRejectedValue(new Error('Native session missing'));
    expect(await getCurrentUserAction()).toEqual({ success: false, error: 'Failed to get session' });
    expect(await getLocalSessionAction()).toBeNull();
    expect(await getLocalUsersAction()).toMatchObject({ success: false });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('handles native enrollment statuses and error shapes without exposing SQL', async () => {
    mockInvoke.mockResolvedValueOnce(false);
    expect(await getOwnerEnrollmentStatusAction()).toEqual({ success: true, pending: false });
    mockInvoke.mockResolvedValueOnce(null);
    expect(await getOwnerEnrollmentStatusAction()).toMatchObject({ success: false, pending: true });
    mockInvoke.mockRejectedValueOnce('fake permission denied');
    expect(await enrollInitialOwnerAction('synthetic-invalid-proof', 'Synthetic!Password2026')).toEqual({
      success: false, error: 'fake permission denied',
    });
    mockLoginLocal.mockResolvedValueOnce({ success: false, error: 'no enrolled account' });
    expect(await loginLocalAction('missing', 'test')).toMatchObject({ success: false });
    expect(mockDbExecute).not.toHaveBeenCalled();
  });
});
