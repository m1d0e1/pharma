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
  dbTransaction: jest.fn(async (callback: () => Promise<unknown>) => callback()),
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
  getActivityLogsAction,
  getCashMovementsAction,
  getFinancialNoticesAction,
  getJournalDetailsAction,
  getJournalsAction,
  getTreasuryDashboardAction,
  getTrialBalanceAction,
  generateDailySnapshotAction,
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
    `);
  });

  afterEach(() => mockDb.close());

  it('keeps finance reads inside the signed-in pharmacy and resolves notice names from the real schema', async () => {
    expect((await getCashMovementsAction()).data?.map((row: any) => row.id)).toEqual(['m1']);

    expect(await getTreasuryDashboardAction()).toMatchObject({
      success: true,
      data: {
        treasuryBalance: 100,
        todayReceipts: 10,
        todayExpenses: 3,
      },
    });

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
});
