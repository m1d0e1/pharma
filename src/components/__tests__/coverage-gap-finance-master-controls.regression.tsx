import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import * as finance from '@/app/actions-client/finance';
import { getClientSession } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(),
}));
jest.mock('@/components/finance/FinancialComponents', () => ({
  FinancialNoticeForm: () => <div>financial-notice-form</div>,
}));
jest.mock('@/components/finance/TrialBalanceSettingsClient', () => function MockTrialBalanceSettingsClient() {
  return <div>trial-settings</div>;
});
jest.mock('@/components/reports/TrialBalanceReport', () => function MockTrialBalanceReport() {
  return <div>trial-report</div>;
});
jest.mock('@/components/finance/CashTransactionsClient', () => function MockCashTransactionsClient() {
  return <div>cash-transactions</div>;
});
jest.mock('@/app/actions-client/expenses', () => ({
  getExpensesAction: jest.fn().mockResolvedValue({ success: true, data: [] }),
  addExpenseAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({
  createCashMovementAction: jest.fn(),
  getCashMovementsAction: jest.fn(),
  getPointsOfSaleAction: jest.fn(),
  addPointOfSaleAction: jest.fn(),
  updatePointOfSaleAction: jest.fn(),
  deletePointOfSaleAction: jest.fn(),
  getExpenseDefinitionsAction: jest.fn(),
  addExpenseDefinitionAction: jest.fn(),
  updateExpenseDefinitionAction: jest.fn(),
  deleteExpenseDefinitionAction: jest.fn(),
  getBanksAction: jest.fn(),
  addBankAction: jest.fn(),
  updateBankAction: jest.fn(),
  deleteBankAction: jest.fn(),
  getPapersAction: jest.fn(),
  addPaperAction: jest.fn(),
  updatePaperStatusAction: jest.fn(),
  deletePaperAction: jest.fn(),
  getCardsAction: jest.fn(),
  addCardAction: jest.fn(),
  updateCardAction: jest.fn(),
  deleteCardAction: jest.fn(),
  getAccountsAction: jest.fn(),
  getJournalsAction: jest.fn(),
  createManualJournalAction: jest.fn(),
  addAccountAction: jest.fn(),
  updateAccountAction: jest.fn(),
  deleteAccountAction: jest.fn(),
  getJournalDetailsAction: jest.fn(),
  getFinancialNoticesAction: jest.fn(),
  getActivityLogsAction: jest.fn(),
  getTreasuryDashboardAction: jest.fn(),
}));
jest.mock('react-hot-toast', () => ({
  toast: {
    error: jest.fn(),
    success: jest.fn(),
  },
}));

const emptyResult = { success: true, data: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('coverage gap: finance master-data controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getClientSession as jest.Mock).mockResolvedValue({ id: 'owner-1', role: 'owner' });
    Object.defineProperty(window, 'print', { configurable: true, value: jest.fn() });
    window.confirm = jest.fn(() => true);

    for (const action of [
      finance.getCashMovementsAction,
      finance.getPointsOfSaleAction,
      finance.getExpenseDefinitionsAction,
      finance.getBanksAction,
      finance.getPapersAction,
      finance.getCardsAction,
      finance.getAccountsAction,
      finance.getJournalsAction,
      finance.getFinancialNoticesAction,
      finance.getActivityLogsAction,
    ]) {
      (action as jest.Mock).mockResolvedValue(emptyResult);
    }
    (finance.getTreasuryDashboardAction as jest.Mock).mockResolvedValue({
      success: true,
      data: {
        treasuryBalance: 0,
        todayReceipts: 0,
        todayExpenses: 0,
        totalShiftHandovers: 0,
        counts: { treasury: 0, receipts: 0, expenses: 0, handovers: 0 },
        details: [],
      },
    });
  });

  it.each([
    ['banks', /إضافة حساب بنكي/, 'إضافة حساب بنكي جديد'],
    ['cards', /إضافة ماكينة \/ كارت/, 'إضافة ماكينة تحصيل / كارت'],
    ['pos_management', /إضافة نقطة بيع/, 'إضافة نقطة بيع جديدة'],
    ['papers', /تسجيل شيك صادر/, 'تسجيل شيك صادر (مدفوع)'],
  ] as const)('opens the real %s add modal from the visible control', async (initialTab, buttonName, heading) => {
    render(<AccountsManagementClient initialTab={initialTab} />);

    fireEvent.click(await screen.findByRole('button', { name: buttonName }));

    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it('keeps a bank modal open and reports a returned create failure', async () => {
    (finance.addBankAction as jest.Mock).mockResolvedValue({ success: false, error: 'bank rejected' });
    render(<AccountsManagementClient initialTab="banks" />);

    fireEvent.click(await screen.findByRole('button', { name: /إضافة حساب بنكي/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: البنك الأهلي المصري'), {
      target: { value: 'بنك تجريبي' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة الحساب' }));

    await waitFor(() => expect(finance.addBankAction).toHaveBeenCalledWith({
      name_ar: 'بنك تجريبي',
      name_en: undefined,
      account_number: undefined,
      branch: undefined,
      current_balance: 0,
    }));
    expect(toast.error).toHaveBeenCalledWith('bank rejected');
    expect(screen.getByRole('heading', { name: 'إضافة حساب بنكي جديد' })).toBeInTheDocument();
  });

  it('shows a retryable bank-load error instead of a successful empty state', async () => {
    (finance.getBanksAction as jest.Mock)
      .mockResolvedValueOnce({ success: false, error: 'bank load failed' })
      .mockResolvedValue({
        success: true,
        data: [{ id: 9, name_ar: 'بنك الاسترداد', current_balance: 50 }],
      });

    render(<AccountsManagementClient initialTab="banks" />);

    expect(await screen.findByText('تعذر تحميل بيانات الحسابات البنكية')).toBeInTheDocument();
    expect(screen.queryByText(/لا توجد حسابات بنكية مسجلة/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('بنك الاسترداد')).toBeInTheDocument();
    await waitFor(() => expect(finance.getBanksAction).toHaveBeenCalledTimes(2));
  });

  it('edits a loaded bank without allowing its live balance to be overwritten', async () => {
    (finance.getBanksAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 4,
        name_ar: 'بنك قديم',
        name_en: 'Old Bank',
        account_number: 'ACC-1',
        branch: 'فرع قديم',
        current_balance: 1250,
      }],
    });
    (finance.updateBankAction as jest.Mock).mockResolvedValue({ success: false, error: 'bank edit rejected' });

    render(<AccountsManagementClient initialTab="banks" />);
    fireEvent.click(await screen.findByTitle('تعديل الحساب'));

    expect(await screen.findByRole('heading', { name: 'تعديل الحساب البنكي' })).toBeInTheDocument();
    const name = screen.getByPlaceholderText('مثال: البنك الأهلي المصري');
    fireEvent.change(name, { target: { value: 'بنك معدل' } });
    expect(screen.getByDisplayValue('1250')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التعديلات' }));

    await waitFor(() => expect(finance.updateBankAction).toHaveBeenCalledWith(4, {
      name_ar: 'بنك معدل',
      name_en: 'Old Bank',
      account_number: 'ACC-1',
      branch: 'فرع قديم',
    }));
    expect(toast.error).toHaveBeenCalledWith('bank edit rejected');
    expect(screen.getByRole('heading', { name: 'تعديل الحساب البنكي' })).toBeInTheDocument();
  });

  it('honors bank-delete cancellation and preserves the bank when deletion is rejected', async () => {
    (finance.getBanksAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 7, name_ar: 'بنك للحذف', current_balance: 10 }],
    });
    (finance.deleteBankAction as jest.Mock).mockResolvedValue({ success: false, error: 'bank in use' });
    (window.confirm as jest.Mock).mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<AccountsManagementClient initialTab="banks" />);
    const deleteButton = await screen.findByTitle('حذف الحساب');
    fireEvent.click(deleteButton);
    expect(finance.deleteBankAction).not.toHaveBeenCalled();

    fireEvent.click(deleteButton);
    await waitFor(() => expect(finance.deleteBankAction).toHaveBeenCalledWith(7));
    expect(toast.error).toHaveBeenCalledWith('bank in use');
    expect(screen.getByText('بنك للحذف')).toBeInTheDocument();
  });

  it('edits a card with its bank association and preserves the modal on update failure', async () => {
    (finance.getBanksAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 3, name_ar: 'بنك مرتبط', account_number: 'B-3' }],
    });
    (finance.getCardsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 11,
        name_ar: 'ماكينة قديمة',
        name_en: 'Old Terminal',
        bank_id: 3,
        commission_pct: 1.25,
        current_balance: 900,
      }],
    });
    (finance.updateCardAction as jest.Mock).mockResolvedValue({ success: false, error: 'card edit rejected' });

    render(<AccountsManagementClient initialTab="cards" />);
    fireEvent.click(await screen.findByTitle('تعديل الماكينة'));

    expect(await screen.findByRole('heading', { name: 'تعديل ماكينة التحصيل / البطاقة' })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('3');
    fireEvent.change(screen.getByPlaceholderText('مثال: فوري - كاشير 1'), { target: { value: 'ماكينة معدلة' } });
    fireEvent.change(screen.getByPlaceholderText('مثال: 1.5'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التعديلات' }));

    await waitFor(() => expect(finance.updateCardAction).toHaveBeenCalledWith(11, {
      name_ar: 'ماكينة معدلة',
      name_en: 'Old Terminal',
      bank_id: 3,
      commission_pct: 2.5,
    }));
    expect(toast.error).toHaveBeenCalledWith('card edit rejected');
    expect(screen.getByRole('heading', { name: 'تعديل ماكينة التحصيل / البطاقة' })).toBeInTheDocument();
  });

  it('opens POS edit state and preserves the row when delete is cancelled or rejected', async () => {
    (finance.getPointsOfSaleAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 13,
        name_ar: 'كاشير رئيسي',
        name_en: 'Main POS',
        current_balance: 75,
        location: 'الصالة',
        computer_name: 'PC-13',
      }],
    });
    (finance.deletePointOfSaleAction as jest.Mock).mockResolvedValue({ success: false, error: 'pos in use' });
    (window.confirm as jest.Mock).mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<AccountsManagementClient initialTab="pos_management" />);
    fireEvent.click(await screen.findByTitle('تعديل نقطة البيع'));
    expect(await screen.findByRole('heading', { name: 'تعديل نقطة البيع (POS)' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('كاشير رئيسي')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));

    const deleteButton = screen.getByTitle('حذف نقطة البيع');
    fireEvent.click(deleteButton);
    expect(finance.deletePointOfSaleAction).not.toHaveBeenCalled();
    fireEvent.click(deleteButton);
    await waitFor(() => expect(finance.deletePointOfSaleAction).toHaveBeenCalledWith(13));
    expect(toast.error).toHaveBeenCalledWith('pos in use');
    expect(screen.getByText('كاشير رئيسي')).toBeInTheDocument();
  });

  it('filters papers and preserves pending status when a confirmed status update is rejected', async () => {
    (finance.getPapersAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        {
          id: 21,
          paper_number: 'CHK-100',
          type: 'check',
          direction: 'in',
          target_name: 'عميل أ',
          due_date: '2026-10-01',
          amount: 450,
          status: 'pending',
        },
        {
          id: 22,
          paper_number: 'CHK-200',
          type: 'check',
          direction: 'out',
          target_name: 'مورد ب',
          due_date: '2026-10-02',
          amount: 900,
          status: 'pending',
        },
      ],
    });
    (finance.updatePaperStatusAction as jest.Mock).mockResolvedValue({ success: false, error: 'status rejected' });

    render(<AccountsManagementClient initialTab="papers" />);
    expect(await screen.findByText('CHK-100')).toBeInTheDocument();
    const search = screen.getByPlaceholderText('بحث برقم الشيك، اسم الساحب/الجهة، البيان، أو المبلغ...');
    fireEvent.change(search, { target: { value: 'CHK-100' } });
    expect(screen.queryByText('CHK-200')).not.toBeInTheDocument();

    (window.confirm as jest.Mock).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'تحصيل' }));
    expect(finance.updatePaperStatusAction).not.toHaveBeenCalled();

    (window.confirm as jest.Mock).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'تحصيل' }));
    await waitFor(() => expect(finance.updatePaperStatusAction).toHaveBeenCalledWith(21, 'cashed'));
    expect(toast.error).toHaveBeenCalledWith('status rejected');
    expect(screen.getByText('قيد الانتظار')).toBeInTheDocument();
  });

  it('recovers a bank create modal from a thrown action error', async () => {
    (finance.addBankAction as jest.Mock).mockRejectedValueOnce(new Error('bank transport failed'));
    render(<AccountsManagementClient initialTab="banks" />);

    fireEvent.click(await screen.findByRole('button', { name: /إضافة حساب بنكي/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: البنك الأهلي المصري'), {
      target: { value: 'بنك استثناء' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة الحساب' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'إضافة الحساب' })).toBeEnabled());
    expect(toast.error).toHaveBeenCalledWith('حدث خطأ أثناء حفظ الحساب البنكي');
    expect(screen.getByRole('heading', { name: 'إضافة حساب بنكي جديد' })).toBeInTheDocument();
  });

  it('surfaces a thrown bank-delete error without losing the visible row', async () => {
    (finance.getBanksAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 17, name_ar: 'بنك استثناء حذف', current_balance: 30 }],
    });
    (finance.deleteBankAction as jest.Mock).mockRejectedValueOnce(new Error('delete transport failed'));

    render(<AccountsManagementClient initialTab="banks" />);
    fireEvent.click(await screen.findByTitle('حذف الحساب'));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل حذف الحساب البنكي'));
    expect(screen.getByText('بنك استثناء حذف')).toBeInTheDocument();
  });

  it.each([
    ['banks', /إضافة حساب بنكي/, 'مثال: البنك الأهلي المصري', 'إضافة الحساب', finance.addBankAction],
    ['cards', /إضافة ماكينة \/ كارت/, 'مثال: فوري - كاشير 1', 'إضافة الماكينة', finance.addCardAction],
    ['pos_management', /إضافة نقطة بيع/, 'مثال: كاشير 1 - الصالة', 'إضافة النقطة', finance.addPointOfSaleAction],
  ] as const)('blocks same-tick duplicate %s form submissions while persistence is pending', async (tab, openName, placeholder, submitName, action) => {
    const pending = deferred<any>();
    (action as jest.Mock).mockReturnValue(pending.promise);
    render(<AccountsManagementClient initialTab={tab} />);

    fireEvent.click(await screen.findByRole('button', { name: openName }));
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: 'اسم تجريبي' } });
    const submitButton = screen.getByRole('button', { name: submitName });
    const form = submitButton.closest('form');
    expect(form).not.toBeNull();

    act(() => {
      fireEvent.submit(form!);
      fireEvent.submit(form!);
    });

    expect(action).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it.each([
    ['banks', /إضافة حساب بنكي/, 'مثال: البنك الأهلي المصري', 'إضافة الحساب', 'إضافة حساب بنكي جديد', finance.addBankAction],
    ['cards', /إضافة ماكينة \/ كارت/, 'مثال: فوري - كاشير 1', 'إضافة الماكينة', 'إضافة ماكينة تحصيل / كارت', finance.addCardAction],
    ['pos_management', /إضافة نقطة بيع/, 'مثال: كاشير 1 - الصالة', 'إضافة النقطة', 'إضافة نقطة بيع جديدة', finance.addPointOfSaleAction],
  ] as const)('keeps the %s modal open when cancel is clicked while persistence is pending', async (tab, openName, placeholder, submitName, heading, action) => {
    const pending = deferred<any>();
    (action as jest.Mock).mockReturnValue(pending.promise);
    render(<AccountsManagementClient initialTab={tab} />);

    fireEvent.click(await screen.findByRole('button', { name: openName }));
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: 'اسم معلّق' } });
    fireEvent.click(screen.getByRole('button', { name: submitName }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('blocks same-tick duplicate commercial-paper submissions while persistence is pending', async () => {
    const pending = deferred<any>();
    (finance.addPaperAction as jest.Mock).mockReturnValue(pending.promise);
    render(<AccountsManagementClient initialTab="papers" />);

    fireEvent.click(await screen.findByRole('button', { name: /تسجيل شيك صادر/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: 987456'), { target: { value: 'CHK-DUP' } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } });
    fireEvent.change(screen.getByPlaceholderText('الجهة أو الشخص'), { target: { value: 'مورد تجريبي' } });
    const submitButton = screen.getByRole('button', { name: 'تسجيل الورقة المالية' });
    const form = submitButton.closest('form');
    expect(form).not.toBeNull();

    act(() => {
      fireEvent.submit(form!);
      fireEvent.submit(form!);
    });

    expect(finance.addPaperAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('blocks same-tick duplicate bank deletion while the first deletion is pending', async () => {
    const pending = deferred<any>();
    (finance.getBanksAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 31, name_ar: 'بنك مزدوج', current_balance: 0 }],
    });
    (finance.deleteBankAction as jest.Mock).mockReturnValue(pending.promise);
    render(<AccountsManagementClient initialTab="banks" />);

    const deleteButton = await screen.findByTitle('حذف الحساب');
    act(() => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(finance.deleteBankAction).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('blocks same-tick duplicate paper-status transitions while the first transition is pending', async () => {
    const pending = deferred<any>();
    (finance.getPapersAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 41,
        paper_number: 'CHK-LOCK',
        type: 'check',
        direction: 'in',
        target_name: 'عميل',
        due_date: '2026-10-01',
        amount: 100,
        status: 'pending',
      }],
    });
    (finance.updatePaperStatusAction as jest.Mock).mockReturnValue(pending.promise);
    render(<AccountsManagementClient initialTab="papers" />);

    const statusButton = await screen.findByRole('button', { name: 'تحصيل' });
    act(() => {
      statusButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      statusButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(finance.updatePaperStatusAction).toHaveBeenCalledTimes(1);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('blocks same-tick duplicate account creation while persistence is pending', async () => {
    const pending = deferred<any>();
    (finance.addAccountAction as jest.Mock).mockReturnValue(pending.promise);
    render(<AccountsManagementClient initialTab="chart_of_accounts" />);

    fireEvent.click(await screen.findByRole('button', { name: /إضافة حساب رئيسي/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: 51101'), { target: { value: '5.9.1' } });
    const textboxes = screen.getAllByRole('textbox');
    fireEvent.change(textboxes[1], { target: { value: 'حساب تجريبي' } });
    const saveButton = screen.getByRole('button', { name: 'إضافة الحساب' });

    act(() => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(finance.addAccountAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('keeps account creation open when cancel is clicked while persistence is pending', async () => {
    const pending = deferred<any>();
    (finance.addAccountAction as jest.Mock).mockReturnValue(pending.promise);
    render(<AccountsManagementClient initialTab="chart_of_accounts" />);

    fireEvent.click(await screen.findByRole('button', { name: /إضافة حساب رئيسي/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: 51101'), { target: { value: '5.9.3' } });
    const textboxes = screen.getAllByRole('textbox');
    fireEvent.change(textboxes[1], { target: { value: 'حساب معلّق' } });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة الحساب' }));
    await waitFor(() => expect(finance.addAccountAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByText('إضافة حساب فرعي جديد')).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('keeps account editing open when cancel is clicked while persistence is pending', async () => {
    const pending = deferred<any>();
    (finance.getAccountsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{
        id: 77,
        code: '5.1',
        name_ar: 'حساب قديم',
        name_en: 'Old Account',
        type: 'expense',
        is_group: 0,
        balance: 0,
      }],
    });
    (finance.updateAccountAction as jest.Mock).mockReturnValue(pending.promise);
    render(<AccountsManagementClient initialTab="chart_of_accounts" />);

    fireEvent.click(await screen.findByTitle('تعديل الحساب'));
    expect(await screen.findByText('تعديل بيانات الحساب')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ التعديلات' }));
    await waitFor(() => expect(finance.updateAccountAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByText('تعديل بيانات الحساب')).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('blocks same-tick duplicate expense-definition creation while persistence is pending', async () => {
    const pending = deferred<any>();
    (finance.addExpenseDefinitionAction as jest.Mock).mockReturnValue(pending.promise);
    render(<AccountsManagementClient initialTab="expense_definitions" />);

    fireEvent.click(await screen.findByRole('button', { name: /إضافة نوع مصروف/ }));
    fireEvent.change(screen.getByPlaceholderText(/مثال: 501/), { target: { value: '590' } });
    fireEvent.change(screen.getByPlaceholderText(/مثال: كهرباء/), { target: { value: 'مصروف تجريبي' } });
    const saveButton = screen.getByRole('button', { name: 'إضافة المصروف' });
    act(() => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(finance.addExpenseDefinitionAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('keeps expense-definition creation open when cancel is clicked while persistence is pending', async () => {
    const pending = deferred<any>();
    (finance.addExpenseDefinitionAction as jest.Mock).mockReturnValue(pending.promise);
    render(<AccountsManagementClient initialTab="expense_definitions" />);

    fireEvent.click(await screen.findByRole('button', { name: /إضافة نوع مصروف/ }));
    fireEvent.change(screen.getByPlaceholderText(/مثال: 501/), { target: { value: '592' } });
    fireEvent.change(screen.getByPlaceholderText(/مثال: كهرباء/), { target: { value: 'مصروف معلّق' } });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة المصروف' }));
    await waitFor(() => expect(finance.addExpenseDefinitionAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByDisplayValue('592')).toBeInTheDocument();
    expect(screen.getByDisplayValue('مصروف معلّق')).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('blocks same-tick duplicate operational-expense posting while persistence is pending', async () => {
    const expenses = await import('@/app/actions-client/expenses');
    const pending = deferred<any>();
    (expenses.addExpenseAction as jest.Mock).mockReturnValue(pending.promise);
    (finance.getExpenseDefinitionsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 1, code: 'rent', name_ar: 'إيجار' }],
    });
    render(<AccountsManagementClient initialTab="expenses" />);

    fireEvent.click(await screen.findByRole('button', { name: /إضافة مصروف \(F4\)/ }));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '75' } });
    const saveButton = screen.getByRole('button', { name: 'حفظ المصروف' });
    const form = saveButton.closest('form');
    expect(form).not.toBeNull();

    act(() => {
      fireEvent.submit(form!);
      fireEvent.submit(form!);
    });

    expect(expenses.addExpenseAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('keeps operational-expense posting open when cancel is clicked while persistence is pending', async () => {
    const expenses = await import('@/app/actions-client/expenses');
    const pending = deferred<any>();
    (expenses.addExpenseAction as jest.Mock).mockReturnValue(pending.promise);
    (finance.getExpenseDefinitionsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 1, code: 'rent', name_ar: 'إيجار' }],
    });
    render(<AccountsManagementClient initialTab="expenses" />);

    fireEvent.click(await screen.findByRole('button', { name: /إضافة مصروف \(F4\)/ }));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '85' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));
    await waitFor(() => expect(expenses.addExpenseAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByText('إضافة مصروف تشغيلي جديد')).toBeInTheDocument();
    expect(screen.getByDisplayValue('85')).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('keeps commercial-paper creation open when cancel is clicked while persistence is pending', async () => {
    const pending = deferred<any>();
    (finance.addPaperAction as jest.Mock).mockReturnValue(pending.promise);
    render(<AccountsManagementClient initialTab="papers" />);

    fireEvent.click(await screen.findByRole('button', { name: /تسجيل شيك صادر/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: 987456'), { target: { value: 'CHK-PENDING' } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '500' } });
    fireEvent.change(screen.getByPlaceholderText('الجهة أو الشخص'), { target: { value: 'مورد معلّق' } });
    fireEvent.click(screen.getByRole('button', { name: 'تسجيل الورقة المالية' }));
    await waitFor(() => expect(finance.addPaperAction).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.getByRole('heading', { name: 'تسجيل شيك صادر (مدفوع)' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('CHK-PENDING')).toBeInTheDocument();

    await act(async () => {
      pending.resolve({ success: false, error: 'rejected' });
      await pending.promise;
    });
  });

  it('recovers account creation from a thrown action and restores the save control', async () => {
    (finance.addAccountAction as jest.Mock).mockRejectedValueOnce(new Error('account transport failed'));
    render(<AccountsManagementClient initialTab="chart_of_accounts" />);

    fireEvent.click(await screen.findByRole('button', { name: /إضافة حساب رئيسي/ }));
    fireEvent.change(screen.getByPlaceholderText('مثال: 51101'), { target: { value: '5.9.2' } });
    const textboxes = screen.getAllByRole('textbox');
    fireEvent.change(textboxes[1], { target: { value: 'حساب استثناء' } });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة الحساب' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'إضافة الحساب' })).toBeEnabled());
    expect(toast.error).toHaveBeenCalledWith('فشل إضافة الحساب');
    expect(screen.getByText('إضافة حساب فرعي جديد')).toBeInTheDocument();
  });

  it('recovers expense-definition creation from a thrown action and preserves the form', async () => {
    (finance.addExpenseDefinitionAction as jest.Mock).mockRejectedValueOnce(new Error('definition transport failed'));
    render(<AccountsManagementClient initialTab="expense_definitions" />);

    fireEvent.click(await screen.findByRole('button', { name: /إضافة نوع مصروف/ }));
    fireEvent.change(screen.getByPlaceholderText(/مثال: 501/), { target: { value: '591' } });
    fireEvent.change(screen.getByPlaceholderText(/مثال: كهرباء/), { target: { value: 'مصروف استثناء' } });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة المصروف' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'إضافة المصروف' })).toBeEnabled());
    expect(toast.error).toHaveBeenCalledWith('فشل حفظ البيانات');
    expect(screen.getByDisplayValue('591')).toBeInTheDocument();
    expect(screen.getByDisplayValue('مصروف استثناء')).toBeInTheDocument();
  });

  it('recovers operational-expense posting from a thrown action and preserves the entered amount', async () => {
    const expenses = await import('@/app/actions-client/expenses');
    (expenses.addExpenseAction as jest.Mock).mockRejectedValueOnce(new Error('expense transport failed'));
    (finance.getExpenseDefinitionsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 1, code: 'rent', name_ar: 'إيجار' }],
    });
    render(<AccountsManagementClient initialTab="expenses" />);

    fireEvent.click(await screen.findByRole('button', { name: /إضافة مصروف \(F4\)/ }));
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '125' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ المصروف' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'حفظ المصروف' })).toBeEnabled());
    expect(toast.error).toHaveBeenCalledWith('فشل تسجيل المصروف');
    expect(screen.getByDisplayValue('125')).toBeInTheDocument();
  });

  it('renders a retryable journal-detail failure instead of leaving the detail spinner stuck', async () => {
    (finance.getJournalsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [{ id: 'journal-error-001', date: '2026-09-22', description: 'قيد خطأ', total_amount: 100 }],
    });
    (finance.getJournalDetailsAction as jest.Mock)
      .mockRejectedValueOnce(new Error('journal details unavailable'))
      .mockResolvedValueOnce({
        success: true,
        data: [{ account_code: '1.1', account_name: 'الخزينة', debit: 100, credit: 0, description: 'قيد مستعاد', date: '2026-09-22' }],
      });
    render(<AccountsManagementClient initialTab="daily_journals" />);

    fireEvent.click(await screen.findByTitle('عرض تفاصيل القيد'));

    expect(await screen.findByText('تعذر تحميل تفاصيل القيد')).toBeInTheDocument();
    expect(screen.queryByText('جاري تحميل تفاصيل القيد...')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));

    expect(await screen.findByText('قيد مستعاد')).toBeInTheDocument();
    expect(finance.getJournalDetailsAction).toHaveBeenCalledTimes(2);
  });

  it('keeps journal details owned by the newest selected journal when an older request resolves later', async () => {
    const older = deferred<any>();
    const newer = deferred<any>();
    (finance.getJournalsAction as jest.Mock).mockResolvedValue({
      success: true,
      data: [
        { id: 'journal-old-001', date: '2026-09-21', description: 'قيد قديم', total_amount: 100 },
        { id: 'journal-new-002', date: '2026-09-22', description: 'قيد أحدث', total_amount: 200 },
      ],
    });
    (finance.getJournalDetailsAction as jest.Mock).mockImplementation((id: string) => {
      if (id === 'journal-old-001') return older.promise;
      if (id === 'journal-new-002') return newer.promise;
      return Promise.resolve({ success: true, data: [] });
    });
    render(<AccountsManagementClient initialTab="daily_journals" />);

    const detailButtons = await screen.findAllByTitle('عرض تفاصيل القيد');
    fireEvent.click(detailButtons[0]);
    fireEvent.click(detailButtons[1]);
    await waitFor(() => expect(finance.getJournalDetailsAction).toHaveBeenCalledTimes(2));

    await act(async () => {
      newer.resolve({
        success: true,
        data: [{ account_code: '2.1', account_name: 'الحساب الأحدث', debit: 200, credit: 0, description: 'تفاصيل أحدث', date: '2026-09-22' }],
      });
      await newer.promise;
    });
    expect(await screen.findByText('تفاصيل أحدث')).toBeInTheDocument();

    await act(async () => {
      older.resolve({
        success: true,
        data: [{ account_code: '1.1', account_name: 'الحساب القديم', debit: 100, credit: 0, description: 'تفاصيل قديمة', date: '2026-09-21' }],
      });
      await older.promise;
    });

    expect(screen.queryByText('تفاصيل قديمة')).not.toBeInTheDocument();
    expect(screen.getByText('تفاصيل أحدث')).toBeInTheDocument();
  });

});
