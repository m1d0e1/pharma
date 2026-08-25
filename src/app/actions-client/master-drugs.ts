
import { dbSelect, dbExecute, dbGet, dbTransaction, generateId } from '@/lib/db/tauri';
const logActivity = async (userId, action, details) => {
  try {
    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);
  } catch (e) {
    console.error('Failed to log activity:', e);
  }
};
const initLocalDb = () => {};
const clearAuditLogs = async () => {
  try {
    await dbExecute('DELETE FROM activity_log');
    return true;
  } catch (e) {
    console.error('Failed to clear activity logs:', e);
    return false;
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
    return (...args) => dbTransaction(async () => await cb(...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};

function normalizeBarcode(value: unknown): string | null {
  const barcode = String(value ?? '').trim();
  return barcode.length > 0 ? barcode : null;
}

async function assertBarcodeAvailable(barcode: string | null, excludedDrugId?: number) {
  if (!barcode) return;

  const existing = excludedDrugId === undefined
    ? await db.prepare(`
        SELECT id FROM master_drugs
        WHERE barcode IS NOT NULL AND TRIM(barcode) = ? COLLATE NOCASE
        LIMIT 1
      `).get(barcode) as any
    : await db.prepare(`
        SELECT id FROM master_drugs
        WHERE id != ? AND barcode IS NOT NULL AND TRIM(barcode) = ? COLLATE NOCASE
        LIMIT 1
      `).get(excludedDrugId, barcode) as any;

  if (existing) {
    throw new Error('Barcode is already assigned to another drug');
  }
}




const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local'
import { secureCache } from '@/lib/cache/secure_cache';

export async function getMasterDrugAction(id: number) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_manage_inventory')) return { success: false, error: 'غير مصرح' };

    const item = await db.prepare('SELECT * FROM master_drugs WHERE id = ?').get(id) as any;
    return { success: true, data: item };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addMasterDrugAction(data: any) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || (localUser.role !== 'owner' && localUser.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    const tradeName = (data.trade_name || data.trade_name_en || '').trim();
    const tradeNameEn = (data.trade_name_en || data.trade_name || '').trim() || null;
    if (!tradeName) {
      return { success: false, error: 'اسم الصنف مطلوب' };
    }

    const officialPrice = Number(data.official_price);
    if (!Number.isFinite(officialPrice) || officialPrice < 0) {
      return { success: false, error: 'Invalid selling price' };
    }
    const barcode = normalizeBarcode(data.barcode);

    const stmt = db.prepare(`
      INSERT INTO master_drugs (
        trade_name, trade_name_en, generic_name, active_ingredient, barcode, 
        official_price, category, manufacturer, is_medicine, is_service, 
        is_refrigerated, is_chronic, has_expiry, no_return, origin, notes,
        large_unit, small_unit, medium_unit, large_to_medium, medium_to_small,
        min_limit, max_limit, reorder_point, default_purchase_qty, prevent_fractions,
        tax_percent, discount_percent, stop_dealing, code_2, item_nature,
        scientific_group, usage_method, active_ingredient_ratio, is_table
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insert = db.transaction(async () => {
      await assertBarcodeAvailable(barcode);
      return stmt.run(
      tradeName,
      tradeNameEn,
      data.generic_name || null,
      data.active_ingredient || null,
      barcode,
      officialPrice,
      data.category || null,
      data.manufacturer || null,
      data.is_medicine ?? 1,
      data.is_service ?? 0,
      data.is_refrigerated ?? 0,
      data.is_chronic ?? 0,
      data.has_expiry ?? 1,
      data.no_return ?? 0,
      data.origin || null,
      data.notes || null,
      data.large_unit || null,
      data.small_unit || null,
      data.medium_unit || null,
      data.large_to_medium || null,
      data.medium_to_small || null,
      data.min_limit || null,
      data.max_limit || null,
      data.reorder_point || null,
      data.default_purchase_qty || null,
      data.prevent_fractions ?? 0,
      data.tax_percent ?? 0,
      data.discount_percent ?? 0,
      data.stop_dealing ?? 0,
      data.code_2 || null,
      data.item_nature || null,
      data.scientific_group || null,
      data.usage_method || null,
      data.active_ingredient_ratio || null,
      data.is_table ?? 0
      );
    });
    const result = await insert();

    logActivity(localUser.id, 'ADD_MASTER_DRUG', `أضاف الصنف: ${tradeName}`);
    revalidatePath('/stores/items');

    return { success: true, id: result.lastInsertRowid };
  } catch (error: any) {
    console.error('Add master drug error:', error);
    return { success: false, error: error.message };
  }
}


export async function searchInventoryAction(query: string) {
  try {
    if (!query || query.length < 2) return { success: true, data: [] };

    const searchLower = query.toLowerCase().trim();
    
    // Find matching drugs from RAM cache and sort by relevance score
    await secureCache.load();
    const matchedDrugsRaw = secureCache.getAllDrugs().filter((d: any) => 
      (d.trade_name && d.trade_name.toLowerCase().includes(searchLower)) ||
      (d.trade_name_en && d.trade_name_en.toLowerCase().includes(searchLower)) ||
      d.barcode === searchLower ||
      d.id.toString() === searchLower
    );

    const matchedDrugs = matchedDrugsRaw
      .map(drug => ({ drug, score: getRelevanceScore(drug, searchLower) }))
      .sort((a, b) => b.score - a.score)
      .map(item => item.drug)
      .slice(0, 100);

    if (matchedDrugs.length === 0) return { success: true, data: [] };

    const matchedIds = matchedDrugs.map((d: any) => d.id);
    const placeholders = matchedIds.map(() => '?').join(',');

    // Fetch inventory for these matching drugs
    let sql = `
      SELECT i.*
      FROM inventory i
      WHERE i.drug_id IN (${placeholders})
      LIMIT 20
    `;
    
    const items = await db.prepare(sql).all(...matchedIds) as any[];
    
    // Enrich with names
    const enriched = items.map(item => {
      const d = matchedDrugs.find((d: any) => d.id === item.drug_id);
      return {
        ...item,
        trade_name: d?.trade_name,
        trade_name_en: d?.trade_name_en,
        generic_name: d?.generic_name,
        barcode: d?.barcode
      };
    });

    return { success: true, data: enriched };
  } catch (error: any) {
    console.error('Inventory search error:', error.message);
    return { success: false, error: error.message };
  }
}

export async function updateMasterDrugAction(id: number, data: any) {
  try {
    const localUser = await getLocalSession();
    const tradeName = (data.trade_name || data.trade_name_en || '').trim();
    const tradeNameEn = (data.trade_name_en || data.trade_name || '').trim() || null;
    if (!tradeName) {
      return { success: false, error: 'اسم الصنف مطلوب' };
    }

    const officialPrice = Number(data.official_price ?? data.base_price ?? 0);
    if (!Number.isFinite(officialPrice) || officialPrice < 0) {
      return { success: false, error: 'سعر البيع غير صالح' };
    }

    const barcode = normalizeBarcode(data.barcode);

    const stmt = db.prepare(`
      UPDATE master_drugs SET
        trade_name = ?, trade_name_en = ?, generic_name = ?, active_ingredient = ?, barcode = ?, 
        official_price = ?, category = ?, manufacturer = ?, is_medicine = ?, is_service = ?, 
        is_refrigerated = ?, is_chronic = ?, has_expiry = ?, no_return = ?, origin = ?, notes = ?,
        large_unit = ?, small_unit = ?, medium_unit = ?, large_to_medium = ?, medium_to_small = ?,
        min_limit = ?, max_limit = ?, reorder_point = ?, default_purchase_qty = ?, prevent_fractions = ?,
        tax_percent = ?, discount_percent = ?, stop_dealing = ?,
        code_2 = ?, item_nature = ?, scientific_group = ?, usage_method = ?,
        active_ingredient_ratio = ?, is_table = ?, indications = ?, side_effects = ?
      WHERE id = ?
    `);

    const update = db.transaction(async () => {
      await assertBarcodeAvailable(barcode, id);
      await stmt.run(
      tradeName,
      tradeNameEn,
      data.generic_name || null,
      data.active_ingredient || null,
      barcode,
      officialPrice,
      data.category || null,
      data.manufacturer || null,
      data.is_medicine ?? 1,
      data.is_service ?? 0,
      data.is_refrigerated ?? 0,
      data.is_chronic ?? 0,
      data.has_expiry ?? 1,
      data.no_return ?? 0,
      data.origin || null,
      data.notes || null,
      data.large_unit || null,
      data.small_unit || null,
      data.medium_unit || null,
      data.large_to_medium || null,
      data.medium_to_small || null,
      data.min_limit || null,
      data.max_limit || null,
      data.reorder_point || null,
      data.default_purchase_qty || null,
      data.prevent_fractions ?? 0,
      data.tax_percent ?? 0,
      data.discount_percent ?? 0,
      data.stop_dealing ?? 0,
      data.code_2 || null,
      data.item_nature || null,
      data.scientific_group || null,
      data.usage_method || null,
      data.active_ingredient_ratio || null,
      data.is_table ?? 0,
      data.indications || null,
      data.side_effects || null,
        id
      );
      // ponytail: one selling price source keeps inventory, POS and purchase entry aligned.
      await db.prepare(`
        UPDATE inventory
        SET local_selling_price = ?,
            barcode = CASE WHEN (barcode IS NULL OR barcode = '') AND ? != '' THEN ? ELSE barcode END,
            updated_at = CURRENT_TIMESTAMP
        WHERE drug_id = ?
      `).run(officialPrice, barcode || '', barcode || '', id);
    });
    await update();

    secureCache.updateDrug(id, {
      trade_name: tradeName,
      trade_name_en: tradeNameEn,
      generic_name: data.generic_name,
      active_ingredient: data.active_ingredient,
      barcode,
      official_price: officialPrice,
      large_unit: data.large_unit,
      medium_unit: data.medium_unit,
      small_unit: data.small_unit,
      large_to_medium: data.large_to_medium ? parseInt(data.large_to_medium) : undefined,
      medium_to_small: data.medium_to_small ? parseInt(data.medium_to_small) : undefined,
      stop_dealing: data.stop_dealing ?? 0
    });

    logActivity(localUser.id, 'UPDATE_MASTER_DRUG', `عدل الصنف: ${tradeName}`);
    revalidatePath('/stores/items');

    return { success: true };
  } catch (error: any) {
    console.error('Update master drug error:', error);
    return { success: false, error: error.message };
  }
}

export async function searchMasterDrugsAction(queryOrOptions: string | { 
  query: string, 
  type?: 'medicine' | 'non-medicine' | 'service' | 'all',
  status?: 'stopped' | 'active' | 'all',
  minPrice?: number,
  maxPrice?: number,
  searchByActiveIngredient?: boolean
}): Promise<{ success: boolean; data?: any[]; error?: string }> {
  try {
    const options = typeof queryOrOptions === 'string' ? { query: queryOrOptions } : queryOrOptions;
    const { query, type = 'all', status = 'all', minPrice, maxPrice, searchByActiveIngredient = false } = options;
    
    if (!query) return { success: true, data: [] };

    let allDrugs: any[] = [];
    try {
      await secureCache.load();
      allDrugs = secureCache.getAllDrugs();
    } catch (cacheErr) {
      console.warn('secureCache unavailable in searchMasterDrugsAction, searching DB only:', cacheErr);
    }
    const searchLower = query.toLowerCase().trim();

    // 1. Search in secureCache (RAM)
    const cacheMatched = allDrugs.filter((m: any) => {
      // Name/Barcode/Active Ingredient Match
      const matchesText = searchByActiveIngredient
        ? (m.active_ingredient && m.active_ingredient.toLowerCase().includes(searchLower)) ||
          (m.generic_name && m.generic_name.toLowerCase().includes(searchLower))
        : (m.trade_name && m.trade_name.toLowerCase().includes(searchLower)) ||
          (m.trade_name_en && m.trade_name_en.toLowerCase().includes(searchLower)) ||
          m.barcode === searchLower ||
          m.id?.toString() === searchLower;
      if (!matchesText) return false;

      // Type Filter
      if (type === 'medicine' && (!m.is_medicine || m.is_service)) return false;
      if (type === 'non-medicine' && (m.is_medicine || m.is_service)) return false;
      if (type === 'service' && !m.is_service) return false;

      // Status Filter
      if (status === 'stopped' && !m.stop_dealing) return false;
      if (status === 'active' && m.stop_dealing) return false;

      // Price Filter
      if (minPrice !== undefined && m.official_price < minPrice) return false;
      if (maxPrice !== undefined && m.official_price > maxPrice) return false;

      return true;
    });

    // 2. Search in local SQLite database (for custom added drugs)
    const likePattern = `%${searchLower}%`;
    const dbQuery = searchByActiveIngredient
      ? `SELECT * FROM master_drugs 
         WHERE (active_ingredient LIKE ? OR generic_name LIKE ?)
           AND (trade_name IS NULL OR trade_name != 'SECURE')
           AND (trade_name_en IS NULL OR trade_name_en != 'SECURE')`
      : `SELECT * FROM master_drugs 
         WHERE (trade_name LIKE ? OR trade_name_en LIKE ? OR barcode = ?)
           AND (trade_name IS NULL OR trade_name != 'SECURE')
           AND (trade_name_en IS NULL OR trade_name_en != 'SECURE')`;

    const dbParams = searchByActiveIngredient 
      ? [likePattern, likePattern] 
      : [likePattern, likePattern, searchLower];

    const dbMatched = await db.prepare(dbQuery).all(...dbParams) as any[];

    const dbFiltered = dbMatched.filter((m: any) => {
      if (type === 'medicine' && (!m.is_medicine || m.is_service)) return false;
      if (type === 'non-medicine' && (m.is_medicine || m.is_service)) return false;
      if (type === 'service' && !m.is_service) return false;

      if (status === 'stopped' && !m.stop_dealing) return false;
      if (status === 'active' && m.stop_dealing) return false;

      if (minPrice !== undefined && m.official_price < minPrice) return false;
      if (maxPrice !== undefined && m.official_price > maxPrice) return false;

      return true;
    });

    // 3. Combine both and remove duplicates
    const combinedMap = new Map<string, any>();
    
    // Cache matches take priority
    for (const item of cacheMatched) {
      combinedMap.set(String(item.id), item);
    }

    // Database matches add custom drugs
    for (const item of dbFiltered) {
      if (!combinedMap.has(String(item.id))) {
        combinedMap.set(String(item.id), item);
      }
    }

    const merged = Array.from(combinedMap.values())
      .map(drug => ({ drug, score: getRelevanceScore(drug, searchLower) }))
      .sort((a, b) => b.score - a.score)
      .map(item => item.drug)
      .slice(0, 100);

    const ids = merged.map(drug => drug.id);
    const costs = ids.length ? await db.prepare(`
      SELECT drug_id, SUM(quantity * cost_price) / NULLIF(SUM(quantity), 0) AS purchase_price
      FROM inventory
      WHERE drug_id IN (${ids.map(() => '?').join(',')}) AND quantity > 0
      GROUP BY drug_id
    `).all(...ids) as any[] : [];
    const purchasePrices = new Map(costs.map(row => [String(row.drug_id), Number(row.purchase_price) || 0]));

    return {
      success: true,
      data: merged.map(drug => ({ ...drug, base_price: purchasePrices.get(String(drug.id)) || drug.base_price || 0 }))
    };
  } catch (error: any) {
    console.error('Search master drugs error:', error);
    return { success: false, error: error.message };
  }
}

// Units
export async function getUnitsAction() {
  try {
    const items = await db.prepare('SELECT * FROM units ORDER BY name_ar ASC').all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addUnitAction(data: { name_ar: string, name_en?: string }) {
  try {
    const stmt = db.prepare('INSERT INTO units (name_ar, name_en) VALUES (?, ?)');
    const result = await stmt.run(data.name_ar, data.name_en || null);
    revalidatePath('/stores/units');
    return { success: true, id: result.lastInsertRowid };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function updateUnitAction(id: number, data: { name_ar: string, name_en?: string }) {
  try {
    await db.prepare('UPDATE units SET name_ar = ?, name_en = ? WHERE id = ?').run(data.name_ar, data.name_en || null, id);
    revalidatePath('/stores/units');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteUnitAction(id: number) {
  try {
    await db.prepare('DELETE FROM units WHERE id = ?').run(id);
    revalidatePath('/stores/units');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Product Categories (Hierarchical)
export async function addProductCategoryAction(data: { name_ar: string, name_en?: string, parent_id?: number }) {
  try {
    const stmt = db.prepare('INSERT INTO product_categories (name_ar, name_en, parent_id) VALUES (?, ?, ?)');
    const result = await stmt.run(data.name_ar, data.name_en || null, data.parent_id || null);
    revalidatePath('/stores/categories');
    return { success: true, id: result.lastInsertRowid };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function updateProductCategoryAction(id: number, data: { name_ar: string, name_en?: string, parent_id?: number }) {
  try {
    await db.prepare('UPDATE product_categories SET name_ar = ?, name_en = ?, parent_id = ? WHERE id = ?').run(data.name_ar, data.name_en || null, data.parent_id || null, id);
    revalidatePath('/stores/categories');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteProductCategoryAction(id: number) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || (localUser.role !== 'owner' && localUser.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }

    // Check if it has children
    const check = await db.prepare('SELECT COUNT(*) as count FROM product_categories WHERE parent_id = ?').get(id) as any;
    if (check.count > 0) return { success: false, error: 'لا يمكن حذف مجموعة تحتوي على مجموعات فرعية' };

    // Check if it has items
    const itemCheck = await db.prepare('SELECT id FROM master_drugs WHERE category_id = ? LIMIT 1').get(id) as any;
    if (itemCheck) return { success: false, error: 'لا يمكن حذف مجموعة تحتوي على أصناف مسجلة' };

    await db.prepare('DELETE FROM product_categories WHERE id = ?').run(id);
    revalidatePath('/stores/categories');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function getProductCategoriesAction() {
  try {
    const items = await db.prepare('SELECT * FROM product_categories ORDER BY name_ar ASC').all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Alternatives
export async function addAlternativeAction(drugId: number, altId: number) {
  try {
    const stmt = db.prepare('INSERT OR IGNORE INTO drug_alternatives (drug_id, alternative_id) VALUES (?, ?)');
    await stmt.run(drugId, altId);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function getAlternativesAction(drugId: number) {
  try {
    const items = await db.prepare(`
      SELECT m.* FROM master_drugs m
      JOIN drug_alternatives a ON m.id = a.alternative_id
      WHERE a.drug_id = ?
    `).all(drugId);
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Indications
export async function addIndicationAction(data: { name_ar: string, name_en?: string }) {
  try {
    const stmt = db.prepare('INSERT INTO indications (name_ar, name_en) VALUES (?, ?)');
    const result = await stmt.run(data.name_ar, data.name_en || null);
    revalidatePath('/stores/indications');
    return { success: true, id: result.lastInsertRowid };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function updateIndicationAction(id: number, data: { name_ar: string, name_en?: string }) {
  try {
    await db.prepare('UPDATE indications SET name_ar = ?, name_en = ? WHERE id = ?').run(data.name_ar, data.name_en || null, id);
    revalidatePath('/stores/indications');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteIndicationAction(id: number) {
  try {
    await db.prepare('DELETE FROM indications WHERE id = ?').run(id);
    revalidatePath('/stores/indications');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function getIndicationsAction() {
  try {
    const items = await db.prepare('SELECT * FROM indications ORDER BY name_ar ASC').all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Scientific Groups
export async function getScientificGroupsAction() {
  try {
    const items = await db.prepare('SELECT * FROM scientific_groups ORDER BY name_ar ASC').all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addScientificGroupAction(data: { name_ar: string, name_en?: string }) {
  try {
    const stmt = db.prepare('INSERT INTO scientific_groups (name_ar, name_en) VALUES (?, ?)');
    const result = await stmt.run(data.name_ar, data.name_en || null);
    revalidatePath('/stores/scientific-groups');
    return { success: true, id: result.lastInsertRowid };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function updateScientificGroupAction(id: number, data: { name_ar: string, name_en?: string }) {
  try {
    await db.prepare('UPDATE scientific_groups SET name_ar = ?, name_en = ? WHERE id = ?').run(data.name_ar, data.name_en || null, id);
    revalidatePath('/stores/scientific-groups');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteScientificGroupAction(id: number) {
  try {
    await db.prepare('DELETE FROM scientific_groups WHERE id = ?').run(id);
    revalidatePath('/stores/scientific-groups');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Item Natures
export async function getItemNaturesAction() {
  try {
    const items = await db.prepare('SELECT * FROM item_natures ORDER BY name_ar ASC').all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addItemNatureAction(data: { name_ar: string, name_en?: string }) {
  try {
    const stmt = db.prepare('INSERT INTO item_natures (name_ar, name_en) VALUES (?, ?)');
    const result = await stmt.run(data.name_ar, data.name_en || null);
    revalidatePath('/stores/nature');
    return { success: true, id: result.lastInsertRowid };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function updateItemNatureAction(id: number, data: { name_ar: string, name_en?: string }) {
  try {
    await db.prepare('UPDATE item_natures SET name_ar = ?, name_en = ? WHERE id = ?').run(data.name_ar, data.name_en || null, id);
    revalidatePath('/stores/nature');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteItemNatureAction(id: number) {
  try {
    await db.prepare('DELETE FROM item_natures WHERE id = ?').run(id);
    revalidatePath('/stores/nature');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Usage Methods
export async function getUsageMethodsAction() {
  try {
    const items = await db.prepare('SELECT * FROM usage_methods ORDER BY name_ar ASC').all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addUsageMethodAction(data: { name_ar: string, name_en?: string }) {
  try {
    const stmt = db.prepare('INSERT INTO usage_methods (name_ar, name_en) VALUES (?, ?)');
    const result = await stmt.run(data.name_ar, data.name_en || null);
    revalidatePath('/stores/usage');
    return { success: true, id: result.lastInsertRowid };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function updateUsageMethodAction(id: number, data: { name_ar: string, name_en?: string }) {
  try {
    await db.prepare('UPDATE usage_methods SET name_ar = ?, name_en = ? WHERE id = ?').run(data.name_ar, data.name_en || null, id);
    revalidatePath('/stores/usage');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteUsageMethodAction(id: number) {
  try {
    await db.prepare('DELETE FROM usage_methods WHERE id = ?').run(id);
    revalidatePath('/stores/usage');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Adjustment Reasons
export async function getAdjustmentReasonsAction() {
  try {
    const items = await db.prepare('SELECT * FROM adjustment_reasons ORDER BY name_ar ASC').all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addAdjustmentReasonAction(data: { name_ar: string, name_en?: string }) {
  try {
    const stmt = db.prepare('INSERT INTO adjustment_reasons (name_ar, name_en) VALUES (?, ?)');
    const result = await stmt.run(data.name_ar, data.name_en || null);
    revalidatePath('/stores/adjustment-reasons');
    return { success: true, id: result.lastInsertRowid };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function updateAdjustmentReasonAction(id: number, data: { name_ar: string, name_en?: string }) {
  try {
    await db.prepare('UPDATE adjustment_reasons SET name_ar = ?, name_en = ? WHERE id = ?').run(data.name_ar, data.name_en || null, id);
    revalidatePath('/stores/adjustment-reasons');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteAdjustmentReasonAction(id: number) {
  try {
    await db.prepare('DELETE FROM adjustment_reasons WHERE id = ?').run(id);
    revalidatePath('/stores/adjustment-reasons');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}



// Generic Delete/Update for other tables
export async function updateGenericBilingualAction(table: string, id: number, data: { name_ar: string, name_en?: string }) {
  try {
    const ALLOWED = new Set(['indications', 'item_natures', 'usage_methods', 'scientific_groups', 'units', 'manufacturers']);
    if (!ALLOWED.has(table)) return { success: false, error: 'Table not allowed' };

    await db.prepare(`UPDATE ${table} SET name_ar = ?, name_en = ? WHERE id = ?`).run(data.name_ar, data.name_en || null, id);
    revalidatePath(`/stores/${table.replace('_', '-')}`);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteGenericBilingualAction(table: string, id: number) {
  try {
    const ALLOWED = new Set(['indications', 'item_natures', 'usage_methods', 'scientific_groups', 'units', 'manufacturers']);
    if (!ALLOWED.has(table)) return { success: false, error: 'Table not allowed' };

    await db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    revalidatePath(`/stores/${table.replace('_', '-')}`);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function getDrugsByIndicationAction(indicationId: number) {
  try {
    const items = await db.prepare(`
      SELECT m.*, i.id as link_id FROM master_drugs m
      JOIN drug_indications i ON m.id = i.drug_id
      WHERE i.indication_id = ?
    `).all(indicationId);
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addDrugIndicationAction(drugId: number, indicationId: number) {
  try {
    const stmt = db.prepare('INSERT OR IGNORE INTO drug_indications (drug_id, indication_id) VALUES (?, ?)');
    await stmt.run(drugId, indicationId);
    revalidatePath('/stores/drug-indications');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteDrugIndicationAction(drugId: number, indicationId: number) {
  try {
    await db.prepare('DELETE FROM drug_indications WHERE drug_id = ? AND indication_id = ?').run(drugId, indicationId);
    revalidatePath('/stores/drug-indications');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

const MASTER_DRUG_REFERENCE_PREDICATE = `
  EXISTS(SELECT 1 FROM inventory WHERE drug_id = m.id) OR
  EXISTS(SELECT 1 FROM sales_items WHERE drug_id = m.id) OR
  EXISTS(SELECT 1 FROM refill_reminders WHERE drug_id = m.id) OR
  EXISTS(SELECT 1 FROM return_items WHERE drug_id = m.id) OR
  EXISTS(SELECT 1 FROM purchase_invoice_items WHERE drug_id = m.id) OR
  EXISTS(SELECT 1 FROM purchase_order_items WHERE drug_id = m.id) OR
  EXISTS(SELECT 1 FROM purchase_return_items WHERE drug_id = m.id) OR
  EXISTS(SELECT 1 FROM opening_balance_items WHERE drug_id = m.id) OR
  EXISTS(SELECT 1 FROM shortages WHERE drug_id = m.id) OR
  EXISTS(SELECT 1 FROM drug_indications WHERE drug_id = m.id) OR
  EXISTS(SELECT 1 FROM drug_alternatives WHERE drug_id = m.id OR alternative_id = m.id)
`;

export async function getUnusedItemsAction() {
  try {
    const localUser = await getLocalSession();
    if (!localUser || !hasUserPermissionSync(localUser, 'can_manage_inventory')) {
      return { success: false, error: 'Unauthorized' };
    }

    const items = await db.prepare(`
      SELECT m.* FROM master_drugs m
      WHERE NOT (${MASTER_DRUG_REFERENCE_PREDICATE})
      ORDER BY m.trade_name ASC
    `).all() as any[];
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteMasterDrugAction(id: number) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || !hasUserPermissionSync(localUser, 'can_manage_inventory')) {
      return { success: false, error: 'Unauthorized' };
    }
    if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
      return { success: false, error: 'Invalid drug id' };
    }

    const remove = db.transaction(async () => {
      const item = await db.prepare(`
        SELECT m.id, CASE WHEN (${MASTER_DRUG_REFERENCE_PREDICATE}) THEN 1 ELSE 0 END AS is_referenced
        FROM master_drugs m
        WHERE m.id = ?
      `).get(Number(id)) as any;

      if (!item) throw new Error('Drug not found');
      if (Number(item.is_referenced) === 1) {
        throw new Error('Drugs with inventory, transaction, or clinical history cannot be deleted');
      }

      const result = await db.prepare('DELETE FROM master_drugs WHERE id = ?').run(Number(id));
      if (Number(result.changes) !== 1) throw new Error('Drug was not deleted');

      await db.prepare(`
        INSERT INTO activity_log (user_id, action, details)
        VALUES (?, 'DELETE_MASTER_DRUG', ?)
      `).run(localUser.id, `Deleted unused master drug #${Number(id)}`);
    });

    await remove();
    try {
      await secureCache.reload();
    } catch (cacheError) {
      console.warn('Master drug deleted but cache reload failed:', cacheError);
    }

    revalidatePath('/stores/delete-items');
    revalidatePath('/stores/items');
    revalidatePath('/inventory');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function migrateNamesToEnglishAction() {
  try {
    const localUser = await getLocalSession();
    if (!localUser || localUser.role !== 'owner') return { success: false, error: 'غير مصرح' };

    const transaction = db.transaction(async () => {
      // 1. Where trade_name_en exists, make it the main trade_name
      await db.prepare(`
        UPDATE master_drugs 
        SET trade_name = trade_name_en
        WHERE trade_name_en IS NOT NULL AND trade_name_en != ''
      `).run();

      // 2. Clear trade_name_en to avoid redundancy if desired, or keep it.
      // The user said "delete arabic names", so we cleared the old trade_name by overwriting it with English.
      // If trade_name_en was null, we might still have Arabic in trade_name.
      // Let's clear any remaining Arabic (non-ASCII) from trade_name if we can't find an English alternative.
      // But for now, the user said "i will add it later", so maybe just leave as is or clear all and let them re-import.
    });

    await transaction();
    revalidatePath('/stores/items');
    return { success: true };
  } catch (error: any) {
    console.error('Migration error:', error);
    return { success: false, error: error.message };
  }
}

// Manufacturers
export async function getManufacturersAction() {
  try {
    const items = await db.prepare('SELECT * FROM manufacturers ORDER BY name_ar ASC').all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addManufacturerAction(data: { name_ar: string, name_en?: string }) {
  try {
    const stmt = db.prepare('INSERT INTO manufacturers (name_ar, name_en) VALUES (?, ?)');
    const result = await stmt.run(data.name_ar, data.name_en || null);
    revalidatePath('/stores/manufacturers');
    return { success: true, id: result.lastInsertRowid };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Opening Balances
export async function getOpeningBalancesAction() {
  try {
    const session = await getLocalSession();
    if (!session || (session.role !== 'owner' && session.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!session || !hasUserPermissionSync(session, 'can_view_opening_balances')) return { success: false, error: 'Unauthorized' };

    const items = await db.prepare(`
      SELECT b.*, u.full_name as user_name 
      FROM opening_balances b
      JOIN users u ON b.user_id = u.id
      ORDER BY b.created_at DESC
    `).all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function createOpeningBalanceAction(notes?: string) {
  try {
    const session = await getLocalSession();
    if (!session || !hasUserPermissionSync(session, 'can_view_opening_balances')) return { success: false, error: 'Unauthorized' };
    
    const id = generateId();
    await db.prepare('INSERT INTO opening_balances (id, user_id, notes) VALUES (?, ?, ?)').run(id, session.id, notes || null);
    revalidatePath('/stores/opening-balances');
    return { success: true, id };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addOpeningBalanceItemAction(obId: string, item: { drug_id: number, quantity: number, unit_id?: number, expiry_date?: string, selling_price?: number, cost_price?: number, discount_pct?: number }) {
  try {
    await db.prepare(`
      INSERT INTO opening_balance_items (ob_id, drug_id, quantity, unit_id, expiry_date, selling_price, cost_price, discount_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(obId, item.drug_id, item.quantity, item.unit_id || null, item.expiry_date || null, item.selling_price || null, item.cost_price || null, item.discount_pct || 0);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function completeOpeningBalanceAction(obId: string) {
  try {
    const session = await getLocalSession();
    if (!session || (session.role !== 'owner' && session.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!session || !hasUserPermissionSync(session, 'can_view_opening_balances')) return { success: false, error: 'Unauthorized' };

    const transaction = db.transaction(async () => {
      // 1. Update status
      await db.prepare('UPDATE opening_balances SET status = ? WHERE id = ?').run('completed', obId);

      // 2. Add items to inventory
      const items = await db.prepare('SELECT * FROM opening_balance_items WHERE ob_id = ?').all(obId) as any[];
      for (const item of items) {
        const invId = generateId();
        await db.prepare(`
          INSERT INTO inventory (id, drug_id, pharmacy_id, quantity, local_selling_price, cost_price, expiry_date)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(invId, item.drug_id, session.pharmacy_id, item.quantity, item.selling_price, item.cost_price, item.expiry_date);
      }
    });

    await transaction();
    revalidatePath('/stores/opening-balances');
    revalidatePath('/inventory');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Stock Adjustments
export async function createStockAdjustmentAction(inventoryId: string, data: { reason_id: number, old_quantity: number, new_quantity: number, notes?: string }) {
  try {
    const session = await getLocalSession();
    if (!session || (session.role !== 'owner' && session.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!session) return { success: false, error: 'Unauthorized' };

    const transaction = db.transaction(async () => {
      // 1. Record adjustment
      await db.prepare(`
        INSERT INTO stock_adjustments (inventory_id, reason_id, old_quantity, new_quantity, user_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(inventoryId, data.reason_id, data.old_quantity, data.new_quantity, session.id);

      // 2. Update inventory
      await db.prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(data.new_quantity, inventoryId);
    });

    await transaction();
    revalidatePath('/inventory');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}


export async function addDrugAlternativeAction(drugId: number, alternativeId: number) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || (localUser.role !== 'owner' && localUser.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!localUser || !hasUserPermissionSync(localUser, 'can_manage_inventory')) return { success: false, error: 'غير مصرح' };

    const existing = await db.prepare('SELECT id FROM drug_alternatives WHERE (drug_id = ? AND alternative_id = ?) OR (drug_id = ? AND alternative_id = ?)').get(drugId, alternativeId, alternativeId, drugId);
    if (existing) return { success: true };

    await db.prepare('INSERT INTO drug_alternatives (drug_id, alternative_id) VALUES (?, ?)').run(drugId, alternativeId);
    
    await logActivity(localUser.id, 'ADD_ALTERNATIVE', `تم ربط بديل للصنف ${drugId}`);
    return { success: true };
  } catch (error: any) {
    console.error('Add alternative error:', error);
    return { success: false, error: error.message };
  }
}

export async function removeDrugAlternativeAction(drugId: number, alternativeId: number) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || !hasUserPermissionSync(localUser, 'can_manage_inventory')) return { success: false, error: 'غير مصرح' };

    await db.prepare('DELETE FROM drug_alternatives WHERE (drug_id = ? AND alternative_id = ?) OR (drug_id = ? AND alternative_id = ?)').run(drugId, alternativeId, alternativeId, drugId);
    
    await logActivity(localUser.id, 'REMOVE_ALTERNATIVE', `تم إزالة بديل للصنف ${drugId}`);
    return { success: true };
  } catch (error: any) {
    console.error('Remove alternative error:', error);
    return { success: false, error: error.message };
  }
}

export async function addDrugInteractionAction(ingredientA: string, ingredientB: string, severity: string = 'minor') {
  try {
    const localUser = await getLocalSession();
    if (!localUser || (localUser.role !== 'owner' && localUser.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!localUser || !hasUserPermissionSync(localUser, 'can_manage_inventory')) return { success: false, error: 'غير مصرح' };

    if (!ingredientA || !ingredientB) return { success: false, error: 'المادة الفعالة مطلوبة' };

    const existing = await db.prepare('SELECT id FROM drug_interactions WHERE (ingredient_a = ? AND ingredient_b = ?) OR (ingredient_a = ? AND ingredient_b = ?)').get(ingredientA, ingredientB, ingredientB, ingredientA);
    if (existing) return { success: true };

    await db.prepare('INSERT INTO drug_interactions (ingredient_a, ingredient_b, severity) VALUES (?, ?, ?)').run(ingredientA, ingredientB, severity);
    
    await logActivity(localUser.id, 'ADD_INTERACTION', `إضافة تعارض بين ${ingredientA} و ${ingredientB}`);
    return { success: true };
  } catch (error: any) {
    console.error('Add interaction error:', error);
    return { success: false, error: error.message };
  }
}

export async function removeDrugInteractionAction(id: number) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || !hasUserPermissionSync(localUser, 'can_manage_inventory')) return { success: false, error: 'غير مصرح' };

    await db.prepare('DELETE FROM drug_interactions WHERE id = ?').run(id);
    
    await logActivity(localUser.id, 'REMOVE_INTERACTION', `إزالة تعارض دوائي`);
    return { success: true };
  } catch (error: any) {
    console.error('Remove interaction error:', error);
    return { success: false, error: error.message };
  }
}

export function getRelevanceScore(drug: any, searchLower: string): number {
  const tradeEn = (drug.trade_name_en || '').toLowerCase().trim();
  const tradeAr = (drug.trade_name || '').toLowerCase().trim();
  const active = (drug.active_ingredient || drug.generic_name || '').toLowerCase().trim();
  const barcode = (drug.barcode || '').toLowerCase().trim();

  // 1. Exact matches on trade name or barcode
  if (tradeEn === searchLower || tradeAr === searchLower || barcode === searchLower || String(drug.id) === searchLower) {
    return 100;
  }

  // 2. Starts-with match on trade name (initial letters)
  if (tradeEn.startsWith(searchLower) || tradeAr.startsWith(searchLower)) {
    return 80;
  }

  // 3. Starts-with match on any word of trade name
  const tradeEnWords = tradeEn.split(/[\s\-]+/);
  const tradeArWords = tradeAr.split(/[\s\-]+/);
  if (tradeEnWords.some((w: string) => w.startsWith(searchLower)) || tradeArWords.some((w: string) => w.startsWith(searchLower))) {
    return 70;
  }

  // 4. Contains match on trade name
  if (tradeEn.includes(searchLower) || tradeAr.includes(searchLower)) {
    return 60;
  }

  // 5. Starts-with match on active ingredient (initial letters)
  if (active.startsWith(searchLower)) {
    return 50;
  }

  // 6. Starts-with match on any word of active ingredient
  const activeWords = active.split(/[\s\-\+]+/);
  if (activeWords.some((w: string) => w.startsWith(searchLower))) {
    return 40;
  }

  // 7. Contains match on active ingredient
  if (active.includes(searchLower)) {
    return 30;
  }

  return 0;
}
