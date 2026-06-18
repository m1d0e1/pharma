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

const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

/**
 * Helper to get Arabic category label
 */
function getCategoryLabel(catCode: string): string {
  const FALLBACK_CATEGORIES = [
    { code: 'RENT', name_ar: 'إيجار' },
    { code: 'SALARIES', name_ar: 'رواتب وأجور' },
    { code: 'ELECTRICITY', name_ar: 'كهرباء' },
    { code: 'WATER', name_ar: 'مياه' },
    { code: 'INTERNET', name_ar: 'إنترنت' },
    { code: 'TRANSPORT', name_ar: 'نقل ومواصلات' },
    { code: 'SUPPLIES', name_ar: 'مستلزمات ومواد' },
    { code: 'OTHER', name_ar: 'مصاريف متنوعة' },
  ];
  const cat = FALLBACK_CATEGORIES.find(c => c.code.toUpperCase() === catCode.toUpperCase());
  return cat ? cat.name_ar : catCode;
}

/**
 * Helper to dynamically resolve or create an account for a given expense category
 */
async function getOrCreateExpenseAccount(categoryCode: string): Promise<number> {
  const mapping: { [key: string]: { code: string; nameAr: string; nameEn: string } } = {
    RENT: { code: '511', nameAr: 'إيجار', nameEn: 'Rent' },
    ELECTRICITY: { code: '512', nameAr: 'كهرباء', nameEn: 'Electricity' },
    SALARIES: { code: '513', nameAr: 'أجور ومرتبات', nameEn: 'Salaries' },
    INTERNET: { code: '514', nameAr: 'إنترنت', nameEn: 'Internet' },
    TRANSPORT: { code: '515', nameAr: 'نقل ومواصلات', nameEn: 'Transport' },
    SUPPLIES: { code: '516', nameAr: 'مستلزمات ومواد', nameEn: 'Supplies' },
    WATER: { code: '517', nameAr: 'مياه', nameEn: 'Water' },
    OTHER: { code: '519', nameAr: 'مصاريف متنوعة', nameEn: 'Other' },
  };

  const info = mapping[categoryCode.toUpperCase()] || { code: '519', nameAr: 'مصاريف متنوعة', nameEn: 'Other' };
  
  // 1. Try to find by code
  let account = await db.prepare("SELECT id FROM accounts WHERE code = ?").get(info.code) as any;
  if (account) {
    return account.id;
  }

  // 2. Try to find by name_en or name_ar
  account = await db.prepare("SELECT id FROM accounts WHERE name_en = ? OR name_ar = ?").get(info.nameEn, info.nameAr) as any;
  if (account) {
    return account.id;
  }

  // 3. Create it under parent_id = 10 (Operating Expenses)
  const res = await db.prepare(`
    INSERT INTO accounts (parent_id, code, name_ar, name_en, type, is_group, balance)
    VALUES (10, ?, ?, ?, 'expense', 0, 0)
  `).run(info.code, info.nameAr, info.nameEn);

  return res.lastInsertId;
}

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
    if (!user) return { success: false, error: 'غير مصرح' };

    const expenseId = generateId();
    const cashMovementId = generateId();
    const journalId = generateId();

    const transaction = db.transaction(async () => {
      // 1. Resolve accounts
      const cashDrawerSetting = await db.prepare("SELECT account_id FROM trial_balance_settings WHERE category = 'cash_drawer'").get() as any;
      const mainCashAccountId = cashDrawerSetting?.account_id || (await db.prepare("SELECT id FROM accounts WHERE code = '111'").get() as any)?.id || 7;
      
      const categoryAccountId = await getOrCreateExpenseAccount(data.category);

      // 2. Get active shift if any
      const openShift = await db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'").get(user.id) as any;
      const shiftId = openShift?.id || null;

      // 3. Insert into expenses
      await db.prepare(`
        INSERT INTO expenses (id, user_id, category, amount, description, date, cash_movement_id, journal_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(expenseId, user.id, data.category, data.amount, data.description || null, data.date, cashMovementId, journalId);

      // 4. Insert into cash_movements (Disbursement)
      await db.prepare(`
        INSERT INTO cash_movements (
          id, user_id, shift_id, type, category, sub_category, 
          amount, notes, date, actual_date
        ) VALUES (?, ?, ?, 'disbursement', 'operating_expense', ?, ?, ?, ?, ?)
      `).run(
        cashMovementId, user.id, shiftId, data.category, 
        data.amount, data.description || null, data.date, new Date().toISOString()
      );

      // 5. Insert into daily_journals
      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        journalId, data.date, 
        `مصروف: ${getCategoryLabel(data.category)} - ${data.description || ''}`, 
        user.id, data.amount
      );

      // 6. Insert into journal_entries (Debit expense account, Credit cash drawer)
      await db.prepare(`
        INSERT INTO journal_entries (journal_id, account_id, type, amount, notes)
        VALUES (?, ?, 'debit', ?, ?)
      `).run(journalId, categoryAccountId, data.amount, data.description || null);

      await db.prepare(`
        INSERT INTO journal_entries (journal_id, account_id, type, amount, notes)
        VALUES (?, ?, 'credit', ?, ?)
      `).run(journalId, mainCashAccountId, data.amount, data.description || null);
    });

    await transaction();

    logActivity(user.id, 'ADD_EXPENSE', `${data.category}: ${data.amount} ج.م - ${data.description}`);

    revalidatePath('/expenses');
    return { success: true, id: expenseId };
  } catch (error) {
    console.error('Add expense error:', error);
    return { success: false, error: 'فشل إضافة المصروف وتحديث الحسابات' };
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
    if (!user || user.role !== 'owner') return { success: false, error: 'غير مصرح' };

    const expense = await db.prepare('SELECT cash_movement_id, journal_id, amount, category FROM expenses WHERE id = ?').get(id) as any;
    if (!expense) return { success: false, error: 'المصروف غير موجود' };

    const transaction = db.transaction(async () => {
      if (expense.journal_id) {
        await db.prepare('DELETE FROM journal_entries WHERE journal_id = ?').run(expense.journal_id);
        await db.prepare('DELETE FROM daily_journals WHERE id = ?').run(expense.journal_id);
      }
      if (expense.cash_movement_id) {
        await db.prepare('DELETE FROM cash_movements WHERE id = ?').run(expense.cash_movement_id);
      }
      await db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
    });

    await transaction();

    logActivity(user.id, 'DELETE_EXPENSE', `حذف مصروف #${id.substring(0, 8)} بمبلغ ${expense.amount}`);

    revalidatePath('/expenses');
    return { success: true };
  } catch (error) {
    console.error('Delete expense error:', error);
    return { success: false, error: 'فشل حذف المصروف وتحديث الحسابات' };
  }
}

/**
 * Get expense summary (for dashboard widget and P&L cards)
 */
export async function getExpenseSummaryAction(month?: string) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const targetMonth = month || new Date().toLocaleDateString('en-CA').substring(0, 7); // YYYY-MM in local timezone

    const byCategory = await db.prepare(`
      SELECT category, SUM(amount) as total 
      FROM expenses 
      WHERE date LIKE ? || '%'
      GROUP BY category 
      ORDER BY total DESC
    `).all(targetMonth) as any[];

    const totalExpenses = byCategory.reduce((sum, c) => sum + c.total, 0);

    const totalRevenueRes = await db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as revenue
      FROM sales_invoices
      WHERE created_at LIKE ? || '%' AND status IN ('completed', 'delivered')
    `).get(targetMonth) as any;

    const totalReturnsRes = await db.prepare(`
      SELECT COALESCE(SUM(total_refund), 0) as refunds
      FROM returns
      WHERE created_at LIKE ? || '%' AND status = 'approved'
    `).get(targetMonth) as any;

    // Calculate total COGS (Gross Sales COGS - Returned COGS)
    const grossCogsRes = await db.prepare(`
      SELECT COALESCE(SUM(si.quantity_sold * si.cost_price), 0) as cogs
      FROM sales_items si
      JOIN sales_invoices s ON si.invoice_id = s.id
      WHERE s.created_at LIKE ? || '%' AND s.status IN ('completed', 'delivered')
    `).get(targetMonth) as any;

    const returnedCogsRes = await db.prepare(`
      SELECT COALESCE(SUM(ri.quantity_returned * COALESCE(si.cost_price, i.cost_price, 0)), 0) as returned_cogs
      FROM return_items ri
      JOIN returns r ON ri.return_id = r.id
      LEFT JOIN sales_items si ON r.invoice_id = si.invoice_id AND ri.inventory_id = si.inventory_id
      LEFT JOIN inventory i ON ri.inventory_id = i.id
      WHERE r.created_at LIKE ? || '%' AND r.status = 'approved'
    `).get(targetMonth) as any;

    const totalRevenue = totalRevenueRes?.revenue || 0;
    const totalReturns = totalReturnsRes?.refunds || 0;
    const grossCogs = grossCogsRes?.cogs || 0;
    const returnedCogs = returnedCogsRes?.returned_cogs || 0;
    const totalCOGS = Math.max(0, grossCogs - returnedCogs);

    return {
      success: true,
      data: {
        byCategory,
        totalExpenses,
        totalRevenue,
        totalReturns,
        totalCOGS,
        netProfit: (totalRevenue - totalReturns) - totalCOGS - totalExpenses,
      }
    };
  } catch (error) {
    console.error('Get expense summary error:', error);
    return { success: false, error: 'فشل جلب ملخص المصروفات' };
  }
}

