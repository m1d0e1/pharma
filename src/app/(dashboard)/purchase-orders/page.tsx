'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';
import { getPurchaseOrdersAction } from '@/app/actions-client/purchases';
import PurchaseOrdersClient from '@/components/inventory/PurchaseOrdersClient';

export default function PurchaseOrdersPage() {
  const [user, setUser] = useState<any>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const session = await getClientSession();
      setUser(session);
      
      if (session) {
        const result = await getPurchaseOrdersAction();
        if (result.success && result.data) {
          setOrders(result.data);
        }
      }
      setLoading(false);
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!user) return <AccessDenied />;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">أوامر الشراء</h1>
          <p className="text-slate-500 mt-1">تتبع طلباتك من الموردين والشركات.</p>
        </div>
      </div>

      <PurchaseOrdersClient initialOrders={orders} />
    </div>
  )
}
