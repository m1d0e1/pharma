'use client'
import { useHotkeys } from 'react-hotkeys-hook';

import { useState, useEffect, useCallback, useRef } from 'react'
import { updateInventoryAction } from '@/app/actions-client/inventory'
import { toast } from 'react-hot-toast'

interface InventoryItem {
  id: string
  quantity: number
  local_selling_price: number
  strips_per_box?: number | null
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
  const [quantity, setQuantity] = useState(item.quantity.toString())
  const [localPrice, setLocalPrice] = useState(item.local_selling_price.toString())
  const [expiryDate, setExpiryDate] = useState(item.expiry_date ? item.expiry_date.split('T')[0] : '')
  const initialConversion = Number(item.strips_per_box) > 0 ? Number(item.strips_per_box) : (item.master_drugs?.large_to_medium || 1)
  const [largeToMedium, setLargeToMedium] = useState(initialConversion.toString())
  const [reasonId, setReasonId] = useState<string>('')
  const [reasons, setReasons] = useState<any[]>([])
  const [reasonsLoading, setReasonsLoading] = useState(false)
  const [reasonsLoadError, setReasonsLoadError] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const reasonsRequestRef = useRef(0)
  const submissionRef = useRef(false)

  const handleClose = () => {
    if (submissionRef.current) return
    onClose()
  }
  useHotkeys('esc', handleClose, { enableOnFormTags: true });
  const parsedQuantity = Number(quantity)
  const quantityChanged = Number.isFinite(parsedQuantity) && parsedQuantity !== Number(item.quantity)

  const loadReasons = useCallback(async () => {
    const requestId = ++reasonsRequestRef.current
    setReasonsLoading(true)
    setReasonsLoadError(false)

    try {
      const { getAdjustmentReasonsAction } = await import('@/app/actions-client/master-drugs')
      const res = await getAdjustmentReasonsAction()
      if (reasonsRequestRef.current !== requestId) return

      if (res.success) {
        setReasons(res.data || [])
      } else {
        setReasonsLoadError(true)
      }
    } catch {
      if (reasonsRequestRef.current === requestId) {
        setReasonsLoadError(true)
      }
    } finally {
      if (reasonsRequestRef.current === requestId) {
        setReasonsLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadReasons()
    return () => {
      reasonsRequestRef.current += 1
    }
  }, [loadReasons])

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (quantityChanged && !reasonId) {
      toast.error('يجب اختيار سبب عند تعديل الكمية')
      return
    }

    if (submissionRef.current) return
    submissionRef.current = true
    setIsSubmitting(true)

    // Prepare form data for Server Action
    const formData = {
      id: item.id,
      quantity: parseFloat(quantity),
      local_selling_price: parseFloat(localPrice),
      expiry_date: expiryDate || undefined,
      large_to_medium: Number(largeToMedium) !== initialConversion ? Number(largeToMedium) : undefined,
      reason_id: reasonId ? parseInt(reasonId) : undefined
    }

    let result: Awaited<ReturnType<typeof updateInventoryAction>> | undefined
    try {
      result = await updateInventoryAction(formData)
    } catch {
      toast.error('حدث خطأ أثناء التحديث')
    } finally {
      submissionRef.current = false
      setIsSubmitting(false)
    }

    if (!result) return

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
          <button onClick={handleClose} disabled={isSubmitting} className="text-2xl disabled:opacity-50 disabled:cursor-not-allowed">&times;</button>
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
            <label className="text-xs font-black text-slate-500 mr-2">
              {quantityChanged ? 'سبب التعديل (مطلوب عند تغيير الكمية)' : 'سبب التعديل (اختياري)'}
            </label>
            <select
              value={reasonId}
              onChange={(e) => setReasonId(e.target.value)}
              required={quantityChanged}
              disabled={reasonsLoading}
              className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none font-bold text-slate-700 dark:text-slate-300"
            >
              <option value="">-- اختر سبب التعديل --</option>
              {reasons.map((r: any) => (
                <option key={r.id} value={r.id}>{r.name_ar || r.name_en || r.reason || `#${r.id}`}</option>
              ))}
            </select>
            {reasonsLoadError && (
              <div className="flex items-center justify-between gap-3 text-xs font-bold text-red-600">
                <span>تعذر تحميل أسباب التعديل</span>
                <button
                  type="button"
                  onClick={() => void loadReasons()}
                  disabled={reasonsLoading}
                  className="rounded-lg border border-red-200 px-3 py-1.5 hover:bg-red-50 disabled:opacity-50"
                >
                  إعادة تحميل الأسباب
                </button>
              </div>
            )}
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="flex-1 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 py-4 rounded-2xl font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
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
