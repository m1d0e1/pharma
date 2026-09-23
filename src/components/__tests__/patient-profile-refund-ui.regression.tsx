import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import PatientProfileModal from '@/components/patients/PatientProfileModal';
import {
  addPatientAllergyAction,
  addPatientConditionAction,
  deletePatientAllergyAction,
  getReceiptDetailsAction,
  getPatientProfileAction,
  updatePatientAction,
  updatePatientWalletAction,
} from '@/app/actions-client/patients';
import { addPatientPaymentAction } from '@/app/actions-client/finance';
import { toast } from 'react-hot-toast';

let mockSession: any = {
  id: 'pharmacist-1',
  role: 'pharmacist',
  permissions: { can_view_patients: true, acc_can_process_cash_flow: true },
};

jest.mock('@/app/actions-client/patients', () => ({
  getPatientProfileAction: jest.fn(),
  updatePatientAction: jest.fn(),
  addPatientAllergyAction: jest.fn(),
  addPatientConditionAction: jest.fn(),
  deletePatientAllergyAction: jest.fn(),
  getReceiptDetailsAction: jest.fn(),
  updatePatientWalletAction: jest.fn(),
}));

jest.mock('@/app/actions-client/finance', () => ({
  addPatientPaymentAction: jest.fn(),
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/components/receipts/ReceiptDetailsModal', () => function MockReceiptDetailsModal({ invoice }: any) {
  return <div data-testid="patient-receipt-modal">receipt-{invoice.id}</div>;
});

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.role === 'owner' || user?.permissions?.[key] === true),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockSession = {
    id: 'pharmacist-1',
    role: 'pharmacist',
    permissions: { can_view_patients: true, acc_can_process_cash_flow: true },
  };
});

const profileData = {
  id: 'p1',
  full_name: 'محمد أحمد',
  wallet_balance: 50,
  credit_limit: 500,
  outstandingBalance: 120,
  allergies: [],
  conditions: [],
  purchaseHistory: [],
  payments: [],
};

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

test('keeps payment history visible but hides payment creation without cash-flow permission', async () => {
  mockSession.permissions.acc_can_process_cash_flow = false;
  (getPatientProfileAction as jest.Mock).mockResolvedValue({
    success: true,
    data: {
      id: 'p1',
      full_name: 'محمد أحمد',
      allergies: [],
      conditions: [],
      purchaseHistory: [],
      payments: [{ id: 'tx-1', type: 'payment', amount: 80, date: '2026-09-01', notes: 'سداد نقدي', user_name: 'أدمن' }],
    },
  });

  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);
  await screen.findByDisplayValue('محمد أحمد');
  fireEvent.click(screen.getByRole('button', { name: /توريدات نقدية/ }));

  expect(screen.getByText('سداد نقدي')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /إضافة توريد/ })).not.toBeInTheDocument();
});

test('restores profile-save controls and preserves edits when update throws', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({ success: true, data: profileData });
  (updatePatientAction as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));
  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);

  const nameInput = await screen.findByDisplayValue('محمد أحمد');
  fireEvent.change(nameInput, { target: { value: 'محمد بعد التعديل' } });
  fireEvent.click(screen.getByRole('button', { name: /حفظ جميع التعديلات/ }));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء تحديث البيانات'));
  expect(screen.getByRole('button', { name: /حفظ جميع التعديلات/ })).toBeEnabled();
  expect(screen.getByDisplayValue('محمد بعد التعديل')).toBeInTheDocument();
});

test('keeps a payment form open and reusable when payment creation throws', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({ success: true, data: profileData });
  (addPatientPaymentAction as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));
  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);

  await screen.findByDisplayValue('محمد أحمد');
  fireEvent.click(screen.getByRole('button', { name: /توريدات نقدية/ }));
  fireEvent.click(await screen.findByRole('button', { name: /إضافة توريد/ }));
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '25' } });
  fireEvent.click(screen.getByRole('button', { name: 'تأكيد تسجيل الدفعة' }));

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء إضافة الدفعة'));
  expect(screen.getByRole('button', { name: 'تأكيد تسجيل الدفعة' })).toBeEnabled();
  expect(screen.getByDisplayValue('25')).toBeInTheDocument();
});

test('keeps the patient profile open after a committed payment when only the follow-up profile reload fails', async () => {
  const onClose = jest.fn();
  (getPatientProfileAction as jest.Mock)
    .mockResolvedValueOnce({ success: true, data: profileData })
    .mockResolvedValueOnce({ success: false, error: 'profile refresh unavailable' })
    .mockResolvedValueOnce({ success: true, data: { ...profileData, current_balance: 25 } });
  (addPatientPaymentAction as jest.Mock).mockResolvedValueOnce({ success: true });
  render(<PatientProfileModal patientId="p1" onClose={onClose} onSuccess={jest.fn()} />);

  await screen.findByDisplayValue('محمد أحمد');
  fireEvent.click(screen.getByRole('button', { name: /توريدات نقدية/ }));
  fireEvent.click(await screen.findByRole('button', { name: /إضافة توريد/ }));
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '25' } });
  fireEvent.click(screen.getByRole('button', { name: 'تأكيد تسجيل الدفعة' }));

  await waitFor(() => expect(addPatientPaymentAction).toHaveBeenCalledTimes(1));
  expect(toast.success).toHaveBeenCalledWith('تم تسجيل الدفعة بنجاح');
  expect(await screen.findByText('تم الحفظ لكن تعذر تحديث ملف العميل')).toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getAllByText('محمد أحمد').length).toBeGreaterThan(0);

  fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل ملف العميل' }));
  await waitFor(() => expect(getPatientProfileAction).toHaveBeenCalledTimes(3));
  expect(screen.queryByText('تم الحفظ لكن تعذر تحديث ملف العميل')).not.toBeInTheDocument();
});

test('blocks repeated patient-payment submission while the financial write is pending', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({ success: true, data: profileData });
  let resolvePayment: (value: { success: boolean; error?: string }) => void = () => {};
  (addPatientPaymentAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
    resolvePayment = resolve;
  }));
  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);

  await screen.findByDisplayValue('محمد أحمد');
  fireEvent.click(screen.getByRole('button', { name: /توريدات نقدية/ }));
  fireEvent.click(await screen.findByRole('button', { name: /إضافة توريد/ }));
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '35' } });
  const submit = screen.getByRole('button', { name: 'تأكيد تسجيل الدفعة' });
  const form = submit.closest('form') as HTMLFormElement;
  fireEvent.submit(form);
  fireEvent.submit(form);

  await waitFor(() => expect(addPatientPaymentAction).toHaveBeenCalled());
  expect(addPatientPaymentAction).toHaveBeenCalledTimes(1);

  resolvePayment({ success: false, error: 'تعذر تسجيل الدفعة' });
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر تسجيل الدفعة'));
  expect(screen.getByDisplayValue('35')).toBeInTheDocument();
});

test('locks wallet top-up while pending and preserves the amount when the action rejects it', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({ success: true, data: profileData });
  let resolveTopUp!: (value: { success: boolean; error?: string }) => void;
  (updatePatientWalletAction as jest.Mock).mockImplementationOnce(() => new Promise(resolve => {
    resolveTopUp = resolve;
  }));
  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);

  await screen.findByDisplayValue('محمد أحمد');
  fireEvent.click(screen.getByRole('button', { name: 'المالية والتأمين' }));
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '40' } });
  fireEvent.click(screen.getByRole('button', { name: 'تأكيد الشحن' }));

  await waitFor(() => expect(updatePatientWalletAction).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: 'جاري الشحن...' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'جاري الشحن...' }));
  expect(updatePatientWalletAction).toHaveBeenCalledTimes(1);

  await act(async () => resolveTopUp({ success: false, error: 'لا توجد وردية مفتوحة' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('لا توجد وردية مفتوحة'));
  expect(screen.getByRole('button', { name: 'تأكيد الشحن' })).toBeEnabled();
  expect(screen.getByDisplayValue('40')).toBeInTheDocument();
});

test('keeps an allergy visible and surfaces a returned delete failure without false refresh', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({
    success: true,
    data: {
      ...profileData,
      allergies: [{ id: 9, allergen: 'Penicillin', severity: 'severe', notes: '' }],
    },
  });
  (deletePatientAllergyAction as jest.Mock).mockResolvedValueOnce({ success: false, error: 'غير مصرح' });
  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);

  await screen.findByDisplayValue('محمد أحمد');
  fireEvent.click(screen.getByRole('button', { name: 'الملف الطبي' }));
  const allergy = await screen.findByText('Penicillin');
  const deleteButton = allergy.closest('.group')?.querySelector('button') as HTMLButtonElement;
  fireEvent.click(deleteButton);

  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('غير مصرح'));
  expect(screen.getByText('Penicillin')).toBeInTheDocument();
  expect(getPatientProfileAction).toHaveBeenCalledTimes(1);
});

test('blocks duplicate allergy deletion and recovers when the delete action throws', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({
    success: true,
    data: {
      ...profileData,
      allergies: [{ id: 9, allergen: 'Penicillin', severity: 'severe', notes: '' }],
    },
  });
  let rejectDelete: (reason?: any) => void = () => {};
  (deletePatientAllergyAction as jest.Mock).mockImplementationOnce(() => new Promise((_resolve, reject) => {
    rejectDelete = reject;
  }));
  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);

  await screen.findByDisplayValue('محمد أحمد');
  fireEvent.click(screen.getByRole('button', { name: 'الملف الطبي' }));
  const allergy = await screen.findByText('Penicillin');
  const deleteButton = allergy.closest('.group')?.querySelector('button') as HTMLButtonElement;
  fireEvent.click(deleteButton);
  fireEvent.click(deleteButton);

  expect(deletePatientAllergyAction).toHaveBeenCalledTimes(1);
  expect(deleteButton).toBeDisabled();

  await act(async () => rejectDelete(new Error('delete bridge unavailable')));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل حذف الحساسية'));
  expect(screen.getByText('Penicillin')).toBeInTheDocument();
  expect(deleteButton).toBeEnabled();
});

test('blocks repeated profile-save submissions while the first update is pending', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({ success: true, data: profileData });
  let resolveUpdate!: (value: { success: boolean; error?: string }) => void;
  (updatePatientAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
    resolveUpdate = resolve;
  }));
  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);

  await screen.findByDisplayValue('محمد أحمد');
  const save = screen.getByRole('button', { name: /حفظ جميع التعديلات/ });
  const form = save.closest('form') as HTMLFormElement;
  act(() => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  expect(updatePatientAction).toHaveBeenCalledTimes(1);

  await act(async () => resolveUpdate({ success: false, error: 'تعذر التحديث مؤقتاً' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر التحديث مؤقتاً'));
});

test('blocks repeated wallet top-up events before the pending state rerenders', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({ success: true, data: profileData });
  let resolveTopUp!: (value: { success: boolean; error?: string }) => void;
  (updatePatientWalletAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
    resolveTopUp = resolve;
  }));
  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);

  await screen.findByDisplayValue('محمد أحمد');
  fireEvent.click(screen.getByRole('button', { name: 'المالية والتأمين' }));
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '45' } });
  const topUp = screen.getByRole('button', { name: 'تأكيد الشحن' });
  act(() => {
    topUp.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    topUp.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  await waitFor(() => expect(updatePatientWalletAction).toHaveBeenCalled());
  expect(updatePatientWalletAction).toHaveBeenCalledTimes(1);

  await act(async () => resolveTopUp({ success: false, error: 'تعذر شحن المحفظة' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر شحن المحفظة'));
});

test('keeps profile data owned by the newest patientId when an older request resolves afterwards', async () => {
  let resolveOld!: (value: any) => void;
  let resolveNew!: (value: any) => void;
  (getPatientProfileAction as jest.Mock).mockImplementation((id: string) => {
    if (id === 'p-old') return new Promise(resolve => { resolveOld = resolve; });
    if (id === 'p-new') return new Promise(resolve => { resolveNew = resolve; });
    return Promise.resolve({ success: false });
  });

  const view = render(<PatientProfileModal patientId="p-old" onClose={jest.fn()} onSuccess={jest.fn()} />);
  await waitFor(() => expect(getPatientProfileAction).toHaveBeenCalledWith('p-old'));
  view.rerender(<PatientProfileModal patientId="p-new" onClose={jest.fn()} onSuccess={jest.fn()} />);
  await waitFor(() => expect(getPatientProfileAction).toHaveBeenCalledWith('p-new'));

  await act(async () => resolveNew({ success: true, data: { ...profileData, id: 'p-new', full_name: 'Newest Patient' } }));
  expect(await screen.findByDisplayValue('Newest Patient')).toBeInTheDocument();

  await act(async () => resolveOld({ success: true, data: { ...profileData, id: 'p-old', full_name: 'Stale Patient' } }));
  expect(screen.queryByDisplayValue('Stale Patient')).not.toBeInTheDocument();
  expect(screen.getByDisplayValue('Newest Patient')).toBeInTheDocument();
});

test('blocks repeated allergy creation while the first write is pending', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({ success: true, data: profileData });
  let resolveAllergy!: (value: { success: boolean; error?: string }) => void;
  (addPatientAllergyAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
    resolveAllergy = resolve;
  }));
  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);

  await screen.findByDisplayValue('محمد أحمد');
  fireEvent.click(screen.getByRole('button', { name: 'الملف الطبي' }));
  fireEvent.click(screen.getByRole('button', { name: /إضافة حساسية جديدة/ }));
  fireEvent.change(screen.getByPlaceholderText('مثال: البنسلين'), { target: { value: 'Aspirin' } });
  const allergyHeading = screen.getByRole('heading', { name: 'إضافة حساسية جديدة' });
  const allergyForm = allergyHeading.closest('form') as HTMLFormElement;
  act(() => {
    allergyForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    allergyForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  expect(addPatientAllergyAction).toHaveBeenCalledTimes(1);

  await act(async () => resolveAllergy({ success: false, error: 'تعذر إضافة الحساسية' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر إضافة الحساسية'));
});

test('blocks repeated condition creation while the first write is pending', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({ success: true, data: profileData });
  let resolveCondition!: (value: { success: boolean; error?: string }) => void;
  (addPatientConditionAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
    resolveCondition = resolve;
  }));
  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);

  await screen.findByDisplayValue('محمد أحمد');
  fireEvent.click(screen.getByRole('button', { name: 'الملف الطبي' }));
  fireEvent.click(screen.getByRole('button', { name: /إضافة حالة صحية$/ }));
  fireEvent.change(screen.getByPlaceholderText('مثال: ضغط الدم المرتفع'), { target: { value: 'Diabetes' } });
  const conditionHeading = screen.getByRole('heading', { name: 'إضافة حالة صحية جديدة' });
  const conditionForm = conditionHeading.closest('form') as HTMLFormElement;
  act(() => {
    conditionForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    conditionForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });

  expect(addPatientConditionAction).toHaveBeenCalledTimes(1);

  await act(async () => resolveCondition({ success: false, error: 'تعذر إضافة الحالة المرضية' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('تعذر إضافة الحالة المرضية'));
});

test('keeps the latest purchase-history receipt when an older detail request resolves afterwards', async () => {
  (getPatientProfileAction as jest.Mock).mockResolvedValue({
    success: true,
    data: {
      ...profileData,
      purchaseHistory: [
        { invoice_id: 'receipt-old', total_amount: 20, created_at: '2026-09-20T10:00:00Z', drugs: 'Old Drug' },
        { invoice_id: 'receipt-new', total_amount: 30, created_at: '2026-09-21T10:00:00Z', drugs: 'New Drug' },
      ],
    },
  });
  let resolveOld!: (value: unknown) => void;
  let resolveNew!: (value: unknown) => void;
  (getReceiptDetailsAction as jest.Mock)
    .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));

  render(<PatientProfileModal patientId="p1" onClose={jest.fn()} onSuccess={jest.fn()} />);
  await screen.findByDisplayValue('محمد أحمد');
  fireEvent.click(screen.getByRole('button', { name: 'سجل المشتريات' }));

  fireEvent.click((await screen.findByText('Old Drug')).closest('.group') as HTMLElement);
  fireEvent.click(screen.getByText('New Drug').closest('.group') as HTMLElement);
  expect(getReceiptDetailsAction).toHaveBeenNthCalledWith(1, 'receipt-old');
  expect(getReceiptDetailsAction).toHaveBeenNthCalledWith(2, 'receipt-new');

  await act(async () => {
    resolveNew({ success: true, data: { id: 'receipt-new' } });
  });
  expect(await screen.findByTestId('patient-receipt-modal')).toHaveTextContent('receipt-receipt-new');

  await act(async () => {
    resolveOld({ success: true, data: { id: 'receipt-old' } });
  });
  expect(screen.getByTestId('patient-receipt-modal')).toHaveTextContent('receipt-receipt-new');
});
