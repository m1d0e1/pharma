'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import SalesReturnClient from './SalesReturnClient';
import { useRouter } from 'next/navigation';
import AccessDenied from '@/components/AccessDenied';

export default function NewSalesReturnPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    async function checkAuth() {
      const userObj = await getClientSession();
      if (!userObj) {
        setLoading(false);
        router.push('/login');
      } else {
        setUser(userObj);
        const isAllowed = hasUserPermissionSync(userObj, 'can_view_returns');
        if (isAllowed) {
          setAllowed(true);
        }
        setLoading(false);
      }
    }
    checkAuth();
  }, [router]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  return <SalesReturnClient />;
}
