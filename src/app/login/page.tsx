'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'react-hot-toast';
import { Shield, Lock, User, Loader2, Globe, CheckCircle2 } from 'lucide-react';
import { loginLocalAction } from '@/app/actions-client/auth';
import { syncFromCloud } from '@/lib/sync/universal';

export default function LoginPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncedUsers, setSyncedUsers] = useState<string[]>([]);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
  });

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
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
        // Use window.location for a full reload to dashboard to avoid ChunkLoadError
        window.location.href = '/';
        return;
      }

      if (result.error === 'المستخدم غير موجود') {
        toast.error('المستخدم غير موجود محلياً. استخدم البريد الإلكتروني الذي قمت بمزامنته.');
      } else {
        toast.error(result.error || 'فشل تسجيل الدخول');
      }
    } catch (error) {
      console.error('Login error:', error);
      toast.error('حدث خطأ غير متوقع');
    } finally {
      setLoading(false);
    }
  };

  const handleInitialSync = async () => {
    setIsSyncing(true);
    const toastId = toast.loading('جاري المزامنة مع السحابة (The Brain)... جلب كافة البيانات...');
    
    try {
      const result = await syncFromCloud();
      if (result.success) {
        toast.success(result.message || 'تمت المزامنة بنجاح!', { id: toastId });
        if (result.syncedUsernames) {
          setSyncedUsers(result.syncedUsernames);
        }
      } else {
        toast.error(result.error || 'فشل الاتصال بالسحابة', { id: toastId });
      }
    } catch (error) {
      toast.error('تأكد من وجود اتصال بالإنترنت للمزامنة الأولى', { id: toastId });
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 p-4 font-sans" dir="rtl">
      {/* Background Decor */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-[10%] -right-[10%] w-[40%] h-[40%] bg-blue-600/10 blur-[120px] rounded-full"></div>
        <div className="absolute -bottom-[10%] -left-[10%] w-[40%] h-[40%] bg-indigo-600/10 blur-[120px] rounded-full"></div>
      </div>

      <div className="w-full max-w-[480px] relative">
        <div className="bg-slate-900/50 backdrop-blur-3xl p-10 rounded-[2.5rem] border border-slate-800 shadow-2xl relative z-10">
          
          {/* Header */}
          <div className="flex flex-col items-center mb-10 text-center">
            <div className="w-20 h-20 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-3xl flex items-center justify-center shadow-2xl shadow-blue-500/20 mb-6 group transition-transform hover:scale-110">
              <Shield className="w-10 h-10 text-white" />
            </div>
            <h1 className="text-4xl font-black text-white tracking-tight">فارما تيك</h1>
            <h2 className="text-blue-400 text-lg font-bold mt-2">The Local Enforcer</h2>
          </div>

          {syncedUsers.length > 0 && (
            <div className="mb-8 p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl animate-in fade-in slide-in-from-top-4 duration-500">
               <div className="flex items-center gap-2 text-emerald-400 mb-2 font-bold text-sm">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>تمت المزامنة! الحسابات المتاحة للدخول:</span>
               </div>
               <div className="flex flex-wrap gap-2">
                  {syncedUsers.map(user => (
                    <button 
                      key={user}
                      onClick={() => setFormData({ ...formData, username: user })}
                      className="text-[10px] bg-emerald-500/20 text-emerald-300 px-2 py-1 rounded-lg border border-emerald-500/30 hover:bg-emerald-500/30 transition-all"
                    >
                      {user}
                    </button>
                  ))}
               </div>
               <p className="text-[10px] text-emerald-500/60 mt-3 italic">* أول عملية دخول ستقوم بضبط كلمة المرور الخاصة بك محلياً.</p>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 uppercase tracking-widest mr-2">اسم المستخدم / البريد</label>
              <div className="relative group">
                <User className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  required
                  className="w-full pr-12 pl-4 py-4 bg-slate-800/50 border border-slate-700 rounded-2xl text-white placeholder:text-slate-600 focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all outline-none"
                  placeholder="admin@pharmacy.com"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-black text-slate-500 uppercase tracking-widest mr-2">كلمة المرور</label>
              <div className="relative group">
                <Lock className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-500 group-focus-within:text-blue-400 transition-colors" />
                <input
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  required
                  className="w-full pr-12 pl-4 py-4 bg-slate-800/50 border border-slate-700 rounded-2xl text-white placeholder:text-slate-600 focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 transition-all outline-none"
                  placeholder="••••••••"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || isSyncing}
              className="w-full py-4 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-black rounded-2xl shadow-xl shadow-blue-500/20 transform transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'دخول للنظام المحلي'}
            </button>
          </form>

          {/* Sync Option */}
          <div className="mt-8 pt-8 border-t border-slate-800">
             <button
               onClick={handleInitialSync}
               disabled={isSyncing || loading}
               className="w-full py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-2xl border border-slate-700 transition-all flex items-center justify-center gap-3 text-sm"
             >
               {isSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
               مزامنة كافة البيانات (أول مرة)
             </button>
          </div>
        </div>

        <p className="text-center mt-8 text-slate-600 text-[10px] font-bold uppercase tracking-[0.2em]">
          Powered by PharmaTech Local Enforcer v1.1
        </p>
      </div>
    </div>
  );
}
