import CashTransactionsClient from '@/components/finance/CashTransactionsClient';
import { getClientSession } from '@/lib/auth/local';
import { redirect } from 'next/navigation';
import AccessDenied from '@/components/AccessDenied';

export const metadata = {
  title: 'حركة النقدية | PharmaTech',
  description: 'إدارة عمليات صرف وتوريد النقدية',
};

export default async function CashTransactionsPage() {
  const user = await getClientSession();
  
  if (!user) {
    return <AccessDenied />;
  }

  const canManageFinance = user.role === 'owner' || user.role === 'admin' || user.role === 'pharmacist';
  
  if (!canManageFinance) {
    return <AccessDenied />;
  }

  return (
    <div className="p-8">
      <CashTransactionsClient />
    </div>
  );
}
