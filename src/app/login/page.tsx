'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'react-hot-toast';
import { Shield, Lock, User, Loader2, Globe } from 'lucide-react';
import { enrollInitialOwnerAction, getOwnerEnrollmentStatusAction, loginLocalAction } from '@/app/actions-client/auth';
import { syncFromCloud } from '@/lib/sync/universal';
import { isTauri } from '@/lib/env';

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const loginSubmissionRef = useRef(false);
  const initialSyncRef = useRef(false);
  const enrollmentSubmissionRef = useRef(false);
  const [enrollmentPending, setEnrollmentPending] = useState<boolean | null>(isTauri ? null : false);
  const [enrollmentError, setEnrollmentError] = useState('');
  const [setupForm, setSetupForm] = useState({ activationCode: '', newPassword: '', confirmPassword: '' });
  const [formData, setFormData] = useState({
    username: '',
    password: '',
  });

  const checkOwnerSetup = async () => {
    const result = await getOwnerEnrollmentStatusAction();
    if (!result.success) {
      setEnrollmentPending(null);
      setEnrollmentError(result.error || 'تعذر التحقق من إعداد المالك');
      return;
    }
    setEnrollmentError('');
    setEnrollmentPending(result.pending);
  };

  useEffect(() => {
    if (isTauri) void checkOwnerSetup();
  }, []);

  const handleOwnerSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (enrollmentSubmissionRef.current) return;
    if (setupForm.newPassword !== setupForm.confirmPassword) {
      setEnrollmentError('تأكيد كلمة المرور غير مطابق');
      return;
    }
    enrollmentSubmissionRef.current = true;
    setLoading(true);
    setEnrollmentError('');
    try {
      const result = await enrollInitialOwnerAction(setupForm.activationCode, setupForm.newPassword);
      if (!result.success) {
        setEnrollmentError(result.error || 'تعذر إعداد حساب المالك');
        return;
      }
      setSetupForm({ activationCode: '', newPassword: '', confirmPassword: '' });
      setEnrollmentPending(false);
      toast.success('تم إعداد المالك بأمان. سجّل الدخول بكلمة المرور الجديدة.');
    } finally {
      enrollmentSubmissionRef.current = false;
      setLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loginSubmissionRef.current) return;
    loginSubmissionRef.current = true;
    setLoading(true);

    try {
      const result = await loginLocalAction(formData.username, formData.password);

      if (result.success && result.user) {
        // Save user to localStorage so getLocalSession() can find it on the client
        const sessionUser = {
          id: result.user.id,
          username: result.user.username,
          role: result.user.role,
          full_name: result.user.full_name,
          pharmacy_id: result.user.pharmacy_id,
          permissions: result.user.permissions || '[]'
        };
        localStorage.setItem('pharma_session_user', JSON.stringify(sessionUser));

        toast.success(`أهلاً بك، ${result.user.full_name}`);
        // Keep navigation inside the packaged SPA. A full location reload can
        // tear down the Tauri WebView instead of resolving the exported route.
        router.replace('/');
        return;
      }

      if (result.error === 'المستخدم غير موجود') {
        toast.error('المستخدم غير موجود محلياً. اطلب من المالك إنشاء الحساب أو التحقق من اسم المستخدم.');
      } else {
        toast.error(result.error || 'فشل تسجيل الدخول');
      }
    } catch (error) {
      console.error('Login error:', error);
      toast.error('حدث خطأ غير متوقع');
    } finally {
      loginSubmissionRef.current = false;
      setLoading(false);
    }
  };

  const handleInitialSync = async () => {
    if (initialSyncRef.current) return;
    initialSyncRef.current = true;
    setIsSyncing(true);
    const toastId = toast.loading('جاري تحديث قائمة الأدوية والتفاعلات العامة...');
    
    try {
      const result = await syncFromCloud();
      if (result.success) {
        toast.success(result.message || 'تمت المزامنة بنجاح!', { id: toastId });
      } else {
        toast.error(result.error || 'فشل الاتصال بالسحابة', { id: toastId });
      }
    } catch (error) {
      toast.error('تأكد من وجود اتصال بالإنترنت للمزامنة الأولى', { id: toastId });
    } finally {
      initialSyncRef.current = false;
      setIsSyncing(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4 py-8 font-sans" dir="rtl">
      <div className="w-full max-w-[440px]">
        <div className="rounded-2xl border border-slate-700/80 bg-slate-900 p-5 shadow-xl sm:p-9">
          
          {/* Header */}
          <div className="mb-8 flex flex-col items-center text-center">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-primary-700 text-white">
              <Shield className="h-7 w-7" aria-hidden="true" />
            </div>
            <h1 className="text-3xl font-bold text-white">فارما تيك</h1>
            <p className="mt-2 text-sm font-medium text-slate-300">The Local Enforcer</p>
          </div>

          {isTauri && enrollmentPending === null ? (
            <div role="alert" className="space-y-4 text-sm text-amber-200">
              <p>{enrollmentError || 'جاري التحقق من حالة إعداد المالك…'}</p>
              {enrollmentError && <button type="button" onClick={() => void checkOwnerSetup()} className="rounded-lg border border-amber-400 px-4 py-2">إعادة المحاولة</button>}
            </div>
          ) : enrollmentPending ? (
            <form onSubmit={handleOwnerSetup} className="space-y-5" aria-busy={loading}>
              <p className="text-sm text-slate-200">إعداد حساب المالك لأول مرة. إذا ثبّتَّ ترخيصاً موقعاً للعمل دون إنترنت على صيدلية جديدة فارغة، يمكنك اختيار كلمة مرور المالك مباشرةً. أما إذا فعّلت الترخيص عبر الإنترنت فأدخل رمز التفعيل الأصلي ثم اختر كلمة مرور قوية. لا يمنح الترخيص وحده صلاحية الاستحواذ على سجلات صيدلية قديمة.</p>
              <label className="block space-y-2 text-sm text-slate-200" htmlFor="owner-activation-code">
                <span>رمز تفعيل الترخيص</span>
                <input id="owner-activation-code" type="password" autoComplete="off" maxLength={43}
                  value={setupForm.activationCode}
                  onChange={e => setSetupForm(p => ({ ...p, activationCode: e.target.value }))}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-white" />
              </label>
              <p className="text-xs text-slate-400">اترك هذا الحقل فارغاً فقط عند استخدام ترخيص دون اتصال صادر خصيصاً لجهازك. التفعيل عبر الإنترنت يتطلب الرمز الأصلي.</p>
              <label className="block space-y-2 text-sm text-slate-200" htmlFor="owner-new-password">
                <span>كلمة مرور جديدة (14 حرفاً على الأقل، أحرف كبيرة وصغيرة وأرقام ورموز)</span>
                <input id="owner-new-password" type="password" autoComplete="new-password" required minLength={14}
                  value={setupForm.newPassword}
                  onChange={e => setSetupForm(p => ({ ...p, newPassword: e.target.value }))}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-white" />
              </label>
              <label className="block space-y-2 text-sm text-slate-200" htmlFor="owner-confirm-password">
                <span>تأكيد كلمة المرور</span>
                <input id="owner-confirm-password" type="password" autoComplete="new-password" required
                  value={setupForm.confirmPassword}
                  onChange={e => setSetupForm(p => ({ ...p, confirmPassword: e.target.value }))}
                  className="w-full rounded-lg border border-slate-600 bg-slate-800 p-3 text-white" />
              </label>
              {enrollmentError && <p role="alert" className="text-sm text-rose-300">{enrollmentError}</p>}
              <button type="submit" disabled={loading} className="w-full rounded-lg bg-primary-700 p-3 font-semibold text-white disabled:opacity-50">
                {loading ? 'جاري إعداد المالك…' : 'إعداد المالك'}
              </button>
            </form>
          ) : (
          <form onSubmit={handleLogin} className="space-y-5" aria-busy={loading}>
            <div className="space-y-2">
              <label htmlFor="login-username" className="mr-1 text-sm font-semibold text-slate-200">اسم المستخدم / البريد</label>
              <div className="relative group">
                <User className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-focus-within:text-sky-300 transition-colors" aria-hidden="true" />
                <input
                  id="login-username"
                  type="text"
                  autoComplete="username"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  required
                  className="min-h-12 w-full rounded-lg border border-slate-600 bg-slate-800 py-3 pr-12 pl-4 text-white placeholder:text-slate-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30 focus:outline-none transition-colors"
                  placeholder="admin@pharmacy.com"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="login-password" className="mr-1 text-sm font-semibold text-slate-200">كلمة المرور</label>
              <div className="relative group">
                <Lock className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-focus-within:text-sky-300 transition-colors" aria-hidden="true" />
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  required
                  className="min-h-12 w-full rounded-lg border border-slate-600 bg-slate-800 py-3 pr-12 pl-4 text-white placeholder:text-slate-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30 focus:outline-none transition-colors"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || isSyncing}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary-700 px-4 py-3 font-semibold text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? <><Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /><span role="status">جاري تسجيل الدخول...</span></> : 'دخول للنظام المحلي'}
            </button>
          </form>
          )}

          {/* Sync Option */}
          <div className="mt-7 border-t border-slate-700 pt-6">
             <button
               onClick={handleInitialSync}
               disabled={isSyncing || loading}
               className="flex min-h-11 w-full items-center justify-center gap-3 rounded-lg border border-slate-600 bg-slate-800 px-3 py-3 text-sm font-semibold text-slate-100 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
             >
               {isSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
               تحديث قائمة الأدوية والتفاعلات
             </button>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          Powered by PharmaTech Local Enforcer v1.1
        </p>
      </div>
    </div>
  );
}
