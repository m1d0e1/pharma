import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getDatabase, execute } from './client';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

interface Migration {
  version: string;
  filename: string;
  sql: string;
}

function getMigrationFiles(): Migration[] {
  if (!existsSync(MIGRATIONS_DIR)) {
    return [];
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  return files.map((filename) => {
    const version = filename.split('_')[0];
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8');
    return { version, filename, sql };
  });
}

function getAppliedMigrations(): string[] {
  try {
    const result = getDatabase()
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as { version: string }[];
    return result.map((row) => row.version);
  } catch (error) {
    // Table doesn't exist yet
    return [];
  }
}

function createMigrationsTable(): void {
  execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function applyMigration(migration: Migration): void {
  const db = getDatabase();

  db.exec('BEGIN TRANSACTION');

  try {
    // Execute migration SQL
    db.exec(migration.sql);

    // Record migration
    db
      .prepare('INSERT INTO schema_migrations (version) VALUES (?)')
      .run(migration.version);

    db.exec('COMMIT');

    console.log(`Applied migration: ${migration.filename}`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw new Error(`Failed to apply migration ${migration.filename}: ${error}`);
  }
}

export function migrate(): void {
  console.log('Starting database migration...');

  // Create migrations table if it doesn't exist
  createMigrationsTable();

  // Get available and applied migrations
  const availableMigrations = getMigrationFiles();
  const appliedMigrations = getAppliedMigrations();

  // Find pending migrations
  const pendingMigrations = availableMigrations.filter(
    (migration) => !appliedMigrations.includes(migration.version)
  );

  if (pendingMigrations.length === 0) {
    console.log('No pending migrations to apply.');
    return;
  }

  console.log(`Found ${pendingMigrations.length} pending migration(s)`);

  // Apply pending migrations
  for (const migration of pendingMigrations) {
    applyMigration(migration);
  }

  console.log('Migration completed successfully.');
}

export function rollback(targetVersion?: string): void {
  console.log('Rollback not implemented for SQLite. Use backup/restore instead.');
}

export function getMigrationStatus(): {
  applied: string[];
  pending: string[];
} {
  const availableMigrations = getMigrationFiles();
  const appliedMigrations = getAppliedMigrations();

  const pendingMigrations = availableMigrations
    .filter((migration) => !appliedMigrations.includes(migration.version))
    .map((m) => m.version);

  return {
    applied: appliedMigrations,
    pending: pendingMigrations,
  };
}
