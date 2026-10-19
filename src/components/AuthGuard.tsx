'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
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

  useEffect(() => {
    let active = true;
    setAuthorized(false);
    setLoading(true);
    setCheckError(false);
    async function checkAuth() {
      try {
        const user = await getClientSession();
        if (!active) return;
        
        if (!user) {
          // DashboardLayout is not mounted on /login. Revalidate this shared
          // shell at mount/role change/retry, not every child pathname change:
          // route-specific PermissionGuard still checks each destination.
          router.push('/login');
          return;
        }

        const satisfiesRequiredRole = !requiredRole || user.role === requiredRole ||
          user.role === 'owner' || (requiredRole !== 'owner' && user.role === 'admin');
        if (!satisfiesRequiredRole) {
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
  }, [router, requiredRole, retryAttempt]);

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
