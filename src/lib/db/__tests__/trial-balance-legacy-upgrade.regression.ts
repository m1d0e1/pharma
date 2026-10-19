import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import bcrypt from 'bcryptjs';

const directory = join(process.cwd(), 'src-tauri', 'migrations');
const migrations = () => readdirSync(directory)
  .filter(file => file.endsWith('.sql') && Number.isInteger(Number(file.slice(0, 3))))
  .sort();

describe('legacy trial-balance mappings during desktop upgrades', () => {
  it('keeps existing records, restores canonical accounts and prevents recurring duplicate categories', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = OFF');
      for (const file of migrations().filter(file => Number(file.slice(0, 3)) <= 30)) {
        db.exec(readFileSync(join(directory, file), 'utf8'));
      }
      const original = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='trial_balance_settings'")
        .get() as { sql: string };
      const legacy = original.sql.replace(/category TEXT NOT NULL UNIQUE/i, 'category TEXT NOT NULL');
      expect(legacy).not.toBe(original.sql);
      db.exec('CREATE TEMP TABLE previous_mappings AS SELECT * FROM trial_balance_settings');
      db.exec('DROP TABLE trial_balance_settings');
      db.exec(legacy);
      db.exec('INSERT INTO trial_balance_settings SELECT * FROM temp.previous_mappings');
      db.exec('DROP TABLE temp.previous_mappings');
      db.pragma('foreign_keys = ON');

      const hash = bcrypt.hashSync('upgrade-fixture-only', 4);
      db.prepare("INSERT INTO users(id,username,password_hash,role,pharmacy_id,is_active) VALUES ('upgrade-owner','upgrade-owner',?,'owner','ph-a',1)")
        .run(hash);
      db.exec("INSERT INTO master_drugs(id,trade_name,official_price) VALUES(87001,'Preserved Drug',24)");
      db.exec("INSERT INTO inventory(id,drug_id,pharmacy_id,quantity,batch_number,expiry_date,cost_price,strips_per_box) VALUES('upgrade-lot',87001,'ph-a',48,'OLD-LOT','2028-01-31',4.5,12)");
      db.exec("INSERT INTO daily_journals(id,date,description,created_by,total_amount) VALUES('upgrade-journal','2026-07-01','Prior journal','upgrade-owner',24)");
      db.exec("INSERT INTO journal_entries(journal_id,account_id,type,amount) VALUES('upgrade-journal',6,'debit',24),('upgrade-journal',7,'credit',24)");

      const cashAccount = db.prepare("SELECT id FROM accounts WHERE code='1.1.1'").get() as { id: number };
      const wrongAccount = db.prepare('SELECT id FROM accounts WHERE id <> ? ORDER BY id LIMIT 1')
        .get(cashAccount.id) as { id: number };
      expect(wrongAccount.id).not.toBe(cashAccount.id);
      db.prepare("UPDATE trial_balance_settings SET account_id=? WHERE category='cash_drawer'").run(cashAccount.id);
      db.prepare("INSERT INTO trial_balance_settings(category,target_type,account_id) VALUES('cash_drawer','account',?)").run(wrongAccount.id);
      db.prepare("INSERT INTO trial_balance_settings(category,target_type,account_id) VALUES('accounts_receivable','account',?)").run(wrongAccount.id);
      // Pre-plugin category mappings may have NULL target_type, while newer
      // defaults for the same policy-owned category use 'account'.
      db.exec("UPDATE trial_balance_settings SET target_type=NULL WHERE id=(SELECT MIN(id) FROM trial_balance_settings WHERE category='cash_drawer')");

      const before = {
        owner: db.prepare("SELECT username,password_hash,role,pharmacy_id,is_active FROM users WHERE id='upgrade-owner'").get(),
        stock: db.prepare("SELECT quantity,batch_number,expiry_date,cost_price,strips_per_box FROM inventory WHERE id='upgrade-lot'").get(),
        journal: db.prepare("SELECT created_by,total_amount FROM daily_journals WHERE id='upgrade-journal'").get(),
        postings: db.prepare("SELECT account_id,type,amount FROM journal_entries WHERE journal_id='upgrade-journal' ORDER BY id").all(),
      };

      // Replay every forward migration introduced after the existing v30 release.
      for (const file of migrations().filter(file => Number(file.slice(0, 3)) > 30)) {
        db.exec(readFileSync(join(directory, file), 'utf8'));
      }
      expect(db.prepare('SELECT category FROM trial_balance_settings GROUP BY category HAVING COUNT(*) > 1').all())
        .toEqual([]);
      for (const [category, code] of [['cash_drawer', '1.1.1'], ['accounts_receivable', '1.1.2']]) {
        expect(db.prepare('SELECT a.code FROM trial_balance_settings s JOIN accounts a ON a.id=s.account_id WHERE s.category=?')
          .get(category)).toEqual({ code });
      }
      expect(() => db.exec("INSERT INTO trial_balance_settings(category) VALUES('cash_drawer')")).toThrow();
      db.exec("INSERT INTO trial_balance_settings(category,target_type,account_id) VALUES('cash_drawer','account',6) ON CONFLICT(category) DO UPDATE SET target_type=excluded.target_type");
      expect(db.prepare("SELECT username,password_hash,role,pharmacy_id,is_active FROM users WHERE id='upgrade-owner'").get())
        .toEqual(before.owner);
      expect(db.prepare("SELECT quantity,batch_number,expiry_date,cost_price,strips_per_box FROM inventory WHERE id='upgrade-lot'").get())
        .toEqual(before.stock);
      expect(db.prepare("SELECT created_by,total_amount FROM daily_journals WHERE id='upgrade-journal'").get())
        .toEqual(before.journal);
      expect(db.prepare("SELECT account_id,type,amount FROM journal_entries WHERE journal_id='upgrade-journal' ORDER BY id").all())
        .toEqual(before.postings);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });

  it('rolls back instead of deleting a conflicting noncore mapping', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = OFF');
      for (const file of migrations().filter(file => Number(file.slice(0, 3)) <= 30)) {
        db.exec(readFileSync(join(directory, file), 'utf8'));
      }
      const original = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='trial_balance_settings'")
        .get() as { sql: string };
      db.exec('CREATE TEMP TABLE previous_mappings AS SELECT * FROM trial_balance_settings');
      db.exec('DROP TABLE trial_balance_settings');
      db.exec(original.sql.replace(/category TEXT NOT NULL UNIQUE/i, 'category TEXT NOT NULL'));
      db.exec('INSERT INTO trial_balance_settings SELECT * FROM temp.previous_mappings');
      db.exec('DROP TABLE temp.previous_mappings');
      db.pragma('foreign_keys = ON');

      db.prepare("INSERT INTO trial_balance_settings(category,target_type,target_id,target_name,account_id) VALUES ('bank:legacy','bank','b-1','Original Bank',NULL)").run();
      db.prepare("INSERT INTO trial_balance_settings(category,target_type,target_id,target_name,account_id) VALUES ('bank:legacy','bank','b-2','Other Bank',NULL)").run();
      const before = db.prepare("SELECT id,category,target_type,target_id,target_name,account_id FROM trial_balance_settings ORDER BY id").all();
      const sql = readFileSync(join(directory, '031_trial_balance_unique_categories.sql'), 'utf8');
      expect(() => db.transaction(() => db.exec(sql))()).toThrow(/UNIQUE constraint failed/i);
      expect(db.prepare("SELECT id,category,target_type,target_id,target_name,account_id FROM trial_balance_settings ORDER BY id").all())
        .toEqual(before);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });
});
