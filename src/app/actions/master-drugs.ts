'use server';

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




const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;
import { getLocalSession } from '@/lib/auth/local'
import { secureCache } from '@/lib/cache/secure_cache';

export async function getMasterDrugAction(id: number) {
  try {
    const item = await db.prepare('SELECT * FROM master_drugs WHERE id = ?').get(id) as any;
    return { success: true, data: item };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addMasterDrugAction(data: any) {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

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

    const result = await stmt.run(
      data.trade_name,
      data.trade_name_en || null,
      data.generic_name || null,
      data.active_ingredient || null,
      data.barcode || null,
      data.official_price || 0,
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

    logActivity(localUser.id, 'ADD_MASTER_DRUG', `أضاف الصنف: ${data.trade_name}`);
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
    
    // Find matching drugs from RAM cache
    const matchedDrugs = secureCache.getAllDrugs().filter((d: any) => 
      (d.trade_name && d.trade_name.toLowerCase().includes(searchLower)) ||
      (d.trade_name_en && d.trade_name_en.toLowerCase().includes(searchLower)) ||
      d.barcode === searchLower ||
      d.id.toString() === searchLower
    ).slice(0, 100);

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
    if (!localUser) return { success: false, error: 'غير مصرح' };

    const stmt = db.prepare(`
      UPDATE master_drugs SET
        trade_name = ?, trade_name_en = ?, generic_name = ?, active_ingredient = ?, barcode = ?, 
        official_price = ?, category = ?, manufacturer = ?, is_medicine = ?, is_service = ?, 
        is_refrigerated = ?, is_chronic = ?, has_expiry = ?, no_return = ?, origin = ?, notes = ?,
        large_unit = ?, small_unit = ?, medium_unit = ?, large_to_medium = ?, medium_to_small = ?,
        min_limit = ?, max_limit = ?, reorder_point = ?, default_purchase_qty = ?, prevent_fractions = ?,
        tax_percent = ?, discount_percent = ?, stop_dealing = ?,
        code_2 = ?, item_nature = ?, scientific_group = ?, usage_method = ?,
        active_ingredient_ratio = ?, is_table = ?
      WHERE id = ?
    `);

    await stmt.run(
      data.trade_name,
      data.trade_name_en || null,
      data.generic_name || null,
      data.active_ingredient || null,
      data.barcode || null,
      data.official_price || 0,
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
      id
    );

    logActivity(localUser.id, 'UPDATE_MASTER_DRUG', `عدل الصنف: ${data.trade_name}`);
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
  maxPrice?: number
}): Promise<{ success: boolean; data?: any[]; error?: string }> {
  try {
    const options = typeof queryOrOptions === 'string' ? { query: queryOrOptions } : queryOrOptions;
    const { query, type = 'all', status = 'all', minPrice, maxPrice } = options;
    
    if (!query) return { success: true, data: [] };

    await secureCache.load();
    const allDrugs = secureCache.getAllDrugs();
    const searchLower = query.toLowerCase().trim();

    // 1. Search in secureCache (RAM)
    const cacheMatched = allDrugs.filter((m: any) => {
      // Name/Barcode Match
      const matchesText = (m.trade_name && m.trade_name.toLowerCase().includes(searchLower)) ||
                          (m.trade_name_en && m.trade_name_en.toLowerCase().includes(searchLower)) ||
                          (m.active_ingredient && m.active_ingredient.toLowerCase().includes(searchLower)) ||
                          m.barcode === searchLower;
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
    const dbMatched = await db.prepare(`
      SELECT * FROM master_drugs 
      WHERE (trade_name LIKE ? OR trade_name_en LIKE ? OR active_ingredient LIKE ? OR barcode = ?)
        AND (trade_name IS NULL OR trade_name != 'SECURE')
        AND (trade_name_en IS NULL OR trade_name_en != 'SECURE')
    `).all(likePattern, likePattern, likePattern, searchLower) as any[];

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

    const merged = Array.from(combinedMap.values()).slice(0, 100);

    return { success: true, data: merged };
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
    // Check if it has children
    const check = await db.prepare('SELECT COUNT(*) as count FROM product_categories WHERE parent_id = ?').get(id) as any;
    if (check.count > 0) return { success: false, error: 'لا يمكن حذف مجموعة تحتوي على مجموعات فرعية' };

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
    const allowedTables = ['indications', 'item_natures', 'usage_methods', 'scientific_groups', 'units', 'manufacturers'];
    if (!allowedTables.includes(table)) return { success: false, error: 'Table not allowed' };
    
    await db.prepare(`UPDATE ${table} SET name_ar = ?, name_en = ? WHERE id = ?`).run(data.name_ar, data.name_en || null, id);
    revalidatePath(`/stores/${table.replace('_', '-')}`);
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function deleteGenericBilingualAction(table: string, id: number) {
  try {
    const allowedTables = ['indications', 'item_natures', 'usage_methods', 'scientific_groups', 'units', 'manufacturers'];
    if (!allowedTables.includes(table)) return { success: false, error: 'Table not allowed' };

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

export async function getUnusedItemsAction() {
  try {
    // Items that are NOT in inventory AND NOT in sales_items
    const items = await db.prepare(`
      SELECT m.* FROM master_drugs m
      WHERE NOT EXISTS (SELECT 1 FROM inventory i WHERE i.drug_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM sales_items s WHERE s.drug_id = m.id)
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
    if (!localUser) return { success: false, error: 'غير مصرح' };

    // Security check - Only owner/admin
    if (localUser.role !== 'owner' && localUser.role !== 'admin') {
      return { success: false, error: 'ليس لديك صلاحية الحذف' };
    }

    // Triple check - don't delete if it has inventory now
    const check = await db.prepare('SELECT COUNT(*) as count FROM inventory WHERE drug_id = ?').get(id) as any;
    if (check.count > 0) return { success: false, error: 'لا يمكن حذف صنف له رصيد حالي' };

    await db.prepare('DELETE FROM master_drugs WHERE id = ?').run(id);
    
    logActivity(localUser.id, 'DELETE_MASTER_DRUG', `حذف الصنف كود: ${id}`);
    revalidatePath('/stores/delete-items');
    revalidatePath('/stores/items');

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
    if (!session) return { success: false, error: 'Unauthorized' };
    
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
    if (!session) return { success: false, error: 'Unauthorized' };

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

// Shortages
export async function getShortagesAction() {
  try {
    const items = await db.prepare(`
      SELECT s.*, 
             m.trade_name, m.trade_name_en,
             m.generic_name
      FROM shortages s
      LEFT JOIN master_drugs m ON s.drug_id = m.id
      WHERE s.status != 'received'
      ORDER BY s.created_at DESC
    `).all();
    return { success: true, data: items };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function addShortageAction(drugId: number, quantity: number = 1) {
  try {
    await db.prepare('INSERT INTO shortages (drug_id, requested_quantity) VALUES (?, ?)').run(drugId, quantity);
    revalidatePath('/stores/shortages');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function updateShortageStatusAction(id: number, status: string) {
  try {
    await db.prepare('UPDATE shortages SET status = ? WHERE id = ?').run(status, id);
    revalidatePath('/stores/shortages');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Stock Adjustments
export async function createStockAdjustmentAction(inventoryId: string, data: { reason_id: number, old_quantity: number, new_quantity: number, notes?: string }) {
  try {
    const session = await getLocalSession();
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

