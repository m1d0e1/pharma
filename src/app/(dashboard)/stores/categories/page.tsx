'use client';

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getClientSession } from '@/lib/auth/local'
import ProductCategoriesManagement from '@/components/inventory/ProductCategoriesManagement'
import {
  addProductCategoryAction,
  deleteProductCategoryAction,
  getProductCategoriesAction,
  updateProductCategoryAction,
} from '@/app/actions-client/master-drugs'

export default function CategoriesPage() {
  const router = useRouter();
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [sessionError, setSessionError] = useState(false);
  const [authAttempt, setAuthAttempt] = useState(0);
  const loadRequestRef = React.useRef(0);

  async function loadData(reportError = true) {
    const requestId = ++loadRequestRef.current;
    if (reportError) setLoadError('');
    try {
      const result = await getProductCategoriesAction();
      if (requestId !== loadRequestRef.current) return;
      if (!result.success) throw new Error(result.error || 'Failed to load categories');
      setCategories(result.data || []);
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      console.error('Failed to load categories:', err);
      if (reportError) setLoadError('تعذر تحميل مجموعات الأصناف');
    } finally {
      if (reportError && requestId === loadRequestRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    setSessionError(false);
    async function checkAuthAndLoad() {
      try {
        const localUser = await getClientSession();
        if (!active) return;
        if (!localUser) {
          router.push('/login');
          return;
        }
        await loadData();
      } catch (err) {
        if (!active) return;
        console.error('Failed to verify categories session:', err);
        setSessionError(true);
        setLoading(false);
      }
    }
    void checkAuthAndLoad();
    return () => {
      active = false;
      loadRequestRef.current += 1;
    };
  }, [router, authAttempt]);

  const handleAdd = async (data: { name_ar: string, name_en?: string, parent_id: number | null }) => {
    const result = await addProductCategoryAction({ ...data, parent_id: data.parent_id ?? undefined });
    if (result.success) await loadData(false);
    return result;
  }

  const handleUpdate = async (id: number, data: { name_ar: string, name_en?: string, parent_id: number | null }) => {
    const result = await updateProductCategoryAction(id, { ...data, parent_id: data.parent_id ?? undefined });
    if (result.success) await loadData(false);
    return result;
  }

  const handleDelete = async (id: number) => {
    const result = await deleteProductCategoryAction(id);
    if (result.success) await loadData(false);
    return result;
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="flex flex-col justify-center items-center gap-4 py-20" dir="rtl">
        <p className="font-black text-rose-600">تعذر التحقق من جلسة المستخدم</p>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setAuthAttempt(attempt => attempt + 1);
          }}
          className="px-6 py-3 rounded-2xl bg-slate-900 text-white font-black"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col justify-center items-center gap-4 py-20" dir="rtl">
        <p className="font-black text-rose-600">{loadError}</p>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void loadData();
          }}
          className="px-6 py-3 rounded-2xl bg-slate-900 text-white font-black"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in slide-in-up" dir="rtl">
      <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl shadow-soft border border-slate-100 dark:border-slate-800 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">مجموعات الأصناف</h1>
          <p className="text-slate-500 font-bold mt-1">تنظيم المنتجات في شجرة تصنيفات (مستحضرات تجميل، أدوية، منظفات...).</p>
        </div>
      </div>

      <ProductCategoriesManagement 
        initialData={categories} 
        onAdd={handleAdd}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
      />
    </div>
  );
}
