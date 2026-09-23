'use client';

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getClientSession } from '@/lib/auth/local'
import { FlaskConical } from 'lucide-react'
import BilingualManagementClient from '@/components/inventory/BilingualManagementClient'
import { dbSelect } from '@/lib/db/tauri'
import { addScientificGroupAction, updateScientificGroupAction, deleteScientificGroupAction } from '@/app/actions-client/master-drugs'

export default function ScientificGroupsPage() {
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
        const result = await dbSelect('SELECT * FROM scientific_groups ORDER BY name_ar ASC');
        if (active) setData(result);
      } catch (err) {
        console.error('Failed to load scientific groups:', err);
        if (active) setLoadError('تعذر تحميل بيانات القائمة');
      } finally {
        if (active) setLoading(false);
      }
    }
    checkAuthAndLoad();
    return () => { active = false; };
  }, [router, loadAttempt]);

  const handleAdd = addScientificGroupAction;
  const handleUpdate = updateScientificGroupAction;
  const handleDelete = deleteScientificGroupAction;

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
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">المجموعات العلمية</h1>
          <p className="text-slate-500 font-bold mt-1">التصنيف العلمي والطبي للأدوية (مضادات حيوية، مسكنات...).</p>
        </div>
      </div>

      <BilingualManagementClient 
        title="مجموعة علمية"
        initialData={data} 
        iconName="FlaskConical"
        onAdd={handleAdd}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />
    </div>
  );
}
