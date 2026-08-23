'use client'

import React, { useState } from 'react'
import { FileText, Search, CheckCircle2, Clock, AlertCircle, Package, Printer, RefreshCw, Loader2, Warehouse } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'react-hot-toast'
import Link from 'next/link'
import { getShortagesAction, syncLowStockToShortagesAction, updateShortageStatusAction } from '@/app/actions-client/shortages'

export default function ShortagesClient({ initialData }: { initialData: any[] }) {
  const [data, setData] = useState(initialData)
  const [search, setSearch] = useState('')
  const [isSyncing, setIsSyncing] = useState(false)

  const filtered = data.filter(item => 
    (item.trade_name || '').toLowerCase().includes(search.toLowerCase()) ||
    (item.trade_name_en && item.trade_name_en.toLowerCase().includes(search.toLowerCase())) ||
    (item.generic_name && item.generic_name.toLowerCase().includes(search.toLowerCase()))
  )

  const reload = async () => {
    const result = await getShortagesAction()
    if (!result.success) throw new Error(result.error || 'فشل تحميل النواقص')
    setData(result.data || [])
  }

  const handleStatusUpdate = async (id: number, newStatus: string) => {
    try {
      const result = await updateShortageStatusAction(id, newStatus)
      if (!result.success) throw new Error(result.error || 'فشل تحديث الحالة')
      setData(prev => newStatus === 'received'
        ? prev.filter(item => item.id !== id)
        : prev.map(item => item.id === id ? { ...item, status: newStatus } : item))
      toast.success('تم تحديث الحالة بنجاح')
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || 'فشل تحديث الحالة')
    }
  }

  const handleSync = async () => {
    setIsSyncing(true)
    try {
      const result = await syncLowStockToShortagesAction()
      if (!result.success) throw new Error(result.error || 'فشل مزامنة المخزون')
      await reload()
      const summary = result.data as any
      if (summary.total === 0) toast.success('المخزون بحالة جيدة، لا توجد نواقص جديدة')
      else toast.success(`تمت مزامنة ${summary.total} صنف مع المخزون`)
    } catch (err: any) {
      console.error(err)
      toast.error(err.message || 'فشل مزامنة المخزون')
    } finally {
      setIsSyncing(false)
    }
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] shadow-hard border border-slate-100 dark:border-slate-800 flex justify-between items-center relative overflow-hidden">
        <div className="relative z-10">
          <div className="flex items-center gap-4 mb-2">
            <div className="w-12 h-12 bg-primary-600 rounded-2xl flex items-center justify-center text-white shadow-lg">
              <FileText className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-black text-slate-900 dark:text-white">كشكول النواقص</h1>
              <p className="text-slate-500 font-bold">تسجيل ومتابعة الأصناف الغير متوفرة لطلبها</p>
            </div>
          </div>
        </div>
        <div className="absolute left-[-20px] top-[-20px] w-64 h-64 bg-primary-500/5 rounded-full blur-3xl" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between no-print">
        <div className="relative w-full md:w-96">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
          <input 
            type="text" 
            placeholder="بحث في النواقص..."
            className="w-full pr-12 pl-4 py-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-3xl shadow-soft focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none font-bold transition-all"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        
        <div className="flex flex-wrap gap-4">
           <button
             onClick={handleSync}
             disabled={isSyncing}
             className="bg-purple-50 text-purple-600 hover:bg-purple-600 hover:text-white px-8 py-4 rounded-3xl font-black shadow-lg transition-all flex items-center gap-3 active:scale-95 disabled:opacity-50"
           >
             {isSyncing ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCw className="w-5 h-5" />}
             مزامنة مع المخزون
           </button>

           <button 
             onClick={() => window.print()}
             className="bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-100 dark:border-slate-800 hover:bg-slate-50 px-8 py-4 rounded-3xl font-black shadow-sm transition-all flex items-center gap-3 active:scale-95"
           >
             <Printer className="w-5 h-5" />
             طباعة النواقص
           </button>

           <Link
             href="/inventory/low-stock"
             className="bg-primary-600 hover:bg-primary-700 text-white px-8 py-4 rounded-3xl font-black shadow-lg shadow-primary-500/20 transition-all flex items-center gap-3 active:scale-95"
           >
             <Warehouse className="w-5 h-5" />
             عرض نواقص المخزون
           </Link>
        </div>
      </div>

      {/* List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filtered.length > 0 ? (
          filtered.map((item) => (
            <div 
              key={item.id}
              className="bg-white dark:bg-slate-900 p-6 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-soft hover:shadow-hard transition-all duration-300 flex flex-col gap-4 group"
            >
              <div className="flex justify-between items-start">
                <div className="flex-1">
                  <h3 className="font-black text-slate-900 dark:text-white text-lg group-hover:text-primary-600 transition-colors leading-tight">
                    {item.trade_name_en || item.trade_name}
                  </h3>
                  <p className="text-slate-400 font-bold text-[10px] mt-1">{item.trade_name_en ? item.trade_name : (item.generic_name || 'بدون إسم علمي')}</p>
                </div>
                <div className={cn(
                  "px-4 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider",
                  item.status === 'pending' ? "bg-amber-100 text-amber-600" : "bg-blue-100 text-blue-600"
                )}>
                  {item.status === 'pending' ? 'مطلوب' : 'قيد الطلب'}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 py-3 border-y border-slate-50 dark:border-slate-800 text-center">
                <div className="rounded-xl bg-slate-50 dark:bg-slate-800 p-2">
                  <span className="block text-[9px] font-black text-slate-400">الرصيد الحالي</span>
                  <span className={cn('text-sm font-black', Number(item.current_stock) <= 0 ? 'text-red-600' : 'text-slate-700 dark:text-slate-200')}>
                    {Number(item.current_stock || 0).toLocaleString('ar-EG')}
                  </span>
                </div>
                <div className="rounded-xl bg-slate-50 dark:bg-slate-800 p-2">
                  <span className="block text-[9px] font-black text-slate-400">حد إعادة الطلب</span>
                  <span className="text-sm font-black text-amber-600">{Number(item.reorder_point || 0).toLocaleString('ar-EG')}</span>
                </div>
                <div className="rounded-xl bg-red-50 dark:bg-red-900/10 p-2">
                  <span className="block text-[9px] font-black text-slate-400">العجز</span>
                  <span className="text-sm font-black text-red-600">{Number(item.deficit || 0).toLocaleString('ar-EG')}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-4 text-slate-500 text-xs font-bold">
                <div className="flex items-center gap-1.5">
                  <Package className="w-4 h-4 text-primary-500" />
                  <span>الكمية المطلوبة: {item.requested_quantity}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-slate-400" />
                  <span>{new Date(item.created_at).toLocaleDateString('ar-EG')}</span>
                </div>
                <span className={cn(
                  'mr-auto px-2 py-1 rounded-lg text-[9px] font-black',
                  item.inventory_status === 'sufficient'
                    ? 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                    : item.inventory_status === 'out_of_stock'
                      ? 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400'
                )}>
                  {item.inventory_status === 'sufficient' ? 'تم توفير المخزون' : item.inventory_status === 'out_of_stock' ? 'نافد' : 'أقل من الحد'}
                </span>
              </div>

              <div className="flex gap-2 mt-2 no-print">
                {item.status === 'pending' && (
                  <button 
                    onClick={() => handleStatusUpdate(item.id, 'ordered')}
                    className="flex-1 bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white py-3 rounded-2xl font-black text-xs transition-all flex items-center justify-center gap-2"
                  >
                    <Clock className="w-4 h-4" />
                    تم الطلب
                  </button>
                )}
                <button 
                  onClick={() => handleStatusUpdate(item.id, 'received')}
                  className="flex-1 bg-green-50 text-green-600 hover:bg-green-600 hover:text-white py-3 rounded-2xl font-black text-xs transition-all flex items-center justify-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  تم الاستلام
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="col-span-full py-20 flex flex-col items-center justify-center text-slate-400 gap-4 bg-white/50 dark:bg-slate-900/50 rounded-[40px] border-2 border-dashed border-slate-200 dark:border-slate-800">
            <AlertCircle className="w-16 h-16 opacity-20" />
            <p className="font-black text-xl">لا توجد أصناف ناقصة حالياً</p>
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
