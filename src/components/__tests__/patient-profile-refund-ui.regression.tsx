import { render, screen, fireEvent } from '@testing-library/react';
import PatientProfileModal from '@/components/patients/PatientProfileModal';
import { getPatientProfileAction } from '@/app/actions-client/patients';

jest.mock('@/app/actions-client/patients', () => ({
  getPatientProfileAction: jest.fn(),
  updatePatientAction: jest.fn(),
  addPatientAllergyAction: jest.fn(),
  addPatientConditionAction: jest.fn(),
  deletePatientAllergyAction: jest.fn(),
  getReceiptDetailsAction: jest.fn(),
}));

jest.mock('@/app/actions-client/finance', () => ({
  addPatientPaymentAction: jest.fn(),
}));

test('renders customer profile payments tab with payments and refund indicators', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({
    success: true,
    data: {
      id: 'p1',
      full_name: 'محمد أحمد',
      wallet_balance: 50,
      credit_limit: 500,
      outstandingBalance: 120,
      allergies: [],
      conditions: [],
      purchaseHistory: [],
      payments: [
        { id: 'tx-1', type: 'payment', amount: 80, date: '2026-09-01', notes: 'سداد نقدي', user_name: 'أدمن' },
        { id: 'tx-2', type: 'refund', amount: 35, date: '2026-09-02', notes: 'مرتجع مبيعات فاتورة #inv-1234', user_name: 'أدمن' },
      ],
    },
  });

  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);

  // Wait for profile load
  await screen.findByDisplayValue('محمد أحمد');

  // Switch to payments tab
  fireEvent.click(screen.getByRole('button', { name: /توريدات نقدية/ }));

  // Check payment row
  expect(screen.getByText('80 ج.م')).toBeInTheDocument();
  expect(screen.getByText('سداد نقدي')).toBeInTheDocument();

  // Check refund row (negative amount)
  expect(screen.getByText('-35 ج.م')).toBeInTheDocument();
  expect(screen.getByText('مرتجع مبيعات فاتورة #inv-1234')).toBeInTheDocument();
});
