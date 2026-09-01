import fs from 'node:fs';
import path from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import * as finance from '@/app/actions-client/finance';
import { getExpensesAction } from '@/app/actions-client/expenses';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn().mockResolvedValue({ role: 'owner' }),
}));
jest.mock('@/components/finance/FinancialComponents', () => ({
  FinancialNoticeForm: () => <div>financial-notice-form</div>,
}));
jest.mock('@/components/finance/TrialBalanceSettingsClient', () => function MockTrialSettings() {
  return <div>trial-settings</div>;
});
jest.mock('@/components/reports/TrialBalanceReport', () => function MockTrialReport() {
  return <div>trial-report</div>;
});
jest.mock('@/components/finance/CashTransactionsClient', () => function MockCashTransactions() {
  return <div>cash-transactions</div>;
});
jest.mock('@/app/actions-client/expenses', () => ({
  getExpensesAction: jest.fn(),
  addExpenseAction: jest.fn(),
  deleteExpenseAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({
  createCashMovementAction: jest.fn(),
  getCashMovementsAction: jest.fn(),
  getPointsOfSaleAction: jest.fn(),
  getExpenseDefinitionsAction: jest.fn(),
  addExpenseDefinitionAction: jest.fn(),
  updateExpenseDefinitionAction: jest.fn(),
  deleteExpenseDefinitionAction: jest.fn(),
  getBanksAction: jest.fn(),
  getPapersAction: jest.fn(),
  getCardsAction: jest.fn(),
  getAccountsAction: jest.fn(),
  getJournalsAction: jest.fn(),
  addAccountAction: jest.fn(),
  updateAccountAction: jest.fn(),
  deleteAccountAction: jest.fn(),
  getJournalDetailsAction: jest.fn(),
  seedFinanceTestDataAction: jest.fn(),
  getFinancialNoticesAction: jest.fn(),
  getActivityLogsAction: jest.fn(),
}));

const emptyResult = { success: true, data: [] };

beforeEach(() => {
  for (const action of [
    finance.getCashMovementsAction,
    finance.getPointsOfSaleAction,
    finance.getExpenseDefinitionsAction,
    finance.addExpenseDefinitionAction,
    finance.updateExpenseDefinitionAction,
    finance.deleteExpenseDefinitionAction,
    finance.getBanksAction,
    finance.getPapersAction,
    finance.getCardsAction,
    finance.getAccountsAction,
    finance.getJournalsAction,
    finance.getFinancialNoticesAction,
    finance.getActivityLogsAction,
    finance.updateAccountAction,
    finance.deleteAccountAction,
    getExpensesAction,
  ]) {
    (action as jest.Mock).mockResolvedValue(emptyResult);
  }
});

it('opens the real POS-management tab from its dedicated route', async () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/app/(dashboard)/finance/pos-management/page.tsx'),
    'utf8',
  );
  expect(source).toContain('initialTab="pos_management"');

  render(<AccountsManagementClient initialTab="pos_management" />);

  expect(await screen.findByRole('heading', { name: 'إدارة نقاط البيع' })).toBeInTheDocument();
  await waitFor(() => expect(finance.getPointsOfSaleAction).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: /إضافة نقطة بيع/ })).toBeEnabled();
});

it('shows the total money recorded by completed shift handovers', async () => {
  (finance.getCashMovementsAction as jest.Mock).mockResolvedValue({
    success: true,
    data: [
      { id: 'handover-1', category: 'handover', type: 'disbursement', amount: 120 },
      { id: 'handover-2', category: 'handover', type: 'disbursement', amount: '30.5' },
      { id: 'expense-1', category: 'expenses', type: 'disbursement', amount: 900 },
    ],
  });

  render(<AccountsManagementClient initialTab="treasury" />);

  const handoverCard = (await screen.findByText('إجمالي تسليمات الورديات')).parentElement;
  await waitFor(() => expect(handoverCard).toHaveTextContent('150.5 ج.م'));
});

it('dynamically searches movements in Treasury tab and provides navigation links', async () => {
  (finance.getCashMovementsAction as jest.Mock).mockResolvedValue({
    success: true,
    data: [
      { id: 'mov-1', type: 'receipt', category: 'patient', notes: 'سداد مريض محمد', amount: 350, date: '2026-09-01' },
      { id: 'mov-2', type: 'disbursement', category: 'salaries', notes: 'مرتب د. سارة', amount: 5000, date: '2026-09-01' },
    ],
  });

  const { fireEvent } = await import('@testing-library/react');
  render(<AccountsManagementClient initialTab="treasury" />);

  expect(await screen.findByText('سجل توريدات وحركات النقدية')).toBeInTheDocument();
  expect(await screen.findByText('سداد مريض محمد')).toBeInTheDocument();
  expect(screen.getByText('مرتب د. سارة')).toBeInTheDocument();

  // Test navigation links
  const shiftsLink = screen.getByRole('link', { name: /الورديات/i });
  expect(shiftsLink).toHaveAttribute('href', '/shifts');

  const handoverLink = screen.getByRole('link', { name: /تسليم الدرج/i });
  expect(handoverLink).toHaveAttribute('href', '/finance/handover');

  // Test search input
  const searchInput = screen.getByPlaceholderText(/بحث في السجل/i);
  fireEvent.change(searchInput, { target: { value: 'سارة' } });

  expect(screen.queryByText('سداد مريض محمد')).not.toBeInTheDocument();
  expect(screen.getByText('مرتب د. سارة')).toBeInTheDocument();
});

it('allows editing and deleting accounts from the Chart of Accounts table and tree', async () => {
  const sampleAccounts = [
    { id: 1, code: '1', name_ar: 'الأصول', name_en: 'Assets', type: 'asset', is_group: 1, parent_id: null, balance: 100 },
    { id: 2, code: '1.1', name_ar: 'الأصول المتداولة', name_en: 'Current Assets', type: 'asset', is_group: 1, parent_id: 1, balance: 100 },
    { id: 3, code: '1.1.1', name_ar: 'الصندوق الفرعي', name_en: 'Sub Cash Drawer', type: 'asset', is_group: 0, parent_id: 2, balance: 100 },
  ];

  (finance.getAccountsAction as jest.Mock).mockResolvedValue({
    success: true,
    data: sampleAccounts,
  });
  (finance.updateAccountAction as jest.Mock).mockResolvedValue({ success: true });
  (finance.deleteAccountAction as jest.Mock).mockResolvedValue({ success: true });

  window.confirm = jest.fn(() => true);

  const { fireEvent } = await import('@testing-library/react');
  render(<AccountsManagementClient initialTab="chart_of_accounts" />);

  // Switch to table mode
  const tableBtn = await screen.findByRole('button', { name: 'جدول' });
  fireEvent.click(tableBtn);

  expect(await screen.findByText(/الصندوق الفرعي/)).toBeInTheDocument();

  // Test Edit
  const editButtons = screen.getAllByTitle('تعديل الحساب');
  expect(editButtons.length).toBeGreaterThan(0);
  fireEvent.click(editButtons[editButtons.length - 1]); // click sub drawer edit

  expect(await screen.findByText('تعديل بيانات الحساب')).toBeInTheDocument();
  const nameInput = screen.getByDisplayValue('الصندوق الفرعي');
  fireEvent.change(nameInput, { target: { value: 'صندوق الكاشير 1' } });

  const saveBtn = screen.getByRole('button', { name: 'حفظ التعديلات' });
  fireEvent.click(saveBtn);

  await waitFor(() => {
    expect(finance.updateAccountAction).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ name_ar: 'صندوق الكاشير 1' })
    );
  });

  // Test Delete
  const deleteButtons = screen.getAllByTitle('حذف الحساب');
  expect(deleteButtons.length).toBeGreaterThan(0);
  fireEvent.click(deleteButtons[deleteButtons.length - 1]);

  expect(window.confirm).toHaveBeenCalled();
  await waitFor(() => {
    expect(finance.deleteAccountAction).toHaveBeenCalledWith(3);
  });
});

it('renders, searches, adds, edits, and deletes expense definitions dynamically with link to expenses', async () => {
  const sampleDefs = [
    { id: 1, code: '501', name_ar: 'كهرباء وإنارة', name_en: 'Electricity', created_at: '2026-06-01' },
    { id: 2, code: '502', name_ar: 'مياه ومرافق', name_en: 'Water', created_at: '2026-06-01' },
    { id: 3, code: '505', name_ar: 'صيانة ونظافة', name_en: 'Maintenance', created_at: '2026-06-01' },
  ];

  (finance.getExpenseDefinitionsAction as jest.Mock).mockResolvedValue({
    success: true,
    data: sampleDefs,
  });
  (finance.addExpenseDefinitionAction as jest.Mock).mockResolvedValue({ success: true, id: 4 });
  (finance.updateExpenseDefinitionAction as jest.Mock).mockResolvedValue({ success: true });
  (finance.deleteExpenseDefinitionAction as jest.Mock).mockResolvedValue({ success: true });

  window.confirm = jest.fn(() => true);

  const { fireEvent } = await import('@testing-library/react');
  render(<AccountsManagementClient initialTab="expense_definitions" />);

  // Verify list rendered
  expect(await screen.findByText('كهرباء وإنارة')).toBeInTheDocument();
  expect(screen.getByText('مياه ومرافق')).toBeInTheDocument();
  expect(screen.getByText('صيانة ونظافة')).toBeInTheDocument();

  // Verify operational link exists
  const expensesLink = screen.getByRole('link', { name: /سجل المصروفات التشغيلية/i });
  expect(expensesLink).toHaveAttribute('href', '/expenses');

  // Verify search
  const searchInput = screen.getByPlaceholderText(/بحث بالكود/i);
  fireEvent.change(searchInput, { target: { value: 'صيانة' } });
  expect(screen.queryByText('كهرباء وإنارة')).not.toBeInTheDocument();
  expect(screen.getByText('صيانة ونظافة')).toBeInTheDocument();

  // Clear search
  fireEvent.change(searchInput, { target: { value: '' } });

  // Test Add Modal
  const addBtn = screen.getByRole('button', { name: /إضافة نوع مصروف/i });
  fireEvent.click(addBtn);

  expect(await screen.findByText('إضافة نوع مصروف جديد')).toBeInTheDocument();
  const codeInput = screen.getByPlaceholderText(/مثال: 501/i);
  const nameArInput = screen.getByPlaceholderText(/مثال: كهرباء/i);
  fireEvent.change(codeInput, { target: { value: '520' } });
  fireEvent.change(nameArInput, { target: { value: 'تسويق وإعلانات' } });

  const saveAddBtn = screen.getByRole('button', { name: 'إضافة المصروف' });
  fireEvent.click(saveAddBtn);

  await waitFor(() => {
    expect(finance.addExpenseDefinitionAction).toHaveBeenCalledWith(
      expect.objectContaining({ code: '520', name_ar: 'تسويق وإعلانات' })
    );
  });

  // Test Edit Modal
  const editButtons = screen.getAllByTitle('تعديل تعريف المصروف');
  expect(editButtons.length).toBeGreaterThan(0);
  fireEvent.click(editButtons[0]); // click first edit

  expect(await screen.findByText('تعديل تعريف المصروف')).toBeInTheDocument();
  const editNameInput = screen.getByDisplayValue('كهرباء وإنارة');
  fireEvent.change(editNameInput, { target: { value: 'كهرباء ومولدات' } });

  const saveEditBtn = screen.getByRole('button', { name: 'حفظ التعديلات' });
  fireEvent.click(saveEditBtn);

  await waitFor(() => {
    expect(finance.updateExpenseDefinitionAction).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ name_ar: 'كهرباء ومولدات' })
    );
  });

  // Test Delete
  const deleteButtons = screen.getAllByTitle('حذف تعريف المصروف');
  expect(deleteButtons.length).toBeGreaterThan(0);
  fireEvent.click(deleteButtons[0]);

  expect(window.confirm).toHaveBeenCalled();
  await waitFor(() => {
    expect(finance.deleteExpenseDefinitionAction).toHaveBeenCalledWith(1);
  });
});

it('renders financial notices tab with summary stats, search filter, and target badges', async () => {
  const sampleNotices = [
    {
      id: 'fn-1',
      type: 'credit',
      target_type: 'customer',
      target_id: 'p-1',
      target_name: 'أحمد محمود',
      amount: 150,
      reason: 'خصم إضافي / تسوية حساب',
      user_name: 'د. محمد',
      notes: 'تسوية شهرية',
      date: '2026-09-01',
    },
    {
      id: 'fn-2',
      type: 'debit',
      target_type: 'supplier',
      target_id: '1',
      target_name: 'شركة فارما',
      amount: 500,
      reason: 'خصم تجاري / تسوية فاتورة',
      user_name: 'د. محمد',
      notes: 'بونص كمية',
      date: '2026-09-01',
    },
  ];

  (finance.getFinancialNoticesAction as jest.Mock).mockResolvedValue({
    success: true,
    data: sampleNotices,
  });

  const { fireEvent } = await import('@testing-library/react');
  render(<AccountsManagementClient initialTab="notices" />);

  // Verify list rendered with target names
  expect(await screen.findByText('أحمد محمود')).toBeInTheDocument();
  expect(screen.getByText('شركة فارما')).toBeInTheDocument();

  // Verify totals rendered
  expect(screen.getByText('إجمالي الإشعارات المدينة (Debit)')).toBeInTheDocument();
  expect(screen.getByText('إجمالي الإشعارات الدائنة (Credit)')).toBeInTheDocument();
  expect(screen.getByText('صافي أثر التسويات')).toBeInTheDocument();

  // Test live search filter
  const searchInput = screen.getByPlaceholderText(/بحث بالسبب، الجهة/i);
  fireEvent.change(searchInput, { target: { value: 'فارما' } });
  expect(screen.queryByText('أحمد محمود')).not.toBeInTheDocument();
  expect(screen.getByText('شركة فارما')).toBeInTheDocument();
});

it('renders operational expenses tab with stats, live search, add expense modal, and deletion', async () => {
  const expenses = await import('@/app/actions-client/expenses');
  const sampleExpenses = [
    {
      id: 'exp-1',
      category: 'electricity',
      amount: 450,
      user_name: 'د. محمد',
      description: 'فاتورة الكهرباء',
      date: '2026-09-01',
    },
    {
      id: 'exp-2',
      category: 'rent',
      amount: 3000,
      user_name: 'د. محمد',
      description: 'إيجار شهر 9',
      date: '2026-09-01',
    },
  ];

  (expenses.getExpensesAction as jest.Mock).mockResolvedValue({
    success: true,
    data: sampleExpenses,
  });
  (expenses.addExpenseAction as jest.Mock).mockResolvedValue({
    success: true,
    id: 'exp-new-1',
  });
  (expenses.deleteExpenseAction as jest.Mock).mockResolvedValue({
    success: true,
  });
  (finance.getExpenseDefinitionsAction as jest.Mock).mockResolvedValue({
    success: true,
    data: [
      { id: 1, code: 'electricity', name_ar: 'كهرباء وإنارة', name_en: 'Electricity' },
      { id: 2, code: 'rent', name_ar: 'إيجار', name_en: 'Rent' },
    ],
  });

  const { fireEvent } = await import('@testing-library/react');
  render(<AccountsManagementClient initialTab="expenses" />);

  // Check stats and headers
  expect(await screen.findByText('المصاريف التشغيلية')).toBeInTheDocument();
  expect(screen.getByText('إجمالي الشهر')).toBeInTheDocument();
  expect(screen.getByText('أكبر تصنيف')).toBeInTheDocument();
  expect(screen.getByText('عدد العمليات')).toBeInTheDocument();

  // Check table entries
  expect(await screen.findByText('فاتورة الكهرباء')).toBeInTheDocument();
  expect(screen.getByText('إيجار شهر 9')).toBeInTheDocument();

  // Search filter
  const searchInput = screen.getByPlaceholderText(/بحث بالتصنيف، المبلغ/i);
  fireEvent.change(searchInput, { target: { value: 'الكهرباء' } });
  expect(screen.getByText('فاتورة الكهرباء')).toBeInTheDocument();
  expect(screen.queryByText('إيجار شهر 9')).not.toBeInTheDocument();

  // Clear search
  fireEvent.change(searchInput, { target: { value: '' } });

  // Test Add Expense Modal
  const addBtn = screen.getByRole('button', { name: /إضافة مصروف \(F4\)/i });
  fireEvent.click(addBtn);

  expect(await screen.findByText('إضافة مصروف تشغيلي جديد')).toBeInTheDocument();
  const amtInput = screen.getByPlaceholderText('0.00');
  fireEvent.change(amtInput, { target: { value: '120' } });

  const descInput = screen.getByPlaceholderText(/اكتب بيان أو سبب المصروف/i);
  fireEvent.change(descInput, { target: { value: 'مستلزمات نظافة' } });

  const saveBtn = screen.getByRole('button', { name: /حفظ المصروف/i });
  fireEvent.click(saveBtn);

  await waitFor(() => {
    expect(expenses.addExpenseAction).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 120,
        description: 'مستلزمات نظافة',
      })
    );
  });

  // Test Delete Expense
  window.confirm = jest.fn(() => true);
  const deleteButtons = screen.getAllByTitle('حذف المصروف');
  expect(deleteButtons.length).toBeGreaterThan(0);
  fireEvent.click(deleteButtons[0]);

  expect(window.confirm).toHaveBeenCalled();
  await waitFor(() => {
    expect(expenses.deleteExpenseAction).toHaveBeenCalledWith('exp-1');
  });
});





