import Database from 'better-sqlite3';
import { createFunctionTransactionDb } from '@/tests/helpers/sqlite-transaction-db';

let db: Database.Database;
let failMasterUnitUpdate = false;
let session: any;
let allowedPermissions: Set<string>;

jest.mock('@/lib/db/tauri', () => ({
  generateId: jest.fn(() => 'new-lot'),
  dbSelect: jest.fn(async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params)),
  dbGet: jest.fn(async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) ?? null),
  dbExecute: jest.fn(async (sql: string, params: unknown[] = []) => {
    if (failMasterUnitUpdate && /UPDATE\s+master_drugs\s+SET\s+large_unit/i.test(sql)) {
      throw new Error('injected master metadata failure');
    }
    const result = db.prepare(sql).run(...params);
    return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }),
  dbTransaction: jest.fn(async (callback: any) => {
    db.exec('BEGIN');
    try {
      const transactionDb = createFunctionTransactionDb({
        select: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
        get: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) ?? null,
        execute: async (sql: string, params: unknown[] = []) => {
          if (failMasterUnitUpdate && /UPDATE\s+master_drugs\s+SET\s+large_unit/i.test(sql)) {
            throw new Error('injected master metadata failure');
          }
          const result = db.prepare(sql).run(...params);
          return { rowsAffected: result.changes, lastInsertId: Number(result.lastInsertRowid) };
        },
      });
      const result = await callback(transactionDb);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }),
}));

jest.mock('@/lib/auth/local', () => ({
  getLocalSession: jest.fn(async () => session),
  hasUserPermissionSync: jest.fn((_user: any, permission: string) => allowedPermissions.has(permission)),
}));

jest.mock('@/lib/cache/secure_cache', () => ({
  secureCache: {
    updateDrug: jest.fn(),
    load: jest.fn(async () => {}),
    reload: jest.fn(async () => {}),
  },
}));

jest.mock('@/lib/inventory/refresh', () => ({ notifyInventoryChanged: jest.fn() }));

jest.unmock('@/app/actions-client/inventory');

import { addInventoryAction } from '@/app/actions-client/inventory';

describe('addInventoryAction transaction atomicity', () => {
  beforeEach(() => {
    failMasterUnitUpdate = false;
    session = { id: 'inventory-user', role: 'pharmacist', pharmacy_id: 'ph-1' };
    allowedPermissions = new Set(['can_manage_inventory', 'can_modify_unit_conversion']);
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE master_drugs (
        id INTEGER PRIMARY KEY,
        trade_name TEXT,
        trade_name_en TEXT,
        active_ingredient TEXT,
        barcode TEXT,
        large_unit TEXT,
        large_to_medium INTEGER DEFAULT 1,
        medium_to_small INTEGER DEFAULT 1
      );
      CREATE TABLE inventory (
        id TEXT PRIMARY KEY,
        pharmacy_id TEXT,
        drug_id INTEGER,
        quantity REAL,
        local_selling_price REAL,
        expiry_date TEXT,
        barcode TEXT,
        strips_per_box INTEGER DEFAULT 1,
        medium_to_small INTEGER DEFAULT 1
      );
      CREATE TABLE activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        action TEXT,
        details TEXT
      );
      INSERT INTO master_drugs (id, trade_name, medium_to_small)
      VALUES (101, 'Atomic Test Drug', 1);
    `);
  });

  afterEach(() => db.close());

  it('rolls back the lot when a later master-drug metadata update fails', async () => {
    failMasterUnitUpdate = true;

    const result = await addInventoryAction({
      drug_id: 101,
      quantity: 5,
      local_selling_price: 12,
      expiry_date: '2028-12-31',
      unit: 'علبة',
      large_to_medium: 2,
      barcode: 'ATOMIC-101',
    });

    expect(result.success).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS n FROM inventory').get() as any).n).toBe(0);
    expect(db.prepare('SELECT large_unit, large_to_medium, barcode FROM master_drugs WHERE id = 101').get()).toEqual({
      large_unit: null,
      large_to_medium: 1,
      barcode: null,
    });
  });

  it('rejects a shared unit-conversion change without can_modify_unit_conversion', async () => {
    allowedPermissions.delete('can_modify_unit_conversion');

    const result = await addInventoryAction({
      drug_id: 101,
      quantity: 5,
      local_selling_price: 12,
      expiry_date: '2028-12-31',
      unit: 'علبة',
      large_to_medium: 4,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('معاملات التحويل');
    expect((db.prepare('SELECT COUNT(*) AS n FROM inventory').get() as any).n).toBe(0);
    expect((db.prepare('SELECT large_to_medium FROM master_drugs WHERE id = 101').get() as any).large_to_medium).toBe(1);
  });

  it('rejects a barcode already assigned to another drug without inserting a lot', async () => {
    db.prepare(`
      INSERT INTO master_drugs (id, trade_name, barcode, medium_to_small)
      VALUES (102, 'Barcode Owner', 'DUPLICATE-BC', 1)
    `).run();

    const result = await addInventoryAction({
      drug_id: 101,
      quantity: 5,
      local_selling_price: 12,
      expiry_date: '2028-12-31',
      barcode: 'DUPLICATE-BC',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Barcode');
    expect((db.prepare('SELECT COUNT(*) AS n FROM inventory WHERE drug_id = 101').get() as any).n).toBe(0);
    expect((db.prepare('SELECT barcode FROM master_drugs WHERE id = 101').get() as any).barcode).toBeNull();
  });

  it('rejects a barcode owned only by another drug inventory lot', async () => {
    db.prepare(`
      INSERT INTO master_drugs (id, trade_name, medium_to_small)
      VALUES (102, 'Lot Barcode Owner', 1)
    `).run();
    db.prepare(`
      INSERT INTO inventory (
        id, pharmacy_id, drug_id, quantity, local_selling_price,
        expiry_date, barcode, strips_per_box, medium_to_small
      ) VALUES ('owner-lot', 'ph-1', 102, 1, 10, '2029-12-31', 'LOT-ONLY-BC', 1, 1)
    `).run();

    const result = await addInventoryAction({
      drug_id: 101,
      quantity: 5,
      local_selling_price: 12,
      expiry_date: '2028-12-31',
      barcode: 'LOT-ONLY-BC',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Barcode');
    expect((db.prepare('SELECT COUNT(*) AS n FROM inventory WHERE drug_id = 101').get() as any).n).toBe(0);
  });
});
