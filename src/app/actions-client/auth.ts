// Client-side auth actions for Tauri/static mode (no 'use server')

import { dbSelect, dbExecute, dbGet, dbTransaction } from '@/lib/db/tauri';
import { isTauri } from '@/lib/env';

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



import { getLocalSession, logoutLocal, loginLocal } from '@/lib/auth/local';
import { isStaffOwner } from '@/lib/auth/staff-policy';

const redirect = (path) => {
  if (typeof window !== 'undefined') {
    window.location.href = path;
  }
};

export async function loginLocalAction(username: string, password?: string) {
  return loginLocal(username, password);
}

// On first licensed startup, only the native process may decide whether its
// canonical seeded owner still requires enrollment. No renderer SQL or owner ID.
export async function getOwnerEnrollmentStatusAction(): Promise<{ success: boolean; pending: boolean; error?: string }> {
  if (!isTauri) return { success: true, pending: false };
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const pending = await invoke<boolean>('owner_enrollment_status');
    if (typeof pending !== 'boolean') throw new Error('Invalid native enrollment status');
    return { success: true, pending };
  } catch {
    return { success: false, pending: true, error: 'تعذر التحقق من إعداد المالك؛ حاول مرة أخرى' };
  }
}

export async function enrollInitialOwnerAction(
  activationCode: string, newPassword: string,
): Promise<{ success: boolean; error?: string }> {
  if (!isTauri) return { success: false, error: 'إعداد المالك متاح على سطح المكتب فقط' };
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<void>('enroll_initial_owner', { activationCode, newPassword });
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getCurrentUserAction() {
  try {
    const user = await getLocalSession();
    if (!user) return { success: false, error: 'No session' };
    
    return {
      success: true,
      user: {
        id: user.id,
        full_name: user.full_name,
        role: user.role,
        pharmacy_id: user.pharmacy_id
      }
    };
  } catch (error) {
    return { success: false, error: 'Failed to get session' };
  }
}

export async function getLocalSessionAction() {
  try {
    const user = await getLocalSession();
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      pharmacy_id: user.pharmacy_id
    };
  } catch (error) {
    return null;
  }
}

export async function logoutLocalAction() {
  await logoutLocal();
  redirect('/login');
}

export async function getLocalUsersAction() {
  try {
    if (!isStaffOwner(await getLocalSession())) return { success: false, error: 'غير مصرح - للمالك فقط' };
    const users = isTauri
      ? await (await import('@tauri-apps/api/core')).invoke<any[]>('list_local_staff_summaries')
      : await db.prepare('SELECT id, username, full_name, role, (password_hash IS NOT NULL) as has_password FROM users').all();
    return { success: true, data: users };
  } catch (error) {
    return { success: false, error: 'Failed to fetch users' };
  }
}
