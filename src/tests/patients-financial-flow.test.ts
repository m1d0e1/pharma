import Database from 'better-sqlite3';
import { patientOutstandingBalanceExpression } from '../lib/patients/balance';

function setupTestDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      full_name TEXT
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      phone TEXT,
      credit_limit REAL DEFAULT 0,
      opening_balance REAL DEFAULT 0,
      wallet_balance REAL DEFAULT 0,
      points_balance INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sales_invoices (
      id TEXT PRIMARY KEY,
      patient_id INTEGER,
      user_id TEXT,
      total_amount REAL,
      payment_method TEXT,
      status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS returns (
      id TEXT PRIMARY KEY,
      invoice_id TEXT,
      user_id TEXT,
      total_refund REAL,
      refund_method TEXT,
      status TEXT DEFAULT 'approved',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS patient_transactions (
      id TEXT PRIMARY KEY,
      patient_id INTEGER NOT NULL,
      user_id TEXT,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT,
      notes TEXT,
      date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS financial_notices (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT,
      notes TEXT,
      date TEXT,
      user_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

describe('Patient Financial Flow & Outstanding Balance Logic', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupTestDb();
    db.prepare("INSERT INTO users (id, username, role, full_name) VALUES ('u1', 'admin', 'admin', 'مدير النظام')").run();
    db.prepare(`
      INSERT INTO patients (id, full_name, credit_limit, opening_balance, wallet_balance)
      VALUES (1, 'محمد علي', 1000, 100, 50)
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  function getOutstanding(patientId: number): number {
    const row = db.prepare(`
      SELECT CAST(${patientOutstandingBalanceExpression('p')} AS REAL) AS outstanding_balance
      FROM patients p WHERE p.id = ?
    `).get(patientId) as any;
    return Number(row?.outstanding_balance || 0);
  }

  it('calculates initial debt based on opening_balance', () => {
    expect(getOutstanding(1)).toBe(100);
  });

  it('increases debt when a credit sale is completed', () => {
    db.prepare(`
      INSERT INTO sales_invoices (id, patient_id, user_id, total_amount, payment_method, status)
      VALUES ('inv-c1', 1, 'u1', 250, 'credit', 'completed')
    `).run();

    expect(getOutstanding(1)).toBe(350); // 100 opening + 250 credit sale
  });

  it('does NOT increase debt when a cash sale is made for the patient', () => {
    db.prepare(`
      INSERT INTO sales_invoices (id, patient_id, user_id, total_amount, payment_method, status)
      VALUES ('inv-cash1', 1, 'u1', 500, 'cash', 'completed')
    `).run();

    expect(getOutstanding(1)).toBe(100); // unaffected by cash sales
  });

  it('decreases debt when a return is refunded to patient_account', () => {
    db.prepare(`
      INSERT INTO sales_invoices (id, patient_id, user_id, total_amount, payment_method, status)
      VALUES ('inv-c2', 1, 'u1', 300, 'credit', 'completed')
    `).run();

    db.prepare(`
      INSERT INTO returns (id, invoice_id, user_id, total_refund, refund_method, status)
      VALUES ('ret-1', 'inv-c2', 'u1', 100, 'patient_account', 'approved')
    `).run();

    expect(getOutstanding(1)).toBe(300); // 100 + 300 - 100 = 300
  });

  it('decreases debt when patient pays towards outstanding debt', () => {
    db.prepare(`
      INSERT INTO sales_invoices (id, patient_id, user_id, total_amount, payment_method, status)
      VALUES ('inv-c3', 1, 'u1', 400, 'credit', 'completed')
    `).run();

    // Patient pays 200 EGP
    db.prepare(`
      INSERT INTO patient_transactions (id, patient_id, user_id, type, amount, payment_method, notes, date)
      VALUES ('tx-1', 1, 'u1', 'payment', 200, 'cash', 'سداد جزئي', '2026-07-22')
    `).run();

    expect(getOutstanding(1)).toBe(300); // 100 + 400 - 200 = 300
  });

  it('handles debit adjustments (increases debt) and credit adjustments (decreases debt)', () => {
    // Debit adjustment (positive amount)
    db.prepare(`
      INSERT INTO patient_transactions (id, patient_id, user_id, type, amount, notes, date)
      VALUES ('tx-adj1', 1, 'u1', 'adjustment', 50, 'إشعار مدين', '2026-07-22')
    `).run();

    expect(getOutstanding(1)).toBe(150); // 100 + 50 = 150

    // Credit adjustment (negative amount)
    db.prepare(`
      INSERT INTO patient_transactions (id, patient_id, user_id, type, amount, notes, date)
      VALUES ('tx-adj2', 1, 'u1', 'adjustment', -30, 'إشعار دائن', '2026-07-22')
    `).run();

    expect(getOutstanding(1)).toBe(120); // 150 - 30 = 120
  });

  it('wallet balance is stored separately and can be topped up', () => {
    const patient = db.prepare('SELECT wallet_balance FROM patients WHERE id = 1').get() as any;
    expect(patient.wallet_balance).toBe(50);

    db.prepare('UPDATE patients SET wallet_balance = wallet_balance + ? WHERE id = 1').run(150);

    const updated = db.prepare('SELECT wallet_balance FROM patients WHERE id = 1').get() as any;
    expect(updated.wallet_balance).toBe(200);
  });
});
