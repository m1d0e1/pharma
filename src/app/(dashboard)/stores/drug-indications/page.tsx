'use client';

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getClientSession } from '@/lib/auth/local'
import DrugIndicationsClient from '@/components/inventory/DrugIndicationsClient'
import { dbSelect } from '@/lib/db/tauri'

export default function DrugIndicationsPage() {
  const router = useRouter();
  const [indications, setIndications] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function checkAuthAndLoad() {
      const localUser = await getClientSession();
      if (!localUser) {
        router.push('/login');
        return;
      }
      
      try {
        const data = await dbSelect('SELECT * FROM indications ORDER BY name_ar ASC');
        setIndications(data);
      } catch (err) {
        console.error('Failed to load indications:', err);
      } finally {
        setLoading(false);
      }
    }
    checkAuthAndLoad();
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
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">أصناف دواعي الاستخدام</h1>
          <p className="text-slate-500 font-bold mt-1">ربط الأدوية بدواعي استعمالها الطبية لتسهيل البحث وخدمة العملاء.</p>
        </div>
      </div>

      <DrugIndicationsClient indications={indications} />
    </div>
  )
}
