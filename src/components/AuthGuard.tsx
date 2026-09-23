'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { getClientSession } from '@/lib/auth/local';

interface AuthGuardProps {
  children: React.ReactNode;
  requiredRole?: string;
}

export default function AuthGuard({ children, requiredRole }: AuthGuardProps) {
  const [authorized, setAuthorized] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checkError, setCheckError] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let active = true;
    setAuthorized(false);
    setLoading(true);
    setCheckError(false);
    const log = (m: string) => typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__?.invoke('log_frontend_error', { message: m });
    async function checkAuth() {
      try {
        log('AUTHGUARD: checking session...');
        const user = await getClientSession();
        if (!active) return;
        log('AUTHGUARD: user=' + (user ? user.username : 'NULL'));
        
        if (!user) {
          // Prevent infinite redirect loops if already on login page
          if (pathname !== '/login') {
            log('AUTHGUARD: redirecting to /login');
            router.push('/login');
          }
          return;
        }

        if (requiredRole && user.role !== requiredRole && user.role !== 'owner' && user.role !== 'admin') {
          router.push('/');
          return;
        }

        setAuthorized(true);
      } catch (err) {
        if (!active) return;
        console.error('AuthGuard verification failed:', err);
        setCheckError(true);
      } finally {
        if (active) setLoading(false);
      }
    }

    void checkAuth();
    return () => {
      active = false;
    };
  }, [router, pathname, requiredRole, retryAttempt]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50 dark:bg-slate-900" dir="rtl">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 dark:border-blue-400 mx-auto"></div>
          <p className="mt-4 text-slate-600 dark:text-slate-400 font-medium">جاري التحقق من الهوية...</p>
        </div>
      </div>
    );
  }

  if (checkError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 bg-slate-50 dark:bg-slate-900" dir="rtl">
        <p className="font-black text-slate-800 dark:text-slate-100">تعذر التحقق من الهوية</p>
        <button
          type="button"
          onClick={() => setRetryAttempt(attempt => attempt + 1)}
          className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return authorized ? <>{children}</> : null;
}
