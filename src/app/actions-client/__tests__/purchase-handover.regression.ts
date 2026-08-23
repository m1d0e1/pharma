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
jest.unmock('@/app/actions-client/patients');

import {
  createPurchaseReturnAction,
  createPurchaseInvoiceAction,
  addSupplierPaymentAction,
  getPurchaseInvoiceDetailsAction,
  getPurchasesReportsAction,
} from '@/app/actions-client/purchases';
import { barcodeLookupAction, processCheckoutAction, searchDrugsAction } from '@/app/actions-client/sales';
import { addOpeningBalanceAction } from '@/app/actions-client/inventory';
import { getHandoverDetailsAction, getOpenShiftHandoverAction, getShiftCreditSalesAction, processHandoverAction } from '@/app/actions-client/handover';
import { createCashMovementAction } from '@/app/actions-client/finance';
import { getCurrentShiftAction, getShiftsAction } from '@/app/actions-client/shifts';
import { getShiftReportAction } from '@/app/actions-client/reports';
import { updatePatientWalletAction } from '@/app/actions-client/patients';
import { closeDeliveryInvoiceAction } from '@/app/actions-client/delivery';
import { addExpenseAction } from '@/app/actions-client/expenses';

describe('purchase reports and drawer handover regressions', () => {
  beforeEach(() => {
    mockId = 0;
    mockDb = new Database(':memory:');
    mockDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/011_shift_cash_difference_account.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/012_shortages_pharmacy_scope.sql', 'utf8'));
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
        ('unlinked-credit', 'admin', NULL, 500, 'credit', 'completed'),
        ('unlinked-cash', 'admin', NULL, 600, 'cash', 'completed'),
        ('unlinked-visa', 'admin', NULL, 700, 'visa', 'completed'),
        ('draft-sale', 'admin', 'shift-1', 999, 'cash', 'draft');

      INSERT INTO returns (id, invoice_id, user_id, shift_id, total_refund, refund_method, status)
      VALUES
        ('cash-return', '${saleId}', 'admin', 'shift-1', 10, 'cash', 'approved'),
        ('pending-return', '${saleId}', 'admin', 'shift-1', 100, 'cash', 'pending'),
        ('account-return', '${saleId}', 'admin', 'shift-1', 7, 'patient_account', 'approved'),
        ('unlinked-return', '${saleId}', 'admin', NULL, 800, 'cash', 'approved');

      INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, date)
      VALUES
        ('receipt', 'admin', 'shift-1', 'receipt', 'manual', 5, '2026-07-24'),
        ('legacy-receipt', 'admin', 'shift-1', 'in', 'purchase_return', 11, '2026-07-24'),
        ('expense', 'admin', 'shift-1', 'disbursement', 'expense', 3, '2026-07-24'),
        ('unlinked-receipt', 'admin', NULL, 'receipt', 'manual', 4, '2026-07-24'),
        ('unlinked-expense', 'admin', NULL, 'disbursement', 'expense', 900, '2026-07-24');
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
        receipts: 16,
        disbursements: 3,
        expected_cash: 153,
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

  it('rejects completed checkout without creating a hidden shift', async () => {
    mockDb.prepare(`
      INSERT INTO inventory (id, drug_id, quantity, local_selling_price, cost_price, expiry_date)
      VALUES ('no-shift-stock', 9001, 2, 15, 10, '2099-12-31')
    `).run();

    const checkout = await processCheckoutAction({
      items: [{
        drug_id: 9001,
        inventory_id: 'no-shift-stock',
        quantity_sold: 1,
        unit_price: 15,
        selected_unit: 'large',
      }],
      payment_method: 'cash',
      status: 'completed',
    });

    expect(checkout).toMatchObject({ success: false, error: expect.stringContaining('فتح وردية') });
    expect((mockDb.prepare('SELECT COUNT(*) AS total FROM shifts').get() as any).total).toBe(0);
    expect((mockDb.prepare('SELECT COUNT(*) AS total FROM sales_invoices').get() as any).total).toBe(0);
  });

  it('links cash movements to the open shift and closes it through one reconciled handover', async () => {
    mockDb.exec(`
      INSERT INTO users (id, username, password_hash, role, full_name)
      VALUES ('receiver', 'receiver', 'hash', 'admin', 'Receiver');
      INSERT INTO shifts (id, user_id, start_time, starting_cash, status)
      VALUES ('cash-shift', 'admin', '2026-08-22 08:00:00', 100, 'open');
      INSERT INTO sales_invoices (id, user_id, shift_id, total_amount, payment_method, status)
      VALUES
        ('cash-sale', 'admin', 'cash-shift', 50, 'cash', 'completed'),
        ('delivery-sale', 'admin', 'cash-shift', 30, 'delivery', 'approved'),
        ('visa-sale', 'admin', 'cash-shift', 99, 'visa', 'completed');
      INSERT INTO returns (id, invoice_id, user_id, shift_id, total_refund, refund_method, status)
      VALUES ('cash-return', 'cash-sale', 'admin', 'cash-shift', 10, 'cash', 'approved');
    `);

    const receipt = await createCashMovementAction({
      type: 'receipt',
      category: 'pharmacy',
      amount: 5,
      date: '2026-08-22',
      notes: 'وردية حالية',
    });
    expect(receipt.success).toBe(true);
    expect((mockDb.prepare('SELECT shift_id FROM cash_movements WHERE id = ?').get(receipt.id) as any).shift_id)
      .toBe('cash-shift');

    mockDb.exec(`
      INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, date)
      VALUES
        ('legacy-in', 'admin', 'cash-shift', 'in', 'other', 2, '2026-08-22'),
        ('legacy-out', 'admin', 'cash-shift', 'out', 'other', 1, '2026-08-22');
    `);
    const before = await getHandoverDetailsAction('cash-shift');
    expect(before).toMatchObject({
      success: true,
      data: {
        cash_sales: 50,
        returns: 10,
        receipts: 7,
        disbursements: 1,
        expected_cash: 146,
      },
    });

    const handover = await processHandoverAction({
      shiftId: 'cash-shift',
      actualCash: 136,
      transferAmount: 130,
      transferTargetId: '',
      transferTargetType: 'treasury',
      receiverUsername: 'receiver',
      receiverPasswordHash: 'password',
      notes: 'نهاية الوردية',
    });
    expect(handover).toMatchObject({ success: true, difference: -10, remainingCash: 6, status: 'discrepancy' });
    expect(mockDb.prepare('SELECT ending_cash, status FROM shifts WHERE id = ?').get('cash-shift'))
      .toMatchObject({ ending_cash: 6, status: 'discrepancy' });
    expect((mockDb.prepare("SELECT COUNT(*) AS total FROM cash_movements WHERE shift_id = ? AND category = 'handover'").get('cash-shift') as any).total)
      .toBe(1);
    expect((mockDb.prepare("SELECT COUNT(*) AS total FROM daily_journals WHERE description LIKE 'تسليم درج:%'").get() as any).total)
      .toBe(0);

    const shifts = await getShiftsAction({ status: 'all' });
    expect(shifts.data?.find((shift: any) => shift.id === 'cash-shift')).toMatchObject({
      expected_cash_amount: 16,
      cash_difference: -10,
    });
    expect(await getShiftReportAction('cash-shift')).toMatchObject({
      success: true,
      data: {
        summary: {
          cashSales: 50,
          cashReturns: 10,
          cashReceipts: 7,
          cashDisbursements: 131,
          cashHandover: 130,
          expectedCash: 16,
          actualCash: 6,
          difference: -10,
        },
      },
    });
    const shiftCount = (mockDb.prepare('SELECT COUNT(*) AS total FROM shifts').get() as any).total;
    expect(await getCurrentShiftAction()).toMatchObject({ success: true, data: null, has_open_shift: false });
    expect((mockDb.prepare('SELECT COUNT(*) AS total FROM shifts').get() as any).total).toBe(shiftCount);

    const afterClose = await createCashMovementAction({
      type: 'receipt',
      category: 'pharmacy',
      amount: 1,
      date: '2026-08-22',
    });
    expect(afterClose).toMatchObject({ success: false, error: expect.stringContaining('فتح وردية') });
  });

  it('links every user-triggered cash path to the collecting shift', async () => {
    mockDb.exec(`
      INSERT INTO patients (id, full_name, wallet_balance)
      VALUES ('wallet-patient', 'Wallet Patient', 0);
      INSERT INTO shifts (id, user_id, start_time, ending_cash, status)
      VALUES ('delivery-origin-shift', 'admin', '2026-08-21 08:00:00', 0, 'closed');
      INSERT INTO shifts (id, user_id, start_time, starting_cash, status)
      VALUES ('collecting-shift', 'admin', '2026-08-22 08:00:00', 0, 'open');
      INSERT INTO sales_invoices (
        id, user_id, patient_id, shift_id, total_amount, payment_method, status
      ) VALUES (
        'delivery-invoice', 'admin', 'wallet-patient', 'delivery-origin-shift', 20, 'delivery', 'completed'
      );
    `);

    expect(await updatePatientWalletAction('wallet-patient', 25, 'cash top-up')).toMatchObject({ success: true, balance: 25 });
    expect(await addSupplierPaymentAction({ supplier_id: 1, amount: 10, payment_method: 'cash' })).toMatchObject({ success: true });
    expect(await addExpenseAction({ category: 'rent', amount: 3, description: 'cash expense', date: '2026-08-22' })).toMatchObject({ success: true });
    expect(await closeDeliveryInvoiceAction('delivery-invoice', 2)).toMatchObject({ success: true });
    expect(await closeDeliveryInvoiceAction('delivery-invoice', 2)).toMatchObject({ success: false });

    expect(mockDb.prepare(`
      SELECT category, type, amount, shift_id
      FROM cash_movements
      ORDER BY category
    `).all()).toEqual([
      { category: 'accounts_payable', type: 'disbursement', amount: 10, shift_id: 'collecting-shift' },
      { category: 'delivery', type: 'receipt', amount: 22, shift_id: 'collecting-shift' },
      { category: 'operating_expenses', type: 'disbursement', amount: 3, shift_id: 'collecting-shift' },
      { category: 'patient_wallet', type: 'receipt', amount: 25, shift_id: 'collecting-shift' },
    ]);

    expect(await getHandoverDetailsAction('collecting-shift')).toMatchObject({
      success: true,
      data: {
        cash_sales: 0,
        receipts: 47,
        disbursements: 13,
        expected_cash: 34,
      },
    });
  });

  it('adds a drug to shortages when checkout sells its last valid unit without duplicates', async () => {
    mockDb.prepare(`
      INSERT INTO shifts (id, user_id, start_time, starting_cash, status)
      VALUES ('shortage-shift', 'admin', CURRENT_TIMESTAMP, 0, 'open')
    `).run();
    mockDb.prepare('UPDATE master_drugs SET default_purchase_qty = 6 WHERE id = 9001').run();
    mockDb.exec(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, cost_price, expiry_date)
      VALUES
        ('last-valid-unit', NULL, 9001, 1, 15, 10, '2099-12-31'),
        ('expired-stock', NULL, 9001, 12, 15, 10, '2020-01-01'),
        ('other-pharmacy-stock', 'other-pharmacy', 9001, 12, 15, 10, '2099-12-31');
    `);

    const checkout = () => processCheckoutAction({
      items: [{
        drug_id: 9001,
        inventory_id: 'last-valid-unit',
        quantity_sold: 1,
        unit_price: 15,
        selected_unit: 'large',
      }],
      payment_method: 'cash',
      status: 'completed',
    });

    expect((await checkout()).success).toBe(true);
    expect((mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('last-valid-unit') as any).quantity)
      .toBe(0);
    expect(mockDb.prepare(`
      SELECT drug_id, requested_quantity, status
      FROM shortages
      WHERE drug_id = 9001
    `).all()).toEqual([{ drug_id: 9001, requested_quantity: 6, status: 'pending' }]);

    mockDb.prepare('UPDATE inventory SET quantity = 1 WHERE id = ?').run('last-valid-unit');
    expect((await checkout()).success).toBe(true);
    expect((mockDb.prepare(`
      SELECT COUNT(*) AS total
      FROM shortages
      WHERE drug_id = 9001 AND status IN ('pending', 'ordered')
    `).get() as any).total).toBe(1);
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
    mockDb.prepare(`
      INSERT INTO shifts (id, user_id, start_time, starting_cash, status)
      VALUES ('inventory-shift', 'admin', CURRENT_TIMESTAMP, 0, 'open')
    `).run();
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
