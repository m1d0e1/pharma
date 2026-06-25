/**
 * Exhaustive Finance Module Tests
 * Covers: Accounts tree, double-entry, cash movements, banks, credit cards,
 *         commercial papers, trial balance, expense definitions.
 * Uses real better-sqlite3 :memory: database.
 */

import Database from 'better-sqlite3';

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER,
      code TEXT UNIQUE NOT NULL,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','income','expense')),
      is_group INTEGER DEFAULT 0 CHECK(is_group IN (0,1)),
      balance REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE cash_movements (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      shift_id TEXT,
      type TEXT NOT NULL CHECK(type IN ('disbursement','receipt')),
      category TEXT NOT NULL,
      amount REAL NOT NULL CHECK(amount > 0),
      source_type TEXT,
      target_name TEXT,
      notes TEXT,
      date TEXT NOT NULL,
      actual_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE banks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      account_number TEXT,
      branch TEXT,
      current_balance REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE credit_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      bank_id INTEGER,
      commission_pct REAL DEFAULT 0,
      current_balance REAL DEFAULT 0,
      FOREIGN KEY (bank_id) REFERENCES banks(id)
    );
    CREATE TABLE commercial_papers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('check','promissory_note')),
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      paper_number TEXT,
      bank_id INTEGER,
      amount REAL NOT NULL CHECK(amount > 0),
      due_date TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','cashed','bounced')),
      target_name TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bank_id) REFERENCES banks(id)
    );
    CREATE TABLE daily_journals (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      description TEXT,
      created_by TEXT,
      total_amount REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_id TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('debit','credit')),
      amount REAL NOT NULL CHECK(amount > 0),
      notes TEXT,
      FOREIGN KEY (journal_id) REFERENCES daily_journals(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    CREATE TABLE trial_balance_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      target_type TEXT,
      account_id INTEGER,
      target_name TEXT,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );
    CREATE TABLE expense_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      name_ar TEXT NOT NULL,
      name_en TEXT
    );
    CREATE TABLE daily_financial_snapshots (
      date TEXT PRIMARY KEY,
      total_sales REAL DEFAULT 0,
      total_returns REAL DEFAULT 0,
      total_cash_movements REAL DEFAULT 0,
      net_profit REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE shifts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      pos_id TEXT,
      starting_cash REAL DEFAULT 0,
      status TEXT DEFAULT 'open',
      opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME,
      expected_cash REAL,
      actual_cash REAL,
      discrepancy REAL
    );
    CREATE TABLE pos_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE shift_handovers (
      id TEXT PRIMARY KEY,
      shift_id TEXT NOT NULL,
      handed_over_by TEXT NOT NULL,
      handed_over_to TEXT NOT NULL,
      actual_cash REAL NOT NULL,
      expected_cash REAL NOT NULL,
      discrepancy REAL NOT NULL,
      handover_time DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function seedData(db: Database.Database) {
  // 3 banks
  const bankInsert = db.prepare(
    'INSERT INTO banks (name_ar, name_en, account_number, branch, current_balance) VALUES (?, ?, ?, ?, ?)'
  );
  bankInsert.run('البنك التجاري الدولي', 'CIB', '100012345678', 'فرع المهندسين', 125000.00);
  bankInsert.run('بنك مصر', 'Banque Misr', '200098765432', 'فرع الدقي', 45000.00);
  bankInsert.run('البنك الأهلي المصري', 'NBE', '300055556666', 'فرع العباسية', 75000.00);

  // 2 credit cards (linked to banks 1 and 2)
  const cardInsert = db.prepare(
    'INSERT INTO credit_cards (name_ar, name_en, bank_id, commission_pct, current_balance) VALUES (?, ?, ?, ?, ?)'
  );
  cardInsert.run('ماكينة فوري', 'Fawry Terminal', 1, 1.5, 3200.00);
  cardInsert.run('فيزا بنك مصر', 'BM Visa', 2, 2.0, 1500.00);

  // 5 accounts in hierarchy
  // Group accounts: 1=Assets(parent), 2=Liabilities(parent), 3=Revenue(parent)
  // Leaf accounts: 4=Main Treasury(child of 1), 5=Suppliers(child of 2)
  db.prepare("INSERT INTO accounts (id, parent_id, code, name_ar, name_en, type, is_group) VALUES (1, NULL, '1', 'الأصول', 'Assets', 'asset', 1)").run();
  db.prepare("INSERT INTO accounts (id, parent_id, code, name_ar, name_en, type, is_group) VALUES (2, NULL, '2', 'الخصوم', 'Liabilities', 'liability', 1)").run();
  db.prepare("INSERT INTO accounts (id, parent_id, code, name_ar, name_en, type, is_group) VALUES (3, NULL, '3', 'الإيرادات', 'Revenue', 'income', 0)").run();
  db.prepare("INSERT INTO accounts (id, parent_id, code, name_ar, name_en, type, is_group, balance) VALUES (4, 1, '1.1', 'الخزينة الرئيسية', 'Main Treasury', 'asset', 0, 10000)").run();
  db.prepare("INSERT INTO accounts (id, parent_id, code, name_ar, name_en, type, is_group, balance) VALUES (5, 2, '2.1', 'الموردين', 'Suppliers', 'liability', 0, 5000)").run();

  // 4 expense definitions
  const expInsert = db.prepare(
    'INSERT INTO expense_definitions (code, name_ar, name_en) VALUES (?, ?, ?)'
  );
  expInsert.run('51', 'كهرباء', 'Electricity');
  expInsert.run('52', 'مياه', 'Water');
  expInsert.run('53', 'إيجار', 'Rent');
  expInsert.run('54', 'رواتب', 'Salaries');

  // 1 shift register
  db.prepare("INSERT INTO shifts (id, user_id, starting_cash, status) VALUES ('shift-001', 'u1', 5000, 'open')").run();
}

// ─────────────────────────────────────────────
// SECTION 1: Account Tree Scenarios
// ─────────────────────────────────────────────
describe('1. Account Tree Scenarios', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); createSchema(db); seedData(db); });
  afterAll(() => db.close());

  it('Scenario 1: Create root account (parent_id = NULL)', () => {
    const result = db.prepare(
      "INSERT INTO accounts (code, name_ar, type, is_group) VALUES ('4', 'رأس المال', 'equity', 1)"
    ).run();
    expect(result.changes).toBe(1);

    const root = db.prepare("SELECT * FROM accounts WHERE code = '4'").get() as any;
    expect(root.parent_id).toBeNull();
    expect(root.type).toBe('equity');
    expect(root.is_group).toBe(1);
  });

  it('Scenario 2: Create child account linked to parent', () => {
    const result = db.prepare(
      "INSERT INTO accounts (code, name_ar, type, is_group, parent_id) VALUES ('1.1.1', 'خزينة الصندوق', 'asset', 0, 4)"
    ).run();
    expect(result.changes).toBe(1);

    const child = db.prepare("SELECT * FROM accounts WHERE code = '1.1.1'").get() as any;
    expect(child.parent_id).toBe(4);
    expect(child.is_group).toBe(0);
  });

  it('Scenario 3: Create grandchild account (3 levels deep)', () => {
    // Create a child under Assets (id=1 level1), then grandchild
    // level2: 1.2 under id=1
    const l2 = db.prepare(
      "INSERT INTO accounts (code, name_ar, type, is_group, parent_id) VALUES ('1.2', 'نقدية بالبنوك', 'asset', 0, 1)"
    ).run();
    expect(l2.changes).toBe(1);
    const l2acc = db.prepare("SELECT id FROM accounts WHERE code = '1.2'").get() as any;

    // level3: 1.2.1 under 1.2
    const l3 = db.prepare(
      "INSERT INTO accounts (code, name_ar, type, is_group, parent_id) VALUES ('1.2.1', 'بنك CIB', 'asset', 0, ?)"
    ).run(l2acc.id);
    expect(l3.changes).toBe(1);

    const grandchild = db.prepare("SELECT a.*, b.code as parent_code FROM accounts a JOIN accounts b ON a.parent_id = b.id WHERE a.code = '1.2.1'").get() as any;
    expect(grandchild.parent_code).toBe('1.2');
  });

  it('Scenario 4: Delete leaf account (no children) — should work', () => {
    // Leaf account is id=3 (Revenue, is_group=0 with no children)
    const children = db.prepare("SELECT COUNT(*) as c FROM accounts WHERE parent_id = 3").get() as any;
    expect(children.c).toBe(0);

    const result = db.prepare("DELETE FROM accounts WHERE id = 3 AND is_group = 0 AND (SELECT COUNT(*) FROM accounts WHERE parent_id = accounts.id) = 0").run();
    expect(result.changes).toBe(1);

    const deleted = db.prepare("SELECT * FROM accounts WHERE id = 3").get();
    expect(deleted).toBeUndefined();
  });

  it('Scenario 5: Delete group account (has children) — should be blocked', () => {
    // Account id=1 (Assets, is_group=1) has children (id=4: 1.1)
    const children = db.prepare("SELECT COUNT(*) as c FROM accounts WHERE parent_id = 1").get() as any;
    expect(children.c).toBeGreaterThan(0);

    // This should delete 0 rows because is_group=1 and has children
    const result = db.prepare("DELETE FROM accounts WHERE id = 1 AND is_group = 0 AND (SELECT COUNT(*) FROM accounts WHERE parent_id = accounts.id) = 0").run();
    expect(result.changes).toBe(0);

    const stillExists = db.prepare("SELECT * FROM accounts WHERE id = 1").get();
    expect(stillExists).toBeDefined();
  });

  it('Scenario 6: Get children for a given parent', () => {
    const children = db.prepare("SELECT * FROM accounts WHERE parent_id = 1 ORDER BY code").all() as any[];
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(children.some((c: any) => c.code === '1.1')).toBe(true);
    expect(children.some((c: any) => c.code === '1.2')).toBe(true);
  });

  it('Scenario 7: Account code uniqueness enforcement', () => {
    // Duplicate code should throw
    expect(() => {
      db.prepare("INSERT INTO accounts (code, name_ar, type) VALUES ('1.2', 'مكرر', 'asset')").run();
    }).toThrow();
  });

  it('Scenario 8: Account balance tracking (sum of children)', () => {
    // Sum balances of leaf children under id=1 (Assets): id=4 has 10000, id=1.2 has 0
    const sum = db.prepare("SELECT COALESCE(SUM(balance), 0) as total FROM accounts WHERE parent_id = 1 AND is_group = 0").get() as any;
    expect(sum.total).toBe(10000);
  });
});

// ─────────────────────────────────────────────
// SECTION 2: Double-Entry Scenarios
// ─────────────────────────────────────────────
describe('2. Double-Entry Journal Scenarios', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); createSchema(db); seedData(db); });
  afterAll(() => db.close());

  it('Scenario 9: Post journal entry with single debit/credit pair (balanced)', () => {
    db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES ('dj-001', '2026-06-23', 'بيع نقدي', 'u1', 2000)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-001', 4, 'debit', 2000)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-001', 3, 'credit', 2000)").run();

    const entries = db.prepare("SELECT * FROM journal_entries WHERE journal_id = 'dj-001'").all() as any[];
    expect(entries).toHaveLength(2);

    const debitSum = entries.filter((e: any) => e.type === 'debit').reduce((s: number, e: any) => s + e.amount, 0);
    const creditSum = entries.filter((e: any) => e.type === 'credit').reduce((s: number, e: any) => s + e.amount, 0);
    expect(debitSum).toBe(creditSum);
  });

  it('Scenario 10: Post journal entry with multiple debits/credits (balanced)', () => {
    db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES ('dj-002', '2026-06-23', 'مشتريات متعددة', 'u1', 3000)").run();
    // 2 debits: cash 1000 + bank 2000 = 3000
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-002', 4, 'debit', 1000)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-002', 1, 'debit', 2000)").run();
    // 3 credits: supplier 1500 + revenue 1000 + equity 500 = 3000
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-002', 5, 'credit', 1500)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-002', 3, 'credit', 1000)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-002', 2, 'credit', 500)").run();

    const entries = db.prepare("SELECT * FROM journal_entries WHERE journal_id = 'dj-002' ORDER BY id").all() as any[];
    expect(entries).toHaveLength(5);

    const debitSum = entries.filter((e: any) => e.type === 'debit').reduce((s: number, e: any) => s + e.amount, 0);
    const creditSum = entries.filter((e: any) => e.type === 'credit').reduce((s: number, e: any) => s + e.amount, 0);
    expect(debitSum).toBe(3000);
    expect(creditSum).toBe(3000);
    expect(debitSum).toBe(creditSum);
  });

  it('Scenario 11: Post journal entry where debits != credits — unbalanced detection', () => {
    db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES ('dj-003', '2026-06-23', 'قيد غير متوازن', 'u1', 1000)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-003', 4, 'debit', 1000)").run();
    // Only one entry — unbalanced by design (no matching credit)

    const debitSum = (db.prepare("SELECT COALESCE(SUM(amount), 0) as s FROM journal_entries WHERE journal_id = 'dj-003' AND type = 'debit'").get() as any).s;
    const creditSum = (db.prepare("SELECT COALESCE(SUM(amount), 0) as s FROM journal_entries WHERE journal_id = 'dj-003' AND type = 'credit'").get() as any).s;
    expect(debitSum).toBe(1000);
    expect(creditSum).toBe(0);
    expect(debitSum).not.toBe(creditSum);
  });

  it('Scenario 12: Journal entry linked to daily journal', () => {
    const entries = db.prepare(`
      SELECT je.*, dj.date, dj.description as journal_desc
      FROM journal_entries je
      JOIN daily_journals dj ON je.journal_id = dj.id
      WHERE je.journal_id = 'dj-001'
    `).all() as any[];
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((e: any) => {
      expect(e.date).toBe('2026-06-23');
    });
  });

  it('Scenario 13: Daily journal date uniqueness', () => {
    db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES ('dj-004', '2026-06-24', 'قيد ثاني', 'u1', 500)").run();
    // Same date, different id is fine
    db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES ('dj-005', '2026-06-24', 'قيد ثالث', 'u1', 300)").run();

    const journalsOnDate = db.prepare("SELECT * FROM daily_journals WHERE date = '2026-06-24'").all() as any[];
    expect(journalsOnDate).toHaveLength(2);
  });

  it('Scenario 14: Multiple journal entries in same daily journal', () => {
    // dj-002 already has 5 entries
    const count = (db.prepare("SELECT COUNT(*) as c FROM journal_entries WHERE journal_id = 'dj-002'").get() as any).c;
    expect(count).toBe(5);

    // Add another entry to same journal
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-002', 4, 'debit', 500)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-002', 5, 'credit', 500)").run();
    const newCount = (db.prepare("SELECT COUNT(*) as c FROM journal_entries WHERE journal_id = 'dj-002'").get() as any).c;
    expect(newCount).toBe(7);
  });
});

// ─────────────────────────────────────────────
// SECTION 3: Cash Movement Scenarios
// ─────────────────────────────────────────────
describe('3. Cash Movement Scenarios', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); createSchema(db); seedData(db); });
  afterAll(() => db.close());

  it('Scenario 15: Record cash disbursement', () => {
    db.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, date) VALUES ('cm-001', 'u1', 'disbursement', 'مصروفات تشغيلية', 500, '2026-06-23')").run();
    const cm = db.prepare("SELECT * FROM cash_movements WHERE id = 'cm-001'").get() as any;
    expect(cm.type).toBe('disbursement');
    expect(cm.amount).toBe(500);
    expect(cm.category).toBe('مصروفات تشغيلية');
  });

  it('Scenario 16: Record cash receipt', () => {
    db.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, date) VALUES ('cm-002', 'u1', 'receipt', 'إيرادات مبيعات', 1200, '2026-06-23')").run();
    const cm = db.prepare("SELECT * FROM cash_movements WHERE id = 'cm-002'").get() as any;
    expect(cm.type).toBe('receipt');
    expect(cm.amount).toBe(1200);
  });

  it('Scenario 17: Net cash calculation (receipts - disbursements)', () => {
    // cm-001: -500, cm-002: +1200, add another receipt
    db.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, date) VALUES ('cm-003', 'u1', 'receipt', 'أخرى', 300, '2026-06-23')").run();

    const net = db.prepare("SELECT SUM(CASE WHEN type='receipt' THEN amount ELSE -amount END) as net FROM cash_movements").get() as any;
    expect(net.net).toBe(1000); // -500 + 1200 + 300
  });

  it('Scenario 18: Cash movement linked to shift', () => {
    db.prepare("INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, date) VALUES ('cm-004', 'u1', 'shift-001', 'disbursement', 'صندوق', 200, '2026-06-23')").run();
    const shiftCms = db.prepare("SELECT * FROM cash_movements WHERE shift_id = 'shift-001'").all() as any[];
    expect(shiftCms).toHaveLength(1);
    expect(shiftCms[0].id).toBe('cm-004');
  });

  it('Scenario 19: Cash movement with category tracking', () => {
    const byCategory = db.prepare("SELECT category, SUM(CASE WHEN type='receipt' THEN amount ELSE -amount END) as net FROM cash_movements GROUP BY category HAVING category = 'مصروفات تشغيلية'").all() as any[];
    expect(byCategory.length).toBeGreaterThan(0);
    expect(byCategory[0].net).toBe(-500);
  });

  it('Scenario 20: Cash movement date filtering', () => {
    // Add a movement with a different date
    db.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, date) VALUES ('cm-005', 'u1', 'receipt', 'أخرى', 999, '2026-06-24')").run();

    const filtered = db.prepare("SELECT COUNT(*) as c FROM cash_movements WHERE date >= '2026-06-23' AND date <= '2026-06-23'").get() as any;
    expect(filtered.c).toBe(4); // cm-001, cm-002, cm-003, cm-004

    const filtered2 = db.prepare("SELECT COUNT(*) as c FROM cash_movements WHERE date = '2026-06-24'").get() as any;
    expect(filtered2.c).toBe(1);
  });
});

// ─────────────────────────────────────────────
// SECTION 4: Bank Scenarios
// ─────────────────────────────────────────────
describe('4. Bank Scenarios', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); createSchema(db); seedData(db); });
  afterAll(() => db.close());

  it('Scenario 21: Create bank account with initial balance', () => {
    const b1 = db.prepare("SELECT current_balance FROM banks WHERE name_ar = 'البنك التجاري الدولي'").get() as any;
    expect(b1.current_balance).toBe(125000);

    const allBanks = db.prepare("SELECT SUM(current_balance) as total FROM banks").get() as any;
    expect(allBanks.total).toBe(245000); // 125000 + 45000 + 75000
  });

  it('Scenario 22: Update bank balance', () => {
    db.prepare("UPDATE banks SET current_balance = current_balance + 5000 WHERE name_ar = 'البنك التجاري الدولي'").run();
    const b1 = db.prepare("SELECT current_balance FROM banks WHERE name_ar = 'البنك التجاري الدولي'").get() as any;
    expect(b1.current_balance).toBe(130000);
  });

  it('Scenario 23: Bank transfer between accounts', () => {
    // Transfer 10000 from CIB (id=1) to Banque Misr (id=2)
    db.prepare("UPDATE banks SET current_balance = current_balance - 10000 WHERE id = 1").run();
    db.prepare("UPDATE banks SET current_balance = current_balance + 10000 WHERE id = 2").run();

    const b1 = db.prepare("SELECT current_balance FROM banks WHERE id = 1").get() as any;
    const b2 = db.prepare("SELECT current_balance FROM banks WHERE id = 2").get() as any;
    expect(b1.current_balance).toBe(120000); // 130000 - 10000
    expect(b2.current_balance).toBe(55000);  // 45000 + 10000

    // Total should remain same
    const total = db.prepare("SELECT SUM(current_balance) as total FROM banks").get() as any;
    expect(total.total).toBe(250000); // 120000 + 55000 + 75000
  });

  it('Scenario 24: Bank with zero balance', () => {
    db.prepare("INSERT INTO banks (name_ar, account_number, current_balance) VALUES ('بنك فارغ', '000000000', 0)").run();
    const zeroBank = db.prepare("SELECT * FROM banks WHERE current_balance = 0").get() as any;
    expect(zeroBank).toBeDefined();
    expect(zeroBank.name_ar).toBe('بنك فارغ');
  });

  it('Scenario 25: Negative bank balance (overdraft)', () => {
    db.prepare("UPDATE banks SET current_balance = -5000 WHERE name_ar = 'بنك فارغ'").run();
    const overdrawn = db.prepare("SELECT * FROM banks WHERE current_balance < 0").get() as any;
    expect(overdrawn).toBeDefined();
    expect(overdrawn.current_balance).toBe(-5000);
  });
});

// ─────────────────────────────────────────────
// SECTION 5: Credit Card Scenarios
// ─────────────────────────────────────────────
describe('5. Credit Card Scenarios', () => {
  let db: Database.Database;

  beforeAll(() => { db = new Database(':memory:'); createSchema(db); seedData(db); });
  afterAll(() => db.close());

  it('Scenario 26: Create credit card linked to bank', () => {
    const card = db.prepare(`
      SELECT cc.*, b.name_ar as bank_name
      FROM credit_cards cc
      JOIN banks b ON cc.bank_id = b.id
      WHERE cc.name_ar = 'ماكينة فوري'
    `).get() as any;
    expect(card).toBeDefined();
    expect(card.bank_name).toBe('البنك التجاري الدولي');
    expect(card.bank_id).toBe(1);
  });

  it('Scenario 27: Credit card commission calculation', () => {
    // Process a sale of 10000 through Fawry Terminal (1.5% commission)
    const saleAmount = 10000;
    const card = db.prepare("SELECT * FROM credit_cards WHERE id = 1").get() as any;
    const commission = saleAmount * (card.commission_pct / 100);
    expect(commission).toBe(150); // 10000 * 1.5%

    const netAmount = saleAmount - commission;
    expect(netAmount).toBe(9850);

    // Update card balance with net amount
    db.prepare("UPDATE credit_cards SET current_balance = current_balance + ? WHERE id = 1").run(netAmount);
    const updatedCard = db.prepare("SELECT current_balance FROM credit_cards WHERE id = 1").get() as any;
    expect(updatedCard.current_balance).toBe(3200 + 9850);
  });

  it('Scenario 28: Credit card balance update', () => {
    db.prepare("UPDATE credit_cards SET current_balance = 0 WHERE id = 1").run();
    const card = db.prepare("SELECT current_balance FROM credit_cards WHERE id = 1").get() as any;
    expect(card.current_balance).toBe(0);

    db.prepare("UPDATE credit_cards SET current_balance = 5000 WHERE id = 1").run();
    const card2 = db.prepare("SELECT current_balance FROM credit_cards WHERE id = 1").get() as any;
    expect(card2.current_balance).toBe(5000);
  });

  it('Scenario 29: Multiple cards for same bank', () => {
    // Bank id=2 already has 'فيزا بنك مصر', add another
    db.prepare("INSERT INTO credit_cards (name_ar, bank_id, commission_pct, current_balance) VALUES ('ماستركارد بنك مصر', 2, 1.2, 800)").run();

    const bank2Cards = db.prepare("SELECT * FROM credit_cards WHERE bank_id = 2").all() as any[];
    expect(bank2Cards).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────
// SECTION 6: Commercial Paper Scenarios
// ─────────────────────────────────────────────
describe('6. Commercial Paper Scenarios', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:'); createSchema(db); seedData(db);
  });
  afterAll(() => db.close());

  it('Scenario 30: Create incoming check', () => {
    db.prepare("INSERT INTO commercial_papers (id, type, direction, paper_number, bank_id, amount, due_date, status, target_name) VALUES ('cp-001', 'check', 'in', 'CHK-001', 1, 25000, '2026-07-15', 'pending', 'عميل محمود')").run();
    const cp = db.prepare("SELECT * FROM commercial_papers WHERE id = 'cp-001'").get() as any;
    expect(cp.type).toBe('check');
    expect(cp.direction).toBe('in');
    expect(cp.status).toBe('pending');
    expect(cp.amount).toBe(25000);
  });

  it('Scenario 31: Check lifecycle: pending → cashed', () => {
    db.prepare("UPDATE commercial_papers SET status = 'cashed' WHERE id = 'cp-001'").run();
    db.prepare("UPDATE banks SET current_balance = current_balance + 25000 WHERE id = 1").run();

    const cp = db.prepare("SELECT status FROM commercial_papers WHERE id = 'cp-001'").get() as any;
    expect(cp.status).toBe('cashed');

    const bank = db.prepare("SELECT current_balance FROM banks WHERE id = 1").get() as any;
    expect(bank.current_balance).toBe(150000); // 125000 + 25000
  });

  it('Scenario 32: Check lifecycle: pending → bounced', () => {
    // Create a new pending check
    db.prepare("INSERT INTO commercial_papers (id, type, direction, paper_number, bank_id, amount, due_date, status, target_name) VALUES ('cp-002', 'check', 'in', 'CHK-002', 1, 5000, '2026-08-01', 'pending', 'عميل علي')").run();
    let cp = db.prepare("SELECT status FROM commercial_papers WHERE id = 'cp-002'").get() as any;
    expect(cp.status).toBe('pending');

    // Cash it first
    db.prepare("UPDATE commercial_papers SET status = 'cashed' WHERE id = 'cp-002'").run();
    db.prepare("UPDATE banks SET current_balance = current_balance + 5000 WHERE id = 1").run();

    // Then bounce it
    db.prepare("UPDATE commercial_papers SET status = 'bounced' WHERE id = 'cp-002'").run();
    cp = db.prepare("SELECT status FROM commercial_papers WHERE id = 'cp-002'").get() as any;
    expect(cp.status).toBe('bounced');
  });

  it('Scenario 33: Bounced check reverts bank balance', () => {
    // Bank id=1 balance before processing cp-002: 150000 (from scenario 31)
    // After cashing cp-002: 155000, after bouncing: should revert to 150000
    db.prepare("UPDATE banks SET current_balance = current_balance - 5000 WHERE id = 1").run();
    const bank = db.prepare("SELECT current_balance FROM banks WHERE id = 1").get() as any;
    expect(bank.current_balance).toBe(150000);
  });

  it('Scenario 34: Create outgoing promissory note', () => {
    db.prepare("INSERT INTO commercial_papers (id, type, direction, paper_number, amount, due_date, status, target_name) VALUES ('cp-003', 'promissory_note', 'out', 'PN-001', 15000, '2026-09-01', 'pending', 'مورد أحمد')").run();
    const cp = db.prepare("SELECT * FROM commercial_papers WHERE id = 'cp-003'").get() as any;
    expect(cp.type).toBe('promissory_note');
    expect(cp.direction).toBe('out');
    expect(cp.amount).toBe(15000);
  });

  it('Scenario 35: Promissory note lifecycle: pending → cashed', () => {
    db.prepare("UPDATE commercial_papers SET status = 'cashed' WHERE id = 'cp-003'").run();
    db.prepare("UPDATE banks SET current_balance = current_balance - 15000 WHERE id = 1").run();

    const cp = db.prepare("SELECT status FROM commercial_papers WHERE id = 'cp-003'").get() as any;
    expect(cp.status).toBe('cashed');

    const bank = db.prepare("SELECT current_balance FROM banks WHERE id = 1").get() as any;
    expect(bank.current_balance).toBe(135000); // 150000 - 15000
  });
});

// ─────────────────────────────────────────────
// SECTION 7: Trial Balance & Expense Scenarios
// ─────────────────────────────────────────────
describe('7. Trial Balance & Expense Scenarios', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:'); createSchema(db); seedData(db);

    // Add some journal entries for trial balance
    db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES ('dj-tb-001', '2026-06-23', 'قيد ميزان المراجعة', 'u1', 8000)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-tb-001', 4, 'debit', 8000)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-tb-001', 3, 'credit', 8000)").run();

    db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES ('dj-tb-002', '2026-06-24', 'قيد مصروفات', 'u1', 3000)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-tb-002', 5, 'debit', 3000)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('dj-tb-002', 4, 'credit', 3000)").run();
  });
  afterAll(() => db.close());

  it('Scenario 36: Trial balance settings mapping', () => {
    db.prepare("INSERT INTO trial_balance_settings (category, account_id) VALUES ('cash_drawer', 4)").run();
    db.prepare("INSERT INTO trial_balance_settings (category, account_id) VALUES ('sales_revenue', 3)").run();

    const settings = db.prepare("SELECT s.*, a.name_ar as account_name FROM trial_balance_settings s JOIN accounts a ON s.account_id = a.id ORDER BY s.category").all() as any[];
    expect(settings).toHaveLength(2);
    expect(settings[0].category).toBe('cash_drawer');
    expect(settings[0].account_name).toBe('الخزينة الرئيسية');
  });

  it('Scenario 37: Trial balance generation (debits = credits)', () => {
    const balances = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN je.type = 'debit' THEN je.amount ELSE 0 END), 0) as total_debit,
        COALESCE(SUM(CASE WHEN je.type = 'credit' THEN je.amount ELSE 0 END), 0) as total_credit
      FROM journal_entries je
    `).get() as any;

    expect(balances.total_debit).toBe(11000); // 8000 + 3000
    expect(balances.total_credit).toBe(11000); // 8000 + 3000
    expect(balances.total_debit).toBe(balances.total_credit);
  });

  it('Scenario 38: Trial balance with empty data (no entries edge case)', () => {
    const emptyDb = new Database(':memory:');
    createSchema(emptyDb);
    // seed only accounts, no journal entries

    const balances = emptyDb.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN je.type = 'debit' THEN je.amount ELSE 0 END), 0) as total_debit,
        COALESCE(SUM(CASE WHEN je.type = 'credit' THEN je.amount ELSE 0 END), 0) as total_credit
      FROM accounts a
      LEFT JOIN journal_entries je ON a.id = je.account_id
    `).get() as any;

    expect(balances.total_debit).toBe(0);
    expect(balances.total_credit).toBe(0);
    expect(balances.total_debit).toBe(balances.total_credit);
    emptyDb.close();
  });

  it('Scenario 39: Expense definition CRUD', () => {
    // Create
    db.prepare("INSERT INTO expense_definitions (code, name_ar, name_en) VALUES ('55', 'صيانة', 'Maintenance')").run();
    let exp = db.prepare("SELECT * FROM expense_definitions WHERE code = '55'").get() as any;
    expect(exp.name_ar).toBe('صيانة');

    // Read all
    const all = db.prepare("SELECT * FROM expense_definitions ORDER BY code").all() as any[];
    expect(all.length).toBeGreaterThanOrEqual(5); // 4 seeded + 1 new

    // Update
    db.prepare("UPDATE expense_definitions SET name_en = 'Repairs' WHERE code = '55'").run();
    exp = db.prepare("SELECT * FROM expense_definitions WHERE code = '55'").get() as any;
    expect(exp.name_en).toBe('Repairs');

    // Delete
    db.prepare("DELETE FROM expense_definitions WHERE code = '55'").run();
    exp = db.prepare("SELECT * FROM expense_definitions WHERE code = '55'").get();
    expect(exp).toBeUndefined();
  });

  it('Scenario 40: Expense recording and category filtering', () => {
    // Simulate recording expenses via cash movements
    db.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, date) VALUES ('cm-exp-001', 'u1', 'disbursement', 'كهرباء', 800, '2026-06-23')").run();
    db.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, date) VALUES ('cm-exp-002', 'u1', 'disbursement', 'إيجار', 2000, '2026-06-23')").run();
    db.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, date) VALUES ('cm-exp-003', 'u1', 'disbursement', 'كهرباء', 900, '2026-06-24')").run();

    // Filter by expense category
    const electricityTotal = db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM cash_movements WHERE category = 'كهرباء' AND type = 'disbursement'").get() as any;
    expect(electricityTotal.total).toBe(1700); // 800 + 900

    // Filter by date and category
    const rentFiltered = db.prepare("SELECT * FROM cash_movements WHERE category = 'إيجار' AND date = '2026-06-23'").all() as any[];
    expect(rentFiltered).toHaveLength(1);
    expect(rentFiltered[0].amount).toBe(2000);
  });
});

// ─────────────────────────────────────────────
// SECTION 8: POS Management Scenarios
// ─────────────────────────────────────────────
describe('8. POS Management Scenarios', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:'); createSchema(db); seedData(db);
  });
  afterAll(() => db.close());

  it('Scenario 41: Create new POS device', () => {
    db.prepare("INSERT INTO pos_devices (id, name, status) VALUES ('pos-1', 'Main Register 1', 'active')").run();
    const pos = db.prepare("SELECT * FROM pos_devices WHERE id = 'pos-1'").get() as any;
    expect(pos).toBeDefined();
    expect(pos.name).toBe('Main Register 1');
    expect(pos.status).toBe('active');
  });

  it('Scenario 42: Deactivate POS device', () => {
    db.prepare("UPDATE pos_devices SET status = 'inactive' WHERE id = 'pos-1'").run();
    const pos = db.prepare("SELECT * FROM pos_devices WHERE id = 'pos-1'").get() as any;
    expect(pos.status).toBe('inactive');
  });
});

// ─────────────────────────────────────────────
// SECTION 9: Shift Handover & Discrepancies Scenarios
// ─────────────────────────────────────────────
describe('9. Shift Handover & Discrepancies Scenarios', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:'); createSchema(db); seedData(db);
    db.prepare("INSERT INTO pos_devices (id, name, status) VALUES ('pos-1', 'Register 1', 'active')").run();
  });
  afterAll(() => db.close());

  it('Scenario 43: Open shift with POS device', () => {
    db.prepare("INSERT INTO shifts (id, user_id, pos_id, starting_cash, status) VALUES ('shift-002', 'u2', 'pos-1', 1000, 'open')").run();
    const shift = db.prepare("SELECT * FROM shifts WHERE id = 'shift-002'").get() as any;
    expect(shift.status).toBe('open');
    expect(shift.pos_id).toBe('pos-1');
  });

  it('Scenario 44: Add sales and compute expected cash', () => {
    // Add sales receipt
    db.prepare("INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, date) VALUES ('cm-s1', 'u2', 'shift-002', 'receipt', 'sales', 2500, '2026-06-23')").run();
    db.prepare("INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, date) VALUES ('cm-s2', 'u2', 'shift-002', 'disbursement', 'expenses', 300, '2026-06-23')").run();
    
    const shift = db.prepare("SELECT * FROM shifts WHERE id = 'shift-002'").get() as any;
    const movements = db.prepare("SELECT SUM(CASE WHEN type='receipt' THEN amount ELSE -amount END) as net FROM cash_movements WHERE shift_id = 'shift-002'").get() as any;
    
    const expected = shift.starting_cash + movements.net; // 1000 + 2500 - 300 = 3200
    expect(expected).toBe(3200);
  });

  it('Scenario 45: Close shift with discrepancy', () => {
    // Expected cash: 3200. Actual cash reported: 3100 (100 short)
    const expected = 3200;
    const actual = 3100;
    const discrepancy = actual - expected; // -100

    db.prepare("UPDATE shifts SET status = 'closed', closed_at = CURRENT_TIMESTAMP, expected_cash = ?, actual_cash = ?, discrepancy = ? WHERE id = 'shift-002'").run(expected, actual, discrepancy);
    
    const shift = db.prepare("SELECT * FROM shifts WHERE id = 'shift-002'").get() as any;
    expect(shift.status).toBe('closed');
    expect(shift.discrepancy).toBe(-100);
  });

  it('Scenario 46: Record shift handover', () => {
    db.prepare("INSERT INTO shift_handovers (id, shift_id, handed_over_by, handed_over_to, expected_cash, actual_cash, discrepancy) VALUES ('sh-1', 'shift-002', 'u2', 'u3', 3200, 3100, -100)").run();
    
    const handover = db.prepare("SELECT * FROM shift_handovers WHERE id = 'sh-1'").get() as any;
    expect(handover.discrepancy).toBe(-100);
    expect(handover.handed_over_to).toBe('u3');
  });
});

// ─────────────────────────────────────────────
// SECTION 10: Expanded Cash Movements & Operations Scenarios
// ─────────────────────────────────────────────
describe('10. Expanded Cash Movements & Operations Scenarios', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(':memory:'); createSchema(db); seedData(db);
  });
  afterAll(() => db.close());

  it('Scenario 47: Cash out for purchases', () => {
    db.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, date) VALUES ('cm-purch-1', 'u1', 'disbursement', 'مشتريات', 5000, '2026-06-23')").run();
    const movement = db.prepare("SELECT * FROM cash_movements WHERE id = 'cm-purch-1'").get() as any;
    expect(movement.amount).toBe(5000);
    expect(movement.category).toBe('مشتريات');
  });

  it('Scenario 48: Cash in from external sales', () => {
    db.prepare("INSERT INTO cash_movements (id, user_id, type, category, amount, date) VALUES ('cm-sale-1', 'u1', 'receipt', 'مبيعات خارجية', 7500, '2026-06-23')").run();
    const movement = db.prepare("SELECT * FROM cash_movements WHERE id = 'cm-sale-1'").get() as any;
    expect(movement.amount).toBe(7500);
    expect(movement.type).toBe('receipt');
  });

  it('Scenario 49: Multiple category trial balance accumulation', () => {
    const netPurchases = db.prepare("SELECT SUM(amount) as total FROM cash_movements WHERE category = 'مشتريات' AND type = 'disbursement'").get() as any;
    const netSales = db.prepare("SELECT SUM(amount) as total FROM cash_movements WHERE category = 'مبيعات خارجية' AND type = 'receipt'").get() as any;
    
    expect(netPurchases.total).toBe(5000);
    expect(netSales.total).toBe(7500);
  });
});
