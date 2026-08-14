'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { getTrialBalanceAction } from '@/app/actions-client/finance';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Printer, RefreshCw, Download, Calendar, Search, SlidersHorizontal, ArrowUpDown } from 'lucide-react';
import { toast } from 'react-hot-toast';

export default function TrialBalanceReport({ userRole }: { userRole?: string }) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode, setViewMode] = useState<'net' | 'detailed'>('detailed');

  const fetchData = useCallback(async (start?: string, end?: string) => {
    try {
      setLoading(true);
      const s = start !== undefined ? start : startDate;
      const e = end !== undefined ? end : endDate;
      const res = await getTrialBalanceAction(s, e);
      if (res.success) {
        setData(res.data || []);
      } else {
        toast.error(res.error || 'فشل تحميل ميزان المراجعة');
      }
    } catch (error) {
      console.error('Fetch trial balance error:', error);
      toast.error('حدث خطأ غير متوقع أثناء تحميل البيانات');
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const applyPreset = (preset: 'today' | 'this_month' | 'this_year' | 'all') => {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    if (preset === 'today') {
      setStartDate(todayStr);
      setEndDate(todayStr);
      fetchData(todayStr, todayStr);
    } else if (preset === 'this_month') {
      const startOfMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
      setStartDate(startOfMonth);
      setEndDate(todayStr);
      fetchData(startOfMonth, todayStr);
    } else if (preset === 'this_year') {
      const startOfYear = `${now.getFullYear()}-01-01`;
      setStartDate(startOfYear);
      setEndDate(todayStr);
      fetchData(startOfYear, todayStr);
    } else {
      setStartDate('');
      setEndDate('');
      fetchData('', '');
    }
  };

  const filteredAccounts = useMemo(() => {
    const leaf = data.filter(item => item.is_group === 0);
    if (!searchTerm.trim()) return leaf;
    const q = searchTerm.trim().toLowerCase();
    return leaf.filter(
      item =>
        (item.code && item.code.toLowerCase().includes(q)) ||
        (item.name_ar && item.name_ar.toLowerCase().includes(q)) ||
        (item.name_en && item.name_en.toLowerCase().includes(q))
    );
  }, [data, searchTerm]);

  // Totals for leaf accounts
  const totals = useMemo(() => {
    return filteredAccounts.reduce(
      (acc, item) => ({
        opening_debit: acc.opening_debit + (item.opening_net_debit || 0),
        opening_credit: acc.opening_credit + (item.opening_net_credit || 0),
        period_debit: acc.period_debit + (item.period_debit || 0),
        period_credit: acc.period_credit + (item.period_credit || 0),
        net_debit: acc.net_debit + (item.net_debit || 0),
        net_credit: acc.net_credit + (item.net_credit || 0),
      }),
      { opening_debit: 0, opening_credit: 0, period_debit: 0, period_credit: 0, net_debit: 0, net_credit: 0 }
    );
  }, [filteredAccounts]);

  const handleExportCSV = () => {
    if (filteredAccounts.length === 0) {
      toast.error('لا توجد بيانات للتصدير');
      return;
    }
    const headers = viewMode === 'detailed'
      ? ['كود الحساب', 'اسم الحساب', 'رصيد افتتاحي مدين', 'رصيد افتتاحي دائن', 'حركة الفترة مدين', 'حركة الفترة دائن', 'رصيد ختامي مدين', 'رصيد ختامي دائن']
      : ['كود الحساب', 'اسم الحساب', 'رصيد مدين', 'رصيد دائن'];

    const rows = filteredAccounts.map(item => {
      if (viewMode === 'detailed') {
        return [
          `"${item.code || ''}"`,
          `"${item.name_ar || ''}"`,
          (item.opening_net_debit || 0).toFixed(2),
          (item.opening_net_credit || 0).toFixed(2),
          (item.period_debit || 0).toFixed(2),
          (item.period_credit || 0).toFixed(2),
          (item.net_debit || 0).toFixed(2),
          (item.net_credit || 0).toFixed(2),
        ];
      }
      return [
        `"${item.code || ''}"`,
        `"${item.name_ar || ''}"`,
        (item.net_debit || 0).toFixed(2),
        (item.net_credit || 0).toFixed(2),
      ];
    });

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `trial_balance_${startDate || 'all'}_${endDate || 'all'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    toast.success('تم تصدير ملف CSV بنجاح');
  };

  const handlePrint = () => {
    window.print();
  };

  const isBalanced = Math.abs(totals.net_debit - totals.net_credit) < 0.01;

  return (
    <div className="space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white dark:bg-slate-900 p-6 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800">
        <div>
          <h1 className="text-2xl font-black text-slate-800 dark:text-white">ميزان المراجعة</h1>
          <p className="text-slate-500 text-sm mt-1">
            {startDate || endDate ? (
              <span>الفترة: من <strong className="text-slate-700 dark:text-slate-300">{startDate || 'البداية'}</strong> إلى <strong className="text-slate-700 dark:text-slate-300">{endDate || 'الآن'}</strong></span>
            ) : (
              'عرض الأرصدة وحركات جميع الحسابات (تراكمي)'
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button 
            onClick={() => fetchData()}
            title="تحديث البيانات"
            className="p-3 bg-slate-100 dark:bg-slate-800 rounded-xl hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
          >
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button 
            onClick={handleExportCSV}
            className="flex items-center gap-2 px-4 py-3 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-700 transition-all border border-slate-200 dark:border-slate-700"
          >
            <Download className="w-4 h-4" />
            تصدير CSV
          </button>
          <button 
            onClick={handlePrint}
            className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 shadow-lg shadow-blue-500/20 transition-all"
          >
            <Printer className="w-5 h-5" />
            طباعة
          </button>
        </div>
      </div>

      {/* Reports Unified Navigation Tab Bar */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-6 text-sm overflow-x-auto pb-1">
        {userRole === 'owner' && (
          <Link 
            href="/reports" 
            className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2 shrink-0"
          >
            <span>📊</span> التحليلات والمخططات
          </Link>
        )}
        <Link 
          href="/reports/sales" 
          className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2 shrink-0"
        >
          <span>🧾</span> تقرير فواتير المبيعات
        </Link>
        <Link 
          href="/reports/purchases" 
          className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors flex items-center gap-2 shrink-0"
        >
          <span>🛒</span> تقارير المشتريات
        </Link>
        <Link 
          href="/reports/trial-balance" 
          className="pb-4 border-b-2 border-blue-600 font-black text-blue-600 dark:text-blue-400 flex items-center gap-2 shrink-0"
        >
          <span>⚖️</span> ميزان المراجعة
        </Link>
      </div>

      {/* Filter and Range Controls Bar */}
      <div className="bg-white dark:bg-slate-900 p-5 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {/* Date range inputs */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-3 py-2 rounded-2xl border border-slate-200 dark:border-slate-700">
              <Calendar className="w-4 h-4 text-slate-400" />
              <span className="text-xs font-bold text-slate-500">من:</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-transparent text-xs font-bold text-slate-800 dark:text-white outline-none"
              />
            </div>
            <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-3 py-2 rounded-2xl border border-slate-200 dark:border-slate-700">
              <Calendar className="w-4 h-4 text-slate-400" />
              <span className="text-xs font-bold text-slate-500">إلى:</span>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-transparent text-xs font-bold text-slate-800 dark:text-white outline-none"
              />
            </div>
            <button
              onClick={() => fetchData()}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-900 dark:bg-slate-700 dark:hover:bg-slate-600 text-white rounded-xl text-xs font-bold transition-all shadow-sm"
            >
              تطبيق الفترة
            </button>
          </div>

          {/* Quick presets */}
          <div className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-800/60 p-1 rounded-2xl border border-slate-100 dark:border-slate-700">
            <button
              onClick={() => applyPreset('today')}
              className="px-3 py-1.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition-all"
            >
              اليوم
            </button>
            <button
              onClick={() => applyPreset('this_month')}
              className="px-3 py-1.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition-all"
            >
              هذا الشهر
            </button>
            <button
              onClick={() => applyPreset('this_year')}
              className="px-3 py-1.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition-all"
            >
              هذا العام
            </button>
            <button
              onClick={() => applyPreset('all')}
              className="px-3 py-1.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition-all"
            >
              الكل (تراكمي)
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
          {/* Account search */}
          <div className="relative min-w-[260px]">
            <Search className="w-4 h-4 absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="بحث باسم الحساب أو الكود..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl pr-10 pl-4 py-2 text-xs font-bold outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* View mode toggle */}
          <div className="flex items-center gap-2 bg-slate-100 dark:bg-slate-800 p-1 rounded-2xl border border-slate-200 dark:border-slate-700">
            <button
              onClick={() => setViewMode('net')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all ${
                viewMode === 'net'
                  ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-800'
              }`}
            >
              الأرصدة الصافية
            </button>
            <button
              onClick={() => setViewMode('detailed')}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all ${
                viewMode === 'detailed'
                  ? 'bg-white dark:bg-slate-700 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-800'
              }`}
            >
              تفصيلي بالمجاميع والحركات
            </button>
          </div>
        </div>
      </div>

      {/* Main Table */}
      <Card className="rounded-[2.5rem] border-none shadow-xl overflow-hidden bg-white dark:bg-slate-900">
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-700">
              {viewMode === 'detailed' ? (
                <>
                  <TableRow>
                    <TableHead rowSpan={2} className="text-right py-4 px-6 font-black text-slate-500 w-24">كود الحساب</TableHead>
                    <TableHead rowSpan={2} className="text-right py-4 px-6 font-black text-slate-500 min-w-[200px]">اسم الحساب</TableHead>
                    <TableHead colSpan={2} className="text-center py-2 px-4 font-black text-purple-700 dark:text-purple-400 bg-purple-50/50 dark:bg-purple-900/20 border-b border-purple-100 dark:border-purple-800/40">
                      رصيد أول المدة
                    </TableHead>
                    <TableHead colSpan={2} className="text-center py-2 px-4 font-black text-blue-700 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-900/20 border-b border-blue-100 dark:border-blue-800/40">
                      حركة الفترة
                    </TableHead>
                    <TableHead colSpan={2} className="text-center py-2 px-4 font-black text-emerald-700 dark:text-emerald-400 bg-emerald-50/50 dark:bg-emerald-900/20 border-b border-emerald-100 dark:border-emerald-800/40">
                      رصيد آخر المدة
                    </TableHead>
                  </TableRow>
                  <TableRow className="bg-slate-100/50 dark:bg-slate-800/50 text-[11px]">
                    <TableHead className="text-center py-2 px-3 font-black text-purple-600 bg-purple-50/30">مدين</TableHead>
                    <TableHead className="text-center py-2 px-3 font-black text-purple-600 bg-purple-50/30">دائن</TableHead>
                    <TableHead className="text-center py-2 px-3 font-black text-blue-600 bg-blue-50/30">مدين</TableHead>
                    <TableHead className="text-center py-2 px-3 font-black text-blue-600 bg-blue-50/30">دائن</TableHead>
                    <TableHead className="text-center py-2 px-3 font-black text-emerald-600 bg-emerald-50/30">مدين</TableHead>
                    <TableHead className="text-center py-2 px-3 font-black text-rose-600 bg-rose-50/30">دائن</TableHead>
                  </TableRow>
                </>
              ) : (
                <TableRow>
                  <TableHead className="text-right py-5 px-6 font-black text-slate-400 w-28">كود الحساب</TableHead>
                  <TableHead className="text-right py-5 px-6 font-black text-slate-400">اسم الحساب</TableHead>
                  <TableHead className="text-center py-5 px-6 font-black text-emerald-600 bg-emerald-50/30 w-44">أرصدة مدينة</TableHead>
                  <TableHead className="text-center py-5 px-6 font-black text-rose-600 bg-rose-50/30 w-44">أرصدة دائنة</TableHead>
                </TableRow>
              )}
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={viewMode === 'detailed' ? 8 : 4} className="text-center py-20 text-slate-400 animate-pulse">
                    جاري تحميل ومزامنة ميزان المراجعة...
                  </TableCell>
                </TableRow>
              ) : filteredAccounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={viewMode === 'detailed' ? 8 : 4} className="text-center py-20 text-slate-400 italic">
                    لا توجد حركات مسجلة للحسابات المحددة
                  </TableCell>
                </TableRow>
              ) : (
                filteredAccounts.map((item) => (
                  <TableRow key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                    <TableCell className="py-4 px-6 font-mono text-xs font-bold text-slate-500 dark:text-slate-400">{item.code}</TableCell>
                    <TableCell className="py-4 px-6 font-bold text-slate-800 dark:text-white">
                      <div>
                        <p className="text-xs">{item.name_ar}</p>
                        {item.name_en && <p className="text-[10px] text-slate-400 font-sans">{item.name_en}</p>}
                      </div>
                    </TableCell>
                    
                    {viewMode === 'detailed' ? (
                      <>
                        {/* Opening */}
                        <TableCell className="py-4 px-3 text-center font-bold text-xs text-purple-700 dark:text-purple-400 bg-purple-50/10">
                          {item.opening_net_debit > 0 ? item.opening_net_debit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                        </TableCell>
                        <TableCell className="py-4 px-3 text-center font-bold text-xs text-purple-700 dark:text-purple-400 bg-purple-50/10">
                          {item.opening_net_credit > 0 ? item.opening_net_credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                        </TableCell>

                        {/* Period Movements */}
                        <TableCell className="py-4 px-3 text-center font-bold text-xs text-blue-600 dark:text-blue-400 bg-blue-50/10">
                          {item.period_debit > 0 ? item.period_debit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                        </TableCell>
                        <TableCell className="py-4 px-3 text-center font-bold text-xs text-blue-600 dark:text-blue-400 bg-blue-50/10">
                          {item.period_credit > 0 ? item.period_credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                        </TableCell>

                        {/* Net Closing */}
                        <TableCell className="py-4 px-3 text-center font-black text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50/10">
                          {item.net_debit > 0 ? item.net_debit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                        </TableCell>
                        <TableCell className="py-4 px-3 text-center font-black text-xs text-rose-600 dark:text-rose-400 bg-rose-50/10">
                          {item.net_credit > 0 ? item.net_credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                        </TableCell>
                      </>
                    ) : (
                      <>
                        <TableCell className="py-4 px-6 text-center font-black text-emerald-600 dark:text-emerald-400 text-xs">
                          {item.net_debit > 0 ? item.net_debit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                        </TableCell>
                        <TableCell className="py-4 px-6 text-center font-black text-rose-600 dark:text-rose-400 text-xs">
                          {item.net_credit > 0 ? item.net_credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                        </TableCell>
                      </>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
            <tfoot className="bg-slate-900 text-white font-black">
              {viewMode === 'detailed' ? (
                <TableRow>
                  <TableCell colSpan={2} className="py-5 px-6 text-sm font-black">الإجمالي العام</TableCell>
                  <TableCell className="py-5 px-3 text-center text-xs text-purple-300 font-black">
                    {totals.opening_debit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="py-5 px-3 text-center text-xs text-purple-300 font-black">
                    {totals.opening_credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="py-5 px-3 text-center text-xs text-blue-300 font-black">
                    {totals.period_debit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="py-5 px-3 text-center text-xs text-blue-300 font-black">
                    {totals.period_credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="py-5 px-3 text-center text-sm text-emerald-400 font-black">
                    {totals.net_debit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="py-5 px-3 text-center text-sm text-rose-400 font-black">
                    {totals.net_credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow>
                  <TableCell colSpan={2} className="py-5 px-6 text-base font-black">الإجمالي العام</TableCell>
                  <TableCell className="py-5 px-6 text-center text-lg text-emerald-400 font-black">
                    {totals.net_debit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                  <TableCell className="py-5 px-6 text-center text-lg text-rose-400 font-black">
                    {totals.net_credit.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </TableCell>
                </TableRow>
              )}
            </tfoot>
          </Table>
        </CardContent>
      </Card>
      
      {!isBalanced && (
        <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/40 p-4 rounded-2xl flex items-center gap-3 text-rose-600 dark:text-rose-300">
          <div className="w-2.5 h-2.5 rounded-full bg-rose-500 animate-ping shrink-0" />
          <p className="font-bold text-xs">
            تنبيه مالي: ميزان المراجعة غير متزن. هناك فارق بين الجانب المدين والدائن قدره {Math.abs(totals.net_debit - totals.net_credit).toFixed(2)} ج.م
          </p>
        </div>
      )}
    </div>
  );
}

