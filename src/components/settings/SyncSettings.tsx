'use client';

import React, { useState } from 'react';
import { syncFromCloud } from '@/lib/sync/universal';
import { toast } from 'react-hot-toast';
import { useRouter } from 'next/navigation';

export default function SyncSettings() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const handleSync = async () => {
    setSyncing(true);
    console.log('Starting sync...');
    try {
      const result = await syncFromCloud();
      console.log('Sync result:', result);
      if (result.success) {
        toast.success(result.message || 'تمت المزامنة بنجاح');
        setLastSync(new Date().toLocaleString('ar-EG'));
        router.refresh();
      } else {
        toast.error(result.error || 'فشل المزامنة');
      }
    } catch (err) {
      console.error('Sync execution error:', err);
      toast.error('حدث خطأ أثناء تنفيذ المزامنة');
    }
    setSyncing(false);
  };

  return (
    <div className="bg-gradient-to-br from-indigo-800 to-slate-900 p-8 rounded-[2rem] text-white shadow-2xl relative overflow-hidden group">
      <div className="absolute -top-10 -right-10 w-40 h-40 bg-blue-500/10 blur-3xl rounded-full"></div>
      
      <div className="flex items-center gap-4 mb-6">
        <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center text-2xl">🧠</div>
        <div>
          <h4 className="text-xl font-bold">Cloud Admin (The Brain)</h4>
          <p className="text-indigo-200 text-xs">تحميل قائمة الأدوية والتحقق من الاشتراك</p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">
          <p className="text-sm text-indigo-100 leading-relaxed mb-6">
            يقوم هذا الإجراء بالاتصال بالسحابة لجلب أحدث قائمة أدوية معتمدة والتحقق من حالة اشتراك صيدليتك. بعد المزامنة، ستعمل الصيدلية بشكل محلي بالكامل.
          </p>
          
          <button 
            onClick={handleSync}
            disabled={syncing}
            className="w-full py-4 bg-white text-indigo-900 rounded-2xl font-black shadow-xl hover:bg-indigo-50 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {syncing ? 'جاري المزامنة...' : 'مزامنة مع السحابة الآن'}
            {!syncing && <span>⚡</span>}
          </button>
        </div>
        
        <p className="text-[10px] text-center text-indigo-300 font-bold uppercase tracking-wider">
          آخر مزامنة: {lastSync || 'لم يتم المزامنة بعد'}
        </p>
      </div>
    </div>
  );
}
