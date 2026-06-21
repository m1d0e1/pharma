'use client';

import React, { useEffect, useState } from 'react';
import { getAdjustmentsAction } from '@/app/actions-client/inventory';
import AdjustmentsClient from "./AdjustmentsClient";

export default function AdjustmentsPage() {
  const [reasons, setReasons] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadReasons() {
      try {
        const res = await getAdjustmentsAction();
        if (res.success) {
          setReasons(res.data || []);
        } else {
          console.error('Failed to load adjustment reasons:', (res as any).error);
        }
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
