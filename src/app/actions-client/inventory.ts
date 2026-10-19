import { secureCache } from '@/lib/cache/secure_cache';
import { dbSelect, dbExecute, dbGet, dbTransaction, dbReadScopedAll, generateId, type TransactionDb } from '@/lib/db/tauri';
import { isTauri } from '@/lib/env';
const logActivity = async (userId, action, details) => {
  try {
    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
};

const db = {
  prepare: (sql) => ({
    all: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbSelect(sql, args);
    },
    get: (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbGet(sql, args);
    },
    run: async (...p) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      const res = await dbExecute(sql, args);
      return {
        changes: res.rowsAffected,
        lastInsertRowid: res.lastInsertId,
        rowsAffected: res.rowsAffected,
        lastInsertId: res.lastInsertId
      };
    }
  }),
  transaction: (cb) => {
    return (...args) => dbTransaction(async (transactionDb) => await cb(transactionDb, ...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};



import { z } from 'zod';

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { isBusinessDate, localDate } from '@/lib/time';
import { importInventoryWorkbookRows } from '@/lib/inventory/import';
import { notifyInventoryChanged } from '@/lib/inventory/refresh';
import { getSalesQuantityInLargeSql, resolveRecoveredShortages } from '@/lib/inventory/reorder-state';

function normalizePharmacyId(value: unknown): string {
  const pharmacyId = String(value ?? '').trim();
  return pharmacyId || 'local_default';
}

function normalizeInventoryBarcode(value: unknown): string | null {
  const barcode = String(value ?? '').trim();
  return barcode.length > 0 ? barcode : null;
}

async function assertInventoryBarcodeAvailable(
  barcode: string | null,
  drugId: number,
  scopedDb: Pick<TransactionDb, 'prepare'>,
) {
  if (!barcode) return;

  const masterOwner = await scopedDb.prepare(`
    SELECT id
    FROM master_drugs
    WHERE id != ?
      AND barcode IS NOT NULL
      AND TRIM(barcode) = ? COLLATE NOCASE
    LIMIT 1
  `).get(drugId, barcode) as any;
  if (masterOwner) throw new Error('Barcode is already assigned to another drug');

  const inventoryOwner = await scopedDb.prepare(`
    SELECT drug_id
    FROM inventory
    WHERE drug_id != ?
      AND barcode IS NOT NULL
      AND TRIM(barcode) = ? COLLATE NOCASE
      AND (quantity IS NULL OR quantity != 0)
    LIMIT 1
  `).get(drugId, barcode) as any;
  if (inventoryOwner) throw new Error('Barcode is already assigned to another drug');
}

async function assertInventoryImportConversionPermission(
  user: any,
  inventoryRows: any[],
  drugRows: any[],
  scopedDb: Pick<TransactionDb, 'prepare'>,
) {
  if (hasUserPermissionSync(user, 'can_modify_unit_conversion')) return;

  const requestedDrugIds = [...new Set([
    ...drugRows.map(row => Number(row?.id)),
    ...inventoryRows.map(row => Number(row?.drug_id)),
  ].filter(id => Number.isSafeInteger(id) && id > 0))];
  if (requestedDrugIds.length === 0) return;

  const existingRows = await scopedDb.prepare(`
    SELECT id,
           COALESCE(NULLIF(large_to_medium, 0), 1) AS large_to_medium,
           COALESCE(NULLIF(medium_to_small, 0), 1) AS medium_to_small
    FROM master_drugs
    WHERE id IN (${requestedDrugIds.map(() => '?').join(',')})
  `).all(...requestedDrugIds) as any[];
  const existingById = new Map(existingRows.map(row => [Number(row.id), row]));

  const conversion = (value: unknown) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 10_000 ? parsed : null;
  };

  for (const row of drugRows) {
    const drugId = Number(row?.id);
    if (!Number.isSafeInteger(drugId) || drugId <= 0) continue;
    const current = existingById.get(drugId);
    for (const field of ['large_to_medium', 'medium_to_small'] as const) {
      const requested = conversion(row?.[field]);
      if (requested === null) continue;
      const currentValue = Number(current?.[field] || 1);
      if (requested !== currentValue) throw new Error('غير مصرح بتعديل معاملات التحويل');
    }
  }

  for (const row of inventoryRows) {
    const drugId = Number(row?.drug_id);
    if (!Number.isSafeInteger(drugId) || drugId <= 0) continue;
    const importedMaster = drugRows.find(drug => Number(drug?.id) === drugId);
    const largeToMedium = conversion(importedMaster?.large_to_medium)
      ?? Number(existingById.get(drugId)?.large_to_medium || 1);
    const mediumToSmall = conversion(importedMaster?.medium_to_small)
      ?? Number(existingById.get(drugId)?.medium_to_small || 1);
    const stripsPerBox = conversion(row?.strips_per_box) ?? largeToMedium;
    if (stripsPerBox !== largeToMedium) throw new Error('غير مصرح بتعديل معاملات التحويل');

    // Unlike strips_per_box, the importer writes this source value directly.
    if (row?.medium_to_small !== undefined) {
      const requested = conversion(row.medium_to_small);
      if (requested === null || requested !== mediumToSmall) {
        throw new Error('غير مصرح بتعديل معاملات التحويل');
      }
    }
  }
}

export async function importInventoryWorkbookAction(inventoryRows: any[], drugRows: any[]) {
  if (isTauri) {
    try {
      // Desktop imports must not upsert shared master catalog, restore stale
      // lot IDs or accept spreadsheet pharmacy/cost/account authority.
      // The bounded native route adds NEW zero-cost lots only to verified
      // existing catalog drugs; historical restores need a separate workflow.
      if (!Array.isArray(inventoryRows) || !Array.isArray(drugRows) ||
          inventoryRows.length < 1 || inventoryRows.length > 200 || drugRows.length > 0) {
        return { success: false, error: 'الاستيراد الأصلي يدعم 1–200 دفعة لأصناف موجودة فقط، دون تعديل الكتالوج العام' };
      }
      const rows = inventoryRows.map((row: Record<string, unknown>) => {
        if (!row || typeof row !== 'object' || Array.isArray(row) ||
            ['id', 'pharmacy_id', 'user_id', 'created_by', 'cost_price', 'account_id', 'official_price']
              .some(key => Object.prototype.hasOwnProperty.call(row, key))) {
          throw new Error('Existing lot IDs, account, cost and pharmacy fields cannot be imported as new stock');
        }
        const drugId = Number(row.drug_id);
        const quantity = Number(row.quantity);
        const localSellingPrice = Number(row.local_selling_price);
        if (!Number.isSafeInteger(drugId) || drugId <= 0 ||
            !Number.isFinite(quantity) || quantity <= 0 ||
            !Number.isFinite(localSellingPrice) || localSellingPrice < 0) {
          throw new Error('Invalid imported stock quantities or authoritative drug reference');
        }
        const expiryDate = typeof row.expiry_date === 'string' && row.expiry_date.trim()
          ? row.expiry_date.trim() : null;
        const largeToMedium = row.strips_per_box == null || row.strips_per_box === ''
          ? null : Number(row.strips_per_box);
        const mediumToSmall = row.medium_to_small == null || row.medium_to_small === ''
          ? null : Number(row.medium_to_small);
        if ((largeToMedium !== null && (!Number.isSafeInteger(largeToMedium) || largeToMedium <= 0)) ||
            (mediumToSmall !== null && (!Number.isSafeInteger(mediumToSmall) || mediumToSmall <= 0))) {
          throw new Error('Invalid imported unit conversion assertion');
        }
        return {
          drugId, quantity, localSellingPrice, expiryDate,
          barcode: normalizeInventoryBarcode(row.barcode),
          unit: typeof row.large_unit === 'string' && row.large_unit.trim() ? row.large_unit.trim() : null,
          expectNullLargeUnit: false,
          largeToMedium, mediumToSmall,
        };
      });
      const requestId = generateId();
      const reply = await (await import('@tauri-apps/api/core')).invoke<unknown>(
        'import_inventory_lots_native', { input: { requestId, rows } },
      );
      if (!reply || typeof reply !== 'object' || Array.isArray(reply) ||
          (reply as any).success !== true ||
          typeof (reply as any).requestId !== 'string' ||
          !addInventorySchema.shape.request_id.safeParse((reply as any).requestId).success ||
          !Number.isSafeInteger((reply as any).inventoryCount) ||
          (reply as any).inventoryCount !== rows.length ||
          !Array.isArray((reply as any).inventoryIds) ||
          (reply as any).inventoryIds.length !== rows.length ||
          (reply as any).inventoryIds.some((id: unknown) => typeof id !== 'string' || !id) ||
          typeof (reply as any).replayed !== 'boolean' ||
          'error' in reply || 'code' in reply) {
        throw new Error('Invalid native import acknowledgement');
      }
      revalidatePath('/inventory');
      try { notifyInventoryChanged(); } catch (error) { console.error('Inventory import refresh error:', error); }
      return { success: true, data: { inventoryCount: rows.length, masterDrugCount: 0 }, replayed: (reply as any).replayed as boolean };
    } catch {
      return { success: false, error: 'فشل الاستيراد الأصلي؛ لا يمكن التراجع إلى استعلامات SQL من الواجهة' };
    }
  }
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_manage_inventory')) {
      return { success: false, error: 'غير مصرح' };
    }

    const data = await importInventoryWorkbookRows(
      inventoryRows,
      drugRows,
      normalizePharmacyId(user.pharmacy_id),
      undefined,
      (effectiveInventoryRows, effectiveMasterRows, transaction) =>
        assertInventoryImportConversionPermission(user, effectiveInventoryRows, effectiveMasterRows, transaction),
    );
    revalidatePath('/inventory');
    notifyInventoryChanged();
    return { success: true, data };
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

// Zod schema for adding inventory
const addInventorySchema = z.object({
  pharmacy_id: z.string().optional().nullable(),
  drug_id: z.coerce.number().int().positive('معرف الدواء يجب أن يكون رقم موجب'),
  quantity: z.coerce.number().positive('الكمية يجب أن تكون رقم موجب'),
  local_selling_price: z.coerce.number().nonnegative('السعر لا يمكن أن يكون سالباً'),
  expiry_date: z.preprocess(
    val => (typeof val === 'string' && val.trim() === '' ? null : val),
    z.string().refine(isBusinessDate, 'تاريخ الصلاحية غير صالح').optional().nullable()
  ),
  barcode: z.string().optional().nullable(),
  unit: z.string().optional().nullable(),
  large_to_medium: z.coerce.number().int().positive().optional().nullable(),
  // Optional live-catalog precondition, not a catalog write permission.
  expect_null_large_unit: z.boolean().optional(),
  // Keep the exact desktop retry witness; Rust requires a canonical UUIDv4.
  request_id: z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'معرف محاولة الإضافة غير صالح',
  ).optional(),
});

// Zod schema for updating inventory
const updateInventorySchema = z.object({
  id: z.string().min(1, 'معرف المخزون غير صالح'),
  quantity: z.coerce.number().min(0, 'الكمية لا يمكن أن تكون سالبة'),
  local_selling_price: z.coerce.number().min(0, 'السعر لا يمكن أن يكون سالباً'),
  // Desktop updates are compare-and-swap against the original rendered lot.
  expected_quantity: z.number().finite().nonnegative().optional(),
  expected_local_selling_price: z.number().finite().nonnegative().optional(),
  reason_id: z.coerce.number().optional().nullable(),
  large_to_medium: z.coerce.number().int().positive().optional().nullable(),
  barcode: z.string().optional().nullable(),
  unit: z.string().optional().nullable(),
  expiry_date: z.preprocess(
    val => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().refine(isBusinessDate, 'تاريخ الصلاحية غير صالح').optional().nullable()
  ),
});

// Zod schema for deleting inventory
const deleteInventorySchema = z.object({
  id: z.string().min(1, 'معرف المخزون غير صالح'),
});

// Zod's numeric coercion maps an empty string, null, false or [] to zero.
// Desktop inventory permits a *deliberate* zero selling price, but an empty
// form value must never silently create a free lot or overwrite live pricing.
// Preserve finite numeric values and nonblank numeric text from HTML inputs.
function isExplicitNativeSellingPrice(value: unknown): boolean {
  return (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value)));
}

export type AddInventoryInput = z.infer<typeof addInventorySchema>;
export type UpdateInventoryInput = z.infer<typeof updateInventorySchema>;
export type DeleteInventoryInput = z.infer<typeof deleteInventorySchema>;

export interface PendingInventoryCreation {
  requestId: string;
  inventoryId: string;
  createdBy: string;
  drugId: number;
  quantity: number;
  localSellingPrice: number;
  expiryDate: string | null;
  createdAt: string;
}

/** Durable recovery is backed by scoped native SQLite receipts, never
 * sessionStorage/localStorage or an untrusted renderer actor/pharmacy. */
export async function getPendingInventoryCreationsAction() {
  if (!isTauri) return { success: true as const, data: [] as PendingInventoryCreation[] };
  try {
    const rows = await (await import('@tauri-apps/api/core')).invoke<unknown>(
      'list_unacknowledged_inventory_creates_native',
    );
    if (!Array.isArray(rows) || rows.length > 100 || rows.some(row =>
      !row || typeof row !== 'object' || Array.isArray(row) ||
      typeof row.requestId !== 'string' || !addInventorySchema.shape.request_id.safeParse(row.requestId).success ||
      typeof row.inventoryId !== 'string' || !row.inventoryId ||
      typeof row.createdBy !== 'string' || !row.createdBy ||
      !Number.isSafeInteger(row.drugId) || row.drugId <= 0 ||
      !Number.isFinite(row.quantity) || row.quantity < 0 ||
      !Number.isFinite(row.localSellingPrice) || row.localSellingPrice < 0 ||
      (row.expiryDate !== null && typeof row.expiryDate !== 'string') ||
      typeof row.createdAt !== 'string'
    )) throw new Error('Malformed native pending inventory recovery records');
    return { success: true as const, data: rows as PendingInventoryCreation[] };
  } catch (error) {
    // A native failure must remain diagnosable to the authorized inventory
    // manager. The renderer still fails closed: no create/ack fallback occurs.
    const nativeMessage = typeof error === 'string'
      ? error.trim()
      : error instanceof Error ? error.message.trim() : '';
    return {
      success: false as const,
      error: nativeMessage ? nativeMessage.slice(0, 500) : 'تعذر التحقق من عمليات إضافة المخزون السابقة',
    };
  }
}

export async function acknowledgePendingInventoryCreationAction(requestId: string, inventoryId: string) {
  if (!isTauri) return { success: false as const, error: 'التأكيد الأصلي متاح لتطبيق سطح المكتب فقط' };
  if (!addInventorySchema.shape.request_id.safeParse(requestId).success ||
      typeof inventoryId !== 'string' || !inventoryId.trim() || inventoryId.length > 128) {
    return { success: false as const, error: 'معرف عملية الإضافة غير صالح' };
  }
  try {
    const ack = await (await import('@tauri-apps/api/core')).invoke<unknown>(
      'acknowledge_inventory_create_native', { payload: { requestId, inventoryId } },
    );
    if (!ack || typeof ack !== 'object' || Array.isArray(ack) ||
        (ack as any).success !== true || (ack as any).requestId !== requestId ||
        (ack as any).inventoryId !== inventoryId || 'error' in ack || 'code' in ack) {
      throw new Error('Invalid native inventory acknowledgement');
    }
    return { success: true as const };
  } catch {
    return { success: false as const, error: 'تعذر تأكيد الإضافة السابقة؛ راجع سجل المخزون' };
  }
}

/**
 * Server Action to add a new inventory item (Local Enforcer)
 */
export async function addInventoryAction(formData: AddInventoryInput) {
  if (isTauri) {
    try {
      if (!isExplicitNativeSellingPrice(formData.local_selling_price)) {
        return { success: false, error: 'سعر البيع مطلوب ولا يمكن تركه فارغاً' };
      }
      const parsed = addInventorySchema.safeParse(formData);
      if (!parsed.success) {
        return { success: false, error: `بيانات الإدخال غير صالحة: ${parsed.error.issues.map(i => i.message).join(', ')}` };
      }
      const { drug_id, quantity, local_selling_price, expiry_date, barcode, unit, large_to_medium, expect_null_large_unit, request_id } = parsed.data;
      if (!Number.isSafeInteger(drug_id) || !Number.isFinite(quantity) ||
          !Number.isFinite(local_selling_price)) {
        return { success: false, error: 'بيانات الإدخال غير صالحة' };
      }
      // Unit/conversion values are assertions against the live native catalog.
      // Rust rejects changes; this command never mutates shared catalog units.
      const stableRequestId = request_id ?? generateId();
      const result = await (await import('@tauri-apps/api/core')).invoke<unknown>(
        'create_inventory_lot_native', {
          payload: {
            drugId: drug_id,
            quantity,
            localSellingPrice: local_selling_price,
            expiryDate: expiry_date ?? null,
            barcode: normalizeInventoryBarcode(barcode),
            unit: unit?.trim() || null,
            largeToMedium: large_to_medium ?? null,
            expectNullLargeUnit: expect_null_large_unit === true,
            requestId: stableRequestId,
          },
        },
      );
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          (result as { success?: unknown }).success !== true ||
          typeof (result as { id?: unknown }).id !== 'string' ||
          !(result as { id: string }).id.trim() ||
          (result as { drugId?: unknown }).drugId !== drug_id ||
          'error' in result || 'code' in result) {
        throw new Error('Invalid native inventory creation confirmation');
      }
      // CRITICAL: do NOT automatically acknowledge the durable receipt.
      // If the acknowledgement COMMIT succeeds but *its* IPC reply is lost,
      // the UI cannot know whether it happened; after modal close/restart a
      // fresh nonce could duplicate a previous stock creation. Only an
      // explicit operator verification of the original existing lot may
      // clear the pending receipt via acknowledgePendingInventoryCreationAction.
      // Until then the native pharmacy-wide new-nonce guard stays closed.
      revalidatePath('/inventory');
      revalidatePath('/');
      try { notifyInventoryChanged(); } catch (error) { console.error('Inventory native refresh error:', error); }
      return { success: true };
    } catch (error: any) {
      console.error('Native add inventory error:', error);
      return { success: false, error: 'فشل إضافة الصنف' };
    }
  }

  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح - لا يوجد جلسة' };

    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    if (!hasUserPermissionSync(localUser, 'can_manage_inventory')) {
      return { success: false, error: 'ليس لديك صلاحية إضافة أصناف للمخزون' };
    }

    // Step 3: Validation
    console.log('[addInventoryAction] Step 3: Validating formData...');
    const validationResult = addInventorySchema.safeParse(formData);
    if (!validationResult.success) {
      console.error('[addInventoryAction] Step 3 FAILED: Validation errors:', JSON.stringify(validationResult.error.issues));
      return { success: false, error: `بيانات الإدخال غير صالحة: ${validationResult.error.issues.map(i => i.message).join(', ')}` };
    }
    console.log('[addInventoryAction] Step 3 result: validation passed');

    const { drug_id, quantity, local_selling_price, expiry_date, barcode, unit, large_to_medium } = validationResult.data;
    const normalizedBarcode = normalizeInventoryBarcode(barcode);
    const pharmacyId = normalizePharmacyId(localUser.pharmacy_id);
    const catalogUnits = await db.prepare(`
      SELECT large_unit,
             COALESCE(NULLIF(large_to_medium, 0), 1) AS large_to_medium,
             COALESCE(has_expiry, 1) AS has_expiry
      FROM master_drugs
      WHERE id = ?
    `).get(drug_id) as any;
    if (!catalogUnits) {
      return { success: false, error: 'الصنف غير موجود بكتالوج الأدوية' };
    }
    if (Number(catalogUnits.has_expiry ?? 1) !== 0 && !expiry_date) {
      return { success: false, error: 'بيانات الإدخال غير صالحة: تاريخ الصلاحية غير صالح' };
    }
    const canModifyUnitConversion = hasUserPermissionSync(localUser, 'can_modify_unit_conversion');
    const requestedUnit = String(unit || '').trim();
    const currentUnit = String(catalogUnits.large_unit || '').trim();
    const changesUnit = Boolean(requestedUnit) && requestedUnit !== currentUnit;
    const changesConversion = large_to_medium !== undefined && large_to_medium !== null
      && Number(large_to_medium) !== Number(catalogUnits.large_to_medium || 1);
    if ((changesUnit || changesConversion) && !canModifyUnitConversion) {
      return { success: false, error: 'غير مصرح بتعديل معاملات التحويل' };
    }

    // Step 4: Generate ID
    console.log('[addInventoryAction] Step 4: Generating UUID...');
    const id = generateId();

    // Step 5: Insert the lot and any shared catalog metadata atomically. If a
    // later metadata write fails, the UI must not see a failed action after a
    // lot has already been committed (a retry would otherwise duplicate stock).
    console.log('[addInventoryAction] Step 5: Inserting into inventory...');
    await dbTransaction(async (transactionDb) => {
      const conversion = await transactionDb.prepare(
        'SELECT COALESCE(NULLIF(medium_to_small, 0), 1) AS medium_to_small FROM master_drugs WHERE id = ?'
      ).get(drug_id) as any;
      const mediumToSmall = Math.max(1, Number(conversion?.medium_to_small) || 1);

      await assertInventoryBarcodeAvailable(normalizedBarcode, drug_id, transactionDb);

      await transactionDb.prepare(`
        INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date, barcode, strips_per_box, medium_to_small)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, pharmacyId, drug_id, quantity, local_selling_price, expiry_date ?? null, normalizedBarcode, large_to_medium || 1, mediumToSmall);

      if (unit) {
        await transactionDb.prepare('UPDATE master_drugs SET large_unit = ? WHERE id = ?').run(unit, drug_id);
      }

      if (large_to_medium !== undefined && large_to_medium !== null) {
        await transactionDb.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(large_to_medium, drug_id);
      }

      if (normalizedBarcode) {
        await transactionDb.prepare("UPDATE master_drugs SET barcode = ? WHERE id = ? AND (barcode IS NULL OR barcode = '')").run(normalizedBarcode, drug_id);
      }

      await resolveRecoveredShortages(transactionDb, drug_id, pharmacyId);
    });

    if (unit || (large_to_medium !== undefined && large_to_medium !== null) || normalizedBarcode) {
      secureCache.updateDrug(drug_id, {
        ...(unit ? { large_unit: unit } : {}),
        ...(large_to_medium !== undefined && large_to_medium !== null ? { large_to_medium } : {}),
        ...(normalizedBarcode ? { barcode: normalizedBarcode } : {})
      });
    }
    
    console.log('[addInventoryAction] Step 5 result: INSERT successful');

    // Step 6: Get trade name for activity log via direct SQL (avoids loading full 191K cache)
    let tradeName = `صنف #${drug_id}`;
    try {
      const drugRow = await db.prepare('SELECT trade_name, trade_name_en, active_ingredient FROM master_drugs WHERE id = ?').get(drug_id) as any;
      if (drugRow) tradeName = drugRow.trade_name_en || drugRow.trade_name || drugRow.active_ingredient || tradeName;
    } catch (_) {}

    logActivity(localUser.id, 'ADD_INVENTORY', `أضاف ${quantity} من ${tradeName}`);
    console.log('[addInventoryAction] SUCCESS! Returning success.');

    revalidatePath('/inventory');
    revalidatePath('/');

    notifyInventoryChanged();
    return { success: true };
  } catch (error: any) {
    console.error('[addInventoryAction] CAUGHT ERROR:', error?.message || error, '\nStack:', error?.stack);
    return { success: false, error: `فشل إضافة الصنف: ${error?.message || String(error)}` };
  }
}

/**
 * Server Action to update an existing inventory item
 */
export async function updateInventoryAction(formData: UpdateInventoryInput) {
  if (isTauri) {
    try {
      if (!isExplicitNativeSellingPrice(formData.local_selling_price)) {
        return { success: false, error: 'سعر البيع مطلوب ولا يمكن تركه فارغاً' };
      }
      const parsed = updateInventorySchema.safeParse(formData);
      if (!parsed.success || parsed.data.expected_quantity === undefined ||
          parsed.data.expected_local_selling_price === undefined ||
          !Number.isFinite(parsed.data.quantity) ||
          !Number.isFinite(parsed.data.local_selling_price)) {
        return { success: false, error: 'بيانات تحديث المخزون غير صالحة أو قديمة؛ أعد فتح شاشة التعديل' };
      }
      const row = parsed.data;
      const result = await (await import('@tauri-apps/api/core')).invoke<unknown>(
        'update_inventory_lot_native', {
          payload: {
            id: row.id,
            quantity: row.quantity,
            localSellingPrice: row.local_selling_price,
            expectedQuantity: row.expected_quantity,
            expectedLocalSellingPrice: row.expected_local_selling_price,
            reasonId: row.reason_id ?? null,
            expiryDate: row.expiry_date,
            barcode: row.barcode,
            unit: row.unit ?? null,
            largeToMedium: row.large_to_medium ?? null,
          },
        },
      );
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          (result as { success?: unknown }).success !== true ||
          (result as { id?: unknown }).id !== row.id ||
          'error' in result || 'code' in result) {
        throw new Error('Invalid native inventory update confirmation');
      }
      revalidatePath('/inventory');
      revalidatePath('/');
      try { notifyInventoryChanged(); } catch (error) { console.error('Inventory native refresh error:', error); }
      return { success: true };
    } catch {
      return { success: false, error: 'فشل التحديث الأصلي للمخزون؛ أعد تحميل بيانات الصنف قبل المحاولة' };
    }
  }
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    if (!hasUserPermissionSync(localUser, 'can_manage_inventory')) {
      return { success: false, error: 'ليس لديك صلاحية تحديث بيانات المخزون' };
    }

    const validationResult = updateInventorySchema.safeParse(formData);
    if (!validationResult.success) {
      return { success: false, error: 'بيانات التحديث غير صالحة.' };
    }

    const { id, quantity, local_selling_price, reason_id, large_to_medium, expiry_date } = validationResult.data;
    const pharmacyId = normalizePharmacyId(localUser.pharmacy_id);

    const { secureCache } = await import('@/lib/cache/secure_cache');
    await secureCache.load();

    const result = await dbTransaction(async (db) => {
    const current = await db.prepare(`
      SELECT i.quantity, i.drug_id, i.strips_per_box, m.large_to_medium, COALESCE(m.has_expiry, 1) AS has_expiry
      FROM inventory i 
      JOIN master_drugs m ON m.id = i.drug_id
      WHERE i.id = ?
        AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(id, pharmacyId, pharmacyId) as { quantity: number, drug_id: number, strips_per_box?: number, large_to_medium?: number, has_expiry?: number };

    if (!current) return { success: false, error: 'الصنف غير موجود بالمخزون' };

    if (Math.abs(Number(quantity) - Number(current.quantity)) > 0.000001 && !reason_id) {
      return { success: false, error: 'يجب اختيار سبب عند تعديل كمية المخزون' };
    }

    if (expiry_date === null && Number(current.has_expiry ?? 1) !== 0) {
      return { success: false, error: 'بيانات التحديث غير صالحة: تاريخ الصلاحية مطلوب لهذا الصنف' };
    }

    const canModifyUnitConversion = hasUserPermissionSync(localUser, 'can_modify_unit_conversion');
    if (large_to_medium !== undefined && large_to_medium !== null) {
      const changesBatchConversion = Number(large_to_medium) !== Number(current.strips_per_box || current.large_to_medium || 1);
      if (changesBatchConversion && !canModifyUnitConversion) {
        return { success: false, error: 'غير مصرح بتعديل معاملات التحويل' };
      }
    }

    let updateInvQuery = `
      UPDATE inventory 
      SET quantity = ?, local_selling_price = ?, updated_at = CURRENT_TIMESTAMP
    `;
    const invParams: any[] = [quantity, local_selling_price];

    if (expiry_date !== undefined) {
      updateInvQuery += `, expiry_date = ?`;
      invParams.push(expiry_date);
    }

    updateInvQuery += ` WHERE id = ? AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))`;
    invParams.push(id, pharmacyId, pharmacyId);

    await db.prepare(updateInvQuery).run(...invParams);

    if (large_to_medium !== undefined && large_to_medium !== null && canModifyUnitConversion
        && Number(large_to_medium) !== Number(current.strips_per_box || current.large_to_medium || 1)) {
      await db.prepare('UPDATE inventory SET strips_per_box = ? WHERE id = ?').run(large_to_medium, id);
      await db.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(large_to_medium, current.drug_id);
    }

    // Keep selling price aligned across master_drugs & inventory
    await db.prepare('UPDATE master_drugs SET official_price = ? WHERE id = ?').run(local_selling_price, current.drug_id);

    // Direct SQL lookup for trade name
    const drugRow2 = await db.prepare('SELECT trade_name, trade_name_en, active_ingredient FROM master_drugs WHERE id = ?').get(current.drug_id) as any;
    const tradeName = drugRow2?.trade_name_en || drugRow2?.trade_name || drugRow2?.active_ingredient || `صنف #${current.drug_id}`;

    if (reason_id && quantity !== current.quantity) {
      let reasonText = 'تسوية مخزون';
      try {
        const adjustmentReason = await db.prepare('SELECT * FROM adjustment_reasons WHERE id = ?').get(reason_id) as any;
        reasonText = adjustmentReason?.name_ar || adjustmentReason?.reason || adjustmentReason?.name_en || 'تسوية مخزون';
      } catch (e) {}
      const journalId = generateId();
      const diff = Math.abs(quantity - current.quantity);
      const costPrice = await db.prepare('SELECT cost_price FROM inventory WHERE id = ?').get(id) as { cost_price: number };
      const totalValue = diff * (costPrice?.cost_price || 0);

      if (totalValue > 0) {
        const date = localDate();
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(journalId, date, `تسوية مخزون (${reasonText}) للصنف: ${tradeName}`, localUser.id, totalValue);

        const getAccountId = async (cat: string) => {
          const s = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
          return s?.account_id;
        };

        const accounts = {
          inventory: await getAccountId('inventory_asset') || 10,
          inventoryExpense: await getAccountId('inventory_adjustment_expense') || 11,
          inventoryRevenue: await getAccountId('inventory_adjustment_revenue') || 9
        };

        if (quantity > current.quantity) {
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'debit', totalValue);
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventoryRevenue, 'credit', totalValue);
        } else {
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventoryExpense, 'debit', totalValue);
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'credit', totalValue);
        }
      }
      
      await db.prepare(`
        INSERT INTO stock_adjustments (inventory_id, reason_id, old_quantity, new_quantity, user_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, reason_id, current.quantity, quantity, localUser.id);
    }

    if (Number(quantity) > Number(current.quantity) || Boolean(expiry_date)) {
      await resolveRecoveredShortages(db, current.drug_id, pharmacyId);
    }

    await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(
      localUser.id,
      'UPDATE_INVENTORY',
      `عدل مخزون الصنف ${tradeName}: من ${current.quantity} إلى ${quantity}`
    );
    return { success: true };
    });

    if (!result.success) return result;
    await secureCache.reload();

    revalidatePath('/inventory');
    revalidatePath('/');
    notifyInventoryChanged();
    return { success: true };
  } catch (error: any) {
    console.error('Local Update Error:', error);
    return { success: false, error: 'فشل تحديث المخزون: ' + (error.message || error) };
  }
}

/**
 * Server Action to delete an inventory item
 */
export async function deleteInventoryAction(formData: DeleteInventoryInput) {
  if (isTauri) {
    try {
      const parsed = deleteInventorySchema.safeParse(formData);
      if (!parsed.success) return { success: false, error: 'بيانات الحذف غير صالحة.' };

      const result = await (await import('@tauri-apps/api/core')).invoke<unknown>(
        'delete_inventory_lot_native', { payload: { id: parsed.data.id } },
      );
      if (!result || typeof result !== 'object' || Array.isArray(result) ||
          (result as { success?: unknown }).success !== true ||
          (result as { id?: unknown }).id !== parsed.data.id ||
          !['zeroed', 'deleted'].includes(String((result as { disposition?: unknown }).disposition)) ||
          'error' in result || 'code' in result) {
        throw new Error('Invalid native inventory deletion confirmation');
      }
      revalidatePath('/inventory');
      revalidatePath('/');
      try { notifyInventoryChanged(); } catch (error) { console.error('Inventory native refresh error:', error); }
      return { success: true };
    } catch (error: any) {
      console.error('Native delete inventory error:', error);
      return { success: false, error: 'فشل حذف الصنف.' };
    }
  }

  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    const { hasUserPermissionSync } = await import('@/lib/auth/local');
    if (!hasUserPermissionSync(localUser, 'can_manage_inventory')) {
      return { success: false, error: 'ليس لديك صلاحية حذف بيانات المخزون' };
    }

    const validationResult = deleteInventorySchema.safeParse(formData);
    if (!validationResult.success) {
      return { success: false, error: 'بيانات الحذف غير صالحة.' };
    }
    const pharmacyId = normalizePharmacyId(localUser.pharmacy_id);
    const inventoryId = validationResult.data.id;

    const remove = db.transaction(async (db) => {
      const current = await db.prepare(`
        SELECT i.drug_id, CAST(COALESCE(i.quantity, 0) AS REAL) AS quantity,
               CAST(COALESCE(i.cost_price, 0) AS REAL) AS cost_price, i.batch_number,
               COALESCE(m.trade_name_en, m.trade_name, m.active_ingredient) AS trade_name
        FROM inventory i
        LEFT JOIN master_drugs m ON m.id = i.drug_id
        WHERE i.id = ?
          AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
      `).get(inventoryId, pharmacyId, pharmacyId) as any;

      if (!current) throw new Error('Inventory item not found in this pharmacy');
      const history = await db.prepare(`
        SELECT
          EXISTS(SELECT 1 FROM sales_items WHERE inventory_id = ?) OR
          EXISTS(SELECT 1 FROM return_items WHERE inventory_id = ?) OR
          EXISTS(SELECT 1 FROM purchase_invoice_items WHERE inventory_id = ?) OR
          EXISTS(SELECT 1 FROM purchase_return_items WHERE inventory_id = ?) OR
          EXISTS(SELECT 1 FROM stock_adjustments WHERE inventory_id = ?)
          AS has_history
      `).get(inventoryId, inventoryId, inventoryId, inventoryId, inventoryId) as any;
      const oldQuantity = Number(current.quantity);
      if (Math.abs(oldQuantity) > 0.000001) {
        const update = await db.prepare(`
          UPDATE inventory
          SET quantity = 0, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        `).run(inventoryId, pharmacyId, pharmacyId);
        if (Number(update.changes) !== 1) throw new Error('Inventory item was not updated');

        await db.prepare(`
          INSERT INTO stock_adjustments (inventory_id, reason_id, old_quantity, new_quantity, user_id)
          VALUES (?, NULL, ?, 0, ?)
        `).run(inventoryId, oldQuantity, localUser.id);

        const totalValue = Math.abs(oldQuantity) * Number(current.cost_price || 0);
        if (totalValue > 0) {
          const inventorySetting = await db.prepare(
            'SELECT account_id FROM trial_balance_settings WHERE category = ?'
          ).get('inventory_asset') as any;
          const adjustmentSetting = await db.prepare(
            'SELECT account_id FROM trial_balance_settings WHERE category = ?'
          ).get('inventory_adjustment_expense') as any;
          const journalId = generateId();
          await db.prepare(`
            INSERT INTO daily_journals (id, date, description, created_by, total_amount)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            journalId,
            localDate(),
            `تصفير مخزون الدفعة ${inventoryId} (${current.trade_name || `drug #${current.drug_id}`})`,
            localUser.id,
            totalValue,
          );
          await db.prepare(
            'INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)'
          ).run(journalId, Number(adjustmentSetting?.account_id || 11), 'debit', totalValue);
          await db.prepare(
            'INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)'
          ).run(journalId, Number(inventorySetting?.account_id || 10), 'credit', totalValue);
        }

        await db.prepare(`
          INSERT INTO activity_log (user_id, action, details)
          VALUES (?, 'ZERO_INVENTORY', ?)
        `).run(
          localUser.id,
          `Zeroed inventory lot ${inventoryId} (${current.trade_name || `drug #${current.drug_id}`}); old_quantity=${oldQuantity}; batch=${current.batch_number || 'none'}`
        );
        return;
      }

      if (Number(history?.has_history) === 1) {
        throw new Error('Zero-quantity inventory lots with transaction or adjustment history are retained');
      }

      const result = await db.prepare(`
        DELETE FROM inventory
        WHERE id = ?
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      `).run(inventoryId, pharmacyId, pharmacyId);
      if (Number(result.changes) !== 1) throw new Error('Inventory item was not deleted');

      await db.prepare(`
        INSERT INTO activity_log (user_id, action, details)
        VALUES (?, 'DELETE_INVENTORY', ?)
      `).run(
        localUser.id,
        `Deleted unreferenced inventory lot ${inventoryId} (${current.trade_name || `drug #${current.drug_id}`}); quantity=${Number(current.quantity)}; batch=${current.batch_number || 'none'}`
      );
    });

    await remove();

    revalidatePath('/inventory');
    revalidatePath('/');

    notifyInventoryChanged();
    return { success: true };
  } catch (error: any) {
    if (!error?.message?.includes('not found') && !error?.message?.includes('history')) {
      console.error('Local Delete Error:', error);
    }
    return { success: false, error: error?.message || 'فشل حذف الصنف.' };
  }
}

export async function checkInteractionsAction(ingredients: string[]) {
  try {
    if (ingredients.length < 2) return { success: true, interactions: [] };

    // 1. Tokenize ingredients (split by +, ,, and space)
    const tokens: string[] = [];
    ingredients.forEach(i => {
      if (!i || i === '---') return;
      const parts = i.split(/[+, \-\/]/).map(p => p.trim()).filter(p => p.length > 2);
      tokens.push(...parts);
    });

    if (tokens.length < 2) return { success: true, interactions: [] };

    // 2. Normalize and generate variations
    const normalizedTokens = new Set<string>();
    tokens.forEach(t => {
      const lower = t.toLowerCase();
      normalizedTokens.add(lower);
      if (lower.endsWith('e')) {
        normalizedTokens.add(lower.slice(0, -1));
      } else if (lower.length > 3) {
        normalizedTokens.add(lower + 'e');
      }
    });

    const uniqueTokens = Array.from(normalizedTokens);
    
    // 3. Find interactions
    const placeholders = uniqueTokens.map(() => '?').join(',');
    const query = `
      SELECT ingredient_a, ingredient_b, severity, description_en, description_ar, recommendation
      FROM drug_interactions
      WHERE ingredient_a IN (${placeholders}) 
        AND ingredient_b IN (${placeholders})
    `;
    
    const interactions = await db.prepare(query).all(...uniqueTokens, ...uniqueTokens) as any[];
    
    const seen = new Set();
    const uniqueInteractions = [];

    for (const inter of interactions) {
      const pair = [inter.ingredient_a.toLowerCase(), inter.ingredient_b.toLowerCase()].sort().join('|');
      if (!seen.has(pair) && inter.ingredient_a.toLowerCase() !== inter.ingredient_b.toLowerCase()) {
        seen.add(pair);
        uniqueInteractions.push(inter);
      }
    }

    return { success: true, interactions: uniqueInteractions };
  } catch (error) {
    console.error('Interaction check error:', error);
    return { success: false, error: 'فشل فحص التفاعلات الدوائية' };
  }
}

/**
 * Perform comprehensive clinical safety checks (Allergies + Conditions)
 */
export async function checkClinicalSafetyAction(patientId: string, activeIngredients: string[]) {
  try {
    const alerts: { type: 'allergy' | 'condition' | 'interaction', severity: string, message_ar: string, message_en: string }[] = [];
    
    if (!patientId || activeIngredients.length === 0) return { success: true, alerts: [] };

    // 1. Check Allergies
    const allergies = await db.prepare('SELECT allergen, severity, notes FROM patient_allergies WHERE patient_id = ?').all(patientId) as any[];
    
    for (const ing of activeIngredients) {
      const match = allergies.find(a => 
        ing.toLowerCase().includes(a.allergen.toLowerCase()) || 
        a.allergen.toLowerCase().includes(ing.toLowerCase())
      );
      if (match) {
        alerts.push({
          type: 'allergy',
          severity: match.severity || 'high',
          message_ar: `تحذير: المريض لديه حساسية من "${match.allergen}" الموجود في هذا الدواء`,
          message_en: `Warning: Patient is allergic to "${match.allergen}" found in this medication`
        });
      }
    }

    // 2. Check Conditions (Keyword matching)
    const conditions = await db.prepare('SELECT condition_name FROM patient_conditions WHERE patient_id = ?').all(patientId) as any[];
    const condList = conditions.map(c => c.condition_name.toLowerCase());
    const ingredientList = activeIngredients.map(i => i.toLowerCase());

    // Logic: Condition vs Ingredient Group
    const rules = [
      {
        condition: ['asthma', 'copd'],
        ingredientMatch: (ing: string) => ing.endsWith('olol') || ing.includes('propranolol'),
        severity: 'critical',
        ar: 'تحذير: يمنع استخدام حاصرات بيتا لمرضى الربو أو الانسداد الرئوي',
        en: 'Critical: Beta blockers are contraindicated for patients with Asthma or COPD'
      },
      {
        condition: ['kidney', 'renal', 'failure'],
        ingredientMatch: (ing: string) => ing.includes('ibuprofen') || ing.includes('diclofenac') || ing.includes('naproxen'),
        severity: 'major',
        ar: 'تنبيه: يجب الحذر عند استخدام مضادات الالتهاب (NSAIDs) لمرضى القصور الكلوي',
        en: 'Major: Use NSAIDs with extreme caution in patients with renal impairment'
      },
      {
        condition: ['diabetes', 'sugar'],
        ingredientMatch: (ing: string) => ing.includes('prednisone') || ing.includes('dexamethasone') || ing.includes('hydrocortisone'),
        severity: 'major',
        ar: 'تنبيه: الكورتيزون قد يسبب ارتفاعاً حاداً في مستوى السكر في الدم',
        en: 'Major: Corticosteroids can cause significant hyperglycemia in diabetic patients'
      },
      {
        condition: ['hypertension', 'blood pressure'],
        ingredientMatch: (ing: string) => ing.includes('pseudoephedrine') || ing.includes('phenylephrine'),
        severity: 'moderate',
        ar: 'تنبيه: مزيلات الاحتقان قد ترفع ضغط الدم',
        en: 'Moderate: Decongestants may increase blood pressure'
      },
      {
        condition: ['ulcer', 'gastritis', 'stomach'],
        ingredientMatch: (ing: string) => ing.includes('aspirin') || ing.includes('diclofenac') || ing.includes('ibuprofen'),
        severity: 'major',
        ar: 'تحذير: مضادات الالتهاب قد تسبب نزيفاً أو تهيجاً لمرضى القرحة المعدية',
        en: 'Major: NSAIDs may cause gastric bleeding or irritation in patients with ulcers'
      },
      {
        condition: ['glaucoma'],
        ingredientMatch: (ing: string) => ing.includes('atropine') || ing.includes('hyoscine') || ing.includes('diphenhydramine'),
        severity: 'critical',
        ar: 'تحذير: مضادات الكولين قد ترفع ضغط العين بشكل خطر لمرضى الجلوكوما',
        en: 'Critical: Anticholinergics can dangerously increase intraocular pressure in glaucoma'
      }
    ];

    for (const rule of rules) {
      const hasCondition = rule.condition.some(c => condList.some(pc => pc.includes(c)));
      if (hasCondition) {
        if (ingredientList.some(rule.ingredientMatch)) {
          alerts.push({
            type: 'condition',
            severity: rule.severity,
            message_ar: rule.ar,
            message_en: rule.en
          });
        }
      }
    }

    return { success: true, alerts };
  } catch (error) {
    console.error('Clinical safety check error:', error);
    return { success: false, error: 'فشل فحص السلامة السريرية' };
  }
}

/**
 * Get items with low stock (quantity < 10 or custom threshold)
 */
export async function getLowStockAction(threshold?: number, maxRows: number | null = 250) {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'can_view_low_stock') && !hasUserPermissionSync(user, 'can_view_restock'))) {
      return { success: false, error: 'غير مصرح' };
    }

    const defaultLimit = Number(threshold) > 0 ? Number(threshold) : 10;
    const pharmacyId = user.pharmacy_id || 'local_default';
    const resultLimit = maxRows === null ? null : Math.max(1, Math.floor(Number(maxRows) || 250));
    const quantityInLarge = getSalesQuantityInLargeSql({
      quantity: 'si.quantity_sold',
      unit: 'si.unit',
      mediumUnit: 'm.medium_unit',
      smallUnit: 'm.small_unit',
      largeFactor: 'COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1)',
      smallFactor: 'COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(m.medium_to_small, 0), 1)',
    });

    const items = await db.prepare(`
      WITH Params AS (
        SELECT ? AS pharmacy_id, ? AS default_limit
      ),
      ScopedEligibleDrugs AS (
        SELECT DISTINCT i.drug_id
        FROM inventory i
        CROSS JOIN Params p
        WHERE (i.pharmacy_id = p.pharmacy_id OR (i.pharmacy_id IS NULL AND p.pharmacy_id = 'local_default'))
          AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
      ),
      AnyInventoryDrugs AS (
        SELECT DISTINCT drug_id
        FROM inventory
      ),
      DrugStock AS (
        SELECT 
          i.drug_id,
          SUM(
            CASE
              WHEN COALESCE(stock_md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL
                THEN COALESCE(i.quantity, 0)
              ELSE 0
            END
          ) AS current_stock,
          MIN(
            CASE
              WHEN COALESCE(stock_md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL
                THEN i.local_selling_price
            END
          ) AS local_selling_price,
          MIN(
            CASE
              WHEN i.quantity > 0
                AND (COALESCE(stock_md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
                THEN i.expiry_date
            END
          ) AS nearest_expiry,
          MAX(
            CASE
              WHEN COALESCE(stock_md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL
                THEN i.barcode
            END
          ) AS lot_barcode
        FROM inventory i
        JOIN master_drugs stock_md ON stock_md.id = i.drug_id
        CROSS JOIN Params p
        WHERE (i.pharmacy_id = p.pharmacy_id OR (i.pharmacy_id IS NULL AND p.pharmacy_id = 'local_default'))
          AND i.quantity > 0
          AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
        GROUP BY i.drug_id
      ),
      MonthlySales AS (
        SELECT 
          si.drug_id,
          SUM(${quantityInLarge}) AS avg_monthly_usage
        FROM sales_items si
        JOIN sales_invoices inv ON si.invoice_id = inv.id
        JOIN master_drugs m ON m.id = si.drug_id
        CROSS JOIN Params p
        WHERE si.is_negative = 0 
          AND (inv.status IS NULL OR inv.status = '' OR inv.status IN ('completed', 'approved', 'delivered'))
          AND (inv.pharmacy_id = p.pharmacy_id OR (inv.pharmacy_id IS NULL AND p.pharmacy_id = 'local_default'))
          AND inv.created_at >= datetime('now', '-30 days')
        GROUP BY si.drug_id
      )
      SELECT
        COUNT(*) OVER() AS total_count,
       m.id,
        m.id AS drug_id,
        COALESCE(ds.current_stock, 0) AS current_stock,
        COALESCE(ds.current_stock, 0) AS quantity,
        COALESCE(ds.local_selling_price, m.official_price, 0) AS local_selling_price,
        ds.nearest_expiry AS expiry_date,
        m.trade_name,
        m.trade_name_en,
        m.active_ingredient,
        m.generic_name,
        m.manufacturer,
        m.category,
        COALESCE(NULLIF(m.barcode, ''), NULLIF(ds.lot_barcode, '')) AS barcode,
        COALESCE(m.official_price, 0) AS official_price,
        MAX(
          COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), p.default_limit),
          COALESCE(ms.avg_monthly_usage, 0)
        ) AS reorder_point,
        COALESCE(NULLIF(m.default_purchase_qty, 0), 1) AS default_purchase_qty,
        COALESCE(ms.avg_monthly_usage, 0) AS avg_monthly_usage,
        MAX(
          0,
          MAX(
            COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), p.default_limit),
            COALESCE(ms.avg_monthly_usage, 0)
          ) - COALESCE(ds.current_stock, 0)
        ) AS deficit,
        CASE 
          WHEN COALESCE(ds.current_stock, 0) <= 0 THEN 'out_of_stock'
          WHEN COALESCE(ds.current_stock, 0) <= (
            MAX(
              COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), p.default_limit),
              COALESCE(ms.avg_monthly_usage, 0)
            ) / 2
          ) THEN 'critical'
          ELSE 'low'
        END AS status
      FROM master_drugs m
      CROSS JOIN Params p
      LEFT JOIN ScopedEligibleDrugs sed ON m.id = sed.drug_id
      LEFT JOIN AnyInventoryDrugs aid ON m.id = aid.drug_id
      LEFT JOIN DrugStock ds ON m.id = ds.drug_id
      LEFT JOIN MonthlySales ms ON m.id = ms.drug_id
      WHERE COALESCE(m.stop_dealing, 0) = 0
        AND (sed.drug_id IS NOT NULL OR aid.drug_id IS NULL OR COALESCE(ms.avg_monthly_usage, 0) > 0)
        AND (
        (ds.current_stock IS NOT NULL AND ds.current_stock <= MAX(
          COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), p.default_limit),
          COALESCE(ms.avg_monthly_usage, 0)
        ))
        OR (ds.current_stock IS NULL AND (m.reorder_point > 0 OR m.min_limit > 0 OR ms.avg_monthly_usage > 0))
      )
      ORDER BY 
        CASE WHEN COALESCE(ds.current_stock, 0) <= 0 THEN 0 ELSE 1 END,
        deficit DESC,
        quantity ASC
      ${resultLimit === null ? '' : 'LIMIT ?'}
    `).all(...(resultLimit === null ? [pharmacyId, defaultLimit] : [pharmacyId, defaultLimit, resultLimit])) as any[];

    const totalCount = Number(items[0]?.total_count || 0);
    const data = items.map(({ total_count: _totalCount, ...item }) => item);
    return { success: true, data, totalCount };
  } catch (error) {
    console.error('Get low stock error:', error);
    return { success: false, error: 'فشل جلب الأصناف منخفضة المخزون' };
  }
}

// Pre-compiled prepared statements for alerts (cached at module level)
const _lowStockStmt = db.prepare(`
  SELECT m.id as id, m.id as drug_id,
         SUM(CASE WHEN COALESCE(m.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL THEN i.quantity ELSE 0 END) as quantity,
         'low_stock' as alert_type,
         m.trade_name, m.active_ingredient, m.manufacturer, m.trade_name_en
  FROM master_drugs m
  JOIN inventory i ON m.id = i.drug_id
  WHERE COALESCE(m.stop_dealing, 0) = 0
    AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
    AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
  GROUP BY m.id
  HAVING SUM(CASE WHEN COALESCE(m.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL THEN i.quantity ELSE 0 END)
    <= COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), 10)
  LIMIT 10
`);
const _expiringStmt = db.prepare(`
  SELECT i.id, i.drug_id, i.expiry_date, 'expiring' as alert_type,
         m.trade_name, m.active_ingredient, m.manufacturer, m.trade_name_en
  FROM inventory i
  JOIN master_drugs m ON i.drug_id = m.id
  WHERE i.expiry_date > ? AND i.expiry_date <= ? AND i.quantity > 0
    AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
  LIMIT 10
`);
const _expiredStmt = db.prepare(`
  SELECT i.id, i.drug_id, i.expiry_date, 'expired' as alert_type,
         m.trade_name, m.active_ingredient, m.manufacturer, m.trade_name_en
  FROM inventory i
  JOIN master_drugs m ON i.drug_id = m.id
  WHERE i.expiry_date <= ? AND i.quantity > 0
    AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
  LIMIT 10
`);

const _getAlertsData = unstable_cache(
  async (today: string, threeMonthsStr: string, pharmacyId: string) => {
    const lowStock = await _lowStockStmt.all(pharmacyId, pharmacyId) as any[];
    const expiring = await _expiringStmt.all(today, threeMonthsStr, pharmacyId, pharmacyId) as any[];
    const expired = await _expiredStmt.all(today, pharmacyId, pharmacyId) as any[];
    return { lowStock, expiring, expired };
  },
  ['inventory-alerts-by-pharmacy'],
  { revalidate: 60 } // Cache for 60 seconds — alerts don't need real-time precision
);

/**
 * Get unified inventory alerts (Low stock + Expiring soon)
 */
export async function getInventoryAlertsAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };
    const pharmacyId = normalizePharmacyId(user.pharmacy_id);

    if (isTauri) {
      // The dashboard header mounts on every route. These are private lot
      // records, not global catalog rows: desktop SQL in the renderer is
      // deliberately forbidden even for an authenticated session.
      if (!pharmacyId || pharmacyId === 'local_default') {
        return { success: false, error: 'ملكية المخزون غير موثقة لهذه الصيدلية' };
      }
      const { invoke } = await import('@tauri-apps/api/core');
      const native = await invoke<unknown>('read_inventory_alerts_native');
      const row = native && typeof native === 'object' && !Array.isArray(native)
        ? native as Record<string, unknown> : null;
      const counts = row?.counts && typeof row.counts === 'object' && !Array.isArray(row.counts)
        ? row.counts as Record<string, unknown> : null;
      const alerts = row?.alerts;
      const safeText = (text: unknown) => text === null || text === undefined ||
        (typeof text === 'string' && text.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(text));
      const countKeys = ['lowStock', 'expiring', 'expired', 'total'] as const;
      if (!row || row.actorId !== String(user.id) || row.pharmacyId !== pharmacyId ||
          !Array.isArray(alerts) || alerts.length > 30 || !counts ||
          countKeys.some(key => !Number.isSafeInteger(counts[key]) ||
            Number(counts[key]) < 0 || Number(counts[key]) > 30) ||
          Number(counts.total) !== alerts.length ||
          Number(counts.total) !== Number(counts.lowStock) + Number(counts.expiring) + Number(counts.expired) ||
          alerts.some(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return true;
            const record = item as Record<string, unknown>;
            return !['low_stock', 'expiring', 'expired'].includes(String(record.alert_type)) ||
              !['string', 'number'].includes(typeof record.id) || !String(record.id).trim() ||
              !Number.isSafeInteger(record.drug_id) || Number(record.drug_id) <= 0 ||
              typeof record.trade_name !== 'string' || !record.trade_name.trim() ||
              !safeText(record.trade_name) || !safeText(record.trade_name_en) ||
              !safeText(record.active_ingredient) || !safeText(record.manufacturer) ||
              (record.quantity !== null && record.quantity !== undefined &&
                (typeof record.quantity !== 'number' || !Number.isFinite(record.quantity) || record.quantity < 0)) ||
              (record.alert_type !== 'low_stock' &&
                (typeof record.expiry_date !== 'string' || !isBusinessDate(record.expiry_date)));
          }) ||
          alerts.filter(item => item.alert_type === 'low_stock').length !== Number(counts.lowStock) ||
          alerts.filter(item => item.alert_type === 'expiring').length !== Number(counts.expiring) ||
          alerts.filter(item => item.alert_type === 'expired').length !== Number(counts.expired)) {
        throw new Error('Invalid tenant-scoped native inventory alert projection');
      }
      return { success: true, data: { alerts, counts } };
    }

    const today = localDate();
    const threeMonthsLater = new Date();
    threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3);
    const threeMonthsStr = localDate(threeMonthsLater);

    const { lowStock, expiring, expired } = await _getAlertsData(today, threeMonthsStr, pharmacyId);

    // Queries already JOIN master_drugs - no cache enrichment needed
    const allAlerts = [...expired, ...expiring, ...lowStock];

    return { 
      success: true, 
      data: {
        alerts: allAlerts,
        counts: {
          lowStock: lowStock.length,
          expiring: expiring.length,
          expired: expired.length,
          total: allAlerts.length
        }
      }
    };
  } catch (error) {
    // The native exception may contain private SQL/lot/tenant data. The UI
    // already offers an explicit retry; do not emit sensitive payloads.
    if (!isTauri) console.error('Get inventory alerts error:', error);
    return { success: false, error: 'فشل جلب تنبيهات المخزون' };
  }
}

/**
 * Get full drug details for the DrugDetailsModal
 */
export async function getDrugDetailsFullAction(drugId: number | string) {
  try {
    const user = await getLocalSession();
    const canViewDrugDetails = !!user && (
      hasUserPermissionSync(user, 'can_view_stores')
      || hasUserPermissionSync(user, 'can_access_pos')
      || hasUserPermissionSync(user, 'can_view_purchases')
    );
    if (!canViewDrugDetails) {
      return { success: false, error: 'غير مصرح' };
    }
    const pharmacyId = normalizePharmacyId(user.pharmacy_id);

    // Get basic drug info
    const drug = await db.prepare(`
      SELECT * FROM master_drugs WHERE id = ?
    `).get(drugId) as any;

    if (!drug) {
      return { success: false, error: 'Drug not found' };
    }

    // Get min local selling price from active inventory batches
    const minPriceRow = await db.prepare(`
      SELECT MIN(local_selling_price) as local_price 
      FROM inventory 
      WHERE drug_id = ? AND quantity > 0
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(drugId, pharmacyId, pharmacyId) as { local_price: number | null };

    drug.min_price = minPriceRow?.local_price !== null && minPriceRow?.local_price !== undefined
      ? minPriceRow.local_price 
      : drug.official_price;

    // Parse units
    try {
      drug.units = JSON.parse(drug.units || '{}');
    } catch (e) {
      drug.units = { large: 'علبة', medium: 'شريط', small: 'قرص' };
    }

    // Get total stock
    const stockRow = await db.prepare(`
      SELECT SUM(quantity) as total
      FROM inventory
      WHERE drug_id = ?
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(drugId, pharmacyId, pharmacyId) as { total: number };
    drug.total_stock = stockRow?.total || 0;

    // Get expiry batches
    const batches = await db.prepare(`
      SELECT batch_number, expiry_date, quantity
      FROM inventory
      WHERE drug_id = ? AND quantity > 0
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
      ORDER BY expiry_date ASC
    `).all(drugId, pharmacyId, pharmacyId) as any[];

    const today = localDate();
    drug.expiry_batches = batches.map(b => ({
      ...b,
      is_expired: Boolean(b.expiry_date && b.expiry_date < today)
    }));

    // Get Consumption Stats (Last 6 months)
    const consumption = await db.prepare(`
      SELECT strftime('%Y', si.created_at, 'localtime') as year, strftime('%m', si.created_at, 'localtime') as month,
             SUM(
               CASE
                 WHEN si.unit IN ('medium', 'strip', 'شريط') OR si.unit = m.medium_unit
                   THEN si.quantity_sold / COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1)
                 WHEN si.unit IN ('small', 'unit', 'pill') OR si.unit = m.small_unit
                   THEN si.quantity_sold / (
                     COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(m.large_to_medium, 0), 1)
                     * COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(m.medium_to_small, 0), 1)
                   )
                 ELSE si.quantity_sold
               END
             ) as net_sales,
             COUNT(*) as transactions
      FROM sales_items si
      JOIN sales_invoices invoice ON invoice.id = si.invoice_id
      JOIN master_drugs m ON m.id = si.drug_id
      WHERE si.drug_id = ?
        AND (invoice.status IS NULL OR invoice.status = '' OR invoice.status IN ('completed', 'approved', 'delivered'))
        AND (invoice.pharmacy_id = ? OR (invoice.pharmacy_id IS NULL AND ? = 'local_default'))
      GROUP BY year, month
      ORDER BY year DESC, month DESC
      LIMIT 6
    `).all(drugId, pharmacyId, pharmacyId) as any[];
    drug.consumption_stats = consumption;

    // Get Conflicts (Interactions)
    let conflicts: any[] = [];
    if (drug.active_ingredient) {
      const ingredientParts = drug.active_ingredient
        .split(/[+,;]/)
        .map((p: string) => p.trim())
        .filter((p: string) => p.length > 0);

      const conflictingMap = new Map();

      for (const ingredient of ingredientParts) {
        const searchBase = ingredient.replace(/e$/i, '');
        const searchE = searchBase + 'e';

        const interactions = await db.prepare(`
          SELECT id, ingredient_a, ingredient_b, severity, description_ar, description_en
          FROM drug_interactions
          WHERE UPPER(ingredient_a) IN (UPPER(?), UPPER(?), UPPER(?)) 
             OR UPPER(ingredient_b) IN (UPPER(?), UPPER(?), UPPER(?))
             OR UPPER(ingredient_a) LIKE '%' || UPPER(?) || '%'
             OR UPPER(ingredient_b) LIKE '%' || UPPER(?) || '%'
        `).all(ingredient, searchBase, searchE, ingredient, searchBase, searchE, searchBase, searchBase) as any[];

        const conflictItems = interactions
          .filter((i: any) => i.severity !== 'food')
          .sort((a: any, b: any) => {
            const weight = (s: string) => s === 'major' ? 3 : s === 'moderate' ? 2 : 1;
            return weight(b.severity) - weight(a.severity);
          });

        for (const interaction of conflictItems) {
          if (conflictingMap.size >= 50) break;
          const isA = interaction.ingredient_a.toUpperCase() === ingredient.toUpperCase();
          const otherIngredient = isA ? interaction.ingredient_b : interaction.ingredient_a;

          const drugsWithOtherIngredient = await db.prepare(`
            SELECT id, trade_name, official_price, active_ingredient, manufacturer
            FROM master_drugs
            WHERE UPPER(active_ingredient) LIKE UPPER(?) AND id != ?
            LIMIT 10
          `).all(`%${otherIngredient}%`, drugId) as any[];

          for (const d of drugsWithOtherIngredient) {
            if (conflictingMap.size >= 50) break;
            if (!conflictingMap.has(d.id)) {
              conflictingMap.set(d.id, {
                ...d,
                interaction_id: interaction.id,
                severity: interaction.severity,
                description: interaction.description_ar || interaction.description_en,
                conflicting_ingredient: otherIngredient,
                source_ingredient: ingredient,
              });
            }
          }
        }
      }
      conflicts = Array.from(conflictingMap.values());
    }
    drug.conflicts = conflicts;

    // Get alternatives (same active ingredient + manually linked)
    const alternatives = await db.prepare(`
      SELECT md.id, md.trade_name, md.active_ingredient, md.official_price as min_price, md.manufacturer,
             (SELECT SUM(i.quantity)
                FROM inventory i
               WHERE i.drug_id = md.id
                 AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
             ) as total_stock
      FROM master_drugs md
      WHERE (md.active_ingredient = ? 
             AND md.active_ingredient IS NOT NULL 
             AND md.active_ingredient != '')
         OR md.id IN (
             SELECT alternative_id FROM drug_alternatives WHERE drug_id = ?
             UNION
             SELECT drug_id FROM drug_alternatives WHERE alternative_id = ?
         )
    `).all(pharmacyId, pharmacyId, drug.active_ingredient, drugId, drugId) as any[];
    
    // Filter out the current drug itself
    drug.alternatives = alternatives.filter(a => a.id !== drugId).slice(0, 10);
    
    // Get Supplier History
    const supplierHistory = hasUserPermissionSync(user, 'can_view_purchases')
      ? await db.prepare(`
          SELECT s.id as supplier_id, s.name_ar as supplier_name, pii.cost_price, pii.selling_price,
                 pii.tax_percent, pii.discount_percent, pi.invoice_date
          FROM purchase_invoice_items pii
          JOIN purchase_invoices pi ON pii.invoice_id = pi.id
          JOIN suppliers s ON pi.supplier_id = s.id
          WHERE pii.drug_id = ?
            AND (pi.pharmacy_id = ? OR (pi.pharmacy_id IS NULL AND ? = 'local_default'))
          ORDER BY pi.invoice_date DESC
        `).all(drugId, pharmacyId, pharmacyId)
      : [];
    drug.supplier_history = supplierHistory;

    return { success: true, data: drug };
  } catch (error: any) {
    console.error('getDrugDetailsFullAction Error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get all inventory items (replaces client-side dbSelect on Web)
 */
export async function getInventoryListAction(search?: string, drugId?: number) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_stores')) {
      return { success: false, error: 'غير مصرح' };
    }
    const pharmacyId = normalizePharmacyId(user.pharmacy_id);
    const inventoryFilter = drugId === undefined ? 'i.quantity > 0' : '(i.drug_id = ? AND i.quantity > 0)';

    let queryStr = `
      SELECT 
        i.id,
        i.drug_id,
        i.quantity,
        i.expiry_date,
        i.local_selling_price,
        i.cost_price,
        i.strips_per_box,
        COALESCE(NULLIF(i.barcode, ''), NULLIF(m.barcode, '')) AS barcode,
        i.barcode AS lot_barcode,
        m.barcode AS drug_barcode,
        m.trade_name,
        m.trade_name_en,
        m.generic_name,
        m.active_ingredient,
        m.category,
        m.manufacturer,
        m.large_to_medium
      FROM inventory i
      JOIN master_drugs m ON i.drug_id = m.id
      WHERE ${inventoryFilter}
        AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
    `;
    const params: any[] = drugId === undefined
      ? [pharmacyId, pharmacyId]
      : [drugId, pharmacyId, pharmacyId];

    if (drugId === undefined && search && search.trim().length > 0) {
      const trimmed = search.trim();
      const sanitizedFts = trimmed.replace(/["'*^()?:[\]{}]/g, ' ').trim();
      const ftsQuery = sanitizedFts
        ? sanitizedFts.split(/\s+/).filter(Boolean).map(t => `"${t}"*`).join(' ')
        : '';
      const prefixPattern = `${trimmed}%`;
      const likePattern = `%${trimmed}%`;

      let useFts = false;
      if (ftsQuery && !isTauri) {
        try {
          await db.prepare('SELECT rowid FROM master_drugs_fts WHERE master_drugs_fts MATCH ? LIMIT 1').get(ftsQuery);
          useFts = true;
        } catch {
          useFts = false;
        }
      }

      if (useFts) {
        queryStr += `
          AND (
            i.barcode = ?
            OR m.barcode = ?
            OR m.id IN (SELECT rowid FROM master_drugs_fts WHERE master_drugs_fts MATCH ?)
            OR m.trade_name LIKE ?
            OR m.trade_name_en LIKE ?
          )
        `;
        params.push(trimmed, trimmed, ftsQuery, prefixPattern, prefixPattern);
      } else {
        queryStr += `
          AND (
            i.barcode = ? 
            OR m.barcode = ?
            OR m.trade_name LIKE ? 
            OR m.trade_name_en LIKE ?
            OR m.generic_name LIKE ?
            OR m.active_ingredient LIKE ?
          )
        `;
        params.push(trimmed, trimmed, likePattern, likePattern, likePattern, likePattern);
      }
    }

    // ponytail: client paging needs every matching lot for correct totals; use SQL paging + aggregates if volumes demand it.
    queryStr += ` ORDER BY i.expiry_date ASC`;

    // A release build denies arbitrary renderer reads of inventory. Native
    // scoped reads use the database-authenticated pharmacy and role instead of
    // trusting the frontend WHERE predicate or user-provided tenant ID.
    const data = isTauri
      ? await dbReadScopedAll('inventory.enriched', {
          search: drugId === undefined ? search : null,
          drugId: drugId ?? null,
        }) as any[]
      : await db.prepare(queryStr).all(...params) as any[];

    // Query already JOINs master_drugs - no cache enrichment needed
    const mapped = data.map((item: any) => ({
      ...item,
      barcode: item.barcode || item.lot_barcode || item.drug_barcode || '',
      master_drugs: {
        trade_name: item.trade_name,
        trade_name_en: item.trade_name_en || item.trade_name || '',
        active_ingredient: item.active_ingredient || item.generic_name || '---',
        category: item.category || '',
        manufacturer: item.manufacturer || '',
        large_to_medium: item.large_to_medium || 1,
        barcode: item.drug_barcode || item.barcode || ''
      }
    }));

    return { success: true, data: mapped };
  } catch (error: any) {
    console.error('getInventoryListAction Error:', error);
    return { success: false, error: error.message };
  }
}


/** No raw renderer SQL, user ID or pharmacy ID crosses this native boundary. */
async function readNativeInventoryHistory(
  queryId: 'inventory.movements' | 'inventory.opening_balances'
): Promise<any[]> {
  const { invoke } = await import('@tauri-apps/api/core');
  const pageSize = 200;
  const rows: any[] = [];
  let readActor: string | undefined;
  let readPharmacy: string | undefined;
  for (let offset = 0; offset <= 50_000; offset += pageSize) {
    const page = await invoke<{ actorId: string; pharmacyId: string; rows: any[] }>('db_read_inventory_history', {
      queryId,
      limit: pageSize,
      offset,
    });
    if (!page || typeof page.actorId !== 'string' || !page.actorId
        || typeof page.pharmacyId !== 'string' || !page.pharmacyId
        || !Array.isArray(page.rows) || page.rows.length > pageSize) {
      throw new Error('Invalid native inventory history page');
    }
    if (readActor !== undefined && (page.actorId !== readActor || page.pharmacyId !== readPharmacy)) {
      throw new Error('Inventory history read scope changed during pagination');
    }
    readActor = page.actorId;
    readPharmacy = page.pharmacyId;
    rows.push(...page.rows);
    if (page.rows.length < pageSize) return rows;
  }
  throw new Error('Inventory history exceeds the native page window; a streamed export is required');
}

export async function getMovementsAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'preview_item_movements')) {
      return { success: false, error: 'غير مصرح', data: [] };
    }
    const pharmacyId = user.pharmacy_id || 'local_default';
    const data = isTauri
      ? await readNativeInventoryHistory('inventory.movements')
      : await db.prepare(`
      SELECT al.*, COALESCE(u.full_name, u.username, al.user_id, 'غير محدد') AS user_name,
             u.username
      FROM activity_log al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE al.action IN (
        'ADD_INVENTORY', 'UPDATE_INVENTORY', 'DELETE_INVENTORY', 'ADJUST_STOCK', 'STOCK_ADJUSTMENT', 'ZERO_INVENTORY',
        'OPENING_BALANCE',
        'SALE', 'COMPLETE_SALE',
        'RETURN', 'CREATE_RETURN',
        'PURCHASE', 'COMPLETE_PURCHASE',
        'PURCHASE_RETURN'
      )
        AND (al.pharmacy_id = ? OR (al.pharmacy_id IS NULL AND ? = 'local_default'))
      ORDER BY al.created_at DESC
    `).all(pharmacyId, pharmacyId) as any[];
    return { success: true, data };
  } catch (error: any) {
    return { success: false, error: error?.message || 'فشل تحميل حركات الأصناف', data: [] };
  }
}
export async function getOpeningBalancesAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_opening_balances')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = normalizePharmacyId(user.pharmacy_id);

    const data = isTauri
      ? await readNativeInventoryHistory('inventory.opening_balances')
      : await db.prepare(`
      SELECT i.*, md.trade_name, md.trade_name_en
      FROM inventory i
      JOIN master_drugs md ON i.drug_id = md.id
      WHERE i.batch_number LIKE 'OPEN-%'
        AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
      ORDER BY i.created_at DESC
    `).all(pharmacyId, pharmacyId) as any[];
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message || (typeof err === 'string' ? err : 'Error fetching balances') };
  }
}

export async function addOpeningBalanceAction(data: {
  drug_id: number;
  quantity: number;
  cost_price: number;
  unit_price: number;
  expiry_date?: string | null;
}) {
  try {
    const session = await getLocalSession();
    if (!session || (!hasUserPermissionSync(session, 'can_view_opening_balances') && !hasUserPermissionSync(session, 'can_manage_inventory'))) {
      return { success: false, error: 'Unauthorized' };
    }
    if (!Number.isFinite(data.quantity) || data.quantity <= 0
        || !Number.isFinite(data.cost_price) || data.cost_price < 0
        || !Number.isFinite(data.unit_price) || data.unit_price < 0) {
      return { success: false, error: 'بيانات الرصيد الافتتاحي غير صالحة' };
    }

    if (isTauri) {
      // Native command owns actor, pharmacy, validation and the entire
      // stock + journal + activity + recovered-shortages transaction.
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('add_opening_balance_critical', {
        payload: {
          drug_id: data.drug_id,
          quantity: data.quantity,
          cost_price: data.cost_price,
          unit_price: data.unit_price,
          expiry_date: data.expiry_date ?? null,
        },
      });
      revalidatePath('/inventory');
      revalidatePath('/inventory/opening-balances');
      notifyInventoryChanged();
      return { success: true };
    }

    const batchNumber = 'OPEN-' + generateId().substring(0, 8);
    const drug = await db.prepare(`
      SELECT COALESCE(NULLIF(large_to_medium, 0), 1) AS large_to_medium,
             COALESCE(NULLIF(medium_to_small, 0), 1) AS medium_to_small,
             COALESCE(has_expiry, 1) AS has_expiry,
             COALESCE(trade_name_en, trade_name, active_ingredient) AS trade_name
      FROM master_drugs
      WHERE id = ?
    `).get(data.drug_id) as any;
    if (!drug) return { success: false, error: 'الصنف غير موجود' };
    const expiryDate = typeof data.expiry_date === 'string' && data.expiry_date.trim() ? data.expiry_date : null;
    const requiresExpiry = Number(drug.has_expiry ?? 1) !== 0;
    if ((requiresExpiry && !expiryDate) || (expiryDate && !isBusinessDate(expiryDate))) {
      return { success: false, error: 'بيانات الرصيد الافتتاحي غير صالحة' };
    }

    await dbTransaction(async (db) => {
      await db.prepare(`
        INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, expiry_date, quantity, local_selling_price, cost_price, strips_per_box, medium_to_small)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        generateId(), session.pharmacy_id || 'local_default', data.drug_id, batchNumber, expiryDate,
        data.quantity, data.unit_price, data.cost_price, Number(drug.large_to_medium) || 1, Number(drug.medium_to_small) || 1
      );

      const amount = Number(data.quantity) * Number(data.cost_price);
      if (amount > 0.000001) {
        const inventorySetting = await db.prepare("SELECT account_id FROM trial_balance_settings WHERE category = 'inventory_asset' LIMIT 1").get() as any;
        const equitySetting = await db.prepare("SELECT account_id FROM trial_balance_settings WHERE category = 'opening_balance_equity' LIMIT 1").get() as any;
        const journalId = generateId();
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(journalId, localDate(), `رصيد افتتاحي للمخزون: ${drug.trade_name || `صنف #${data.drug_id}`} (${batchNumber})`, session.id, amount);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, Number(inventorySetting?.account_id || 10), 'debit', amount);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, Number(equitySetting?.account_id || 21), 'credit', amount);
      }

      await db.prepare('INSERT INTO activity_log (user_id, action, details, pharmacy_id) VALUES (?, ?, ?, ?)').run(
        session.id,
        'OPENING_BALANCE',
        `رصيد افتتاحي ${data.quantity} من ${drug.trade_name || `صنف #${data.drug_id}`} (${batchNumber})`,
        session.pharmacy_id || 'local_default'
      );

      await resolveRecoveredShortages(db, data.drug_id, session.pharmacy_id || 'local_default');
    });

    revalidatePath('/inventory');
    revalidatePath('/inventory/opening-balances');
    notifyInventoryChanged();
    return { success: true };
  } catch (err: any) {
    console.error('addOpeningBalance error:', err);
    return { success: false, error: err.message || (typeof err === 'string' ? err : 'Error saving balance') };
  }
}
export async function getRestockItemsAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_restock')) return { success: false, error: 'غير مصرح' };

    const lowStockRes = await getLowStockAction(10);
    if (!lowStockRes.success) return { success: false, data: [] };

    const items = (lowStockRes.data || []).map((item: any) => {
      const suggestedOrder = Math.max(
        Number(item.default_purchase_qty || 1),
        Number(item.deficit || 1),
        Math.ceil(Number(item.avg_monthly_usage || 0))
      );

      return {
        id: String(item.id),
        drug_id: item.drug_id,
        quantity: item.quantity,
        min_stock_level: item.reorder_point,
        suggested_order: suggestedOrder,
        master_drugs: {
          id: item.drug_id,
          trade_name: item.trade_name_en || item.trade_name,
          trade_name_ar: item.trade_name,
          official_price: item.official_price || item.local_selling_price || 0,
          category: item.category || '',
          manufacturer: item.manufacturer || '',
          barcode: item.barcode || ''
        }
      };
    });

    return { success: true, data: items };
  } catch (error: any) {
    console.error('getRestockItemsAction error:', error);
    return { success: false, error: error.message };
  }
}
export async function getAdjustmentsAction() {
  const { getAdjustmentReasonsAction } = await import('./master-drugs');
  return getAdjustmentReasonsAction();
}
export async function getUnusedDrugsAction() {
  const { getUnusedItemsAction } = await import('./master-drugs');
  return getUnusedItemsAction();
}

export async function deleteDrugAction(id: number) {
  const { deleteMasterDrugAction } = await import('./master-drugs');
  return deleteMasterDrugAction(id);
}
