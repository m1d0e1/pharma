
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
import { getLowStockAction } from './inventory';

const DEFAULT_REORDER_LIMIT = 10;

function requestedQuantity(value: unknown): number {
  const quantity = Math.ceil(Number(value));
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

async function upsertActiveShortage(drugId: number, pharmacyId: string, quantity: number, notes?: string) {
  const existingRows = await db.prepare(`
    SELECT id, requested_quantity, status, notes
    FROM shortages
    WHERE drug_id = ? AND pharmacy_id = ?
      AND status IN ('pending', 'ordered')
    ORDER BY CASE WHEN status = 'ordered' THEN 0 ELSE 1 END, created_at DESC, rowid DESC
  `).all(drugId, pharmacyId) as any[];

  if (existingRows.length > 0) {
    const existing = existingRows[0];
    const nextQuantity = Math.max(
      quantity,
      ...existingRows.map(row => requestedQuantity(row.requested_quantity)),
    );
    await db.prepare(`
      UPDATE shortages
      SET requested_quantity = ?, notes = COALESCE(NULLIF(?, ''), notes)
      WHERE id = ?
    `).run(nextQuantity, notes?.trim() || '', existing.id);
    await db.prepare(`
      DELETE FROM shortages
      WHERE drug_id = ? AND pharmacy_id = ?
        AND status IN ('pending', 'ordered')
        AND id != ?
    `).run(drugId, pharmacyId, existing.id);
    return { id: existing.id, created: false, requested_quantity: nextQuantity };
  }

  const inserted = await db.prepare(`
    INSERT INTO shortages (drug_id, pharmacy_id, requested_quantity, status, notes)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(drugId, pharmacyId, quantity, notes?.trim() || null);
  return { id: inserted.lastInsertRowid, created: true, requested_quantity: quantity };
}

export async function addToShortagesAction(data: { drug_id: number | string; qty?: number; notes?: string }) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_restock')) return { success: false, error: 'غير مصرح' };

    const drugId = Number(data.drug_id);
    if (!Number.isInteger(drugId) || drugId <= 0) {
      return { success: false, error: 'معرف الصنف غير صالح' };
    }

    const pharmacyId = user.pharmacy_id || 'local_default';
    const result = await dbTransaction(() => upsertActiveShortage(
      drugId,
      pharmacyId,
      requestedQuantity(data.qty),
      data.notes,
    ));
    return { success: true, data: result };
  } catch (error: any) {
    console.error('Shortage Error:', error);
    return { success: false, error: error.message };
  }
}

export async function getShortagesAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_restock')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = user.pharmacy_id || 'local_default';

    const items = await db.prepare(`
      WITH Params AS (
        SELECT ? AS pharmacy_id
      ),
      DrugStock AS (
        SELECT i.drug_id, SUM(COALESCE(i.quantity, 0)) AS current_stock
        FROM inventory i
        CROSS JOIN Params p
        WHERE (i.pharmacy_id = p.pharmacy_id OR (i.pharmacy_id IS NULL AND p.pharmacy_id = 'local_default'))
          AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
        GROUP BY i.drug_id
      )
      SELECT
        s.id,
        s.drug_id,
        s.requested_quantity,
        s.status,
        s.notes,
        s.pharmacy_id,
        s.created_at,
        m.trade_name,
        m.trade_name_en,
        m.generic_name,
        COALESCE(ds.current_stock, 0) AS current_stock,
        COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), ?) AS reorder_point,
        MAX(
          0,
          COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), ?) - COALESCE(ds.current_stock, 0)
        ) AS deficit,
        CASE
          WHEN COALESCE(ds.current_stock, 0) <= 0 THEN 'out_of_stock'
          WHEN COALESCE(ds.current_stock, 0) <= COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), ?)
            THEN 'low'
          ELSE 'sufficient'
        END AS inventory_status
      FROM shortages s
      CROSS JOIN Params p
      JOIN master_drugs m ON m.id = s.drug_id
      LEFT JOIN DrugStock ds ON ds.drug_id = s.drug_id
      WHERE s.pharmacy_id = p.pharmacy_id
        AND COALESCE(s.status, 'pending') != 'received'
      ORDER BY
        CASE WHEN COALESCE(ds.current_stock, 0) <= 0 THEN 0 ELSE 1 END,
        deficit DESC,
        s.created_at DESC
    `).all(pharmacyId, DEFAULT_REORDER_LIMIT, DEFAULT_REORDER_LIMIT, DEFAULT_REORDER_LIMIT) as any[];

    return { success: true, data: items };
  } catch (error: any) {
    console.error('Get shortages error:', error);
    return { success: false, error: error.message };
  }
}

export async function updateShortageStatusAction(id: number | string, status: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_restock')) return { success: false, error: 'غير مصرح' };
    if (!['pending', 'ordered', 'received'].includes(status)) {
      return { success: false, error: 'حالة الطلب غير صالحة' };
    }
    const pharmacyId = user.pharmacy_id || 'local_default';

    await dbTransaction(async () => {
      const shortage = await db.prepare(`
        SELECT drug_id FROM shortages WHERE id = ? AND pharmacy_id = ?
      `).get(id, pharmacyId) as any;
      if (!shortage) throw new Error('بند النواقص غير موجود');

      if (status === 'received') {
        const stock = await db.prepare(`
          SELECT COALESCE(SUM(quantity), 0) AS quantity
          FROM inventory
          WHERE drug_id = ?
            AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
            AND (expiry_date IS NULL OR expiry_date >= date('now', 'localtime'))
        `).get(shortage.drug_id, pharmacyId, pharmacyId) as any;
        if (Number(stock?.quantity || 0) <= 0) {
          throw new Error('لا يمكن تأكيد الاستلام قبل إضافة الكمية إلى مخزون الفرع');
        }
      }

      const result = await db.prepare(`
        UPDATE shortages SET status = ? WHERE id = ? AND pharmacy_id = ?
      `).run(status, id, pharmacyId);
      if (result.changes !== 1) throw new Error('بند النواقص غير موجود');
    });
    return { success: true };
  } catch (error: any) {
    console.error('Update shortage status error:', error);
    return { success: false, error: error.message };
  }
}

export async function syncLowStockToShortagesAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_restock')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = user.pharmacy_id || 'local_default';

    const lowStock = await getLowStockAction(DEFAULT_REORDER_LIMIT);
    if (!lowStock.success) return { success: false, error: lowStock.error || 'فشل قراءة المخزون' };

    const items = lowStock.data || [];
    let created = 0;
    let updated = 0;
    await dbTransaction(async () => {
      for (const item of items) {
        const quantity = requestedQuantity(Math.max(
          Number(item.default_purchase_qty || 1),
          Number(item.deficit || 0),
          Math.ceil(Number(item.avg_monthly_usage || 0)),
        ));
        const result = await upsertActiveShortage(Number(item.drug_id), pharmacyId, quantity);
        if (result.created) created += 1;
        else updated += 1;
      }
    });

    return { success: true, data: { total: items.length, created, updated } };
  } catch (error: any) {
    console.error('Sync low stock error:', error);
    return { success: false, error: error.message };
  }
}

export async function getSmartShortagesAction() {
  const lowStock = await getLowStockAction(DEFAULT_REORDER_LIMIT);
  if (!lowStock.success) return lowStock;

  return {
    success: true,
    data: (lowStock.data || []).map((item: any) => ({
      ...item,
      total_stock: Number(item.quantity || 0),
      sales_30d: Number(item.avg_monthly_usage || 0),
      recommendation: item.status === 'out_of_stock' ? 'Urgent Order' : 'Low Stock',
    })),
  };
}
