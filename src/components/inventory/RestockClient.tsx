'use client'

import React from 'react'

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
    <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-right border-collapse">
          <thead>
            <tr className="bg-slate-50/50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
              <th className="px-8 py-5 text-sm font-bold text-slate-500">اسم الدواء</th>
              <th className="px-8 py-5 text-sm font-bold text-slate-500 text-center">الكمية الحالية</th>
              <th className="px-8 py-5 text-sm font-bold text-slate-500 text-center">الحد الأدنى</th>
              <th className="px-8 py-5 text-sm font-bold text-slate-500 text-center">الكمية المقترحة</th>
              <th className="px-8 py-5 text-sm font-bold text-slate-500">التكلفة التقديرية</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((item) => {
              const estimatedCost = item.suggested_order * item.master_drugs.official_price

              return (
                <tr key={item.id} className="group hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
                  <td className="px-8 py-5">
                    <div className="flex flex-col">
                      <span className="font-bold text-slate-900 dark:text-white">{item.master_drugs.trade_name}</span>
                      <span className="text-[10px] text-slate-400 font-bold uppercase">{item.master_drugs.manufacturer}</span>
                    </div>
                  </td>
                  <td className="px-8 py-5 text-center">
                    <span className={`px-3 py-1 rounded-full text-xs font-black ${item.quantity === 0 ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
                      {item.quantity}
                    </span>
                  </td>
                  <td className="px-8 py-5 text-center font-bold text-slate-400">
                    {item.min_stock_level}
                  </td>
                  <td className="px-8 py-5 text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <button 
                        type="button"
                        onClick={() => onUpdateQuantity(item.id, Math.max(0, item.suggested_order - 1))}
                        className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 font-black text-slate-600 dark:text-slate-350 transition-colors flex items-center justify-center select-none shadow-sm text-sm"
                      >
                        -
                      </button>
                      <input 
                        type="number" 
                        min="0"
                        value={item.suggested_order}
                        onChange={(e) => onUpdateQuantity(item.id, Math.max(0, parseInt(e.target.value) || 0))}
                        className="w-16 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-2 rounded-lg text-center font-black text-sm outline-none focus:ring-2 focus:ring-emerald-500"
                      />
                      <button 
                        type="button"
                        onClick={() => onUpdateQuantity(item.id, item.suggested_order + 1)}
                        className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 font-black text-slate-600 dark:text-slate-350 transition-colors flex items-center justify-center select-none shadow-sm text-sm"
                      >
                        +
                      </button>
                    </div>
                  </td>
                  <td className="px-8 py-5">
                    <span className="font-black text-slate-900 dark:text-white">
                      {estimatedCost.toLocaleString()} <span className="text-[10px] font-bold">ج.م</span>
                    </span>
                  </td>
                </tr>
              )
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="p-20 text-center">
                   <div className="flex flex-col items-center gap-4 opacity-20">
                     <span className="text-6xl">✅</span>
                     <p className="font-black text-xl">المخزون مكتمل! لا توجد نواقص حالياً.</p>
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
