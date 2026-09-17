'use client';

import React, { useEffect, useState } from 'react';
import BilingualManagementClient from '@/components/inventory/BilingualManagementClient';
import { dbSelect } from '@/lib/db/tauri';
import { addManufacturerAction, updateGenericBilingualAction, deleteGenericBilingualAction } from '@/app/actions-client/master-drugs';

export default function ManufacturersPage() {
  const [manufacturers, setManufacturers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadManufacturers() {
    try {
      const data = await dbSelect('SELECT * FROM manufacturers ORDER BY name_ar ASC');
      setManufacturers(data);
    } catch (err) {
      console.error('Failed to load manufacturers:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadManufacturers();
  }, []);

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
