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

  useEffect(() => {
    async function checkPermission() {
      const user = await getClientSession();
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
    }
    checkPermission();
  }, [permissionKey]);

  if (authorized === null) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto"></div>
      </div>
    );
  }

  return authorized ? <>{children}</> : <>{fallback}</>;
}
