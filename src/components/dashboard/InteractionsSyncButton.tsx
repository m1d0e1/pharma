'use client';

import React, { useRef, useState } from 'react';
import { Zap } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { syncDrugInteractionsClient } from '@/lib/sync/interactions';

export default function InteractionsSyncButton() {
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);

  const handleSync = async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const result = await syncDrugInteractionsClient();
      if ('error' in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`تم تحديث التفاعلات بنجاح. ${result.count} تفاعل جديد/محدث.`);
    } catch (err) {
      console.error('InteractionsSyncButton error:', err);
      toast.error('خطأ في مزامنة التفاعلات');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  };

  return (
    <button
      onClick={handleSync}
      disabled={syncing}
      className={`
        relative overflow-hidden group px-4 py-2.5 rounded-lg font-semibold text-sm transition-colors duration-150
        flex items-center gap-2 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950
        ${syncing
          ? 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none'
          : 'bg-primary-700 text-white hover:bg-primary-800'}
      `}
    >
      {syncing ? (
        <>
          <Zap className="w-4 h-4 animate-pulse" />
          <span>جاري تحديث التفاعلات...</span>
        </>
      ) : (
        <>
          <div className="relative">
            <Zap className="w-4 h-4" />
            <div className="hidden"></div>
          </div>
          <span>تحديث التفاعلات الدوائية</span>
        </>
      )}
    </button>
  );
}
