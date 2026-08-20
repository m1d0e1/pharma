import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

let mockDb: Database.Database;
let mockSession: any = { id: 'admin', role: 'owner', pharmacy_id: 'local_default' };
let mockPermission = true;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => Promise<unknown>) => {
    mockDb.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback();
      mockDb.exec('COMMIT');
      return result;
    } catch (error) {
      mockDb.exec('ROLLBACK');
      throw error;
    }
  }),
  generateId: jest.fn(() => 'id-' + Math.random().toString(36).substring(2, 9)),
}));

jest.mock('@/lib/auth/local', () => {
  const actual = jest.requireActual('@/lib/auth/local');
  return {
    ...actual,
    getLocalSession: jest.fn(async () => mockSession),
  };
});

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    reload: jest.fn(async () => undefined),
    getAllDrugs: jest.fn(() => []),
    updateDrug: jest.fn(),
    enrich: jest.fn((rows: unknown[]) => rows),
  },
}));

jest.unmock('@/app/actions-client/inventory');
jest.unmock('@/app/actions-client/patients');
jest.unmock('@/app/actions-client/returns');

import { updateInventoryAction } from '@/app/actions-client/inventory';
import { getPatientStatementAction } from '@/app/actions-client/patients';
import { createReturnAction } from '@/app/actions-client/returns';
import { patientOutstandingBalanceQuery } from '@/lib/patients/balance';

function applyMigrations(db: Database.Database) {
  const files = readdirSync('src-tauri/migrations')
    .filter(file => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(join('src-tauri/migrations', file), 'utf8'));
  }
}

describe('Patient Statement, Inventory Amount Editing, and Credit Returns', () => {
  beforeEach(() => {
    mockPermission = true;
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: 'local_default' };
    mockDb = new Database(':memory:');
    applyMigrations(mockDb);
    mockDb.pragma('foreign_keys = OFF');

    // Seed basic user, account, drug
    mockDb.prepare(`
      INSERT OR IGNORE INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
      VALUES ('admin', 'admin', 'owner', 'Admin', 'local_default', '{}', 1)
    `).run();

    mockDb.prepare(`
      INSERT OR IGNORE INTO master_drugs (id, trade_name, trade_name_en, official_price, large_to_medium)
      VALUES (101, 'بانادول', 'Panadol', 20, 2)
    `).run();

    mockDb.prepare(`
      INSERT OR IGNORE INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, cost_price, expiry_date)
      VALUES ('inv-1', 'local_default', 101, 50, 20, 10, '2028-12-31')
    `).run();

    mockDb.prepare(`
      INSERT OR IGNORE INTO patients (id, full_name, phone, opening_balance)
      VALUES ('pat-1', 'الحاجه مجده', '01012345678', 100)
    `).run();
  });

  afterEach(() => {
    mockDb.close();
  });

  it('updates inventory quantity and price with stock adjustments', async () => {
    // 1. Edit quantity from 50 to 30 with reason
    mockDb.prepare(`INSERT OR IGNORE INTO adjustment_reasons (id, name_ar) VALUES (1, 'تلف عبوات')`).run();

    const updateRes = await updateInventoryAction({
      id: 'inv-1',
      quantity: 30,
      local_selling_price: 25,
      reason_id: 1,
      expiry_date: '2029-01-01',
    });

    expect(updateRes).toEqual({ success: true });

    const inv = mockDb.prepare('SELECT * FROM inventory WHERE id = ?').get('inv-1') as any;
    expect(inv.quantity).toBe(30);
    expect(inv.local_selling_price).toBe(25);
    expect(inv.expiry_date).toBe('2029-01-01');

    // Verify stock adjustment row was created
    const adj = mockDb.prepare('SELECT * FROM stock_adjustments WHERE inventory_id = ?').get('inv-1') as any;
    expect(adj).toBeDefined();
    expect(adj.old_quantity).toBe(50);
    expect(adj.new_quantity).toBe(30);
  });

  it('fetches patient statement with credit sales, returns, and notices without crashing', async () => {
    // 1. Add credit sale
    mockDb.prepare(`
      INSERT INTO sales_invoices (id, patient_id, total_amount, payment_method, status, user_id, created_at)
      VALUES ('inv-credit-1', 'pat-1', 200, 'credit', 'completed', 'admin', '2026-08-01 10:00:00')
    `).run();

    mockDb.prepare(`
      INSERT INTO sales_items (id, invoice_id, drug_id, quantity_sold, unit_price, cost_price)
      VALUES (1, 'inv-credit-1', 101, 10, 20, 10)
    `).run();

    // 2. Add customer payment
    mockDb.prepare(`
      INSERT INTO patient_transactions (id, patient_id, type, amount, payment_method, user_id, date)
      VALUES ('pt-1', 'pat-1', 'payment', 50, 'cash', 'admin', '2026-08-05 12:00:00')
    `).run();

    // 3. Add financial notice
    mockDb.prepare(`
      INSERT INTO financial_notices (id, target_type, target_id, type, amount, reason, date, user_id)
      VALUES ('fn-1', 'customer', 'pat-1', 'debit', 20, 'تعديل حساب', '2026-08-06', 'admin')
    `).run();

    // Fetch statement
    const res = await getPatientStatementAction('pat-1');
    expect(res.success).toBe(true);
    expect(res.data).toBeDefined();
    expect(res.data?.patient.full_name).toBe('الحاجه مجده');
    expect(res.data?.movements.length).toBeGreaterThanOrEqual(2);
    expect(res.data?.items.length).toBeGreaterThanOrEqual(1);

    // Initial 100 + credit sale 200 - payment 50 + imported debit notice 20.
    expect(res.data?.currentBalance).toBe(270);
    expect(res.data?.movements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'إشعار مدين (إضافة)', balance_effect: 20 }),
    ]));
  });

  it('correctly calculates patient balance when returning a drug from a debit/credit sale', async () => {
    // 1. Create a credit invoice of 200 EGP (10 units @ 20 EGP)
    mockDb.prepare(`
      INSERT INTO sales_invoices (id, patient_id, total_amount, payment_method, status, user_id, created_at)
      VALUES ('inv-sale-deb', 'pat-1', 200, 'credit', 'completed', 'admin', '2026-08-10 10:00:00')
    `).run();

    mockDb.prepare(`
      INSERT INTO sales_items (id, invoice_id, drug_id, inventory_id, quantity_sold, unit_price, cost_price, unit)
      VALUES (10, 'inv-sale-deb', 101, 'inv-1', 10, 20, 10, 'large')
    `).run();

    // Verify balance before return: opening (100) + credit sale (200) = 300
    const beforeBal = mockDb.prepare(patientOutstandingBalanceQuery()).get('pat-1') as any;
    expect(beforeBal.outstanding_balance).toBe(300);

    // 2. Return 2 units with refund_method = 'patient_account' (40 EGP discount from debit)
    const returnRes = await createReturnAction({
      invoice_id: 'inv-sale-deb',
      refund_method: 'patient_account',
      reason: 'ارجاع من الحساب',
      patient_id: 'pat-1',
      items: [
        {
          sale_item_id: 10,
          inventory_id: 'inv-1',
          drug_name: 'بانادول',
          quantity: 2,
          unit_price: 20,
          unit: 'large',
        }
      ]
    });

    expect(returnRes.success).toBe(true);
    expect(returnRes.totalRefund).toBe(40);

    // 3. Add an imported debit notice and a normally mirrored credit notice.
    mockDb.prepare(`
      INSERT INTO financial_notices (id, target_type, target_id, type, amount, reason, date, user_id)
      VALUES
        ('fn-imported-debit', 'customer', 'pat-1', 'debit', 15, 'فرق مرتجعات', '2026-08-11', 'admin'),
        ('fn-paired-credit', 'customer', 'pat-1', 'credit', 5, 'خصم إضافي', '2026-08-12', 'admin')
    `).run();
    mockDb.prepare(`
      INSERT INTO patient_transactions (id, patient_id, type, amount, notes, date, user_id)
      VALUES ('pt-paired-credit', 'pat-1', 'adjustment', -5, 'خصم إضافي', '2026-08-12', 'admin')
    `).run();

    // Opening 100 + sale 200 - return 40 + debit notice 15 - credit notice 5.
    const afterBal = mockDb.prepare(patientOutstandingBalanceQuery()).get('pat-1') as any;
    expect(afterBal.outstanding_balance).toBe(270);

    // 4. The mirrored notice is counted once; return and notices keep their signs.
    const statementRes = await getPatientStatementAction('pat-1');
    expect(statementRes.success).toBe(true);
    expect(statementRes.data?.currentBalance).toBe(270);

    const returnMovement = statementRes.data?.movements.find((m: any) => m.type === 'مرتجع بيع');
    expect(returnMovement).toBeDefined();
    expect(returnMovement.balance_effect).toBe(-40);
    expect(statementRes.data?.movements).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'إشعار مدين (إضافة)', balance_effect: 15 }),
      expect.objectContaining({ type: 'إشعار دائن (خصم)', balance_effect: -5 }),
    ]));
  });

  it('works with legacy schema (adjustment_reasons with reason column and cashier permissions)', async () => {
    // Drop table and recreate with legacy `reason` column
    mockDb.exec(`DROP TABLE IF EXISTS adjustment_reasons; CREATE TABLE adjustment_reasons (id INTEGER PRIMARY KEY, reason TEXT);`);
    mockDb.prepare(`INSERT INTO adjustment_reasons (id, reason) VALUES (5, 'هالك مخزني')`).run();

    // 1. Update inventory with legacy reason column and string price as owner
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: 'local_default' };
    mockPermission = true;

    const updateRes = await updateInventoryAction({
      id: 'inv-1',
      quantity: '40' as any,
      local_selling_price: '22.5' as any,
      reason_id: '5' as any,
      expiry_date: '',
    });

    expect(updateRes).toEqual({ success: true });

    // 2. Fetch patient statement as cashier who only has can_sell permission
    mockSession = { id: 'cashier-1', role: 'cashier', pharmacy_id: 'local_default', permissions: JSON.stringify({ can_sell: true }) };
    mockPermission = false; // doesn't have can_view_patients, but has can_sell

    const statementRes = await getPatientStatementAction('pat-1');
    expect(statementRes.success).toBe(true);
    expect(statementRes.data?.patient.full_name).toBe('الحاجه مجده');
  });
});
