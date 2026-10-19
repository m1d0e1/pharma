'use client';

import React, { useEffect, useState } from 'react';
import RestockHeader from '@/components/inventory/RestockHeader';
import RestockClient from '@/components/inventory/RestockClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getRestockItemsAction } from '@/app/actions-client/inventory';
import AccessDenied from '@/components/AccessDenied';
import { subscribeInventoryChanges } from '@/lib/inventory/refresh';
import { BarChart3 } from 'lucide-react';

export default function RestockPage() {
  const [automatedList, setAutomatedList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadRestockData() {
      setUser(null);
      setAllowed(false);
      setLoadError('');
      try {
        const userObj = await getClientSession();
        if (!active) return;
        if (!userObj) return;
        setUser(userObj);

        const isAllowed = hasUserPermissionSync(userObj, 'can_view_restock');
        setAllowed(isAllowed);

        if (isAllowed) {
          const res = await getRestockItemsAction();
          if (res.success) {
            if (active) setAutomatedList(res.data || []);
          } else {
            console.error('Failed to load restock data:', (res as any).error);
            if (active) setLoadError('تعذر تحميل قائمة إعادة التموين');
          }
        }
      } catch (err) {
        console.error('Failed to load restock data:', err);
        if (active) setLoadError('تعذر تحميل قائمة إعادة التموين');
      } finally {
        if (active) setLoading(false);
      }
    }

    loadRestockData();
    return () => { active = false; };
  }, [reloadKey]);

  useEffect(() => subscribeInventoryChanges(() => setReloadKey(value => value + 1)), []);

  const handleUpdateQuantity = (itemId: string, newQty: number) => {
    setAutomatedList(prev =>
      prev.map(item =>
        item.id === itemId ? { ...item, suggested_order: newQty } : item
      )
    );
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-24" dir="rtl">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user || !allowed) {
    return <AccessDenied />;
  }

  if (loadError) {
    return (
      <div className="flex flex-col justify-center items-center gap-4 py-20" dir="rtl">
        <p className="font-black text-rose-600">{loadError}</p>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            setReloadKey(value => value + 1);
          }}
          className="px-5 py-2.5 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6" dir="rtl">
      <RestockHeader initialItems={automatedList} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2">
           <RestockClient items={automatedList || []} onUpdateQuantity={handleUpdateQuantity} />
        </div>
        
        <div>
           <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
             <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
               <BarChart3 className="w-5 h-5 text-primary-700" aria-hidden="true" /> ملخص النواقص
             </h3>
             <div className="space-y-4">
               <div className="flex justify-between items-center p-3.5 bg-red-50 dark:bg-red-950/20 rounded-lg border border-red-100 dark:border-red-900/40">
                 <span className="text-sm font-semibold text-red-700 dark:text-red-300">أصناف منتهية</span>
                 <span className="text-xl font-bold text-red-700 dark:text-red-300 tabular-nums">{automatedList.filter(i => i.quantity === 0).length}</span>
               </div>
               <div className="flex justify-between items-center p-3.5 bg-amber-50 dark:bg-amber-950/20 rounded-lg border border-amber-100 dark:border-amber-900/40">
                 <span className="text-sm font-semibold text-amber-700 dark:text-amber-300">أصناف قاربت على النفاد</span>
                 <span className="text-xl font-bold text-amber-700 dark:text-amber-300 tabular-nums">{automatedList.filter(i => i.quantity > 0).length}</span>
               </div>
               <div className="pt-4 border-t">
                 <p className="text-xs text-slate-500 dark:text-slate-400 mb-2 font-semibold">الميزانية التقديرية لإعادة الملء</p>
                 <h4 className="text-2xl font-bold text-slate-900 dark:text-white tabular-nums">
                   {automatedList.reduce((sum, item) => sum + (item.suggested_order * ((item.master_drugs as any)?.official_price || 0)), 0).toLocaleString()} <span className="text-sm">ج.م</span>
                 </h4>
               </div>
             </div>
           </div>
        </div>
      </div>
    </div>
  );
}
