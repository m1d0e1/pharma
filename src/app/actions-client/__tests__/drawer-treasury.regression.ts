/** @jest-environment node */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

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
  dbTransaction: jest.fn(async (callback: any) => {
    if (sqlite.inTransaction) return callback(mockCreateSqliteTransactionDb(sqlite));
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = await callback(mockCreateSqliteTransactionDb(sqlite)); sqlite.exec('COMMIT'); return result; }
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
import { closeShiftAction, getCurrentShiftStatsAction, getShiftsAction } from '@/app/actions-client/shifts';
import { getShiftReportAction } from '@/app/actions-client/reports';

const migrations = ['001_initial.sql', '008_patient_accounting.sql', '011_shift_cash_difference_account.sql', '013_shift_handover_details.sql', '024_commercial_papers_pharmacy_scope.sql', '025_sales_item_discount_snapshot.sql', '026_sales_loyalty_redemption_snapshot.sql', '028_finance_definitions_pharmacy_scope.sql', '029_shift_treasury_retained_cash.sql'];

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
    sqlite.prepare("UPDATE returns SET status = 'APPROVED'").run();
    expect((await dashboard()).data).toMatchObject({ treasuryBalance: 50, drawerBalance: 50 });
    expect(await createCashMovementAction({ type: 'receipt', category: 'pharmacy', amount: 20, date: '2026-09-25' })).toMatchObject({ success: true });
    expect(await createCashMovementAction({ type: 'disbursement', category: 'operating_expenses', amount: 7, date: '2026-09-25' })).toMatchObject({ success: true });
    const result = await dashboard();
    expect(result.data).toMatchObject({ treasuryBalance: 50, drawerBalance: 63 });
  });

  it('fails visibly rather than choosing or summing multiple open drawers', async () => {
    sqlite.exec("INSERT INTO shifts(id,user_id,starting_cash,status) VALUES ('one','owner',100,'open'), ('two','receiver',300,'open')");
    expect(await dashboard()).toMatchObject({ success: false, error: expect.stringContaining('أكثر من وردية') });
  });

  it.each(['treasury', 'next_shift', 'bank', 'pos'] as const)('uses the current drawer after a %s handover, checkout, and repeat handover', async target => {
    sqlite.prepare("INSERT INTO shifts(id, user_id, starting_cash, status) VALUES ('old', 'owner', 100, 'open')").run();
    await checkout(100, 'old');
    expect((await dashboard()).data).toMatchObject({ treasuryBalance: 0, drawerBalance: 200, drawerShiftId: 'old' });

    const first = await handover('old', 200, 150, target);
    expect(first).toMatchObject({ success: true });
    const newShiftId = first.newShiftId!;
    const afterFirst = await dashboard();
    const expectedAfterFirst = {
      treasury: { treasuryBalance: 150, drawerBalance: 50 },
      next_shift: { treasuryBalance: 50, drawerBalance: 150 },
      bank: { treasuryBalance: 0, drawerBalance: 50 },
      pos: { treasuryBalance: 0, drawerBalance: 50 },
    }[target];
    expect(afterFirst.data).toMatchObject({ ...expectedAfterFirst, drawerShiftId: newShiftId });

    await checkout(10, newShiftId);
    expect((await dashboard()).data).toMatchObject({
      treasuryBalance: expectedAfterFirst.treasuryBalance,
      drawerBalance: expectedAfterFirst.drawerBalance + 10,
    });
    const second = await handover(newShiftId, expectedAfterFirst.drawerBalance + 10, 10, target);
    expect(second).toMatchObject({ success: true });
    const expectedAfterSecond = {
      treasury: { treasuryBalance: 160, drawerBalance: 50 },
      next_shift: { treasuryBalance: 200, drawerBalance: 10 },
      bank: { treasuryBalance: 0, drawerBalance: 50 },
      pos: { treasuryBalance: 0, drawerBalance: 50 },
    }[target];
    expect((await dashboard()).data).toMatchObject({
      ...expectedAfterSecond,
      drawerShiftId: second.newShiftId,
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cash_movements WHERE category = 'handover'").get()).toEqual({ count: 2 });
  });

  it('splits 9000 into 3000 for the next drawer and 6000 retained in treasury', async () => {
    sqlite.prepare("INSERT INTO shifts(id, user_id, starting_cash, status) VALUES ('split-9000', 'owner', 9000, 'open')").run();
    const cashAccount = (sqlite.prepare("SELECT account_id FROM trial_balance_settings WHERE category = 'cash_drawer'").get() as any).account_id;
    const equityAccount = (sqlite.prepare("SELECT account_id FROM trial_balance_settings WHERE category = 'opening_balance_equity'").get() as any).account_id;
    sqlite.prepare("INSERT INTO daily_journals(id, date, description, created_by, total_amount) VALUES ('split-opening', date('now', 'localtime'), 'Opening cash for split test', 'owner', 9000)").run();
    sqlite.prepare("INSERT INTO journal_entries(journal_id, account_id, type, amount) VALUES ('split-opening', ?, 'debit', 9000)").run(cashAccount);
    sqlite.prepare("INSERT INTO journal_entries(journal_id, account_id, type, amount) VALUES ('split-opening', ?, 'credit', 9000)").run(equityAccount);

    const result = await handover('split-9000', 9000, 3000, 'next_shift');

    expect(result).toMatchObject({ success: true, remainingCash: 3000, startingCash: 3000 });
    expect(sqlite.prepare("SELECT actual_cash, transfer_amount, transfer_target, treasury_retained_cash, ending_cash, status FROM shifts WHERE id = 'split-9000'").get()).toMatchObject({
      actual_cash: 9000,
      transfer_amount: 3000,
      transfer_target: 'next_shift',
      treasury_retained_cash: 6000,
      ending_cash: 3000,
      status: 'closed',
    });
    expect(sqlite.prepare("SELECT starting_cash, status FROM shifts WHERE id = ?").get(result.newShiftId)).toEqual({ starting_cash: 3000, status: 'open' });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cash_movements WHERE shift_id = ? AND category = 'handover_received'").get(result.newShiftId)).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM shifts WHERE status = 'open'").get()).toEqual({ count: 1 });

    const summary = await dashboard();
    expect(summary.data).toMatchObject({ treasuryBalance: 6000, drawerBalance: 3000, ledgerCashBalance: 9000, detailCount: 1 });
    expect(summary.data?.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ shift_id: 'split-9000', amount: 6000, type: 'receipt' }),
    ]));
    expect(summary.data!.treasuryBalance + summary.data!.drawerBalance).toBe(summary.data!.ledgerCashBalance);

    const shiftHistory = await getShiftsAction({ status: 'all' });
    expect(shiftHistory.data?.find((shift: any) => shift.id === 'split-9000')).toMatchObject({
      actual_cash: 9000,
      transfer_amount: 3000,
      expected_cash_amount: 3000,
      cash_difference: 0,
    });
    expect(await getShiftReportAction('split-9000')).toMatchObject({
      success: true,
      data: {
        summary: {
          actualCash: 9000,
          expectedCash: 9000,
          difference: 0,
          cashHandover: 3000,
        },
      },
    });
  });

  it('keeps explicit main-safe cash movements in treasury instead of the open drawer', async () => {
    sqlite.prepare("INSERT INTO shifts(id, user_id, starting_cash, status) VALUES ('safe-source', 'owner', 100, 'open')").run();
    const first = await handover('safe-source', 100, 60, 'treasury');
    expect(first).toMatchObject({ success: true, remainingCash: 40 });
    expect((await dashboard()).data).toMatchObject({ treasuryBalance: 60, drawerBalance: 40 });

    expect(await createCashMovementAction({
      type: 'disbursement', category: 'personal', amount: 10,
      source_type: 'main_safe', date: '2026-09-25',
    })).toMatchObject({ success: true });
    expect((await dashboard()).data).toMatchObject({ treasuryBalance: 50, drawerBalance: 40 });
    expect(await getCurrentShiftStatsAction()).toMatchObject({
      success: true,
      data: { expected_cash: 40 },
    });

    expect(await createCashMovementAction({
      type: 'receipt', category: 'pharmacy', amount: 5,
      source_type: 'main_safe', date: '2026-09-25',
    })).toMatchObject({ success: true });
    expect((await dashboard()).data).toMatchObject({ treasuryBalance: 55, drawerBalance: 40 });
  });

  it('ignores main-safe movements when the legacy close action reconciles the drawer', async () => {
    sqlite.prepare("INSERT INTO shifts(id, user_id, starting_cash, status) VALUES ('legacy-safe-close', 'owner', 100, 'open')").run();
    expect(await createCashMovementAction({
      type: 'disbursement', category: 'personal', amount: 10,
      source_type: 'main_safe', date: '2026-09-25', shift_id: 'legacy-safe-close',
    })).toMatchObject({ success: true });

    expect(await closeShiftAction({ shift_id: 'legacy-safe-close', ending_cash_amount: 100 })).toMatchObject({ success: true });
    expect(sqlite.prepare("SELECT status, cash_difference FROM shifts WHERE id = 'legacy-safe-close'").get()).toEqual({
      status: 'closed',
      cash_difference: 0,
    });
  });

  it('uses counted overage and shortage as the new drawer starting cash, not an extra sale or handover', async () => {
    sqlite.prepare("INSERT INTO shifts(id, user_id, starting_cash, status) VALUES ('over', 'owner', 100, 'open')").run();
    await checkout(100, 'over');
    const over = await handover('over', 205, 150, 'treasury');
    expect(over).toMatchObject({ success: true, difference: 5 });
    expect((await dashboard()).data).toMatchObject({ treasuryBalance: 150, drawerBalance: 55 });

    const short = await handover(over.newShiftId!, 50, 20, 'treasury');
    expect(short).toMatchObject({ success: true, difference: -5 });
    expect((await dashboard()).data).toMatchObject({ treasuryBalance: 170, drawerBalance: 30 });
  });

  it('does not use closed/foreign shifts, never creates shift 0, and returns zero with no open drawer', async () => {
    sqlite.exec(`
      UPDATE users SET pharmacy_id = 'other' WHERE id = 'receiver';
      INSERT INTO shifts(id, user_id, pharmacy_id, starting_cash, status) VALUES
        ('closed', 'owner', 'local_default', 999, 'closed'),
        ('foreign', 'receiver', 'other', 777, 'open');
    `);
    const empty = await dashboard();
    expect(empty.data).toMatchObject({ treasuryBalance: 0, drawerBalance: 0, drawerShiftId: null, ledgerCashBalance: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM shifts WHERE id = '0'").get()).toEqual({ count: 0 });

    sqlite.prepare("INSERT INTO shifts(id, user_id, pharmacy_id, starting_cash, status) VALUES ('local', 'owner', 'local_default', 25, 'open')").run();
    expect((await dashboard()).data).toMatchObject({ treasuryBalance: 0, drawerBalance: 25, drawerShiftId: 'local' });
  });

  it('keeps legacy open-drawer transfer reconciliation separate from retained treasury cash', async () => {
    sqlite.exec(`
      INSERT INTO shifts(id, user_id, pharmacy_id, starting_cash, transfer_amount, status) VALUES ('legacy', 'owner', 'local_default', 100, 30, 'open');
      INSERT INTO sales_invoices(id, user_id, shift_id, total_amount, payment_method, status) VALUES ('cash-sale', 'owner', 'legacy', 40, 'cash', 'completed');
      INSERT INTO cash_movements(id, user_id, shift_id, type, category, amount, date) VALUES
        ('receipt', 'owner', 'legacy', 'receipt', 'pharmacy', 20, '2026-01-01'),
        ('expense', 'owner', 'legacy', 'disbursement', 'expense', 10, '2026-01-01'),
        ('handover', 'owner', 'legacy', 'disbursement', 'handover', 30, '2026-01-01');
    `);
    const result = await dashboard();
    expect(result.data).toMatchObject({ treasuryBalance: 0, drawerBalance: 120, drawerShiftId: 'legacy', detailCount: 0, details: [] });

    sqlite.prepare("UPDATE shifts SET transfer_amount = 50 WHERE id = 'legacy'").run();
    const legacyUnrecorded = await dashboard();
    expect(legacyUnrecorded.data).toMatchObject({ treasuryBalance: 0, drawerBalance: 100 });
  });

  it('rolls back legacy shift closure when its cash-difference journal cannot post', async () => {
    sqlite.prepare("INSERT INTO shifts(id, user_id, starting_cash, status) VALUES ('legacy-close', 'owner', 100, 'open')").run();
    const beforeShift = sqlite.prepare("SELECT status, ending_cash, cash_difference FROM shifts WHERE id='legacy-close'").get();
    sqlite.exec("CREATE TRIGGER block_shift_difference_entry BEFORE INSERT ON journal_entries BEGIN SELECT RAISE(ABORT, 'shift difference journal blocked'); END");

    const result = await closeShiftAction({ shift_id: 'legacy-close', ending_cash_amount: 120 });

    expect(result).toMatchObject({ success: false });
    expect(sqlite.prepare("SELECT status, ending_cash, cash_difference FROM shifts WHERE id='legacy-close'").get()).toEqual(beforeShift);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM daily_journals WHERE description='تسوية وردية: عجز/زيادة نقدية'").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='END_SHIFT'").get()).toEqual({ count: 0 });
  });
});
