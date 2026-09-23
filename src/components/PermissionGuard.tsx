'use client';

import { useEffect, useState } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';

interface PermissionGuardProps {
  children: React.ReactNode;
  permissionKey?: string;
  fallback?: React.ReactNode;
}

export default function PermissionGuard({ children, permissionKey, fallback = <AccessDenied /> }: PermissionGuardProps) {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [checkError, setCheckError] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);

  useEffect(() => {
    let active = true;

    async function checkPermission() {
      setAuthorized(null);
      setCheckError(false);
      try {
        const user = await getClientSession();
        if (!active) return;
        if (!user) {
          setAuthorized(false);
          return;
        }

        if (permissionKey) {
          const hasPerm = hasUserPermissionSync(user, permissionKey);
          setAuthorized(hasPerm);
        } else {
          setAuthorized(true);
        }
      } catch {
        if (active) {
          setCheckError(true);
          setAuthorized(false);
        }
      }
    }
    checkPermission();
    return () => {
      active = false;
    };
  }, [permissionKey, retryAttempt]);

  if (checkError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4 text-center">
        <p className="font-black text-slate-800 dark:text-slate-100">تعذر التحقق من الصلاحيات</p>
        <button
          type="button"
          onClick={() => setRetryAttempt(attempt => attempt + 1)}
          className="px-5 py-2 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (authorized === null) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
      </div>
    );
  }

  return authorized ? <>{children}</> : <>{fallback}</>;
}
