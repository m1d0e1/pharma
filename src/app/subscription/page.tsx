'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'react-hot-toast';
import { CheckCircle, XCircle, Loader2, Key, Shield } from 'lucide-react';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

export default function SubscriptionActivationPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [subscriptionId, setSubscriptionId] = useState('');
  const [status, setStatus] = useState<'idle' | 'validating' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStatus('validating');

    try {
      // Simulate subscription validation (in real app, this would call an API)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // For demo purposes, accept any subscription ID
      if (subscriptionId.length < 5) {
        setStatus('error');
        setMessage('معرف الاشتراك غير صالح');
        toast.error('Invalid subscription ID');
        return;
      }

      // Store subscription ID
      localStorage.setItem('subscriptionId', subscriptionId);
      localStorage.setItem('subscriptionActivated', 'true');

      // Set cookie for middleware
      document.cookie = `subscriptionActivated=true; path=/; max-age=31536000; SameSite=Strict`;

      setStatus('success');
      setMessage('تم تفعيل الاشتراك بنجاح!');
      toast.success('Subscription activated successfully!');

      // Redirect to dashboard after 2 seconds
      setTimeout(() => {
        router.push('/dashboard');
      }, 2000);
    } catch (error) {
      console.error('Activation error:', error);
      setStatus('error');
      setMessage('فشل تفعيل الاشتراك');
      toast.error('Failed to activate subscription');
    } finally {
      setLoading(false);
    }
  };

  const handleSkip = () => {
    // Allow skipping for demo purposes
    localStorage.setItem('subscriptionActivated', 'true');
    toast('Subscription activation skipped');
    router.push('/dashboard');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-slate-900 dark:to-slate-800 p-4" dir="rtl">
      <div className="w-full max-w-lg">
        <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl overflow-hidden border border-slate-200 dark:border-slate-800">
          <div className="p-8">
            <div className="flex flex-col items-center mb-8">
              <div className="w-20 h-20 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl flex items-center justify-center shadow-lg mb-4">
                <Shield className="w-12 h-12 text-white" />
              </div>
              <h1 className="text-3xl font-bold text-slate-900 dark:text-white mb-2">
                تفعيل الاشتراك
              </h1>
              <p className="text-slate-500 dark:text-slate-400 text-center">
                قم بتفعيل اشتراكك للوصول إلى جميع ميزات النظام
              </p>
            </div>

            {status === 'idle' && (
              <form onSubmit={handleActivate} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    معرف الاشتراك
                  </label>
                  <div className="relative">
                    <Key className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                    <input
                      type="text"
                      value={subscriptionId}
                      onChange={(e) => setSubscriptionId(e.target.value)}
                      required
                      className="w-full pr-10 pl-4 py-3 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-blue-500 transition-all outline-none"
                      placeholder="أدخل معرف الاشتراك"
                    />
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                    يمكنك العثور على معرف الاشتراك في بريدك الإلكتروني أو في لوحة التحكم
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-bold py-3 rounded-lg shadow-lg hover:shadow-xl transform transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <Loader2 className="w-5 h-5 animate-spin" />
                      جاري التفعيل...
                    </span>
                  ) : (
                    'تفعيل الاشتراك'
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleSkip}
                  className="w-full bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-medium py-3 rounded-lg transition-all"
                >
                  تخطي للتجربة
                </button>
              </form>
            )}

            {status === 'validating' && (
              <div className="flex flex-col items-center justify-center py-12">
                <Loader2 className="w-16 h-16 text-blue-600 animate-spin mb-4" />
                <p className="text-lg font-medium text-slate-700 dark:text-slate-300">
                  جاري التحقق من الاشتراك...
                </p>
              </div>
            )}

            {status === 'success' && (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="w-20 h-20 bg-green-100 dark:bg-green-900/20 rounded-full flex items-center justify-center mb-4">
                  <CheckCircle className="w-12 h-12 text-green-600 dark:text-green-400" />
                </div>
                <h2 className="text-2xl font-bold text-green-600 dark:text-green-400 mb-2">
                  تم التفعيل بنجاح!
                </h2>
                <p className="text-slate-500 dark:text-slate-400 text-center">
                  {message}
                </p>
                <p className="text-sm text-slate-400 dark:text-slate-500 mt-4">
                  جاري تحويلك إلى لوحة التحكم...
                </p>
              </div>
            )}

            {status === 'error' && (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="w-20 h-20 bg-red-100 dark:bg-red-900/20 rounded-full flex items-center justify-center mb-4">
                  <XCircle className="w-12 h-12 text-red-600 dark:text-red-400" />
                </div>
                <h2 className="text-2xl font-bold text-red-600 dark:text-red-400 mb-2">
                  فشل التفعيل
                </h2>
                <p className="text-slate-500 dark:text-slate-400 text-center mb-6">
                  {message}
                </p>
                <button
                  onClick={() => setStatus('idle')}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-lg transition-all"
                >
                  المحاولة مرة أخرى
                </button>
              </div>
            )}
          </div>

          <div className="bg-slate-50 dark:bg-slate-800/50 p-4 border-t border-slate-200 dark:border-slate-800">
            <div className="flex items-start gap-3">
              <Shield className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-slate-600 dark:text-slate-400">
                <p className="font-medium mb-1">لماذا نحتاج إلى تفعيل الاشتراك؟</p>
                <p>
                  تفعيل الاشتراك يضمن حصولك على جميع الميزات والتحديثات، كما يتيح لنا تقديم الدعم الفني المتخصص لك.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
