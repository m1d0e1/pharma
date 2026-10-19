import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PatientProfileModal from '@/components/patients/PatientProfileModal';
import { getPatientProfileAction } from '@/app/actions-client/patients';

jest.mock('@/app/actions-client/patients', () => ({
  getPatientProfileAction: jest.fn(), updatePatientAction: jest.fn(),
  addPatientAllergyAction: jest.fn(), addPatientConditionAction: jest.fn(),
  deletePatientAllergyAction: jest.fn(), getReceiptDetailsAction: jest.fn(),
  updatePatientWalletAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({ addPatientPaymentAction: jest.fn(), addFinancialNoticeAction: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => ({ role: 'pharmacist', permissions: { acc_can_process_cash_flow: true } })),
  hasUserPermissionSync: (user: any, key: string) => !!user?.permissions?.[key],
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@/components/patients/CustomerStatementModal', () => function MockPatientStatement() {
  return <div>البيان الموثق متاح</div>;
});
jest.mock('@/components/receipts/ReceiptDetailsModal', () => () => null);
jest.mock('@/components/finance/FinancialComponents', () => ({
  CustomerStatementContent: () => null, FinancialNoticeForm: () => null,
}));

test('newly 061-owned native base profile stays open with wallet top-up and verified subset statement access', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({ success: true, data: {
    id: 'new-061-owned', full_name: 'Native Owned Patient', phone: null,
    credit_limit: 30, wallet_balance: null, points_balance: null,
    opening_balance: null, outstandingBalance: null,
    profileScope: 'owned_basics_only',
  } });
  const onClose = jest.fn();
  render(<PatientProfileModal patientId="new-061-owned" onClose={onClose} onSuccess={jest.fn()} />);
  await screen.findByRole('dialog', { name: 'Native Owned Patient' });
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByText(/بيانات هوية العميل موثقة/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'الملف الطبي' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'سجل المشتريات' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'حفظ جميع التعديلات' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'المالية والتأمين' }));
  expect(screen.getByText('شحن محفظة العميل')).toBeInTheDocument();
  expect(screen.getAllByText('غير متاح').length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: 'تأكيد الشحن' })).toBeEnabled();
  fireEvent.click(screen.getAllByRole('button', { name: 'كشف الحساب' })[0]);
  await waitFor(() => expect(screen.getByText('البيان الموثق متاح')).toBeInTheDocument());
});
