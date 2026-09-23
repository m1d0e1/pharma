'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local'
import { getUnusedDrugsAction, deleteDrugAction } from '@/app/actions-client/inventory'
import DeleteUnusedItemsClient from '@/components/inventory/DeleteUnusedItemsClient'
import DrugReplacementDialog from '@/components/master-drugs/DrugReplacementDialog';

export default function DeleteUnusedItemsPage() {
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [replacement, setReplacement] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const loadRequestRef = useRef(0);
  const routeRequestRef = useRef(0);

  const loadData = useCallback(async (reportError = false) => {
    const requestId = ++loadRequestRef.current;
    try {
      const res = await getUnusedDrugsAction();
      if (requestId !== loadRequestRef.current) return;
      if (res.success) {
        setItems(res.data || []);
      } else {
        console.error('Failed to load unused items:', (res as any).error);
        if (reportError) setLoadError('تعذر تحميل قائمة الأصناف القابلة للحذف');
      }
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      console.error('Failed to load unused items:', err);
      if (reportError) setLoadError('تعذر تحميل قائمة الأصناف القابلة للحذف');
    } finally {
      if (reportError && requestId === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    async function checkAuthAndLoad() {
      const requestId = ++routeRequestRef.current;
      setLoading(true);
      setLoadError('');
      setIsAuthorized(false);
      try {
        const localUser = await getClientSession();
        if (requestId !== routeRequestRef.current) return;
        if (!localUser) {
          router.push('/login');
          return;
        }

        if (
          (localUser.role !== 'owner' && localUser.role !== 'admin')
          || !hasUserPermissionSync(localUser, 'can_manage_inventory')
        ) {
          router.push('/inventory');
          return;
        }

        setIsAuthorized(true);
        await loadData(true);
      } catch (err) {
        if (requestId !== routeRequestRef.current) return;
        console.error('Failed to load delete-items route:', err);
        setLoadError('تعذر تحميل قائمة الأصناف القابلة للحذف');
        setLoading(false);
      }
    }
    void checkAuthAndLoad();
    return () => {
      routeRequestRef.current += 1;
    };
  }, [router, loadData, retryAttempt]);

  const handleDelete = async (id: number) => {
    try {
      const res = await deleteDrugAction(id);
      if (res.success) {
        await loadData();
        return { success: true };
      }
      if ((res as any).code === 'DRUG_IN_USE' || /Drugs with inventory, transaction, or clinical history/i.test(res.error || '')) {
        setReplacement(items.find(item => item.id === id) || { id });
        return { success: false, error: 'اختر الحذف الآمن أو نقل الروابط إلى بديل من نافذة التحذير' };
      }
      return res;
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

  if (loadError) {
    return (
      <div className="flex flex-col justify-center items-center gap-4 py-16" dir="rtl">
        <p className="font-black text-rose-600">{loadError}</p>
        <button
          type="button"
          onClick={() => setRetryAttempt(attempt => attempt + 1)}
          className="px-6 py-3 rounded-2xl bg-slate-900 text-white font-black"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (!isAuthorized) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in slide-in-up" dir="rtl">
      {replacement && <DrugReplacementDialog source={replacement} onClose={() => setReplacement(null)} onArchived={async () => { setReplacement(null); await loadData(); }} onSuccess={async () => { setReplacement(null); await loadData(); }} />}
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
