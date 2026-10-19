import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import PatientListClient from '@/components/patients/PatientListClient';
import PatientProfileModal from '@/components/patients/PatientProfileModal';
import {
  getPatientProfileAction, getPatientsAction, updatePatientWalletAction,
} from '@/app/actions-client/patients';
import { addPatientPaymentAction } from '@/app/actions-client/finance';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';

const mockRefresh = jest.fn();
const mockRouter = { push: jest.fn(), refresh: mockRefresh };

jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn(),
}));
jest.mock('@/app/actions-client/patients', () => ({
  getPatientProfileAction: jest.fn(), getPatientsAction: jest.fn(),
  updatePatientAction: jest.fn(), updatePatientWalletAction: jest.fn(),
  addPatientAllergyAction: jest.fn(), addPatientConditionAction: jest.fn(),
  deletePatientAllergyAction: jest.fn(), getReceiptDetailsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({
  addPatientPaymentAction: jest.fn(), addFinancialNoticeAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@/components/finance/FinancialComponents', () => ({
  CustomerStatementContent: () => null,
  FinancialNoticeForm: () => null,
}));
jest.mock('@/components/patients/CustomerStatementModal', () => () => null);
jest.mock('@/components/receipts/ReceiptDetailsModal', () => () => null);
jest.mock('@/components/AddPatientModal', () => () => null);

const debtor = {
  id: 'qa8-debtor-11', full_name: 'Synthetic Debtor', name_en: 'DEBT ACCOUNT',
  phone: '01111111011', address: '', notes: '', points_balance: 0,
  outstanding_balance: 90, wallet_balance: 12, credit_limit: 300,
  customer_type: 'individual', created_at: '2026-10-02T10:00:00Z',
};
const credited = {
  id: 'qa8-credit-22', full_name: 'Synthetic Credited', name_en: 'CREDIT CUSTOMER',
  phone: '01222222022', address: '', notes: '', points_balance: 0,
  outstanding_balance: -18, wallet_balance: 20, credit_limit: 240,
  customer_type: 'individual', created_at: '2026-10-03T10:00:00Z',
};
const creditRefund = {
  id: 'qa8-refund-1', type: 'refund', amount: 18, date: '2026-10-12',
  notes: 'Synthetic patient-account sale return', user_name: 'Synthetic Cashier',
};

function profileFor(id: string) {
  const patient = id === debtor.id ? debtor : credited;
  return {
    ...patient, outstandingBalance: patient.outstanding_balance,
    allergies: [], conditions: [], purchaseHistory: [],
    payments: id === credited.id ? [creditRefund] : [],
  };
}

function mountList() {
  return render(<PatientListClient
    pharmacyId="qa8-pharmacy" initialPatients={[debtor, credited]} canDeletePatients={false}
  />);
}

async function openPaymentForm() {
  fireEvent.click(screen.getByRole('button', { name: 'توريدات نقدية' }));
  fireEvent.click(await screen.findByRole('button', { name: 'إضافة توريد (F1)' }));
  return screen.getByRole('button', { name: 'تأكيد تسجيل الدفعة' });
}

describe('QA background: rendered patient search, receivable settlement and refund history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRefresh.mockReset();
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'qa8-staff', role: 'pharmacist',
      permissions: { acc_can_process_cash_flow: true, acc_can_view_notifications: false },
    });
    (hasUserPermissionSync as jest.Mock).mockImplementation((user, key) => user?.permissions?.[key] === true);
    (getPatientProfileAction as jest.Mock).mockImplementation(async (id: string) => ({
      success: true, data: profileFor(id),
    }));
    (getPatientsAction as jest.Mock).mockResolvedValue({ success: true, data: [debtor, credited] });
  });

  it('finds the exact debtor by English name then phone, opens that profile and posts a dated bank collection against its ID', async () => {
    (addPatientPaymentAction as jest.Mock).mockResolvedValue({ success: true });
    (getPatientsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ ...debtor, outstanding_balance: 53.75 }, credited],
    });
    mountList();
    const search = screen.getByRole('textbox', { name: 'بحث في المرضى بالاسم أو رقم الهاتف' });
    fireEvent.change(search, { target: { value: 'debt account' } });
    expect(screen.getByText('Synthetic Debtor')).toBeInTheDocument();
    expect(screen.queryByText('Synthetic Credited')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: debtor.phone } });
    expect(screen.getByText('Synthetic Debtor')).toBeInTheDocument();
    expect(screen.queryByText('Synthetic Credited')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'عرض وتعديل الملف' }));
    const dialog = await screen.findByRole('dialog', { name: 'Synthetic Debtor' });
    expect(getPatientProfileAction).toHaveBeenCalledWith(debtor.id);
    const submit = await openPaymentForm();
    fireEvent.change(within(dialog).getByLabelText('مبلغ الدفعة'), { target: { value: '36.25' } });
    fireEvent.change(within(dialog).getByLabelText('طريقة الدفع'), { target: { value: 'bank' } });
    fireEvent.change(within(dialog).getByLabelText('تاريخ الدفعة'), { target: { value: '2026-10-11' } });
    fireEvent.change(within(dialog).getByLabelText('البيان / ملاحظات'), {
      target: { value: 'Synthetic bank collection for earlier credit invoice' },
    });
    fireEvent.click(submit);

    await waitFor(() => expect(addPatientPaymentAction).toHaveBeenCalledWith(expect.objectContaining({
      patient_id: debtor.id, amount: 36.25, payment_method: 'bank',
      date: '2026-10-11', notes: 'Synthetic bank collection for earlier credit invoice',
      request_id: expect.any(String),
    })));
    expect(addPatientPaymentAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(getPatientsAction).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('53.75 ج.م')).toBeInTheDocument();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'تأكيد تسجيل الدفعة' })).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('blocks zero and negative credit settlements before the writer, then retains bank/date/note inputs for a returned-error retry', async () => {
    (addPatientPaymentAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Synthetic receivable write refused' })
      .mockResolvedValueOnce({ success: true });
    const onSuccess = jest.fn();
    const onClose = jest.fn();
    render(<PatientProfileModal patientId={credited.id} onClose={onClose} onSuccess={onSuccess} />);
    await screen.findByRole('dialog', { name: 'Synthetic Credited' });
    const submit = await openPaymentForm();
    const amount = screen.getByLabelText('مبلغ الدفعة');
    fireEvent.change(amount, { target: { value: '0' } });
    fireEvent.click(submit);
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال مبلغ صحيح');
    fireEvent.change(amount, { target: { value: '-9' } });
    fireEvent.click(submit);
    expect(addPatientPaymentAction).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();

    fireEvent.change(amount, { target: { value: '12.75' } });
    fireEvent.change(screen.getByLabelText('طريقة الدفع'), { target: { value: 'bank' } });
    fireEvent.change(screen.getByLabelText('تاريخ الدفعة'), { target: { value: '2026-09-29' } });
    fireEvent.change(screen.getByLabelText('البيان / ملاحظات'), { target: { value: 'Synthetic settlement correction' } });
    fireEvent.click(submit);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Synthetic receivable write refused'));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(submit).toBeEnabled();
    expect(amount).toHaveValue(12.75);
    expect(screen.getByLabelText('طريقة الدفع')).toHaveValue('bank');
    expect(screen.getByLabelText('تاريخ الدفعة')).toHaveValue('2026-09-29');
    expect(screen.getByLabelText('البيان / ملاحظات')).toHaveValue('Synthetic settlement correction');

    fireEvent.click(submit);
    const payload = {
      patient_id: credited.id, amount: 12.75, payment_method: 'bank',
      date: '2026-09-29', notes: 'Synthetic settlement correction',
    };
    await waitFor(() => expect(addPatientPaymentAction).toHaveBeenCalledTimes(2));
    const requestId = (addPatientPaymentAction as jest.Mock).mock.calls[0][0].request_id;
    expect(requestId).toEqual(expect.any(String));
    // A rejected retry keeps the same native idempotency key, preventing
    // duplicate collection if the original acknowledgement was lost.
    expect((addPatientPaymentAction as jest.Mock).mock.calls).toEqual([
      [{ ...payload, request_id: requestId }],
      [{ ...payload, request_id: requestId }],
    ]);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'تأكيد تسجيل الدفعة' })).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects zero and negative wallet funding, preserves a refused valid amount, then retries the exact patient and note', async () => {
    (updatePatientWalletAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Synthetic wallet credit denied' })
      .mockResolvedValueOnce({ success: true });
    render(<PatientProfileModal patientId={credited.id} onClose={jest.fn()} onSuccess={jest.fn()} />);
    await screen.findByRole('dialog', { name: 'Synthetic Credited' });
    fireEvent.click(screen.getByRole('button', { name: 'المالية والتأمين' }));
    const amount = screen.getByLabelText('المبلغ المراد شحنه');
    const confirm = screen.getByRole('button', { name: 'تأكيد الشحن' });

    fireEvent.click(confirm);
    fireEvent.change(amount, { target: { value: '0' } });
    fireEvent.click(confirm);
    fireEvent.change(amount, { target: { value: '-7' } });
    fireEvent.click(confirm);
    expect(updatePatientWalletAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال مبلغ صحيح');

    fireEvent.change(amount, { target: { value: '30.5' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Synthetic wallet credit denied'));
    expect(confirm).toBeEnabled();
    expect(amount).toHaveValue(30.5);
    expect(getPatientProfileAction).toHaveBeenCalledTimes(1);

    fireEvent.click(confirm);
    await waitFor(() => expect(updatePatientWalletAction).toHaveBeenCalledTimes(2));
    const requestId = (updatePatientWalletAction as jest.Mock).mock.calls[0][3];
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    // A lost native acknowledgement must not issue a new financial intent:
    // reusing the first UUID lets native duplicate protection prevent a second credit.
    expect((updatePatientWalletAction as jest.Mock).mock.calls).toEqual([
      [credited.id, 30.5, 'شحن يدوي من الملف الشخصي', requestId],
      [credited.id, 30.5, 'شحن يدوي من الملف الشخصي', requestId],
    ]);
    await waitFor(() => expect(getPatientProfileAction).toHaveBeenCalledTimes(2));
    expect(toast.success).toHaveBeenCalledWith('تم شحن المحفظة بنجاح');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('lets a restricted cashier search a credited patient and inspect a credit refund without exposing collection or wallet writers', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'qa8-viewer', role: 'cashier',
      permissions: { acc_can_process_cash_flow: false, acc_can_view_notifications: false },
    });
    mountList();
    fireEvent.change(screen.getByRole('textbox', { name: 'بحث في المرضى بالاسم أو رقم الهاتف' }), {
      target: { value: 'CREDIT CUSTOMER' },
    });
    expect(screen.getByText('Synthetic Credited')).toBeInTheDocument();
    expect(screen.getByText('رصيد دائن')).toBeInTheDocument();
    expect(screen.getByText('18.00 ج.م')).toBeInTheDocument();
    expect(screen.queryByText('Synthetic Debtor')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'عرض وتعديل الملف' }));
    const dialog = await screen.findByRole('dialog', { name: 'Synthetic Credited' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'توريدات نقدية' }));
    expect(within(dialog).getByText('-18 ج.م')).toBeInTheDocument();
    expect(within(dialog).getByText('Synthetic patient-account sale return')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'إضافة توريد (F1)' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'تأكيد تسجيل الدفعة' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'المالية والتأمين' }));
    expect(within(dialog).getByText('رصيد المحفظة')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('المبلغ المراد شحنه')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'تأكيد الشحن' })).not.toBeInTheDocument();
    expect(addPatientPaymentAction).not.toHaveBeenCalled();
    expect(updatePatientWalletAction).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
