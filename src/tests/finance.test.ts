import {
  addFinancialNoticeAction,
  addPatientPaymentAction,
  createCashMovementAction,
  addAccountAction,
  updateAccountAction,
  generateDailySnapshotAction,
  getTrialBalanceAction
} from '@/app/actions/finance';
import { dbSelect, dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';
import { getLocalSession } from '@/lib/auth/local';
import { revalidatePath } from 'next/cache';

// Mock dependencies
jest.mock('@/lib/db/tauri', () => ({
  __esModule: true,
  dbSelect: jest.fn(),
  dbExecute: jest.fn(),
  dbGet: jest.fn(),
  dbTransaction: jest.fn((cb) => cb()),
  generateId: jest.fn(() => 'test-uuid-123'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('next/cache', () => ({
  revalidatePath: jest.fn(),
}));

describe('Finance Module Server Actions', () => {
  const mockUser = { id: 'test-user-id', pharmacy_id: 'test-pharmacy-id', role: 'owner' };
  
  beforeEach(() => {
    jest.clearAllMocks();
    (getLocalSession as jest.Mock).mockResolvedValue(mockUser);
    (dbTransaction as jest.Mock).mockImplementation((cb: any) => cb());
  });

  describe('addAccountAction (Unit Test - Chart of Accounts Hierarchy)', () => {
    it('should validate inputs and prevent SQL injection by using parameterized queries', async () => {
      (dbExecute as jest.Mock).mockResolvedValue({ rowsAffected: 1, lastInsertId: 123 });

      const input = {
        code: '111',
        name_ar: 'الخزينة',
        name_en: 'Treasury',
        type: 'asset' as const,
        is_group: 0,
        parent_id: null,
      };

      const result = await addAccountAction(input);

      expect(result.success).toBe(true);
      expect(result.id).toBe(123);
      expect(dbExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO accounts'),
        ['111', 'الخزينة', 'Treasury', 'asset', 0, null]
      );
    });

    it('should fail when input validation (Zod) fails', async () => {
      const invalidInput = {
        code: '', // invalid: min 1
        name_ar: 'الخزينة',
        type: 'invalid_type' as any, // invalid enum
        is_group: 5, // invalid: max 1
      };

      const result = await addAccountAction(invalidInput as any);

      expect(result.success).toBe(false);
      expect(dbExecute).not.toHaveBeenCalled();
    });
  });

  describe('updateAccountAction (Unit Test - Zod mapped fields)', () => {
    it('should securely map keys using Zod schemas', async () => {
      (dbExecute as jest.Mock).mockResolvedValue({ rowsAffected: 1 });

      const input = {
        name_ar: 'خزينة رئيسية',
        is_group: 1,
      };

      const result = await updateAccountAction(1, input);

      expect(result.success).toBe(true);
      expect(dbExecute).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE accounts SET name_ar = ?, is_group = ? WHERE id = ?'),
        ['خزينة رئيسية', 1, 1]
      );
    });
  });

  describe('createCashMovementAction (Integration Test - Journal Entries)', () => {
    it('should create a cash movement, daily journal, and balanced double-entry journals', async () => {
      (dbExecute as jest.Mock).mockResolvedValue({ rowsAffected: 1 });
      (dbGet as jest.Mock)
        .mockResolvedValueOnce({ account_id: 6 }) // Main Cash Account
        .mockResolvedValueOnce({ account_id: 11 }); // Category Account (Expense)

      const input = {
        type: 'disbursement' as const,
        category: 'operating_expenses',
        amount: 500,
        notes: 'صيانة',
        date: '2026-05-08',
      };

      const result = await createCashMovementAction(input);

      expect(result.success).toBe(true);
      expect(dbTransaction).toHaveBeenCalled();
      
      // Should have been called for: cash_movement, daily_journal, and 2 journal_entries
      expect(dbExecute).toHaveBeenCalledTimes(4); 
      
      // Verify Debit (Category) and Credit (Cash) for Disbursement
      // 1st entry: Category = 11, type = 'debit', amount = 500
      expect(dbExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO journal_entries'),
        [expect.any(String), 11, 'debit', 500]
      );
      // 2nd entry: Cash = 6, type = 'credit', amount = 500
      expect(dbExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO journal_entries'),
        [expect.any(String), 6, 'credit', 500]
      );
    });

    it('should return unauthenticated warning if session is missing', async () => {
      (getLocalSession as jest.Mock).mockResolvedValue(null);

      const input = {
        type: 'receipt' as const,
        category: 'sales',
        amount: 1000,
        date: '2026-05-08',
      };

      const result = await createCashMovementAction(input);

      expect(result.success).toBe(false);
      expect(result.error).toBe('غير مصرح');
      expect(dbTransaction).not.toHaveBeenCalled();
    });
  });

  describe('generateDailySnapshotAction (Logic Test - Net Profit)', () => {
    it('should aggregate sales, returns, and movements to calculate net profit', async () => {
      (dbExecute as jest.Mock).mockResolvedValue({ rowsAffected: 1 });
      (dbGet as jest.Mock)
        .mockResolvedValueOnce({ total: 5000 }) // Sales
        .mockResolvedValueOnce({ total: 500 })  // Returns
        .mockResolvedValueOnce({ net: -100 });  // Net Cash Movements (e.g. expenses)

      const result = await generateDailySnapshotAction('2026-05-08');

      expect(result.success).toBe(true);
      // Net Profit = 5000 - 500 + (-100) = 4400
      expect(result.data.net).toBe(4400); 
      expect(dbExecute).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO daily_financial_snapshots'),
        ['2026-05-08', 5000, 500, -100, 4400]
      );
    });
  });

  describe('getTrialBalanceAction (Logic Test - Equilibrium Check)', () => {
    it('should aggregate debits and credits from journal_entries to check trial balance', async () => {
      (dbSelect as jest.Mock).mockResolvedValue([
        { id: 1, code: '111', type: 'asset', total_debit: 1000, total_credit: 200 },
        { id: 2, code: '211', type: 'liability', total_debit: 0, total_credit: 800 },
      ]);

      const result = await getTrialBalanceAction();

      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      
      // Check net balances calculation
      const asset = result.data.find((a: any) => a.code === '111');
      expect(asset.net_debit).toBe(800);
      expect(asset.net_credit).toBe(0);

      const liability = result.data.find((a: any) => a.code === '211');
      expect(liability.net_debit).toBe(0);
      expect(liability.net_credit).toBe(800);
      
      // Verify Total Net Debit == Total Net Credit (800 == 800)
      const totalNetDebit = result.data.reduce((sum: number, acc: any) => sum + acc.net_debit, 0);
      const totalNetCredit = result.data.reduce((sum: number, acc: any) => sum + acc.net_credit, 0);
      expect(totalNetDebit).toBe(totalNetCredit);
    });
  });
});
