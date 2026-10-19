import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { ensureCanonicalLocalSchema } from '../canonical-local-schema';

function applyCanonicalMigrations(database: Database.Database) {
  const directory = join(process.cwd(), 'src-tauri', 'migrations');
  for (const file of readdirSync(directory).filter(name => /^\d{3}_.*\.sql$/.test(name)).sort()) {
    database.exec(readFileSync(join(directory, file), 'utf8'));
  }
}

describe('canonical local schema repair atomicity', () => {
  it('rolls back missing-table installation when an orphaned legacy lot blocks constraint repair', () => {
    const database = new Database(':memory:');
    try {
      applyCanonicalMigrations(database);
      database.pragma('foreign_keys = OFF');
      database.exec(`
        DROP TABLE drug_interactions;
        DROP TABLE inventory;
        CREATE TABLE inventory (id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity INTEGER DEFAULT 0);
        INSERT INTO inventory VALUES ('orphaned-lot', 999999999, 'local_default', 5);
      `);
      database.pragma('foreign_keys = ON');

      const missingTable = () => database.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='drug_interactions'",
      ).get();
      const legacyInventorySql = (database.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='inventory'",
      ).get() as { sql: string }).sql;

      expect(missingTable()).toBeUndefined();
      expect(() => ensureCanonicalLocalSchema(database)).toThrow(/foreign key/i);
      expect(missingTable()).toBeUndefined();
      expect((database.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='inventory'",
      ).get() as { sql: string }).sql).toBe(legacyInventorySql);
      expect(database.prepare("SELECT * FROM inventory WHERE id='orphaned-lot'").get()).toEqual({
        id: 'orphaned-lot', drug_id: 999999999, pharmacy_id: 'local_default', quantity: 5,
      });
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      database.close();
    }
  });

  it('keeps the legacy index when canonical replacement rejects duplicate rows', () => {
    const database = new Database(':memory:');
    try {
      applyCanonicalMigrations(database);
      database.exec(`
        DROP INDEX uidx_interactions;
        CREATE INDEX uidx_interactions ON drug_interactions(ingredient_a);
        INSERT INTO drug_interactions(ingredient_a, ingredient_b, description_en)
        VALUES ('review-A', 'review-B', 'old'), ('review-A', 'review-B', 'duplicate');
      `);
      const indexSql = () => (database.prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='uidx_interactions'",
      ).get() as { sql: string } | undefined)?.sql;
      const beforeIndexSql = indexSql();

      expect(() => ensureCanonicalLocalSchema(database)).toThrow(/UNIQUE constraint failed/i);
      expect(indexSql()).toBe(beforeIndexSql);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM drug_interactions WHERE ingredient_a='review-A'",
      ).get()).toEqual({ count: 2 });
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      database.close();
    }
  });
});
