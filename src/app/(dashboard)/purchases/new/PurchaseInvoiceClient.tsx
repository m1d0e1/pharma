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
  ChevronLeft,
  Printer,
  Save
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { searchMasterDrugsAction } from '@/app/actions-client/master-drugs'
import { 
  getSuppliersAction, 
  createPurchaseInvoiceAction, 
  addPurchaseInvoiceItemAction, 
  completePurchaseInvoiceAction,
  checkSupplierPendingInvoiceAction,
  getPurchaseInvoiceDetailsAction,
  getPurchaseInvoiceAction,
  updateCompletedPurchaseInvoiceAction
} from '@/app/actions-client/purchases'
import { toast } from 'react-hot-toast'
import { useRouter, useSearchParams } from 'next/navigation'
import { usePurchaseStore } from '@/store/usePurchaseStore'
import { useHotkeys } from 'react-hotkeys-hook'
import { Supplier, PurchaseItem } from '@/types/purchases'
import BarcodePrinter from '@/components/purchases/BarcodePrinter'
function normalizeDateToYMD(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  dateStr = dateStr.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  let match = dateStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  match = dateStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = dateStr.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (match) return `${match[2]}-${match[1].padStart(2, '0')}-01`;
  return dateStr;
}

const DrugDetailsModal = nextDynamic(() => import('@/components/pos/DrugDetailsModal'), { ssr: false });
const QuickAddDrugModal = nextDynamic(() => import('@/components/master-drugs/QuickAddDrugModal'), { ssr: false });

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
    const menuWidth = 192;
    const menuHeight = 220;
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 12;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 12;
    if (x < 12) x = 12;
    if (y < 12) y = 12;
    setContextMenu({ x, y, drugId });
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
  const [searchByActive, setSearchByActive] = useState(false)
  const [searchResults, setSearchResults] = useState<any[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDrafting, setIsDrafting] = useState(false)
  const [showBarcodePrinter, setShowBarcodePrinter] = useState(false)
  const [errors, setErrors] = useState<Record<string, boolean>>({})
  const [itemErrors, setItemErrors] = useState<Record<string, Record<string, boolean>>>({})
  const [drafts, setDrafts] = useState<any[]>([])
  const [showDraftsModal, setShowDraftsModal] = useState(false)
  const [isEditingCompleted, setIsEditingCompleted] = useState(false)
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false)

  const handleEnterNext = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const currentTd = e.currentTarget.closest('td');
      const row = e.currentTarget.closest('tr');
      if (!currentTd || !row) return;
      
      const inputs = Array.from(row.querySelectorAll('input'));
      const idx = inputs.indexOf(e.currentTarget);
      if (idx >= 0 && idx < inputs.length - 1) {
        inputs[idx + 1].focus();
        (inputs[idx + 1] as HTMLInputElement).select?.();
      } else {
        const nextRow = row.nextElementSibling;
        if (nextRow) {
          const nextInput = nextRow.querySelector('input') as HTMLInputElement | null;
          if (nextInput) {
            nextInput.focus();
            nextInput.select?.();
          }
        }
      }
    }
  };

  const loadDrafts = async () => {
    const { getDraftPurchaseInvoicesAction } = await import('@/app/actions-client/purchases');
    const res = await getDraftPurchaseInvoicesAction();
    if (res.success) {
      setDrafts(res.data || []);
    }
  };

  const handleLoadDraft = async (draftId: string) => {
    try {
      const { getPurchaseInvoiceAction, getPurchaseInvoiceDetailsAction } = await import('@/app/actions-client/purchases');
      const invoiceRes = await getPurchaseInvoiceAction(draftId);
      const itemsRes = await getPurchaseInvoiceDetailsAction(draftId);
      if (invoiceRes.success && itemsRes.success) {
        const invoice = invoiceRes.data;
        const s = suppliers.find(sup => sup.id === invoice.supplier_id);
        setSelectedSupplier(s || null);

        setInvoiceHeader({
          id: invoice.id,
          invoice_number: invoice.invoice_number || '',
          invoice_date: normalizeDateToYMD(invoice.invoice_date) || new Date().toISOString().split('T')[0],
          payment_method: invoice.payment_method || 'cash',
          notes: invoice.notes || '',
          discount_percent: invoice.discount_percent || 0,
          discount_value: invoice.discount_value || 0,
          expenses: invoice.expenses || 0,
        });
        
        const formattedCart: PurchaseItem[] = itemsRes.data.map((i: any) => ({
          id: i.drug_id,
          trade_name: i.trade_name_en || i.trade_name || i.drug_name || '',
          barcode: i.barcode || '',
          quantity: i.quantity || 1,
          bonus_quantity: i.bonus_quantity || 0,
          discount_percent: i.discount_percent || 0,
          discount_value: i.discount_value || 0,
          tax_percent: i.tax_percent || 0,
          cost_price: i.cost_price || 0,
          selling_price: i.selling_price || 0,
          official_price: i.selling_price || 0,
          batch_number: i.batch_number || '',
          expiry_date: normalizeDateToYMD(i.expiry_date) || '',
          strips_per_box: i.strips_per_box || i.large_to_medium || ''
        }));
        setCart(formattedCart);
        setShowDraftsModal(false);
        toast.success('تم تحميل مسودة الفاتورة بنجاح');
      } else {
        toast.error('فشل في تحميل المسودة');
      }
    } catch (e) {
      console.error(e);
      toast.error('حدث خطأ أثناء تحميل المسودة');
    }
  };

  // Hotkeys
  useHotkeys('f2', (e) => { e.preventDefault(); handleNewInvoice(); }, { enableOnFormTags: true });
  useHotkeys('f4', (e) => { e.preventDefault(); document.querySelector<HTMLInputElement>('input[placeholder*="Search"]')?.focus(); }, { enableOnFormTags: true });
  useHotkeys('f9', (e) => { e.preventDefault(); handleSubmit(false); }, { enableOnFormTags: true }, [cart, selectedSupplier, invoiceHeader]);
  useHotkeys('f10', (e) => { e.preventDefault(); handleSubmit(true); }, { enableOnFormTags: true }, [cart, selectedSupplier, invoiceHeader]);


  const handledDrugIdRef = React.useRef<string | null>(null)

  // Unsaved purchases are deliberately discarded when leaving this screen.
  useEffect(() => {
    return () => resetPurchase()
  }, [resetPurchase])

  // Load suppliers
  useEffect(() => {
    getSuppliersAction().then(res => {
      if (res.success) setSuppliers(res.data)
    })
  }, [])

  const searchParams = useSearchParams()

  // Handle drugId and supplier_id from URL
  useEffect(() => {
    const drugId = searchParams.get('drugId')
    if (drugId && handledDrugIdRef.current !== drugId) {
      handledDrugIdRef.current = drugId
      
      // Clean up URL parameters immediately to prevent duplicate runs on remounts
      const newUrl = window.location.pathname
      window.history.replaceState({}, '', newUrl)

      import('@/app/actions-client/master-drugs').then(({ getMasterDrugAction }) => {
        getMasterDrugAction(parseInt(drugId)).then(res => {
          if (res.success && res.data) {
            addToCart(res.data)
            toast.success(`تمت إضافة "${res.data.trade_name_en || res.data.trade_name}" للفاتورة تلقائياً`)
          }
        })
      })
    }

    const supplierIdParam = searchParams.get('supplier_id')
    if (supplierIdParam && suppliers.length > 0) {
      handleSupplierChange(parseInt(supplierIdParam), suppliers, true)
      
      const newUrl = window.location.pathname
      window.history.replaceState({}, '', newUrl)
    }

    const editInvoiceId = searchParams.get('edit_invoice_id')
    if (editInvoiceId && handledDrugIdRef.current !== editInvoiceId && suppliers.length > 0) {
      handledDrugIdRef.current = editInvoiceId
      
      const newUrl = window.location.pathname
      window.history.replaceState({}, '', newUrl)
      
      toast.loading('جاري تحميل الفاتورة للتعديل...', { id: 'loading-edit' })
      Promise.all([
        getPurchaseInvoiceAction(editInvoiceId),
        getPurchaseInvoiceDetailsAction(editInvoiceId)
      ]).then(([invoiceRes, itemsRes]) => {
        toast.dismiss('loading-edit')
        if (invoiceRes.success && itemsRes.success && invoiceRes.data) {
          const invoice = invoiceRes.data
          setIsEditingCompleted(invoice.status === 'completed')
          
          const s = suppliers.find(sup => sup.id === invoice.supplier_id)
          setSelectedSupplier(s || null)
          
          setInvoiceHeader({
            id: invoice.id,
            invoice_number: invoice.invoice_number || '',
            invoice_date: normalizeDateToYMD(invoice.invoice_date) || new Date().toISOString().split('T')[0],
            payment_method: invoice.payment_method || 'cash',
            notes: invoice.notes || '',
            discount_percent: invoice.discount_percent || 0,
            discount_value: invoice.discount_value || 0,
            expenses: invoice.expenses || 0,
          })
          
          const formattedCart: PurchaseItem[] = itemsRes.data.map((i: any) => ({
            id: i.drug_id,
            trade_name: i.trade_name_en || i.trade_name || i.drug_name || '',
            barcode: i.barcode || '',
            quantity: i.quantity || 1,
            bonus_quantity: i.bonus_quantity || 0,
            discount_percent: i.discount_percent || 0,
            discount_value: i.discount_value || 0,
            tax_percent: i.tax_percent || 0,
            cost_price: i.cost_price || 0,
            selling_price: i.selling_price || 0,
            official_price: i.selling_price || 0,
            batch_number: i.batch_number || '',
            expiry_date: normalizeDateToYMD(i.expiry_date) || '',
            strips_per_box: i.strips_per_box || i.large_to_medium || ''
          }))
          setCart(formattedCart)
          toast.success('تم تحميل الفاتورة للتعديل بنجاح')
        } else {
          toast.error('فشل في تحميل الفاتورة للتعديل')
        }
      }).catch(err => {
        toast.dismiss('loading-edit')
        console.error(err)
        toast.error('حدث خطأ أثناء تحميل الفاتورة')
      })
    }
  }, [searchParams, suppliers])

  const handleDrugSearch = async (query: string, byActive = searchByActive) => {
    setSearchQuery(query)
    if (query.length > 2) {
      const res = await searchMasterDrugsAction({ query, searchByActiveIngredient: byActive })
      if (res.success) setSearchResults(res.data)
    } else {
      setSearchResults([])
    }
  }

  const addToCart = async (drug: any) => {
    let wasAdded = false
    let finalStripsPerBox = drug.large_to_medium || '';
    if (!finalStripsPerBox) {
      try {
        const { dbGet } = await import('@/lib/db/tauri');
        const row = await dbGet('SELECT strips_per_box FROM inventory WHERE drug_id = ? AND strips_per_box > 0 ORDER BY expiry_date DESC LIMIT 1', [drug.id]) as any;
        if (row && row.strips_per_box) {
          finalStripsPerBox = row.strips_per_box;
        } else {
          const row2 = await dbGet('SELECT strips_per_box FROM purchase_invoice_items WHERE drug_id = ? AND strips_per_box > 0 ORDER BY id DESC LIMIT 1', [drug.id]) as any;
          if (row2 && row2.strips_per_box) {
            finalStripsPerBox = row2.strips_per_box;
          }
        }
      } catch (e) {
        console.error(e);
      }
    }

    setCart(prev => {
      if (prev.find(item => String(item.id) === String(drug.id))) {
        return prev
      }
      wasAdded = true
      const officialPrice = Number(drug.official_price) || 0
      const purchasePrice = Number(drug.base_price) || officialPrice
      return [...prev, { 
        ...drug, 
        quantity: 1, 
        bonus_quantity: 0,
        cost_price: purchasePrice,
        selling_price: officialPrice,
        tax_percent: 0,
        discount_percent: 0,
        large_unit: drug.large_unit,
        medium_unit: drug.medium_unit,
        small_unit: drug.small_unit,
        strips_per_box: finalStripsPerBox
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
        
        // ponytail: link selling_price, discount_percent, and cost_price bidirectionally
        if (field === 'selling_price' || field === 'discount_percent') {
          const sell = Number(field === 'selling_price' ? value : item.selling_price) || 0;
          const disc = Number(field === 'discount_percent' ? value : item.discount_percent) || 0;
          updated.cost_price = sell * (1 - disc / 100);
        } else if (field === 'cost_price') {
          const cost = Number(value) || 0;
          const sell = Number(item.selling_price) || 0;
          updated.discount_percent = sell > 0 ? ((sell - cost) / sell) * 100 : 0;
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
    return sub
      * (1 + Number(item.tax_percent || 0) / 100)
      * (1 + Number(invoiceHeader.tax_percent || 0) / 100);
  }

  const calculateTaxedUnitCost = (item: any) => {
    const received = Number(item.quantity || 0) + Number(item.bonus_quantity || 0);
    return received > 0 ? calculateItemTotal(item) / received : Number(item.cost_price || 0);
  }

  const subTotal = cart.reduce((sum, item) => sum + calculateItemTotal(item), 0)
  const totalAmount = (() => {
    const withExpenses = subTotal + Number(invoiceHeader.expenses || 0);
    const withDiscountVal = withExpenses - Number(invoiceHeader.discount_value || 0);
    const withDiscountPct = withDiscountVal * (1 - (Number(invoiceHeader.discount_percent || 0) / 100));
    return withDiscountPct;
  })()

  const handleSupplierChange = async (supplierId: number, suppliersList?: any[], autoLoad: boolean = false) => {
    const sList = suppliersList || suppliers;
    const s = sList.find(sup => sup.id === supplierId)
    setSelectedSupplier(s || null)
    
    if (supplierId) {
      const res = await checkSupplierPendingInvoiceAction(supplierId)
      if (res.success && res.hasPending) {
        if (autoLoad) {
          try {
            const itemsRes = await getPurchaseInvoiceDetailsAction(res.invoice.id);
            if (itemsRes.success) {
              setInvoiceHeader({
                id: res.invoice.id,
                invoice_number: res.invoice.invoice_number || '',
                invoice_date: normalizeDateToYMD(res.invoice.invoice_date) || new Date().toISOString().split('T')[0],
                payment_method: res.invoice.payment_method || 'cash',
                notes: res.invoice.notes || '',
                discount_percent: res.invoice.discount_percent || 0,
                discount_value: res.invoice.discount_value || 0,
                expenses: res.invoice.expenses || 0,
              });
              
              const formattedCart: PurchaseItem[] = itemsRes.data.map((i: any) => ({
                id: i.drug_id,
                trade_name: i.trade_name_en || i.trade_name || i.drug_name || '',
                barcode: i.barcode || '',
                quantity: i.quantity || 1,
                bonus_quantity: i.bonus_quantity || 0,
                discount_percent: i.discount_percent || 0,
                discount_value: i.discount_value || 0,
                tax_percent: i.tax_percent || 0,
                cost_price: i.cost_price || 0,
                selling_price: i.selling_price || 0,
                official_price: i.selling_price || 0,
                batch_number: i.batch_number || '',
                expiry_date: normalizeDateToYMD(i.expiry_date) || '',
                strips_per_box: i.strips_per_box || i.large_to_medium || ''
              }));
              setCart(formattedCart);
              toast.success('تم تحميل الفاتورة بنجاح');
            }
          } catch (error) {
            console.error(error);
          }
          return;
        }

        toast((t) => (
          <div className="flex items-center gap-3">
            <AlertTriangle className="text-amber-500 w-6 h-6" />
            <div className="text-right">
              <p className="font-bold text-sm">تنبيه: توجد فاتورة غير مكتملة لهذا المورد</p>
              <p className="text-[10px] text-slate-500">رقم الفاتورة: {res.invoice.invoice_number || 'بدون رقم'}</p>
              <button 
                onClick={async () => {
                  toast.dismiss(t.id);
                  try {
                    const itemsRes = await getPurchaseInvoiceDetailsAction(res.invoice.id);
                    if (itemsRes.success) {
                      setInvoiceHeader({
                        id: res.invoice.id,
                        invoice_number: res.invoice.invoice_number || '',
                        invoice_date: normalizeDateToYMD(res.invoice.invoice_date) || new Date().toISOString().split('T')[0],
                        payment_method: res.invoice.payment_method || 'cash',
                        notes: res.invoice.notes || '',
                        discount_percent: res.invoice.discount_percent || 0,
                        discount_value: res.invoice.discount_value || 0,
                        expenses: res.invoice.expenses || 0,
                      });
                      
                      const formattedCart: PurchaseItem[] = itemsRes.data.map((i: any) => ({
                        id: i.drug_id,
                        trade_name: i.trade_name_en || i.trade_name || i.drug_name || '',
                        barcode: i.barcode || '',
                        quantity: i.quantity || 1,
                        bonus_quantity: i.bonus_quantity || 0,
                        discount_percent: i.discount_percent || 0,
                        discount_value: i.discount_value || 0,
                        tax_percent: i.tax_percent || 0,
                        cost_price: i.cost_price || 0,
                        selling_price: i.selling_price || 0,
                        official_price: i.selling_price || 0,
                        batch_number: i.batch_number || '',
                        expiry_date: normalizeDateToYMD(i.expiry_date) || '',
                        strips_per_box: i.strips_per_box || i.large_to_medium || ''
                      }));
                      setCart(formattedCart);
                      toast.success('تم تحميل الفاتورة بنجاح');
                    } else {
                      console.error('Failed to load pending invoice:', itemsRes.error);
                      toast.error('فشل في تحميل الفاتورة: ' + itemsRes.error);
                    }
                  } catch (e: any) {
                    console.error('Crash loading pending invoice:', e);
                    toast.error('حدث خطأ غير متوقع');
                  }
                }}
                className="mt-2 text-xs bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-md transition-colors"
              >
                استكمال الفاتورة
              </button>
            </div>
            <button onClick={() => toast.dismiss(t.id)} className="text-slate-400 hover:text-slate-600 mr-auto self-start"><X className="w-4 h-4" /></button>
          </div>
        ), { duration: 10000, position: 'top-center' })
      }
    }
  }

  const handleNewInvoice = () => {
    if (cart.length > 0 && !confirm('هل تريد مسح الفاتورة الحالية والبدء من جديد؟')) return;
    resetPurchase();
  };


  const handleSubmit = async (isDraft = false) => {
    const headerErrors: Record<string, boolean> = {}
    const rowErrors: Record<string, Record<string, boolean>> = {}

    if (!selectedSupplier) {
      headerErrors.supplier = true
    }
    if (!invoiceHeader.invoice_number || invoiceHeader.invoice_number.trim() === '') {
      headerErrors.invoice_number = true
    }
    if (!invoiceHeader.invoice_date || invoiceHeader.invoice_date.trim() === '') {
      headerErrors.invoice_date = true
    }
    if (cart.length === 0) {
      headerErrors.cartEmpty = true
    }

    // Normalize expiry dates
    const normalizedCart = cart.map(item => ({
      ...item,
      expiry_date: normalizeDateToYMD(item.expiry_date) || ''
    }));
    setCart(normalizedCart);

    // Validation Warnings & Checks for items
    for (const item of normalizedCart) {
      const itemErr: Record<string, boolean> = {}
      
      const quantityNum = Number(item.quantity) || 0;
      if (quantityNum <= 0) {
        itemErr.quantity = true;
      }

      const costPriceNum = Number(item.cost_price) || 0;
      if (costPriceNum <= 0) {
        itemErr.cost_price = true;
      }

      if (!item.expiry_date || item.expiry_date.trim() === '') {
        itemErr.expiry_date = true;
      } else {
        const parts = item.expiry_date.split('-');
        if (parts.length !== 3 || parts[0].length !== 4 || parts[1].length !== 2 || parts[2].length !== 2) {
          itemErr.expiry_date = true;
        } else {
          const year = parseInt(parts[0], 10);
          const month = parseInt(parts[1], 10);
          const day = parseInt(parts[2], 10);
          if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2000) {
            itemErr.expiry_date = true;
          } else {
            const now = new Date();
            const expiry = new Date(year, month - 1, day);
            const diffMonths = (expiry.getFullYear() - now.getFullYear()) * 12 + (expiry.getMonth() - now.getMonth());
            if (diffMonths < 0) {
              itemErr.expiry_expired = true;
            }
          }
        }
      }

      if (Object.keys(itemErr).length > 0) {
        rowErrors[String(item.id)] = itemErr;
      }
    }

    setErrors(headerErrors)
    setItemErrors(rowErrors)

    if (Object.keys(headerErrors).length > 0) {
      if (headerErrors.supplier) toast.error('يرجى اختيار المورد')
      else if (headerErrors.invoice_number) toast.error('يرجى إدخال رقم الفاتورة')
      else if (headerErrors.invoice_date) toast.error('يرجى إدخال تاريخ الفاتورة')
      else if (headerErrors.cartEmpty) toast.error('يرجى إضافة أصناف للفاتورة')
      return
    }

    if (Object.keys(rowErrors).length > 0) {
      const firstItemId = Object.keys(rowErrors)[0];
      const firstItem = cart.find(i => String(i.id) === firstItemId);
      const itemName = firstItem ? (firstItem.trade_name_en || firstItem.trade_name) : 'الصنف';
      
      const firstErr = rowErrors[firstItemId];
      if (firstErr.quantity) {
        toast.error(`يجب إدخال كمية صحيحة للصنف ${itemName}`);
      } else if (firstErr.cost_price) {
        toast.error(`يجب إدخال سعر شراء صحيح للصنف ${itemName}`);
      } else if (firstErr.expiry_date) {
        toast.error(`يجب إدخال تاريخ صلاحية صحيح للصنف ${itemName}`);
      } else if (firstErr.expiry_expired) {
        toast.error(`الصنف ${itemName} منتهي الصلاحية!`);
      }
      return
    }

    // Warnings (non-blocking)
    for (const item of normalizedCart) {
      const costPriceNum = Number(item.cost_price) || 0;
      const officialPriceNum = Number(item.official_price) || 0;
      if (costPriceNum > officialPriceNum && officialPriceNum > 0) {
        toast.error(`سعر الشراء (${costPriceNum}) أكبر من السعر الرسمي (${officialPriceNum}) للصنف ${item.trade_name_en || item.trade_name}. تم الحفظ مع التنبيه`, { duration: 4000 });
      }
      if (item.expiry_date) {
        const parts = item.expiry_date.split('-');
        if (parts.length === 3) {
          const year = parseInt(parts[0], 10);
          const month = parseInt(parts[1], 10);
          const day = parseInt(parts[2], 10);
          const now = new Date();
          const expiry = new Date(year, month - 1, day);
          const diffMonths = (expiry.getFullYear() - now.getFullYear()) * 12 + (expiry.getMonth() - now.getMonth());
          if (diffMonths >= 0 && diffMonths < 6) {
            toast.error(`تحذير: الصنف ${item.trade_name_en || item.trade_name} اقترب على انتهاء الصلاحية. تم الحفظ مع التنبيه`, { duration: 4000 });
          }
        }
      }
    }

    if (isDraft) setIsDrafting(true); else setIsSubmitting(true);
    
    try {
      let res;
      if (isEditingCompleted) {
        res = await updateCompletedPurchaseInvoiceAction({
          id: invoiceHeader.id!,
          supplier_id: (selectedSupplier as any).id,
          invoice_number: invoiceHeader.invoice_number || undefined,
          invoice_date: invoiceHeader.invoice_date || undefined,
          payment_method: invoiceHeader.payment_method || 'credit',
          notes: invoiceHeader.notes || undefined,
          check_number: invoiceHeader.check_number || undefined,
          expenses: Number(invoiceHeader.expenses) || 0,
          discount_value: Number(invoiceHeader.discount_value) || 0,
          discount_percent: Number(invoiceHeader.discount_percent) || 0,
          tax_percent: Number(invoiceHeader.tax_percent) || 0,
          cart: normalizedCart
        });
      } else {
        res = await createPurchaseInvoiceAction({
          ...invoiceHeader,
          expenses: Number(invoiceHeader.expenses) || 0,
          discount_value: Number(invoiceHeader.discount_value) || 0,
          discount_percent: Number(invoiceHeader.discount_percent) || 0,
          tax_percent: Number(invoiceHeader.tax_percent) || 0,
          supplier_id: (selectedSupplier as any).id,
          status: isDraft ? 'draft' : 'pending',
          cart: normalizedCart.map(item => {
            return { ...item, expiry_date: item.expiry_date };
          }),
          id: invoiceHeader.id || undefined
        });
      }

      if (!res.success) {
        const errMsg = (res as any).error || 'فشل في تسجيل الفاتورة';
        console.error('Save purchase invoice failed:', (res as any).error);
        throw new Error(errMsg);
      }

      if (isEditingCompleted) {
        toast.success('تم تعديل فاتورة الشراء المكتملة بنجاح')
        if (confirm('تم تعديل الفاتورة بنجاح. هل تريد طباعة الباركود؟')) {
           setShowBarcodePrinter(true)
        } else {
           resetPurchase();
           router.push('/purchases')
        }
      } else if (!isDraft) {
        toast.success('تم تسجيل فاتورة الشراء بنجاح')
        if (confirm('تم الحفظ بنجاح. هل تريد طباعة الباركود؟')) {
           setShowBarcodePrinter(true)
        } else {
           resetPurchase();
           router.push('/purchases')
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
        <div className="flex justify-between items-start mb-8">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-3xl font-black text-slate-900 dark:text-white">
                {isEditingCompleted ? 'تعديل فاتورة شراء مكتملة' : 'فاتورة شراء جديدة'}
              </h1>
              <p className="text-slate-500 font-bold">
                {isEditingCompleted ? 'تعديل أصناف الفاتورة، وتعديل كميات وأسعار المخزون المرتبط تلقائياً' : 'تسجيل توريدات جديدة وتحديث أرصدة الموردين'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 no-print">
            {!isEditingCompleted && (
              <button 
                onClick={async () => {
                  await loadDrafts();
                  setShowDraftsModal(true);
                }}
                className="p-3 bg-primary-50 dark:bg-primary-950/20 hover:bg-primary-100 dark:hover:bg-primary-900/30 transition-all rounded-xl text-primary-600 dark:text-primary-400 font-bold text-xs flex items-center gap-2"
              >
                <FileText className="w-5 h-5" />
                <span>استرجاع المسودات</span>
              </button>
            )}
            <button onClick={() => window.print()} className="p-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 transition-all rounded-xl">
              <Printer className="w-6 h-6 text-slate-600 dark:text-slate-300" />
            </button>
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
              className={`w-full p-4 bg-slate-50 dark:bg-slate-800 border rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all ${
                errors.supplier ? 'border-red-500 ring-2 ring-red-500/20' : 'border-none'
              }`}
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
              className={`w-full p-4 bg-slate-50 dark:bg-slate-800 border rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all ${
                errors.invoice_number ? 'border-red-500 ring-2 ring-red-500/20' : 'border-none'
              }`}
              value={invoiceHeader.invoice_number}
              onChange={(e) => setInvoiceHeader({ ...invoiceHeader, invoice_number: e.target.value })}
            />
          </div>

          {/* Date */}
          <div className="space-y-3">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-slate-400" />
              تاريخ الفاتورة
            </label>

            <div className="relative flex items-center">
              <Calendar className="absolute right-4 text-slate-400 w-5 h-5 pointer-events-none" />
              <input 
                type="date"
                className={`w-full pr-12 pl-12 py-4 bg-slate-50 dark:bg-slate-800 border rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all cursor-pointer ${
                  errors.invoice_date ? 'border-red-500 ring-2 ring-red-500/20' : 'border-none'
                }`}
                value={invoiceHeader.invoice_date}
                onChange={(e) => setInvoiceHeader({ ...invoiceHeader, invoice_date: e.target.value })}
                onClick={(e) => { try { e.currentTarget.showPicker(); } catch (err) {} }}
                onFocus={(e) => { try { e.currentTarget.showPicker(); } catch (err) {} }}
              />
            </div>
          </div>

          {/* Payment Method */}
          <div className="space-y-3">
            <label className="text-xs font-black text-slate-400 uppercase tracking-widest mr-2 flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-emerald-500" />
              طريقة الدفع
            </label>

            <div className="flex bg-slate-50 dark:bg-slate-800 rounded-2xl p-1 gap-1">
              <button 
                onClick={() => setInvoiceHeader({ ...invoiceHeader, payment_method: 'cash' })}
                className={cn(
                  "flex-1 py-3 px-2 rounded-xl font-black text-[10px] transition-all whitespace-nowrap",
                  invoiceHeader.payment_method === 'cash' ? "bg-white dark:bg-slate-700 shadow-sm text-emerald-600 border border-emerald-100" : "text-slate-400"
                )}
              >
                نقدي
              </button>

              <button 
                onClick={() => setInvoiceHeader({ ...invoiceHeader, payment_method: 'credit' })}
                className={cn(
                  "flex-1 py-3 px-2 rounded-xl font-black text-[10px] transition-all whitespace-nowrap",
                  invoiceHeader.payment_method === 'credit' ? "bg-white dark:bg-slate-700 shadow-sm text-primary-600 border border-primary-100" : "text-slate-400"
                )}
              >
                آجل
              </button>

              <button 
                onClick={() => setInvoiceHeader({ ...invoiceHeader, payment_method: 'check' })}
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
                onChange={(e) => setInvoiceHeader({ ...invoiceHeader, check_number: e.target.value })}
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
                setInvoiceHeader({ ...invoiceHeader, expenses: val });
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
                setInvoiceHeader({ ...invoiceHeader, discount_value: val });
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
                setInvoiceHeader({ ...invoiceHeader, discount_percent: val });
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
                setInvoiceHeader({ ...invoiceHeader, tax_percent: val });
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

            
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1">
                <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
                <input 
                  type="text"
                  placeholder="اسم الصنف أو الباركود..."
                  className="w-full pr-12 pl-4 py-4 bg-slate-50 dark:bg-slate-800 border-none rounded-2xl font-bold outline-none ring-2 ring-transparent focus:ring-primary-500/20 transition-all"
                  value={searchQuery}
                  onChange={(e) => handleDrugSearch(e.target.value)}
                />
                {searchResults.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-2xl shadow-hard z-50 overflow-y-auto max-h-[300px] animate-in fade-in duration-200">
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
              <button
                type="button"
                onClick={() => setIsQuickAddOpen(true)}
                className="p-4 bg-primary-600 hover:bg-primary-700 text-white rounded-2xl font-bold transition-all shadow-md flex items-center justify-center shrink-0"
                title="إضافة دواء جديد كلياً"
              >
                <Plus className="w-5 h-5" />
              </button>
            </div>
            
            <div className="flex items-center gap-2 mb-4 px-1">
              <label className="flex items-center gap-2 text-xs font-bold text-slate-600 dark:text-slate-400 cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={searchByActive} 
                  onChange={(e) => {
                    setSearchByActive(e.target.checked);
                    handleDrugSearch(searchQuery, e.target.checked);
                  }}
                  className="rounded text-primary-600 focus:ring-primary-500 border-slate-300 w-4 h-4"
                />
                <span>البحث بالمادة الفعالة</span>
              </label>
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

              
              <div className="flex flex-col gap-2">
                <button 
                  onClick={() => handleSubmit(false)}
                  disabled={isSubmitting || isDrafting || cart.length === 0}
                  className="w-full py-4 bg-primary-600 hover:bg-primary-700 text-white rounded-2xl font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isSubmitting ? (
                    <div className="w-5 h-5 border-3 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <>
                      <CheckCircle2 className="w-5 h-5" />
                      {isEditingCompleted ? 'حفظ التعديلات (F9)' : 'حفظ نهائي (F9)'}
                    </>
                  )}
                </button>

                <div className="flex gap-2">
                  {!isEditingCompleted ? (
                    <button 
                      onClick={() => handleSubmit(true)}
                      disabled={isSubmitting || isDrafting || cart.length === 0}
                      className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-xl font-bold transition-all disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
                    >
                      {isDrafting ? (
                        <div className="w-4 h-4 border-2 border-slate-500/30 border-t-slate-500 rounded-full animate-spin" />
                      ) : (
                        <>
                          <Save className="w-4 h-4" />
                          حفظ كمسودة (F10)
                        </>
                      )}
                    </button>
                  ) : null}

                  <button 
                    onClick={() => {
                      if (isEditingCompleted) {
                        if (confirm('هل أنت متأكد من إلغاء التعديلات والعودة للفواتير؟')) {
                          resetPurchase();
                          router.push('/purchases');
                        }
                      } else {
                        if (confirm('هل أنت متأكد من إلغاء وحذف الفاتورة الحالية بالكامل؟')) {
                          resetPurchase();
                          toast.success('تم إلغاء الفاتورة بنجاح');
                        }
                      }
                    }}
                    className="flex-1 py-3 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/20 dark:hover:bg-rose-950/40 text-rose-600 rounded-xl font-bold transition-all flex items-center justify-center gap-2 text-sm"
                  >
                    <Trash2 className="w-4 h-4" />
                    {isEditingCompleted ? 'إلغاء التعديل' : 'إلغاء الفاتورة'}
                  </button>
                </div>
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
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">الباركود / QR</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">سعر بيع الوحدة</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">الكمية</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">بونص</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">تاريخ الصلاحية</th>
                    <th className="px-2 py-4 font-black text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100 dark:border-slate-800">شرائط/علبة</th>
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
                          placeholder="باركود..."
                          className="w-24 p-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-primary-500/20 text-xs"
                          value={item.barcode || ''}
                          onChange={(e) => updateCartItem(item.id, 'barcode', e.target.value)}
                          onKeyDown={handleEnterNext}
                        />
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
                          onKeyDown={handleEnterNext}
                        />
                      </td>
                      <td className="px-2 py-3">
                        <input 
                          type="text"
                          className={`w-12 p-2.5 bg-slate-50 dark:bg-slate-800 border rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-primary-500/20 text-xs ${
                            itemErrors[item.id]?.quantity ? 'border-red-500 ring-2 ring-red-500/20' : 'border-none'
                          }`}
                          value={item.quantity}
                          onChange={(e) => {
                            const val = e.target.value.replace(/[^0-9]/g, '');
                            updateCartItem(item.id, 'quantity', val);
                          }}
                          onKeyDown={handleEnterNext}
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
                          onKeyDown={handleEnterNext}
                        />
                      </td>
                      <td className="px-2 py-3">
                        <div className="relative flex items-center w-[145px]">
                          <Calendar className="absolute right-2 text-slate-400 w-4 h-4 pointer-events-none" />
                          <input 
                            type="date"
                            className={`w-full pr-8 pl-8 py-2.5 bg-slate-50 dark:bg-slate-800 border rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-primary-500/20 text-xs cursor-pointer ${
                              itemErrors[item.id]?.expiry_date || itemErrors[item.id]?.expiry_expired ? 'border-red-500 ring-2 ring-red-500/20' : 'border-none'
                            }`}
                            value={item.expiry_date}
                            onChange={(e) => updateCartItem(item.id, 'expiry_date', e.target.value)}
                            onClick={(e) => { try { e.currentTarget.showPicker(); } catch (err) {} }}
                            onFocus={(e) => { try { e.currentTarget.showPicker(); } catch (err) {} }}
                            onKeyDown={handleEnterNext}
                          />
                        </div>
                      </td>
                      <td className="px-2 py-3">
                        <input 
                          type="text"
                          className="w-12 p-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-primary-500/20 text-xs"
                          value={item.strips_per_box === undefined || item.strips_per_box === null ? '' : item.strips_per_box}
                          onChange={(e) => {
                            const val = e.target.value.replace(/[^0-9]/g, '');
                            updateCartItem(item.id, 'strips_per_box', val ? parseInt(val) : '');
                          }}
                          onKeyDown={handleEnterNext}
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
                          onKeyDown={handleEnterNext}
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
                          onKeyDown={handleEnterNext}
                        />
                      </td>
                      <td className="px-2 py-3">
                        <input 
                          type="text"
                          className={`w-16 p-2.5 bg-slate-50 dark:bg-slate-800 border rounded-xl font-bold text-center outline-none focus:ring-2 focus:ring-blue-500/20 text-xs text-blue-600 dark:text-blue-400 ${
                            itemErrors[item.id]?.cost_price ? 'border-red-500 ring-2 ring-red-500/20' : 'border-none'
                          }`}
                          value={item.cost_price}
                          onChange={(e) => {
                            const val = e.target.value.replace(/[^0-9.]/g, '');
                            updateCartItem(item.id, 'cost_price', val);
                          }}
                          onKeyDown={handleEnterNext}
                        />
                        <div className="mt-1 text-[9px] font-bold text-emerald-600 text-center">
                          {calculateTaxedUnitCost(item).toFixed(2)} {'شامل الضريبة'}
                        </div>
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
          onDrugUpdated={(updatedDrug) => {
            setCart(prev => prev.map(item => String(item.id) === String(updatedDrug.id) ? {
              ...item,
              trade_name: updatedDrug.trade_name,
              trade_name_en: updatedDrug.trade_name_en,
              barcode: updatedDrug.barcode,
              official_price: updatedDrug.official_price || item.official_price,
              selling_price: updatedDrug.official_price || item.selling_price,
              large_unit: updatedDrug.large_unit,
              medium_unit: updatedDrug.medium_unit,
              small_unit: updatedDrug.small_unit,
              large_to_medium: updatedDrug.large_to_medium,
              medium_to_small: updatedDrug.medium_to_small
            } : item));
          }}
        />
      )}

      {isQuickAddOpen && (
        <QuickAddDrugModal
          onClose={() => setIsQuickAddOpen(false)}
          onSuccess={(drugId, tradeName, large_unit, official_price, large_to_medium, barcode) => {
            setIsQuickAddOpen(false);
            if (drugId) {
              addToCart({
                id: drugId,
                trade_name: tradeName,
                trade_name_en: tradeName,
                official_price: official_price,
                base_price: official_price,
                large_unit: large_unit,
                large_to_medium: large_to_medium || 1,
                barcode: barcode || ''
              });
              toast.success(`تمت إضافة "${tradeName}" للفاتورة`);
            }
          }}
        />
      )}

      {showDraftsModal && (
        <div className="fixed inset-0 z-[200] bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 rounded-[35px] max-w-2xl w-full p-8 border border-slate-100 dark:border-slate-800 shadow-2xl space-y-6">
            <div className="flex justify-between items-center pb-4 border-b border-slate-100 dark:border-slate-800 flex-row-reverse">
              <h3 className="text-xl font-black text-slate-900 dark:text-white">المسودات المحفوظة</h3>
              <button onClick={() => setShowDraftsModal(false)} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-850 rounded-xl transition-all"><X className="w-5 h-5 text-slate-500" /></button>
            </div>
            
            <div className="max-h-[400px] overflow-y-auto space-y-3 pr-2">
              {drafts.length === 0 ? (
                <p className="text-center text-slate-400 py-12 font-bold text-sm">لا توجد مسودات محفوظة حالياً</p>
              ) : (
                drafts.map(d => (
                  <div key={d.id} className="flex justify-between items-center p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-100 dark:border-slate-800 flex-row-reverse">
                    <div className="text-right">
                      <p className="font-black text-sm text-slate-950 dark:text-white">{d.supplier_name}</p>
                      <p className="text-xs text-slate-400 font-bold mt-1">رقم الفاتورة: {d.invoice_number || 'بدون رقم'} | تاريخ: {d.invoice_date}</p>
                    </div>
                    <button 
                      onClick={() => handleLoadDraft(d.id)}
                      className="px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white text-xs font-bold rounded-xl transition-all shadow-md shadow-primary-500/20"
                    >
                      تحميل المسودة
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
</div>
  )
}
