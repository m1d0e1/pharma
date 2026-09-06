import Database from 'better-sqlite3';

let mockDb: Database.Database;

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => mockDb.prepare(sql).get(...params) || null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    const result = mockDb.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: () => unknown) => callback()),
}));

import { syncMasterDrugsToLocal } from '@/app/actions-client/sync';

describe('non-destructive cloud drug catalog sync', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    mockDb.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_name TEXT NOT NULL,
        trade_name_en TEXT,
        generic_name TEXT,
        active_ingredient TEXT,
        barcode TEXT,
        official_price REAL DEFAULT 0,
        category TEXT,
        manufacturer TEXT,
        notes TEXT,
        large_to_medium INTEGER DEFAULT 1,
        reorder_point REAL DEFAULT 0
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY,
        drug_id INTEGER NOT NULL REFERENCES master_drugs(id),
        quantity REAL NOT NULL
      );
      CREATE TABLE cloud_drug_mappings (
        cloud_id INTEGER PRIMARY KEY,
        local_drug_id INTEGER NOT NULL UNIQUE REFERENCES master_drugs(id) ON DELETE CASCADE,
        last_cloud_name TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO master_drugs
        (id, trade_name, trade_name_en, generic_name, active_ingredient, barcode, official_price, category, manufacturer, notes, large_to_medium, reorder_point)
      VALUES
        (10, 'MY CUSTOM DRUG', 'My custom drug', 'custom generic', 'CUSTOM', 'CUSTOM-10', 17, 'custom category', 'CUSTOM LAB', 'keep me', 12, 7),
        (20, 'PANADOL', 'Panadol Local', 'paracetamol local', 'OLD ACTIVE', '62220', 30, 'old category', 'OLD LAB', 'local note', 10, 5),
        (30, 'LOCAL ONLY', 'Local only', 'local generic', 'LOCAL', 'LOCAL-30', 9, 'local', 'LOCAL LAB', 'custom-only', 8, 3);
      INSERT INTO inventory (id, drug_id, quantity) VALUES ('lot-custom', 10, 4), ('lot-panadol', 20, 6);
    `);
  });

  afterEach(() => mockDb.close());

  it('does not let a shifted cloud ID overwrite the CSV-backed local catalog', async () => {
    const result = await syncMasterDrugsToLocal([
      // Cloud ID 10 belongs to a different local record. Matching by its
      // numeric ID would corrupt the custom drug at #10; matching by identity
      // finds PANADOL at #20 and leaves its reference data unchanged.
      { id: 10, trade_name: 'PANADOL', price: 42, active_ingredient: 'PARACETAMOL', category: '', manufacturer: 'UPDATED LAB' },
      { id: 11, trade_name: 'NEW CATALOG DRUG', price: 55, active_ingredient: 'NEW ACTIVE', category: 'new category', manufacturer: 'NEW LAB' },
      { id: null, trade_name: 'INVALID ROW', price: 1 },
    ]);

    expect(result).toEqual({ synced: 2, skipped: 1 });
    expect(mockDb.prepare(`
      SELECT trade_name, trade_name_en, generic_name, active_ingredient, barcode,
             official_price, category, manufacturer, notes, large_to_medium, reorder_point
      FROM master_drugs WHERE id = 20
    `).get()).toEqual({
      trade_name: 'PANADOL',
      trade_name_en: 'Panadol Local',
      generic_name: 'paracetamol local',
      active_ingredient: 'OLD ACTIVE',
      barcode: '62220',
      official_price: 30,
      category: 'old category',
      manufacturer: 'OLD LAB',
      notes: 'local note',
      large_to_medium: 10,
      reorder_point: 5,
    });

    expect(mockDb.prepare('SELECT trade_name, barcode, notes FROM master_drugs WHERE id = 10').get()).toEqual({
      trade_name: 'MY CUSTOM DRUG', barcode: 'CUSTOM-10', notes: 'keep me',
    });
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM master_drugs WHERE trade_name = 'LOCAL ONLY'").get()).toEqual({ count: 1 });
    expect(mockDb.prepare("SELECT quantity FROM inventory WHERE id = 'lot-custom'").get()).toEqual({ quantity: 4 });

    expect(mockDb.prepare('SELECT local_drug_id FROM cloud_drug_mappings WHERE cloud_id = 10').get()).toEqual({ local_drug_id: 20 });
    const mapping = mockDb.prepare('SELECT local_drug_id FROM cloud_drug_mappings WHERE cloud_id = 11').get() as any;
    expect(mockDb.prepare('SELECT trade_name, barcode FROM master_drugs WHERE id = ?').get(mapping.local_drug_id)).toEqual({
      trade_name: 'NEW CATALOG DRUG', barcode: null,
    });

    await syncMasterDrugsToLocal([
      { id: 10, trade_name: 'PANADOL', price: 999, active_ingredient: 'WRONG ACTIVE', category: 'wrong category', manufacturer: 'WRONG LAB' },
      { id: 11, trade_name: 'NEW CATALOG DRUG', price: 60, active_ingredient: 'REWRITTEN', category: '', manufacturer: '' },
    ]);
    expect(mockDb.prepare('SELECT trade_name, official_price, active_ingredient FROM master_drugs WHERE id = ?').get(mapping.local_drug_id)).toEqual({
      trade_name: 'NEW CATALOG DRUG', official_price: 55, active_ingredient: 'NEW ACTIVE',
    });
    expect(mockDb.prepare('SELECT official_price, active_ingredient FROM master_drugs WHERE id = 20').get()).toEqual({
      official_price: 30, active_ingredient: 'OLD ACTIVE',
    });
    expect(mockDb.prepare("SELECT COUNT(*) AS count FROM master_drugs WHERE trade_name LIKE 'NEW CATALOG DRUG%'").get()).toEqual({ count: 1 });
  });
});
