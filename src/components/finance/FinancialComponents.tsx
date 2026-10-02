'use client';

import React, { useState, useEffect, useRef } from 'react';
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
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [data, setData] = useState<any>(null);
  const [dateFilter, setDateFilter] = useState({ from: '', to: '' });
  const [appliedFilter, setAppliedFilter] = useState({ from: '', to: '' });

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setLoadError(false);
      setData(null);
      try {
        const res = await getPatientStatementAction(patientId);
        if (!active) return;
        if (res.success && res.data) {
          setData(res.data);
        } else {
          setLoadError(true);
        }
      } catch (error) {
        if (active) {
          console.error('Customer statement load failed:', error);
          setLoadError(true);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [patientId, loadAttempt]);

  if (loading) return <div className="p-20 text-center font-black animate-pulse">جاري تحميل كشف الحساب...</div>;
  if (loadError || !data || !data.patient) {
    return (
      <div className="p-20 text-center space-y-4">
        <p className="font-black text-rose-500">فشل تحميل البيانات</p>
        <button
          type="button"
          onClick={() => setLoadAttempt(attempt => attempt + 1)}
          className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-black"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

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
       <div className="bg-white dark:bg-slate-900 p-4 sm:p-6 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm grid grid-cols-1 md:grid-cols-4 gap-4 sm:gap-6 items-end">
          <div className="space-y-2">
             <label htmlFor="statement-date-from" className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">من تاريخ</label>
             <input id="statement-date-from" type="date" value={dateFilter.from} onChange={e => setDateFilter({...dateFilter, from: e.target.value})} className="w-full bg-slate-50 dark:bg-slate-800 p-3.5 rounded-xl border border-transparent outline-none font-bold focus:border-blue-500" />
          </div>
          <div className="space-y-2">
             <label htmlFor="statement-date-to" className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">إلى تاريخ</label>
             <input id="statement-date-to" type="date" value={dateFilter.to} onChange={e => setDateFilter({...dateFilter, to: e.target.value})} className="w-full bg-slate-50 dark:bg-slate-800 p-3.5 rounded-xl border border-transparent outline-none font-bold focus:border-blue-500" />
          </div>
          <div className="flex gap-4">
             <button type="button" onClick={handleSearch} className="flex-1 py-3.5 bg-blue-600 text-white rounded-xl font-black hover:bg-blue-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">بحث</button>
             {hasFilter && (
                <button type="button" onClick={handleReset} className="px-4 py-3.5 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl font-bold hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500">إعادة تعيين</button>
             )}
              <button type="button" aria-label="طباعة كشف الحساب" onClick={() => window.print()} className="p-3.5 bg-slate-100 dark:bg-slate-800 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"><Printer className="w-6 h-6" /></button>
          </div>
          <div className="text-left">
             <p className="text-xs font-black text-slate-500 dark:text-slate-400 mb-1">
                {hasFilter ? 'رصيد نهاية الفترة للحركات المعروضة' : 'الرصيد الحالي'}
             </p>
             <p className="text-3xl font-black text-blue-600">
                {(hasFilter ? periodEndingBalance : currentBalance).toLocaleString('en-US')} <span className="text-xs">ج.م</span>
             </p>
          </div>
       </div>

       {/* Ledger Table */}
       <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 overflow-x-auto shadow-sm">
          <table className="w-full min-w-[760px] text-right border-collapse">
             <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                   <th className="px-6 py-5 text-xs font-black text-slate-400 uppercase border-l border-slate-100 dark:border-slate-800">التاريخ</th>
                   <th className="px-6 py-5 text-xs font-black text-slate-400 uppercase border-l border-slate-100 dark:border-slate-800">البيان</th>
                   <th className="px-6 py-5 text-xs font-black text-slate-400 uppercase border-l border-slate-100 dark:border-slate-800">مدين</th>
                   <th className="px-6 py-5 text-xs font-black text-slate-400 uppercase border-l border-slate-100 dark:border-slate-800">دائن</th>
                   <th className="px-6 py-5 text-xs font-black text-slate-400 uppercase">الرصيد المتراكم للحركات المعروضة</th>
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
                                  <span className="text-xs font-bold text-slate-400">#{mov.doc_no.slice(0, 6)}</span>
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
  const submissionRef = useRef(false);
  const [patients, setPatients] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [selectorLoadError, setSelectorLoadError] = useState(false);
  const [selectorLoadAttempt, setSelectorLoadAttempt] = useState(0);

  useEffect(() => {
    if (targetId) {
      setSelectorLoadError(false);
      setFormData(prev => ({ ...prev, target_id: targetId, target_type: targetType }));
      return;
    }
    
    let isMounted = true;
    setSelectorLoadError(false);
    Promise.all([
      getPatientsAction().catch(() => ({ success: false, data: [] })),
      getSuppliersAction().catch(() => ({ success: false, data: [] }))
    ]).then(([patRes, supRes]) => {
      if (!isMounted) return;
      if (!patRes.success || !supRes.success) setSelectorLoadError(true);
      if (patRes.success && patRes.data) {
        setPatients(patRes.data);
        setFormData(prev => prev.target_type === 'customer' && !prev.target_id && patRes.data.length > 0
          ? { ...prev, target_id: String(patRes.data[0].id) }
          : prev);
      }
      if (supRes.success && supRes.data) {
        setSuppliers(supRes.data);
      }
    });

    return () => { isMounted = false; };
  }, [targetId, targetType, selectorLoadAttempt]);

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

    if (submissionRef.current) return;
    submissionRef.current = true;
    setIsSubmitting(true);
    try {
      const res = await addFinancialNoticeAction(formData as any);
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
    } catch (error) {
      console.error('Financial notice submission failed:', error);
      toast.error('فشل حفظ الإشعار');
    } finally {
      submissionRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-white dark:bg-slate-900 p-4 sm:p-6 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm space-y-6" dir="rtl">
       <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 dark:border-slate-800 pb-4">
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
                aria-pressed={formData.target_type === 'customer'}
                onClick={() => handleTargetTypeChange('customer')}
                className={cn(
                  "px-4 py-2.5 rounded-xl font-black text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                  formData.target_type === 'customer' ? "bg-white dark:bg-slate-900 text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-800 dark:hover:text-white"
                )}
              >
                عميل / مريض
              </button>
              <button
                type="button"
                aria-pressed={formData.target_type === 'supplier'}
                onClick={() => handleTargetTypeChange('supplier')}
                className={cn(
                  "px-4 py-2.5 rounded-xl font-black text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                  formData.target_type === 'supplier' ? "bg-white dark:bg-slate-900 text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-800 dark:hover:text-white"
                )}
              >
                مورد
              </button>
              <button
                type="button"
                aria-pressed={formData.target_type === 'pharmacy'}
                onClick={() => handleTargetTypeChange('pharmacy')}
                className={cn(
                  "px-4 py-2.5 rounded-xl font-black text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                  formData.target_type === 'pharmacy' ? "bg-white dark:bg-slate-900 text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-800 dark:hover:text-white"
                )}
              >
                تسوية الصيدلية (عام)
              </button>
            </div>
          )}
       </div>

       {!targetId && selectorLoadError && (
         <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-300">
           <span className="font-black text-sm">تعذر تحميل قوائم العملاء أو الموردين</span>
           <button
             type="button"
             onClick={() => setSelectorLoadAttempt(attempt => attempt + 1)}
             className="px-4 py-2 rounded-xl bg-rose-600 text-white text-xs font-black"
           >
             إعادة تحميل القوائم
           </button>
         </div>
       )}

       <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-5 md:gap-8">
          <div className="space-y-4">
             {!targetId && formData.target_type !== 'pharmacy' && (
               <div className="space-y-2">
                 <label htmlFor="notice-target" className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">
                   {formData.target_type === 'customer' ? 'العميل / المريض المستهدف *' : 'المورد المستهدف *'}
                 </label>
                 {formData.target_type === 'customer' ? (
                   <select
                     id="notice-target"
                     value={formData.target_id}
                     onChange={e => setFormData({ ...formData, target_id: e.target.value })}
                     className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl outline-none font-bold text-sm border-2 border-transparent focus:border-blue-500 text-slate-900 dark:text-white transition-all"
                   >
                     <option value="">-- اختر العميل --</option>
                     {patients.map(p => (
                       <option key={`pat-opt-${p.id}`} value={p.id}>
                         {p.full_name || p.name || `#${p.id}`} {p.phone ? `(${p.phone})` : ''} - رصيد: {Number(p.outstanding_balance ?? p.current_balance ?? 0)} ج.م
                       </option>
                     ))}
                   </select>
                 ) : (
                   <select
                     id="notice-target"
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
                  aria-pressed={formData.type === 'credit'}
                  onClick={() => setFormData({...formData, type: 'credit'})}
                  className={cn(
                    "py-4 rounded-xl font-black text-base transition-colors border-2 flex flex-col items-center justify-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500",
                    formData.type === 'credit' ? "bg-rose-50 dark:bg-rose-950/30 border-rose-500 text-rose-600 shadow-lg" : "bg-slate-50 dark:bg-slate-800 border-transparent text-slate-400"
                  )}
                >
                   <span>خصم (Credit)</span>
                   <span className="text-xs font-bold opacity-80">تخفيض المديونية / دائن</span>
                </button>
                <button 
                  type="button"
                  aria-pressed={formData.type === 'debit'}
                  onClick={() => setFormData({...formData, type: 'debit'})}
                  className={cn(
                    "py-4 rounded-xl font-black text-base transition-colors border-2 flex flex-col items-center justify-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
                    formData.type === 'debit' ? "bg-emerald-50 dark:bg-emerald-950/30 border-emerald-500 text-emerald-600 shadow-lg" : "bg-slate-50 dark:bg-slate-800 border-transparent text-slate-400"
                  )}
                >
                   <span>إضافة (Debit)</span>
                   <span className="text-xs font-bold opacity-80">زيادة المديونية / مدين</span>
                </button>
             </div>

             <div className="space-y-2">
                <label htmlFor="notice-amount" className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">المبلغ المستحق *</label>
                <input 
                  id="notice-amount"
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
                <label htmlFor="notice-date" className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">تاريخ العملية</label>
                <input 
                  id="notice-date"
                  type="date" 
                  value={formData.date}
                  onChange={e => setFormData({...formData, date: e.target.value})}
                  className="w-full bg-slate-50 dark:bg-slate-800 p-5 rounded-2xl outline-none font-bold text-slate-900 dark:text-white"
                />
             </div>
          </div>

          <div className="space-y-6">
             <div className="space-y-2">
                <label htmlFor="notice-reason" className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">سبب الإشعار *</label>
                <select 
                  id="notice-reason"
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
                <label htmlFor="notice-notes" className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">ملاحظات إضافية</label>
                <textarea 
                  id="notice-notes"
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
                className="w-full py-4 bg-slate-800 hover:bg-slate-700 text-white rounded-xl font-black text-base transition-colors flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-offset-2"
             >
                {isSubmitting ? 'جاري الحفظ...' : <><Save className="w-6 h-6" /> حفظ الإشعار</>}
             </button>
          </div>
       </form>
    </div>
  );
}
