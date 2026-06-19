import AccountsManagementClient from '@/components/finance/AccountsManagementClient';
import PermissionGuard from '@/components/PermissionGuard';

export const metadata = {
  title: 'إدارة البطاقات | PharmaTech',
};

export default function CardsPage() {
  return (
    <PermissionGuard permissionKey="acc_can_collect_credit_cards">
      <div className="p-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">إدارة البطاقات والماكينات</h1>
            <p className="text-slate-500 font-bold">متابعة أرصدة ماكينات الدفع الإلكتروني والعمولات.</p>
          </div>
        </div>

        <AccountsManagementClient initialTab="cards" />
      </div>
    </PermissionGuard>
  );
}
