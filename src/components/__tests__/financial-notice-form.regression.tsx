import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
});