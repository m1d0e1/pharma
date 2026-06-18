
import { dbSelect, dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';
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




import { getLocalSession } from '@/lib/auth/local';


const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

// Get distinct ingredients from the drug_interactions table in SQLite
async function getDbIngredients() {
  const rows = await dbSelect<{ ingredient_a: string; ingredient_b: string }>(
    'SELECT DISTINCT ingredient_a, ingredient_b FROM drug_interactions'
  );
  const ingredients = new Set<string>();
  for (const r of rows) {
    ingredients.add(r.ingredient_a.toLowerCase());
    ingredients.add(r.ingredient_b.toLowerCase());
  }
  return Array.from(ingredients);
}


/**
 * Check for drug interactions between items in the cart and patient's history
 */
export async function checkDrugInteractions(cartIngredients: string[], patientId?: string) {
  try {
    const cartIngs: string[] = [];
    
    const parseIngredients = (input: string) => {
      if (!input) return [];
      // Split by '+', '/', ',', ';', and ignore extra spaces
      return input.split(/[+\/,\;]/).map(p => p.trim()).filter(p => p.length > 2);
    };

    cartIngredients.forEach(i => {
      parseIngredients(i).forEach(ing => cartIngs.push(ing));
    });

    // If patient is linked, also get their past purchase ingredients
    if (patientId) {
      const pastSales = await db.prepare(`
        SELECT DISTINCT i.drug_id
        FROM sales_items si
        JOIN sales_invoices inv ON si.invoice_id = inv.id
        JOIN inventory i ON si.inventory_id = i.id
        WHERE inv.patient_id = ?
          AND inv.created_at >= datetime('now', '-90 days')
      `).all(patientId) as any[];

      // Look up active ingredients from master_drugs via SQL JOIN
      const pastDrugIds = pastSales.map((item: any) => item.drug_id).filter(Boolean);
      if (pastDrugIds.length > 0) {
        const placeholdersPast = pastDrugIds.map(() => '?').join(',');
        const drugRows = await dbSelect<{ active_ingredient: string }>(
          `SELECT active_ingredient FROM master_drugs WHERE id IN (${placeholdersPast}) AND active_ingredient IS NOT NULL AND active_ingredient != ''`,
          pastDrugIds
        );
        drugRows.forEach(row => {
          parseIngredients(row.active_ingredient).forEach(ing => cartIngs.push(ing));
        });
      }
    }

    // Check patient allergies
    const allergies: any[] = [];
    if (patientId) {
      const patientAllergies = await db.prepare('SELECT * FROM patient_allergies WHERE patient_id = ?').all(patientId) as any[];
      for (const allergy of patientAllergies) {
        for (const ingredient of cartIngs) {
          const cleanIng = ingredient.toLowerCase();
          const cleanAllergen = allergy.allergen.toLowerCase();
          if (cleanIng.includes(cleanAllergen) || cleanAllergen.includes(cleanIng)) {
            allergies.push({
              type: 'allergy',
              severity: 'critical',
              allergen: allergy.allergen,
              ingredient,
              description_ar: `المريض لديه حساسية مسجلة ضد ${allergy.allergen}`,
            });
          }
        }
      }
    }

    // Check drug-drug interactions
    if (cartIngs.length < 2) {
      return { success: true, data: { interactions: [], allergies, hasCritical: allergies.length > 0, hasMajor: false } };
    }

    const dbIngredients = await getDbIngredients();
    const matched = new Set<string>();

    const cleanStr = (s: string) => {
      let cleaned = s
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      cleaned = cleaned.split(' ').map(word => {
        if (word.endsWith('e') && word.length > 4) {
          return word.slice(0, -1);
        }
        return word;
      }).join(' ');

      return cleaned;
    };

    const checkSub = (longer: string, shorter: string) => {
      const escaped = shorter.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      return regex.test(longer);
    };

    const matchIngredients = (cartIng: string, dbIng: string) => {
      const p1 = cleanStr(cartIng);
      const p2 = cleanStr(dbIng);
      if (!p1 || !p2) return false;
      if (p1 === p2) return true;
      if (p1.length > p2.length) {
        return checkSub(p1, p2);
      } else {
        return checkSub(p2, p1);
      }
    };

    for (const cartIng of cartIngs) {
      for (const dbIng of dbIngredients) {
        if (matchIngredients(cartIng, dbIng)) {
          matched.add(dbIng);
        }
      }
    }

    const matchedArray = Array.from(matched);
    if (matchedArray.length < 2) {
      return {
        success: true,
        data: {
          interactions: [],
          allergies,
          hasCritical: allergies.length > 0,
          hasMajor: false,
        }
      };
    }

    const placeholders = matchedArray.map(() => '?').join(',');
    const stmt = db.prepare(`
      SELECT * FROM drug_interactions 
      WHERE ingredient_a IN (${placeholders}) 
        AND ingredient_b IN (${placeholders})
    `);

    const pairs = await stmt.all(...matchedArray, ...matchedArray) as any[];

    const interactionsFound = new Set<string>(); // To avoid duplicates
    const results: any[] = [];

    for (const p of pairs) {
      const key = `${p.ingredient_a}_${p.ingredient_b}`;
      if (!interactionsFound.has(key)) {
        interactionsFound.add(key);
        results.push({
          type: 'interaction',
          severity: p.severity,
          ingredient_a: p.ingredient_a,
          ingredient_b: p.ingredient_b,
          description_ar: p.description_ar || p.description_en,
          description_en: p.description_en,
          recommendation: p.recommendation,
        });
      }
    }

    return {
      success: true,
      data: {
        interactions: results,
        allergies,
        hasCritical: [...results, ...allergies].some(i => i.severity === 'critical'),
        hasMajor: [...results, ...allergies].some(i => i.severity === 'major'),
      }
    };
  } catch (error) {
    console.error('Drug interaction check error:', error);
    return { success: false, error: 'فشل فحص التفاعلات الدوائية' };
  }
}

/**
 * Get paginated interactions
 */
export async function getInteractionsAction(page: number = 1, limit: number = 50, search: string = '', severity: string = 'all') {
  try {
    const offset = (page - 1) * limit;
    let query = 'SELECT * FROM drug_interactions WHERE 1=1';
    const params: any[] = [];

    if (search) {
      query += ' AND (ingredient_a LIKE ? OR ingredient_b LIKE ? OR description_ar LIKE ? OR description_en LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }

    if (severity !== 'all') {
      query += ' AND severity = ?';
      params.push(severity);
    }

    const total = await db.prepare(`SELECT COUNT(*) as count FROM (${query})`).get(...params) as any;
    
    query += ' ORDER BY severity DESC, ingredient_a ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const data = await db.prepare(query).all(...params);

    return { 
      success: true, 
      data, 
      total: total.count,
      pages: Math.ceil(total.count / limit)
    };
  } catch (error) {
    console.error('Fetch interactions error:', error);
    return { success: false, error: 'فشل جلب التفاعلات' };
  }
}

/**
 * Add a new drug interaction
 */
export async function addInteractionAction(data: {
  ingredient_a: string;
  ingredient_b: string;
  severity: string;
  description_ar: string;
  recommendation: string;
}) {
  try {
    const user = await getLocalSession();
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user || user.role !== 'owner') return { success: false, error: 'غير مصرح' };

    await db.prepare(`
      INSERT INTO drug_interactions (ingredient_a, ingredient_b, severity, description_ar, recommendation)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.ingredient_a, data.ingredient_b, data.severity, data.description_ar, data.recommendation);

    // Cache invalidation no longer needed as we use RAM cache

    logActivity(user.id, 'ADD_INTERACTION', `أضاف تفاعل: ${data.ingredient_a} + ${data.ingredient_b}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: 'فشل إضافة التفاعل' };
  }
}
