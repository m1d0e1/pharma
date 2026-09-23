'use client';

import React, { useEffect, useState } from 'react';
import CogsAdjustmentClient from '@/components/sales/CogsAdjustmentClient';
import { getClientSession } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';

export default function CogsAdjustmentPage() {
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadPage() {
      setLoading(true);
      setLoadError('');
      try {
        const localUser = await getClientSession();
        if (!active) return;
        if (localUser) {
          setUser(localUser);
          setAllowed(localUser.role === 'owner');
        }
      } catch (err) {
        console.error('Failed to load user session:', err);
        if (active) setLoadError('تعذر التحقق من جلسة المستخدم');
      } finally {
        if (active) setLoading(false);
      }
    }
    loadPage();
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

  return (
    <div className="container mx-auto py-8">
      <CogsAdjustmentClient />
    </div>
  );
}
