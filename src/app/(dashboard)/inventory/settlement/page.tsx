'use client';

import React, { useEffect, useState } from 'react';
import { getUnsettledSalesAction } from '@/app/actions-client/settlement';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';
import { PackageSearch } from 'lucide-react';
import SettlementClient from '@/components/sales/SettlementClient';

export default function InventorySettlementPage() {
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [unsettledItems, setUnsettledItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadSettlement() {
      setLoading(true);
      setLoadError('');
      setUser(null);
      setAllowed(false);
      try {
        const localUser = await getClientSession();
        if (!active) return;
        if (localUser) {
          setUser(localUser);

          const isAllowed = hasUserPermissionSync(localUser, 'can_view_settlement');
          setAllowed(isAllowed);

          if (isAllowed) {
            const res = await getUnsettledSalesAction();
            if (!active) return;
            if (res.success) {
              setUnsettledItems(res.data || []);
            } else {
              setLoadError('تعذر تحميل بيانات التسوية');
            }
          }
        }
      } catch (err) {
        console.error('Failed to load settlement data:', err);
        if (active) setLoadError('تعذر تحميل بيانات التسوية');
      } finally {
        if (active) setLoading(false);
      }
    }

    loadSettlement();
    return () => { active = false; };
  }, [loadAttempt]);

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20" dir="rtl">
        <p className="font-black text-rose-600">{loadError}</p>
        <button type="button" onClick={() => setLoadAttempt(attempt => attempt + 1)} className="px-6 py-3 rounded-2xl bg-slate-900 text-white font-black">
          إعادة المحاولة
        </button>
      </div>
    );
  }

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  return (
    <div className="p-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="p-4 bg-purple-100 dark:bg-purple-900/30 text-purple-600 rounded-[24px] shadow-lg shadow-purple-500/10">
            <PackageSearch className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">تسوية المخزون السالب</h1>
            <p className="text-slate-500 font-bold">ربط المبيعات التي تمت برصيد سالب مع الأصناف المضافة حديثاً.</p>
          </div>
        </div>
      </div>

      <SettlementClient initialItems={unsettledItems} />
    </div>
  );
}
