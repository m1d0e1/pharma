import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StaffManagementClient from '@/components/admin/StaffManagementClient';

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

it('warns about an open shift and reconciles it before deactivating the user', async () => {
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  const onDeleteUser = jest.fn().mockResolvedValue({
    success: false,
    code: 'OPEN_SHIFT',
    error: 'open shift',
    openShift: { id: 'shift-1', start_time: '2026-08-31T09:00:00Z', expected_cash: 125 },
  });
  const onCloseShiftAndDelete = jest.fn().mockResolvedValue({ success: true });
  const user = userEvent.setup();

  render(
    <StaffManagementClient
      users={[{ id: 'user-1', username: 'cashier', full_name: 'Cashier One', role: 'pharmacist', permissions: '{}' }]}
      jobs={[]}
      onUpdatePermissions={jest.fn()}
      onAddUser={jest.fn()}
      onDeleteUser={onDeleteUser}
      onCloseShiftAndDelete={onCloseShiftAndDelete}
      onUpdateUser={jest.fn()}
      onResetPassword={jest.fn()}
    />,
  );

  await user.click(screen.getByTitle('حذف الموظف'));
  expect(await screen.findByRole('heading', { name: 'لدى الموظف وردية مفتوحة' })).toBeInTheDocument();
  expect(screen.getByText('125.00 ج.م')).toBeInTheDocument();

  await user.clear(screen.getByLabelText('النقدية الفعلية في الدرج'));
  await user.type(screen.getByLabelText('النقدية الفعلية في الدرج'), '120');
  await user.type(screen.getByLabelText('ملاحظات الإغلاق (اختياري)'), 'Counted by owner');
  await user.type(screen.getByLabelText('كلمة مرور المسؤول للتأكيد'), 'owner-password');
  await user.click(screen.getByRole('button', { name: 'إغلاق الوردية وتعطيل الحساب' }));

  await waitFor(() => expect(onCloseShiftAndDelete).toHaveBeenCalledWith({
    userId: 'user-1',
    shiftId: 'shift-1',
    actualCash: 120,
    authorizerPassword: 'owner-password',
    notes: 'Counted by owner',
  }));
  expect(screen.queryByRole('heading', { name: 'لدى الموظف وردية مفتوحة' })).not.toBeInTheDocument();
});

it('exposes a separate permission for discounting each sale item', async () => {
  const user = userEvent.setup();
  render(
    <StaffManagementClient
      users={[{ id: 'user-1', username: 'cashier', full_name: 'Cashier One', role: 'pharmacist', permissions: '{}' }]}
      jobs={[]}
      onUpdatePermissions={jest.fn()}
      onAddUser={jest.fn()}
      onDeleteUser={jest.fn()}
      onCloseShiftAndDelete={jest.fn()}
      onUpdateUser={jest.fn()}
      onResetPassword={jest.fn()}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'تعديل' }));
  await user.click(screen.getByRole('button', { name: /المبيعات/ }));
  expect(screen.getByRole('checkbox', { name: 'تعديل خصم كل صنف في سلة البيع' })).not.toBeChecked();
});
