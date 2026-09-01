'use client';
import { useHotkeys } from 'react-hotkeys-hook';

import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { 
  Plus, Search, ArrowRightLeft, X, Save, Activity, DollarSign,
  ArrowUpRight, ArrowDownLeft, Clock, Wallet, Layers, Filter
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { 
  createCashMovementAction, 
  getCashMovementsAction 
} from '@/app/actions-client/finance';
import { addExpenseAction } from '@/app/actions-client/expenses';
import { getCurrentShiftAction } from '@/app/actions-client/shifts';
import { format, isValid } from 'date-fns';
import { toast } from 'react-hot-toast';

const safeFormat = (dateStr: string | null | undefined, fmt: string) => {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return isValid(d) ? format(d, fmt) : '-';
};

export default function CashTransactionsClient({ 
  initialShowForm, 
  onFormClose 
}: { 
  initialShowForm?: { show: boolean, type: 'disbursement' | 'receipt' },
  onFormClose?: () => void 
} = {}) {
  const [movements, setMovements] = useState<any[]>([]);
  const [currentShift, setCurrentShift] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState<{ show: boolean, type: 'disbursement' | 'receipt' }>(initialShowForm || { show: false, type: 'disbursement' });
  const [filterType, setFilterType] = useState<'all' | 'disbursement' | 'receipt'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    if (initialShowForm) {
      setShowForm(initialShowForm);
    }
  }, [initialShowForm]);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    const [movRes, shiftRes] = await Promise.all([
      getCashMovementsAction(),
      getCurrentShiftAction()
    ]);
    if (movRes.success) setMovements(movRes.data as any[]);
    if (shiftRes.success && shiftRes.data) setCurrentShift(shiftRes.data);
    setLoading(false);
  }

  const stats = useMemo(() => {
    let totalDisbursements = 0;
    let totalReceipts = 0;
    let disbursementCount = 0;
    let receiptCount = 0;

    movements.forEach(m => {
      const amt = Number(m.amount) || 0;
      if (m.type === 'disbursement') {
        totalDisbursements += amt;
        disbursementCount++;
      } else if (m.type === 'receipt') {
        totalReceipts += amt;
        receiptCount++;
      }
    });

    return {
      totalDisbursements,
      totalReceipts,
      netMovement: totalReceipts - totalDisbursements,
      disbursementCount,
      receiptCount,
      totalCount: movements.length
    };
  }, [movements]);

  const filteredMovements = useMemo(() => {
    return movements.filter(m => {
      if (filterType !== 'all' && m.type !== filterType) return false;
      if (searchTerm.trim()) {
        const query = searchTerm.toLowerCase().trim();
        const categoryText = String(m.category || '').toLowerCase();
        const subCategoryText = String(m.sub_category || '').toLowerCase();
        const targetText = String(m.target_name || '').toLowerCase();
        const notesText = String(m.notes || '').toLowerCase();
        const userText = String(m.user_name || m.user_id || '').toLowerCase();
        const shiftText = String(m.shift_id || '').toLowerCase();
        const amountText = String(m.amount || '');

        const matches = 
          categoryText.includes(query) ||
          subCategoryText.includes(query) ||
          targetText.includes(query) ||
          notesText.includes(query) ||
          userText.includes(query) ||
          shiftText.includes(query) ||
          amountText.includes(query);

        if (!matches) return false;
      }
      return true;
    });
  }, [movements, filterType, searchTerm]);

  if (!isMounted) return null;

  return (
    <div className="space-y-8" dir="rtl">
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-6">
        <div>
          <h2 className="text-2xl font-black text-slate-800 dark:text-white">حركة النقدية (صرف / توريد)</h2>
          <p className="text-slate-500 font-bold mt-1">كل حركة تُربط تلقائياً بالوردية المفتوحة وتظهر في تسليم الدرج والقيود اليومية</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/shifts"
            className="px-5 py-3.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 rounded-2xl font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-all flex items-center gap-2 text-sm"
          >
            <Clock className="w-4 h-4 text-blue-500" />
            الورديات
          </Link>
          <Link
            href="/finance/handover"
            className="px-5 py-3.5 bg-blue-600 text-white rounded-2xl font-black hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 flex items-center gap-2 text-sm"
          >
            <Wallet className="w-4 h-4" />
            تسليم الدرج
          </Link>
          <button 
            onClick={() => setShowForm({ show: true, type: 'disbursement' })}
            className="px-6 py-3.5 bg-rose-600 text-white rounded-2xl font-black hover:bg-rose-700 transition-all shadow-xl shadow-rose-500/20 flex items-center gap-2 text-sm"
          >
            <Plus className="w-4 h-4" /> صرف نقدية
          </button>
          <button 
            onClick={() => setShowForm({ show: true, type: 'receipt' })}
            className="px-6 py-3.5 bg-emerald-600 text-white rounded-2xl font-black hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-500/20 flex items-center gap-2 text-sm"
          >
            <Plus className="w-4 h-4" /> توريد نقدية
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 p-6 rounded-[28px] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-900/30 text-blue-600 flex items-center justify-center font-black">
            <Clock className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-400">حالة الوردية الحالية</div>
            <div className="text-sm font-black text-slate-800 dark:text-white mt-0.5">
              {currentShift ? (
                <span className="text-emerald-600 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  وردية نشطة #{String(currentShift.id).slice(0, 8)}
                </span>
              ) : (
                <span className="text-amber-500">لا توجد وردية مفتوحة</span>
              )}
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-[28px] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-rose-50 dark:bg-rose-900/30 text-rose-600 flex items-center justify-center font-black">
            <ArrowUpRight className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-400">إجمالي الصرف ({stats.disbursementCount})</div>
            <div className="text-lg font-black text-rose-600 mt-0.5">
              {stats.totalDisbursements.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-[28px] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 flex items-center justify-center font-black">
            <ArrowDownLeft className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-400">إجمالي التوريد ({stats.receiptCount})</div>
            <div className="text-lg font-black text-emerald-600 mt-0.5">
              {stats.totalReceipts.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 p-6 rounded-[28px] border border-slate-100 dark:border-slate-800 shadow-sm flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-purple-50 dark:bg-purple-900/30 text-purple-600 flex items-center justify-center font-black">
            <DollarSign className="w-6 h-6" />
          </div>
          <div>
            <div className="text-xs font-bold text-slate-400">صافي الحركة النقدية</div>
            <div className={cn("text-lg font-black mt-0.5", stats.netMovement >= 0 ? "text-emerald-600" : "text-rose-600")}>
              {stats.netMovement >= 0 ? '+' : ''}{stats.netMovement.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م
            </div>
          </div>
        </div>
      </div>

      {showForm.show && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-8">
          <div className="w-full max-w-3xl animate-in zoom-in duration-300">
            <CashMovementForm 
              type={showForm.type} 
              currentShift={currentShift}
              onClose={() => { 
                setShowForm({ ...showForm, show: false }); 
                loadData(); 
                if (onFormClose) onFormClose();
              }} 
            />
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
        <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-4 w-full md:w-auto">
            <h4 className="font-black text-slate-700 dark:text-slate-200 text-sm">
              سجل الحركات الأخيرة ({filteredMovements.length})
            </h4>
            
            <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-2xl gap-1">
              <button
                onClick={() => setFilterType('all')}
                className={cn(
                  "px-3.5 py-1.5 rounded-xl text-xs font-black transition-all",
                  filterType === 'all'
                    ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm"
                    : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                )}
              >
                الكل ({stats.totalCount})
              </button>
              <button
                onClick={() => setFilterType('disbursement')}
                className={cn(
                  "px-3.5 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1",
                  filterType === 'disbursement'
                    ? "bg-rose-600 text-white shadow-sm"
                    : "text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/20"
                )}
              >
                صرف ({stats.disbursementCount})
              </button>
              <button
                onClick={() => setFilterType('receipt')}
                className={cn(
                  "px-3.5 py-1.5 rounded-xl text-xs font-black transition-all flex items-center gap-1",
                  filterType === 'receipt'
                    ? "bg-emerald-600 text-white shadow-sm"
                    : "text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/20"
                )}
              >
                توريد ({stats.receiptCount})
              </button>
            </div>
          </div>

          <div className="relative w-full md:w-80">
            <Search className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text"
              placeholder="بحث في البيان، المستلم، الملاحظات، أو المستخدم..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pr-10 pl-4 py-2.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl text-xs font-bold text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {searchTerm && (
              <button onClick={() => setSearchTerm('')} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        <table className="w-full text-right">
          <thead className="bg-slate-50 dark:bg-slate-800/50">
            <tr>
              <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">التاريخ</th>
              <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase text-center">النوع</th>
              <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">البيان / التصنيف</th>
              <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">القيمة</th>
              <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">المستخدم / الوردية</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {loading ? (
              <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل السجل...</td></tr>
            ) : filteredMovements.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-20 text-center text-slate-400 font-bold">
                  {searchTerm ? 'لا توجد نتائج مطابقة للبحث' : 'لا توجد حركات مسجلة'}
                </td>
              </tr>
            ) : filteredMovements.map((m: any) => (
              <tr key={m.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                <td className="px-8 py-5 font-bold text-slate-500 text-xs" dir="ltr">
                  {safeFormat(m.created_at || m.date, 'yyyy/MM/dd HH:mm')}
                </td>
                <td className="px-8 py-5 text-center">
                  <span className={cn(
                    "px-4 py-1.5 rounded-full text-xs font-black inline-block",
                    m.type === 'disbursement' ? "bg-rose-50 text-rose-600 dark:bg-rose-950/30 dark:text-rose-400" : "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-400"
                  )}>
                    {m.type === 'disbursement' ? 'صرف نقدية' : 'توريد نقدية'}
                  </span>
                </td>
                <td className="px-8 py-5">
                  <p className="font-black text-slate-800 dark:text-white text-sm">
                    {m.category === 'operating_expenses' ? 'مصروفات تشغيل' : 
                     m.category === 'salaries' ? 'أجور ومرتبات' :
                     m.category === 'rent' ? 'إيجار' :
                     m.category === 'electricity' ? 'كهرباء' :
                     m.category === 'personal' ? 'مسحوبات شخصية' :
                     m.category === 'patient' ? 'توريد من عميل' : 
                     m.category === 'supplier' ? 'توريد من مورد' : 
                     m.category === 'pharmacy' ? 'توريد للصيدلية' :
                     m.category === 'handover' ? 'تسليم درج' : m.category}
                  </p>
                  <p className="text-[11px] text-slate-400 font-bold mt-0.5">
                    {[m.sub_category, m.target_name, m.notes].filter(Boolean).join(' • ') || '—'}
                  </p>
                </td>
                <td className="px-8 py-5">
                  <p className={cn("font-black text-lg", m.type === 'disbursement' ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400")}>
                    {m.type === 'disbursement' ? '-' : '+'}{Number(m.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })} <span className="text-xs">ج.م</span>
                  </p>
                </td>
                <td className="px-8 py-5">
                  <p className="font-bold text-slate-700 dark:text-slate-300 text-xs">{m.user_name || m.user_id}</p>
                  {m.shift_id ? (
                    <Link href="/shifts" className="text-[10px] font-mono text-blue-500 hover:underline inline-block mt-0.5">
                      وردية #{String(m.shift_id).slice(0, 8)}
                    </Link>
                  ) : (
                    <span className="text-[10px] text-slate-400 font-bold">الخزينة الرئيسية</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CashMovementForm({ type, currentShift, onClose }: { type: 'disbursement' | 'receipt', currentShift?: any, onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
     amount: 0,
     date: format(new Date(), 'yyyy-MM-dd'),
     actual_date: format(new Date(), 'yyyy-MM-dd HH:mm'),
     category: type === 'disbursement' ? 'operating_expenses' : 'pharmacy',
     sub_category: '',
     source_type: currentShift ? 'pos' : 'main_safe',
     target_name: '',
     notes: '',
     shift_id: currentShift?.id || undefined
  });

  const categories = type === 'disbursement' ? [
     { id: 'operating_expenses', label: 'مصروفات تشغيل' },
     { id: 'salaries', label: 'أجور ومرتبات' },
     { id: 'rent', label: 'إيجار' },
     { id: 'electricity', label: 'كهرباء' },
     { id: 'personal', label: 'مسحوبات شخصية' }
  ] : [
     { id: 'patient', label: 'عميل' },
     { id: 'supplier', label: 'مورد' },
     { id: 'pharmacy', label: 'الصيدلية' },
     { id: 'other', label: 'أخرى' }
  ];

  const subCategories = [
     'إكراميات', 'انترنت', 'أتعاب مهنيين', 'أدوات مكتبية', 'إصلاح وصيانة', 'الرقم الموحد', 'إيجار وسائل نقل', 'تراخيص', 'تليفون وفاكس'
  ];

  useHotkeys('enter', (e) => { e.preventDefault(); handleSubmit(); }, { enableOnFormTags: ['input', 'select'] });

  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

  const handleSubmit = async () => {
     if (formData.amount <= 0) {
        toast.error('يرجى إدخال قيمة صحيحة');
        return;
     }
     setLoading(true);
     const isExpense = type === 'disbursement' && ['operating_expenses', 'salaries', 'rent', 'electricity'].includes(formData.category);
     const res = isExpense
       ? await addExpenseAction({
           category: formData.category === 'operating_expenses'
             ? formData.sub_category || 'operating_expenses'
             : formData.category,
           amount: formData.amount,
           description: formData.notes,
           date: formData.date,
         })
       : await createCashMovementAction({ ...formData, type });
     
     if (res.success) {
        toast.success('تم تسجيل الحركة بنجاح');
        onClose();
     } else {
        toast.error(res.error || 'فشل التسجيل');
     }
     setLoading(false);
  };

  return (
     <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-2xl overflow-hidden">
        <div className={cn(
           "p-8 border-b text-white flex justify-between items-center",
           type === 'disbursement' ? "bg-gradient-to-r from-rose-600 to-rose-800" : "bg-gradient-to-r from-emerald-600 to-emerald-800"
        )}>
           <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-white/20 rounded-2xl flex items-center justify-center">
                 <ArrowRightLeft className="w-6 h-6 text-white" />
              </div>
              <div>
                 <h3 className="text-2xl font-black">{type === 'disbursement' ? 'صرف نقدية جديدة' : 'توريد نقدية جديدة'}</h3>
                 <p className="text-white/60 font-bold">أدخل تفاصيل العملية المالية بدقة</p>
              </div>
           </div>
           <button onClick={onClose} className="p-3 hover:bg-white/10 rounded-2xl transition-all"><X className="w-6 h-6" /></button>
        </div>

        <div className="p-10 space-y-8">
           <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-2">تاريخ المستند</label>
                 <input type="text" value={formData.date} readOnly className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl font-black text-slate-500 outline-none" />
              </div>
              <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-2">التاريخ الفعلي</label>
                 <input type="text" value={formData.actual_date} readOnly className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl font-black text-slate-500 outline-none" />
              </div>
              <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-2">مسلسل</label>
                 <input type="text" value="Auto" readOnly className="w-full bg-slate-50 dark:bg-slate-800 p-4 rounded-2xl font-black text-center text-blue-600 outline-none placeholder:text-blue-200" />
              </div>
           </div>

           <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="space-y-3">
                 <label className="text-lg font-black text-slate-700 dark:text-slate-300">القيمة المالية</label>
                 <div className="relative">
                    <DollarSign className="absolute right-4 top-1/2 -translate-y-1/2 w-6 h-6 text-slate-400" />
                    <input 
                       type="number" 
                       autoFocus
                       value={formData.amount || ''}
                       onChange={(e) => setFormData({...formData, amount: parseFloat(e.target.value) || 0})}
                       placeholder="0.00"
                       className="w-full pr-14 pl-6 py-5 bg-slate-50 dark:bg-slate-800 border-4 border-transparent focus:border-blue-500 rounded-3xl outline-none font-black text-3xl transition-all text-center" 
                    />
                 </div>
              </div>

              <div className="space-y-3">
                 <label className="text-lg font-black text-slate-700 dark:text-slate-300">{type === 'disbursement' ? 'صرف من' : 'وارد إلى'}</label>
                 <select 
                   value={formData.source_type}
                   onChange={(e) => setFormData({...formData, source_type: e.target.value})}
                   className="w-full bg-slate-50 dark:bg-slate-800 p-5 rounded-3xl outline-none font-black text-xl border-4 border-transparent focus:border-blue-500 transition-all appearance-none"
                 >
                    <option value="pos">نقطة البيع (درج الكاشير)</option>
                    <option value="main_safe">خزينة المحل الرئيسية</option>
                    <option value="admin">خزينة الإدارة</option>
                 </select>
              </div>
           </div>

           <div className="bg-slate-50 dark:bg-slate-800/50 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                 <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-2">{type === 'disbursement' ? 'صرف إلى النوع' : 'وارد من النوع'}</label>
                    <select 
                       value={formData.category}
                       onChange={(e) => setFormData({...formData, category: e.target.value})}
                       className="w-full bg-white dark:bg-slate-900 p-4 rounded-2xl outline-none font-black border-2 border-transparent focus:border-blue-500 transition-all"
                    >
                       {categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                 </div>
                 {type === 'disbursement' && (
                    <div className="space-y-2">
                       <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-2">التصنيف الفرعي</label>
                       <select 
                          value={formData.sub_category}
                          onChange={(e) => setFormData({...formData, sub_category: e.target.value})}
                          className="w-full bg-white dark:bg-slate-900 p-4 rounded-2xl outline-none font-black border-2 border-transparent focus:border-blue-500 transition-all"
                       >
                          <option value="">بدون تصنيف فرعي</option>
                          {subCategories.map(s => <option key={s} value={s}>{s}</option>)}
                       </select>
                    </div>
                 )}
                 {type === 'receipt' && (
                    <div className="space-y-2">
                       <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-2">إسم الجهة / الشخص</label>
                       <input 
                          type="text" 
                          value={formData.target_name}
                          onChange={(e) => setFormData({...formData, target_name: e.target.value})}
                          placeholder="ادخل الإسم هنا..." 
                          className="w-full bg-white dark:bg-slate-900 p-4 rounded-2xl outline-none font-black border-2 border-transparent focus:border-blue-500 transition-all" 
                       />
                    </div>
                 )}
              </div>

              <div className="space-y-2">
                 <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mr-2">ملاحظات إضافية</label>
                 <textarea 
                    value={formData.notes}
                    onChange={(e) => setFormData({...formData, notes: e.target.value})}
                    rows={3} 
                    placeholder="اكتب أي ملاحظات هنا..." 
                    className="w-full bg-white dark:bg-slate-900 p-4 rounded-2xl outline-none font-black border-2 border-transparent focus:border-blue-500 transition-all resize-none" 
                 />
              </div>
           </div>
        </div>

        <div className="p-8 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex gap-4">
           <button 
              onClick={handleSubmit}
              disabled={loading}
              className={cn(
                 "flex-1 py-5 rounded-[2rem] font-black text-xl text-white transition-all shadow-2xl flex items-center justify-center gap-3 active:scale-95",
                 type === 'disbursement' ? "bg-rose-600 hover:bg-rose-700 shadow-rose-500/20" : "bg-emerald-600 hover:bg-emerald-700 shadow-emerald-500/20"
              )}
           >
              {loading ? <Activity className="w-6 h-6 animate-spin" /> : <Save className="w-6 h-6" />}
              حفظ العملية (S)
           </button>
           <button onClick={onClose} className="px-10 py-5 bg-white dark:bg-slate-900 text-slate-500 rounded-[2rem] font-black text-xl border border-slate-100 dark:border-slate-700 hover:bg-slate-50 transition-all">
              إلغاء (C)
           </button>
        </div>
     </div>
  );
}
