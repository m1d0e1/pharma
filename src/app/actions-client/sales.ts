
import { dbSelect, dbExecute, dbGet, dbTransaction, generateId } from '@/lib/db/tauri';
import { ensurePermanentShiftForUser, getShiftForPharmacy } from './shifts';
import { notifyInventoryChanged } from '@/lib/inventory/refresh';
import { resolveDrugUnitProfile } from '@/lib/inventory/unit-profile';
const logActivity = async (userId: string, action: string, details: string) => {
  try {
    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
};

function normalizeDateToYMD(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  dateStr = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  let match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  match = dateStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = dateStr.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (match) return `${match[2]}-${match[1].padStart(2, '0')}-01`;
  return dateStr;
}

const db = {
  prepare: (sql: string) => ({
    all: (...p: any[]) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbSelect(sql, args);
    },
    get: (...p: any[]) => {
      const args = p.length === 1 && Array.isArray(p[0]) ? p[0] : p;
      return dbGet(sql, args);
    },
    run: async (...p: any[]) => {
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
  transaction: (cb: (...args: any[]) => any) => {
    return (...args: any[]) => dbTransaction(async (transactionDb) => await cb(transactionDb, ...args));
  },
  exec: (sql: string) => {
    return dbExecute(sql);
  }
};

import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { z } from 'zod';
import { format } from 'date-fns';
import { secureCache } from '@/lib/cache/secure_cache';
import { getSearchVariants, matchesDrug, calculateDrugRelevance } from '@/lib/search/normalization';
import { calculateCheckoutTotal, calculateLoyaltyPoints } from '@/lib/pos/checkout-calculation';
import { isTauri } from '@/lib/env';
import {
  patientOutstandingBalanceExpression,
  patientOutstandingBalanceQuery,
} from '@/lib/patients/balance';
import { normalizeUtcTimestamp } from '@/lib/time';
import { EGP_PER_REDEEMED_POINT, MIN_REDEEM_POINTS, loyaltyDiscountAmount } from '@/lib/loyalty/policy';

const CheckoutItemSchema = z.object({
  drug_id: z.coerce.number(),
  inventory_id: z.string().optional().nullable(),
  quantity_sold: z.coerce.number().positive(),
  unit_price: z.coerce.number().nonnegative(),
  item_discount_percent: z.coerce.number().min(0).max(100).optional().default(0),
  selected_unit: z.string().default('large'),
  is_negative: z.boolean().optional().default(false)
});

const CheckoutRequestSchema = z.object({
  items: z.array(CheckoutItemSchema).min(1),
  patient_id: z.union([z.string(), z.number(), z.null()]).optional().nullable(),
  shift_id: z.union([z.string(), z.number(), z.null()]).optional().nullable(),
  source_draft_id: z.union([z.string(), z.null()]).optional().nullable(),
  payment_method: z.enum(['cash', 'credit', 'check', 'visa', 'delivery', 'wallet']).default('cash'),
  check_number: z.string().optional().nullable(),
  status: z.enum(['completed', 'draft']).default('completed'),
  total_discount: z.coerce.number().nonnegative().optional().default(0),
  additional_fees: z.coerce.number().nonnegative().optional().default(0),
  points_to_redeem: z.coerce.number().int().nonnegative().optional().default(0),
});

function saleStockQty(quantity: number, unit: string, largeToMedium: number, mediumToSmall: number, mediumUnit?: string, smallUnit?: string) {
  if (unit === 'medium' || unit === 'strip' || unit === 'شريط' || unit === mediumUnit) return quantity / largeToMedium;
  if (unit === 'small' || unit === smallUnit) return quantity / (largeToMedium * mediumToSmall);
  return quantity;
}

function canUsePos(user: any): boolean {
  return !!user && hasUserPermissionSync(user, 'can_access_pos');
}

function sourceDraftValidationError(sourceDraft: any, pharmacyId: string): string | null {
  if (!sourceDraft) return 'الفاتورة المعلقة المحددة غير موجودة';
  const sourcePharmacy = sourceDraft.pharmacy_id || 'local_default';
  if (sourcePharmacy !== pharmacyId) return 'الفاتورة المعلقة تتبع صيدلية أخرى';
  if (sourceDraft.status !== 'draft') return 'الفاتورة المحددة لم تعد فاتورة معلقة';
  return null;
}

function permissionNumber(user: any, key: string, fallback = 0): number {
  let values = user?.permissions;
  try { if (typeof values === 'string') values = JSON.parse(values); } catch { return fallback; }
  const value = values && !Array.isArray(values) ? values[key] : undefined;
  return Number(value ?? (user?.role === 'owner' ? 100 : fallback)) || fallback;
}

async function validateCheckoutPrices(items: z.infer<typeof CheckoutItemSchema>[], pharmacyId: string) {
  for (const item of items) {
    const priceRow = item.inventory_id
      ? await db.prepare(`
          SELECT COALESCE(i.local_selling_price, md.official_price, 0) AS large_price,
                 COALESCE(NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium,
                 COALESCE(NULLIF(i.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1) AS medium_to_small,
                 md.medium_unit, md.small_unit
          FROM inventory i
          JOIN master_drugs md ON md.id = i.drug_id
          WHERE i.id = ? AND i.drug_id = ?
            AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
            AND i.quantity > 0
            AND (COALESCE(md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
            AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
        `).get(item.inventory_id, item.drug_id, pharmacyId, pharmacyId) as any
      : await db.prepare(`
          SELECT COALESCE(MIN(i.local_selling_price), md.official_price, 0) AS large_price,
                 COALESCE(NULLIF(MAX(i.strips_per_box), 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium,
                 COALESCE(NULLIF(MAX(i.medium_to_small), 0), NULLIF(md.medium_to_small, 0), 1) AS medium_to_small,
                 md.medium_unit, md.small_unit
          FROM master_drugs md
          LEFT JOIN inventory i ON i.drug_id = md.id
            AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
            AND i.quantity > 0
            AND (COALESCE(md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
            AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
          WHERE md.id = ?
          GROUP BY md.id
        `).get(pharmacyId, pharmacyId, item.drug_id) as any;

    if (!priceRow) return false;
    const largeToMedium = Math.max(1, Number(priceRow.large_to_medium) || 1);
    const mediumToSmall = Math.max(1, Number(priceRow.medium_to_small) || 1);
    let expectedPrice = Number(priceRow.large_price) || 0;
    if (['medium', 'strip', 'شريط', priceRow.medium_unit].includes(item.selected_unit)) {
      expectedPrice /= largeToMedium;
    } else if (['small', priceRow.small_unit].includes(item.selected_unit)) {
      expectedPrice /= largeToMedium * mediumToSmall;
    }
    expectedPrice *= 1 - (Number(item.item_discount_percent) || 0) / 100;
    if (Math.abs(expectedPrice - Number(item.unit_price)) > 0.011) return false;
  }
  return true;
}

export async function searchDrugsAction(searchTerm: string, limit = 20, searchByActiveIngredient = false) {
  try {
    const localUser = await getLocalSession();
    const pharmacyId = localUser?.pharmacy_id || 'local_default';
    if (!canUsePos(localUser)) return { success: false, error: 'غير مصرح' };

    if (!searchTerm || searchTerm.trim().length === 0) {
      return { success: true, data: [] };
    }

    let exactMatch: any = null;
    const searchLower = searchTerm.toLowerCase().trim();
    
    let allDrugs: any[] = [];
    try {
      await secureCache.load();
      allDrugs = secureCache.getAllDrugs();
    } catch (cacheErr) {
      console.warn('secureCache unavailable in searchDrugsAction, searching DB only:', cacheErr);
    }
    const variants = getSearchVariants(searchLower);
    const cacheMatched = allDrugs.filter((d: any) => {
      if (Number(d.stop_dealing) === 1) return false;
      const match = matchesDrug(d, variants, searchByActiveIngredient);
      if (d.barcode === searchLower || d.id.toString() === searchLower) exactMatch = d;
      return match;
    });

    // Search custom drugs in SQLite db
    const textConditions: string[] = [];
    const dbParams: any[] = [];
    for (const term of variants.searchTerms) {
      const pattern = `%${term}%`;
      if (searchByActiveIngredient) {
        textConditions.push('(active_ingredient LIKE ? OR generic_name LIKE ?)');
        dbParams.push(pattern, pattern);
      } else {
        textConditions.push('(trade_name LIKE ? OR trade_name_en LIKE ? OR barcode = ?)');
        dbParams.push(pattern, pattern, term);
      }
    }
    if (variants.compactQuery && variants.compactQuery.length >= 2) {
      const compactPattern = `%${variants.compactQuery}%`;
      textConditions.push('(trade_name LIKE ? OR trade_name_en LIKE ?)');
      dbParams.push(compactPattern, compactPattern);
    }
    if (!searchByActiveIngredient) {
      textConditions.push('EXISTS (SELECT 1 FROM inventory barcode_lot WHERE barcode_lot.drug_id = master_drugs.id AND barcode_lot.barcode = ? COLLATE NOCASE)');
      dbParams.push(searchLower);
    }

    const whereClause = textConditions.length > 0 ? `(${textConditions.join(' OR ')})` : '1=1';
    const dbQuery = `
      SELECT * FROM master_drugs 
      WHERE ${whereClause}
        AND COALESCE(stop_dealing,0)=0
        AND (trade_name IS NULL OR trade_name != 'SECURE')
        AND (trade_name_en IS NULL OR trade_name_en != 'SECURE')
      LIMIT 100
    `;

    const dbMatched = await db.prepare(dbQuery).all(...dbParams) as any[];

    // Combine both and remove duplicates
    const combinedMap = new Map<string, any>();
    
    // Find exact match in dbMatched
    let exactDbMatch = dbMatched.find((d: any) => d.barcode === searchLower || d.id.toString() === searchLower);

    if (exactMatch) {
      combinedMap.set(String(exactMatch.id), exactMatch);
    } else if (exactDbMatch) {
      combinedMap.set(String(exactDbMatch.id), exactDbMatch);
    }

    for (const item of cacheMatched) {
      if (!combinedMap.has(String(item.id))) {
        combinedMap.set(String(item.id), item);
      }
    }

    for (const item of dbMatched) {
      if (!combinedMap.has(String(item.id))) {
        combinedMap.set(String(item.id), item);
      }
    }

    const rawMatchedDrugs = Array.from(combinedMap.values());
    if (rawMatchedDrugs.length === 0) return { success: true, data: [] };

    // Fetch inventory aggregates for candidates to check stock (limit to 500 to avoid SQL variable limit)
    const candidates = rawMatchedDrugs.slice(0, 500);
    const candidateIds = candidates.map((d: any) => d.id);
    const placeholders = candidateIds.map(() => '?').join(',');
    const today = format(new Date(), 'yyyy-MM-dd');

    const inventoryAgg = await db.prepare(`
      SELECT drug_id, 
             COALESCE(SUM(quantity), 0) as total_stock,
             MIN(local_selling_price) as min_price,
             AVG(cost_price) as avg_cost_price,
             MIN(expiry_date) as nearest_expiry,
             MAX(strips_per_box) as max_strips
      FROM inventory
      WHERE drug_id IN (${placeholders})
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        AND quantity > 0
        AND (
          COALESCE((SELECT md.has_expiry FROM master_drugs md WHERE md.id = inventory.drug_id), 1) = 0
          OR expiry_date IS NOT NULL
        )
        AND (expiry_date IS NULL OR expiry_date >= ?)
      GROUP BY drug_id
    `).all(...candidateIds, pharmacyId, pharmacyId, today) as any[];

    // Calculate score for each candidate (add +1000 if it has stock in inventory)
    const scoredCandidates = candidates.map((drug: any) => {
      const inv = (inventoryAgg as any[]).find((i: any) => String(i.drug_id) === String(drug.id)) || {};
      const hasStock = (inv.total_stock || 0) > 0;
      let score = getRelevanceScore(drug, searchLower);
      if (hasStock) {
        score += 1000;
      }
      return { drug, score, inv };
    });

    // Sort by score and slice to final limit
    scoredCandidates.sort((a, b) => b.score - a.score);
    const finalSelection = scoredCandidates.slice(0, limit);

    const matchedIds = finalSelection.map((item) => item.drug.id);
    const matchedPlaceholders = matchedIds.map(() => '?').join(',');

    const batchesData = matchedIds.length > 0 ? await db.prepare(`
      SELECT id as inventory_id, drug_id, quantity, expiry_date, local_selling_price, cost_price, strips_per_box, medium_to_small
      FROM inventory
      WHERE drug_id IN (${matchedPlaceholders})
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        AND quantity > 0
        AND (
          COALESCE((SELECT md.has_expiry FROM master_drugs md WHERE md.id = inventory.drug_id), 1) = 0
          OR expiry_date IS NOT NULL
        )
        AND (expiry_date IS NULL OR expiry_date >= ?)
      ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, created_at ASC
    `).all(...matchedIds, pharmacyId, pharmacyId, today) as any[] : [];

    const data = finalSelection.map((item: any) => {
      const drug = item.drug;
      const inv = item.inv;
      const rawLargeToMedium = inv.max_strips > 1 ? inv.max_strips : (drug.large_to_medium || 1);
      const unitProfile = resolveDrugUnitProfile({ ...drug, large_to_medium: rawLargeToMedium });
      const actualLargeToMedium = unitProfile.largeToMedium;
      const drugBatches = batchesData.filter((b: any) => String(b.drug_id) === String(drug.id)).map((b: any) => ({
        inventory_id: b.inventory_id,
        quantity: b.quantity,
        expiry_date: b.expiry_date ? normalizeDateToYMD(b.expiry_date) : null,
        unit_price: b.local_selling_price || drug.official_price,
        strips_per_box: unitProfile.isSingleContainer
          ? 1
          : (Number(b.strips_per_box) > 0 ? Number(b.strips_per_box) : (drug.large_to_medium || 1)),
        medium_to_small: unitProfile.isSingleContainer
          ? 1
          : (Number(b.medium_to_small) > 0 ? Number(b.medium_to_small) : (drug.medium_to_small || 1))
      }));
      return {
        id: drug.id,
        trade_name: drug.trade_name_en || drug.trade_name || 'بدون اسم تجاري',
        active_ingredient: drug.active_ingredient || drug.generic_name || '---',
        category: drug.category,
        official_price: drug.official_price,
        total_stock: inv.total_stock || 0,
        min_price: inv.min_price || drug.official_price,
        cost_price: inv.avg_cost_price || 0,
        nearest_expiry: inv.nearest_expiry,
        is_expired: inv.nearest_expiry ? (normalizeDateToYMD(inv.nearest_expiry) || '') < today : false,
        large_unit: unitProfile.largeUnit,
        medium_unit: unitProfile.mediumUnit,
        small_unit: unitProfile.smallUnit,
        large_to_medium: actualLargeToMedium,
        medium_to_small: unitProfile.mediumToSmall,
        reorder_point: drug.reorder_point || 0,
        profit_margin: (inv.min_price && inv.avg_cost_price > 0)
          ? Math.round(((inv.min_price - inv.avg_cost_price) / inv.min_price) * 100)
          : null,
        needs_reorder: drug.reorder_point ? (inv.total_stock || 0) <= drug.reorder_point : false,
        batches: drugBatches,
        units: {
          large: unitProfile.largeUnit,
          medium: unitProfile.mediumUnit,
          small: unitProfile.smallUnit,
          large_to_medium: actualLargeToMedium,
          medium_to_small: unitProfile.mediumToSmall
        }
      };
    });
    return { success: true, data };
  } catch (error) {
    console.error('Drug search error:', error);
    return { success: false, error: 'فشل البحث' };
  }
}

export async function searchPatientsAction(query: string) {
  try {
    const localUser = await getLocalSession();
    if (!canUsePos(localUser)) return { success: false, error: 'غير مصرح' };

    if (!query || query.length < 2) {
      return { success: true, data: [] };
    }

    const searchPattern = `%${query}%`;
    const patients = await db.prepare(`
      SELECT
        p.id,
        p.full_name,
        p.phone,
        p.credit_limit,
        p.wallet_balance,
        p.opening_balance,
        p.points_balance,
        p.payment_method,
        CAST(${patientOutstandingBalanceExpression('p')} AS REAL) AS outstanding_balance
      FROM patients p
      WHERE (p.full_name LIKE ? OR p.phone LIKE ?)
      LIMIT 5
    `).all(searchPattern, searchPattern) as any[];

    return { success: true, data: patients };
  } catch (error: any) {
    console.error('Patient search action error:', error);
    return { success: false, error: 'فشل البحث عن المرضى' };
  }
}

export async function barcodeLookupAction(barcode: string) {
  try {
    const localUser = await getLocalSession();
    const pharmacyId = localUser?.pharmacy_id || 'local_default';
    if (!canUsePos(localUser)) return { success: false, error: 'غير مصرح' };

    const normalizedBarcode = String(barcode || '').trim();
    if (!normalizedBarcode) {
      return { success: false, error: 'الباركود مطلوب' };
    }

    const today = format(new Date(), 'yyyy-MM-dd');
    const matchingDrugs = await db.prepare(`
      SELECT DISTINCT md.id
      FROM master_drugs md
      INNER JOIN inventory i ON md.id = i.drug_id
      WHERE (i.barcode = ? COLLATE NOCASE OR md.barcode = ? COLLATE NOCASE)
        AND COALESCE(md.stop_dealing,0)=0
        AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
        AND i.quantity > 0
        AND (COALESCE(md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
        AND (i.expiry_date IS NULL OR i.expiry_date >= ?)
      LIMIT 2
    `).all(normalizedBarcode, normalizedBarcode, pharmacyId, pharmacyId, today) as any[];

    const matchingDrugIds = new Set(matchingDrugs.map(item => item.id).filter(id => id !== null && id !== undefined));
    if (matchingDrugIds.size > 1) {
      return { success: false, error: 'الباركود مرتبط بأكثر من صنف؛ يرجى تصحيحه من إدارة الأصناف' };
    }

    const drug = await db.prepare(`
      SELECT
        md.id,
        md.trade_name,
        md.trade_name_en,
        md.generic_name,
        md.active_ingredient,
        md.category,
        md.official_price,
        md.large_unit,
        md.medium_unit,
        md.small_unit,
        md.large_to_medium,
        md.medium_to_small,
        md.reorder_point,
        i.local_selling_price as unit_price,
        i.cost_price as avg_cost_price,
        i.quantity,
        i.expiry_date as nearest_expiry,
        i.strips_per_box,
        i.id as inventory_id
      FROM master_drugs md
      INNER JOIN inventory i ON md.id = i.drug_id
      WHERE (i.barcode = ? COLLATE NOCASE OR md.barcode = ? COLLATE NOCASE)
        AND COALESCE(md.stop_dealing,0)=0
        AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
        AND i.quantity > 0
        AND (COALESCE(md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
        AND (i.expiry_date IS NULL OR i.expiry_date >= ?)
      ORDER BY CASE WHEN i.expiry_date IS NULL THEN 1 ELSE 0 END, i.expiry_date ASC, i.created_at ASC
      LIMIT 1
    `).get(normalizedBarcode, normalizedBarcode, pharmacyId, pharmacyId, today) as any;

    if (!drug) {
      return { success: true, data: null };
    }

    const rawLargeToMedium = drug.strips_per_box > 1 ? drug.strips_per_box : (drug.large_to_medium || 1);
    const unitProfile = resolveDrugUnitProfile({ ...drug, large_to_medium: rawLargeToMedium });
    const actualLargeToMedium = unitProfile.largeToMedium;

    const drugBatches = await db.prepare(`
      SELECT id as inventory_id, quantity, expiry_date, local_selling_price, cost_price, strips_per_box, medium_to_small
      FROM inventory
      WHERE drug_id = ?
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
        AND quantity > 0
        AND (
          COALESCE((SELECT md.has_expiry FROM master_drugs md WHERE md.id = inventory.drug_id), 1) = 0
          OR expiry_date IS NOT NULL
        )
        AND (expiry_date IS NULL OR expiry_date >= ?)
      ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, created_at ASC
    `).all(drug.id, pharmacyId, pharmacyId, today) as any[];
    const totalStock = drugBatches.reduce((sum: number, batch: any) => sum + Number(batch.quantity || 0), 0);

    const data = {
      id: drug.id,
      trade_name: drug.trade_name_en || drug.trade_name || drug.generic_name || 'غير معروف',
      active_ingredient: drug.active_ingredient || drug.generic_name || '---',
      category: drug.category,
      official_price: drug.official_price,
      unit_price: drug.unit_price,
      quantity: totalStock,
      inventory_id: drug.inventory_id,
      cost_price: drug.avg_cost_price || 0,
      nearest_expiry: drug.nearest_expiry,
      is_expired: drug.nearest_expiry ? (normalizeDateToYMD(drug.nearest_expiry) || '') < today : false,
      reorder_point: drug.reorder_point || 0,
      needs_reorder: drug.reorder_point ? totalStock <= drug.reorder_point : false,
      profit_margin: drug.unit_price && drug.avg_cost_price > 0 
        ? Math.round(((drug.unit_price - drug.avg_cost_price) / drug.unit_price) * 100) 
        : null,
      units: {
        large: unitProfile.largeUnit,
        medium: unitProfile.mediumUnit,
        small: unitProfile.smallUnit,
        large_to_medium: actualLargeToMedium,
        medium_to_small: unitProfile.mediumToSmall
      },
      batches: drugBatches.map((b: any) => ({
        inventory_id: b.inventory_id,
        quantity: b.quantity,
        expiry_date: b.expiry_date ? normalizeDateToYMD(b.expiry_date) : null,
        unit_price: b.local_selling_price || drug.official_price,
        strips_per_box: unitProfile.isSingleContainer
          ? 1
          : (Number(b.strips_per_box) > 0 ? Number(b.strips_per_box) : (drug.large_to_medium || 1)),
        medium_to_small: unitProfile.isSingleContainer
          ? 1
          : (Number(b.medium_to_small) > 0 ? Number(b.medium_to_small) : (drug.medium_to_small || 1))
      }))
    };

    return { success: true, data };
  } catch (error: any) {
    console.error('Barcode lookup action error:', error);
    return { success: false, error: 'فشل البحث بالباركود' };
  }
}

export async function fetchDraftsAction() {
  try {
    const localUser = await getLocalSession();
    if (!canUsePos(localUser) || !hasUserPermissionSync(localUser, 'show_suspended_invoices')) return { success: false, error: 'غير مصرح' };

    const pharmacyId = localUser.pharmacy_id || 'local_default';

    // Fetch draft invoices with their items and patient info
    const drafts = await db.prepare(`
      SELECT 
        si.id,
        si.total_amount,
        si.created_at,
        p.full_name as patient_name,
        si.patient_id,
        si.payment_method,
        si.check_number,
        si.discount_amount
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE si.pharmacy_id = ? AND si.status = 'draft'
      ORDER BY si.created_at DESC
    `).all(pharmacyId) as any[];

    // For each draft, fetch items
    const draftsWithItems = await Promise.all((drafts as any[]).map(async (draft: any) => {
      const items = await db.prepare(`
        SELECT 
          si.drug_id,
          si.quantity_sold as qty,
          si.unit_price as price,
          COALESCE(si.item_discount_percent, 0) as item_discount_percent,
          si.unit as selectedUnit,
          si.is_negative,
          md.trade_name,
          md.trade_name_en,
          md.active_ingredient,
          md.large_unit,
          md.medium_unit,
          md.small_unit,
          md.large_to_medium,
          md.medium_to_small,
          md.official_price
        FROM sales_items si
        LEFT JOIN master_drugs md ON si.drug_id = md.id
        WHERE si.invoice_id = ?
      `).all(draft.id) as any[];

      const today = format(new Date(), 'yyyy-MM-dd');
      const liveDrugIds = Array.from(new Set(
        (items as any[])
          .filter((item: any) => !item.is_negative)
          .map((item: any) => item.drug_id)
          .filter((drugId: any) => drugId !== null && drugId !== undefined)
      ));
      const liveBatches = liveDrugIds.length > 0 ? await db.prepare(`
        SELECT id as inventory_id, drug_id, quantity, expiry_date, local_selling_price, strips_per_box, medium_to_small
        FROM inventory
        WHERE drug_id IN (${liveDrugIds.map(() => '?').join(',')})
          AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
          AND quantity > 0
          AND (
            COALESCE((SELECT md.has_expiry FROM master_drugs md WHERE md.id = inventory.drug_id), 1) = 0
            OR expiry_date IS NOT NULL
          )
          AND (expiry_date IS NULL OR expiry_date >= ?)
        ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, created_at ASC
      `).all(...liveDrugIds, pharmacyId, pharmacyId, today) as any[] : [];

      const mappedItems = (items as any[]).map((item: any) => {
        const batches = item.is_negative
          ? []
          : liveBatches
              .filter((batch: any) => String(batch.drug_id) === String(item.drug_id))
              .map((batch: any) => ({
                inventory_id: batch.inventory_id,
                quantity: batch.quantity,
                expiry_date: batch.expiry_date ? normalizeDateToYMD(batch.expiry_date) : null,
                unit_price: batch.local_selling_price || item.official_price,
                strips_per_box: Number(batch.strips_per_box) > 0
                  ? Number(batch.strips_per_box)
                  : (item.large_to_medium || 1),
                medium_to_small: Number(batch.medium_to_small) > 0
                  ? Number(batch.medium_to_small)
                  : (item.medium_to_small || 1),
              }));
          return {
            ...item,
            itemDiscountPercent: Number(item.item_discount_percent) || 0,
            trade_name: item.trade_name_en || item.trade_name,
          total_stock: batches.reduce((sum: number, batch: any) => sum + Number(batch.quantity || 0), 0),
          batches,
          units: {
            large: item.large_unit || 'علبة',
            medium: item.medium_unit,
            small: item.small_unit,
            large_to_medium: item.large_to_medium || 1,
            medium_to_small: item.medium_to_small || 1
          },
          basePrice: item.official_price
        };
      });
      const itemSubtotal = mappedItems.reduce(
        (sum: number, item: any) => sum + (Number(item.qty) || 0) * (Number(item.price) || 0),
        0,
      );
      const additionalFees = Math.max(
        0,
        (Number(draft.total_amount) || 0) - itemSubtotal + (Number(draft.discount_amount) || 0),
      );

      return {
        ...draft,
        additional_fees: additionalFees,
        items: mappedItems,
      };
    }));

    return { success: true, data: draftsWithItems };
  } catch (error: any) {
    console.error('Fetch drafts action error:', error);
    return { success: false, error: 'فشل جلب المسودات' };
  }
}

export async function processCheckoutAction(data: any) {
  try {
    const localUser = await getLocalSession();
    if (!canUsePos(localUser)) return { success: false, error: 'غير مصرح' };
    if (!isTauri && typeof window !== 'undefined') {
      return {
        success: false,
        error: 'إتمام البيع من المتصفح غير مدعوم لأنه يتطلب معاملة ذرية؛ استخدم تطبيق سطح المكتب',
      };
    }

    const pharmacyId = localUser.pharmacy_id || 'local_default';
    const userId = localUser.id;

    const validatedData = CheckoutRequestSchema.parse(data);
    const normalizedCheckNumber = validatedData.payment_method === 'check'
      ? String(validatedData.check_number || '').trim()
      : '';
    if (validatedData.status === 'completed' && validatedData.payment_method === 'check' && !normalizedCheckNumber) {
      return { success: false, error: 'رقم الشيك مطلوب للبيع المكتمل بالشيك' };
    }
    if (validatedData.status === 'completed' && validatedData.payment_method === 'delivery' && !validatedData.patient_id) {
      return { success: false, error: 'يجب اختيار مريض لفاتورة التوصيل' };
    }
    const loyaltyDiscount = loyaltyDiscountAmount(validatedData.points_to_redeem);
    if (!Number.isFinite(loyaltyDiscount)) {
      return { success: false, error: 'عدد نقاط الولاء غير صالح' };
    }
    if (validatedData.points_to_redeem > 0) {
      if (validatedData.status !== 'completed') {
        return { success: false, error: 'لا يمكن استرداد نقاط الولاء في فاتورة معلقة' };
      }
      if (!validatedData.patient_id) {
        return { success: false, error: 'يجب اختيار مريض لاسترداد نقاط الولاء' };
      }
      if (validatedData.points_to_redeem < MIN_REDEEM_POINTS) {
        return { success: false, error: `الحد الأدنى للاسترداد ${MIN_REDEEM_POINTS} نقطة` };
      }
    }
    if (validatedData.status === 'draft' && !hasUserPermissionSync(localUser, 'suspended_can_save_invoice')) {
      return { success: false, error: 'غير مصرح بحفظ الفواتير المعلقة' };
    }
    if (validatedData.payment_method === 'credit' && !hasUserPermissionSync(localUser, 'can_sell_credit')) {
      return { success: false, error: 'غير مصرح بالبيع الآجل' };
    }
    if (validatedData.items.some(item => item.is_negative) && !hasUserPermissionSync(localUser, 'can_sell_no_stock')) {
      return { success: false, error: 'غير مصرح بالبيع بدون رصيد' };
    }
    if (validatedData.items.some(item => item.item_discount_percent > 0) && !hasUserPermissionSync(localUser, 'can_discount_sale_item')) {
      return { success: false, error: 'غير مصرح بتعديل خصم الصنف' };
    }
    if (validatedData.total_discount > 0) {
      if (!hasUserPermissionSync(localUser, 'can_give_total_discount')) {
        return { success: false, error: 'غير مصرح بإضافة خصم إجمالي' };
      }
      const gross = validatedData.items.reduce((sum, item) => sum + item.quantity_sold * item.unit_price, 0);
      const maxDiscountPercent = permissionNumber(localUser, 'max_invoice_discount_percent');
      if (gross > 0 && (validatedData.total_discount / gross) * 100 > maxDiscountPercent + 0.000001) {
        return { success: false, error: `نسبة الخصم تتجاوز الحد المسموح (${maxDiscountPercent}%)` };
      }
    }
    const merchandiseGross = validatedData.items.reduce((sum, item) => sum + item.quantity_sold * item.unit_price, 0);
    const eligibleMerchandiseAfterManualDiscount = Math.max(0, merchandiseGross - validatedData.total_discount);
    if (loyaltyDiscount > eligibleMerchandiseAfterManualDiscount + 0.000001) {
      return { success: false, error: 'خصم نقاط الولاء يتجاوز قيمة الأصناف بعد الخصم اليدوي' };
    }
    const combinedDiscount = validatedData.total_discount + loyaltyDiscount;
    const requestedTotalAmount = calculateCheckoutTotal(validatedData.items, combinedDiscount, validatedData.additional_fees || 0);
    if (!hasUserPermissionSync(localUser, 'can_change_price_sale') && !(await validateCheckoutPrices(validatedData.items, pharmacyId))) {
      return { success: false, error: 'غير مصرح بتغيير سعر الصنف أثناء البيع' };
    }
    if (validatedData.source_draft_id) {
      if (!hasUserPermissionSync(localUser, 'show_suspended_invoices')) {
        return { success: false, error: 'غير مصرح باستكمال الفواتير المعلقة' };
      }
      const sourceDraft = await db.prepare(`
        SELECT id, pharmacy_id, status FROM sales_invoices WHERE id = ?
      `).get(validatedData.source_draft_id) as any;
      const sourceDraftError = sourceDraftValidationError(sourceDraft, pharmacyId);
      if (sourceDraftError) return { success: false, error: sourceDraftError };
    }
    const requestedShiftId = validatedData.shift_id ? String(validatedData.shift_id) : null;
    const requestedShift = requestedShiftId
      ? await getShiftForPharmacy(requestedShiftId, pharmacyId, true)
      : null;
    const permanentShift = requestedShift || await ensurePermanentShiftForUser(userId);
    const shiftId = permanentShift?.id ? String(permanentShift.id) : null;

    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke('process_checkout_critical', {
        payload: {
          pharmacy_id: pharmacyId,
          user_id: userId,
          items: validatedData.items,
          patient_id: validatedData.patient_id ? String(validatedData.patient_id) : null,
          shift_id: shiftId,
          source_draft_id: validatedData.source_draft_id ? String(validatedData.source_draft_id) : null,
          payment_method: validatedData.payment_method,
          check_number: normalizedCheckNumber || null,
          status: validatedData.status,
          total_discount: validatedData.total_discount || 0,
          additional_fees: validatedData.additional_fees || 0,
          points_to_redeem: validatedData.points_to_redeem || 0,
        }
      }) as any;

      if (validatedData.status === 'completed') notifyInventoryChanged();

      return {
        success: true,
        data: {
          sale_id: result.sale_id,
          total_amount: result.total_amount,
          points_earned: result.points_earned,
          points_redeemed: result.points_redeemed,
          loyalty_discount_amount: result.loyalty_discount_amount,
          created_at: result.created_at,
        }
      };
    }

    // Patient Financial Validation
    let patientLoyaltyLevel: string | null = null;
    if (validatedData.patient_id && validatedData.status === 'completed') {
      const patient = await db.prepare('SELECT credit_limit, wallet_balance, loyalty_level, points_balance FROM patients WHERE id = ?').get(validatedData.patient_id) as any;
      if (!patient) {
        return { success: false, error: 'المريض المحدد غير موجود' };
      }
      if (patient) {
        patientLoyaltyLevel = patient.loyalty_level || null;
        const subTotal = requestedTotalAmount;

        if (validatedData.points_to_redeem > Number(patient.points_balance || 0)) {
          return { success: false, error: `رصيد النقاط غير كافٍ (${Math.floor(Number(patient.points_balance || 0))} نقطة متاحة)` };
        }

        if (validatedData.payment_method === 'credit') {
          const balanceRow = await db.prepare(patientOutstandingBalanceQuery()).get(validatedData.patient_id) as any;
           const currentDebt = balanceRow?.outstanding_balance || 0;
          const creditLeft = (patient.credit_limit || 0) - currentDebt;

          if ((currentDebt + subTotal) > (patient.credit_limit || 0)) {
            return { 
              success: false, 
              error: `تجاوز العميل الحد الائتماني المسموح به. الائتمان المتبقي الحالي: ${creditLeft.toFixed(2)} ج.م (قيمة الفاتورة: ${subTotal.toFixed(2)} ج.م، الحد الأقصى: ${patient.credit_limit} ج.م)` 
            };
          }
        }

        if (validatedData.payment_method === 'wallet') {
          if (subTotal > (patient.wallet_balance || 0)) {
            return { success: false, error: `رصيد المحفظة غير كافٍ (${patient.wallet_balance} ج.م)` };
          }
        }
      }
    } else if (validatedData.payment_method === 'credit' || validatedData.payment_method === 'wallet') {
      return { success: false, error: 'يجب اختيار مريض للبيع بالأجل أو باستخدام المحفظة' };
    }

    const saleId = generateId();
    const totalAmount = requestedTotalAmount;
    let pointsEarned = 0;

    await dbTransaction(async (db) => {
      if (validatedData.source_draft_id) {
        if (!hasUserPermissionSync(localUser, 'show_suspended_invoices')) {
          throw new Error('غير مصرح باستكمال الفواتير المعلقة');
        }
        const sourceDraft = await db.prepare(`
          SELECT id, pharmacy_id, status FROM sales_invoices WHERE id = ?
        `).get(validatedData.source_draft_id) as any;
        const sourceDraftError = sourceDraftValidationError(sourceDraft, pharmacyId);
        if (sourceDraftError) throw new Error(sourceDraftError);
        await db.prepare('DELETE FROM sales_items WHERE invoice_id = ?').run(validatedData.source_draft_id);
        const deletedDraft = await db.prepare("DELETE FROM sales_invoices WHERE id = ? AND status = 'draft'")
          .run(validatedData.source_draft_id);
        if (deletedDraft.changes !== 1) throw new Error('تعذر استبدال الفاتورة المعلقة؛ أعد المحاولة');
      }

      if (validatedData.patient_id && validatedData.status === 'completed') {
        const patient = await db.prepare('SELECT credit_limit, wallet_balance, loyalty_level, points_balance FROM patients WHERE id = ?')
          .get(validatedData.patient_id) as any;
        if (!patient) throw new Error('المريض المحدد غير موجود');
        patientLoyaltyLevel = patient.loyalty_level || null;

        if (validatedData.payment_method === 'credit') {
          const balanceRow = await db.prepare(patientOutstandingBalanceQuery()).get(validatedData.patient_id) as any;
          const currentDebt = Number(balanceRow?.outstanding_balance || 0);
          const creditLimit = Number(patient.credit_limit || 0);
          const creditLeft = creditLimit - currentDebt;
          if (currentDebt + totalAmount > creditLimit + 0.000001) {
            throw new Error(`تجاوز العميل الحد الائتماني المسموح به. الائتمان المتبقي الحالي: ${creditLeft.toFixed(2)} ج.م (قيمة الفاتورة: ${totalAmount.toFixed(2)} ج.م، الحد الأقصى: ${creditLimit} ج.م)`);
          }
        }

        if (validatedData.payment_method === 'wallet') {
          const walletBalance = Number(patient.wallet_balance || 0);
          if (totalAmount > walletBalance + 0.000001) {
            throw new Error(`رصيد المحفظة غير كافٍ (${walletBalance} ج.م)`);
          }
        }

        if (validatedData.points_to_redeem > 0) {
          const loyaltyUpdate = await db.prepare(`
            UPDATE patients
            SET points_balance = COALESCE(points_balance, 0) - ?
            WHERE id = ? AND COALESCE(points_balance, 0) >= ?
          `).run(validatedData.points_to_redeem, validatedData.patient_id, validatedData.points_to_redeem);
          if (!loyaltyUpdate.changes) {
            const current = await db.prepare('SELECT COALESCE(points_balance, 0) AS points_balance FROM patients WHERE id = ?')
              .get(validatedData.patient_id) as any;
            throw new Error(`رصيد النقاط غير كافٍ (${Math.floor(Number(current?.points_balance || 0))} نقطة متاحة)`);
          }
          await db.prepare("INSERT INTO activity_log (user_id, action, details) VALUES (?, 'REDEEM_POINTS', ?)")
            .run(
              userId,
              `Redeemed ${validatedData.points_to_redeem} points = ${loyaltyDiscount.toFixed(2)} EGP on sale ${saleId}`,
            );
        }
      }

      const today = format(new Date(), 'yyyy-MM-dd');
      let totalCogs = 0;

      await db.prepare(`
        INSERT INTO sales_invoices (
          id, pharmacy_id, user_id, patient_id, shift_id, total_amount, payment_method, check_number,
          status, discount_amount, points_redeemed, loyalty_discount_amount, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        saleId, pharmacyId, userId, 
        validatedData.patient_id || null, 
        shiftId,
        totalAmount, 
        validatedData.payment_method,
        normalizedCheckNumber || null,
        validatedData.status,
        combinedDiscount,
        validatedData.points_to_redeem || 0,
        loyaltyDiscount,
      );

      for (const item of validatedData.items) {
        const drugInfo = await db.prepare(`
          SELECT md.trade_name, md.trade_name_en, md.active_ingredient, md.large_to_medium, md.medium_to_small, md.has_expiry, md.medium_unit, md.small_unit, md.stop_dealing
          FROM master_drugs md
          WHERE md.id = ?
        `).get(item.drug_id) as any;
        if (Number(drugInfo?.stop_dealing) === 1) throw new Error('هذا الصنف مؤرشف أو متوقف؛ أزل الصنف من الفاتورة أو أعد تفعيله من إدارة الأصناف');
        
        const isPlaceholder = (s?: string) => !s || /^Drug\s*#?\s*\d+$/i.test(String(s).trim());
        const drugName = (!isPlaceholder(drugInfo?.trade_name_en) ? drugInfo?.trade_name_en : null) ||
                         (!isPlaceholder(drugInfo?.trade_name) ? drugInfo?.trade_name : null) ||
                         (!isPlaceholder(drugInfo?.active_ingredient) ? drugInfo?.active_ingredient : null) ||
                         drugInfo?.trade_name || drugInfo?.trade_name_en || `Drug #${item.drug_id}`;
        
        const fallbackLargeToMedium = Math.max(1, Number(drugInfo?.large_to_medium) || 1);
        const mediumToSmall = Math.max(1, Number(drugInfo?.medium_to_small) || 1);
        const requiresExpiry = Number(drugInfo?.has_expiry ?? 1) !== 0;

        if (validatedData.status === 'completed') {
          const batches = item.inventory_id 
            ? await db.prepare(`
                SELECT id, quantity, cost_price, expiry_date, strips_per_box, medium_to_small
                FROM inventory
                WHERE id = ? AND drug_id = ?
                  AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
                  AND quantity > 0
                  AND (? = 0 OR expiry_date IS NOT NULL)
                  AND (expiry_date IS NULL OR expiry_date >= ?)
              `).all(item.inventory_id, item.drug_id, pharmacyId, pharmacyId, requiresExpiry ? 1 : 0, today) as any[]
            : await db.prepare(`
                SELECT id, quantity, cost_price, expiry_date, strips_per_box, medium_to_small
                FROM inventory
                WHERE drug_id = ?
                  AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
                  AND quantity > 0
                  AND (? = 0 OR expiry_date IS NOT NULL)
                  AND (expiry_date IS NULL OR expiry_date >= ?)
                ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC, created_at ASC
              `).all(item.drug_id, pharmacyId, pharmacyId, requiresExpiry ? 1 : 0, today) as any[];

          if (item.inventory_id && batches.length === 0 && !item.is_negative) {
            throw new Error(`دفعة المخزون المحددة للصنف "${drugName}" غير صالحة أو منتهية`);
          }

          const selectedUnitCapacity = batches.reduce((total, batch) => {
            const batchLargeToMedium = Number(batch.strips_per_box) > 0
              ? Number(batch.strips_per_box)
              : fallbackLargeToMedium;
            const batchMediumToSmall = Number(batch.medium_to_small) > 0
              ? Number(batch.medium_to_small)
              : mediumToSmall;
            const stockPerSelectedUnit = saleStockQty(
              1,
              item.selected_unit,
              batchLargeToMedium,
              batchMediumToSmall,
              drugInfo?.medium_unit,
              drugInfo?.small_unit
            );
            return total + (Number(batch.quantity) || 0) / stockPerSelectedUnit;
          }, 0);

          if (!item.is_negative && selectedUnitCapacity + 0.000001 < item.quantity_sold) {
            throw new Error(`الكمية غير كافية للصنف "${drugName}" (المتاح: ${selectedUnitCapacity.toFixed(2)} ${item.selected_unit})`);
          }

          let remainingSelectedUnits = item.quantity_sold;

          for (const batch of batches) {
            if (remainingSelectedUnits <= 0.000001) break;

            const batchLargeToMedium = Number(batch.strips_per_box) > 0
              ? Number(batch.strips_per_box)
              : fallbackLargeToMedium;
            const batchMediumToSmall = Number(batch.medium_to_small) > 0
              ? Number(batch.medium_to_small)
              : mediumToSmall;
            const stockPerSelectedUnit = saleStockQty(
              1,
              item.selected_unit,
              batchLargeToMedium,
              batchMediumToSmall,
              drugInfo?.medium_unit,
              drugInfo?.small_unit
            );
            const batchCapacity = (Number(batch.quantity) || 0) / stockPerSelectedUnit;
            const quantityInSelectedUnit = Math.min(remainingSelectedUnits, batchCapacity);
            const deductFromThisBatch = quantityInSelectedUnit * stockPerSelectedUnit;

            const stockUpdate = await db.prepare(`
              UPDATE inventory
              SET quantity = CASE WHEN quantity - ? < 0.000001 THEN 0 ELSE quantity - ? END,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND drug_id = ?
                AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
                AND quantity + 0.000001 >= ?
            `).run(
              deductFromThisBatch,
              deductFromThisBatch,
              batch.id,
              item.drug_id,
              pharmacyId,
              pharmacyId,
              deductFromThisBatch
            );
            if (stockUpdate.changes !== 1) {
              throw new Error(`Inventory changed while processing "${drugName}"; please retry`);
            }
            
            await db.prepare(`
              INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, item_discount_percent, unit, is_negative, cost_price, large_to_medium, medium_to_small, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `).run(saleId, batch.id, item.drug_id, quantityInSelectedUnit, item.unit_price, item.item_discount_percent, item.selected_unit, 0, batch.cost_price || 0, batchLargeToMedium, batchMediumToSmall);

            totalCogs += (batch.cost_price || 0) * deductFromThisBatch;
            remainingSelectedUnits -= quantityInSelectedUnit;
          }

          if (remainingSelectedUnits > 0.000001) {
            if (item.is_negative) {
              await db.prepare(`
                INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, item_discount_percent, unit, is_negative, cost_price, large_to_medium, medium_to_small, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
              `).run(saleId, null, item.drug_id, remainingSelectedUnits, item.unit_price, item.item_discount_percent, item.selected_unit, 1, 0, fallbackLargeToMedium, mediumToSmall);
            } else {
              throw new Error(`تغير المخزون أثناء معالجة "${drugName}"؛ يرجى إعادة المحاولة`);
            }
          }

          await db.prepare(`
            INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, status)
            SELECT
              md.id,
              ?,
              MAX(1, COALESCE(NULLIF(md.default_purchase_qty, 0), NULLIF(md.reorder_point, 0), NULLIF(md.min_limit, 0), 1)),
              'pending'
            FROM master_drugs md
            WHERE md.id = ?
              AND COALESCE((
                SELECT SUM(i.quantity)
                FROM inventory i
                WHERE i.drug_id = md.id
                  AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
                  AND (COALESCE(md.has_expiry, 1) = 0 OR i.expiry_date IS NOT NULL)
                  AND (i.expiry_date IS NULL OR i.expiry_date >= ?)
              ), 0) <= 0.0001
              AND NOT EXISTS (
                SELECT 1
                FROM shortages s
                WHERE s.drug_id = md.id AND s.pharmacy_id = ? AND s.status IN ('pending', 'ordered')
              )
          `).run(pharmacyId, item.drug_id, pharmacyId, pharmacyId, today, pharmacyId);
        } else {
          await db.prepare(`
            INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, item_discount_percent, unit, is_negative, cost_price, large_to_medium, medium_to_small, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(saleId, null, item.drug_id, item.quantity_sold, item.unit_price, item.item_discount_percent, item.selected_unit, item.is_negative ? 1 : 0, 0, fallbackLargeToMedium, mediumToSmall);
        }
      }

      if (validatedData.status === 'completed') {
        const journalId = generateId();
        const saleDate = format(new Date(), 'yyyy-MM-dd');
        
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(journalId, saleDate, `فاتورة مبيعات رقم ${saleId.slice(0, 8)}`, userId, totalAmount + totalCogs);

        const getAccountId = async (cat: string) => {
          const s = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
          return s?.account_id;
        };

        const accounts = {
          cash: await getAccountId('cash_drawer') || 6,
          receivable: await getAccountId('accounts_receivable') || 8,
          bank: await getAccountId('bank_clearing') || (await db.prepare("SELECT id FROM accounts WHERE code = '1.1.4'").get() as any)?.id || 6,
          sales: await getAccountId('sales_revenue') || 9,
          inventory: await getAccountId('inventory_asset') || 10,
          cogs: await getAccountId('cogs_expense') || 11
        };

        let debitAccount = accounts.cash;
        if (validatedData.payment_method === 'credit' || validatedData.payment_method === 'delivery') debitAccount = accounts.receivable;
        if (validatedData.payment_method === 'visa' || validatedData.payment_method === 'check') debitAccount = accounts.bank;
        if (validatedData.payment_method === 'wallet') {
          debitAccount = await getAccountId('patient_wallet_liability') || 7;
        }

        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, debitAccount, 'debit', totalAmount);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.sales, 'credit', totalAmount);

        if (validatedData.payment_method === 'wallet' && validatedData.patient_id) {
          const walletUpdate = await db.prepare(`
            UPDATE patients
            SET wallet_balance = wallet_balance - ?
            WHERE id = ? AND COALESCE(wallet_balance, 0) + 0.000001 >= ?
          `).run(totalAmount, validatedData.patient_id, totalAmount);
          if (!walletUpdate.changes) throw new Error('رصيد المحفظة غير كافٍ');
        }

        if (totalCogs > 0) {
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.cogs, 'debit', totalCogs);
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, accounts.inventory, 'credit', totalCogs);
        }
      }

      if (validatedData.status === 'completed' && validatedData.patient_id) {
        const patient = await db.prepare('SELECT credit_limit, wallet_balance, loyalty_level FROM patients WHERE id = ?').get(validatedData.patient_id) as any;
        const today = format(new Date(), 'yyyy-MM-dd');

        for (const item of validatedData.items) {
          const reminderId = generateId();
          const nextRefillDate = new Date();
          const days = item.selected_unit === 'large' ? 30 : item.selected_unit === 'medium' ? 10 : 3;
          nextRefillDate.setDate(nextRefillDate.getDate() + (days * item.quantity_sold));

          await db.prepare(`
            INSERT INTO refill_reminders (id, patient_id, drug_id, last_sold_date, next_refill_date, created_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).run(reminderId, validatedData.patient_id, item.drug_id, today, format(nextRefillDate, 'yyyy-MM-dd'));
        }

        pointsEarned = calculateLoyaltyPoints(totalAmount, patient?.loyalty_level || patientLoyaltyLevel);
        if (pointsEarned > 0) {
          await db.prepare('UPDATE patients SET points_balance = COALESCE(points_balance, 0) + ? WHERE id = ?').run(pointsEarned, validatedData.patient_id);
        }
        await db.prepare('UPDATE sales_invoices SET points_earned = ? WHERE id = ?').run(pointsEarned, saleId);
      }
    });

    if (validatedData.status === 'completed') notifyInventoryChanged();

    const savedInvoice = await db.prepare('SELECT created_at FROM sales_invoices WHERE id = ?').get(saleId) as any;
    return {
      success: true,
      data: {
        sale_id: saleId,
        total_amount: totalAmount,
        points_earned: pointsEarned,
        points_redeemed: validatedData.points_to_redeem,
        loyalty_discount_amount: loyaltyDiscount,
        created_at: normalizeUtcTimestamp(savedInvoice?.created_at),
      }
    };
  } catch (error: any) {
    console.error('Checkout error:', error);
    return { success: false, error: (typeof error === 'string' ? error : error?.message) || '\u0641\u0634\u0644\u062a \u0645\u0639\u0627\u0644\u062c\u0629 \u0639\u0645\u0644\u064a\u0629 \u0627\u0644\u0628\u064a\u0639' };
  }
}

export async function getSalesDashboardStatsAction() {
  try {
    const localUser = await getLocalSession();
    if (!localUser || !hasUserPermissionSync(localUser, 'rep_can_view_sales')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = localUser.pharmacy_id || 'local_default';

    // Today's Sales
    const todaySalesRow = await db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total 
      FROM sales_invoices 
      WHERE DATE(created_at, 'localtime') = DATE('now', 'localtime')
        AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(pharmacyId, pharmacyId) as any;
    const todaySales = todaySalesRow?.total || 0;

    // Yesterday's Sales
    const yesterdaySalesRow = await db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total 
      FROM sales_invoices 
      WHERE DATE(created_at, 'localtime') = DATE('now', '-1 day', 'localtime')
        AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(pharmacyId, pharmacyId) as any;
    const yesterdaySales = yesterdaySalesRow?.total || 0;

    let salesChangeText = 'استقرار المبيعات مقارنة بالمساء';
    if (yesterdaySales > 0) {
      const pctDiff = ((todaySales - yesterdaySales) / yesterdaySales) * 100;
      if (pctDiff >= 0) {
        salesChangeText = `بزيادة ${pctDiff.toFixed(0)}% عن يوم أمس`;
      } else {
        salesChangeText = `بانخفاض ${Math.abs(pctDiff).toFixed(0)}% عن يوم أمس`;
      }
    } else if (todaySales > 0) {
      salesChangeText = 'مبيعات أولية اليوم';
    }

    // Delivery Stats
    const deliveryCountRow = await db.prepare(`
      SELECT COUNT(*) as total 
      FROM sales_invoices 
      WHERE payment_method = 'delivery'
        AND DATE(created_at, 'localtime') = DATE('now', 'localtime')
        AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(pharmacyId, pharmacyId) as any;
    const deliveryCount = deliveryCountRow?.total || 0;

    const pendingDeliveryRow = await db.prepare(`
      SELECT COUNT(*) as pending 
      FROM sales_invoices 
      WHERE payment_method = 'delivery'
        AND status = 'completed'
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(pharmacyId, pharmacyId) as any;
    const pendingDeliveryCount = pendingDeliveryRow?.pending || 0;
    const pendingDeliveryCountText = `يوجد ${pendingDeliveryCount} طلبات قيد الانتظار`;

    // Average Invoice
    const todayAvgInvoiceRow = await db.prepare(`
      SELECT COALESCE(AVG(total_amount), 0) as avg_val 
      FROM sales_invoices 
      WHERE DATE(created_at, 'localtime') = DATE('now', 'localtime')
        AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(pharmacyId, pharmacyId) as any;
    const averageInvoice = Math.round(todayAvgInvoiceRow?.avg_val || 0);

    const yesterdayAvgInvoiceRow = await db.prepare(`
      SELECT COALESCE(AVG(total_amount), 0) as avg_val 
      FROM sales_invoices 
      WHERE DATE(created_at, 'localtime') = DATE('now', '-1 day', 'localtime')
        AND (status IS NULL OR status = '' OR status IN ('completed', 'approved', 'delivered'))
        AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(pharmacyId, pharmacyId) as any;
    const yesterdayAverageInvoice = Math.round(yesterdayAvgInvoiceRow?.avg_val || 0);

    let averageInvoiceChangeText = 'أداء مستقر للموظفين';
    if (averageInvoice > 0 && yesterdayAverageInvoice > 0) {
      const avgPct = ((averageInvoice - yesterdayAverageInvoice) / yesterdayAverageInvoice) * 100;
      if (avgPct >= 5) {
        averageInvoiceChangeText = 'تحسن ملحوظ في سلة المشتريات';
      } else if (avgPct <= -5) {
        averageInvoiceChangeText = 'انخفاض طفيف في متوسط الفاتورة';
      }
    }

    return {
      success: true,
      data: {
        todaySales,
        salesChangeText,
        deliveryCount,
        pendingDeliveryCountText,
        averageInvoice,
        averageInvoiceChangeText
      }
    };
  } catch (error: any) {
    console.error('Error fetching sales stats:', error);
    return { success: false, error: error.message || '\u0641\u0634\u0644 \u062c\u0644\u0628 \u0625\u062d\u0635\u0627\u0626\u064a\u0627\u062a \u0627\u0644\u0645\u0628\u064a\u0639\u0627\u062a' };
  }
}

export function getRelevanceScore(drug: any, searchLower: string): number {
  return calculateDrugRelevance(drug, searchLower);
}
