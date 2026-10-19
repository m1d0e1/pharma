import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import StaffManagementClient from '@/components/admin/StaffManagementClient';

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

const PATIENTS_LABEL = 'عرض وإدارة المرضى وحساباتهم';
const INTERACTIONS_LABEL = 'عرض وفحص التفاعلات الدوائية';

type SavedFlags = Record<string, boolean>;

function mountEditor(role: string, storedPermissions: SavedFlags = {}) {
  const onUpdatePermissions = jest.fn(async (_id: string, _flags: unknown) => ({ success: true }));
  const onUpdateUser = jest.fn(async () => ({ success: true }));
  const user = userEvent.setup();

  render(<StaffManagementClient
    users={[{
      id: 'fixture-user',
      username: 'fixture',
      full_name: 'موظف تجريبي',
      role,
      permissions: JSON.stringify(storedPermissions),
    }]}
    jobs={[]}
    onUpdatePermissions={onUpdatePermissions}
    onUpdateUser={onUpdateUser}
    onAddUser={jest.fn(async () => ({ success: true }))}
    onDeleteUser={jest.fn(async () => ({ success: true }))}
    onCloseShiftAndDelete={jest.fn(async () => ({ success: true }))}
    onResetPassword={jest.fn(async () => ({ success: true }))}
  />);

  return { user, onUpdatePermissions, onUpdateUser };
}

async function openMedicalPermissions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'تعديل' }));
  const editor = screen.getByRole('dialog', { name: 'إدارة الموظف' });
  await user.click(within(editor).getByRole('button', { name: 'المرضى والطبية' }));
  return {
    editor,
    patients: within(editor).getByRole('checkbox', { name: PATIENTS_LABEL }),
    interactions: within(editor).getByRole('checkbox', { name: INTERACTIONS_LABEL }),
  };
}

describe('owner staff editor: patient and clinical interaction grants stay separate', () => {
  it('shows a newly introduced clinical grant as enabled for an owner with legacy saved permissions', async () => {
    const { user, onUpdatePermissions } = mountEditor('owner');
    const { editor, patients, interactions } = await openMedicalPermissions(user);

    expect(patients).toBeChecked();
    expect(interactions).toBeChecked();
    await user.click(within(editor).getByRole('button', { name: 'حفظ التغييرات' }));
    await waitFor(() => expect(onUpdatePermissions).toHaveBeenCalledWith('fixture-user', expect.objectContaining({
      can_view_patients: true,
      can_view_interactions: true,
    })));
  });

  it('does not infer interaction access from a legacy patient-only staff grant and saves explicit false', async () => {
    const { user, onUpdatePermissions } = mountEditor('pharmacist', { can_view_patients: true });
    const { editor, patients, interactions } = await openMedicalPermissions(user);

    expect(patients).toBeChecked();
    expect(interactions).not.toBeChecked();
    await user.click(within(editor).getByRole('button', { name: 'حفظ التغييرات' }));
    await waitFor(() => expect(onUpdatePermissions).toHaveBeenCalledWith('fixture-user', expect.objectContaining({
      can_view_patients: true,
      can_view_interactions: false,
    })));
  });

  it.each([
    { caseName: 'clinical-only', saved: { can_view_interactions: true, can_view_patients: false }, toggled: 'patients' },
    { caseName: 'patient-only', saved: { can_view_interactions: false, can_view_patients: true }, toggled: 'interactions' },
  ])('keeps the $caseName grant independent while editing the other checkbox', async ({ saved, toggled }) => {
    const { user, onUpdatePermissions, onUpdateUser } = mountEditor('pharmacist', saved);
    const { editor, patients, interactions } = await openMedicalPermissions(user);
    expect(patients).toHaveProperty('checked', saved.can_view_patients);
    expect(interactions).toHaveProperty('checked', saved.can_view_interactions);

    await user.click(toggled === 'patients' ? patients : interactions);
    expect(patients).toBeChecked();
    expect(interactions).toBeChecked();
    await user.click(within(editor).getByRole('button', { name: 'حفظ التغييرات' }));

    await waitFor(() => expect(onUpdatePermissions).toHaveBeenCalledWith('fixture-user', expect.objectContaining({
      can_view_patients: true,
      can_view_interactions: true,
    })));
    expect(onUpdateUser).toHaveBeenCalledWith('fixture-user', expect.objectContaining({ role: 'pharmacist' }));
  });
});
