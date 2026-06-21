'use client'
import { useHotkeys } from 'react-hotkeys-hook';

import { useState, useEffect } from 'react'
import { addInventoryAction } from '@/app/actions-client/inventory'
import { searchMasterDrugsAction, getUnitsAction } from '@/app/actions-client/master-drugs'
import { toast } from 'react-hot-toast'
import { Plus, Search, Sparkles } from 'lucide-react'
import QuickAddDrugModal from './master-drugs/QuickAddDrugModal'

interface MasterDrug {
  id: number
  trade_name: string
  trade_name_en?: string
  active_ingredient: string
  official_price: number
  large_unit?: string
  large_to_medium?: number
}

interface AddInventoryModalProps {
  pharmacyId: string
  onClose: () => void
  onSuccess: () => void
}

export default function AddInventoryModal({ pharmacyId, onClose, onSuccess }: AddInventoryModalProps) {
  useHotkeys('esc', () => { if(typeof onClose === 'function') onClose(); }, { enableOnFormTags: true });


  const [step, setStep] = useState<1 | 2>(1)
  const [searchTerm, setSearchTerm] = useState('')
  const [searchResults, setSearchResults] = useState<MasterDrug[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false)
  
  const [selectedDrug, setSelectedDrug] = useState<MasterDrug | null>(null)
  const [quantity, setQuantity] = useState('')
  const [stripsQuantity, setStripsQuantity] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [localPrice, setLocalPrice] = useState('')
  const [barcode, setBarcode] = useState('')
  const [largeToMedium, setLargeToMedium] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [unitsList, setUnitsList] = useState<{name_ar: string}[]>([])
  const [selectedUnit, setSelectedUnit] = useState('')

  useEffect(() => {
    async function fetchUnits() {
      const res = await getUnitsAction()
      if (res.success && res.data) setUnitsList(res.data)
    }
    fetchUnits()
  }, [])

  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      if (searchTerm.length >= 2) {
        setIsSearching(true)
        const result = await searchMasterDrugsAction(searchTerm)
        
        if (result.success && result.data) {
          setSearchResults(result.data)
        } else {
          toast.error(result.error || 'فشل البحث المحلي')
        }
        setIsSearching(false)
      } else {
        setSearchResults([])
      }
    }, 300)

    return () => clearTimeout(delayDebounceFn)
  }, [searchTerm])

  const handleSelectDrug = (drug: MasterDrug) => {
    setSelectedDrug(drug)
    setSelectedUnit(drug.large_unit || 'علبة')
    setLocalPrice(drug.official_price > 0 ? drug.official_price.toString() : '')
    setLargeToMedium(drug.large_to_medium ? drug.large_to_medium.toString() : '')
    setStep(2)
  }

  const handleSaveToInventory = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedDrug) return

    // Client-side validation
    let qty = parseFloat(quantity) || 0
    const strips = parseInt(stripsQuantity) || 0
    const conversion = largeToMedium ? parseInt(largeToMedium) : 1
    
    if (strips > 0) {
      qty += strips / (conversion || 1)
    }

    const price = parseFloat(localPrice)
    
    if (qty <= 0) {
      toast.error('يجب إدخال كمية صحيحة (علب أو شرائط)')
      return
    }
    if (isNaN(price) || price < 0) {
      toast.error('سعر البيع يجب أن يكون رقماً صحيحاً (0 أو أكثر)')
      return
    }
    if (!expiryDate || !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
      toast.error('يجب إدخال تاريخ صلاحية صحيح (YYYY-MM-DD)')
      return
    }

    setIsSubmitting(true)

    // Prepare form data for Server Action
    const formData = {
      pharmacy_id: pharmacyId,
      drug_id: selectedDrug.id,
      quantity: qty,
      local_selling_price: price,
      expiry_date: expiryDate,
      barcode: barcode || null,
      unit: selectedUnit,
      large_to_medium: largeToMedium ? parseInt(largeToMedium) : null
    }

    console.log('[AddInventoryModal] Submitting formData:', JSON.stringify(formData))

    // Call Server Action
    const result = await addInventoryAction(formData)

    setIsSubmitting(false)

    console.log('[AddInventoryModal] Result:', JSON.stringify(result))

    if (result.success) {
      toast.success('تمت إضافة المخزون بنجاح!')
      onSuccess()
      onClose()
    } else {
      toast.error(result.error || 'حدث خطأ أثناء الإضافة. يرجى المحاولة مرة أخرى.')
    }
  }

  return (
    <>
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 z-[100] animate-in fade-in duration-300" dir="rtl">
      <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-2xl w-full max-w-lg overflow-y-auto max-h-[90vh] border border-slate-200 dark:border-slate-800 transform animate-in zoom-in slide-in-from-bottom-8 duration-500">
        
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 p-6 flex justify-between items-center text-white relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none">
             <div className="absolute -top-10 -left-10 w-40 h-40 bg-white rounded-full blur-3xl"></div>
          </div>
          <div className="relative z-10">
            <h2 className="text-xl font-black">
              {step === 1 ? 'البحث عن صنف' : 'إضافة للمخزون'}
            </h2>
            <p className="text-blue-100 text-xs mt-0.5">
              {step === 1 ? 'اختر دواء من القائمة الرئيسية' : 'أدخل بيانات الكمية والسعر'}
            </p>
          </div>
          <button 
            onClick={onClose} 
            className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center hover:bg-white/30 transition-colors text-2xl font-bold"
          >
            &times;
          </button>
        </div>

        {/* Step 1: Search */}
        {step === 1 && (
          <div className="p-8 space-y-6">
            <div className="relative">
              <span className="absolute inset-y-0 right-4 flex items-center text-slate-400">🔍</span>
              <input
                type="text"
                placeholder="ابحث باسم الدواء (مثلاً: Panadol)..."
                className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 pr-12 pl-4 py-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-bold"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                autoFocus
              />
            </div>

            {isSearching && (
              <div className="flex items-center justify-center py-4 gap-2 text-blue-600">
                <div className="w-2 h-2 bg-current rounded-full animate-bounce"></div>
                <div className="w-2 h-2 bg-current rounded-full animate-bounce delay-75"></div>
                <div className="w-2 h-2 bg-current rounded-full animate-bounce delay-150"></div>
                <span className="text-sm font-bold">جاري البحث في قاعدة البيانات...</span>
              </div>
            )}

            <div className="max-h-80 overflow-y-auto space-y-3 pr-1">
              {searchResults.map((drug) => (
                <button
                  key={drug.id}
                  onClick={() => handleSelectDrug(drug)}
                  className="w-full text-right p-5 rounded-2xl border border-slate-100 dark:border-slate-800 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all flex items-center justify-between group"
                >
                  <div className="flex flex-col">
                    <span className="font-black text-slate-800 dark:text-white group-hover:text-blue-600 transition-colors">{drug.trade_name || drug.trade_name_en || 'بدون اسم تجاري'}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400 mt-1">{drug.active_ingredient || 'بدون مادة فعالة'}</span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-lg font-black text-emerald-600">{drug.official_price} <span className="text-[10px]">ج.م</span></span>
                    <span className="text-[10px] text-slate-400 font-bold">السعر الرسمي</span>
                  </div>
                </button>
              ))}
              
              {!isSearching && (
                <button 
                  onClick={() => setIsQuickAddOpen(true)}
                  className="w-full p-5 rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-800 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-all flex items-center justify-center gap-3 group"
                >
                  <div className="w-10 h-10 bg-slate-100 dark:bg-slate-800 rounded-xl flex items-center justify-center text-slate-400 group-hover:bg-blue-100 group-hover:text-blue-600 transition-colors">
                    <Plus className="w-5 h-5" />
                  </div>
                  <div className="text-right">
                    <p className="font-black text-slate-900 dark:text-white">أضف صنف مخصص</p>
                    <p className="text-[10px] font-bold text-slate-400">إذا لم تجد الدواء في القاعدة العامة</p>
                  </div>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step 2: Data Entry Form */}
        {step === 2 && selectedDrug && (
          <form onSubmit={handleSaveToInventory} className="p-8 space-y-6">
            
            <div className="bg-slate-50 dark:bg-slate-800/50 p-6 rounded-3xl border border-blue-100 dark:border-blue-900/30 flex items-center justify-between gap-4">
               <div className="flex items-center gap-4">
                 <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center text-2xl shadow-lg shadow-blue-500/20">💊</div>
                 <div>
                    <p className="font-black text-xl text-slate-900 dark:text-white leading-none">{selectedDrug.trade_name}</p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">المادة الفعالة: {selectedDrug.active_ingredient || '---'}</p>
                 </div>
               </div>
               <div className="flex flex-col items-end bg-white dark:bg-slate-900 px-4 py-2 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                  <select
                    value={selectedUnit}
                    onChange={(e) => setSelectedUnit(e.target.value)}
                    className="text-lg font-black text-blue-600 dark:text-blue-400 bg-slate-50 dark:bg-slate-800 outline-none hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg px-3 py-1 text-right w-full border border-blue-200 dark:border-blue-800 focus:ring-2 focus:ring-blue-500 appearance-none"
                  >
                    <option value="" disabled>اختر الوحدة</option>
                    {unitsList.map((u, i) => (
                      <option key={i} value={u.name_ar}>{u.name_ar}</option>
                    ))}
                    {selectedDrug.large_unit && !unitsList.some(u => u.name_ar === selectedDrug.large_unit) && (
                      <option value={selectedDrug.large_unit}>{selectedDrug.large_unit}</option>
                    )}
                  </select>
                  <span className="text-[10px] text-slate-400 font-bold px-2 mt-1">الوحدة الأساسية</span>
               </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">الكمية ({selectedDrug.large_unit || 'علبة'})</label>
                <input
                  type="number"
                  min="0"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-bold"
                  placeholder="مثلاً: 20"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">الكمية (شريط)</label>
                <input
                  type="number"
                  min="0"
                  value={stripsQuantity}
                  onChange={(e) => setStripsQuantity(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-bold"
                  placeholder="اختياري"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">تاريخ الصلاحية</label>
                <input
                  type="date"
                  required
                  value={expiryDate}
                  onChange={(e) => setExpiryDate(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-bold"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">سعر البيع المحلي (ج.م)</label>
                <input
                  type="number"
                  required
                  step="0.01"
                  value={localPrice}
                  onChange={(e) => setLocalPrice(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-bold"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">الباركود</label>
                <input
                  type="text"
                  value={barcode}
                  placeholder="اختياري"
                  onChange={(e) => setBarcode(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-bold"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-black text-slate-500 dark:text-slate-400 mr-2">عدد الشرائط بالعلبة (Strips per Box)</label>
                <input
                  type="number"
                  min="1"
                  value={largeToMedium}
                  onChange={(e) => setLargeToMedium(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all font-bold"
                  placeholder="مثال: 3 (اختياري)"
                />
              </div>
              <div className="space-y-1.5 flex items-end">
                {/* Empty spacer */}
              </div>
            </div>

            <div className="flex gap-4 pt-2">
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex-[2] bg-emerald-600 text-white py-4 rounded-2xl font-black text-lg hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-500/20 disabled:opacity-50 transform active:scale-95 flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    <span>جاري الحفظ...</span>
                  </>
                ) : (
                  <>
                    <span>💾</span>
                    <span>حفظ في المخزون</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="flex-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 py-4 rounded-2xl font-black hover:bg-slate-200 dark:hover:bg-slate-700 transition-all transform active:scale-95"
              >
                رجوع
              </button>
            </div>
          </form>
        )}

      </div>
    </div>

    {/* QuickAddDrugModal rendered OUTSIDE the clipping overflow div — shows full-screen correctly */}
    {isQuickAddOpen && (
      <QuickAddDrugModal 
        onClose={() => setIsQuickAddOpen(false)}
        onSuccess={(id, name, large_to_medium) => {
          setSelectedDrug({ id, trade_name: name, active_ingredient: '', official_price: 0, large_to_medium: large_to_medium || undefined })
          setLargeToMedium(large_to_medium ? large_to_medium.toString() : '')
          setIsQuickAddOpen(false)
          setStep(2)
        }}
      />
    )}
    </>
  )
}
