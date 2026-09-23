'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { getClientSession } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';
import { getPurchaseOrdersAction } from '@/app/actions-client/purchases';
import PurchaseOrdersClient from '@/components/inventory/PurchaseOrdersClient';

export default function PurchaseOrdersPage() {
  const [user, setUser] = useState<any>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const loadRequestRef = React.useRef(0);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setLoadError(false);
    setUser(null);
    try {
      const session = await getClientSession();
      if (requestId !== loadRequestRef.current) return;
      setUser(session);
      
      if (session) {
        const result = await getPurchaseOrdersAction();
        if (requestId !== loadRequestRef.current) return;
        if (result.success && result.data) {
          setOrders(result.data);
        } else {
          setLoadError(true);
        }
      }
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      console.error('Failed to load purchase orders:', err);
      setLoadError(true);
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4" dir="rtl">
        <p className="font-black text-slate-700 dark:text-slate-200">تعذر تحميل أوامر الشراء</p>
        <button type="button" onClick={() => void load()} className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-black">
          إعادة المحاولة
        </button>
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
