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


export async function createPurchaseOrderAction(data: {
  supplier_name: string;
  notes?: string;
  items: { drug_id: number; quantity: number; expected_price: number }[];
}) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const po_id = 'PO-' + generateId().substring(0, 8).toUpperCase();
    const total_amount = data.items.reduce((sum, item) => sum + (item.quantity * item.expected_price), 0);

    const transaction = db.transaction(async () => {
      // Create PO header
      await db.prepare(`
        INSERT INTO purchase_orders (id, user_id, supplier_name, total_amount, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(po_id, user.id, data.supplier_name, total_amount, data.notes || null);

      // Create PO items
      const itemStmt = db.prepare(`
        INSERT INTO purchase_order_items (po_id, drug_id, quantity, expected_price)
        VALUES (?, ?, ?, ?)
      `);

      for (const item of data.items) {
        await itemStmt.run(po_id, item.drug_id, item.quantity, item.expected_price);
      }

      // Log activity
      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(user.id, 'إنشاء أمر شراء', `تم إنشاء أمر شراء ${po_id} للمورد ${data.supplier_name}`);
    });

    await transaction();

    revalidatePath('/restock');
    return { success: true, po_id };
  } catch (error) {
    console.error('PO error:', error);
    return { success: false, error: 'فشل إنشاء أمر الشراء' };
  }
}

export async function getPurchaseOrdersAction() {
  try {
    const orders = await db.prepare(`
      SELECT po.*, u.full_name as creator_name,
             (SELECT COUNT(*) FROM purchase_order_items WHERE po_id = po.id) as item_count
      FROM purchase_orders po
      JOIN users u ON po.user_id = u.id
      ORDER BY po.created_at DESC
    `).all();
    return { success: true, data: orders };
  } catch (error) {
    return { success: false, error: 'فشل جلب أوامر الشراء' };
  }
}

export async function updatePurchaseOrderStatusAction(poId: string, status: string) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    await db.prepare('UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, poId);

    revalidatePath('/restock');
    return { success: true };
  } catch (error) {
    return { success: false, error: 'فشل تحديث حالة الطلب' };
  }
}
