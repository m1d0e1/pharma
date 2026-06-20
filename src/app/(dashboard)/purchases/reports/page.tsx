'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';
import PurchaseReportsClient from '@/components/reports/PurchaseReportsClient';
import { Printer } from 'lucide-react';

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
        <button onClick={() => window.print()} className="flex items-center gap-2 px-6 py-3 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-xl font-bold border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 transition-all shadow-sm no-print">
          <Printer className="w-5 h-5" />
          طباعة التقارير
        </button>
      </div>

      <PurchaseReportsClient />
    </div>
  )
}
