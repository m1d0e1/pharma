
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




import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { createCashMovementAction } from './finance';

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

/**
 * Add an expense
 */
export async function addExpenseAction(data: {
  category: string;
  amount: number;
  description: string;
  date: string;
}) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'acc_can_define_expenses')) return { success: false, error: 'غير مصرح' };
    if (!Number.isFinite(data.amount) || data.amount <= 0) return { success: false, error: 'مبلغ المصروف غير صالح' };
    if (!data.category.trim() || !data.date) return { success: false, error: 'بيانات المصروف غير مكتملة' };

    const id = generateId();
    await dbTransaction(async () => {
      await db.prepare(`
        INSERT INTO expenses (id, user_id, category, amount, description, date)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, user.id, data.category, data.amount, data.description, data.date);

      const cashMovement = await createCashMovementAction({
        type: 'disbursement',
        category: 'operating_expenses',
        sub_category: data.category,
        amount: data.amount,
        notes: data.description,
        date: data.date,
      });
      if (!cashMovement.success) throw new Error(cashMovement.error || 'فشل تسجيل حركة المصروف النقدية');
    });

    await logActivity(user.id, 'ADD_EXPENSE', `${data.category}: ${data.amount} ج.م - ${data.description}`);

    revalidatePath('/expenses');
    return { success: true, id };
  } catch (error) {
    console.error('Add expense error:', error);
    return { success: false, error: 'فشل إضافة المصروف' };
  }
}

/**
 * Get expenses with optional date range filter
 */
export async function getExpensesAction(filter?: { from?: string; to?: string; category?: string }) {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'can_view_expenses') && !hasUserPermissionSync(user, 'acc_can_define_expenses'))) return { success: false, error: 'غير مصرح' };

    let query = `
      SELECT e.*, u.full_name as user_name 
      FROM expenses e 
      JOIN users u ON e.user_id = u.id 
      WHERE 1=1
    `;
    const params: any[] = [];

    if (filter?.from) {
      query += ' AND e.date >= ?';
      params.push(filter.from);
    }
    if (filter?.to) {
      query += ' AND e.date <= ?';
      params.push(filter.to);
    }
    if (filter?.category && filter.category !== 'all') {
      query += ' AND e.category = ?';
      params.push(filter.category);
    }

    query += ' ORDER BY e.date DESC, e.created_at DESC LIMIT 200';

    const expenses = await db.prepare(query).all(...params);
    return { success: true, data: expenses };
  } catch (error) {
    return { success: false, error: 'فشل جلب المصروفات' };
  }
}

/**
 * Delete an expense
 */
export async function deleteExpenseAction(id: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'acc_can_define_expenses')) return { success: false, error: 'غير مصرح' };

    const expense = await db.prepare('SELECT id FROM expenses WHERE id = ?').get(id);
    if (!expense) return { success: false, error: 'المصروف غير موجود' };

    return {
      success: false,
      error: 'لا يمكن حذف مصروف مُرحّل حفاظاً على سلامة الخزينة والقيود المحاسبية. سجّل حركة عكسية موثقة بدلاً من الحذف.',
    };
  } catch (error) {
    return { success: false, error: 'فشل حذف المصروف' };
  }
}

/**
 * Get expense summary (for dashboard widget)
 */
export async function getExpenseSummaryAction(month?: string) {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'can_view_expenses') && !hasUserPermissionSync(user, 'acc_can_define_expenses'))) return { success: false, error: 'غير مصرح' };

    const targetMonth = month || new Date().toISOString().substring(0, 7); // YYYY-MM

    const byCategory = await db.prepare(`
      SELECT category, SUM(amount) as total 
      FROM expenses 
      WHERE date LIKE ? || '%'
      GROUP BY category 
      ORDER BY total DESC
    `).all(targetMonth) as any[];

    const totalExpenses = byCategory.reduce((sum, c) => sum + c.total, 0);

    const totalRevenue = await db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as revenue
      FROM sales_invoices
      WHERE created_at LIKE ? || '%'
    `).get(targetMonth) as any;

    const totalReturns = await db.prepare(`
      SELECT COALESCE(SUM(total_refund), 0) as refunds
      FROM returns
      WHERE created_at LIKE ? || '%'
        AND status IN ('approved', 'completed')
    `).get(targetMonth) as any;

    const soldCogs = await db.prepare(`
      SELECT COALESCE(SUM(
        COALESCE(si.cost_price, 0) *
        CASE
          WHEN si.unit IN ('medium', 'strip', 'شريط') OR si.unit = md.medium_unit
            THEN si.quantity_sold / COALESCE(NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1)
          WHEN si.unit = 'small' OR si.unit = md.small_unit
            THEN si.quantity_sold / (
              COALESCE(NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) *
              COALESCE(NULLIF(md.medium_to_small, 0), 1)
            )
          ELSE si.quantity_sold
        END
      ), 0) AS cogs
      FROM sales_items si
      JOIN sales_invoices invoice ON invoice.id = si.invoice_id
      LEFT JOIN inventory i ON i.id = si.inventory_id
      LEFT JOIN master_drugs md ON md.id = si.drug_id
      WHERE invoice.created_at LIKE ? || '%'
        AND invoice.status IN ('completed', 'delivered')
        AND COALESCE(si.is_negative, 0) = 0
    `).get(targetMonth) as any;

    const returnedCogs = await db.prepare(`
      SELECT COALESCE(SUM(
        COALESCE(si.cost_price, 0) *
        CASE
          WHEN ri.unit IN ('medium', 'strip', 'شريط') OR ri.unit = md.medium_unit
            THEN ri.quantity_returned / COALESCE(NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1)
          WHEN ri.unit = 'small' OR ri.unit = md.small_unit
            THEN ri.quantity_returned / (
              COALESCE(NULLIF(i.strips_per_box, 0), NULLIF(md.large_to_medium, 0), 1) *
              COALESCE(NULLIF(md.medium_to_small, 0), 1)
            )
          ELSE ri.quantity_returned
        END
      ), 0) AS cogs
      FROM return_items ri
      JOIN returns r ON r.id = ri.return_id
      LEFT JOIN sales_items si ON si.id = ri.sale_item_id
      LEFT JOIN inventory i ON i.id = COALESCE(ri.inventory_id, si.inventory_id)
      LEFT JOIN master_drugs md ON md.id = COALESCE(ri.drug_id, si.drug_id)
      WHERE r.created_at LIKE ? || '%'
        AND r.status IN ('approved', 'completed')
    `).get(targetMonth) as any;

    const revenue = Number(totalRevenue?.revenue || 0);
    const refunds = Number(totalReturns?.refunds || 0);
    const totalCOGS = Number(soldCogs?.cogs || 0) - Number(returnedCogs?.cogs || 0);

    return {
      success: true,
      data: {
        byCategory,
        totalExpenses,
        totalRevenue: revenue,
        totalReturns: refunds,
        totalCOGS,
        netProfit: revenue - refunds - totalCOGS - totalExpenses,
      }
    };
  } catch (error) {
    return { success: false, error: 'فشل جلب ملخص المصروفات' };
  }
}
