'use client'

import React from 'react'
import { CheckCircle2, Minus, Plus } from 'lucide-react'

interface RestockItem {
  id: string
  quantity: number
  min_stock_level: number
  suggested_order: number
  master_drugs: {
    id: number
    trade_name: string
    official_price: number
    category: string
    manufacturer: string
  }
}

interface Props {
  items: RestockItem[]
  onUpdateQuantity: (id: string, qty: number) => void
}

export default function RestockClient({ items, onUpdateQuantity }: Props) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-right border-collapse">
          <thead>
            <tr className="bg-slate-50/50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
              <th className="px-4 py-3 text-xs font-semibold text-slate-600 dark:text-slate-300">اسم الدواء</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-600 dark:text-slate-300 text-center">الكمية الحالية</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-600 dark:text-slate-300 text-center">الحد الأدنى</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-600 dark:text-slate-300 text-center">الكمية المقترحة</th>
              <th className="px-4 py-3 text-xs font-semibold text-slate-600 dark:text-slate-300">التكلفة التقديرية</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((item) => {
              const estimatedCost = item.suggested_order * item.master_drugs.official_price

              return (
                <tr key={item.id} className="group hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex flex-col">
                      <span className="font-bold text-slate-900 dark:text-white">{item.master_drugs.trade_name}</span>
                      <span className="text-xs text-slate-500 font-bold">{item.master_drugs.manufacturer}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`px-3 py-1 rounded-full text-xs font-black ${item.quantity === 0 ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
                      {item.quantity}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center font-medium text-slate-500 dark:text-slate-400">
                    {item.min_stock_level}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <button 
                        type="button"
                        aria-label={`تقليل كمية طلب ${item.master_drugs.trade_name}`}
                        onClick={() => onUpdateQuantity(item.id, Math.max(0, item.suggested_order - 1))}
                        className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors flex items-center justify-center select-none"
                      >
                        <Minus className="w-4 h-4" aria-hidden="true" />
                      </button>
                      <input 
                        type="number" 
                        aria-label={`كمية الطلب المقترحة لـ ${item.master_drugs.trade_name}`}
                        min="0"
                        value={item.suggested_order}
                        onChange={(e) => onUpdateQuantity(item.id, Math.max(0, parseInt(e.target.value) || 0))}
                        className="w-16 h-9 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 px-2 rounded-lg text-center font-semibold text-sm outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-600"
                      />
                      <button 
                        type="button"
                        aria-label={`زيادة كمية طلب ${item.master_drugs.trade_name}`}
                        onClick={() => onUpdateQuantity(item.id, item.suggested_order + 1)}
                        className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors flex items-center justify-center select-none"
                      >
                        <Plus className="w-4 h-4" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-semibold text-slate-900 dark:text-white tabular-nums">
                      {estimatedCost.toLocaleString()} <span className="text-xs font-bold">ج.م</span>
                    </span>
                  </td>
                </tr>
              )
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="p-12 text-center">
                   <div className="flex flex-col items-center gap-3 text-slate-500 dark:text-slate-400">
                     <CheckCircle2 className="w-9 h-9 text-emerald-600" aria-hidden="true" />
                     <p className="font-semibold">لا توجد أصناف تحتاج إلى إعادة تموين حالياً.</p>
                   </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
