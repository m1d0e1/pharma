'use client';

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getClientSession } from '@/lib/auth/local'
import { dbSelect, dbExecute } from '@/lib/db/tauri'
import DeleteUnusedItemsClient from '@/components/inventory/DeleteUnusedItemsClient'

export default function DeleteUnusedItemsPage() {
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);

  async function loadData() {
    try {
      const data = await dbSelect(`
        SELECT * FROM master_drugs 
        WHERE id NOT IN (SELECT drug_id FROM inventory)
        AND id NOT IN (SELECT drug_id FROM sales_items)
        ORDER BY trade_name ASC
      `);
      setItems(data);
    } catch (err) {
      console.error('Failed to load unused items:', err);
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
      
      if (localUser.role !== 'owner' && localUser.role !== 'admin') {
        router.push('/inventory');
        return;
      }

      setIsAuthorized(true);
      await loadData();
    }
    checkAuthAndLoad();
  }, []);

  const handleDelete = async (id: number) => {
    try {
      const localUser = await getClientSession();
      if (!localUser || (localUser.role !== 'owner' && localUser.role !== 'admin')) {
        return { success: false, error: 'ليس لديك صلاحية الحذف' };
      }

      await dbExecute('DELETE FROM master_drugs WHERE id = ?', [id]);
      await loadData();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  if (loading || !isAuthorized) {
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
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">حذف الأصناف التي لم يتم عليها حركات</h1>
          <p className="text-slate-500 font-bold mt-1">تنظيف قاعدة البيانات من الأصناف غير المستخدمة والقديمة.</p>
        </div>
      </div>

      <DeleteUnusedItemsClient initialItems={items} onDelete={handleDelete} />
    </div>
  )
}
