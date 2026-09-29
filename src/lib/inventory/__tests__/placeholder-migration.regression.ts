import Database from 'better-sqlite3';
import { createSqliteTransactionDb as mockCreateSqliteTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let mockDb: Database.Database;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) ?? null),
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
  generateId: jest.fn(() => 'generated-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'admin', role: 'owner', pharmacy_id: 'local_default' })),
  hasUserPermissionSync: jest.fn(() => true),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    load: jest.fn(),
    reload: jest.fn(),
    updateDrug: jest.fn(),
    getDisplayName: jest.fn(),
    enrich: jest.fn((items: unknown[]) => items),
  },
}));

jest.unmock('@/app/actions-client/inventory');

import { migrateLegacyPlaceholderInventoryScope } from '@/lib/inventory/placeholder-migration';
import { getInventoryListAction } from '@/app/actions-client/inventory';

function addDrug(id: number, tradeName: string, barcode: string | null = null) {
  mockDb.prepare(`
    INSERT INTO master_drugs (
      id, trade_name, trade_name_en, generic_name, active_ingredient, barcode,
      category, manufacturer, large_to_medium
    ) VALUES (?, ?, ?, '', '', ?, '', '', 1)
  `).run(id, tradeName, tradeName, barcode);
}

function addInventory(id: string, drugId: number, quantity: number, pharmacyId: string | null, barcode: string | null = null) {
  mockDb.prepare(`
    INSERT INTO inventory (
      id, drug_id, quantity, pharmacy_id, expiry_date, local_selling_price,
      cost_price, strips_per_box, barcode
    ) VALUES (?, ?, ?, ?, '2027-12-31', 10, 5, 1, ?)
  `).run(id, drugId, quantity, pharmacyId, barcode);
}

function replacementCollisionCount(sourceId: number, targetId: number): number {
  const row = mockDb.prepare(`
    WITH codes AS (
      SELECT barcode FROM master_drugs WHERE id IN (?, ?)
      UNION
      SELECT barcode FROM inventory WHERE drug_id IN (?, ?)
    ),
    owners AS (
      SELECT id AS drug_id, barcode FROM master_drugs
      UNION
      SELECT drug_id, barcode FROM inventory
    )
    SELECT COUNT(*) AS count
    FROM owners o
    JOIN codes c ON TRIM(o.barcode) = TRIM(c.barcode) COLLATE NOCASE
    WHERE TRIM(COALESCE(c.barcode, '')) != ''
      AND o.drug_id NOT IN (?, ?)
  `).get(sourceId, targetId, sourceId, targetId, sourceId, targetId) as { count: number };
  return Number(row.count);
}

describe('legacy placeholder pharmacy scope migration', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY,
        trade_name TEXT,
        trade_name_en TEXT,
        generic_name TEXT,
        active_ingredient TEXT,
        barcode TEXT,
        category TEXT,
        manufacturer TEXT,
        large_to_medium INTEGER DEFAULT 1
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY,
        drug_id INTEGER NOT NULL,
        quantity REAL NOT NULL DEFAULT 0,
        pharmacy_id TEXT,
        expiry_date TEXT,
        local_selling_price REAL,
        cost_price REAL,
        strips_per_box INTEGER DEFAULT 1,
        barcode TEXT
      );
      CREATE TABLE sales_items (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER);
      CREATE TABLE purchase_invoice_items (id INTEGER PRIMARY KEY AUTOINCREMENT, drug_id INTEGER);
    `);
  });

  afterEach(() => mockDb.close());

  it('moves legacy/null lots to local_default, restores inventory visibility, and clears the unused dummy barcode collision', async () => {
    addDrug(1319, 'Antodine 40 legacy', '6221025003843');
    addDrug(100099, 'انتودين 40 اقراص', '6221025003843');
    addDrug(100001, 'Drug 100001', '6221025003843');
    addDrug(2000, 'LAMIFEN');

    addInventory('legacy-1319', 1319, 1.3333333336666668, 'placeholder-id', '6221025003843');
    addInventory('legacy-lamifen', 2000, 4, null, null);
    addInventory('dummy-zero', 100001, 0, 'placeholder-id', '6221025003843');
    addInventory('official-stock', 100099, 2, 'local_default', '6221025003843');

    const before = await getInventoryListAction(undefined, 1319);
    expect(before).toMatchObject({ success: true, data: [] });
    expect(replacementCollisionCount(1319, 100099)).toBeGreaterThan(0);

    const result = await migrateLegacyPlaceholderInventoryScope();

    expect(result.changed).toBe(true);
    expect(result.affectedItems).toEqual([
      expect.objectContaining({ id: 'legacy-1319', drug_id: 1319, quantity: 1.3333333336666668 }),
      expect.objectContaining({ id: 'legacy-lamifen', drug_id: 2000, quantity: 4 }),
    ]);
    expect(result.migratedRows).toBe(3);
    expect(result.barcodeRowsUpdated).toBe(2);
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM inventory WHERE pharmacy_id = 'placeholder-id'").get()).toEqual({ count: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS count FROM inventory WHERE pharmacy_id IS NULL').get()).toEqual({ count: 0 });
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM inventory WHERE pharmacy_id = 'local_default'").get()).toEqual({ count: 4 });
    expect(mockDb.prepare('SELECT barcode FROM master_drugs WHERE id = 100001').get()).toEqual({ barcode: 'TEMP-100001' });
    expect(mockDb.prepare("SELECT barcode FROM inventory WHERE id = 'dummy-zero'").get()).toEqual({ barcode: 'TEMP-100001' });
    expect(replacementCollisionCount(1319, 100099)).toBe(0);

    const after = await getInventoryListAction(undefined, 1319);
    expect(after.success).toBe(true);
    expect(after.data).toEqual([
      expect.objectContaining({ id: 'legacy-1319', drug_id: 1319, quantity: 1.3333333336666668 }),
    ]);

    const rerun = await migrateLegacyPlaceholderInventoryScope();
    expect(rerun).toMatchObject({ changed: false, affectedItems: [], migratedRows: 0, barcodeRowsUpdated: 0 });
  });

  it('does not rewrite the known barcode when dummy drug #100001 has purchase history', async () => {
    addDrug(100001, 'Drug 100001', '6221025003843');
    addInventory('dummy-history', 100001, 0, 'local_default', '6221025003843');
    mockDb.prepare('INSERT INTO purchase_invoice_items (drug_id) VALUES (100001)').run();

    const result = await migrateLegacyPlaceholderInventoryScope();

    expect(result.changed).toBe(false);
    expect(result.barcodeRowsUpdated).toBe(0);
    expect(mockDb.prepare('SELECT barcode FROM master_drugs WHERE id = 100001').get()).toEqual({ barcode: '6221025003843' });
    expect(mockDb.prepare("SELECT barcode FROM inventory WHERE id = 'dummy-history'").get()).toEqual({ barcode: '6221025003843' });
  });

  it.each(['real name', 'real English name', 'positive stock', 'negative stock', 'sales history', 'master collision', 'lot collision'])(
    'leaves ambiguous barcode data unchanged: %s', async reason => {
      addDrug(100001, 'Drug 100001', '6221025003843');
      addInventory('protected', 100001, 0, 'local_default', '6221025003843');
      if (reason === 'real name') mockDb.exec("UPDATE master_drugs SET trade_name='Real custom drug' WHERE id=100001");
      if (reason === 'real English name') mockDb.exec("UPDATE master_drugs SET trade_name_en='Real custom drug' WHERE id=100001");
      if (reason === 'positive stock') mockDb.exec("UPDATE inventory SET quantity=5 WHERE id='protected'");
      if (reason === 'negative stock') mockDb.exec("UPDATE inventory SET quantity=-1 WHERE id='protected'");
      if (reason === 'sales history') mockDb.exec('INSERT INTO sales_items(drug_id) VALUES(100001)');
      if (reason === 'master collision') addDrug(9001, 'Other', ' temp-100001 ');
      if (reason === 'lot collision') {
        addDrug(9001, 'Other');
        addInventory('other', 9001, 0, 'another-branch', 'TEMP-100001');
      }
      const before = { drugs: mockDb.prepare('SELECT * FROM master_drugs ORDER BY id').all(), lots: mockDb.prepare('SELECT * FROM inventory ORDER BY id').all() };
      expect(await migrateLegacyPlaceholderInventoryScope()).toMatchObject({ changed: false, barcodeRowsUpdated: 0 });
      expect({ drugs: mockDb.prepare('SELECT * FROM master_drugs ORDER BY id').all(), lots: mockDb.prepare('SELECT * FROM inventory ORDER BY id').all() }).toEqual(before);
    },
  );
});
