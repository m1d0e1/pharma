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
  importInventoryWorkbookRows,
  type InventoryImportDatabase,
} from '@/lib/inventory/import';

function adapter(db: Database.Database): InventoryImportDatabase {
  let nextId = 0;
  return {
    select: async (sql, params = []) => db.prepare(sql).all(...params as any[]),
    execute: async (sql, params = []) => db.prepare(sql).run(...params as any[]),
    transaction: async callback => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await callback();
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
  { id: 'lot-conventin', drug_id: '100013', pharmacy_id: 'local_default', quantity: '1', barcode: '3', strips_per_box: '6.223E+12' },
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
      barcode: '6223000000000',
      strips_per_box: 3,
      pharmacy_id: 'active-pharmacy',
    });
    expect(db.prepare('SELECT barcode FROM master_drugs WHERE id = 100013').get()).toEqual({ barcode: '6223000000000' });
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

  it('keeps a same-ID canonical drug when multiple non-name fields prove the shifted workbook row identity', async () => {
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

    await importInventoryWorkbookRows(
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
    );

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
    expect(db.prepare('SELECT id, drug_id, quantity, strips_per_box FROM inventory ORDER BY id').all()).toEqual([
      { id: 'canonical-aig-lot', drug_id: 429, quantity: 0.5, strips_per_box: 2 },
      { id: 'legacy-zero-lot', drug_id: 417, quantity: 0, strips_per_box: 4 },
    ]);
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
});
