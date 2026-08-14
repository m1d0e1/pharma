'use client';

import React, { useEffect, useState, useCallback } from 'react';
import SuppliersManagementClient from '@/components/purchases/SuppliersManagementClient';
import {
  addSupplierAction,
  deleteSupplierAction,
  getSuppliersAction,
  updateSupplierAction,
} from '@/app/actions-client/purchases';

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const loadSuppliers = useCallback(async () => {
    try {
      const result = await getSuppliersAction();
      if (!result.success) throw new Error(result.error || 'فشل تحميل الموردين');
      setSuppliers(result.data || []);
    } catch (err) {
      console.error('Failed to load suppliers:', err);
      setLoadError(err instanceof Error ? err.message : 'فشل تحميل الموردين');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSuppliers();
  }, [loadSuppliers]);

  const handleAdd = async (data: { name_ar: string; name_en?: string; phone?: string; address?: string }) => {
    return addSupplierAction(data);
  };

  const handleUpdate = async (id: number, data: { name_ar: string; name_en?: string; phone?: string; address?: string }) => {
    return updateSupplierAction(id, data);
  };

  const handleDelete = async (id: number) => {
    return deleteSupplierAction(id);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center font-bold text-red-700" dir="rtl">
        {loadError}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center" dir="rtl">
        <div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white">دليل الموردين والحسابات</h1>
          <p className="text-slate-500 font-bold mt-1">متابعة مديونيات الموردين، كشوف الحسابات، وسداد الدفعات النقدية والبنكية.</p>
        </div>
      </div>

      <SuppliersManagementClient
        initialData={suppliers}
        onAdd={handleAdd}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
        onRefresh={loadSuppliers}
      />
    </div>
  );
}
