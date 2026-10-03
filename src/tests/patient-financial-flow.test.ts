import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { patientOutstandingBalanceQuery } from '@/lib/patients/balance';

describe('patient debit and credit lifecycle', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
    const accountingMigration = readFileSync('src-tauri/migrations/008_patient_accounting.sql', 'utf8');
    db.exec(accountingMigration);
    db.exec(accountingMigration); // Migration must be safe on an upgraded installation.

    db.prepare(`
      INSERT INTO patients (id, full_name, opening_balance, credit_limit, wallet_balance)
      VALUES ('patient-1', 'Ledger Patient', 100, 1000, 500)
    `).run();
  });

  afterEach(() => db.close());

  it('uses one sign-correct balance for sales, account returns, payments, and notices', () => {
    db.prepare(`
      INSERT INTO sales_invoices (id, user_id, patient_id, total_amount, payment_method, status)
      VALUES
        ('credit-complete', 'admin', 'patient-1', 200, 'credit', 'completed'),
        ('cash-complete', 'admin', 'patient-1', 900, 'cash', 'completed'),
        ('credit-draft', 'admin', 'patient-1', 700, 'credit', 'draft')
    `).run();

    db.prepare(`
      INSERT INTO returns (id, invoice_id, user_id, total_refund, refund_method, status)
      VALUES
        ('account-approved', 'credit-complete', 'admin', 50, 'patient_account', 'approved'),
        ('cash-approved', 'credit-complete', 'admin', 30, 'cash', 'approved'),
        ('account-pending', 'credit-complete', 'admin', 40, 'patient_account', 'pending')
    `).run();

    db.prepare(`
      INSERT INTO patient_transactions (id, patient_id, user_id, type, amount, date)
      VALUES
        ('payment', 'patient-1', 'admin', 'payment', 25, '2026-07-22'),
        ('debit-notice', 'patient-1', 'admin', 'adjustment', 10, '2026-07-22'),
        ('credit-notice', 'patient-1', 'admin', 'adjustment', -5, '2026-07-22')
    `).run();

    const result = db.prepare(patientOutstandingBalanceQuery()).get('patient-1') as any;

    // 100 opening + 200 credit sale - 50 account return - 25 payment + 10 - 5 notices.
    expect(result.outstanding_balance).toBe(230);
    // The 500 prepaid wallet, cash sale/return, draft sale, and pending return are separate.
    expect((db.prepare("SELECT wallet_balance FROM patients WHERE id = 'patient-1'").get() as any).wallet_balance).toBe(500);
  });

  it('seeds exactly one mapped account for every patient financial route', () => {
    const expected = {
      bank_clearing: 'asset',
      patient_wallet_liability: 'liability',
      customer_adjustments: 'expense',
      opening_balance_equity: 'equity',
    };

    for (const [category, type] of Object.entries(expected)) {
      const rows = db.prepare(`
        SELECT a.type
        FROM trial_balance_settings t
        JOIN accounts a ON a.id = t.account_id
        WHERE t.category = ?
      `).all(category) as any[];
      expect(rows).toEqual([{ type }]);
    }
  });

  it('keeps every patient journal balanced', () => {
    const mappings = Object.fromEntries(
      (db.prepare(`
        SELECT category, account_id FROM trial_balance_settings
        WHERE category IN ('cash_drawer', 'accounts_receivable', 'patient_wallet_liability')
      `).all() as any[]).map(row => [row.category, row.account_id])
    );
    db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES ('wallet-topup', '2026-07-22', 'Wallet top-up', 'admin', 100)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('wallet-topup', ?, 'debit', 100)").run(mappings.cash_drawer);
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('wallet-topup', ?, 'credit', 100)").run(mappings.patient_wallet_liability);
    db.prepare("INSERT INTO daily_journals (id, date, description, created_by, total_amount) VALUES ('collection', '2026-07-22', 'Collection', 'admin', 60)").run();
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('collection', ?, 'debit', 60)").run(mappings.cash_drawer);
    db.prepare("INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES ('collection', ?, 'credit', 60)").run(mappings.accounts_receivable);

    const journals = db.prepare(`
      SELECT journal_id,
             SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END) AS debit,
             SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END) AS credit
      FROM journal_entries
      GROUP BY journal_id
    `).all() as any[];

    expect(journals).toHaveLength(2);
    expect(journals.every(row => row.debit === row.credit)).toBe(true);
  });
});
