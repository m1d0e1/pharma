'use client';
import { useHotkeys } from 'react-hotkeys-hook';

import React, { useState, useEffect } from 'react';
import { 
  Plus, Search, ArrowRightLeft, X, Save, Activity, DollarSign,
  ArrowUpRight, ArrowDownLeft
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { 
  createCashMovementAction, 
  getCashMovementsAction 
} from '@/app/actions/finance';
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
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState<{ show: boolean, type: 'disbursement' | 'receipt' }>(initialShowForm || { show: false, type: 'disbursement' });
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    if (initialShowForm) {
      setShowForm(initialShowForm);
    }
  }, [initialShowForm]);

  useEffect(() => {
    loadMovements();
  }, []);

  async function loadMovements() {
    setLoading(true);
    const res = await getCashMovementsAction();
    if (res.success) setMovements(res.data as any[]);
    setLoading(false);
  }

  if (!isMounted) return null;

  return (
    <div className="space-y-8" dir="rtl">
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-black text-slate-800 dark:text-white">حركة النقدية (صرف / توريد)</h2>
          <p className="text-slate-500 font-bold">إدارة جميع حركات السيولة النقدية اليدوية</p>
        </div>
        <div className="flex gap-4">
          <button 
            onClick={() => setShowForm({ show: true, type: 'disbursement' })}
            className="px-8 py-4 bg-rose-600 text-white rounded-2xl font-black hover:bg-rose-700 transition-all shadow-xl shadow-rose-500/20 flex items-center gap-2"
          >
            <Plus className="w-5 h-5" /> صرف نقدية
          </button>
          <button 
            onClick={() => setShowForm({ show: true, type: 'receipt' })}
            className="px-8 py-4 bg-emerald-600 text-white rounded-2xl font-black hover:bg-emerald-700 transition-all shadow-xl shadow-emerald-500/20 flex items-center gap-2"
          >
            <Plus className="w-5 h-5" /> توريد نقدية
          </button>
        </div>
      </div>

      {showForm.show && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-8">
          <div className="w-full max-w-3xl animate-in zoom-in duration-300">
            <CashMovementForm 
              type={showForm.type} 
              onClose={() => { 
                setShowForm({ ...showForm, show: false }); 
                loadMovements(); 
                if (onFormClose) onFormClose();
              }} 
            />
          </div>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
        <div className="p-8 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
          <h4 className="font-black text-slate-500 uppercase tracking-widest text-xs">سجل الحركات الأخيرة ({movements.length})</h4>
          <div className="flex gap-2">
            <span className="bg-rose-100 text-rose-600 px-3 py-1 rounded-lg text-[10px] font-black uppercase">صرف</span>
            <span className="bg-emerald-100 text-emerald-600 px-3 py-1 rounded-lg text-[10px] font-black uppercase">توريد</span>
          </div>
        </div>
        <table className="w-full text-right">
          <thead className="bg-slate-50 dark:bg-slate-800/50">
            <tr>
              <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">التاريخ</th>
              <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase text-center">النوع</th>
              <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">البيان / التصنيف</th>
              <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">القيمة</th>
              <th className="px-8 py-5 text-xs font-black text-slate-400 uppercase">المستخدم</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {loading ? (
              <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">جاري تحميل السجل...</td></tr>
            ) : movements.length === 0 ? (
              <tr><td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">لا توجد حركات مسجلة</td></tr>
            ) : movements.map((m: any) => (
              <tr key={m.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                <td className="px-8 py-5 font-bold text-slate-500">
                  {safeFormat(m.created_at, 'yyyy/MM/dd HH:mm')}
                </td>
                <td className="px-8 py-5 text-center">
                  <span className={cn(
                    "px-4 py-1.5 rounded-full text-xs font-black",
                    m.type === 'disbursement' ? "bg-rose-50 text-rose-600" : "bg-emerald-50 text-emerald-600"
                  )}>
                    {m.type === 'disbursement' ? 'صرف نقدية' : 'توريد نقدية'}
                  </span>
                </td>
                <td className="px-8 py-5">
                  <p className="font-black text-slate-800 dark:text-white">
                    {m.category === 'operating_expenses' ? 'مصروفات تشغيل' : 
                     m.category === 'salaries' ? 'أجور ومرتبات' :
                     m.category === 'patient' ? 'توريد من عميل' : 
                     m.category === 'supplier' ? 'توريد من مورد' : m.category}
                  </p>
                  <p className="text-[10px] text-slate-400 font-bold">{m.sub_category || m.target_name || m.notes}</p>
                </td>
                <td className="px-8 py-5">
                  <p className={cn("font-black text-lg", m.type === 'disbursement' ? "text-rose-600" : "text-emerald-600")}>
                    {m.type === 'disbursement' ? '-' : '+'}{m.amount.toLocaleString('en-US')} <span className="text-xs">ج.م</span>
                  </p>
                </td>
                <td className="px-8 py-5 font-bold text-slate-400 italic">SYSTEM</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CashMovementForm({ type, onClose }: { type: 'disbursement' | 'receipt', onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
     amount: 0,
     date: format(new Date(), 'yyyy-MM-dd'),
     actual_date: format(new Date(), 'yyyy-MM-dd HH:mm'),
     category: type === 'disbursement' ? 'operating_expenses' : 'pharmacy',
     sub_category: '',
     source_type: 'pos',
     target_name: '',
     notes: ''
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

  const handleSubmit = async () => {
     
  useHotkeys('enter', (e) => { e.preventDefault(); handleSubmit(); }, { enableOnFormTags: ['input', 'select'] });

  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });
if (formData.amount <= 0) {
        toast.error('يرجى إدخال قيمة صحيحة');
        return;
     }
     setLoading(true);
     const shiftId = typeof window !== 'undefined' ? localStorage.getItem('current_shift_id') : null;
     const res = await createCashMovementAction({
        ...formData,
        type,
        shift_id: shiftId || undefined
     });
     
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
                    <option value="pos">نقطة البيع</option>
                    <option value="main_safe">خزينة المحل</option>
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
