'use client'

import React, { useState, useEffect } from 'react'
import { addMasterDrugAction, getUnitsAction } from '@/app/actions/master-drugs'
import { toast } from 'react-hot-toast'
import { Plus, X, Pill, BadgeDollarSign, Factory, Beaker, Box, ChevronDown } from 'lucide-react'
import { useHotkeys } from 'react-hotkeys-hook'

interface Props {
  onClose: () => void
  onSuccess: (drugId: number, tradeName: string, large_to_medium?: number | null) => void
}

export default function QuickAddDrugModal({ onClose, onSuccess }: Props) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [unitsList, setUnitsList] = useState<{ name_ar: string }[]>([])
  const [formData, setFormData] = useState({
    trade_name: '',
    trade_name_en: '',
    generic_name: '',
    active_ingredient: '',
    official_price: '',
    manufacturer: '',
    unit: '',
    category: 'Medicines',
    large_to_medium: ''
  })

  useEffect(() => {
    async function fetchUnits() {
      const res = await getUnitsAction()
      if (res.success && res.data) setUnitsList(res.data)
    }
    fetchUnits()
  }, [])

  useHotkeys('esc', () => onClose(), { enableOnFormTags: true })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)
    const largeToMediumVal = formData.large_to_medium ? parseInt(formData.large_to_medium) : null
    const res = await addMasterDrugAction({
      ...formData,
      official_price: parseFloat(formData.official_price) || 0,
      large_to_medium: largeToMediumVal,
      is_medicine: 1
    })
    setIsSubmitting(false)
    if (res.success) {
      toast.success('تمت إضافة الصنف لقاعدة البيانات بنجاح')
      onSuccess(res.id as number, formData.trade_name_en || formData.trade_name, largeToMediumVal)
    } else {
      toast.error(res.error || 'فشل إضافة الصنف')
    }
  }

  const inputClass = "w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-2.5 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all font-semibold text-slate-900 dark:text-white placeholder:text-slate-400 placeholder:font-normal text-sm"
  const labelClass = "text-[11px] font-bold text-slate-500 dark:text-slate-400 flex items-center gap-1.5 mb-1.5 uppercase tracking-wide"

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-6"
      dir="rtl"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-slate-900/70 backdrop-blur-md" />

      {/* Modal — no maxHeight, everything visible at once */}
      <div className="relative bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-lg border border-slate-200/60 dark:border-slate-700/60 animate-in zoom-in-95 fade-in duration-200 overflow-hidden">

        {/* ── Header ── */}
        <div className="relative bg-gradient-to-br from-indigo-600 via-blue-600 to-blue-500 px-6 py-5 overflow-hidden">
          <div className="absolute -top-6 -right-6 w-28 h-28 bg-white/10 rounded-full blur-2xl pointer-events-none" />
          <div className="absolute -bottom-4 -left-4 w-24 h-24 bg-blue-300/20 rounded-full blur-xl pointer-events-none" />
          <div className="relative flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-white/20 rounded-xl flex items-center justify-center shrink-0">
                <Pill className="w-4.5 h-4.5 text-white" />
              </div>
              <div>
                <h2 className="text-lg font-black text-white tracking-tight leading-tight">إضافة صنف جديد للقاعدة</h2>
                <p className="text-blue-100/75 text-[11px] font-medium mt-0.5">أدخل البيانات الأساسية لتعريف الدواء</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="w-8 h-8 bg-white/15 hover:bg-white/30 rounded-xl flex items-center justify-center transition-all hover:scale-110 active:scale-95 text-white shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── Form (no scroll needed) ── */}
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-5 space-y-4">

            {/* Row 1: Arabic + English names */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>
                  <Pill className="w-3 h-3 text-blue-500" />
                  الاسم التجاري (عربي) <span className="text-red-500 normal-case">*</span>
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={formData.trade_name}
                  onChange={(e) => setFormData({ ...formData, trade_name: e.target.value })}
                  className={inputClass}
                  placeholder="أدخل الاسم بالعربية"
                />
              </div>
              <div>
                <label className={labelClass}>
                  <Pill className="w-3 h-3 text-blue-500" />
                  الاسم التجاري (EN)
                </label>
                <input
                  type="text"
                  value={formData.trade_name_en}
                  onChange={(e) => setFormData({ ...formData, trade_name_en: e.target.value })}
                  className={inputClass}
                  dir="ltr"
                  placeholder="Trade Name (EN)"
                />
              </div>
            </div>

            {/* Row 2: Active ingredient */}
            <div>
              <label className={labelClass}>
                <Beaker className="w-3 h-3 text-emerald-500" />
                المادة الفعالة
              </label>
              <input
                type="text"
                value={formData.active_ingredient}
                onChange={(e) => setFormData({ ...formData, active_ingredient: e.target.value })}
                className={inputClass}
                placeholder="مثال: Paracetamol 500mg"
              />
            </div>

            {/* Row 3: Unit + Price + Manufacturer */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelClass}>
                  <Box className="w-3 h-3 text-violet-500" />
                  الوحدة (Unit)
                </label>
                <div className="relative">
                  <input
                    list="units-list"
                    value={formData.unit}
                    onChange={(e) => setFormData({ ...formData, unit: e.target.value })}
                    className={inputClass + " pr-4"}
                    placeholder="اختر أو اكتب الوحدة"
                  />
                  <datalist id="units-list">
                    {unitsList.map((u, idx) => (
                      <option key={idx} value={u.name_ar} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div>
                <label className={labelClass}>
                  <BadgeDollarSign className="w-3 h-3 text-amber-500" />
                  السعر الرسمي <span className="text-red-500 normal-case">*</span>
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    value={formData.official_price}
                    onChange={(e) => setFormData({ ...formData, official_price: e.target.value })}
                    className={inputClass + " pl-11"}
                    placeholder="0.00"
                  />
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[11px] font-bold text-slate-400">ج.م</span>
                </div>
              </div>

              <div>
                <label className={labelClass}>
                  <Factory className="w-3 h-3 text-orange-500" />
                  الشركة المصنعة
                </label>
                <input
                  type="text"
                  value={formData.manufacturer}
                  onChange={(e) => setFormData({ ...formData, manufacturer: e.target.value })}
                  className={inputClass}
                  placeholder="اسم الشركة"
                />
              </div>
            </div>

            {/* Row 4: Strips per Box */}
            <div>
              <label className={labelClass}>
                <Pill className="w-3 h-3 text-indigo-500" />
                عدد الشرائط بالعلبة (Strips per Box)
              </label>
              <input
                type="number"
                min="1"
                value={formData.large_to_medium}
                onChange={(e) => setFormData({ ...formData, large_to_medium: e.target.value })}
                className={inputClass}
                placeholder="مثال: 3 (اختياري)"
              />
            </div>

          </div>

          {/* ── Footer ── */}
          <div className="px-6 py-4 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-4">
            {/* Keyboard hints */}
            <div className="flex items-center gap-2.5 text-[11px] text-slate-400 font-medium">
              <span className="flex items-center gap-1">
                <kbd className="bg-white dark:bg-slate-800 px-1.5 py-0.5 rounded-md border border-slate-200 dark:border-slate-700 font-sans text-[10px] text-slate-600 dark:text-slate-300">Enter</kbd>
                للحفظ
              </span>
              <span className="flex items-center gap-1">
                <kbd className="bg-white dark:bg-slate-800 px-1.5 py-0.5 rounded-md border border-slate-200 dark:border-slate-700 font-sans text-[10px] text-slate-600 dark:text-slate-300">Esc</kbd>
                للإغلاق
              </span>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-bold text-sm hover:bg-slate-100 dark:hover:bg-slate-800 transition-all active:scale-95"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex items-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white px-5 py-2 rounded-xl font-bold text-sm shadow-md shadow-blue-500/20 hover:shadow-blue-500/35 transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed min-w-[110px] justify-center"
              >
                {isSubmitting ? (
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Plus className="w-4 h-4" />
                    حفظ الصنف
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
