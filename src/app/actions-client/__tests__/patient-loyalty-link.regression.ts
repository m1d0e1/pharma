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

const { updatePatientAction } = jest.requireActual(
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
        opening_balance REAL DEFAULT 0,
        points_balance REAL DEFAULT 0,
        point_value REAL DEFAULT 1,
        customer_type TEXT DEFAULT 'individual',
        payment_method TEXT DEFAULT 'cash',
        notes TEXT
      );
      INSERT INTO patients (id, full_name, phone, opening_balance, points_balance, point_value)
      VALUES ('patient-1', 'Original Patient', '01012345678', 0, 100, 1);
    `);
  });

  afterEach(() => mockDb.close());

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
});
