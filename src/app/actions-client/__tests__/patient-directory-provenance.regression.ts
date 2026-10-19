/** @jest-environment node */
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

let sqlite: Database.Database;
let actor: any;
jest.mock('@/lib/env', () => ({ isTauri: false }));
jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, args: unknown[] = []) => sqlite.prepare(sql).all(...args)),
  dbGet: jest.fn(async (sql: string, args: unknown[] = []) => sqlite.prepare(sql).get(...args) ?? null),
  dbExecute: jest.fn(async (sql: string, args: unknown[] = []) => {
    const result = sqlite.prepare(sql).run(...args);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'native-request-only'),
}));
jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => actor),
  hasUserPermissionSync: jest.fn((session: any, permission: string) => Boolean(session?.permissions?.[permission])),
}));
jest.mock('@/lib/cache/secure_cache', () => ({ secureCache: { updateDrug: jest.fn() } }));
const {
  addPatientAction, getPatientForPosAction, getPatientProfileAction, getPatientsAction,
  getPatientStatementAction, searchPatientsAction, updatePatientAction,
} = jest.requireActual('@/app/actions-client/patients') as typeof import('@/app/actions-client/patients');

describe('nonempty patient directory tenant provenance', () => {
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE patients (
        id TEXT PRIMARY KEY,full_name TEXT,name_en TEXT,phone TEXT,mobile TEXT,address TEXT,area TEXT,
        birth_date TEXT,gender TEXT,insurance_number TEXT,car_number TEXT,credit_limit REAL,
        opening_balance REAL,points_balance REAL,point_value REAL,customer_type TEXT,payment_method TEXT,
        wallet_balance REAL,notes TEXT
      );
      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY,patient_id TEXT,pharmacy_id TEXT,total_amount REAL,payment_method TEXT,
        status TEXT,created_at TEXT,user_id TEXT
      );
      CREATE TABLE returns (id TEXT,invoice_id TEXT,total_refund REAL,refund_method TEXT,status TEXT,pharmacy_id TEXT);
      CREATE TABLE patient_transactions(patient_id TEXT,type TEXT,amount REAL,date TEXT,user_id TEXT,notes TEXT);
      CREATE TABLE financial_notices(target_type TEXT,target_id TEXT,type TEXT,amount REAL,date TEXT,user_id TEXT,reason TEXT);
      INSERT INTO patients(id,full_name,name_en,phone,credit_limit,opening_balance,points_balance,wallet_balance) VALUES
        ('new-a','New Owned A','Owned A','01011111111',300,0,80,0),
        ('new-b','Private B','B secret','01022222222',9999,0,700,0),
        ('legacy','Legacy PRIVATE','Legacy','01033333333',9999,2000,400,0),
        ('unowned','Unwitnessed PRIVATE','Old','01044444444',9999,0,400,0);
      INSERT INTO sales_invoices VALUES
        ('legacy-a','legacy','tenant-a',555,'credit','completed','2026-10-01','owner-a'),
        ('legacy-b','legacy','tenant-b',777,'credit','completed','2026-10-01','owner-b');
    `);
    sqlite.exec(readFileSync('src-tauri/migrations/061_native_patient_directory_ownership.sql', 'utf8'));
    sqlite.prepare(`INSERT INTO native_patient_directory_ownership
      (patient_id,pharmacy_id,actor_id,intent_sha256) VALUES (?,?,?,?)`)
      .run('new-a', 'tenant-a', 'owner-a', 'a'.repeat(64));
    sqlite.prepare(`INSERT INTO native_patient_directory_ownership
      (patient_id,pharmacy_id,actor_id,intent_sha256) VALUES (?,?,?,?)`)
      .run('new-b', 'tenant-b', 'owner-b', 'b'.repeat(64));
    actor = {
      id: 'owner-a', pharmacy_id: 'tenant-a',
      permissions: { can_view_patients: true, can_access_pos: true },
    };
  });
  afterEach(() => sqlite.close());

  it('shows only prospectively owned patients in directory, POS search and POS persisted lookup', async () => {
    const all = await getPatientsAction();
    expect(all.success).toBe(true);
    expect(all.data).toEqual([expect.objectContaining({
      id: 'new-a', full_name: 'New Owned A', credit_limit: 300,
    })]);
    expect((await searchPatientsAction('', true)).data).toEqual([expect.objectContaining({ id: 'new-a' })]);
    expect((await searchPatientsAction('Owned')).data).toEqual([expect.objectContaining({ id: 'new-a' })]);
    expect((await getPatientForPosAction('new-a')).data).toMatchObject({ full_name: 'New Owned A' });
    for (const other of ['legacy', 'unowned', 'new-b']) {
      expect(await getPatientForPosAction(other)).toMatchObject({ success: false });
      expect(JSON.stringify(all)).not.toContain(other === 'legacy' ? 'Legacy PRIVATE' : other === 'new-b' ? 'Private B' : 'Unwitnessed PRIVATE');
    }
    actor.permissions = { can_access_pos: true };
    expect((await getPatientForPosAction('new-a')).success).toBe(true);
    expect((await getPatientsAction()).success).toBe(false);
    expect((await getPatientProfileAction('new-a')).success).toBe(false);
  });

  it('treats legacy local_default as unidentified and never infers patient ownership from a sale', async () => {
    actor.pharmacy_id = 'local_default';
    for (const result of [
      await getPatientsAction(),
      await searchPatientsAction('Legacy'),
      await searchPatientsAction('', true),
      await getPatientForPosAction('legacy'),
      await getPatientProfileAction('legacy'),
      await getPatientStatementAction('legacy'),
    ]) {
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('Legacy patient ownership'),
      });
    }
    expect((await getPatientsAction({ reportScope: true })).success).toBe(false);
  });

  it('fails the whole financial directory and POS lookup when witnessed ownership becomes ambiguous', async () => {
    sqlite.prepare(`INSERT INTO patient_transactions(patient_id,type,amount) VALUES('new-a','payment',10)`).run();
    for (const result of [
      await getPatientsAction(),
      await searchPatientsAction('Owned'),
      await getPatientForPosAction('new-a'),
      await getPatientProfileAction('new-a'),
    ]) {
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain('New Owned A');
    }
    sqlite.prepare('DELETE FROM patient_transactions').run();
    sqlite.prepare(`INSERT INTO sales_invoices VALUES
      ('other-sale','new-a','tenant-b',500,'credit','completed','2026-10-12','owner-b')`).run();
    expect((await getPatientsAction()).success).toBe(false);
    expect((await getPatientForPosAction('new-a')).success).toBe(false);
  });

  it('does not create globally unowned patients or change a legacy patient through browser actions', async () => {
    const form = {
      full_name: 'New Patient Secure', credit_limit: 100, opening_balance: 0,
      points_balance: 0, point_value: 1, customer_type: 'individual', payment_method: 'cash',
    };
    expect((await addPatientAction(form)).success).toBe(false);
    expect((await updatePatientAction('legacy', form)).success).toBe(false);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM patients').get()).toEqual({ count: 4 });
    expect(sqlite.prepare("SELECT full_name FROM patients WHERE id='legacy'").get())
      .toEqual({ full_name: 'Legacy PRIVATE' });
  });
});
