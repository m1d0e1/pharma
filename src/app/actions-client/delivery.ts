
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
const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

export async function getPendingDeliveriesAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_delivery')) return { success: false, error: 'غير مصرح' };

    const invoices = await db.prepare(`
      SELECT 
        si.*, 
        p.full_name as patient_name,
        p.address as patient_address,
        p.phone as patient_phone
      FROM sales_invoices si
      JOIN patients p ON si.patient_id = p.id
      WHERE si.payment_method = 'delivery' AND si.status = 'completed'
      ORDER BY si.created_at DESC
    `).all() as any[];

    return { success: true, data: invoices };
  } catch (error) {
    return { success: false, error: 'فشل جلب فواتير التوصيل' };
  }
}

export async function closeDeliveryInvoiceAction(invoiceId: string, deliveryFee: number) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_delivery')) return { success: false, error: 'غير مصرح' };

    const transaction = db.transaction(async () => {
      // 1. Fetch invoice info to get total
      const invoice = await db.prepare('SELECT total_amount, shift_id FROM sales_invoices WHERE id = ?').get(invoiceId) as any;
      const totalCollected = (invoice?.total_amount || 0) + deliveryFee;

      // 2. Update invoice status and total
      await db.prepare("UPDATE sales_invoices SET status = 'delivered', total_amount = ? WHERE id = ?").run(totalCollected, invoiceId);

      // 3. Automatically record cash receipt (Handover from driver)
      const receiptId = generateId();
      await db.prepare(`
        INSERT INTO cash_movements (
          id, user_id, shift_id, type, category, amount, notes, date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receiptId, user.id, invoice.shift_id || null, 'receipt', 'delivery', 
        totalCollected, `Delivery Closed: Invoice #${invoiceId.substring(0, 8)} (incl. Fee: ${deliveryFee})`,
        new Date().toISOString().split('T')[0]
      );

      // 4. Log Activity
      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(user.id, 'DELIVERY_CLOSED', `Closed delivery invoice ${invoiceId} with fee ${deliveryFee}. Total collected: ${totalCollected}`);
    });

    await transaction();
    revalidatePath('/sales/delivery');
    return { success: true };
  } catch (error) {
    return { success: false, error: 'فشل إغلاق فاتورة التوصيل' };
  }
}

export async function getRepresentativeCashStatementAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_delivery')) return { success: false, error: 'غير مصرح' };

    // Get all pending delivery invoices (completed but not yet handed over)
    const pending = await db.prepare(`
      SELECT 
        si.id, 
        si.total_amount, 
        si.created_at, 
        p.full_name as patient_name,
        u.full_name as created_by_name
      FROM sales_invoices si
      JOIN patients p ON si.patient_id = p.id
      JOIN users u ON si.user_id = u.id
      WHERE si.payment_method = 'delivery' AND si.status = 'completed'
    `).all() as any[];

    const history = await db.prepare(`
      SELECT 
        si.id, 
        si.total_amount, 
        si.created_at, 
        p.full_name as patient_name
      FROM sales_invoices si
      JOIN patients p ON si.patient_id = p.id
      WHERE si.payment_method = 'delivery' AND si.status = 'delivered'
      ORDER BY si.created_at DESC LIMIT 20
    `).all() as any[];

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
