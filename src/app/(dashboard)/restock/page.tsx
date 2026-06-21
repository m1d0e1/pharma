'use client';

import React, { useEffect, useState } from 'react';
import RestockHeader from '@/components/inventory/RestockHeader';
import RestockClient from '@/components/inventory/RestockClient';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { getRestockItemsAction } from '@/app/actions-client/inventory';
import AccessDenied from '@/components/AccessDenied';

export default function RestockPage() {
  const [automatedList, setAutomatedList] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadRestockData() {
      try {
        const userObj = await getClientSession();
        if (!userObj) return;
        setUser(userObj);

        const isAllowed = hasUserPermissionSync(userObj, 'can_view_restock');

        if (isAllowed) {
          setAllowed(true);
          const res = await getRestockItemsAction();
          if (res.success) {
            if (active) setAutomatedList(res.data || []);
          } else {
            console.error('Failed to load restock data:', (res as any).error);
          }
        }
      } catch (err) {
        console.error('Failed to load restock data:', err);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadRestockData();
    return () => { active = false; };
  }, []);

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

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <RestockHeader initialItems={automatedList} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2">
           <RestockClient items={automatedList || []} onUpdateQuantity={handleUpdateQuantity} />
        </div>
        
        <div className="space-y-6">
           <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl">
             <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
               <span>📊</span> ملخص النواقص
             </h3>
             <div className="space-y-4">
               <div className="flex justify-between items-center p-4 bg-red-50 dark:bg-red-900/10 rounded-2xl">
                 <span className="text-sm font-bold text-red-600">أصناف منتهية</span>
                 <span className="text-2xl font-black text-red-700">{automatedList.filter(i => i.quantity === 0).length}</span>
               </div>
               <div className="flex justify-between items-center p-4 bg-amber-50 dark:bg-amber-900/10 rounded-2xl">
                 <span className="text-sm font-bold text-amber-600">أصناف قاربت على النفاد</span>
                 <span className="text-2xl font-black text-amber-700">{automatedList.filter(i => i.quantity > 0).length}</span>
               </div>
               <div className="pt-4 border-t">
                 <p className="text-xs text-slate-400 mb-2 font-bold uppercase">الميزانية التقديرية لإعادة الملء</p>
                 <h4 className="text-3xl font-black text-slate-900 dark:text-white">
                   {automatedList.reduce((sum, item) => sum + (item.suggested_order * ((item.master_drugs as any)?.official_price || 0)), 0).toLocaleString()} <span className="text-sm">ج.م</span>
                 </h4>
               </div>
             </div>
           </div>
           
           <div className="bg-gradient-to-br from-purple-600 to-indigo-700 p-8 rounded-3xl text-white shadow-xl">
             <h4 className="text-xl font-bold mb-2">الذكاء الاصطناعي 🤖</h4>
             <p className="text-purple-100 text-sm leading-relaxed">بناءً على مبيعات الشهر الماضي، نقترح عليك زيادة طلب "بانادول" بنسبة 20% لتجنب النقص المستقبلي.</p>
           </div>
        </div>
      </div>
    </div>
  );
}
