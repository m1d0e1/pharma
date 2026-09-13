'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession } from '@/lib/auth/local';
import StaffManagementClient from '@/components/admin/StaffManagementClient';
import { 
  updateUserPermissionsAction, 
  addUserAction, 
  deleteUserAction, 
  closeUserShiftAndDeactivateAction,
  updateUserAction, 
  resetUserPasswordAction,
  getStaffManagementDataAction
} from '@/app/actions-client/users';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import AccessDenied from '@/components/AccessDenied';
import { hasUserPermissionSync } from '@/lib/auth/local';

export default function StaffManagePage() {
  const [user, setUser] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadData() {
    try {
      const res = await getStaffManagementDataAction();
      if (res.success) {
        setUsers(res.users || []);
        setJobs(res.jobs || []);
      } else {
        console.error(res.error);
      }
    } catch (err) {
      console.error('Failed to load users management data:', err);
    }
  }

  useEffect(() => {
    async function initPage() {
      try {
        const localUser = await getClientSession();
        if (!localUser) return;
        setUser(localUser);

        const isAllowed = hasUserPermissionSync(localUser, 'can_view_staff_manage');
        if (isAllowed) {
          await loadData();
        }
      } catch (err) {
        console.error('Failed to initialize manage page:', err);
      } finally {
        setLoading(false);
      }
    }

    initPage();
  }, []);

  const handleUpdatePermissions = async (userId: string, permissions: any) => {
    const res = await updateUserPermissionsAction(userId, permissions);
    if (res.success) await loadData();
    return res;
  };

  const handleAddUser = async (formData: any) => {
    const res = await addUserAction(formData);
    if (res.success) await loadData();
    return res;
  };

  const handleDeleteUser = async (userId: string) => {
    const res = await deleteUserAction(userId);
    if (res.success) await loadData();
    return res;
  };

  const handleCloseShiftAndDelete = async (data: {
    userId: string;
    shiftId: string;
    actualCash: number;
    authorizerPassword: string;
    notes?: string;
  }) => {
    const res = await closeUserShiftAndDeactivateAction(data);
    if (res.success) await loadData();
    return res;
  };

  const handleUpdateUser = async (userId: string, data: any) => {
    const res = await updateUserAction(userId, data);
    if (res.success) await loadData();
    return res;
  };

  const handleResetPassword = async (userId: string, newPassword: string) => {
    return await resetUserPasswordAction(userId, newPassword);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || !hasUserPermissionSync(user, 'can_view_staff_manage')) {
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
            <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">إدارة الموظفين</h1>
            <p className="text-slate-500 font-bold">التحكم في صلاحيات الوصول والمهام.</p>
          </div>
        </div>
      </div>

      <StaffManagementClient 
        users={users} 
        jobs={jobs}
        onUpdatePermissions={handleUpdatePermissions} 
        onAddUser={handleAddUser}
      onDeleteUser={handleDeleteUser}
      onCloseShiftAndDelete={handleCloseShiftAndDelete}
        onUpdateUser={handleUpdateUser}
        onResetPassword={handleResetPassword}
      />
    </div>
  );
}
