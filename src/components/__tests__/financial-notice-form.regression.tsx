import React from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FinancialNoticeForm } from '@/components/finance/FinancialComponents';
import * as finance from '@/app/actions-client/finance';
import * as patients from '@/app/actions-client/patients';
import * as purchases from '@/app/actions-client/purchases';

jest.mock('@/app/actions-client/finance', () => ({
  addFinancialNoticeAction: jest.fn(),
}));

jest.mock('@/app/actions-client/patients', () => ({
  getPatientsAction: jest.fn(),
  getPatientStatementAction: jest.fn(),
}));

jest.mock('@/app/actions-client/purchases', () => ({
  getSuppliersAction: jest.fn(),
}));

describe('FinancialNoticeForm Component', () => {
  beforeEach(() => {
    (patients.getPatientsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { id: 'p-101', name: 'أحمد محمود', phone: '01011111111', current_balance: 300 },
        { id: 'p-102', name: 'سارة إبراهيم', phone: '01022222222', current_balance: 0 },
      ],
    });
    (purchases.getSuppliersAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { id: 1, name: 'الشركة المصرية للأدوية', phone: '01234567890', current_balance: 5000 },
      ],
    });
    (finance.addFinancialNoticeAction as jest.Mock).mockResolvedValue({ success: true, id: 'fn-new-1' });
  });

  it('renders with target type toggles and allows submitting customer credit notice', async () => {
    const onSuccess = jest.fn();
    render(<FinancialNoticeForm onSuccess={onSuccess} />);

    // Check header
    expect(screen.getByText(/إشعار مالي جديد/)).toBeInTheDocument();

    // Patients dropdown should populate
    expect(await screen.findByText(/أحمد محمود/)).toBeInTheDocument();

    // Select amount
    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '75' } });

    // Submit
    const saveBtn = screen.getByRole('button', { name: /حفظ الإشعار/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(finance.addFinancialNoticeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'credit',
          target_type: 'customer',
          target_id: 'p-101',
          amount: 75,
        })
      );
      expect(onSuccess).toHaveBeenCalled();
    });
  });

  it('switches target type to supplier and selects supplier from dropdown', async () => {
    render(<FinancialNoticeForm />);

    const supplierTabBtn = await screen.findByRole('button', { name: 'مورد' });
    fireEvent.click(supplierTabBtn);

    // Verify supplier dropdown rendered and select supplier
    expect(await screen.findByText(/الشركة المصرية للأدوية/)).toBeInTheDocument();
    const select = screen.getAllByRole('combobox')[0];
    fireEvent.change(select, { target: { value: '1' } });

    // Select debit
    const debitBtn = screen.getByRole('button', { name: /إضافة \(Debit\)/i });
    fireEvent.click(debitBtn);

    // Enter amount
    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '250' } });

    // Submit
    const saveBtn = screen.getByRole('button', { name: /حفظ الإشعار/i });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(finance.addFinancialNoticeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'debit',
          target_type: 'supplier',
          target_id: '1',
          amount: 250,
        })
      );
    });
  });

  it('blocks repeated financial-notice writes while the first submission is pending', async () => {
    let resolveNotice: (value: { success: boolean; error?: string }) => void = () => {};
    (finance.addFinancialNoticeAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveNotice = resolve;
    }));

    render(<FinancialNoticeForm targetId="p-101" />);
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '75' } });
    const form = screen.getByRole('button', { name: /حفظ الإشعار/i }).closest('form') as HTMLFormElement;

    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    expect(finance.addFinancialNoticeAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveNotice({ success: false, error: 'تعذر الحفظ مؤقتاً' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /حفظ الإشعار/i })).toBeEnabled());
  });

  it('preserves entered notice data and restores submission controls when the write throws', async () => {
    (finance.addFinancialNoticeAction as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));
    render(<FinancialNoticeForm targetId="p-101" />);

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '125' } });
    fireEvent.change(screen.getByPlaceholderText('سجل تفاصيل العملية ومبررات الإشعار هنا...'), {
      target: { value: 'احتفظ بهذه الملاحظة بعد الخطأ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /حفظ الإشعار/i }));

    await waitFor(() => expect(finance.addFinancialNoticeAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /حفظ الإشعار/i })).toBeEnabled());
    expect(screen.getByDisplayValue('125')).toBeInTheDocument();
    expect(screen.getByDisplayValue('احتفظ بهذه الملاحظة بعد الخطأ')).toBeInTheDocument();
  });

  it('shows a retryable selector-load error instead of presenting failed customer data as an empty list', async () => {
    (patients.getPatientsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('patients unavailable'))
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 'p-recovered', name: 'عميل مستعاد', phone: '01033333333', current_balance: 0 }],
      });
    render(<FinancialNoticeForm />);

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '90' } });
    expect(await screen.findByText('تعذر تحميل قوائم العملاء أو الموردين')).toBeInTheDocument();
    expect(screen.getByDisplayValue('90')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة تحميل القوائم' }));

    expect(await screen.findByText(/عميل مستعاد/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('90')).toBeInTheDocument();
  });
});
