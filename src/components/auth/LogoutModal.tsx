'use client';
import { useHotkeys } from 'react-hotkeys-hook';

import { useState } from 'react';
import { LogOut, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { logoutLocalAction } from '@/app/actions-client/auth';

interface LogoutModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function LogoutModal({ isOpen, onClose }: LogoutModalProps) {
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });
  const [loading, setLoading] = useState(false);

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
                يمكنك الدخول بمستخدم آخر ومتابعة العمل فوراً
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
        </div>
      </div>
    </div>
  );
}
