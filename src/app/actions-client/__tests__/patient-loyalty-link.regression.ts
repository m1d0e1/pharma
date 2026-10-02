import Database from 'better-sqlite3';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let mockSession: any;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => {
    mockDb.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback(mockCreateSqliteTransactionDb(mockDb));
      mockDb.exec('COMMIT');
      return result;
    } catch (error) {
      mockDb.exec('ROLLBACK');
      throw error;
    }
  }),
  generateId: jest.fn(() => 'patient-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, key: string) => user?.role === 'owner' || user?.permissions?.[key] === true),
}));

const { addPatientAction, getPatientForPosAction, searchPatientsAction, updatePatientAction } = jest.requireActual(
  '@/app/actions-client/patients'
) as typeof import('@/app/actions-client/patients');

describe('patient profile and loyalty linkage', () => {
  beforeEach(() => {
    mockSession = { id: 'owner-1', role: 'owner', pharmacy_id: 'local_default' };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE patients (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        name_en TEXT,
        phone TEXT,
        mobile TEXT,
        address TEXT,
        area TEXT,
        birth_date TEXT,
        gender TEXT,
        insurance_number TEXT,
        car_number TEXT,
        credit_limit REAL DEFAULT 0,
        wallet_balance REAL DEFAULT 0,
        opening_balance REAL DEFAULT 0,
        points_balance REAL DEFAULT 0,
        point_value REAL DEFAULT 1,
        customer_type TEXT DEFAULT 'individual',
        payment_method TEXT DEFAULT 'cash',
        notes TEXT
      );
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY,
        patient_id TEXT,
        total_amount REAL DEFAULT 0,
        payment_method TEXT,
        status TEXT
      );
      CREATE TABLE returns (
        id TEXT PRIMARY KEY,
        invoice_id TEXT,
        total_refund REAL DEFAULT 0,
        refund_method TEXT,
        status TEXT
      );
      CREATE TABLE patient_transactions (
        patient_id TEXT,
        type TEXT,
        amount REAL DEFAULT 0,
        date TEXT,
        user_id TEXT,
        notes TEXT
      );
      CREATE TABLE financial_notices (
        target_type TEXT,
        target_id TEXT,
        type TEXT,
        amount REAL DEFAULT 0,
        date TEXT,
        user_id TEXT,
        reason TEXT
      );
      INSERT INTO patients (id, full_name, phone, opening_balance, points_balance, point_value)
      VALUES ('patient-1', 'Original Patient', '01012345678', 0, 100, 1);
      INSERT INTO patients (
        id, full_name, phone, credit_limit, opening_balance, points_balance, point_value
      ) VALUES (
        'pos-patient', 'POS Loyalty Patient', '01099999999', 500, 385, 180, 1
      );
    `);
  });

  afterEach(() => mockDb.close());

  it('returns loyalty points in POS patient search results', async () => {
    const result = await searchPatientsAction('POS Loyalty');

    expect(result).toMatchObject({
      success: true,
      data: [{
        id: 'pos-patient',
        credit_limit: 500,
        outstanding_balance: 385,
        points_balance: 180,
      }],
    });
    expect(Number(result.data?.[0]?.credit_limit || 0) - Number(result.data?.[0]?.outstanding_balance || 0)).toBe(115);

    const fetchAll = await searchPatientsAction('', true);
    expect(fetchAll.success).toBe(true);
    expect(fetchAll.data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pos-patient', points_balance: 180 }),
    ]));
  });

  it('refreshes checkout-safe patient data for a POS-only role without granting profile access', async () => {
    mockSession = { id: 'cashier-1', role: 'cashier', pharmacy_id: 'local_default', permissions: { can_access_pos: true } };

    expect(await getPatientForPosAction('pos-patient')).toMatchObject({
      success: true,
      data: {
        id: 'pos-patient',
        credit_limit: 500,
        outstanding_balance: 385,
        points_balance: 180,
      },
    });

    mockSession.permissions = { can_access_pos: false, can_view_patients: false };
    expect(await getPatientForPosAction('pos-patient')).toEqual({ success: false, error: 'Unauthorized' });
  });

  it('does not overwrite loyalty points earned after the profile was loaded', async () => {
    const staleProfilePayload = {
      full_name: 'Renamed Patient',
      name_en: '',
      phone: '01012345678',
      mobile: '',
      address: '',
      area: '',
      birth_date: null,
      gender: 'male' as const,
      insurance_number: null,
      car_number: null,
      credit_limit: 0,
      opening_balance: 0,
      points_balance: 100,
      point_value: 1,
      customer_type: 'individual',
      payment_method: 'cash',
      notes: '',
    };

    // POS completes a sale after the profile loaded and awards 40 new points.
    mockDb.prepare("UPDATE patients SET points_balance = 140 WHERE id = 'patient-1'").run();

    expect(await updatePatientAction('patient-1', staleProfilePayload)).toMatchObject({ success: true });
    expect(mockDb.prepare("SELECT full_name, points_balance FROM patients WHERE id = 'patient-1'").get()).toEqual({
      full_name: 'Renamed Patient',
      points_balance: 140,
    });
  });

  it('allows patient metadata edits while a system-owned loyalty debt is negative', async () => {
    mockDb.prepare("UPDATE patients SET points_balance = -25 WHERE id = 'patient-1'").run();
    const debtProfilePayload = {
      full_name: 'Debt Patient Renamed',
      name_en: '',
      phone: '01012345678',
      mobile: '',
      address: '',
      area: '',
      birth_date: null,
      gender: 'male' as const,
      insurance_number: null,
      car_number: null,
      credit_limit: 0,
      opening_balance: 0,
      points_balance: -25,
      point_value: 1,
      customer_type: 'individual',
      payment_method: 'cash',
      notes: '',
    };

    expect(await updatePatientAction('patient-1', debtProfilePayload)).toMatchObject({ success: true });
    expect(mockDb.prepare("SELECT full_name, points_balance FROM patients WHERE id = 'patient-1'").get()).toEqual({
      full_name: 'Debt Patient Renamed',
      points_balance: -25,
    });
  });

  it('does not trust caller-supplied loyalty points when creating a patient', async () => {
    expect(await addPatientAction({
      full_name: 'New Patient',
      name_en: '',
      phone: '01022222222',
      mobile: '',
      address: '',
      area: '',
      birth_date: null,
      gender: 'male',
      insurance_number: null,
      car_number: null,
      credit_limit: 0,
      opening_balance: 0,
      points_balance: 500,
      point_value: 1,
      customer_type: 'individual',
      payment_method: 'cash',
      notes: '',
    })).toMatchObject({ success: true });

    expect(mockDb.prepare("SELECT points_balance FROM patients WHERE id = 'patient-id'").get()).toEqual({
      points_balance: 0,
    });
  });
});
