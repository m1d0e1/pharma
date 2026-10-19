'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { subDays, format, parseISO } from 'date-fns';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { dbSelect } from '@/lib/db/tauri';
import { getReportsDataAction } from '@/app/actions-client/reports';
import { BarChart3, Download, PackageCheck, ReceiptText, Scale, ShieldX, ShoppingCart, TrendingUp } from 'lucide-react';

const ReportsClient = dynamic(() => import('@/components/dashboard/SalesCharts'));

export default function ReportsPage() {
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [salesHistory, setSalesHistory] = useState<any[]>([]);
  const [topDrugs, setTopDrugs] = useState<any[]>([]);
  const [categoryData, setCategoryData] = useState<any[]>([]);
  const [salesHistoryRawCount, setSalesHistoryRawCount] = useState(0);
  const [totalUnitsSold, setTotalUnitsSold] = useState(0);
  const [loadError, setLoadError] = useState('');
  const loadRequestRef = useRef(0);

  const loadReportsData = React.useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const localUser = await getClientSession();
      if (requestId !== loadRequestRef.current) return;
      setUser(localUser);
      if (!localUser) return;

      if (!hasUserPermissionSync(localUser, 'rep_can_view_sales')) return;

      const res = await getReportsDataAction();
      if (requestId !== loadRequestRef.current) return;
      if (!res.success || !res.data) {
        setLoadError('تعذر تحميل بيانات التقارير');
        return;
      }

      const {
        salesHistoryRaw = [],
        topDrugsRaw = [],
        categoryRaw = [],
        totalUnitsSold: totalUnitsSoldRaw,
      } = res.data as any;

      setSalesHistoryRawCount((salesHistoryRaw || []).length);

      // Process sales history into daily buckets
      const dailySalesMap = new Map();
      for (let i = 29; i >= 0; i--) {
        const d = format(subDays(new Date(), i), 'yyyy-MM-dd');
        dailySalesMap.set(d, 0);
      }

      salesHistoryRaw.forEach((inv: any) => {
        const d = inv.local_date
          || (inv.created_at.includes('T') ? inv.created_at.split('T')[0] : inv.created_at.split(' ')[0]);
        if (dailySalesMap.has(d)) {
          dailySalesMap.set(d, dailySalesMap.get(d) + Number(inv.total_amount));
        }
      });

      const salesHist = Array.from(dailySalesMap.entries()).map(([date, revenue]) => ({
        date,
        revenue
      }));
      setSalesHistory(salesHist);

      const fallbackUnits = topDrugsRaw.reduce((sum: number, d: any) => sum + Number(d.quantity_sold || 0), 0);
      setTotalUnitsSold(Number.isFinite(Number(totalUnitsSoldRaw)) ? Number(totalUnitsSoldRaw) : fallbackUnits);

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
      if (requestId !== loadRequestRef.current) return;
      console.error('Failed to load reports data:', err);
      setLoadError('تعذر تحميل بيانات التقارير');
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReportsData();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [loadReportsData]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || !hasUserPermissionSync(user, 'rep_can_view_sales')) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-center space-y-4" dir="rtl">
        <ShieldX className="w-12 h-12 text-rose-500" aria-hidden="true" />
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">غير مصرح لك بالوصول</h2>
        <p className="text-slate-500 max-w-md">عذراً، هذه الصفحة مخصصة لمديري النظام فقط. يرجى مراجعة المسؤول إذا كنت تعتقد أن هذا خطأ.</p>
        <Link href="/" className="px-5 py-2.5 bg-primary-700 text-white rounded-lg hover:bg-primary-800 transition-colors font-semibold">العودة للرئيسية</Link>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24" dir="rtl">
        <p className="font-black text-rose-600">{loadError}</p>
        <button type="button" onClick={loadReportsData} className="px-5 py-2.5 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors">
          إعادة المحاولة
        </button>
      </div>
    );
  }

  const exportReport = () => {
    const rows = [['date', 'revenue'], ...salesHistory.map((d: any) => [d.date, d.revenue])];
    const csv = '\uFEFF' + rows.map(row => row.join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    Object.assign(document.createElement('a'), { href: url, download: `sales_summary_${format(new Date(), 'yyyy-MM-dd')}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">التقارير والتحليلات</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">ملخص أداء المبيعات وحركة الأصناف خلال آخر 30 يوماً.</p>
        </div>
        <div className="flex gap-3">
           <button type="button" onClick={exportReport} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 px-4 py-2.5 rounded-lg font-semibold text-sm shadow-sm hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors flex items-center gap-2">
             <Download className="w-4 h-4" aria-hidden="true" /> تصدير التقرير
           </button>
        </div>
      </div>

      {/* Reports Unified Navigation Tab Bar */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-6 text-sm overflow-x-auto pb-1">
        <Link 
          href="/reports" 
          className="pb-4 border-b-2 border-blue-600 font-black text-blue-600 dark:text-blue-400 flex items-center gap-2"
        >
          <BarChart3 className="w-4 h-4" aria-hidden="true" /> التحليلات والمخططات
        </Link>
        {hasUserPermissionSync(user, 'rep_can_view_sales') && (
          <Link
            href="/reports/sales"
            className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
          >
            <ReceiptText className="w-4 h-4" aria-hidden="true" /> تقرير فواتير المبيعات
          </Link>
        )}
        {hasUserPermissionSync(user, 'rep_can_view_purchases') && (
          <Link
            href="/reports/purchases"
            className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
          >
            <ShoppingCart className="w-4 h-4" aria-hidden="true" /> تقارير المشتريات
          </Link>
        )}
        {hasUserPermissionSync(user, 'acc_can_view_reports') && (
          <Link
            href="/reports/trial-balance"
            className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2"
          >
            <Scale className="w-4 h-4" aria-hidden="true" /> ميزان المراجعة
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
           <div className="flex items-center justify-between gap-3 mb-2"><p className="text-slate-500 dark:text-slate-400 text-xs font-semibold">إجمالي الإيرادات</p><TrendingUp className="w-5 h-5 text-blue-600" aria-hidden="true" /></div>
           <h3 className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">{salesHistory.reduce((sum, d) => sum + d.revenue, 0).toLocaleString()} ج.م</h3>
           <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">آخر 30 يوماً</div>
        </div>
        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
           <div className="flex items-center justify-between gap-3 mb-2"><p className="text-slate-500 dark:text-slate-400 text-xs font-semibold">عدد العمليات</p><ReceiptText className="w-5 h-5 text-emerald-600" aria-hidden="true" /></div>
           <h3 className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">{salesHistoryRawCount} عملية</h3>
           <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">متوسط {Math.round(salesHistoryRawCount / 30)} عملية/يوم</p>
        </div>
        <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
           <div className="flex items-center justify-between gap-3 mb-2"><p className="text-slate-500 dark:text-slate-400 text-xs font-semibold">الأصناف المبيعة</p><PackageCheck className="w-5 h-5 text-amber-600" aria-hidden="true" /></div>
           <h3 className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">{totalUnitsSold} وحدة</h3>
           <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">آخر 30 يوماً</p>
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
