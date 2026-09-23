import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StaffManagementClient from '@/components/admin/StaffManagementClient';
import toast from 'react-hot-toast';

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

const staff = {
  id: 'staff-1',
  username: 'pharmacist_one',
  full_name: 'Pharmacist One',
  role: 'pharmacist',
  permissions: '{}',
};

function renderStaff(overrides: Partial<React.ComponentProps<typeof StaffManagementClient>> = {}) {
  const props: React.ComponentProps<typeof StaffManagementClient> = {
    users: [staff],
    jobs: [],
    onUpdatePermissions: jest.fn(async () => ({ success: true })),
    onAddUser: jest.fn(async () => ({ success: true })),
    onDeleteUser: jest.fn(async () => ({ success: true })),
    onCloseShiftAndDelete: jest.fn(async () => ({ success: true })),
    onUpdateUser: jest.fn(async () => ({ success: true })),
    onResetPassword: jest.fn(async () => ({ success: true })),
    ...overrides,
  };
  render(<StaffManagementClient {...props} />);
  return props;
}

describe('coverage gap: staff-management direct controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('validates add-user basics, preserves the modal on returned failure, then closes on success', async () => {
    const onAddUser = jest.fn()
      .mockResolvedValueOnce({ success: false, error: 'username exists' })
      .mockResolvedValueOnce({ success: true });
    const user = userEvent.setup();
    renderStaff({ onAddUser });

    await user.click(screen.getByRole('button', { name: 'إضافة موظف جديد' }));
    await user.click(screen.getByRole('button', { name: 'حفظ الموظف' }));
    expect(onAddUser).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('يرجى ملء جميع البيانات الأساسية');

    await user.type(screen.getByPlaceholderText('مثال: د. محمد علي'), 'د. أحمد');
    await user.type(screen.getByPlaceholderText('m_ali'), 'ahmed');
    await user.type(screen.getByPlaceholderText('••••••••'), 'secret1');
    await user.click(screen.getByRole('button', { name: 'حفظ الموظف' }));

    await waitFor(() => expect(onAddUser).toHaveBeenCalledWith(expect.objectContaining({
      full_name: 'د. أحمد',
      username: 'ahmed',
      password: 'secret1',
      role: 'pharmacist',
    })));
    expect(toast.error).toHaveBeenCalledWith('username exists');
    expect(screen.getByRole('heading', { name: 'إضافة موظف' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'حفظ الموظف' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'إضافة موظف' })).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith('تم إضافة الموظف بنجاح');
  });

  it('cancels the add-user modal without submitting', async () => {
    const onAddUser = jest.fn();
    const user = userEvent.setup();
    renderStaff({ onAddUser });

    await user.click(screen.getByRole('button', { name: 'إضافة موظف جديد' }));
    await user.type(screen.getByPlaceholderText('مثال: د. محمد علي'), 'Draft User');
    await user.click(screen.getByRole('button', { name: 'إلغاء' }));

    expect(screen.queryByRole('heading', { name: 'إضافة موظف' })).not.toBeInTheDocument();
    expect(onAddUser).not.toHaveBeenCalled();
  });

  it('enforces reset-password minimum length, preserves failure state, and closes after success', async () => {
    const onResetPassword = jest.fn()
      .mockResolvedValueOnce({ success: false, error: 'reset rejected' })
      .mockResolvedValueOnce({ success: true });
    const user = userEvent.setup();
    renderStaff({ onResetPassword });

    await user.click(screen.getByTitle('إعادة تعيين كلمة المرور'));
    const password = screen.getByPlaceholderText('أدخل كلمة المرور الجديدة');
    const confirm = screen.getByRole('button', { name: 'تأكيد التغيير' });

    await user.type(password, '12345');
    expect(confirm).toBeDisabled();
    await user.type(password, '6');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    await waitFor(() => expect(onResetPassword).toHaveBeenCalledWith('staff-1', '123456'));
    expect(toast.error).toHaveBeenCalledWith('reset rejected');
    expect(screen.getByRole('heading', { name: 'إعادة تعيين المرور' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'تأكيد التغيير' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'إعادة تعيين المرور' })).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith('تم إعادة تعيين كلمة المرور بنجاح');
  });

  it('recovers the add-user modal from a thrown action error', async () => {
    const onAddUser = jest.fn().mockRejectedValueOnce(new Error('network down'));
    const user = userEvent.setup();
    renderStaff({ onAddUser });

    await user.click(screen.getByRole('button', { name: 'إضافة موظف جديد' }));
    await user.type(screen.getByPlaceholderText('مثال: د. محمد علي'), 'Thrown User');
    await user.type(screen.getByPlaceholderText('m_ali'), 'thrown');
    await user.click(screen.getByRole('button', { name: 'حفظ الموظف' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ الموظف' })).toBeEnabled());
    expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء إضافة الموظف');
    expect(screen.getByRole('heading', { name: 'إضافة موظف' })).toBeInTheDocument();
  });

  it('recovers the reset-password modal from a thrown action error', async () => {
    const onResetPassword = jest.fn().mockRejectedValueOnce(new Error('network down'));
    const user = userEvent.setup();
    renderStaff({ onResetPassword });

    await user.click(screen.getByTitle('إعادة تعيين كلمة المرور'));
    await user.type(screen.getByPlaceholderText('أدخل كلمة المرور الجديدة'), 'abcdef');
    await user.click(screen.getByRole('button', { name: 'تأكيد التغيير' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'تأكيد التغيير' })).toBeEnabled());
    expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء إعادة تعيين كلمة المرور');
    expect(screen.getByRole('heading', { name: 'إعادة تعيين المرور' })).toBeInTheDocument();
  });

  it('surfaces a thrown direct-deactivation error instead of leaving staff actions busy', async () => {
    jest.spyOn(window, 'confirm').mockReturnValueOnce(true);
    const onDeleteUser = jest.fn().mockRejectedValueOnce(new Error('delete transport down'));
    const user = userEvent.setup();
    renderStaff({ onDeleteUser });

    await user.click(screen.getByTitle('حذف الموظف'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء تعطيل الموظف'));
    expect(screen.getByText('Pharmacist One')).toBeInTheDocument();
  });

  it('recovers the open-shift reconciliation modal from a thrown close/deactivate action', async () => {
    jest.spyOn(window, 'confirm').mockReturnValueOnce(true);
    const onDeleteUser = jest.fn().mockResolvedValueOnce({
      success: false,
      code: 'OPEN_SHIFT',
      error: 'open shift',
      openShift: { id: 'shift-staff', start_time: '2026-09-21T08:00:00Z', expected_cash: 100 },
    });
    const onCloseShiftAndDelete = jest.fn().mockRejectedValueOnce(new Error('close transport down'));
    const user = userEvent.setup();
    renderStaff({ onDeleteUser, onCloseShiftAndDelete });

    await user.click(screen.getByTitle('حذف الموظف'));
    expect(await screen.findByRole('heading', { name: 'لدى الموظف وردية مفتوحة' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('كلمة مرور المسؤول للتأكيد'), 'owner-password');
    await user.click(screen.getByRole('button', { name: 'إغلاق الوردية وتعطيل الحساب' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'إغلاق الوردية وتعطيل الحساب' })).toBeEnabled());
    expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء إغلاق الوردية وتعطيل الحساب');
    expect(screen.getByRole('heading', { name: 'لدى الموظف وردية مفتوحة' })).toBeInTheDocument();
  });

  it('blocks repeated add-user events while the first create is pending', async () => {
    let resolveAdd: (value: { success: boolean; error?: string }) => void = () => {};
    const onAddUser = jest.fn(() => new Promise<{ success: boolean; error?: string }>(resolve => { resolveAdd = resolve; }));
    const user = userEvent.setup();
    renderStaff({ onAddUser });

    await user.click(screen.getByRole('button', { name: 'إضافة موظف جديد' }));
    await user.type(screen.getByPlaceholderText('مثال: د. محمد علي'), 'Single Create');
    await user.type(screen.getByPlaceholderText('m_ali'), 'single_create');
    const save = screen.getByRole('button', { name: 'حفظ الموظف' });

    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onAddUser).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAdd({ success: false, error: 'تعذر الإنشاء مؤقتاً' });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ الموظف' })).toBeEnabled());
  });

  it('blocks repeated password-reset events while the first reset is pending', async () => {
    let resolveReset: (value: { success: boolean; error?: string }) => void = () => {};
    const onResetPassword = jest.fn(() => new Promise<{ success: boolean; error?: string }>(resolve => { resolveReset = resolve; }));
    const user = userEvent.setup();
    renderStaff({ onResetPassword });

    await user.click(screen.getByTitle('إعادة تعيين كلمة المرور'));
    await user.type(screen.getByPlaceholderText('أدخل كلمة المرور الجديدة'), 'abcdef');
    const confirm = screen.getByRole('button', { name: 'تأكيد التغيير' });

    act(() => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onResetPassword).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReset({ success: false, error: 'تعذر التغيير مؤقتاً' });
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'تأكيد التغيير' })).toBeEnabled());
  });

  it('blocks repeated edit saves and keeps the editor open when permission saving fails', async () => {
    let resolveInfo: (value: { success: boolean; error?: string }) => void = () => {};
    const onUpdateUser = jest.fn(() => new Promise<{ success: boolean; error?: string }>(resolve => { resolveInfo = resolve; }));
    const onUpdatePermissions = jest.fn().mockResolvedValue({ success: false, error: 'permission save failed' });
    const user = userEvent.setup();
    renderStaff({ onUpdateUser, onUpdatePermissions });

    await user.click(screen.getByRole('button', { name: 'تعديل' }));
    const save = screen.getByRole('button', { name: 'حفظ التغييرات' });

    act(() => {
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      save.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onUpdateUser).toHaveBeenCalledTimes(1);
    expect(onUpdatePermissions).not.toHaveBeenCalled();

    await act(async () => {
      resolveInfo({ success: true });
    });

    await waitFor(() => expect(onUpdatePermissions).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith('permission save failed');
    expect(screen.getByRole('button', { name: 'حفظ التغييرات' })).toBeEnabled();
  });
});
