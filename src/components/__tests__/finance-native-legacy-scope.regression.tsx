import { fireEvent, render, screen } from '@testing-library/react';
import TrialBalanceReport from '@/components/reports/TrialBalanceReport';
import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import * as finance from '@/app/actions-client/finance';

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('react-hotkeys-hook', () => ({ useHotkeys: jest.fn() }));
jest.mock('react-hot-toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('@/lib/auth/local', () => ({
  getClientSession: jest.fn(async () => ({ id: 'owner-a', role: 'owner' })),
  hasUserPermissionSync: jest.fn(() => true),
}));
jest.mock('@/components/finance/FinancialComponents', () => ({
  FinancialNoticeForm: () => <div>financial-notice-form</div>,
}));
jest.mock('@/components/finance/TrialBalanceSettingsClient', () => () => null);
jest.mock('@/components/finance/CashTransactionsClient', () => () => null);
jest.mock('@/app/actions-client/expenses', () => ({
  getExpensesAction: jest.fn(async () => ({ success: true, data: [] })),
  addExpenseAction: jest.fn(),
}));
jest.mock('@/app/actions-client/finance', () => ({
  getTrialBalanceAction: jest.fn(),
  getAccountsAction: jest.fn(),
  getCashMovementsAction: jest.fn(),
  getPointsOfSaleAction: jest.fn(),
  getExpenseDefinitionsAction: jest.fn(),
  getBanksAction: jest.fn(),
  getPapersAction: jest.fn(),
  getCardsAction: jest.fn(),
  getJournalsAction: jest.fn(),
  getFinancialNoticesAction: jest.fn(),
  getActivityLogsAction: jest.fn(),
  getTreasuryDashboardAction: jest.fn(),
}));

const nativeTrial = [
  { id: 1, code: '1.1.1', name_ar: 'خزنة اختبار مستقلة', name_en: 'QA cash', type: 'asset', is_group: 0,
    net_debit: 300, net_credit: 0, period_debit: 300, period_credit: 0 },
  { id: 2, code: '3.1', name_ar: 'مبيعات اختبار مستقلة', name_en: 'QA sales', type: 'revenue', is_group: 0,
    net_debit: 0, net_credit: 300, period_debit: 0, period_credit: 300 },
];

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(window, 'print', { configurable: true, value: jest.fn() });
  for (const name of [
    'getAccountsAction', 'getCashMovementsAction', 'getPointsOfSaleAction', 'getExpenseDefinitionsAction',
    'getBanksAction', 'getPapersAction', 'getCardsAction', 'getJournalsAction',
    'getFinancialNoticesAction', 'getActivityLogsAction',
  ]) (finance as any)[name].mockResolvedValue({ success: true, data: [] });
  (finance.getTreasuryDashboardAction as jest.Mock).mockResolvedValue({
    success: true, data: { treasuryBalance: 0, drawerBalance: 0, ledgerCashBalance: 0,
      todayReceipts: 0, todayExpenses: 0, totalShiftHandovers: 0,
      counts: { treasury: 0, receipts: 0, expenses: 0, handovers: 0 } },
  });
});

it('labels the verified native tenant-only trial balance and includes its limitation in CSV', async () => {
  (finance.getTrialBalanceAction as jest.Mock).mockResolvedValue({ success: true, data: nativeTrial });
  let csvBlob: Blob | undefined;
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn((blob: Blob) => {
    csvBlob = blob;
    return 'blob:mock-report';
  }) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<TrialBalanceReport userRole="owner" />);
  expect(await screen.findByText('خزنة اختبار مستقلة')).toBeInTheDocument();
  expect(screen.getByRole('note')).toHaveTextContent('قيود local_default التاريخية غير منسوبة');
  expect(screen.getByText(/حركات القيود المسندة إلى الصيدلية الحالية/)).toBeInTheDocument();
  expect(screen.getByText(/لا يعني ذلك اكتمال السجل التاريخي/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'طباعة' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: /تصدير CSV/ }));
  expect(csvBlob).toBeDefined();
  const csvText = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(csvBlob!);
  });
  expect(csvText).toContain('قيود local_default التاريخية غير منسوبة');
  expect(csvText).toContain('خزنة اختبار مستقلة');
  click.mockRestore();
});

it('clears a previous successful trial on a failed refresh and blocks export and print', async () => {
  (finance.getTrialBalanceAction as jest.Mock)
    .mockResolvedValueOnce({ success: true, data: nativeTrial })
    .mockResolvedValueOnce({ success: false, error: 'Unverifiable finance journal entry source' });
  render(<TrialBalanceReport userRole="owner" />);
  expect(await screen.findByText('خزنة اختبار مستقلة')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'تحديث ميزان المراجعة' }));
  expect(await screen.findByText('Unverifiable finance journal entry source')).toBeInTheDocument();
  expect(screen.queryByText('خزنة اختبار مستقلة')).not.toBeInTheDocument();
  expect(screen.queryByText(/القيود المسندة متوازنة/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /تصدير CSV/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'طباعة' })).toBeDisabled();
  expect(screen.getByRole('note')).toHaveTextContent('لا يؤكد هذا التقرير اكتمال الأرصدة التاريخية');
});

it('shows a persistent legacy exclusion notice on the accounts chart and rejects false empty balances', async () => {
  (finance.getAccountsAction as jest.Mock).mockResolvedValueOnce({
    success: true,
    data: [{ id: 1, code: '1.1.1', name_ar: 'خزنة اختبار مستقلة', name_en: 'QA cash',
      type: 'asset', is_group: 0, balance: 300 }],
  });
  render(<AccountsManagementClient initialTab="chart_of_accounts" />);
  expect(await screen.findByText('خزنة اختبار مستقلة')).toBeInTheDocument();
  expect(screen.getByRole('note')).toHaveTextContent('قيود local_default التاريخية');
  expect(screen.getByRole('note')).toHaveTextContent('اكتمال السجل المحاسبي التاريخي');
});

it('does not show stale or zero chart balances after a native verification failure', async () => {
  (finance.getAccountsAction as jest.Mock).mockResolvedValueOnce({
    success: false, error: 'Unreconciled legacy finance journal ownership prevents complete reporting',
  });
  render(<AccountsManagementClient initialTab="chart_of_accounts" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Unreconciled legacy finance journal ownership');
  expect(screen.queryByText('لا توجد حسابات مسجلة')).not.toBeInTheDocument();
  expect(screen.queryByText('خزنة اختبار مستقلة')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeInTheDocument();
});
