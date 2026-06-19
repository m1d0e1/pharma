import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import PermissionGuard from '@/components/PermissionGuard';

export const metadata = {
  title: 'شجرة الحسابات | PharmaTech',
};

export default function AccountsPage() {
  return (
    <PermissionGuard permissionKey="acc_can_view_general">
      <div className="p-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">إدارة الحسابات</h1>
            <p className="text-slate-500 font-bold">إدارة شجرة الحسابات والهيكل المالي للصيدلية.</p>
          </div>
        </div>

        <AccountsManagementClient initialTab="chart_of_accounts" />
      </div>
    </PermissionGuard>
  );
}
