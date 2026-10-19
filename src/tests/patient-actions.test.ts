import { createFunctionTransactionDb as mockCreateFunctionTransactionDb } from '@/tests/helpers/sqlite-transaction-db';
import { dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';
import { getLocalSession } from '@/lib/auth/local';

let shiftReadCount = 0;
let makeSharedShift = false;
let witnessOwner = 'tenant-a';

jest.mock('@/lib/db/tauri', () => {
  const dbSelect = jest.fn();
  const dbExecute = jest.fn();
  const dbGet = jest.fn();
  return {
    dbSelect,
    dbExecute,
    dbGet,
    dbTransaction: jest.fn((callback: any) => callback(mockCreateFunctionTransactionDb({ select: dbSelect, get: dbGet, execute: dbExecute }))),
    generateId: jest.fn()
      .mockReturnValueOnce('movement-id')
      .mockReturnValueOnce('journal-id')
      .mockReturnValue('generated-id'),
  };
});

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.role === 'owner' || user?.permissions?.[key] === true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: {} }));

const { updatePatientAction, updatePatientWalletAction } = jest.requireActual(
  '@/app/actions-client/patients'
) as typeof import('@/app/actions-client/patients');

describe('patient action financial safeguards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    shiftReadCount = 0;
    makeSharedShift = false;
    witnessOwner = 'tenant-a';
    (getLocalSession as jest.Mock).mockResolvedValue({ id: 'admin', role: 'owner', pharmacy_id: 'tenant-a' });
    (dbExecute as jest.Mock).mockResolvedValue({ rowsAffected: 1 });
    // Independent immutable ownership witness, not a guessed owner from
    // patient.id or local_default. The SQL text and binds are checked so the
    // mock cannot accidentally certify another branch's patient.
    (dbGet as jest.Mock).mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT 1 AS owned FROM patients p')) {
        expect(sql).toContain('native_patient_directory_ownership');
        expect(sql).toContain('NOT EXISTS (SELECT 1 FROM sales_invoices other');
        expect(params).toEqual(['patient-1', 'tenant-a', 'tenant-a']);
        return witnessOwner === 'tenant-a' ? { owned: 1 } : null;
      }
      if (sql.includes('AS opening_balance FROM patients')) return { opening_balance: 0 };
      if (sql.includes('FROM users') && sql.includes('pharmacy_id')) return { pharmacy_id: 'tenant-a' };
      if (sql.includes('FROM shifts s') && sql.includes('ORDER BY s.start_time')) {
        shiftReadCount++;
        return makeSharedShift && shiftReadCount === 1 ? null : {
          id: makeSharedShift ? 'shared-shift' : 'shift-1', user_id: 'admin', status: 'open',
        };
      }
      if (sql.includes('CAST(wallet_balance AS REAL)')) return { full_name: 'Test Patient', wallet_balance: 40 };
      if (sql.includes("category = 'cash_drawer'")) return { account_id: 6 };
      if (sql.includes("category = 'patient_wallet_liability'")) return { account_id: 12 };
      return null;
    });
  });

  it('does not overwrite wallet or loyalty when ordinary profile fields are saved', async () => {
    const result = await updatePatientAction('patient-1', {
      full_name: 'Test Patient',
      mobile: '01000000000',
      area: 'Cairo',
      car_number: 'ABC-1',
      credit_limit: 500,
      points_balance: 25,
      point_value: 2,
      payment_method: 'credit',
    } as any);

    expect(result.success).toBe(true);
    const [sql, params] = (dbExecute as jest.Mock).mock.calls[0];
    expect(sql).not.toContain('wallet_balance');
    expect(sql).not.toContain('loyalty_level');
    expect(sql).not.toContain('points_balance');
    expect(sql).not.toContain('opening_balance = ?');
    expect(sql).toContain('mobile = ?');
    expect(sql).toContain('area = ?');
    expect(sql).toContain('car_number = ?');
    expect(sql).toContain('payment_method = ?');
    expect(params).toContain('credit');
  });

  it('top-ups wallet, cash receipt, and liability journal in one transaction', async () => {
    const result = await updatePatientWalletAction('patient-1', 60, 'advance');

    expect(result).toMatchObject({ success: true, balance: 100 });
    expect(dbTransaction).toHaveBeenCalledTimes(1);
    expect(dbExecute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE patients SET wallet_balance'),
      [60, 'patient-1']
    );
    expect(dbExecute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO cash_movements'),
      expect.arrayContaining(['shift-1', 60, 'patient-1'])
    );
    expect(dbExecute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO journal_entries'),
      [expect.any(String), 6, 'debit', 60]
    );
    expect(dbExecute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO journal_entries'),
      [expect.any(String), 12, 'credit', 60]
    );
  });

  it('allows a delegated patient manager with cash-flow permission to top up the wallet', async () => {
    (getLocalSession as jest.Mock).mockResolvedValue({
      id: 'pharmacist-1',
      role: 'pharmacist',
      pharmacy_id: 'tenant-a',
      permissions: { can_view_patients: true, acc_can_process_cash_flow: true },
    });

    const result = await updatePatientWalletAction('patient-1', 60, 'advance');

    expect(result).toMatchObject({ success: true, balance: 100 });
    expect(dbTransaction).toHaveBeenCalledTimes(1);
  });

  it('creates the shared shift before a cash wallet top-up when none is open', async () => {
    makeSharedShift = true;

    const result = await updatePatientWalletAction('patient-1', 60, 'advance');

    expect(result).toMatchObject({ success: true, balance: 100 });
    expect(dbExecute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO shifts'),
      expect.arrayContaining(['admin'])
    );
    expect(dbExecute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO cash_movements'),
      expect.arrayContaining(['shared-shift', 60, 'patient-1'])
    );
  });

  it('rejects zero or negative wallet top-ups before starting a transaction', async () => {
    const result = await updatePatientWalletAction('patient-1', 0);

    expect(result.success).toBe(false);
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('rejects wallet top-ups when patient access is allowed but cash-flow permission is denied', async () => {
    (getLocalSession as jest.Mock).mockResolvedValue({
      id: 'patient-manager',
      role: 'pharmacist',
      permissions: { can_view_patients: true, acc_can_process_cash_flow: false },
    });

    const result = await updatePatientWalletAction('patient-1', 60, 'advance');

    expect(result.success).toBe(false);
    expect(result.error).toContain('غير مصرح');
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('rejects unowned, cross-tenant and local_default patients before any cash movement or journal write', async () => {
    witnessOwner = 'tenant-b';
    expect(await updatePatientWalletAction('patient-1', 60)).toMatchObject({
      success: false, error: 'Legacy patient ownership needs independent tenant verification',
    });
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();

    witnessOwner = 'tenant-a';
    (getLocalSession as jest.Mock).mockResolvedValue({ id: 'admin', role: 'owner', pharmacy_id: 'local_default' });
    expect(await updatePatientWalletAction('patient-1', 60)).toMatchObject({
      success: false, error: 'Legacy patient ownership needs independent tenant verification',
    });
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(dbExecute).not.toHaveBeenCalled();
  });
});
