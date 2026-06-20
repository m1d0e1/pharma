'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { subDays, format, parseISO } from 'date-fns';
import { getClientSession } from '@/lib/auth/local';
import { dbSelect } from '@/lib/db/tauri';
import { getReportsDataAction } from '@/app/actions/reports';

const ReportsClient = dynamic(() => import('@/components/dashboard/SalesCharts'));

export default function ReportsPage() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [salesHistory, setSalesHistory] = useState<any[]>([]);
  const [topDrugs, setTopDrugs] = useState<any[]>([]);
  const [categoryData, setCategoryData] = useState<any[]>([]);
  const [salesHistoryRawCount, setSalesHistoryRawCount] = useState(0);
  const [totalUnitsSold, setTotalUnitsSold] = useState(0);

  useEffect(() => {
    async function loadReportsData() {
      try {
        const localUser = await getClientSession();
        if (!localUser) return;
        setUser(localUser);

        if (localUser.role !== 'owner') {
          setLoading(false);
          return;
        }

        const res = await getReportsDataAction();
        if (!res.success || !res.data) {
          setLoading(false);
          return;
        }

        const { salesHistoryRaw = [], topDrugsRaw = [], categoryRaw = [] } = res.data;

        setSalesHistoryRawCount((salesHistoryRaw || []).length);

        // Process sales history into daily buckets
        const dailySalesMap = new Map();
        for (let i = 29; i >= 0; i--) {
          const d = format(subDays(new Date(), i), 'yyyy-MM-dd');
          dailySalesMap.set(d, 0);
        }

        salesHistoryRaw.forEach((inv: any) => {
          const d = format(parseISO(inv.created_at), 'yyyy-MM-dd');
          if (dailySalesMap.has(d)) {
            dailySalesMap.set(d, dailySalesMap.get(d) + Number(inv.total_amount));
          }
        });

        const salesHist = Array.from(dailySalesMap.entries()).map(([date, revenue]) => ({
          date,
          revenue
        }));
        setSalesHistory(salesHist);

        setTotalUnitsSold(topDrugsRaw.reduce((sum: number, d: any) => sum + d.quantity_sold, 0));

        const drugSalesMap = new Map();
        topDrugsRaw.forEach((item: any) => {
          const name = item.trade_name || 'غير معروف';
          drugSalesMap.set(name, (drugSalesMap.get(name) || 0) + item.quantity_sold);
        });

        const drugs = Array.from(drugSalesMap.entries())
          .map(([name, sales]) => ({ name, sales, color: '#3b82f6' }))
          .sort((a, b) => b.sales - a.sales)
          .slice(0, 5);
        setTopDrugs(drugs);

        const categoryMap = new Map();
        categoryRaw.forEach((item: any) => {
          const name = item.category || 'أخرى';
          categoryMap.set(name, (categoryMap.get(name) || 0) + item.quantity_sold);
        });

        const cats = Array.from(categoryMap.entries())
          .map(([name, value]) => ({ name, value, color: '#10b981' }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 6);
        setCategoryData(cats);
      } catch (err) {
        console.error('Failed to load reports data:', err);
      } finally {
        setLoading(false);
      }
    }

    loadReportsData();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || user.role !== 'owner') {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-center space-y-4" dir="rtl">
        <div className="text-6xl">🚫</div>
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">غير مصرح لك بالوصول</h2>
        <p className="text-slate-500 max-w-md">عذراً، هذه الصفحة مخصصة لمديري النظام فقط. يرجى مراجعة المسؤول إذا كنت تعتقد أن هذا خطأ.</p>
        <Link href="/" className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-all font-bold">العودة للرئيسية</Link>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-4" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">التقارير والتحليلات</h1>
          <p className="text-slate-500 dark:text-slate-400">نظرة عميقة على أداء المبيعات وحركة المخزون.</p>
        </div>
        <div className="flex gap-3">
           <button className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-6 py-3 rounded-2xl font-bold text-sm shadow-sm hover:bg-slate-50 transition-all flex items-center gap-2">
             <span>📥</span> تصدير التقرير
           </button>
        </div>
      </div>

      {/* Reports Unified Navigation Tab Bar */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-6 text-sm">
        <Link 
          href="/reports" 
          className="pb-4 border-b-2 border-blue-600 font-black text-blue-600 dark:text-blue-400 flex items-center gap-2"
        >
          <span>📊</span> التحليلات والمخططات
        </Link>
        <Link 
          href="/reports/sales" 
          className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
        >
          <span>🧾</span> تقرير فواتير المبيعات
        </Link>
        <Link 
          href="/reports/purchases" 
          className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
        >
          <span>🛒</span> تقارير المشتريات
        </Link>
        <Link 
          href="/reports/trial-balance" 
          className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
        >
          <span>⚖️</span> ميزان المراجعة
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-gradient-to-br from-blue-600 to-indigo-700 p-6 rounded-3xl text-white shadow-xl">
           <p className="text-blue-100 text-xs font-bold uppercase tracking-wider mb-2">إجمالي إيرادات الشهر</p>
           <h3 className="text-3xl font-black">{salesHistory.reduce((sum, d) => sum + d.revenue, 0).toLocaleString()} ج.م</h3>
           <div className="mt-4 flex items-center gap-2 text-xs text-blue-200 bg-white/10 w-fit px-2 py-1 rounded-full font-bold">
             <span>🚀</span> +12.5% منذ الشهر الماضي
           </div>
        </div>
        <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
           <p className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-2">عدد العمليات</p>
           <h3 className="text-3xl font-black text-slate-900 dark:text-white">{salesHistoryRawCount} عملية</h3>
           <p className="mt-4 text-xs text-slate-400 font-bold">متوسط {Math.round(salesHistoryRawCount / 30)} عملية/يوم</p>
        </div>
        <div className="bg-white dark:bg-slate-900 p-6 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
           <p className="text-slate-500 text-xs font-bold uppercase tracking-wider mb-2">الأصناف المبيعة</p>
           <h3 className="text-3xl font-black text-slate-900 dark:text-white">{totalUnitsSold} وحدة</h3>
           <p className="mt-4 text-xs text-emerald-500 font-bold">● نشاط مخزني مرتفع</p>
        </div>
      </div>

      <ReportsClient 
        salesHistory={salesHistory} 
        topDrugs={topDrugs} 
        categoryData={categoryData} 
      />
    </div>
  );
}
