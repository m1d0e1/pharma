'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import JobsManagementClient from '@/components/admin/JobsManagementClient';
import { addJobAction, deleteJobAction, getJobsAction } from '@/app/actions-client/users';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import AccessDenied from '@/components/AccessDenied';

export default function StaffRolesPage() {
  const [user, setUser] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  async function loadJobs(): Promise<boolean> {
    try {
      const result = await getJobsAction();
      if (result.success) {
        setJobs(result.data || []);
        return true;
      }
      return false;
    } catch (err) {
      console.error('Failed to load jobs:', err);
      return false;
    }
  }

  async function refreshAfterMutation() {
    const loaded = await loadJobs();
    setRefreshError(!loaded);
  }

  useEffect(() => {
    async function initPage() {
      setLoading(true);
      setLoadError(false);
      try {
        const localUser = await getClientSession();
        if (!localUser) return;
        setUser(localUser);

        const isAllowed = hasUserPermissionSync(localUser, 'can_view_staff_roles');
        if (isAllowed) {
          const loaded = await loadJobs();
          if (!loaded) setLoadError(true);
        }
      } catch (err) {
        console.error('Failed to initialize jobs page:', err);
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    }

    initPage();
  }, [loadAttempt]);

  const handleAddJob = async (data: { name_ar: string; name_en?: string; min_salary?: number; max_salary?: number }) => {
    const res = await addJobAction(data);
    if (res.success) await refreshAfterMutation();
    return res;
  };

  const handleDeleteJob = async (jobId: number) => {
    const res = await deleteJobAction(jobId);
    if (res.success) await refreshAfterMutation();
    return res;
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="py-24 text-center space-y-4" dir="rtl">
        <p className="font-black text-slate-800 dark:text-slate-100">تعذر تحميل بيانات الوظائف</p>
        <button
          type="button"
          onClick={() => setLoadAttempt(attempt => attempt + 1)}
          className="px-5 py-2 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (!user || !hasUserPermissionSync(user, 'can_view_staff_roles')) {
    return <AccessDenied />;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      {refreshError && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-800">
          <span className="font-black">تعذر تحديث بيانات الوظائف</span>
          <button
            type="button"
            onClick={() => void refreshAfterMutation()}
            className="rounded-xl bg-white px-4 py-2 text-xs font-black shadow-sm ring-1 ring-amber-200"
          >
            إعادة تحميل بيانات الوظائف
          </button>
        </div>
      )}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <Link href="/staff" className="p-3 bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 hover:bg-slate-50 transition-all">
            <ArrowRight className="w-6 h-6 text-slate-600" />
          </Link>
          <div>
            <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">إدارة الوظائف</h1>
            <p className="text-slate-500 font-bold">تعريف المسميات الوظيفية وهياكل الرواتب.</p>
          </div>
        </div>
      </div>

      <JobsManagementClient 
        initialJobs={jobs}
        onAddJob={handleAddJob}
        onDeleteJob={handleDeleteJob}
      />
    </div>
  );
}
