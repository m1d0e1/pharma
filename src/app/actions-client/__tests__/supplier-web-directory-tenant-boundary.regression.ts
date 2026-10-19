/** @jest-environment node */
import Database from 'better-sqlite3';

let sqlite: Database.Database;
let actor: any;

jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => actor),
  hasUserPermissionSync: jest.fn((session: any, key: string) =>
    Boolean(session?.permissions?.[key] || session?.role === 'owner')),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { updateDrug: jest.fn() } }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'synthetic-id'),
}));

import { addSupplierAction, deleteSupplierAction, getPurchasesReportsAction, getSupplierTransactionsAction, getSuppliersAction, updateSupplierAction } from '@/app/actions-client/purchases';

describe('web fallback supplier tenant provenance', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name_ar TEXT, name_en TEXT, phone TEXT, address TEXT, balance REAL);
      CREATE TABLE purchase_invoices (id TEXT PRIMARY KEY, supplier_id INTEGER, pharmacy_id TEXT);
      CREATE TABLE supplier_transactions (id INTEGER PRIMARY KEY, supplier_id INTEGER, reference_id TEXT, type TEXT);
      CREATE TABLE purchase_returns (id TEXT PRIMARY KEY, supplier_id INTEGER);
      CREATE TABLE financial_notices (id TEXT PRIMARY KEY, target_type TEXT, target_id TEXT);
      INSERT INTO suppliers VALUES
        (7, 'Shared supplier', 'Shared', 'OTHER TENANT PHONE', 'OTHER TENANT ADDRESS', 9999),
        (8, 'Tenant B only', 'B', 'SECRET CONTACT', 'PRIVATE ADDRESS', 555),
        (9, 'Legacy unowned', 'Old', 'LEGACY', 'UNKNOWN', 111);
      INSERT INTO purchase_invoices VALUES
        ('a-inv1',7,'tenant-a'), ('a-inv2',7,'tenant-a'),
        ('b-inv1',7,'tenant-b'), ('b-inv2',8,'tenant-b'),
        ('unowned-inv',9,NULL);
      INSERT INTO supplier_transactions VALUES
        (1,7,'a-inv1','invoice'),(2,7,'b-inv1','invoice'),(3,8,'b-inv2','invoice');
    `);
    actor = { id: 'user-a', role: 'pharmacist', pharmacy_id: 'tenant-a', permissions: { can_view_suppliers: true } };
  });
  afterEach(() => sqlite.close());

  it('only lists invoice-attested suppliers and never exposes cross-tenant shared balance or contact details', async () => {
    const result = await getSuppliersAction();
    expect(result.success).toBe(true);
    const rows = (result as any).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 7, name_ar: 'Shared supplier', balance: null, purchase_count: 2 });
    expect(rows[0]).not.toHaveProperty('phone');
    expect(rows[0]).not.toHaveProperty('address');
    expect(JSON.stringify(rows)).not.toContain('9999');
    expect(JSON.stringify(rows)).not.toContain('SECRET CONTACT');
    expect(JSON.stringify(rows)).not.toContain('Tenant B only');
  });

  it('does not claim that local_default owns anonymous historical supplier rows', async () => {
    actor.pharmacy_id = 'local_default';
    const result = await getSuppliersAction();
    expect(result).toMatchObject({ success: false, error: expect.any(String) });
    expect(await getSupplierTransactionsAction(7)).toMatchObject({
      success: false, error: 'Legacy purchasing ownership needs independent tenant verification',
    });
    actor.permissions.can_view_purchases = true;
    expect(await getPurchasesReportsAction()).toMatchObject({
      success: false, error: 'Legacy purchasing ownership needs independent tenant verification',
    });
  });

  it('never lets tenant A rewrite or create globally shared suppliers without independent ownership', async () => {
    actor.role = 'owner';
    actor.permissions = { can_view_suppliers: true };
    const before = sqlite.prepare('SELECT id, name_ar, balance FROM suppliers ORDER BY id').all();
    expect(await addSupplierAction({ name_ar: 'No owner provenance' })).toMatchObject({ success: false });
    expect(await updateSupplierAction(7, { name_ar: 'Hijacked shared row' })).toMatchObject({ success: false });
    expect(await updateSupplierAction(8, { name_ar: 'Hijacked other tenant' })).toMatchObject({ success: false });
    expect(await deleteSupplierAction(9)).toMatchObject({ success: false });
    expect(sqlite.prepare('SELECT id, name_ar, balance FROM suppliers ORDER BY id').all()).toEqual(before);
  });
});
