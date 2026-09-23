'use client';

import { useState, useEffect, useRef } from 'react';
import { ShieldCheck, ShieldAlert, Zap, Loader2 } from 'lucide-react';
import { toast } from 'react-hot-toast';

// Simple server action mockup inside the component or I could create a real one.
// I'll assume we can update a config key in the local DB.
import { updateConfigAction, getConfigAction } from '@/app/actions-client/config';

export default function SubscriptionStatus() {
  const [status, setStatus] = useState<'activated' | 'expired' | 'none'>('none');
  const [loading, setLoading] = useState(true);
  const [isActivating, setIsActivating] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const activationRef = useRef(false);
  const statusRequestRef = useRef(0);

  useEffect(() => {
    void fetchStatus();
    return () => {
      statusRequestRef.current += 1;
    };
  }, []);

  const fetchStatus = async () => {
    const requestId = ++statusRequestRef.current;
    setLoading(true);
    setLoadError(false);
    try {
      const result = await getConfigAction('subscription_status');
      if (requestId !== statusRequestRef.current) return;
      if (result.success) {
        setStatus((result.value || 'none') as any);
      } else {
        setLoadError(true);
      }
    } catch {
      if (requestId === statusRequestRef.current) setLoadError(true);
    } finally {
      if (requestId === statusRequestRef.current) setLoading(false);
    }
  };

  const handleManualActivate = async () => {
    if (activationRef.current) return;
    activationRef.current = true;
    setIsActivating(true);
    try {
      const result = await updateConfigAction('subscription_status', 'activated');
      if (result.success) {
        toast.success('تم تفعيل وضع العمل المحلي');
        setStatus('activated');
        // Set the cookie too so middleware is happy
        document.cookie = 'subscriptionActivated=true; path=/; max-age=31536000';
      } else {
        toast.error('فشل تفعيل وضع العمل المحلي');
      }
    } catch {
      toast.error('فشل تفعيل وضع العمل المحلي');
    } finally {
      activationRef.current = false;
      setIsActivating(false);
    }
  };

  if (loading) return null;

  if (loadError) {
    return (
      <div className="card-glass text-center space-y-4">
        <ShieldAlert className="w-8 h-8 text-amber-500 mx-auto" />
        <p className="font-black text-slate-700 dark:text-slate-200">تعذر تحميل وضع التشغيل</p>
        <button
          type="button"
          onClick={() => void fetchStatus()}
          className="px-5 py-2.5 rounded-xl bg-amber-500 text-white font-black hover:bg-amber-600"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="card-glass relative overflow-hidden group">
      <div className={`absolute top-0 left-0 w-full h-1 bg-gradient-to-r ${status === 'activated' ? 'from-emerald-500 to-teal-600' : 'from-amber-500 to-orange-600'}`}></div>
      
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`p-3 rounded-2xl ${status === 'activated' ? 'bg-emerald-100 dark:bg-emerald-900/20 text-emerald-600' : 'bg-amber-100 dark:bg-amber-900/20 text-amber-600'}`}>
            {status === 'activated' ? <ShieldCheck className="w-6 h-6" /> : <ShieldAlert className="w-6 h-6" />}
          </div>
          <div>
            <h2 className="text-xl font-black">وضع التشغيل</h2>
            <p className="text-xs text-slate-500 font-bold mt-0.5">
              {status === 'activated' ? 'العمل المحلي مفعل' : 'العمل المحلي غير مفعل'}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {status === 'activated' ? (
          <div className="flex items-center gap-3 p-4 bg-emerald-50 dark:bg-emerald-900/10 rounded-2xl border border-emerald-100 dark:border-emerald-800/30">
            <Zap className="w-5 h-5 text-emerald-600 fill-current animate-pulse" />
            <span className="text-sm font-black text-emerald-800 dark:text-emerald-200">وضع العمل بدون اتصال مفعل (المنفذ)</span>
          </div>
        ) : (
          <div className="space-y-4">
             <p className="text-sm text-slate-600 dark:text-slate-400 font-medium leading-relaxed">
              يمكنك تفعيل وضع العمل المحلي دون ادعاء وجود ترخيص تم التحقق منه عبر الخادم.
            </p>
            <button
              onClick={handleManualActivate}
              disabled={isActivating}
              className="w-full bg-gradient-to-r from-amber-500 to-orange-600 text-white py-4 rounded-2xl font-black text-lg transition-all shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2 hover:opacity-90 transform active:scale-95 disabled:opacity-50"
            >
              {isActivating ? <Loader2 className="w-5 h-5 animate-spin" /> : 'تفعيل العمل المحلي'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
