'use client';

import React, { useEffect, useState } from 'react';
import BilingualManagementClient from '@/components/inventory/BilingualManagementClient';
import { dbSelect, dbExecute } from '@/lib/db/tauri';

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadSuppliers() {
      try {
        const data = await dbSelect('SELECT * FROM suppliers ORDER BY id DESC');
        setSuppliers(data);
      } catch (err) {
        console.error('Failed to load suppliers:', err);
      } finally {
        setLoading(false);
      }
    }
    loadSuppliers();
  }, []);

  const handleAdd = async (data: { name_ar: string, name_en?: string }) => {
    try {
      const res = await dbExecute(
        'INSERT INTO suppliers (name_ar, name_en) VALUES (?, ?)',
        [data.name_ar, data.name_en || null]
      );
      return { success: true, id: res.lastInsertId };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  };

  const handleUpdate = async (id: number, data: { name_ar: string, name_en?: string }) => {
    try {
      await dbExecute(
        'UPDATE suppliers SET name_ar = ?, name_en = ? WHERE id = ?',
        [data.name_ar, data.name_en || null, id]
      );
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await dbExecute('DELETE FROM suppliers WHERE id = ?', [id]);
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
      title="الموردين"
      initialData={suppliers}
      iconName="Users"
      onAdd={handleAdd}
      onUpdate={handleUpdate}
      onDelete={handleDelete}
    />
  );
}
