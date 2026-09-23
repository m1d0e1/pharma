import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PatientsPage from '@/app/(dashboard)/patients/page';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getPatientsAction } from '@/app/actions-client/patients';

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/app/actions-client/patients', () => ({ getPatientsAction: jest.fn() }));
jest.mock('@/components/patients/PatientListClient', () => function MockPatientListClient({ canDeletePatients }: any) {
  return <div>delete-patients:{String(canDeletePatients)}</div>;
});

beforeEach(() => {
  jest.clearAllMocks();
  (getPatientsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  (hasUserPermissionSync as jest.Mock).mockImplementation((user: any, key: string) => user.permissions?.[key] === true);
});

it('passes the dedicated patient-delete permission through to the patient list', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({
    id: 'pharmacist-1',
    role: 'pharmacist',
    pharmacy_id: 'local_default',
    permissions: { can_view_patients: true, can_delete_patients: true },
  });

  render(<PatientsPage />);

  expect(await screen.findByText('delete-patients:true')).toBeInTheDocument();
});

it('does not grant patient deletion from the admin role when the dedicated permission is off', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({
    id: 'admin-1',
    role: 'admin',
    pharmacy_id: 'local_default',
    permissions: { can_view_patients: true, can_delete_patients: false },
  });

  render(<PatientsPage />);

  expect(await screen.findByText('delete-patients:false')).toBeInTheDocument();
});

it('does not keep an earlier patient-view authorization when retry resolves to a denied session', async () => {
  (getClientSession as jest.Mock)
    .mockResolvedValueOnce({
      id: 'patient-viewer',
      role: 'pharmacist',
      pharmacy_id: 'ph-1',
      permissions: { can_view_patients: true, can_delete_patients: false },
    })
    .mockResolvedValueOnce({
      id: 'restricted-user',
      role: 'pharmacist',
      pharmacy_id: 'ph-1',
      permissions: { can_view_patients: false, can_delete_patients: false },
    });
  (getPatientsAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'patient load failed' });

  render(<PatientsPage />);
  expect(await screen.findByText('تعذر تحميل بيانات المرضى')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

  await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('وصول غير مصرح به')).toBeInTheDocument();
  expect(screen.queryByText(/delete-patients:/)).not.toBeInTheDocument();
});

it('does not let an older patient retry re-authorize after a newer denied retry', async () => {
  let resolveOlder!: (value: any) => void;
  (getClientSession as jest.Mock)
    .mockResolvedValueOnce({
      id: 'patient-viewer',
      role: 'pharmacist',
      pharmacy_id: 'ph-1',
      permissions: { can_view_patients: true, can_delete_patients: false },
    })
    .mockImplementationOnce(() => new Promise(resolve => { resolveOlder = resolve; }))
    .mockResolvedValueOnce({
      id: 'restricted-user',
      role: 'pharmacist',
      pharmacy_id: 'ph-1',
      permissions: { can_view_patients: false, can_delete_patients: false },
    });
  (getPatientsAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'patient load failed' });

  render(<PatientsPage />);
  const retry = await screen.findByRole('button', { name: 'إعادة المحاولة' });
  act(() => {
    retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    retry.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await waitFor(() => expect(getClientSession).toHaveBeenCalledTimes(3));
  expect(await screen.findByText('وصول غير مصرح به')).toBeInTheDocument();

  await act(async () => {
    resolveOlder({
      id: 'stale-viewer',
      role: 'pharmacist',
      pharmacy_id: 'ph-1',
      permissions: { can_view_patients: true, can_delete_patients: false },
    });
  });

  await waitFor(() => expect(screen.getByText('وصول غير مصرح به')).toBeInTheDocument());
  expect(screen.queryByText(/delete-patients:/)).not.toBeInTheDocument();
});
