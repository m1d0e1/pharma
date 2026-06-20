'use client'
import { useHotkeys } from 'react-hotkeys-hook';

import { useState, useEffect } from 'react'
import { updateInventoryAction } from '@/app/actions/inventory'
import { toast } from 'react-hot-toast'

interface InventoryItem {
  id: string
  quantity: number
  local_selling_price: number
  expiry_date: string
  master_drugs: {
    trade_name: string
    large_to_medium?: number
  }
}

interface EditInventoryModalProps {
  item: InventoryItem
  onClose: () => void
  onSuccess: () => void
}

export default function EditInventoryModal({ item, onClose, onSuccess }: EditInventoryModalProps) {
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });

  const [quantity, setQuantity] = useState(item.quantity.toString())
  const [localPrice, setLocalPrice] = useState(item.local_selling_price.toString())
  const [expiryDate, setExpiryDate] = useState(item.expiry_date ? item.expiry_date.split('T')[0] : '')
  const [largeToMedium, setLargeToMedium] = useState(item.master_drugs?.large_to_medium?.toString() || '1')
  const [reasonId, setReasonId] = useState<string>('')
  const [reasons, setReasons] = useState<any[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    async function loadReasons() {
      const { getAdjustmentReasonsAction } = await import('@/app/actions/master-drugs')
      const res = await getAdjustmentReasonsAction()
      if (res.success) setReasons(res.data || [])
    }
    loadReasons()
  }, [])

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    // Prepare form data for Server Action
    const formData = {
      id: item.id,
      quantity: parseFloat(quantity),
      local_selling_price: parseFloat(localPrice),
      expiry_date: expiryDate || undefined,
      large_to_medium: largeToMedium ? parseInt(largeToMedium) : undefined,
      reason_id: reasonId ? parseInt(reasonId) : undefined
    }

    // Call Server Action
    const result = await updateInventoryAction(formData)

    setIsSubmitting(false)

    if (result.success) {
      toast.success('تم تحديث البيانات بنجاح')
      onSuccess()
      onClose()
    } else {
      toast.error(result.error || 'حدث خطأ أثناء التحديث')
    }
  }

  return (
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[110]" dir="rtl">
      <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-md overflow-hidden border border-slate-200 dark:border-slate-800 animate-in zoom-in duration-300">
        
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-6 flex justify-between items-center text-white">
          <div>
            <h2 className="text-xl font-black">تعديل الصنف</h2>
            <p className="text-blue-100 text-xs">{item.master_drugs.trade_name}</p>
          </div>
          <button onClick={onClose} className="text-2xl">&times;</button>
        </div>

        <form onSubmit={handleUpdate} className="p-8 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-500 mr-2">الكمية المتوفرة</label>
              <input
                type="number"
                required
                min="0"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none font-bold"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-500 mr-2">سعر البيع للعلبة (ج.م)</label>
              <input
                type="number"
                required
                step="0.01"
                value={localPrice}
                onChange={(e) => setLocalPrice(e.target.value)}
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none font-bold"
              />
            </div>
            
            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-500 mr-2">تاريخ الصلاحية</label>
              <input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none font-bold"
              />
            </div>
            
            <div className="space-y-1.5">
              <label className="text-xs font-black text-slate-500 mr-2">عدد الشرائط بالعلبة</label>
              <input
                type="number"
                min="1"
                value={largeToMedium}
                onChange={(e) => setLargeToMedium(e.target.value)}
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none font-bold"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-black text-slate-500 mr-2">سبب التعديل (اختياري)</label>
            <select
              value={reasonId}
              onChange={(e) => setReasonId(e.target.value)}
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none font-bold text-slate-700 dark:text-slate-300"
            >
              <option value="">-- اختر سبب التعديل --</option>
              {reasons.map((r: any) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 py-4 rounded-2xl font-bold transition-all"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-4 rounded-2xl font-bold shadow-lg shadow-blue-500/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'جاري الحفظ...' : 'حفظ التغييرات'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
