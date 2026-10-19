import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ExpensesClient from '@/components/expenses/ExpensesClient';
import { addExpenseAction, getExpensesAction, getExpenseSummaryAction } from '@/app/actions-client/expenses';
import { getExpenseDefinitionsAction } from '@/app/actions-client/finance';
import { toast } from 'react-hot-toast';

jest.mock('@/app/actions-client/expenses', () => ({
  addExpenseAction: jest.fn(), getExpensesAction: jest.fn(), getExpenseSummaryAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({ getExpenseDefinitionsAction: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));

const categories = [
  { code: 'RENT', name_ar: 'إيجار' }, { code: 'UTILITIES', name_ar: 'مرافق' },
];
const summary = { totalRevenue: 1000, totalExpenses: 110, totalReturns: 50,
  totalCOGS: 300, netProfit: 540, byCategory: [
    { category: 'RENT', total: 80 }, { category: 'UTILITIES', total: 30 },
  ] };
const rent = { id: 17, category: 'RENT', date: '2026-10-15', amount: 80,
  description: 'BG rent identity', user_name: 'Synthetic cashier' };
const utility = { id: 18, category: 'UTILITIES', date: '2026-10-14', amount: 30,
  description: 'BG electricity identity', user_name: 'Synthetic owner' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  (getExpenseDefinitionsAction as jest.Mock).mockResolvedValue({ success: true, data: categories });
  (getExpensesAction as jest.Mock).mockResolvedValue({ success: true, data: [rent, utility] });
  (getExpenseSummaryAction as jest.Mock).mockResolvedValue({ success: true, data: summary });
  (addExpenseAction as jest.Mock).mockResolvedValue({ success: true });
});

describe('QA background expenses: real category, financial report and writer controls', () => {
  it('keeps a viewer read-only while changing named source category filters and showing cash/COGS totals', async () => {
    render(<ExpensesClient canManage={false} />);
    expect(await screen.findByText('BG rent identity')).toBeInTheDocument();
    expect(screen.getByText('BG electricity identity')).toBeInTheDocument();
    expect(screen.getByText('تكلفة المبيعات (COGS)')).toBeInTheDocument();
    expect(screen.getByText('توزيع المصروفات حسب الفئة')).toBeInTheDocument();
    expect(screen.getByText('540', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'إضافة مصروف' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'تصفية المصروفات حسب الفئة' }), {
      target: { value: 'UTILITIES' },
    });
    await waitFor(() => expect(getExpensesAction).toHaveBeenLastCalledWith({
      category: 'UTILITIES',
    }));
    expect(addExpenseAction).not.toHaveBeenCalled();
  });

  it('rejects zero and negative expense, prevents two pending submissions, and retries one exact rejected financial intent', async () => {
    const pending = deferred<{ success: boolean; error?: string }>();
    (addExpenseAction as jest.Mock)
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ success: true });
    render(<ExpensesClient canManage />);
    await screen.findByText('BG rent identity');
    fireEvent.click(screen.getByRole('button', { name: 'إضافة مصروف' }));
    const form = screen.getByRole('heading', { name: 'إضافة مصروف جديد' }).closest('form') as HTMLFormElement;
    expect(form).not.toBeNull();
    fireEvent.change(within(form).getByRole('combobox', { name: 'الفئة' }), { target: { value: 'UTILITIES' } });
    fireEvent.change(within(form).getByLabelText('الوصف'), { target: { value: 'QA-only electricity' } });
    fireEvent.change(within(form).getByLabelText('التاريخ'), { target: { value: '2026-10-15' } });
    const amount = within(form).getByLabelText('المبلغ (ج.م)');
    fireEvent.change(amount, { target: { value: '0' } });
    fireEvent.submit(form);
    fireEvent.change(amount, { target: { value: '-10' } });
    fireEvent.submit(form);
    expect(addExpenseAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('يرجى إدخال مبلغ صحيح');

    fireEvent.change(amount, { target: { value: '30.25' } });
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(addExpenseAction).toHaveBeenCalledTimes(1);
    const expected = { category: 'UTILITIES', amount: 30.25,
      description: 'QA-only electricity', date: '2026-10-15', request_id: expect.any(String) };
    expect(addExpenseAction).toHaveBeenCalledWith(expected);
    expect(within(form).getByRole('button', { name: 'جاري الحفظ...' })).toBeDisabled();
    await act(async () => { pending.resolve({ success: false, error: 'Native tenant owner denied' }); await pending.promise; });
    expect(toast.error).toHaveBeenCalledWith('Native tenant owner denied');
    expect(screen.getByDisplayValue('QA-only electricity')).toBeInTheDocument();
    fireEvent.submit(form);
    await waitFor(() => expect(addExpenseAction).toHaveBeenCalledTimes(2));
    expect((addExpenseAction as jest.Mock).mock.calls).toEqual([[expected], [expected]]);
    const [first, retry] = (addExpenseAction as jest.Mock).mock.calls.map(([payload])=>payload);
    expect(first.request_id).toBe(retry.request_id);
    expect(first.request_id.length).toBeGreaterThan(8);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'إضافة مصروف جديد' })).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith('تم إضافة المصروف بنجاح');
  });

  it('shows a retryable genuine load denial instead of a false empty record list', async () => {
    (getExpensesAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Read ownership denied' })
      .mockResolvedValueOnce({ success: true, data: [rent] });
    render(<ExpensesClient canManage={false} />);
    expect(await screen.findByText('تعذر تحميل بيانات المصروفات')).toBeInTheDocument();
    expect(screen.queryByText('لا توجد مصروفات مسجلة')).not.toBeInTheDocument();
    expect(screen.queryByText('BG rent identity')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(await screen.findByText('BG rent identity')).toBeInTheDocument();
    expect(getExpensesAction).toHaveBeenCalledTimes(2);
    expect(getExpenseSummaryAction).toHaveBeenCalledTimes(1);
  });

  it('ignores stale older expense rows after a newer category filter request completed', async () => {
    const oldRead = deferred<{ success: boolean; data: typeof rent[] }>();
    (getExpensesAction as jest.Mock)
      .mockImplementationOnce(() => oldRead.promise)
      .mockResolvedValueOnce({ success: true, data: [utility] });
    render(<ExpensesClient canManage={false} />);
    await screen.findByRole('combobox', { name: 'تصفية المصروفات حسب الفئة' });
    fireEvent.change(screen.getByRole('combobox', { name: 'تصفية المصروفات حسب الفئة' }), {
      target: { value: 'UTILITIES' },
    });
    expect(await screen.findByText('BG electricity identity')).toBeInTheDocument();
    await act(async () => { oldRead.resolve({ success: true, data: [rent] }); await oldRead.promise; });
    expect(screen.queryByText('BG rent identity')).not.toBeInTheDocument();
    expect(screen.getByText('BG electricity identity')).toBeInTheDocument();
  });

  it('uses a new nonce for a changed expense amount after an unsuccessful original intent', async () => {
    (addExpenseAction as jest.Mock).mockResolvedValueOnce({success:false,error:'posting denied'})
      .mockResolvedValueOnce({success:true});
    render(<ExpensesClient canManage />);
    await screen.findByText('BG rent identity');
    fireEvent.click(screen.getByRole('button',{name:'إضافة مصروف'}));
    const form=screen.getByRole('heading',{name:'إضافة مصروف جديد'}).closest('form') as HTMLFormElement;
    const amount=within(form).getByLabelText('المبلغ (ج.م)');
    fireEvent.change(amount,{target:{value:'10.25'}});
    fireEvent.submit(form);
    await waitFor(()=>expect(toast.error).toHaveBeenCalledWith('posting denied'));
    fireEvent.change(amount,{target:{value:'20.50'}});
    fireEvent.submit(form);
    await waitFor(()=>expect(addExpenseAction).toHaveBeenCalledTimes(2));
    const [original,changed]=(addExpenseAction as jest.Mock).mock.calls.map(([payload])=>payload);
    expect(original).toEqual(expect.objectContaining({amount:10.25,request_id:expect.any(String)}));
    expect(changed).toEqual(expect.objectContaining({amount:20.50,request_id:expect.any(String)}));
    expect(changed.request_id).not.toBe(original.request_id);
  });

  it('does not silently change expense category or original request ID when definitions arrive after a refused writer', async () => {
    const pendingDefinitions = deferred<{ success: boolean; data: typeof categories }>();
    (getExpenseDefinitionsAction as jest.Mock).mockImplementationOnce(() => pendingDefinitions.promise);
    (addExpenseAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'Response missing after native financial attempt' })
      .mockResolvedValueOnce({ success: true });
    render(<ExpensesClient canManage />);
    await screen.findByText('BG rent identity');
    fireEvent.click(screen.getByRole('button', { name: 'إضافة مصروف' }));
    const form = screen.getByRole('heading', { name: 'إضافة مصروف جديد' }).closest('form') as HTMLFormElement;
    const category = within(form).getByRole('combobox', { name: 'الفئة' });
    fireEvent.change(category, { target: { value: 'RENT' } });
    fireEvent.change(within(form).getByLabelText('المبلغ (ج.م)'), { target: { value: '35.20' } });
    fireEvent.change(within(form).getByLabelText('الوصف'), { target: { value: 'Original rent intent' } });
    fireEvent.submit(form);
    await waitFor(() => expect(addExpenseAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Response missing after native financial attempt'));
    await act(async () => {
      pendingDefinitions.resolve({ success: true, data: [{ code: 'UTILITIES', name_ar: 'مرافق' }, { code: 'RENT', name_ar: 'إيجار' }] });
      await pendingDefinitions.promise;
    });
    expect(category).toHaveValue('RENT');
    expect(within(form).getByLabelText('المبلغ (ج.م)')).toHaveValue(35.20);
    fireEvent.submit(form);
    await waitFor(() => expect(addExpenseAction).toHaveBeenCalledTimes(2));
    const [first, retry] = (addExpenseAction as jest.Mock).mock.calls.map(([data]) => data);
    expect(first.category).toBe('RENT');
    expect(first).toEqual(retry);
  });

  it('reuses original nonce when an in-flight expense is edited and restored to the same exact financial intent', async () => {
    const pending = deferred<{ success: boolean; error: string }>();
    (addExpenseAction as jest.Mock)
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce({ success: true });
    render(<ExpensesClient canManage />);
    await screen.findByText('BG rent identity');
    fireEvent.click(screen.getByRole('button', { name: 'إضافة مصروف' }));
    const form = screen.getByRole('heading', { name: 'إضافة مصروف جديد' }).closest('form') as HTMLFormElement;
    const amount = within(form).getByLabelText('المبلغ (ج.م)');
    fireEvent.change(amount, { target: { value: '10.25' } });
    fireEvent.submit(form);
    await waitFor(() => expect(addExpenseAction).toHaveBeenCalledTimes(1));
    fireEvent.change(amount, { target: { value: '11.25' } });
    fireEvent.change(amount, { target: { value: '10.25' } });
    await act(async () => {
      pending.resolve({ success: false, error: 'Native response lost' });
      await pending.promise;
    });
    fireEvent.submit(form);
    await waitFor(() => expect(addExpenseAction).toHaveBeenCalledTimes(2));
    const [first, retry] = (addExpenseAction as jest.Mock).mock.calls.map(([data]) => data);
    expect(first.amount).toBe(10.25);
    expect(first).toEqual(retry);
  });

});
