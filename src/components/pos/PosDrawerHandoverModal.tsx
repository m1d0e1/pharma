'use client';

import React, { useState, useEffect } from 'react';
import { X, Save, ArrowLeftRight, Lock, User, AlertCircle, ShieldCheck, Eye, Receipt, Phone, UserCheck, Calendar } from 'lucide-react';
import { getHandoverDetailsAction, processHandoverAction, getOpenShiftHandoverAction, getShiftCreditSalesAction } from '@/app/actions-client/handover';
import { getCurrentShiftAction } from '@/app/actions-client/shifts';
import { getBanksAction } from '@/app/actions-client/finance';
import { getStaffAction } from '@/app/actions-client/users';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

interface PosDrawerHandoverModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function PosDrawerHandoverModal({ isOpen, onClose }: PosDrawerHandoverModalProps) {
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [details, setDetails] = useState<any>(null);
  const [activeUserDisplay, setActiveUserDisplay] = useState<string>('');
  const [userRole, setUserRole] = useState<string>('pharmacist');
  const [banks, setBanks] = useState<any[]>([]);
  const [staff, setStaff] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  // Credit breakdown popup state
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [creditSalesList, setCreditSalesList] = useState<any[]>([]);
  const [loadingCredit, setLoadingCredit] = useState(false);

  // Owner Audit details popup state
  const [showOwnerAuditModal, setShowOwnerAuditModal] = useState(false);

  const [form, setForm] = useState({
    actualCash: 0,
    transferAmount: 0,
    transferTargetId: '',
    transferTargetType: 'treasury' as 'treasury' | 'bank',
    receiverUsername: '',
    receiverPassword: '',
    notes: ''
  });

  useEffect(() => {
    if (!isOpen) return;

    async function loadData() {
      setLoading(true);

      const { getClientSession } = await import('@/lib/auth/local');
      const sessionUser = await getClientSession();
      const activeUserName = sessionUser?.full_name || sessionUser?.username || 'المستخدم الحالي';
      setActiveUserDisplay(activeUserName);
      setUserRole(sessionUser?.role || 'pharmacist');

      const shiftRes = await getCurrentShiftAction();
      let activeShiftId = shiftRes.data?.id;
      if (!activeShiftId) {
        const openShiftRes = await getOpenShiftHandoverAction();
        activeShiftId = openShiftRes.data?.id;
      }

      if (activeShiftId) {
        setShiftId(activeShiftId);
        const detailsRes = await getHandoverDetailsAction(activeShiftId);
        if (detailsRes.success && detailsRes.data) {
          setDetails({
            ...detailsRes.data,
            user_name: activeUserName
          });
          setForm(prev => ({
            ...prev,
            actualCash: prev.actualCash || 0
          }));
        }
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
  }, [isOpen]);

  const handleOpenCreditDetails = async () => {
    setShowCreditModal(true);
    const targetShiftId = shiftId || details?.id;
    setLoadingCredit(true);
    const res = await getShiftCreditSalesAction(targetShiftId || undefined);
    if (res.success && res.data) {
      setCreditSalesList(res.data);
    }
    setLoadingCredit(false);
  };

  const handleOpenOwnerAudit = () => {
    if (userRole !== 'owner' && userRole !== 'admin') {
      toast.error('عرض تفاصيل حسابات النظام والعجز/الزيادة متاح فقط لمالك الصيدلية');
      return;
    }
    setShowOwnerAuditModal(true);
  };

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showCreditModal) {
          setShowCreditModal(false);
        } else if (showOwnerAuditModal) {
          setShowOwnerAuditModal(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, showCreditModal, showOwnerAuditModal]);

  if (!isOpen) return null;

  const expectedCash = details?.expected_cash || 0;
  const discrepancy = (form.actualCash || 0) - expectedCash;
  const remainingCash = (form.actualCash || 0) - (form.transferAmount || 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shiftId) {
      toast.error('لا توجد وردية مفتوحة');
      return;
    }
    if (form.transferAmount < 0) {
      toast.error('مبلغ التحويل يجب أن يكون أكبر من أو يساوي 0');
      return;
    }
    if (form.transferAmount > form.actualCash) {
      toast.error('مبلغ التحويل أكبر من النقدية الفعلية في الدرج');
      return;
    }
    if (!form.receiverUsername) {
      toast.error('يرجى اختيار المستلم');
      return;
    }

    setProcessing(true);
    const res = await processHandoverAction({
      shiftId,
      actualCash: form.actualCash,
      transferAmount: form.transferAmount,
      transferTargetId: form.transferTargetId,
      transferTargetType: form.transferTargetType,
      receiverUsername: form.receiverUsername,
      receiverPasswordHash: form.receiverPassword,
      notes: form.notes
    });

    if (res.success) {
      toast.success('تم تسليم الدرج وإغلاق الوردية بنجاح');
      onClose();
    } else {
      toast.error(res.error || 'فشل تسليم الدرج');
    }
    setProcessing(false);
  };

  const formattedStartTime = details?.start_time
    ? format(new Date(details.start_time), 'HH:mm dd/MM/yyyy')
    : format(new Date(), 'HH:mm dd/MM/yyyy');

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in" dir="rtl">
      <div className="w-full max-w-lg bg-slate-200 dark:bg-slate-900 text-slate-900 dark:text-white rounded-2xl shadow-2xl border-2 border-slate-400 dark:border-slate-700 overflow-hidden font-sans">
        
        {/* Title Bar */}
        <div className="bg-gradient-to-r from-blue-900 via-blue-800 to-blue-950 text-white px-4 py-2 flex justify-between items-center select-none">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="w-4 h-4 text-blue-200" />
            <span className="font-bold text-sm">تسليم درج</span>
          </div>
          <button 
            onClick={onClose} 
            className="w-6 h-6 rounded bg-slate-700/50 hover:bg-rose-600 flex items-center justify-center text-xs transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        {loading ? (
          <div className="p-12 text-center font-bold text-slate-600 dark:text-slate-400 animate-pulse">
            جاري تحميل بيانات الوردية والدرج...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            
            {/* Header Title inside form */}
            <div className="text-center pb-2">
              <h2 className="text-2xl font-black text-slate-800 dark:text-slate-100 tracking-tight">
                تسليم درج نقطة البيع
              </h2>
            </div>

            {/* Section 1: المستخدم الحالي */}
            <div className="border border-slate-400 dark:border-slate-700 rounded-xl p-4 bg-slate-100/80 dark:bg-slate-800/60 relative pt-3">
              <span className="absolute -top-3 right-4 px-2 bg-slate-200 dark:bg-slate-900 font-bold text-xs text-slate-700 dark:text-slate-300">
                المستخدم الحالي
              </span>
              
              <div className="space-y-2 text-xs font-bold">
                <div className="grid grid-cols-3 items-center gap-2">
                  <label className="col-span-1 text-slate-700 dark:text-slate-300">المستخدم الحالي</label>
                  <input 
                    type="text" 
                    readOnly 
                    value={activeUserDisplay || details?.user_name || 'المستخدم الحالي'} 
                    className="col-span-2 px-3 py-1.5 bg-amber-50 dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-black text-red-600 dark:text-red-400 text-center uppercase"
                  />
                </div>

                <div className="grid grid-cols-3 items-center gap-2">
                  <label className="col-span-1 text-slate-700 dark:text-slate-300">الرصيد الإفتتاحي</label>
                  <input 
                    type="text" 
                    readOnly 
                    value={(details?.starting_cash || 0).toFixed(2)} 
                    className="col-span-2 px-3 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-black text-red-600 dark:text-red-400 text-center"
                  />
                </div>

                <div className="grid grid-cols-3 items-center gap-2">
                  <label className="col-span-1 text-slate-700 dark:text-slate-300">بداية الفترة</label>
                  <input 
                    type="text" 
                    readOnly 
                    value={formattedStartTime} 
                    className="col-span-2 px-3 py-1.5 bg-blue-50 dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-black text-blue-800 dark:text-blue-300 text-center dir-ltr"
                  />
                </div>

                <div className="grid grid-cols-3 items-center gap-2">
                  <div className="col-span-1 flex items-center justify-between">
                    <label className="text-slate-700 dark:text-slate-300">أجل</label>
                    <button 
                      type="button"
                      onClick={handleOpenCreditDetails}
                      className="p-1 rounded bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/40 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 transition-all flex items-center gap-1 text-[10px] font-bold"
                      title="عرض تفاصيل فواتير الآجل والعملاء"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>تفاصيل</span>
                    </button>
                  </div>
                  <input 
                    type="text" 
                    readOnly 
                    value={(details?.credit_sales || 0).toFixed(2)} 
                    className="col-span-2 px-3 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-black text-slate-900 dark:text-white text-center"
                  />
                </div>
              </div>
            </div>

            {/* Section 2: النقدية */}
            <div className="border border-slate-400 dark:border-slate-700 rounded-xl p-4 bg-slate-100/80 dark:bg-slate-800/60 relative pt-3">
              <div className="flex justify-between items-center -mt-6 mb-2">
                <span className="px-2 bg-slate-200 dark:bg-slate-900 font-bold text-xs text-slate-700 dark:text-slate-300 rounded">
                  النقدية
                </span>
                <button
                  type="button"
                  onClick={handleOpenOwnerAudit}
                  className="px-2 py-0.5 rounded bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 text-[10px] font-bold flex items-center gap-1 transition-all border border-purple-200 dark:border-purple-800"
                  title="عرض تفاصيل حسابات النظام والعجز/الزيادة (خاص بالمالك)"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-purple-600" />
                  <span>تفاصيل النظام والعجز/الزيادة (للمالك)</span>
                </button>
              </div>

              <div className="space-y-2 text-xs font-bold">
                <div className="grid grid-cols-3 items-center gap-2">
                  <label className="col-span-1 text-slate-700 dark:text-slate-300">النقدية الفعلية بالدرج</label>
                  <input 
                    type="number" 
                    step="0.01" 
                    min="0"
                    value={form.actualCash} 
                    onChange={(e) => setForm({ ...form, actualCash: parseFloat(e.target.value) || 0 })}
                    placeholder="أدخل النقدية الفعلية..."
                    className="col-span-2 px-3 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-black text-slate-900 dark:text-white text-center focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>

                <div className="grid grid-cols-3 items-center gap-2">
                  <label className="col-span-1 text-slate-700 dark:text-slate-300">تحويل مبلغ</label>
                  <div className="col-span-2 flex items-center gap-2">
                    <input 
                      type="number" 
                      step="0.01" 
                      value={form.transferAmount} 
                      onChange={(e) => setForm({ ...form, transferAmount: parseFloat(e.target.value) || 0 })}
                      className="w-1/2 px-3 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-black text-slate-900 dark:text-white text-center"
                    />
                    <span className="text-slate-600 dark:text-slate-400 font-bold">إلى</span>
                    <select 
                      value={form.transferTargetType === 'bank' ? form.transferTargetId : 'treasury'}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === 'treasury') {
                          setForm({ ...form, transferTargetType: 'treasury', transferTargetId: '' });
                        } else {
                          setForm({ ...form, transferTargetType: 'bank', transferTargetId: val });
                        }
                      }}
                      className="w-1/2 px-2 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-bold text-xs text-slate-900 dark:text-white"
                    >
                      <option value="treasury">الخزينة الرئيسية</option>
                      {banks.map(b => (
                        <option key={b.id} value={b.id}>{b.name_ar}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-3 items-center gap-2">
                  <label className="col-span-1 text-slate-700 dark:text-slate-300">الباقي بالدرج</label>
                  <input 
                    type="text" 
                    readOnly 
                    value={remainingCash.toFixed(2)} 
                    className="col-span-2 px-3 py-1.5 bg-amber-50 dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-black text-emerald-700 dark:text-emerald-400 text-center"
                  />
                </div>
              </div>
            </div>

            {/* Section 3: المسلم */}
            <div className="border border-slate-400 dark:border-slate-700 rounded-xl p-4 bg-slate-100/80 dark:bg-slate-800/60 relative pt-3">
              <span className="absolute -top-3 right-4 px-2 bg-slate-200 dark:bg-slate-900 font-bold text-xs text-slate-700 dark:text-slate-300">
                المسلم
              </span>

              <div className="space-y-2 text-xs font-bold">
                <div className="grid grid-cols-3 items-center gap-2">
                  <label className="col-span-1 text-slate-700 dark:text-slate-300">إسم المستخدم</label>
                  <select 
                    value={form.receiverUsername}
                    onChange={(e) => setForm({ ...form, receiverUsername: e.target.value })}
                    className="col-span-2 px-3 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-black text-red-600 dark:text-red-400 text-center uppercase"
                  >
                    {staff.map(s => (
                      <option key={s.id} value={s.username}>{s.full_name || s.username}</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-3 items-center gap-2">
                  <label className="col-span-1 text-slate-700 dark:text-slate-300">كلمة المرور</label>
                  <input 
                    type="password" 
                    value={form.receiverPassword} 
                    onChange={(e) => setForm({ ...form, receiverPassword: e.target.value })}
                    placeholder="***" 
                    className="col-span-2 px-3 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-black text-slate-900 dark:text-white text-center"
                  />
                </div>
              </div>
            </div>

            {/* Section 4: ملاحظات */}
            <div className="grid grid-cols-4 items-center gap-2 text-xs font-bold">
              <label className="col-span-1 text-slate-700 dark:text-slate-300">ملاحظات</label>
              <input 
                type="text" 
                value={form.notes} 
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="col-span-3 px-3 py-2 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-bold text-slate-900 dark:text-white"
              />
            </div>

            {/* Bottom Action Buttons */}
            <div className="flex justify-center gap-6 pt-3">
              <button 
                type="submit" 
                disabled={processing}
                className="px-8 py-2 bg-slate-300 hover:bg-slate-400 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-900 dark:text-white rounded border border-slate-500 font-black text-sm shadow transition-all active:translate-y-0.5"
              >
                {processing ? 'جاري الحفظ...' : 'حفظ S'}
              </button>
              <button 
                type="button" 
                onClick={onClose} 
                className="px-8 py-2 bg-slate-300 hover:bg-slate-400 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-900 dark:text-white rounded border border-slate-500 font-black text-sm shadow transition-all active:translate-y-0.5"
              >
                إغلاق C
              </button>
            </div>

          </form>
        )}
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
                          {Number(inv.credit_amount || inv.total_amount || 0).toLocaleString('ar-EG')} ج.م
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
                    الوردية: #{shiftId ? shiftId.substring(0, 8) : '---'} | الموظف: {activeUserDisplay || details?.user_name}
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
              <div className={`p-5 rounded-2xl border flex items-center justify-between gap-4 ${
                Math.abs(discrepancy) < 0.01 
                  ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                  : discrepancy > 0
                    ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-300'
                    : 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300'
              }`}>
                <div>
                  <p className="text-xs font-bold uppercase tracking-wider opacity-80">حالة المطابقة المالية</p>
                  <p className="text-lg font-black mt-0.5">
                    {Math.abs(discrepancy) < 0.01 
                      ? 'الدرج مطابق تماماً للحسابات النظامية'
                      : discrepancy > 0
                        ? `يوجد زيادة في الدرج بمقدار +${discrepancy.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م`
                        : `يوجد عجز في الدرج بمقدار -${Math.abs(discrepancy).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م`
                    }
                  </p>
                </div>
                <div className="text-left font-mono font-black text-2xl">
                  {discrepancy > 0 ? `+${discrepancy.toFixed(2)}` : discrepancy.toFixed(2)} <span className="text-xs font-sans">ج.م</span>
                </div>
              </div>

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
                  <span className="font-mono text-blue-600 dark:text-blue-400 font-black text-base">{expectedCash.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
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
