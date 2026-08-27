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

  const [form, setForm] = useState({
    actualCash: 0,
    transferAmount: 0,
    transferTargetId: '',
    transferTargetType: 'treasury' as 'treasury' | 'next_shift' | 'bank',
    receiverUsername: '',
    receiverPassword: '',
    notes: ''
  });

  useEffect(() => {
    setShiftId(null);
    setDetails(null);
    setActiveUserDisplay('');
    setCreditSalesList([]);
    setShowCreditModal(false);
    setLoadingCredit(false);
    setLoading(true);
    setProcessing(false);
    setForm({
      actualCash: 0,
      transferAmount: 0,
      transferTargetId: '',
      transferTargetType: 'treasury',
      receiverUsername: '',
      receiverPassword: '',
      notes: ''
    });

    if (!isOpen) return;
    let cancelled = false;

    async function loadData() {
      setLoading(true);

      const { getClientSession } = await import('@/lib/auth/local');
      const sessionUser = await getClientSession();
      if (cancelled) return;
      const activeUserName = sessionUser?.full_name || sessionUser?.username || 'المستخدم الحالي';
      setActiveUserDisplay(activeUserName);
      setUserRole(sessionUser?.role || 'pharmacist');

      const shiftRes = await getCurrentShiftAction();
      if (cancelled) return;
      let activeShiftId = shiftRes.data?.id;
      if (!activeShiftId) {
        const openShiftRes = await getOpenShiftHandoverAction();
        if (cancelled) return;
        activeShiftId = openShiftRes.data?.id;
      }

      if (activeShiftId) {
        setShiftId(activeShiftId);
        const detailsRes = await getHandoverDetailsAction(activeShiftId);
        if (cancelled) return;
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
      if (cancelled) return;
      if (banksRes.success) setBanks(banksRes.data || []);

      const staffRes = await getStaffAction();
      if (cancelled) return;
      if (staffRes.success) {
        setStaff(staffRes.data || []);
        if (staffRes.data && staffRes.data.length > 0) {
          setForm(prev => ({ ...prev, receiverUsername: staffRes.data[0].username }));
        }
      }

      setLoading(false);
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleOpenCreditDetails = async () => {
    setShowCreditModal(true);
    const targetShiftId = shiftId || details?.id;
    setCreditSalesList([]);
    setLoadingCredit(true);
    if (!targetShiftId) {
      setLoadingCredit(false);
      toast.error('لا توجد وردية مفتوحة');
      return;
    }

    try {
      const res = await getShiftCreditSalesAction(targetShiftId);
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

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showCreditModal) {
          setShowCreditModal(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, showCreditModal]);

  if (!isOpen) return null;

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
      notes: form.notes,
      autoOpenNewShift: true
    });

    if (res.success) {
      toast.success(`تم تسليم الدرج وفتح الوردية الجديدة بنجاح (رصيد ${Number(res.startingCash ?? res.remainingCash ?? 0).toFixed(2)} ج.م)`);
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
              <span className="absolute -top-3 right-4 px-2 bg-slate-200 dark:bg-slate-900 font-bold text-xs text-slate-700 dark:text-slate-300">
                النقدية
              </span>

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
                      value={form.transferTargetType === 'bank' ? form.transferTargetId : (form.transferTargetType || 'treasury')}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === 'treasury') {
                          setForm({ ...form, transferTargetType: 'treasury', transferTargetId: '' });
                        } else if (val === 'next_shift') {
                          setForm({ ...form, transferTargetType: 'next_shift', transferTargetId: '' });
                        } else {
                          setForm({ ...form, transferTargetType: 'bank', transferTargetId: val });
                        }
                      }}
                      className="w-1/2 px-2 py-1.5 bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 rounded font-bold text-xs text-slate-900 dark:text-white"
                    >
                      <option value="treasury">الخزينة الرئيسية</option>
                      <option value="next_shift">الوردية التالية (ترحيل بالدرج)</option>
                      {banks.map(b => (
                        <option key={b.id} value={b.id}>بنك: {b.name_ar}</option>
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

            {/* Section 3: المستلم / مستخدم الوردية التالية */}
            <div className="border border-slate-400 dark:border-slate-700 rounded-xl p-4 bg-slate-100/80 dark:bg-slate-800/60 relative pt-3">
              <span className="absolute -top-3 right-4 px-2 bg-slate-200 dark:bg-slate-900 font-bold text-xs text-slate-700 dark:text-slate-300">
                المستلم / مستخدم الوردية التالية
              </span>

              <div className="space-y-2 text-xs font-bold">
                <div className="grid grid-cols-3 items-center gap-2">
                  <label className="col-span-1 text-slate-700 dark:text-slate-300">إسم المستلم</label>
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

      {/* Credit Details Breakdown Sub-Modal */}
      {showCreditModal && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-sm animate-in fade-in" dir="rtl">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[85vh]">
            <div className="p-4 bg-slate-100 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2 text-slate-800 dark:text-white font-black text-base">
                <Receipt className="w-5 h-5 text-blue-600" />
                <span>تفاصيل فواتير الآجل للوردية (#{shiftId ? shiftId.substring(0, 8) : '---'})</span>
              </div>
              <button 
                onClick={() => setShowCreditModal(false)}
                className="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-rose-500 hover:text-white transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1">
              {loadingCredit ? (
                <div className="py-12 text-center text-slate-500 font-bold animate-pulse">
                  جاري تحميل تفاصيل فواتير الآجل...
                </div>
              ) : creditSalesList.length === 0 ? (
                <div className="py-12 text-center text-slate-400 font-bold">
                  لا توجد مبيعات آجل مسجلة في هذه الوردية
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-2xl overflow-hidden">
                  <div className="grid grid-cols-12 bg-slate-50 dark:bg-slate-800/80 p-3 text-xs font-black text-slate-500">
                    <span className="col-span-2 text-center">رقم الفاتورة</span>
                    <span className="col-span-4">اسم العميل</span>
                    <span className="col-span-3 text-center">التاريخ والوقت</span>
                    <span className="col-span-3 text-left">المبلغ</span>
                  </div>
                  {creditSalesList.map((item) => (
                    <div key={item.id} className="grid grid-cols-12 p-3 text-xs font-bold items-center hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors">
                      <span className="col-span-2 text-center font-mono text-slate-600 dark:text-slate-400">
                        #{item.invoice_number || item.id}
                      </span>
                      <div className="col-span-4">
                        <span className="font-black text-slate-900 dark:text-slate-100 block truncate">
                          {item.patient_name || item.customer_name || 'عميل غير مسجل'}
                        </span>
                        {(item.patient_phone || item.customer_phone) && (
                          <span className="text-[10px] text-slate-400 font-mono block">
                            {item.patient_phone || item.customer_phone}
                          </span>
                        )}
                      </div>
                      <span className="col-span-3 text-center text-slate-500 text-[11px]">
                        {item.created_at ? format(new Date(item.created_at), 'HH:mm dd/MM') : '---'}
                      </span>
                      <span className="col-span-3 text-left font-mono font-black text-amber-600 dark:text-amber-400 text-sm">
                        {Number(item.credit_amount ?? item.total_amount ?? 0).toFixed(2)} ج.م
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-3 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-200 dark:border-slate-700 flex justify-between items-center shrink-0">
              <span className="font-black text-xs text-slate-600 dark:text-slate-400">
                إجمالي الآجل: {creditSalesList.reduce((sum, item) => sum + Number(item.total_amount || 0), 0).toFixed(2)} ج.م
              </span>
              <button 
                onClick={() => setShowCreditModal(false)}
                className="px-6 py-1.5 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold transition-all shadow"
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
