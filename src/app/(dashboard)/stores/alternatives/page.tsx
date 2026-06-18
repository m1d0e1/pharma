'use client';

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getClientSession } from '@/lib/auth/local'
import DrugAlternativesClient from '@/components/inventory/DrugAlternativesClient'

export default function AlternativesPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function checkAuth() {
      const localUser = await getClientSession();
      if (!localUser) {
        router.push('/login');
        return;
      }
      setLoading(false);
    }
    checkAuth();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in slide-in-up" dir="rtl">
      <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-soft border border-slate-100 dark:border-slate-800 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">بدائل الأصناف والتفاعلات</h1>
          <p className="text-slate-500 font-bold mt-1">ربط الأدوية ببدائلها وتحديد التفاعلات الدوائية والغذائية.</p>
        </div>
      </div>

      <DrugAlternativesClient />
    </div>
  )
}
