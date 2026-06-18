'use client';

import React, { useEffect, useState } from 'react';
import { dbSelect } from '@/lib/db/tauri';

export default function DeadStockWidget() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadDeadStock() {
      try {
        const results = await dbSelect(`
          SELECT 
            MIN(i.id) as id, 
            SUM(i.quantity) as quantity, 
            i.drug_id, 
            m.trade_name, m.trade_name_en,
            m.active_ingredient, m.generic_name, m.manufacturer,
            (julianday('now') - julianday(
              COALESCE(
                (SELECT MAX(si.created_at) FROM sales_items si WHERE si.drug_id = i.drug_id),
                MIN(i.created_at)
              )
            )) / 30 as months_idle
          FROM inventory i
          JOIN master_drugs m ON i.drug_id = m.id
          WHERE i.quantity > 0 
          GROUP BY i.drug_id
          HAVING months_idle >= 1
          ORDER BY months_idle DESC
          LIMIT 5
        `);

        const { secureCache } = require('@/lib/cache/secure_cache');
        await secureCache.load();

        const enriched = secureCache.enrich(results.map((r: any) => ({ ...r, id: r.drug_id })));
        const mapped = results.map((item: any, idx: number) => ({
          ...item,
          drug_name: enriched[idx]?.trade_name || item.trade_name || item.active_ingredient || `صنف #${item.drug_id}`
        }));

        setItems(mapped);
      } catch (e) {
        console.error('Failed to load dead stock:', e);
      } finally {
        setLoading(false);
      }
    }

    loadDeadStock();
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
          <span className="text-2xl">🧊</span> تحليل الرواكد
        </h3>
        <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-xs font-bold">راكد</span>
      </div>

      <div className="space-y-4">
        {items.length === 0 ? (
          <p className="text-slate-400 text-center py-8">جميع الأصناف تتحرك بشكل جيد! 🚀</p>
        ) : (
          items.map(item => (
            <div key={item.id} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-700">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white dark:bg-slate-800 rounded-xl flex items-center justify-center shadow-sm">📦</div>
                <div>
                  <p className="font-bold text-slate-900 dark:text-white text-sm">{item.drug_name}</p>
                  <p className="text-[10px] text-slate-400">المتاح: {item.quantity}</p>
                </div>
              </div>
              <div className="text-left">
                <p className="text-indigo-600 font-black text-sm">{Math.floor(item.months_idle)} شهر</p>
                <p className="text-[10px] text-slate-400 font-bold uppercase">بدون مبيعات</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
