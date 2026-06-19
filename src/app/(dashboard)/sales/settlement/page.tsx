import React from 'react';
import SettlementClient from '@/components/sales/SettlementClient';
import PermissionGuard from '@/components/PermissionGuard';

export default function SettlementPage() {
  return (
    <PermissionGuard permissionKey="can_view_settlement">
      <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-black text-slate-900 dark:text-white">تسوية مبيعات بدون رصيد</h1>
            <p className="text-slate-500 mt-1 font-bold">قم بربط المبيعات التي تمت بدون رصيد بالدفعات المخزنية المتوفرة.</p>
          </div>
        </div>

        <SettlementClient initialItems={[]} />
      </div>
    </PermissionGuard>
  );
}
