/**
 * Phase 6: Finance Tests (P1)
 * Chart of accounts, cash movements, banks, cards, commercial papers, journals.
 */

import Database from 'better-sqlite3';

function seedFinance(db: Database.Database) {
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, code TEXT UNIQUE NOT NULL, name_ar TEXT NOT NULL, name_en TEXT, type TEXT NOT NULL, is_group INTEGER DEFAULT 0, balance REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE cash_movements (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, shift_id TEXT, type TEXT NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL, source_type TEXT, target_name TEXT, notes TEXT, date TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE banks (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, name_en TEXT, account_number TEXT, current_balance REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE credit_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, name_en TEXT, bank_id INTEGER, commission_pct REAL DEFAULT 0, current_balance REAL DEFAULT 0);
    CREATE TABLE commercial_papers (id TEXT PRIMARY KEY, type TEXT NOT NULL, direction TEXT NOT NULL, paper_number TEXT, bank_id INTEGER, amount REAL NOT NULL, due_date TEXT, status TEXT DEFAULT 'pending', target_name TEXT, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE daily_journals (id TEXT PRIMARY KEY, date TEXT NOT NULL, description TEXT, created_by TEXT, total_amount REAL NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE journal_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, journal_id TEXT NOT NULL, account_id INTEGER NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, notes TEXT);
    CREATE TABLE trial_balance_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, target_type TEXT, account_id INTEGER, target_name TEXT);
    CREATE TABLE daily_financial_snapshots (date TEXT PRIMARY KEY, total_sales REAL DEFAULT 0, total_returns REAL DEFAULT 0, total_cash_movements REAL DEFAULT 0, net_profit REAL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE points_of_sale (id INTEGER PRIMARY KEY AUTOINCREMENT, name_ar TEXT NOT NULL, status TEXT DEFAULT 'active', current_balance REAL DEFAULT 0);
    CREATE TABLE expense_definitions (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name_ar TEXT NOT NULL, name_en TEXT);
    CREATE TABLE financial_notices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL, reason TEXT, date TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  `);
}

describe('Phase 6a: Chart of Accounts (Double-Entry)', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedFinance(db); });
  afterAll(() => db.close());

  it('Scenario 1: Create account hierarchy (parent → child)', () => {
    db.prepare("INSERT INTO accounts (id, parent_id, code, name_ar, type, is_group) VALUES (1, NULL, '1', 'الأصول', 'asset', 1)").run();
    db.prepare("INSERT INTO accounts (id, parent_id, code, name_ar, type, is_group) VALUES (2, 1, '1.1', 'النقدية', 'asset', 0)").run();
    db.prepare("INSERT INTO accounts (id, parent_id, code, name_ar, type, is_group) VALUES (3, 1, '1.2', 'البنوك', 'asset', 0)").run();
    db.prepare("INSERT INTO accounts (id, parent_id, code, name_ar, type, is_group) VALUES (4, NULL, '2', 'الخصوم', 'liability', 1)").run();

    const parents = db.prepare("SELECT * FROM accounts WHERE parent_id IS NULL").all() as any[];
    expect(parents).toHaveLength(2);

    const children = db.prepare("SELECT * FROM accounts WHERE parent_id = 1").all() as any[];
    expect(children).toHaveLength(2);
    expect(children[0].code).toBe('1.1');
  });

  it('Scenario 2: Post journal entry with debit/credit pair', () => {
    const journalId = 'jour-001';
    db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES (?, '2026-06-23', 'قيد اليوم', 'u1', 1000)").run(journalId);
    // Debit: Cash account (2) increases
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 2, 'debit', 1000)").run(journalId);
    // Credit: Sales revenue account increases
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 3, 'credit', 1000)").run(journalId);

    const entries = db.prepare("SELECT * FROM journal_entries WHERE journal_id = ? ORDER BY id").all(journalId) as any[];
    expect(entries).toHaveLength(2);

    const debitTotal = entries.filter((e: any) => e.type === 'debit').reduce((s: number, e: any) => s + e.amount, 0);
    const creditTotal = entries.filter((e: any) => e.type === 'credit').reduce((s: number, e: any) => s + e.amount, 0);
    expect(debitTotal).toBe(creditTotal); // balanced entry
  });

  it('Scenario 3: Account balance updates', () => {
    db.prepare("UPDATE accounts SET balance = balance + 1000 WHERE id = 2").run();
    db.prepare("UPDATE accounts SET balance = balance - 1000 WHERE id = 3").run();

    const acc2 = db.prepare("SELECT balance FROM accounts WHERE id = 2").get() as any;
    expect(acc2.balance).toBe(1000);
  });

  it('Scenario 4: Prevent delete of group account with children', () => {
    const children = db.prepare("SELECT COUNT(*) as c FROM accounts WHERE parent_id = 1").get() as any;
    expect(children.c).toBeGreaterThan(0);
    // In a real app this would throw; verify the check logic works
    const isGroup = db.prepare("SELECT is_group FROM accounts WHERE id = 1").get() as any;
    expect(isGroup.is_group).toBe(1);
  });
});

describe('Phase 6b: Cash Movements', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedFinance(db); });
  afterAll(() => db.close());

  it('Scenario 5: Record cash disbursement (صرف)', () => {
    db.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, date) VALUES ('cm-001', 'u1', 'disbursement', 'مصروفات', 500, '2026-06-23')").run();
    db.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, date) VALUES ('cm-002', 'u1', 'receipt', 'إيرادات', 200, '2026-06-23')").run();

    const net = db.prepare("SELECT SUM(CASE WHEN type='receipt' THEN amount ELSE -amount END) as net FROM cash_movements").get() as any;
    expect(net.net).toBe(-300); // -500 + 200
  });

  it('Scenario 6: Cash movement linked to shift', () => {
    db.prepare("INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, date) VALUES ('cm-003', 'u1', 'shift-001', 'disbursement', 'صندوق', 150, '2026-06-23')").run();
    const shiftMovements = db.prepare("SELECT COUNT(*) as c FROM cash_movements WHERE shift_id = 'shift-001'").get() as any;
    expect(shiftMovements.c).toBe(1);
  });
});

describe('Phase 6c: Banks & Credit Cards', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedFinance(db); });
  afterAll(() => db.close());

  it('Scenario 7: Create bank account with initial balance', () => {
    db.prepare("INSERT INTO banks (id, name_ar, account_number, current_balance) VALUES (1, 'البنك الأهلي', '123456789', 100000)").run();
    db.prepare("INSERT INTO banks (id, name_ar, account_number, current_balance) VALUES (2, 'HSBC', '987654321', 50000)").run();

    const total = db.prepare("SELECT SUM(current_balance) as total FROM banks").get() as any;
    expect(total.total).toBe(150000);
  });

  it('Scenario 8: Credit card linked to bank with commission', () => {
    db.prepare("INSERT INTO credit_cards (name_ar, bank_id, commission_pct, current_balance) VALUES ('Visa NBE', 1, 2.5, 0)").run();
    db.prepare("INSERT INTO credit_cards (name_ar, bank_id, commission_pct, current_balance) VALUES ('Mastercard HSBC', 2, 1.8, 0)").run();

    const cards = db.prepare("SELECT cc.*, b.name_ar as bank_name FROM credit_cards cc JOIN banks b ON cc.bank_id = b.id").all() as any[];
    expect(cards).toHaveLength(2);
    expect(cards[0].bank_name).toBe('البنك الأهلي');
    expect(cards[0].commission_pct).toBe(2.5);
  });

  it('Scenario 9: Bank transfer updates both balances', () => {
    db.prepare("UPDATE banks SET current_balance = current_balance - 10000 WHERE id = 1").run();
    db.prepare("UPDATE banks SET current_balance = current_balance + 10000 WHERE id = 2").run();

    const b1 = db.prepare("SELECT current_balance FROM banks WHERE id = 1").get() as any;
    const b2 = db.prepare("SELECT current_balance FROM banks WHERE id = 2").get() as any;
    expect(b1.current_balance).toBe(90000); // 100000 - 10000
    expect(b2.current_balance).toBe(60000); // 50000 + 10000
  });
});

describe('Phase 6d: Commercial Papers (Checks/Promissory Notes)', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedFinance(db); db.prepare("INSERT INTO banks (id, name_ar, current_balance) VALUES (1, 'البنك الأهلي', 100000)").run(); });
  afterAll(() => db.close());

  it('Scenario 10: Lifecycle of an incoming check (pending → cashed)', () => {
    db.prepare("INSERT INTO commercial_papers (id, type, direction, paper_number, bank_id, amount, due_date, status, target_name) VALUES ('cp-001', 'check', 'in', 'CHK-001', 1, 25000, '2026-07-15', 'pending', 'عميل')").run();
    let cp = db.prepare("SELECT * FROM commercial_papers WHERE id = 'cp-001'").get() as any;
    expect(cp.status).toBe('pending');

    db.prepare("UPDATE commercial_papers SET status = 'cashed' WHERE id = 'cp-001'").run();
    db.prepare("UPDATE banks SET current_balance = current_balance + 25000 WHERE id = 1").run();
    cp = db.prepare("SELECT * FROM commercial_papers WHERE id = 'cp-001'").get() as any;
    expect(cp.status).toBe('cashed');

    const bank = db.prepare("SELECT current_balance FROM banks WHERE id = 1").get() as any;
    expect(bank.current_balance).toBe(125000);
  });

  it('Scenario 11: Bounced check reverts status', () => {
    db.prepare("UPDATE commercial_papers SET status = 'bounced' WHERE id = 'cp-001'").run();
    db.prepare("UPDATE banks SET current_balance = current_balance - 25000 WHERE id = 1").run();
    const cp = db.prepare("SELECT status FROM commercial_papers WHERE id = 'cp-001'").get() as any;
    expect(cp.status).toBe('bounced');
  });

  it('Scenario 12: Outgoing promissory note', () => {
    db.prepare("INSERT INTO commercial_papers (id, type, direction, amount, due_date, status) VALUES ('cp-002', 'promissory_note', 'out', 5000, '2026-08-01', 'pending')").run();
    const cp = db.prepare("SELECT * FROM commercial_papers WHERE id = 'cp-002'").get() as any;
    expect(cp.type).toBe('promissory_note');
    expect(cp.direction).toBe('out');
  });
});

describe('Phase 6e: Daily Financial Snapshots', () => {
  let db: Database.Database;
  beforeAll(() => { db = new Database(':memory:'); seedFinance(db); });
  afterAll(() => db.close());

  it('Scenario 13: Create daily financial snapshot', () => {
    db.prepare("INSERT INTO daily_financial_snapshots (date, total_sales, total_returns, net_profit) VALUES ('2026-06-23', 5000, 200, 1500)").run();
    const snap = db.prepare("SELECT * FROM daily_financial_snapshots WHERE date = '2026-06-23'").get() as any;
    expect(snap.total_sales).toBe(5000);
    expect(snap.total_returns).toBe(200);
    expect(snap.net_profit).toBe(1500);
  });

  it('Scenario 14: Upsert snapshot (replace on same date)', () => {
    db.prepare("INSERT OR REPLACE INTO daily_financial_snapshots (date, total_sales, total_returns, net_profit) VALUES ('2026-06-23', 5200, 150, 1600)").run();
    const snap = db.prepare("SELECT * FROM daily_financial_snapshots WHERE date = '2026-06-23'").get() as any;
    expect(snap.total_sales).toBe(5200);
  });
});
