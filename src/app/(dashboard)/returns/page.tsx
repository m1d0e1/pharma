'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import ReturnsClient from '@/components/returns/ReturnsClient';
import { useRouter } from 'next/navigation';
import AccessDenied from '@/components/AccessDenied';

export default function ReturnsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    async function checkAuth() {
      const userObj = await getClientSession();
      if (!userObj) {
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

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">المرتجعات والاستبدال</h1>
          <p className="text-slate-500 mt-1">إدارة مرتجعات العملاء واستعادة المخزون تلقائياً</p>
        </div>
      </div>

      <ReturnsClient title="المرتجعات" />
    </div>
  );
}
