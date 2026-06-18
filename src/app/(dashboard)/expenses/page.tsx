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

  useEffect(() => {
    async function checkAuth() {
      const sessionUser = await getClientSession();
      if (!sessionUser) {
        router.push('/login');
      } else {
        setUser(sessionUser);
        setLoading(false);
      }
    }
    checkAuth();
  }, [router]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!hasUserPermissionSync(user, 'can_view_expenses')) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-center space-y-4" dir="rtl">
        <div className="text-6xl">🔐</div>
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white">غير مصرح لك بالوصول</h2>
        <p className="text-slate-500">هذه الصفحة مخصصة للمالك فقط.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 dark:text-white">المصروفات والأرباح</h1>
        <p className="text-slate-500 mt-1">تتبع المصروفات وحساب صافي الأرباح الفعلي</p>
      </div>

      <ExpensesClient />
    </div>
  );
}