import Database from 'better-sqlite3';

let mockDb: Database.Database;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) =>
    mockDb.prepare(sql).all(...params)),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'owner', pharmacy_id: null })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));

import {
  getNegativeStockInvoicesAction,
  getUnsettledSalesAction,
} from '@/app/actions-client/settlement';

describe('negative-stock settlement returns', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, barcode TEXT
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity REAL, expiry_date TEXT
      );
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, created_at TEXT
      );
      CREATE TABLE sales_items (
        id INTEGER PRIMARY KEY, invoice_id TEXT, drug_id INTEGER, quantity_sold REAL,
        unit TEXT, unit_price REAL, is_negative INTEGER
      );
      CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, status TEXT);
      CREATE TABLE return_items (
        return_id TEXT, sale_item_id INTEGER, quantity_returned REAL
      );

      INSERT INTO master_drugs VALUES (1, 'دواء', 'Drug', '123');
      INSERT INTO inventory VALUES ('batch', 1, NULL, 5, '2099-12-31');
      INSERT INTO sales_invoices VALUES
        ('partial-sale', NULL, '2026-08-25 10:00:00'),
        ('full-sale', NULL, '2026-08-25 11:00:00'),
        ('other-sale', NULL, '2026-08-25 12:00:00');
      INSERT INTO sales_items VALUES
        (1, 'partial-sale', 1, 4, 'small', 2, 1),
        (2, 'full-sale', 1, 2, 'small', 2, 1);
      INSERT INTO returns VALUES
        ('approved', 'partial-sale', 'APPROVED'),
        ('completed', 'partial-sale', 'completed'),
        ('pending', 'partial-sale', 'pending'),
        ('wrong-invoice', 'other-sale', 'approved'),
        ('fully-returned', 'full-sale', 'approved');
      INSERT INTO return_items VALUES
        ('approved', 1, 1),
        ('completed', 1, 1),
        ('pending', 1, 1),
        ('wrong-invoice', 1, 100),
        ('fully-returned', 2, 2);
    `);
  });

  afterEach(() => mockDb.close());

  it.each([
    ['invoice list', getNegativeStockInvoicesAction],
    ['batch settlement list', getUnsettledSalesAction],
  ])('reports approved returns without hiding fully returned unresolved rows in the %s', async (_name, action) => {
    const result = await action();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);

    const partial = (result.data as any[]).find((item) => item.item_id === 1);
    expect(partial).toMatchObject({
      quantity_sold: 4,
      returned_quantity: 2,
      net_unreturned_quantity: 2,
    });

    const fullyReturned = (result.data as any[]).find((item) => item.item_id === 2);
    expect(fullyReturned).toMatchObject({
      quantity_sold: 2,
      returned_quantity: 2,
      net_unreturned_quantity: 0,
    });
  });
});
