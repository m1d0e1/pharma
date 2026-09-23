'use client';

import React, { useEffect, useState } from 'react';
import BilingualManagementClient from '@/components/inventory/BilingualManagementClient';
import { dbSelect } from '@/lib/db/tauri';
import { addManufacturerAction, updateGenericBilingualAction, deleteGenericBilingualAction } from '@/app/actions-client/master-drugs';

export default function ManufacturersPage() {
  const [manufacturers, setManufacturers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadManufacturers() {
      setLoading(true);
      setLoadError('');
      try {
        const data = await dbSelect('SELECT * FROM manufacturers ORDER BY name_ar ASC');
        if (active) setManufacturers(data);
      } catch (err) {
        console.error('Failed to load manufacturers:', err);
        if (active) setLoadError('تعذر تحميل بيانات القائمة');
      } finally {
        if (active) setLoading(false);
      }
    }
    loadManufacturers();
    return () => { active = false; };
  }, [loadAttempt]);

  const handleAdd = addManufacturerAction;
  const handleUpdate = (id: number, data: { name_ar: string, name_en?: string }) => updateGenericBilingualAction('manufacturers', id, data);
  const handleDelete = (id: number) => deleteGenericBilingualAction('manufacturers', id);

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
    <BilingualManagementClient
      title="الشركات المنتجة"
      initialData={manufacturers}
      iconName="Building2"
      onAdd={handleAdd}
      onUpdate={handleUpdate}
      onDelete={handleDelete}
    />
  );
}
