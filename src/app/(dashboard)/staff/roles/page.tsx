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

  async function loadJobs() {
    try {
      const result = await getJobsAction();
      if (result.success) setJobs(result.data || []);
    } catch (err) {
      console.error('Failed to load jobs:', err);
    }
  }

  useEffect(() => {
    async function initPage() {
      try {
        const localUser = await getClientSession();
        if (!localUser) return;
        setUser(localUser);

        const isAllowed = hasUserPermissionSync(localUser, 'can_view_staff_roles');
        if (isAllowed) {
          await loadJobs();
        }
      } catch (err) {
        console.error('Failed to initialize jobs page:', err);
      } finally {
        setLoading(false);
      }
    }

    initPage();
  }, []);

  const handleAddJob = async (data: { name_ar: string; name_en?: string; min_salary?: number; max_salary?: number }) => {
    const res = await addJobAction(data);
    if (res.success) await loadJobs();
    return res;
  };

  const handleDeleteJob = async (jobId: number) => {
    const res = await deleteJobAction(jobId);
    if (res.success) await loadJobs();
    return res;
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || !hasUserPermissionSync(user, 'can_view_staff_roles')) {
    return <AccessDenied />;
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
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
