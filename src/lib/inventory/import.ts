import { dbExecute, dbSelect, dbTransaction, generateId } from '@/lib/db/tauri';

type ExcelRow = Record<string, unknown>;

export interface InventoryImportDatabase {
  select<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  transaction<T>(callback: () => Promise<T>): Promise<T>;
  generateId(): string;
}

const defaultDatabase: InventoryImportDatabase = {
  select: dbSelect,
  execute: dbExecute,
  transaction: dbTransaction,
  generateId,
};

const text = (value: unknown) => value === null || value === undefined
  ? null
  : String(value).trim() || null;

const drugId = (value: unknown) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const conversion = (value: unknown) => {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount > 0 && amount <= 10_000 ? amount : null;
};

const shiftedBarcode = (value: unknown) => {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) return null;
  const barcode = String(amount);
  return barcode.length >= 12 && barcode.length <= 14 ? barcode : null;
};

const drugName = (row: ExcelRow, id: number) => {
  for (const value of [row.trade_name, row.trade_name_en]) {
    const name = text(value);
    if (name && name.toLowerCase() !== `drug ${id}`) return name;
  }
  return null;
};

async function columns(database: InventoryImportDatabase, table: 'master_drugs' | 'inventory') {
  return new Set((await database.select<{ name: string }>(`PRAGMA table_info(${table})`)).map(column => column.name));
}

async function upsertRows(
  database: InventoryImportDatabase,
  table: 'master_drugs' | 'inventory',
  rows: ExcelRow[],
  allowed: Set<string>,
) {
  for (const row of rows) {
    const names = [...allowed].filter(name => row[name] !== undefined);
    if (!names.includes('id')) continue;
    const updates = names.filter(name => name !== 'id').map(name => `${name}=excluded.${name}`);
    await database.execute(
      `INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')}) ON CONFLICT(id) ${updates.length ? `DO UPDATE SET ${updates.join(',')}` : 'DO NOTHING'}`,
      names.map(name => row[name]),
    );
  }
}

export async function importInventoryWorkbookRows(
  inventoryRows: ExcelRow[],
  masterDrugRows: ExcelRow[],
  destinationPharmacyId: string,
  database: InventoryImportDatabase = defaultDatabase,
) {
  const pharmacyId = text(destinationPharmacyId);
  if (!pharmacyId) throw new Error('A destination pharmacy is required');

  const sourceDrugs = new Map<number, ExcelRow>();
  for (const row of masterDrugRows) {
    const id = drugId(row.id);
    if (!id) continue;
    const name = drugName(row, id);
    if (!name) continue;
    const normalized: ExcelRow = { ...row, id, trade_name: name };
    const englishName = text(row.trade_name_en);
    if (!englishName || englishName.toLowerCase() === `drug ${id}`) delete normalized.trade_name_en;
    const displacedBarcode = shiftedBarcode(row.large_to_medium) || shiftedBarcode(row.medium_to_small);
    const barcode = displacedBarcode && (!text(row.barcode) || conversion(row.barcode))
      ? displacedBarcode
      : text(row.barcode);
    if (barcode) normalized.barcode = barcode;
    else delete normalized.barcode;
    for (const field of ['large_to_medium', 'medium_to_small']) {
      const amount = conversion(row[field]);
      if (amount) normalized[field] = amount;
      else delete normalized[field];
    }
    sourceDrugs.set(id, normalized);
  }

  const inventory: ExcelRow[] = [];
  const fallbackDrugs = new Map<number, ExcelRow>();
  for (const row of inventoryRows) {
    const id = drugId(row.drug_id);
    if (!id) continue;
    const normalized: ExcelRow = {
      ...row,
      id: text(row.id) || database.generateId(),
      drug_id: id,
      pharmacy_id: pharmacyId,
      strips_per_box: conversion(row.strips_per_box) || 1,
    };
    const displacedBarcode = shiftedBarcode(row.strips_per_box);
    const swappedConversion = conversion(row.barcode);
    const barcode = displacedBarcode && (!text(row.barcode) || swappedConversion)
      ? displacedBarcode
      : text(row.barcode) || text(sourceDrugs.get(id)?.barcode);
    if (displacedBarcode && swappedConversion) normalized.strips_per_box = swappedConversion;
    if (barcode) normalized.barcode = barcode;
    else delete normalized.barcode;
    if (displacedBarcode && sourceDrugs.has(id)) sourceDrugs.get(id)!.barcode = displacedBarcode;
    inventory.push(normalized);

    if (!sourceDrugs.has(id)) {
      const name = drugName(row, id);
      if (name) {
        const fallback: ExcelRow = { id, trade_name: name };
        const englishName = text(row.trade_name_en);
        if (englishName && englishName.toLowerCase() !== `drug ${id}`) fallback.trade_name_en = englishName;
        if (barcode) fallback.barcode = barcode;
        fallbackDrugs.set(id, fallback);
      }
    }
  }

  const masterColumns = await columns(database, 'master_drugs');
  const inventoryColumns = await columns(database, 'inventory');
  await database.transaction(async () => {
    await upsertRows(database, 'master_drugs', [...sourceDrugs.values(), ...fallbackDrugs.values()], masterColumns);

    const importedDrugIds = new Set([...sourceDrugs.keys(), ...fallbackDrugs.keys()]);
    for (const id of new Set(inventory.map(row => Number(row.drug_id)))) {
      if (importedDrugIds.has(id)) continue;
      const existing = await database.select<{ trade_name: string }>(
        'SELECT trade_name FROM master_drugs WHERE id = ?',
        [id],
      );
      if (!existing[0] || !drugName(existing[0] as ExcelRow, id)) {
        throw new Error(`Missing drug name for inventory drug ${id}`);
      }
    }

    for (const row of inventory) {
      if (row.barcode) {
        await database.execute(
          `UPDATE master_drugs SET barcode = COALESCE(NULLIF(barcode, ''), ?) WHERE id = ?`,
          [row.barcode, row.drug_id],
        );
      }
    }
    await upsertRows(database, 'inventory', inventory, inventoryColumns);
  });

  return { inventoryCount: inventory.length, masterDrugCount: sourceDrugs.size + fallbackDrugs.size };
}
