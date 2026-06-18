'use server';

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




import { getLocalSession } from '@/lib/auth/local';
const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

export async function getNegativeStockInvoicesAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    // Find sales items where is_negative = 1
    const items = await db.prepare(`
      SELECT 
        si.*, 
        inv.id as inventory_id,
        md.trade_name,
        md.trade_name_en,
        md.barcode,
        s.id as invoice_id,
        s.created_at as invoice_date
      FROM sales_items si
      LEFT JOIN inventory inv ON si.inventory_id = inv.id
      LEFT JOIN master_drugs md ON si.drug_id = md.id
      JOIN sales_invoices s ON si.invoice_id = s.id
      WHERE si.is_negative = 1
      ORDER BY s.created_at DESC
    `).all() as any[];

    return { success: true, data: items };
  } catch (error) {
    return { success: false, error: 'فشل جلب الأصناف المباعة بدون رصيد' };
  }
}

export async function settleNegativeStockAction(itemId: number, costPrice: number) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    const transaction = db.transaction(async () => {
      // 1. Get the item
      const item = await db.prepare('SELECT * FROM sales_items WHERE id = ?').get(itemId) as any;
      if (!item) throw new Error('الصنف غير موجود');

      // 2. Update the item's cost (if we had a place to store it, usually COGS)
      // For now, we'll mark it as settled by setting is_negative = 0
      await db.prepare('UPDATE sales_items SET is_negative = 0 WHERE id = ?').run(itemId);

      // 3. Update inventory cost price if it was 0
      await db.prepare(`
        UPDATE inventory 
        SET cost_price = ? 
        WHERE id = ? AND (cost_price = 0 OR cost_price IS NULL)
      `).run(costPrice, item.inventory_id);

      // 4. Log the settlement
      await db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)').run(user.id, 'SETTLEMENT', `Settled negative stock for item ${itemId} with cost ${costPrice}`);
    });

    await transaction();
    revalidatePath('/inventory');
    revalidatePath('/sales/settlement');

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message || 'فشل عملية التسوية' };
  }
}

export async function getUnsettledSalesAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'Unauthorized' };

    const items = await db.prepare(`
      SELECT 
        si.id as item_id,
        si.invoice_id,
        si.quantity_sold,
        si.unit,
        si.unit_price,
        md.trade_name,
        md.trade_name_en,
        md.id as drug_id,
        s.created_at as sale_date,
        s.created_at as created_at,
        (SELECT COALESCE(SUM(quantity), 0) FROM inventory WHERE drug_id = md.id) as current_stock_balance
      FROM sales_items si
      LEFT JOIN master_drugs md ON si.drug_id = md.id
      JOIN sales_invoices s ON si.invoice_id = s.id
      WHERE si.is_negative = 1
      ORDER BY s.created_at DESC
    `).all() as any[];

    return { success: true, data: items };
  } catch (error) {
    return { success: false, error: 'Failed to fetch unsettled items' };
  }
}

export async function getDrugBatchesAction(drugId: number) {
  try {
    const batches = await db.prepare(`
      SELECT 
        id,
        id as inventory_id,
        batch_number,
        expiry_date,
        quantity,
        cost_price
      FROM inventory
      WHERE drug_id = ? AND quantity > 0
      ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date ASC
    `).all(drugId) as any[];

    return { success: true, data: batches };
  } catch (error) {
    return { success: false, error: 'Failed to fetch batches' };
  }
}

export async function settleSaleItemAction(itemId: number, inventoryId: string, quantity: number) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'Unauthorized' };

    const transaction = db.transaction(async () => {
      // 1. Get the sales item to know the unit and drug_id
      const saleItem = await db.prepare('SELECT drug_id, unit, quantity_sold FROM sales_items WHERE id = ?').get(itemId) as any;
      if (!saleItem) throw new Error('Sale item not found');

      // 2. Fetch conversion factors
      const drugInfo = await db.prepare('SELECT large_to_medium, medium_to_small FROM master_drugs WHERE id = ?').get(saleItem.drug_id) as any;
      
      let deductionQty = quantity;
      if (saleItem.unit === 'medium') {
        deductionQty = quantity / (drugInfo.large_to_medium || 1);
      } else if (saleItem.unit === 'small') {
        deductionQty = quantity / ((drugInfo.large_to_medium || 1) * (drugInfo.medium_to_small || 1));
      }

      // 3. Mark item as settled
      await db.prepare('UPDATE sales_items SET is_negative = 0, inventory_id = ? WHERE id = ?').run(inventoryId, itemId);
      
      // 4. Deduct from inventory using converted quantity
      await db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE id = ?').run(deductionQty, inventoryId);
      
      logActivity(user.id, 'SETTLE_NEGATIVE_STOCK', `Settled item ${itemId} using batch ${inventoryId} (Converted Qty: ${deductionQty})`);
    });

    await transaction();
    revalidatePath('/sales/settlement');
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}


