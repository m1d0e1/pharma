import TrialBalanceSettingsClient from '@/components/finance/TrialBalanceSettingsClient';
import PermissionGuard from '@/components/PermissionGuard';

export const metadata = {
  title: 'إعدادات ميزان المراجعة | PharmaTech',
  description: 'ربط الكيانات بشجرة الحسابات',
};

export default function TrialBalanceSettingsPage() {
  return (
    <PermissionGuard permissionKey="acc_can_view_general">
      <div className="p-8">
        <TrialBalanceSettingsClient />
      </div>
    </PermissionGuard>
  );
}
