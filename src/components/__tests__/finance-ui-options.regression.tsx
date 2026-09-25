import fs from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import * as finance from '@/app/actions-client/finance';
import { getExpensesAction } from '@/app/actions-client/expenses';
import { getClientSession } from '@/lib/auth/local';
import { toast } from 'react-hot-toast';

jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
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
  getTreasuryDashboardAction: jest.fn(),
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
  createManualJournalAction: jest.fn(),
  addAccountAction: jest.fn(),
  updateAccountAction: jest.fn(),
  deleteAccountAction: jest.fn(),
  getJournalDetailsAction: jest.fn(),
  seedFinanceTestDataAction: jest.fn(),
  getFinancialNoticesAction: jest.fn(),
  getActivityLogsAction: jest.fn(),
}));

const emptyResult = { success: true, data: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  (getClientSession as jest.Mock).mockResolvedValue({ role: 'owner' });
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
  (finance.getTreasuryDashboardAction as jest.Mock).mockResolvedValue({
    success: true,
    data: {
      treasuryBalance: 0,
      ledgerCashBalance: 0,
      todayReceipts: 0,
      todayExpenses: 0,
      totalShiftHandovers: 0,
      counts: { treasury: 0, receipts: 0, expenses: 0, handovers: 0 },
      detailCount: 0,
      details: [],
    },
  });
});

it.each([
  { ledgerCash: 100, drawer: 200, pos: 0, bank: 20 },
  { ledgerCash: 100, drawer: 200, pos: 60, bank: 20 },
  { ledgerCash: 40, drawer: 300, pos: 0, bank: 80 },
])('keeps ledger liquidity separate from physical drawer cash: %j', async ({ ledgerCash, drawer, pos, bank }) => {
  (finance.getTreasuryDashboardAction as jest.Mock).mockResolvedValue({
    success: true,
    data: { treasuryBalance: drawer, ledgerCashBalance: ledgerCash, todayReceipts: 0, todayExpenses: 0, totalShiftHandovers: 0 },
  });
  (finance.getPointsOfSaleAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 1, name_ar: 'POS', current_balance: pos }] });
  (finance.getBanksAction as jest.Mock).mockResolvedValue({ success: true, data: [{ id: 2, name_ar: 'Bank', current_balance: bank }] });
  render(<AccountsManagementClient initialTab="treasury" />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'إجمالي السيولة' }).parentElement).toHaveTextContent((ledgerCash + bank).toFixed(2)));
  expect(screen.getByRole('button', { name: 'عرض تفاصيل رصيد الخزنة (الدرج)' })).toHaveTextContent(String(drawer));
  expect(screen.getByText(/يختلف عن نقدية الدرج الفعلية/)).toBeInTheDocument();
});

it('keeps treasury read-only for a user who can view finance but cannot process cash', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({
    id: 'viewer-1',
    role: 'pharmacist',
    permissions: ['acc_can_view_general'],
  });

  render(<AccountsManagementClient initialTab="treasury" />);

  expect(await screen.findByText('سجل توريدات وحركات النقدية')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /صرف نقدية/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /إضافة توريد جديد/ })).not.toBeInTheDocument();
  await waitFor(() => expect(finance.getCashMovementsAction).toHaveBeenCalled());
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

it('keeps the newest finance tab loading while an older tab request finishes first', async () => {
  const olderBanks = deferred<any>();
  const newerBanks = deferred<any>();
  let bankCalls = 0;
  (finance.getBanksAction as jest.Mock).mockImplementation(() => {
    bankCalls += 1;
    return bankCalls === 1 ? olderBanks.promise : newerBanks.promise;
  });
  (finance.getCardsAction as jest.Mock).mockResolvedValue({ success: true, data: [] });

  render(<AccountsManagementClient initialTab="banks" />);
  await waitFor(() => expect(finance.getBanksAction).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: /البطاقات الائتمانية/ }));
  await waitFor(() => expect(finance.getBanksAction).toHaveBeenCalledTimes(2));
  expect(screen.getByText('جاري تحميل البيانات...')).toBeInTheDocument();

  await act(async () => {
    olderBanks.resolve({ success: true, data: [] });
    await olderBanks.promise;
  });
  expect(screen.getByText('جاري تحميل البيانات...')).toBeInTheDocument();
  expect(screen.queryByText(/لا توجد ماكينات مسجلة/)).not.toBeInTheDocument();

  newerBanks.resolve({ success: true, data: [] });
  expect(await screen.findByText(/لا توجد ماكينات مسجلة/)).toBeInTheDocument();
});

it('shows the current-month total money recorded by completed shift handovers', async () => {
  (finance.getTreasuryDashboardAction as jest.Mock).mockResolvedValue({
    success: true,
    data: {
      treasuryBalance: 500,
      ledgerCashBalance: 700,
      todayReceipts: 100,
      todayExpenses: 25,
      totalShiftHandovers: 150.5,
      counts: { treasury: 1, receipts: 1, expenses: 1, handovers: 2 },
      detailCount: 0,
      details: [],
    },
  });

  render(<AccountsManagementClient initialTab="treasury" />);

  const handoverCard = (await screen.findByText('تسليمات الورديات هذا الشهر')).parentElement;
  await waitFor(() => expect(handoverCard).toHaveTextContent('150.5 ج.م'));
});

it.each(['shift-updated', 'storage', 'focus'])('refreshes drawer balance and open drawer details after %s', async eventType => {
  let refreshed = false;
  (finance.getTreasuryDashboardAction as jest.Mock).mockImplementation(async (metric?: string) => ({
    success: true,
    data: {
      treasuryBalance: refreshed ? 275 : 120,
      ledgerCashBalance: 800,
      todayReceipts: 0,
      todayExpenses: 0,
      totalShiftHandovers: 0,
      counts: { treasury: 2, receipts: 0, expenses: 0, handovers: 0 },
      detailCount: metric === 'treasury' ? 2 : 0,
      details: metric === 'treasury' ? [{
        id: refreshed ? 'opening-new' : 'opening-old',
        date: '2026-09-25',
        description: refreshed ? 'رصيد بداية الوردية الجديدة' : 'رصيد بداية الوردية الحالية',
        amount: refreshed ? 200 : 100,
        type: 'receipt',
      }, {
        id: 'cash-sales',
        date: '2026-09-25',
        description: 'مبيعات نقدية',
        amount: refreshed ? 75 : 20,
        type: 'receipt',
      }] : [],
    },
  }));

  render(<AccountsManagementClient initialTab="treasury" />);
  fireEvent.click(await screen.findByRole('button', { name: 'عرض تفاصيل رصيد الخزنة (الدرج)' }));
  expect(await screen.findByText('رصيد بداية الوردية الحالية')).toBeInTheDocument();
  expect(screen.getByText('مبيعات نقدية')).toBeInTheDocument();

  refreshed = true;
  await act(async () => window.dispatchEvent(eventType === 'storage'
    ? new StorageEvent('storage', { key: 'pharma:shift-updated', newValue: 'new-shift' })
    : new Event(eventType)));
  expect(await screen.findByText('رصيد بداية الوردية الجديدة')).toBeInTheDocument();
  expect(screen.queryByText('رصيد بداية الوردية الحالية')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'عرض تفاصيل رصيد الخزنة (الدرج)' })).toHaveTextContent('275');
});

it('hides stale drawer amounts and offers retry when the summary fails', async () => {
  render(<AccountsManagementClient initialTab="treasury" />);
  await waitFor(() => expect(finance.getTreasuryDashboardAction).toHaveBeenCalled());
  (finance.getTreasuryDashboardAction as jest.Mock).mockResolvedValue({ success: false, error: 'تعذر حساب رصيد الدرج' });
  await act(async () => window.dispatchEvent(new Event('shift-updated')));
  expect(await screen.findByRole('alert')).toHaveTextContent('تعذر حساب رصيد الدرج');
  expect(screen.queryByRole('button', { name: 'عرض تفاصيل رصيد الخزنة (الدرج)' })).not.toBeInTheDocument();
  (finance.getTreasuryDashboardAction as jest.Mock).mockResolvedValue({ success: true, data: {
    treasuryBalance: 40, ledgerCashBalance: 100, todayReceipts: 0, todayExpenses: 0, totalShiftHandovers: 60,
  } });
  fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'عرض تفاصيل رصيد الخزنة (الدرج)' })).toHaveTextContent('40'));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('opens authoritative details from every treasury summary card', async () => {
  const totals = {
    treasuryBalance: 45,
    ledgerCashBalance: 500,
    todayReceipts: 100,
    todayExpenses: 25,
    totalShiftHandovers: 150,
    counts: { treasury: 1, receipts: 1, expenses: 1, handovers: 1 },
  };
  (finance.getTreasuryDashboardAction as jest.Mock).mockImplementation(async (metric?: string) => ({
    success: true,
    data: {
      ...totals,
      detailCount: metric ? 1 : 0,
      details: metric ? [{
        id: `${metric}-1`,
        date: '2026-09-01',
        description: `تفصيل ${metric}`,
        amount: 25,
        type: metric === 'receipts' || metric === 'treasury' ? 'receipt' : 'disbursement',
        user_name: 'د. محمد',
      }] : [],
    },
  }));

  render(<AccountsManagementClient initialTab="treasury" />);

  for (const [label, metric] of [
    ['رصيد الخزنة (الدرج)', 'treasury'],
    ['توريدات اليوم', 'receipts'],
    ['المصروفات اليومية', 'expenses'],
    ['تسليمات الورديات هذا الشهر', 'handovers'],
  ] as const) {
    fireEvent.click(await screen.findByRole('button', { name: `عرض تفاصيل ${label}` }));
    await waitFor(() => expect(finance.getTreasuryDashboardAction).toHaveBeenCalledWith(metric));
    expect(await screen.findByText(`تفصيل ${metric}`)).toBeInTheDocument();
  }
  expect(screen.getByText(/التحويل لوردية تالية لا ينشئ إيرادًا جديدًا/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'عرض تفاصيل رصيد الخزنة' })).not.toBeInTheDocument();
});

it('keeps treasury details owned by the newest summary-card request', async () => {
  const older = deferred<any>();
  const newer = deferred<any>();
  const base = {
    treasuryBalance: 500,
    ledgerCashBalance: 600,
    todayReceipts: 100,
    todayExpenses: 25,
    totalShiftHandovers: 150,
    counts: { treasury: 1, receipts: 1, expenses: 1, handovers: 1 },
  };
  (finance.getTreasuryDashboardAction as jest.Mock).mockImplementation((metric?: string) => {
    if (!metric) return Promise.resolve({ success: true, data: { ...base, detailCount: 0, details: [] } });
    if (metric === 'treasury') return older.promise;
    if (metric === 'receipts') return newer.promise;
    return Promise.resolve({ success: true, data: { ...base, detailCount: 0, details: [] } });
  });

  render(<AccountsManagementClient initialTab="treasury" />);
  fireEvent.click(await screen.findByRole('button', { name: 'عرض تفاصيل رصيد الخزنة (الدرج)' }));
  await waitFor(() => expect(finance.getTreasuryDashboardAction).toHaveBeenCalledWith('treasury'));
  fireEvent.click(screen.getByRole('button', { name: 'عرض تفاصيل توريدات اليوم' }));
  await waitFor(() => expect(finance.getTreasuryDashboardAction).toHaveBeenCalledWith('receipts'));

  newer.resolve({
    success: true,
    data: { ...base, detailCount: 1, details: [{ id: 'new', date: '2026-09-22', description: 'newest treasury detail', amount: 11, type: 'receipt' }] },
  });
  expect(await screen.findByText('newest treasury detail')).toBeInTheDocument();

  await act(async () => {
    older.resolve({
      success: true,
      data: { ...base, detailCount: 1, details: [{ id: 'old', date: '2026-09-22', description: 'stale treasury detail', amount: 9, type: 'receipt' }] },
    });
    await older.promise;
  });
  expect(screen.queryByText('stale treasury detail')).not.toBeInTheDocument();
  expect(screen.getByText('newest treasury detail')).toBeInTheDocument();
});

it('surfaces a thrown treasury-detail request and releases its loading state for retry', async () => {
  const base = {
    treasuryBalance: 0,
    ledgerCashBalance: 0,
    todayReceipts: 0,
    todayExpenses: 0,
    totalShiftHandovers: 0,
    counts: { treasury: 0, receipts: 0, expenses: 0, handovers: 0 },
  };
  let treasuryAttempts = 0;
  (finance.getTreasuryDashboardAction as jest.Mock).mockImplementation((metric?: string) => {
    if (!metric) return Promise.resolve({ success: true, data: { ...base, detailCount: 0, details: [] } });
    if (metric === 'treasury') {
      treasuryAttempts += 1;
      if (treasuryAttempts === 1) return Promise.reject(new Error('bridge unavailable'));
      return Promise.resolve({
        success: true,
        data: {
          ...base,
          detailCount: 1,
          details: [{ id: 'retry', date: '2026-09-22', description: 'retry detail', amount: 5, type: 'receipt' }],
        },
      });
    }
    return Promise.resolve({ success: true, data: { ...base, detailCount: 0, details: [] } });
  });

  render(<AccountsManagementClient initialTab="treasury" />);
  const treasury = await screen.findByRole('button', { name: 'عرض تفاصيل رصيد الخزنة (الدرج)' });
  fireEvent.click(treasury);
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('فشل جلب تفاصيل الرقم'));

  fireEvent.click(treasury);
  expect(await screen.findByText('retry detail')).toBeInTheDocument();
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

it('filters immutable handover history and exposes the logical user drawer', async () => {
  (finance.getCashMovementsAction as jest.Mock).mockResolvedValue({
    success: true,
    data: [
      { id: 'handover-1', category: 'handover', type: 'disbursement', amount: 120, source_type: 'user_drawer', user_name: 'د. محمد', target_name: 'د. سارة', shift_id: 'shift-123', date: '2026-09-01 11:00' },
      { id: 'expense-1', category: 'salaries', type: 'disbursement', amount: 900, date: '2026-09-01 12:00' },
    ],
  });

  const { fireEvent } = await import('@testing-library/react');
  render(<AccountsManagementClient initialTab="treasury" />);

  expect(await screen.findByText(/د\. سارة/)).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'سجل التسليمات' }));
  expect(await screen.findByText('تسليم درج')).toBeInTheDocument();
  expect(screen.getByText('درج د. محمد')).toBeInTheDocument();
  expect(screen.queryByText('أجور ومرتبات')).not.toBeInTheDocument();
});

it('opens the wired balanced manual-journal form from daily journals', async () => {
  (finance.getAccountsAction as jest.Mock).mockResolvedValue({
    success: true,
    data: [
      { id: 1, code: '1.1.1', name_ar: 'الخزينة', type: 'asset', is_group: 0 },
      { id: 2, code: '4.1', name_ar: 'التسويات', type: 'income', is_group: 0 },
    ],
  });

  const { fireEvent } = await import('@testing-library/react');
  render(<AccountsManagementClient initialTab="daily_journals" />);
  fireEvent.click(await screen.findByRole('button', { name: /قيد يومي جديد/ }));

  expect(await screen.findByText('إنشاء سند قيد يومي يدوي')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'حفظ القيد اليومي' })).toBeDisabled();
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

it('keeps the Chart of Accounts read-only without daily-entry permission', async () => {
  const sampleAccounts = [
    { id: 1, code: '1', name_ar: 'الأصول', name_en: 'Assets', type: 'asset', is_group: 1, parent_id: null, balance: 100 },
    { id: 2, code: '1.1', name_ar: 'الأصول المتداولة', name_en: 'Current Assets', type: 'asset', is_group: 1, parent_id: 1, balance: 100 },
    { id: 3, code: '1.1.1', name_ar: 'الصندوق الفرعي', name_en: 'Sub Cash Drawer', type: 'asset', is_group: 0, parent_id: 2, balance: 100 },
  ];
  (getClientSession as jest.Mock).mockResolvedValue({
    id: 'viewer-accounts',
    role: 'pharmacist',
    permissions: ['acc_can_view_general'],
  });
  (finance.getAccountsAction as jest.Mock).mockResolvedValue({ success: true, data: sampleAccounts });

  const { fireEvent } = await import('@testing-library/react');
  render(<AccountsManagementClient initialTab="chart_of_accounts" />);

  const nestedGroup = await screen.findByText('الأصول المتداولة');
  fireEvent.click(nestedGroup);
  expect(await screen.findByText(/الصندوق الفرعي/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /إضافة حساب رئيسي/ })).not.toBeInTheDocument();
  expect(screen.queryByTitle('إضافة حساب فرعي')).not.toBeInTheDocument();
  expect(screen.queryByTitle('تعديل الحساب')).not.toBeInTheDocument();
  expect(screen.queryByTitle('حذف الحساب')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'جدول' }));
  expect(screen.queryByText('إجراءات')).not.toBeInTheDocument();
  expect(screen.queryByTitle('إضافة حساب فرعي')).not.toBeInTheDocument();
  expect(screen.queryByTitle('تعديل الحساب')).not.toBeInTheDocument();
  expect(screen.queryByTitle('حذف الحساب')).not.toBeInTheDocument();
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

  // Posted expenses are immutable because their cash and journal entries must remain linked.
  expect(screen.queryByTitle('حذف المصروف')).not.toBeInTheDocument();
});

it('lets a cash-flow operator record an operational expense without expense-definition permission', async () => {
  (getClientSession as jest.Mock).mockResolvedValue({
    id: 'cash-flow-operator',
    role: 'pharmacist',
    permissions: ['can_view_expenses', 'acc_can_process_cash_flow'],
  });
  (getExpensesAction as jest.Mock).mockResolvedValue({ success: true, data: [] });
  (finance.getExpenseDefinitionsAction as jest.Mock).mockResolvedValue({
    success: true,
    data: [{ id: 1, code: 'rent', name_ar: 'إيجار', name_en: 'Rent' }],
  });

  render(<AccountsManagementClient initialTab="expenses" />);

  expect(await screen.findByText('المصاريف التشغيلية')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /إضافة مصروف \(F4\)/i })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'تعريف المصروفات' })).not.toBeInTheDocument();
});
