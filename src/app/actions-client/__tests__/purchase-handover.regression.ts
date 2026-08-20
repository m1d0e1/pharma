import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

let mockDb: Database.Database;
let mockId = 0;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
  generateId: jest.fn(() => `test-id-${++mockId}`),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'owner', pharmacy_id: null })),
  hasUserPermissionSync: jest.fn(() => true),
  verifyPassword: jest.fn(async () => true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    getAllDrugs: jest.fn(() => []),
    updateDrug: jest.fn(),
    enrich: jest.fn((rows: unknown[]) => rows),
  },
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.unmock('@/app/actions-client/inventory');

import {
  createPurchaseReturnAction,
  createPurchaseInvoiceAction,
  getPurchaseInvoiceDetailsAction,
  getPurchasesReportsAction,
} from '@/app/actions-client/purchases';
import { barcodeLookupAction, processCheckoutAction, searchDrugsAction } from '@/app/actions-client/sales';
import { addOpeningBalanceAction } from '@/app/actions-client/inventory';
import { getHandoverDetailsAction, getOpenShiftHandoverAction, getShiftCreditSalesAction } from '@/app/actions-client/handover';

describe('purchase reports and drawer handover regressions', () => {
  beforeEach(() => {
    mockId = 0;
    mockDb = new Database(':memory:');
    mockDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
    const purchaseItemColumns = mockDb.prepare('PRAGMA table_info(purchase_invoice_items)').all() as any[];
    if (!purchaseItemColumns.some(column => column.name === 'barcode')) {
      mockDb.exec('ALTER TABLE purchase_invoice_items ADD COLUMN barcode TEXT');
    }
    mockDb.pragma('foreign_keys = ON');
    mockDb.prepare(`
      INSERT INTO suppliers (id, name_ar, balance) VALUES (1, 'Test Supplier', 0)
    `).run();
    mockDb.prepare(`
      INSERT INTO master_drugs (
        id, trade_name, trade_name_en, barcode, official_price,
        large_to_medium, medium_to_small, has_expiry
      ) VALUES (9001, 'Test Drug', 'Test Drug', '6220000000001', 20, 1, 1, 1)
    `).run();
  });

  afterEach(() => mockDb.close());

  it('creates a purchase then lists and opens it from purchase reports', async () => {
    const created = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'PO-REPORT-1',
      invoice_date: '2026-07-24',
      payment_method: 'credit',
      status: 'completed',
      cart: [{
        id: 9001,
        quantity: 3,
        unit_id: 1,
        expiry_date: '2028-01-31',
        cost_price: 10,
        selling_price: 15,
        bonus_quantity: 1,
        tax_percent: 0,
        discount_percent: 0,
        strips_per_box: 1,
      }],
    });

    expect(created.success).toBe(true);
    const report = await getPurchasesReportsAction({ invoiceNumber: 'PO-REPORT-1' });
    expect(report).toMatchObject({ success: true, invoiceCount: 1, totalSelling: 45 });

    const details = await getPurchaseInvoiceDetailsAction(created.id!);
    expect(details).toMatchObject({
      success: true,
      data: [expect.objectContaining({
        trade_name: 'Test Drug',
        barcode: '6220000000001',
        cost_price: 10,
        selling_price: 15,
        expiry_date: '2028-01-31',
      })],
    });
  });

  it('links checkout to the open shift and calculates live drawer cash', async () => {
    mockDb.prepare(`
      INSERT INTO shifts (id, user_id, start_time, starting_cash, status)
      VALUES ('shift-1', 'admin', '2020-01-01 00:00:00', 100, 'open')
    `).run();
    mockDb.prepare(`
      INSERT INTO inventory (
        id, drug_id, quantity, local_selling_price, cost_price,
        expiry_date, strips_per_box
      ) VALUES ('stock-1', 9001, 10, 50, 10, '2099-12-31', 1)
    `).run();

    const checkout = await processCheckoutAction({
      items: [{
        drug_id: 9001,
        inventory_id: 'stock-1',
        quantity_sold: 1,
        unit_price: 50,
        selected_unit: 'large',
      }],
      payment_method: 'cash',
      status: 'completed',
    });
    expect(checkout.success).toBe(true);

    const saleId = checkout.data!.sale_id;
    expect((mockDb.prepare('SELECT shift_id FROM sales_invoices WHERE id = ?').get(saleId) as any).shift_id)
      .toBe('shift-1');

    mockDb.exec(`
      INSERT INTO sales_invoices (id, user_id, shift_id, total_amount, payment_method, status)
      VALUES
        ('visa-sale', 'admin', 'shift-1', 30, 'visa', 'completed'),
        ('credit-sale', 'admin', 'shift-1', 40, 'credit', 'completed'),
        ('draft-sale', 'admin', 'shift-1', 999, 'cash', 'draft');

      INSERT INTO returns (id, invoice_id, user_id, shift_id, total_refund, refund_method, status)
      VALUES
        ('cash-return', '${saleId}', 'admin', 'shift-1', 10, 'cash', 'approved'),
        ('pending-return', '${saleId}', 'admin', 'shift-1', 100, 'cash', 'pending'),
        ('account-return', '${saleId}', 'admin', 'shift-1', 7, 'patient_account', 'approved');

      INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, date)
      VALUES
        ('receipt', 'admin', 'shift-1', 'receipt', 'manual', 5, '2026-07-24'),
        ('legacy-receipt', 'admin', 'shift-1', 'in', 'purchase_return', 11, '2026-07-24'),
        ('expense', 'admin', 'shift-1', 'disbursement', 'expense', 3, '2026-07-24'),
        ('unlinked-receipt', 'admin', NULL, 'receipt', 'manual', 4, '2026-07-24');
    `);

    const openShift = await getOpenShiftHandoverAction();
    expect(openShift).toMatchObject({ success: true, data: { id: 'shift-1' } });

    mockDb.exec(`
      INSERT INTO shifts (id, user_id, start_time, starting_cash, status)
      VALUES ('shift-2', 'admin', '2020-01-02 00:00:00', 50, 'closed');
      INSERT INTO sales_invoices (id, user_id, shift_id, total_amount, payment_method, status)
      VALUES ('other-shift-credit', 'admin', 'shift-2', 90, 'credit', 'completed');
    `);

    const details = await getHandoverDetailsAction('shift-1');
    expect(details).toMatchObject({
      success: true,
      data: {
        starting_cash: 100,
        cash_sales: 50,
        visa_sales: 30,
        credit_sales: 40,
        returns: 10,
        receipts: 20,
        disbursements: 3,
        expected_cash: 157,
      },
    });

    const shift1Credit = await getShiftCreditSalesAction('shift-1');
    expect(shift1Credit.success).toBe(true);
    expect(shift1Credit.data).toHaveLength(1);
    expect(shift1Credit.data[0]).toMatchObject({
      id: 'credit-sale',
      total_amount: 40,
      credit_amount: 40,
    });

    const shift2Credit = await getShiftCreditSalesAction('shift-2');
    expect(shift2Credit.success).toBe(true);
    expect(shift2Credit.data).toHaveLength(1);
    expect(shift2Credit.data[0]).toMatchObject({
      id: 'other-shift-credit',
      total_amount: 90,
      credit_amount: 90,
    });
  });

  it('keeps purchase lots separate by pharmacy, expiry, and batch and links each invoice line', async () => {
    const first = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'LOT-A',
      status: 'completed',
      cart: [{
        id: 9001, quantity: 2, expiry_date: '2028-01-31', cost_price: 10, selling_price: 15,
        bonus_quantity: 0, tax_percent: 0, discount_percent: 0, strips_per_box: 1,
      }],
    });
    const second = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'LOT-B',
      status: 'completed',
      cart: [{
        id: 9001, quantity: 3, expiry_date: '2028-01-31', cost_price: 11, selling_price: 16,
        bonus_quantity: 0, tax_percent: 0, discount_percent: 0, strips_per_box: 1,
      }],
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    const lots = mockDb.prepare(`
      SELECT id, batch_number, quantity
      FROM inventory
      WHERE drug_id = 9001
      ORDER BY batch_number
    `).all() as any[];
    expect(lots).toMatchObject([
      { batch_number: 'LOT-A', quantity: 2 },
      { batch_number: 'LOT-B', quantity: 3 },
    ]);

    const linkedLines = mockDb.prepare(`
      SELECT pii.inventory_id, i.batch_number
      FROM purchase_invoice_items pii
      JOIN inventory i ON i.id = pii.inventory_id
      WHERE pii.invoice_id IN (?, ?)
      ORDER BY i.batch_number
    `).all(first.id, second.id) as any[];
    expect(linkedLines).toEqual([
      expect.objectContaining({ batch_number: 'LOT-A', inventory_id: expect.any(String) }),
      expect.objectContaining({ batch_number: 'LOT-B', inventory_id: expect.any(String) }),
    ]);
  });

  it('excludes expired and other-pharmacy lots from search, barcode lookup, and checkout', async () => {
    mockDb.exec(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, cost_price, expiry_date)
      VALUES
        ('default-valid', NULL, 9001, 3, 15, 10, '2099-12-31'),
        ('default-expired', NULL, 9001, 7, 14, 9, '2020-01-01'),
        ('other-valid', 'other-pharmacy', 9001, 20, 13, 8, '2099-12-31');
    `);

    const search = await searchDrugsAction('Test Drug');
    expect(search).toMatchObject({
      success: true,
      data: [expect.objectContaining({
        id: 9001,
        total_stock: 3,
        batches: [expect.objectContaining({ inventory_id: 'default-valid', quantity: 3 })],
      })],
    });

    const barcode = await barcodeLookupAction('6220000000001');
    expect(barcode).toMatchObject({
      success: true,
      data: expect.objectContaining({ inventory_id: 'default-valid', quantity: 3 }),
    });

    const checkout = await processCheckoutAction({
      items: [{
        drug_id: 9001,
        inventory_id: 'other-valid',
        quantity_sold: 1,
        unit_price: 13,
        selected_unit: 'large',
      }],
      payment_method: 'cash',
      status: 'completed',
    });
    expect(checkout.success).toBe(false);
  });

  it('stores opening-balance retail price in the POS selling-price column', async () => {
    const result = await addOpeningBalanceAction({
      drug_id: 9001,
      quantity: 4,
      cost_price: 10,
      unit_price: 17,
      expiry_date: '2099-12-31',
    });
    expect(result.success).toBe(true);

    const row = mockDb.prepare(`
      SELECT local_selling_price, unit_price
      FROM inventory
      WHERE batch_number LIKE 'OPEN-%'
    `).get() as any;
    expect(row).toMatchObject({ local_selling_price: 17, unit_price: 0 });
  });

  it('rejects cumulative, mismatched, and duplicate purchase-return lines before changing stock', async () => {
    const purchase = await createPurchaseInvoiceAction({
      supplier_id: 1,
      invoice_number: 'RETURN-SOURCE',
      payment_method: 'credit',
      status: 'completed',
      cart: [{
        id: 9001, quantity: 3, expiry_date: '2099-12-31', cost_price: 10, selling_price: 15,
        bonus_quantity: 0, tax_percent: 0, discount_percent: 0, strips_per_box: 1,
      }],
    });
    expect(purchase.success).toBe(true);

    const source = mockDb.prepare(`
      SELECT pii.id, pii.inventory_id
      FROM purchase_invoice_items pii
      WHERE pii.invoice_id = ?
    `).get(purchase.id) as any;
    const baseLine = {
      purchase_invoice_item_id: source.id,
      inventory_id: source.inventory_id,
      drug_id: 9001,
      drug_name: 'Test Drug',
      quantity: 2,
      unit_price: 10,
      unit: 'large',
    };

    const firstReturn = await createPurchaseReturnAction({
      purchase_invoice_id: purchase.id!,
      supplier_id: 1,
      reason: 'damaged',
      refund_method: 'credit',
      items: [baseLine],
    });
    expect(firstReturn.success).toBe(true);

    const excessive = await createPurchaseReturnAction({
      purchase_invoice_id: purchase.id!,
      supplier_id: 1,
      reason: 'repeat',
      refund_method: 'credit',
      items: [baseLine],
    });
    expect(excessive).toMatchObject({ success: false, error: expect.stringContaining('invoice remainder') });

    const mismatched = await createPurchaseReturnAction({
      purchase_invoice_id: purchase.id!,
      supplier_id: 1,
      reason: 'wrong drug',
      refund_method: 'credit',
      items: [{ ...baseLine, quantity: 1, drug_id: 9002 }],
    });
    expect(mismatched).toMatchObject({ success: false, error: expect.stringContaining('does not match') });

    const duplicate = await createPurchaseReturnAction({
      purchase_invoice_id: purchase.id!,
      supplier_id: 1,
      reason: 'duplicate',
      refund_method: 'credit',
      items: [{ ...baseLine, quantity: 0.5 }, { ...baseLine, quantity: 0.5 }],
    });
    expect(duplicate).toMatchObject({ success: false, error: expect.stringContaining('Duplicate') });

    expect((mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get(source.inventory_id) as any).quantity).toBe(1);
    expect((mockDb.prepare('SELECT COUNT(*) AS count FROM purchase_returns').get() as any).count).toBe(1);
  });
});
