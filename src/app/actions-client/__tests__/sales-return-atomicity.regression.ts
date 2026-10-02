/** @jest-environment node */

import Database from 'better-sqlite3';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let idCounter = 0;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => {
    mockDb.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback(mockCreateSqliteTransactionDb(mockDb));
      mockDb.exec('COMMIT');
      return result;
    } catch (error) {
      mockDb.exec('ROLLBACK');
      throw error;
    }
  }),
  generateId: jest.fn(() => `return-${++idCounter}`),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'owner-1', role: 'owner', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/app/actions-client/finance', () => ({
  requireOpenShiftId: jest.fn(async () => 'shift-1'),
}));

jest.mock('@/lib/env', () => ({ isTauri: false }));

import { createReturnAction } from '@/app/actions-client/returns';

const returnData = (quantity: number) => ({
  invoice_id: 'sale-1',
  refund_method: 'cash' as const,
  reason: 'test',
  items: [{
    sale_item_id: 1,
    inventory_id: 'lot-1',
    drug_name: 'Test drug',
    quantity,
    unit_price: 10,
    unit: 'large',
  }],
});

describe('sales return fallback atomicity', () => {
  beforeEach(() => {
    idCounter = 0;
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, patient_id TEXT, total_amount REAL,
        discount_amount REAL DEFAULT 0, payment_method TEXT, status TEXT,
        points_earned INTEGER DEFAULT 0, points_redeemed INTEGER DEFAULT 0,
        loyalty_discount_amount REAL DEFAULT 0
      );
      CREATE TABLE sales_items (
        id INTEGER PRIMARY KEY, invoice_id TEXT, inventory_id TEXT, drug_id INTEGER,
        quantity_sold REAL, unit_price REAL, unit TEXT, cost_price REAL,
        large_to_medium INTEGER DEFAULT 1, medium_to_small INTEGER DEFAULT 1
      );
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, no_return INTEGER DEFAULT 0, trade_name TEXT,
        medium_unit TEXT, small_unit TEXT
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY, pharmacy_id TEXT, drug_id INTEGER, quantity REAL,
        batch_number TEXT, expiry_date TEXT, unit_price REAL, cost_price REAL,
        strips_per_box INTEGER, medium_to_small INTEGER
      );
      CREATE TABLE returns (
        id TEXT PRIMARY KEY, invoice_id TEXT, user_id TEXT, pharmacy_id TEXT,
        shift_id TEXT, reason TEXT, total_refund REAL, refund_method TEXT, status TEXT
      );
      CREATE TABLE return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT, inventory_id TEXT,
        drug_name TEXT, quantity_returned REAL, unit_price REAL, sale_item_id INTEGER, unit TEXT
      );
      CREATE TABLE daily_journals (
        id TEXT PRIMARY KEY, date TEXT, description TEXT, created_by TEXT, total_amount REAL
      );
      CREATE TABLE journal_entries (journal_id TEXT, account_id INTEGER, type TEXT, amount REAL);
      CREATE TABLE trial_balance_settings (category TEXT, account_id INTEGER);
      CREATE TABLE activity_log (user_id TEXT, action TEXT, details TEXT);
      CREATE TABLE patients (
        id TEXT PRIMARY KEY, wallet_balance REAL DEFAULT 0, points_balance REAL DEFAULT 0
      );

      INSERT INTO sales_invoices (
        id, pharmacy_id, patient_id, total_amount, discount_amount, payment_method, status
      ) VALUES ('sale-1', 'ph-1', NULL, 50, 0, 'cash', 'completed');
      INSERT INTO master_drugs VALUES (101, 0, 'Test drug', NULL, NULL);
      INSERT INTO sales_items VALUES (1, 'sale-1', 'lot-1', 101, 5, 10, 'large', 4, 1, 1);
      INSERT INTO inventory VALUES ('lot-1', 'ph-1', 101, 10, 'B1', '2030-01-01', 10, 4, 1, 1);
      INSERT INTO trial_balance_settings VALUES
        ('cash_drawer', 6),
        ('accounts_receivable', 8),
        ('sales_revenue', 9),
        ('inventory_asset', 10),
        ('cogs_expense', 11),
        ('bank_clearing', 12),
        ('patient_wallet_liability', 13);
    `);
  });

  afterEach(() => mockDb.close());

  it('rolls back the approved return and stock restoration when a late journal write fails', async () => {
    mockDb.exec(`
      CREATE TRIGGER fail_return_journal_entry
      BEFORE INSERT ON journal_entries
      BEGIN
        SELECT RAISE(ABORT, 'injected return journal failure');
      END;
    `);

    expect(await createReturnAction(returnData(2))).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM return_items').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual({ quantity: 10 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM journal_entries').get()).toEqual({ count: 0 });
  });

  it('rolls back the approved return when its audit write fails', async () => {
    mockDb.exec(`
      CREATE TRIGGER reject_return_audit
      BEFORE INSERT ON activity_log
      WHEN NEW.action = 'CREATE_RETURN'
      BEGIN
        SELECT RAISE(ABORT, 'return audit failed');
      END;
    `);
    const stockBefore = mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1');
    const journalBefore = mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get();

    expect(await createReturnAction(returnData(2))).toMatchObject({ success: false });

    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual(stockBefore);
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM return_items').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM daily_journals').get()).toEqual(journalBefore);
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action = 'CREATE_RETURN'").get()).toEqual({ count: 0 });
  });

  it('allows successive partial returns only up to the sold quantity', async () => {
    expect(await createReturnAction(returnData(2))).toMatchObject({ success: true, totalRefund: 20 });
    expect(await createReturnAction(returnData(3))).toMatchObject({ success: true, totalRefund: 30 });
    expect(await createReturnAction(returnData(1))).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 2 });
    expect(mockDb.prepare('SELECT SUM(quantity_returned) AS quantity FROM return_items').get()).toEqual({ quantity: 5 });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual({ quantity: 15 });
  });

  it('treats a linked historical NULL return unit as the original non-large sale unit', async () => {
    mockDb.prepare("UPDATE sales_invoices SET total_amount = 10 WHERE id = 'sale-1'").run();
    mockDb.prepare("UPDATE sales_items SET quantity_sold = 10, unit_price = 1, unit = 'small', large_to_medium = 10, medium_to_small = 2 WHERE id = 1").run();
    mockDb.prepare(`
      INSERT INTO returns (id, invoice_id, user_id, pharmacy_id, reason, total_refund, refund_method, status)
      VALUES ('legacy-null-unit', 'sale-1', 'owner-1', 'ph-1', 'legacy unit', 3, 'cash', 'approved')
    `).run();
    mockDb.prepare(`
      INSERT INTO return_items (return_id, inventory_id, drug_name, quantity_returned, unit_price, sale_item_id, unit)
      VALUES ('legacy-null-unit', 'lot-1', 'Test drug', 3, 1, 1, NULL)
    `).run();

    expect(await createReturnAction({ ...returnData(7), items: [{ ...returnData(7).items[0], unit_price: 1, unit: 'small' }] }))
      .toMatchObject({ success: true, totalRefund: 7 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 2 });
  });

  it('restores redeemed points while preserving earned-point debt when earned points were already spent', async () => {
    mockDb.prepare("INSERT INTO patients (id, wallet_balance, points_balance) VALUES ('loyalty-patient', 0, 140)").run();
    mockDb.prepare(`
      UPDATE sales_invoices
      SET patient_id = 'loyalty-patient', total_amount = 40, discount_amount = 10,
          points_earned = 40, points_redeemed = 100, loyalty_discount_amount = 10
      WHERE id = 'sale-1'
    `).run();

    expect(await createReturnAction(returnData(2))).toMatchObject({ success: true, totalRefund: 16 });
    expect(mockDb.prepare("SELECT points_balance FROM patients WHERE id = 'loyalty-patient'").get())
      .toEqual({ points_balance: 164 });

    // Simulate the customer spending the remaining points before returning the rest of the earning sale.
    mockDb.prepare("UPDATE patients SET points_balance = 0 WHERE id = 'loyalty-patient'").run();
    expect(await createReturnAction(returnData(3))).toMatchObject({ success: true, totalRefund: 24 });
    expect(mockDb.prepare("SELECT points_balance FROM patients WHERE id = 'loyalty-patient'").get())
      .toEqual({ points_balance: 36 });
  });

  it('blocks an additional return when a finalized legacy return item has unresolved sale-item lineage', async () => {
    mockDb.prepare(`
      INSERT INTO returns (id, invoice_id, user_id, pharmacy_id, reason, total_refund, refund_method, status)
      VALUES ('legacy-return', 'sale-1', 'owner-1', 'ph-1', 'legacy', 30, 'cash', 'approved')
    `).run();
    mockDb.prepare(`
      INSERT INTO return_items (return_id, inventory_id, drug_name, quantity_returned, unit_price, sale_item_id, unit)
      VALUES ('legacy-return', 'lot-1', 'Test drug', 3, 10, NULL, 'large')
    `).run();
    const stockBefore = mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1');

    expect(await createReturnAction(returnData(3))).toMatchObject({ success: false });

    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual(stockBefore);
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM returns WHERE id <> 'legacy-return'").get()).toEqual({ count: 0 });
  });

  it('restores a missing sold lot with the original cost basis instead of contaminating another lot', async () => {
    mockDb.prepare('DELETE FROM inventory WHERE id = ?').run('lot-1');
    mockDb.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, unit_price, cost_price, strips_per_box, medium_to_small)
      VALUES ('other-lot', 'ph-1', 101, 7, 10, 9, 1, 1)
    `).run();

    expect(await createReturnAction(returnData(2))).toMatchObject({ success: true, totalRefund: 20 });
    expect(mockDb.prepare('SELECT quantity, cost_price FROM inventory WHERE id = ?').get('other-lot')).toEqual({
      quantity: 7,
      cost_price: 9,
    });
    expect(mockDb.prepare(`
      SELECT quantity, cost_price, expiry_date
      FROM inventory
      WHERE drug_id = 101 AND id <> 'other-lot'
    `).get()).toEqual({
      quantity: 2,
      cost_price: 4,
      expiry_date: null,
    });
  });

  it('rejects duplicate sale-item lines whose combined quantity exceeds the invoice remainder', async () => {
    const duplicateLineReturn = returnData(3);
    duplicateLineReturn.items.push({ ...duplicateLineReturn.items[0], quantity: 3 });

    expect(await createReturnAction(duplicateLineReturn)).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM return_items').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual({ quantity: 10 });
  });

  it('credits the configured bank-clearing account for a bank/card refund', async () => {
    const result = await createReturnAction({ ...returnData(1), refund_method: 'bank' });

    expect(result).toMatchObject({ success: true, totalRefund: 10 });
    expect(mockDb.prepare(
      "SELECT account_id FROM journal_entries WHERE type = 'credit' AND amount = 10"
    ).get()).toEqual({ account_id: 12 });
  });

  it('rejects a wallet refund when the sale has no linked patient', async () => {
    expect(await createReturnAction({ ...returnData(1), refund_method: 'wallet' })).toMatchObject({
      success: false,
    });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual({ quantity: 10 });
  });

  it('rejects unsupported refund methods before writing return or accounting state', async () => {
    const result = await createReturnAction({
      ...returnData(1),
      refund_method: 'coupon',
    } as any);

    expect(result).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual({ quantity: 10 });
  });

  it('credits a valid wallet refund to the patient wallet and wallet-liability account', async () => {
    mockDb.prepare("INSERT INTO patients (id, wallet_balance) VALUES ('patient-1', 5)").run();
    mockDb.prepare("UPDATE sales_invoices SET patient_id = 'patient-1', payment_method = 'wallet' WHERE id = 'sale-1'").run();

    const result = await createReturnAction({
      ...returnData(1),
      refund_method: 'wallet',
      patient_id: 'patient-1',
    });

    expect(result).toMatchObject({ success: true, totalRefund: 10 });
    expect(mockDb.prepare("SELECT wallet_balance FROM patients WHERE id = 'patient-1'").get()).toEqual({
      wallet_balance: 15,
    });
    expect(mockDb.prepare(
      "SELECT account_id FROM journal_entries WHERE type = 'credit' AND amount = 10"
    ).get()).toEqual({ account_id: 13 });
  });

  it('accepts exact fractional partial returns but rejects a quantity beyond the stock tolerance', async () => {
    mockDb.prepare('UPDATE sales_invoices SET total_amount = 10 WHERE id = ?').run('sale-1');
    mockDb.prepare('UPDATE sales_items SET quantity_sold = 1 WHERE id = 1').run();

    expect(await createReturnAction(returnData(0.5))).toMatchObject({ success: true, totalRefund: 5 });
    const stockBeforeRejectedReturn = mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1');
    const refundsBeforeRejectedReturn = mockDb.prepare('SELECT COALESCE(SUM(total_refund), 0) AS total FROM returns').get();

    expect(await createReturnAction(returnData(0.504))).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual(stockBeforeRejectedReturn);
    expect(mockDb.prepare('SELECT COALESCE(SUM(total_refund), 0) AS total FROM returns').get()).toEqual(refundsBeforeRejectedReturn);
    expect(await createReturnAction(returnData(0.5))).toMatchObject({ success: true, totalRefund: 5 });
  });

  it('denies returns for delivery invoices before collection without changing stock or records', async () => {
    mockDb.prepare("UPDATE sales_invoices SET payment_method = 'delivery', status = 'completed' WHERE id = 'sale-1'").run();

    await expect(createReturnAction(returnData(1))).resolves.toEqual({
      success: false,
      error: 'يجب تسوية تحصيل فاتورة التوصيل قبل إجراء المرتجع',
    });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM returns').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT quantity FROM inventory WHERE id = ?').get('lot-1')).toEqual({ quantity: 10 });
  });
});
