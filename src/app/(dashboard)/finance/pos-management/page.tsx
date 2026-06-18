import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';

export const metadata = {
  title: 'إدارة نقاط البيع | PharmaTech',
};

export default async function PosManagementPage() {
  const user = await getClientSession();
  if (!user || !hasUserPermissionSync(user, 'acc_can_view_pos')) {
    return <AccessDenied />;
  }

  return (
    <div className="p-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">إدارة نقاط البيع</h1>
          <p className="text-slate-500 font-bold">تعريف نقاط البيع ومتابعة أرصدتها الحالية.</p>
        </div>
      </div>

      <AccountsManagementClient initialTab="pos_management" />
    </div>
  );
}
