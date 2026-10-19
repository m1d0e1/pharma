'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession } from '@/lib/auth/local';
import InteractionsClient from '@/components/interactions/InteractionsClient';
import { dbSelect, dbGet } from '@/lib/db/tauri';
import { AlertTriangle, ShieldCheck } from 'lucide-react';

export default function InteractionsPage() {
  const [user, setUser] = useState<any>(null);
  const [stats, setStats] = useState({ total: 0, critical: 0, major: 0, moderate: 0 });
  const [initialData, setInitialData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadInteractions() {
      setLoading(true);
      setLoadError('');
      try {
        const localUser = await getClientSession();
        if (!active) return;
        setUser(localUser);
        if (!localUser) return;

        const totalRow = await dbGet('SELECT COUNT(*) as count FROM drug_interactions');
        const criticalRow = await dbGet("SELECT COUNT(*) as count FROM drug_interactions WHERE severity = 'critical'");
        const majorRow = await dbGet("SELECT COUNT(*) as count FROM drug_interactions WHERE severity = 'major'");
        const moderateRow = await dbGet("SELECT COUNT(*) as count FROM drug_interactions WHERE severity = 'moderate'");

        const countRows = [totalRow, criticalRow, majorRow, moderateRow];
        if (countRows.some(row => !row || !Number.isSafeInteger(row.count) || row.count < 0)) {
          throw new Error('Drug interaction counts unavailable');
        }

        if (!active) return;
        setStats({
          total: totalRow.count,
          critical: criticalRow.count,
          major: majorRow.count,
          moderate: moderateRow.count,
        });

        const initial = await dbSelect('SELECT * FROM drug_interactions ORDER BY severity DESC, ingredient_a ASC LIMIT 50');
        if (!Array.isArray(initial)) throw new Error('Drug interaction list unavailable');
        if (active) setInitialData(initial);
      } catch (err) {
        console.error('Failed to load interactions:', err);
        if (active) setLoadError('تعذر تحميل بيانات التفاعلات');
      } finally {
        if (active) setLoading(false);
      }
    }

    loadInteractions();
    return () => { active = false; };
  }, [loadAttempt]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
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

  if (!user) {
    return null;
  }

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">فحص التفاعلات الدوائية</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">قاعدة التفاعلات الدوائية والتنبيهات السريرية</p>
        </div>
      </div>

      {/* Safety Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <p className="text-slate-500 dark:text-slate-400 text-xs font-semibold mb-2">إجمالي التفاعلات</p>
          <h3 className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">{stats.total}</h3>
          <p className="text-xs mt-2 text-slate-400">في قاعدة البيانات</p>
        </div>
        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-amber-200 dark:border-amber-900/60 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-2"><p className="text-amber-700 dark:text-amber-300 text-xs font-semibold">تفاعلات خطيرة</p><AlertTriangle className="w-5 h-5 text-amber-600" aria-hidden="true" /></div>
          <h3 className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">{stats.major}</h3>
          <p className="text-xs mt-2 text-slate-500 dark:text-slate-400">تحتاج تأكيد الصيدلي</p>
        </div>
      </div>

      {/* How it works */}
      <div className="bg-blue-50/70 dark:bg-blue-950/20 p-5 rounded-xl border border-blue-200 dark:border-blue-900/60">
        <h3 className="text-base font-semibold text-blue-900 dark:text-blue-200 mb-4 flex items-center gap-2"><ShieldCheck className="w-5 h-5" aria-hidden="true" /> كيف يعمل فحص التفاعلات</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="space-y-2">
            <div className="w-10 h-10 bg-blue-200 dark:bg-blue-800 rounded-xl flex items-center justify-center text-lg font-black text-blue-700">1</div>
            <h4 className="font-bold text-blue-900 dark:text-blue-200">عند إضافة دواء للسلة</h4>
            <p className="text-sm text-blue-700 dark:text-blue-400">يفحص النظام تلقائياً المواد الفعالة للأدوية الموجودة حالياً في السلة</p>
          </div>
          <div className="space-y-2">
            <div className="w-10 h-10 bg-blue-200 dark:bg-blue-800 rounded-xl flex items-center justify-center text-lg font-black text-blue-700">2</div>
            <h4 className="font-bold text-blue-900 dark:text-blue-200">تنبيه فوري</h4>
            <p className="text-sm text-blue-700 dark:text-blue-400">يظهر تحذير ملون حسب درجة الخطورة مع التوصيات العلاجية</p>
          </div>
          <div className="space-y-2">
            <div className="w-10 h-10 bg-blue-200 dark:bg-blue-800 rounded-xl flex items-center justify-center text-lg font-black text-blue-700">3</div>
            <h4 className="font-bold text-blue-900 dark:text-blue-200">قرار مسؤول</h4>
            <p className="text-sm text-blue-700 dark:text-blue-400">الصيدلي يمكنه المتابعة مع تسجيل السبب، أو تغيير الدواء</p>
          </div>
        </div>
      </div>

      <InteractionsClient 
        initialInteractions={initialData} 
        totalCount={stats.total}
        userRole={user.role} 
      />
    </div>
  );
}
