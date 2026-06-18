'use client';

import React, { useState } from 'react';
import { RefreshCw, CheckCircle2 } from 'lucide-react';
import { syncFromCloud } from '@/lib/sync/universal';
import { toast } from 'react-hot-toast';
import { useRouter } from 'next/navigation';

export default function DrugSyncButton() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    console.log('DrugSyncButton: Starting sync process...');
    setSyncing(true);
    try {
      const result = await syncFromCloud();
      console.log('DrugSyncButton: Sync result received:', result);
      if (result.success) {
        toast.success(result.message || 'تم تحديث قائمة الأدوية بنجاح');
        // Wait a bit so the user can see the success message
        setTimeout(() => {
          router.refresh();
        }, 1500);
      } else {
        toast.error(result.error || 'فشل تحديث الأدوية');
      }
    } catch (err) {
      console.error('DrugSyncButton: Unexpected error:', err);
      toast.error('خطأ في الاتصال بالسحابة');
    } finally {
      setSyncing(false);
      console.log('DrugSyncButton: Sync process finished.');
    }
  };

  return (
    <button
      onClick={handleSync}
      disabled={syncing}
      className={`
        relative overflow-hidden group px-6 py-3 rounded-2xl font-black text-sm transition-all duration-500
        flex items-center gap-3 shadow-xl
        ${syncing 
          ? 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none' 
          : 'bg-gradient-to-r from-blue-600 to-indigo-700 text-white hover:shadow-blue-500/30 hover:-translate-y-1 active:scale-95'}
      `}
    >
      {syncing ? (
        <>
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span>جاري التحديث...</span>
        </>
      ) : (
        <>
          <div className="relative">
            <RefreshCw className="w-4 h-4 group-hover:rotate-180 transition-transform duration-700" />
            <div className="absolute inset-0 bg-white/20 blur-md rounded-full scale-150 opacity-0 group-hover:opacity-100 transition-opacity"></div>
          </div>
          <span>تحديث قائمة الأدوية</span>
        </>
      )}
    </button>
  );
}
