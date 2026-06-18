'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession } from '@/lib/auth/local';
import ItemsManagementClient from '@/components/inventory/ItemsManagementClient';
import { dbSelect } from '@/lib/db/tauri';

export default function ItemsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadItems() {
      try {
        const localUser = await getClientSession();
        if (!localUser) return;

        const data = await dbSelect(`
          SELECT * FROM master_drugs 
          ORDER BY trade_name ASC 
          LIMIT 100
        `);
        setItems(data || []);
      } catch (err) {
        console.error('Failed to load master drugs:', err);
      } finally {
        setLoading(false);
      }
    }

    loadItems();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in slide-in-up" dir="rtl">
      <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-soft border border-slate-100 dark:border-slate-800">
        <div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">إدارة الأصناف</h1>
          <p className="text-slate-500 font-bold mt-1">تعريف وتعديل بيانات الأدوية والمنتجات في النظام.</p>
        </div>
      </div>

      <React.Suspense fallback={<div className="text-center py-10">جاري تحميل الأصناف...</div>}>
        <ItemsManagementClient initialItems={items} />
      </React.Suspense>
    </div>
  );
}
