// Universal Authentication Helper for local operations
import { dbGet, dbExecute } from '@/lib/db/tauri';
import { cache } from 'react';

const SESSION_COOKIE = 'pharma_session';

export async function hashPassword(password: string): Promise<string> {
  const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI__ !== undefined || (window as any).__TAURI_INTERNALS__ !== undefined);

  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<string>('bcrypt_hash', { password });
  }

  // Server-side or Node environment
  const bcrypt = await import('bcryptjs');
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI__ !== undefined || (window as any).__TAURI_INTERNALS__ !== undefined);

  if (isTauri) {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<boolean>('bcrypt_compare', { password, hash });
  }

  // Server-side or Node environment
  const bcrypt = await import('bcryptjs');
  return bcrypt.compare(password, hash);
}

export async function loginLocal(username: string, password?: string) {
  const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI__ !== undefined || (window as any).__TAURI_INTERNALS__ !== undefined);
  const isClient = typeof window !== 'undefined';

  if (isTauri) {
    // Tauri Mode: local DB queries + Rust bcrypt commands
    const cleanUsername = username.trim();
    const user = await dbGet('SELECT * FROM users WHERE username = ?', [cleanUsername]);

    if (!user) {
      return { success: false, error: 'المستخدم غير موجود' };
    }

    if (password) {
      if (user.password_hash) {
        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) return { success: false, error: 'كلمة المرور غير صحيحة' };
      } else {
        // First login setup
        const hashed = await hashPassword(password);
        await dbExecute('UPDATE users SET password_hash = ? WHERE id = ?', [hashed, user.id]);
      }
    }

    const sessionUser = {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      pharmacy_id: user.pharmacy_id,
      permissions: user.permissions
    };

    localStorage.setItem('pharma_session_user', JSON.stringify(sessionUser));
    try {
      await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [
        user.id,
        'LOGIN',
        `تسجيل دخول للمستخدم: ${user.full_name || user.username}`
      ]);
    } catch (e) {
      console.error('Failed to log login activity:', e);
    }
    return { success: true, user: sessionUser };
  }

  if (isClient) {
    // Client-side Electron/Web mode: call API route
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const result = await response.json();
    
    if (result.success && result.user) {
      // Map API user object to local schema
      const sessionUser = {
        id: result.user.id,
        username: result.user.username,
        role: result.user.role,
        full_name: result.user.fullName,
        pharmacy_id: result.user.pharmacyId,
        permissions: JSON.stringify(result.user.permissions)
      };
      localStorage.setItem('pharma_session_user', JSON.stringify(sessionUser));
      return { success: true, user: sessionUser };
    }
    return { success: false, error: result.error || 'فشلت عملية تسجيل الدخول' };
  }

  // Server-side (Node Next.js Server) execution
  const cleanUsername = username.trim();
  const user = await dbGet('SELECT * FROM users WHERE username = ?', [cleanUsername]);

  if (!user) {
    return { success: false, error: 'المستخدم غير موجود' };
  }

  if (password) {
    if (user.password_hash) {
      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) return { success: false, error: 'كلمة المرور غير صحيحة' };
    } else {
      const hashed = await hashPassword(password);
      await dbExecute('UPDATE users SET password_hash = ? WHERE id = ?', [hashed, user.id]);
    }
  }

  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  
  cookieStore.set(SESSION_COOKIE, user.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 8
  });

  // Expected by middleware
  cookieStore.set('token', user.id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8
  });

  cookieStore.set('userRole', user.role || 'pharmacist', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8
  });

  cookieStore.set('subscriptionActivated', 'true', {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8
  });

  try {
    await dbExecute('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)', [
      user.id,
      'LOGIN',
      `تسجيل دخول للمستخدم: ${user.full_name || user.username}`
    ]);
  } catch (e) {
    console.error('Failed to log login activity:', e);
  }

  return {
    success: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      full_name: user.full_name,
      pharmacy_id: user.pharmacy_id,
      permissions: user.permissions
    }
  };
}

export async function logoutLocal() {
  const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI__ !== undefined || (window as any).__TAURI_INTERNALS__ !== undefined);
  const isClient = typeof window !== 'undefined';

  if (isTauri || isClient) {
    localStorage.removeItem('pharma_session_user');
    
    if (isClient && !isTauri) {
      // Clear cookies by calling the Server Action
      const { logoutLocalAction } = await import('@/app/actions-client/auth');
      await logoutLocalAction();
    }
    return;
  }

  // Server-side cookies cleanup
  const { cookies } = await import('next/headers');
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  cookieStore.delete('token');
  cookieStore.delete('userRole');
  cookieStore.delete('subscriptionActivated');
}

export const getLocalSession = cache(async () => {
  if (typeof globalThis !== 'undefined' && (globalThis as any).__MOCK_SESSION__) {
    return (globalThis as any).__MOCK_SESSION__;
  }
  const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI__ !== undefined || (window as any).__TAURI_INTERNALS__ !== undefined);
  const isClient = typeof window !== 'undefined';

  if (isTauri || isClient) {
    const stored = localStorage.getItem('pharma_session_user');
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored);
      // Query the database to get the latest permissions/role for this user
      const dbUser = await dbGet('SELECT id, username, role, full_name, pharmacy_id, permissions FROM users WHERE id = ?', [parsed.id]);
      if (dbUser) {
        const updatedUser = {
          id: dbUser.id,
          username: dbUser.username,
          role: dbUser.role,
          full_name: dbUser.full_name,
          pharmacy_id: dbUser.pharmacy_id,
          permissions: dbUser.permissions
        };
        localStorage.setItem('pharma_session_user', JSON.stringify(updatedUser));
        return updatedUser;
      }
      return parsed;
    } catch (e) {
      console.warn('Failed to fetch fresh session from DB, falling back to localStorage:', e);
      try {
        return JSON.parse(stored);
      } catch (_) {
        return null;
      }
    }
  }

  if (process.env.TAURI_BUILD === '1') {
    return null;
  }

  // Server-side
  try {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    const userId = cookieStore.get(SESSION_COOKIE)?.value;

    if (!userId) return null;

    return await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
  } catch (error: any) {
    if (
      error &&
      (error.message?.includes('Dynamic server usage') ||
        error.code === 'NEXT_STATIC_GEN_BAILOUT' ||
        error.digest?.includes('DYNAMIC_SERVER_USAGE'))
    ) {
      throw error;
    }
    console.error('Error fetching server session:', error);
    return null;
  }
});

export async function getPermissionValue(permissionKey: string, defaultValue: any = null) {
  const user = await getLocalSession();
  if (!user) return defaultValue;

  if (user.permissions) {
    let perms = user.permissions;
    let attempts = 0;
    while (typeof perms === 'string' && attempts < 3) {
      try {
        perms = JSON.parse(perms);
      } catch (e) {
        break;
      }
      attempts++;
    }
    if (perms && typeof perms === 'object' && perms[permissionKey] !== undefined) {
      return perms[permissionKey];
    }
  }

  if (user.role === 'owner' || user.role === 'admin') {
    if (permissionKey.includes('discount')) return 100;
    if (permissionKey.includes('max')) return 9999999;
    return true;
  }

  return defaultValue;
}

export async function hasPermission(permissionKey: string) {
  return !!(await getPermissionValue(permissionKey, false));
}

export function hasUserPermissionSync(user: any, permissionKey: string): boolean {
  if (!user) return false;
  if (user.role === 'owner' || user.role === 'admin') return true;
  if (!user.permissions) return false;
  
  let perms = user.permissions;
  let attempts = 0;
  while (typeof perms === 'string' && attempts < 3) {
    try {
      perms = JSON.parse(perms);
    } catch (e) {
      break;
    }
    attempts++;
  }
  
  if (!perms || typeof perms !== 'object') return false;
  return perms[permissionKey] === true || perms[permissionKey] === 'true' || perms[permissionKey] == 1;
}

/**
 * Client-safe session reader — NO React cache() wrapper.
 * Use this in 'use client' components (especially in Tauri builds where
 * React's cache() is memoized at static render time and always returns null).
 * Falls back to raw localStorage value if the DB query fails.
 */
export async function getClientSession() {
  if (typeof window === 'undefined') return null;

  const stored = localStorage.getItem('pharma_session_user');
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored);
    // Try to refresh from DB (works in both Tauri and web client modes)
    try {
      const dbUser = await dbGet(
        'SELECT id, username, role, full_name, pharmacy_id, permissions FROM users WHERE id = ?',
        [parsed.id]
      );
      if (dbUser) {
        const updatedUser = {
          id: dbUser.id,
          username: dbUser.username,
          role: dbUser.role,
          full_name: dbUser.full_name,
          pharmacy_id: dbUser.pharmacy_id,
          permissions: dbUser.permissions,
        };
        localStorage.setItem('pharma_session_user', JSON.stringify(updatedUser));
        return updatedUser;
      }
    } catch (_) {
      // DB not ready yet — fall back to stored value
    }
    return parsed;
  } catch (_) {
    return null;
  }
}
