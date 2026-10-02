import { dbSelect, dbTransaction, generateId, type TransactionDb } from '@/lib/db/tauri';
import { assertBarcodeOwnershipAvailable } from '@/lib/inventory/barcode-ownership';

type CatalogRow = Record<string, unknown>;

const DRUGEYE_SOURCE_COLUMNS = ['Trade Name', 'Price', 'Active Ingredient', 'Category', 'Manufacturer'] as const;

export const CATALOG_MUTABLE_FIELDS = [
  'trade_name',
  'trade_name_en',
  'generic_name',
  'active_ingredient',
  'barcode',
  'official_price',
  'category',
  'manufacturer',
  'is_medicine',
  'is_service',
  'is_refrigerated',
  'is_chronic',
  'has_expiry',
  'no_return',
  'origin',
  'code_2',
  'item_nature',
  'scientific_group',
  'usage_method',
  'active_ingredient_ratio',
  'is_table',
  'indications',
  'side_effects',
] as const;

export const CATALOG_PROTECTED_LOCAL_FIELDS = [
  'notes',
  'large_unit',
  'medium_unit',
  'small_unit',
  'large_to_medium',
  'medium_to_small',
  'min_limit',
  'max_limit',
  'reorder_point',
  'default_purchase_qty',
  'prevent_fractions',
  'tax_percent',
  'discount_percent',
  'stop_dealing',
] as const;

export type CatalogMutableField = typeof CATALOG_MUTABLE_FIELDS[number];
export type CatalogProtectedField = typeof CATALOG_PROTECTED_LOCAL_FIELDS[number];
export type CatalogPolicy = 'local' | 'catalog' | 'ask';
export type CatalogFieldDecisionAction = 'keep_local' | 'use_catalog';
export type CatalogNewDrugDecisionAction = 'keep_absent' | 'add';

const numericFields = new Set<string>([
  'official_price',
  'is_medicine',
  'is_service',
  'is_refrigerated',
  'is_chronic',
  'has_expiry',
  'no_return',
  'is_table',
  'large_to_medium',
  'medium_to_small',
  'min_limit',
  'max_limit',
  'reorder_point',
  'default_purchase_qty',
  'prevent_fractions',
  'tax_percent',
  'discount_percent',
  'stop_dealing',
]);

const booleanIntegerFields = new Set<string>([
  'is_medicine',
  'is_service',
  'is_refrigerated',
  'is_chronic',
  'has_expiry',
  'no_return',
  'is_table',
  'prevent_fractions',
  'stop_dealing',
]);

export const catalogFieldLabels: Record<CatalogMutableField | CatalogProtectedField, string> = {
  trade_name: 'الاسم التجاري',
  trade_name_en: 'الاسم التجاري بالإنجليزية',
  generic_name: 'الاسم العلمي/العام',
  active_ingredient: 'المادة الفعالة',
  barcode: 'الباركود',
  official_price: 'السعر الرسمي',
  category: 'الفئة',
  manufacturer: 'الشركة المصنعة',
  is_medicine: 'دواء',
  is_service: 'خدمة',
  is_refrigerated: 'يحتاج تبريد',
  is_chronic: 'دواء مزمن',
  has_expiry: 'له تاريخ صلاحية',
  no_return: 'غير قابل للمرتجع',
  origin: 'المنشأ',
  code_2: 'الكود الإضافي',
  item_nature: 'طبيعة الصنف',
  scientific_group: 'المجموعة العلمية',
  usage_method: 'طريقة الاستخدام',
  active_ingredient_ratio: 'تركيز المادة الفعالة',
  is_table: 'جدولي',
  indications: 'دواعي الاستعمال',
  side_effects: 'الآثار الجانبية',
  notes: 'ملاحظات محلية',
  large_unit: 'الوحدة الكبيرة',
  medium_unit: 'الوحدة المتوسطة',
  small_unit: 'الوحدة الصغيرة',
  large_to_medium: 'تحويل الكبير إلى المتوسط',
  medium_to_small: 'تحويل المتوسط إلى الصغير',
  min_limit: 'الحد الأدنى',
  max_limit: 'الحد الأقصى',
  reorder_point: 'حد إعادة الطلب',
  default_purchase_qty: 'كمية الشراء الافتراضية',
  prevent_fractions: 'منع الكسور',
  tax_percent: 'الضريبة المحلية',
  discount_percent: 'الخصم المحلي',
  stop_dealing: 'إيقاف التعامل',
};

export interface CatalogFieldChange {
  field: CatalogMutableField;
  label: string;
  currentValue: unknown;
  incomingValue: unknown;
  policy: CatalogPolicy | null;
  defaultDecision: CatalogFieldDecisionAction;
  blockedReason?: string;
}

export interface CatalogProtectedChange {
  field: CatalogProtectedField;
  label: string;
  currentValue: unknown;
  incomingValue: unknown;
}

export interface CatalogChangedDrugPreview {
  catalogDrugId: number;
  masterDrugId: number;
  name: string;
  matchMethod: 'catalog_link' | 'same_id_name' | 'same_id_barcode';
  changes: CatalogFieldChange[];
  protectedChanges: CatalogProtectedChange[];
}

export interface CatalogNewDrugPreview {
  catalogDrugId: number;
  name: string;
  suppressed: boolean;
  incoming: Record<string, unknown>;
  protectedIncomingFields: CatalogProtectedField[];
}

export interface CatalogIdentityConflictPreview {
  catalogDrugId: number;
  masterDrugId: number;
  currentName: string;
  incomingName: string;
  reason: string;
}

export interface CatalogCurrentOnlyPreview {
  masterDrugId: number;
  name: string;
}

export interface MasterDrugCatalogUpdatePreview {
  signature: string;
  summary: {
    incomingCount: number;
    changedDrugCount: number;
    changedFieldCount: number;
    protectedFieldCount: number;
    newDrugCount: number;
    suppressedDrugCount: number;
    identityConflictCount: number;
    currentOnlyCount: number;
    unchangedCount: number;
    inventoryRowsAffected: 0;
    historyRowsAffected: 0;
  };
  changedDrugs: CatalogChangedDrugPreview[];
  newDrugs: CatalogNewDrugPreview[];
  identityConflicts: CatalogIdentityConflictPreview[];
  matchedLinks: Array<{ catalogDrugId: number; masterDrugId: number }>;
  currentOnlySample: CatalogCurrentOnlyPreview[];
}

export interface CatalogFieldDecision {
  catalogDrugId: number;
  masterDrugId: number;
  field: CatalogMutableField;
  action: CatalogFieldDecisionAction;
  expectedCurrentValue: unknown;
  expectedIncomingValue: unknown;
}

export interface CatalogNewDrugDecision {
  catalogDrugId: number;
  action: CatalogNewDrugDecisionAction;
}

export interface ApplyMasterDrugCatalogUpdateRequest {
  rows: CatalogRow[];
  previewSignature: string;
  fieldDecisions: CatalogFieldDecision[];
  newDrugDecisions: CatalogNewDrugDecision[];
  identityConflictDecisions: Array<{ catalogDrugId: number; action: 'keep_local' }>;
  userId: string;
  backupPath: string;
  sourceName?: string;
}

type ReadDb = Pick<TransactionDb, 'select'>;
type WriteDb = Pick<TransactionDb, 'select' | 'execute'>;

export interface CatalogUpdateDatabase {
  select<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(callback: (db: WriteDb) => Promise<T>): Promise<T>;
}

const defaultDatabase: CatalogUpdateDatabase = {
  select: dbSelect,
  transaction: callback => dbTransaction(callback),
};

const own = (row: CatalogRow, field: string) => Object.prototype.hasOwnProperty.call(row, field);

const cleanText = (value: unknown) => value === null || value === undefined
  ? null
  : String(value).trim() || null;

const normalizeName = (value: unknown) => cleanText(value)?.normalize('NFKC').replace(/\s+/g, ' ').toUpperCase() || null;

const normalizeValue = (field: string, value: unknown) => {
  if (value === undefined) return undefined;
  if (numericFields.has(field)) {
    if (value === null || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Invalid numeric value for ${field}`);
    if (field === 'official_price' && number < 0) {
      throw new Error('Invalid selling price');
    }
    if (booleanIntegerFields.has(field)) return number ? 1 : 0;
    return number;
  }
  return cleanText(value);
};

const valueKey = (value: unknown) => value === null || value === undefined ? null : value;
const valuesEqual = (a: unknown, b: unknown) => Object.is(valueKey(a), valueKey(b));

function normalizeIncomingRows(rows: CatalogRow[]) {
  const seen = new Set<number>();
  return rows.map((raw, index) => {
    const id = Number(raw.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid drug id at workbook row ${index + 2}`);
    }
    if (seen.has(id)) throw new Error(`Duplicate drug id ${id} in the workbook`);
    seen.add(id);

    const row: CatalogRow = { id };
    if (own(raw, '__catalog_ambiguous_reason')) {
      row.__catalog_ambiguous_reason = raw.__catalog_ambiguous_reason;
    }
    // master_drugs.trade_name is NOT NULL. Treat an explicitly blank catalog
    // value as "not supplied" rather than offering a destructive NULL update.
    // Prefer the Arabic alias when the primary column is blank.
    const tradeNameSource = cleanText(raw.trade_name) ?? cleanText(raw.trade_name_ar);
    if (tradeNameSource) row.trade_name = normalizeValue('trade_name', tradeNameSource);

    for (const field of [...CATALOG_MUTABLE_FIELDS, ...CATALOG_PROTECTED_LOCAL_FIELDS]) {
      if (field === 'trade_name' || !own(raw, field)) continue;
      row[field] = normalizeValue(field, raw[field]);
    }
    return row;
  });
}

function isDrugEyeRow(row: CatalogRow) {
  return DRUGEYE_SOURCE_COLUMNS.some(column => own(row, column));
}

function normalizeDrugEyeSourceRow(raw: CatalogRow) {
  return {
    trade_name: cleanText(raw['Trade Name']),
    official_price: normalizeValue('official_price', raw.Price),
    active_ingredient: cleanText(raw['Active Ingredient']),
    category: cleanText(raw.Category),
    manufacturer: cleanText(raw.Manufacturer),
  } satisfies CatalogRow;
}

async function assignStableIdsToDrugEyeRows(rows: CatalogRow[], database: ReadDb | Pick<CatalogUpdateDatabase, 'select'>) {
  const currentRows = await database.select<CatalogRow>('SELECT id, trade_name, trade_name_en FROM master_drugs');
  const currentByName = new Map<string, CatalogRow[]>();
  let maxId = 0;
  for (const current of currentRows) {
    const id = Number(current.id);
    if (Number.isSafeInteger(id)) maxId = Math.max(maxId, id);
    for (const candidate of [current.trade_name, current.trade_name_en]) {
      const normalized = normalizeName(candidate);
      if (!normalized) continue;
      const bucket = currentByName.get(normalized) || [];
      if (!bucket.some(item => Number(item.id) === id)) bucket.push(current);
      currentByName.set(normalized, bucket);
    }
  }

  const normalizedRows = rows.map(normalizeDrugEyeSourceRow);
  const sourceNameCounts = new Map<string, number>();
  for (const row of normalizedRows) {
    const name = normalizeName(row.trade_name);
    if (!name) continue;
    sourceNameCounts.set(name, (sourceNameCounts.get(name) || 0) + 1);
  }

  let nextId = maxId + 1;
  return normalizedRows.map((row, index) => {
    const name = normalizeName(row.trade_name);
    if (!name) throw new Error(`DrugEye row ${index + 2} has no trade name`);
    const sourceDuplicate = (sourceNameCounts.get(name) || 0) > 1;
    const matches = currentByName.get(name) || [];
    const ambiguous = sourceDuplicate || matches.length > 1;
    return {
      id: !ambiguous && matches.length === 1 ? Number(matches[0].id) : nextId++,
      ...row,
      ...(ambiguous ? { __catalog_ambiguous_reason: sourceDuplicate
        ? 'اسم الدواء مكرر داخل ملف DrugEye'
        : 'اسم الدواء يطابق أكثر من سجل محلي ولا يمكن اختيار الهوية بأمان' } : {}),
    };
  });
}

async function prepareIncomingRows(rows: CatalogRow[], database: ReadDb | Pick<CatalogUpdateDatabase, 'select'>) {
  if (rows.length > 0 && rows.every(isDrugEyeRow)) {
    return assignStableIdsToDrugEyeRows(rows, database);
  }
  return rows;
}

function displayName(row: CatalogRow | undefined, id: number) {
  return cleanText(row?.trade_name) || cleanText(row?.trade_name_en) || `Drug #${id}`;
}

function identityMethod(current: CatalogRow, incoming: CatalogRow): CatalogChangedDrugPreview['matchMethod'] | null {
  const currentNames = new Set([normalizeName(current.trade_name), normalizeName(current.trade_name_en)].filter(Boolean));
  const incomingNames = [normalizeName(incoming.trade_name), normalizeName(incoming.trade_name_en)].filter(Boolean) as string[];
  if (incomingNames.some(name => currentNames.has(name))) return 'same_id_name';

  const currentBarcode = cleanText(current.barcode);
  const incomingBarcode = cleanText(incoming.barcode);
  if (currentBarcode && incomingBarcode && currentBarcode.toUpperCase() === incomingBarcode.toUpperCase()) {
    return 'same_id_barcode';
  }

  // Same numeric IDs are not enough to prove catalog identity. Generic
  // metadata such as ingredient/manufacturer/category is commonly shared by
  // multiple products, so even several matching metadata fields can still
  // describe a different drug. Require an exact normalized name or barcode;
  // otherwise surface an identity conflict for manual review.
  return null;
}

function stableSignature(value: unknown) {
  const input = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `catalog-preview-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

async function buildPreview(rows: CatalogRow[], database: ReadDb | Pick<CatalogUpdateDatabase, 'select'>): Promise<MasterDrugCatalogUpdatePreview> {
  const preparedRows = await prepareIncomingRows(rows, database);
  const incomingRows = normalizeIncomingRows(preparedRows);
  const currentRows = await database.select<CatalogRow>(`
    SELECT id, ${[...CATALOG_MUTABLE_FIELDS, ...CATALOG_PROTECTED_LOCAL_FIELDS].join(', ')}
    FROM master_drugs
  `);
  const links = await database.select<{ catalog_drug_id: number; master_drug_id: number }>(
    'SELECT catalog_drug_id, master_drug_id FROM drug_catalog_links'
  );
  const suppressions = await database.select<{ catalog_drug_id: number }>(
    'SELECT catalog_drug_id FROM drug_catalog_suppressions'
  );
  const policies = await database.select<{ master_drug_id: number; field_name: string; policy: CatalogPolicy }>(
    'SELECT master_drug_id, field_name, policy FROM drug_catalog_field_policies'
  );
  const positiveStockWithoutExpiry = new Set((await database.select<{ drug_id: number }>(
    "SELECT DISTINCT drug_id FROM inventory WHERE COALESCE(quantity, 0) > 0 AND (expiry_date IS NULL OR TRIM(expiry_date) = '')"
  )).map(row => Number(row.drug_id)));

  const currentById = new Map(currentRows.map(row => [Number(row.id), row]));
  const linkByCatalog = new Map(links.map(row => [Number(row.catalog_drug_id), Number(row.master_drug_id)]));
  const suppressed = new Set(suppressions.map(row => Number(row.catalog_drug_id)));
  const policyByField = new Map(policies.map(row => [`${row.master_drug_id}:${row.field_name}`, row.policy]));
  const incomingCatalogIds = new Set<number>();
  const matchedMasterIds = new Set<number>();

  const changedDrugs: CatalogChangedDrugPreview[] = [];
  const newDrugs: CatalogNewDrugPreview[] = [];
  const identityConflicts: CatalogIdentityConflictPreview[] = [];
  const matchedLinks: Array<{ catalogDrugId: number; masterDrugId: number }> = [];
  let unchangedCount = 0;

  for (const incoming of incomingRows) {
    const catalogDrugId = Number(incoming.id);
    incomingCatalogIds.add(catalogDrugId);
    const linkedMasterId = linkByCatalog.get(catalogDrugId);
    const linkedCurrent = linkedMasterId ? currentById.get(linkedMasterId) : undefined;
    const sameIdCurrent = currentById.get(catalogDrugId);

    if (own(incoming, '__catalog_ambiguous_reason')) {
      identityConflicts.push({
        catalogDrugId,
        masterDrugId: 0,
        currentName: 'عدة سجلات/هوية غير محسومة',
        incomingName: displayName(incoming, catalogDrugId),
        reason: String(incoming.__catalog_ambiguous_reason),
      });
      continue;
    }

    let current: CatalogRow | undefined;
    let masterDrugId: number | undefined;
    let matchMethod: CatalogChangedDrugPreview['matchMethod'] | null = null;
    if (linkedCurrent) {
      current = linkedCurrent;
      masterDrugId = linkedMasterId;
      matchMethod = 'catalog_link';
    } else if (sameIdCurrent) {
      const method = identityMethod(sameIdCurrent, incoming);
      if (!method) {
        identityConflicts.push({
          catalogDrugId,
          masterDrugId: catalogDrugId,
          currentName: displayName(sameIdCurrent, catalogDrugId),
          incomingName: displayName(incoming, catalogDrugId),
          reason: 'نفس الرقم موجود محلياً لكن هوية الدواء لا تتطابق بشكل آمن',
        });
        matchedMasterIds.add(catalogDrugId);
        continue;
      }
      current = sameIdCurrent;
      masterDrugId = catalogDrugId;
      matchMethod = method;
    }

    if (!current || !masterDrugId || !matchMethod) {
      const protectedIncomingFields = CATALOG_PROTECTED_LOCAL_FIELDS.filter(field => own(incoming, field));
      const incomingCatalogFields: Record<string, unknown> = {};
      for (const field of [...CATALOG_MUTABLE_FIELDS, ...CATALOG_PROTECTED_LOCAL_FIELDS]) {
        if (own(incoming, field)) incomingCatalogFields[field] = incoming[field];
      }
      newDrugs.push({
        catalogDrugId,
        name: displayName(incoming, catalogDrugId),
        suppressed: suppressed.has(catalogDrugId),
        incoming: incomingCatalogFields,
        protectedIncomingFields,
      });
      continue;
    }

    matchedMasterIds.add(masterDrugId);
    matchedLinks.push({ catalogDrugId, masterDrugId });
    const changes: CatalogFieldChange[] = [];
    const protectedChanges: CatalogProtectedChange[] = [];
    for (const field of CATALOG_MUTABLE_FIELDS) {
      if (!own(incoming, field)) continue;
      const incomingValue = normalizeValue(field, incoming[field]);
      const currentValue = normalizeValue(field, current[field]);
      if (valuesEqual(currentValue, incomingValue)) continue;
      const policy = policyByField.get(`${masterDrugId}:${field}`) || null;
      const blockedReason = field === 'has_expiry'
        && Number(currentValue) === 0
        && Number(incomingValue) === 1
        && positiveStockWithoutExpiry.has(masterDrugId)
        ? 'يوجد مخزون موجب لهذا الصنف بدون تاريخ صلاحية. أضف تواريخ الصلاحية للمخزون أولاً قبل تفعيل هذا الحقل من الدليل.'
        : undefined;
      changes.push({
        field,
        label: catalogFieldLabels[field],
        currentValue,
        incomingValue,
        policy,
        // Even when a prior review chose the catalog value, each new catalog
        // release starts conservatively. The remembered policy is displayed to
        // the reviewer as context, but never silently pre-approves a new value.
        defaultDecision: 'keep_local',
        blockedReason,
      });
    }
    for (const field of CATALOG_PROTECTED_LOCAL_FIELDS) {
      if (!own(incoming, field)) continue;
      const incomingValue = normalizeValue(field, incoming[field]);
      const currentValue = normalizeValue(field, current[field]);
      if (valuesEqual(currentValue, incomingValue)) continue;
      protectedChanges.push({ field, label: catalogFieldLabels[field], currentValue, incomingValue });
    }

    if (changes.length || protectedChanges.length) {
      changedDrugs.push({
        catalogDrugId,
        masterDrugId,
        name: displayName(current, masterDrugId),
        matchMethod,
        changes,
        protectedChanges,
      });
    } else {
      unchangedCount++;
    }
  }

  const currentOnly = currentRows
    .filter(row => !matchedMasterIds.has(Number(row.id)) && !incomingCatalogIds.has(Number(row.id)))
    .map(row => ({ masterDrugId: Number(row.id), name: displayName(row, Number(row.id)) }));

  const summary = {
    incomingCount: incomingRows.length,
    changedDrugCount: changedDrugs.length,
    changedFieldCount: changedDrugs.reduce((sum, drug) => sum + drug.changes.length, 0),
    protectedFieldCount: changedDrugs.reduce((sum, drug) => sum + drug.protectedChanges.length, 0),
    newDrugCount: newDrugs.length,
    suppressedDrugCount: newDrugs.filter(drug => drug.suppressed).length,
    identityConflictCount: identityConflicts.length,
    currentOnlyCount: currentOnly.length,
    unchangedCount,
    inventoryRowsAffected: 0 as const,
    historyRowsAffected: 0 as const,
  };

  const signature = stableSignature({
    summary,
    changedDrugs: changedDrugs.map(drug => ({
      catalogDrugId: drug.catalogDrugId,
      masterDrugId: drug.masterDrugId,
      changes: drug.changes.map(change => [change.field, change.currentValue, change.incomingValue, change.policy, change.blockedReason || null]),
      protectedChanges: drug.protectedChanges.map(change => [change.field, change.currentValue, change.incomingValue]),
    })),
    newDrugs: newDrugs.map(drug => [drug.catalogDrugId, drug.suppressed, drug.incoming]),
    identityConflicts: identityConflicts.map(conflict => [conflict.catalogDrugId, conflict.masterDrugId, conflict.currentName, conflict.incomingName]),
    matchedLinks: matchedLinks.map(link => [link.catalogDrugId, link.masterDrugId]),
  });

  return {
    signature,
    summary,
    changedDrugs,
    newDrugs,
    identityConflicts,
    matchedLinks,
    currentOnlySample: currentOnly.slice(0, 200),
  };
}

export function previewMasterDrugCatalogUpdate(
  rows: CatalogRow[],
  database: CatalogUpdateDatabase = defaultDatabase,
) {
  return buildPreview(rows, database);
}

export async function applyMasterDrugCatalogUpdate(
  request: ApplyMasterDrugCatalogUpdateRequest,
  database: CatalogUpdateDatabase = defaultDatabase,
) {
  if (!request.userId.trim()) throw new Error('A verified user is required');
  if (!request.backupPath.trim()) throw new Error('A verified pre-update backup is required');

  return database.transaction(async transaction => {
    const preview = await buildPreview(request.rows, transaction);
    if (preview.signature !== request.previewSignature) {
      throw new Error('Drug directory changed while it was being reviewed. Run the review again before applying.');
    }

    const fieldDecisionMap = new Map(request.fieldDecisions.map(decision => [
      `${decision.catalogDrugId}:${decision.masterDrugId}:${decision.field}`,
      decision,
    ]));
    const newDecisionMap = new Map(request.newDrugDecisions.map(decision => [decision.catalogDrugId, decision]));
    const conflictDecisionMap = new Map(request.identityConflictDecisions.map(decision => [decision.catalogDrugId, decision]));

    let updatedFields = 0;
    let updatedDrugs = 0;
    let keptLocalFields = 0;
    let addedDrugs = 0;
    let keptAbsentDrugs = 0;
    let conflictsKeptLocal = 0;

    for (const drug of preview.changedDrugs) {
      const updates: Array<[CatalogMutableField, unknown]> = [];
      for (const change of drug.changes) {
        const decision = fieldDecisionMap.get(`${drug.catalogDrugId}:${drug.masterDrugId}:${change.field}`);
        if (!decision) throw new Error(`Missing review decision for drug ${drug.catalogDrugId}, field ${change.field}`);
        if (decision.action !== 'keep_local' && decision.action !== 'use_catalog') {
          throw new Error(`Invalid review decision for drug ${drug.catalogDrugId}, field ${change.field}`);
        }
        if (!valuesEqual(decision.expectedCurrentValue, change.currentValue) || !valuesEqual(decision.expectedIncomingValue, change.incomingValue)) {
          throw new Error(`Stale review decision for drug ${drug.catalogDrugId}, field ${change.field}`);
        }
        if (decision.action === 'use_catalog' && change.blockedReason) {
          throw new Error(`Catalog value for ${change.field} cannot be applied: ${change.blockedReason}`);
        }

        const policy: CatalogPolicy = decision.action === 'use_catalog' ? 'catalog' : 'local';
        await transaction.execute(`
          INSERT INTO drug_catalog_field_policies (master_drug_id, field_name, policy, updated_by, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(master_drug_id, field_name) DO UPDATE SET
            policy = excluded.policy,
            updated_by = excluded.updated_by,
            updated_at = CURRENT_TIMESTAMP
        `, [drug.masterDrugId, change.field, policy, request.userId]);

        if (decision.action === 'use_catalog') {
          if (change.field === 'barcode') {
            await assertBarcodeOwnershipAvailable(
              transaction,
              [{ barcode: change.incomingValue, drugId: drug.masterDrugId }],
            );
          }
          updates.push([change.field, change.incomingValue]);
          updatedFields++;
        } else {
          keptLocalFields++;
        }
      }

      if (updates.length) {
        await transaction.execute(
          `UPDATE master_drugs SET ${updates.map(([field]) => `${field} = ?`).join(', ')} WHERE id = ?`,
          [...updates.map(([, value]) => value), drug.masterDrugId],
        );
        updatedDrugs++;
      }

    }

    // Persist every safe match, including unchanged rows. This establishes a
    // durable catalog identity for existing installations so later local name
    // edits or intentional deletions do not make the next update guess again.
    for (const link of preview.matchedLinks) {
      await transaction.execute(`
        INSERT INTO drug_catalog_links (catalog_drug_id, master_drug_id, linked_by, linked_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(catalog_drug_id) DO UPDATE SET
          master_drug_id = excluded.master_drug_id,
          linked_by = excluded.linked_by,
          linked_at = CURRENT_TIMESTAMP
      `, [link.catalogDrugId, link.masterDrugId, request.userId]);
    }

    for (const drug of preview.newDrugs) {
      const decision = newDecisionMap.get(drug.catalogDrugId);
      if (!decision) throw new Error(`Missing review decision for new catalog drug ${drug.catalogDrugId}`);
      if (decision.action !== 'keep_absent' && decision.action !== 'add') {
        throw new Error(`Invalid review decision for new catalog drug ${drug.catalogDrugId}`);
      }
      if (decision.action === 'keep_absent') {
        await transaction.execute(`
          INSERT INTO drug_catalog_suppressions (catalog_drug_id, reason, created_by, created_at, updated_at)
          VALUES (?, 'kept_absent_by_user', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(catalog_drug_id) DO UPDATE SET
            reason = excluded.reason,
            created_by = excluded.created_by,
            updated_at = CURRENT_TIMESTAMP
        `, [drug.catalogDrugId, request.userId]);
        keptAbsentDrugs++;
        continue;
      }

      const tradeName = cleanText(drug.incoming.trade_name) || cleanText(drug.incoming.trade_name_en);
      if (!tradeName) throw new Error(`New catalog drug ${drug.catalogDrugId} has no trade name`);
      if (own(drug.incoming, 'barcode')) {
        await assertBarcodeOwnershipAvailable(transaction, [{ barcode: drug.incoming.barcode }]);
      }

      const fields = CATALOG_MUTABLE_FIELDS.filter(field => own(drug.incoming, field));
      if (!fields.includes('trade_name')) fields.unshift('trade_name');
      const values = fields.map(field => field === 'trade_name' ? tradeName : drug.incoming[field]);
      await transaction.execute(
        `INSERT INTO master_drugs (id, ${fields.join(', ')}) VALUES (?, ${fields.map(() => '?').join(', ')})`,
        [drug.catalogDrugId, ...values],
      );
      await transaction.execute('DELETE FROM drug_catalog_suppressions WHERE catalog_drug_id = ?', [drug.catalogDrugId]);
      await transaction.execute(`
        INSERT INTO drug_catalog_links (catalog_drug_id, master_drug_id, linked_by, linked_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(catalog_drug_id) DO UPDATE SET
          master_drug_id = excluded.master_drug_id,
          linked_by = excluded.linked_by,
          linked_at = CURRENT_TIMESTAMP
      `, [drug.catalogDrugId, drug.catalogDrugId, request.userId]);
      addedDrugs++;
    }

    for (const conflict of preview.identityConflicts) {
      const decision = conflictDecisionMap.get(conflict.catalogDrugId);
      if (!decision || decision.action !== 'keep_local') {
        throw new Error(`Identity conflict ${conflict.catalogDrugId} must be kept local and reviewed manually`);
      }
      await transaction.execute(`
        INSERT INTO drug_catalog_suppressions (catalog_drug_id, reason, created_by, created_at, updated_at)
        VALUES (?, 'identity_conflict_kept_local', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(catalog_drug_id) DO UPDATE SET
          reason = excluded.reason,
          created_by = excluded.created_by,
          updated_at = CURRENT_TIMESTAMP
      `, [conflict.catalogDrugId, request.userId]);
      conflictsKeptLocal++;
    }

    const result = {
      updatedDrugs,
      updatedFields,
      keptLocalFields,
      addedDrugs,
      keptAbsentDrugs,
      conflictsKeptLocal,
      currentOnlyPreserved: preview.summary.currentOnlyCount,
      protectedFieldsPreserved: preview.summary.protectedFieldCount,
      inventoryRowsAffected: 0,
      historyRowsAffected: 0,
      backupPath: request.backupPath,
    };
    const runId = generateId();
    await transaction.execute(`
      INSERT INTO drug_catalog_update_runs (
        id, user_id, source_name, preview_signature, backup_path, summary_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `, [runId, request.userId, cleanText(request.sourceName), request.previewSignature, request.backupPath, JSON.stringify(result)]);
    await transaction.execute(
      "INSERT INTO activity_log (user_id, action, details) VALUES (?, 'DRUG_CATALOG_RECONCILE', ?)",
      [request.userId, JSON.stringify({ runId, source: cleanText(request.sourceName), ...result })],
    );

    return { runId, ...result };
  });
}
