'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';
import PurchaseReportsClient from '@/components/reports/PurchaseReportsClient';

export default function PurchaseReportsPage() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const session = await getClientSession();
      setUser(session);
      setLoading(false);
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!user) return <AccessDenied />;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">تقارير المشتريات</h1>
          <p className="text-slate-500 mt-1">تتبع فواتير ومصروفات المشتريات الخاصة بالصيدلية.</p>
        </div>
      </div>

      <PurchaseReportsClient />
    </div>
  )
}
