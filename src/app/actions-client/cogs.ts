
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




import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { secureCache } from '@/lib/cache/secure_cache';
const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

export async function getSoldItemsForCogsAdjustmentAction(searchTerm: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_cogs')) return { success: false, error: 'غير مصرح' };

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
      ORDER BY s.created_at DESC
    `).all() as any[];

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
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user || !hasUserPermissionSync(user, 'can_view_cogs')) return { success: false, error: 'غير مصرح' };

    await db.prepare('UPDATE sales_items SET cost_price = ? WHERE id = ?').run(newCost, itemId);
    await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(user.id, 'COGS_ADJUSTMENT', `Adjusted cost for sold item ${itemId} to ${newCost}`);

    revalidatePath('/reports/cogs');
    return { success: true };
  } catch (error) {
    return { success: false, error: 'فشل تعديل التكلفة' };
  }
}
