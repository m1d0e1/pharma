import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

type SqliteDb = Database.Database;

interface TableColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

interface SchemaObject {
  type: 'index' | 'trigger';
  name: string;
  tbl_name: string;
  sql: string;
}

const MIGRATION_GLOB_HINT = 'src-tauri/migrations/*.sql';

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function migrationDirectory() {
  const candidates = [
    join(process.cwd(), 'src-tauri', 'migrations'),
    join(process.cwd(), '..', 'src-tauri', 'migrations'),
  ];
  const directory = candidates.find(candidate => (
    existsSync(candidate)
    && readdirSync(candidate).some(file => file.endsWith('.sql'))
  ));
  if (!directory) {
    throw new Error(
      `Canonical database migrations are unavailable. Expected ${MIGRATION_GLOB_HINT} in the standalone bundle.`,
    );
  }
  return directory;
}

function buildCanonicalDatabase() {
  const canonical = new Database(':memory:');
  canonical.pragma('foreign_keys = OFF');
  const directory = migrationDirectory();
  for (const file of readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
    canonical.exec(readFileSync(join(directory, file), 'utf8'));
  }
  return canonical;
}

function tableColumns(database: SqliteDb, table: string): TableColumn[] {
  return database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as TableColumn[];
}

function foreignKeys(database: SqliteDb, table: string): ForeignKeyRow[] {
  return database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as ForeignKeyRow[];
}

function normalizedForeignKeys(database: SqliteDb, table: string) {
  return foreignKeys(database, table)
    .map(row => ({
      table: row.table,
      from: row.from,
      to: row.to || '',
      on_update: row.on_update,
      on_delete: row.on_delete,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function normalizedDefault(value: string | null) {
  return String(value ?? '').trim();
}

function tablesNeedingConstraintRepair(target: SqliteDb, canonical: SqliteDb) {
  const targetTables = new Set(
    (target.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>).map(row => row.name),
  );
  const canonicalTables = (
    canonical.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ name: string }>
  ).map(row => row.name);

  const drifted: string[] = [];
  for (const table of canonicalTables) {
    if (!targetTables.has(table) || table.startsWith('master_drugs_fts_')) continue;
    const expectedColumns = tableColumns(canonical, table);
    const actualColumns = new Map(tableColumns(target, table).map(column => [column.name, column]));
    const defaultMismatch = expectedColumns.some(expected => {
      const actual = actualColumns.get(expected.name);
      return actual && normalizedDefault(actual.dflt_value) !== normalizedDefault(expected.dflt_value);
    });
    const fkMismatch = JSON.stringify(normalizedForeignKeys(target, table))
      !== JSON.stringify(normalizedForeignKeys(canonical, table));
    if (defaultMismatch || fkMismatch) drifted.push(table);
  }
  return drifted;
}

function installMissingCanonicalTables(target: SqliteDb, canonical: SqliteDb) {
  const canonicalTables = canonical.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name",
  ).all() as Array<{ name: string; sql: string }>;
  for (const table of canonicalTables) {
    const exists = target.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table.name);
    if (!exists) target.exec(table.sql);
  }
}

function replaceCreateTableName(createSql: string, table: string, replacement: string) {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(?:"${escaped}"|\\[${escaped}\\]|${escaped})`,
    'i',
  );
  if (!pattern.test(createSql.trim())) {
    throw new Error(`Cannot derive canonical CREATE TABLE statement for ${table}`);
  }
  return createSql.trim().replace(pattern, `$1${quoteIdentifier(replacement)}`);
}

function localOnlyColumnDefinition(column: TableColumn) {
  if (column.pk) {
    throw new Error(`Cannot preserve unsupported local-only primary-key column ${column.name}`);
  }
  if (column.notnull && column.dflt_value === null) {
    throw new Error(
      `Cannot safely preserve local-only NOT NULL column ${column.name} without a default`,
    );
  }
  return [
    quoteIdentifier(column.name),
    column.type || 'TEXT',
    column.notnull ? 'NOT NULL' : '',
    column.dflt_value !== null ? `DEFAULT ${column.dflt_value}` : '',
  ].filter(Boolean).join(' ');
}

function rebuildTableFromCanonical(target: SqliteDb, canonical: SqliteDb, table: string) {
  const canonicalSql = canonical.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) as { sql?: string } | undefined;
  if (!canonicalSql?.sql || /^CREATE\s+VIRTUAL\s+TABLE/i.test(canonicalSql.sql)) {
    throw new Error(`Canonical table SQL is unavailable for ${table}`);
  }

  const originalColumns = tableColumns(target, table);
  const existingObjects = target.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name",
  ).all(table) as SchemaObject[];
  const originalCount = Number(
    (target.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number }).count,
  );
  const temporary = `__canonical_repair_${table}`;
  target.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(temporary)}`);
  target.exec(replaceCreateTableName(canonicalSql.sql, table, temporary));

  const canonicalColumnNames = new Set(tableColumns(target, temporary).map(column => column.name));
  for (const column of originalColumns) {
    if (!canonicalColumnNames.has(column.name)) {
      target.exec(
        `ALTER TABLE ${quoteIdentifier(temporary)} ADD COLUMN ${localOnlyColumnDefinition(column)}`,
      );
    }
  }

  const repairedColumns = new Set(tableColumns(target, temporary).map(column => column.name));
  const copyColumns = originalColumns
    .map(column => column.name)
    .filter(column => repairedColumns.has(column));
  if (copyColumns.length) {
    const quoted = copyColumns.map(quoteIdentifier).join(', ');
    target.exec(
      `INSERT INTO ${quoteIdentifier(temporary)} (${quoted}) SELECT ${quoted} FROM ${quoteIdentifier(table)}`,
    );
  }
  const copiedCount = Number(
    (target.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(temporary)}`).get() as { count: number }).count,
  );
  if (copiedCount !== originalCount) {
    throw new Error(`Row-count mismatch while repairing ${table}: ${originalCount} -> ${copiedCount}`);
  }

  target.exec(`DROP TABLE ${quoteIdentifier(table)}`);
  target.exec(
    `ALTER TABLE ${quoteIdentifier(temporary)} RENAME TO ${quoteIdentifier(table)}`,
  );
  for (const schemaObject of existingObjects) {
    target.exec(schemaObject.sql);
  }
}

function installMissingCanonicalObjects(target: SqliteDb, canonical: SqliteDb) {
  const objects = canonical.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name",
  ).all() as SchemaObject[];
  for (const object of objects) {
    const exists = target.prepare(
      'SELECT 1 FROM sqlite_master WHERE type=? AND name=?',
    ).get(object.type, object.name);
    if (!exists) target.exec(object.sql);
  }
}

/**
 * Makes the standalone/better-sqlite fallback honor the same table constraints
 * as the numbered Tauri migrations. Existing rows are copied transactionally.
 * If canonical FKs would expose orphaned legacy data, the whole rebuild rolls
 * back; no rows are deleted or guessed.
 */
export function ensureCanonicalLocalSchema(target: SqliteDb) {
  const canonical = buildCanonicalDatabase();
  try {
    installMissingCanonicalTables(target, canonical);
    const driftedTables = tablesNeedingConstraintRepair(target, canonical);
    if (driftedTables.length === 0) {
      installMissingCanonicalObjects(target, canonical);
      return;
    }

    const foreignKeysEnabled = Number(target.pragma('foreign_keys', { simple: true })) === 1;
    target.pragma('foreign_keys = OFF');
    target.exec('BEGIN IMMEDIATE');
    try {
      for (const table of driftedTables) rebuildTableFromCanonical(target, canonical, table);
      installMissingCanonicalObjects(target, canonical);
      const violations = target.prepare('PRAGMA foreign_key_check').all() as Array<Record<string, unknown>>;
      if (violations.length) {
        const sample = violations.slice(0, 5)
          .map(row => `${row.table || 'unknown'}#${row.rowid ?? '?'} -> ${row.parent || 'unknown'}`)
          .join(', ');
        throw new Error(
          `Canonical local schema foreign key validation failed (${violations.length} violation(s)): ${sample}`,
        );
      }
      target.exec('COMMIT');
    } catch (error) {
      try { target.exec('ROLLBACK'); } catch {}
      throw error;
    } finally {
      target.pragma(`foreign_keys = ${foreignKeysEnabled ? 'ON' : 'OFF'}`);
    }
  } catch (error) {
    throw new Error(
      `Canonical local schema repair failed; existing data was preserved. ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    canonical.close();
  }
}
