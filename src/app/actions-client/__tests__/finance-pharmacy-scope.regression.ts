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
  dbTransaction: jest.fn(async (callback: any) => callback(mockCreateSqliteTransactionDb(mockDb))),
  generateId: jest.fn(() => 'test-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/app/actions-client/shifts', () => ({
  ensurePermanentShiftForUser: jest.fn(),
}));

import {
  addBankAction,
  addCardAction,
  addPointOfSaleAction,
  deleteBankAction,
  deleteCardAction,
  deletePointOfSaleAction,
  getActivityLogsAction,
  getBanksAction,
  getCardsAction,
  getCashMovementsAction,
  getFinancialNoticesAction,
  getJournalDetailsAction,
  getJournalsAction,
  getPointsOfSaleAction,
  getTreasuryDashboardAction,
  getTrialBalanceAction,
  generateDailySnapshotAction,
  addPaperAction,
  deletePaperAction,
  getPapersAction,
  updateBankAction,
  updateCardAction,
  updatePointOfSaleAction,
  updatePaperStatusAction,
} from '@/app/actions-client/finance';

describe('finance pharmacy scope', () => {
  beforeEach(() => {
    mockSession = { id: 'u1', role: 'owner', pharmacy_id: 'ph-1' };
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT,
        full_name TEXT,
        pharmacy_id TEXT
      );
      CREATE TABLE shifts (id TEXT PRIMARY KEY, pharmacy_id TEXT, status TEXT);
      CREATE TABLE cash_movements (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        shift_id TEXT,
        pharmacy_id TEXT,
        type TEXT,
        category TEXT,
        amount REAL,
        source_type TEXT,
        target_name TEXT,
        notes TEXT,
        date TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE expenses (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        pharmacy_id TEXT,
        category TEXT,
        amount REAL,
        description TEXT,
        date TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY,
        code TEXT,
        name_ar TEXT,
        name_en TEXT,
        type TEXT,
        parent_id INTEGER,
        is_group INTEGER DEFAULT 0
      );
      CREATE TABLE trial_balance_settings (
        category TEXT PRIMARY KEY,
        account_id INTEGER
      );
      CREATE TABLE daily_journals (
        id TEXT PRIMARY KEY,
        date TEXT,
        description TEXT,
        created_by TEXT,
        pharmacy_id TEXT,
        total_amount REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        journal_id TEXT,
        account_id INTEGER,
        type TEXT,
        amount REAL,
        notes TEXT
      );
      CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT);
      CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT);
      CREATE TABLE financial_notices (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        pharmacy_id TEXT,
        target_type TEXT,
        target_id TEXT,
        type TEXT,
        amount REAL,
        reason TEXT,
        notes TEXT,
        date TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        pharmacy_id TEXT,
        action TEXT,
        details TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY,
        pharmacy_id TEXT,
        total_amount REAL,
        status TEXT,
        created_at TEXT
      );
      CREATE TABLE returns (
        id TEXT PRIMARY KEY,
        invoice_id TEXT,
        user_id TEXT,
        pharmacy_id TEXT,
        total_refund REAL,
        status TEXT,
        created_at TEXT
      );
      CREATE TABLE daily_financial_snapshots (
        date TEXT NOT NULL,
        pharmacy_id TEXT NOT NULL,
        total_sales REAL DEFAULT 0,
        total_returns REAL DEFAULT 0,
        total_cash_movements REAL DEFAULT 0,
        net_profit REAL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (date, pharmacy_id)
      );
      CREATE TABLE commercial_papers (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        direction TEXT NOT NULL,
        paper_number TEXT,
        bank_id INTEGER,
        amount REAL NOT NULL,
        due_date TEXT,
        status TEXT DEFAULT 'pending',
        target_name TEXT,
        notes TEXT,
        pharmacy_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE banks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name_ar TEXT NOT NULL,
        name_en TEXT,
        account_number TEXT,
        branch TEXT,
        current_balance REAL DEFAULT 0,
        pharmacy_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE credit_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name_ar TEXT NOT NULL,
        name_en TEXT,
        bank_id INTEGER,
        commission_pct REAL DEFAULT 0,
        current_balance REAL DEFAULT 0,
        pharmacy_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE points_of_sale (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name_ar TEXT NOT NULL,
        name_en TEXT,
        location TEXT,
        computer_name TEXT,
        current_balance REAL DEFAULT 0,
        initial_credit REAL DEFAULT 0,
        initial_debit REAL DEFAULT 0,
        status TEXT DEFAULT 'active',
        pharmacy_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO users VALUES
        ('u1', 'u1', 'User One', 'ph-1'),
        ('u2', 'u2', 'User Two', 'ph-2');
      INSERT INTO accounts VALUES (6, '1.1.1', 'Cash', 'Cash', 'asset', NULL, 0);
      INSERT INTO trial_balance_settings VALUES ('cash_drawer', 6);
      INSERT INTO patients VALUES ('p1', 'Patient One');
      INSERT INTO suppliers VALUES (2, 'Supplier Two', 'Supplier Two');

      INSERT INTO cash_movements
        (id, user_id, pharmacy_id, type, category, amount, notes, date)
      VALUES
        ('m1', 'u1', 'ph-1', 'receipt', 'collection', 10, 'ph1 receipt', date('now', 'localtime')),
        ('m2', 'u2', 'ph-2', 'receipt', 'collection', 20, 'ph2 receipt', date('now', 'localtime'));
      INSERT INTO expenses
        (id, user_id, pharmacy_id, category, amount, description, date)
      VALUES
        ('e1', 'u1', 'ph-1', 'rent', 3, 'ph1 expense', date('now', 'localtime')),
        ('e2', 'u2', 'ph-2', 'rent', 7, 'ph2 expense', date('now', 'localtime'));
      INSERT INTO daily_journals
        (id, date, description, created_by, pharmacy_id, total_amount)
      VALUES
        ('j1', date('now', 'localtime'), 'ph1 journal', 'u1', 'ph-1', 100),
        ('j2', date('now', 'localtime'), 'ph2 journal', 'u2', 'ph-2', 200);
      INSERT INTO journal_entries (journal_id, account_id, type, amount)
      VALUES ('j1', 6, 'debit', 100), ('j2', 6, 'debit', 200);
      INSERT INTO financial_notices
        (id, user_id, pharmacy_id, target_type, target_id, type, amount, reason, date)
      VALUES
        ('n1', 'u1', 'ph-1', 'customer', 'p1', 'debit', 5, 'ph1 notice', date('now', 'localtime')),
        ('n2', 'u2', 'ph-2', 'supplier', '2', 'debit', 8, 'ph2 notice', date('now', 'localtime'));
      INSERT INTO activity_log (user_id, pharmacy_id, action, details)
      VALUES ('u1', 'ph-1', 'PH1', 'ph1 log'), ('u2', 'ph-2', 'PH2', 'ph2 log');
      INSERT INTO sales_invoices VALUES
        ('sale-1', 'ph-1', 30, 'completed', datetime('now')),
        ('sale-2', 'ph-2', 70, 'completed', datetime('now'));
      INSERT INTO returns VALUES
        ('return-1', 'sale-1', 'u1', 'ph-1', 4, 'approved', datetime('now')),
        ('return-2', 'sale-2', 'u2', 'ph-2', 9, 'approved', datetime('now')),
        ('general-return-1', NULL, 'u1', 'ph-1', 6, 'approved', datetime('now')),
        ('general-return-2', NULL, 'u2', 'ph-2', 11, 'approved', datetime('now'));
      INSERT INTO commercial_papers
        (id,type,direction,paper_number,amount,due_date,status,target_name,pharmacy_id)
      VALUES
        ('paper-1','check','in','P1',10,'2026-10-01','pending','PH1 Paper','ph-1'),
        ('paper-2','check','in','P2',20,'2026-10-01','pending','PH2 Paper','ph-2');
      INSERT INTO banks (id,name_ar,name_en,current_balance,pharmacy_id) VALUES
        (1,'PH1 Bank','PH1 Bank',0,'ph-1'),
        (2,'PH2 Bank','PH2 Bank',0,'ph-2');
      INSERT INTO credit_cards (id,name_ar,name_en,bank_id,current_balance,pharmacy_id) VALUES
        (1,'PH1 Card','PH1 Card',1,0,'ph-1'),
        (2,'PH2 Card','PH2 Card',2,0,'ph-2');
      INSERT INTO points_of_sale (id,name_ar,name_en,status,current_balance,pharmacy_id) VALUES
        (1,'PH1 POS','PH1 POS','active',0,'ph-1'),
        (2,'PH2 POS','PH2 POS','active',0,'ph-2');
      ALTER TABLE shifts ADD COLUMN user_id TEXT;
      ALTER TABLE shifts ADD COLUMN start_time TEXT;
      ALTER TABLE shifts ADD COLUMN end_time TEXT;
      ALTER TABLE shifts ADD COLUMN starting_cash REAL DEFAULT 0;
      ALTER TABLE shifts ADD COLUMN actual_cash REAL;
      ALTER TABLE shifts ADD COLUMN transfer_amount REAL DEFAULT 0;
      ALTER TABLE shifts ADD COLUMN transfer_target TEXT;
      ALTER TABLE shifts ADD COLUMN treasury_retained_cash REAL;
      ALTER TABLE sales_invoices ADD COLUMN shift_id TEXT;
      ALTER TABLE sales_invoices ADD COLUMN payment_method TEXT;
      ALTER TABLE sales_invoices ADD COLUMN paid_amount REAL DEFAULT 0;
      ALTER TABLE sales_invoices ADD COLUMN remaining_amount REAL DEFAULT 0;
      ALTER TABLE returns ADD COLUMN shift_id TEXT;
      ALTER TABLE returns ADD COLUMN refund_method TEXT;
      INSERT INTO shifts
        (id, pharmacy_id, status, user_id, start_time, end_time, actual_cash, transfer_amount, transfer_target, treasury_retained_cash)
      VALUES
        ('treasury-ph1', 'ph-1', 'closed', 'u1', datetime('now', '-2 hours'), datetime('now', '-1 hour'), 100, 40, 'next_shift', 60),
        ('treasury-ph2', 'ph-2', 'closed', 'u2', datetime('now', '-2 hours'), datetime('now', '-1 hour'), 150, 60, 'next_shift', 90);
    `);
  });

  afterEach(() => mockDb.close());

  it('keeps finance reads inside the signed-in pharmacy and resolves notice names from the real schema', async () => {
    expect((await getCashMovementsAction()).data?.map((row: any) => row.id)).toEqual(['m1']);

    expect(await getTreasuryDashboardAction()).toMatchObject({
      success: true,
      data: {
        treasuryBalance: 60,
        ledgerCashBalance: 100,
        todayReceipts: 10,
        todayExpenses: 3,
      },
    });
    expect((await getTreasuryDashboardAction('treasury')).data?.details).toEqual([
      expect.objectContaining({ shift_id: 'treasury-ph1', amount: 60 }),
    ]);

    expect((await getJournalsAction()).data?.map((row: any) => row.id)).toEqual(['j1']);
    expect((await getJournalDetailsAction('j2')).data).toEqual([]);

    const trial = await getTrialBalanceAction();
    expect(trial.success).toBe(true);
    expect(trial.data?.find((row: any) => row.id === 6)).toMatchObject({
      total_debit: 100,
      total_credit: 0,
      net_debit: 100,
    });

    const notices = await getFinancialNoticesAction();
    expect(notices).toMatchObject({ success: true });
    expect(notices.data).toEqual([
      expect.objectContaining({ id: 'n1', target_name: 'Patient One' }),
    ]);

    mockDb.prepare("UPDATE users SET pharmacy_id = 'ph-2' WHERE id = 'u1'").run();
    expect((await getActivityLogsAction()).data?.map((row: any) => row.action)).toEqual(['PH1']);
  });

  it('stores independent daily snapshots for pharmacies sharing the same database', async () => {
    const today = (mockDb.prepare("SELECT date('now','localtime') AS d").get() as any).d;
    expect(await generateDailySnapshotAction(today)).toMatchObject({ success: true });

    mockSession = { id: 'u2', role: 'owner', pharmacy_id: 'ph-2' };
    expect(await generateDailySnapshotAction(today)).toMatchObject({ success: true });

    expect(mockDb.prepare(
      'SELECT pharmacy_id,total_sales,total_returns,total_cash_movements,net_profit FROM daily_financial_snapshots WHERE date = ? ORDER BY pharmacy_id'
    ).all(today)).toEqual([
      { pharmacy_id:'ph-1', total_sales:30, total_returns:10, total_cash_movements:10, net_profit:30 },
      { pharmacy_id:'ph-2', total_sales:70, total_returns:20, total_cash_movements:20, net_profit:70 },
    ]);
  });

  it('keeps commercial papers inside their pharmacy for list, status, create, and delete', async () => {
    expect((await getPapersAction()).data?.map((row: any) => row.id)).toEqual(['paper-1']);
    expect(await updatePaperStatusAction('paper-2', 'bounced')).toMatchObject({ success: false });
    expect(await deletePaperAction('paper-2')).toMatchObject({ success: false });
    expect(mockDb.prepare("SELECT status FROM commercial_papers WHERE id='paper-2'").get()).toEqual({ status: 'pending' });

    expect(await addPaperAction({
      type: 'check', direction: 'in', paper_number: 'P3', amount: 30,
      due_date: '2026-10-02', target_name: 'PH1 New Paper',
    })).toMatchObject({ success: true });
    expect(mockDb.prepare("SELECT pharmacy_id FROM commercial_papers WHERE id='test-id'").get()).toEqual({ pharmacy_id: 'ph-1' });

    mockSession = { id: 'u2', role: 'owner', pharmacy_id: 'ph-2' };
    expect((await getPapersAction()).data?.map((row: any) => row.id)).toEqual(['paper-2']);
  });

  it('keeps banks, card terminals, and POS definitions inside their pharmacy for reads and mutations', async () => {
    expect((await getBanksAction()).data?.map((row: any) => row.id)).toEqual([1]);
    expect((await getCardsAction()).data?.map((row: any) => row.id)).toEqual([1]);
    expect((await getPointsOfSaleAction()).data?.map((row: any) => row.id)).toEqual([1]);

    expect(await updateBankAction(2, { name_ar: 'blocked' })).toMatchObject({ success: false });
    expect(await updateCardAction(2, { name_ar: 'blocked' })).toMatchObject({ success: false });
    expect(await updatePointOfSaleAction(2, { name_ar: 'blocked' })).toMatchObject({ success: false });
    expect(await deleteBankAction(2)).toMatchObject({ success: false });
    expect(await deleteCardAction(2)).toMatchObject({ success: false });
    expect(await deletePointOfSaleAction(2)).toMatchObject({ success: false });

    expect(await addBankAction({ name_ar: 'PH1 New Bank' })).toMatchObject({ success: true });
    expect(await addCardAction({ name_ar: 'PH1 New Card', bank_id: 1 })).toMatchObject({ success: true });
    expect(await addPointOfSaleAction({ name_ar: 'PH1 New POS' })).toMatchObject({ success: true });
    expect(mockDb.prepare("SELECT pharmacy_id FROM banks WHERE name_ar='PH1 New Bank'").get()).toEqual({ pharmacy_id: 'ph-1' });
    expect(mockDb.prepare("SELECT pharmacy_id FROM credit_cards WHERE name_ar='PH1 New Card'").get()).toEqual({ pharmacy_id: 'ph-1' });
    expect(mockDb.prepare("SELECT pharmacy_id FROM points_of_sale WHERE name_ar='PH1 New POS'").get()).toEqual({ pharmacy_id: 'ph-1' });

    mockSession = { id: 'u2', role: 'owner', pharmacy_id: 'ph-2' };
    expect((await getBanksAction()).data?.map((row: any) => row.id)).toEqual([2]);
    expect((await getCardsAction()).data?.map((row: any) => row.id)).toEqual([2]);
    expect((await getPointsOfSaleAction()).data?.map((row: any) => row.id)).toEqual([2]);
  });
});
