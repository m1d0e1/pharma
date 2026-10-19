/** @jest-environment node */

import Database from 'better-sqlite3';

const mockInvoke = jest.fn();
const mockSelect = jest.fn();
const mockGet = jest.fn();
let mockSession: any;
let mockIsTauri = true;
let testDb: Database.Database;

jest.mock('@/lib/env', () => ({ get isTauri() { return mockIsTauri; } }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: (...args: any[]) => mockInvoke(...args) }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: (...args: any[]) => mockSelect(...args),
  dbGet: (...args: any[]) => mockGet(...args),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(),
  normalizeDatabaseTimestamps: jest.requireActual('@/lib/db/tauri').normalizeDatabaseTimestamps,
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, permission: string) =>
    Boolean(user?.permissions?.[permission])),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { load: jest.fn(), updateDrug: jest.fn(), getAllDrugs: jest.fn(() => []) },
}));

import { getDraftPurchaseInvoicesAction, getPurchaseInvoiceAction } from '@/app/actions-client/purchases';

describe('typed native purchase draft picker and invoice detail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauri = true;
    mockSession = {
      id: 'buyer-a',
      role: 'pharmacist',
      pharmacy_id: 'a',
      permissions: { can_view_purchases: true },
    };
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE users(id TEXT,pharmacy_id TEXT);
      CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name_ar TEXT);
      INSERT INTO suppliers VALUES(7,'Supplier A'),(8,'Supplier B');
      CREATE TABLE purchase_invoices(
        id TEXT PRIMARY KEY,supplier_id INTEGER,pharmacy_id TEXT,user_id TEXT,
        status TEXT,invoice_number TEXT,invoice_date TEXT,total_amount REAL,
        created_at TEXT,updated_at TEXT,notes TEXT
      );
      INSERT INTO purchase_invoices VALUES
        ('a-new',7,'a','buyer-a','draft','A-NEW','2026-10-10',30,
         '2026-10-20 10:00:00','2026-10-20 12:00:00','A-only notes'),
        ('a-null',7,'a','buyer-a','draft','A-NULL',NULL,4,
         NULL,NULL,'null timestamp'),
        ('a-completed',7,'a','buyer-a','completed','A-DONE',NULL,60,
         '2026-10-21 10:00:00',NULL,'completed'),
        ('b-private',8,'b','buyer-b','draft','B-SECRET',NULL,999,
         '2027-01-01 10:00:00',NULL,'foreign'),
        ('default-invoice',7,NULL,'buyer-default','draft','DEFAULT',NULL,7,
         '2026-10-22 10:00:00',NULL,'default tenant'),
        ('a-orphan',999,'a','buyer-a','draft','NO-SUPPLIER',NULL,15,
         '2026-10-24 10:00:00',NULL,'omitted from drafts by INNER join');
    `);
    const insert = testDb.prepare(`
      INSERT INTO purchase_invoices
        (id,supplier_id,pharmacy_id,user_id,status,invoice_number,invoice_date,total_amount,created_at)
      VALUES (?,7,'a','buyer-a','draft',?,NULL,5,?)
    `);
    for (let index = 0; index < 205; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const timestamp = new Date(Date.UTC(2026, 9, 15, 0, 0, index))
        .toISOString().replace('T', ' ').slice(0, 19);
      insert.run('a-draft-' + suffix, 'DRAFT-' + suffix, timestamp);
    }
    const { normalizeDatabaseTimestamps } = jest.requireActual('@/lib/db/tauri');
    mockSelect.mockImplementation(async (sql: string, params: unknown[] = []) =>
      normalizeDatabaseTimestamps(testDb.prepare(sql).all(...params)));
    mockGet.mockImplementation(async (sql: string, params: unknown[] = []) =>
      normalizeDatabaseTimestamps([testDb.prepare(sql).get(...params) || null])[0]);
    mockInvoke.mockImplementation(async (command: string, payload: any) => {
      if (command === 'db_read_scoped' && payload.queryId === 'purchases.invoice_get') {
        return testDb.prepare(`
          SELECT i.* FROM purchase_invoices i WHERE i.id=?
            AND (i.pharmacy_id='a' OR (i.pharmacy_id IS NULL AND 'a'='local_default'))
          LIMIT 1
        `).all(payload.recordId);
      }
      if (command === 'db_read_purchasing_page' && payload.queryId === 'purchases.drafts_list') {
        const rows = testDb.prepare(`
          SELECT pi.id,pi.invoice_number,pi.invoice_date,pi.supplier_id,
            s.name_ar AS supplier_name,pi.total_amount,
            pi.created_at AS __cursor_created_at
          FROM purchase_invoices pi JOIN suppliers s ON pi.supplier_id=s.id
          WHERE pi.status='draft' AND pi.pharmacy_id='a'
          ORDER BY pi.created_at DESC,pi.id DESC
        `).all() as any[];
        const cursor = payload.cursor === null ? null
          : JSON.parse(payload.cursor) as [string | null, string];
        const remaining = cursor === null ? rows : rows.filter(row =>
          (cursor[0] !== null && row.__cursor_created_at === null) ||
          (cursor[0] !== null && row.__cursor_created_at !== null &&
            (row.__cursor_created_at < cursor[0] ||
              (row.__cursor_created_at === cursor[0] && row.id < cursor[1]))) ||
          (cursor[0] === null && row.__cursor_created_at === null && row.id < cursor[1]));
        return { actorId: 'buyer-a', pharmacyId: 'a', rows: remaining.slice(0, payload.limit) };
      }
      throw new Error('Unexpected query ID');
    });
  });

  afterEach(() => testDb.close());

  it('returns all draft pages with exact web shape, no extra cursor property or foreign records', async () => {
    const native = await getDraftPurchaseInvoicesAction();
    expect(native.success).toBe(true);
    const rows = (native as any).data as any[];
    expect(rows).toHaveLength(207);
    expect(rows[0]).toEqual({
      id: 'a-new', invoice_number: 'A-NEW', invoice_date: '2026-10-10',
      supplier_id: 7, supplier_name: 'Supplier A', total_amount: 30,
    });
    expect(rows[rows.length - 1]).toMatchObject({ id: 'a-null', invoice_date: null });
    expect(rows.every(row => Object.keys(row).sort().join(',') ===
      'id,invoice_date,invoice_number,supplier_id,supplier_name,total_amount')).toBe(true);
    expect(new Set(rows.map(row => row.id)).size).toBe(207);
    expect(JSON.stringify(native)).not.toMatch(/b-private|default-invoice|a-orphan|a-completed/);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'db_read_purchasing_page', {
      queryId: 'purchases.drafts_list', cursor: null, limit: 200,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'db_read_purchasing_page', {
      queryId: 'purchases.drafts_list',
      cursor: JSON.stringify([
        testDb.prepare('SELECT created_at FROM purchase_invoices WHERE id=?')
          .get(rows[199].id)?.created_at,
        rows[199].id,
      ]),
      limit: 200,
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockInvoke.mock.calls.every(call =>
      !('sql' in call[1]) && !('pharmacyId' in call[1]) && !('actorId' in call[1]))).toBe(true);

    mockIsTauri = false;
    expect(await getDraftPurchaseInvoicesAction()).toEqual(native);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('matches web full invoice detail and null semantics without renderer-SQL fallback', async () => {
    const native = await getPurchaseInvoiceAction('a-new');
    expect(native).toEqual({
      success: true,
      data: {
        id: 'a-new', supplier_id: 7, pharmacy_id: 'a', user_id: 'buyer-a',
        status: 'draft', invoice_number: 'A-NEW', invoice_date: '2026-10-10',
        total_amount: 30, created_at: '2026-10-20T10:00:00Z',
        updated_at: '2026-10-20T12:00:00Z', notes: 'A-only notes',
      },
    });
    for (const id of ['b-private', 'default-invoice', 'nonexistent']) {
      expect(await getPurchaseInvoiceAction(id)).toEqual({ success: true, data: null });
    }
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'db_read_scoped', {
      queryId: 'purchases.invoice_get', recordId: 'a-new',
      limit: 1, offset: 0, search: null, drugId: null,
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    mockIsTauri = false;
    expect(await getPurchaseInvoiceAction('a-new')).toEqual(native);
    expect(await getPurchaseInvoiceAction('b-private')).toEqual({ success: true, data: null });
  });

  it.each([true, false])('denies frontend purchase permission for both reads (native=%s)', async tauri => {
    mockIsTauri = tauri;
    mockSession.permissions.can_view_purchases = false;
    expect(await getDraftPurchaseInvoicesAction()).toEqual({ success: false, error: 'Unauthorized' });
    expect(await getPurchaseInvoiceAction('a-new')).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fails closed on native denied or malformed responses; never uses generic SQL', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('Native permission denied'));
    expect(await getDraftPurchaseInvoicesAction()).toEqual({
      success: false, error: 'Native permission denied',
    });
    mockInvoke.mockResolvedValueOnce([{ id: 'a-new' }]);
    expect(await getDraftPurchaseInvoicesAction()).toMatchObject({ success: false });
    mockInvoke.mockResolvedValueOnce([{}, {}]);
    expect(await getPurchaseInvoiceAction('a-new')).toEqual({
      success: false, error: 'Invalid native purchase invoice detail response',
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('refuses repeated full pages instead of silently truncating or spinning', async () => {
    const page = Array.from({ length: 200 }, (_, index) => ({
      id: 'repeated-' + index,
      invoice_number: 'D-' + index,
      invoice_date: null,
      supplier_id: 7,
      supplier_name: 'Supplier A',
      total_amount: 1,
      __cursor_created_at: '2026-10-15 00:00:00',
    }));
    mockInvoke.mockResolvedValue({ actorId: 'buyer-a', pharmacyId: 'a', rows: page });
    expect(await getDraftPurchaseInvoicesAction()).toEqual({
      success: false, error: 'Native purchase draft pagination did not advance',
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
