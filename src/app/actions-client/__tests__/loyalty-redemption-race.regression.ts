import Database from 'better-sqlite3';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let mockSession: any;
let transactionQueue: Promise<void> = Promise.resolve();

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn((callback: any) => {
    const run = async () => {
      mockDb.exec('BEGIN IMMEDIATE');
      try {
        const result = await callback(mockCreateSqliteTransactionDb(mockDb));
        mockDb.exec('COMMIT');
        return result;
      } catch (error) {
        mockDb.exec('ROLLBACK');
        throw error;
      }
    };
    const pending = transactionQueue.then(run, run);
    transactionQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, permission: string) =>
    Boolean(user?.permissions?.[permission])
  ),
}));

import { awardLoyaltyPointsAction, getPatientLoyaltyAction, redeemLoyaltyPointsAction } from '@/app/actions-client/loyalty';

describe('loyalty redemption concurrency', () => {
  beforeEach(() => {
    transactionQueue = Promise.resolve();
    mockSession = { id: 'cashier-1', role: 'cashier', pharmacy_id: 'local_default', permissions: { can_access_pos: true } };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE patients (
        id TEXT PRIMARY KEY,
        full_name TEXT,
        points_balance REAL DEFAULT 0,
        loyalty_level TEXT DEFAULT 'bronze'
      );
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY,
        patient_id TEXT,
        pharmacy_id TEXT,
        total_amount REAL,
        status TEXT,
        points_earned REAL DEFAULT 0
      );
      CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT);
      INSERT INTO patients (id, full_name, points_balance)
      VALUES ('patient-1', 'Concurrent Patient', 150);
    `);
  });

  afterEach(() => mockDb.close());

  it('allows only one concurrent 100-point redemption from a 150-point balance', async () => {
    const [first, second] = await Promise.all([
      redeemLoyaltyPointsAction('patient-1', 100),
      redeemLoyaltyPointsAction('patient-1', 100),
    ]);

    expect([first.success, second.success].filter(Boolean)).toHaveLength(1);
    expect(mockDb.prepare("SELECT points_balance FROM patients WHERE id = 'patient-1'").get()).toEqual({
      points_balance: 50,
    });
  });

  it('denies loyalty reads and mutations when patient/POS permissions are explicitly absent', async () => {
    mockSession = {
      id: 'restricted-1',
      role: 'pharmacist',
      permissions: { can_access_pos: false, can_view_patients: false },
    };

    expect(await getPatientLoyaltyAction('patient-1')).toMatchObject({ success: false });
    expect(await awardLoyaltyPointsAction('patient-1', 50, 'invoice-1')).toMatchObject({ success: false });
    expect(await redeemLoyaltyPointsAction('patient-1', 100)).toMatchObject({ success: false });
    expect(mockDb.prepare("SELECT points_balance FROM patients WHERE id = 'patient-1'").get()).toEqual({
      points_balance: 150,
    });
  });

  it('does not report awarded points when the target patient no longer exists', async () => {
    expect(await awardLoyaltyPointsAction('missing-patient', 50, 'invoice-2')).toMatchObject({
      success: false,
    });
  });

  it('derives awards from the finalized invoice and does not award the same invoice twice', async () => {
    mockDb.prepare(`
      INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, status, points_earned)
      VALUES ('invoice-1', 'patient-1', 'local_default', 50, 'completed', 0)
    `).run();

    expect(await awardLoyaltyPointsAction('patient-1', 9999, 'invoice-1')).toMatchObject({
      success: true,
      pointsEarned: 50,
    });
    expect(mockDb.prepare("SELECT points_balance FROM patients WHERE id = 'patient-1'").get()).toEqual({
      points_balance: 200,
    });
    expect(mockDb.prepare("SELECT points_earned FROM sales_invoices WHERE id = 'invoice-1'").get()).toEqual({
      points_earned: 50,
    });

    expect(await awardLoyaltyPointsAction('patient-1', 9999, 'invoice-1')).toMatchObject({ success: true });
    expect(mockDb.prepare("SELECT points_balance FROM patients WHERE id = 'patient-1'").get()).toEqual({
      points_balance: 200,
    });
  });

  it('uses the canonical tier multiplier when the legacy award helper is invoked', async () => {
    mockDb.prepare("UPDATE patients SET loyalty_level = 'gold' WHERE id = 'patient-1'").run();
    mockDb.prepare(`
      INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, status, points_earned)
      VALUES ('gold-invoice', 'patient-1', 'local_default', 50, 'completed', 0)
    `).run();

    expect(await awardLoyaltyPointsAction('patient-1', 50, 'gold-invoice')).toMatchObject({
      success: true,
      pointsEarned: 75,
    });
    expect(mockDb.prepare("SELECT points_balance FROM patients WHERE id = 'patient-1'").get()).toEqual({
      points_balance: 225,
    });
  });

  it('does not award points from an invoice owned by another pharmacy', async () => {
    mockDb.prepare(`
      INSERT INTO sales_invoices (id, patient_id, pharmacy_id, total_amount, status, points_earned)
      VALUES ('foreign-invoice', 'patient-1', 'ph-foreign', 75, 'completed', 0)
    `).run();

    expect(await awardLoyaltyPointsAction('patient-1', 75, 'foreign-invoice')).toMatchObject({ success: false });
    expect(mockDb.prepare("SELECT points_balance FROM patients WHERE id = 'patient-1'").get()).toEqual({
      points_balance: 150,
    });
    expect(mockDb.prepare("SELECT points_earned FROM sales_invoices WHERE id = 'foreign-invoice'").get()).toEqual({
      points_earned: 0,
    });
  });

  it('rejects non-finite loyalty redemption values without changing the balance', async () => {
    expect(await redeemLoyaltyPointsAction('patient-1', Number.NaN)).toMatchObject({ success: false });
    expect(mockDb.prepare("SELECT points_balance FROM patients WHERE id = 'patient-1'").get()).toEqual({
      points_balance: 150,
    });
  });

  it('rolls back point redemption when its audit record cannot be written', async () => {
    mockDb.exec(`
      CREATE TRIGGER fail_redeem_audit
      BEFORE INSERT ON activity_log
      WHEN NEW.action = 'REDEEM_POINTS'
      BEGIN
        SELECT RAISE(ABORT, 'redeem audit blocked');
      END;
    `);

    expect(await redeemLoyaltyPointsAction('patient-1', 100)).toMatchObject({ success: false });
    expect(mockDb.prepare("SELECT points_balance FROM patients WHERE id = 'patient-1'").get()).toEqual({
      points_balance: 150,
    });
  });
});
