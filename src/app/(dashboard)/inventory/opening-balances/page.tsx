'use client';

import React, { useEffect, useState } from 'react';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import AccessDenied from '@/components/AccessDenied';
import { Database, Plus, Search } from 'lucide-react';
import { getOpeningBalancesAction } from '@/app/actions/inventory';
import Link from 'next/link';

export default function OpeningBalancesPage() {
  const [user, setUser] = useState<any>(null);
  const [allowed, setAllowed] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadOpeningBalances() {
      try {
        const localUser = await getClientSession();
        if (localUser) {
          setUser(localUser);

          const isAllowed = hasUserPermissionSync(localUser, 'can_view_opening_balances');

          if (isAllowed) {
            setAllowed(true);
            const res = await getOpeningBalancesAction();
            if (res.success) {
              setItems(res.data || []);
            } else {
              console.error('Failed to load opening balances:', (res as any).error);
            }
          }
        }
      } catch (err) {
        console.error('Failed to load opening balances:', err);
      } finally {
        setLoading(false);
      }
    }

    loadOpeningBalances();
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

  const filteredItems = items.filter((item: any) => {
    const text = `${item.trade_name} ${item.trade_name_en || ''}`.toLowerCase();
    return text.includes(searchTerm.toLowerCase());
  });

  return (
    <div className="p-8 space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700" dir="rtl">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="p-4 bg-blue-100 dark:bg-blue-900/30 text-blue-600 rounded-[24px] shadow-lg shadow-blue-500/10">
            <Database className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-3xl font-black text-slate-900 dark:text-white tracking-tight">الأرصدة الإفتتاحية</h1>
            <p className="text-slate-500 font-bold">إدخال ومراجعة أرصدة بداية المدة للأصناف.</p>
          </div>
        </div>
        <Link href="/inventory/opening-balances/new" className="px-8 py-4 bg-blue-600 text-white rounded-[24px] font-black hover:bg-blue-700 transition-all shadow-xl flex items-center gap-3">
          <Plus className="w-5 h-5" /> إضافة رصيد إفتتاحي
        </Link>
      </div>

      <div className="bg-white dark:bg-slate-900 rounded-[40px] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
        <div className="p-8 border-b border-slate-100 dark:border-slate-800">
          <div className="relative w-full max-w-md">
            <Search className="absolute right-5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input 
              type="text" 
              placeholder="بحث في الأرصدة..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pr-14 pl-6 py-4 bg-slate-50 dark:bg-slate-800 rounded-2xl outline-none font-bold text-slate-900 dark:text-white" 
            />
          </div>
        </div>
        <table className="w-full text-right">
          <thead className="bg-slate-50 dark:bg-slate-800/50">
            <tr className="text-slate-400 text-[10px] font-black uppercase tracking-widest">
              <th className="px-8 py-6">الصنف</th>
              <th className="px-8 py-6">الكمية</th>
              <th className="px-8 py-6">سعر التكلفة</th>
              <th className="px-8 py-6">تاريخ الإدخال</th>
              <th className="px-8 py-6">الحالة</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filteredItems.map((item: any) => (
              <tr key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                <td className="px-8 py-6 font-black text-slate-900 dark:text-white">{item.trade_name}</td>
                <td className="px-8 py-6 font-bold">{item.quantity}</td>
                <td className="px-8 py-6 font-black text-emerald-600">{item.cost_price?.toLocaleString()} ج.م</td>
                <td className="px-8 py-6 font-bold text-slate-500">{item.created_at}</td>
                <td className="px-8 py-6">
                  <span className="bg-emerald-50 text-emerald-600 px-4 py-1.5 rounded-full text-[10px] font-black">مرحل</span>
                </td>
              </tr>
            ))}
            {filteredItems.length === 0 && (
              <tr>
                <td colSpan={5} className="py-20 text-center text-slate-400 italic font-bold">لا توجد أرصدة إفتتاحية مسجلة.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
