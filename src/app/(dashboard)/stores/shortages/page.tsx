'use client';

import React, { useEffect, useState } from 'react';
import { getShortagesAction } from '@/app/actions-client/shortages';
import ShortagesClient from "./ShortagesClient";

export default function ShortagesPage() {
  const [shortages, setShortages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadShortages() {
      try {
        const result = await getShortagesAction();
        if (!result.success) throw new Error(result.error || 'فشل تحميل كشكول النواقص');
        setShortages(result.data || []);
      } catch (err) {
        console.error('Failed to load shortages:', err);
      } finally {
        setLoading(false);
      }
    }
    loadShortages();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <ShortagesClient 
      initialData={shortages} 
    />
  );
}
