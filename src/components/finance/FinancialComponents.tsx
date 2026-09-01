'use client';

import React, { useState, useEffect } from 'react';
import { 
  History, ArrowUpRight, ArrowDownLeft, Printer, Search, 
  Calendar, CreditCard, User, Box, AlertCircle, Save, X 
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getPatientsAction, getPatientStatementAction } from '@/app/actions-client/patients';
import { getSuppliersAction } from '@/app/actions-client/purchases';
import { addFinancialNoticeAction } from '@/app/actions-client/finance';
import { toast } from 'react-hot-toast';
import { format, isValid } from 'date-fns';

const safeFormat = (dateStr: string | null | undefined, fmt: string) => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return isValid(d) ? format(d, fmt) : '-';
};

export function CustomerStatementContent({ patientId }: { patientId: string }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [dateFilter, setDateFilter] = useState({ from: '', to: '' });
  const [appliedFilter, setAppliedFilter] = useState({ from: '', to: '' });

  useEffect(() => {
    async function load() {
      setLoading(true);
      const res = await getPatientStatementAction(patientId);
      if (res.success) setData(res.data);
      setLoading(false);
    }
    load();
  }, [patientId]);

  if (loading) return <div className="p-20 text-center font-black animate-pulse">جاري تحميل كشف الحساب...</div>;
  if (!data || !data.patient) return <div className="p-20 text-center font-black text-rose-500">فشل تحميل البيانات</div>;

  const patient = data.patient || {};
  const movements = data.movements || [];
  const currentBalance = Number(data.currentBalance ?? 0);

  // 1. Sort all movements chronologically (oldest first)
  const sortedMovements = [...movements].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // 2. Compute running balance for all movements
  let running = Number(patient.opening_balance || 0);
  const movementsWithBalance = sortedMovements.map(mov => {
    const balanceEffect = Number(mov.balance_effect ?? 0);
    running += balanceEffect;
    return { ...mov, balanceEffect, runningBalance: running };
  });

  // 3. Apply appliedFilter
  const fromDate = appliedFilter.from ? new Date(appliedFilter.from + 'T00:00:00') : null;
  const toDate = appliedFilter.to ? new Date(appliedFilter.to + 'T23:59:59') : null;

  let periodOpeningBalance = Number(patient.opening_balance || 0);
  if (fromDate) {
    const beforePeriod = movementsWithBalance.filter(mov => new Date(mov.date).getTime() < fromDate.getTime());
    if (beforePeriod.length > 0) {
      periodOpeningBalance = beforePeriod[beforePeriod.length - 1].runningBalance;
    }
  }

  const visibleMovements = movementsWithBalance.filter(mov => {
    const movTime = new Date(mov.date).getTime();
    if (fromDate && movTime < fromDate.getTime()) return false;
    if (toDate && movTime > toDate.getTime()) return false;
    return true;
  });

  const periodEndingBalance = visibleMovements.length > 0 
    ? visibleMovements[visibleMovements.length - 1].runningBalance 
    : periodOpeningBalance;

  const handleSearch = () => {
    setAppliedFilter(dateFilter);
  };

  const handleReset = () => {
    setDateFilter({ from: '', to: '' });
    setAppliedFilter({ from: '', to: '' });
  };

  const hasFilter = !!(appliedFilter.from || appliedFilter.to);

  return (
    <div className="space-y-8" dir="rtl">
       {/* Filters */}
       <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-sm grid grid-cols-1 md:grid-cols-4 gap-6 items-end">
          <div className="space-y-2">
             <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">من تاريخ</label>
             <input type="date" value={dateFilter.from} onChange={e => setDateFilter({...dateFilter, from: e.target.value})} className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl border-none outline-none font-bold" />
          </div>
          <div className="space-y-2">
             <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">إلى تاريخ</label>
             <input type="date" value={dateFilter.to} onChange={e => setDateFilter({...dateFilter, to: e.target.value})} className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl border-none outline-none font-bold" />
          </div>
          <div className="flex gap-4">
             <button onClick={handleSearch} className="flex-1 py-4 bg-blue-600 text-white rounded-2xl font-black shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all">بحث</button>
             {hasFilter && (
                <button onClick={handleReset} className="px-4 py-4 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-2xl font-bold transition-all">إعادة تعيين</button>
             )}
              <button onClick={() => window.print()} className="p-4 bg-slate-100 dark:bg-slate-800 rounded-2xl text-slate-500 hover:bg-slate-200 transition-all"><Printer className="w-6 h-6" /></button>
          </div>
          <div className="text-left">
             <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">
                {hasFilter ? 'رصيد نهاية الفترة' : 'الرصيد الحالي'}
             </p>
             <p className="text-3xl font-black text-blue-600">
                {(hasFilter ? periodEndingBalance : currentBalance).toLocaleString('en-US')} <span className="text-xs">ج.م</span>
             </p>
          </div>
       </div>

       {/* Ledger Table */}
       <div className="bg-white dark:bg-slate-900 rounded-[32px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
          <table className="w-full text-right border-collapse">
             <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                   <th className="px-6 py-5 text-xs font-black text-slate-400 uppercase border-l border-slate-100 dark:border-slate-800">التاريخ</th>
                   <th className="px-6 py-5 text-xs font-black text-slate-400 uppercase border-l border-slate-100 dark:border-slate-800">البيان</th>
                   <th className="px-6 py-5 text-xs font-black text-slate-400 uppercase border-l border-slate-100 dark:border-slate-800">مدين</th>
                   <th className="px-6 py-5 text-xs font-black text-slate-400 uppercase border-l border-slate-100 dark:border-slate-800">دائن</th>
                   <th className="px-6 py-5 text-xs font-black text-slate-400 uppercase">الرصيد المتراكم</th>
                </tr>
             </thead>
             <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                <tr className="bg-amber-50/30 dark:bg-amber-900/5">
                   <td className="px-6 py-4 font-bold text-slate-400">---</td>
                   <td className="px-6 py-4 font-black text-amber-600 italic">رصيد افتتاحي</td>
                   <td className="px-6 py-4 font-black text-blue-600">{periodOpeningBalance > 0 ? periodOpeningBalance.toLocaleString('en-US') : '0.00'}</td>
                   <td className="px-6 py-4 font-black text-emerald-600">{periodOpeningBalance < 0 ? Math.abs(periodOpeningBalance).toLocaleString('en-US') : '0.00'}</td>
                   <td className="px-6 py-4 font-black">{periodOpeningBalance.toLocaleString('en-US')}</td>
                </tr>
                {visibleMovements.map((mov: any, i: number) => (
                   <tr key={i} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <td className="px-6 py-4 font-bold text-slate-500">{safeFormat(mov.date, 'yyyy/MM/dd HH:mm')}</td>
                      <td className="px-6 py-4">
                         <div className="flex items-center gap-3">
                            <div className={cn(
                               "w-8 h-8 rounded-lg flex items-center justify-center",
                               mov.balanceEffect > 0 ? "bg-blue-100 text-blue-600" : "bg-emerald-100 text-emerald-600"
                             )}>
                                {mov.balanceEffect > 0 ? <ArrowUpRight className="w-4 h-4" /> : <ArrowDownLeft className="w-4 h-4" />}
                            </div>
                            <div className="min-w-0">
                               <div className="flex items-center gap-2">
                                  <span className="font-black text-slate-800 dark:text-white">{mov.type}</span>
                                  <span className="text-[10px] font-bold text-slate-400">#{mov.doc_no.slice(0, 6)}</span>
                                </div>
                               {mov.notes && <p className="mt-1 text-xs font-bold text-slate-500 break-words">{mov.notes}</p>}
                            </div>
                         </div>
                      </td>
                      <td className="px-6 py-4 font-black text-blue-600">{mov.balanceEffect > 0 ? mov.balanceEffect.toLocaleString('en-US') : '0.00'}</td>
                      <td className="px-6 py-4 font-black text-emerald-600">{mov.balanceEffect < 0 ? Math.abs(mov.balanceEffect).toLocaleString('en-US') : '0.00'}</td>
                      <td className="px-6 py-4 font-black text-slate-900 dark:text-white">{mov.runningBalance.toLocaleString('en-US')}</td>
                   </tr>
                ))}
             </tbody>
          </table>
       </div>
    </div>
  );
}

export function FinancialNoticeForm({ 
  targetId, 
  targetType = 'customer', 
  onSuccess 
}: { 
  targetId?: string, 
  targetType?: 'customer' | 'supplier' | 'pharmacy', 
  onSuccess?: () => void 
}) {
  const [formData, setFormData] = useState({
    type: 'credit' as 'credit' | 'debit',
    target_type: targetType,
    target_id: targetId || '',
    amount: 0,
    reason: 'خصم إضافي / تسوية حساب',
    notes: '',
    date: format(new Date(), 'yyyy-MM-dd')
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [patients, setPatients] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);

  useEffect(() => {
    if (targetId) {
      setFormData(prev => ({ ...prev, target_id: targetId, target_type: targetType }));
      return;
    }
    
    let isMounted = true;
    Promise.all([
      getPatientsAction().catch(() => ({ success: false, data: [] })),
      getSuppliersAction().catch(() => ({ success: false, data: [] }))
    ]).then(([patRes, supRes]) => {
      if (!isMounted) return;
      if (patRes.success && patRes.data) {
        setPatients(patRes.data);
        if (formData.target_type === 'customer' && !formData.target_id && patRes.data.length > 0) {
          setFormData(prev => ({ ...prev, target_id: String(patRes.data[0].id) }));
        }
      }
      if (supRes.success && supRes.data) {
        setSuppliers(supRes.data);
      }
    });

    return () => { isMounted = false; };
  }, [targetId]);

  const handleTargetTypeChange = (newType: 'customer' | 'supplier' | 'pharmacy') => {
    let initialTargetId = '';
    if (newType === 'customer' && patients.length > 0) {
      initialTargetId = String(patients[0].id);
    } else if (newType === 'supplier' && suppliers.length > 0) {
      initialTargetId = String(suppliers[0].id);
    }
    setFormData(prev => ({
      ...prev,
      target_type: newType,
      target_id: initialTargetId,
      reason: newType === 'customer' 
        ? 'خصم إضافي / تسوية حساب' 
        : newType === 'supplier' 
          ? 'خصم تجاري / تسوية فاتورة' 
          : 'تسوية عجز / زيادة نقدية'
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.target_type !== 'pharmacy' && !formData.target_id) {
      toast.error(formData.target_type === 'customer' ? 'يرجى اختيار العميل المستهدف' : 'يرجى اختيار المورد المستهدف');
      return;
    }
    if (!formData.amount || formData.amount <= 0) {
      toast.error('يرجى إدخال مبلغ صحيح للإشعار');
      return;
    }

    setIsSubmitting(true);
    const res = await addFinancialNoticeAction(formData as any);
    setIsSubmitting(false);
    if (res.success) {
       toast.success('تم حفظ الإشعار المالي بنجاح');
       setFormData(prev => ({
         ...prev, 
         amount: 0, 
         notes: '',
         target_id: targetId || prev.target_id
       }));
       onSuccess?.();
    } else {
       toast.error(res.error || 'فشل حفظ الإشعار');
    }
  };

  return (
    <div className="bg-white dark:bg-slate-900 p-8 md:p-10 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm space-y-8" dir="rtl">
       <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-6">
          <div className="flex items-center gap-4">
             <div className="w-14 h-14 bg-amber-100 dark:bg-amber-900/30 rounded-2xl flex items-center justify-center text-amber-600">
                <AlertCircle className="w-8 h-8" />
             </div>
             <div>
                <h3 className="text-2xl font-black text-slate-800 dark:text-white">إشعار مالي جديد (Notice)</h3>
                <p className="text-slate-500 font-bold text-xs md:text-sm">تسجيل تسوية مالية أو خصم/إضافة وتعديل الأرصدة والقيود المحاسبية</p>
             </div>
          </div>

          {!targetId && (
            <div className="flex items-center p-1.5 bg-slate-100 dark:bg-slate-800 rounded-2xl gap-1">
              <button
                type="button"
                onClick={() => handleTargetTypeChange('customer')}
                className={cn(
                  "px-5 py-2.5 rounded-xl font-black text-xs transition-all",
                  formData.target_type === 'customer' ? "bg-white dark:bg-slate-900 text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-800 dark:hover:text-white"
                )}
              >
                عميل / مريض
              </button>
              <button
                type="button"
                onClick={() => handleTargetTypeChange('supplier')}
                className={cn(
                  "px-5 py-2.5 rounded-xl font-black text-xs transition-all",
                  formData.target_type === 'supplier' ? "bg-white dark:bg-slate-900 text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-800 dark:hover:text-white"
                )}
              >
                مورد
              </button>
              <button
                type="button"
                onClick={() => handleTargetTypeChange('pharmacy')}
                className={cn(
                  "px-5 py-2.5 rounded-xl font-black text-xs transition-all",
                  formData.target_type === 'pharmacy' ? "bg-white dark:bg-slate-900 text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-800 dark:hover:text-white"
                )}
              >
                تسوية الصيدلية (عام)
              </button>
            </div>
          )}
       </div>

       <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="space-y-4">
             {!targetId && formData.target_type !== 'pharmacy' && (
               <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">
                   {formData.target_type === 'customer' ? 'العميل / المريض المستهدف *' : 'المورد المستهدف *'}
                 </label>
                 {formData.target_type === 'customer' ? (
                   <select
                     value={formData.target_id}
                     onChange={e => setFormData({ ...formData, target_id: e.target.value })}
                     className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl outline-none font-bold text-sm border-2 border-transparent focus:border-blue-500 text-slate-900 dark:text-white transition-all"
                   >
                     <option value="">-- اختر العميل --</option>
                     {patients.map(p => (
                       <option key={`pat-opt-${p.id}`} value={p.id}>
                         {p.name} {p.phone ? `(${p.phone})` : ''} {p.current_balance ? ` - رصيد: ${p.current_balance} ج.م` : ''}
                       </option>
                     ))}
                   </select>
                 ) : (
                   <select
                     value={formData.target_id}
                     onChange={e => setFormData({ ...formData, target_id: e.target.value })}
                     className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl outline-none font-bold text-sm border-2 border-transparent focus:border-blue-500 text-slate-900 dark:text-white transition-all"
                   >
                     <option value="">-- اختر المورد --</option>
                     {suppliers.map(s => (
                       <option key={`sup-opt-${s.id}`} value={s.id}>
                         {s.name} {s.phone ? `(${s.phone})` : ''} {s.current_balance ? ` - رصيد: ${s.current_balance} ج.م` : ''}
                       </option>
                     ))}
                   </select>
                 )}
               </div>
             )}

             <div className="grid grid-cols-2 gap-4">
                <button 
                  type="button"
                  onClick={() => setFormData({...formData, type: 'credit'})}
                  className={cn(
                    "py-5 rounded-2xl font-black text-lg transition-all border-2 flex flex-col items-center justify-center gap-1",
                    formData.type === 'credit' ? "bg-rose-50 dark:bg-rose-950/30 border-rose-500 text-rose-600 shadow-lg" : "bg-slate-50 dark:bg-slate-800 border-transparent text-slate-400"
                  )}
                >
                   <span>خصم (Credit)</span>
                   <span className="text-[10px] font-bold opacity-75">تخفيض المديونية / دائن</span>
                </button>
                <button 
                  type="button"
                  onClick={() => setFormData({...formData, type: 'debit'})}
                  className={cn(
                    "py-5 rounded-2xl font-black text-lg transition-all border-2 flex flex-col items-center justify-center gap-1",
                    formData.type === 'debit' ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-500 text-emerald-600 shadow-lg" : "bg-slate-50 dark:bg-slate-800 border-transparent text-slate-400"
                  )}
                >
                   <span>إضافة (Debit)</span>
                   <span className="text-[10px] font-bold opacity-75">زيادة المديونية / مدين</span>
                </button>
             </div>

             <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">المبلغ المستحق *</label>
                <input 
                  type="number" 
                  step="any"
                  min="0.01"
                  value={formData.amount || ''}
                  onChange={e => setFormData({...formData, amount: parseFloat(e.target.value) || 0})}
                  className="w-full bg-slate-50 dark:bg-slate-800 p-5 rounded-2xl outline-none font-black text-3xl text-center text-blue-600 focus:bg-white dark:focus:bg-slate-900 border-2 border-transparent focus:border-blue-500 transition-all font-mono"
                  placeholder="0.00"
                />
             </div>

             <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">تاريخ العملية</label>
                <input 
                  type="date" 
                  value={formData.date}
                  onChange={e => setFormData({...formData, date: e.target.value})}
                  className="w-full bg-slate-50 dark:bg-slate-800 p-5 rounded-2xl outline-none font-bold text-slate-900 dark:text-white"
                />
             </div>
          </div>

          <div className="space-y-6">
             <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">سبب الإشعار *</label>
                <select 
                  value={formData.reason}
                  onChange={e => setFormData({...formData, reason: e.target.value})}
                  className="w-full bg-slate-50 dark:bg-slate-800 p-5 rounded-2xl outline-none font-black border-2 border-transparent focus:border-amber-500 text-slate-900 dark:text-white transition-all"
                >
                   {formData.target_type === 'customer' ? (
                     <>
                       <option value="خصم إضافي / تسوية حساب">خصم إضافي / تسوية حساب</option>
                       <option value="رصيد افتتاحي">رصيد افتتاحي</option>
                       <option value="فرق كسور وهلاكات">فرق كسور وهلاكات</option>
                       <option value="فرق مرتجعات وبضاعة">فرق مرتجعات وبضاعة</option>
                       <option value="حافز / مكافأة تعامل">حافز / مكافأة تعامل</option>
                       <option value="أخرى">أخرى</option>
                     </>
                   ) : formData.target_type === 'supplier' ? (
                     <>
                       <option value="خصم تجاري / تسوية فاتورة">خصم تجاري / تسوية فاتورة</option>
                       <option value="رصيد افتتاحي">رصيد افتتاحي</option>
                       <option value="مرتجع غير مطابق">مرتجع غير مطابق</option>
                       <option value="فرق أسعار وبونص">فرق أسعار وبونص</option>
                       <option value="أخرى">أخرى</option>
                     </>
                   ) : (
                     <>
                       <option value="تسوية عجز / زيادة نقدية">تسوية عجز / زيادة نقدية</option>
                       <option value="رصيد افتتاحي">رصيد افتتاحي</option>
                       <option value="تسوية أرصدة حسابات">تسوية أرصدة حسابات</option>
                       <option value="أخرى">أخرى</option>
                     </>
                   )}
                </select>
             </div>

             <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-wider mr-2">ملاحظات إضافية</label>
                <textarea 
                  value={formData.notes}
                  onChange={e => setFormData({...formData, notes: e.target.value})}
                  rows={4}
                  className="w-full bg-slate-50 dark:bg-slate-800 p-5 rounded-2xl outline-none font-bold resize-none text-slate-900 dark:text-white"
                  placeholder="سجل تفاصيل العملية ومبررات الإشعار هنا..."
                />
             </div>

             <button 
                type="submit"
                disabled={isSubmitting || !formData.amount}
                className="w-full py-5 bg-slate-800 hover:bg-slate-700 text-white rounded-3xl font-black text-xl transition-all shadow-xl flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95"
             >
                {isSubmitting ? 'جاري الحفظ...' : <><Save className="w-6 h-6" /> حفظ الإشعار (S)</>}
             </button>
          </div>
       </form>
    </div>
  );
}