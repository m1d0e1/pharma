import Database from 'better-sqlite3';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let idCounter = 0;
let beforeTransactionHook: (() => void) | null = null;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => {
    if (mockDb.inTransaction) return callback(mockCreateSqliteTransactionDb(mockDb));
    const hook = beforeTransactionHook;
    beforeTransactionHook = null;
    hook?.();
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

import { addBankAction, addFinancialNoticeAction, addPaperAction, createCashMovementAction, createManualJournalAction, updatePaperStatusAction } from '@/app/actions-client/finance';

describe('wave 2 finance transaction rollback', () => {
  beforeEach(() => {
    idCounter = 0;
    beforeTransactionHook = null;
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
        created_by TEXT, total_amount REAL, pharmacy_id TEXT
      );
      CREATE TABLE journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id TEXT,
        account_id INTEGER, type TEXT, amount REAL, notes TEXT
      );
      CREATE TABLE trial_balance_settings (
        category TEXT, account_id INTEGER, target_name TEXT, target_type TEXT
      );
      CREATE TABLE expense_definitions (id INTEGER PRIMARY KEY, code TEXT, name_ar TEXT, name_en TEXT);
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, code TEXT, is_group INTEGER DEFAULT 0);
      CREATE TABLE banks (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT, name_en TEXT, account_number TEXT, branch TEXT, current_balance REAL DEFAULT 0);
      CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name_ar TEXT, balance REAL DEFAULT 0);
      CREATE TABLE supplier_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, supplier_id INTEGER, user_id TEXT,
        type TEXT, amount REAL, notes TEXT, date TEXT
      );
      CREATE TABLE financial_notices (
        id TEXT PRIMARY KEY, user_id TEXT, target_type TEXT, target_id TEXT,
        type TEXT, amount REAL, reason TEXT, notes TEXT, date TEXT
      );
      CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT);
      CREATE TABLE commercial_papers (
        id TEXT PRIMARY KEY, type TEXT, direction TEXT, paper_number TEXT,
        bank_id INTEGER, amount REAL, due_date TEXT, status TEXT,
        target_name TEXT, notes TEXT, pharmacy_id TEXT
      );

      INSERT INTO users VALUES ('owner-1', 'ph-1');
      INSERT INTO accounts VALUES (6, '1.1.1', 0), (7, '2.1', 0), (11, '4.1', 0), (12, '1.1.4', 0), (14, '4.2', 0), (15, '3.9', 0);
      INSERT INTO trial_balance_settings (category, account_id) VALUES
        ('cash_drawer', 6), ('accounts_payable', 7), ('collection', 11),
        ('bank_clearing', 12), ('customer_adjustments', 14), ('opening_balance_equity', 15);
      INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Rollback Supplier',100);
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

  it('fails closed instead of posting an unmapped operating expense to COGS', async () => {
    mockDb.prepare("INSERT INTO expense_definitions(id, code, name_ar) VALUES(1, 'rent', 'إيجار')").run();

    expect(await createCashMovementAction({
      type: 'disbursement', category: 'operating_expenses', sub_category: 'rent', amount: 25,
      date: '2026-09-21', shift_id: 'shift-1',
    })).toMatchObject({ success: false });

    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM cash_movements').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
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

  it('rejects non-finite amounts and invalid entry types before manual-journal persistence', async () => {
    expect(await createManualJournalAction({
      date: '2026-09-21', description: 'infinite', entries: [
        { account_id: 6, type: 'debit', amount: Number.POSITIVE_INFINITY },
        { account_id: 11, type: 'credit', amount: Number.POSITIVE_INFINITY },
      ],
    })).toMatchObject({ success: false });

    expect(await createManualJournalAction({
      date: '2026-09-21', description: 'invalid type', entries: [
        { account_id: 6, type: 'debit', amount: 10 },
        { account_id: 11, type: 'sideways' as any, amount: 10 },
      ],
    })).toMatchObject({ success: false });

    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
  });

  it('rejects non-finite commercial-paper amounts before persistence', async () => {
    expect(await addPaperAction({
      type: 'check', direction: 'in', paper_number: 'INF-1', amount: Number.POSITIVE_INFINITY,
      due_date: '2026-09-27', target_name: 'Invalid paper',
    })).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM commercial_papers').get()).toEqual({ count: 0 });
  });

  it('does not cash a paper twice when its status changes after the initial read', async () => {
    mockDb.prepare(`
      INSERT INTO commercial_papers
        (id,type,direction,paper_number,amount,due_date,status,target_name,pharmacy_id)
      VALUES ('paper-race','check','in','RACE-1',10,'2026-09-27','pending','Race Paper','ph-1')
    `).run();
    beforeTransactionHook = () => {
      mockDb.prepare("UPDATE commercial_papers SET status='cashed' WHERE id='paper-race'").run();
    };

    expect(await updatePaperStatusAction('paper-race', 'cashed', '2026-09-27')).toMatchObject({ success: true });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM cash_movements').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
  });

  it('rejects a stale paper transition when another caller moved it to a different status', async () => {
    mockDb.prepare(`
      INSERT INTO commercial_papers
        (id,type,direction,paper_number,amount,due_date,status,target_name,pharmacy_id)
      VALUES ('paper-conflict','check','in','RACE-2',10,'2026-09-27','pending','Race Paper','ph-1')
    `).run();
    beforeTransactionHook = () => {
      mockDb.prepare("UPDATE commercial_papers SET status='bounced' WHERE id='paper-conflict'").run();
    };

    expect(await updatePaperStatusAction('paper-conflict', 'cashed', '2026-09-27')).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM cash_movements').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
  });

  it('rolls back a bank master row when opening-balance posting fails', async () => {
    mockDb.exec(`
      CREATE TRIGGER fail_bank_opening_entry
      BEFORE INSERT ON journal_entries
      BEGIN SELECT RAISE(ABORT, 'injected bank opening failure'); END;
    `);

    expect(await addBankAction({ name_ar: 'Rollback Bank', current_balance: 50 })).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM banks').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
  });

  it('rolls back the whole supplier notice when its subledger insert fails', async () => {
    mockDb.exec(`
      CREATE TRIGGER fail_supplier_notice_tx
      BEFORE INSERT ON supplier_transactions
      BEGIN SELECT RAISE(ABORT, 'injected supplier notice failure'); END;
    `);

    expect(await addFinancialNoticeAction({
      target_type: 'supplier', target_id: '1', type: 'credit', amount: 12.34,
      reason: 'atomic supplier notice', date: '2026-09-27',
    })).toMatchObject({ success: false });

    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM financial_notices').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT balance FROM suppliers WHERE id = 1').get()).toEqual({ balance: 100 });
  });

  it('resolves supplier-notice fallback accounts by canonical code, not legacy row ids', async () => {
    mockDb.exec(`
      DELETE FROM trial_balance_settings WHERE category IN ('accounts_payable', 'customer_adjustments');
      UPDATE accounts SET id = 107 WHERE code = '2.1';
      UPDATE accounts SET id = 114 WHERE code = '4.2';
    `);

    expect(await addFinancialNoticeAction({
      target_type: 'supplier', target_id: '1', type: 'debit', amount: 5,
      reason: 'canonical fallback', date: '2026-09-27',
    })).toMatchObject({ success: true });

    expect(mockDb.prepare('SELECT account_id, type, amount FROM journal_entries ORDER BY id').all()).toEqual([
      { account_id: 107, type: 'credit', amount: 5 },
      { account_id: 114, type: 'debit', amount: 5 },
    ]);
  });

  it('posts supplier notices in the same direction as the accounts-payable liability balance', async () => {
    expect(await addFinancialNoticeAction({
      target_type: 'supplier', target_id: '1', type: 'debit', amount: 5,
      reason: 'supplier liability increase', date: '2026-09-27',
    })).toMatchObject({ success: true });

    expect(mockDb.prepare('SELECT balance FROM suppliers WHERE id = 1').get()).toEqual({ balance: 105 });
    expect(mockDb.prepare(`
      SELECT a.code, je.type, je.amount
      FROM journal_entries je
      JOIN accounts a ON a.id = je.account_id
      ORDER BY je.id
    `).all()).toEqual([
      { code: '2.1', type: 'credit', amount: 5 },
      { code: '4.2', type: 'debit', amount: 5 },
    ]);
  });
});
