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

let mockSession: any = { id: 'admin', role: 'owner', pharmacy_id: null };

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
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
import { getCurrentShiftAction, getShiftsAction, openShiftAction, getShiftReceiptsAction } from '@/app/actions-client/shifts';
import { createReturnAction } from '@/app/actions-client/returns';
import { getShiftReportAction } from '@/app/actions-client/reports';
import { updatePatientWalletAction } from '@/app/actions-client/patients';
import { closeDeliveryInvoiceAction } from '@/app/actions-client/delivery';
import { addExpenseAction } from '@/app/actions-client/expenses';

describe('purchase reports and drawer handover regressions', () => {
  beforeEach(() => {
    mockId = 0;
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    mockDb = new Database(':memory:');
    mockDb.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/008_patient_accounting.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/011_shift_cash_difference_account.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/012_shortages_pharmacy_scope.sql', 'utf8'));
    mockDb.exec(readFileSync('src-tauri/migrations/013_shift_handover_details.sql', 'utf8'));
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

    const visaCheckout = await processCheckoutAction({
      items: [{
        drug_id: 9001,
        inventory_id: 'stock-1',
        quantity_sold: 1,
        unit_price: 30,
        selected_unit: 'large',
      }],
      payment_method: 'visa',
      status: 'completed',
    });
    expect(visaCheckout.success).toBe(true);
    expect(mockDb.prepare(`
      SELECT a.code
      FROM journal_entries je
      JOIN accounts a ON a.id = je.account_id
      WHERE je.journal_id = (SELECT id FROM daily_journals ORDER BY rowid DESC LIMIT 1)
        AND je.type = 'debit' AND je.amount = 30
    `).get()).toEqual({ code: '1.1.4' });

    mockDb.exec(`
      INSERT INTO sales_invoices (id, user_id, shift_id, total_amount, payment_method, status)
      VALUES
        ('credit-sale', 'admin', 'shift-1', 40, 'credit', 'completed'),
        ('partial-credit', 'admin', 'shift-1', 100, 'credit', 'completed'),
        ('paid-credit', 'admin', 'shift-1', 50, 'credit', 'completed'),
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

      UPDATE sales_invoices SET paid_amount = 30, remaining_amount = 70 WHERE id = 'partial-credit';
      UPDATE sales_invoices SET paid_amount = 50, remaining_amount = 0 WHERE id = 'paid-credit';
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
        credit_sales: 110,
        returns: 10,
        receipts: 16,
        disbursements: 3,
        expected_cash: 153,
      },
    });

    const shift1Credit = await getShiftCreditSalesAction('shift-1');
    expect(shift1Credit.success).toBe(true);
    expect(shift1Credit.data).toHaveLength(3);
    expect(shift1Credit.data.find((invoice: any) => invoice.id === 'credit-sale')).toMatchObject({
      id: 'credit-sale',
      total_amount: 40,
      credit_amount: 40,
    });
    expect(shift1Credit.data.find((invoice: any) => invoice.id === 'partial-credit')).toMatchObject({
      total_amount: 100,
      credit_amount: 70,
    });
    expect(shift1Credit.data.find((invoice: any) => invoice.id === 'paid-credit')).toMatchObject({
      total_amount: 50,
      credit_amount: 0,
    });

    const shift2Credit = await getShiftCreditSalesAction('shift-2');
    expect(shift2Credit).toMatchObject({ success: false, data: [] });
  });

  it('keeps mixed-lot balances exact and exposes debit receipts only for the current open shift', async () => {
    mockDb.exec(`
      UPDATE master_drugs
      SET large_to_medium = 12, medium_to_small = 2, medium_unit = 'strip', small_unit = 'tablet'
      WHERE id = 9001;
      INSERT INTO users (id, username, password_hash, role, full_name, is_active)
      VALUES ('receiver', 'receiver', 'hash', 'admin', 'Receiver', 1);
      INSERT INTO patients (id, full_name, credit_limit, wallet_balance, loyalty_level, points_balance)
      VALUES ('patient-1', 'Credit Patient', 1000, 0, 'bronze', 0);
      INSERT INTO inventory (
        id, drug_id, quantity, local_selling_price, cost_price,
        expiry_date, strips_per_box, created_at
      ) VALUES
        ('lot-10', 9001, 1, 60, 100, '2099-01-01', 10, '2026-01-01'),
        ('lot-12', 9001, 1, 60, 120, '2099-02-01', 12, '2026-01-02');
    `);

    const openedA = await openShiftAction({ starting_cash_amount: 100 });
    expect(openedA.success).toBe(true);
    const shiftA = openedA.shiftId!;
    expect(await openShiftAction({ starting_cash_amount: 999 })).toMatchObject({
      success: false,
      error: expect.stringContaining('وردية مفتوحة'),
    });
    expect((mockDb.prepare("SELECT COUNT(*) AS total FROM shifts WHERE user_id = 'admin' AND status = 'open'").get() as any).total)
      .toBe(1);

    const checkoutA = await processCheckoutAction({
      items: [{
        drug_id: 9001,
        inventory_id: null,
        quantity_sold: 12,
        unit_price: 5,
        selected_unit: 'medium',
      }],
      patient_id: 'patient-1',
      payment_method: 'credit',
      status: 'completed',
    });
    expect(checkoutA.success).toBe(true);
    const saleA = checkoutA.data!.sale_id;

    const splitA = mockDb.prepare(`
      SELECT inventory_id, quantity_sold
      FROM sales_items
      WHERE invoice_id = ?
      ORDER BY id
    `).all(saleA) as any[];
    expect(splitA).toEqual([
      expect.objectContaining({ inventory_id: 'lot-10', quantity_sold: 10 }),
      expect.objectContaining({ inventory_id: 'lot-12', quantity_sold: 2 }),
    ]);
    expect((mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-10') as any).quantity).toBe(0);
    expect((mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-12') as any).quantity).toBeCloseTo(5 / 6, 8);
    expect(await getHandoverDetailsAction(shiftA)).toMatchObject({
      success: true,
      data: { credit_sales: 60, expected_cash: 100 },
    });
    expect(await getShiftCreditSalesAction()).toMatchObject({
      success: true,
      data: [expect.objectContaining({ id: saleA, credit_amount: 60 })],
    });

    expect(await processHandoverAction({
      shiftId: shiftA,
      actualCash: 100,
      transferAmount: 0,
      transferTargetId: '',
      transferTargetType: 'treasury',
      receiverUsername: 'receiver',
      receiverPasswordHash: 'password',
    })).toMatchObject({ success: true, difference: 0 });

    const openedB = await openShiftAction({ starting_cash_amount: 20 });
    expect(openedB.success).toBe(true);
    const shiftB = openedB.shiftId!;
    const checkoutB = await processCheckoutAction({
      items: [{
        drug_id: 9001,
        inventory_id: null,
        quantity_sold: 4,
        unit_price: 1,
        selected_unit: 'small',
      }],
      patient_id: 'patient-1',
      payment_method: 'credit',
      status: 'completed',
    });
    expect(checkoutB.success).toBe(true);
    const saleB = checkoutB.data!.sale_id;

    expect((mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-12') as any).quantity).toBeCloseTo(2 / 3, 8);
    expect(mockDb.prepare('SELECT inventory_id, quantity_sold FROM sales_items WHERE invoice_id = ?').all(saleB))
      .toEqual([expect.objectContaining({ inventory_id: 'lot-12', quantity_sold: 4 })]);

    const returnedA = await createReturnAction({
      invoice_id: saleA,
      shift_id: shiftB,
      refund_method: 'patient_account',
      reason: 'mixed-lot balance regression',
      patient_id: 'patient-1',
      items: splitA.map((line: any) => ({
        sale_item_id: Number((mockDb.prepare(`
          SELECT id FROM sales_items WHERE invoice_id = ? AND inventory_id = ?
        `).get(saleA, line.inventory_id) as any).id),
        inventory_id: line.inventory_id,
        drug_name: 'Test Drug',
        quantity: line.quantity_sold,
        unit_price: 5,
        unit: line.inventory_id === 'lot-10' ? 'strip' : 'medium',
      })),
    });
    expect(returnedA.success).toBe(true);
    expect((mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-10') as any).quantity).toBeCloseTo(1, 8);
    expect((mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-12') as any).quantity).toBeCloseTo(5 / 6, 8);

    expect(await getShiftCreditSalesAction()).toMatchObject({
      success: true,
      data: [expect.objectContaining({ id: saleB, credit_amount: 4 })],
    });
    expect(await getShiftCreditSalesAction(shiftB)).toMatchObject({
      success: true,
      data: [expect.objectContaining({ id: saleB })],
    });
    expect(await getShiftCreditSalesAction(shiftA)).toMatchObject({ success: false, data: [] });

    expect(await processHandoverAction({
      shiftId: shiftB,
      actualCash: 20,
      transferAmount: 0,
      transferTargetId: '',
      transferTargetType: 'treasury',
      receiverUsername: 'receiver',
      receiverPasswordHash: 'password',
    })).toMatchObject({ success: true, difference: 0 });
    expect(await getShiftCreditSalesAction()).toMatchObject({ success: true, data: [] });
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
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, cost_price, expiry_date, strips_per_box)
      VALUES
        ('default-valid', NULL, 9001, 3, 15, 10, '2099-12-31', 10),
        ('default-expired', NULL, 9001, 7, 14, 9, '2020-01-01', 12),
        ('other-valid', 'other-pharmacy', 9001, 20, 13, 8, '2099-12-31', 20);
    `);

    const search = await searchDrugsAction('Test Drug');
    expect(search).toMatchObject({
      success: true,
      data: [expect.objectContaining({
        id: 9001,
        total_stock: 3,
        batches: [expect.objectContaining({ inventory_id: 'default-valid', quantity: 3, strips_per_box: 10 })],
      })],
    });

    const barcode = await barcodeLookupAction('6220000000001');
    expect(barcode).toMatchObject({
      success: true,
      data: expect.objectContaining({
        inventory_id: 'default-valid',
        quantity: 3,
        batches: [expect.objectContaining({ inventory_id: 'default-valid', strips_per_box: 10 })],
      }),
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

  it('links handover to shifts with audit columns and carry-over balance for next shift', async () => {
    // 1. Setup users: cashier, receiver (pharmacist), admin/owner
    mockDb.prepare(`
      INSERT INTO users (id, username, password_hash, role, full_name, is_active)
      VALUES
        ('user-cashier', 'cashier1', '$2b$10$hashedpass', 'cashier', 'كاشير الفرع', 1),
        ('user-receiver', 'receiver1', '$2b$10$hashedpass', 'pharmacist', 'المستلم الصيدلي', 1)
    `).run();

    // 2. Open a shift with 50 starting cash
    mockSession = { id: 'user-cashier', role: 'cashier', pharmacy_id: null };
    const openRes = await openShiftAction({ starting_cash_amount: 50, opening_notes: 'بداية الوردية' });
    expect(openRes.success).toBe(true);
    const shiftId = openRes.shiftId!;

    // 3. Perform a sale in this shift (100 cash)
    mockDb.prepare(`
      INSERT INTO sales_invoices (id, shift_id, user_id, payment_method, total_amount, paid_amount, remaining_amount, status)
      VALUES ('inv-test-1', ?, 'user-cashier', 'cash', 100, 100, 0, 'completed')
    `).run(shiftId);

    // Expected cash = 50 + 100 = 150
    const details = await getHandoverDetailsAction(shiftId);
    expect(details.success).toBe(true);
    expect(details.data.expected_cash).toBe(150);

    // 4. Process handover: Actual counted = 155 (overage +5), transfer to treasury = 120, leaving 35 in drawer
    const handoverRes = await processHandoverAction({
      shiftId,
      actualCash: 155,
      transferAmount: 120,
      transferTargetId: '',
      transferTargetType: 'treasury',
      receiverUsername: 'receiver1',
      receiverPasswordHash: 'password',
      notes: 'تسليم الخزينة والمناوبة',
    });
    expect(handoverRes.success).toBe(true);
    expect(handoverRes.difference).toBe(5); // +5 overage
    expect(handoverRes.remainingCash).toBe(35); // 155 - 120 = 35

    // 5. Verify database columns are stored in shifts
    const savedShift = mockDb.prepare('SELECT actual_cash, transfer_amount, transfer_target, cash_difference, receiver_id, ending_cash, status FROM shifts WHERE id = ?').get(shiftId) as any;
    expect(savedShift).toMatchObject({
      actual_cash: 155,
      transfer_amount: 120,
      transfer_target: 'treasury',
      cash_difference: 5,
      receiver_id: 'user-receiver',
      ending_cash: 35,
      status: 'closed',
    });

    // 6. Test Owner / Admin access to audit columns
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    const ownerView = await getShiftsAction({ status: 'all' });
    expect(ownerView.success).toBe(true);
    const ownerShift = ownerView.data?.find((s: any) => s.id === shiftId);
    expect(ownerShift).toMatchObject({
      starting_cash_amount: 50,
      ending_cash_amount: 35,
      actual_cash: 155,
      transfer_amount: 120,
      transfer_target: 'treasury',
      cash_difference: 5,
      receiver_name: 'المستلم الصيدلي',
      expected_cash_amount: 30,
    });

    // 7. Test Non-privileged user (pharmacist/cashier) does NOT see audit columns
    mockSession = { id: 'user-cashier', role: 'cashier', pharmacy_id: null };
    const cashierView = await getShiftsAction({ status: 'all' });
    expect(cashierView.success).toBe(true);
    const cashierShift = cashierView.data?.find((s: any) => s.id === shiftId);
    expect(cashierShift).toMatchObject({
      starting_cash_amount: 50,
      ending_cash_amount: 35,
      actual_cash: null,
      transfer_amount: null,
      transfer_target: null,
      cash_difference: null,
      receiver_name: null,
      expected_cash_amount: null,
    });

    // 8. Test suggested starting cash for the next shift carries over the 35 remaining cash
    const currentShiftInfo = await getCurrentShiftAction();
    expect(currentShiftInfo.success).toBe(true);
    expect(currentShiftInfo.has_open_shift).toBe(false);
    expect((currentShiftInfo as any).suggested_starting_cash).toBe(35);

    // 9. Open new shift using the carry-over balance
    const nextShift = await openShiftAction({ starting_cash_amount: (currentShiftInfo as any).suggested_starting_cash });
    expect(nextShift.success).toBe(true);
    const nextSaved = mockDb.prepare('SELECT starting_cash, status FROM shifts WHERE id = ?').get(nextShift.shiftId!) as any;
    expect(nextSaved.starting_cash).toBe(35);
  });

  it('accepts any cash value and next_shift target even if trial balance cash_difference account is unconfigured', async () => {
    // 1. Delete cash_difference settings and accounts to simulate unconfigured accounts
    mockDb.exec("DELETE FROM trial_balance_settings WHERE category = 'cash_difference'");
    mockDb.exec("DELETE FROM accounts WHERE code = '4.3'");

    mockDb.exec(`
      INSERT INTO users (id, username, password_hash, role, full_name)
      VALUES ('user-next-cashier', 'next_cashier', 'hash', 'pharmacist', 'كاشير الوردية التالية');
      INSERT INTO shifts (id, user_id, start_time, starting_cash, status)
      VALUES ('shift-unconfigured-tb', 'admin', '2026-08-26 08:00:00', 100, 'open');
      INSERT INTO sales_invoices (id, user_id, shift_id, total_amount, payment_method, status)
      VALUES ('sale-unconfigured', 'admin', 'shift-unconfigured-tb', 200, 'cash', 'completed');
    `);

    // Expected cash: 100 + 200 = 300
    // User enters actual cash: 150 (shortage of -150), transfers 100 to next_shift
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    const handoverRes = await processHandoverAction({
      shiftId: 'shift-unconfigured-tb',
      actualCash: 150,
      transferAmount: 100,
      transferTargetId: '',
      transferTargetType: 'next_shift' as any,
      receiverUsername: 'next_cashier',
      receiverPasswordHash: 'password',
      notes: 'تسليم الوردية التالية مع عجز',
    });

    expect(handoverRes.success).toBe(true);
    expect(handoverRes.difference).toBe(-150);
    expect(handoverRes.remainingCash).toBe(50);
    expect(handoverRes.status).toBe('discrepancy');

    const saved = mockDb.prepare('SELECT actual_cash, transfer_amount, transfer_target, cash_difference, receiver_id, ending_cash, status FROM shifts WHERE id = ?').get('shift-unconfigured-tb') as any;
    expect(saved).toMatchObject({
      actual_cash: 150,
      transfer_amount: 100,
      transfer_target: 'next_shift',
      cash_difference: -150,
      receiver_id: 'user-next-cashier',
      ending_cash: 50,
      status: 'discrepancy',
    });
  });

  it('fetches receipts belonging to a shift with item details, payment methods, and patient info', async () => {
    mockDb.exec(`
      INSERT OR REPLACE INTO users (id, username, full_name, role) VALUES ('pharmacist-1', 'ph1', 'د. صيدلي 1', 'pharmacist');
      INSERT OR REPLACE INTO patients (id, full_name, phone) VALUES ('patient-101', 'أحمد محمود', '01012345678');
      INSERT OR REPLACE INTO master_drugs (id, trade_name, trade_name_en, official_price, large_unit, medium_unit, small_unit) 
      VALUES (999, 'Panadol Extra', 'Panadol Extra', 50.0, 'علبة', 'شريط', 'قرص');

      INSERT INTO shifts (id, user_id, start_time, starting_cash, status)
      VALUES ('shift-rec-1', 'pharmacist-1', '2026-08-26 08:00:00', 100, 'closed');

      INSERT INTO sales_invoices (id, user_id, patient_id, total_amount, paid_amount, payment_method, shift_id, status, created_at)
      VALUES ('inv-rec-1', 'pharmacist-1', 'patient-101', 100, 100, 'cash', 'shift-rec-1', 'completed', '2026-08-26 09:00:00');

      INSERT INTO sales_items (invoice_id, drug_id, quantity_sold, unit_price, unit)
      VALUES ('inv-rec-1', 999, 2, 50.0, 'large');
    `);

    mockSession = { id: 'pharmacist-1', role: 'pharmacist', pharmacy_id: null };
    const res = await getShiftReceiptsAction('shift-rec-1');

    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toMatchObject({
      id: 'inv-rec-1',
      total_amount: 100,
      payment_method: 'cash',
      patient_name: 'أحمد محمود',
      patient_phone: '01012345678',
    });
    expect(res.data[0].sales_items).toHaveLength(1);
    expect(res.data[0].sales_items[0]).toMatchObject({
      quantity_sold: 2,
      unit_price: 50,
      trade_name: 'Panadol Extra',
    });
  });
});

