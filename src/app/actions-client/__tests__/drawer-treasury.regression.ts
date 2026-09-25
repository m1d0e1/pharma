/** @jest-environment node */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

let sqlite: Database.Database;
let nextId = 0;
let session: any = { id: 'owner', role: 'owner', pharmacy_id: null };

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => unknown) => {
    if (sqlite.inTransaction) return callback();
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = await callback(); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }),
  generateId: jest.fn(() => `drawer-test-${++nextId}`),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => session),
  hasUserPermissionSync: jest.fn(() => true),
  verifyPassword: jest.fn(async () => true),
}));
jest.mock('@/lib/env', () => ({ isTauri: false }));

import { processCheckoutAction } from '@/app/actions-client/sales';
import { createCashMovementAction, getTreasuryDashboardAction } from '@/app/actions-client/finance';
import { createReturnAction } from '@/app/actions-client/returns';
import { processHandoverAction } from '@/app/actions-client/handover';

const migrations = ['001_initial.sql', '008_patient_accounting.sql', '011_shift_cash_difference_account.sql', '013_shift_handover_details.sql'];

function dashboard() {
  return getTreasuryDashboardAction('treasury');
}

async function checkout(amount: number, shiftId?: string) {
  const result = await processCheckoutAction({
    items: [{ drug_id: 1, inventory_id: 'stock', quantity_sold: 1, unit_price: amount, selected_unit: 'large' }],
    payment_method: 'cash', status: 'completed', shift_id: shiftId,
  });
  expect(result).toMatchObject({ success: true });
}

async function handover(shiftId: string, actualCash: number, transferAmount: number, target: 'treasury' | 'next_shift' | 'bank' | 'pos') {
  return processHandoverAction({
    shiftId, actualCash, transferAmount, transferTargetType: target,
    transferTargetId: target === 'bank' ? '1' : target === 'pos' ? '1' : '',
    receiverUsername: 'receiver', receiverPasswordHash: 'accepted',
  });
}

describe('current drawer treasury balance', () => {
  beforeEach(() => {
    nextId = 0;
    session = { id: 'owner', role: 'owner', pharmacy_id: null };
    sqlite = new Database(':memory:');
    for (const migration of migrations) sqlite.exec(readFileSync(`src-tauri/migrations/${migration}`, 'utf8'));
    sqlite.exec(`
      ALTER TABLE shifts ADD COLUMN pharmacy_id TEXT;
      ALTER TABLE cash_movements ADD COLUMN pharmacy_id TEXT;
      ALTER TABLE daily_journals ADD COLUMN pharmacy_id TEXT;
      ALTER TABLE returns ADD COLUMN pharmacy_id TEXT;
      ALTER TABLE expenses ADD COLUMN pharmacy_id TEXT;
      ALTER TABLE inventory ADD COLUMN medium_to_small INTEGER DEFAULT 1;
      ALTER TABLE sales_items ADD COLUMN large_to_medium INTEGER DEFAULT 1;
      ALTER TABLE sales_items ADD COLUMN medium_to_small INTEGER DEFAULT 1;
      CREATE TRIGGER shift_pharmacy AFTER INSERT ON shifts WHEN NEW.pharmacy_id IS NULL
      BEGIN UPDATE shifts SET pharmacy_id = COALESCE((SELECT pharmacy_id FROM users WHERE id = NEW.user_id), 'local_default') WHERE id = NEW.id; END;
      CREATE TRIGGER cash_movement_pharmacy AFTER INSERT ON cash_movements WHEN NEW.pharmacy_id IS NULL
      BEGIN UPDATE cash_movements SET pharmacy_id = COALESCE((SELECT pharmacy_id FROM shifts WHERE id = NEW.shift_id), 'local_default') WHERE id = NEW.id; END;
      CREATE TRIGGER journal_pharmacy AFTER INSERT ON daily_journals WHEN NEW.pharmacy_id IS NULL
      BEGIN UPDATE daily_journals SET pharmacy_id = COALESCE((SELECT pharmacy_id FROM users WHERE id = NEW.created_by), 'local_default') WHERE id = NEW.id; END;
      INSERT INTO users(id, username, password_hash, role) VALUES ('owner', 'owner', 'hash', 'owner'), ('receiver', 'receiver', 'hash', 'admin');
      INSERT INTO master_drugs(id, trade_name, official_price, large_to_medium, medium_to_small) VALUES (1, 'Drawer Drug', 100, 1, 1);
      INSERT INTO inventory(id, drug_id, quantity, local_selling_price, cost_price, expiry_date, strips_per_box) VALUES ('stock', 1, 100, 100, 20, '2099-01-01', 1);
      INSERT INTO banks(id, name_ar, current_balance) VALUES (1, 'Bank', 0);
      INSERT INTO points_of_sale(id, name_ar, current_balance) VALUES (1, 'POS', 0);
    `);
  });

  afterEach(() => sqlite.close());

  it('deducts a cash refund after handover from the paying drawer, with receipts and expenses counted once', async () => {
    sqlite.exec("INSERT INTO shifts(id,user_id,starting_cash,status) VALUES ('sale-shift','owner',100,'open')");
    await checkout(100, 'sale-shift');
    const sale = sqlite.prepare('SELECT id, invoice_id FROM sales_items LIMIT 1').get() as any;
    const next = await handover('sale-shift', 200, 50, 'treasury');
    expect(next.success).toBe(true);
    expect(await createReturnAction({
      invoice_id: sale.invoice_id, shift_id: next.newShiftId!, refund_method: 'cash', reason: 'refund',
      items: [{ sale_item_id: sale.id, inventory_id: 'stock', drug_name: 'Drawer Drug', quantity: 1, unit_price: 100, unit: 'large' }],
    })).toMatchObject({ success: true, totalRefund: 100 });
    expect((await dashboard()).data?.treasuryBalance).toBe(50);
    expect(await createCashMovementAction({ type: 'receipt', category: 'pharmacy', amount: 20, date: '2026-09-25' })).toMatchObject({ success: true });
    expect(await createCashMovementAction({ type: 'disbursement', category: 'operating_expenses', amount: 7, date: '2026-09-25' })).toMatchObject({ success: true });
    const result = await dashboard();
    expect(result.data?.treasuryBalance).toBe(63);
    expect(result.data!.details.reduce((sum: number, row: any) => sum + (row.type === 'receipt' ? row.amount : -row.amount), 0)).toBe(63);
  });

  it('fails visibly rather than choosing or summing multiple open drawers', async () => {
    sqlite.exec("INSERT INTO shifts(id,user_id,starting_cash,status) VALUES ('one','owner',100,'open'), ('two','receiver',300,'open')");
    expect(await dashboard()).toMatchObject({ success: false, error: expect.stringContaining('أكثر من وردية') });
  });

  it.each(['treasury', 'next_shift', 'bank', 'pos'] as const)('uses the current drawer after a %s handover, checkout, and repeat handover', async target => {
    sqlite.prepare("INSERT INTO shifts(id, user_id, starting_cash, status) VALUES ('old', 'owner', 100, 'open')").run();
    await checkout(100, 'old');
    expect((await dashboard()).data).toMatchObject({ treasuryBalance: 200, drawerShiftId: 'old' });

    const first = await handover('old', 200, 150, target);
    expect(first).toMatchObject({ success: true });
    const newShiftId = first.newShiftId!;
    const afterFirst = await dashboard();
    const expectedAfterFirst = target === 'next_shift' ? 200 : 50;
    expect(afterFirst.data).toMatchObject({ treasuryBalance: expectedAfterFirst, drawerShiftId: newShiftId });

    await checkout(10, newShiftId);
    expect((await dashboard()).data?.treasuryBalance).toBe(expectedAfterFirst + 10);
    const second = await handover(newShiftId, expectedAfterFirst + 10, 10, target);
    expect(second).toMatchObject({ success: true });
    expect((await dashboard()).data).toMatchObject({
      treasuryBalance: target === 'next_shift' ? 210 : 50,
      drawerShiftId: second.newShiftId,
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cash_movements WHERE category = 'handover'").get()).toEqual({ count: 2 });
  });

  it('uses counted overage and shortage as the new drawer starting cash, not an extra sale or handover', async () => {
    sqlite.prepare("INSERT INTO shifts(id, user_id, starting_cash, status) VALUES ('over', 'owner', 100, 'open')").run();
    await checkout(100, 'over');
    const over = await handover('over', 205, 150, 'treasury');
    expect(over).toMatchObject({ success: true, difference: 5 });
    expect((await dashboard()).data?.treasuryBalance).toBe(55);

    const short = await handover(over.newShiftId!, 50, 20, 'treasury');
    expect(short).toMatchObject({ success: true, difference: -5 });
    expect((await dashboard()).data?.treasuryBalance).toBe(30);
  });

  it('does not use closed/foreign shifts, never creates shift 0, and returns zero with no open drawer', async () => {
    sqlite.exec(`
      UPDATE users SET pharmacy_id = 'other' WHERE id = 'receiver';
      INSERT INTO shifts(id, user_id, pharmacy_id, starting_cash, status) VALUES
        ('closed', 'owner', 'local_default', 999, 'closed'),
        ('foreign', 'receiver', 'other', 777, 'open');
    `);
    const empty = await dashboard();
    expect(empty.data).toMatchObject({ treasuryBalance: 0, drawerShiftId: null, ledgerCashBalance: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM shifts WHERE id = '0'").get()).toEqual({ count: 0 });

    sqlite.prepare("INSERT INTO shifts(id, user_id, pharmacy_id, starting_cash, status) VALUES ('local', 'owner', 'local_default', 25, 'open')").run();
    expect((await dashboard()).data).toMatchObject({ treasuryBalance: 25, drawerShiftId: 'local' });
  });

  it('reconciles legacy transfer amounts once and emits drawer detail lines whose signed sum equals the balance', async () => {
    sqlite.exec(`
      INSERT INTO shifts(id, user_id, pharmacy_id, starting_cash, transfer_amount, status) VALUES ('legacy', 'owner', 'local_default', 100, 30, 'open');
      INSERT INTO sales_invoices(id, user_id, shift_id, total_amount, payment_method, status) VALUES ('cash-sale', 'owner', 'legacy', 40, 'cash', 'completed');
      INSERT INTO cash_movements(id, user_id, shift_id, type, category, amount, date) VALUES
        ('receipt', 'owner', 'legacy', 'receipt', 'pharmacy', 20, '2026-01-01'),
        ('expense', 'owner', 'legacy', 'disbursement', 'expense', 10, '2026-01-01'),
        ('handover', 'owner', 'legacy', 'disbursement', 'handover', 30, '2026-01-01');
    `);
    const result = await dashboard();
    expect(result.data).toMatchObject({ treasuryBalance: 120, drawerShiftId: 'legacy' });
    const signedTotal = result.data!.details.reduce((sum: number, row: any) => sum + (row.type === 'receipt' ? row.amount : -row.amount), 0);
    expect(signedTotal).toBe(result.data!.treasuryBalance);

    sqlite.prepare("UPDATE shifts SET transfer_amount = 50 WHERE id = 'legacy'").run();
    const legacyUnrecorded = await dashboard();
    expect(legacyUnrecorded.data?.treasuryBalance).toBe(100);
    expect(legacyUnrecorded.data?.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'legacy:legacy-transfers', amount: 20, type: 'disbursement' }),
    ]));
  });
});
