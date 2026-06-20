'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import JobsManagementClient from '@/components/admin/JobsManagementClient';
import { addJobAction, deleteJobAction } from '@/app/actions/users';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import AccessDenied from '@/components/AccessDenied';
import { dbSelect, dbExecute } from '@/lib/db/tauri';

export default function StaffRolesPage() {
  const [user, setUser] = useState<any>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const isTauri = typeof window !== 'undefined' && ((window as any).__TAURI__ !== undefined || (window as any).__TAURI_INTERNALS__ !== undefined);

  async function loadJobs() {
    try {
      const data = await dbSelect('SELECT * FROM employee_jobs ORDER BY name_ar ASC');
      setJobs(data || []);
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
    if (isTauri) {
      try {
        await dbExecute('INSERT INTO employee_jobs (name_ar, name_en, min_salary, max_salary) VALUES (?, ?, ?, ?)',
          [data.name_ar, data.name_en || null, data.min_salary || 0, data.max_salary || 0]);
        await loadJobs();
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
    const res = await addJobAction(data);
    if (res.success) await loadJobs();
    return res;
  };

  const handleDeleteJob = async (jobId: number) => {
    if (isTauri) {
      try {
        await dbExecute('DELETE FROM employee_jobs WHERE id = ?', [jobId]);
        await loadJobs();
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    }
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
