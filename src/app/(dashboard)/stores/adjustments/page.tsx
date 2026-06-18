'use client';

import React, { useEffect, useState } from 'react';
import { dbSelect } from '@/lib/db/tauri';
import AdjustmentsClient from "./AdjustmentsClient";

export default function AdjustmentsPage() {
  const [reasons, setReasons] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadReasons() {
      try {
        const data = await dbSelect('SELECT * FROM adjustment_reasons ORDER BY name_ar ASC');
        setReasons(data);
      } catch (err) {
        console.error('Failed to load adjustment reasons:', err);
      } finally {
        setLoading(false);
      }
    }
    loadReasons();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <AdjustmentsClient 
      reasons={reasons} 
    />
  );
}
