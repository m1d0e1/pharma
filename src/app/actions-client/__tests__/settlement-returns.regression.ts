import Database from 'better-sqlite3';

let mockDb: Database.Database;
let canManageInventory = true;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) =>
    mockDb.prepare(sql).all(...params)),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'owner', pharmacy_id: null })),
  hasUserPermissionSync: jest.fn((_user: unknown, key: string) =>
    key === 'can_manage_inventory' ? canManageInventory : true),
}));

jest.mock('@/lib/env', () => ({ isTauri: true }));
jest.mock('@tauri-apps/api/core', () => ({ invoke: jest.fn() }));

import {
  getDrugBatchesAction,
  getNegativeStockInvoicesAction,
  getUnsettledSalesAction,
  settleSaleItemAction,
} from '@/app/actions-client/settlement';
import { invoke } from '@tauri-apps/api/core';

describe('negative-stock settlement returns', () => {
  beforeEach(() => {
    canManageInventory = true;
    jest.clearAllMocks();
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, barcode TEXT,
        medium_unit TEXT, small_unit TEXT, has_expiry INTEGER DEFAULT 1
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity REAL, cost_price REAL, expiry_date TEXT, batch_number TEXT, created_at TEXT
      );
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, created_at TEXT, status TEXT
      );
      CREATE TABLE sales_items (
        id INTEGER PRIMARY KEY, invoice_id TEXT, drug_id INTEGER, quantity_sold REAL,
        unit TEXT, unit_price REAL, is_negative INTEGER,
        large_to_medium INTEGER DEFAULT 1, medium_to_small INTEGER DEFAULT 1
      );
      CREATE TABLE returns (id TEXT PRIMARY KEY, invoice_id TEXT, status TEXT);
      CREATE TABLE return_items (
        return_id TEXT, sale_item_id INTEGER, quantity_returned REAL, unit TEXT
      );

      INSERT INTO master_drugs
        (id, trade_name, trade_name_en, barcode, medium_unit, small_unit, has_expiry)
      VALUES (1, 'دواء', 'Drug', '123', 'blister', 'tablet', 1);
      INSERT INTO inventory VALUES
        ('batch', 1, NULL, 5, 10, '2099-12-31', 'BATCH-1', '2026-01-01'),
        ('unknown-expiry', 1, NULL, 10, 6, NULL, 'UNKNOWN', '2026-01-02');
      INSERT INTO sales_invoices VALUES
        ('partial-sale', NULL, '2026-08-25 10:00:00', 'completed'),
        ('full-sale', NULL, '2026-08-25 11:00:00', 'completed'),
        ('other-sale', NULL, '2026-08-25 12:00:00', 'completed'),
        ('draft-sale', NULL, '2026-08-25 13:00:00', 'draft');
      INSERT INTO sales_items VALUES
        (1, 'partial-sale', 1, 10, 'small', 2, 1, 10, 2),
        (2, 'full-sale', 1, 2, 'small', 2, 1, 10, 2),
        (3, 'draft-sale', 1, 1, 'large', 2, 1, 10, 2);
      INSERT INTO returns VALUES
        ('approved', 'partial-sale', 'APPROVED'),
        ('pending', 'partial-sale', 'pending'),
        ('wrong-invoice', 'other-sale', 'approved'),
        ('fully-returned', 'full-sale', 'approved');
      INSERT INTO return_items VALUES
        ('approved', 1, 1, 'blister'),
        ('pending', 1, 10, 'blister'),
        ('wrong-invoice', 1, 100, 'small'),
        ('fully-returned', 2, 2, '');
    `);
  });

  afterEach(() => mockDb.close());

  it('keeps settlement readable but blocks the stock mutation without inventory-management permission', async () => {
    canManageInventory = false;

    const result = await settleSaleItemAction(1, 'batch');

    expect(result).toEqual({
      success: false,
      error: 'Unauthorized: inventory management permission required',
    });
    expect(invoke).not.toHaveBeenCalled();
    expect((await getUnsettledSalesAction()).success).toBe(true);
  });

  it.each([
    ['invoice list', getNegativeStockInvoicesAction],
    ['batch settlement list', getUnsettledSalesAction],
  ])('reports approved returns without hiding fully returned unresolved rows in the %s', async (_name, action) => {
    const result = await action();
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);

    const partial = (result.data as any[]).find((item) => item.item_id === 1);
    expect(partial).toMatchObject({
      quantity_sold: 10,
      returned_quantity: 2,
      net_unreturned_quantity: 8,
    });

    const fullyReturned = (result.data as any[]).find((item) => item.item_id === 2);
    expect(fullyReturned).toMatchObject({
      quantity_sold: 2,
      returned_quantity: 2,
      net_unreturned_quantity: 0,
    });
  });

  it('excludes unknown-expiry stock from settlement availability for expiry-tracked drugs', async () => {
    const unsettled = await getUnsettledSalesAction();
    expect(unsettled.success).toBe(true);
    expect((unsettled.data as any[]).find((item) => item.item_id === 1)).toMatchObject({
      current_stock_balance: 5,
    });

    const batches = await getDrugBatchesAction(1);
    expect(batches).toEqual({
      success: true,
      data: [expect.objectContaining({ inventory_id: 'batch', quantity: 5 })],
    });
  });
});
