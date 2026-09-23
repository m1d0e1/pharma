'use client';

import React, { useEffect, useState } from 'react';
import ShiftReportClient from '@/components/reports/ShiftReportClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';
import { useRouter, useSearchParams } from 'next/navigation';

export default function ShiftReportPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get('id');
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
        console.error('Failed to load shift report session:', err);
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

  if (!hasUserPermissionSync(user, 'rep_can_view_shifts')) {
    return <AccessDenied />;
  }

  if (!id) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center space-y-4" dir="rtl">
        <div className="text-6xl">⚠️</div>
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">لم يتم تحديد معرف الوردية</h2>
        <p className="text-slate-500 max-w-md">يرجى العودة إلى قائمة الشفتات واختيار وردية محددة لعرض التقرير الخاص بها.</p>
        <button 
          onClick={() => router.push('/shifts')} 
          className="mt-4 px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-md shadow-blue-500/20"
        >
          الذهاب إلى قائمة الشفتات
        </button>
      </div>
    );
  }

  return (
    <div className="p-8">
      <ShiftReportClient shiftId={id} />
    </div>
  );
}
