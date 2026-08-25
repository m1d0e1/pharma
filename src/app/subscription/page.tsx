'use client';

import { useRouter } from 'next/navigation';
import { toast } from 'react-hot-toast';
import { ShieldAlert, WifiOff } from 'lucide-react';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export default function SubscriptionActivationPage() {
  const router = useRouter();

  const enableLocalMode = () => {
    localStorage.setItem('subscriptionMode', 'local');
    localStorage.setItem('subscriptionActivated', 'true');
    document.cookie = 'subscriptionActivated=true; path=/; max-age=31536000; SameSite=Strict';
    toast.success('تم تفعيل وضع العمل المحلي');
    router.push('/');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4" dir="rtl">
      <div className="w-full max-w-lg bg-slate-900 rounded-3xl border border-slate-800 p-8 text-center shadow-2xl">
        <div className="w-20 h-20 mx-auto mb-6 bg-amber-500/15 rounded-3xl flex items-center justify-center">
          <ShieldAlert className="w-10 h-10 text-amber-400" />
        </div>
        <h1 className="text-3xl font-black text-white mb-3">وضع التشغيل المحلي</h1>
        <p className="text-slate-300 font-bold leading-7 mb-4">
          التحقق التجاري من الاشتراك عبر الخادم غير متاح في هذا الإصدار.
        </p>
        <p className="text-sm text-slate-500 leading-6 mb-8">
          يمكنك متابعة استخدام بيانات الجهاز محلياً دون ادعاء وجود ترخيص تم التحقق منه.
        </p>
        <button
          type="button"
          onClick={enableLocalMode}
          className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white rounded-2xl font-black flex items-center justify-center gap-3 transition-colors"
        >
          <WifiOff className="w-5 h-5" /> بدء العمل المحلي
        </button>
      </div>
    </div>
  );
}
