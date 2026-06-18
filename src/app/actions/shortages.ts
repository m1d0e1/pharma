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

export async function addToShortagesAction(data: { drug_id: number | string; qty?: number; notes?: string }) {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    await db.prepare(`
      INSERT INTO shortages (drug_id, requested_quantity)
      VALUES (?, ?)
    `).run(data.drug_id, data.qty || 1);

    return { success: true };
  } catch (error: any) {
    console.error('Shortage Error:', error);
    return { success: false, error: error.message };
  }
}

export async function getSmartShortagesAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'غير مصرح' };

    // logic: Get all drugs, their current stock, and their sales in the last 30 days
    const results = await db.prepare(`
      SELECT 
        m.id, 
        CASE WHEN m.trade_name_en IS NOT NULL AND m.trade_name_en != '' THEN m.trade_name_en ELSE m.trade_name END as trade_name, 
        m.reorder_point,
        COALESCE(SUM(i.quantity), 0) as total_stock,
        (
          SELECT COALESCE(SUM(si.quantity_sold), 0) 
          FROM sales_items si 
          JOIN sales_invoices sin ON si.invoice_id = sin.id
          WHERE si.drug_id = m.id AND sin.created_at >= date('now', '-30 days')
        ) as sales_30d
      FROM master_drugs m
      LEFT JOIN inventory i ON m.id = i.drug_id
      GROUP BY m.id
    `).all() as any[];

    const predictions = results.map(r => {
      const dailyAvg = r.sales_30d / 30;
      const daysLeft = dailyAvg > 0 ? Math.floor(r.total_stock / dailyAvg) : 999;
      
      return {
        ...r,
        daily_avg: dailyAvg.toFixed(2),
        days_left: daysLeft,
        recommendation: daysLeft < 7 ? 'Urgent Order' : (r.total_stock < r.reorder_point ? 'Low Stock' : 'Safe')
      };
    }).filter(p => p.days_left < 14 || p.total_stock < p.reorder_point);

    return { success: true, data: predictions };
  } catch (error: any) {
    console.error('Smart Shortages Error:', error);
    return { success: false, error: error.message };
  }
}

