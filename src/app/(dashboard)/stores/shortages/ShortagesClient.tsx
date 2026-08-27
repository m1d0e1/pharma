'use client'

import React, { useState } from 'react'
import {
  FileText, Search, CheckCircle2, Clock, AlertCircle, Package,
  Printer, RefreshCw, Loader2, Warehouse, Trash2, ShoppingCart,
  Copy, Edit3, Check, Building2, Tag, CheckCheck, Square, CheckSquare, X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'react-hot-toast'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  getShortagesAction,
  syncLowStockToShortagesAction,
  updateShortageStatusAction,
  updateShortageQuantityAction,
  deleteShortageAction,
  deleteShortagesBulkAction,
  updateShortagesStatusBulkAction
} from '@/app/actions-client/shortages'
import PurchaseOrderModal from '@/components/inventory/PurchaseOrderModal'

export default function ShortagesClient({ initialData }: { initialData: any[] }) {
  const router = useRouter()
  const [data, setData] = useState(initialData)
  const [search, setSearch] = useState('')
  const [activeTab, setActiveTab] = useState<'all' | 'out_of_stock' | 'pending' | 'ordered'>('all')
  const [isSyncing, setIsSyncing] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editQty, setEditQty] = useState<number>(1)
  const [editNotes, setEditNotes] = useState<string>('')
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [isPoModalOpen, setIsPoModalOpen] = useState(false)
  const [poItems, setPoItems] = useState<any[]>([])

  const { pendingCount, orderedCount, outOfStockCount } = React.useMemo(() => {
    let pending = 0;
    let ordered = 0;
    let outOfStock = 0;
    for (const item of data) {
      if (item.status === 'pending') pending++;
      else if (item.status === 'ordered') ordered++;

      if (Number(item.current_stock || 0) <= 0 || item.inventory_status === 'out_of_stock' || item.inventory_status === 'critical') {
        outOfStock++;
      }
    }
    return { pendingCount: pending, orderedCount: ordered, outOfStockCount: outOfStock };
  }, [data]);

  const filtered = React.useMemo(() => {
    const q = search.toLowerCase().trim();
    return data.filter(item => {
      if (activeTab === 'pending' && item.status !== 'pending') return false;
      if (activeTab === 'ordered' && item.status !== 'ordered') return false;
      if (activeTab === 'out_of_stock') {
        const isUrgent = Number(item.current_stock || 0) <= 0 || item.inventory_status === 'out_of_stock' || item.inventory_status === 'critical';
        if (!isUrgent) return false;
      }

      if (!q) return true;
      return (
        (item.trade_name || '').toLowerCase().includes(q) ||
        (item.trade_name_en && item.trade_name_en.toLowerCase().includes(q)) ||
        (item.generic_name && item.generic_name.toLowerCase().includes(q)) ||
        (item.notes && item.notes.toLowerCase().includes(q)) ||
        (item.last_supplier_name && item.last_supplier_name.toLowerCase().includes(q))
      );
    });
  }, [data, activeTab, search]);

  const filteredIds = React.useMemo(() => filtered.map(item => item.id), [filtered]);
  const isAllFilteredSelected = filteredIds.length > 0 && filteredIds.every(id => selectedIds.includes(id));

  const handleToggleSelect = (id: number) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id])
  }

  const handleSelectAllFiltered = () => {
    if (isAllFilteredSelected) {
      setSelectedIds(prev => prev.filter(id => !filteredIds.includes(id)))
    } else {
      setSelectedIds(prev => Array.from(new Set([...prev, ...filteredIds])))
    }
  }

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
      setSelectedIds(prev => prev.filter(i => i !== id))
      toast.success(newStatus === 'received' ? 'تم استلام الصنف وتوريده للمخزون' : 'تم تغيير الحالة إلى قيد الطلب')
    } catch (err: any) {
      console.error(err)
      toast.error(err.message || 'فشل تحديث الحالة')
    }
  }

  const handleDelete = async (id: number, drugName: string) => {
    if (!confirm(`هل أنت متأكد من حذف (${drugName}) من كشكول النواقص؟`)) return
    try {
      const result = await deleteShortageAction(id)
      if (!result.success) throw new Error(result.error || 'فشل الحذف')
      setData(prev => prev.filter(item => item.id !== id))
      setSelectedIds(prev => prev.filter(i => i !== id))
      toast.success('تم حذف الصنف من كشكول النواقص')
    } catch (err: any) {
      toast.error(err.message || 'فشل الحذف')
    }
  }

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return
    if (!confirm(`هل أنت متأكد من حذف ${selectedIds.length} صنف من كشكول النواقص؟`)) return
    try {
      const result = await deleteShortagesBulkAction(selectedIds)
      if (!result.success) throw new Error(result.error || 'فشل الحذف الجماعي')
      setData(prev => prev.filter(item => !selectedIds.includes(item.id)))
      setSelectedIds([])
      toast.success(`تم حذف ${result.count || selectedIds.length} صنف بنجاح`)
    } catch (err: any) {
      toast.error(err.message || 'فشل الحذف الجماعي')
    }
  }

  const handleBulkStatusUpdate = async (newStatus: string) => {
    if (selectedIds.length === 0) return
    try {
      const result = await updateShortagesStatusBulkAction(selectedIds, newStatus)
      if (!result.success) throw new Error(result.error || 'فشل تحديث الحالة')
      if (newStatus === 'received') {
        setData(prev => prev.filter(item => !selectedIds.includes(item.id)))
        toast.success(`تم استلام وتوريد الأصناف المحددة`)
      } else {
        setData(prev => prev.map(item => selectedIds.includes(item.id) ? { ...item, status: newStatus } : item))
        toast.success(`تم تحديث حالة ${result.count || selectedIds.length} صنف بنجاح`)
      }
      setSelectedIds([])
    } catch (err: any) {
      toast.error(err.message || 'فشل تحديث الحالة')
    }
  }

  const startEditing = (item: any) => {
    setEditingId(item.id)
    setEditQty(item.requested_quantity || 1)
    setEditNotes(item.notes || '')
  }

  const saveEditing = async (id: number) => {
    try {
      const result = await updateShortageQuantityAction(id, editQty, editNotes)
      if (!result.success) throw new Error(result.error || 'فشل تعديل البيانات')
      setData(prev => prev.map(item => item.id === id ? {
        ...item,
        requested_quantity: editQty,
        notes: editNotes.trim() || null
      } : item))
      setEditingId(null)
      toast.success('تم حفظ التعديلات بنجاح')
    } catch (err: any) {
      toast.error(err.message || 'فشل التعديل')
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

  const handleCopyForWhatsApp = (useSelectedOnly = false) => {
    const itemsToCopy = useSelectedOnly && selectedIds.length > 0
      ? data.filter(i => selectedIds.includes(i.id))
      : filtered

    if (itemsToCopy.length === 0) {
      toast.error('لا توجد أصناف لنسخها')
      return
    }

    const lines = [
      '📋 *طلبيّة نواقص الأدوية*',
      `التاريخ: ${new Date().toLocaleDateString('ar-EG')}`,
      '--------------------------------',
      ...itemsToCopy.map((item, idx) => {
        const name = item.trade_name_en || item.trade_name
        const note = item.notes ? ` (ملاحظة: ${item.notes})` : ''
        return `${idx + 1}. ${name} - الكمية: ${item.requested_quantity}${note}`
      }),
      '--------------------------------',
      `إجمالي الأصناف: ${itemsToCopy.length}`
    ]

    const text = lines.join('\n')
    navigator.clipboard.writeText(text).then(() => {
      toast.success(`تم نسخ ${itemsToCopy.length} صنف للحافظة جاهزة للمشاركة عبر الواتساب`)
    }).catch(() => {
      toast.error('فشل نسخ النص')
    })
  }

  const handleConvertToPurchase = async (useSelectedOnly = false) => {
    const itemsToConvert = useSelectedOnly && selectedIds.length > 0
      ? data.filter(i => selectedIds.includes(i.id))
      : filtered

    if (itemsToConvert.length === 0) {
      toast.error('لا توجد أصناف لتحويلها')
      return
    }

    try {
      sessionStorage.setItem('shortages_to_purchase', JSON.stringify(itemsToConvert))
      toast.success(`جاري تحويل ${itemsToConvert.length} صنف وتحديث حالتها إلى (قيد الطلب)...`)
      router.push('/purchases/new')

      const idsToUpdate = itemsToConvert.filter(i => i.status === 'pending').map(i => i.id);
      if (idsToUpdate.length > 0) {
        updateShortagesStatusBulkAction(idsToUpdate, 'ordered').catch(console.error);
        setData(prev => prev.map(item => idsToUpdate.includes(item.id) ? { ...item, status: 'ordered' } : item));
      }
    } catch (e) {
      console.error(e)
      toast.error('فشل تحويل الأصناف')
    }
  }

  const handleOpenPurchaseOrderModal = (useSelectedOnly = false) => {
    const itemsToOrder = useSelectedOnly && selectedIds.length > 0
      ? data.filter(i => selectedIds.includes(i.id))
      : filtered

    if (itemsToOrder.length === 0) {
      toast.error('لا توجد أصناف لإنشاء أمر الشراء')
      return
    }

    setPoItems(itemsToOrder)
    setIsPoModalOpen(true)
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500" dir="rtl">
      {/* Header */}
      <div className="bg-white dark:bg-slate-900 p-8 rounded-[40px] shadow-hard border border-slate-100 dark:border-slate-800 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 relative overflow-hidden">
        <div className="relative z-10">
          <div className="flex items-center gap-4 mb-2">
            <div className="w-12 h-12 bg-primary-600 rounded-2xl flex items-center justify-center text-white shadow-lg">
              <FileText className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-3xl font-black text-slate-900 dark:text-white">كشكول النواقص</h1>
              <p className="text-slate-500 font-bold">تسجيل ومتابعة الأصناف الناقصة وإعداد طلبيات الشراء</p>
            </div>
          </div>
        </div>

        {/* Quick Stats Badges */}
        <div className="flex items-center gap-3 relative z-10 flex-wrap">
          <button
            onClick={() => setActiveTab(activeTab === 'out_of_stock' ? 'all' : 'out_of_stock')}
            className={cn(
              "px-5 py-3 rounded-2xl border font-black text-sm transition-all flex items-center gap-2 cursor-pointer active:scale-95",
              activeTab === 'out_of_stock'
                ? "bg-rose-600 text-white border-rose-600 shadow-md shadow-rose-500/20"
                : "bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900/40 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/50"
            )}
          >
            <AlertCircle className="w-4 h-4" />
            منتهي / حرج: {outOfStockCount} صنف
          </button>
          <button
            onClick={() => setActiveTab(activeTab === 'pending' ? 'all' : 'pending')}
            className={cn(
              "px-5 py-3 rounded-2xl border font-black text-sm transition-all flex items-center gap-2 cursor-pointer active:scale-95",
              activeTab === 'pending'
                ? "bg-amber-600 text-white border-amber-600 shadow-md shadow-amber-500/20"
                : "bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-900/40 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50"
            )}
          >
            مطلوب: {pendingCount} صنف
          </button>
          <button
            onClick={() => setActiveTab(activeTab === 'ordered' ? 'all' : 'ordered')}
            className={cn(
              "px-5 py-3 rounded-2xl border font-black text-sm transition-all flex items-center gap-2 cursor-pointer active:scale-95",
              activeTab === 'ordered'
                ? "bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-500/20"
                : "bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50"
            )}
          >
            قيد الطلب: {orderedCount} صنف
          </button>
        </div>

        <div className="absolute left-[-20px] top-[-20px] w-64 h-64 bg-primary-500/5 rounded-full blur-3xl" />
      </div>

      {/* Toolbar & Tabs */}
      <div className="flex flex-col gap-4 no-print">
        {/* Tabs & Search Row */}
        <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
          {/* Tabs */}
          <div className="flex bg-slate-100 dark:bg-slate-800 p-1.5 rounded-3xl w-full md:w-auto flex-wrap">
            <button
              onClick={() => setActiveTab('all')}
              className={cn(
                "flex-1 md:flex-none px-6 py-2.5 rounded-2xl font-black text-xs transition-all",
                activeTab === 'all'
                  ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              )}
            >
              الكل ({data.length})
            </button>
            <button
              onClick={() => setActiveTab('out_of_stock')}
              className={cn(
                "flex-1 md:flex-none px-6 py-2.5 rounded-2xl font-black text-xs transition-all flex items-center justify-center gap-1.5",
                activeTab === 'out_of_stock'
                  ? "bg-rose-600 text-white shadow-sm"
                  : "text-rose-600 hover:text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30"
              )}
            >
              <AlertCircle className="w-3.5 h-3.5" />
              منتهي / حرج ({outOfStockCount})
            </button>
            <button
              onClick={() => setActiveTab('pending')}
              className={cn(
                "flex-1 md:flex-none px-6 py-2.5 rounded-2xl font-black text-xs transition-all",
                activeTab === 'pending'
                  ? "bg-amber-500 text-white shadow-sm"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              )}
            >
              مطلوب ({pendingCount})
            </button>
            <button
              onClick={() => setActiveTab('ordered')}
              className={cn(
                "flex-1 md:flex-none px-6 py-2.5 rounded-2xl font-black text-xs transition-all",
                activeTab === 'ordered'
                  ? "bg-blue-600 text-white shadow-sm"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400"
              )}
            >
              قيد الطلب ({orderedCount})
            </button>
          </div>

          {/* Search Input */}
          <div className="relative w-full md:w-96">
            <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
            <input 
              type="text" 
              placeholder="بحث باسم الدواء، المورد، أو الملاحظة..."
              className="w-full pr-12 pl-4 py-3.5 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-3xl shadow-soft focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none font-bold text-sm transition-all"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Action Buttons Toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleSelectAllFiltered}
            className={cn(
              "px-5 py-3 rounded-2xl font-black text-xs shadow-sm transition-all flex items-center gap-2 active:scale-95",
              isAllFilteredSelected
                ? "bg-primary-600 text-white shadow-primary-500/20"
                : "bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
            )}
          >
            <CheckCheck className="w-4 h-4" />
            {isAllFilteredSelected ? "إلغاء تحديد الكل" : `تحديد الكل (${filtered.length})`}
          </button>

          <button
            onClick={handleSync}
            disabled={isSyncing}
            className="bg-purple-50 text-purple-600 dark:bg-purple-950/40 dark:text-purple-300 hover:bg-purple-600 hover:text-white px-6 py-3 rounded-2xl font-black text-xs shadow-sm transition-all flex items-center gap-2 active:scale-95 disabled:opacity-50"
          >
            {isSyncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            مزامنة مع المخزون
          </button>

          <button
            onClick={() => handleOpenPurchaseOrderModal(false)}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-2xl font-black text-xs shadow-md shadow-blue-500/20 transition-all flex items-center gap-2 active:scale-95"
          >
            <Package className="w-4 h-4" />
            إنشاء أمر شراء ({filtered.length})
          </button>

          <button
            onClick={() => handleConvertToPurchase(false)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-2xl font-black text-xs shadow-md shadow-emerald-500/20 transition-all flex items-center gap-2 active:scale-95"
          >
            <ShoppingCart className="w-4 h-4" />
            تحويل إلى فاتورة مشتريات ({filtered.length})
          </button>

          <button
            onClick={() => handleCopyForWhatsApp(false)}
            className="bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300 hover:bg-green-600 hover:text-white border border-green-200 dark:border-green-800/40 px-6 py-3 rounded-2xl font-black text-xs shadow-sm transition-all flex items-center gap-2 active:scale-95"
          >
            <Copy className="w-4 h-4" />
            نسخ طلبية للواتساب
          </button>

          <button 
            onClick={() => window.print()}
            className="bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-100 dark:border-slate-800 hover:bg-slate-50 px-6 py-3 rounded-2xl font-black text-xs shadow-sm transition-all flex items-center gap-2 active:scale-95 mr-auto"
          >
            <Printer className="w-4 h-4" />
            طباعة النواقص
          </button>

          <Link
            href="/inventory/low-stock"
            className="bg-primary-600 hover:bg-primary-700 text-white px-6 py-3 rounded-2xl font-black text-xs shadow-sm transition-all flex items-center gap-2 active:scale-95"
          >
            <Warehouse className="w-4 h-4" />
            عرض نواقص المخزون
          </Link>
        </div>

        {/* Floating Bulk Actions Bar */}
        {selectedIds.length > 0 && (
          <div className="bg-slate-900 text-white p-4 sm:p-5 rounded-3xl shadow-2xl border border-slate-800 flex flex-wrap items-center justify-between gap-4 sticky top-4 z-30 animate-in slide-in-from-top duration-300">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-2xl bg-primary-600 text-white flex items-center justify-center font-black text-sm shadow-md shadow-primary-500/30">
                {selectedIds.length}
              </span>
              <div>
                <p className="font-black text-sm text-white">تم تحديد {selectedIds.length} صنف</p>
                <p className="text-[11px] text-slate-400 font-bold">يمكنك تطبيق إجراء جماعي على جميع الأصناف المحددة</p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleBulkDelete}
                className="bg-rose-600 hover:bg-rose-700 text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95 shadow-md shadow-rose-600/20"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>حذف المحدد ({selectedIds.length})</span>
              </button>

              <button
                onClick={() => handleBulkStatusUpdate('ordered')}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95 shadow-md shadow-blue-600/20"
              >
                <Clock className="w-3.5 h-3.5" />
                <span>تحويل لـ قيد الطلب</span>
              </button>

              <button
                onClick={() => handleBulkStatusUpdate('pending')}
                className="bg-amber-600 hover:bg-amber-700 text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95 shadow-md shadow-amber-600/20"
              >
                <Clock className="w-3.5 h-3.5" />
                <span>إعادة لـ مطلوب</span>
              </button>

              <button
                onClick={() => handleBulkStatusUpdate('received')}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95 shadow-md shadow-emerald-600/20"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>تم الاستلام</span>
              </button>

              <button
                onClick={() => handleOpenPurchaseOrderModal(true)}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95 shadow-md shadow-blue-600/20"
              >
                <Package className="w-3.5 h-3.5" />
                <span>إنشاء أمر شراء ({selectedIds.length})</span>
              </button>

              <button
                onClick={() => handleConvertToPurchase(true)}
                className="bg-primary-600 hover:bg-primary-700 text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95"
              >
                <ShoppingCart className="w-3.5 h-3.5" />
                <span>تحويل للمشتريات ({selectedIds.length})</span>
              </button>

              <button
                onClick={() => handleCopyForWhatsApp(true)}
                className="bg-slate-800 hover:bg-slate-700 text-green-400 border border-green-500/30 px-3.5 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>نسخ للواتساب</span>
              </button>

              <button
                onClick={() => setSelectedIds([])}
                className="text-slate-400 hover:text-white px-3 py-2 rounded-xl font-bold text-xs hover:bg-white/10 transition-colors"
              >
                إلغاء التحديد
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Shortages Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filtered.length > 0 ? (
          filtered.map((item) => {
            const isEditing = editingId === item.id
            const isSelected = selectedIds.includes(item.id)

            return (
              <div 
                key={item.id}
                className={cn(
                  "bg-white dark:bg-slate-900 p-6 rounded-[32px] border transition-all duration-300 flex flex-col gap-4 group relative",
                  isSelected
                    ? "border-primary-500 ring-2 ring-primary-500/20 bg-primary-50/10 dark:bg-primary-950/20 shadow-hard"
                    : "border-slate-100 dark:border-slate-800 shadow-soft hover:shadow-hard"
                )}
              >
                {/* Top Row: Selection Checkbox + Title + Status + Delete */}
                <div className="flex justify-between items-start gap-2">
                  <div className="flex items-start gap-3 flex-1">
                    {/* Multi-select Checkbox */}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleToggleSelect(item.id); }}
                      className={cn(
                        "w-7 h-7 rounded-xl flex items-center justify-center transition-all shrink-0 mt-0.5 no-print",
                        isSelected
                          ? "bg-primary-600 text-white shadow-md shadow-primary-500/30 ring-2 ring-primary-500/40"
                          : "bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600 hover:bg-slate-200 dark:hover:bg-slate-700"
                      )}
                      title={isSelected ? "إلغاء تحديد الصنف" : "تحديد الصنف"}
                    >
                      {isSelected ? <Check className="w-4 h-4 stroke-[3]" /> : <Square className="w-4 h-4" />}
                    </button>

                    <div>
                      <h3 className="font-black text-slate-900 dark:text-white text-lg group-hover:text-primary-600 transition-colors leading-tight">
                        {item.trade_name_en || item.trade_name}
                      </h3>
                      <p className="text-slate-400 font-bold text-[11px] mt-0.5">
                        {item.trade_name_en ? item.trade_name : (item.generic_name || 'بدون إسم علمي')}
                      </p>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    {Number(item.current_stock || 0) <= 0 ? (
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-200 dark:border-rose-900/60 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3 text-rose-600" />
                        منتهي
                      </span>
                    ) : item.inventory_status === 'critical' ? (
                      <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-400 border border-orange-200 dark:border-orange-900/60 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3 text-orange-600" />
                        حرج
                      </span>
                    ) : null}

                    <span className={cn(
                      "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider",
                      item.status === 'pending' ? "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400" : "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-400"
                    )}>
                      {item.status === 'pending' ? 'مطلوب' : 'قيد الطلب'}
                    </span>

                    {/* Delete button */}
                    <button
                      onClick={() => handleDelete(item.id, item.trade_name_en || item.trade_name)}
                      className="text-slate-300 hover:text-red-500 dark:hover:text-red-400 p-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition-all no-print"
                      title="حذف من الكشكول"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Stock Details Grid */}
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

                {/* Last Supplier & Cost Info (if available) */}
                {(item.last_supplier_name || Number(item.last_cost_price) > 0) && (
                  <div className="flex items-center justify-between px-3 py-2 bg-slate-50 dark:bg-slate-800/60 rounded-xl text-[11px] font-bold text-slate-600 dark:text-slate-400">
                    {item.last_supplier_name && (
                      <span className="flex items-center gap-1">
                        <Building2 className="w-3.5 h-3.5 text-slate-400" />
                        <span>آخر مورد: <b className="text-slate-800 dark:text-slate-200">{item.last_supplier_name}</b></span>
                      </span>
                    )}
                    {Number(item.last_cost_price) > 0 && (
                      <span className="flex items-center gap-1">
                        <Tag className="w-3.5 h-3.5 text-slate-400" />
                        <span>آخر تكلفة: <b className="text-slate-800 dark:text-slate-200">{Number(item.last_cost_price).toFixed(2)} ج.م</b></span>
                      </span>
                    )}
                  </div>
                )}

                {/* Requested Quantity & Notes Section (With Inline Edit) */}
                {isEditing ? (
                  <div className="p-3 bg-primary-50 dark:bg-primary-950/30 rounded-2xl space-y-2 border border-primary-200 dark:border-primary-800/50">
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-black text-slate-700 dark:text-slate-300 w-20">الكمية:</label>
                      <input
                        type="number"
                        min="1"
                        value={editQty}
                        onChange={(e) => setEditQty(Math.max(1, parseInt(e.target.value) || 1))}
                        className="flex-1 px-3 py-1.5 bg-white dark:bg-slate-900 border rounded-xl font-black text-xs text-primary-600 outline-none"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs font-black text-slate-700 dark:text-slate-300 w-20">ملاحظة:</label>
                      <input
                        type="text"
                        placeholder="مثل: مطلوب لعميل..."
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        className="flex-1 px-3 py-1.5 bg-white dark:bg-slate-900 border rounded-xl font-bold text-xs outline-none"
                      />
                    </div>
                    <div className="flex gap-2 justify-end pt-1">
                      <button
                        onClick={() => setEditingId(null)}
                        className="px-3 py-1 text-xs font-bold text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-lg"
                      >
                        إلغاء
                      </button>
                      <button
                        onClick={() => saveEditing(item.id)}
                        className="px-4 py-1 text-xs font-black bg-primary-600 text-white hover:bg-primary-700 rounded-lg flex items-center gap-1"
                      >
                        <Check className="w-3.5 h-3.5" />
                        حفظ
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-slate-500 text-xs font-bold">
                    <div className="flex items-center gap-2">
                      <span className="flex items-center gap-1 text-slate-700 dark:text-slate-300 font-black">
                        <Package className="w-4 h-4 text-primary-500" />
                        الكمية المطلوبة: <span className="text-primary-600">{item.requested_quantity}</span>
                      </span>
                      <button
                        onClick={() => startEditing(item)}
                        className="text-slate-400 hover:text-primary-600 p-0.5 rounded transition-colors no-print"
                        title="تعديل الكمية والملاحظات"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="flex items-center gap-1 text-slate-400 text-[10px]">
                      <Clock className="w-3.5 h-3.5" />
                      <span>{new Date(item.created_at).toLocaleDateString('ar-EG')}</span>
                    </div>

                    {item.notes && (
                      <div className="w-full text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 px-3 py-1 rounded-xl">
                        ملاحظة: {item.notes}
                      </div>
                    )}
                  </div>
                )}

                {/* Status Update Actions */}
                <div className="flex gap-2 mt-auto pt-2 no-print">
                  {item.status === 'pending' ? (
                    <button 
                      onClick={() => handleStatusUpdate(item.id, 'ordered')}
                      className="flex-1 bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white py-3 rounded-2xl font-black text-xs transition-all flex items-center justify-center gap-2"
                    >
                      <Clock className="w-4 h-4" />
                      تم الطلب
                    </button>
                  ) : (
                    <button 
                      onClick={() => handleStatusUpdate(item.id, 'pending')}
                      className="flex-1 bg-slate-50 text-slate-600 hover:bg-slate-600 hover:text-white py-3 rounded-2xl font-black text-xs transition-all flex items-center justify-center gap-2"
                    >
                      <Clock className="w-4 h-4" />
                      إعادة لـ مطلوب
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
            )
          })
        ) : (
          <div className="col-span-full py-20 flex flex-col items-center justify-center text-slate-400 gap-4 bg-white/50 dark:bg-slate-900/50 rounded-[40px] border-2 border-dashed border-slate-200 dark:border-slate-800">
            <AlertCircle className="w-16 h-16 opacity-20" />
            <p className="font-black text-xl">لا توجد أصناف في هذه القائمة حالياً</p>
          </div>
        )}
      </div>

      {/* Purchase Order Modal */}
      {isPoModalOpen && (
        <PurchaseOrderModal
          initialItems={poItems}
          onClose={() => setIsPoModalOpen(false)}
          onSuccess={async () => {
            await reload();
            setSelectedIds([]);
          }}
        />
      )}

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
