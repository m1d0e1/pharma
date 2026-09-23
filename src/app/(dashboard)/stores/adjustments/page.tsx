'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getAdjustmentsAction } from '@/app/actions-client/inventory';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import AdjustmentsClient from "./AdjustmentsClient";

export default function AdjustmentsPage() {
  const router = useRouter();
  const [reasons, setReasons] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);

  useEffect(() => {
    async function loadReasons() {
      setLoading(true);
      setLoadError(false);
      try {
        const user = await getClientSession();
        if (!user) {
          router.push('/login');
          return;
        }
        if (!hasUserPermissionSync(user, 'can_manage_inventory')) {
          router.push('/inventory');
          return;
        }
        setAuthorized(true);
        const res = await getAdjustmentsAction();
        if (res.success) {
          setReasons(res.data || []);
        } else {
          console.error('Failed to load adjustment reasons:', (res as any).error);
          setLoadError(true);
        }
      } catch (err) {
        console.error('Failed to load adjustment reasons:', err);
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    }
    loadReasons();
  }, [router, retryAttempt]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col justify-center items-center py-12 gap-4" dir="rtl">
        <p className="font-black text-slate-700 dark:text-slate-200">تعذر تحميل بيانات شاشة التسوية</p>
        <button
          type="button"
          onClick={() => setRetryAttempt(attempt => attempt + 1)}
          className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-black"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (!authorized) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <AdjustmentsClient 
      reasons={reasons} 
    />
  );
}
