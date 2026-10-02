'use client';

import React, { useEffect, useState } from 'react';
import DrawerHandoverClient from '@/components/finance/DrawerHandoverClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getOpenShiftHandoverAction } from '@/app/actions-client/handover';
import { AlertCircle } from 'lucide-react';
import Link from 'next/link';
import AccessDenied from '@/components/AccessDenied';

export default function HandoverPage() {
  const [currentShift, setCurrentShift] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function checkShift() {
      setLoading(true);
      setLoadError('');
      setCurrentShift(null);
      try {
        const userObj = await getClientSession();
        if (!active) return;
        setUser(userObj);
        if (!userObj) {
          setAllowed(false);
          return;
        }

        const isAllowed = hasUserPermissionSync(userObj, 'acc_can_view_handover');
        setAllowed(isAllowed);

        if (isAllowed) {
          const res = await getOpenShiftHandoverAction();
          if (!active) return;
          if (res.success) {
            setCurrentShift(res.data || null);
          } else {
            setLoadError('تعذر تحميل حالة التسليم');
          }
        }
      } catch (err) {
        console.error('Failed to check current shift:', err);
        if (active) setLoadError('تعذر تحميل حالة التسليم');
      } finally {
        if (active) setLoading(false);
      }
    }

    checkShift();
    return () => { active = false; };
  }, [loadAttempt]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
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

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  if (!currentShift) {
    return (
      <div className="container mx-auto px-3 sm:px-6 py-10 sm:py-16" dir="rtl">
        <div className="max-w-2xl mx-auto bg-white dark:bg-slate-900 p-6 sm:p-8 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm text-center space-y-6">
          <div className="w-16 h-16 bg-rose-50 dark:bg-rose-900/20 rounded-2xl flex items-center justify-center mx-auto">
            <AlertCircle className="w-8 h-8 text-rose-600" />
          </div>
          <div className="space-y-4">
            <h1 className="text-2xl font-black text-slate-800 dark:text-white">لا توجد وردية مفتوحة حالياً</h1>
            <p className="text-slate-500 font-bold max-w-md mx-auto">
              يجب أن تكون الوردية المشتركة مفتوحة لتتمكن من إجراء عملية التسليم.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link 
              href="/shifts"
              className="px-6 py-3.5 bg-slate-900 text-white rounded-xl font-black hover:bg-slate-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              الذهاب إلى الورديات
            </Link>
            <Link 
              href="/"
              className="px-6 py-3.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
            >
              الرئيسية
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-3 sm:px-6 py-6" dir="rtl">
      <DrawerHandoverClient shiftId={currentShift.id} />
    </div>
  );
}
