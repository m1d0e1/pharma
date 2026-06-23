'use client';

import React, { useState, useEffect } from 'react';
import { 
  DollarSign, ArrowLeftRight, UserCheck, 
  FileText, ShieldCheck, AlertTriangle,
  History, Landmark, Calculator, Printer
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getHandoverDetailsAction, processHandoverAction } from '@/app/actions-client/handover';
import { getBanksAction } from '@/app/actions-client/finance';
import { getStaffAction } from '@/app/actions-client/users';
import toast from 'react-hot-toast';

interface DrawerHandoverProps {
  shiftId: string;
  onClose?: () => void;
}

export default function DrawerHandoverClient({ shiftId, onClose }: DrawerHandoverProps) {
  const [details, setDetails] = useState<any>(null);
  const [banks, setBanks] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  const [form, setForm] = useState({
    transferAmount: 0,
    transferTargetId: '',
    transferTargetType: 'bank' as 'bank' | 'pos' | 'treasury',
    receiverUsername: '',
    receiverPassword: '',
    notes: ''
  });

  useEffect(() => {
    async function loadData() {
      const detailsRes = await getHandoverDetailsAction(shiftId);
      if (detailsRes.success) setDetails(detailsRes.data);

      const banksRes = await getBanksAction();
      if (banksRes.success) setBanks(banksRes.data || []);

      const staffRes = await getStaffAction();
      if (staffRes.success) setStaff(staffRes.data || []);

      setLoading(false);
    }
    loadData();
  }, [shiftId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.transferAmount <= 0) {
      toast.error('يرجى تحديد مبلغ التحويل');
      return;
    }
    if (!form.receiverUsername) {
      toast.error('يرجى تحديد المستلم');
      return;
    }

    setProcessing(true);
    const res = await processHandoverAction({
      shiftId,
      ...form,
      receiverPasswordHash: form.receiverPassword // In real app, hash it
    });

    if (res.success) {
      toast.success('تمت عملية تسليم الدرج بنجاح');
      if (onClose) {
        onClose();
      } else {
        window.location.href = '/shifts'; // Redirect to shifts page
      }
    } else {
      toast.error(res.error || 'فشل إتمام العملية');
    }
    setProcessing(false);
  };

  if (loading) return <div className="p-20 text-center animate-pulse font-black text-slate-400">جاري تحميل البيانات...</div>;

  return (
    <div className="max-w-4xl mx-auto space-y-8" dir="rtl">
      {/* Summary Header (Image 2 style) */}
      <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-xl">
        <div className="p-8 bg-slate-900 text-white flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-blue-600 rounded-2xl">
              <Calculator className="w-8 h-8" />
            </div>
            <div>
              <h2 className="text-2xl font-black">تسليم درج نقطة البيع</h2>
              <p className="text-white/40 text-xs font-bold">مراجعة وتحويل نقدية الوردية</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="text-left">
              <p className="text-[10px] font-black uppercase text-white/40 mb-1">الرصيد المتوقع في الدرج</p>
              <p className="text-4xl font-black text-emerald-400">
                {details?.expected_cash?.toLocaleString('en-US') ?? '0'} <span className="text-sm">ج.م</span>
              </p>
            </div>
            <button onClick={() => window.print()} className="p-3 bg-white/10 hover:bg-white/20 rounded-xl transition-all no-print" title="طباعة">
              <Printer className="w-6 h-6 text-white" />
            </button>
          </div>
        </div>

        <div className="p-10 grid grid-cols-1 lg:grid-cols-2 gap-10">
          {/* Details Table (Image 3 style) */}
          <div className="space-y-6">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <History className="w-4 h-4" /> تفاصيل حركات الوردية
            </h3>
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-3xl p-4 divide-y divide-slate-100 dark:divide-slate-700">
              <DetailRow label="الرصيد الإفتتاحي" value={details?.starting_cash} color="text-slate-500" />
              <DetailRow label="إجمالي مبيعات كاش" value={details?.cash_sales} color="text-emerald-600" isPositive />
              <DetailRow label="توريدات نقدية" value={details?.receipts} color="text-emerald-600" isPositive />
              <div className="h-2" />
              <DetailRow label="مرتجع مبيعات" value={details?.returns} color="text-rose-600" isNegative />
              <DetailRow label="مصروفات / صرف نقدية" value={details?.disbursements} color="text-rose-600" isNegative />
              <div className="pt-4 mt-4 border-t-2 border-dashed border-slate-200 dark:border-slate-600">
                <DetailRow label="صافي النقدية المتوقع" value={details?.expected_cash} color="text-blue-600 font-black text-xl" />
              </div>
            </div>

            <div className="p-6 bg-blue-50 dark:bg-blue-900/10 rounded-3xl border border-blue-100 dark:border-blue-800 flex items-start gap-4">
              <AlertTriangle className="w-6 h-6 text-blue-600 shrink-0" />
              <p className="text-xs font-bold text-blue-800 dark:text-blue-300 leading-relaxed">
                يتم حساب الرصيد المتوقع بناءً على كافة الحركات المسجلة خلال الوردية الحالية. يرجى التأكد من مطابقة المبلغ الفعلي في الدرج مع هذا الرقم قبل التسليم.
              </p>
            </div>
          </div>

          {/* Handover Form (Image 5 style) */}
          <form onSubmit={handleSubmit} className="space-y-8">
            <div className="space-y-6">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                <ArrowLeftRight className="w-4 h-4" /> بيانات التحويل والتسليم
              </h3>

              <div className="grid grid-cols-1 gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase mr-2">المبلغ المراد تحويله</label>
                  <div className="relative">
                    <DollarSign className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                    <input 
                      type="number" 
                      step="0.01"
                      className="w-full pr-12 pl-4 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-black text-xl outline-none focus:ring-2 ring-blue-500"
                      placeholder="0.00"
                      value={form.transferAmount}
                      onChange={(e) => setForm({...form, transferAmount: parseFloat(e.target.value) || 0})}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase mr-2">التحويل إلى</label>
                  <div className="flex gap-4">
                    <select 
                      className="w-1/3 px-4 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-black outline-none"
                      value={form.transferTargetType}
                      onChange={(e) => setForm({...form, transferTargetType: e.target.value as any})}
                    >
                      <option value="treasury">الخزينة</option>
                      <option value="bank">البنك</option>
                    </select>
                    {form.transferTargetType === 'bank' && (
                      <select 
                        className="flex-1 px-4 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-black outline-none"
                        value={form.transferTargetId}
                        onChange={(e) => setForm({...form, transferTargetId: e.target.value})}
                      >
                        <option value="">اختر البنك...</option>
                        {banks.map(b => <option key={b.id} value={b.id}>{b.name_ar}</option>)}
                      </select>
                    )}
                    {form.transferTargetType === 'treasury' && (
                      <div className="flex-1 px-4 py-4 bg-slate-100 dark:bg-slate-800/50 rounded-2xl text-slate-400 font-bold flex items-center gap-2">
                        <Landmark className="w-5 h-5" /> الخزينة الرئيسية
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-4 pt-6 border-t border-slate-100 dark:border-slate-800">
                  <div className="flex items-center gap-2 mb-2">
                    <UserCheck className="w-5 h-5 text-slate-400" />
                    <span className="text-[10px] font-black text-slate-400 uppercase">بيانات المستلم</span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <select 
                      className="w-full px-4 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-black outline-none"
                      value={form.receiverUsername}
                      onChange={(e) => setForm({...form, receiverUsername: e.target.value})}
                    >
                      <option value="">اختر المستلم...</option>
                      {staff.map(s => <option key={s.id} value={s.username}>{s.full_name}</option>)}
                    </select>
                    <input 
                      type="password" 
                      placeholder="كلمة مرور المستلم"
                      className="w-full px-4 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-black outline-none focus:ring-2 ring-blue-500"
                      value={form.receiverPassword}
                      onChange={(e) => setForm({...form, receiverPassword: e.target.value})}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase mr-2">ملاحظات</label>
                  <textarea 
                    className="w-full px-4 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none h-24"
                    placeholder="أضف أي ملاحظات هنا..."
                    value={form.notes}
                    onChange={(e) => setForm({...form, notes: e.target.value})}
                  />
                </div>
              </div>

              <button 
                type="submit"
                disabled={processing}
                className={cn(
                  "w-full py-6 bg-slate-900 text-white rounded-[24px] font-black text-xl flex items-center justify-center gap-4 transition-all shadow-2xl",
                  processing ? "opacity-50 cursor-not-allowed" : "hover:scale-[1.02] active:scale-[0.98] hover:bg-slate-800"
                )}
              >
                {processing ? 'جاري التنفيذ...' : (
                  <>
                    <ShieldCheck className="w-8 h-8" /> إتمام تسليم الدرج (S)
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value, color, isPositive, isNegative }: { label: string, value: number, color: string, isPositive?: boolean, isNegative?: boolean }) {
  return (
    <div className="flex justify-between items-center py-4">
      <span className="text-sm font-bold text-slate-400">{label}</span>
      <span className={cn("text-lg font-black", color)}>
        {isPositive && '+'}
        {isNegative && '-'}
        {value?.toLocaleString('en-US')}
      </span>
    </div>
  );
}
