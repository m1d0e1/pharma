'use client';

import React, { useEffect, useState } from 'react';
import BilingualManagementClient from '@/components/inventory/BilingualManagementClient';
import { dbSelect, dbExecute } from '@/lib/db/tauri';

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

  const handleAdd = async (data: { name_ar: string, name_en?: string }) => {
    try {
      const res = await dbExecute(
        'INSERT INTO manufacturers (name_ar, name_en) VALUES (?, ?)',
        [data.name_ar, data.name_en || null]
      );
      await loadManufacturers();
      return { success: true, id: res.lastInsertId };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  };

  const handleUpdate = async (id: number, data: { name_ar: string, name_en?: string }) => {
    try {
      await dbExecute(
        'UPDATE manufacturers SET name_ar = ?, name_en = ? WHERE id = ?',
        [data.name_ar, data.name_en || null, id]
      );
      await loadManufacturers();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await dbExecute('DELETE FROM manufacturers WHERE id = ?', [id]);
      await loadManufacturers();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  };

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
