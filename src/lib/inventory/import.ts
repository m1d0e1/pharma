import { dbExecute, dbSelect, dbTransaction, generateId, type TransactionDb } from '@/lib/db/tauri';
import { assertBarcodeOwnershipAvailable } from '@/lib/inventory/barcode-ownership';
import { resolveRecoveredShortages } from '@/lib/inventory/reorder-state';

type ExcelRow = Record<string, unknown>;

export type InventoryImportTransaction = Pick<TransactionDb, 'select' | 'execute' | 'prepare'>;
export type InventoryImportValidator = (
  inventoryRows: ExcelRow[],
  masterDrugRows: ExcelRow[],
  database: InventoryImportTransaction,
) => Promise<void>;

export interface InventoryImportDatabase {
  select<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  transaction<T>(callback: (database: InventoryImportTransaction) => Promise<T>): Promise<T>;
  generateId(): string;
}

const defaultDatabase: InventoryImportDatabase = {
  select: dbSelect,
  execute: dbExecute,
  transaction: callback => dbTransaction(callback),
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

const drugName = (row: ExcelRow, id: number) => {
  for (const value of [row.trade_name, row.trade_name_en]) {
    const name = text(value);
    if (name && !isPlaceholderDrugName(name, id)) return name;
  }
  return null;
};

async function columns(database: Pick<InventoryImportDatabase, 'select'>, table: 'master_drugs' | 'inventory' | 'shortages') {
  return new Set((await database.select<{ name: string }>(`PRAGMA table_info(${table})`)).map(column => column.name));
}

async function upsertRows(
  database: Pick<InventoryImportDatabase, 'execute'>,
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
  validateInventoryRows?: InventoryImportValidator,
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
    const packFactor = conversion(row.strips_per_box) || conversion(sourceDrugs.get(id)?.large_to_medium);
    const normalized: ExcelRow = {
      ...row,
      id: text(row.id) || database.generateId(),
      drug_id: id,
      pharmacy_id: pharmacyId,
    };
    const quantityText = text(row.quantity);
    if (quantityText !== null) {
      const quantity = Number(row.quantity);
      if (!Number.isFinite(quantity) || quantity < 0) {
        throw new Error(`Invalid inventory quantity for drug ${id}`);
      }
      normalized.quantity = quantity;
    } else {
      delete normalized.quantity;
    }
    if (packFactor) normalized.strips_per_box = packFactor;
    else delete normalized.strips_per_box;
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

  // Tauri's transaction read guard accepts SELECT statements only; schema
  // introspection is read-only and must stay on the standalone connection.
  const masterColumns = await columns(database, 'master_drugs');
  const inventoryColumns = await columns(database, 'inventory');
  const shortageColumns = await columns(database, 'shortages');
  await database.transaction(async transaction => {
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
      const rows = await transaction.select<ExcelRow>(`
        SELECT id, trade_name, trade_name_en, active_ingredient, category, manufacturer
        FROM master_drugs
        WHERE id IN (${ids.map(() => '?').join(',')})
      `, ids);
      for (const row of rows) {
        const id = drugId(row.id);
        if (id) existingById.set(id, row);
      }
    }

    const idRemapping = new Map<number, number>();

    for (const [sourceId, row] of importedDrugs) {
      const incomingNames = identityNames(row, sourceId);
      const existingAtSource = existingById.get(sourceId);
      const existingNames = existingAtSource
        ? identityNames(existingAtSource, sourceId)
        : new Set<string>();
      const sameIdentity = [...incomingNames].some(name => existingNames.has(name));

      if (existingAtSource && existingNames.size > 0 && !sameIdentity) {
        // A numeric ID plus generic metadata is not enough to prove identity.
        // Resolve only through one unambiguous exact barcode/name match.
        const incomingName = drugName(row, sourceId);
        let targetMatch: ExcelRow | null = null;

        if (incomingName && !isPlaceholderDrugName(incomingName, sourceId)) {
          const barcode = text(row.barcode);
          if (barcode) {
            const byBarcode = await transaction.select<ExcelRow>(
              'SELECT id, trade_name, trade_name_en, active_ingredient FROM master_drugs WHERE TRIM(barcode) = ? COLLATE NOCASE LIMIT 2',
              [barcode],
            );
            if (byBarcode.length === 1) {
              targetMatch = byBarcode[0];
            } else if (byBarcode.length > 1) {
              targetMatch = null;
            }
          }

          if (!targetMatch) {
            const byName = await transaction.select<ExcelRow>(
              'SELECT id, trade_name, trade_name_en, active_ingredient FROM master_drugs WHERE LOWER(TRIM(trade_name)) = LOWER(TRIM(?)) OR LOWER(TRIM(trade_name_en)) = LOWER(TRIM(?)) LIMIT 2',
              [incomingName, incomingName],
            );
            if (byName.length === 1) {
              targetMatch = byName[0];
            }
          }
        }

        // Safety check: ensure active_ingredient does not contradict.
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

    for (const sourceId of new Set(inventory.map(row => Number(row.drug_id)))) {
      const existing = existingById.get(sourceId);
      if (importedDrugs.has(sourceId) || (existing && drugName(existing, sourceId)) || idRemapping.has(sourceId)) continue;
      const barcodes = [...new Set(inventory
        .filter(row => Number(row.drug_id) === sourceId)
        .map(row => text(row.barcode))
        .filter((barcode): barcode is string => Boolean(barcode)))];
      if (barcodes.length !== 1) continue;

      const matches = new Map<number, ExcelRow>();
      for (const [candidateId, candidate] of importedDrugs) {
        if (text(candidate.barcode) === barcodes[0]) matches.set(candidateId, candidate);
      }
      for (const candidate of await transaction.select<ExcelRow>(
        'SELECT id, trade_name, trade_name_en, active_ingredient FROM master_drugs WHERE barcode = ?',
        [barcodes[0]],
      )) {
        const candidateId = drugId(candidate.id);
        if (candidateId && drugName(candidate, candidateId)) matches.set(candidateId, candidate);
      }

      if (matches.size === 1) {
        const targetId = [...matches.keys()][0];
        idRemapping.set(sourceId, idRemapping.get(targetId) || targetId);
      } else if (matches.size > 1) {
        throw new Error(
          `Ambiguous barcode ${barcodes[0]} for unnamed inventory drug ${sourceId}; ` +
          `it matches drug IDs ${[...matches.keys()].join(', ')} and the import was rolled back`,
        );
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

    const masterRowsForValidation = [...importedDrugs.entries()]
      .filter(([sourceId]) => !idRemapping.has(sourceId))
      .map(([, row]) => row);
    // Inventory workbook import is allowed to create a missing master record so
    // its stock rows have a valid FK, but it must never act as an alternate
    // drug-directory updater for an already-existing drug. Existing users may
    // have intentionally edited catalog metadata, units, conversions, limits,
    // notes, or operational flags. Preserve the entire existing master row and
    // import only the inventory/lots. Catalog metadata changes go through the
    // dedicated review/backup/reconciliation workflow.
    const masterRowsToUpsert = masterRowsForValidation.filter(row => {
      const id = drugId(row.id);
      if (!id) return true;
      const existing = existingById.get(id);
      // A legacy placeholder such as "Drug 14598" is not a meaningful local
      // catalog choice; allow the workbook to repair that placeholder. Once an
      // existing row has a real name, inventory import must preserve it whole.
      return !(existing && drugName(existing, id));
    });
    // Validate only master rows that can actually be written. Existing real
    // master records are deliberately preserved, so stale workbook conversion
    // metadata for those rows must not block an otherwise compatible stock
    // import. Lot-level conversion validation still runs below.
    await validateInventoryRows?.([], masterRowsToUpsert, transaction);
    await assertBarcodeOwnershipAvailable(
      transaction,
      [
        ...masterRowsToUpsert.map(row => ({ barcode: row.barcode, drugId: row.id as number | string | null | undefined })),
        ...inventory.map(row => ({ barcode: row.barcode, drugId: row.drug_id as number | string | null | undefined })),
      ],
      { conflictMessage: 'Barcode is already assigned to another drug' },
    );
    await upsertRows(transaction, 'master_drugs', masterRowsToUpsert, masterColumns);

    const plannedMasterIds = new Set(masterRowsToUpsert.map(row => Number(row.id)));
    const missingIds = [...new Set(inventory.map(row => Number(row.drug_id)))].filter(id => {
      const existing = existingById.get(id);
      return !plannedMasterIds.has(id) && ![...idRemapping.values()].includes(id) &&
        (!existing || !drugName(existing, id));
    });
    if (missingIds.length > 0) {
      throw new Error(
        `Missing valid drug names for inventory drug IDs: ${missingIds.join(', ')}. ` +
        'Add a real trade_name or trade_name_en to the workbook; the import was rolled back',
      );
    }

    const finalDrugIds = [...new Set(inventory.map(row => Number(row.drug_id)))].filter(
      id => Number.isSafeInteger(id) && id > 0,
    );
    const conversionByDrug = new Map<number, number>();
    for (let offset = 0; offset < finalDrugIds.length; offset += 500) {
      const ids = finalDrugIds.slice(offset, offset + 500);
      const rows = await transaction.select<ExcelRow>(`
        SELECT id, large_to_medium
        FROM master_drugs
        WHERE id IN (${ids.map(() => '?').join(',')})
      `, ids);
      for (const row of rows) {
        const id = drugId(row.id);
        const factor = conversion(row.large_to_medium);
        if (id && factor) conversionByDrug.set(id, factor);
      }
    }
    for (const row of inventory) {
      if (!conversion(row.strips_per_box)) {
        row.strips_per_box = conversionByDrug.get(Number(row.drug_id)) || 1;
      }
    }

    const incomingInventoryIds = [...new Set(inventory.map(row => text(row.id)).filter((id): id is string => Boolean(id)))];
    const incomingDrugByInventoryId = new Map<string, number>();
    for (const row of inventory) {
      const inventoryId = text(row.id);
      const ownerDrugId = drugId(row.drug_id);
      if (!inventoryId || !ownerDrugId) continue;
      const previousDrugId = incomingDrugByInventoryId.get(inventoryId);
      if (previousDrugId !== undefined && previousDrugId !== ownerDrugId) {
        throw new Error(`Imported inventory id ${inventoryId} refers to more than one drug`);
      }
      incomingDrugByInventoryId.set(inventoryId, ownerDrugId);
    }
    for (let offset = 0; offset < incomingInventoryIds.length; offset += 500) {
      const ids = incomingInventoryIds.slice(offset, offset + 500);
      const rows = await transaction.select<ExcelRow>(`
        SELECT id, pharmacy_id, drug_id
        FROM inventory
        WHERE id IN (${ids.map(() => '?').join(',')})
      `, ids);
      for (const row of rows) {
        const inventoryId = text(row.id) || '';
        const ownerPharmacy = text(row.pharmacy_id) || 'local_default';
        if (ownerPharmacy !== pharmacyId) {
          throw new Error(`Imported inventory id ${text(row.id) || ''} belongs to another pharmacy`);
        }
        const currentDrugId = drugId(row.drug_id);
        const importedDrugId = incomingDrugByInventoryId.get(inventoryId);
        if (currentDrugId && importedDrugId && currentDrugId !== importedDrugId) {
          throw new Error(`Imported inventory id ${inventoryId} belongs to another drug`);
        }
      }
    }

    for (const row of inventory) {
      if (row.barcode) {
        await transaction.execute(
          `UPDATE master_drugs SET barcode = COALESCE(NULLIF(barcode, ''), ?) WHERE id = ?`,
          [row.barcode, row.drug_id],
        );
      }
    }
    await validateInventoryRows?.(inventory, [], transaction);
    await upsertRows(transaction, 'inventory', inventory, inventoryColumns);
    if (shortageColumns.has('drug_id') && shortageColumns.has('status')) {
      for (const id of finalDrugIds) {
        await resolveRecoveredShortages(transaction, id, pharmacyId);
      }
    }
  });

  return { inventoryCount: inventory.length, masterDrugCount: sourceDrugs.size + fallbackDrugs.size };
}

export async function importMasterDrugWorkbookRows(
  rows: ExcelRow[],
  database: InventoryImportDatabase = defaultDatabase,
) {
  let imported = 0;
  await database.transaction(async transaction => {
    for (const row of rows) {
      const id = drugId(row.id);
      const tradeName = text(row.trade_name) || text(row.trade_name_ar);
      if (!tradeName) {
        throw new Error('A trade name is required for every imported master drug');
      }
      const values = [
        tradeName,
        row.trade_name_en || null,
        row.generic_name || null,
        row.active_ingredient || null,
        row.barcode || null,
        Number(row.official_price) || 0,
        row.large_unit || null,
        row.medium_unit || null,
        row.small_unit || null,
        row.large_to_medium ? Number(row.large_to_medium) : null,
        row.medium_to_small ? Number(row.medium_to_small) : null,
        row.category || null,
        row.manufacturer || null,
        row.stop_dealing ? Number(row.stop_dealing) : 0,
      ];

      if (id) {
        await transaction.execute(`
          INSERT INTO master_drugs (
            id, trade_name, trade_name_en, generic_name, active_ingredient, barcode,
            official_price, large_unit, medium_unit, small_unit, large_to_medium,
            medium_to_small, category, manufacturer, stop_dealing
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            trade_name=excluded.trade_name,
            trade_name_en=excluded.trade_name_en,
            generic_name=excluded.generic_name,
            active_ingredient=excluded.active_ingredient,
            barcode=excluded.barcode,
            official_price=excluded.official_price,
            large_unit=excluded.large_unit,
            medium_unit=excluded.medium_unit,
            small_unit=excluded.small_unit,
            large_to_medium=excluded.large_to_medium,
            medium_to_small=excluded.medium_to_small,
            category=excluded.category,
            manufacturer=excluded.manufacturer,
            stop_dealing=excluded.stop_dealing
        `, [id, ...values]);
      } else {
        await transaction.execute(`
          INSERT INTO master_drugs (
            trade_name, trade_name_en, generic_name, active_ingredient, barcode,
            official_price, large_unit, medium_unit, small_unit, large_to_medium,
            medium_to_small, category, manufacturer, stop_dealing
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, values);
      }
      imported++;
    }
  });

  return { masterDrugCount: imported };
}
