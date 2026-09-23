import Database from 'better-sqlite3';

let mockDb: Database.Database;
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
  generateId: jest.fn(() => `wave2-fin-${++idCounter}`),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({
    id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1', permissions: {},
  })),
  hasUserPermissionSync: jest.fn((user: any) => user?.role === 'owner'),
}));

jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(async () => ({ id: 'shift-1' })),
  getShiftForPharmacy: jest.fn(async (shiftId: string) => shiftId === 'shift-1' ? { id: 'shift-1' } : null),
}));

import { createCashMovementAction, createManualJournalAction } from '@/app/actions-client/finance';

describe('wave 2 finance transaction rollback', () => {
  beforeEach(() => {
    idCounter = 0;
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, pharmacy_id TEXT);
      CREATE TABLE cash_movements (
        id TEXT PRIMARY KEY, user_id TEXT, shift_id TEXT, type TEXT,
        category TEXT, sub_category TEXT, amount REAL, source_type TEXT,
        target_name TEXT, notes TEXT, date TEXT, actual_date TEXT
      );
      CREATE TABLE daily_journals (
        id TEXT PRIMARY KEY, date TEXT, description TEXT,
        created_by TEXT, total_amount REAL
      );
      CREATE TABLE journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id TEXT,
        account_id INTEGER, type TEXT, amount REAL, notes TEXT
      );
      CREATE TABLE trial_balance_settings (
        category TEXT, account_id INTEGER, target_name TEXT, target_type TEXT
      );
      CREATE TABLE expense_definitions (id INTEGER PRIMARY KEY, code TEXT, name_ar TEXT, name_en TEXT);
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, is_group INTEGER DEFAULT 0);
      CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT);

      INSERT INTO users VALUES ('owner-1', 'ph-1');
      INSERT INTO accounts VALUES (6, 0), (11, 0);
      INSERT INTO trial_balance_settings (category, account_id) VALUES ('cash_drawer', 6), ('collection', 11);
    `);
  });

  afterEach(() => mockDb.close());

  it('rolls back the cash movement and journal header when journal entry posting fails', async () => {
    mockDb.exec(`
      CREATE TRIGGER fail_cash_journal_entry
      BEFORE INSERT ON journal_entries
      BEGIN
        SELECT RAISE(ABORT, 'injected cash journal failure');
      END;
    `);

    expect(await createCashMovementAction({
      type: 'receipt', category: 'collection', amount: 25,
      date: '2026-09-21', shift_id: 'shift-1',
    })).toMatchObject({ success: false });

    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM cash_movements').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM journal_entries').get()).toEqual({ count: 0 });
  });

  it('rejects an unbalanced manual journal and rolls back its header if entry posting fails', async () => {
    expect(await createManualJournalAction({
      date: '2026-09-21',
      description: 'unbalanced',
      entries: [
        { account_id: 6, type: 'debit', amount: 10 },
        { account_id: 11, type: 'credit', amount: 9 },
      ],
    })).toMatchObject({ success: false, error: expect.stringContaining('القيد غير متزن') });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });

    mockDb.exec(`
      CREATE TRIGGER fail_manual_journal_entry
      BEFORE INSERT ON journal_entries
      BEGIN
        SELECT RAISE(ABORT, 'injected manual journal failure');
      END;
    `);

    expect(await createManualJournalAction({
      date: '2026-09-21',
      description: 'balanced but failing',
      entries: [
        { account_id: 6, type: 'debit', amount: 10 },
        { account_id: 11, type: 'credit', amount: 10 },
      ],
    })).toMatchObject({ success: false });

    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM journal_entries').get()).toEqual({ count: 0 });
  });
});
