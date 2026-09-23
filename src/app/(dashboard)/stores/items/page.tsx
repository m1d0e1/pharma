'use client';

import React, { useEffect, useState } from 'react';
import ItemsManagementClient from '@/components/inventory/ItemsManagementClient';
import { dbSelect, dbGet } from '@/lib/db/tauri';

export default function ItemsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadItems() {
      setLoading(true);
      setLoadError('');
      try {
        const [data, countRes] = await Promise.all([
          dbSelect(`
            SELECT * FROM master_drugs 
            ORDER BY trade_name ASC 
            LIMIT 100
          `),
          dbGet('SELECT COUNT(*) as count FROM master_drugs')
        ]);
        if (active) {
          setItems(data || []);
          setTotalCount(Number(countRes?.count) || (data || []).length);
        }
      } catch (err) {
        console.error('Failed to load master drugs:', err);
        if (active) setLoadError('تعذر تحميل بيانات الأصناف');
      } finally {
        if (active) setLoading(false);
      }
    }

    loadItems();
    return () => { active = false; };
  }, [loadAttempt]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
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
      <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-soft border border-slate-100 dark:border-slate-800">
        <div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">إدارة الأصناف</h1>
          <p className="text-slate-500 font-bold mt-1">تعريف وتعديل بيانات الأدوية والمنتجات في النظام.</p>
        </div>
      </div>

      <React.Suspense fallback={<div className="text-center py-10">جاري تحميل الأصناف...</div>}>
        <ItemsManagementClient initialItems={items} totalCount={totalCount} />
      </React.Suspense>
    </div>
  );
}
