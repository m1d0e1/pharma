'use client'

import { useState, useEffect } from 'react'
import { PackageSearch, AlertTriangle, ShoppingCart, ArrowRight, Loader2, RefreshCw, ClipboardList, Warehouse } from 'lucide-react'
import Link from 'next/link'
import { toast } from 'react-hot-toast'
import { getLowStockAction } from '@/app/actions-client/inventory'
import { addToShortagesAction } from '@/app/actions-client/shortages'

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
  const [savingDrugId, setSavingDrugId] = useState<number | null>(null)

  const loadReorderItems = async () => {
    setIsLoading(true)
    try {
      const result = await getLowStockAction(10)
      if (!result.success) throw new Error(result.error || 'فشل تحميل تنبيهات إعادة الطلب')

      const mapped = (result.data || []).map((item: any) => {
        const deficit = Number(item.deficit || 0)
        const suggestedQty = Math.max(
          Number(item.default_purchase_qty || 1),
          deficit,
          Math.ceil(Number(item.avg_monthly_usage || 0)),
        )

        return {
          drug_id: item.drug_id,
          trade_name: item.trade_name_en || item.trade_name || item.active_ingredient || `صنف #${item.drug_id}`,
          current_stock: Number(item.quantity || 0),
          reorder_point: Number(item.reorder_point || 10),
          deficit,
          avg_monthly_usage: Number(item.avg_monthly_usage || 0),
          suggested_qty: Math.ceil(suggestedQty),
        }
      })

      setItems(mapped)
    } catch (e) {
      console.error('Failed to load reorder alerts', e)
    } finally {
      setIsLoading(false)
    }
  }

  const addToNotebook = async (item: ReorderItem) => {
    setSavingDrugId(item.drug_id)
    try {
      const result = await addToShortagesAction({ drug_id: item.drug_id, qty: item.suggested_qty })
      if (!result.success) throw new Error(result.error || 'فشل الإضافة')
      toast.success((result.data as any)?.created ? 'تمت الإضافة إلى كشكول النواقص' : 'تم تحديث الكمية في كشكول النواقص')
    } catch (error: any) {
      toast.error(error.message || 'فشل الإضافة إلى كشكول النواقص')
    } finally {
      setSavingDrugId(null)
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
            <div className="shrink-0 flex items-center gap-1.5">
              <Link
                href={`/inventory?search=${encodeURIComponent(item.trade_name)}`}
                className="p-2 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
                title="عرض في المخزون"
              >
                <Warehouse className="w-3.5 h-3.5" />
              </Link>
              <button
                onClick={() => addToNotebook(item)}
                disabled={savingDrugId === item.drug_id}
                className="flex items-center gap-1 px-3 py-2 bg-purple-100 dark:bg-purple-900/20 text-purple-700 dark:text-purple-400 rounded-xl text-[10px] font-black hover:bg-purple-200 dark:hover:bg-purple-900/40 transition-colors disabled:opacity-50"
              >
                {savingDrugId === item.drug_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ClipboardList className="w-3 h-3" />}
                كشكول
              </button>
              <Link
                href={`/purchases/new?drugId=${item.drug_id}`}
                className="flex items-center gap-1 px-3 py-2 bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 rounded-xl text-[10px] font-black hover:bg-amber-200 dark:hover:bg-amber-900/40 transition-colors"
              >
                <ShoppingCart className="w-3 h-3" />
                شراء
              </Link>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 bg-slate-50 dark:bg-slate-800/50">
        <Link 
          href="/inventory/low-stock" 
          className="flex items-center justify-center gap-2 p-4 text-sm font-black text-slate-500 hover:text-amber-600 transition-colors"
        >
          عرض الكل ({items.length} صنف)
          <ArrowRight className="w-4 h-4 rtl:rotate-180" />
        </Link>
        <Link
          href="/stores/shortages"
          className="flex items-center justify-center gap-2 p-4 border-r border-slate-200 dark:border-slate-700 text-sm font-black text-slate-500 hover:text-purple-600 transition-colors"
        >
          <ClipboardList className="w-4 h-4" />
          كشكول النواقص
        </Link>
      </div>
    </div>
  )
}
