let mockSession: any;

const dbSelect = jest.fn();
const dbGet = jest.fn();
const dbExecute = jest.fn();
const dbTransaction = jest.fn();

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => dbSelect(...args),
  dbGet: (...args: any[]) => dbGet(...args),
  dbExecute: (...args: any[]) => dbExecute(...args),
  dbTransaction: (...args: any[]) => dbTransaction(...args),
  generateId: jest.fn(() => 'wave2-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, key: string) =>
    user?.role === 'owner' || user?.permissions?.[key] === true
  ),
  verifyPassword: jest.fn(async () => true),
}));

import {
  addAccountAction,
  addBankAction,
  addCardAction,
  addExpenseDefinitionAction,
  addFinancialNoticeAction,
  addPaperAction,
  addPointOfSaleAction,
  createCashMovementAction,
  getExpenseDefinitionsAction,
  getPointsOfSaleAction,
  getTrialBalanceAction,
  getTrialBalanceSettingsAction,
  updatePaperStatusAction,
} from '@/app/actions-client/finance';
import { getShiftsAction } from '@/app/actions-client/shifts';
import { processHandoverAction } from '@/app/actions-client/handover';

const deniedFinanceCases: Array<[string, () => Promise<any>]> = [
  ['acc_can_view_general', () => getTrialBalanceSettingsAction()],
  ['acc_can_view_pos', () => addPointOfSaleAction({ name_ar: 'POS' })],
  ['acc_can_view_bank_accounts', () => addBankAction({ name_ar: 'Bank' })],
  ['acc_can_define_expenses', () => addExpenseDefinitionAction({ code: 'W2', name_ar: 'Wave 2' })],
  ['acc_can_process_cash_flow', () => createCashMovementAction({
    type: 'receipt', category: 'collection', amount: 10, date: '2026-09-21',
  })],
  ['acc_can_view_securities', () => addPaperAction({
    type: 'check', direction: 'in', paper_number: 'CHK-W2', amount: 10,
    due_date: '2026-09-21', target_name: 'Test',
  })],
  ['acc_can_make_daily_entries', () => addAccountAction({
    code: '9.99', name_ar: 'Wave 2 Account', type: 'asset', is_group: 0,
  })],
  ['acc_can_view_notifications', () => addFinancialNoticeAction({
    target_type: 'pharmacy', type: 'debit', amount: 10,
    reason: 'Wave 2', date: '2026-09-21',
  })],
  ['acc_can_collect_credit_cards', () => addCardAction({ name_ar: 'Terminal' })],
  ['acc_can_view_reports', () => getTrialBalanceAction()],
  ['can_select_pos_financial', () => getPointsOfSaleAction()],
  ['can_view_expenses', () => getExpenseDefinitionsAction()],
  ['can_view_shifts', () => getShiftsAction({ status: 'all' })],
  ['acc_can_view_handover', () => processHandoverAction({
    shiftId: 'shift-1', actualCash: 0, transferAmount: 0,
    transferTargetId: '', transferTargetType: 'treasury',
    receiverUsername: '', receiverPasswordHash: '',
  })],
];

describe('wave 2 granular finance permission enforcement', () => {
  beforeEach(() => {
    mockSession = { id: 'view-only', role: 'cashier', pharmacy_id: 'ph-1', permissions: {} };
    dbSelect.mockReset();
    dbGet.mockReset();
    dbExecute.mockReset();
    dbTransaction.mockReset();
  });

  it.each(deniedFinanceCases)('denies %s before touching the database', async (_permission, action) => {
    const result = await action();

    expect(result).toMatchObject({ success: false });
    expect(dbSelect).not.toHaveBeenCalled();
    expect(dbGet).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
    expect(dbTransaction).not.toHaveBeenCalled();
  });

  it('lets a finance view-only user read general finance without granting cash mutation', async () => {
    mockSession.permissions.acc_can_view_general = true;
    dbSelect.mockResolvedValueOnce([]);

    expect(await getTrialBalanceSettingsAction()).toEqual({ success: true, data: [] });
    expect(await createCashMovementAction({
      type: 'receipt', category: 'collection', amount: 10, date: '2026-09-21',
    })).toEqual({ success: false, error: 'غير مصرح' });
  });

  it('requires cash-flow permission before a securities viewer can cash a paper', async () => {
    mockSession.permissions.acc_can_view_securities = true;
    dbGet.mockResolvedValueOnce({
      id: 'paper-1', type: 'check', direction: 'in', paper_number: 'CHK-1',
      amount: 10, status: 'pending', target_name: 'Test',
    });

    expect(await updatePaperStatusAction('paper-1', 'cashed', '2026-09-21')).toEqual({
      success: false,
      error: 'تحصيل أو صرف الورقة يتطلب صلاحية حركة النقدية',
    });
    expect(dbTransaction).not.toHaveBeenCalled();
  });
});
