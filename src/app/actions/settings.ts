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



import { createClient } from '@/utils/supabase/client';
import { getLocalSession, hasUserPermissionSync } from '@/lib/auth/local';
const revalidatePath = (...args: any[]) => {}; const unstable_cache = (fn: any, ...args: any[]) => fn;

export async function updatePharmacyAction(formData: any) {
  try {
    const localUser = await getLocalSession();
    if (!localUser || (localUser.role !== 'owner' && localUser.role !== 'admin')) {
      return { success: false, error: 'غير مصرح - للمالك والمدير فقط' };
    }
    if (!localUser || !hasUserPermissionSync(localUser, 'can_view_settings')) return { success: false, error: 'غير مصرح' };

    // 1. Update Cloud (Supabase)
    const supabase = await createClient();

    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (!authError && user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('pharmacy_id')
          .eq('id', user.id)
          .single();

        if (profile?.pharmacy_id) {
          const { error: updateError } = await supabase
            .from('pharmacies')
            .update({
              name: formData.name,
              name_en: formData.name_en,
              phone: formData.phone,
              address: formData.address,
              commercial_registry: formData.commercial_registry,
              tax_card: formData.tax_card,
              owner_name: formData.owner_name,
              owner_address: formData.owner_address,
              owner_phone: formData.owner_phone,
              owner_mobile: formData.owner_mobile,
              manager_name: formData.manager_name,
              manager_address: formData.manager_address,
              manager_phone: formData.manager_phone,
              manager_mobile: formData.manager_mobile,
            })
            .eq('id', profile.pharmacy_id);

          if (updateError) {
            console.error('Update pharmacy error:', updateError);
            // We still continue to update local even if cloud fails (for offline resiliency)
          }
        }
      } else {
        console.warn('Supabase auth failed, proceeding with local update only');
      }
    } catch (err) {
      console.warn('Supabase client error, proceeding with local update only:', err);
    }

    // 2. Update Local Enforcer (SQLite)
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
