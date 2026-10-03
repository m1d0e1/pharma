/** @jest-environment node */

import Database from 'better-sqlite3';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let sessionQueue: any[];
let beforeTransaction: (() => Promise<void>) | null = null;

jest.mock('@/lib/auth/local', () => ({
  ...jest.requireActual('@/lib/auth/local'),
  getLocalSession: jest.fn(async () => sessionQueue.shift() ?? null),
  hasUserPermissionSync: jest.fn(() => true),
  verifyPassword: jest.fn(async () => true),
  hashPassword: jest.fn(async () => 'test-password-hash'),
}));

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => {
    if (beforeTransaction) {
      const interleave = beforeTransaction;
      beforeTransaction = null;
      await interleave();
    }
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
  generateId: jest.fn(() => 'generated-id'),
}));

jest.mock('@/app/actions-client/shifts', () => ({
  getShiftForPharmacy: jest.fn(async () => ({ id: 'shift-owner-b' })),
  ensurePermanentShiftForUser: jest.fn(),
}));

jest.mock('@/lib/finance/drawer', () => ({
  loadHandoverDetails: jest.fn(async () => ({
    status: 'open',
    user_id: 'owner-b',
    expected_cash: 0,
  })),
}));

import { processHandoverAction } from '@/app/actions-client/handover';
import { updateUserAction } from '@/app/actions-client/users';

describe('staff handover last-owner concurrency', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT,
        full_name TEXT,
        role TEXT,
        pharmacy_id TEXT,
        is_active INTEGER DEFAULT 1,
        password_hash TEXT,
        permissions TEXT,
        job_id INTEGER,
        qualification TEXT,
        hire_date TEXT,
        shift TEXT,
        code TEXT
      );
      CREATE TABLE shifts (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        pharmacy_id TEXT,
        status TEXT,
        end_time TEXT,
        ending_cash REAL,
        actual_cash REAL,
        transfer_amount REAL,
        transfer_target TEXT,
        treasury_retained_cash REAL,
        cash_difference REAL,
        receiver_id TEXT,
        notes TEXT
      );
      CREATE TABLE trial_balance_settings (category TEXT PRIMARY KEY, account_id INTEGER);
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT, name_ar TEXT, type TEXT, is_group INTEGER);
      CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT);

      INSERT INTO users (id, username, full_name, role, pharmacy_id, is_active, password_hash) VALUES
        ('owner-a', 'owner-a', 'Owner A', 'owner', 'ph-1', 1, 'hash-a'),
        ('owner-b', 'owner-b', 'Owner B', 'owner', 'ph-1', 1, 'hash-b');
      INSERT INTO shifts (id, user_id, pharmacy_id, status) VALUES
        ('shift-owner-b', 'owner-b', 'ph-1', 'open');
      INSERT INTO trial_balance_settings (category, account_id) VALUES
        ('cash_drawer', 6), ('bank_clearing', 7), ('cash_difference', 8);
      INSERT INTO accounts (id, code, name_ar, type, is_group) VALUES
        (6, '1.1.1', 'Cash', 'asset', 0),
        (7, '1.1.4', 'Bank', 'asset', 0),
        (8, '4.3', 'Cash Difference', 'expense', 0);
    `);
    sessionQueue = [
      { id: 'owner-a', role: 'owner', pharmacy_id: 'ph-1' },
      { id: 'owner-a', role: 'owner', pharmacy_id: 'ph-1' },
    ];
    beforeTransaction = null;
  });

  afterEach(() => mockDb.close());

  it('rechecks the last-owner invariant when a managed-shift closure races with owner demotion', async () => {
    beforeTransaction = async () => {
      const demotion = await updateUserAction('owner-a', {
        username: 'owner-a',
        full_name: 'Owner A',
        role: 'admin',
      });
      expect(demotion.success).toBe(true);
    };

    const result = await processHandoverAction({
      shiftId: 'shift-owner-b',
      actualCash: 0,
      transferAmount: 0,
      transferTargetId: '',
      transferTargetType: 'treasury',
      receiverUsername: '',
      receiverPasswordHash: '',
      closeOnly: true,
      managedUserId: 'owner-b',
      deactivateManagedUser: true,
      authorizerPassword: 'secret',
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('لا يمكن تعطيل المالك الوحيد'),
    });
    expect((mockDb.prepare(`
      SELECT COUNT(*) AS count
      FROM users
      WHERE role = 'owner' AND is_active = 1 AND pharmacy_id = 'ph-1'
    `).get() as { count: number }).count).toBe(1);
    expect(mockDb.prepare("SELECT is_active FROM users WHERE id = 'owner-b'").get()).toEqual({ is_active: 1 });
  });
});
