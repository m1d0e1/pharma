'use client'

import { useState, useEffect } from 'react'
import { AlertTriangle, CheckCircle2, Package, Search, Calendar, CreditCard, ChevronDown } from 'lucide-react'
import { toast } from 'react-hot-toast'
import { settleSaleItemAction, getDrugBatchesAction, getUnsettledSalesAction } from '@/app/actions/settlement'
import { format } from 'date-fns'
import { ar } from 'date-fns/locale'

interface UnsettledItem {
  item_id: number
  invoice_id: string
  drug_id: number
  trade_name: string
  trade_name_en?: string
  quantity_sold: number
  unit_price: number
  unit: string
  created_at?: string
  sale_date?: string
  current_stock_balance: number
}

interface Batch {
  id: string
  expiry_date: string
  quantity: number
  cost_price: number
}

const formatDateSafe = (dateVal: any) => {
  if (!dateVal) return '---'
  try {
    const d = new Date(dateVal)
    if (isNaN(d.getTime())) return '---'
    return format(d, 'PPP', { locale: ar })
  } catch (e) {
    return '---'
  }
}

export default function SettlementClient({ initialItems }: { initialItems: UnsettledItem[] }) {
  const [items, setItems] = useState<UnsettledItem[]>(initialItems)
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedItem, setSelectedItem] = useState<UnsettledItem | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  // Keep state synced if parent changes the items (e.g. initial load resolves)
  useEffect(() => {
    setItems(initialItems)
  }, [initialItems])

  const loadLatest = async (showToast = false) => {
    setIsRefreshing(true)
    try {
      const result = await getUnsettledSalesAction()
      if (result.success) {
        setItems(result.data as UnsettledItem[])
        if (showToast) toast.success('تم تحديث البيانات')
      } else {
        if (showToast) toast.error('فشل تحديث البيانات')
      }
    } catch (err) {
      console.error('Failed to sync data:', err)
      if (showToast) toast.error('حدث خطأ أثناء الاتصال بقاعدة البيانات')
    } finally {
      setIsRefreshing(false)
    }
  }

  // Automatic Background Refresh when Tab/Window Gains Focus
  useEffect(() => {
    const handleFocus = () => {
      loadLatest(false)
    }
    window.addEventListener('focus', handleFocus)
    return () => {
      window.removeEventListener('focus', handleFocus)
    }
  }, [])

  const filteredItems = items.filter(i => 
    (i.trade_name_en || i.trade_name).toLowerCase().includes(searchTerm.toLowerCase()) || 
    i.invoice_id.includes(searchTerm)
  )

  const handleOpenSettlement = async (item: UnsettledItem) => {
    setSelectedItem(item)
    const result = await getDrugBatchesAction(item.drug_id)
    if (result.success) {
      setBatches(result.data as Batch[])
      setIsModalOpen(true)
    } else {
      toast.error('فشل جلب دفعات المخزون')
    }
  }

  const handleSettle = async (batchId: string) => {
    if (!selectedItem) return
    setIsProcessing(true)
    
    const result = await settleSaleItemAction(selectedItem.item_id, batchId, selectedItem.quantity_sold)
    
    setIsProcessing(false)
    if (result.success) {
      toast.success('تمت التسوية بنجاح')
      setItems(prev => prev.filter(i => i.item_id !== selectedItem.item_id))
      setIsModalOpen(false)
      // Trigger a reload to refresh stock numbers after settlement
      loadLatest(false)
    } else {
      toast.error(result.error || 'حدث خطأ أثناء التسوية')
    }
  }

  return (
    <div className="space-y-6">
      {/* Search & Actions Bar */}
      <div className="flex flex-col md:flex-row gap-4 items-center">
        <div className="relative group flex-1 w-full">
          <div className="absolute inset-y-0 right-5 flex items-center pointer-events-none">
            <Search className="w-6 h-6 text-slate-400 group-focus-within:text-purple-500 transition-colors" />
          </div>
          <input
            type="text"
            placeholder="ابحث برقم الفاتورة أو اسم الصنف..."
            className="w-full bg-white dark:bg-slate-900 border-2 border-slate-100 dark:border-slate-800 p-5 pr-14 rounded-[30px] focus:ring-4 focus:ring-purple-500/10 focus:border-purple-500 outline-none transition-all font-black text-lg shadow-xl shadow-slate-200/20"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <button
          onClick={() => loadLatest(true)}
          disabled={isRefreshing}
          className="bg-white dark:bg-slate-900 border-2 border-slate-100 dark:border-slate-800 px-6 py-5 rounded-[30px] shadow-xl hover:bg-slate-50 dark:hover:bg-slate-800 transition-all font-black text-sm text-purple-600 dark:text-purple-400 flex items-center gap-2 disabled:opacity-50 h-[68px] w-full md:w-auto justify-center shrink-0"
        >
          <span className={`inline-block text-base ${isRefreshing ? 'animate-spin' : ''}`}>🔄</span>
          {isRefreshing ? 'جاري التحديث...' : 'تحديث البيانات'}
        </button>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-slate-900 rounded-[40px] shadow-2xl border border-slate-100 dark:border-slate-800 overflow-hidden">
        <table className="w-full text-right">
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
              <th className="p-6 font-black text-slate-500 uppercase tracking-widest text-[10px]">الصنف</th>
              <th className="p-6 font-black text-slate-500 uppercase tracking-widest text-[10px]">رقم الفاتورة</th>
              <th className="p-6 font-black text-slate-500 uppercase tracking-widest text-[10px]">الكمية المباعة</th>
              <th className="p-6 font-black text-slate-500 uppercase tracking-widest text-[10px]">رصيد المخزن الحالي</th>
              <th className="p-6 font-black text-slate-500 uppercase tracking-widest text-[10px]">التاريخ</th>
              <th className="p-6 font-black text-slate-500 uppercase tracking-widest text-[10px]">الإجراء</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
            {filteredItems.map((item) => (
              <tr key={item.item_id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors group">
                <td className="p-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-amber-100 dark:bg-amber-900/30 rounded-2xl flex items-center justify-center">
                      <AlertTriangle className="w-6 h-6 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                      <p className="font-black text-slate-900 dark:text-white">{item.trade_name_en || item.trade_name}</p>
                      {item.trade_name_en && (
                        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">{item.trade_name}</p>
                      )}
                      <p className="text-[10px] font-bold text-slate-400">ID: {item.drug_id}</p>
                    </div>
                  </div>
                </td>
                <td className="p-6">
                  <span className="bg-slate-100 dark:bg-slate-800 px-3 py-1.5 rounded-lg font-black text-xs">
                    #{item.invoice_id.split('-')[0]}...
                  </span>
                </td>
                <td className="p-6">
                  <div className="flex flex-col">
                    <span className="font-black text-rose-600 dark:text-rose-400 text-lg">{item.quantity_sold}</span>
                    <span className="text-[10px] font-bold text-slate-400">وحدة: {item.unit === 'large' ? 'كبرى' : item.unit === 'medium' ? 'متوسطة' : 'صغرى'}</span>
                  </div>
                </td>
                <td className="p-6">
                  <div className={Number(item.current_stock_balance) > 0 ? "text-emerald-600 font-black" : "text-slate-400 font-bold"}>
                    {Number(item.current_stock_balance) > 0 
                      ? `${Number(item.current_stock_balance).toFixed(2).replace(/\.?0+$/, '')} متوفر` 
                      : 'لا يوجد رصيد'}
                  </div>
                </td>
                <td className="p-6 text-sm font-bold text-slate-500">
                  {formatDateSafe(item.created_at || (item as any).sale_date)}
                </td>
                <td className="p-6">
                  <button
                    onClick={() => handleOpenSettlement(item)}
                    className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-2xl font-black text-sm transition-all shadow-lg shadow-purple-500/20 active:scale-95"
                  >
                    تسوية الآن
                  </button>
                </td>
              </tr>
            ))}
            {filteredItems.length === 0 && (
              <tr>
                <td colSpan={6} className="p-20 text-center">
                  <div className="flex flex-col items-center">
                    <CheckCircle2 className="w-16 h-16 text-emerald-500 mb-4 opacity-20" />
                    <p className="text-slate-400 font-black text-xl">لا يوجد مبيعات معلقة للتسوية</p>
                    <p className="text-slate-500 text-sm mt-2">جميع المبيعات مرتبطة بأرصدة مخزنية صحيحة.</p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Settlement Modal */}
      {isModalOpen && selectedItem && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md flex items-center justify-center p-4 z-[250]" dir="rtl">
          <div className="bg-white dark:bg-slate-900 rounded-[40px] shadow-2xl w-full max-w-xl overflow-hidden border border-white/20 animate-in zoom-in duration-300">
            <div className="bg-gradient-to-r from-purple-600 to-indigo-600 p-8 flex justify-between items-center text-white">
              <div>
                <h2 className="text-2xl font-black">اختيار دفعة التسوية</h2>
                <p className="text-purple-100 text-sm mt-1 font-bold">للصنف: {selectedItem.trade_name_en || selectedItem.trade_name}</p>
              </div>
              <button onClick={() => setIsModalOpen(false)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                <ChevronDown className="w-8 h-8 rotate-180" />
              </button>
            </div>

            <div className="p-8 space-y-6 max-h-[60vh] overflow-y-auto custom-scrollbar">
              <div className="bg-amber-50 dark:bg-amber-900/20 p-4 rounded-2xl border border-amber-100 dark:border-amber-900/30 flex gap-4">
                 <AlertTriangle className="w-6 h-6 text-amber-600 shrink-0" />
                 <p className="text-xs font-bold text-amber-800 dark:text-amber-400">
                   سيتم خصم <b>{selectedItem.quantity_sold}</b> {selectedItem.unit === 'large' ? 'وحدة كبرى' : 'وحدة'} من الدفعة المختارة وتغيير حالة الفاتورة لتصبح "مستقرة".
                 </p>
              </div>

              <div className="space-y-4">
                <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2">الدفعات المتوفرة</h3>
                {batches.length > 0 ? (
                  batches.map(batch => (
                    <button
                      key={batch.id}
                      disabled={isProcessing}
                      onClick={() => handleSettle(batch.id)}
                      className="w-full text-right p-6 bg-slate-50 dark:bg-slate-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 border-2 border-transparent hover:border-emerald-500 rounded-3xl transition-all group flex justify-between items-center"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                           <Package className="w-4 h-4 text-slate-400 group-hover:text-emerald-500" />
                           <span className="font-black text-slate-900 dark:text-white">دفعة: {batch.id.substring(0, 8)}</span>
                        </div>
                        <div className="flex gap-4 text-[10px] font-bold text-slate-400">
                           <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> انتهاء: {batch.expiry_date || '---'}</span>
                           <span className="flex items-center gap-1"><CreditCard className="w-3 h-3" /> سعر الشراء: {batch.cost_price}</span>
                        </div>
                      </div>
                      <div className="text-left">
                        <div className="font-black text-emerald-600 dark:text-emerald-400 text-lg">{batch.quantity}</div>
                        <div className="text-[10px] font-bold text-slate-400 uppercase">الرصيد المتاح</div>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="p-10 text-center bg-slate-50 dark:bg-slate-800 rounded-3xl">
                     <p className="font-bold text-slate-400">لا توجد أرصدة متوفرة حالياً لهذا الصنف.</p>
                     <p className="text-xs text-slate-500 mt-1">يرجى إضافة توريد جديد أولاً.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="p-8 border-t border-slate-100 dark:border-slate-800 flex gap-4">
               <button
                 onClick={() => setIsModalOpen(false)}
                 className="flex-1 py-4 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-2xl font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
               >
                 إلغاء
               </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
