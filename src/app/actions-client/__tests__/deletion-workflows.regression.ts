import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;
let mockSession: any = { id: 'admin', role: 'owner', pharmacy_id: null };
let mockPermission = true;
let mockConversionPermission = true;
let mockGeneratedId = 0;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => {
    mockDb.exec('BEGIN IMMEDIATE');
    try {
      const result = await callback(mockCreateSqliteTransactionDb(mockDb));
      mockDb.exec('COMMIT');
      return result;
    } catch (error) {
      mockDb.exec('ROLLBACK');
      throw error;
    }
  }),
  generateId: jest.fn(() => `test-id-${++mockGeneratedId}`),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => mockSession),
  hasUserPermissionSync: jest.fn((_user: any, permission: string) =>
    permission === 'can_modify_unit_conversion' ? mockConversionPermission : mockPermission),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(async () => undefined),
    reload: jest.fn(async () => undefined),
    getAllDrugs: jest.fn(() => []),
    addDrug: jest.fn(),
    updateDrug: jest.fn(),
    enrich: jest.fn((rows: unknown[]) => rows),
  },
}));

jest.mock('@/lib/inventory/refresh', () => ({
  notifyInventoryChanged: jest.fn(),
  notifyDrugCatalogChanged: jest.fn(),
}));

jest.unmock('@/app/actions-client/inventory');
jest.unmock('@/app/actions-client/master-drugs');

import {
  deleteDrugAction,
  deleteInventoryAction,
  getUnusedDrugsAction,
} from '@/app/actions-client/inventory';
import {
  addProductCategoryAction,
  addMasterDrugAction,
  applyMasterDrugCatalogUpdateAction,
  archiveMasterDrugAction,
  deleteProductCategoryAction,
  deleteMasterDrugAction,
  getUnusedItemsAction,
  importMasterDrugWorkbookAction,
  previewMasterDrugCatalogUpdateAction,
  unarchiveMasterDrugAction,
  updateProductCategoryAction,
  updateMasterDrugAction,
} from '@/app/actions-client/master-drugs';
import { secureCache } from '@/lib/cache/secure_cache';
import { notifyDrugCatalogChanged, notifyInventoryChanged } from '@/lib/inventory/refresh';

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

  // The current app runs Tauri SQL migrations after the legacy compatibility
  // repair. Keep this deliberately narrow so the fixture retains its old
  // inventory/history shape while gaining the catalog reconciliation metadata
  // required by the current master-drug actions.
  db.exec(readFileSync('src-tauri/migrations/027_drug_catalog_reconciliation.sql', 'utf8'));
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
    (secureCache.reload as jest.Mock).mockClear();
    (notifyDrugCatalogChanged as jest.Mock).mockClear();
    (notifyInventoryChanged as jest.Mock).mockClear();
    mockGeneratedId = 0;
    mockPermission = true;
    mockConversionPermission = true;
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
    const zeroJournal = mockDb.prepare(`
      SELECT id, total_amount FROM daily_journals
      WHERE description LIKE '%manual-positive%'
      ORDER BY rowid DESC LIMIT 1
    `).get() as any;
    expect(zeroJournal).toEqual(expect.objectContaining({ total_amount: 14 }));
    expect(mockDb.prepare(`
      SELECT type, amount FROM journal_entries
      WHERE journal_id = ? ORDER BY type
    `).all(zeroJournal.id)).toEqual([
      { type: 'credit', amount: 14 },
      { type: 'debit', amount: 14 },
    ]);

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
    expect(referenced).toMatchObject({ success: false, code: 'DRUG_IN_USE' });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id = 2006').get()).toEqual({ count: 1 });

    const missing = await deleteDrugAction(999999);
    expect(missing).toMatchObject({ success: false, error: expect.stringContaining('not found') });

    mockDb.prepare(`
      INSERT INTO drug_catalog_links (catalog_drug_id, master_drug_id, linked_by)
      VALUES (2001, 2001, 'admin')
    `).run();
    expect(await deleteDrugAction(2001)).toEqual({ success: true });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id = 2001').get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM master_drugs_fts WHERE rowid = 2001').get()).toEqual({ count: 0 });
    expect(mockDb.prepare(`
      SELECT catalog_drug_id, reason FROM drug_catalog_suppressions WHERE catalog_drug_id = 2001
    `).get()).toEqual({ catalog_drug_id: 2001, reason: 'deleted_locally' });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM drug_catalog_links WHERE catalog_drug_id = 2001').get()).toEqual({ count: 0 });
    expect(mockDb.prepare(`SELECT COUNT(*) AS count FROM activity_log WHERE action = 'DELETE_MASTER_DRUG'`).get()).toEqual({ count: 1 });
    expect(mockDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('turns the legacy master-drug workbook action into a review-only dry run', async () => {
    insertUserAndDrug(2050);
    mockDb.prepare(`UPDATE master_drugs SET trade_name = 'LOCAL DRUG', official_price = 11 WHERE id = 2050`).run();

    const result = await importMasterDrugWorkbookAction([
      { id: 2050, trade_name: 'LOCAL DRUG', official_price: 99 },
    ]);

    expect(result).toMatchObject({
      success: false,
      code: 'CATALOG_REVIEW_REQUIRED',
      data: expect.objectContaining({
        summary: expect.objectContaining({ changedDrugCount: 1, inventoryRowsAffected: 0, historyRowsAffected: 0 }),
      }),
    });
    expect(mockDb.prepare(`SELECT official_price FROM master_drugs WHERE id = 2050`).get()).toEqual({ official_price: 11 });
    expect(mockDb.prepare(`SELECT COUNT(*) AS count FROM drug_catalog_update_runs`).get()).toEqual({ count: 0 });
  });

  it('requires manage permission to preview and the current owner/admin session to apply a catalog review', async () => {
    insertUserAndDrug(2051);
    const rows = [{ id: 2051, trade_name: 'Drug 2051', official_price: 10 }];

    mockPermission = false;
    expect(await previewMasterDrugCatalogUpdateAction(rows)).toMatchObject({ success: false, error: 'غير مصرح' });

    mockPermission = true;
    mockSession = { id: 'admin', role: 'pharmacist', pharmacy_id: null };
    const pharmacistPreview = await previewMasterDrugCatalogUpdateAction(rows);
    expect(pharmacistPreview).toMatchObject({ success: true, data: expect.objectContaining({ signature: expect.any(String) }) });
    expect(await applyMasterDrugCatalogUpdateAction({
      rows,
      previewSignature: pharmacistPreview.data!.signature,
      fieldDecisions: [],
      newDrugDecisions: [],
      identityConflictDecisions: [],
      adminPassword: 'irrelevant-in-role-preflight',
    })).toMatchObject({ success: false, error: expect.stringContaining('مالك أو مدير') });

    mockSession = { id: 'admin', role: 'owner', pharmacy_id: null };
    const ownerPreview = await previewMasterDrugCatalogUpdateAction(rows);
    const applied = await applyMasterDrugCatalogUpdateAction({
      rows,
      previewSignature: ownerPreview.data!.signature,
      fieldDecisions: [],
      newDrugDecisions: [],
      identityConflictDecisions: [],
      adminPassword: 'test-owner-password',
    });
    expect(applied).toMatchObject({
      success: true,
      data: expect.objectContaining({ inventoryRowsAffected: 0, historyRowsAffected: 0 }),
    });
    expect(secureCache.reload).toHaveBeenCalledTimes(1);
    expect(notifyDrugCatalogChanged).toHaveBeenCalledTimes(1);
  });

  it('deletes an unreferenced product category on the current schema and protects text-linked categories', async () => {
    insertUserAndDrug(2101);
    mockDb.prepare(`UPDATE master_drugs SET category = 'Linked Category' WHERE id = 2101`).run();
    const linked = mockDb.prepare(`
      INSERT INTO product_categories (name_ar, name_en) VALUES ('Linked Category', 'Linked Category EN')
    `).run();
    const disposable = mockDb.prepare(`
      INSERT INTO product_categories (name_ar, name_en) VALUES ('Disposable GUI Category', 'Disposable GUI Category EN')
    `).run();

    const linkedResult = await deleteProductCategoryAction(Number(linked.lastInsertRowid));
    expect(linkedResult).toMatchObject({ success: false, error: expect.stringContaining('أصناف') });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM product_categories WHERE id = ?').get(linked.lastInsertRowid)).toEqual({ count: 1 });

    expect(await deleteProductCategoryAction(Number(disposable.lastInsertRowid))).toEqual({ success: true });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM product_categories WHERE id = ?').get(disposable.lastInsertRowid)).toEqual({ count: 0 });
  });

  it('keeps text-linked drugs attached when a product category is renamed', async () => {
    insertUserAndDrug(2102);
    insertDrug(2103);
    mockDb.prepare(`UPDATE master_drugs SET category = 'Linked Category' WHERE id = 2102`).run();
    mockDb.prepare(`UPDATE master_drugs SET category = 'Linked Category EN' WHERE id = 2103`).run();
    const linked = mockDb.prepare(`
      INSERT INTO product_categories (name_ar, name_en) VALUES ('Linked Category', 'Linked Category EN')
    `).run();
    const categoryId = Number(linked.lastInsertRowid);

    expect(await updateProductCategoryAction(categoryId, {
      name_ar: 'Renamed Category',
      name_en: 'Renamed Category EN',
    })).toEqual({ success: true });

    expect(mockDb.prepare('SELECT category FROM master_drugs WHERE id = 2102').get()).toEqual({
      category: 'Renamed Category',
    });
    expect(mockDb.prepare('SELECT category FROM master_drugs WHERE id = 2103').get()).toEqual({
      category: 'Renamed Category EN',
    });
    expect(await deleteProductCategoryAction(categoryId)).toMatchObject({
      success: false,
      error: expect.stringContaining('أصناف'),
    });
  });

  it('renames Arabic- and English-linked category rows from their original names without double-matching', async () => {
    insertUserAndDrug(2104);
    insertDrug(2105);
    mockDb.prepare(`UPDATE master_drugs SET category = 'Old Arabic' WHERE id = 2104`).run();
    mockDb.prepare(`UPDATE master_drugs SET category = 'Old English' WHERE id = 2105`).run();
    const linked = mockDb.prepare(`
      INSERT INTO product_categories (name_ar, name_en) VALUES ('Old Arabic', 'Old English')
    `).run();

    expect(await updateProductCategoryAction(Number(linked.lastInsertRowid), {
      name_ar: 'Old English',
      name_en: 'New English',
    })).toEqual({ success: true });

    expect(mockDb.prepare('SELECT id, category FROM master_drugs WHERE id IN (2104,2105) ORDER BY id').all()).toEqual([
      { id: 2104, category: 'Old English' },
      { id: 2105, category: 'New English' },
    ]);
  });

  it('rejects category labels that collide with another category bilingual alias', async () => {
    mockDb.prepare(`
      INSERT INTO product_categories (name_ar, name_en) VALUES ('Primary Arabic', 'Shared Alias')
    `).run();

    expect(await addProductCategoryAction({
      name_ar: ' shared alias ',
      name_en: 'Other English',
    })).toMatchObject({ success: false, error: expect.stringContaining('مستخدم') });

    expect(mockDb.prepare(`
      SELECT COUNT(*) AS count FROM product_categories
      WHERE LOWER(TRIM(name_ar)) = LOWER('shared alias')
    `).get()).toEqual({ count: 0 });
  });

  it('refuses to rename a legacy ambiguous category instead of reclassifying another category drugs', async () => {
    insertUserAndDrug(2107);
    mockDb.prepare(`UPDATE master_drugs SET category = 'Shared Legacy Alias' WHERE id = 2107`).run();
    const first = mockDb.prepare(`
      INSERT INTO product_categories (name_ar, name_en) VALUES ('First Category', 'Shared Legacy Alias')
    `).run();
    mockDb.prepare(`
      INSERT INTO product_categories (name_ar, name_en) VALUES ('Shared Legacy Alias', 'Second Category')
    `).run();

    expect(await updateProductCategoryAction(Number(first.lastInsertRowid), {
      name_ar: 'Renamed First Category',
      name_en: 'Renamed First Category EN',
    })).toMatchObject({ success: false, error: expect.stringContaining('مستخدم') });

    expect(mockDb.prepare('SELECT category FROM master_drugs WHERE id = 2107').get()).toEqual({
      category: 'Shared Legacy Alias',
    });
    expect(mockDb.prepare('SELECT name_ar, name_en FROM product_categories WHERE id = ?').get(first.lastInsertRowid)).toEqual({
      name_ar: 'First Category',
      name_en: 'Shared Legacy Alias',
    });
  });

  it('rechecks category references inside the delete transaction before removing the category', async () => {
    insertUserAndDrug(2106);
    const category = mockDb.prepare(`
      INSERT INTO product_categories (name_ar, name_en) VALUES ('Race Category', 'Race Category EN')
    `).run();
    const categoryId = Number(category.lastInsertRowid);
    const { dbTransaction } = jest.requireMock('@/lib/db/tauri') as { dbTransaction: jest.Mock };
    dbTransaction.mockImplementationOnce(async (callback: any) => {
      // Simulate another writer linking a drug immediately before this action
      // acquires its write transaction.
      mockDb.prepare(`UPDATE master_drugs SET category = 'Race Category' WHERE id = 2106`).run();
      mockDb.exec('BEGIN IMMEDIATE');
      try {
        const result = await callback(mockCreateSqliteTransactionDb(mockDb));
        mockDb.exec('COMMIT');
        return result;
      } catch (error) {
        mockDb.exec('ROLLBACK');
        throw error;
      }
    });

    expect(await deleteProductCategoryAction(categoryId)).toMatchObject({
      success: false,
      error: expect.stringContaining('أصناف'),
    });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM product_categories WHERE id = ?').get(categoryId)).toEqual({ count: 1 });
  });

  it('archives used drugs only after permission and confirmation, without changing stock or history', async () => {
    insertUserAndDrug(2001);
    seedMasterDrugReferences();
    const before = ['inventory','sales_items','return_items','purchase_invoice_items','refill_reminders'].map(table => mockDb.prepare(`SELECT * FROM ${table}`).all());
    expect((await archiveMasterDrugAction(2006,false)).success).toBe(false);
    mockPermission=false;
    expect((await archiveMasterDrugAction(2006,true)).success).toBe(false);
    mockPermission=true;
    expect(mockDb.prepare('SELECT stop_dealing FROM master_drugs WHERE id=2006').get()).toEqual({ stop_dealing:0 });
    expect(await archiveMasterDrugAction(2006,true)).toEqual({ success:true });
    expect(mockDb.prepare('SELECT stop_dealing FROM master_drugs WHERE id=2006').get()).toEqual({ stop_dealing:1 });
    expect(['inventory','sales_items','return_items','purchase_invoice_items','refill_reminders'].map(table => mockDb.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='ARCHIVE_MASTER_DRUG'").get()).toEqual({ count:1 });
    expect(notifyInventoryChanged).toHaveBeenCalledTimes(1);
    expect(mockDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('unarchives an archived drug only with permission and confirmation, preserving stock and history', async () => {
    insertUserAndDrug(2001);
    seedMasterDrugReferences();
    mockDb.prepare('UPDATE master_drugs SET stop_dealing=1 WHERE id=2006').run();
    const before = ['inventory','sales_items','return_items','purchase_invoice_items','refill_reminders'].map(table => mockDb.prepare(`SELECT * FROM ${table}`).all());

    expect((await unarchiveMasterDrugAction(2006, false)).success).toBe(false);
    mockPermission = false;
    expect((await unarchiveMasterDrugAction(2006, true)).success).toBe(false);
    mockPermission = true;

    expect(await unarchiveMasterDrugAction(2006, true)).toEqual({ success: true });
    expect(mockDb.prepare('SELECT stop_dealing FROM master_drugs WHERE id=2006').get()).toEqual({ stop_dealing: 0 });
    expect(['inventory','sales_items','return_items','purchase_invoice_items','refill_reminders'].map(table => mockDb.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM activity_log WHERE action='UNARCHIVE_MASTER_DRUG'").get()).toEqual({ count: 1 });
    expect(notifyInventoryChanged).toHaveBeenCalledTimes(1);
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

  it('rejects nonpositive conversion factors on add and update', async () => {
    insertUserAndDrug(3050);

    for (const invalid of [0, -1]) {
      const add = await addMasterDrugAction({
        trade_name: `Invalid conversion ${invalid}`,
        official_price: 10,
        large_to_medium: invalid,
        medium_to_small: 2,
      });
      expect(add).toMatchObject({ success: false, error: expect.stringContaining('تحويل') });
    }

    const before = mockDb.prepare('SELECT large_to_medium, medium_to_small FROM master_drugs WHERE id = 3050').get();
    const update = await updateMasterDrugAction(3050, {
      trade_name: 'Drug 3050',
      official_price: 10,
      large_to_medium: 2,
      medium_to_small: -5,
    });
    expect(update).toMatchObject({ success: false, error: expect.stringContaining('تحويل') });
    expect(mockDb.prepare('SELECT large_to_medium, medium_to_small FROM master_drugs WHERE id = 3050').get()).toEqual(before);
  });

  it('requires conversion permission to rename an existing unit hierarchy', async () => {
    insertUserAndDrug(3051);
    mockDb.prepare(`
      UPDATE master_drugs
      SET large_unit='Box', medium_unit='Strip', small_unit='Tablet', large_to_medium=3, medium_to_small=10
      WHERE id=3051
    `).run();
    mockConversionPermission = false;

    const result = await updateMasterDrugAction(3051, {
      trade_name: 'Drug 3051',
      official_price: 10,
      large_unit: 'Bottle',
      medium_unit: 'Strip',
      small_unit: 'Tablet',
      large_to_medium: 3,
      medium_to_small: 10,
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('تحويل') });
    expect(mockDb.prepare('SELECT large_unit, medium_unit, small_unit FROM master_drugs WHERE id=3051').get()).toEqual({
      large_unit: 'Box', medium_unit: 'Strip', small_unit: 'Tablet',
    });
  });

  it('rejects renaming a custom unit label when historical sales still depend on that label', async () => {
    insertUserAndDrug(3054);
    mockDb.prepare(`
      UPDATE master_drugs
      SET large_unit='Box', medium_unit='Legacy Strip', small_unit='Tablet', large_to_medium=3, medium_to_small=10
      WHERE id=3054
    `).run();
    mockDb.prepare(`INSERT INTO sales_invoices (id, user_id, status) VALUES ('legacy-unit-sale', 'admin', 'completed')`).run();
    mockDb.prepare(`
      INSERT INTO sales_items (invoice_id, drug_id, quantity_sold, unit_price, unit)
      VALUES ('legacy-unit-sale', 3054, 1, 10, 'Legacy Strip')
    `).run();

    const result = await updateMasterDrugAction(3054, {
      trade_name: 'Drug 3054',
      official_price: 10,
      large_unit: 'Box',
      medium_unit: 'New Strip',
      small_unit: 'Tablet',
      large_to_medium: 3,
      medium_to_small: 10,
    });

    expect(result).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT medium_unit FROM master_drugs WHERE id=3054').get()).toEqual({ medium_unit: 'Legacy Strip' });
    expect(mockDb.prepare("SELECT unit FROM sales_items WHERE invoice_id='legacy-unit-sale'").get()).toEqual({ unit: 'Legacy Strip' });
  });

  it('rejects renaming a case-variant generic unit label when reports still depend on its exact case', async () => {
    insertUserAndDrug(3055);
    mockDb.prepare(`
      UPDATE master_drugs
      SET large_unit='Box', medium_unit='Strip', small_unit='Tablet', large_to_medium=3, medium_to_small=10
      WHERE id=3055
    `).run();
    mockDb.prepare(`INSERT INTO sales_invoices (id, user_id, status) VALUES ('case-unit-sale', 'admin', 'completed')`).run();
    mockDb.prepare(`
      INSERT INTO sales_items (invoice_id, drug_id, quantity_sold, unit_price, unit)
      VALUES ('case-unit-sale', 3055, 3, 10, 'Strip')
    `).run();

    const result = await updateMasterDrugAction(3055, {
      trade_name: 'Drug 3055',
      official_price: 10,
      large_unit: 'Box',
      medium_unit: 'Blister',
      small_unit: 'Tablet',
      large_to_medium: 3,
      medium_to_small: 10,
    });

    expect(result).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT medium_unit FROM master_drugs WHERE id=3055').get()).toEqual({ medium_unit: 'Strip' });
    expect(mockDb.prepare("SELECT unit FROM sales_items WHERE invoice_id='case-unit-sale'").get()).toEqual({ unit: 'Strip' });
  });

  it('rejects renaming a custom unit label when case-insensitive consumers still depend on it', async () => {
    insertUserAndDrug(3056);
    mockDb.prepare(`
      UPDATE master_drugs
      SET large_unit='Box', medium_unit='Legacy Strip', small_unit='Tablet', large_to_medium=3, medium_to_small=10
      WHERE id=3056
    `).run();
    mockDb.prepare(`INSERT INTO sales_invoices (id, user_id, status) VALUES ('casefold-unit-sale', 'admin', 'completed')`).run();
    mockDb.prepare(`
      INSERT INTO sales_items (invoice_id, drug_id, quantity_sold, unit_price, unit)
      VALUES ('casefold-unit-sale', 3056, 3, 10, 'legacy strip')
    `).run();

    const result = await updateMasterDrugAction(3056, {
      trade_name: 'Drug 3056',
      official_price: 10,
      large_unit: 'Box',
      medium_unit: 'Blister',
      small_unit: 'Tablet',
      large_to_medium: 3,
      medium_to_small: 10,
    });

    expect(result).toMatchObject({ success: false });
    expect(mockDb.prepare('SELECT medium_unit FROM master_drugs WHERE id=3056').get()).toEqual({ medium_unit: 'Legacy Strip' });
    expect(mockDb.prepare("SELECT unit FROM sales_items WHERE invoice_id='casefold-unit-sale'").get()).toEqual({ unit: 'legacy strip' });
  });

  it('allows a case-variant configured rename when history uses only an independent canonical alias', async () => {
    insertUserAndDrug(3057);
    mockDb.prepare(`
      UPDATE master_drugs
      SET large_unit='Box', medium_unit='Strip', small_unit='Tablet', large_to_medium=3, medium_to_small=10
      WHERE id=3057
    `).run();
    mockDb.prepare(`INSERT INTO sales_invoices (id, user_id, status) VALUES ('independent-alias-sale', 'admin', 'completed')`).run();
    mockDb.prepare(`
      INSERT INTO sales_items (invoice_id, drug_id, quantity_sold, unit_price, unit)
      VALUES ('independent-alias-sale', 3057, 3, 10, 'STRIP')
    `).run();

    const result = await updateMasterDrugAction(3057, {
      trade_name: 'Drug 3057',
      official_price: 10,
      large_unit: 'Box',
      medium_unit: 'Blister',
      small_unit: 'Tablet',
      large_to_medium: 3,
      medium_to_small: 10,
    });

    expect(result).toMatchObject({ success: true });
    expect(mockDb.prepare('SELECT medium_unit FROM master_drugs WHERE id=3057').get()).toEqual({ medium_unit: 'Blister' });
    expect(mockDb.prepare("SELECT unit FROM sales_items WHERE invoice_id='independent-alias-sale'").get()).toEqual({ unit: 'STRIP' });
  });

  it('rechecks conversion permission against the transactional row before a stale save can overwrite it', async () => {
    insertUserAndDrug(3052);
    mockDb.prepare(`
      UPDATE master_drugs
      SET large_unit='Box', medium_unit='Strip', small_unit='Tablet', large_to_medium=3, medium_to_small=10
      WHERE id=3052
    `).run();
    mockConversionPermission = false;

    const { dbTransaction } = jest.requireMock('@/lib/db/tauri') as { dbTransaction: jest.Mock };
    dbTransaction.mockImplementationOnce(async (callback: any) => {
      // Simulate an authorized concurrent conversion edit after the action's
      // initial read but before its write transaction begins.
      mockDb.prepare(`
        UPDATE master_drugs
        SET large_unit='Bottle', large_to_medium=4
        WHERE id=3052
      `).run();
      mockDb.exec('BEGIN IMMEDIATE');
      try {
        const result = await callback(mockCreateSqliteTransactionDb(mockDb));
        mockDb.exec('COMMIT');
        return result;
      } catch (error) {
        mockDb.exec('ROLLBACK');
        throw error;
      }
    });

    const result = await updateMasterDrugAction(3052, {
      trade_name: 'Drug 3052 renamed',
      official_price: 10,
      large_unit: 'Box',
      medium_unit: 'Strip',
      small_unit: 'Tablet',
      large_to_medium: 3,
      medium_to_small: 10,
    });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('تحويل') });
    expect(mockDb.prepare(`
      SELECT trade_name, large_unit, large_to_medium
      FROM master_drugs WHERE id=3052
    `).get()).toEqual({ trade_name: 'Drug 3052', large_unit: 'Bottle', large_to_medium: 4 });
  });

  it('preserves an existing conversion hierarchy on partial edits without conversion permission', async () => {
    insertUserAndDrug(3053);
    mockDb.prepare(`
      UPDATE master_drugs
      SET has_expiry=0, large_unit='Box', medium_unit='Strip', small_unit='Tablet', large_to_medium=3, medium_to_small=10
      WHERE id=3053
    `).run();
    mockConversionPermission = false;

    const result = await updateMasterDrugAction(3053, {
      trade_name: 'Drug 3053 renamed',
      official_price: 12,
    });

    expect(result).toEqual({ success: true });
    expect(mockDb.prepare(`
      SELECT trade_name, official_price, has_expiry, large_unit, medium_unit, small_unit, large_to_medium, medium_to_small
      FROM master_drugs WHERE id=3053
    `).get()).toEqual({
      trade_name: 'Drug 3053 renamed',
      official_price: 12,
      has_expiry: 0,
      large_unit: 'Box',
      medium_unit: 'Strip',
      small_unit: 'Tablet',
      large_to_medium: 3,
      medium_to_small: 10,
    });
  });

  it.each(['add','update'])('allows catalog %s past an exhausted batch alias without changing the old drug', async operation => {
    insertUserAndDrug(3002);
    insertDrug(3003);
    mockDb.exec(`UPDATE master_drugs SET barcode='CORRECT-OLD' WHERE id=3002;
      INSERT INTO inventory(id,drug_id,quantity,barcode) VALUES('empty-alias',3002,0,'REASSIGNED');`);
    const before = mockDb.prepare("SELECT * FROM inventory WHERE id='empty-alias'").get();
    const data = {trade_name:'New strength',official_price:20,barcode:'REASSIGNED'};
    const result = operation === 'add' ? await addMasterDrugAction(data) : await updateMasterDrugAction(3003,data);
    expect(result.success).toBe(true);
    expect(mockDb.prepare("SELECT * FROM inventory WHERE id='empty-alias'").get()).toEqual(before);
    expect(mockDb.prepare('SELECT barcode FROM master_drugs WHERE id=3002').get()).toEqual({barcode:'CORRECT-OLD'});
    expect(mockDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('preserves the previous barcode on existing stock when the master barcode changes', async () => {
    insertUserAndDrug(3002);
    mockDb.prepare("UPDATE master_drugs SET barcode = 'OLD-CODE' WHERE id = 3002").run();
    mockDb.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, barcode)
      VALUES ('old-packages', 'local_default', 3002, 4, 10, NULL)
    `).run();

    const result = await updateMasterDrugAction(3002, {
      trade_name_en: 'Drug 3002',
      official_price: 12,
      barcode: 'NEW-CODE',
    });

    expect(result).toEqual({ success: true });
    expect(mockDb.prepare('SELECT barcode FROM master_drugs WHERE id = 3002').get()).toEqual({ barcode: 'NEW-CODE' });
    expect(mockDb.prepare('SELECT barcode, quantity FROM inventory WHERE id = ?').get('old-packages'))
      .toEqual({ barcode: 'OLD-CODE', quantity: 4 });

    insertUserAndDrug(3003);
    const conflict = await updateMasterDrugAction(3003, {
      trade_name_en: 'Drug 3003',
      official_price: 10,
      barcode: 'OLD-CODE',
    });
    expect(conflict).toMatchObject({ success: false, error: expect.stringContaining('Barcode') });
  });
});
