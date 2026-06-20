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



const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;
import { getLocalSession } from '@/lib/auth/local'


/**
 * Clear all activity logs (Owner only)
 */
export async function clearAuditLogsAction() {
  try {
    const user = await getLocalSession();
    if (!user || user.role !== 'owner') {
      return { success: false, error: 'غير مصرح - للمالك فقط' };
    }

    const success = await clearAuditLogs();
    if (success) {
      await logActivity(user.id, 'CLEAR_LOGS', 'قام المالك بمسح جميع سجلات النشاط');
      revalidatePath('/audit');
      return { success: true };
    } else {
      return { success: false, error: 'فشل مسح السجلات' };
    }
  } catch (error) {
    console.error('Clear logs error:', error);
    return { success: false, error: 'حدث خطأ أثناء مسح السجلات' };
  }
}

export async function getAuditLogsAction() { return { success: false, data: { logs: [], todayCount: 0, userActivity: [], actionTypes: [] } }; }
