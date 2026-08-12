import Database from 'better-sqlite3';

let sqlite: Database.Database;
let inTransaction = false;
let linkageCheckedInTransaction = false;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/linked_count[\s\S]*FROM patients p/.test(sql)) {
      linkageCheckedInTransaction = inTransaction;
    }
    return sqlite.prepare(sql).all(...params);
  }),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/linked_count[\s\S]*FROM patients p/.test(sql)) {
      linkageCheckedInTransaction = inTransaction;
    }
    return sqlite.prepare(sql).get(...params) ?? null;
  }),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => Promise<unknown>) => {
    sqlite.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      const result = await callback();
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    } finally {
      inTransaction = false;
    }
  }),
  generateId: jest.fn(() => 'test-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'owner' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: {} }));

jest.unmock('@/app/actions-client/patients');

import { deletePatientAction } from '@/app/actions-client/patients';
import { getLocalSession } from '@/lib/auth/local';

const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (id TEXT PRIMARY KEY);
  CREATE TABLE master_drugs (id INTEGER PRIMARY KEY);
  CREATE TABLE activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    action TEXT,
    details TEXT
  );
  CREATE TABLE patients (
    id TEXT PRIMARY KEY,
    full_name TEXT NOT NULL,
    opening_balance REAL DEFAULT 0,
    wallet_balance REAL DEFAULT 0,
    points_balance REAL DEFAULT 0
  );
  CREATE TABLE sales_invoices (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    patient_id TEXT,
    FOREIGN KEY (patient_id) REFERENCES patients(id)
  );
  CREATE TABLE patient_transactions (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    date TEXT NOT NULL,
    FOREIGN KEY (patient_id) REFERENCES patients(id)
  );
  CREATE TABLE refill_reminders (
    id TEXT PRIMARY KEY,
    patient_id TEXT,
    drug_id INTEGER,
    FOREIGN KEY (patient_id) REFERENCES patients(id)
  );
  CREATE TABLE patient_allergies (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL,
    allergen TEXT NOT NULL,
    FOREIGN KEY (patient_id) REFERENCES patients(id)
  );
  CREATE TABLE patient_conditions (
    id INTEGER PRIMARY KEY,
    patient_id TEXT NOT NULL,
    condition_name TEXT NOT NULL,
    FOREIGN KEY (patient_id) REFERENCES patients(id)
  );
  CREATE TABLE financial_notices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT,
    type TEXT NOT NULL,
    amount REAL NOT NULL,
    date TEXT NOT NULL
  );
  CREATE TABLE cash_movements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    source_type TEXT,
    target_name TEXT,
    date TEXT NOT NULL
  );
`;

function addPatient(id: string, openingBalance = 0, walletBalance = 0) {
  sqlite.prepare(
    'INSERT INTO patients (id, full_name, opening_balance, wallet_balance) VALUES (?, ?, ?, ?)',
  ).run(id, `Patient ${id}`, openingBalance, walletBalance);
}

describe('patient deletion integrity', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(schema);
    sqlite.prepare("INSERT INTO users (id) VALUES ('admin')").run();
    linkageCheckedInTransaction = false;
  });

  afterEach(() => sqlite.close());

  it('atomically deletes an unlinked patient and only their owned clinical profile', async () => {
    addPatient('free');
    sqlite.prepare("INSERT INTO patient_allergies (patient_id, allergen) VALUES ('free', 'penicillin')").run();
    sqlite.prepare("INSERT INTO patient_conditions (patient_id, condition_name) VALUES ('free', 'asthma')").run();

    await expect(deletePatientAction('free')).resolves.toEqual({ success: true });

    expect(linkageCheckedInTransaction).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM patients WHERE id = 'free'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM patient_allergies WHERE patient_id = 'free'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM patient_conditions WHERE patient_id = 'free'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT action, details FROM activity_log WHERE action = 'PATIENT_DELETED'").get()).toEqual({
      action: 'PATIENT_DELETED',
      details: JSON.stringify({ patient_id: 'free' }),
    });
  });

  it.each([
    ['sale history', (id: string) => sqlite.prepare("INSERT INTO sales_invoices (id, user_id, patient_id) VALUES ('sale', 'admin', ?)").run(id)],
    ['patient transaction', (id: string) => sqlite.prepare("INSERT INTO patient_transactions (id, patient_id, user_id, type, amount, date) VALUES ('tx', ?, 'admin', 'payment', 10, '2026-01-01')").run(id)],
    ['refill history', (id: string) => sqlite.prepare("INSERT INTO refill_reminders (id, patient_id) VALUES ('refill', ?)").run(id)],
    ['financial notice', (id: string) => sqlite.prepare("INSERT INTO financial_notices (id, user_id, target_type, target_id, type, amount, date) VALUES ('notice', 'admin', 'customer', ?, 'debit', 10, '2026-01-01')").run(id)],
    ['wallet cash movement', (id: string) => sqlite.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, source_type, target_name, date) VALUES ('cash', 'admin', 'receipt', 'wallet', 10, 'patient_wallet', ?, '2026-01-01')").run(id)],
  ])('blocks deletion and preserves all data for %s', async (_label, link) => {
    addPatient('linked');
    sqlite.prepare("INSERT INTO patient_allergies (patient_id, allergen) VALUES ('linked', 'aspirin')").run();
    link('linked');

    const result = await deletePatientAction('linked');

    expect(result.success).toBe(false);
    expect(result.error).toContain('مرتبطة');
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM patients WHERE id = 'linked'").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM patient_allergies WHERE patient_id = 'linked'").get()).toEqual({ count: 1 });
  });

  it.each([
    ['opening balance', 25, 0],
    ['wallet balance', 0, 25],
  ])('blocks deletion for a non-zero %s', async (_label, opening, wallet) => {
    addPatient('balance', opening, wallet);

    const result = await deletePatientAction('balance');

    expect(result.success).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM patients WHERE id = 'balance'").get()).toEqual({ count: 1 });
  });

  it('blocks deletion when loyalty points remain', async () => {
    addPatient('points');
    sqlite.prepare("UPDATE patients SET points_balance = 1 WHERE id = 'points'").run();

    const result = await deletePatientAction('points');

    expect(result.success).toBe(false);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM patients WHERE id = 'points'").get()).toEqual({ count: 1 });
  });

  it('returns a stable error for a missing or concurrently removed patient', async () => {
    await expect(deletePatientAction('missing')).resolves.toEqual({
      success: false,
      error: 'المريض غير موجود',
    });
    expect(linkageCheckedInTransaction).toBe(true);
  });

  it('does not let a view-only pharmacist delete patients', async () => {
    addPatient('protected');
    jest.mocked(getLocalSession).mockResolvedValueOnce({ id: 'pharmacist', role: 'pharmacist' } as any);

    const result = await deletePatientAction('protected');

    expect(result.success).toBe(false);
    expect(result.error).toContain('غير مصرح');
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM patients WHERE id = 'protected'").get()).toEqual({ count: 1 });
  });
});
