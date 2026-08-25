import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PatientListClient from '@/components/patients/PatientListClient';
import { deletePatientAction, getPatientsAction } from '@/app/actions-client/patients';
import { toast } from 'react-hot-toast';

const refresh = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}));
jest.mock('@/components/AddPatientModal', () => function MockAddPatientModal() {
  return <div>add-patient-modal</div>;
});
jest.mock('@/components/patients/PatientProfileModal', () => function MockPatientProfileModal() {
  return <div>patient-profile-modal</div>;
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
