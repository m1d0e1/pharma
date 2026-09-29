/** @jest-environment node */

import Database from 'better-sqlite3';

let mockDb: Database.Database;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'unused-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { updateDrug: jest.fn(), getDrug: jest.fn() },
}));

jest.mock('@/app/actions-client/finance', () => ({
  requireOpenShiftId: jest.fn(async () => 'shift-1'),
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));

import { getReturnsAction } from '@/app/actions-client/returns';
import { getPurchaseReturnsAction } from '@/app/actions-client/purchases';

describe('returns history completeness', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, full_name TEXT);
      CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT);
      CREATE TABLE master_drugs (id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT);
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY, patient_id TEXT, total_amount REAL, created_at TEXT
      );
      CREATE TABLE returns (
        id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, pharmacy_id TEXT,
        total_refund REAL, refund_method TEXT, status TEXT, created_at TEXT
      );
      CREATE TABLE return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT,
        drug_name TEXT, quantity_returned REAL, unit_price REAL, sale_item_id INTEGER,
        unit TEXT, drug_id INTEGER, total_price REAL
      );
      CREATE TABLE suppliers (id INTEGER PRIMARY KEY, name_ar TEXT);
      CREATE TABLE purchase_invoices (
        id TEXT PRIMARY KEY, supplier_id INTEGER, user_id TEXT, pharmacy_id TEXT,
        invoice_number TEXT, invoice_date TEXT, total_amount REAL, payment_method TEXT,
        created_at TEXT
      );
      CREATE TABLE purchase_returns (
        id TEXT PRIMARY KEY, purchase_invoice_id TEXT, supplier_id INTEGER, user_id TEXT,
        total_amount REAL, refund_method TEXT, status TEXT, created_at TEXT
      );
      CREATE TABLE purchase_return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_return_id TEXT
      );

      INSERT INTO users VALUES ('owner-1', 'Owner');
      INSERT INTO suppliers VALUES (1, 'Supplier');
    `);

    const insertSaleInvoice = mockDb.prepare(
      'INSERT INTO sales_invoices (id, total_amount, created_at) VALUES (?, 10, ?)'
    );
    const insertSaleReturn = mockDb.prepare(
      "INSERT INTO returns (id, invoice_id, user_id, pharmacy_id, total_refund, refund_method, status, created_at) VALUES (?, ?, 'owner-1', 'ph-1', 10, 'cash', 'approved', ?)"
    );
    const insertPurchaseInvoice = mockDb.prepare(
      "INSERT INTO purchase_invoices (id, supplier_id, user_id, pharmacy_id, invoice_number, invoice_date, total_amount, payment_method, created_at) VALUES (?, 1, 'owner-1', 'ph-1', ?, '2026-09-01', 10, 'cash', ?)"
    );
    const insertPurchaseReturn = mockDb.prepare(
      "INSERT INTO purchase_returns (id, purchase_invoice_id, supplier_id, user_id, total_amount, refund_method, status, created_at) VALUES (?, ?, 1, 'owner-1', 10, 'cash', 'completed', ?)"
    );

    for (let index = 0; index < 101; index += 1) {
      const stamp = `2026-09-${String((index % 27) + 1).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00`;
      const saleId = `sale-${index}`;
      const saleReturnId = `sale-return-${index}`;
      insertSaleInvoice.run(saleId, stamp);
      insertSaleReturn.run(saleReturnId, saleId, stamp);

      const purchaseId = `purchase-${index}`;
      const purchaseReturnId = `purchase-return-${index}`;
      insertPurchaseInvoice.run(purchaseId, `INV-${index}`, stamp);
      insertPurchaseReturn.run(purchaseReturnId, purchaseId, stamp);
    }
  });

  afterEach(() => mockDb.close());

  it('pages sales-return history without truncating older records', async () => {
    const first = await (getReturnsAction as any)({ limit: 50, offset: 0 });
    const second = await (getReturnsAction as any)({ limit: 50, offset: 50 });
    const last = await (getReturnsAction as any)({ limit: 50, offset: 100 });

    expect(first).toMatchObject({ success: true, hasMore: true });
    expect(first.data).toHaveLength(50);
    expect(second).toMatchObject({ success: true, hasMore: true });
    expect(second.data).toHaveLength(50);
    expect(last).toMatchObject({ success: true, hasMore: false });
    expect(last.data).toHaveLength(1);
    expect(new Set([...first.data, ...second.data, ...last.data].map((row: any) => row.id))).toHaveProperty('size', 101);
  });

  it('pages purchase-return history without truncating older records', async () => {
    const first = await (getPurchaseReturnsAction as any)({ limit: 50, offset: 0 });
    const second = await (getPurchaseReturnsAction as any)({ limit: 50, offset: 50 });
    const last = await (getPurchaseReturnsAction as any)({ limit: 50, offset: 100 });

    expect(first).toMatchObject({ success: true, hasMore: true });
    expect(first.data).toHaveLength(50);
    expect(second).toMatchObject({ success: true, hasMore: true });
    expect(second.data).toHaveLength(50);
    expect(last).toMatchObject({ success: true, hasMore: false });
    expect(last.data).toHaveLength(1);
    expect(new Set([...first.data, ...second.data, ...last.data].map((row: any) => row.id))).toHaveProperty('size', 101);
  });
});
