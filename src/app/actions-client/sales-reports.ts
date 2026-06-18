
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

export async function getSalesReportsAction(filters: {
  startDate?: string;
  endDate?: string;
  pharmacyId?: string;
  userId?: string;
  patientId?: string;
  paymentMethod?: string;
  invoiceNumber?: string;
  isReturn?: boolean;
}) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_sales')) return { success: false, error: 'غير مصرح' };

    let query = `
      SELECT 
        si.*, 
        u.full_name as staff_name,
        p.full_name as patient_name
      FROM sales_invoices si
      LEFT JOIN users u ON si.user_id = u.id
      LEFT JOIN patients p ON si.patient_id = p.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (filters.startDate) {
      query += ` AND si.created_at >= ?`;
      params.push(filters.startDate + ' 00:00:00');
    }
    if (filters.endDate) {
      query += ` AND si.created_at <= ?`;
      params.push(filters.endDate + ' 23:59:59');
    }
    if (filters.userId) {
      query += ` AND si.user_id = ?`;
      params.push(filters.userId);
    }
    if (filters.patientId) {
      query += ` AND si.patient_id = ?`;
      params.push(filters.patientId);
    }
    if (filters.paymentMethod && filters.paymentMethod !== 'all') {
      query += ` AND si.payment_method = ?`;
      params.push(filters.paymentMethod);
    }
    if (filters.invoiceNumber) {
      query += ` AND si.id LIKE ?`;
      params.push(`%${filters.invoiceNumber}%`);
    }

    query += ` ORDER BY si.created_at DESC`;

    const invoices = await db.prepare(query).all(...params) as any[];

    // If we need items for the first invoice or a specific one, we can fetch them separately
    // But for the main report list, we usually show summary first.

    return { success: true, data: invoices };
  } catch (error) {
    console.error('Sales report error:', error);
    return { success: false, error: 'فشل جلب تقرير المبيعات' };
  }
}

export async function getInvoiceDetailsAction(invoiceId: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'rep_can_view_sales')) return { success: false, error: 'غير مصرح' };

    const items = await db.prepare(`
      SELECT 
        si.*, 
        md.trade_name,
        md.trade_name_en,
        md.barcode
      FROM sales_items si
      LEFT JOIN master_drugs md ON si.drug_id = md.id
      WHERE si.invoice_id = ?
    `).all(invoiceId) as any[];

    return { success: true, data: items };
  } catch (error) {
    return { success: false, error: 'فشل جلب تفاصيل الفاتورة' };
  }
}
