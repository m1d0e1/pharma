import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
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
jest.mock('@/app/actions-client/expenses', () => ({ getExpensesAction: jest.fn() }));
jest.mock('@/app/actions-client/finance', () => ({
  createCashMovementAction: jest.fn(),
  getCashMovementsAction: jest.fn(),
  getPointsOfSaleAction: jest.fn(),
  getExpenseDefinitionsAction: jest.fn(),
  getBanksAction: jest.fn(),
  getPapersAction: jest.fn(),
  getCardsAction: jest.fn(),
  getAccountsAction: jest.fn(),
  getJournalsAction: jest.fn(),
  addAccountAction: jest.fn(),
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
    finance.getBanksAction,
    finance.getPapersAction,
    finance.getCardsAction,
    finance.getAccountsAction,
    finance.getJournalsAction,
    finance.getFinancialNoticesAction,
    finance.getActivityLogsAction,
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
  expect(finance.getPointsOfSaleAction).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /إضافة نقطة بيع/ })).toBeDisabled();
});

it.each([
  ['expense_definitions', 'إضافة نوع مصروف'],
  ['banks', 'إضافة حساب بنكي'],
  ['papers', 'شيك صادر'],
  ['cards', 'إضافة ماكينة / كارت'],
  ['daily_journals', 'قيد يومي جديد'],
])('labels the unfinished %s action as unavailable', async (tab, buttonName) => {
  render(<AccountsManagementClient initialTab={tab} />);

  expect(await screen.findByRole('button', { name: new RegExp(buttonName) })).toBeDisabled();
});
