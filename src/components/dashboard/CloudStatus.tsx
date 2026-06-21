'use client';

import React, { useState, useEffect } from 'react';
import { Globe, ShieldCheck, ShieldAlert, Loader2, LogIn } from 'lucide-react';
import { loginCloudAction } from '@/app/actions-client/auth';
import { toast } from 'react-hot-toast';

interface Props {
  initialSession: any;
}

export default function CloudStatus({ initialSession }: Props) {
  const [session, setSession] = useState(initialSession);
  const [showLogin, setShowLogin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({ email: '', password: '' });

  const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI__ !== undefined || (window as any).__TAURI_INTERNALS__ !== undefined);

  useEffect(() => {
    if (isTauri) {
      async function checkCloudSession() {
        try {
          const { getSupabaseBrowserClient } = await import('@/lib/supabase');
          const supabase = getSupabaseBrowserClient();
          const { data } = await supabase.auth.getUser();
          if (data?.user) {
            setSession(data.user);
          }
        } catch (e) {
          console.error('Failed to check cloud session:', e);
        }
      }
      checkCloudSession();
    }
  }, [isTauri]);

  const handleCloudLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    if (isTauri) {
      try {
        const { getSupabaseBrowserClient } = await import('@/lib/supabase');
        const supabase = getSupabaseBrowserClient();
        const { data, error } = await supabase.auth.signInWithPassword({
          email: formData.email,
          password: formData.password,
        });

        if (error) {
          toast.error(error.message || 'فشل الاتصال بالسحابة');
        } else if (data?.user) {
          setSession(data.user);
          setShowLogin(false);
          toast.success('تم الاتصال بالسحابة بنجاح');
        }
      } catch (err) {
        toast.error('خطأ في الاتصال بالسحابة');
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      const result = await loginCloudAction(formData.email, formData.password);
      if (result.success) {
        setSession(result.user);
        setShowLogin(false);
        toast.success('تم الاتصال بالسحابة بنجاح');
        // Reload to ensure all server components see the new session cookie
        window.location.reload();
      } else {
        toast.error(result.error || 'فشل الاتصال بالسحابة');
      }
    } catch (err) {
      toast.error('خطأ في الاتصال بالسحابة');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      <div className={`
        flex items-center gap-3 px-4 py-2 rounded-2xl border transition-all
        ${session 
          ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400' 
          : 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400 cursor-pointer hover:bg-amber-500/20'}
      `}
      onClick={() => !session && setShowLogin(!showLogin)}
      >
        {session ? (
          <>
            <ShieldCheck className="w-4 h-4" />
            <span className="text-xs font-bold whitespace-nowrap">متصل بالسحابة</span>
          </>
        ) : (
          <>
            <ShieldAlert className="w-4 h-4" />
            <span className="text-xs font-bold whitespace-nowrap">السحابة غير متصلة</span>
          </>
        )}
      </div>

      {showLogin && (
        <div className="absolute top-full mt-4 left-0 w-80 bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl border border-slate-200 dark:border-slate-800 p-6 z-50 animate-in fade-in zoom-in-95 duration-300">
          <div className="flex items-center gap-3 mb-4">
             <div className="p-2 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600">
                <Globe className="w-5 h-5" />
             </div>
             <h4 className="font-black text-slate-900 dark:text-white">دخول السحابة</h4>
          </div>
          <p className="text-[10px] text-slate-500 mb-6 font-bold leading-relaxed">
             الاتصال بالسحابة (The Brain) مطلوب للمزامنة والتحقق من الاشتراك.
          </p>

          <form onSubmit={handleCloudLogin} className="space-y-4">
            <input 
              type="email" 
              placeholder="البريد السحابي"
              className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500 transition-all text-right"
              value={formData.email}
              onChange={e => setFormData({...formData, email: e.target.value})}
              required
            />
            <input 
              type="password" 
              placeholder="كلمة المرور"
              className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500 transition-all text-right"
              value={formData.password}
              onChange={e => setFormData({...formData, password: e.target.value})}
              required
            />
            <button 
              disabled={loading}
              className="w-full py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              {loading ? 'جاري الاتصال...' : 'اتصل بالسحابة الآن'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
