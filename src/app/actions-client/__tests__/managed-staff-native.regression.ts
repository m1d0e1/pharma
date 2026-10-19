/** @jest-environment node */

const mockInvoke = jest.fn();
const mockRendererSql = jest.fn((..._args: unknown[]) => { throw new Error('renderer SQL must not run in native staff mutation'); });
const mockLocalSession = jest.fn((..._args: unknown[]) => { throw new Error('renderer session must not authorize native staff mutation'); });
const mockGenerateId = jest.fn(() => '3c56ecf8-6864-4d87-86e0-5f978a8cdf12');
const mockHandover = jest.fn((..._args: unknown[]): Promise<any> => Promise.resolve({ success: true }));
let mockIsTauri = true;

jest.mock('@/lib/env', () => ({ get isTauri() { return mockIsTauri; } }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: unknown[]) => mockRendererSql(...args),
  dbGet: (...args: unknown[]) => mockRendererSql(...args),
  dbExecute: (...args: unknown[]) => mockRendererSql(...args),
  dbTransaction: (...args: unknown[]) => mockRendererSql(...args),
  generateId: () => mockGenerateId(),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: (...args: unknown[]) => mockLocalSession(...args),
}));
jest.mock('@/app/actions-client/handover', () => ({
  processHandoverAction: (...args: unknown[]) => mockHandover(...args),
}));

import {
  addUserAction,
  closeUserShiftAndDeactivateAction,
  deleteUserAction,
  getStaffManagementDataAction,
  resetUserPasswordAction,
  updateUserAction,
  updateUserPermissionsAction,
} from '@/app/actions-client/users';

const closure = {
  userId: 'staff-a',
  shiftId: 'shift-a',
  actualCash: 121.75,
  authorizerPassword: 'verified by Rust only',
  notes: 'End of employment',
};
const nativeClosureConfirmation = {
  success: true,
  userId: 'staff-a',
  shiftId: 'shift-a',
  actualCash: 121.75,
  difference: 0,
  status: 'closed',
};

describe('managed staff native authorization and SQL boundary', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauri = true;
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => consoleError.mockRestore());

  const expectNoRendererAuthority = () => {
    expect(mockRendererSql).not.toHaveBeenCalled();
    expect(mockLocalSession).not.toHaveBeenCalled();
    expect(mockHandover).not.toHaveBeenCalled();
  };

  it('reads staff management only through typed native IPC', async () => {
    const native = {
      users: [{ id: 'staff-a', username: 'staff-a', full_name: 'Staff A', role: 'admin', is_active: 1, permissions: '{}', job_id: null, qualification: null, hire_date: null, shift: null, code: null, job_name_ar: null }],
      jobs: [{ id: 1, name_ar: 'صيدلي', name_en: 'Pharmacist', min_salary: 0, max_salary: 0, created_at: null }],
    };
    mockInvoke.mockResolvedValueOnce(native);
    expect(await getStaffManagementDataAction()).toEqual({ success: true, ...native });
    expect(mockInvoke).toHaveBeenCalledWith('get_staff_management_data_native');
    expectNoRendererAuthority();
  });

  it('routes add, update, permission, and password changes through narrow native commands', async () => {
    mockInvoke.mockResolvedValue({ success: true });
    expect((await addUserAction({ username: 'new-a', full_name: 'New A', role: 'pharmacist', password: 'Strong!Pass1', job_id: 2 })).success).toBe(true);
    expect((await updateUserAction('staff-a', { username: 'staff-2', full_name: 'Staff 2', role: 'admin', qualification: 'BPharm' })).success).toBe(true);
    expect((await updateUserPermissionsAction('staff-a', { can_view_sales: true, unknown: true })).success).toBe(true);
    expect((await resetUserPasswordAction('staff-a', 'Other!Pass2')).success).toBe(true);
    expect(mockInvoke.mock.calls.map(call => call[0])).toEqual([
      'add_staff_user_native', 'update_staff_user_native', 'update_staff_permissions_native', 'reset_staff_password_native',
    ]);
    expect(mockInvoke.mock.calls[0][1].payload).toMatchObject({ username: 'new-a', fullName: 'New A', password: 'Strong!Pass1', jobId: 2 });
    expect(mockInvoke.mock.calls[1][1].payload).toEqual({
      userId: 'staff-a', username: 'staff-2', fullName: 'Staff 2', role: 'admin', password: null,
      jobId: null, qualification: 'BPharm', hireDate: null, shift: null, code: null,
    });
    expect(mockInvoke.mock.calls[2][1].payload).toEqual({ userId: 'staff-a', permissions: { can_view_sales: true } });
    expect(mockInvoke.mock.calls[3][1].payload).toEqual({ userId: 'staff-a', newPassword: 'Other!Pass2' });
    expectNoRendererAuthority();
  });

  it('never forwards owner-only permissions for newly created restricted staff', async () => {
    mockInvoke.mockResolvedValue({ success: true });
    const ownerOnly = [
      'can_view_staff_manage', 'can_view_staff_roles', 'rep_can_view_activity', 'can_view_cogs',
    ];
    for (const role of ['admin', 'pharmacist', 'cashier']) {
      expect((await addUserAction({
        username: `new-${role}`, full_name: `New ${role}`, role, password: 'Strong!Pass1',
      })).success).toBe(true);
      const payload = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1][1].payload;
      expect(payload.role).toBe(role);
      for (const permission of ownerOnly) {
        expect(payload.permissions).not.toHaveProperty(permission);
      }
    }
    expect((await addUserAction({
      username: 'new-owner', full_name: 'New Owner', role: 'owner', password: 'Strong!Pass1',
    })).success).toBe(true);
    const ownerPayload = mockInvoke.mock.calls[mockInvoke.mock.calls.length - 1][1].payload;
    for (const permission of ownerOnly) {
      expect(ownerPayload.permissions[permission]).toBe(true);
    }
    expectNoRendererAuthority();
  });

  it.each([
    () => addUserAction({ username: 'new-a', full_name: 'New A', role: 'admin', password: 'Strong!Pass1' }),
    () => updateUserAction('staff-a', { username: 'staff-a', full_name: 'Staff A', role: 'admin' }),
    () => updateUserPermissionsAction('staff-a', { can_view_sales: true }),
    () => resetUserPasswordAction('staff-a', 'Other!Pass2'),
  ])('fails closed when a native staff mutation reply is malformed', async action => {
    mockInvoke.mockResolvedValueOnce({ success: true, extra: 'untrusted' });
    expect((await action()).success).toBe(false);
    expectNoRendererAuthority();
  });

  it('deactivates only through native IPC and never forwards a forged actor or tenant', async () => {
    mockInvoke.mockResolvedValueOnce({ success: true });

    const result = await (deleteUserAction as any)('staff-a', {
      actorId: 'forged-owner', pharmacyId: 'foreign-pharmacy', role: 'owner',
    });

    expect(result).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('deactivate_staff_native', {
      payload: { userId: 'staff-a' },
    });
    expect(mockGenerateId).not.toHaveBeenCalled();
    expectNoRendererAuthority();
  });

  it('retains the exact native OPEN_SHIFT cash snapshot without querying handover or SQL', async () => {
    mockInvoke.mockResolvedValueOnce({
      success: false,
      code: 'OPEN_SHIFT',
      error: 'untrusted extra message',
      openShift: {
        id: 'shift-a', start_time: '2026-10-11 09:00:00', expected_cash: 199.75,
        pharmacy_id: 'foreign-pharmacy',
      },
    });

    expect(await deleteUserAction('staff-a')).toEqual({
      success: false,
      code: 'OPEN_SHIFT',
      error: 'لدى الموظف وردية مفتوحة ويجب تسويتها قبل تعطيل الحساب',
      openShift: { id: 'shift-a', start_time: '2026-10-11 09:00:00', expected_cash: 199.75 },
    });
    expect(mockInvoke).toHaveBeenCalledWith('deactivate_staff_native', {
      payload: { userId: 'staff-a' },
    });
    expectNoRendererAuthority();
  });

  it.each([
    null,
    [],
    { success: 'true' },
    { success: true, code: 'OPEN_SHIFT' },
    { success: true, error: 'not really deactivated' },
    { success: false },
  ])('fails closed for a malformed deactivation reply: %p', async reply => {
    mockInvoke.mockResolvedValueOnce(reply);
    expect(await deleteUserAction('staff-a')).toEqual({ success: false, error: 'فشل حذف المستخدم' });
    expectNoRendererAuthority();
  });

  it.each([
    { success: false, code: 'OPEN_SHIFT' },
    { success: false, code: 'OPEN_SHIFT', openShift: { id: 'shift-a', start_time: null, expected_cash: 25 } },
    { success: false, code: 'OPEN_SHIFT', openShift: { id: 'shift-a', start_time: '2026-10-11', expected_cash: '25' } },
    { success: false, code: 'OPEN_SHIFT', openShift: { id: 'shift-a', start_time: '2026-10-11', expected_cash: Infinity } },
  ])('rejects an incomplete native open shift without fabricating its cash or start time: %p', async reply => {
    mockInvoke.mockResolvedValueOnce(reply);
    expect(await deleteUserAction('staff-a')).toEqual({
      success: false,
      error: 'تعذر قراءة تفاصيل الوردية المفتوحة؛ يرجى مراجعة الوردية قبل تعطيل الحساب',
    });
    expectNoRendererAuthority();
  });

  it.each([
    new Error('Owner permission denied by Rust'),
    new Error('Staff belongs to a different pharmacy'),
  ])('keeps native deactivation denial final, with no SQL fallback: %p', async denial => {
    mockInvoke.mockRejectedValueOnce(denial);
    expect(await deleteUserAction('staff-a')).toEqual({ success: false, error: 'فشل حذف المستخدم' });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expectNoRendererAuthority();
  });

  it('closes and deactivates through owner-verified native IPC using only business inputs and nonce', async () => {
    mockInvoke.mockResolvedValueOnce(nativeClosureConfirmation);
    const forged = {
      ...closure,
      actorId: 'forged-owner',
      pharmacyId: 'foreign-pharmacy',
      role: 'owner',
      expectedCash: -123456,
      transferTargetId: 'forged-bank',
    };

    expect(await closeUserShiftAndDeactivateAction(forged)).toEqual({ success: true });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('close_staff_shift_and_deactivate_native', {
      payload: {
        userId: 'staff-a',
        shiftId: 'shift-a',
        actualCash: 121.75,
        authorizerPassword: 'verified by Rust only',
        notes: 'End of employment',
        requestId: '3c56ecf8-6864-4d87-86e0-5f978a8cdf12',
      },
    });
    expect(mockGenerateId).toHaveBeenCalledTimes(1);
    expectNoRendererAuthority();
  });

  it('sends a null note when optional notes are omitted', async () => {
    mockInvoke.mockResolvedValueOnce(nativeClosureConfirmation);
    const { notes: _notes, ...withoutNotes } = closure;
    expect(await closeUserShiftAndDeactivateAction(withoutNotes)).toEqual({ success: true });
    expect(mockInvoke.mock.calls[0][1].payload.notes).toBeNull();
    expectNoRendererAuthority();
  });

  it.each([
    null,
    [],
    {},
    { success: 'true' },
    { success: true },
    { ...nativeClosureConfirmation, error: 'not really closed' },
    { ...nativeClosureConfirmation, userId: 'forged-other-user' },
    { ...nativeClosureConfirmation, shiftId: 'foreign-shift' },
    { ...nativeClosureConfirmation, actualCash: 200 },
    { ...nativeClosureConfirmation, difference: Infinity },
    { ...nativeClosureConfirmation, difference: '0' },
    { ...nativeClosureConfirmation, status: 'open' },
    { success: false, error: 'Invalid authorizer password' },
  ])('fails closed for a malformed or denied native closure reply: %p', async reply => {
    mockInvoke.mockResolvedValueOnce(reply);
    expect(await closeUserShiftAndDeactivateAction(closure)).toEqual({
      success: false, error: 'فشل إتمام عملية التسليم',
    });
    expectNoRendererAuthority();
  });

  it.each([
    new Error('Foreign tenant shift'),
    new Error('Wrong owner password'),
    new Error('Last owner cannot be deactivated'),
  ])('keeps native closure rejection final without SQL or web handover fallback: %p', async denial => {
    mockInvoke.mockRejectedValueOnce(denial);
    expect(await closeUserShiftAndDeactivateAction(closure)).toEqual({
      success: false, error: 'فشل إتمام عملية التسليم',
    });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expectNoRendererAuthority();
  });

  it('rejects invalid actual cash before invoking native closure', async () => {
    expect((await closeUserShiftAndDeactivateAction({ ...closure, actualCash: -1 })).success).toBe(false);
    expect((await closeUserShiftAndDeactivateAction({ ...closure, actualCash: Infinity })).success).toBe(false);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockGenerateId).not.toHaveBeenCalled();
    expectNoRendererAuthority();
  });

  it('retains the legacy web handover delegation and payload', async () => {
    mockIsTauri = false;
    mockHandover.mockResolvedValueOnce({ success: true, status: 'closed' });
    expect(await closeUserShiftAndDeactivateAction(closure)).toEqual({ success: true, status: 'closed' });
    expect(mockHandover).toHaveBeenCalledWith({
      shiftId: 'shift-a',
      actualCash: 121.75,
      transferAmount: 121.75,
      transferTargetId: '',
      transferTargetType: 'treasury',
      receiverUsername: '',
      receiverPasswordHash: '',
      closeOnly: true,
      managedUserId: 'staff-a',
      deactivateManagedUser: true,
      authorizerPassword: 'verified by Rust only',
      notes: 'End of employment',
    });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockGenerateId).not.toHaveBeenCalled();
  });
});
