'use client'

import nextDynamic from 'next/dynamic'
import React, { useState, useEffect } from 'react'
import { Info, Settings } from 'lucide-react'
import { 
  FileText, 
  Search, 
  Plus, 
  Trash2, 
  CheckCircle2, 
  Calendar, 
  User, 
  Hash, 
  DollarSign, 
  Package, 
  AlertTriangle,
  X,
  ChevronDown,
  ChevronLeft
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { searchMasterDrugsAction } from '@/app/actions/master-drugs'
import { 
  getSuppliersAction, 
  createPurchaseInvoiceAction, 
  addPurchaseInvoiceItemAction, 
  completePurchaseInvoiceAction,
  checkSupplierPendingInvoiceAction
} from '@/app/actions/purchases'
import { toast } from 'react-hot-toast'
import { useRouter } from 'next/navigation'
import { usePurchaseStore } from '@/store/usePurchaseStore'
import { useHotkeys } from 'react-hotkeys-hook'
import { Supplier, PurchaseItem } from '@/types/purchases'
import BarcodePrinter from '@/components/purchases/BarcodePrinter'

const formatExpiryDate = (val: string) => {
  const digits = val.replace(/\D/g, '');
  if (digits.length <= 2) {
    return digits;
  }
  return `${digits.slice(0, 2)}/${digits.slice(2, 6)}`;
};

const DrugDetailsModal = nextDynamic(() => import('@/components/pos/DrugDetailsModal'), { ssr: false });

function ContextMenuItem({ icon: Icon, label, onClick, color = "text-slate-700 dark:text-slate-300" }: any) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800 rounded-xl transition-all text-right font-bold text-xs ${color}`}
    >
      <Icon className="w-4 h-4 opacity-50" />
      <span>{label}</span>
    </button>
  );
}

export default function PurchaseInvoiceClient() {
  const router = useRouter()
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, drugId: string | number } | null>(null);
  const [showDrugDetails, setShowDrugDetails] = useState<string | number | null>(null);

  const handleContextMenu = (e: React.MouseEvent, drugId: string | number) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, drugId });
  };
  const closeContextMenu = () => setContextMenu(null);

  useEffect(() => {
    const handleClick = () => closeContextMenu();
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);
  const { 
    cart, setCart, 
    selectedSupplier, setSelectedSupplier, 
    header: invoiceHeader, setHeader: setInvoiceHeader,
    resetPurchase
  } = usePurchaseStore()

  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDrafting, setIsDrafting] = useState(false)
  const [showBarcodePrinter, setShowBarcodePrinter] = useState(false)

  // Hotkeys
  useHotkeys('f2', (e) => { e.preventDefault(); handleNewInvoice(); }, { enableOnFormTags: true });
  useHotkeys('f4', (e) => { e.preventDefault(); document.querySelector<HTMLInputElement>('input[placeholder*="Search"]')?.focus(); }, { enableOnFormTags: true });
  useHotkeys('f9', (e) => { e.preventDefault(); handleSubmit(false); }, { enableOnFormTags: true });
  useHotkeys('f10', (e) => { e.preventDefault(); handleSubmit(true); }, { enableOnFormTags: true });


  const [hydrated, setHydrated] = useState(false)
  const handledDrugIdRef = React.useRef<string | null>(null)

  // Wait for Zustand store hydration
  useEffect(() => {
    const unsub = usePurchaseStore.persist.onFinishHydration(() => {
      setHydrated(true)
    })
    if (usePurchaseStore.persist.hasHydrated()) {
      setHydrated(true)
    }
    return () => unsub()
  }, [])

  // Load suppliers
  useEffect(() => {
    getSuppliersAction().then(res => {
      if (res.success) setSuppliers(res.data)
    })
  }, [])

  // Handle drugId from URL once store is hydrated
  useEffect(() => {
    if (!hydrated) return

    const params = new URLSearchParams(window.location.search)
    const drugId = params.get('drugId')
    if (drugId && handledDrugIdRef.current !== drugId) {
      handledDrugIdRef.current = drugId
      
      // Clean up URL parameters immediately to prevent duplicate runs on remounts
      const newUrl = window.location.pathname
      window.history.replaceState({}, '', newUrl)

      import('@/app/actions/master-drugs').then(({ getMasterDrugAction }) => {
        getMasterDrugAction(parseInt(drugId)).then(res => {
          if (res.success && res.data) {
            addToCart(res.data)
            toast.success(`تمت إضافة "${res.data.trade_name_en || res.data.trade_name}" للفاتورة تلقائياً`)
          }
        })
      })
    }
  }, [hydrated])

  const handleDrugSearch = async (query: string) => {
    setSearchQuery(query)
    if (query.length > 2) {
      const res = await searchMasterDrugsAction(query)
      if (res.success) setSearchResults(res.data)
    } else {
      setSearchResults([])
    }
  }

  const addToCart = (drug: any) => {
    let wasAdded = false
    setCart(prev => {
      if (prev.find(item => String(item.id) === String(drug.id))) {
        return prev
      }
      wasAdded = true
      const officialPrice = Number(drug.official_price) || 0
      return [...prev, { 
        ...drug, 
        quantity: 1, 
        bonus_quantity: 0,
        cost_price: officialPrice, 
        selling_price: officialPrice,
        tax_percent: 0,
        discount_percent: 0,
        expiry_date: ''
      }]
    })

    if (!wasAdded) {
      toast.error('هذا الصنف مضاف بالفعل')
      return
    }

    setSearchQuery('')
    setSearchResults([])
  }


  const updateCartItem = (id: number | string, field: string, value: any) => {
    setCart(prev => prev.map(item => {
      if (String(item.id) === String(id)) {
        const updated = { ...item, [field]: value };
        
        // Auto-calculate cost_price
        if (field === 'selling_price' || field === 'discount_percent' || field === 'tax_percent') {
          const sp = Number(updated.selling_price) || 0;
          const disc = Number(updated.discount_percent) || 0;
          const tax = Number(updated.tax_percent) || 0;
          
          const discountedSp = sp - (sp * (disc / 100));
          const taxAmount = discountedSp * (tax / 100);
          
          // Calculate cost price and format to 2 decimal places
          updated.cost_price = parseFloat((discountedSp + taxAmount).toFixed(2));
        }
        
        return updated;
      }
      return item;
    }))
  }

  const removeFromCart = (id: number | string) => {
    setCart(prev => prev.filter(item => String(item.id) !== String(id)))
  }

  const calculateItemTotal = (item: any) => {
    const sub = Number(item.quantity || 0) * Number(item.cost_price || 0);
    const tax = sub * (Number(item.tax_percent || 0) / 100);
    const disc = (sub + tax) * (Number(item.discount_percent || 0) / 100);
    return sub + tax - disc;
  }

  const subTotal = cart.reduce((sum, item) => sum + calculateItemTotal(item), 0)
  const totalAmount = (() => {
    const withExpenses = subTotal + Number(invoiceHeader.expenses || 0);
    const withDiscountVal = withExpenses - Number(invoiceHeader.discount_value || 0);
    const withDiscountPct = withDiscountVal * (1 - (Number(invoiceHeader.discount_percent || 0) / 100));
    return withDiscountPct;
  })()

  const handleSupplierChange = async (supplierId: number) => {
    const s = suppliers.find(sup => sup.id === supplierId)
    setSelectedSupplier(s || null)
    
    if (supplierId) {
      const res = await checkSupplierPendingInvoiceAction(supplierId)
      if (res.success && res.hasPending) {
        toast((t) => (
          <div className="flex items-center gap-3">
            <AlertTriangle className="text-amber-500 w-6 h-6" />
            <div className="text-right">
              <p className="font-bold text-sm">تنبيه: توجد فاتورة غير مكتملة لهذا المورد</p>
              <p className="text-[10px] text-slate-500">رقم الفاتورة: {res.invoice.invoice_number || 'بدون رقم'}</p>
            </div>
            <button onClick={() => toast.dismiss(t.id)} className="text-slate-400 hover:text-slate-600 mr-auto"><X className="w-4 h-4" /></button>
          </div>
        ), { duration: 5000, position: 'top-center' })
      }
    }
  }

  const handleNewInvoice = () => {
    if (cart.length > 0 && !confirm('هل تريد مسح الفاتورة الحالية والبدء من جديد؟')) return;
    resetPurchase();
  };


  const handleSubmit = async (isDraft = false) => {
    if (!selectedSupplier) {
      toast.error('يرجى اختيار المورد')
      return
    }
    if (cart.length === 0) {
      toast.error('يرجى إضافة أصناف للفاتورة')
      return
    }

    // Validation Warnings & Checks
    for (const item of cart) {
      const costPriceNum = Number(item.cost_price) || 0;
      const officialPriceNum = Number(item.official_price) || 0;
      if (costPriceNum > officialPriceNum && officialPriceNum > 0) {
        if (!confirm(`تنبيه: سعر الشراء (${costPriceNum}) أكبر من السعر الرسمي (${officialPriceNum}) للصنف ${item.trade_name_en || item.trade_name}. هل تريد الاستمرار؟`)) {
          return;
        }
      }
      
      if (item.expiry_date) {
        const parts = item.expiry_date.split('/');
        if (parts.length !== 2) {
          toast.error(`صيغة تاريخ الصلاحية غير صحيحة للصنف ${item.trade_name_en || item.trade_name}. يجب أن تكون MM/YYYY`);
          return;
        }
        const month = parseInt(parts[0], 10);
        const year = parseInt(parts[1], 10);
        if (isNaN(month) || month < 1 || month > 12) {
          toast.error(`الشهر غير صحيح (${parts[0]}) في تاريخ الصلاحية للصنف ${item.trade_name_en || item.trade_name}`);
          return;
        }
        const currentYear = new Date().getFullYear();
        if (isNaN(year) || year < currentYear || year > currentYear + 20) {
          toast.error(`السنة غير صحيحة (${parts[1]}) في تاريخ الصلاحية للصنف ${item.trade_name_en || item.trade_name}`);
          return;
        }

        const expiry = new Date(year, month - 1);
        const now = new Date();
        const diffMonths = (expiry.getFullYear() - now.getFullYear()) * 12 + (expiry.getMonth() - now.getMonth());
        if (diffMonths < 6) {
          if (!confirm(`تنبيه: الصنف ${item.trade_name_en || item.trade_name} ستنتهي صلاحيته خلال ${diffMonths} شهر. هل تريد الاستمرار؟`)) {
            return;
          }
        }
      }
    }


    if (isDraft) setIsDrafting(true); else setIsSubmitting(true);
    
    try {
      // 1. Create Invoice
      const res = await createPurchaseInvoiceAction({
        supplier_id: (selectedSupplier as any).id,
        invoice_number: invoiceHeader.invoice_number,
        invoice_date: invoiceHeader.invoice_date,
        payment_method: invoiceHeader.payment_method,
        notes: invoiceHeader.notes,
        check_number: invoiceHeader.check_number,
        expenses: Number(invoiceHeader.expenses) || 0,
        discount_value: Number(invoiceHeader.discount_value) || 0,
        discount_percent: Number(invoiceHeader.discount_percent) || 0,
        tax_percent: Number(invoiceHeader.tax_percent) || 0,
        status: isDraft ? 'draft' : 'pending'
      })

      if (!res.success) throw new Error(res.error)

      const invoiceId = res.id as string

      // 2. Add Items
      for (const item of cart) {
        let formattedExpiry = item.expiry_date;
        if (formattedExpiry && formattedExpiry.includes('/')) {
          const [month, year] = formattedExpiry.split('/');
          formattedExpiry = `${year}-${month.padStart(2, '0')}-01`;
        }
        const itemRes = await addPurchaseInvoiceItemAction(invoiceId, {
          drug_id: typeof item.id === 'string' ? item.id : Number(item.id),
          quantity: Number(item.quantity) || 0,
          cost_price: Number(item.cost_price) || 0,
          selling_price: Number(item.selling_price) || 0,
          bonus_quantity: Number(item.bonus_quantity) || 0,
          tax_percent: Number(item.tax_percent) || 0,
          discount_percent: Number(item.discount_percent) || 0,
          expiry_date: formattedExpiry
        })
        if (!itemRes.success) {
          toast.error(`فشل إضافة الصنف ${item.trade_name}: ${itemRes.error}`);
          setIsSubmitting(false);
          setIsDrafting(false);
          return;
        }
      }

      // 3. Complete Invoice if not draft
      if (!isDraft) {
        const completeRes = await completePurchaseInvoiceAction(invoiceId)
        if (completeRes.success) {
          toast.success('تم تسجيل فاتورة الشراء بنجاح')
          if (confirm('تم الحفظ بنجاح. هل تريد طباعة الباركود؟')) {
             setShowBarcodePrinter(true)
          } else {
             resetPurchase();
             router.push('/purchases')
          }
        } else {
          throw new Error(completeRes.error)
        }
      } else {
        toast.success('تم حفظ الفاتورة كمسودة')
        resetPurchase();
        router.push('/purchases')
      }
    } catch (error: any) {
      toast.error(error.message || 'فشل في تسجيل الفاتورة')
    } finally {
      setIsDrafting(false)
      setIsSubmitting(false)
    }
  }


  return (
    <div className="space-y-8 animate-in slide-in-from-bottom duration-500 pb-20" dir="rtl">
      {/* Header Form */}
      <div className="bg-white dark:bg-slate-900 p-10 rounded-[45px] shadow-hard border border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-black text-slate-900 dark:text-white">فاتورة شراء جديدة</h1>
            <p className="text-slate-500 font-bold">تسجيل توريدات جديدة وتحديث أرصدة الموردين</p>
          </div>

        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Supplier Selector */}
          <div className="space-y-3">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2 flex items-center gap-2">
              <User className="w-4 h-4 text-primary-500" />
              المورد
            </label>

            <select 
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
              value={selectedSupplier?.id || ''}
              onChange={(e) => handleSupplierChange(parseInt(e.target.value))}
            >
              <option value="">اختر المورد...</option>

              {suppliers.map(s => (
                <option key={s.id} value={s.id}>{s.name_ar}</option>
              ))}
            </select>
            {selectedSupplier && (
              <div className="px-4 py-2 bg-primary-50 dark:bg-primary-900/20 rounded-xl border border-primary-100 dark:border-primary-800 text-[10px] font-black text-primary-700 dark:text-primary-400 animate-in fade-in">
                الرصيد الحالي: {selectedSupplier.balance.toFixed(2)} ج.م
              </div>
            )}

          </div>

          {/* Invoice Number */}
          <div className="space-y-3">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2 flex items-center gap-2">
              <Hash className="w-4 h-4 text-slate-400" />
              رقم الفاتورة
            </label>

            <input 
              type="text"
              placeholder="مثلاً: INV-2024-001"
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
              value={invoiceHeader.invoice_number}
              onChange={(e) => setInvoiceHeader({ invoice_number: e.target.value })}

            />
          </div>

          {/* Date */}
          <div className="space-y-3">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-slate-400" />
              تاريخ الفاتورة
            </label>

            <input 
              type="date"
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
              value={invoiceHeader.invoice_date}
              onChange={(e) => setInvoiceHeader({ invoice_date: e.target.value })}

            />
          </div>

          {/* Payment Method */}
          <div className="space-y-3">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2 flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-emerald-500" />
              طريقة الدفع
            </label>

            <div className="flex bg-slate-50 dark:bg-slate-800 rounded-2xl p-1 gap-1">
              <button 
                onClick={() => setInvoiceHeader({ payment_method: 'cash' })}
                className={cn(
                  "flex-1 py-3 px-2 rounded-xl font-black text-[10px] transition-all whitespace-nowrap",
                  invoiceHeader.payment_method === 'cash' ? "bg-white dark:bg-slate-700 shadow-sm text-emerald-600 border border-emerald-100" : "text-slate-400"
                )}
              >
                نقدي
              </button>

              <button 
                onClick={() => setInvoiceHeader({ payment_method: 'credit' })}
                className={cn(
                  "flex-1 py-3 px-2 rounded-xl font-black text-[10px] transition-all whitespace-nowrap",
                  invoiceHeader.payment_method === 'credit' ? "bg-white dark:bg-slate-700 shadow-sm text-primary-600 border border-primary-100" : "text-slate-400"
                )}
              >
                آجل
              </button>

              <button 
                onClick={() => setInvoiceHeader({ payment_method: 'check' })}
                className={cn(
                  "flex-1 py-3 px-2 rounded-xl font-black text-[10px] transition-all whitespace-nowrap",
                  invoiceHeader.payment_method === 'check' ? "bg-white dark:bg-slate-700 shadow-sm text-amber-600 border border-amber-100" : "text-slate-400"
                )}
              >
                شيك
              </button>

            </div>
            {invoiceHeader.payment_method === 'check' && (
              <input 
                type="text"
                placeholder="رقم الشيك..."
                className="w-full p-3 mt-2 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold outline-none ring-2 ring-amber-500/10 focus:ring-amber-500/20 animate-in slide-in-from-top-2 duration-300"
                value={invoiceHeader.check_number}
                onChange={(e) => setInvoiceHeader({ check_number: e.target.value })}

              />
            )}
          </div>
        </div>

        {/* Financial Details Row */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mt-10 pt-8 border-t border-slate-50 dark:border-slate-800">
           {/* Expenses */}
           <div className="space-y-3">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2 flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-slate-400" />
              المصروفات

            </label>
            <input 
              type="text"
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
              value={invoiceHeader.expenses}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9.]/g, '');
                setInvoiceHeader({ expenses: val });
              }}
            />
          </div>

          {/* Discount Value */}
          <div className="space-y-3">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2 flex items-center gap-2">
              <Plus className="w-4 h-4 text-rose-500" />
              قيمة الخصم

            </label>
            <input 
              type="text"
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
              value={invoiceHeader.discount_value}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9.]/g, '');
                setInvoiceHeader({ discount_value: val });
              }}
            />
          </div>

          {/* Discount Percent */}
          <div className="space-y-3">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2 flex items-center gap-2">
              <Plus className="w-4 h-4 text-rose-500 rotate-45" />
              نسبة الخصم %

            </label>
            <input 
              type="text"
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
              value={invoiceHeader.discount_percent}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9.]/g, '');
                setInvoiceHeader({ discount_percent: val });
              }}
            />
          </div>

          {/* Added Tax */}
          <div className="space-y-3">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2 flex items-center gap-2">
              <ChevronDown className="w-4 h-4 text-blue-500" />
              ضريبة القيمة المضافة %

            </label>
            <input 
              type="text"
              className="w-full p-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
              value={invoiceHeader.tax_percent}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9.]/g, '');
                setInvoiceHeader({ tax_percent: val });
              }}
            />
          </div>
        </div>
      </div>

      {/* Item Selector & Cart Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
        {/* Left Side: Search */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] border border-slate-100 dark:border-slate-800 shadow-soft sticky top-24">
              <h2 className="font-black text-lg mb-6 flex items-center gap-3">
              <Package className="w-6 h-6 text-primary-500" />
              إضافة صنف
            </h2>

            
            <div className="relative">
              <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input 
                type="text"
                placeholder="اسم الصنف أو الباركود..."
                className="w-full pr-12 pl-4 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
                value={searchQuery}
                onChange={(e) => handleDrugSearch(e.target.value)}
              />

              
              {searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-3 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-[28px] shadow-hard z-50 overflow-hidden animate-in zoom-in-95">
                  {searchResults.map((drug) => (
                    <button 
                      key={drug.id}
                      onClick={() => addToCart(drug)}
                      className="w-full p-4 text-right hover:bg-primary-50 dark:hover:bg-primary-900/20 transition-all border-b border-slate-50 dark:border-slate-800 last:border-0"
                    >
                      <div className="font-black text-slate-900 dark:text-white leading-tight">{drug.trade_name_en || drug.trade_name}</div>
                      {drug.trade_name_en && (
                        <div className="text-[11px] text-slate-500 font-bold italic mt-0.5">{drug.trade_name}</div>
                      )}
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="text-[9px] text-slate-400 font-bold uppercase tracking-widest bg-slate-100 dark:bg-slate-800 inline-block px-2 py-0.5 rounded-md">
                          {drug.barcode || 'بدون باركود'}
                        </div>
                        <div className="text-[9px] text-emerald-600 font-bold uppercase tracking-widest bg-emerald-50 dark:bg-emerald-900/20 inline-block px-2 py-0.5 rounded-md border border-emerald-100 dark:border-emerald-800">
                          بيع: {drug.official_price}
                        </div>
                        {drug.base_price > 0 && (
                          <div className="text-[9px] text-blue-600 font-bold uppercase tracking-widest bg-blue-50 dark:bg-blue-900/20 inline-block px-2 py-0.5 rounded-md border border-blue-100 dark:border-blue-800">
                            شراء: {drug.base_price}
                          </div>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-8 pt-8 border-t border-slate-50 dark:border-slate-800 space-y-4">
              <div className="flex justify-between items-center mb-2">
                <span className="text-slate-400 font-black text-xs uppercase tracking-widest">الإجمالي الفرعي</span>
                <span className="text-lg font-bold text-slate-600 dark:text-slate-400">{subTotal.toFixed(2)} ج.م</span>
              </div>
              <div className="flex justify-between items-center mb-4">
                <span className="text-slate-400 font-black text-xs uppercase tracking-widest">إجمالي الفاتورة</span>
                <span className="text-2xl font-black text-primary-600">{totalAmount.toFixed(2)} ج.م</span>
              </div>

              
              <div className="grid grid-cols-2 gap-3">
                <button 
                  onClick={() => handleSubmit(true)}
                  disabled={isSubmitting || isDrafting || cart.length === 0}
                  className="bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 py-4 rounded-2xl font-black transition-all flex items-center justify-center gap-2 active:scale-95"
                >
                  {isDrafting ? (
                    <div className="w-5 h-5 border-3 border-slate-300 border-t-slate-600 rounded-full animate-spin" />
                  ) : (
                    <>
                      <FileText className="w-5 h-5" />
                      حفظ مسودة
                    </>

                  )}
                </button>
                <button 
                  onClick={() => handleSubmit(false)}
                  disabled={isSubmitting || isDrafting || cart.length === 0}
                  className="bg-primary-600 hover:bg-primary-700 text-white py-4 rounded-2xl font-black shadow-lg shadow-primary-500/20 transition-all flex items-center justify-center gap-2 active:scale-95"
                >
                  {isSubmitting ? (
                    <div className="w-5 h-5 border-3 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <>
                      <CheckCircle2 className="w-5 h-5" />
                      حفظ نهائي
                    </>

                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: Grid */}
        <div className="lg:col-span-3">
          <div className="bg-white dark:bg-slate-900 rounded-[45px] border border-slate-100 dark:border-slate-800 shadow-soft overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800/50">
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">الصنف</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">سعر بيع الوحدة</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">الكمية</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">بونص</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">تاريخ الصلاحية</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">ضريبة %</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">خصم %</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">سعر شراء الوحدة</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">الإجمالي</th>

                    <th className="px-2 py-4 border-b border-slate-100 dark:border-slate-800"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                  {cart.map((item) => (
                    <tr key={String(item.id)} onContextMenu={(e) => handleContextMenu(e, item.id)} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-all group">
                      <td className="px-2 py-3">
                        <div className="font-black text-slate-900 dark:text-white group-hover:text-primary-600 transition-colors text-sm">{item.trade_name_en || item.trade_name}</div>
                        <div className="text-[10px] text-slate-400 font-bold mt-1 uppercase">{item.trade_name}</div>
                      </td>
                      <td className="px-2 py-3">
                        <input 
                          type="text"
                          className="w-16 p-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-emerald-500/20 text-xs text-emerald-600 dark:text-emerald-400"
                          value={item.selling_price}
                          onChange={(e) => {
                            const val = e.target.value.replace(/[^0-9.]/g, '');
                            updateCartItem(item.id, 'selling_price', val);
                          }}
                        />
                      </td>
                      <td className="px-2 py-3">
                        <input 
                          type="text"
                          className="w-12 p-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-primary-500/20 text-xs"
                          value={item.quantity}
                          onChange={(e) => {
                            const val = e.target.value.replace(/[^0-9]/g, '');
                            updateCartItem(item.id, 'quantity', val);
                          }}
                        />
                      </td>
                      <td className="px-2 py-3">
                        <input 
                          type="text"
                          className="w-16 p-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-primary-500/20 text-xs"
                          value={item.bonus_quantity}
                          onChange={(e) => {
                            const val = e.target.value.replace(/[^0-9]/g, '');
                            updateCartItem(item.id, 'bonus_quantity', val);
                          }}
                        />
                      </td>
                      <td className="px-2 py-3">
                        <input 
                          type="text"
                          placeholder="MM/YYYY"
                          className="w-24 p-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-primary-500/20 text-xs"
                          value={item.expiry_date}
                          onChange={(e) => updateCartItem(item.id, 'expiry_date', formatExpiryDate(e.target.value))}
                        />
                      </td>
                      <td className="px-2 py-3">
                        <input 
                          type="text"
                          className="w-12 p-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-primary-500/20 text-xs"
                          value={item.tax_percent}
                          onChange={(e) => {
                            const val = e.target.value.replace(/[^0-9.]/g, '');
                            updateCartItem(item.id, 'tax_percent', val);
                          }}
                        />
                      </td>
                      <td className="px-2 py-3">
                        <input 
                          type="text"
                          className="w-12 p-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-primary-500/20 text-xs"
                          value={item.discount_percent}
                          onChange={(e) => {
                            const val = e.target.value.replace(/[^0-9.]/g, '');
                            updateCartItem(item.id, 'discount_percent', val);
                          }}
                        />
                      </td>
                      <td className="px-2 py-3">
                        <input 
                          type="text"
                          className="w-16 p-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-blue-500/20 text-xs text-blue-600 dark:text-blue-400"
                          value={item.cost_price}
                          onChange={(e) => {
                            const val = e.target.value.replace(/[^0-9.]/g, '');
                            updateCartItem(item.id, 'cost_price', val);
                          }}
                        />
                      </td>
                      <td className="px-2 py-3 font-black text-slate-900 dark:text-white text-sm">
                        {calculateItemTotal(item).toFixed(2)}
                      </td>
                      <td className="px-2 py-3">
                        <button 
                          onClick={() => removeFromCart(item.id)}
                          className="p-2 text-slate-400 hover:text-danger-600 hover:bg-danger-50 dark:hover:bg-danger-900/20 rounded-xl transition-all"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {cart.length === 0 && (
                    <tr>
                      <td colSpan={10} className="p-32 text-center">
                        <div className="flex flex-col items-center opacity-30">
                          <AlertTriangle className="w-16 h-16 mb-4" />
                          <p className="font-black text-xl italic">الفاتورة فارغة.. ابدأ بإضافة الأصناف</p>
                        </div>

                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {showBarcodePrinter && (
        <BarcodePrinter 
          items={cart.map(item => ({
            id: item.id,
            trade_name: item.trade_name,
            trade_name_en: item.trade_name_en,
            barcode: item.barcode || `MD-${item.id}`,
            selling_price: item.selling_price,
            expiry_date: item.expiry_date
          }))}
          onClose={() => {
            setShowBarcodePrinter(false)
            resetPurchase()
            router.push('/purchases')
          }}
        />
      )}
    
      {contextMenu && (
        <div 
          className="fixed z-[300] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl overflow-hidden w-64 animate-in fade-in zoom-in duration-200"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div className="p-2 space-y-1">
            <ContextMenuItem 
              icon={Info} 
              label="معلومات الصنف" 
              onClick={() => setShowDrugDetails(contextMenu.drugId)} 
            />
            <ContextMenuItem 
              icon={Settings} 
              label="تعديل كارت الصنف" 
              onClick={() => router.push(`/stores/items?edit=${contextMenu.drugId}`)} 
            />
            <div className="h-px bg-slate-100 dark:bg-slate-800 my-1 mx-2" />
            <ContextMenuItem 
              icon={Trash2} 
              label="حذف من الفاتورة" 
              color="text-red-500"
              onClick={() => {
                const newCart = [...cart];
                newCart.splice(cart.findIndex(i => String(i.id) === String(contextMenu.drugId)), 1);
                setCart(newCart);
                closeContextMenu();
              }} 
            />
          </div>
        </div>
      )}

      {showDrugDetails && (
        <DrugDetailsModal 
          drugId={showDrugDetails} 
          onClose={() => setShowDrugDetails(null)} 
        />
      )}
</div>
  )
}
