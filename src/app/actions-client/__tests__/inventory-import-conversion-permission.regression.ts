let allowedPermissions = new Set<string>();

import Database from 'better-sqlite3';

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(async () => ([
    { id: 101, large_to_medium: 1, medium_to_small: 1 },
  ])),
  dbGet: jest.fn(async () => null),
  dbExecute: jest.fn(async () => ({ rowsAffected: 0, lastInsertId: 0 })),
  dbTransaction: jest.fn(async (callback: any) => callback({})),
  generateId: jest.fn(() => 'generated-id'),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => ({ id: 'inventory-user', role: 'pharmacist', pharmacy_id: 'ph-1' })),
  hasUserPermissionSync: jest.fn((_user: any, permission: string) => allowedPermissions.has(permission)),
}));

jest.mock('@/lib/inventory/import', () => ({
  importInventoryWorkbookRows: jest.fn(async (inventoryRows, drugRows, _pharmacyId, _database, validate) => {
    const transaction = {
      prepare: () => ({ all: async () => [{ id: 101, large_to_medium: 1, medium_to_small: 1 }] }),
    };
    await validate?.([], drugRows, transaction);
    await validate?.(inventoryRows, [], transaction);
    return { inventoryCount: 1, masterDrugCount: 1 };
  }),
}));

jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: { updateDrug: jest.fn(), load: jest.fn(), reload: jest.fn() },
}));

jest.unmock('@/app/actions-client/inventory');

import { importInventoryWorkbookAction } from '@/app/actions-client/inventory';
import { importInventoryWorkbookRows } from '@/lib/inventory/import';

function importDatabase(db: Database.Database) {
  return {
    select: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params as any[]),
    execute: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params as any[]),
    transaction: async (callback: any) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await callback({
          select: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params as any[]),
          execute: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params as any[]),
          prepare: (sql: string) => ({
            all: async (...params: any[]) => db.prepare(sql).all(...params),
          }),
        });
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    generateId: () => 'generated-id',
  };
}

describe('inventory workbook conversion permission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    allowedPermissions = new Set(['can_manage_inventory']);
  });

  it('rejects a workbook that changes a shared conversion without can_modify_unit_conversion', async () => {
    const result = await importInventoryWorkbookAction(
      [{ id: 'lot-101', drug_id: 101, quantity: 2, strips_per_box: 4 }],
      [{ id: 101, trade_name: 'Conversion Drug', large_to_medium: 4, medium_to_small: 1 }],
    );

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('معاملات التحويل') });
    expect(importInventoryWorkbookRows).toHaveBeenCalledTimes(1);
  });

  it('allows an unchanged workbook conversion without the extra permission', async () => {
    const result = await importInventoryWorkbookAction(
      [{ id: 'lot-101', drug_id: 101, quantity: 2, strips_per_box: 1 }],
      [{ id: 101, trade_name: 'Conversion Drug', large_to_medium: 1, medium_to_small: 1 }],
    );

    expect(result).toMatchObject({ success: true });
    expect(importInventoryWorkbookRows).toHaveBeenCalledWith(
      expect.any(Array), expect.any(Array), 'ph-1', undefined, expect.any(Function),
    );
  });

  it('rejects a changed small-unit factor without can_modify_unit_conversion', async () => {
    const result = await importInventoryWorkbookAction(
      [{ id: 'lot-101', drug_id: 101, quantity: 2, strips_per_box: 1, medium_to_small: 2 }],
      [{ id: 101, trade_name: 'Conversion Drug', large_to_medium: 1, medium_to_small: 1 }],
    );

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('معاملات التحويل') });
    expect(importInventoryWorkbookRows).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed supplied small-unit factor without the extra permission', async () => {
    const result = await importInventoryWorkbookAction(
      [{ id: 'lot-101', drug_id: 101, quantity: 2, strips_per_box: 1, medium_to_small: 0 }],
      [{ id: 101, trade_name: 'Conversion Drug', large_to_medium: 1, medium_to_small: 1 }],
    );

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('معاملات التحويل') });
    expect(importInventoryWorkbookRows).toHaveBeenCalledTimes(1);
  });

  it('allows a changed small-unit factor with can_modify_unit_conversion', async () => {
    allowedPermissions.add('can_modify_unit_conversion');

    const result = await importInventoryWorkbookAction(
      [{ id: 'lot-101', drug_id: 101, quantity: 2, strips_per_box: 1, medium_to_small: 2 }],
      [{ id: 101, trade_name: 'Conversion Drug', large_to_medium: 1, medium_to_small: 2 }],
    );

    expect(result).toMatchObject({ success: true });
    expect(importInventoryWorkbookRows).toHaveBeenCalledTimes(1);
  });

  it('rolls back a remapped small-unit conversion through the real importer', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, active_ingredient TEXT,
        category TEXT, manufacturer TEXT, barcode TEXT, large_to_medium INTEGER, medium_to_small INTEGER
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity REAL,
        strips_per_box INTEGER, medium_to_small INTEGER, barcode TEXT
      );
      INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small)
      VALUES (101, 'SOURCE DRUG', 1, 1), (202, 'TARGET DRUG', 1, 2);
    `);
    const actualImporter = jest.requireActual<typeof import('@/lib/inventory/import')>('@/lib/inventory/import');
    (importInventoryWorkbookRows as jest.Mock).mockImplementationOnce(
      (inventoryRows, drugRows, pharmacyId, _database, validate) => actualImporter.importInventoryWorkbookRows(
        inventoryRows, drugRows, pharmacyId, importDatabase(db) as any, validate,
      ),
    );

    try {
      const result = await importInventoryWorkbookAction(
        [
          { id: 'valid-lot', drug_id: 303, quantity: 2, strips_per_box: 1, medium_to_small: 1 },
          { id: 'remapped-lot', drug_id: 101, quantity: 1, strips_per_box: 1, medium_to_small: 1, barcode: 'TARGET-CODE' },
        ],
        [
          { id: 303, trade_name: 'VALID NEW DRUG', large_to_medium: 1, medium_to_small: 1 },
          { id: 101, trade_name: 'TARGET DRUG', large_to_medium: 1, medium_to_small: 1 },
        ],
      );

      expect(result).toMatchObject({ success: false, error: expect.stringContaining('معاملات التحويل') });
      expect(db.prepare('SELECT COUNT(*) AS count FROM inventory').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT medium_to_small FROM master_drugs WHERE id = 202').get()).toEqual({ medium_to_small: 2 });
      expect(db.prepare('SELECT id FROM master_drugs WHERE id = 303').get()).toBeUndefined();
      expect(db.prepare('SELECT barcode FROM master_drugs WHERE id = 202').get()).toEqual({ barcode: null });
    } finally {
      db.close();
    }
  });

  it('allows compatible stock when stale existing-master conversion metadata is preserved instead of written', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY, trade_name TEXT, trade_name_en TEXT, active_ingredient TEXT,
        category TEXT, manufacturer TEXT, barcode TEXT, large_to_medium INTEGER, medium_to_small INTEGER
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY, drug_id INTEGER, pharmacy_id TEXT, quantity REAL,
        strips_per_box INTEGER, medium_to_small INTEGER, barcode TEXT
      );
      INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small)
      VALUES (101, 'Conversion Drug', 1, 1);
    `);
    const actualImporter = jest.requireActual<typeof import('@/lib/inventory/import')>('@/lib/inventory/import');
    (importInventoryWorkbookRows as jest.Mock).mockImplementationOnce(
      (inventoryRows, drugRows, pharmacyId, _database, validate) => actualImporter.importInventoryWorkbookRows(
        inventoryRows, drugRows, pharmacyId, importDatabase(db) as any, validate,
      ),
    );

    try {
      const result = await importInventoryWorkbookAction(
        [{ id: 'compatible-lot', drug_id: 101, quantity: 2, strips_per_box: 1 }],
        [{ id: 101, trade_name: 'Conversion Drug', large_to_medium: 4, medium_to_small: 1 }],
      );

      expect(result).toMatchObject({ success: true });
      expect(db.prepare('SELECT large_to_medium FROM master_drugs WHERE id = 101').get()).toEqual({ large_to_medium: 1 });
      expect(db.prepare('SELECT drug_id, quantity, strips_per_box FROM inventory WHERE id = ?').get('compatible-lot')).toEqual({
        drug_id: 101,
        quantity: 2,
        strips_per_box: 1,
      });
    } finally {
      db.close();
    }
  });
});
