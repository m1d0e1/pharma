import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

let mockDb: Database.Database;
let mockSession: any = { id: 'admin', role: 'owner', pharmacy_id: null };
let mockPermission = true;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => Promise<unknown>) => {
    mockDb.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback();
      mockDb.exec('COMMIT');
      return result;
    } catch (error) {
      mockDb.exec('ROLLBACK');
      throw error;
    }
  }),
  generateId: jest.fn(() => 'test-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn(() => mockPermission),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    reload: jest.fn(async () => undefined),
    getAllDrugs: jest.fn(() => []),
    updateDrug: jest.fn(),
    enrich: jest.fn((rows: unknown[]) => rows),
  },
}));

jest.unmock('@/app/actions-client/inventory');
jest.unmock('@/app/actions-client/master-drugs');

import {
  deleteDrugAction,
  deleteInventoryAction,
  getUnusedDrugsAction,
} from '@/app/actions-client/inventory';
import {
  addMasterDrugAction,
  deleteMasterDrugAction,
  getUnusedItemsAction,
  updateMasterDrugAction,
} from '@/app/actions-client/master-drugs';

function applyCurrentMigrations(db: Database.Database, includeInitial = true) {
  const files = readdirSync('src-tauri/migrations')
    .filter(file => file.endsWith('.sql'))
    .sort()
    .filter(file => includeInitial || file !== '001_initial.sql');
  for (const file of files) {
    db.exec(readFileSync(join('src-tauri/migrations', file), 'utf8'));
  }
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!columns.some(item => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function upgradeV214ThroughCompatibility(db: Database.Database) {
  // A representative field-updated v0.2.14 database: migration 1's tables
  // remain, but compatibility has supplied the newer columns/tables while
  // several historical inventory links no longer have FK clauses.
  db.exec(readFileSync('src-tauri/migrations/001_initial.sql', 'utf8'));
  db.pragma('foreign_keys = OFF');
  for (const table of ['sales_items', 'return_items', 'purchase_invoice_items']) {
    const createSql = (db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table) as any).sql as string;
    const withoutInventoryFk = createSql
      .replace(/,?\s*FOREIGN KEY \(inventory_id\) REFERENCES inventory \(id\)(?: ON DELETE SET NULL)?/i, '');
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_with_inventory_fk`);
    db.exec(withoutInventoryFk);
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map(column => column.name);
    db.exec(`INSERT INTO ${table} (${columns.join(',')}) SELECT ${columns.join(',')} FROM ${table}_with_inventory_fk`);
    db.exec(`DROP TABLE ${table}_with_inventory_fk`);
  }
  db.pragma('foreign_keys = ON');

  // Exercise the same idempotent column repair contract as schema.rs.
  const compatibilityColumns: Array<[string, string, string]> = [
    ['master_drugs', 'base_price', 'base_price REAL DEFAULT 0'],
    ['master_drugs', 'code_2', 'code_2 TEXT'],
    ['master_drugs', 'item_nature', 'item_nature TEXT'],
    ['master_drugs', 'scientific_group', 'scientific_group TEXT'],
    ['master_drugs', 'usage_method', 'usage_method TEXT'],
    ['master_drugs', 'active_ingredient_ratio', 'active_ingredient_ratio TEXT'],
    ['master_drugs', 'is_table', 'is_table INTEGER DEFAULT 0'],
    ['master_drugs', 'indications', 'indications TEXT'],
    ['master_drugs', 'side_effects', 'side_effects TEXT'],
    ['return_items', 'drug_id', 'drug_id INTEGER'],
    ['return_items', 'total_price', 'total_price REAL'],
    ['return_items', 'sale_item_id', 'sale_item_id INTEGER'],
    ['return_items', 'unit', "unit TEXT DEFAULT 'large'"],
    ['purchase_invoices', 'updated_at', 'updated_at DATETIME'],
    ['purchase_invoice_items', 'strips_per_box', 'strips_per_box INTEGER DEFAULT 1'],
    ['purchase_invoice_items', 'inventory_id', 'inventory_id TEXT'],
    ['purchase_invoice_items', 'barcode', 'barcode TEXT'],
    ['purchase_returns', 'purchase_invoice_id', 'purchase_invoice_id TEXT'],
    ['purchase_return_items', 'purchase_invoice_item_id', 'purchase_invoice_item_id INTEGER'],
    ['purchase_return_items', 'unit', "unit TEXT DEFAULT 'large'"],
  ];
  for (const [table, column, definition] of compatibilityColumns) {
    addColumnIfMissing(db, table, column, definition);
  }
}

function insertUserAndDrug(drugId = 1000) {
  mockDb.prepare(`
    INSERT OR IGNORE INTO users (id, username, role, full_name, pharmacy_id, permissions, is_active)
    VALUES ('admin', 'admin', 'owner', 'Admin', NULL, '{}', 1)
  `).run();
  insertDrug(drugId);
}

function insertDrug(id: number) {
  mockDb.prepare(`
    INSERT INTO master_drugs (id, trade_name, trade_name_en, official_price)
    VALUES (?, ?, ?, 10)
  `).run(id, `Drug ${id}`, `Drug ${id}`);
}

function seedInventoryHistory(drugId: number) {
  const inventoryRows = [
    ['manual-positive', 'local_default', 7, 'MANUAL-7'],
    ['legacy-null', null, 3, null],
    ['empty-unreferenced', 'local_default', 0, 'EMPTY'],
    ['other-branch', 'branch-b', 4, 'OTHER'],
    ['history-sale', 'local_default', 0, 'SALE'],
    ['history-return', 'local_default', 0, 'RETURN'],
    ['history-purchase', 'local_default', 0, 'PURCHASE'],
    ['history-preturn', 'local_default', 0, 'P-RETURN'],
    ['history-adjustment', 'local_default', 0, 'ADJUST'],
  ];
  const inventoryInsert = mockDb.prepare(`
    INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, batch_number, cost_price)
    VALUES (?, ?, ?, ?, ?, 2)
  `);
  for (const row of inventoryRows) inventoryInsert.run(...row.slice(0, 2), drugId, ...row.slice(2));

  mockDb.prepare(`INSERT INTO sales_invoices (id, user_id, status) VALUES ('sale-1', 'admin', 'completed')`).run();
  mockDb.prepare(`
    INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price)
    VALUES ('sale-1', 'history-sale', ?, 1, 10)
  `).run(drugId);

  mockDb.prepare(`INSERT INTO returns (id, user_id, status) VALUES ('return-1', 'admin', 'completed')`).run();
  mockDb.prepare(`
    INSERT INTO return_items (return_id, inventory_id, drug_id, quantity_returned, unit_price)
    VALUES ('return-1', 'history-return', ?, 1, 10)
  `).run(drugId);

  mockDb.prepare(`INSERT INTO suppliers (id, name_ar) VALUES (1, 'Supplier')`).run();
  mockDb.prepare(`
    INSERT INTO purchase_invoices (id, supplier_id, user_id, status)
    VALUES ('purchase-1', 1, 'admin', 'completed')
  `).run();
  mockDb.prepare(`
    INSERT INTO purchase_invoice_items (invoice_id, inventory_id, drug_id, quantity, cost_price)
    VALUES ('purchase-1', 'history-purchase', ?, 1, 2)
  `).run(drugId);

  mockDb.prepare(`
    INSERT INTO purchase_returns (id, supplier_id, user_id, status)
    VALUES ('purchase-return-1', 1, 'admin', 'completed')
  `).run();
  mockDb.prepare(`
    INSERT INTO purchase_return_items (purchase_return_id, inventory_id, drug_id, quantity_returned)
    VALUES ('purchase-return-1', 'history-preturn', ?, 1)
  `).run(drugId);

  mockDb.prepare(`INSERT OR IGNORE INTO adjustment_reasons (id, name_ar) VALUES (91, 'Count')`).run();
  mockDb.prepare(`
    INSERT INTO stock_adjustments (inventory_id, reason_id, old_quantity, new_quantity, user_id)
    VALUES ('history-adjustment', 91, 1, 0, 'admin')
  `).run();
}

function seedMasterDrugReferences() {
  for (let id = 2002; id <= 2013; id += 1) insertDrug(id);

  mockDb.prepare(`INSERT INTO inventory (id, drug_id, pharmacy_id, quantity) VALUES ('master-stock', 2002, 'local_default', 0)`).run();
  mockDb.prepare(`INSERT INTO sales_invoices (id, user_id) VALUES ('master-sale', 'admin')`).run();
  mockDb.prepare(`INSERT INTO sales_items (invoice_id, drug_id, quantity_sold) VALUES ('master-sale', 2003, 1)`).run();
  mockDb.prepare(`INSERT INTO refill_reminders (id, drug_id) VALUES ('master-reminder', 2004)`).run();
  mockDb.prepare(`INSERT INTO returns (id, user_id) VALUES ('master-return', 'admin')`).run();
  mockDb.prepare(`INSERT INTO return_items (return_id, drug_id, quantity_returned) VALUES ('master-return', 2005, 1)`).run();

  mockDb.prepare(`INSERT INTO suppliers (id, name_ar) VALUES (2, 'Supplier 2')`).run();
  mockDb.prepare(`INSERT INTO purchase_invoices (id, supplier_id, user_id) VALUES ('master-purchase', 2, 'admin')`).run();
  mockDb.prepare(`
    INSERT INTO purchase_invoice_items (invoice_id, drug_id, quantity, cost_price)
    VALUES ('master-purchase', 2006, 1, 2)
  `).run();
  mockDb.prepare(`INSERT INTO purchase_orders (id, user_id) VALUES ('master-order', 'admin')`).run();
  mockDb.prepare(`INSERT INTO purchase_order_items (po_id, drug_id, quantity) VALUES ('master-order', 2007, 1)`).run();
  mockDb.prepare(`INSERT INTO purchase_returns (id, supplier_id, user_id) VALUES ('master-preturn', 2, 'admin')`).run();
  mockDb.prepare(`INSERT INTO purchase_return_items (purchase_return_id, drug_id, quantity_returned) VALUES ('master-preturn', 2008, 1)`).run();

  mockDb.prepare(`INSERT INTO opening_balances (id, user_id) VALUES ('master-opening', 'admin')`).run();
  mockDb.prepare(`INSERT INTO opening_balance_items (ob_id, drug_id, quantity) VALUES ('master-opening', 2009, 1)`).run();
  mockDb.prepare(`INSERT INTO shortages (drug_id, requested_quantity) VALUES (2010, 1)`).run();
  mockDb.prepare(`INSERT OR IGNORE INTO indications (id, name_ar) VALUES (81, 'Test')`).run();
  mockDb.prepare(`INSERT INTO drug_indications (drug_id, indication_id) VALUES (2011, 81)`).run();
  mockDb.prepare(`INSERT INTO drug_alternatives (drug_id, alternative_id) VALUES (2012, 2013)`).run();
}

const databaseVariants = [
  {
    name: 'fresh migrations 1-9',
    initialize: (db: Database.Database) => applyCurrentMigrations(db),
  },
  {
    name: 'v0.2.14 schema upgraded through compatibility',
    initialize: (db: Database.Database) => upgradeV214ThroughCompatibility(db),
  },
];

describe.each(databaseVariants)('$name deletion invariants', ({ initialize }) => {
  beforeEach(() => {
    mockPermission = true;
    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    mockDb = new Database(':memory:');
    initialize(mockDb);
    mockDb.pragma('foreign_keys = ON');
  });

  afterEach(() => mockDb.close());

  it('zeroes positive same-pharmacy lots, hard-deletes only unreferenced zero lots, and preserves history', async () => {
    insertUserAndDrug();
    seedInventoryHistory(1000);

    const otherBranch = await deleteInventoryAction({ id: 'other-branch' });
    expect(otherBranch).toMatchObject({ success: false, error: expect.stringContaining('not found') });
    expect(mockDb.prepare(`SELECT COUNT(*) AS count FROM inventory WHERE id = 'other-branch'`).get()).toEqual({ count: 1 });

    const missing = await deleteInventoryAction({ id: 'missing' });
    expect(missing).toMatchObject({ success: false, error: expect.stringContaining('not found') });

    expect(await deleteInventoryAction({ id: 'manual-positive' })).toEqual({ success: true });
    expect(await deleteInventoryAction({ id: 'legacy-null' })).toEqual({ success: true });
    expect(mockDb.prepare(`SELECT quantity FROM inventory WHERE id = 'manual-positive'`).get()).toEqual({ quantity: 0 });
    expect(mockDb.prepare(`SELECT quantity FROM inventory WHERE id = 'legacy-null'`).get()).toEqual({ quantity: 0 });
    expect(mockDb.prepare(`
      SELECT old_quantity, new_quantity, user_id FROM stock_adjustments
      WHERE inventory_id = 'manual-positive'
    `).get()).toEqual({ old_quantity: 7, new_quantity: 0, user_id: 'admin' });

    const zeroLog = mockDb.prepare(`
      SELECT details FROM activity_log
      WHERE action = 'ZERO_INVENTORY' AND details LIKE '%manual-positive%'
    `).get() as any;
    expect(zeroLog.details).toContain('old_quantity=7');
    expect(zeroLog.details).toContain('batch=MANUAL-7');

    // Some field-upgraded databases lost inventory FKs while retaining the
    // reference columns. Explicit preflight still protects zero-quantity history.
    mockDb.pragma('foreign_keys = OFF');
    for (const id of ['history-sale', 'history-return', 'history-purchase', 'history-preturn', 'history-adjustment']) {
      const result = await deleteInventoryAction({ id });
      expect(result).toMatchObject({ success: false, error: expect.stringContaining('history') });
      expect(mockDb.prepare('SELECT COUNT(*) AS count FROM inventory WHERE id = ?').get(id)).toEqual({ count: 1 });
    }
    mockDb.pragma('foreign_keys = ON');

    expect((await deleteInventoryAction({ id: 'manual-positive' })).success).toBe(false);
    expect(mockDb.prepare(`SELECT COUNT(*) AS count FROM inventory WHERE id = 'manual-positive'`).get()).toEqual({ count: 1 });
    expect(await deleteInventoryAction({ id: 'empty-unreferenced' })).toEqual({ success: true });
    expect(mockDb.prepare(`SELECT COUNT(*) AS count FROM inventory WHERE id = 'empty-unreferenced'`).get()).toEqual({ count: 0 });
    expect(mockDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('lists and deletes only truly unreferenced master drugs through both public routes', async () => {
    insertUserAndDrug(2001);
    seedMasterDrugReferences();

    const directList = await getUnusedItemsAction();
    const pageList = await getUnusedDrugsAction();
    expect(directList.success).toBe(true);
    expect(pageList.success).toBe(true);

    const directIds = new Set((directList.data || []).map((item: any) => Number(item.id)));
    const pageIds = new Set((pageList.data || []).map((item: any) => Number(item.id)));
    expect(directIds.has(2001)).toBe(true);
    expect(pageIds.has(2001)).toBe(true);
    for (let id = 2002; id <= 2013; id += 1) {
      expect(directIds.has(id)).toBe(false);
      expect(pageIds.has(id)).toBe(false);
    }

    const referenced = await deleteMasterDrugAction(2006);
    expect(referenced).toMatchObject({ success: false, error: expect.stringContaining('history') });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id = 2006').get()).toEqual({ count: 1 });

    const missing = await deleteDrugAction(999999);
    expect(missing).toMatchObject({ success: false, error: expect.stringContaining('not found') });

    expect(await deleteDrugAction(2001)).toEqual({ success: true });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id = 2001').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM master_drugs_fts WHERE rowid = 2001').get()).toEqual({ count: 0 });
    expect(mockDb.prepare(`SELECT COUNT(*) AS count FROM activity_log WHERE action = 'DELETE_MASTER_DRUG'`).get()).toEqual({ count: 1 });
    expect(mockDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('edits drug card and synchronizes prices on both fresh and upgraded databases', async () => {
    insertUserAndDrug(3001);
    mockDb.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, barcode)
      VALUES ('inv-3001', 'local_default', 3001, 10, 10, 'BAR-OLD')
    `).run();

    // 1. Edit drug card with full fields
    const editRes = await updateMasterDrugAction(3001, {
      trade_name: 'بانادول اكسترا معدل',
      trade_name_en: 'Panadol Extra Modified',
      official_price: 25.5,
      barcode: '6221234567890',
      active_ingredient: 'Paracetamol 500mg + Caffeine 65mg',
      category: 'Analgesics',
      manufacturer: 'GSK',
      large_unit: 'علبة',
      medium_unit: 'شريط',
      small_unit: 'قرص',
      large_to_medium: 3,
      medium_to_small: 10,
      indications: 'Headache, fever',
      side_effects: 'Insomnia',
    });

    expect(editRes).toEqual({ success: true });

    const updated = mockDb.prepare('SELECT * FROM master_drugs WHERE id = 3001').get() as any;
    expect(updated.trade_name).toBe('بانادول اكسترا معدل');
    expect(updated.trade_name_en).toBe('Panadol Extra Modified');
    expect(updated.official_price).toBe(25.5);
    expect(updated.barcode).toBe('6221234567890');
    expect(updated.active_ingredient).toBe('Paracetamol 500mg + Caffeine 65mg');

    // 2. Verify inventory selling price synchronized
    const invRow = mockDb.prepare('SELECT local_selling_price, barcode FROM inventory WHERE id = ?').get('inv-3001') as any;
    expect(invRow.local_selling_price).toBe(25.5);

    // 3. Edit drug card with English name only fallback
    const editNameOnly = await updateMasterDrugAction(3001, {
      trade_name_en: 'Panadol Extra Pure EN',
      official_price: 30,
    });
    expect(editNameOnly).toEqual({ success: true });
    const nameUpdated = mockDb.prepare('SELECT trade_name, trade_name_en, official_price FROM master_drugs WHERE id = 3001').get() as any;
    expect(nameUpdated.trade_name).toBe('Panadol Extra Pure EN');
    expect(nameUpdated.trade_name_en).toBe('Panadol Extra Pure EN');
    expect(nameUpdated.official_price).toBe(30);
  });
});
