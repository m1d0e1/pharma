'use client';

import React, { useEffect, useState } from 'react';
import BilingualManagementClient from '@/components/inventory/BilingualManagementClient';
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

  useEffect(() => {
    async function loadSuppliers() {
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
    }
    loadSuppliers();
  }, []);

  const handleAdd = async (data: { name_ar: string, name_en?: string }) => {
    return addSupplierAction(data);
  };

  const handleUpdate = async (id: number, data: { name_ar: string, name_en?: string }) => {
    return updateSupplierAction(id, data);
  };

  const handleDelete = async (id: number) => {
    return deleteSupplierAction(id);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
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
    <BilingualManagementClient
      title="الموردين"
      initialData={suppliers}
      iconName="Users"
      onAdd={handleAdd}
      onUpdate={handleUpdate}
      onDelete={handleDelete}
    />
  );
}
