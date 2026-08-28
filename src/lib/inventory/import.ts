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

const isPlaceholderDrugName = (value: string, id: number) =>
  new RegExp(`^drug\\s*#?\\s*${id}$`, 'i').test(value.trim());

const normalizedDrugName = (value: unknown) => {
  const name = text(value);
  return name
    ? name.normalize('NFKC').replace(/\s+/g, ' ').toUpperCase()
    : null;
};

const identityNames = (row: ExcelRow, id: number) => new Set(
  [row.trade_name, row.trade_name_en]
    .map(text)
    .filter((name): name is string => Boolean(name) && !isPlaceholderDrugName(name!, id))
    .map(normalizedDrugName)
    .filter((name): name is string => Boolean(name)),
);

const matchingIdentityMetadata = (incoming: ExcelRow, existing: ExcelRow) =>
  ['active_ingredient', 'category', 'manufacturer'].filter(field => {
    const incomingValue = normalizedDrugName(incoming[field]);
    const existingValue = normalizedDrugName(existing[field]);
    return Boolean(incomingValue && existingValue && incomingValue === existingValue);
  }).length;

const drugName = (row: ExcelRow, id: number) => {
  for (const value of [row.trade_name, row.trade_name_en]) {
    const name = text(value);
    if (name && !isPlaceholderDrugName(name, id)) return name;
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
      strips_per_box: conversion(row.strips_per_box) || conversion(sourceDrugs.get(id)?.large_to_medium) || 1,
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
    const importedDrugs = new Map<number, ExcelRow>([
      ...sourceDrugs.entries(),
      ...fallbackDrugs.entries(),
    ]);
    const relevantIds = [...new Set([
      ...importedDrugs.keys(),
      ...inventory.map(row => Number(row.drug_id)),
    ])].filter(id => Number.isSafeInteger(id) && id > 0);
    const existingById = new Map<number, ExcelRow>();
    for (let offset = 0; offset < relevantIds.length; offset += 500) {
      const ids = relevantIds.slice(offset, offset + 500);
      const rows = await database.select<ExcelRow>(`
        SELECT id, trade_name, trade_name_en, active_ingredient, category, manufacturer
        FROM master_drugs
        WHERE id IN (${ids.map(() => '?').join(',')})
      `, ids);
      for (const row of rows) {
        const id = drugId(row.id);
        if (id) existingById.set(id, row);
      }
    }

    const preserveExistingNames = new Set<number>();
    const idRemapping = new Map<number, number>();

    for (const [sourceId, row] of importedDrugs) {
      const incomingNames = identityNames(row, sourceId);
      const existingAtSource = existingById.get(sourceId);
      const existingNames = existingAtSource
        ? identityNames(existingAtSource, sourceId)
        : new Set<string>();
      const sameIdentity = [...incomingNames].some(name => existingNames.has(name));

      if (existingAtSource && existingNames.size > 0 && !sameIdentity) {
        // Case 1: Multiple stable metadata fields prove that the workbook row still belongs to this
        // numeric ID, keep the ID and discard only its shifted name fields.
        if (matchingIdentityMetadata(row, existingAtSource) >= 2) {
          preserveExistingNames.add(sourceId);
        } else {
          // Case 2: sourceId belongs to a different drug in this database.
          // Safely resolve the incoming drug's true ID in the target database by barcode or exact name.
          const incomingName = drugName(row, sourceId);
          let targetMatch: ExcelRow | null = null;

          if (incomingName && !isPlaceholderDrugName(incomingName, sourceId)) {
            const barcode = text(row.barcode);
            if (barcode) {
              const byBarcode = await database.select<ExcelRow>(
                'SELECT id, trade_name, trade_name_en, active_ingredient FROM master_drugs WHERE barcode = ? LIMIT 1',
                [barcode],
              );
              if (byBarcode.length > 0) {
                targetMatch = byBarcode[0];
              }
            }

            if (!targetMatch) {
              const byName = await database.select<ExcelRow>(
                'SELECT id, trade_name, trade_name_en, active_ingredient FROM master_drugs WHERE LOWER(TRIM(trade_name)) = LOWER(TRIM(?)) OR LOWER(TRIM(trade_name_en)) = LOWER(TRIM(?)) LIMIT 1',
                [incomingName, incomingName],
              );
              if (byName.length > 0) {
                targetMatch = byName[0];
              }
            }
          }

          // Safety check: ensure active_ingredient does not contradict
          if (targetMatch) {
            const incomingIng = normalizedDrugName(row.active_ingredient);
            const targetIng = normalizedDrugName(targetMatch.active_ingredient);
            if (incomingIng && targetIng && incomingIng !== targetIng) {
              targetMatch = null;
            }
          }

          if (targetMatch && drugId(targetMatch.id)) {
            const resolvedTargetId = drugId(targetMatch.id)!;
            idRemapping.set(sourceId, resolvedTargetId);
          } else {
            const existingName = drugName(existingAtSource, sourceId) || `drug ${sourceId}`;
            throw new Error(
              `Drug identity conflict for source drug ${sourceId}: ` +
              `workbook name "${incomingName || `drug ${sourceId}`}" does not match existing "${existingName}"; ` +
              'the import was rolled back',
            );
          }
        }
      }
    }

    // Apply ID remapping to inventory rows
    if (idRemapping.size > 0) {
      for (const item of inventory) {
        const remapped = idRemapping.get(Number(item.drug_id));
        if (remapped) {
          item.drug_id = remapped;
        }
      }
    }

    // Preserve the canonical names at a proven same-ID conflict while allowing
    // all other partial, remapped, and legitimate-new-ID imports to behave safely.
    const masterRowsToUpsert = [
      ...[...importedDrugs.entries()]
        .filter(([sourceId]) => !idRemapping.has(sourceId))
        .map(([sourceId, row]) => {
          if (!preserveExistingNames.has(sourceId)) return row;
          const existing = existingById.get(sourceId)!;
          return {
            ...row,
            trade_name: existing.trade_name,
            trade_name_en: existing.trade_name_en,
          };
        }),
    ];
    await upsertRows(database, 'master_drugs', masterRowsToUpsert, masterColumns);

    const plannedMasterIds = new Set(masterRowsToUpsert.map(row => Number(row.id)));
    for (const id of new Set(inventory.map(row => Number(row.drug_id)))) {
      if (plannedMasterIds.has(id) || existingById.has(id) || [...idRemapping.values()].includes(id)) continue;
      throw new Error(`Missing drug name for inventory drug ${id}`);
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
