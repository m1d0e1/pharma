import Database from 'better-sqlite3';

let mockDb: Database.Database;
let mockSession: any;
let idCounter = 0;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => Promise<unknown>) => {
    mockDb.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback();
      mockDb.exec('COMMIT');
      return result;
    } catch (error) {
      mockDb.exec('ROLLBACK');
      throw error;
    }
  }),
  generateId: jest.fn(() => `patient-payment-${++idCounter}`),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.role === 'owner' || user?.permissions?.[key] === true),
}));

jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(async () => ({ id: 'shift-1' })),
  getShiftForPharmacy: jest.fn(async (shiftId: string) => shiftId === 'shift-1' ? { id: 'shift-1' } : null),
}));

import { addPatientPaymentAction } from '@/app/actions-client/finance';

describe('patient payment action', () => {
  beforeEach(() => {
    idCounter = 0;
    mockSession = {
      id: 'pharmacist-1',
      role: 'pharmacist',
      pharmacy_id: 'ph-1',
      permissions: { can_view_patients: true, acc_can_process_cash_flow: true },
    };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, pharmacy_id TEXT);
      CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT, opening_balance REAL DEFAULT 0);
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY, patient_id TEXT, total_amount REAL,
        payment_method TEXT, status TEXT
      );
      CREATE TABLE returns (
        id TEXT PRIMARY KEY, invoice_id TEXT, total_refund REAL,
        refund_method TEXT, status TEXT
      );
      CREATE TABLE patient_transactions (
        id TEXT PRIMARY KEY, patient_id TEXT, user_id TEXT, type TEXT,
        amount REAL, payment_method TEXT, notes TEXT, date TEXT
      );
      CREATE TABLE financial_notices (
        id TEXT PRIMARY KEY, user_id TEXT, target_type TEXT, target_id TEXT,
        type TEXT, amount REAL, reason TEXT, date TEXT
      );
      CREATE TABLE cash_movements (
        id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT, type TEXT,
        category TEXT, amount REAL, source_type TEXT, target_name TEXT,
        notes TEXT, date TEXT
      );
      CREATE TABLE trial_balance_settings (category TEXT PRIMARY KEY, account_id INTEGER);
      CREATE TABLE daily_journals (
        id TEXT PRIMARY KEY, date TEXT, description TEXT,
        created_by TEXT, total_amount REAL
      );
      CREATE TABLE journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id TEXT,
        account_id INTEGER, type TEXT, amount REAL
      );
      CREATE TABLE activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT,
        action TEXT, details TEXT
      );

      INSERT INTO users VALUES ('pharmacist-1', 'ph-1');
      INSERT INTO patients VALUES ('patient-1', 'Patient One', 100);
      INSERT INTO sales_invoices VALUES ('credit-sale', 'patient-1', 50, 'credit', 'completed');
      INSERT INTO trial_balance_settings VALUES ('cash_drawer', 6), ('accounts_receivable', 8);
    `);
  });

  afterEach(() => mockDb.close());

  it('records a permitted cash payment in the patient ledger, drawer, and accounting journal', async () => {
    const result = await addPatientPaymentAction({
      patient_id: 'patient-1',
      shift_id: 'shift-1',
      amount: 40,
      payment_method: 'cash',
      notes: 'partial settlement',
      date: '2026-09-21',
    });

    expect(result).toMatchObject({ success: true, remainingBalance: 110 });
    expect(mockDb.prepare('SELECT type, amount, payment_method FROM patient_transactions').get()).toEqual({
      type: 'payment', amount: 40, payment_method: 'cash',
    });
    expect(mockDb.prepare('SELECT shift_id, type, category, amount FROM cash_movements').get()).toEqual({
      shift_id: 'shift-1', type: 'receipt', category: 'accounts_receivable', amount: 40,
    });
    expect(mockDb.prepare('SELECT account_id, type, amount FROM journal_entries ORDER BY id').all()).toEqual([
      { account_id: 6, type: 'debit', amount: 40 },
      { account_id: 8, type: 'credit', amount: 40 },
    ]);
  });

  it('rejects overpayment and denied cash-flow permission without writing financial history', async () => {
    expect(await addPatientPaymentAction({
      patient_id: 'patient-1', shift_id: 'shift-1', amount: 151,
      payment_method: 'cash', date: '2026-09-21',
    })).toMatchObject({ success: false });

    mockSession.permissions.acc_can_process_cash_flow = false;
    expect(await addPatientPaymentAction({
      patient_id: 'patient-1', shift_id: 'shift-1', amount: 10,
      payment_method: 'cash', date: '2026-09-21',
    })).toEqual({ success: false, error: 'غير مصرح' });

    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM patient_transactions').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM cash_movements').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
  });

  it('rolls back the ledger and cash receipt if journal posting fails', async () => {
    mockDb.exec(`
      CREATE TRIGGER fail_patient_payment_journal
      BEFORE INSERT ON journal_entries
      BEGIN
        SELECT RAISE(ABORT, 'injected journal failure');
      END;
    `);

    expect(await addPatientPaymentAction({
      patient_id: 'patient-1', shift_id: 'shift-1', amount: 10,
      payment_method: 'cash', date: '2026-09-21',
    })).toMatchObject({ success: false });

    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM patient_transactions').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM cash_movements').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
  });
});
