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



import { z } from 'zod';

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

import { getLocalSession } from '@/lib/auth/local';
import { secureCache } from '@/lib/cache/secure_cache';

// Zod schema for adding inventory
const addInventorySchema = z.object({
  pharmacy_id: z.string().optional().nullable(),
  drug_id: z.number().int().positive('معرف الدواء يجب أن يكون رقم موجب'),
  quantity: z.number().int().positive('الكمية يجب أن تكون رقم موجب'),
  local_selling_price: z.number().nonnegative('السعر لا يمكن أن يكون سالباً'),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ غير صحيحة (YYYY-MM-DD)'),
  barcode: z.string().optional().nullable(),
  unit: z.string().optional().nullable(),
  large_to_medium: z.number().int().positive().optional().nullable(),
});

// Zod schema for updating inventory
const updateInventorySchema = z.object({
  id: z.string().uuid('معرف المخزون غير صالح'),
  quantity: z.number().min(0, 'الكمية لا يمكن أن تكون سالبة'),
  local_selling_price: z.number().positive('السعر يجب أن يكون رقم موجب'),
  reason_id: z.number().optional().nullable(),
});

// Zod schema for deleting inventory
const deleteInventorySchema = z.object({
  id: z.string().uuid('معرف المخزون غير صالح'),
});

export type AddInventoryInput = z.infer<typeof addInventorySchema>;
export type UpdateInventoryInput = z.infer<typeof updateInventorySchema>;
export type DeleteInventoryInput = z.infer<typeof deleteInventorySchema>;

/**
 * Server Action to add a new inventory item (Local Enforcer)
 */
export async function addInventoryAction(formData: AddInventoryInput) {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    const { hasPermission } = await import('@/lib/auth/local');
    if (!await hasPermission('can_manage_inventory')) {
      return { success: false, error: 'ليس لديك صلاحية إضافة أصناف للمخزون' };
    }

    const validationResult = addInventorySchema.safeParse(formData);
    if (!validationResult.success) {
      return { success: false, error: 'بيانات الإدخال غير صالحة.' };
    }

    const { pharmacy_id, drug_id, quantity, local_selling_price, expiry_date, barcode, unit, large_to_medium } = validationResult.data;

    await secureCache.load();
    const tradeName = secureCache.getDisplayName(drug_id);

    const id = generateId();

    await db.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date, barcode, strips_per_box)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, pharmacy_id || null, drug_id, quantity, local_selling_price, expiry_date, barcode || null, large_to_medium || 1);

    if (unit) {
      await db.prepare('UPDATE master_drugs SET large_unit = ? WHERE id = ?').run(unit, drug_id);
    }

    if (large_to_medium !== undefined && large_to_medium !== null) {
      await db.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(large_to_medium, drug_id);
    }

    logActivity(localUser.id, 'ADD_INVENTORY', `أضاف ${quantity} من ${tradeName}`);

    revalidatePath('/inventory');
    revalidatePath('/');

    return { success: true };
  } catch (error: any) {
    console.error('Local Inventory Error:', error);
    return { success: false, error: 'فشل إضافة الصنف محلياً.' };
  }
}

/**
 * Server Action to update an existing inventory item
 */
export async function updateInventoryAction(formData: UpdateInventoryInput) {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    const { hasPermission } = await import('@/lib/auth/local');
    if (!await hasPermission('can_manage_inventory')) {
      return { success: false, error: 'ليس لديك صلاحية تحديث بيانات المخزون' };
    }

    const validationResult = updateInventorySchema.safeParse(formData);
    if (!validationResult.success) {
      return { success: false, error: 'بيانات التحديث غير صالحة.' };
    }

    const { id, quantity, local_selling_price, reason_id } = validationResult.data;

    await secureCache.load();
    const transaction = db.transaction(async () => {
      const current = await db.prepare(`
        SELECT i.quantity, i.drug_id
        FROM inventory i 
        WHERE i.id = ?
      `).get(id) as { quantity: number, drug_id: number };

      if (!current) throw new Error('Inventory not found');

      await db.prepare(`
        UPDATE inventory 
        SET quantity = ?, local_selling_price = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(quantity, local_selling_price, id);

      const tradeName = secureCache.getDisplayName(current.drug_id);

      if (reason_id && quantity !== current.quantity) {
        await db.prepare(`
          INSERT INTO stock_adjustments (inventory_id, reason_id, old_quantity, new_quantity, user_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, reason_id, current.quantity, quantity, localUser.id);

        // Accounting for Adjustment
        const journalId = generateId();
        const diff = Math.abs(quantity - current.quantity);
        const costPrice = await db.prepare('SELECT cost_price FROM inventory WHERE id = ?').get(id) as { cost_price: number };
        const totalValue = diff * (costPrice?.cost_price || 0);

        if (totalValue > 0) {
          const adjDate = new Date().toISOString().split('T')[0];
          await db.prepare(`
            INSERT INTO daily_journals (id, date, description, created_by, total_amount)
            VALUES (?, ?, ?, ?, ?)
          `).run(journalId, adjDate, `تسوية مخزنية: ${tradeName}`, localUser.id, totalValue);

          const getAccountId = async (cat: string) => {
            const s = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
            return s?.account_id;
          };

          const invAcc = await getAccountId('inventory_asset') || 10;
          const adjAcc = await getAccountId('inventory_adjustment') || 12;

          if (quantity < current.quantity) {
            // Decrease: Debit Adjustment (Expense), Credit Inventory (Asset)
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, adjAcc, 'debit', totalValue);
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, invAcc, 'credit', totalValue);
          } else {
            // Increase: Debit Inventory (Asset), Credit Adjustment (Gain/Income)
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, invAcc, 'debit', totalValue);
            await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, adjAcc, 'credit', totalValue);
          }
        }
      }

      logActivity(localUser.id, 'UPDATE_INVENTORY', `حدث بيانات ${tradeName} (الكمية: ${quantity})`);
    });

    await transaction();

    revalidatePath('/inventory');
    revalidatePath('/');

    return { success: true };
  } catch (error: any) {
    console.error('Local Update Error:', error);
    return { success: false, error: 'فشل تحديث المخزون.' };
  }
}

/**
 * Server Action to delete an inventory item
 */
export async function deleteInventoryAction(formData: DeleteInventoryInput) {
  try {
    const localUser = await getLocalSession();
    if (!localUser) return { success: false, error: 'غير مصرح' };

    const validationResult = deleteInventorySchema.safeParse(formData);
    if (!validationResult.success) {
      return { success: false, error: 'بيانات الحذف غير صالحة.' };
    }

    // Get drug info before deletion
    const current = await db.prepare(`
      SELECT i.drug_id
      FROM inventory i 
      WHERE i.id = ?
    `).get(validationResult.data.id) as { drug_id: number };

    await secureCache.load();
    const tradeName = secureCache.getDisplayName(current?.drug_id ?? 0);

    await db.prepare('DELETE FROM inventory WHERE id = ?').run(validationResult.data.id);

    logActivity(localUser.id, 'DELETE_INVENTORY', `حذف ${tradeName} من المخزون`);

    revalidatePath('/inventory');
    revalidatePath('/');

    return { success: true };
  } catch (error: any) {
    console.error('Local Delete Error:', error);
    return { success: false, error: 'فشل حذف الصنف.' };
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
export async function getLowStockAction(threshold: number = 10) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const items = await db.prepare(`
      SELECT i.id, i.drug_id, i.quantity, i.local_selling_price, i.expiry_date,
             m.trade_name, m.active_ingredient, m.manufacturer, m.trade_name_en, m.official_price
      FROM inventory i
      JOIN master_drugs m ON i.drug_id = m.id
      WHERE i.quantity <= COALESCE(
        NULLIF(m.reorder_point, 0),
        (
          SELECT COALESCE(SUM(si.quantity_sold), 0)
          FROM sales_items si
          JOIN sales_invoices inv ON si.invoice_id = inv.id
          WHERE si.drug_id = i.drug_id
            AND si.is_negative = 0
            AND inv.created_at >= datetime('now', '-30 days', 'localtime')
        ),
        ?
      )
      ORDER BY i.quantity ASC
    `).all(threshold) as any[];

    const { secureCache } = require('@/lib/cache/secure_cache');
    await secureCache.load();
    const enriched = secureCache.enrich(items);

    return { success: true, data: enriched };
  } catch (error) {
    console.error('Get low stock error:', error);
    return { success: false, error: 'فشل جلب الأصناف منخفضة المخزون' };
  }
}

/**
 * Reconcile negative sales with new inventory
 */
export async function settleNegativeStockAction(drugId: number | string, newInventoryId: string) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const transaction = db.transaction(async () => {
      // 1. Get negative sales for this drug
      const negativeSales = await db.prepare(`
        SELECT si.id, si.invoice_id, si.quantity_sold, si.unit_price, si.unit, si.cost_price, si.created_at
        FROM sales_items si
        WHERE si.drug_id = ? AND si.is_negative = 1
        ORDER BY si.created_at ASC
      `).all(drugId) as any[];

      // 2. Get available quantity in the new inventory
      let inventory = await db.prepare('SELECT id, quantity FROM inventory WHERE id = ?').get(newInventoryId) as any;
      if (!inventory) throw new Error('Inventory not found');

      let available = inventory.quantity;

      for (const sale of negativeSales) {
        if (available <= 0) break;

        const settleQty = Math.min(sale.quantity_sold, available);

        if (settleQty < sale.quantity_sold) {
          // Partial settlement: update the current sales_item to settleQty and remove negative flag
          await db.prepare(`
            UPDATE sales_items 
            SET inventory_id = ?, is_negative = 0, quantity_sold = ? 
            WHERE id = ?
          `).run(newInventoryId, settleQty, sale.id);

          // Insert a new sales_item for the remaining negative quantity
          const remainder = sale.quantity_sold - settleQty;
          await db.prepare(`
            INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, is_negative, cost_price, created_at)
            VALUES (?, NULL, ?, ?, ?, ?, 1, ?, ?)
          `).run(sale.invoice_id, drugId, remainder, sale.unit_price, sale.unit, sale.cost_price, sale.created_at);
        } else {
          // Full settlement
          await db.prepare(`
            UPDATE sales_items 
            SET inventory_id = ?, is_negative = 0, quantity_sold = ? 
            WHERE id = ?
          `).run(newInventoryId, settleQty, sale.id);
        }

        available -= settleQty;
      }

      // Update inventory final quantity
      await db.prepare('UPDATE inventory SET quantity = ? WHERE id = ?').run(available, newInventoryId);
    });

    await transaction();
    revalidatePath('/inventory');
    return { success: true };
  } catch (error: any) {
    console.error('Settle Stock Error:', error);
    return { success: false, error: error.message };
  }
}
// Pre-compiled prepared statements for alerts (cached at module level)
const _lowStockStmt = db.prepare(`
  SELECT i.id, i.drug_id, i.quantity, 'low_stock' as alert_type,
         m.trade_name, m.active_ingredient, m.manufacturer, m.trade_name_en
  FROM inventory i
  JOIN master_drugs m ON i.drug_id = m.id
  WHERE i.quantity <= COALESCE(
    NULLIF(m.reorder_point, 0),
    (
      SELECT COALESCE(SUM(si.quantity_sold), 0)
      FROM sales_items si
      JOIN sales_invoices inv ON si.invoice_id = inv.id
      WHERE si.drug_id = i.drug_id
        AND si.is_negative = 0
        AND inv.created_at >= datetime('now', '-30 days', 'localtime')
    ),
    10
  )
  LIMIT 10
`);
const _expiringStmt = db.prepare(`
  SELECT i.id, i.drug_id, i.expiry_date, 'expiring' as alert_type,
         m.trade_name, m.active_ingredient, m.manufacturer, m.trade_name_en
  FROM inventory i
  JOIN master_drugs m ON i.drug_id = m.id
  WHERE i.expiry_date > ? AND i.expiry_date <= ?
  LIMIT 10
`);
const _expiredStmt = db.prepare(`
  SELECT i.id, i.drug_id, i.expiry_date, 'expired' as alert_type,
         m.trade_name, m.active_ingredient, m.manufacturer, m.trade_name_en
  FROM inventory i
  JOIN master_drugs m ON i.drug_id = m.id
  WHERE i.expiry_date <= ?
  LIMIT 10
`);

const _getAlertsData = unstable_cache(
  async (today: string, threeMonthsStr: string) => {
    const lowStock = await _lowStockStmt.all() as any[];
    const expiring = await _expiringStmt.all(today, threeMonthsStr) as any[];
    const expired = await _expiredStmt.all(today) as any[];
    return { lowStock, expiring, expired };
  },
  ['inventory-alerts'],
  { revalidate: 60 } // Cache for 60 seconds — alerts don't need real-time precision
);

/**
 * Get unified inventory alerts (Low stock + Expiring soon)
 */
export async function getInventoryAlertsAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const today = new Date().toISOString().split('T')[0];
    const threeMonthsLater = new Date();
    threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3);
    const threeMonthsStr = threeMonthsLater.toISOString().split('T')[0];

    const { lowStock, expiring, expired } = await _getAlertsData(today, threeMonthsStr);

    const { secureCache } = require('@/lib/cache/secure_cache');
    await secureCache.load();
    const enrichedLowStock = secureCache.enrich(lowStock);
    const enrichedExpiring = secureCache.enrich(expiring);
    const enrichedExpired = secureCache.enrich(expired);

    const allAlerts = [...enrichedExpired, ...enrichedExpiring, ...enrichedLowStock];

    return { 
      success: true, 
      data: {
        alerts: allAlerts,
        counts: {
          lowStock: enrichedLowStock.length,
          expiring: enrichedExpiring.length,
          expired: enrichedExpired.length,
          total: allAlerts.length
        }
      }
    };
  } catch (error) {
    console.error('Get inventory alerts error:', error);
    return { success: false, error: 'فشل جلب تنبيهات المخزون' };
  }
}

/**
 * Get full drug details for the DrugDetailsModal
 */
export async function getDrugDetailsFullAction(drugId: number | string) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    // Get basic drug info
    const drug = await db.prepare(`
      SELECT * FROM master_drugs WHERE id = ?
    `).get(drugId) as any;

    if (!drug) {
      return { success: false, error: 'Drug not found' };
    }

    // Parse units
    try {
      drug.units = JSON.parse(drug.units || '{}');
    } catch (e) {
      drug.units = { large: 'علبة', medium: 'شريط', small: 'قرص' };
    }

    // Get total stock
    const stockRow = await db.prepare('SELECT SUM(quantity) as total FROM inventory WHERE drug_id = ?').get(drugId) as { total: number };
    drug.total_stock = stockRow?.total || 0;

    // Get expiry batches
    const batches = await db.prepare(`
      SELECT batch_number, expiry_date, quantity
      FROM inventory
      WHERE drug_id = ? AND quantity > 0
      ORDER BY expiry_date ASC
    `).all(drugId) as any[];

    const today = new Date();
    drug.expiry_batches = batches.map(b => ({
      ...b,
      is_expired: new Date(b.expiry_date) < today
    }));

    // Get Consumption Stats (Last 6 months)
    const consumption = await db.prepare(`
      SELECT strftime('%Y', created_at) as year, strftime('%m', created_at) as month, 
             SUM(quantity_sold) as net_sales, COUNT(*) as transactions
      FROM sales_items
      WHERE drug_id = ?
      GROUP BY year, month
      ORDER BY year DESC, month DESC
      LIMIT 6
    `).all(drugId) as any[];
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
        const interactions = await db.prepare(`
          SELECT id, ingredient_a, ingredient_b, severity, description_ar, description_en
          FROM drug_interactions
          WHERE UPPER(ingredient_a) = UPPER(?) OR UPPER(ingredient_b) = UPPER(?)
        `).all(ingredient, ingredient) as any[];

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

    // Get alternatives (same active ingredient)
    const alternatives = await db.prepare(`
      SELECT md.id, md.trade_name, md.active_ingredient, md.official_price as min_price, md.manufacturer,
             (SELECT SUM(quantity) FROM inventory WHERE drug_id = md.id) as total_stock
      FROM master_drugs md
      WHERE md.active_ingredient = ? 
        AND md.active_ingredient IS NOT NULL 
        AND md.active_ingredient != '' 
        AND md.id != ?
      LIMIT 10
    `).all(drug.active_ingredient, drugId);
    
    drug.alternatives = alternatives;
    
    // Get Supplier History
    const supplierHistory = await db.prepare(`
      SELECT s.id as supplier_id, s.name_ar as supplier_name, pii.cost_price, pii.selling_price, 
             pii.tax_percent, pii.discount_percent, pi.invoice_date
      FROM purchase_invoice_items pii
      JOIN purchase_invoices pi ON pii.invoice_id = pi.id
      JOIN suppliers s ON pi.supplier_id = s.id
      WHERE pii.drug_id = ?
      ORDER BY pi.invoice_date DESC
    `).all(drugId);
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
export async function getInventoryListAction(search?: string) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    let queryStr = `
      SELECT 
        i.id,
        i.drug_id,
        i.quantity,
        i.expiry_date,
        i.local_selling_price,
        m.trade_name,
        m.trade_name_en,
        m.generic_name,
        m.active_ingredient,
        m.category,
        m.manufacturer
      FROM inventory i
      JOIN master_drugs m ON i.drug_id = m.id
    `;
    const params: any[] = [];

    if (search && search.trim().length > 0) {
      queryStr += `
        WHERE m.trade_name LIKE ? 
           OR m.trade_name_en LIKE ? 
           OR m.generic_name LIKE ? 
           OR m.active_ingredient LIKE ?
           OR m.category LIKE ?
           OR m.manufacturer LIKE ?
      `;
      const searchPattern = `%${search.trim()}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }

    queryStr += ` ORDER BY i.expiry_date ASC LIMIT 200`;

    const data = await db.prepare(queryStr).all(...params) as any[];

    const { secureCache } = require('@/lib/cache/secure_cache');
    await secureCache.load();
    const enriched = secureCache.enrich(data);

    const mapped = enriched.map((item: any) => ({
      ...item,
      master_drugs: {
        trade_name: item.trade_name,
        trade_name_en: item.trade_name_en || item.trade_name || '',
        active_ingredient: item.active_ingredient || item.generic_name || '---',
        category: item.category,
        manufacturer: item.manufacturer
      }
    }));

    return { success: true, data: mapped };
  } catch (error: any) {
    console.error('getInventoryListAction Error:', error);
    return { success: false, error: error.message };
  }
}
