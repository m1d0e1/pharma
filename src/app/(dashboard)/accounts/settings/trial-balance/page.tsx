import TrialBalanceSettingsClient from '@/components/finance/TrialBalanceSettingsClient';
import { getClientSession } from '@/lib/auth/local';
import { redirect } from 'next/navigation';
import AccessDenied from '@/components/AccessDenied';

export const metadata = {
  title: 'إعدادات ميزان المراجعة | PharmaTech',
  description: 'ربط الكيانات بشجرة الحسابات',
};

export default async function TrialBalanceSettingsPage() {
  const user = await getClientSession();
  
  if (!user) {
    return <AccessDenied />;
  }

  const canManageAccounts = user.role === 'owner' || user.role === 'admin';
  
  if (!canManageAccounts) {
    return <AccessDenied />;
  }

  return (
    <div className="p-8">
      <TrialBalanceSettingsClient />
    </div>
  );
}
