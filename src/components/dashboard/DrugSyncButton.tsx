'use client';

import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { syncFromCloud } from '@/lib/sync/universal';
import { toast } from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { secureCache } from '@/lib/cache/secure_cache';

export default function DrugSyncButton() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  const handleSync = async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    console.log('DrugSyncButton: Starting sync process...');
    setSyncing(true);
    try {
      const result = await syncFromCloud();
      console.log('DrugSyncButton: Sync result received:', result);
      if (result.success) {
        toast.success(result.message || 'تم تحديث قائمة الأدوية بنجاح');
        
        // Reload cache in background so UI picks up new drugs
        secureCache.reload().catch(e => console.error('Cache reload failed:', e));
        
        // Wait a bit so the user can see the success message
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          router.refresh();
        }, 1500);
      } else {
        toast.error(result.error || 'فشل تحديث الأدوية');
      }
    } catch (err) {
      console.error('DrugSyncButton: Unexpected error:', err);
      toast.error('خطأ في الاتصال بالسحابة');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      console.log('DrugSyncButton: Sync process finished.');
    }
  };

  return (
    <button
      onClick={handleSync}
      disabled={syncing}
      className={`
        inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-semibold shadow-sm transition-colors duration-150
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950
        ${syncing 
          ? 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed shadow-none'
          : 'bg-primary-700 text-white hover:bg-primary-800'}
      `}
    >
      {syncing ? (
        <>
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span>جاري التحديث...</span>
        </>
      ) : (
        <>
          <RefreshCw className="w-4 h-4" />
          <span>تحديث قائمة الأدوية</span>
        </>
      )}
    </button>
  );
}
