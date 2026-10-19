/** @jest-environment node */

import Database from 'better-sqlite3';

const mockInvoke = jest.fn();
const mockSelect = jest.fn();
const mockGet = jest.fn();
let mockIsTauri = true;
let mockSession: any;
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
  hasUserPermissionSync: jest.fn((user: any, key: string) => Boolean(user?.permissions?.[key])),
}));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { updateDrug: jest.fn(), load: jest.fn(), getAllDrugs: jest.fn(() => []) },
}));

import { getPurchaseInvoicesAction } from '@/app/actions-client/purchases';

describe('typed native purchase invoice list boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTauri = true;
    mockSession = {
      id: 'buyer-a',
      pharmacy_id: 'a',
      role: 'pharmacist',
      permissions: { can_view_purchases: true },
    };
    testDb = new Database(':memory:');
    testDb.exec(`
      CREATE TABLE users(id TEXT,full_name TEXT,pharmacy_id TEXT);
      INSERT INTO users VALUES ('buyer-a','Buyer A','a'),('buyer-b','Buyer B','b');
      CREATE TABLE suppliers(id INTEGER PRIMARY KEY,name_ar TEXT,phone TEXT);
      INSERT INTO suppliers VALUES (7,'Supplier A','0100'),(8,'Supplier B','0200');
      CREATE TABLE master_drugs(id INTEGER PRIMARY KEY,trade_name TEXT);
      INSERT INTO master_drugs VALUES (1,'Drug One'),(2,'Drug Two');
      CREATE TABLE purchase_invoices(
        id TEXT PRIMARY KEY,supplier_id INTEGER,pharmacy_id TEXT,user_id TEXT,
        invoice_number TEXT,total_amount REAL,status TEXT,created_at TEXT,notes TEXT
      );
      CREATE TABLE purchase_invoice_items(invoice_id TEXT,drug_id INTEGER);
      INSERT INTO purchase_invoices VALUES
        ('a-detail',7,'a','buyer-a','A-DETAIL',19,'completed','2026-12-31 11:00:00','special'),
        ('b-secret',8,'b','buyer-b','B-SECRET',999,'completed','2027-01-01 11:00:00','foreign');
      INSERT INTO purchase_invoice_items VALUES
        ('a-detail',1),('a-detail',2),('b-secret',2);
    `);
    const insert = testDb.prepare(`
      INSERT INTO purchase_invoices(
        id,supplier_id,pharmacy_id,user_id,invoice_number,total_amount,status,created_at,notes
      ) VALUES (?,7,'a','buyer-a',?,10,'completed',?,NULL)
    `);
    for (let index = 0; index < 205; index += 1) {
      const identifier = String(index).padStart(3, '0');
      insert.run('a-' + identifier, 'A-' + identifier,
        new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString().replace('T', ' ').slice(0, 19));
    }

    mockSelect.mockImplementation(async (sql: string, args: unknown[] = []) => {
      const { normalizeDatabaseTimestamps } = jest.requireActual('@/lib/db/tauri');
      return normalizeDatabaseTimestamps(testDb.prepare(sql).all(...args));
    });
    mockInvoke.mockImplementation(async (command: string, payload: any) => {
      if (command !== 'db_read_purchasing_page' || payload.queryId !== 'purchases.invoices_list') {
        throw new Error('Unexpected native command');
      }
      // Synthetic scoped backend: the contract and SQL aliases are exercised
      // by the real SQLite legacy query, while Rust tests enforce native roles.
      const all = testDb.prepare(`
        SELECT i.*, s.name_ar as supplier_name, s.phone as supplier_phone,
               u.full_name as user_name,
               (SELECT GROUP_CONCAT(md.trade_name, ' ')
                  FROM purchase_invoice_items pii
                  JOIN master_drugs md ON pii.drug_id=md.id
                 WHERE pii.invoice_id=i.id) as drug_names
        FROM purchase_invoices i
        JOIN suppliers s ON i.supplier_id=s.id
        LEFT JOIN users u ON i.user_id=u.id
        WHERE i.pharmacy_id='a'
        ORDER BY i.created_at DESC,i.id DESC
      `).all() as any[];
      let remaining = all;
      if (payload.cursor !== null) {
        const [date, id] = JSON.parse(payload.cursor) as [string | null, string];
        remaining = all.filter(row => (row.created_at === null && date !== null) ||
          (date !== null && row.created_at !== null &&
            (row.created_at < date || (row.created_at === date && row.id < id))) ||
          (date === null && row.created_at === null && row.id < id));
      }
      return { actorId: 'buyer-a', pharmacyId: 'a', rows: remaining.slice(0, payload.limit) };
    });
  });

  afterEach(() => testDb.close());

  it('fetches every page, preserving complete invoice.*, supplier, user and drug names', async () => {
    const native = await getPurchaseInvoicesAction();
    expect(native.success).toBe(true);
    const nativeRows = (native as any).data;
    expect(nativeRows).toHaveLength(206);
    expect(nativeRows[0]).toMatchObject({
      id: 'a-detail', supplier_name: 'Supplier A', supplier_phone: '0100',
      user_name: 'Buyer A', drug_names: 'Drug One Drug Two',
      invoice_number: 'A-DETAIL', total_amount: 19, notes: 'special',
      created_at: '2026-12-31T11:00:00Z',
    });
    expect(nativeRows.some((row: any) => row.id === 'b-secret')).toBe(false);
    expect(new Set(nativeRows.map((row: any) => row.id)).size).toBe(206);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockInvoke).toHaveBeenNthCalledWith(1, 'db_read_purchasing_page', {
      queryId: 'purchases.invoices_list', cursor: null, limit: 200,
    });
    expect(mockInvoke).toHaveBeenNthCalledWith(2, 'db_read_purchasing_page', {
      queryId: 'purchases.invoices_list',
      // Cursor must use raw DB timestamps; returned rows use normalized ISO.
      cursor: JSON.stringify([
        nativeRows[199].created_at.replace('T', ' ').replace(/Z$/, ''),
        nativeRows[199].id,
      ]),
      limit: 200,
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockInvoke.mock.calls.every(call =>
      !('sql' in call[1]) && !('pharmacyId' in call[1]) && !('userId' in call[1]),
    )).toBe(true);

    mockIsTauri = false;
    const web = await getPurchaseInvoicesAction();
    expect(web).toEqual(native);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect((mockSelect.mock.calls[0][0] as string)).toContain('FROM purchase_invoices i');
  });

  it.each([true, false])('checks frontend purchases visibility before %s transport', async tauri => {
    mockIsTauri = tauri;
    mockSession.permissions.can_view_purchases = false;
    expect(await getPurchaseInvoicesAction()).toEqual({ success: false, error: 'Unauthorized' });
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('fails closed on native denial or malformed response; no generic SQL retry', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockInvoke.mockRejectedValueOnce(new Error('Denied by native permission'));
    expect(await getPurchaseInvoicesAction()).toMatchObject({
      success: false, error: 'Denied by native permission',
    });
    mockInvoke.mockResolvedValueOnce('not an array');
    expect(await getPurchaseInvoicesAction()).toMatchObject({
      success: false, error: 'Invalid native purchasing page envelope',
    });
    spy.mockRestore();
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('rejects an unchanged keyset cursor instead of looping or dropping rows', async () => {
    const duplicatePage = Array.from({ length: 200 }, (_entry, index) => ({
      id: 'invoice-' + index, created_at: '2026-10-01',
    }));
    mockInvoke.mockResolvedValue({ actorId: 'buyer-a', pharmacyId: 'a', rows: duplicatePage });
    const result = await getPurchaseInvoicesAction();
    expect(result).toMatchObject({
      success: false, error: 'Native purchase invoice pagination did not advance',
    });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
