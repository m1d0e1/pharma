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

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexInfoRow {
  seqno: number;
  name: string | null;
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

function normalizedType(value: string) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizedSchemaSql(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function uniqueConstraintSignatures(database: SqliteDb, table: string) {
  const indexes = database.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all() as IndexListRow[];
  return indexes
    .filter(index => Number(index.unique) === 1 && index.origin === 'u')
    .map(index => {
      const columns = database.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`).all() as IndexInfoRow[];
      return JSON.stringify({
        columns: columns
          .sort((left, right) => left.seqno - right.seqno)
          .map(column => column.name || ''),
        partial: Number(index.partial),
      });
    })
    .sort();
}

function tableCreateSql(database: SqliteDb, table: string) {
  const row = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table) as { sql?: string } | undefined;
  return row?.sql || '';
}

function extractCheckConstraints(createSql: string) {
  const checks: string[] = [];
  const isWord = (char: string | undefined) => Boolean(char && /[A-Za-z0-9_]/.test(char));
  let quote: "'" | '"' | '`' | ']' | null = null;

  for (let index = 0; index < createSql.length; index += 1) {
    const char = createSql[index];
    if (quote) {
      if (quote === ']' && char === ']') quote = null;
      else if (quote !== ']' && char === quote) {
        if (createSql[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '[') {
      quote = ']';
      continue;
    }
    if (createSql.slice(index, index + 5).toUpperCase() !== 'CHECK'
      || isWord(createSql[index - 1])
      || isWord(createSql[index + 5])) {
      continue;
    }

    let cursor = index + 5;
    while (/\s/.test(createSql[cursor] || '')) cursor += 1;
    if (createSql[cursor] !== '(') continue;

    const start = cursor + 1;
    let depth = 1;
    let innerQuote: "'" | '"' | '`' | ']' | null = null;
    cursor += 1;
    for (; cursor < createSql.length; cursor += 1) {
      const inner = createSql[cursor];
      if (innerQuote) {
        if (innerQuote === ']' && inner === ']') innerQuote = null;
        else if (innerQuote !== ']' && inner === innerQuote) {
          if (createSql[cursor + 1] === innerQuote) cursor += 1;
          else innerQuote = null;
        }
        continue;
      }
      if (inner === "'" || inner === '"' || inner === '`') {
        innerQuote = inner;
        continue;
      }
      if (inner === '[') {
        innerQuote = ']';
        continue;
      }
      if (inner === '(') depth += 1;
      else if (inner === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    checks.push(normalizedSchemaSql(createSql.slice(start, cursor)));
    index = cursor;
  }
  return checks.sort();
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
    const columnMismatch = expectedColumns.some(expected => {
      const actual = actualColumns.get(expected.name);
      return !actual
        || normalizedType(actual.type) !== normalizedType(expected.type)
        || Number(actual.notnull) !== Number(expected.notnull)
        || normalizedDefault(actual.dflt_value) !== normalizedDefault(expected.dflt_value)
        || Number(actual.pk) !== Number(expected.pk);
    });
    const fkMismatch = JSON.stringify(normalizedForeignKeys(target, table))
      !== JSON.stringify(normalizedForeignKeys(canonical, table));
    const actualUnique = new Set(uniqueConstraintSignatures(target, table));
    const uniqueMismatch = uniqueConstraintSignatures(canonical, table)
      .some(signature => !actualUnique.has(signature));
    const actualChecks = new Set(extractCheckConstraints(tableCreateSql(target, table)));
    const checkMismatch = extractCheckConstraints(tableCreateSql(canonical, table))
      .some(check => !actualChecks.has(check));
    if (columnMismatch || fkMismatch || uniqueMismatch || checkMismatch) drifted.push(table);
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

function suspendTriggersForSchemaRepair(target: SqliteDb) {
  const triggers = target.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL ORDER BY name",
  ).all() as SchemaObject[];
  for (const trigger of triggers) {
    target.exec(`DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)}`);
  }
  return triggers;
}

function restoreTriggersAfterSchemaRepair(target: SqliteDb, triggers: SchemaObject[]) {
  for (const trigger of triggers) target.exec(trigger.sql);
}

function installMissingCanonicalObjects(target: SqliteDb, canonical: SqliteDb) {
  const objects = canonical.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name",
  ).all() as SchemaObject[];
  for (const object of objects) {
    const actual = target.prepare(
      'SELECT sql FROM sqlite_master WHERE type=? AND name=?',
    ).get(object.type, object.name) as { sql?: string } | undefined;
    if (!actual) {
      target.exec(object.sql);
      continue;
    }
    if (normalizedSchemaSql(actual.sql || '') === normalizedSchemaSql(object.sql)) continue;
    target.exec(`DROP ${object.type.toUpperCase()} IF EXISTS ${quoteIdentifier(object.name)}`);
    target.exec(object.sql);
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
    const foreignKeysEnabled = Number(target.pragma('foreign_keys', { simple: true })) === 1;
    target.pragma('foreign_keys = OFF');
    let transactionStarted = false;
    try {
      target.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      installMissingCanonicalTables(target, canonical);
      const driftedTables = tablesNeedingConstraintRepair(target, canonical);
      // A trigger owned by one table can reference another table that is being
      // rebuilt. SQLite validates the trigger SQL during DROP/RENAME, so leaving
      // cross-table triggers installed can make an otherwise safe repair fail
      // while the referenced table is briefly absent. DDL is transactional here:
      // suspend all triggers, rebuild the drifted tables, then restore the exact
      // pre-repair trigger set before canonical object reconciliation.
      if (driftedTables.length) {
        const suspendedTriggers = suspendTriggersForSchemaRepair(target);
        for (const table of driftedTables) rebuildTableFromCanonical(target, canonical, table);
        restoreTriggersAfterSchemaRepair(target, suspendedTriggers);
      }
      installMissingCanonicalObjects(target, canonical);
      if (driftedTables.length) {
        const violations = target.prepare('PRAGMA foreign_key_check').all() as Array<Record<string, unknown>>;
        if (violations.length) {
          const sample = violations.slice(0, 5)
            .map(row => `${row.table || 'unknown'}#${row.rowid ?? '?'} -> ${row.parent || 'unknown'}`)
            .join(', ');
          throw new Error(
            `Canonical local schema foreign key validation failed (${violations.length} violation(s)): ${sample}`,
          );
        }
      }
      target.exec('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try { target.exec('ROLLBACK'); } catch {}
      }
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
