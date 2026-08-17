import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import * as XLSX from 'xlsx';

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
});

const workbookPath = join(process.cwd(), 'inventory_export (6).xlsx');
(existsSync(workbookPath) ? it : it.skip)('imports the supplied inventory_export (6).xlsx without generated drug names', async () => {
  const workbook = XLSX.readFile(workbookPath);
  const inventory = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.inventory, { raw: true });
  const drugs = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.master_drugs, { raw: true });

  for (const initialize of variants.map(([, setup]) => setup)) {
    const db = new Database(':memory:');
    initialize(db);
    db.pragma('foreign_keys = ON');
    await importInventoryWorkbookRows(inventory, drugs, 'active-pharmacy', adapter(db));

    expect(db.prepare('SELECT COUNT(*) AS count FROM inventory').get()).toEqual({ count: 1458 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM master_drugs WHERE trade_name GLOB 'Drug [0-9]*'`).get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT trade_name, barcode, large_to_medium FROM master_drugs WHERE id = 14598').get()).toEqual({
      trade_name: 'MOXEN 7.5 MG 20 TABS.',
      barcode: '6223003930264',
      large_to_medium: null,
    });
    expect(db.prepare('SELECT barcode, strips_per_box FROM inventory WHERE id = ?').get('584e3f17-d7eb-4038-a0d8-c3c11f4c3070')).toEqual({
      barcode: '6223003930264',
      strips_per_box: 1,
    });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM inventory WHERE pharmacy_id != 'active-pharmacy'`).get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT barcode, strips_per_box FROM inventory WHERE id = ?').get('b01be38d-65b8-49ab-8b0a-2d588112b161')).toEqual({
      barcode: '6224010000000',
      strips_per_box: 1,
    });
    expect(db.prepare('SELECT barcode, strips_per_box FROM inventory WHERE id = ?').get('db52f47f-086a-4ed7-a931-03a7f64f2c2c')).toEqual({
      barcode: '6223000000000',
      strips_per_box: 3,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  }
}, 30_000);
