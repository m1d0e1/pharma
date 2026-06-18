'use client'

import { useState, useEffect } from 'react'
import { PackageSearch, AlertTriangle, ShoppingCart, ArrowRight, Loader2, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { dbSelect } from '@/lib/db/tauri'

interface ReorderItem {
  drug_id: number
  trade_name: string
  current_stock: number
  reorder_point: number
  deficit: number
  avg_monthly_usage: number
  suggested_qty: number
}

export default function ReorderAlerts() {
  const [items, setItems] = useState<ReorderItem[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const loadReorderItems = async () => {
    setIsLoading(true)
    try {
      const results = await dbSelect(`
        WITH MonthlySales AS (
          SELECT 
            si.drug_id, 
            SUM(si.quantity_sold) as avg_monthly_usage
          FROM sales_items si
          JOIN sales_invoices inv ON si.invoice_id = inv.id
          WHERE si.is_negative = 0 
            AND inv.created_at >= datetime('now', '-30 days')
          GROUP BY si.drug_id
        ),
        RelevantDrugs AS (
          SELECT id as drug_id, reorder_point 
          FROM master_drugs 
          WHERE reorder_point > 0
          UNION
          SELECT drug_id, 0 as reorder_point 
          FROM MonthlySales
        ),
        StockInfo AS (
          SELECT drug_id, SUM(quantity) as current_stock
          FROM inventory
          GROUP BY drug_id
        )
        SELECT 
          rd.drug_id,
          md.trade_name, md.trade_name_en,
          md.active_ingredient, md.generic_name, md.manufacturer,
          md.reorder_point as manual_reorder_point,
          MAX(COALESCE(md.reorder_point, 0), COALESCE(ms.avg_monthly_usage, 0)) as dynamic_reorder_point,
          COALESCE(si.current_stock, 0) as current_stock,
          COALESCE(ms.avg_monthly_usage, 0) as avg_monthly_usage,
          (MAX(COALESCE(md.reorder_point, 0), COALESCE(ms.avg_monthly_usage, 0)) - COALESCE(si.current_stock, 0)) as deficit
        FROM RelevantDrugs rd
        JOIN master_drugs md ON rd.drug_id = md.id
        LEFT JOIN MonthlySales ms ON rd.drug_id = ms.drug_id
        LEFT JOIN StockInfo si ON rd.drug_id = si.drug_id
        WHERE COALESCE(si.current_stock, 0) <= MAX(COALESCE(md.reorder_point, 0), COALESCE(ms.avg_monthly_usage, 0))
          AND MAX(COALESCE(md.reorder_point, 0), COALESCE(ms.avg_monthly_usage, 0)) > 0
        ORDER BY deficit DESC
        LIMIT 50
      `);

      const { secureCache } = require('@/lib/cache/secure_cache');
      await secureCache.load();

      const enriched = secureCache.enrich(results.map((r: any) => ({ ...r, id: r.drug_id })));
      const mapped = results.map((item: any, idx: number) => {
        const limit = item.dynamic_reorder_point;
        const deficit = item.deficit;
        const suggestedQty = Math.max(limit * 2, deficit + limit);

        return {
          drug_id: item.drug_id,
          trade_name: enriched[idx]?.trade_name || item.trade_name || item.trade_name_en || item.active_ingredient || `صنف #${item.drug_id}`,
          current_stock: item.current_stock,
          reorder_point: limit,
          deficit: deficit,
          avg_monthly_usage: item.avg_monthly_usage,
          suggested_qty: suggestedQty
        };
      });

      setItems(mapped)
    } catch (e) {
      console.error('Failed to load reorder alerts', e)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadReorderItems()
  }, [])

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 p-8 shadow-xl">
        <div className="flex items-center justify-center gap-3 text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="font-bold text-sm">جاري تحميل تنبيهات النواقص...</span>
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 p-8 shadow-xl">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-emerald-100 dark:bg-emerald-900/30 rounded-2xl flex items-center justify-center">
            <PackageSearch className="w-6 h-6 text-emerald-600" />
          </div>
          <div>
            <h3 className="font-black text-lg">المخزون ممتاز ✅</h3>
            <p className="text-sm text-slate-500">جميع الأصناف فوق مستويات إعادة الطلب</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl overflow-hidden">
      <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-100 dark:bg-amber-900/30 rounded-2xl flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <h3 className="font-black text-lg">تنبيهات إعادة الطلب</h3>
            <p className="text-xs text-slate-400 font-bold">{items.length} أصناف تحتاج لتوفيرها</p>
          </div>
        </div>
        <button 
          onClick={loadReorderItems}
          className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-colors"
        >
          <RefreshCw className="w-4 h-4 text-slate-400" />
        </button>
      </div>

      <div className="divide-y divide-slate-50 dark:divide-slate-800 max-h-[300px] overflow-auto">
        {items.slice(0, 8).map(item => (
          <div key={item.drug_id} className="p-4 flex items-center justify-between hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
            <div className="flex-1 min-w-0">
              <p className="font-bold text-sm truncate">{item.trade_name}</p>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-[10px] font-black text-red-500 bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded">
                  المخزون: {item.current_stock}
                </span>
                <span className="text-[10px] font-bold text-slate-400">
                  الحد: {item.reorder_point}
                </span>
                {item.suggested_qty > 0 && (
                  <span className="text-[10px] font-black text-blue-600 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded">
                    المقترح: {item.suggested_qty}
                  </span>
                )}
              </div>
            </div>
            <Link 
              href={`/purchases/new?drugId=${item.drug_id}`}
              className="shrink-0 flex items-center gap-1 px-3 py-1.5 bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 rounded-xl text-[10px] font-black hover:bg-amber-200 dark:hover:bg-amber-900/40 transition-colors"
            >
              <ShoppingCart className="w-3 h-3" />
              طلب شراء
            </Link>
          </div>
        ))}
      </div>

      {items.length > 8 && (
        <Link 
          href="/inventory/low-stock" 
          className="flex items-center justify-center gap-2 p-4 bg-slate-50 dark:bg-slate-800/50 text-sm font-black text-slate-500 hover:text-amber-600 transition-colors"
        >
          عرض الكل ({items.length} صنف)
          <ArrowRight className="w-4 h-4 rtl:rotate-180" />
        </Link>
      )}
    </div>
  )
}
