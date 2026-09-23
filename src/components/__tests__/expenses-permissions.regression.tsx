import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ExpensesPage from '@/app/(dashboard)/expenses/page';
import { getClientSession } from '@/lib/auth/local';
import { addExpenseAction, getExpensesAction } from '@/app/actions-client/expenses';
import { toast } from 'react-hot-toast';

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}));

jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
  hasUserPermissionSync: jest.fn((user: any, key: string) => (
    user?.role === 'owner' || user?.permissions?.[key] === true
  )),
}));

jest.mock('@/app/actions-client/expenses', () => ({
  addExpenseAction: jest.fn(),
  getExpensesAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  getExpenseSummaryAction: jest.fn().mockResolvedValue({
    success: true,
    data: {
      totalRevenue: 0,
      totalExpenses: 0,
      totalReturns: 0,
      totalCOGS: 0,
      netProfit: 0,
      byCategory: [],
    },
  }),
}));

jest.mock('@/app/actions-client/finance', () => ({
  getExpenseDefinitionsAction: jest.fn().mockResolvedValue({
    success: true,
    data: [{ id: 1, code: 'rent', name_ar: 'إيجار', name_en: 'Rent' }],
  }),
}));

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  toast: { success: jest.fn(), error: jest.fn() },
}));

describe('standalone expenses permission wiring', () => {
  beforeEach(() => {
    push.mockReset();
  });

  it('lets a cash-flow operator who can view expenses open the record-expense form', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'cash-flow-operator',
      role: 'pharmacist',
      permissions: {
        can_view_expenses: true,
        acc_can_process_cash_flow: true,
        acc_can_define_expenses: false,
      },
    });

    render(<ExpensesPage />);

    expect(await screen.findByText('المصروفات والأرباح')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /إضافة مصروف/i })).toBeInTheDocument();
  });

  it('keeps a view-only expenses user read-only', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'expense-viewer',
      role: 'pharmacist',
      permissions: {
        can_view_expenses: true,
        acc_can_process_cash_flow: false,
        acc_can_define_expenses: false,
      },
    });

    render(<ExpensesPage />);

    expect(await screen.findByText('المصروفات والأرباح')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /إضافة مصروف/i })).not.toBeInTheDocument();
  });

  it('shows a retryable load error instead of presenting a failed expense request as a healthy empty list', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'expense-viewer',
      role: 'pharmacist',
      permissions: { can_view_expenses: true },
    });
    (getExpensesAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'expense load failed' })
      .mockResolvedValueOnce({
        success: true,
        data: [{ id: 'exp-1', date: '2026-09-21', category: 'rent', description: 'Recovered expense', amount: 20, user_name: 'Owner' }],
      });

    render(<ExpensesPage />);

    expect(await screen.findByText('تعذر تحميل بيانات المصروفات')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد مصروفات مسجلة')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('Recovered expense')).toBeInTheDocument();
  });

  it('blocks repeated expense writes while the first submission is pending', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'cash-flow-operator',
      role: 'pharmacist',
      permissions: { can_view_expenses: true, acc_can_process_cash_flow: true },
    });
    let resolveAdd: (value: { success: boolean; error?: string }) => void = () => {};
    (addExpenseAction as jest.Mock).mockImplementation(() => new Promise(resolve => {
      resolveAdd = resolve;
    }));

    render(<ExpensesPage />);
    await screen.findByText('المصروفات والأرباح');
    fireEvent.click(screen.getByRole('button', { name: /إضافة مصروف/i }));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '25' } });
    const form = screen.getByRole('button', { name: 'حفظ' }).closest('form') as HTMLFormElement;

    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    expect(addExpenseAction).toHaveBeenCalledTimes(1);
    await act(async () => resolveAdd({ success: false, error: 'write rejected' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled());
  });

  it('keeps the expense form open when Cancel is clicked while the write is pending', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'cash-flow-operator',
      role: 'pharmacist',
      permissions: { can_view_expenses: true, acc_can_process_cash_flow: true },
    });
    (getExpensesAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
    let resolveAdd: (value: { success: boolean; error?: string }) => void = () => {};
    const pending = new Promise<{ success: boolean; error?: string }>(resolve => {
      resolveAdd = resolve;
    });
    (addExpenseAction as jest.Mock).mockReturnValue(pending);

    render(<ExpensesPage />);
    await screen.findByText('المصروفات والأرباح');
    fireEvent.click(screen.getByRole('button', { name: /إضافة مصروف/i }));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '45' } });
    fireEvent.change(screen.getByPlaceholderText('وصف المصروف...'), { target: { value: 'مصروف معلّق' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(addExpenseAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByDisplayValue('45')).toBeInTheDocument();
    expect(screen.getByDisplayValue('مصروف معلّق')).toBeInTheDocument();

    await act(async () => {
      resolveAdd({ success: false, error: 'write rejected' });
      await pending;
    });
  });

  it('preserves entered expense data and restores submission controls when the write throws', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'cash-flow-operator',
      role: 'pharmacist',
      permissions: { can_view_expenses: true, acc_can_process_cash_flow: true },
    });
    (addExpenseAction as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));

    render(<ExpensesPage />);
    await screen.findByText('المصروفات والأرباح');
    fireEvent.click(screen.getByRole('button', { name: /إضافة مصروف/i }));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '35' } });
    fireEvent.change(screen.getByPlaceholderText('وصف المصروف...'), { target: { value: 'احتفظ بالبيانات' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل إضافة المصروف'));
    expect(screen.getByDisplayValue('35')).toBeInTheDocument();
    expect(screen.getByDisplayValue('احتفظ بالبيانات')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'حفظ' })).toBeEnabled();
  });

  it('keeps a newer filtered expense result when an older request resolves afterwards', async () => {
    (getClientSession as jest.Mock).mockResolvedValue({
      id: 'expense-viewer',
      role: 'pharmacist',
      permissions: { can_view_expenses: true },
    });
    let resolveAll: (value: any) => void = () => {};
    let resolveRent: (value: any) => void = () => {};
    (getExpensesAction as jest.Mock).mockImplementation((filter?: { category?: string }) => new Promise(resolve => {
      if (filter?.category === 'rent') resolveRent = resolve;
      else resolveAll = resolve;
    }));

    render(<ExpensesPage />);
    await screen.findByText('المصروفات والأرباح');
    await waitFor(() => expect(getExpensesAction).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'rent' } });
    await waitFor(() => expect(getExpensesAction).toHaveBeenCalledTimes(2));

    await act(async () => resolveRent({
      success: true,
      data: [{ id: 'rent-new', date: '2026-09-21', category: 'rent', description: 'Newest rent result', amount: 40, user_name: 'Owner' }],
    }));
    expect(await screen.findByText('Newest rent result')).toBeInTheDocument();

    await act(async () => resolveAll({
      success: true,
      data: [{ id: 'all-old', date: '2026-09-20', category: 'rent', description: 'Stale all-expenses result', amount: 10, user_name: 'Owner' }],
    }));

    await waitFor(() => expect(screen.getByText('Newest rent result')).toBeInTheDocument());
    expect(screen.queryByText('Stale all-expenses result')).not.toBeInTheDocument();
  });
});
