'use client';

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getClientSession } from '@/lib/auth/local'
import { Info } from 'lucide-react'
import BilingualManagementClient from '@/components/inventory/BilingualManagementClient'
import { dbSelect, dbExecute } from '@/lib/db/tauri'

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
  }, []);

  const handleAdd = async (item: { name_ar: string, name_en?: string }) => {
    try {
      const result = await dbExecute('INSERT INTO usage_methods (name_ar, name_en) VALUES (?, ?)', [item.name_ar, item.name_en || null]);
      await loadData();
      return { success: true, id: result.lastInsertId };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  const handleUpdate = async (id: number, item: { name_ar: string, name_en?: string }) => {
    try {
      await dbExecute('UPDATE usage_methods SET name_ar = ?, name_en = ? WHERE id = ?', [item.name_ar, item.name_en || null, id]);
      await loadData();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  const handleDelete = async (id: number) => {
    try {
      await dbExecute('DELETE FROM usage_methods WHERE id = ?', [id]);
      await loadData();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

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
