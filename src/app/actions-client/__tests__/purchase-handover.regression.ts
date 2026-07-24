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
  secureCache: { updateDrug: jest.fn(), enrich: jest.fn((rows: unknown[]) => rows) },
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));

import {
  createPurchaseInvoiceAction,
  getPurchaseInvoiceDetailsAction,
  getPurchasesReportsAction,
} from '@/app/actions-client/purchases';
import { processCheckoutAction } from '@/app/actions-client/sales';
import { getHandoverDetailsAction, getOpenShiftHandoverAction } from '@/app/actions-client/handover';

describe('purchase reports and drawer handover regressions', () => {
  beforeEach(() => {
    mockId = 0;
    mockDb = new Database(':memory:');
    mockDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
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
  });
});
