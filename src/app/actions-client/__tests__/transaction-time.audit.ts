// Audit-only contract tests. Known failures are intentionally retained; production code is not changed.
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
let mockDb: Database.Database;
let mockId = 0;
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: any[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: any[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: any[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => unknown) => {
    if (mockDb.inTransaction) return callback();
    mockDb.exec('BEGIN IMMEDIATE');
    try { const result = await callback(); mockDb.exec('COMMIT'); return result; }
    catch (error) { mockDb.exec('ROLLBACK'); throw error; }
  }),
  generateId: jest.fn(() => `time-audit-${++mockId}`),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'owner', pharmacy_id: null })),
  hasUserPermissionSync: jest.fn(() => true),
}));
import { addFinancialNoticeAction, addPaperAction, createCashMovementAction, createManualJournalAction } from '../finance';
import { addSupplierPaymentAction } from '../purchases';

beforeEach(() => {
  mockDb = new Database(':memory:');
  for (const file of ['001_initial.sql','008_patient_accounting.sql','011_shift_cash_difference_account.sql','013_shift_handover_details.sql']) {
    mockDb.exec(readFileSync(`src-tauri/migrations/${file}`, 'utf8'));
  }
  mockDb.exec("INSERT INTO shifts(id,user_id,starting_cash,status) VALUES('audit-shift','admin',100,'open')");
});
afterEach(() => mockDb.close());

it.each(['','not-a-date','2026-02-30'])('rejects invalid cash/journal business date %s without committing money', async date => {
  const result = await createCashMovementAction({type:'receipt',category:'pharmacy',amount:10,date});
  expect({ success:result.success, movements:mockDb.prepare('SELECT COUNT(*) AS n FROM cash_movements').get(), journals:mockDb.prepare('SELECT COUNT(*) AS n FROM daily_journals').get() })
    .toEqual({success:false,movements:{n:0},journals:{n:0}});
});

it.each(['2024-02-29','2026-09-01'])('preserves valid/backdated business date %s separately from creation instant', async date => {
  const result = await createCashMovementAction({type:'receipt',category:'pharmacy',amount:10,date});
  expect(result.success).toBe(true);
  const movement = mockDb.prepare('SELECT date,created_at,user_id,shift_id FROM cash_movements WHERE id=?').get(result.id) as any;
  expect(movement).toMatchObject({date,user_id:'admin',shift_id:'audit-shift'});
  expect(Math.abs(Date.now()-Date.parse(movement.created_at.replace(' ','T')+'Z'))).toBeLessThan(2000);
  expect(mockDb.prepare('SELECT date FROM daily_journals').get()).toEqual({date});
});

it.each(['not-a-date','2026-02-30'])('rejects invalid financial-notice date %s', async date => {
  const result = await addFinancialNoticeAction({target_type:'pharmacy',type:'debit',amount:10,reason:'Audit',date});
  expect(result.success).toBe(false);
});

it.each(['not-a-date','2026-02-30'])('rejects invalid manual-journal date %s', async date => {
  const result = await createManualJournalAction({date,description:'Audit',entries:[{account_id:6,type:'debit',amount:10},{account_id:11,type:'credit',amount:10}]});
  expect(result.success).toBe(false);
});

it.each(['not-a-date','2026-02-30'])('rejects invalid supplier-payment date %s', async date => {
  const result = await addSupplierPaymentAction({ supplier_id: 1, amount: 10, date });
  expect(result.success).toBe(false);
});

it('stores a supplier payment business date separately from its UTC creation instant', async () => {
  mockDb.prepare("INSERT INTO suppliers(id,name_ar,balance) VALUES(1,'Audit supplier',100)").run();
  const result = await addSupplierPaymentAction({ supplier_id: 1, amount: 10, payment_method: 'bank', date: '2026-09-01' });
  expect(result.success).toBe(true);
  const row = mockDb.prepare("SELECT date,created_at FROM supplier_transactions WHERE type='payment'").get() as any;
  expect(row.date).toBe('2026-09-01');
  expect(Math.abs(Date.now() - Date.parse(`${row.created_at.replace(' ', 'T')}Z`))).toBeLessThan(2000);
});

it.each(['not-a-date','2026-02-30'])('rejects invalid commercial-paper due date %s', async due_date => {
  const result = await addPaperAction({
    type: 'check', direction: 'in', paper_number: 'CHK-1', amount: 10, due_date, target_name: 'Audit',
  });
  expect(result.success).toBe(false);
});
