
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
        COALESCE(m.official_price, 0) AS official_price,
        COALESCE(m.large_to_medium, 1) AS large_to_medium,
        COALESCE(NULLIF(m.barcode, ''), '') AS barcode,
        (
          SELECT sup.name_ar 
          FROM purchase_invoice_items pii
          JOIN purchase_invoices pi ON pii.invoice_id = pi.id
          JOIN suppliers sup ON pi.supplier_id = sup.id
          WHERE pii.drug_id = s.drug_id
            AND (pi.status IS NULL OR pi.status = '' OR pi.status = 'completed')
            AND (pi.pharmacy_id = ? OR (pi.pharmacy_id IS NULL AND ? = 'local_default'))
          ORDER BY pi.created_at DESC, pii.id DESC
          LIMIT 1
        ) AS last_supplier_name,
        (
          SELECT pii.cost_price 
          FROM purchase_invoice_items pii
          JOIN purchase_invoices pi ON pii.invoice_id = pi.id
          WHERE pii.drug_id = s.drug_id
            AND (pi.status IS NULL OR pi.status = '' OR pi.status = 'completed')
            AND (pi.pharmacy_id = ? OR (pi.pharmacy_id IS NULL AND ? = 'local_default'))
          ORDER BY pi.created_at DESC, pii.id DESC
          LIMIT 1
        ) AS last_cost_price,
        COALESCE(ds.current_stock, 0) AS current_stock,
        COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), ?) AS reorder_point,
        MAX(
          0,
          COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), ?) - COALESCE(ds.current_stock, 0)
        ) AS deficit,
        CASE
          WHEN COALESCE(ds.current_stock, 0) <= 0 THEN 'out_of_stock'
          WHEN COALESCE(ds.current_stock, 0) <= (COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), ?) / 2) THEN 'critical'
          WHEN COALESCE(ds.current_stock, 0) <= COALESCE(NULLIF(m.reorder_point, 0), NULLIF(m.min_limit, 0), ?)
            THEN 'low'
          ELSE 'sufficient'
        END AS inventory_status
      FROM shortages s
      JOIN master_drugs m ON m.id = s.drug_id
      LEFT JOIN (
        SELECT i.drug_id, SUM(COALESCE(i.quantity, 0)) AS current_stock
        FROM inventory i
        WHERE (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
          AND (i.expiry_date IS NULL OR i.expiry_date >= date('now', 'localtime'))
        GROUP BY i.drug_id
      ) ds ON ds.drug_id = s.drug_id
      WHERE (s.pharmacy_id = ? OR (s.pharmacy_id IS NULL AND ? = 'local_default'))
        AND COALESCE(s.status, 'pending') != 'received'
      ORDER BY
        CASE WHEN COALESCE(ds.current_stock, 0) <= 0 THEN 0 ELSE 1 END,
        deficit DESC,
        s.created_at DESC
    `).all(
      pharmacyId, pharmacyId,
      pharmacyId, pharmacyId,
      DEFAULT_REORDER_LIMIT, DEFAULT_REORDER_LIMIT, DEFAULT_REORDER_LIMIT, DEFAULT_REORDER_LIMIT,
      pharmacyId, pharmacyId,
      pharmacyId, pharmacyId
    ) as any[];

    return { success: true, data: items };
  } catch (error: any) {
    console.error('Get shortages error:', error);
    return { success: false, error: error.message };
  }
}

export async function updateShortageQuantityAction(id: number | string, qty: number, notes?: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_restock')) return { success: false, error: 'غير مصرح' };
    const quantity = requestedQuantity(qty);
    const pharmacyId = user.pharmacy_id || 'local_default';

    const result = await db.prepare(`
      UPDATE shortages
      SET requested_quantity = ?, notes = COALESCE(?, notes)
      WHERE id = ? AND pharmacy_id = ?
    `).run(quantity, notes !== undefined ? (notes?.trim() || null) : null, id, pharmacyId);

    if (result.changes === 0) return { success: false, error: 'بند النواقص غير موجود' };
    return { success: true, requested_quantity: quantity };
  } catch (error: any) {
    console.error('Update shortage quantity error:', error);
    return { success: false, error: error.message };
  }
}

export async function deleteShortageAction(id: number | string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_restock')) return { success: false, error: 'غير مصرح' };
    const pharmacyId = user.pharmacy_id || 'local_default';

    const result = await db.prepare(`
      DELETE FROM shortages WHERE id = ? AND pharmacy_id = ?
    `).run(id, pharmacyId);

    if (result.changes === 0) return { success: false, error: 'بند النواقص غير موجود' };
    return { success: true };
  } catch (error: any) {
    console.error('Delete shortage error:', error);
    return { success: false, error: error.message };
  }
}

export async function deleteShortagesBulkAction(ids: (number | string)[]) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_restock')) return { success: false, error: 'غير مصرح' };
    if (!Array.isArray(ids) || ids.length === 0) return { success: true, count: 0 };

    const pharmacyId = user.pharmacy_id || 'local_default';
    const placeholders = ids.map(() => '?').join(',');
    const result = await db.prepare(`
      DELETE FROM shortages WHERE id IN (${placeholders}) AND pharmacy_id = ?
    `).run(...ids, pharmacyId);

    return { success: true, count: result.changes };
  } catch (error: any) {
    console.error('Delete shortages bulk error:', error);
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

export async function updateShortagesStatusBulkAction(ids: (number | string)[], status: string) {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_restock')) return { success: false, error: 'غير مصرح' };
    if (!['pending', 'ordered', 'received'].includes(status)) {
      return { success: false, error: 'حالة الطلب غير صالحة' };
    }
    if (!Array.isArray(ids) || ids.length === 0) return { success: true, count: 0 };

    const pharmacyId = user.pharmacy_id || 'local_default';
    let updatedCount = 0;
    await dbTransaction(async () => {
      for (const id of ids) {
        if (status === 'received') {
          const shortage = await db.prepare(`
            SELECT drug_id FROM shortages WHERE id = ? AND pharmacy_id = ?
          `).get(id, pharmacyId) as any;
          if (!shortage) continue;

          const stock = await db.prepare(`
            SELECT COALESCE(SUM(quantity), 0) AS quantity
            FROM inventory
            WHERE drug_id = ?
              AND (pharmacy_id = ? OR (pharmacy_id IS NULL AND ? = 'local_default'))
              AND (expiry_date IS NULL OR expiry_date >= date('now', 'localtime'))
          `).get(shortage.drug_id, pharmacyId, pharmacyId) as any;
          if (Number(stock?.quantity || 0) <= 0) {
            continue;
          }
        }

        const res = await db.prepare(`
          UPDATE shortages SET status = ? WHERE id = ? AND pharmacy_id = ?
        `).run(status, id, pharmacyId);
        if (res.changes > 0) updatedCount += res.changes;
      }
    });

    return { success: true, count: updatedCount };
  } catch (error: any) {
    console.error('Update shortages status bulk error:', error);
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
