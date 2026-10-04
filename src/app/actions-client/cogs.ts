
import { dbSelect, dbExecute, dbGet, dbTransaction, generateId } from '@/lib/db/tauri';

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




import { getLocalSession } from '@/lib/auth/local';
import { isStaffOwner } from '@/lib/auth/staff-policy';
import { secureCache } from '@/lib/cache/secure_cache';
const revalidatePath = (...args: any[]) => {};

function unitsPerLarge(
  unit: string | undefined,
  largeToMedium: number,
  mediumToSmall: number,
  mediumUnit?: string,
  smallUnit?: string,
) {
  const value = String(unit || 'large').trim().toLowerCase();
  const configuredMedium = String(mediumUnit || '').trim().toLowerCase();
  const configuredSmall = String(smallUnit || '').trim().toLowerCase();
  if (value === 'medium' || value === 'strip' || value === 'شريط' || (configuredMedium && value === configuredMedium)) {
    return largeToMedium;
  }
  if (value === 'small' || value === 'unit' || value === 'pill' || (configuredSmall && value === configuredSmall)) {
    return largeToMedium * mediumToSmall;
  }
  return 1;
}

export async function getSoldItemsForCogsAdjustmentAction(searchTerm: string) {
  try {
    const user = await getLocalSession();
    if (!isStaffOwner(user)) return { success: false, error: 'غير مصرح' };
    const pharmacyId = user?.pharmacy_id || 'local_default';

    const items = await db.prepare(`
      SELECT 
        si.*, 
        COALESCE(si.cost_price, inv.cost_price, 0) as current_inv_cost,
        s.created_at as invoice_date,
        m.trade_name, m.trade_name_en, m.active_ingredient
      FROM sales_items si
      JOIN inventory inv ON si.inventory_id = inv.id
      JOIN sales_invoices s ON si.invoice_id = s.id
      JOIN master_drugs m ON si.drug_id = m.id
      WHERE (s.status IS NULL OR s.status = '' OR LOWER(s.status) IN ('completed', 'approved', 'delivered'))
        AND (
          s.pharmacy_id = ?
          OR (? = 'local_default' AND (s.pharmacy_id IS NULL OR TRIM(s.pharmacy_id) = ''))
        )
      ORDER BY s.created_at DESC
    `).all(pharmacyId, pharmacyId) as any[];

    const filtered = items.filter((item: any) => {
      const s = searchTerm.toLowerCase();
      return (
        (item.trade_name && item.trade_name.toLowerCase().includes(s)) ||
        (item.trade_name_en && item.trade_name_en.toLowerCase().includes(s)) ||
        item.invoice_id?.toString().includes(s) ||
        item.id?.toString().includes(s)
      );
    }).slice(0, 50);

    return { success: true, data: filtered };
  } catch (error) {
    return { success: false, error: 'فشل جلب الأصناف' };
  }
}

export async function updateSoldItemCostAction(itemId: number | string, newCost: number) {
  try {
    const user = await getLocalSession();
    if (!isStaffOwner(user)) return { success: false, error: 'غير مصرح' };
    if (!Number.isFinite(newCost) || newCost <= 0) return { success: false, error: 'التكلفة الجديدة غير صالحة' };
    const pharmacyId = user?.pharmacy_id || 'local_default';

    await dbTransaction(async (db) => {
      const item = await db.prepare(`
        SELECT si.id, si.invoice_id, si.quantity_sold, si.unit,
               COALESCE(si.cost_price, 0) AS old_cost,
               COALESCE(NULLIF(si.large_to_medium, 0), NULLIF(inv.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) AS large_to_medium,
               COALESCE(NULLIF(si.medium_to_small, 0), NULLIF(inv.medium_to_small, 0), NULLIF(md.medium_to_small, 0), 1) AS medium_to_small,
               md.medium_unit, md.small_unit
        FROM sales_items si
        JOIN sales_invoices s ON s.id = si.invoice_id
        LEFT JOIN inventory inv ON inv.id = si.inventory_id
        LEFT JOIN master_drugs md ON md.id = si.drug_id
        WHERE si.id = ?
          AND (s.status IS NULL OR s.status = '' OR LOWER(s.status) IN ('completed', 'approved', 'delivered'))
          AND (
            s.pharmacy_id = ?
            OR (? = 'local_default' AND (s.pharmacy_id IS NULL OR TRIM(s.pharmacy_id) = ''))
          )
      `).get(itemId, pharmacyId, pharmacyId) as any;
      if (!item) throw new Error('الصنف المباع غير موجود أو الفاتورة غير مكتملة');

      const oldCost = Number(item.old_cost || 0);
      const largeToMedium = Number(item.large_to_medium) > 0 ? Number(item.large_to_medium) : 1;
      const mediumToSmall = Number(item.medium_to_small) > 0 ? Number(item.medium_to_small) : 1;
      const saleUnit = String(item.unit || 'large').trim() || 'large';
      const saleUnitsPerLarge = unitsPerLarge(
        saleUnit,
        largeToMedium,
        mediumToSmall,
        item.medium_unit,
        item.small_unit,
      );
      const priorReturns = await db.prepare(`
        SELECT ri.quantity_returned, ri.unit
        FROM return_items ri
        JOIN returns r ON r.id = ri.return_id
        WHERE ri.sale_item_id = ?
          AND r.invoice_id = ?
          AND LOWER(COALESCE(r.status, '')) IN ('approved', 'completed')
      `).all(itemId, item.invoice_id) as any[];
      const returnedInSaleUnit = priorReturns.reduce((sum, prior) => {
        const historicalUnit = String(prior.unit || '').trim() || saleUnit;
        const returnedUnitsPerLarge = unitsPerLarge(
          historicalUnit,
          largeToMedium,
          mediumToSmall,
          item.medium_unit,
          item.small_unit,
        );
        return sum + (Number(prior.quantity_returned || 0) * saleUnitsPerLarge / returnedUnitsPerLarge);
      }, 0);
      const soldQty = Math.max(0, Number(item.quantity_sold || 0) - returnedInSaleUnit);
      const baseQty = soldQty / saleUnitsPerLarge;
      const delta = (newCost - oldCost) * baseQty;

      await db.prepare('UPDATE sales_items SET cost_price = ? WHERE id = ?').run(newCost, itemId);

      if (Math.abs(delta) > 0.000001) {
        const getAccount = async (category: string, fallback: number) => {
          const row = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ? LIMIT 1').get(category) as any;
          return Number(row?.account_id || fallback);
        };
        const cogsAccount = await getAccount('cogs_expense', 11);
        const inventoryAccount = await getAccount('inventory_asset', 10);
        const amount = Math.abs(delta);
        const journalId = generateId();
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount, pharmacy_id)
          VALUES (?, date('now', 'localtime'), ?, ?, ?, ?)
        `).run(journalId, `COGS adjustment sale item #${itemId}`, user.id, amount, pharmacyId);
        const debitAccount = delta > 0 ? cogsAccount : inventoryAccount;
        const creditAccount = delta > 0 ? inventoryAccount : cogsAccount;
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, debitAccount, 'debit', amount);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, creditAccount, 'credit', amount);
      }

      await db.prepare('INSERT INTO activity_log (user_id, action, details, pharmacy_id) VALUES (?, ?, ?, ?)').run(
        user.id,
        'COGS_ADJUSTMENT',
        `Adjusted cost for sold item ${itemId} from ${oldCost} to ${newCost}; net quantity ${baseQty}`,
        pharmacyId,
      );
    });

    revalidatePath('/reports/cogs');
    return { success: true };
  } catch (error) {
    return { success: false, error: 'فشل تعديل التكلفة' };
  }
}
