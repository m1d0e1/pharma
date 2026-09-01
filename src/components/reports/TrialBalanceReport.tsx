'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { getTrialBalanceAction } from '@/app/actions-client/finance';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import TableScrollContainer from '@/components/ui/TableScrollContainer';
import { Printer, RefreshCw, Download, Calendar, Search, CheckCircle2, AlertCircle, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { toast } from 'react-hot-toast';

// ponytail: label map — extend as chart of accounts grows
const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  asset:     'أصول',
  liability: 'التزامات',
  equity:    'حقوق الملكية',
  income:    'إيرادات',
  expense:   'مصروفات',
};

function fmt(n: number) {
  return n.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function balanceSummary(debit: number, credit: number, type: string) {
  const net = debit - credit;
  if (Math.abs(net) < 0.01) return { text: 'صفر', color: 'text-slate-400', Icon: Minus };
  const normallyDebit = type === 'asset' || type === 'expense';
  const amount = fmt(Math.abs(net));
  if ((normallyDebit && net > 0) || (!normallyDebit && net < 0)) {
    return { text: `${amount} ج.م`, color: 'text-emerald-600', Icon: TrendingUp };
  }
  return { text: `${amount} ج.م`, color: 'text-rose-600', Icon: TrendingDown };
}

export default function TrialBalanceReport({ userRole }: { userRole?: string }) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [mode, setMode] = useState<'cumulative' | 'net' | 'period'>('cumulative');

  const fetchData = useCallback(async (s = startDate, e = endDate) => {
    setLoading(true);
    const res = await getTrialBalanceAction(s, e);
    if (res.success) setData(res.data || []);
    else toast.error(res.error || 'فشل تحميل ميزان المراجعة');
    setLoading(false);
  }, [startDate, endDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const applyPreset = (preset: 'today' | 'month' | 'year' | 'all') => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const map: Record<string, string[]> = {
      today: [today, today],
      month: [`${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, today],
      year:  [`${now.getFullYear()}-01-01`, today],
      all:   ['', ''],
    };
    const [ns, ne] = map[preset];
    setStartDate(ns); setEndDate(ne); fetchData(ns, ne);
  };

  const accounts = useMemo(() => {
    const leaf = data.filter(r => r.is_group === 0);
    const q = searchTerm.trim().toLowerCase();
    if (!q) return leaf;
    return leaf.filter(r =>
      (r.code || '').toLowerCase().includes(q) ||
      (r.name_ar || '').toLowerCase().includes(q) ||
      (r.name_en || '').toLowerCase().includes(q)
    );
  }, [data, searchTerm]);

  const totals = useMemo(() =>
    accounts.reduce((acc, r) => ({
      debit:         acc.debit         + (r.net_debit      || 0),
      credit:        acc.credit        + (r.net_credit     || 0),
      period_debit:  acc.period_debit  + (r.period_debit   || 0),
      period_credit: acc.period_credit + (r.period_credit  || 0),
    }), { debit: 0, credit: 0, period_debit: 0, period_credit: 0 }),
  [accounts]);

  const isBalanced = Math.abs(totals.debit - totals.credit) < 0.01;

  const handleExport = () => {
    if (!accounts.length) { toast.error('لا توجد بيانات للتصدير'); return; }
    const header = ['الكود', 'اسم الحساب', 'نوع الحساب', 'الرصيد مدين', 'الرصيد دائن', 'حركة الفترة مدين', 'حركة الفترة دائن'];
    const rows = accounts.map(r => [
      r.code || '', r.name_ar || '', ACCOUNT_TYPE_LABEL[r.type] || r.type || '',
      (r.net_debit || 0).toFixed(2), (r.net_credit || 0).toFixed(2),
      (r.period_debit || 0).toFixed(2), (r.period_credit || 0).toFixed(2),
    ]);
    const csv = '\uFEFF' + [header, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    Object.assign(document.createElement('a'), { href: url, download: `trial_balance_${startDate || 'all'}.csv` }).click();
    URL.revokeObjectURL(url);
    toast.success('تم التصدير');
  };

  const PRESETS = [
    { key: 'today', label: 'اليوم' },
    { key: 'month', label: 'هذا الشهر' },
    { key: 'year', label: 'هذا العام' },
    { key: 'all', label: 'الكل' },
  ] as const;

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-white dark:bg-slate-900 p-6 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800">
        <div>
          <h1 className="text-2xl font-black text-slate-800 dark:text-white">ميزان المراجعة</h1>
          <p className="text-slate-500 text-sm mt-1">
            {startDate || endDate
              ? <>من <strong className="text-slate-700 dark:text-slate-300">{startDate || 'البداية'}</strong> إلى <strong className="text-slate-700 dark:text-slate-300">{endDate || 'الآن'}</strong></>
              : 'عرض الأرصدة وحركات جميع الحسابات (تراكمي)'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => fetchData()} title="تحديث" className="p-3 bg-slate-100 dark:bg-slate-800 rounded-xl hover:bg-slate-200 transition-all">
            <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={handleExport} className="flex items-center gap-2 px-4 py-3 bg-slate-100 dark:bg-slate-800 rounded-xl font-bold hover:bg-slate-200 transition-all border border-slate-200 dark:border-slate-700 text-sm">
            <Download className="w-4 h-4" /> تصدير CSV
          </button>
          <button onClick={() => window.print()} className="flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 shadow-lg shadow-blue-500/20 transition-all text-sm">
            <Printer className="w-5 h-5" /> طباعة
          </button>
        </div>
      </div>

      <div className="flex border-b border-slate-200 dark:border-slate-800 gap-6 text-sm overflow-x-auto pb-1">
        {userRole === 'owner' && (
          <Link href="/reports" className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 transition-colors flex items-center gap-2 shrink-0">
            📊 التحليلات والمخططات
          </Link>
        )}
        <Link href="/reports/sales" className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 transition-colors flex items-center gap-2 shrink-0">
          🧾 تقرير المبيعات
        </Link>
        <Link href="/reports/purchases" className="pb-4 border-b-2 border-transparent font-bold text-slate-500 hover:text-slate-800 transition-colors flex items-center gap-2 shrink-0">
          🛒 تقارير المشتريات
        </Link>
        <Link href="/reports/trial-balance" className="pb-4 border-b-2 border-blue-600 font-black text-blue-600 dark:text-blue-400 flex items-center gap-2 shrink-0">
          ⚖️ ميزان المراجعة
        </Link>
      </div>

      <div className="bg-white dark:bg-slate-900 p-5 rounded-3xl shadow-sm border border-slate-100 dark:border-slate-800 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-3 py-2 rounded-2xl border border-slate-200 dark:border-slate-700">
              <Calendar className="w-4 h-4 text-slate-400" />
              <span className="text-xs font-bold text-slate-500">من:</span>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                className="bg-transparent text-xs font-bold outline-none text-slate-800 dark:text-white" />
            </div>
            <div className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800 px-3 py-2 rounded-2xl border border-slate-200 dark:border-slate-700">
              <Calendar className="w-4 h-4 text-slate-400" />
              <span className="text-xs font-bold text-slate-500">إلى:</span>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)}
                className="bg-transparent text-xs font-bold outline-none text-slate-800 dark:text-white" />
            </div>
            <button onClick={() => fetchData()} className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold transition-all">
              تطبيق
            </button>
          </div>

          <div className="flex items-center gap-1 bg-slate-50 dark:bg-slate-800/60 p-1 rounded-2xl border border-slate-100 dark:border-slate-700">
            {PRESETS.map(p => (
              <button key={p.key} onClick={() => applyPreset(p.key)}
                className="px-3 py-1.5 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-700 hover:shadow-sm transition-all">
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div className="relative min-w-[260px]">
            <Search className="w-4 h-4 absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              placeholder="بحث باسم الحساب أو الكود..."
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl pr-10 pl-4 py-2 text-xs font-bold outline-none focus:ring-2 focus:ring-blue-500" />
          </div>

          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-2xl">
            <button
              onClick={() => setMode('cumulative')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${mode === 'cumulative' ? 'bg-white dark:bg-slate-700 shadow-sm text-blue-600 dark:text-blue-400 font-black' : 'text-slate-600 dark:text-slate-400'}`}
            >
              الأرصدة التراكمية
            </button>
            <button
              onClick={() => setMode('net')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${mode === 'net' ? 'bg-white dark:bg-slate-700 shadow-sm text-blue-600 dark:text-blue-400 font-black' : 'text-slate-600 dark:text-slate-400'}`}
            >
              الأرصدة الصافية
            </button>
            <button
              onClick={() => setMode('period')}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${mode === 'period' ? 'bg-white dark:bg-slate-700 shadow-sm text-blue-600 dark:text-blue-400 font-black' : 'text-slate-600 dark:text-slate-400'}`}
            >
              حركات الفترة
            </button>
          </div>
        </div>
      </div>

      {!isBalanced && (
        <div className="flex items-center gap-3 p-4 rounded-2xl border font-bold text-sm bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800/40 text-rose-700 dark:text-rose-300">
          <AlertCircle className="w-5 h-5 shrink-0 animate-pulse" /> تنبيه مالي: ميزان المراجعة غير متزن — الفارق {fmt(Math.abs(totals.debit - totals.credit))} ج.م (يُرجى مراجعة القيود)
        </div>
      )}

      {isBalanced && (
        <div className="flex items-center gap-3 p-4 rounded-2xl border font-bold text-sm bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/40 text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="w-5 h-5 shrink-0" /> الميزان متوازن ✓ — مجموع الأرصدة المدينة مساوٍ للأرصدة الدائنة
        </div>
      )}

      {!loading && accounts.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCard label="إجمالي الأرصدة المدينة" sublabel="أصول + مصروفات" value={fmt(totals.debit)} color="text-emerald-600" />
          <SummaryCard label="إجمالي الأرصدة الدائنة" sublabel="التزامات + إيرادات" value={fmt(totals.credit)} color="text-rose-600" />
          <SummaryCard label="حركة الفترة (مدين)" sublabel="" value={fmt(totals.period_debit)} color="text-blue-600" />
          <SummaryCard label="حركة الفترة (دائن)" sublabel="" value={fmt(totals.period_credit)} color="text-purple-600" />
        </div>
      )}

      <Card className="rounded-[2.5rem] border-none shadow-xl overflow-hidden bg-white dark:bg-slate-900">
        <CardContent className="p-0">
          <TableScrollContainer>
          <Table>
            <TableHeader className="bg-slate-50 dark:bg-slate-800/70 border-b border-slate-200 dark:border-slate-700">
              <TableRow>
                <TableHead className="text-right py-5 px-6 font-black text-slate-400 w-24">كود</TableHead>
                <TableHead className="text-right py-5 px-6 font-black text-slate-400">اسم الحساب</TableHead>
                <TableHead className="text-center py-5 px-4 font-black text-slate-400 w-28">النوع</TableHead>
                
                {mode === 'cumulative' && (
                  <TableHead className="text-center py-5 px-4 font-black text-slate-600 bg-slate-100/50 dark:bg-slate-800/80 w-52">
                    الرصيد التراكمي
                    <span className="block text-[10px] text-slate-400 font-normal">حتى نهاية الفترة</span>
                  </TableHead>
                )}

                {mode === 'net' && (
                  <>
                    <TableHead className="text-center py-5 px-4 font-black text-emerald-600 bg-emerald-50/30 w-36">
                      أرصدة مدينة
                    </TableHead>
                    <TableHead className="text-center py-5 px-4 font-black text-rose-600 bg-rose-50/30 w-36">
                      أرصدة دائنة
                    </TableHead>
                  </>
                )}

                {mode === 'period' && (
                  <>
                    <TableHead className="text-center py-5 px-4 font-black text-blue-600 bg-blue-50/30 w-36">
                      حركة الفترة (مدين)
                    </TableHead>
                    <TableHead className="text-center py-5 px-4 font-black text-purple-600 bg-purple-50/30 w-36">
                      حركة الفترة (دائن)
                    </TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-20 text-slate-400 animate-pulse">
                    جاري تحميل بيانات الحسابات...
                  </TableCell>
                </TableRow>
              ) : accounts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-20 text-slate-400 italic">
                    لا توجد حركات مسجلة {searchTerm ? 'تطابق بحثك' : 'للفترة المحددة'}
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map(acc => {
                  const { text, color, Icon } = balanceSummary(acc.net_debit, acc.net_credit, acc.type);
                  return (
                    <TableRow key={acc.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <TableCell className="py-4 px-6 font-mono text-xs font-bold text-slate-500">{acc.code}</TableCell>
                      <TableCell className="py-4 px-6 font-black text-slate-800 dark:text-white">{acc.name_ar}</TableCell>
                      <TableCell className="py-4 px-4 text-center">
                        <span className="inline-block px-2.5 py-1 rounded-xl text-[11px] font-black bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                          {ACCOUNT_TYPE_LABEL[acc.type] || acc.type || '—'}
                        </span>
                      </TableCell>

                      {mode === 'cumulative' && (
                        <TableCell className="py-4 px-4 text-center">
                          <span className={`inline-flex items-center gap-1 font-black text-sm font-mono ${color}`}>
                            <Icon className="w-4 h-4 shrink-0" />
                            {text}
                          </span>
                        </TableCell>
                      )}

                      {mode === 'net' && (
                        <>
                          <TableCell className="py-4 px-4 text-center font-mono font-bold text-sm text-emerald-600">
                            {acc.net_debit > 0 ? `${fmt(acc.net_debit)} ج.م` : '—'}
                          </TableCell>
                          <TableCell className="py-4 px-4 text-center font-mono font-bold text-sm text-rose-600">
                            {acc.net_credit > 0 ? `${fmt(acc.net_credit)} ج.م` : '—'}
                          </TableCell>
                        </>
                      )}

                      {mode === 'period' && (
                        <>
                          <TableCell className="py-4 px-4 text-center font-mono font-bold text-sm text-blue-600">
                            {acc.period_debit > 0 ? `${fmt(acc.period_debit)} ج.م` : '—'}
                          </TableCell>
                          <TableCell className="py-4 px-4 text-center font-mono font-bold text-sm text-purple-600">
                            {acc.period_credit > 0 ? `${fmt(acc.period_credit)} ج.م` : '—'}
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  );
                })
              )}

              {!loading && accounts.length > 0 && (
                <TableRow className="bg-slate-100/70 dark:bg-slate-800/80 font-black border-t-2 border-slate-300 dark:border-slate-600">
                  <TableCell colSpan={3} className="py-5 px-6 text-sm text-slate-700 dark:text-slate-200">
                    الإجمالي العام ({accounts.length} حساب)
                  </TableCell>
                  
                  {mode === 'cumulative' && (
                    <TableCell className="py-5 px-4 text-center text-xs font-mono">
                      <span className="text-emerald-600">مدين: {fmt(totals.debit)}</span>
                      {' '}
                      <span className="text-rose-600">دائن: {fmt(totals.credit)}</span>
                    </TableCell>
                  )}

                  {mode === 'net' && (
                    <>
                      <TableCell className="py-5 px-4 text-center font-mono font-black text-sm text-emerald-700 dark:text-emerald-400">
                        {fmt(totals.debit)} ج.م
                      </TableCell>
                      <TableCell className="py-5 px-4 text-center font-mono font-black text-sm text-rose-700 dark:text-rose-400">
                        {fmt(totals.credit)} ج.م
                      </TableCell>
                    </>
                  )}

                  {mode === 'period' && (
                    <>
                      <TableCell className="py-5 px-4 text-center font-mono font-black text-sm text-blue-700 dark:text-blue-400">
                        {fmt(totals.period_debit)} ج.م
                      </TableCell>
                      <TableCell className="py-5 px-4 text-center font-mono font-black text-sm text-purple-700 dark:text-purple-400">
                        {fmt(totals.period_credit)} ج.م
                      </TableCell>
                    </>
                  )}
                </TableRow>
              )}
            </TableBody>
          </Table>
          </TableScrollContainer>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ label, sublabel, value, color }: { label: string; sublabel: string; value: string; color: string }) {
  return (
    <Card className="rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm bg-white dark:bg-slate-900 p-5">
      <p className="text-xs font-bold text-slate-400">{label}</p>
      {sublabel && <p className="text-[10px] text-slate-400 mt-0.5">{sublabel}</p>}
      <p className={`text-xl font-black font-mono mt-2 ${color}`}>{value} <span className="text-xs font-normal">ج.م</span></p>
    </Card>
  );
}
