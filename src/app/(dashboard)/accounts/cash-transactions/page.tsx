import CashTransactionsClient from '@/components/finance/CashTransactionsClient';
import PermissionGuard from '@/components/PermissionGuard';

export const metadata = {
  title: 'حركة النقدية | PharmaTech',
  description: 'إدارة عمليات صرف وتوريد النقدية',
};

export default function CashTransactionsPage() {
  return (
    <PermissionGuard permissionKey="acc_can_process_cash_flow">
      <div className="p-8">
        <CashTransactionsClient />
      </div>
    </PermissionGuard>
  );
}
