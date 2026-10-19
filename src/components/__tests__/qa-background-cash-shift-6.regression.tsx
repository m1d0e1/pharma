import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CashTransactionsClient from '@/components/finance/CashTransactionsClient';
import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import ShiftReportClient from '@/components/reports/ShiftReportClient';
import * as finance from '@/app/actions-client/finance';
import { addExpenseAction } from '@/app/actions-client/expenses';
import { getCurrentShiftAction } from '@/app/actions-client/shifts';
import { getShiftReportAction } from '@/app/actions-client/reports';
import { getClientSession } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('next/link', () => function MockLink({ href, children, ...props }: React.PropsWithChildren<{ href: string }>) {
  return <a href={href} {...props}>{children}</a>;
});
jest.mock('@/lib/auth/local', () => ({ getClientSession: jest.fn() }));
jest.mock('@/app/actions-client/finance', () => ({
  createCashMovementAction: jest.fn(), getCashMovementsAction: jest.fn(),
  getTreasuryDashboardAction: jest.fn(), getPointsOfSaleAction: jest.fn(),
  getBanksAction: jest.fn(), getAccountsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/expenses', () => ({ getExpensesAction: jest.fn(), addExpenseAction: jest.fn() }));
jest.mock('@/app/actions-client/shifts', () => ({ getCurrentShiftAction: jest.fn() }));
jest.mock('@/app/actions-client/reports', () => ({ getShiftReportAction: jest.fn() }));
jest.mock('@/components/finance/FinancialComponents', () => ({ FinancialNoticeForm: () => null }));
jest.mock('@/components/finance/TrialBalanceSettingsClient', () => () => null);
jest.mock('@/components/reports/TrialBalanceReport', () => () => null);
jest.mock('@/components/shifts/ShiftReceiptsModal', () => function MockReceiptDialog({ isOpen, shiftId, onClose }: {
  isOpen: boolean; shiftId: string; onClose: () => void;
}) {
  return isOpen ? <div role="dialog" aria-label="Shift receipts">Shift source: {shiftId}
    <button onClick={onClose}>Close receipts</button>
  </div> : null;
});
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const empty = { success: true, data: [] };
const treasurySummary = {
  treasuryBalance: 900, drawerBalance: 100, ledgerCashBalance: 950,
  todayReceipts: 40, todayExpenses: 10, totalShiftHandovers: 65,
  counts: { treasury: 2, receipts: 1, expenses: 1, handovers: 1 },
};
const movements = [
  {
    id: 'movement-receipt', type: 'receipt', category: 'patient', amount: 87.5,
    target_name: 'Synthetic Patient One', notes: 'Synthetic received cash',
    user_name: 'Cashier A', shift_id: 'shift-source-A123', source_type: 'pos',
    created_at: '2026-09-20T09:30:00',
  },
  {
    id: 'movement-expense', type: 'disbursement', category: 'salaries', amount: 32,
    notes: 'Synthetic salary cash', user_name: 'Cashier B', shift_id: null,
    source_type: 'main_safe', created_at: 'invalid-date',
  },
];

describe('QA background cash, treasury and shift report rendered boundaries', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ role: 'owner', id: 'owner-synthetic' });
    (finance.getCashMovementsAction as jest.Mock).mockResolvedValue({ success: true, data: movements });
    (finance.getTreasuryDashboardAction as jest.Mock).mockResolvedValue({ success: true, data: treasurySummary });
    (finance.getPointsOfSaleAction as jest.Mock).mockResolvedValue(empty);
    (finance.getBanksAction as jest.Mock).mockResolvedValue(empty);
    (finance.getAccountsAction as jest.Mock).mockResolvedValue(empty);
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({ success: true, data: null });
    (finance.createCashMovementAction as jest.Mock).mockResolvedValue({ success: false, error: 'Synthetic financial write rejected' });
    (addExpenseAction as jest.Mock).mockResolvedValue({ success: false, error: 'Synthetic expense rejected' });
  });

  it('combines shift-reference search with type filters and clear, without fetching or changing totals', async () => {
    render(<CashTransactionsClient />);
    expect(await screen.findByText('Synthetic received cash', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('سجل الحركات الأخيرة (2)')).toBeInTheDocument();
    expect(screen.getByText('إجمالي التوريد (1)')).toBeInTheDocument();
    const search = screen.getByRole('textbox', { name: 'بحث في الحركات النقدية' });

    fireEvent.change(search, { target: { value: '  SHIFT-SOURCE-A123  ' } });
    expect(screen.getByText('سجل الحركات الأخيرة (1)')).toBeInTheDocument();
    expect(screen.getByText('Synthetic received cash', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Synthetic salary cash', { exact: false })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'صرف (1)' }));
    expect(screen.getByText('سجل الحركات الأخيرة (0)')).toBeInTheDocument();
    expect(screen.getByText('لا توجد نتائج مطابقة للبحث')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'مسح البحث' }));
    expect(screen.getByText('Synthetic salary cash', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Synthetic received cash', { exact: false })).not.toBeInTheDocument();
    expect(screen.getByText('إجمالي التوريد (1)')).toBeInTheDocument();
    expect(finance.getCashMovementsAction).toHaveBeenCalledTimes(1);
    expect(finance.createCashMovementAction).not.toHaveBeenCalled();
    expect(addExpenseAction).not.toHaveBeenCalled();
  });

  it('rejects negative receipt amounts, preserves read-only dates and submits an explicit non-shift source identity', async () => {
    (finance.getCashMovementsAction as jest.Mock).mockResolvedValue(empty);
    render(<CashTransactionsClient initialShowForm={{ show: true, type: 'receipt' }} />);
    const form = await screen.findByRole('dialog', { name: 'توريد نقدية جديدة' });
    await waitFor(() => expect(getCurrentShiftAction).toHaveBeenCalledTimes(1));
    expect(screen.getByText('لا توجد وردية مفتوحة')).toBeInTheDocument();
    const documentDate = screen.getByLabelText('تاريخ المستند') as HTMLInputElement;
    const actualDate = screen.getByLabelText('التاريخ الفعلي') as HTMLInputElement;
    expect(documentDate).toHaveAttribute('readonly');
    expect(actualDate).toHaveAttribute('readonly');
    expect(documentDate.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(actualDate.value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(screen.getByLabelText('وارد إلى')).toHaveValue('main_safe');

    fireEvent.change(screen.getByLabelText('القيمة المالية'), { target: { value: '-5' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ العملية' }));
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال قيمة صحيحة');
    expect(finance.createCashMovementAction).not.toHaveBeenCalled();
    expect(addExpenseAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('القيمة المالية'), { target: { value: '37.5' } });
    fireEvent.change(screen.getByLabelText('وارد إلى'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('وارد من النوع'), { target: { value: 'supplier' } });
    fireEvent.change(screen.getByLabelText('اسم الجهة / الشخص'), { target: { value: 'Synthetic Supplier Source' } });
    fireEvent.change(screen.getByLabelText('ملاحظات إضافية'), { target: { value: 'Synthetic receipt provenance' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ العملية' }));
    await waitFor(() => expect(finance.createCashMovementAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'receipt', amount: 37.5, category: 'supplier', source_type: 'admin',
      shift_id: undefined, target_name: 'Synthetic Supplier Source',
      notes: 'Synthetic receipt provenance', date: documentDate.value,
      actual_date: actualDate.value,
    })));
    expect(toast.error).toHaveBeenCalledWith('Synthetic financial write rejected');
    expect(form).toBeInTheDocument();
    expect(screen.getByLabelText('القيمة المالية')).toHaveValue(37.5);
    expect(addExpenseAction).not.toHaveBeenCalled();
  });

  it('routes personal withdrawals to a shift-bound movement and retries after a synthetic rejection', async () => {
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({
      success: true, data: { id: 'shift-cashier-specific', status: 'open' },
    });
    (finance.createCashMovementAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Synthetic rejection' })
      .mockResolvedValueOnce({ success: true, id: 'synthetic-confirmation' });
    render(<CashTransactionsClient />);
    expect(await screen.findByText(/وردية نشطة #shift-ca/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'صرف نقدية' }));
    expect(screen.getByLabelText('صرف من')).toHaveValue('pos');
    fireEvent.change(screen.getByLabelText('صرف إلى النوع'), { target: { value: 'personal' } });
    fireEvent.change(screen.getByLabelText('القيمة المالية'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ العملية' }));
    await waitFor(() => expect(finance.createCashMovementAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'disbursement', category: 'personal', amount: 12,
      source_type: 'pos', shift_id: 'shift-cashier-specific',
    })));
    expect(toast.error).toHaveBeenCalledWith('Synthetic rejection');
    expect(screen.getByRole('dialog', { name: 'صرف نقدية جديدة' })).toBeInTheDocument();
    expect(screen.getByLabelText('القيمة المالية')).toHaveValue(12);
    expect(addExpenseAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('القيمة المالية'), { target: { value: '14' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'حفظ العملية' }));
    });
    await waitFor(() => expect(finance.createCashMovementAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'صرف نقدية جديدة' })).not.toBeInTheDocument());
    expect(finance.createCashMovementAction).toHaveBeenLastCalledWith(expect.objectContaining({
      category: 'personal', amount: 14, shift_id: 'shift-cashier-specific',
    }));
    expect(finance.getCashMovementsAction).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith('تم تسجيل الحركة بنجاح');
  });

  it('blocks a forbidden initial cash tab before mounting any financial movement or shift read', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'restricted-viewer', role: 'pharmacist', permissions: ['acc_can_view_general'],
    });
    render(<AccountsManagementClient initialTab="cash_movement" />);
    expect(await screen.findByRole('button', { name: 'شجرة الحسابات' })).toBeInTheDocument();
    await waitFor(() => expect(finance.getAccountsAction).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'حركة النقدية' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'صرف نقدية' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(finance.getCashMovementsAction).not.toHaveBeenCalled();
    expect(getCurrentShiftAction).not.toHaveBeenCalled();
    expect(finance.createCashMovementAction).not.toHaveBeenCalled();
    expect(addExpenseAction).not.toHaveBeenCalled();
  });

  it('keeps owner treasury history read-only until navigating to the permitted cash form, with source and invalid-date indicators', async () => {
    (finance.getCashMovementsAction as jest.Mock).mockResolvedValue({ success: true, data: [
      { ...movements[0], id: 'handover-source', category: 'handover', source_type: 'user_drawer_received', user_name: 'Receiving Cashier', shift_id: 'shift-origin-XYZ' },
      movements[1],
    ] });
    render(<AccountsManagementClient initialTab="treasury" />);
    expect(await screen.findByText('سجل توريدات وحركات النقدية')).toBeInTheDocument();
    expect(await screen.findByText('درج Receiving Cashier')).toBeInTheDocument();
    expect(screen.getByText('وردية #shift-or')).toHaveAttribute('href', '/shifts');
    const invalidRow = screen.getByText('Synthetic salary cash', { exact: false }).closest('tr');
    expect(invalidRow?.querySelector('td')).toHaveTextContent('-');
    const search = screen.getByPlaceholderText('بحث في السجل (البيان، المستلم، المستخدم، القيمة)...');
    fireEvent.change(search, { target: { value: '  USER_DRAWER_RECEIVED ' } });
    expect(screen.getByText('عدد الحركات: (1)')).toBeInTheDocument();
    expect(screen.queryByText('Synthetic salary cash', { exact: false })).not.toBeInTheDocument();
    expect(finance.createCashMovementAction).not.toHaveBeenCalled();
    expect(addExpenseAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'صرف نقدية' }));
    expect(await screen.findByRole('dialog', { name: 'صرف نقدية جديدة' })).toBeInTheDocument();
    expect(screen.getByLabelText('صرف من')).toHaveValue('main_safe');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    });
    expect(screen.queryByRole('dialog', { name: 'صرف نقدية جديدة' })).not.toBeInTheDocument();
    expect(finance.createCashMovementAction).not.toHaveBeenCalled();
    expect(addExpenseAction).not.toHaveBeenCalled();
  });

  it('shows shift cash and visa separately, reconciles drawer movement, and opens receipts by keyboard with the requested shift identity', async () => {
    (getShiftReportAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        shift: { id: 'shift-qa-RECEIPT-1', staff_name: 'Synthetic Cashier', status: 'closed',
          start_time: '2026-09-20T09:00:00', end_time: '2026-09-20T17:00:00', starting_cash: 100 },
        sales: [
          { payment_method: 'cash', count: 2, total: 200, remaining: 0 },
          { payment_method: 'visa', count: 1, total: 90, remaining: 0 },
        ],
        returns: [{ payment_method: 'cash', count: 1, total: 20 }],
        movements: [],
        summary: {
          cashSales: 200, cashReturns: 20, cashReceipts: 15,
          cashDisbursements: 35, cashHandover: 10,
          expectedCash: 250, actualCash: 247, difference: -3,
        },
      },
    });
    render(<ShiftReportClient shiftId="shift-qa-RECEIPT-1" />);
    expect(await screen.findByText('Synthetic Cashier')).toBeInTheDocument();
    expect(getShiftReportAction).toHaveBeenCalledWith('shift-qa-RECEIPT-1');
    expect(screen.getByText('فيزا / شبكة')).toBeInTheDocument();
    expect(screen.getByText('نقدي')).toBeInTheDocument();
    expect(screen.getByText('يوجد فرق نقدي')).toBeInTheDocument();
    expect(screen.queryByText('مطابق تماماً')).not.toBeInTheDocument();
    expect(screen.getByText('تسليم درج / تحويلات (-)')).toBeInTheDocument();
    expect(screen.getByText('مصروفات / سحب أخرى (-)')).toBeInTheDocument();
    expect(screen.getByText('النقدية الدفترية المتوقعة بالدرج').parentElement).toHaveTextContent('250');
    expect(screen.getByText('النقدية المعدودة فعليًا في درج الوردية').parentElement).toHaveTextContent('247');

    const invoiceCount = screen.getByRole('button', { name: /عدد الفواتير: 3/ });
    fireEvent.keyDown(invoiceCount, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Shift receipts' })).toHaveTextContent('Shift source: shift-qa-RECEIPT-1');
    fireEvent.click(screen.getByRole('button', { name: 'Close receipts' }));
    expect(screen.queryByRole('dialog', { name: 'Shift receipts' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'عرض فواتير الوردية' }));
    expect(screen.getByRole('dialog', { name: 'Shift receipts' })).toBeInTheDocument();
    expect(finance.createCashMovementAction).not.toHaveBeenCalled();
    expect(addExpenseAction).not.toHaveBeenCalled();
  });
});
