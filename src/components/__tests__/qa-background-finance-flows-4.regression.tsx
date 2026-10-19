import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import { FinancialNoticeForm } from '@/components/finance/FinancialComponents';
import { getClientSession } from '@/lib/auth/local';
import { getAccountsAction, getFinancialNoticesAction, addFinancialNoticeAction } from '@/app/actions-client/finance';
import { getPatientsAction } from '@/app/actions-client/patients';
import { getSuppliersAction } from '@/app/actions-client/purchases';
import { toast } from 'react-hot-toast';

// Every money-bearing operation is a Jest mock. No native IPC, database, or GUI.
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({ getClientSession: jest.fn() }));
jest.mock('@/components/finance/TrialBalanceSettingsClient', () => () => null);
jest.mock('@/components/reports/TrialBalanceReport', () => () => null);
jest.mock('@/components/finance/CashTransactionsClient', () => () => null);
jest.mock('@/app/actions-client/expenses', () => ({
  getExpensesAction: jest.fn(), addExpenseAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({
  getAccountsAction: jest.fn(),
  getFinancialNoticesAction: jest.fn(),
  addFinancialNoticeAction: jest.fn(),
  getCashMovementsAction: jest.fn(),
  getTreasuryDashboardAction: jest.fn(),
  getPointsOfSaleAction: jest.fn(),
  getBanksAction: jest.fn(),
  getExpenseDefinitionsAction: jest.fn(),
  getJournalsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/patients', () => ({
  getPatientsAction: jest.fn(), getPatientStatementAction: jest.fn(),
}));
jest.mock('@/app/actions-client/purchases', () => ({ getSuppliersAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const patient = {
  id: 'qa-notice-patient', full_name: 'Synthetic Notice Patient', phone: '01000000000',
  outstanding_balance: 240,
};
const supplier = {
  id: 'qa-notice-supplier', name: 'Synthetic Notice Supplier', phone: '01100000000',
  current_balance: 350,
};
const existingNotice = {
  id: 'qa-notice-before', type: 'credit', target_type: 'customer',
  target_id: patient.id, target_name: patient.full_name, amount: 36,
  reason: 'Legacy synthetic discount', user_name: 'QA Operator',
  notes: 'Existing synthetic notice', date: '2026-09-04',
};
const savedNotice = {
  id: 'qa-notice-after', type: 'debit', target_type: 'supplier',
  target_id: supplier.id, target_name: supplier.name, amount: 74,
  reason: 'فرق أسعار وبونص', user_name: 'QA Operator',
  notes: 'QA adjustment source reference', date: '2026-09-08',
};

function session(permissions: Record<string, boolean>) {
  return { id: 'qa-staff', role: 'pharmacist', permissions };
}

describe('QA background finance notices: guarded navigation, source references and action failures', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue(session({
      acc_can_view_general: true, acc_can_view_notifications: true,
    }));
    (getAccountsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    (getFinancialNoticesAction as jest.Mock).mockResolvedValue({
      success: true, data: [existingNotice],
    });
    (getPatientsAction as jest.Mock).mockResolvedValue({ success: true, data: [patient] });
    (getSuppliersAction as jest.Mock).mockResolvedValue({ success: true, data: [supplier] });
  });

  it('redirects an unauthorized notices tab to an allowed accounting tab before fetching notices', async () => {
    (getClientSession as jest.Mock).mockResolvedValue(session({
      acc_can_view_general: true, acc_can_view_notifications: false,
    }));
    render(<AccountsManagementClient initialTab="notices" />);

    expect(await screen.findByRole('button', { name: 'شجرة الحسابات' })).toBeInTheDocument();
    await waitFor(() => expect(getAccountsAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'الإشعارات والتسويات' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'إشعار مالي جديد (Notice)' })).not.toBeInTheDocument();
    expect(getFinancialNoticesAction).not.toHaveBeenCalled();
    expect(getPatientsAction).not.toHaveBeenCalled();
    expect(addFinancialNoticeAction).not.toHaveBeenCalled();
  });

  it('navigates to authorized notices, filters historical targets, and keeps unrelated accounting tabs intact', async () => {
    render(<AccountsManagementClient initialTab="chart_of_accounts" />);
    await waitFor(() => expect(getAccountsAction).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'الإشعارات والتسويات' }));

    expect(await screen.findByText(patient.full_name)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'إشعار مالي جديد (Notice)' })).toBeInTheDocument();
    expect(screen.getByText('إجمالي الإشعارات الدائنة (Credit)')).toBeInTheDocument();
    expect(getFinancialNoticesAction).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByPlaceholderText('بحث بالسبب، الجهة، أو الملاحظات...'), {
      target: { value: 'missing-token' },
    });
    expect(screen.getByText('لا توجد إشعارات مسجلة تطابق البحث')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('بحث بالسبب، الجهة، أو الملاحظات...'), {
      target: { value: 'Existing synthetic notice' },
    });
    expect(screen.getByText(patient.full_name)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'شجرة الحسابات' }));
    await waitFor(() => expect(getAccountsAction).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('heading', { name: 'إشعار مالي جديد (Notice)' })).not.toBeInTheDocument();
    expect(addFinancialNoticeAction).not.toHaveBeenCalled();
  });

  it('blocks a notice when the patient selector is empty and never attempts a money-bearing action', async () => {
    (getPatientsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    render(<FinancialNoticeForm />);
    await waitFor(() => expect(getPatientsAction).toHaveBeenCalledTimes(1));
    const submit = screen.getByRole('button', { name: 'حفظ الإشعار' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('المبلغ المستحق *'), { target: { value: '42' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(toast.error).toHaveBeenCalledWith('يرجى اختيار العميل المستهدف');
    expect(addFinancialNoticeAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'مورد' }));
    fireEvent.change(screen.getByLabelText('المبلغ المستحق *'), { target: { value: '0' } });
    expect(submit).toBeDisabled();
    expect(addFinancialNoticeAction).not.toHaveBeenCalled();
  });

  it('recovers both source selectors after a failed load, preserving entered notice fields', async () => {
    (getPatientsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('Synthetic patient-list bridge refused'))
      .mockResolvedValueOnce({ success: true, data: [patient] });
    (getSuppliersAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Synthetic supplier source blocked' })
      .mockResolvedValueOnce({ success: true, data: [supplier] });
    render(<FinancialNoticeForm />);

    fireEvent.change(screen.getByLabelText('المبلغ المستحق *'), { target: { value: '73.5' } });
    fireEvent.change(screen.getByLabelText('ملاحظات إضافية'), {
      target: { value: 'Synthetic reconciliation explanation' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('تعذر تحميل قوائم العملاء أو الموردين');
    expect(screen.getByLabelText('المبلغ المستحق *')).toHaveValue(73.5);
    fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل القوائم' }));

    expect(await screen.findByText(/Synthetic Notice Patient/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'مورد' }));
    expect(await screen.findByText(/Synthetic Notice Supplier/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('المبلغ المستحق *')).toHaveValue(73.5);
    expect(screen.getByLabelText('ملاحظات إضافية')).toHaveValue('Synthetic reconciliation explanation');
    expect(addFinancialNoticeAction).not.toHaveBeenCalled();
  });

  it('submits a supplier debit notice with exact source id, reason, date and notes; refreshes historical notice list after success', async () => {
    (addFinancialNoticeAction as jest.Mock).mockResolvedValue({ success: true, id: savedNotice.id });
    (getFinancialNoticesAction as jest.Mock)
      .mockResolvedValueOnce({ success: true, data: [existingNotice] })
      .mockResolvedValueOnce({ success: true, data: [existingNotice, savedNotice] });
    render(<AccountsManagementClient initialTab="notices" />);
    await screen.findByRole('heading', { name: 'إشعار مالي جديد (Notice)' });
    await waitFor(() => expect(getFinancialNoticesAction).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'مورد' }));
    await screen.findByText(/Synthetic Notice Supplier/);
    fireEvent.click(screen.getByRole('button', { name: /إضافة \(Debit\)/ }));
    fireEvent.change(screen.getByLabelText('المبلغ المستحق *'), { target: { value: '74' } });
    fireEvent.change(screen.getByLabelText('سبب الإشعار *'), { target: { value: 'فرق أسعار وبونص' } });
    fireEvent.change(screen.getByLabelText('تاريخ العملية'), { target: { value: '2026-09-08' } });
    fireEvent.change(screen.getByLabelText('ملاحظات إضافية'), {
      target: { value: 'QA adjustment source reference' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإشعار' }));

    await waitFor(() => expect(addFinancialNoticeAction).toHaveBeenCalledWith(expect.objectContaining({
      target_type: 'supplier', target_id: supplier.id, type: 'debit',
      amount: 74, reason: 'فرق أسعار وبونص', date: '2026-09-08',
      notes: 'QA adjustment source reference', request_id: expect.any(String),
    })));
    expect(await screen.findByText('QA adjustment source reference')).toBeInTheDocument();
    expect(getFinancialNoticesAction).toHaveBeenCalledTimes(2);
    expect(screen.getByText(supplier.name)).toBeInTheDocument();
    expect(screen.getByLabelText('المبلغ المستحق *')).toHaveValue(null);
    expect(toast.success).toHaveBeenCalledWith('تم حفظ الإشعار المالي بنجاح');
  });

  it('keeps a rejected notice editable and retries without claiming success or refreshing until the acknowledged action', async () => {
    (addFinancialNoticeAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Synthetic native financial notice rejected' })
      .mockResolvedValueOnce({ success: true, id: 'qa-acknowledged-notice' });
    render(<AccountsManagementClient initialTab="notices" />);
    await screen.findByRole('heading', { name: 'إشعار مالي جديد (Notice)' });
    // Permission gating now defers mounting the form until the session is
    // known; explicitly choose the valid patient after its options load.
    fireEvent.click(screen.getByRole('button', { name: 'عميل / مريض' }));
    await screen.findByRole('option', { name: /Synthetic Notice Patient/ });
    fireEvent.change(screen.getByLabelText('العميل / المريض المستهدف *'), { target: { value: patient.id } });
    fireEvent.change(screen.getByLabelText('المبلغ المستحق *'), { target: { value: '38' } });
    fireEvent.change(screen.getByLabelText('ملاحظات إضافية'), { target: { value: 'Synthetic reason retained' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإشعار' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Synthetic native financial notice rejected'));
    expect(getFinancialNoticesAction).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('المبلغ المستحق *')).toHaveValue(38);
    expect(screen.getByLabelText('ملاحظات إضافية')).toHaveValue('Synthetic reason retained');
    expect(toast.success).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإشعار' }));
    await waitFor(() => expect(getFinancialNoticesAction).toHaveBeenCalledTimes(2));
    expect(addFinancialNoticeAction).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('ملاحظات إضافية')).toHaveValue('');
  });

  it('locks a pending notice form even when two DOM submit events fire in one turn', async () => {
    let complete!: (result: { success: boolean; error?: string }) => void;
    (addFinancialNoticeAction as jest.Mock).mockImplementationOnce(
      () => new Promise(resolve => { complete = resolve; }),
    );
    const onSuccess = jest.fn();
    render(<FinancialNoticeForm targetId={patient.id} targetType="customer" onSuccess={onSuccess} />);
    expect(getPatientsAction).not.toHaveBeenCalled();
    expect(getSuppliersAction).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('المبلغ المستحق *'), { target: { value: '18' } });
    const form = screen.getByRole('button', { name: 'حفظ الإشعار' }).closest('form') as HTMLFormElement;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(addFinancialNoticeAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'جاري الحفظ...' })).toBeDisabled();
    await act(async () => { complete({ success: false, error: 'Synthetic transaction unavailable' }); });
    expect(toast.error).toHaveBeenCalledWith('Synthetic transaction unavailable');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByLabelText('المبلغ المستحق *')).toHaveValue(18);
    expect(screen.getByRole('button', { name: 'حفظ الإشعار' })).toBeEnabled();
  });
});
