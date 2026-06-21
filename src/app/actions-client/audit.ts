
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
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local'


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

export async function getAuditLogsAction() {
  try {
    const user = await getLocalSession();
    if (!user || !hasUserPermissionSync(user, 'can_view_audit')) {
      return { success: false, error: 'غير مصرح' };
    }

    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    const sevenDaysAgoStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] + ' 00:00:00';

    const logs = await db.prepare(`
      SELECT al.*, u.full_name as user_name 
      FROM activity_log al 
      LEFT JOIN users u ON al.user_id = u.id 
      ORDER BY al.created_at DESC 
      LIMIT 100
    `).all() as any[];

    const todayCountRes = await db.prepare(`
      SELECT COUNT(*) as count FROM activity_log WHERE created_at >= ?
    `).get(todayStart) as any;

    const userActivity = await db.prepare(`
      SELECT u.full_name, COUNT(al.id) as actions
      FROM activity_log al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE al.created_at >= ?
      GROUP BY u.full_name
      ORDER BY actions DESC
      LIMIT 5
    `).all(sevenDaysAgoStart) as any[];

    const actionTypes = await db.prepare(`
      SELECT action, COUNT(id) as count
      FROM activity_log
      WHERE created_at >= ?
      GROUP BY action
      ORDER BY count DESC
      LIMIT 5
    `).all(sevenDaysAgoStart) as any[];

    return { 
      success: true, 
      data: { 
        logs, 
        todayCount: todayCountRes?.count || 0, 
        userActivity, 
        actionTypes 
      } 
    };
  } catch (error) {
    console.error('getAuditLogsAction error:', error);
    return { success: false, error: 'Failed to get audit logs' };
  }
}
