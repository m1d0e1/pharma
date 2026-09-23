'use client';

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getClientSession } from '@/lib/auth/local'
import { FileText } from 'lucide-react'
import BilingualManagementClient from '@/components/inventory/BilingualManagementClient'
import { dbSelect } from '@/lib/db/tauri'
import { addItemNatureAction, updateItemNatureAction, deleteItemNatureAction } from '@/app/actions-client/master-drugs'

export default function NaturePage() {
  const router = useRouter();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function checkAuthAndLoad() {
      setLoading(true);
      setLoadError('');
      try {
        const localUser = await getClientSession();
        if (!active) return;
        if (!localUser) {
          router.push('/login');
          return;
        }
        const result = await dbSelect('SELECT * FROM item_natures ORDER BY name_ar ASC');
        if (active) setData(result);
      } catch (err) {
        console.error('Failed to load natures:', err);
        if (active) setLoadError('تعذر تحميل بيانات القائمة');
      } finally {
        if (active) setLoading(false);
      }
    }
    checkAuthAndLoad();
    return () => { active = false; };
  }, [router, loadAttempt]);

  const handleAdd = addItemNatureAction;
  const handleUpdate = updateItemNatureAction;
  const handleDelete = deleteItemNatureAction;

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20" dir="rtl">
        <p className="font-black text-rose-600">{loadError}</p>
        <button type="button" onClick={() => setLoadAttempt(attempt => attempt + 1)} className="px-6 py-3 rounded-2xl bg-slate-900 text-white font-black">
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in slide-in-up" dir="rtl">
      <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-soft border border-slate-100 dark:border-slate-800 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">طبيعة الأصناف</h1>
          <p className="text-slate-500 font-bold mt-1">تصنيف شكل الدواء أو طبيعته (أقراص، كبسول، شراب...).</p>
        </div>
      </div>

      <BilingualManagementClient 
        initialData={data} 
        title="طبيعة صنف" 
        iconName="FileText"
        onAdd={handleAdd}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />
    </div>
  )
}
