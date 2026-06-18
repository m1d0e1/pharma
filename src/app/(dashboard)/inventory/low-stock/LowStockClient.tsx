'use client'

import React, { useState } from 'react'
import { 
  Search, 
  ArrowLeft, 
  ShoppingCart, 
  ExternalLink,
  ChevronRight,
  TrendingDown,
  Printer,
  Package
} from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

interface LowStockItem {
  id: string
  drug_id: number
  quantity: number
  local_selling_price: number
  expiry_date: string
  trade_name: string
  trade_name_en?: string
  active_ingredient: string
  official_price: number
  manufacturer: string
}

interface Props {
  initialItems: LowStockItem[]
}

export default function LowStockClient({ initialItems }: Props) {
  const [searchTerm, setSearchTerm] = useState('')

  const filteredItems = initialItems.filter(item => 
    item.trade_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (item.trade_name_en && item.trade_name_en.toLowerCase().includes(searchTerm.toLowerCase())) ||
    item.active_ingredient?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.manufacturer?.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const handlePrint = () => {
    window.print()
  }

  return (
    <div className="space-y-6" dir="rtl">
      {/* Search & Actions Bar */}
      <div className="flex flex-col md:flex-row gap-4 items-center no-print">
        <div className="relative flex-1 group">
          <Search className="absolute right-5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
          <input 
            type="text"
            placeholder="ابحث في النواقص..."
            className="w-full pr-14 pl-6 py-5 bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm focus:ring-4 focus:ring-blue-500/5 outline-none transition-all font-bold text-lg"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        
        <div className="flex gap-3">
          <button 
            onClick={handlePrint}
            className="p-5 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm hover:bg-slate-50 transition-all flex items-center gap-3 font-black"
          >
            <Printer className="w-6 h-6" />
            <span>طباعة القائمة</span>
          </button>
          
          <Link 
            href="/inventory"
            className="p-5 bg-blue-600 text-white rounded-3xl shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all flex items-center gap-3 font-black"
          >
            <ArrowLeft className="w-6 h-6 rotate-180" />
            <span>العودة للمخزون</span>
          </Link>
        </div>
      </div>

      {/* Grid Layout for Low Stock Items */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredItems.map((item) => (
          <div key={item.id} className="group bg-white dark:bg-slate-900 p-6 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all relative overflow-hidden">
             {/* Progress indicator bg */}
             <div className="absolute bottom-0 left-0 h-1.5 bg-red-500/20 w-full">
                <div 
                  className="h-full bg-red-600 shadow-[0_0_10px_rgba(220,38,38,0.5)]" 
                  style={{ width: `${Math.min((item.quantity / 15) * 100, 100)}%` }}
                ></div>
             </div>

             <div className="flex justify-between items-start mb-6">
                <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-2xl">
                   <TrendingDown className="w-6 h-6 text-red-600" />
                </div>
                <div className="px-4 py-2 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-100 dark:border-slate-700">
                   <span className="text-sm font-black text-slate-500">الكمية: </span>
                   <span className="text-xl font-black text-red-600">{item.quantity}</span>
                </div>
             </div>

             <div className="space-y-1 mb-6">
                <h3 className="text-xl font-black text-slate-900 dark:text-white group-hover:text-blue-600 transition-colors leading-tight">
                  {item.trade_name_en || item.trade_name}
                </h3>
                <p className="text-xs font-bold text-slate-400 truncate">{item.active_ingredient}</p>
             </div>

             <div className="grid grid-cols-2 gap-3 pt-6 border-t border-slate-50 dark:border-slate-800">
                <div className="space-y-1">
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">الشركة</p>
                   <p className="text-xs font-bold text-slate-700 dark:text-slate-300 truncate">{item.manufacturer || 'غير مسجل'}</p>
                </div>
                <div className="space-y-1 text-left">
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">السعر</p>
                   <p className="text-sm font-black text-emerald-600">{item.local_selling_price} ج.م</p>
                </div>
             </div>

             <div className="mt-8 flex gap-2 no-print">
                <Link 
                   href={`/purchases/new?drugId=${item.drug_id}`}
                   className="flex-1 bg-slate-50 dark:bg-slate-800 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-slate-600 dark:text-slate-400 hover:text-blue-600 py-3 rounded-2xl font-black text-xs transition-all flex items-center justify-center gap-2"
                >
                   <ShoppingCart className="w-4 h-4" />
                   طلب شراء
                </Link>
                <Link 
                   href={`/inventory?search=${encodeURIComponent(item.trade_name_en || item.trade_name)}`}
                   className="p-3 bg-slate-50 dark:bg-slate-800 text-slate-400 hover:text-slate-600 rounded-2xl transition-all flex items-center justify-center"
                >
                   <ExternalLink className="w-4 h-4" />
                </Link>
             </div>
          </div>
        ))}

        {filteredItems.length === 0 && (
          <div className="col-span-full py-20 bg-white dark:bg-slate-900 rounded-[3rem] border-2 border-dashed border-slate-100 dark:border-slate-800 flex flex-col items-center justify-center gap-4 text-slate-300">
             <Package className="w-20 h-20 opacity-20" />
             <p className="text-2xl font-black italic">لا توجد نواقص تطابق بحثك</p>
          </div>
        )}
      </div>

      {/* Print styles */}
      <style jsx global>{`
        @media print {
          .no-print, nav, button, .flex-col-md-row { display: none !important; }
          .bg-white { border: none !important; }
          body { background: white !important; font-size: 12pt; }
          .grid { display: block !important; }
          .group { border: 1px solid #eee !important; margin-bottom: 10px !important; break-inside: avoid; }
        }
      `}</style>
    </div>
  )
}
