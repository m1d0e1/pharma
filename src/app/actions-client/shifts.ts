
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
export async function openShiftAction(data: { starting_cash_amount: number; opening_notes?: string; user_id?: string | number }) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };
    if (!Number.isFinite(data.starting_cash_amount) || data.starting_cash_amount < 0) {
      return { success: false, error: 'الرصيد الافتتاحي غير صالح' };
    }

    const targetUserId = data.user_id || user.id;

    const shiftId = generateId();
    const inserted = await db.prepare(`
      INSERT INTO shifts (id, user_id, starting_cash, notes, status)
      SELECT ?, ?, ?, ?, 'open'
      WHERE NOT EXISTS (
        SELECT 1 FROM shifts WHERE CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
      )
    `).run(shiftId, targetUserId, data.starting_cash_amount, data.opening_notes || null, targetUserId);
    if (inserted.changes !== 1) {
      return { success: false, error: 'لديك وردية مفتوحة بالفعل' };
    }

    logActivity(targetUserId, 'START_SHIFT', `بدأ وردية جديدة بمبلغ ${data.starting_cash_amount}`);

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
    if (!Number.isFinite(data.ending_cash_amount) || data.ending_cash_amount < 0) {
      return { success: false, error: 'الرصيد الختامي غير صالح' };
    }

    let shiftId = data.shift_id;
    if (!shiftId || shiftId === 'auto') {
      const openShift = await db.prepare("SELECT id FROM shifts WHERE CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'").get(user.id) as any;
      if (!openShift) return { success: false, error: 'لا توجد وردية مفتوحة لإغلاقها' };
      shiftId = openShift.id;
    }

    const transaction = db.transaction(async () => {
      // 1. Calculate reconciliation difference
      const shift = await db.prepare(`
        SELECT CAST(COALESCE(starting_cash, 0) AS REAL) as starting_cash
        FROM shifts
        WHERE id = ? AND CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
      `).get(shiftId, user.id) as any;
      if (!shift) throw new Error('الوردية غير مفتوحة أو لا تخص المستخدم الحالي');
      
      const sales = await db.prepare(`
        SELECT CAST(COALESCE(SUM(total_amount), 0) AS REAL) as total
        FROM sales_invoices 
        WHERE shift_id = ?
          AND (status IS NULL OR status = '' OR status IN ('completed', 'approved'))
          AND payment_method = 'cash'
      `).get(shiftId) as any;

      const returns = await db.prepare(`
        SELECT CAST(COALESCE(SUM(total_refund), 0) AS REAL) as total
        FROM returns 
        WHERE shift_id = ?
          AND (status IS NULL OR status = '' OR status IN ('approved', 'completed'))
          AND refund_method = 'cash'
      `).get(shiftId) as any;

      const movements = await db.prepare(`
        SELECT CAST(COALESCE(SUM(
          CASE WHEN type IN ('receipt', 'in') THEN amount
               WHEN type IN ('disbursement', 'out') THEN -amount
               ELSE 0 END
        ), 0) AS REAL) as net
        FROM cash_movements 
        WHERE shift_id = ?
      `).get(shiftId) as any;

      const expectedCash = Number(shift.starting_cash) + Number(sales.total) - Number(returns.total) + Number(movements.net);
      const difference = data.ending_cash_amount - expectedCash;

      // Determine status based on discrepancy (> 5 EGP)
      const status = Math.abs(difference) > 5 ? 'discrepancy' : 'closed';

      // 2. Update shift record
      const shiftUpdate = await db.prepare(`
        UPDATE shifts 
        SET end_time = CURRENT_TIMESTAMP,
            ending_cash = ?,
            actual_cash = ?,
            cash_difference = ?,
            notes = ?,
            status = ?
        WHERE id = ? AND CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
      `).run(data.ending_cash_amount, data.ending_cash_amount, difference, data.closing_notes || null, status, shiftId, user.id);
      if (shiftUpdate.changes !== 1) throw new Error('تم إغلاق الوردية أو تعديلها بالفعل');

      // 3. Accounting Reconciliation (Journal Entry)
      if (Math.abs(difference) > 0.01) {
        const journalId = generateId();
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, date('now', 'localtime'), ?, ?, ?)
        `).run(journalId, `تسوية وردية: عجز/زيادة نقدية`, user.id, Math.abs(difference));

        const getAccountId = async (cat: string) => {
          const s = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ?').get(cat) as any;
          return s?.account_id;
        };

        const cashAcc = await getAccountId('cash_drawer') || (await db.prepare("SELECT id FROM accounts WHERE code = '1.1.1'").get() as any)?.id || 6;
        let diffAcc = await getAccountId('cash_difference') || (await db.prepare("SELECT id FROM accounts WHERE code = '4.3' OR name_ar LIKE '%عجز%' LIMIT 1").get() as any)?.id;
        if (!diffAcc) {
          try {
            const ins = await db.prepare("INSERT OR IGNORE INTO accounts (code, name_ar, name_en, type, is_group) VALUES ('4.3', 'عجز وزيادة الخزينة', 'Cash Shortage/Overage', 'expense', 0)").run();
            diffAcc = (await db.prepare("SELECT id FROM accounts WHERE code = '4.3' LIMIT 1").get() as any)?.id || ins.lastInsertRowid;
          } catch {}
        }

        if (diffAcc && cashAcc) {
          try {
            if (difference > 0) {
              // Overage: Debit Cash (Asset), Credit Difference (Income/Gain)
              await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, cashAcc, 'debit', difference);
              await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, diffAcc, 'credit', difference);
            } else {
              // Shortage: Debit Difference (Loss/Expense), Credit Cash (Asset)
              await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, diffAcc, 'debit', Math.abs(difference));
              await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)').run(journalId, cashAcc, 'credit', Math.abs(difference));
            }
          } catch (jErr) {
            console.warn('Could not post difference journal entry in closeShiftAction:', jErr);
          }
        }
      }

      await logActivity(user.id, 'END_SHIFT', `أنهى الوردية بمبلغ ${data.ending_cash_amount}. الفرق: ${difference.toFixed(2)}`);
    });

    await transaction();
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('End shift error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'فشل إنهاء الوردية' };
  }
}

export async function getShiftsAction(filter: { status: string }) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_shifts')) return { success: false, error: 'غير مصرح' };

    const isOwnerOrAdmin = user.role === 'owner' || user.role === 'admin';

    const params: any[] = [];
    if (filter.status !== 'all') {
      params.push(filter.status);
    }

    const rawShifts = await db.prepare(`
      SELECT s.id, s.start_time as shift_start, s.end_time as shift_end, 
             s.starting_cash as starting_cash_amount, s.ending_cash as ending_cash_amount,
             s.actual_cash, s.transfer_amount, s.transfer_target, s.cash_difference,
             s.receiver_id, ru.full_name as receiver_name,
             s.status, s.notes as opening_notes, u.full_name, u.role,
             COALESCE(sales.total_sales, 0) as total_sales,
             COALESCE(rets.total_refunds, 0) as total_refunds,
             COALESCE(moves.net_movements, 0) as net_movements
      FROM shifts s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN users ru ON s.receiver_id = ru.id
      LEFT JOIN (
        SELECT shift_id, SUM(total_amount) as total_sales
        FROM sales_invoices
        WHERE payment_method = 'cash'
          AND (status IS NULL OR status = '' OR status IN ('completed', 'approved'))
        GROUP BY shift_id
      ) sales ON s.id = sales.shift_id
      LEFT JOIN (
        SELECT shift_id, SUM(total_refund) as total_refunds
        FROM returns
        WHERE refund_method = 'cash'
          AND (status IS NULL OR status = '' OR status IN ('approved', 'completed'))
        GROUP BY shift_id
      ) rets ON s.id = rets.shift_id
      LEFT JOIN (
        SELECT shift_id, SUM(
          CASE WHEN type IN ('receipt', 'in') THEN amount
               WHEN type IN ('disbursement', 'out') THEN -amount
               ELSE 0 END
        ) as net_movements
        FROM cash_movements
        GROUP BY shift_id
      ) moves ON s.id = moves.shift_id
      ${filter.status !== 'all' ? 'WHERE s.status = ?' : ''}
      ORDER BY s.start_time DESC LIMIT 50
    `).all(...params) as any[];
    
    const shifts = rawShifts.map(s => {
      const expectedCash = s.starting_cash_amount + s.total_sales - s.total_refunds + s.net_movements;
      const difference = (s.cash_difference !== null && s.cash_difference !== undefined)
        ? Number(s.cash_difference)
        : (s.status !== 'open' && s.ending_cash_amount !== null ? (s.ending_cash_amount - expectedCash) : 0);

      return {
        id: s.id,
        shift_start: s.shift_start,
        shift_end: s.shift_end,
        starting_cash_amount: s.starting_cash_amount,
        ending_cash_amount: s.ending_cash_amount,
        actual_cash: isOwnerOrAdmin ? s.actual_cash : null,
        transfer_amount: isOwnerOrAdmin ? (s.transfer_amount || 0) : null,
        transfer_target: isOwnerOrAdmin ? s.transfer_target : null,
        receiver_id: isOwnerOrAdmin ? s.receiver_id : null,
        receiver_name: isOwnerOrAdmin ? (s.receiver_name || null) : null,
        expected_cash_amount: isOwnerOrAdmin ? expectedCash : null,
        cash_difference: isOwnerOrAdmin ? difference : null,
        status: s.status,
        opening_notes: s.opening_notes || null,
        closing_notes: s.closing_notes || s.notes || null,
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
      SELECT id, user_id, start_time as shift_start, starting_cash as starting_cash_amount, status
      FROM shifts 
      WHERE CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
      ORDER BY start_time DESC LIMIT 1
    `).get(user.id) as any;

    const lastClosed = await db.prepare(`
      SELECT ending_cash
      FROM shifts
      WHERE status != 'open' AND ending_cash IS NOT NULL
      ORDER BY COALESCE(end_time, start_time) DESC
      LIMIT 1
    `).get() as any;

    const suggestedStartingCash = lastClosed && lastClosed.ending_cash !== null && lastClosed.ending_cash !== undefined
      ? Number(lastClosed.ending_cash)
      : 0;

    return { 
      success: true, 
      data: shift || null,
      has_open_shift: !!shift,
      suggested_starting_cash: suggestedStartingCash
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
      WHERE CAST(user_id AS TEXT) = CAST(? AS TEXT) AND status = 'open'
    `).get(user.id) as any;

    if (!shift) return { success: false, error: 'لا توجد وردية مفتوحة' };

    // 1. All completed transactions count
    const countStats = await db.prepare(`
      SELECT COUNT(*) as transactions
      FROM sales_invoices
      WHERE shift_id = ? AND (status IS NULL OR status = '' OR status IN ('completed', 'approved'))
    `).get(shift.id) as any;

    // 2. Total sales revenue (all payment methods)
    const salesStats = await db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total_revenue
      FROM sales_invoices
      WHERE shift_id = ? AND (status IS NULL OR status = '' OR status IN ('completed', 'approved'))
    `).get(shift.id) as any;

    // 3. Cash-drawer sales revenue (cash & delivery)
    const cashSalesStats = await db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total_cash_revenue
      FROM sales_invoices
      WHERE shift_id = ?
        AND (status IS NULL OR status = '' OR status IN ('completed', 'approved'))
        AND payment_method = 'cash'
    `).get(shift.id) as any;

    // 4. Cash returns
    const returnStats = await db.prepare(`
      SELECT COALESCE(SUM(total_refund), 0) as total_refunds
      FROM returns
      WHERE shift_id = ?
        AND (status IS NULL OR status = '' OR status IN ('approved', 'completed'))
        AND refund_method = 'cash'
    `).get(shift.id) as any;

    // 5. Cash movements (manual)
    const movementsStats = await db.prepare(`
      SELECT COALESCE(SUM(
        CASE WHEN type IN ('receipt', 'in') THEN amount
             WHEN type IN ('disbursement', 'out') THEN -amount
             ELSE 0 END
      ), 0) as net
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

/**
 * Get all receipts / invoices belonging to a specific shift
 */
export async function getShiftReceiptsAction(shiftId: string) {
  try {
    const user = await getLocalSession();
    if (!user || (!hasUserPermissionSync(user, 'can_view_shifts') && !hasUserPermissionSync(user, 'can_view_receipts') && !hasUserPermissionSync(user, 'rep_can_view_shifts'))) {
      return { success: false, error: 'غير مصرح' };
    }

    const invoicesData = await db.prepare(`
      SELECT 
        si.id,
        si.total_amount,
        si.paid_amount,
        si.remaining_amount,
        si.payment_method,
        si.discount_amount,
        si.created_at,
        si.status,
        si.user_id,
        si.patient_id,
        u.full_name as staff_name,
        p.full_name as patient_name,
        p.phone as patient_phone
      FROM sales_invoices si
      LEFT JOIN users u ON si.user_id = u.id
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE si.shift_id = ?
        AND (si.status IS NULL OR si.status = '' OR si.status IN ('completed', 'approved'))
      ORDER BY si.created_at DESC
    `).all(shiftId) as any[];

    if (!invoicesData || invoicesData.length === 0) {
      return { success: true, data: [] };
    }

    const invoiceIds = invoicesData.map(inv => `'${inv.id}'`).join(',');
    const itemsData = await db.prepare(`
      SELECT 
        si.invoice_id,
        si.quantity_sold,
        si.unit_price,
        si.unit,
        si.drug_id,
        COALESCE(
          NULLIF(NULLIF(md.trade_name, ''), 'Drug ' || md.id),
          NULLIF(NULLIF(md.trade_name_en, ''), 'Drug ' || md.id),
          md.trade_name,
          md.trade_name_en,
          'صنف #' || si.drug_id
        ) AS trade_name,
        COALESCE(
          NULLIF(NULLIF(md.trade_name_en, ''), 'Drug ' || md.id),
          NULLIF(NULLIF(md.trade_name, ''), 'Drug ' || md.id),
          md.trade_name_en,
          md.trade_name,
          'صنف #' || si.drug_id
        ) AS trade_name_en,
        md.active_ingredient,
        md.large_unit,
        md.medium_unit,
        md.small_unit
      FROM sales_items si
      LEFT JOIN master_drugs md ON si.drug_id = md.id
      WHERE si.invoice_id IN (${invoiceIds})
    `).all() as any[];

    const fullInvoices = invoicesData.map(invoice => {
      const items = (itemsData || []).filter((item: any) => item.invoice_id === invoice.id);
      return {
        ...invoice,
        profiles: { full_name: invoice.staff_name || 'موظف' },
        patients: invoice.patient_name ? { full_name: invoice.patient_name, phone: invoice.patient_phone } : null,
        payment_method: invoice.payment_method || 'cash',
        sales_items: items.map((item: any) => ({
          quantity_sold: Number(item.quantity_sold || 0),
          unit_price: Number(item.unit_price || 0),
          unit: item.unit,
          units: {
            large: item.large_unit || 'علبة',
            medium: item.medium_unit,
            small: item.small_unit
          },
          trade_name: item.trade_name,
          trade_name_en: item.trade_name_en,
          inventory: {
            master_drugs: {
              trade_name: item.trade_name || 'صنف غير معروف',
              trade_name_en: item.trade_name_en || ''
            }
          }
        }))
      };
    });

    return { success: true, data: fullInvoices };
  } catch (error) {
    console.error('Get shift receipts error:', error);
    return { success: false, error: 'فشل جلب فواتير الوردية' };
  }
}
