import Database from 'better-sqlite3';

let mockDb: Database.Database;
let mockUser: any;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'report-metadata-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockUser),
  hasUserPermissionSync: jest.fn((user: any, permission: string) =>
    user?.role === 'owner' || user?.permissions?.[permission] === true
  ),
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    getAllDrugs: jest.fn(() => []),
    getDrug: jest.fn(),
    updateDrug: jest.fn(),
    reload: jest.fn(),
  },
}));

import { getSuppliersAction } from '@/app/actions-client/purchases';
const { getPatientsAction } = jest.requireActual('@/app/actions-client/patients') as typeof import('@/app/actions-client/patients');

describe('report metadata permission and pharmacy scope', () => {
  beforeEach(() => {
    mockUser = {
      id: 'reporter-a',
      role: 'staff',
      pharmacy_id: 'ph-a',
      permissions: {
        rep_can_view_purchases: true,
        rep_can_view_sales: true,
        can_view_purchases: false,
        can_view_suppliers: false,
        can_view_patients: false,
      },
    };

    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE suppliers (
        id INTEGER PRIMARY KEY,
        name_ar TEXT NOT NULL,
        name_en TEXT,
        balance REAL DEFAULT 0
      );
      CREATE TABLE purchase_invoices (
        id TEXT PRIMARY KEY,
        supplier_id INTEGER,
        pharmacy_id TEXT,
        status TEXT
      );
      CREATE TABLE patients (
        id TEXT PRIMARY KEY,
        full_name TEXT NOT NULL,
        name_en TEXT
      );
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY,
        patient_id TEXT,
        pharmacy_id TEXT,
        status TEXT
      );

      INSERT INTO suppliers VALUES
        (1, 'Supplier A', 'Supplier A', 111),
        (2, 'Supplier B', 'Supplier B', 222),
        (3, 'Unused Supplier', 'Unused Supplier', 333);
      INSERT INTO purchase_invoices VALUES
        ('pa', 1, 'ph-a', 'completed'),
        ('pb', 2, 'ph-b', 'completed');

      INSERT INTO patients VALUES
        ('patient-a', 'Patient A', 'Patient A'),
        ('patient-b', 'Patient B', 'Patient B'),
        ('patient-unused', 'Patient Unused', 'Patient Unused');
      INSERT INTO sales_invoices VALUES
        ('sa', 'patient-a', 'ph-a', 'completed'),
        ('sb', 'patient-b', 'ph-b', 'completed');
    `);
  });

  afterEach(() => mockDb.close());

  it('lets purchase-report-only users load only supplier labels referenced by their pharmacy', async () => {
    expect(await getSuppliersAction({ reportScope: true })).toEqual({
      success: true,
      data: [{ id: 1, name_ar: 'Supplier A', name_en: 'Supplier A' }],
    });

    expect(await getSuppliersAction()).toMatchObject({ success: false });
  });

  it('lets sales-report-only users load only patient labels referenced by their pharmacy', async () => {
    expect(await getPatientsAction({ reportScope: true })).toEqual({
      success: true,
      data: [{ id: 'patient-a', full_name: 'Patient A', name_en: 'Patient A' }],
    });

    expect(await getPatientsAction()).toMatchObject({ success: false });
  });

  it('does not turn report metadata mode into a general metadata bypass', async () => {
    mockUser.permissions.rep_can_view_purchases = false;
    mockUser.permissions.rep_can_view_sales = false;

    expect(await getSuppliersAction({ reportScope: true })).toMatchObject({ success: false });
    expect(await getPatientsAction({ reportScope: true })).toMatchObject({ success: false });
  });
});
