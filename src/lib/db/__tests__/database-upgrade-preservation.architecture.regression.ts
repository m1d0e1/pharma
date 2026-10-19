import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ensureCanonicalLocalSchema } from '../canonical-local-schema';

type SqliteDb = Database.Database;

const migrationDirectory = join(process.cwd(), 'src-tauri', 'migrations');

function applyNumberedMigrations(db: SqliteDb, includeLatest: boolean) {
  const files = readdirSync(migrationDirectory)
    .filter(name => /^\d{3}_.*\.sql$/.test(name))
    .sort();
  expect(files.length).toBeGreaterThan(1);
  for (const file of includeLatest ? files : files.slice(0, -1)) {
    db.exec(readFileSync(join(migrationDirectory, file), 'utf8'));
  }
  return files[files.length - 1];
}

function seedExistingUserRecords(db: SqliteDb) {
  db.exec(`
    INSERT INTO users (id, username, password_hash, role, full_name, pharmacy_id, permissions, is_active)
    VALUES ('upgrade-owner', 'upgrade-owner', 'existing-password-hash', 'owner',
      'Existing Owner', 'pharmacy-a', '["process_sales","manage_inventory"]', 1);

    INSERT INTO master_drugs (id, trade_name, official_price)
    VALUES (84001, 'Existing Stock Drug', 120);
    INSERT INTO inventory (
      id, drug_id, pharmacy_id, quantity, batch_number, expiry_date, cost_price, strips_per_box
    ) VALUES (
      'existing-lot', 84001, 'pharmacy-a', 37, 'B-041', '2027-06-30', 3.75, 12
    );

    INSERT INTO accounts (id, parent_id, code, name_ar, name_en, type, balance)
    VALUES (9001, 2, '1.1.99', 'حساب مخصص', 'Existing Asset Account', 'asset', 248.75);
    INSERT INTO daily_journals (id, date, description, created_by, total_amount)
    VALUES ('existing-journal', '2026-07-03', 'Existing balanced entry', 'upgrade-owner', 83.5);
    INSERT INTO journal_entries (journal_id, account_id, type, amount, notes)
    VALUES ('existing-journal', 9001, 'debit', 83.5, 'Existing debit');
    INSERT INTO journal_entries (journal_id, account_id, type, amount, notes)
    VALUES ('existing-journal', 9, 'credit', 83.5, 'Existing credit');
  `);
}

function existingDataSnapshot(db: SqliteDb) {
  return {
    owner: db.prepare(`
      SELECT id, username, password_hash, role, full_name, pharmacy_id, permissions, is_active
      FROM users WHERE id = 'upgrade-owner'
    `).get(),
    lot: db.prepare(`
      SELECT id, drug_id, pharmacy_id, quantity, batch_number, expiry_date, cost_price, strips_per_box
      FROM inventory WHERE id = 'existing-lot'
    `).get(),
    account: db.prepare(`
      SELECT id, parent_id, code, name_ar, name_en, type, balance
      FROM accounts WHERE id = 9001
    `).get(),
    journal: db.prepare(`
      SELECT id, date, description, created_by, total_amount
      FROM daily_journals WHERE id = 'existing-journal'
    `).get(),
    postings: db.prepare(`
      SELECT id, journal_id, account_id, type, amount, notes
      FROM journal_entries WHERE journal_id = 'existing-journal' ORDER BY id
    `).all(),
  };
}

// Simulate constraint drift seen by the standalone compatibility repair. Keep
// every historical row while altering only a disposable in-memory database.
function weakenTable(db: SqliteDb, table: string, change: (sql: string) => string) {
  const record = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql: string };
  const weakened = change(record.sql);
  expect(weakened).not.toBe(record.sql);

  const quotedTable = `"${table}"`;
  const temporary = `"__legacy_copy_${table}"`;
  db.pragma('foreign_keys = OFF');
  db.exec(`CREATE TEMP TABLE ${temporary} AS SELECT * FROM ${quotedTable}`);
  db.exec(`DROP TABLE ${quotedTable}`);
  db.exec(weakened);
  db.exec(`INSERT INTO ${quotedTable} SELECT * FROM temp.${temporary}`);
  db.exec(`DROP TABLE temp.${temporary}`);
  db.pragma('foreign_keys = ON');
}

describe('existing SQLite database upgrade preservation', () => {
  let db: SqliteDb;

  beforeEach(() => {
    db = new Database(':memory:');
    // Begin from an actual numbered migration history, before the latest upgrade.
    applyNumberedMigrations(db, false);
    db.pragma('foreign_keys = ON');
    seedExistingUserRecords(db);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  afterEach(() => {
    db.close();
  });

  it('keeps staff, lot quantities and balanced journal rows while repairing legacy constraints', () => {
    const before = existingDataSnapshot(db);
    expect(before.owner).toMatchObject({ id: 'upgrade-owner', role: 'owner' });
    expect(before.lot).toMatchObject({ id: 'existing-lot', quantity: 37, strips_per_box: 12 });
    expect(before.account).toMatchObject({ code: '1.1.99', balance: 248.75 });
    expect(before.postings).toHaveLength(2);

    weakenTable(db, 'users', sql => sql.replace(
      'username TEXT UNIQUE NOT NULL COLLATE NOCASE',
      'username TEXT NOT NULL COLLATE NOCASE',
    ));
    weakenTable(db, 'inventory', sql => sql.replace(
      'quantity INTEGER DEFAULT 0', 'quantity INTEGER DEFAULT 1',
    ));
    weakenTable(db, 'accounts', sql => sql.replace(
      'code TEXT UNIQUE NOT NULL', 'code TEXT NOT NULL',
    ));
    weakenTable(db, 'journal_entries', sql => sql.replace(
      'amount REAL NOT NULL', 'amount REAL',
    ));

    const latest = readdirSync(migrationDirectory)
      .filter(name => /^\d{3}_.*\.sql$/.test(name)).sort().pop();
    expect(latest).toBeDefined();
    db.exec(readFileSync(join(migrationDirectory, latest!), 'utf8'));
    ensureCanonicalLocalSchema(db);

    expect(existingDataSnapshot(db)).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });

    const userIndexes = db.prepare('PRAGMA index_list(users)').all() as Array<{ name: string; unique: number }>;
    expect(userIndexes.some(index => index.unique === 1 && (
      db.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<{ name: string }>
    ).some(column => column.name === 'username'))).toBe(true);
    expect((db.prepare('PRAGMA table_info(inventory)').all() as Array<{ name: string; dflt_value: string | null }>)
      .find(column => column.name === 'quantity')?.dflt_value).toBe('0');
    expect((db.prepare('PRAGMA table_info(journal_entries)').all() as Array<{ name: string; notnull: number }>)
      .find(column => column.name === 'amount')?.notnull).toBe(1);

    ensureCanonicalLocalSchema(db);
    expect(existingDataSnapshot(db)).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rolls back an unsafe rebuild without removing an orphaned historical stock lot or accounting rows', () => {
    const before = existingDataSnapshot(db);
    weakenTable(db, 'inventory', sql => sql.replace(
      ',\n  FOREIGN KEY (drug_id) REFERENCES master_drugs (id)', '',
    ));
    db.exec(`
      INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, batch_number)
      VALUES ('orphaned-lot', 89999, 'pharmacy-a', 5, 'B-orphan');
    `);
    const orphanBefore = db.prepare(
      "SELECT id, drug_id, quantity, batch_number FROM inventory WHERE id = 'orphaned-lot'",
    ).get();

    expect(() => ensureCanonicalLocalSchema(db)).toThrow(/foreign key/i);
    expect(existingDataSnapshot(db)).toEqual(before);
    expect(db.prepare(
      "SELECT id, drug_id, quantity, batch_number FROM inventory WHERE id = 'orphaned-lot'",
    ).get()).toEqual(orphanBefore);
    expect(db.prepare('PRAGMA foreign_key_list(inventory)').all()).toEqual([]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
  });
});
