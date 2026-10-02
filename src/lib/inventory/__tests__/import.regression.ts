import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

jest.mock('@/lib/db/tauri', () => ({
  dbSelect: jest.fn(),
  dbExecute: jest.fn(),
  dbTransaction: jest.fn(),
  generateId: jest.fn(() => 'generated-id'),
}));

import {
  importMasterDrugWorkbookRows,
  importInventoryWorkbookRows,
  type InventoryImportDatabase,
} from '@/lib/inventory/import';

function adapter(db: Database.Database): InventoryImportDatabase {
  let nextId = 0;
  return {
    // A Tauri transaction queues standalone calls behind itself. Imports must only
    // use the callback's scoped database once the transaction begins.
    select: async (sql, params = []) => {
      if (!/^\s*PRAGMA\s+table_info/i.test(sql)) throw new Error('standalone select inside import');
      return db.prepare(sql).all(...params as any[]);
    },
    execute: async () => { throw new Error('standalone execute inside import'); },
    transaction: async callback => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const prepare = (sql: string) => ({
          all: async (...params: any[]) => db.prepare(sql).all(...params),
          get: async (...params: any[]) => db.prepare(sql).get(...params) ?? null,
          run: async (...params: any[]) => {
            const result = db.prepare(sql).run(...params);
            return {
              changes: result.changes,
              lastInsertRowid: Number(result.lastInsertRowid),
              rowsAffected: result.changes,
              lastInsertId: Number(result.lastInsertRowid),
            };
          },
        });
        const result = await callback({
          select: async (sql, params = []) => {
            if (/^\s*PRAGMA\b/i.test(sql)) throw new Error('PRAGMA is not allowed inside a transaction');
            return db.prepare(sql).all(...params as any[]);
          },
          execute: async (sql, params = []) => db.prepare(sql).run(...params as any[]),
          prepare,
        });
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    generateId: () => `generated-${++nextId}`,
  };
}

function freshDatabase(db: Database.Database) {
  for (const file of readdirSync('src-tauri/migrations').filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join('src-tauri/migrations', file), 'utf8'));
  }
}

function upgradedV214Database(db: Database.Database) {
  // master_drugs/inventory were unchanged in v0.2.14; isolate that real slice,
  // then add the columns supplied by current startup compatibility.
  const initial = readFileSync('src-tauri/migrations/001_initial.sql', 'utf8');
  db.exec(initial.slice(
    initial.indexOf('CREATE TABLE IF NOT EXISTS master_drugs'),
    initial.indexOf('-- 5. Sales & Invoices'),
  ));
  const cols = (db.prepare('PRAGMA table_info(master_drugs)').all() as any[]).map(c => c.name);
  if (!cols.includes('base_price')) db.exec('ALTER TABLE master_drugs ADD COLUMN base_price REAL DEFAULT 0;');
  if (!cols.includes('indications')) db.exec('ALTER TABLE master_drugs ADD COLUMN indications TEXT;');
  if (!cols.includes('side_effects')) db.exec('ALTER TABLE master_drugs ADD COLUMN side_effects TEXT;');
  db.exec("INSERT INTO master_drugs (id, trade_name, barcode) VALUES (14598, 'Drug 14598', NULL);");
}

const variants = [
  ['fresh installation', freshDatabase],
  ['v0.2.14 database after update compatibility', upgradedV214Database],
] as const;

const fixtureDrugs = [
  { id: '14598', trade_name: 'MOXEN 7.5 MG 20 TABS.', large_to_medium: '6.223E+12' },
  { id: '6525', trade_name: 'ELONDA 0.5 MG 2 TABS.' },
  { id: '100013', trade_name: 'كونفينتين 100', trade_name_en: 'conventin 100 tab', barcode: '3' },
];

const fixtureInventory = [
  { id: 'lot-moxen', drug_id: '14598', pharmacy_id: 'placeholder-id', quantity: '1', strips_per_box: '6.223E+12' },
  { id: 'lot-elonda', drug_id: '6525', pharmacy_id: 'local_default', quantity: '1', strips_per_box: '6.22401E+12' },
  { id: 'lot-conventin', drug_id: '100013', pharmacy_id: 'local_default', quantity: '1', barcode: '3', strips_per_box: '6.225E+12' },
];

describe.each(variants)('%s inventory workbook import', (_name, initialize) => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initialize(db);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => db.close());

  it('preserves names, targets the active pharmacy, and recovers displaced barcodes safely', async () => {
    await importInventoryWorkbookRows(fixtureInventory, fixtureDrugs, 'active-pharmacy', adapter(db));

    expect(db.prepare(`SELECT COUNT(*) AS count FROM master_drugs WHERE trade_name GLOB 'Drug [0-9]*'`).get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT trade_name, barcode, large_to_medium FROM master_drugs WHERE id = 14598').get()).toEqual({
      trade_name: 'MOXEN 7.5 MG 20 TABS.',
      barcode: '6223000000000',
      large_to_medium: null,
    });
    expect(db.prepare('SELECT barcode, strips_per_box, pharmacy_id FROM inventory WHERE id = ?').get('lot-elonda')).toEqual({
      barcode: '6224010000000',
      strips_per_box: 1,
      pharmacy_id: 'active-pharmacy',
    });
    expect(db.prepare('SELECT barcode, strips_per_box, pharmacy_id FROM inventory WHERE id = ?').get('lot-conventin')).toEqual({
      barcode: '6225000000000',
      strips_per_box: 3,
      pharmacy_id: 'active-pharmacy',
    });
    expect(db.prepare('SELECT barcode FROM master_drugs WHERE id = 100013').get()).toEqual({ barcode: '6225000000000' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('uses the master pack factor when the inventory workbook leaves it blank', async () => {
    await importInventoryWorkbookRows(
      [{ id: 'lot-pack', drug_id: 9902, quantity: 1 }],
      [{ id: 9902, trade_name: 'PACKED DRUG', large_to_medium: 3 }],
      'active-pharmacy',
      adapter(db),
    );

    expect(db.prepare('SELECT strips_per_box FROM inventory WHERE id = ?').get('lot-pack')).toEqual({
      strips_per_box: 3,
    });
  });

  it('preserves another pharmacy lot when the workbook reuses its global inventory id', async () => {
    db.exec(`
      INSERT OR IGNORE INTO master_drugs (id, trade_name, large_to_medium) VALUES (9903, 'BRANCH SAFE DRUG', 2);
      INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, strips_per_box)
      VALUES ('shared-lot', 9903, 'other-pharmacy', 7, 2);
    `);

    await expect(importInventoryWorkbookRows(
      [{ id: 'shared-lot', drug_id: 9903, quantity: 2, strips_per_box: 2 }],
      [],
      'active-pharmacy',
      adapter(db),
    )).rejects.toThrow(/inventory id.*another pharmacy/i);

    expect(db.prepare('SELECT pharmacy_id, quantity, strips_per_box FROM inventory WHERE id = ?').get('shared-lot')).toEqual({
      pharmacy_id: 'other-pharmacy',
      quantity: 7,
      strips_per_box: 2,
    });
  });

  it('rejects negative imported stock without partially writing the workbook', async () => {
    db.exec(`INSERT OR IGNORE INTO master_drugs (id, trade_name) VALUES (9904, 'NEGATIVE IMPORT DRUG')`);

    await expect(importInventoryWorkbookRows(
      [
        { id: 'valid-before-negative', drug_id: 9904, quantity: 2 },
        { id: 'negative-lot', drug_id: 9904, quantity: -1 },
      ],
      [],
      'active-pharmacy',
      adapter(db),
    )).rejects.toThrow(/quantity/i);

    expect(db.prepare("SELECT COUNT(*) AS count FROM inventory WHERE id IN ('valid-before-negative', 'negative-lot')").get())
      .toEqual({ count: 0 });
  });

  it('uses the existing catalog conversion for an inventory-only workbook with no pack factor', async () => {
    db.exec(`
      INSERT OR REPLACE INTO master_drugs (id, trade_name, large_to_medium)
      VALUES (9905, 'EXISTING CONVERSION DRUG', 6)
    `);

    await importInventoryWorkbookRows(
      [{ id: 'inventory-only-pack', drug_id: 9905, quantity: 1 }],
      [],
      'active-pharmacy',
      adapter(db),
    );

    expect(db.prepare('SELECT strips_per_box FROM inventory WHERE id = ?').get('inventory-only-pack')).toEqual({
      strips_per_box: 6,
    });
  });
});

describe('inventory workbook drug identity preflight', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    freshDatabase(db);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => db.close());

  it('rejects a shifted display name at an existing canonical ID and rolls back every row', async () => {
    db.exec(`
      INSERT INTO master_drugs (id, trade_name, trade_name_en, active_ingredient)
      VALUES
        (417, 'AGIOLAX 12 GRANULES IN SACHETS', 'AGIOLAX 12 GRANULES IN SACHETS', 'ISPAGHULA HUSK'),
        (429, 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.', 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.', 'ESOMEPRAZOLE');
    `);

    const importPromise = importInventoryWorkbookRows(
      [
        { id: 'shifted-lot', drug_id: 417, quantity: 0, strips_per_box: 4 },
        { id: 'new-lot', drug_id: 9901, quantity: 2, strips_per_box: 1 },
      ],
      [
        {
          id: 417,
          trade_name: 'Drug 417',
          trade_name_en: 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.',
          active_ingredient: 'ISPAGHULA HUSK',
        },
        { id: 9901, trade_name: 'Legitimate new workbook drug' },
      ],
      'active-pharmacy',
      adapter(db),
    );

    await expect(importPromise).rejects.toThrow(/Drug identity conflict for source drug 417/);
    expect(db.prepare('SELECT trade_name, active_ingredient FROM master_drugs WHERE id = 417').get()).toEqual({
      trade_name: 'AGIOLAX 12 GRANULES IN SACHETS',
      active_ingredient: 'ISPAGHULA HUSK',
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id = 9901').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM inventory').get()).toEqual({ count: 0 });
  });

  it('rejects a same-ID name mismatch even when generic metadata overlaps', async () => {
    db.exec(`
      INSERT INTO master_drugs (
        id, trade_name, trade_name_en, active_ingredient, category, manufacturer
      ) VALUES
        (
          417, 'AGIOLAX 12 GRANULES IN SACHETS', 'AGIOLAX 12 GRANULES IN SACHETS',
          'ISPAGHULA HUSK + PLANTAGO SEED + SENNA', 'laxative', 'VIATRIS HEALTHCARE'
        ),
        (
          429, 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.', 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.',
          'ESOMEPRAZOLE', 'peptic ulcer.proton pump inhibitor', 'PLANET CURE'
        );
    `);

    await expect(importInventoryWorkbookRows(
      [
        { id: 'legacy-zero-lot', drug_id: 417, quantity: 0, strips_per_box: 4 },
        { id: 'canonical-aig-lot', drug_id: 429, quantity: 0.5, strips_per_box: 2 },
      ],
      [
        {
          id: 417,
          trade_name: 'Drug 417',
          trade_name_en: 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.',
          active_ingredient: 'ISPAGHULA HUSK + PLANTAGO SEED + SENNA',
          category: 'laxative',
          manufacturer: 'VIATRIS HEALTHCARE',
        },
        {
          id: 429,
          trade_name: 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.',
          trade_name_en: 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.',
          active_ingredient: 'ESOMEPRAZOLE',
          category: 'peptic ulcer.proton pump inhibitor',
          manufacturer: 'PLANET CURE',
        },
      ],
      'active-pharmacy',
      adapter(db),
    )).rejects.toThrow(/Drug identity conflict for source drug 417/i);

    expect(db.prepare(`
      SELECT id, trade_name, trade_name_en, active_ingredient, category, manufacturer
      FROM master_drugs WHERE id IN (417, 429) ORDER BY id
    `).all()).toEqual([
      {
        id: 417,
        trade_name: 'AGIOLAX 12 GRANULES IN SACHETS',
        trade_name_en: 'AGIOLAX 12 GRANULES IN SACHETS',
        active_ingredient: 'ISPAGHULA HUSK + PLANTAGO SEED + SENNA',
        category: 'laxative',
        manufacturer: 'VIATRIS HEALTHCARE',
      },
      {
        id: 429,
        trade_name: 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.',
        trade_name_en: 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.',
        active_ingredient: 'ESOMEPRAZOLE',
        category: 'peptic ulcer.proton pump inhibitor',
        manufacturer: 'PLANET CURE',
      },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM inventory').get()).toEqual({ count: 0 });
  });

  it('keeps legitimate new IDs and partial existing-ID rows without name-based balance merging', async () => {
    db.exec(`
      INSERT INTO master_drugs (id, trade_name, trade_name_en, active_ingredient)
      VALUES (429, 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.', 'AIG ESOMEPRAZOLE 40 MG 28 CAPS.', 'ESOMEPRAZOLE');
    `);

    await importInventoryWorkbookRows(
      [
        { id: 'new-duplicate-name-lot', drug_id: 9000, quantity: 0.5, strips_per_box: 2 },
        { id: 'partial-lot', drug_id: 429, quantity: 1, strips_per_box: 2 },
        { id: 'new-lot', drug_id: 9001, quantity: 3, strips_per_box: 1 },
      ],
      [
        {
          id: 9000,
          trade_name: '  aig   esomeprazole 40 mg 28 caps. ',
          active_ingredient: 'A DISTINCT NEW SOURCE ROW',
        },
        { id: 9001, trade_name: 'Legitimate new workbook drug' },
      ],
      'active-pharmacy',
      adapter(db),
    );

    expect(db.prepare('SELECT active_ingredient FROM master_drugs WHERE id = 9000').get()).toEqual({
      active_ingredient: 'A DISTINCT NEW SOURCE ROW',
    });
    expect(db.prepare('SELECT active_ingredient FROM master_drugs WHERE id = 429').get()).toEqual({
      active_ingredient: 'ESOMEPRAZOLE',
    });
    expect(db.prepare('SELECT trade_name FROM master_drugs WHERE id = 9001').get()).toEqual({
      trade_name: 'Legitimate new workbook drug',
    });
    expect(db.prepare('SELECT id, drug_id, pharmacy_id FROM inventory ORDER BY id').all()).toEqual([
      { id: 'new-duplicate-name-lot', drug_id: 9000, pharmacy_id: 'active-pharmacy' },
      { id: 'new-lot', drug_id: 9001, pharmacy_id: 'active-pharmacy' },
      { id: 'partial-lot', drug_id: 429, pharmacy_id: 'active-pharmacy' },
    ]);
  });

  it('imports stock without using the inventory workbook as a catalog updater for an existing drug', async () => {
    db.exec(`
      INSERT INTO master_drugs (
        id, trade_name, trade_name_en, active_ingredient, manufacturer,
        official_price, notes, large_unit, large_to_medium, reorder_point, stop_dealing
      ) VALUES (
        7000, 'LOCAL NAME', 'LOCAL ENGLISH', 'LOCAL INGREDIENT', 'LOCAL MAKER',
        45, 'LOCAL NOTE', 'LOCAL BOX', 6, 4, 1
      );
    `);

    await importInventoryWorkbookRows(
      [{ id: 'safe-stock-lot', drug_id: 7000, quantity: 3, strips_per_box: 6 }],
      [{
        id: 7000,
        trade_name: 'LOCAL NAME',
        trade_name_en: 'CATALOG ENGLISH',
        active_ingredient: 'CATALOG INGREDIENT',
        manufacturer: 'CATALOG MAKER',
        official_price: 99,
        notes: 'CATALOG NOTE',
        large_unit: 'CATALOG BOX',
        large_to_medium: 12,
        reorder_point: 99,
        stop_dealing: 0,
      }],
      'active-pharmacy',
      adapter(db),
    );

    expect(db.prepare(`
      SELECT trade_name, trade_name_en, active_ingredient, manufacturer,
             official_price, notes, large_unit, large_to_medium, reorder_point, stop_dealing
      FROM master_drugs WHERE id = 7000
    `).get()).toEqual({
      trade_name: 'LOCAL NAME',
      trade_name_en: 'LOCAL ENGLISH',
      active_ingredient: 'LOCAL INGREDIENT',
      manufacturer: 'LOCAL MAKER',
      official_price: 45,
      notes: 'LOCAL NOTE',
      large_unit: 'LOCAL BOX',
      large_to_medium: 6,
      reorder_point: 4,
      stop_dealing: 1,
    });
    expect(db.prepare(`
      SELECT drug_id, pharmacy_id, quantity, strips_per_box
      FROM inventory WHERE id = 'safe-stock-lot'
    `).get()).toEqual({
      drug_id: 7000,
      pharmacy_id: 'active-pharmacy',
      quantity: 3,
      strips_per_box: 6,
    });
  });

  it('rejects an imported inventory barcode that belongs to another drug before backfilling the master row', async () => {
    db.exec(`
      INSERT INTO master_drugs (id, trade_name, barcode)
      VALUES
        (7001, 'BARCODE TARGET', NULL),
        (7002, 'BARCODE OWNER', 'DUP-CODE');
    `);

    await expect(importInventoryWorkbookRows(
      [{ id: 'duplicate-barcode-lot', drug_id: 7001, quantity: 2, barcode: 'DUP-CODE' }],
      [{ id: 7001, trade_name: 'BARCODE TARGET' }],
      'active-pharmacy',
      adapter(db),
    )).rejects.toThrow(/barcode.*another drug/i);

    expect(db.prepare('SELECT barcode FROM master_drugs WHERE id = 7001').get()).toEqual({ barcode: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE id = ?').get('duplicate-barcode-lot')).toEqual({ count: 0 });
  });

  it('rejects reusing an existing same-pharmacy inventory id for a different drug', async () => {
    db.exec(`
      INSERT INTO master_drugs (id, trade_name) VALUES
        (7003, 'ORIGINAL LOT DRUG'),
        (7004, 'DIFFERENT IMPORT DRUG');
      INSERT INTO inventory (id, drug_id, pharmacy_id, quantity)
      VALUES ('stable-lot-id', 7003, 'active-pharmacy', 4);
      INSERT INTO sales_invoices (id, pharmacy_id, total_amount, payment_method, status)
      VALUES ('stable-sale', 'active-pharmacy', 10, 'cash', 'completed');
      INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price)
      VALUES ('stable-sale', 'stable-lot-id', 7003, 1, 10);
    `);

    await expect(importInventoryWorkbookRows(
      [{ id: 'stable-lot-id', drug_id: 7004, quantity: 7 }],
      [{ id: 7004, trade_name: 'DIFFERENT IMPORT DRUG' }],
      'active-pharmacy',
      adapter(db),
    )).rejects.toThrow(/inventory id.*another drug/i);

    expect(db.prepare('SELECT drug_id, quantity FROM inventory WHERE id = ?').get('stable-lot-id')).toEqual({
      drug_id: 7003,
      quantity: 4,
    });
    expect(db.prepare('SELECT inventory_id, drug_id FROM sales_items WHERE invoice_id = ?').get('stable-sale')).toEqual({
      inventory_id: 'stable-lot-id',
      drug_id: 7003,
    });
  });

  it('remaps an unnamed duplicate to the one named drug with the same barcode', async () => {
    await importInventoryWorkbookRows(
      [
        { id: 'legacy-lot', drug_id: 100001, quantity: 2, barcode: '6221025003843' },
        { id: 'named-lot', drug_id: 100099, quantity: 3, barcode: '6221025003843' },
      ],
      [
        { id: 100001, trade_name: 'Drug 100001', barcode: '6221025003843' },
        { id: 100099, trade_name: 'انتودين 40 اقراص', barcode: '6221025003843' },
      ],
      'active-pharmacy',
      adapter(db),
    );

    expect(db.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id = 100001').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT id, drug_id, quantity FROM inventory ORDER BY id').all()).toEqual([
      { id: 'legacy-lot', drug_id: 100099, quantity: 2 },
      { id: 'named-lot', drug_id: 100099, quantity: 3 },
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects an ambiguous placeholder/barcode row without partially writing valid rows', async () => {
    await expect(importInventoryWorkbookRows(
      [
        { id: 'placeholder-lot', drug_id: 100002, quantity: 1, barcode: '6221025003843' },
        { id: 'valid-lot', drug_id: 9002, quantity: 1, barcode: '6221025003843' },
        { id: 'other-valid-lot', drug_id: 9003, quantity: 1, barcode: '6221025003843' },
      ],
      [
        { id: 100002, trade_name: 'Drug 100002', barcode: '6221025003843' },
        { id: 9002, trade_name: 'Valid named row', barcode: '6221025003843' },
        { id: 9003, trade_name: 'Another named row', barcode: '6221025003843' },
      ],
      'active-pharmacy',
      adapter(db),
    )).rejects.toThrow(/Ambiguous barcode 6221025003843 for unnamed inventory drug 100002/);

    expect(db.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id = 100002').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id = 9002').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id = 9003').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM inventory').get()).toEqual({ count: 0 });
  });

  it('safely remaps shifted source IDs to the matching target drug without corrupting existing drugs', async () => {
    db.exec(`
      INSERT INTO master_drugs (id, trade_name, active_ingredient)
      VALUES
        (2190, 'BACTOBLIS 10 SACHETS', 'STREPTOCOCCUS SALIVARIUS'),
        (2228, 'BAMBEDIL 1MG/ML SYRUP 120ML', 'BAMBUTEROL');
    `);

    const result = await importInventoryWorkbookRows(
      [
        { id: 'bambedil-lot', drug_id: 2190, quantity: 5, strips_per_box: 1 },
      ],
      [
        {
          id: 2190,
          trade_name: 'BAMBEDIL 1MG/ML SYRUP 120ML',
          active_ingredient: 'BAMBUTEROL',
        },
      ],
      'active-pharmacy',
      adapter(db),
    );

    expect(result.inventoryCount).toBe(1);

    // BACTOBLIS at 2190 must remain completely untouched
    expect(db.prepare('SELECT trade_name, active_ingredient FROM master_drugs WHERE id = 2190').get()).toEqual({
      trade_name: 'BACTOBLIS 10 SACHETS',
      active_ingredient: 'STREPTOCOCCUS SALIVARIUS',
    });

    // BAMBEDIL at 2228 must remain completely untouched
    expect(db.prepare('SELECT trade_name, active_ingredient FROM master_drugs WHERE id = 2228').get()).toEqual({
      trade_name: 'BAMBEDIL 1MG/ML SYRUP 120ML',
      active_ingredient: 'BAMBUTEROL',
    });

    // Inventory row must be remapped to 2228 (BAMBEDIL), NEVER attached to 2190 (BACTOBLIS)
    expect(db.prepare('SELECT id, drug_id, quantity, pharmacy_id FROM inventory WHERE id = ?').get('bambedil-lot')).toEqual({
      id: 'bambedil-lot',
      drug_id: 2228,
      quantity: 5,
      pharmacy_id: 'active-pharmacy',
    });
  });

  it('resolves only the destination pharmacy shortage when imported stock clears its reorder threshold', async () => {
    db.exec(`
      INSERT INTO master_drugs (id, trade_name, reorder_point)
      VALUES (9906, 'IMPORTED RECOVERY DRUG', 5);
      INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, status)
      VALUES
        (9906, 'active-pharmacy', 6, 'pending'),
        (9906, 'other-pharmacy', 6, 'pending');
    `);

    await importInventoryWorkbookRows(
      [{ id: 'recovery-lot', drug_id: 9906, quantity: 6, expiry_date: '2099-12-31' }],
      [],
      'active-pharmacy',
      adapter(db),
    );

    expect(db.prepare('SELECT pharmacy_id, status FROM shortages WHERE drug_id = 9906 ORDER BY pharmacy_id').all()).toEqual([
      { pharmacy_id: 'active-pharmacy', status: 'received' },
      { pharmacy_id: 'other-pharmacy', status: 'pending' },
    ]);
  });

  it('runs inventory validation after source IDs are remapped', async () => {
    db.exec('ALTER TABLE inventory ADD COLUMN medium_to_small INTEGER;');
    db.exec(`
      INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small)
      VALUES
        (2190, 'SOURCE DRUG', 1, 1),
        (2228, 'TARGET DRUG', 1, 2);
    `);

    await expect(importInventoryWorkbookRows(
      [{ id: 'remapped-lot', drug_id: 2190, quantity: 1, strips_per_box: 1, medium_to_small: 1 }],
      [{ id: 2190, trade_name: 'TARGET DRUG', large_to_medium: 1, medium_to_small: 1 }],
      'active-pharmacy',
      adapter(db),
      async (rows, _masterRows, transaction) => {
        if (rows.length === 0) return;
        expect(rows).toEqual([expect.objectContaining({ drug_id: 2228, medium_to_small: 1 })]);
        const target = await transaction.select<any>(
          'SELECT large_to_medium, medium_to_small FROM master_drugs WHERE id = ?',
          [2228],
        );
        if (Number(rows[0].medium_to_small) !== Number(target[0].medium_to_small)) {
          throw new Error('غير مصرح بتعديل معاملات التحويل');
        }
      },
    )).rejects.toThrow('غير مصرح بتعديل معاملات التحويل');

    expect(db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE id = ?').get('remapped-lot')).toEqual({ count: 0 });
  });

  it('does not validate discarded existing-master conversion metadata that will not be written', async () => {
    db.exec(`
      INSERT INTO master_drugs (id, trade_name, large_to_medium, medium_to_small)
      VALUES (3001, 'EXISTING DRUG', 1, 1);
    `);

    await importInventoryWorkbookRows(
      [],
      [{ id: 3001, trade_name: 'EXISTING DRUG', large_to_medium: 2, medium_to_small: 1 }],
      'active-pharmacy',
      adapter(db),
      async (_rows, masterRows, transaction) => {
        expect(masterRows).toEqual([]);
        expect(await transaction.select<any>(
          'SELECT large_to_medium FROM master_drugs WHERE id = ?',
          [3001],
        )).toEqual([expect.objectContaining({ large_to_medium: 1 })]);
      },
    );

    expect(db.prepare('SELECT large_to_medium FROM master_drugs WHERE id = ?').get(3001)).toEqual({ large_to_medium: 1 });
  });
});

describe('master drug workbook import transaction', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    freshDatabase(db);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => db.close());

  it('rolls back earlier catalog rows when a later row is invalid', async () => {
    await expect(importMasterDrugWorkbookRows([
      { id: 8001, trade_name: 'VALID IMPORTED DRUG', official_price: 10 },
      { id: 8002, trade_name: null, official_price: 20 },
    ], adapter(db))).rejects.toThrow();

    expect(db.prepare('SELECT COUNT(*) AS count FROM master_drugs WHERE id IN (8001, 8002)').get())
      .toEqual({ count: 0 });
  });
});
