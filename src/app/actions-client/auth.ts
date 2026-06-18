// Client-side auth actions for Tauri/static mode (no 'use server')

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



import { getLocalSession, logoutLocal, loginLocal } from '@/lib/auth/local';

import { createClient } from '@/utils/supabase/client';
import { useRouter } from 'next/navigation';
const redirect = (path) => {
  if (typeof window !== 'undefined') {
    window.location.href = path;
  }
};

export async function loginLocalAction(username: string, password?: string) {
  return loginLocal(username, password);
}

export async function loginCloudAction(email: string, password: string) {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) return { success: false, error: error.message };
    
    return { 
      success: true, 
      user: data.user 
    };
  } catch (error) {
    return { success: false, error: 'حدث خطأ أثناء الاتصال بالسحابة' };
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
    const users = await db.prepare('SELECT id, username, full_name, role, (password_hash IS NOT NULL) as has_password FROM users').all();
    return { success: true, data: users };
  } catch (error) {
    return { success: false, error: 'Failed to fetch users' };
  }
}
