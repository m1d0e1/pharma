import Database from 'better-sqlite3';

let mockDb: Database.Database;
let mockSession: any;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => Promise<unknown>) => callback()),
  generateId: jest.fn(() => 'test-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((user: any, permission: string) =>
    user?.role === 'owner'
    || user?.role === 'admin'
    || user?.permissions?.[permission] === true
  ),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { updateDrug: jest.fn() },
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));

import {
  addSupplierAction,
  deleteSupplierAction,
  getSuppliersAction,
  updateSupplierAction,
} from '@/app/actions-client/purchases';

function createSupplierSchema() {
  mockDb.exec(`
    CREATE TABLE suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name_ar TEXT NOT NULL,
      name_en TEXT,
      phone TEXT,
      address TEXT,
      balance REAL DEFAULT 0
    );
    CREATE TABLE purchase_invoices (id TEXT PRIMARY KEY, supplier_id INTEGER NOT NULL);
    CREATE TABLE purchase_returns (id TEXT PRIMARY KEY, supplier_id INTEGER NOT NULL);
    CREATE TABLE supplier_transactions (id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL);
    CREATE TABLE financial_notices (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT
    );
  `);
}

describe('supplier management authorization and history safety', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    createSupplierSchema();
    mockSession = {
      id: 'owner-1',
      role: 'owner',
      permissions: {},
    };
  });

  afterEach(() => mockDb.close());

  it('allows supplier viewing but rejects mutations for non-admin users', async () => {
    mockDb.prepare("INSERT INTO suppliers (name_ar) VALUES ('Existing')").run();
    mockSession = {
      id: 'manager-1',
      role: 'manager',
      permissions: { can_view_suppliers: true, can_view_purchases: true },
    };

    expect(await getSuppliersAction()).toMatchObject({ success: true });
    expect(await addSupplierAction({ name_ar: 'Blocked add' })).toMatchObject({ success: false });
    expect(await updateSupplierAction(1, { name_ar: 'Blocked update' })).toMatchObject({ success: false });
    expect(await deleteSupplierAction(1)).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT name_ar FROM suppliers WHERE id = 1').get()).toEqual({ name_ar: 'Existing' });
  });

  it('refuses deletion when purchase history is linked and returns a clear Arabic error', async () => {
    const supplierId = Number(mockDb.prepare("INSERT INTO suppliers (name_ar) VALUES ('Linked')").run().lastInsertRowid);
    mockDb.prepare("INSERT INTO purchase_invoices (id, supplier_id) VALUES ('invoice-1', ?)").run(supplierId);

    const result = await deleteSupplierAction(supplierId);

    expect(result).toEqual({
      success: false,
      error: 'لا يمكن حذف المورد لوجود فواتير شراء أو مرتجعات أو حركات مالية مرتبطة به',
    });
    expect(mockDb.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId)).toBeDefined();
  });

  it('normalizes supplier data, preserves hidden fields on name edits, and deletes an unlinked supplier', async () => {
    const added = await addSupplierAction({
      name_ar: '  New supplier  ',
      name_en: '  New Supplier  ',
      phone: '  0100000000  ',
      address: '  Cairo  ',
    });
    expect(added.success).toBe(true);
    const supplierId = Number((added as any).id);

    expect(await updateSupplierAction(supplierId, {
      name_ar: '  Updated supplier  ',
      name_en: '  Updated Supplier  ',
    })).toEqual({ success: true });
    expect(mockDb.prepare('SELECT name_ar, name_en, phone, address FROM suppliers WHERE id = ?').get(supplierId)).toEqual({
      name_ar: 'Updated supplier',
      name_en: 'Updated Supplier',
      phone: '0100000000',
      address: 'Cairo',
    });

    expect(await deleteSupplierAction(supplierId)).toEqual({ success: true });
    expect(mockDb.prepare('SELECT id FROM suppliers WHERE id = ?').get(supplierId)).toBeUndefined();
    expect(await addSupplierAction({ name_ar: '   ' })).toMatchObject({ success: false });
  });
});
