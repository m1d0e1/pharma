'use client';

import React, { useEffect, useState } from 'react';
import { getLowStockAction } from '@/app/actions-client/inventory';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';
import { AlertTriangle, ShoppingCart, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import LowStockClient from './LowStockClient';

export default function LowStockPage() {
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadLowStock() {
      try {
        const localUser = await getClientSession();
        if (localUser) {
          setUser(localUser);

          const isAllowed = hasUserPermissionSync(localUser, 'can_view_low_stock');

          if (isAllowed) {
            setAllowed(true);
            const res = await getLowStockAction(10); // Default threshold
            if (res.success) {
              setItems(res.data || []);
            }
          }
        }
      } catch (err) {
        console.error('Failed to load low stock data:', err);
      } finally {
        setLoading(false);
      }
    }

    loadLowStock();
  }, []);

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
    <div className="p-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="p-4 bg-amber-100 dark:bg-amber-900/30 text-amber-600 rounded-[24px] shadow-lg shadow-amber-500/10">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">النواقص (Low Stock)</h1>
            <p className="text-slate-500 font-bold">الأصناف التي وصل رصيدها للحد الأدنى.</p>
          </div>
        </div>
        <Link 
          href="/restock"
          className="px-8 py-4 bg-slate-900 text-white rounded-[24px] font-black hover:bg-slate-800 transition-all shadow-xl flex items-center gap-3 no-print"
        >
          <ShoppingCart className="w-5 h-5" /> طلب نواقص
        </Link>
      </div>

      <LowStockClient initialItems={items} />
    </div>
  );
}
