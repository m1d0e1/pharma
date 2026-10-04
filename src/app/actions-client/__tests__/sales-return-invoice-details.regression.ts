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
  generateId: jest.fn(() => 'generated-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/app/actions-client/finance', () => ({
  requireOpenShiftId: jest.fn(),
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));

import {
  getInvoiceForReturnAction,
  getSalesInvoicesByDateAction,
  searchRecentReturnInvoicesAction,
} from '@/app/actions-client/returns';

describe('sales return invoice detail quantities', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, full_name TEXT);
      CREATE TABLE patients (id TEXT PRIMARY KEY, full_name TEXT);
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, patient_id TEXT, user_id TEXT,
        total_amount REAL, discount_amount REAL DEFAULT 0, payment_method TEXT,
        status TEXT, created_at TEXT
      );
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT,
        active_ingredient TEXT, large_to_medium INTEGER, medium_to_small INTEGER,
        large_unit TEXT,
        medium_unit TEXT, small_unit TEXT, barcode TEXT
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, drug_id INTEGER,
        strips_per_box INTEGER, medium_to_small INTEGER, expiry_date TEXT, barcode TEXT
      );
      CREATE TABLE sales_items (
        id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER,
        quantity_sold REAL, unit_price REAL, unit TEXT,
        large_to_medium INTEGER, medium_to_small INTEGER
      );
      CREATE TABLE returns (
        id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, pharmacy_id TEXT,
        reason TEXT, total_refund REAL, refund_method TEXT, status TEXT
      );
      CREATE TABLE return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT,
        drug_id INTEGER, drug_name TEXT, quantity_returned REAL, unit_price REAL,
        sale_item_id INTEGER, unit TEXT, total_price REAL
      );

      INSERT INTO users VALUES ('owner-1', 'Owner');
      INSERT INTO sales_invoices (
        id, pharmacy_id, patient_id, user_id, total_amount, discount_amount,
        payment_method, status, created_at
      ) VALUES ('sale-units', 'ph-1', NULL, 'owner-1', 10, 0, 'cash', 'completed', '2026-09-29 10:00:00');
      INSERT INTO master_drugs VALUES (
        101, 'Unit Drug', 'Unit Drug', NULL, 10, 2, 'case', 'strip', 'tablet', NULL
      );
      INSERT INTO inventory VALUES ('lot-1', 'ph-1', 101, 10, 2, '2030-01-01', NULL);
      INSERT INTO sales_items VALUES (
        1, 'sale-units', 'lot-1', 101, 10, 1, 'small', 10, 2
      );
      INSERT INTO returns VALUES (
        'prior-return', 'sale-units', 'owner-1', 'ph-1', 'legacy selected unit', 2, 'cash', 'approved'
      );
      INSERT INTO return_items (
        return_id, inventory_id, drug_id, drug_name, quantity_returned,
        unit_price, sale_item_id, unit, total_price
      ) VALUES ('prior-return', 'lot-1', 101, 'Unit Drug', 1, 2, 1, 'medium', 2);
    `);
  });

  afterEach(() => mockDb.close());

  it('converts finalized prior return rows into the original sale unit before exposing the remainder', async () => {
    const result = await getInvoiceForReturnAction('sale-units');

    expect(result).toMatchObject({ success: true });
    const item = (result as any).data.items[0];
    expect(item).toMatchObject({
      quantity_sold: 10,
      unit: 'small',
      large_to_medium: 10,
      medium_to_small: 2,
      large_unit: 'case',
      medium_unit: 'strip',
      small_unit: 'tablet',
      returned_quantity: 2,
    });
    expect(item.quantity_sold - item.returned_quantity).toBe(8);
  });

  it('treats a missing historical return unit as the original sale unit', async () => {
    mockDb.prepare("UPDATE return_items SET quantity_returned = 3, unit = NULL WHERE return_id = 'prior-return'").run();

    const result = await getInvoiceForReturnAction('sale-units');

    expect(result).toMatchObject({ success: true });
    const item = (result as any).data.items[0];
    expect(item.returned_quantity).toBe(3);
    expect(item.quantity_sold - item.returned_quantity).toBe(7);
  });


  it('hides a fully returned invoice from the date list when legacy return units differ from the sale unit', async () => {
    mockDb.prepare("UPDATE return_items SET quantity_returned = 5, unit = 'medium' WHERE return_id = 'prior-return'").run();

    const result = await getSalesInvoicesByDateAction('2026-09-29');

    expect(result).toMatchObject({ success: true });
    expect((result as any).data).toEqual([]);
  });

  it('hides a fully returned invoice from free-text search using the same unit-aware remainder rule', async () => {
    mockDb.prepare("UPDATE return_items SET quantity_returned = 5, unit = 'medium' WHERE return_id = 'prior-return'").run();

    const result = await searchRecentReturnInvoicesAction('sale-units');

    expect(result).toMatchObject({ success: true });
    expect((result as any).data).toEqual([]);
  });

  it('keeps a partially returned invoice searchable', async () => {
    mockDb.prepare("UPDATE return_items SET quantity_returned = 4, unit = 'medium' WHERE return_id = 'prior-return'").run();

    const result = await searchRecentReturnInvoicesAction('sale-units');

    expect(result).toMatchObject({ success: true });
    expect((result as any).data.map((row: any) => row.id)).toEqual(['sale-units']);
  });


  it('treats NULL and blank historical units as the original sale unit in date-list returnability', async () => {
    mockDb.prepare("UPDATE return_items SET quantity_returned = 1, unit = NULL WHERE return_id = 'prior-return'").run();
    const nullUnit = await getSalesInvoicesByDateAction('2026-09-29');
    expect((nullUnit as any).data.map((row: any) => row.id)).toEqual(['sale-units']);

    mockDb.prepare("UPDATE return_items SET unit = '   ' WHERE return_id = 'prior-return'").run();
    const blankUnit = await getSalesInvoicesByDateAction('2026-09-29');
    expect((blankUnit as any).data.map((row: any) => row.id)).toEqual(['sale-units']);
  });

});
