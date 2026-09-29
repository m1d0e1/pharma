import Database from 'better-sqlite3';

let mockDb: Database.Database;
let mockSession: any;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(),
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
    mockSession = { id: 'cashier-1', role: 'cashier', permissions: { can_access_pos: true } };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE patients (
        id TEXT PRIMARY KEY,
        full_name TEXT,
        points_balance REAL DEFAULT 0
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
});
