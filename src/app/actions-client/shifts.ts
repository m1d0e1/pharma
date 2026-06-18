
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

import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';


/**
 * Start a new shift (Alias for openShiftAction for compatibility)
 */
export async function openShiftAction(data: { starting_cash_amount: number; opening_notes?: string }) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    // Check if there's already an open shift for this user
    const existingShift = await db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'").get(user.id) as any;
    if (existingShift) {
      return { success: false, error: 'لديك وردية مفتوحة بالفعل' };
    }

    const shiftId = generateId();
    await db.prepare(`
      INSERT INTO shifts (id, user_id, starting_cash, notes, status)
      VALUES (?, ?, ?, ?, 'open')
    `).run(shiftId, user.id, data.starting_cash_amount, data.opening_notes || null);

    logActivity(user.id, 'START_SHIFT', `بدأ وردية جديدة بمبلغ ${data.starting_cash_amount}`);

    revalidatePath('/');
    return { success: true, shiftId };
  } catch (error) {
    console.error('Start shift error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'فشل بدء الوردية' };
  }
}

/**
 * End a shift (Alias for closeShiftAction for compatibility)
 */
export async function closeShiftAction(data: { shift_id?: string; ending_cash_amount: number; closing_notes?: string }) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    let shiftId = data.shift_id;
    if (!shiftId || shiftId === 'auto') {
      const openShift = await db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'open'").get(user.id) as any;
      if (!openShift) return { success: false, error: 'لا توجد وردية مفتوحة لإغلاقها' };
      shiftId = openShift.id;
    }

    const transaction = db.transaction(async () => {
      // 1. Calculate reconciliation difference
      const shift = await db.prepare('SELECT COALESCE(starting_cash, 0) as starting_cash FROM shifts WHERE id = ?').get(shiftId) as any;
      
      const sales = await db.prepare(`
        SELECT COALESCE(SUM(total_amount), 0) as total 
        FROM sales_invoices 
        WHERE shift_id = ? AND status = 'completed' AND payment_method IN ('cash', 'delivery')
      `).get(shiftId) as any;

      const returns = await db.prepare(`
        SELECT COALESCE(SUM(total_refund), 0) as total 
        FROM returns 
        WHERE shift_id = ? AND status = 'approved' AND refund_method = 'cash'
      `).get(shiftId) as any;

      const movements = await db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN type='receipt' THEN amount ELSE -amount END), 0) as net 
        FROM cash_movements 
        WHERE shift_id = ?
      `).get(shiftId) as any;

      const expectedCash = shift.starting_cash + sales.total - returns.total + movements.net;
      const difference = data.ending_cash_amount - expectedCash;

      // Determine status based on discrepancy (> 5 EGP)
      const status = Math.abs(difference) > 5 ? 'discrepancy' : 'closed';

      // 2. Update shift record
      await db.prepare(`
        UPDATE shifts 
        SET end_time = CURRENT_TIMESTAMP, ending_cash = ?, notes = ?, status = ?
        WHERE id = ?
      `).run(data.ending_cash_amount, data.closing_notes || null, status, shiftId);

      // 3. Accounting Reconciliation (Journal Entry)
      if (Math.abs(difference) > 0.01) {
        const journalId = generateId();
        const date = new Date().toISOString().split('T')[0];
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(journalId, date, `تسوية وردية: عجز/زيادة نقدية`, user.id, Math.abs(difference));

        const getAccountId = async (cat: string) => {
          const s = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
          return s?.account_id;
        };

        const cashAcc = await getAccountId('cash_drawer') || 6;
        const diffAcc = await getAccountId('cash_difference') || 13;

        if (difference > 0) {
          // Overage: Debit Cash (Asset), Credit Difference (Income/Gain)
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, cashAcc, 'debit', difference);
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, diffAcc, 'credit', difference);
        } else {
          // Shortage: Debit Difference (Loss/Expense), Credit Cash (Asset)
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, diffAcc, 'debit', Math.abs(difference));
          await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, cashAcc, 'credit', Math.abs(difference));
        }
      }

      logActivity(user.id, 'END_SHIFT', `أنهى الوردية بمبلغ ${data.ending_cash_amount}. الفرق: ${difference.toFixed(2)}`);
    });

    await transaction();
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('End shift error:', error);
    return { success: false, error: 'فشل إنهاء الوردية' };
  }
}

export async function getShiftsAction(filter: { status: string }) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_shifts')) return { success: false, error: 'غير مصرح' };

    const params: any[] = [];
    if (filter.status !== 'all') {
      params.push(filter.status);
    }

    const rawShifts = await db.prepare(`
      SELECT s.id, s.start_time as shift_start, s.end_time as shift_end, 
             s.starting_cash as starting_cash_amount, s.ending_cash as ending_cash_amount,
             s.status, s.notes as opening_notes, u.full_name, u.role,
             COALESCE(sales.total_sales, 0) as total_sales,
             COALESCE(rets.total_refunds, 0) as total_refunds,
             COALESCE(moves.net_movements, 0) as net_movements
      FROM shifts s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN (
        SELECT shift_id, SUM(total_amount) as total_sales
        FROM sales_invoices
        WHERE payment_method IN ('cash', 'delivery') AND status = 'completed'
        GROUP BY shift_id
      ) sales ON s.id = sales.shift_id
      LEFT JOIN (
        SELECT shift_id, SUM(total_refund) as total_refunds
        FROM returns
        WHERE refund_method = 'cash' AND status = 'approved'
        GROUP BY shift_id
      ) rets ON s.id = rets.shift_id
      LEFT JOIN (
        SELECT shift_id, SUM(CASE WHEN type='receipt' THEN amount ELSE -amount END) as net_movements
        FROM cash_movements
        GROUP BY shift_id
      ) moves ON s.id = moves.shift_id
      ${filter.status !== 'all' ? 'WHERE s.status = ?' : ''}
      ORDER BY s.start_time DESC LIMIT 50
    `).all(...params) as any[];
    
    const shifts = rawShifts.map(s => {
      const expectedCash = s.starting_cash_amount + s.total_sales - s.total_refunds + s.net_movements;
      const difference = s.status === 'closed' && s.ending_cash_amount !== null 
        ? (s.ending_cash_amount - expectedCash) 
        : 0;

      return {
        ...s,
        expected_cash_amount: expectedCash,
        cash_difference: difference,
        profiles: {
          full_name: s.full_name,
          role: s.role
        }
      };
    });

    return { success: true, data: shifts };
  } catch (error) {
    console.error('Get shifts error:', error);
    return { success: false, error: 'فشل جلب سجل الشفتات' };
  }
}

/**
 * Get current open shift
 */
export async function getCurrentShiftAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const shift = await db.prepare(`
      SELECT id, start_time as shift_start, starting_cash as starting_cash_amount, status
      FROM shifts 
      WHERE user_id = ? AND status = 'open'
    `).get(user.id) as any;

    return { 
      success: true, 
      data: shift || null,
      has_open_shift: !!shift 
    };
  } catch (error) {
    console.error('Get current shift error:', error);
    return { success: false, error: 'فشل جلب الوردية الحالية' };
  }
}

/**
 * Get stats for current open shift
 */
export async function getCurrentShiftStatsAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const shift = await db.prepare(`
      SELECT id, start_time, starting_cash
      FROM shifts 
      WHERE user_id = ? AND status = 'open'
    `).get(user.id) as any;

    if (!shift) return { success: false, error: 'لا توجد وردية مفتوحة' };

    // 1. All completed transactions count
    const countStats = await db.prepare(`
      SELECT COUNT(*) as transactions
      FROM sales_invoices
      WHERE shift_id = ? AND status = 'completed'
    `).get(shift.id) as any;

    // 2. Total sales revenue (all payment methods)
    const salesStats = await db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total_revenue
      FROM sales_invoices
      WHERE shift_id = ? AND status = 'completed'
    `).get(shift.id) as any;

    // 3. Cash-drawer sales revenue (cash & delivery)
    const cashSalesStats = await db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total_cash_revenue
      FROM sales_invoices
      WHERE shift_id = ? AND status = 'completed' AND payment_method IN ('cash', 'delivery')
    `).get(shift.id) as any;

    // 4. Cash returns
    const returnStats = await db.prepare(`
      SELECT COALESCE(SUM(total_refund), 0) as total_refunds
      FROM returns
      WHERE shift_id = ? AND status = 'approved' AND refund_method = 'cash'
    `).get(shift.id) as any;

    // 5. Cash movements (manual)
    const movementsStats = await db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN type='receipt' THEN amount ELSE -amount END), 0) as net
      FROM cash_movements
      WHERE shift_id = ?
    `).get(shift.id) as any;

    const startingCash = shift.starting_cash || 0;
    const totalRevenue = salesStats.total_revenue || 0;
    const totalCashRevenue = cashSalesStats.total_cash_revenue || 0;
    const totalRefunds = returnStats.total_refunds || 0;
    const netMovements = movementsStats.net || 0;

    const expectedCash = startingCash + totalCashRevenue - totalRefunds + netMovements;

    return { 
      success: true, 
      data: {
        ...shift,
        transactions: countStats.transactions || 0,
        revenue: totalRevenue, // Show total completed sales as "revenue"
        total_refunds: totalRefunds,
        expected_cash: expectedCash
      }
    };
  } catch (error) {
    console.error('Get shift stats error:', error);
    return { success: false, error: 'فشل جلب إحصائيات الوردية' };
  }
}

// Keep aliases for older versions if any
export async function startShiftAction(startingCash: number, notes?: string) {
  return openShiftAction({ starting_cash_amount: startingCash, opening_notes: notes });
}

export async function endShiftAction(endingCash: number, notes?: string) {
  // This is a wrapper for the older call signature used in LogoutModal
  return closeShiftAction({ 
    shift_id: 'auto', // Logic should find the open one
    ending_cash_amount: endingCash,
    closing_notes: notes
  });
}

/**
 * Force close all open shifts (Owner only)
 */
export async function forceCloseAllShiftsAction() {
  try {
    const user = await getLocalSession();
    if (!user || user.role !== 'owner') {
      return { success: false, error: 'غير مصرح - للمالك فقط' };
    }

    await db.prepare(`
      UPDATE shifts 
      SET end_time = CURRENT_TIMESTAMP, status = 'closed', notes = 'إغلاق اضطراري من قبل المالك'
      WHERE status = 'open'
    `).run();

    logActivity(user.id, 'FORCE_CLOSE_SHIFTS', 'قام المالك بإغلاق جميع الورديات المفتوحة اضطرارياً');

    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('Force close error:', error);
    return { success: false, error: 'فشل الإغلاق الاضطراري' };
  }
}
