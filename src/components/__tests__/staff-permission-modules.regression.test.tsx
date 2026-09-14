import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StaffManagementClient from '@/components/admin/StaffManagementClient';
import { PERMISSION_MODULES } from '@/lib/auth/permission-catalog';

afterEach(cleanup);

it('organizes every editable permission under its business module', async () => {
  const user = userEvent.setup();
  render(
    <StaffManagementClient
      users={[{ id: 'staff', username: 'staff', full_name: 'موظف', role: 'pharmacist', permissions: '{}' }]}
      jobs={[]}
      onUpdatePermissions={jest.fn(async () => ({ success: true }))}
      onAddUser={jest.fn(async () => ({ success: true }))}
      onDeleteUser={jest.fn(async () => ({ success: true }))}
      onCloseShiftAndDelete={jest.fn(async () => ({ success: true }))}
      onUpdateUser={jest.fn(async () => ({ success: true }))}
      onResetPassword={jest.fn(async () => ({ success: true }))}
    />,
  );

  await user.click(screen.getByRole('button', { name: 'تعديل' }));
  expect(screen.queryByRole('button', { name: 'خيارات أخرى' })).not.toBeInTheDocument();

  for (const permModule of PERMISSION_MODULES) {
    await user.click(screen.getByRole('button', { name: permModule.label }));
    expect(screen.getAllByText(permModule.title).length).toBeGreaterThan(0);
    for (const permission of permModule.permissions) {
      expect(screen.getAllByText(permission.label, { exact: false }).length).toBeGreaterThan(0);
    }
  }
});
