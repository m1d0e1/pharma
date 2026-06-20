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




import { getLocalSession } from '@/lib/auth/local';
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
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user) return { success: false, error: 'غير مصرح' };

    const id = generateId();
    await db.prepare(`
      INSERT INTO expenses (id, user_id, category, amount, description, date)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, user.id, data.category, data.amount, data.description, data.date);

    logActivity(user.id, 'ADD_EXPENSE', `${data.category}: ${data.amount} ج.م - ${data.description}`);

    // Create a cash movement to ensure double-entry accounting updates
    await createCashMovementAction({
      type: 'disbursement',
      category: 'operating_expenses',
      sub_category: data.category,
      amount: data.amount,
      notes: data.description,
      date: data.date,
    });

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
    if (!user) return { success: false, error: 'غير مصرح' };

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
    if (!user || (user.role !== 'owner' && user.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!user || user.role !== 'owner') return { success: false, error: 'غير مصرح' };

    await db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    logActivity(user.id, 'DELETE_EXPENSE', `حذف مصروف #${id.substring(0, 8)}`);

    revalidatePath('/expenses');
    return { success: true };
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
    if (!user) return { success: false, error: 'غير مصرح' };

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
    `).get(targetMonth) as any;

    return {
      success: true,
      data: {
        byCategory,
        totalExpenses,
        totalRevenue: totalRevenue?.revenue || 0,
        totalReturns: totalReturns?.refunds || 0,
        netProfit: (totalRevenue?.revenue || 0) - totalExpenses - (totalReturns?.refunds || 0),
      }
    };
  } catch (error) {
    return { success: false, error: 'فشل جلب ملخص المصروفات' };
  }
}
