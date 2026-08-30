import { secureCache } from '@/lib/cache/secure_cache';
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

import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';

function normalizePharmacyId(value: unknown): string {
  const pharmacyId = String(value ?? '').trim();
  return pharmacyId || 'local_default';
}

// Zod schema for adding inventory
const addInventorySchema = z.object({
  pharmacy_id: z.string().optional().nullable(),
  drug_id: z.coerce.number().int().positive('معرف الدواء يجب أن يكون رقم موجب'),
  quantity: z.coerce.number().positive('الكمية يجب أن تكون رقم موجب'),
  local_selling_price: z.coerce.number().nonnegative('السعر لا يمكن أن يكون سالباً'),
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ غير صحيحة (YYYY-MM-DD)'),
  barcode: z.string().optional().nullable(),
  unit: z.string().optional().nullable(),
  large_to_medium: z.coerce.number().int().positive().optional().nullable(),
});

// Zod schema for updating inventory
const updateInventorySchema = z.object({
  id: z.string().min(1, 'معرف المخزون غير صالح'),
  quantity: z.coerce.number().min(0, 'الكمية لا يمكن أن تكون سالبة'),
  local_selling_price: z.coerce.number().min(0, 'السعر لا يمكن أن يكون سالباً'),
  reason_id: z.coerce.number().optional().nullable(),
  large_to_medium: z.coerce.number().int().positive().optional().nullable(),
  expiry_date: z.preprocess(
    val => (typeof val === 'string' && val.trim() === '' ? null : val),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'صيغة التاريخ غير صحيحة (YYYY-MM-DD)').optional().nullable()
  ),
});

// Zod schema for deleting inventory
const deleteInventorySchema = z.object({
  id: z.string().min(1, 'معرف المخزون غير صالح'),
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
    const pharmacyId = normalizePharmacyId(localUser.pharmacy_id);

    // Step 4: Generate ID
    console.log('[addInventoryAction] Step 4: Generating UUID...');
    const id = generateId();
    console.log('[addInventoryAction] Step 4 result: id=', id);

    // Step 5: Insert
    console.log('[addInventoryAction] Step 5: Inserting into inventory...');
    console.log('[addInventoryAction] Step 5 params:', { id, pharmacy_id: pharmacyId, drug_id, quantity, local_selling_price, expiry_date, barcode: barcode || null, unit, large_to_medium });
    
    // Begin Transaction using single queries (or standard run)
    await db.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, quantity, local_selling_price, expiry_date, barcode, strips_per_box)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, pharmacyId, drug_id, quantity, local_selling_price, expiry_date, barcode || null, large_to_medium || 1);
    
    if (unit) {
      await db.prepare('UPDATE master_drugs SET large_unit = ? WHERE id = ?').run(unit, drug_id);
    }

    if (large_to_medium !== undefined && large_to_medium !== null) {
      await db.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(large_to_medium, drug_id);
    }

    if (barcode) {
      await db.prepare("UPDATE master_drugs SET barcode = ? WHERE id = ? AND (barcode IS NULL OR barcode = '')").run(barcode, drug_id);
    }

    if (unit || (large_to_medium !== undefined && large_to_medium !== null) || barcode) {
      secureCache.updateDrug(drug_id, {
        ...(unit ? { large_unit: unit } : {}),
        ...(large_to_medium !== undefined && large_to_medium !== null ? { large_to_medium } : {}),
        ...(barcode ? { barcode } : {})
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

    const current = await db.prepare(`
      SELECT i.quantity, i.drug_id
      FROM inventory i 
      WHERE i.id = ?
        AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
    `).get(id, pharmacyId, pharmacyId) as { quantity: number, drug_id: number };

    if (!current) return { success: false, error: 'الصنف غير موجود بالمخزون' };

    let updateInvQuery = `
      UPDATE inventory 
      SET quantity = ?, local_selling_price = ?, updated_at = CURRENT_TIMESTAMP
    `;
    const invParams: any[] = [quantity, local_selling_price];

    if (expiry_date) {
      updateInvQuery += `, expiry_date = ?`;
      invParams.push(expiry_date);
    }

    updateInvQuery += ` WHERE id = ?`;
    invParams.push(id);

    await db.prepare(updateInvQuery).run(...invParams);

    if (large_to_medium !== undefined && large_to_medium !== null) {
      await db.prepare('UPDATE master_drugs SET large_to_medium = ? WHERE id = ?').run(large_to_medium, current.drug_id);
      secureCache.updateDrug(current.drug_id, { large_to_medium });
    }

    // Keep selling price aligned across master_drugs & inventory
    await db.prepare('UPDATE master_drugs SET official_price = ? WHERE id = ?').run(local_selling_price, current.drug_id);
    secureCache.updateDrug(current.drug_id, { official_price: local_selling_price });

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
        const date = new Date().toISOString().split('T')[0];
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

    logActivity(localUser.id, 'UPDATE_INVENTORY', `عدل مخزون الصنف ${tradeName}: من ${current.quantity} إلى ${quantity}`);

    await secureCache.reload();

    revalidatePath('/inventory');
    revalidatePath('/');
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

    const remove = db.transaction(async () => {
      const current = await db.prepare(`
        SELECT i.drug_id, CAST(COALESCE(i.quantity, 0) AS REAL) AS quantity, i.batch_number,
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
export async function getLowStockAction(threshold?: number) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const defaultLimit = Number(threshold) > 0 ? Number(threshold) : 10;
    const pharmacyId = user.pharmacy_id || 'local_default';

    const items = await db.prepare(`
      WITH Params AS (
        SELECT ? AS pharmacy_id, ? AS default_limit
      ),
      DrugStock AS (
        SELECT 
          i.drug_id,
          SUM(COALESCE(i.quantity, 0)) AS current_stock,
          MIN(i.local_selling_price) AS local_selling_price,
          MIN(CASE WHEN i.quantity > 0 THEN i.expiry_date END) AS nearest_expiry,
          MAX(i.barcode) AS lot_barcode
        FROM inventory i
        CROSS JOIN Params p
        WHERE (i.pharmacy_id = p.pharmacy_id OR (i.pharmacy_id IS NULL AND p.pharmacy_id = 'local_default'))
          AND i.quantity > 0
          AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
        GROUP BY i.drug_id
      ),
      MonthlySales AS (
        SELECT 
          si.drug_id,
          SUM(
            CASE
              WHEN si.unit IN ('medium', 'strip', 'شريط') OR si.unit = m.medium_unit
                THEN si.quantity_sold / COALESCE(NULLIF(m.large_to_medium, 0), 1)
              WHEN si.unit = 'small' OR si.unit = m.small_unit
                THEN si.quantity_sold / (COALESCE(NULLIF(m.large_to_medium, 0), 1) * COALESCE(NULLIF(m.medium_to_small, 0), 1))
              ELSE si.quantity_sold
            END
          ) AS avg_monthly_usage
        FROM sales_items si
        JOIN sales_invoices inv ON si.invoice_id = inv.id
        JOIN master_drugs m ON m.id = si.drug_id
        CROSS JOIN Params p
        WHERE si.is_negative = 0 
          AND (inv.status IS NULL OR inv.status = '' OR inv.status IN ('completed', 'approved'))
          AND (inv.pharmacy_id = p.pharmacy_id OR (inv.pharmacy_id IS NULL AND p.pharmacy_id = 'local_default'))
          AND inv.created_at >= datetime('now', '-30 days')
        GROUP BY si.drug_id
      )
      SELECT 
        m.id,
        m.id AS drug_id,
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
      LEFT JOIN DrugStock ds ON m.id = ds.drug_id
      LEFT JOIN MonthlySales ms ON m.id = ms.drug_id
      WHERE (
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
      LIMIT 250
    `).all(pharmacyId, defaultLimit) as any[];

    return { success: true, data: items };
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
        SELECT si.id, si.invoice_id, si.quantity_sold
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

        if (settleQty === sale.quantity_sold) {
          // Fully settled this negative sale
          await db.prepare(`
            UPDATE sales_items 
            SET inventory_id = ?, is_negative = 0 
            WHERE id = ?
          `).run(newInventoryId, sale.id);
        } else {
          // Partially settled
          // 1. Update the original row to just the settled quantity, link to inventory, not negative
          await db.prepare(`
            UPDATE sales_items 
            SET inventory_id = ?, is_negative = 0, quantity_sold = ? 
            WHERE id = ?
          `).run(newInventoryId, settleQty, sale.id);

          // 2. Insert a new row for the remaining negative quantity
          const remainingQty = sale.quantity_sold - settleQty;
          await db.prepare(`
            INSERT INTO sales_items (invoice_id, inventory_id, drug_id, quantity_sold, unit_price, unit, is_negative, created_at)
            SELECT invoice_id, NULL, drug_id, ?, unit_price, unit, 1, created_at
            FROM sales_items WHERE id = ?
          `).run(remainingQty, sale.id);
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
  SELECT m.id as id, m.id as drug_id, SUM(i.quantity) as quantity, 'low_stock' as alert_type,
         m.trade_name, m.active_ingredient, m.manufacturer, m.trade_name_en
  FROM master_drugs m
  JOIN inventory i ON m.id = i.drug_id
  WHERE (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
    AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
  GROUP BY m.id
  HAVING SUM(i.quantity) <= COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), 10)
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

    const today = new Date().toISOString().split('T')[0];
    const threeMonthsLater = new Date();
    threeMonthsLater.setMonth(threeMonthsLater.getMonth() + 3);
    const threeMonthsStr = threeMonthsLater.toISOString().split('T')[0];

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

    const today = new Date();
    drug.expiry_batches = batches.map(b => ({
      ...b,
      is_expired: new Date(b.expiry_date) < today
    }));

    // Get Consumption Stats (Last 6 months)
    const consumption = await db.prepare(`
      SELECT strftime('%Y', si.created_at) as year, strftime('%m', si.created_at) as month,
             SUM(si.quantity_sold) as net_sales, COUNT(*) as transactions
      FROM sales_items si
      JOIN sales_invoices invoice ON invoice.id = si.invoice_id
      WHERE si.drug_id = ?
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
    const supplierHistory = await db.prepare(`
      SELECT s.id as supplier_id, s.name_ar as supplier_name, pii.cost_price, pii.selling_price, 
             pii.tax_percent, pii.discount_percent, pi.invoice_date
      FROM purchase_invoice_items pii
      JOIN purchase_invoices pi ON pii.invoice_id = pi.id
      JOIN suppliers s ON pi.supplier_id = s.id
      WHERE pii.drug_id = ?
        AND (pi.pharmacy_id = ? OR (pi.pharmacy_id IS NULL AND ? = 'local_default'))
      ORDER BY pi.invoice_date DESC
    `).all(drugId, pharmacyId, pharmacyId);
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
    if (!user) return { success: false, error: 'غير مصرح' };
    const pharmacyId = normalizePharmacyId(user.pharmacy_id);
    const inventoryFilter = drugId === undefined ? 'i.quantity > 0' : '(i.drug_id = ? AND i.quantity > 0)';

    let queryStr = `
      SELECT 
        i.id,
        i.drug_id,
        i.quantity,
        i.expiry_date,
        i.local_selling_price,
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
      if (ftsQuery) {
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

    // ponytail: LIMIT 1000 caps initial load; paginated on client anyway
    queryStr += ` ORDER BY i.expiry_date ASC LIMIT 1000`;

    const data = await db.prepare(queryStr).all(...params) as any[];

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


export async function getMovementsAction() { return { success: false, data: [] }; }
export async function getOpeningBalancesAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };
    const pharmacyId = normalizePharmacyId(user.pharmacy_id);

    const data = await db.prepare(`
      SELECT i.*, md.trade_name, md.trade_name_en
      FROM inventory i
      JOIN master_drugs md ON i.drug_id = md.id
      WHERE i.batch_number LIKE 'OPEN-%'
        AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
      ORDER BY i.created_at DESC
      LIMIT 100
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
  expiry_date: string;
}) {
  try {
    const session = await getLocalSession();
    if (!session || (!hasUserPermissionSync(session, 'can_view_opening_balances') && !hasUserPermissionSync(session, 'can_manage_inventory'))) {
      return { success: false, error: 'Unauthorized' };
    }

    const batchNumber = 'OPEN-' + generateId().substring(0, 8);
    
    await db.prepare(`
      INSERT INTO inventory (id, pharmacy_id, drug_id, batch_number, expiry_date, quantity, local_selling_price, cost_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(generateId(), session.pharmacy_id || 'local_default', data.drug_id, batchNumber, data.expiry_date, data.quantity, data.unit_price, data.cost_price);

    revalidatePath('/inventory');
    revalidatePath('/inventory/opening-balances');
    return { success: true };
  } catch (err: any) {
    console.error('addOpeningBalance error:', err);
    return { success: false, error: err.message || (typeof err === 'string' ? err : 'Error saving balance') };
  }
}
export async function getRestockItemsAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

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
export async function getAdjustmentsAction() { return { success: false, data: [] }; }
export async function getUnusedDrugsAction() {
  const { getUnusedItemsAction } = await import('./master-drugs');
  return getUnusedItemsAction();
}

export async function deleteDrugAction(id: number) {
  const { deleteMasterDrugAction } = await import('./master-drugs');
  return deleteMasterDrugAction(id);
}
