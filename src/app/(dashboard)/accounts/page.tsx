import React from 'react';
import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import PermissionGuard from '@/components/PermissionGuard';

export default function AccountsPage() {
  return (
    <PermissionGuard permissionKey="acc_can_view_general">
      <div className="space-y-6 animate-in fade-in duration-200" dir="rtl">
        <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-4 sm:p-6 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm">
          <div>
            <h1 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white">الإدارة المالية والحسابات</h1>
            <p className="text-slate-500 font-bold mt-1">إدارة الخزينة، التوريدات، والمصاريف والتقارير المالية.</p>
          </div>
        </div>

        <AccountsManagementClient />
      </div>
    </PermissionGuard>
  );
}
