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
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    async function checkAuth() {
      try {
        const user = await getClientSession();
        
        if (!user) {
          // Prevent infinite redirect loops if already on login page
          if (pathname !== '/login') {
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
        console.error('AuthGuard verification failed:', err);
        router.push('/login');
      } finally {
        setLoading(false);
      }
    }

    checkAuth();
  }, [router, pathname, requiredRole]);

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

  return authorized ? <>{children}</> : null;
}
