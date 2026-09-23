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
  dbSelect: jest.fn(async () => []),
  dbGet: jest.fn(async () => null),
  dbExecute: jest.fn(async () => ({ rowsAffected: 1, lastInsertId: 1 })),
  dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
  generateId: jest.fn(() => 'expense-1'),
}));

jest.mock('@/app/actions-client/finance', () => ({
  createCashMovementAction: jest.fn(async () => ({ success: true, id: 'cash-1' })),
}));

import { addExpenseAction } from '@/app/actions-client/expenses';
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
    })).resolves.toEqual({ success: true, id: 'expense-1' });

    expect(dbTransaction).toHaveBeenCalledTimes(1);
    expect(createCashMovementAction).toHaveBeenCalledWith(expect.objectContaining({
      type: 'disbursement',
      category: 'operating_expenses',
      sub_category: 'rent',
      amount: 25,
    }));
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
