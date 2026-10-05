'use client'

import React, { useState, useEffect, useRef } from 'react'
import { addMasterDrugAction, getUnitsAction } from '@/app/actions-client/master-drugs'
import { toast } from 'react-hot-toast'
import { Plus, X, Pill, BadgeDollarSign, Factory, Beaker, Box, ChevronDown } from 'lucide-react'
import { useHotkeys } from 'react-hotkeys-hook'
import { findDrugBarcodeConflict, getReplacementDrug } from '@/app/actions-client/drug-replacement';
import DrugReplacementDialog from './DrugReplacementDialog';
import { useDialogFocusTrap } from '@/hooks/useDialogFocusTrap';

interface Props {
  onClose: () => void
  onSuccess: (drugId: number, tradeName: string, large_unit: string, official_price: number, large_to_medium?: number | null, barcode?: string) => void
}

export default function QuickAddDrugModal({ onClose, onSuccess }: Props) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const submissionRef = useRef(false)
  const [replacement, setReplacement] = useState<any>(null);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>(!replacement);
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
    large_to_medium: '',
    barcode: ''
  })

  useEffect(() => {
    async function fetchUnits() {
      try {
        const res = await getUnitsAction()
        if (res.success && res.data) setUnitsList(res.data)
      } catch {
        toast.error('تعذر تحميل الوحدات')
      }
    }
    void fetchUnits()
  }, [])

  const handleClose = () => {
    if (replacement || submissionRef.current) return
    onClose()
  }

  useHotkeys('esc', handleClose, { enableOnFormTags: true }, [replacement])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submissionRef.current) return
    submissionRef.current = true
    setIsSubmitting(true)
    const largeToMediumVal = formData.large_to_medium ? parseInt(formData.large_to_medium) : null
    const officialPriceVal = parseFloat(formData.official_price) || 0
    let successId: number | null = null
    let conflict: any = null
    let errorMessage: string | null = null

    try {
      const res = await addMasterDrugAction({
        ...formData,
        large_unit: formData.unit,
        official_price: officialPriceVal,
        large_to_medium: largeToMediumVal,
        is_medicine: 1
      })

      if (res.success) {
        successId = res.id as number
      } else {
        conflict = await findDrugBarcodeConflict(formData.barcode).catch(() => null)
        if (!conflict) {
          errorMessage = res.error || 'فشل إضافة الصنف'
        }
      }
    } catch {
      errorMessage = 'فشل إضافة الصنف'
    } finally {
      submissionRef.current = false
      setIsSubmitting(false)
    }

    if (successId !== null) {
      toast.success('تمت إضافة الصنف لقاعدة البيانات بنجاح')
      onSuccess(successId, formData.trade_name_en || formData.trade_name, formData.unit, officialPriceVal, largeToMediumVal, formData.barcode)
      return
    }

    if (conflict) {
      setReplacement({ source: conflict, newDrug: { ...formData, large_unit: formData.unit, official_price: officialPriceVal, large_to_medium: largeToMediumVal } })
      return
    }

    if (errorMessage) toast.error(errorMessage)
  }

  const inputClass = "w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-4 py-2.5 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all font-semibold text-slate-900 dark:text-white placeholder:text-slate-400 placeholder:font-normal text-sm"
  const labelClass = "text-[11px] font-bold text-slate-500 dark:text-slate-400 flex items-center gap-1.5 mb-1.5 uppercase tracking-wide"

  return (
    <>
    {replacement && <DrugReplacementDialog {...replacement} onClose={() => setReplacement(null)} onSuccess={async (id, _backupPath, savedDrug) => {
      setReplacement(null);
      const drug = savedDrug || await getReplacementDrug(id).catch(() => null);
      if (drug) onSuccess(id, drug.trade_name_en || drug.trade_name, drug.large_unit, drug.official_price, drug.large_to_medium, drug.barcode);
      else { toast.success('تم الاستبدال. ابحث عن الصنف الجديد لإضافته للفاتورة'); onClose(); }
    }} />}
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-6"
      dir="rtl"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose() }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-slate-900/70 backdrop-blur-md" />

      <div ref={dialogRef} role="dialog" aria-modal="true" aria-hidden={replacement ? true : undefined} aria-labelledby="quick-add-drug-title" tabIndex={-1} className="relative bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto border border-slate-200/60 dark:border-slate-700/60 animate-in zoom-in-95 fade-in duration-200">

        {/* ── Header ── */}
        <div className="relative bg-primary-700 px-6 py-5 overflow-hidden">
          <div className="relative flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 bg-white/20 rounded-xl flex items-center justify-center shrink-0">
                <Pill className="w-[18px] h-[18px] text-white" />
              </div>
              <div>
                <h2 id="quick-add-drug-title" className="text-lg font-black text-white tracking-tight leading-tight">إضافة صنف جديد للقاعدة</h2>
                <p className="text-blue-100/75 text-[11px] font-medium mt-0.5">أدخل البيانات الأساسية لتعريف الدواء</p>
              </div>
            </div>
            <button
              type="button"
              aria-label="إغلاق إضافة الصنف"
              disabled={isSubmitting}
              onClick={handleClose}
              className="w-8 h-8 bg-white/15 hover:bg-white/30 rounded-xl flex items-center justify-center transition-all hover:scale-110 active:scale-95 text-white shrink-0 disabled:opacity-50"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ── Form (no scroll needed) ── */}
        <form onSubmit={handleSubmit}>
          <div className="px-6 py-5 space-y-4">

            {/* Row 1: Arabic + English names */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="quick-drug-name-ar" className={labelClass}>
                  <Pill className="w-3 h-3 text-blue-500" />
                  الاسم التجاري (عربي) <span className="text-red-500 normal-case">*</span>
                </label>
                <input
                  id="quick-drug-name-ar"
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
                <label htmlFor="quick-drug-name-en" className={labelClass}>
                  <Pill className="w-3 h-3 text-blue-500" />
                  الاسم التجاري (EN)
                </label>
                <input
                  id="quick-drug-name-en"
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
              <label htmlFor="quick-drug-active" className={labelClass}>
                <Beaker className="w-3 h-3 text-emerald-500" />
                المادة الفعالة
              </label>
              <input
                id="quick-drug-active"
                type="text"
                value={formData.active_ingredient}
                onChange={(e) => setFormData({ ...formData, active_ingredient: e.target.value })}
                className={inputClass}
                placeholder="مثال: Paracetamol 500mg"
              />
            </div>

            {/* Row 3: Unit + Price + Manufacturer */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="quick-drug-unit" className={labelClass}>
                  <Box className="w-3 h-3 text-violet-500" />
                  الوحدة (Unit)
                </label>
                <div className="relative">
                  <input
                    id="quick-drug-unit"
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
                <label htmlFor="quick-drug-price" className={labelClass}>
                  <BadgeDollarSign className="w-3 h-3 text-amber-500" />
                  السعر الرسمي <span className="text-red-500 normal-case">*</span>
                </label>
                <div className="relative">
                  <input
                    id="quick-drug-price"
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
                <label htmlFor="quick-drug-manufacturer" className={labelClass}>
                  <Factory className="w-3 h-3 text-orange-500" />
                  الشركة المصنعة
                </label>
                <input
                  id="quick-drug-manufacturer"
                  type="text"
                  value={formData.manufacturer}
                  onChange={(e) => setFormData({ ...formData, manufacturer: e.target.value })}
                  className={inputClass}
                  placeholder="اسم الشركة"
                />
              </div>
            </div>

            {/* Row 4: Barcode + Strips per Box */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="quick-drug-barcode" className={labelClass}>
                  <Box className="w-3 h-3 text-slate-500" />
                  الباركود (Barcode)
                </label>
                <input
                  id="quick-drug-barcode"
                  type="text"
                  value={formData.barcode}
                  onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const form = e.currentTarget.form;
                      setTimeout(() => {
                        form?.requestSubmit();
                      }, 50);
                    }
                  }}
                  className={inputClass}
                  placeholder="رقم الباركود (اختياري)"
                />
              </div>
              <div>
                <label htmlFor="quick-drug-conversion" className={labelClass}>
                  <Pill className="w-3 h-3 text-indigo-500" />
                  عدد الشرائط بالعلبة *
                </label>
                <input
                  id="quick-drug-conversion"
                  type="number"
                  min="1"
                  required
                  value={formData.large_to_medium}
                  onChange={(e) => setFormData({ ...formData, large_to_medium: e.target.value })}
                  className={inputClass}
                  placeholder="مثال: 3 (مطلوب)"
                />
              </div>
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
                disabled={isSubmitting}
                onClick={handleClose}
                className="min-h-11 px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-semibold text-sm hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="min-h-11 flex items-center gap-2 bg-primary-700 hover:bg-primary-800 text-white px-5 py-2.5 rounded-lg font-semibold text-sm shadow-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed min-w-[110px] justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
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
    </>
  )
}
