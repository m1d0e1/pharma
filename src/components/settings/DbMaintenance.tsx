'use client';

import React, { useState } from 'react';
import { Database, ShieldAlert, Sparkles, RefreshCw } from 'lucide-react';
import { runDatabaseMaintenanceClient } from '@/lib/settings/client';
import { toast } from 'react-hot-toast';

export default function DbMaintenance() {
  const [running, setRunning] = useState(false);

  const handleMaintenance = async () => {
    setRunning(true);
    const toastId = toast.loading('جاري إجراء صيانة قاعدة البيانات (VACUUM & ANALYZE)...');
    try {
      const result = await runDatabaseMaintenanceClient();
      if (result.success) {
        toast.success(result.message || 'تم تحسين قاعدة البيانات بنجاح', { id: toastId });
      } else {
        toast.error(result.error || 'فشلت عملية الصيانة', { id: toastId });
      }
    } catch (err) {
      console.error('Maintenance execution error:', err);
      toast.error('حدث خطأ غير متوقع أثناء تنفيذ الصيانة', { id: toastId });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="bg-gradient-to-br from-slate-900 to-slate-950 p-8 rounded-[2rem] text-white shadow-2xl relative overflow-hidden group">
      <div className="absolute -top-10 -right-10 w-40 h-40 bg-blue-500/10 blur-3xl rounded-full"></div>
      
      <div className="flex items-center gap-4 mb-6">
        <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center text-2xl">
          <Database className="w-6 h-6 text-blue-400" />
        </div>
        <div>
          <h4 className="text-xl font-bold">صيانة قاعدة البيانات (Local Enforcer)</h4>
          <p className="text-slate-400 text-xs">تحسين وضغط التخزين المحلي وتسريع الاستعلامات</p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="bg-white/5 border border-white/10 p-6 rounded-2xl space-y-4">
          <p className="text-sm text-slate-300 leading-relaxed">
            يقوم هذا الإجراء بإعادة بناء ملف قاعدة البيانات بالكامل لاستعادة المساحة المهدرة الناتجة عن حذف الفواتير والأصناف السابقة (`VACUUM`)، ويقوم بتحديث إحصائيات الفهارس لتسريع محرك بحث SQLite (`ANALYZE`).
          </p>

          <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl flex gap-3 text-amber-200">
            <ShieldAlert className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed font-semibold">
              تنبيه: قد تتوقف عمليات الكتابة والقراءة لثوانٍ معدودة أثناء إجراء الصيانة. يُنصح بإجرائها خارج أوقات الذروة.
            </p>
          </div>
          
          <button 
            onClick={handleMaintenance}
            disabled={running}
            className="w-full py-4 bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white rounded-2xl font-black shadow-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2 border border-blue-400/20"
          >
            {running ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                <span>جاري تحسين قاعدة البيانات...</span>
              </>
            ) : (
              <>
                <span>تحسين وضغط قاعدة البيانات الآن</span>
                <Sparkles className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
