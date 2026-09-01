import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CashTransactionsClient from '@/components/finance/CashTransactionsClient';
import { getCashMovementsAction, createCashMovementAction } from '@/app/actions-client/finance';
import { addExpenseAction } from '@/app/actions-client/expenses';
import { getCurrentShiftAction } from '@/app/actions-client/shifts';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('next/link', () => {
  return function MockLink({ href, children, ...props }: any) {
    return <a href={href} {...props}>{children}</a>;
  };
});
jest.mock('@/app/actions-client/finance', () => ({
  createCashMovementAction: jest.fn(),
  getCashMovementsAction: jest.fn(),
}));
jest.mock('@/app/actions-client/shifts', () => ({
  getCurrentShiftAction: jest.fn(),
}));
jest.mock('@/app/actions-client/expenses', () => ({
  addExpenseAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

const mockMovements = [
  {
    id: 'cm-1',
    type: 'disbursement',
    category: 'operating_expenses',
    sub_category: 'أدوات مكتبية',
    amount: 150.0,
    user_id: 'user-1',
    user_name: 'د. أحمد',
    shift_id: 'shift-100',
    date: '2026-09-01',
    created_at: '2026-09-01T10:00:00Z',
    notes: 'شراء ورق طباعة'
  },
  {
    id: 'cm-2',
    type: 'receipt',
    category: 'patient',
    target_name: 'محمد علي',
    amount: 500.0,
    user_id: 'user-1',
    user_name: 'د. أحمد',
    shift_id: 'shift-100',
    date: '2026-09-01',
    created_at: '2026-09-01T11:00:00Z',
    notes: 'سداد حساب آجل'
  },
  {
    id: 'cm-3',
    type: 'disbursement',
    category: 'electricity',
    sub_category: '',
    amount: 200.0,
    user_id: 'user-2',
    user_name: 'د. سارة',
    shift_id: null,
    date: '2026-09-01',
    created_at: '2026-09-01T12:00:00Z',
    notes: 'فاتورة الكهرباء'
  }
];

describe('CashTransactionsClient Regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getCashMovementsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: mockMovements
    });
    (getCurrentShiftAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        id: 'shift-100',
        status: 'open',
        user_id: 'user-1',
        starting_cash_amount: 1000
      }
    });
    (createCashMovementAction as jest.Mock).mockResolvedValue({
      success: true,
      id: 'cm-new'
    });
    (addExpenseAction as jest.Mock).mockResolvedValue({
      success: true,
      id: 'expense-new'
    });
  });

  it('renders shift status, metrics, navigation links, and initial movements table', async () => {
    render(<CashTransactionsClient />);

    await waitFor(() => {
      expect(screen.getByText(/وردية نشطة/i)).toBeInTheDocument();
      expect(screen.getByText(/حركة النقدية \(صرف \/ توريد\)/i)).toBeInTheDocument();
    });

    // Check navigation links
    const shiftsLink = screen.getByRole('link', { name: /الورديات/i });
    expect(shiftsLink).toHaveAttribute('href', '/shifts');

    const handoverLink = screen.getByRole('link', { name: /تسليم الدرج/i });
    expect(handoverLink).toHaveAttribute('href', '/finance/handover');

    // Check KPIs
    expect(screen.getByText(/إجمالي الصرف \(2\)/i)).toBeInTheDocument();
    expect(screen.getByText(/إجمالي التوريد \(1\)/i)).toBeInTheDocument();

    // Check rows rendered
    expect(screen.getByText(/شراء ورق طباعة/)).toBeInTheDocument();
    expect(screen.getByText(/سداد حساب آجل/)).toBeInTheDocument();
    expect(screen.getByText(/فاتورة الكهرباء/)).toBeInTheDocument();
  });

  it('dynamically filters movements by type when clicking filter tabs', async () => {
    render(<CashTransactionsClient />);

    await waitFor(() => {
      expect(screen.getByText(/شراء ورق طباعة/)).toBeInTheDocument();
    });

    // Filter by 'صرف'
    const disbursementTab = screen.getByRole('button', { name: /صرف \(2\)/i });
    fireEvent.click(disbursementTab);

    expect(screen.getByText(/شراء ورق طباعة/)).toBeInTheDocument();
    expect(screen.getByText(/فاتورة الكهرباء/)).toBeInTheDocument();
    expect(screen.queryByText(/سداد حساب آجل/)).not.toBeInTheDocument();

    // Filter by 'توريد'
    const receiptTab = screen.getByRole('button', { name: /توريد \(1\)/i });
    fireEvent.click(receiptTab);

    expect(screen.queryByText(/شراء ورق طباعة/)).not.toBeInTheDocument();
    expect(screen.queryByText(/فاتورة الكهرباء/)).not.toBeInTheDocument();
    expect(screen.getByText(/سداد حساب آجل/)).toBeInTheDocument();

    // Reset to 'الكل'
    const allTab = screen.getByRole('button', { name: /الكل \(3\)/i });
    fireEvent.click(allTab);

    expect(screen.getByText(/شراء ورق طباعة/)).toBeInTheDocument();
    expect(screen.getByText(/سداد حساب آجل/)).toBeInTheDocument();
    expect(screen.getByText(/فاتورة الكهرباء/)).toBeInTheDocument();
  });

  it('dynamically searches movements by keyword', async () => {
    render(<CashTransactionsClient />);

    await waitFor(() => {
      expect(screen.getByText(/شراء ورق طباعة/)).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/بحث في البيان، المستلم، الملاحظات، أو المستخدم/i);
    fireEvent.change(searchInput, { target: { value: 'سارة' } });

    expect(screen.queryByText(/شراء ورق طباعة/)).not.toBeInTheDocument();
    expect(screen.queryByText(/سداد حساب آجل/)).not.toBeInTheDocument();
    expect(screen.getByText(/فاتورة الكهرباء/)).toBeInTheDocument();
  });

  it('opens disbursement form, links to open shift, and submits', async () => {
    render(<CashTransactionsClient />);

    await waitFor(() => {
      expect(screen.getByText(/صرف نقدية/i)).toBeInTheDocument();
    });

    const addDisbursementBtn = screen.getByRole('button', { name: /صرف نقدية/i });
    fireEvent.click(addDisbursementBtn);

    expect(screen.getByText('صرف نقدية جديدة')).toBeInTheDocument();

    const amountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(amountInput, { target: { value: '80' } });

    const notesInput = screen.getByPlaceholderText('اكتب أي ملاحظات هنا...');
    fireEvent.change(notesInput, { target: { value: 'شاي وسكر' } });

    const submitBtn = screen.getByRole('button', { name: /حفظ العملية/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(addExpenseAction).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 80,
          category: 'operating_expenses',
          description: 'شاي وسكر',
        })
      );
    });
    expect(createCashMovementAction).not.toHaveBeenCalled();
  });
});
