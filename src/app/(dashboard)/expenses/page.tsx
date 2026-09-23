'use client';
import React, { useEffect, useState } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { useRouter } from 'next/navigation';
import AccessDenied from '@/components/AccessDenied';
import ExpensesClient from '@/components/expenses/ExpensesClient';

export default function ExpensesPage() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState(false);
  const [retryAttempt, setRetryAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSessionError(false);
    async function checkAuth() {
      try {
        const sessionUser = await getClientSession();
        if (!active) return;
        if (!sessionUser) {
          router.push('/login');
          return;
        }
        setUser(sessionUser);
        setLoading(false);
      } catch (err) {
        if (!active) return;
        console.error('Failed to verify expenses session:', err);
        setSessionError(true);
        setLoading(false);
      }
    }
    void checkAuth();
    return () => {
      active = false;
    };
  }, [router, retryAttempt]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4" dir="rtl">
        <p className="font-black text-slate-700 dark:text-slate-200">تعذر التحقق من جلسة المستخدم</p>
        <button type="button" onClick={() => setRetryAttempt(attempt => attempt + 1)} className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-black">
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (!hasUserPermissionSync(user, 'can_view_expenses')) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-center space-y-4" dir="rtl">
        <div className="text-6xl">🔐</div>
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">غير مصرح لك بالوصول</h2>
        <p className="text-slate-500">ليس لديك صلاحية عرض المصروفات.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 dark:text-white">المصروفات والأرباح</h1>
        <p className="text-slate-500 mt-1">تتبع المصروفات وحساب صافي الأرباح الفعلي</p>
      </div>

      <ExpensesClient
        canManage={
          hasUserPermissionSync(user, 'acc_can_define_expenses')
          || hasUserPermissionSync(user, 'acc_can_process_cash_flow')
        }
      />
    </div>
  );
}
