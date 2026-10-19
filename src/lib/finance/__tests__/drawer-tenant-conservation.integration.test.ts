/** @jest-environment node */

import Database from 'better-sqlite3';
import { dbGet, dbSelect } from '@/lib/db/tauri';
import { getOpenDrawerSnapshot, loadHandoverDetails } from '@/lib/finance/drawer';

// Read-only, synthetic web adapter for the CURRENT drawer.ts SQL. No real
// database, renderer login, native command or finance write is involved.
let sqlite: Database.Database;
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => sqlite.prepare(sql).get(...params) ?? null),
}));

const pharmacyA = 'synthetic-pharmacy-A';
const pharmacyB = 'synthetic-pharmacy-B';

function populateCrossModuleFixture() {
  sqlite.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, full_name TEXT, pharmacy_id TEXT);
    CREATE TABLE shifts (
      id TEXT PRIMARY KEY, user_id TEXT, pharmacy_id TEXT, start_time TEXT,
      end_time TEXT, status TEXT, starting_cash REAL, transfer_amount REAL
    );
    CREATE TABLE sales_invoices (
      id TEXT PRIMARY KEY, pharmacy_id TEXT, shift_id TEXT, status TEXT,
      payment_method TEXT, total_amount REAL, paid_amount REAL, remaining_amount REAL
    );
    CREATE TABLE returns (
      id TEXT PRIMARY KEY, pharmacy_id TEXT, shift_id TEXT, status TEXT,
      refund_method TEXT, total_refund REAL
    );
    CREATE TABLE cash_movements (
      id TEXT PRIMARY KEY, pharmacy_id TEXT, shift_id TEXT, type TEXT,
      category TEXT, source_type TEXT, amount REAL
    );
    INSERT INTO users VALUES ('staff-A', 'staff-a', 'Synthetic staff A', '${pharmacyA}');
    INSERT INTO shifts VALUES
      ('active-A','staff-A','${pharmacyA}','2026-10-15 09:00:00',NULL,'open',100,30),
      ('inactive-B','staff-A','${pharmacyB}','2026-10-14 09:00:00',NULL,'closed',999,0),
      ('unknown-owner','staff-A',NULL,'2026-10-13 09:00:00',NULL,'closed',999,0);
    INSERT INTO sales_invoices VALUES
      ('cash-A','${pharmacyA}','active-A','completed','cash',70,70,0),
      ('visa-A','${pharmacyA}','active-A','completed','visa',90,90,0),
      ('credit-A','${pharmacyA}','active-A','approved','credit',40,15,25),
      ('void-A','${pharmacyA}','active-A','cancelled','cash',900,900,0),
      ('cash-B','${pharmacyB}','active-A','completed','cash',700,700,0),
      ('cash-unknown',NULL,'active-A','completed','cash',400,400,0);
    INSERT INTO returns VALUES
      ('approved-A','${pharmacyA}','active-A','approved','cash',10),
      ('draft-A','${pharmacyA}','active-A','draft','cash',900),
      ('foreign-B','${pharmacyB}','active-A','completed','cash',200),
      ('unknown-refund',NULL,'active-A','completed','cash',250);
    INSERT INTO cash_movements VALUES
      ('receipt-A','${pharmacyA}','active-A','receipt','other','user_drawer',20),
      ('expense-A','${pharmacyA}','active-A','out','expenses','user_drawer',4),
      ('handover-A','${pharmacyA}','active-A','disbursement','handover','user_drawer',15),
      ('safe-A','${pharmacyA}','active-A','receipt','other','main_safe',3000),
      ('receipt-B','${pharmacyB}','active-A','receipt','other','user_drawer',300),
      ('handover-B','${pharmacyB}','active-A','out','handover','user_drawer',100),
      ('unknown-receipt',NULL,'active-A','receipt','other','user_drawer',400);
  `);
}

describe('current-source drawer SQL isolates reconciled cash custody', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    populateCrossModuleFixture();
  });
  afterEach(() => { sqlite.close(); jest.clearAllMocks(); });

  it('reconciles only proven tenant sales, returns and movements even when other tenant and NULL rows reuse the same shift ID', async () => {
    const details = await loadHandoverDetails('active-A');
    expect(details).toMatchObject({
      id: 'active-A', cash_sales: 70, visa_sales: 90, credit_sales: 25,
      returns: 10, receipts: 20, disbursements: 19,
      transferred_so_far: 30, expected_cash: 146,
    });
    const drawer = await getOpenDrawerSnapshot(pharmacyA);
    expect(drawer).toMatchObject({ balance: 146, shiftId: 'active-A' });
    expect(drawer.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'active-A:legacy-transfers', amount: 15, type: 'disbursement' }),
      expect.objectContaining({ id: 'active-A:disbursements', amount: 19, type: 'disbursement' }),
    ]));
    expect(drawer.details.reduce((sum, entry) => sum + (entry.type === 'receipt' ? entry.amount : -entry.amount), 0)).toBe(146);
  });

  it('counts a recorded handover only once and subtracts only any missing legacy transfer amount', async () => {
    sqlite.prepare("UPDATE shifts SET transfer_amount=15 WHERE id='active-A'").run();
    expect((await loadHandoverDetails('active-A')).expected_cash).toBe(161);
    sqlite.prepare("UPDATE shifts SET transfer_amount=50 WHERE id='active-A'").run();
    expect((await loadHandoverDetails('active-A')).expected_cash).toBe(126);
  });

  it('does not claim an unknown historical NULL owner as local_default cash custody', async () => {
    sqlite.exec("UPDATE shifts SET status='closed' WHERE id='active-A'; UPDATE shifts SET status='open' WHERE id='unknown-owner'");
    expect(await getOpenDrawerSnapshot('local_default')).toEqual({ balance: 0, shiftId: null, details: [] });
    await expect(loadHandoverDetails('unknown-owner')).rejects.toThrow();
  });

  it('rejects an open drawer owned by another tenant', async () => {
    sqlite.exec("UPDATE shifts SET status='open' WHERE id='inactive-B'");
    expect(await getOpenDrawerSnapshot(pharmacyB)).toMatchObject({ balance: 999, shiftId: 'inactive-B' });
    expect((await getOpenDrawerSnapshot(pharmacyA)).shiftId).toBe('active-A');
  });

  it('fails closed if a required SQL read is broken instead of publishing partial cash', async () => {
    jest.mocked(dbSelect).mockRejectedValueOnce(new Error('Synthetic SQL SELECT failed'));
    await expect(getOpenDrawerSnapshot(pharmacyA)).rejects.toThrow('Synthetic SQL SELECT failed');
    jest.mocked(dbGet).mockRejectedValueOnce(new Error('Synthetic SQL GET failed'));
    await expect(loadHandoverDetails('active-A')).rejects.toThrow('Synthetic SQL GET failed');
  });
});
