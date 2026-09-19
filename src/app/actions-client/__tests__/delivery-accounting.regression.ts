import Database from 'better-sqlite3';

let mockDb: Database.Database;
let mockIdCounter = 0;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
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
  generateId: jest.fn(() => `delivery-test-${++mockIdCounter}`),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'owner', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/app/actions-client/finance', () => ({
  requireOpenShiftId: jest.fn(async () => 'shift-1'),
}));

import { closeDeliveryInvoiceAction } from '@/app/actions-client/delivery';

function insertOriginalSale(invoiceId: string, debitAccount: number) {
  mockDb.prepare(`
    INSERT INTO sales_invoices (id, pharmacy_id, total_amount, payment_method, status)
    VALUES (?, 'ph-1', 100, 'delivery', 'completed')
  `).run(invoiceId);
  mockDb.prepare(`
    INSERT INTO daily_journals (id, date, description, created_by, total_amount)
    VALUES (?, '2026-09-18', ?, 'admin', 100)
  `).run(`sale-${invoiceId}`, `Sales invoice ${invoiceId.slice(0, 8)}`);
  mockDb.prepare("UPDATE daily_journals SET pharmacy_id = 'ph-1' WHERE id = ?").run(`sale-${invoiceId}`);
  mockDb.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, 100)')
    .run(`sale-${invoiceId}`, debitAccount, 'debit');
  mockDb.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, 9, ?, 100)')
    .run(`sale-${invoiceId}`, 'credit');
}

describe('delivery collection accounting compatibility', () => {
  beforeEach(() => {
    mockIdCounter = 0;
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY,
        pharmacy_id TEXT,
        total_amount REAL,
        payment_method TEXT,
        status TEXT
      );
      CREATE TABLE cash_movements (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        shift_id TEXT,
        pharmacy_id TEXT,
        type TEXT,
        category TEXT,
        amount REAL,
        notes TEXT,
        date TEXT
      );
      CREATE TABLE trial_balance_settings (category TEXT PRIMARY KEY, account_id INTEGER);
      CREATE TABLE daily_journals (
        id TEXT PRIMARY KEY,
        date TEXT,
        description TEXT,
        created_by TEXT,
        pharmacy_id TEXT,
        total_amount REAL
      );
      CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL);
      CREATE TABLE activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        pharmacy_id TEXT,
        action TEXT,
        details TEXT
      );
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, pharmacy_id TEXT);
      INSERT INTO users VALUES ('admin', 'admin', 'ph-1');
      CREATE TRIGGER daily_journals_snapshot_pharmacy_insert AFTER INSERT ON daily_journals
      WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
      BEGIN
        UPDATE daily_journals SET pharmacy_id = 'ph-1' WHERE id = NEW.id;
      END;
      CREATE TRIGGER cash_movements_snapshot_pharmacy_insert AFTER INSERT ON cash_movements
      WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
      BEGIN
        UPDATE cash_movements SET pharmacy_id = 'ph-1' WHERE id = NEW.id;
      END;
      CREATE TRIGGER activity_log_snapshot_pharmacy_insert AFTER INSERT ON activity_log
      WHEN NEW.pharmacy_id IS NULL OR TRIM(NEW.pharmacy_id) = ''
      BEGIN
        UPDATE activity_log SET pharmacy_id = 'ph-1' WHERE id = NEW.id;
      END;
      INSERT INTO trial_balance_settings VALUES
        ('cash_drawer', 6),
        ('accounts_receivable', 8),
        ('sales_revenue', 9);
    `);
  });

  afterEach(() => mockDb.close());

  it('reclassifies a legacy cash-posted delivery once before collection', async () => {
    insertOriginalSale('legacy-123456', 6);

    expect(await closeDeliveryInvoiceAction('legacy-123456', 5)).toEqual({ success: true });
    expect(mockDb.prepare("SELECT status, total_amount FROM sales_invoices WHERE id = 'legacy-123456'").get()).toEqual({
      status: 'delivered',
      total_amount: 105,
    });
    expect(mockDb.prepare("SELECT amount FROM cash_movements WHERE category = 'delivery'").get()).toEqual({ amount: 105 });

    const correction = mockDb.prepare(`
      SELECT je.account_id, je.type, je.amount
      FROM journal_entries je
      JOIN daily_journals dj ON dj.id = je.journal_id
      WHERE dj.description LIKE 'تصحيح محاسبة توصيل قديم%'
      ORDER BY je.rowid
    `).all();
    expect(correction).toEqual([
      { account_id: 8, type: 'debit', amount: 100 },
      { account_id: 6, type: 'credit', amount: 100 },
    ]);

    const collection = mockDb.prepare(`
      SELECT je.account_id, je.type, je.amount
      FROM journal_entries je
      JOIN daily_journals dj ON dj.id = je.journal_id
      WHERE dj.description LIKE 'تحصيل توصيل فاتورة%'
      ORDER BY je.rowid
    `).all();
    expect(collection).toEqual([
      { account_id: 6, type: 'debit', amount: 105 },
      { account_id: 8, type: 'credit', amount: 100 },
      { account_id: 9, type: 'credit', amount: 5 },
    ]);
    expect((mockDb.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'LEGACY_DELIVERY_ACCOUNTING_CORRECTED'").get() as any).n).toBe(1);

    const cashNet = mockDb.prepare("SELECT SUM(CASE WHEN type='debit' THEN amount ELSE -amount END) AS total FROM journal_entries WHERE account_id=6").get() as any;
    const receivableNet = mockDb.prepare("SELECT SUM(CASE WHEN type='debit' THEN amount ELSE -amount END) AS total FROM journal_entries WHERE account_id=8").get() as any;
    expect(cashNet.total).toBe(105);
    expect(receivableNet.total).toBe(0);

    expect((await closeDeliveryInvoiceAction('legacy-123456', 5)).success).toBe(false);
    expect((mockDb.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'LEGACY_DELIVERY_ACCOUNTING_CORRECTED'").get() as any).n).toBe(1);
  });

  it('keeps the normal receivable collection path unchanged for new deliveries', async () => {
    insertOriginalSale('modern-123456', 8);

    expect(await closeDeliveryInvoiceAction('modern-123456', 5)).toEqual({ success: true });
    expect((mockDb.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'LEGACY_DELIVERY_ACCOUNTING_CORRECTED'").get() as any).n).toBe(0);
    expect((mockDb.prepare("SELECT COUNT(*) AS n FROM daily_journals WHERE description LIKE 'تصحيح محاسبة توصيل قديم%'").get() as any).n).toBe(0);

    const cashNet = mockDb.prepare("SELECT SUM(CASE WHEN type='debit' THEN amount ELSE -amount END) AS total FROM journal_entries WHERE account_id=6").get() as any;
    const receivableNet = mockDb.prepare("SELECT SUM(CASE WHEN type='debit' THEN amount ELSE -amount END) AS total FROM journal_entries WHERE account_id=8").get() as any;
    const salesNet = mockDb.prepare("SELECT SUM(CASE WHEN type='credit' THEN amount ELSE -amount END) AS total FROM journal_entries WHERE account_id=9").get() as any;
    expect(cashNet.total).toBe(105);
    expect(receivableNet.total).toBe(0);
    expect(salesNet.total).toBe(105);
  });

  it('ignores a matching legacy journal from another pharmacy when deciding whether to reclassify', async () => {
    mockDb.prepare(`
      INSERT INTO sales_invoices (id, pharmacy_id, total_amount, payment_method, status)
      VALUES ('modern-foreign-collision', 'ph-1', 100, 'delivery', 'completed')
    `).run();
    mockDb.prepare(`
      INSERT INTO daily_journals (id, date, description, created_by, pharmacy_id, total_amount)
      VALUES ('foreign-sale', '2026-09-18', 'Sales invoice modern-f', 'admin', 'ph-2', 100)
    `).run();
    mockDb.prepare("INSERT INTO journal_entries VALUES ('foreign-sale', 6, 'debit', 100)").run();
    mockDb.prepare("INSERT INTO journal_entries VALUES ('foreign-sale', 9, 'credit', 100)").run();

    expect(await closeDeliveryInvoiceAction('modern-foreign-collision', 0)).toEqual({ success: true });
    expect((mockDb.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'LEGACY_DELIVERY_ACCOUNTING_CORRECTED'").get() as any).n).toBe(0);
  });
});
