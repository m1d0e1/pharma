'use client';

import React, { useEffect, useState } from 'react';
import { getShortagesAction } from '@/app/actions-client/shortages';
import ShortagesClient from "./ShortagesClient";
import { subscribeInventoryChanges } from '@/lib/inventory/refresh';

export default function ShortagesPage() {
  const [shortages, setShortages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => subscribeInventoryChanges(() => setLoadAttempt(attempt => attempt + 1)), []);

  useEffect(() => {
    let active = true;
    async function loadShortages() {
      setLoading(true);
      setLoadError('');
      try {
        const result = await getShortagesAction();
        if (!result.success) throw new Error(result.error || 'فشل تحميل كشكول النواقص');
        if (active) setShortages(result.data || []);
      } catch (err) {
        console.error('Failed to load shortages:', err);
        if (active) setLoadError('تعذر تحميل كشكول النواقص');
      } finally {
        if (active) setLoading(false);
      }
    }
    loadShortages();
    return () => { active = false; };
  }, [loadAttempt]);

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
    <ShortagesClient 
      initialData={shortages} 
    />
  );
}
