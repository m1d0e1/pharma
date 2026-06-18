'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession } from '@/lib/auth/local';
import InteractionsClient from '@/components/interactions/InteractionsClient';
import { dbSelect, dbGet } from '@/lib/db/tauri';

export default function InteractionsPage() {
  const [user, setUser] = useState<any>(null);
  const [stats, setStats] = useState({ total: 0, critical: 0, major: 0, moderate: 0 });
  const [initialData, setInitialData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadInteractions() {
      try {
        const localUser = await getClientSession();
        if (!localUser) return;
        setUser(localUser);

        const totalRow = await dbGet('SELECT COUNT(*) as count FROM drug_interactions');
        const criticalRow = await dbGet("SELECT COUNT(*) as count FROM drug_interactions WHERE severity = 'critical'");
        const majorRow = await dbGet("SELECT COUNT(*) as count FROM drug_interactions WHERE severity = 'major'");
        const moderateRow = await dbGet("SELECT COUNT(*) as count FROM drug_interactions WHERE severity = 'moderate'");

        setStats({
          total: totalRow?.count || 0,
          critical: criticalRow?.count || 0,
          major: majorRow?.count || 0,
          moderate: moderateRow?.count || 0,
        });

        const initial = await dbSelect('SELECT * FROM drug_interactions ORDER BY severity DESC, ingredient_a ASC LIMIT 50');
        setInitialData(initial || []);
      } catch (err) {
        console.error('Failed to load interactions:', err);
      } finally {
        setLoading(false);
      }
    }

    loadInteractions();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">فحص التفاعلات الدوائية</h1>
          <p className="text-slate-500 mt-1">نظام ذكي لحماية المريض من التفاعلات الدوائية الخطيرة</p>
        </div>
      </div>

      {/* Safety Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
          <p className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-2">إجمالي التفاعلات</p>
          <h3 className="text-3xl font-black text-slate-900 dark:text-white">{stats.total}</h3>
          <p className="text-xs mt-2 text-slate-400">في قاعدة البيانات</p>
        </div>
        <div className="bg-gradient-to-br from-amber-500 to-orange-600 p-6 rounded-3xl text-white shadow-xl">
          <p className="text-amber-100 text-xs font-bold uppercase tracking-wider mb-2">⚠️ خطيرة</p>
          <h3 className="text-3xl font-black">{stats.major}</h3>
          <p className="text-xs mt-2 text-amber-200">تحتاج تأكيد الصيدلي</p>
        </div>
      </div>

      {/* How it works */}
      <div className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 p-8 rounded-3xl border-2 border-dashed border-blue-200 dark:border-blue-800">
        <h3 className="text-lg font-bold text-blue-800 dark:text-blue-300 mb-4">🛡️ كيف يعمل نظام الحماية الدوائية</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="space-y-2">
            <div className="w-10 h-10 bg-blue-200 dark:bg-blue-800 rounded-xl flex items-center justify-center text-lg font-black text-blue-700">1</div>
            <h4 className="font-bold text-blue-900 dark:text-blue-200">عند إضافة دواء للسلة</h4>
            <p className="text-sm text-blue-700 dark:text-blue-400">يفحص النظام تلقائياً المادة الفعالة مع باقي أدوية السلة وتاريخ المريض</p>
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
