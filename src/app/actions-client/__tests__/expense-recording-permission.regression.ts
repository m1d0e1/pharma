import { createFunctionTransactionDb as mockCreateFunctionTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let permissions: Record<string, boolean> = {};

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({
    id: 'expense-user',
    role: 'pharmacist',
    pharmacy_id: 'local_default',
    permissions,
  })),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.permissions?.[key] === true),
}));

jest.mock('@/lib/db/tauri', () => ({
  ...(() => {
    const dbSelect = jest.fn(async () => []);
    const dbGet = jest.fn(async () => null);
    const dbExecute = jest.fn(async () => ({ rowsAffected: 1, lastInsertId: 1 }));
    return {
      dbSelect,
      dbGet,
      dbExecute,
      dbTransaction: jest.fn(async (callback: any) => callback(mockCreateFunctionTransactionDb({ select: dbSelect, get: dbGet, execute: dbExecute }))),
    };
  })(),
  generateId: jest.fn(() => 'expense-1'),
}));

jest.mock('@/app/actions-client/finance', () => ({
  createCashMovementAction: jest.fn(async () => ({ success: true, id: 'cash-1' })),
}));

import { addExpenseAction, getExpensesAction, getExpenseSummaryAction } from '@/app/actions-client/expenses';
import { createCashMovementAction } from '@/app/actions-client/finance';
import { dbTransaction } from '@/lib/db/tauri';

describe('expense recording permission contract', () => {
  beforeEach(() => {
    permissions = {};
    jest.clearAllMocks();
  });

  it('allows a cash-flow operator to record an operational expense', async () => {
    permissions = { acc_can_process_cash_flow: true };

    await expect(addExpenseAction({
      category: 'rent',
      amount: 25,
      description: 'cash-flow expense',
      date: '2026-09-21',
      source_type: 'main_safe',
      shift_id: 'shift-1',
    })).resolves.toEqual({ success: true, id: 'expense-1' });

    expect(dbTransaction).toHaveBeenCalledTimes(1);
    expect(createCashMovementAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'disbursement',
        category: 'operating_expenses',
        sub_category: 'rent',
        amount: 25,
        source_type: 'main_safe',
        shift_id: 'shift-1',
      }),
      expect.objectContaining({ prepare: expect.any(Function) }),
    );
  });

  it('keeps cash-flow-only users out of expense/P&L read APIs', async () => {
    permissions = { acc_can_process_cash_flow: true };

    await expect(getExpensesAction()).resolves.toEqual({ success: false, error: 'غير مصرح' });
    await expect(getExpenseSummaryAction()).resolves.toEqual({ success: false, error: 'غير مصرح' });
  });

  it('still allows the dedicated expense-definition permission to record expenses', async () => {
    permissions = { acc_can_define_expenses: true };

    await expect(addExpenseAction({
      category: 'rent',
      amount: 10,
      description: '',
      date: '2026-09-21',
    })).resolves.toMatchObject({ success: true });
  });

  it('does not let an expense-definition user read expense history or P&L without view permission', async () => {
    permissions = { acc_can_define_expenses: true };

    await expect(getExpensesAction()).resolves.toEqual({ success: false, error: 'غير مصرح' });
    await expect(getExpenseSummaryAction()).resolves.toEqual({ success: false, error: 'غير مصرح' });
  });

  it('keeps an expenses viewer without either write permission read-only', async () => {
    permissions = { can_view_expenses: true };

    await expect(addExpenseAction({
      category: 'rent',
      amount: 10,
      description: '',
      date: '2026-09-21',
    })).resolves.toEqual({ success: false, error: 'غير مصرح' });

    expect(dbTransaction).not.toHaveBeenCalled();
    expect(createCashMovementAction).not.toHaveBeenCalled();
  });
});
