
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
import { format } from 'date-fns';
import { requireOpenShiftId } from './finance';
const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

export async function getPendingDeliveriesAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_delivery')) return { success: false, error: 'غير مصرح' };

    const pharmacyId = user.pharmacy_id || 'local_default';
    const pharmacyClause = ` AND (si.pharmacy_id = ? OR (si.pharmacy_id IS NULL AND ? = 'local_default'))`;
    const invoices = await db.prepare(`
      SELECT 
        si.*, 
        p.full_name as patient_name,
        p.address as patient_address,
        p.phone as patient_phone
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE si.payment_method = 'delivery' AND si.status = 'completed'${pharmacyClause}
      ORDER BY si.created_at DESC
    `).all(pharmacyId, pharmacyId) as any[];

    return { success: true, data: invoices };
  } catch (error) {
    return { success: false, error: 'فشل جلب فواتير التوصيل' };
  }
}

export async function closeDeliveryInvoiceAction(invoiceId: string, deliveryFee: number) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_delivery')) return { success: false, error: 'غير مصرح' };
    if (!Number.isFinite(deliveryFee) || deliveryFee < 0) return { success: false, error: 'رسوم التوصيل غير صالحة' };

    const transaction = db.transaction(async () => {
      const pharmacyId = user.pharmacy_id || 'local_default';
      const pharmacyClause = ` AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))`;
      const invoiceParams = [invoiceId, pharmacyId, pharmacyId];
      // 1. Fetch invoice info to get total
      const invoice = await db.prepare(`SELECT total_amount FROM sales_invoices WHERE id = ? AND payment_method = 'delivery' AND status = 'completed'${pharmacyClause}`).get(...invoiceParams) as any;
      if (!invoice) throw new Error('فاتورة التوصيل غير موجودة أو تم تحصيلها بالفعل');
      const shiftId = await requireOpenShiftId(user.id);
      const totalCollected = Number(invoice.total_amount || 0) + deliveryFee;
      const originalTotal = Number(invoice.total_amount || 0);

      // 2. Update invoice status and total
      const updated = await db.prepare(`UPDATE sales_invoices SET status = 'delivered', total_amount = ? WHERE id = ? AND status = 'completed'${pharmacyClause}`).run(totalCollected, invoiceId, pharmacyId, pharmacyId);
      if (updated.changes !== 1) throw new Error('تم تحصيل فاتورة التوصيل بالفعل');

      // 3. Automatically record cash receipt (Handover from driver)
      const receiptId = generateId();
      await db.prepare(`
        INSERT INTO cash_movements (
          id, user_id, shift_id, type, category, amount, notes, date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receiptId, user.id, shiftId, 'receipt', 'delivery',
        totalCollected, `Delivery Closed: Invoice #${invoiceId.substring(0, 8)} (incl. Fee: ${deliveryFee})`,
        format(new Date(), 'yyyy-MM-dd')
      );

      const getAccountId = async (category: string, fallback: number) => {
        const setting = await db.prepare('SELECT account_id FROM trial_balance_settings WHERE category = ? LIMIT 1').get(category) as any;
        return Number(setting?.account_id || fallback);
      };
      const cashAccount = await getAccountId('cash_drawer', 6);
      const receivableAccount = await getAccountId('accounts_receivable', 8);
      const salesAccount = await getAccountId('sales_revenue', 9);
      const originalPosting = await db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN je.account_id = ? AND je.type = 'debit' THEN je.amount ELSE 0 END), 0) AS cash_debit,
          COALESCE(SUM(CASE WHEN je.account_id = ? AND je.type = 'debit' THEN je.amount ELSE 0 END), 0) AS receivable_debit
        FROM journal_entries je
        JOIN daily_journals dj ON dj.id = je.journal_id
        WHERE dj.description LIKE ?
          AND (dj.pharmacy_id = ? OR (dj.pharmacy_id IS NULL AND ? = 'local_default'))
      `).get(cashAccount, receivableAccount, `%${invoiceId.substring(0, 8)}%`, pharmacyId, pharmacyId) as any;
      const legacyCashPosting = originalTotal > 0.000001
        && Number(originalPosting?.cash_debit || 0) + 0.005 >= originalTotal
        && Number(originalPosting?.receivable_debit || 0) + 0.005 < originalTotal;

      if (legacyCashPosting) {
        const correctionId = generateId();
        await db.prepare(`
          INSERT INTO daily_journals (id, date, description, created_by, total_amount)
          VALUES (?, ?, ?, ?, ?)
        `).run(correctionId, format(new Date(), 'yyyy-MM-dd'), `تصحيح محاسبة توصيل قديم #${invoiceId.substring(0, 8)}`, user.id, originalTotal);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(correctionId, receivableAccount, 'debit', originalTotal);
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(correctionId, cashAccount, 'credit', originalTotal);
        await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)')
          .run(user.id, 'LEGACY_DELIVERY_ACCOUNTING_CORRECTED', `Reclassified legacy delivery invoice ${invoiceId} from cash to receivable before collection`);
      }

      const journalId = generateId();
      await db.prepare(`
        INSERT INTO daily_journals (id, date, description, created_by, total_amount)
        VALUES (?, ?, ?, ?, ?)
      `).run(journalId, format(new Date(), 'yyyy-MM-dd'), `تحصيل توصيل فاتورة #${invoiceId.substring(0, 8)}`, user.id, totalCollected);
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
        .run(journalId, cashAccount, 'debit', totalCollected);
      await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
        .run(journalId, receivableAccount, 'credit', originalTotal);
      if (deliveryFee > 0.000001) {
        await db.prepare('INSERT INTO journal_entries (journal_id, account_id, type, amount) VALUES (?, ?, ?, ?)')
          .run(journalId, salesAccount, 'credit', deliveryFee);
      }

      // 4. Log Activity
      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(user.id, 'DELIVERY_CLOSED', `Closed delivery invoice ${invoiceId} with fee ${deliveryFee}. Total collected: ${totalCollected}`);
    });

    await transaction();
    revalidatePath('/sales/delivery');
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'فشل إغلاق فاتورة التوصيل' };
  }
}

export async function getRepresentativeCashStatementAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_delivery')) return { success: false, error: 'غير مصرح' };

    // Get all pending delivery invoices (completed but not yet handed over)
    const pharmacyId = user.pharmacy_id || 'local_default';
    const pharmacyClause = ` AND (si.pharmacy_id = ? OR (si.pharmacy_id IS NULL AND ? = 'local_default'))`;
    const pharmacyParams = [pharmacyId, pharmacyId];
    const pending = await db.prepare(`
      SELECT 
        si.id, 
        si.total_amount, 
        si.created_at, 
        p.full_name as patient_name,
        u.full_name as created_by_name
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      JOIN users u ON si.user_id = u.id
      WHERE si.payment_method = 'delivery' AND si.status = 'completed'${pharmacyClause}
    `).all(...pharmacyParams) as any[];

    const history = await db.prepare(`
      SELECT 
        si.id, 
        si.total_amount, 
        si.created_at, 
        p.full_name as patient_name
      FROM sales_invoices si
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE si.payment_method = 'delivery' AND si.status = 'delivered'${pharmacyClause}
      ORDER BY si.created_at DESC LIMIT 20
    `).all(...pharmacyParams) as any[];

    const totalPending = pending.reduce((sum, inv) => sum + inv.total_amount, 0);

    return { 
      success: true, 
      data: {
        pending,
        history,
        total_pending_amount: totalPending
      } 
    };
  } catch (error) {
    console.error('Rep statement error:', error);
    return { success: false, error: 'فشل جلب كشف حساب المناديب' };
  }
}
