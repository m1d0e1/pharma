'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import StaffAnalyticsClient from '@/components/admin/StaffAnalyticsClient';
import { getClientSession, hasUserPermissionSync, isOwnerOrAdmin } from '@/lib/auth/local';
import { getStaffPerformanceAction } from '@/app/actions-client/users';
import AccessDenied from '@/components/AccessDenied';

export default function StaffPage() {
  const [user, setUser] = useState<any>(null);
  const [staffMetrics, setStaffMetrics] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadStaffData() {
      try {
        const localUser = await getClientSession();
        if (!localUser) return;
        setUser(localUser);

        const isAllowed = isOwnerOrAdmin(localUser) || hasUserPermissionSync(localUser, 'rep_can_view_activity');
        if (!isAllowed) {
          setLoading(false);
          return;
        }

        const res = await getStaffPerformanceAction();
        if (res.success && res.data) {
          setStaffMetrics(res.data);
        }
      } catch (err) {
        console.error('Failed to load staff performance data:', err);
      } finally {
        setLoading(false);
      }
    }

    loadStaffData();
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || (!isOwnerOrAdmin(user) && !hasUserPermissionSync(user, 'rep_can_view_activity'))) {
    return <AccessDenied />;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">أداء طاقم العمل</h1>
          <p className="text-slate-500 mt-1">تقارير وتحليلات أداء المبيعات والشفتات للموظفين.</p>
        </div>
        <div className="flex gap-3">
          {(isOwnerOrAdmin(user) || hasUserPermissionSync(user, 'can_view_staff_manage')) && (
            <Link href="/staff/manage" className="bg-slate-900 dark:bg-slate-800 text-white px-6 py-3 rounded-2xl font-bold text-sm shadow-lg hover:bg-slate-800 transition-all">
              🛡️ إدارة الموظفين
            </Link>
          )}
          {(isOwnerOrAdmin(user) || hasUserPermissionSync(user, 'can_view_shifts')) && (
            <Link href="/shifts" className="bg-blue-600 text-white px-6 py-3 rounded-2xl font-bold text-sm shadow-lg hover:bg-blue-700 transition-all">
              📅 إدارة الشفتات
            </Link>
          )}
        </div>
      </div>

      <StaffAnalyticsClient metrics={staffMetrics} />
      
      {!staffMetrics.some(m => m.totalRevenue > 0) && (
        <div className="p-6 bg-slate-50 dark:bg-slate-800/50 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800 text-center">
          <p className="text-slate-400 font-bold">لا توجد بيانات مبيعات كافية لتحليل أداء الموظفين حالياً.</p>
        </div>
      )}
    </div>
  );
}
