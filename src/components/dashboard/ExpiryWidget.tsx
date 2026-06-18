'use client';

import React, { useEffect, useState } from 'react';
import { dbSelect } from '@/lib/db/tauri';

export default function ExpiryWidget() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadExpiringItems() {
      try {
        const thirtyDaysFromNow = new Date();
        thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);
        const dateStr = thirtyDaysFromNow.toISOString().split('T')[0];

        const results = await dbSelect(`
          SELECT i.id, i.expiry_date, i.drug_id, i.quantity,
                 m.trade_name, m.trade_name_en,
                 m.active_ingredient, m.generic_name, m.manufacturer,
                 (julianday(i.expiry_date) - julianday('now')) as days_left
          FROM inventory i
          JOIN master_drugs m ON i.drug_id = m.id
          WHERE i.expiry_date <= ? AND i.quantity > 0
          ORDER BY i.expiry_date ASC
          LIMIT 5
        `, [dateStr]);

        const { secureCache } = require('@/lib/cache/secure_cache');
        await secureCache.load();

        const enriched = secureCache.enrich(results.map((r: any) => ({ ...r, id: r.drug_id })));
        const mapped = results.map((item: any, idx: number) => ({
          ...item,
          drug_name: enriched[idx]?.trade_name || item.trade_name || item.active_ingredient || `صنف #${item.drug_id}`
        }));

        setItems(mapped);
      } catch (e) {
        console.error('Failed to load expiring items:', e);
      } finally {
        setLoading(false);
      }
    }

    loadExpiringItems();
  }, []);

  if (loading) {
    return (
      <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl h-full">
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-xl font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <span className="text-2xl">⏳</span> تنبيهات انتهاء الصلاحية
        </h3>
        <span className="bg-amber-100 text-amber-700 px-3 py-1 rounded-full text-xs font-bold">30 يوم</span>
      </div>

      <div className="space-y-4">
        {items.length === 0 ? (
          <p className="text-slate-400 text-center py-8">لا توجد أصناف قاربت على الانتهاء 👍</p>
        ) : (
          items.map(item => {
            const daysLeft = Math.ceil(item.days_left);
            return (
              <div key={item.id} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-700">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-white dark:bg-slate-800 rounded-xl flex items-center justify-center shadow-sm">💊</div>
                  <div>
                    <p className="font-bold text-slate-900 dark:text-white text-sm">{item.drug_name}</p>
                    <p className="text-[10px] text-slate-400">{item.expiry_date}</p>
                  </div>
                </div>
                <div className={`px-3 py-1 rounded-lg text-xs font-black ${daysLeft <= 7 ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
                {daysLeft <= 0 ? '!منتهية' : `${Math.abs(daysLeft)} يوم متبقي`}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
