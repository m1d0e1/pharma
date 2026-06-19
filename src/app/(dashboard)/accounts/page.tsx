import React from 'react';
import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import PermissionGuard from '@/components/PermissionGuard';

export default function AccountsPage() {
  return (
    <PermissionGuard permissionKey="acc_can_view_general">
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
        <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-sm">
          <div>
            <h1 className="text-4xl font-black text-slate-900 dark:text-white">الإدارة المالية والحسابات</h1>
            <p className="text-slate-500 font-bold mt-1">إدارة الخزينة، التوريدات، والمصاريف والتقارير المالية.</p>
          </div>
        </div>

        <AccountsManagementClient />
      </div>
    </PermissionGuard>
  );
}
