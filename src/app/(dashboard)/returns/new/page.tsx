'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import SalesReturnClient from './SalesReturnClient';
import { useRouter } from 'next/navigation';
import AccessDenied from '@/components/AccessDenied';

export default function NewSalesReturnPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function checkAuth() {
      setLoading(true);
      setLoadError('');
      try {
        const userObj = await getClientSession();
        if (!active) return;
        if (!userObj) {
          router.push('/login');
          return;
        }
        setUser(userObj);
        setAllowed(hasUserPermissionSync(userObj, 'can_view_returns'));
      } catch (err) {
        console.error('Failed to load new-return session:', err);
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

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  return <SalesReturnClient />;
}
