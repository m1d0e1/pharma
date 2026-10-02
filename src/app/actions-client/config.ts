
import { dbSelect, dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
import { isPharmacyIdentityConfigKey, pharmacyIdentityConfigKey } from '@/lib/settings/pharmacy-identity';
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
    return (...args) => dbTransaction(async (transactionDb) => await cb(transactionDb, ...args));
  },
  exec: (sql) => {
    return dbExecute(sql);
  }
};




const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

/**
 * Get a configuration value from local DB
 */
export async function getConfigAction(key: string) {
  try {
    const localUser = isPharmacyIdentityConfigKey(key) ? await getLocalSession() : null;
    const scopedKey = isPharmacyIdentityConfigKey(key)
      ? pharmacyIdentityConfigKey(key, localUser?.pharmacy_id)
      : key;
    const row = await db.prepare('SELECT value FROM config WHERE key = ?').get(scopedKey) as { value: string };
    return { success: true, value: row?.value || null };
  } catch (error) {
    return { success: false, error: 'Failed to fetch config' };
  }
}

/**
 * Update a configuration value in local DB
 */
export async function updateConfigAction(key: string, value: string) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || !hasUserPermissionSync(localUser, 'can_view_settings')) {
      return { success: false, error: 'غير مصرح' };
    }
    const scopedKey = isPharmacyIdentityConfigKey(key)
      ? pharmacyIdentityConfigKey(key, localUser.pharmacy_id)
      : key;

    await db.prepare(`
      INSERT INTO config (key, value) 
      VALUES (?, ?) 
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(scopedKey, value);
    
    revalidatePath('/');
    return { success: true };
  } catch (error) {
    console.error('Update config error:', error);
    return { success: false, error: 'Failed to update config' };
  }
}
