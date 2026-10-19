'use client';

import React, { useEffect, useRef, useState } from 'react';
import { dbSelect } from '@/lib/db/tauri';
import { getClientSession, hasUserPermissionSync } from '@/lib/auth/local';
import { subscribeInventoryChanges } from '@/lib/inventory/refresh';
import { Package, Snowflake } from 'lucide-react';

export default function DeadStockWidget() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loadRequestRef = useRef(0);

  useEffect(() => {
    const requestId = ++loadRequestRef.current;
    async function loadDeadStock() {
      setLoading(true);
      setLoadError(false);
      setAccessDenied(false);
      try {
        const user = await getClientSession();
        if (requestId !== loadRequestRef.current) return;
        if (!user) {
          setLoadError(true);
          return;
        }
        if (!hasUserPermissionSync(user, 'can_view_stores')) {
          setAccessDenied(true);
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
                   AND (sinv.status IS NULL OR sinv.status = '' OR sinv.status IN ('completed', 'approved', 'delivered'))
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
        if (requestId !== loadRequestRef.current) return;

        const { secureCache } = require('@/lib/cache/secure_cache');
        await secureCache.load();
        if (requestId !== loadRequestRef.current) return;

        const enriched = secureCache.enrich(results.map((r: any) => ({ ...r, id: r.drug_id })));
        const mapped = results.map((item: any, idx: number) => ({
          ...item,
          drug_name: enriched[idx]?.trade_name || item.trade_name || item.active_ingredient || `صنف #${item.drug_id}`
        }));

        setItems(mapped);
      } catch (e) {
        if (requestId !== loadRequestRef.current) return;
        console.error('Failed to load dead stock:', e);
        setLoadError(true);
      } finally {
        if (requestId === loadRequestRef.current) setLoading(false);
      }
    }

    loadDeadStock();
  }, [loadAttempt]);

  useEffect(() => subscribeInventoryChanges(
    () => setLoadAttempt(attempt => attempt + 1)
  ), []);

  useEffect(() => () => {
    loadRequestRef.current += 1;
  }, []);

  if (loading) {
    return (
      <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm h-full flex items-center justify-center">
        <p className="font-black text-slate-500 dark:text-slate-300">غير مصرح بعرض بيانات المخزون</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm h-full flex flex-col items-center justify-center gap-4 text-center">
        <p className="font-black text-slate-800 dark:text-slate-100">تعذر تحميل تحليل الرواكد</p>
        <button
          type="button"
          onClick={() => setLoadAttempt(attempt => attempt + 1)}
          className="px-4 py-2 rounded-lg bg-primary-700 text-white text-xs font-semibold hover:bg-primary-800 transition-colors"
        >
          إعادة المحاولة
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm h-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-slate-900 dark:text-white flex items-center gap-2">
          <Snowflake className="w-5 h-5 text-blue-600" aria-hidden="true" /> تحليل الرواكد
        </h3>
        <span className="bg-blue-100 text-blue-700 px-3 py-1 rounded-full text-xs font-bold">راكد</span>
      </div>

      <div className="space-y-3">
        {items.length === 0 ? (
          <p className="text-slate-500 dark:text-slate-400 text-center py-8">لا توجد أصناف راكدة ضمن الفترة الحالية</p>
        ) : (
          items.map(item => (
            <div key={item.id} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-700">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 bg-white dark:bg-slate-800 rounded-lg flex items-center justify-center border border-slate-200 dark:border-slate-700 shrink-0"><Package className="w-4 h-4 text-slate-600 dark:text-slate-300" aria-hidden="true" /></div>
                <div>
                  <p className="font-semibold text-slate-900 dark:text-white text-sm truncate">{item.drug_name}</p>
                  <p className="text-xs text-slate-500">المتاح: {item.quantity}</p>
                </div>
              </div>
              <div className="text-left">
                <p className="text-indigo-600 font-black text-sm">{Math.floor(item.months_idle)} شهر</p>
                <p className="text-xs text-slate-500 font-bold">بدون مبيعات</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
