
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
const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

export async function updatePharmacyAction(formData: any) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || !hasUserPermissionSync(localUser, 'can_view_settings')) return { success: false, error: 'غير مصرح' };

    // Update Local Enforcer (SQLite). Cloud sync is read-only public catalog data.
    await db.prepare(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('pharmacy_name', formData.name);

    await db.prepare(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('pharmacy_phone', formData.phone);

    await db.prepare(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('pharmacy_address', formData.address);

    revalidatePath('/settings');
    return { success: true };
  } catch (error) {
    console.error('Unexpected error in updatePharmacyAction:', error);
    return { success: false, error: 'An unexpected error occurred' };
  }
}

export async function runDatabaseMaintenanceAction() {
  try {
    const localUser = await getLocalSession();
    if (!localUser || !hasUserPermissionSync(localUser, 'can_view_settings')) return { success: false, error: 'غير مصرح' };

    await db.exec('VACUUM');
    await db.exec('ANALYZE');
    return { success: true, message: 'تم تحسين وضغط قاعدة البيانات وتحديث الفهارس بنجاح!' };
  } catch (error) {
    console.error('Failed to run database maintenance:', error);
    return { success: false, error: 'فشل تنفيذ عملية صيانة قاعدة البيانات' };
  }
}
