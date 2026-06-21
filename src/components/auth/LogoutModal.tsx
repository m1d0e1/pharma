'use client';
import { useHotkeys } from 'react-hotkeys-hook';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, DollarSign, Clock, X, AlertTriangle } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { logoutLocalAction } from '@/app/actions-client/auth';
import { endShiftAction, getCurrentShiftAction } from '@/app/actions-client/shifts';

interface LogoutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function LogoutModal({ isOpen, onClose }: LogoutModalProps) {
  const router = useRouter();
  
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });
const [loading, setLoading] = useState(false);
  const [currentShift, setCurrentShift] = useState<any>(null);
  const [formData, setFormData] = useState({
    endingCashAmount: 0,
    closingNotes: '',
  });

  // Load current shift info when modal opens
  useEffect(() => {
    if (isOpen) {
      const fetchShift = async () => {
        const result = await getCurrentShiftAction();
        if (result.success && result.data) {
          setCurrentShift(result.data);
        }
      };
      fetchShift();
    }
  }, [isOpen]);

  const handleCloseShiftAndLogout = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // 1. End Shift locally
      const shiftResult = await endShiftAction(formData.endingCashAmount, formData.closingNotes);
      if (!shiftResult.success) {
        throw new Error(shiftResult.error || 'فشل إغلاق الوردية');
      }

      toast.success('تم إغلاق الوردية بنجاح');

      // 2. Logout locally
      await logoutLocalAction();
      
      // 3. Clear any leftovers
      localStorage.clear();
      
      toast.success('تم تسجيل الخروج بنجاح');
      onClose();
      
      // Force a full reload to clear all states and catch new auth status
      window.location.href = '/login';
    } catch (error: any) {
      console.error('Logout error:', error);
      toast.error(error.message || 'حدث خطأ أثناء تسجيل الخروج');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickLogout = async () => {
    setLoading(true);
    try {
      await logoutLocalAction();
      localStorage.clear();
      
      toast.success('تم تسجيل الخروج بنجاح');
      onClose();
      window.location.href = '/login';
    } catch (error) {
      toast.error('فشل تسجيل الخروج');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const hasOpenShift = !!currentShift;

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[200] p-4 animate-in fade-in duration-200" dir="rtl">
      <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl max-w-md w-full overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in slide-in-from-bottom-4 duration-300">
        
        {/* Header */}
        <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-red-50 dark:bg-red-900/20 rounded-2xl flex items-center justify-center">
              <LogOut className="w-6 h-6 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h2 className="text-xl font-black text-slate-900 dark:text-white">
                تسجيل الخروج
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 font-bold mt-0.5">
                {hasOpenShift ? 'يجب إغلاق الوردية أولاً' : 'هل أنت متأكد من رغبتك في الخروج؟'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center transition-colors"
          >
            <X className="w-5 h-5 text-slate-400" />
          </button>
        </div>

        <div className="p-8">
          {hasOpenShift ? (
            <form onSubmit={handleCloseShiftAndLogout} className="space-y-6">
              <div className="p-4 bg-amber-50 dark:bg-amber-900/10 rounded-2xl border border-amber-200 dark:border-amber-800 flex gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-black text-amber-800 dark:text-amber-200 leading-tight">وردية مفتوحة قيد التشغيل</p>
                  <p className="text-xs text-amber-700 dark:text-amber-300 mt-1 font-bold">يرجى تسجيل إجمالي النقدية الموجدة في الخزنة حالياً لإغلاق الوردية.</p>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-black text-slate-700 dark:text-slate-300 mr-2">إجمالي النقدية بالخزنة (ج.م)</label>
                <div className="relative">
                  <DollarSign className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    autoFocus
                    value={formData.endingCashAmount}
                    onChange={(e) => setFormData({ ...formData, endingCashAmount: parseFloat(e.target.value) || 0 })}
                    className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pr-12 pl-4 py-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-black text-lg"
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-black text-slate-700 dark:text-slate-300 mr-2">ملاحظات الإغلاق (اختياري)</label>
                <textarea
                  value={formData.closingNotes}
                  onChange={(e) => setFormData({ ...formData, closingNotes: e.target.value })}
                  rows={3}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-bold resize-none"
                  placeholder="أي ملاحظات بخصوص عجز أو زيادة أو أحداث..."
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-red-600 text-white py-4 rounded-2xl font-black text-lg hover:bg-red-700 transition-all shadow-xl shadow-red-500/20 transform active:scale-95 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    <span>جاري الإغلاق...</span>
                  </>
                ) : (
                  <>
                    <span>🔒</span>
                    <span>إغلاق الوردية وتسجيل الخروج</span>
                  </>
                )}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="p-6 text-center">
                <p className="text-slate-600 dark:text-slate-400 font-bold">ستفقد الجلسة الحالية وسيتم توجيهك لصفحة الدخول.</p>
              </div>
              
              <div className="flex flex-col gap-3">
                <button
                  onClick={handleQuickLogout}
                  disabled={loading}
                  className="w-full bg-red-600 text-white py-4 rounded-2xl font-black text-lg hover:bg-red-700 transition-all shadow-xl shadow-red-500/20 transform active:scale-95 disabled:opacity-50"
                >
                  {loading ? 'جاري الخروج...' : 'تأكيد تسجيل الخروج'}
                </button>

                <button
                  onClick={onClose}
                  className="w-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 py-4 rounded-2xl font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-all transform active:scale-95"
                >
                  إلغاء
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
