'use client';

import React, { useState, useEffect } from 'react';
import { 
  Printer, ArrowRight, Download, Calendar, Clock, User, 
  TrendingUp, TrendingDown, DollarSign, CreditCard, 
  ArrowUpRight, ArrowDownLeft, AlertCircle, CheckCircle,
  Receipt, ShoppingBag, RotateCcw
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getShiftReportAction } from '@/app/actions/reports';
import { format } from 'date-fns';
import { ar } from 'date-fns/locale';

export default function ShiftReportClient({ shiftId }: { shiftId: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const res = await getShiftReportAction(shiftId);
      if (res.success) setData(res.data);
      setLoading(false);
    }
    load();
  }, [shiftId]);

  if (loading) return <div className="p-20 text-center font-black animate-pulse">جاري إنشاء التقرير...</div>;
  if (!data) return <div className="p-20 text-center font-black text-rose-500">فشل تحميل بيانات التقرير</div>;

  const { shift, sales, returns, movements, summary } = data;

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-20" dir="rtl">
      {/* Header Actions */}
      <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-sm sticky top-4 z-10 backdrop-blur-md bg-opacity-80">
        <div className="flex items-center gap-4">
          <button onClick={() => window.history.back()} className="p-3 bg-slate-50 dark:bg-slate-800 rounded-2xl text-slate-400 hover:text-slate-800 transition-all">
            <ArrowRight className="w-6 h-6" />
          </button>
          <div>
            <h1 className="text-xl font-black">تقرير إغلاق الوردية</h1>
            <p className="text-xs font-bold text-slate-400">#{shift.id.slice(0, 12).toUpperCase()}</p>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={() => window.print()} className="px-6 py-3 bg-slate-900 text-white rounded-2xl font-black flex items-center gap-2 hover:bg-slate-800 transition-all shadow-lg">
            <Printer className="w-5 h-5" /> طباعة
          </button>
          <button className="p-3 bg-blue-50 text-blue-600 rounded-2xl hover:bg-blue-600 hover:text-white transition-all">
            <Download className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Basic Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <InfoCard icon={User} label="الموظف المسؤول" value={shift.staff_name} subValue={shift.status === 'open' ? 'شفت مفتوح' : 'شفت مغلق'} />
        <InfoCard icon={Calendar} label="وقت البدء" value={format(new Date(shift.start_time), 'yyyy/MM/dd')} subValue={format(new Date(shift.start_time), 'HH:mm')} />
        <InfoCard icon={Clock} label="وقت الانتهاء" value={shift.end_time ? format(new Date(shift.end_time), 'yyyy/MM/dd') : '-'} subValue={shift.end_time ? format(new Date(shift.end_time), 'HH:mm') : 'لا يزال يعمل'} />
      </div>

      {/* Main Cash Summary (Image 3 Style) */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-3 grid grid-cols-2 md:grid-cols-4 gap-6">
           <StatBox label="إجمالي المبيعات" value={sales.reduce((s: any, a: any) => s + a.total, 0)} icon={ShoppingBag} color="blue" />
           <StatBox label="إجمالي المرتجعات" value={returns.reduce((s: any, a: any) => s + a.total, 0)} icon={RotateCcw} color="rose" />
           <StatBox label="صافي النقدية" value={summary.cashSales - summary.cashReturns} icon={DollarSign} color="emerald" />
           <StatBox label="عدد الفواتير" value={sales.reduce((s: any, a: any) => s + a.count, 0)} icon={Receipt} color="purple" />
        </div>
        <div className={cn(
          "p-8 rounded-[40px] flex flex-col justify-center border-2",
          summary.difference === 0 ? "bg-emerald-50 border-emerald-200 text-emerald-700" :
          summary.difference > 0 ? "bg-blue-50 border-blue-200 text-blue-700" : "bg-rose-50 border-rose-200 text-rose-700"
        )}>
           <p className="text-xs font-black uppercase tracking-widest opacity-60 mb-2">فرق العجز / الزيادة</p>
           <p className="text-4xl font-black">{summary.difference > 0 ? '+' : ''}{summary.difference.toLocaleString()} <span className="text-sm">ج.م</span></p>
           <div className="flex items-center gap-2 mt-4 opacity-70">
             {summary.difference === 0 ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
             <span className="font-bold text-sm">{summary.difference === 0 ? 'مطابق تماماً' : 'يوجد فرق نقدي'}</span>
           </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Sales Breakdown */}
        <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
           <div className="p-8 border-b border-slate-50 dark:border-slate-800 flex justify-between items-center">
              <h3 className="text-lg font-black flex items-center gap-3"><TrendingUp className="text-blue-500" /> تحليل المبيعات</h3>
           </div>
           <div className="p-8 space-y-6">
              {sales.map((s: any) => (
                <div key={s.payment_method} className="flex justify-between items-center">
                   <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-slate-50 dark:bg-slate-800 rounded-2xl flex items-center justify-center">
                         {s.payment_method === 'cash' ? <DollarSign className="w-6 h-6 text-emerald-500" /> : <CreditCard className="w-6 h-6 text-blue-500" />}
                      </div>
                      <div>
                         <p className="font-black text-slate-800 dark:text-white">{s.payment_method === 'cash' ? 'نقدي' : s.payment_method === 'visa' ? 'فيزا / شبكة' : s.payment_method}</p>
                         <p className="text-xs font-bold text-slate-400">{s.count} فاتورة</p>
                      </div>
                   </div>
                   <div className="text-left">
                      <p className="text-xl font-black">{s.total.toLocaleString()} <span className="text-[10px]">ج.م</span></p>
                      {s.remaining > 0 && <p className="text-[10px] font-bold text-rose-500">آجل: {s.remaining.toLocaleString()}</p>}
                   </div>
                </div>
              ))}
           </div>
        </div>

        {/* Cash Flow Reconciliation */}
        <div className="bg-slate-900 text-white rounded-[40px] p-10 shadow-2xl relative overflow-hidden">
           <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/10 blur-[100px] rounded-full" />
           <h3 className="text-2xl font-black mb-8 relative z-10">مطابقة الخزينة</h3>
           
           <div className="space-y-6 relative z-10">
              <ReconRow label="الرصيد الافتتاحي" value={shift.starting_cash} />
              <ReconRow label="مبيعات نقدية (+)" value={summary.cashSales} color="text-emerald-400" />
              <ReconRow label="مرتجعات نقدية (-)" value={summary.cashReturns} color="text-rose-400" />
              <ReconRow label="توريدات يدوية (+)" value={summary.cashReceipts} color="text-emerald-400" />
              <ReconRow label="مصروفات / سحب (-)" value={summary.cashDisbursements} color="text-rose-400" />
              
              <div className="pt-6 border-t border-white/10 mt-6">
                 <div className="flex justify-between items-end">
                    <div>
                       <p className="text-xs font-bold text-white/40 uppercase tracking-widest mb-1">الرصيد المتوقع</p>
                       <p className="text-3xl font-black text-blue-400">{summary.expectedCash.toLocaleString()} <span className="text-sm">ج.م</span></p>
                    </div>
                    <div className="text-left">
                       <p className="text-xs font-bold text-white/40 uppercase tracking-widest mb-1">الرصيد الفعلي</p>
                       <p className="text-3xl font-black">{summary.actualCash ? summary.actualCash.toLocaleString() : '---'} <span className="text-sm">ج.م</span></p>
                    </div>
                 </div>
              </div>
           </div>
        </div>
      </div>
    </div>
  );
}

function InfoCard({ icon: Icon, label, value, subValue }: any) {
  return (
    <div className="bg-white dark:bg-slate-900 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 flex items-center gap-5 shadow-sm">
      <div className="w-14 h-14 bg-slate-50 dark:bg-slate-800 rounded-2xl flex items-center justify-center text-slate-400">
        <Icon className="w-7 h-7" />
      </div>
      <div>
        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{label}</p>
        <p className="text-lg font-black text-slate-800 dark:text-white">{value}</p>
        <p className="text-xs font-bold text-blue-500">{subValue}</p>
      </div>
    </div>
  );
}

function StatBox({ label, value, icon: Icon, color }: any) {
  const colors: any = {
    blue: "bg-blue-50 text-blue-600",
    rose: "bg-rose-50 text-rose-600",
    emerald: "bg-emerald-50 text-emerald-600",
    purple: "bg-purple-50 text-purple-600"
  };
  return (
    <div className="bg-white dark:bg-slate-900 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-sm text-center">
      <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4", colors[color])}>
        <Icon className="w-6 h-6" />
      </div>
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">{label}</p>
      <p className="text-2xl font-black text-slate-800 dark:text-white">{value.toLocaleString()}</p>
    </div>
  );
}

function ReconRow({ label, value, color = "text-white/80" }: any) {
  return (
    <div className="flex justify-between items-center text-sm font-bold">
      <span className="text-white/60">{label}</span>
      <span className={color}>{value.toLocaleString()} ج.م</span>
    </div>
  );
}
