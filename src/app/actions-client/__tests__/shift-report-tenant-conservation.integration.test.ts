/** @jest-environment node */
import Database from 'better-sqlite3';
import { getShiftReportAction } from '@/app/actions-client/reports';
import { getLocalSession } from '@/lib/auth/local';

// This exercises actual current-source report SQL against a newly allocated
// SQLite :memory: database. Only session inspection is a clearly labeled test
// fixture; it is not a native login, browser cookie, or QA tenant identity.
let mockSqlite: Database.Database;
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(),
  hasUserPermissionSync: (user: any, key: string) => user?.permissions?.[key] === true,
}));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockSqlite.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockSqlite.prepare(sql).get(...params)),
  dbExecute: jest.fn(() => { throw new Error('Read-only report tests must not write'); }),
  normalizeDatabaseTimestamps: (value: unknown) => value,
}));

const pharmacyA = 'synthetic-pharmacy-A';
const pharmacyB = 'synthetic-pharmacy-B';
const syntheticSession = (tenant: string, permitted = true) => ({
  id: 'synthetic-session-not-authenticated', role: 'pharmacist', pharmacy_id: tenant,
  permissions: { rep_can_view_shifts: permitted },
});

function insertRows(): void {
  mockSqlite.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, full_name TEXT);
    CREATE TABLE shifts(id TEXT PRIMARY KEY, pharmacy_id TEXT, user_id TEXT,
      starting_cash REAL, ending_cash REAL, status TEXT, actual_cash REAL, cash_difference REAL,
      start_time TEXT DEFAULT '2026-10-15 09:00:00');
    CREATE TABLE sales_invoices(id TEXT PRIMARY KEY, pharmacy_id TEXT, shift_id TEXT,
      payment_method TEXT, status TEXT, total_amount REAL, paid_amount REAL, remaining_amount REAL);
    CREATE TABLE returns(id TEXT PRIMARY KEY, pharmacy_id TEXT, shift_id TEXT,
      refund_method TEXT, status TEXT, total_refund REAL);
    CREATE TABLE cash_movements(id TEXT PRIMARY KEY, pharmacy_id TEXT, shift_id TEXT,
      type TEXT, category TEXT, source_type TEXT, amount REAL);
    INSERT INTO users VALUES ('synthetic-user', 'Synthetic pharmacist');
    INSERT INTO shifts(id,pharmacy_id,user_id,starting_cash,ending_cash,status,actual_cash,cash_difference) VALUES
      ('shift-A', 'synthetic-pharmacy-A', 'synthetic-user', 100, NULL, 'open', NULL, NULL),
      ('shift-B', 'synthetic-pharmacy-B', 'synthetic-user', 300, NULL, 'open', NULL, NULL),
      ('legacy-unowned', NULL, 'synthetic-user', 999, NULL, 'open', NULL, NULL);
    INSERT INTO sales_invoices VALUES
      ('cash-A', 'synthetic-pharmacy-A', 'shift-A', 'cash', 'completed', 70, 70, 0),
      ('card-A', 'synthetic-pharmacy-A', 'shift-A', 'visa', 'completed', 90, 90, 0),
      ('void-A', 'synthetic-pharmacy-A', 'shift-A', 'cash', 'cancelled', 800, 800, 0),
      ('cash-B', 'synthetic-pharmacy-B', 'shift-A', 'cash', 'completed', 700, 700, 0),
      ('cash-legacy', NULL, 'shift-A', 'cash', 'completed', 400, 400, 0);
    INSERT INTO returns VALUES
      ('return-A', 'synthetic-pharmacy-A', 'shift-A', 'cash', 'approved', 10),
      ('return-void', 'synthetic-pharmacy-A', 'shift-A', 'cash', 'draft', 999),
      ('return-B', 'synthetic-pharmacy-B', 'shift-A', 'cash', 'completed', 200),
      ('return-legacy', NULL, 'shift-A', 'cash', 'completed', 250);
    INSERT INTO cash_movements VALUES
      ('receipt-A', 'synthetic-pharmacy-A', 'shift-A', 'receipt', 'other', 'drawer', 20),
      ('handover-A', 'synthetic-pharmacy-A', 'shift-A', 'out', 'handover', 'drawer', 5),
      ('main-safe-A', 'synthetic-pharmacy-A', 'shift-A', 'receipt', 'other', 'main_safe', 3000),
      ('receipt-B', 'synthetic-pharmacy-B', 'shift-A', 'receipt', 'other', 'drawer', 300),
      ('receipt-legacy', NULL, 'shift-A', 'receipt', 'other', 'drawer', 400);
  `);
}

describe('web shift report isolated SQL tenant and cash conservation', () => {
  beforeEach(() => {
    mockSqlite = new Database(':memory:');
    insertRows();
    (getLocalSession as jest.Mock).mockResolvedValue(syntheticSession(pharmacyA));
  });
  afterEach(() => { mockSqlite.close(); jest.clearAllMocks(); });

  it('reconciles only its own approved cash sales, refunds and movements despite misassigned cross-tenant shift IDs', async () => {
    const result = await getShiftReportAction('shift-A');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.summary).toMatchObject({
      cashSales: 70, cashReturns: 10, cashReceipts: 20, cashDisbursements: 5,
      cashHandover: 5, expectedCash: 175,
    });
    expect(result.data.sales.find((s: any) => s.payment_method === 'cash')).toMatchObject({ count: 1, total: 70 });
    expect(result.data.returns).toEqual([expect.objectContaining({ refund_method: 'cash', total: 10 })]);
  });

  it('rejects a different pharmacy shift before reporting any balances', async () => {
    const result = await getShiftReportAction('shift-B');
    expect(result).toMatchObject({ success: false, error: 'الوردية غير موجودة أو لا تخص هذه الصيدلية' });
  });

  it('does not silently claim unknown legacy financial history for local_default', async () => {
    (getLocalSession as jest.Mock).mockResolvedValue(syntheticSession('local_default'));
    const result = await getShiftReportAction('legacy-unowned');
    expect(result.success).toBe(false);
  });

  it('rejects missing reporting permission before exposing an authorized shift', async () => {
    (getLocalSession as jest.Mock).mockResolvedValue(syntheticSession(pharmacyA, false));
    expect(await getShiftReportAction('shift-A')).toMatchObject({ success: false, error: 'غير مصرح' });
  });

  it('reconciles an explicitly closed drawer using the recorded actual cash and variance', async () => {
    mockSqlite.prepare(`UPDATE shifts SET status='closed', actual_cash=173, cash_difference=-2,
      ending_cash=173 WHERE id='shift-A'`).run();
    const result = await getShiftReportAction('shift-A');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.summary).toMatchObject({
      expectedCash: 175, actualCash: 173, difference: -2,
    });
  });

  it('does not publish partly computed balances if a required SQL read fails', async () => {
    mockSqlite.exec('DROP TABLE returns');
    const result = await getShiftReportAction('shift-A');
    expect(result.success).toBe(false);
    expect((result as any).data).toBeUndefined();
  });

  it('rejects a missing tenant claim instead of assuming legacy local_default ownership', async () => {
    (getLocalSession as jest.Mock).mockResolvedValue({
      id: 'synthetic-no-tenant', role: 'owner', pharmacy_id: null,
      permissions: { rep_can_view_shifts: true },
    });
    const result = await getShiftReportAction('shift-A');
    expect(result.success).toBe(false);
  });
});
