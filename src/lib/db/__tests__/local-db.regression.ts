jest.mock('@/scripts/importInteractions', () => ({ importInteractionsFromCSV: jest.fn() }));

function applyCanonicalMigrations(database: any) {
  const { readFileSync, readdirSync } = require('fs');
  const { join } = require('path');
  for (const file of readdirSync('src-tauri/migrations').filter((name: string) => name.endsWith('.sql')).sort()) {
    database.exec(readFileSync(join('src-tauri/migrations', file), 'utf8'));
  }
}

function weakenSalesItemsConstraints(database: any) {
  const columns = database.prepare('PRAGMA table_info(sales_items)').all() as any[];
  const definitions = columns.map(column => [
    `"${String(column.name).replace(/"/g, '""')}"`,
    column.type || 'TEXT',
    column.pk ? 'PRIMARY KEY' : '',
    column.notnull ? 'NOT NULL' : '',
    column.name !== 'unit' && column.dflt_value !== null ? `DEFAULT ${column.dflt_value}` : '',
  ].filter(Boolean).join(' '));
  database.pragma('foreign_keys = OFF');
  database.exec('DROP TABLE sales_items');
  database.exec(`CREATE TABLE sales_items (${definitions.join(', ')})`);
  database.pragma('foreign_keys = ON');
}

describe('fresh local database bootstrap', () => {
  it('creates the current purchasing, inventory, sales, and return schema', () => {
    process.env.PHARMA_DB_PATH = ':memory:';
    delete (global as any).__db_initialized;
    jest.resetModules();

    const { getDatabase, closeDatabase } = require('../client');
    const db = getDatabase();
    const columns = (table: string) =>
      db.prepare(`PRAGMA table_info(${table})`).all().map((column: any) => column.name);

    expect(columns('master_drugs')).toEqual(expect.arrayContaining(['barcode', 'indications', 'side_effects']));
    expect(columns('purchase_invoices')).toContain('updated_at');
    expect(columns('purchase_invoice_items')).toEqual(expect.arrayContaining(['inventory_id', 'barcode', 'strips_per_box']));
    expect(columns('return_items')).toEqual(expect.arrayContaining(['sale_item_id', 'unit', 'drug_id', 'total_price']));
    expect(columns('purchase_return_items')).toEqual(expect.arrayContaining(['purchase_invoice_item_id', 'unit']));
    expect(columns('master_drugs_fts')).toEqual(expect.arrayContaining(['manufacturer', 'category']));
    expect([
      'drug_catalog_links',
      'drug_catalog_suppressions',
      'drug_catalog_field_policies',
      'drug_catalog_update_runs',
    ].every(table => db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table))).toBe(true);
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_master_drugs_catalog_suppress_before_delete'"
    ).get()).toEqual({ name: 'trg_master_drugs_catalog_suppress_before_delete' });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_drug_catalog_links_master'"
    ).get()).toEqual({ name: 'idx_drug_catalog_links_master' });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_drug_catalog_field_policies_drug'"
    ).get()).toEqual({ name: 'idx_drug_catalog_field_policies_drug' });
    expect(db.prepare('PRAGMA foreign_key_list(drug_catalog_links)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'master_drugs',
          from: 'master_drug_id',
          to: 'id',
          on_delete: 'CASCADE',
        }),
      ]),
    );
    db.prepare('INSERT INTO master_drugs (id, trade_name) VALUES (?, ?)').run(999991, 'Catalog trigger sentinel');
    db.prepare(
      'INSERT INTO drug_catalog_links (catalog_drug_id, master_drug_id, linked_by) VALUES (?, ?, ?)'
    ).run(999991, 999991, 'test');
    db.prepare('DELETE FROM master_drugs WHERE id=?').run(999991);
    expect(db.prepare(
      'SELECT reason FROM drug_catalog_suppressions WHERE catalog_drug_id=?'
    ).get(999991)).toEqual({ reason: 'deleted_locally' });
    expect(db.prepare('SELECT name_ar FROM adjustment_reasons ORDER BY id').all()).toEqual([
      { name_ar: 'جرد وتصحيح رصيد' },
      { name_ar: 'تلف أو كسر' },
      { name_ar: 'منتهي الصلاحية' },
      { name_ar: 'خطأ إدخال' },
    ]);
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });

    closeDatabase();
    delete (global as any).__db_initialized;
    delete process.env.PHARMA_DB_PATH;
  });

  it('enforces the canonical sales-item defaults and foreign keys on a fresh local database', () => {
    process.env.PHARMA_DB_PATH = ':memory:';
    delete (global as any).__db_initialized;
    jest.resetModules();

    const { getDatabase, closeDatabase } = require('../client');
    const db = getDatabase();
    const unitColumn = db.prepare('PRAGMA table_info(sales_items)').all()
      .find((column: any) => column.name === 'unit');
    expect(unitColumn?.dflt_value).toBe("'large'");

    expect(() => db.prepare(
      "INSERT INTO sales_items (invoice_id, drug_id, quantity_sold, unit_price) VALUES ('missing-invoice', 999999, 1, 10)"
    ).run()).toThrow(/FOREIGN KEY constraint failed/i);

    closeDatabase();
    delete (global as any).__db_initialized;
    delete process.env.PHARMA_DB_PATH;
  });

  it('matches the canonical migration foreign-key graph and column defaults on a fresh local database', () => {
    const Database = require('better-sqlite3');
    const { readFileSync, readdirSync } = require('fs');
    const { join } = require('path');

    const canonical = new Database(':memory:');
    for (const file of readdirSync('src-tauri/migrations').filter((name: string) => name.endsWith('.sql')).sort()) {
      canonical.exec(readFileSync(join('src-tauri/migrations', file), 'utf8'));
    }

    process.env.PHARMA_DB_PATH = ':memory:';
    delete (global as any).__db_initialized;
    jest.resetModules();
    const { getDatabase, closeDatabase } = require('../client');
    const local = getDatabase();

    const tableNames = (database: any) => database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_sqlx_migrations' ORDER BY name"
    ).all().map((row: any) => row.name);
    const canonicalTables = tableNames(canonical);
    const localTables = tableNames(local);
    const missingTables = canonicalTables.filter((name: string) => !localTables.includes(name));
    const commonTables = canonicalTables.filter((name: string) => localTables.includes(name));

    const foreignKeys = (database: any, table: string) => database.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .map((row: any) => ({
        table: row.table,
        from: row.from,
        to: row.to,
        on_update: row.on_update,
        on_delete: row.on_delete,
      }))
      .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const foreignKeyMismatches: any[] = [];
    for (const table of commonTables) {
      const actual = foreignKeys(local, table);
      const expected = foreignKeys(canonical, table);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        foreignKeyMismatches.push({ table, expected, actual });
      }
    }

    const columnShape = (database: any, table: string) => new Map(
      database.prepare(`PRAGMA table_info(${table})`).all()
        .map((column: any) => [column.name, {
          type: String(column.type || '').toUpperCase(),
          notnull: Number(column.notnull),
          default: String(column.dflt_value ?? ''),
          pk: Number(column.pk),
        }])
    );
    const columnMismatches: any[] = [];
    for (const table of commonTables) {
      const expected = columnShape(canonical, table);
      const actual = columnShape(local, table);
      for (const [column, expectedShape] of expected.entries()) {
        const actualShape = actual.get(column);
        if (!actualShape || JSON.stringify(actualShape) !== JSON.stringify(expectedShape)) {
          columnMismatches.push({ table, column, expected: expectedShape, actual: actualShape || null });
        }
      }
    }

    const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim().toLowerCase();
    const canonicalObjects = canonical.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type, name"
    ).all() as Array<{ type: string; name: string; sql: string }>;
    const objectMismatches: any[] = [];
    for (const expected of canonicalObjects) {
      const actual = local.prepare(
        'SELECT type, name, sql FROM sqlite_master WHERE type=? AND name=?'
      ).get(expected.type, expected.name) as { type: string; name: string; sql: string } | undefined;
      if (!actual || normalizeSql(actual.sql) !== normalizeSql(expected.sql)) {
        objectMismatches.push({
          type: expected.type,
          name: expected.name,
          expected: normalizeSql(expected.sql),
          actual: actual ? normalizeSql(actual.sql) : null,
        });
      }
    }

    expect({
      missingTables,
      foreignKeyMismatches,
      columnMismatches,
      objectMismatches,
    }).toEqual({
      missingTables: [],
      foreignKeyMismatches: [],
      columnMismatches: [],
      objectMismatches: [],
    });

    canonical.close();
    closeDatabase();
    delete (global as any).__db_initialized;
    delete process.env.PHARMA_DB_PATH;
  });

  it('repairs a structurally weak legacy local schema without losing valid rows', () => {
    const Database = require('better-sqlite3');
    const { join } = require('path');
    const { tmpdir } = require('os');
    const { unlinkSync } = require('fs');
    const dbPath = join(tmpdir(), `pharma-legacy-constraints-${process.pid}-${Date.now()}.db`);
    const legacy = new Database(dbPath);
    applyCanonicalMigrations(legacy);
    weakenSalesItemsConstraints(legacy);
    legacy.exec(`
      INSERT INTO master_drugs(id, trade_name) VALUES (51001, 'Legacy Drug');
      INSERT INTO inventory(id, drug_id, pharmacy_id, quantity) VALUES ('legacy-lot', 51001, 'local_default', 4);
      INSERT INTO sales_invoices(id, pharmacy_id, total_amount, status) VALUES ('legacy-sale', 'local_default', 10, 'completed');
      INSERT INTO sales_items(invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit)
      VALUES ('legacy-sale', 'legacy-lot', 51001, 1, 10, 'large');
    `);
    legacy.close();

    process.env.PHARMA_DB_PATH = dbPath;
    delete (global as any).__db_initialized;
    jest.resetModules();
    const { getDatabase, closeDatabase } = require('../client');
    const db = getDatabase();
    expect(db.prepare(
      "SELECT invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit FROM sales_items WHERE invoice_id='legacy-sale'"
    ).get()).toEqual({
      invoice_id: 'legacy-sale',
      inventory_id: 'legacy-lot',
      drug_id: 51001,
      quantity_sold: 1,
      unit_price: 10,
      unit: 'large',
    });
    expect(db.prepare('PRAGMA foreign_key_list(sales_items)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: 'sales_invoices', from: 'invoice_id', to: 'id' }),
        expect.objectContaining({ table: 'inventory', from: 'inventory_id', to: 'id' }),
        expect.objectContaining({ table: 'master_drugs', from: 'drug_id', to: 'id' }),
      ]),
    );
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    closeDatabase();
    delete (global as any).__db_initialized;
    delete process.env.PHARMA_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch {}
    }
  });

  it('rolls back canonical constraint repair instead of deleting orphan legacy data', () => {
    const Database = require('better-sqlite3');
    const { join } = require('path');
    const { tmpdir } = require('os');
    const { unlinkSync } = require('fs');
    const dbPath = join(tmpdir(), `pharma-orphan-constraints-${process.pid}-${Date.now()}.db`);
    const legacy = new Database(dbPath);
    applyCanonicalMigrations(legacy);
    weakenSalesItemsConstraints(legacy);
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`
      INSERT INTO sales_items(invoice_id, drug_id, quantity_sold, unit_price)
      VALUES ('missing-invoice', 991991, 1, 10);
    `);
    legacy.close();

    process.env.PHARMA_DB_PATH = dbPath;
    delete (global as any).__db_initialized;
    jest.resetModules();
    const { getDatabase, closeDatabase } = require('../client');
    expect(() => getDatabase()).toThrow(/canonical local schema|foreign key/i);
    try { closeDatabase(); } catch {}

    const preserved = new Database(dbPath);
    expect(preserved.prepare(
      "SELECT invoice_id, drug_id, quantity_sold, unit_price FROM sales_items WHERE invoice_id='missing-invoice'"
    ).get()).toEqual({
      invoice_id: 'missing-invoice',
      drug_id: 991991,
      quantity_sold: 1,
      unit_price: 10,
    });
    preserved.close();

    delete (global as any).__db_initialized;
    delete process.env.PHARMA_DB_PATH;
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch {}
    }
  });

  it('upgrades a legacy users table that predates pharmacy scope without losing the user', () => {
    const Database = require('better-sqlite3');
    const { join } = require('path');
    const { tmpdir } = require('os');
    const { unlinkSync } = require('fs');
    const dbPath = join(tmpdir(), `pharma-legacy-users-${process.pid}-${Date.now()}.db`);
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        role TEXT,
        full_name TEXT,
        permissions TEXT,
        is_active INTEGER DEFAULT 1
      );
      INSERT INTO users (id, username, password_hash, role, full_name, permissions, is_active)
      VALUES ('legacy-owner', 'legacy-owner', 'hash', 'owner', 'Legacy Owner', NULL, 1);
    `);
    legacy.close();

    process.env.PHARMA_DB_PATH = dbPath;
    delete (global as any).__db_initialized;
    jest.resetModules();

    const { getDatabase, closeDatabase } = require('../client');
    const db = getDatabase();
    const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column: any) => column.name);
    expect(userColumns).toContain('pharmacy_id');
    expect(db.prepare('SELECT id, username, full_name FROM users WHERE id = ?').get('legacy-owner')).toEqual({
      id: 'legacy-owner',
      username: 'legacy-owner',
      full_name: 'Legacy Owner',
    });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='drug_catalog_update_runs'"
    ).get()).toEqual({ name: 'drug_catalog_update_runs' });
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_master_drugs_catalog_suppress_before_delete'"
    ).get()).toEqual({ name: 'trg_master_drugs_catalog_suppress_before_delete' });
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });

    closeDatabase();
    delete (global as any).__db_initialized;
    delete process.env.PHARMA_DB_PATH;
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(`${dbPath}-wal`); } catch {}
    try { unlinkSync(`${dbPath}-shm`); } catch {}
  });

  it('keeps a legacy shift and its cash on the sale branch when staff moved before upgrade', () => {
    const Database = require('better-sqlite3');
    const { join } = require('path');
    const { tmpdir } = require('os');
    const { unlinkSync } = require('fs');
    const dbPath = join(tmpdir(), `pharma-legacy-shift-scope-${process.pid}-${Date.now()}.db`);
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        role TEXT,
        full_name TEXT,
        pharmacy_id TEXT,
        permissions TEXT,
        is_active INTEGER DEFAULT 1
      );
      INSERT INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
      VALUES ('moved', 'moved', 'pharmacist', 'Moved Staff', 'ph-B', NULL, 1);

      CREATE TABLE shifts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        start_time DATETIME,
        end_time DATETIME,
        starting_cash REAL DEFAULT 0,
        ending_cash REAL,
        status TEXT DEFAULT 'open',
        notes TEXT
      );
      INSERT INTO shifts (id, user_id, start_time, end_time, status)
      VALUES ('old-shift', 'moved', '2026-01-01 08:00:00', '2026-01-01 16:00:00', 'closed');

      CREATE TABLE sales_invoices (
        id TEXT PRIMARY KEY,
        pharmacy_id TEXT,
        user_id TEXT,
        patient_id TEXT,
        shift_id TEXT,
        total_amount REAL,
        payment_method TEXT,
        check_number TEXT,
        status TEXT DEFAULT 'completed',
        discount_amount REAL DEFAULT 0,
        paid_amount REAL DEFAULT 0,
        remaining_amount REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO sales_invoices (id, pharmacy_id, user_id, shift_id, total_amount, status, created_at)
      VALUES ('old-sale', 'ph-A', 'moved', 'old-shift', 25, 'completed', '2026-01-01 10:00:00');

      CREATE TABLE cash_movements (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        shift_id TEXT,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        amount REAL NOT NULL,
        notes TEXT,
        date TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO cash_movements (id, user_id, shift_id, type, category, amount, date)
      VALUES ('old-cash', 'moved', 'old-shift', 'receipt', 'sale', 25, '2026-01-01');

      CREATE TABLE expenses (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        category TEXT NOT NULL,
        amount REAL NOT NULL,
        description TEXT,
        date TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO expenses (id, user_id, category, amount, description, date)
      VALUES ('cash-movement-old-cash', 'moved', 'rent', 25, 'Historical rent', '2026-01-01');
    `);
    legacy.close();

    process.env.PHARMA_DB_PATH = dbPath;
    delete (global as any).__db_initialized;
    jest.resetModules();

    const { getDatabase, closeDatabase } = require('../client');
    const db = getDatabase();
    expect(db.prepare("SELECT pharmacy_id FROM sales_invoices WHERE id = 'old-sale'").get()).toEqual({ pharmacy_id: 'ph-A' });
    expect(db.prepare("SELECT pharmacy_id FROM shifts WHERE id = 'old-shift'").get()).toEqual({ pharmacy_id: 'ph-A' });
    expect(db.prepare("SELECT pharmacy_id FROM cash_movements WHERE id = 'old-cash'").get()).toEqual({ pharmacy_id: 'ph-A' });
    expect(db.prepare("SELECT pharmacy_id FROM expenses WHERE id = 'cash-movement-old-cash'").get()).toEqual({ pharmacy_id: 'ph-A' });
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });

    closeDatabase();
    delete (global as any).__db_initialized;
    delete process.env.PHARMA_DB_PATH;
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(`${dbPath}-wal`); } catch {}
    try { unlinkSync(`${dbPath}-shm`); } catch {}
  });
});
