'use client';

import React, { useEffect, useState } from 'react';
import { dbSelect } from '@/lib/db/tauri';
import { getClientSession } from '@/lib/auth/local';

export default function DeadStockWidget() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    async function loadDeadStock() {
      setLoading(true);
      setLoadError(false);
      try {
        const user = await getClientSession();
        if (!user) {
          setLoadError(true);
          return;
        }
        const pharmacyId = user.pharmacy_id || 'local_default';
        const results = await dbSelect(`
          SELECT 
            MIN(i.id) as id, 
            SUM(i.quantity) as quantity, 
            i.drug_id, 
            m.trade_name, m.trade_name_en,
            m.active_ingredient, m.generic_name, m.manufacturer,
            (julianday('now') - julianday(
              COALESCE(
                (SELECT MAX(si.created_at)
                 FROM sales_items si
                 JOIN sales_invoices sinv ON sinv.id = si.invoice_id
                 WHERE si.drug_id = i.drug_id
                   AND (sinv.pharmacy_id = ? OR (sinv.pharmacy_id IS NULL AND ? = 'local_default'))),
                MIN(i.created_at)
              )
            )) / 30 as months_idle
          FROM inventory i
          JOIN master_drugs m ON i.drug_id = m.id
          WHERE i.quantity > 0
            AND (i.pharmacy_id = ? OR (i.pharmacy_id IS NULL AND ? = 'local_default'))
          GROUP BY i.drug_id
          HAVING months_idle >= 1
          ORDER BY months_idle DESC
          LIMIT 5
        `, [pharmacyId, pharmacyId, pharmacyId, pharmacyId]);

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
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    }

    loadDeadStock();
  }, [loadAttempt]);

  if (loading) {
    return (
      <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl h-full flex flex-col items-center justify-center gap-4 text-center">
        <p className="font-black text-slate-800 dark:text-slate-100">تعذر تحميل تحليل الرواكد</p>
        <button
          type="button"
          onClick={() => setLoadAttempt(attempt => attempt + 1)}
          className="px-4 py-2 rounded-xl bg-blue-600 text-white text-xs font-black hover:bg-blue-700"
        >
          إعادة المحاولة
        </button>
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
