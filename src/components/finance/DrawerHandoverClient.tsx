'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  DollarSign, ArrowLeftRight, UserCheck, 
  FileText, ShieldCheck, AlertTriangle,
  History, Landmark, Calculator, Printer, Eye, Receipt, X, AlertCircle, ArrowRight
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getHandoverDetailsAction, processHandoverAction, getShiftCreditSalesAction } from '@/app/actions-client/handover';
import { getBanksAction } from '@/app/actions-client/finance';
import { getStaffAction } from '@/app/actions-client/users';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

interface DrawerHandoverProps {
  shiftId: string;
  onClose?: () => void;
}

export default function DrawerHandoverClient({ shiftId, onClose }: DrawerHandoverProps) {
  const [details, setDetails] = useState<any>(null);
  const [userRole, setUserRole] = useState<string>('pharmacist');
  const [banks, setBanks] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  // Credit details modal
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [creditSalesList, setCreditSalesList] = useState<any[]>([]);
  const [loadingCredit, setLoadingCredit] = useState(false);

  // Owner audit modal
  const [showOwnerAuditModal, setShowOwnerAuditModal] = useState(false);

  const [form, setForm] = useState({
    actualCash: 0,
    transferAmount: 0,
    transferTargetId: '',
    transferTargetType: 'treasury' as 'bank' | 'pos' | 'treasury',
    receiverUsername: '',
    receiverPassword: '',
    notes: ''
  });

  useEffect(() => {
    async function loadData() {
      const { getClientSession } = await import('@/lib/auth/local');
      const sessionUser = await getClientSession();
      setUserRole(sessionUser?.role || 'pharmacist');

      const detailsRes = await getHandoverDetailsAction(shiftId);
      if (detailsRes.success && detailsRes.data) {
        setDetails(detailsRes.data);
        setForm(prev => ({
          ...prev,
          actualCash: prev.actualCash || 0
        }));
      }

      const banksRes = await getBanksAction();
      if (banksRes.success) setBanks(banksRes.data || []);

      const staffRes = await getStaffAction();
      if (staffRes.success) {
        setStaff(staffRes.data || []);
        if (staffRes.data && staffRes.data.length > 0) {
          setForm(prev => ({ ...prev, receiverUsername: staffRes.data[0].username }));
        }
      }

      setLoading(false);
    }
    loadData();
  }, [shiftId]);

  const handleOpenCreditDetails = async () => {
    setShowCreditModal(true);
    const targetShiftId = shiftId || details?.id;
    setCreditSalesList([]);
    setLoadingCredit(true);
    try {
      const res = await getShiftCreditSalesAction(targetShiftId || undefined);
      if (res.success && res.data) {
        setCreditSalesList(res.data);
      } else {
        toast.error(res.error || 'فشل تحميل تفاصيل مبيعات الآجل');
      }
    } catch {
      setCreditSalesList([]);
      toast.error('فشل تحميل تفاصيل مبيعات الآجل');
    } finally {
      setLoadingCredit(false);
    }
  };

  const handleOpenOwnerAudit = () => {
    if (userRole !== 'owner' && userRole !== 'admin') {
      toast.error('عرض تفاصيل حسابات النظام والعجز/الزيادة متاح فقط لمالك الصيدلية');
      return;
    }
    setShowOwnerAuditModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.transferAmount < 0) {
      toast.error('مبلغ التحويل غير صالح');
      return;
    }
    if (form.transferAmount > form.actualCash) {
      toast.error('مبلغ التحويل أكبر من النقدية الفعلية في الدرج');
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
      receiverPasswordHash: form.receiverPassword
    });

    if (res.success) {
      toast.success('تم تسليم الدرج وإغلاق الوردية بنجاح');
      if (onClose) {
        onClose();
      } else {
        window.location.href = '/shifts';
      }
    } else {
      toast.error(res.error || 'فشل إتمام العملية');
    }
    setProcessing(false);
  };

  if (loading) return <div className="p-20 text-center animate-pulse font-black text-slate-400">جاري تحميل البيانات...</div>;

  return (
    <div className="max-w-4xl mx-auto space-y-8" dir="rtl">
      {/* Summary Header */}
      <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-xl">
        <div className="p-8 bg-slate-900 text-white flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div className="flex items-center gap-4">
            {!onClose && (
              <Link 
                href="/shifts" 
                className="p-3 bg-white/10 hover:bg-white/20 rounded-2xl text-white transition-all no-print flex items-center justify-center"
                title="العودة إلى إدارة الشفتات"
              >
                <ArrowRight className="w-5 h-5" />
              </Link>
            )}
            <div className="w-16 h-16 bg-blue-600/20 rounded-3xl flex items-center justify-center border border-blue-500/30">
              <Calculator className="w-8 h-8 text-blue-400" />
            </div>
            <div>
              <h2 className="text-2xl font-black">تسليم درج الوردية</h2>
              <p className="text-xs font-bold text-slate-400 mt-1">
                الموظف الحالي: {details?.user_name} | بداية الوردية: {details?.start_time ? new Date(details.start_time).toLocaleTimeString('ar-EG') : '---'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={handleOpenOwnerAudit}
              className="px-4 py-2.5 rounded-2xl bg-purple-600/30 hover:bg-purple-600/50 text-purple-200 border border-purple-400/30 font-black text-xs flex items-center gap-2 transition-all no-print"
              title="تقرير المطابقة والعجز/الزيادة (خاص بالمالك)"
            >
              <ShieldCheck className="w-4 h-4 text-purple-300" />
              <span>تفاصيل النظام والعجز/الزيادة (للمالك)</span>
            </button>
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
          {/* Details Table */}
          <div className="space-y-6">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
              <History className="w-4 h-4" /> تفاصيل حركات الوردية
            </h3>
            <div className="bg-slate-50 dark:bg-slate-800/50 rounded-3xl p-4 divide-y divide-slate-100 dark:divide-slate-700">
              <DetailRow label="الرصيد الإفتتاحي" value={details?.starting_cash} color="text-slate-500" />
              <DetailRow label="إجمالي مبيعات كاش" value={details?.cash_sales} color="text-emerald-600" isPositive />
              <DetailRow label="توريدات نقدية" value={details?.receipts} color="text-emerald-600" isPositive />
              
              {/* Credit Sales Row with details button */}
              <div className="flex justify-between items-center py-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-slate-400">مبيعات آجل</span>
                  <button 
                    type="button"
                    onClick={handleOpenCreditDetails}
                    className="px-2 py-0.5 rounded bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-[10px] font-bold flex items-center gap-1 transition-colors"
                    title="أين ذهب الآجل؟"
                  >
                    <Eye className="w-3 h-3" />
                    <span>تفاصيل</span>
                  </button>
                </div>
                <span className="text-lg font-black text-amber-600">
                  {details?.credit_sales?.toLocaleString('en-US') ?? '0'}
                </span>
              </div>

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

          {/* Handover Form */}
          <form onSubmit={handleSubmit} className="space-y-8">
            <div className="space-y-6">
              <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                <ArrowLeftRight className="w-4 h-4" /> بيانات التحويل والتسليم
              </h3>

              <div className="grid grid-cols-1 gap-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase mr-2">النقدية الفعلية بالدرج (العد الفعلي)</label>
                  <div className="relative">
                    <DollarSign className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                    <input 
                      type="number" 
                      step="0.01" 
                      className="w-full pr-12 pl-4 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-black text-xl outline-none focus:ring-2 ring-blue-500 text-slate-900 dark:text-white"
                      placeholder="0.00"
                      value={form.actualCash}
                      onChange={(e) => setForm({...form, actualCash: parseFloat(e.target.value) || 0})}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase mr-2">المبلغ المراد تحويله</label>
                  <div className="relative">
                    <DollarSign className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                    <input 
                      type="number" 
                      step="0.01" 
                      className="w-full pr-12 pl-4 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-black text-xl outline-none focus:ring-2 ring-blue-500 text-slate-900 dark:text-white"
                      placeholder="0.00"
                      value={form.transferAmount}
                      onChange={(e) => setForm({...form, transferAmount: parseFloat(e.target.value) || 0})}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase mr-2">الجهة المحول إليها</label>
                    <select 
                      className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold text-sm outline-none focus:ring-2 ring-blue-500"
                      value={form.transferTargetType}
                      onChange={(e) => setForm({...form, transferTargetType: e.target.value as any})}
                    >
                      <option value="treasury">الخزينة الرئيسية</option>
                      <option value="bank">حساب بنكي</option>
                    </select>
                  </div>

                  {form.transferTargetType === 'bank' && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase mr-2">اختر البنك</label>
                      <select 
                        className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold text-sm outline-none focus:ring-2 ring-blue-500"
                        value={form.transferTargetId}
                        onChange={(e) => setForm({...form, transferTargetId: e.target.value})}
                      >
                        <option value="">-- اختر البنك --</option>
                        {banks.map(b => (
                          <option key={b.id} value={b.id}>{b.name_ar}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase mr-2">المستلم</label>
                    <select 
                      className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold text-sm outline-none focus:ring-2 ring-blue-500"
                      value={form.receiverUsername}
                      onChange={(e) => setForm({...form, receiverUsername: e.target.value})}
                    >
                      {staff.map(s => (
                        <option key={s.id} value={s.username}>{s.full_name || s.username}</option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase mr-2">كلمة مرور المستلم</label>
                    <input 
                      type="password" 
                      className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold text-sm outline-none focus:ring-2 ring-blue-500"
                      placeholder="••••••••"
                      value={form.receiverPassword}
                      onChange={(e) => setForm({...form, receiverPassword: e.target.value})}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black text-slate-400 uppercase mr-2">ملاحظات التحويل</label>
                  <textarea 
                    rows={2}
                    className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold text-sm outline-none focus:ring-2 ring-blue-500 resize-none"
                    placeholder="أي ملاحظات إضافية بخصوص التحويل أو العجز..."
                    value={form.notes}
                    onChange={(e) => setForm({...form, notes: e.target.value})}
                  />
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
              <button 
                type="submit"
                disabled={processing}
                className={cn(
                  "w-full py-5 bg-slate-900 text-white rounded-3xl font-black text-lg shadow-xl flex items-center justify-center gap-3 transition-all",
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

      {/* Credit Sales Details Sub-Modal */}
      {showCreditModal && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm animate-in fade-in" dir="rtl">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[85vh]">
            
            {/* Header */}
            <div className="p-5 bg-gradient-to-r from-blue-900 via-indigo-900 to-slate-900 text-white flex justify-between items-center shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-blue-500/20 flex items-center justify-center border border-blue-400/30">
                  <Receipt className="w-5 h-5 text-blue-300" />
                </div>
                <div>
                  <h3 className="font-black text-base">تفاصيل مبيعات الآجل للوردية</h3>
                  <p className="text-xs text-blue-200 font-bold">
                    إجمالي الآجل: {(details?.credit_sales || 0).toLocaleString('ar-EG')} ج.م
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setShowCreditModal(false)}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
              >
                <X className="w-5 h-5 text-white" />
              </button>
            </div>

            {/* Content Table */}
            <div className="p-6 overflow-y-auto flex-1 divide-y divide-slate-100 dark:divide-slate-800">
              {loadingCredit ? (
                <div className="py-16 text-center text-slate-400 font-bold animate-pulse">
                  جاري تحميل فواتير الآجل...
                </div>
              ) : creditSalesList.length === 0 ? (
                <div className="py-16 text-center text-slate-400 space-y-2">
                  <AlertCircle className="w-12 h-12 mx-auto text-slate-300 dark:text-slate-600" />
                  <p className="font-black text-base text-slate-600 dark:text-slate-300">لا توجد مبيعات آجل مسجلة في هذه الوردية</p>
                </div>
              ) : (
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="text-slate-400 font-black border-b border-slate-100 dark:border-slate-800 pb-2">
                      <th className="pb-3 px-2">الفاتورة</th>
                      <th className="pb-3 px-2">العميل / المريض</th>
                      <th className="pb-3 px-2">الوقت</th>
                      <th className="pb-3 px-2 text-center">المبلغ الآجل</th>
                      <th className="pb-3 px-2">ملاحظات</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-medium">
                    {creditSalesList.map((inv) => (
                      <tr key={inv.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors">
                        <td className="py-3 px-2 font-mono font-bold text-blue-600 dark:text-blue-400">
                          #{inv.invoice_number || inv.id.substring(0, 8)}
                        </td>
                        <td className="py-3 px-2">
                          <div className="font-bold text-slate-900 dark:text-white">{inv.patient_name}</div>
                          {inv.patient_phone && (
                            <div className="text-[10px] text-slate-400 font-mono">{inv.patient_phone}</div>
                          )}
                        </td>
                        <td className="py-3 px-2 text-slate-500 font-mono dir-ltr text-right">
                          {inv.created_at ? format(new Date(inv.created_at), 'HH:mm - dd/MM') : '---'}
                        </td>
                        <td className="py-3 px-2 text-center font-black text-emerald-600 dark:text-emerald-400">
                          {Number(inv.credit_amount ?? inv.total_amount ?? 0).toLocaleString('ar-EG')} ج.م
                        </td>
                        <td className="py-3 px-2 text-slate-400 max-w-[150px] truncate text-[11px]">
                          {inv.notes || '---'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex justify-between items-center shrink-0">
              <span className="text-xs font-bold text-slate-500">
                عدد الفواتير: {creditSalesList.length}
              </span>
              <button
                type="button"
                onClick={() => setShowCreditModal(false)}
                className="px-6 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold transition-all shadow"
              >
                إغلاق
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Owner Audit & Discrepancy Sub-Modal */}
      {showOwnerAuditModal && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-sm animate-in fade-in" dir="rtl">
          <div className="w-full max-w-xl bg-white dark:bg-slate-900 rounded-3xl shadow-2xl border border-purple-200 dark:border-purple-900/50 overflow-hidden flex flex-col max-h-[90vh]">
            
            {/* Header */}
            <div className="p-5 bg-gradient-to-r from-purple-900 via-indigo-900 to-slate-900 text-white flex justify-between items-center shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-purple-500/20 flex items-center justify-center border border-purple-400/30">
                  <ShieldCheck className="w-6 h-6 text-purple-300" />
                </div>
                <div>
                  <h3 className="font-black text-base flex items-center gap-2">
                    <span>تقرير مطابقة الحسابات والعجز / الزيادة</span>
                    <span className="text-[10px] bg-purple-500/30 border border-purple-400/40 px-2 py-0.5 rounded-full font-bold">خاص بالمالك</span>
                  </h3>
                  <p className="text-xs text-purple-200 font-bold">
                    الوردية: #{shiftId ? shiftId.substring(0, 8) : '---'} | الموظف: {details?.user_name}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setShowOwnerAuditModal(false)}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
              >
                <X className="w-5 h-5 text-white" />
              </button>
            </div>

            {/* Audit Breakdown List */}
            <div className="p-6 overflow-y-auto flex-1 space-y-5">
              
              {/* Discrepancy Status Hero Banner */}
              {(() => {
                const exp = details?.expected_cash || 0;
                const act = form.actualCash || 0;
                const diff = act - exp;
                const isExact = Math.abs(diff) < 0.01;

                return (
                  <div className={`p-5 rounded-2xl border flex items-center justify-between gap-4 ${
                    isExact 
                      ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                      : diff > 0
                        ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-300'
                        : 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300'
                  }`}>
                    <div>
                      <p className="text-xs font-bold uppercase tracking-wider opacity-80">حالة المطابقة المالية</p>
                      <p className="text-lg font-black mt-0.5">
                        {isExact 
                          ? 'الدرج مطابق تماماً للحسابات النظامية'
                          : diff > 0
                            ? `يوجد زيادة في الدرج بمقدار +${diff.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م`
                            : `يوجد عجز في الدرج بمقدار -${Math.abs(diff).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م`
                        }
                      </p>
                    </div>
                    <div className="text-left font-mono font-black text-2xl">
                      {diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)} <span className="text-xs font-sans">ج.م</span>
                    </div>
                  </div>
                );
              })()}

              {/* Detailed Breakdown Grid */}
              <div className="bg-slate-50 dark:bg-slate-800/60 rounded-2xl p-4 divide-y divide-slate-200/60 dark:divide-slate-700/60 text-xs font-bold">
                <div className="flex justify-between items-center py-2.5">
                  <span className="text-slate-600 dark:text-slate-400">💵 الرصيد الإفتتاحي للوردية</span>
                  <span className="font-mono text-slate-800 dark:text-slate-200 font-black">{(details?.starting_cash || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
                </div>

                <div className="flex justify-between items-center py-2.5">
                  <span className="text-slate-600 dark:text-slate-400">📈 إجمالي مبيعات نقدي (كاش) (+)</span>
                  <span className="font-mono text-emerald-600 dark:text-emerald-400 font-black">+{(details?.cash_sales || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
                </div>

                <div className="flex justify-between items-center py-2.5">
                  <span className="text-slate-600 dark:text-slate-400">💳 مبيعات البطاقات (فيزا / دفع إلكتروني)</span>
                  <span className="font-mono text-indigo-600 dark:text-indigo-400 font-black">{(details?.visa_sales || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
                </div>

                <div className="flex justify-between items-center py-2.5">
                  <span className="text-slate-600 dark:text-slate-400">📑 مبيعات الآجل (حسابات عملاء)</span>
                  <span className="font-mono text-amber-600 dark:text-amber-400 font-black">{(details?.credit_sales || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
                </div>

                <div className="flex justify-between items-center py-2.5">
                  <span className="text-slate-600 dark:text-slate-400">📥 إيداعات وتوريدات نقدية (+)</span>
                  <span className="font-mono text-emerald-600 dark:text-emerald-400 font-black">+{(details?.receipts || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
                </div>

                <div className="flex justify-between items-center py-2.5">
                  <span className="text-slate-600 dark:text-slate-400">📤 مسحوبات ومصروفات نقدية (-)</span>
                  <span className="font-mono text-rose-600 dark:text-rose-400 font-black">-{(details?.disbursements || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
                </div>

                <div className="flex justify-between items-center py-2.5">
                  <span className="text-slate-600 dark:text-slate-400">🔄 مرتجعات مبيعات نقدية مستردة (-)</span>
                  <span className="font-mono text-rose-600 dark:text-rose-400 font-black">-{(details?.returns || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
                </div>

                <div className="flex justify-between items-center py-3 bg-slate-200/50 dark:bg-slate-700/50 -mx-4 px-4 rounded-xl mt-2 text-sm">
                  <span className="font-black text-slate-900 dark:text-white">🧮 النقدية المتوقعة دفترياً بالدرج</span>
                  <span className="font-mono text-blue-600 dark:text-blue-400 font-black text-base">{(details?.expected_cash || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
                </div>

                <div className="flex justify-between items-center py-3 bg-purple-50/50 dark:bg-purple-900/20 -mx-4 px-4 rounded-xl mt-2 text-sm">
                  <span className="font-black text-purple-900 dark:text-purple-200">💰 النقدية الفعلية المدخلة من الموظف</span>
                  <span className="font-mono text-purple-700 dark:text-purple-300 font-black text-base">{(form.actualCash || 0).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
                </div>
              </div>

            </div>

            {/* Footer */}
            <div className="p-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex justify-end items-center shrink-0">
              <button
                type="button"
                onClick={() => setShowOwnerAuditModal(false)}
                className="px-6 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold transition-all shadow"
              >
                إغلاق التقرير
              </button>
            </div>

          </div>
        </div>
      )}

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
