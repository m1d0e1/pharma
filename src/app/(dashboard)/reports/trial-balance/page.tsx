'use client';
import React, { useEffect, useState } from 'react';
import TrialBalanceReport from '@/components/reports/TrialBalanceReport';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { useRouter } from 'next/navigation';
import AccessDenied from '@/components/AccessDenied';
import { Printer } from 'lucide-react';

export default function TrialBalanceReportPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function checkAuth() {
      setLoading(true);
      setLoadError('');
      try {
        const sessionUser = await getClientSession();
        if (!active) return;
        if (!sessionUser) {
          router.push('/login');
          return;
        }
        setUser(sessionUser);
      } catch (err) {
        console.error('Failed to load trial balance session:', err);
        if (active) setLoadError('تعذر التحقق من جلسة المستخدم');
      } finally {
        if (active) setLoading(false);
      }
    }
    checkAuth();
    return () => { active = false; };
  }, [router, loadAttempt]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20" dir="rtl">
        <p className="font-black text-rose-600">{loadError}</p>
        <button type="button" onClick={() => setLoadAttempt(attempt => attempt + 1)} className="px-6 py-3 rounded-2xl bg-slate-900 text-white font-black">
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (!user) return null;

  if (!hasUserPermissionSync(user, 'acc_can_view_reports')) {
    return <AccessDenied />;
  }

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">ميزان المراجعة</h1>
        <button onClick={() => window.print()} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-xl font-bold shadow-sm hover:bg-blue-700 transition-all no-print">
          <Printer className="w-5 h-5" />
          طباعة التقرير
        </button>
      </div>
      <TrialBalanceReport userRole={user.role} user={user} />
    </div>
  );
}
