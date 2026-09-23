import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PatientListClient from '@/components/patients/PatientListClient';
import { deletePatientAction, getPatientsAction } from '@/app/actions-client/patients';
import { toast } from 'react-hot-toast';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));
jest.mock('@/components/AddPatientModal', () => function MockAddPatientModal({ onClose, onSuccess }: any) {
  return <div><span>add-patient-modal</span><button onClick={onClose}>close-add</button><button onClick={onSuccess}>success-add</button></div>;
});
jest.mock('@/components/patients/PatientProfileModal', () => function MockPatientProfileModal({ patientId, onClose, onSuccess }: any) {
  return <div><span>patient-profile-modal:{patientId}</span><button onClick={onClose}>close-profile</button><button onClick={onSuccess}>success-profile</button></div>;
});
jest.mock('@/app/actions-client/patients', () => ({
  deletePatientAction: jest.fn(),
  getPatientsAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
}));

const patients = [
  {
    id: 'patient-one', full_name: 'أحمد علي', name_en: 'Ahmed Ali', phone: '01011111111',
    address: 'Cairo', notes: '', points_balance: 5, outstanding_balance: 30,
    wallet_balance: 10, credit_limit: 100, customer_type: 'individual', created_at: '2026-08-25',
  },
  {
    id: 'patient-two', full_name: 'سارة حسن', name_en: 'Sara Hassan', phone: '01022222222',
    address: 'Giza', notes: '', points_balance: 0, outstanding_balance: -15,
    wallet_balance: 0, credit_limit: 100, customer_type: 'contract', created_at: '2026-08-25',
  },
];

it('searches patients and completes the permitted delete confirmation flow', async () => {
  (deletePatientAction as jest.Mock).mockResolvedValue({ success: true });
  (getPatientsAction as jest.Mock).mockResolvedValue({ success: true, data: [patients[1]] });
  const user = userEvent.setup();

  render(<PatientListClient initialPatients={patients} pharmacyId="local_default" canDeletePatients />);

  await user.type(screen.getByPlaceholderText('ابحث عن مريض بالاسم أو رقم الهاتف...'), '010111');
  expect(screen.getByText('أحمد علي')).toBeInTheDocument();
  expect(screen.queryByText('سارة حسن')).not.toBeInTheDocument();
  await user.clear(screen.getByPlaceholderText('ابحث عن مريض بالاسم أو رقم الهاتف...'));

  await user.click(screen.getAllByTitle('حذف المريض')[0]);
  expect(screen.getByRole('heading', { name: 'تأكيد حذف المريض' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'نعم، تأكيد الحذف' }));

  await waitFor(() => expect(deletePatientAction).toHaveBeenCalledWith('patient-one'));
  await waitFor(() => expect(screen.queryByText('أحمد علي')).not.toBeInTheDocument());
  expect(toast.success).toHaveBeenCalledWith('تم حذف المريض بنجاح');
  expect(refresh).toHaveBeenCalled();
});

it('opens and closes add/profile flows and refreshes the list after child success', async () => {
  const user = userEvent.setup();
  (getPatientsAction as jest.Mock).mockResolvedValue({ success: true, data: [patients[1]] });

  render(<PatientListClient initialPatients={patients} pharmacyId="local_default" canDeletePatients={false} />);

  expect(screen.queryByTitle('حذف المريض')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /إضافة مريض/ }));
  expect(screen.getByText('add-patient-modal')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'close-add' }));
  expect(screen.queryByText('add-patient-modal')).not.toBeInTheDocument();

  await user.click(screen.getAllByTitle('تعديل بيانات المريض')[0]);
  expect(screen.getByText('patient-profile-modal:patient-one')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'success-profile' }));
  await waitFor(() => expect(getPatientsAction).toHaveBeenCalled());
  expect(refresh).toHaveBeenCalled();
  expect(await screen.findByText('سارة حسن')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'close-profile' }));
  expect(screen.queryByText(/patient-profile-modal:/)).not.toBeInTheDocument();
});

it('supports delete cancellation and surfaces a failed delete without removing the patient', async () => {
  const user = userEvent.setup();
  (deletePatientAction as jest.Mock).mockResolvedValue({ success: false, error: 'لا يمكن حذف مريض مرتبط بحركات' });
  render(<PatientListClient initialPatients={patients} pharmacyId="local_default" canDeletePatients />);

  await user.click(screen.getAllByTitle('حذف المريض')[0]);
  await user.click(screen.getByRole('button', { name: 'إلغاء' }));
  expect(deletePatientAction).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'تأكيد حذف المريض' })).not.toBeInTheDocument();

  await user.click(screen.getAllByTitle('حذف المريض')[0]);
  await user.click(screen.getByRole('button', { name: 'نعم، تأكيد الحذف' }));
  await waitFor(() => expect(deletePatientAction).toHaveBeenCalledWith('patient-one'));
  expect(toast.error).toHaveBeenCalledWith('لا يمكن حذف مريض مرتبط بحركات');
  expect(screen.getByText('أحمد علي')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'تأكيد حذف المريض' })).toBeInTheDocument();
});

it('blocks repeated patient-delete events while the first delete is pending', async () => {
  let resolveDelete: (value: { success: boolean; error?: string }) => void = () => {};
  const pendingDelete = new Promise<{ success: boolean; error?: string }>(resolve => {
    resolveDelete = resolve;
  });
  (deletePatientAction as jest.Mock).mockReturnValue(pendingDelete);
  const user = userEvent.setup();
  render(<PatientListClient initialPatients={patients} pharmacyId="local_default" canDeletePatients />);

  await user.click(screen.getAllByTitle('حذف المريض')[0]);
  const confirm = screen.getByRole('button', { name: 'نعم، تأكيد الحذف' });

  act(() => {
    confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  await waitFor(() => expect(deletePatientAction).toHaveBeenCalled());
  expect(deletePatientAction).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveDelete({ success: false, error: 'تعذر الحذف مؤقتاً' });
  });
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر الحذف مؤقتاً'));
  expect(screen.getByText('أحمد علي')).toBeInTheDocument();
});

it('keeps newer route patients when an older child-success refresh resolves afterwards', async () => {
  let resolveRefresh: (value: { success: boolean; data: typeof patients }) => void = () => {};
  (getPatientsAction as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
    resolveRefresh = resolve;
  }));
  const user = userEvent.setup();
  const view = render(
    <PatientListClient initialPatients={patients} pharmacyId="local_default" canDeletePatients={false} />
  );

  await user.click(screen.getByRole('button', { name: /إضافة مريض/ }));
  await user.click(screen.getByRole('button', { name: 'success-add' }));
  await waitFor(() => expect(getPatientsAction).toHaveBeenCalledTimes(1));

  const newerPatients = [{
    ...patients[0],
    id: 'patient-newest',
    full_name: 'أحدث مريض من المسار',
    phone: '01033333333',
  }];
  view.rerender(
    <PatientListClient initialPatients={newerPatients} pharmacyId="local_default" canDeletePatients={false} />
  );
  expect(screen.getByText('أحدث مريض من المسار')).toBeInTheDocument();

  await act(async () => {
    resolveRefresh({ success: true, data: patients });
  });

  expect(screen.getByText('أحدث مريض من المسار')).toBeInTheDocument();
  expect(screen.queryByText('أحمد علي')).not.toBeInTheDocument();
});

it('does not misreport a completed patient delete as failed when the post-delete route refresh throws', async () => {
  (deletePatientAction as jest.Mock).mockResolvedValue({ success: true });
  (getPatientsAction as jest.Mock).mockResolvedValue({ success: true, data: [patients[1]] });
  refresh.mockImplementationOnce(() => {
    throw new Error('route refresh failed');
  });
  const user = userEvent.setup();
  render(<PatientListClient initialPatients={patients} pharmacyId="local_default" canDeletePatients />);

  await user.click(screen.getAllByTitle('حذف المريض')[0]);
  await user.click(screen.getByRole('button', { name: 'نعم، تأكيد الحذف' }));

  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('تم حذف المريض بنجاح'));
  expect(deletePatientAction).toHaveBeenCalledTimes(1);
  expect(toast.error).toHaveBeenCalledWith('تم حذف المريض لكن تعذر تحديث القائمة');
  expect(toast.error).not.toHaveBeenCalledWith('حدث خطأ أثناء حذف المريض');
  expect(screen.queryByRole('heading', { name: 'تأكيد حذف المريض' })).not.toBeInTheDocument();
  expect(screen.queryByText('أحمد علي')).not.toBeInTheDocument();
});
