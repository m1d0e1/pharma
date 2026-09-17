'use client';

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getClientSession } from '@/lib/auth/local'
import { Info } from 'lucide-react'
import BilingualManagementClient from '@/components/inventory/BilingualManagementClient'
import { dbSelect } from '@/lib/db/tauri'
import { addUsageMethodAction, updateUsageMethodAction, deleteUsageMethodAction } from '@/app/actions-client/master-drugs'

export default function UsagePage() {
  const router = useRouter();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadData() {
    try {
      const result = await dbSelect('SELECT * FROM usage_methods ORDER BY name_ar ASC');
      setData(result);
    } catch (err) {
      console.error('Failed to load usage methods:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    async function checkAuthAndLoad() {
      const localUser = await getClientSession();
      if (!localUser) {
        router.push('/login');
        return;
      }
      await loadData();
    }
    checkAuthAndLoad();
  }, [router]);

  const handleAdd = addUsageMethodAction;
  const handleUpdate = updateUsageMethodAction;
  const handleDelete = deleteUsageMethodAction;

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
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">طرق الإستخدام</h1>
          <p className="text-slate-500 font-bold mt-1">تعليمات تناول الدواء (قبل الأكل، بعد الأكل، دهان خارجي...).</p>
        </div>
      </div>

      <BilingualManagementClient 
        initialData={data} 
        title="طريقة إستخدام" 
        iconName="Info"
        onAdd={handleAdd}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />
    </div>
  )
}
