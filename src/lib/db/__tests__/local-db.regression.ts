jest.mock('@/scripts/importInteractions', () => ({ importInteractionsFromCSV: jest.fn() }));

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
