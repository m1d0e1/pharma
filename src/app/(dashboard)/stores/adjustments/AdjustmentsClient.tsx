'use client'

import React, { useState } from 'react'
import { Activity, Search, RefreshCcw, AlertTriangle, Package, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dbSelect, dbExecute, dbTransaction } from '@/lib/db/tauri'
import { getClientSession } from '@/lib/auth/local'
import { toast } from 'react-hot-toast'

export default function AdjustmentsClient({ reasons }: { reasons: any[] }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [selectedItem, setSelectedItem] = useState<any>(null)
  const [newQty, setNewQty] = useState<number>(0)
  const [selectedReason, setSelectedReason] = useState<number>(0)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSearch = async (q: string) => {
    setQuery(q)
    if (q.length > 2) {
      try {
        const searchPattern = `%${q}%`;
        const data = await dbSelect(`
          SELECT i.*, m.trade_name, m.trade_name_en, m.generic_name, m.barcode
          FROM inventory i
          JOIN master_drugs m ON i.drug_id = m.id
          WHERE (m.trade_name LIKE ? OR m.trade_name_en LIKE ? OR m.barcode LIKE ?)
          LIMIT 20
        `, [searchPattern, searchPattern, searchPattern]);
        setResults(data);
      } catch (err) {
        console.error('Failed to search inventory:', err);
      }
    } else {
      setResults([])
    }
  }

  const handleSelectItem = (item: any) => {
    setSelectedItem(item)
    setNewQty(item.quantity)
    setQuery('')
    setResults([])
  }

  const handleSubmit = async () => {
    if (!selectedItem || !selectedReason) {
      toast.error('يرجى اختيار الصنف وسبب التسوية')
      return
    }

    setIsSubmitting(true)
    try {
      const user = await getClientSession();
      const userId = user?.id || 'system';

      await dbTransaction(async () => {
        // 1. Record stock adjustment
        await dbExecute(`
          INSERT INTO stock_adjustments (inventory_id, reason_id, old_quantity, new_quantity, user_id)
          VALUES (?, ?, ?, ?, ?)
        `, [selectedItem.id, selectedReason, selectedItem.quantity, newQty, userId]);

        // 2. Update inventory quantity
        await dbExecute(`
          UPDATE inventory SET quantity = ? WHERE id = ?
        `, [newQty, selectedItem.id]);
      });

      toast.success('تمت تسوية الكمية بنجاح')
      setSelectedItem(null)
      setSelectedReason(0)
    } catch (err: any) {
      console.error('Adjustment failed:', err);
      toast.error(err.message || 'فشل إجراء التسوية')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] shadow-hard border border-slate-100 dark:border-slate-800 flex justify-between items-center relative overflow-hidden">
        <div className="relative z-10">
          <div className="flex items-center gap-4 mb-2">
            <div className="w-12 h-12 bg-primary-600 rounded-2xl flex items-center justify-center text-white shadow-lg">
              <Activity className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-black text-slate-900 dark:text-white">تسوية الكميات</h1>
              <p className="text-slate-500 font-bold">تعديل أرصدة المخزون يدوياً مع ذكر الأسباب</p>
            </div>
          </div>
        </div>
        <div className="absolute left-[-20px] top-[-20px] w-64 h-64 bg-primary-500/5 rounded-full blur-3xl" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Step 1: Find Item */}
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-soft">
            <h2 className="font-black text-lg mb-6 flex items-center gap-3 text-slate-800 dark:text-white">
              <div className="w-8 h-8 bg-slate-100 dark:bg-slate-800 rounded-lg flex items-center justify-center text-slate-500 font-black text-sm">١</div>
              البحث عن الصنف بالمخزون
            </h2>
            
            <div className="relative">
              <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input 
                type="text"
                placeholder="إسم الصنف أو الباركود..."
                className="w-full pr-12 pl-4 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
                value={query}
                onChange={(e) => handleSearch(e.target.value)}
              />
              {results.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-2 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-2xl shadow-hard z-50 overflow-hidden">
                  {results.map((item) => (
                    <button 
                      key={item.id}
                      onClick={() => handleSelectItem(item)}
                      className="w-full p-4 text-right hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-all border-b border-slate-50 dark:border-slate-800 last:border-0"
                    >
                      <div className="font-black text-slate-900 dark:text-white">{item.trade_name_en || item.trade_name}</div>
                      <div className="flex justify-between items-center mt-1">
                        <span className="text-[10px] text-slate-400 font-bold uppercase">{item.barcode || 'بدون باركود'}</span>
                        <span className="text-xs font-black text-primary-600">الرصيد: {item.quantity}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedItem && (
              <div className="mt-6 p-4 bg-primary-50 dark:bg-primary-900/10 rounded-2xl border border-primary-100 dark:border-primary-900/20 animate-in zoom-in-95">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-white dark:bg-slate-800 rounded-xl flex items-center justify-center text-primary-600 shadow-sm">
                    <Package className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="font-black text-slate-900 dark:text-white">{selectedItem.trade_name_en || selectedItem.trade_name}</div>
                    <div className="text-xs font-bold text-slate-500">الرصيد الحالي: {selectedItem.quantity}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Step 2: Adjust */}
        <div className={cn("space-y-6 transition-all duration-500", !selectedItem && "opacity-30 pointer-events-none grayscale")}>
          <div className="bg-white dark:bg-slate-900 p-8 rounded-[32px] border border-slate-100 dark:border-slate-800 shadow-soft">
            <h2 className="font-black text-lg mb-6 flex items-center gap-3 text-slate-800 dark:text-white">
              <div className="w-8 h-8 bg-slate-100 dark:bg-slate-800 rounded-lg flex items-center justify-center text-slate-500 font-black text-sm">٢</div>
              تعديل الكمية والسبب
            </h2>

            <div className="space-y-6">
              <div>
                <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-3 mr-2">الكمية الجديدة</label>
                <input 
                  type="number"
                  className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-black text-2xl text-center outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
                  value={newQty}
                  onChange={(e) => setNewQty(parseInt(e.target.value) || 0)}
                />
              </div>

              <div>
                <label className="block text-xs font-black text-slate-400 uppercase tracking-widest mb-3 mr-2">سبب التسوية</label>
                <select 
                  className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
                  value={selectedReason}
                  onChange={(e) => setSelectedReason(parseInt(e.target.value))}
                >
                  <option value={0}>اختر السبب...</option>
                  {reasons.map(reason => (
                    <option key={reason.id} value={reason.id}>{reason.name_ar}</option>
                  ))}
                </select>
              </div>

              <div className={cn(
                "p-4 rounded-2xl border flex items-start gap-3",
                newQty > (selectedItem?.quantity || 0) 
                  ? "bg-blue-50 border-blue-100 text-blue-700" 
                  : "bg-amber-50 border-amber-100 text-amber-700"
              )}>
                <AlertTriangle className="w-5 h-5 mt-0.5" />
                <div className="text-xs font-bold leading-relaxed">
                  سيتم {newQty > (selectedItem?.quantity || 0) ? 'زيادة' : 'تقليل'} الرصيد بمقدار {Math.abs(newQty - (selectedItem?.quantity || 0))} وحدة. 
                  هذا الإجراء سيؤثر على قيمة المخزون الحالية.
                </div>
              </div>

              <button 
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="w-full bg-primary-600 hover:bg-primary-700 disabled:bg-slate-200 text-white py-5 rounded-[24px] font-black shadow-lg shadow-primary-500/20 transition-all flex items-center justify-center gap-3 active:scale-95"
              >
                {isSubmitting ? <RefreshCcw className="w-6 h-6 animate-spin" /> : <CheckCircle2 className="w-6 h-6" />}
                تنفيذ التسوية
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
