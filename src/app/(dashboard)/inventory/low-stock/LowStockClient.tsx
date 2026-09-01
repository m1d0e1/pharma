'use client';
import TableScrollContainer from '@/components/ui/TableScrollContainer';

import React, { useState, useMemo } from 'react';
import { 
  Search, 
  ArrowLeft, 
  ShoppingCart, 
  ExternalLink,
  TrendingDown,
  Printer,
  Package,
  AlertCircle,
  ClipboardList,
  Loader2,
  Copy,
  CheckCheck,
  Square,
  CheckSquare,
  FileText,
  Warehouse,
  X,
  Plus,
  Download,
  LayoutGrid,
  Table as TableIcon
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'react-hot-toast';
import { cn } from '@/lib/utils';
import { addToShortagesAction } from '@/app/actions-client/shortages';
import PurchaseOrderModal from '@/components/inventory/PurchaseOrderModal';

export interface LowStockItem {
  id: string | number;
  drug_id: number;
  quantity: number;
  local_selling_price: number;
  expiry_date?: string;
  trade_name: string;
  trade_name_en?: string;
  active_ingredient: string;
  official_price: number;
  manufacturer: string;
  barcode?: string;
  reorder_point?: number;
  default_purchase_qty?: number;
  avg_monthly_usage?: number;
  deficit?: number;
  status?: 'out_of_stock' | 'critical' | 'low';
}

interface Props {
  initialItems: LowStockItem[];
}

export default function LowStockClient({ initialItems }: Props) {
  const router = useRouter();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'out_of_stock' | 'critical' | 'low'>('all');
  const [savingDrugId, setSavingDrugId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [isBulkAdding, setIsBulkAdding] = useState(false);
  const [isPoModalOpen, setIsPoModalOpen] = useState(false);
  const [poItems, setPoItems] = useState<any[]>([]);
  const [viewMode, setViewMode] = useState<'grid' | 'table'>('grid');

  const filteredItems = useMemo(() => {
    return initialItems.filter(item => {
      const matchesSearch = 
        item.trade_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (item.trade_name_en && item.trade_name_en.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (item.active_ingredient && item.active_ingredient.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (item.manufacturer && item.manufacturer.toLowerCase().includes(searchTerm.toLowerCase())) ||
        (item.barcode && item.barcode.toLowerCase().includes(searchTerm.toLowerCase()));

      if (!matchesSearch) return false;

      if (filterStatus === 'out_of_stock') return Number(item.quantity || 0) <= 0;
      if (filterStatus === 'critical') return Number(item.quantity || 0) > 0 && item.status === 'critical';
      if (filterStatus === 'low') return Number(item.quantity || 0) > 0 && item.status !== 'critical';

      return true;
    });
  }, [initialItems, searchTerm, filterStatus]);

  const outOfStockCount = useMemo(() => initialItems.filter(i => Number(i.quantity || 0) <= 0).length, [initialItems]);
  const criticalCount = useMemo(() => initialItems.filter(i => Number(i.quantity || 0) > 0 && i.status === 'critical').length, [initialItems]);

  const filteredDrugIds = useMemo(() => filteredItems.map(item => item.drug_id), [filteredItems]);
  const isAllFilteredSelected = filteredDrugIds.length > 0 && filteredDrugIds.every(id => selectedIds.includes(id));

  const handleToggleSelect = (drugId: number) => {
    setSelectedIds(prev => prev.includes(drugId) ? prev.filter(id => id !== drugId) : [...prev, drugId]);
  };

  const handleSelectAllFiltered = () => {
    if (isAllFilteredSelected) {
      setSelectedIds(prev => prev.filter(id => !filteredDrugIds.includes(id)));
    } else {
      setSelectedIds(prev => Array.from(new Set([...prev, ...filteredDrugIds])));
    }
  };

  const getSuggestedQuantity = (item: LowStockItem) => {
    return Math.ceil(Math.max(
      Number(item.default_purchase_qty || 1),
      Number(item.deficit || 0),
      Number(item.avg_monthly_usage || 0),
      1
    ));
  };

  const addToNotebook = async (item: LowStockItem) => {
    const suggestedQuantity = getSuggestedQuantity(item);

    setSavingDrugId(item.drug_id);
    try {
      const result = await addToShortagesAction({ drug_id: item.drug_id, qty: suggestedQuantity });
      if (!result.success) throw new Error(result.error || 'فشل الإضافة');
      toast.success((result.data as any)?.created ? 'تمت الإضافة إلى كشكول النواقص' : 'الصنف موجود وتم تحديث كميته');
    } catch (error: any) {
      toast.error(error.message || 'فشل الإضافة إلى كشكول النواقص');
    } finally {
      setSavingDrugId(null);
    }
  };

  const handleBulkAddToShortages = async (useSelectedOnly = false) => {
    const itemsToAdd = useSelectedOnly && selectedIds.length > 0
      ? initialItems.filter(i => selectedIds.includes(i.drug_id))
      : filteredItems;

    if (itemsToAdd.length === 0) {
      toast.error('لا توجد أصناف للإضافة');
      return;
    }

    setIsBulkAdding(true);
    try {
      let successCount = 0;
      await Promise.all(
        itemsToAdd.map(async (item) => {
          const qty = getSuggestedQuantity(item);
          const res = await addToShortagesAction({ drug_id: item.drug_id, qty });
          if (res.success) successCount++;
        })
      );

      toast.success(`تمت إضافة وتحديث ${successCount} صنف في كشكول النواقص بنجاح`);
      setSelectedIds([]);
    } catch (err: any) {
      console.error(err);
      toast.error('حدث خطأ أثناء الإضافة الجماعية لكشكول النواقص');
    } finally {
      setIsBulkAdding(false);
    }
  };

  const handleOpenPurchaseOrderModal = (useSelectedOnly = false) => {
    const itemsToOrder = useSelectedOnly && selectedIds.length > 0
      ? initialItems.filter(i => selectedIds.includes(i.drug_id))
      : filteredItems;

    if (itemsToOrder.length === 0) {
      toast.error('لا توجد أصناف لإنشاء أمر الشراء');
      return;
    }

    const formattedPoItems = itemsToOrder.map(item => ({
      drug_id: item.drug_id,
      trade_name: item.trade_name,
      trade_name_en: item.trade_name_en,
      requested_quantity: getSuggestedQuantity(item),
      current_stock: item.quantity,
      cost_price: item.official_price || 0,
      reorder_point: item.reorder_point || 10
    }));

    setPoItems(formattedPoItems);
    setIsPoModalOpen(true);
  };

  const handleConvertToPurchase = (useSelectedOnly = false) => {
    const itemsToConvert = useSelectedOnly && selectedIds.length > 0
      ? initialItems.filter(i => selectedIds.includes(i.drug_id))
      : filteredItems;

    if (itemsToConvert.length === 0) {
      toast.error('لا توجد أصناف لتحويلها');
      return;
    }

    try {
      const formattedForPurchase = itemsToConvert.map(item => ({
        id: item.drug_id,
        drug_id: item.drug_id,
        trade_name: item.trade_name,
        trade_name_en: item.trade_name_en,
        requested_quantity: getSuggestedQuantity(item),
        current_stock: item.quantity,
        cost_price: item.official_price || 0
      }));

      sessionStorage.setItem('shortages_to_purchase', JSON.stringify(formattedForPurchase));
      toast.success(`جاري تحويل ${itemsToConvert.length} صنف إلى فاتورة مشتريات...`);
      router.push('/purchases/new');
    } catch (e) {
      console.error(e);
      toast.error('فشل تحويل الأصناف لفاتورة مشتريات');
    }
  };

  const handleCopyForWhatsApp = (useSelectedOnly = false) => {
    const itemsToCopy = useSelectedOnly && selectedIds.length > 0
      ? initialItems.filter(i => selectedIds.includes(i.drug_id))
      : filteredItems;

    if (itemsToCopy.length === 0) {
      toast.error('لا توجد أصناف لنسخها');
      return;
    }

    const lines = [
      '📋 *طلبيّة نواقص الأدوية (تنبيهات نقص المخزون)*',
      `التاريخ: ${new Date().toLocaleDateString('ar-EG')}`,
      '--------------------------------',
      ...itemsToCopy.map((item, idx) => {
        const name = item.trade_name_en || item.trade_name;
        const qty = getSuggestedQuantity(item);
        const stockInfo = ` (الرصيد: ${item.quantity} / حد الطلب: ${item.reorder_point || 10})`;
        return `${idx + 1}. ${name} - الكمية المطلوبة: ${qty}${stockInfo}`;
      }),
      '--------------------------------',
      `إجمالي الأصناف: ${itemsToCopy.length}`
    ];

    const text = lines.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      toast.success(`تم نسخ ${itemsToCopy.length} صنف للحافظة جاهزة للمشاركة عبر الواتساب`);
    }).catch(() => {
      toast.error('فشل نسخ النص');
    });
  };

  const handlePrint = () => {
    window.print();
  };

  const handleExportCSV = (useSelectedOnly = false) => {
    const itemsToExport = useSelectedOnly && selectedIds.length > 0
      ? initialItems.filter(i => selectedIds.includes(i.drug_id))
      : filteredItems;

    if (itemsToExport.length === 0) {
      toast.error('لا توجد بيانات للتصدير');
      return;
    }

    const headers = ['اسم الصنف', 'الاسم الإنجليزي', 'المادة الفعالة', 'الباركود', 'الشركة', 'الرصيد الحالي', 'حد الطلب', 'العجز', 'الكمية المقترحة', 'الحالة'];
    const rows = itemsToExport.map(item => [
      `"${(item.trade_name || '').replace(/"/g, '""')}"`,
      `"${(item.trade_name_en || '').replace(/"/g, '""')}"`,
      `"${(item.active_ingredient || '').replace(/"/g, '""')}"`,
      `"${item.barcode || ''}"`,
      `"${(item.manufacturer || '').replace(/"/g, '""')}"`,
      item.quantity,
      item.reorder_point || 10,
      Math.max(0, (item.reorder_point || 10) - item.quantity),
      getSuggestedQuantity(item),
      item.quantity <= 0 ? 'منتهي' : item.status === 'critical' ? 'حرج' : 'تحت حد الطلب'
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `low_stock_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success(`تم تصدير ${itemsToExport.length} صنف بنجاح`);
  };

  return (
    <div className="space-y-6" dir="rtl">
      {/* Search, Status Tabs & Actions Bar */}
      <div className="flex flex-col md:flex-row gap-4 items-center justify-between no-print">
        <div className="relative flex-1 group w-full">
          <Search className="absolute right-5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
          <input 
            type="text"
            placeholder="بحث بالاسم، الباركود، المادة الفعالة، أو الشركة المصنعة..."
            className="w-full pr-14 pl-6 py-4 bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm focus:ring-4 focus:ring-blue-500/5 outline-none transition-all font-bold text-sm"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto shrink-0">
          <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-2xl text-xs font-black">
            <button
              onClick={() => setFilterStatus('all')}
              className={`px-4 py-2 rounded-xl transition-all ${filterStatus === 'all' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-500'}`}
            >
              الكل ({initialItems.length})
            </button>
            <button
              onClick={() => setFilterStatus('out_of_stock')}
              className={`px-4 py-2 rounded-xl transition-all ${filterStatus === 'out_of_stock' ? 'bg-red-500 text-white shadow-sm' : 'text-red-500'}`}
            >
              منتهية ({outOfStockCount})
            </button>
            <button
              onClick={() => setFilterStatus('critical')}
              className={`px-4 py-2 rounded-xl transition-all ${filterStatus === 'critical' ? 'bg-amber-500 text-white shadow-sm' : 'text-amber-600'}`}
            >
              حرجة ({criticalCount})
            </button>
          </div>

          <Link
            href="/stores/shortages"
            className="px-5 py-3.5 bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300 rounded-2xl border border-purple-200 dark:border-purple-800/40 hover:bg-purple-600 hover:text-white transition-all flex items-center gap-2 font-black text-xs whitespace-nowrap"
          >
            <FileText className="w-4 h-4" />
            <span>كشكول النواقص</span>
          </Link>

          <Link 
            href="/inventory"
            className="px-5 py-3.5 bg-blue-600 text-white rounded-2xl shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all flex items-center gap-2 font-black text-xs whitespace-nowrap"
          >
            <ArrowLeft className="w-4 h-4 rotate-180" />
            <span>المخزون</span>
          </Link>
        </div>
      </div>

      {/* Action Buttons Toolbar */}
      <div className="flex flex-wrap items-center gap-3 no-print">
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
          {isAllFilteredSelected ? "إلغاء تحديد الكل" : `تحديد الكل (${filteredItems.length})`}
        </button>

        <button
          onClick={() => handleBulkAddToShortages(false)}
          disabled={isBulkAdding}
          className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-2xl font-black text-xs shadow-md shadow-purple-500/20 transition-all flex items-center gap-2 active:scale-95 disabled:opacity-50"
        >
          {isBulkAdding ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />}
          إضافة الكل للكشكول ({filteredItems.length})
        </button>

        <button
          onClick={() => handleOpenPurchaseOrderModal(false)}
          className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-2xl font-black text-xs shadow-md shadow-blue-500/20 transition-all flex items-center gap-2 active:scale-95"
        >
          <Package className="w-4 h-4" />
          إنشاء أمر شراء ({filteredItems.length})
        </button>

        <button
          onClick={() => handleConvertToPurchase(false)}
          className="bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-2xl font-black text-xs shadow-md shadow-emerald-500/20 transition-all flex items-center gap-2 active:scale-95"
        >
          <ShoppingCart className="w-4 h-4" />
          تحويل للمشتريات ({filteredItems.length})
        </button>

        <button
          onClick={() => handleCopyForWhatsApp(false)}
          className="bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300 hover:bg-green-600 hover:text-white border border-green-200 dark:border-green-800/40 px-5 py-3 rounded-2xl font-black text-xs shadow-sm transition-all flex items-center gap-2 active:scale-95"
        >
          <Copy className="w-4 h-4" />
          نسخ للواتساب
        </button>

        <button
          onClick={() => handleExportCSV(false)}
          className="bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 px-5 py-3 rounded-2xl font-black text-xs shadow-sm transition-all flex items-center gap-2 active:scale-95"
        >
          <Download className="w-4 h-4" />
          تصدير Excel
        </button>

        <button
          onClick={handlePrint}
          className="bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border border-slate-100 dark:border-slate-800 hover:bg-slate-50 px-5 py-3 rounded-2xl font-black text-xs shadow-sm transition-all flex items-center gap-2 active:scale-95"
        >
          <Printer className="w-4 h-4" />
          طباعة
        </button>

        <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-2xl mr-auto gap-1">
          <button
            onClick={() => setViewMode('grid')}
            className={cn(
              "p-2 rounded-xl transition-all",
              viewMode === 'grid' ? "bg-white dark:bg-slate-900 text-primary-600 shadow-sm" : "text-slate-400 hover:text-slate-600"
            )}
            title="عرض بطاقات"
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button
            onClick={() => setViewMode('table')}
            className={cn(
              "p-2 rounded-xl transition-all",
              viewMode === 'table' ? "bg-white dark:bg-slate-900 text-primary-600 shadow-sm" : "text-slate-400 hover:text-slate-600"
            )}
            title="عرض جدول"
          >
            <TableIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Floating Bulk Actions Bar */}
      {selectedIds.length > 0 && (
        <div className="bg-slate-900 text-white p-4 sm:p-5 rounded-3xl shadow-2xl border border-slate-800 flex flex-wrap items-center justify-between gap-4 sticky top-4 z-30 animate-in slide-in-from-top duration-300 no-print">
          <div className="flex items-center gap-3">
            <span className="w-9 h-9 rounded-2xl bg-primary-600 text-white flex items-center justify-center font-black text-sm shadow-md shadow-primary-500/30">
              {selectedIds.length}
            </span>
            <div>
              <p className="font-black text-sm text-white">تم تحديد {selectedIds.length} صنف</p>
              <p className="text-[11px] text-slate-400 font-bold">يمكنك تطبيق إجراء جماعي على الأصناف المحددة</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => handleBulkAddToShortages(true)}
              disabled={isBulkAdding}
              className="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95 shadow-md shadow-purple-600/20 disabled:opacity-50"
            >
              {isBulkAdding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ClipboardList className="w-3.5 h-3.5" />}
              إضافة للكشكول ({selectedIds.length})
            </button>

            <button
              onClick={() => handleOpenPurchaseOrderModal(true)}
              className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95 shadow-md shadow-blue-600/20"
            >
              <Package className="w-3.5 h-3.5" />
              أمر شراء ({selectedIds.length})
            </button>

            <button
              onClick={() => handleConvertToPurchase(true)}
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95 shadow-md shadow-emerald-600/20"
            >
              <ShoppingCart className="w-3.5 h-3.5" />
              فاتورة مشتريات ({selectedIds.length})
            </button>

            <button
              onClick={() => handleCopyForWhatsApp(true)}
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95 shadow-md shadow-green-600/20"
            >
              <Copy className="w-3.5 h-3.5" />
              نسخ للواتساب
            </button>

            <button
              onClick={() => handleExportCSV(true)}
              className="bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-3.5 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1.5 active:scale-95"
            >
              <Download className="w-3.5 h-3.5" />
              <span>تصدير ({selectedIds.length})</span>
            </button>

            <button
              onClick={() => setSelectedIds([])}
              className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-3.5 py-2.5 rounded-xl font-black text-xs transition-all flex items-center gap-1 active:scale-95"
            >
              <X className="w-3.5 h-3.5" />
              إلغاء التحديد
            </button>
          </div>
        </div>
      )}

      {/* Items List: Grid or Table View */}
      {viewMode === 'table' ? (
        <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
          <TableScrollContainer>
            <table className="w-full text-right text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-400 font-black border-b border-slate-100 dark:border-slate-800">
                <tr>
                  <th className="p-4 w-12 text-center no-print">
                    <button
                      type="button"
                      onClick={handleSelectAllFiltered}
                      className="p-1 text-slate-400 hover:text-primary-600"
                    >
                      {isAllFilteredSelected ? <CheckSquare className="w-4 h-4 text-primary-600" /> : <Square className="w-4 h-4" />}
                    </button>
                  </th>
                  <th className="p-4">الصنف الدوائي</th>
                  <th className="p-4 text-center">الرصيد الحالي</th>
                  <th className="p-4 text-center">حد الطلب</th>
                  <th className="p-4 text-center">العجز المقدر</th>
                  <th className="p-4 text-center">المقترح</th>
                  <th className="p-4">الشركة والمادة</th>
                  <th className="p-4 text-center">الحالة</th>
                  <th className="p-4 text-center no-print">إجراءات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-bold">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="p-12 text-center text-slate-400 italic">
                      لا توجد أصناف تطابق البحث
                    </td>
                  </tr>
                ) : (
                  filteredItems.map(item => {
                    const isZero = Number(item.quantity || 0) <= 0;
                    const reorderLimit = Number(item.reorder_point || 10);
                    const deficit = Math.max(0, reorderLimit - Number(item.quantity || 0));
                    const isSelected = selectedIds.includes(item.drug_id);
                    const suggested = getSuggestedQuantity(item);

                    return (
                      <tr 
                        key={item.id || item.drug_id} 
                        className={cn(
                          "hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors",
                          isSelected && "bg-blue-50/30 dark:bg-blue-950/20"
                        )}
                      >
                        <td className="p-4 text-center no-print">
                          <button
                            type="button"
                            onClick={() => handleToggleSelect(item.drug_id)}
                            className="p-1 text-slate-400 hover:text-primary-600"
                          >
                            {isSelected ? <CheckSquare className="w-4 h-4 text-primary-600" /> : <Square className="w-4 h-4" />}
                          </button>
                        </td>
                        <td className="p-4">
                          <div className="font-black text-sm text-slate-900 dark:text-white">
                            {item.trade_name_en || item.trade_name}
                          </div>
                          {item.barcode && (
                            <span className="text-[10px] text-slate-400 font-mono">{item.barcode}</span>
                          )}
                        </td>
                        <td className="p-4 text-center">
                          <span className={cn("px-2.5 py-1 rounded-lg text-xs font-black", isZero ? "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400" : "text-slate-800 dark:text-slate-200")}>
                            {item.quantity}
                          </span>
                        </td>
                        <td className="p-4 text-center text-slate-500 font-black">{reorderLimit}</td>
                        <td className="p-4 text-center">
                          <span className="text-red-600 font-black">-{deficit}</span>
                        </td>
                        <td className="p-4 text-center">
                          <span className="text-blue-600 bg-blue-50 dark:bg-blue-900/20 px-2.5 py-1 rounded-lg font-black">
                            {suggested}
                          </span>
                        </td>
                        <td className="p-4">
                          <div className="text-slate-700 dark:text-slate-300 truncate max-w-[160px]">{item.manufacturer || '---'}</div>
                          <div className="text-[10px] text-slate-400 truncate max-w-[160px]">{item.active_ingredient || '---'}</div>
                        </td>
                        <td className="p-4 text-center">
                          <span className={cn(
                            "px-2.5 py-1 rounded-full text-[10px] font-black",
                            isZero 
                              ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" 
                              : item.status === 'critical' 
                                ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                                : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                          )}>
                            {isZero ? 'منتهي' : item.status === 'critical' ? 'حرج' : 'تحت الحد'}
                          </span>
                        </td>
                        <td className="p-4 text-center no-print">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => addToNotebook(item)}
                              disabled={savingDrugId === item.drug_id}
                              className="px-2.5 py-1.5 bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-lg text-xs font-black transition-colors flex items-center gap-1 disabled:opacity-50"
                              title="إضافة لكشكول النواقص"
                            >
                              {savingDrugId === item.drug_id ? <Loader2 className="w-3 h-3 animate-spin" /> : <ClipboardList className="w-3 h-3" />}
                              <span>كشكول</span>
                            </button>
                            <Link
                              href={`/purchases/new?drugId=${item.drug_id}`}
                              className="px-2.5 py-1.5 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-xs font-black transition-colors flex items-center gap-1 shadow-sm"
                              title="طلب شراء"
                            >
                              <ShoppingCart className="w-3 h-3" />
                              <span>شراء</span>
                            </Link>
                            <Link
                              href={`/inventory?search=${encodeURIComponent(item.barcode || item.trade_name_en || item.trade_name)}`}
                              className="p-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-lg transition-colors"
                              title="عرض بالمخزون"
                            >
                              <Warehouse className="w-3.5 h-3.5" />
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </TableScrollContainer>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredItems.map((item) => {
            const isZero = Number(item.quantity || 0) <= 0;
            const reorderLimit = Number(item.reorder_point || 10);
            const deficit = Math.max(0, reorderLimit - Number(item.quantity || 0));
            const isSelected = selectedIds.includes(item.drug_id);

            return (
              <div 
                key={item.id || item.drug_id} 
                className={cn(
                  "group bg-white dark:bg-slate-900 p-6 rounded-[2.5rem] border shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all relative overflow-hidden flex flex-col justify-between",
                  isZero 
                    ? 'border-red-200 dark:border-red-900/40 border-t-8 border-t-red-600' 
                    : item.status === 'critical' 
                      ? 'border-amber-200 dark:border-amber-900/40 border-t-8 border-t-amber-500' 
                      : 'border-slate-100 dark:border-slate-800 border-t-8 border-t-blue-500',
                  isSelected && "ring-2 ring-primary-500 bg-blue-50/20 dark:bg-blue-950/20 shadow-md"
                )}
              >
                <div>
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex items-center gap-2">
                      {/* Checkbox button */}
                      <button
                        type="button"
                        onClick={() => handleToggleSelect(item.drug_id)}
                        className={cn(
                          "p-1.5 rounded-xl transition-all active:scale-90 no-print",
                          isSelected
                            ? "bg-primary-600 text-white shadow-sm shadow-primary-500/30"
                            : "bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600"
                        )}
                        title={isSelected ? "إلغاء التحديد" : "تحديد الصنف"}
                      >
                        {isSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                      </button>

                      <div className={`p-2.5 rounded-2xl ${
                        isZero ? 'bg-red-50 text-red-600 dark:bg-red-900/20' : 'bg-amber-50 text-amber-600 dark:bg-amber-900/20'
                      }`}>
                        <TrendingDown className="w-5 h-5" />
                      </div>
                      <div>
                        <span className={`px-2.5 py-0.5 rounded-lg text-[10px] font-black ${
                          isZero 
                            ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' 
                            : item.status === 'critical' 
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                              : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        }`}>
                          {isZero ? 'نفد من المخزون (0)' : item.status === 'critical' ? 'مستوى حرج' : 'تحت حد الطلب'}
                        </span>
                      </div>
                    </div>

                    <div className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-100 dark:border-slate-700 text-left">
                      <span className="text-[10px] font-bold text-slate-400 block">الرصيد / الحد</span>
                      <span className={`text-base font-black ${isZero ? 'text-red-600' : 'text-amber-600'}`}>
                        {item.quantity} <span className="text-xs text-slate-400">/ {reorderLimit}</span>
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1 mb-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg font-black text-slate-900 dark:text-white group-hover:text-blue-600 transition-colors leading-tight">
                        {item.trade_name_en || item.trade_name}
                      </h3>
                      {item.barcode && (
                        <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 font-mono text-[9px] font-bold">
                          {item.barcode}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-bold text-slate-400 truncate">{item.active_ingredient || '---'}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-4 border-t border-slate-50 dark:border-slate-800 text-xs">
                    <div>
                      <p className="text-[10px] font-black text-slate-400 uppercase">الشركة</p>
                      <p className="font-bold text-slate-700 dark:text-slate-300 truncate">{item.manufacturer || 'غير مسجل'}</p>
                    </div>
                    <div className="text-left">
                      <p className="text-[10px] font-black text-slate-400 uppercase">العجز المقدر</p>
                      <p className="font-black text-red-600">{deficit} وحدة</p>
                    </div>
                  </div>
                </div>

                <div className="mt-6 flex gap-2 no-print">
                  <button
                    onClick={() => addToNotebook(item)}
                    disabled={savingDrugId === item.drug_id}
                    className="flex-1 bg-purple-100 hover:bg-purple-200 dark:bg-purple-900/20 dark:hover:bg-purple-900/40 text-purple-700 dark:text-purple-400 py-2.5 rounded-xl font-black text-xs transition-all flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    {savingDrugId === item.drug_id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ClipboardList className="w-3.5 h-3.5" />}
                    <span>إضافة للكشكول</span>
                  </button>
                  <Link 
                    href={`/purchases/new?drugId=${item.drug_id}`}
                    className="flex-1 bg-primary-600 hover:bg-primary-700 text-white py-2.5 rounded-xl font-black text-xs transition-all flex items-center justify-center gap-1.5 shadow-md shadow-primary-500/20 active:scale-95"
                  >
                    <ShoppingCart className="w-3.5 h-3.5" />
                    <span>طلب شراء</span>
                  </Link>
                  <Link 
                    href={`/inventory?search=${encodeURIComponent(item.barcode || item.trade_name_en || item.trade_name)}`}
                    className="p-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-xl transition-all flex items-center justify-center"
                    title="عرض بالمخزون"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </Link>
                </div>
              </div>
            );
          })}

          {filteredItems.length === 0 && (
            <div className="col-span-full py-20 bg-white dark:bg-slate-900 rounded-[3rem] border-2 border-dashed border-slate-100 dark:border-slate-800 flex flex-col items-center justify-center gap-4 text-slate-300">
              <Package className="w-20 h-20 opacity-20" />
              <p className="text-2xl font-black italic">لا توجد نواقص تطابق بحثك</p>
            </div>
          )}
        </div>
      )}

      {/* Purchase Order Modal */}
      {isPoModalOpen && (
        <PurchaseOrderModal
          initialItems={poItems}
          onClose={() => setIsPoModalOpen(false)}
          onSuccess={() => {
            setIsPoModalOpen(false);
            toast.success('تم إنشاء أمر الشراء بنجاح');
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
  );
}
