'use client';

import React, { useEffect, useState } from 'react';
import DrawerHandoverClient from '@/components/finance/DrawerHandoverClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getOpenShiftHandoverAction } from '@/app/actions/handover';
import { AlertCircle } from 'lucide-react';
import Link from 'next/link';
import AccessDenied from '@/components/AccessDenied';

export default function HandoverPage() {
  const [currentShift, setCurrentShift] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    async function checkShift() {
      try {
        const userObj = await getClientSession();
        if (userObj) {
          setUser(userObj);

          const isAllowed = hasUserPermissionSync(userObj, 'acc_can_view_handover');

          if (isAllowed) {
            setAllowed(true);
            const res = await getOpenShiftHandoverAction();
            if (res.success) {
              setCurrentShift(res.data || null);
            } else {
              setCurrentShift(null);
            }
          }
        }
      } catch (err) {
        console.error('Failed to check current shift:', err);
      } finally {
        setLoading(false);
      }
    }

    checkShift();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  if (!currentShift) {
    return (
      <div className="container mx-auto py-20" dir="rtl">
        <div className="max-w-2xl mx-auto bg-white dark:bg-slate-900 p-12 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-xl text-center space-y-8">
          <div className="w-24 h-24 bg-rose-50 dark:bg-rose-900/20 rounded-full flex items-center justify-center mx-auto">
            <AlertCircle className="w-12 h-12 text-rose-600" />
          </div>
          <div className="space-y-4">
            <h1 className="text-3xl font-black text-slate-800 dark:text-white">لا توجد وردية مفتوحة حالياً</h1>
            <p className="text-slate-500 font-bold max-w-md mx-auto">
              عذراً، يجب أن يكون هناك وردية مفتوحة باسمك لتتمكن من إجراء عملية تسليم الدرج.
            </p>
          </div>
          <div className="flex gap-4 justify-center">
            <Link 
              href="/shifts"
              className="px-10 py-5 bg-slate-900 text-white rounded-[24px] font-black hover:bg-slate-800 transition-all shadow-xl"
            >
              الذهاب إلى الورديات
            </Link>
            <Link 
              href="/"
              className="px-10 py-5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-[24px] font-black hover:bg-slate-200 transition-all"
            >
              الرئيسية
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8" dir="rtl">
      <DrawerHandoverClient shiftId={currentShift.id} />
    </div>
  );
}
