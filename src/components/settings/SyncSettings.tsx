'use client';

import React, { useRef, useState } from 'react';
import { syncFromCloud } from '@/lib/sync/universal';
import { toast } from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { DatabaseZap, RefreshCw } from 'lucide-react';

export default function SyncSettings() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const syncingRef = useRef(false);

  const handleSync = async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    console.log('Starting sync...');
    try {
      const result = await syncFromCloud();
      console.log('Sync result:', result);
      if (result.success) {
        toast.success(result.message || 'تمت المزامنة بنجاح');
        setLastSync(new Date().toLocaleString('ar-EG'));
        try {
          router.refresh();
        } catch (refreshError) {
          console.error('Post-sync refresh failed:', refreshError);
        }
      } else {
        toast.error(result.error || 'فشل المزامنة');
      }
    } catch (err) {
      console.error('Sync execution error:', err);
      toast.error('حدث خطأ أثناء تنفيذ المزامنة');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  };

  return (
    <div className="bg-slate-900 dark:bg-slate-900 p-5 sm:p-6 rounded-xl text-white shadow-sm border border-slate-800">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-10 h-10 bg-white/10 rounded-lg flex items-center justify-center"><DatabaseZap className="w-5 h-5" aria-hidden="true" /></div>
        <div>
          <h4 className="text-xl font-bold">تحديث البيانات المرجعية</h4>
          <p className="text-indigo-200 text-sm">تحميل قائمة الأدوية والتفاعلات العامة</p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="bg-white/5 border border-white/10 p-5 rounded-lg">
          <p className="text-sm text-indigo-100 leading-relaxed mb-6">
            الاتصال بالسحابة اختياري ويُستخدم فقط لجلب أحدث قائمة أدوية وتفاعلات عامة. تسجيل الدخول وإدارة المستخدمين يظلان محليين بالكامل.
          </p>
          
          <button 
            type="button"
            onClick={handleSync}
            disabled={syncing}
            className="w-full py-2.5 bg-white text-slate-900 rounded-lg font-semibold shadow-sm hover:bg-slate-100 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {syncing ? 'جاري التحديث...' : 'تحديث البيانات المرجعية الآن'}
            {!syncing && <RefreshCw className="w-4 h-4" aria-hidden="true" />}
          </button>
        </div>
        
        <p className="text-xs text-center text-indigo-300 font-bold">
          آخر مزامنة: {lastSync || 'لم يتم المزامنة بعد'}
        </p>
      </div>
    </div>
  );
}
