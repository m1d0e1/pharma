'use client';

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getClientSession } from '@/lib/auth/local'
import ProductCategoriesManagement from '@/components/inventory/ProductCategoriesManagement'
import { dbSelect, dbExecute, dbGet } from '@/lib/db/tauri'

export default function CategoriesPage() {
  const router = useRouter();
  const [categories, setCategories] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadData() {
    try {
      const data = await dbSelect('SELECT * FROM product_categories ORDER BY name_ar ASC');
      setCategories(data);
    } catch (err) {
      console.error('Failed to load categories:', err);
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

  const handleAdd = async (data: { name_ar: string, name_en?: string, parent_id?: number }) => {
    try {
      const result = await dbExecute(
        'INSERT INTO product_categories (name_ar, name_en, parent_id) VALUES (?, ?, ?)',
        [data.name_ar, data.name_en || null, data.parent_id || null]
      );
      await loadData();
      return { success: true, id: result.lastInsertId };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  const handleUpdate = async (id: number, data: { name_ar: string, name_en?: string, parent_id?: number }) => {
    try {
      await dbExecute(
        'UPDATE product_categories SET name_ar = ?, name_en = ?, parent_id = ? WHERE id = ?',
        [data.name_ar, data.name_en || null, data.parent_id || null, id]
      );
      await loadData();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  const handleDelete = async (id: number) => {
    try {
      const check = await dbGet('SELECT COUNT(*) as count FROM product_categories WHERE parent_id = ?', [id]);
      if (check && check.count > 0) {
        return { success: false, error: 'لا يمكن حذف مجموعة تحتوي على مجموعات فرعية' };
      }
      await dbExecute('DELETE FROM product_categories WHERE id = ?', [id]);
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
